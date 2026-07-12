/**
 * The audio front-end: Opus decode → VAD → utterance ENDPOINTING (+ the background-audio ring).
 * Extracted from the speech-watch processor (was stt-watch) so the transcription/orchestration
 * logic stays separate from the always-on audio sensor. This class IS one cohesive unit — the
 * Opus decode is fused into the VAD framing (`feed` → decode → `#process` → `#vadFrame`), and the
 * test hook `feedPcm` bypasses only the decode — so it is deliberately NOT split further.
 *
 * Per producer it depacketizes the WebRTC Opus audio RTP, decodes it in-process to 16 kHz mono
 * PCM (opusscript), and runs a voice-activity detector over 30 ms frames. Instead of blindly
 * transcribing fixed rolling windows (overlap-repeats + silence-hallucinations), it detects
 * UTTERANCES:
 *
 *   silence … → [speech starts] → buffer while voiced → [≥ENDPOINT_MS silence]
 *             → onUtterance(WHOLE utterance PCM).
 *
 * One final callback per thing the person says — no windowing artifacts, and the engine never
 * sees pure silence (so it can't hallucinate "Thank you"/"I'm sorry" loops). A max-utterance cap
 * flushes a runaway monologue. Decode mirrors the video FrameGrabber (werift depacketizes, opusscript
 * → 48 kHz PCM, decimate to 16 kHz). Transport-free: the caller wires onUtterance/onInterim/
 * onAcousticTrigger, so tests drive it via feedPcm. See docs/perception-pipeline.md §3.
 */
import OpusScript from 'opusscript';
import { dePacketizeRtpPackets } from 'werift';
import type { RtpPacket } from 'werift';
import { AudioTrigger } from './audio-trigger.js';

const OPUS_RATE = 48_000; // WebRTC Opus is 48 kHz
/** The STT sidecar (parakeet/whisper) wants 16 kHz — exported so the transcribe call names it. */
export const SAMPLE_RATE = 16_000;
const FRAME_MS = 30;
const FRAME_SAMPLES = (SAMPLE_RATE * FRAME_MS) / 1000;

/** Per-frame RMS at/above this counts as "voiced" (above comfort-noise hum).
 *  LOWERED 0.02 → 0.012 (the post-restart no-STT fix). Measured live: after an app
 *  restart the dock mic comes up at slightly reduced gain — real speech peaks ~0.018,
 *  JUST under the old 0.02 gate, so the VAD never fired and the utterance was never
 *  endpointed/transcribed (intermittent "UI says listening but no reply"). Healthy
 *  speech peaks ~0.021-0.023; true room tone sits ~0.001-0.004 — so 0.012 sits in the
 *  clean gap: it catches marginal-gain restart speech with margin, while staying well
 *  above comfort noise. See docs/findings/inprogress-stt-issue.md. */
const SILENCE_RMS = Number(process.env.STT_SILENCE_RMS ?? 0.012);
/** The background-audio payload window: a continuous never-drained PCM ring of the
 *  last N ms, snapshotted at a trigger so the interpreter hears the LEAD-UP too
 *  (bg-audio-summarizer.md §2 "trigger vs payload"). */
const BG_WINDOW_MS = Number(process.env.PERCEPTION_BG_WINDOW_MS ?? 10_000);
/** Silence this long after speech ends the utterance (endpoint). 1.3 s so natural
 *  mid-sentence pauses ("What time is the … meeting?") don't split a thought; the
 *  cost is ~0.6 s longer to commit after you actually stop. */
const ENDPOINT_MS = Number(process.env.STT_ENDPOINT_MS ?? 1300);
/** Ignore "utterances" shorter than this (clicks, stray noise). 180ms (was 350)
 *  so short real words — "hi", "yes", "no", "ok" — register as turns; 350 dropped
 *  a bare "hi" as noise. The engine's own confidence (no_speech_prob, Whisper only)
 *  still filters a genuine click that sneaks past this. */
const MIN_UTTERANCE_MS = Number(process.env.STT_MIN_UTTERANCE_MS ?? 180);
/** Force-flush a monologue this long even without an endpoint — a safety cap so we
 *  don't buffer audio forever, NOT a normal endpoint. 60s (was 15s, which chopped a
 *  normal long sentence/count mid-thought). The real end is the VAD silence endpoint;
 *  this only catches a runaway. */
const MAX_UTTERANCE_MS = Number(process.env.STT_MAX_UTTERANCE_MS ?? 60_000);
/** Keep this much leading silence/onset before the first voiced frame (so we don't
 *  clip the first phoneme). */
const PREROLL_MS = 200;

/** How often, while the user is mid-utterance, we re-transcribe the buffer-so-far
 *  to emit a live interim (partial) transcript for the dock UI. 800ms (NOT pibot's
 *  250ms): the contention probe showed a 400ms cadence starves the shared Metal GPU
 *  (vision completed 1 window in 12s); 800ms gives 3-5 live updates across a typical
 *  utterance with GPU gaps. Interims also fire ONLY while the dock is listening (a
 *  few seconds/turn), not on every ambient utterance, so the cost is bounded.
 *  Env-tunable from the playground. */
const INTERIM_INTERVAL_MS = Number(process.env.STT_INTERIM_INTERVAL_MS ?? 800);
/** Don't emit an interim until the utterance has at least this much voiced audio —
 *  a 100ms onset transcribes to junk and just makes the caption flicker. */
const INTERIM_MIN_AUDIO_MS = Number(process.env.STT_INTERIM_MIN_AUDIO_MS ?? 300);

/** Concatenate a list of equal-typed Int16 frames into one contiguous buffer. */
export function concatFrames(frames: Int16Array[]): Int16Array {
  let n = 0; for (const f of frames) n += f.length;
  const pcm = new Int16Array(n);
  let o = 0; for (const f of frames) { pcm.set(f, o); o += f.length; }
  return pcm;
}

export class UtteranceDetector {
  #dec: OpusScript | null = null;
  #started = false;
  #carry = new Int16Array(0);  // leftover samples < one frame
  #preroll: Int16Array[] = []; // recent silence frames (so onset isn't clipped)
  #utter: Int16Array[] = [];   // frames of the in-progress utterance
  #inSpeech = false;
  #silenceMs = 0;
  #utterMs = 0;
  #onUtterance: (pcm: Int16Array, startedAt: Date, endedAt: Date) => void | Promise<void>;
  #startedAt: Date | null = null;
  // INTERIM streaming state. #lastInterimMs = utterance-ms at the last interim tick;
  // #interimInFlight guards against piling up re-transcriptions if one is slow (the
  // probe showed under contention a pass can take >2s — never queue a second).
  #lastInterimMs = 0;
  #interimInFlight = false;
  // Opus decode success/failure counters — a sustained failure run is logged (a dead
  // decoder used to fail silently; see the post-restart STT investigation).
  #decodeOk = 0;
  #decodeFail = 0;
  // BACKGROUND-AUDIO substrate: a continuous ring of the last BG_WINDOW_MS of frames
  // (voiced or not — never drained, unlike #utter) + the cheap per-frame trigger.
  #ring: Int16Array[] = [];
  #acoustic = new AudioTrigger();

  // Same as onUtterance but awaitable — used by flushNow so the caller knows the
  // transcript is persisted. Set alongside the constructor callback.
  commit?: (pcm: Int16Array, startedAt: Date, endedAt: Date) => Promise<void>;
  // INTERIM hook: called at ~INTERIM_INTERVAL_MS while in-speech with the partial
  // utterance PCM, ONLY when shouldInterim() returns true (the listening gate). The
  // processor wires this to transcribe()+emit; the detector stays transport-free so
  // tests can drive it. Returns a promise so we can clear #interimInFlight on settle.
  onInterim?: (pcm: Int16Array, startedAt: Date) => Promise<void>;
  // The listening gate — interims are skipped unless this returns true (or is unset,
  // in which case interims never fire: opt-in). Cheap, called per candidate tick.
  shouldInterim?: () => boolean;
  // ACOUSTIC TRIGGER hook (background audio): fired on an impulse (crash/bang) or a
  // sustained-energy stretch (music/alarm) with the last BG_WINDOW_MS of PCM — the
  // lead-up included. Speech endpoints stay on the onUtterance path. Opt-in.
  onAcousticTrigger?: (kind: 'impulse' | 'sustained', windowPcm: Int16Array, at: Date) => void;

  constructor(onUtterance: (pcm: Int16Array, startedAt: Date, endedAt: Date) => void | Promise<void>) {
    this.#onUtterance = onUtterance;
  }

  start(): void {
    if (this.#started) return;
    this.#started = true;
    this.#dec = new OpusScript(OPUS_RATE, 1, OpusScript.Application.AUDIO);
  }

  feed(rtp: RtpPacket): void {
    if (!this.#started || !this.#dec) return;
    try {
      const frame = dePacketizeRtpPackets('opus', [rtp]);
      const data = frame?.data;
      if (!data?.length) return;
      const decoded = this.#dec.decode(data);
      const pcm48 = new Int16Array(decoded.buffer, decoded.byteOffset, Math.floor(decoded.length / 2));
      const out = new Int16Array(Math.floor(pcm48.length / 3)); // 48k → 16k
      for (let i = 0; i < out.length; i++) out[i] = pcm48[i * 3]!;
      this.#decodeOk++;
      this.#process(out);
    } catch (err) {
      // DIAG (post-restart no-STT hunt): a SILENT decode failure here is the suspected
      // root cause — packets "fed" but decode to nothing → no VAD → no utterance. Count
      // it and log the first error + a periodic summary so a dead decoder is never
      // invisible. (docs/findings/inprogress-stt-issue.md)
      this.#decodeFail++;
      if (this.#decodeFail === 1) {
        console.warn(`[speech-watch] OPUS DECODE FAILED (first): ${err instanceof Error ? err.message : String(err)}`);
      }
      if (this.#decodeFail % 200 === 0) {
        console.warn(`[speech-watch] opus decode: ${this.#decodeFail} failures / ${this.#decodeOk} ok`);
      }
    }
  }

  /** Test-only: inject raw 16 kHz mono PCM straight into the VAD (bypasses the
   *  Opus decode in feed()). Exercises the exact same framing + endpoint code
   *  the production path runs, so local tests reflect real cut-off behavior. */
  feedPcm(pcm: Int16Array): void { this.#process(pcm); }

  /** Append decoded PCM, slice into 30 ms frames, run VAD per frame. */
  #process(add: Int16Array): void {
    const buf = new Int16Array(this.#carry.length + add.length);
    buf.set(this.#carry); buf.set(add, this.#carry.length);
    let off = 0;
    for (; off + FRAME_SAMPLES <= buf.length; off += FRAME_SAMPLES) {
      this.#vadFrame(buf.subarray(off, off + FRAME_SAMPLES));
    }
    this.#carry = buf.slice(off);
  }

  #vadFrame(frame: Int16Array): void {
    let sum = 0;
    for (let i = 0; i < frame.length; i++) { const v = frame[i]! / 32768; sum += v * v; }
    const rms = Math.sqrt(sum / frame.length);
    const voiced = rms >= SILENCE_RMS;

    // BACKGROUND-AUDIO ring + trigger: every frame (voiced or not) lands in the ring;
    // the cheap trigger runs per frame and snapshots the ring when something acoustically
    // significant that is NOT a speech endpoint happens. Sensing is never slowed — the
    // expensive interpretation downstream owns its own cooldown.
    this.#ring.push(frame);
    const ringCap = BG_WINDOW_MS / FRAME_MS;
    if (this.#ring.length > ringCap) this.#ring.shift();
    if (this.onAcousticTrigger) {
      const trig = this.#acoustic.frame(rms, FRAME_MS, Date.now(), this.#inSpeech);
      if (trig) this.onAcousticTrigger(trig, concatFrames(this.#ring), new Date());
    }

    if (this.#inSpeech) {
      this.#utter.push(frame);
      this.#utterMs += FRAME_MS;
      this.#silenceMs = voiced ? 0 : this.#silenceMs + FRAME_MS;
      if (this.#silenceMs >= ENDPOINT_MS || this.#utterMs >= MAX_UTTERANCE_MS) { this.#endUtterance(); return; }
      this.#maybeInterim();
    } else if (voiced) {
      // speech onset — start an utterance, prepend the preroll.
      this.#inSpeech = true;
      this.#silenceMs = 0; this.#utterMs = 0;
      this.#lastInterimMs = 0; // fresh utterance → interim cadence restarts
      this.#startedAt = new Date();
      this.#utter = [...this.#preroll, frame];
      this.#preroll = [];
    } else {
      // keep a short trailing preroll of silence frames.
      this.#preroll.push(frame);
      const max = PREROLL_MS / FRAME_MS;
      if (this.#preroll.length > max) this.#preroll.shift();
    }
  }

  /** While in-speech, fire a live interim re-transcription at INTERIM_INTERVAL_MS —
   *  but ONLY when: the listening gate is open (shouldInterim), a hook is wired, no
   *  pass is already in flight (don't queue — a slow pass under GPU contention can
   *  exceed the interval), and we have enough audio to be worth transcribing. Each
   *  interim re-transcribes the WHOLE utterance-so-far (growing buffer), so context
   *  only grows — the partial naturally self-corrects as more audio arrives, and the
   *  final endpointed transcript is still the full-context authoritative one. */
  #maybeInterim(): void {
    if (!this.onInterim || this.#interimInFlight) return;
    if (this.#utterMs < INTERIM_MIN_AUDIO_MS) return;
    if (this.#utterMs - this.#lastInterimMs < INTERIM_INTERVAL_MS) return;
    if (!this.shouldInterim?.()) return;
    this.#lastInterimMs = this.#utterMs;
    this.#interimInFlight = true;
    const pcm = concatFrames(this.#utter);
    const started = this.#startedAt ?? new Date();
    void this.onInterim(pcm, started).catch(() => { /* interims are best-effort */ })
      .finally(() => { this.#interimInFlight = false; });
  }

  #endUtterance(): void {
    const frames = this.#utter;
    const ms = this.#utterMs - this.#silenceMs; // voiced span
    this.#inSpeech = false; this.#utter = []; this.#silenceMs = 0; this.#utterMs = 0;
    this.#lastInterimMs = 0;
    if (ms < MIN_UTTERANCE_MS) return; // too short → noise (a clipped/quiet onset
                                       // under MIN_UTTERANCE_MS is dropped here — the
                                       // cause of an occasional "tapped but no reply"
                                       // when only a fragment of speech was voiced).
    this.#onUtterance(concatFrames(frames), this.#startedAt ?? new Date(), new Date());
    this.#startedAt = null;
  }

  /** Force-commit an in-progress utterance NOW (don't wait for the silence
   *  endpoint). Used by the Summarize flush so the thing you're mid-saying lands
   *  in the store before we summarize. No-op if not currently in speech. Awaits
   *  the commit (via `commit`) so the caller knows the transcript is persisted. */
  async flushNow(): Promise<void> {
    if (!this.#inSpeech) return;
    const frames = this.#utter;
    const ms = this.#utterMs - this.#silenceMs;
    this.#inSpeech = false; this.#utter = []; this.#silenceMs = 0; this.#utterMs = 0;
    if (ms < MIN_UTTERANCE_MS) return;
    const started = this.#startedAt ?? new Date();
    this.#startedAt = null;
    await (this.commit ?? this.#onUtterance)(concatFrames(frames), started, new Date());
  }

  /** Drop any in-progress utterance + buffers WITHOUT committing. Used by the
   *  echo-gate: when the dock starts speaking, anything captured up to that point
   *  is either the user's tail (already endpointed) or onset of the dock's own
   *  voice — neither should commit. Keeps the decoder alive (unlike stop()). */
  reset(): void {
    this.#inSpeech = false;
    this.#utter = []; this.#preroll = []; this.#carry = new Int16Array(0);
    this.#silenceMs = 0; this.#utterMs = 0; this.#startedAt = null;
    this.#lastInterimMs = 0;
  }

  stop(): void {
    this.#started = false;
    try { this.#dec?.delete(); } catch { /* */ }
    this.#dec = null;
    this.#utter = []; this.#preroll = []; this.#carry = new Int16Array(0);
  }
}

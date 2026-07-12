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

// ─────────────────────────── MERGED ACOUSTIC BATCH (perception-to-brain merge) ───────────────────────────
// The batch window feeds ONE context-aware interpreter call that replaces the two eager
// bg-audio calls (per-utterance speech-details + per-impulse sound). It accumulates ALL
// decoded PCM since the last fire (a DRAIN buffer, not the lossy 10s ring), and fires when
// a trigger is ARMED and the room is quiet — cutting the window at an ENDPOINT boundary so
// no word is split and no audio is missed between fires.
/** Don't fire more often than this — the floor since the last fire. Also the natural
 *  window size in a chatty room. */
const BATCH_MIN_MS = Number(process.env.PERCEPTION_BATCH_MIN_MS ?? 10_000);
/** Quiet gap required after an endpointed utterance before the batch may fire (so we
 *  don't cut while the user is mid-thought between sentences). */
const BATCH_SILENCE_MS = Number(process.env.PERCEPTION_BATCH_SILENCE_MS ?? 1500);
/** Hard cap: if armed but the room never goes quiet, force-fire around here — but ONLY at
 *  an endpoint boundary. If no endpoint has occurred by the cap, keep going until one does
 *  (a true non-stop monologue) so we never split a word; the cursor picks up the remainder. */
const BATCH_MAX_MS = Number(process.env.PERCEPTION_BATCH_MAX_MS ?? 30_000);
/** Bound the drain buffer so a wedged interpreter can't grow it without limit (frames are
 *  dropped from the FRONT past this — a degraded but bounded window, logged by the caller). */
const BATCH_HARD_CAP_MS = Number(process.env.PERCEPTION_BATCH_HARD_CAP_MS ?? 90_000);

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

  // ── AUDIO ENRICHER batch state (the merged context-aware pass) ──
  #batch: Int16Array[] = [];        // DRAIN buffer: all frames since the last fire (never lossy)
  #batchMs = 0;                     // ms of audio held in #batch
  #batchStartMs = 0;                // epoch ms of the batch's first frame (segment timestamps anchor here)
  #batchArmed = false;              // a trigger (endpoint or acoustic) occurred → eligible to fire
  #lastEndpointOffMs = 0;          // #batchMs at the most recent utterance endpoint (the safe cut point)
  #batchFiring = false;             // an enricher pass is in flight — don't fire again until it returns
  /** Fired when the batch is ready: the AUDIO ENRICHER should transcribe+interpret `windowPcm`
   *  (starting at epoch `startedAtMs`) in context and return segment records. The window is cut
   *  at an endpoint boundary; `armedBy` says what triggered (speech endpoint vs acoustic).
   *  Opt-in; the caller (speech-watch) owns the async pass and clears it via `enrichDone()`. */
  onEnrich?: (windowPcm: Int16Array, startedAtMs: number, armedBy: 'speech' | 'acoustic', voicedPct: number) => void;
  #armedBy: 'speech' | 'acoustic' = 'speech';

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
    // The cheap acoustic trigger runs whenever EITHER consumer wants it (the legacy sound
    // path OR the merged enricher's arming). Capture its verdict once.
    let acousticTrig: 'impulse' | 'sustained' | null = null;
    if (this.onAcousticTrigger || this.onEnrich) {
      acousticTrig = this.#acoustic.frame(rms, FRAME_MS, Date.now(), this.#inSpeech);
      if (acousticTrig && this.onAcousticTrigger) this.onAcousticTrigger(acousticTrig, concatFrames(this.#ring), new Date());
    }

    // AUDIO ENRICHER drain buffer: accumulate EVERY frame since the last fire. Unlike the
    // 10s ring this is never lossy within a batch (bounded only by the hard cap). An acoustic
    // trigger arms the batch; a speech endpoint arms it too (handled in #endUtterance).
    if (this.onEnrich) {
      if (!this.#batch.length) this.#batchStartMs = Date.now() - FRAME_MS;
      this.#batch.push(frame);
      this.#batchMs += FRAME_MS;
      if (acousticTrig) { this.#batchArmed = true; this.#armedBy = 'acoustic'; }
      // bound the drain buffer (wedged enricher safety): drop from the FRONT past the hard cap.
      while (this.#batchMs > BATCH_HARD_CAP_MS && this.#batch.length > 1) {
        this.#batch.shift(); this.#batchMs -= FRAME_MS;
        this.#batchStartMs += FRAME_MS; this.#lastEndpointOffMs = Math.max(0, this.#lastEndpointOffMs - FRAME_MS);
      }
      this.#maybeEnrich(voiced);
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

  /** Decide whether the AUDIO ENRICHER batch should fire this frame, and if so cut it at a
   *  safe boundary and hand it off. Fires when: a pass isn't already in flight, the batch is
   *  ARMED (an endpoint or acoustic trigger happened), at least BATCH_MIN_MS of audio has
   *  accumulated (the floor), the room is currently quiet (>=BATCH_SILENCE_MS since the last
   *  voiced frame) OR we've hit the BATCH_MAX_MS cap — AND there is an endpoint boundary to cut
   *  at. If we're past the cap but no endpoint has occurred yet (a true non-stop monologue) we
   *  keep going until one does, so a word is never split; the cursor picks up the remainder. */
  #maybeEnrich(voiced: boolean): void {
    // Track trailing silence CONTINUOUSLY (any non-voiced frame extends it) — the endpoint's
    // own ~1.3s silence counts too, so a normal "utterance ends → room goes quiet" reaches the
    // BATCH_SILENCE_MS threshold. A voiced frame resets it. (Done regardless of arming/floor so
    // the counter is always current.)
    this.#batchSilenceMs = voiced ? 0 : this.#batchSilenceMs + FRAME_MS;
    if (!this.onEnrich || this.#batchFiring || !this.#batchArmed) return;
    if (this.#batchMs < BATCH_MIN_MS) return;
    // fire when the room is quiet (not mid a NEW utterance) with enough trailing silence, OR
    // we've hit the cap. #inSpeech guards against firing while a fresh utterance is underway.
    const quiet = !this.#inSpeech && this.#batchSilenceMs >= BATCH_SILENCE_MS;
    const capped = this.#batchMs >= BATCH_MAX_MS;
    if (!quiet && !capped) return;
    // cut ONLY at the last endpoint boundary (never mid-word). If none yet, wait for one.
    const cut = this.#lastEndpointOffMs;
    if (cut <= 0) return; // no completed utterance in the batch yet → keep accumulating
    this.#fireEnrich(cut);
  }
  #batchSilenceMs = 0;

  /** Cut the batch at `cutFrames*FRAME_MS` worth of audio, hand the window to the enricher,
   *  and retain the REMAINDER (audio after the cut) as the start of the next batch so nothing
   *  is missed and windows never overlap. */
  #fireEnrich(cutMs: number): void {
    const cutFrames = Math.round(cutMs / FRAME_MS);
    const head = this.#batch.slice(0, cutFrames);
    const tail = this.#batch.slice(cutFrames);
    const startedAtMs = this.#batchStartMs;
    const armedBy = this.#armedBy;
    // advance the cursor: the remainder becomes the new batch; timestamps continue from the cut.
    this.#batch = tail;
    this.#batchStartMs = startedAtMs + cutFrames * FRAME_MS;
    this.#batchMs = tail.length * FRAME_MS;
    this.#lastEndpointOffMs = 0;   // no endpoint boundary in the fresh remainder yet
    this.#batchArmed = false;      // disarmed — re-arms only when a NEW endpoint/acoustic trigger occurs
    this.#batchSilenceMs = 0;
    this.#batchFiring = true;
    const pcm = concatFrames(head);
    // DIAG: how much of this window is actually VOICED? A window that's mostly silence but comes
    // back as a full "conversation" is the model hallucinating (the goodbye-loop bug).
    let voicedFrames = 0;
    for (let i = 0; i + FRAME_SAMPLES <= pcm.length; i += FRAME_SAMPLES) {
      let sum = 0; for (let j = 0; j < FRAME_SAMPLES; j++) { const v = pcm[i + j]! / 32768; sum += v * v; }
      if (Math.sqrt(sum / FRAME_SAMPLES) >= SILENCE_RMS) voicedFrames++;
    }
    const totalFrames = Math.floor(pcm.length / FRAME_SAMPLES) || 1;
    const voicedPct = Math.round((voicedFrames / totalFrames) * 100);
    console.log(`[enrich] fire: ${(pcm.length / SAMPLE_RATE).toFixed(1)}s window, ${voicedPct}% voiced, armedBy=${armedBy}`);
    this.onEnrich!(pcm, startedAtMs, armedBy, voicedPct);
  }

  /** The enricher pass finished — allow the next fire. Called by the owner after its async
   *  interpret+persist completes (success or failure), like #interimInFlight for interims. */
  enrichDone(): void { this.#batchFiring = false; }

  #endUtterance(): void {
    const frames = this.#utter;
    const ms = this.#utterMs - this.#silenceMs; // voiced span
    this.#inSpeech = false; this.#utter = []; this.#silenceMs = 0; this.#utterMs = 0;
    this.#lastInterimMs = 0;
    if (ms < MIN_UTTERANCE_MS) return; // too short → noise (a clipped/quiet onset
                                       // under MIN_UTTERANCE_MS is dropped here — the
                                       // cause of an occasional "tapped but no reply"
                                       // when only a fragment of speech was voiced).
    // ARM the enricher batch at THIS endpoint: it's a safe cut boundary (a completed
    // utterance), so the batch may now fire here once the room stays quiet / the cap hits.
    if (this.onEnrich) { this.#batchArmed = true; this.#armedBy = 'speech'; this.#lastEndpointOffMs = this.#batchMs; }
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

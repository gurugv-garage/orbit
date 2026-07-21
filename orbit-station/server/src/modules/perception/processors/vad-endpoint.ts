/**
 * The audio front-end: Opus decode → VAD → utterance ENDPOINTING (+ the enricher ring).
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
/** The enricher payload window: a continuous never-drained PCM ring of the
 *  last N ms, snapshotted at a trigger so the interpreter hears the LEAD-UP too
 *  (bg-audio-summarizer.md §2 "trigger vs payload"). */
const ENRICH_RING_MS = Number(process.env.PERCEPTION_ENRICH_RING_MS ?? 10_000);
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
/** SPEECH-ONSET hook threshold (barge-in "polite pause"): fire onSpeechStart only
 *  after this much VOICED audio inside the utterance. A single voiced frame is
 *  often a bump/click or the dock's own AEC residual; ~a quarter second of
 *  sustained voice is a person. Env-tunable for live iteration.
 *
 *  This span must be CONTIGUOUS (see #voicedMs below), not merely cumulative: a
 *  CLAP is a broadband transient — a sharp attack that clears the RMS `voiced`
 *  bar, then a fast decay. A single clap rings for well under 240ms, and two
 *  claps used to ACCUMULATE past the threshold across the silent gap between
 *  them, tripping the barge pause on applause/a hand-clap while the dock spoke
 *  (live 2026-07-21). Requiring an UNBROKEN run of voiced frames rejects the
 *  transient (it decays before 240ms) while still firing on real speech, whose
 *  envelope stays up. This is the "gate the onset on real speech, not raw
 *  energy" fix — done in the time domain so it keeps the sub-endpoint latency
 *  the pause needs (waiting for a parakeet word would land 300-800ms too late,
 *  after the overlap has already mangled STT). */
const ONSET_SUSTAIN_MS = Number(process.env.STT_ONSET_SUSTAIN_MS ?? 240);
/** SPEECH-ONSET energy floor — the barge-in pause's OWN, HIGHER threshold, kept
 *  SEPARATE from SILENCE_RMS (2026-07-21). SILENCE_RMS (0.012) is deliberately low
 *  so quiet real speech still transcribes — but the barge pause reused it, so ANY
 *  faint sustained sound (a fan, distant chatter, the dock's own TTS echo, a hum)
 *  above 0.012 for 240ms paused the reply. The pause should fire only on a sound
 *  loud enough to be a real interruption spoken AT the dock, not ambient noise, so
 *  it gets its own bar here. Only the onset hook uses this; transcription still
 *  uses SILENCE_RMS (unchanged). Tune up if small noises still pause, down if a
 *  real close "stop" doesn't. Env-tunable for live iteration. */
const ONSET_RMS = Number(process.env.STT_ONSET_RMS ?? 0.035);
/** Dropout tolerance for the contiguous-voice onset: real voice has micro-gaps
 *  (stop consonants, glottal closures) of a frame or two, so a single silent
 *  frame must NOT reset the onset run. Past this the run is considered broken (a
 *  clap's decay, or a gap between two claps) and the accumulator restarts. */
const ONSET_GAP_TOLERANCE_MS = Number(process.env.STT_ONSET_GAP_TOLERANCE_MS ?? 90);

// ─────────────────────────── MERGED ACOUSTIC BATCH (perception-to-brain merge) ───────────────────────────
// The batch window feeds ONE context-aware interpreter call that replaces the two eager
// enricher calls (per-utterance speech-details + per-impulse sound). It accumulates ALL
// decoded PCM since the last fire (a DRAIN buffer, not the lossy 10s ring), and fires when
// a trigger is ARMED and the room is quiet — cutting the window at an ENDPOINT boundary so
// no word is split and no audio is missed between fires.
// ── DUAL-PATH BATCHING ──────────────────────────────────────────────────────────────────
// A batch fires on one of two paths, and `armedBy` records the CAUSE (not the content —
// an acoustic-triggered clip may still contain speech, and that's fine):
//
//   A) SPEECH path (low latency): a parakeet STT endpoint that returned real WORDS arms it.
//      After each endpoint we wait SPEECH_INACTIVITY_MS for new speech; if more speech starts
//      we extend (wait for its endpoint, then wait again — repeats indefinitely); once the lull
//      passes with no new speech, we FIRE. Chained sentences with sub-lull gaps = ONE clip.
//
//   B) ACOUSTIC path (ambient): an acoustic event (impulse/sustained), when no speech clip is
//      open, opens a window ANCHORED at that event; it fires ACOUSTIC_WINDOW_MS later regardless
//      of further acoustic events (they don't extend it). Continuous sound → back-to-back windows.
//
//   Speech OVERRIDES an open acoustic window: the clip START stays the acoustic marker (lead-up
//   sound kept) but the END switches to the speech path (endpoint + lull), so it fires BEFORE the
//   full window. armedBy stays 'acoustic' (audio was the cause; speech was found inside).
//
// The speech/non-speech distinction is made by PARAKEET (words vs '') via speechEndpoint(), NOT by
// the RMS VAD — an RMS blip (a quiet whir) is not speech, so it can only ever arm the acoustic path.
/** After a speech endpoint, wait this long for new speech before firing the speech clip. A new
 *  utterance within the window extends the clip (one grouped clip); silence past it fires. */
const SPEECH_INACTIVITY_MS = Number(process.env.PERCEPTION_SPEECH_INACTIVITY_MS ?? 3_000);
/** The acoustic (ambient/non-speech) window length: an acoustic event with no speech captures
 *  this many ms of audio, then fires. Anchored at the first event; continuous sound → back-to-back. */
const ACOUSTIC_WINDOW_MS = Number(process.env.PERCEPTION_ACOUSTIC_WINDOW_MS ?? 30_000);
/** Hard cap: if a clip somehow never reaches its fire condition (a true non-stop monologue with no
 *  lull, or a runaway), force-fire around here — but ONLY at an endpoint boundary so no word splits. */
const BATCH_MAX_MS = Number(process.env.PERCEPTION_BATCH_MAX_MS ?? 45_000);
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
  // ENRICHER substrate: a continuous ring of the last ENRICH_RING_MS of frames
  // (voiced or not — never drained, unlike #utter) + the cheap per-frame trigger.
  #ring: Int16Array[] = [];
  #acoustic = new AudioTrigger();

  // ── AUDIO ENRICHER batch state (the dual-path context-aware pass) ──
  #batch: Int16Array[] = [];        // DRAIN buffer: all frames since the last fire (never lossy)
  #batchMs = 0;                     // ms of audio held in #batch
  #batchStartMs = 0;                // epoch ms of the batch's first frame (segment timestamps anchor here)
  #lastEndpointOffMs = 0;          // #batchMs at the most recent utterance endpoint (the safe cut point)
  #batchFiring = false;             // an enricher pass is in flight — don't fire again until it returns
  // PATH A (speech): parakeet confirmed WORDS on an endpoint → a speech clip is open. #speechDeadlineMs
  // is the #batchMs value at which the SPEECH_INACTIVITY lull elapses (fire then, if still quiet). A
  // new endpoint with words pushes it out; new speech onset also holds it open.
  #speechArmed = false;
  #speechDeadlineMs = 0;
  // PATH B (acoustic): an acoustic window is open, anchored at #acousticStartOffMs (a #batchMs offset);
  // it fires ACOUSTIC_WINDOW_MS of audio after that anchor. 0 = no acoustic window open.
  #acousticOpen = false;
  #acousticFireAtMs = 0;           // #batchMs at which the acoustic window fires (anchor + ACOUSTIC_WINDOW_MS)
  // ENRICH PATH GATES (console-tunable, live). Which of the two trigger paths may fire the enricher:
  //   #enrichSpeech   → Path A (parakeet speech endpoint) may arm. Default ON (real in-room speech is
  //                     the durable-memory signal everyone wants).
  //   #enrichNonSpeech→ Path B (acoustic/ambient event) may open a window. Default OFF (ambient sound
  //                     rarely carries value + costs a Gemini call). When OFF, an RMS event never opens
  //                     a window, so no acoustic-armed clip is ever produced.
  // Gating happens at the ARM points (not at fire) so a disabled path never even starts a clip.
  #enrichSpeech = true;
  #enrichNonSpeech = false;
  /** Fired when the batch is ready: the AUDIO ENRICHER should transcribe+interpret `windowPcm`
   *  (starting at epoch `startedAtMs`) in context and return segment records. The window is cut
   *  at an endpoint boundary; `armedBy` says what triggered (speech endpoint vs acoustic).
   *  Opt-in; the caller (speech-watch) owns the async pass and clears it via `enrichDone()`. */
  onEnrich?: (windowPcm: Int16Array, startedAtMs: number, armedBy: 'speech' | 'acoustic', voicedPct: number) => void;

  // Same as onUtterance but awaitable — used by flushNow so the caller knows the
  // transcript is persisted. Set alongside the constructor callback.
  commit?: (pcm: Int16Array, startedAt: Date, endedAt: Date) => Promise<void>;
  // SPEECH-ONSET hook (barge-in "polite pause"): fired ONCE per utterance, as soon
  // as ONSET_SUSTAIN_MS of voiced audio has accumulated — long before the endpoint
  // or any transcription. The consumer (brain) uses it to hold the dock's TTS the
  // moment someone starts talking over it. Opt-in; transport-free like the others.
  onSpeechStart?: (startedAt: Date) => void;
  #voicedMs = 0;        // CONTIGUOUS voiced ms for the onset (resets on a real gap; NOT cumulative)
  #onsetGapMs = 0;      // running silence within the voiced run (tolerated up to ONSET_GAP_TOLERANCE_MS)
  #onsetFired = false;
  // INTERIM hook: called at ~INTERIM_INTERVAL_MS while in-speech with the partial
  // utterance PCM, ONLY when shouldInterim() returns true (the listening gate). The
  // processor wires this to transcribe()+emit; the detector stays transport-free so
  // tests can drive it. Returns a promise so we can clear #interimInFlight on settle.
  onInterim?: (pcm: Int16Array, startedAt: Date) => Promise<void>;
  // The listening gate — interims are skipped unless this returns true (or is unset,
  // in which case interims never fire: opt-in). Cheap, called per candidate tick.
  shouldInterim?: () => boolean;
  // ACOUSTIC TRIGGER hook (enricher): fired on an impulse (crash/bang) or a
  // sustained-energy stretch (music/alarm) with the last ENRICH_RING_MS of PCM — the
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

    // ENRICHER ring + trigger: every frame (voiced or not) lands in the ring;
    // the cheap trigger runs per frame and snapshots the ring when something acoustically
    // significant that is NOT a speech endpoint happens. Sensing is never slowed — the
    // expensive interpretation downstream owns its own cooldown.
    this.#ring.push(frame);
    const ringCap = ENRICH_RING_MS / FRAME_MS;
    if (this.#ring.length > ringCap) this.#ring.shift();
    // The cheap acoustic trigger runs whenever EITHER consumer wants it (the legacy sound
    // path OR the merged enricher's arming). Capture its verdict once.
    let acousticTrig: 'impulse' | 'sustained' | null = null;
    if (this.onAcousticTrigger || this.onEnrich) {
      acousticTrig = this.#acoustic.frame(rms, FRAME_MS, Date.now(), this.#inSpeech);
      if (acousticTrig && this.onAcousticTrigger) this.onAcousticTrigger(acousticTrig, concatFrames(this.#ring), new Date());
    }

    // AUDIO ENRICHER drain buffer: accumulate EVERY frame since the last fire. Unlike the
    // 10s ring this is never lossy within a batch (bounded only by the hard cap).
    if (this.onEnrich) {
      if (!this.#batch.length) this.#batchStartMs = Date.now() - FRAME_MS;
      this.#batch.push(frame);
      this.#batchMs += FRAME_MS;
      // PATH B arm: an acoustic event, when NO acoustic window is already open, opens one anchored
      // HERE (fires ACOUSTIC_WINDOW_MS of audio later). Further acoustic events during the window do
      // NOT extend it (anchored). A speech clip owns the batch instead when one is open (speech wins).
      if (this.#enrichNonSpeech && acousticTrig && !this.#acousticOpen && !this.#speechArmed) {
        this.#acousticOpen = true;
        this.#acousticFireAtMs = this.#batchMs + ACOUSTIC_WINDOW_MS;
      }
      // bound the drain buffer (wedged enricher safety): drop from the FRONT past the hard cap.
      while (this.#batchMs > BATCH_HARD_CAP_MS && this.#batch.length > 1) {
        this.#batch.shift(); this.#batchMs -= FRAME_MS;
        this.#batchStartMs += FRAME_MS;
        this.#lastEndpointOffMs = Math.max(0, this.#lastEndpointOffMs - FRAME_MS);
        this.#acousticFireAtMs = Math.max(0, this.#acousticFireAtMs - FRAME_MS);
        this.#speechDeadlineMs = Math.max(0, this.#speechDeadlineMs - FRAME_MS);
      }
      this.#maybeEnrich(voiced);
    }

    if (this.#inSpeech) {
      this.#utter.push(frame);
      this.#utterMs += FRAME_MS;
      this.#silenceMs = voiced ? 0 : this.#silenceMs + FRAME_MS;
      // CONTIGUOUS-LOUD onset (clap reject + small-noise reject): only an UNBROKEN
      // run of audio above the HIGHER onset floor (ONSET_RMS, not the low
      // transcription SILENCE_RMS) arms the barge pause — so a faint sustained
      // sound (fan/hum/echo/distant chatter) that is "voiced" enough to transcribe
      // is NOT loud enough to pause. A loud frame extends the run; a sub-floor
      // frame is tolerated up to ONSET_GAP_TOLERANCE_MS (voice micro-gaps), past
      // which the run resets — so a clap's decay, and the gap between two claps,
      // never accumulate to the threshold. (Only matters until the onset fires.)
      const loud = rms >= ONSET_RMS;
      if (!this.#onsetFired) {
        if (loud) {
          this.#voicedMs += FRAME_MS;
          this.#onsetGapMs = 0;
          if (this.#voicedMs >= ONSET_SUSTAIN_MS) {
            this.#onsetFired = true;
            this.onSpeechStart?.(this.#startedAt ?? new Date());
          }
        } else {
          this.#onsetGapMs += FRAME_MS;
          if (this.#onsetGapMs > ONSET_GAP_TOLERANCE_MS) this.#voicedMs = 0;
        }
      }
      if (this.#silenceMs >= ENDPOINT_MS || this.#utterMs >= MAX_UTTERANCE_MS) { this.#endUtterance(); return; }
      this.#maybeInterim();
    } else if (voiced) {
      // speech onset — start an utterance, prepend the preroll.
      this.#inSpeech = true;
      this.#silenceMs = 0; this.#utterMs = 0;
      // Seed the barge-onset run only if this first frame is LOUD (>= ONSET_RMS),
      // not merely voiced (>= SILENCE_RMS) — a quiet-start utterance must build the
      // onset run from its first genuinely loud frame, not get a free 30ms.
      this.#voicedMs = rms >= ONSET_RMS ? FRAME_MS : 0; this.#onsetGapMs = 0; this.#onsetFired = false;
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

  /** DUAL-PATH fire decision, run per frame. Two independent ways a batch fires:
   *   A) SPEECH: a speech clip is open (#speechArmed) and the SPEECH_INACTIVITY lull has elapsed
   *      (#batchMs past #speechDeadlineMs) with no new utterance in progress → fire at the last
   *      endpoint boundary. A new endpoint-with-words pushes #speechDeadlineMs out (grouping).
   *   B) ACOUSTIC: an acoustic window is open (#acousticOpen) and #batchMs reached its anchored
   *      fire time (#acousticFireAtMs) → fire. If a speech clip opened inside the window, path A
   *      fires it FIRST (speech overrides — earlier), so B only fires a pure-ambient window.
   *   Plus a hard-cap safety (BATCH_MAX_MS) so nothing buffers unboundedly. All fires cut at the
   *   last endpoint boundary when one exists; a pure-acoustic window with no endpoint cuts at the
   *   whole buffer (there's no word to split). */
  #maybeEnrich(voiced: boolean): void {
    if (!this.onEnrich || this.#batchFiring) return;
    const endpointCut = this.#lastEndpointOffMs; // >0 ⇒ a completed utterance boundary exists

    // ── PATH A: speech clip ── fire once the SPEECH_INACTIVITY lull has elapsed since the last
    // REAL-speech endpoint (#speechDeadlineMs). We do NOT gate on !#inSpeech: a noisy room flickers
    // the RMS VAD in and out of #inSpeech continuously, so that gate would block firing forever. The
    // deadline already means "3s since real speech AND no newer real speech" (a new utterance pushes
    // it via speechEndpoint), and we cut at the last ENDPOINT boundary, which never splits a word.
    if (this.#speechArmed && endpointCut > 0 && this.#batchMs >= this.#speechDeadlineMs) {
      this.#fireEnrich(endpointCut, 'speech');
      return;
    }

    // ── PATH B: acoustic window ── fire when the anchored window elapses. Cut at the last endpoint
    // if one exists (keep whole utterances intact); else cut the whole buffer (pure non-speech).
    // Same reasoning: don't gate on !#inSpeech (would stall in continuous sound).
    if (this.#acousticOpen && this.#batchMs >= this.#acousticFireAtMs) {
      this.#fireEnrich(endpointCut > 0 ? endpointCut : this.#batchMs, 'acoustic');
      return;
    }

    // ── HARD-CAP safety ── never let the buffer grow past BATCH_MAX_MS while armed. In a noisy room
    // the VAD can stay #inSpeech continuously (never a quiet gap), so this must fire EVEN mid-speech —
    // but ONLY at the last endpoint boundary (a completed utterance) so no word is split. If there's
    // no endpoint yet (a true non-stop monologue), we wait for one; the drain buffer's own hard cap
    // (BATCH_HARD_CAP_MS) is the final backstop. This is what prevents the 90s runaway windows.
    if ((this.#speechArmed || this.#acousticOpen) && this.#batchMs >= BATCH_MAX_MS && endpointCut > 0) {
      this.#fireEnrich(endpointCut, this.#speechArmed ? 'speech' : 'acoustic');
    }
  }

  /** Cut the batch at `cutFrames*FRAME_MS` worth of audio, hand the window to the enricher,
   *  and retain the REMAINDER (audio after the cut) as the start of the next batch so nothing
   *  is missed and windows never overlap. */
  #fireEnrich(cutMs: number, armedBy: 'speech' | 'acoustic'): void {
    const cutFrames = Math.round(cutMs / FRAME_MS);
    const head = this.#batch.slice(0, cutFrames);
    const tail = this.#batch.slice(cutFrames);
    const startedAtMs = this.#batchStartMs;
    // advance the cursor: the remainder becomes the new batch; timestamps continue from the cut.
    this.#batch = tail;
    this.#batchStartMs = startedAtMs + cutFrames * FRAME_MS;
    this.#batchMs = tail.length * FRAME_MS;
    this.#lastEndpointOffMs = 0;   // no endpoint boundary in the fresh remainder yet
    // disarm BOTH paths — a new endpoint-with-words / acoustic event re-arms for the next clip.
    this.#speechArmed = false; this.#speechDeadlineMs = 0;
    this.#acousticOpen = false; this.#acousticFireAtMs = 0;
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
    // Record the endpoint boundary (a safe cut point — a completed utterance). We DON'T arm the
    // speech path here: that's PARAKEET-driven (words vs '') via speechEndpoint(), called by the
    // owner once transcription returns. An RMS endpoint alone is not proof of speech (a whir trips
    // it). So we just mark the cut and hand the utterance off; arming waits for the verdict.
    if (this.onEnrich) this.#lastEndpointOffMs = this.#batchMs;
    this.#onUtterance(concatFrames(frames), this.#startedAt ?? new Date(), new Date());
    this.#startedAt = null;
  }

  /** PARAKEET's verdict on the just-endpointed utterance, from the owner (speech-watch) after STT
   *  returns. `hasWords` = the utterance transcribed to real words → this is a SPEECH endpoint →
   *  open/extend the speech clip (fire SPEECH_INACTIVITY_MS after this, if no new speech). `false`
   *  (parakeet returned '') → NOT speech → leave the speech path alone (only the acoustic path can
   *  arm). This is what makes "STT had an endpoint" the definition of a speech trigger. */
  speechEndpoint(hasWords: boolean): void {
    if (!this.onEnrich || !hasWords || !this.#enrichSpeech) return;
    this.#speechArmed = true;
    this.#speechDeadlineMs = this.#batchMs + SPEECH_INACTIVITY_MS;
    // speech OVERRIDES an open acoustic window: keep the window's START (the acoustic marker, so the
    // lead-up sound is in the clip) but let the SPEECH path own the END → fires before the full window.
    // (armedBy still reports 'acoustic' when a window was open — the audio was the cause.)
  }

  /** Console-tunable: which enricher trigger PATHS are live. `speech` gates Path A (parakeet
   *  speech endpoint), `nonSpeech` gates Path B (acoustic/ambient event). A path turned off
   *  never ARMS, so no clip of that kind is produced (nor its Gemini call). Applied live. */
  setEnrichPaths(paths: { speech: boolean; nonSpeech: boolean }): void {
    this.#enrichSpeech = paths.speech;
    this.#enrichNonSpeech = paths.nonSpeech;
    // If non-speech was just disabled, retire any acoustic window that's mid-flight (no speech
    // has overridden it — a pure acoustic clip would fire under the now-disabled path).
    if (!this.#enrichNonSpeech && this.#acousticOpen && !this.#speechArmed) {
      this.#acousticOpen = false; this.#acousticFireAtMs = 0;
    }
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

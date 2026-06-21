/**
 * SttWatchProcessor — always-on server-side speech-to-text (perception pyramid
 * tier-1 audio sensor, docs/perception-pipeline.md §9), with VAD ENDPOINTING.
 *
 * Per producer it depacketizes the WebRTC Opus audio RTP, decodes it in-process to
 * 16 kHz mono PCM (opusscript), and runs a voice-activity detector over 30 ms
 * frames. Instead of blindly transcribing fixed rolling windows (which caused
 * overlap-repeats and Whisper silence-hallucinations), it detects UTTERANCES:
 *
 *   silence … → [speech starts] → buffer while voiced → [≥ENDPOINT_MS silence]
 *             → transcribe the WHOLE utterance ONCE → emit one clean `transcript`.
 *
 * This is the right shape for streaming STT: one final transcript per thing the
 * person says, no windowing artifacts, and Whisper never sees pure silence (so it
 * can't hallucinate "Thank you"/"I'm sorry" loops). A max-utterance cap flushes a
 * very long monologue so we don't buffer forever.
 *
 * Decode mirrors the video FrameGrabber: werift depacketizes RTP, opusscript turns
 * each Opus packet into 48 kHz PCM, we decimate to 16 kHz.
 */

import OpusScript from 'opusscript';
import { dePacketizeRtpPackets } from 'werift';
import type { RtpPacket } from 'werift';
import type { MediaKind } from '../../media/tap.js';
import type { StreamContext, StreamProcessor } from '../processor.js';
import { makeSnapshot, type SnapshotStore } from '../snapshots.js';

const SIDECAR_URL = process.env.PERCEPTION_SIDECAR_URL ?? 'http://127.0.0.1:8078';
/** A1.4: the echo-gate (drop audio while the dock speaks) is OFF by default — the
 *  A1 AEC fix cancels the dock's own voice, and the gate would block voice
 *  barge-in. Set STT_ECHO_GATE=1 to re-enable on a device with weak AEC. */
const ECHO_GATE = process.env.STT_ECHO_GATE === '1';
const OPUS_RATE = 48_000; // WebRTC Opus is 48 kHz
const SAMPLE_RATE = 16_000; // whisper wants 16 kHz
const FRAME_MS = 30;
const FRAME_SAMPLES = (SAMPLE_RATE * FRAME_MS) / 1000;

/** Per-frame RMS at/above this counts as "voiced" (above comfort-noise hum). */
const SILENCE_RMS = Number(process.env.STT_SILENCE_RMS ?? 0.02);
/** Silence this long after speech ends the utterance (endpoint). 1.3 s so natural
 *  mid-sentence pauses ("What time is the … meeting?") don't split a thought; the
 *  cost is ~0.6 s longer to commit after you actually stop. */
const ENDPOINT_MS = Number(process.env.STT_ENDPOINT_MS ?? 1300);
/** Ignore "utterances" shorter than this (clicks, stray noise). 180ms (was 350)
 *  so short real words — "hi", "yes", "no", "ok" — register as turns; 350 dropped
 *  a bare "hi" as noise. Whisper's own confidence (no_speech_prob) still filters a
 *  genuine click that sneaks past this. */
const MIN_UTTERANCE_MS = Number(process.env.STT_MIN_UTTERANCE_MS ?? 180);
/** Force-flush a monologue this long even without an endpoint. */
const MAX_UTTERANCE_MS = Number(process.env.STT_MAX_UTTERANCE_MS ?? 15_000);
/** Keep this much leading silence/onset before the first voiced frame (so we don't
 *  clip the first phoneme). */
const PREROLL_MS = 200;

// --------------------------------------------------------------------------- //
// Whisper silence-hallucination backstop (the VAD should pre-empt these).
// --------------------------------------------------------------------------- //
const HALLUCINATION_PHRASES = new Set([
  'you', 'thank you', 'thanks for watching', 'thank you for watching',
  "i'm sorry", 'bye', 'bye.', '.', 'so', 'okay', 'the end',
]);

/** The dock's listening on/off BEEP (a ToneGenerator blip) isn't an AEC reference
 *  (only TTS is rendered through the WebRTC loopback), so the mic hears it and
 *  Whisper transcribes it as "beep"/"beep beep". Drop a transcript that is ONLY
 *  beep tokens so it never becomes an agent turn (the dock was replying to its own
 *  beep). A real sentence that merely CONTAINS "beep" still passes. */
function isBeepArtifact(text: string): boolean {
  const norm = text.toLowerCase().replace(/[^a-z\s]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!norm) return false;
  return norm.split(' ').every((w) => w === 'beep');
}

function isHallucination(text: string): boolean {
  const norm = text.toLowerCase().replace(/\s+/g, ' ').trim();
  if (HALLUCINATION_PHRASES.has(norm.replace(/[.!]+$/, ''))) return true;
  const words = norm.split(/\s+/).filter(Boolean);
  if (words.length < 4) return false;
  const counts = new Map<string, number>();
  for (const w of words) counts.set(w, (counts.get(w) ?? 0) + 1);
  if (Math.max(...counts.values()) / words.length > 0.5) return true;
  const clauses = norm.split(/[.!?]+/).map((c) => c.trim()).filter(Boolean);
  if (clauses.length >= 3) {
    const cc = new Map<string, number>();
    for (const c of clauses) cc.set(c, (cc.get(c) ?? 0) + 1);
    if (Math.max(...cc.values()) / clauses.length > 0.5) return true;
  }
  return false;
}

// --------------------------------------------------------------------------- //
// Utterance detector — decodes Opus → PCM frames → VAD endpointing. Calls
// onUtterance(pcm) with a complete utterance's PCM when speech ends.
// --------------------------------------------------------------------------- //
/** Concatenate a list of equal-typed Int16 frames into one contiguous buffer. */
function concatFrames(frames: Int16Array[]): Int16Array {
  let n = 0; for (const f of frames) n += f.length;
  const pcm = new Int16Array(n);
  let o = 0; for (const f of frames) { pcm.set(f, o); o += f.length; }
  return pcm;
}

class UtteranceDetector {
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

  // Same as onUtterance but awaitable — used by flushNow so the caller knows the
  // transcript is persisted. Set alongside the constructor callback.
  commit?: (pcm: Int16Array, startedAt: Date, endedAt: Date) => Promise<void>;

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
      this.#process(out);
    } catch { /* skip bad packet */ }
  }

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
    const voiced = Math.sqrt(sum / frame.length) >= SILENCE_RMS;

    if (this.#inSpeech) {
      this.#utter.push(frame);
      this.#utterMs += FRAME_MS;
      this.#silenceMs = voiced ? 0 : this.#silenceMs + FRAME_MS;
      if (this.#silenceMs >= ENDPOINT_MS || this.#utterMs >= MAX_UTTERANCE_MS) this.#endUtterance();
    } else if (voiced) {
      // speech onset — start an utterance, prepend the preroll.
      this.#inSpeech = true;
      this.#silenceMs = 0; this.#utterMs = 0;
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

  #endUtterance(): void {
    const frames = this.#utter;
    const ms = this.#utterMs - this.#silenceMs; // voiced span
    this.#inSpeech = false; this.#utter = []; this.#silenceMs = 0; this.#utterMs = 0;
    if (ms < MIN_UTTERANCE_MS) return; // too short → noise
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
  }

  stop(): void {
    this.#started = false;
    try { this.#dec?.delete(); } catch { /* */ }
    this.#dec = null;
    this.#utter = []; this.#preroll = []; this.#carry = new Int16Array(0);
  }
}

/** Whisper output + its own confidence tells (null when the sidecar is old/quiet). */
interface Transcription {
  text: string;
  avgLogprob: number | null;      // mean token log-prob; very negative = unsure
  noSpeechProb: number | null;    // P(silence/noise); high = likely hallucination
  compressionRatio: number | null; // gzip ratio; high = repetitive loop
  inferMs: number | null;         // sidecar-reported transcription latency
}

async function transcribe(pcm: Int16Array): Promise<Transcription | null> {
  try {
    const buf = Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength);
    const r = await fetch(`${SIDECAR_URL}/transcribe`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pcm_b64: buf.toString('base64'), sample_rate: SAMPLE_RATE }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!r.ok) return null;
    const j = (await r.json()) as {
      text?: string; avg_logprob?: number | null; no_speech_prob?: number | null;
      compression_ratio?: number | null; latency_ms?: number;
    };
    const text = j.text?.trim();
    if (!text) return null;
    return {
      text,
      avgLogprob: j.avg_logprob ?? null,
      noSpeechProb: j.no_speech_prob ?? null,
      compressionRatio: j.compression_ratio ?? null,
      inferMs: j.latency_ms != null ? Math.round(j.latency_ms) : null,
    };
  } catch {
    return null;
  }
}

// Confidence gates on Whisper's OWN metrics — the real hallucination tells, far
// better than a phrase blacklist. Defaults are conservative (only flag clearly bad
// transcripts); all env-tunable from the perception playground.
const LOGPROB_MIN = Number(process.env.STT_LOGPROB_MIN ?? -1.0);   // below → unsure
const NOSPEECH_MAX = Number(process.env.STT_NOSPEECH_MAX ?? 0.5);  // above → likely noise
const COMPRESSION_MAX = Number(process.env.STT_COMPRESSION_MAX ?? 2.4); // above → repetitive loop

/** Decide lowConfidence from Whisper metrics first, falling back to text heuristics
 *  (so it still works against an older sidecar that returns only text). We TAG, not
 *  drop — a flagged "oh!" / gasp can still be signal; the summarizer LLM decides. */
function isLowConfidence(t: Transcription): boolean {
  if (t.avgLogprob != null && t.avgLogprob < LOGPROB_MIN) return true;
  if (t.noSpeechProb != null && t.noSpeechProb > NOSPEECH_MAX) return true;
  if (t.compressionRatio != null && t.compressionRatio > COMPRESSION_MAX) return true;
  return isHallucination(t.text) || t.text.replace(/[^a-z0-9]/gi, '').length < 3;
}

/** GARBAGE tier — a transcript so unreliable its WORDS should not be presented to
 *  the brain as content (far-field mush, a repetition-loop hallucination like
 *  "I am a child. I am a child. …", pure noise). Distinct from merely "shaky": we
 *  still KEEP the record (tagged, raw text intact for the console/ring), but the
 *  grounding renders it as "[unclear speech]" so nothing downstream treats the
 *  garbled words as a fact. Tunable from the playground. */
// The RELIABLE garbage tell is a REPETITION LOOP (high compression ratio): Whisper
// emitting the same clause over and over on unclear audio. That caught every real
// hallucination in the captured data with zero false positives. Raw logprob/noSpeech
// alone are too aggressive (they nuke short legit utterances like "Thank you" / "Okay"
// that are quiet) — so they only escalate to GARBAGE when BOTH are bad together.
const GARBAGE_COMPRESSION = Number(process.env.STT_GARBAGE_COMPRESSION ?? 3.0); // repetition loop
const GARBAGE_LOGPROB = Number(process.env.STT_GARBAGE_LOGPROB ?? -1.15); // very unsure (combined only)
const GARBAGE_NOSPEECH = Number(process.env.STT_GARBAGE_NOSPEECH ?? 0.6); // likely not speech (combined only)

export type ConfTier = 'good' | 'shaky' | 'garbage';
export function confidenceTier(t: {
  avgLogprob: number | null; noSpeechProb: number | null; compressionRatio: number | null; text: string;
}): ConfTier {
  // GARBAGE: a repetition loop (the clearest tell), OR very-unsure AND very-non-speech
  // together (a single bad metric isn't enough — short quiet words read as both).
  const loop = isRepetitionLoop(t.text)
    || (t.compressionRatio != null && t.compressionRatio >= GARBAGE_COMPRESSION);
  const veryUnsure = t.avgLogprob != null && t.avgLogprob <= GARBAGE_LOGPROB
    && t.noSpeechProb != null && t.noSpeechProb >= GARBAGE_NOSPEECH;
  if (loop || veryUnsure) return 'garbage';
  if (isLowConfidence(t as Transcription)) return 'shaky';
  return 'good';
}

/** A repetition-loop hallucination: the same short clause repeated many times
 *  ("I am a child. I am a child. …", "sir, sir, sir, …"). Whisper does this on
 *  unclear/far audio. Compression ratio usually catches it, but check text too. */
function isRepetitionLoop(text: string): boolean {
  const norm = text.toLowerCase().replace(/[^a-z\s]/g, ' ').replace(/\s+/g, ' ').trim();
  const words = norm.split(' ').filter(Boolean);
  if (words.length < 8) return false;
  // unique words / total — a loop has very few unique words for its length.
  const uniq = new Set(words).size;
  return uniq / words.length < 0.35;
}

interface StreamState {
  ctx: StreamContext;
  detector: UtteranceDetector;
  /** echo-gate: true while we're dropping audio because the dock is speaking. */
  muted: boolean;
}

/** A final transcript + its utterance window, handed to the A1.2 transcript hook. */
export interface FinalTranscriptEvent {
  dockId: string;
  streamId: string;
  text: string;
  startedAt: number;
  endedAt: number;
  lowConfidence: boolean;
  confTier?: ConfTier;
}

export function sttWatchProcessor(
  store: SnapshotStore,
  /** A1.2: called once per endpointed final utterance (text + window), so the
   *  brain can decide via the addressed latch whether it becomes an agent turn. */
  onFinal?: (e: FinalTranscriptEvent) => void,
  /** A1.2 echo-gate (2c.1 Tier 2): true while the dock's OWN TTS is playing. We
   *  drop audio then so the station never transcribes the dock's own voice (the
   *  self-transcribe feedback loop). Defaults to never-speaking. */
  isSpeaking?: (dockId: string) => boolean,
  /** PRODUCTION background STT upgrade: given a finished utterance's PCM, return a
   *  better DIARIZED transcript (online, e.g. Gemini flash-lite) to replace the live
   *  Whisper text in the snapshot. Async + best-effort — the live path never waits on
   *  it. Undefined = local-Whisper-only (the default). */
  backgroundStt?: (pcm: Int16Array, sampleRate: number, dockId: string) => Promise<{ text: string; speaker?: number } | null>,
): StreamProcessor & {
  /** Force-commit any in-progress utterance on EVERY stream now, awaiting the
   *  transcription. Used by the Summarize flush so a mid-sentence is captured. */
  flushAll(): Promise<void>;
} {
  const streams = new Map<string, StreamState>();

  return {
    flushAll: async () => { await Promise.all([...streams.values()].map((s) => s.detector.flushNow())); },
    id: 'stt-watch',
    sources: '*',
    mediaKinds: ['audio'],
    channels: [],

    onStreamStart(ctx: StreamContext) {
      // Each completed (or force-flushed) utterance → one transcription → snapshot.
      // Returns a Promise so flushNow() can await the commit before summarizing.
      const commit = async (pcm: Int16Array, startedAt: Date, endedAt: Date): Promise<void> => {
        const tr = await transcribe(pcm);
        if (!tr) return;
        // Don't DROP shaky transcripts — a gasp / "oh!" / cut-off word can be
        // signal. TAG them lowConfidence (from Whisper's own logprob/no-speech/
        // compression metrics, falling back to text heuristics) and let the
        // summarizer LLM decide noise vs signal.
        const tier = confidenceTier(tr);
        const lowConfidence = tier !== 'good'; // back-compat flag (shaky OR garbage)
        const rec = makeSnapshot({
          dockId: ctx.dockId,
          source: { id: ctx.streamId, kind: 'speech', device: 'dock-webrtc', host: 'station' },
          model: { name: 'whisper-small.en-mlx', endpoint: SIDECAR_URL },
          from: startedAt, to: endedAt,
          payload: {
            text: tr.text, lowConfidence, confTier: tier,
            // keep the raw metrics on the record for the playground to inspect/tune
            avgLogprob: tr.avgLogprob, noSpeechProb: tr.noSpeechProb, compressionRatio: tr.compressionRatio,
            inferMs: tr.inferMs,
          },
        });
        store.add(rec);
        // BACKGROUND UPGRADE (production split): the snapshot lands NOW with Whisper
        // text (fast); if a background engine is wired, async re-transcribe this
        // utterance with the better diarized model and PATCH the snapshot in place.
        // Best-effort — never blocks the live addressed-turn path below.
        if (backgroundStt) {
          void backgroundStt(pcm, SAMPLE_RATE, ctx.dockId).then((up) => {
            if (up?.text) {
              store.update(rec, {
                text: up.text,
                ...(up.speaker != null ? { speaker: up.speaker } : {}),
                bgModel: true, // marks this snapshot as background-upgraded
              });
            }
          }).catch(() => { /* keep the Whisper text */ });
        }
        // confidence rides along so downstream sees Whisper's certainty, not a constant
        const conf = tr.avgLogprob != null ? Math.max(0, Math.min(1, 1 + tr.avgLogprob)) : 0.8;
        ctx.emit({ kind: 'transcript', source: 'stt-watch', payload: { text: tr.text, isFinal: true }, confidence: conf });
        // A1.2: hand the final transcript + its utterance window to the brain's
        // addressed latch so a tapped utterance can become an agent turn — UNLESS
        // it's the dock's own listening beep transcribed as "beep beep" (keep the
        // snapshot above for the record, but never let it become a turn).
        if (!isBeepArtifact(tr.text)) {
          onFinal?.({
            dockId: ctx.dockId, streamId: ctx.streamId, text: tr.text,
            startedAt: startedAt.getTime(), endedAt: endedAt.getTime(), lowConfidence, confTier: tier,
          });
        }
      };
      const detector = new UtteranceDetector((pcm, startedAt, endedAt) => { void commit(pcm, startedAt, endedAt); });
      detector.commit = commit; // flushNow awaits this; the live path stays fire-and-forget
      detector.start();
      streams.set(ctx.streamId, { ctx, detector, muted: false });
    },

    onRtp(streamId: string, _kind: MediaKind, rtp: RtpPacket) {
      const st = streams.get(streamId);
      if (!st) return;
      // Echo-gate (2c.1 Tier 2): drop audio while the dock's own TTS plays so we
      // don't transcribe ourselves. NOW DEFAULT-OFF: the A1 AEC fix (TTS rendered
      // through WebRTC → software AEC) cancels the dock's voice at the source, so
      // this mute is redundant AND blocks voice barge-in (A1.4) — it deafens the
      // station exactly when the user might talk over the dock. Kept behind a flag
      // (STT_ECHO_GATE=1) as a one-line fallback for a device whose AEC is weaker.
      if (ECHO_GATE && isSpeaking?.(st.ctx.dockId)) {
        if (!st.muted) { st.detector.reset(); st.muted = true; }
        return;
      }
      st.muted = false;
      st.detector.feed(rtp);
    },

    onStreamEnd(streamId: string) {
      streams.get(streamId)?.detector.stop();
      streams.delete(streamId);
    },
  };
}

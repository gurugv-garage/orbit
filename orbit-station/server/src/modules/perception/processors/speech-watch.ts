/**
 * SpeechWatchProcessor — always-on server-side audio front-end + speech-to-text (perception pyramid
 * tier-1 audio sensor, docs/perception-pipeline.md §9), with VAD ENDPOINTING.
 *
 * Engine note: the actual transcriber is the STT sidecar (:8078), whose engine is
 * a sidecar flag — PARAKEET-TDT by default (since 2026-06-22), whisper as fallback.
 * Comments here that name "Whisper" describe behaviour first observed under it; the
 * silence-hallucination / confidence-metric details are Whisper-specific (Parakeet
 * returns null for all three metrics, so the metric-based gates below are DORMANT
 * under it — see isLowConfidence/confidenceTier). The VAD/endpointing is engine-
 * agnostic. See docs/perception-pipeline.md §3.
 *
 * Per producer it depacketizes the WebRTC Opus audio RTP, decodes it in-process to
 * 16 kHz mono PCM (opusscript), and runs a voice-activity detector over 30 ms
 * frames. Instead of blindly transcribing fixed rolling windows (which caused
 * overlap-repeats and silence-hallucinations), it detects UTTERANCES:
 *
 *   silence … → [speech starts] → buffer while voiced → [≥ENDPOINT_MS silence]
 *             → transcribe the WHOLE utterance ONCE → emit one clean `transcript`.
 *
 * This is the right shape for streaming STT: one final transcript per thing the
 * person says, no windowing artifacts, and the engine never sees pure silence (so it
 * can't hallucinate "Thank you"/"I'm sorry" loops). A max-utterance cap flushes a
 * very long monologue so we don't buffer forever.
 *
 * Decode mirrors the video FrameGrabber: werift depacketizes RTP, opusscript turns
 * each Opus packet into 48 kHz PCM, we decimate to 16 kHz.
 */

import type { RtpPacket } from 'werift';
import type { MediaKind } from '../../media/tap.js';
import type { StreamContext, StreamProcessor } from '../processor.js';
import { makeSnapshot, type SnapshotStore } from '../snapshots.js';
import { dockConditions } from '../../../core/conditions.js';
import { UtteranceDetector, SAMPLE_RATE } from './vad-endpoint.js';
import type { EnrichContext, EnrichResult } from './audio-enricher.js';
import { mkdirSync, writeFileSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

/** How much disk the enricher WAV-debug dump may use before it prunes the oldest files. */
// ~0.5-0.9 MB per window (14-29s @ 16 kHz mono). 200 MB ≈ ~300-400 windows ≈ a few hours of active
// conversation — enough to browse a tuning session and compare enricher text vs the real audio.
const ENRICH_SAVE_BUDGET_BYTES = Number(process.env.PERCEPTION_ENRICH_SAVE_MB ?? 200) * 1024 * 1024;

/** DEBUG (PERCEPTION_ENRICH_SAVE=1): dump the exact 16 kHz mono WAV the enricher received, so we
 *  can LISTEN and tell whether the enricher's text matches the audio (Gemini/prompt) or the audio
 *  itself is garbled (STT/mic) or misaligned (a bug). Filename encodes the window start + voiced%.
 *  Self-bounded: keeps the newest ~ENRICH_SAVE_BUDGET_BYTES (default 100 MB), pruning oldest. */
function saveEnrichWav(dockId: string, pcm: Int16Array, startedAtMs: number, voicedPct: number): void {
  try {
    const dir = `.data/enrich-audio/${dockId}`;
    mkdirSync(dir, { recursive: true });
    const db = pcm.length * 2;
    writeFileSync(`${dir}/${startedAtMs}_v${voicedPct}.wav`,
      Buffer.concat([wavHeader(db), Buffer.from(pcm.buffer, pcm.byteOffset, db)]));
    // prune oldest until under budget (the filename prefix = startedAtMs is a natural age sort).
    const files = readdirSync(dir).filter((f) => f.endsWith('.wav')).sort();
    let total = files.reduce((n, f) => n + statSync(join(dir, f)).size, 0);
    for (const f of files) { if (total <= ENRICH_SAVE_BUDGET_BYTES) break; try { total -= statSync(join(dir, f)).size; unlinkSync(join(dir, f)); } catch { /* */ } }
  } catch { /* debug best-effort */ }
}

/** 44-byte canonical WAV header for 16 kHz mono int16 PCM (shared by the enricher
 *  dump above and the per-utterance dump below — keep the byte layout in ONE place). */
function wavHeader(dataBytes: number): Buffer {
  const hdr = Buffer.alloc(44);
  hdr.write('RIFF', 0); hdr.writeUInt32LE(36 + dataBytes, 4); hdr.write('WAVE', 8); hdr.write('fmt ', 12);
  hdr.writeUInt32LE(16, 16); hdr.writeUInt16LE(1, 20); hdr.writeUInt16LE(1, 22);
  hdr.writeUInt32LE(SAMPLE_RATE, 24); hdr.writeUInt32LE(SAMPLE_RATE * 2, 28); hdr.writeUInt16LE(2, 32);
  hdr.writeUInt16LE(16, 34); hdr.write('data', 36); hdr.writeUInt32LE(dataBytes, 40);
  return hdr;
}

/** Per-utterance audio dump (always on, self-bounded): the exact PCM each final
 *  transcript came from, so the console can PLAY any speech row (and enrollment can
 *  keep the clip). The path is THE shared contract between the writer (here), the
 *  enroll clip-copy (voice/service.ts) and the HTTP reader (perception/index.ts) —
 *  cwd-relative like the sibling enrich-audio dump. */
export function utteranceWavPath(dockId: string, startedAtMs: number): string {
  return `.data/utterance-audio/${dockId}/${startedAtMs}.wav`;
}
const UTTER_SAVE_BUDGET_BYTES = Number(process.env.PERCEPTION_UTTER_SAVE_MB ?? 200) * 1024 * 1024;
// Prune every Nth save, not every save — readdir+stat-per-file on each utterance
// would put hundreds of sync syscalls on the hot audio path for no benefit (the
// budget only drifts by ~N clip sizes between prunes).
const UTTER_PRUNE_EVERY = 20;
let utterSavesSincePrune = 0;
function saveUtteranceWav(dockId: string, pcm: Int16Array, startedAtMs: number): boolean {
  try {
    const dir = `.data/utterance-audio/${dockId}`;
    mkdirSync(dir, { recursive: true });
    const db = pcm.length * 2;
    writeFileSync(utteranceWavPath(dockId, startedAtMs),
      Buffer.concat([wavHeader(db), Buffer.from(pcm.buffer, pcm.byteOffset, db)]));
    if (++utterSavesSincePrune >= UTTER_PRUNE_EVERY) {
      utterSavesSincePrune = 0;
      const sizes = new Map(readdirSync(dir).filter((f) => f.endsWith('.wav')).sort()
        .map((f) => [f, statSync(join(dir, f)).size] as const));
      let total = [...sizes.values()].reduce((n, s) => n + s, 0);
      for (const [f, size] of sizes) {
        if (total <= UTTER_SAVE_BUDGET_BYTES) break;
        try { unlinkSync(join(dir, f)); total -= size; } catch { /* */ }
      }
    }
    return true;
  } catch { return false; }
}

const SIDECAR_URL = process.env.PERCEPTION_SIDECAR_URL ?? 'http://127.0.0.1:8078';
/** A1.4: the echo-gate (drop audio while the dock speaks) is OFF by default — the
 *  A1 AEC fix cancels the dock's own voice, and the gate would block voice
 *  barge-in. Set STT_ECHO_GATE=1 to re-enable on a device with weak AEC. */
const ECHO_GATE = process.env.STT_ECHO_GATE === '1';

// --------------------------------------------------------------------------- //
// STT silence-hallucination backstop (the VAD should pre-empt these).
// --------------------------------------------------------------------------- //
// Canonical silence outputs — stock sign-off / caption phrases the engine emits from
// faint room noise (first seen under Whisper; the phrase list is engine-neutral). These
// are essentially NEVER real addressed speech, so they're dropped from becoming a turn
// UNCONDITIONALLY (still kept as a lowConfidence snapshot for the record). Observed
// live: "Thank you" → phantom "You're very welcome!".
const HALLUCINATION_PHRASES = new Set([
  'you', 'thank you', 'thanks for watching', 'thank you for watching',
  "i'm sorry", 'bye', 'bye.', '.', 'so', 'okay', 'the end',
  'thanks', 'thank you so much', 'thank you very much',
]);

// Short backchannels ("yeah", "mm hmm", "oh", "aww", "one sec") are AMBIGUOUS: a real
// confident "yeah" is a valid answer to the dock's question, but the same token from
// near-silence is a hallucination. So these are dropped as a turn ONLY when the engine
// is also UNSURE (lowConfidence) — a voiced, confident "yeah" still becomes a turn.
// (Under Parakeet, "unsure" can only come from the text heuristics — no metrics.)
const SOFT_BACKCHANNELS = new Set([
  'yeah', 'yep', 'mm', 'mm hmm', 'mhm', 'uh huh', 'hmm', 'oh', 'ah', 'aww', 'one sec',
]);
export function isLowConfBackchannel(text: string, lowConfidence: boolean): boolean {
  if (!lowConfidence) return false;
  return SOFT_BACKCHANNELS.has(text.toLowerCase().replace(/[.!?]+$/, '').replace(/\s+/g, ' ').trim());
}

/** The dock's listening on/off BEEP (a ToneGenerator blip) isn't an AEC reference
 *  (only TTS is rendered through the WebRTC loopback), so the mic hears it and
 *  the STT engine transcribes it as "beep"/"beep beep". Drop a transcript that is ONLY
 *  beep tokens so it never becomes an agent turn (the dock was replying to its own
 *  beep). A real sentence that merely CONTAINS "beep" still passes. */
function isBeepArtifact(text: string): boolean {
  const norm = text.toLowerCase().replace(/[^a-z\s]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!norm) return false;
  return norm.split(' ').every((w) => w === 'beep');
}

/** A transcript with no actual WORDS — pure punctuation / whitespace / a stray token
 *  like "!", ".", "?!". The STT engine emits these on a brief unvoiced blip. They carry zero
 *  content, so they must NEVER become an agent turn (observed: a lone "!" → the dock
 *  replied "Is there something you'd like to tell me?"). Kept as a snapshot upstream;
 *  just never addressed. Threshold <2 alphanumerics (so "!" / "." / "" are out, but a
 *  real one-letter token like "I" / a quiet "ok" still passes via the word filters). */
export function hasNoWords(text: string): boolean {
  return text.replace(/[^a-z0-9]/gi, '').length < 2;
}

export function isHallucination(text: string): boolean {
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

/** STT output + its own confidence tells (null when the sidecar is old/quiet). */
interface Transcription {
  text: string;
  model: string;                  // the STT model the sidecar actually ran (e.g. parakeet)
  avgLogprob: number | null;      // mean token log-prob; very negative = unsure
  noSpeechProb: number | null;    // P(silence/noise); high = likely hallucination
  compressionRatio: number | null; // gzip ratio; high = repetitive loop
  inferMs: number | null;         // sidecar-reported transcription latency
  /** the engine's OWN utterance confidence 0..1 (parakeet: geometric mean of token
   *  confidences — exp(mean token logprob)). Null on old sidecars / whisper. */
  engineConf: number | null;
  /** speaker embedding (unit-norm, sidecar --embed-model) — only when requested. */
  embedding: number[] | null;
}

/** The STT model label: the sidecar's own report wins (per-call `model`, else its
 *  /health `stt_model`); else a configurable env; else a neutral fallback. NEVER a
 *  hardcoded engine name — the sidecar can be whisper, parakeet, … and the UI must
 *  reflect what actually ran. The /health value is cached after the first probe. */
const STT_MODEL_FALLBACK = process.env.PERCEPTION_STT_MODEL ?? 'stt-sidecar';
let healthSttModel: string | undefined; // cached from the sidecar /health
async function sidecarSttModel(): Promise<string> {
  if (healthSttModel) return healthSttModel;
  try {
    const r = await fetch(`${SIDECAR_URL}/health`, { signal: AbortSignal.timeout(2000) });
    const j = (await r.json()) as { stt_model?: string };
    if (j.stt_model) healthSttModel = j.stt_model;
  } catch { /* fall back below */ }
  return healthSttModel ?? STT_MODEL_FALLBACK;
}

/** Result of one transcribe attempt. We DISTINGUISH "the sidecar is unreachable/
 *  errored" from "the sidecar ran but heard nothing" — the former is a fault the
 *  user should be told about (the dock is deaf), the latter is just silence. */
type TranscribeResult =
  | { ok: true; transcription: Transcription | null }   // ran; maybe empty (silence)
  | { ok: false; error: string };                        // sidecar unreachable / errored

async function transcribe(pcm: Int16Array, embed = false): Promise<TranscribeResult> {
  try {
    const buf = Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength);
    const r = await fetch(`${SIDECAR_URL}/transcribe`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      // embed:true only on the final-commit path (never interims) — the sidecar
      // then also returns the utterance's speaker embedding (voice fingerprint).
      body: JSON.stringify({ pcm_b64: buf.toString('base64'), sample_rate: SAMPLE_RATE, embed }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!r.ok) return { ok: false, error: `STT sidecar returned ${r.status}` };
    const j = (await r.json()) as {
      text?: string; model?: string; avg_logprob?: number | null; no_speech_prob?: number | null;
      compression_ratio?: number | null; latency_ms?: number; embedding?: number[];
      confidence?: number | null;
    };
    const text = j.text?.trim();
    if (!text) return { ok: true, transcription: null };
    return {
      ok: true,
      transcription: {
        text,
        // the per-call model wins; else the sidecar's /health stt_model (cached);
        // else the env/neutral fallback. Trim the org prefix (mlx-community/…).
        model: (j.model ?? await sidecarSttModel()).replace(/^.*\//, ''),
        avgLogprob: j.avg_logprob ?? null,
        noSpeechProb: j.no_speech_prob ?? null,
        compressionRatio: j.compression_ratio ?? null,
        inferMs: j.latency_ms != null ? Math.round(j.latency_ms) : null,
        engineConf: typeof j.confidence === 'number' ? j.confidence : null,
        embedding: Array.isArray(j.embedding) ? j.embedding : null,
      },
    };
  } catch (e) {
    // ECONNREFUSED (sidecar not running) / timeout / DNS — the dock is DEAF.
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

// Confidence gates on the engine's OWN metrics — the real hallucination tells, far
// better than a phrase blacklist. WHISPER ONLY: Parakeet returns null for all three,
// so under it these gates are dormant and only the text heuristics in isLowConfidence
// fire. Defaults are conservative (only flag clearly bad transcripts); all env-tunable
// from the perception playground.
const LOGPROB_MIN = Number(process.env.STT_LOGPROB_MIN ?? -1.0);   // below → unsure
const NOSPEECH_MAX = Number(process.env.STT_NOSPEECH_MAX ?? 0.5);  // above → likely noise
const COMPRESSION_MAX = Number(process.env.STT_COMPRESSION_MAX ?? 2.4); // above → repetitive loop
/** Shortest utterance worth a voice fingerprint — embeddings on sub-second
 *  far-field slivers matched nobody in the 2026-07-14 trial. */
const VOICE_MIN_S = Number(process.env.VOICE_MIN_S ?? 0.8);

/** Decide lowConfidence from the engine's metrics first, falling back to text heuristics
 *  (so it still works against Parakeet / an older sidecar that returns null metrics —
 *  every `!= null` guard short-circuits and only the text rule remains). We TAG, not
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
// The RELIABLE garbage tell is a REPETITION LOOP: the engine emitting the same clause
// over and over on unclear audio. Compression ratio catches it WHEN present (Whisper);
// under Parakeet (null metrics) only the text-based isRepetitionLoop() fires. That
// caught every real hallucination in the captured data with zero false positives. Raw
// logprob/noSpeech alone are too aggressive (they nuke short legit utterances like
// "Thank you" / "Okay" that are quiet) — so they only escalate to GARBAGE when BOTH are
// bad together. (All metric branches are Whisper-only; dormant under Parakeet.)
//
// The combined (logprob AND no_speech) condition is WHISPER'S OWN silence/hallucination
// rule — OpenAI's transcribe.py marks a segment as silence only when
// `no_speech_prob > no_speech_threshold AND avg_logprob < logprob_threshold` (both),
// to avoid false-positives on confident speech that happens to have a high no-speech
// prob. We align our GARBAGE thresholds to Whisper's documented defaults: logprob -1.0,
// no_speech 0.6, compression 2.4. (Previously -1.15 logprob, which was stricter than
// Whisper's default and let borderline hallucinations like "I think" (-1.12, 0.59)
// through as a turn.) Env-tunable; the perception playground replays recordings to tune.
const GARBAGE_COMPRESSION = Number(process.env.STT_GARBAGE_COMPRESSION ?? 3.0); // repetition loop (> Whisper's 2.4: only flag a clear loop)
const GARBAGE_LOGPROB = Number(process.env.STT_GARBAGE_LOGPROB ?? -1.0);  // Whisper's logprob_threshold (combined only)
const GARBAGE_NOSPEECH = Number(process.env.STT_GARBAGE_NOSPEECH ?? 0.6); // Whisper's no_speech_threshold (combined only)

export type ConfTier = 'good' | 'shaky' | 'garbage';
// Parakeet tiering on the engine's OWN token confidence (calibrated 2026-07-14 on
// n=75 real dock utterances): junk fragments scored <0.75, word-salad 0.75–0.85,
// real speech 0.85+, clean 0.95+. Conservative defaults — garbage only for the
// clearly-non-transcribable tail; the mixed band is TAGGED shaky, never dropped.
const CONF_GARBAGE = Number(process.env.STT_CONF_GARBAGE ?? 0.72);
const CONF_SHAKY = Number(process.env.STT_CONF_SHAKY ?? 0.85);

export function confidenceTier(t: {
  avgLogprob: number | null; noSpeechProb: number | null; compressionRatio: number | null; text: string;
  engineConf?: number | null;
}): ConfTier {
  // GARBAGE: a repetition loop (the clearest tell), OR very-unsure AND very-non-speech
  // together (a single bad metric isn't enough — short quiet words read as both), OR
  // the engine's own confidence in the calibrated non-transcribable tail (parakeet).
  const loop = isRepetitionLoop(t.text)
    || (t.compressionRatio != null && t.compressionRatio >= GARBAGE_COMPRESSION);
  const veryUnsure = t.avgLogprob != null && t.avgLogprob <= GARBAGE_LOGPROB
    && t.noSpeechProb != null && t.noSpeechProb >= GARBAGE_NOSPEECH;
  if (loop || veryUnsure || (t.engineConf != null && t.engineConf < CONF_GARBAGE)) return 'garbage';
  if (t.engineConf != null && t.engineConf < CONF_SHAKY) return 'shaky';
  if (isLowConfidence(t as Transcription)) return 'shaky';
  return 'good';
}

/** A repetition-loop hallucination: the same short clause repeated many times
 *  ("I am a child. I am a child. …", "sir, sir, sir, …"). STT engines do this on
 *  unclear/far audio. Compression ratio catches it under Whisper; this text check is
 *  the only loop tell under Parakeet (null metrics), so check text regardless. */
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
  /** diagnostics: whether any RTP has arrived + a packet counter. */
  rtpSeen?: boolean;
  rtpCount?: number;
  /** unregister this detector from the live enrich-path gate (called on stream end). */
  unregisterEnrichPaths?: () => void;
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
  /** The engine's own confidence metrics, carried through so observability shows WHY a
   *  transcript was tagged (and the addressed-decision trace can record them). Null
   *  under Parakeet (Whisper-only), in which case nothing tagged the transcript by metric. */
  avgLogprob?: number | null;
  noSpeechProb?: number | null;
  compressionRatio?: number | null;
  /** Voice fingerprint of the utterance (best enrolled candidate + whether it cleared
   *  the match bar) — the brain's HEARING identity, distinct from face identity. */
  voice?: import('../voice/service.js').VoiceLabel;
}

/** A LIVE interim (partial) transcript emitted mid-utterance for the dock UI. seq is
 *  monotonic PER UTTERANCE (resets each new utterance) so the client can drop a stale
 *  out-of-order arrival. isFinal is always false here (the final goes via onFinal). */
export interface InterimTranscriptEvent {
  dockId: string;
  streamId: string;
  text: string;
  /** the in-progress utterance's start (ms epoch) — pairs an interim with its final. */
  startedAt: number;
  /** monotonic within the utterance; the UI shows only a higher seq than last seen. */
  seq: number;
}

export function speechWatchProcessor(
  store: SnapshotStore,
  /** A1.2: called once per endpointed final utterance (text + window), so the
   *  brain can decide via the addressed latch whether it becomes an agent turn. */
  onFinal?: (e: FinalTranscriptEvent) => void,
  /** A1.2 echo-gate (2c.1 Tier 2): true while the dock's OWN TTS is playing. We
   *  drop audio then so the station never transcribes the dock's own voice (the
   *  self-transcribe feedback loop). Defaults to never-speaking. */
  isSpeaking?: (dockId: string) => boolean,
  /** LIVE INTERIMS: emitted mid-utterance for the dock caption UI. Undefined = no
   *  interims (default). Best-effort, decoupled from the authoritative final path. */
  onInterim?: (e: InterimTranscriptEvent) => void,
  /** The listening gate for interims: re-transcribe mid-utterance ONLY while this
   *  returns true for the dock (i.e. the dock is in a listening/followup turn). Undefined
   *  ⇒ interims never fire. Keeps the cost bounded to active turns, not ambient speech. */
  isListening?: (dockId: string) => boolean,
  /** AUDIO ENRICHER (the merged path): given a batch window's PCM + context, return diarized,
   *  context-aware SEGMENTS (accurate transcript + source/kind/salience/addressed). When wired,
   *  it REPLACES the two `backgroundAudio` calls: it lands the authoritative durable records
   *  (one per segment); parakeet then stays live-only. Undefined ⇒ the legacy backgroundAudio
   *  path is used instead. */
  enrich?: (pcm: Int16Array, sampleRate: number, dockId: string, context: EnrichContext) => Promise<EnrichResult>,
  /** Context for the enricher: recent authoritative transcript + who's present (for name
   *  spelling / continuity). Pulled live from the store/grounding by the caller. */
  enrichContext?: (dockId: string) => EnrichContext,
  /** An addressed in-room speech segment observed by the enricher → the brain's WAKE FALLBACK
   *  (the interpreter heard the robot's name the local STT garbled). Fired SYNCHRONOUSLY the moment
   *  the enricher's result lands — no queue/batch between detection and this call. Observation
   *  only; the brain's addressed latch is the sole authority on whether it becomes a turn. */
  onEnrichAddressed?: (e: { dockId: string; text: string; conf: number; directive: string }) => void,
  /** Register a detector's enrich-path gate so console toggles (speech / non-speech triggers)
   *  apply live. Called once per detector with its `setEnrichPaths`; returns an unregister fn the
   *  stream teardown calls. Undefined ⇒ paths stay at the detector's defaults (speech on/non-speech
   *  off). Wired to perception's enricher_ state by the caller. */
  registerEnrichPaths?: (apply: (p: { speech: boolean; nonSpeech: boolean }) => void) => () => void,
  /** VOICE FINGERPRINT (observe-only trial): when set + enabled, finals ≥ VOICE_MIN_S
   *  request a speaker embedding from the sidecar and the label lands on the snapshot
   *  as `voice: {name, score}`. voice/service.ts owns matching + the enroll ring. */
  voiceId?: import('../voice/service.js').VoiceIdService,
  /** SPEECH ONSET (barge-in "polite pause"): fired once per utterance after
   *  ~ONSET_SUSTAIN_MS of sustained voice — long before the endpoint/transcript.
   *  The brain holds the dock's TTS on it when the dock is mid-reply. */
  onSpeechStart?: (e: { dockId: string; at: number }) => void,
): StreamProcessor & {
  /** Force-commit any in-progress utterance on EVERY stream now, awaiting the
   *  transcription. Used by the Summarize flush so a mid-sentence is captured. */
  flushAll(): Promise<void>;
} {
  const streams = new Map<string, StreamState>();
  const unknownStreamsLogged = new Set<string>(); // diagnostic: log unknown-stream audio once

  return {
    flushAll: async () => { await Promise.all([...streams.values()].map((s) => s.detector.flushNow())); },
    id: 'speech-watch',
    sources: '*',
    mediaKinds: ['audio'],
    channels: [],

    onStreamStart(ctx: StreamContext) {
      // IDEMPOTENT RE-ATTACH (the "listening but no response" bug): the SFU fires
      // onStreamStart repeatedly for the SAME streamId (ICE renegotiation / track
      // re-add on a station reload or network blip — observed firing every few
      // seconds with no matching onStreamEnd). The old code rebuilt the detector
      // each time and `streams.set` REPLACED it, throwing away the in-progress
      // utterance buffer mid-speech — so the VAD never accumulated a full utterance,
      // nothing ever endpointed, and every tap window timed out with no transcript.
      // Fix: if a detector already exists for this stream, KEEP it (a re-attach is
      // not a new stream). Audio keeps flowing into the SAME detector → utterances
      // endpoint normally.
      if (streams.has(ctx.streamId)) {
        console.log(`[speech-watch] onStreamStart: ${ctx.streamId} already attached — keeping existing detector (re-attach)`);
        return;
      }
      // DIAG: detector attach. (Re-enabled to debug the post-restart no-STT race.)
      console.log(`[speech-watch] onStreamStart: dock=${ctx.dockId} streamId=${ctx.streamId} — speech detector attached`);
      // Each completed (or force-flushed) utterance → one transcription → snapshot.
      // Returns a Promise so flushNow() can await the commit before summarizing.
      const commit = async (pcm: Int16Array, startedAt: Date, endedAt: Date): Promise<void> => {
        // Voice fingerprint: piggyback on the same sidecar call. Sub-VOICE_MIN_S
        // utterances skip it — embeddings on <0.8s far-field slivers are noise
        // (trial-measured), and the enroll ring shouldn't collect them either.
        const durS = pcm.length / SAMPLE_RATE;
        const wantEmbed = !!voiceId && voiceId.enabled() && durS >= VOICE_MIN_S;
        const res = await transcribe(pcm, wantEmbed);
        if (!res.ok) {
          // The sidecar is unreachable/errored → the dock is DEAF. Record it so the
          // brain can tell the user the real reason when they next try to talk
          // (generic ambient-error channel — core/conditions.ts).
          dockConditions.report(ctx.dockId, 'stt_unreachable',
            "I can't hear you right now — my speech recognition service isn't running. "
            + 'Please start the STT sidecar on the station.');
          return;
        }
        // The sidecar answered → clear any prior deaf condition (recovered).
        dockConditions.clear(ctx.dockId, 'stt_unreachable');
        const tr = res.transcription;
        // SPEECH-vs-NONSPEECH signal for the enricher batch: parakeet is the authority, but a
        // far-field ROOM flickers the RMS VAD and parakeet emits SPURIOUS one/two-char artifacts on
        // those noise blips. If we treated any non-empty text as "speech" the fast path would arm on
        // noise AND keep pushing its lull (window never closes → the 90s hard-cap windows we saw).
        // So require a SUBSTANTIVE transcript: a non-garbage tier AND ≥2 real word-chars. A quiet
        // whir → '' or a garbage sliver → NOT speech (only the acoustic path can arm). This makes
        // "parakeet endpointed real words" the definition of a speech trigger.
        const words = (tr?.text ?? '').replace(/[^a-z0-9]/gi, '');
        const isRealSpeech = !!tr && words.length >= 2 && confidenceTier(tr) !== 'garbage';
        detector.speechEndpoint(isRealSpeech);
        if (!tr) return;
        // Don't DROP shaky transcripts — a gasp / "oh!" / cut-off word can be
        // signal. TAG them lowConfidence (from the engine's own logprob/no-speech/
        // compression metrics under Whisper, falling back to text heuristics — which
        // is all there is under Parakeet) and let the summarizer LLM decide noise vs signal.
        const tier = confidenceTier(tr);
        const lowConfidence = tier !== 'good'; // back-compat flag (shaky OR garbage)
        // Label the utterance's voice + feed the enroll ring. Soft path: no
        // embedding (flag off / short clip / old sidecar) → no voice field.
        const voice = wantEmbed && tr.embedding
          ? voiceId!.handleUtterance(ctx.dockId, tr.embedding, tr.text, startedAt.getTime(), durS)
          : undefined;
        // Keep the utterance's audio (bounded dump) so the console can play the row
        // and enrollment can retain the clip. `clip:true` tells the UI a ▶ exists.
        const clip = saveUtteranceWav(ctx.dockId, pcm, startedAt.getTime());
        const rec = makeSnapshot({
          dockId: ctx.dockId,
          source: { id: ctx.streamId, kind: 'speech', device: 'dock-webrtc', host: 'station' },
          model: { name: tr.model, endpoint: SIDECAR_URL },
          from: startedAt, to: endedAt,
          payload: {
            text: tr.text, lowConfidence, confTier: tier,
            // the engine's OWN transcription confidence (parakeet token geo-mean) —
            // rides the generic payload.confidence so the console renders it (◷ %).
            ...(tr.engineConf != null ? { confidence: Number(tr.engineConf.toFixed(3)) } : {}),
            // who said it (voice fingerprint) — observe-only for now; the raw score
            // stays on the record so the trial can calibrate thresholds offline.
            ...(voice ? { voice } : {}),
            ...(clip ? { clip: true } : {}),
            // keep the raw metrics on the record for the playground to inspect/tune
            avgLogprob: tr.avgLogprob, noSpeechProb: tr.noSpeechProb, compressionRatio: tr.compressionRatio,
            inferMs: tr.inferMs,
            // Parakeet's record is LIVE-ONLY: it feeds the addressed-latch/onFinal + the console
            // STT lane, but the AUDIO ENRICHER's batch pass lands the authoritative durable
            // transcript. The memory arm prefers enricher segments over these (avoid double-count).
            liveOnly: true,
          },
        });
        store.add(rec);
        // confidence rides along so downstream sees the engine's certainty, not a constant.
        // Parakeet now reports its own token confidence; Whisper maps from logprob;
        // only an old sidecar falls back to the 0.8 neutral default.
        const conf = tr.engineConf
          ?? (tr.avgLogprob != null ? Math.max(0, Math.min(1, 1 + tr.avgLogprob)) : 0.8);
        ctx.emit({ kind: 'transcript', source: 'speech-watch', payload: { text: tr.text, isFinal: true }, confidence: conf });
        // A1.2: hand the final transcript + its utterance window to the brain's
        // addressed latch so a tapped utterance can become an agent turn — UNLESS
        // it's the dock's own listening beep ("beep beep") or an STT silence-
        // hallucination ("Thank you" / "Yeah" / "Okay" / "you" emitted from near-
        // silence). Both still land as snapshots above for the record, but neither
        // may become an agent turn — otherwise the dock answers things no one said
        // (the "Thank you" → "You're very welcome!" phantom reply).
        if (!isBeepArtifact(tr.text) && !isHallucination(tr.text)
            && !isLowConfBackchannel(tr.text, lowConfidence) && !hasNoWords(tr.text)) {
          onFinal?.({
            dockId: ctx.dockId, streamId: ctx.streamId, text: tr.text,
            startedAt: startedAt.getTime(), endedAt: endedAt.getTime(), lowConfidence, confTier: tier,
            avgLogprob: tr.avgLogprob, noSpeechProb: tr.noSpeechProb, compressionRatio: tr.compressionRatio,
            voice, // who the voice sounded like (fingerprint) — the brain's hearing-identity
          });
        }
      };
      const detector = new UtteranceDetector((pcm, startedAt, endedAt) => { void commit(pcm, startedAt, endedAt); });
      detector.commit = commit; // flushNow awaits this; the live path stays fire-and-forget
      if (onSpeechStart) {
        detector.onSpeechStart = (startedAt) => onSpeechStart({ dockId: ctx.dockId, at: startedAt.getTime() });
      }

      // ── AUDIO ENRICHER (merged path) ── when wired, ONE context-aware pass over each batch
      // window replaces the two backgroundAudio calls: it lands the authoritative durable
      // records (one per diarized segment). Parakeet then stays live-only (conversation/wake/
      // addressed-latch) and does NOT write the durable speech record.
      if (enrich) {
        // CROSS-BATCH dedup: overlapping windows re-transcribe boundary audio, so the same
        // sentence can come back in two consecutive batches. Remember the last few emitted texts
        // per stream and skip an immediate repeat. (In-batch dupes are handled in coalesceSegments.)
        const recentEnriched: string[] = [];
        const normText = (t: string) => t.toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
        detector.onEnrich = (windowPcm, startedAtMs, armedBy, voicedPct) => {
         // The SYNCHRONOUS prologue (below, before `void enrich(...)`) must never throw without
         // calling enrichDone() — else #batchFiring stays true and the enricher wedges forever for
         // this stream. Wrap it; on any sync error, release the guard.
         try {
          const windowEndMs = startedAtMs + Math.round(windowPcm.length / (SAMPLE_RATE / 1000));
          // The raw parakeet STT that overlapped THIS window — parakeet endpoints per real utterance,
          // so a non-empty result is PROOF there was real speech here. Shown on the row (enricher vs
          // raw STT compare) AND used by the hallucination guard below.
          const sttHere = store.list()
            .filter((r) => r.source.kind === 'speech' && (r.payload as { liveOnly?: boolean }).liveOnly
              && Date.parse(r.interval.from) < windowEndMs && Date.parse(r.interval.to) > startedAtMs)
            .map((r) => String((r.payload as { text?: string }).text ?? '')).filter(Boolean);
          const sttWindow = sttHere.join(' ').slice(0, 300);
          // HALLUCINATION GUARD: a window that's almost all silence but comes back as a full
          // "conversation" is the model inventing it. Skip the enrich when <10% voiced AND armed by a
          // speech endpoint — BUT only if parakeet ALSO heard nothing here. If parakeet DID catch a
          // real utterance (sttHere non-empty), there's provably real speech in this window (just
          // quiet/far-field) and skipping would drop its enrichment — the exact "parakeet has it,
          // enricher doesn't" loss. So run enrich when parakeet found speech, guard only true silence.
          if (voicedPct < 10 && armedBy === 'speech' && sttHere.length === 0) {
            console.log(`[enrich] skip: ${voicedPct}% voiced, no parakeet STT — silent window (hallucination guard)`);
            detector.enrichDone(); return;
          }
          // DEBUG: dump the exact WAV the enricher receives (PERCEPTION_ENRICH_SAVE=1), so we can
          // LISTEN and confirm whether the enricher's text matches the actual audio or hallucinates.
          if (process.env.PERCEPTION_ENRICH_SAVE === '1') { void saveEnrichWav(ctx.dockId, windowPcm, startedAtMs, voicedPct); }
          const context = enrichContext?.(ctx.dockId) ?? {};
          void enrich(windowPcm, SAMPLE_RATE, ctx.dockId, context)
            .then(({ segments: segs, meta }) => {
              // FIRED but produced NOTHING — Gemini 429/timeout/malformed (enrichAudio returns []),
              // OR everything was filtered. If parakeet DID hear speech here, this is a "parakeet has
              // it, enricher doesn't" miss — surface it so it's not silent.
              if (segs.length === 0 && sttHere.length > 0) {
                console.log(`[enrich] empty: fired ${meta.windowMs}ms window (${voicedPct}% voiced, ${meta.latencyMs}ms) but 0 segments — parakeet heard: "${sttWindow.slice(0, 80)}"`);
              }
              if (segs.length === 0) return;
              // ADDRESSED → the brain FIRST, before the record is written — ZERO avoidable work between
              // the enricher identifying "spoken to orbit" and the wake. Fires per addressed segment.
              for (const seg of segs) {
                if (seg.addressedToRobot && seg.source === 'speech') {
                  onEnrichAddressed?.({ dockId: ctx.dockId, text: seg.text, conf: seg.addressConf ?? 0.7, directive: seg.directive ?? '' });
                }
              }
              // ONE RECORD PER LLM CALL. The call took ONE audio clip (this batch window) and produced
              // N utterance SEGMENTS — they belong on ONE record as a `segments[]` field, NOT shattered
              // into N bus records the UI has to reassemble (that reassembly caused the duplicate-row /
              // wrong-audio / split-transcript bugs). The record's interval IS the real clip window
              // [startedAtMs, +windowMs] so ▶ plays exactly this audio. Per-segment fromMs/toMs are the
              // model's APPROXIMATE ordering hints — NOT reliable audio offsets (Gemini is not a forced
              // aligner), so we never seek by them; the whole clip is the unit you can trust.
              const stitched = segs.map((s) => s.text.trim()).filter(Boolean).join(' ');
              const nt = normText(stitched);
              if (nt.length > 3 && recentEnriched.includes(nt)) return; // cross-call repeat (finally() releases the guard)
              recentEnriched.push(nt); if (recentEnriched.length > 6) recentEnriched.shift();
              // roll-ups so simple consumers (isSalient / dropSuperseded / vision-gate) don't walk segments.
              const hasSpeech = segs.some((s) => s.source === 'speech');
              const addressedToRobot = segs.some((s) => s.addressedToRobot && s.source === 'speech');
              const maxSalience = segs.some((s) => s.salience === 'startling') ? 'startling'
                : segs.some((s) => s.salience === 'notable') ? 'notable' : 'low';
              // the FIRST addressed segment's directive/conf, for the summarizer/brain convenience roll-up.
              const addr = segs.find((s) => s.addressedToRobot && s.source === 'speech');
              store.add(makeSnapshot({
                dockId: ctx.dockId,
                source: { id: ctx.streamId, kind: 'enriched', device: 'dock-webrtc', host: 'station' },
                model: { name: 'audio-enricher', endpoint: 'gemini' },
                from: new Date(startedAtMs), to: new Date(windowEndMs), // the REAL clip window
                payload: {
                  // the utterances this call produced (the expandable detail).
                  segments: segs.map((s) => ({
                    fromMs: s.fromMs, toMs: s.toMs, text: s.text,
                    ...(s.speaker != null ? { speaker: s.speaker } : {}),
                    audioSource: s.source,
                    ...(s.kind ? { audioKind: s.kind } : {}),
                    ...(s.transcriptConf != null ? { transcriptConf: s.transcriptConf } : {}),
                    salience: s.salience,
                    ...(s.salienceConf != null ? { salienceConf: s.salienceConf } : {}),
                    ...(s.summary ? { summary: s.summary } : {}),
                    ...(s.addressedToRobot ? { addressedToRobot: true } : {}),
                    ...(s.addressConf != null ? { addressConf: s.addressConf } : {}),
                    ...(s.directive ? { directive: s.directive } : {}),
                    ...(s.echo ? { echo: true } : {}),
                  })),
                  // ROLL-UPS (call-level) — the whole-clip transcript + cheap flags for simple consumers.
                  text: stitched, hasSpeech, addressedToRobot, maxSalience,
                  ...(addr?.directive ? { directive: addr.directive } : {}),
                  ...(addr?.addressConf != null ? { addressConf: addr.addressConf } : {}),
                  // CALL METADATA (once) — trigger + how much real audio + the raw parakeet STT here.
                  enriched: true, armedBy, voicedPct,
                  ...(sttWindow ? { sttWindow } : {}),
                  enrichBatchId: startedAtMs, // = the clip WAV's startedAtMs (▶ matches exactly by this)
                  windowMs: meta.windowMs,
                  enrichModel: meta.model, enrichMs: meta.latencyMs,
                  ...(meta.promptTokens != null ? { enrichPromptTokens: meta.promptTokens } : {}),
                  ...(meta.outputTokens != null ? { enrichOutputTokens: meta.outputTokens } : {}),
                  ...(meta.totalTokens != null ? { enrichTotalTokens: meta.totalTokens } : {}),
                  enrichPromptChars: meta.promptChars, enrichPrompt: meta.prompt,
                },
              }));
            })
            .catch(() => { /* enricher best-effort — parakeet's live path already ran */ })
            .finally(() => { detector.enrichDone(); });
         } catch { detector.enrichDone(); } // sync prologue threw → release the batch guard
        };
      }

      // (Non-speech acoustic events — a crash, music, laughter — are now produced by the AUDIO
      // ENRICHER: its batch pass emits them as 'sound' segments with source:'sound'. The old
      // per-impulse backgroundAudio path was removed with the merge.)
      // LIVE INTERIMS — only when a consumer (onInterim) AND a gate (isListening) are
      // wired. The detector calls onInterim(pcm) at INTERIM_INTERVAL_MS while in-speech;
      // we transcribe the partial and forward it with a per-utterance monotonic seq. A
      // blank/whitespace partial is skipped (don't flash an empty caption). These are
      // best-effort and NEVER touch the snapshot/final/addressed path above.
      if (onInterim && isListening) {
        let lastStartMs = 0; // detect a new utterance (startedAt changes) → reset seq
        let seq = 0;
        detector.shouldInterim = () => isListening(ctx.dockId);
        detector.onInterim = async (pcm, startedAt) => {
          const startMs = startedAt.getTime();
          if (startMs !== lastStartMs) { lastStartMs = startMs; seq = 0; }
          const res = await transcribe(pcm);
          if (!res.ok || !res.transcription) return;
          const text = res.transcription.text.trim();
          if (!text) return; // don't emit an empty interim (flicker)
          onInterim({ dockId: ctx.dockId, streamId: ctx.streamId, text, startedAt: startMs, seq: seq++ });
        };
      }
      detector.start();
      // Live enrich-path gates (console speech / non-speech toggles). The registrar seeds the
      // detector with current state immediately and pushes future changes; keep the unregister.
      const unregisterEnrichPaths = registerEnrichPaths?.((p) => detector.setEnrichPaths(p));
      streams.set(ctx.streamId, { ctx, detector, muted: false, unregisterEnrichPaths });
    },

    onRtp(streamId: string, _kind: MediaKind, rtp: RtpPacket) {
      const st = streams.get(streamId);
      if (!st) {
        // Audio arriving for a stream with NO detector = the no-STT bug: a producer
        // (re)attached but onStreamStart never created its state. Log ONCE per
        // unknown stream so we see it without spamming every packet.
        if (!unknownStreamsLogged.has(streamId)) {
          unknownStreamsLogged.add(streamId);
          // DIAG: audio for a stream with no detector (re-enabled for the restart race).
          console.warn(`[speech-watch] onRtp for UNKNOWN stream ${streamId} — no detector, dropping audio (no onStreamStart fired?)`);
        }
        return;
      }
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
      // DIAG (re-enabled): confirm audio packets reach the detector (first packet +
      // a heartbeat every ~500) — distinguishes "detector attached but starved" from
      // "audio flowing but not endpointing" in the post-restart race.
      if (!st.rtpSeen) { st.rtpSeen = true; console.log(`[speech-watch] FIRST audio packet for ${streamId} — feeding detector`); }
      st.rtpCount = (st.rtpCount ?? 0) + 1;
      if (st.rtpCount % 500 === 0) console.log(`[speech-watch] ${streamId}: ${st.rtpCount} audio packets fed`);
      st.detector.feed(rtp);
    },

    onStreamEnd(streamId: string) {
      console.warn(`[speech-watch] onStreamEnd: ${streamId} — detector stopped + removed`); // DIAG (restart hunt)
      const st = streams.get(streamId);
      st?.detector.stop();
      st?.unregisterEnrichPaths?.();
      streams.delete(streamId);
    },
  };
}

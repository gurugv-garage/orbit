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
import type { BgAudioEvent } from './background-audio.js';

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

async function transcribe(pcm: Int16Array): Promise<TranscribeResult> {
  try {
    const buf = Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength);
    const r = await fetch(`${SIDECAR_URL}/transcribe`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pcm_b64: buf.toString('base64'), sample_rate: SAMPLE_RATE }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!r.ok) return { ok: false, error: `STT sidecar returned ${r.status}` };
    const j = (await r.json()) as {
      text?: string; model?: string; avg_logprob?: number | null; no_speech_prob?: number | null;
      compression_ratio?: number | null; latency_ms?: number;
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
  /** PRODUCTION background AUDIO interpreter (bg-audio-summarizer.md): given an acoustic
   *  window's PCM + what triggered it, return the interpreted event (kind/salience/
   *  transcript/summary). Speech endpoints UPGRADE the speech snapshot in place;
   *  impulse/sustained triggers become their own 'sound' snapshots. Async + best-effort —
   *  the live path never waits on it. Undefined = local engine only (the default). */
  backgroundAudio?: (pcm: Int16Array, sampleRate: number, dockId: string, trigger: 'speech' | 'impulse' | 'sustained') => Promise<(BgAudioEvent & { model?: string }) | null>,
  /** LIVE INTERIMS: emitted mid-utterance for the dock caption UI. Undefined = no
   *  interims (default). Best-effort, decoupled from the authoritative final path. */
  onInterim?: (e: InterimTranscriptEvent) => void,
  /** The listening gate for interims: re-transcribe mid-utterance ONLY while this
   *  returns true for the dock (i.e. the dock is in a listening/followup turn). Undefined
   *  ⇒ interims never fire. Keeps the cost bounded to active turns, not ambient speech. */
  isListening?: (dockId: string) => boolean,
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
        const res = await transcribe(pcm);
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
        if (!tr) return;
        // Don't DROP shaky transcripts — a gasp / "oh!" / cut-off word can be
        // signal. TAG them lowConfidence (from the engine's own logprob/no-speech/
        // compression metrics under Whisper, falling back to text heuristics — which
        // is all there is under Parakeet) and let the summarizer LLM decide noise vs signal.
        const tier = confidenceTier(tr);
        const lowConfidence = tier !== 'good'; // back-compat flag (shaky OR garbage)
        const rec = makeSnapshot({
          dockId: ctx.dockId,
          source: { id: ctx.streamId, kind: 'speech', device: 'dock-webrtc', host: 'station' },
          model: { name: tr.model, endpoint: SIDECAR_URL },
          from: startedAt, to: endedAt,
          payload: {
            text: tr.text, lowConfidence, confTier: tier,
            // keep the raw metrics on the record for the playground to inspect/tune
            avgLogprob: tr.avgLogprob, noSpeechProb: tr.noSpeechProb, compressionRatio: tr.compressionRatio,
            inferMs: tr.inferMs,
          },
        });
        store.add(rec);
        // BACKGROUND UPGRADE (production split): the snapshot lands NOW with the local
        // engine's text (fast); if the background audio interpreter is wired, async
        // interpret this utterance and PATCH the snapshot in place with the acoustic
        // event fields (+ a transcript upgrade when the model heard the words better).
        // NO speaker indices — per-clip diarization was structurally broken and polluted
        // 81% of long-term memories with "speaker 0" (bg-audio-summarizer.md §1).
        // Best-effort — never blocks the live addressed-turn path below.
        if (backgroundAudio) {
          void backgroundAudio(pcm, SAMPLE_RATE, ctx.dockId, 'speech').then((ev) => {
            if (!ev) return;
            store.update(rec, {
              // The interpreter's transcript REPLACES the local text only when the local
              // engine was itself unsure (shaky/garbage tier) — a confident local read is
              // authoritative (Gemini rewrote "Hey now, are you still…" into mush, seen
              // live 2026-07-05; the doc's original complaint). Otherwise the alternate
              // read rides along as bgTranscript for corroboration.
              ...(ev.transcript && tier !== 'good' ? {
                sttText: rec.payload.text as string, // PRESERVE the raw local transcript
                text: ev.transcript,
              } : ev.transcript && ev.transcript !== (rec.payload.text as string) ? {
                bgTranscript: ev.transcript,
              } : {}),
              audioKind: ev.kind, audioKindConf: ev.kindConf,
              salience: ev.salience, salienceConf: ev.salienceConf,
              summary: ev.summary,
              ...(ev.addressedToRobot ? { addressedToRobot: true, addressConf: ev.addressConf, directive: ev.directive } : {}),
              bgModel: true,                       // marks this snapshot as bg-upgraded
              ...(ev.model ? { audioModel: ev.model } : {}), // the background audio interpreter engine
            });
          }).catch(() => { /* keep the local STT text */ });
        }
        // confidence rides along so downstream sees the engine's certainty, not a constant.
        // Whisper gives a real logprob; Parakeet has none → the 0.8 neutral default.
        const conf = tr.avgLogprob != null ? Math.max(0, Math.min(1, 1 + tr.avgLogprob)) : 0.8;
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
          });
        }
      };
      const detector = new UtteranceDetector((pcm, startedAt, endedAt) => { void commit(pcm, startedAt, endedAt); });
      detector.commit = commit; // flushNow awaits this; the live path stays fire-and-forget
      // NON-SPEECH acoustic events (impulse/sustained): interpret the ring window and
      // land a 'sound' snapshot — laughter, music, a crash now exist in the record
      // (they were structurally invisible to the words-only pipeline).
      if (backgroundAudio) {
        detector.onAcousticTrigger = (trig, windowPcm, at) => {
          void backgroundAudio(windowPcm, SAMPLE_RATE, ctx.dockId, trig).then((ev) => {
            if (!ev) return;
            const windowMs = Math.round(windowPcm.length / (SAMPLE_RATE / 1000));
            store.add(makeSnapshot({
              dockId: ctx.dockId,
              source: { id: ctx.streamId, kind: 'sound', device: 'dock-webrtc', host: 'station' },
              model: { name: ev.model ?? 'bg-audio', endpoint: 'gemini' },
              from: new Date(at.getTime() - windowMs), to: at,
              payload: {
                text: ev.summary || `[${ev.kind}]`,
                audioKind: ev.kind, audioKindConf: ev.kindConf,
                salience: ev.salience, salienceConf: ev.salienceConf,
                ...(ev.addressedToRobot ? { addressedToRobot: true, addressConf: ev.addressConf, directive: ev.directive } : {}),
                trigger: trig,
              },
            }));
          }).catch(() => { /* best-effort */ });
        };
      }
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
      streams.set(ctx.streamId, { ctx, detector, muted: false });
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
      streams.get(streamId)?.detector.stop();
      streams.delete(streamId);
    },
  };
}

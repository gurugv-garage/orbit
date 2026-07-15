/**
 * Perception module — owns the `perception` topic, the per-dock world-state, and
 * the processor registry's contents. The PerceptionProcessingHub itself is built in main.ts
 * (it must be the SFU's media tap, wired before the perception module inits); this
 * module registers processors onto it and aggregates their results into
 * PerceptionState, exposed over REST + pushed live on the `perception` topic.
 *
 *   GET /api/perception          all docks' world states
 *   GET /api/perception/:dockId  one dock's world state
 *   POST /api/perception/result  worker/sidecar processors post results here (Phase 2)
 *
 * The dock subscribes to `perception` (directed results) and re-grounds its agent;
 * the browser console subscribes (undirected `state`) and renders a panel.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Bus } from '../../core/bus.js';
import { json } from '../../core/http.js';
import type { IncomingMessage } from 'node:http';
import type { RouteContext, StationModule } from '../../core/module.js';
import { fileURLToPath } from 'node:url';
import type { PerceptionProcessingHub } from './perception-processing-hub.js';
import { PerceptionState } from './state.js';
import { presenceProcessor } from './processors/presence.js';
import { faceRecognitionProcessor } from './processors/face-recognition.js';
import { visionSnapshotProcessor } from './processors/vision-snapshot.js';
import { identitySnapshotProcessor } from './processors/identity-snapshot.js';
import { speechWatchProcessor, utteranceWavPath } from './processors/speech-watch.js';
import { enrichAudio } from './processors/audio-enricher.js';
import { bodyMotionWatchProcessor, type MotionCommand } from './processors/bodymotion-watch.js';
import { SnapshotStore, isoIst, sampleEvenly, makeSnapshot, type SnapshotRecord } from './snapshots.js';
import { PerceiveStore, type PerceivePayload } from './perceive.js';
import { TakeStore } from './takes.js';
import { summarize, geminiText, stitch } from './summarizer.js';
import { buildGrounding, memoryGroundingSlice, type LastSummary, isSalient } from './grounding.js';
import { SidecarSupervisor } from './sidecars.js';
import { MemoryStore, type MemoryRow, type MemoryType, type RecallFilter, type LineageEdge } from './memory/store.js';
import { geminiEmbedder } from './memory/embedder.js';
import { startGateWatcher, type RaisedThought } from './attention/gate-watcher.js';
import { startAutoSummarizer } from './auto-summarizer.js';
import { selfCompressAndTrim, recordsSince, spanSummariesSince,
  recordsInWindow, spanSummariesInWindow, listDockHistory, dockHistory } from './retention.js';
import { DEFAULT_GATE_CONFIG, type GateConfig, type GateOutcome } from './attention/gate.js';
import { orbitDb } from '../../core/db.js';
import { setVisionExtra, getVisionExtra, visionBase } from './vision-instruction.js';
import { Gallery } from './face/gallery.js';
import { describeFace, describeAllFaces, type DetectedFace } from './face/recognizer.js';

/** A base64 JPEG (the dock's on-device camera frame) → its face descriptor. */
async function describeBase64(b64: string): Promise<number[] | null> {
  try { return await describeFace(Buffer.from(b64, 'base64')); } catch { return null; }
}
/** All faces in a base64 JPEG, left-to-right. Empty on decode/parse failure. */
async function describeAllBase64(b64: string): Promise<DetectedFace[]> {
  try { return await describeAllFaces(Buffer.from(b64, 'base64')); } catch { return []; }
}
/** A horizontal position word from a normalized x (0=left … 1=right). */
function sideOf(cx: number): 'left' | 'center' | 'right' {
  return cx < 0.4 ? 'left' : cx > 0.6 ? 'right' : 'center';
}
/** The MLX sidecars (the only out-of-process perception pieces). Same URLs +
 *  defaults the processors use (vision-snapshot.ts / speech-watch.ts). */
const SIDECARS = [
  { name: 'vision', kind: 'qwen2.5-VL temporal', modelField: 'temporal_model',
    url: process.env.TEMPORAL_SIDECAR_URL ?? 'http://127.0.0.1:8080' },
  { name: 'speech', kind: 'whisper small.en', modelField: 'stt_model',
    url: process.env.PERCEPTION_SIDECAR_URL ?? 'http://127.0.0.1:8078' },
] as const;

export interface SidecarHealth {
  name: string; kind: string; url: string; up: boolean;
  model?: string | null; latencyMs?: number; error?: string;
}

/** Ping each sidecar's GET /health with a short timeout; never throws. */
async function pingSidecars(): Promise<SidecarHealth[]> {
  return Promise.all(SIDECARS.map(async (s): Promise<SidecarHealth> => {
    const t0 = Date.now();
    try {
      const r = await fetch(`${s.url}/health`, { signal: AbortSignal.timeout(1500) });
      const latencyMs = Date.now() - t0;
      if (!r.ok) return { name: s.name, kind: s.kind, url: s.url, up: false, latencyMs, error: `HTTP ${r.status}` };
      const body = (await r.json()) as Record<string, unknown>;
      const model = (body[s.modelField] as string | undefined) ?? null;
      return { name: s.name, kind: s.kind, url: s.url, up: true, model, latencyMs };
    } catch (err) {
      return { name: s.name, kind: s.kind, url: s.url, up: false,
        error: err instanceof Error && err.name === 'TimeoutError' ? 'timeout' : 'unreachable' };
    }
  }));
}

/** The dock most of these records belong to (the store mixes docks; a summarize
 *  window is normally one dock's). Empty string if there are none. */
function dominantDock(recs: { dockId: string }[]): string {
  const tally = new Map<string, number>();
  for (const r of recs) if (r.dockId) tally.set(r.dockId, (tally.get(r.dockId) ?? 0) + 1);
  let best = '', n = 0;
  for (const [d, c] of tally) if (c > n) { best = d; n = c; }
  return best;
}

/** Named people in the LATEST identity record of a dock's recent records — used to
 *  bias the grounding memory slice toward beliefs about who's actually here. Only
 *  RECOGNISED names (not 'unknown'/null); empty if no identity yet. */
function presentNamesFromRecent(recent: SnapshotRecord[]): string[] {
  const id = [...recent].reverse().find((r) => r.source.kind === 'identity');
  const faces = (id?.payload.faces as Array<{ name: string | null }> | undefined) ?? [];
  return faces.map((f) => f.name).filter((n): n is string => !!n);
}
import { makeResult, type PerceptionResult } from './result.js';
import { classifyDistance, TENTATIVE_THRESHOLD } from './face/gallery.js';
import { VoiceIdService } from './voice/service.js';

// Gallery persists next to the server's data (alongside the db). One file.
const GALLERY_PATH = fileURLToPath(new URL('../../../data/face-gallery.json', import.meta.url));
// Voice twin of the face gallery — same data root, one file.
const VOICE_GALLERY_PATH = fileURLToPath(new URL('../../../data/voice-gallery.json', import.meta.url));
// Enrolled samples' audio clips — permanent (deleted only with their sample).
const VOICE_CLIPS_DIR = fileURLToPath(new URL('../../../data/voice-clips', import.meta.url));

// recollect_face frame sampling: how many of the grabber's latest frames to try
// before declaring "no one", and the gap between tries (so we sample DIFFERENT live
// frames). Tolerates a single blurred/dropped/blink frame. Tune via env.
const RECOGNIZE_FRAME_TRIES = Number(process.env.RECOGNIZE_FRAME_TRIES ?? 3);
const RECOGNIZE_FRAME_GAP_MS = Number(process.env.RECOGNIZE_FRAME_GAP_MS ?? 120);

// force_get_current consensus: how many fresh vision captures to take for an on-demand
// "what do you see now?". The small VLM is capable but inconsistent frame-to-frame, so
// several reads let the Gemini summarizer reconcile to the majority. 3 ≈ a few seconds
// (captures serialize on the single MLX sidecar). Tune via env.
const FORCE_GET_CAPTURES = Number(process.env.FORCE_GET_CAPTURES ?? 3);

/** One recognized (or unrecognized) face, as the brain's tools consume it. */
export interface RecognizedPerson {
  name: string | null;
  tentative: string | null;
  confidence: number;
  side: 'left' | 'center' | 'right';
  /** normalized bounding box 0..1 (x,y = top-left; w,h = size) — for control loops
   *  (faceFollow) that need WHERE precisely, not just the coarse `side`. */
  box: { x: number; y: number; w: number; h: number };
}
export interface RecognizeOut {
  name: string | null;
  tentative: string | null;
  confidence: number;
  noFace: boolean;
  people: RecognizedPerson[];
}

/**
 * In-process face API for the server brain's tools (remember/recollect/
 * confirm/forget_face) — the same operations the WS request/result flow
 * serves, minus the round-trip. Photo-first (the turn-request's attached
 * camera JPEG); falls back to the dock's live SFU frame via `streamId`.
 */
export interface FaceToolsApi {
  enroll(opts: { name: string; photo?: string; streamId?: string }): Promise<{ ok: boolean; reason?: string }>;
  recognize(opts: { photo?: string; streamId?: string }): Promise<RecognizeOut>;
  confirm(opts: { name: string; photo?: string; streamId?: string }): Promise<{ ok: boolean }>;
  forget(opts: { name: string; streamId?: string }): Promise<{ ok: boolean }>;
  /** The latest decoded frame of a live SFU stream as base64 JPEG — the
   *  brain's vision source when the phone didn't attach a photo (the video
   *  is already flowing; vision turns need no extra upload). */
  frame(streamId: string): string | undefined;
  /** Is this name enrolled in the gallery (case-insensitive)? — the gallery pre-check for
   *  find_person: "do I actually know this person before I go looking for them?". */
  knowsPerson(name: string): boolean;
  /** Canonical display names of everyone enrolled — so find_person can say who it CAN find. */
  knownNames(): string[];
}

const faceToolsRef: { current?: FaceToolsApi } = {};
/** The live FaceToolsApi (set when the perception module inits). */
export function getFaceTools(): FaceToolsApi | undefined {
  return faceToolsRef.current;
}

/**
 * Perception GROUNDING for the brain (docs/perception-to-brain.md Decision 3.1):
 * the per-turn context block — the last summary (stamped with staleness) plus the
 * raw stream since it. Pulled synchronously when a turn is built (no Gemini on the
 * turn's critical path); the brain injects the returned string into the prompt.
 * Returns undefined when nothing has been perceived yet (a cold dock).
 */
export interface PerceptionGroundingApi {
  /** the grounding block for `dockId` right now, or undefined if there's nothing. */
  /** `coherent` (coherence-layer.md step 1): salient-events-only tail — the
   *  self-thought variant. Conversations omit it and get the full raw tail. */
  forDock(dockId: string, opts?: { coherent?: boolean }): string | undefined;
  /**
   * FORCE a fresh summary of the live moment NOW (docs/perception-to-brain.md 3.2
   * `force_get_current`): flush the in-flight tail (open utterance + a one-shot
   * vision capture), summarize the just-closed window, cache it as the dock's last
   * summary (so grounding goes live), and return the summary text. Costs a Gemini
   * call + a vision capture — deliberate, agent-invoked, NOT per-turn. `streamId`
   * is the dock's live camera stream (for the vision flush); omit if none.
   */
  forceCurrent(dockId: string, streamId?: string, windowMs?: number): Promise<{ summary: string; error?: string; window: { from: string; to: string } }>;
}

const groundingRef: { current?: PerceptionGroundingApi } = {};

/** FEEDBACK LOOP (coherence-layer.md §4): the brain reports an unprompted SPOKEN
 *  remark; a minute later we pair it with the salient perception that followed and
 *  add the pair as a 'summary'-kind ring record (source.id 'feedback-pair') — curator
 *  evidence that a remark landed well, oddly, or into a void. */
const selfRemarkRef: { current?: (dockId: string, text: string) => void } = {};

/** BOREDOM-ON-COHERENCE pulse (coherence-layer.md step 5): epoch ms of the last
 *  SALIENT record for a dock, or null when perception is cold/unwired. */
const salientPulseRef: { current?: (dockId: string) => number | null } = {};
export function lastSalientAt(dockId: string): number | null {
  return salientPulseRef.current?.(dockId) ?? null;
}
export function noteSelfRemark(dockId: string, text: string): void {
  selfRemarkRef.current?.(dockId, text);
}
/** The durable PERCEPTION SPAN since a checkpoint (§7c) — the "everything I've perceived since
 *  I last introspected" feed the ego reads. ONE stream, TWO fidelities: for the OLDER part of
 *  the span (where raw was trimmed) it reads the stream's own **span-summaries** (perception
 *  compressed its tail); for the RECENT part it reads RAW (the enriched truth), stitched into a
 *  clean transcript. Consumption is the constraint, not storage — so raw is capped by
 *  `maxRecords` (the most recent N; §7c "read raw up to a budget"). Chronological: summaries of
 *  the older gap first, then the recent raw. Returns '' only if the span has neither. */
/** MEMORY-ARM DEDUP: the audio enricher writes the authoritative speech records; parakeet also
 *  writes a live-only record for the SAME utterance (for the addressed-latch/console). The memory
 *  arm must NOT summarize both — drop each `liveOnly` speech record whose span overlaps an ENRICHED
 *  speech record (the enriched one is the truth). Non-speech + un-superseded records pass through. */
export function dropSupersededSpeech(records: SnapshotRecord[]): SnapshotRecord[] {
  // ENRICHED speech = a one-per-call 'enriched' record that CONTAINS real in-room speech (the
  // hasSpeech roll-up; a pure media/sound call doesn't supersede a spoken utterance). Only those
  // override a live-only parakeet 'speech' record whose span the enriched clip window covers.
  const enriched = records.filter((r) => r.source.kind === 'enriched'
    && (r.payload as { hasSpeech?: boolean }).hasSpeech === true);
  if (!enriched.length) return records; // no enricher speech → nothing supersedes parakeet
  const overlaps = (a: SnapshotRecord, b: SnapshotRecord) =>
    a.interval.from <= b.interval.to && b.interval.from <= a.interval.to;
  return records.filter((r) => {
    if (r.source.kind !== 'speech' || !(r.payload as { liveOnly?: boolean }).liveOnly) return true;
    return !enriched.some((e) => overlaps(e, r)); // drop a live-only utterance the enricher covered
  });
}

export function perceptionSince(dockId: string, sinceIso: string, maxRecords = 300): string {
  const raw = dropSupersededSpeech(recordsSince(dockId, sinceIso).filter((r) => r.source.kind !== 'summary'));
  const capped = raw.slice(-maxRecords); // most-recent N raw (the consumption budget)
  const parts: string[] = [];
  // OLDER fidelity: span-summaries whose span starts at/after the checkpoint. If raw was capped,
  // the span-summaries covering the trimmed-off older gap are exactly what fills it.
  const summaries = spanSummariesSince(dockId, sinceIso);
  if (summaries.length) {
    const digest = summaries.map((s) => {
      const from = (s.interval.from.slice(11, 16)); const to = s.interval.to.slice(11, 16);
      return `[earlier, ${from}–${to}] ${s.payload.text}`;
    }).join('\n');
    parts.push(`EARLIER (compressed — raw no longer retained):\n${digest}`);
  } else if (raw.length > capped.length) {
    parts.push(`(earlier ${raw.length - capped.length} perceptions omitted for length)`);
  }
  // RECENT fidelity: the raw span — with OFFLINE gaps labelled. A stretch with NO records is
  // DOWNTIME (the station was off — nothing was written), NOT an empty room (an idle-but-running
  // dock still emits records, even sparse ones). The self must read a gap as its own downtime, not
  // the world emptying — else a restart looks like abandonment.
  if (capped.length) parts.push(stitchWithGaps(capped));
  return parts.join('\n\n');
}

/** The RECONCILED perception feed for the ego (the fix for the "my eyes are broken" spiral). The
 *  ego must NOT reason over raw sensor lines — a small vision model that hallucinates objects, an
 *  identity detector that flickers "no one" mid-presence, and overheard (not addressed) speech all
 *  CONTRADICT each other, and a faithful reasoner reads that as "my senses are defective" rather
 *  than "my senses are noisy". Quality-control belongs in the SUMMARIZER (one place, no buck-
 *  passing — user decision 2026-07-10): so the ego reads the summarizer's reconciled output, never
 *  raw. Assembles: span-summaries (older, already reconciled) + the rolling summary (recent
 *  reconciled "now") + an ON-DEMAND summary of the un-summarized tail (same summarizer). Async
 *  (the tail summary is a Gemini call); introspection is already an LLM call at ≤hourly cadence, so
 *  the extra call is cheap. Falls back to `perceptionSince` (raw) only if summarization is
 *  unavailable, so a fresh dock / no-Gemini still works. */
export async function reconciledPerceptionSince(
  dockId: string, sinceIso: string, rollingSummary?: { text: string; toIso?: string },
): Promise<string> {
  const parts: string[] = [];
  // OLDER: reconciled span-summaries since the checkpoint.
  const summaries = spanSummariesSince(dockId, sinceIso);
  if (summaries.length) {
    const digest = summaries.map((s) => `[earlier, ${s.interval.from.slice(11, 16)}–${s.interval.to.slice(11, 16)}] ${s.payload.text}`).join('\n');
    parts.push(`EARLIER (your reconciled memory of older spans):\n${digest}`);
  }
  // RECENT: the rolling summary (the summarizer's reconciled "what's going on now").
  const rollTo = rollingSummary?.toIso;
  if (rollingSummary?.text) parts.push(`RECENTLY (your reconciled read of the current stretch):\n${rollingSummary.text}`);
  // TAIL: records newer than the rolling summary's window — summarize on demand so the ego never
  // sees raw. Boundary = max(checkpoint, rolling.to); if there's a meaningful tail, reconcile it.
  const tailSinceIso = rollTo && rollTo > sinceIso ? rollTo : sinceIso;
  const tail = dropSupersededSpeech(recordsSince(dockId, tailSinceIso).filter((r) => r.source.kind !== 'summary')).slice(-120);
  if (tail.length >= 2) {
    try {
      const r = await summarize(tail, { windowFromIso: tailSinceIso });
      if (r.summary && !/^\(/.test(r.summary.trim())) parts.push(`JUST NOW (reconciled from the latest, still-uncompressed moments):\n${r.summary.trim()}`);
    } catch { /* tail reconcile best-effort — a summarizer failure just omits the freshest sliver */ }
  }
  // Fallback: if nothing reconciled was available at all (fresh dock / no Gemini), give raw so the
  // ego isn't blind — better a noisy read than none, and a fresh dock has little to misread yet.
  if (!parts.length) return perceptionSince(dockId, sinceIso);
  return parts.join('\n\n');
}

/** Stitch the raw records, but insert an explicit DOWNTIME marker wherever there's a no-record gap
 *  longer than OFFLINE_GAP_MS between consecutive records. "No records at all" is the offline
 *  signal (records-that-say-"no one" are a real empty room and pass through untouched). */
const OFFLINE_GAP_MS = Number(process.env.PERCEPTION_OFFLINE_GAP_MS ?? 20 * 60_000); // > 20 min silence = downtime
function stitchWithGaps(records: SnapshotRecord[]): string {
  if (records.length < 2) return stitch(records);
  const out: string[] = [];
  for (let i = 0; i < records.length; i++) {
    if (i > 0) {
      const prevEnd = Date.parse(records[i - 1]!.interval.to || records[i - 1]!.interval.from);
      const thisStart = Date.parse(records[i]!.interval.from);
      const gapMs = thisStart - prevEnd;
      if (gapMs > OFFLINE_GAP_MS) {
        const h = Math.floor(gapMs / 3600_000), m = Math.round((gapMs % 3600_000) / 60_000);
        const dur = h ? `${h}h${m ? ` ${m}m` : ''}` : `${m}m`;
        out.push(`[⚠ offline ~${dur} — no perception recorded here; this was DOWNTIME (you were off), not an empty room]`);
      }
    }
    out.push(stitch([records[i]!]));
  }
  return out.join('\n');
}
/** The span-digest prompt (§7c self-compression, quality path). This runs at TRIM time over a
 *  whole aged-out span (hours), and its job is different from the ~60 s "what's going on right
 *  now" situational brief: it produces the DURABLE MEMORY of a past stretch of the dock's life —
 *  what a self would want to still know after the raw is gone. So it keeps the throughline, the
 *  people, the notable events and changes, and the emotional arc; compresses steady-state; and
 *  stays faithful (it must not invent — thin/absent perception should read as a quiet, empty
 *  stretch, not a fabricated scene). Text-in/text-out over the already-stitched transcript. */
const SPAN_DIGEST_SYSTEM = [
  'You are a personal robot compressing your own memory of a PAST stretch of time (the raw',
  'perception for it is about to be discarded — this digest is all you will keep of it).',
  'From the time-stamped perception transcript below, write a compact, faithful memory of what',
  'happened over this span — the kind of thing you would want to still remember later.',
  '',
  'Keep: the throughline (what the span was mostly about), who was present (name them when',
  'IDENTITY/diarization support it), notable events and CHANGES (someone arriving/leaving, a',
  'request, a conflict, a resolution), and the emotional arc if one is legible. Compress',
  'steady-state and repetition to a phrase. Drop noise, flicker, and low-confidence junk.',
  '',
  'Be faithful above all — this becomes memory, so a fabrication here is a false memory. Do NOT',
  'invent presence or events from thin/ambiguous perception; if the span was mostly empty or',
  'quiet, say so plainly ("a long quiet stretch, no one around") rather than inventing a scene.',
  'A single VISION line is a guess, not fact. Write a few plain sentences, past tense, no preamble.',
].join('\n');

/** Compress one aged-out span into a durable memory digest (injected into selfCompressAndTrim). Stitches
 *  the raw records into a transcript, then runs the span-digest prompt. Returns '' on failure so
 *  retention keeps the raw for a retry (never silent loss). */
async function trimSpanDigest(records: SnapshotRecord[]): Promise<string> {
  try {
    if (!records.length) return '';
    const dockId = records[0]!.dockId;
    const transcript = stitch(records);
    const text = await geminiText(
      `${SPAN_DIGEST_SYSTEM}\n\n=== PERCEPTION TIMELINE (span) ===\n${transcript}\n\n=== MEMORY ===`,
      dockId, 'span-digest',
    );
    return (text || '').trim();
  } catch { return ''; }
}

/** The fact-extraction prompt (§7c unified memory — the summarizer's SECOND output, apart from the
 *  digest). At the same trim pass, pull out DURABLE FACTS worth remembering ("Guru prefers tea",
 *  "the standup is at 5pm") — not "what happened this hour" (that's the digest) but "what's true /
 *  worth keeping as a queryable fact". Faithful: only facts the perception actually supports; a
 *  quiet/empty span yields none. Returns strict JSON so we can store structured beliefs. */
const FACT_EXTRACT_SYSTEM = [
  'You are a personal robot deciding what, from a stretch of your perception, is worth REMEMBERING',
  'as a durable fact — the kind of thing still true and useful long after this hour is forgotten.',
  '',
  'REMEMBER mostly about PEOPLE and what passes between you and them: a person\'s name, a preference',
  'or habit they reveal, their role, a relationship, a commitment or plan, something they asked or',
  'told you, how an interaction went. That is what a companion keeps. Do NOT catalogue the SCENERY —',
  'furniture, room layout, lights, windows, fixtures are not facts worth a memory; skip them.',
  '',
  'ADDRESSED vs OVERHEARD: speech tagged "[→ TO YOU]" was said to you — a real interaction worth',
  'remembering. Speech tagged "[overheard — not to you]" is room chatter / a video / another',
  'conversation you were NOT part of — do NOT store it as a fact about your relationship with',
  'anyone, and do NOT record its content as something someone told YOU. At most, an overheard',
  'stretch is context ("someone was doing a workout nearby"), never a fact you were told.',
  '',
  'FAITHFULNESS IS EVERYTHING — this becomes permanent memory, so a wrong fact is a false belief you',
  'will carry for weeks. VISION is a SMALL model that HALLUCINATES objects (it notoriously invents',
  '"gymnastic rings / a pull-up bar / exercise apparatus" from straps, hooks, or cables). NEVER store',
  'a fact that rests on a single vision line, or on vision alone — a durable fact needs speech or',
  'repeated, consistent evidence. When unsure, DON\'T remember it. An empty list is the common,',
  'correct answer for a quiet or ordinary stretch. Never invent.',
  '',
  'Return STRICT JSON only, no prose: {"facts":[{"subject":"<short entity, e.g. guru>","claim":',
  '"<the durable fact, e.g. prefers tea>","confidence":<0..1>}]}. subject is a short normalized tag',
  '(a person\'s name where possible); confidence is conservative — 0.4–0.7 typical, only speech-',
  'corroborated facts go higher.',
].join('\n');

/** Extract durable facts from an aged-out span and store them (§7c unified memory). The summarizer's
 *  second output — runs in the SAME trim pass as the digest, ONE checkpoint. Append + LIGHT DEDUP:
 *  for each candidate, look for a near-duplicate on the same subject already in the store; if found,
 *  revise it (keeps the store self-maintaining without a separate reconcile job); else remember it.
 *  Best-effort and non-throwing — a failure must never block trim/compression. Injected into
 *  selfCompressAndTrim so retention.ts stays free of Gemini/store deps. */
async function extractFactsFromSpan(records: SnapshotRecord[], memory: MemoryStore): Promise<number> {
  try {
    const raw = records.filter((r) => r.source?.kind !== 'summary');
    if (raw.length < 3) return 0; // too thin to yield a durable fact
    const dockId = raw[0]!.dockId;
    const transcript = stitch(raw);
    const out = await geminiText(
      `${FACT_EXTRACT_SYSTEM}\n\n=== PERCEPTION TIMELINE (span) ===\n${transcript}\n\n=== JSON ===`,
      dockId, 'fact-extract',
    );
    const m = out.match(/\{[\s\S]*\}/);
    if (!m) return 0;
    let facts: Array<{ subject?: string; claim?: string; confidence?: number }> = [];
    try { facts = (JSON.parse(m[0]) as { facts?: typeof facts }).facts ?? []; } catch { return 0; }
    let stored = 0;
    for (const f of facts) {
      const claim = (f.claim || '').trim();
      if (!claim) continue;
      const subject = (f.subject || '').trim().toLowerCase();
      const confidence = typeof f.confidence === 'number' ? Math.max(0, Math.min(1, f.confidence)) : 0.5;
      // LIGHT DEDUP: semantic recall on the same subject; a close claim → revise, else remember.
      let dupId: string | undefined;
      try {
        const hits = await memory.recall({ dockId, subject: subject || undefined, query: claim, limit: 3 });
        dupId = hits.find((h) => sameFact(h.claim, claim))?.id;
      } catch { /* recall best-effort */ }
      try {
        if (dupId) { await memory.revise(dupId, { claim, confidence }); }
        else { await memory.remember({ dockId, type: 'fact', subject: subject || undefined, claim, confidence, derivation: 'derived' }); }
        stored++;
      } catch { /* store best-effort */ }
    }
    return stored;
  } catch { return 0; }
}

/** Cheap near-duplicate test for two fact claims (light dedup — not a full reconcile). Normalizes
 *  and checks token-overlap; a high overlap on the same subject means "the same fact, refresh it". */
function sameFact(a: string, b: string): boolean {
  const norm = (s: string) => new Set(s.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter((w) => w.length > 2));
  const A = norm(a), B = norm(b);
  if (!A.size || !B.size) return false;
  let inter = 0; for (const w of A) if (B.has(w)) inter++;
  return inter / Math.min(A.size, B.size) >= 0.6;
}

/** The live PerceptionGroundingApi (set when the perception module inits). */
export function getPerceptionGrounding(): PerceptionGroundingApi | undefined {
  return groundingRef.current;
}

/**
 * The MEMORY facade for the brain (docs/perception-to-brain.md Decision 4 + the
 * 3.2 pull tools) — the dock's unified, evolving, per-dock memory, exposed the
 * way an LLM agent reaches for it: discover (subjects/recent), recall (structured
 * AND/OR semantic), inspect (lineage), and mutate (remember/update/forget). Wraps
 * MemoryStore so the brain never touches sqlite directly (same facade pattern as
 * FaceToolsApi). A `memoryHit` carries the lineage inline for inspect.
 */
export interface MemoryApi {
  recall(f: RecallFilter): Promise<MemoryRow[]>;
  inspect(id: string): { memory: MemoryRow; lineage: LineageEdge[] } | undefined;
  remember(m: { dockId: string; type: MemoryType; subject?: string; claim: string; confidence?: number }): Promise<string>;
  update(id: string, patch: { claim?: string; confidence?: number; subject?: string }): Promise<string | null>;
  forget(id: string): boolean;
  subjects(dockId: string): string[];
  recent(dockId: string, limit?: number): MemoryRow[];
  count(dockId: string): number;
}

const memoryRef: { current?: MemoryApi } = {};
/** The live MemoryApi (set when the perception module inits). */
export function getMemoryApi(): MemoryApi | undefined {
  return memoryRef.current;
}
/** The live MemoryStore (for the console's memory inspector REST routes). */
const memoryStoreRef: { current?: MemoryStore } = {};
export function getMemoryStore(): MemoryStore | undefined {
  return memoryStoreRef.current;
}

/** RUNTIME state of the AUDIO ENRICHER (Gemini) — flippable live from the Perception Studio
 *  (GET/POST /api/perception/enricher). The enricher is ALWAYS ON (it's
 *  the sole authoritative audio path now), so `enabled` is retained only for API back-compat;
 *  `model` is the live-selectable Gemini model the enricher runs. Seeded from
 *  PERCEPTION_ENRICH_MODEL.
 *  TRIGGER PATHS (which audio starts an enrich call): `speech` = Path A, parakeet speech endpoint
 *  (real in-room speech); `nonSpeech` = Path B, acoustic/ambient event. Default speech ON /
 *  nonSpeech OFF — only real speech reaches Gemini; ambient sound is ignored (no value + costs a
 *  call). A disabled path never arms, so no clip of that kind is produced. Pushed live to every
 *  detector via `applyEnrichPaths()`. */
const enricher_ = { enabled: true, model: 'gemini-2.5-flash-lite', speech: true, nonSpeech: false };
export function getEnricherState() { return { ...enricher_ }; }
/** The model the live enricher should use right now (console-selectable). */
export function currentEnrichModel(): string { return enricher_.model; }
/** Live detectors that want the enrich-path gates pushed to them. speech-watch registers each
 *  UtteranceDetector's `setEnrichPaths` here so a console toggle applies without a restart. */
const enrichPathSinks = new Set<(p: { speech: boolean; nonSpeech: boolean }) => void>();
export function registerEnrichPathSink(apply: (p: { speech: boolean; nonSpeech: boolean }) => void): () => void {
  apply({ speech: enricher_.speech, nonSpeech: enricher_.nonSpeech }); // seed the new detector with current state
  enrichPathSinks.add(apply);
  return () => { enrichPathSinks.delete(apply); };
}
function applyEnrichPaths(): void {
  for (const apply of enrichPathSinks) apply({ speech: enricher_.speech, nonSpeech: enricher_.nonSpeech });
}

/** Dock-addressed OBSERVATIONS from the background audio interpreter — the brain
 *  registers a handler and DECIDES (wake fallback for the local STT mis-hearing the
 *  robot's name: Parakeet renders "orbit" as "alright"/"hey now", so the local wake
 *  matcher never sees it, but the online interpreter hears the name in the audio). */
export interface BgAddressedEvent { dockId: string; directive: string; transcript: string; conf: number }
let bgAddressedHandler: ((e: BgAddressedEvent) => void) | undefined;
export function getBgAddressedApi() {
  return { onAddressed: (h: (e: BgAddressedEvent) => void) => { bgAddressedHandler = h; } };
}

/** The brain stamps its authoritative addressed-vs-overheard decision onto the speech snapshot
 *  (docs/TODO.md §3.0). Set when the perception module inits; the brain calls it from every branch
 *  of onAddressedFinal (ran-a-turn / wake → addressed=true; not-addressed → addressed=false). */
let markAddressedHandler: ((dockId: string, endedAtMs: number, addressed: boolean) => void) | undefined;
export function markSpeechAddressed(dockId: string, endedAtMs: number, addressed: boolean): void {
  markAddressedHandler?.(dockId, endedAtMs, addressed);
}

/** The brain calls this the moment it WAKES the robot from an enricher-addressed utterance, so the
 *  enricher record that triggered it gets stamped `wokeRobot: true` — visible on the row (🤖). The
 *  wake happens downstream of the record write, so this patches it after the fact (by matching the
 *  most recent enriched addressed record for the dock with this text). */
let markWokeHandler: ((dockId: string, text: string) => void) | undefined;
export function markEnrichWoke(dockId: string, text: string): void { markWokeHandler?.(dockId, text); }

/**
 * The proactive ATTENTION GATE control surface (docs/perception-to-brain.md Phase 5).
 * The brain registers `onRaise` so a gate firing becomes a self-thought
 * (enqueueAutonomousTurn); the console toggles `enabled` + reads recent decisions.
 */
export interface GateApi {
  setEnabled(on: boolean): void;
  isEnabled(): boolean;
  /** the brain calls this once to receive raised thoughts. */
  onRaise(fn: (t: RaisedThought) => void): void;
  /** recent gate decisions (raises + why-not), newest first — for the console. */
  recentDecisions(limit?: number): Array<{ ts: number; dockId: string; raised: boolean; detail: string }>;
}
const gateRef: { current?: GateApi } = {};
/** The live GateApi (set when the perception module inits). */
export function getGateApi(): GateApi | undefined {
  return gateRef.current;
}

/**
 * Final-transcript hook (A1.2, the always-on-mic shift). The server STT
 * (speech-watch) emits one final transcript per endpointed utterance; the brain
 * registers `onFinal` to receive each with its utterance window, so it can decide
 * — via the addressed latch — whether that utterance becomes an agent turn.
 * Mirrors GateApi.onRaise (a single consumer, set once at brain init).
 */
export interface FinalTranscript {
  dockId: string;
  streamId: string;
  text: string;
  /** the utterance's VAD window (ms epoch) — drives the addressed correlation. */
  startedAt: number;
  endedAt: number;
  /** Whisper's own confidence flag (a gasp/low-conf word is tagged, not dropped). */
  lowConfidence: boolean;
  /** graded confidence: 'good' | 'shaky' | 'garbage'. A 'garbage' addressed utterance
   *  (far-field mush / repetition-loop) should not become a confident agent turn. */
  confTier?: 'good' | 'shaky' | 'garbage';
  /** Voice fingerprint (hearing-identity): the best enrolled candidate for this
   *  utterance's voice + whether it cleared the match threshold. */
  voice?: { name: string; score?: number; match?: boolean };
}
/** A LIVE interim (partial) transcript — emitted mid-utterance for the dock caption
 *  UI. Cosmetic: the authoritative transcript is still the endpointed FinalTranscript.
 *  seq is monotonic per utterance (resets each utterance) so a stale arrival is dropped. */
export interface InterimTranscript {
  dockId: string;
  streamId: string;
  text: string;
  startedAt: number;
  seq: number;
}
export interface TranscriptApi {
  /** the brain calls this once to receive final transcripts. */
  onFinal(fn: (t: FinalTranscript) => void): void;
  /** A1.2 echo-gate: the brain reports when the dock's OWN TTS is playing, so
   *  the STT processor drops audio then (no self-transcribe). Mirrors the brain's
   *  noteSpeech signal (the phone's speech-status frames). */
  setSpeaking(dockId: string, speaking: boolean): void;
  /** the brain calls this once to receive LIVE interim (partial) transcripts to
   *  forward to the dock caption UI. Best-effort; decoupled from onFinal. */
  onInterim(fn: (t: InterimTranscript) => void): void;
  /** the brain calls this once to receive SPEECH-ONSET events (someone started
   *  talking — fired after ~240ms of sustained voice, long before the final).
   *  Drives the barge-in "polite pause": hold TTS while the dock is mid-reply. */
  onSpeechStart(fn: (e: { dockId: string; at: number }) => void): void;
  /** the brain registers HOW to check "is dock X in a listening/followup turn" — the
   *  gate that decides whether interims are produced at all (bounds the GPU cost to
   *  active turns, not ambient speech). Until set, NO interims fire. */
  setListeningResolver(fn: (dockId: string) => boolean): void;
}
const transcriptRef: { current?: TranscriptApi } = {};
/** The live TranscriptApi (set when the perception module inits). */
export function getTranscriptApi(): TranscriptApi | undefined {
  return transcriptRef.current;
}

/** Read-only access to the snapshot store for other modules (the capture/judging
 *  harness needs the snapshots produced during a recorded window). */
export interface SnapshotsApi {
  /** Snapshots whose interval overlaps [fromIso, toIso], optionally one dock. */
  inWindow(fromIso: string, toIso: string, dockId?: string): SnapshotRecord[];
}
const snapshotsRef: { current?: SnapshotsApi } = {};
export function getSnapshotsApi(): SnapshotsApi | undefined {
  return snapshotsRef.current;
}

/** The live per-dock `perceive` store (on-device MLKit face-track). Reachable by the
 *  faceFollow `face-track` capability (the fast face source — §7) and the console.
 *  Set when the perception module inits. */
const perceiveRef: { current?: PerceiveStore } = {};
export function getPerceiveStore(): PerceiveStore | undefined {
  return perceiveRef.current;
}


/** The camera-moving signal, set by main.ts from the MotionExecutor. Perception stays
 *  decoupled from bodylink (clean layering) — main wires the two together. Returns true
 *  if the dock's head panned within the settle window (self-motion, not world change). */
const cameraMovingRef: { current?: (dockId: string) => boolean } = {};
export function setCameraMoving(fn: (dockId: string) => boolean): void { cameraMovingRef.current = fn; }

export function perceptionModule(getHub: () => PerceptionProcessingHub): StationModule {
  let state: PerceptionState;
  const snapshots = new SnapshotStore(); // WebRTC vision+speech snapshot records
  snapshotsRef.current = {
    inWindow: (fromIso, toIso, dockId) =>
      snapshots.inWindow(fromIso, toIso).filter((r) => !dockId || r.dockId === dockId),
  };
  // ADDRESSED-STAMP (docs/TODO.md §3.0 seam): the BRAIN owns the authoritative addressed-vs-
  // overheard decision (tap / wake / conversation-window latch). It calls this to stamp the
  // decision onto the SPEECH snapshot, so the summarizer, fact-extraction, and the ego can tell
  // "said TO the dock" from room chatter — instead of treating all speech identically (which made
  // the ego think overheard workout instructions were addressed to it). Finds the speech record by
  // its utterance end time (± a small tolerance) and patches payload.addressed. Best-effort.
  markAddressedHandler = (dockId, endedAtMs, addressed) => {
    try {
      const to = isoIst(new Date(endedAtMs));
      const win = 4000; // ± tolerance: match the utterance whose end is near endedAtMs
      const from = new Date(endedAtMs - 60_000 + 5.5 * 3600_000).toISOString();
      const cands = snapshots.inWindow(from, isoIst(new Date(endedAtMs + win)))
        .filter((r) => r.dockId === dockId && r.source.kind === 'speech');
      // the record whose `to` (utterance end) is closest to endedAtMs
      let best: SnapshotRecord | undefined; let bestDist = win;
      for (const r of cands) {
        const d = Math.abs(Date.parse(r.interval.to) - Date.parse(to));
        if (d <= bestDist) { best = r; bestDist = d; }
      }
      if (best) snapshots.update(best, { addressed });
    } catch { /* best-effort — never break the turn path */ }
  };
  // WOKE THE ROBOT: stamp the enriched addressed record that triggered a wake (so the row shows 🤖).
  // The wake fires synchronously off the enricher result but AFTER the record is written, so we
  // patch the most recent enriched+addressed record for the dock whose text matches.
  markWokeHandler = (dockId, text) => {
    try {
      const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
      const want = norm(text);
      const recent = snapshots.list().filter((r) => r.dockId === dockId && r.source.kind === 'enriched'
        && (r.payload as { addressedToRobot?: boolean }).addressedToRobot);
      // newest record whose ADDRESSED SEGMENT text matches the wake text (walk from the end). One
      // fused record carries N segments; match the addressed one, not the stitched roll-up.
      for (let i = recent.length - 1; i >= 0; i--) {
        const segs = (recent[i]!.payload as { segments?: Array<{ text?: string; addressedToRobot?: boolean }> }).segments ?? [];
        if (segs.some((s) => s.addressedToRobot && norm(String(s.text ?? '')) === want)) {
          snapshots.update(recent[i]!, { wokeRobot: true });
          break;
        }
      }
    } catch { /* best-effort */ }
  };
  const takes = new TakeStore();         // frozen snapshot bundles for A/B replay
  // LIVE per-dock face-track (the on-device MLKit `perceive` stream, §7) — latest-state,
  // NOT the heavy snapshot ring. The faceFollow `face-track` capability reads it.
  const perceive = new PerceiveStore();
  perceiveRef.current = perceive;
  // Latest produced summary PER DOCK — the head of perception grounding (3.1). Set
  // on each successful /snapshots/summarize; read synchronously by the brain facade.
  // PERSISTED to .data (coherence-layer.md §6): the rolling picture is the coherence
  // engine's short-horizon state — a station restart used to amnesia-wipe the day
  // (grounding starts from it). Loaded at construction;
  // written on each set (summaries are ≥60 s apart, a write per set is nothing).
  const LAST_SUMMARY_FILE = '.data/perception/last-summary.json';
  const lastSummary = new Map<string, LastSummary>();
  try {
    const raw = JSON.parse(readFileSync(LAST_SUMMARY_FILE, 'utf8')) as Record<string, LastSummary>;
    for (const [dock, v] of Object.entries(raw)) if (v?.text && v.window?.from) lastSummary.set(dock, v);
    if (lastSummary.size) console.log(`[perception] restored ${lastSummary.size} rolling summar${lastSummary.size === 1 ? 'y' : 'ies'} from disk`);
  } catch { /* first boot / no file — fine */ }
  const persistLastSummaries = () => {
    try {
      mkdirSync(dirname(LAST_SUMMARY_FILE), { recursive: true });
      writeFileSync(LAST_SUMMARY_FILE, JSON.stringify(Object.fromEntries(lastSummary), null, 2));
    } catch (err) { console.warn(`[perception] last-summary persist failed: ${String(err)}`); }
  };
  // The unified per-dock MEMORY store (Decision 4) — durable sqlite, gemini-embedded
  // for semantic recall. Backs the recall_memory/inspect/remember/update/forget tools.
  const memory = new MemoryStore(orbitDb(), geminiEmbedder());
  const sidecars = new SidecarSupervisor(); // start/stop the MLX sidecars from the console
  let bus: Bus;
  const gallery = new Gallery(GALLERY_PATH);
  const face = faceRecognitionProcessor(gallery);
  // VOICE FINGERPRINT (observe-only trial): per-utterance speaker embeddings from
  // the STT sidecar (--embed-model), matched against an enrolled voice gallery —
  // the audio twin of the face gallery above. Labels speech snapshots only; no
  // brain/addressed wiring yet. Kill: PERCEPTION_VOICE_ID=0.
  const voiceId = new VoiceIdService(VOICE_GALLERY_PATH, VOICE_CLIPS_DIR);
  // A1.2: the brain registers onFinal (via TranscriptApi) to receive each final
  // utterance; we hold the single handler and forward speech-watch's events to it.
  // It also reports `speaking` per dock (echo-gate) — speech-watch drops audio then.
  let finalHandler: ((t: FinalTranscript) => void) | undefined;
  // LIVE INTERIMS: the brain registers a handler (to forward partials to the dock UI)
  // and a listening-resolver (the gate — only produce interims during an active turn).
  let interimHandler: ((t: InterimTranscript) => void) | undefined;
  let listeningResolver: ((dockId: string) => boolean) | undefined;
  let speechStartHandler: ((e: { dockId: string; at: number }) => void) | undefined;
  // Echo-gate: a dock is "speaking" while its TTS plays AND for a short tail after
  // (TTS reverb + AEC settle still leak into the mic just after speech-status off).
  // Map dockId → epoch ms until which it counts as speaking.
  //
  // CRITICAL: the deadline is ALWAYS FINITE and self-healing. `speaking:true` does
  // NOT latch forever — it sets a bounded window that each subsequent frame extends.
  // If a `speaking:false` (or a long TTS's repeated keepalives) is ever lost, the
  // gate auto-recovers when the window lapses instead of stranding the station
  // permanently deaf (the stuck-mute bug). A real long reply re-sends speech-status
  // as it streams sentences, so the window keeps extending while TTS actually plays.
  const SPEAK_ON_WINDOW_MS = 6_000; // a single speech-status:true holds the mute this long…
  const SPEAK_TAIL_MS = 800;        // …and a speech-status:false leaves this much tail.
  const speakingUntil = new Map<string, number>();
  transcriptRef.current = {
    onFinal: (fn) => { finalHandler = fn; },
    setSpeaking: (dockId, on) => {
      speakingUntil.set(dockId, Date.now() + (on ? SPEAK_ON_WINDOW_MS : SPEAK_TAIL_MS));
    },
    onInterim: (fn) => { interimHandler = fn; },
    onSpeechStart: (fn) => { speechStartHandler = fn; },
    setListeningResolver: (fn) => { listeningResolver = fn; },
  };
  // AUDIO ENRICHER (production split, docs/findings/recall-reliability.md): each
  // VAD-gated utterance is async re-transcribed online (Gemini) to UPGRADE the
  // snapshot with a better, DIARIZED transcript for recall. The live addressed-turn
  // path stays local Whisper. This is a RUNTIME toggle (the Perception Studio
  // flips it live) rather than a fixed env var: PERCEPTION_ENRICH_MODEL only seeds
  // the model name + the initial enabled state, so existing setups behave as before
  // (env set → on at boot; env unset → off, but still flippable on at runtime).
  // Seed the enricher's live-selectable model from PERCEPTION_ENRICH_MODEL.
  // Env UNSET ⇒ both trigger paths seed OFF (no window ever arms, zero Gemini
  // calls) — the documented "env unset → off at boot, still flippable from the
  // console". Set the env to re-enable at boot. (2026-07-14: unset — the voice-
  // fingerprint stage replaces the enricher; parakeet records are the durable
  // truth via dropSupersededSpeech's no-enricher fallback.)
  enricher_.model = process.env.PERCEPTION_ENRICH_MODEL
    || 'gemini-2.5-flash-lite';
  if (!process.env.PERCEPTION_ENRICH_MODEL) { enricher_.speech = false; enricher_.nonSpeech = false; }
  // CONTEXT-AWARE: assemble the recent-discussion context for a dock (rolling summary
  // + who's present) so Gemini disambiguates names/topic/homophones. Cheap (a few
  // hundred chars; audio dominates the cost).
  const bgContext = (dockId: string): string => {
    const parts: string[] = [];
    const sum = lastSummary.get(dockId)?.text;
    if (sum) parts.push(`Recent: ${sum.slice(0, 600)}`);
    const names = [...new Set(
      snapshots.list().filter((r) => r.dockId === dockId && r.source.kind === 'identity')
        .slice(-8)
        .flatMap((r) => ((r.payload.faces as Array<{ name?: string | null }> | undefined) ?? [])
          .map((f) => f.name).filter((n): n is string => !!n)),
    )];
    if (names.length) parts.push(`People present: ${names.join(', ')}.`);
    return parts.join('\n');
  };
  // ── AUDIO ENRICHER (the merged audio path) ── the debounced vad-endpoint batch window →
  // ONE context-aware call that lands the authoritative diarized transcript (+ per-segment
  // acoustic read: source/kind/salience/addressed). This REPLACES the old two enricher calls
  // (speech-details patch + per-impulse sound). Always on; parakeet is live-only.
  const enrich = (pcm: Int16Array, rate: number, dockId: string, context: import('./processors/audio-enricher.js').EnrichContext) =>
    enrichAudio(pcm, rate, enricher_.model, context, dockId); // model is live-selectable from the console
  const enrichCtx = (dockId: string): import('./processors/audio-enricher.js').EnrichContext => {
    const names = [...new Set(
      snapshots.list().filter((r) => r.dockId === dockId && r.source.kind === 'identity').slice(-8)
        .flatMap((r) => ((r.payload.faces as Array<{ name?: string | null }> | undefined) ?? [])
          .map((f) => f.name).filter((n): n is string => !!n)),
    )];
    return { recentTranscript: bgContext(dockId) || undefined, present: names };
  };
  const stt = speechWatchProcessor(
    snapshots,
    (e) => finalHandler?.(e),
    (dockId) => Date.now() < (speakingUntil.get(dockId) ?? 0),
    // LIVE INTERIMS → brain → directed caption frame to the dock. Gated on the
    // brain's listening-resolver (only during an active listening/followup turn);
    // if the brain never registers one, interims never fire (resolver stays undefined).
    (e) => interimHandler?.(e),
    (dockId) => listeningResolver?.(dockId) ?? false,
    enrich,
    enrichCtx,
    // the enricher's addressed in-room segments → the brain's wake fallback.
    // enricher-addressed → brain, SYNCHRONOUS (no batching between detect and send); pass the
    // enricher's ACTUAL address confidence + directive (was hardcoded 0.7/empty — wasted signal).
    (e) => bgAddressedHandler?.({ dockId: e.dockId, directive: e.directive, transcript: e.text, conf: e.conf }),
    registerEnrichPathSink, // live speech / non-speech trigger gates → each detector
    voiceId, // 🎙→👤 voice fingerprint on finals (observe-only)
    // SPEECH ONSET → brain (barge-in "polite pause"): someone started talking —
    // if the dock is mid-reply the brain holds its TTS until the final decides.
    (e) => speechStartHandler?.(e),
  ); // 🎙 speech (exposes flushAll)
  const bodymotion = bodyMotionWatchProcessor(snapshots); // 🤖 ego-motion (setMotion seam)
  // Vision reuses the face processor's decoded frame (ONE ffmpeg per dock, not two). The
  // camera-moving signal comes from the MotionExecutor (set by main via setCameraMoving) —
  // faceFollow's pans never reach the bodymotion stream, so bodymotion.current() is useless
  // here; the executor's lastMotionAt is the real "my head just moved" signal.
  const vision = visionSnapshotProcessor(snapshots, (sid) => face.currentFrame(sid),
    (dockId) => cameraMovingRef.current?.(dockId) ?? false); // 👁 vision + self-motion tag

  /** Publish a result directed to its dock + an undirected copy (state/console). */
  function fanResult(r: PerceptionResult): void {
    bus.publish({ topic: 'perception', kind: r.kind, payload: r, source: 'station', to: r.dockId });
    bus.publish({ topic: 'perception', kind: r.kind, payload: r, source: 'station' });
  }

  return {
    name: 'perception',
    topic: 'perception',
    description: 'stream-processing results + per-dock world-state (presence, identity, …)',

    init(b: Bus) {
      bus = b;
      state = new PerceptionState(bus);
      const hub = getHub();
      // Always-on processors. More land here as phases progress (audio, …).
      // ONE WebRTC perception pipeline. The browser publishes mic+cam to the SFU;
      // these processors tap that stream. Vision = qwen (scene+action, one model,
      // latency-bound windows); speech = whisper utterances. Both emit shared-format
      // snapshot records (IST from/to/duration + source) into the SnapshotStore.
      hub.register(presenceProcessor());
      hub.register(face);
      // THREE snapshot streams, same format, kept separate (LLM merge later):
      hub.register(stt);    // 🎙 speech (whisper)
      hub.register(vision); // 👁 vision (qwen, no identity)
      hub.register(bodymotion); // 🤖 ego-motion (robot proprioception; station feeds commands)
      hub.register(identitySnapshotProcessor(snapshots, // 👤 identity (face-api + boxes)
        (sid) => face.recognizeAllCurrent(sid),
        (sid) => bodymotion.current(sid))); // ego-aware: don't drop people mid-move

      // Summarize a dock's recent window and cache it as `lastSummary` (so grounding
      // goes live). Shared by force_get_current, the console, and the A1.5
      // auto-summarizer. `flush` (default true) force-ends the in-flight tail first.
      const summarizeWindowAndCache = async (
        dockId: string, opts?: { streamId?: string; windowMs?: number; flush?: boolean; cache?: boolean; captures?: number },
      ): Promise<{ summary: string; error?: string; window: { from: string; to: string } }> => {
        // Anchor the window START before the (possibly multi-second) captures, so the
        // window is GUARANTEED to span every fresh read regardless of inference time.
        const startedAt = Date.now();
        if (opts?.flush !== false) {
          try { await stt.flushAll(); } catch { /* best-effort */ }
          if (opts?.streamId) {
            // CONSENSUS: the small vision model is capable but INCONSISTENT frame-to-frame
            // (a held mug read correctly on one frame, as "smartphone"/"ruler" on the next).
            // For an on-demand "what do you see now?", take a few fresh captures so the
            // summary window holds several independent reads — the Gemini summarizer then
            // reconciles them (majority wins) instead of trusting one possibly-bad frame.
            const n = Math.max(1, opts?.captures ?? 1);
            for (let i = 0; i < n; i++) {
              try { await vision.captureNow(opts.streamId); } catch { /* best-effort */ }
            }
          }
        }
        const toIso = isoIst(new Date());
        // window = max(requested window, the span we just spent capturing) so all the
        // fresh consensus reads are included even if inference ran long.
        const windowMs = Math.max(opts?.windowMs ?? 60_000, Date.now() - startedAt + 1_000);
        const fromIso = isoIst(new Date(Date.now() - windowMs));
        // exclude prior SUMMARY records: a summary must digest the streams, not itself.
        const recs = dropSupersededSpeech(snapshots.inWindowWithState(fromIso, toIso)
          .filter((r) => r.dockId === dockId && r.source.kind !== 'summary'));
        // KEYFRAMES as the tie-breaker: the small VLM (qwen-3B) is inconsistent and, on a
        // sparse window, a single wrong sentence ("a person on a pull-up bar" for straps on a
        // hook) becomes the headline with nothing to check it. Send the actual keyframes so
        // Gemini SEES the scene and can override the VLM's text. Default-on for the background
        // path; PERCEPTION_SUMMARY_KEYFRAMES=0 disables. maxKeyframes bounds the image cost.
        const wantKf = process.env.PERCEPTION_SUMMARY_KEYFRAMES !== '0';
        const keyframes = wantKf
          ? snapshots.keyframesInWindow(fromIso, toIso, Number(process.env.PERCEPTION_SUMMARY_MAX_KEYFRAMES ?? 4))
          : undefined;
        const result = await summarize(recs, { windowFromIso: fromIso, keyframes });
        // Only update the BACKGROUND grounding (lastSummary) when this is a background-
        // scope summary. A tight "right now" read (force_get_current, ~6s window) must
        // NOT overwrite the 60s background sense — it's a momentary answer, not the
        // ongoing context — so it passes cache:false.
        if (result.summary && !result.error && opts?.cache !== false) {
          lastSummary.set(dockId, {
            dockId, text: result.summary,
            window: { from: fromIso, to: toIso }, computedAt: Date.now(),
          });
          persistLastSummaries();
          // The summary is also a RING RECORD (kind 'summary') — the coherence pulse.
          // Durable facts come from the trim pass (extractFactsFromSpan), not from these
          // pulses; the Studio shows them, and the summarize input above excludes them.
          snapshots.add(makeSnapshot({
            dockId,
            source: { id: 'rolling-summary', kind: 'summary', device: 'station', host: 'station' },
            model: { name: 'gemini-summarizer', endpoint: 'in-process' },
            from: new Date(fromIso), to: new Date(toIso),
            // LINEAGE: the EXACT stitched input the summarizer digested (truncated) +
            // the record count — the Studio shows it collapsible per pulse, so how each
            // coherence layer line was built is inspectable, not inferred.
            payload: { text: result.summary, inputCount: recs.length, inputs: stitch(recs, fromIso).slice(0, 4_000) },
          }));
        }
        return { summary: result.summary, error: result.error, window: { from: fromIso, to: toIso } };
      };

      // Perception grounding facade for the brain (3.1): synchronously build the
      // per-turn context block for a dock — last summary (with staleness) + the raw
      // stream since it, from this dock's records. No network; the brain injects it.
      groundingRef.current = {
        forDock(dockId: string, opts?: { coherent?: boolean }): string | undefined {
          const now = Date.now();
          // this dock's recent records (the store mixes docks; records are tagged).
          const recent = dropSupersededSpeech(snapshots.list().filter((r) => r.dockId === dockId && r.source.kind !== 'summary'));
          const block = buildGrounding({
            last: lastSummary.get(dockId) ?? null,
            recent,
            now,
            nowIso: isoIst(new Date(now)),
            coherent: opts?.coherent === true,
          });
          // PASSIVE long-term memory: append a small, confidence-ranked slice of durable
          // beliefs about WHO IS PRESENT (so the agent knows what it knows without calling
          // recall_memory). Best-effort + synchronous: read recent active beliefs for this
          // dock and let the pure slice filter/rank/cap. Present-subject relevance is a
          // light filter — if we can name who's here, prefer their beliefs.
          let memBlock = '';
          try {
            const present = presentNamesFromRecent(recent);   // names in the latest identity record
            const rows = memory.recent(dockId, 40);            // active beliefs, recent-first
            const cand = rows
              // prefer beliefs about a present person; if we know nobody's here, keep all
              // (high-confidence general facts still worth surfacing).
              .filter((m) => present.length === 0 || !m.subject || present.includes(m.subject))
              .map((m) => ({ subject: m.subject, claim: m.claim, confidence: m.confidence }));
            memBlock = memoryGroundingSlice(cand);
          } catch { /* grounding must never fail on the memory read */ }

          const out = [block, memBlock].filter(Boolean).join('\n\n');
          return out || undefined;
        },
        async forceCurrent(dockId, streamId, windowMs) {
          // Flush the in-flight tail (so "right now" is captured), then summarize a TIGHT
          // window around it. captures:FORCE_GET_CAPTURES — take several fresh reads so the
          // summarizer reconciles the inconsistent small-model object-ID (majority wins).
          // cache:false — this momentary read must not overwrite the 60s background sense
          // (lastSummary). force_get_current is the deliberate, on-demand path; the A1.5
          // auto-summarizer caches via the same helper (single capture).
          return summarizeWindowAndCache(dockId, {
            streamId, windowMs, flush: true, cache: false, captures: FORCE_GET_CAPTURES,
          });
        },
      };

      salientPulseRef.current = (dockId: string) => {
        let latest: string | null = null;
        for (const r of snapshots.list()) {
          if (r.dockId !== dockId || r.source.kind === 'summary' || !isSalient(r)) continue;
          if (r.source.kind === 'bodymotion') continue; // the robot's own motion is not a world event
          if (!latest || r.interval.to > latest) latest = r.interval.to;
        }
        return latest ? new Date(latest).getTime() : null;
      };

      // FEEDBACK PAIRS: remark → wait one minute → pair with the salient reaction.
      const REACTION_WINDOW_MS = 60_000;
      selfRemarkRef.current = (dockId: string, text: string) => {
        const saidAtIso = isoIst(new Date());
        const t = setTimeout(() => {
          try {
            const reactions = snapshots.list()
              .filter((r) => r.dockId === dockId && r.interval.from > saidAtIso && r.source.kind !== 'summary')
              .filter(isSalient)
              .slice(-4)
              .map((r) => `${r.source.kind}: ${(r.payload.text ?? '').toString().trim()}`)
              .filter((l) => l.length > 8);
            const reaction = reactions.length ? reactions.join(' · ') : 'no visible reaction';
            snapshots.add(makeSnapshot({
              dockId,
              source: { id: 'feedback-pair', kind: 'summary', device: 'station', host: 'station' },
              model: { name: 'feedback-loop', endpoint: 'in-process' },
              from: new Date(Date.now() - REACTION_WINDOW_MS), to: new Date(),
              payload: { text: `orbit remarked unprompted: "${text}". Reaction in the following minute: ${reaction}.` },
            }));
            console.log(`[coherence] feedback pair recorded for ${dockId} (${reactions.length} reaction records)`);
          } catch (err) { console.warn(`[coherence] feedback pair failed: ${String(err)}`); }
        }, REACTION_WINDOW_MS);
        t.unref?.();
      };

      // MEMORY facade (Decision 4) — the brain's discover/recall/inspect/mutate
      // surface over the unified store. The brain never imports MemoryStore directly.
      memoryStoreRef.current = memory;
      memoryRef.current = {
        recall: (f) => memory.recall(f),
        inspect: (id) => {
          const m = memory.get(id);
          return m ? { memory: m, lineage: memory.lineage(id) } : undefined;
        },
        remember: (m) => memory.remember({ ...m, derivation: 'observed' }),
        update: (id, patch) => memory.revise(id, patch),
        forget: (id) => memory.forget(id),
        subjects: (dockId) => memory.subjects(dockId),
        recent: (dockId, limit) => memory.recent(dockId, limit),
        count: (dockId) => memory.count(dockId),
      };

      // PROACTIVE ATTENTION GATE (Phase 5) — watches the snapshot stream and raises a
      // self-thought when something is worth the robot's attention (arrival / strong
      // emotion / [relevance, stubbed]). OFF by default — proactivity is opt-in. The
      // brain registers onRaise → enqueueAutonomousTurn; the console toggles + reads
      // recent decisions.
      const gateCfg: GateConfig = { ...DEFAULT_GATE_CONFIG };
      let raiseHandler: ((t: RaisedThought) => void) | undefined;
      const decisions: Array<{ ts: number; dockId: string; raised: boolean; detail: string }> = [];
      const noteDecision = (dockId: string, o: GateOutcome) => {
        // log only RAISES and the gate being enabled-but-quiet for an interesting
        // reason (skip the constant "gate disabled" noise).
        if (!o.raise && (o.reason === 'gate disabled' || o.reason === 'nothing worth raising')) return;
        decisions.push({ ts: Date.now(), dockId, raised: o.raise, detail: o.raise ? `${o.kind}: ${o.text}` : o.reason });
        if (decisions.length > 50) decisions.splice(0, decisions.length - 50);
      };
      startGateWatcher(snapshots, () => gateCfg, (t) => raiseHandler?.(t), noteDecision);

      // Durable perception retention + SELF-COMPRESSION (§7c). The ONE summarizer pass, at trim,
      // per closed clock-hour, produces TWO outputs (apart from each other, one checkpoint):
      //   ① trimSpanDigest    → a durable span-summary (COMPRESSES the timeline; replaces aged raw)
      //   ② extractFactsFromSpan → durable FACTS into the memory store (append + light dedup)
      // `summarizeSpan` failing keeps the raw for a retry (no hole); fact-extraction is best-effort
      // (the digest is the contract). This replaces the old separate background curator job — one
      // pipeline, one checkpoint. Interval env-tunable (accelerate for tests).
      const trimTimer = setInterval(() => {
        selfCompressAndTrim(
          Date.now(),
          (records) => trimSpanDigest(records),
          (records) => extractFactsFromSpan(records, memory).then(() => {}),
        )
          .then((touched) => { if (touched.length) console.log(`[perception] retention self-compress+trim: ${touched.join(',')}`); })
          .catch((err) => console.error('[perception] retention trim failed', err));
      }, Number(process.env.PERCEPTION_TRIM_INTERVAL_MS ?? 30 * 60_000));
      (trimTimer as { unref?: () => void }).unref?.();

      // A1.5 auto-summarizer: keep grounding's lastSummary fresh without a manual
      // /summarize. Per active dock (those with recent records), on a debounced
      // cadence, fuse the recent window + cache it. Cheap: skips idle docks +
      // throttles busy ones (shouldSummarize). OFF if PERCEPTION_AUTO_SUMMARY=0.
      if (process.env.PERCEPTION_AUTO_SUMMARY !== '0') {
        // Count records per dock from one store scan, memoized for a beat so the
        // auto-summarizer's activeDocks()+countFor(d)×N calls in a single tick
        // share ONE pass over snapshots (instead of rescanning per dock).
        let countCache: { at: number; map: Map<string, number> } | null = null;
        const dockCounts = (): Map<string, number> => {
          const now = Date.now();
          if (countCache && now - countCache.at < 1_000) return countCache.map;
          const m = new Map<string, number>();
          for (const r of snapshots.list()) {
            if (r.source.kind === 'summary') continue; // the pulse must not feed its own trigger
            if ((r.payload as { gap?: boolean }).gap) continue; // frame-accounting gaps aren't new CONTENT — don't trigger a summary of "nothing happened"
            m.set(r.dockId, (m.get(r.dockId) ?? 0) + 1);
          }
          countCache = { at: now, map: m };
          return m;
        };
        startAutoSummarizer({
          store: snapshots,
          activeDocks: () => [...dockCounts().keys()],
          countFor: (d) => dockCounts().get(d) ?? 0,
          summarizeAndCache: async (d) => { await summarizeWindowAndCache(d, { flush: true }); },
          log: (m) => console.log(m),
        });
      }

      // DURABLE FACTS are extracted inline by the summarizer's trim pass
      // (extractFactsFromSpan, wired above) — the retired background curator's job. No
      // separate consolidate/reconcile loop: the same span the digest summarizes yields
      // durable beliefs into the MemoryStore (append + light dedup), one checkpoint.
      gateRef.current = {
        setEnabled: (on) => { gateCfg.enabled = on; },
        isEnabled: () => gateCfg.enabled,
        onRaise: (fn) => { raiseHandler = fn; },
        recentDecisions: (limit = 20) => decisions.slice(-limit).reverse(),
      };

      // In-process face API for the server brain (docs/decision-traces/server-brain-impl.md §3.1):
      // the same operations the WS request/result flow below serves, exposed as
      // function calls so the brain's tools skip the round-trip.
      faceToolsRef.current = {
        async enroll({ name, photo, streamId }) {
          const n = name.trim();
          if (!n) return { ok: false, reason: 'no name' };
          if (photo) {
            const d = await describeBase64(photo);
            if (!d) return { ok: false, reason: 'no face detected' };
            gallery.enroll(n, d, photo, gallery.has(n)); // append for a known name
            return { ok: true };
          }
          if (streamId) return face.enrollCurrent(streamId, n);
          return { ok: false, reason: 'no photo or stream' };
        },
        async recognize({ photo, streamId }) {
          let faces: DetectedFace[] = [];
          if (photo) {
            faces = await describeAllBase64(photo);
          } else if (streamId) {
            // FLICKER TOLERANCE: a single live frame is unreliable — face-api misses a
            // face on a blurred / dropped / mid-blink frame, which made recollect_face
            // hard-return "No one is in front of you" even though the DEBOUNCED identity
            // stream (CONFIRM/DROP hysteresis) confidently showed the person present —
            // the "I see you, but I don't see you" greeting. Sample up to a few of the
            // grabber's latest frames a beat apart and take the first that has a face,
            // so one bad frame no longer reads as "no one". (grabber.latest() refreshes
            // continuously from the SFU, so successive reads are genuinely new frames.)
            for (let attempt = 0; attempt < RECOGNIZE_FRAME_TRIES; attempt++) {
              const buf = face.currentFrame(streamId);
              if (buf) { try { faces = await describeAllFaces(buf); } catch { faces = []; } }
              if (faces.length > 0) break;
              if (attempt < RECOGNIZE_FRAME_TRIES - 1) await new Promise((r) => setTimeout(r, RECOGNIZE_FRAME_GAP_MS));
            }
          }
          const people = faces.map((f) => {
            const m = gallery.match(f.descriptor, TENTATIVE_THRESHOLD);
            const verdict = m ? classifyDistance(m.distance) : 'none';
            return {
              name: verdict === 'confident' ? m!.name : null,
              tentative: verdict === 'tentative' ? m!.name : null,
              confidence: m ? Math.max(0, 1 - m.distance) : 0,
              side: sideOf(f.cx),
              box: f.box,
            };
          });
          const confident = people.filter((x) => x.name).sort((a, b) => b.confidence - a.confidence);
          const tentatives = people.filter((x) => !x.name && x.tentative).sort((a, b) => b.confidence - a.confidence);
          const primary = confident[0] ?? tentatives[0];
          return {
            name: confident[0]?.name ?? null,
            tentative: confident[0] ? null : (tentatives[0]?.tentative ?? null),
            confidence: primary?.confidence ?? 0,
            noFace: faces.length === 0,
            people,
          };
        },
        async confirm({ name, photo, streamId }) {
          const n = name.trim();
          if (!n) return { ok: false };
          if (photo) {
            const d = await describeBase64(photo);
            if (d) { gallery.enroll(n, d, photo, true); return { ok: true }; }
            return { ok: false };
          }
          if (streamId) {
            const r = await face.enrollCurrent(streamId, n);
            return { ok: r.ok };
          }
          return { ok: false };
        },
        frame(streamId) {
          return face.currentFrame(streamId)?.toString('base64');
        },
        async forget({ name, streamId }) {
          const n = name.trim();
          if (!n) return { ok: false };
          if (streamId) { void face.forgetCurrent(streamId, n); return { ok: true }; }
          return { ok: gallery.remove(n) };
        },
        knowsPerson(name) { return !!name?.trim() && gallery.has(name.trim()); },
        knownNames() { return gallery.names(); },
      };

      // Agent-driven enrollment over the WS: the dock's `remember_face` tool
      // publishes `perception`/`enroll-request {name}`; we enroll the face it's
      // currently streaming (streamId = the app's peer id = msg.source) and reply
      // `enroll-result` directed back to that dock.
      bus.on('perception', (msg) => {
        if (msg.source === 'station') return;
        const p = msg.payload as { name?: string; reqId?: string; photo?: string } | null;
        // The dock sends `photo` = its CLEAN on-device camera JPEG (base64). We
        // recognize/enroll from THAT directly — no dependency on the live WebRTC
        // stream (which decodes lossily and drops). This is the on-demand path.
        if (msg.kind === 'enroll-request') {
          const name = p?.name?.trim();
          if (!name || !p?.photo) {
            bus.publish({ topic: 'perception', kind: 'enroll-result', payload: { ok: false, reason: name ? 'no photo' : 'no name' }, source: 'station', to: msg.source });
            return;
          }
          void describeBase64(p.photo).then((d) => {
            const ok = !!d;
            // APPEND for a known name (another angle → recognition improves).
            // Replacing on every "my name is X" wiped a person's whole sample
            // set down to one possibly-bad frame — recognition got WORSE each
            // time someone re-introduced themselves. Full replacement is a
            // deliberate console action (REST /gallery), not a voice flow.
            if (d) gallery.enroll(name, d, p.photo, gallery.has(name));
            bus.publish({ topic: 'perception', kind: 'enroll-result', payload: { name, ok, reason: ok ? undefined : 'no face detected' }, source: 'station', to: msg.source });
          });
        } else if (msg.kind === 'recognize-request') {
          const reqId = p?.reqId;
          void describeAllBase64(p?.photo ?? '').then((faces) => {
            // Classify EVERY face: confident name, tentative name, or unknown —
            // each tagged with its side (left/center/right) so the dock can say
            // "Guru on the left, someone I don't know on the right". The
            // confident/tentative split is [classifyDistance] — ONE definition;
            // the raw confidence rides along for display only (the dock must
            // act on the categorical fields, never re-threshold the float).
            const people = faces.map((f) => {
              const m = gallery.match(f.descriptor, TENTATIVE_THRESHOLD);
              const verdict = m ? classifyDistance(m.distance) : 'none';
              return {
                name: verdict === 'confident' ? m!.name : null,
                tentative: verdict === 'tentative' ? m!.name : null,
                confidence: m ? Math.max(0, 1 - m.distance) : 0,
                side: sideOf(f.cx),
              };
            });
            // Back-compat single fields (the dock caches one identity): pick the
            // best confident match, else the best tentative.
            const confident = people.filter((x) => x.name).sort((a, b) => b.confidence - a.confidence);
            const tentatives = people.filter((x) => !x.name && x.tentative).sort((a, b) => b.confidence - a.confidence);
            const primary = confident[0] ?? tentatives[0];
            const out = {
              name: confident[0]?.name ?? null,
              tentative: confident[0] ? null : (tentatives[0]?.tentative ?? null),
              confidence: primary?.confidence ?? 0,
              noFace: faces.length === 0,
              people, // the full per-face list (multi-person)
            };
            bus.publish({ topic: 'perception', kind: 'recognize-result', payload: { reqId, ...out }, source: 'station', to: msg.source });
          });
        } else if (msg.kind === 'confirm-request') {
          // confirm_face: user said "yes I'm X" → append this capture (descriptor
          // + its photo) as another angle, so it's visible/deletable in the console.
          const name = p?.name?.trim();
          if (name && p?.photo) void describeBase64(p.photo).then((d) => { if (d) gallery.enroll(name, d, p.photo, true); });
        } else if (msg.kind === 'forget-request') {
          // forget_face: "that's not me" → drop the wrong association.
          const name = (msg.payload as { name?: string } | null)?.name?.trim();
          if (name) void face.forgetCurrent(msg.source, name);
        }
      });

      // The `perceive` stream (docs/decision-traces/facefollow-and-actuator-lease.md §7):
      // the phone forwards its on-device MLKit face perception (~1 Hz, deduped on the
      // phone) as topic `perceive`, kind `frame`. We resolve the originating peer to its
      // dock (same peer→dock mapping snapshots use) and stash it as the dock's LIVE
      // latest face-track — NOT the heavy snapshot ring (this is high-rate geometry the
      // faceFollow loop reads, history nobody needs).
      bus.on('perceive', (msg) => {
        if (msg.source === 'station') return;
        // DEBUG telemetry (perceive/telemetry): the phone's 1 Hz detection-health report.
        // Log it so a stream STALL is diagnosable without adb — see which stage stops:
        //   framesIn=0        → CAMERA stalled (no frames to the analyzer)
        //   framesIn>0, passes=0 → the analysis GATE is stuck (interval/throttle bug)
        //   passes>0, hits=0  → the DETECTOR is blind (you're there but MLKit misses you)
        //   lastFaceMsAgo climbing → going blind; intervalMs = current adaptive cadence
        if (msg.kind === 'telemetry') {
          const t = msg.payload as { framesIn?: number; facePasses?: number; faceHits?: number; lastFaceMsAgo?: number; intervalMs?: number } | null;
          if (t) {
            const dockId = getHub().resolveDock(msg.source);
            console.log(`[perceive-tel] ${dockId} framesIn=${t.framesIn} passes=${t.facePasses} hits=${t.faceHits} lastFace=${t.lastFaceMsAgo}ms interval=${t.intervalMs}ms`);
          }
          return;
        }
        if (msg.kind !== 'frame') return;
        const payload = msg.payload as PerceivePayload | null;
        if (!payload || !Array.isArray(payload.faces)) return;
        const dockId = getHub().resolveDock(msg.source);
        perceive.update(dockId, payload);
        // TODO(perceive→ring): optionally fold payload.emotion / payload.identity into
        // the SnapshotStore (the ring already models those kinds) so they join the
        // recall record. Deferred: the on-device emotion/identity here would need the
        // same CONFIRM/DROP hysteresis the identity stream applies (else ~1 Hz raw
        // would spam the ring + skew the summarizer), which is more than a few lines —
        // out of scope for landing the live face-track. Face GEOMETRY never goes in the ring.
      });

      // Generic reconnect snapshot: when a dock (re)joins, push it its current
      // world-state so the agent re-grounds immediately (identity is one field).
      bus.on('station', (msg) => {
        if (msg.kind !== 'peer-joined') return;
        const p = msg.payload as { caps?: string[]; id?: string; dock?: string } | null;
        // re-ground whichever component renders identity/face state (the phone
        // declares the 'face' cap) — routing by capability, not role.
        if (!p?.dock || !(p.caps ?? []).includes('face')) return;
        const ws = state.get(p.dock);
        if (ws) bus.publish({ topic: 'perception', kind: 'snapshot', payload: ws, source: 'station', to: p.id });
      });
    },

    async route(ctx: RouteContext) {
      const { req, res, subPath } = ctx;

      if (req.method === 'GET' && subPath === '/') {
        json(res, 200, state.all());
        return true;
      }
      // ── HISTORY (offline review) — the persisted perception on disk (§7c), so the console
      // can show a dock that ISN'T live-streaming right now. Keyed by STABLE dock name, so an
      // offline dock (and one reconnecting with a new peerId) is the same history.
      // GET /docks → [{ dock, from, to, lastSeen, hasSummaries, days }] — every dock with
      //   on-disk history. The console UNIONS this with /media/status producers (live ∪ history)
      //   to build its source selector; `live` is computed client-side against that producer list.
      if (req.method === 'GET' && subPath === '/docks') {
        json(res, 200, listDockHistory());
        return true;
      }
      // GET /history?dock=X[&from=ISO&to=ISO] → the persisted timeline for a pinned window,
      //   in the SAME SnapshotRecord shape as /snapshots (so the console timeline renders it
      //   unchanged; span-summaries ride in as kind:'summary' rows = the older, lossy fidelity).
      //   Defaults to the full retained span for the dock when from/to are omitted.
      if (req.method === 'GET' && subPath === '/history') {
        const u = new URL(req.url ?? '', 'http://x');
        const dock = u.searchParams.get('dock') ?? '';
        if (!dock) { json(res, 400, { error: 'dock query param required' }); return true; }
        const hist = dockHistory(dock);
        const fromIso = u.searchParams.get('from') || hist?.from || isoIst(new Date(Date.now() - 6 * 3600_000));
        const toIso = u.searchParams.get('to') || hist?.to || isoIst(new Date());
        // raw records + the compressed older tail, merged and sorted (the timeline expects one feed).
        const recs = [
          ...recordsInWindow(dock, fromIso, toIso),
          ...spanSummariesInWindow(dock, fromIso, toIso),
        ].sort((a, b) => (a.interval.from < b.interval.from ? -1 : a.interval.from > b.interval.from ? 1 : 0));
        json(res, 200, { dock, window: { from: fromIso, to: toIso }, records: recs });
        return true;
      }
      // The dock's LATEST on-device face-track (the `perceive` stream, §7) — live state
      // for the console + debugging. GET /api/perception/:dockId/perceive → { ts, payload }
      // or { error } when nothing's arrived. Must precede the bare /:dockId catch-all.
      const pm = subPath.match(/^\/([^/]+)\/perceive$/);
      if (pm && req.method === 'GET') {
        const dockId = decodeURIComponent(pm[1]!);
        const entry = perceive.latest(dockId);
        json(res, 200, entry ?? { error: 'no perceive frame', dockId });
        return true;
      }
      // ── SIDECAR HEALTH — the two MLX apps are the only out-of-process pieces
      // (operations/perception-runbook.md §1). Ping each /health (short timeout) so the console
      // can show up/down + which model is loaded, without anyone sshing in.
      // GET /sidecars → [{ name, url, up, model?, latencyMs?, error? }, …]
      if (req.method === 'GET' && subPath === '/sidecars') {
        json(res, 200, await pingSidecars());
        return true;
      }
      // Start/stop/restart a sidecar from the console (single-laptop dev convenience).
      // POST /sidecars/:name/{start|stop|restart} → { ok, … } (liveness via the GET above)
      const scm = subPath.match(/^\/sidecars\/(vision|speech)\/(start|stop|restart)$/);
      if (scm && req.method === 'POST') {
        const name = scm[1] as 'vision' | 'speech';
        const op = scm[2] as 'start' | 'stop' | 'restart';
        // start/restart refuse to double-bind: if the port already serves, treat as up.
        if (op !== 'stop') {
          const live = (await pingSidecars()).find((s) => s.name === name);
          if (op === 'start' && live?.up) { json(res, 200, { ok: true, alreadyUp: true }); return true; }
        }
        const r = op === 'start' ? await sidecars.start(name)
          : op === 'stop' ? await sidecars.stop(name)
          : await sidecars.restart(name);
        json(res, r.ok ? 200 : 500, r);
        return true;
      }
      // ── ATTENTION GATE (Phase 5) — the console's proactivity control (5c). ──
      // GET /gate → { enabled, recent: [...] }
      if (req.method === 'GET' && subPath === '/gate') {
        json(res, 200, { enabled: gateRef.current?.isEnabled() ?? false, recent: gateRef.current?.recentDecisions(20) ?? [] });
        return true;
      }
      // POST /gate {enabled} → toggle proactivity
      if (req.method === 'POST' && subPath === '/gate') {
        const b = await parseBody<{ enabled?: boolean }>(req);
        gateRef.current?.setEnabled(b.enabled === true);
        json(res, 200, { ok: true, enabled: gateRef.current?.isEnabled() ?? false });
        return true;
      }

      // ── MEMORY (Decision 4) — the console's memory inspector (4c). dock-scoped. ──
      // GET /memory?dock=X[&query=&subject=&type=&inactive=1] → recall/list
      if (req.method === 'GET' && subPath === '/memory') {
        const u = new URL(req.url ?? '', 'http://x');
        const dock = u.searchParams.get('dock') ?? '';
        if (!dock) { json(res, 400, { error: 'dock query param required' }); return true; }
        const rows = await memory.recall({
          dockId: dock,
          query: u.searchParams.get('query') || undefined,
          subject: u.searchParams.get('subject') || undefined,
          type: (u.searchParams.get('type') as MemoryType) || undefined,
          includeInactive: u.searchParams.get('inactive') === '1',
          limit: Number(u.searchParams.get('limit') ?? 50),
        });
        json(res, 200, { count: memory.count(dock), subjects: memory.subjects(dock), memories: rows });
        return true;
      }
      // GET /memory/item/:id → one memory + its lineage (the "why" view)
      let mm = subPath.match(/^\/memory\/item\/([^/]+)$/);
      if (mm && req.method === 'GET') {
        const id = decodeURIComponent(mm[1]!);
        const m = memory.get(id);
        if (!m) { json(res, 404, { error: 'no such memory' }); return true; }
        json(res, 200, { memory: m, lineage: memory.lineage(id) });
        return true;
      }
      // POST /memory {dock, type, subject?, claim, confidence?} → remember (console add)
      if (req.method === 'POST' && subPath === '/memory') {
        const b = await parseBody<{ dock?: string; type?: MemoryType; subject?: string; claim?: string; confidence?: number }>(req);
        if (!b.dock || !b.claim?.trim()) { json(res, 400, { error: 'dock + claim required' }); return true; }
        const id = await memory.remember({ dockId: b.dock, type: b.type || 'fact', subject: b.subject, claim: b.claim.trim(), confidence: b.confidence });
        json(res, 200, { ok: true, id });
        return true;
      }
      // PATCH /memory/item/:id {claim?, confidence?, subject?} → revise (supersede)
      mm = subPath.match(/^\/memory\/item\/([^/]+)$/);
      if (mm && req.method === 'PATCH') {
        const id = decodeURIComponent(mm[1]!);
        const b = await parseBody<{ claim?: string; confidence?: number; subject?: string }>(req);
        const newId = await memory.revise(id, b);
        json(res, newId ? 200 : 404, { ok: !!newId, id: newId });
        return true;
      }
      // DELETE /memory/item/:id → forget (purge from active recall)
      mm = subPath.match(/^\/memory\/item\/([^/]+)$/);
      if (mm && req.method === 'DELETE') {
        const ok = memory.forget(decodeURIComponent(mm[1]!));
        json(res, ok ? 200 : 404, { ok });
        return true;
      }

      // Snapshot records (WebRTC vision + speech), shared format, ordered by start.
      // GET /snapshots[?limit=N]; POST /snapshots/clear wipes the ring.
      if (req.method === 'GET' && subPath === '/snapshots') {
        const q = new URL(req.url ?? '', 'http://x').searchParams;
        const limit = Number(q.get('limit') ?? 300);
        // ?dock=X scopes to one dock/stream's snapshots (the console source selector);
        // omitted/all = the merged feed across every producer.
        const dock = q.get('dock');
        const all = snapshots.list(limit);
        json(res, 200, dock && dock !== 'all' ? all.filter((r) => r.dockId === dock) : all);
        return true;
      }
      if (req.method === 'POST' && subPath === '/snapshots/clear') {
        snapshots.clear();
        json(res, 200, { ok: true });
        return true;
      }
      // Flush in-flight perception so a Summarize right after captures the NOW:
      // force-commit any open utterance + take a fresh one-shot vision analysis,
      // awaiting both so they're in the store before the (separate) summarize call.
      // POST /snapshots/flush {streamId?} → {ok, vision:bool}
      if (req.method === 'POST' && subPath === '/snapshots/flush') {
        const body = await parseBody<{ streamId?: string }>(req);
        await stt.flushAll(); // every audio stream's open utterance
        let visionCommitted = false;
        if (body.streamId) visionCommitted = await vision.captureNow(body.streamId);
        json(res, 200, { ok: true, vision: visionCommitted });
        return true;
      }
      // Inject a robot MOTION COMMAND (the station's contract; or a mock for testing).
      // POST /bodymotion {streamId, mode, direction?, durationMs, amount?, label?}
      // → records a 'camera moving' snapshot + marks the camera unsettled for
      //   durationMs + settle tail (so identity won't drop people mid-move).
      if (req.method === 'POST' && subPath === '/bodymotion') {
        const body = await parseBody<{ streamId?: string } & MotionCommand>(req);
        if (!body.streamId || !body.mode || body.durationMs == null) {
          json(res, 400, { error: 'bodymotion needs streamId, mode, durationMs' });
          return true;
        }
        const ok = bodymotion.pushCommand(body.streamId, {
          mode: body.mode, direction: body.direction, durationMs: body.durationMs,
          amount: body.amount, label: body.label, at: body.at,
        });
        json(res, ok ? 200 : 404, { ok, reason: ok ? undefined : 'stream not found' });
        return true;
      }
      // Summarize the last `windowMs` of snapshots via Gemini. Optional keyframes.
      // POST /snapshots/summarize {windowMs, withKeyframes?, maxKeyframes?}
      // → {summary, model, counts, prompt:{system,transcript}, withKeyframes, error?}
      if (req.method === 'POST' && subPath === '/snapshots/summarize') {
        const body = await parseBody<
          { windowMs?: number; fromIso?: string; toIso?: string;
            withKeyframes?: boolean; maxKeyframes?: number; model?: string; dock?: string }>(req);
        // Prefer EXPLICIT bounds (the client pins the window at click time so the
        // log and the LLM input agree exactly). Fall back to windowMs = [now-w, now]
        // for older callers. inWindowWithState = overlap + carried-in state streams.
        const toIso = body.toIso ?? isoIst(new Date());
        const fromIso = body.fromIso ?? isoIst(new Date(Date.now() - (body.windowMs ?? 60_000)));
        // inWindowWithState carries forward the last identity/bodymotion BEFORE the
        // window, so the summary knows the camera/presence state it ENTERED with
        // (a pan or a person that last changed before the window isn't lost).
        // ?dock scopes the summary to one source (the console selector); else all.
        // Exclude prior SUMMARY records: a summary must digest the raw streams, not itself
        // (the comment below promised this; the filter was missing → summaries fed on their
        // own past output, drifting). Matches the auto/background path.
        let recs = snapshots.inWindowWithState(fromIso, toIso)
          .filter((r) => r.source.kind !== 'summary')
          .filter((r) => !body.dock || body.dock === 'all' || r.dockId === body.dock);
        // OFFLINE HISTORY: when this window is scoped to one dock and the ring has nothing for it
        // (an offline dock, or a window older than the ~1000-record ring), fall back to the durable
        // on-disk records so "Summarize" works over persisted history, not just the live tail (§7c).
        // Ring-first keeps the live path exact (carried-in state streams); disk is the fallback only.
        if (!recs.length && body.dock && body.dock !== 'all') {
          recs = recordsInWindow(body.dock, fromIso, toIso).filter((r) => r.source.kind !== 'summary');
        }
        const keyframes = body.withKeyframes
          ? snapshots.keyframesInWindow(fromIso, toIso, body.maxKeyframes ?? 6) : undefined;
        const result = await summarize(recs, { keyframes, model: body.model, windowFromIso: fromIso });
        // Cache it as the head of grounding (3.1) for whichever dock this window is
        // about — the dominant dockId in the summarized records. A real (non-empty,
        // non-error) summary only; an error/empty leaves the prior summary in place.
        const dockId = dominantDock(recs);
        if (dockId && result.summary && !result.error) {
          lastSummary.set(dockId, {
            dockId, text: result.summary,
            window: { from: fromIso, to: toIso }, computedAt: Date.now(),
          });
          persistLastSummaries();
          // The summary is also a RING RECORD (kind 'summary') — the coherence pulse.
          // Durable facts come from the trim pass (extractFactsFromSpan), not from these
          // pulses; the Studio shows them, and the summarize input above excludes them.
          snapshots.add(makeSnapshot({
            dockId,
            source: { id: 'rolling-summary', kind: 'summary', device: 'station', host: 'station' },
            model: { name: 'gemini-summarizer', endpoint: 'in-process' },
            from: new Date(fromIso), to: new Date(toIso),
            // LINEAGE: the EXACT stitched input the summarizer digested (truncated) +
            // the record count — the Studio shows it collapsible per pulse, so how each
            // coherence layer line was built is inspectable, not inferred.
            payload: { text: result.summary, inputCount: recs.length, inputs: stitch(recs, fromIso).slice(0, 4_000) },
          }));
        }
        // Echo the exact window used so the console can pin its log to it.
        json(res, 200, { ...result, window: { from: fromIso, to: toIso } });
        return true;
      }
      // --- TAKES: freeze a window to disk for apples-to-apples A/B replay ------
      // Save the current window (or all) as a named, immutable take.
      // POST /takes/save {name, windowMs?}  (omit windowMs → save everything)
      if (req.method === 'POST' && subPath === '/takes/save') {
        const body = await parseBody<{ name?: string; windowMs?: number }>(req);
        const name = body.name?.trim();
        if (!name) { json(res, 400, { error: 'take needs a name' }); return true; }
        const recs = body.windowMs
          ? snapshots.since(isoIst(new Date(Date.now() - body.windowMs)))
          : snapshots.list();
        const kf = body.windowMs
          ? snapshots.keyframesAllSince(isoIst(new Date(Date.now() - body.windowMs)))
          : snapshots.keyframesAllSince('');
        if (recs.length === 0) { json(res, 400, { error: 'nothing to save in this window' }); return true; }
        json(res, 200, takes.save(name, recs, kf));
        return true;
      }
      // List saved takes (metadata only).  GET /takes
      if (req.method === 'GET' && subPath === '/takes') {
        json(res, 200, takes.list());
        return true;
      }
      // Summarize a SAVED take — same fixed input, varied prompt/model/keyframes.
      // POST /takes/summarize {name, withKeyframes?, maxKeyframes?, model?}
      if (req.method === 'POST' && subPath === '/takes/summarize') {
        const body = await parseBody<
          { name?: string; withKeyframes?: boolean; maxKeyframes?: number; model?: string }>(req);
        const take = body.name ? takes.load(body.name) : null;
        if (!take) { json(res, 404, { error: 'no such take' }); return true; }
        const keyframes = body.withKeyframes
          ? sampleEvenly(take.keyframes, body.maxKeyframes ?? 6) : undefined;
        json(res, 200, { ...await summarize(take.records, { keyframes, model: body.model }),
          take: take.name, window: take.range });
        return true;
      }
      // Load a take's records into the view (so the log shows the frozen data).
      // GET /takes/load?name=…
      if (req.method === 'GET' && subPath === '/takes/load') {
        const name = new URL(req.url ?? '', 'http://x').searchParams.get('name') ?? '';
        const take = takes.load(name);
        if (!take) { json(res, 404, { error: 'no such take' }); return true; }
        json(res, 200, { name: take.name, range: take.range, counts: take.counts, records: take.records });
        return true;
      }
      if (req.method === 'POST' && subPath === '/takes/delete') {
        const body = await parseBody<{ name?: string }>(req);
        json(res, 200, { deleted: body.name ? takes.delete(body.name) : false });
        return true;
      }
      // Steer the vision instruction. GET → {base, extra}; POST {extra} sets it.
      if (req.method === 'GET' && subPath === '/instruction') {
        json(res, 200, { base: visionBase(), extra: getVisionExtra() });
        return true;
      }
      if (req.method === 'POST' && subPath === '/instruction') {
        const body = await parseBody<{ extra?: string }>(req);
        setVisionExtra(body.extra ?? '');
        json(res, 200, { base: visionBase(), extra: getVisionExtra() });
        return true;
      }
      // AUDIO ENRICHER state. GET → {enabled, model, speech, nonSpeech}; POST {model?, speech?,
      // nonSpeech?} picks the live Gemini model + which trigger paths are live (no restart). The
      // enricher is always ON now, so `enabled` is retained for API back-compat only. The route is
      // '/api/perception/enricher' (no legacy aliases).
      if (req.method === 'GET' && subPath === '/enricher') {
        json(res, 200, getEnricherState());
        return true;
      }
      if (req.method === 'POST' && subPath === '/enricher') {
        const body = await parseBody<{ enabled?: boolean; model?: string; speech?: boolean; nonSpeech?: boolean }>(req);
        if (typeof body.model === 'string' && body.model) enricher_.model = body.model;
        let pathsChanged = false;
        if (typeof body.speech === 'boolean') { enricher_.speech = body.speech; pathsChanged = true; }
        if (typeof body.nonSpeech === 'boolean') { enricher_.nonSpeech = body.nonSpeech; pathsChanged = true; }
        if (pathsChanged) applyEnrichPaths(); // push the gate change to every live detector
        json(res, 200, getEnricherState()); // `enabled` ignored — enricher is always on
        return true;
      }
      // DEBUG: dump the current decoded frame the face processor sees, to inspect
      // what's actually being recognized.  GET /api/perception/frame/:streamId
      if (req.method === 'GET' && subPath.startsWith('/frame/')) {
        const streamId = decodeURIComponent(subPath.slice('/frame/'.length));
        const buf = face.currentFrame(streamId);
        if (!buf) { json(res, 404, { error: 'no frame' }); return true; }
        res.writeHead(200, { 'content-type': 'image/jpeg' });
        res.end(buf);
        return true;
      }
      // DEBUG: serve a saved enricher WAV so the Studio can PLAY the exact audio a row was made
      // from. GET /api/perception/enrich-audio/:dock/:startedAtMs → the wav (or 404 if not saved,
      // e.g. PERCEPTION_ENRICH_SAVE off or pruned). The console picks the nearest saved file to the
      // row's start, since the filename is <startedAtMs>_v<voiced%>.wav.
      {
        const am = subPath.match(/^\/enrich-audio\/([^/]+)\/(\d+)$/);
        if (am && req.method === 'GET') {
          const dock = decodeURIComponent(am[1]!); const want = Number(am[2]!);
          const dir = `.data/enrich-audio/${dock}`;
          try {
            const fs = await import('node:fs');
            const files = fs.readdirSync(dir).filter((f) => f.endsWith('.wav'));
            // PRIMARY: the client sends the row's enrichBatchId, which IS the WAV window's startedAtMs
            // = the filename prefix. Match it EXACTLY — this is unambiguous even when batch windows
            // OVERLAP (adjacent 16-30s windows), which the old "window containing the time" match got
            // wrong (a boundary time matched the wrong window → "play one plays both", raw STT from a
            // different clip). Exact-prefix first; the containing-window scan is only a fallback for
            // pre-batchId history that still sends a segment time.
            let best = files.find((f) => Number(f.split('_')[0]) === want);
            if (!best) {
              // FALLBACK (old rows w/o enrichBatchId): the WAV whose window CONTAINS `want`, latest
              // start. Window duration from file size: 16 kHz mono 16-bit = 32000 bytes/s (+44 hdr).
              let bestStart = -Infinity;
              for (const f of files) {
                const t = Number(f.split('_')[0]);
                if (t > want + 1000) continue;
                let durMs = 30_000;
                try { durMs = Math.round(((fs.statSync(`${dir}/${f}`).size - 44) / 32000) * 1000); } catch { /* */ }
                if (want <= t + durMs + 1000 && t > bestStart) { bestStart = t; best = f; }
              }
            }
            if (!best) { json(res, 404, { error: 'no saved audio for this row' }); return true; }
            const buf = fs.readFileSync(`${dir}/${best}`);
            res.writeHead(200, { 'content-type': 'audio/wav', 'content-length': String(buf.length) });
            res.end(buf);
          } catch { json(res, 404, { error: 'enrich audio not available (PERCEPTION_ENRICH_SAVE off?)' }); }
          return true;
        }
      }
      // Gallery: list enrolled people / remove one.
      if (req.method === 'GET' && subPath === '/gallery') {
        // names (back-compat) + people [{name, samples:[{index, photo}]}] so the
        // console can show every enrolled capture and delete one by index.
        json(res, 200, { names: gallery.names(), people: gallery.people() });
        return true;
      }
      // Delete one enrolled capture (fingerprint+photo): { name, index }.
      // Removing the last one removes the person.
      if (req.method === 'POST' && subPath === '/gallery/sample/remove') {
        const body = await parseBody<{ name?: string; index?: number }>(req);
        const removed = body.name != null && typeof body.index === 'number'
          ? gallery.removeSample(body.name, body.index) : false;
        json(res, 200, { removed });
        return true;
      }
      // Enroll the face currently on screen for a dock: { streamId, name }.
      if (req.method === 'POST' && subPath === '/enroll') {
        const body = await parseBody<{ streamId?: string; name?: string }>(req);
        if (!body.streamId || !body.name) {
          json(res, 400, { error: 'enroll needs streamId + name' });
          return true;
        }
        const result = await face.enrollCurrent(body.streamId, body.name.trim());
        // broadcast so every console (this tab + any other) refreshes the gallery.
        bus.publish({ topic: 'perception', kind: 'enroll-result', payload: { name: body.name.trim(), ok: result.ok, reason: result.reason }, source: 'station' });
        json(res, result.ok ? 200 : 409, result);
        return true;
      }
      if (req.method === 'POST' && subPath === '/gallery/remove') {
        const body = await parseBody<{ name?: string }>(req);
        const removed = body.name ? gallery.remove(body.name) : false;
        json(res, 200, { removed });
        return true;
      }
      // Reassign ONE sample to another person ("this photo is actually X").
      if (req.method === 'POST' && subPath === '/gallery/sample/reassign') {
        const body = await parseBody<{ from?: string; index?: number; to?: string }>(req);
        const r = body.from && body.to && typeof body.index === 'number'
          ? gallery.reassignSample(body.from, body.index, body.to)
          : { ok: false, removedSource: false };
        json(res, 200, r);
        return true;
      }
      // Rename a person (case-insensitive; merges into an existing name).
      if (req.method === 'POST' && subPath === '/gallery/rename') {
        const body = await parseBody<{ from?: string; to?: string }>(req);
        const r = body.from && body.to ? gallery.rename(body.from, body.to) : { ok: false, merged: false };
        json(res, 200, r);
        return true;
      }
      // Prune corrupt samples (bad/missing descriptors) + now-empty people. With
      // { photoless: true } also drop valid-but-photo-less samples (so every kept
      // sample is viewable — at a small cost to matching robustness).
      if (req.method === 'POST' && subPath === '/gallery/clean') {
        const body = await parseBody<{ photoless?: boolean }>(req);
        json(res, 200, gallery.clean(!!body.photoless));
        return true;
      }
      // ── VOICE gallery (fingerprints) — parallel to the face routes above. ──
      if (req.method === 'GET' && subPath === '/voice/gallery') {
        json(res, 200, { names: voiceId.gallery.names(), people: voiceId.gallery.people() });
        return true;
      }
      // Recent fingerprinted utterances for a dock — the enroll UI's pick list
      // ("speak a few lines, then select which were you"): ?dock=<dockId>.
      if (req.method === 'GET' && subPath === '/voice/recent') {
        const dock = new URL(req.url ?? '', 'http://x').searchParams.get('dock') ?? '';
        json(res, 200, { recent: voiceId.recent(dock) });
        return true;
      }
      // Enroll selected recent utterances as one person: { dock, name, ids }.
      if (req.method === 'POST' && subPath === '/voice/enroll') {
        const body = await parseBody<{ dock?: string; name?: string; ids?: number[] }>(req);
        if (!body.dock || !body.name?.trim() || !Array.isArray(body.ids) || !body.ids.length) {
          json(res, 400, { error: 'voice enroll needs dock + name + ids[]' });
          return true;
        }
        // Near-identical re-enrollments dedup server-side (counted, not stored).
        const r = voiceId.enrollFromRecent(body.dock, body.name.trim(), body.ids);
        const ok = r.enrolled > 0 || r.duplicates > 0; // a dup means "already known", not a failure
        bus.publish({ topic: 'perception', kind: 'enroll-result', payload: { name: body.name.trim(), ok, voice: true }, source: 'station' });
        json(res, ok ? 200 : 409, { ok, ...r });
        return true;
      }
      if (req.method === 'POST' && subPath === '/voice/gallery/remove') {
        const body = await parseBody<{ name?: string }>(req);
        json(res, 200, { removed: body.name ? voiceId.removePerson(body.name) : false });
        return true;
      }
      if (req.method === 'POST' && subPath === '/voice/gallery/sample/remove') {
        const body = await parseBody<{ name?: string; index?: number }>(req);
        const removed = body.name != null && typeof body.index === 'number'
          ? voiceId.removeSample(body.name, body.index) : false;
        json(res, 200, { removed });
        return true;
      }
      // Serve an enrolled sample's permanent clip: GET /voice/clip/<file> (flat names only).
      {
        const cm = subPath.match(/^\/voice\/clip\/([a-z0-9-]+\.wav)$/);
        if (cm && req.method === 'GET') {
          try {
            const fs = await import('node:fs');
            const buf = fs.readFileSync(`${VOICE_CLIPS_DIR}/${cm[1]}`);
            res.writeHead(200, { 'content-type': 'audio/wav', 'content-length': String(buf.length) });
            res.end(buf);
          } catch { json(res, 404, { error: 'clip not found' }); }
          return true;
        }
      }
      // Serve a speech row's utterance audio: GET /utterance-audio/:dock/:startedAtMs
      // (the bounded always-on dump speech-watch writes; exact filename match).
      // The dock segment is re-validated AFTER decoding — `[^/]+` alone admits
      // percent-encoded `../` (path traversal); dock names are plain slugs.
      {
        const um = subPath.match(/^\/utterance-audio\/([^/]+)\/(\d+)$/);
        if (um && req.method === 'GET') {
          const dock = decodeURIComponent(um[1]!);
          if (!/^[a-zA-Z0-9_-]+$/.test(dock)) { json(res, 404, { error: 'bad dock' }); return true; }
          try {
            const fs = await import('node:fs');
            const buf = fs.readFileSync(utteranceWavPath(dock, Number(um[2]!)));
            res.writeHead(200, { 'content-type': 'audio/wav', 'content-length': String(buf.length) });
            res.end(buf);
          } catch { json(res, 404, { error: 'utterance audio not available (pruned?)' }); }
          return true;
        }
      }
      if (req.method === 'GET' && subPath.length > 1) {
        const dockId = decodeURIComponent(subPath.slice(1));
        json(res, 200, state.get(dockId) ?? { error: 'unknown dock', dockId });
        return true;
      }
      // Worker/sidecar processors POST results here; we fold + fan them like any
      // in-process result (directed to the dock + broadcast for the console/state).
      if (req.method === 'POST' && subPath === '/result') {
        const body = await parseBody<PerceptionResult>(req);
        if (!body.kind || !body.dockId || !body.streamId) {
          json(res, 400, { error: 'result needs kind, dockId, streamId' });
          return true;
        }
        const r = makeResult({
          kind: body.kind, dockId: body.dockId, streamId: body.streamId,
          payload: body.payload ?? {}, confidence: body.confidence,
          source: body.source ?? 'external', ts: body.ts,
        });
        // Direct to the dock (agent re-grounds) + broadcast (state folds it in).
        fanResult(r);
        json(res, 200, { ok: true });
        return true;
      }
      return false;
    },
  };
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

/** Read + JSON-parse a request body, tolerating an empty OR malformed body by
 *  returning {}. route() isn't wrapped in a try/catch upstream, so a raw
 *  JSON.parse throw would reject the request promise and HANG the client (no
 *  response). Every route validates required fields, so {} is handled gracefully. */
async function parseBody<T>(req: IncomingMessage): Promise<Partial<T>> {
  const raw = await readBody(req);
  if (!raw) return {};
  try { return JSON.parse(raw) as Partial<T>; } catch { return {}; }
}

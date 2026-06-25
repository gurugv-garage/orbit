/**
 * Perception module — owns the `perception` topic, the per-dock world-state, and
 * the processor registry's contents. The ProcessingHub itself is built in main.ts
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

import type { Bus } from '../../core/bus.js';
import { json } from '../../core/http.js';
import type { IncomingMessage } from 'node:http';
import type { RouteContext, StationModule } from '../../core/module.js';
import { fileURLToPath } from 'node:url';
import type { ProcessingHub } from './hub.js';
import { PerceptionState } from './state.js';
import { presenceProcessor } from './processors/presence.js';
import { faceRecognitionProcessor } from './processors/face-recognition.js';
import { visionSnapshotProcessor } from './processors/vision-snapshot.js';
import { identitySnapshotProcessor } from './processors/identity-snapshot.js';
import { sttWatchProcessor } from './processors/stt-watch.js';
import { backgroundTranscribe } from './processors/background-stt.js';
import { bodyMotionWatchProcessor, type MotionCommand } from './processors/bodymotion-watch.js';
import { SnapshotStore, isoIst, sampleEvenly, type SnapshotRecord } from './snapshots.js';
import { TakeStore } from './takes.js';
import { summarize, geminiText } from './summarizer.js';
import { buildGrounding, memoryGroundingSlice, type LastSummary } from './grounding.js';
import { SidecarSupervisor } from './sidecars.js';
import { MemoryStore, type MemoryRow, type MemoryType, type RecallFilter, type LineageEdge } from './memory/store.js';
import { geminiEmbedder } from './memory/embedder.js';
import { startGateWatcher, type RaisedThought } from './attention/gate-watcher.js';
import { startAutoSummarizer } from './auto-summarizer.js';
import { startLongTermMemoryCurator, CONFIG_META as CURATOR_CONFIG_META, type CuratorHandle } from './memory/longterm/curator.js';
import { pendingObservations, pendingStats } from './memory/longterm/sources.js';
import type { BeliefHit } from './memory/longterm/reconcile.js';
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
 *  defaults the processors use (vision-snapshot.ts / stt-watch.ts). */
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

// Gallery persists next to the server's data (alongside the db). One file.
const GALLERY_PATH = fileURLToPath(new URL('../../../data/face-gallery.json', import.meta.url));

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
  forDock(dockId: string): string | undefined;
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

/** RUNTIME state of the background diarized-STT (Gemini) pipeline — flippable live
 *  from the Perception Studio (GET/POST /api/perception/bg-stt). `enabled` gates
 *  whether each utterance gets re-transcribed online; `model` is which Gemini model
 *  does it. Seeded from PERCEPTION_BG_STT_MODEL at module init. */
const bgStt_ = { enabled: false, model: 'gemini-2.5-flash-lite' };
export function getBgStt() { return { ...bgStt_ }; }

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

const curatorRef: { current?: CuratorHandle } = {};
/** The live memory-curator handle (toggle + recent passes + run-now) — backs the
 *  Perception Studio's curator panel. Set when the perception module inits. */
export function getMemoryCuratorApi(): CuratorHandle | undefined {
  return curatorRef.current;
}

/**
 * Final-transcript hook (A1.2, the always-on-mic shift). The server STT
 * (stt-watch) emits one final transcript per endpointed utterance; the brain
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


export function perceptionModule(getHub: () => ProcessingHub): StationModule {
  let state: PerceptionState;
  const snapshots = new SnapshotStore(); // WebRTC vision+speech snapshot records
  snapshotsRef.current = {
    inWindow: (fromIso, toIso, dockId) =>
      snapshots.inWindow(fromIso, toIso).filter((r) => !dockId || r.dockId === dockId),
  };
  const takes = new TakeStore();         // frozen snapshot bundles for A/B replay
  // Latest produced summary PER DOCK — the head of perception grounding (3.1). Set
  // on each successful /snapshots/summarize; read synchronously by the brain facade.
  const lastSummary = new Map<string, LastSummary>();
  // The unified per-dock MEMORY store (Decision 4) — durable sqlite, gemini-embedded
  // for semantic recall. Backs the recall_memory/inspect/remember/update/forget tools.
  const memory = new MemoryStore(orbitDb(), geminiEmbedder());
  const sidecars = new SidecarSupervisor(); // start/stop the MLX sidecars from the console
  let bus: Bus;
  const gallery = new Gallery(GALLERY_PATH);
  const face = faceRecognitionProcessor(gallery);
  // A1.2: the brain registers onFinal (via TranscriptApi) to receive each final
  // utterance; we hold the single handler and forward stt-watch's events to it.
  // It also reports `speaking` per dock (echo-gate) — stt-watch drops audio then.
  let finalHandler: ((t: FinalTranscript) => void) | undefined;
  // LIVE INTERIMS: the brain registers a handler (to forward partials to the dock UI)
  // and a listening-resolver (the gate — only produce interims during an active turn).
  let interimHandler: ((t: InterimTranscript) => void) | undefined;
  let listeningResolver: ((dockId: string) => boolean) | undefined;
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
    setListeningResolver: (fn) => { listeningResolver = fn; },
  };
  // BACKGROUND STT (production split, docs/findings/recall-reliability.md): each
  // VAD-gated utterance is async re-transcribed online (Gemini) to UPGRADE the
  // snapshot with a better, DIARIZED transcript for recall. The live addressed-turn
  // path stays local Whisper. This is now a RUNTIME toggle (the Perception Studio
  // flips it live) rather than a fixed env var: PERCEPTION_BG_STT_MODEL only seeds
  // the model name + the initial enabled state, so existing setups behave as before
  // (env set → on at boot; env unset → off, but still flippable on at runtime).
  const DEFAULT_BG_STT_MODEL = 'gemini-2.5-flash-lite';
  bgStt_.model = process.env.PERCEPTION_BG_STT_MODEL || DEFAULT_BG_STT_MODEL;
  bgStt_.enabled = !!process.env.PERCEPTION_BG_STT_MODEL;
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
  // Always wired; gated at CALL time on the runtime toggle so it can flip live
  // without rebuilding the processor. Disabled → returns null (the stt-watch path
  // then keeps the local-Whisper text, exactly like the old env-unset case).
  const bgStt = async (pcm: Int16Array, rate: number, dockId: string) => {
    if (!bgStt_.enabled) return null;
    const model = bgStt_.model; // snapshot the model used for THIS call (it can flip live)
    const up = await backgroundTranscribe(pcm, rate, model, bgContext(dockId), dockId);
    // tag the result with the diarization model so the snapshot records STT and
    // diarization models SEPARATELY (the two stages are distinct engines).
    return up ? { ...up, model } : null;
  };
  const stt = sttWatchProcessor(
    snapshots,
    (e) => finalHandler?.(e),
    (dockId) => Date.now() < (speakingUntil.get(dockId) ?? 0),
    bgStt,
    // LIVE INTERIMS → brain → directed caption frame to the dock. Gated on the
    // brain's listening-resolver (only during an active listening/followup turn);
    // if the brain never registers one, interims never fire (resolver stays undefined).
    (e) => interimHandler?.(e),
    (dockId) => listeningResolver?.(dockId) ?? false,
  ); // 🎙 speech (exposes flushAll)
  // Vision reuses the face processor's decoded frame (ONE ffmpeg per dock, not two).
  const vision = visionSnapshotProcessor(snapshots, (sid) => face.currentFrame(sid)); // 👁 vision (captureNow)
  const bodymotion = bodyMotionWatchProcessor(snapshots); // 🤖 ego-motion (setMotion seam)

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
        const recs = snapshots.inWindowWithState(fromIso, toIso).filter((r) => r.dockId === dockId);
        const result = await summarize(recs);
        // Only update the BACKGROUND grounding (lastSummary) when this is a background-
        // scope summary. A tight "right now" read (force_get_current, ~6s window) must
        // NOT overwrite the 60s background sense — it's a momentary answer, not the
        // ongoing context — so it passes cache:false.
        if (result.summary && !result.error && opts?.cache !== false) {
          lastSummary.set(dockId, {
            dockId, text: result.summary,
            window: { from: fromIso, to: toIso }, computedAt: Date.now(),
          });
        }
        return { summary: result.summary, error: result.error, window: { from: fromIso, to: toIso } };
      };

      // Perception grounding facade for the brain (3.1): synchronously build the
      // per-turn context block for a dock — last summary (with staleness) + the raw
      // stream since it, from this dock's records. No network; the brain injects it.
      groundingRef.current = {
        forDock(dockId: string): string | undefined {
          const now = Date.now();
          // this dock's recent records (the store mixes docks; records are tagged).
          const recent = snapshots.list().filter((r) => r.dockId === dockId);
          const block = buildGrounding({
            last: lastSummary.get(dockId) ?? null,
            recent,
            now,
            nowIso: isoIst(new Date(now)),
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
          for (const r of snapshots.list()) m.set(r.dockId, (m.get(r.dockId) ?? 0) + 1);
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

      // LONG-TERM MEMORY CURATOR: the pipeline layer that tends durable (long-term)
      // memory from short-term sources (the snapshot stream). Two ops on their own
      // clocks (docs/decision-traces/long-term-memory-curator.md):
      //   • consolidate — accumulation-driven: promote salient speech (diarized) into
      //     new derived beliefs, event-time aligned (who was present when said), lineage'd.
      //   • reconcile  — slow interval: revise/forget existing beliefs (the maintain pass).
      // In-process (reaches MemoryStore + the snapshot ring directly); LLM via the
      // summarizer's gemini path. Always STARTED so the console can flip it live; enabled
      // seeded from PERCEPTION_CURATE (off when =0). Backs GET/POST /api/perception/curator.
      const toBeliefHit = (m: MemoryRow): BeliefHit =>
        ({ id: m.id, type: m.type, subject: m.subject, claim: m.claim, confidence: m.confidence });
      /** who was present as-of an event-time iso (event-time alignment via stateAt). */
      const presentAt = (iso: string): string | undefined => {
        const rec = snapshots.stateAt('identity', iso);
        const t = rec?.payload.text;
        return typeof t === 'string' && t !== 'no one in view' ? t : undefined;
      };
      const sourceCtx = { store: snapshots, presentAt };
      /** docks with durable memory OR any snapshot activity — the curation candidates. */
      const curatorDocks = (): string[] => {
        const set = new Set<string>(memory.docks());
        for (const r of snapshots.list()) set.add(r.dockId);
        return [...set];
      };
      curatorRef.current = startLongTermMemoryCurator({
        enabled: process.env.PERCEPTION_CURATE !== '0',
        activeDocks: curatorDocks,
        // load-aware: pending = unconsolidated speech after the watermark. The cadence
        // (cadence.ts) decides flood/age/quiet from these stats; consolidate takes a
        // bounded oldest chunk so a flood drains over ticks, exactly-once.
        pendingStats: (dockId, watermarkIso) => pendingStats(snapshots, dockId, watermarkIso),
        pendingObservations: (dockId, watermarkIso, limit) =>
          pendingObservations(sourceCtx, dockId, watermarkIso, limit),
        // restart-safe watermark: newest event-time already consolidated (belief lineage).
        // lineage source_id is `<kind>@<iso>`; the watermark compares against the bare iso.
        watermarkSeed: (dockId) => {
          const src = memory.latestConsolidatedSource(dockId); // e.g. 'speech@2026-…+05:30'
          const at = src?.indexOf('@') ?? -1;
          return src && at >= 0 ? src.slice(at + 1) : '';
        },
        beliefs: async (dockId, limit) => (await memory.recall({ dockId, limit })).map(toBeliefHit),
        reflect: (prompt, dockId, purpose) => geminiText(prompt, dockId, purpose),
        create: (dockId, b) => memory.remember({
          dockId, type: b.type as MemoryType, subject: b.subject, claim: b.claim,
          confidence: b.confidence, derivation: 'derived', lineage: b.lineage,
        }),
        revise: (id, patch) => memory.revise(id, patch),
        forget: (id) => memory.forget(id),
        log: (m) => console.log(m),
      });
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

      // ── MEMORY CURATOR — the console's curator panel (control + watch + debug). ──
      // GET /curator → { enabled, recent: [ {ts,dockId,reviewed,revised,forgot,skipped,changes} ] }
      if (req.method === 'GET' && subPath === '/curator') {
        json(res, 200, {
          enabled: curatorRef.current?.isEnabled() ?? false,
          recent: curatorRef.current?.recent(30) ?? [],
        });
        return true;
      }
      // POST /curator {enabled} → toggle the maintenance loop live
      if (req.method === 'POST' && subPath === '/curator') {
        const b = await parseBody<{ enabled?: boolean }>(req);
        curatorRef.current?.setEnabled(b.enabled === true);
        json(res, 200, { ok: true, enabled: curatorRef.current?.isEnabled() ?? false });
        return true;
      }
      // POST /curator/run → force a pass NOW (bypasses the per-dock interval) for debugging
      if (req.method === 'POST' && subPath === '/curator/run') {
        if (!curatorRef.current) { json(res, 503, { error: 'curator not ready' }); return true; }
        await curatorRef.current.tick();
        json(res, 200, { ok: true, recent: curatorRef.current.recent(5) });
        return true;
      }
      // GET /curator/config → { scope, config, meta } — the live-tunable knobs (ALL docks).
      if (req.method === 'GET' && subPath === '/curator/config') {
        if (!curatorRef.current) { json(res, 503, { error: 'curator not ready' }); return true; }
        json(res, 200, { scope: 'all-docks', config: curatorRef.current.getConfig(), meta: CURATOR_CONFIG_META });
        return true;
      }
      // POST /curator/config {<knob>:<value>,…} → patch live; clamped to bounds; applies
      // NEXT TICK (no restart). Returns the resulting config so the UI confirms what applied.
      if (req.method === 'POST' && subPath === '/curator/config') {
        if (!curatorRef.current) { json(res, 503, { error: 'curator not ready' }); return true; }
        const b = await parseBody<Record<string, unknown>>(req);
        const patch: Record<string, number> = {};
        for (const k of Object.keys(CURATOR_CONFIG_META)) if (typeof b[k] === 'number') patch[k] = b[k] as number;
        const config = curatorRef.current.setConfig(patch);
        json(res, 200, { ok: true, scope: 'all-docks', config, meta: CURATOR_CONFIG_META });
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
        const recs = snapshots.inWindowWithState(fromIso, toIso)
          .filter((r) => !body.dock || body.dock === 'all' || r.dockId === body.dock);
        const keyframes = body.withKeyframes
          ? snapshots.keyframesInWindow(fromIso, toIso, body.maxKeyframes ?? 6) : undefined;
        const result = await summarize(recs, { keyframes, model: body.model });
        // Cache it as the head of grounding (3.1) for whichever dock this window is
        // about — the dominant dockId in the summarized records. A real (non-empty,
        // non-error) summary only; an error/empty leaves the prior summary in place.
        const dockId = dominantDock(recs);
        if (dockId && result.summary && !result.error) {
          lastSummary.set(dockId, {
            dockId, text: result.summary,
            window: { from: fromIso, to: toIso }, computedAt: Date.now(),
          });
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
      // Diarized background-STT (Gemini) pipeline toggle. GET → {enabled, model};
      // POST {enabled?, model?} flips it live (no restart). Off ⇒ local-Whisper only.
      if (req.method === 'GET' && subPath === '/bg-stt') {
        json(res, 200, getBgStt());
        return true;
      }
      if (req.method === 'POST' && subPath === '/bg-stt') {
        const body = await parseBody<{ enabled?: boolean; model?: string }>(req);
        if (typeof body.enabled === 'boolean') bgStt_.enabled = body.enabled;
        if (typeof body.model === 'string' && body.model) bgStt_.model = body.model;
        json(res, 200, getBgStt());
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

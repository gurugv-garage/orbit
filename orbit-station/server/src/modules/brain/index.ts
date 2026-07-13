/**
 * Brain module — the dock's LLM loop, server-side (docs/decision-traces/server-brain-impl.md).
 *
 * Owns the `agent` topic. One DockBrainSession per dock (lazy). Tenancy rule:
 * a frame's dock is resolved from the SENDER's hello via the roster — never
 * from the payload — so a device can only ever act on its own lane.
 *
 *   phone → station:  transcript (partials pre-warm), turn-request,
 *                     tool-result (handled by RpcBroker), turn-cancel,
 *                     speech-status
 *   station → phone:  tool-call, speak, turn-status, brain-status (directed)
 *
 *   GET    /api/brain/docks                lanes + open session
 *   GET    /api/brain/keystatus            which API key the current model uses
 *   GET    /api/brain/:dock/sessions       session index (incl. summaries)
 *   GET    /api/brain/:dock/history        open session transcript
 *   POST   /api/brain/:dock/session/end    close now (next turn opens fresh)
 *   GET    /api/brain/:dock/session/:id/dump  export as pi-harness v3 JSONL (download)
 *   GET    /api/brain/:dock/skills         installed skills (name+description)
 *   POST   /api/brain/:dock/skills         install a SKILL.md ({ content })
 *   DELETE /api/brain/:dock/skills/:name   remove an installed skill
 */

import type { Bus } from '../../core/bus.js';
import { json } from '../../core/http.js';
import type { WebSocketGateway } from '../../core/websocket-gateway.js';
import { dockConditions } from '../../core/conditions.js';
import { readFileSync } from 'node:fs';
import type { RouteContext, StationModule } from '../../core/module.js';
import type { Directory } from '../docks/directory.js';
import type { MotionExecutor } from '../bodylink/motion.js';
import { gesturesFromConfig } from '../bodylink/motion.js';
import { getFaceTools, getPerceptionGrounding, getMemoryApi, getGateApi, getTranscriptApi, getPerceiveStore, getBgAddressedApi, markSpeechAddressed, markEnrichWoke, noteSelfRemark, lastSalientAt } from '../perception/index.js';
import { getSelf } from '../ego/index.js';
import { isRecording } from '../capture/index.js';
import type { VideoRecorderApi } from '../perception/record/recorder.js';
import { RpcBroker } from './rpc.js';
import { BusyQueue, splitByAge, type HeardUtterance } from './busy-queue.js';
import { classifyStopIntent } from './stop-intent.js';
import { DockBrainSession, type TurnRequest, keyStatusFor } from './session.js';
import { SessionStore } from './store.js';
import { installDockSkill, listDockSkills, removeDockSkill, loadDockSkills } from './skills.js';
import { buildSystemPrompt } from './prompt.js';
import { FILE_TOOLS_PROMPT } from './filetools.js';
import { TaskSupervisor, type InstanceInfo, type SignalKind } from './tasks/supervisor.js';
import { buildTaskTools } from './tasks/tools.js';
import { defaultTasksRoot, userTasksRoot, loadAllTaskDefs, findTaskDef } from './tasks/manager.js';
import { CapabilityBroker } from './tasks/capabilities.js';
import { buildCapabilityRegistry } from './tasks/register-capabilities.js';
import { validateParams } from '../../tasks/_harness/index.js';
import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

/** Read-only access to brain state for other modules (the feedback bundler:
 *  session meta+transcript, the live profile, the conversation probe, the active
 *  model, and recent addressed-decisions). Tenancy is the caller's concern —
 *  this is keyed by dock, not by peer. */
export interface BrainAccess {
  openSessionId(dock: string): string | undefined;
  sessionDump(dock: string, sessionId: string): { meta?: unknown; transcript?: unknown };
  profile(dock: string): Promise<unknown>;
  conversation(dock: string): unknown;
  models(dock: string): { brain?: string; thinking?: string };
  addressed(dock: string): unknown[];
  dockOf(peerId: string): string | undefined;
}
const brainRef: { current?: BrainAccess } = {};
/** The live BrainAccess (set when the brain module inits). */
export function getBrainAccess(): BrainAccess | undefined {
  return brainRef.current;
}

/** Short filler tokens STT commonly emits in place of (or mangling) the wake-phrase lead-in
 *  — "hey" gets rendered as "okay"/"k"/"hi"/etc. The NAME ("orbit") is the high-signal token;
 *  the lead-in is throwaway. We accept the name preceded by at most one of these (or nothing). */
const WAKE_FILLER = new Set(['hey', 'hay', 'hi', 'ok', 'okay', 'k', 'kay', 'yo', 'a', 'ay', 'eh', 'um', 'uh', 'hello', 'hej', 'he']);

/** SOUNDALIKES of the wake NAME that STT/diarization routinely mis-render. "orbit" is two stressed
 *  syllables ("OR-bit") that ASR maps onto lots of real words — we accept these as the name so a
 *  mangled final still wakes. Whole-word only (so "orbital"/"exorbitant" still don't wake — those
 *  are handled by the caller's whole-word tokenisation). Keyed by the CANONICAL name; a wake
 *  config can extend the set per-dock via `aliases` (exposed in the conductor console).
 *  Hardware/STT-observed misses drive this list — add, don't theorise. */
const WAKE_SOUNDALIKES: Record<string, string[]> = {
  orbit: [
    'orbit', 'orbits', 'orbid', 'orbet', 'orbut', 'orbot', 'orbite', 'orbita',
    'oribit', 'oribut', 'arbit', 'arbut', 'aubert', 'obert', 'albert', 'aubrey',
    'robert', 'robit', 'orbeez', 'awbit', 'or bit', 'all bit', 'or bet',
  ],
};

/** The accepted renderings of a phrase's NAME (last word): the canonical name + its built-in
 *  soundalikes + any per-dock `extra` aliases from the wake config. All lower-cased, deduped.
 *  Multi-word aliases ("or bit") are matched as a phrase by the caller. */
export function nameAliases(phrase: string, extra: string[] = []): string[] {
  const name = phrase.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim().split(' ').filter(Boolean).pop() ?? '';
  const built = WAKE_SOUNDALIKES[name] ?? [name];
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
  return [...new Set([name, ...built, ...extra.map(norm)].filter(Boolean))];
}

/** WAKE-PHRASE match (conductor's `wakeUp`): true if the utterance is a wake-from-idle call.
 *  Lenient because STT phrasing varies a lot — both the throwaway lead-in AND the name itself
 *  (ASR mis-renders "orbit" as "albert"/"robert"/… — see WAKE_SOUNDALIKES). Two ways to match,
 *  both case/punctuation-insensitive and required NEAR THE START (not buried mid-sentence):
 *   1) the FULL phrase ("hey orbit") as a whole-word run, with ≤2 filler words before it; or
 *   2) the NAME (or a soundalike) as the first real word, optionally preceded by exactly one
 *      short filler token — catches STT's "okay orbit" / "k orbit" / bare "orbit" / "hey albert";
 *   3) the NAME (or a soundalike) as the LAST real word — a trailing term of address ("good job,
 *      orbit" / "thanks orbit"), which is a strong addressed signal even though the name isn't up
 *      front. A name buried in the MIDDLE still does NOT wake (that's a mention, not an address).
 *      Whole-word only, so "orbital" does NOT wake.
 *  `aliases` extends the accepted name renderings per-dock (from the wake config / console).
 *  Hardware-observed misses that motivated (2): "Okay orbit." / "K orbit." (2026-06-26). */
export function matchesWake(text: string, phrase: string, aliases: string[] = []): boolean {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
  const t = norm(text); const p = norm(phrase);
  if (!t || !p) return false;
  // (1) FULL phrase near the start.
  const idx = (' ' + t + ' ').indexOf(' ' + p + ' ');
  if (idx >= 0) {
    const before = t.slice(0, Math.max(0, idx - 1)).trim();
    if (before.split(' ').filter(Boolean).length <= 2) return true;
  }
  // (2)/(3) NAME (or a soundalike) at the START or END. Names may be multi-word ("or bit") —
  // match the alias as a whole-word run. Longest aliases first so "or bit" beats a stray "or".
  const names = nameAliases(p, aliases).sort((a, b) => b.length - a.length);
  const words = t.split(' ').filter(Boolean);
  const runAt = (nmWords: string[], at: number) => at >= 0 && nmWords.every((w, i) => words[at + i] === w);
  for (const nm of names) {
    const nmWords = nm.split(' ').filter(Boolean);
    // (2) starts with the name…
    if (runAt(nmWords, 0)) return true;                                     // "orbit …" / "or bit …"
    // …or one short filler then the name.
    if (words.length > nmWords.length && WAKE_FILLER.has(words[0]!) && runAt(nmWords, 1)) return true; // "okay orbit …"
    // (3) ENDS with the name — a trailing term of address ("good job, orbit").
    if (runAt(nmWords, words.length - nmWords.length)) return true;         // "… orbit"
  }
  return false;
}

/** Strip the wake NAME from a matched utterance and return the remaining CONTENT, or '' if the
 *  utterance was a bare wake call ("hey orbit" with nothing else). Handles the name at either end:
 *   • LEADING ("hey orbit, look right")  → returns the tail after the name ("look right");
 *   • TRAILING ("good job, orbit")       → returns the head before the name ("good job") — a term
 *     of address, so the praise/callout itself is the content and gets a real reply, not "did you
 *     call me?". Original casing/punctuation is preserved; only the boundary comma/space next to
 *     the name is trimmed. Only call when matchesWake(text, phrase) is already true. */
export function stripWake(text: string, phrase: string, aliases: string[] = []): string {
  // Name (alias) runs, longest first so we consume the whole "or bit" not a stray "or".
  const names = nameAliases(phrase, aliases).map((n) => n.split(' ').filter(Boolean)).sort((a, b) => b.length - a.length);
  // Walk the raw tokens (keeping start+end offsets) so we can excise the name run without re-casing.
  const toks: { w: string; start: number; end: number }[] = [];
  const re = /[a-z0-9]+/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) toks.push({ w: m[0].toLowerCase(), start: m.index, end: m.index + m[0].length });
  const runAt = (nm: string[], at: number) => at >= 0 && at + nm.length <= toks.length && nm.every((w, j) => toks[at + j]!.w === w);
  // LEADING: a name run within the first few tokens → content is everything AFTER it.
  for (let i = 0; i <= 3; i++) {
    for (const nm of names) {
      if (runAt(nm, i)) {
        const tail = text.slice(toks[i + nm.length - 1]!.end).replace(/^[\s,.:;!?—–-]+/, '').trim();
        if (tail) return tail;               // leading name + command
        // No tail here — fall through to check a TRAILING match (or bare wake) below.
      }
    }
  }
  // TRAILING: a name run at the END → content is everything BEFORE it (the term-of-address case).
  for (const nm of names) {
    if (runAt(nm, toks.length - nm.length)) {
      const head = text.slice(0, toks[toks.length - nm.length]!.start).replace(/[\s,.:;!?—–-]+$/, '').trim();
      // If the head is ONLY wake filler ("hey"/"okay"/…), this is bare wake ("hey orbit"), not
      // a praise/callout — no content. Otherwise the head IS the addressed content ("good job").
      const headWords = head.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(Boolean);
      if (headWords.length && headWords.every((w) => WAKE_FILLER.has(w))) return '';
      return head;
    }
  }
  return ''; // bare wake ("hey orbit") — no content either side.
}

/** WakeApi — the conductor's `wakeUp` behaviour governs the wake check through this:
 *  enable/disable + the phrase/prompt, per dock. */
export interface WakeApi {
  setWakeConfig(dock: string, cfg: WakeConfig | null): void;
}
/** Wake config, governed by the conductor's `wakeUp` behaviour (enable/phrase/prompt) plus
 *  `aliases` — extra accepted renderings of the wake NAME (STT soundalikes), tunable in the
 *  conductor console on top of the built-in WAKE_SOUNDALIKES set. */
export interface WakeConfig { enabled: boolean; phrase: string; prompt: string; aliases?: string[] }
const wakeApiRef: { current?: WakeApi } = {};
/** The live WakeApi (set when the brain module inits) — for the conductor. */
export function getWakeApi(): WakeApi | undefined { return wakeApiRef.current; }

/** ConductorAccess — the narrow surface the conductor needs from the brain: the dock's
 *  conversation mode + start/stop/list of background tasks (keeps the supervisor encapsulated).
 *  faceFollow starts under the open session; if it closes, the task dies and the conductor's
 *  idempotent reconcile simply restarts it next tick — that's how a session-scoped task becomes
 *  a session-INDEPENDENT behaviour (design §4.1) without new task-lifecycle machinery. */
export interface ConductorAccess {
  convMode(dock: string): string | null;
  listTasks(dock: string): Array<{ name: string; instanceId: string; parentSessionId?: string; startedAt: number; state: string; status: string }>;
  /** start a packaged task by name under the dock's open session; returns instanceId | null
   *  (null if no open session / unknown task). `params` are handed to the task verbatim
   *  (the conductor passes a conducted thing's tunings — snapshot at start). */
  startTask(dock: string, taskName: string, params?: Record<string, unknown>): string | null;
  stopTask(dock: string, instanceId: string): void;
}
const condAccessRef: { current?: ConductorAccess } = {};
/** The live ConductorAccess (set when the brain module inits) — for the conductor. */
export function getConductorAccess(): ConductorAccess | undefined { return condAccessRef.current; }

const IDLE_SWEEP_MS = 60_000;
/** How often to re-push the task-digest to live docks so the app HUD self-corrects
 *  even if a per-change push was missed (failproof running-tasks view). */
const DIGEST_SWEEP_MS = 3_000;
/** A face arriving after at least this long with no presence triggers a PROACTIVE
 *  greeting ("haven't seen you in a while") — not on every walk-up, only after a
 *  real absence. Tune via CONV_GREET_ABSENCE_MS. */
const GREET_ABSENCE_MS = Number(process.env.CONV_GREET_ABSENCE_MS ?? 60 * 60_000);

export interface BrainWiring {
  directory: Directory;
  motion: MotionExecutor;
  getHub: () => WebSocketGateway;
  /** effective config value by key (the shared ConfigStore). */
  config: (key: string) => unknown;
  /** live video recorder (record_video tool). Optional — undefined disables it. */
  recordVideo?: VideoRecorderApi;
  /** snapshot per-session context onto observability on each turn end (the
   *  "instrument everything per session" hook). Undefined → no enrichment. */
  enrichSession?: (dock: string, sessionId: string, span?: { from: number; to: number }) => Promise<void> | void;
  /** the shared session-context composer sources — also handed to the
   *  inspect_observability tool so the agent can pull structured self-knowledge. */
  sessionContext?: import('../observability/context.js').ContextSources;
  /** feedback capture entrypoint (record_feedback tool). Undefined → tool off. */
  feedbackCapture?: import('./tools.js').FeedbackCaptureFn;
  /** observability read access (inspect_observability tool). Undefined → tool off. */
  obs?: import('./tools.js').ObsToolApi;
}

export function brainModule(w: BrainWiring): StationModule {
  const store = new SessionStore();
  const sessions = new Map<string, DockBrainSession>();
  // Per-dock wall-clock of the last face-presence arrival, for the long-absence
  // proactive greeting (GREET_ABSENCE_MS). Only a gap longer than that greets.
  const lastFaceArrival = new Map<string, number>();
  // TEMP DIAGNOSTIC: ring of recent addressed-utterance decisions (GET /:dock/debug/addressed).
  // Captures text + the mode/window at decision time + the decision, so a live repro of
  // "replied after listening went off" shows EXACTLY which gate let it through.
  const addrTrace: Array<Record<string, unknown>> = [];
  // WAKE (conductor's `wakeUp` behaviour): per-dock wake config, set by the conductor via
  // the exported WakeApi. Absent/disabled → no wake check (the default). The match runs in
  // onAddressedFinal (the single point every final transcript lands).
  const wakeCfg = new Map<string, WakeConfig>();
  // Set in init(): simulate a tapped addressed utterance (debug self-test seam).
  let injectAddressed: (dock: string, text: string) => void = () => {};
  // Set in init(): feed a HEARD final into onAddressedFinal with NO tap — the
  // mid-turn seam (WI-0, docs/findings/2026-07-13-busy-queue-black-hole.md
  // Addendum 3). debug/say's tap would INTERRUPT a busy turn, so the busy-queue
  // path is unreachable through it; this drives the exact same entrypoint the
  // live STT final uses.
  let injectHeard: (t: { dockId: string; text: string; startedAt: number; endedAt: number; confTier?: string }) => void = () => {};
  // Set in init(): the busy-queue drain, invoked by each session's onSettled
  // (declared here because the session factory below wires it before init runs).
  let drainBusy: (dock: string) => void = () => {};
  const tasksRoot = defaultTasksRoot();
  const userTasks = userTasksRoot();
  const taskRoots = [
    { root: tasksRoot, source: 'packaged' as const }, // packaged first: curated beats generated
    { root: userTasks, source: 'generated' as const },
  ];
  // Task defs the CONDUCTOR may start (resolved in init so ConductorAccess.startTask is
  // synchronous). v1: just face-follow.
  const condTaskDefs = new Map<string, { name: string; filePath: string; manifest: { model?: string; bgTask?: boolean } }>();
  let bus: Bus;
  let rpc: RpcBroker;

  // The ONE recording-guarded entry for a SELF-THOUGHT turn. The gate raise, the task
  // `think` capability, the long-absence greeting, and the console think-poke all funnel
  // here — the isRecording guard is a privacy invariant ("recording → dock stays silent")
  // and must never be copy-pasted per call site (a copy that forgets it speaks during a
  // recording). `session()` is the factory, so a cold dock is safe.
  const raiseSelfThought = (dock: string, text: string, opts: { key?: string; ttlMs?: number; idPrefix?: string; via?: string } = {}) => {
    if (isRecording(dock)) return;
    // No anti-repeat quote-list, no style scaffolding: the self-thought prompt is ONE
    // plain instruction (idle-moods thoughtPrompt), and we trust the model to vary its
    // own remarks from the real inputs — the camera frame + grounding + its own history
    // in the session. The old quoted-recent-lines tail bloated the prompt AND, by echoing
    // prior lines verbatim into the context, actively poisoned it (2026-07-13 root-cause:
    // a quoted code-failure line kept the model on a stale thread). Over-instructing was
    // the disease; the fix is to instruct less and let the model do its job.
    // Attach the CURRENT camera frame (when live) so the model authors the line while
    // LOOKING at the scene, not just reading vision's one-line text description —
    // speech is the dock's one channel that reaches people who aren't watching it,
    // so the words carry the visual grounding (2026-07-06 direction: rely on speech
    // + keyframes; screen/motion are garnish nobody is usually looking at).
    const streamId = w.directory.resolveCap(dock, 'camera')?.id;
    const frame = streamId ? getFaceTools()?.frame(streamId) : undefined;
    session(dock).enqueueAutonomousTurn({
      turnId: `${opts.idPrefix ?? 'self'}-${randomUUID()}`,
      // `via` = WHICH source raised this (mood bit / gate key / greet / console) —
      // surfaced in the observability trace so a self turn is attributable at a glance.
      trigger: { kind: 'self', text, ...(opts.via ? { via: opts.via } : {}) },
      ...(frame ? { imageBase64: frame } : {}),
      expiresAt: Date.now() + (opts.ttlMs ?? 60_000),
      ...(opts.key ? { coalesceKey: opts.key } : {}),
    });
  };

  // A task's parent signal (notify / finish / errored / stuck) → an autonomous
  // turn in that dock's conversational session (tasks §7a).
  const onTaskSignal = (dock: string, info: InstanceInfo, kind: SignalKind, ev: { text: string; image?: string }) => {
    // A CONDUCTOR-standing task (face-follow, idle-moods) that errors is auto-restarted by
    // the conductor's idempotent reconcile — do NOT speak the failure. With a body offline
    // this was a crash loop of spoken apologies ("my servo is taking a nap…" ×3 in 4 min,
    // seen in observability 2026-07-05); the conductor card + logs already surface it.
    if (kind === 'errored' && condTaskDefs.has(info.name)) {
      console.log(`[brain] ${dock}: standing task ${info.name} (${info.instanceId}) errored — not spoken (conductor restarts it): ${ev.text.slice(0, 140)}`);
      pushTaskDigest(dock);
      return;
    }
    // Use the session FACTORY, not sessions.get: after a station restart the
    // in-memory DockBrainSession may not exist yet (it's created lazily on the
    // first turn), but the dock has running tasks + an open session in the store.
    // Without this the task notify was silently dropped → "the reminder didn't
    // speak". The factory creates/returns the live session so the turn injects.
    const s = session(dock);
    const label = kind === 'finish' ? 'finished' : kind === 'errored' ? 'failed' : kind === 'stuck' ? 'needs input' : 'update';
    const text = `[background task ${info.name} (${info.instanceId}) ${label}] ${ev.text}`
      + (kind === 'stuck' ? ` — call provide_input("${info.instanceId}", <answer>) once the user answers.` : '');
    s.enqueueAutonomousTurn({
      turnId: `auto-${randomUUID()}`,
      trigger: { kind: 'task', text, via: `${info.name}:${kind}` },
      ...(ev.image ? { imageBase64: ev.image } : {}),
      expiresAt: Date.now() + 120_000,
      // coalesce back-to-back signals from the SAME instance (notify+finish) into
      // one turn — keeps both messages, avoids the 2nd superseding the 1st's TTS.
      coalesceKey: info.instanceId,
    });
    pushTaskDigest(dock); // refresh the app's running-tasks view on every change
  };

  // push a directed frame DOWN to a task peer, addressed by (dock, component).
  const sendToTask = (dock: string, instanceId: string, kind: string, payload: Record<string, unknown>) => {
    bus.publish({
      topic: 'tasks', kind, payload: { instanceId, ...payload },
      source: 'station', toAddr: { dock, component: `task:${instanceId}` },
    });
  };

  const supervisor = new TaskSupervisor({
    root: store.root,
    stationWsUrl: process.env.STATION_WS ?? `ws://127.0.0.1:${process.env.PORT ?? 8099}/ws`,
    runner: () => (w.config('brainTaskRunner') === 'tmux' ? 'tmux' : 'child'),
    // give every task the dock's model (for the harness vision helper) + the keys
    // already inherited from process.env (.env). No token — local processes.
    extraEnv: () => {
      const m = w.config('brainModel');
      const env: Record<string, string> = {};
      if (typeof m === 'string' && m) env.BRAIN_MODEL = m;
      return env;
    },
    onSignal: onTaskSignal,
    sendToTask,
  });

  // STATION CAPABILITIES a task can invoke over the wire (frame/recognize/move —
  // things needing the station's live in-process state) — a registry of named
  // handlers + a broker that serves `request` frames.
  const capabilities = buildCapabilityRegistry({
    directory: w.directory, motion: w.motion, getFaces: getFaceTools,
    getPerceive: getPerceiveStore,
    msSinceSalient: (dock) => {
      const at = lastSalientAt(dock);
      return at == null ? null : Date.now() - at;
    },
    getGestures: () => gesturesFromConfig(w.config('faceGestures')),
    // task `think` → the same self-thought lane as the attention gate (recording-guarded).
    enqueueThought: (dock, text, coalesceKey, via) => raiseSelfThought(dock, text, { key: coalesceKey, via }),
  });
  const capBroker = new CapabilityBroker(capabilities, sendToTask);

  // Push a compact TASK DIGEST to a dock's phone (debug surface): the open
  // sessionId + the running task instances. Sent on hello and whenever tasks
  // change (onTaskSignal), so the app can show "what's running" + the session id.
  const pushTaskDigest = (dock: string) => {
    const sessionId = store.openSession(dock)?.sessionId ?? null;
    const tasks = supervisor.list(dock)
      .filter((i) => i.state === 'running' || i.state === 'stuck')
      .map((i) => ({
        instanceId: i.instanceId, name: i.name, state: i.state, lastSignal: i.lastSignal ?? null,
        // surface the followed person's name for the face-follow indicator (named mode);
        // undefined in salient mode (the phone then falls back to the recognized identity).
        ...(typeof i.params?.target === 'string' && i.params.target ? { target: i.params.target as string } : {}),
      }));
    bus.publish({
      topic: 'agent', kind: 'task-digest',
      payload: { sessionId, tasks },
      source: 'station', toAddr: { dock, component: 'phone' },
    });
  };

  function session(dock: string): DockBrainSession {
    let s = sessions.get(dock);
    if (!s) {
      s = new DockBrainSession(dock, {
        bus, directory: w.directory, rpc, motion: w.motion, store,
        getFaces: getFaceTools, getGrounding: getPerceptionGrounding,
        getMemory: getMemoryApi, getSelf,
        recordVideo: w.recordVideo, config: w.config,
        enrichSession: w.enrichSession,
      onSelfRemark: (dock, text) => noteSelfRemark(dock, text),
        feedbackCapture: w.feedbackCapture,
        obs: w.obs,
        log: (line) => console.log(line),
        // the busy-queue drain (WI-1): fires when THIS dock's speech lane goes
        // quiet, for every turn kind. Late-bound — the drain closure is
        // assigned in init() where the queue + addressed trace live.
        onSettled: (d) => drainBusy(d),
        stopTasksForParent: (d, parentSessionId) => { supervisor.stopForParent(d, parentSessionId); },
        hasRunningTasks: (d, parentSessionId) => supervisor.hasRunningUnder(d, parentSessionId),
        getTaskTools: (d, parentSessionId) => buildTaskTools({
          dock: d, supervisor, tasksRoot, userTasksRoot: userTasks, parentSessionId, config: w.config,
          capabilityAd: capabilities.advertiseFor(d),
          knowsPerson: (name) => getFaceTools()?.knowsPerson(name) ?? false,
          knownNames: () => getFaceTools()?.knownNames() ?? [],
        }),
      });
      sessions.set(dock, s);
    }
    return s;
  }

  /** TENANT RESOLUTION: the sender's dock, from its hello — never the payload. */
  function dockOf(peerId: string): string | undefined {
    return w.getHub().roster().find((p) => p.id === peerId)?.dock;
  }

  // Expose read-only brain state to the feedback bundler (and any later reader).
  brainRef.current = {
    // Prefer the OPEN session; else fall back to the most-recent (just-closed)
    // one — feedback is usually flagged right AFTER a conversation, by which
    // point the session may have idle-closed. Without the fallback the dump
    // loses its trace link (sessions are newest-first).
    openSessionId: (dock) => store.openSession(dock)?.sessionId ?? store.sessions(dock)[0]?.sessionId,
    sessionDump: (dock, sessionId) => ({
      meta: store.sessions(dock).find((s) => s.sessionId === sessionId),
      transcript: store.messages(dock, sessionId),
    }),
    profile: (dock) => buildDockProfile(dock, w, store),
    conversation: (dock) => sessions.get(dock)?.conversation(),
    models: (dock) => {
      void dock;
      const brain = typeof w.config('brainModel') === 'string' ? (w.config('brainModel') as string) : undefined;
      const thinking = typeof w.config('brainThinkingLevel') === 'string' ? (w.config('brainThinkingLevel') as string) : undefined;
      return { brain, thinking };
    },
    addressed: (dock) => addrTrace.filter((e) => e.dock === dock),
    dockOf,
  };

  // WakeApi for the conductor's `wakeUp` behaviour — set/clear the per-dock wake config.
  wakeApiRef.current = {
    setWakeConfig: (dock, cfg) => { if (cfg) wakeCfg.set(dock, cfg); else wakeCfg.delete(dock); },
  };

  // ConductorAccess — conversation mode + task start/stop/list for the per-dock conductor.
  condAccessRef.current = {
    convMode: (dock) => sessions.get(dock)?.conversation().mode ?? null,
    listTasks: (dock) => supervisor.list(dock).map((i) => ({
      name: i.name, instanceId: i.instanceId, parentSessionId: i.parentSessionId,
      startedAt: i.startedAt, state: i.state, status: supervisor.status(i.instanceId),
    })),
    startTask: (dock, taskName, params) => {
      // brainTaskMax=0 means "tasks fully disabled" — that must include the conductor's
      // standing tasks, or an operator who quieted a dock still gets body motion + idle
      // speech (review finding 2026-07-05). Non-zero values only cap the brain's run_task
      // tool; standing tasks don't compete for those slots.
      if (Number(w.config('brainTaskMax') ?? 1) === 0) return null;
      let parent = store.openSession(dock)?.sessionId;
      if (!parent) {
        // The session idle-CLOSED while the phone stayed connected — ensurePresenceSession
        // only fires on peer-join, so nothing would ever reopen one and conducted tasks
        // stalled in ARMING forever (seen live 2026-07-05, session s-gpet). The design
        // intent (§3.0) is "a connected app always has a session for startTask to nest
        // under": complete it here — presence (an online voice peer) + a conducted start
        // is a legitimate reopen. The dock must still be genuinely present.
        if (!w.directory.resolveCap(dock, 'voice')) return null;
        session(dock).ensurePresenceSession();
        parent = store.openSession(dock)?.sessionId;
        if (!parent) return null; // still nothing (shouldn't happen); reconcile retries
      }
      const def = condTaskDefs.get(taskName);
      if (!def) return null;
      return supervisor.start({ dock, name: def.name, filePath: def.filePath, params: params ?? {}, parentSessionId: parent, model: def.manifest.model, bgTask: def.manifest.bgTask });
    },
    stopTask: (_dock, instanceId) => { supervisor.stop(instanceId); },
  };

  return {
    name: 'brain',
    topic: 'agent',
    description: 'the dock brain: per-dock pi agent sessions; transcripts up, tool-calls/speak down',

    init(b) {
      bus = b;
      rpc = new RpcBroker(bus, w.directory);

      // Resolve the task defs the conductor may start (so ConductorAccess.startTask is
      // sync). Fire-and-forget — populated well before the first ~1Hz conductor tick.
      void (async () => {
        for (const name of ['face-follow', 'idle-moods']) {
          try { const d = await findTaskDef(taskRoots, name); condTaskDefs.set(name, { name: d.name, filePath: d.filePath, manifest: d.manifest }); }
          catch { /* def missing → conductor startTask returns null, reconcile retries */ }
        }
      })();

      // PROACTIVE GATE (docs/perception-to-brain.md Phase 5): a raised attention thought
      // becomes a self-thought turn on the dock's session — the SAME autonomous-turn
      // lane as tasks (user turns still win; it defers while listening/speaking). This
      // is the auto-raise replacement for the console's manual think-poke.
      // BG-AUDIO WAKE FALLBACK: the online interpreter heard someone address the robot
      // (calling "orbit", telling it something) where the LOCAL STT mis-rendered the
      // name (Parakeet: "orbit" → "alright"/"hey now" — seen live 2026-07-05), so the
      // local wake matcher never fired. The observation arrives ~2-4 s late (Gemini
      // RTT); we act on it ONLY when the wake behaviour is armed, the dock is fully
      // idle (a local wake/turn already engaging = natural dedupe), confidence is
      // decent, and we're not recording. The BRAIN decides — perception only observed.
      getBgAddressedApi().onAddressed((e) => {
        const cfg = wakeCfg.get(e.dockId);
        if (!cfg?.enabled || e.conf < 0.6 || isRecording(e.dockId)) return;
        // NAME REQUIRED (Addendum 5.1): the enricher judged meeting chatter
        // ("tell me something", conf 0.95) as addressed and IGNITED followup
        // chains. An out-of-band wake must contain the robot's actual name —
        // the same renderings the local matcher accepts (incl. soundalikes).
        const heard = `${e.transcript ?? ''} ${e.directive ?? ''}`.toLowerCase();
        if (!nameAliases(cfg.phrase, cfg.aliases).some((n) => heard.includes(n))) {
          console.log(`[wake] enricher fallback SKIPPED, no name (conf ${e.conf.toFixed(2)}): ${e.directive || e.transcript}`);
          return;
        }
        const s2 = session(e.dockId);
        if (s2.conversation().mode !== 'idle') return; // already engaged
        console.log(`[wake] audio-enricher fallback FIRED (conf ${e.conf.toFixed(2)}): ${e.directive || e.transcript}`);
        s2.wake(cfg.prompt);
        // stamp the enricher record that triggered this wake so its row shows 🤖 woke-the-robot.
        markEnrichWoke(e.dockId, e.transcript);
      });

      getGateApi()?.onRaise((t) => {
        // dedup same-kind raises via t.key (e.g. 'arrival:guru'); recording guard inside.
        raiseSelfThought(t.dockId, t.text, { key: t.key, ttlMs: 30_000, via: `gate:${t.key}` });
      });

      // ADDRESSED TRANSCRIPT → TURN (A1.2, always-on-mic shift). The server STT
      // hears EVERY utterance; a dock tap marks intent ("talking TO me"). Per dock
      // we hold an addressed latch (tapped by the `addressed` agent frame below);
      // when a final utterance qualifies (overlaps/follows the tap), it becomes a
      // user turn-request. The latch clears at sentence-end (one tap → one turn).
      // Overheard (un-tapped) speech is ignored here — only the attention gate may
      // act on it (A1.5). See addressed.ts for the pure correlation + tests.
      // BUSY QUEUE: addressed utterances that arrive while the dock is mid-turn
      // (THINKING/SPEAKING) are NOT auto-superseded (that let ambient speech abort the
      // dock's own reply — see the guard below). Instead we ACCUMULATE every utterance
      // heard during the reply and run them TOGETHER as one combined turn when the
      // dock's speech lane SETTLES (the session's onSettled hook — fires for EVERY
      // turn kind, including wake/task/self; the old per-branch `.then(drain)` missed
      // all but one and its re-entry design could never answer anything — the
      // busy-queue black hole, docs/findings/2026-07-13-busy-queue-black-hole.md).
      // Contract (WI-1): every queued utterance either runs at the next settle or is
      // traced `skip:stale` — zero silent outcomes. Staleness is judged PER ITEM
      // (its own endedAt), so an old ghost can't poison a fresh follow-up.
      type AddressedFinal = HeardUtterance;
      const busyQueue = new BusyQueue();
      const BUSY_QUEUE_MAX_AGE_MS = 20_000; // per-ITEM age cap at drain time
      // drain-side trace: same ring as the addressed decisions, so a queued
      // utterance's TERMINAL outcome (drain:ran / skip:stale) is always visible.
      const pushAddrTrace = (u: AddressedFinal, decision: string, mode: string) => {
        addrTrace.push({ at: Date.now(), dock: u.dockId, text: u.text, tier: u.confTier ?? '?',
          avgLogprob: u.avgLogprob, noSpeechProb: u.noSpeechProb, compressionRatio: u.compressionRatio,
          decision, mode, startedAt: u.startedAt, endedAt: u.endedAt });
        if (addrTrace.length > 50) addrTrace.shift();
      };
      // The drain: called from the session's onSettled (lane quiet, any turn kind).
      // Runs the survivors DIRECTLY via handleTurnRequest — never back through
      // onAddressedFinal: the addressed/grace window check would reject a by-now-
      // seconds-old batch (Addendum 2's second kill mechanism) and mis-stamp it
      // as overheard.
      drainBusy = (dock) => {
        const items = busyQueue.take(dock);
        if (items.length === 0) return;
        const s = session(dock);
        const mode = s.conversation().mode;
        // RECORDING re-check (code review): the skip:recording gate only ran at
        // ENQUEUE time — a capture that started while the reply played must not
        // get a spoken drained turn. Drop WITH trace (recording wants silence,
        // not a deferred answer).
        if (isRecording(dock)) {
          for (const u of items) pushAddrTrace(u, 'skip:recording', mode);
          return;
        }
        // HOLD: 'listening' = the user is mid-exchange (e.g. tap-interrupt — their
        // next utterance wins; the queue joins the turn after); an active turn
        // (thinking/speaking or turnActive) = draining now would supersede it.
        // Items go back intact and re-evaluate at the next settle — where the
        // per-item staleness below still bounds their lifetime, WITH a trace.
        if (s.turnActive || mode !== 'idle' && mode !== 'followup') {
          busyQueue.putBack(dock, items);
          return;
        }
        const { fresh, stale } = splitByAge(items, Date.now(), BUSY_QUEUE_MAX_AGE_MS);
        for (const u of stale) pushAddrTrace(u, 'skip:stale', mode);
        if (fresh.length === 0) return;
        for (const u of fresh) {
          pushAddrTrace(u, 'drain:ran', mode);
          // queued speech that runs WAS addressed — stamp it for the recall record.
          markSpeechAddressed(dock, u.endedAt, true);
        }
        const newest = fresh[fresh.length - 1]!;
        void s.handleTurnRequest({
          turnId: `addr-${randomUUID()}`,
          // via 'busy-drain': heard DURING the reply, not deliberately addressed
          // — same possibly-overheard framing as the followup window.
          trigger: { kind: 'user', text: fresh.map((u) => u.text).join(' '), via: 'busy-drain' }, // in order, nothing lost
          stationOriginated: true,
          stt: { confTier: newest.confTier, avgLogprob: newest.avgLogprob,
            noSpeechProb: newest.noSpeechProb, compressionRatio: newest.compressionRatio },
        }).catch((err) => console.error(`[brain] ${dock}: drained busy-queue turn crashed`, err));
      };
      // A finalized utterance → ask the dock's conversation state if it's ADDRESSED
      // (an open listening/followup window); if so, run it as a turn. The addressed
      // decision now lives in the session's ConversationState (single owner) — no
      // separate latch Map. Overheard utterances are ignored here (still transcribed
      // upstream; the attention gate may act on them later).
      const onAddressedFinal = (t: AddressedFinal) => {
        // DIAG (kept, disabled): confirms a transcript reached the brain. Re-enable
        // if "STT shown but no turn" recurs.
        // DIAG (kept, disabled): confirms a transcript reached the brain. Re-enable
        // if "STT shown but no turn" recurs.
        // console.log(`[brain] onAddressedFinal RECEIVED: dock=${t.dockId} text="${t.text.slice(0,40)}" started=${t.startedAt} ended=${t.endedAt}`);
        // snapshot the conversation state BEFORE any decision consumes the window.
        const preLastWin = session(t.dockId).convLastWindowUntil(); // BEFORE snapshot prunes
        const pre = session(t.dockId).conversation();
        const trace = (decision: string) => {
          addrTrace.push({ at: Date.now(), dock: t.dockId, text: t.text, tier: t.confTier ?? '?',
            avgLogprob: t.avgLogprob, noSpeechProb: t.noSpeechProb, compressionRatio: t.compressionRatio,
            decision, mode: pre.mode, windowUntil: pre.windowUntil, msToExpiry: pre.msToExpiry,
            lastWindowUntil: preLastWin, startedAt: t.startedAt, endedAt: t.endedAt });
          if (addrTrace.length > 50) addrTrace.shift();
          // STAMP the addressed decision onto the speech snapshot (docs/TODO.md §3.0), so the
          // summarizer / fact-extraction / ego can tell "said to the dock" from room chatter.
          // ran-a-turn / wake ⇒ addressed; explicitly not-addressed ⇒ overheard. Ambiguous skips
          // (garbage/no-words/recording/busy-queue) are left unstamped — not a clean signal.
          if (decision === 'RAN-TURN' || decision === 'wake' || decision === 'wake+command'
              || decision === 'stop:cancel') {
            markSpeechAddressed(t.dockId, t.endedAt, true);
          } else if (decision === 'skip:not-addressed') {
            markSpeechAddressed(t.dockId, t.endedAt, false);
          }
        };
        // RECORDING MODE: while this dock is being recorded for the capture harness,
        // the dock must NOT respond (we want clean ambient perception). The mic/cam
        // keep capturing + transcribing upstream; we just don't turn it into a reply.
        if (isRecording(t.dockId)) { trace('skip:recording'); return; }
        // WAKE (conductor's `wakeUp` behaviour): when the dock is NOT in a listening window
        // and this utterance matches the wake phrase, WAKE — open listening + speak the prompt
        // — and consume the utterance (it was just "hey orbit", not a turn). Governed by the
        // conductor via setWakeConfig (enabled/phrase/prompt); off by default until armed.
        if (wakeCfg.get(t.dockId)?.enabled && !session(t.dockId).isListening()) {
          const w = wakeCfg.get(t.dockId)!;
          if (matchesWake(t.text, w.phrase, w.aliases)) {
            // WAKE + COMMAND in one breath ("hey orbit, look to your right"): strip the wake
            // phrase and run the REMAINDER as a real addressed turn — no "did you call me?"
            // deflection (which would drop the command). Bare wake ("hey orbit") → command is
            // empty → fall through to wake()'s ack + open-window. Reuse the <2-alphanumerics
            // content check so a trailing "!" / "orbit?" doesn't count as a command.
            const command = stripWake(t.text, w.phrase, w.aliases);
            if (command.replace(/[^a-z0-9]/gi, '').length >= 2) {
              console.log(`[wake] ${t.dockId} FIRED-WITH-COMMAND on "${t.text}" → turn "${command}" (phrase="${w.phrase}", tier=${t.confTier ?? '?'})`);
              trace('wake+command');
              session(t.dockId).tapOpen(); // open the listening window (adopt), same as wake()
              void session(t.dockId).handleTurnRequest({
                turnId: `addr-${randomUUID()}`,
                trigger: { kind: 'user', text: command },
                stationOriginated: true,
                stt: { confTier: t.confTier, avgLogprob: t.avgLogprob, noSpeechProb: t.noSpeechProb,
                  compressionRatio: t.compressionRatio },
              }).catch((err) => console.error(`[brain] ${t.dockId}: wake+command turn crashed`, err));
              return;
            }
            console.log(`[wake] ${t.dockId} FIRED on "${t.text}" (phrase="${w.phrase}", tier=${t.confTier ?? '?'})`);
            trace('wake');
            session(t.dockId).wake(w.prompt);
            return;
          }
          // INSTRUMENT near-misses: an idle utterance whose first few words CONTAIN an accepted
          // name/soundalike (or the bare name anywhere) but didn't wake — so renderings we don't
          // yet accept, or that landed buried mid-sentence, are visible (observe, don't theorize).
          const lc = t.text.toLowerCase();
          const near = nameAliases(w.phrase, w.aliases).find((n) => lc.includes(n));
          if (near) {
            console.log(`[wake] ${t.dockId} near-miss (no wake, saw "${near}") on "${t.text}" (phrase="${w.phrase}", tier=${t.confTier ?? '?'})`);
          }
        }
        // GARBAGE STT: a far-field-mush / repetition-loop transcript must not become a
        // confident agent turn (we'd reply to words that were never said). The snapshot
        // is still kept (tagged) upstream; we just don't act on it. Shaky still runs —
        // a quiet "yes"/"ok" you addressed should work.
        if (t.confTier === 'garbage') { trace('skip:garbage'); return; }
        // CONTENT-FREE backstop: a transcript with no real words ("!", ".", "?!") must
        // never run a turn even if it slips the upstream filter (observed: a lone "!"
        // → the dock replied). <2 alphanumerics = no words.
        if (t.text.replace(/[^a-z0-9]/gi, '').length < 2) { trace('skip:no-words'); return; }
        // REFLEX VOICE-STOP / DISMISSAL (WI-2 + Addendum 5.1): a bare "stop" /
        // "never mind" / "shut up" / "I'm not talking to you" heard in ANY
        // engaged mode stands the dock DOWN: aborts the active turn (the only
        // voice path that can stop a move), closes every window — NO listening
        // window (dismissed ≠ tap-interrupt: leave me alone), clears the busy
        // queue (traced skip:dismissed so nothing drains after), → idle.
        // Re-engage via tap/palm/wake. Deliberately narrow (stop-intent.ts):
        // content sentences are handled normally. Kill-switch: brainVoiceStop=false.
        if (pre.mode !== 'idle' && w.config('brainVoiceStop') !== false) {
          const stop = classifyStopIntent(t.text);
          if (stop === 'dismiss') {
            trace('stop:dismiss');
            for (const u of busyQueue.take(t.dockId)) pushAddrTrace(u, 'skip:dismissed', pre.mode);
            session(t.dockId).dismiss();
            return;
          }
          // PAUSE ("wait" / "hold on"): shut up and LISTEN — abort the reply and
          // open a listening window (the spoken tap-interrupt); the busy queue is
          // KEPT (they're mid-exchange; it drains at the next settle).
          if (stop === 'pause') {
            trace('stop:pause');
            session(t.dockId).tapOpen();
            return;
          }
        }
        // BUSY QUEUE: don't let a heard utterance auto-start a turn while the dock is
        // already mid-turn (THINKING/SPEAKING). handleTurnRequest has supersede
        // semantics — a new addressed turn ABORTS the active reply and runs the new one.
        // That's the right behaviour for a deliberate barge-in (a TAP, which routes
        // through tap()/tapWouldInterrupt and explicitly cancels), but NOT for ambient
        // speech: observed live (docs trace) the dock interrupted its OWN reply with
        // stray room audio — "look around" then "I don't know" each superseded the last,
        // and a bare "And" ran a turn. So we ACCUMULATE everything heard during the reply
        // and run it as one combined turn when the reply finishes (below). A tap can still
        // interrupt. Use the PRE snapshot (mode before utteranceAddressed() consumes it).
        if (pre.mode === 'thinking' || pre.mode === 'speaking') {
          busyQueue.add(t);
          trace('queue:busy');
          return;
        }
        if (!session(t.dockId).utteranceAddressed(t.endedAt, Date.now(), t.startedAt)) { trace('skip:not-addressed'); return; }
        trace('RAN-TURN');
        void session(t.dockId).handleTurnRequest({
          turnId: `addr-${randomUUID()}`,
          // via 'followup-window': heard in the auto re-listen window, NOT via a
          // deliberate signal (tap/palm/wake open 'listening', not 'followup') —
          // the brain frames these as possibly-overheard and may stay silent,
          // which mechanically ends the followup chain (no reply → no window).
          trigger: pre.mode === 'followup'
            ? { kind: 'user', text: t.text, via: 'followup-window' }
            : { kind: 'user', text: t.text },
          stationOriginated: true, // A1.2: the phone must ADOPT this (it didn't start it)
          // STT confidence → observability turn trace (why this heard utterance ran).
          stt: { confTier: t.confTier, avgLogprob: t.avgLogprob, noSpeechProb: t.noSpeechProb,
            compressionRatio: t.compressionRatio },
        }).catch((err) => console.error(`[brain] ${t.dockId}: addressed turn crashed`, err));
        // (busy-queue drain: no longer here — the session's onSettled hook drains
        // for EVERY turn kind when the speech lane goes quiet; see drainBusy above.)
      };
      // Debug self-test: tap (open the window) then feed a final utterance → a turn
      // always fires. Drives the REAL addressed→turn→adopt path with NO live mic.
      injectAddressed = (dock, text) => {
        session(dock).tap();
        onAddressedFinal({ dockId: dock, text, startedAt: Date.now(), endedAt: Date.now() });
      };
      // No tap: exactly what a live mic final looks like to the brain.
      injectHeard = (t) => { onAddressedFinal(t); };
      getTranscriptApi()?.onFinal((t) => { onAddressedFinal(t); });
      // LIVE INTERIMS (caption UI): the gate — produce interims ONLY while the dock is
      // in a listening/followup turn (bounds GPU cost to active turns, not ambient
      // speech). The handler forwards each partial as a directed caption frame. Both
      // are cosmetic: interims never start or alter a turn (that's onAddressedFinal).
      getTranscriptApi()?.setListeningResolver((dock) => session(dock).isListening());
      getTranscriptApi()?.onInterim((t) => { session(t.dockId).sendInterim(t.text, t.seq); });

      bus.on('agent', (msg) => {
        if (msg.source === 'station') return;
        const dock = dockOf(msg.source);
        if (!dock) {
          bus.publish({
            topic: 'agent', kind: 'error',
            payload: { message: 'agent frames need a dock identity (hello.dock)' },
            source: 'station', to: msg.source,
          });
          return;
        }
        const p = msg.payload as Record<string, unknown> | null;
        switch (msg.kind) {
          case 'hello':
            // A (re)connecting phone → reconcile conversation state to idle (clears
            // anything a frame lost across a disconnect would have wedged), then
            // re-send the current mode so the phone (a pure renderer with no state
            // of its own) shows the right thing immediately.
            session(dock).notePhoneConnected();
            session(dock).resendConversation();
            // The deterministic half of the resync handshake: the peer-joined
            // push below can RACE the peer's subscribe frame (both arrive
            // back-to-back; the directed reply fans out before the topic
            // registration lands) — so the phone also says hello on the agent
            // topic AFTER subscribing, and this reply can't miss.
            bus.publish({
              topic: 'agent', kind: 'brain-status',
              payload: { ready: true, activeTurnId: null, sessionId: store.openSession(dock)?.sessionId ?? null },
              source: 'station', to: msg.source,
            });
            pushTaskDigest(dock); // seed the app's running-tasks view on connect
            break;
          case 'transcript':
            if (p?.isFinal !== true) session(dock).preWarm();
            break;
          case 'turn-request':
            void session(dock).handleTurnRequest(p as unknown as TurnRequest).catch((err) => {
              console.error(`[brain] ${dock}: turn crashed`, err);
            });
            break;
          case 'addressed': {
            // A tap — TOGGLE the dock's addressed listening window (D1). Stamped
            // with the STATION clock so the utterance correlation (also station
            // clock) is skew-free. Tap on = open window; tap again = close it.
            // EXCEPT openOnly (the PALM gesture): address open-only, never toggle
            // off — a palm always means "listen to me". Fixes palm-during-speaking
            // racing speaking→followup and landing as tap-off → idle → dropped.
            if ((p as { openOnly?: boolean } | null)?.openOnly) session(dock).tapOpen();
            else session(dock).tap();
            // TRANSPARENCY: the user is trying to talk. If the dock is in a known
            // broken condition (e.g. the STT sidecar is down so it's deaf), tell
            // it the real reason now so it can speak it — instead of silently
            // failing to hear (core/conditions.ts, generic ambient-error channel).
            const cond = dockConditions.current(dock);
            if (cond) {
              bus.publish({
                topic: 'agent', kind: 'dock-error',
                payload: { code: cond.code, message: cond.message },
                source: 'station', toAddr: { dock, component: 'phone' },
              });
            }
            break;
          }
          case 'vad':
            // VAD edge from the phone — active=true HOLDS the window open (no ceiling
            // while talking), active=false (a real silence end) releases to a short
            // endpoint. Default true for old phones that only sent on speech onset.
            session(dock).vadActivity(p?.active !== false);
            break;
          case 'face-arrival': {
            // a NEW face in view → low-priority listen (station decides; yields to
            // an active tap/followup).
            session(dock).faceArrival();
            // LONG-ABSENCE GREETING: if it's been a while since anyone was last in
            // front of this dock, proactively greet (a self-thought turn; the LLM
            // uses its perception grounding/identity to name them if known). Not on
            // every walk-up — only after a real gap. Coalesced so a flicker of
            // arrivals doesn't stack greetings.
            const nowMs = Date.now();
            const prev = lastFaceArrival.get(dock);
            lastFaceArrival.set(dock, nowMs);
            if (prev != null && nowMs - prev >= GREET_ABSENCE_MS) {
              // recording guard rides in raiseSelfThought (this path previously lacked it).
              raiseSelfThought(dock,
                '[Someone just came into view after a long absence. If you recognise them, greet them warmly by name and note it\'s been a while; otherwise a friendly hello. Keep it to one short sentence.]',
                { key: 'greet-arrival', ttlMs: 30_000, idPrefix: 'greet', via: 'greet-arrival' });
            }
            break;
          }
          case 'face-left':
            // a face left → release ONLY a face listen window (never a tap/followup).
            session(dock).faceLeft();
            break;
          case 'turn-cancel':
            session(dock).cancel(typeof p?.turnId === 'string' ? p.turnId : undefined);
            break;
          case 'speech-status':
            session(dock).noteSpeech(p?.speaking === true);
            // A1.2 echo-gate: tell the STT processor to drop audio while our TTS
            // plays, so the station doesn't transcribe the dock's own voice.
            getTranscriptApi()?.setSpeaking(dock, p?.speaking === true);
            break;
          // 'tool-result' is consumed by the RpcBroker's own subscription
          default:
            break;
        }
      });

      // task processes publish on the `tasks` topic; route each frame to the
      // supervisor (scoped to the sender's dock via its hello, never the payload).
      bus.on('tasks', (msg) => {
        if (msg.source === 'station') return; // our own init/input/stop frames
        const dock = dockOf(msg.source);
        if (!dock) return;
        const p = (msg.payload ?? {}) as Record<string, unknown>;
        const instanceId = typeof p.instanceId === 'string' ? p.instanceId : '';
        if (!instanceId) return;
        // capability requests are served by the broker (dispatch + reply); all other
        // frames (status/notify/finish/…) go to the supervisor.
        if (msg.kind === 'request') { void capBroker.handle(dock, instanceId, p); return; }
        supervisor.onFrame(dock, { instanceId, kind: msg.kind, payload: p });
      });

      // resync handshake + turn-abort on voice-component connectivity
      bus.on('station', (msg) => {
        if (msg.source !== 'station') return;
        const p = msg.payload as { id?: string; dock?: string; caps?: string[]; component?: string } | null;
        if (!p?.dock) return;
        if (msg.kind === 'peer-joined' && (p.caps ?? []).includes('voice')) {
          // PRESENCE session (§3.0): the phone (voice component) appearing IS the
          // session boundary — open/resume one now so self-initiated things (the
          // conductor's faceFollow task, future proactive turns) have a session to
          // attach to without waiting for the user to speak. Gated on the `voice`
          // cap so the ESP32 body / browser joining does NOT open a session.
          session(p.dock).ensurePresenceSession();
          // best-effort (may race the peer's subscribe — the agent/hello
          // handler above is the guaranteed path)
          bus.publish({
            topic: 'agent', kind: 'brain-status',
            payload: { ready: true, activeTurnId: null },
            source: 'station', to: p.id,
          });
        }
        if (msg.kind === 'peer-left') {
          const s = sessions.get(p.dock);
          if (!s) return;
          // A TASK peer (component "task:<id>") leaving is NOT the dock going
          // offline — a reminder's own task process disconnecting must NOT cancel
          // the autonomous turn it just triggered (this silently killed every
          // reminder: TURNEND cancelled, empty reply). Only a real dock component
          // (phone/body) loss matters here.
          if (p.component?.startsWith('task:')) return;
          // any component loss aborts in-flight tool RPCs for safety; voice
          // loss kills the turn itself (the conversation has no mouth).
          rpc.rejectAllForDock(p.dock, 'dock component went offline');
          s.onDockOffline();
          // PHONE (face) offline → STAND DOWN: kill every running task on the dock except
          // bgTask ones (reminders survive so they still fire after you walk away). Without
          // this the body kept moving with the phone gone — a conductor task (idle-moods /
          // face-follow) animating an empty room, since the body stayed online and nothing
          // tore the tasks down. Conductor tasks ALSO get force-off via reconcile's
          // phone-presence gate; this catches brain/user-launched ones too, immediately.
          if (p.component === 'phone') {
            const killed = supervisor.stopAllForDock(p.dock);
            if (killed.length) console.log(`[brain] ${p.dock}: phone offline → stopped ${killed.length} task(s): ${killed.join(', ')}`);
          }
        }
      });

      const sweep = setInterval(() => {
        for (const s of sessions.values()) s.maybeIdleClose();
      }, IDLE_SWEEP_MS);
      sweep.unref?.();

      // FAILPROOF task-digest: re-push the running-tasks view to every live dock on
      // a short cadence, so the app HUD self-corrects if any single push was missed
      // (a task that started/stopped without a signal, a dropped frame, etc.). Cheap
      // (a small directed frame per active dock; skipped when nothing's running and
      // nothing changed is not worth tracking — just send it).
      const digestSweep = setInterval(() => {
        for (const dock of sessions.keys()) pushTaskDigest(dock);
      }, DIGEST_SWEEP_MS);
      digestSweep.unref?.();
    },

    async route(ctx: RouteContext) {
      const { req, res, subPath } = ctx;
      if (req.method === 'GET' && subPath === '/docks') {
        const lanes = [...sessions.values()].map((s) => ({
          dock: s.dock, sessionId: s.sessionId ?? null,
          turnActive: s.turnActive, lastTurnEndedAt: s.lastTurnEndedAt,
          state: s.state(), // 2c: attention state (idle/listening/speaking/thinking)
          inflightToolCalls: rpc.inflight(s.dock),
        }));
        json(res, 200, lanes);
        return true;
      }
      // which API key the brain will use for the current model (name + set/unset
      // + the paid fallback) — surfaced in the console so the active key is
      // never a mystery.
      if (req.method === 'GET' && subPath === '/keystatus') {
        const model = typeof w.config('brainModel') === 'string' ? (w.config('brainModel') as string) : '';
        json(res, 200, keyStatusFor(model, w.config('brainAlwaysPaid') === true));
        return true;
      }
      // the dock's full brain CONTEXT in one call: effective config, key status,
      // live composition, memory (latest summary), skills, and the system
      // prompt the brain would actually send right now. Powers the Brain view's
      // "dock console" — everything about THIS dock's brain in context.
      const pm = subPath.match(/^\/([^/]+)\/profile$/);
      if (pm && req.method === 'GET') {
        const dock = decodeURIComponent(pm[1]!);
        // enrich with the LIVE session's attention state (idle/listening/speaking/
        // thinking) + the grounding block, for the console's 2c test surface. The
        // session may not exist yet (lazy) → 'idle' + whatever grounding exists.
        const live = sessions.get(dock);
        void buildDockProfile(dock, w, store).then((p) => json(res, 200, {
          ...p,
          state: live?.state() ?? 'idle',
          listening: live?.isListening() ?? false,
          grounding: getPerceptionGrounding()?.forDock(dock) ?? null,
        }));
        return true;
      }
      // ── 2c DEBUG: toggle the stubbed `listening` state (user mid-utterance) so the
      // console can exercise the thought-defer path by hand. No real mic signal yet
      // (Phase A1); this is the test seam. POST /:dock/listening {listening:bool}
      const lm = subPath.match(/^\/([^/]+)\/listening$/);
      if (lm && req.method === 'POST') {
        const dock = decodeURIComponent(lm[1]!);
        const body = JSON.parse((await readBody(req)) || '{}') as { listening?: boolean };
        session(dock).setListening(body.listening === true);
        json(res, 200, { ok: true, listening: body.listening === true });
        return true;
      }
      // GET /:dock/conversation — the live conversation state probe (the primary
      // testability hook: { mode, windowUntil, speakUntil, msToExpiry }).
      const cm = subPath.match(/^\/([^/]+)\/conversation$/);
      if (cm && req.method === 'GET') {
        json(res, 200, session(decodeURIComponent(cm[1]!)).conversation());
        return true;
      }
      // TEMP DIAGNOSTIC: GET /:dock/debug/addressed — recent addressed-decisions ring.
      const am = subPath.match(/^\/([^/]+)\/debug\/addressed$/);
      if (am && req.method === 'GET') {
        const dock = decodeURIComponent(am[1]!);
        json(res, 200, addrTrace.filter((e) => e.dock === dock));
        return true;
      }
      let m = subPath.match(/^\/([^/]+)\/sessions$/);
      if (m && req.method === 'GET') {
        json(res, 200, store.sessions(decodeURIComponent(m[1]!)));
        return true;
      }
      m = subPath.match(/^\/([^/]+)\/history$/);
      if (m && req.method === 'GET') {
        const dock = decodeURIComponent(m[1]!);
        const open = store.openSession(dock);
        json(res, 200, open ? store.messages(dock, open.sessionId) : []);
        return true;
      }
      m = subPath.match(/^\/([^/]+)\/session\/end$/);
      if (m && req.method === 'POST') {
        const dock = decodeURIComponent(m[1]!);
        sessions.get(dock)?.endSession('console');
        json(res, 200, { ok: true });
        return true;
      }
      // ── internal THOUGHT poke (docs/perception-to-brain.md Phase 1) ──────────
      // Inject a self-originated thought into the dock's session — the test seam
      // for internal-thought routing before the real attention gate exists. The
      // thought runs the SAME autonomous-turn lane as a task (user turns still
      // win), but with trigger.kind:'self' so the prompt frames it as the robot's
      // own observation. `text` is the thought; later this comes from the live
      // perception summary instead of the request body.
      m = subPath.match(/^\/([^/]+)\/think$/);
      if (m && req.method === 'POST') {
        const dock = decodeURIComponent(m[1]!);
        const body = JSON.parse((await readBody(req)) || '{}') as { text?: string; ttlMs?: number; kind?: string };
        const text = typeof body.text === 'string' ? body.text.trim() : '';
        if (!text) { json(res, 400, { error: 'body.text (the thought) is required' }); return true; }
        const ttl = typeof body.ttlMs === 'number' && body.ttlMs > 0 ? body.ttlMs : 30_000;
        // coalesce by thought KIND (default 'self:test') so a newer thought of the
        // same kind replaces a stale pending one, but different kinds don't clobber.
        const kind = typeof body.kind === 'string' && body.kind ? body.kind : 'test';
        // recording guard rides in raiseSelfThought (a test poke must not speak mid-recording).
        raiseSelfThought(dock, text, { key: `self:${kind}`, ttlMs: ttl, via: `console:${kind}` });
        json(res, 200, { ok: true });
        return true;
      }
      // ── debug: simulate an ADDRESSED utterance (A1.2 self-test, no live mic) ──
      // POST /:dock/debug/say {text} → taps the latch + feeds `text` as a final
      // transcript, driving the real addressed→turn→adopt path. Lets the loop be
      // tested end-to-end (incl. the phone adopting the station-originated turn)
      // without anyone speaking. The dock will reply through DockTts as usual.
      m = subPath.match(/^\/([^/]+)\/debug\/say$/);
      if (m && req.method === 'POST') {
        const dock = decodeURIComponent(m[1]!);
        const body = JSON.parse((await readBody(req)) || '{}') as { text?: string };
        const text = typeof body.text === 'string' ? body.text.trim() : '';
        if (!text) { json(res, 400, { error: 'body.text (the utterance) is required' }); return true; }
        injectAddressed(dock, text);
        json(res, 200, { ok: true, injected: text });
        return true;
      }
      // ── debug: simulate a HEARD utterance, NO tap (WI-0 mid-turn harness) ──
      // POST /:dock/debug/hear {text, [startedAt], [endedAt], [confTier]} → feeds
      // the final straight into the addressed decision, exactly like a live STT
      // final. While the dock is busy this exercises the busy queue (which
      // debug/say cannot: its tap interrupts). Response echoes the decision
      // context so a scenario driver can assert without a second round-trip.
      m = subPath.match(/^\/([^/]+)\/debug\/hear$/);
      if (m && req.method === 'POST') {
        const dock = decodeURIComponent(m[1]!);
        const b = JSON.parse((await readBody(req)) || '{}') as
          { text?: string; startedAt?: number; endedAt?: number; confTier?: string };
        const text = typeof b.text === 'string' ? b.text.trim() : '';
        if (!text) { json(res, 400, { error: 'body.text (the utterance) is required' }); return true; }
        const endedAt = typeof b.endedAt === 'number' ? b.endedAt : Date.now();
        const startedAt = typeof b.startedAt === 'number' ? b.startedAt : endedAt - 1_500;
        injectHeard({ dockId: dock, text, startedAt, endedAt, confTier: b.confTier });
        json(res, 200, { ok: true, injected: text, conversation: session(dock).conversation() });
        return true;
      }
      // POST /:dock/debug/event {event, [endedAt], [text]} — inject a RAW
      // conversation event to drive any flow headless (no mic):
      //   tap | vad | tts-start | tts-end | connected | utterance{text,endedAt}
      // utterance runs the addressed path (→ a turn if a window is open).
      m = subPath.match(/^\/([^/]+)\/debug\/event$/);
      if (m && req.method === 'POST') {
        const dock = decodeURIComponent(m[1]!);
        const b = JSON.parse((await readBody(req)) || '{}') as { event?: string; text?: string; endedAt?: number };
        const s = session(dock);
        switch (b.event) {
          case 'tap': s.tap(); break;
          case 'vad': s.vadActivity(); break;
          case 'face-arrival': s.faceArrival(); break;
          case 'face-left': s.faceLeft(); break;
          case 'tts-start': s.noteSpeech(true); break;
          case 'tts-end': s.noteSpeech(false); break;
          case 'connected': s.notePhoneConnected(); break;
          case 'utterance': {
            const endedAt = typeof b.endedAt === 'number' ? b.endedAt : Date.now();
            const addressed = s.utteranceAddressed(endedAt);
            if (addressed && b.text) {
              void s.handleTurnRequest({ turnId: `addr-${randomUUID()}`, trigger: { kind: 'user', text: b.text.trim() }, stationOriginated: true })
                .catch((err) => console.error(`[brain] ${dock}: debug utterance turn crashed`, err));
            }
            json(res, 200, { ok: true, addressed, conversation: s.conversation() });
            return true;
          }
          default: json(res, 400, { error: 'event must be tap|vad|face-arrival|face-left|tts-start|tts-end|connected|utterance' }); return true;
        }
        json(res, 200, { ok: true, conversation: s.conversation() });
        return true;
      }
      // delete a specific session (transcript + index entry). Refuses the
      // currently-open one; the obs trace is dropped via the obs DELETE route.
      m = subPath.match(/^\/([^/]+)\/session\/([^/]+)$/);
      if (m && req.method === 'DELETE') {
        const dock = decodeURIComponent(m[1]!);
        const sid = decodeURIComponent(m[2]!);
        const r = store.delete(dock, sid);
        json(res, r === 'deleted' ? 200 : r === 'open' ? 409 : 404, { ok: r === 'deleted', reason: r });
        return true;
      }
      // Export a session as pi-harness-compatible v3 JSONL (openable with
      // `pi --session <file>`). Downloads as <sessionId>.jsonl.
      m = subPath.match(/^\/([^/]+)\/session\/([^/]+)\/dump$/);
      if (m && req.method === 'GET') {
        const dock = decodeURIComponent(m[1]!);
        const sid = decodeURIComponent(m[2]!);
        const jsonl = store.dumpJsonl(dock, sid);
        res.writeHead(200, {
          'content-type': 'application/x-ndjson; charset=utf-8',
          'content-disposition': `attachment; filename="${sid}.jsonl"`,
        });
        res.end(jsonl);
        return true;
      }
      m = subPath.match(/^\/([^/]+)\/session\/([^/]+)\/resume$/);
      if (m && req.method === 'POST') {
        // session(dock) (not sessions.get): the lane may not exist yet after
        // a station restart — resuming must still work.
        const ok = session(decodeURIComponent(m[1]!)).resume(decodeURIComponent(m[2]!));
        json(res, ok ? 200 : 404, { ok });
        return true;
      }
      // ── skills (docs/decision-traces/server-brain-selfmod.md §1a) — per-dock install/list/remove.
      // The dock's NEXT session picks up an installed skill (loaded per turn).
      m = subPath.match(/^\/([^/]+)\/skills$/);
      if (m && req.method === 'GET') {
        json(res, 200, await listDockSkills(store.root, decodeURIComponent(m[1]!)));
        return true;
      }
      if (m && req.method === 'POST') {
        const dock = decodeURIComponent(m[1]!);
        try {
          const body = JSON.parse(await readBody(req)) as { content?: string };
          if (typeof body.content !== 'string' || body.content.trim().length === 0) {
            json(res, 400, { error: 'body.content (the SKILL.md text) is required' });
            return true;
          }
          const name = await installDockSkill(store.root, dock, body.content);
          json(res, 200, { ok: true, name });
        } catch (err) {
          json(res, 400, { error: String(err instanceof Error ? err.message : err) });
        }
        return true;
      }
      m = subPath.match(/^\/([^/]+)\/skills\/([^/]+)$/);
      if (m && req.method === 'DELETE') {
        const ok = await removeDockSkill(store.root, decodeURIComponent(m[1]!), decodeURIComponent(m[2]!));
        json(res, ok ? 200 : 404, { ok });
        return true;
      }

      // ── tasks (docs/tasks.md §8) ───────────────────────────────────────
      // definitions (shared, by name)
      if (req.method === 'GET' && subPath === '/tasks') {
        const defs = await loadAllTaskDefs(taskRoots);
        json(res, 200, defs.map((d) => ({ name: d.name, description: d.description, params: d.manifest.params ?? [], goal: d.goal, source: d.source })));
        return true;
      }
      m = subPath.match(/^\/tasks\/([^/]+)$/);
      if (m && req.method === 'GET') {
        try {
          const def = await findTaskDef(taskRoots, decodeURIComponent(m[1]!));
          json(res, 200, { name: def.name, description: def.description, manifest: def.manifest, goal: def.goal, source: def.source });
        } catch (err) { json(res, 404, { error: String(err) }); }
        return true;
      }
      // instances (dock-scoped, by id)
      m = subPath.match(/^\/([^/]+)\/instances$/);
      if (m && req.method === 'GET') {
        json(res, 200, supervisor.list(decodeURIComponent(m[1]!)));
        return true;
      }
      if (m && req.method === 'POST') {
        const dock = decodeURIComponent(m[1]!);
        const body = JSON.parse((await readBody(req)) || '{}') as { name?: string; params?: Record<string, unknown> };
        try {
          const parent = store.openSession(dock)?.sessionId;
          if (!parent) { json(res, 409, { error: 'no open session for this dock' }); return true; }
          const def = await findTaskDef(taskRoots, body.name ?? '');
          const v = validateParams(def.manifest, body.params ?? {});
          if (!v.ok) { json(res, 400, { error: v.errors.join('; ') }); return true; }
          const id = supervisor.start({ dock, name: def.name, filePath: def.filePath, params: v.values, parentSessionId: parent });
          pushTaskDigest(dock); // immediate HUD update on start (the sweep is the backstop)
          json(res, 200, { instanceId: id });
        } catch (err) { json(res, 400, { error: String(err) }); }
        return true;
      }
      // resolve an instance ONLY if it belongs to the dock in the path — REST is
      // dock-scoped like the WS path, so dockA can't touch dockB's tasks by id.
      const inDock = (pathDock: string, id: string) => {
        const info = supervisor.get(id);
        return info && info.dock === decodeURIComponent(pathDock) ? info : undefined;
      };
      m = subPath.match(/^\/([^/]+)\/instances\/([^/]+)$/);
      if (m && req.method === 'GET') {
        const id = decodeURIComponent(m[2]!);
        const info = inDock(m[1]!, id);
        if (!info) { json(res, 404, { error: 'no such instance' }); return true; }
        json(res, 200, { ...info, status: supervisor.status(id), log: supervisor.logTail(id) });
        return true;
      }
      m = subPath.match(/^\/([^/]+)\/instances\/([^/]+)\/(status|logs)$/);
      if (m && req.method === 'GET') {
        const id = decodeURIComponent(m[2]!);
        if (!inDock(m[1]!, id)) { json(res, 404, { error: 'no such instance' }); return true; }
        json(res, 200, m[3] === 'status' ? { status: supervisor.status(id) } : { log: supervisor.logTail(id) });
        return true;
      }
      // the task's OWN source (read-only) — so the console can inspect how a
      // running instance actually works. Path comes from the supervisor's record
      // of THIS instance (never the request), so it can't read arbitrary files.
      m = subPath.match(/^\/([^/]+)\/instances\/([^/]+)\/source$/);
      if (m && req.method === 'GET') {
        const id = decodeURIComponent(m[2]!);
        const info = inDock(m[1]!, id);
        if (!info) { json(res, 404, { error: 'no such instance' }); return true; }
        try { json(res, 200, { filePath: info.filePath, source: readFileSync(info.filePath, 'utf8') }); }
        catch (err) { json(res, 404, { error: String(err) }); }
        return true;
      }
      m = subPath.match(/^\/([^/]+)\/instances\/([^/]+)\/(pause|resume|stop|restart)$/);
      if (m && req.method === 'POST') {
        const id = decodeURIComponent(m[2]!);
        if (!inDock(m[1]!, id)) { json(res, 404, { ok: false }); return true; }
        const op = m[3]!;
        const ok = op === 'restart' ? !!(await supervisor.restart(id)) : supervisor[op as 'pause' | 'resume' | 'stop'](id);
        json(res, ok ? 200 : 404, { ok });
        return true;
      }
      m = subPath.match(/^\/([^/]+)\/instances\/([^/]+)\/input$/);
      if (m && req.method === 'POST') {
        const id = decodeURIComponent(m[2]!);
        if (!inDock(m[1]!, id)) { json(res, 404, { ok: false }); return true; }
        const body = JSON.parse((await readBody(req)) || '{}') as { answer?: string };
        const ok = supervisor.provideInput(id, body.answer ?? '');
        json(res, ok ? 200 : 404, { ok });
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

/**
 * The dock's full brain context in one payload — the "dock console" data:
 * effective config, key status, live composition, memory (latest closed
 * session's summary), skills, and the SYSTEM PROMPT the brain would send right
 * now (assembled exactly as a turn would, minus the live per-turn perception).
 */
async function buildDockProfile(dock: string, w: BrainWiring, store: SessionStore) {
  const cfg = (k: string) => w.config(k);
  const str = (k: string) => (typeof cfg(k) === 'string' ? (cfg(k) as string) : '');
  const model = str('brainModel');

  // skills (per-dock folder) + the prompt block they contribute
  let skills: Awaited<ReturnType<typeof loadDockSkills>> = { skills: [], promptBlock: '' };
  try { skills = await loadDockSkills(store.root, dock); } catch { /* none */ }

  // memory = the latest CLOSED session's summary (what seeds a fresh session)
  const sessions = store.sessions(dock);
  const memory = sessions.find((s) => s.closedAt != null && s.summary)?.summary;

  // live composition (voice/face/camera/servo presence)
  const info = w.directory.dockInfo(dock);
  const fileAccess = cfg('brainFileAccess') === true;
  const bodyLine = w.directory.resolveCap(dock, 'servo') != null
    ? 'Body: CONNECTED. Parts you can move — neck (head tilt), foot (base swivel); use the move tool.'
    : 'Body: NOT connected (movement requests will be ignored).';

  // the effective system prompt, assembled as a real turn would (sans the live
  // perception snapshot, which only exists mid-turn).
  const systemPrompt = buildSystemPrompt({
    persona: str('brainPersona') || undefined,
    memory,
    skills: [skills.promptBlock, fileAccess ? FILE_TOOLS_PROMPT : ''].filter(Boolean).join('\n\n') || undefined,
    context: bodyLine,
    // the live grounding the dock would inject right now (so the console preview
    // matches a real turn). Best-effort — undefined on a cold dock.
    grounding: getPerceptionGrounding()?.forDock(dock),
  });

  const grantsAll = cfg('brainGrants') as Record<string, unknown> | undefined;

  return {
    dock,
    config: {
      brainModel: model,
      brainPersona: str('brainPersona'),
      brainThinkingLevel: str('brainThinkingLevel') || 'off',
      brainTurnTimeoutMs: typeof cfg('brainTurnTimeoutMs') === 'number' ? cfg('brainTurnTimeoutMs') : 60_000,
      brainSkills: cfg('brainSkills') !== false,
      brainFileAccess: fileAccess,
      brainAlwaysPaid: cfg('brainAlwaysPaid') === true,
      brainGrants: (grantsAll && typeof grantsAll === 'object' ? (grantsAll as Record<string, unknown>)[dock] : undefined) ?? {},
    },
    key: keyStatusFor(model, cfg('brainAlwaysPaid') === true),
    composition: {
      components: info.components.map((c) => ({
        component: c.component, kind: c.kind, caps: c.caps, online: c.online, build: c.build,
      })),
    },
    memory: memory ?? null,
    skills: skills.skills.map((s) => ({ name: s.name, description: s.description })),
    sessionCount: sessions.length,
    openSession: sessions.find((s) => s.closedAt == null)?.sessionId ?? null,
    systemPrompt,
  };
}

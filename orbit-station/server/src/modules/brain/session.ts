/**
 * DockBrainSession — one dock's brain lane (docs/decision-traces/server-brain-impl.md §3.1).
 *
 * Owns the pi Agent, the turn lifecycle, history hygiene, and the wire
 * conversation with the phone (speak frames, turn-status) — a 1:1 port of
 * the battle-tested semantics in the app's DockAgent.kt:
 *
 *   - SUPERSEDE: a new turn-request aborts the active turn and AWAITS the
 *     full unwind before prompting (pi's Agent is one-run-at-a-time; racing
 *     the reset gets "busy" rejections — the cancelAndJoin race, observed
 *     live on the phone).
 *   - sanitizeHistory() before every prompt: synthetic "(interrupted)"
 *     results for unanswered tool calls + cap trim at a user-message
 *     boundary. Without it every post-interruption turn 400s on
 *     OpenAI-style endpoints.
 *   - Trailing-clause flush ONLY on normal completion — a cancelled or
 *     timed-out turn must not leak its half-sentence into the next turn's
 *     TTS queue.
 *   - Softened failure: if the turn already spoke or ran a tool before a
 *     later step died, the phone speaks "lost my train of thought", not
 *     "couldn't reach my model" — the action happened.
 *   - Turn start cancels any leftover gesture (motion.stop = stopBody port).
 *
 * SESSION lifecycle (§3.0): opened lazily on the first turn, closed on idle
 * timeout or explicit end (summary persisted), decoupled from connections —
 * an app restart or hardware swap continues the same session.
 */

import { randomUUID } from 'node:crypto';
import {
  Agent,
  type AgentEvent,
  type AgentMessage,
} from '@earendil-works/pi-agent-core';
import {
  getModel,
  streamSimple,
  type AssistantMessage,
  type ImageContent,
  type Model,
  type TextContent,
  type ToolCall,
  type ToolResultMessage,
} from '@earendil-works/pi-ai';
import type { Bus } from '../../core/bus.js';
import { dockConditions } from '../../core/conditions.js';
import type { Directory } from '../docks/directory.js';
import type { MotionExecutor } from '../bodylink/motion.js';
import type { FaceToolsApi, PerceptionGroundingApi, MemoryApi } from '../perception/index.js';
import { gesturesFromConfig } from '../bodylink/motion.js';
import { buildSystemPrompt, isVisionIntent, MOOD_TAG_RE, stripMoodTag } from './prompt.js';
import { decideThought, type SessionState } from './thought-router.js';
import { ConversationState, type ConvTransition } from './conversation-state.js';
import { MAX_HISTORY_MESSAGES, SESSION_IDLE_MIN, VISION_GATE } from './constants.js';
import { RpcBroker } from './rpc.js';
import { SentenceStreamer } from './sentence.js';
import { SessionStore, type SessionMeta } from './store.js';
import { loadDockSkills, type DockSkills } from './skills.js';
import { buildFileTools, FILE_TOOLS_PROMPT } from './filetools.js';
import { buildDockTools, buildGrantTools, buildSlackTools, buildWhatsAppTools, buildResearchTools, buildMemoryTools, buildFeedbackTools, buildObsTools, fireFace, type ToolTurnContext } from './tools.js';
import { FACES, type MoveStep } from './schemas.js';
import type { VideoRecorderApi } from '../perception/record/recorder.js';
import * as slack from '../../integrations/slack.js';

/** How long an autonomous (task) turn waits before running, so back-to-back
 *  same-instance signals (notify+finish) coalesce into one turn. Tiny vs. the
 *  settle gap + the model turn; imperceptible for delivery. */
const COALESCE_WINDOW_MS = 60;
/** How often to tick the conversation state while in a timed mode, so window/speak
 *  expiries emit their transition promptly (phone beep-off/idle on time). */
const CONV_TICK_MS = 500;

export interface TurnRequest {
  turnId: string;
  /** `via` = WHICH source raised a non-user trigger (a mood bit id, a gate raise key,
   *  the greet, the console poke) — provenance surfaced in the observability trace. */
  trigger: { kind: string; text: string; via?: string };
  context?: { state?: string; battery?: number };
  imageBase64?: string;
  imageMime?: string;
  /** for autonomous (task) turns: drop the turn if it can't start before this
   *  wall-clock (stale news is not spoken — docs/tasks.md §7a). */
  expiresAt?: number;
  /** A1.2: this turn was STARTED BY THE STATION (not the phone) even though its
   *  trigger.kind is 'user' (an addressed always-on-mic utterance). The phone must
   *  ADOPT it (autonomous:true) so its speak frames aren't dropped as stale — it
   *  never set currentTurnId locally. Distinct from trigger.kind, which still
   *  frames the prompt as a user utterance. */
  stationOriginated?: boolean;
  /** STT confidence for an addressed (heard) turn — surfaced in observability so the
   *  trace shows WHY a heard utterance was trusted/flagged (Whisper's own metrics). */
  stt?: { confTier?: string; avgLogprob?: number | null; noSpeechProb?: number | null; compressionRatio?: number | null };
}

export interface SessionDeps {
  bus: Bus;
  directory: Directory;
  rpc: RpcBroker;
  motion: MotionExecutor;
  store: SessionStore;
  getFaces: () => FaceToolsApi | undefined;
  /** perception grounding (docs/perception-to-brain.md 3.1): the per-turn context
   *  block (last summary + raw-since), pulled synchronously and injected into the
   *  prompt. Undefined → no perception grounding (the dock behaves as before). */
  getGrounding?: () => PerceptionGroundingApi | undefined;
  /** the dock's unified memory facade (recall/inspect/remember/update/forget tools).
   *  Undefined → memory tools not offered. */
  getMemory?: () => MemoryApi | undefined;
  /** the dock's current EGO document (docs/decision-traces/ego.md) — its evolving inner
   *  self, injected each turn as WHO IS SPEAKING so it can feel/answer from a real inner
   *  life. Undefined → no ego injected (the dock speaks as before). */
  getSelf?: (dock: string) => string | undefined;
  /** live video recorder (record_video tool). Undefined → tool not offered. */
  recordVideo?: VideoRecorderApi;
  /** effective config value by key (shared ConfigStore). */
  config: (key: string) => unknown;
  log?: (line: string) => void;
  /** the dock's speech lane went QUIET — the whole user-perceived turn is over:
   *  either the TTS tail drained after the loop closed (the TurnSettled moment),
   *  or a turn completed without ever speaking. The busy-queue drain hangs off
   *  this (WI-1, busy-queue-black-hole.md Addendum 3): it fires for EVERY turn
   *  kind (user/wake/task/self — the old per-branch `.then(drain)` missed all
   *  but one, the ghost class). NOT fired for cancelled/superseded turns: a
   *  tap-interrupt means the user is about to speak (the queue holds; it drains
   *  at the interrupting turn's settle). */
  onSettled?: (dock: string) => void;
  /** test seam: scripted LLM transport (pi StreamFn). Default: pi-ai providers. */
  streamFn?: import('@earendil-works/pi-agent-core').StreamFn;
  /** stop every task instance running under a parent conversational session
   *  (the lifetime cascade — tasks §5). Set by the brain module; the
   *  supervisor is the source of truth for what's running. */
  stopTasksForParent?: (dock: string, parentSessionId: string) => void;
  /** does this conversational session have any running tasks? (idle-close guard
   *  — tasks §5: a task keeps its parent session alive). */
  hasRunningTasks?: (dock: string, parentSessionId: string) => boolean;
  /** the dock's model-facing task tools, built per-turn with the live session id
   *  as the parent (tasks §6). Undefined → tasks disabled / not wired. */
  getTaskTools?: (dock: string, parentSessionId: () => string | undefined) => import('@earendil-works/pi-agent-core').AgentTool<any>[];
  /** SNAPSHOT per-session context (provenance/config/models/perception/…) onto
   *  the observability session record. Called on each turn end so EVERY session
   *  is instrumented (observability is the source of truth). Undefined → skip. */
  enrichSession?: (dock: string, sessionId: string, span?: { from: number; to: number }) => Promise<void> | void;
  /** called when a SELF-thought turn actually SPOKE (dock, the spoken text) — the
   *  coherence feedback loop pairs it with the next minute's perceived reaction. */
  onSelfRemark?: (dock: string, text: string) => void;
  /** feedback capture entrypoint (record_feedback tool). Undefined → tool off. */
  feedbackCapture?: import('./tools.js').FeedbackCaptureFn;
  /** observability read access (inspect_observability tool). Undefined → tool off. */
  obs?: import('./tools.js').ObsToolApi;
}

type FailCode = 'timeout' | 'llm_error' | 'busy';

/** Presence-session resume gate (§3.0): should `ensurePresenceSession` RESUME
 *  the dock's most-recent session (vs. open a fresh one) when the phone (re)appears?
 *  Yes iff it's closed AND its last turn ended within the idle window — a brief
 *  drop / app restart continues the same engagement; a long absence starts anew.
 *  Pure so the boundary is unit-tested without a full DockBrainSession. */
export function resumableOnPresence(recent: SessionMeta | undefined, now: number): recent is SessionMeta {
  return !!recent && recent.closedAt != null
    // a CONSOLE close is a human's explicit boundary — presence must not undo it
    // (WI-5: observed live, `session/end` was resumed ~2s later by the presence
    // path, making a fresh session impossible while the phone was connected).
    // Records without closedBy (pre-field) stay resumable, as before.
    && recent.closedBy !== 'console'
    && now - recent.lastTurnEndedAt <= SESSION_IDLE_MIN * 60_000;
}

export class DockBrainSession {
  readonly dock: string;
  #d: SessionDeps;

  #agent?: Agent;
  #meta?: SessionMeta;
  // paid-key selection for google: true = use GEMINI_API_KEY_PAID_ACC. Set by
  // the always-paid config, or latched mid-turn when the free key hits a
  // quota/overload and we retry on the paid one.
  #usePaidKey = false;

  // "Approve all" for code/file mutations: latched when the user taps it on a
  // confirm dialog; auto-approves subsequent mutations for the rest of THIS
  // session (re-arms on close). Session-scoped, not persisted.
  #approveAllMutations = false;
  // per-dock skills (pi progressive disclosure), reloaded each turn so a
  // freshly-installed SKILL.md applies next-turn with no session restart.
  #skills: DockSkills = { skills: [], promptBlock: '' };

  // the in-flight turn's FULL lifecycle promise (#runTurn incl. finally) and
  // the newest request — supersede ordering (see handleTurnRequest).
  #running?: Promise<void>;
  #latestReq?: TurnRequest;

  // autonomous (task) turn queue — station-originated turns injected into the
  // same lane (docs/tasks.md §7a). User turns always win: the drain loop only
  // ever starts a task turn in a FREE lane, and a user turn supersedes a running
  // one via the normal handleTurnRequest path.
  #autoQueue: (TurnRequest & { expiresAt?: number; coalesceKey?: string })[] = [];
  #autoDrainTimer: ReturnType<typeof setTimeout> | undefined;
  #draining = false;

  // ── conversation state (the SINGLE owner — docs/findings/conversation-state-*) ─
  // idle/listening/thinking/speaking/followup + the addressed decision, in one
  // place. tap/utterance/vad/tts/connect events drive it; state() + the addressed
  // correlation read it. Replaces the old #speaking/#listening flags + the external
  // addressedLatch Map. A transition callback emits obs + drives the phone renderer.
  #conv = new ConversationState((t) => this.#onConvTransition(t));
  #convTick?: ReturnType<typeof setInterval>; // ticks while in a timed conv mode

  // ── per-turn state (reset in #runTurn) ────────────────────────────────────
  #activeTurnId?: string;
  #triggerText = '';
  #triggerKind = 'user';
  /** the sentences actually SPOKEN this turn (for the self-remark feedback loop). */
  #spokenSentences: string[] = [];
  #triggerVia: string | undefined; // the raising source (mood bit / gate key / …) — obs only
  // A1.2: a station-originated user turn (an addressed always-on-mic utterance) —
  // the phone must adopt it even though its trigger.kind is 'user'.
  #stationOriginated = false;
  #cancelled = false;
  #timedOut = false;
  #spokeThisTurn = false;
  // Inline mood tag (WI-3): a leading [face:NAME] in the reply text sets the
  // face WITHOUT a separate LLM step. Per-STEP parse state (each pi step
  // streams a fresh assistant message) + a per-TURN applied latch.
  #moodStepChecked = false; // this step's leading text has been classified
  #moodStripLen = 0;        // chars to strip from this step's cumulative text
  #moodApplied = false;     // face already set this turn (first tag wins)
  #moodEnabled = true;      // brainInlineMood, snapshot per turn (config() is a
                            // registry scan — not per streaming delta)
  #moodHeldRaw: string | null = null; // text HELD while a leading '[' may still
                            // become a tag — released as prose at step end if it
                            // never resolves (else '[thinks' = silent dead air)
  #toolRanThisTurn = false;
  #streamer = new SentenceStreamer();
  #speakSeq = 0;
  #obsSeq = 0;
  #obsTurnId = '';
  #shippedStreamStart = false;
  #turnCtx: ToolTurnContext = { turnId: '' };
  #turnActive = false;
  // debug-stream timing (the console's turn inspector — kind 'brain-debug' on obs)
  #turnStartedAt = 0;
  #stepIndex = -1;
  #stepStartedAt = 0;
  #stepTtft: number | undefined;
  /** wall-clock of the step's first thinking / first answer-text token —
   *  thinkingMs = the span between them (the model's reasoning phase). */
  #stepThinkAt: number | undefined;
  #stepTextAt: number | undefined;
  #toolStarts = new Map<string, number>();

  constructor(dock: string, deps: SessionDeps) {
    this.dock = dock;
    this.#d = deps;
    this.#baseTools = buildDockTools({
      dock,
      rpc: deps.rpc,
      motion: deps.motion,
      getFaces: deps.getFaces,
      getGrounding: deps.getGrounding,
      getGestures: () => gesturesFromConfig(deps.config('faceGestures')) as Record<string, MoveStep[]>,
      getTurnContext: () => this.#turnCtx,
      recordVideo: deps.recordVideo
        ? {
            record: (streamId, seconds) => deps.recordVideo!.record(streamId, seconds),
            onClipReady: (info) => { void this.#onClipReady(info); },
          }
        : undefined,
    });
  }

  /** A record_video clip finished: upload it to Slack (if asked / configured) and
   *  surface it back on the dock as an autonomous follow-up turn. Off the turn that
   *  started it — record_video returned immediately. Best-effort. */
  async #onClipReady(info: { path: string; caption?: string; slackChannel?: string }): Promise<void> {
    const channel = info.slackChannel ?? slack.slackDefaultChannel();
    let slackNote = '';
    if (slack.slackEnabled() && channel) {
      try {
        await slack.uploadFile({
          channel, filePath: info.path, title: info.caption, initialComment: info.caption,
        });
        slackNote = ` and sent it to Slack`;
      } catch (err) {
        this.#d.log?.(`[brain] ${this.dock}: clip Slack upload failed: ${String(err)}`);
        slackNote = ` but couldn't send it to Slack`;
      }
    }
    this.enqueueAutonomousTurn({
      turnId: `auto-${randomUUID()}`,
      trigger: { kind: 'task', text: `[your video clip is ready${slackNote}${info.caption ? `: ${info.caption}` : ''}] Tell the user the recording is done.` },
      expiresAt: Date.now() + 120_000,
    });
  }

  readonly #baseTools: ReturnType<typeof buildDockTools>;

  /** This dock's cross-dock grants from the `brainGrants` config json:
   *  { <thisDock>: { <targetDock>: [caps…] } } → the inner map. */
  #grants(): Record<string, string[]> {
    const all = this.#d.config('brainGrants') as Record<string, Record<string, string[]>> | undefined;
    const mine = all?.[this.dock];
    return mine && typeof mine === 'object' ? mine : {};
  }

  /** Load this dock's skills (gated by `brainSkills` config, default on).
   *  Non-fatal: any error → no skills, dock behaves as before. */
  async #loadSkills(): Promise<DockSkills> {
    if (this.#d.config('brainSkills') === false) return { skills: [], promptBlock: '' };
    try {
      return await loadDockSkills(this.#d.store.root, this.dock);
    } catch (err) {
      this.#d.log?.(`[brain] ${this.dock}: skill load failed (ignored): ${String(err)}`);
      return { skills: [], promptBlock: '' };
    }
  }

  get sessionId(): string | undefined {
    return this.#meta?.sessionId;
  }
  get turnActive(): boolean {
    return this.#turnActive;
  }
  get lastTurnEndedAt(): number {
    return this.#meta?.lastTurnEndedAt ?? 0;
  }

  /**
   * The coarse session state the attention gate routes on (2.2). Priority order
   * matches "who wins": a running turn (`thinking`) outranks everything; then our
   * own TTS (`speaking`); then a user mid-utterance (`listening`, stubbed today);
   * else `idle`. A self-thought/task never barges a turn that's already in flight.
   */
  state(): SessionState {
    // a running turn is the authoritative "thinking" (the real execution lane);
    // otherwise the conversation state machine owns it.
    if (this.#running || this.#turnActive) return 'thinking';
    const m = this.#conv.mode(Date.now());
    // ConvMode 'followup' maps to 'listening' for the thought-router (both are
    // open addressed windows it must defer behind).
    if (m === 'speaking') return 'speaking';
    if (m === 'listening' || m === 'followup') return 'listening';
    return 'idle';
  }

  /** Live conversation snapshot (the GET /:dock/conversation probe). */
  conversation(): ReturnType<ConversationState['snapshot']> {
    return this.#conv.snapshot(Date.now());
  }

  /** TEMP DIAGNOSTIC: the long-utterance grace horizon (#lastWindowUntil). */
  convLastWindowUntil(): number { return this.#conv.lastWindowUntil; }

  // ── conversation events (the single state machine) ─────────────────────────

  /** User tapped — TOGGLE the listening window (D1), or INTERRUPT an in-flight
   *  reply (tap-to-interrupt): a tap while thinking/speaking aborts the active turn
   *  (stops TTS) and opens a fresh listening window so the user can speak again. */
  tap(now = Date.now()): void {
    const interrupts = this.#conv.tapWouldInterrupt(now);
    this.#conv.tap(now);
    if (interrupts) this.#interruptSpeech(); // abort the interrupted reply (or its TTS tail)
  }

  /** Abort whatever is AUDIBLY in flight: the active turn (agent + motion +
   *  frames), or — after the loop already ended — the phone's still-draining
   *  TTS queue. cancel() early-returns when no turn is active, so post-turn
   *  interrupts (the common case: TTS plays after turn end) previously sent NO
   *  signal and the dock talked to the end of its buffer (live 2026-07-13).
   *  The bare `cancelled` frame makes the phone silence (app build 31+; older
   *  builds ignore it — no worse than before). */
  #interruptSpeech(): void {
    if (this.#turnActive) this.cancel();
    else this.#sendToVoice('cancelled', { turnId: '' });
  }

  /** ADDRESS open-only (the palm gesture) — never toggles listening off. Like
   *  {@link tap} it interrupts an in-flight reply, but it always leaves the dock
   *  LISTENING (fixes the palm-during-speaking → followup → tap-off → dropped
   *  utterance bug). */
  tapOpen(now = Date.now()): void {
    const interrupts = this.#conv.tapWouldInterrupt(now);
    this.#conv.tapOpen(now);
    if (interrupts) this.#interruptSpeech(); // abort the interrupted reply (or its TTS tail)
  }

  /** WAKE (conductor `wakeUp` behaviour): the wake phrase was heard while idle. Open the
   *  listening window AND acknowledge with a short spoken prompt ("did you call me?"), so the
   *  user knows the dock is now listening.
   *
   *  WI-4 (busy-queue-black-hole.md): the ack is a CANNED utterance through the
   *  standard frame envelope — no LLM. It used to be an autonomous turn asking the
   *  model to echo a constant: 6–7s of step time and ~20k input tokens billed per
   *  "did you call me?" — and the autonomous lane DEFERS while listening (the
   *  thought gate), so the ack was additionally gated behind the very window the
   *  wake just opened. Canned is safe even mid-wake-supersede: tapOpen has already
   *  cancelled the dying turn (the phone silences + drops its straggler frames by
   *  turnId once it adopts the canned turn). */
  wake(prompt: string, now = Date.now()): void {
    this.tapOpen(now); // open the listening window first so the follow-up utterance is addressed
    this.speakCanned(prompt);
  }

  /** Speak a short canned line through the standard turn envelope WITHOUT an
   *  LLM run: minted turnId, the same three frames a real autonomous turn ships
   *  — `accepted` (+`autonomous:true`, which makes the phone ADOPT the turn so
   *  the speak passes its turnId gate — RemoteBrain.onTurnStatus), the `speak`,
   *  and `done`. No agent, no transcript message, no per-step obs. */
  speakCanned(text: string): void {
    const turnId = `canned-${randomUUID()}`;
    this.#sendToVoice('turn-status', { turnId, state: 'accepted', autonomous: true });
    this.#sendToVoice('speak', { turnId, seq: 0, text });
    this.#sendToVoice('turn-status', { turnId, state: 'done' });
  }

  /** Spoken dismissal ("stop" / "shut up" / "not talking to you"): abort any
   *  active turn and stand DOWN to idle — no listening window (unlike
   *  tap-interrupt, where the user wants to speak next). The →idle transition
   *  fires the settle chokepoint; the caller clears the busy queue first so
   *  nothing drains after a dismissal. */
  dismiss(now = Date.now()): void {
    this.#interruptSpeech();
    this.#conv.dismiss(now);
  }

  /** VAD activity from the phone — extends an open listening/followup window. */
  vadActivity(active = true, now = Date.now()): void { this.#conv.vadActivity(now, active); }

  /** A new face arrived in the dock's camera (low-priority listen). */
  faceArrival(now = Date.now()): void { this.#conv.faceArrival(now); }

  /** A face left the camera (releases only a low-priority face listen window —
   *  never a tap/follow-up). */
  faceLeft(now = Date.now()): void { this.#conv.faceLeft(now); }

  /** Re-send the current conversation mode (e.g. to a (re)connecting phone, which
   *  is a pure renderer with no state of its own). */
  resendConversation(): void {
    const m = this.#conv.mode(Date.now());
    try { this.#sendToVoice('conversation', { from: m, to: m, reason: 'resync', at: Date.now() }); }
    catch { /* transport optional */ }
  }

  /**
   * A finalized utterance ended at `endedAt`. Returns whether it's ADDRESSED (the
   * caller then runs a turn). Folds in the old addressedLatch — "are we in an open
   * listening window?" IS the decision.
   */
  utteranceAddressed(endedAt: number, now = Date.now(), startedAt?: number): boolean {
    return this.#conv.utteranceEnded(endedAt, now, startedAt);
  }

  /** Back-compat shim for the console 2c surface + tests. */
  setListening(listening: boolean): void {
    if (listening) this.#conv.tap(Date.now());
    else this.#conv.reconcileConnected(Date.now());
  }
  isListening(): boolean { return this.#conv.isListening(Date.now()); }

  /** Pre-warm on streamed transcript partials: open/load the session and
   *  resolve the profile so the LLM call fires the instant the final lands. */
  preWarm(): void {
    try {
      this.#ensureSession();
    } catch (err) {
      this.#d.log?.(`[brain] ${this.dock}: pre-warm failed: ${String(err)}`);
    }
  }

  /** Handle a turn-request (supersede semantics included). */
  async handleTurnRequest(req: TurnRequest): Promise<void> {
    // SUPERSEDE: abort the active run, then wait for the WHOLE previous
    // #runTurn — including its `finally` — to unwind before prompting.
    // Waiting only for the agent to go idle (the old code) raced our own
    // cleanup: the superseded turn's finally ran AFTER the new turn had
    // started and clobbered #activeTurnId, so every speak frame of the new
    // turn shipped with a dead turnId and the phone dropped the entire
    // reply (caught live on the emulator: two rapid utterances → second
    // turn "done" but silent).
    this.#latestReq = req;
    const prev = this.#running;
    if (prev) {
      this.#cancelled = true;
      this.#agent?.abort();
    }
    const run = (async () => {
      if (prev) {
        try { await prev; } catch { /* unwound */ }
      }
      if (this.#latestReq !== req) return; // superseded while still queued
      await this.#runTurn(req);
    })();
    this.#running = run;
    try {
      await run;
    } finally {
      if (this.#running === run) this.#running = undefined;
    }
  }

  /** Inject a station-originated (task) turn into this dock's lane. The turn only
   *  ever STARTS in a free lane and is superseded by any user turn exactly like a
   *  normal turn — users are never starved (docs/tasks.md §7a). */
  enqueueAutonomousTurn(req: TurnRequest & { expiresAt?: number; coalesceKey?: string }): void {
    // COALESCE: a task often emits a notify then a finish ~0ms apart (the reminder,
    // then "reminded"). Two back-to-back autonomous turns make the 2nd supersede the
    // 1st before TTS plays, AND read as redundant. If a not-yet-run turn with the
    // same coalesceKey (the instanceId) is still queued, MERGE the new text into it
    // — keeping BOTH messages (finish may carry critical info) in one turn.
    if (req.coalesceKey) {
      const pending = this.#autoQueue.find((q) => q.coalesceKey === req.coalesceKey);
      if (pending) {
        const a = pending.trigger.text.trim();
        const b = req.trigger.text.trim();
        if (b && !a.includes(b)) pending.trigger.text = a ? `${a}\n${b}` : b;
        if (req.imageBase64 && !pending.imageBase64) pending.imageBase64 = req.imageBase64;
        if (req.expiresAt) pending.expiresAt = req.expiresAt;
        return; // the deferred drain (scheduled when `pending` was enqueued) runs it
      }
    }
    if (this.#autoQueue.length >= 4) this.#autoQueue.shift(); // drop oldest, bounded
    this.#autoQueue.push(req);
    // Defer the drain a short COALESCING WINDOW so a notify immediately followed by
    // a finish (same instance, ~ms apart) both land in the queue and merge above,
    // rather than the notify starting before the finish arrives. Negligible delay
    // for delivery; the gap is dwarfed by the settle gap + the model turn itself.
    if (this.#autoDrainTimer == null) {
      this.#autoDrainTimer = setTimeout(() => { this.#autoDrainTimer = undefined; void this.#drainAuto(); }, COALESCE_WINDOW_MS);
      this.#autoDrainTimer.unref?.();
    }
  }

  async #drainAuto(): Promise<void> {
    if (this.#draining) return;
    this.#draining = true;
    try {
      while (this.#autoQueue.length > 0) {
        // user priority: wait for the WHOLE current chain (incl. queued user
        // supersede closures) to settle before even consulting the gate — a
        // running turn is a promise we can await, not a flag we poll.
        while (this.#running) { try { await this.#running; } catch { /* unwound */ } }

        const settle = num(this.#d.config('brainTaskSettleMs'), 1500);
        // The PURE gate (docs/perception-to-brain.md 2.2) decides run/defer/drop
        // from state + staleness + the settle gap. It reads the HEAD of the queue
        // (peek, not shift) so a deferred turn stays queued for the next pass.
        const head = this.#autoQueue[0]!;
        const decision = decideThought({
          state: this.state(),
          now: Date.now(),
          expiresAt: head.expiresAt,
          lastTurnEndedAt: this.lastTurnEndedAt,
          settleMs: settle,
        });
        if (decision === 'drop') {
          this.#autoQueue.shift(); // stale news — discard, never spoken
          this.#d.log?.(`[brain] ${this.dock}: ${head.trigger.kind} turn dropped (stale)`);
          continue;
        }
        if (decision === 'defer') {
          // BUSY (speaking/listening) or within the settle gap → hold and re-poll.
          // (`thinking` is already handled by the while(#running) await above; this
          // covers the flag-based states that clear via external events.) For now a
          // deferred thought is simply re-evaluated next pass — if it goes stale
          // meanwhile, the next decision drops it (the doc's "log+drop" first cut).
          await sleep(250);
          continue;
        }
        const req = this.#autoQueue.shift()!;
        // NO await between the while(#running) exit and assigning #running below:
        // on the single-threaded loop a user request cannot slot into the gap.
        const run = this.#runTurn(req);
        this.#running = run; // ← a user turn-request can now supersede it normally
        try { await run; } catch { /* logged in #runTurn */ }
        finally { if (this.#running === run) this.#running = undefined; }
      }
    } finally {
      this.#draining = false;
    }
  }

  /** Tap-to-stop. The phone has already silenced TTS locally; this stops
   *  generation + actuation. Idempotent; unknown turnIds are ignored. */
  cancel(turnId?: string): void {
    if (!this.#turnActive) return;
    if (turnId != null && turnId !== this.#activeTurnId) return;
    this.#cancelled = true;
    this.#d.motion.stop(this.dock);
    this.#d.rpc.rejectAllForDock(this.dock, 'turn cancelled');
    this.#agent?.abort();
    this.#sendToVoice('cancelled', { turnId: this.#activeTurnId });
  }

  /** The dock's voice component went offline: the turn dies (visibly), the
   *  session survives. */
  onDockOffline(): void {
    if (!this.#turnActive) return;
    this.#cancelled = true;
    this.#d.motion.stop(this.dock);
    this.#d.rpc.rejectAllForDock(this.dock, 'dock went offline');
    this.#agent?.abort();
  }

  /** Phone TTS start/drain markers → obs SpeakStart/SpeakEnd (+ TurnSettled
   *  when the TTS tail drains after the loop closed — the end of the whole
   *  user-perceived turn). */
  noteSpeech(speaking: boolean): void {
    // TTS start/end drives the conversation state machine: speaking → SPEAKING;
    // end → FOLLOWUP (auto re-listen). The machine bounds SPEAKING (SPEAK_MAX_MS)
    // so a lost end-frame can't wedge it, and reconcileConnected clears it on
    // reconnect — the two real recoveries (no blind latch).
    const wasSpeaking = this.#conv.mode(Date.now()) === 'speaking';
    if (speaking) this.#conv.speakStart(Date.now());
    else this.#conv.speakEnd(Date.now());
    this.#shipObsMarker(speaking ? 'SpeakStart' : 'SpeakEnd');
    if (!speaking && !this.#turnActive) {
      this.#shipObsMarker('TurnSettled');
      // Normally speakEnd's speaking→followup transition fires the settle
      // chokepoint. When tts-start was LOST (mode never reached 'speaking'),
      // speakEnd no-ops and no transition fires — settle directly instead.
      if (!wasSpeaking) this.#maybeSettle();
    }
  }

  /** The phone (re)connected → reconcile the conversation state to idle. A fresh
   *  phone has no in-flight speech/listening; this clears anything a lost frame
   *  across a disconnect would otherwise have wedged (the stuck-speaking bug). */
  notePhoneConnected(): void {
    this.#conv.reconcileConnected(Date.now());
  }

  /** PRESENCE session (§3.0): the app being open IS the session boundary — an
   *  open app with no session is a meaningless state, and self-initiated things
   *  (the conductor's faceFollow task, a future Slack/proactive turn) need a
   *  session to attach to WITHOUT waiting for the user to speak first. So on
   *  phone connect we make a session exist:
   *    • already open → keep it;
   *    • a recent session still within the idle window → RESUME it (transcript +
   *      context intact — a brief drop / app restart doesn't fragment it);
   *    • else → open fresh.
   *  Idempotent + non-destructive: it never closes anything, so it can't kill a
   *  turn or a task. Close stays as-is (idle sweep / explicit end) — decoupling
   *  task lifetime from the session is tracked separately (TODO, §3.0). */
  ensurePresenceSession(now = Date.now()): void {
    // idle boundary may have lapsed while we slept → let the normal close run first.
    this.maybeIdleClose(now);
    if (this.#d.store.openSession(this.dock)) return; // already present
    // most-recent closed session still inside the idle window → resume it.
    const recent = this.#d.store.sessions(this.dock)[0];
    if (resumableOnPresence(recent, now) && this.#d.store.reopen(this.dock, recent!.sessionId)) {
      this.#meta = this.#d.store.openSession(this.dock);
      this.#agent = undefined; // next turn lazy-loads this transcript
      this.#d.log?.(`[brain] ${this.dock}: presence resumed session ${recent.sessionId}`);
      return;
    }
    const meta = this.#d.store.open(this.dock);
    this.#meta = meta;
    this.#agent = undefined;
    this.#d.log?.(`[brain] ${this.dock}: presence opened session ${meta.sessionId}`);
  }

  /** Emit a conversation transition on the obs stream (for tests + the phone
   *  renderer) + a structured log line. */
  #onConvTransition(t: ConvTransition): void {
    this.#d.log?.(`[conv] ${this.dock} ${t.from}->${t.to} (${t.reason})`);
    // a directed agent frame to the phone (the renderer reads it for face/beeps).
    // windowUntil = absolute epoch ms the listening/followup window closes (0 when not
    // timed) — the phone renders a live countdown from it, so a screenshot shows WHETHER
    // it's listening AND how long is left (debugging the "UI says listening but no reply").
    const snap = this.#conv.snapshot(t.at);
    try {
      this.#sendToVoice('conversation', {
        from: t.from, to: t.to, reason: t.reason, at: t.at, windowUntil: snap.windowUntil,
      });
    } catch { /* transport optional in tests */ }
    // Drive the tick only while in a TIMED mode (listening/followup/speaking), so
    // a window/speak expiry fires its transition promptly (the phone gets beep-off
    // / idle on time, not only at the next incoming event). Stop when idle/thinking
    // (no pending expiry) — no idle timer.
    const timed = t.to === 'listening' || t.to === 'followup' || t.to === 'speaking';
    if (timed && !this.#convTick) {
      this.#convTick = setInterval(() => this.#conv.tick(Date.now()), CONV_TICK_MS);
      this.#convTick.unref?.();
    } else if (!timed && this.#convTick) {
      clearInterval(this.#convTick); this.#convTick = undefined;
    }
    // SETTLE CHOKEPOINT (code review on WI-1: the two ad-hoc settle call sites
    // missed failed-silent turns and every passive window expiry). "The lane
    // went quiet" IS a conversation transition: entering FOLLOWUP (tts tail
    // drained) or IDLE (no-speech settle, window-timeout, tap-off, reconcile,
    // think/speak safety prunes). Firing here makes the busy-queue drain follow
    // the state machine instead of hand-picked branches. #maybeSettle re-checks
    // in-flight turns; the drain no-ops on an empty queue — over-firing is
    // harmless, under-firing is a black hole.
    if (t.to === 'followup' || t.to === 'idle') this.#maybeSettle();
  }

  /** The single quiet-check before onSettled: never settle under a running or
   *  in-flight turn (a drained turn would supersede it). */
  #maybeSettle(): void {
    if (this.#turnActive || this.#running) return;
    this.#d.onSettled?.(this.dock);
  }

  /** Idle-close check (clock measured from last turn END — an active turn
   *  always resets it, so closing mid-turn is impossible by construction).
   *  A session with RUNNING TASKS is NOT idle-closed (tasks §5): the task
   *  keeps it alive, so a reminder/watcher set just before the user went quiet
   *  isn't silently killed by the idle sweep. */
  maybeIdleClose(now = Date.now()): void {
    if (!this.#meta || this.#turnActive) return;
    if (this.#d.hasRunningTasks?.(this.dock, this.#meta.sessionId)) return;
    const idleMin = SESSION_IDLE_MIN;
    if (now - this.#meta.lastTurnEndedAt > idleMin * 60_000) this.endSession('idle');
  }

  /** Continue an old session (console "continue"): closes the open one (if
   *  any), reopens the target, and ADOPTS it as the live session so a later
   *  resume can close it again. */
  resume(sessionId: string): boolean {
    if (this.#meta?.sessionId === sessionId) return true; // already live

    // Close whatever is open — prefer the in-memory lane, but FALL BACK to
    // disk: resume() used to blank #meta after reopening, so a second resume
    // had no in-memory pointer to the session it had just opened on disk and
    // left it open → store.reopen then refused (one-open-per-dock) → 404. Now
    // we always reconcile against disk before reopening.
    const openOnDisk = this.#d.store.openSession(this.dock);
    if (this.#meta) {
      this.endSession('switched');
    } else if (openOnDisk && openOnDisk.sessionId !== sessionId) {
      // desync (or a fresh process): adopt the disk-open session, then close it
      this.#meta = openOnDisk;
      this.endSession('switched');
    }

    const ok = this.#d.store.reopen(this.dock, sessionId);
    if (ok) {
      // ADOPT the reopened session as live (don't blank #meta — that's what
      // broke the second resume). Drop the agent so the next turn lazy-loads
      // this transcript.
      this.#meta = this.#d.store.openSession(this.dock);
      this.#agent = undefined;
      this.#approveAllMutations = false;
      this.#d.log?.(`[brain] ${this.dock}: resuming session ${sessionId}`);
    }
    return ok;
  }

  /** Close the open session (idle / console / reset): summary persisted, the
   *  next turn opens fresh. */
  endSession(reason: string): void {
    if (!this.#meta) return;
    if (this.#turnActive) this.cancel();
    // session boundary → conversation back to idle (clears windows + the tick).
    this.#conv.reconcileConnected(Date.now());
    const { sessionId } = this.#meta;
    const messages = this.#agent?.state.messages ?? this.#d.store.messages(this.dock, sessionId);
    // stop every task running under this conversation (the lifetime cascade, §5)
    // BEFORE closing the record. The supervisor knows what's running.
    this.#d.stopTasksForParent?.(this.dock, sessionId);
    // close NOW with the cheap tail digest; the LLM compaction below upgrades
    // it asynchronously (close must never wait on a model). `reason` is
    // recorded as closedBy — 'console' makes the close durable against the
    // presence-resume path (WI-5).
    this.#d.store.close(this.dock, sessionId, summarize(messages), reason);
    this.#d.log?.(`[brain] ${this.dock}: session ${sessionId} closed (${reason})`);
    this.#meta = undefined;
    this.#agent = undefined;
    this.#approveAllMutations = false; // approve-all is session-scoped; re-arm on close
    void this.#compactSummary(sessionId, messages);
  }

  /** Compact a closed session's transcript into a short memory note via one
   *  background LLM call — the seed the NEXT session's prompt carries (the
   *  dock remembers across engagements). Best-effort: any failure leaves the
   *  tail digest in place. */
  async #compactSummary(sessionId: string, messages: AgentMessage[]): Promise<void> {
    const transcript = transcriptLines(messages).join('\n');
    if (transcript.length < 120) return; // not worth a model call
    try {
      const agent = new Agent({
        initialState: {
          systemPrompt: SUMMARIZER_PROMPT,
          model: this.#resolveModel(),
          thinkingLevel: 'off',
          tools: [],
          messages: [],
        },
        getApiKey: (provider: string) => apiKeyFor(provider),
        streamFn: this.#d.streamFn ?? cappedStreamFn(),
      } as never);
      await agent.prompt([{
        role: 'user',
        content: [{ type: 'text', text: transcript.slice(-6_000) }],
        timestamp: Date.now(),
      } as AgentMessage]);
      const note = assistantText(agent.state.messages.at(-1)).trim();
      if (note && !agent.state.errorMessage) {
        this.#d.store.setSummary(this.dock, sessionId, note.slice(0, 800));
        this.#d.log?.(`[brain] ${this.dock}: session ${sessionId} compacted (${note.length} chars)`);
      }
    } catch (err) {
      this.#d.log?.(`[brain] ${this.dock}: summary compaction failed (digest kept): ${String(err)}`);
    }
  }

  // ── internals ──────────────────────────────────────────────────────────────

  #ensureSession(): Agent {
    // idle boundary crossed while we slept → close before opening fresh
    this.maybeIdleClose();
    if (this.#agent && this.#meta) return this.#agent;

    const existing = this.#d.store.openSession(this.dock);
    this.#meta = existing ?? this.#d.store.open(this.dock);
    const messages = existing ? this.#d.store.messages(this.dock, existing.sessionId) : [];

    const agent = new Agent({
      initialState: {
        systemPrompt: buildSystemPrompt({}),
        model: this.#resolveModel(),
        thinkingLevel: 'off', // latency: no extended reasoning on dock turns
        tools: this.#baseTools,
        messages,
      },
      // reads #usePaidKey at call time, so flipping it mid-turn (quota fallback)
      // takes effect on the very next provider request — no agent rebuild.
      getApiKey: (provider) => apiKeyFor(provider, this.#usePaidKey),
      ...(this.#d.streamFn ? { streamFn: this.#d.streamFn } : {}),
    });
    agent.subscribe((event) => this.#onAgentEvent(event));
    this.#agent = agent;
    this.#d.log?.(`[brain] ${this.dock}: session ${this.#meta.sessionId} ${existing ? 'resumed' : 'opened'} (${messages.length} msgs)`);
    return agent;
  }

  async #runTurn(req: TurnRequest): Promise<void> {
    const agent = this.#ensureSession();

    // conversation: a turn is running → THINKING (closes any listening window).
    this.#conv.turnStart(Date.now());

    // reset per-turn state
    this.#activeTurnId = req.turnId;
    this.#triggerText = req.trigger.text;
    this.#triggerKind = req.trigger.kind || 'user';
    this.#triggerVia = req.trigger.via;
    this.#stationOriginated = req.stationOriginated === true;
    this.#cancelled = false;
    this.#timedOut = false;
    this.#spokeThisTurn = false;
    this.#moodStepChecked = false;
    this.#moodStripLen = 0;
    this.#moodApplied = false;
    this.#moodHeldRaw = null;
    this.#moodEnabled = this.#d.config('brainInlineMood') !== false;
    this.#spokenSentences = [];
    this.#toolRanThisTurn = false;
    this.#streamer = new SentenceStreamer();
    this.#speakSeq = 0;
    this.#obsSeq = 0;
    this.#obsTurnId = `turn-${randomUUID().slice(0, 8)}`;
    this.#shippedStreamStart = false;
    this.#turnActive = true;

    // a new turn cancels any leftover gesture from the prior one (stopBody port)
    this.#d.motion.stop(this.dock);

    this.#turnStartedAt = Date.now();
    this.#stepIndex = -1;
    this.#toolStarts.clear();

    // live grounding + profile, re-read each turn (config applies next-turn)
    this.#sanitizeHistory(agent);
    // The body half of the grounding is the STATION's to report (it owns the
    // body link since the cutover); the phone's context covers face + senses.
    const bodyLine = this.#d.directory.resolveCap(this.dock, 'servo') != null
      ? `Body: CONNECTED — currently ${this.#d.motion.pose(this.dock) ?? 'at rest'}. `
        + 'Parts you can move — neck (head tilt), foot (base swivel); use the move tool '
        + '(relative:true for "turn more/again").'
      : 'Body: NOT connected (movement requests will be ignored).';
    // session seeding: the most recent CLOSED session's memory note rides the
    // system prompt, so a fresh engagement still knows this morning's context.
    const memory = this.#d.store.sessions(this.dock)
      .find((m) => m.closedAt != null && m.summary && m.sessionId !== this.#meta?.sessionId)?.summary;
    // per-dock skills, reloaded each turn from the dock's own folder (tenancy =
    // the path); a freshly-installed SKILL.md thus applies next-turn. Failure is
    // non-fatal — a dock with no/broken skills behaves exactly as before.
    this.#skills = await this.#loadSkills();
    // full pi coding skills (read/write/edit/run over the station's own code),
    // gated OFF by default. When on, the model is told it has them (so it can
    // answer questions about its code AND modify itself) and mutations require
    // dock UI confirmation.
    const fileAccess = this.#d.config('brainFileAccess') === true;
    // recent-research (last30days CLI): the integration gates on LAST30DAYS_SCRIPT;
    // bridge the config key into the env each turn so a configured/cleared path
    // applies next-turn (the tool is offered only when the script + a Python exist).
    const researchScript = str(this.#d.config('brainResearchScript'));
    if (researchScript) process.env.LAST30DAYS_SCRIPT = researchScript;
    else delete process.env.LAST30DAYS_SCRIPT;
    const taskPrompt = this.#d.config('brainTaskMax') === 0 ? '' :
      'BACKGROUND TASKS — you can run long-running background jobs as supervised '
      + 'processes: anything that needs to keep working over time or react later. They '
      + 'can loop on a timer, react to events, watch the camera, drive the body, call '
      + 'tools, run multi-step jobs — whatever the request needs (reminders and '
      + 'watchers are just two common examples, not the limit). When a request implies '
      + 'ongoing/deferred work, FIRST call list_tasks to see existing definitions, then '
      + 'run_task a fitting one (gather/ask for any required params) — STRONGLY PREFER '
      + 'reusing an existing definition over writing a new one. For a one-time reminder '
      + '("remind me in N"), reuse remind-after; for a repeating one ("every N"), reuse '
      + 'remind-every. Only if nothing fits, CREATE one with write_task. A ONE-TIME job '
      + 'must FINISH after it acts (do not leave it looping forever); only repeating jobs '
      + 'keep running. NEVER refuse with "I can only run predefined tasks": browse, reuse, '
      + 'or author. Track with get_task_status; manage with pause/resume/stop_task; answer '
      + 'a stuck task with provide_input. Relay any "[background task …]" message naturally.';
    // perception grounding (3.1): the last summary (stamped with staleness) + the
    // raw stream since it, for THIS dock. Pulled synchronously (no Gemini on the
    // turn path) and injected every turn — user AND self — so the agent always
    // reasons over what's been happening, not just the instant. Best-effort: a cold
    // dock / unwired perception → undefined, and the turn grounds as before.
    let grounding: string | undefined;
    // SELF-thoughts ground on the COHERENT layer (summary + beliefs + salient events
    // only — coherence-layer.md step 1): idle remarks authored from raw mush were the
    // out-of-place-line generator. User turns keep the full raw tail (a conversation
    // may reference anything just heard, including the shaky bits).
    try { grounding = this.#d.getGrounding?.()?.forDock(this.dock, { coherent: this.#triggerKind === 'self' }); }
    catch (err) { this.#d.log?.(`[brain] ${this.dock}: grounding failed (ignored): ${String(err)}`); }
    // the dock's EGO — its current evolving self, injected as WHO IS SPEAKING (ego.md §3.5).
    let self: string | undefined;
    try { self = this.#d.getSelf?.(this.dock); }
    catch (err) { this.#d.log?.(`[brain] ${this.dock}: ego read failed (ignored): ${String(err)}`); }
    agent.state.systemPrompt = buildSystemPrompt({
      persona: str(this.#d.config('brainPersona')),
      self,
      memory,
      skills: [this.#skills.promptBlock, fileAccess ? FILE_TOOLS_PROMPT : '', taskPrompt]
        .filter(Boolean).join('\n\n'),
      context: [bodyLine, req.context?.state].filter(Boolean).join(' '),
      grounding,
      // a self-thought is the robot's OWN perception/awareness, not a user
      // utterance — frame it so the model doesn't reply "you said…" to itself
      // and knows it may stay silent (docs/perception-to-brain.md 2.1).
      selfThought: this.#triggerKind === 'self',
      // heard in the followup window / during the reply, not deliberately
      // addressed — the model may stay silent, which ends the followup chain.
      overheard: this.#triggerVia === 'followup-window' || this.#triggerVia === 'busy-drain',
      // false → the pre-WI-3 tool-mood prompt (kill-switch pairs with #filterMood)
      inlineMood: this.#d.config('brainInlineMood') !== false,
    });
    agent.state.model = this.#resolveModel();
    agent.state.thinkingLevel = (str(this.#d.config('brainThinkingLevel')) ?? 'off') as never;
    // paid-key policy, re-read each turn: always-paid config forces it; else
    // start on the free key and fall back to paid only if this turn 429s/503s.
    this.#usePaidKey = this.#d.config('brainAlwaysPaid') === true && hasPaidKey();
    // cross-dock grants (config json { <dock>: { <target>: [caps] } }) become
    // extra tools — re-derived each turn so a granted/revoked dock applies
    // next-turn, no session restart. invoke_skill joins them when the dock has
    // any skills (the on-demand half of progressive disclosure).
    agent.state.tools = [
      ...this.#baseTools,
      ...buildGrantTools(this.dock, this.#grants(), this.#d.motion),
      ...buildSlackTools(), // send_to_slack — only when SLACK_BOT_TOKEN is set
      ...buildWhatsAppTools(), // send_to_whatsapp — only when WHATSAPP_TOKEN is set
      ...buildResearchTools(), // research_recent — only when the last30days CLI is wired
      // memory tools (recall/inspect/remember/update/forget) — only when the dock's
      // memory facade is wired (docs/perception-to-brain.md Decision 4).
      ...(this.#d.getMemory ? buildMemoryTools(this.dock, this.#d.getMemory) : []),
      ...(this.#skills.tool ? [this.#skills.tool] : []),
      ...(fileAccess ? buildFileTools({ confirm: (s, d) => this.#confirmOnDock(s, d) }) : []),
      ...(this.#d.getTaskTools?.(this.dock, () => this.#meta?.sessionId) ?? []),
      // feedback + self-knowledge: record_feedback (flag a session for review) and
      // inspect_observability (answer "what version / how fast / any errors" from
      // the same traces the console shows). Both built only when wired.
      ...buildFeedbackTools(this.dock, () => this.#meta?.sessionId, this.#d.feedbackCapture, () => this.#obsTurnId || undefined),
      ...buildObsTools(this.dock, () => this.#meta?.sessionId, this.#d.obs),
    ];
    this.#debug('turn-start', {
      text: req.trigger.text,
      model: `${agent.state.model.provider}/${agent.state.model.id}`,
      thinkingLevel: agent.state.thinkingLevel,
      historyMessages: agent.state.messages.length,
      // STT confidence for a heard turn (observability: why this transcript was trusted).
      ...(req.stt ? { stt: req.stt } : {}),
    });

    // vision gate (brain-side). Image source, in order: the phone-attached
    // photo (sent only when its SFU stream is down — quality + no-stream
    // fallback), else a frame grabbed from the dock's LIVE STREAM — the video
    // is already flowing, so a vision turn costs no per-turn upload.
    const streamId = this.#d.directory.resolveCap(this.dock, 'camera')?.id;
    this.#turnCtx = {
      turnId: req.turnId,
      imageBase64: req.imageBase64, // face tools may use the frame even on gated turns
      streamId,
    };
    // vision-gate bypass for task turns: the triggering frame IS the evidence,
    // and task text won't match the vision-intent regex (tasks §7a).
    const gate = VISION_GATE && this.#triggerKind === 'user';
    const content: (TextContent | ImageContent)[] = [{ type: 'text', text: req.trigger.text }];
    if (!gate || isVisionIntent(req.trigger.text)) {
      const grabbed = req.imageBase64 == null && streamId != null
        ? this.#d.getFaces()?.frame(streamId) : undefined;
      const image = req.imageBase64 ?? grabbed;
      if (image) {
        content.push({ type: 'image', data: image, mimeType: req.imageBase64 ? (req.imageMime ?? 'image/jpeg') : 'image/jpeg' });
        this.#debug('vision', { source: req.imageBase64 ? 'phone-photo' : 'sfu-frame' });
      }
    }

    // autonomous:true signals the phone to ADOPT a station-originated turn it
    // didn't initiate (RemoteBrain.kt — tasks §7b).
    this.#sendToVoice('turn-status', {
      turnId: req.turnId,
      state: 'accepted',
      // autonomous (phone must ADOPT) iff the phone didn't start it: any non-user
      // trigger (task/self) OR a station-originated user turn (A1.2 addressed mic).
      ...(this.#triggerKind !== 'user' || this.#stationOriginated ? { autonomous: true } : {}),
    });

    const timeoutMs = num(this.#d.config('brainTurnTimeoutMs'), 60_000);
    const timer = setTimeout(() => {
      this.#timedOut = true;
      agent.abort();
    }, timeoutMs);

    const userMessage = { role: 'user', content, timestamp: Date.now() } as AgentMessage;
    let failCode: FailCode | undefined;
    try {
      await agent.prompt([userMessage]);
      // AUTO-FALLBACK: free key hit a quota/overload → retry this turn ONCE on
      // the paid account (google only, when a paid key exists and we weren't
      // already on it). The paid key clears 429/503; a real error still fails.
      if (!this.#cancelled && !this.#timedOut && !this.#usePaidKey
          && hasPaidKey() && agent.state.model.provider === 'google'
          && isQuotaOrOverload(agent.state.errorMessage)) {
        // EXPECTED + BENIGN: the FREE key hitting quota is normal — that's why a paid
        // fallback exists. Log it clearly as "free key failed → falling back to paid"
        // so it's never mistaken for a real outage (it isn't, unless the paid retry
        // below ALSO fails).
        this.#d.log?.(`[brain] ${this.dock}: FREE key hit quota/overload (${agent.state.errorMessage?.slice(0, 60)}…) — this is expected; FALLING BACK to paid account`);
        this.#debug('paid-fallback', { reason: agent.state.errorMessage?.slice(0, 120) });
        this.#usePaidKey = true;
        // The failed prompt already appended the user message (and possibly a
        // trailing error-assistant). Drop any trailing assistant and CONTINUE
        // from the existing transcript — re-prompting would duplicate the user
        // message. getApiKey now returns the paid key; the retry overwrites
        // agent.state.errorMessage (cleared on success, set again on a real fail).
        const msgs = agent.state.messages;
        while (msgs.length > 0 && (msgs[msgs.length - 1] as { role?: string }).role === 'assistant') {
          msgs.pop();
        }
        if (msgs.length > 0 && (msgs[msgs.length - 1] as { role?: string }).role === 'user') {
          await agent.continue();
        } else {
          await agent.prompt([userMessage]);
        }
        // Log the OUTCOME of the paid retry so the logs are unambiguous next time.
        if (isQuotaOrOverload(agent.state.errorMessage)) {
          this.#d.log?.(`[brain] ${this.dock}: PAID account ALSO hit quota/overload — BOTH keys exhausted, the turn will fail (user-facing)`);
        } else if (agent.state.errorMessage) {
          this.#d.log?.(`[brain] ${this.dock}: paid retry failed with a non-quota error: ${agent.state.errorMessage.slice(0, 80)}`);
        } else {
          this.#d.log?.(`[brain] ${this.dock}: paid account recovered the turn (free-key quota was the only problem)`);
        }
      }
      const errMsg = agent.state.errorMessage;
      if (this.#timedOut) failCode = 'timeout';
      else if (!this.#cancelled && errMsg) failCode = 'llm_error';
      // BOTH-KEYS-EXHAUSTED → a genuinely user-facing condition. Report it to the
      // ambient dock-conditions so the user hears it on their NEXT interaction (the
      // throttled dock-error channel), instead of silent dead air. Only when we were
      // ALREADY on the paid key (so the free-key 429 alone never speaks) AND the final
      // error is still a quota/overload. Any non-quota outcome clears the condition.
      if (this.#usePaidKey && !this.#cancelled && isQuotaOrOverload(agent.state.errorMessage)) {
        dockConditions.report(this.dock, 'llm_exhausted',
          "I've hit my usage limit right now and can't think clearly — please try again in a little while, or ask my operator to top up my credits.");
      } else if (!this.#cancelled && !isQuotaOrOverload(agent.state.errorMessage)) {
        dockConditions.clear(this.dock, 'llm_exhausted'); // recovered / unrelated error
      }
    } catch (err) {
      if (!this.#cancelled) {
        failCode = this.#timedOut ? 'timeout' : 'llm_error';
        this.#d.log?.(`[brain] ${this.dock}: turn failed: ${String(err)}`);
      }
    } finally {
      clearTimeout(timer);
      this.#turnActive = false;

      const completedNormally = !this.#cancelled && !this.#timedOut && failCode == null;
      if (completedNormally) {
        this.#releaseHeldMood(); // an unresolved held '[' is prose, not silence
        const tail = this.#streamer.flush();
        if (tail != null) this.#speak(tail);
      }

      if (this.#meta) this.#d.store.turnEnded(this.dock, this.#meta.sessionId, agent.state.messages);
      this.#shipObs('TurnEnd');

      // FEEDBACK LOOP (coherence-layer.md §4 step 4): an UNPROMPTED spoken remark
      // (a self-thought that actually spoke) is an action in the world — hand it to
      // perception so the following minute's reaction is paired with it and the pair
      // becomes curator evidence. Best-effort; never affects the turn.
      if (completedNormally && this.#triggerKind === 'self' && this.#spokenSentences.length > 0) {
        try { this.#d.onSelfRemark?.(this.dock, this.#spokenSentences.join(' ')); }
        catch { /* observation only */ }
      }

      // INSTRUMENT: snapshot the session's station-side context (provenance,
      // config, models, perception window, …) onto the obs record. Best-effort,
      // off the turn's critical path — a failure here never affects the reply.
      if (this.#meta) {
        const sid = this.#meta.sessionId;
        const span = { from: this.#turnStartedAt, to: Date.now() };
        void Promise.resolve(this.#d.enrichSession?.(this.dock, sid, span))
          .catch((err) => this.#d.log?.(`[brain] ${this.dock}: enrich failed (ignored): ${String(err)}`));
      }

      this.#debug('turn-end', {
        state: this.#cancelled ? 'cancelled' : failCode != null ? 'failed' : 'done',
        code: failCode,
        // the provider's actual words (e.g. "No API key for provider: google")
        // — without this, every misconfig is an opaque llm_error.
        error: failCode != null ? agent.state.errorMessage : undefined,
        totalMs: Date.now() - this.#turnStartedAt,
      });
      if (this.#cancelled) {
        this.#sendToVoice('turn-status', { turnId: req.turnId, state: 'cancelled' });
      } else if (failCode != null) {
        // softened failure (DockAgent nuance): if the turn already DID
        // something, only the follow-up narration died.
        const softened = this.#spokeThisTurn || this.#toolRanThisTurn;
        this.#sendToVoice('turn-status', {
          turnId: req.turnId, state: 'failed', code: failCode,
          detail: softened ? 'lost-train-of-thought' : 'model-unreachable',
          error: agent.state.errorMessage,
        });
        this.#d.log?.(`[brain] ${this.dock}: turn failed (${failCode}): ${agent.state.errorMessage ?? 'no detail'}`);
        // SPEAK THE FAILURE instead of dying silently (the "STT shown but no
        // reply" symptom): when nothing was said this turn, say a short reason so
        // the user knows the dock heard them but couldn't answer — rather than dead
        // air. Rate-limit (429/quota/overload) gets its own line; other errors get
        // a generic one. Only when not softened (a partial reply already covered it).
        if (!softened) {
          const rateLimited = isQuotaOrOverload(agent.state.errorMessage);
          const line = rateLimited
            ? "Sorry, I'm being rate limited right now — give me a moment and try again."
            : failCode === 'timeout'
              ? "Sorry, that took too long and I couldn't finish — could you try again?"
              : "Sorry, I hit an error and couldn't answer that — could you try again?";
          this.#speak(line);
        }
      } else {
        this.#sendToVoice('turn-status', { turnId: req.turnId, state: 'done' });
      }
      this.#activeTurnId = undefined;
      // SILENT-TURN SETTLE: a turn that ended without ever speaking gets no
      // tts markers, so the noteSpeech settle never fires — and the conv
      // machine would sit wedged in 'thinking' until the THINK_MAX_MS prune
      // (silently gating wakes for up to 60s after e.g. a self-thought that
      // chose silence). This covers FAILED turns too (code review: a
      // softened failure — tool ran, no speech — matched neither settle site
      // and stranded the busy queue). Only cancelled/superseded turns are
      // excluded: a tap-interrupt means the user speaks next; their queue
      // drains at the interrupting turn's settle or the window-timeout
      // transition. DEFERRED one tick because #running still points at THIS
      // turn inside its own finally; by setImmediate time it has cleared, and
      // a newer turn re-sets it (that turn's own settle follows).
      if (!this.#cancelled && !this.#spokeThisTurn) {
        setImmediate(() => {
          if (this.#running || this.#turnActive) return;
          const wasThinking = this.#conv.mode(Date.now()) === 'thinking';
          this.#conv.noSpeechSettle(Date.now()); // thinking→idle → the chokepoint fires
          // already-idle edge (e.g. think-timeout pruned mid-turn): no
          // transition happened above, settle directly.
          if (!wasThinking) this.#maybeSettle();
        });
      }
    }
  }

  /**
   * Repair + bound the transcript before a new prompt (1:1 port of
   * DockAgent.sanitizeHistory):
   *  1. patch unanswered tool calls (from a cancelled turn) with synthetic
   *     "(interrupted)" results — OpenAI-style endpoints reject the history
   *     otherwise, which would fail EVERY turn after an interruption;
   *  2. cap the history, trimming whole turns from the front (cut at a
   *     user-message boundary so call/result pairs are never split).
   */
  #sanitizeHistory(agent: Agent): void {
    const msgs = agent.state.messages;
    if (msgs.length === 0) return;
    const answered = new Set(
      msgs.filter((m): m is ToolResultMessage => (m as { role?: string }).role === 'toolResult')
        .map((m) => m.toolCallId),
    );
    const repaired: AgentMessage[] = [];
    for (const m of msgs) {
      repaired.push(m);
      if ((m as { role?: string }).role === 'assistant') {
        const calls = (m as AssistantMessage).content.filter(
          (c): c is ToolCall => (c as { type?: string }).type === 'toolCall',
        );
        for (const tc of calls) {
          if (answered.has(tc.id)) continue;
          repaired.push({
            role: 'toolResult',
            toolCallId: tc.id,
            toolName: tc.name,
            content: [{ type: 'text', text: '(interrupted before completing)' }],
            isError: false,
            timestamp: Date.now(),
          } satisfies ToolResultMessage as AgentMessage);
        }
      }
    }
    let result = repaired;
    // HYSTERESIS TRIM (Addendum 7, prompt-cache stability): trimming to the cap
    // EVERY turn shifted the history window by one turn per turn — the request
    // prefix (which includes the message list) never repeated, so a long
    // session got ZERO Gemini implicit-cache hits (measured live: 20k tokens,
    // cached:0 every turn, while an under-cap smoke session cached 93%). Trim
    // in CHUNKS instead: let history grow to 1.5× the cap, then cut down to
    // ~0.75× at a user boundary. Between cuts the window is append-only →
    // prefix-stable → cached; one miss per chunk instead of per turn.
    const cap = MAX_HISTORY_MESSAGES;
    const high = Math.floor(cap * 1.5);
    if (result.length > high) {
      const keep = Math.floor(cap * 0.75);
      let boundary: number | undefined;
      for (let i = result.length - keep; i < result.length; i++) {
        if ((result[i] as { role?: string }).role === 'user') { boundary = i; break; }
      }
      if (boundary != null && boundary > 0) result = result.slice(boundary);
    }
    if (result.length !== msgs.length) agent.state.messages = result;
  }

  /** Translate pi loop events → speak frames + status + obs DTOs. NOTE the
   *  vocabulary shift: current upstream pi calls one LLM call+tools a "turn"
   *  and the whole prompt() run "agent_*" — our obs model (brain.md)
   *  calls those Step and Turn; mapped here. */
  #onAgentEvent(event: AgentEvent): void {
    switch (event.type) {
      case 'agent_start':
        // NOT lastUserText(agent): pi emits agent_start BEFORE appending the
        // new user message, so deriving the trigger from history labeled
        // every turn with the PREVIOUS utterance (seen live on the console).
        this.#shipObs('TurnStart', {
          trigger: { kind: this.#triggerKind, text: this.#triggerText, ...(this.#triggerVia ? { via: this.#triggerVia } : {}) },
        });
        break;
      case 'turn_start':
        // Each pi "turn" is one LLM STEP (our vocab), and each step is a FRESH
        // assistant message whose text streams from zero. The SentenceStreamer
        // tracks an emitted-chars offset, so it MUST reset per step — otherwise
        // step 2+ (e.g. the model reacting to a tool result on a multi-step
        // turn) gets sliced at the previous step's offset, dropping its opening
        // words or emitting a bare-punctuation fragment ("!"). Flush any tail
        // from the prior step first so a step that ended without terminal
        // punctuation still gets spoken.
        if (this.#stepIndex >= 0) {
          this.#releaseHeldMood(); // an unresolved held '[' is prose, not silence
          const tail = this.#streamer.flush();
          if (tail != null) this.#speak(tail);
        }
        this.#streamer = new SentenceStreamer();
        this.#shippedStreamStart = false;
        this.#moodStepChecked = false; // a later step may lead with its own tag
        this.#moodStripLen = 0;
        this.#stepIndex++;
        this.#stepStartedAt = Date.now();
        this.#stepTtft = undefined;
        this.#stepThinkAt = undefined;
        this.#stepTextAt = undefined;
        this.#shipObs('StepStart');
        this.#debug('step-start', { step: this.#stepIndex });
        break;
      case 'message_update': {
        // first token of the step = TTFT (the number that dominates §7)
        if (this.#stepTtft == null) {
          this.#stepTtft = Date.now() - this.#stepStartedAt;
          this.#debug('ttft', { step: this.#stepIndex, ms: this.#stepTtft });
        }
        const ame = event.assistantMessageEvent;
        if (ame?.type === 'text_delta') {
          if (this.#stepTextAt == null) {
            this.#stepTextAt = Date.now();
            this.#debug('text-start', { step: this.#stepIndex, ms: this.#stepTextAt - this.#stepStartedAt });
          }
          this.#debug('text-delta', { delta: ame.delta });
        } else if (ame?.type === 'thinking_delta') {
          if (this.#stepThinkAt == null) {
            this.#stepThinkAt = Date.now();
            this.#debug('thinking-start', { step: this.#stepIndex, ms: this.#stepThinkAt - this.#stepStartedAt });
          }
          this.#debug('thinking-delta', { delta: ame.delta });
        }
        const text = this.#filterMood(assistantText(event.message));
        if (text.length > 0) {
          for (const sentence of this.#streamer.push(text)) this.#speak(sentence);
          this.#sendToVoice('turn-status', { turnId: this.#activeTurnId, state: 'thinking' });
        }
        // ship only the FIRST update per step (streamStartedAt = TTFT); the
        // browser obs subscribers are on the other end of this bus.
        if (!this.#shippedStreamStart) {
          this.#shippedStreamStart = true;
          this.#shipObs('MessageUpdate');
        }
        break;
      }
      case 'message_end': {
        const m = event.message as AssistantMessage;
        if ((m as { role?: string }).role === 'assistant') {
          // strip the inline mood tag so the console/obs history shows what
          // was actually SAID, not the control token.
          this.#shipObs('MessageEnd', { text: stripMoodTag(assistantText(event.message)) });
        }
        break;
      }
      case 'tool_execution_start':
        this.#toolStarts.set(event.toolCallId, Date.now());
        this.#sendToVoice('turn-status', {
          turnId: this.#activeTurnId, state: 'acting', detail: event.toolName,
        });
        this.#shipObs('ToolExecutionStart', {
          toolCallId: event.toolCallId, toolName: event.toolName, args: event.args,
        });
        this.#debug('tool-start', { toolCallId: event.toolCallId, name: event.toolName, args: event.args });
        break;
      case 'tool_execution_end': {
        if (!event.isError) this.#toolRanThisTurn = true;
        const result = event.result as { content?: Array<{ type?: string; text?: string }> } | undefined;
        const resultText = result?.content?.find((c) => c.type === 'text')?.text ?? '';
        const startedAt = this.#toolStarts.get(event.toolCallId);
        this.#shipObs('ToolExecutionEnd', {
          toolCallId: event.toolCallId, toolName: event.toolName, isError: event.isError,
          result: resultText,
        });
        this.#debug('tool-end', {
          toolCallId: event.toolCallId, name: event.toolName, isError: event.isError,
          result: resultText, ms: startedAt != null ? Date.now() - startedAt : undefined,
        });
        break;
      }
      case 'turn_end': {
        const m = event.message as AssistantMessage;
        const stepMs = Date.now() - this.#stepStartedAt;
        // the reasoning phase: first thinking token → first answer token
        // (or step end when the step never produced answer text)
        const thinkingMs = this.#stepThinkAt != null
          ? (this.#stepTextAt ?? Date.now()) - this.#stepThinkAt
          : undefined;
        const ttftTextMs = this.#stepTextAt != null ? this.#stepTextAt - this.#stepStartedAt : undefined;
        // Persist the SAME rich timings + cost on the obs StepEnd as the live
        // debug stream carries, so a resumed session's inspector matches live
        // the step's own error message (e.g. the 429 body) when it errored —
        // so an errored step shows WHAT failed, even when the turn recovered.
        const stepError = (m as { errorMessage?: string }).errorMessage;
        // exactly (the obs tree is the single source for resumed turns).
        this.#shipObs('StepEnd', {
          model: (m as { model?: string }).model ?? '',
          stopReason: (m as { stopReason?: string }).stopReason,
          error: stepError,
          ms: stepMs,
          ttftMs: this.#stepTtft,
          thinkingMs,
          ttftTextMs,
          usage: m.usage ? {
            inputTokens: m.usage.input, outputTokens: m.usage.output,
            totalTokens: m.usage.totalTokens, cost: m.usage.cost?.total,
            // prompt-cache hits (Addendum 7): the observable for cache-friendly
            // prompt ordering — without it a caching regression is invisible.
            cacheRead: m.usage.cacheRead,
          } : undefined,
        });
        this.#debug('step-end', {
          step: this.#stepIndex,
          ms: stepMs,
          error: stepError,
          ttftMs: this.#stepTtft,
          thinkingMs,
          ttftTextMs,
          stopReason: (m as { stopReason?: string }).stopReason,
          model: (m as { model?: string }).model ?? '',
          usage: m.usage ? {
            input: m.usage.input, output: m.usage.output,
            total: m.usage.totalTokens, cost: m.usage.cost?.total,
          } : undefined,
        });
        break;
      }
      default:
        break;
    }
  }

  /** Ask the dock to CONFIRM a mutating code/file action before it runs. RPCs
   *  a `confirm` tool-call to the dock's face surface; the UI shows it and acks
   *  approve / deny / approve-all. Anything but an explicit, non-error approval
   *  = DENY (offline, timeout, decline all fail safe).
   *
   *  "Approve all" (the user tapped it once) latches #approveAllMutations for
   *  the rest of the session: subsequent mutations skip the RPC entirely. */
  async #confirmOnDock(summary: string, detail: string): Promise<boolean> {
    // deployment-wide auto-approve: skip the dock popup entirely and run every
    // mutation. Opt-in config (brainFileAutoApprove); pairs with brainFileAccess.
    if (this.#d.config('brainFileAutoApprove') === true) return true;
    if (this.#approveAllMutations) return true; // session-wide approval already given
    const ack = await this.#d.rpc.call({
      dock: this.dock, cap: 'face', turnId: this.#activeTurnId ?? '',
      toolCallId: `confirm-${randomUUID().slice(0, 8)}`,
      name: 'confirm', args: { summary, detail },
      timeoutMs: 120_000, // a human is reading + deciding
    });
    if (ack.isError) return false;
    const reply = ack.content.trim();
    if (/^(approved[-_]all|approve[-_]all|all)$/i.test(reply)) {
      this.#approveAllMutations = true; // every mutation this session is now auto-approved
      this.#d.log?.(`[brain] ${this.dock}: approve-all latched for this session`);
      return true;
    }
    return /^(approved|yes|true|ok)$/i.test(reply);
  }

  /** A LIVE interim (partial) user transcript → directed caption frame to the voice
   *  component. Cosmetic UI feedback only: it never starts/affects a turn — the
   *  authoritative path is the endpointed final via onAddressedFinal. Gated upstream
   *  on isListening, so this only fires during an active listening/followup turn. */
  sendInterim(text: string, seq: number): void {
    this.#sendToVoice('transcript-interim', { text, seq, isFinal: false });
  }

  /** Inline mood tag (WI-3, busy-queue-black-hole.md Addendum 3): the reply's
   *  leading `[face:NAME]` sets the face with NO extra LLM step (the old
   *  separate set_face step cost a full serial ttft on a ~23k prompt — the
   *  dominant term in the 8s median reply latency). Called on each step's
   *  CUMULATIVE text before it enters the SentenceStreamer, so the tag is
   *  never spoken and never subtitled. While a leading tag is still streaming
   *  in ("[face:ha"), output is HELD (empty) so a partial tag can't leak;
   *  a leading bracket that turns out not to be a mood tag passes through. */
  #filterMood(text: string): string {
    if (!this.#moodEnabled) return text;
    if (this.#moodStripLen > 0) return text.slice(this.#moodStripLen);
    if (this.#moodStepChecked || text.length === 0) return text;
    const m = text.match(MOOD_TAG_RE);
    if (m) {
      this.#moodStepChecked = true;
      this.#moodHeldRaw = null;
      this.#moodStripLen = m[0].length;
      this.#applyMood(m[1]!.toLowerCase());
      return text.slice(this.#moodStripLen);
    }
    if (/^\s*\[[^\]]*$/.test(text) && text.length < 40) {
      this.#moodHeldRaw = text; // tag may still be completing — hold, don't leak
      return '';
    }
    this.#moodStepChecked = true; // leading text is real prose (or a non-mood bracket)
    this.#moodHeldRaw = null;
    return text;
  }

  /** A held leading '[' that never resolved into a mood tag by step end is
   *  released as PROSE (review finding: a step whose whole text was '[thinks'
   *  was silently dropped — dead air). Call before every streamer flush. */
  #releaseHeldMood(): void {
    if (this.#moodHeldRaw == null) return;
    const text = this.#moodHeldRaw;
    this.#moodHeldRaw = null;
    this.#moodStepChecked = true;
    for (const sentence of this.#streamer.push(text)) this.#speak(sentence);
  }

  /** Apply a parsed mood: same effects as the set_face tool (gesture in-process,
   *  face UI via phone RPC), both best-effort and NOT awaited. First tag wins
   *  per turn; unknown names are logged and ignored (the tag is still stripped
   *  — better silent than spoken). */
  #applyMood(expression: string): void {
    if (this.#moodApplied) return;
    if (!FACES.includes(expression as never)) {
      this.#d.log?.(`[brain] ${this.dock}: inline mood ignored (unknown face "${expression}")`);
      return;
    }
    this.#moodApplied = true;
    this.#debug('mood', { expression });
    fireFace({
      dock: this.dock, motion: this.#d.motion, rpc: this.#d.rpc,
      gestures: gesturesFromConfig(this.#d.config('faceGestures')) as Record<string, MoveStep[]>,
      turnId: this.#activeTurnId ?? '', toolCallId: `mood-${this.#obsTurnId}`,
      expression, warn: (msg) => this.#d.log?.(`[brain] ${this.dock}: inline mood ${msg}`),
    });
  }

  /** One spoken sentence → directed speak frame to the voice component. */
  #speak(sentence: string): void {
    this.#spokeThisTurn = true;
    this.#spokenSentences.push(sentence);
    const seq = this.#speakSeq++;
    this.#sendToVoice('speak', { turnId: this.#activeTurnId, seq, text: sentence });
    this.#debug('speak', { seq, text: sentence });
  }

  /** Rich per-turn debug stream for the console's turn inspector — kind
   *  'brain-debug' on the obs topic (browsers subscribe obs; devices don't,
   *  so full deltas here never hit a phone's radio). */
  #debug(type: string, data?: Record<string, unknown>): void {
    this.#d.bus.publish({
      topic: 'obs', kind: 'brain-debug',
      payload: {
        dock: this.dock, sessionId: this.#meta?.sessionId,
        turnId: this.#activeTurnId, ts: Date.now(), type, ...(data ?? {}),
      },
      source: this.dock,
    });
  }

  #sendToVoice(kind: string, payload: unknown): void {
    const target = this.#d.directory.resolveCap(this.dock, 'voice');
    if (!target?.component) return; // offline: the turn is dying via onDockOffline
    this.#d.bus.publish({
      topic: 'agent', kind, payload, source: 'station',
      toAddr: { dock: this.dock, component: target.component },
    });
  }

  /** AgentEventDto onto the obs bus topic — in-process, same ingest as the
   *  old phone path. `source` = DOCK NAME (multi-tenant fix: every dock would
   *  otherwise collide as source 'station'). */
  #shipObs(kind: string, data?: Record<string, unknown>): void {
    if (!this.#meta) return;
    this.#d.bus.publish({
      topic: 'obs', kind: 'event',
      payload: {
        sessionId: this.#meta.sessionId,
        turnId: this.#obsTurnId,
        seq: this.#obsSeq++,
        kind,
        ts: Date.now(),
        ...(data ? { data } : {}),
      },
      source: this.dock,
    });
  }

  #shipObsMarker(kind: string): void {
    if (this.#obsTurnId === '') return;
    this.#shipObs(kind);
  }

  #resolveModel(): Model<any> {
    const spec = str(this.#d.config('brainModel')) ?? 'google/gemini-2.5-flash';
    return resolveModel(spec);
  }
}

// ── helpers ──────────────────────────────────────────────────────────────────

/**
 * Resolve "provider/modelId" (pi-ai catalog) or
 * "openai-compatible/<modelId>@<baseUrl>" (LAN Ollama / llama.cpp).
 */
export function resolveModel(spec: string): Model<any> {
  const slash = spec.indexOf('/');
  const provider = slash > 0 ? spec.slice(0, slash) : 'google';
  const rest = slash > 0 ? spec.slice(slash + 1) : spec;
  if (provider === 'openai-compatible' || rest.includes('@')) {
    const at = rest.lastIndexOf('@');
    const modelId = at > 0 ? rest.slice(0, at) : rest;
    const baseUrl = at > 0 ? rest.slice(at + 1) : 'http://localhost:11434/v1';
    return {
      id: modelId, name: modelId, api: 'openai-completions', provider: 'openai-compatible',
      baseUrl, reasoning: false, input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 32_768, maxTokens: 8_192,
    } as Model<any>;
  }
  try {
    return getModel(provider as never, rest as never) as Model<any>;
  } catch (err) {
    throw new Error(`unknown brainModel "${spec}" (${String(err)})`);
  }
}

/**
 * Per-request output cap. The dock speaks 1-2 sentences + a tool call — it
 * never needs a model's full default (some advertise 64k). pi's Agent has no
 * state field for this and omits max_tokens entirely when unset, so a provider
 * (OpenRouter) quotes the model's full max up-front — which 402'd the moment
 * account balance dipped below that (huge) quote. [cappedStreamFn] injects it
 * into every request's options, the only reliable seam.
 */
export const DOCK_MAX_TOKENS = 2048;

/** Wrap pi's default transport to cap max_tokens on every request (see
 *  [DOCK_MAX_TOKENS]). `cap` lets the grader use a larger budget. */
export function cappedStreamFn(cap = DOCK_MAX_TOKENS): import('@earendil-works/pi-agent-core').StreamFn {
  return ((model, context, options) =>
    streamSimple(model, context, { ...options, maxTokens: cap })) as import('@earendil-works/pi-agent-core').StreamFn;
}

/** provider → station env var. Keys never live in device builds anymore.
 *  `paid` selects the paid-account key for providers that have one (google:
 *  GEMINI_API_KEY_PAID_ACC) — used as the overload/quota fallback and the
 *  always-paid switch. Falls back to the free key if the paid one is unset. */
export function apiKeyFor(provider: string, paid = false): string | undefined {
  const env = process.env;
  switch (provider) {
    case 'google':
      return paid
        ? (env.GEMINI_API_KEY_PAID_ACC ?? env.GEMINI_API_KEY ?? env.GOOGLE_API_KEY)
        : (env.GEMINI_API_KEY ?? env.GOOGLE_API_KEY);
    case 'anthropic': return env.ANTHROPIC_API_KEY;
    case 'openai': return env.OPENAI_API_KEY;
    case 'openrouter': return env.OPENROUTER_API_KEY;
    default: return undefined;
  }
}

/** True when a provider error is a quota/rate-limit/overload — the cases the
 *  paid-account key can fix (mirrors the dock's diagnoseTurnFailure). */
export function isQuotaOrOverload(errorMessage: string | undefined): boolean {
  if (!errorMessage) return false;
  const e = errorMessage.toLowerCase();
  return ['429', 'resource_exhausted', 'rate limit', 'rate-limit', 'too many requests',
    'quota', '503', 'overloaded', 'unavailable', 'high demand']
    .some((n) => e.includes(n));
}

/** Whether the google paid-account key is even configured. */
export function hasPaidKey(): boolean {
  return !!process.env.GEMINI_API_KEY_PAID_ACC;
}

/** The env-var name a provider+paid combination resolves to (NOT the value).
 *  Mirrors apiKeyFor's selection so the console can show which key is in use. */
export function keyEnvName(provider: string, paid = false): string | undefined {
  switch (provider) {
    case 'google': return paid ? 'GEMINI_API_KEY_PAID_ACC' : 'GEMINI_API_KEY';
    case 'anthropic': return 'ANTHROPIC_API_KEY';
    case 'openai': return 'OPENAI_API_KEY';
    case 'openrouter': return 'OPENROUTER_API_KEY';
    default: return undefined; // openai-compatible / LAN: no key
  }
}

export interface KeyStatus {
  provider: string;
  /** the env var the NEXT turn will use (paid when alwaysPaid, else free). */
  keyName: string | null;
  /** is that key actually set in the station env? */
  keySet: boolean;
  /** google only: the paid fallback exists and would be tried on a 429/503. */
  paidFallback: { keyName: string; keySet: boolean } | null;
  /** true when alwaysPaid is on AND a paid key exists (google). */
  alwaysPaid: boolean;
}

/** Resolve which API key the dock brain will use for a model spec — names +
 *  set/unset, the paid fallback, and the always-paid state — for the console. */
export function keyStatusFor(modelSpec: string, alwaysPaid: boolean): KeyStatus {
  const spec = modelSpec || 'google/gemini-2.5-flash';
  const slash = spec.indexOf('/');
  let provider = slash > 0 ? spec.slice(0, slash) : 'google';
  const rest = slash > 0 ? spec.slice(slash + 1) : spec;
  if (provider === 'openai-compatible' || rest.includes('@')) provider = 'openai-compatible';

  const usePaidNow = provider === 'google' && alwaysPaid && hasPaidKey();
  const keyName = keyEnvName(provider, usePaidNow) ?? null;
  const keySet = keyName != null && !!process.env[keyName];

  const paidFallback = provider === 'google' && !usePaidNow
    ? { keyName: 'GEMINI_API_KEY_PAID_ACC', keySet: hasPaidKey() }
    : null;

  return { provider, keyName, keySet, paidFallback, alwaysPaid: usePaidNow };
}

function assistantText(m: unknown): string {
  const msg = m as { role?: string; content?: Array<{ type?: string; text?: string }> };
  if (msg.role !== 'assistant' || !Array.isArray(msg.content)) return '';
  return msg.content.filter((c) => c.type === 'text').map((c) => c.text ?? '').join('');
}


/** Plain user/orbit lines of a transcript (tool noise dropped). */
function transcriptLines(messages: AgentMessage[]): string[] {
  const lines: string[] = [];
  for (const m of messages) {
    const role = (m as { role?: string }).role;
    if (role === 'user') {
      const t = typeof (m as { content?: unknown }).content === 'string'
        ? (m as { content: string }).content
        : ((m as { content?: Array<{ type?: string; text?: string }> }).content ?? [])
            .filter((c) => c.type === 'text').map((c) => c.text ?? '').join('');
      if (t) lines.push(`user: ${t}`);
    } else if (role === 'assistant') {
      // the inline mood tag is a control token, not conversation — keep it out
      // of summaries/compaction (it leaks into seeded context otherwise).
      const t = stripMoodTag(assistantText(m));
      if (t) lines.push(`orbit: ${t}`);
    }
  }
  return lines;
}

/** Instant close-time summary: a tail digest. The async LLM compaction
 *  (#compactSummary) upgrades it to a real memory note when it lands. */
function summarize(messages: AgentMessage[]): string {
  return transcriptLines(messages).slice(-8).join('\n').slice(0, 1_000);
}

/** One-shot compaction prompt — output is carried verbatim in the next
 *  session's system prompt, so it must be short and third-person. */
const SUMMARIZER_PROMPT = `You compress a conversation between a user and "orbit" (a small desk robot) into ONE short memory note (max 80 words). Keep: people's names and anything learned about them, stated preferences, facts to remember, unfinished topics or promises. Drop: small talk, gestures, one-off commands. Write the note only — no preamble, no headings.`;

function num(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}
function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

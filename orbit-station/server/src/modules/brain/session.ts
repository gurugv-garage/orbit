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
  type Context,
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
import { buildSystemPrompt, buildTurnContext, stripTurnContext, isVisionIntent, MOOD_TAG_RE, MOVE_TAG_RE, stripMoodTag } from './prompt.js';
import { SpeechGate } from './speech-gate.js';
import { decideThought, type SessionState } from './thought-router.js';
import { ConversationState, type AdmitTrace, type ConvTransition } from './conversation-state.js';
import { mkdirSync, writeFileSync, readdirSync, statSync, unlinkSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { recordConvEvent } from '../observability/conv-events.js';
import { MAX_HISTORY_MESSAGES, SESSION_IDLE_MIN, VISION_GATE } from './constants.js';
import { RpcBroker } from './rpc.js';
import { makeReplayStreamFn, wrapToolsForReplay, type ReplayScript } from './replay.js';
import { SentenceStreamer } from './sentence.js';
import { SessionStore, type SessionMeta } from './store.js';
import { loadDockSkills, type DockSkills } from './skills.js';
import { buildFileTools, FILE_TOOLS_PROMPT } from './filetools.js';
import { buildDockTools, buildGrantTools, buildSlackTools, buildWhatsAppTools, buildResearchTools, buildWebSearchTools, buildMemoryTools, buildFeedbackTools, buildObsTools, buildSessionTools, buildQuietTools, fireFace, type ToolTurnContext } from './tools.js';
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
  /** `via` = WHICH source raised/admitted the trigger (a mood bit id, a gate raise
   *  key, the greet, the console poke — and for addressed user turns the WINDOW
   *  that admitted the utterance: tap-window/followup-window/…). `window` = the
   *  ConversationState admit verdict for addressed user turns (which rule + which
   *  window + how it opened + time left) — provenance surfaced in observability so
   *  "why did this turn run" is never a mystery. */
  trigger: { kind: string; text: string; via?: string; window?: AdmitTrace;
    /** segmentation-minted id of the admitting utterance (`<dockId>:<audioStartMs>`)
     *  — joins this turn to its conv_events/perception rows on the timeline. */
    utteranceId?: string };
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
   *  trace shows WHY a heard utterance was trusted/flagged (Whisper's own metrics).
   *  `voice` = the utterance's voice fingerprint (hearing-identity): when it cleared
   *  the match bar the turn prompt names the speaker as the interlocutor. */
  stt?: { confTier?: string; avgLogprob?: number | null; noSpeechProb?: number | null; compressionRatio?: number | null;
    voice?: { name: string; score?: number; match?: boolean } };
  /** How many times this turn is a MERGE-SUPERSEDE of a prior thinking turn
   *  (Addendum 10: speech heard mid-thinking cancels + re-asks with the
   *  addition folded in). Bounds the abort-restart loop (cap in brain index). */
  merges?: number;
  /** REPLAY (station-constructed only — the obs console's ▶ replay): re-run a
   *  recorded turn's assistant responses through the live pipeline with NO LLM
   *  calls. The turn leaves no trace in the session: history is restored and
   *  persistence/enrichment are skipped (see #runTurn's replay guards). */
  replay?: ReplayScript;
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
  /** record the exact request an LLM step sent (obs request ring). Undefined → off. */
  recordRequest?: (sessionId: string, turnId: string, stepIndex: number, json: string) => void;
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
  #triggerWindow: AdmitTrace | undefined; // the admit verdict for addressed user turns — obs only
  #triggerUtterance: string | undefined; // the admitting utterance's correlation id — obs only
  #triggerStt: TurnRequest['stt'] | undefined; // STT evidence for the admitting utterance — obs only
  #turnImage: string | undefined; // ref of the saved input frame this turn's model saw — obs only
  #mergeCount = 0; // merge-supersedes carried by the CURRENT turn (Addendum 10)
  // A1.2: a station-originated user turn (an addressed always-on-mic utterance) —
  // the phone must adopt it even though its trigger.kind is 'user'.
  #stationOriginated = false;
  #cancelled = false;
  #timedOut = false;
  #spokeThisTurn = false;
  // Inline mood tag (WI-3 → Fix 5): a [face:NAME] tag in the reply text sets
  // the face WITHOUT a separate LLM step. Tags ride the SentenceStreamer raw
  // and are extracted PER SENTENCE at #speak — the mood travels on the same
  // speak frame as the words it belongs to, so the phone can apply it when
  // that utterance actually STARTS PLAYING (audio lags the parse by seconds;
  // firing at parse wore the story's LAST face during its FIRST sentence).
  #moodEnabled = true;      // brainInlineMood, snapshot per turn (config() is a
                            // registry scan — not per streaming delta)
  #toolRanThisTurn = false;
  #streamer = new SentenceStreamer();
  #speakSeq = 0;
  // Motion-speech timing: the audio-clock gate the move tool awaits, plus the
  // step-start seq snapshot that tells it "did I speak before this call?"
  // (docs/decision-traces/motion-speech-timing.md).
  #speechGate = new SpeechGate();
  #stepStartSpeakSeq = 0;
  // the TURN's abort signal — long tools (visual_search) poll it; fired at every
  // site the speech gate cancels (cancel/supersede/offline/timeout) + turn end.
  #turnAbort = new AbortController();
  #obsSeq = 0;
  #obsTurnId = '';
  #shippedStreamStart = false;
  #turnCtx: ToolTurnContext = { turnId: '' };
  #turnActive = false;
  /** set by the end_session tool: close the session at the NEXT settle (an
   *  in-turn close would cancel the turn that asked for it — see buildSessionTools). */
  #endRequested = false;
  /** QUIET MODE (🤐): while set, the dock does NOT SPEAK — addressed turns are
   *  skipped whole (no LLM), self-thought + spoken mood bits are suppressed, the
   *  wake ack is silenced. Perception intake and body motion/idle-moods keep
   *  running (motion never routes through the speak path). Values: undefined =
   *  off; Infinity = indefinite (UI toggle, until manually turned off); a
   *  timestamp = timed (the keep_quiet tool), auto-unlocks when Date.now() passes
   *  it. Session-scoped (in-memory), like #approveAllMutations — a station
   *  restart clears it. Manual off (setQuiet(null)) ALWAYS wins over a timed lock. */
  #quietUntil?: number;
  // debug-stream timing (the console's turn inspector — kind 'brain-debug' on obs)
  #turnStartedAt = 0;
  #stepIndex = -1;
  #stepStartedAt = 0;
  /** the serialized request the in-flight step sent (captured in the streamFn
   *  wrapper, persisted to the obs request ring on its StepEnd). */
  #pendingRequest: string | undefined;
  /** REPLAY transport for the CURRENT turn (undefined = real LLM). Assigned
   *  from req.replay in #runTurn's reset block — every turn overwrites it, so
   *  a stale replay can never leak into a later real turn. */
  #replayStreamFn: import('@earendil-works/pi-agent-core').StreamFn | undefined;
  #stepTtft: number | undefined;
  /** wall-clock of the step's first thinking / first answer-text token —
   *  thinkingMs = the span between them (the model's reasoning phase). */
  #stepThinkAt: number | undefined;
  /** streamed thinking-text chars this step → the thinkingTokens estimate on
   *  StepEnd (providers fold billed thought tokens into `output`; pi keeps no
   *  split, so chars/4 on the streamed thoughts is the best observable). */
  #stepThinkChars = 0;
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
      showOnFace: (jpegB64: string, ttlMs: number) => {
        this.#sendToVoice('show-image', { turnId: this.#activeTurnId, jpegB64, ttlMs });
      },
      speech: {
        textThisStep: () => this.#speakSeq > this.#stepStartSpeakSeq,
        takeAnchor: () => this.#speechGate.takeAnchor(),
        waitQuiet: () => this.#speechGate.waitQuiet(),
        waitAnchor: (seq: number) => this.#speechGate.waitAnchor(seq),
      },
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
  /** The in-flight turn's identity for the MERGE decision (Addendum 10): what
   *  kind started it, its (possibly already-merged) trigger text, and how many
   *  merges it carries. Null when no turn is running. */
  get activeTurn(): { kind: string; text: string; merges: number } | null {
    if (!this.#turnActive) return null;
    return { kind: this.#triggerKind, text: this.#triggerText, merges: this.#mergeCount };
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
    // QUIET MODE (🤐): a TAP is the deliberate "engage me" gesture, so it EXITS
    // quiet (manual off always wins over a timed/agent lock) and then opens
    // listening as normal. A palm (tapOpen) does NOT — see tapOpen. (Face-arrival
    // and wake windows also can't open while quiet.)
    if (this.isQuiet(now)) this.setQuiet(null);
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
    // QUIET MODE (🤐): the PALM ("listen to me") is ignored while quiet — a quiet
    // dock never opens a listening window it can't reply from. This is also the
    // gate for wake() (which calls tapOpen) and wake+command's adopt. Only a TAP
    // (tap(), the deliberate engage gesture) exits quiet. No-op cleanly.
    if (this.isQuiet(now)) return;
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
    if (this.isQuiet()) return; // 🤐 quiet mode silences the wake ack too
    const turnId = `canned-${randomUUID()}`;
    this.#sendToVoice('turn-status', { turnId, state: 'accepted', autonomous: true });
    this.#sendToVoice('speak', { turnId, seq: 0, text });
    this.#sendToVoice('turn-status', { turnId, state: 'done' });
  }

  // ── QUIET MODE (🤐) ─────────────────────────────────────────────────────────
  /** Enter/leave quiet mode. `untilMs`: Infinity = indefinite (UI toggle, until
   *  manually off); a future epoch-ms = timed (auto-unlocks); `null` = OFF NOW
   *  (manual, always wins over a timed lock). Pushes a `quiet` frame so the
   *  phone face shows/hides the 🤐 (with a countdown when timed). */
  setQuiet(untilMs: number | null): void {
    this.#quietUntil = untilMs == null ? undefined : untilMs;
    this.#d.log?.(`[quiet] ${this.dock} ${untilMs == null ? 'OFF' : untilMs === Infinity ? 'ON (indefinite)' : `ON until ${new Date(untilMs).toISOString()}`}`);
    this.#emitQuiet();
  }

  /** Whether the dock is currently quiet. Lazily expires a timed lock (and emits
   *  the un-quiet frame) so a screenshot / probe never shows stale quiet. */
  isQuiet(now = Date.now()): boolean {
    if (this.#quietUntil == null) return false;
    if (this.#quietUntil === Infinity) return true;
    if (now < this.#quietUntil) return true;
    this.#quietUntil = undefined; // timed lock expired → auto-unlock
    this.#emitQuiet();
    return false;
  }

  /** REST probe: { quiet, until } — until is 0 for indefinite/off (no countdown),
   *  else the epoch-ms the timed lock unlocks. */
  quietState(now = Date.now()): { quiet: boolean; until: number } {
    const quiet = this.isQuiet(now); // also expires a stale timed lock
    const until = this.#quietUntil && this.#quietUntil !== Infinity ? this.#quietUntil : 0;
    return { quiet, until };
  }

  /** Push the current quiet state to the phone face (renderer). `until` = the
   *  timed-unlock epoch ms (0 = indefinite or off) so the face can count down. */
  #emitQuiet(): void {
    const until = this.#quietUntil && this.#quietUntil !== Infinity ? this.#quietUntil : 0;
    try { this.#sendToVoice('quiet', { quiet: this.#quietUntil != null, until }); }
    catch { /* transport optional in tests */ }
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
  faceArrival(now = Date.now()): void {
    if (this.isQuiet(now)) return; // 🤐 a new face can't open a listen window while quiet
    this.#conv.faceArrival(now);
  }

  /** A face left the camera (releases only a low-priority face listen window —
   *  never a tap/follow-up). */
  faceLeft(now = Date.now()): void { this.#conv.faceLeft(now); }

  /** Re-send the current conversation mode (e.g. to a (re)connecting phone, which
   *  is a pure renderer with no state of its own). */
  resendConversation(): void {
    const m = this.#conv.mode(Date.now());
    try { this.#sendToVoice('conversation', { from: m, to: m, reason: 'resync', at: Date.now() }); }
    catch { /* transport optional */ }
    this.#emitQuiet(); // a phone connecting mid-quiet must show the 🤐 immediately
  }

  /**
   * A finalized utterance ended at `endedAt`. Returns whether it's ADDRESSED (the
   * caller then runs a turn). Folds in the old addressedLatch — "are we in an open
   * listening window?" IS the decision.
   */
  utteranceAddressed(endedAt: number, now = Date.now(), startedAt?: number): boolean {
    return this.#conv.utteranceEnded(endedAt, now, startedAt);
  }

  /** The admit verdict of the most recent utteranceAddressed() — WHICH rule/window
   *  let the utterance in (or kept it out). Read right after the call; feeds the
   *  turn trigger's provenance + the addressed debug trace. */
  lastAdmit(): AdmitTrace | null { return this.#conv.lastAdmit; }

  /** Back-compat shim for the console 2c surface + tests. */
  setListening(listening: boolean): void {
    if (listening) this.#conv.tap(Date.now());
    else this.#conv.reconcileConnected(Date.now());
  }
  isListening(): boolean { return this.#conv.isListening(Date.now()); }

  /** Hold / release the dock's TTS playback mid-reply (the barge-in "polite
   *  pause"). Unlike cancel, nothing is dropped: the phone silences playback
   *  but keeps its queue + speaking signal, and hold=false continues where it
   *  stopped. The turn/conversation state here is untouched — a paused reply
   *  is still SPEAKING, so an STT final arriving during the hold routes
   *  through the normal stop-intent/busy-queue paths. */
  ttsHold(hold: boolean): void {
    this.#sendToVoice('tts-hold', { hold });
  }

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
      this.#speechGate.cancel(); // release any move gated inside the superseded turn
      this.#turnAbort.abort();
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
    // QUIET MODE (🤐): a quiet dock makes NO unprompted speech — drop every
    // autonomous turn (task reminders/notify, greetings, self-thought). This is
    // the single chokepoint for ALL station-originated turns, so a source that
    // doesn't route through raiseSelfThought (e.g. task signals) is covered too.
    // The turn is dropped, not deferred — consistent with skipping addressed
    // turns whole. Only USER turns (handleTurnRequest, gated at admission) run.
    if (this.isQuiet()) return;
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
    this.#speechGate.cancel(); // a gated move must not fire into the interruption
    this.#turnAbort.abort();
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
    this.#speechGate.cancel();
    this.#turnAbort.abort();
    this.#d.motion.stop(this.dock);
    this.#d.rpc.rejectAllForDock(this.dock, 'dock went offline');
    this.#agent?.abort();
  }

  /** Phone TTS start/drain markers → obs SpeakStart/SpeakEnd (+ TurnSettled
   *  when the TTS tail drains after the loop closed — the end of the whole
   *  user-perceived turn). */
  noteSpeech(speaking: boolean, keepalive = false): void {
    // KEEPALIVE (build 34+): the phone re-asserts speaking every ~5s while
    // audio actually plays or is held, flagged so it can NEVER be mistaken for
    // an edge — it only refreshes the SPEAK_MAX_MS cap (2026-07-15: the cap
    // settled the turn + drained the busy queue over a still-playing story).
    // speakRefresh no-ops unless already SPEAKING, so a late in-flight
    // keepalive after a dismiss/tap-interrupt can't re-enter 'speaking',
    // re-gate wakes for 30s, or clobber the tap's listening window. No obs
    // marker: keepalives aren't SpeakStart edges.
    if (keepalive) { this.#conv.speakRefresh(Date.now()); return; }
    // TTS start/end drives the conversation state machine: speaking → SPEAKING;
    // end → FOLLOWUP (auto re-listen). The machine bounds SPEAKING (SPEAK_MAX_MS)
    // so a lost end-frame can't wedge it, and reconcileConnected clears it on
    // reconnect — the two real recoveries (no blind latch).
    const wasSpeaking = this.#conv.mode(Date.now()) === 'speaking';
    if (speaking) this.#conv.speakStart(Date.now());
    else this.#conv.speakEnd(Date.now());
    // TTS queue drained → everything sent so far was SPOKEN: release any move
    // gated on "after my words" (motion-speech-timing).
    if (!speaking) this.#speechGate.noteQuiet();
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
    // The listening-window/mode LIFECYCLE on the durable timeline: open (reason
    // tap/palm-address/reply-followup/…), expire (window-timeout), consume
    // (addressed-utterance), speak edges, safety prunes. Extends don't transition
    // (same mode) — windowUntil on each event carries the current horizon instead.
    recordConvEvent({
      dockId: this.dock, lane: 'conv', type: `conv:${t.to}`, verdict: t.reason,
      ts: t.at, detail: { from: t.from, windowUntil: this.#conv.snapshot(t.at).windowUntil },
    });
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
    // deferred self-close (end_session tool): the sign-off has drained — close
    // BEFORE the drain so a queued utterance opens the fresh session instead
    // of landing in the dying one.
    if (this.#endRequested) this.endSession('requested');
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
    this.#endRequested = false; // any close path satisfies/voids a pending self-close
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
      // capture-what-was-sent seam: the context arg IS the request, byte-for-
      // byte. Snapshot it here (persisted on the matching StepEnd, which is the
      // first point that knows the step's identity) and defer to the injected
      // transport — or pi's own default when none is injected.
      streamFn: ((model, context, options) => {
        this.#pendingRequest = serializeRequest(context);
        return (this.#replayStreamFn ?? this.#d.streamFn ?? streamSimple)(model, context, options);
      }) as import('@earendil-works/pi-agent-core').StreamFn,
    });
    agent.subscribe((event) => this.#onAgentEvent(event));
    this.#agent = agent;
    this.#d.log?.(`[brain] ${this.dock}: session ${this.#meta.sessionId} ${existing ? 'resumed' : 'opened'} (${messages.length} msgs)`);
    return agent;
  }

  async #runTurn(req: TurnRequest): Promise<void> {
    const agent = this.#ensureSession();
    // REPLAY leaves no trace: snapshot the history now, restore it in finally.
    const preReplayMessages = req.replay ? agent.state.messages.slice() : undefined;

    // conversation: a turn is running → THINKING (closes any listening window).
    this.#conv.turnStart(Date.now());

    // reset per-turn state
    this.#activeTurnId = req.turnId;
    // per-turn replay latch: EVERY turn assigns it (undefined on normal turns),
    // so a stale replay transport can never survive into a real turn.
    this.#replayStreamFn = req.replay ? makeReplayStreamFn(req.replay) : undefined;
    this.#triggerText = req.trigger.text;
    this.#triggerKind = req.trigger.kind || 'user';
    this.#triggerVia = req.trigger.via;
    this.#triggerWindow = req.trigger.window;
    this.#triggerUtterance = req.trigger.utteranceId;
    this.#triggerStt = req.stt;
    this.#turnImage = undefined;
    this.#mergeCount = req.merges ?? 0;
    this.#stationOriginated = req.stationOriginated === true;
    this.#cancelled = false;
    this.#timedOut = false;
    this.#spokeThisTurn = false;
    this.#moodEnabled = this.#d.config('brainInlineMood') !== false;
    this.#spokenSentences = [];
    this.#toolRanThisTurn = false;
    this.#streamer = new SentenceStreamer();
    this.#speakSeq = 0;
    this.#stepStartSpeakSeq = 0;
    this.#speechGate.reset(); // a stale [move] anchor or gated waiter must not leak into this turn
    this.#turnAbort = new AbortController(); // fresh signal — the last turn's abort must not kill this one
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
    const camOnline = this.#d.directory.resolveCap(this.dock, 'camera') != null;
    const bodyLine = (this.#d.directory.resolveCap(this.dock, 'servo') != null
      ? `Body: CONNECTED — currently ${this.#d.motion.pose(this.dock) ?? 'at rest'}. `
        + 'Parts you can move — neck (head tilt), foot (base swivel); use the move tool '
        + '(relative:true for "turn more/again").'
      : 'Body: NOT connected (movement requests will be ignored).')
      + (camOnline ? ' Camera: LIVE.' : ' Camera: OFFLINE.')
      // Components flap; the transcript remembers their outages as vivid tool
      // errors long after recovery (live turn-a3f: "my body is still offline"
      // while the body stood connected — the model trusted its own history
      // over this line). THIS line is the present tense; say so explicitly.
      + ' This status line is CURRENT as of this turn — if earlier messages in this conversation'
      + ' said a body/camera/tool was offline or unable, that is OUTDATED; trust this line and try again.';
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
    // HEARING-IDENTITY (voice fingerprint): who the CURRENT utterance sounded like —
    // deliberately separate from who the dock SEES (the identity/face records inside
    // the grounding). A confident voice match names the interlocutor; an unmatched
    // voice is stated as unknown so the agent doesn't guess (a playing video can
    // sound like an enrolled person — the words + what it sees must corroborate).
    const heardVoice = req.stt?.voice;
    if (heardVoice) {
      const pct = heardVoice.score != null ? `${Math.round(heardVoice.score * 100)}% voice match` : 'unscored';
      // One factual line, not instructions (over-instruction backfires — the
      // self-thought RCA). "even off-camera" is the only clause that earned its
      // place: live turn-531f9873 deflected a matched speaker to "step into view"
      // after recollect_face saw no one.
      // name 'unknown' = empty gallery or the "other" decoy caught it — rendering
      // "closest: unknown, 88%" would be a self-contradictory fact in the prompt.
      const hearing = heardVoice.match
        ? `Hearing (voice-id): ${heardVoice.name}, ${pct} — your interlocutor, even if off-camera.`
        : heardVoice.name === 'unknown'
          ? 'Hearing (voice-id): not a voice you know.'
          : `Hearing (voice-id): unrecognized (closest: ${heardVoice.name}, ${pct}).`;
      grounding = grounding ? `${grounding}\n${hearing}` : hearing;
      this.#d.log?.(`[brain] ${this.dock}: hearing-identity → ${heardVoice.name} ${pct}${heardVoice.match ? '' : ' (below bar)'}`);
    }
    // the dock's EGO — its current evolving self, injected as WHO IS SPEAKING (ego.md §3.5).
    let self: string | undefined;
    try { self = this.#d.getSelf?.(this.dock); }
    catch (err) { this.#d.log?.(`[brain] ${this.dock}: ego read failed (ignored): ${String(err)}`); }
    // CACHE STABILITY v2: the system prompt is fully STATIC within a session
    // (persona/skills/memory/ego only) — every volatile per-turn piece rides
    // the user message via buildTurnContext below. See prompt.ts for why.
    agent.state.systemPrompt = buildSystemPrompt({
      persona: str(this.#d.config('brainPersona')),
      self,
      memory,
      skills: [this.#skills.promptBlock, fileAccess ? FILE_TOOLS_PROMPT : '', taskPrompt]
        .filter(Boolean).join('\n\n'),
      // false → the pre-WI-3 tool-mood prompt (kill-switch pairs with #filterMood)
      inlineMood: this.#d.config('brainInlineMood') !== false,
    });
    const turnContext = buildTurnContext({
      // a self-thought is the robot's OWN perception/awareness, not a user
      // utterance — frame it so the model doesn't reply "you said…" to itself
      // and knows it may stay silent (docs/perception-to-brain.md 2.1).
      selfThought: this.#triggerKind === 'self',
      // heard in the followup window / during the reply, not deliberately
      // addressed — the model may stay silent, which ends the followup chain.
      overheard: this.#triggerVia === 'followup-window' || this.#triggerVia === 'busy-drain',
      grounding,
      context: [bodyLine, req.context?.state].filter(Boolean).join(' '),
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
      ...buildWebSearchTools(this.dock), // web_search — only when a Gemini key is set
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
      // end_session — "start a new session" / "kill this session", spoken.
      // Deferred to settle so the sign-off gets said (see buildSessionTools).
      ...buildSessionTools(
        () => { this.#endRequested = true; },
        () => (this.#meta ? this.#d.hasRunningTasks?.(this.dock, this.#meta.sessionId) === true : false),
      ),
      // keep_quiet — "be quiet" / "stop talking for a bit", spoken. Sets the
      // quiet flag; this turn's ack is still spoken, quiet holds from next turn.
      ...buildQuietTools((untilMs) => this.setQuiet(untilMs)),
    ];
    // REPLAY tool policy: embodiment runs real, external effects return their
    // recorded results (the canned assistant messages reuse recorded call ids).
    if (req.replay) agent.state.tools = wrapToolsForReplay(agent.state.tools, req.replay);
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
      voice: req.stt?.voice, // hearing-identity → face tools answer with both channels
      signal: this.#turnAbort.signal, // long tools (visual_search) stop when the turn dies
    };
    // vision-gate bypass for task turns: the triggering frame IS the evidence,
    // and task text won't match the vision-intent regex (tasks §7a).
    const gate = VISION_GATE && this.#triggerKind === 'user';
    const content: (TextContent | ImageContent)[] = [{ type: 'text', text: `${turnContext}\n\n${req.trigger.text}` }];
    if (!gate || isVisionIntent(req.trigger.text)) {
      // no live-frame grab on a replay: the responses are canned, an image is dead weight
      const grabbed = req.imageBase64 == null && streamId != null && !req.replay
        ? this.#d.getFaces()?.frame(streamId) : undefined;
      const image = req.imageBase64 ?? grabbed;
      if (image) {
        content.push({ type: 'image', data: image, mimeType: req.imageBase64 ? (req.imageMime ?? 'image/jpeg') : 'image/jpeg' });
        this.#debug('vision', { source: req.imageBase64 ? 'phone-photo' : 'sfu-frame' });
        // Keep the EXACT frame the model saw (the request ring strips images):
        // bounded dump keyed dock/turnId, ref rides TurnStart → TurnRecord.image →
        // the obs UI renders the thumbnail. "What did it actually look at?" must
        // never be unanswerable on a vision turn.
        this.#turnImage = saveTurnImage(this.dock, req.turnId, image);
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
      // kind lets the phone fire the HEARD cue only for the USER's own speech
      // (an adopted task/self turn is the robot acting alone — no flash).
      kind: this.#triggerKind,
    });

    const timeoutMs = num(this.#d.config('brainTurnTimeoutMs'), 60_000);
    const timer = setTimeout(() => {
      this.#timedOut = true;
      this.#speechGate.cancel(); // a move gated on speech must not outlive the turn
      this.#turnAbort.abort();
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
        const tail = this.#streamer.flush();
        if (tail != null) this.#speak(tail);
      }

      // REPLAY: restore the pre-turn history and skip persistence — the canned
      // exchange must not enter the session's real transcript or context.
      if (preReplayMessages) agent.state.messages = preReplayMessages;
      if (this.#meta && !req.replay) this.#d.store.turnEnded(this.dock, this.#meta.sessionId, agent.state.messages);
      // obs records the TERMINAL STATE (cancelled turns were previously
      // indistinguishable from done ones in /api/observability — a merge-
      // superseded turn must show as cancelled, per Addendum 10).
      this.#shipObs('TurnEnd', {
        state: this.#cancelled ? 'cancelled' : failCode != null ? 'failed' : 'done',
        ...(this.#mergeCount > 0 ? { merges: this.#mergeCount } : {}),
      });

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
      if (this.#meta && !req.replay) {
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
    // Strip the volatile turn-context block from PAST user messages (it was only
    // ever situational — stale grounding/clock in history misleads the model and
    // bloats every future request). Only the most recent message ever has one,
    // so at most ONE message changes per request → the cache prefix keeps
    // everything before it.
    let strippedAny = false;
    for (let i = repaired.length - 1; i >= 0; i--) {
      const m = repaired[i] as { role?: string; content?: unknown };
      if (m.role !== 'user' || !Array.isArray(m.content)) continue;
      const c0 = m.content[0] as { type?: string; text?: string };
      if (c0?.type === 'text' && typeof c0.text === 'string') {
        const stripped = stripTurnContext(c0.text);
        if (stripped !== c0.text) {
          repaired[i] = { ...m, content: [{ ...c0, text: stripped }, ...m.content.slice(1)] } as AgentMessage;
          strippedAny = true;
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
    if (result.length !== msgs.length || strippedAny) agent.state.messages = result;
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
          trigger: { kind: this.#triggerKind, text: this.#triggerText,
            ...(this.#triggerVia ? { via: this.#triggerVia } : {}),
            ...(this.#triggerWindow ? { window: this.#triggerWindow } : {}),
            ...(this.#triggerUtterance ? { utteranceId: this.#triggerUtterance } : {}) },
          ...(this.#turnImage ? { image: this.#turnImage } : {}),
          ...(this.#triggerStt ? { stt: this.#triggerStt } : {}),
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
          const tail = this.#streamer.flush();
          if (tail != null) this.#speak(tail);
        }
        this.#streamer = new SentenceStreamer();
        this.#shippedStreamStart = false;
        this.#stepIndex++;
        this.#stepStartSpeakSeq = this.#speakSeq; // "spoke before the tool call?" is judged per STEP
        this.#stepStartedAt = Date.now();
        this.#stepTtft = undefined;
        this.#stepThinkAt = undefined;
        this.#stepTextAt = undefined;
        this.#stepThinkChars = 0;
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
          this.#stepThinkChars += ame.delta?.length ?? 0;
          this.#debug('thinking-delta', { delta: ame.delta });
        }
        // Tags ride RAW through the streamer (a tag contains no terminal
        // punctuation, so no sentence boundary can fall inside one — a partial
        // tag stays buffered). Extraction happens per-sentence in #speak.
        const text = assistantText(event.message);
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
          // Flush the streamer's tail NOW — before this step's tools execute.
          // The tail used to wait for the next step's turn_start, which runs
          // AFTER tools: a [move] tag on the step's LAST sentence never
          // reached #speak before the move tool consumed its anchor (live
          // turn-863f68ff: "…one… [move]go wiggle!" — the wiggle ran during
          // the countdown and "go wiggle!" played after it). Flushing here
          // puts every spoken word of the step ahead of its motion gate.
          const tail = this.#streamer.flush();
          if (tail != null) this.#speak(tail);
          // strip the inline mood tag so the console/obs history shows what
          // was actually SAID, not the control token — but keep the RAW form
          // too: turn-replay needs the tags, and the session transcript that
          // also holds them is bounded (history trim loses old turns).
          const rawAssistant = assistantText(event.message);
          this.#shipObs('MessageEnd', { text: stripMoodTag(rawAssistant), rawText: rawAssistant });
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
            // ESTIMATE (chars/4 of the streamed thoughts): providers bill
            // thinking inside `output` and pi keeps no split — this shows how
            // much of that output was reasoning, not reply.
            ...(this.#stepThinkChars > 0 ? { thinkingTokens: Math.round(this.#stepThinkChars / 4) } : {}),
          } : undefined,
        });
        // persist the captured request under the ids the obs tree uses, so the
        // console's step row can show exactly what this step sent.
        if (this.#pendingRequest && this.#meta) {
          try {
            this.#d.recordRequest?.(this.#meta.sessionId, this.#obsTurnId, this.#stepIndex, this.#pendingRequest);
          } catch (err) {
            this.#d.log?.(`[brain] ${this.dock}: request-record failed (trace unaffected): ${String(err)}`);
          }
          this.#pendingRequest = undefined;
        }
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
    // The interim is also SPEECH-IN-FLIGHT EVIDENCE from the pipeline that owns
    // the utterance timestamps (Addendum 8): hold the listening window while
    // the transcriber has speech open — replaces the phone-VAD hold/endpoint,
    // whose independent clock closed windows under in-flight utterances.
    this.#conv.speechInFlight(Date.now());
    this.#sendToVoice('transcript-interim', { text, seq, isFinal: false });
  }

  /** Inline mood tag (WI-3 → Fix 5): a LEADING `[face:NAME]` on a sentence is
   *  that sentence's mood — extracted here, at the moment the sentence leaves
   *  for the voice, and shipped ON its speak frame so the phone can apply it
   *  when the utterance starts PLAYING. (The tag exists to avoid a second
   *  serial LLM step — full ttft on a ~23k prompt, the dominant term in reply
   *  latency. Firing it at PARSE time was the original sin: audio starts ~4s
   *  after parse and a 95s story wore its last face from the first word.)
   *
   *  Stripping is global (turn-75cb44ad: the model reads "start every reply
   *  with a tag" per LINE — only the leading one was removed and the dock
   *  SPOKE "face neutral" 24 times); the mood is the sentence's FIRST tag.
   *  Unknown names strip-but-ignore (better silent than spoken). */
  #extractMood(sentence: string): { text: string; mood?: string } {
    if (!this.#moodEnabled) return { text: sentence };
    const m = sentence.match(MOOD_TAG_RE);
    const text = stripMoodTag(sentence).trim();
    const name = m?.[1]?.toLowerCase();
    if (name != null && !FACES.includes(name as never)) {
      this.#d.log?.(`[brain] ${this.dock}: inline mood ignored (unknown face "${name}")`);
      return { text };
    }
    return name != null ? { text, mood: name } : { text };
  }

  /** The phone reports a sentence's mood just went LIVE on its screen (Fix 5:
   *  the mood rides the speak frame and applies at playback start). The
   *  station's half: play the paired body gesture NOW — choreography tracks
   *  the AUDIO clock, not the parse — and put the application on the turn
   *  trace (turn-44e8c4ff: the body moved and observability had nothing to
   *  say why). */
  moodActive(p: { turnId?: unknown; seq?: unknown; expression?: unknown }): void {
    const expression = typeof p.expression === 'string' ? p.expression.toLowerCase() : '';
    if (!FACES.includes(expression as never)) return;
    // a mood ack IS a playback-start report — feed the motion gate too, so a
    // [move] anchored on a mood-tagged sentence releases even on app builds
    // that predate the generic utterance-active ack.
    if (typeof p.seq === 'number') this.#speechGate.noteUtteranceActive(p.seq);
    try {
      this.#d.motion.playGesture(this.dock, expression,
        gesturesFromConfig(this.#d.config('faceGestures')) as Record<string, MoveStep[]>,
        `face:${expression}`);
    } catch { /* body offline — the face already changed */ }
    this.#traceMood(expression, typeof p.seq === 'number' ? p.seq : undefined, 'phone');
  }

  /** Mid-turn speech was CAPTURED (merged into the in-flight turn, or queued
   *  for after the reply) — tell the phone so it can flash the HEARD cue. The
   *  user is often across the room; "did it hear me?" was unanswerable from
   *  there (UX ask 2026-07-17). */
  notifyHeardDuringTurn(via: 'merge' | 'queued'): void {
    this.#sendToVoice('heard-during-turn', { via });
  }

  /** The phone reports a speak-frame's audio just started PLAYING (the
   *  `ack:true` sentences — motion-speech-timing). Releases a move gated on
   *  that sentence's [move] anchor. */
  utteranceActive(p: { turnId?: unknown; seq?: unknown }): void {
    if (typeof p.seq !== 'number') return;
    this.#speechGate.noteUtteranceActive(p.seq);
    this.#debug('utterance-active', { seq: p.seq });
  }

  /** An inline mood becoming REAL is an action in the world, but it bypasses
   *  pi's tool loop — so nothing traced it (the turn-44e8c4ff gap). Record it
   *  as a synthetic tool execution: the existing inspector renders it with no
   *  new obs vocabulary. */
  #traceMood(expression: string, seq: number | undefined, appliedBy: 'station' | 'phone'): void {
    const toolCallId = `mood-${this.#obsTurnId}-${seq ?? 'solo'}`;
    const args = { expression, ...(seq != null ? { seq } : {}), appliedBy };
    this.#shipObs('ToolExecutionStart', { toolCallId, toolName: 'inline_mood', args });
    this.#shipObs('ToolExecutionEnd', {
      toolCallId, toolName: 'inline_mood', isError: false,
      result: `face ${expression} live (applied by ${appliedBy})`,
    });
    this.#debug('mood-active', args);
  }

  /** A mood with no words to ride (the reply was ONLY a tag — e.g. the
   *  stay-silent convention answers with a bare mood): apply station-side,
   *  now, same effects as the set_face tool (gesture in-process, face UI via
   *  phone RPC), best-effort and NOT awaited. */
  #fireMood(expression: string): void {
    this.#traceMood(expression, undefined, 'station');
    fireFace({
      dock: this.dock, motion: this.#d.motion, rpc: this.#d.rpc,
      gestures: gesturesFromConfig(this.#d.config('faceGestures')) as Record<string, MoveStep[]>,
      turnId: this.#activeTurnId ?? '', toolCallId: `mood-${this.#obsTurnId}`,
      expression, warn: (msg) => this.#d.log?.(`[brain] ${this.dock}: inline mood ${msg}`),
    });
  }

  /** One spoken sentence → directed speak frame to the voice component.
   *  The sentence arrives RAW from the streamer; its mood tag (if any) is
   *  extracted here and rides the same frame — the phone applies it when this
   *  utterance starts playing, so face and words stay in step. A tag with no
   *  words left after stripping fires station-side immediately (nothing to
   *  synchronize with). */
  #speak(sentence: string): void {
    // The [move] anchor (motion-speech-timing): detected BEFORE stripping (the
    // mood strip removes it too), it pins the pending move to THIS sentence's
    // playback start. `ack:true` asks the phone to report that start
    // (utterance-active) — old app builds ignore it and the gate falls back
    // to the quiet/timeout path.
    const hasMoveAnchor = MOVE_TAG_RE.test(sentence);
    const { text, mood } = this.#extractMood(sentence);
    if (text.length === 0) {
      if (mood != null) this.#fireMood(mood);
      if (hasMoveAnchor) this.#speechGate.noteAnchor(this.#speakSeq - 1); // bare tag: anchor to the last real sentence
      return; // never ship an empty utterance
    }
    this.#spokeThisTurn = true;
    this.#spokenSentences.push(text);
    const seq = this.#speakSeq++;
    this.#speechGate.noteSent(text.length);
    if (hasMoveAnchor) this.#speechGate.noteAnchor(seq);
    this.#sendToVoice('speak', {
      turnId: this.#activeTurnId, seq, text,
      ...(mood != null ? { mood } : {}),
      ...(hasMoveAnchor ? { ack: true } : {}),
    });
    this.#debug('speak', { seq, text, ...(mood != null ? { mood } : {}), ...(hasMoveAnchor ? { moveAnchor: true } : {}) });
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

/** Persist the input frame a vision turn's model actually saw (the request ring
 *  strips image bytes). Bounded dump like the utterance WAVs: prune oldest past
 *  the budget, every Nth save. Returns the ref (`<dock>/<turnId>.jpg`) served by
 *  GET /api/observability/turn-image?f=<ref>, or undefined when the write fails. */
const TURN_IMAGE_BUDGET_BYTES = Number(process.env.OBS_TURN_IMAGE_MB ?? 200) * 1024 * 1024;
let turnImageSavesSincePrune = 0;
export function saveTurnImage(dock: string, turnId: string, base64: string): string | undefined {
  try {
    const safeTurn = turnId.replace(/[^a-zA-Z0-9._-]/g, '_');
    const dir = `.data/turn-images/${dock}`;
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${safeTurn}.jpg`), Buffer.from(base64, 'base64'));
    if (++turnImageSavesSincePrune >= 20) {
      turnImageSavesSincePrune = 0;
      const sizes = new Map(readdirSync(dir).filter((f) => f.endsWith('.jpg'))
        .map((f) => [f, statSync(join(dir, f))] as const)
        .sort((a, b) => a[1].mtimeMs - b[1].mtimeMs)
        .map(([f, st]) => [f, st.size] as const));
      let total = [...sizes.values()].reduce((n, s) => n + s, 0);
      for (const [f, size] of sizes) {
        if (total <= TURN_IMAGE_BUDGET_BYTES) break;
        try { unlinkSync(join(dir, f)); total -= size; } catch { /* */ }
      }
    }
    return `${dock}/${safeTurn}.jpg`;
  } catch { return undefined; }
}

/** Content-addressed dump of request images (sha1 of the base64 → one file per
 *  UNIQUE frame, however many requests repeat it). Bounded like the other dumps. */
const REQ_IMAGE_BUDGET_BYTES = Number(process.env.OBS_REQ_IMAGE_MB ?? 100) * 1024 * 1024;
let reqImageSavesSincePrune = 0;
function saveReqImage(base64: string | undefined): string | undefined {
  if (!base64) return undefined;
  try {
    const ref = `${createHash('sha1').update(base64).digest('hex').slice(0, 20)}.jpg`;
    const dir = '.data/req-images';
    const file = join(dir, ref);
    if (!existsSync(file)) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(file, Buffer.from(base64, 'base64'));
      if (++reqImageSavesSincePrune >= 50) {
        reqImageSavesSincePrune = 0;
        const entries = readdirSync(dir).filter((f) => f.endsWith('.jpg'))
          .map((f) => { const st = statSync(join(dir, f)); return [f, st.size, st.mtimeMs] as const; })
          .sort((a, b) => a[2] - b[2]);
        let total = entries.reduce((n, [, size]) => n + size, 0);
        for (const [f, size] of entries) {
          if (total <= REQ_IMAGE_BUDGET_BYTES) break;
          try { unlinkSync(join(dir, f)); total -= size; } catch { /* */ }
        }
      }
    }
    return ref;
  } catch { return undefined; }
}

/** Serialize one LLM request (the streamFn `context` arg — literally what goes
 *  to the provider) for the obs request ring. Images are replaced with a size
 *  marker: a vision frame is ~100 KB of base64 that's already observable via
 *  perception, and it would triple the row for zero debug value. Tool SCHEMAS
 *  are static per build — names alone identify what the model saw. */
export function serializeRequest(context: Context): string {
  const messages = context.messages.map((m) => {
    const content = (m as { content?: unknown }).content;
    if (!Array.isArray(content)) return m;
    return {
      ...m,
      content: content.map((part) => {
        const p = part as { type?: string; data?: string };
        return p.type === 'image'
          // Bytes still stripped from the ring row (they'd shrink its window ~10×),
          // but each unique frame is saved ONCE to a content-addressed dump —
          // history repeats the same frames every request, so dedup makes "show
          // the images the model saw" nearly free. imageRef serves via
          // GET /api/observability/req-image?f=<ref>.
          ? { type: 'image', imageRef: saveReqImage(p.data),
              omitted: `[image stripped, ${p.data?.length ?? 0} base64 chars]` }
          : part;
      }),
    };
  });
  return JSON.stringify({
    systemPrompt: context.systemPrompt,
    tools: context.tools?.map((t) => t.name),
    messages,
  });
}

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

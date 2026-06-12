/**
 * DockBrainSession — one dock's brain lane (docs/SERVER-BRAIN-IMPL.md §3.1).
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
  type AssistantMessage,
  type ImageContent,
  type Model,
  type TextContent,
  type ToolCall,
  type ToolResultMessage,
} from '@earendil-works/pi-ai';
import type { Bus } from '../../core/bus.js';
import type { Directory } from '../docks/directory.js';
import type { MotionExecutor } from '../bodylink/motion.js';
import type { FaceToolsApi } from '../perception/index.js';
import { gesturesFromConfig } from '../bodylink/motion.js';
import { buildSystemPrompt, isVisionIntent } from './prompt.js';
import { RpcBroker } from './rpc.js';
import { SentenceStreamer } from './sentence.js';
import { SessionStore, type SessionMeta } from './store.js';
import { buildDockTools, type ToolTurnContext } from './tools.js';
import type { MoveStep } from './schemas.js';

export interface TurnRequest {
  turnId: string;
  trigger: { kind: string; text: string };
  context?: { state?: string; battery?: number };
  imageBase64?: string;
  imageMime?: string;
}

export interface SessionDeps {
  bus: Bus;
  directory: Directory;
  rpc: RpcBroker;
  motion: MotionExecutor;
  store: SessionStore;
  getFaces: () => FaceToolsApi | undefined;
  /** effective config value by key (shared ConfigStore). */
  config: (key: string) => unknown;
  log?: (line: string) => void;
  /** test seam: scripted LLM transport (pi StreamFn). Default: pi-ai providers. */
  streamFn?: import('@earendil-works/pi-agent-core').StreamFn;
}

type FailCode = 'timeout' | 'llm_error' | 'busy';

export class DockBrainSession {
  readonly dock: string;
  #d: SessionDeps;

  #agent?: Agent;
  #meta?: SessionMeta;

  // the in-flight turn's FULL lifecycle promise (#runTurn incl. finally) and
  // the newest request — supersede ordering (see handleTurnRequest).
  #running?: Promise<void>;
  #latestReq?: TurnRequest;

  // ── per-turn state (reset in #runTurn) ────────────────────────────────────
  #activeTurnId?: string;
  #triggerText = '';
  #cancelled = false;
  #timedOut = false;
  #spokeThisTurn = false;
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
    this.#shipObsMarker(speaking ? 'SpeakStart' : 'SpeakEnd');
    if (!speaking && !this.#turnActive) this.#shipObsMarker('TurnSettled');
  }

  /** Idle-close check (clock measured from last turn END — an active turn
   *  always resets it, so closing mid-turn is impossible by construction). */
  maybeIdleClose(now = Date.now()): void {
    if (!this.#meta || this.#turnActive) return;
    const idleMin = num(this.#d.config('brainSessionIdleMin'), 30);
    if (now - this.#meta.lastTurnEndedAt > idleMin * 60_000) this.endSession('idle');
  }

  /** Continue an old session (console "continue"): closes the open one (if
   *  any), reopens the target, and drops the in-memory agent so the next turn
   *  lazy-loads the reopened transcript. */
  resume(sessionId: string): boolean {
    if (this.#meta?.sessionId === sessionId) return true; // already live
    if (this.#meta) this.endSession('switched');
    const ok = this.#d.store.reopen(this.dock, sessionId);
    if (ok) {
      this.#meta = undefined;
      this.#agent = undefined; // ensureSession reloads the reopened transcript
      this.#d.log?.(`[brain] ${this.dock}: resuming session ${sessionId}`);
    }
    return ok;
  }

  /** Close the open session (idle / console / reset): summary persisted, the
   *  next turn opens fresh. */
  endSession(reason: string): void {
    if (!this.#meta) return;
    if (this.#turnActive) this.cancel();
    const { sessionId } = this.#meta;
    const messages = this.#agent?.state.messages ?? this.#d.store.messages(this.dock, sessionId);
    // close NOW with the cheap tail digest; the LLM compaction below upgrades
    // it asynchronously (close must never wait on a model).
    this.#d.store.close(this.dock, sessionId, summarize(messages));
    this.#d.log?.(`[brain] ${this.dock}: session ${sessionId} closed (${reason})`);
    this.#meta = undefined;
    this.#agent = undefined;
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
        ...(this.#d.streamFn ? { streamFn: this.#d.streamFn } : {}),
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
        tools: buildDockTools({
          dock: this.dock,
          rpc: this.#d.rpc,
          motion: this.#d.motion,
          getFaces: this.#d.getFaces,
          getGestures: () => gesturesFromConfig(this.#d.config('faceGestures')) as Record<string, MoveStep[]>,
          getTurnContext: () => this.#turnCtx,
        }),
        messages,
      },
      getApiKey: (provider) => apiKeyFor(provider),
      ...(this.#d.streamFn ? { streamFn: this.#d.streamFn } : {}),
    });
    agent.subscribe((event) => this.#onAgentEvent(event));
    this.#agent = agent;
    this.#d.log?.(`[brain] ${this.dock}: session ${this.#meta.sessionId} ${existing ? 'resumed' : 'opened'} (${messages.length} msgs)`);
    return agent;
  }

  async #runTurn(req: TurnRequest): Promise<void> {
    const agent = this.#ensureSession();

    // reset per-turn state
    this.#activeTurnId = req.turnId;
    this.#triggerText = req.trigger.text;
    this.#cancelled = false;
    this.#timedOut = false;
    this.#spokeThisTurn = false;
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
      ? 'Body: CONNECTED. Parts you can move — neck (head tilt), foot (base swivel); use the move tool.'
      : 'Body: NOT connected (movement requests will be ignored).';
    // session seeding: the most recent CLOSED session's memory note rides the
    // system prompt, so a fresh engagement still knows this morning's context.
    const memory = this.#d.store.sessions(this.dock)
      .find((m) => m.closedAt != null && m.summary && m.sessionId !== this.#meta?.sessionId)?.summary;
    agent.state.systemPrompt = buildSystemPrompt({
      persona: str(this.#d.config('brainPersona')),
      memory,
      context: [bodyLine, req.context?.state].filter(Boolean).join(' '),
    });
    agent.state.model = this.#resolveModel();
    agent.state.thinkingLevel = (str(this.#d.config('brainThinkingLevel')) ?? 'off') as never;
    this.#debug('turn-start', {
      text: req.trigger.text,
      model: `${agent.state.model.provider}/${agent.state.model.id}`,
      thinkingLevel: agent.state.thinkingLevel,
      historyMessages: agent.state.messages.length,
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
    const gate = this.#d.config('brainVisionGate') !== false;
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

    this.#sendToVoice('turn-status', { turnId: req.turnId, state: 'accepted' });

    const timeoutMs = num(this.#d.config('brainTurnTimeoutMs'), 60_000);
    const timer = setTimeout(() => {
      this.#timedOut = true;
      agent.abort();
    }, timeoutMs);

    let failCode: FailCode | undefined;
    try {
      await agent.prompt([{ role: 'user', content, timestamp: Date.now() } as AgentMessage]);
      const errMsg = agent.state.errorMessage;
      if (this.#timedOut) failCode = 'timeout';
      else if (!this.#cancelled && errMsg) failCode = 'llm_error';
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

      if (this.#meta) this.#d.store.turnEnded(this.dock, this.#meta.sessionId, agent.state.messages);
      this.#shipObs('TurnEnd');

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
      } else {
        this.#sendToVoice('turn-status', { turnId: req.turnId, state: 'done' });
      }
      this.#activeTurnId = undefined;
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
    const cap = num(this.#d.config('brainMaxHistoryMessages'), 48);
    if (result.length > cap) {
      let boundary: number | undefined;
      for (let i = result.length - cap; i < result.length; i++) {
        if ((result[i] as { role?: string }).role === 'user') { boundary = i; break; }
      }
      if (boundary != null && boundary > 0) result = result.slice(boundary);
    }
    if (result.length !== msgs.length) agent.state.messages = result;
  }

  /** Translate pi loop events → speak frames + status + obs DTOs. NOTE the
   *  vocabulary shift: current upstream pi calls one LLM call+tools a "turn"
   *  and the whole prompt() run "agent_*" — our obs model (AGENT-MODEL.md)
   *  calls those Step and Turn; mapped here. */
  #onAgentEvent(event: AgentEvent): void {
    switch (event.type) {
      case 'agent_start':
        // NOT lastUserText(agent): pi emits agent_start BEFORE appending the
        // new user message, so deriving the trigger from history labeled
        // every turn with the PREVIOUS utterance (seen live on the console).
        this.#shipObs('TurnStart', {
          trigger: { kind: 'user', text: this.#triggerText },
        });
        break;
      case 'turn_start':
        this.#shippedStreamStart = false;
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
          this.#shipObs('MessageEnd', { text: assistantText(event.message) });
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
        this.#shipObs('StepEnd', {
          model: (m as { model?: string }).model ?? '',
          stopReason: (m as { stopReason?: string }).stopReason,
          usage: m.usage ? { inputTokens: m.usage.input, outputTokens: m.usage.output } : undefined,
        });
        this.#debug('step-end', {
          step: this.#stepIndex,
          ms: Date.now() - this.#stepStartedAt,
          ttftMs: this.#stepTtft,
          // the reasoning phase: first thinking token → first answer token
          // (or step end when the step never produced answer text)
          thinkingMs: this.#stepThinkAt != null
            ? (this.#stepTextAt ?? Date.now()) - this.#stepThinkAt
            : undefined,
          ttftTextMs: this.#stepTextAt != null ? this.#stepTextAt - this.#stepStartedAt : undefined,
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

  /** One spoken sentence → directed speak frame to the voice component. */
  #speak(sentence: string): void {
    this.#spokeThisTurn = true;
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

/** provider → station env var. Keys never live in device builds anymore. */
export function apiKeyFor(provider: string): string | undefined {
  const env = process.env;
  switch (provider) {
    case 'google': return env.GEMINI_API_KEY ?? env.GOOGLE_API_KEY;
    case 'anthropic': return env.ANTHROPIC_API_KEY;
    case 'openai': return env.OPENAI_API_KEY;
    case 'openrouter': return env.OPENROUTER_API_KEY;
    default: return undefined;
  }
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
      const t = assistantText(m);
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

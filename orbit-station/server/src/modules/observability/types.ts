/**
 * Observability types — a faithful TS mirror of agent-core's vocabulary so any
 * agent-core host (the dock app today) can ship its loop events here verbatim.
 *
 * Source of truth: node-dock/app/agent-core/AGENT-MODEL.md
 *   Session ⊃ Turns ⊃ Steps ⊃ (one LLM call each)
 *   AgentEvent: node-dock/app/agent-core/.../agent/Types.kt
 *
 * A host emits a flat stream of AgentEventDto frames within a turn; the station
 * reconstructs the nested Session/Turn/Step tree from them.
 */

/** Mirrors AgentEvent (agent/Types.kt) — the events agent-core's loop emits. */
export type AgentEventKind =
  | 'TurnStart'
  | 'TurnEnd'
  | 'StepStart'
  | 'StepEnd'
  | 'MessageStart'
  | 'MessageUpdate'
  | 'MessageEnd'
  | 'ToolExecutionStart'
  | 'ToolExecutionUpdate'
  | 'ToolExecutionEnd'
  // synthetic markers the dock emits (not agent-core events):
  | 'SpeakStart'
  | 'SpeakEnd';

/**
 * One agent-core event as it crosses the wire. The host stamps it with the
 * session/turn it belongs to so the station can thread a multi-turn session.
 */
export interface AgentEventDto {
  /** which Session (shared message history) this belongs to. host-assigned. */
  sessionId: string;
  /** which Turn (one prompt() → complete response) within the session. */
  turnId: string;
  /** monotonically increasing within a turn; used to order steps/LLM-calls. */
  seq: number;
  kind: AgentEventKind;
  ts: number;
  /** event-specific detail (tool name + args, message text, stop reason, …). */
  data?: {
    toolCallId?: string;
    toolName?: string;
    args?: unknown;
    isError?: boolean;
    result?: string;
    text?: string;
    trigger?: { kind: string; text?: string };
    stopReason?: string;
    /** usage if the host reports it on StepEnd / MessageEnd. */
    usage?: { inputTokens?: number; outputTokens?: number };
    model?: string;
    [k: string]: unknown;
  };
}

// ── reconstructed tree (what the station stores + serves to the UI) ──────────

export interface ToolCallRecord {
  toolCallId: string;
  toolName: string;
  args?: unknown;
  isError?: boolean;
  /** the tool's response text (what it returned to the model). */
  result?: string;
  startedAt: number;
  endedAt?: number;
}

/** A Step = one LLM call + the tool executions it triggered. */
export interface StepRecord {
  index: number;
  startedAt: number;
  /** when the first real output token streamed (generate→stream boundary). */
  streamStartedAt?: number;
  endedAt?: number;
  model?: string;
  stopReason?: string;
  text?: string;
  usage?: { inputTokens?: number; outputTokens?: number };
  tools: ToolCallRecord[];
}

/** A Turn = one prompt() → complete response, 1+ steps. */
/** A speech (TTS) window within a turn: dock was talking from startedAt→endedAt. */
export interface SpeechWindow { startedAt: number; endedAt?: number }

/**
 * What started a turn. A turn is trigger-agnostic (AGENT-MODEL.md): today the
 * only `kind` is "user" (speaks/types), `text` = the utterance. Future kinds —
 * "heartbeat", "schedule", "node" (another orbit node), etc. — set a different
 * kind and carry their own payload in `text`. The UI badges on `kind`.
 */
export interface Trigger { kind: string; text?: string }

export interface TurnRecord {
  turnId: string;
  sessionId: string;
  /** what started this turn (user utterance today; see Trigger). */
  trigger?: Trigger;
  /** TTS speaking windows (the dock may speak in multiple chunks). */
  speech?: SpeechWindow[];
  startedAt: number;
  endedAt?: number;
  steps: StepRecord[];
  /** llm calls = steps that emitted tool calls + 1 (per AGENT-MODEL.md). */
  llmCalls: number;
}

/** A Session = turns sharing one message history. */
export interface SessionRecord {
  sessionId: string;
  /** the peer (dock id) that owns this session. */
  source: string;
  firstSeen: number;
  lastSeen: number;
  turns: TurnRecord[];
}

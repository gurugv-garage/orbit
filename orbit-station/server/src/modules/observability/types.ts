/**
 * Observability types — a faithful TS mirror of agent-core's vocabulary so any
 * agent-core host (the dock app today) can ship its loop events here verbatim.
 *
 * Source of truth: docs/brain.md (at the repo root)
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
  | 'SpeakEnd'
  // the TTS tail drained after TurnEnd → the whole user-perceived turn is over.
  | 'TurnSettled';

/**
 * One agent-core event as it crosses the wire. The host stamps it with the
 * session/turn it belongs to so the station can thread a multi-turn session.
 */
export interface AgentEventDto {
  /** which Session (shared message history) this belongs to. host-assigned. */
  sessionId: string;
  /** OPTIONAL self-declared source (the owning dock). A task process connects
   *  as its own peer (peer.id = task-<instance>), so the hub would stamp the
   *  WS source as the task, not the dock that owns it. A task sets this so its
   *  LLM spend rolls up under the dock. When absent, ingest uses the WS source. */
  source?: string;
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
    usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number; cost?: number };
    /** rich per-step timings (StepEnd) — mirrors the live inspector. */
    ms?: number;
    ttftMs?: number;
    thinkingMs?: number;
    ttftTextMs?: number;
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
  /** the step's error message when stopReason === 'error' (provider error body
   *  etc.) — shown in the inspector even when a later step recovered the turn. */
  error?: string;
  text?: string;
  usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number; cost?: number };
  /** rich timings the host reports on StepEnd (mirrors the live brain-debug
   *  inspector so a resumed session renders identically). */
  ms?: number;
  ttftMs?: number;
  thinkingMs?: number;
  ttftTextMs?: number;
  tools: ToolCallRecord[];
}

/** A Turn = one prompt() → complete response, 1+ steps. */
/** A speech (TTS) window within a turn: dock was talking from startedAt→endedAt. */
export interface SpeechWindow { startedAt: number; endedAt?: number }

/**
 * What started a turn. A turn is trigger-agnostic (brain.md): today the
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
  /** when the TTS tail finished after endedAt — the real end of the UX turn. */
  settledAt?: number;
  steps: StepRecord[];
  /** llm calls = steps that emitted tool calls + 1 (per brain.md). */
  llmCalls: number;
}

// ── cost aggregation (the Cost console tab) ─────────────────────────────────

/** How a cost rollup is sliced. `kind` = the turn's trigger kind (user vs task);
 *  `source` = the dock; `model` = the LLM each step ran on; `day` = UTC date;
 *  `usecase` = the human-readable role each call plays (Conversation,
 *  Speech-to-text, Summarizer, Memory, Background tasks). */
export type CostGroupBy = 'source' | 'kind' | 'model' | 'day' | 'usecase';

/** Summed usage for one group (or the grand total when `group` is absent). */
export interface CostBucket {
  /** the group's value (dock name / 'user'|'task' / model id / 'YYYY-MM-DD').
   *  Absent on the grand total. */
  group?: string;
  cost: number;
  inputTokens: number;
  outputTokens: number;
  /** LLM calls = steps that carried usage. */
  calls: number;
}

export interface CostSummary {
  /** window actually covered (epoch ms), echoed back for the UI. */
  from: number;
  to: number;
  total: CostBucket;
  groupBy: CostGroupBy;
  groups: CostBucket[];
}

/** A time-bucketed series: one row per day, each split by `groupBy` value. */
export interface CostSeriesPoint {
  /** UTC day, 'YYYY-MM-DD'. */
  day: string;
  /** group value → summed cost for that day. */
  byGroup: Record<string, number>;
}

/**
 * Per-session ENRICHMENT — the station-side context that isn't in the agent
 * event stream but belongs to the session for debugging: build/version
 * provenance, the effective config snapshot, the active models, and a windowed
 * slice of perception (with STT/vision confidences + raw payloads).
 *
 * This is the "instrument everything per session" surface: captured for EVERY
 * session (refreshed on turn end), persisted alongside the trace, so the
 * console and the feedback flow read ONE source of truth. The feedback flow
 * then only adds the user's words + a fresh static snapshot on top.
 */
export interface SessionEnrichment {
  /** when this enrichment was last refreshed (epoch ms). */
  updatedAt: number;
  /** build/version provenance (station git/version/node; app/firmware when known). */
  provenance?: unknown;
  /** the dock's effective brain config at capture (model, thinking, persona flags…). */
  config?: Record<string, unknown>;
  /** active models: brain model + thinking, perception sidecar models. */
  models?: { brain?: string; thinking?: string; perception?: Array<{ name: string; endpoint: string }> };
  /** the live system prompt / composition snapshot (the dock profile). */
  profile?: unknown;
  /** perception snapshots overlapping the session window (confidences + payloads). */
  perception?: unknown[];
  /** recent attention-gate decisions during the session. */
  gateDecisions?: unknown[];
  /** recent addressed-decisions for the dock. */
  addressed?: unknown[];
  /** the world-state / grounding block text at capture. */
  grounding?: string | null;
}

/** A Session = turns sharing one message history. */
export interface SessionRecord {
  sessionId: string;
  /** the peer (dock id) that owns this session. */
  source: string;
  firstSeen: number;
  lastSeen: number;
  turns: TurnRecord[];
  /** station-side per-session context (see SessionEnrichment). Optional: older
   *  sessions + sessions whose dock never enriched simply omit it. */
  enrichment?: SessionEnrichment;
}

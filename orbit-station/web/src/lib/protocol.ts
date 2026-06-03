/**
 * Client-side mirror of the station wire protocol.
 * Source of truth: server/src/core/protocol.ts — keep in sync.
 */

export type Topic = 'obs' | 'config' | 'bodylink' | 'mind' | 'station';
export type PeerRole = 'browser' | 'firmware' | 'app' | 'fake';

export interface EventFrame {
  t: 'event';
  topic: Topic;
  kind: string;
  payload: unknown;
  ts: number;
}
export interface WelcomeFrame { t: 'welcome'; id: string; serverTime: number; }
export interface ErrorFrame { t: 'error'; message: string; }
export type OutboundFrame = EventFrame | WelcomeFrame | ErrorFrame;

// agent-core observability (mirror of server/.../observability/types.ts) ──────
export type AgentEventKind =
  | 'TurnStart' | 'TurnEnd' | 'StepStart' | 'StepEnd'
  | 'MessageStart' | 'MessageUpdate' | 'MessageEnd'
  | 'ToolExecutionStart' | 'ToolExecutionUpdate' | 'ToolExecutionEnd'
  | 'SpeakStart' | 'SpeakEnd';

export interface AgentEventDto {
  sessionId: string;
  turnId: string;
  seq: number;
  kind: AgentEventKind;
  ts: number;
  data?: {
    toolCallId?: string;
    toolName?: string;
    args?: unknown;
    isError?: boolean;
    text?: string;
    stopReason?: string;
    usage?: { inputTokens?: number; outputTokens?: number };
    model?: string;
    [k: string]: unknown;
  };
}

export interface PeerInfo {
  role: PeerRole; id: string; label?: string; dock?: string; bodyAddr?: string;
  ip?: string; lastSeen: number; connectedAt: number; links?: Record<string, boolean>; topics: Topic[];
}

// dock directory (mirror of server/.../core/protocol.ts) ──────────────────────
export interface DockMember {
  role: PeerRole; id: string; label?: string; online: boolean; ip?: string; lastSeen?: number;
  links?: Record<string, boolean>;
}
export interface DockInfo {
  name: string;
  bodyAddr?: string;
  app?: DockMember;
  firmware?: DockMember;
}

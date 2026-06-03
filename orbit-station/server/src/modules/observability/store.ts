/**
 * Reconstructs the Session/Turn/Step tree from the flat AgentEventDto stream,
 * keeping a bounded in-memory history. The dock app emits agent-core's
 * AgentEvents; this threads them back into the nested model the UI shows.
 */

import type {
  AgentEventDto,
  SessionRecord,
  StepRecord,
  ToolCallRecord,
  TurnRecord,
} from './types.js';

const MAX_SESSIONS = 200;

export class ObsStore {
  #sessions = new Map<string, SessionRecord>();
  /** insertion order for bounded eviction. */
  #order: string[] = [];

  /** Apply one agent-core event; returns the touched session for fan-out. */
  ingest(ev: AgentEventDto, source: string): SessionRecord {
    const session = this.#session(ev.sessionId, source, ev.ts);
    session.lastSeen = ev.ts;
    const turn = this.#turn(session, ev.turnId, ev.ts);

    switch (ev.kind) {
      case 'TurnStart':
        turn.startedAt = ev.ts;
        break;
      case 'TurnEnd':
        turn.endedAt = ev.ts;
        turn.llmCalls = turn.steps.filter((s) => s.tools.length > 0).length + 1;
        break;
      case 'StepStart':
        turn.steps.push({ index: turn.steps.length, startedAt: ev.ts, tools: [] });
        break;
      case 'StepEnd': {
        const step = last(turn.steps);
        if (step) {
          step.endedAt = ev.ts;
          step.stopReason = ev.data?.stopReason;
          step.model = ev.data?.model;
          if (ev.data?.usage) step.usage = ev.data.usage;
        }
        break;
      }
      case 'MessageEnd': {
        const step = last(turn.steps);
        if (step && ev.data?.text != null) step.text = ev.data.text;
        break;
      }
      case 'ToolExecutionStart': {
        const step = last(turn.steps);
        if (step && ev.data?.toolCallId) {
          const tc: ToolCallRecord = {
            toolCallId: ev.data.toolCallId,
            toolName: ev.data.toolName ?? '?',
            args: ev.data.args,
            startedAt: ev.ts,
          };
          step.tools.push(tc);
        }
        break;
      }
      case 'ToolExecutionEnd': {
        const step = last(turn.steps);
        const tc = step?.tools.find((t) => t.toolCallId === ev.data?.toolCallId);
        if (tc) {
          tc.endedAt = ev.ts;
          tc.isError = ev.data?.isError;
          if (ev.data?.result != null) tc.result = ev.data.result as string;
        }
        break;
      }
      // MessageStart / MessageUpdate / ToolExecutionUpdate are streaming noise
      // for the persisted tree; the live UI gets them via WS fan-out anyway.
    }
    return session;
  }

  list(): Array<Omit<SessionRecord, 'turns'> & { turns: number }> {
    return this.#order
      .map((id) => this.#sessions.get(id))
      .filter((s): s is SessionRecord => !!s)
      .map((s) => ({ ...s, turns: s.turns.length }))
      .reverse();
  }

  get(sessionId: string): SessionRecord | undefined {
    return this.#sessions.get(sessionId);
  }

  #session(id: string, source: string, ts: number): SessionRecord {
    let s = this.#sessions.get(id);
    if (!s) {
      s = { sessionId: id, source, firstSeen: ts, lastSeen: ts, turns: [] };
      this.#sessions.set(id, s);
      this.#order.push(id);
      while (this.#order.length > MAX_SESSIONS) {
        const evicted = this.#order.shift();
        if (evicted) this.#sessions.delete(evicted);
      }
    }
    return s;
  }

  #turn(session: SessionRecord, turnId: string, ts: number): TurnRecord {
    let t = session.turns.find((x) => x.turnId === turnId);
    if (!t) {
      t = { turnId, sessionId: session.sessionId, startedAt: ts, steps: [], llmCalls: 0 };
      session.turns.push(t);
    }
    return t;
  }
}

function last<T>(arr: T[]): T | undefined {
  return arr.length ? arr[arr.length - 1] : undefined;
}

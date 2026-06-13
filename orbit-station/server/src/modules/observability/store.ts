/**
 * Reconstructs the Session/Turn/Step tree from the flat AgentEventDto stream.
 * The dock app emits agent-core's AgentEvents; this threads them back into the
 * nested model the UI shows.
 *
 * In-memory working set (handles incremental event mutation cleanly) MIRRORED
 * to SQLite (orbit.db) on each change, so traces survive station restarts.
 * Hydrates the recent set from SQLite on boot. Reads serve from memory.
 */

import type Database from 'better-sqlite3';
import { orbitDb } from '../../core/db.js';
import type {
  AgentEventDto,
  SessionRecord,
  StepRecord,
  ToolCallRecord,
  TurnRecord,
} from './types.js';

const MAX_SESSIONS = 200;
const HYDRATE_TURNS = 2000; // most-recent turns loaded into memory on boot

export class ObsStore {
  #sessions = new Map<string, SessionRecord>();
  /** insertion order for bounded eviction. */
  #order: string[] = [];
  #db: Database.Database;

  constructor() {
    this.#db = orbitDb();
    this.#initSchema();
    this.#hydrate();
  }

  /** Apply one agent-core event; returns the touched session for fan-out. */
  ingest(ev: AgentEventDto, source: string): SessionRecord {
    const session = this.#session(ev.sessionId, source, ev.ts);
    session.lastSeen = ev.ts;
    const turn = this.#turn(session, ev.turnId, ev.ts);

    switch (ev.kind) {
      case 'TurnStart':
        turn.startedAt = ev.ts;
        if (ev.data?.trigger != null) turn.trigger = ev.data.trigger;
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
          // rich timings (mirror the live inspector for resumed sessions)
          if (ev.data?.ms != null) step.ms = ev.data.ms;
          if (ev.data?.ttftMs != null) step.ttftMs = ev.data.ttftMs;
          if (ev.data?.thinkingMs != null) step.thinkingMs = ev.data.thinkingMs;
          if (ev.data?.ttftTextMs != null) step.ttftTextMs = ev.data.ttftTextMs;
        }
        break;
      }
      case 'MessageUpdate': {
        // First real delta = streaming started (the empty MessageStart at step
        // start isn't a reliable boundary; deltas only fire for actual content).
        const step = last(turn.steps);
        if (step && step.streamStartedAt == null) step.streamStartedAt = ev.ts;
        break;
      }
      case 'MessageEnd': {
        const step = last(turn.steps);
        if (step && ev.data?.text != null) step.text = ev.data.text;
        break;
      }
      case 'SpeakStart': {
        const list = (turn.speech ??= []);
        // a new utterance implies any prior open window ended (defensive: some
        // SpeakEnds don't arrive). Close it at this start.
        const prevOpen = list.findLast((w) => w.endedAt == null);
        if (prevOpen) prevOpen.endedAt = ev.ts;
        list.push({ startedAt: ev.ts });
        break;
      }
      case 'SpeakEnd': {
        const open = turn.speech?.findLast((w) => w.endedAt == null);
        if (open) open.endedAt = ev.ts;
        break;
      }
      case 'TurnSettled':
        // TTS tail drained after TurnEnd — the real end of the UX turn.
        turn.settledAt = ev.ts;
        break;
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
    this.#persist(session, turn);
    return session;
  }

  // ── persistence (orbit.db) ───────────────────────────────────────────────

  #initSchema(): void {
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS obs_sessions (
        session_id TEXT PRIMARY KEY, source TEXT,
        first_seen INTEGER, last_seen INTEGER
      );
      CREATE TABLE IF NOT EXISTS obs_turns (
        -- turn ids are unique only WITHIN a session, so the key is composite.
        session_id TEXT, turn_id TEXT, source TEXT,
        trigger_kind TEXT, trigger_text TEXT,
        started_at INTEGER, ended_at INTEGER, duration_ms INTEGER,
        step_count INTEGER, had_error INTEGER,
        detail TEXT,                    -- full TurnRecord as JSON
        PRIMARY KEY (session_id, turn_id)
      );
      CREATE INDEX IF NOT EXISTS obs_turns_started ON obs_turns(started_at);
      CREATE INDEX IF NOT EXISTS obs_turns_session ON obs_turns(session_id);
      -- FTS over the searchable text (trigger, step text, tool args/results),
      -- keyed by the same composite identity packed into one column.
      CREATE VIRTUAL TABLE IF NOT EXISTS obs_fts USING fts5(turn_key, body);
    `);
  }

  #persist(session: SessionRecord, turn: TurnRecord): void {
    this.#db.prepare(
      `INSERT INTO obs_sessions(session_id,source,first_seen,last_seen)
       VALUES(@id,@src,@fs,@ls)
       ON CONFLICT(session_id) DO UPDATE SET last_seen=@ls`,
    ).run({ id: session.sessionId, src: session.source, fs: session.firstSeen, ls: session.lastSeen });

    const hadError = turn.steps.some((s) => s.tools.some((t) => t.isError)) ? 1 : 0;
    this.#db.prepare(
      `INSERT INTO obs_turns(session_id,turn_id,source,trigger_kind,trigger_text,started_at,ended_at,duration_ms,step_count,had_error,detail)
       VALUES(@sid,@id,@src,@tk,@tt,@sa,@ea,@dur,@sc,@err,@det)
       ON CONFLICT(session_id,turn_id) DO UPDATE SET
         ended_at=@ea, duration_ms=@dur, step_count=@sc, had_error=@err, detail=@det, trigger_kind=@tk, trigger_text=@tt`,
    ).run({
      id: turn.turnId, sid: turn.sessionId, src: session.source,
      tk: turn.trigger?.kind ?? null, tt: turn.trigger?.text ?? null,
      sa: turn.startedAt, ea: turn.endedAt ?? null,
      dur: (turn.endedAt ?? turn.startedAt) - turn.startedAt,
      sc: turn.steps.length, err: hadError, det: JSON.stringify(turn),
    });

    const key = ftsKey(turn.sessionId, turn.turnId);
    const body = [
      turn.trigger?.text,
      ...turn.steps.map((s) => s.text),
      ...turn.steps.flatMap((s) => s.tools.map((t) => `${t.toolName} ${JSON.stringify(t.args ?? '')} ${t.result ?? ''}`)),
    ].filter(Boolean).join(' \n ');
    this.#db.prepare(`DELETE FROM obs_fts WHERE turn_key=?`).run(key);
    this.#db.prepare(`INSERT INTO obs_fts(turn_key,body) VALUES(?,?)`).run(key, body);
  }

  #hydrate(): void {
    // Load the most-recent turns back into the in-memory working set so the UI
    // (and ongoing reconstruction) has history after a restart.
    const rows = this.#db.prepare(
      `SELECT detail, source FROM obs_turns ORDER BY started_at DESC LIMIT ?`,
    ).all(HYDRATE_TURNS) as Array<{ detail: string; source: string }>;
    // oldest-first so #order/eviction matches original arrival order.
    for (const row of rows.reverse()) {
      const turn = JSON.parse(row.detail) as TurnRecord;
      const session = this.#session(turn.sessionId, row.source, turn.startedAt);
      session.lastSeen = Math.max(session.lastSeen, turn.endedAt ?? turn.startedAt);
      if (!session.turns.find((t) => t.turnId === turn.turnId)) session.turns.push(turn);
    }
  }

  /** The most recent [limit] turns across all sessions, newest first — feeds
   *  the /health summary. Served from the in-memory working set. */
  recentTurns(limit: number): TurnRecord[] {
    return [...this.#sessions.values()]
      .flatMap((s) => s.turns)
      .sort((a, b) => b.startedAt - a.startedAt)
      .slice(0, limit);
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

  /** Permanently delete a session's trace (in-memory + SQLite + FTS). */
  delete(sessionId: string): boolean {
    const had = this.#sessions.delete(sessionId);
    this.#order = this.#order.filter((id) => id !== sessionId);
    const keys = this.#db.prepare(`SELECT turn_id FROM obs_turns WHERE session_id=?`).all(sessionId) as { turn_id: string }[];
    for (const { turn_id } of keys) {
      this.#db.prepare(`DELETE FROM obs_fts WHERE turn_key=?`).run(ftsKey(sessionId, turn_id));
    }
    const info = this.#db.prepare(`DELETE FROM obs_turns WHERE session_id=?`).run(sessionId);
    this.#db.prepare(`DELETE FROM obs_sessions WHERE session_id=?`).run(sessionId);
    return had || info.changes > 0;
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

/** Packed composite identity for the FTS row (turn ids aren't globally unique). */
function ftsKey(sessionId: string, turnId: string): string {
  return `${sessionId} ${turnId}`;
}

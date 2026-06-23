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
  CostBucket,
  CostGroupBy,
  CostSeriesPoint,
  CostSummary,
  SessionEnrichment,
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

  /** `db` overrides the shared orbit.db — tests pass an isolated (e.g. in-memory)
   *  handle so they don't touch the live store. */
  constructor(db?: Database.Database) {
    this.#db = db ?? orbitDb();
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
          if (typeof ev.data?.error === 'string') step.error = ev.data.error;
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
        first_seen INTEGER, last_seen INTEGER,
        enrichment TEXT                 -- SessionEnrichment as JSON (per-session context)
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
    // MIGRATION: add the per-session enrichment column to tables created before
    // it existed (CREATE TABLE IF NOT EXISTS won't add a column to an old table).
    const cols = this.#db.prepare(`PRAGMA table_info(obs_sessions)`).all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === 'enrichment')) {
      this.#db.exec(`ALTER TABLE obs_sessions ADD COLUMN enrichment TEXT`);
    }
  }

  #persist(session: SessionRecord, turn: TurnRecord): void {
    this.#db.prepare(
      `INSERT INTO obs_sessions(session_id,source,first_seen,last_seen,enrichment)
       VALUES(@id,@src,@fs,@ls,@enr)
       ON CONFLICT(session_id) DO UPDATE SET last_seen=@ls`,
    ).run({
      id: session.sessionId, src: session.source, fs: session.firstSeen, ls: session.lastSeen,
      enr: session.enrichment ? JSON.stringify(session.enrichment) : null,
    });

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
    // re-attach enrichment for the hydrated sessions (one row each).
    const enr = this.#db.prepare(
      `SELECT session_id, enrichment FROM obs_sessions WHERE enrichment IS NOT NULL`,
    ).all() as Array<{ session_id: string; enrichment: string }>;
    for (const row of enr) {
      const s = this.#sessions.get(row.session_id);
      if (s) try { s.enrichment = JSON.parse(row.enrichment) as SessionEnrichment; } catch { /* skip bad json */ }
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

  // ── cost aggregation (the Cost tab) ──────────────────────────────────────

  /** Turns whose start falls in [from,to], read from SQLite so the window can
   *  reach past the in-memory working set (exact within DB retention). Each row
   *  is the full TurnRecord JSON plus the session's source. */
  #turnsInWindow(from: number, to: number): Array<{ turn: TurnRecord; source: string }> {
    const rows = this.#db.prepare(
      `SELECT detail, source FROM obs_turns WHERE started_at BETWEEN ? AND ? ORDER BY started_at`,
    ).all(from, to) as Array<{ detail: string; source: string }>;
    return rows.map((r) => ({ turn: JSON.parse(r.detail) as TurnRecord, source: r.source }));
  }

  /** Total LLM spend over [from,to], grouped by source/kind/model/day. Sums each
   *  step's `usage` (cost as pi's list price; null cost counts as 0). Steps
   *  without usage (no LLM call) are skipped. */
  costRollup(from: number, to: number, groupBy: CostGroupBy): CostSummary {
    const total = bucket();
    const groups = new Map<string, CostBucket>();
    for (const { turn, source } of this.#turnsInWindow(from, to)) {
      const kind = costKind(turn.trigger?.kind);
      for (const step of turn.steps) {
        const u = step.usage;
        if (!u) continue;
        const key = groupBy === 'source' ? source
          : groupBy === 'kind' ? kind
          : groupBy === 'model' ? (step.model || 'unknown')
          : groupBy === 'usecase' ? costUseCase(turn, step.model)
          : utcDay(turn.startedAt);
        add(total, u);
        let g = groups.get(key);
        if (!g) { g = bucket(); g.group = key; groups.set(key, g); }
        add(g, u);
      }
    }
    return {
      from, to, total, groupBy,
      groups: [...groups.values()].sort((a, b) => b.cost - a.cost),
    };
  }

  /** Per-day cost series over [from,to], each day split by groupBy value — feeds
   *  the stacked time chart. */
  costSeries(from: number, to: number, groupBy: 'source' | 'kind' | 'model' | 'usecase'): CostSeriesPoint[] {
    const days = new Map<string, Record<string, number>>();
    for (const { turn, source } of this.#turnsInWindow(from, to)) {
      const kind = costKind(turn.trigger?.kind);
      const day = utcDay(turn.startedAt);
      for (const step of turn.steps) {
        const cost = step.usage?.cost;
        if (!cost) continue;
        const key = groupBy === 'source' ? source
          : groupBy === 'kind' ? kind
          : groupBy === 'usecase' ? costUseCase(turn, step.model)
          : (step.model || 'unknown');
        const row = days.get(day) ?? {};
        row[key] = (row[key] ?? 0) + cost;
        days.set(day, row);
      }
    }
    return [...days.entries()].sort(([a], [b]) => a.localeCompare(b))
      .map(([day, byGroup]) => ({ day, byGroup }));
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

  /** Attach/refresh per-session ENRICHMENT (station-side context: provenance,
   *  config, models, perception window, …). Merged shallowly over any prior
   *  enrichment and persisted. Creates the session shell if it doesn't exist
   *  yet (enrichment can land before the first agent event on a fresh session).
   *  `source` is the owning dock (same identity the event stream uses). */
  enrich(sessionId: string, source: string, patch: Partial<SessionEnrichment>): SessionRecord {
    const s = this.#session(sessionId, source, Date.now());
    s.enrichment = { ...(s.enrichment ?? { updatedAt: 0 }), ...patch, updatedAt: Date.now() };
    // persist just the enrichment (no turn needed).
    this.#db.prepare(
      `INSERT INTO obs_sessions(session_id,source,first_seen,last_seen,enrichment)
       VALUES(@id,@src,@fs,@ls,@enr)
       ON CONFLICT(session_id) DO UPDATE SET last_seen=@ls, enrichment=@enr`,
    ).run({
      id: s.sessionId, src: s.source, fs: s.firstSeen, ls: s.lastSeen,
      enr: JSON.stringify(s.enrichment),
    });
    return s;
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

/** A zeroed cost accumulator. */
function bucket(): CostBucket {
  return { cost: 0, inputTokens: 0, outputTokens: 0, calls: 0 };
}

/** Fold one step's usage into an accumulator. */
function add(b: CostBucket, u: NonNullable<StepRecord['usage']>): void {
  b.cost += u.cost ?? 0;
  b.inputTokens += u.inputTokens ?? 0;
  b.outputTokens += u.outputTokens ?? 0;
  b.calls += 1;
}

/** Bucket a turn's trigger kind for the cost 'kind' axis. `task` and `perception`
 *  (the station's own non-user LLM spend — bg-STT, summaries, embeds) get their own
 *  rows; everything else (incl. an absent trigger) is user-driven spend → 'user'. */
function costKind(triggerKind: string | undefined): string {
  if (triggerKind === 'task') return 'task';
  if (triggerKind === 'perception') return 'perception';
  return 'user';
}

/** Map a perception role tag → its human-readable use-case label. The tag is the
 *  `label` reportGeminiCost stamps (in trigger.text and the model-name suffix). */
const USECASE_LABELS: Record<string, string> = {
  'bg-stt': 'Speech-to-text',
  summary: 'Summarizer',
  'mem-embed': 'Memory embeddings',
};

/** The cost 'usecase' axis: the human-readable role a call plays, derived from the
 *  turn's trigger and the per-call role tag perception stamps. Brain turns →
 *  'Conversation' (user) / 'Background tasks' (task). Perception turns carry their
 *  role in trigger.text; we also fall back to the legacy `model (role)` suffix so
 *  historical rows (written before the tag existed) still classify. */
function costUseCase(turn: TurnRecord, model: string | undefined): string {
  if (turn.trigger?.kind === 'perception') {
    const tag = turn.trigger.text || model?.match(/\(([^)]+)\)\s*$/)?.[1];
    return (tag && USECASE_LABELS[tag]) || 'Perception';
  }
  if (turn.trigger?.kind === 'task') return 'Background tasks';
  return 'Conversation';
}

/** UTC calendar day ('YYYY-MM-DD') of an epoch-ms timestamp. */
function utcDay(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}

/** Packed composite identity for the FTS row (turn ids aren't globally unique). */
function ftsKey(sessionId: string, turnId: string): string {
  return `${sessionId} ${turnId}`;
}

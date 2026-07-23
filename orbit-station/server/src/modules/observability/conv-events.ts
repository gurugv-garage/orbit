/**
 * ConvEvents — the durable cross-component CONVERSATION timeline.
 *
 * One append-only stream of every gate verdict / state transition in the
 * conversational pipeline, from every component, on one (station) clock:
 *   phone       client-evt frames (tts-pause, face-state, state-heal, …)
 *   perception  STT gate deaths + finals (voiced-fraction drop, withheld, final)
 *   brain       addressed/barge/stop/queue decisions (the old in-memory addrTrace)
 *   conv        ConversationState transitions (window open/expire/consume, modes)
 *
 * This is the answer to "what happened on dock X between t1 and t2?" — the
 * addrTrace ring was in-memory (cap 50, lost on restart) and the acoustic
 * front-end wrote nowhere at all; everything now lands here, keyed where
 * possible by utteranceId (minted at segmentation: `<dockId>:<audioStartMs>`)
 * so an audio segment can be followed snapshot → admit → turn.
 *
 * Timestamps: `ts` is always the station clock at record time. Utterance events
 * ALSO carry the audio-truth window (`audioStartAt`/`audioEndAt`, when the sound
 * happened) and `sttFinalAt` (when the transcript landed) — the lag between the
 * two is real and debugging barge/stop timing requires seeing both. Phone events
 * carry `deviceTs` (the phone's clock) beside the station arrival `ts`.
 *
 * Persistence: SQLite (orbit.db), time-window retention. Emitters call
 * recordConvEvent() directly (fire-and-forget, never throws into the caller);
 * the observability module wires setConvEventPublisher() so each event also
 * fans out live on the bus (topic 'obs', kind 'conv-event') for the timeline UI.
 */

import type Database from 'better-sqlite3';
import { orbitDb } from '../../core/db.js';

export interface ConvEvent {
  /** station clock, ms epoch (stamped at record time when omitted). */
  ts?: number;
  dockId: string;
  /** which component produced it — the timeline swimlane. */
  lane: 'phone' | 'perception' | 'brain' | 'conv';
  /** event type, namespaced: 'stt:final' | 'stt:drop' | 'addr' | 'conv:listening' | 'phone:tts-pause' … */
  type: string;
  /** the decision/reason when the event IS a verdict ('RAN-TURN', 'voiced-fraction', 'window-timeout', …). */
  verdict?: string;
  /** transcript text when the event concerns an utterance. */
  text?: string;
  /** segmentation-minted correlation id: `<dockId>:<audioStartMs>`. */
  utteranceId?: string;
  turnId?: string;
  /** audio-truth window: when the SOUND actually happened (ms epoch). */
  audioStartAt?: number;
  audioEndAt?: number;
  /** when the STT transcript landed (ms epoch) — vs audioEndAt = the STT lag. */
  sttFinalAt?: number;
  /** the phone's own clock for client-evt frames (station arrival is `ts`). */
  deviceTs?: number;
  /** anything else worth keeping (mode, thresholds, held ms, …). */
  detail?: Record<string, unknown>;
}

/** A stored event: ConvEvent with the stamped ts + its rowid. */
export type StoredConvEvent = ConvEvent & { ts: number; id: number };

/** Keep this many days of events (prune runs opportunistically on insert). */
const RETAIN_DAYS = Number(process.env.OBS_CONV_EVENTS_DAYS ?? 14);
const PRUNE_EVERY = 200;

export class ConvEventLog {
  #db: Database.Database;
  #insertsSincePrune = 0;

  constructor(db?: Database.Database) {
    this.#db = db ?? orbitDb();
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS conv_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL, dock TEXT NOT NULL,
        lane TEXT NOT NULL, type TEXT NOT NULL,
        verdict TEXT, text TEXT, utterance_id TEXT, turn_id TEXT,
        audio_start INTEGER, audio_end INTEGER, stt_final_at INTEGER, device_ts INTEGER,
        detail TEXT
      );
      CREATE INDEX IF NOT EXISTS conv_events_dock_ts ON conv_events(dock, ts);
    `);
  }

  add(ev: ConvEvent): StoredConvEvent {
    const ts = ev.ts ?? Date.now();
    const info = this.#db.prepare(
      `INSERT INTO conv_events(ts,dock,lane,type,verdict,text,utterance_id,turn_id,audio_start,audio_end,stt_final_at,device_ts,detail)
       VALUES(@ts,@dock,@lane,@type,@verdict,@text,@uid,@tid,@as,@ae,@sf,@dt,@detail)`,
    ).run({
      ts, dock: ev.dockId, lane: ev.lane, type: ev.type,
      verdict: ev.verdict ?? null, text: ev.text ?? null,
      uid: ev.utteranceId ?? null, tid: ev.turnId ?? null,
      as: ev.audioStartAt ?? null, ae: ev.audioEndAt ?? null,
      sf: ev.sttFinalAt ?? null, dt: ev.deviceTs ?? null,
      detail: ev.detail ? JSON.stringify(ev.detail) : null,
    });
    if (++this.#insertsSincePrune >= PRUNE_EVERY) {
      this.#insertsSincePrune = 0;
      this.#db.prepare(`DELETE FROM conv_events WHERE ts < ?`).run(Date.now() - RETAIN_DAYS * 86_400_000);
    }
    return { ...ev, ts, id: Number(info.lastInsertRowid) };
  }

  query(opts: { dock?: string; from?: number; to?: number; limit?: number; lanes?: string[] }): StoredConvEvent[] {
    const to = opts.to ?? Date.now();
    const from = opts.from ?? to - 3_600_000;
    const limit = Math.min(opts.limit ?? 2000, 20_000);
    const laneFilter = opts.lanes?.length ? ` AND lane IN (${opts.lanes.map(() => '?').join(',')})` : '';
    const rows = this.#db.prepare(
      `SELECT * FROM conv_events WHERE ts BETWEEN ? AND ?${opts.dock ? ' AND dock=?' : ''}${laneFilter}
       ORDER BY ts DESC LIMIT ?`,
    ).all(...[from, to, ...(opts.dock ? [opts.dock] : []), ...(opts.lanes ?? []), limit]) as Array<Record<string, unknown>>;
    return rows.reverse().map((r) => ({
      id: r.id as number, ts: r.ts as number, dockId: r.dock as string,
      lane: r.lane as ConvEvent['lane'], type: r.type as string,
      ...(r.verdict != null ? { verdict: r.verdict as string } : {}),
      ...(r.text != null ? { text: r.text as string } : {}),
      ...(r.utterance_id != null ? { utteranceId: r.utterance_id as string } : {}),
      ...(r.turn_id != null ? { turnId: r.turn_id as string } : {}),
      ...(r.audio_start != null ? { audioStartAt: r.audio_start as number } : {}),
      ...(r.audio_end != null ? { audioEndAt: r.audio_end as number } : {}),
      ...(r.stt_final_at != null ? { sttFinalAt: r.stt_final_at as number } : {}),
      ...(r.device_ts != null ? { deviceTs: r.device_ts as number } : {}),
      ...(r.detail != null ? { detail: JSON.parse(r.detail as string) as Record<string, unknown> } : {}),
    }));
  }
}

// ── module-level singleton + live fan-out ───────────────────────────────────
// Emitters (perception processors, brain, session) call recordConvEvent()
// directly; the log lazy-inits on first use so init order never matters. The
// observability module registers a publisher so events also stream on the bus.

let log: ConvEventLog | undefined;
let publisher: ((ev: StoredConvEvent) => void) | undefined;

export function convEventLog(): ConvEventLog {
  return (log ??= new ConvEventLog());
}

/** Live fan-out hook (observability init → bus publish). One consumer. */
export function setConvEventPublisher(fn: (ev: StoredConvEvent) => void): void {
  publisher = fn;
}

/** Append one event to the durable conversation timeline (+ live fan-out).
 *  Fire-and-forget: a storage error must never break the hot path it traces.
 *  NO-OP under the node test runner (NODE_TEST_CONTEXT) or OBS_CONV_EVENTS=0 —
 *  unit tests exercise sessions with fake docks (test-bot/desk-1/…) and the
 *  singleton writes to the REAL orbit.db; without this gate every `npm test`
 *  floods the live timeline with phantom turn-starts (seen live 2026-07-23). */
export function recordConvEvent(ev: ConvEvent): void {
  if (process.env.NODE_TEST_CONTEXT || process.env.OBS_CONV_EVENTS === '0') return;
  try {
    const stored = convEventLog().add(ev);
    publisher?.(stored);
  } catch (err) {
    console.warn(`[conv-events] record failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

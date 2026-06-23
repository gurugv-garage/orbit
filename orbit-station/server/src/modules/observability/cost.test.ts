/**
 * Cost rollup tests (node:test) — seed turns via the real ingest path into an
 * isolated in-memory DB, then assert the grouped sums the Cost tab reads.
 *
 *   npm test --workspace server
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { ObsStore } from './store.js';
import type { AgentEventDto } from './types.js';

const DAY = 24 * 3600_000;

/** Feed one LLM step (StepStart→StepEnd with usage) for a turn, plus the
 *  TurnStart that carries its trigger kind. Emits a full minimal turn. */
function seedTurn(
  store: ObsStore,
  opts: {
    source: string; sessionId: string; turnId: string; ts: number;
    kind: string; model: string;
    cost: number; input: number; output: number;
  },
): void {
  const base = { sessionId: opts.sessionId, turnId: opts.turnId, ts: opts.ts };
  const ev = (over: Partial<AgentEventDto>): AgentEventDto =>
    ({ ...base, seq: 0, kind: 'TurnStart', ...over } as AgentEventDto);
  store.ingest(ev({ kind: 'TurnStart', data: { trigger: { kind: opts.kind } } }), opts.source);
  store.ingest(ev({ kind: 'StepStart' }), opts.source);
  store.ingest(ev({
    kind: 'StepEnd',
    data: { model: opts.model, usage: { inputTokens: opts.input, outputTokens: opts.output, cost: opts.cost } },
  }), opts.source);
  store.ingest(ev({ kind: 'TurnEnd' }), opts.source);
}

function freshStore(): ObsStore {
  return new ObsStore(new Database(':memory:'));
}

test('costRollup groups by source and sums cost + tokens', () => {
  const store = freshStore();
  const now = Date.now();
  seedTurn(store, { source: 'deskA', sessionId: 's1', turnId: 't1', ts: now, kind: 'user', model: 'g/flash', cost: 0.01, input: 100, output: 20 });
  seedTurn(store, { source: 'deskA', sessionId: 's1', turnId: 't2', ts: now, kind: 'user', model: 'g/flash', cost: 0.02, input: 200, output: 40 });
  seedTurn(store, { source: 'deskB', sessionId: 's2', turnId: 't1', ts: now, kind: 'user', model: 'g/pro', cost: 0.05, input: 300, output: 60 });

  const r = store.costRollup(now - DAY, now + DAY, 'source');
  assert.equal(r.total.calls, 3);
  assert.ok(Math.abs(r.total.cost - 0.08) < 1e-9);
  assert.equal(r.total.inputTokens, 600);
  assert.equal(r.total.outputTokens, 120);
  // sorted by cost desc → deskB first.
  assert.deepEqual(r.groups.map((g) => g.group), ['deskB', 'deskA']);
  const deskA = r.groups.find((g) => g.group === 'deskA')!;
  assert.ok(Math.abs(deskA.cost - 0.03) < 1e-9);
  assert.equal(deskA.calls, 2);
});

test('costRollup by kind separates user vs task', () => {
  const store = freshStore();
  const now = Date.now();
  seedTurn(store, { source: 'deskA', sessionId: 's1', turnId: 't1', ts: now, kind: 'user', model: 'm', cost: 0.10, input: 1, output: 1 });
  seedTurn(store, { source: 'deskA', sessionId: 'task:x:t-1', turnId: 't1', ts: now, kind: 'task', model: 'm', cost: 0.04, input: 1, output: 1 });

  const r = store.costRollup(now - DAY, now + DAY, 'kind');
  assert.deepEqual(r.groups.map((g) => g.group), ['user', 'task']);
  assert.ok(Math.abs(r.groups.find((g) => g.group === 'task')!.cost - 0.04) < 1e-9);
});

test('costRollup by kind gives perception its own bucket (not folded into user)', () => {
  const store = freshStore();
  const now = Date.now();
  seedTurn(store, { source: 'deskA', sessionId: 's1', turnId: 't1', ts: now, kind: 'user', model: 'm', cost: 0.10, input: 1, output: 1 });
  seedTurn(store, { source: 'deskA', sessionId: 'perception:deskA', turnId: 'p1', ts: now, kind: 'perception', model: 'g (bg-stt)', cost: 0.02, input: 1, output: 1 });

  const r = store.costRollup(now - DAY, now + DAY, 'kind');
  assert.deepEqual(r.groups.map((g) => g.group).sort(), ['perception', 'user']);
  assert.ok(Math.abs(r.groups.find((g) => g.group === 'perception')!.cost - 0.02) < 1e-9);
  // user must NOT absorb the perception spend
  assert.ok(Math.abs(r.groups.find((g) => g.group === 'user')!.cost - 0.10) < 1e-9);
});

test('costRollup by usecase labels each call by its role', () => {
  const store = freshStore();
  const now = Date.now();
  // brain user + task turns
  seedTurn(store, { source: 'deskA', sessionId: 's1', turnId: 't1', ts: now, kind: 'user', model: 'gemini-2.5-flash', cost: 0.10, input: 1, output: 1 });
  seedTurn(store, { source: 'deskA', sessionId: 'task:x', turnId: 't1', ts: now, kind: 'task', model: 'm', cost: 0.03, input: 1, output: 1 });
  // perception roles, classified via the legacy `model (role)` suffix (no trigger.text)
  seedTurn(store, { source: 'deskA', sessionId: 'perception:deskA', turnId: 'p1', ts: now, kind: 'perception', model: 'gemini-2.5-flash-lite (bg-stt)', cost: 0.02, input: 1, output: 1 });
  seedTurn(store, { source: 'deskA', sessionId: 'perception:deskA', turnId: 'p2', ts: now, kind: 'perception', model: 'gemini-2.5-flash (summary)', cost: 0.01, input: 1, output: 1 });
  // perception role classified via trigger.text (what reportGeminiCost stamps now)
  store.ingest({ sessionId: 'perception:station', turnId: 'e1', seq: 0, kind: 'TurnStart', ts: now, data: { trigger: { kind: 'perception', text: 'mem-embed' } } }, 'station');
  store.ingest({ sessionId: 'perception:station', turnId: 'e1', seq: 1, kind: 'StepStart', ts: now }, 'station');
  store.ingest({ sessionId: 'perception:station', turnId: 'e1', seq: 2, kind: 'StepEnd', ts: now, data: { model: 'gemini-embedding-001', usage: { inputTokens: 1, outputTokens: 0, cost: 0.005 } } }, 'station');
  store.ingest({ sessionId: 'perception:station', turnId: 'e1', seq: 3, kind: 'TurnEnd', ts: now }, 'station');

  const r = store.costRollup(now - DAY, now + DAY, 'usecase');
  const by = Object.fromEntries(r.groups.map((g) => [g.group, g.cost]));
  assert.ok(Math.abs(by['Conversation']! - 0.10) < 1e-9);
  assert.ok(Math.abs(by['Background tasks']! - 0.03) < 1e-9);
  assert.ok(Math.abs(by['Speech-to-text']! - 0.02) < 1e-9);
  assert.ok(Math.abs(by['Summarizer']! - 0.01) < 1e-9);
  assert.ok(Math.abs(by['Memory embeddings']! - 0.005) < 1e-9);
});

test('costRollup honors the time window', () => {
  const store = freshStore();
  const now = Date.now();
  seedTurn(store, { source: 'd', sessionId: 's1', turnId: 'old', ts: now - 10 * DAY, kind: 'user', model: 'm', cost: 0.99, input: 1, output: 1 });
  seedTurn(store, { source: 'd', sessionId: 's1', turnId: 'new', ts: now, kind: 'user', model: 'm', cost: 0.01, input: 1, output: 1 });

  const r = store.costRollup(now - 2 * DAY, now + DAY, 'source');
  assert.equal(r.total.calls, 1);
  assert.ok(Math.abs(r.total.cost - 0.01) < 1e-9);
});

test('steps without usage are skipped (no phantom calls)', () => {
  const store = freshStore();
  const now = Date.now();
  // a turn with a step that has no usage (e.g. a pure tool step or errored call)
  store.ingest({ sessionId: 's1', turnId: 't1', seq: 0, kind: 'TurnStart', ts: now, data: { trigger: { kind: 'user' } } }, 'd');
  store.ingest({ sessionId: 's1', turnId: 't1', seq: 1, kind: 'StepStart', ts: now }, 'd');
  store.ingest({ sessionId: 's1', turnId: 't1', seq: 2, kind: 'StepEnd', ts: now, data: { model: 'm' } }, 'd');
  store.ingest({ sessionId: 's1', turnId: 't1', seq: 3, kind: 'TurnEnd', ts: now }, 'd');

  const r = store.costRollup(now - DAY, now + DAY, 'source');
  assert.equal(r.total.calls, 0);
  assert.equal(r.total.cost, 0);
});

test('costSeries buckets cost per UTC day split by group', () => {
  const store = freshStore();
  // fixed timestamps so the day boundaries are deterministic.
  const d1 = Date.parse('2026-06-10T12:00:00Z');
  const d2 = Date.parse('2026-06-11T12:00:00Z');
  seedTurn(store, { source: 'deskA', sessionId: 's1', turnId: 't1', ts: d1, kind: 'user', model: 'm', cost: 0.01, input: 1, output: 1 });
  seedTurn(store, { source: 'deskB', sessionId: 's2', turnId: 't1', ts: d1, kind: 'user', model: 'm', cost: 0.02, input: 1, output: 1 });
  seedTurn(store, { source: 'deskA', sessionId: 's1', turnId: 't2', ts: d2, kind: 'user', model: 'm', cost: 0.03, input: 1, output: 1 });

  const series = store.costSeries(d1 - DAY, d2 + DAY, 'source');
  assert.deepEqual(series.map((p) => p.day), ['2026-06-10', '2026-06-11']);
  assert.ok(Math.abs(series[0]!.byGroup.deskA! - 0.01) < 1e-9);
  assert.ok(Math.abs(series[0]!.byGroup.deskB! - 0.02) < 1e-9);
  assert.ok(Math.abs(series[1]!.byGroup.deskA! - 0.03) < 1e-9);
});

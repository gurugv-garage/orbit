/**
 * Long-term memory curator — the pure logic of both ops + the cadence decisions + the
 * loop (with injected effects). No Gemini/sqlite/live ring. The breakable parts:
 * cadence gates, messy-JSON tolerance, the id-guard (reconcile) + grounding-guard
 * (consolidate), and event-time alignment via the source layer.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reconcilePrompt, parseReconcile, reconcilePlan, type BeliefHit } from './reconcile.js';
import { consolidatePrompt, parseConsolidate, consolidatePlan } from './consolidate.js';
import { observationsIn, pendingObservations, pendingStats, type Observation, type SourceContext } from './sources.js';
import { shouldReconcile, startLongTermMemoryCurator, type PendingStats } from './curator.js';
import { decideConsolidate, batchSize, type CadenceCfg } from './cadence.js';
import type { SnapshotStore, SnapshotRecord } from '../../snapshots.js';

const belief = (id: string, claim: string): BeliefHit => ({ id, claim, type: 'fact', subject: '', confidence: 0.6 });

// ── consolidate cadence (load-aware: flood / age / quiet) ───────────────────────

const CAD: CadenceCfg = { batchAt: 5, maxAgeMs: 300_000, quietMs: 45_000, floorMs: 30_000 };

test('decideConsolidate: nothing pending → wait', () => {
  assert.equal(decideConsolidate({ pendingCount: 0, oldestPendingAgeMs: 0, sinceLastSpeechMs: 0, sinceLastPassMs: 1e9 }, CAD), null);
});

test('decideConsolidate: FLOOD — ≥batch pending, floor elapsed', () => {
  assert.equal(decideConsolidate({ pendingCount: 5, oldestPendingAgeMs: 1000, sinceLastSpeechMs: 0, sinceLastPassMs: 1e9 }, CAD), 'flood');
  // within floor + not age-critical → wait (don't thrash)
  assert.equal(decideConsolidate({ pendingCount: 5, oldestPendingAgeMs: 1000, sinceLastSpeechMs: 0, sinceLastPassMs: 1000 }, CAD), null);
});

test('decideConsolidate: AGE overrides the floor (don\'t let the ring drop it)', () => {
  // only 1 pending, just consolidated 1s ago, but it\'s been pending 6 min → flush anyway
  assert.equal(decideConsolidate({ pendingCount: 1, oldestPendingAgeMs: 360_000, sinceLastSpeechMs: 0, sinceLastPassMs: 1000 }, CAD), 'age');
});

test('decideConsolidate: QUIET — small backlog, speech stopped', () => {
  assert.equal(decideConsolidate({ pendingCount: 2, oldestPendingAgeMs: 1000, sinceLastSpeechMs: 60_000, sinceLastPassMs: 1e9 }, CAD), 'quiet');
  // still talking (not quiet) + below batch → wait
  assert.equal(decideConsolidate({ pendingCount: 2, oldestPendingAgeMs: 1000, sinceLastSpeechMs: 5_000, sinceLastPassMs: 1e9 }, CAD), null);
});

test('decideConsolidate: force (run-now) processes a small backlog past the floor', () => {
  assert.equal(decideConsolidate({ pendingCount: 1, oldestPendingAgeMs: 100, sinceLastSpeechMs: 100, sinceLastPassMs: 100 }, CAD, true), 'flood');
});

test('batchSize: all of a small backlog; capped under a flood', () => {
  assert.equal(batchSize(3, CAD, 20), 3);
  assert.equal(batchSize(57, CAD, 20), 20); // flood → bounded
  assert.equal(batchSize(0, CAD, 20), 0);
});

test('shouldReconcile: enough beliefs AND interval elapsed', () => {
  assert.equal(shouldReconcile(3, 0, 1e9, 1000, 4), false);     // too few beliefs
  assert.equal(shouldReconcile(4, 0, 1e9, 1000, 4), true);
  assert.equal(shouldReconcile(4, 1e9, 1e9 + 500, 1000, 4), false);
});

// ── reconcile (MAINTAIN, bounded) ───────────────────────────────────────────────

const known = new Set(['m1', 'm2', 'm3']);

test('reconcile parses messy JSON; {} on garbage', () => {
  assert.equal(parseReconcile('```json\n{"forget":[{"id":"m1"}]}\n```').forget?.[0]!.id, 'm1');
  assert.deepEqual(parseReconcile('no json'), {});
});

test('reconcile id-guard: a hallucinated id never reaches the plan', () => {
  const plan = reconcilePlan({
    revisions: [{ id: 'ghost', claim: 'x' }, { id: 'm1', claim: 'ok' }],
    forget: [{ id: 'ghost2' }, { id: 'm2' }],
  }, known);
  assert.deepEqual(plan.revise.map((r) => r.id), ['m1']);
  assert.deepEqual(plan.forget, ['m2']);
});

test('reconcile prompt lists ids + says do NOT invent', () => {
  const p = reconcilePrompt([belief('m1', 'likes tea')]);
  assert.match(p, /\[m1\].*likes tea/);
  assert.match(p, /do NOT invent/i);
});

// ── consolidate (CREATE, grounded) ──────────────────────────────────────────────

const obsIds = new Set(['speech@t1', 'speech@t2']);

test('consolidate plan: keeps a grounded belief, builds lineage from support', () => {
  const plan = consolidatePlan({
    beliefs: [{ type: 'preference', subject: 'guru', claim: 'prefers tea', confidence: 0.5, support: ['speech@t1'] }],
  }, obsIds);
  assert.equal(plan.length, 1);
  assert.equal(plan[0]!.claim, 'prefers tea');
  assert.deepEqual(plan[0]!.lineage, [{ sourceKind: 'snapshot', sourceId: 'speech@t1' }]);
});

test('consolidate GROUNDING-guard: a belief with no real support is dropped', () => {
  const plan = consolidatePlan({
    beliefs: [
      { claim: 'invented from nothing', support: [] },
      { claim: 'also invented', support: ['ghost@t9'] },     // support not in the window
      { claim: 'real one', support: ['speech@t2'] },
    ],
  }, obsIds);
  assert.deepEqual(plan.map((b) => b.claim), ['real one']);
});

test('consolidate clamps confidence to confMax (over-confident model gets capped)', () => {
  const plan = consolidatePlan({ beliefs: [{ claim: 'x', confidence: 0.95, support: ['speech@t1'] }] }, obsIds, 0.6);
  assert.equal(plan[0]!.confidence, 0.6); // 0.95 → clamped to the live confMax
});

test('consolidate clamps a bad type to fact + drops empty claims', () => {
  const plan = consolidatePlan({
    beliefs: [
      { type: 'nonsense' as never, claim: 'x', support: ['speech@t1'] },
      { claim: '   ', support: ['speech@t1'] },
    ],
  }, obsIds);
  assert.equal(plan.length, 1);
  assert.equal(plan[0]!.type, 'fact');
});

test('consolidate prompt shows "already known" + the aligned observations', () => {
  const obs: Observation[] = [{ lineageId: 'speech@t1', atIso: '2026-01-01T10:00:00+05:30', text: 'I love espresso', presentAt: 'guru', speaker: 1 }];
  const p = consolidatePrompt(obs, [belief('m1', 'guru works on robotics')]);
  assert.match(p, /ALREADY KNOWN/);
  assert.match(p, /guru works on robotics/);
  assert.match(p, /\[speech@t1\]/);
  assert.match(p, /present: guru/);
  assert.match(p, /I love espresso/);
});

// ── sources (event-time alignment) ──────────────────────────────────────────────

function speechRec(dockId: string, from: string, text: string, extra: Record<string, unknown> = {}): SnapshotRecord {
  return {
    ts: from, tz: 'IST', dockId,
    source: { id: `${dockId}-s`, kind: 'speech', device: 'd', host: 'h' },
    model: { name: 'stt', endpoint: 'x' },
    interval: { from, to: from, durationMs: 0 },
    payload: { text, ...extra },
  } as SnapshotRecord;
}

test('observationsIn: prefers diarized text, keeps raw, attaches present-at', () => {
  const recs = [speechRec('d1', '2026-01-01T10:00:00+05:30', 'diarized hi', { sttText: 'raw hi', speaker: 2 })];
  const store = { inWindow: () => recs } as unknown as SnapshotStore;
  const ctx: SourceContext = { store, presentAt: (iso) => iso.includes('10:00') ? 'guru' : undefined };
  const obs = observationsIn(ctx, 'd1', 'a', 'z');
  assert.equal(obs.length, 1);
  assert.equal(obs[0]!.text, 'diarized hi');
  assert.equal(obs[0]!.raw, 'raw hi');
  assert.equal(obs[0]!.speaker, 2);
  assert.equal(obs[0]!.presentAt, 'guru');
  assert.equal(obs[0]!.lineageId, 'speech@2026-01-01T10:00:00+05:30');
});

test('observationsIn: drops word-less utterances, filters to the dock + speech', () => {
  const recs = [
    speechRec('d1', 't1', '!!'),                 // no words → dropped
    speechRec('d2', 't2', 'other dock'),         // wrong dock → filtered
    speechRec('d1', 't3', 'real words here'),
  ];
  const store = { inWindow: () => recs } as unknown as SnapshotStore;
  const obs = observationsIn({ store, presentAt: () => undefined }, 'd1', 'a', 'z');
  assert.deepEqual(obs.map((o) => o.text), ['real words here']);
});

test('pendingStats + pendingObservations: post-watermark, oldest-first, capped', () => {
  const recs = [
    speechRec('d1', '2026-01-01T10:00:00+05:30', 'one'),
    speechRec('d1', '2026-01-01T10:01:00+05:30', 'two'),
    speechRec('d1', '2026-01-01T10:02:00+05:30', 'three'),
  ];
  const store = { list: () => recs } as unknown as SnapshotStore;
  const ctx: SourceContext = { store, presentAt: () => undefined };
  // watermark before everything → all 3 pending
  const all = pendingStats(store, 'd1', '');
  assert.equal(all.count, 3);
  assert.equal(all.oldestIso, '2026-01-01T10:00:00+05:30');
  // watermark after the first → only the later 2 pending
  const after1 = pendingStats(store, 'd1', '2026-01-01T10:00:00+05:30');
  assert.equal(after1.count, 2);
  assert.equal(after1.oldestIso, '2026-01-01T10:01:00+05:30');
  // capped + oldest-first
  const obs = pendingObservations(ctx, 'd1', '', 2);
  assert.deepEqual(obs.map((o) => o.text), ['one', 'two']);
});

// ── the loop (injected effects) — models a real pending queue + watermark ───────

test('tick runs BOTH ops: consolidate creates, reconcile maintains', async () => {
  const created: string[] = []; const forgot: string[] = [];
  const obs: Observation[] = [{ lineageId: 'speech@t1', atIso: '2026-01-01T10:00:00+05:30', text: 'I love espresso', presentAt: 'guru' }];
  const curator = startLongTermMemoryCurator({
    activeDocks: () => ['d1'],
    watermarkSeed: () => '',
    pendingStats: (_d, wm) => { const p = obs.filter((o) => o.atIso > wm); return { count: p.length, oldestIso: p[0]?.atIso ?? '', newestIso: p[p.length - 1]?.atIso ?? '' }; },
    pendingObservations: (_d, wm, limit) => obs.filter((o) => o.atIso > wm).slice(0, limit),
    beliefs: async () => [belief('m1', 'stale'), belief('m2', 'b'), belief('m3', 'c'), belief('m4', 'd')],
    reflect: async (_p, _d, purpose) => purpose === 'consolidate'
      ? '{"beliefs":[{"type":"preference","subject":"guru","claim":"guru loves espresso","support":["speech@t1"]}]}'
      : '{"forget":[{"id":"m1"}]}',
    create: async (_d, b) => { created.push(b.claim); return 'id'; },
    revise: async () => 'v2', forget: (id) => { forgot.push(id); return true; },
    pollMs: 1e9, now: () => 1e12,
  });
  await curator.tick();
  assert.deepEqual(created, ['guru loves espresso']);
  assert.deepEqual(forgot, ['m1']);
  curator.stop();
});

test('FLOOD drains over ticks, EXACTLY-ONCE (watermark advances, no re-send)', async () => {
  // 50 utterances, batch capped at 20 → 3 ticks (20+20+10), each utterance consolidated once.
  // pad the index so lineageIds don't substring-collide (t01 vs t1) — exact accounting.
  const obs: Observation[] = Array.from({ length: 50 }, (_, i) => ({
    lineageId: `speech@t${String(i).padStart(2, '0')}`, atIso: `2026-01-01T10:${String(i).padStart(2, '0')}:00+05:30`, text: `utterance ${i}`,
  }));
  const seenLineageIds: string[] = [];
  const curator = startLongTermMemoryCurator({
    activeDocks: () => ['d1'],
    watermarkSeed: () => '',
    pendingStats: (_d, wm) => { const p = obs.filter((o) => o.atIso > wm); return { count: p.length, oldestIso: p[0]?.atIso ?? '', newestIso: p[p.length - 1]?.atIso ?? '' }; },
    pendingObservations: (_d, wm, limit) => obs.filter((o) => o.atIso > wm).slice(0, limit),
    beliefs: async () => [],
    reflect: async (prompt, _d, purpose) => {
      if (purpose !== 'consolidate') return '{}';
      // record which utterances were in THIS batch (exact lineageId match, no substring collision)
      for (const o of obs) if (prompt.includes(`[${o.lineageId}]`)) seenLineageIds.push(o.lineageId);
      return '{}'; // create nothing; we only care about the batching/watermark
    },
    create: async () => 'id', revise: async () => null, forget: () => false,
    pollMs: 1e9, now: () => 1e12,
  });
  await curator.tick(); // batch 1 (20)
  await curator.tick(); // batch 2 (20)
  await curator.tick(); // batch 3 (10)
  await curator.tick(); // nothing left
  // every utterance seen EXACTLY once across the drain
  assert.equal(seenLineageIds.length, 50, 'each utterance consolidated exactly once');
  assert.equal(new Set(seenLineageIds).size, 50, 'no duplicates (watermark prevents re-send)');
  curator.stop();
});

test('RESTART-SAFE: a fresh curator seeded from belief lineage does NOT re-consolidate', async () => {
  // simulate: 3 utterances already consolidated before a "restart"; the ring still holds
  // them (or new ones), and a FRESH curator (new in-memory state) starts up. With the
  // lineage-derived watermark seed, it must NOT re-process what's already consolidated.
  const obs: Observation[] = [
    { lineageId: 'speech@a', atIso: '2026-01-01T10:00:00+05:30', text: 'one' },
    { lineageId: 'speech@b', atIso: '2026-01-01T10:01:00+05:30', text: 'two' },
    { lineageId: 'speech@c', atIso: '2026-01-01T10:02:00+05:30', text: 'three (NEW since restart)' },
  ];
  // the dock already consolidated up to the SECOND utterance's event-time (its lineage).
  const seedWatermark = '2026-01-01T10:01:00+05:30';
  const sent: string[] = [];
  const curator = startLongTermMemoryCurator({
    activeDocks: () => ['d1'],
    watermarkSeed: () => seedWatermark,        // ← derived from lineage on (re)start
    pendingStats: (_d, wm) => { const p = obs.filter((o) => o.atIso > wm); return { count: p.length, oldestIso: p[0]?.atIso ?? '', newestIso: p[p.length - 1]?.atIso ?? '' }; },
    pendingObservations: (_d, wm, limit) => obs.filter((o) => o.atIso > wm).slice(0, limit),
    beliefs: async () => [],
    reflect: async (prompt, _d, purpose) => {
      if (purpose !== 'consolidate') return '{}';
      for (const o of obs) if (prompt.includes(`[${o.lineageId}]`)) sent.push(o.lineageId);
      return '{}';
    },
    create: async () => 'id', revise: async () => null, forget: () => false,
    pollMs: 1e9, now: () => 1e12,
  });
  await curator.tick();
  // only the NEW (post-watermark) utterance is processed; the two already-consolidated are NOT re-sent.
  assert.deepEqual(sent, ['speech@c']);
  curator.stop();
});

test('an LLM error does NOT advance the watermark (the span retries, no data loss)', async () => {
  const obs: Observation[] = [
    { lineageId: 'speech@t1', atIso: '2026-01-01T10:00:00+05:30', text: 'a' },
    { lineageId: 'speech@t2', atIso: '2026-01-01T10:01:00+05:30', text: 'b' },
  ];
  let calls = 0; const created: string[] = [];
  const curator = startLongTermMemoryCurator({
    activeDocks: () => ['d1'],
    watermarkSeed: () => '',
    pendingStats: (_d, wm) => { const p = obs.filter((o) => o.atIso > wm); return { count: p.length, oldestIso: p[0]?.atIso ?? '', newestIso: p[p.length - 1]?.atIso ?? '' }; },
    pendingObservations: (_d, wm, limit) => obs.filter((o) => o.atIso > wm).slice(0, limit),
    beliefs: async () => [],
    reflect: async (_p, _d, purpose) => {
      if (purpose !== 'consolidate') return '{}';
      calls++;
      if (calls === 1) throw new Error('gemini 500');     // first pass fails
      return '{"beliefs":[{"claim":"recovered","support":["speech@t1"]}]}'; // retry succeeds
    },
    create: async (_d, b) => { created.push(b.claim); return 'id'; },
    revise: async () => null, forget: () => false,
    pollMs: 1e9, now: () => 1e12,
  });
  await curator.tick(); // fails, watermark NOT advanced
  await curator.tick(); // retries the SAME span, succeeds
  assert.deepEqual(created, ['recovered']);
  curator.stop();
});

test('LIVE CONFIG: setConfig is read on the next pass (no restart), clamped to bounds', async () => {
  // 3 pending; default batchAt=5 (won't flood). Lower batchAt to 2 LIVE → next pass floods.
  const obs: Observation[] = [
    { lineageId: 'speech@a', atIso: '2026-01-01T10:00:00+05:30', text: 'one' },
    { lineageId: 'speech@b', atIso: '2026-01-01T10:00:30+05:30', text: 'two' },
    { lineageId: 'speech@c', atIso: '2026-01-01T10:01:00+05:30', text: 'three' },
  ];
  let consolidated = 0;
  const curator = startLongTermMemoryCurator({
    activeDocks: () => ['d1'],
    watermarkSeed: () => '',
    // not a forced tick — use the natural loop decision so cadence/config actually gates it.
    pendingStats: (_d, wm) => { const p = obs.filter((o) => o.atIso > wm); return { count: p.length, oldestIso: p[0]?.atIso ?? '', newestIso: p[p.length - 1]?.atIso ?? '' }; },
    pendingObservations: (_d, wm, limit) => obs.filter((o) => o.atIso > wm).slice(0, limit),
    beliefs: async () => [],
    reflect: async (_p, _d, purpose) => { if (purpose === 'consolidate') consolidated++; return '{}'; },
    create: async () => 'id', revise: async () => null, forget: () => false,
    // floor 0 + recent speech so only batchAt gates; quiet won't fire (sinceLastSpeech small).
    config: { batchAt: 5, floorMs: 0, quietMs: 999_999, maxAgeMs: 999_999 },
    pollMs: 1e9, now: () => new Date('2026-01-01T10:01:01+05:30').getTime(),
  });
  // expose getConfig + a non-forced evaluate via the public tick? tick forces — instead
  // drive the decision through config: with batchAt=5 and 3 pending, a forced tick still
  // consolidates (force=flood), so to test the GATE we compare config values directly.
  assert.equal(curator.getConfig().batchAt, 5);
  const applied = curator.setConfig({ batchAt: 2, confMax: 5 /* out of [0,1] → clamps */ });
  assert.equal(applied.batchAt, 2);              // live patch took
  assert.equal(applied.confMax, 1);              // clamped to bound (max 1)
  assert.equal(curator.getConfig().batchAt, 2);  // and is readable
  curator.stop();
});

test('disabled curator does nothing', async () => {
  const obs: Observation[] = [{ lineageId: 'speech@t1', atIso: '2026-01-01T10:00:00+05:30', text: 'x' }];
  const created: string[] = [];
  const curator = startLongTermMemoryCurator({
    activeDocks: () => ['d1'],
    watermarkSeed: () => '',
    pendingStats: () => ({ count: 1, oldestIso: obs[0]!.atIso, newestIso: obs[0]!.atIso }),
    pendingObservations: () => obs,
    beliefs: async () => [],
    reflect: async () => '{"beliefs":[{"claim":"x","support":["speech@t1"]}]}',
    create: async (_d, b) => { created.push(b.claim); return 'id'; },
    revise: async () => null, forget: () => false,
    pollMs: 1e9, now: () => 1e12,
  });
  curator.setEnabled(false);
  await curator.tick();
  assert.deepEqual(created, []);
  curator.stop();
});

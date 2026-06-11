/**
 * UX-health metric tests (node:test) — pure TurnRecord in, metrics out. These
 * encode the failure modes mined from the live obs data, so a regression in
 * the dock's turn pipeline shows up here / on /api/observability/health.
 *
 *   npm test --workspace server
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { healthSummary, percentiles, turnHealth } from './health.js';
import type { TurnRecord } from './types.js';

function turn(over: Partial<TurnRecord>): TurnRecord {
  return {
    turnId: 't1', sessionId: 's1', startedAt: 1000, steps: [], llmCalls: 0,
    ...over,
  };
}

test('latency metrics: first token / first speech / settle / duration', () => {
  const h = turnHealth(turn({
    startedAt: 1000,
    endedAt: 4000,
    settledAt: 9000,
    steps: [
      { index: 0, startedAt: 1001, streamStartedAt: 2400, endedAt: 2500, tools: [] },
      { index: 1, startedAt: 2500, streamStartedAt: 3900, endedAt: 4000, tools: [] },
    ],
    speech: [{ startedAt: 3000, endedAt: 8800 }],
  }));
  assert.equal(h.firstTokenMs, 1400);   // first step's first delta
  assert.equal(h.firstSpeechMs, 2000);
  assert.equal(h.settleMs, 8000);
  assert.equal(h.durationMs, 3000);
  assert.equal(h.steps, 2);
  assert.equal(h.unfinished, false);
});

test('mid-turn speech drop is counted; the post-turn TTS tail is not', () => {
  const h = turnHealth(turn({
    startedAt: 0,
    endedAt: 10_000,
    speech: [
      { startedAt: 1000, endedAt: 2000 },
      { startedAt: 5000, endedAt: 6000 },    // fell + rose INSIDE the turn → drop
      { startedAt: 12_000, endedAt: 15_000 }, // after TurnEnd → legit tail, not a drop
    ],
  }));
  assert.equal(h.midTurnSpeechDrops, 1);
});

test('back-to-back windows (defensive close, gap 0) are not drops', () => {
  const h = turnHealth(turn({
    startedAt: 0, endedAt: 10_000,
    speech: [
      { startedAt: 1000, endedAt: 2000 },
      { startedAt: 2000, endedAt: 3000 },
    ],
  }));
  assert.equal(h.midTurnSpeechDrops, 0);
});

test('error steps + tool errors + unfinished turns are counted', () => {
  const h = turnHealth(turn({
    steps: [
      { index: 0, startedAt: 1, endedAt: 2, stopReason: 'TOOL_USE',
        tools: [{ toolCallId: 'a', toolName: 'move', startedAt: 1, isError: true }] },
      { index: 1, startedAt: 2, endedAt: 3, stopReason: 'ERROR', tools: [] },
    ],
    // no endedAt → unfinished
  }));
  assert.equal(h.errorSteps, 1);
  assert.equal(h.toolErrors, 1);
  assert.equal(h.unfinished, true);
});

test('percentiles: empty, single, and spread', () => {
  assert.deepEqual(percentiles([]), { n: 0 });
  assert.deepEqual(percentiles([7]), { p50: 7, p90: 7, max: 7, n: 1 });
  const p = percentiles([10, 20, 30, 40, 50, 60, 70, 80, 90, 100]);
  assert.equal(p.p50, 60);
  assert.equal(p.p90, 100);
  assert.equal(p.max, 100);
});

test('healthSummary aggregates across turns and tracks input tokens', () => {
  const turns: TurnRecord[] = [
    turn({
      turnId: 'a', startedAt: 0, endedAt: 2000,
      steps: [{ index: 0, startedAt: 0, streamStartedAt: 1000, endedAt: 2000,
        usage: { inputTokens: 500, outputTokens: 20 }, tools: [] }],
      speech: [{ startedAt: 1500, endedAt: 1900 }],
    }),
    turn({
      turnId: 'b', startedAt: 10_000, endedAt: 13_000,
      steps: [
        { index: 0, startedAt: 10_000, streamStartedAt: 12_000, endedAt: 12_500,
          stopReason: 'ERROR', usage: { inputTokens: 800 }, tools: [] },
      ],
    }),
  ];
  const s = healthSummary(turns);
  assert.equal(s.window, 2);
  assert.equal(s.firstTokenMs.n, 2);
  assert.equal(s.firstTokenMs.p50, 2000); // nearest-rank (upper) median of [1000, 2000]
  assert.equal(s.firstTokenMs.max, 2000);
  assert.equal(s.firstSpeechMs.n, 1);   // turn b never spoke
  assert.equal(s.errorSteps, 1);
  assert.equal(s.unfinishedTurns, 0);
  assert.equal(s.inputTokens.n, 2);
  assert.equal(s.inputTokens.max, 800);
});

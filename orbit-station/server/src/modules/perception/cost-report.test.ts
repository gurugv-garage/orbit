/**
 * cost-report tests (node:test) — the perception → Cost-tab spend math.
 *
 *   npm test --workspace server
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { geminiCost } from './cost-report.js';

test('flash-lite splits audio vs text input at the right rates', () => {
  // 1000 audio + 200 text prompt tokens, 50 output. flash-lite: text 0.10,
  // audio 0.30, out 0.40 per 1M.
  const { inputTokens, outputTokens, cost } = geminiCost('gemini-2.5-flash-lite', {
    promptTokenCount: 1200,
    candidatesTokenCount: 50,
    promptTokensDetails: [{ modality: 'AUDIO', tokenCount: 1000 }, { modality: 'TEXT', tokenCount: 200 }],
  });
  assert.equal(inputTokens, 1200);
  assert.equal(outputTokens, 50);
  // (200*0.10 + 1000*0.30 + 50*0.40) / 1e6
  const expected = (200 * 0.10 + 1000 * 0.30 + 50 * 0.40) / 1e6;
  assert.ok(Math.abs(cost - expected) < 1e-12, `${cost} vs ${expected}`);
});

test('no modality detail → all input billed as text', () => {
  const { cost } = geminiCost('gemini-2.5-flash-lite', { promptTokenCount: 1000, candidatesTokenCount: 0 });
  assert.ok(Math.abs(cost - (1000 * 0.10) / 1e6) < 1e-12);
});

test('dated/suffixed model id resolves by longest prefix', () => {
  const a = geminiCost('gemini-2.5-flash-lite-preview-09-2025', { promptTokenCount: 1000, candidatesTokenCount: 0 });
  const b = geminiCost('gemini-2.5-flash-lite', { promptTokenCount: 1000, candidatesTokenCount: 0 });
  assert.equal(a.cost, b.cost);
  // and it must NOT collapse to the shorter 'gemini-2.5-flash' price
  const flash = geminiCost('gemini-2.5-flash', { promptTokenCount: 1000, candidatesTokenCount: 0 });
  assert.notEqual(a.cost, flash.cost);
});

test('embedding model: input priced, output free, no audio', () => {
  const { cost } = geminiCost('gemini-embedding-001', { promptTokenCount: 1000, candidatesTokenCount: 0 });
  assert.ok(Math.abs(cost - (1000 * 0.15) / 1e6) < 1e-12);
});

test('unknown model → tokens recorded, cost 0 (never throws)', () => {
  const { inputTokens, outputTokens, cost } = geminiCost('some-future-model', {
    promptTokenCount: 500, candidatesTokenCount: 20,
  });
  assert.equal(inputTokens, 500);
  assert.equal(outputTokens, 20);
  assert.equal(cost, 0);
});

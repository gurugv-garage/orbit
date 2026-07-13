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

test('THINKING tokens are billed at the output rate (2.5 models report them separately)', () => {
  // A real gemini-2.5-flash enrich response: 1028 prompt (1023 audio + 5 text), 9 visible output,
  // 26 THINKING. Google bills output "including thinking tokens", so output = 9 + 26 = 35.
  const { inputTokens, outputTokens, cost } = geminiCost('gemini-2.5-flash', {
    promptTokenCount: 1028,
    candidatesTokenCount: 9,
    thoughtsTokenCount: 26,
    totalTokenCount: 1063,
    promptTokensDetails: [{ modality: 'AUDIO', tokenCount: 1023 }, { modality: 'TEXT', tokenCount: 5 }],
  });
  assert.equal(inputTokens, 1028);
  assert.equal(outputTokens, 35, 'output MUST include the 26 thinking tokens (was the under-count bug)');
  // flash: text 0.30, audio 1.00, out 2.50 per 1M — (5*0.30 + 1023*1.00 + 35*2.50)/1e6
  const expected = (5 * 0.30 + 1023 * 1.00 + 35 * 2.50) / 1e6;
  assert.ok(Math.abs(cost - expected) < 1e-12, `${cost} vs ${expected}`);
  // and it must be MORE than the old (buggy) calc that ignored thinking tokens.
  const buggy = (5 * 0.30 + 1023 * 1.00 + 9 * 2.50) / 1e6;
  assert.ok(cost > buggy, 'thinking-inclusive cost exceeds the old candidates-only cost');
});

test('no thinking field → output is just the visible tokens (back-compat)', () => {
  const { outputTokens } = geminiCost('gemini-2.5-flash', { promptTokenCount: 100, candidatesTokenCount: 12 });
  assert.equal(outputTokens, 12);
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

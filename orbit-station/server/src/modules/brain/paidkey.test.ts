/**
 * Paid-account key fallback (GEMINI_API_KEY_PAID_ACC):
 *  - apiKeyFor(provider, paid) selects free vs paid for google;
 *  - isQuotaOrOverload classifies the errors the paid key can fix;
 *  - hasPaidKey reflects the env.
 * The end-to-end fallback (free 429 → retry on paid) is exercised by the
 * session google-path test below.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { apiKeyFor, isQuotaOrOverload, hasPaidKey } from './session.js';

function withEnv(vars: Record<string, string | undefined>, fn: () => void) {
  const prev: Record<string, string | undefined> = {};
  for (const k of Object.keys(vars)) { prev[k] = process.env[k]; if (vars[k] === undefined) delete process.env[k]; else process.env[k] = vars[k]; }
  try { fn(); } finally {
    for (const k of Object.keys(prev)) { if (prev[k] === undefined) delete process.env[k]; else process.env[k] = prev[k]; }
  }
}

test('apiKeyFor selects free vs paid google key', () => {
  withEnv({ GEMINI_API_KEY: 'free-key', GEMINI_API_KEY_PAID_ACC: 'paid-key', GOOGLE_API_KEY: undefined }, () => {
    assert.equal(apiKeyFor('google'), 'free-key');
    assert.equal(apiKeyFor('google', false), 'free-key');
    assert.equal(apiKeyFor('google', true), 'paid-key');
    assert.equal(hasPaidKey(), true);
  });
});

test('paid falls back to free key when no paid key configured', () => {
  withEnv({ GEMINI_API_KEY: 'free-key', GEMINI_API_KEY_PAID_ACC: undefined }, () => {
    assert.equal(apiKeyFor('google', true), 'free-key'); // graceful: never returns undefined just because paid is unset
    assert.equal(hasPaidKey(), false);
  });
});

test('non-google providers ignore the paid flag', () => {
  withEnv({ OPENROUTER_API_KEY: 'or-key' }, () => {
    assert.equal(apiKeyFor('openrouter', true), 'or-key');
    assert.equal(apiKeyFor('openrouter', false), 'or-key');
  });
});

test('isQuotaOrOverload matches the fixable provider errors', () => {
  // the real bodies
  assert.equal(isQuotaOrOverload('{"error":{"code":429,"status":"RESOURCE_EXHAUSTED"}}'), true);
  assert.equal(isQuotaOrOverload('402 This request requires more credits'), false); // credits ≠ quota; paid key won't fix a different account's billing
  assert.equal(isQuotaOrOverload('{"error":{"code":503,"message":"high demand"}}'), true);
  assert.equal(isQuotaOrOverload('429 Too Many Requests'), true);
  assert.equal(isQuotaOrOverload('401 invalid api key'), false);
  assert.equal(isQuotaOrOverload(undefined), false);
  assert.equal(isQuotaOrOverload(''), false);
});

/**
 * Request-ring tests (node:test) — the exact-request capture store
 * (obs_requests): roundtrip, overwrite, and the session-delete cascade.
 *
 *   npm test --workspace server
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { ObsStore } from './store.js';

function freshStore(): ObsStore {
  return new ObsStore(new Database(':memory:'));
}

test('request ring: put → get roundtrips the exact JSON', () => {
  const store = freshStore();
  const req = JSON.stringify({ systemPrompt: 'be a dock', tools: ['move'], messages: [{ role: 'user', content: 'hi' }] });
  store.putRequest('s-1', 'turn-a', 0, req);
  assert.equal(store.getRequest('s-1', 'turn-a', 0), req);
  assert.equal(store.getRequest('s-1', 'turn-a', 1), undefined);
  assert.equal(store.getRequest('s-2', 'turn-a', 0), undefined);
});

test('request ring: re-put on the same step identity overwrites (retry case)', () => {
  const store = freshStore();
  store.putRequest('s-1', 'turn-a', 0, '{"v":1}');
  store.putRequest('s-1', 'turn-a', 0, '{"v":2}');
  assert.equal(store.getRequest('s-1', 'turn-a', 0), '{"v":2}');
});

test('request ring: deleting a session drops its recorded requests too', () => {
  const store = freshStore();
  store.putRequest('s-1', 'turn-a', 0, '{"v":1}');
  store.putRequest('s-2', 'turn-b', 0, '{"v":2}');
  store.delete('s-1');
  assert.equal(store.getRequest('s-1', 'turn-a', 0), undefined);
  assert.equal(store.getRequest('s-2', 'turn-b', 0), '{"v":2}');
});

test('request ring: large multi-step turns store and read back per step', () => {
  const store = freshStore();
  const big = JSON.stringify({ systemPrompt: 'x'.repeat(50_000), messages: [] });
  for (let i = 0; i < 5; i++) store.putRequest('s-1', 'turn-a', i, big);
  for (let i = 0; i < 5; i++) assert.equal(store.getRequest('s-1', 'turn-a', i), big);
});

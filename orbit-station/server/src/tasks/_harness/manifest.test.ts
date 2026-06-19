/**
 * Manifest input-schema validation (docs/tasks.md §2, §6, §11.E) — required
 * presence, defaults, coarse type checks, duration parsing.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateParams, durationMs, type TaskManifest } from './index.js';

const manifest: TaskManifest = {
  name: 'watch', description: 'x',
  params: [
    { name: 'condition', type: 'string', required: true },
    { name: 'interval', type: 'duration', default: '5s' },
    { name: 'count', type: 'number' },
  ],
};

test('applies defaults and passes valid values through', () => {
  const r = validateParams(manifest, { condition: 'hand raised', count: 3 });
  assert.ok(r.ok);
  assert.deepEqual(r.values, { condition: 'hand raised', interval: '5s', count: 3 });
});

test('refuses a missing required param', () => {
  const r = validateParams(manifest, { interval: '10s' });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes('condition')));
});

test('refuses an ill-typed param', () => {
  const r = validateParams(manifest, { condition: 'x', count: 'three' as unknown as number });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes('count')));
});

test('drops undeclared keys (schema is the contract)', () => {
  const r = validateParams(manifest, { condition: 'x', bogus: 1 as unknown });
  assert.ok(r.ok);
  assert.equal('bogus' in r.values, false);
});

test('durationMs parses units', () => {
  assert.equal(durationMs('500ms'), 500);
  assert.equal(durationMs('5s'), 5000);
  assert.equal(durationMs('10m'), 600000);
  assert.equal(durationMs('1h'), 3600000);
  assert.equal(durationMs(250), 250);
  assert.equal(durationMs('nonsense'), 0);
});

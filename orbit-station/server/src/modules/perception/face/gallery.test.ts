/**
 * Gallery unit tests (node:test) — pure math, no models. Verifies enroll, match
 * by nearest descriptor, threshold rejection, persistence, and removal.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { Gallery, euclidean } from './gallery.js';

const tmp = () => join(tmpdir(), `gallery-test-${Math.random().toString(36).slice(2)}.json`);
/** a 128-d descriptor that's `v` in every dim (so distances are predictable). */
const vec = (v: number) => new Array(128).fill(v);

test('euclidean distance is correct', () => {
  assert.equal(euclidean(vec(0), vec(0)), 0);
  // sqrt(128 * 1^2) = sqrt(128)
  assert.ok(Math.abs(euclidean(vec(0), vec(1)) - Math.sqrt(128)) < 1e-9);
});

test('enroll + exact match', () => {
  const path = tmp();
  try {
    const g = new Gallery(path);
    g.enroll('alice', vec(0.1));
    const m = g.match(vec(0.1));
    assert.ok(m && m.name === 'alice' && m.distance === 0);
  } finally { rmSync(path, { force: true }); }
});

test('nearest person wins among several', () => {
  const path = tmp();
  try {
    const g = new Gallery(path);
    g.enroll('alice', vec(0.0));
    g.enroll('bob', vec(0.5));
    // closer to bob
    const m = g.match(vec(0.48));
    assert.equal(m?.name, 'bob');
  } finally { rmSync(path, { force: true }); }
});

test('threshold rejects a far stranger', () => {
  const path = tmp();
  try {
    const g = new Gallery(path);
    g.enroll('alice', vec(0.0));
    // a descriptor far away (distance sqrt(128) ≈ 11.3 >> 0.6)
    assert.equal(g.match(vec(1.0)), null);
  } finally { rmSync(path, { force: true }); }
});

test('persists across instances', () => {
  const path = tmp();
  try {
    const a = new Gallery(path);
    a.enroll('alice', vec(0.2));
    const b = new Gallery(path); // reload from disk
    assert.deepEqual(b.names(), ['alice']);
    assert.ok(b.match(vec(0.2)));
  } finally { rmSync(path, { force: true }); }
});

test('multiple descriptors per person; match uses the nearest', () => {
  const path = tmp();
  try {
    const g = new Gallery(path);
    g.enroll('alice', vec(0.0));
    g.enroll('alice', vec(0.9), undefined, true); // append a second angle
    // query near the second descriptor still matches alice
    const m = g.match(vec(0.92));
    assert.equal(m?.name, 'alice');
  } finally { rmSync(path, { force: true }); }
});

test('remove drops a person', () => {
  const path = tmp();
  try {
    const g = new Gallery(path);
    g.enroll('alice', vec(0.1));
    assert.equal(g.remove('alice'), true);
    assert.equal(g.match(vec(0.1)), null);
    assert.equal(g.remove('nobody'), false);
  } finally { rmSync(path, { force: true }); }
});

/**
 * Gallery unit tests (node:test) — pure math, no models. Verifies enroll, match
 * by nearest descriptor, threshold rejection, persistence, and removal.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync, writeFileSync, readFileSync } from 'node:fs';
import { Gallery, euclidean, classifyDistance, MATCH_THRESHOLD, TENTATIVE_THRESHOLD } from './gallery.js';

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

test('each enroll keeps its own photo; people() exposes per-sample photos', () => {
  const path = tmp();
  try {
    const g = new Gallery(path);
    g.enroll('alice', vec(0.0), 'PHOTO_A');
    g.enroll('alice', vec(0.9), 'PHOTO_B', true); // 2nd angle, its own photo
    const people = g.people();
    assert.equal(people.length, 1);
    assert.equal(people[0]!.name, 'alice');
    assert.deepEqual(people[0]!.samples, [
      { index: 0, photo: 'PHOTO_A' },
      { index: 1, photo: 'PHOTO_B' },
    ]);
  } finally { rmSync(path, { force: true }); }
});

test('removeSample drops one fingerprint; last one removes the person', () => {
  const path = tmp();
  try {
    const g = new Gallery(path);
    g.enroll('alice', vec(0.0), 'A');
    g.enroll('alice', vec(0.9), 'B', true);
    // drop the first sample → alice still matches near the second
    assert.equal(g.removeSample('alice', 0), true);
    assert.equal(g.people()[0]!.samples.length, 1);
    assert.equal(g.match(vec(0.9))?.name, 'alice');
    // out-of-range is a no-op
    assert.equal(g.removeSample('alice', 5), false);
    // dropping the last sample removes the person entirely
    assert.equal(g.removeSample('alice', 0), true);
    assert.deepEqual(g.names(), []);
  } finally { rmSync(path, { force: true }); }
});

test('migrates legacy {descriptors,photo} on load', () => {
  const path = tmp();
  try {
    // hand-write the OLD on-disk shape: descriptors[] + a single shared photo.
    writeFileSync(path, JSON.stringify([
      { name: 'Guru', descriptors: [vec(0.1), vec(0.2)], photo: 'OLD_PHOTO', enrolledAt: 123 },
    ]));
    const g = new Gallery(path);
    // still matches both descriptors
    assert.equal(g.match(vec(0.1))?.name, 'Guru');
    assert.equal(g.match(vec(0.2))?.name, 'Guru');
    // migrated to samples: photo on the first, none on the rest
    const samples = g.people()[0]!.samples;
    assert.deepEqual(samples, [{ index: 0, photo: 'OLD_PHOTO' }, { index: 1, photo: undefined }]);
    // and the migration was persisted in the new shape
    const onDisk = JSON.parse(readFileSync(path, 'utf-8')) as { samples?: unknown }[];
    assert.ok(Array.isArray(onDisk[0]!.samples));
  } finally { rmSync(path, { force: true }); }
});

// ── verdict classification + voice-enroll append semantics ──────────────────

test('classifyDistance: one definition, correct boundaries', () => {
  assert.equal(classifyDistance(0.3), 'confident');
  assert.equal(classifyDistance(MATCH_THRESHOLD), 'confident');        // inclusive
  assert.equal(classifyDistance(MATCH_THRESHOLD + 0.001), 'tentative');
  assert.equal(classifyDistance(TENTATIVE_THRESHOLD), 'tentative');    // inclusive
  assert.equal(classifyDistance(TENTATIVE_THRESHOLD + 0.001), 'none');
  // the band is wide enough for the confirm/learn loop to actually fire
  assert.ok(TENTATIVE_THRESHOLD - MATCH_THRESHOLD >= 0.1,
    'tentative band must be wide enough to hedge-and-confirm');
});

test('has() is case/space-insensitive', () => {
  const path = tmp();
  try {
    const g = new Gallery(path);
    g.enroll('Guru', vec(0.1));
    assert.ok(g.has('guru '));
    assert.ok(!g.has('shweta'));
  } finally { rmSync(path, { force: true }); }
});

test('voice re-enroll APPENDS for a known name instead of wiping samples', () => {
  const path = tmp();
  try {
    const g = new Gallery(path);
    // build up a person with 3 samples (initial + 2 confirms)
    g.enroll('Guru', vec(0.1));
    g.enroll('Guru', vec(0.2), undefined, true);
    g.enroll('Guru', vec(0.3), undefined, true);
    assert.equal(g.people()[0]!.samples.length, 3);
    // the voice flow's call shape: append = gallery.has(name)
    g.enroll('Guru', vec(0.4), undefined, g.has('Guru'));
    assert.equal(g.people()[0]!.samples.length, 4, 're-enroll must not wipe prior samples');
    // all four descriptors still match
    assert.equal(g.match(vec(0.1))?.name, 'Guru');
    assert.equal(g.match(vec(0.4))?.name, 'Guru');
    // a brand-new name with the same call shape starts fresh
    g.enroll('Shweta', vec(0.9), undefined, g.has('Shweta'));
    assert.equal(g.has('Shweta'), true);
  } finally { rmSync(path, { force: true }); }
});

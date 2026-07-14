/**
 * VoiceGallery unit tests (node:test) — pure math, no models. Verifies enroll,
 * cosine matching, verdict classification, persistence, and removal.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync, readFileSync } from 'node:fs';
import { VoiceGallery, cosine, classifyScore, VOICE_MATCH, VOICE_REJECT } from './gallery.js';

const tmp = () => join(tmpdir(), `voice-gallery-test-${Math.random().toString(36).slice(2)}.json`);

/** unit vector along axis i of a 192-d space. */
const axis = (i: number) => { const v = new Array(192).fill(0); v[i] = 1; return v; };
/** unit vector between axes a and b (cosine 1/√2 ≈ 0.707 to each). */
const mix = (a: number, b: number) => {
  const v = new Array(192).fill(0); v[a] = Math.SQRT1_2; v[b] = Math.SQRT1_2; return v;
};

test('cosine: identical=1, orthogonal=0, mixed=√½', () => {
  assert.ok(Math.abs(cosine(axis(0), axis(0)) - 1) < 1e-9);
  assert.ok(Math.abs(cosine(axis(0), axis(1))) < 1e-9);
  assert.ok(Math.abs(cosine(mix(0, 1), axis(0)) - Math.SQRT1_2) < 1e-9);
});

test('cosine normalizes non-unit inputs', () => {
  const doubled = axis(0).map((x) => x * 2);
  assert.ok(Math.abs(cosine(doubled, axis(0)) - 1) < 1e-9);
});

test('classifyScore bands', () => {
  assert.equal(classifyScore(VOICE_MATCH), 'match');
  assert.equal(classifyScore((VOICE_MATCH + VOICE_REJECT) / 2), 'unknown');
  assert.equal(classifyScore(VOICE_REJECT - 0.01), 'other');
});

test('enroll + match nearest by cosine', () => {
  const p = tmp();
  try {
    const g = new VoiceGallery(p);
    g.enroll('Guru', axis(0), 'hello there');
    g.enroll('Anne', axis(1), 'hi');
    const m = g.match(mix(0, 2))!; // closer to guru's axis than anne's
    assert.equal(m.name, 'Guru');
    assert.ok(Math.abs(m.score - Math.SQRT1_2) < 1e-9);
  } finally { rmSync(p, { force: true }); }
});

test('match returns best-even-below-threshold; caller classifies', () => {
  const p = tmp();
  try {
    const g = new VoiceGallery(p);
    g.enroll('Guru', axis(0));
    const m = g.match(axis(5))!; // orthogonal — score ~0
    assert.equal(m.name, 'Guru');
    assert.equal(classifyScore(m.score), 'other');
  } finally { rmSync(p, { force: true }); }
});

test('match on empty gallery returns null', () => {
  const p = tmp();
  try {
    assert.equal(new VoiceGallery(p).match(axis(0)), null);
  } finally { rmSync(p, { force: true }); }
});

test('persistence round-trip + case-insensitive identity', () => {
  const p = tmp();
  try {
    const g1 = new VoiceGallery(p);
    g1.enroll('guru', axis(0), 'line one');
    g1.enroll('GURU ', axis(1), 'line two'); // same person, appends
    const g2 = new VoiceGallery(p);
    assert.deepEqual(g2.names(), ['Guru']);
    assert.equal(g2.people()[0]!.samples.length, 2);
    assert.equal(g2.people()[0]!.samples[1]!.text, 'line two');
    const raw = JSON.parse(readFileSync(p, 'utf-8'));
    assert.equal(raw.length, 1);
  } finally { rmSync(p, { force: true }); }
});

test('append=false replaces prior samples; remove/removeSample', () => {
  const p = tmp();
  try {
    const g = new VoiceGallery(p);
    g.enroll('Guru', axis(0));
    g.enroll('Guru', axis(1));
    g.enroll('Guru', axis(2), undefined, false); // replace
    assert.equal(g.people()[0]!.samples.length, 1);
    assert.ok(g.removeSample('guru', 0));
    assert.equal(g.size(), 0); // last sample removed the person
    g.enroll('Anne', axis(3));
    assert.ok(g.remove('ANNE'));
    assert.equal(g.size(), 0);
  } finally { rmSync(p, { force: true }); }
});

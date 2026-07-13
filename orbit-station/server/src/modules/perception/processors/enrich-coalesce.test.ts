import { test } from 'node:test';
import assert from 'node:assert/strict';
import { coalesceSegments, type EnrichSegment } from './audio-enricher.js';

// THE BUG (seen live 2026-07-12): the enricher returned one segment PER WORD with degenerate
// (~0s) timestamps — "one","is","good.","And","then"… as separate records. coalesceSegments
// merges consecutive same-speaker fragments into whole utterances and spreads degenerate times.
const seg = (fromMs: number, toMs: number, text: string, speaker = 0, extra: Partial<EnrichSegment> = {}): EnrichSegment => ({
  fromMs, toMs, text, speaker, source: 'speech', salience: 'low', addressedToRobot: false, ...extra,
});

test('merges per-word fragments from one speaker into a single utterance', () => {
  const words = ['Okay,', 'and', 'then', 'we', 'can', 'do', 'the', 'other', 'one', 'again.']
    .map((w, i) => seg(i * 50, i * 50 + 40, w)); // all ~0s-ish, same speaker
  const out = coalesceSegments(words, 10_000);
  assert.equal(out.length, 1, 'ten word-fragments → one utterance');
  assert.equal(out[0]!.text, 'Okay, and then we can do the other one again.');
});

test('starts a new segment when the speaker changes', () => {
  const segs = [
    seg(0, 100, 'How do we separate the salts?', 0),
    seg(150, 300, "Let's use crystallization.", 1),
    seg(320, 400, 'Good idea.', 0),
  ];
  const out = coalesceSegments(segs, 10_000);
  assert.equal(out.length, 3, 'three speakers turns stay distinct');
});

test('spreads degenerate (all-zero) timestamps across the real window', () => {
  const segs = [seg(0, 0, 'First sentence.', 0), seg(0, 0, 'Second one.', 1), seg(0, 0, 'Third.', 0)];
  const out = coalesceSegments(segs, 9_000);
  assert.equal(out.length, 3);
  assert.ok(out[0]!.fromMs === 0 && out[0]!.toMs === 3000, 'first third of the window');
  assert.ok(out[2]!.toMs === 9000, 'last segment reaches the window end');
  assert.ok(out[0]!.toMs > out[0]!.fromMs, 'no zero-width segments after spread');
});

test('a run with a >1.2s gap is NOT merged (a real pause = new utterance)', () => {
  const segs = [seg(0, 800, 'One thought.', 0), seg(2500, 3200, 'A separate thought.', 0)]; // 1.7s gap
  const out = coalesceSegments(segs, 10_000);
  assert.equal(out.length, 2, 'the pause splits them');
});

test('salience/addressed escalate when merging (a notable/addressed fragment lifts the utterance)', () => {
  const segs = [
    seg(0, 100, 'Hey', 0),
    seg(120, 300, 'orbit stop that!', 0, { salience: 'notable', addressedToRobot: true }),
  ];
  const out = coalesceSegments(segs, 10_000);
  assert.equal(out.length, 1);
  assert.equal(out[0]!.salience, 'notable', 'merged utterance takes the higher salience');
  assert.equal(out[0]!.addressedToRobot, true, 'addressed carries through the merge');
});

test('drops a consecutive duplicate sentence (overlap re-emit)', () => {
  const segs = [
    seg(0, 1000, "It's a whole element that we can do.", 0),
    seg(1100, 2000, "It's a whole element that we can do.", 0), // exact re-emit across an overlap
    seg(2100, 3000, 'Next thing.', 0),
  ];
  const out = coalesceSegments(segs, 10_000);
  const texts = out.map((s) => s.text);
  assert.equal(texts.filter((t) => t.startsWith("It's a whole")).length, 1, 'the duplicate is dropped');
});

test('does not glue two complete sentences into one run', () => {
  const segs = [
    seg(0, 800, 'First complete thought.', 0),   // ends with '.'
    seg(900, 1700, 'Second complete thought.', 0), // < 1.2s gap but prev already ended a sentence
  ];
  const out = coalesceSegments(segs, 10_000);
  assert.equal(out.length, 2, 'a period boundary keeps sentences separate');
});

test('degenerate spread caps segment length (no 20s blobs)', () => {
  const segs = [seg(0, 0, 'One.', 0), seg(0, 0, 'Two.', 1)];
  const out = coalesceSegments(segs, 40_000); // 40s window, 2 segs → slots are 20s
  assert.ok(out.every((s) => s.toMs - s.fromMs <= 8000), 'each spread segment is capped at 8s, not 20s');
});

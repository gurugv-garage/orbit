/**
 * Ported verbatim from the dock's StreamingReplyExtractorTest.kt — these
 * vectors are the segmentation spec; the Kotlin file is deleted at cutover.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SentenceStreamer } from './sentence.js';

/** Push a list of cumulative-text snapshots, collecting all sentences emitted. */
function drive(snapshots: string[], flush = true): string[] {
  const ex = new SentenceStreamer();
  const out: string[] = [];
  for (const s of snapshots) out.push(...ex.push(s));
  if (flush) {
    const tail = ex.flush();
    if (tail != null) out.push(tail);
  }
  return out;
}

/** Simulate streaming a final string in growing prefixes (1 char at a time). */
function prefixes(full: string): string[] {
  return Array.from({ length: full.length }, (_, i) => full.substring(0, i + 1));
}

test('emits first complete sentence while more streams', () => {
  const ex = new SentenceStreamer();
  assert.deepEqual(ex.push('Hello there. And the'), ['Hello there.']);
});

test('does not emit partial sentence', () => {
  const ex = new SentenceStreamer();
  assert.deepEqual(ex.push('Hello the'), []);
});

test('emits sentences across chunks then flushes tail', () => {
  const out = drive([
    'One thing. ',
    'One thing. Two things! ',
    'One thing. Two things! A trailing bit',
  ]);
  assert.deepEqual(out, ['One thing.', 'Two things!', 'A trailing bit']);
});

test('handles prose streamed char by char', () => {
  assert.deepEqual(drive(prefixes('Hi there! How are you?')), ['Hi there!', 'How are you?']);
});

test('does not re-split already emitted sentences', () => {
  const ex = new SentenceStreamer();
  assert.deepEqual(ex.push('First. '), ['First.']);
  assert.deepEqual(ex.push('First. Second. '), ['Second.']); // not "First." again
});

test('handles ellipsis and multi-punct', () => {
  const ex = new SentenceStreamer();
  assert.deepEqual(ex.push('Wait… really?! Yes. '), ['Wait…', 'really?!', 'Yes.']);
});

test('flush returns the trailing clause', () => {
  const ex = new SentenceStreamer();
  ex.push('All done. ');                 // emits "All done."
  ex.push('All done. one more bit');     // trailing, no terminator
  assert.equal(ex.flush(), 'one more bit');
});

test('flush returns null when everything emitted', () => {
  const ex = new SentenceStreamer();
  ex.push('All done. ');
  assert.equal(ex.flush(), null);
});

test('liveText returns full prefix without consuming', () => {
  const ex = new SentenceStreamer();
  assert.equal(ex.liveText('Hello the'), 'Hello the');
  // liveText doesn't consume, so push still emits the sentence once done.
  assert.deepEqual(ex.push('Hello there. '), ['Hello there.']);
});

test('liveText null when empty', () => {
  assert.equal(new SentenceStreamer().liveText(''), null);
});

test('flush is idempotent', () => {
  const ex = new SentenceStreamer();
  ex.push('Tail with no end');
  assert.equal(ex.flush(), 'Tail with no end');
  assert.equal(ex.flush(), null);
  assert.deepEqual(ex.push('more'), []); // no output after flush
});

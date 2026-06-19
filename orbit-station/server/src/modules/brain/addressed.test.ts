import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { newLatch, tap, decideAddressed, type Utterance } from './addressed.js';

/** Helper: an utterance spanning [from, to] ms. */
const utt = (from: number, to: number): Utterance => ({ startedAt: from, endedAt: to });

describe('addressed-latch correlator (A1.2)', () => {
  it('not addressed without a tap', () => {
    const { addressed, next } = decideAddressed(newLatch(), utt(100, 500));
    assert.equal(addressed, false);
    assert.equal(next.tapAt, null);
  });

  it('tap-then-speak: utterance starting after the tap is addressed', () => {
    const l = tap(newLatch(), 1000);
    const { addressed, next } = decideAddressed(l, utt(1200, 1800));
    assert.equal(addressed, true);
    assert.equal(next.tapAt, null, 'latch clears at sentence-end');
  });

  it('tap-mid-sentence: utterance in progress at the tap is addressed (started before, ends after)', () => {
    // The user is already talking; the tap lands partway through. That whole
    // sentence should count — the case the user called out explicitly.
    const l = tap(newLatch(), 1500);
    const { addressed, next } = decideAddressed(l, utt(1000, 2200));
    assert.equal(addressed, true);
    assert.equal(next.tapAt, null);
  });

  it('tap-at-the-very-end: utterance ending exactly at the tap is addressed (boundary)', () => {
    const l = tap(newLatch(), 2000);
    const { addressed } = decideAddressed(l, utt(1000, 2000));
    assert.equal(addressed, true);
  });

  it('stale utterance: one that ENDED before the tap is NOT addressed, and the latch stays armed', () => {
    // The tap was meant for a LATER sentence; a sentence that already finished
    // before the tap is the past (this is the deferred walk-back boundary —
    // Decision 2b would grab it; the simple latch does not).
    const l = tap(newLatch(), 2000);
    const { addressed, next } = decideAddressed(l, utt(500, 1500));
    assert.equal(addressed, false);
    assert.equal(next.tapAt, 2000, 'latch NOT consumed by a stale utterance');
  });

  it('one tap → one turn: the next utterance (no new tap) is overheard', () => {
    let l = tap(newLatch(), 1000);
    const first = decideAddressed(l, utt(1100, 1700));
    assert.equal(first.addressed, true);
    l = first.next;
    const second = decideAddressed(l, utt(2000, 2600));
    assert.equal(second.addressed, false, 'sentence-end cleared the latch');
  });

  it('two taps before an utterance: the later tap wins, still one turn', () => {
    let l = tap(newLatch(), 1000);
    l = tap(l, 1400);
    assert.equal(l.tapAt, 1400);
    const { addressed, next } = decideAddressed(l, utt(1500, 2100));
    assert.equal(addressed, true);
    assert.equal(next.tapAt, null);
  });

  it('re-tap after a turn re-arms for the next sentence', () => {
    let l = tap(newLatch(), 1000);
    l = decideAddressed(l, utt(1100, 1700)).next; // consumed
    assert.equal(l.tapAt, null);
    l = tap(l, 3000);                              // re-tap
    const { addressed } = decideAddressed(l, utt(3100, 3700));
    assert.equal(addressed, true);
  });
});

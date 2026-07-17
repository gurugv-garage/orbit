/**
 * SpeechGate — the audio-clock barriers behind the move tool's timing
 * (docs/decision-traces/motion-speech-timing.md). The contract under test:
 * waitQuiet releases on TTS drain, waitAnchor on the tagged sentence's
 * playback start, both fall back to a timeout, and cancel/reset never leave
 * a motion queued to fire into an interruption.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SpeechGate } from './speech-gate.js';

test('waitQuiet is immediate when nothing was sent', async () => {
  const g = new SpeechGate();
  assert.equal(await g.waitQuiet(), 'immediate');
});

test('waitQuiet resolves on the quiet signal (TTS drain)', async () => {
  const g = new SpeechGate();
  g.noteSent(40);
  const p = g.waitQuiet();
  g.noteQuiet();
  assert.equal(await p, 'quiet');
});

test('waitQuiet is immediate again after a drain', async () => {
  const g = new SpeechGate();
  g.noteSent(40);
  g.noteQuiet();
  assert.equal(await g.waitQuiet(), 'immediate');
});

test('waitAnchor resolves when that sentence starts playing', async () => {
  const g = new SpeechGate();
  g.noteSent(20);
  g.noteAnchor(2);
  const seq = g.takeAnchor();
  assert.equal(seq, 2);
  const p = g.waitAnchor(seq!);
  g.noteUtteranceActive(1); // earlier sentence — not yet
  g.noteUtteranceActive(2); // the anchor sentence
  assert.equal(await p, 'spoken');
});

test('waitAnchor is immediate when the sentence already played', async () => {
  const g = new SpeechGate();
  g.noteUtteranceActive(3);
  assert.equal(await g.waitAnchor(2), 'spoken');
});

test('waitAnchor falls back to quiet (old app builds never ack)', async () => {
  const g = new SpeechGate();
  g.noteSent(20);
  g.noteAnchor(0);
  const p = g.waitAnchor(g.takeAnchor()!);
  g.noteQuiet(); // lane drained without any utterance-active
  assert.equal(await p, 'quiet');
});

test('takeAnchor consumes — a second take returns undefined', () => {
  const g = new SpeechGate();
  g.noteAnchor(1);
  assert.equal(g.takeAnchor(), 1);
  assert.equal(g.takeAnchor(), undefined);
});

test('cancel releases every waiter as cancelled', async () => {
  const g = new SpeechGate();
  g.noteSent(500);
  const q = g.waitQuiet();
  const a = g.waitAnchor(4);
  g.cancel();
  assert.equal(await q, 'cancelled');
  assert.equal(await a, 'cancelled');
});

test('reset clears the anchor and the unspoken state', async () => {
  const g = new SpeechGate();
  g.noteSent(100);
  g.noteAnchor(3);
  g.reset();
  assert.equal(g.takeAnchor(), undefined);
  assert.equal(await g.waitQuiet(), 'immediate'); // no carried-over unspoken chars
});

test('reset does not leak playback state across turns', async () => {
  const g = new SpeechGate();
  g.noteUtteranceActive(9);
  g.reset();
  // seq 0 of the NEW turn must not look already-played
  g.noteSent(10);
  const p = g.waitAnchor(0);
  g.noteUtteranceActive(0);
  assert.equal(await p, 'spoken');
});

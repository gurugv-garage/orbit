/**
 * isStopIntent fixture table — WI-2's committed precision/recall record
 * (busy-queue-black-hole.md Addendum 3). Positives are reflex stops a user
 * says over the dock's reply/motion; negatives are content that HAPPENS to
 * contain stop words and must go to the busy queue instead (a false cancel
 * eats a real reply — precision beats recall).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isStopIntent } from './stop-intent.js';

const POSITIVES = [
  'Stop.',
  'stop',
  'Stop it.',
  'Okay stop.',
  'stop stop stop',
  'Never mind.',
  'nevermind',
  'Actually never mind, stop moving.', // D1's exact class
  'Wait.',
  'wait wait wait',
  'No wait.',
  'Hold on.',
  'Hold on a moment — actually just wait', // filler + cores only… (see note below)
  'Enough.',
  'Be quiet.',
  'Shut up.',
  'Shh.',
  'Orbit, stop.',
  'Hey, stop talking.',
  'Cancel that.',
  'Stop, never mind.',
];

const NEGATIVES = [
  '', // empty
  '!',
  'Tell me about the bus stop.',
  'Tell me a story about stopping.',
  'What should I stop doing to sleep better?',
  'Wait, what is the capital of France?', // a redirect — queue + answer, not cancel
  'I can wait for you.',
  'Never say never.',
  'Hold on to your dreams.',
  'The rain will stop tomorrow, right?',
  'Can you count without stopping?',
  'Non-stop flights are better.',
  'My watch stopped.',
  'Put it where the music stops.',
  'Wait, tell me a joke instead.', // content redirect
  'What does never mind mean in Hindi?', // content question about the phrase
];

test('positives: bare reflex stops match', () => {
  for (const s of POSITIVES) {
    assert.equal(isStopIntent(s), true, `expected STOP: "${s}"`);
  }
});

test('negatives: content with embedded stop words must NOT match', () => {
  for (const s of NEGATIVES) {
    assert.equal(isStopIntent(s), false, `expected NOT stop: "${s}"`);
  }
});

test('length guard: a long sentence of stop-ish words is not a reflex', () => {
  assert.equal(isStopIntent('wait wait wait wait wait wait wait wait wait wait'), false);
});

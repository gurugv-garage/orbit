/**
 * matchesWake — the wake-phrase match for the orchestrator's `wakeUp` behaviour. Lenient
 * (STT phrasing varies) but not trigger-happy: the phrase must appear near the START of the
 * utterance, case/punctuation-insensitive, with at most a little filler before it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchesWake } from './index.js';

const P = 'hey orbit';

test('plain phrase matches', () => {
  assert.equal(matchesWake('hey orbit', P), true);
});

test('case + punctuation insensitive', () => {
  assert.equal(matchesWake('Hey, Orbit!', P), true);
  assert.equal(matchesWake('HEY ORBIT?', P), true);
});

test('a little filler before the phrase still wakes', () => {
  assert.equal(matchesWake('um hey orbit', P), true);
  assert.equal(matchesWake('ok, hey orbit', P), true);
});

test('trailing words after the phrase still wake', () => {
  assert.equal(matchesWake('hey orbit are you there', P), true);
  assert.equal(matchesWake('hey orbit, what time is it', P), true);
});

test('phrase buried mid-sentence does NOT wake (not addressed-from-idle)', () => {
  assert.equal(matchesWake('so i was telling sam to say hey orbit later', P), false);
  assert.equal(matchesWake('the thing about hey orbit is whatever', P), false);
});

test('partial / wrong phrase does not match', () => {
  assert.equal(matchesWake('hey there', P), false);
  assert.equal(matchesWake('orbit', P), false);     // missing "hey" lead
  assert.equal(matchesWake('hey jarvis', P), false);
});

test('empty inputs are safe', () => {
  assert.equal(matchesWake('', P), false);
  assert.equal(matchesWake('hey orbit', ''), false);
});

test('a custom phrase works (tunable)', () => {
  assert.equal(matchesWake('okay computer do this', 'okay computer'), true);
  assert.equal(matchesWake('hey orbit', 'okay computer'), false);
});

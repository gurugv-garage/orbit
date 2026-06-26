/**
 * matchesWake — the wake-phrase match for the conductor's `wakeUp` behaviour. Lenient
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
  assert.equal(matchesWake('hey jarvis', P), false);
});

test('the NAME alone wakes — STT often drops/mangles "hey" but lands "orbit"', () => {
  assert.equal(matchesWake('orbit', P), true);          // bare name
  assert.equal(matchesWake('Orbit?', P), true);
  assert.equal(matchesWake('orbit are you there', P), true); // name first + trailing
});

test('a single short filler before the name wakes (the observed STT mishears)', () => {
  assert.equal(matchesWake('okay orbit', P), true);     // "hey"→"okay"
  assert.equal(matchesWake('K orbit.', P), true);       // "hey"→"k"
  assert.equal(matchesWake('hi orbit', P), true);
  assert.equal(matchesWake('yo orbit', P), true);
});

test('name as a substring of another word does NOT wake', () => {
  assert.equal(matchesWake('orbital mechanics', P), false); // whole-word only
  assert.equal(matchesWake('exorbitant', P), false);
});

test('two non-filler words before the name does NOT wake', () => {
  // only ONE short filler is allowed before the bare name (rule 2); a real lead-in
  // ("i said orbit") is not a wake-from-idle call.
  assert.equal(matchesWake('i said orbit', P), false);
});

test('empty inputs are safe', () => {
  assert.equal(matchesWake('', P), false);
  assert.equal(matchesWake('hey orbit', ''), false);
});

test('a custom phrase works (tunable)', () => {
  assert.equal(matchesWake('okay computer do this', 'okay computer'), true);
  assert.equal(matchesWake('hey orbit', 'okay computer'), false);
});

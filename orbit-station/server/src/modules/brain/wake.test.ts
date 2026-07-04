/**
 * matchesWake — the wake-phrase match for the conductor's `wakeUp` behaviour. Lenient
 * (STT phrasing varies) but not trigger-happy: the phrase must appear near the START of the
 * utterance, case/punctuation-insensitive, with at most a little filler before it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchesWake, stripWake } from './index.js';

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

test('two non-filler words before a LEADING name is not a start-anchored wake', () => {
  // rule (2) allows only ONE short filler before the bare name, so "i said orbit later" (name
  // mid-sentence) does not wake. But when the name is the LAST word, the trailing-address rule
  // (3) DOES wake ("i said orbit" reads as addressing the dock) — that's the intended tradeoff.
  assert.equal(matchesWake('i said orbit later', P), false); // name buried mid-sentence
  assert.equal(matchesWake('i said orbit', P), true);        // name trailing → term of address
});

test('empty inputs are safe', () => {
  assert.equal(matchesWake('', P), false);
  assert.equal(matchesWake('hey orbit', ''), false);
});

test('a custom phrase works (tunable)', () => {
  assert.equal(matchesWake('okay computer do this', 'okay computer'), true);
  assert.equal(matchesWake('hey orbit', 'okay computer'), false);
});

// stripWake — split a matched utterance into the wake lead-in + the trailing COMMAND, so a
// "hey orbit, look right" runs the command instead of deflecting to "did you call me?".
test('bare wake yields no command', () => {
  assert.equal(stripWake('hey orbit', P), '');
  assert.equal(stripWake('Hey, Orbit!', P), '');
  assert.equal(stripWake('okay orbit', P), '');
  assert.equal(stripWake('orbit', P), '');
});

test('wake + command returns the command, original casing preserved', () => {
  assert.equal(stripWake('Hey Orbit, look to your right.', P), 'look to your right.');
  assert.equal(stripWake('hey orbit what time is it', P), 'what time is it');
  assert.equal(stripWake('orbit, turn left', P), 'turn left');
  assert.equal(stripWake('okay orbit play some music', P), 'play some music');
});

test('boundary punctuation between wake and command is trimmed, inner kept', () => {
  assert.equal(stripWake('hey orbit — set a timer for 5 min', P), 'set a timer for 5 min');
  assert.equal(stripWake('orbit: what is 2+2?', P), 'what is 2+2?');
});

test('custom phrase strips correctly', () => {
  assert.equal(stripWake('okay computer do this', 'okay computer'), 'do this');
});

// Soundalikes — STT/diarization mis-render "orbit" as real words; those still wake + strip.
test('soundalikes of the name wake', () => {
  assert.equal(matchesWake('hey albert', P), true);
  assert.equal(matchesWake('robert what time is it', P), true);
  assert.equal(matchesWake('okay orbot play music', P), true);
  assert.equal(matchesWake('or bit turn left', P), true); // two-word rendering
});

test('soundalikes strip to the command', () => {
  assert.equal(stripWake('hey albert, look right', P), 'look right');
  assert.equal(stripWake('robert what time is it', P), 'what time is it');
  assert.equal(stripWake('or bit turn left', P), 'turn left');
});

test('soundalike is whole-word only (no false wake)', () => {
  assert.equal(matchesWake('orbital mechanics', P), false);
  assert.equal(matchesWake('albertine was here', P), false); // "albertine" != "albert"
});

test('a real non-soundalike word does not wake', () => {
  assert.equal(matchesWake('hey there sam', P), false);
  assert.equal(matchesWake('turn the light on', P), false);
});

// Trailing term of address ("good job, orbit") — the name at the END is a strong addressed
// signal even though it's not up front. The praise itself is the content → real reply, not ack.
test('trailing name wakes (term of address)', () => {
  assert.equal(matchesWake('good job, orbit', P), true);
  assert.equal(matchesWake('job well done, orbit', P), true);
  assert.equal(matchesWake('thanks orbit', P), true);
  assert.equal(matchesWake('nice work albert', P), true); // soundalike at end
});

test('trailing name strips to the praise/content (before the name)', () => {
  assert.equal(stripWake('good job, orbit', P), 'good job');
  assert.equal(stripWake('Job well done, Orbit.', P), 'Job well done');
  assert.equal(stripWake('nice work albert', P), 'nice work');
});

test('name buried in the MIDDLE still does NOT wake (a mention, not an address)', () => {
  assert.equal(matchesWake('so i told orbit stories yesterday', P), false);
  assert.equal(matchesWake('the orbit of the moon is elliptical', P), false);
});

test('per-dock aliases extend the accepted names', () => {
  assert.equal(matchesWake('hey orbita do this', P), true); // orbita is built-in
  assert.equal(matchesWake('hey zorb do this', P), false);  // not built-in
  assert.equal(matchesWake('hey zorb do this', P, ['zorb']), true); // added via config
  assert.equal(stripWake('hey zorb do this', P, ['zorb']), 'do this');
});

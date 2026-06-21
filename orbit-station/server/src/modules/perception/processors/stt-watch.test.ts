import { test } from 'node:test';
import assert from 'node:assert/strict';
import { UtteranceDetector, isHallucination, isLowConfBackchannel, hasNoWords } from './stt-watch.js';

// Mirrors the detector's own constants. FRAME_MS=30 @ 16 kHz → 480 samples/frame.
// ENDPOINT_MS=1300 → ~44 silent frames commit. MIN_UTTERANCE_MS=180 → ≥6 voiced
// frames to count. voiced = RMS >= SILENCE_RMS(0.02). loud() ≈ RMS 0.24 (clearly
// voiced); quiet() = silence. These run LOCALLY via feedPcm — no dock, no Opus.
const FRAME = 480;
const loud = (n: number) => { const f = new Int16Array(FRAME * n); for (let i = 0; i < f.length; i++) f[i] = i % 2 ? 8000 : -8000; return f; };
const quiet = (n: number) => new Int16Array(FRAME * n);
const frames = (ms: number) => Math.round(ms / 30); // ms → frame count

function detector() {
  const ends: number[] = []; // voiced-ms of each committed utterance
  const d = new UtteranceDetector((pcm) => { ends.push(pcm.length / 16); }); // 16 samples/ms @16k
  return { d, ends };
}

// THE BUG UNDER TEST: continuous loud speech must NOT endpoint mid-utterance,
// no matter how long you keep talking (up to the MAX_UTTERANCE safety cap).
test('continuous voiced audio does NOT endpoint (no mid-speech cut-off)', () => {
  const { d, ends } = detector();
  d.feedPcm(loud(frames(30_000))); // 30s of unbroken speech
  assert.equal(ends.length, 0, 'no endpoint while continuously voiced for 30s');
});

// Endpoint SHOULD fire after ~1.3s of real silence following speech.
test('endpoint fires after ~1.3s of silence', () => {
  const { d, ends } = detector();
  d.feedPcm(loud(frames(600)));    // 600ms speech
  d.feedPcm(quiet(frames(1500)));  // 1.5s silence ≥ 1.3s → endpoint
  assert.equal(ends.length, 1, 'one utterance committed after the silence');
});

// A brief mid-sentence gap (< endpoint) must NOT split a continuous utterance —
// this is "a breath between words", not the end of the sentence.
test('a short gap (<1.3s) does not split a continuous utterance', () => {
  const { d, ends } = detector();
  d.feedPcm(loud(frames(600)));
  d.feedPcm(quiet(frames(900)));   // 0.9s gap (< 1.3s) — a breath
  d.feedPcm(loud(frames(600)));
  d.feedPcm(quiet(frames(1500)));  // real end
  assert.equal(ends.length, 1, 'the short gap did not cause an early endpoint');
});

// THE REAL-WORLD SCENARIO. Counting "one… two… three…" with SHORT gaps stays one
// utterance; with LONG gaps (>1.3s, e.g. separate `say` processes) it splits —
// which is the test-method artifact, NOT a dock bug.
test('counting with short gaps = one utterance; long gaps = split per number', () => {
  // short gaps (0.5s between numbers) → one continuous utterance
  const a = detector();
  for (let i = 0; i < 10; i++) { a.d.feedPcm(loud(frames(400))); a.d.feedPcm(quiet(frames(500))); }
  a.d.feedPcm(quiet(frames(1500)));
  assert.equal(a.ends.length, 1, 'short gaps: stays one utterance');

  // long gaps (1.6s between numbers, like per-number `say` startup) → splits
  const b = detector();
  for (let i = 0; i < 10; i++) { b.d.feedPcm(loud(frames(400))); b.d.feedPcm(quiet(frames(1600))); }
  assert.equal(b.ends.length, 10, 'long gaps: splits into one utterance per number');
});

// TURN-GATING: a Whisper silence-hallucination must NOT become an agent turn (the
// "Thank you" → "You're very welcome!" phantom reply). Stock sign-offs are dropped
// unconditionally; the snapshot still lands for the record.
test('stock silence-hallucinations are blocked from becoming a turn', () => {
  for (const p of ['Thank you', 'thank you for watching', 'Okay', 'Bye.', 'you', 'The end']) {
    assert.equal(isHallucination(p), true, `"${p}" should be a hallucination`);
  }
  // real content is NOT a hallucination
  for (const p of ['tell me a story', 'what is two plus two', 'set a timer for five minutes']) {
    assert.equal(isHallucination(p), false, `"${p}" must pass through`);
  }
});

// SHORT BACKCHANNELS are ambiguous: drop as a turn ONLY when Whisper is also unsure.
test('short backchannels are gated on confidence, not dropped outright', () => {
  // low-confidence "yeah" from near-silence → blocked
  assert.equal(isLowConfBackchannel('yeah', true), true);
  assert.equal(isLowConfBackchannel('Mm hmm.', true), true);
  assert.equal(isLowConfBackchannel('one sec', true), true);
  // a CONFIDENT "yeah" (a real answer to the dock's question) → still a turn
  assert.equal(isLowConfBackchannel('yeah', false), false);
  assert.equal(isLowConfBackchannel('yes', false), false);
  // real content is never a backchannel, regardless of confidence
  assert.equal(isLowConfBackchannel('yes please send it', true), false);
});

// CONTENT-FREE transcripts ("!", ".", "") must never become a turn (observed live:
// a lone "!" → the dock replied "Is there something you'd like to tell me?").
test('punctuation-only / empty transcripts have no words (blocked from a turn)', () => {
  for (const p of ['!', '.', '?!', '...', '  ', '', '-']) {
    assert.equal(hasNoWords(p), true, `"${p}" must be treated as wordless`);
  }
  // a real (even short) utterance is NOT wordless
  for (const p of ['hi', 'ok', 'yes', 'no', 'go', 'tell me a story']) {
    assert.equal(hasNoWords(p), false, `"${p}" must pass as real words`);
  }
});

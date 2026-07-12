import { test } from 'node:test';
import assert from 'node:assert/strict';
import { UtteranceDetector } from './vad-endpoint.js';
import { isHallucination, isLowConfBackchannel, hasNoWords } from './speech-watch.js';

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

// --------------------------------------------------------------------------- //
// LIVE INTERIMS (streaming partial transcripts). Mirrors detector constants:
// INTERIM_INTERVAL_MS=800, INTERIM_MIN_AUDIO_MS=300. The detector calls onInterim
// at the cadence WHILE in-speech, gated by shouldInterim(). onInterim is async; we
// resolve it synchronously in tests so #interimInFlight clears before the next frame.
// --------------------------------------------------------------------------- //

/** A detector wired with interim hooks. `gate` toggles shouldInterim; each onInterim
 *  call records the voiced-ms of the partial buffer and (optionally) blocks until
 *  released, to exercise the in-flight guard.
 *
 *  IMPORTANT: onInterim is ASYNC and the detector guards with #interimInFlight until
 *  the promise SETTLES (a microtask). In production, RTP frames arrive over time so
 *  the promise settles between feeds; in tests we must feed incrementally and await a
 *  microtask between chunks (feedMs) — feeding 5s in one synchronous feedPcm would
 *  keep the guard latched and emit only ONE interim (which is itself correct behavior,
 *  just not what we're measuring). */
function interimDetector(opts?: { gate?: () => boolean }) {
  const ends: number[] = [];
  const interims: number[] = []; // voiced-ms of each interim's buffer
  let gateOpen = true;
  let release: (() => void) | null = null;
  let block = false;
  const d = new UtteranceDetector((pcm) => { ends.push(pcm.length / 16); });
  d.shouldInterim = opts?.gate ?? (() => gateOpen);
  d.onInterim = (pcm) => {
    interims.push(pcm.length / 16);
    if (!block) return Promise.resolve();
    return new Promise<void>((res) => { release = res; });
  };
  // feed `ms` of audio as ~150ms chunks, draining microtasks between each so an async
  // onInterim settles and the in-flight guard clears — mirrors incremental RTP.
  const feedMs = async (ms: number, kind: (n: number) => Int16Array) => {
    const chunk = 150;
    for (let done = 0; done < ms; done += chunk) {
      d.feedPcm(kind(frames(Math.min(chunk, ms - done))));
      await Promise.resolve(); // let onInterim's promise settle (clears #interimInFlight)
    }
  };
  return {
    d, ends, interims, feedMs,
    feed: (ms: number) => feedMs(ms, loud),
    silence: (ms: number) => feedMs(ms, quiet),
    setGate: (v: boolean) => { gateOpen = v; },
    setBlocking: (v: boolean) => { block = v; },
    releaseInFlight: () => { release?.(); release = null; },
  };
}

// CADENCE: ~5s of continuous speech at an 800ms cadence → ~6 interims (5000/800),
// and crucially NO endpoint (still talking). The exact count can vary ±1 with framing.
test('interims fire at ~800ms cadence during continuous speech (no endpoint yet)', async () => {
  const h = interimDetector();
  await h.feed(5000); // 5s continuous speech, fed incrementally
  assert.equal(h.ends.length, 0, 'no endpoint while still speaking');
  assert.ok(h.interims.length >= 4 && h.interims.length <= 7,
    `~6 interims over 5s @800ms, got ${h.interims.length}`);
  // each interim sees MORE audio than the previous (growing buffer → self-correcting).
  for (let i = 1; i < h.interims.length; i++) {
    assert.ok(h.interims[i]! > h.interims[i - 1]!, 'interim buffer grows each tick');
  }
});

// LISTENING GATE: when shouldInterim() is false (dock not in a listening turn), NO
// interim fires — the whole point of bounding GPU cost to active turns.
test('no interims fire when the listening gate is closed', async () => {
  const h = interimDetector();
  h.setGate(false);
  await h.feed(5000);
  assert.equal(h.interims.length, 0, 'gate closed → zero interims');
  // …and the final path is untouched: a real endpoint still commits.
  await h.silence(1500);
  assert.equal(h.ends.length, 1, 'final still commits with the gate closed');
});

// GATE FLIP MID-UTTERANCE: opening the gate partway begins interims; closing stops them.
test('the listening gate is honored dynamically mid-utterance', async () => {
  const h = interimDetector();
  h.setGate(false);
  await h.feed(2000); // 2s with gate closed → none
  assert.equal(h.interims.length, 0);
  h.setGate(true);
  await h.feed(2000); // 2s with gate open → some
  assert.ok(h.interims.length >= 1, 'interims resume once the gate opens');
});

// MIN-AUDIO FLOOR: no interim until the utterance has ≥ INTERIM_MIN_AUDIO_MS(300) of
// audio (a 100ms onset transcribes to junk / caption flicker). Below the floor: none.
test('no interim before the min-audio floor (300ms)', async () => {
  const h = interimDetector();
  await h.feed(200);  // 200ms < 300ms floor (also < first 800ms tick)
  assert.equal(h.interims.length, 0, 'too little audio → no interim');
});

// IN-FLIGHT GUARD: while one interim transcription is outstanding (slow under GPU
// contention), no second one is queued — we never pile up re-transcriptions.
test('in-flight guard: a slow interim is not double-fired', async () => {
  const h = interimDetector();
  h.setBlocking(true);
  await h.feed(3000); // 3s would normally be ~3-4 interims, but the first blocks…
  assert.equal(h.interims.length, 1, 'only ONE interim in flight at a time');
  h.releaseInFlight();             // settle the outstanding one
  h.setBlocking(false);
  await h.feed(1500); // …now subsequent ticks may fire
  assert.ok(h.interims.length >= 2, 'next interim fires after the prior settles');
});

// NEW UTTERANCE RESETS CADENCE: after an endpoint, the next utterance starts its
// interim cadence fresh (doesn't inherit the prior utterance's timer).
test('interim cadence resets per utterance', async () => {
  const h = interimDetector();
  await h.feed(1200);    // utterance 1 (≥1 interim past the 800ms tick)
  await h.silence(1500); // endpoint
  const after1 = h.interims.length;
  assert.equal(h.ends.length, 1);
  assert.ok(after1 >= 1, 'utterance 1 produced an interim');
  await h.feed(1200);    // utterance 2
  // utterance 2 crosses the floor + 800ms tick and fires its OWN interim, proving the
  // cadence counter reset (it didn't carry the prior utterance's lastMs).
  assert.ok(h.interims.length > after1, 'new utterance emits its own interim');
});

// SAFETY: with NO interim hook wired (default), the detector behaves exactly as
// before — no interims, finals unaffected. (Opt-in feature.)
test('detector with no interim hook is unchanged (interims are opt-in)', () => {
  const ends: number[] = [];
  const d = new UtteranceDetector((pcm) => { ends.push(pcm.length / 16); });
  // no d.onInterim / d.shouldInterim set
  d.feedPcm(loud(frames(5000)));
  d.feedPcm(quiet(frames(1500)));
  assert.equal(ends.length, 1, 'final path identical when interims are not wired');
});

// ─────────────────────── AUDIO ENRICHER batch trigger ───────────────────────
// The merged path's debounced batch window: BATCH_MIN_MS=10s floor, fires when armed
// (a speech endpoint) AND quiet (BATCH_SILENCE_MS=1.5s) — cutting ONLY at an endpoint
// boundary, retaining the remainder (cursor). Opt-in via detector.onEnrich; enrichDone()
// clears the in-flight guard. These drive feedPcm locally (no dock/Opus/LLM).
function enrichHarness() {
  const fires: Array<{ ms: number; startedAtMs: number; armedBy: 'speech' | 'acoustic' }> = [];
  const d = new UtteranceDetector(() => { /* utterance sink */ });
  d.onEnrich = (windowPcm, startedAtMs, armedBy) => {
    fires.push({ ms: windowPcm.length / 16, startedAtMs, armedBy });
    d.enrichDone(); // synchronous "pass complete" so the guard clears immediately
  };
  return { d, fires };
}

test('enricher does NOT fire before the 10s floor even when armed+quiet', () => {
  const { d, fires } = enrichHarness();
  d.feedPcm(loud(frames(600)));    // a short utterance (arms on endpoint)
  d.feedPcm(quiet(frames(2000)));  // endpoint + quiet — but total audio < 10s
  assert.equal(fires.length, 0, 'floor not reached → no fire');
});

test('enricher fires once armed + past the 10s floor + quiet, at an endpoint boundary', () => {
  const { d, fires } = enrichHarness();
  d.feedPcm(loud(frames(9000)));   // 9s speech
  d.feedPcm(quiet(frames(2000)));  // endpoint at ~9s, then quiet; total 11s ≥ 10s floor → FIRE
  assert.equal(fires.length, 1, 'one batch fired');
  assert.equal(fires[0]!.armedBy, 'speech', 'armed by the speech endpoint');
  // the window is cut at the endpoint BOUNDARY = 9s speech + the ~1.3s ENDPOINT_MS silence the
  // detector waited before declaring the endpoint (~10.3s), NOT the full 11s batch — the ~0.7s
  // of extra trailing silence stays in the remainder for the next window.
  assert.ok(fires[0]!.ms >= 9800 && fires[0]!.ms <= 10800, `cut at the endpoint (~10.3s), got ${fires[0]!.ms}ms`);
  assert.ok(fires[0]!.ms < 11000, 'not the whole 11s batch — the trailing silence is retained');
});

test('enricher does not fire while still mid-speech past the floor (waits for quiet)', () => {
  const { d, fires } = enrichHarness();
  d.feedPcm(loud(frames(15_000))); // 15s of UNBROKEN speech — armed never (no endpoint), never quiet
  assert.equal(fires.length, 0, 'no endpoint boundary + not quiet → no fire mid-monologue');
});

test('enricher cursor: the remainder after a cut carries into the next batch (no miss/overlap)', () => {
  const { d, fires } = enrichHarness();
  // first window: 9s speech → endpoint → quiet → fire (~9s)
  d.feedPcm(loud(frames(9000)));
  d.feedPcm(quiet(frames(2000)));
  assert.equal(fires.length, 1, 'first fire');
  const firstEnd = fires[0]!.startedAtMs + fires[0]!.ms;
  // second batch accumulates from the cursor; another 10s+endpoint+quiet fires again.
  d.feedPcm(loud(frames(10_000)));
  d.feedPcm(quiet(frames(2000)));
  assert.equal(fires.length, 2, 'second fire');
  // the second window starts at/after the first window's end (no overlap, contiguous).
  assert.ok(fires[1]!.startedAtMs >= firstEnd - 60, 'second window continues from the cursor');
});

test('detector with no onEnrich is unchanged (enricher is opt-in)', () => {
  const ends: number[] = [];
  const d = new UtteranceDetector((pcm) => { ends.push(pcm.length / 16); });
  d.feedPcm(loud(frames(9000)));
  d.feedPcm(quiet(frames(2000)));
  assert.equal(ends.length, 1, 'utterance path identical when the enricher is not wired');
});

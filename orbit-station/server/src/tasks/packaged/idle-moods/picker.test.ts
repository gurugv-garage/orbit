/**
 * idle-moods picker — the mood policy proven as truth tables (pure fn, seeded rand):
 * quiet hours (incl. the midnight wrap + boundaries), the attention presence rule +
 * once-per-presence, needsFace/needsNoFace, the anti-repeat, the three-condition speak
 * gate, per-mood weight disables, and the thought-only-bit exclusion while the gate is
 * closed.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inQuietHours, pickBit, type MoodCfg, type PickInput } from './picker.js';
import { BITS, type Bit } from './bits.js';

const CFG: MoodCfg = {
  freshEventMaxMs: 180_000,
  quietStartHour: 22, quietEndHour: 7,
  attentionAfterMs: 180_000,
  speakMinGapMs: 1_200_000, speakIdleMinMs: 600_000,
  weights: {},
};

/** a deterministic rand sequence */
const seq = (...vals: number[]) => { let i = 0; return () => vals[Math.min(i++, vals.length - 1)]!; };

const INP: PickInput = {
  hourLocal: 14, facesPresent: false, msPresentContinuous: 0,
  msSinceConversation: 3_600_000, msSinceLastSpoke: 3_600_000,
  msSinceSalient: 0, rand: seq(0),  // fresh happening by default; reactive-gate tests vary it
};

// ── quiet hours ────────────────────────────────────────────────────────────────
test('inQuietHours wraps midnight (22→7)', () => {
  assert.equal(inQuietHours(23, 22, 7), true);
  assert.equal(inQuietHours(2, 22, 7), true);
  assert.equal(inQuietHours(7, 22, 7), false);   // end is exclusive
  assert.equal(inQuietHours(22, 22, 7), true);   // start is inclusive
  assert.equal(inQuietHours(12, 22, 7), false);
  assert.equal(inQuietHours(3, 1, 5), true);     // non-wrapping window
  assert.equal(inQuietHours(5, 1, 5), false);
  assert.equal(inQuietHours(3, 6, 6), false);    // start===end → disabled
});

test('quiet hours: only sleepy bits, and NEVER speak', () => {
  for (const r of [0, 0.3, 0.6, 0.99]) {
    const p = pickBit({ ...INP, hourLocal: 23, rand: seq(r) }, CFG, BITS);
    assert.ok(p, 'sleepy pool is non-empty');
    assert.equal(p.bit.mood, 'sleepy');
    assert.equal(p.speak, false);
  }
});

test('outside quiet hours sleepy bits are excluded', () => {
  for (const r of [0, 0.3, 0.6, 0.99]) {
    const p = pickBit({ ...INP, rand: seq(r) }, CFG, BITS);
    assert.ok(p && p.bit.mood !== 'sleepy', `picked ${p?.bit.id} — not sleepy`);
  }
});

// ── attention + needsFace ──────────────────────────────────────────────────────
test('attention bits need CONTINUOUS presence ≥ attentionAfterMs', () => {
  const eligibleMoods = (inp: PickInput) => {
    const seen = new Set<string>();
    for (let r = 0; r < 1; r += 0.02) {
      const p = pickBit({ ...inp, rand: seq(r) }, CFG, BITS);
      if (p) seen.add(p.bit.mood);
    }
    return seen;
  };
  // nobody visible → no attention (and no needsFace rows at all)
  assert.equal(eligibleMoods(INP).has('attention'), false, 'absent → no attention');
  // visible but only just arrived → still no attention
  assert.equal(
    eligibleMoods({ ...INP, facesPresent: true, msPresentContinuous: 30_000 }).has('attention'),
    false, 'short presence → no attention');
  // present long enough → attention bits are in the pool
  assert.equal(
    eligibleMoods({ ...INP, facesPresent: true, msPresentContinuous: 300_000 }).has('attention'),
    true, 'long presence → attention eligible');
  // …but only ONCE per presence stretch: attentionSpent shuts the mood off again.
  assert.equal(
    eligibleMoods({ ...INP, facesPresent: true, msPresentContinuous: 300_000, attentionSpent: true }).has('attention'),
    false, 'attention already offered this presence → out of the pool');
});

test('needsNoFace: lonely-style bits never play to a full room', () => {
  const lonely: Bit = { id: 'f.lonely', mood: 'flavor', weight: 1, needsNoFace: true, gesture: 'sad' };
  assert.ok(pickBit({ ...INP, facesPresent: false }, { ...CFG, weights: { flavor: 1 } }, [lonely]),
    'eligible when nobody is visible');
  assert.equal(pickBit({ ...INP, facesPresent: true }, { ...CFG, weights: { flavor: 1 } }, [lonely]), null,
    'excluded the moment someone IS visible');
});

test('anti-repeat: the last-performed bit leaves the pool unless it is all that is left', () => {
  const a: Bit = { id: 'b.a', mood: 'bored', weight: 1, gesture: 'curious' };
  const b: Bit = { id: 'b.b', mood: 'bored', weight: 1, gesture: 'sad' };
  for (let r = 0; r < 1; r += 0.1) {
    const p = pickBit({ ...INP, lastBitId: 'b.a', rand: seq(r) }, CFG, [a, b]);
    assert.equal(p!.bit.id, 'b.b', 'the repeat candidate is excluded');
  }
  const solo = pickBit({ ...INP, lastBitId: 'b.a', rand: seq(0) }, CFG, [a]);
  assert.equal(solo!.bit.id, 'b.a', 'a one-bit pool still plays (repeat beats silence forever)');
});

// ── the speak gate ─────────────────────────────────────────────────────────────
const thoughtBit: Bit = { id: 't.only', mood: 'bored', weight: 1, thought: 'x' };
const motionThoughtBit: Bit = { id: 't.motion', mood: 'bored', weight: 1, thought: 'x', gesture: 'curious' };

test('speak gate: all three conditions must hold', () => {
  const pick1 = (over: Partial<PickInput>) => pickBit({ ...INP, ...over, rand: seq(0) }, CFG, [motionThoughtBit]);
  assert.equal(pick1({})!.speak, true, 'gate open → speaks');
  assert.equal(pick1({ msSinceLastSpoke: 60_000 })!.speak, false, 'spoke recently → silent');
  assert.equal(pick1({ msSinceConversation: 60_000 })!.speak, false, 'conversation too recent → silent');
  const sleepyThought: Bit = { ...motionThoughtBit, mood: 'sleepy' };
  const quietPick = pickBit({ ...INP, hourLocal: 23, rand: seq(0) }, CFG, [sleepyThought]);
  assert.equal(quietPick!.speak, false, 'quiet hours → silent even with the gaps elapsed');
});

test('a thought-ONLY bit leaves the pool while the gate is closed; motion+thought stays silent', () => {
  const closed = { ...INP, msSinceLastSpoke: 0 };
  assert.equal(pickBit(closed, CFG, [thoughtBit]), null, 'thought-only bit has nothing to perform');
  const p = pickBit(closed, CFG, [thoughtBit, motionThoughtBit]);
  assert.equal(p!.bit.id, 't.motion', 'the motion-carrying row is picked instead');
  assert.equal(p!.speak, false);
});

// ── weights ────────────────────────────────────────────────────────────────────
test('a mood weight of 0 disables the mood; all-zero → null', () => {
  const cfg: MoodCfg = { ...CFG, weights: { bored: 0, curious: 0, flavor: 0 } };
  for (let r = 0; r < 1; r += 0.05) {
    const p = pickBit({ ...INP, rand: seq(r) }, cfg, BITS);
    assert.equal(p, null, 'nothing eligible when every reachable mood is zeroed');
  }
});

test('weighted pick is deterministic under a seeded rand and spans the pool', () => {
  const first = pickBit({ ...INP, rand: seq(0) }, CFG, BITS)!;
  const last = pickBit({ ...INP, rand: seq(0.999999) }, CFG, BITS)!;
  assert.ok(first.bit.id !== last.bit.id, 'different rolls reach different bits');
  assert.deepEqual(pickBit({ ...INP, rand: seq(0.5) }, CFG, BITS),
    pickBit({ ...INP, rand: seq(0.5) }, CFG, BITS), 'same roll → same pick');
});

// ── boredom-on-coherence: the reactive event gate (coherence-layer.md step 5) ────
test('reactive bits need a recent salient happening; social bids do not', () => {
  const bits: Bit[] = [
    { id: 'r.wonder', mood: 'curious', weight: 1, reactive: true, thought: 'react to it' },
    { id: 's.lonely', mood: 'flavor', weight: 1, needsNoFace: true, thought: 'wistful' },
  ];
  // stale world (no event for 10 min) → reactive ineligible, social bid still eligible
  const stale = pickBit({ ...INP, msSinceSalient: 600_000, rand: seq(0) }, CFG, bits);
  assert.equal(stale!.bit.id, 's.lonely');
  // fresh happening → reactive back in the pool
  const fresh = pickBit({ ...INP, msSinceSalient: 30_000, rand: seq(0) }, CFG, bits);
  assert.equal(fresh!.bit.id, 'r.wonder');
  // perception cold (null) → treat as stale
  const cold = pickBit({ ...INP, msSinceSalient: null, rand: seq(0) }, CFG, bits);
  assert.equal(cold!.bit.id, 's.lonely');
});

// ── the `why` decision trace (instrumentation: attribute a spoken bit) ────────────
test('why surfaces the fresh-event verdict + gate reasoning for the PICKED bit', () => {
  const reactive: Bit = { id: 'r.wonder', mood: 'curious', weight: 1, reactive: true, thought: 'react' };
  const social: Bit = { id: 's.lonely', mood: 'flavor', weight: 1, needsNoFace: true, thought: 'wistful' };

  // a reactive pick on a fresh world → why.reactive true, salientMs carried through.
  const fresh = pickBit({ ...INP, msSinceSalient: 30_000, rand: seq(0) }, CFG, [reactive, social])!;
  assert.equal(fresh.bit.id, 'r.wonder');
  assert.equal(fresh.why.reactive, true, 'the picked bit was reactive');
  assert.equal(fresh.why.salientMs, 30_000, 'ms-since-salient is surfaced for attribution');
  assert.equal(fresh.why.freshEventMaxMs, CFG.freshEventMaxMs);

  // a NON-reactive pick → why.reactive false (the gate did not apply to it).
  const stale = pickBit({ ...INP, msSinceSalient: 600_000, rand: seq(0) }, CFG, [reactive, social])!;
  assert.equal(stale.bit.id, 's.lonely');
  assert.equal(stale.why.reactive, false, 'the social bid is not reactive');
  assert.equal(stale.why.salientMs, 600_000, 'the stale age is still recorded');

  // the speak-gate breakdown mirrors `speak`, condition by condition. Use a motion+thought
  // bit so the closed gate leaves it IN the pool (thought-only bits leave — see the gate
  // test above); we want to observe the gate verdict on a bit that still gets picked.
  const motionThought: Bit = { id: 'm.t', mood: 'curious', weight: 1, thought: 'x', gesture: 'curious' };
  const gated = pickBit({ ...INP, msSinceLastSpoke: 0, rand: seq(0) }, CFG, [motionThought])!;
  assert.equal(gated.speak, false);
  assert.equal(gated.why.canSpeak, false);
  assert.equal(gated.why.gate.spokeGapOk, false, 'the spoke-gap is the closed condition');
  assert.equal(gated.why.gate.convGapOk, true);
  assert.equal(gated.why.gate.notQuiet, true);
});

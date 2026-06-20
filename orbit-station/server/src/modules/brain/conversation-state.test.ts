import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ConversationState, ConvCfg, type ConvTransition } from './conversation-state.js';

const L = ConvCfg.LISTEN_MS;
const F = ConvCfg.FOLLOWUP_MS;
const V = ConvCfg.VAD_EXTEND_MS;
const G = ConvCfg.GRACE_MS;

/** A state + a transition log, for asserting exact sequences. */
function make() {
  const log: ConvTransition[] = [];
  const cs = new ConversationState((t) => log.push(t));
  return { cs, log, seq: () => log.map((t) => `${t.from}->${t.to}`) };
}

describe('ConversationState — A: basic addressed turn', () => {
  // A1 — tap → listening; lifetime; VAD extends; utterance → thinking→speaking→followup.
  it('A1: tap→listening with LISTEN_MS lifetime; utterance drives the turn', () => {
    const { cs, seq } = make();
    cs.tap(0);
    assert.equal(cs.mode(0), 'listening');
    assert.equal(cs.msToExpiry(0), L, 'listening lives for LISTEN_MS');
    // utterance within the window → addressed → run the turn lifecycle.
    assert.equal(cs.utteranceEnded(500, 600), true);
    cs.turnStart(600); cs.speakStart(700); cs.speakEnd(1200);
    assert.equal(cs.mode(1200), 'followup');
    assert.deepEqual(seq(), ['idle->listening', 'listening->thinking', 'thinking->speaking', 'speaking->followup']);
  });

  it('A1b: VAD activity extends the listening window past the original LISTEN_MS', () => {
    const { cs } = make();
    cs.tap(0);
    // VAD late in the window (when VAD_EXTEND pushes BEYOND what's left) extends it.
    cs.vadActivity(L - 100);
    assert.equal(cs.msToExpiry(L - 100), V, 'window now lives VAD_EXTEND_MS from the VAD tick');
    // so it survives past the original LISTEN_MS.
    assert.equal(cs.mode(L + 100), 'listening', 'kept alive by VAD past LISTEN_MS');
    // ...and still expires VAD_EXTEND_MS after the last VAD.
    assert.equal(cs.mode(L - 100 + V), 'idle');
  });

  // A2 — tap, no speech → idle after LISTEN_MS.
  it('A2: tap then silence → idle exactly at LISTEN_MS', () => {
    const { cs, seq } = make();
    cs.tap(0);
    assert.equal(cs.mode(L - 1), 'listening');
    assert.equal(cs.mode(L), 'idle', 'expires at LISTEN_MS');
    assert.deepEqual(seq(), ['idle->listening', 'listening->idle']);
  });

  // A3 — overheard: no tap → not addressed; stays idle.
  it('A3: utterance with no tap is NOT addressed; stays idle', () => {
    const { cs } = make();
    assert.equal(cs.utteranceEnded(100, 200), false);
    assert.equal(cs.mode(200), 'idle');
  });

  // CONSUME: an addressed utterance closes the window atomically → thinking, so a
  // SECOND rapid utterance in the async gap can't double-fire a turn.
  it('addressed utterance consumes the window (no double-fire)', () => {
    const { cs } = make();
    cs.tap(0);
    assert.equal(cs.utteranceEnded(100, 200), true, 'first is addressed');
    assert.equal(cs.mode(200), 'thinking', 'window consumed → thinking');
    assert.equal(cs.utteranceEnded(250, 300), false, 'second in the gap is NOT addressed again');
  });

  // A4 — tap before the sentence ends (started before tap, ends after) → addressed.
  it('A4: tap before the sentence ends → addressed', () => {
    const { cs } = make();
    // sentence started at 0, user taps at 500, sentence ends at 1500.
    cs.tap(500);
    assert.equal(cs.utteranceEnded(1500, 1500), true);
  });

  it('A4b: ordering race — utterance ended just BEFORE the tap (within GRACE)', () => {
    const { cs } = make();
    cs.tap(1000);                                   // tapped a beat after finishing
    assert.equal(cs.utteranceEnded(1000 - (G - 100), 1000), true, 'within grace');
    cs.tap(5000);
    assert.equal(cs.utteranceEnded(5000 - (G + 100), 5000), false, 'beyond grace → not addressed');
  });
});

describe('ConversationState — C: auto re-listen (follow-up)', () => {
  // C1 — reply → followup → follow-up utterance → turn, several loops.
  it('C1: multi-loop follow-up without tapping (4 loops)', () => {
    const { cs } = make();
    let t = 0;
    cs.tap(t); assert.equal(cs.utteranceEnded(t + 100, t + 200), true);
    for (let i = 0; i < 4; i++) {
      cs.turnStart(t); cs.speakStart(t + 10); cs.speakEnd(t + 100);
      assert.equal(cs.mode(t + 100), 'followup', `loop ${i}: followup after reply`);
      assert.equal(cs.msToExpiry(t + 100), F, 'followup lives FOLLOWUP_MS');
      // a follow-up utterance inside the window is addressed (no tap).
      assert.equal(cs.utteranceEnded(t + 200, t + 300), true, `loop ${i}: follow-up addressed`);
      t += 400;
    }
  });

  // C2 — reply → silence → idle after FOLLOWUP_MS.
  it('C2: followup expires to idle at FOLLOWUP_MS', () => {
    const { cs } = make();
    cs.speakStart(0); cs.speakEnd(100);
    assert.equal(cs.mode(100 + F - 1), 'followup');
    assert.equal(cs.mode(100 + F), 'idle');
  });

  // C3 — slow follow-up: VAD extends the followup window.
  it('C3: VAD during followup extends past FOLLOWUP_MS', () => {
    const { cs } = make();
    cs.speakStart(0); cs.speakEnd(0); // followup window [0, F]
    cs.vadActivity(F - 500);          // user starts talking late
    assert.equal(cs.mode(F + 100), 'followup', 'extended, not expired');
    assert.equal(cs.utteranceEnded(F + 1000, F + 1100), true, 'late follow-up still addressed');
  });
});

describe('ConversationState — follow-up opens after EVERY reply (decided)', () => {
  // Decided: follow-up (auto re-listen) opens whenever the dock finishes speaking,
  // regardless of what triggered the turn. ConversationState is trigger-agnostic —
  // it only sees speakStart/speakEnd — so BOTH cases below are the same transition;
  // these tests pin that contract explicitly (user-initiated AND not).
  it('user-initiated reply → follow-up', () => {
    const { cs } = make();
    cs.tap(0); cs.turnStart(0); cs.speakStart(10); cs.speakEnd(100);
    assert.equal(cs.mode(100), 'followup', 'user turn → follow-up after reply');
  });

  it('NOT user-initiated (self-thought / task) reply → ALSO follow-up', () => {
    const { cs } = make();
    // no tap — a proactive turn the dock started itself.
    cs.turnStart(0); cs.speakStart(10); cs.speakEnd(100);
    assert.equal(cs.mode(100), 'followup', 'proactive turn ALSO opens follow-up');
    // and the follow-up is a real addressed window: a follow-up utterance runs.
    assert.equal(cs.utteranceEnded(200, 300), true);
  });
});

describe('ConversationState — D: priority / toggle', () => {
  // D1 — tap is a toggle.
  it('D1: tap toggles listening on then off', () => {
    const { cs, seq } = make();
    cs.tap(0); assert.equal(cs.mode(0), 'listening');
    cs.tap(100); assert.equal(cs.mode(100), 'idle', 'second tap turns it off');
    assert.deepEqual(seq(), ['idle->listening', 'listening->idle']);
  });

  it('D1b: tap during followup toggles it off', () => {
    const { cs } = make();
    cs.speakStart(0); cs.speakEnd(0); assert.equal(cs.mode(0), 'followup');
    cs.tap(100); assert.equal(cs.mode(100), 'idle');
  });

  it('D1c: tap during thinking/speaking is ignored (turn owns the lane)', () => {
    const { cs } = make();
    cs.turnStart(0); cs.tap(50); assert.equal(cs.mode(50), 'thinking');
    cs.speakStart(60); cs.tap(70); assert.equal(cs.mode(70), 'speaking');
  });
});

describe('ConversationState — robustness (unit; full reconnection sim separate)', () => {
  // R1 (unit) — lost tts-end: speaking can't wedge past SPEAK_MAX_MS.
  it('R1: a lost tts-end → leaves speaking by SPEAK_MAX_MS', () => {
    const { cs } = make();
    cs.speakStart(0);
    assert.equal(cs.mode(ConvCfg.SPEAK_MAX_MS - 1), 'speaking');
    assert.notEqual(cs.mode(ConvCfg.SPEAK_MAX_MS), 'speaking', 'recovered (→ followup)');
  });

  // R2 (unit) — reconcile on connect → idle from any mode.
  it('R2: reconcileConnected → idle from speaking', () => {
    const { cs } = make();
    cs.speakStart(0);
    cs.reconcileConnected(100);
    assert.equal(cs.mode(100), 'idle');
  });
});

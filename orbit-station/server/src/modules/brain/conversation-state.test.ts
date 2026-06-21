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

  // LONG-UTTERANCE: a sentence that STARTED while listening but runs past the window
  // expiry is still addressed (you were talking the whole time — don't drop it).
  it('A1c: a long utterance that ends after the window expired is still addressed', () => {
    const { cs } = make();
    cs.tap(0);                                    // window open [0, LISTEN_MS]
    assert.equal(cs.mode(L + 100), 'idle', 'window expired to idle');
    // you started speaking at L-500 (while open) and finished at L+1500 (after expiry).
    assert.equal(cs.utteranceEnded(L + 1500, L + 1500, L - 500), true,
      'started-while-open utterance is addressed despite ending late');
    assert.equal(cs.mode(L + 1500), 'thinking', '→ runs the turn');
  });

  // ...but an utterance that STARTS after the window is long gone is NOT addressed.
  it('A1d: an utterance that starts well after the window closed is NOT addressed', () => {
    const { cs } = make();
    cs.tap(0);
    cs.mode(L + 100); // expire
    assert.equal(cs.utteranceEnded(L + 10_000, L + 10_000, L + 9_000), false,
      'started long after the window → overheard, not addressed');
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

  // D1c — tap-to-interrupt: a tap while thinking/speaking INTERRUPTS the in-flight
  // reply → a fresh tap LISTENING window (the session aborts the turn on this edge).
  it('D1c: tap during speaking → interrupt → listening (tap window)', () => {
    const { cs, seq } = make();
    cs.turnStart(0); cs.speakStart(10);
    assert.equal(cs.mode(20), 'speaking');
    assert.equal(cs.tapWouldInterrupt(30), true, 'tap here would interrupt');
    cs.tap(30);
    assert.equal(cs.mode(30), 'listening', 'interrupt opens a listening window');
    assert.equal(cs.msToExpiry(30), L, 'a full LISTEN_MS tap window');
    assert.deepEqual(seq().at(-1), 'speaking->listening');
  });

  it('D1d: tap during thinking → interrupt → listening', () => {
    const { cs } = make();
    cs.turnStart(0);
    assert.equal(cs.tapWouldInterrupt(50), true);
    cs.tap(50);
    assert.equal(cs.mode(50), 'listening', 'interrupt before any speech also listens');
  });

  // A late tts-end (the aborted turn's TTS stopping) must NOT clobber the tap window
  // the interrupt opened with a lower-priority followup.
  it('D1e: a tts-end after a tap-interrupt does not overwrite the tap window', () => {
    const { cs } = make();
    cs.turnStart(0); cs.speakStart(10);
    cs.tap(30);                       // interrupt → listening (tap)
    cs.speakEnd(40);                  // the aborted reply's TTS stops, arriving late
    assert.equal(cs.mode(40), 'listening', 'still the tap listening window');
    assert.equal(cs.msToExpiry(40), L - 10, 'tap window intact (not a followup window)');
  });
});

describe('ConversationState — D2/D3: camera presence priority', () => {
  // D3 — a face arriving opens a low-priority listen window when idle.
  it('D3a: face arrival opens a listen window when idle', () => {
    const { cs } = make();
    cs.faceArrival(0);
    assert.equal(cs.mode(0), 'listening');
    assert.equal(cs.msToExpiry(0), ConvCfg.FACE_ARRIVAL_MS);
  });

  // D3 — a face arriving does NOT override an active tap/followup window.
  it('D3b: face arrival during a tap window is ignored (no downgrade)', () => {
    const { cs } = make();
    cs.tap(0);                       // high-priority window, LISTEN_MS
    cs.faceArrival(100);             // a new face shows up
    assert.equal(cs.msToExpiry(100), L - 100, 'still the TAP window, not shortened to FACE');
  });

  // D2 — leaving the camera releases ONLY a face window...
  it('D2a: face-left clears a FACE listen window', () => {
    const { cs } = make();
    cs.faceArrival(0);
    cs.faceLeft(100);
    assert.equal(cs.mode(100), 'idle', 'face window released on leave');
  });

  // D2 — ...but face-left does NOT cancel a tap.
  it('D2b: face-left does NOT cancel a TAP window', () => {
    const { cs } = make();
    cs.tap(0);
    cs.faceLeft(100);
    assert.equal(cs.mode(100), 'listening', 'tap survives a glance away');
  });

  // D2 — ...nor a follow-up (the headline case: glance away mid-conversation).
  it('D2c: face-left does NOT cancel a FOLLOWUP window', () => {
    const { cs } = make();
    cs.speakStart(0); cs.speakEnd(10);   // → followup
    cs.faceLeft(100);
    assert.equal(cs.mode(100), 'followup', 'follow-up survives leaving the camera');
    assert.equal(cs.utteranceEnded(200, 300), true, 'and I can still follow up');
  });

  it('D2d: face-left when idle/thinking is a no-op', () => {
    const { cs } = make();
    cs.faceLeft(0); assert.equal(cs.mode(0), 'idle');
    cs.turnStart(0); cs.faceLeft(50); assert.equal(cs.mode(50), 'thinking');
  });
});

describe('ConversationState — face-presence anti-flap cooldown', () => {
  const CD = ConvCfg.FACE_COOLDOWN_MS;
  const FA = ConvCfg.FACE_ARRIVAL_MS;

  // After a face window is RELEASED (left), a new arrival is ignored until cooldown.
  it('a face-arrival right after a face-left is suppressed (no flap)', () => {
    const { cs } = make();
    cs.faceArrival(0);
    assert.equal(cs.mode(0), 'listening', 'first presence opens');
    cs.faceLeft(100);
    assert.equal(cs.mode(100), 'idle', 'left → idle (cooldown armed)');
    cs.faceArrival(200);                       // pacing back in immediately
    assert.equal(cs.mode(200), 'idle', 'suppressed during cooldown — no re-open');
  });

  // Once cooldown passes, a face-arrival opens normally again.
  it('a face-arrival AFTER the cooldown opens again', () => {
    const { cs } = make();
    cs.faceArrival(0);
    cs.faceLeft(100);                          // cooldown until 100 + CD
    cs.faceArrival(100 + CD + 1);
    assert.equal(cs.mode(100 + CD + 1), 'listening', 'past cooldown → opens');
  });

  // A face window that TIMES OUT (no leave event) also arms the cooldown.
  it('a timed-out face window also arms the cooldown', () => {
    const { cs } = make();
    cs.faceArrival(0);
    assert.equal(cs.mode(FA), 'idle', 'face window expired to idle');
    cs.faceArrival(FA + 50);                   // face still lingering in frame
    assert.equal(cs.mode(FA + 50), 'idle', 'lingering face does not re-open (cooldown)');
    cs.faceArrival(FA + CD + 1);
    assert.equal(cs.mode(FA + CD + 1), 'listening', 'opens once cooldown clears');
  });

  // A TAP is never subject to the face cooldown — deliberate intent always wins.
  it('a TAP ignores the face cooldown', () => {
    const { cs } = make();
    cs.faceArrival(0); cs.faceLeft(100);       // cooldown armed
    cs.tap(200);
    assert.equal(cs.mode(200), 'listening', 'a tap opens immediately despite cooldown');
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

  // ── clean reset: app-restart + server-restart (the user-requested cases) ──

  // APP RESTART: the phone reconnects → hello → notePhoneConnected →
  // reconcileConnected. From ANY mode the conversation comes back CLEAN idle (no
  // stale window/speak leaks across the reconnect).
  it('clean reset on app-restart (reconcile) from every mode → idle, no leaked window', () => {
    for (const setup of [
      (cs: ConversationState) => cs.tap(0),                         // listening
      (cs: ConversationState) => cs.turnStart(0),                   // thinking
      (cs: ConversationState) => cs.speakStart(0),                  // speaking
      (cs: ConversationState) => { cs.speakStart(0); cs.speakEnd(5); }, // followup
      (cs: ConversationState) => cs.faceArrival(0),                 // face listen
    ]) {
      const { cs } = make();
      setup(cs);
      cs.reconcileConnected(1000);
      const snap = cs.snapshot(1000);
      assert.equal(snap.mode, 'idle', 'reconnect → idle');
      assert.equal(snap.windowUntil, 0, 'no leaked listening window');
      assert.equal(snap.speakUntil, 0, 'no leaked speak window');
    }
  });

  // SERVER RESTART: a fresh process means a brand-new ConversationState — it starts
  // idle by construction. (The phone reconnects into it via hello → reconcile +
  // resync frame; modelled here as "a new instance is idle".)
  it('clean reset on server-restart (new instance) → idle by construction', () => {
    const { cs } = make();
    assert.equal(cs.mode(0), 'idle');
    assert.equal(cs.msToExpiry(0), 0);
  });

  // A reconcile when ALREADY idle is a clean no-op (no spurious transition churn).
  it('reconcile while idle stays idle', () => {
    const { cs, seq } = make();
    cs.reconcileConnected(0);
    assert.equal(cs.mode(0), 'idle');
    assert.deepEqual(seq(), [], 'no transition emitted (already idle)');
  });
});

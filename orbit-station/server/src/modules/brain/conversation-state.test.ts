import { describe, it, before, after } from 'node:test';
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

  // VAD now FOLLOWS speech (endpoint-based): active HOLDS the window open with no
  // ceiling; an explicit vad-END releases it to a short endpoint.
  it('A1b: VAD active holds the window open with no ceiling (talk as long as you like)', () => {
    const { cs } = make();
    const HOLD = ConvCfg.VAD_HOLD_MS;
    const EP = ConvCfg.VAD_ENDPOINT_MS;
    cs.tap(0);
    cs.vadActivity(L - 100, true);                    // still talking late in the window
    assert.equal(cs.msToExpiry(L - 100), HOLD, 'held open VAD_HOLD_MS from the VAD tick');
    assert.equal(cs.mode(L + 5_000), 'listening', 'still listening well past LISTEN_MS');
    // keep re-asserting active (the phone keepalive) → stays open far beyond any fixed timeout
    cs.vadActivity(L + 5_000, true);
    assert.equal(cs.mode(L + 9_000), 'listening', 'no ceiling while talking');
    // a vad-END → closes after the short endpoint, not the full hold.
    cs.vadActivity(L + 9_000, false);
    assert.equal(cs.mode(L + 9_000 + EP - 1), 'listening', 'endpoint tail');
    assert.equal(cs.mode(L + 9_000 + EP), 'idle', 'closes shortly after speech ends');
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

  // A1e — THE STALE-WINDOW LEAK (observed: "listening → watching, then it still
  // replied"). A VAD hold pushes the most-recent-window expiry up to VAD_HOLD_MS into
  // the future; when the window then TIMES OUT (UI flips to idle/"watching") without an
  // utterance being consumed, that future value must NOT keep later speech "addressed".
  it('A1e: speech after a VAD-held window times out is NOT addressed (stale-window leak)', () => {
    const { cs } = make();
    const HOLD = ConvCfg.VAD_HOLD_MS;
    cs.tap(0);                          // window open
    cs.vadActivity(100, true);          // VAD hold → lastWindowUntil ≈ 100 + HOLD (far future)
    cs.tap(200);                        // tap-off: deliberately close (UI shows not-listening)
    assert.equal(cs.mode(300), 'idle', 'window closed → idle');
    // you speak 5s later, entirely AFTER the close — overheard, must not run a turn.
    assert.equal(cs.utteranceEnded(5000, 5000, 4000), false,
      'speech well after the closed window is overheard, not addressed');
    // and even something inside the OLD stale hold horizon is not addressed.
    assert.equal(cs.utteranceEnded(HOLD - 1000, HOLD - 1000, HOLD - 2000), false,
      'inside the stale 30s hold horizon, but the window already closed → not addressed');
  });

  // A1f — same leak via a window TIMEOUT (not a tap-off): hold, let it expire, speak late.
  it('A1f: speech after a held window auto-expires is NOT addressed', () => {
    const { cs } = make();
    cs.tap(0);
    cs.vadActivity(100, true);          // hold far out
    cs.vadActivity(200, false);         // speech ended → releases to a short endpoint
    cs.mode(10_000);                    // long after → window-timeout prunes to idle
    assert.equal(cs.utteranceEnded(20_000, 20_000, 19_000), false,
      'speech 20s later, after the window expired → not addressed');
  });

  // A1g — THE EXACT LIVE TRACE: a followup window (after a reply) is VAD-held, then
  // NOTHING prunes until the next utterance arrives (#prune runs lazily). The window
  // really expired at #windowUntil, but prune doesn't run until the utterance's `now`,
  // many seconds later. Clamping the grace to `now` (the bug) left this addressed;
  // clamping to the real expiry (#windowUntil) correctly drops it. No mode() read
  // before the utterance — that's what makes prune lazy, mirroring production.
  it('A1g: lazy-prune — speech long after a held followup expired is NOT addressed', () => {
    const { cs } = make();
    const HOLD = ConvCfg.VAD_HOLD_MS;
    cs.tap(0);
    assert.equal(cs.utteranceEnded(100, 200), true);   // a turn → consume
    cs.speakStart(300);
    cs.speakEnd(400);                                   // reply done → followup window opens
    cs.vadActivity(500, true);                          // VAD hold → lastWindowUntil ≈ 500+HOLD
    cs.vadActivity(600, false);                         // speech ended → endpoint (short)
    // NO prune here. The endpoint window expires ~600+VAD_ENDPOINT_MS, but nothing reads
    // state until the utterance below at t≈HOLD (e.g. 30s later) — prune fires THEN.
    const t = HOLD; // ~30s later, well past the real expiry
    assert.equal(cs.utteranceEnded(t, t, t - 2000), false,
      'overheard speech 30s after the followup window expired → NOT addressed');
    assert.notEqual(cs.mode(t), 'thinking', 'sanity: the turn was not run');
  });

  // A1h — THE EXACT LIVE NUMBERS: window closed; the utterance STARTED ~0.6s AFTER the
  // close but within GRACE of it. The old `startedAt <= lastWindowUntil + GRACE` let it
  // through ("Now can you hear me?" while idle); it must not — an utterance that BEGAN
  // after the window closed is overheard, GRACE is only for the ENDING race.
  it('A1h: an utterance that STARTED just after the window closed is NOT addressed', () => {
    const { cs } = make();
    cs.tap(0);
    assert.equal(cs.utteranceEnded(100, 200), true); // consume the tap window
    cs.speakStart(300); cs.speakEnd(400);            // reply → followup window opens
    // followup closes at 400+FOLLOWUP_MS. Speak STARTING after that, ending a beat later.
    const close = 400 + ConvCfg.FOLLOWUP_MS;
    const start = close + 600;                        // started 0.6s AFTER close (within GRACE)
    assert.equal(cs.utteranceEnded(start + 1900, start + 1900, start), false,
      'started after the window closed → overheard, even though within GRACE of the close');
  });

  // A1i — but a sentence that STARTED at/before the close and ran over IS still addressed
  // (the legit long-utterance case must keep working after tightening the start check).
  it('A1i: a sentence started before the close, ending after, is still addressed', () => {
    const { cs } = make();
    cs.tap(0);
    const close = ConvCfg.LISTEN_MS;                  // tap window closes at LISTEN_MS
    // started 1s BEFORE close, ended 1.5s after → straddles the edge → addressed.
    assert.equal(cs.utteranceEnded(close + 1500, close + 1500, close - 1000), true,
      'started while open, ended late → addressed (long-utterance grace intact)');
  });

  // A1j — THE INTERMITTENT LIVE RACE (reproduced ~1-in-10 with screenshots + the
  // addressed trace): you tap, the badge shows "listening · Ns", you speak WELL within
  // the window — but the FINAL only lands after a lazy #prune flips mode to idle in the
  // ~1.3s STT-endpoint gap. The utterance STARTED inside the open interval, so it MUST
  // still be addressed. The old rescue (startedAt <= #lastWindowUntil, zeroed on the
  // prior consume) failed here intermittently; the [openedAt, lastWindowUntil] interval
  // check fixes it deterministically.
  it('A1j: started in-window but final lands after a lazy prune-to-idle → addressed', () => {
    const { cs } = make();
    cs.tap(0);                                       // window open [0, LISTEN_MS]
    const start = 800;                               // spoke 0.8s in (badge clearly listening)
    // NO read before this — prune is lazy; the final arrives at LISTEN_MS+300 (just past
    // the real close, inside the STT-endpoint gap), so utteranceEnded prunes to idle THEN.
    const end = ConvCfg.LISTEN_MS + 300;
    assert.equal(cs.utteranceEnded(end, end, start), true,
      'utterance begun while listening is addressed even if the final lands post-prune');
    assert.equal(cs.mode(end), 'thinking', '→ runs the turn');
  });

  // A1k — same breath, TWO utterances: the first consumes the window; the second (also
  // begun in the original open interval) must still be addressed — the old `consumed`
  // zeroing of #lastWindowUntil dropped it.
  it('A1k: a second utterance from the same open window is still addressed', () => {
    const { cs } = make();
    cs.tap(0);
    assert.equal(cs.utteranceEnded(1000, 1100, 200), true, 'first utterance addressed');
    // second utterance also started while the window was open (300), ends a bit later;
    // still within the window so windowOpenNow is true OR the interval rescue applies.
    assert.equal(cs.utteranceEnded(2000, 2100, 300), true, 'second from the same window addressed');
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
  // These tests cover the face-arrival WINDOW logic, which is gated OFF by
  // default in production (wake-on-look disabled — tap/wave only). Enable the
  // flag for this suite so the logic stays under test; restore after.
  before(() => { process.env.CONV_FACE_ARRIVAL = '1'; });
  after(() => { delete process.env.CONV_FACE_ARRIVAL; });

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
  // Face-arrival window is gated off by default in production; enable for this
  // logic suite (see the D2/D3 block above for why).
  before(() => { process.env.CONV_FACE_ARRIVAL = '1'; });
  after(() => { delete process.env.CONV_FACE_ARRIVAL; });

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
      (cs: ConversationState) => {                                  // face listen
        process.env.CONV_FACE_ARRIVAL = '1';
        cs.faceArrival(0);
        delete process.env.CONV_FACE_ARRIVAL;
      },
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

/**
 * Reconnection sim (R1–R4) — the WS-drop / reconnect scenarios from
 * docs/findings/conversation-state-test-cases.md "── Reconnections ──".
 *
 * R5/R6 (clean reset on app/server restart) live in conversation-state.test.ts as
 * pure-state cases. THESE exercise the SESSION wiring end-to-end: that a real
 * reconnect path (hello → notePhoneConnected + resendConversation) recovers a
 * stuck/leaked conversation AND re-syncs the phone with a `conversation` frame —
 * not just that the math in ConversationState is right.
 *
 * The "WS drop" is modelled the way it actually behaves: while dropped, the phone
 * stops receiving station→phone frames (we stop reading them); on reconnect the
 * station gets a `hello`, which the brain module turns into notePhoneConnected()
 * + resendConversation(). We assert the conversation snapshot AND the resync frame
 * the phone receives back.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Bus, type BusMessage } from '../../core/bus.js';
import type { RosterEntry } from '../../core/hub.js';
import { Directory } from '../docks/directory.js';
import { MotionExecutor } from '../bodylink/motion.js';
import { RpcBroker } from './rpc.js';
import { SessionStore } from './store.js';
import { DockBrainSession, type SessionDeps } from './session.js';
import { ConvCfg } from './conversation-state.js';

const DOCK = 'test-bot';

function phonePeer(): RosterEntry {
  return {
    role: 'device', id: 'phone-hw-1', dock: DOCK, component: 'phone',
    kind: 'dock-android-app', caps: ['voice', 'face', 'camera'],
    lastSeen: Date.now(), connectedAt: Date.now(), topics: ['agent'],
  };
}

/** A bare session + a capture of every station→phone frame (the "phone's WS"). */
function makeSession() {
  const bus = new Bus();
  const roster = [phonePeer()];
  const directory = new Directory(() => roster, join(tmpdir(), `dir-${Math.random()}.json`));
  const motion = new MotionExecutor(bus, directory);
  const rpc = new RpcBroker(bus, directory);
  const store = new SessionStore(mkdtempSync(join(tmpdir(), 'brain-recon-')));
  const frames: BusMessage[] = [];
  bus.on('agent', (m) => { if (m.source === 'station') frames.push(m); });
  const config: Record<string, unknown> = { brainModel: 'openai-compatible/faux@http://test' };
  const deps: SessionDeps = {
    bus, directory, rpc, motion, store,
    getFaces: () => undefined as never,
    config: (k) => config[k as keyof typeof config],
    streamFn: (() => { throw new Error('no turns in reconnection sim'); }) as never,
  };
  const session = new DockBrainSession(DOCK, deps);
  return { session, frames };
}

const convFrames = (frames: BusMessage[]) =>
  frames.filter((f) => f.kind === 'conversation').map((f) => f.payload as { from: string; to: string; reason: string });

// ── R1: lost "TTS finished" → speaking recovers, and a reconnect clears it ──────
test('R1: a never-arriving tts-end does not wedge speaking; reconnect clears it', () => {
  const { session, frames } = makeSession();
  const t0 = Date.now();
  session.noteSpeech(true); // tts-start; the matching tts-end is "lost"

  // Bounded by SPEAK_MAX_MS even if the phone never reports tts-end.
  assert.equal(session.conversation().mode, 'speaking', 'speaking right after tts-start');

  // The phone reconnects (hello) while we still think it is speaking → reconcile.
  frames.length = 0;
  session.notePhoneConnected();
  session.resendConversation();
  assert.equal(session.conversation().mode, 'idle', 'reconnect reconciled the lost-end speaking → idle');
  assert.ok(convFrames(frames).some((f) => f.reason === 'resync'),
    'phone got a conversation resync frame');
  void t0;
});

// ── R2: phone reconnect from any mode → clean idle + resync ─────────────────────
test('R2: phone reconnect from a live listening window → idle, resync sent', () => {
  const { session, frames } = makeSession();
  session.tap();                       // open a listening window
  assert.equal(session.conversation().mode, 'listening');

  frames.length = 0;
  session.notePhoneConnected();        // hello
  session.resendConversation();
  assert.equal(session.conversation().mode, 'idle', 'reconnect → clean idle');
  const resync = convFrames(frames).filter((f) => f.reason === 'resync');
  assert.equal(resync.length, 1, 'exactly one resync frame to the phone');
  assert.equal(resync[0]?.to, 'idle', 'resync reflects the reconciled idle mode');
});

// ── R3: disconnect mid-listening / mid-followup → window doesn't leak ───────────
test('R3: dropping the WS mid-listening does not leak the window across reconnect', () => {
  const { session } = makeSession();
  session.tap();                       // listening window opens
  assert.equal(session.conversation().mode, 'listening');

  // WS drops: the phone stops getting frames (we just stop caring about them).
  // Time passes; the phone reconnects. The window must NOT still be open.
  session.notePhoneConnected();
  const snap = session.conversation();
  assert.equal(snap.mode, 'idle', 'no leaked listening window after reconnect');
  assert.equal(snap.windowUntil, 0, 'window cleared');
  assert.equal(snap.speakUntil, 0, 'no speak window');
});

test('R3b: dropping the WS mid-followup does not leak the followup window', () => {
  const { session } = makeSession();
  // Drive into followup the way a finished reply does: speak then end.
  session.noteSpeech(true);
  session.noteSpeech(false);           // → followup (auto re-listen)
  assert.equal(session.conversation().mode, 'followup', 'in the followup window');

  session.notePhoneConnected();        // reconnect
  assert.equal(session.conversation().mode, 'idle', 'followup window did not leak');
});

// ── R4: station "restart" + dock re-hello → state re-established (clean) ─────────
test('R4: a fresh session + dock re-hello comes up clean idle and re-syncs the phone', () => {
  // A new process = a new session, idle by construction. The dock re-hellos into it.
  const { session, frames } = makeSession();
  assert.equal(session.conversation().mode, 'idle', 'fresh session is idle');

  frames.length = 0;
  session.notePhoneConnected();        // the re-hello
  session.resendConversation();
  assert.equal(session.conversation().mode, 'idle');
  // The resync goes out even from idle — that is what un-sticks a stale phone face.
  assert.ok(convFrames(frames).some((f) => f.reason === 'resync'),
    'phone re-synced after station restart, even though idle');
});

// Guard: SPEAK_MAX_MS is a real bound (referenced by R1's rationale).
test('R1 rationale: SPEAK_MAX_MS is a finite ceiling', () => {
  assert.ok(ConvCfg.SPEAK_MAX_MS > 0 && Number.isFinite(ConvCfg.SPEAK_MAX_MS));
});

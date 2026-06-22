/**
 * INTEGRATION: the live interim (partial) transcript path, brain → dock.
 *
 *   stt-watch (gated on isListening) → TranscriptApi.onInterim
 *     → brain handler → session.sendInterim(text, seq)
 *     → directed 'transcript-interim' frame on the 'agent' topic → the phone.
 *
 * This covers the brain seam the unit tests can't: that sendInterim emits the right
 * directed frame, that the listening gate (session.isListening) opens/closes with the
 * conversation state, and that interims NEVER start or alter a turn (cosmetic only).
 * Real Bus + Directory + DockBrainSession; only the LLM transport + dock peer scripted.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';
import { Bus, type BusMessage } from '../../core/bus.js';
import type { RosterEntry } from '../../core/hub.js';
import { Directory } from '../docks/directory.js';
import { MotionExecutor } from '../bodylink/motion.js';
import { RpcBroker } from './rpc.js';
import { SessionStore } from './store.js';
import { DockBrainSession, type SessionDeps } from './session.js';

const DOCK = 'desk-1';

function phonePeer(): RosterEntry {
  return {
    role: 'device', id: 'phone-1', dock: DOCK, component: 'phone',
    kind: 'dock-android-app', caps: ['voice', 'face', 'camera'],
    lastSeen: Date.now(), connectedAt: Date.now(), topics: ['agent'],
  };
}

interface InterimFrame { text: string; seq: number; isFinal: boolean }

function rig() {
  const bus = new Bus();
  const directory = new Directory(() => [phonePeer()], join(tmpdir(), `dir-${Math.random()}.json`));
  const motion = new MotionExecutor(bus, directory);
  const rpc = new RpcBroker(bus, directory);
  const store = new SessionStore(mkdtempSync(join(tmpdir(), 'interim-')));
  const interims: InterimFrame[] = [];
  const speaks: string[] = [];
  // Capture what the station directs to the phone over the 'agent' topic.
  bus.on('agent', (m: BusMessage) => {
    if (m.source !== 'station') return;
    if (m.kind === 'transcript-interim') interims.push(m.payload as InterimFrame);
    if (m.kind === 'speak') speaks.push((m.payload as { text: string }).text);
  });
  const cfg = { brainModel: 'openai-compatible/faux@http://test', brainTaskSettleMs: 0 } as Record<string, unknown>;
  const deps: SessionDeps = {
    bus, directory, rpc, motion, store,
    getFaces: () => undefined,
    config: (k) => cfg[k],
    streamFn: (() => {
      const s = createAssistantMessageEventStream();
      s.end();
      return s;
    }) as never,
  };
  const session = new DockBrainSession(DOCK, deps);
  return { bus, session, interims, speaks };
}

// CORE: sendInterim emits a directed transcript-interim frame to the phone with the
// text + monotonic seq, marked non-final.
test('sendInterim emits a directed transcript-interim frame', () => {
  const { session, interims } = rig();
  session.sendInterim('what time', 0);
  session.sendInterim('what time is it', 1);
  assert.equal(interims.length, 2);
  assert.deepEqual(interims[0], { text: 'what time', seq: 0, isFinal: false });
  assert.deepEqual(interims[1], { text: 'what time is it', seq: 1, isFinal: false });
});

// THE GATE: a tapped (addressed) dock is listening → the resolver opens; an idle dock
// is not. This is what bounds interim GPU cost to active turns.
test('isListening gate: open while listening, closed when idle', () => {
  const { session } = rig();
  assert.equal(session.isListening(), false, 'fresh session is idle');
  session.tap(); // open the listening window (the addressed gesture)
  assert.equal(session.isListening(), true, 'tapped → listening');
});

// COSMETIC ONLY: sending interims must NEVER produce a speak / start a turn. The
// authoritative path is the endpointed final (onAddressedFinal), not these.
test('interims never start a turn or cause a reply', () => {
  const { session, speaks } = rig();
  session.tap();
  session.sendInterim('tell me a story', 0);
  session.sendInterim('tell me a story about', 1);
  assert.equal(speaks.length, 0, 'no speak frame from interims');
  assert.equal(session.turnActive, false, 'no turn became active from interims');
});

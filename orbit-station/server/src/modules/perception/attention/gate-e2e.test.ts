/**
 * END-TO-END integration (docs/perception-to-agent.md Phase 5) — the WHOLE proactive
 * chain across modules, no mocks of the seam under test:
 *
 *   identity snapshot lands in the store
 *     → startGateWatcher derives signals + evaluateGate RAISES (arrival)
 *     → the raise handler calls session.enqueueAutonomousTurn (trigger.kind:'self')
 *     → DockBrainSession routes it through the Phase-1 state gate and RUNS a turn
 *     → the dock "speaks" (a scripted LLM)
 *
 * This is the cross-module wiring the unit tests can't cover: real SnapshotStore,
 * real gate + watcher, real session. Only the LLM transport + dock peer are scripted.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createAssistantMessageEventStream, type AssistantMessageEventStream, type AssistantMessage,
} from '@earendil-works/pi-ai';
import { Bus, type BusMessage } from '../../../core/bus.js';
import type { RosterEntry } from '../../../core/hub.js';
import { Directory } from '../../docks/directory.js';
import { MotionExecutor } from '../../bodylink/motion.js';
import { RpcBroker } from '../../brain/rpc.js';
import { SessionStore } from '../../brain/store.js';
import { DockBrainSession, type SessionDeps } from '../../brain/session.js';
import { SnapshotStore, makeSnapshot } from '../snapshots.js';
import { startGateWatcher, type RaisedThought } from './gate-watcher.js';
import { DEFAULT_GATE_CONFIG, type GateConfig } from './gate.js';

const DOCK = 'desk-1';

function phonePeer(): RosterEntry {
  return {
    role: 'device', id: 'phone-1', dock: DOCK, component: 'phone',
    kind: 'dock-android-app', caps: ['voice', 'face', 'camera'],
    lastSeen: Date.now(), connectedAt: Date.now(), topics: ['agent'],
  };
}
function assistant(text: string): AssistantMessage {
  return {
    role: 'assistant', content: text ? [{ type: 'text', text }] : [],
    api: 'openai-completions', provider: 'test', model: 'faux',
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: 'stop', timestamp: Date.now(),
  };
}
function say(text: string) {
  return (s: AssistantMessageEventStream) => {
    s.push({ type: 'start', partial: assistant('') });
    s.push({ type: 'text_delta', contentIndex: 0, delta: text, partial: assistant(text) });
    s.push({ type: 'done', reason: 'stop', message: assistant(text) });
    s.end();
  };
}

function identityRecord(names: (string | null)[]) {
  return makeSnapshot({
    dockId: DOCK, source: { id: 'cam-0', kind: 'identity', device: 'd', host: 'h' },
    model: { name: 'face-api', endpoint: 'in-process' },
    from: new Date(), to: new Date(),
    payload: { text: names.join(', ') || 'no one', faces: names.map((name) => ({ name })) },
  });
}

const tick = () => new Promise((r) => setTimeout(r, 30));

test('E2E: an arrival snapshot raises a self-thought that the session speaks', async () => {
  const bus = new Bus();
  const roster = [phonePeer()];
  const directory = new Directory(() => roster, join(tmpdir(), `dir-${Math.random()}.json`));
  const motion = new MotionExecutor(bus, directory);
  const rpc = new RpcBroker(bus, directory);
  const store = new SessionStore(mkdtempSync(join(tmpdir(), 'gate-e2e-')));
  const speaks: string[] = [];
  bus.on('agent', (m: BusMessage) => {
    if (m.source === 'station' && m.kind === 'speak') speaks.push((m.payload as { text: string }).text);
  });

  const cfg = { brainModel: 'openai-compatible/faux@http://test', brainTaskSettleMs: 0 } as Record<string, unknown>;
  const deps: SessionDeps = {
    bus, directory, rpc, motion, store,
    getFaces: () => undefined,
    config: (k) => cfg[k],
    streamFn: ((_m: unknown, _c: unknown, _o: unknown) => {
      const stream = createAssistantMessageEventStream();
      say('Oh, hi Guru!')(stream);
      return stream;
    }) as never,
  };
  const session = new DockBrainSession(DOCK, deps);

  // the REAL gate chain: store → watcher → gate → raise → session.
  const snapshots = new SnapshotStore();
  const gateCfg: GateConfig = { ...DEFAULT_GATE_CONFIG, enabled: true };
  const raised: RaisedThought[] = [];
  startGateWatcher(snapshots, () => gateCfg, (t) => {
    raised.push(t);
    session.enqueueAutonomousTurn({
      turnId: `self-${Math.random().toString(36).slice(2)}`,
      trigger: { kind: 'self', text: t.text },
      expiresAt: Date.now() + 30_000, coalesceKey: t.key,
    });
  });

  // 1) nobody → then Guru arrives. Two readings so the watcher diffs an ARRIVAL.
  snapshots.add(identityRecord([]));        // present: []
  await tick();                             // let the debounce fire (sets prev=[])
  snapshots.add(identityRecord(['guru']));  // present: [guru] → arrival
  // wait for: debounce (400ms) → raise → enqueue (coalesce 60ms) → drain → turn
  for (let i = 0; i < 80 && speaks.length === 0; i++) await tick();

  assert.equal(raised.length, 1, 'the gate raised exactly one thought');
  assert.equal(raised[0]!.kind, 'self:presence');
  assert.match(raised[0]!.text, /guru just came into view/);
  assert.deepEqual(speaks, ['Oh, hi Guru!'], 'the session ran the self-thought and spoke');
});

test('E2E: the gate stays silent when disabled (no raise, no turn)', async () => {
  const bus = new Bus();
  const directory = new Directory(() => [phonePeer()], join(tmpdir(), `dir-${Math.random()}.json`));
  const motion = new MotionExecutor(bus, directory);
  const store = new SessionStore(mkdtempSync(join(tmpdir(), 'gate-e2e2-')));
  const speaks: string[] = [];
  bus.on('agent', (m: BusMessage) => { if (m.source === 'station' && m.kind === 'speak') speaks.push((m.payload as { text: string }).text); });
  const cfg = { brainModel: 'openai-compatible/faux@http://test', brainTaskSettleMs: 0 } as Record<string, unknown>;
  const session = new DockBrainSession(DOCK, {
    bus, directory, rpc: new RpcBroker(bus, directory), motion, store,
    getFaces: () => undefined, config: (k) => cfg[k],
    streamFn: (() => { const s = createAssistantMessageEventStream(); say('hi')(s); return s; }) as never,
  });

  const snapshots = new SnapshotStore();
  const gateCfg: GateConfig = { ...DEFAULT_GATE_CONFIG, enabled: false }; // OFF
  let raises = 0;
  startGateWatcher(snapshots, () => gateCfg, () => { raises++; session.enqueueAutonomousTurn({ turnId: 'x', trigger: { kind: 'self', text: 'x' } }); });

  snapshots.add(identityRecord([]));
  await tick();
  snapshots.add(identityRecord(['guru']));
  for (let i = 0; i < 30; i++) await tick();

  assert.equal(raises, 0, 'disabled gate raised nothing');
  assert.deepEqual(speaks, [], 'no turn ran');
});

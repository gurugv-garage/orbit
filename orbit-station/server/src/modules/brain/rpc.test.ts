import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Bus, type BusMessage } from '../../core/bus.js';
import type { RosterEntry } from '../../core/hub.js';
import { Directory } from '../docks/directory.js';
import { RpcBroker } from './rpc.js';

function phonePeer(dock: string): RosterEntry {
  return {
    role: 'device', id: `${dock}-phone-hw`, dock, component: 'phone',
    kind: 'dock-android-app', caps: ['voice', 'face', 'camera'],
    lastSeen: Date.now(), connectedAt: Date.now(), topics: ['agent'],
  };
}

function setup(roster: RosterEntry[] = []) {
  const bus = new Bus();
  const directory = new Directory(() => roster, join(tmpdir(), `docks-test-${Math.random()}.json`));
  const broker = new RpcBroker(bus, directory);
  const sent: BusMessage[] = [];
  bus.on('agent', (m) => { if (m.source === 'station') sent.push(m); });
  return { bus, broker, sent };
}

test('resolves on matching tool-result', async () => {
  const { bus, broker, sent } = setup([phonePeer('anne-bot')]);
  const call = broker.call({
    dock: 'anne-bot', cap: 'face', turnId: 't1', toolCallId: 'tc1',
    name: 'set_face', args: { expression: 'happy' },
  });
  assert.equal(sent.length, 1);
  const frame = sent[0]!.payload as { reqId: string };
  assert.deepEqual(sent[0]!.toAddr, { dock: 'anne-bot', component: 'phone' });
  bus.publish({
    topic: 'agent', kind: 'tool-result', source: 'anne-bot-phone-hw',
    payload: { reqId: frame.reqId, toolCallId: 'tc1', content: 'face set to happy', isError: false },
  });
  const r = await call;
  assert.deepEqual(r, { content: 'face set to happy', isError: false });
  assert.equal(broker.inflight(), 0);
});

test('offline component → instant error result, nothing sent', async () => {
  const { broker, sent } = setup([]);
  const r = await broker.call({
    dock: 'anne-bot', cap: 'face', turnId: 't1', toolCallId: 'tc1',
    name: 'set_face', args: {},
  });
  assert.equal(r.isError, true);
  assert.match(r.content, /no online component/);
  assert.equal(sent.length, 0);
});

test('timeout → error result; late result dropped', async () => {
  const { bus, broker, sent } = setup([phonePeer('anne-bot')]);
  const r = await broker.call({
    dock: 'anne-bot', cap: 'face', turnId: 't1', toolCallId: 'tc1',
    name: 'set_face', args: {}, timeoutMs: 20,
  });
  assert.equal(r.isError, true);
  assert.match(r.content, /no response/);
  // late result after timeout: must not throw, must stay settled
  const frame = sent[0]!.payload as { reqId: string };
  bus.publish({
    topic: 'agent', kind: 'tool-result', source: 'anne-bot-phone-hw',
    payload: { reqId: frame.reqId, content: 'late', isError: false },
  });
  assert.equal(broker.inflight(), 0);
});

test('rejectAllForDock settles only that dock', async () => {
  const roster = [phonePeer('anne-bot'), phonePeer('desk-bot')];
  const { broker } = setup(roster);
  const a = broker.call({ dock: 'anne-bot', cap: 'face', turnId: 't', toolCallId: 'a', name: 'set_face', args: {} });
  const b = broker.call({ dock: 'desk-bot', cap: 'face', turnId: 't', toolCallId: 'b', name: 'set_face', args: {} });
  assert.equal(broker.inflight(), 2);
  broker.rejectAllForDock('anne-bot', 'dock went offline');
  const ra = await a;
  assert.equal(ra.isError, true);
  assert.match(ra.content, /offline/);
  assert.equal(broker.inflight('desk-bot'), 1);
  broker.rejectAllForDock('desk-bot', 'cleanup');
  await b;
});

test('two docks in flight resolve independently', async () => {
  const roster = [phonePeer('anne-bot'), phonePeer('desk-bot')];
  const { bus, broker, sent } = setup(roster);
  const a = broker.call({ dock: 'anne-bot', cap: 'face', turnId: 't', toolCallId: 'a', name: 'set_face', args: {} });
  const b = broker.call({ dock: 'desk-bot', cap: 'face', turnId: 't', toolCallId: 'b', name: 'set_face', args: {} });
  const [fa, fb] = sent.map((s) => s.payload as { reqId: string });
  bus.publish({ topic: 'agent', kind: 'tool-result', source: 'desk-bot-phone-hw', payload: { reqId: fb!.reqId, content: 'B', isError: false } });
  bus.publish({ topic: 'agent', kind: 'tool-result', source: 'anne-bot-phone-hw', payload: { reqId: fa!.reqId, content: 'A', isError: false } });
  assert.equal((await a).content, 'A');
  assert.equal((await b).content, 'B');
});

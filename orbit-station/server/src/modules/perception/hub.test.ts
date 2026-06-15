/**
 * ProcessingHub unit tests (node:test). Verify the hub fans media + WS facts to
 * registered processors with source/kind/channel filtering, routes emitted results
 * to the perception topic, and handles runtime register/unregister + teardown.
 * No real WebRTC — we drive onTrack with a fake track object.
 *
 *   npm test --workspace server
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Bus, type BusMessage } from '../../core/bus.js';
import { ProcessingHub } from './hub.js';
import type { ChannelItem, StreamContext, StreamProcessor } from './processor.js';
import type { MediaKind } from '../media/tap.js';

/** A fake werift MediaStreamTrack whose onReceiveRtp we can fire manually. */
function fakeTrack() {
  const subs: Array<(rtp: any) => void> = [];
  return {
    track: { onReceiveRtp: { subscribe: (cb: (rtp: any) => void) => subs.push(cb) } } as any,
    fireRtp: (rtp: any) => subs.forEach((s) => s(rtp)),
  };
}

/** A recording stub processor. */
function stub(opts: Partial<StreamProcessor> & { id: string }) {
  const log = { started: [] as string[], rtp: [] as any[], facts: [] as ChannelItem[], ended: [] as string[] };
  let ctx: StreamContext | undefined;
  const p: StreamProcessor = {
    id: opts.id,
    sources: opts.sources ?? '*',
    mediaKinds: opts.mediaKinds ?? [],
    channels: opts.channels ?? [],
    onStreamStart: (c) => { ctx = c; log.started.push(c.streamId); },
    onRtp: (_s, _k, rtp) => log.rtp.push(rtp),
    onChannelItem: (i) => log.facts.push(i),
    onStreamEnd: (s) => log.ended.push(s),
  };
  return { p, log, getCtx: () => ctx };
}

/** Collect perception-topic publishes. */
function collectPerception(bus: Bus) {
  const out: BusMessage[] = [];
  bus.on('perception', (m) => out.push(m));
  return out;
}

const hubWith = () => {
  const bus = new Bus();
  // resolveDock: strip a trailing "-app" to a friendly name, else identity.
  const hub = new ProcessingHub(bus, (id) => id.replace(/-app$/, ''));
  return { bus, hub };
};

test('media: one track fans RTP to all matching processors', () => {
  const { hub } = hubWith();
  const a = stub({ id: 'a', mediaKinds: ['video'] });
  const b = stub({ id: 'b', mediaKinds: ['video'] });
  const c = stub({ id: 'c', mediaKinds: ['audio'] }); // wrong kind
  hub.register(a.p); hub.register(b.p); hub.register(c.p);

  const t = fakeTrack();
  hub.onTrack('dock-1', 'video', t.track);
  t.fireRtp({ seq: 1 }); t.fireRtp({ seq: 2 });

  assert.deepEqual(a.log.started, ['dock-1']);
  assert.deepEqual(b.log.started, ['dock-1']);
  assert.equal(a.log.rtp.length, 2);
  assert.equal(b.log.rtp.length, 2);
  assert.equal(c.log.rtp.length, 0, 'audio-only processor gets no video RTP');
  assert.deepEqual(c.log.started, [], 'and is not started on a video-only stream');
});

test('source filtering: a processor only sees its declared sources', () => {
  const { hub } = hubWith();
  const only1 = stub({ id: 'only1', sources: ['dock-1'], mediaKinds: ['video'] });
  hub.register(only1.p);

  hub.onTrack('dock-1', 'video', fakeTrack().track);
  hub.onTrack('dock-2', 'video', fakeTrack().track);

  assert.deepEqual(only1.log.started, ['dock-1'], 'dock-2 filtered out');
});

test('WS facts: client topic → channel items, filtered by channel + source', () => {
  const { bus, hub } = hubWith();
  const batteryProc = stub({ id: 'bat', sources: '*', channels: ['client.battery'] });
  hub.register(batteryProc.p);

  // dock publishes a battery fact (source = its peer id)
  bus.publish({ topic: 'client', kind: 'battery', payload: { pct: 42 }, source: 'dock-1-app' });
  // and an unrelated client fact it doesn't want
  bus.publish({ topic: 'client', kind: 'vad', payload: { speaking: true }, source: 'dock-1-app' });

  assert.equal(batteryProc.log.facts.length, 1);
  const f = batteryProc.log.facts[0]!;
  assert.equal(f.channel, 'client.battery');
  assert.equal(f.source, 'dock-1-app');
  assert.equal(f.dockId, 'dock-1', 'resolveDock applied');
  assert.deepEqual(f.payload, { pct: 42 });
});

test('emit: a result is published on the perception topic, directed + broadcast', () => {
  const { bus, hub } = hubWith();
  const results = collectPerception(bus);
  const p = stub({ id: 'p', mediaKinds: ['video'] });
  hub.register(p.p);
  hub.onTrack('dock-1-app', 'video', fakeTrack().track);

  p.getCtx()!.emit({ kind: 'presence', payload: { present: true }, source: 'p', confidence: 1 });

  // one directed (to the dock) + one undirected (console/state)
  assert.equal(results.length, 2);
  const directed = results.find((r) => r.to != null);
  const broadcast = results.find((r) => r.to == null);
  assert.ok(directed && directed.to === 'dock-1', 'directed to dockId');
  assert.ok(broadcast, 'undirected copy present');
  const payload = directed!.payload as any;
  assert.equal(payload.kind, 'presence');
  assert.equal(payload.dockId, 'dock-1');
  assert.equal(payload.streamId, 'dock-1-app');
  assert.ok(typeof payload.ts === 'number');
});

test('chaining: ctx.publish delivers a fact to OTHER processors on the same channel', () => {
  const { hub } = hubWith();
  const producer = stub({ id: 'prod', mediaKinds: ['video'] });
  const consumer = stub({ id: 'cons', channels: ['face.box'] });
  hub.register(producer.p); hub.register(consumer.p);
  hub.onTrack('dock-1', 'video', fakeTrack().track); // starts producer; consumer is fact-only

  producer.getCtx()!.publish('face.box', { x: 1, y: 2 });

  assert.equal(consumer.log.facts.length, 1);
  assert.equal(consumer.log.facts[0]!.channel, 'face.box');
  assert.equal(producer.log.facts.length, 0, 'producer does not receive its own publish');
});

test('teardown: onProducerGone ends matching processors', () => {
  const { hub } = hubWith();
  const p = stub({ id: 'p', mediaKinds: ['video'] });
  hub.register(p.p);
  hub.onTrack('dock-1', 'video', fakeTrack().track);
  hub.onProducerGone('dock-1');
  assert.deepEqual(p.log.ended, ['dock-1']);
});

test('runtime register: a processor added AFTER a stream is active starts on it', () => {
  const { hub } = hubWith();
  hub.onTrack('dock-1', 'video', fakeTrack().track); // stream active first
  const late = stub({ id: 'late', mediaKinds: ['video'] });
  hub.register(late.p);
  assert.deepEqual(late.log.started, ['dock-1'], 'late processor catches the active stream');
});

test('runtime register: a late processor also RECEIVES RTP from the live track', () => {
  const { hub } = hubWith();
  const t = fakeTrack();
  hub.onTrack('dock-1', 'video', t.track); // stream live BEFORE the processor exists
  const late = stub({ id: 'late', mediaKinds: ['video'] });
  hub.register(late.p);
  t.fireRtp({ seq: 1 });
  t.fireRtp({ seq: 2 });
  assert.equal(late.log.rtp.length, 2, 'late processor gets RTP from the already-live track');
});

test('unregister: removing a processor ends its streams and stops delivery', () => {
  const { hub } = hubWith();
  const p = stub({ id: 'p', mediaKinds: ['video'] });
  const remove = hub.register(p.p);
  const t = fakeTrack();
  hub.onTrack('dock-1', 'video', t.track);
  remove();
  assert.deepEqual(p.log.ended, ['dock-1'], 'unregister ends active streams');
  t.fireRtp({ seq: 9 });
  assert.equal(p.log.rtp.length, 0, 'no RTP after unregister');
});

test('a throwing processor does not break the hub', () => {
  const { hub } = hubWith();
  const bad: StreamProcessor = {
    id: 'bad', sources: '*', mediaKinds: ['video'], channels: [],
    onStreamStart: () => { throw new Error('boom'); },
    onStreamEnd: () => {},
  };
  const good = stub({ id: 'good', mediaKinds: ['video'] });
  hub.register(bad); hub.register(good.p);
  // should not throw
  hub.onTrack('dock-1', 'video', fakeTrack().track);
  assert.deepEqual(good.log.started, ['dock-1'], 'good processor still ran');
});

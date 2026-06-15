/**
 * Task capabilities — the station-side registry + broker that serve a task
 * process's `request` frames. Pure logic (no processes, no WS): a fake hasDockCap
 * gates per-dock; a fake sendToTask captures the reply.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CapabilityRegistry, CapabilityBroker, type Capability } from './capabilities.js';

const frameCap: Capability = {
  op: 'frame', requires: 'camera',
  describe: 'await this.frame() → latest camera JPEG (or undefined)',
  when: 'when you need to look at what the camera sees now',
  handler: () => 'JPEGDATA',
};
const moveCap: Capability = {
  op: 'move', requires: 'servo',
  describe: 'await this.move(steps) → drive the body',
  when: 'to turn or gesture the body',
  handler: (_ctx, args) => ({ moved: args.steps }),
};
const httpCap: Capability = {
  op: 'http_get', // no requires → always available
  describe: 'await this.request("http_get", { url })',
  when: 'to fetch a URL',
  handler: (_ctx, args) => `fetched ${args.url}`,
};

/** dock 'full' has camera+servo; dock 'mini' has neither. */
const hasCap = (dock: string, cap: string) => dock === 'full' && (cap === 'camera' || cap === 'servo');

function registry() {
  return new CapabilityRegistry(hasCap).register(frameCap).register(moveCap).register(httpCap);
}

test('register refuses a duplicate op', () => {
  const r = registry();
  assert.throws(() => r.register(frameCap), /already registered/);
});

test('forDock filters by the dock\'s capabilities', () => {
  const r = registry();
  assert.deepEqual(r.forDock('full').map((c) => c.op).sort(), ['frame', 'http_get', 'move']);
  assert.deepEqual(r.forDock('mini').map((c) => c.op).sort(), ['http_get']); // only the unrequired one
});

test('advertiseFor lists only available caps, with describe + when', () => {
  const r = registry();
  const ad = r.advertiseFor('full');
  assert.match(ad, /this.frame\(\)/);
  assert.match(ad, /this.move\(steps\)/);
  assert.match(ad, /when you need to look/);
  // mini still has http_get → non-empty, but no frame/move
  const mini = r.advertiseFor('mini');
  assert.match(mini, /http_get/);
  assert.doesNotMatch(mini, /this.move/);
});

test('invoke runs a permitted capability and returns its result', async () => {
  const r = registry();
  const out = await r.invoke({ dock: 'full', instanceId: 't-1' }, 'frame', {});
  assert.deepEqual(out, { ok: true, result: 'JPEGDATA' });
});

test('invoke refuses an unknown op', async () => {
  const r = registry();
  const out = await r.invoke({ dock: 'full', instanceId: 't-1' }, 'nope', {});
  assert.equal(out.ok, false);
  assert.match((out as { error: string }).error, /unknown capability/);
});

test('invoke refuses a cap the dock lacks (tenancy-gated)', async () => {
  const r = registry();
  const out = await r.invoke({ dock: 'mini', instanceId: 't-1' }, 'move', { steps: [] });
  assert.equal(out.ok, false);
  assert.match((out as { error: string }).error, /no "servo"/);
});

test('invoke turns a handler throw into an error result (never throws)', async () => {
  const r = new CapabilityRegistry(() => true).register({
    op: 'boom', describe: 'x', when: 'y', handler: () => { throw new Error('kaboom'); },
  });
  const out = await r.invoke({ dock: 'full', instanceId: 't-1' }, 'boom', {});
  assert.equal(out.ok, false);
  assert.match((out as { error: string }).error, /kaboom/);
});

test('invoke passes the task\'s dock/instance + args to the handler', async () => {
  let seen: unknown;
  const r = new CapabilityRegistry(() => true).register({
    op: 'echo', describe: 'x', when: 'y',
    handler: (ctx, args) => { seen = { ctx, args }; return 'ok'; },
  });
  await r.invoke({ dock: 'full', instanceId: 't-9' }, 'echo', { a: 1 });
  assert.deepEqual(seen, { ctx: { dock: 'full', instanceId: 't-9' }, args: { a: 1 } });
});

// ── broker ───────────────────────────────────────────────────────────────────

test('broker dispatches a request and ships a response with the reqId', async () => {
  const sent: Array<{ dock: string; id: string; kind: string; payload: Record<string, unknown> }> = [];
  const broker = new CapabilityBroker(registry(), (dock, id, kind, payload) => sent.push({ dock, id, kind, payload }));
  await broker.handle('full', 't-1', { reqId: 'r1', op: 'http_get', args: { url: 'x' } });
  assert.equal(sent.length, 1);
  assert.equal(sent[0]!.kind, 'response');
  assert.deepEqual(sent[0]!.payload, { reqId: 'r1', ok: true, result: 'fetched x' });
});

test('broker replies with an error for a denied/unknown op (still correlated)', async () => {
  const sent: Array<Record<string, unknown>> = [];
  const broker = new CapabilityBroker(registry(), (_d, _i, _k, payload) => sent.push(payload));
  await broker.handle('mini', 't-1', { reqId: 'r2', op: 'move', args: {} });
  assert.equal(sent[0]!.ok, false);
  assert.equal(sent[0]!.reqId, 'r2');
  assert.match(String(sent[0]!.error), /servo/);
});

test('broker drops a request with no reqId (can\'t correlate a reply)', async () => {
  const sent: unknown[] = [];
  const broker = new CapabilityBroker(registry(), () => sent.push(1));
  await broker.handle('full', 't-1', { op: 'frame', args: {} }); // no reqId
  assert.equal(sent.length, 0);
});

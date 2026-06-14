/**
 * Task PROCESS integration — proves the separate-process + WebSocket model end to
 * end with REAL processes (no model, no browser). A real Hub + Bus on a real port,
 * the `tasks` topic wired exactly as the brain does, and actual `tsx` task
 * processes connecting back over ws://. Covers the happy path plus the resiliency
 * cases that only the real wire can show: a crashing task → errored; stop kills the
 * process; askAgentInput ↔ provideInput round-trips.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Bus } from '../../../core/bus.js';
import { Hub } from '../../../core/hub.js';
import { TaskSupervisor, describeInstance, type InstanceInfo, type SignalKind } from './supervisor.js';
import { defaultTasksRoot } from './manager.js';

const DOCK = 'proc-test-bot';
const tick = () => new Promise((r) => setTimeout(r, 20));

interface Rig {
  http: Server;
  supervisor: TaskSupervisor;
  signals: Array<{ kind: SignalKind; text: string; info: InstanceInfo }>;
  start: (filePath: string, params?: Record<string, unknown>, name?: string) => string;
  waitFor: (pred: () => boolean, ms?: number) => Promise<boolean>;
  close: () => Promise<void>;
}

async function makeRig(): Promise<Rig> {
  const http = await new Promise<Server>((resolve) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => resolve(s));
  });
  const port = (http.address() as { port: number }).port;
  const bus = new Bus();
  const hub = new Hub(http, bus);
  const signals: Rig['signals'] = [];
  const supervisor = new TaskSupervisor({
    root: mkdtempSync(join(tmpdir(), 'proc-')),
    stationWsUrl: `ws://127.0.0.1:${port}/ws`,
    onSignal: (_dock, info, kind, ev) => signals.push({ kind, text: ev.text, info }),
    sendToTask: (dock, instanceId, kind, payload) => {
      bus.publish({
        topic: 'tasks', kind, payload: { instanceId, ...payload },
        source: 'station', toAddr: { dock, component: `task:${instanceId}` },
      });
    },
  });
  // the brain's `tasks` routing: dock from the sender's hello (never the payload).
  bus.on('tasks', (msg) => {
    if (msg.source === 'station') return;
    const dock = hub.roster().find((p) => p.id === msg.source)?.dock;
    if (!dock) return;
    const p = (msg.payload ?? {}) as Record<string, unknown>;
    const instanceId = typeof p.instanceId === 'string' ? p.instanceId : '';
    if (instanceId) supervisor.onFrame(dock, { instanceId, kind: msg.kind, payload: p });
  });

  const start = (filePath: string, params: Record<string, unknown> = {}, name = 'remind-after') =>
    supervisor.start({ dock: DOCK, name, filePath, params, parentSessionId: 'sess-proc-1' });
  const waitFor = async (pred: () => boolean, ms = 8000) => {
    for (let i = 0; i < ms / 20 && !pred(); i++) await tick();
    return pred();
  };
  const close = () => new Promise<void>((r) => http.close(() => r()));
  return { http, supervisor, signals, start, waitFor, close };
}

/** Write a throwaway task.ts into a temp generated dir; returns its path + cleanup. */
function fixtureTask(body: string, status = "'x'"): { filePath: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'fixture-'));
  const harness = join(defaultTasksRoot(), '..', '_harness', 'index.js');
  const src = `
import { Task, runTask, type TaskManifest } from '${harness}';
export const manifest = { name: 'fixture', description: 'x', params: [] } satisfies TaskManifest;
class F extends Task {
  async run(): Promise<void> { ${body} }
  getStatus(): string { return ${status}; }
}
runTask(F);
`;
  const filePath = join(dir, 'task.ts');
  mkdirSync(dir, { recursive: true });
  writeFileSync(filePath, src);
  return { filePath, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('a real task process connects over WS, gets init, notifies, and finishes', async () => {
  const r = await makeRig();
  const filePath = join(defaultTasksRoot(), 'remind-after', 'task.ts');
  const id = r.start(filePath, { message: 'take a bath', delay: '200ms' });

  assert.ok(await r.waitFor(() => r.signals.some((s) => s.kind === 'finish')), 'finished over WS');
  const notify = r.signals.find((s) => s.kind === 'notify');
  assert.ok(notify && /take a bath/.test(notify.text), 'notified with the message');
  assert.equal(r.supervisor.get(id)?.state, 'done');
  assert.match(r.supervisor.status(id), /waiting 200ms|remind/i);
  const info = r.supervisor.get(id)!;
  assert.equal(info.runCount, 1);
  assert.ok(info.startedAt > 0 && info.spawnedAt >= info.startedAt);
  assert.match(describeInstance(info), /remind-after.*message=take a bath.*started/);

  r.supervisor.stop(id);
  await r.close();
});

test('a task that THROWS in run() lands as errored over WS (not a silent zombie)', async () => {
  const r = await makeRig();
  const fx = fixtureTask(`throw new Error('kaboom');`);
  const id = r.start(fx.filePath, {}, 'fixture');

  assert.ok(await r.waitFor(() => r.supervisor.get(id)?.state === 'errored'), 'reached errored');
  const err = r.signals.find((s) => s.kind === 'errored');
  assert.ok(err && /kaboom/.test(err.text), 'the failure reason reached the parent');

  fx.cleanup();
  await r.close();
});

test('stop() kills a long-running process — no further frames arrive', async () => {
  const r = await makeRig();
  // a task that notifies fast forever; we stop it and assert it goes quiet.
  const fx = fixtureTask(`while (true) { await this.notifyAgent('tick'); await this.sleep(40); }`);
  const id = r.start(fx.filePath, {}, 'fixture');

  assert.ok(await r.waitFor(() => r.signals.some((s) => s.kind === 'notify')), 'it started ticking');
  r.supervisor.stop(id);
  assert.equal(r.supervisor.get(id)?.state, 'stopped');
  const countAfterStop = r.signals.length;
  // give any in-flight/late frames a moment; the killed process must not keep ticking.
  await new Promise((res) => setTimeout(res, 300));
  assert.ok(r.signals.length - countAfterStop <= 1, 'at most one in-flight frame, then silence');

  fx.cleanup();
  await r.close();
});

test('askAgentInput ↔ provideInput round-trips over the real wire', async () => {
  const r = await makeRig();
  // ask, then notify the answer back so we can observe it, then finish.
  const fx = fixtureTask(
    `const ans = await this.askAgentInput('red or blue?'); await this.notifyAgent('you said ' + ans); this.finish();`,
  );
  const id = r.start(fx.filePath, {}, 'fixture');

  assert.ok(await r.waitFor(() => r.supervisor.get(id)?.state === 'stuck'), 'parked as stuck');
  assert.ok(r.signals.some((s) => s.kind === 'stuck' && /red or blue/.test(s.text)), 'asked the parent');
  assert.equal(r.supervisor.provideInput(id, 'blue'), true);

  assert.ok(await r.waitFor(() => r.signals.some((s) => s.kind === 'finish')), 'resumed + finished');
  assert.ok(r.signals.some((s) => s.kind === 'notify' && /you said blue/.test(s.text)), 'got the answer');

  fx.cleanup();
  await r.close();
});

test('a superseded askAgentInput rejects the first promise (no forever-hung await)', async () => {
  const r = await makeRig();
  // start awaiting the first ask, then issue a second ask before answering. The
  // first await must REJECT (not hang); the task catches it, reports, and the
  // second ask then parks it as stuck — proving the first didn't leak.
  const fx = fixtureTask(`
    const first = this.askAgentInput('first?');
    const second = this.askAgentInput('second?');   // supersedes the first
    try { await first; this.errored('first should have rejected'); }
    catch (e) { await this.notifyAgent('first rejected: ' + (e instanceof Error ? e.message : e)); }
    await second; this.finish();
  `);
  const id = r.start(fx.filePath, {}, 'fixture');

  assert.ok(await r.waitFor(() =>
    r.signals.some((s) => s.kind === 'notify' && /first rejected: .*superseded/.test(s.text))),
    'the first ask rejected promptly instead of hanging');
  // and it is now parked on the SECOND ask
  assert.ok(await r.waitFor(() => r.supervisor.get(id)?.state === 'stuck'), 'now stuck on the second ask');
  r.supervisor.provideInput(id, 'done');
  assert.ok(await r.waitFor(() => r.supervisor.get(id)?.state === 'done'), 'second answered → finished');

  fx.cleanup();
  await r.close();
});

test('an unhandled rejection in the body still reports errored (with a reason) to the parent', async () => {
  const r = await makeRig();
  // fire a rejecting promise WITHOUT awaiting it → unhandledRejection. The safety
  // net must turn it into an `errored` signal, not a silent bare crash.
  const fx = fixtureTask(`
    Promise.reject(new Error('unhandled boom'));
    await this.sleep('2s');   // give the rejection time to surface
  `);
  const id = r.start(fx.filePath, {}, 'fixture');

  assert.ok(await r.waitFor(() => r.supervisor.get(id)?.state === 'errored'), 'reached errored, not a silent crash');
  const err = r.signals.find((s) => s.kind === 'errored');
  assert.ok(err && /unhandled boom/.test(err.text), 'the crash reason reached the parent');

  fx.cleanup();
  await r.close();
});

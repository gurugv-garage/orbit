/**
 * Task PROCESS integration — proves the separate-process + WebSocket model end to
 * end, with NO model and NO browser. We stand up the real Hub + Bus on a real
 * port, wire the `tasks` topic exactly as the brain does (route task frames →
 * supervisor; supervisor sends init/input down by toAddr), then SPAWN the real
 * packaged `remind-after` task as its own `tsx` process. We assert that it:
 *   connects → attaches → gets init (params) → notifies → finishes,
 * with the supervisor surfacing status + the terminal outcome via onSignal.
 *
 * This is the real wire: the task process connects back over ws://, scoped to its
 * (dock, instanceId), and all parent↔task comms flow over that socket.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Bus } from '../../../core/bus.js';
import { Hub } from '../../../core/hub.js';
import { TaskSupervisor, describeInstance, type InstanceInfo, type SignalKind } from './supervisor.js';
import { defaultTasksRoot } from './manager.js';

const DOCK = 'proc-test-bot';
const tick = () => new Promise((r) => setTimeout(r, 20));

function listen(): Promise<{ http: ReturnType<typeof createServer>; port: number }> {
  return new Promise((resolve) => {
    const http = createServer();
    http.listen(0, '127.0.0.1', () => {
      const addr = http.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({ http, port });
    });
  });
}

test('a real task process connects over WS, gets init, notifies, and finishes', async () => {
  const { http, port } = await listen();
  const bus = new Bus();
  const hub = new Hub(http, bus);
  const wsUrl = `ws://127.0.0.1:${port}/ws`;

  // collect the parent signals the supervisor forwards (these become autonomous turns).
  const signals: Array<{ kind: SignalKind; text: string; info: InstanceInfo }> = [];
  const supervisor = new TaskSupervisor({
    root: mkdtempSync(join(tmpdir(), 'proc-')),
    stationWsUrl: wsUrl,
    onSignal: (_dock, info, kind, ev) => signals.push({ kind, text: ev.text, info }),
    sendToTask: (dock, instanceId, kind, payload) => {
      bus.publish({
        topic: 'tasks', kind, payload: { instanceId, ...payload },
        source: 'station', toAddr: { dock, component: `task:${instanceId}` },
      });
    },
  });

  // the brain's `tasks` routing: resolve the sender's dock from its hello, hand
  // each frame to the supervisor (tenancy from the roster, never the payload).
  bus.on('tasks', (msg) => {
    if (msg.source === 'station') return;
    const dock = hub.roster().find((p) => p.id === msg.source)?.dock;
    if (!dock) return;
    const p = (msg.payload ?? {}) as Record<string, unknown>;
    const instanceId = typeof p.instanceId === 'string' ? p.instanceId : '';
    if (instanceId) supervisor.onFrame(dock, { instanceId, kind: msg.kind, payload: p });
  });

  // spawn the REAL packaged remind-after with a tiny delay so the test is quick.
  const filePath = join(defaultTasksRoot(), 'remind-after', 'task.ts');
  const id = supervisor.start({
    dock: DOCK, name: 'remind-after', filePath,
    params: { message: 'take a bath', delay: '200ms' },
    parentSessionId: 'sess-proc-1',
  });

  // wait for the notify + finish to come back over the wire (process boot + tsx
  // cold start can take a few seconds).
  for (let i = 0; i < 400 && !signals.some((s) => s.kind === 'finish'); i++) await tick();

  const notify = signals.find((s) => s.kind === 'notify');
  const finish = signals.find((s) => s.kind === 'finish');
  assert.ok(notify, 'the task notified the parent over WS');
  assert.match(notify!.text, /take a bath/);
  assert.ok(finish, 'the task reported finish over WS');
  assert.equal(supervisor.get(id)?.state, 'done');
  // its self-kept status was reported up too
  assert.match(supervisor.status(id), /waiting 200ms|remind/i);
  // the instance descriptor is tracked: first run, with a real start time.
  const info = supervisor.get(id)!;
  assert.equal(info.runCount, 1, 'first run');
  assert.ok(info.startedAt > 0 && info.spawnedAt >= info.startedAt, 'has start/spawn times');
  assert.match(describeInstance(info), /remind-after.*message=take a bath.*started/);

  supervisor.stop(id);
  void hub;
  await new Promise<void>((r) => http.close(() => r()));
});

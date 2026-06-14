/**
 * Autonomous (task) turn injection — docs/TASKS_V1.md §7a, §11.B.
 *  - enqueueAutonomousTurn makes the dock speak unprompted, with autonomous:true
 *    on the accepted turn-status and trigger.kind:'task' on the obs TurnStart;
 *  - a queued task turn WAITS for an in-flight user turn (users never starved);
 *  - a user turn-request supersedes a running task turn (cancelled, then the user
 *    turn completes);
 *  - an expired (expiresAt) task turn is dropped, not spoken;
 *  - two task turns FIFO.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createAssistantMessageEventStream,
  type AssistantMessageEventStream,
  type AssistantMessage,
} from '@earendil-works/pi-ai';
import { Bus, type BusMessage } from '../../core/bus.js';
import type { RosterEntry } from '../../core/hub.js';
import { Directory } from '../docks/directory.js';
import { MotionExecutor } from '../bodylink/motion.js';
import { RpcBroker } from './rpc.js';
import { SessionStore } from './store.js';
import { DockBrainSession, type SessionDeps } from './session.js';

const DOCK = 'auto-bot';

function phonePeer(): RosterEntry {
  return {
    role: 'device', id: 'phone-hw-1', dock: DOCK, component: 'phone',
    kind: 'dock-android-app', caps: ['voice', 'face', 'camera'],
    lastSeen: Date.now(), connectedAt: Date.now(), topics: ['agent'],
  };
}

function assistant(text: string, stopReason: AssistantMessage['stopReason'] = 'stop'): AssistantMessage {
  return {
    role: 'assistant', content: text ? [{ type: 'text', text }] : [],
    api: 'openai-completions', provider: 'test', model: 'faux',
    usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason, timestamp: Date.now(),
  };
}

/** A script that emits one full answer of `text`. */
function say(text: string) {
  return (s: AssistantMessageEventStream) => {
    s.push({ type: 'start', partial: assistant('') });
    s.push({ type: 'text_delta', contentIndex: 0, delta: text, partial: assistant(text) });
    s.push({ type: 'done', reason: 'stop', message: assistant(text) });
    s.end();
  };
}

/** A script that blocks until `release` resolves, then answers `text` — unless aborted. */
function sayAfter(text: string, gate: Promise<void>) {
  return (s: AssistantMessageEventStream, signal?: AbortSignal) => {
    s.push({ type: 'start', partial: assistant('') });
    void gate.then(() => {
      if (signal?.aborted) { s.push({ type: 'done', reason: 'stop', message: assistant('') }); s.end(); return; }
      s.push({ type: 'text_delta', contentIndex: 0, delta: text, partial: assistant(text) });
      s.push({ type: 'done', reason: 'stop', message: assistant(text) });
      s.end();
    });
    signal?.addEventListener('abort', () => { s.push({ type: 'done', reason: 'stop', message: assistant('') }); s.end(); });
  };
}

type Script = (stream: AssistantMessageEventStream, signal?: AbortSignal) => void;

function makeSession(scripts: Script[], config: Record<string, unknown> = {}) {
  const bus = new Bus();
  const roster = [phonePeer()];
  const directory = new Directory(() => roster, join(tmpdir(), `dir-${Math.random()}.json`));
  const motion = new MotionExecutor(bus, directory);
  const rpc = new RpcBroker(bus, directory);
  const store = new SessionStore(mkdtempSync(join(tmpdir(), 'auto-test-')));
  const frames: BusMessage[] = [];
  bus.on('agent', (m) => { if (m.source === 'station') frames.push(m); });
  const obs: BusMessage[] = [];
  bus.on('obs', (m) => obs.push(m));

  const cfg = { brainModel: 'openai-compatible/faux@http://test', brainTaskSettleMs: 0, ...config };
  const deps: SessionDeps = {
    bus, directory, rpc, motion, store,
    getFaces: () => undefined,
    config: (k) => cfg[k as keyof typeof cfg],
    streamFn: ((_m: unknown, _ctx: unknown, options?: { signal?: AbortSignal }) => {
      const stream = createAssistantMessageEventStream();
      const script = scripts.shift();
      if (!script) throw new Error('script exhausted');
      script(stream, options?.signal);
      return stream;
    }) as never,
  };
  return { session: new DockBrainSession(DOCK, deps), frames, obs };
}

const speakText = (frames: BusMessage[]) =>
  frames.filter((f) => f.kind === 'speak').map((f) => (f.payload as { text: string }).text);
const accepted = (frames: BusMessage[]) =>
  frames.filter((f) => f.kind === 'turn-status' && (f.payload as { state: string }).state === 'accepted')
    .map((f) => f.payload as { turnId: string; autonomous?: boolean });
const statuses = (frames: BusMessage[]) =>
  frames.filter((f) => f.kind === 'turn-status').map((f) => (f.payload as { state: string }).state);

const tick = () => new Promise((r) => setTimeout(r, 20));

test('enqueueAutonomousTurn speaks unprompted with autonomous:true + obs kind task', async () => {
  const { session, frames, obs } = makeSession([say('You picked up your phone.')]);

  session.enqueueAutonomousTurn({
    turnId: 'auto-1',
    trigger: { kind: 'task', text: '[task m1 fired] you picked up your phone' },
  });
  // drain runs async; wait for the speak
  for (let i = 0; i < 50 && speakText(frames).length === 0; i++) await tick();

  assert.deepEqual(speakText(frames), ['You picked up your phone.']);
  const acc = accepted(frames);
  assert.equal(acc.length, 1);
  assert.equal(acc[0]!.turnId, 'auto-1');
  assert.equal(acc[0]!.autonomous, true);

  // obs TurnStart carries trigger.kind:'task' (event name is payload.kind; detail under .data)
  const turnStart = obs.find((m) => (m.payload as { kind?: string }).kind === 'TurnStart');
  assert.ok(turnStart, 'a TurnStart obs event was emitted');
  assert.equal(
    (turnStart!.payload as { data: { trigger: { kind: string } } }).data.trigger.kind,
    'task',
  );
});

test('a queued task turn waits for an in-flight USER turn (user not starved)', async () => {
  let releaseUser!: () => void;
  const userGate = new Promise<void>((r) => { releaseUser = r; });
  // user turn blocks; then the task turn runs after it
  const { session, frames } = makeSession([sayAfter('User reply.', userGate), say('Task reply.')]);

  const userTurn = session.handleTurnRequest({ turnId: 'u1', trigger: { kind: 'user', text: 'hi' } });
  await tick(); // user turn is now in flight, parked on the gate

  // inject a task turn while the user turn runs
  session.enqueueAutonomousTurn({ turnId: 'auto-1', trigger: { kind: 'task', text: 'task fired' } });
  await tick();
  // nothing spoken yet — the drain loop is parked on the in-flight user turn
  assert.deepEqual(speakText(frames), []);

  releaseUser();
  await userTurn;
  for (let i = 0; i < 50 && speakText(frames).length < 2; i++) await tick();

  // user spoke first, then the task — never starved
  assert.deepEqual(speakText(frames), ['User reply.', 'Task reply.']);
});

test('a user turn-request supersedes a running TASK turn', async () => {
  let releaseTask!: () => void;
  const taskGate = new Promise<void>((r) => { releaseTask = r; });
  const { session, frames } = makeSession([sayAfter('half...', taskGate), say('User wins.')]);

  session.enqueueAutonomousTurn({ turnId: 'auto-1', trigger: { kind: 'task', text: 'task fired' } });
  await tick(); // task turn in flight, parked on its gate

  // user speaks → supersede the running task turn
  const userTurn = session.handleTurnRequest({ turnId: 'u1', trigger: { kind: 'user', text: 'stop, listen' } });
  releaseTask(); // the aborted task stream resolves
  await userTurn;
  for (let i = 0; i < 50 && !speakText(frames).includes('User wins.'); i++) await tick();

  assert.ok(statuses(frames).includes('cancelled'), 'task turn was cancelled');
  assert.ok(speakText(frames).includes('User wins.'), 'user turn completed');
});

test('an expired task turn is dropped, not spoken', async () => {
  const { session, frames } = makeSession([]); // no script — nothing should run
  session.enqueueAutonomousTurn({
    turnId: 'auto-stale',
    trigger: { kind: 'task', text: 'old news' },
    expiresAt: Date.now() - 1, // already expired
  });
  for (let i = 0; i < 10; i++) await tick();
  assert.deepEqual(speakText(frames), []);
  assert.deepEqual(accepted(frames), []);
});

test('two task turns FIFO', async () => {
  const { session, frames } = makeSession([say('first'), say('second')]);
  session.enqueueAutonomousTurn({ turnId: 'a1', trigger: { kind: 'task', text: 'one' } });
  session.enqueueAutonomousTurn({ turnId: 'a2', trigger: { kind: 'task', text: 'two' } });
  for (let i = 0; i < 50 && speakText(frames).length < 2; i++) await tick();
  assert.deepEqual(speakText(frames), ['first', 'second']);
});

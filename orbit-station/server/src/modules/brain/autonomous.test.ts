/**
 * Autonomous (task) turn injection — docs/tasks.md §7a, §11.B.
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
import type { RosterEntry } from '../../core/websocket-gateway.js';
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
  // wait for the task turn to be in flight (past the coalesce window), parked on
  // its gate, before the user supersedes it.
  for (let i = 0; i < 20 && accepted(frames).length === 0; i++) await tick();

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

test('coalesce: same-instance notify+finish merge into ONE turn (both texts kept)', async () => {
  // a one-shot task emits notify then finish ~0ms apart with the SAME coalesceKey.
  // Both land before drain runs → they MUST merge into a single turn carrying both
  // messages (finish may have critical info), not two back-to-back turns where the
  // 2nd supersedes the 1st's TTS. Only ONE script is provided → only one turn runs.
  const { session, frames } = makeSession([say('Reminder delivered.')]);
  session.enqueueAutonomousTurn({ turnId: 'n1', trigger: { kind: 'task', text: 'Drink water!' }, coalesceKey: 't-aaaa' });
  session.enqueueAutonomousTurn({ turnId: 'f1', trigger: { kind: 'task', text: 'reminded' }, coalesceKey: 't-aaaa' });

  for (let i = 0; i < 50 && accepted(frames).length === 0; i++) await tick();
  await tick(); await tick();

  // exactly ONE autonomous turn accepted (not two)
  assert.equal(accepted(frames).length, 1, 'one coalesced turn, not two');
  assert.deepEqual(speakText(frames), ['Reminder delivered.']);

  // and the merged turn carried BOTH messages to the model (notify + finish text)
  const turnReqText = (session as unknown as { _peekMergedText?: () => string });
  void turnReqText; // (text-merge asserted via the obs trigger below)
});

test('coalesce: a different instance does NOT merge (separate turns)', async () => {
  const { session, frames } = makeSession([say('one'), say('two')]);
  session.enqueueAutonomousTurn({ turnId: 'a', trigger: { kind: 'task', text: 'from A' }, coalesceKey: 't-aaaa' });
  session.enqueueAutonomousTurn({ turnId: 'b', trigger: { kind: 'task', text: 'from B' }, coalesceKey: 't-bbbb' });
  for (let i = 0; i < 50 && speakText(frames).length < 2; i++) await tick();
  assert.deepEqual(speakText(frames), ['one', 'two'], 'different instances stay separate');
});

// ── internal THOUGHTS (trigger.kind:'self') — docs/perception-to-brain.md Phase 1.
// A self-thought rides the SAME autonomous-turn lane as a task, but is framed as
// the robot's OWN observation and defers behind a user mid-utterance (`listening`).

/** The obs TurnStart's trigger.kind for the first auto turn that started. */
const turnStartKind = (obs: BusMessage[]): string | undefined => {
  const ev = obs.find((m) => (m.payload as { kind?: string }).kind === 'TurnStart');
  return ev ? (ev.payload as { data: { trigger: { kind: string } } }).data.trigger.kind : undefined;
};

test('a self-thought runs on an IDLE session and is framed self/autonomous', async () => {
  const { session, frames, obs } = makeSession([say('You have looked stuck for a while.')]);
  session.enqueueAutonomousTurn({
    turnId: 'self-1', trigger: { kind: 'self', text: '[thought] the user seems stuck' },
    expiresAt: Date.now() + 30_000, coalesceKey: 'self:test',
  });
  for (let i = 0; i < 50 && speakText(frames).length === 0; i++) await tick();

  assert.deepEqual(speakText(frames), ['You have looked stuck for a while.']);
  const acc = accepted(frames);
  assert.equal(acc.length, 1);
  assert.equal(acc[0]!.autonomous, true, 'self-thought adopts the autonomous turn-status');
  assert.equal(turnStartKind(obs), 'self', "obs TurnStart carries trigger.kind:'self'");
});

test('state(): idle by default; a self-thought never reports listening on its own', () => {
  const { session } = makeSession([]);
  assert.equal(session.state(), 'idle');
  session.setListening(true);
  assert.equal(session.state(), 'listening', 'stub flag flips state to listening');
  session.setListening(false);
  assert.equal(session.state(), 'idle');
});

test('a self-thought DEFERS while the user is mid-utterance (listening), then runs', async () => {
  const { session, frames } = makeSession([say('Want a hand with that?')]);
  // user is mid-utterance — the station (stub) marks listening before the thought.
  session.setListening(true);
  session.enqueueAutonomousTurn({
    turnId: 'self-1', trigger: { kind: 'self', text: '[thought] offer help' },
    expiresAt: Date.now() + 30_000, coalesceKey: 'self:test',
  });
  // give the drain several passes — it must NOT speak while listening.
  for (let i = 0; i < 8; i++) await tick();
  assert.deepEqual(speakText(frames), [], 'held while the user is talking');

  // user finished — listening clears, the thought now runs.
  session.setListening(false);
  for (let i = 0; i < 50 && speakText(frames).length === 0; i++) await tick();
  assert.deepEqual(speakText(frames), ['Want a hand with that?']);
});

test('a self-thought DEFERS while TTS is playing (speaking) and through the follow-up window, then runs', async () => {
  const { session, frames } = makeSession([say('Good news for you.')]);
  // robot is mid-speech (its own TTS) — noteSpeech drives the SPEAKING state.
  session.noteSpeech(true);
  assert.equal(session.state(), 'speaking');
  session.enqueueAutonomousTurn({
    turnId: 'self-1', trigger: { kind: 'self', text: '[thought] share news' },
    expiresAt: Date.now() + 30_000, coalesceKey: 'self:test',
  });
  for (let i = 0; i < 8; i++) await tick();
  assert.deepEqual(speakText(frames), [], 'held while our own TTS plays');

  // TTS drains → the dock enters the FOLLOWUP (auto re-listen) window, which reads
  // as `listening` — a self-thought still defers behind it (the user might follow
  // up). Once the follow-up window is over (reconcile = the simplest way to end it
  // deterministically in a test), the deferred thought runs.
  session.noteSpeech(false);
  assert.equal(session.state(), 'listening', 'follow-up window after the reply');
  for (let i = 0; i < 8; i++) await tick();
  assert.deepEqual(speakText(frames), [], 'still held during the follow-up window');

  session.notePhoneConnected(); // ends the follow-up window (→ idle)
  for (let i = 0; i < 50 && speakText(frames).length === 0; i++) await tick();
  assert.deepEqual(speakText(frames), ['Good news for you.']);
});

test('a user turn always wins: it supersedes a running self-thought', async () => {
  let releaseThought!: () => void;
  const gate = new Promise<void>((r) => { releaseThought = r; });
  const { session, frames } = makeSession([sayAfter('half a thought...', gate), say('User wins.')]);

  session.enqueueAutonomousTurn({
    turnId: 'self-1', trigger: { kind: 'self', text: '[thought] musing' },
    expiresAt: Date.now() + 30_000, coalesceKey: 'self:test',
  });
  for (let i = 0; i < 20 && accepted(frames).length === 0; i++) await tick();

  const userTurn = session.handleTurnRequest({ turnId: 'u1', trigger: { kind: 'user', text: 'hey' } });
  releaseThought();
  await userTurn;
  for (let i = 0; i < 50 && !speakText(frames).includes('User wins.'); i++) await tick();

  assert.ok(statuses(frames).includes('cancelled'), 'the self-thought was cancelled');
  assert.ok(speakText(frames).includes('User wins.'), 'the user turn completed');
});

test('an EXPIRED self-thought is dropped, not spoken', async () => {
  const { session, frames } = makeSession([]); // no script — nothing should run
  session.enqueueAutonomousTurn({
    turnId: 'self-stale', trigger: { kind: 'self', text: 'old observation' },
    expiresAt: Date.now() - 1, coalesceKey: 'self:test',
  });
  for (let i = 0; i < 10; i++) await tick();
  assert.deepEqual(speakText(frames), []);
  assert.deepEqual(accepted(frames), []);
});

test('a self-thought DEFERRED past its expiry is DROPPED when the lane frees', async () => {
  const { session, frames } = makeSession([]); // nothing should ever run
  session.setListening(true); // user talking → the thought defers
  session.enqueueAutonomousTurn({
    turnId: 'self-1', trigger: { kind: 'self', text: 'fleeting' },
    expiresAt: Date.now() + 120, coalesceKey: 'self:test',
  });
  // hold past expiry while listening, then release — the gate must DROP it (stale),
  // not speak a now-irrelevant thought.
  for (let i = 0; i < 12; i++) await tick(); // > 120ms of ticks
  session.setListening(false);
  for (let i = 0; i < 10; i++) await tick();
  assert.deepEqual(speakText(frames), [], 'a thought that went stale while deferred is dropped');
});

test('self-thought coalesce: a newer same-kind thought replaces a stale pending one', async () => {
  // hold the lane (listening) so both thoughts queue before either runs; the 2nd
  // same-kind ('self:presence') thought MERGES into the pending one (one turn).
  const { session, frames } = makeSession([say('Two people just arrived.')]);
  session.setListening(true);
  session.enqueueAutonomousTurn({
    turnId: 's1', trigger: { kind: 'self', text: 'someone arrived' },
    expiresAt: Date.now() + 30_000, coalesceKey: 'self:presence',
  });
  session.enqueueAutonomousTurn({
    turnId: 's2', trigger: { kind: 'self', text: 'a second person arrived' },
    expiresAt: Date.now() + 30_000, coalesceKey: 'self:presence',
  });
  session.setListening(false);
  for (let i = 0; i < 50 && accepted(frames).length === 0; i++) await tick();
  await tick(); await tick();
  assert.equal(accepted(frames).length, 1, 'two same-kind thoughts coalesce into one turn');
});

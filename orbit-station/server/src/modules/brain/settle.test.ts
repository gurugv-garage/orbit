/**
 * onSettled — the WI-1 settle hook the busy-queue drain hangs off
 * (docs/findings/2026-07-13-busy-queue-black-hole.md Addendum 3). The contract
 * under test: the hook fires exactly when the dock's speech lane goes QUIET —
 * after the TTS tail drains (spoken turns, any trigger kind), or at completion
 * of a turn that never spoke (which must also un-wedge 'thinking') — and NEVER
 * under a cancelled turn or while a newer turn is in flight.
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

const DOCK = 'settle-bot';

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

type Script = (stream: AssistantMessageEventStream, signal?: AbortSignal) => void;

/** A script that speaks `text` and completes normally. */
const speaks = (text: string): Script => (s) => {
  const done = assistant(text);
  s.push({ type: 'start', partial: assistant('') });
  s.push({ type: 'text_delta', contentIndex: 0, delta: text, partial: done });
  s.push({ type: 'done', reason: 'stop', message: done });
  s.end(done);
};

/** A script that completes normally with NO text at all (a silent turn). */
const silent = (): Script => (s) => {
  const done = assistant('');
  s.push({ type: 'start', partial: assistant('') });
  s.push({ type: 'done', reason: 'stop', message: done });
  s.end(done);
};

/** A script that stalls until aborted. */
const stalls = (onArmed?: () => void): Script => (s, signal) => {
  signal?.addEventListener('abort', () => {
    const err = assistant('', 'aborted');
    s.push({ type: 'error', reason: 'aborted', error: err });
    s.end(err);
  });
  onArmed?.();
};

function makeSession(scripts: Script[], config: Record<string, unknown> = {}) {
  const bus = new Bus();
  const roster = [phonePeer()];
  const directory = new Directory(() => roster, join(tmpdir(), `dir-${Math.random()}.json`));
  const motion = new MotionExecutor(bus, directory);
  const rpc = new RpcBroker(bus, directory);
  const store = new SessionStore(mkdtempSync(join(tmpdir(), 'brain-settle-')));
  const frames: BusMessage[] = [];
  bus.on('agent', (m) => { if (m.source === 'station') frames.push(m); });
  const settles: number[] = [];
  const cfg = { brainModel: 'openai-compatible/faux@http://test', brainTaskSettleMs: 0, ...config };
  const deps: SessionDeps = {
    bus, directory, rpc, motion, store,
    getFaces: () => undefined,
    config: (k) => cfg[k as keyof typeof cfg],
    onSettled: () => settles.push(Date.now()),
    streamFn: ((_model: unknown, _ctx: unknown, options?: { signal?: AbortSignal }) => {
      const stream = createAssistantMessageEventStream();
      const script = scripts.shift();
      if (!script) throw new Error('script exhausted');
      script(stream, options?.signal);
      return stream;
    }) as never,
  };
  return { session: new DockBrainSession(DOCK, deps), settles, frames };
}

const nextTick = () => new Promise<void>((r) => setImmediate(() => setImmediate(r)));

test('spoken turn: settle fires only when the TTS tail drains, not at loop end', async () => {
  const { session, settles } = makeSession([speaks('Hello there. ')]);
  await session.handleTurnRequest({ turnId: 't1', trigger: { kind: 'user', text: 'hi' } });
  await nextTick();
  assert.equal(settles.length, 0, 'no settle at loop end — the phone is still speaking');
  session.noteSpeech(true);   // phone TTS started
  assert.equal(settles.length, 0);
  session.noteSpeech(false);  // TTS tail drained → the TurnSettled moment
  assert.equal(settles.length, 1, 'settle fires exactly once at tts-end');
  assert.equal(session.conversation().mode, 'followup');
});

test('silent turn: settle fires at completion AND un-wedges thinking → idle', async () => {
  const { session, settles } = makeSession([silent()]);
  await session.handleTurnRequest({ turnId: 't1', trigger: { kind: 'user', text: 'ponder' } });
  await nextTick(); // the silent-turn settle is deferred one tick
  assert.equal(settles.length, 1, 'settle fires for a turn that never spoke');
  // the old behavior left 'thinking' wedged until the 60s THINK_MAX prune,
  // silently gating every wake meanwhile.
  assert.equal(session.conversation().mode, 'idle');
});

test('cancelled turn: no settle (a tap-interrupt means the user speaks next)', async () => {
  let armed: (() => void) | undefined;
  const { session, settles } = makeSession([stalls(() => armed?.())]);
  const turn = session.handleTurnRequest({ turnId: 't1', trigger: { kind: 'user', text: 'go' } });
  await new Promise<void>((r) => { armed = r; });
  session.cancel('t1');
  await turn;
  await nextTick();
  assert.equal(settles.length, 0, 'cancelled turns never settle');
});

test('late tts-end under a NEWER running turn does not settle', async () => {
  let armed: (() => void) | undefined;
  const { session, settles } = makeSession([speaks('First reply. '), stalls(() => armed?.())]);
  await session.handleTurnRequest({ turnId: 't1', trigger: { kind: 'user', text: 'one' } });
  session.noteSpeech(true); // turn 1's TTS starts
  const turn2 = session.handleTurnRequest({ turnId: 't2', trigger: { kind: 'user', text: 'two' } });
  await new Promise<void>((r) => { armed = r; });
  session.noteSpeech(false); // turn 1's tts-end lands while turn 2 is mid-flight
  assert.equal(settles.length, 0, 'a settle here would let a drained turn supersede the live one');
  session.cancel();
  await turn2;
});

test('autonomous (task/self) silent turn settles too — the ghost class is covered', async () => {
  const { session, settles } = makeSession([silent()]);
  session.enqueueAutonomousTurn({ turnId: 'auto-1', trigger: { kind: 'self', text: '[thought] nothing to say' } });
  // the auto queue drains on a 60ms coalesce timer, then the turn runs
  await new Promise((r) => setTimeout(r, 300));
  await nextTick();
  assert.equal(settles.length, 1, 'the autonomous lane settles like any other turn kind');
});

test('superseded turn does not settle under its replacement', async () => {
  let armed: (() => void) | undefined;
  const { session, settles } = makeSession([stalls(() => armed?.()), speaks('Second wins. ')]);
  const turn1 = session.handleTurnRequest({ turnId: 't1', trigger: { kind: 'user', text: 'one' } });
  await new Promise<void>((r) => { armed = r; });
  const turn2 = session.handleTurnRequest({ turnId: 't2', trigger: { kind: 'user', text: 'two' } }); // supersedes t1
  await Promise.all([turn1, turn2]);
  await nextTick();
  assert.equal(settles.length, 0, 'neither the aborted turn nor the still-speaking one settles yet');
  session.noteSpeech(true);
  session.noteSpeech(false);
  assert.equal(settles.length, 1, 'the surviving turn settles normally at its tts-end');
});

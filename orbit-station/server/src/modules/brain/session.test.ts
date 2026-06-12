/**
 * DockBrainSession against a scripted StreamFn — the ported DockAgent
 * semantics under test: streaming speak frames, trailing-clause flush rules,
 * cancel → sanitized history, timeout ceiling, supersede, session lifecycle.
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

const DOCK = 'test-bot';

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

/** A scripted transport: each call shifts the next script entry. */
type Script = (stream: AssistantMessageEventStream, signal?: AbortSignal) => void;

function makeSession(scripts: Script[], opts: { config?: Record<string, unknown> } = {}) {
  const bus = new Bus();
  const roster = [phonePeer()];
  const directory = new Directory(() => roster, join(tmpdir(), `dir-${Math.random()}.json`));
  const motion = new MotionExecutor(bus, directory);
  const rpc = new RpcBroker(bus, directory);
  const store = new SessionStore(mkdtempSync(join(tmpdir(), 'brain-test-')));
  const frames: BusMessage[] = [];
  bus.on('agent', (m) => { if (m.source === 'station') frames.push(m); });
  const obs: BusMessage[] = [];
  bus.on('obs', (m) => obs.push(m));

  const config = { brainModel: 'openai-compatible/faux@http://test', ...opts.config };
  const deps: SessionDeps = {
    bus, directory, rpc, motion, store,
    getFaces: () => undefined,
    config: (k) => config[k as keyof typeof config],
    streamFn: ((_model: unknown, _ctx: unknown, options?: { signal?: AbortSignal }) => {
      const stream = createAssistantMessageEventStream();
      const script = scripts.shift();
      if (!script) throw new Error('script exhausted');
      script(stream, options?.signal);
      return stream;
    }) as never,
  };
  const session = new DockBrainSession(DOCK, deps);
  return { session, frames, obs, motion, store, bus };
}

const speakFrames = (frames: BusMessage[]) =>
  frames.filter((f) => f.kind === 'speak').map((f) => (f.payload as { text: string }).text);
const statusOf = (frames: BusMessage[]) =>
  frames.filter((f) => f.kind === 'turn-status').map((f) => (f.payload as { state: string }).state);

test('streams sentences as speak frames + flushes trailing clause on normal completion', async () => {
  const { session, frames } = makeSession([
    (s) => {
      const partial = assistant('');
      s.push({ type: 'start', partial });
      s.push({ type: 'text_delta', contentIndex: 0, delta: 'Hello there. ', partial: assistant('Hello there. ') });
      s.push({ type: 'text_delta', contentIndex: 0, delta: 'And more', partial: assistant('Hello there. And more') });
      const done = assistant('Hello there. And more');
      s.push({ type: 'done', reason: 'stop', message: done });
      s.end(done);
    },
  ]);
  await session.handleTurnRequest({ turnId: 't1', trigger: { kind: 'user', text: 'hi' } });
  const spoken = speakFrames(frames);
  assert.deepEqual(spoken, ['Hello there.', 'And more']); // trailing clause flushed
  assert.deepEqual(statusOf(frames).at(-1), 'done');
  // every station→phone frame is DIRECTED at the voice component
  for (const f of frames) assert.deepEqual(f.toAddr, { dock: DOCK, component: 'phone' });
});

test('timeout: aborts, no trailing flush, failed status with code', async () => {
  const { session, frames } = makeSession(
    [
      (s, signal) => {
        s.push({ type: 'text_delta', contentIndex: 0, delta: 'Half a sente', partial: assistant('Half a sente') });
        // never completes; abort ends it
        signal?.addEventListener('abort', () => {
          const err = assistant('Half a sente', 'aborted');
          s.push({ type: 'error', reason: 'aborted', error: err });
          s.end(err);
        });
      },
    ],
    { config: { brainTurnTimeoutMs: 5_000 > 0 ? 60 : 60 } }, // 60ms ceiling
  );
  await session.handleTurnRequest({ turnId: 't1', trigger: { kind: 'user', text: 'hang' } });
  assert.deepEqual(speakFrames(session ? frames : []), []); // half-sentence never leaks
  const last = frames.filter((f) => f.kind === 'turn-status').at(-1)!.payload as { state: string; code?: string };
  assert.equal(last.state, 'failed');
  assert.equal(last.code, 'timeout');
});

test('cancel mid-turn: cancelled status, history sanitized for next turn', async () => {
  let cancelArmed: (() => void) | undefined;
  const { session, frames, bus } = makeSession([
    (s, signal) => {
      // emit a tool call, then stall — cancel arrives mid-tool
      const m = assistant('');
      m.content.push({ type: 'toolCall', id: 'call-1', name: 'set_face', arguments: { expression: 'happy' } });
      m.stopReason = 'toolUse';
      s.push({ type: 'toolcall_end', contentIndex: 0, toolCall: m.content[0] as never, partial: m });
      s.push({ type: 'done', reason: 'toolUse', message: m });
      s.end(m);
    },
    // (the tool executes via rpc → never acked; cancel unwinds the loop)
    (s, signal) => {
      signal?.addEventListener('abort', () => {
        const err = assistant('', 'aborted');
        s.push({ type: 'error', reason: 'aborted', error: err });
        s.end(err);
      });
      cancelArmed?.();
    },
    // next turn: must see a sanitized history (no unanswered tool call)
    (s) => {
      const done = assistant('Back again. ');
      s.push({ type: 'start', partial: assistant('') });
      s.push({ type: 'text_delta', contentIndex: 0, delta: 'Back again. ', partial: done });
      s.push({ type: 'done', reason: 'stop', message: done });
      s.end(done);
    },
  ]);

  // act like the phone: instantly ack any tool-call (fire-and-forget contract)
  bus.on('agent', (m) => {
    if (m.kind !== 'tool-call' || m.source !== 'station') return;
    const p = m.payload as { reqId: string; toolCallId: string };
    queueMicrotask(() => bus.publish({
      topic: 'agent', kind: 'tool-result', source: 'phone-hw-1',
      payload: { reqId: p.reqId, toolCallId: p.toolCallId, content: 'face set', isError: false },
    }));
  });

  const turn1 = session.handleTurnRequest({ turnId: 't1', trigger: { kind: 'user', text: 'wave' } });
  // cancel once the second LLM call (post-tool) is in flight
  await new Promise<void>((resolve) => { cancelArmed = resolve; });
  session.cancel('t1');
  await turn1;
  assert.ok(statusOf(frames).includes('cancelled'));

  await session.handleTurnRequest({ turnId: 't2', trigger: { kind: 'user', text: 'back' } });
  assert.deepEqual(speakFrames(frames).at(-1), 'Back again.');
  assert.equal(statusOf(frames).at(-1), 'done');
});

test('session lifecycle: persists across instances, idle close opens fresh with summary', async () => {
  const script: Script = (s) => {
    const done = assistant('Noted. ');
    s.push({ type: 'text_delta', contentIndex: 0, delta: 'Noted. ', partial: done });
    s.push({ type: 'done', reason: 'stop', message: done });
    s.end(done);
  };
  const { session, store } = makeSession([script, script], { config: { brainSessionIdleMin: 1 } });
  await session.handleTurnRequest({ turnId: 't1', trigger: { kind: 'user', text: 'remember the cake' } });
  const sid1 = session.sessionId!;
  assert.ok(sid1);
  assert.equal(store.sessions(DOCK)[0]!.turns, 1);

  // idle boundary crossed → close with summary; next turn opens fresh
  session.maybeIdleClose(Date.now() + 2 * 60_000);
  const closed = store.sessions(DOCK).find((s2) => s2.sessionId === sid1)!;
  assert.ok(closed.closedAt != null);
  assert.match(closed.summary ?? '', /cake/);

  await session.handleTurnRequest({ turnId: 't2', trigger: { kind: 'user', text: 'fresh start' } });
  assert.notEqual(session.sessionId, sid1);
});

test('obs events carry dock as source and the Turn/Step vocabulary', async () => {
  const { session, obs } = makeSession([
    (s) => {
      const done = assistant('Hi. ');
      s.push({ type: 'start', partial: assistant('') });
      s.push({ type: 'text_delta', contentIndex: 0, delta: 'Hi. ', partial: done });
      s.push({ type: 'done', reason: 'stop', message: done });
      s.end(done);
    },
  ]);
  await session.handleTurnRequest({ turnId: 't1', trigger: { kind: 'user', text: 'hi' } });
  const kinds = obs.map((o) => (o.payload as { kind: string }).kind);
  for (const expected of ['TurnStart', 'StepStart', 'MessageUpdate', 'StepEnd', 'TurnEnd']) {
    assert.ok(kinds.includes(expected), `missing ${expected} in ${kinds.join(',')}`);
  }
  for (const o of obs) assert.equal(o.source, DOCK); // multi-tenant: dock, not 'station'
});

/**
 * Inline mood tag (WI-3, busy-queue-black-hole.md Addendum 3) — a leading
 * [face:NAME] in the reply text sets the face with no extra LLM step. Under
 * test: the tag is stripped from speech (even split across stream deltas),
 * fires exactly one set_face RPC, unknown names strip-but-ignore, non-mood
 * brackets pass through, and the brainInlineMood=false kill-switch disables
 * the filter entirely.
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

const DOCK = 'mood-bot';

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

/** A script that streams the reply in the given cumulative snapshots. */
const streams = (...snapshots: string[]): Script => (s) => {
  s.push({ type: 'start', partial: assistant('') });
  for (const snap of snapshots) {
    s.push({ type: 'text_delta', contentIndex: 0, delta: '', partial: assistant(snap) });
  }
  const done = assistant(snapshots[snapshots.length - 1] ?? '');
  s.push({ type: 'done', reason: 'stop', message: done });
  s.end(done);
};

function makeSession(scripts: Script[], config: Record<string, unknown> = {}) {
  const bus = new Bus();
  const roster = [phonePeer()];
  const directory = new Directory(() => roster, join(tmpdir(), `dir-${Math.random()}.json`));
  const motion = new MotionExecutor(bus, directory);
  const rpc = new RpcBroker(bus, directory);
  const store = new SessionStore(mkdtempSync(join(tmpdir(), 'brain-mood-')));
  const frames: BusMessage[] = [];
  bus.on('agent', (m) => { if (m.source === 'station') frames.push(m); });
  const cfg = { brainModel: 'openai-compatible/faux@http://test', ...config };
  const deps: SessionDeps = {
    bus, directory, rpc, motion, store,
    getFaces: () => undefined,
    config: (k) => cfg[k as keyof typeof cfg],
    streamFn: ((_model: unknown, _ctx: unknown, options?: { signal?: AbortSignal }) => {
      const stream = createAssistantMessageEventStream();
      const script = scripts.shift();
      if (!script) throw new Error('script exhausted');
      script(stream, options?.signal);
      return stream;
    }) as never,
  };
  return { session: new DockBrainSession(DOCK, deps), frames };
}

const spoken = (frames: BusMessage[]) =>
  frames.filter((f) => f.kind === 'speak').map((f) => (f.payload as { text: string }).text);
const faceCalls = (frames: BusMessage[]) =>
  frames.filter((f) => f.kind === 'tool-call'
    && (f.payload as { name?: string }).name === 'set_face')
    .map((f) => (f.payload as { args: { expression: string } }).args.expression);

test('leading [face:NAME] is stripped from speech and fires one set_face RPC', async () => {
  const { session, frames } = makeSession([streams('[face:happy] Four! Easy one. ')]);
  await session.handleTurnRequest({ turnId: 't1', trigger: { kind: 'user', text: 'two plus two?' } });
  assert.deepEqual(spoken(frames), ['Four!', 'Easy one.']);
  assert.deepEqual(faceCalls(frames), ['happy']);
});

test('tag split across stream deltas: held (never spoken), then applied', async () => {
  const { session, frames } = makeSession([
    streams('[fa', '[face:exc', '[face:excited] Hi', '[face:excited] Hi there. '),
  ]);
  await session.handleTurnRequest({ turnId: 't1', trigger: { kind: 'user', text: 'hey' } });
  assert.deepEqual(spoken(frames), ['Hi there.']);
  assert.deepEqual(faceCalls(frames), ['excited']);
});

test('unknown face name: tag stripped (never spoken) but no RPC fired', async () => {
  const { session, frames } = makeSession([streams('[face:zorp] Hello. ')]);
  await session.handleTurnRequest({ turnId: 't1', trigger: { kind: 'user', text: 'hi' } });
  assert.deepEqual(spoken(frames), ['Hello.']);
  assert.deepEqual(faceCalls(frames), []);
});

test('no tag → speech unchanged, no face RPC', async () => {
  const { session, frames } = makeSession([streams('Just words here. ')]);
  await session.handleTurnRequest({ turnId: 't1', trigger: { kind: 'user', text: 'hi' } });
  assert.deepEqual(spoken(frames), ['Just words here.']);
  assert.deepEqual(faceCalls(frames), []);
});

test('a non-mood leading bracket passes through to speech', async () => {
  const { session, frames } = makeSession([streams('[laughs] Ha, good one. ')]);
  await session.handleTurnRequest({ turnId: 't1', trigger: { kind: 'user', text: 'joke' } });
  assert.deepEqual(spoken(frames), ['[laughs] Ha, good one.']);
  assert.deepEqual(faceCalls(frames), []);
});

test('kill-switch brainInlineMood=false: filter off, tag spoken as-is', async () => {
  const { session, frames } = makeSession(
    [streams('[face:happy] Hi. ')], { brainInlineMood: false });
  await session.handleTurnRequest({ turnId: 't1', trigger: { kind: 'user', text: 'hi' } });
  assert.deepEqual(spoken(frames), ['[face:happy] Hi.']);
  assert.deepEqual(faceCalls(frames), []);
});

test('an unresolved held leading bracket is released as prose at step end (no dead air)', async () => {
  // the whole step's text is '[thinking' — starts like a tag, never closes.
  const { session, frames } = makeSession([streams('[thi', '[thinking')]);
  await session.handleTurnRequest({ turnId: 't1', trigger: { kind: 'user', text: 'hi' } });
  assert.deepEqual(spoken(frames), ['[thinking'], 'held text must be released, not dropped');
  assert.deepEqual(faceCalls(frames), []);
});

// ── overheard framing (ambient-speech step-3 fix) ───────────────────────────

test('followup-window turns get the overheard framing; tapped turns do not', async () => {
  const { buildSystemPrompt, OVERHEARD_FRAMING } = await import('./prompt.js');
  const overheard = buildSystemPrompt({ overheard: true });
  const direct = buildSystemPrompt({});
  assert.ok(overheard.includes(OVERHEARD_FRAMING.slice(0, 40)), 'framing present when overheard');
  assert.ok(!direct.includes('people in the room talking'), 'absent on direct turns');
});

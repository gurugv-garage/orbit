/**
 * Cross-module INTEGRATION (E2E) tests for the perception→agent chains, backfilled
 * for Phases 2–4 (Phase-5's chain has its own gate-e2e.test.ts). These exercise the
 * real seams between modules — no mock of the component under test:
 *
 *  • GROUNDING (Phase 2): a real summary cached in a real PerceptionGroundingApi →
 *    the DockBrainSession injects it into the system prompt the LLM actually receives.
 *  • MEMORY (Phase 4): the real MemoryStore behind the real MemoryApi facade behind
 *    the real brain tools — a remember tool call then a recall_memory call round-trip
 *    through sqlite, including semantic-less (recency) recall with a fake embedder.
 *
 * Only the LLM transport + the dock peer are scripted.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import {
  createAssistantMessageEventStream, type AssistantMessageEventStream, type AssistantMessage,
} from '@earendil-works/pi-ai';
import { Bus } from '../../core/bus.js';
import type { RosterEntry } from '../../core/websocket-gateway.js';
import { Directory } from '../docks/directory.js';
import { MotionExecutor } from '../bodylink/motion.js';
import { RpcBroker } from './rpc.js';
import { SessionStore } from './store.js';
import { DockBrainSession, type SessionDeps } from './session.js';
import { stripTurnContext } from './prompt.js';
import { buildMemoryTools } from './tools.js';
import { newLatch, tap as tapLatch, decideAddressed, type AddressedLatch } from './addressed.js';
import { MemoryStore, type Embedder } from '../perception/memory/store.js';
import type { MemoryApi, PerceptionGroundingApi } from '../perception/index.js';

const DOCK = 'desk-1';
function phonePeer(): RosterEntry {
  return {
    role: 'device', id: 'phone-1', dock: DOCK, component: 'phone',
    kind: 'dock-android-app', caps: ['voice', 'face', 'camera'],
    lastSeen: Date.now(), connectedAt: Date.now(), topics: ['agent'],
  };
}
function assistant(text: string): AssistantMessage {
  return {
    role: 'assistant', content: text ? [{ type: 'text', text }] : [],
    api: 'openai-completions', provider: 'test', model: 'faux',
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: 'stop', timestamp: Date.now(),
  };
}
const tick = () => new Promise((r) => setTimeout(r, 30));

test('E2E grounding: a cached summary reaches the prompt the LLM receives (turn context)', async () => {
  const bus = new Bus();
  const directory = new Directory(() => [phonePeer()], join(tmpdir(), `dir-${Math.random()}.json`));
  const store = new SessionStore(mkdtempSync(join(tmpdir(), 'gnd-e2e-')));
  const motion = new MotionExecutor(bus, directory);

  // a REAL grounding facade with a cached summary for this dock.
  const grounding: PerceptionGroundingApi = {
    forDock: (dock) => dock === DOCK
      ? 'Perception — last summary (2 min ago, covering 14:30–14:35 IST): Guru has been debugging and sounded frustrated.'
      : undefined,
    forceCurrent: async () => ({ summary: '', window: { from: '', to: '' } }),
  };

  let seenSystemPrompt = '';
  let seenUserText = '';
  const cfg = { brainModel: 'openai-compatible/faux@http://test' } as Record<string, unknown>;
  const deps: SessionDeps = {
    bus, directory, rpc: new RpcBroker(bus, directory), motion, store,
    getFaces: () => undefined,
    getGrounding: () => grounding,
    config: (k) => cfg[k],
    // capture the system prompt the agent actually sends.
    streamFn: ((_m: unknown, ctx: any) => {
      seenSystemPrompt = ctx?.systemPrompt ?? ctx?.system ?? '';
      const lastUser = [...(ctx?.messages ?? [])].reverse().find((x: any) => x.role === 'user');
      seenUserText = Array.isArray(lastUser?.content)
        ? lastUser.content.map((c: any) => c.text ?? '').join('') : String(lastUser?.content ?? '');
      const s: AssistantMessageEventStream = createAssistantMessageEventStream();
      s.push({ type: 'start', partial: assistant('') });
      s.push({ type: 'text_delta', contentIndex: 0, delta: 'ok', partial: assistant('ok') });
      s.push({ type: 'done', reason: 'stop', message: assistant('ok') });
      s.end();
      return s;
    }) as never,
  };
  const session = new DockBrainSession(DOCK, deps);
  await session.handleTurnRequest({ turnId: 'u1', trigger: { kind: 'user', text: 'how am I doing?' } });
  for (let i = 0; i < 20 && !seenSystemPrompt; i++) await tick();

  // CACHE STABILITY v2: grounding rides the TURN CONTEXT on the user message
  // (the system prompt is static per session — prompt.ts). Same E2E guarantee:
  // the cached summary reaches what the LLM actually receives.
  assert.match(seenUserText, /Perception — last summary/);
  assert.match(seenUserText, /debugging and sounded frustrated/);
  assert.doesNotMatch(seenSystemPrompt, /Perception — last summary/, 'grounding must NOT churn the static system prompt');
});

test('E2E memory: remember then recall_memory round-trip through the real store', async () => {
  // real store + real facade + real tools.
  const fakeEmbed: Embedder = async () => null; // recency recall (no network)
  const memStore = new MemoryStore(new Database(':memory:'), fakeEmbed);
  const api: MemoryApi = {
    recall: (f) => memStore.recall(f),
    inspect: (id) => { const m = memStore.get(id); return m ? { memory: m, lineage: memStore.lineage(id) } : undefined; },
    remember: (m) => memStore.remember({ ...m, derivation: 'observed' }),
    update: (id, p) => memStore.revise(id, p),
    forget: (id) => memStore.forget(id),
    subjects: (d) => memStore.subjects(d),
    recent: (d, l) => memStore.recent(d, l),
    count: (d) => memStore.count(d),
  };
  const tools = new Map(buildMemoryTools(DOCK, () => api).map((t) => [t.name, t]));
  const text = (r: { content: readonly unknown[] }) => r.content.map((c) => (c as { text?: string }).text ?? '').join('');

  // 1) the agent remembers a fact (tool → facade → store)
  await tools.get('remember')!.execute('c1', { claim: 'prefers tea', subject: 'guru', type: 'preference' } as never);
  assert.equal(memStore.count(DOCK), 1, 'the memory landed in the real store');

  // 2) the agent recalls it back (store → facade → tool)
  const recall = await tools.get('recall_memory')!.execute('c2', { subject: 'guru' } as never);
  assert.match(text(recall), /prefers tea/);

  // 3) list_subjects sees it
  assert.match(text(await tools.get('list_subjects')!.execute('c3', {} as never)), /guru/);

  // 4) forget it (resolve the 8-char id the recall surfaced)
  const id = memStore.recent(DOCK, 1)[0]!.id;
  await tools.get('forget_memory')!.execute('c4', { id: id.slice(0, 8) } as never);
  assert.equal(memStore.count(DOCK), 0, 'forget purged it from active recall');
});

test('E2E addressed (A1.2): a tapped final transcript becomes a user turn; an un-tapped one does not', async () => {
  const bus = new Bus();
  const directory = new Directory(() => [phonePeer()], join(tmpdir(), `dir-${Math.random()}.json`));
  const store = new SessionStore(mkdtempSync(join(tmpdir(), 'addr-e2e-')));
  const motion = new MotionExecutor(bus, directory);

  // capture the user text the LLM actually receives per turn.
  const seenTurns: string[] = [];
  const cfg = { brainModel: 'openai-compatible/faux@http://test' } as Record<string, unknown>;
  const deps: SessionDeps = {
    bus, directory, rpc: new RpcBroker(bus, directory), motion, store,
    getFaces: () => undefined,
    config: (k) => cfg[k],
    streamFn: ((_model: unknown, ctx: any) => {
      // streamFn(model, context, options) — messages live on the context arg.
      const msgs = (ctx?.messages ?? []) as Array<{ role: string; content: any }>;
      const lastUser = [...msgs].reverse().find((x) => x.role === 'user');
      const raw = Array.isArray(lastUser?.content)
        ? lastUser!.content.map((c: any) => c.text ?? '').join('')
        : String(lastUser?.content ?? '');
      const t = stripTurnContext(raw); // volatile per-turn block rides the user msg now
      if (t) seenTurns.push(t);
      const s: AssistantMessageEventStream = createAssistantMessageEventStream();
      s.push({ type: 'start', partial: assistant('') });
      s.push({ type: 'done', reason: 'stop', message: assistant('ok') });
      s.end();
      return s;
    }) as never,
  };
  const session = new DockBrainSession(DOCK, deps);

  // Replicate the brain/index.ts addressed wiring against THIS session.
  const latch = new Map<string, AddressedLatch>();
  const latchOf = (d: string) => latch.get(d) ?? newLatch();
  const onFinal = async (t: { dockId: string; text: string; startedAt: number; endedAt: number }) => {
    const { addressed, next } = decideAddressed(latchOf(t.dockId), { startedAt: t.startedAt, endedAt: t.endedAt });
    latch.set(t.dockId, next);
    if (addressed) await session.handleTurnRequest({ turnId: `addr-${Math.random()}`, trigger: { kind: 'user', text: t.text } });
  };

  // 1) un-tapped utterance → overheard, NO turn.
  await onFinal({ dockId: DOCK, text: 'just talking to myself', startedAt: 1000, endedAt: 1500 });
  for (let i = 0; i < 10; i++) await tick();
  assert.deepEqual(seenTurns, [], 'overheard speech does not drive a turn');

  // 2) tap, then speak → addressed, ONE turn with that text.
  latch.set(DOCK, tapLatch(latchOf(DOCK), 2000));
  await onFinal({ dockId: DOCK, text: 'what time is it', startedAt: 2100, endedAt: 2700 });
  for (let i = 0; i < 20 && seenTurns.length === 0; i++) await tick();
  assert.deepEqual(seenTurns, ['what time is it'], 'tapped utterance drove exactly one user turn');

  // 3) the next utterance (latch cleared at sentence-end) is overheard again.
  await onFinal({ dockId: DOCK, text: 'and now muttering', startedAt: 3000, endedAt: 3500 });
  for (let i = 0; i < 10; i++) await tick();
  assert.deepEqual(seenTurns, ['what time is it'], 'one tap → one turn; next sentence overheard');
});

/**
 * A reusable barge-in harness. The first turn's stream stays open for `firstMs`
 * (the dock "mid-reply"); later turns complete instantly. Returns helpers to drive
 * addressed turns and inspect which turn text the LLM actually started. The open
 * stream ends on a short timer so an abort+unwind can complete (a real provider
 * ends on the agent's abort; the timer is the test stand-in).
 */
function bargeHarness(firstMs = 200) {
  const bus = new Bus();
  const directory = new Directory(() => [phonePeer()], join(tmpdir(), `dir-${Math.random()}.json`));
  const store = new SessionStore(mkdtempSync(join(tmpdir(), 'barge-e2e-')));
  const motion = new MotionExecutor(bus, directory);
  const started: string[] = [];
  const cfg = { brainModel: 'openai-compatible/faux@http://test' } as Record<string, unknown>;
  let nth = 0;
  const deps: SessionDeps = {
    bus, directory, rpc: new RpcBroker(bus, directory), motion, store,
    getFaces: () => undefined,
    config: (k) => cfg[k],
    streamFn: ((_model: unknown, ctx: any) => {
      const msgs = (ctx?.messages ?? []) as Array<{ role: string; content: any }>;
      const lastUser = [...msgs].reverse().find((x) => x.role === 'user');
      const t = stripTurnContext(Array.isArray(lastUser?.content) ? lastUser!.content.map((c: any) => c.text ?? '').join('') : '');
      started.push(t);
      const s: AssistantMessageEventStream = createAssistantMessageEventStream();
      s.push({ type: 'start', partial: assistant('') });
      const slow = nth++ === 0;
      const finish = () => { s.push({ type: 'done', reason: 'stop', message: assistant('ok') }); s.end(); };
      if (slow) setTimeout(finish, firstMs); else finish();
      return s;
    }) as never,
  };
  const session = new DockBrainSession(DOCK, deps);
  const addressed = (text: string) =>
    session.handleTurnRequest({ turnId: `t-${Math.random()}`, trigger: { kind: 'user', text } });
  return { session, addressed, started };
}

// VARIANT 1 — the canonical case: barge-in mid-reply supersedes.
test('E2E barge-in (A1.4) v1: an addressed utterance mid-turn supersedes the running turn', async () => {
  const { addressed, started } = bargeHarness(400);
  void addressed('tell me a long story');
  for (let i = 0; i < 20 && started.length === 0; i++) await tick();
  assert.deepEqual(started, ['tell me a long story'], 'first turn started');
  void addressed('stop, what time is it');
  for (let i = 0; i < 60 && started.length < 2; i++) await tick();
  assert.equal(started.length, 2, 'the barge-in turn started');
  assert.equal(started[1], 'stop, what time is it', 'barge-in text drove the new turn');
});

// VARIANT 2 — the barge-in WINS: its text is what ultimately runs to completion.
test('E2E barge-in (A1.4) v2: the barge-in turn is the one that completes', async () => {
  const { session, addressed, started } = bargeHarness(400);
  void addressed('first long thing');
  for (let i = 0; i < 20 && started.length === 0; i++) await tick();
  await session.handleTurnRequest({ turnId: 'barge', trigger: { kind: 'user', text: 'actually never mind, hi' } });
  for (let i = 0; i < 30; i++) await tick();
  assert.equal(started.at(-1), 'actually never mind, hi', 'the last started turn is the barge-in');
  assert.ok(started.length >= 2, 'at least the original + barge-in started');
});

// VARIANT 3 — double barge-in: a second interrupt supersedes the first interrupt.
test('E2E barge-in (A1.4) v3: a second barge-in supersedes the first barge-in', async () => {
  const { addressed, started } = bargeHarness(400);
  void addressed('story one');
  for (let i = 0; i < 20 && started.length === 0; i++) await tick();
  void addressed('wait, question A');
  for (let i = 0; i < 20 && started.length < 2; i++) await tick();
  void addressed('no, question B');
  for (let i = 0; i < 60 && started.at(-1) !== 'no, question B'; i++) await tick();
  assert.equal(started.at(-1), 'no, question B', 'the final barge-in is what runs');
});

// VARIANT 4 — no barge-in: a single turn with no interrupt completes normally.
test('E2E barge-in (A1.4) v4: a lone turn (no interrupt) completes without supersede', async () => {
  const { addressed, started } = bargeHarness(50);
  await addressed('just one question');
  for (let i = 0; i < 30; i++) await tick();
  assert.deepEqual(started, ['just one question'], 'exactly one turn started, no spurious supersede');
});

// A1.2 ADOPTION (the bug a server-only test missed): an addressed turn is
// station-originated, so its turn-status MUST carry autonomous:true — otherwise
// the phone drops its speak frames as stale (no audible reply). This captures the
// actual wire frame the phone receives.
test('E2E addressed adoption (A1.2): a station-originated user turn is flagged autonomous', async () => {
  const bus = new Bus();
  const directory = new Directory(() => [phonePeer()], join(tmpdir(), `dir-${Math.random()}.json`));
  const store = new SessionStore(mkdtempSync(join(tmpdir(), 'adopt-e2e-')));
  const motion = new MotionExecutor(bus, directory);
  const cfg = { brainModel: 'openai-compatible/faux@http://test' } as Record<string, unknown>;
  const deps: SessionDeps = {
    bus, directory, rpc: new RpcBroker(bus, directory), motion, store,
    getFaces: () => undefined, config: (k) => cfg[k],
    streamFn: ((_m: unknown, _c: any) => {
      const s: AssistantMessageEventStream = createAssistantMessageEventStream();
      s.push({ type: 'start', partial: assistant('') });
      s.push({ type: 'done', reason: 'stop', message: assistant('hi') });
      s.end(); return s;
    }) as never,
  };
  const session = new DockBrainSession(DOCK, deps);

  // capture the turn-status 'accepted' frames the phone would receive.
  const accepted: Array<{ turnId: string; autonomous?: boolean }> = [];
  bus.on('agent', (msg) => {
    if (msg.kind === 'turn-status') {
      const p = msg.payload as { state?: string; turnId: string; autonomous?: boolean };
      if (p.state === 'accepted') accepted.push({ turnId: p.turnId, autonomous: p.autonomous });
    }
  });

  // a station-originated addressed turn (what brain/index.ts sends from a tap).
  await session.handleTurnRequest({ turnId: 'addr-1', trigger: { kind: 'user', text: 'hi' }, stationOriginated: true });
  for (let i = 0; i < 20; i++) await tick();
  const addr = accepted.find((a) => a.turnId === 'addr-1');
  assert.ok(addr, 'the addressed turn was accepted');
  assert.equal(addr!.autonomous, true, 'station-originated user turn MUST be autonomous (phone adopts it)');

  // a NORMAL phone-started user turn must NOT be autonomous (phone already owns it).
  await session.handleTurnRequest({ turnId: 'user-1', trigger: { kind: 'user', text: 'yo' } });
  for (let i = 0; i < 20; i++) await tick();
  const usr = accepted.find((a) => a.turnId === 'user-1');
  assert.ok(usr, 'the user turn was accepted');
  assert.notEqual(usr!.autonomous, true, 'a phone-started user turn is NOT autonomous');
});

// ── RECONNECT RESYNC (the user-reported "stuck listening" bug: repro → validate) ──
// A station restart / app restart leaves the phone reconnecting. The bug: the phone
// face stayed "listening" while the station reset to idle, so speech was overheard
// (transcribed, not answered). The fix: on hello, the station reconciles to idle AND
// re-sends the current conversation frame so the phone (a pure renderer) can't stay
// stuck. These assert BOTH the state reset and that a frame reaches the phone.
function convCaptureSession() {
  const bus = new Bus();
  const directory = new Directory(() => [phonePeer()], join(tmpdir(), `dir-${Math.random()}.json`));
  const store = new SessionStore(mkdtempSync(join(tmpdir(), 'conv-e2e-')));
  const motion = new MotionExecutor(bus, directory);
  const cfg = { brainModel: 'openai-compatible/faux@http://test' } as Record<string, unknown>;
  const convFrames: Array<{ to: string; reason: string }> = [];
  bus.on('agent', (msg) => {
    if (msg.kind === 'conversation') {
      const p = msg.payload as { to: string; reason: string };
      convFrames.push({ to: p.to, reason: p.reason });
    }
  });
  const deps: SessionDeps = {
    bus, directory, rpc: new RpcBroker(bus, directory), motion, store,
    getFaces: () => undefined, config: (k) => cfg[k],
    streamFn: (() => { const s = createAssistantMessageEventStream(); s.push({ type: 'start', partial: assistant('') }); s.push({ type: 'done', reason: 'stop', message: assistant('ok') }); s.end(); return s; }) as never,
  };
  return { session: new DockBrainSession(DOCK, deps), convFrames };
}

test('E2E reconnect: an active listening window → phone reconnect → station idle + a frame reaches the phone', async () => {
  const { session, convFrames } = convCaptureSession();
  session.tap(); // open a listening window
  assert.equal(session.conversation().mode, 'listening');
  convFrames.length = 0; // ignore the tap frame; focus on the reconnect

  // phone reconnects (the hello path) → reconcile + resend.
  session.notePhoneConnected();
  session.resendConversation();
  await tick();

  assert.equal(session.conversation().mode, 'idle', 'reconciled to idle');
  // the phone MUST receive a frame so a stuck "listening" face corrects to idle.
  assert.ok(convFrames.some((f) => f.to === 'idle'), 'an idle conversation frame reached the phone');
});

test('E2E reconnect: when ALREADY idle, resend STILL sends a frame (fixes a stuck face)', async () => {
  const { session, convFrames } = convCaptureSession();
  // station already idle; the phone face might be stale-stuck on listening. The
  // reconcile fires no transition (idle→idle), so RESEND must still send a frame.
  session.notePhoneConnected();
  convFrames.length = 0;
  session.resendConversation();
  await tick();
  assert.ok(convFrames.some((f) => f.to === 'idle' && f.reason === 'resync'),
    'resync frame sent even with no transition (so a stuck phone face corrects)');
});

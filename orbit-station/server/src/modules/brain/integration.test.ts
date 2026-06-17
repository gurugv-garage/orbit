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
import type { RosterEntry } from '../../core/hub.js';
import { Directory } from '../docks/directory.js';
import { MotionExecutor } from '../bodylink/motion.js';
import { RpcBroker } from './rpc.js';
import { SessionStore } from './store.js';
import { DockBrainSession, type SessionDeps } from './session.js';
import { buildMemoryTools } from './tools.js';
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

test('E2E grounding: a cached summary reaches the LLM system prompt', async () => {
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
  const cfg = { brainModel: 'openai-compatible/faux@http://test' } as Record<string, unknown>;
  const deps: SessionDeps = {
    bus, directory, rpc: new RpcBroker(bus, directory), motion, store,
    getFaces: () => undefined,
    getGrounding: () => grounding,
    config: (k) => cfg[k],
    // capture the system prompt the agent actually sends.
    streamFn: ((_m: unknown, ctx: any) => {
      seenSystemPrompt = ctx?.systemPrompt ?? ctx?.system ?? '';
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

  assert.match(seenSystemPrompt, /Perception — last summary/);
  assert.match(seenSystemPrompt, /debugging and sounded frustrated/);
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

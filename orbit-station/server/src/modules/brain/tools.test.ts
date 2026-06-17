/**
 * force_get_current (docs/PERCEPTION-TO-AGENT.md 3.2) — the perception PULL tool:
 *  - offered only when the grounding facade is wired (getGrounding present);
 *  - flushes + summarizes the live moment via forceCurrent(dock, streamId);
 *  - passes the dock's live streamId from the turn context;
 *  - surfaces a summarizer error as a thrown tool error (the model narrates it).
 * No LLM, no perception module — a mock PerceptionGroundingApi.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildDockTools, buildMemoryTools, type ToolDeps } from './tools.js';
import type { PerceptionGroundingApi, MemoryApi } from '../perception/index.js';
import type { MemoryRow } from '../perception/memory/store.js';

const text = (r: { content: readonly unknown[] }) =>
  r.content.map((c) => (c as { text?: string }).text ?? '').join('');

/** Minimal ToolDeps — only what force_get_current touches; the rest are stubs. */
function deps(over: Partial<ToolDeps> = {}): ToolDeps {
  return {
    dock: 'desk-1',
    rpc: {} as never,
    motion: {} as never,
    getFaces: () => undefined,
    getGestures: () => ({}),
    getTurnContext: () => ({ turnId: 't1', streamId: 'cam-0' }),
    ...over,
  };
}

function toolMap(d: ToolDeps) {
  return new Map(buildDockTools(d).map((t) => [t.name, t]));
}

test('force_get_current is NOT offered without a grounding facade', () => {
  const t = toolMap(deps({ getGrounding: undefined }));
  assert.equal(t.has('force_get_current'), false);
});

test('force_get_current flushes+summarizes the live moment and reports it', async () => {
  let calledWith: { dock?: string; streamId?: string } = {};
  const grounding: PerceptionGroundingApi = {
    forDock: () => undefined,
    async forceCurrent(dock, streamId) {
      calledWith = { dock, streamId };
      return {
        summary: 'Guru is holding a coffee mug and looking at the screen.',
        window: { from: '2026-06-16T14:30:00+05:30', to: '2026-06-16T14:31:00+05:30' },
      };
    },
  };
  const t = toolMap(deps({ getGrounding: () => grounding }));
  assert.ok(t.has('force_get_current'), 'tool offered when grounding is wired');

  const r = await t.get('force_get_current')!.execute('c1', {} as never);
  // passed the dock + the turn's live streamId
  assert.deepEqual(calledWith, { dock: 'desk-1', streamId: 'cam-0' });
  // reports the fresh summary with the IST window clock
  assert.match(text(r), /Right now \(14:30:00–14:31:00 IST\)/);
  assert.match(text(r), /coffee mug/);
});

test('force_get_current surfaces a summarizer error as a thrown tool error', async () => {
  const grounding: PerceptionGroundingApi = {
    forDock: () => undefined,
    async forceCurrent() {
      return { summary: '', error: 'gemini 503: overloaded', window: { from: 'a', to: 'b' } };
    },
  };
  const t = toolMap(deps({ getGrounding: () => grounding }));
  await assert.rejects(
    () => t.get('force_get_current')!.execute('c1', {} as never),
    /couldn't get a fresh read: gemini 503/,
  );
});

test('force_get_current throws cleanly if perception vanished at call time', async () => {
  // facade getter present but returns undefined (perception module not inited)
  const t = toolMap(deps({ getGrounding: () => undefined }));
  // the tool IS built (getGrounding fn present) but errors when invoked
  assert.ok(t.has('force_get_current'));
  await assert.rejects(
    () => t.get('force_get_current')!.execute('c1', {} as never),
    /perception is not available/,
  );
});

// ── memory tools (Decision 4) — a mock MemoryApi captures the calls ──────────

function mkRow(over: Partial<MemoryRow> = {}): MemoryRow {
  return {
    id: 'abcd1234-5678-90ab-cdef-111122223333', dockId: 'desk-1', type: 'preference',
    subject: 'guru', claim: 'prefers tea', valueJson: null, confidence: 0.8,
    derivation: 'observed', status: 'active', createdAt: 1_000, validFrom: 1_000,
    validTo: null, supersedes: null, ...over,
  };
}

function mockMemory(over: Partial<MemoryApi> = {}): { api: MemoryApi; calls: any } {
  const calls: any = {};
  const api: MemoryApi = {
    recall: async (f) => { calls.recall = f; return [mkRow()]; },
    inspect: (id) => { calls.inspect = id; return { memory: mkRow(), lineage: [{ sourceKind: 'snapshot', sourceId: 'vision-1' }] }; },
    remember: async (m) => { calls.remember = m; return 'new-id'; },
    update: async (id, p) => { calls.update = { id, p }; return 'rev-id'; },
    forget: (id) => { calls.forget = id; return true; },
    subjects: () => ['guru', 'kitchen'],
    recent: () => [mkRow()],
    count: () => 1,
    ...over,
  };
  return { api, calls };
}

const memTools = (api?: MemoryApi) => new Map(buildMemoryTools('desk-1', () => api).map((t) => [t.name, t]));

test('recall_memory passes filters through and renders rows with ids', async () => {
  const { api, calls } = mockMemory();
  const r = await memTools(api).get('recall_memory')!.execute('c', { query: 'about guru', type: 'preference' } as never);
  assert.equal(calls.recall.query, 'about guru');
  assert.equal(calls.recall.type, 'preference');
  assert.equal(calls.recall.dockId, 'desk-1');
  assert.match(text(r), /prefers tea/);
  assert.match(text(r), /\[abcd1234\]/); // 8-char id shown for follow-up tools
});

test('recall_memory: empty result reads naturally', async () => {
  const { api } = mockMemory({ recall: async () => [] });
  const r = await memTools(api).get('recall_memory')!.execute('c', {} as never);
  assert.match(text(r), /don't have any memories/);
});

test('list_subjects + list_recent orient the agent', async () => {
  const t = memTools(mockMemory().api);
  assert.match(text(await t.get('list_subjects')!.execute('c', {} as never)), /guru, kitchen/);
  assert.match(text(await t.get('list_recent')!.execute('c', { limit: 5 } as never)), /prefers tea/);
});

test('inspect_memory surfaces lineage + confidence (the "why do I believe this")', async () => {
  const { api, calls } = mockMemory();
  // full id passed straight through
  const r = await memTools(api).get('inspect_memory')!.execute('c', { id: 'abcd1234-5678-90ab-cdef-111122223333' } as never);
  assert.equal(calls.inspect, 'abcd1234-5678-90ab-cdef-111122223333');
  assert.match(text(r), /snapshot:vision-1/);
  assert.match(text(r), /confidence 0.80/);
});

test('inspect/update/forget resolve an 8-char id prefix via recent()', async () => {
  const { api, calls } = mockMemory();
  await memTools(api).get('forget_memory')!.execute('c', { id: 'abcd1234' } as never);
  // resolved to the full id from recent()
  assert.equal(calls.forget, 'abcd1234-5678-90ab-cdef-111122223333');
});

test('remember records a new fact with subject + type', async () => {
  const { api, calls } = mockMemory();
  const r = await memTools(api).get('remember')!.execute('c', { claim: 'likes hiking', subject: 'guru', type: 'preference' } as never);
  assert.equal(calls.remember.claim, 'likes hiking');
  assert.equal(calls.remember.subject, 'guru');
  assert.equal(calls.remember.type, 'preference');
  assert.match(text(r), /remember that about guru/);
});

test('update_memory revises (keeps history per the facade)', async () => {
  const { api, calls } = mockMemory();
  const r = await memTools(api).get('update_memory')!.execute('c', { id: 'abcd1234-5678-90ab-cdef-111122223333', claim: 'now prefers coffee' } as never);
  assert.equal(calls.update.p.claim, 'now prefers coffee');
  assert.match(text(r), /Updated/);
});

test('memory tools throw cleanly when the facade is unavailable', async () => {
  const t = memTools(undefined); // getMemory returns undefined
  await assert.rejects(() => t.get('recall_memory')!.execute('c', {} as never), /memory is not available/);
});

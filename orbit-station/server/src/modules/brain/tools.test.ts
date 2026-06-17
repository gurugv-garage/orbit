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
import { buildDockTools, type ToolDeps } from './tools.js';
import type { PerceptionGroundingApi } from '../perception/index.js';

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

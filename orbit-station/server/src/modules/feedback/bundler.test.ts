/**
 * Feedback bundler tests (node:test) — a fake enriched obs session in, a
 * complete markdown dump out. Asserts the thin-layer contract: the MD carries
 * the user's words, the static provenance snapshot, the session trace timings,
 * and the per-session enrichment (config/models/perception).
 *
 *   npm test --workspace server
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildFeedback, type FeedbackWiring } from './bundler.js';
import { healthSummary } from '../observability/health.js';
import type { SessionRecord } from '../observability/types.js';

function fakeTrace(): SessionRecord {
  return {
    sessionId: 's-test',
    source: 'web-test',
    firstSeen: 1_000,
    lastSeen: 5_000,
    turns: [
      {
        turnId: 't1', sessionId: 's-test', startedAt: 1_000, endedAt: 4_000,
        trigger: { kind: 'user', text: 'move your head' }, llmCalls: 1,
        steps: [
          {
            index: 0, startedAt: 1_001, endedAt: 4_000, model: 'google/gemini-2.5-flash',
            ms: 2999, ttftMs: 800, usage: { inputTokens: 120, outputTokens: 40, cost: 0.0003 },
            tools: [{ toolCallId: 'c1', toolName: 'move', args: { part: 'neck' }, startedAt: 2_000, endedAt: 2_100, isError: false, result: 'ok' }],
          },
        ],
      },
    ],
    enrichment: {
      updatedAt: 5_000,
      config: { brainModel: 'google/gemini-2.5-flash', brainThinking: 'medium' },
      models: { brain: 'google/gemini-2.5-flash', thinking: 'medium', perception: [{ name: 'qwen2.5-vl', endpoint: 'mlx' }] },
      perception: [{ source: { kind: 'speech' }, payload: { text: 'move your head', confidence: 0.91, no_speech: 0.02 } }],
      grounding: 'guru is present, smiling',
    },
  };
}

function wiring(trace: SessionRecord | undefined): FeedbackWiring {
  return {
    getTrace: () => trace,
    health: (turns) => healthSummary(turns),
    openSessionId: () => 's-test',
    getSession: () => ({ meta: { sessionId: 's-test', turns: 1 }, transcript: [{ role: 'user', content: 'move your head' }] }),
    provenance: () => ({
      station: { gitSha: 'abc123def456', gitBranch: 'main', dirty: false, version: '0.1.0', node: 'v20' },
      app: { versionName: '1.2.3', versionCode: 42, gitSha: 'deadbeef' },
      firmware: { build: 17 },
      models: { brain: 'google/gemini-2.5-flash', thinking: 'medium', perception: [{ name: 'qwen2.5-vl', endpoint: 'mlx' }] },
    }),
    memory: () => [],
    constants: () => ({ PORT: '8099' }),
  };
}

test('feedback MD bundles user words + provenance + trace + enrichment', async () => {
  const { markdown, meta } = await buildFeedback(
    { dock: 'web-test', source: 'brain-tool', reason: 'head did not move', detail: 'I asked it to nod' },
    wiring(fakeTrace()),
  );

  // frontmatter
  assert.match(markdown, /^---\n/);
  assert.match(markdown, /id: fb-/);
  assert.match(markdown, /dock: web-test/);
  assert.match(markdown, /sessionId: s-test/);
  assert.match(markdown, /source: brain-tool/);
  // provenance baked into frontmatter + body
  assert.match(markdown, /abc123def456/);
  assert.match(markdown, /firmware\*\*: build 17/);
  assert.match(markdown, /1\.2\.3/); // app version

  // user words
  assert.match(markdown, /head did not move/);
  assert.match(markdown, /I asked it to nod/);

  // trace timings + tool
  assert.match(markdown, /ttft 800ms/);
  assert.match(markdown, /🔧 move/);

  // enrichment surfaced (config + perception confidence)
  assert.match(markdown, /Session context/);
  assert.match(markdown, /qwen2\.5-vl/);
  assert.match(markdown, /no_speech/);

  assert.equal(meta.dock, 'web-test');
  assert.equal(meta.source, 'brain-tool');
});

test('feedback MD tolerates a missing trace (no session)', async () => {
  const { markdown } = await buildFeedback(
    { dock: 'web-test', source: 'api', reason: 'general note' },
    { ...wiring(undefined), openSessionId: () => undefined },
  );
  assert.match(markdown, /general note/);
  assert.match(markdown, /no observability trace/);
});

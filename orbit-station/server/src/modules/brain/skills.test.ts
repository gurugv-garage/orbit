/**
 * Per-dock Skills (docs/SERVER-BRAIN-SELFMOD.md §1a):
 *  - install/list/remove round-trip + path-containment guard + bad-frontmatter
 *    rejection (the REST helpers);
 *  - an installed skill reaches the MODEL: its name+description ride the system
 *    prompt and `invoke_skill` returns the full body (the wiring into a turn).
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
import { installDockSkill, listDockSkills, removeDockSkill, loadDockSkills } from './skills.js';

const DOCK = 'skill-bot';

const TEA = `---
name: tea-brewing
description: How to brew tea. Use when asked about steeping or temperatures.
---
# Brewing tea
Green 80C 2min, black 95C 4min. Ask which, answer warmly.
`;

function assistant(text: string): AssistantMessage {
  return {
    role: 'assistant', content: text ? [{ type: 'text', text }] : [],
    api: 'openai-completions', provider: 'test', model: 'faux',
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: 'stop', timestamp: Date.now(),
  };
}

test('install → list → remove round-trip + rejects bad frontmatter + lane guard', async () => {
  const root = mkdtempSync(join(tmpdir(), 'skills-test-'));

  const name = await installDockSkill(root, DOCK, TEA);
  assert.equal(name, 'tea-brewing');

  const list = await listDockSkills(root, DOCK);
  assert.equal(list.length, 1);
  assert.equal(list[0]!.name, 'tea-brewing');
  assert.match(list[0]!.description, /brew tea/i);

  // bad frontmatter (no name/description) → throws, nothing lingers
  await assert.rejects(() => installDockSkill(root, DOCK, 'just text, no frontmatter'));
  assert.equal((await listDockSkills(root, DOCK)).length, 1);

  // another dock never sees this dock's skill (tenancy = folder)
  assert.equal((await listDockSkills(root, 'other-dock')).length, 0);

  // remove
  assert.equal(await removeDockSkill(root, DOCK, 'tea-brewing'), true);
  assert.equal((await listDockSkills(root, DOCK)).length, 0);
  // removing a missing skill is a clean false
  assert.equal(await removeDockSkill(root, DOCK, 'tea-brewing'), false);
});

test('loadDockSkills builds the prompt block + invoke_skill tool returns the body', async () => {
  const root = mkdtempSync(join(tmpdir(), 'skills-load-'));
  await installDockSkill(root, DOCK, TEA);

  const loaded = await loadDockSkills(root, DOCK);
  assert.match(loaded.promptBlock, /tea-brewing/);
  assert.match(loaded.promptBlock, /invoke_skill/);
  assert.ok(loaded.tool, 'invoke_skill tool present');

  const ok = await loaded.tool!.execute('c1', { name: 'tea-brewing' } as never);
  const okText = (ok.content as Array<{ text?: string }>).map((c) => c.text).join('');
  assert.match(okText, /Brewing tea/); // full body delivered on demand
  assert.notEqual((ok as { isError?: boolean }).isError, true);

  const bad = await loaded.tool!.execute('c2', { name: 'nope' } as never);
  assert.equal((bad as { isError?: boolean }).isError, true);
});

// ── the skill actually reaches the model (system prompt) on a real turn ──────

function phonePeer(): RosterEntry {
  return {
    role: 'device', id: 'phone-hw-1', dock: DOCK, component: 'phone',
    kind: 'dock-android-app', caps: ['voice', 'face', 'camera'],
    lastSeen: Date.now(), connectedAt: Date.now(), topics: ['agent'],
  };
}

test('an installed skill rides the turn system prompt + adds the invoke_skill tool', async () => {
  const storeRoot = mkdtempSync(join(tmpdir(), 'skills-turn-'));
  await installDockSkill(storeRoot, DOCK, TEA);

  const bus = new Bus();
  const roster = [phonePeer()];
  const directory = new Directory(() => roster, join(tmpdir(), `dir-${Math.random()}.json`));
  const motion = new MotionExecutor(bus, directory);
  const rpc = new RpcBroker(bus, directory);
  const store = new SessionStore(storeRoot);

  const ctxs: Array<{ systemPrompt?: string; tools?: Array<{ name: string }> }> = [];
  const deps: SessionDeps = {
    bus, directory, rpc, motion, store,
    getFaces: () => undefined as never,
    config: (k) => ({ brainModel: 'openai-compatible/faux@http://test' } as Record<string, unknown>)[k as string],
    streamFn: ((_m: unknown, ctx: { systemPrompt?: string; tools?: Array<{ name: string }> }) => {
      ctxs.push(ctx);
      const stream: AssistantMessageEventStream = createAssistantMessageEventStream();
      const done = assistant('Sure.');
      stream.push({ type: 'done', reason: 'stop', message: done });
      stream.end(done);
      return stream;
    }) as never,
  };

  const session = new DockBrainSession(DOCK, deps);
  await session.handleTurnRequest({ turnId: 't1', trigger: { kind: 'user', text: 'how do I make tea?' } });

  assert.ok(ctxs.length >= 1, 'streamFn was called');
  const sys = ctxs[0]!.systemPrompt ?? '';
  assert.match(sys, /tea-brewing/, 'skill name in the system prompt (progressive disclosure)');
  assert.match(sys, /invoke_skill/, 'invocation instruction in the prompt');
  const toolNames = (ctxs[0]!.tools ?? []).map((t) => t.name);
  assert.ok(toolNames.includes('invoke_skill'), 'invoke_skill tool offered to the model');
});

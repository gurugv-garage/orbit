/**
 * Turn REPLAY (replay.ts) — recorded assistant responses re-executed through
 * the LIVE session pipeline with no LLM calls. Covers: script construction
 * (transcript join + degraded obs fallback), the scripted transport, the tool
 * side-effect policy, and the full DockBrainSession integration including the
 * no-pollution and latch-regression guarantees.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type AssistantMessageEvent,
  type AssistantMessageEventStream,
} from '@earendil-works/pi-ai';
import type { AgentMessage, AgentTool } from '@earendil-works/pi-agent-core';
import { Bus, type BusMessage } from '../../core/bus.js';
import type { RosterEntry } from '../../core/websocket-gateway.js';
import { Directory } from '../docks/directory.js';
import { MotionExecutor } from '../bodylink/motion.js';
import type { TurnRecord } from '../observability/types.js';
import { RpcBroker } from './rpc.js';
import { SessionStore } from './store.js';
import { DockBrainSession, type SessionDeps } from './session.js';
import { buildReplayScript, makeReplayStreamFn, wrapToolsForReplay, type ReplayScript } from './replay.js';

const DOCK = 'test-bot';

// ── fixtures ─────────────────────────────────────────────────────────────────

const T0 = 1_700_000_000_000;

function recordedTurn(): TurnRecord {
  return {
    turnId: 'turn-orig', sessionId: 's-orig', trigger: { kind: 'user', text: 'wave hello' },
    startedAt: T0, endedAt: T0 + 8_000, state: 'done', llmCalls: 2,
    steps: [
      {
        index: 0, startedAt: T0, streamStartedAt: T0 + 900, endedAt: T0 + 2_000,
        text: 'Hello. Nice to see you.', // obs text: tags STRIPPED
        ms: 2_000, ttftMs: 800, ttftTextMs: 900,
        tools: [
          { toolCallId: 'call-1', toolName: 'get_date_time', args: {}, result: 'obs-clock', startedAt: T0 + 2_000, endedAt: T0 + 2_300 },
          // synthetic tag row (the phone applying [face:happy] at TTS playback,
          // long after the text streamed) — NOT an LLM tool call
          { toolCallId: 'tag-1', toolName: 'inline_mood', args: { expression: 'happy' }, result: 'face happy live', startedAt: T0 + 7_000, endedAt: T0 + 7_003 },
        ],
      },
      { index: 1, startedAt: T0 + 2_300, endedAt: T0 + 3_000, text: 'All done now.', tools: [] },
    ],
  };
}

/** The matching session transcript — raw text, tags INTACT. */
function transcript(): AgentMessage[] {
  const asst = (content: AssistantMessage['content'], stopReason: AssistantMessage['stopReason'], ts: number): AgentMessage => ({
    role: 'assistant', content, api: 'openai-completions', provider: 'test', model: 'faux',
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason, timestamp: ts,
  } as AgentMessage);
  return [
    { role: 'user', content: 'earlier question', timestamp: T0 - 60_000 } as AgentMessage,
    asst([{ type: 'text', text: 'Earlier answer.' }], 'stop', T0 - 59_000),
    { role: 'user', content: 'wave hello', timestamp: T0 + 10 } as AgentMessage,
    asst([
      { type: 'text', text: 'Hello. [face:happy]Nice to see you.' },
      { type: 'toolCall', id: 'call-1', name: 'get_date_time', arguments: {} },
    ], 'toolUse', T0 + 2_000),
    { role: 'toolResult', toolCallId: 'call-1', toolName: 'get_date_time', content: [{ type: 'text', text: 'transcript-clock' }], isError: false, timestamp: T0 + 2_300 } as AgentMessage,
    asst([{ type: 'text', text: '[move]All done now.' }], 'stop', T0 + 3_000),
    { role: 'user', content: 'a later question', timestamp: T0 + 60_000 } as AgentMessage,
  ];
}

async function collect(stream: AssistantMessageEventStream): Promise<AssistantMessageEvent[]> {
  const evs: AssistantMessageEvent[] = [];
  for await (const e of stream) evs.push(e);
  return evs;
}

// ── buildReplayScript ────────────────────────────────────────────────────────

test('buildReplayScript joins the raw transcript (tags intact) with obs timings', () => {
  const script = buildReplayScript(recordedTurn(), transcript(), true);
  assert.equal(script.degraded, undefined);
  assert.equal(script.steps.length, 2);
  // RAW text — the [face:]/[move] tags obs strips are preserved
  assert.equal(script.steps[0]!.text, 'Hello. [face:happy]Nice to see you.');
  assert.equal(script.steps[1]!.text, '[move]All done now.');
  assert.deepEqual(script.steps[0]!.toolCalls.map((t) => t.id), ['call-1']);
  // timings joined by step index; the text stream window ENDS where the step's
  // tools begin (T0+2000) — tool time must not be paced twice
  assert.equal(script.steps[0]!.ttftMs, 800);
  assert.equal(script.steps[0]!.ttftTextMs, 900);
  assert.equal(script.steps[0]!.streamMs, 1_100);
  // the transcript's toolResult wins over the obs fallback result
  assert.equal(script.results['call-1']!.result, 'transcript-clock');
  assert.equal(script.results['call-1']!.ms, 300);
  assert.equal(script.triggerText, 'wave hello');
});

test('buildReplayScript falls back to the obs record (degraded) when the transcript slice is missing', () => {
  const script = buildReplayScript(recordedTurn(), [], true);
  assert.equal(script.degraded, true);
  assert.equal(script.steps.length, 2);
  assert.equal(script.steps[0]!.text, 'Hello. Nice to see you.'); // tag-stripped obs text
  // synthetic tag rows (inline_mood) are NOT canned back as tool calls
  assert.deepEqual(script.steps[0]!.toolCalls.map((t) => t.id), ['call-1']);
  assert.equal(script.results['call-1']!.result, 'obs-clock');
  // ...and don't corrupt the text-window timing (text ends at the REAL tool)
  assert.equal(script.steps[0]!.streamMs, 1_100);
});

test('obs fallback with rawText (recorded post-2026-07-17) keeps the tags — NOT degraded', () => {
  const turn = recordedTurn();
  turn.steps[0]!.rawText = 'Hello. [face:happy]Nice to see you.';
  turn.steps[1]!.rawText = '[move]All done now.';
  const script = buildReplayScript(turn, [], true);
  assert.equal(script.degraded, undefined);
  assert.equal(script.steps[0]!.text, 'Hello. [face:happy]Nice to see you.');
  assert.equal(script.steps[1]!.text, '[move]All done now.');
});

// ── makeReplayStreamFn ───────────────────────────────────────────────────────

test('replay transport streams each recorded step, then ends cleanly when exhausted', async () => {
  const script = buildReplayScript(recordedTurn(), transcript(), false); // instant
  const fn = makeReplayStreamFn(script);

  const s1 = await collect(fn(undefined as never, { messages: [] } as never, {}) as AssistantMessageEventStream);
  const text1 = s1.filter((e) => e.type === 'text_delta').map((e) => (e as { delta: string }).delta).join('');
  assert.equal(text1, 'Hello. [face:happy]Nice to see you.');
  assert.equal(s1.filter((e) => e.type === 'toolcall_end').length, 1);
  const done1 = s1.at(-1)!;
  assert.equal(done1.type, 'done');
  assert.equal((done1 as { reason: string }).reason, 'toolUse');
  // canned messages carry zero usage (no cost pollution)
  assert.equal((done1 as { message: AssistantMessage }).message.usage.totalTokens, 0);

  const s2 = await collect(fn(undefined as never, { messages: [] } as never, {}) as AssistantMessageEventStream);
  assert.equal((s2.at(-1) as { reason: string }).reason, 'stop');

  // EXHAUSTED (the recording ended): a clean empty stop, no throw
  const s3 = await collect(fn(undefined as never, { messages: [] } as never, {}) as AssistantMessageEventStream);
  assert.equal(s3.length, 1);
  assert.equal((s3[0] as { reason: string }).reason, 'stop');
  assert.equal((s3[0] as { message: AssistantMessage }).message.content.length, 0);
});

// ── wrapToolsForReplay ───────────────────────────────────────────────────────

test('tool policy: embodiment stays real, everything else returns its recorded result', async () => {
  let realRan = 0;
  const mk = (name: string): AgentTool<any> => ({
    name, label: name, description: name, parameters: { type: 'object', properties: {} } as never,
    execute: async () => { realRan++; return { content: [{ type: 'text', text: 'live!' }], details: undefined }; },
  });
  const script: ReplayScript = {
    steps: [], results: { 'call-9': { result: 'recorded-out' }, 'call-err': { result: 'boom', isError: true } },
    src: { sessionId: 's', turnId: 't' }, triggerText: '', paced: false,
  };
  const wrapped = wrapToolsForReplay([mk('move'), mk('move_otherdock'), mk('set_face'), mk('send_to_slack'), mk('get_date_time')], script);

  // embodiment passes through untouched
  await wrapped.find((t) => t.name === 'move')!.execute('x', {});
  await wrapped.find((t) => t.name === 'move_otherdock')!.execute('x', {});
  await wrapped.find((t) => t.name === 'set_face')!.execute('x', {});
  assert.equal(realRan, 3);

  // external effect → stub: recorded result by toolCallId, no live execution
  const slack = await wrapped.find((t) => t.name === 'send_to_slack')!.execute('call-9', {});
  assert.equal((slack.content[0] as { text: string }).text, 'recorded-out');
  assert.equal(realRan, 3);

  // recorded error → throws (the trace matches the original)
  await assert.rejects(() => wrapped.find((t) => t.name === 'get_date_time')!.execute('call-err', {}), /boom/);

  // no recorded result → generic stub text
  const missing = await wrapped.find((t) => t.name === 'send_to_slack')!.execute('call-unknown', {});
  assert.match((missing.content[0] as { text: string }).text, /replay stub/);
});

// ── full session integration ─────────────────────────────────────────────────

function phonePeer(): RosterEntry {
  return {
    role: 'device', id: 'phone-hw-1', dock: DOCK, component: 'phone',
    kind: 'dock-android-app', caps: ['voice', 'face', 'camera'],
    lastSeen: Date.now(), connectedAt: Date.now(), topics: ['agent'],
  };
}

function liveAssistant(text: string): AssistantMessage {
  return {
    role: 'assistant', content: text ? [{ type: 'text', text }] : [],
    api: 'openai-completions', provider: 'test', model: 'faux',
    usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: 'stop', timestamp: Date.now(),
  };
}

test('replay turn: live pipeline, stubbed tools, replay obs, no session pollution, latch clears', async () => {
  const bus = new Bus();
  const roster = [phonePeer()];
  const directory = new Directory(() => roster, join(tmpdir(), `dir-${Math.random()}.json`));
  const motion = new MotionExecutor(bus, directory);
  const rpc = new RpcBroker(bus, directory);
  const store = new SessionStore(mkdtempSync(join(tmpdir(), 'brain-replay-test-')));
  const frames: BusMessage[] = [];
  bus.on('agent', (m) => { if (m.source === 'station') frames.push(m); });
  const obs: Array<Record<string, unknown>> = [];
  bus.on('obs', (m) => obs.push(m.payload as Record<string, unknown>));

  // the REAL transport (deps.streamFn): must be untouched by the replay turn,
  // then serve the follow-up normal turn — the latch-regression assertion.
  let realCalls = 0;
  const config: Record<string, unknown> = { brainModel: 'openai-compatible/faux@http://test' };
  const deps: SessionDeps = {
    bus, directory, rpc, motion, store,
    getFaces: () => undefined,
    config: (k) => config[k],
    streamFn: ((_m: unknown, _ctx: unknown, _o: unknown) => {
      realCalls++;
      const s = createAssistantMessageEventStream();
      const done = liveAssistant('Back to normal. ');
      s.push({ type: 'start', partial: liveAssistant('') });
      s.push({ type: 'text_delta', contentIndex: 0, delta: 'Back to normal. ', partial: done });
      s.push({ type: 'done', reason: 'stop', message: done });
      s.end(done);
      return s;
    }) as never,
  };
  const session = new DockBrainSession(DOCK, deps);

  const script = buildReplayScript(recordedTurn(), transcript(), false); // instant replay
  await session.handleTurnRequest({
    turnId: 'r1',
    trigger: { kind: 'replay', text: script.triggerText, via: 's-orig:turn-orig' },
    stationOriginated: true,
    replay: script,
  });

  // ── spoken output came from the RAW transcript text, tags applied live ──
  const speaks = frames.filter((f) => f.kind === 'speak').map((f) => f.payload as { text: string; mood?: string; ack?: boolean });
  assert.deepEqual(speaks.map((s) => s.text), ['Hello.', 'Nice to see you.', 'All done now.']);
  assert.equal(speaks[1]!.mood, 'happy'); // [face:happy] rode its sentence
  assert.equal(speaks[2]!.ack, true); // [move] anchor requested a playback ack
  const statuses = frames.filter((f) => f.kind === 'turn-status').map((f) => f.payload as { state: string; autonomous?: boolean });
  assert.equal(statuses.at(-1)!.state, 'done');
  assert.equal(statuses[0]!.autonomous, true); // phone must ADOPT the station turn

  // ── the stubbed tool answered with the RECORDED result, not a live clock ──
  const toolEnds = obs.filter((e) => e.kind === 'ToolExecutionEnd')
    .map((e) => e.data as { toolName: string; result: string });
  assert.equal(toolEnds.length, 1);
  assert.equal(toolEnds[0]!.toolName, 'get_date_time');
  assert.equal(toolEnds[0]!.result, 'transcript-clock');

  // ── obs: a fresh replay-tagged trace, zero usage ──
  const turnStarts = obs.filter((e) => e.kind === 'TurnStart')
    .map((e) => e.data as { trigger: { kind: string; via?: string } });
  assert.equal(turnStarts.length, 1);
  assert.equal(turnStarts[0]!.trigger.kind, 'replay');
  assert.equal(turnStarts[0]!.trigger.via, 's-orig:turn-orig');
  const stepEnds = obs.filter((e) => e.kind === 'StepEnd')
    .map((e) => e.data as { usage?: { totalTokens?: number } });
  assert.ok(stepEnds.length >= 2);
  for (const se of stepEnds) assert.equal(se.usage?.totalTokens ?? 0, 0);

  // ── no pollution: the LLM transport was never hit, nothing was persisted ──
  assert.equal(realCalls, 0);
  const sid = session.sessionId!;
  assert.deepEqual(store.messages(DOCK, sid), []);

  // ── latch regression: the NEXT (normal) turn uses the real transport and persists ──
  await session.handleTurnRequest({ turnId: 't2', trigger: { kind: 'user', text: 'are you back?' } });
  assert.equal(realCalls, 1);
  const spoken2 = frames.filter((f) => f.kind === 'speak').map((f) => (f.payload as { text: string }).text);
  assert.equal(spoken2.at(-1), 'Back to normal.');
  const persisted = JSON.stringify(store.messages(DOCK, sid));
  assert.ok(persisted.includes('are you back?'));
  // the replayed exchange never entered the session history
  assert.ok(!persisted.includes('Nice to see you'));
  assert.ok(!persisted.includes('wave hello'));
});

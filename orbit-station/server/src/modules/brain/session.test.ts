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

function makeSession(scripts: Script[], opts: { config?: Record<string, unknown>; faces?: unknown; peers?: RosterEntry[] } = {}) {
  const bus = new Bus();
  const roster = [phonePeer(), ...(opts.peers ?? [])];
  const directory = new Directory(() => roster, join(tmpdir(), `dir-${Math.random()}.json`));
  const motion = new MotionExecutor(bus, directory);
  const rpc = new RpcBroker(bus, directory);
  const store = new SessionStore(mkdtempSync(join(tmpdir(), 'brain-test-')));
  const frames: BusMessage[] = [];
  bus.on('agent', (m) => { if (m.source === 'station') frames.push(m); });
  const obs: BusMessage[] = [];
  bus.on('obs', (m) => obs.push(m));

  const config = { brainModel: 'openai-compatible/faux@http://test', ...opts.config };
  const ctxs: Array<{ messages?: unknown[] }> = [];
  const deps: SessionDeps = {
    bus, directory, rpc, motion, store,
    getFaces: () => opts.faces as never,
    config: (k) => config[k as keyof typeof config],
    streamFn: ((_model: unknown, ctx: { messages?: unknown[] }, options?: { signal?: AbortSignal }) => {
      ctxs.push(ctx);
      const stream = createAssistantMessageEventStream();
      const script = scripts.shift();
      if (!script) throw new Error('script exhausted');
      script(stream, options?.signal);
      return stream;
    }) as never,
  };
  const session = new DockBrainSession(DOCK, deps);
  return { session, frames, obs, motion, store, bus, ctxs };
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

test('supersede: the new turn keeps its turnId — the old turn\'s unwind must not clobber it', async () => {
  // Regression (caught live on the emulator): handleTurnRequest used to await
  // only agent.waitForIdle(), so the SUPERSEDED turn's `finally` ran after the
  // new turn had started and wiped #activeTurnId — every speak frame of the
  // new turn then shipped with a dead turnId and the phone dropped the reply.
  let abortArmed: (() => void) | undefined;
  const { session, frames } = makeSession([
    // turn 1: stalls until aborted by the supersede
    (s, signal) => {
      s.push({ type: 'text_delta', contentIndex: 0, delta: 'Once upon a ', partial: assistant('Once upon a ') });
      signal?.addEventListener('abort', () => {
        const err = assistant('Once upon a ', 'aborted');
        s.push({ type: 'error', reason: 'aborted', error: err });
        s.end(err);
      });
      abortArmed?.();
    },
    // turn 2: a clean short reply
    (s) => {
      const done = assistant('Goodbye! ');
      s.push({ type: 'start', partial: assistant('') });
      s.push({ type: 'text_delta', contentIndex: 0, delta: 'Goodbye! ', partial: done });
      s.push({ type: 'done', reason: 'stop', message: done });
      s.end(done);
    },
  ]);

  const turn1 = session.handleTurnRequest({ turnId: 't1', trigger: { kind: 'user', text: 'long story' } });
  await new Promise<void>((resolve) => { abortArmed = resolve; });
  const turn2 = session.handleTurnRequest({ turnId: 't2', trigger: { kind: 'user', text: 'never mind, bye' } });
  await Promise.all([turn1, turn2]);

  // the new turn's reply made it out, addressed to the NEW turnId
  const speaks = frames.filter((f) => f.kind === 'speak')
    .map((f) => f.payload as { turnId: string; text: string });
  assert.deepEqual(speaks.map((s) => s.text), ['Goodbye!']);
  assert.ok(speaks.every((s) => s.turnId === 't2'), `speak turnIds: ${speaks.map((s) => s.turnId)}`);
  // terminal statuses: t1 cancelled (or silently dropped), t2 done — and the
  // LAST word on t2 is 'done', never clobbered by t1's unwind
  const t2Statuses = frames.filter((f) => f.kind === 'turn-status')
    .map((f) => f.payload as { turnId: string; state: string })
    .filter((p) => p.turnId === 't2');
  assert.equal(t2Statuses.at(-1)?.state, 'done');
});

test('vision: with no phone photo, the brain grabs the frame from the live SFU stream', async () => {
  const script: Script = (s) => {
    const done = assistant('I see things. ');
    s.push({ type: 'start', partial: assistant('') });
    s.push({ type: 'text_delta', contentIndex: 0, delta: 'I see things. ', partial: done });
    s.push({ type: 'done', reason: 'stop', message: done });
    s.end(done);
  };
  const grabbed: string[] = [];
  const { session, ctxs } = makeSession([script, script], {
    faces: { frame: (id: string) => { grabbed.push(id); return 'U0ZVRlJBTUU='; } },
  });

  // vision-intent + no imageBase64 → frame comes from the stream (the phone
  // peer's id is the streamId, resolved via the camera cap)
  await session.handleTurnRequest({ turnId: 't1', trigger: { kind: 'user', text: 'what do you see right now' } });
  assert.deepEqual(grabbed, ['phone-hw-1']);
  const msgs = ctxs.at(-1)!.messages as Array<{ role: string; content: Array<{ type: string; data?: string }> }>;
  const user = msgs.filter((m) => m.role === 'user').at(-1)!;
  assert.ok(user.content.some((c) => c.type === 'image' && c.data === 'U0ZVRlJBTUU='), 'image attached from SFU');

  // NON-vision turn: gated — no grab, no image
  await session.handleTurnRequest({ turnId: 't2', trigger: { kind: 'user', text: 'nod please' } });
  assert.equal(grabbed.length, 1);
  const user2 = (ctxs.at(-1)!.messages as Array<{ role: string; content: Array<{ type: string }> }>)
    .filter((m) => m.role === 'user').at(-1)!;
  assert.ok(!user2.content.some((c) => c.type === 'image'), 'no image on gated turn');
});

test('session lifecycle: persists across instances, idle close opens fresh with summary', async () => {
  const script: Script = (s) => {
    const done = assistant('Noted. ');
    s.push({ type: 'text_delta', contentIndex: 0, delta: 'Noted. ', partial: done });
    s.push({ type: 'done', reason: 'stop', message: done });
    s.end(done);
  };
  const { session, store } = makeSession([script, script]);
  await session.handleTurnRequest({ turnId: 't1', trigger: { kind: 'user', text: 'remember the cake' } });
  const sid1 = session.sessionId!;
  assert.ok(sid1);
  assert.equal(store.sessions(DOCK)[0]!.turns, 1);

  // idle boundary crossed (> SESSION_IDLE_MIN=30) → close with summary; next turn opens fresh
  session.maybeIdleClose(Date.now() + 31 * 60_000);
  const closed = store.sessions(DOCK).find((s2) => s2.sessionId === sid1)!;
  assert.ok(closed.closedAt != null);
  assert.match(closed.summary ?? '', /cake/);

  await session.handleTurnRequest({ turnId: 't2', trigger: { kind: 'user', text: 'fresh start' } });
  assert.notEqual(session.sessionId, sid1);
});

test('compaction: close upgrades the digest via one LLM call; the next session is seeded', async () => {
  const reply = (text: string): Script => (s) => {
    const done = assistant(text);
    s.push({ type: 'start', partial: assistant('') });
    s.push({ type: 'text_delta', contentIndex: 0, delta: text, partial: done });
    s.push({ type: 'done', reason: 'stop', message: done });
    s.end(done);
  };
  const { session, store, ctxs } = makeSession([
    reply('Nice to meet you, Guru! I will remember the cake is for Sia. '),
    // the compaction call (fires async on endSession)
    reply("Guru introduced himself; a cake is planned for Sia's birthday."),
    reply('Of course — the cake for Sia! '),
  ]);

  await session.handleTurnRequest({
    turnId: 't1',
    trigger: { kind: 'user', text: "I'm Guru and the cake in the fridge is for Sia's birthday, keep it secret" },
  });
  const sid1 = session.sessionId!;
  session.endSession('test');
  // close is instant (tail digest); the LLM note lands asynchronously
  await new Promise((r) => setTimeout(r, 50));
  const closed = store.sessions(DOCK).find((m) => m.sessionId === sid1)!;
  assert.equal(closed.summary, "Guru introduced himself; a cake is planned for Sia's birthday.");

  // a FRESH session's system prompt carries the note as memory
  await session.handleTurnRequest({ turnId: 't2', trigger: { kind: 'user', text: 'what was the plan again?' } });
  assert.notEqual(session.sessionId, sid1);
  const sys = (ctxs.at(-1) as { systemPrompt?: string }).systemPrompt ?? '';
  assert.ok(sys.includes("a cake is planned for Sia's birthday"), `memory missing from prompt: ${sys.slice(-300)}`);
});

test('brainGrants: a granted dock gets a move_<target> tool that drives the OTHER dock; ungranted has none', async () => {
  const roverBody: RosterEntry = {
    role: 'device', id: 'rover-hw-1', dock: 'rover', component: 'body',
    kind: 'rover-fw', caps: ['servo'],
    lastSeen: Date.now(), connectedAt: Date.now(), topics: ['bodylink'],
  };
  const callMoveRover: Script = (s) => {
    const m = assistant('');
    m.content.push({ type: 'toolCall', id: 'call-1', name: 'move_rover',
      arguments: { steps: [{ part: 'neck', degrees: 10, duration_ms: 200 }] } } as never);
    m.stopReason = 'toolUse';
    s.push({ type: 'toolcall_end', contentIndex: 0, toolCall: m.content[0] as never, partial: m });
    s.push({ type: 'done', reason: 'toolUse', message: m });
    s.end(m);
  };
  const wrapUp: Script = (s) => {
    const done = assistant('Rolling! ');
    s.push({ type: 'start', partial: assistant('') });
    s.push({ type: 'text_delta', contentIndex: 0, delta: 'Rolling! ', partial: done });
    s.push({ type: 'done', reason: 'stop', message: done });
    s.end(done);
  };

  const { session, frames, bus, ctxs } = makeSession([callMoveRover, wrapUp], {
    peers: [roverBody],
    config: { brainGrants: { [DOCK]: { rover: ['servo'] } } },
  });
  const bodyCmds: BusMessage[] = [];
  bus.on('bodylink', (m) => { if (m.kind === 'command') bodyCmds.push(m); });

  await session.handleTurnRequest({ turnId: 't1', trigger: { kind: 'user', text: 'send the rover forward' } });
  assert.equal(statusOf(frames).at(-1), 'done');
  // the command went to the ROVER's body, not ours
  assert.ok(bodyCmds.length >= 1, 'no body command published');
  assert.deepEqual(bodyCmds[0]!.toAddr, { dock: 'rover', component: 'body' });
  // and the granted tool was actually offered to the model
  const tools = (ctxs.at(-1) as { tools?: Array<{ name: string }> }).tools ?? [];
  assert.ok(tools.some((t) => t.name === 'move_rover'), 'move_rover not offered');

  // ungranted dock: no cross-dock tool exposed
  const plain = makeSession([wrapUp], { peers: [roverBody] });
  await plain.session.handleTurnRequest({ turnId: 't1', trigger: { kind: 'user', text: 'hi' } });
  const plainTools = (plain.ctxs.at(-1) as { tools?: Array<{ name: string }> }).tools ?? [];
  assert.ok(!plainTools.some((t) => t.name === 'move_rover'), 'tool leaked without a grant');
});

test('obs events carry dock as source and the Turn/Step vocabulary', async () => {
  const script: Script = (s) => {
    const done = assistant('Hi. ');
    s.push({ type: 'start', partial: assistant('') });
    s.push({ type: 'text_delta', contentIndex: 0, delta: 'Hi. ', partial: done });
    s.push({ type: 'done', reason: 'stop', message: done });
    s.end(done);
  };
  const { session, obs } = makeSession([script, script]);
  await session.handleTurnRequest({ turnId: 't1', trigger: { kind: 'user', text: 'hi' } });
  const kinds = obs.map((o) => (o.payload as { kind: string }).kind);
  for (const expected of ['TurnStart', 'StepStart', 'MessageUpdate', 'StepEnd', 'TurnEnd']) {
    assert.ok(kinds.includes(expected), `missing ${expected} in ${kinds.join(',')}`);
  }
  for (const o of obs) assert.equal(o.source, DOCK); // multi-tenant: dock, not 'station'

  // Regression: each TurnStart must carry ITS OWN trigger text. pi emits
  // agent_start before appending the prompt's user message, so deriving the
  // text from agent history labeled turn N with turn N-1's utterance (seen
  // live: the "do a little dance" turn titled "make a sad face").
  await session.handleTurnRequest({ turnId: 't2', trigger: { kind: 'user', text: 'do a little dance' } });
  const starts = obs
    .map((o) => o.payload as { kind: string; data?: { trigger?: { text?: string } } })
    .filter((p) => p.kind === 'TurnStart')
    .map((p) => p.data?.trigger?.text);
  assert.deepEqual(starts, ['hi', 'do a little dance']);
});

test('google free-key quota → auto-retry on the paid account → turn succeeds', async () => {
  const prevPaid = process.env.GEMINI_API_KEY_PAID_ACC;
  const prevFree = process.env.GEMINI_API_KEY;
  process.env.GEMINI_API_KEY = 'free';
  process.env.GEMINI_API_KEY_PAID_ACC = 'paid';
  try {
    // call #1: the free key 429s; call #2 (paid): a normal reply.
    const fail = (s: AssistantMessageEventStream) => {
      const m = assistant('', 'stop');
      (m as { errorMessage?: string }).errorMessage =
        '{"error":{"code":429,"status":"RESOURCE_EXHAUSTED"}}';
      s.push({ type: 'done', reason: 'stop', message: m });
      s.end(m);
    };
    const ok = (s: AssistantMessageEventStream) => {
      const partial = assistant('');
      s.push({ type: 'start', partial });
      s.push({ type: 'text_delta', contentIndex: 0, delta: 'Hello there. ', partial: assistant('Hello there. ') });
      const done = assistant('Hello there. ');
      s.push({ type: 'done', reason: 'stop', message: done });
      s.end(done);
    };
    const { session, frames } = makeSession([fail, ok], {
      config: { brainModel: 'google/gemini-2.5-flash' },
    });
    await session.handleTurnRequest({ turnId: 't1', trigger: { kind: 'user', text: 'hi' } });
    const last = frames.filter((f) => f.kind === 'turn-status').at(-1)!.payload as { state: string };
    assert.equal(last.state, 'done'); // the paid retry rescued the turn (would be 'failed' without fallback)
    assert.ok(speakFrames(frames).join(' ').includes('Hello there'), 'the paid retry response was spoken');
  } finally {
    if (prevPaid === undefined) delete process.env.GEMINI_API_KEY_PAID_ACC; else process.env.GEMINI_API_KEY_PAID_ACC = prevPaid;
    if (prevFree === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = prevFree;
  }
});

test('google quota with NO paid key → fails (no infinite retry)', async () => {
  const prevPaid = process.env.GEMINI_API_KEY_PAID_ACC;
  delete process.env.GEMINI_API_KEY_PAID_ACC;
  try {
    const fail = (s: AssistantMessageEventStream) => {
      const m = assistant('', 'stop');
      (m as { errorMessage?: string }).errorMessage = '429 RESOURCE_EXHAUSTED';
      s.push({ type: 'error', reason: 'error', error: m });
      s.end(m);
    };
    // only ONE script entry: if it retried, the harness would throw "script exhausted"
    const { session, frames } = makeSession([fail], {
      config: { brainModel: 'google/gemini-2.5-flash' },
    });
    await session.handleTurnRequest({ turnId: 't1', trigger: { kind: 'user', text: 'hi' } });
    const last = frames.filter((f) => f.kind === 'turn-status').at(-1)!.payload as { state: string; code?: string };
    assert.equal(last.state, 'failed');
  } finally {
    if (prevPaid === undefined) delete process.env.GEMINI_API_KEY_PAID_ACC; else process.env.GEMINI_API_KEY_PAID_ACC = prevPaid;
  }
});

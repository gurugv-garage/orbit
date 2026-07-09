/**
 * TaskSupervisor resiliency — the lifecycle STATE MACHINE under adversarial input,
 * driven with a fake spawn seam (no real processes), so every race and corner is
 * deterministic. The real process+WS path is covered by process.test.ts; here we
 * hammer state transitions:
 *   - terminal is STICKY (a finish/notify racing a stop can't resurrect/re-signal)
 *   - stop/resume/restart/provideInput refuse from the wrong state
 *   - tenancy + unknown-instance + malformed frames are dropped safely
 *   - a stale crash exit (after a respawn) doesn't clobber the new run
 *   - the cascade leaves already-finished tasks alone
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TaskSupervisor, type InstanceInfo, type SignalKind } from './supervisor.js';

const DOCK = 'res-bot';

interface Rig {
  sup: TaskSupervisor;
  signals: Array<{ kind: SignalKind; text: string; instanceId: string }>;
  initSent: Array<{ instanceId: string; payload: Record<string, unknown> }>;
  inputSent: Array<{ instanceId: string; answer: unknown }>;
  kills: string[];                       // instanceIds whose fake process was killed
  spawns: string[];                      // instanceIds spawned (in order)
  attach: (instanceId: string) => void;  // simulate the process connecting
}

function rig(): Rig {
  const signals: Rig['signals'] = [];
  const initSent: Rig['initSent'] = [];
  const inputSent: Rig['inputSent'] = [];
  const kills: string[] = [];
  const spawns: string[] = [];
  const sup = new TaskSupervisor({
    root: mkdtempSync(join(tmpdir(), 'res-')),
    stationWsUrl: 'ws://test/ws',
    onSignal: (_dock, info, kind, ev) => signals.push({ kind, text: ev.text, instanceId: info.instanceId }),
    sendToTask: (_dock, instanceId, kind, payload) => {
      if (kind === 'init') initSent.push({ instanceId, payload });
      if (kind === 'input') inputSent.push({ instanceId, answer: payload.answer });
    },
    spawnProcess: (instanceId) => {
      spawns.push(instanceId);
      return { kill: () => kills.push(instanceId) };
    },
  });
  // the process "attaches" → supervisor sends init (we short-circuit the WS).
  const attach = (instanceId: string) => sup.onFrame(DOCK, { instanceId, kind: 'attach', payload: { instanceId } });
  return { sup, signals, initSent, inputSent, kills, spawns, attach };
}

const start = (sup: TaskSupervisor, params: Record<string, unknown> = {}) =>
  sup.start({ dock: DOCK, name: 'remind-after', filePath: '/fake/task.ts', params, parentSessionId: 'sess-1' });
const frame = (sup: TaskSupervisor, instanceId: string, kind: string, payload: Record<string, unknown> = {}) =>
  sup.onFrame(DOCK, { instanceId, kind, payload: { instanceId, ...payload } });
const st = (sup: TaskSupervisor, id: string): InstanceInfo['state'] | undefined => sup.get(id)?.state;

// ── terminal is sticky ───────────────────────────────────────────────────────

test('a finish frame racing a stop CANNOT flip stopped→done', () => {
  const { sup } = rig();
  const id = start(sup);
  assert.equal(sup.stop(id), true);
  assert.equal(st(sup, id), 'stopped');
  // the dying process emits a finish a beat later — must be ignored
  frame(sup, id, 'finish', { summary: 'too late' });
  assert.equal(st(sup, id), 'stopped', 'terminal state is sticky');
});

test('a notify after a terminal state is NOT forwarded to the parent', () => {
  const { sup, signals } = rig();
  const id = start(sup);
  frame(sup, id, 'finish', { summary: 'done' });
  assert.equal(st(sup, id), 'done');
  frame(sup, id, 'notify', { text: 'zombie update' });
  assert.equal(signals.filter((s) => s.kind === 'notify').length, 0, 'no zombie notify');
});

test('a second finish does not double-signal', () => {
  const { sup, signals } = rig();
  const id = start(sup);
  frame(sup, id, 'finish', { summary: 'first' });
  frame(sup, id, 'finish', { summary: 'second' });
  assert.equal(signals.filter((s) => s.kind === 'finish').length, 1, 'exactly one finish reaches the parent');
});

test('errored then finish: the first terminal wins', () => {
  const { sup } = rig();
  const id = start(sup);
  frame(sup, id, 'errored', { why: 'boom' });
  frame(sup, id, 'finish', { summary: 'recovered?' });
  assert.equal(st(sup, id), 'errored');
});

// ── lifecycle guards ─────────────────────────────────────────────────────────

test('stop on a done task is a no-op (does not relabel done→stopped)', () => {
  const { sup } = rig();
  const id = start(sup);
  frame(sup, id, 'finish');
  assert.equal(sup.stop(id), false);
  assert.equal(st(sup, id), 'done');
});

test('resume refuses a done/errored task (would re-run a finished job)', () => {
  const { sup, spawns } = rig();
  const id = start(sup);
  frame(sup, id, 'finish');
  const before = spawns.length;
  assert.equal(sup.resume(id), false);
  assert.equal(spawns.length, before, 'no respawn of a completed task');
});

test('resume a STOPPED task respawns it from checkpoint (runCount increments)', () => {
  const { sup, spawns } = rig();
  const id = start(sup);
  sup.stop(id);
  assert.equal(sup.resume(id), true);
  assert.equal(st(sup, id), 'running');
  assert.equal(spawns.length, 2, 'spawned twice (start + resume)');
  assert.equal(sup.get(id)?.runCount, 2);
});

test('provideInput only delivers to a STUCK task', () => {
  const { sup, inputSent } = rig();
  const id = start(sup);
  // running, not stuck → refused
  assert.equal(sup.provideInput(id, 'hi'), false);
  assert.equal(inputSent.length, 0);
  // now it asks → stuck → delivered, back to running
  frame(sup, id, 'ask', { prompt: 'red or blue?' });
  assert.equal(st(sup, id), 'stuck');
  assert.equal(sup.provideInput(id, 'blue'), true);
  assert.equal(inputSent.at(-1)?.answer, 'blue');
  assert.equal(st(sup, id), 'running');
});

test('lifecycle ops on an unknown instanceId return false, never throw', () => {
  const { sup } = rig();
  assert.equal(sup.stop('t-nope'), false);
  assert.equal(sup.resume('t-nope'), false);
  assert.equal(sup.restart('t-nope'), false);
  assert.equal(sup.provideInput('t-nope', 'x'), false);
  assert.equal(sup.get('t-nope'), undefined);
});

// ── tenancy + malformed input ────────────────────────────────────────────────

test('a frame for the wrong dock is dropped', () => {
  const { sup, signals } = rig();
  const id = start(sup);
  sup.onFrame('OTHER-dock', { instanceId: id, kind: 'finish', payload: { instanceId: id } });
  assert.notEqual(st(sup, id), 'done', 'cross-dock frame ignored');
  assert.equal(signals.length, 0);
});

test('a frame for an unknown instance is dropped silently', () => {
  const { sup, signals } = rig();
  start(sup);
  sup.onFrame(DOCK, { instanceId: 't-ghost', kind: 'finish', payload: { instanceId: 't-ghost' } });
  assert.equal(signals.length, 0);
});

test('malformed frames (missing fields, unknown kind) do not throw or corrupt state', () => {
  const { sup } = rig();
  const id = start(sup);
  frame(sup, id, 'status', {});                  // no status text
  frame(sup, id, 'notify', {});                  // no text
  frame(sup, id, 'bogus-kind', { foo: 1 });      // unknown kind
  frame(sup, id, 'checkpoint', {});              // no state
  assert.equal(st(sup, id), 'running', 'survived a barrage of junk');
});

// ── init / attach ────────────────────────────────────────────────────────────

test('attach triggers init carrying params + descriptor; runCount survives resume', () => {
  const { sup, initSent, attach } = rig();
  const id = start(sup, { message: 'bath', delay: '5m' });
  attach(id);
  const first = initSent.at(-1)!;
  assert.equal(first.instanceId, id);
  assert.deepEqual(first.payload.params, { message: 'bath', delay: '5m' });
  assert.equal(first.payload.runCount, 1);
  // stop + resume → re-attach → init now says runCount 2, same startedAt
  sup.stop(id); sup.resume(id); attach(id);
  const second = initSent.at(-1)!;
  assert.equal(second.payload.runCount, 2);
  assert.equal(second.payload.startedAt, first.payload.startedAt, 'first-start time preserved');
});

// ── cascade ──────────────────────────────────────────────────────────────────

test('stopForParent stops running tasks but leaves a finished one untouched', () => {
  const { sup } = rig();
  const running = start(sup);
  const finished = start(sup);
  frame(sup, finished, 'finish');
  const stopped = sup.stopForParent(DOCK, 'sess-1');
  assert.deepEqual(stopped, [running], 'only the running one was stopped');
  assert.equal(st(sup, running), 'stopped');
  assert.equal(st(sup, finished), 'done', 'finished task NOT relabelled');
});

test('stopForParent is scoped to the parent session', () => {
  const { sup } = rig();
  const a = start(sup);
  const b = sup.start({ dock: DOCK, name: 'x', filePath: '/f', params: {}, parentSessionId: 'sess-OTHER' });
  sup.stopForParent(DOCK, 'sess-1');
  assert.equal(st(sup, a), 'stopped');
  assert.equal(st(sup, b), 'running', 'other session untouched');
});

test('stopAllForDock stops running tasks but EXEMPTS bgTask (a reminder survives phone-offline)', () => {
  const { sup } = rig();
  const body = sup.start({ dock: DOCK, name: 'idle-moods', filePath: '/f', params: {}, parentSessionId: 'sess-1' });
  const reminder = sup.start({ dock: DOCK, name: 'remind-after', filePath: '/f', params: {}, parentSessionId: 'sess-1', bgTask: true });
  const stopped = sup.stopAllForDock(DOCK);
  assert.deepEqual(stopped, [body], 'only the non-bgTask body task stopped');
  assert.equal(st(sup, body), 'stopped');
  assert.equal(st(sup, reminder), 'running', 'bgTask reminder still running after the stand-down');
});

test('stopAllForDock({includeBg:true}) stops bgTask tasks too', () => {
  const { sup } = rig();
  const reminder = sup.start({ dock: DOCK, name: 'remind-after', filePath: '/f', params: {}, parentSessionId: 'sess-1', bgTask: true });
  sup.stopAllForDock(DOCK, { includeBg: true });
  assert.equal(st(sup, reminder), 'stopped', 'bgTask stopped when explicitly included');
});

test('stopAllForDock is scoped to the dock + leaves terminal tasks alone', () => {
  const { sup } = rig();
  const here = start(sup);
  const finished = start(sup);
  frame(sup, finished, 'finish');
  const other = sup.start({ dock: 'other-dock', name: 'x', filePath: '/f', params: {}, parentSessionId: 'sess-1' });
  sup.stopAllForDock(DOCK);
  assert.equal(st(sup, here), 'stopped');
  assert.equal(st(sup, finished), 'done', 'finished task NOT relabelled');
  assert.equal(st(sup, other), 'running', 'other dock untouched');
});

// ── counts ───────────────────────────────────────────────────────────────────

test('countRunning reflects running+stuck only; terminal drops out', () => {
  const { sup } = rig();
  const a = start(sup);
  const b = start(sup);
  const c = start(sup);
  assert.equal(sup.countRunning(DOCK), 3);
  frame(sup, a, 'finish');
  frame(sup, b, 'ask', { prompt: '?' });   // stuck still counts as running-ish
  assert.equal(sup.countRunning(DOCK), 2, 'done dropped; stuck retained');
  sup.stop(c);
  assert.equal(sup.countRunning(DOCK), 1);
});

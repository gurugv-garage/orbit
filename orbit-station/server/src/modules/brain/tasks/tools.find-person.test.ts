/**
 * find_person tool — the named-follow convenience over run_task('face-follow', {target}).
 * Verifies the three behaviours that matter (driven with the supervisor's fake spawn seam,
 * so no real process launches):
 *   - UNKNOWN name → refuses + says who it DOES know (does NOT start a follow)
 *   - KNOWN name → starts face-follow in named mode (target = the person)
 *   - KNOWN name while one is already running → RE-TARGETS (stops the old, starts one new)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TaskSupervisor } from './supervisor.js';
import { buildTaskTools } from './tools.js';

const DOCK = 'find-bot';
// the real packaged task tree (find_person resolves the face-follow def from here).
const TASKS_ROOT = resolve(fileURLToPath(new URL('../../../tasks/packaged', import.meta.url)));

interface Rig { tools: ReturnType<typeof buildTaskTools>; spawns: string[]; kills: string[]; sup: TaskSupervisor }

function rig(opts: { known: string[] } = { known: [] }): Rig {
  const spawns: string[] = []; const kills: string[] = [];
  const sup = new TaskSupervisor({
    root: mkdtempSync(join(tmpdir(), 'fp-')),
    stationWsUrl: 'ws://test/ws',
    onSignal: () => {},
    sendToTask: () => {},
    spawnProcess: (instanceId) => { spawns.push(instanceId); return { kill: () => kills.push(instanceId) }; },
  });
  const knownLc = opts.known.map((n) => n.toLowerCase());
  const tools = buildTaskTools({
    dock: DOCK, supervisor: sup, tasksRoot: TASKS_ROOT, userTasksRoot: mkdtempSync(join(tmpdir(), 'fpu-')),
    parentSessionId: () => 'sess-1', config: (k) => (k === 'brainTaskMax' ? 3 : undefined),
    knowsPerson: (name) => knownLc.includes(name.trim().toLowerCase()),
    knownNames: () => opts.known,
  });
  return { tools, spawns, kills, sup };
}

const findPerson = (r: Rig) => r.tools.find((t) => t.name === 'find_person')!;
const call = async (r: Rig, name: string) => {
  const res = await findPerson(r).execute('id', { name }) as { content: Array<{ text: string }> };
  return res.content[0]!.text;
};

test('find_person exists when tasks are enabled', () => {
  assert.ok(findPerson(rig()), 'find_person tool is registered');
});

test('UNKNOWN person → refuses, names who it knows, starts NOTHING', async () => {
  const r = rig({ known: ['Guru', 'Aanya'] });
  const txt = await call(r, 'Bob');
  assert.match(txt, /don't recognize|don.t recognize/i);
  assert.match(txt, /Guru/); // tells the user who it CAN find
  assert.equal(r.spawns.length, 0, 'did not launch a follow for an unknown person');
});

test('KNOWN person → starts face-follow in NAMED mode', async () => {
  const r = rig({ known: ['Guru'] });
  const txt = await call(r, 'Guru');
  assert.match(txt, /started|re-pointed/i);
  assert.equal(r.spawns.length, 1, 'launched exactly one follow');
  const inst = r.sup.list(DOCK)[0]!;
  assert.equal(inst.name, 'face-follow');
  assert.equal(inst.params.target, 'Guru', 'named mode: target is the person');
});

test('RE-TARGET: a second find_person stops the old follow and starts one new', async () => {
  const r = rig({ known: ['Guru', 'Aanya'] });
  await call(r, 'Guru');
  await call(r, 'Aanya');
  assert.equal(r.spawns.length, 2, 'two launches total (start, then re-target)');
  assert.equal(r.kills.length, 1, 'the first follow was stopped on re-target');
  const running = r.sup.list(DOCK).filter((i) => i.state !== 'stopped');
  assert.equal(running.length, 1, 'only ONE follow running after re-target (no stacking)');
  assert.equal(running[0]!.params.target, 'Aanya', 're-pointed at the new person');
});

test('case-insensitive known-check', async () => {
  const r = rig({ known: ['Guru'] });
  const txt = await call(r, 'guru');
  assert.match(txt, /started|re-pointed/i);
  assert.equal(r.spawns.length, 1);
});

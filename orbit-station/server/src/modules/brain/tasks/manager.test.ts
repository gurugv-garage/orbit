/**
 * Task manager — loads the real shipped definitions STATICALLY (never executes a
 * task.ts, since running one connects to the station), validates write (typecheck
 * + class/manifest shape) with rollback, path-guards removal, builds the prompt
 * block, and resolves generated-over-packaged.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  loadTaskDefs, loadTaskDef, writeTaskDef, removeTaskDef, taskPromptBlock, defaultTasksRoot, extractGoal,
  loadAllTaskDefs, findTaskDef,
} from './manager.js';

const SHIPPED = defaultTasksRoot();                 // .../src/tasks/packaged
// absolute path to the real harness — for tasks written to TEMP dirs.
const HARNESS = join(SHIPPED, '..', '_harness', 'index.js');

/** a minimal valid task.ts in the class form, importing the real harness. */
function validTask(name: string, description = 'ok'): string {
  return `
import { Task, runTask, type TaskManifest } from '${HARNESS}';
export const manifest = { name: '${name}', description: '${description}', params: [] } satisfies TaskManifest;
class T extends Task {
  async run(): Promise<void> { this.finish(); }
  getStatus(): string { return 'ok'; }
}
runTask(T);
`;
}

test('loads every PACKAGED definition with name + manifest + goal', async () => {
  const defs = await loadTaskDefs(SHIPPED);
  const names = defs.map((d) => d.name).sort();
  for (const expected of ['remind-after', 'remind-every']) {
    assert.ok(names.includes(expected), `missing ${expected}`);
  }
  const re = defs.find((d) => d.name === 'remind-every')!;
  assert.match(re.goal, /remind/i);                    // doc-comment goal extracted
  assert.equal(re.manifest.params?.[0]?.name, 'message');
});

test('_harness is NOT loaded as a task', async () => {
  const defs = await loadTaskDefs(SHIPPED);
  assert.equal(defs.find((d) => d.name === '_harness'), undefined);
});

test('taskPromptBlock lists names + descriptions', async () => {
  const defs = await loadTaskDefs(SHIPPED);
  const block = taskPromptBlock(defs);
  assert.match(block, /remind-every:/);
  assert.match(block, /REUSE/);
});

test('extractGoal pulls the leading doc-comment', () => {
  const goal = extractGoal('/**\n * # x\n * GOAL: do a thing.\n */\nexport const manifest = {};');
  assert.match(goal, /GOAL: do a thing/);
});

test('writeTaskDef validates by typecheck+shape and rolls back a broken file', async () => {
  const root = mkdtempSync(join(tmpdir(), 'taskdefs-'));
  const created = await writeTaskDef(root, 'tmp-good', validTask('tmp-good'));
  assert.equal(created.name, 'tmp-good');
  assert.equal(created.filePath, join(root, 'tmp-good', 'task.ts'));
  assert.ok(existsSync(created.filePath));

  // a broken one (no manifest / no class) throws and leaves nothing behind
  const bad = `export const x = 42;`;
  await assert.rejects(() => writeTaskDef(root, 'tmp-bad', bad), /manifest|extends Task|runTask|type error/i);
  assert.equal(existsSync(join(root, 'tmp-bad')), false, 'broken def rolled back');
});

test('removeTaskDef is path-containment guarded', async () => {
  const root = mkdtempSync(join(tmpdir(), 'taskdefs-'));
  await writeTaskDef(root, 'tmp-rm', validTask('tmp-rm'));
  assert.equal(removeTaskDef(root, '../escape'), false);   // containment
  assert.equal(removeTaskDef(root, '_harness'), false);    // not a task dir
  assert.equal(removeTaskDef(root, 'tmp-rm'), true);
  assert.equal(existsSync(join(root, 'tmp-rm')), false);
});

test('loadTaskDef throws a clear error for a missing manifest', async () => {
  const root = mkdtempSync(join(tmpdir(), 'taskdefs-'));
  await assert.rejects(() => loadTaskDef(root, 'nope'));
});

// ── packaged vs generated: search order + source labels ──────────────────────

test('generated tasks win over packaged when names collide; each is source-tagged', async () => {
  const gen = mkdtempSync(join(tmpdir(), 'gen-'));
  await writeTaskDef(gen, 'remind-after', validTask('remind-after', 'GENERATED override'));

  const roots = [
    { root: gen, source: 'generated' as const },
    { root: SHIPPED, source: 'packaged' as const },
  ];

  const found = await findTaskDef(roots, 'remind-after');
  assert.equal(found.description, 'GENERATED override');
  assert.equal(found.source, 'generated');

  const all = await loadAllTaskDefs(roots);
  const ra = all.filter((d) => d.name === 'remind-after');
  assert.equal(ra.length, 1, 'collision deduped to one');
  assert.equal(ra[0]!.source, 'generated');
  const re = all.find((d) => d.name === 'remind-every')!;
  assert.equal(re.source, 'packaged');
});

test('packaged is found when there is no generated override', async () => {
  const gen = mkdtempSync(join(tmpdir(), 'gen-empty-'));
  const roots = [
    { root: gen, source: 'generated' as const },
    { root: SHIPPED, source: 'packaged' as const },
  ];
  const found = await findTaskDef(roots, 'remind-every');
  assert.equal(found.source, 'packaged');
});

// ── authoring: typecheck-on-write + imports ──────────────────────────────────

test('writeTaskDef typechecks the body — rejects a call to a non-existent Task method', async () => {
  const { userTasksRoot } = await import('./manager.js');
  const { authorTaskSource } = await import('./scaffold.js');
  const root = userTasksRoot();                      // real generated root (relative import resolves)
  const src = authorTaskSource({
    name: 'tc-bogus', description: 'x', goal: 'x',
    body: `await this.runCommand('ls'); this.finish();`,   // this.runCommand does NOT exist
  }, '../../_harness/index.js');
  await assert.rejects(() => writeTaskDef(root, 'tc-bogus', src), /runCommand|type error/i);
  rmSync(join(root, 'tc-bogus'), { recursive: true, force: true });
});

test('writeTaskDef ACCEPTS a task that imports node:child_process and runs a shell command', async () => {
  const { userTasksRoot } = await import('./manager.js');
  const { authorTaskSource } = await import('./scaffold.js');
  const root = userTasksRoot();
  const src = authorTaskSource({
    name: 'tc-shell', description: 'x', goal: 'x',
    imports: [`import { execSync } from 'node:child_process'`],
    body: `const out = execSync('echo hi').toString(); this.status(out); this.finish();`,
  }, '../../_harness/index.js');
  const created = await writeTaskDef(root, 'tc-shell', src);
  assert.equal(created.name, 'tc-shell');
  rmSync(join(root, 'tc-shell'), { recursive: true, force: true });
});

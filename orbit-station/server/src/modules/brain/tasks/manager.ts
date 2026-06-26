/**
 * Task definition manager — `skills.ts` for task processes. Definitions are single
 * `task.ts` files (a `manifest`, a `class extends Task`, and a trailing
 * `runTask(...)`). A task RUNS as its own process, so we never execute the file to
 * load it — that would connect to the station. Instead we STATICALLY read the
 * manifest + goal from source and TYPECHECK it on write. Removal is
 * path-containment guarded. The `_harness/` and `_*` folders are not tasks.
 */
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import type { TaskManifest } from '../../../tasks/_harness/index.js';

export type TaskSource = 'packaged' | 'generated';

export interface TaskDef {
  name: string;
  description: string;
  manifest: TaskManifest;
  /** the human-readable goal from the top doc-comment (for reuse discovery). */
  goal: string;
  /** absolute path of the task.ts — what the supervisor spawns. */
  filePath: string;
  /** where it lives: 'packaged' (committed src/tasks) or 'generated' (LLM-authored,
   *  not committed). */
  source?: TaskSource;
}

/** PACKAGED task definitions — committed, hand-vetted: src/tasks/packaged/. */
export function defaultTasksRoot(): string {
  return resolve(new URL('../../../tasks/packaged', import.meta.url).pathname);
}

/** GENERATED task definitions — LLM-authored, gitignored: src/tasks/generated/.
 *  (The dev server's file-watcher ignores this dir so authoring one doesn't
 *  restart it mid-turn — see package.json `dev`.) */
export function userTasksRoot(): string {
  return resolve(new URL('../../../tasks/generated', import.meta.url).pathname);
}

/** The harness import specifier for a GENERATED task. Both packaged/<t>/ and
 *  generated/<t>/ sit at the same depth under src/tasks, so a plain relative
 *  '../../_harness/index.js' resolves for either. */
export function harnessImportPath(): string {
  return '../../_harness/index.js';
}

function isTaskDir(name: string): boolean {
  return !name.startsWith('_') && !name.startsWith('.');
}

/** Extract the leading block-comment "GOAL" prose (or the whole top comment). */
export function extractGoal(source: string): string {
  const m = source.match(/\/\*\*([\s\S]*?)\*\//);
  if (!m) return '';
  const body = m[1]!.split('\n').map((l) => l.replace(/^\s*\*\s?/, '').trimEnd()).join('\n').trim();
  return body;
}

/** Load ONE definition by name — STATICALLY (never executes the file). Throws if
 *  it doesn't exist or is missing the required shape (manifest + class + runTask). */
export async function loadTaskDef(root: string, name: string): Promise<TaskDef> {
  const filePath = join(root, name, 'task.ts');
  const source = readFileSync(filePath, 'utf8');
  const manifest = extractManifest(source);
  if (!manifest || typeof manifest.name !== 'string' || typeof manifest.description !== 'string') {
    throw new Error(`task "${name}": missing or invalid \`export const manifest\` (name + description required)`);
  }
  if (!/class\s+\w+\s+extends\s+Task\b/.test(source) || !/\brunTask\s*\(/.test(source)) {
    throw new Error(`task "${name}": must declare \`class … extends Task\` and end with \`runTask(…)\``);
  }
  return { name: manifest.name, description: manifest.description, manifest, goal: extractGoal(source), filePath };
}

/** Statically read `export const manifest = { … } satisfies TaskManifest;` from
 *  source by evaluating just the object literal in a sandbox-free Function. Returns
 *  undefined if it can't be parsed (the typecheck on write is the real guard). */
function extractManifest(source: string): TaskManifest | undefined {
  const m = source.match(/export\s+const\s+manifest\s*=\s*(\{[\s\S]*?\})\s*(?:satisfies\s+\w+)?\s*;/);
  if (!m) return undefined;
  try {
    // the literal is plain data (name/description/params); evaluate it in isolation.
    return Function(`"use strict";return (${m[1]});`)() as TaskManifest;
  } catch { return undefined; }
}

/** Load every definition under the root (skips _harness etc.). Bad ones are
 *  skipped with a console warning rather than failing the whole load. */
export async function loadTaskDefs(root: string): Promise<TaskDef[]> {
  let dirs: string[];
  try {
    dirs = readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory() && isTaskDir(d.name)).map((d) => d.name);
  } catch { return []; }
  const out: TaskDef[] = [];
  for (const name of dirs) {
    try { out.push(await loadTaskDef(root, name)); }
    catch (err) { console.warn(`[tasks] skipping "${name}": ${String(err)}`); }
  }
  return out;
}

/** A search root tagged with where its tasks come from. */
export interface LabeledRoot { root: string; source: TaskSource }

/** Load definitions from labeled roots in ORDER — the FIRST root to define a name
 *  WINS (so list generated-first to prefer recently-authored tasks). Each def is
 *  tagged with its source. Missing roots are skipped. */
export async function loadAllTaskDefs(roots: LabeledRoot[]): Promise<TaskDef[]> {
  const byName = new Map<string, TaskDef>();
  for (const { root, source } of roots) {
    for (const d of await loadTaskDefs(root)) {
      if (!byName.has(d.name)) byName.set(d.name, { ...d, source }); // first wins
    }
  }
  return [...byName.values()];
}

/** Find ONE definition by name across labeled roots (first match wins). Tags the
 *  returned def with its source. Throws if none. */
export async function findTaskDef(roots: LabeledRoot[], name: string): Promise<TaskDef> {
  for (const { root, source } of roots) {
    try { return { ...(await loadTaskDef(root, name)), source }; } catch { /* try next */ }
  }
  throw new Error(`no task definition named "${name}"`);
}

/** Progressive-disclosure block for the system prompt (mirrors skills). */
export function taskPromptBlock(defs: TaskDef[]): string {
  if (defs.length === 0) {
    return 'You currently have NO background tasks defined. A task is a job you can run and supervise as a background process. If asked, say you can create one.';
  }
  const list = defs.map((d) => `- ${d.name}: ${d.description}`).join('\n');
  return 'You can run BACKGROUND TASKS — long-running jobs supervised as separate processes. '
    + 'Browse and REUSE an existing task before writing a new one; address running jobs by their instanceId.\n'
    + `Available task definitions:\n${list}`;
}

/** Write a new (or overwrite an existing) definition's task.ts, then validate by
 *  TYPECHECK + static shape-check (never executes it — running a task connects to
 *  the station). Rolls back on failure. Returns name. */
export async function writeTaskDef(root: string, name: string, source: string): Promise<{ name: string; filePath: string }> {
  if (!/^[a-z0-9-]{1,64}$/.test(name)) throw new Error(`bad task name "${name}" (kebab-case, 1–64 chars)`);
  const dir = join(root, name);
  const filePath = join(dir, 'task.ts');
  let existed = false;
  try { readFileSync(filePath); existed = true; } catch { /* new */ }
  const backup = existed ? readFileSync(filePath, 'utf8') : undefined;

  mkdirSync(dir, { recursive: true });
  writeFileSync(filePath, source);
  const rollback = () => {
    if (backup !== undefined) writeFileSync(filePath, backup);
    else rmSync(dir, { recursive: true, force: true });
  };
  try {
    // 1) TYPECHECK the file and report diagnostics — catches typos, wrong types,
    //    calling a method that doesn't exist on the Task base class, etc. This is
    //    the real correctness gate (the file is never executed to validate).
    const diags = typecheckTaskFile(filePath);
    if (diags) throw new Error(`task "${name}" has type errors:\n${diags}`);
    // 2) shape-check (static): valid manifest + `class extends Task` + runTask(…).
    const def = await loadTaskDef(root, name);
    return { name: def.name, filePath: def.filePath };
  } catch (err) {
    rollback();
    throw err;
  }
}

/** Typecheck ONE task.ts; returns the diagnostic text (for the LLM to fix), or
 *  undefined if clean. Uses the project tsconfig but checks just this file. */
export function typecheckTaskFile(filePath: string): string | undefined {
  // strictNullChecks (catches the real bugs: undefined params, wrong types, calling
  // a missing method on the Task base class) but NOT noImplicitAny — an LLM
  // shouldn't have to annotate every callback param; that pedantry causes fix-loops.
  const r = spawnSync('npx', ['tsc', '--noEmit', '--skipLibCheck', '--module', 'nodenext',
    '--moduleResolution', 'nodenext', '--target', 'es2022', '--lib', 'es2023',
    '--strictNullChecks', '--noImplicitThis', '--noImplicitAny', 'false', filePath],
    { encoding: 'utf8', cwd: serverCwd(), timeout: 30_000 });
  if (r.status === 0) return undefined;
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`.trim();
  // keep only the error lines for the file, trimmed for the model
  const lines = out.split('\n').filter((l) => /error TS\d+/.test(l)).map((l) => l.replace(/^.*[/\\]/, ''));
  return (lines.length ? lines : [out]).slice(0, 12).join('\n') || undefined;
}

/** The server package dir (cwd for tsc). */
function serverCwd(): string {
  return resolve(new URL('../../../..', import.meta.url).pathname);
}

/** Remove a definition by name. Path-containment guarded. */
export function removeTaskDef(root: string, name: string): boolean {
  const dir = resolve(join(root, name));
  const tasksRoot = resolve(root);
  if (dir === tasksRoot || !dir.startsWith(tasksRoot + '/') || !isTaskDir(name)) return false;
  try { readFileSync(join(dir, 'task.ts')); } catch { return false; }
  rmSync(dir, { recursive: true, force: true });
  return true;
}

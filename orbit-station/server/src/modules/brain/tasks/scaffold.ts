/**
 * Task authoring — the LLM writes the run() body (+ a status line); this wraps it
 * into a complete, typechecked `task.ts`: a doc-comment goal, a `manifest`, a
 * `class extends Task` implementing run()/getStatus(), and a trailing runTask(…).
 * The framework is GENERIC: run() is arbitrary code over the Task primitives
 * (this.status / this.notifyAgent / this.askAgentInput / this.finish / this.errored
 * / this.sleep / this.checkpoint), NOT a fixed menu of task shapes.
 */
import type { TaskParam } from '../../../tasks/_harness/index.js';

export interface AuthorSpec {
  name: string;                 // kebab
  description: string;
  goal: string;                 // human-readable goal prose (the doc-comment)
  params?: TaskParam[];         // the input schema run() reads as this.params.*
  /** extra import lines run() needs (e.g. "import { execFile } from 'node:child_process'").
   *  The harness import is always added; these are appended. */
  imports?: string[];
  /** the JS for the run() method body — statements over `this` (the primitives). */
  body: string;
  /** a JS expression for getStatus()'s return value (defaults to the description). */
  status?: string;
  /** the model this task's OWN reasoning (this.ask/this.agent/vision) runs on, as
   *  "provider/modelId" from the dock's allowed task models. Omit for a task that
   *  does no LLM work (it just inherits the dock default — harmless). */
  model?: string;
}

const PARAM_TYPES = new Set(['string', 'number', 'boolean', 'duration', 'string[]']);

/** Assemble a complete task.ts from an LLM-authored spec. `harness` is the import
 *  specifier (relative for shipped/generated tasks). */
export function authorTaskSource(spec: AuthorSpec, harness = '../../_harness/index.js'): string {
  if (!/^[a-z0-9-]{1,64}$/.test(spec.name)) throw new Error(`bad task name "${spec.name}" (kebab-case)`);
  for (const p of spec.params ?? []) {
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(p.name)) throw new Error(`bad param name "${p.name}"`);
    if (!PARAM_TYPES.has(p.type)) throw new Error(`bad param type "${p.type}" for "${p.name}"`);
  }
  const className = classNameFor(spec.name);
  const goalLines = spec.goal.trim().split('\n').map((l) => ` * ${l}`).join('\n');
  const paramsJson = JSON.stringify(spec.params ?? [], null, 2)
    .split('\n').map((l, i) => (i === 0 ? l : `  ${l}`)).join('\n');
  const extraImports = (spec.imports ?? [])
    .map((s) => s.trim()).filter((s) => s && !s.includes('_harness'))
    .join('\n');
  const statusExpr = (spec.status ?? '').trim() || JSON.stringify(spec.description);

  return `/**
 * # ${spec.name}
 * ${spec.description}
 *
${goalLines}
 */
import { Task, runTask, type TaskManifest } from '${harness}';
${extraImports}

export const manifest = {
  name: '${spec.name}',
  description: ${JSON.stringify(spec.description)},
  params: ${paramsJson},${spec.model ? `\n  model: ${JSON.stringify(spec.model)},` : ''}
} satisfies TaskManifest;

class ${className} extends Task {
  async run(): Promise<void> {
${indent(spec.body.trim(), '    ')}
  }
  getStatus(): string {
    return ${statusExpr};
  }
}

runTask(${className});
`;
}

/** PascalCase class name from a kebab task name, suffixed Task. */
function classNameFor(name: string): string {
  const pascal = name.split('-').filter(Boolean)
    .map((w) => w[0]!.toUpperCase() + w.slice(1)).join('');
  return `${pascal || 'Generated'}Task`;
}

function indent(s: string, pad: string): string {
  return s.split('\n').map((l) => (l.trim() ? pad + l : l)).join('\n');
}

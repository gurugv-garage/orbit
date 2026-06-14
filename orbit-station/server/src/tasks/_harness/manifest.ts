/**
 * Manifest input-schema validation (docs/TASKS_V1.md §2, §6).
 *
 * A definition declares `params` (key/val schema). `run_task` supplies values;
 * `validateParams` checks required presence + coarse types, applies defaults,
 * and returns the value bag the harness hands the task as `ctx.params`. The LLM
 * is expected to gather/ask for required values up front (§6); this is the
 * server-side backstop that refuses a bad call.
 */
import type { TaskManifest, TaskParam } from './types.js';
import { durationMs } from './types.js';

export interface ValidationResult {
  ok: boolean;
  values: Record<string, unknown>;
  errors: string[];
}

function typeOk(p: TaskParam, v: unknown): boolean {
  switch (p.type) {
    case 'string': return typeof v === 'string';
    case 'number': return typeof v === 'number' && Number.isFinite(v);
    case 'boolean': return typeof v === 'boolean';
    case 'duration': return typeof v === 'string' && durationMs(v) > 0 || typeof v === 'number';
    case 'string[]': return Array.isArray(v) && v.every((x) => typeof x === 'string');
    default: return false;
  }
}

export function validateParams(
  manifest: TaskManifest,
  input: Record<string, unknown> = {},
): ValidationResult {
  const schema = manifest.params ?? [];
  const values: Record<string, unknown> = {};
  const errors: string[] = [];

  for (const p of schema) {
    const given = input[p.name];
    if (given === undefined || given === null) {
      if (p.default !== undefined) { values[p.name] = p.default; continue; }
      if (p.required) { errors.push(`missing required param "${p.name}" (${p.type})`); continue; }
      continue; // optional, no default → absent
    }
    if (!typeOk(p, given)) {
      errors.push(`param "${p.name}" must be ${p.type}, got ${JSON.stringify(given)}`);
      continue;
    }
    values[p.name] = given;
  }

  // pass through unknown keys? No — keep ctx.params to the declared schema so a
  // typo doesn't silently ride along. (The LLM addresses params by their names.)
  return { ok: errors.length === 0, values, errors };
}

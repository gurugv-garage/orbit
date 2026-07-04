/**
 * Full pi coding skills for the dock brain (docs/decision-traces/server-brain-selfmod.md §1b,
 * Tier 4). The model gets the coding-agent surface: read_file, write_file,
 * edit_file, run_command — over the WHOLE station host, INCLUDING its own
 * source code. The dock can inspect and rewrite the robot it runs on.
 *
 * ⚠️ MAXIMAL CAPABILITY. No sandbox: these run in the live station process with
 * its permissions. Two guardrails, both REQUIRED:
 *   1. gated OFF by default (`brainFileAccess` config) — opt-in per deployment;
 *   2. every MUTATING action (write/edit/run) requires explicit USER
 *      CONFIRMATION via the dock UI before it executes (the `confirm` callback,
 *      backed by an RPC to the dock — same path as set_face). read_file is the
 *      only un-gated op (inspection is safe).
 *
 * Built on the `NodeExecutionEnv` (FileSystem + Shell) pi already ships.
 */

import { type AgentTool, type AgentToolResult } from '@earendil-works/pi-agent-core';
import { NodeExecutionEnv } from '@earendil-works/pi-agent-core/node';

const env = new NodeExecutionEnv({ cwd: process.cwd() });

/** Ask the dock to confirm a mutating action. Resolves true = approved. */
export type ConfirmFn = (summary: string, detail: string) => Promise<boolean>;

function textResult(text: string): AgentToolResult<unknown> {
  return { content: [{ type: 'text', text }], details: undefined };
}

/** thrown text becomes an error tool-result in pi's loop (codebase convention). */
class ToolError extends Error {}
const DENIED = 'The user declined this action on the dock.';

async function unwrap<T>(p: Promise<{ ok: true; value: T } | { ok: false; error: { message?: string } }>): Promise<T> {
  const r = await p;
  if (r.ok) return r.value;
  throw new Error(r.error?.message ?? 'operation failed');
}

const MAX_READ = 200_000; // chars; keep a giant file from blowing the context

export interface FileToolDeps {
  /** request UI confirmation for a mutating action; default-deny on any error. */
  confirm: ConfirmFn;
}

/**
 * The full read/write/edit/exec toolset. Returned only when `brainFileAccess`
 * is enabled (the session gates it). Mutating tools call `deps.confirm` and
 * abort on a decline.
 */
export function buildFileTools(deps: FileToolDeps): AgentTool<any>[] {
  const read: AgentTool<any> = {
    name: 'read_file',
    label: 'read_file',
    description: 'Read a text file from the station host (the robot\'s own machine) by path — absolute, or relative to the station working directory. Returns the file contents. Use this to inspect your own source code and config.',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: 'file path to read' } },
      required: ['path'],
    } as never,
    async execute(_id: string, params: any) {
      const path = String(params?.path ?? '');
      if (!path) throw new ToolError('path is required');
      const content = await unwrap(env.readTextFile(path));
      return content.length > MAX_READ
        ? textResult(content.slice(0, MAX_READ) + `\n\n[truncated at ${MAX_READ} chars]`)
        : textResult(content);
    },
  };

  const write: AgentTool<any> = {
    name: 'write_file',
    label: 'write_file',
    description: 'Create or OVERWRITE a file on the station host with the given content (including your own source code). Requires the user to confirm on the dock first. Use edit_file for surgical changes.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'file path to write' },
        content: { type: 'string', description: 'the full file content' },
      },
      required: ['path', 'content'],
    } as never,
    async execute(_id: string, params: any) {
      const path = String(params?.path ?? '');
      const content = String(params?.content ?? '');
      if (!path) throw new ToolError('path is required');
      if (!(await deps.confirm(`Overwrite ${path}`, `Write ${content.length} chars to ${path}`))) {
        throw new ToolError(DENIED);
      }
      await unwrap(env.writeFile(path, content));
      return textResult(`wrote ${content.length} chars to ${path}`);
    },
  };

  const edit: AgentTool<any> = {
    name: 'edit_file',
    label: 'edit_file',
    description: 'Replace an exact string in a file with a new string (the surgical edit; old_string must be unique). Requires the user to confirm on the dock first.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'file path to edit' },
        old_string: { type: 'string', description: 'exact text to replace (must be unique in the file)' },
        new_string: { type: 'string', description: 'replacement text' },
      },
      required: ['path', 'old_string', 'new_string'],
    } as never,
    async execute(_id: string, params: any) {
      const path = String(params?.path ?? '');
      const oldStr = String(params?.old_string ?? '');
      const newStr = String(params?.new_string ?? '');
      if (!path || !oldStr) throw new ToolError('path and old_string are required');
      const content = await unwrap(env.readTextFile(path));
      const count = content.split(oldStr).length - 1;
      if (count === 0) throw new ToolError(`old_string not found in ${path}`);
      if (count > 1) throw new ToolError(`old_string is ambiguous (${count} matches) in ${path}; include more context`);
      if (!(await deps.confirm(`Edit ${path}`, `Replace in ${path}:\n- ${oldStr.slice(0, 200)}\n+ ${newStr.slice(0, 200)}`))) {
        throw new ToolError(DENIED);
      }
      await unwrap(env.writeFile(path, content.replace(oldStr, newStr)));
      return textResult(`edited ${path}`);
    },
  };

  const run: AgentTool<any> = {
    name: 'run_command',
    label: 'run_command',
    description: 'Run a shell command on the station host (builds, tests, git, anything) and return stdout/stderr/exit code. Requires the user to confirm on the dock first.',
    parameters: {
      type: 'object',
      properties: { command: { type: 'string', description: 'the shell command' } },
      required: ['command'],
    } as never,
    async execute(_id: string, params: any) {
      const command = String(params?.command ?? '');
      if (!command) throw new ToolError('command is required');
      if (!(await deps.confirm(`Run a command`, `$ ${command}`))) {
        throw new ToolError(DENIED);
      }
      const out = await unwrap(env.exec(command, { timeout: 120 }));
      const parts: string[] = [];
      if (out.stdout) parts.push(out.stdout);
      if (out.stderr) parts.push(`[stderr]\n${out.stderr}`);
      parts.push(`[exit ${out.exitCode}]`);
      return textResult(parts.join('\n'));
    },
  };

  return [read, write, edit, run];
}

/** The system-prompt block telling the model it has these powers (only added
 *  when brainFileAccess is on). Makes the capability self-aware + sets the
 *  confirmation expectation so it doesn't promise instant edits. */
export const FILE_TOOLS_PROMPT =
  `You have FULL ACCESS to the code, files, and shell of the station you run on — your own machine. `
  + `This is REAL access, not a limitation: never say "I can't access git / files / external systems" — you CAN. `
  + `read_file reads any file; run_command runs ANY shell command (git, builds, tests, grep, anything) and returns its output. `
  + `When asked about commits, code, docs, or what changed, run the appropriate command and report the real output — `
  + `do not fall back to memory or guess. You can also MODIFY yourself: write_file and edit_file change your own source. `
  + `Every MUTATING action (write, edit, run_command) asks the user to confirm on the dock first — so explain what `
  + `you'll do, make the call, and tell them to approve it on the screen; if they decline, it doesn't happen. `
  + `read_file is direct (no confirmation). Be careful and precise: these affect the running robot.`;

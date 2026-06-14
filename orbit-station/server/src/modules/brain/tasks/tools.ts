/**
 * Task tools (docs/TASKS_V1.md §6) — the model-facing surface. Definition tools
 * take a `name`, instance tools take an `instanceId`. `run_task` validates inputs
 * against the definition's manifest schema and refuses a missing/ill-typed
 * required param (the LLM is expected to gather/ask for them up front).
 */
import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core';
import { loadAllTaskDefs, findTaskDef, writeTaskDef, harnessImportPath } from './manager.js';
import { authorTaskSource } from './scaffold.js';
import { validateParams } from '../../../tasks/_harness/index.js';
import type { TaskParam } from '../../../tasks/_harness/index.js';
import { describeInstance, type TaskSupervisor } from './supervisor.js';

export interface TaskToolDeps {
  dock: string;
  supervisor: TaskSupervisor;
  /** SHIPPED definitions (src tree, read-only). */
  tasksRoot: string;
  /** USER/LLM-created definitions (under .data, writable, not watched). */
  userTasksRoot: string;
  /** the open conversational session id (tasks nest under it). */
  parentSessionId: () => string | undefined;
  /** effective config (brainTaskMax). */
  config: (key: string) => unknown;
}

function txt(text: string): AgentToolResult<unknown> {
  return { content: [{ type: 'text', text }], details: undefined };
}
function tool(name: string, description: string, parameters: object,
  execute: (id: string, args: any) => Promise<AgentToolResult<unknown>>): AgentTool<any> {
  return { name, label: name, description, parameters: parameters as never, execute };
}
const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);

export function buildTaskTools(d: TaskToolDeps): AgentTool<any>[] {
  if (d.config('brainTaskMax') === 0) return []; // tasks disabled
  // search GENERATED first, then PACKAGED — prefer a recently-authored task over
  // a shipped one when both match (your manual pruning later promotes generated
  // ones into the packaged folder).
  const roots = [
    { root: d.userTasksRoot, source: 'generated' as const },
    { root: d.tasksRoot, source: 'packaged' as const },
  ];

  const list = tool('list_tasks',
    'List available background TASK definitions you can run, AND this dock\'s currently running task instances (id, definition, state). Browse this before writing a new task — reuse an existing one when it fits.',
    { type: 'object', properties: {} },
    async () => {
      const defs = await loadAllTaskDefs(roots);
      const instances = d.supervisor.list(d.dock);
      const defLines = defs.length
        ? defs.map((t) => `- ${t.name} [${t.source ?? 'packaged'}]: ${t.description}`).join('\n')
        : '(no task definitions yet)';
      const instLines = instances.length
        ? instances.map((i) => `- ${i.instanceId} [${i.name}] ${i.state.toUpperCase()}${i.lastSignal ? ` — ${i.lastSignal}` : ''}`).join('\n')
        : '(no tasks running)';
      return txt(`DEFINITIONS (reusable):\n${defLines}\n\nRUNNING INSTANCES (this dock):\n${instLines}`);
    });

  const run = tool('run_task',
    'Start (instantiate) an existing task definition as a background process on this dock. Provide values for the definition\'s params; if you don\'t have a required value, ASK the user first rather than guessing. Returns the new instanceId.',
    {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'the task definition name' },
        params: { type: 'object', description: 'the input values for the definition\'s param schema' },
      },
      required: ['name'],
    },
    async (_id, args: { name?: string; params?: Record<string, unknown> }) => {
      const name = args?.name;
      if (!name) throw new Error('run_task needs a task name');
      const parent = d.parentSessionId();
      if (!parent) throw new Error('no open session to run a task under');
      const max = num(d.config('brainTaskMax'), 3);
      if (d.supervisor.countRunning(d.dock) >= max) {
        throw new Error(`too many tasks already running (max ${max}); stop one first`);
      }
      const def = await findTaskDef(roots, name); // throws if unknown
      const v = validateParams(def.manifest, args?.params ?? {});
      if (!v.ok) throw new Error(`bad params for "${name}": ${v.errors.join('; ')}`);
      const instanceId = d.supervisor.start({ dock: d.dock, name, filePath: def.filePath, params: v.values, parentSessionId: parent });
      return txt(`started task ${instanceId} (${name}). Watch it with list_tasks / get_task_status.`);
    });

  const status = tool('get_task_status',
    'Pull a running task instance\'s current progress: its self-maintained status + recent log + state. Call this when the user asks how a task is going.',
    { type: 'object', properties: { instanceId: { type: 'string' } }, required: ['instanceId'] },
    async (_id, args: { instanceId?: string }) => {
      const info = d.supervisor.get(args?.instanceId ?? '');
      if (!info) return txt(`no task "${args?.instanceId}" — use list_tasks for ids.`);
      const md = d.supervisor.status(info.instanceId);
      const log = d.supervisor.logTail(info.instanceId, 12);
      const started = new Date(info.startedAt).toISOString();
      const ageMin = Math.round((Date.now() - info.startedAt) / 60_000);
      return txt(`${info.instanceId} [${info.name}] ${info.state.toUpperCase()}\n`
        + `about: ${describeInstance(info)}\n`
        + `started: ${started} (${ageMin}m ago)${info.runCount > 1 ? `, run #${info.runCount}` : ''}\n`
        + `${md || '(no status yet)'}\n\nrecent log:\n${log}`);
    });

  const provideInput = tool('provide_input',
    'Give an answer to a task that is STUCK waiting for user input (it asked a question). Resumes the task from where it parked.',
    { type: 'object', properties: { instanceId: { type: 'string' }, answer: { type: 'string' } }, required: ['instanceId', 'answer'] },
    async (_id, args: { instanceId?: string; answer?: string }) => {
      const ok = d.supervisor.provideInput(args?.instanceId ?? '', args?.answer ?? '');
      return txt(ok ? `delivered to ${args?.instanceId}.` : `task ${args?.instanceId} is not waiting for input.`);
    });

  const write = tool('write_task',
    'CREATE a new background task when no existing definition fits (check list_tasks first). '
    + 'A task runs as its OWN process. You write the `body` of an `async run()` method on a class '
    + 'that already extends our Task base (it handles connecting + messaging). `body` is plain '
    + 'JavaScript that does whatever the request needs (loop on a timer, react to events, call an '
    + 'API, multi-step jobs) using `this`:\n'
    + '• this.params.<name> — the inputs you declared in params\n'
    + '• await this.notifyAgent(text, image?) — push an update to the user (only when useful)\n'
    + '• this.status(text) — set the status the user can pull anytime via get_task_status\n'
    + '• this.finish(summary) — done;  this.errored(why) — failed\n'
    + '• await this.sleep("5s") — wait (string duration or ms number)\n'
    + '• const answer = await this.askAgentInput(prompt) — ask the user and AWAIT their answer\n'
    + '• this.state.<k> = …; this.checkpoint() — optional: persist state so a resume reloads it\n'
    + 'CRITICAL — ONE-SHOT vs RECURRING: if the job happens ONCE (e.g. "remind me in 10 minutes"), '
    + 'do the work then call this.finish() so it STOPS — do NOT loop forever. Only loop '
    + '(while (true) { … }) for genuinely REPEATING jobs ("every N", "keep watching"). Always reach '
    + 'a terminal: this.finish() on completion or this.errored() on failure. (Most one-time reminders '
    + 'are better served by the shipped remind-after task — reuse it.)\n'
    + 'One-shot example body: `await this.sleep(this.params.delay as string); await this.notifyAgent(this.params.message as string); this.finish();`\n'
    + 'Recurring example body: `while (true) { await this.sleep(this.params.interval as string); await this.notifyAgent(this.params.message as string); }`\n'
    + 'Declare inputs in `params` — any value run() relies on (e.g. interval, delay) MUST be '
    + 'required:true OR have a default; never read an undefined param. `this.params.X` is typed '
    + '`unknown`, so CAST it (e.g. `this.params.from as number`).\n'
    + '`status` is a JS expression for getStatus() — what the user sees when they ask how it is going '
    + '(e.g. `` `reminding every ${this.params.interval}` ``). Defaults to the description.\n'
    + 'NEED A NODE MODULE OR SHELL? run() cannot add its own import lines, so list any imports in '
    + '`imports` (e.g. "import { execFile } from \'node:child_process\'"). It is a real Node process — '
    + 'you can run shell commands, read files, call HTTP. '
    + 'The new task is TYPECHECKED before it is saved — if write_task returns type errors, FIX the '
    + 'body/imports and call write_task again. Then start it with run_task.',
    {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'short kebab-case name, e.g. "watch-mug" or "remind-bath"' },
        description: { type: 'string', description: 'one line describing what it does (for reuse discovery)' },
        goal: { type: 'string', description: 'a few lines of plain-English goal (becomes the doc-comment)' },
        params: {
          type: 'array',
          description: 'the input schema run() reads as this.params.*',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              type: { type: 'string', enum: ['string', 'number', 'boolean', 'duration', 'string[]'] },
              required: { type: 'boolean' },
              default: {},
            },
            required: ['name', 'type'],
          },
        },
        imports: {
          type: 'array', items: { type: 'string' },
          description: 'extra import lines run() needs, e.g. ["import { execFile } from \'node:child_process\'"]',
        },
        body: { type: 'string', description: 'the JavaScript body of `async run() { … }` — the actual task logic, using `this`' },
        status: { type: 'string', description: 'a JS expression for getStatus() (e.g. `` `waiting ${this.params.delay}` ``); optional' },
      },
      required: ['name', 'description', 'body'],
    },
    async (_id, args: { name?: string; description?: string; goal?: string; params?: TaskParam[]; imports?: string[]; body?: string; status?: string }) => {
      if (!args?.name || !args?.description || !args?.body) throw new Error('write_task needs name, description, body');
      const source = authorTaskSource(
        { name: args.name, description: args.description, goal: args.goal ?? args.description, params: args.params, imports: args.imports, body: args.body, status: args.status },
        harnessImportPath(),
      );
      // writeTaskDef typechecks + import-validates; on failure it throws the
      // diagnostics, which pi turns into an error tool result the LLM can fix.
      const created = await writeTaskDef(d.userTasksRoot, args.name, source);
      return txt(`created + typechecked task "${created}". Now start it with run_task("${created}", { … }).`);
    });

  const lifecycle = (toolName: string, verb: 'pause' | 'resume' | 'stop') => tool(toolName,
    `${verb[0]!.toUpperCase()}${verb.slice(1)} a running task instance (or "all").`,
    { type: 'object', properties: { instanceId: { type: 'string' } }, required: ['instanceId'] },
    async (_id, args: { instanceId?: string }) => {
      const target = args?.instanceId ?? '';
      const ids = target === 'all' ? d.supervisor.list(d.dock).map((i) => i.instanceId) : [target];
      let n = 0;
      for (const id of ids) { if (d.supervisor[verb](id)) n++; }
      return txt(`${verb}ed ${n} task(s).`);
    });

  return [
    list, run, write, status, provideInput,
    lifecycle('pause_task', 'pause'),
    lifecycle('resume_task', 'resume'),
    lifecycle('stop_task', 'stop'),
  ];
}

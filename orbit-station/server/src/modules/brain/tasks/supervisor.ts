/**
 * TaskSupervisor — owns running task instances per dock, each a SEPARATE OS
 * PROCESS (`npx tsx task.ts`, in a tmux window when tmux is present). It:
 *   - mints instanceIds and spawns the process with identity in env,
 *   - tracks each instance's reported status + checkpoint (written to disk so a
 *     respawn can resume),
 *   - drives lifecycle: start, stop (kill the process), resume (respawn from the
 *     last checkpoint), provideInput (answer a stuck task), stopForParent (cascade).
 *
 * It does NOT touch the WebSocket itself. The brain module routes the task peer's
 * `tasks`-topic frames in via onFrame(); the supervisor asks the brain to push
 * `init`/`input` frames down via the injected sendToTask(). Parent signals
 * (notify/finish/errored/stuck) go to the brain via onSignal() → autonomous turn.
 */
import { randomUUID } from 'node:crypto';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';

export type InstanceState = 'running' | 'stuck' | 'done' | 'errored' | 'stopped';
export type SignalKind = 'notify' | 'finish' | 'errored' | 'stuck';

export interface InstanceInfo {
  instanceId: string;
  dock: string;
  name: string;                 // definition name
  params: Record<string, unknown>;
  parentSessionId: string;
  state: InstanceState;
  /** epoch ms this instance was FIRST started (survives respawns/resume). */
  startedAt: number;
  /** how many times the process has been (re)spawned (1 on first run). */
  runCount: number;
  /** epoch ms of the CURRENT process's spawn (differs from startedAt after resume). */
  spawnedAt: number;
  lastSignal?: string;
}

/** A one-line human description of what an instance is about (for init.about,
 *  the console, and logs): "remind-after: {message:'bath', delay:'5m'}". */
export function describeInstance(info: InstanceInfo): string {
  const params = Object.entries(info.params)
    .map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`).join(', ');
  const when = new Date(info.startedAt).toISOString();
  return `${info.name}${params ? ` (${params})` : ''} — started ${when}`
    + (info.runCount > 1 ? `, run #${info.runCount}` : '');
}

export interface StartArgs {
  dock: string;
  name: string;
  /** absolute path to the definition's task.ts. */
  filePath: string;
  params: Record<string, unknown>;
  parentSessionId: string;
}

/** A frame from a task process (already unwrapped: kind + payload). */
export interface TaskFrame {
  instanceId: string;
  kind: string;
  payload: Record<string, unknown>;
}

export interface SupervisorDeps {
  /** data root, e.g. .data/brain. Instance dirs are <root>/<dock>/tasks/<id>/. */
  root: string;
  /** ws url the spawned process connects back to. */
  stationWsUrl: string;
  /** push a directed frame DOWN to a task peer (init/input/stop), via the hub. */
  sendToTask: (dock: string, instanceId: string, kind: string, payload: Record<string, unknown>) => void;
  /** a task parent signal → the brain (lands as an autonomous turn). */
  onSignal: (dock: string, info: InstanceInfo, kind: SignalKind, ev: { text: string; image?: string }) => void;
  /** how to run a task process: 'tmux' (attachable window) or 'child' (headless).
   *  'tmux' falls back to 'child' when tmux isn't installed. Defaults to 'tmux'. */
  runner?: () => 'tmux' | 'child';
}

interface Entry {
  info: InstanceInfo;
  filePath: string;
  child?: ChildProcess;
  status: string;               // last reported getStatus()/status() line
  log: string[];                // tail of process stderr/stdout + lifecycle notes
}

/** Is tmux available on this host? (cached) */
let _tmux: boolean | undefined;
function hasTmux(): boolean {
  if (_tmux === undefined) {
    try { _tmux = spawnSync('tmux', ['-V'], { stdio: 'ignore' }).status === 0; }
    catch { _tmux = false; }
  }
  return _tmux;
}

export class TaskSupervisor {
  #byId = new Map<string, Entry>();

  constructor(private readonly d: SupervisorDeps) {}

  #dir(dock: string, instanceId: string): string {
    return join(this.d.root, sanitize(dock), 'tasks', instanceId);
  }
  #checkpointPath(dock: string, instanceId: string): string {
    return join(this.#dir(dock, instanceId), 'checkpoint.json');
  }

  /** Start a new instance from a definition file. Returns its instanceId. */
  start(args: StartArgs): string {
    const instanceId = `t-${randomUUID().slice(0, 4)}`;
    const info: InstanceInfo = {
      instanceId, dock: args.dock, name: args.name, params: args.params,
      parentSessionId: args.parentSessionId, state: 'running',
      startedAt: Date.now(), runCount: 0, spawnedAt: Date.now(),
    };
    const dir = this.#dir(args.dock, instanceId);
    mkdirSync(dir, { recursive: true });
    // seed the checkpoint with the params (the process reads it via our init frame).
    this.#byId.set(instanceId, { info, filePath: args.filePath, status: '', log: [] });
    this.#spawn(instanceId);
    return instanceId;
  }

  /** Spawn (or respawn) the process for an existing entry, loading its checkpoint. */
  #spawn(instanceId: string): void {
    const e = this.#byId.get(instanceId);
    if (!e) return;
    e.info.runCount += 1;            // 1 on first run, 2+ after a resume/restart
    e.info.spawnedAt = Date.now();   // THIS process's spawn (startedAt stays the first)
    const { dock, name, parentSessionId } = e.info;
    const env = {
      ...process.env,
      STATION_WS: this.d.stationWsUrl,
      TASK_DOCK: dock,
      TASK_INSTANCE_ID: instanceId,
      TASK_NAME: name,
      TASK_SESSION_ID: parentSessionId,
    };
    const logFile = join(this.#dir(dock, instanceId), 'task.log');
    const note = (line: string) => {
      e.log.push(line); if (e.log.length > 400) e.log.shift();
      try { appendFileSync(logFile, line + '\n'); } catch { /* best effort */ }
    };

    const cwd = serverCwd();
    // tmux gives an inspectable, named window; fall back to a plain detached child
    // (when the runner pref is 'child', or tmux isn't installed).
    const useTmux = (this.d.runner?.() ?? 'tmux') === 'tmux' && hasTmux();
    const tmuxName = `orbit-task-${instanceId}`;
    if (useTmux) {
      // Run tsx inside a fresh detached tmux session, IN the server cwd (so the
      // workspace tsx + node_modules resolve) and with output teed to the log
      // (tmux output is otherwise invisible). The inner env is exported in the
      // command line so it survives tmux's login shell.
      const envPrefix = Object.entries(taskEnvOnly(env)).map(([k, v]) => `${k}=${shq(v)}`).join(' ');
      const cmd = `${envPrefix} npx tsx ${shq(e.filePath)} > ${shq(this.#dir(dock, instanceId) + '/proc.log')} 2>&1`;
      const r = spawnSync('tmux', ['new-session', '-d', '-s', tmuxName, '-c', cwd, cmd],
        { env, stdio: 'ignore' });
      note(`[spawn] tmux ${tmuxName} (cwd ${cwd}) → npx tsx ${e.filePath}${r.status === 0 ? '' : ` [tmux failed: ${r.status}]`}`);
      // tmux returns immediately; the task's terminal state arrives via WS frames
      // (onFrame). e.child stays undefined — stop() kills the tmux session.
      e.child = undefined;
    } else {
      const child: ChildProcess = spawn('npx', ['tsx', e.filePath], { env, cwd, stdio: ['ignore', 'pipe', 'pipe'] });
      child.stdout?.on('data', (b) => note(`[out] ${String(b).trimEnd()}`));
      child.stderr?.on('data', (b) => note(`[err] ${String(b).trimEnd()}`));
      note(`[spawn] npx tsx ${e.filePath} (cwd ${cwd})`);
      e.child = child;
      child.on('exit', (code) => {
        note(`[exit] code=${code ?? 'null'}`);
        // a crash before any terminal frame → errored (finish/errored frames set
        // state first when the task exits normally).
        if (e.info.state === 'running' || e.info.state === 'stuck') {
          e.info.state = code === 0 ? 'done' : 'errored';
        }
      });
    }
  }

  /** Send the task its init frame (params + resumed checkpoint) — called by the
   *  brain when the task peer ATTACHES on the tasks topic. */
  #sendInit(instanceId: string): void {
    const e = this.#byId.get(instanceId);
    if (!e) return;
    let state: Record<string, unknown> = {};
    try { state = JSON.parse(readFileSync(this.#checkpointPath(e.info.dock, instanceId), 'utf8')); }
    catch { /* fresh start, no checkpoint */ }
    this.d.sendToTask(e.info.dock, instanceId, 'init', {
      params: e.info.params, state,
      startedAt: e.info.startedAt, runCount: e.info.runCount, spawnedAt: e.info.spawnedAt,
      about: describeInstance(e.info),
    });
  }

  /** Route an inbound frame from a task process. The brain calls this for every
   *  `tasks`-topic publish from a task peer. */
  onFrame(dock: string, f: TaskFrame): void {
    const e = this.#byId.get(f.instanceId);
    if (!e || e.info.dock !== dock) return;
    const p = f.payload;
    switch (f.kind) {
      case 'attach':
        // the process is connected + stable; hand it params + any checkpoint.
        this.#sendInit(f.instanceId);
        break;
      case 'status':
        e.status = String(p.status ?? '');
        break;
      case 'checkpoint':
        try {
          writeFileSync(this.#checkpointPath(dock, f.instanceId), JSON.stringify(p.state ?? {}, null, 2));
        } catch { /* best effort */ }
        break;
      case 'notify':
        e.info.lastSignal = `notify: ${p.text}`;
        this.d.onSignal(dock, e.info, 'notify', { text: String(p.text ?? ''), image: p.image as string | undefined });
        break;
      case 'ask':
        e.info.state = 'stuck';
        e.info.lastSignal = `stuck: ${p.prompt}`;
        this.d.onSignal(dock, e.info, 'stuck', { text: String(p.prompt ?? '') });
        break;
      case 'finish':
        e.info.state = 'done';
        e.info.lastSignal = `finish: ${p.summary ?? ''}`;
        this.d.onSignal(dock, e.info, 'finish', { text: String(p.summary ?? 'done') });
        break;
      case 'errored':
        e.info.state = 'errored';
        e.info.lastSignal = `errored: ${p.why}`;
        this.d.onSignal(dock, e.info, 'errored', { text: String(p.why ?? 'failed') });
        break;
    }
  }

  /** Hard stop: kill the process. The last checkpoint survives on disk. */
  stop(instanceId: string): boolean {
    const e = this.#byId.get(instanceId);
    if (!e) return false;
    this.#kill(e);
    e.info.state = 'stopped';
    return true;
  }

  #kill(e: Entry): void {
    if (hasTmux()) {
      spawnSync('tmux', ['kill-session', '-t', `orbit-task-${e.info.instanceId}`], { stdio: 'ignore' });
    }
    try { e.child?.kill('SIGKILL'); } catch { /* already gone */ }
    e.child = undefined;
  }

  /** Resume a stopped/stuck task: respawn a fresh process from the checkpoint. */
  resume(instanceId: string): boolean {
    const e = this.#byId.get(instanceId);
    if (!e) return false;
    this.#kill(e);
    e.info.state = 'running';
    this.#spawn(instanceId);
    return true;
  }
  /** Pause is just stop (a free-running process has no mid-run pause). */
  pause(instanceId: string): boolean { return this.stop(instanceId); }
  /** Restart = stop + respawn from checkpoint. */
  restart(instanceId: string): boolean {
    this.stop(instanceId);
    return this.resume(instanceId);
  }

  /** Answer a stuck task: send `input` down; it resolves the awaiting ask. */
  provideInput(instanceId: string, answer: string): boolean {
    const e = this.#byId.get(instanceId);
    if (!e) return false;
    this.d.sendToTask(e.info.dock, instanceId, 'input', { answer });
    if (e.info.state === 'stuck') e.info.state = 'running';
    return true;
  }

  /** Stop every instance under a parent conversational session (the cascade). */
  stopForParent(dock: string, parentSessionId: string): string[] {
    const ids: string[] = [];
    for (const e of this.#byId.values()) {
      if (e.info.dock === dock && e.info.parentSessionId === parentSessionId) {
        this.stop(e.info.instanceId); ids.push(e.info.instanceId);
      }
    }
    return ids;
  }
  stopMany(instanceIds: string[]): void { for (const id of instanceIds) this.stop(id); }

  get(instanceId: string): InstanceInfo | undefined { return this.#byId.get(instanceId)?.info; }
  status(instanceId: string): string { return this.#byId.get(instanceId)?.status ?? ''; }
  logTail(instanceId: string, n = 200): string {
    const log = this.#byId.get(instanceId)?.log ?? [];
    return log.slice(-n).join('\n');
  }
  list(dock?: string): InstanceInfo[] {
    return [...this.#byId.values()].map((e) => e.info).filter((i) => !dock || i.dock === dock);
  }
  countRunning(dock: string): number {
    return this.list(dock).filter((i) => i.state === 'running' || i.state === 'stuck').length;
  }
  hasRunningUnder(dock: string, parentSessionId: string): boolean {
    return this.list(dock).some((i) =>
      i.parentSessionId === parentSessionId && (i.state === 'running' || i.state === 'stuck'));
  }
}

function sanitize(dock: string): string { return dock.replace(/[^a-zA-Z0-9._-]/g, '_'); }

/** The server package dir — cwd for the spawned process (workspace tsx + node_modules). */
function serverCwd(): string {
  return new URL('../../../..', import.meta.url).pathname;
}
/** Just the task identity keys (what tmux's command line needs to re-export). */
function taskEnvOnly(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of ['STATION_WS', 'TASK_DOCK', 'TASK_INSTANCE_ID', 'TASK_NAME', 'TASK_SESSION_ID']) {
    if (env[k]) out[k] = env[k]!;
  }
  return out;
}
/** single-quote a value for a shell command line. */
function shq(v: string): string { return `'${v.replace(/'/g, `'\\''`)}'`; }

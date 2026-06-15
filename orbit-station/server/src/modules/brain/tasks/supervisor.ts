/**
 * TaskSupervisor — owns running task instances per dock, each a SEPARATE OS
 * PROCESS running `task.ts` via tsx: a detached child process by default, or a
 * tmux window when `brainTaskRunner: 'tmux'` is chosen (see TASK_RUNNER_DEFAULT). It:
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

/** Terminal states are STICKY — once an instance reaches one, no late frame from a
 *  dying process can move it (a finish racing a stop must not flip stopped→done). */
const TERMINAL: ReadonlySet<InstanceState> = new Set(['done', 'errored', 'stopped']);

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
  /** absolute path to this instance's task.ts source — so the brain can read_file/
   *  edit_file the actual code when the user asks how the task works. */
  filePath: string;
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
  /** the model this task chose (manifest.model), injected as TASK_MODEL so the
   *  harness's this.ask / this.agent / vision run on it. Omit = dock default. */
  model?: string;
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
  /** how to run a task process: 'child' (default — dies with the station) or
   *  'tmux' (attachable window; falls back to 'child' when tmux isn't installed).
   *  Unset → TASK_RUNNER_DEFAULT ('child'). */
  runner?: () => 'tmux' | 'child';
  /** extra env vars injected into every spawned task (e.g. BRAIN_MODEL for the
   *  vision helper). Read at spawn time so config changes apply to new tasks. */
  extraEnv?: () => Record<string, string>;
  /** TEST SEAM: override how a process is launched. Given the instance + its env,
   *  returns a `kill` fn the supervisor calls to terminate it. When set, neither
   *  tmux nor child_process is touched — used to drive the lifecycle state machine
   *  deterministically without real processes. Production leaves this undefined. */
  spawnProcess?: (instanceId: string, env: Record<string, string>) => { kill: () => void };
}

interface Entry {
  info: InstanceInfo;
  filePath: string;
  /** the task's chosen model (manifest.model), injected as TASK_MODEL on spawn so
   *  this.ask/this.agent/vision use it. undefined = dock default (BRAIN_MODEL). */
  model?: string;
  /** the child process (child runner). undefined for tmux or after a kill. */
  child?: ChildProcess;
  /** the tmux session name IF this instance was tmux-spawned; else undefined.
   *  Drives #kill — we only `tmux kill-session` instances we actually launched
   *  in tmux (child-runner instances never touch tmux). */
  tmuxName?: string;
  /** TEST SEAM kill handle (set when SupervisorDeps.spawnProcess is used). */
  killFn?: () => void;
  status: string;               // last reported getStatus()/status() line
  log: string[];                // tail of process stderr/stdout + lifecycle notes
}

/**
 * Default task runner. 'child' is deliberate: a child process dies WITH the
 * station (its WS drops, it self-exits) — so a station restart leaves no orphans
 * and there is nothing to rehydrate or manage. 'tmux' gives an attachable window
 * to watch a task live, but a tmux session OUTLIVES the station: after a restart
 * the new supervisor can't see (or kill) a long-sleeping task left behind. So tmux
 * is opt-in (set `brainTaskRunner: 'tmux'` when you knowingly want to watch one).
 */
const TASK_RUNNER_DEFAULT: 'tmux' | 'child' = 'child';

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

  /** Mint a fresh, currently-unused instanceId (`t-` + 4 hex). */
  #newId(): string {
    let id = `t-${randomUUID().slice(0, 4)}`;
    while (this.#byId.has(id)) id = `t-${randomUUID().slice(0, 4)}`;
    return id;
  }

  /** Start a new instance from a definition file. Returns its instanceId. */
  start(args: StartArgs): string {
    const instanceId = this.#newId();
    const info: InstanceInfo = {
      instanceId, dock: args.dock, name: args.name, params: args.params,
      parentSessionId: args.parentSessionId, state: 'running',
      startedAt: Date.now(), runCount: 0, spawnedAt: Date.now(),
      filePath: args.filePath,
    };
    const dir = this.#dir(args.dock, instanceId);
    mkdirSync(dir, { recursive: true });
    // seed the checkpoint with the params (the process reads it via our init frame).
    this.#byId.set(instanceId, { info, filePath: args.filePath, model: args.model, status: '', log: [] });
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
      ...(this.d.extraEnv?.() ?? {}), // e.g. BRAIN_MODEL (the dock default) for the harness
      STATION_WS: this.d.stationWsUrl,
      TASK_DOCK: dock,
      TASK_INSTANCE_ID: instanceId,
      TASK_NAME: name,
      TASK_SESSION_ID: parentSessionId,
      // the task's OWN model choice (manifest.model) wins over the dock default;
      // only set when chosen, so LLM-free tasks just inherit BRAIN_MODEL harmlessly.
      ...(e.model ? { TASK_MODEL: e.model } : {}),
    };
    const logFile = join(this.#dir(dock, instanceId), 'task.log');
    const note = (line: string) => {
      e.log.push(line); if (e.log.length > 400) e.log.shift();
      try { appendFileSync(logFile, line + '\n'); } catch { /* best effort */ }
    };

    // TEST SEAM: a fake launcher drives the lifecycle without real processes.
    if (this.d.spawnProcess) {
      e.tmuxName = undefined;
      e.child = undefined;
      e.killFn = this.d.spawnProcess(instanceId, env).kill;
      note('[spawn] (test seam)');
      return;
    }

    const cwd = serverCwd();
    // 'child' by default (dies with the station — no orphans); 'tmux' only when
    // explicitly chosen AND available. See TASK_RUNNER_DEFAULT.
    const useTmux = (this.d.runner?.() ?? TASK_RUNNER_DEFAULT) === 'tmux' && hasTmux();
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
      // (onFrame). No child handle — #kill kills the tmux session by name.
      e.child = undefined;
      e.tmuxName = tmuxName;
    } else {
      // Spawn tsx DIRECTLY (not `npx tsx`) as a DETACHED process-group leader. The
      // `npx`→npm-exec→tsx→node chain meant a SIGKILL hit only the wrapper and the
      // real task survived as an orphaned grandchild; spawning the workspace tsx
      // binary directly + killing the whole group (kill(-pid)) guarantees the task
      // actually dies on stop(). detached:true makes the child its own group leader.
      const child: ChildProcess = spawn(process.execPath, [tsxBin(), e.filePath],
        { env, cwd, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
      child.stdout?.on('data', (b) => note(`[out] ${String(b).trimEnd()}`));
      child.stderr?.on('data', (b) => note(`[err] ${String(b).trimEnd()}`));
      note(`[spawn] tsx ${e.filePath} (cwd ${cwd}, pid ${child.pid})`);
      e.child = child;
      e.tmuxName = undefined;
      child.on('exit', (code) => {
        note(`[exit] code=${code ?? 'null'}`);
        // Ignore a STALE exit: if this isn't the entry's current child (a restart
        // already respawned), or the instance is already terminal, do nothing.
        if (e.child !== child || TERMINAL.has(e.info.state)) return;
        // a crash before any terminal frame → errored (finish/errored frames set
        // state first when the task exits normally).
        e.info.state = code === 0 ? 'done' : 'errored';
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
   *  `tasks`-topic publish from a task peer. Frames from an unknown instance, the
   *  wrong dock, or an ALREADY-TERMINAL instance are dropped (a finish/notify
   *  racing a stop must not resurrect or re-signal it — terminal is sticky). */
  onFrame(dock: string, f: TaskFrame): void {
    const e = this.#byId.get(f.instanceId);
    if (!e || e.info.dock !== dock) return;
    // a late frame from a dying/killed process is ignored once terminal — except
    // `checkpoint`, which is just a disk write and is always safe (and harmless).
    if (TERMINAL.has(e.info.state) && f.kind !== 'checkpoint') return;
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

  /** Hard stop: kill the process. The last checkpoint survives on disk. A task
   *  that already reached a terminal state (done/errored/stopped) is a no-op —
   *  killing is idempotent and we never relabel a `done` task as `stopped`. */
  stop(instanceId: string): boolean {
    const e = this.#byId.get(instanceId);
    if (!e) return false;
    if (TERMINAL.has(e.info.state)) { this.#kill(e); return false; }
    this.#kill(e);
    e.info.state = 'stopped';
    return true;
  }

  #kill(e: Entry): void {
    // test seam first (no real process behind it).
    if (e.killFn) { try { e.killFn(); } catch { /* ignore */ } e.killFn = undefined; }
    // only the runner we actually used: a tmux session (by name) OR a detached
    // child process group. Don't shell out to tmux for a child-runner instance.
    if (e.tmuxName) {
      spawnSync('tmux', ['kill-session', '-t', e.tmuxName], { stdio: 'ignore' });
      e.tmuxName = undefined;
    }
    if (e.child?.pid) {
      // the child is a detached group leader — kill the whole GROUP (negative pid)
      // so tsx's node grandchild dies too, not just the immediate process.
      try { process.kill(-e.child.pid, 'SIGKILL'); }
      catch { try { e.child.kill('SIGKILL'); } catch { /* already gone */ } }
    }
    e.child = undefined;
  }

  /** Resume a STOPPED task: respawn a fresh process from the checkpoint. Refuses a
   *  task that already completed/failed — resuming a `done` job would re-run it.
   *  (A `stuck` task is resumed by provideInput, not here. A `running` one is a
   *  no-op restart so the caller can force a fresh process.) */
  resume(instanceId: string): boolean {
    const e = this.#byId.get(instanceId);
    if (!e) return false;
    if (e.info.state === 'done' || e.info.state === 'errored') return false;
    this.#kill(e);
    e.info.state = 'running';
    this.#spawn(instanceId);
    return true;
  }
  /** Pause is just stop (a free-running process has no mid-run pause). */
  pause(instanceId: string): boolean { return this.stop(instanceId); }
  /** Restart = stop + respawn from checkpoint. Refused once terminal (done/errored). */
  restart(instanceId: string): boolean {
    const e = this.#byId.get(instanceId);
    if (!e || e.info.state === 'done' || e.info.state === 'errored') return false;
    this.stop(instanceId);
    return this.resume(instanceId);
  }

  /** Answer a STUCK task: send `input` down; it resolves the awaiting ask. Only a
   *  stuck task is waiting for input — refuse otherwise (nothing to deliver to). */
  provideInput(instanceId: string, answer: string): boolean {
    const e = this.#byId.get(instanceId);
    if (!e || e.info.state !== 'stuck') return false;
    this.d.sendToTask(e.info.dock, instanceId, 'input', { answer });
    e.info.state = 'running';
    return true;
  }

  /** Stop every STILL-RUNNING instance under a parent session (the session-end
   *  cascade). Already-terminal instances are left as-is (a `done` task must not
   *  be relabeled `stopped`). Returns the ids it actually stopped. */
  stopForParent(dock: string, parentSessionId: string): string[] {
    const ids: string[] = [];
    for (const e of this.#byId.values()) {
      if (e.info.dock === dock && e.info.parentSessionId === parentSessionId
          && !TERMINAL.has(e.info.state)) {
        this.stop(e.info.instanceId); ids.push(e.info.instanceId);
      }
    }
    return ids;
  }

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
/** The tsx CLI to run a task.ts with `node <tsxBin> task.ts` — the workspace tsx,
 *  hoisted to the orbit-station root (one level above the server package). Running
 *  it directly (vs `npx tsx`) avoids an npm-exec wrapper process so a kill reaches
 *  the real task. */
function tsxBin(): string {
  return new URL('../../../../../node_modules/tsx/dist/cli.mjs', import.meta.url).pathname;
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

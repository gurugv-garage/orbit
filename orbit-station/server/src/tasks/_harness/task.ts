/**
 * The Task base class — what an LLM-authored task.ts extends.
 *
 * A task is a SEPARATE OS PROCESS (spawned by the supervisor, run via `npx tsx`).
 * When the process boots, `runTask(MyTask)` (see ./run.ts) constructs the task and
 * calls `start()`. `start()` is OURS: it connects to the station as a WebSocket
 * client, waits until the connection is stable + the station has sent the `init`
 * frame (params + any resume checkpoint), and ONLY THEN calls the subclass `run()`.
 *
 * The LLM implements just TWO things:
 *   - run()        the actual work (a plain async method; loop/sleep/call APIs/…)
 *   - getStatus()  one line describing current progress (the pull surface)
 *
 * Everything that crosses back to the parent agent is a base-class primitive — a
 * message on the `tasks` WS topic, scoped to this task's session:
 *   - this.status(text)          set what get_task_status returns
 *   - this.notifyAgent(text,img) push an update to the dock's agent/user
 *   - this.askAgentInput(prompt)  ask the agent/user and AWAIT their answer
 *   - this.finish(summary)/this.errored(why)  the terminal outcome
 *   - this.checkpoint()          persist this.state (reloaded on resume)
 *   - this.sleep(ms|"5s")        abort-aware-ish wait
 *
 * Read-only context (set before run()): this.params (the inputs) and
 * this.instance (what THIS instance is about — name, params, startedAt, runCount).
 *
 * There is NO askVlm/frame/move here — a task is a real Node process; if it needs
 * the camera or body it sends its own WS message. We don't curate a capability
 * menu.
 */
import { WebSocket } from 'ws';
import { durationMs } from './types.js';

/** Identity the supervisor spawns the process with (env, no token — see CLAUDE.md). */
export interface TaskIdentity {
  stationWsUrl: string;
  dock: string;
  instanceId: string;
  /** the task definition name (for logging/labels). */
  name: string;
  /** the parent conversational session this task belongs to. */
  sessionId: string;
}

/** Read identity from the process env the supervisor set. */
export function identityFromEnv(): TaskIdentity {
  const need = (k: string): string => {
    const v = process.env[k];
    if (!v) throw new Error(`task process missing env ${k}`);
    return v;
  };
  return {
    stationWsUrl: process.env.STATION_WS ?? 'ws://localhost:8099/ws',
    dock: need('TASK_DOCK'),
    instanceId: need('TASK_INSTANCE_ID'),
    name: need('TASK_NAME'),
    sessionId: need('TASK_SESSION_ID'),
  };
}

/**
 * What THIS running instance is about — set by the base class from the station's
 * `init` frame before run(). The supervisor is the source of truth (it knows when
 * the instance was first started, how many times it has been respawned, etc.). A
 * task can read `this.instance` for logging / status / branching on resume.
 */
export interface TaskInstanceInfo {
  /** the definition this instance was started from. */
  name: string;
  /** this instance's id (stable across respawns/resume). */
  instanceId: string;
  /** the dock it runs for. */
  dock: string;
  /** the parent conversational session it belongs to. */
  sessionId: string;
  /** the run_task inputs this instance was started with. */
  params: Record<string, unknown>;
  /** epoch ms when this instance was FIRST started (survives respawns). */
  startedAt: number;
  /** how many times the process has been (re)spawned — 1 on first run, 2+ after a
   *  resume/restart/crash-restart. */
  runCount: number;
  /** epoch ms of THIS process's spawn (differs from startedAt after a resume). */
  spawnedAt: number;
  /** a one-line human description of what this instance is doing (e.g.
   *  "remind-after: 'take a bath' in 5m"), assembled by the supervisor. */
  about: string;
}

export abstract class Task {
  /** the run_task inputs (set from the station's `init` frame before run()). */
  protected params: Record<string, unknown> = {};
  /** a free checkpoint store; mutate freely, call this.checkpoint() to persist. */
  protected state: Record<string, unknown> = {};
  /** what THIS instance is about — name, params, when first started, run count.
   *  Set from `init` before run(). See {@link TaskInstanceInfo}. */
  protected instance!: TaskInstanceInfo;

  #ws?: WebSocket;
  #ident!: TaskIdentity;
  #ready?: () => void;          // resolves once `init` arrives
  #initReceived = false;
  #pendingAsk?: (answer: string) => void;
  #done = false;

  // ── what the LLM implements ────────────────────────────────────────────────
  /** the actual work. May loop; should reach finish()/errored(). */
  abstract run(): Promise<void>;
  /** one line describing current progress (returned by get_task_status). */
  abstract getStatus(): string;

  // ── the boot path (ours) ───────────────────────────────────────────────────
  /**
   * Connect to the station, wait for a STABLE connection + the `init` frame, then
   * run(). On terminal outcome (finish/errored) or run() returning, the process
   * exits. Throws if the connection can't be established.
   */
  async start(ident: TaskIdentity): Promise<void> {
    this.#ident = ident;
    await this.#connect();
    // init carries params + any resume checkpoint; run() must not start before it.
    await new Promise<void>((resolve) => {
      if (this.#initReceived) return resolve();
      this.#ready = resolve;
    });
    try {
      await this.run();
      // run() returned without an explicit terminal — treat as finished.
      if (!this.#done) this.finish();
    } catch (err) {
      if (!this.#done) this.errored(String((err as Error)?.stack ?? err));
    } finally {
      // let the last frame flush, then exit so the process (tmux window) closes.
      await this.#sleepReal(150);
      this.#ws?.close();
    }
  }

  #connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.#ident.stationWsUrl, { rejectUnauthorized: false });
      this.#ws = ws;
      let opened = false;
      ws.on('open', () => {
        opened = true;
        // identify as a task peer; (dock, component) is the address the station
        // routes our directed frames to. component = task:<instanceId>.
        this.#send({
          t: 'hello', role: 'task', id: `task-${this.#ident.instanceId}`,
          dock: this.#ident.dock, component: `task:${this.#ident.instanceId}`,
          kind: 'dock-task', label: `${this.#ident.name} (${this.#ident.instanceId})`,
        });
        this.#send({ t: 'subscribe', topics: ['tasks'] });
        // announce ourselves on the tasks topic so the station binds us + sends init.
        this.#publish('attach', {
          instanceId: this.#ident.instanceId, sessionId: this.#ident.sessionId, name: this.#ident.name,
        });
        resolve(); // connection is open + we've said hello; init follows asynchronously.
      });
      ws.on('message', (raw) => this.#onMessage(raw.toString()));
      ws.on('error', (e) => { if (!opened) reject(e); });
      ws.on('close', () => {
        // station went away mid-run: nothing to report to; just exit.
        if (!this.#done) process.exit(0);
      });
    });
  }

  #onMessage(raw: string): void {
    let f: any;
    try { f = JSON.parse(raw); } catch { return; }
    if (f.t !== 'event' || f.topic !== 'tasks') return;
    const p = f.payload ?? {};
    // only handle frames addressed to THIS instance.
    if (p.instanceId && p.instanceId !== this.#ident.instanceId) return;
    switch (f.kind) {
      case 'init':
        this.params = p.params ?? {};
        this.state = p.state ?? {};
        this.instance = {
          name: this.#ident.name,
          instanceId: this.#ident.instanceId,
          dock: this.#ident.dock,
          sessionId: this.#ident.sessionId,
          params: this.params,
          startedAt: Number(p.startedAt) || Date.now(),
          runCount: Number(p.runCount) || 1,
          spawnedAt: Number(p.spawnedAt) || Date.now(),
          about: typeof p.about === 'string' ? p.about : `${this.#ident.name} (${this.#ident.instanceId})`,
        };
        this.#initReceived = true;
        this.#ready?.();
        break;
      case 'input':
        this.#pendingAsk?.(String(p.answer ?? ''));
        this.#pendingAsk = undefined;
        break;
      case 'stop':
        // hard stop is a process kill by the supervisor; this is a courtesy frame.
        process.exit(0);
    }
  }

  // ── the primitives (LLM-facing) ────────────────────────────────────────────
  /** set the pull-surface status string. */
  protected status(text: string): void {
    this.#publish('status', { status: text });
  }
  /** push an update up to the dock's agent/user (becomes an autonomous turn). */
  protected async notifyAgent(text: string, image?: string): Promise<void> {
    this.#publish('notify', { text, ...(image ? { image } : {}) });
  }
  /** ask the agent/user a question and AWAIT the answer (the stuck path). */
  protected askAgentInput(prompt: string): Promise<string> {
    this.#publish('ask', { prompt });
    return new Promise((resolve) => { this.#pendingAsk = resolve; });
  }
  /** persist this.state so a resume (respawn) reloads it. */
  protected checkpoint(): void {
    this.#publish('checkpoint', { state: this.state });
  }
  /** terminal: succeeded. */
  protected finish(summary?: string): void {
    if (this.#done) return;
    this.#done = true;
    this.#publish('finish', { summary: summary ?? this.getStatusSafe() });
  }
  /** terminal: failed. */
  protected errored(why: string): void {
    if (this.#done) return;
    this.#done = true;
    this.#publish('errored', { why });
  }
  /** abort-aware-ish sleep ("5s" | 1000). */
  protected sleep(ms: number | string): Promise<void> {
    const n = typeof ms === 'number' ? ms : durationMs(ms);
    if (!Number.isFinite(n) || n < 0) throw new Error(`sleep got a bad duration (${JSON.stringify(ms)})`);
    return this.#sleepReal(n);
  }

  // ── internals ──────────────────────────────────────────────────────────────
  #sleepReal(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }
  getStatusSafe(): string {
    try { return this.getStatus(); } catch { return ''; }
  }
  #publish(kind: string, payload: Record<string, unknown>): void {
    this.#send({ t: 'publish', topic: 'tasks', kind, payload: { instanceId: this.#ident.instanceId, ...payload } });
  }
  #send(obj: unknown): void {
    try { this.#ws?.send(JSON.stringify(obj)); } catch { /* socket gone */ }
  }
}

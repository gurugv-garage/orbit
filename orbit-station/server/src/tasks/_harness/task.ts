/**
 * The Task base class — what an LLM-authored task.ts extends.
 *
 * A task is a SEPARATE OS PROCESS (spawned by the supervisor via `tsx`).
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
 *   - this.sleep(ms|"5s")        wait (NOT interruptible — stop = kill the process)
 *
 * Read-only context (set before run()): this.params (the inputs) and
 * this.instance (what THIS instance is about — name, params, startedAt, runCount).
 *
 * STATION CAPABILITIES — `await this.request(op, args)` asks the station to run a
 * registered handler for things that need the station's LIVE IN-PROCESS STATE: the
 * decoded camera frame (this.frame()), who's present (recognize), the body
 * (this.move()). A task runs in the SAME ENVIRONMENT as the station (same machine,
 * same .env, same node_modules), so for anything else — running an LLM to reason
 * about a frame, importing a module, calling HTTP — it just does it ITSELF. For the
 * LLM, the base class exposes `this.agent` (a ready-to-use pi Agent: the dock's
 * model + the env key, already wired) and `this.ask(content)` (one-shot →
 * the text answer). Vision sugar `askVision`/`isTrueInImage` wrap that for the
 * common image case. Which station `op`s a dock exposes is advertised at authoring
 * time.
 */
import { WebSocket } from 'ws';
import type { Agent, AgentMessage } from '@earendil-works/pi-agent-core';
import { durationMs } from './types.js';
import { parseClock, msUntilNext } from './clock.js';
import { DockMemory } from './memory.js';

/** Liveness: the station's hub pings every ~2s. If a task hears nothing at all for
 *  this long, it assumes the station died abruptly (SIGKILL/crash — no clean WS
 *  close) and self-exits, so no task ever outlives its station. */
const STATION_SILENCE_MS = 10_000;
const WATCHDOG_TICK_MS = 2_000;

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
  #pendingAsk?: { resolve: (answer: string) => void; reject: (err: Error) => void };
  /** in-flight this.request() calls, keyed by reqId → its promise resolvers. */
  #pendingReq = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  #reqSeq = 0;
  #done = false;
  #lastHeard = Date.now();      // last station ping/message — the liveness clock
  #watchdog?: ReturnType<typeof setInterval>;
  #agentInstance?: Agent;

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
    // Safety net: a crash in the LLM-authored body (an unhandled rejection or a
    // throw outside the run() await chain — e.g. an unawaited askAgentInput that
    // got superseded) should still tell the PARENT why, not just exit silently.
    const crash = (err: unknown) => {
      const why = String((err as Error)?.stack ?? err);
      if (!this.#done) this.errored(why);
      setTimeout(() => process.exit(1), 150);   // let the errored frame flush
    };
    process.on('unhandledRejection', crash);
    process.on('uncaughtException', crash);
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
      if (this.#watchdog) clearInterval(this.#watchdog);
      for (const pend of this.#pendingReq.values()) { clearTimeout(pend.timer); pend.reject(new Error('task ending')); }
      this.#pendingReq.clear();
      // let the last frame flush, then exit so the process closes.
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
      ws.on('message', (raw) => { this.#lastHeard = Date.now(); this.#onMessage(raw.toString()); });
      // the station pings every ~2s (hub liveness sweep); any ping/pong/message
      // resets the liveness clock.
      ws.on('ping', () => { this.#lastHeard = Date.now(); });
      ws.on('pong', () => { this.#lastHeard = Date.now(); });
      ws.on('error', (e) => { if (!opened) reject(e); });
      ws.on('close', () => {
        // station went away mid-run: nothing to report to; just exit.
        if (!this.#done) process.exit(0);
      });
      // WATCHDOG: a `sleep`ing task has an idle socket, so an ABRUPTLY-dead station
      // (SIGKILL/crash) won't fire 'close' for a long time and the process would
      // orphan. The hub pings every ~2s; if we hear NOTHING for STATION_SILENCE_MS
      // the station is gone — self-exit so no task outlives its station.
      this.#watchdog = setInterval(() => {
        if (Date.now() - this.#lastHeard > STATION_SILENCE_MS) {
          if (this.#watchdog) clearInterval(this.#watchdog);
          process.exit(0);
        }
      }, WATCHDOG_TICK_MS);
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
        // Idempotent: a reconnect re-sends `attach`, which makes the station
        // re-send `init`. Honour only the FIRST — re-applying the on-disk
        // checkpoint would clobber in-memory progress since the last checkpoint().
        if (this.#initReceived) break;
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
      case 'input': {
        const pending = this.#pendingAsk;
        this.#pendingAsk = undefined;
        pending?.resolve(String(p.answer ?? ''));
        break;
      }
      case 'response': {
        // a station capability replied; resolve/reject the matching this.request().
        const reqId = String(p.reqId ?? '');
        const pend = this.#pendingReq.get(reqId);
        if (!pend) break;
        this.#pendingReq.delete(reqId);
        clearTimeout(pend.timer);
        if (p.ok) pend.resolve(p.result);
        else pend.reject(new Error(String(p.error ?? 'capability failed')));
        break;
      }
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
  /** push an update up to the dock's agent/user (becomes an autonomous turn).
   *  Fire-and-forget — it resolves as soon as the frame is queued on the socket,
   *  not when the user sees it (returns a Promise only for `await` convenience). */
  protected notifyAgent(text: string, image?: string): Promise<void> {
    this.#publish('notify', { text, ...(image ? { image } : {}) });
    return Promise.resolve();
  }
  /** ask the agent/user a question and AWAIT the answer (the stuck path). Only one
   *  ask can be outstanding; asking again before an answer rejects the earlier
   *  promise (so a forgotten ask can't leak a forever-pending await). */
  protected askAgentInput(prompt: string): Promise<string> {
    this.#pendingAsk?.reject(new Error('askAgentInput superseded by a newer ask'));
    this.#publish('ask', { prompt });
    return new Promise((resolve, reject) => { this.#pendingAsk = { resolve, reject }; });
  }
  /** Ask the STATION to run a registered capability and await the result. The op
   *  must be one the dock exposes (advertised at authoring time); an unknown or
   *  unavailable op rejects. Rejects after `timeoutMs` so a task never hangs on a
   *  missing handler. Typed sugar (this.frame/move) wraps common ops. */
  protected request<T = unknown>(op: string, args: Record<string, unknown> = {}, timeoutMs = 20_000): Promise<T> {
    const reqId = `q${++this.#reqSeq}`;
    this.#publish('request', { reqId, op, args });
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pendingReq.delete(reqId);
        reject(new Error(`station capability "${op}" timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      timer.unref?.();
      this.#pendingReq.set(reqId, { resolve: resolve as (v: unknown) => void, reject, timer });
    });
  }
  /** the dock's latest camera frame as a base64 JPEG (or undefined if none). To
   *  REASON about it, run your own pi Agent — the model key is in process.env. */
  protected frame(): Promise<string | undefined> { return this.request('frame'); }
  /** drive the dock body with move steps (fire-and-forget on the station side). */
  protected move(steps: unknown[]): Promise<void> { return this.request('move', { steps }); }
  /** The latest on-device face boxes via `face-track` — [] on ANY error (a transient
   *  read failure reads as "no faces", never a crash). Shared face source for body
   *  tasks; callers needing the full typed shape can request('face-track') directly. */
  protected async trackFaces(): Promise<Array<{ box?: unknown; name?: string }>> {
    try {
      const out = await this.request<{ faces?: Array<{ box?: unknown; name?: string }> }>('face-track');
      return (out?.faces ?? []).filter((f) => f.box);
    } catch { return []; }
  }
  /** Hold the body lease through `ms` of wall-clock (a long move/gesture playing
   *  station-side): sleep in short slices, renewing via `bodyHeld` each slice. The slice
   *  must stay well under the lease TTL (1500 ms — bodylink/lease.ts LeaseOpts; keep in
   *  sync) or the hold expires mid-step and an equal-priority waiter legally steals the
   *  body (seen live 2026-07-05). Returns false the moment we no longer hold. */
  protected async holdBodyThrough(ms: number): Promise<boolean> {
    const SLICE_MS = 500;
    for (let remain = ms; remain > 0; remain -= SLICE_MS) {
      await this.sleep(Math.min(remain, SLICE_MS));
      const held = await this.request<{ held: boolean }>('bodyHeld').catch(() => ({ held: true }));
      if (!held?.held) return false;
    }
    return true;
  }

  // ── Memory (DIRECT — not a capability) ───────────────────────────────────────
  // Memory is a sqlite file + an env-keyed embedder, all reconstructible from the
  // SHARED code + `.env` a task already has — so a task opens it DIRECTLY, no wire.
  // (Capabilities, above, are only for the station's LIVE in-process state — the
  // decoded camera frame, the body link — that a separate process can't rebuild.)
  // `this.memory` is dock-SCOPED: the dock is bound here (the task's verified
  // identity), never an argument, so a task can only touch its own dock's beliefs.
  // Lazily constructed (and the heavy deps imported) on first use.
  #memory?: DockMemory;
  protected get memory(): DockMemory {
    if (!this.#memory) this.#memory = new DockMemory(this.#ident.dock);
    return this.#memory;
  }

  // ── Slack (a SELF action — NOT a station capability) ─────────────────────────
  // A task runs in the station's environment (same .env, node_modules), so it
  // talks to Slack DIRECTLY — no WS round-trip. These wrap the station's slack
  // helper (bot token from the env) so a task needn't know its import path/API.
  // All throw on failure (bad token / channel / scope). `channel` is a #name or
  // id; omit it to use SLACK_DEFAULT_CHANNEL.

  /** Post a message to a Slack channel (mrkdwn supported). */
  protected async sendToSlack(text: string, channel?: string): Promise<void> {
    const slack = await import('../../integrations/slack.js');
    await slack.postMessage({ text, channel });
  }
  /** Take/Use a camera frame and post it to Slack as a photo. Pass a base64 JPEG
   *  (e.g. from `await this.frame()`); omit to grab the current frame here.
   *  Throws if there's no frame to send. */
  protected async sendPhotoToSlack(opts: { channel?: string; caption?: string; jpegBase64?: string } = {}): Promise<void> {
    const jpeg = opts.jpegBase64 ?? (await this.frame());
    if (!jpeg) throw new Error('no camera frame to send (the dock is not streaming)');
    const slack = await import('../../integrations/slack.js');
    await slack.uploadFile({
      channel: opts.channel,
      bytes: Buffer.from(jpeg, 'base64'),
      filename: `photo-${Date.now()}.jpg`,
      title: opts.caption,
      initialComment: opts.caption,
    });
  }
  /** Direct-message a person on Slack (by name, @handle, or email). */
  protected async dmOnSlack(user: string, text: string): Promise<void> {
    const slack = await import('../../integrations/slack.js');
    await slack.dmUser(user, text);
  }

  /** THE TASK'S OWN LLM — a ready-to-use pi Agent (the dock's model + the provider
   *  key from env, already wired). The CORE reasoning primitive: vision,
   *  classification, summarization, multi-step, tool use — drive it directly. Built
   *  lazily on first use (pi is imported only when you actually use the LLM). For
   *  the common "ask once, get text" case prefer `this.ask(...)`. */
  protected async getAgent(): Promise<Agent> {
    if (!this.#agentInstance) {
      const { Agent } = await import('@earendil-works/pi-agent-core');
      const { taskModel, taskApiKey } = await import('./model.js');
      const agent = new Agent({
        initialState: { systemPrompt: 'You are a helper for a small desk robot. Be concise and answer directly.', model: taskModel(), thinkingLevel: 'off', tools: [], messages: [] },
        getApiKey: (provider: string) => taskApiKey(provider),
      } as never);
      // Wrap prompt() so EVERY LLM call — `this.ask` AND author-driven
      // getAgent().prompt() — ships its usage to obs, so task spend rolls up in
      // the Cost tab under this dock. The model's own cost (pi list pricing) is
      // on the last assistant message after prompt() resolves.
      const origPrompt = agent.prompt.bind(agent);
      agent.prompt = (async (...args: Parameters<Agent['prompt']>) => {
        const r = await origPrompt(...args);
        try { this.#shipLlmUsage(agent); } catch { /* obs must never break a task */ }
        return r;
      }) as Agent['prompt'];
      this.#agentInstance = agent;
    }
    return this.#agentInstance;
  }
  /** One-shot over the task's own agent: send `content` (text and/or images),
   *  return the assistant's TEXT reply. The common shape — most reasoning is "ask
   *  once, read the answer". For multi-turn/tools use `await this.getAgent()`.
   *  `content` items: {type:'text',text} / {type:'image',data:<base64 jpeg>,
   *  mimeType:'image/jpeg'} (an image is exactly what this.frame() returns). */
  protected async ask(content: Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType?: string }>): Promise<string> {
    const agent = await this.getAgent();
    const { assistantText } = await import('./model.js');
    await agent.prompt([{ role: 'user', content, timestamp: Date.now() } as AgentMessage]);
    return assistantText(agent.state.messages) || '(no answer)';
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
  /** Wait ("5s" | 1000). NOT interruptible — a stop kills the whole process, so a
   *  task does not need (and cannot use) an abort signal. */
  protected sleep(ms: number | string): Promise<void> {
    const n = typeof ms === 'number' ? ms : durationMs(ms);
    if (!Number.isFinite(n) || n < 0) throw new Error(`sleep got a bad duration (${JSON.stringify(ms)})`);
    return this.#sleepReal(n);
  }
  /** Wait until the NEXT wall-clock occurrence of `time` — "19:20", "7:20pm",
   *  "4:40 PM", "7am" — in the station's local timezone (today if still ahead,
   *  else tomorrow). Use this for "at TIME of day"; never hand-parse clock times. */
  protected sleepUntil(time: string): Promise<void> {
    const clock = parseClock(time);
    if (!clock) throw new Error(`sleepUntil could not parse the time ${JSON.stringify(time)} — use e.g. "7:20pm" or "19:20"`);
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
    return this.#sleepReal(msUntilNext(clock, tz));
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

  // ── obs: report the task's OWN LLM spend ─────────────────────────────────────
  #obsSeq = 0;

  /** Ship the last assistant message's usage to obs as a minimal one-step turn,
   *  so the task's own LLM calls appear in the Cost tab (kind=task) under its
   *  dock. One `ask`/`prompt` = one obs turn. Best-effort; never throws. */
  #shipLlmUsage(agent: Agent): void {
    const msgs = agent.state.messages as Array<{ role?: string; usage?: { input?: number; output?: number; totalTokens?: number; cost?: { total?: number }; model?: string }; model?: string }>;
    const last = msgs.at(-1);
    const u = last?.role === 'assistant' ? last.usage : undefined;
    if (!u) return; // no usage reported (faux model / error) — nothing to bill.
    const ts = Date.now();
    const sessionId = `task:${this.#ident.name}:${this.#ident.instanceId}`;
    const turnId = `t-${(this.#obsSeq++).toString(36)}`;
    const model = last?.model ?? '';
    const base = { sessionId, turnId, source: this.#ident.dock };
    // a self-contained one-step turn: Start → Step(usage) → End.
    this.#shipObs({ ...base, kind: 'TurnStart', ts, seq: 0, data: { trigger: { kind: 'task', text: this.#ident.name } } });
    this.#shipObs({ ...base, kind: 'StepStart', ts, seq: 1 });
    this.#shipObs({ ...base, kind: 'StepEnd', ts, seq: 2, data: {
      model,
      usage: { inputTokens: u.input, outputTokens: u.output, totalTokens: u.totalTokens, cost: u.cost?.total },
    } });
    this.#shipObs({ ...base, kind: 'TurnEnd', ts, seq: 3 });
  }

  /** Publish one obs event on the `obs` topic (the station's ObsStore ingests it).
   *  Shape mirrors AgentEventDto; `source` self-declares the owning dock. */
  #shipObs(ev: Record<string, unknown>): void {
    this.#send({ t: 'publish', topic: 'obs', kind: 'event', payload: ev });
  }
  #send(obj: unknown): void {
    try { this.#ws?.send(JSON.stringify(obj)); } catch { /* socket gone */ }
  }
}

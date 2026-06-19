/**
 * Task capabilities — the station-side surface a task PROCESS can invoke over the
 * wire (docs/tasks.md §"capability layer"). A task runs as its own process; when
 * it needs something only the station can do (grab the dock's current camera frame,
 * ask a vision model, drive the body), it sends a `request` frame and the station
 * runs a REGISTERED handler and replies. This is the inverse of RpcBroker (which
 * RPCs OUT to the phone) — here a task RPCs IN to the station.
 *
 * Design (kept small on purpose):
 *   - A capability is a NAMED, registered handler — never arbitrary code. A task can
 *     only invoke what the station chose to expose.
 *   - Each registration declares `requires?` (a dock capability tag like 'camera' or
 *     'servo'); the registry advertises + gates per-dock, so a bodyless dock never
 *     sees (or can run) `move`. Tenancy is the task's verified dock (from its hello),
 *     never an argument.
 *   - `describe` + `when` feed the task-authoring prompt so the author knows what
 *     exists and when to use it — built per-dock (see buildTaskTools / authoring).
 *
 * The task side correlates request↔response by `reqId` (see _harness/task.ts); the
 * broker here just invokes the handler and ships the result back via sendToTask.
 */

/** Context every handler gets — the task's verified identity. Never from args. */
export interface CapabilityCtx {
  dock: string;
  instanceId: string;
}

/** One registered capability. */
export interface Capability {
  /** the `op` a task names in this.request(op, …). kebab/snake, stable. */
  op: string;
  /** a dock capability tag this needs (e.g. 'camera', 'servo'); omit = always available. */
  requires?: string;
  /** one line for the author: the call signature + what it returns. */
  describe: string;
  /** one line for the author: when to reach for it. */
  when: string;
  /** run it. Returns the JSON-able result handed back to the task. May throw —
   *  the broker turns a throw into an error response. */
  handler: (ctx: CapabilityCtx, args: Record<string, unknown>) => Promise<unknown> | unknown;
}

/** Does a dock currently serve a capability tag? (camera/servo/…) Injected so the
 *  registry stays decoupled from the docs Directory. */
export type HasDockCap = (dock: string, cap: string) => boolean;

export class CapabilityRegistry {
  #byOp = new Map<string, Capability>();

  constructor(private readonly hasDockCap: HasDockCap) {}

  register(cap: Capability): this {
    if (this.#byOp.has(cap.op)) throw new Error(`capability "${cap.op}" already registered`);
    this.#byOp.set(cap.op, cap);
    return this;
  }

  /** The capabilities a given dock can use right now (requirements satisfied). */
  forDock(dock: string): Capability[] {
    return [...this.#byOp.values()].filter((c) => !c.requires || this.hasDockCap(dock, c.requires));
  }

  /** A per-dock advertisement block for the task-authoring prompt: each available
   *  capability as `• <describe> — <when>`. Empty string when the dock has none
   *  beyond the base primitives. */
  advertiseFor(dock: string): string {
    const caps = this.forDock(dock);
    if (caps.length === 0) return '';
    const lines = caps.map((c) => `• ${c.describe} — ${c.when}`).join('\n');
    return 'STATION CAPABILITIES (await this.request, or the typed helpers below) — '
      + 'this dock can also:\n' + lines;
  }

  /** Invoke an op for a dock. Refuses an unknown op or one whose requirement the
   *  dock doesn't meet. Returns a discriminated result (never throws). */
  async invoke(ctx: CapabilityCtx, op: string, args: Record<string, unknown>):
    Promise<{ ok: true; result: unknown } | { ok: false; error: string }> {
    const cap = this.#byOp.get(op);
    if (!cap) return { ok: false, error: `unknown capability "${op}"` };
    if (cap.requires && !this.hasDockCap(ctx.dock, cap.requires)) {
      // The dock declares this capability (the op was advertised at authoring time
      // because the dock serves it) but the component serving it is OFFLINE right
      // now — e.g. the phone dropped its WS for a moment. This is TRANSIENT, never a
      // statement that the dock lacks the hardware. Say so explicitly: an author LLM
      // that reads "has no camera" concludes the dock is camera-less forever and
      // gives up; it must instead keep retrying until the component reconnects.
      return {
        ok: false,
        error: `"${cap.requires}" momentarily unavailable on dock "${ctx.dock}" — the component `
          + `serving it (e.g. the phone for "camera") is offline RIGHT NOW, not absent. This is `
          + `transient: retry "${op}" after a short wait; it recovers when the component reconnects.`,
      };
    }
    try {
      return { ok: true, result: await cap.handler(ctx, args) };
    } catch (err) {
      return { ok: false, error: String((err as Error)?.message ?? err) };
    }
  }
}

/** Push a directed `response` frame back to a task peer. (The same shape the
 *  supervisor's sendToTask uses for init/input.) */
export type SendToTask = (dock: string, instanceId: string, kind: string, payload: Record<string, unknown>) => void;

/**
 * CapabilityBroker — handles `request` frames from task peers: dispatch to the
 * registry, ship a `response` back. Stateless beyond the registry; correlation by
 * reqId is the task's job.
 */
export class CapabilityBroker {
  constructor(
    private readonly registry: CapabilityRegistry,
    private readonly sendToTask: SendToTask,
  ) {}

  /** Handle one inbound `request` frame. `dock` is the SENDER's verified dock. */
  async handle(dock: string, instanceId: string, payload: Record<string, unknown>): Promise<void> {
    const reqId = typeof payload.reqId === 'string' ? payload.reqId : '';
    const op = typeof payload.op === 'string' ? payload.op : '';
    const args = (payload.args ?? {}) as Record<string, unknown>;
    if (!reqId) return; // can't reply without a correlation id; drop
    const r = await this.registry.invoke({ dock, instanceId }, op, args);
    this.sendToTask(dock, instanceId, 'response', r.ok
      ? { reqId, ok: true, result: r.result }
      : { reqId, ok: false, error: r.error });
  }
}

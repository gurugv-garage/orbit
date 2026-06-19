/**
 * RpcBroker — awaited tool calls to a dock component over the bus.
 *
 * The brain's phone-surface tools (set_face today) execute remotely: the
 * broker publishes a directed `tool-call` on the `agent` topic and resolves
 * the matching `tool-result` by reqId. Semantics (docs/decision-traces/server-brain-impl.md §2):
 *
 *   - fire-and-forget actuation: the device acks instantly after dispatching;
 *     one LAN RTT per call, never actuation-travel time.
 *   - NEVER hangs a turn: offline component → instant error result; timeout →
 *     error result. Errors flow back to the model as tool results, the loop
 *     continues, the model narrates.
 *   - at-most-once: unique reqIds, no retries ever (a missed nod is fine, a
 *     doubled servo move is not). Late results are logged and dropped.
 *   - peer-left: all in-flight calls for that dock resolve as errors.
 */

import { randomUUID } from 'node:crypto';
import type { Bus } from '../../core/bus.js';
import type { Directory } from '../docks/directory.js';

export interface RpcResult {
  content: string;
  isError: boolean;
}

interface Pending {
  dock: string;
  resolve: (r: RpcResult) => void;
  timer: NodeJS.Timeout;
}

export const DEFAULT_TOOL_TIMEOUT_MS = 10_000;

export class RpcBroker {
  #bus: Bus;
  #directory: Directory;
  #pending = new Map<string, Pending>();

  constructor(bus: Bus, directory: Directory) {
    this.#bus = bus;
    this.#directory = directory;
    bus.on('agent', (msg) => {
      if (msg.kind !== 'tool-result' || msg.source === 'station') return;
      const p = msg.payload as { reqId?: string; content?: string; isError?: boolean } | null;
      if (!p?.reqId) return;
      const pending = this.#pending.get(p.reqId);
      if (!pending) {
        console.warn(`[brain/rpc] late/unknown tool-result ${p.reqId} — dropped`);
        return;
      }
      this.#settle(p.reqId, {
        content: typeof p.content === 'string' ? p.content : '',
        isError: p.isError === true,
      });
    });
  }

  /**
   * Call a tool on the component of `dock` serving `cap`. Resolves with the
   * device's ack (or an error result) — never rejects, never hangs.
   */
  call(opts: {
    dock: string;
    cap: string;
    turnId: string;
    toolCallId: string;
    name: string;
    args: unknown;
    timeoutMs?: number;
  }): Promise<RpcResult> {
    const target = this.#directory.resolveCap(opts.dock, opts.cap);
    const component = target?.component;
    if (!component) {
      return Promise.resolve({
        content: `(no online component of ${opts.dock} serves '${opts.cap}')`,
        isError: true,
      });
    }
    const reqId = randomUUID();
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS;
    return new Promise<RpcResult>((resolve) => {
      // NOT unref'd: an in-flight call should keep the loop alive until it
      // settles — it's bounded by timeoutMs either way.
      const timer = setTimeout(() => {
        this.#settle(reqId, { content: '(no response from dock)', isError: true });
      }, timeoutMs);
      this.#pending.set(reqId, { dock: opts.dock, resolve, timer });
      this.#bus.publish({
        topic: 'agent',
        kind: 'tool-call',
        payload: {
          reqId, toolCallId: opts.toolCallId, turnId: opts.turnId,
          name: opts.name, args: opts.args, timeoutMs,
        },
        source: 'station',
        toAddr: { dock: opts.dock, component },
      });
    });
  }

  /** Peer-left / turn-abort: settle every in-flight call for a dock as an error. */
  rejectAllForDock(dock: string, reason: string): void {
    for (const [reqId, p] of [...this.#pending]) {
      if (p.dock === dock) this.#settle(reqId, { content: `(${reason})`, isError: true });
    }
  }

  /** in-flight count (tests + console). */
  inflight(dock?: string): number {
    if (dock == null) return this.#pending.size;
    return [...this.#pending.values()].filter((p) => p.dock === dock).length;
  }

  #settle(reqId: string, result: RpcResult): void {
    const p = this.#pending.get(reqId);
    if (!p) return;
    this.#pending.delete(reqId);
    clearTimeout(p.timer);
    p.resolve(result);
  }
}

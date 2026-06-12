/**
 * In-process event bus. The spine of the station.
 *
 * Everything that happens — a peer publishing an agent event, a config change,
 * a body command, a peer connecting — becomes a bus message on a topic. The WS
 * hub bridges the bus to/from sockets; modules subscribe to react. `mind` will
 * eventually be just another subscriber here.
 */

import type { ComponentAddr, Topic } from './protocol.js';

export interface BusMessage {
  topic: Topic;
  kind: string;
  payload: unknown;
  ts: number;
  /** id of the peer that originated it, or 'station' for internal. */
  source: string;
  /**
   * Optional target peer id. When set, the hub delivers this message ONLY to
   * that peer (still gated on topic subscription) — for directed pushes like
   * per-peer config snapshots. Unset = normal broadcast to all subscribers.
   */
  to?: string;
  /**
   * Optional target ADDRESS (dock + component slot) — the preferred way for
   * modules to direct a frame. Resolved against the live roster at fan-out
   * time by the hub, so reconnects/hardware swaps need nothing special on
   * the send path. If both `to` and `toAddr` are set, a peer matching either
   * receives it.
   */
  toAddr?: ComponentAddr;
}

/** True when a message is directed (peer-id or address). */
export function isDirected(msg: BusMessage): boolean {
  return msg.to != null || msg.toAddr != null;
}

type Handler = (msg: BusMessage) => void;

export class Bus {
  #handlers = new Map<Topic | '*', Set<Handler>>();

  /** Subscribe to one topic, or '*' for everything. Returns an unsubscribe fn. */
  on(topic: Topic | '*', handler: Handler): () => void {
    let set = this.#handlers.get(topic);
    if (!set) {
      set = new Set();
      this.#handlers.set(topic, set);
    }
    set.add(handler);
    return () => set!.delete(handler);
  }

  publish(msg: Omit<BusMessage, 'ts'> & { ts?: number }): void {
    const full: BusMessage = { ...msg, ts: msg.ts ?? Date.now() };
    this.#handlers.get(full.topic)?.forEach((h) => safe(h, full));
    this.#handlers.get('*')?.forEach((h) => safe(h, full));
  }
}

function safe(h: Handler, msg: BusMessage): void {
  try {
    h(msg);
  } catch (err) {
    console.error('[bus] handler threw', err);
  }
}

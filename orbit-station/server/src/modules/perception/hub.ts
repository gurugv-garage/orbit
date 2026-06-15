/**
 * ProcessingHub — the single fusion point for stream processing.
 *
 * It IS the SFU's one MediaTap (so the SFU stays unchanged and unaware there are
 * many consumers), AND it subscribes to the bus for WS-origin facts. It fans both,
 * source-filtered, to a runtime registry of StreamProcessors, and routes each
 * processor's emitted PerceptionResult onto the `perception` topic (directed to the
 * dock + an undirected copy the console panel/state aggregator consume).
 *
 * Decoupling: the hub takes a bus (publish/subscribe) and a `resolveDock(streamId)`
 * (peer id → dock name, from the live roster) — it never imports another module.
 * mediaModule is handed this hub as its tap (see main.ts), preserving media's
 * portability.
 *
 * Threading: every processor callback runs on the main event loop. The hub wraps
 * each in try/catch so a processor can never kill the SFU or the bus.
 */

import type { Bus, BusMessage } from '../../core/bus.js';
import type { MediaKind, MediaTap } from '../media/tap.js';
import type { MediaStreamTrack, RtpPacket } from 'werift';
import { makeResult, type PerceptionResult } from './result.js';
import {
  wantsSource,
  type ChannelItem,
  type StreamContext,
  type StreamProcessor,
} from './processor.js';

/**
 * Which bus messages become fact channels. The dock publishes client facts on the
 * `client` topic (kind = the fact name); we expose them as channel `client.<kind>`.
 * Other processors' outputs are delivered directly (not via the bus) for latency,
 * so this map is just the external (WS) → channel bridge.
 */
const CLIENT_TOPIC = 'client' as const;
const channelForBusMsg = (m: BusMessage): string | null =>
  m.topic === CLIENT_TOPIC ? `${CLIENT_TOPIC}.${m.kind}` : null;

/** map key for a live track (so a late processor can re-subscribe to its RTP). */
const trackKey = (streamId: string, kind: MediaKind): string => `${streamId}|${kind}`;

interface Registered {
  p: StreamProcessor;
  /** live ctx per active stream this processor has started on. */
  ctx: Map<string, StreamContext>;
}

export class ProcessingHub implements MediaTap {
  #bus: Bus;
  #resolveDock: (streamId: string) => string;
  #procs: Registered[] = [];
  /** active producer streamIds → their media kinds seen (for late registration). */
  #active = new Map<string, Set<MediaKind>>();
  /** live tracks per "streamId|kind", so a processor registered AFTER a stream
   *  went live can still subscribe to its RTP (not just onStreamStart). */
  #tracks = new Map<string, MediaStreamTrack>();

  constructor(bus: Bus, resolveDock: (streamId: string) => string) {
    this.#bus = bus;
    this.#resolveDock = resolveDock;
    // WS facts → channel items, fanned to interested processors.
    this.#bus.on(CLIENT_TOPIC, (m) => this.#onBusFact(m));
  }

  // ── registry (runtime add/remove — dynamic watchers) ───────────────────────

  register(p: StreamProcessor): () => void {
    const reg: Registered = { p, ctx: new Map() };
    this.#procs.push(reg);
    // Start it on any already-active streams it cares about.
    for (const [streamId, kinds] of this.#active) {
      if (!wantsSource(p, streamId)) continue;
      if (p.mediaKinds.length && ![...kinds].some((k) => p.mediaKinds.includes(k))) {
        // no matching media yet, but a fact-only processor still gets a ctx
        if (p.mediaKinds.length) continue;
      }
      this.#startOn(reg, streamId);
      // Subscribe a LATE processor to each live track it wants — onTrack already
      // fired for this stream, so without this it would get onStreamStart but no
      // onRtp (it would never see any media).
      for (const kind of kinds) {
        if (reg.p.mediaKinds.includes(kind)) this.#subscribeRtp(reg, streamId, kind);
      }
    }
    return () => {
      const i = this.#procs.indexOf(reg);
      if (i >= 0) this.#procs.splice(i, 1);
      for (const streamId of reg.ctx.keys()) this.#safe(() => reg.p.onStreamEnd(streamId));
    };
  }

  // ── MediaTap (called by the SFU) ───────────────────────────────────────────

  onTrack(streamId: string, kind: MediaKind, track: MediaStreamTrack): void {
    const kinds = this.#active.get(streamId) ?? new Set<MediaKind>();
    kinds.add(kind);
    this.#active.set(streamId, kinds);
    this.#tracks.set(trackKey(streamId, kind), track); // for late registration

    for (const reg of this.#procs) {
      if (!wantsSource(reg.p, streamId)) continue;
      if (!reg.p.mediaKinds.includes(kind)) continue;
      this.#startOn(reg, streamId); // idempotent (ctx cached)
      this.#subscribeRtp(reg, streamId, kind);
    }
  }

  /** Wire one processor's onRtp to a live track. Safe to call once per
   *  (reg, stream, kind) — subscriptions self-gate on the processor still being
   *  registered + active on the stream, so a removed/late processor is correct. */
  #subscribeRtp(reg: Registered, streamId: string, kind: MediaKind): void {
    const track = this.#tracks.get(trackKey(streamId, kind));
    if (!track) return;
    track.onReceiveRtp.subscribe((rtp: RtpPacket) => {
      if (!this.#procs.includes(reg) || !reg.ctx.has(streamId)) return;
      this.#safe(() => reg.p.onRtp?.(streamId, kind, rtp));
    });
  }

  onProducerGone(streamId: string): void {
    const kinds = this.#active.get(streamId);
    this.#active.delete(streamId);
    if (kinds) for (const kind of kinds) this.#tracks.delete(trackKey(streamId, kind));
    for (const reg of this.#procs) {
      if (reg.ctx.delete(streamId)) this.#safe(() => reg.p.onStreamEnd(streamId));
    }
  }

  // ── WS facts → processors ──────────────────────────────────────────────────

  #onBusFact(m: BusMessage): void {
    if (m.source === 'station') return; // ignore our own emissions
    const channel = channelForBusMsg(m);
    if (!channel) return;
    const streamId = m.source;
    const item: ChannelItem = {
      channel, source: streamId, dockId: this.#resolveDock(streamId), ts: m.ts, payload: m.payload,
    };
    for (const reg of this.#procs) {
      if (!wantsSource(reg.p, streamId)) continue;
      if (!reg.p.channels.includes(channel)) continue;
      // a fact-only processor may not have started on this stream yet — start it.
      if (!reg.ctx.has(streamId) && reg.p.mediaKinds.length === 0) this.#startOn(reg, streamId);
      this.#safe(() => reg.p.onChannelItem?.(item));
    }
  }

  // ── internals ──────────────────────────────────────────────────────────────

  #startOn(reg: Registered, streamId: string): void {
    if (reg.ctx.has(streamId)) return;
    const dockId = this.#resolveDock(streamId);
    const ctx: StreamContext = {
      streamId,
      dockId,
      emit: (r) => this.#publishResult(makeResult({ ...r, streamId, dockId })),
      publish: (channel, payload) => {
        // a processor's output is itself a fact other processors can consume.
        const item: ChannelItem = { channel, source: streamId, dockId, ts: Date.now(), payload };
        for (const other of this.#procs) {
          if (other === reg) continue;
          if (!wantsSource(other.p, streamId) || !other.p.channels.includes(channel)) continue;
          this.#safe(() => other.p.onChannelItem?.(item));
        }
      },
    };
    reg.ctx.set(streamId, ctx);
    this.#safe(() => reg.p.onStreamStart(ctx));
  }

  #publishResult(r: PerceptionResult): void {
    // directed to the dock (its agent re-grounds) ...
    this.#bus.publish({ topic: 'perception', kind: r.kind, payload: r, source: 'station', to: r.dockId });
    // ... and an undirected copy for the state aggregator + console panel.
    this.#bus.publish({ topic: 'perception', kind: r.kind, payload: r, source: 'station' });
  }

  #safe(fn: () => void): void {
    try { fn(); } catch (err) { console.error('[perception/hub] processor threw', err); }
  }
}

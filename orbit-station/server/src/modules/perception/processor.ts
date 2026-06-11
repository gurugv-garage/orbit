/**
 * StreamProcessor — a stage that consumes a dock's streams (media + WS facts,
 * source-filtered) and emits PerceptionResults. The ProcessingHub ([hub.ts]) owns
 * the one MediaTap and the bus subscription, and fans both to processors here.
 *
 * Why media AND facts here (not in MediaTap): a processor that correlates audio +
 * video + on-device VAD + battery needs both transports keyed to the SAME source.
 * MediaTap stays a narrow RTP observer; the HUB fuses media + WS and delivers them
 * through this interface, pre-filtered by `sources`/`mediaKinds`/`channels`.
 *
 * The source contract: every item carries `{ source, dockId }`. The unifying key
 * is the dock's producer peer id — the SFU keys media by it (`streamId`) and the
 * bus stamps WS messages with it (`source`) — so one subscription correlates both.
 *
 * Windowing is NOT here: the substrate ships items; a processor that needs "the
 * last 3 s" keeps its own ring buffer and windows it however it likes (consumer-
 * side, by design).
 *
 * Every callback runs on the main event loop — keep them non-blocking (offload
 * decode/ML to a worker_thread or sidecar; see WorkerProcessor / SidecarProcessor).
 */

import type { MediaKind } from '../media/tap.js';
import type { RtpPacket } from 'werift';
import type { PerceptionResult } from './result.js';

/** A timestamped typed fact on a channel (WS-origin, or another processor's output). */
export interface ChannelItem {
  /** channel name, e.g. 'client.battery', 'client.vad', 'face.box'. */
  channel: string;
  /** producer peer id this item is about (the source filter key). */
  source: string;
  /** the dock this item is about. */
  dockId: string;
  /** station receive time (ms epoch). */
  ts: number;
  payload: unknown;
}

/** Per-stream context handed to a processor at onStreamStart. */
export interface StreamContext {
  /** the producer peer id (= the dock's appId). */
  streamId: string;
  /** the resolved dock name. */
  dockId: string;
  /** emit a typed result → hub → perception topic → dock + console. */
  emit(result: Omit<PerceptionResult, 'ts' | 'streamId' | 'dockId'> & { ts?: number }): void;
  /** publish a fact onto a channel for OTHER processors to consume (chaining). */
  publish(channel: string, payload: unknown): void;
}

export interface StreamProcessor {
  /** stable id, e.g. 'face-recognition'. */
  readonly id: string;
  /**
   * which sources (dock/component ids) this processor wants, or '*' for all.
   * The hub delivers only media + channel items whose source matches.
   */
  readonly sources: readonly string[] | '*';
  /** which media track kinds it wants (empty = no media). */
  readonly mediaKinds: readonly MediaKind[];
  /** which fact channels it wants (empty = no WS facts). */
  readonly channels: readonly string[];

  /** A matching producer's track appeared. ctx is valid until onStreamEnd. */
  onStreamStart(ctx: StreamContext): void;
  /** Raw inbound RTP for a wanted media kind. Non-blocking. */
  onRtp?(streamId: string, kind: MediaKind, rtp: RtpPacket): void;
  /** A matching WS/derived fact arrived (pre-filtered to sources+channels). */
  onChannelItem?(item: ChannelItem): void;
  /** The producer ended — flush/close per-stream state. */
  onStreamEnd(streamId: string): void;
}

/** Does this processor want items from `source`? */
export function wantsSource(p: StreamProcessor, source: string): boolean {
  return p.sources === '*' || p.sources.includes(source);
}

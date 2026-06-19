/**
 * MediaTap — the seam for **processing** a dock's live stream (STT, vision,
 * recording, …). This is the whole reason the SFU runs server-side instead of
 * peer-to-peer: every producer's media passes through here, so a processor can
 * observe it without the dock or browsers knowing.
 *
 * A tap receives the SFU's *inbound* RTP for one producer — the same packets the
 * SFU forwards to viewers — as `(streamId, kind, rtp)`. What you do with them is
 * the tap's business. Two shapes ship here; pick by where the processing runs:
 *
 *  ┌─ same box ──────────────────────────────────────────────────────────────┐
 *  │ InProcessTap: hands each RtpPacket to a JS callback in this process.      │
 *  │ Cheap, zero serialization. Use for light work, or to decode with werift's │
 *  │ `nonstandard` (dePacketizeRtpPackets / MediaRecorder) right here.         │
 *  │ ⚠ runs on the main event loop — keep it non-blocking; offload heavy work  │
 *  │   (decode + ML) to a worker_thread.                                        │
 *  └──────────────────────────────────────────────────────────────────────────┘
 *  ┌─ separate box ────────────────────────────────────────────────────────────┐
 *  │ ForwardingTap: serializes each packet and ships it over a socket (UDP/TCP/ │
 *  │ WS) to a processing **sidecar** (Python/Go/another Node). The sidecar      │
 *  │ depacketizes + decodes (e.g. feed RTP straight into ffmpeg / GStreamer)    │
 *  │ and runs STT/vision off this machine entirely. Keeps the station light.    │
 *  └────────────────────────────────────────────────────────────────────────────┘
 *
 * The SFU calls `onTrack(streamId, kind, track)` once per producer track; the tap
 * subscribes to `track.onReceiveRtp`. `onProducerGone(streamId)` lets it flush /
 * close per-stream resources (files, sidecar sessions).
 *
 * See docs/media-processing.md for the end-to-end picture + a sidecar example.
 */

import type { MediaStreamTrack, RtpPacket } from 'werift';

export type MediaKind = 'audio' | 'video';

/** A processor that observes producers' inbound media. */
export interface MediaTap {
  /** Called once per producer track. Subscribe to its RTP here. */
  onTrack(streamId: string, kind: MediaKind, track: MediaStreamTrack): void;
  /** A producer ended — release any per-stream state (files, sidecar sessions). */
  onProducerGone(streamId: string): void;
}

/**
 * Same-box tap: invoke a JS callback for each RTP packet. The callback gets the
 * raw `RtpPacket` (header + encoded payload — VP8 video / Opus audio). Decode
 * with werift's `nonstandard` helpers if you need samples/frames; otherwise the
 * encoded payload is enough for recording or forwarding.
 *
 * IMPORTANT: the callback runs on the main event loop. Do only light work here
 * (counters, buffering, handing a Buffer to a worker_thread). Never block.
 */
export class InProcessTap implements MediaTap {
  constructor(
    private readonly onRtp: (streamId: string, kind: MediaKind, rtp: RtpPacket) => void,
    private readonly onGone?: (streamId: string) => void,
  ) {}

  onTrack(streamId: string, kind: MediaKind, track: MediaStreamTrack): void {
    track.onReceiveRtp.subscribe((rtp) => {
      try { this.onRtp(streamId, kind, rtp); } catch { /* never let a processor kill the SFU */ }
    });
  }

  onProducerGone(streamId: string): void {
    this.onGone?.(streamId);
  }
}

/**
 * Separate-box tap: ship every RTP packet to a processing sidecar over a datagram
 * socket. The wire framing is intentionally trivial so a Python/Go/Node sidecar
 * can parse it in a few lines:
 *
 *   1 byte   kind        (0 = audio, 1 = video)
 *   1 byte   streamId len (L)
 *   L bytes  streamId    (utf-8)
 *   …rest    the serialized RTP packet (header + payload), as werift emits it
 *
 * The sidecar reassembles per-(streamId,kind) RTP streams and decodes them
 * (ffmpeg/GStreamer take RTP directly). UDP keeps the station non-blocking and
 * tolerates a slow consumer (drops, not back-pressure) — right for real-time media.
 *
 * Env: MEDIA_SINK="udp://127.0.0.1:5004" (host = the sidecar). See the sidecar
 * example in docs/media-processing.md.
 */
import { createSocket, type Socket } from 'node:dgram';

const KIND_BYTE: Record<MediaKind, number> = { audio: 0, video: 1 };

export class ForwardingTap implements MediaTap {
  #sock: Socket;
  #host: string;
  #port: number;

  /** @param sinkUrl e.g. "udp://127.0.0.1:5004" */
  constructor(sinkUrl: string) {
    const u = new URL(sinkUrl);
    if (u.protocol !== 'udp:') throw new Error(`ForwardingTap: only udp:// supported, got ${u.protocol}`);
    this.#host = u.hostname;
    this.#port = Number(u.port);
    this.#sock = createSocket('udp4');
    this.#sock.on('error', () => {/* sidecar down — drop; SFU keeps streaming */});
  }

  onTrack(streamId: string, kind: MediaKind, track: MediaStreamTrack): void {
    const idBuf = Buffer.from(streamId, 'utf-8');
    const prefix = Buffer.from([KIND_BYTE[kind], idBuf.length]);
    track.onReceiveRtp.subscribe((rtp) => {
      // rtp.serialize() gives the on-wire RTP bytes the sidecar can feed to ffmpeg.
      const packet = Buffer.concat([prefix, idBuf, rtp.serialize()]);
      this.#sock.send(packet, this.#port, this.#host, () => {/* fire-and-forget */});
    });
  }

  onProducerGone(_streamId: string): void {
    // UDP is connectionless; nothing per-stream to close. The sidecar times the
    // stream out on packet silence. (TCP/WS variant would close a session here.)
  }

  close(): void { this.#sock.close(); }
}

/**
 * Pick a tap from the environment (so deployment chooses, not code):
 *   MEDIA_SINK unset            → no processing (returns null)
 *   MEDIA_SINK="udp://host:port" → ForwardingTap to a sidecar (separate box)
 * For an in-process tap, construct InProcessTap directly in main.ts (it needs a
 * JS callback, which an env var can't carry).
 */
export function tapFromEnv(): MediaTap | null {
  const sink = process.env.MEDIA_SINK;
  if (!sink) return null;
  return new ForwardingTap(sink);
}

/**
 * FrameGrabber — turns a producer's live VP8 RTP into the latest decoded JPEG
 * frame, on demand. The processor hands it each RTP packet; the grabber relays
 * them to a local UDP port that ffmpeg reads (via a tiny SDP), and ffmpeg decodes
 * VP8 → a stream of JPEGs (~1 fps). The recognizer + enrollment read `latest()`.
 *
 * Why this shape: ffmpeg is the battle-tested VP8 decoder; werift only
 * depacketizes. Feeding ffmpeg real RTP over UDP (described by an SDP) is the
 * standard, robust way to decode a live WebRTC video stream server-side (see
 * docs/MEDIA-PROCESSING.md). We decimate to ~1 fps at the output so we decode at
 * recognition cadence, not video cadence.
 *
 * NOTE: the live RTP→ffmpeg decode is the one link not yet validated on real VP8
 * (needs a device stream); the recognizer + gallery are proven on real images.
 * The grabber is isolated so the decode is swappable without touching the
 * processor or recognizer. Each grabber uses its own UDP port (per stream).
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { createSocket, type Socket } from 'node:dgram';
import { writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RtpPacket } from 'werift';

let portSeq = 5004;

export class FrameGrabber {
  #ff?: ChildProcess;
  #sock?: Socket;
  #port: number;
  #sdpPath: string;
  #latest: Buffer | null = null;
  #buf: Buffer[] = [];
  #started = false;

  constructor() {
    this.#port = portSeq; portSeq += 2; // even ports for RTP
    this.#sdpPath = join(tmpdir(), `dock-vp8-${this.#port}.sdp`);
  }

  start(): void {
    if (this.#started) return;
    this.#started = true;
    const sdp = [
      'v=0', 'o=- 0 0 IN IP4 127.0.0.1', 's=dock', 'c=IN IP4 127.0.0.1', 't=0 0',
      `m=video ${this.#port} RTP/AVP 96`, 'a=rtpmap:96 VP8/90000',
    ].join('\n');
    writeFileSync(this.#sdpPath, sdp);

    this.#sock = createSocket('udp4');
    this.#ff = spawn('ffmpeg', [
      '-loglevel', 'warning',
      // VP8 size is carried IN the keyframe, not the SDP — at low/variable fps
      // ffmpeg was giving up ("unspecified size") before a keyframe arrived. Give
      // it a long analyze window + big probe so it waits for the first keyframe.
      '-analyzeduration', '10M', '-probesize', '20M',
      '-protocol_whitelist', 'file,udp,rtp',
      '-i', this.#sdpPath,
      '-r', '1', '-f', 'image2pipe', '-vcodec', 'mjpeg', 'pipe:1',
    ]);
    this.#ff.stderr?.on('data', (d) => console.log(`[grabber:ffmpeg] ${String(d).trim().slice(0, 200)}`));
    this.#ff.on('exit', (code, sig) => console.log(`[grabber:ffmpeg] exited code=${code} sig=${sig}`));
    this.#collect();
  }

  /** Relay one inbound RTP packet to ffmpeg's UDP port. Called per packet. */
  feed(rtp: RtpPacket): void {
    if (!this.#sock) return;
    const bytes = rtp.serialize();
    this.#sock.send(bytes, this.#port, '127.0.0.1');
  }

  /** Latest decoded JPEG frame, or null if none yet. */
  latest(): Buffer | null { return this.#latest; }

  stop(): void {
    this.#started = false;
    try { this.#ff?.kill('SIGKILL'); } catch { /* */ }
    try { this.#sock?.close(); } catch { /* */ }
    try { rmSync(this.#sdpPath, { force: true }); } catch { /* */ }
    this.#ff = undefined; this.#sock = undefined; this.#latest = null; this.#buf = [];
  }

  /** Split ffmpeg's mjpeg stdout into individual JPEG frames; keep the latest. */
  #collect(): void {
    this.#ff?.stdout?.on('data', (chunk: Buffer) => {
      this.#buf.push(chunk);
      const joined = Buffer.concat(this.#buf);
      const end = joined.lastIndexOf(Buffer.from([0xff, 0xd9]));      // EOI
      const start = end >= 0 ? joined.lastIndexOf(Buffer.from([0xff, 0xd8]), end) : -1; // SOI
      if (end > start && start >= 0) {
        this.#latest = joined.subarray(start, end + 2);
        this.#buf = [joined.subarray(end + 2)];
      }
      if (joined.length > 4_000_000) this.#buf = [joined.subarray(joined.length - 1_000_000)];
    });
  }
}

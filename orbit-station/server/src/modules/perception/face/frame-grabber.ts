/**
 * FrameGrabber — turns a producer's live VP8 RTP into the latest decoded JPEG,
 * on demand. The recognizer + enrollment read `latest()` (~1-2 fps).
 *
 * Why not "ffmpeg -i sdp" directly: ffmpeg's SDP/RTP demuxer needs the video
 * dimensions to open the stream, but VP8 carries size only inside a KEYFRAME — so
 * ffmpeg bailed with "Could not find codec parameters … unspecified size" before a
 * keyframe arrived, and recognition saw no frames. Instead we:
 *   1. group inbound RTP into frames (werift's depacketizer, pure JS, reliable),
 *   2. wrap each frame in an IVF container — which has an explicit width/height
 *      header ffmpeg reads instantly — starting from the first KEYFRAME,
 *   3. pipe the IVF stream to ffmpeg's stdin → it decodes VP8 → MJPEG on stdout.
 *
 * IVF size comes from the keyframe's VP8 uncompressed header, so ffmpeg never has
 * to guess. This is the robust path for live WebRTC VP8 server-side.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { dePacketizeRtpPackets } from 'werift';
import type { RtpPacket } from 'werift';

export class FrameGrabber {
  #ff?: ChildProcess;
  #latest: Buffer | null = null;
  #out: Buffer[] = [];
  #started = false;

  // RTP → frame assembly
  #pktBuf: RtpPacket[] = [];
  #curTs: number | null = null;
  // IVF state
  #wroteHeader = false;
  #width = 0;
  #height = 0;
  #seenKeyframe = false;

  start(): void {
    if (this.#started) return;
    this.#started = true;
    // Read IVF from stdin; decode VP8 → one MJPEG frame/sec on stdout.
    this.#ff = spawn('ffmpeg', [
      '-loglevel', 'error',
      '-f', 'ivf', '-i', 'pipe:0',
      '-r', '1', '-f', 'image2pipe', '-vcodec', 'mjpeg', 'pipe:1',
    ]);
    this.#ff.stdout?.on('data', (c: Buffer) => this.#collect(c));
    this.#ff.stderr?.on('data', () => {/* swallow */});
    this.#ff.on('exit', () => { this.#started = false; });
  }

  /** Feed one inbound RTP packet. We assemble frames on the timestamp boundary. */
  feed(rtp: RtpPacket): void {
    if (!this.#started || !this.#ff?.stdin?.writable) return;
    const ts = rtp.header.timestamp;
    if (this.#curTs === null) this.#curTs = ts;
    // a new timestamp = a new frame → flush the buffered packets as one frame.
    if (ts !== this.#curTs && this.#pktBuf.length) {
      this.#emitFrame(this.#pktBuf);
      this.#pktBuf = [];
      this.#curTs = ts;
    }
    this.#pktBuf.push(rtp);
    // also flush on the marker bit (last packet of a frame).
    if (rtp.header.marker && this.#pktBuf.length) {
      this.#emitFrame(this.#pktBuf);
      this.#pktBuf = [];
      this.#curTs = null;
    }
  }

  latest(): Buffer | null { return this.#latest; }

  stop(): void {
    this.#started = false;
    try { this.#ff?.stdin?.end(); } catch { /* */ }
    try { this.#ff?.kill('SIGKILL'); } catch { /* */ }
    this.#ff = undefined; this.#latest = null;
    this.#out = []; this.#pktBuf = []; this.#curTs = null;
    this.#wroteHeader = false; this.#seenKeyframe = false;
  }

  // ── frame assembly → IVF → ffmpeg ──────────────────────────────────────────

  #emitFrame(packets: RtpPacket[]): void {
    let frame;
    try { frame = dePacketizeRtpPackets('VP8', packets); } catch { return; }
    if (!frame?.data?.length) return;
    const data = frame.data;

    // Wait for the first keyframe so we can size the IVF header from it.
    if (!this.#seenKeyframe) {
      if (!frame.isKeyframe) return;
      const dims = vp8KeyframeSize(data);
      if (!dims) return;
      this.#width = dims.w; this.#height = dims.h;
      this.#seenKeyframe = true;
    }
    if (!this.#wroteHeader) {
      this.#write(ivfHeader(this.#width, this.#height));
      this.#wroteHeader = true;
    }
    this.#write(ivfFrameHeader(data.length));
    this.#write(data);
  }

  #write(b: Buffer): void {
    try { this.#ff?.stdin?.write(b); } catch { /* */ }
  }

  /** Split ffmpeg's MJPEG stdout into JPEGs; keep the latest complete one. */
  #collect(chunk: Buffer): void {
    this.#out.push(chunk);
    const joined = Buffer.concat(this.#out);
    const end = joined.lastIndexOf(Buffer.from([0xff, 0xd9]));       // EOI
    const start = end >= 0 ? joined.lastIndexOf(Buffer.from([0xff, 0xd8]), end) : -1; // SOI
    if (end > start && start >= 0) {
      this.#latest = joined.subarray(start, end + 2);
      this.#out = [joined.subarray(end + 2)];
    }
    if (joined.length > 4_000_000) this.#out = [joined.subarray(joined.length - 1_000_000)];
  }
}

/** Parse width/height from a VP8 keyframe's uncompressed data chunk. */
function vp8KeyframeSize(buf: Buffer): { w: number; h: number } | null {
  // VP8 keyframe: 3-byte frame tag, then start code 0x9d 0x01 0x2a, then 2+2 bytes
  // of (width|hscale) (height|vscale), 14-bit dims little-endian.
  if (buf.length < 10) return null;
  if (buf[3] !== 0x9d || buf[4] !== 0x01 || buf[5] !== 0x2a) return null;
  const w = (buf.readUInt16LE(6) & 0x3fff);
  const h = (buf.readUInt16LE(8) & 0x3fff);
  return w && h ? { w, h } : null;
}

/** 32-byte IVF file header for a VP8 stream of w×h. */
function ivfHeader(w: number, h: number): Buffer {
  const b = Buffer.alloc(32);
  b.write('DKIF', 0, 'ascii');
  b.writeUInt16LE(0, 4);          // version
  b.writeUInt16LE(32, 6);         // header length
  b.write('VP80', 8, 'ascii');    // codec FourCC
  b.writeUInt16LE(w, 12);
  b.writeUInt16LE(h, 14);
  b.writeUInt32LE(30, 16);        // timebase denom (fps numerator) — nominal
  b.writeUInt32LE(1, 20);         // timebase num
  b.writeUInt32LE(0, 24);         // frame count (0 = unknown/stream)
  b.writeUInt32LE(0, 28);         // unused
  return b;
}

let ivfFrameIndex = 0;
/** 12-byte IVF frame header (size + monotonic timestamp). */
function ivfFrameHeader(size: number): Buffer {
  const b = Buffer.alloc(12);
  b.writeUInt32LE(size, 0);
  b.writeUInt32LE(ivfFrameIndex++, 4); // 64-bit ts; low word is enough at our rate
  b.writeUInt32LE(0, 8);
  return b;
}

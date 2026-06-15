/**
 * IVF → VP8 RTP — feed a committed video file into the REAL media pipeline for
 * tests, mocking nothing internal. An `.ivf` is a raw VP8 elementary stream with a
 * tiny container header; we parse its frames and packetize each as one VP8 RTP
 * packet (small test frames fit in one MTU), which the station's FrameGrabber
 * depacketizes + ffmpeg-decodes exactly as it does a live dock stream.
 *
 * Used by media-task.test.ts (and usable to drive the SFU like fake-dock-media).
 * The IVF spec: 32-byte file header, then per-frame [4-byte size | 8-byte ts | data].
 */
import { readFileSync } from 'node:fs';
import { RtpPacket, RtpHeader } from 'werift';

/** Parse the VP8 frames out of an .ivf file. */
export function ivfFrames(path: string): Buffer[] {
  const buf = readFileSync(path);
  const frames: Buffer[] = [];
  let off = 32; // skip the IVF file header
  while (off + 12 <= buf.length) {
    const size = buf.readUInt32LE(off);
    frames.push(buf.subarray(off + 12, off + 12 + size));
    off += 12 + size;
  }
  return frames;
}

/** One VP8 RTP packet for a whole frame: a 1-byte VP8 payload descriptor (S bit
 *  set = start of partition) + the frame data. Fine for small test frames. */
export function vp8Packet(frame: Buffer, seq: number, ts: number, ssrc = 1234): RtpPacket {
  const payload = Buffer.concat([Buffer.from([0x10]), frame]);
  const header = new RtpHeader({ payloadType: 96, sequenceNumber: seq & 0xffff, timestamp: ts >>> 0, ssrc, marker: true });
  return new RtpPacket(header, payload);
}

/**
 * Packetize an .ivf into a sequence of VP8 RTP packets, one per frame, with the
 * RTP timestamp advancing each frame (the grabber flushes a frame when the
 * timestamp changes). Includes a trailing flush packet so the LAST frame emits.
 */
export function ivfToRtp(path: string, tsStep = 3000): RtpPacket[] {
  const frames = ivfFrames(path);
  const out: RtpPacket[] = [];
  let seq = 0, ts = 0;
  for (const f of frames) { out.push(vp8Packet(f, seq++, ts)); ts += tsStep; }
  out.push(vp8Packet(Buffer.alloc(1), seq++, ts)); // flush the last frame
  return out;
}

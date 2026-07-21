/**
 * FrameGrabber — turns a producer's live VP8 RTP into the latest decoded JPEG,
 * on demand. The recognizer + enrollment read `latest()` (~1-2 fps). It also keeps
 * a short rolling WINDOW of recent frames (RING_WINDOW_MS) so `frameAt(t)` can serve
 * "the frame the camera was showing at moment t" — the seam behind the brain's
 * time-parameterized capture (docs/decision-traces/thin-client-consolidation.md).
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

/** A decoded frame older than this is considered stale (camera paused/covered). */
const FRAME_FRESH_MS = 1500;

/** How long a rolling window of recent frames to retain, so the brain can ask about a
 *  MOMENT ("what did I see when I heard the doorbell") instead of only "now". At ~1-2 fps
 *  and ~50 KB/frame this is ~5-6 MB per stream at the ceiling — cheap for one live dock. */
const RING_WINDOW_MS = 60_000;
/** Hard cap on retained frames, so a burst can't blow memory even if fps spikes. */
const RING_MAX_FRAMES = 240;

/** One decoded frame + when it was produced (ms epoch, station clock). */
export interface StampedFrame { jpeg: Buffer; at: number }

export class FrameGrabber {
  #ff?: ChildProcess;
  #latest: Buffer | null = null;
  #latestAt = 0; // when #latest was produced (ms epoch)
  // Rolling window of recent frames, oldest→newest (the newest is also #latest).
  // Enables frameAt(t): "the frame the camera was showing at time t".
  #ring: StampedFrame[] = [];
  #out: Buffer[] = [];
  #started = false;

  // RTP → frame assembly
  #pktBuf: RtpPacket[] = [];
  #curTs: number | null = null;
  // IVF state
  #wroteHeader = false;
  #width = 0;
  #height = 0;
  #frameIndex = 0;

  start(): void {
    if (this.#started) return;
    this.#started = true;
    // Read IVF from stdin; decode VP8 → one MJPEG per DECODED frame on stdout.
    // NOT `-r 1`: that rate-limits against the IVF timestamp clock (1/30s per
    // frame), but the dock feeds ~1-2 REAL fps — so ffmpeg emitted one JPEG per
    // ~30 input frames ≈ every 20+ wall seconds, and `latest()`'s freshness
    // window (1.5 s) almost never caught one. That starved every stream-frame
    // consumer (recollect fallback, the /frame debug route, the brain's vision
    // grab). Passthrough = a JPEG per decoded frame, at the real input rate.
    this.#ff = spawn('ffmpeg', [
      '-loglevel', 'error',
      '-f', 'ivf', '-i', 'pipe:0',
      // -q:v 2 = near-lossless MJPEG (scale is 2..31, lower=better; default ~3-4
      // softens the VP8→JPEG re-encode). The frame served to the brain's vision
      // grab, the /frame route, and the console Live Wall is only as sharp as this
      // pass; 2 stops the station from adding a second softening on top of VP8.
      // Cost is a few KB larger JPEGs, served on-demand over LAN — negligible.
      '-fps_mode', 'passthrough', '-f', 'image2pipe', '-vcodec', 'mjpeg', '-q:v', '2', 'pipe:1',
    ]);
    this.#ff.stdout?.on('data', (c: Buffer) => this.#collect(c));
    this.#ff.stderr?.on('data', () => {/* swallow */});
    this.#ff.on('exit', () => { this.#started = false; });
  }

  /**
   * Feed one inbound RTP packet. We collect all packets of one frame (same RTP
   * timestamp) and emit the assembled frame when the timestamp advances. We do
   * NOT also flush on the marker bit — a frame can span packets after the marker
   * in some senders, and double-flushing split frames, producing the corrupted
   * (smeared) images. One frame = one contiguous run of equal timestamps.
   */
  feed(rtp: RtpPacket): void {
    if (!this.#started || !this.#ff?.stdin?.writable) return;
    const ts = rtp.header.timestamp;
    if (this.#curTs === null) this.#curTs = ts;
    if (ts !== this.#curTs) {
      // timestamp advanced → the previous frame is complete.
      if (this.#pktBuf.length) this.#emitFrame(this.#pktBuf);
      this.#pktBuf = [];
      this.#curTs = ts;
    }
    this.#pktBuf.push(rtp);
  }

  /**
   * The latest decoded JPEG, or null if it's STALE. When the camera is covered or
   * the dock pauses sending frames, ffmpeg stops emitting new JPEGs and #latest
   * would otherwise return an old frame (with a face that's no longer there) —
   * which made recollect_face say "I see guru" while covered. We only return a
   * frame produced within FRAME_FRESH_MS.
   */
  latest(): Buffer | null {
    if (!this.#latest || Date.now() - this.#latestAt > FRAME_FRESH_MS) return null;
    return this.#latest;
  }

  /** The latest frame only if it was decoded AT/AFTER `minTs` (and fresh).
   *  The visual-search sweep must judge a frame captured after its motion
   *  settled — a frame from 1.2s ago is a mid-move smear, and `latest()`
   *  would happily serve it. Callers poll this until a post-settle frame
   *  lands (one arrives within ~100ms on a live stream). */
  latestSince(minTs: number): Buffer | null {
    if (!this.#latest || this.#latestAt < minTs) return null;
    if (Date.now() - this.#latestAt > FRAME_FRESH_MS) return null;
    return this.#latest;
  }

  /**
   * The frame the camera was showing AT `tMs` (station-clock epoch) — the newest
   * retained frame with `at <= tMs`. This is the "look back to a moment" accessor:
   * a salient event (a sound, a spoken line, a visual change) is stamped on the same
   * Date.now() clock, so `frameAt(event.ts)` returns what was on camera then.
   *
   * Returns null when `t` predates the whole window (frame already evicted) or no
   * frame at/before `t` exists yet. `toleranceMs` allows a `t` slightly AFTER the
   * last frame to still resolve to that last frame (frames arrive ~1 Hz, so a `t`
   * stamped between two frames should snap to the one just before it) — default one
   * frame-interval's worth of slack.
   */
  frameAt(tMs: number, toleranceMs = 1500): Buffer | null {
    return frameAtIn(this.#ring, tMs, toleranceMs);
  }

  /** Diagnostics: the time span currently retained in the ring (empty → nulls). */
  ringSpan(): { count: number; oldestAt: number | null; newestAt: number | null } {
    if (!this.#ring.length) return { count: 0, oldestAt: null, newestAt: null };
    return { count: this.#ring.length, oldestAt: this.#ring[0]!.at, newestAt: this.#ring[this.#ring.length - 1]!.at };
  }

  stop(): void {
    this.#started = false;
    try { this.#ff?.stdin?.end(); } catch { /* */ }
    try { this.#ff?.kill('SIGKILL'); } catch { /* */ }
    this.#ff = undefined; this.#latest = null;
    this.#ring = [];
    this.#out = []; this.#pktBuf = []; this.#curTs = null;
    this.#wroteHeader = false;
  }

  // ── frame assembly → IVF → ffmpeg ──────────────────────────────────────────

  #emitFrame(packets: RtpPacket[]): void {
    let frame;
    try { frame = dePacketizeRtpPackets('VP8', packets); } catch { return; }
    if (!frame?.data?.length) return;
    const data = frame.data;
    // We must START from a keyframe (for the IVF size + a decodable reference).
    // After that we pass P-frames too — keyframes alone are too rare (the dock
    // only sends one at connect), so keyframe-only starved recognition. With the
    // packet-assembly fixed (group by timestamp, no marker double-flush), the
    // frames decode cleanly. Drop P-frames only until the first keyframe lands.
    if (!this.#wroteHeader) {
      if (!frame.isKeyframe) return;
      const dims = vp8KeyframeSize(data);
      if (!dims) return;
      this.#width = dims.w; this.#height = dims.h;
      this.#write(ivfHeader(this.#width, this.#height));
      this.#wroteHeader = true;
    }
    this.#write(ivfFrameHeader(data.length, this.#frameIndex++));
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
      const jpeg = joined.subarray(start, end + 2);
      const at = Date.now();
      this.#latest = jpeg;
      this.#latestAt = at;
      // Push into the rolling window (evict by age + hard count cap). The newest frame is
      // always #latest, so every existing latest()/latestSince() caller is unaffected — the
      // ring is purely additive. (pure helper so the window logic is unit-testable.)
      pushToRing(this.#ring, { jpeg, at }, RING_WINDOW_MS, RING_MAX_FRAMES);
      this.#out = [joined.subarray(end + 2)];
    }
    if (joined.length > 4_000_000) this.#out = [joined.subarray(joined.length - 1_000_000)];
  }
}

/** Push `frame` (newest) into an oldest→newest ring, evicting anything older than
 *  `windowMs` before the newest frame, and capping the count at `maxFrames`. Pure so
 *  the window/eviction policy is unit-testable without ffmpeg. Mutates `ring` in place. */
export function pushToRing(ring: StampedFrame[], frame: StampedFrame, windowMs: number, maxFrames: number): void {
  ring.push(frame);
  const cutoff = frame.at - windowMs;
  while (ring.length && (ring[0]!.at < cutoff || ring.length > maxFrames)) ring.shift();
}

/** The newest frame in `ring` with `at <= tMs + toleranceMs` (oldest→newest ring).
 *  null when `t` predates every retained frame. Pure; see FrameGrabber.frameAt. */
export function frameAtIn(ring: StampedFrame[], tMs: number, toleranceMs: number): Buffer | null {
  for (let i = ring.length - 1; i >= 0; i--) {
    const f = ring[i]!;
    if (f.at <= tMs + toleranceMs) return f.jpeg;
  }
  return null;
}

/** Parse width/height from a VP8 keyframe's uncompressed data chunk. */
export function vp8KeyframeSize(buf: Buffer): { w: number; h: number } | null {
  // VP8 keyframe: 3-byte frame tag, then start code 0x9d 0x01 0x2a, then 2+2 bytes
  // of (width|hscale) (height|vscale), 14-bit dims little-endian.
  if (buf.length < 10) return null;
  if (buf[3] !== 0x9d || buf[4] !== 0x01 || buf[5] !== 0x2a) return null;
  const w = (buf.readUInt16LE(6) & 0x3fff);
  const h = (buf.readUInt16LE(8) & 0x3fff);
  return w && h ? { w, h } : null;
}

/** 32-byte IVF file header for a VP8 stream of w×h. */
export function ivfHeader(w: number, h: number): Buffer {
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

/** 12-byte IVF frame header (size + monotonic timestamp). */
export function ivfFrameHeader(size: number, index: number): Buffer {
  const b = Buffer.alloc(12);
  b.writeUInt32LE(size, 0);
  b.writeUInt32LE(index, 4); // 64-bit ts; low word is enough at our rate
  b.writeUInt32LE(0, 8);
  return b;
}

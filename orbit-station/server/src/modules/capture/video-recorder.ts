/**
 * VideoClipRecorder — open-ended (start/stop) version of the fixed-duration
 * [perception/record/recorder.ts], for the capture-judging harness. Same RTP(VP8)
 * → IVF → ffmpeg → WebM stream-copy pipeline, but the caller controls start/stop
 * (a station-driven "record this dock now" session) instead of a fixed `seconds`.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { dePacketizeRtpPackets, type RtpPacket } from 'werift';
import type { MediaKind } from '../media/tap.js';
import type { ProcessingHub } from '../perception/hub.js';
import type { StreamContext, StreamProcessor } from '../perception/processor.js';
import { ivfFrameHeader, ivfHeader, vp8KeyframeSize } from '../perception/face/frame-grabber.js';

export interface VideoRecordHandle {
  stop(): Promise<{ path: string }>;
  startedAt(): number;
}

/** Start recording `streamId`'s video to `outPath` (.webm). */
export function startVideoRecording(
  hub: ProcessingHub,
  streamId: string,
  outPath: string,
): VideoRecordHandle {
  let started = 0;
  let unregister: (() => void) | undefined;
  const writer = new ClipWriter(outPath);

  const proc: StreamProcessor = {
    id: `capture-video:${streamId}:${Date.now()}`,
    sources: [streamId],
    mediaKinds: ['video'] as readonly MediaKind[],
    channels: [],
    onStreamStart(_ctx: StreamContext) { started = Date.now(); writer.start(); },
    onRtp(_id: string, _kind: MediaKind, rtp: RtpPacket) { writer.feed(rtp); },
    onStreamEnd() { /* handled by stop() */ },
  };
  unregister = hub.register(proc);

  return {
    startedAt: () => started,
    async stop(): Promise<{ path: string }> {
      unregister?.();
      await writer.finalize();
      return { path: outPath };
    },
  };
}

/** RTP(VP8) → IVF → ffmpeg → WebM (stream-copy). Mirrors record/recorder.ts. */
class ClipWriter {
  #ff?: ChildProcess;
  #started = false;
  #ffExit?: Promise<void>;
  #pktBuf: RtpPacket[] = [];
  #curTs: number | null = null;
  #wroteHeader = false;
  #frameIndex = 0;
  #firstFrameMs = 0;   // wall-clock of the first written frame (IVF time origin)
  #lastTick = -1;      // last IVF timestamp written (monotonic guard)

  constructor(private readonly outPath: string) {}

  start(): void {
    if (this.#started) return;
    this.#started = true;
    this.#ff = spawn('ffmpeg', [
      '-loglevel', 'error', '-y',
      '-f', 'ivf', '-i', 'pipe:0',
      '-c:v', 'copy', '-f', 'webm', this.outPath,
    ]);
    this.#ff.stderr?.on('data', () => {/* swallow */});
    this.#ffExit = new Promise<void>((res) => { this.#ff?.on('exit', () => res()); });
  }

  feed(rtp: RtpPacket): void {
    if (!this.#started || !this.#ff?.stdin?.writable) return;
    const ts = rtp.header.timestamp;
    if (this.#curTs === null) this.#curTs = ts;
    if (ts !== this.#curTs) {
      if (this.#pktBuf.length) this.#emitFrame(this.#pktBuf);
      this.#pktBuf = []; this.#curTs = ts;
    }
    this.#pktBuf.push(rtp);
  }

  #emitFrame(packets: RtpPacket[]): void {
    let frame;
    try { frame = dePacketizeRtpPackets('VP8', packets); } catch { return; }
    if (!frame?.data?.length) return;
    const data = frame.data;
    if (!this.#wroteHeader) {
      if (!frame.isKeyframe) return;
      const dims = vp8KeyframeSize(data);
      if (!dims) return;
      this.#write(ivfHeader(dims.w, dims.h));
      this.#wroteHeader = true;
      this.#firstFrameMs = Date.now();
    }
    // IVF timebase is 30/1 (frame-grabber.ts), so 1 tick = 1/30 s. Stamp each frame
    // at its REAL elapsed wall-clock time (not a frame index) — the dock's video
    // arrives at a low, variable rate; an index would imply 30fps and collapse a
    // 10 s clip to ~0.3 s. Wall-clock ticks give ffmpeg the true duration.
    const tick = Math.round(((Date.now() - this.#firstFrameMs) / 1000) * 30);
    this.#write(ivfFrameHeader(data.length, Math.max(tick, this.#lastTick + 1)));
    this.#lastTick = Math.max(tick, this.#lastTick + 1);
    this.#frameIndex++;
    this.#write(data);
  }

  #write(b: Buffer): void { try { this.#ff?.stdin?.write(b); } catch { /* */ } }

  async finalize(): Promise<void> {
    if (this.#pktBuf.length) this.#emitFrame(this.#pktBuf);
    this.#pktBuf = [];
    try { this.#ff?.stdin?.end(); } catch { /* */ }
    await this.#ffExit;
  }
}

/**
 * VideoRecorderApi — record a dock's LIVE camera stream to a WebM clip for N
 * seconds. The `record_video` brain tool kicks this off and returns immediately;
 * a watcher (the caller) awaits the returned promise and, when the clip lands,
 * uploads it / notifies (so the turn never blocks for the whole recording).
 *
 * It reuses the perception substrate: a one-shot StreamProcessor registered on
 * the PerceptionProcessingHub for ONE streamId, fed the same inbound VP8 RTP the face
 * recognizer gets. We assemble RTP → IVF (the FrameGrabber trick — IVF carries
 * explicit dims so ffmpeg opens the stream without a keyframe wait) and pipe IVF
 * into ffmpeg, which STREAM-COPIES VP8 into a WebM container (no re-encode →
 * cheap, fast). After `seconds` we stop, unregister, and resolve the file path.
 *
 * Audio is intentionally NOT muxed in v1: the dock's audio is a separate Opus
 * track and aligning it adds complexity; a video-only clip is the useful case
 * ("show me what you saw"). Adding audio later = a second ffmpeg input.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { dePacketizeRtpPackets, type RtpPacket } from 'werift';
import type { MediaKind } from '../../media/tap.js';
import type { PerceptionProcessingHub } from '../perception-processing-hub.js';
import type { StreamContext, StreamProcessor } from '../processor.js';
import { ivfFrameHeader, ivfHeader, vp8KeyframeSize } from '../face/frame-grabber.js';

/** Hard ceiling so a bad `seconds` can never tie up a stream/ffmpeg forever. */
export const MAX_RECORD_SECONDS = 30;
/** If the stream never goes live (dock not actually streaming), give up. */
const STREAM_WAIT_MS = 5_000;

export interface RecordResult {
  /** absolute path to the written .webm. */
  path: string;
  /** the dock the clip is for. */
  dockId: string;
}

export interface VideoRecorderApi {
  /**
   * Record `streamId` for `seconds` (capped to {@link MAX_RECORD_SECONDS}).
   * Resolves with the clip path once written; rejects if the stream never
   * produces video or ffmpeg fails.
   */
  record(streamId: string, seconds: number): Promise<RecordResult>;
}

/** Build the recorder API. `recordingsDir` is created on first use. */
export function buildVideoRecorder(hub: PerceptionProcessingHub, recordingsDir: string): VideoRecorderApi {
  return {
    async record(streamId: string, seconds: number): Promise<RecordResult> {
      const secs = Math.max(1, Math.min(MAX_RECORD_SECONDS, Math.floor(seconds || 0)));
      await mkdir(recordingsDir, { recursive: true });
      const outPath = join(recordingsDir, `${sanitize(streamId)}-${Date.now()}.webm`);

      return await new Promise<RecordResult>((resolve, reject) => {
        const clip = new ClipWriter(outPath);
        let unregister: (() => void) | undefined;
        let startTimer: ReturnType<typeof setTimeout> | undefined;
        let stopTimer: ReturnType<typeof setTimeout> | undefined;
        let settled = false;

        const finish = (err?: Error) => {
          if (settled) return;
          settled = true;
          if (startTimer) clearTimeout(startTimer);
          if (stopTimer) clearTimeout(stopTimer);
          unregister?.();
          if (err) { clip.abort(); reject(err); return; }
          clip.finalize()
            .then((dockId) => resolve({ path: outPath, dockId }))
            .catch(reject);
        };

        const proc: StreamProcessor = {
          id: `clip-recorder:${streamId}:${Date.now()}`,
          sources: [streamId],
          mediaKinds: ['video'] as readonly MediaKind[],
          channels: [],
          onStreamStart(ctx: StreamContext) {
            clip.bindDock(ctx.dockId);
            if (startTimer) { clearTimeout(startTimer); startTimer = undefined; }
            clip.start();
            // record for `secs` from the moment media actually starts flowing.
            stopTimer = setTimeout(() => finish(), secs * 1000);
          },
          onRtp(_id: string, _kind: MediaKind, rtp: RtpPacket) {
            clip.feed(rtp);
          },
          onStreamEnd() {
            // producer vanished mid-clip — finalize whatever we have.
            finish();
          },
        };

        unregister = hub.register(proc);
        // If the hub didn't immediately start us on an already-live stream, the
        // dock isn't streaming video — fail rather than hang.
        startTimer = setTimeout(
          () => finish(new Error(`dock stream "${streamId}" is not producing video`)),
          STREAM_WAIT_MS,
        );
      });
    },
  };
}

/** keep streamIds filesystem-safe in the output name. */
function sanitize(s: string): string {
  return s.replace(/[^a-zA-Z0-9._-]/g, '_');
}

/**
 * Assembles inbound VP8 RTP into an IVF stream piped to ffmpeg, which stream-
 * copies it into a WebM file. Mirrors FrameGrabber's RTP→IVF assembly, but the
 * sink is a container mux (no decode), so it's light.
 */
class ClipWriter {
  #ff?: ChildProcess;
  #dockId = 'unknown';
  #started = false;
  #ffExit?: Promise<void>;

  // RTP → frame assembly (group by timestamp; flush on advance).
  #pktBuf: RtpPacket[] = [];
  #curTs: number | null = null;
  // IVF state
  #wroteHeader = false;
  #frameIndex = 0;

  constructor(private readonly outPath: string) {}

  bindDock(dockId: string): void { this.#dockId = dockId; }

  start(): void {
    if (this.#started) return;
    this.#started = true;
    // IVF (VP8) in → WebM out, copying the video stream (no re-encode).
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
      this.#pktBuf = [];
      this.#curTs = ts;
    }
    this.#pktBuf.push(rtp);
  }

  #emitFrame(packets: RtpPacket[]): void {
    let frame;
    try { frame = dePacketizeRtpPackets('VP8', packets); } catch { return; }
    if (!frame?.data?.length) return;
    const data = frame.data;
    if (!this.#wroteHeader) {
      // start from a keyframe — the IVF size + first decodable reference.
      if (!frame.isKeyframe) return;
      const dims = vp8KeyframeSize(data);
      if (!dims) return;
      this.#write(ivfHeader(dims.w, dims.h));
      this.#wroteHeader = true;
    }
    this.#write(ivfFrameHeader(data.length, this.#frameIndex++));
    this.#write(data);
  }

  #write(b: Buffer): void {
    try { this.#ff?.stdin?.write(b); } catch { /* */ }
  }

  /** Close ffmpeg's stdin and wait for it to flush the WebM; returns the dockId. */
  async finalize(): Promise<string> {
    if (this.#pktBuf.length) this.#emitFrame(this.#pktBuf);
    this.#pktBuf = [];
    try { this.#ff?.stdin?.end(); } catch { /* */ }
    await this.#ffExit; // ffmpeg writes the WebM index on clean stdin close
    return this.#dockId;
  }

  /** Kill ffmpeg without waiting (error path). */
  abort(): void {
    try { this.#ff?.stdin?.end(); } catch { /* */ }
    try { this.#ff?.kill('SIGKILL'); } catch { /* */ }
  }
}

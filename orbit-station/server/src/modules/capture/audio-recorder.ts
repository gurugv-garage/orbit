/**
 * AudioClipRecorder — record a dock's live WebRTC Opus audio to a WAV file, for the
 * capture-judging harness. The video recorder ([record/recorder.ts]) handles VP8 →
 * WebM; this is its audio sibling so a recorded capture session has BOTH tracks (you
 * can't judge STT accuracy without the audio).
 *
 * Reuses the perception substrate: a one-shot StreamProcessor on the PerceptionProcessingHub
 * for ONE streamId, fed the same inbound Opus RTP the STT watcher gets. Each Opus
 * packet → 48 kHz mono PCM-16 (same decode as speech-watch (vad-endpoint)), appended to a buffer; on
 * stop we prepend a WAV header and write the file. 48 kHz mono keeps it aligned with
 * WebRTC's native Opus rate (no resample) and plays natively in the browser.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { dePacketizeRtpPackets, type RtpPacket } from 'werift';
import OpusScript from 'opusscript';
import type { MediaKind } from '../media/tap.js';
import type { PerceptionProcessingHub } from '../perception/perception-processing-hub.js';
import type { StreamContext, StreamProcessor } from '../perception/processor.js';

const OPUS_RATE = 48_000; // WebRTC Opus is 48 kHz mono

export interface AudioRecordHandle {
  /** stop recording now and write the WAV; resolves with the file path. */
  stop(): Promise<{ path: string }>;
  /** epoch ms when audio actually started flowing (0 until then). */
  startedAt(): number;
}

/** Start recording `streamId`'s audio to `outPath` (.wav). Returns a handle to stop.
 *  Rejects via the stop() promise if no audio ever flowed. */
export function startAudioRecording(
  hub: PerceptionProcessingHub,
  streamId: string,
  outPath: string,
): AudioRecordHandle {
  const dec = new OpusScript(OPUS_RATE, 1, OpusScript.Application.AUDIO);
  const chunks: Int16Array[] = [];
  let started = 0;
  let unregister: (() => void) | undefined;

  const proc: StreamProcessor = {
    id: `audio-recorder:${streamId}:${Date.now()}`,
    sources: [streamId],
    mediaKinds: ['audio'] as readonly MediaKind[],
    channels: [],
    onStreamStart(_ctx: StreamContext) { started = Date.now(); },
    onRtp(_id: string, _kind: MediaKind, rtp: RtpPacket) {
      try {
        const frame = dePacketizeRtpPackets('opus', [rtp]);
        const data = frame?.data;
        if (!data?.length) return;
        const decoded = dec.decode(data);
        // decoded is a Buffer of PCM-16 @ 48 kHz mono; copy into our buffer.
        chunks.push(new Int16Array(new Int16Array(decoded.buffer, decoded.byteOffset,
          Math.floor(decoded.length / 2))));
      } catch { /* a bad packet → skip */ }
    },
    onStreamEnd() { /* handled by stop() */ },
  };
  unregister = hub.register(proc);

  return {
    startedAt: () => started,
    async stop(): Promise<{ path: string }> {
      unregister?.();
      try { dec.delete?.(); } catch { /* */ }
      const total = chunks.reduce((n, c) => n + c.length, 0);
      const pcm = new Int16Array(total);
      let o = 0; for (const c of chunks) { pcm.set(c, o); o += c.length; }
      await writeWav(outPath, pcm, OPUS_RATE);
      return { path: outPath };
    },
  };
}

/** Write mono PCM-16 to a .wav (44-byte header + samples). */
async function writeWav(path: string, pcm: Int16Array, rate: number): Promise<void> {
  const dataBytes = pcm.length * 2;
  const buf = Buffer.alloc(44 + dataBytes);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + dataBytes, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22);              // mono
  buf.writeUInt32LE(rate, 24);           // sample rate
  buf.writeUInt32LE(rate * 2, 28);       // byte rate (mono, 2 bytes/sample)
  buf.writeUInt16LE(2, 32);              // block align
  buf.writeUInt16LE(16, 34);             // bits/sample
  buf.write('data', 36); buf.writeUInt32LE(dataBytes, 40);
  for (let i = 0; i < pcm.length; i++) buf.writeInt16LE(pcm[i]!, 44 + i * 2);
  await mkdir(join(path, '..'), { recursive: true }).catch(() => {});
  await writeFile(path, buf);
}

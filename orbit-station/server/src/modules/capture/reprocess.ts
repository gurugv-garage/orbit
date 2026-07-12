/**
 * reprocess — re-run STT over a recorded capture's audio with a chosen model +
 * optional context prompt, producing a new RESULT RUN to compare against the live
 * run (and other models). Whole-file transcription: the model does its OWN
 * segmentation over the same audio, which is the cleanest A/B when comparing models.
 *
 * The segments come back with timing relative to the recording start; we shape them
 * into snapshot-like records (same shape the console timeline already renders) and
 * tier each one (good/shaky/garbage) with the same confidence logic as the live path.
 */

import { readFile } from 'node:fs/promises';
import { isoIst } from '../perception/snapshots.js';
import { confidenceTier } from '../perception/processors/speech-watch.js';
import { isOnlineEngine, transcribeOnline, type EnrichContext } from './online-stt.js';

const SIDECAR_URL = process.env.PERCEPTION_SIDECAR_URL ?? 'http://127.0.0.1:8078';

interface SidecarSegment {
  start: number; end: number; text: string;
  avg_logprob: number | null; no_speech_prob: number | null; compression_ratio: number | null;
}

/** Decode a 16-bit PCM WAV → Int16Array + sample rate (44-byte header). */
async function readWav(path: string): Promise<{ pcm: Int16Array; rate: number }> {
  const buf = await readFile(path);
  const rate = buf.readUInt32LE(24);
  // find the 'data' chunk (usually at 36, but scan to be safe).
  let off = 12;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    if (id === 'data') {
      const pcm = new Int16Array(size / 2);
      for (let i = 0; i < pcm.length; i++) pcm[i] = buf.readInt16LE(off + 8 + i * 2);
      return { pcm, rate };
    }
    off += 8 + size;
  }
  return { pcm: new Int16Array(0), rate };
}

export interface ReprocessRun {
  label: string;
  model?: string;
  /** the context/bias prompt this run was transcribed with (so it's judgeable). */
  prompt?: string;
  createdAt: string;
  snapshots: unknown[];
}

/** Re-transcribe `audioPath` with `model` (+ optional `prompt`), starting at
 *  `startedAtEpoch` (so segment times map to absolute IST like the live snapshots).
 *  Returns a result run ready to append to the manifest. */
export async function reprocessStt(opts: {
  audioPath: string; dockId: string; streamId: string;
  startedAtEpoch: number; model?: string; prompt?: string; label: string; job?: string;
  /** for the 'enrich' engine: recent authoritative transcript + who's present (context). */
  enrichContext?: EnrichContext;
}): Promise<ReprocessRun> {
  // Route ONLINE engines (deepgram / gemini-audio / enrich) vs the LOCAL whisper sidecar.
  let modelName: string;
  let endpoint: string;
  type ESeg = SidecarSegment & { speaker?: number | string; source?: string; kind?: string; salience?: string; addressedToRobot?: boolean };
  let segs: ESeg[];
  if (opts.model && isOnlineEngine(opts.model)) {
    const out = await transcribeOnline(opts.model, opts.audioPath, opts.enrichContext);
    modelName = out.model; endpoint = opts.model;
    segs = out.segments.map((s) => ({
      start: s.start, end: s.end, text: s.text, speaker: s.speaker,
      avg_logprob: s.avg_logprob ?? null, no_speech_prob: s.no_speech_prob ?? null, compression_ratio: s.compression_ratio ?? null,
      source: s.source, kind: s.kind, salience: s.salience, addressedToRobot: s.addressedToRobot,
    }));
  } else {
    const { pcm, rate } = await readWav(opts.audioPath);
    const pcm_b64 = Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength).toString('base64');
    const body = JSON.stringify({ pcm_b64, sample_rate: rate, model: opts.model, initial_prompt: opts.prompt, job: opts.job });
    const r = await fetch(`${SIDECAR_URL}/transcribe_file`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body,
    });
    if (!r.ok) throw new Error(`sidecar ${r.status}: ${await r.text()}`);
    const out = await r.json() as { model: string; segments: SidecarSegment[] };
    modelName = out.model; endpoint = SIDECAR_URL; segs = out.segments ?? [];
  }

  const snapshots = segs.map((s) => {
    const from = new Date(opts.startedAtEpoch + s.start * 1000);
    const to = new Date(opts.startedAtEpoch + s.end * 1000);
    const tier = confidenceTier({
      avgLogprob: s.avg_logprob, noSpeechProb: s.no_speech_prob,
      compressionRatio: s.compression_ratio, text: s.text,
    });
    // Prefix the text with a speaker tag when the engine diarized (Sn:).
    const spk = s.speaker != null ? `S${s.speaker}: ` : '';
    return {
      ts: isoIst(from),
      source: { id: opts.streamId, kind: 'speech', device: 'reprocess', host: 'station' },
      dockId: opts.dockId,
      model: { name: modelName, endpoint },
      interval: { from: isoIst(from), to: isoIst(to), durationMs: Math.round((s.end - s.start) * 1000) },
      payload: {
        text: spk + s.text, confTier: tier, lowConfidence: tier !== 'good',
        ...(s.speaker != null ? { speaker: s.speaker } : {}),
        avgLogprob: s.avg_logprob, noSpeechProb: s.no_speech_prob, compressionRatio: s.compression_ratio,
        // enricher extras (present only for the 'enrich' engine) — shown in the compare grid.
        ...(s.source ? { audioSource: s.source } : {}),
        ...(s.kind ? { audioKind: s.kind } : {}),
        ...(s.salience ? { salience: s.salience } : {}),
        ...(s.addressedToRobot ? { addressedToRobot: true } : {}),
      },
    };
  });

  return { label: opts.label, model: modelName, prompt: opts.prompt, createdAt: isoIst(new Date()), snapshots };
}

/** Current 0..1 progress of an in-flight reprocess `job` (proxied from the sidecar). */
export async function reprocessProgress(job: string): Promise<number> {
  try {
    const r = await fetch(`${SIDECAR_URL}/progress?job=${encodeURIComponent(job)}`);
    if (!r.ok) return 0;
    const j = await r.json() as { progress?: number };
    return j.progress ?? 0;
  } catch { return 0; }
}

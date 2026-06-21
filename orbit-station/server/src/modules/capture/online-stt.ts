/**
 * online-stt — cloud STT engines as reprocess backends for the capture-judging
 * harness, to benchmark accuracy + DIARIZATION against local Whisper on real
 * recordings before committing to a paid provider (docs/findings/recall-reliability.md).
 *
 * Two engines:
 *   - 'deepgram'     — Deepgram batch (Nova) with diarization. Needs DEEPGRAM_API_KEY.
 *   - 'gemini-audio' — Gemini 2.5 transcribes the audio directly + speaker labels via
 *                      prompt. Uses the existing GEMINI_API_KEY. ("Google" path.)
 *
 * Both return per-segment { start, end, text, speaker? } with timing, so the console
 * maps them onto the recording timeline exactly like the local whisper segments.
 */

import { spawn } from 'node:child_process';

/** Downsample a WAV to 16 kHz mono (much smaller upload; online STT wants 16k anyway).
 *  Optionally extract a [start, start+dur] window (seconds) for chunked processing.
 *  Returns the converted bytes via ffmpeg → stdout. */
async function to16kMonoWav(path: string, startSec?: number, durSec?: number): Promise<Buffer> {
  const args = ['-loglevel', 'error'];
  if (startSec != null) args.push('-ss', String(startSec));
  if (durSec != null) args.push('-t', String(durSec));
  args.push('-i', path, '-ar', '16000', '-ac', '1', '-f', 'wav', 'pipe:1');
  return await new Promise((resolve, reject) => {
    const ff = spawn('ffmpeg', args);
    const chunks: Buffer[] = [];
    ff.stdout.on('data', (c) => chunks.push(c as Buffer));
    ff.on('error', reject);
    ff.on('exit', (code) => code === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error(`ffmpeg exit ${code}`)));
  });
}

/** Audio duration in seconds via ffprobe. */
async function durationSec(path: string): Promise<number> {
  return await new Promise((resolve) => {
    const ff = spawn('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', path]);
    let out = '';
    ff.stdout.on('data', (c) => { out += c; });
    ff.on('error', () => resolve(0));
    ff.on('exit', () => resolve(parseFloat(out.trim()) || 0));
  });
}

export interface OnlineSeg {
  start: number; end: number; text: string; speaker?: number | string;
  avg_logprob?: number | null; no_speech_prob?: number | null; compression_ratio?: number | null;
}
export interface OnlineResult { model: string; segments: OnlineSeg[] }

export function isOnlineEngine(model: string): boolean {
  return model === 'deepgram' || model === 'gemini-audio' || model === 'gemini-audio-lite';
}

export async function transcribeOnline(engine: string, audioPath: string): Promise<OnlineResult> {
  if (engine === 'deepgram') return deepgram(audioPath);
  if (engine === 'gemini-audio') return geminiAudio(audioPath, 'gemini-2.5-flash');
  if (engine === 'gemini-audio-lite') return geminiAudio(audioPath, 'gemini-2.5-flash-lite');
  throw new Error(`unknown online engine: ${engine}`);
}

// ── Deepgram (batch + diarization) ──────────────────────────────────────────────
async function deepgram(audioPath: string): Promise<OnlineResult> {
  const key = process.env.DEEPGRAM_API_KEY;
  if (!key) throw new Error('no DEEPGRAM_API_KEY (add it to orbit-station/.env)');
  // 16k mono — the raw 48k WAV is ~40 MB for a few minutes and times out the upload.
  const wav = await to16kMonoWav(audioPath);
  const model = process.env.CAPTURE_DEEPGRAM_MODEL ?? 'nova-2';
  // diarize + utterances (per-utterance speaker segmentation), language pinned.
  const url = `https://api.deepgram.com/v1/listen?model=${model}&diarize=true&punctuate=true&utterances=true&smart_format=true&language=en`;
  const r = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Token ${key}`, 'content-type': 'audio/wav' },
    body: wav,
    signal: AbortSignal.timeout(180_000),
  });
  if (!r.ok) throw new Error(`deepgram ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const data = await r.json() as {
    results?: { utterances?: Array<{ start: number; end: number; transcript: string; speaker?: number; confidence?: number }> };
  };
  const utts = data.results?.utterances ?? [];
  return {
    model: `deepgram-${model}`,
    segments: utts.map((u) => ({
      start: u.start, end: u.end, text: u.transcript.trim(), speaker: u.speaker,
      // Deepgram confidence (0..1) → an avg_logprob-shaped value so the tierer reuses.
      avg_logprob: u.confidence != null ? u.confidence - 1 : null,
    })),
  };
}

/** Parse a possibly-TRUNCATED JSON transcript response. Gemini can hit its output
 *  token cap mid-array on long audio, yielding invalid JSON; salvage the complete
 *  {start,end,speaker,text} objects parsed so far rather than failing the whole run. */
function parseSegmentsLoose(txt: string): Array<{ start: number; end: number; speaker?: number; text: string }> {
  try {
    return (JSON.parse(txt).segments ?? []);
  } catch {
    // Extract each well-formed {...} object from the partial array.
    const out: Array<{ start: number; end: number; speaker?: number; text: string }> = [];
    const re = /\{[^{}]*"start"[^{}]*\}/g;
    for (const m of txt.match(re) ?? []) {
      try { out.push(JSON.parse(m)); } catch { /* skip a broken one */ }
    }
    return out;
  }
}

// ── Gemini-audio (transcribe directly + speaker labels via prompt) ──────────────
// CHUNKED: split the audio into ~CHUNK_SEC windows and transcribe each. Long audio in
// one call makes Gemini tail into a repetition-loop hallucination (blank "S2:" segments)
// AND blows up output tokens (→ ~10× the cost). Chunks keep each call short, accurate,
// and cheap; we offset each chunk's segment times back to absolute.
const CHUNK_SEC = Number(process.env.CAPTURE_GEMINI_CHUNK_SEC ?? 90);

const GEMINI_PROMPT =
  'Transcribe this audio of a real multi-speaker conversation as accurately as you can. '
  + 'Diarize: label speakers as 0,1,2,… Return STRICT JSON: '
  + '{"segments":[{"start":<sec>,"end":<sec>,"speaker":<int>,"text":"…"}]}. '
  + 'start/end are seconds from the START OF THIS CLIP. Split into natural utterance '
  + 'segments. Do not invent words for unintelligible parts — omit them. JSON only.';

async function geminiAudio(audioPath: string, modelArg?: string): Promise<OnlineResult> {
  const key = process.env.GEMINI_API_KEY_PAID_ACC || process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  if (!key) throw new Error('no GEMINI_API_KEY');
  const model = modelArg ?? process.env.CAPTURE_GEMINI_AUDIO_MODEL ?? 'gemini-2.5-flash';
  const total = await durationSec(audioPath);
  const out: OnlineSeg[] = [];

  for (let off = 0; off < (total || CHUNK_SEC); off += CHUNK_SEC) {
    const wav = await to16kMonoWav(audioPath, off, CHUNK_SEC);
    const b64 = wav.toString('base64');
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: GEMINI_PROMPT }, { inline_data: { mime_type: 'audio/wav', data: b64 } }] }],
        generationConfig: { responseMimeType: 'application/json', temperature: 0.1, maxOutputTokens: 8192 },
      }),
      signal: AbortSignal.timeout(120_000),
    });
    if (!r.ok) throw new Error(`gemini-audio ${r.status}: ${(await r.text()).slice(0, 200)}`);
    const data = await r.json() as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
    const txt = data?.candidates?.[0]?.content?.parts?.[0]?.text ?? '{}';
    for (const s of parseSegmentsLoose(txt)) {
      const text = (s.text ?? '').trim();
      if (!text) continue; // drop empty (loop residue)
      out.push({ start: off + (s.start ?? 0), end: off + (s.end ?? s.start ?? 0), text, speaker: s.speaker });
    }
    if (!total) break; // unknown duration → single chunk
  }
  return { model: `gemini-audio (${model})`, segments: out };
}

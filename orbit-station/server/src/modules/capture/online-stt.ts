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
 *  Returns the converted bytes via ffmpeg → stdout. */
async function to16kMonoWav(path: string): Promise<Buffer> {
  return await new Promise((resolve, reject) => {
    const ff = spawn('ffmpeg', ['-loglevel', 'error', '-i', path, '-ar', '16000', '-ac', '1', '-f', 'wav', 'pipe:1']);
    const chunks: Buffer[] = [];
    ff.stdout.on('data', (c) => chunks.push(c as Buffer));
    ff.on('error', reject);
    ff.on('exit', (code) => code === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error(`ffmpeg exit ${code}`)));
  });
}

export interface OnlineSeg {
  start: number; end: number; text: string; speaker?: number | string;
  avg_logprob?: number | null; no_speech_prob?: number | null; compression_ratio?: number | null;
}
export interface OnlineResult { model: string; segments: OnlineSeg[] }

export function isOnlineEngine(model: string): boolean {
  return model === 'deepgram' || model === 'gemini-audio';
}

export async function transcribeOnline(engine: string, audioPath: string): Promise<OnlineResult> {
  if (engine === 'deepgram') return deepgram(audioPath);
  if (engine === 'gemini-audio') return geminiAudio(audioPath);
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
async function geminiAudio(audioPath: string): Promise<OnlineResult> {
  const key = process.env.GEMINI_API_KEY_PAID_ACC || process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  if (!key) throw new Error('no GEMINI_API_KEY');
  const model = process.env.CAPTURE_GEMINI_AUDIO_MODEL ?? 'gemini-2.5-flash';
  const wav = await to16kMonoWav(audioPath); // 16k mono — smaller inline payload
  const b64 = wav.toString('base64');
  const prompt =
    'Transcribe this audio of a real multi-speaker conversation as accurately as you can. '
    + 'Diarize: label speakers as 0,1,2,… Return STRICT JSON: '
    + '{"segments":[{"start":<sec>,"end":<sec>,"speaker":<int>,"text":"…"}]}. '
    + 'start/end are seconds from the beginning of the audio. Split into natural utterance '
    + 'segments. Do not invent words for unintelligible parts — omit them. JSON only.';
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }, { inline_data: { mime_type: 'audio/wav', data: b64 } }] }],
      generationConfig: { responseMimeType: 'application/json', temperature: 0.1, maxOutputTokens: 65536 },
    }),
    signal: AbortSignal.timeout(300_000), // long audio → Gemini can take minutes
  });
  if (!r.ok) throw new Error(`gemini-audio ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const data = await r.json() as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
  const txt = data?.candidates?.[0]?.content?.parts?.[0]?.text ?? '{}';
  const segs = parseSegmentsLoose(txt);
  return {
    model: `gemini-audio (${model})`,
    // Drop empty-text segments — Gemini can tail into a repetition loop of blank
    // "S2:" segments after the real content ends; those aren't speech.
    segments: segs
      .map((s) => ({ start: s.start, end: s.end, text: (s.text ?? '').trim(), speaker: s.speaker }))
      .filter((s) => s.text.length > 0),
  };
}

/**
 * background-stt — the PRODUCTION background transcription path: re-transcribe a
 * single VAD-gated utterance with an online model (default Gemini flash-lite) to
 * UPGRADE the speech snapshot with better, DIARIZED text for recall.
 *
 * The split (docs/findings/recall-reliability.md):
 *   - real-time / addressed turns  → LOCAL Whisper (fast; drives onFinal/emit).
 *   - background snapshot (recall)  → this (online, accurate, diarized).
 *
 * VAD stays local (the cost gate): we only ever send DETECTED UTTERANCE PCM here —
 * never silence, never a connection. One short call per utterance.
 */

const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

function geminiKey(): string | undefined {
  return process.env.GEMINI_API_KEY_PAID_ACC || process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
}

/** One utterance's diarized transcript: the text + (optional) speaker index. */
export interface BgTranscript { text: string; speaker?: number }

const PROMPT =
  'Transcribe this short audio of a real conversation as accurately as you can. '
  + 'If multiple people speak, diarize: label each speaker 0,1,2,…. '
  + 'Return STRICT JSON {"text":"<best transcript, with \\"Sn: \\" speaker prefixes if '
  + 'multiple speakers>","speaker":<the dominant speaker index, or 0>}. '
  + 'Do NOT invent words for unintelligible audio — return "" if you cannot make it out. JSON only.';

/** Build a minimal WAV (16-bit mono) around PCM-16 samples for the audio payload. */
function wav(pcm: Int16Array, rate: number): Buffer {
  const dataBytes = pcm.length * 2;
  const b = Buffer.alloc(44 + dataBytes);
  b.write('RIFF', 0); b.writeUInt32LE(36 + dataBytes, 4); b.write('WAVE', 8);
  b.write('fmt ', 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22); b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate * 2, 28);
  b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34);
  b.write('data', 36); b.writeUInt32LE(dataBytes, 40);
  for (let i = 0; i < pcm.length; i++) b.writeInt16LE(pcm[i]!, 44 + i * 2);
  return b;
}

/**
 * Re-transcribe one utterance's PCM with the background model. `model` is a Gemini
 * model id (e.g. 'gemini-2.5-flash-lite'). Returns null on any failure (the caller
 * keeps the Whisper snapshot) — background STT must never break the live path.
 */
export async function backgroundTranscribe(
  pcm: Int16Array, sampleRate: number, model: string,
): Promise<BgTranscript | null> {
  const key = geminiKey();
  if (!key) return null;
  const b64 = wav(pcm, sampleRate).toString('base64');
  try {
    const r = await fetch(`${GEMINI_BASE}/${model}:generateContent?key=${key}`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: PROMPT }, { inline_data: { mime_type: 'audio/wav', data: b64 } }] }],
        generationConfig: { responseMimeType: 'application/json', temperature: 0.1, maxOutputTokens: 1024 },
      }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!r.ok) return null;
    const data = await r.json() as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
    const txt = data?.candidates?.[0]?.content?.parts?.[0]?.text ?? '{}';
    const parsed = JSON.parse(txt) as { text?: string; speaker?: number };
    const text = (parsed.text ?? '').trim();
    if (!text) return null;
    return { text, speaker: typeof parsed.speaker === 'number' ? parsed.speaker : undefined };
  } catch {
    return null; // network/timeout/parse → keep the local Whisper snapshot
  }
}

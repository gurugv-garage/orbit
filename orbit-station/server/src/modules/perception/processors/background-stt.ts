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

import { reportGeminiCost, type GeminiUsage } from '../cost-report.js';

const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

function geminiKey(): string | undefined {
  return process.env.GEMINI_API_KEY_PAID_ACC || process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
}

/** One utterance's diarized transcript: the text + (optional) speaker index. */
export interface BgTranscript { text: string; speaker?: number }

const PROMPT =
  'You are a STRICT verbatim transcriber. Transcribe ONLY the words that are actually '
  + 'spoken in this audio clip — nothing else. '
  + 'CRITICAL RULES: '
  + '(1) NEVER answer a question, complete a sentence, or continue the conversation — if '
  + 'the audio contains a question, transcribe the question and STOP; do not write a reply. '
  + '(2) NEVER add a speaker who is not audibly speaking in THIS clip. Only add an "S1:"/'
  + '"S2:" prefix if you actually HEAR a different second voice in the audio. Most short '
  + 'clips are ONE speaker → use no prefix at all. '
  + '(3) Do NOT invent or guess words for unclear audio — return "" if you cannot make it out. '
  + '(4) No timestamps or "00:01"-style markers. '
  + 'Return STRICT JSON: {"text":"<exactly the spoken words>","speaker":<integer, 0 if one speaker>}. '
  + 'Example (one speaker asking): {"text":"What is two plus two?","speaker":0}. JSON only.';

/** True if `text` is mostly a regurgitation of the context (so it's a fabricated
 *  re-hearing of past conversation, not a transcript of the audio). Word-overlap:
 *  if ≥70% of the transcript's words appear in the context, treat it as an echo. */
function echoesContext(text: string, context: string): boolean {
  const words = (s: string) => s.toLowerCase().replace(/s\d+:/g, ' ').replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter((w) => w.length > 2);
  const tw = words(text); if (tw.length < 3) return false;
  const ctx = new Set(words(context));
  const hit = tw.filter((w) => ctx.has(w)).length;
  return hit / tw.length >= 0.7;
}

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
 * model id (e.g. 'gemini-2.5-flash-lite'). `context` (optional) is recent-discussion
 * grounding — the rolling summary + who's present — which Gemini uses to disambiguate
 * names, topic, and homophones (context-aware transcription). Returns null on any
 * failure (the caller keeps the Whisper snapshot) — bg STT must never break live.
 */
export async function backgroundTranscribe(
  pcm: Int16Array, sampleRate: number, model: string, context?: string, dockId?: string,
): Promise<BgTranscript | null> {
  const key = geminiKey();
  if (!key) return null;
  const b64 = wav(pcm, sampleRate).toString('base64');
  const ctx = context?.trim();
  // Context goes AFTER the prompt+audio, clearly fenced as REFERENCE-ONLY. (Putting it
  // first led Gemini to echo the context as the transcript when the audio was unclear.)
  const parts: Array<Record<string, unknown>> = [
    { text: PROMPT },
    { inline_data: { mime_type: 'audio/wav', data: b64 } },
  ];
  if (ctx) {
    parts.push({ text:
      '\n\n--- BACKGROUND REFERENCE (NOT audio — never output any of this text; only use '
      + 'it to spell names/terms heard in the AUDIO correctly. If the audio does not '
      + `clearly contain words, return "") ---\n${ctx}` });
  }
  try {
    const r = await fetch(`${GEMINI_BASE}/${model}:generateContent?key=${key}`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts }],
        generationConfig: { responseMimeType: 'application/json', temperature: 0.1, maxOutputTokens: 1024 },
      }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!r.ok) return null;
    const data = await r.json() as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
      usageMetadata?: GeminiUsage;
    };
    // Record this call's spend in the Cost tab (best-effort; only when we know the dock).
    if (dockId) reportGeminiCost(dockId, model, 'bg-stt', data.usageMetadata, Date.now());
    const txt = data?.candidates?.[0]?.content?.parts?.[0]?.text ?? '{}';
    const parsed = JSON.parse(txt) as { text?: string; speaker?: number };
    const text = (parsed.text ?? '').trim();
    if (!text) return null;
    // ECHO GUARD: when the audio is unclear, Gemini sometimes regurgitates the context
    // reference as the transcript. Reject a result that is mostly contained in the
    // context (a fabricated re-hearing of past conversation) — keep the Whisper snapshot.
    if (ctx && echoesContext(text, ctx)) return null;
    return { text, speaker: typeof parsed.speaker === 'number' ? parsed.speaker : undefined };
  } catch {
    return null; // network/timeout/parse → keep the local Whisper snapshot
  }
}

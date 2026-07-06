/**
 * background-audio — the background AUDITORY SCENE INTERPRETER (successor to
 * background-stt; docs/decision-traces/bg-audio-summarizer.md). One online call
 * (default Gemini flash-lite) per SIGNIFICANT acoustic event answers "what just
 * happened acoustically, and how significant is it?" — speech, laughter, music, a
 * crash — instead of re-transcribing every utterance for diarization that never
 * worked (81% of long-term memories were subject-keyed to a meaningless "speaker 0").
 *
 * Phase 1 schema (evidence-backed; docs §3/§6): `kind` + `salience` + `transcript` +
 * `summary`, each with the model's own confidence. NO speaker indices (structurally
 * unstable per-clip), NO affect yet (flash-class models are ~chance on wordless
 * emotion — Phase 2, gated behind an own-audio bench).
 *
 * The local VAD/trigger stays the cost gate; the caller (perception/index.ts) owns
 * the cooldown/debounce. Returns null on ANY failure — this path must never break live.
 */

import { reportGeminiCost, type GeminiUsage } from '../cost-report.js';

const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

function geminiKey(): string | undefined {
  return process.env.GEMINI_API_KEY_PAID_ACC || process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
}

export type AudioKind =
  | 'speech' | 'laughter' | 'crying' | 'shouting' | 'music'
  | 'impact' | 'alarm' | 'ambient' | 'animal' | 'unknown';

/** One interpreted acoustic event. Confidences are the model's self-report — treat as
 *  a vibe, not a probability; the TRANSCRIPT's trust still comes from the local
 *  engine's confTier on the snapshot, not from here. */
export interface BgAudioEvent {
  kind: AudioKind;
  kindConf: number;          // 0..1
  transcript: string;        // verbatim words if kind=speech, else '' (never invented)
  salience: 'low' | 'notable' | 'startling';
  salienceConf: number;      // 0..1
  summary: string;           // one short line: "what happened acoustically"
  /** dock-directed intent OBSERVED in the audio — someone calling the robot, telling it
   *  to stop talking, asking it something. An OBSERVATION only: the brain's addressed
   *  latch remains the sole authority on whether anything becomes a turn (§6 invariant). */
  addressedToRobot: boolean;
  addressConf: number;       // 0..1
  directive: string;         // what they want of it ('stop talking', 'called its name'), '' if none
}

const KINDS: AudioKind[] = ['speech', 'laughter', 'crying', 'shouting', 'music', 'impact', 'alarm', 'ambient', 'animal', 'unknown'];
const SALIENCES = ['low', 'notable', 'startling'] as const;

const PROMPT =
  'You are an auditory scene interpreter for a home robot named "orbit". Listen to this '
  + 'clip and report WHAT the sound is and HOW significant it is — do not converse. '
  + 'Return STRICT JSON: {"kind":"<speech|laughter|crying|shouting|music|impact|alarm|ambient|animal|unknown>",'
  + '"kind_conf":<0..1>,"transcript":"<verbatim spoken words if kind is speech, else empty>",'
  + '"salience":"<low|notable|startling>","salience_conf":<0..1>,'
  + '"summary":"<one short sentence describing what happened acoustically>",'
  + '"addressed_to_robot":<true if someone is audibly speaking TO the robot — calling "orbit", '
  + 'telling it to stop/be quiet, asking it something — else false>,"address_conf":<0..1>,'
  + '"directive":"<what they want of the robot, in a few words (e.g. \'stop talking\', '
  + '\'called its name\', \'asked it a question\') — empty if not addressed>"}. '
  + 'RULES: '
  + '(1) salience = would a person in the room turn their head? routine talk/typing = low; '
  + 'laughter, a doorbell, raised voices = notable; a crash, a scream, an alarm = startling. '
  + '(2) transcript: ONLY words actually audible in THIS clip, verbatim; NEVER answer or '
  + 'continue what was said; if unclear or not speech, return "". '
  + '(3) NEVER invent sounds or words; if unsure of the kind, use "unknown" with low kind_conf. '
  + '(4) summary describes the SOUND ("someone laughing over music"), never a reply, and never '
  + 'a generic "speech was detected" — say what it actually sounds like. '
  + '(5) SINGING, vocals over instruments, or a played recording = "music", NOT "speech" — '
  + '"speech" is only people actually talking in the room. '
  + '(6) addressed_to_robot ONLY from words audible in THIS clip (the name "orbit", or a '
  + 'clear command aimed at the robot) — never guessed from the reference context. JSON only.';

/** True if `text` is mostly a regurgitation of the context (a fabricated re-hearing of
 *  past conversation, not a transcript of the audio). Word-overlap ≥70% = echo. */
export function echoesContext(text: string, context: string): boolean {
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

const clamp01 = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : d);

/**
 * Interpret one acoustic window. `context` (optional) = recent-discussion grounding
 * (rolling summary + who's present) to disambiguate names/terms in the transcript —
 * fenced reference-only (echo-guarded). Returns null on any failure.
 */
export async function interpretAudio(
  pcm: Int16Array, sampleRate: number, model: string, context?: string, dockId?: string,
): Promise<BgAudioEvent | null> {
  const key = geminiKey();
  if (!key) return null;
  const b64 = wav(pcm, sampleRate).toString('base64');
  const ctx = context?.trim();
  // Context goes AFTER the prompt+audio, fenced as REFERENCE-ONLY (putting it first led
  // the model to echo the context as the transcript when the audio was unclear).
  const parts: Array<Record<string, unknown>> = [
    { text: PROMPT },
    { inline_data: { mime_type: 'audio/wav', data: b64 } },
  ];
  if (ctx) {
    parts.push({ text:
      '\n\n--- BACKGROUND REFERENCE (NOT audio — never output any of this text; only use '
      + 'it to spell names/terms heard in the AUDIO correctly. If the audio does not '
      + `clearly contain words, transcript is "") ---\n${ctx}` });
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
    if (dockId) reportGeminiCost(dockId, model, 'bg-audio', data.usageMetadata, Date.now());
    const txt = data?.candidates?.[0]?.content?.parts?.[0]?.text ?? '{}';
    const p = JSON.parse(txt) as Record<string, unknown>;
    const kind = (KINDS as string[]).includes(String(p.kind)) ? p.kind as AudioKind : 'unknown';
    const salience = (SALIENCES as readonly string[]).includes(String(p.salience)) ? p.salience as BgAudioEvent['salience'] : 'low';
    let transcript = kind === 'speech' ? String(p.transcript ?? '').trim() : '';
    // ECHO GUARD: an unclear clip sometimes comes back as a regurgitation of the
    // context reference — drop the transcript (keep the event) in that case.
    if (transcript && ctx && echoesContext(transcript, ctx)) transcript = '';
    const summary = String(p.summary ?? '').trim();
    if (!summary && !transcript) return null; // nothing usable
    const addressedToRobot = p.addressed_to_robot === true;
    return {
      kind, kindConf: clamp01(p.kind_conf, 0.5),
      transcript,
      salience, salienceConf: clamp01(p.salience_conf, 0.5),
      summary: summary || transcript,
      addressedToRobot,
      addressConf: clamp01(p.address_conf, addressedToRobot ? 0.5 : 0),
      directive: addressedToRobot ? String(p.directive ?? '').trim() : '',
    };
  } catch {
    return null; // network/timeout/parse → the local record stands
  }
}

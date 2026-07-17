/**
 * clean — an LLM (Gemini) "cleaning" pass over a raw transcription run. Whisper
 * mishears far-field / multi-speaker audio; a cleaning LLM that reads the WHOLE
 * transcript can fix many errors from context. The output is another result run
 * (cleaned), shown next to the raw ones in the capture compare grid.
 *
 * We KEEP THE RAW SEGMENT TIMES (1:1 with the source run) so the cleaned run lines
 * up against it in the grid. Two modes, to test both:
 *   - 'scored': the LLM returns a cleaned line + a 0..1 confidence per segment
 *               (keeps everything, scores it).
 *   - 'drop':   no scores — the LLM DROPS a segment (empty text) when it can't
 *               confidently reconstruct it (the "cleanest output" view).
 */

import { isoIst } from '../perception/snapshots.js';
import { reportGeminiCost, type GeminiUsage } from '../perception/cost-report.js';

const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
const MODEL = process.env.CAPTURE_CLEAN_MODEL ?? 'gemini-2.5-flash';

function geminiKey(): string | undefined {
  return process.env.GEMINI_API_KEY_PAID_ACC || process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
}

export type CleanMode = 'scored' | 'drop';

interface RawSeg { id: number; from: string; to: string; text: string }

const SYSTEM_SCORED =
  'You are a transcript-cleaning assistant. You are given a raw, automatically-generated '
  + 'transcript of a real conversation — it has STT errors (mishearings, garbled words, '
  + 'repetition-loop hallucinations) from far-field / multi-speaker audio. Using the OVERALL '
  + 'CONTEXT of the whole conversation, produce a CLEANED version of each numbered segment: '
  + 'fix likely mishearings, drop obvious hallucination loops, keep the speaker\'s real meaning. '
  + 'Keep each segment\'s id and timing — only fix the TEXT. Return STRICT JSON: '
  + '{"segments":[{"id":N,"text":"cleaned text","confidence":0.0-1.0}]}. confidence = how sure '
  + 'you are the cleaned text reflects what was actually said. If a segment is pure noise, set '
  + 'text to "" and confidence low. No commentary, JSON only.';

const SYSTEM_DROP =
  'You are a transcript-cleaning assistant. You are given a raw, automatically-generated '
  + 'transcript of a real conversation — it has STT errors (mishearings, garbled words, '
  + 'repetition-loop hallucinations) from far-field / multi-speaker audio. Using the OVERALL '
  + 'CONTEXT of the whole conversation, produce a CLEANED version of each numbered segment: '
  + 'fix likely mishearings and keep the real meaning. IMPORTANT: when you are NOT confident you '
  + 'can reconstruct what was actually said, DROP that segment (return text ""). Better to omit '
  + 'than to invent. Keep each segment\'s id and timing — only fix/drop the TEXT. Return STRICT '
  + 'JSON: {"segments":[{"id":N,"text":"cleaned text or empty"}]}. No commentary, JSON only.';

export interface CleanRun {
  label: string;
  model: string;
  prompt?: string;
  createdAt: string;
  snapshots: unknown[];
  error?: string;
}

/** Clean `source` run's speech segments via Gemini. Returns a new run with the same
 *  segment times, cleaned text (+ confidence in 'scored' mode; dropped/empty in 'drop'). */
export async function cleanRun(opts: {
  sourceLabel: string;
  segments: Array<{ from: string; to: string; text: string; dockId?: string; streamId?: string }>;
  mode: CleanMode;
  model?: string;
}): Promise<CleanRun> {
  const model = opts.model || MODEL;
  const label = `${opts.sourceLabel}→clean${opts.mode === 'scored' ? '-scored' : ''}`;
  const out: CleanRun = { label, model, createdAt: isoIst(new Date()), snapshots: [] };
  const key = geminiKey();
  if (!key) { out.error = 'no GEMINI_API_KEY'; return out; }

  const raw: RawSeg[] = opts.segments.map((s, i) => ({ id: i, from: s.from, to: s.to, text: s.text }));
  if (raw.length === 0) return out;

  const system = opts.mode === 'scored' ? SYSTEM_SCORED : SYSTEM_DROP;
  const numbered = raw.map((s) => `${s.id}\t[${s.from.slice(11, 19)}] ${s.text}`).join('\n');
  const parts = [{ text: `${system}\n\n=== RAW TRANSCRIPT (id\\ttime\\ttext) ===\n${numbered}\n\n=== CLEANED JSON ===` }];

  try {
    const r = await fetch(`${GEMINI_BASE}/${model}:generateContent?key=${key}`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts }],
        generationConfig: { responseMimeType: 'application/json', temperature: 0.2 },
      }),
      signal: AbortSignal.timeout(120_000),
    });
    const data = await r.json() as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>; usageMetadata?: GeminiUsage };
    if (!r.ok) { out.error = `gemini ${r.status}: ${JSON.stringify(data).slice(0, 200)}`; return out; }
    reportGeminiCost(opts.segments[0]?.dockId ?? 'station', model, 'capture-clean', data.usageMetadata, Date.now());
    const txt = data?.candidates?.[0]?.content?.parts?.[0]?.text ?? '{}';
    const parsed = JSON.parse(txt) as { segments?: Array<{ id: number; text: string; confidence?: number }> };
    const byId = new Map((parsed.segments ?? []).map((s) => [s.id, s]));

    // Map cleaned text back onto the raw segment times. Drop empties (dropped segs).
    const first = opts.segments[0];
    for (const s of raw) {
      const cleaned = byId.get(s.id);
      const text = (cleaned?.text ?? '').trim();
      if (!text) continue; // dropped / empty
      const conf = opts.mode === 'scored' ? cleaned?.confidence : undefined;
      out.snapshots.push({
        ts: s.from,
        source: { id: first?.streamId ?? 'clean', kind: 'speech', device: 'llm-clean', host: 'station' },
        dockId: first?.dockId ?? 'unknown',
        model: { name: model, endpoint: 'gemini' },
        interval: { from: s.from, to: s.to, durationMs: new Date(s.to).getTime() - new Date(s.from).getTime() },
        payload: {
          text,
          // scored mode: carry the LLM's confidence + a matching tier so the grid colors it.
          ...(conf != null ? { confidence: conf, confTier: conf >= 0.66 ? 'good' : conf >= 0.33 ? 'shaky' : 'garbage', avgLogprob: conf - 1 } : {}),
        },
      });
    }
  } catch (e) {
    out.error = (e as Error).message;
  }
  return out;
}

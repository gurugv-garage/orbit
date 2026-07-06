/**
 * Perception summarizer (PoC) — turns a window of raw snapshot records (vision +
 * speech + identity, and optionally keyframes) into a meaningful "who was doing
 * what / talking about what" narrative, via Gemini.
 *
 * Stitching: the three streams are independent and time-ordered; this builds one
 * chronological, role-tagged transcript so the LLM can correlate them — e.g. line
 * up a speech utterance with who was present (identity) and what they were doing
 * (vision) at that moment. No hierarchy yet — it summarizes raw snapshots for the
 * chosen window.
 *
 * Returns the summary AND the exact prompt + structured input sent, so the console
 * can show what produced the result (the perception playground).
 */

import type { SnapshotRecord } from './snapshots.js';
import { reportGeminiCost } from './cost-report.js';

const MODEL = process.env.PERCEPTION_SUMMARY_MODEL ?? 'gemini-2.5-flash';
const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

function geminiKey(): string | undefined {
  return process.env.GEMINI_API_KEY_PAID_ACC || process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
}

/** A one-shot text→text Gemini call, sharing this module's key/base/cost-reporting.
 *  Used by other pipeline processors that need a quick LLM reflection (e.g. the
 *  memory curator) without standing up their own client. Throws if no key / on a
 *  non-OK response; `purpose` tags the spend in the Cost tab. */
export async function geminiText(
  prompt: string, dockId: string, purpose = 'curate', model = MODEL,
): Promise<string> {
  const key = geminiKey();
  if (!key) throw new Error('no GEMINI_API_KEY');
  const r = await fetch(`${GEMINI_BASE}/${model}:generateContent?key=${key}`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
    signal: AbortSignal.timeout(60_000),
  });
  const data = (await r.json()) as any;
  if (!r.ok) throw new Error(`gemini ${r.status}: ${JSON.stringify(data).slice(0, 200)}`);
  reportGeminiCost(dockId, model, purpose, data?.usageMetadata, Date.now());
  return data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || '';
}

const SYSTEM = [
  'You are the situational awareness of a personal robot. From a noisy perception',
  'feed of a room you produce the brief the robot acts on: what is actually going on',
  'right now, and what (if anything) is worth its attention.',
  '',
  'The feed is time-stamped streams (all times IST):',
  '  • VISION  — what a person is doing/holding (from a video model; no identity).',
  '  • SPEECH  — transcribed utterances. A "Sn:" prefix (S0/S1/…) is real DIARIZATION',
  '    (distinct speakers separated by the STT) — different numbers are different people;',
  '    map a speaker to a NAME when an IDENTITY overlaps in time. Some also carry',
  '    "[likely <name>]" (a softer active-speaker guess) and/or "[low-confidence]"',
  '    (possibly garbled/noise — judge whether it is signal or junk to ignore).',
  '  • IDENTITY — which enrolled people are recognized in frame, with positions.',
  '  • EMOTION  — a best-effort facial-expression read (e.g. "seemed a little happy").',
  '    It is approximate and can be wrong; treat it as a soft hint, never assert it as',
  '    fact. Use it only if it agrees with speech/action; otherwise downplay or omit it.',
  '  • BODYMOTION — the ROBOT\'s own camera/body movement (the camera is mounted on a',
  '    robot that can pan and drive). "stationary" or "camera moving".',
  '',
  'EGOCENTRIC AWARENESS — critical: the camera MOVES. When BODYMOTION says the camera',
  'was moving, a person leaving the frame or a new face/scene appearing is most likely',
  'the ROBOT turning or driving — NOT someone leaving/arriving and NOT the room changing.',
  'Do not report "X left" / "Y arrived" / "moved to a new room" if it coincides with',
  'camera motion; instead say the robot looked around / moved. Only treat appearances and',
  'disappearances as real world events when the camera was STATIONARY.',
  '',
  'WRITE FOR RELEVANCE, NOT COVERAGE. Lead with the single most important thing:',
  'what the person is engaged in, their apparent state or intent, and anything notable,',
  'new, or actionable (a question asked, a request, a change, a strong emotion, someone',
  'arriving/leaving, a problem). Name people when IDENTITY overlaps in time (say "likely"',
  'if unsure — it is not true diarization). Infer the THROUGHLINE — connect speech +',
  'action + emotion into what is really happening, e.g. "Guru is debugging and sounds',
  'frustrated", not "the person typed; the person spoke".',
  '',
  'DROP THE MUNDANE. Steady-state ("sitting and working") in one short clause, then move',
  'on. Do not list position samples, do not recount every utterance, do not narrate noise.',
  'If genuinely nothing of consequence happened, say exactly that in one line — do not pad.',
  '',
  'Read past the noise, do not narrate it:',
  '  • IDENTITY flickers (~2 s) — brief "unknown"/"no one" gaps do NOT mean someone left;',
  '    treat short gaps as continuity.',
  '  • SPEECH has errors/fragments/filler — paraphrase the intent; ignore garbled bits.',
  '',
  'Ground every claim in the data; never invent people, objects, or topics. Be specific',
  'and concrete (real topics, real actions) over vague ("some activity"). 2-4 sharp',
  'sentences. Reasonable inference about state/intent is welcome; fabrication is not.',
].join('\n');

/** One identity line's readable "who @where" (debounced upstream of the model). */
function identityLabel(r: SnapshotRecord): string {
  const faces = (r.payload.faces as Array<{ name: string | null; box?: { x: number; y: number; w: number; h: number } }> | undefined) ?? [];
  if (!faces.length) return 'no one';
  return faces.map((f) => {
    const pos = f.box ? ` @${f.box.x < 0.33 ? 'left' : f.box.x > 0.66 ? 'right' : 'center'}` : '';
    return `${f.name ?? 'unknown'}${pos}`;
  }).join(', ');
}

/** Cheap diarization: during a speech utterance, which present face had its mouth
 *  most open (was speaking)? Returns that name, or null if undeterminable. Uses the
 *  identity records (which carry per-face mouthOpen) overlapping the utterance. */
function activeSpeaker(all: SnapshotRecord[], speech: SnapshotRecord): string | null {
  const from = speech.interval.from, to = speech.interval.to;
  const MOUTH_MIN = 0.04; // openness floor to count as "speaking"
  let best: { name: string; open: number } | null = null;
  for (const r of all) {
    if (r.source.kind !== 'identity') continue;
    if (r.interval.to < from || r.interval.from > to) continue; // no time overlap
    const faces = (r.payload.faces as Array<{ name: string | null; mouthOpen?: number }> | undefined) ?? [];
    for (const f of faces) {
      if (!f.name || f.mouthOpen == null) continue;
      if (f.mouthOpen >= MOUTH_MIN && (!best || f.mouthOpen > best.open)) {
        best = { name: f.name, open: f.mouthOpen };
      }
    }
  }
  return best?.name ?? null;
}

/** Build the chronological, role-tagged transcript the model reasons over.
 *  Identity flickers every ~2 s; we COLLAPSE consecutive identical identity labels
 *  into one line ("12:02:19–12:02:47 Guru @center") so the model sees presence
 *  spans, not jitter — the single biggest cleanup for readable summaries. */
export function stitch(records: SnapshotRecord[]): string {
  const sorted = [...records].sort((a, b) =>
    a.interval.from < b.interval.from ? -1 : a.interval.from > b.interval.from ? 1 : 0);
  const lines: string[] = [];
  // Collapse consecutive identical IDENTITY and BODYMOTION readings into spans
  // (both are state streams that repeat) so the model sees presence/motion spans,
  // not jitter. Each has its own run accumulator.
  let idRun: { label: string; from: string; to: string } | null = null;
  let bmRun: { label: string; from: string; to: string } | null = null;

  const flushId = () => {
    if (!idRun) return;
    const span = idRun.from === idRun.to ? idRun.from : `${idRun.from}–${idRun.to}`;
    lines.push(`${span} IDENTITY ${idRun.label}`);
    idRun = null;
  };
  const flushBm = () => {
    if (!bmRun) return;
    const span = bmRun.from === bmRun.to ? bmRun.from : `${bmRun.from}–${bmRun.to}`;
    lines.push(`${span} CAMERA  ${bmRun.label}`);
    bmRun = null;
  };
  const flushRuns = () => { flushId(); flushBm(); };

  for (const r of sorted) {
    const t = r.interval.from.slice(11, 19); // HH:MM:SS IST
    if (r.source.kind === 'bodymotion') {
      const label = r.payload.text;
      if (bmRun && bmRun.label === label) bmRun.to = t;
      else { flushBm(); bmRun = { label, from: t, to: t }; }
    } else if (r.source.kind === 'identity') {
      const label = identityLabel(r);
      if (idRun && idRun.label === label) idRun.to = t;       // extend the run
      else { flushId(); idRun = { label, from: t, to: t }; }  // new run
    } else if (r.source.kind === 'speech') {
      flushRuns();
      // ACTIVE-SPEAKER (cheap diarization): who had their mouth most open during
      // this utterance? Look at identity records overlapping the utterance time.
      const speaker = activeSpeaker(sorted, r);
      const tag = speaker ? ` [likely ${speaker}]` : '';
      const tier = (r.payload as { confTier?: string }).confTier
        ?? ((r.payload as { lowConfidence?: boolean }).lowConfidence ? 'shaky' : 'good');
      if (tier === 'garbage') {
        // GARBAGE tier: words unreliable (far-field mush / a Whisper repetition-loop).
        // Do NOT present the garbled text as content — the brain must not treat it as
        // something that was said. Render the FACT of unclear speech + its duration.
        const secs = Math.round((r.interval.durationMs ?? 0) / 1000);
        lines.push(`${t} SPEECH  [unclear speech${secs ? `, ~${secs}s` : ''}]${tag}`);
      } else {
        const conf = tier === 'shaky' ? ' [low-confidence]' : '';
        // dock-directed intent OBSERVED by the audio interpreter (the brain's addressed
        // latch stays the authority) — surfaced so the summary knows it was spoken TO.
        const pr = r.payload as { addressedToRobot?: boolean; directive?: string };
        const toRobot = pr.addressedToRobot ? ` [→ robot${pr.directive ? `: ${pr.directive}` : ''}]` : '';
        lines.push(`${t} SPEECH  ${r.payload.text}${tag}${conf}${toRobot}`);
      }
    } else {
      flushRuns();
      // vision windows may carry a structured CHANGE field (what differs vs the previous
      // window) — the signal the summarizer actually wants; render it distinctly.
      const change = (r.payload as { change?: string }).change;
      lines.push(`${t} ${r.source.kind.toUpperCase().padEnd(8)} ${r.payload.text}${change ? ` [changed: ${change}]` : ''}`);
    }
  }
  flushRuns();
  return lines.join('\n');
}

export interface SummaryResult {
  summary: string;
  model: string;
  withKeyframes: boolean;
  counts: { vision: number; speech: number; identity: number; emotion: number; bodymotion: number; keyframes: number };
  // exactly what was sent, for the console to display:
  prompt: { system: string; transcript: string };
  error?: string;
}

/**
 * Summarize a window of records. `keyframes` (base64 JPEG, optional) are sent
 * inline so we can A/B test whether images help vs. text-only stitching.
 */
export async function summarize(
  records: SnapshotRecord[],
  opts: { keyframes?: string[]; model?: string } = {},
): Promise<SummaryResult> {
  const key = geminiKey();
  const model = opts.model || MODEL;
  const tally = (k: SnapshotRecord['source']['kind']) => records.filter((r) => r.source.kind === k).length;
  const counts = {
    vision: tally('vision'), speech: tally('speech'), identity: tally('identity'),
    emotion: tally('emotion'), bodymotion: tally('bodymotion'),
    keyframes: opts.keyframes?.length ?? 0,
  };
  const transcript = stitch(records);
  const result: SummaryResult = {
    summary: '', model, withKeyframes: counts.keyframes > 0, counts,
    prompt: { system: SYSTEM, transcript },
  };
  if (!key) { result.error = 'no GEMINI_API_KEY'; return result; }
  if (records.length === 0) { result.summary = '(no perception data in this window)'; return result; }

  const parts: Array<Record<string, unknown>> = [
    { text: `${SYSTEM}\n\n=== PERCEPTION TIMELINE (window) ===\n${transcript}\n\n=== SUMMARY ===` },
  ];
  if (opts.keyframes?.length) {
    parts.push({ text: '\nRepresentative keyframes from the window (in order):' });
    for (const b64 of opts.keyframes) parts.push({ inline_data: { mime_type: 'image/jpeg', data: b64 } });
  }

  try {
    const r = await fetch(`${GEMINI_BASE}/${model}:generateContent?key=${key}`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts }] }),
      signal: AbortSignal.timeout(60_000),
    });
    const data = (await r.json()) as any;
    if (!r.ok) { result.error = `gemini ${r.status}: ${JSON.stringify(data).slice(0, 200)}`; return result; }
    // Record this summarizer call's spend in the Cost tab (all records share one
    // dock — it's the rollup `source`). Best-effort; skipped if usage is absent.
    const dockId = records[0]?.dockId;
    if (dockId) reportGeminiCost(dockId, model, 'summary', data?.usageMetadata, Date.now());
    result.summary = data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || '(empty)';
  } catch (e) {
    result.error = (e as Error).message;
  }
  return result;
}

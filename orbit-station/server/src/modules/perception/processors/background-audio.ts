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

/** The keys to try, in order: paid account first (higher limits), then the free/default key as a
 *  fallback. De-duped + de-blanked. A 429 on the paid key rolls over to free (and vice-versa if only
 *  free is set), mirroring the brain's free→paid fallback but generalized to a transient-retry. */
function geminiKeys(): string[] {
  return [...new Set([
    process.env.GEMINI_API_KEY_PAID_ACC,
    process.env.GEMINI_API_KEY,
    process.env.GOOGLE_API_KEY,
  ].filter((k): k is string => !!k))];
}

const sleep = (ms: number) => new Promise<void>((res) => { setTimeout(res, ms); });

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

// ─────────────────────────── AUDIO ENRICHER (live) ───────────────────────────
// The merged live path: ONE context-aware call over a batch window (the debounced
// vad-endpoint trigger). Its PRIMARY job is accurate, coherent, in-context transcription
// (turning garbled reflex-STT into real sentences); it also diarizes, distinguishes real
// in-room speech from PLAYED MEDIA (a TV/video/music) and non-speech sound, and tags salience
// + an addressed observation. Returns per-utterance SEGMENTS with times relative to the window
// start (ms) so the caller can land one record per segment. Mirrors capture/online-stt.ts's
// enrich prompt (kept in sync). Returns [] on any failure — the live path must never break.
export interface EnrichSegment {
  fromMs: number; toMs: number;         // relative to the window start
  text: string;
  speaker?: number;                     // diarized index within the window
  source: 'speech' | 'media' | 'sound'; // real speech vs played media vs a non-speech sound
  kind?: string;                        // acoustic kind (music/impact/laughter/… — set for any source)
  transcriptConf?: number;              // 0..1 — the model's own confidence the text is what was really said
  salience: 'low' | 'notable' | 'startling';
  salienceConf?: number;                // 0..1 — the model's confidence in the salience
  addressedToRobot: boolean;
  addressConf?: number;                 // 0..1 — confidence it was addressed to the robot
  directive?: string;                   // what they want of the robot ('stop', 'called its name'), if addressed
  summary?: string;                     // one short line: what this segment IS, acoustically/semantically
  echo?: boolean;                       // the model's OWN flag: it suspects this is the reference context
                                        // leaking (not fresh audio). KEPT + shown dimmed, never dropped.
}
export interface EnrichContext { recentTranscript?: string; present?: string[] }

const ENRICH_PROMPT_BASE =
  'You transcribe and interpret audio for a home robot named "orbit". This is a real room that '
  + 'may have MULTIPLE people talking (possibly overlapping) AND background media (a TV, a video, '
  + 'or music playing). Your MAIN job is an ACCURATE, coherent transcript — turn unclear audio into '
  + 'the most likely real sentences, not word-salad. '
  + 'Return STRICT JSON: {"segments":[{"start":<sec>,"end":<sec>,"speaker":<int>,'
  + '"source":"<speech|media|sound>","text":"…","transcript_conf":<0..1>,"kind":"<the acoustic type: '
  + 'speech|music|impact|laughter|alarm|ambient|animal|… >","salience":"<low|notable|startling>",'
  + '"salience_conf":<0..1>,"summary":"<one short line: what this segment IS>","addressed":<true|false>,'
  + '"address_conf":<0..1>,"directive":"<if addressed: what they want of the robot, else empty>",'
  + '"echo":<true|false — see rule 5>}]}. '
  + 'RULES: (1) ONE SEGMENT PER CONTINUOUS UTTERANCE — a full sentence or complete thought from a '
  + 'single speaker. DO NOT split per word or per short phrase; merge a run of words by the same '
  + 'speaker into one segment (e.g. "Okay, and then we can do the other one again." is ONE segment, '
  + 'NOT eight). Start a new segment only when the SPEAKER CHANGES or there is a clear pause/topic '
  + 'shift. Aim for a handful of segments across the clip, not dozens. '
  + '(2) start/end = seconds from the START OF THIS CLIP, giving each segment its REAL span (a normal '
  + 'sentence is ~1–4 s, never 0). (3) DIARIZE: a stable speaker index (0,1,2,…) per distinct person. '
  + '(4) source: "speech"=a person in the room; "media"=a TV/video/song/recording playing (never '
  + 'addressed); "sound"=a non-speech event (crash/laughter/doorbell/alarm — describe in text, type '
  + 'in kind). (5) THE REFERENCE TRANSCRIPT IS PRIOR CONTEXT ONLY — it is NOT part of this audio. Use '
  + 'it to spell names/terms consistently and to continue a cut-off thought, but transcribe ONLY what '
  + 'is actually AUDIBLE in THIS clip. Do NOT re-output the reference as if it were just spoken. '
  + 'IMPORTANT: if a person genuinely REPEATS something from the reference (they really said it again '
  + 'in this audio), that IS real speech — transcribe it normally. Only if you are UNSURE whether a '
  + 'segment is truly in this audio versus leaking from the reference, still emit it but set '
  + '"echo":true (default false) so a human can review it — never silently drop a genuine repeat. '
  + 'Never invent words for unintelligible audio (omit). (6) salience: routine talk=low; '
  + 'laughter/doorbell/raised voices=notable; crash/scream/alarm=startling. (7) addressed=true ONLY '
  + 'when a real in-room speaker talks TO the robot ("orbit"/a command) — never for media. '
  + '(8) transcript_conf = HOW SURE you are the text is what was REALLY said (0..1). BE HONEST: if the '
  + 'audio is far/noisy/unclear and you are guessing or it comes out as nonsense, give a LOW '
  + 'transcript_conf — do NOT confidently invent plausible-sounding word-salad. A low-confidence '
  + 'segment is fine; a fabricated confident one is not. JSON only.';

/** Coalesce over-split fragments the model returns despite the prompt: merge CONSECUTIVE segments
 *  from the same speaker+source into one utterance (concatenating text, extending the span). Also
 *  fixes DEGENERATE times — when the model piles everything at ~0s, spread the merged utterances
 *  evenly across the real window so the timeline isn't a zero-width stack. */
export function coalesceSegments(segs: EnrichSegment[], windowMs: number): EnrichSegment[] {
  if (!segs.length) return segs;
  const norm = (t: string) => t.toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
  const merged: EnrichSegment[] = [];
  for (const s of segs) {
    if (!s.text.trim()) continue;
    const prev = merged[merged.length - 1];
    // DROP a consecutive DUPLICATE (the model re-emits the same sentence across an overlap): if the
    // previous kept segment has identical normalized text from the same speaker, skip this one.
    if (prev && prev.speaker === s.speaker && norm(prev.text) === norm(s.text)) continue;
    // REPETITION-LOOP guard (flash-lite hallucinates "X, X, X…"): collapse an immediately-repeated
    // phrase within the text (3+ reps of the same short run → keep one).
    s.text = s.text.replace(/\b(.{4,40}?)(?:[ ,.]+\1\b){2,}/gi, '$1');
    if (prev && prev.speaker === s.speaker && prev.source === s.source
        && s.fromMs - prev.toMs < 1200                       // same speaker, < 1.2s gap → one utterance…
        && !/[.!?]"?\s*$/.test(prev.text)) {                 // …unless the prev already ended a sentence
      prev.text = `${prev.text} ${s.text}`.replace(/\s+/g, ' ').trim();
      prev.toMs = Math.max(prev.toMs, s.toMs);
      if (s.salience === 'startling' || (s.salience === 'notable' && prev.salience === 'low')) { prev.salience = s.salience; prev.salienceConf = s.salienceConf; }
      if (s.addressedToRobot && !prev.addressedToRobot) { prev.addressedToRobot = true; prev.addressConf = s.addressConf; prev.directive = s.directive; }
      if (!prev.summary && s.summary) prev.summary = s.summary;
      if (!prev.kind && s.kind) prev.kind = s.kind;
      // a merged utterance is only as trustworthy as its LEAST-confident fragment
      if (s.transcriptConf != null) prev.transcriptConf = Math.min(prev.transcriptConf ?? 1, s.transcriptConf);
    } else merged.push({ ...s });
  }
  // DEGENERATE times: if the segments' total span covers < half the window, the model's timestamps
  // are junk — spread the merged utterances evenly across the real window instead. Each spread
  // segment is CAPPED (a real utterance is ~seconds, not tens of seconds) so a 2-segment 40s window
  // doesn't produce two 20s blobs; leave the rest as an implicit gap.
  const SPREAD_SEG_CAP_MS = 8_000;
  const span = merged.length > 1 ? Math.max(...merged.map((m) => m.toMs)) - Math.min(...merged.map((m) => m.fromMs)) : windowMs;
  if (merged.length > 1 && span < windowMs * 0.5) {
    const slot = windowMs / merged.length;
    merged.forEach((m, i) => { m.fromMs = Math.round(i * slot); m.toMs = Math.round(i * slot + Math.min(slot, SPREAD_SEG_CAP_MS)); });
  }
  return merged;
}

/** Interpret one BATCH WINDOW: accurate in-context transcription + diarization + acoustic read.
 *  `pcm` is the window (16 kHz mono); `context` biases spelling/continuation. Returns the segments
 *  PLUS per-call operational metadata (model, latency, tokens, prompt) for observability. Returns
 *  empty segments on any failure — the live path must never break. */
export interface EnrichMeta {
  model: string; latencyMs: number;
  promptTokens?: number; outputTokens?: number; totalTokens?: number;
  promptChars: number; windowMs: number; hadContext: boolean;
  /** the FULL prompt sent (template + context) — kept so the row can show exactly what was asked. */
  prompt: string;
}
export interface EnrichResult { segments: EnrichSegment[]; meta: EnrichMeta }

export async function enrichAudio(
  pcm: Int16Array, sampleRate: number, model: string, context?: EnrichContext, dockId?: string,
): Promise<EnrichResult> {
  const windowMs = Math.round(pcm.length / (sampleRate / 1000));
  let prompt = ENRICH_PROMPT_BASE;
  const present = context?.present?.filter(Boolean);
  if (present?.length) prompt += `\n\nPEOPLE LIKELY PRESENT (for name spelling): ${present.join(', ')}.`;
  const rt = context?.recentTranscript?.trim();
  if (rt) prompt += `\n\n--- REFERENCE TRANSCRIPT (recent, context ONLY — do not echo) ---\n${rt}`;
  const meta: EnrichMeta = { model, latencyMs: 0, promptChars: prompt.length, windowMs, hadContext: !!rt, prompt };
  const keys = geminiKeys();
  if (!keys.length) return { segments: [], meta };
  const b64 = wav(pcm, sampleRate).toString('base64');
  const body = JSON.stringify({
    contents: [{ parts: [{ text: prompt }, { inline_data: { mime_type: 'audio/wav', data: b64 } }] }],
    generationConfig: { responseMimeType: 'application/json', temperature: 0.1, maxOutputTokens: 4096 },
  });
  // RETRY across attempts on TRANSIENT failure (429 rate-limit / 5xx / timeout) — a single 429 used
  // to silently drop a whole batch's enrichment (10-30s = several utterances), the "parakeet has it,
  // enricher doesn't" miss. Each attempt rotates to the next key (paid→free→…), so a rate-limited
  // account rolls over. 4xx (other than 429) is NOT retried — it won't get better. Live path stays
  // best-effort: after all attempts, return [] rather than throw.
  const MAX_ATTEMPTS = 3;
  const t0 = Date.now();
  type GeminiResp = { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>; usageMetadata?: GeminiUsage };
  let data: GeminiResp | null = null;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const key = keys[attempt % keys.length]!;
    try {
      const r = await fetch(`${GEMINI_BASE}/${model}:generateContent?key=${key}`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body,
        signal: AbortSignal.timeout(30_000),
      });
      if (r.ok) { data = await r.json() as GeminiResp; break; }
      // transient (429/5xx) → back off and retry (next key); permanent 4xx → give up now.
      const transient = r.status === 429 || r.status >= 500;
      console.log(`[enrich] http ${r.status} on attempt ${attempt + 1}/${MAX_ATTEMPTS}${transient ? ' — retrying' : ' — giving up (non-transient)'}`);
      if (!transient) break;
    } catch (e) {
      // fetch threw — timeout (AbortSignal) or network. Treat as transient.
      console.log(`[enrich] fetch error on attempt ${attempt + 1}/${MAX_ATTEMPTS} (${(e as Error)?.name ?? 'error'}) — retrying`);
    }
    if (attempt < MAX_ATTEMPTS - 1) await sleep(400 * (attempt + 1)); // 400ms, 800ms backoff
  }
  meta.latencyMs = Date.now() - t0;
  if (!data) return { segments: [], meta };
  try {
    const um = data.usageMetadata as { promptTokenCount?: number; candidatesTokenCount?: number; totalTokenCount?: number } | undefined;
    meta.promptTokens = um?.promptTokenCount; meta.outputTokens = um?.candidatesTokenCount; meta.totalTokens = um?.totalTokenCount;
    if (dockId) reportGeminiCost(dockId, model, 'enrich', data.usageMetadata, Date.now());
    const txt = data?.candidates?.[0]?.content?.parts?.[0]?.text ?? '{}';
    let raw: Array<Record<string, unknown>>;
    try { raw = (JSON.parse(txt).segments ?? []) as Array<Record<string, unknown>>; }
    catch { raw = []; for (const m of txt.match(/\{[^{}]*"start"[^{}]*\}/g) ?? []) { try { raw.push(JSON.parse(m)); } catch { /* skip */ } } }
    const mapped = raw
      .map((s): EnrichSegment => {
        const src = ['speech', 'media', 'sound'].includes(String(s.source)) ? s.source as EnrichSegment['source'] : 'speech';
        const conf = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : undefined);
        const addressed = s.addressed === true && src === 'speech';
        return {
          fromMs: Math.max(0, Math.round(((s.start as number) ?? 0) * 1000)),
          toMs: Math.round((((s.end as number) ?? (s.start as number) ?? 0)) * 1000),
          text: String(s.text ?? '').trim(),
          speaker: typeof s.speaker === 'number' ? s.speaker : undefined,
          source: src,
          kind: s.kind ? String(s.kind) : undefined,
          transcriptConf: conf(s.transcript_conf),
          salience: (['low', 'notable', 'startling'].includes(String(s.salience)) ? s.salience : 'low') as EnrichSegment['salience'],
          salienceConf: conf(s.salience_conf),
          addressedToRobot: addressed,
          addressConf: addressed ? conf(s.address_conf) : undefined,
          directive: addressed && s.directive ? String(s.directive).trim() : undefined,
          summary: s.summary ? String(s.summary).trim() : undefined,
          // the model's OWN echo self-flag (rule 5). We KEEP echo segments and surface them dimmed
          // in the Studio rather than dropping them in code — a genuine repeat must never vanish.
          echo: s.echo === true ? true : undefined,
        };
      })
      .filter((s) => s.text.length > 0);
    // Coalesce over-split fragments (the model splits per-word despite the prompt) + fix degenerate
    // times — so one utterance becomes ONE record, not a stack of single words.
    return { segments: coalesceSegments(mapped, windowMs), meta };
  } catch {
    return { segments: [], meta };
  }
}

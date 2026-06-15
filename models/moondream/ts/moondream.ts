/**
 * Moondream-via-Ollama client + structure extraction — the TS port of the
 * Python benchmark (bench/vlm), living in orbit-station so it shares the exact
 * path the production perception processor will use: capture a frame at the
 * dock's 320×240, JPEG it, POST to a local Ollama, parse a useful structure out.
 *
 * Moondream in Ollama is the classic phi2 VQA model (Question/Answer template):
 * prompt-in, free-text-out — no detect/point/caption endpoints. So "structure"
 * is a PROMPTING + PARSING discipline, not a model feature. The functions below
 * are the menu of strategies we benchmark in structure-probe.ts:
 *   - ask():        free-form NL answer
 *   - askYesNo():   a boolean, parsed from a constrained yes/no answer
 *   - askJson():    Ollama format=json, validated against a zod schema
 *   - askFields():  several single-fact questions fused into one record
 *
 * Frame capture uses ffmpeg avfoundation (macOS) → one JPEG on stdout, scaled to
 * the dock's stream resolution. No native webcam bindings.
 */

import { spawn } from 'node:child_process';
import { z } from 'zod';

export const OLLAMA_URL = 'http://localhost:11434';

/** The dock's live monitoring stream spec — match it exactly. node-dock
 *  FaceTracker.kt setTargetResolution(320,240) → VP8 ~1 Hz slideshow. */
export const STREAM_W = 320;
export const STREAM_H = 240;

// --------------------------------------------------------------------------- //
// Frame capture (macOS avfoundation via ffmpeg).
// --------------------------------------------------------------------------- //
/** Grab one webcam frame as a JPEG Buffer, hard-scaled to (w,h) like the dock. */
export function captureFrame(
  cameraIndex = 0,
  w = STREAM_W,
  h = STREAM_H,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const args = [
      '-hide_banner', '-loglevel', 'error',
      '-f', 'avfoundation',
      '-framerate', '30',
      '-i', `${cameraIndex}`,
      '-frames:v', '1',
      '-vf', `scale=${w}:${h}`,
      '-q:v', '5', // JPEG quality (~q80-ish)
      '-f', 'image2', 'pipe:1',
    ];
    const ff = spawn('ffmpeg', args);
    const chunks: Buffer[] = [];
    const errs: Buffer[] = [];
    ff.stdout.on('data', (c) => chunks.push(c));
    ff.stderr.on('data', (c) => errs.push(c));
    ff.on('error', reject);
    ff.on('close', (code) => {
      if (code === 0 && chunks.length) resolve(Buffer.concat(chunks));
      else reject(new Error(`ffmpeg capture failed (code ${code}): ${Buffer.concat(errs)}`));
    });
  });
}

// --------------------------------------------------------------------------- //
// Ollama call.
// --------------------------------------------------------------------------- //
export interface InferResult {
  text: string;
  latencyMs: number;
  loadMs: number;
  evalMs: number;
}

interface GenerateOpts {
  model?: string;
  jsonFormat?: boolean;
  keepAlive?: string;
  numCtx?: number;
  timeoutMs?: number;
}

/** One Ollama /api/generate call with an image. */
export async function generate(
  prompt: string,
  imageB64: string,
  opts: GenerateOpts = {},
): Promise<InferResult> {
  const {
    model = 'moondream',
    jsonFormat = false,
    keepAlive = '10m',
    numCtx,
    timeoutMs = 120_000,
  } = opts;
  const body: Record<string, unknown> = {
    model,
    prompt,
    images: [imageB64],
    stream: false,
    keep_alive: keepAlive,
    options: { temperature: 0, ...(numCtx ? { num_ctx: numCtx } : {}) },
  };
  if (jsonFormat) body.format = 'json';

  const t0 = performance.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(`${OLLAMA_URL}/api/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!r.ok) throw new Error(`Ollama ${r.status}: ${await r.text()}`);
    const data = (await r.json()) as {
      response?: string;
      load_duration?: number;
      eval_duration?: number;
    };
    return {
      text: (data.response ?? '').trim(),
      latencyMs: performance.now() - t0,
      loadMs: (data.load_duration ?? 0) / 1e6,
      evalMs: (data.eval_duration ?? 0) / 1e6,
    };
  } finally {
    clearTimeout(timer);
  }
}

export async function ollamaUp(): Promise<boolean> {
  try {
    const r = await fetch(`${OLLAMA_URL}/api/tags`, { signal: AbortSignal.timeout(3000) });
    return r.ok;
  } catch {
    return false;
  }
}

// --------------------------------------------------------------------------- //
// Structure extraction strategies — the heart of "how much structure can we
// pull out of moondream's loose text output".
// --------------------------------------------------------------------------- //

/** 1) Free-form natural language. */
export async function ask(
  instruction: string,
  imageB64: string,
  opts?: GenerateOpts,
): Promise<{ answer: string } & InferResult> {
  const res = await generate(instruction, imageB64, opts);
  return { answer: res.text, ...res };
}

/** 2) Boolean — the key finding: moondream returns EMPTY on closed yes/no
 *  questions ("Is there a person?"), but answers a DESCRIPTIVE prompt richly.
 *  So we ask it to describe the subject, then derive the boolean from the prose
 *  ("there is no person" => false; "there is a person" => true).
 *
 *  `subject` is the thing to check for, e.g. "person", "a cat on the desk".
 *  The descriptive phrasing is what makes this reliable — see structure-probe. */
export async function askYesNo(
  subject: string,
  imageB64: string,
  opts?: GenerateOpts,
): Promise<{ value: boolean | null; raw: string } & InferResult> {
  // Open question, NOT "whether/is there" (closed framings make moondream emit
  // empty). It always answers "There is a person…/There is no person…", from
  // which polarity() reads the boolean.
  const prompt = `What ${subject} is in the image, and what is it doing?`;
  const res = await generate(prompt, imageB64, opts);
  return { value: polarity(res.text), raw: res.text, ...res };
}

/** Infer a boolean from a free-text VQA answer. Negatives win ties ("no person"
 *  beats a stray "is"). null when genuinely ambiguous. */
export function polarity(text: string): boolean | null {
  const t = ` ${text.toLowerCase()} `;
  const neg = /\bno\b|\bnot\b|\bn't\b|there (?:is|are) no|isn't|aren't|without|empty|nobody|no one/.test(t);
  const pos = /\byes\b|there (?:is|are|appears)|i can see|i see|present|a person|someone/.test(t);
  if (neg && !pos) return false;
  if (pos && !neg) return true;
  if (neg && pos) return false; // "there is no person" — negation dominates
  return null;
}

/** 3) JSON via Ollama format=json, validated against a caller schema. Returns the
 *  parsed object on success, or the raw text + the zod error when it doesn't fit
 *  (so the probe can report HOW OFTEN moondream honors a schema). */
export async function askJson<T>(
  instruction: string,
  schema: z.ZodType<T>,
  imageB64: string,
  opts?: GenerateOpts,
): Promise<{ value: T | null; raw: string; error?: string } & InferResult> {
  const prompt =
    `${instruction}\n` +
    `Respond ONLY with a JSON object, no prose. ` +
    `Keys: ${schemaHint(schema)}.`;
  const res = await generate(prompt, imageB64, { ...opts, jsonFormat: true });
  try {
    const parsed = schema.parse(JSON.parse(res.text));
    return { value: parsed, raw: res.text, ...res };
  } catch (e) {
    return { value: null, raw: res.text, error: (e as Error).message, ...res };
  }
}

/** 4) Field fusion — ask several narrow questions (each of which moondream is
 *  good at) and assemble one structured record. Slower (N calls) but the MOST
 *  reliable structure, because each call is a simple VQA the model handles well. */
export async function askFields(
  fields: Record<string, string>,
  imageB64: string,
  opts?: GenerateOpts,
): Promise<{ value: Record<string, string>; totalMs: number }> {
  const out: Record<string, string> = {};
  let totalMs = 0;
  for (const [key, q] of Object.entries(fields)) {
    const res = await generate(q, imageB64, opts);
    out[key] = res.text;
    totalMs += res.latencyMs;
  }
  return { value: out, totalMs };
}

/** Tiny human hint of a zod object's top-level keys for the prompt. (zod 4:
 *  ZodObject exposes `.shape` as a plain record.) */
function schemaHint(schema: z.ZodType): string {
  const shape = (schema as unknown as { shape?: Record<string, unknown> }).shape;
  return shape ? Object.keys(shape).map((k) => `"${k}"`).join(', ') : '(see instruction)';
}

/** A general monitoring schema we try to coax moondream into. */
export const MonitorSchema = z.object({
  present: z.boolean().describe('is a person present'),
  activity: z.string().describe('what they are doing, short'),
  match: z.boolean().describe('does the watched-for condition hold'),
});
export type Monitor = z.infer<typeof MonitorSchema>;

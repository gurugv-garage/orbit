/**
 * mood-line-bench — offline bench for idle-moods SPOKEN LINES using PAST DATA:
 * the REAL prompt assembly (buildSystemPrompt + thoughtPrompt from src), the dock's
 * REAL past spoken lines as anti-repeat pressure, and REAL past vision/speech
 * grounding — against the real brain model. No dock, no speech, just candidate
 * lines to judge. Usage: npx tsx scripts/mood-line-bench.mts [roundLabel]
 */
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSystemPrompt } from '../src/modules/brain/prompt.js';
import { BITS, thoughtPrompt } from '../src/tasks/packaged/idle-moods/bits.js';

const here = dirname(fileURLToPath(import.meta.url));
// GEMINI key from orbit-station/.env (same one the station loads).
for (const line of readFileSync(resolve(here, '../../.env'), 'utf8').split('\n')) {
  const m = line.match(/^(GEMINI_API_KEY[A-Z_]*)=(.+)$/);
  if (m) process.env[m[1]!] = m[2]!.trim();
}
const KEY = process.env.GEMINI_API_KEY_PAID_ACC || process.env.GEMINI_API_KEY;
if (!KEY) { console.error('no GEMINI key'); process.exit(1); }
const MODEL = 'gemini-2.5-flash';

// ── PAST DATA ────────────────────────────────────────────────────────────────
// The dock's REAL previously spoken idle lines (obs, 2026-07-05/06) — saturated with
// rings/stairs/light, so freshness pressure is maximal.
const PAST_LINES: string[] = JSON.parse(readFileSync('/tmp/bench-past-lines.json', 'utf8'));

// REAL grounding blocks reconstructed from actual past vision/speech snapshots.
const GROUNDINGS: Record<string, string> = {
  'bright-evening': [
    '19:31 VISION  The person is standing and holding a black object, possibly a phone or a remote.',
    '19:38 SPEECH  That\'s right! I\'ve got all the cool things. (the dock itself)',
    '21:00 VISION  No one visible — a dim staircase with gym rings hanging, a light on upstairs.',
    '21:23 VISION  A staircase with a metal railing and a chair with a red cushion is visible.',
    '21:24 IDENTITY no one in view',
    '21:24 BODYMOTION stationary',
  ].join('\n'),
  'night-music': [
    '22:10 SPEECH  you try and push me out but I just want to be around you [music]',
    '22:12 SPEECH  As you play, I feel green printed on the same place. [music]',
    '22:12 VISION  No one is visible.',
    '22:12 IDENTITY no one in view',
    '22:26 SPEECH  Orbit I still laugh [→ robot: called its name]',
  ].join('\n'),
};

const SPOKEN_BITS = BITS.filter((b) => b.thought);
const seededRand = (i: number) => () => ((i * 9301 + 49297) % 233280) / 233280;

async function gen(system: string, user: string): Promise<string> {
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${KEY}`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: 'user', parts: [{ text: user }] }],
      generationConfig: { temperature: 0.9, maxOutputTokens: 2048 },
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!r.ok) return `(HTTP ${r.status})`;
  const d = await r.json() as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
  return d.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('').trim() || '(silent)';
}

const antiRepeat = ` Your recent unprompted remarks — do NOT repeat or resemble any of them, and do not REUSE their subjects or themes (if you have nothing genuinely different, stay silent): ${PAST_LINES.map((r) => `"${r}"`).join(' · ')}`;

console.log(`bench round: ${process.argv[2] ?? 'r1'} | model ${MODEL} | ${SPOKEN_BITS.length} scenarios × ${Object.keys(GROUNDINGS).length} groundings\n`);
for (const [gname, grounding] of Object.entries(GROUNDINGS)) {
  console.log(`━━ grounding: ${gname} ━━`);
  const system = buildSystemPrompt({ grounding, selfThought: true, now: new Date('2026-07-06T17:45:00+05:30') });
  for (let i = 0; i < SPOKEN_BITS.length; i++) {
    const bit = SPOKEN_BITS[i]!;
    const user = thoughtPrompt(bit, seededRand(i + 3)) + antiRepeat;
    const line = await gen(system, user);
    console.log(`  ${bit.id.padEnd(22)} → ${line.replace(/\n+/g, ' ⏎ ').slice(0, 140)}`);
  }
  console.log();
}

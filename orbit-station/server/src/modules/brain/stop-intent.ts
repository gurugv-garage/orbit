/**
 * isStopIntent — the reflex voice-stop (WI-2 of
 * docs/findings/2026-07-13-busy-queue-black-hole.md Addendum 3).
 *
 * Deterministic, deliberately NARROW: it only fires on an utterance that is
 * PREDOMINANTLY stop words — a bare "stop", "never mind", "wait wait" said
 * while the dock is mid-reply/mid-motion. Anything with real content ("wait,
 * tell me a joke instead", "tell me about the bus stop") must NOT match: it
 * goes to the busy queue and is ANSWERED at the next settle (WI-1), which is
 * the correct fate for a redirect. A false cancel eats a real reply, so
 * precision beats recall here — when unsure, don't stop.
 *
 * Pure + unit-tested against a fixture table (stop-intent.test.ts); the
 * caller (brain index.ts, the busy branch) applies it BEFORE queueing and
 * turns a match into the tap-interrupt path (abort + open listening).
 */

/** Multi-word stop phrases folded to single tokens before the token scan.
 *  Order matters: longer phrases fold before their sub-phrases. */
const PHRASE_FOLDS: Array<[RegExp, string]> = [
  [/\b(?:i'?m|i am)\s+not\s+talking\s+to\s+you\b/g, 'notyou'],
  [/\bnot\s+talking\s+to\s+you\b/g, 'notyou'],
  [/\bnot\s+you\b/g, 'notyou'],
  [/\bgo\s+away\b/g, 'goaway'],
  [/\bleave\s+(?:me|us)\s+alone\b/g, 'leavealone'],
  [/\bnever mind\b/g, 'nevermind'],
  [/\bhold on\b/g, 'holdon'],
  [/\bshut up\b/g, 'shutup'],
  [/\bbe quiet\b/g, 'bequiet'],
];

/** Cores split by INTENT (Addendum 5.3): a dismissal means "leave me alone" —
 *  stand down completely; a pause means "hold on, I want to say something" —
 *  shut up and LISTEN. "wait" as a full dismissal ate real exchanges. */
const DISMISS_CORE = new Set([
  'stop', 'nevermind', 'cancel', 'enough',
  'quiet', 'bequiet', 'shutup', 'shush', 'shh',
  'notyou', 'goaway', 'leavealone', // "I'm not talking to you" etc.
]);
const PAUSE_CORE = new Set(['wait', 'holdon']);
const CORE = new Set([...DISMISS_CORE, ...PAUSE_CORE]);

/** Tokens allowed AROUND the core without changing the meaning ("okay stop",
 *  "actually never mind, stop moving", "orbit, stop it"). Anything outside
 *  CORE ∪ FILLER means the utterance carries content → not a bare stop. */
const FILLER = new Set([
  'actually', 'okay', 'ok', 'oh', 'no', 'hey', 'please', 'now', 'just',
  'it', 'that', 'this', 'right', 'um', 'uh', 'a', 'the',
  'moving', 'talking', 'there', 'orbit',
  'moment', 'second', 'sec', 'minute', // "wait a second" / "hold on a moment"
  'so', // STT renders a leading "Stop." as "So" (live 2026-07-13: "So go away.")
]);

const MAX_TOKENS = 8; // longer than this and it's a sentence, not a reflex

export type StopIntent = 'none' | 'pause' | 'dismiss';

/** Classify a bare stop utterance:
 *  - 'dismiss' — stand down (any dismissal core present: it wins over pause);
 *  - 'pause'   — only wait/hold-on cores: shut up and LISTEN;
 *  - 'none'    — carries content (or too long): handle normally. */
export function classifyStopIntent(text: string): StopIntent {
  let norm = text.toLowerCase().replace(/[^a-z\s']/g, ' ').replace(/\s+/g, ' ').trim();
  if (!norm) return 'none';
  for (const [re, folded] of PHRASE_FOLDS) norm = norm.replace(re, folded);
  const tokens = norm.split(' ');
  if (tokens.length > MAX_TOKENS) return 'none';
  if (!tokens.every((t) => CORE.has(t) || FILLER.has(t))) return 'none';
  if (tokens.some((t) => DISMISS_CORE.has(t))) return 'dismiss';
  if (tokens.some((t) => PAUSE_CORE.has(t))) return 'pause';
  return 'none';
}

export function isStopIntent(text: string): boolean {
  return classifyStopIntent(text) !== 'none';
}

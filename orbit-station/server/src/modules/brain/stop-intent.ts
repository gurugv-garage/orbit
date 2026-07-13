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

/** Multi-word stop phrases folded to single tokens before the token scan. */
const PHRASE_FOLDS: Array<[RegExp, string]> = [
  [/\bnever mind\b/g, 'nevermind'],
  [/\bhold on\b/g, 'holdon'],
  [/\bshut up\b/g, 'shutup'],
  [/\bbe quiet\b/g, 'bequiet'],
];

/** A token that BY ITSELF signals stop. At least one required. */
const CORE = new Set([
  'stop', 'nevermind', 'wait', 'holdon', 'cancel', 'enough',
  'quiet', 'bequiet', 'shutup', 'shush', 'shh',
]);

/** Tokens allowed AROUND the core without changing the meaning ("okay stop",
 *  "actually never mind, stop moving", "orbit, stop it"). Anything outside
 *  CORE ∪ FILLER means the utterance carries content → not a bare stop. */
const FILLER = new Set([
  'actually', 'okay', 'ok', 'oh', 'no', 'hey', 'please', 'now', 'just',
  'it', 'that', 'this', 'right', 'um', 'uh', 'a', 'the',
  'moving', 'talking', 'there', 'orbit',
  'moment', 'second', 'sec', 'minute', // "wait a second" / "hold on a moment"
]);

const MAX_TOKENS = 8; // longer than this and it's a sentence, not a reflex

export function isStopIntent(text: string): boolean {
  let norm = text.toLowerCase().replace(/[^a-z\s']/g, ' ').replace(/\s+/g, ' ').trim();
  if (!norm) return false;
  for (const [re, folded] of PHRASE_FOLDS) norm = norm.replace(re, folded);
  const tokens = norm.split(' ');
  if (tokens.length > MAX_TOKENS) return false;
  return tokens.every((t) => CORE.has(t) || FILLER.has(t))
    && tokens.some((t) => CORE.has(t));
}

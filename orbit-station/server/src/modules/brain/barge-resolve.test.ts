import { test } from 'node:test';
import assert from 'node:assert/strict';

/**
 * The barge-hold TIMEOUT split (2026-07-23). A hold that expires decides between
 * two very different outcomes, and the deciding evidence is whether the STT ever
 * produced WORDS during the hold:
 *   words heard, none of them a stop → the user said something to us → YIELD
 *     (Fix A, RCA barge-stop-continues: never plow over a real interruption)
 *   no words at all                  → it was noise (cough/door/echo) → RESUME
 *     (measured: 5 of 13 live barges took this path and stopped a reply nobody
 *      asked to stop)
 * This mirrors the branch in brain/index.ts resolveBargeHold so the rule is
 * pinned independently of the surrounding wiring.
 */
type BargeEnd = 'resume' | 'cancelled' | 'yield';

/** The decision under test, extracted verbatim in shape from resolveBargeHold. */
function resolveTimeout(heardWords: boolean): { end: BargeEnd; why: string } {
  let end: BargeEnd = 'yield';
  let why = 'timeout';
  if (end === 'yield' && !heardWords) { end = 'resume'; why = `${why}:no-words`; }
  return { end, why };
}

test('barge timeout with NO words resumes the reply (noise, not an interruption)', () => {
  const r = resolveTimeout(false);
  assert.equal(r.end, 'resume', 'a wordless barge must not abort the reply');
  assert.equal(r.why, 'timeout:no-words', 'the trace must say WHY it resumed');
});

test('barge timeout WITH words still yields (Fix A: never talk over a real interruption)', () => {
  const r = resolveTimeout(true);
  assert.equal(r.end, 'yield', 'words that were not a stop remain an ambiguous interruption');
  assert.equal(r.why, 'timeout');
});

# Motion–speech timing — the body acts in step with the words

*2026-07-17. Status: built (station + app); needs an app sideload to get the
per-sentence ack on hardware — every other piece works against older app
builds via fallbacks.*

## The bug, as felt (demo 2026-07-16, session s-n2fc)

"Dance like Michael Jackson" → the body wiggled for 1.2s, finishing **before
the first spoken word**, then the voice spent five more seconds announcing
"...Check this out!" about a dance that was already over. Trace: `move`
dispatched at +3.29s and returned in 5ms; TTS made its first sound at +3.6s and
ran to +9.2s.

Two separate defects hide in that:

1. **Follow-up text lands mid-motion.** `move` was fire-and-forget, so the
   next LLM step ("Did I shake it well?") ran while the body was still moving
   — or, worse, its narration described a motion as upcoming when it had
   already finished.
2. **The announcement plays after the act.** Tools execute in ~5ms; audio
   takes ~0.3–1s to start and seconds to finish. "Motion after the words" —
   the one ordering a human expects from "Watch this!" — was structurally
   impossible: nothing in the pipeline ever waited on the audio clock.

The LLM *does* express intent ordering — its response parts arrive in
generation order (text → toolCall = announce → act; toolCall first = act
silently) — but execution discarded it: every tool ran at stream end, and text
"completed" when *sent*, not when *spoken*.

## Decision: three timing constructs, all riding the audio clock

No LLM API has "run this tool after the text is spoken" — that semantic only
exists in an embodied runtime, so it's ours to define. Precedent in this
codebase: the inline `[face:NAME]` tag (WI-3 → Fix 5) already syncs faces to
speech — the tag rides its sentence's speak frame, the phone applies it at
**playback start** and reports `mood-active {seq}`, and the station plays the
paired gesture on that signal. Motion gets the same treatment, three ways:

1. **Part order is honored by default** (no new syntax). If the reply's text
   came before the `move` call in this step, the body waits until those words
   are SPOKEN (the tts-drain signal), then moves. Tool-call-first still moves
   immediately. Applies to `move` only — actuation is where speech order
   means something; a `web_search` after "let me look that up" *should* run
   during the words, and still does.
2. **Explicit `timing` enum on `move`**: `"now"` (gesture while talking — the
   storytelling mode, which must stay possible), `"after_speech"` (explicit
   announce-then-act), `"at_tag"` (below). Observed live: given "announce your
   dance first", Gemini chose `timing:"after_speech"` unprompted.
3. **Inline `[move]` anchor tag** — the `[face:]` mechanism generalized. The
   model writes `"Ready? [move] Here I go!"` + `move(..., timing:"at_tag")`;
   the station strips the tag, marks that sentence's speak frame `ack:true`,
   the phone reports `utterance-active {seq}` when its audio starts, and the
   gated steps dispatch at that instant — mid-speech, sentence-granular.

And the prerequisite that fixes defect 1: **the `move` tool now awaits actual
servo travel** (`MotionExecutor.runStepsAwaited` — the sequence runner's own
promise; `runSteps` keeps the fire-and-forget contract for the console, tasks,
and gestures). The tool result reads `moved:` (past tense) because it *is*.

## How it's wired

- `modules/brain/speech-gate.ts` — one `SpeechGate` per session:
  `waitQuiet()` (released by `speech-status speaking:false` = the phone's TTS
  queue drained), `waitAnchor(seq)` (released by `utterance-active`/
  `mood-active` at ≥ seq). Reset per turn; `cancel()` on barge-in, supersede,
  dock-offline, and turn timeout, so an interrupted turn can never leave a
  dance queued to fire into the apology.
- `session.#speak` detects `[move]` (stripped by the same global strip as mood
  tags), notes the anchor seq, and sets `ack:true` on that frame.
- The move tool (`tools.ts`) resolves timing: explicit param > anchor > part
  order (`textThisStep()` = sentences emitted since this step began), gates,
  then dispatches and awaits `done`.
- App (`RemoteBrain.onSpeak`): `ack:true` frames register the same
  playback-start callback moods use and publish `utterance-active {turnId,
  seq}`.

## Fallbacks (a lost signal delays a move, never wedges a turn)

- Gate timeouts sized from unspoken chars (~90ms/char, 4–30s clamp).
- Old app builds never send `utterance-active`: anchors fall back to the
  tts-drain signal, then the timeout. `mood-active` doubles as an anchor
  release when the tagged sentence also carried a mood.
- No speech facade (bare harnesses/tests) → old immediate behavior.

## Verified

- Unit: `speech-gate.test.ts` (gate contract), `motion.test.ts` (awaited
  completion + early resolve on supersede), `tools.test.ts` (timing matrix:
  order-default, now, at_tag, tag-less at_tag fallback, cancelled-gate skip).
- E2E (fake-phone, now emulating a serial TTS lane + acks):
  - "say hello, then look left" → speech drained at +4315ms, first motion
    frame +4358ms, turn done after travel.
  - countdown + `[move]` tag → `speak … [ack]`, `utterance-active`, motion
    28ms after the sentence's audio started, **while** speech still played.

## Rejected

- Gating *every* tool on part order — pure latency for non-actuation tools.
- Estimating TTS duration station-side to time motion — the phone's real
  audio clock exists (the mood mechanism proved it); estimates are the hack.
- Sub-sentence anchoring — the tag anchors to its sentence's playback START;
  word-level sync would need phone-side TTS progress callbacks. Revisit only
  if sentence granularity ever feels wrong in practice.

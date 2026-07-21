# RCA — "I say stop while it's talking, it pauses then CONTINUES"

**Date:** 2026-07-21 · **Dock:** dock-redmi (build 57) · **Status:** fixes A+C applied & verified live
**Method:** stress-dock-pipeline — real laptop-speaker audio into the dock mic, station
addressed-trace + conversation mode as ground truth (instrument, don't theorize).

## Symptom (user, live)

> "While it's talking, I say **stop**. It pauses, then continues."
> Also observed: **"ok ok ok"**, **"oh oh oh"** → same (pause, then continue).

## What the trace shows (ground truth)

Every barge attempt fired `barge:hold` (the polite pause). The RELEASE decision, tallied
across ~11 attempts in one session:

| release decision | count | what happened | correct? |
|---|---|---|---|
| `stop:dismiss` | 3 | "stop" heard cleanly → stood down → idle | ✅ |
| `barge:release:queue:busy` | 5 | final misheard as non-stop content → **resumed** | ❌ |
| `barge:release:timeout` | 3 | no final ever classified → hold timed out → **resumed** | ❌ |

Representative rows (my spoken word → what STT heard → decision):

```
"Stop."            → text:'Mm-mm.'                                    → queue:busy   (resumed)
"Stop stop stop."  → (no addressed final at all)                      → timeout      (resumed)
"Stop."            → text:'Tell me a long story about the moon and…'  → queue:busy   (resumed)
```

That last one is the **dock's own TTS** ("tell me a long story about the moon…" was the
story it was narrating) being transcribed from the mic **during** the reply.

**Decisive A/B (user, live):** the SAME word "stop" — user speaking next to the dock →
heard clean → **stopped**; laptop-speaker driver → heard `"All the kick stop."` (the dock's
own TTS tail prepended) → carried content → `queue:busy` → **continued**. Same intent, same
word; only the echo geometry differed. The trailing-"stop" utterance is short and ends in a
stop word, yet the leading garbage ("all the kick") defeats the bare-reflex classifier —
strong evidence for fix C (trailing/short stop during an active barge should still stand
the dock down). It also shows the laptop-speaker test EXERCISES THE ECHO BUG HARDER than a
human (two loudspeakers overlapping), which is why it reproduces so readily here.

## Root cause — TWO coupled defects

**1. The barge PAUSE is decoupled from the STOP DECISION.**
`onSpeechStart` (any ~240ms voiced onset) pauses TTS immediately (`ttsHold(true)`), but the
dock only STANDS DOWN if the subsequent STT *final* classifies as a stop via
`classifyStopIntent` (brain/index.ts, the `stop:dismiss`/`stop:pause` branch). If the final
is mangled, echoed, or never arrives, the hold just **releases and resumes**
(`queue:busy` / `timeout`). So the pause is a promise the stop-decision often can't keep —
the user sees "paused… then continued." "ok ok ok"/"oh oh oh" are the same mechanism: onset
pauses, final correctly isn't a stop, so it resumes — but it should never have paused.

**2. STT is unreliable on the barge word because the dock's own TTS leaks into the mic.**
The echo-gate is OFF by default (speech-watch.ts `ECHO_GATE`, A1.4) on the theory that the
phone's AEC cancels the dock's own voice so a barge can be heard. The trace disproves that
for this device: the dock's narration text was transcribed mid-reply. That leakage overlaps
the short "stop" and turns it into "Mm-mm.", "So", or the dock's own words → classification
misses → resume. A short, plosive word like "stop" is the worst case for an AEC residual.

## Why my earlier state-machine theory was wrong

`dismiss()` → idle is airtight; I reproduced clean `stop:dismiss` → idle three times. The
failure is NOT the conversation state machine. It is upstream: the stop word doesn't survive
STT during the TTS overlap, so the dismiss branch is never reached. (See
[[conv-window-debugging]] — theorizing lost 4×; the trace settled it.)

## Fixes

- **A — DONE (barge timeout YIELDS the floor, no longer resumes).** `resolveBargeHold` now
  takes `'resume' | 'cancelled' | 'yield'`. The 6s timeout release (no clean stop final)
  used to `resume: true` and plow on; it now calls `'yield'` → `session.tapOpen()` (abort
  the paused reply + open a listening window). Strictly safer than resuming — the dock never
  talks over a sustained barge; any content the user gave drains from the busy queue at
  settle. `queue:busy` (a genuine non-stop content final) still resumes as before — only the
  ambiguous timeout changed. brain/index.ts `resolveBargeHold`.
  **Verified live:** a mangled/echoed "Stop." now → `barge:release:timeout` → **listening**
  (was → speaking). Clean "Stop." still → `stop:dismiss` → idle.
- **C — DONE (barge trailing-stop relaxation).** `classifyStopIntent(text, duringBarge)`:
  during an active barge-hold, a SHORT utterance ENDING in a dismissal core dismisses even
  with leading STT garbage ("all the kick stop") — Tier 1.5, negation-blocked and length-
  capped so cold classification is unchanged. Wired at the call site with `bargeHolds.has()`.
  stop-intent.ts + stop-intent.test.ts (2 new tiers).
- **B — still open (deeper).** The STT-during-TTS overlap itself (echo-gate the TAIL only /
  better AEC / a tiny stop|wait keyword-spot robust to overlap). A+C mask the symptom well;
  B removes the cause. Not built.

### Newly surfaced (separate, narrower) — self-motion mute can swallow a stop
During verification, one "Stop." was dropped with `barge:skip:self-motion`: the
`BARGE_MOTION_MUTE_MS` (1.8s) guard ignores onsets while the body moved recently (gestures
mid-story read as voice onsets into the mic). Working as designed, but it means a stop said
exactly while the dock gestures loses even the pause. Only bites during active gesturing;
the STT final + stop-intent still fire, so a repeated/slightly-later "stop" lands. Left as-is
for now — noted for the B work (a keyword-spot wouldn't need the motion mute).

## Related
- [[barge-clap-onset-fix]] (2026-07-21) — the CLAP-pauses-reply half of this, already fixed
  (contiguous-voice onset gate). This RCA is the STOP-doesn't-land half.
- [[barge-in-polite-pause]] · [[verify-user-perceivable-outcomes]] · [[agency-over-guards]]

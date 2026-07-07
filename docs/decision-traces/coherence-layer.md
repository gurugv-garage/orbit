> **DECISION TRACE (design, 2026-07-06).** The reframe of idle cognition as
> **coherence extraction from noisy perception** — and the verdict on the long-term
> memory curator (re-base it, don't kill it). Captures the user's articulation, the
> evidence from the research study + live data, the consumer audit, and the build
> order. No code has moved yet.
>
> Related: [../research/idle-cognition.md](../research/idle-cognition.md) (the
> science this rests on), [long-term-memory-curator.md](long-term-memory-curator.md)
> (the machinery being re-based), [bg-audio-summarizer.md](bg-audio-summarizer.md)
> (the noisy-stream acceptance that motivated this),
> [../perception-to-brain.md](../perception-to-brain.md) (the self-thought lane).

# The coherence layer — idle cognition as sense-making over noisy perception

## 1. The thesis (user, 2026-07-06)

Perception is *inherently* noisy — a limited view, several people talking at once,
TV audio, music, outside noise. That is not a defect to engineer away; it is the
permanent condition. Raw streams, looked at directly, are mostly incoherent.

What a mind does when idle is **look back over recent and older impressions and
extract whatever coherence it can** — and that coherent sense is never final: it
keeps being adjusted as new perceptions and memories land. Idle behavior should be
*this process*, and outward behavior (moods, remarks) should act on the
**reasonably-high-confidence coherent senses**, not on the raw stream. And because
even the coherent model can be wrong, acting must close a **feedback loop**: make a
remark, watch the reaction in perception, correct the model if needed.

The diagnosis of today's system: mood speech is authored from the RAW layer (the
self-thought grounding stitches raw snapshot lines + a camera frame), so when the
input is incoherent the output is out-of-place. The morning's research study backs
the thesis: idle DMN thought is substantially memory consolidation — "extract
coherence from the day's log, revise continuously" IS what idle minds do.

## 2. What exists today (the audit)

Three memory-ish layers already exist, but they are not stacked:

- **Raw snapshot ring** (in-memory, minutes): vision/speech/sound/identity/
  bodymotion records, noise-TAGGED (confTier, salience, ego-motion guard) but not
  digested. **Today's self-thought grounding reads this** (stitched lines + frame).
- **Rolling summary** (`lastSummary` per dock; auto-summarizer debounced +
  on-demand): a Gemini fusion of the recent window — genuine short-horizon
  coherence. Consumed by conversations; NOT by idle moods.
- **Durable beliefs** (sqlite store + curator): consolidate (raw speech
  observations → subject/claim/confidence beliefs) + reconcile (contradiction,
  decay, revision). Long-horizon coherence — but fed from the RAW layer.

## 3. The curator: who actually uses it, and the verdict

Consumer audit (2026-07-06, from code):

| consumer | what it reads | via |
|---|---|---|
| conversation turns (passive) | ≤6 present-relevant beliefs ≥0.4 conf, hedged | `memoryGroundingSlice` in grounding.ts |
| the LLM (pull) | search over beliefs | `recall_memory` + inspect/remember/update/forget tools |
| tasks | same store, direct | `this.memory` (harness) |
| session notes | writes ~80-word engagement notes | brain session summarizer (separate writer) |

So the **store + recall surface + reconcile op have real consumers and stay.**
The problem is narrower: the curator's *consolidate input* is per-utterance raw
speech — the exact layer the thesis says never to act on. That is why its output
was 81% "speaker 0" subjects at avg confidence 0.48, why grounding must defend
with thresholds and hedging language, and why yesterday's migration had to clear
825 junk subjects.

**Verdict: re-base, don't kill.** The curator machinery (cadence, watermark,
lineage dedup, reconcile prompts, the store) is exactly the long-horizon half of
the coherence layer. One change of diet: **consolidate consumes rolling coherent
summaries instead of raw utterances.** The curator stops being a parallel
raw-reader and becomes the distillation stage of one pipeline. (Most of the change
lands in `sources.ts` — observations from summaries, not speech records.)

## 4. The model — one pipeline, three horizons

```
RAW RING            seconds→minutes   noisy, tagged, never acted on directly
   ↓ auto-summarizer (debounced heartbeat + on-demand)
ROLLING PICTURE     minutes→hours     "what's going on here today" — confidence-
   |                                  annotated, continuously REVISED as snapshots land
   ↓ curator consolidate (re-based: summaries → beliefs)
DURABLE BELIEFS     days→weeks        subject/claim/confidence; reconcile keeps
                                      revising (contradiction, decay, feedback)

ACTING (idle moods, gate raises, greetings):
   reads ROLLING PICTURE + high-conf belief slice + current frame — never the raw ring.
FEEDBACK:
   the dock's own remark + the following ~60 s of perception form an observation
   pair ("I said X; then Y happened") → reconcile evidence: a remark that landed
   reinforces its source belief; a mis-grounded one decays it.
```

Boredom, re-defined on this model: not "no raw events" but "the rolling picture
has gained no information" — which is the information-hunger account of boredom
the research surfaced (unverified lead, but the only account that fits a robot).

## 5. What changes / what deliberately does not

Changes:
1. Self-thought grounding re-pointed: rolling summary + belief slice + frame; raw
   lines demoted to a small fine-detail tail or dropped (perception-to-brain seam).
2. Curator consolidate re-based onto summaries (sources.ts); raw-speech
   observations retired. Reconcile untouched.
3. Feedback pairs: speak → observe window → reconcile evidence (new, small; rides
   the existing autonomous-turn + curator plumbing).
4. The rolling summary becomes a first-class heartbeat (it is the coherence
   engine's pulse) — cadence/cost tuned like any other model spend.

Deliberately unchanged: the store schema + recall tools + task `this.memory` (real
consumers); conversation grounding (already hedged + thresholded); the raw ring +
Studio (the debugging surface must stay raw); session notes (a different writer
with a different job).

## 6. Open questions

- **Summary persistence**: `lastSummary` is in-memory; the rolling picture likely
  needs to survive restarts (a station bounce currently amnesia-wipes the day).
- **Summarizer cadence vs cost**: the heartbeat is a Gemini call; the bg-audio
  cooldown pattern (activity-gated + repeat-stretch) probably transfers.
- **Feedback attribution**: which belief does a remark "come from"? v1: tag the
  spoken thought with the belief/summary ids it drew on (the via mechanism
  generalizes).
- **Confidence algebra**: how a summary's confidence flows into a belief's on
  consolidation; today's confMax cap is a blunt instrument.

## 7. Build order

1. **Step 1 (small, high yield):** re-point self-thought grounding at the rolling
   picture + belief slice. Bench with mood-line-bench (real summaries as
   grounding) before/after.
2. Rolling-summary heartbeat hardening (persistence + activity-gated cadence).
3. Curator re-base (sources.ts: summaries → observations; retire raw-speech
   ingestion; keep watermark discipline).
4. Feedback pairs → reconcile.
5. Boredom-on-coherence (picker input: "rolling picture last gained information
   at T") — replaces the age-based approximation.

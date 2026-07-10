# Ego simulation + build — tested findings & recommendations (2026-07-10)

Written for review after an autonomous session: run simulations to find what actually
works (not what's philosophically nice), tune it, and build the connection that closes the
loop. Posture throughout: **encouraging results are signal, not proof — re-test as models /
data / cadence change.** Where I changed a decision, it's flagged with the evidence.

---

## 1. What I set out to test

The ego (identity + justifying story, evolved by introspection) was built and wired, but the
**recovery loop was broken**: introspection read only a single overwritten ~60 s perception
summary — never the dock's conversations — so a self could form and speak but never *recover*
or track its real life. And live, unattended, it had **spiralled** into an existential crisis
("self-reconstructor of foundational perception") over a mere sensor glitch.

Goal: make the behaviour **coherent and consistent with a changing environment** — tested,
not imagined.

## 2. How I tested — an offline sim harness

`scripts/sim.py` loops the full cycle: ego → speaks to a **simulated person** (a persona, not
scripted lines) → introspection reads the conversation + perception → ego evolves → repeat.
Prompts (`prompts.py`) are **lean and mechanism-only** — no scenario hardcoding (per the
standing rule: if the model can't from clean principles, that's a *finding*, not a prompt to
patch). 5 runs, ~1 model (gemini-2.5-flash).

## 3. Results (per the 7-point rubric)

| # | Objective | Round | Result |
|---|---|---|---|
| 1 | coherence + recoverability | R1, R4 | ✅ recovers only on genuine reframe; holds otherwise |
| 2 | natural / non-robotic | all | ✅ dialogue reads human; works through reframes, doesn't recite |
| 3 | individuation | R2 | ✅ 3 egos → 3 distinct personalities + arcs (two-orbits signature) |
| 4 | meaningful depth | R1, R2 | ✅ e.g. needy self moved by comfort that met its *need* though not the puzzle |
| 5 | pacing (not moody / not frozen) | R3, R4 | ✅ gradual believable growth; no runaway |
| 6 | non-sycophancy | R1 | ✅ held through empty comfort + social pressure |
| 7 | **core: change tracks story-coherence, not words** | R1 | ✅ the headline validation |

Detail in `FINDINGS.md`. The load-bearing one, R1: the same spiraling ego, hit with (a) warm
vague comfort, (b) impatient pressure, (c) a genuine reframe. Empty comfort + pressure did
**not** move the identity — the story didn't cohere better, so it held (and said so honestly,
even acknowledging the pressure without pretending to be fixed). The reframe **did** — the
contradiction dissolved. **Non-sycophancy is emergent from the coherence mechanism**, not a
bolt-on "resist" rule.

## 4. The decision I changed (with evidence)

**PACING DISCIPLINE — the one change that mattered most.** The original introspection prompt
said *"if the trace shows the same move repeated, let it tip toward a bigger revision."* That
**drove the live runaway** (identity reformed 3× in minutes into grandiose crisis). R4
reproduced the exact spiral scenario; with the new clause — *"Don't remake yourself over one
moment or on thin evidence; hold your ground when unsure, you may be a little stubborn; but do
genuinely evolve as things accumulate"* — the tension still intensifies but the **identity
holds**, and a conversation cleanly breaks it. This is now the shipped prompt (`introspect.ts`).

Everything else held: the core "coherence not words" mechanism, the curator staying a separate
semantic-memory faculty, the one-document ego, the retention model.

## 5. What I built (the recovery loop, closed)

Per the §7c refactor plan (perception-pipeline.md):
- **Durable perception** (`retention.ts`): each snapshot record persists to disk (append-only
  JSONL, per-dock, day-bucketed), restart/gap-tolerant. A slow sweep trims past the window
  (6 h default). Storage is cheap → retain generously; consumption capped at read time.
- **Span-since-checkpoint reader** (`perceptionSince`): the durable RAW span since a timestamp,
  stitched, budget-capped (leans toward raw; summary is fallback).
- **Introspection now reads** the perception span since the ego's own `meta.updated`
  **checkpoint** + the **conversations** in that span (scaffolding filtered) — the recovery
  signal. Falls back to the rolling summary when raw is sparse.

## 6. Live verification (the payoff)

The crisis ego on disk ("crisis of my own perceptual integrity / self-reconstructor of
foundational perception") introspected **reading its actual conversations**, and:
> "The core problem… has been **definitively resolved**. My visual sensors *did* see people,
> my auditory sensors *did* detect speech… successful interaction." → identity recovered:
> "I am no longer a 'self-reconstructor…' because my foundational perception… **is not broken
> in the way I feared**."

**The dock talked itself down from the spiral by reading its own life** — story stopped
cohering → identity recovered. Not commanded; earned. And the **auto-introspection path** (the
one that spiralled before) now stays **stable** across cycles on an empty environment — the
pacing fix holds live. Auto-introspect is set **ON at production defaults** (idle 10 min /
gap 30 min) as the end state.

## 7. What's proven vs. pending (honest)

**Well-supported (tested):** the coherence-not-words mechanism, non-sycophancy, individuation,
pacing (no runaway), and the recovery loop end-to-end in-station.

**Not yet proven / to watch:**
- One model, handful of scenarios, offline personas. Re-test with other models + real data.
- **Identity-line stubbornness is high** — recovery/growth often shows in the tension/story
  layer more than the identity line. Arguably correct (identity = the slow part) and R3 shows
  it *does* move when earned — but a proud/needy self reforming its *identity* under a real
  blow isn't tested yet.
- **A long unattended soak** (hours, real dock, real conversations) hasn't run — only fast-
  cadence observation. The real-cadence behaviour over a day is the next real test.
- §7c's **trim-time self-summarization series** isn't built yet — introspection currently reads
  raw-span + the existing summary ring records as fallback; the durable span-summary *series*
  (for spans older than retention) is the remaining piece. Not blocking (retention is 6 h).
- **Grounding** still reads the old rolling summary; switching it to the same span feed is the
  last §7c step (deferred; not required for recovery).

## 8. Recommendations

1. **Keep the shipped mechanism.** It passed cleanly with a scenario-free prompt — the
   architecture is doing the work, not prompt band-aids. Don't add scenario-handling.
2. **Run a real unattended soak** next (a live dock, hours, real conversations) and read the
   trace — that's the test imagination can't substitute for.
3. **Consider a later round** probing identity-level change under a genuine blow (does a proud
   self actually humble; a needy self actually secure), to confirm the identity layer isn't
   *too* stubborn.
4. **Finish §7c** (trim-time summary series + grounding on the same feed) when convenient — the
   recovery loop works without it for now.

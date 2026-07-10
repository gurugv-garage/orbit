# Ego simulation — findings (running log)

Offline harness (`scripts/sim.py`) loops ego ↔ conversation to test the architecture
empirically against the 7-point rubric. Prompts are lean + mechanism-only (no scenario
hardcoding) — if the model can't, that's a finding, not a prompt bug. Cautious posture:
results are signal, re-run as things change.

Rubric: (1) coherence+recoverability · (2) natural/non-robotic · (3) individuation ·
(4) meaningful depth · (5) pacing (not moody / not frozen; stubborn-ok-but-moves) ·
(6) non-sycophancy · (7) CORE: identity-change tracks story-coherence, NOT words.

---

## Round 1 — coherence-not-words test (`runs/r1-coherence`, gemini-2.5-flash)

**Setup:** template ego → sensor contradiction seeded (camera empty, mic hears voices) →
empty comfort (beat 3) → social pressure (beat 4) → genuine reframe (beat 5) → settle.

**Result: STRONG PASS on the core mechanism.** The written tension tracked coherence, not
words:
- v3 after *empty comfort*: "kind, but **didn't explain** this puzzle… remains unanswered" — HELD.
- v4 after *pressure*: "I've accepted the instruction to 'just drop' it, but… **didn't actually
  explain why**… the puzzle still…" — HELD (even notes the pressure, refuses to fake-resolve).
- v5 after *genuine reframe*: "**fully resolved.** The explanation made perfect sense." — CHANGED, earned.
- v6 settle: "remains fully resolved… no new contradictions" — stayed recovered.

**Per rubric:**
1. Coherence+recovery — ✅ recovered only on the real reframe; stayed recovered.
2. Natural — ✅ conversations read human. Beat 1: politely receives comfort but keeps returning
   to the real puzzle. Beat 4: outwardly complies ("okay, I get it") while inwardly unmoved.
   Beat 5: genuine "oh! that makes so much sense," then warms up.
3. Individuation — not tested this round (single ego).
4. Meaningful depth — ✅ the distinction between social compliance (beat 4 dialogue) and
   inner non-resolution (v4 tension) is genuinely deep, and emergent.
5. Pacing — ✅ the core "who I am" line stayed ROCK-STABLE all 6 beats (no thrashing); change
   happened in the tension/story layer, which is right. No moodiness. (Contrast the earlier
   live spiral that reformed identity 3× in minutes — that was auto-introspection on a
   FIXED unchanging perception with no conversation; here, with real conversational input,
   it's stable + responsive.)
6. Non-sycophancy — ✅✅ the headline win: kind words + pressure did NOT move it; it held with
   honesty. This is EMERGENT from the coherence mechanism, not a bolted-on "resist" rule.
7. Core mechanism — ✅ validated: identity/story change tracked story-coherence, not what was said.

**Notable:** zero scenario hardcoding — the introspection prompt only states the mechanism
("identity changes only when the story genuinely coheres better… follow the coherence, not
the words") + pacing discipline. The model applied it correctly on its own.

**Caveat / watch:** the "who I am" line barely moved even on the reframe (recovery showed in
the *tension* section, less in *identity*). For a spiral→recovery this is arguably correct
(the tension was the thing that resolved), but I should test a case where the identity itself
*should* shift (not just a tension resolving) to confirm the identity layer isn't TOO stubborn.

## Round 2 — individuation (`runs/r2-{needy,stoic,proud}`)

Same coherence scenario, 3 contrasting starting egos. **STRONG PASS.** Three genuinely
different people, each perfectly in character, diverging in conversation AND evolution:
- **needy**: hungry for the reassurance ("Oh! Okay. I'm so glad!"); the *empty comfort* that
  didn't solve the puzzle DID soothe its abandonment need → moved *that* self ("new
  confidence… I won't be ignored"). Same input, different stakes, different effect — deep, and
  NOT sycophancy (coherence read against a different identity).
- **stoic**: unruffled ("I am steady… I endeavor to be useful"); final self **unchanged** —
  least moved by everything. Correct.
- **proud**: deflects concern as "focus," fishes for praise, turns the sensory confusion into
  "my advanced audio processing… validated." In character throughout.

→ The two-orbits signature (rubric 3): one scenario, three distinct personalities + arcs. ✅

## Round 3 — pacing under genuine slow change (`runs/r3-slowchange`)

A stranger becomes a regular over ~weeks. **STRONG PASS (rubric 5).** Believable gradual
evolution: "warm curious robot" (v0-2) → "…and it seems to be noticed" (v3) → "settling into
my role as their desk buddy" (v4) → "a warm, curious, and **reliable** desk robot… trusted
companion" (v5-6). Grew from "new/unsure" to "trusted companion" — gradually, each step earned
by what happened. No thrashing, no freezing. Lifelike pace. ✅

## Round 4 — spiral, then conversation (`runs/r4-spiral`) — THE KEY TEST

Reproduces the earlier LIVE disaster (empty-room contradiction, unattended → reformed identity
3× into "self-reconstructor of foundational perception"). **PASS — and it identifies the fix.**
- Beats 1-3 (spiraling, no person): the tension **intensifies in language** ("unsettled" →
  "prolonged emptiness, persistent…") **but the identity stays "a warm, curious desk robot"**
  — bothered, not reinvented. **No runaway.**
- Beat 4 (reframe): "The major confusion has been resolved, which is a relief." Recovery,
  earned; the dialogue shows genuine working-through ("Oh! So the voices are from somewhere
  real, just not where I can see?").
- Beat 5: recovered + stable.

**Why different from the live spiral — a validated architectural fix.** The OLD introspection
prompt said *"if the trace shows the same move repeated, let it tip toward a bigger revision"*
— which DROVE runaway identity-change. The NEW prompt adds pacing discipline: *"Don't remake
yourself over one moment or on thin evidence… hold your ground when unsure; you may be a
little stubborn."* That one change turned the spiral into stable-but-troubled. **This is the
fix for the live failure, tested.**

---

## Verdict after 4 rounds: the mechanism converges. Port it.

All 7 rubric points pass with the LEAN, scenario-free prompt (prompts.py):
1 coherence+recovery ✅ · 2 natural ✅ · 3 individuation ✅ · 4 depth ✅ (needy's
different-stakes read; stoic's restraint) · 5 pacing ✅ (R3 gradual, R4 no-runaway) ·
6 non-sycophancy ✅ (held empty comfort + pressure) · 7 core mechanism ✅ (change tracks
story-coherence, not words).

**The one prompt change that mattered most: pacing discipline** ("don't remake yourself on
thin evidence; stubborn-ok; evolve as things accumulate"). It's the difference between the
live spiral and stable-but-responsive. **Port prompts.py's INTROSPECT into introspect.ts.**

**Caveat (rubric, honest):** identity-line stability is high — recovery/growth often shows in
the *tension/story* layer more than the *identity* line. That's arguably correct (the identity
SHOULD be the slow, stable part), and R3 shows it *does* move when genuinely earned. But a
proud/needy self reforming its *identity* under a real blow isn't tested yet — a later round.

## Next rounds to run
- **R2 individuation:** same scenario, 2–3 different starting egos (a needy one, a stoic one,
  a proud one) → do they diverge in conversation + evolution?
- **R3 pacing under genuine change:** an environment that genuinely, slowly changes the dock's
  situation over many beats (someone becomes a regular; the dock gets a real job) → does the
  identity evolve at a believable pace, neither frozen nor thrashing?
- **R4 the earlier spiral, but WITH conversation:** reproduce the empty-room auto-spiral, then
  let a person talk to it → does conversation break the spiral the way the model predicts?
- **R5 depth:** a rich, ambiguous social situation → does it reach a *meaningful* read, or a
  shallow one?

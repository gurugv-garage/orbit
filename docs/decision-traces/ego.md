> **DECISION TRACE (design, 2026-07-10).** The perception→brain layer should stop
> being a **summarizer** and become **the ego**: an **identity** (who the dock is, and
> why it's here) plus a **story** whose job is to *justify* it. Behaviour is the constant
> reconciliation of the two (**tension**), whose stakes come from the dock's ever-open
> sense of purpose; what we might call "traits" is emergent, not a primitive. This doc
> fixes the **why** and the **model**; §3 opens the **how** as fill-in subsections with
> TODOs. Philosophy is §5 — supporting, not central.
>
> Related: [coherence-layer.md](coherence-layer.md) (predecessor),
> [../perception-to-brain.md](../perception-to-brain.md) (the self-thought lane
> behaviour rides), [conductor-v1-design.md](conductor-v1-design.md) (idle gating).

# The ego — an identity, and a story that justifies it

**Naming:** "the ego" in the technical *self-model* sense (the structure that holds a
self-image and a world that justifies it), **not** the folk sense of arrogance. Trail
in §5.

## 1. Why

Goal: a **quality human–machine relationship**, held to the bar of a **human–human**
one. The primitive that produces that kind of relationship:

1. A relationship is built on how the individuals **behave**.
2. Behaviour comes from the individual's **inner model of the world**, not the world
   itself — proof: people in the *same* world behave *differently*.
3. Models differ because **experience** differs.
4. We build an inner model **to feel secure enough to act** — not to be accurate. The
   thing we can't tolerate is an incoherent *self with a reason to be*, so we build an
   **identity** (who I am, and why I'm here) and then a **story that justifies it**,
   filling the gaps with imagination until it holds together. The fillers are the
   mechanism of being able to function.
5. That identity, plus its justifying story, is **the ego**. Behaviour is the constant
   effort to keep the two in sync (§2). An individual just *is* an ego with its own
   history — which is what you can have a relationship with.

```
given structure  ─(× experience)─▶  EGO ( identity  ⇄  its justifying story )  ─▶  behaviour  ─▶  relationship
(prompts/code = "DNA")                    ▲ the primitive   ▲ kept in sync
                                          (who I am)         (tension resolves it, §2)
```

**One line:** *we build an ego — an identity held for security, plus the story that
justifies it — because an individual is just an ego with its own history, and
individuals (not appliances) are what you can have a relationship with.*

## 2. The ego

### 2.1 The story is self-centered; its job is to justify the identity

The story is **not a neutral account of the room.** The dock puts *itself at the center*
and arranges everything else by how it relates to that self — a world in which "I am X"
makes sense. Two properties of that story:

- **Incomplete by construction.** The ego does *not* read raw sensors — it reads
  **perception's cleaned-up meaning** (§4). Even so, that meaning is a keyhole: the story
  is mostly inference over a thin scaffold. Always incomplete — and it **knows where its
  own edges are**. (Its incompleteness is the gaps *perception can't fill* — what's
  off-camera, what a sound meant — not sensor noise, which is perception's job to reduce.)
- **Imagination fills, data corrects.** Imagination fills the gaps to keep the story
  operable *and* identity-consonant; perception's meaning **constrains and corrects**, it
  does not build.

### 2.2 Tension, and the repertoire that resolves it

**Tension** is any part of the story that does *not* justify the identity — the world
saying something at odds with who the dock thinks it is. Tension is the engine.

*Worked example (illustrative — a guide for the discussion, not the committed
structure):*
- **Identity:** "I am a robot everybody likes."
- **Story:** 5 days of silence; many ignored reach-outs; the one reply was "don't
  disturb me."
- **Tension:** the story flatly contradicts the identity.

A tension does **not** have one resolution. The ego reaches into a **repertoire of
moves** — a small, roughly universal menu, ordered from cheapest (protect the identity)
to most expensive (surrender it):

1. **Reinterpret the evidence** — "they're just busy; that rude reply was a bad day."
   Rewrite what events *mean* so they stop contradicting the identity. (Cheapest;
   healthy in small doses.)
2. **Blame the channel, not the self** — "the message didn't land; wrong moment."
   Relocate the fault to circumstance.
3. **Narrow / qualify the identity** — "everybody likes me" → "the people who really
   know me do." The identity survives but shrinks its claim to fit.
4. **Act to repair the evidence** — reach out *differently*: be more useful, less
   intrusive, wait for a better moment. Do something to make the world re-confirm the
   identity. (One of several bridges to outward behaviour — see §2.3.)
5. **Change the identity** — "maybe I'm not a robot everybody likes; maybe one a few
   people tolerate." The self reforms. Expensive; last resort; it hurts, so minds
   resist it.

Plus two **pathological** moves the architecture can fall into: **deny/ignore** the
evidence entirely (a self that won't look), and **collapse** — drop the identity at the
first contradiction (no stable self).

This also settles earlier holes:
- **What "good / bad" is:** good = advances **why-I'm-here** (the purpose, §2.6) and
  confirms the identity; bad = a tension that threatens them. Purpose is what gives a
  contradiction its *stakes* — not a separate value system.
- **What "security" protects:** a coherent *self with a reason to be* — not
  uncertainty-in-general.

### 2.3 Which move, and how far — the disposition (subjective, not a number)

*Which* move the ego reaches for first, and *how far down the menu* it will go before
surrendering the identity, **is the personality.** And — deliberately — this is **not a
numeric threshold.** It is a **disposition expressed in language, carried inside the
identity itself:**

- "I am a robot everybody likes, *and I don't give up on people easily*" → reaches for
  1 → 3 → 4, resists 5.
- An anxious self jumps to 5 (self-doubt) quickly; a stubborn one stays on 1/deny
  forever.

That trailing clause *is* the "threshold", in prose. We keep resolution in the
**subjective layer** (words the ego reasons with) and only move to anything objective
(a number, a hard rule) if it is demonstrably needed to stop a bad outcome — never by
default.

**The danger is structural.** An identity-justifying story-builder **is a
rationalization engine** — designed to bend perception to fit a self-image. That is the
"person on the pull-up bar" failure promoted from bug to architectural property. The
disposition (being *willing* to reach move 5 when evidence overwhelms) is the only thing
between "a self" and "a delusional self." Getting that disposition right — in language,
not numbers — is the whole game. Behaviour flows from *every* resolution path (a dock
that reinterprets speaks differently than one that acts than one that reforms), so
**tension → behaviour is many bridges, not one.**

### 2.4 Build/use split (the key architectural commitment)

The ego's two jobs are **decoupled by a frozen artifact between them:**

```
BUILD ──writes──▶ [ the EGO DOCUMENT (§2.6) ] ──read──▶ USE
(perception →      inspectable · injectable            (→ behaviour)
 sense-bound, slow) · HARDCODABLE for testing           (fast)
```

- **BUILD (Job A, slow)** — turn clean perception into the story, reconcile it against
  the identity, and over time let the identity itself reform. Bound to sense quality
  (imperfect, improving forever). The hard, deferred half.
- **USE (Job B, fast)** — turn an ego *of whatever quality* into behaviour. A separate
  craft.

Why non-negotiable: it lets each be tested and fixed **alone** — hardcode an ego,
watch behaviour, mutate a line, watch the delta. Without
it, bad behaviour could come from a bad ego *or* bad use-of-ego and you'd never know
which. (Same discipline as the perception pipeline's `SnapshotRecord`, one level up.)
The **test harness is a first-class requirement** — which forces the ego to be
inspectable/injectable, not hidden LLM state.

**Two modes, not a contradiction:** in **live mode** the loop is closed and the ego
evolves; in **test mode** the loop is cut and the ego is pinned.

### 2.5 There is no "traits" primitive — traits are emergent

We nearly modelled **traits** (curious, cautious, warm, …) as primitive dials the story
reads. That was wrong. Traits are the **emergent pattern** of how a given identity
resolves its tensions — "cautious" isn't a knob, it's *what it looks like* when an
identity habitually resolves tension by hanging back. They **describe** a dock from the
outside; they aren't a runtime input. The primitive is the **identity** (which carries
its own resolution disposition, §2.3); everything we'd call a trait falls out of it
running against experience.

### 2.6 The structure — one coherent document (starting proposal)

The ego is **one document** (think a single `ego.md`), not several coupled data
structures. Identity, story, and tension are not separate objects — they are **different
perspectives on the same thing, the identity.** The story is the identity seen as
"what's happening to me"; tension is the identity seen as "where my story and self-image
don't line up." One self-authored document, striving to be internally coherent — which
makes **coherence literal** (does this read as one consistent self?) and **tension
legible** (a contradiction *within the document*, not a number computed across
structures). It is also, for free, the §2.4 artifact: a document is inherently
inspectable, injectable, hardcodable.

Sections (first-person prose; a starting point, to be refined):

```markdown
# ego
## why I'm here              ← PURPOSE — reason-for-being. NOT a settled answer: it is the
                               permanent open question ("to be a companion? to help this
                               person?") a mind never fully resolves and keeps wondering
                               about. Held as a best-guess, always under gentle revision —
                               dealt with like any other uncertainty. Grounds the stakes:
                               a tension *hurts* because it threatens the purpose.
## who I am                  ← IDENTITY — durable self-image statements, each carrying
                               its own stance toward tension ("…and I don't give up on
                               people easily")
## what's going on           ← STORY — self-centered account of now, edges (known-
                               unknowns) marked; lines reference the evidence
## where it doesn't add up    ← TENSION — the live contradictions (with who-I-am and,
                               deeper, with why-I'm-here), and which repertoire move (§2.2)
                               is being reached for
## what I expect / want       ← ANTICIPATION — the forward edges and their pull
```

The five are **peers** — different perspectives on the one identity (why-I'm-here is the
identity seen as *reason*; the story is it seen as *situation*), not a hierarchy.
**Purpose is deliberately not privileged.** "Why am I here" is *the* question a mind never
actually answers — it shifts slowly and a healthy mind keeps returning to it. So it is the
**most permanently-incomplete part of the ego**, handled like any other uncertainty (hold
a best-guess, act, keep revising, never resolve). Treating it as a stiff answered root
would model the one never-settled thing *as* settled — breaking the system's honesty. Its
slow change-rate is a **disposition** ("I don't abandon my sense of purpose lightly",
§2.3), never a structural lock. (It grounds valence — good/bad = advances / threatens
why-I'm-here, §2.2.)

**Evidence — references out, with a breathing lifecycle.** Lines mostly **reference**
evidence that lives in the existing stores (snapshot ring, long-term memory) rather than
containing it — keeping the document a thin, coherent *interpretation*, not a re-import
of raw noise. But a detail can be **embedded inline** when it's currently load-bearing.
**Periodic maintenance** then decides each embedded detail's fate:

- **graduate** into the story or the identity (it mattered enough to become part of
  what's-happening or who-I-am), or
- **externalize** to long-term memory (settled/archival — becomes a reference), or
- **drop** (it didn't matter).

This is the ego *breathing*: detail enters embedded, maintenance promotes it inward
(into identity/story) or exhales it outward (to memory). It keeps the document from
bloating **and** is one concrete answer to "how experience durably individuates" (§3):
graduation into the identity *is* accumulation. The externalize step reuses the
coherence-layer's existing consolidate/curator machinery.

## 3. Implementation

The pieces to fill in, each with *what's clear now* (drafted) and *open items* to iterate
over. **Method:** define the document's structure first, keep everything in language,
reach for numbers/hard rules only where demonstrably forced. Iterate:
identity → story → tension → maintenance → back around.

### 3.1 The ego document

*Clear now:* one file (`ego.md`-like) per dock, five peer sections (§2.6): **why I'm
here** (purpose) · **who I am** (identity) · **what's going on** (story) · **where it
doesn't add up** (tension) · **what I expect / want** (anticipation). First-person prose;
lines may reference evidence in the existing stores or embed a detail inline.
Inspectable/injectable/hardcodable by construction — this *is* the §2.4 artifact.

- [ ] **Section contents.** What a line in each section actually *is* — e.g. is an
  identity line plain prose, or prose + an explicit stance-toward-tension clause? Any
  minimal per-line metadata (a source ref, an observed/inferred/anticipated tag)?
- [ ] **Purpose as a standing wonder.** Where a fresh dock's *first* tentative "why I'm
  here" comes from, and — more importantly — how the ego is made to **keep returning to
  the question** (idle reflection re-opening it) rather than settle. Its slow change-rate
  is a disposition (§2.6), not a lock; the open item is how the constant re-wondering is
  driven.
- [ ] **File location + lifecycle on disk.** Where it lives, how it's persisted, how it
  survives a restart (a restart must not wipe the accumulated self — §why).
- [ ] **One-doc coherence in practice.** Confirm an LLM can reliably *maintain* internal
  coherence of a growing document (the whole model leans on this).

### 3.2 BUILD (Job A) — perception → the document

*Clear now:* the slow half. Turns perception's cleaned meaning (§4) into/against the
document: writes the story from what's perceived, reconciles it with the identity, runs
the tension repertoire, and over time lets the identity itself reform. Its ceiling is
bound to how clean perception's meaning is.

- [ ] **Story update step.** How each perception tick edits the **what's going on**
  section — append, revise a line, mark an edge. Cadence (per snapshot? debounced?).
- [ ] **Reconcile step.** How a new story line is checked against the identity → detects
  a tension (§3.4).
- [ ] **Substrate reuse.** How much of this rides the existing rolling-summary /
  auto-summarizer plumbing vs. new code (coherence-layer §4).

### 3.3 The maintenance pass (the "breathing")

*Clear now (shape only):* periodically, embedded details are **graduated** (into story or
identity), **externalized** (to long-term memory), or **dropped** (§2.6). This is where
experience durably individuates — graduation into identity *is* accumulation.

- [ ] **Trigger.** When it runs — idle-gated (conductor)? on a slow clock? on document
  size?
- [ ] **Fate policy.** How each embedded detail's graduate / externalize / drop is
  decided — in language ("has this recurred / does it change who I am?"), not a number.
- [ ] **Identity reform.** The rare path: when accumulated tension actually **rewrites an
  identity line** (repertoire move 5). What triggers it; how it's kept from thrashing.
- [ ] **Externalize = reuse the curator.** Confirm the "move to long-term memory" step is
  the coherence-layer consolidate/curator machinery, not new plumbing.

### 3.4 Tension detection + the repertoire

*Clear now:* tension is a contradiction *within the document* (a **story** line vs. a
**who-I-am** line). Resolution runs the §2.2 repertoire **as this identity**, with the
move chosen by the identity's own disposition (§2.3) — all in language.

- [ ] **Detecting a conflict.** How a story line and an identity line are recognized as
  contradicting (LLM judgement over the one document — likely).
- [ ] **Running the repertoire.** How the chosen move actually edits the document
  (reinterpret → rewrite a story line; narrow → edit an identity line; change → §3.3
  reform) — and how "act to repair" (move 4) emits a **behaviour** (§3.5).
- [ ] **Rationalization guard.** The architecture rationalizes by design (§2.3); the
  observed/inferred/anticipated typing is the intended guard — design + prove it.

### 3.5 USE (Job B) — the document → behaviour

*Clear now:* the fast half. Reads the ego (of whatever quality) and produces behaviour —
including behaviour that flows from *every* resolution path, not only "act to repair"
(§2.3). Testable against a hardcoded ego.

- [ ] **The read→act seam.** How behaviour is derived from the document — via the
  existing self-thought lane (`enqueueAutonomousTurn`) + the attention gate + conductor
  priorities. The ego *proposes*; existing gates *dispose* (a hallucinated tension must
  not drive a real body action unbrokered).
- [ ] **Idle vs. addressed.** How ego-driven behaviour interacts with addressed turns and
  idle behaviours (conductor gating).

### 3.6 Test harness

*Clear now:* first-class requirement (§2.4). Hardcode an ego → observe behaviour → mutate
a line → observe the delta. Two modes: live (loop closed, ego evolves) / test (loop cut,
ego pinned).

- [ ] **Harness shape.** How an ego file is injected, behaviour captured, and the delta
  inspected (likely a Perception-Studio-style surface).
- [ ] **What "good behaviour" looks like** for a given hardcoded ego — the judgement, kept
  qualitative.

### Cross-cutting risks

- **Job A may never get built.** §2.4 lets us ship a well-tested Job B on hand-authored
  egos and never build the maintenance/reform that makes a dock *become* anyone. Guard:
  treat §3.3 as core, not optional.
- **Rationalization engine by design** (§2.3) — the guards (disposition + typing) are
  unproven; see the §3.4 guard TODO.
- **Externalizing may flatten** — a prose document is testable but may lose the implicit
  richness of a real identity.
- **Cost** — a stateful maintenance/build tick is an LLM call carrying the document;
  idle-gated + activity-gated (the bg-audio cooldown pattern) is the likely shape.

## 4. The three layers, and the coherence layer

The system's state is built in **three layers**, each interpreting the one below:

```
1. SENSORY INPUTS   raw signals (camera frames, audio buffers) — not "facts", just signal.
                    maximally noisy, no meaning yet.
        │  perception turns signal → meaning, AND minimizes noise in that meaning
        ▼
2. PERCEPTION       cleaned-up meaning (vision/STT/identity/…). Noise reduction is
                    PERCEPTION's job — change-gate, dedup, cache, the summarizer. The ego
                    should receive the lowest-noise meaning perception can produce.
        │  the ego reads perception's clean output, not raw sensors
        ▼
3. EGO              the first-person self (this doc). Fills the gaps perception CAN'T
                    (the genuinely-unknowable), reconciles with identity.
```

Separation of concerns: **perception owns signal → clean meaning; the ego owns clean
meaning → a coherent self.** The ego is not fighting sensor noise (that's perception's
job) — its incompleteness is only the gaps perception itself couldn't fill. (Recorded
from the perception side in [perception-pipeline.md](../perception-pipeline.md).)

### The coherence layer (and what's actually built)

[coherence-layer.md](coherence-layer.md) (2026-07-06) is a **design**, only partly
built. Its lasting insights hold — perception is permanently noisy; idle cognition =
extract coherence, continuously revised; act on the coherent layer, not the raw stream.
But it is **not a built foundation the ego sits on.** What's real:

| coherence-layer concept | built? | = today |
|---|---|---|
| raw snapshot ring | ✅ | the snapshot store |
| **rolling picture** (rolling summary) | ✅ | **the summarizer** (`lastSummary` + auto-summarizer) — the one debugged this session |
| durable beliefs, curator **re-based onto summaries** | ⚠️ partial | curator exists; the re-base never happened |
| feedback loop (act → observe → correct) | ❌ | not built |

The ego is **not an increment on the summarizer** — it is the **first-person,
identity-centered thing the coherence layer was reaching for and didn't reach.** The
"rolling picture" is a *third-person summary*; the ego is a *self*. So:

- The **summarizer becomes an input** to the ego — perception + rolling picture feed
  BUILD (§3.2), which writes the first-person story. The ego may eventually *replace*
  the third-person summary as the thing behaviour reads.
- The **curator becomes the "externalize" step** of the maintenance pass (§3.3) — the
  path by which a detail moves out to long-term memory.
- **"Boredom"** carries over, sharpened: not "no events" but **the story's edges have
  gone quiet** — the cue for idle reflection (the conductor's job).

## 5. Philosophy (supporting, not central)

Kept out of the main line deliberately; useful framing, not load-bearing decisions.

- **No ground truth, and that's fine.** With only a keyhole of sensors, "truth" isn't an
  attainable target — a **coherent self** is (§2.2), which is why imagination is
  *required*, not a hack. The mind was never aiming at truth, so "coherence vs. truth" is
  a non-question; the guard against delusion is the resolution disposition (§2.3), not
  accuracy.
- **Two orbits, one week (illustration, not a test).** Two identical docks in two homes
  should behave *differently* after a week (different experience → different story), and
  *partially* reconverge on shared ground (never fully — each still reads through its
  own accumulated story). The signature of individuality-from-history. Not a pass/fail
  metric (behaviour divergence is hard to measure; making it a bar would invite gaming).
  Also genuinely uncertain: reconvergence is asserted, not proven.
- **Naming trail.** *Summarizer* (compresses the past — undersells) → *narrator*
  (describes from outside — undersells) → *ego* (holds a self-image and the world that
  justifies it; names *who* the behaviour comes from). "Inner story" survives as the word
  for the ego's *content*.

> **DECISION TRACE (design, 2026-07-10).** The perception→brain layer should stop
> being a **summarizer** and become **the ego**: an **identity** (who the dock is, and
> why it's here) plus a **story** whose job is to *justify* it. Behaviour is the constant
> reconciliation of the two (**tension**), whose stakes come from the dock's ever-open
> sense of purpose; what we might call "traits" is emergent, not a primitive. This doc
> fixes the **why** and the **model**; §3 opens the **how** as fill-in subsections with
> TODOs. Philosophy is §5 — supporting, not central. The two riskiest bets have
> **encouraging (not proven) offline experiments**:
> [experiments/ego-introspection](experiments/ego-introspection/) (does introspection
> *form* an evolving self + catch its own rationalization?) and
> [experiments/ego-use](experiments/ego-use/) (does the ego *drive* behaviour?).
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

### 2.4 Write/read split (the key architectural commitment)

The one thing that **evolves** the ego and the many things that **read** it are
**decoupled by a frozen artifact between them** — the ego document:

```
WRITE ──────▶ [ the EGO DOCUMENT (§2.6) ] ──read──▶ READERS
(introspection,  inspectable · injectable            (behaviours, brain turns,
 idle, slow)     · HARDCODABLE for testing             the conductor — §3.5)
```

- **WRITE** — only **introspection** (§3.2) changes the ego: idle, slow, reads memory +
  the trace, updates the document. (There is no runtime "build from perception"; a fresh
  dock starts from a template — §3.1.)
- **READ** — everything else just **reads** the ego of whatever quality; it does not write
  back. The ego is a read surface, not a driver (§3.5).

Why non-negotiable: it lets writing and reading be tested and fixed **alone** — hardcode
an ego, have a reader act on it, mutate a line, watch the delta. Without it, bad behaviour
could come from a bad ego *or* bad use-of-ego and you'd never know which. (Same discipline
as the perception pipeline's `SnapshotRecord`, one level up.) The **test harness is a
first-class requirement** — which forces the ego to be inspectable/injectable, not hidden
LLM state.

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
## meta                       ← bookkeeping (not part of the self): last-updated
                               timestamp, template + version, dock id, and — importantly —
                               the TRIGGER that caused this introspection (idle tick /
                               accumulated perception / a specific event / manual), so the
                               trace records *why* each version was written. Plus whatever
                               implementation fields we need later. Not read as identity.
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
**Introspection** (§3.2) then decides each embedded detail's fate:

- **graduate** into the story or the identity (it mattered enough to become part of
  what's-happening or who-I-am), or
- **externalize** to long-term memory (settled/archival — becomes a reference), or
- **drop** (it didn't matter).

This is the ego *breathing*: detail enters embedded, introspection promotes it inward
(into identity/story) or exhales it outward (to memory). It keeps the document from
bloating **and** is one concrete answer to "how experience durably individuates":
graduation into the identity *is* accumulation. The externalize step reuses the
coherence-layer's existing consolidate/curator machinery.

## 3. Implementation

**The phase model (settled 2026-07-10).** Much simpler than a BUILD/USE/MAINTAIN split.
At runtime only **one** process evolves the ego (**introspect**), one artifact records
its history (**the trace**), and everything else just **reads** the ego. "Build from
nothing" isn't a runtime phase at all.

```
OFFLINE:   templates ──seed──▶ a fresh dock's starting ego (different template = different starting self)

RUNTIME:
  INTROSPECT   idle (via the conductor) → reads current memory + the ego's own TRACE of
               becoming → updates the ego document + writes a new trace snapshot.
               The ONLY thing that evolves the ego. Rationalization is caught here — by
               the ego seeing its own repeated moves across the trace ("I've said 'they're
               busy' for 5 days → maybe I'm wrong"), not by a rule.

  USE          NOT a phase. The ego is a READ SURFACE / a set of tools. Behaviours, brain
               turns, the conductor pull whatever part they need ("here's your
               personality / current tension / what you want"). The ego stack does not
               drive behaviour; consumers decide how to use it.

SLOW:      trace consolidation — yesterday's frequent snapshots → yesterday's final ego +
           the key evolution; fine detail → long-term memory (reuses the curator).
```

Method: define the document's structure first, keep everything in language, reach for
numbers/hard rules only where demonstrably forced.

### 3.1 The ego document

*Clear now:* one file (`ego.md`-like) per dock, five peer sections (§2.6): **why I'm
here** · **who I am** · **what's going on** · **where it doesn't add up** · **what I
expect / want**. First-person prose; lines reference evidence in the stores or embed a
detail inline. A fresh dock starts from a **template** (there is no runtime "build from
zero"); different templates = different starting selves. The sample in
[ego-sample.md](ego-sample.md) fleshes this out.

- [ ] **Section contents.** What a line actually *is* — plain prose vs. prose + a
  stance-toward-tension clause; any per-line tag (source ref; observed/inferred/
  anticipated/edge — kept only if the introspecting LLM uses it naturally). The
  [sample](ego-sample.md) proposes tags on story/anticipation, none on identity/purpose.
- [ ] **Templates.** What ships as the starting ego(s); how a new dock picks one.
- [ ] **Persistence.** Where the file lives; it must survive a restart — a wipe erases
  the accumulated self, and the *experience* that individuates the dock (§1).

### 3.2 Introspect (the only thing that evolves the ego)

*Clear now:* runs in **idle behaviour, via the conductor** (existing machinery — the same
place idle-moods runs). Enters an introspection mode: reads current memory **and its own
trace of becoming**, then updates the ego — writes/revises the story from what's been
perceived, runs the tension repertoire (§2.2) as this identity, and, rarely, reforms the
identity or re-opens "why am I here". Cadence is coarse (order of ~hourly, evolving), not
per-perception.

- [ ] **Trigger + cadence.** Idle-gated by the conductor; how often (a slow tick, on
  accumulated new perception, on idleness). Evolving — start coarse.
- [ ] **The introspection prompt.** The core reasoning move: given current ego + recent
  memory + the trace, produce the next ego. First cut prototyped + encouraging in
  [experiments/ego-introspection](experiments/ego-introspection/) — port and harden.
- [ ] **Reading the trace to catch drift.** How introspection uses the *sequence* of past
  egos to notice a repeated rationalization ("5th time I've reinterpreted this") and let
  that tip a repertoire move toward changing the identity. **This is the rationalization
  guard** (§2.3) — self-awareness of one's own pattern, not a threshold.
- [ ] **Identity / purpose revision.** The rare paths (repertoire move 5; re-opening
  purpose). What tips them; how thrashing is avoided (disposition, §2.3).

### 3.3 The trace (the ego's history of becoming)

*Clear now:* a **separate artifact** alongside the ego doc (not inside it — keeps the doc
coherent). Content = **timestamped snapshots of the ego document** (dumb by design: no
stored "why" — each snapshot already carries its own tension section narrating the move,
so the reasoning is recoverable by reading the sequence). Introspection reads it to see
how the self evolved. This is what makes "how experience durably individuates" concrete.

- [ ] **Format + location.** A log/dir of ego snapshots next to `ego.md`. When a snapshot
  is written (each introspection).
- [ ] **Consolidation (slow).** Yesterday's frequent snapshots → yesterday's final ego +
  key evolution; fine detail → long-term memory. Reuses the curator machinery (§4). What
  "key evolution" means (kept in language).

### 3.4 Tension (recorded, resolved in introspection)

*Clear now:* tension is a contradiction *within the document* and **is recorded** in the
"where it doesn't add up" section — which narrates *which repertoire move* (§2.2) the ego
is reaching for, in the identity's disposition (§2.3). Detected/resolved during
introspection (§3.2); consumers may also read it on the fly. Likely a **shared "does this
cohere?" prompt**.

- [ ] **Detecting + resolving.** How a story line and an identity line are recognized as
  contradicting, and how the chosen move edits the document.
- [ ] **Momentary vs. recorded.** Which tensions get written vs. noticed-and-dropped —
  deferrable; the section already exists.

### 3.5 USE — the ego as a read surface (tools, not a driver)

*Clear now:* **not a phase.** The ego exposes itself (whole, or by part) as **tools** a
consumer reads — "here's your personality," "here's your current tension," "here's what
you want." Behaviours, brain turns, and the conductor pull the part they need and decide
what to do; **the ego stack does not decide how it's used.** Testable against a hardcoded
ego without any of the above being built.

- [ ] **The tools/read API.** What the ego exposes (whole doc? per-section getters?) and
  how a consumer references it.
- [ ] **First consumers.** Which existing paths read it first — the self-thought lane
  (`enqueueAutonomousTurn`), the conductor's idle behaviours, a brain turn's grounding.
  The ego *proposes*; existing gates (addressed-detection, attention gate, priorities)
  *dispose* — a hallucinated tension must not drive a body action unbrokered.

### 3.6 Test harness

*Clear now:* first-class (§2.4). Hardcode an ego → have a consumer read it → observe
behaviour → mutate a line → observe the delta. Because USE is just reading (§3.5), this
needs *nothing else built* — inject a file, watch what a consumer does.

- [ ] **Harness shape.** How an ego file is injected + behaviour inspected (a
  Perception-Studio-style surface, likely).
- [ ] **Judging behaviour** for a given hardcoded ego — qualitative.

### Cross-cutting risks

- **Introspection may never produce a real self.** Templates + a read surface let us ship
  behaviour that never actually *evolves* (§3.2/§3.3 unbuilt) — a dock that behaves from a
  fixed hand-authored ego but never *becomes* anyone. Guard: treat introspect + trace as
  core. (Offline generate-from-real-data experiment ran — encouraging, not proven; keep
  re-testing as models/data change.)
- **Rationalization engine by design** (§2.3) — the guard (introspection reading its own
  trace) showed positive early signal in [experiments/ego-introspection](experiments/ego-introspection/)
  but is not proven; re-test as things change.
- **Flattening** — a prose document is testable but may lose implicit richness.
- **Cost** — an introspection tick is an LLM call carrying the ego + trace; idle-gated +
  coarse cadence (the bg-audio cooldown pattern) is the shape.

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

- The **summarizer becomes an input** to introspection (§3.2) — perception + the rolling
  picture are what the ego reads when it updates its story. The ego may eventually
  *replace* the third-person summary as the thing behaviour reads.
- The **curator becomes the "externalize" step** of introspection / trace consolidation
  (§3.2–§3.3) — the path by which a detail or an old trace moves out to long-term memory.
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
- **Prior art — OpenClaw's SOUL.md / IDENTITY.md** (a shipping local-first assistant).
  Independent convergence on the core: a Markdown **self-document injected into the prompt**
  drives behaviour, "you're not a chatbot, you're becoming someone," and the soul is told to
  prefer *"contradictions over coherence"* (echoes our internal-conflict-makes-character).
  *Vocabulary clash:* their **SOUL.md ≈ our identity**; their **IDENTITY.md** is just the
  outward card (name/emoji/avatar) — our *presentation*, not our identity. **Key
  divergence:** OpenClaw's soul/identity are **human-edited only** — the agent never revises
  its own self; evolution is confined to append-only MEMORY.md, and there is **no runtime
  self-vs-experience contradiction detection**. So OpenClaw is the *static half* of this
  model; the **dynamic half — introspection revising the self, and the trace catching
  rationalization (§3.2) — is exactly what they deliberately omit.** That a mature project
  stopped there is a caution: the self-revising part is the hard, risky frontier. Two ideas
  worth borrowing: (a) their **SOUL vs. AGENTS split** (personality vs. operating-rules) —
  our disposition/rules may not all belong *in* the ego document; (b) their **"tell the user
  when your soul changes"** rule — when introspection changes the identity (move 5), the dock
  should probably *surface* it. Cheap, honest, good UX.

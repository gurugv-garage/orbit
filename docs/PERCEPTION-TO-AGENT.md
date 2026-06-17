# Plugging perception into the dock agent — design

> How the always-on perception pipeline ([PERCEPTION-PIPELINE.md](PERCEPTION-PIPELINE.md))
> feeds the dock's brain agent (`modules/brain/`): grounding, memory, and — the hard
> part — **internal thoughts** the agent raises for itself.
>
> Status: **Phases 1–2 built.** Phase 1 = internal-thought routing (`trigger.kind:'self'`,
> the pure `ThoughtRouter` gate, the `listening`/`speaking` state accessor, the
> `POST /api/brain/:dock/think` test-poke). Phase 2 = grounding (the last summary +
> raw-since stream injected every turn, via `buildGrounding()` + the
> `PerceptionGroundingApi` facade). All unit-tested. Phases 3–5 (pull tools, memory store,
> the real attention gate) remain design. This doc pins the decisions + the seams.

## Where we are today (the gap)

A turn only happens when the **user** speaks: dock app (mic → VAD/wake → STT) →
`turn-request {text, context.state, image?}` → the brain runs a turn, appending a
per-turn grounding line (face recognition pulled on demand + one camera frame). The
rich snapshot pipeline (continuous vision/speech/identity/emotion/bodymotion + the
summarizer) is **not wired to the brain at all**. Plugging it in is the set of
decisions below (1, 2, 2b, 2c, 3, 4, 5), then the phased build.

> **Implementing this? Start at "Implementation anchors" (end of doc)** for the exact
> files, function names, and line references for Phase 1, plus the one caveat that
> shapes it (the `listening` signal doesn't exist yet — Phase 1 stubs it).

### The key realization: a thought IS an autonomous turn

The brain **already** routes non-user messages into the session — that's exactly how
**background tasks** notify the agent (`[background task …]` → `enqueueAutonomousTurn`).
That path already implements most of what an internal thought needs, battle-tested:

| What a thought needs | Already in `enqueueAutonomousTurn` / `#drainAuto` |
|---|---|
| user always wins | `while (#running) await` before taking the lane |
| staleness → drop | `if (now > req.expiresAt) continue` |
| de-dup / coalesce | `coalesceKey` merges a pending same-key turn |
| don't barge a rapid exchange | `settleMs` gap after the last turn |
| bounded backlog | drop-oldest at queue length 4 |
| defer + re-evaluate | queue, drain after `#running` settles |

So a self-thought is **`enqueueAutonomousTurn({ trigger:{kind:'self', text}, expiresAt,
coalesceKey })`** — NOT new plumbing. Tasks and thoughts unify on one mechanism (this
is the "push, like tasks" choice in Decision 5). What's genuinely **new** is small:
(a) the `'self'` provenance + prompt framing, (b) one new state rule — **defer while
the user is mid-utterance (`listening`)**, which the task path doesn't check, and
(c) push-grounding to keep perception context fresh.

---

## Decision 1 — Trigger: ONE attention gate (wake = interject = thought)

The robot should act on what it perceives, not only react to direct speech. The key
unification: **"wake word", "interject into a conversation", and "pure perception
thought" are the same mechanism** — each is a *candidate to speak* that runs the same
gate → becomes a `trigger:'self'` autonomous turn → behaves per the session-state table.
- **wake word** ("hey orbit") = the highest-confidence case: *directly addressed →
  almost always respond.*
- **overheard relevance** ("…they said my name / asked something I can answer") =
  *not addressed, but I judge it's worth interjecting.*
- **perception thought** ("you've looked stuck for a while") = *nothing said, but worth
  raising.*

Consequence: **the wake word can NOT live on the client.** It's not a dumb gate — the
"should I interject into this conversation?" judgment needs the conversation context,
which lives at the station. So wake/interjection is one **continuous attention gate**
at the station consuming: addressed-detection (wake phrase = a strong input),
topic-relevance, and perception thoughts — all feeding one `enqueueAutonomousTurn`.
**Tap-to-talk and tap-to-interrupt remain** as explicit user overrides on top.

**Deferred:** the gate's *judgment* (cheap rules → small LLM judge, per the pyramid).
For now a **test button** injects a thought. What's built **first** is everything
downstream — the session handling an internally-originated message correctly (Decision
2) — and the speech it's *about* (Decision 2b, the segmentation problem).

---

## Decision 2 — The internal thought (THE core piece to solidify)

An *internal thought* is a message that enters the agent session originated by the
**robot's own perception/awareness**, not the user. The session must:

### 2.1 Provenance — the agent knows it's its own thought
A thought is tagged as **self-originated**, distinct from a user utterance. It enters
the session as a turn with `trigger.kind = 'self'` (today's kinds are `'user'` /
`'task'`; add `'self'`). The prompt frames it so the model understands *"this is
something you noticed / thought, not something the user said"* — so it doesn't reply
"you said…" to its own observation. The agent may then **choose to speak, act, or stay
silent** (a thought is permission to consider, not an obligation to talk).

### 2.2 Behavior by current session state — the crux, fully specified
Exactly **one `current_session` per dock** (a singleton; see Decision 4). When a
thought arrives, behavior depends on session state. `[existing]` = already handled by
the autonomous-turn path; `[NEW]` = the rule we must add.

| Session state | What it means | Thought behavior |
|---|---|---|
| **idle** | no turn running, no one speaking | **Run** as an autonomous turn. `[existing]` |
| **listening** | user is mid-utterance (VAD active / partials arriving) | **Defer** — do NOT interrupt the user. `[NEW]` — `#drainAuto` waits on a running *turn* but not on the user *speaking*; add a `listening` gate. |
| **speaking** | TTS playing the agent's last answer | **Queue** behind the speech. Treated as "still busy responding" — wait, then re-evaluate. `[mostly existing]` (the settle gap + `#running` cover the common case). |
| **thinking** | a turn (user or self) is in flight | **Defer**; a self-thought never supersedes a user turn; a *user* turn always wins. `[existing]` |

Cross-cutting (all `[existing]` unless noted):
- **User always wins** — user turn-request supersedes an in-flight self-thought.
- **Staleness** — a thought carries `expiresAt` (the perception time it was raised + a
  budget); dropped if it waited too long. A 30-s-old "someone walked in" isn't worth saying.
- **De-dup / coalesce** — `coalesceKey` merges/replaces a pending same-kind thought.
- **Deferred → re-evaluate (your call).** A thought deferred behind the user/speech is
  NOT auto-run when the lane frees; instead, when the agent next gets a breather it
  **re-evaluates** — if the thought is still relevant (or perception raised a newer
  one) it acts, else it's dropped. Rationale: if the robot's still talking it's mostly
  *responding*, which is fine; it gets a chance to act when it pauses. **If re-eval is
  too complex initially, fall back to: log the deferred thought and drop it** (don't
  block on perfect re-evaluation).

### 2.3 Unit-testability (a hard requirement)
All of 2.2 must be testable without a live dock/LLM. Plan: a `ThoughtRouter` (or
methods on the session) that takes `(thought, sessionState)` and returns a decision
(`run` / `defer` / `queue` / `drop` / `supersede`) — a **pure decision function** over
an explicit state enum, unit-tested across every cell of the table. The session's
existing state (`#running`, `#activeTurnId`, `preWarm`/`noteSpeech` flags) is surfaced
as a single `state(): 'idle'|'listening'|'speaking'|'thinking'` accessor the router
reads. Injection + supersede + staleness each get tests; no network, no model.

---

## Decision 2b — What speech does a turn carry? (the segmentation problem)

Today the **Android recognizer hands us a clean, finalized utterance** — it solves
speech segmentation *for* us. If we move to always-on WebRTC + our own STT (which the
unified attention gate above *requires* — the station must hear the conversation to
judge interjection), **we own segmentation**, and it's the hard part: a continuous
stream has no turn boundaries, so *what exact text is a turn about?*

**We already have the raw material.** Our STT emits per-utterance speech snapshots with
`from`/`to` timing + a best-effort active-speaker tag (`[likely <name>]`); the summarizer
already **stitches** them into a role-tagged transcript. So segmentation = *scoping that
stitch*, not re-doing STT.

A turn carries **two distinct things** — keep them separate:
1. **The trigger** — the precise signal that fired: the wake phrase, or the utterance
   that mentioned the agent/topic, or the perception event. Short. "Why I'm responding."
2. **The conversational context** — a **window of recent utterances bounded by
   conversational coherence, not a fixed clock**: walk back from the trigger through
   contiguous speech until a **long silence gap** (a lull) or a **cap** (~30–60 s).
   Hand it as the stitched, speaker-tagged, confidence-annotated transcript the
   summarizer already produces. "What I need to respond well."

Each utterance keeps its **STT confidence + speaker guess**, so the agent knows what's
solid vs. shaky (and can hedge — ties to memory confidence). This is the same machinery
as grounding (Decision 3), scoped to "the current conversational segment up to the
trigger."

**Open (own design pass, when WebRTC mic unblocks):** the exact segment boundary rule
(silence-gap threshold? speaker-turn change? topic shift?); whether very-low-confidence
utterances are included-but-tagged or dropped; how the trigger utterance is
de-duplicated from the context window. The `listening` state signal source is part of
this (see Open questions).

---

## Decision 2c — Echo cancellation + barge-in (always-on mic essentials)

Always-on WebRTC mic + TTS through a speaker introduces two coupled problems. Both slot
onto existing infrastructure.

### 2c.1 Echo cancellation — the robot must not hear ITSELF
If the robot's TTS loops back into the mic, STT transcribes it → it looks like a "user
utterance" → the agent responds to itself (**infinite loop**), wakes itself (own name in
a sentence), and pollutes the transcript. **Defense in depth:**
- **Tier 1 — capture AEC (primary, mostly free).** WebRTC `echoCancellation: true` uses
  the playback signal as a reference. *Already on* in the console
  (`getUserMedia audio:{echoCancellation:true}`); **add `noiseSuppression` +
  `autoGainControl`.** Degrades when mic/speaker are far apart or loud (a robot, vs a
  laptop), so it's necessary but not sufficient.
- **Tier 2 — station "I'm speaking" gate (robust, cheap).** The station KNOWS when its
  own TTS plays — `noteSpeech(true/false)` already ships SpeakStart/SpeakEnd. During that
  window, **suppress/flag the speech stream** so self-overlap isn't fed to STT/attention.
  Reuses the **`speaking`** state we already have (the same signal that defers thoughts).
- **Tier 3 — semantic backstop.** If TTS text still leaks through, **match the
  transcript against what we just said** (we have both the speak frames and the STT
  output) and drop the echo.

### 2c.2 Barge-in — the USER interrupting the ROBOT
The other direction from robot→robot (which we said *always wait*). The user talking over
the robot's TTS should **stop it and listen** — essential UX. Today this is
**tap-to-interrupt** (explicit); with always-on mic it should ALSO be **voice barge-in**.
- **Mechanism already exists.** A barge-in is just a user turn-request arriving mid-speech
  → the existing **supersede** path aborts the active turn, and `sanitizeHistory()`
  already inserts synthetic `(interrupted)` markers so the LLM history stays valid. What's
  new is only the **trigger**: voice-activity during `speaking` → emit the interrupt.
- **Coupled to echo cancellation (the hard part).** Voice barge-in must distinguish "the
  user is interrupting" from "the mic is hearing the robot's own voice." With weak AEC,
  the robot's own TTS reads as a barge-in → it stops itself mid-sentence. **So barge-in
  detection depends on 2c.1 working** — they ship together, not separately.
- Keep tap-to-interrupt as the always-reliable fallback regardless of AEC quality.

**Open:** barge-in sensitivity (how much user speech over TTS counts — a word? a "no!"?);
whether a false barge-in resumes the cut-off speech or drops it; the AEC-confidence
threshold below which we trust ONLY tap (not voice) to interrupt.

---

## Decision 3 — Grounding: last summary, timeline-aware + pull tools

Every turn (user OR self) carries perception context so the agent reasons over what's
been happening — **not** just the current instant.

### 3.1 Always-on: the last summary + the raw stream since it ✅ **BUILT (Phase 2)**
Inject, **every turn (user AND self)**, the **most recent summary** stamped with its
window and **how stale it is** — e.g. *"Perception — last summary (2 min ago, covering
14:30–14:35 IST): Guru has been coding, sounded frustrated, asked about lunch."* —
**followed by the raw stream SINCE that summary** (the stitched, timestamped, speaker/
confidence-tagged records that accumulated after it: *"Since then (14:35–now, raw — not
yet summarized): …"*). So the agent has the fused narrative up to a point, then the
unfused "what's happened since." The agent thus knows whether context is live or old and
can hedge ("a few minutes ago you were…").

**Decided shape (NOT a fresh summarize per turn** — that's 5–15 s of Gemini we can't put
on the turn's critical path): grounding reuses whatever summary was last produced
(console click today; `force_get_current` later) and appends the cheap raw tail. No
always-on Gemini loop. If no summary exists yet, grounding is just the recent raw window
with its timestamps; a cold dock injects nothing.

**Decided: PUSH/injected, not a tool.** The full block is injected automatically (the
agent shouldn't have to *choose* to look — for a self-thought, perception IS the trigger;
a weak model would answer blind if it were pull-only). The *deliberate/expensive* pulls
(`force_get_current`, `recall_memory`) are the separate tool surface (3.2, Phase 3).

**As built:** pure builder `buildGrounding()` (`perception/grounding.ts`) +
`staleness()`; a per-dock `lastSummary` cache set on each successful
`/snapshots/summarize`; the `PerceptionGroundingApi` facade (`getPerceptionGrounding()`,
mirrors `FaceToolsApi`) the brain reads via the `getGrounding` dep and injects through
`buildSystemPrompt({ grounding })`. The raw tail reuses the summarizer's `stitch()` and
is capped (`MAX_RAW_LINES`). Unit-tested in `grounding.test.ts` (staleness phrasing,
summary+since, since-window exclusion, no-summary fallback, cold-dock null, line cap).
The console's dock-profile prompt preview shows the live grounding too.

### 3.2 The agent's tool surface (v1) — perceive → discover → inspect → mutate
Think like the agent: it can't use point-lookups until it can **discover** what exists.
So the set spans four needs. (These give the agent its *agency* over perception/memory.)

**PERCEIVE (the live now):**
- **`force_get_current()`** — flush + re-summarize the **live** moment now. For when the
  user pushes for now-ness ("what am I holding right now?"). Deliberate; costs a summary.

**DISCOVER (navigate what's remembered) — the part an LLM needs most:**
- **`recall_memory({ type?, subject?, time_interval?, query? })`** — the workhorse.
  Structured filters (type/subject/time) AND/OR a natural-language `query` (semantic
  scan). "what happened this morning", "what do I know about Guru", "did we talk about
  my flight". Returns matching memories (claim + confidence + when), or "not much" past
  the horizon.
- **`list_subjects()` / `list_recent(limit)`** — cheap orientation: who/what do I have
  memories about; what are my most recent memories. The agent calls these to *find its
  footing* before a targeted recall (an LLM can't recall by id it doesn't know).

**INSPECT (why do I believe this) — the self-reflection capability:**
- **`inspect_memory(id)`** — returns a memory's **lineage** + confidence: what it was
  derived from (records/other memories), when, by which model. Powers "dig into how this
  memory formed" — so when corrected, the agent can defend ("here's what I saw at 14:30")
  or concede ("that was one blurry frame — you're right").

**MUTATE (evolve the memory) — corrections and learning:**
- **`update_memory(id, correction)`** — revise a memory the user corrected; supersedes
  (keeps history), doesn't delete in place.
- **`forget_memory(id)`** — purge (status → purged).
- **`remember(subject, claim, { type?, confidence? })`** — record a new fact the agent
  learned in conversation ("Guru prefers tea") — the general form of `remember_face`.

The existing **face tools** (`remember/confirm/forget_face`, `recollect_face`) stay as
the `type:'person'` specialization for now; they're folded behind this surface later
(4.5) without changing their behavior. **Don't ship two parallel memory APIs.**

> Design principle: every tool maps to a natural agent intent ("what's now / what do I
> know / why / fix it"), and reads like something an LLM would reach for unprompted. If
> a tool needs the agent to already know an `id` it has no way to discover, add the
> discovery tool first.

---

## Decision 4 — Memory: a unified, per-dock, evolving store (the keystone)

`recall_memory` (the agent tool, 3.2) + grounding need perception to **outlive the
in-memory ring** (drops after ~1000 records). This is the deepest sub-system; its own design
pass. Home: a **memory sub-system of the perception module**, **per dock** (each dock
has its own memory world). The principles below are firm; the schema is a sketch.

### 4.1 The model: everything is a MEMORY, and everything evolves
We already have the proof: the **face gallery** is exactly this — faces↔names that
**improve** (each `confirm_face` appends a sample), get **corrected** (`forget_face`),
and carry **provenance** (every sample keeps the photo + `addedAt` it came from). We
**generalize the gallery's pattern**, not invent a new one. The gallery becomes one
*kind* of memory in the unified store.

Crucially: **nothing is permanently _constant_.** A memory's value is "the current best
belief," with history — and *everything* is mutable:
- **revision is first-class**, not just purging — a "stable" fact (a person's name,
  their usual chair, a relationship) can **change**, not only expire.
- **purge** (forget) and **revise** (update) are both normal operations.
- how long a memory lives / how readily it's revised is a **per-`type` retention policy**
  (4.3), not a stored field. Sketch of the lifetime spread by type: live-ring (ephemeral)
  · session-scoped facts · rolling **summaries** (persisted; raw kept a while then
  dropped, summaries remain — lossy like human memory) · durable-ish **people/preferences/
  places** (the gallery's kind; still revisable + purgeable).
- "**I don't remember much before X**" is an honest, acceptable answer past the horizon.

### 4.2 LINEAGE / provenance — first-class, queryable (the powerful part)
Every **derived** memory (a summary, an inference, a learned fact) records **what it
was derived from** — the source record/memory ids, the window, the model + prompt that
produced it. This is not just debug metadata; it's a **capability the agent uses**:
- **Debugging** — "why does it believe X?" → trace the lineage.
- **Self-reflection as a tool.** When the user says *"no, you're wrong about that,"* the
  agent can **dig into the lineage** of the contested memory and either **defend** it
  ("here's what I actually observed at 14:30") or **update** it ("you're right — that
  was a thin inference from one blurry frame; correcting it"). Memory you can
  **interrogate and quote**, not just recall. This needs a tool like
  `inspect_memory(id) → {claim, derivedFrom:[…], when, byModel, confidence}`.
- Lineage also drives **honest confidence**: a memory from 5 corroborating observations
  is held firmly; one from a single shaky frame is held loosely (and surfaced as such).

### 4.3 The axes (the unifying structure)
A memory is described by **three axes** (don't conflate them) + confidence:
- **`type`** — person · summary · event · preference · fact · place · … (the gallery =
  `type:'person'`). **Retention/revision policy is keyed on type** — there is no
  separate "volatility" field; how long a memory lives and how it evolves is a per-type
  policy (a `summary` ages out; a `person` is revised, rarely purged).
- **`subject`** — WHAT/WHO the memory is *about* (an entity link). This is the axis the
  agent reaches for most: *"what do I know about Guru / the kitchen?"*. **v1: a
  normalized string tag** (`'guru'`, `'kitchen'`) — NOT a separate entities table, NOT a
  vector (subject is an *exact* lookup; vectors would fuzz it). Promote to a real
  entities table only when relationships *between* entities matter.
- **`derivation`** — `observed` (straight from a snapshot stream) vs `derived` (a
  summary/inference). **Derived rows carry lineage** (4.2).
- **`confidence`** — first-class on EVERY memory, so the agent hedges honestly ("I think
  you said…" vs "you said…"). It's the natural output of lineage (5 corroborating obs =
  high; 1 blurry frame = low).

### 4.4 Storage + querying — one store, two access modes
sqlite via `core/db.ts` (already backs config/cost). Sketch:
```
memory(id, dockId, type, subject, claim, value_json, confidence,
       derivation,                          -- observed | derived
       created_at, valid_from, valid_to|null,  -- evolves via SUPERSEDE, not delete-in-place
       status,                              -- active | revised | purged
       embedding BLOB)                       -- for semantic recall (see below)
memory_lineage(memory_id, source_kind, source_id)  -- derived rows: what fed this memory
```
Two access modes, both needed (an LLM agent uses both):
- **Exact / structured** — filter by `(dockId, type, subject, time_interval, status)`.
  Backs "what do I know about Guru", "what happened this morning". Plain indexed columns.
- **Semantic** — **embeddings from v1.** Each memory carries an `embedding`; `recall`
  with a natural-language query ("did we ever talk about my flight?") does an
  **in-process cosine scan** over the dock's bounded memory set. **No separate vector
  DB** — at our scale (per-dock, purged, hundreds–low-thousands of rows) a brute-force
  scan in sqlite/JS is sub-ms; a vector service would be overkill. (Open: which embedder
  — a small local one in the perception sidecar vs. a cheap embeddings API; a
  v1-implementation choice, not an architecture one.)
- **Evolve** by inserting a new version + marking the old `revised` (history kept for
  lineage), never mutating in place — so "what did you believe last week?" is answerable.
- Don't fork storage per kind. The gallery is wrapped behind this surface (4.5).

### 4.5 Folding the face gallery in — what's done, what's left
The gallery (`faces↔names`) is our first real "evolving, provenance-carrying,
per-dock" memory and **must be tightly part of the memory sub-system**, not a parallel
special case. Audit of where it stands:

- **Already coupled (good):** the gallery is constructed *inside* the perception module
  (`index.ts` → `new Gallery(...)`), its file lives in perception's `data/`, the brain
  reaches it only through the **`FaceToolsApi` facade** (`getFaces()`) — never importing
  `Gallery` directly — and all REST access is under `/api/perception/gallery/*`. No
  rogue file access, no separate module, no out-of-band seam. (Recent perception work
  already tightened this.)
- **Still independent (the gap):** the gallery is its own **ad-hoc JSON file with a
  bespoke shape**, *parallel* to the rest of memory — it predates the memory model. It's
  coupled to the *module* but not to the *memory sub-system* (which doesn't exist yet).

So "bake it in tightly" = **conceptual unification**, not a re-wire of consumers:
make the gallery **one `type:'person'` view over the unified store** (4.3) — same
evolve/revise/lineage/query semantics as every other memory — keeping the
`FaceToolsApi` facade stable so the brain is unaffected. A person entry is then a
memory with lineage (the photos/observations it was learned from), revisable (rename,
re-confirm), purgeable (forget) — which it informally already is; we just put it on the
shared rails. **Do this when we build the memory store (don't fork a second pattern in
the meantime).**

### 4.6 Deferred to the memory follow-up
`memory_type` taxonomy + `time_interval` grammar (for the tools); retention/rollup
budgets per volatility tier; the exact lineage edges worth recording; how grounding
selects *which* memories to inject (recency × relevance × confidence); the gallery →
unified-store migration path (wrap-behind-facade first, then migrate rows).

---

## Decision 5 — Session lifecycle: one current_session, kept fresh

There is exactly **one `current_session` per dock** — a singleton. **Chosen: PUSH**
(it mirrors the task model — tasks already push frames into the session, and thoughts
unify on the same path). Perception feeds context into the current session as it
updates, so the session is **continuously context-aware** without re-pulling each turn.
Proactive thoughts and user turns both run inside the one current session. The existing
lazy-open / idle-close lifecycle stays. (Because thoughts and tasks share the push
mechanism, design principles solved here — provenance, staleness, coalescing, state
gating — apply to task comms too; keep them unified, don't fork.)

---

## Build phases (proposed)

1. **Internal-thought routing (Decision 2)** — the foundation. ✅ **DONE.** As built:
   - `trigger.kind: 'self'` + prompt framing (`SELF_THOUGHT_FRAMING` in `prompt.ts`,
     gated by `buildSystemPrompt({ selfThought })`);
   - a pure **`ThoughtRouter`** (`thought-router.ts`, `decideThought()`) returning
     `run`/`defer`/`drop` over `{state, now, expiresAt, lastTurnEndedAt, settleMs}` —
     the policy, exhaustively unit-tested in `thought-router.test.ts`;
   - `DockBrainSession.state(): 'idle'|'listening'|'speaking'|'thinking'` over the
     existing flags (`#running`/`#turnActive`, a `#speaking` flag latched by
     `noteSpeech`, and a **stubbed `#listening`** flag set by `setListening()`);
   - `#drainAuto` now calls `decideThought` (peek-not-shift) — the `listening`/
     `speaking` defer + log-then-drop-on-stale are the new rules; user-priority +
     coalesce + bounded queue are reused from `enqueueAutonomousTurn` unchanged;
   - a **REST poke** `POST /api/brain/:dock/think` (`{text, ttlMs?, kind?}`) injects a
     self-thought (coalesceKey `self:<kind>`);
   - **integrated tests** in `autonomous.test.ts` (idle→run, listening/speaking→defer-
     then-run, user supersede, expired→drop, deferred-past-expiry→drop, coalesce).
   The `listening` signal is a STUB (the caveat below) — wired + tested, no real source
   yet. The other three states have real signals today.
2. **Grounding (Decision 3.1)** — ✅ **DONE.** PUSH the last summary (with staleness) +
   the raw stream since it into every turn's prompt. Pure `buildGrounding()` +
   `PerceptionGroundingApi` facade + `lastSummary` cache; unit-tested. No per-turn Gemini.
3. **Pull tools (Decision 3.2)** — `force_get_current`, then `recall_memory`/`inspect_memory`.
4. **Memory store (Decision 4)** — persistence + retention tiers; back the tools with it.
5. **Proactive gate (Decision 1, later)** — cheap rules → LLM judge that auto-raises
   thoughts instead of the button.

## Decided
- **Push** grounding (mirrors tasks); thoughts + tasks share one mechanism.
- **Barge-in: always wait** for now — a self-thought never interrupts the robot's own
  speaking. (Revisit only if urgent-event interruption proves necessary.)
- **Deferred thought → re-evaluate** when the agent next pauses (or **log+drop** if
  re-eval is too complex for the first cut).

## Implementation anchors (read this before coding Phase 1)

Concrete code references so a fresh agent can start without re-discovering the codebase.
All paths under `orbit-station/server/src/`.

**Files that exist + what to touch:**
- `modules/brain/session.ts` — the dock session. Key seams:
  - `interface TurnRequest { turnId; trigger: { kind: string; text }; … }` (~line 67).
    `trigger.kind` is a **plain string** today (`'user'` / `'task'`) — adding `'self'`
    needs **no enum change**, just new handling + prompt framing.
  - `enqueueAutonomousTurn(req: TurnRequest & { expiresAt?; coalesceKey? })` (~line 283)
    — **the injection point for a thought.** Already does coalesce + bounded queue.
  - `#drainAuto()` (just after) — drains the auto queue; `while (#running) await` =
    user-priority; `expiresAt` check = staleness; `settleMs` gap. **Add the `listening`
    gate here.**
  - State flags to expose as `state()`: `#running` (a turn in flight), `#turnActive`
    (~line 152, getter ~233), `#activeTurnId`, `#cancelled`; `preWarm()` (~241) and
    `noteSpeech(speaking)` (~362, ships SpeakStart/SpeakEnd) are the speaking/listening
    hooks.
- `modules/brain/prompt.ts` — builds the system prompt. It does **not** currently branch
  on `trigger.kind`; the **`'self'` framing** ("this is your own thought, not the user")
  is new here.
- `modules/brain/index.ts` — WS routing. `turn-request` → `handleTurnRequest` (~line 208);
  task events → `enqueueAutonomousTurn` (~line 200) is the **pattern to copy** for the
  thought test-poke. Add a `POST /api/perception/think` (or brain route) that calls
  `session(dock).enqueueAutonomousTurn({ trigger:{kind:'self', text}, expiresAt, coalesceKey })`.
- `modules/brain/autonomous.test.ts` — **extend THIS** for the thought routing tests (not
  a new suite). It already exercises the auto-turn lane.

**`coalesceKey` convention for thoughts:** tasks key on `instanceId`. Thoughts should key
on a **thought kind/topic** (e.g. `'self:presence'`, `'self:emotion'`) so a newer thought
of the same kind replaces a stale pending one, but different kinds don't clobber each
other. Pin the exact keys when the gate is built.

**THE PHASE-1 CAVEAT (don't miss this):** the **`listening` state has no real signal
today** — the Android recognizer owns the mic, so the station sees no live user speech
(see Open questions: always-on-mic shift). So Phase 1 **builds the structure** — the
`state()` accessor, the `listening` branch in `#drainAuto`, and tests that drive it via a
**stubbed/injected** `listening` flag — but cannot wire `listening` to a real signal yet.
That's fine and intended: the routing logic is fully unit-testable against a stubbed
state; the real signal lands with the mic shift. Build + test the gate now; connect the
wire later. The other three states (`idle`/`speaking`/`thinking`) DO have real signals
today and should be wired for real.

**What Phase 1 delivers (acceptance):** `trigger.kind:'self'` handled end-to-end; a
test-poke injects a thought from the current perception summary; `idle` → runs,
`thinking`/user-turn → user wins, `speaking` → defers, `listening` (stubbed) → defers;
all unit-tested in `autonomous.test.ts`; no live mic/LLM needed for the tests.

**Anchors for the LATER phases (grounding/tools/memory) — reuse existing perception code:**
- Grounding + `force_get_current` reuse `modules/perception/`: `summarize()`
  (`summarizer.ts`), the flush + summarize already wired at the `POST /snapshots/flush`
  and `/snapshots/summarize` routes (`index.ts`), and `inWindowWithState`/`stateAt`
  (`snapshots.ts`) for windowed/state recall. `force_get_current` ≈ flush-then-summarize
  the live window, exposed as a brain tool.
- The brain reaches perception today via the **`FaceToolsApi` facade** (`getFaceTools()`
  in `perception/index.ts`, consumed in `brain/tools.ts`); the new memory tools follow
  the **same facade pattern** — a `MemoryApi` exposed from the perception module, consumed
  as brain tools. Don't let the brain import the store directly (keep the facade).
- New brain tools go in `modules/brain/tools.ts` (`tool(name, DESC, schema, fn)`); schemas
  in `modules/brain/schemas.ts`. The existing `*_face` tools are the worked example.
- Memory store: `core/db.ts` is the shared sqlite layer (backs config/cost) — the memory
  tables live there, owned by the perception module.

## Open questions (for the follow-up)
- `recall_memory` exact `type` taxonomy + `time_interval` grammar + `query` semantics.
- Memory retention tiers (how long raw vs summaries; per-dock budgets).
- Staleness budgets per thought kind (how old is "too old" to say).
- **The always-on-mic shift — discuss deeply before building (this unblocks a lot).**
  Currently the Android **recognizer owns the mic**: no WebRTC audio from the app, so
  the station has no live user-speech signal AND no continuous transcript to judge
  interjection from. The unified attention gate (Decision 1) + station-side wake/
  interject + our-own-segmentation (Decision 2b) ALL depend on moving the mic into the
  WebRTC/perception path. When that lands, three things become real together:
  (a) the **`listening`** signal — "user mid-utterance" (dock VAD frame vs STT partials
  vs our speech stream), with a debounce so a breath-pause ≠ "done";
  (b) **segmentation** — what exact text a turn carries (Decision 2b);
  (c) the **attention gate** judging wake/interject from the live conversation.
  Nothing breaks today; be sure of all three before the shift. **Own design pass.**

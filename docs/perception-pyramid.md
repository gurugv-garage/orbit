# Perception pyramid — always-on stream understanding

> The plan for turning the dock's continuous A/V into an always-current
> understanding that intelligence layers query at the resolution they need —
> and that decides **when to respond** by escalation, not by a wake word.
>
> Status: **design + tier-1 prototype.** Tiers 2–3 are specified here, not yet
> built. Builds on the existing perception module
> (`orbit-station/server/src/modules/perception/`) — this is not a rewrite.
>
> The **as-built** tier-1 pipeline (the four snapshot streams + summarizer) and the
> reasoning behind each component:
> [docs/perception-pipeline.md](perception-pipeline.md).

## The shift

Today's interaction is **triggered**: tap-to-listen / wake word, then process.
That's brittle (and currently broken). The target is **always-on**: the stream
is processed continuously and cheaply, perception is a fact that's always
current, and a tiered intelligence decides when something is worth responding
to. (Tap/markers stay as a temporary crutch for "when to respond" while the
real escalation is built.)

## The core idea: a cost/frequency pyramid

The cheaper a processor, the more often it runs. Cost and frequency are inversely
matched, so the whole thing stays **almost free** — expensive things run rarely.

```
 FREQUENCY        TIER / PROCESSOR          COST         WHAT IT PRODUCES
 ─────────        ────────────────          ────         ────────────────
 every frame      T1  code roll-up          ~0           per-frame facts:
 (~1 Hz)              (transitions,                       present/activity/transcript
                       counts, state)                     → booleans, state-changes,
                                                          "0→1→0 = appeared then left"

 every ~30 s      T2  small LOCAL llm        cheap        fuse last ~30 facts into a
                      (gemma/qwen3-small)    (rare)       short narrative + structured
                                                          events. Idle 99% of the time,
                                                          so its GB/latency barely cost.

 every few min    T3  remote BIG llm         $ / net      situation report / judgment
 or on demand         (Claude, dock brain)   (rare)       over the T2 summaries; produces
                                                          the actual RESPONSE.
```

Always-on **sensors** feed T1:

```
 continuous A/V (SFU, already tapped by ProcessingHub)
   ├─ moondream processor   → per-frame "what I see"   (image → short text)
   └─ whisper  processor    → per-utterance "what I hear" (speech → text, VAD-gated)
```

Both are small (moondream ~1.3 GB, Whisper ~0.5 GB) and there is **no continuous
LLM** — T1 is code, T2/T3 fire rarely. Total always-on footprint ≈ 2 GB.

## "When to respond" = the pyramid IS the decider

There is no separate responder component. **Each cheap tier gates the next
expensive one:**

```
 T1 code    detects a change worth noticing     ──▶ wakes T2
 T2 local   decides "this is significant"        ──▶ wakes T3
 T3 brain   decides "respond, and how"           ──▶ dock speaks/acts
```

The code layer filters ~99 % of frames for free (nothing changed → silence). The
local LLM filters most of the rest. The expensive brain only ever sees the few
moments that might warrant a response — so "deciding when to respond" never burns
an LLM per frame. This is the cheap-decider-wakes-expensive-brain pattern, but it
falls out of the pyramid instead of being bolted on.

## Consumers read the tier matching their need

A vision task "accepts its own requirement on the summarization": it reads
whichever tier matches the granularity it needs.

- "Is someone there right now?"        → T1 current state (free, instant)
- "What happened in the last minute?"  → T2 summary
- "Give me a situation report"          → T3 (synthesize on demand)

## How it maps onto existing code (not a rewrite)

The perception module already has the seam:

| Pyramid piece | Existing code |
|---|---|
| Always-on A/V tap | `media` SFU + `perception/hub.ts` `ProcessingHub` (taps every stream) |
| A sensor | `StreamProcessor` (`perception/processor.ts`) — `presence.ts`, `face-recognition.ts` today; **moondream + whisper next** |
| Per-result envelope | `PerceptionResult` (`result.ts`) — already has `scene`, `transcript`, `watcher-event` kinds |
| T1 rolling state | `PerceptionState` (`state.ts`) — per-dock world state + `recentTranscript` ring buffer already exists; its own comment anticipates "future temporal/aggregate processors (category c)" |
| T2/T3 | **new** consumers of the `perception` topic / `PerceptionState`; T3 = the existing dock brain (`modules/brain`, the pi loop) |

So T1 is mostly *extending what's there*; T2/T3 are new consumers, not new
plumbing.

## Build order

1. **T1 sensor — moondream vision processor** (always-on, per-frame description +
   `present`/`activity`). Prototype: `models/moondream/` sidecar called from a
   `StreamProcessor`. ← *starting here.*
2. **T1 code roll-up** — fold per-frame facts into transitions/state in
   `PerceptionState` (extend it; emit `watcher-event` on changes).
3. **Whisper sensor** — server-side STT processor (VAD-gated), emits `transcript`.
   (The dock also does on-device STT; server STT removes that dependency.)
4. **T2 local summarizer** — every ~30 s, fuse recent facts → narrative + events
   via a small local LLM, only when T1 flags change.
5. **T3 escalation** — significant T2 events wake the dock brain to decide a
   response.

## Open questions

- **Frame cadence vs the dock's ~1 Hz stream** — moondream at ~1 s/frame ≈ the
  stream rate, so "as fast as possible" ≈ 1 Hz. A change-gate (skip near-identical
  frames) keeps T1 near-idle on static scenes.
- **Where T2 runs** — in-process (Ollama) keeps it simple; it's rare enough that
  its memory amortizes. Revisit if co-residency with moondream is tight.
- **Server vs dock STT** — start with whichever is faster to wire; the pyramid
  doesn't care which produces the `transcript` results.

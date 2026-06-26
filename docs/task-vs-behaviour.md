# Task vs behaviour — the one real difference

> What the **conductor** governs is a set of **conducted things**, each of one **kind**: a
> **task** or a **behaviour**. This doc is the single place that says what actually
> distinguishes them — written **deliberately thin**, because the moment we over-define it we
> will confuse ourselves. Related: [conductor-v1-design.md](decision-traces/conductor-v1-design.md)
> (the conductor that governs both), [tasks.md](tasks.md) (the task substrate).
>
> Status: **v1, provisional.** This is a working call, not a law — see "The collapse door" below.

## The difference, in one line

> **A task is DECOUPLED. A behaviour is INSTRUMENTED.**

- A **task** is *independent* — a self-contained capability that runs against a published
  interface (the capabilities / supervisor surface). It doesn't know or care **who** started it
  (a user, the brain, the conductor) or **what** it's wired into. You can drop a new task into
  the packaged-tasks folder and spawn it by name. Example: **faceFollow** — "follow a face"
  stands entirely on its own.
- A **behaviour** is *woven into a specific place in the code at design time* — its logic lives
  at a **known point in an existing code path** and only makes sense there. Its descriptor
  records **`instrumentedAt`** — exactly where it's woven. Example: **wakeUp** — the wake-phrase
  check lives **inside the brain's `onAddressedFinal`** (`brain/index.ts: matchesWake() →
  session.wake()`), on the STT-final signal that already flows through that handler.

That is the whole distinction. Decoupled vs. instrumented.

## What is NOT the distinction (and why we say so out loud)

People reach for these, and they're all **consequences**, not the definition:

| Tempting "rule" | Why it's only a consequence |
|---|---|
| "A task is a separate process; a behaviour isn't." | A decoupled thing *tends* to want its own process, and an instrumented hook *tends* to be small enough not to — but that's fallout, not the rule. A behaviour could grow; a task could be tiny. |
| "A task is generic; a behaviour is bespoke." | Decoupled things *tend* to be reusable and instrumented ones *tend* to be one-off — again, a correlation, not the line. |
| "A behaviour is a one-liner." | Size is incidental. wakeUp is small because the reaction is small, not because it's a behaviour. |

We name these explicitly so that the **first counter-example doesn't break our heads.** When
something doesn't fit one of these incidental traits, that's fine — ask only the real question:
*is its logic decoupled and spawnable, or is it instrumented into a specific code path?*

## From the conductor's side, they're the same thing

The conductor doesn't care which kind a thing is when it **decides**. To the conductor, every
conducted thing is *a named intent it arms/disarms and tunes by a rule*, with a manual override
(Run now / Stop / Auto). The kind only changes **how `enact` reaches it**:

- **task** → start/stop a decoupled process by name (through the supervisor);
- **behaviour** → toggle an instrumented hook on/off (through a narrow callback, e.g. the
  brain's `WakeApi.setWakeConfig`).

The policy (`decide(tunings, world) → off | running`) is identical for both. So is the surface
(REST + the Conductor console tab) — which shows the **kind badge** and, for a behaviour, the
**`instrumentedAt`** line so you can always find where it lives.

## Why keep two kinds at all, then?

Because the **reach** genuinely differs *today*. A decoupled task is reachable as a spawnable
unit; an instrumented behaviour is only reachable at the point it's woven. Until that reach
difference stops mattering, two kinds is the honest model — collapsing them now would *hide* a
real difference, not remove one.

## The collapse door (left open on purpose)

This is a v1 call. If the second kind never earns its keep — if every "behaviour" we add could
just as well have been a small decoupled task, **or** if we grow a clean general way to
instrument tasks in-place — we **collapse to one concept** (a *conducted thing*) and delete the
distinction. We are explicitly **not** forcing a permanent definition now; we are naming the one
difference that is real today and leaving room to simplify tomorrow.

## Worked answers

- **Is faceFollow a task?** Yes — it's decoupled: a standalone "follow a face" capability that
  drives the body via the lease, indifferent to who armed it. (It *also* happens to be a separate
  process and *also* fairly generic, but those are the usual fallout of being decoupled, not the
  reason.)
- **Is wakeUp a behaviour?** Yes — it's instrumented: woven into the brain's heard-utterance
  path, reacting to a stream that only exists in-process there. Making it decoupled would mean
  inventing a transcript fan-out to feed a check that already has a natural home.

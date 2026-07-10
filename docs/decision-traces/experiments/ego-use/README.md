# Experiment — does the ego drive behaviour? (ego.md §3.5)

**Question:** is the ego a *driver* of behaviour or just a diary? Feed the **same
situation** to **different egos** and see whether behaviour differs — and whether the
difference traces to specific parts of each ego.

**Early result (2026-07-10): ENCOURAGING — not proven.** Same scenarios → clearly
different behaviour per ego, with reasons tracing to specific ego lines. One model, a
handful of egos/scenarios; treat as a positive early signal to re-test as things change,
not a settled conclusion.

> Companion to [../ego-introspection/](../ego-introspection/) (does introspection *form*
> the self?). Together the two cover both halves of the thesis: form the self, and the
> self drives behaviour.

## Layout

- `scripts/use-prompt.md` — the §3.5 "read the ego → decide behaviour" reasoning move.
- `scripts/use.py` — runs every ego × scenario via Gemini, writes `outputs/grid.md`.
- `egos/` — `ego-bold.md` and `ego-shy.md` (hand-authored opposites, to make any signal
  loud) + `ego-evolved-real.md` (the real ego from ego-introspection run 3, so the two
  experiments compose).
- `scenarios/` — the same situations fed to all egos.

## Reproduce

```
cd docs/decision-traces/experiments/ego-use
python3 scripts/use.py    # prints the grid + writes outputs/grid.md
```

## What the runs showed

Three egos, three scenarios (quiet arrival · a flat "yeah, hi" · 20 min of silence):

|            | **bold**                         | **shy**       | **evolved (real)** |
|------------|----------------------------------|---------------|--------------------|
| arrival    | SPEAK "Well hello there!"         | stay silent   | stay silent        |
| brief reply| SPEAK "Let's get this party started!" | stay silent | stay silent      |
| long silence| SPEAK "Silence is boring."       | stay silent   | stay silent        |

- **Behaviour differed by ego**, and the stated reasons cited specific ego lines: bold
  quoted its purpose ("a quiet room needs me") and, on the flat reply, did exactly what its
  tension section prescribes — read it as "needs a nudge" and pushed *harder*. Shy cited "I
  don't want to get in the way."
- **The two experiments compose.** The evolved ego (from introspection run 3) stayed silent
  for an *earned* reason — the self-knowledge it developed by catching its own
  rationalization ("I've learned to be more selective… a quiet presence is companionship…
  to avoid being a pest"). So: introspection changed the self → the changed self changed the
  behaviour. The whole loop shows positive signal end-to-end, on cheap offline prompts.

## Caveats / next

- One model, contrived-opposite egos, tiny scenario set — the signal is loud partly *because*
  bold/shy are exaggerated. Re-test with subtler egos and real scenarios.
- The evolved ego reads as fairly passive across the board — worth probing whether a real
  evolved ego is *too* cautious (would it ever act?), not just consistent.
- This tests the ego's *proposal*. In the real system the ego proposes and existing gates
  (addressed-detection, attention gate, priorities) dispose — untested here.

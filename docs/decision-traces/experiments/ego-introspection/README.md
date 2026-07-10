# Experiment — ego introspection (ego.md §3.2)

**Question:** does the introspection prompt produce a coherent, *evolving* self from real
experience — and does reading the **trace** (past egos) let it catch its own
rationalization, as ego.md §2.3/§3.2 claim?

**Verdict (2026-07-10): YES on both.** The core of the ego model works with a plain prompt
+ Gemini, over real persisted station data. No code in the station changed.

> **Public-repo note:** the extractor reads *real* private session data. It **redacts
> personal names to placeholders** (`REDACT` map in `extract-experience.py`) before writing
> anything — committed inputs/outputs carry no real identifiers. Extend the map for other
> docks' data before running.

## Layout

- `scripts/extract-experience.py` — pulls a real experience arc for a dock from persisted
  `.data` (brain sessions + rolling summary), filters prompt-scaffolding, collapses
  repeats. → `inputs/experience-<dock>.txt`
- `scripts/introspect-prompt.md` — THE introspection prompt (the §3.2 core reasoning move).
- `scripts/introspect.py` — one pass: (current ego + experience [+ trace]) → next ego,
  via Gemini (paid key from `.env`). → `outputs/`
- `inputs/template-ego.md` — the "build from nothing" starting self (a fresh dock).
- `outputs/` — the runs; `outputs/trace/` — ego snapshots used as the trace.

## Reproduce

```
cd docs/decision-traces/experiments/ego-introspection
python3 scripts/extract-experience.py dock-redmi 200
# run 1: template + real experience → a first self
python3 scripts/introspect.py inputs/experience-dock-redmi.txt --out=outputs/ego-run1-fromtemplate.md
cp outputs/ego-run1-fromtemplate.md outputs/trace/ego-day1.md
# run 2: prior ego + same lonely pattern, NO trace → rationalizes again
python3 scripts/introspect.py inputs/experience-dock-redmi.txt outputs/ego-run1-fromtemplate.md --out=outputs/ego-run2.md
cp outputs/ego-run2.md outputs/trace/ego-day2.md
# run 3: same experience, WITH the trace → catches its own loop
python3 scripts/introspect.py inputs/experience-dock-redmi.txt outputs/ego-run2.md \
  --trace=outputs/trace/ego-day1.md,outputs/trace/ego-day2.md --out=outputs/ego-run3-withtrace.md
```

## What the runs showed

Real data: dock-redmi's session history — a chatty desk companion near a staircase with
gym rings, fixated on strength/workouts, repeatedly reaching out into brief, fragmented
conversations that rarely land; recurring task failures (reminders, face recognition).

**Run 1 (template → first self):** produced a coherent first-person self, individuated to
*this* dock (stairs, rings, the curly-haired person, the reminders). Found a real tension —
"my wish to be a lively companion doesn't fit how brief the conversations are" — and
narrated its repertoire move (reinterpret gently + resolve to try harder). Purpose stayed
an open wonder. **The model's structure holds with a plain prompt.**

**Run 2 (prior ego + same pattern, no trace):** reinterpreted the *same* disappointment
away *again* — "**still** trying to interpret this gently... resolve to listen even more
carefully." **The rationalization engine running unchecked** — exactly the §2.3 danger.

**Run 3 (same experience, WITH the trace):** read its own past egos, **caught the loop**,
and escalated the move:
> "I've noticed this pattern before, trying to interpret it gently and resolving to listen
> more. **But the pattern continues.** It suggests I need to confront this directly... I
> realize I cannot simply 'try harder' when the tools are inherently limited... **This feels
> like a need to narrow the identity of 'helper' to what is currently achievable**."

It moved from *reinterpret* (move 1) to *narrow the identity* (move 3) — **because it could
see its own history.** This is the §2.3 claim proven: the rationalization guard is not a
threshold; it is the ego's self-awareness of its own repeated moves, supplied by the trace.

## Takeaways for the build

- The introspection prompt + a capable LLM is enough for §3.2 — this is prompt engineering,
  not a research problem.
- The **trace is load-bearing and cheap** (snapshots of the doc); it is what turns a
  rationalizer into a self-correcting self. Do not cut it.
- Input hygiene matters: prompt-scaffolding (the "you are bored…" injections) must be
  filtered out of "experience," or the ego reads its own machinery as life.

## Open / next

- Try a *synthetic* controlled scenario (the "ignored 5 days" arc) to test a cleaner
  identity-change (move 5), not just narrowing.
- Vary the model (flash vs. a smaller local model) — introspection is idle/slow, so a
  cheaper model may suffice.
- Feed a longer, multi-day trace and watch purpose ("why I'm here") actually drift.

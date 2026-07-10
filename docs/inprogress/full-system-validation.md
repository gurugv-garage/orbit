# Ego + perception pipeline — rebuild, validation & behavioural findings

**Status doc — survives across sessions.** If resuming: read **CURRENT STATUS** and **WHAT'S NEXT**.
Updated as work lands. (2026-07-10)

## Where this stands in one paragraph

The perception→memory→ego pipeline was rebuilt and the ego's behaviour against **real, noisy
perception** was fixed. All of it is **committed** on branch `docs/ego-design` (3 commits). The
staged validation runs (accelerated→semi→real) served their purpose — Stage 1 caught real bugs
cheaply — but the decisive work turned out to be **interactive behavioural probing** (`behave.py`),
which surfaced and fixed the actual failure (the ego spiralling on raw noise). Stages 2–3 were
**not** completed as long soaks; they were superseded by fast probes. See WHAT'S NEXT.

## Canonical vocabulary (settled)

Two things get populated: **the ego** (the self) and **the memory**. Memory = the perception
stream (compressed as it ages) + a generic fact store. There is **ONE summarizer**, one checkpoint.

| name | what it is | where |
|---|---|---|
| **raw perception** | vision/speech/identity/emotion/bodymotion records, durable on disk | `.data/perception/records/<dock>/<day>.jsonl` |
| **rolling-summary** | the ~60s reconciled "what's going on right now", overwritten (live grounding cache) | `last-summary.json`; `source.id:'rolling-summary'` |
| **span-summary** | hourly trim-time reconciled digest of an aged-out span (perception compressing its tail) | `span-summaries.jsonl`; `source.id:'span-summary'` |
| **memory store** | generic fact primitive — store/recall/forget facts (semantic + subject/type/confidence), brain TOOLS | sqlite `MemoryStore` (`orbit-station/.data/orbit.db`) |

**The ego reads the RECONCILED stream** (`reconciledPerceptionSince`): span-summaries (older) +
rolling summary (recent) + an on-demand summary of the un-compressed tail — **never raw sensor
lines** (raw is too noisy; a faithful reasoner reads its contradictions as "my eyes are broken").
Quality-control lives in the summarizer only (one place, no buck-passing).

## The unified memory model (curator deleted)

ONE summarizer pass (hourly / at trim) → **TWO outputs**, same checkpoint:

```
raw perception ──▶ THE SUMMARIZER (hourly, at trim) ──┬──▶ ① span-summary  (compress the timeline)
   (the record)                                        └──▶ ② facts → MemoryStore (append+light-dedup)
MemoryStore (generic fact primitive) ◀── also the LLM's `remember` tool
   └─ recall_memory / remember / forget (brain TOOLS) + per-turn memoryGroundingSlice
```

- **① span-summary ≠ ② fact.** ① = "what happened this hour" (lossy timeline). ② = "what's true /
  worth remembering" (a queryable fact).
- **Deleted:** the background curator job + its watermark/poll/reconcile + the whole orphaned
  `memory/longterm/` folder + `/curator*` REST + config knobs + the console panel. Fact-extraction
  rides the one summarizer pass. **Kept:** MemoryStore + brain memory tools + grounding slice + face
  gallery (separate).

## What shipped (all committed, branch `docs/ego-design`)

**Memory pipeline (§7c):**
- Trim-time self-compression → hourly span-summaries. **Record-granular by closed clock-hour**
  (a day-granular first cut never trimmed today's tail — caught by the accelerated stage, fixed).
  Summarize-before-delete: a summarizer failure keeps the raw for a retry — no silent data loss.
- One-stream read; fact-extraction (`extractFactsFromSpan`, append + semantic dedup) as the
  summarizer's 2nd output. Store contract unit-verified.

**Ego behaviour (the core fixes — found by behavioural probing on real room data):**
- **Reconciled feed:** the ego reads the summarizer's reconciled output, not raw. Killed the
  "my eyes are broken / irreversible dissolution" spiral.
- **Addressed-flag:** the brain stamps its addressed decision onto the speech record
  (`markSpeechAddressed`); summarizer renders `[→ TO YOU]` vs `[overheard — not to you]`;
  fact-extraction + ego respect it. Killed the "communication vacuum" spiral driver.
- **Downtime = gaps:** no records = offline (labelled); records saying "no one" = a real empty room.
  A restart doesn't read as abandonment.
- **Cadence:** ~hourly idle + event-triggerable (departure fires early) + keep an hour of trace
  snapshots (was overwrite-in-place).
- **Vision hedging:** the summarizer hedges repeated VLM object guesses ("what looks like gym
  equipment") instead of asserting them as room scenery.

**Net behaviour:** raw feed → existential spiral → (all fixes) → a **calm, self-aware** self
("my vision guesses wrong in the dark"). The ego's ~50–60% "coherent, not-broken" bar is met.

## Accepted model limitations (documented, NOT chased — assume the layer improves)

Per the layer-quality method (ego ~50–60%, conversation ~90–95%): take clean architecture/prompt
wins; for genuine model limits, accept them and test the layer above assuming imperfect input.
- **VLM object hallucination** (small vision model invents equipment) — mitigated by hedging.
- **Live diarization / stable speaker-IDs** — deliberately removed (produced "speaker 0" junk).
- **Gaze / head-pose** — derivable from face-api landmarks but not computed.
- **Name↔speaker binding** — blocked on diarization; names attach only via a real addressed turn
  ("I'm Guru") + face enrollment, not from overheard speech.

## The staged-validation plan (definition kept for reference; superseded by probing)

| stage | raw window | trim | wall-clock | purpose |
|---|---|---|---|---|
| 1 accelerated | ~2 min | ~30 s | ~35–60 min | all components fire, no crash, catch bugs cheap — **DONE, PASSED** |
| 2 semi-real | ~30 min | ~5 min | ~4–6 h | realistic hourly timing — **not run to completion (superseded)** |
| 3 real | 6 h | 30 min | 12–24 h | production knobs, overnight — **not run** |

**Stage 1 verdict (PASSED):** self-compression → span-summaries (faithful digests), fact-extraction
(store writes + dedup), restart-survival (hot-reload mid-run), ego reads long-term + recent + gaps,
trace retention. Bugs caught + fixed by the accelerated-first plan: day→record-granular trim,
hourly-bucket fragmentation, VLM-fact hallucination.

**Why 2–3 were superseded:** Stage 1's real data exposed the *behavioural* failure (the ego
spiralling on noisy perception) that no amount of longer soaking would fix — it needed the
reconciled-feed + addressed-flag fixes. Those were found and verified with **interactive probing**
(`behave.py`) in minutes per iteration, not hours. The long real-cadence soaks remain available
(the drivers + env knobs exist) if a duration/endurance check is wanted later.

## Test tooling

- `scripts/behave.py` — interactive REPL to drive the real station step-by-step (see/hear/say/
  here/gap/introspect/ego/facts). `hear` = overheard; `say` = a real addressed turn. **The primary
  instrument.**
- `scripts/perceive_inject.py` — faithful vision/speech/identity record injection (speech carries
  the addressed flag).
- `scripts/fullsystem_soak.py`, `scripts/soak.py` — the staged soak drivers.
- `scenarios/real-noise.txt` — recreates the noisy room data (overheard workout + VLM hallucination).
- Env knobs (acceleration): `PERCEPTION_RETAIN_MS`, `PERCEPTION_TRIM_INTERVAL_MS`,
  `PERCEPTION_BUCKET_MINUTES` (60=prod hourly; low for tests), `PERCEPTION_OFFLINE_GAP_MS`,
  `EGO_INTROSPECT_IDLE_MS` / `_GAP_MS` / `_EVENT_FLOOR_MS`, `EGO_TRACE_KEEP_ALL_MS`.
- Findings: `RECONCILED-FEED-FINDING.md` (the behavioural fixes), `SOAK-FINDINGS.md` (the arc sims).

## CURRENT STATUS

- **Build:** complete, typechecks (server + web), **committed** (branch `docs/ego-design`, 3 commits;
  not pushed). Tests 546/547 (1 pre-existing flaky task-timeout, unrelated).
- **Behavioural fixes:** shipped + verified via `behave.py` on real noisy data.
- **No station currently running** for a soak (fast config was used for probing).

## WHAT'S NEXT (open, user's call)

1. **Probe the conversation layer** at the ~90–95% bar — the user-facing payoff of the addressed-
   flag: does the dock now reply ONLY to addressed speech and stay quiet on overheard chatter?
2. **Layer-transfer characterization** (the user's method): inject a known perception quality →
   measure ego quality; inject a known ego quality → measure conversation quality. Makes each
   layer's "given this input quality, this output quality" explicit.
3. **Endurance** (optional): if wanted, run a real-cadence soak (semi/real) for a duration check —
   drivers + knobs exist. Lower priority than 1–2.
4. **Push** the branch when ready (not done — awaiting explicit go).

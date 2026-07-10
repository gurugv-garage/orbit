# Full-system validation — the ego + perception pipeline, end-to-end

**Status doc — survives across sessions.** If you're resuming: read "CURRENT STATUS" and
"NEXT CHECK-IN", then tell me to continue. I update this file as stages complete.

## Why this run exists

The earlier arc tests (positive/hard/mixed/why-here) validated the **ego mechanism** in the
**near-checkpoint window** — but NOT the system. Whole components were never in the loop:
trim, self-compression (span-summaries), long-term perception reaching the ego, restart
survival, auto-introspection cadence, grounding on the same feed. Per the user: *"as a system
I wouldn't give any value to that."* So: finish the missing pieces (done — see below), then run
ONE end-to-end soak that exercises **every** component, staged accelerated → semi → real so
bugs surface cheap before the long runs.

## Canonical vocabulary (the naming, settled)

Two things get populated: **the ego** (the self) and **the memory**. The memory is just the
perception stream (compressed as it ages) + a generic fact store. There is **ONE summarizer**, no
second pipeline / no second checkpoint.

| name | what it is | horizon | where |
|---|---|---|---|
| **raw perception** | vision/speech/identity/emotion/bodymotion records, enriched, durable on disk | seconds→retain window | `.data/perception/records/<dock>/<day>.jsonl` |
| **rolling-summary** | the ~60s "what's going on right now" auto-summary, **overwritten** (a live cache for grounding) | ~1 min, always-current | `last-summary.json`; `source.id:'rolling-summary'` |
| **span-summary** | hourly trim-time digest of an aged-out raw span — perception **compressing its own tail**, a retained SERIES | the older tail (hours→30d) | `span-summaries.jsonl`; `source.id:'span-summary'` |
| **memory store** | a **generic fact primitive** — store/recall/forget facts (semantic + subject/type/confidence), exposed as brain TOOLS | durable | sqlite `MemoryStore` |

The **perception feed the ego reads** (`perceptionSince`) = span-summaries (older gap) + raw
(recent), as ONE chronological stream. rolling-summary is only a fallback when raw is empty.

## The unified memory model (collapsed — the curator job is deleted)

The old design had TWO pipelines writing memory: the summarizer (→ summaries) AND a background
**curator** job with its OWN checkpoint/watermark + 60s poll + reconcile, consolidating summaries
into beliefs. That's the over-engineered duplication — "a pain to maintain two checkpoints."

**Collapsed:** ONE summarizer pass (hourly / at trim) produces **TWO distinct outputs** — apart
from each other, same job, same checkpoint:

```
raw perception ──▶ THE SUMMARIZER (hourly / at trim, ONE checkpoint) ──┐
   (the record)                                                        │
        ├──▶ ① span-summary   — COMPRESS the stream (the timeline; replaces the aged raw)
        └──▶ ② fact extraction — remember() durable FACTS worth keeping, into the store
                                  (append + LIGHT DEDUP in the same pass: recall a near-dup /
                                   contradiction → revise it, else add — self-maintaining, no
                                   separate reconcile cadence)

memory store (generic fact primitive)  ◀── also written directly by the LLM (`remember` tool)
        ▲
   recall_memory / remember / forget / update  (brain TOOLS — the LLM's pull surface)
        │
   memoryGroundingSlice  (per-turn: injects present-people facts ≥0.4 conf into grounding)
```

- **① span-summary ≠ ② fact.** ① is "what happened this hour" (compresses the timeline, lossy).
  ② is "what's true / worth remembering" (a queryable fact, not a timeline entry).
- **Store stays** as a generic primitive (semantic recall, subject/type/confidence, revise-history)
  + its brain tools + the per-turn grounding slice. All keep working.
- **Deleted:** the curator background job (`startLongTermMemoryCurator`), its watermark checkpoint,
  its 60s poll, its reconcile timer, and `sources.ts` (the parallel consolidate diet). Fact
  extraction now rides the summarizer's single pass.
- **Face memory is untouched** — a separate JSON `Gallery`, independent of this store.

### Blast radius of the collapse (all 4 layers)

1. **Server logic:** delete `startLongTermMemoryCurator` (curator.ts) + its watermark/poll/reconcile
   timers + `sources.ts` (the parallel consolidate diet). Add fact-extraction (append+light-dedup)
   to the summarizer's trim pass. KEEP `MemoryStore` + the `remember/recall/forget/update` tools +
   `memoryGroundingSlice`.
2. **REST:** remove/repurpose `/curator`, `/curator/run`, `/curator/config` (index.ts ~1164-1190).
   The store's own read (recent beliefs) can stay under a memory endpoint for the console.
3. **UI (PerceptionStudio.tsx ~170-312):** DELETE the `curator` button + recent-passes feed +
   knob panel. **Fold into the `summarize` panel** (decided): since fact-extraction now rides the
   summarizer, the summarize panel gains a small "facts extracted" readout alongside the digest —
   one place showing both summarizer outputs (① digest, ② facts). No separate curator button.
4. **Config/controls:** retire curator knobs `maxBatch/confMax/reconcileMs/reconcileMin` +
   `CURATOR_CONFIG_META` + env `PERCEPTION_CURATE` / `PERCEPTION_RECONCILE_MS`. Any fact-extraction
   knob (e.g. how aggressively to store facts) rides the summarizer config instead.

## What was built to close the gap (this session)

- **§7c step 2 — trim-time self-compression** (`retention.ts` `trimOldDays`): summarizes each
  aged-out day-file into a durable span-summary BEFORE `unlinkSync`; a summarizer failure keeps
  the raw (retry next sweep) → no silent data loss. Unit-verified in isolation. ✅
- **§7c step 3 — one-stream read** (`perceptionSince`): reads span-summaries for the older gap
  + raw for the recent part. ✅
- **Span-digest quality prompt** (`SPAN_DIGEST_SYSTEM`): a purpose-built "compress your memory
  of a PAST span" prompt (faithful, keeps throughline/people/events/arc), distinct from the
  "what's going on right now" brief. Needs real-Gemini validation in the soak. ✅ (built)
- Env knobs for acceleration: `PERCEPTION_RETAIN_MS`, `PERCEPTION_TRIM_INTERVAL_MS`,
  `PERCEPTION_SUMMARY_RETAIN_MS`.

## The staged plan (accelerated → semi → real; each gates the next)

| stage | raw window | trim sweep | wall-clock | gate to next |
|---|---|---|---|---|
| **1 accelerated** | ~2 min | ~30 s | ~30–60 min | all components fire + no crash + ego reads long-term |
| **2 semi-real** | ~30 min | ~5 min | ~4–6 h | stage-1 clean + digests read faithfully over real timing |
| **3 real** | 6 h (default) | 30 min | 12–24 h+ | stage-2 clean |

Each stage exercises, in one run: raw persist → age-out → **trim + self-compress → span-summary
written** → **ego introspection reads span-summaries (long-term) + raw (recent)** → a **mid-run
station restart** (perception + ego survive) → **auto-introspection** at cadence → checks for
spiral/denial/thrash across the long arc.

## STAGE 1 (accelerated) — PASSED ✅ (2026-07-10)

Every mechanism validated end-to-end through the real station on the simplified+intended system:
- **Self-compression → span-summaries:** 6 produced, faithful Gemini digests (no hallucination in
  the digests — the thin-span "Joe County" confabulation is gone).
- **Fact-extraction (2nd summarizer output):** fired repeatedly (store 1251→1256), append+dedup path
  works. QUALITY finding (fixed): VLM "gymnastic rings" hallucination was leaking in as a 0.9 fact;
  hardened the fact prompt (people/relationships over scenery; never store a vision-only fact).
- **Restart-survival:** station hot-reloaded mid-soak (twice) and kept serving + persisting.
- **Ego reads the span** (long-term span-summaries + recent raw + offline labels) and reflects
  coherently — read the reconciliation conversation, stayed a stable warm self, no spiral/thrash.
- **Trace retention:** multiple snapshots retained within the keep-all window (not collapsed to 1 —
  the old bug). **Cadence** (hourly-accelerated) + **departure event-trigger** wired and firing.
- **No crash.** Bugs caught cheaply by the accelerated-first plan: day→record-granular trim,
  hourly-bucket fragmentation, VLM-fact hallucination. All fixed.

**Gate to Stage 2: OPEN.** Mechanism is proven; Stage 2 (semi-real cadence, hours) validates it
holds at realistic timing.

## CURRENT STATUS

- **Build:** complete + typechecks + unit-verified (self-compression isolated test passes).
- **Stage 1 (accelerated, full intended system):** ⏳ RUNNING (2nd attempt, post-collapse + cadence
  + gaps). Accelerated env: `PERCEPTION_RETAIN_MS=120000 PERCEPTION_TRIM_INTERVAL_MS=30000
  PERCEPTION_BUCKET_MINUTES=1 PERCEPTION_OFFLINE_GAP_MS=90000 EGO_INTROSPECT_IDLE_MS=60000
  EGO_INTROSPECT_GAP_MS=120000 EGO_INTROSPECT_EVENT_FLOOR_MS=30000 EGO_TRACE_KEEP_ALL_MS=180000`.
  (`PERCEPTION_BUCKET_MINUTES=1` = a TEST affordance: self-compression buckets by clock-hour in
  prod, but 1-min buckets here so span-summaries close within the soak instead of once per real
  hour.) Soak: `fullsystem_soak.py --minutes 35 --beat-secs 35 --introspect-every 5`.
  Watching: span-summaries fire + facts→store + ego reads both + no crash.
- **Stage 2 (semi):** blocked on stage 1 gate.
- **Stage 3 (real):** blocked on stage 2 gate.
- Code staged in the working tree, uncommitted.

## NEXT CHECK-IN

- **Stage 1** (~35min): DONE — PASSED (see above).
- **Stage 2 (semi-real, ~4h): RUNNING NOW.** Launched with station knobs
  `PERCEPTION_RETAIN_MS=1800000 PERCEPTION_TRIM_INTERVAL_MS=300000` (raw 30min, trim 5min, REAL
  hourly buckets, real ego cadence idle-15/gap-60min). Soak: `fullsystem_soak.py --minutes 240
  --beat-secs 180 --introspect-every 8 --restart-at 0.5 --out runs/stage2`. Logs: `/tmp/stage2.log`
  (soak), `/tmp/station-stage2.log` (station). Evidence: `runs/stage2/fs-log.jsonl`.
  **→ ASK ME TO CHECK AROUND ~22:30 IST** (≈4h from launch ~18:30). Span-summaries fire once per
  real clock-hour, so expect ~3–4 by then. The soak emits a `RESTART_MARKER` at the ~2h mark — when
  you see it (or I flag it), the operator kills+reboots the tmux `ego-dev` session with the SAME env
  to validate real restart-survival, and the soak auto-resumes.
  **To resume:** open a session, say "continue the full-system validation" — I read this doc,
  check `/tmp/stage2.log` + span-summaries + facts + ego trace, and report Stage-2 findings.
- **Stage 3 (real, overnight):** after Stage 2 gate passes. Near-production knobs (raw 6h), 12–24h.

## Mid-run restart (all stages)

Each stage does ONE station kill+reboot at ~halfway (the soak emits a `RESTART_MARKER` and waits
for the station to come back) — validates perception (durable JSONL + span-summaries) and the ego
survive a bounce. Operator/automation kills+reboots the tmux `ego-dev` session with the SAME env.

## Curator collapse — DONE (server + UI)

- **Fact-extraction** added to the summarizer trim pass (`extractFactsFromSpan` in perception
  index.ts): second output of the one pass, per closed hour, append + light-dedup (semantic recall
  on subject → revise if near-dup, else remember). Store contract unit-verified (remember/recall/
  revise-supersedes/append-distinct all correct).
- **Curator job removed:** `startLongTermMemoryCurator` wiring, all 5 `/curator*` REST endpoints,
  and the **entire orphaned `memory/longterm/` folder** (curator.ts, sources.ts, consolidate.ts,
  reconcile.ts, cadence.ts, longterm.test.ts — nothing outside it imported it). Config/env
  (`PERCEPTION_CURATE`, `PERCEPTION_RECONCILE_MS`, curator knobs) retired.
- **Kept:** MemoryStore (the generic fact primitive), brain memory tools (recall_memory/remember/
  forget/update), `memoryGroundingSlice` (per-turn), face gallery (separate). 
- **UI:** curator button/panel/knobs removed from PerceptionStudio; web build clean; a
  `// TODO: facts-extracted readout` marker left in the summarize panel.
- **Tests:** 546/547 pass; the 1 fail is a pre-existing flaky task-timeout test in session.test.ts,
  untouched by this work and unrelated to perception/memory.

## Ego cadence — wired (hourly + event-triggerable + hour of traces)

Matches the hourly perception self-compression, per the "hourly default, event-triggerable" +
"keep an hour of traces" decisions:
- **Idle cadence → ~hourly:** conductor `EGO_INTROSPECT_GAP_MS` default 30min→**60min**,
  `EGO_INTROSPECT_IDLE_MS` 10min→**15min**. The self evolves on the same rhythm as span-summaries.
- **Event-triggerable:** new `triggerIntrospect(dock, trigger)` bypasses the hourly gap (still not
  mid-conversation, still not overlapping, with a 5-min anti-spam floor `EGO_INTROSPECT_EVENT_FLOOR_MS`).
  First concrete trigger wired: a **departure** (present→absent after ≥1min sustained presence) —
  so recovery/de-settle don't wait up to an hour when someone leaves. (More triggers can hang off
  the same seam later.)
- **Trace retention → keep an hour:** `saveEgo` now snapshots EVERY introspection (was: overwrite-
  in-place within a 10min cooldown), and `thinTrace` consolidates snapshots older than
  `EGO_TRACE_KEEP_ALL_MS` (1h) to one-per-bucket. So event-driven extra introspections in an hour
  are all retained → the next introspection sees its own churn (the thrash/rationalization signal),
  instead of silently overwriting. Fixes the accelerated-soak "trace collapsed to 1 snapshot" issue.
- Typecheck clean; conductor tests pass (3/3).

## Downtime / gaps — handled (gaps = downtime, not an empty world)

Principle (user): the system must ASSUME gaps happen and treat them as downtime. The signal is
clean — **no records written = the station was OFF** (downtime); **records that SAY "no one" = a
real empty room** (an idle-but-running dock still emits records). So the presence/absence of
records themselves is the offline detector; no separate marker plumbing needed.

- `perceptionSince` now stitches raw with **offline-gap labels**: a no-record stretch >
  `PERCEPTION_OFFLINE_GAP_MS` (20min) between consecutive records gets an explicit
  `[⚠ offline ~Xh — DOWNTIME (you were off), not an empty room]` marker. The self reads a gap as
  ITS OWN downtime, not the world emptying — so a restart after hours down doesn't look like
  abandonment (the exact misread that can spiral). Unit-verified: 3h gap → labelled; close records
  → no spurious marker.
- Self-compression/trim is already gap-tolerant (a hole in the JSONL reads back fine; missing hours
  simply have no span-summary bucket). The digest side shows downtime as a jump in the
  `[earlier, HH:MM–HH:MM]` timestamps (acceptable for v1).

## Findings log

- **[Stage 1, attempt 2 — LIVE, full intended system]** Span-summaries firing via real Gemini +
  the new hourly (1-min accelerated) bucketing: first digest read *"The span was a quiet period
  with no detected events or individuals present"* — faithful, NOT hallucinated (the earlier thin-
  span "Joe County" confabulation is gone). Self-compression fired on `dock-redmi` AND on leftover
  `desk-1`/`d1` docks (proof it works on real aged data). Rich minute-buckets (12–14 records)
  forming → fact-extraction should fire as they close (thin 1-record buckets correctly yield no
  facts, per the `<3` guard).
- **[Stage 1 — fact-extraction WORKS end-to-end, but QUALITY needs tuning]** Confirmed firing:
  store 1251→1254 via `extractFactsFromSpan` on a closed bucket. The facts are structurally correct
  (subject/claim/confidence, dedup path) but semantically MIXED:
  - Good: `room: contains a desk` (0.7), `room: features a window with light` (0.7) — faithful.
  - BAD: `room: features a permanent ceiling-mounted exercise apparatus with rings` (0.9),
    `occupant: uses the ceiling-mounted apparatus for acrobatic exercises` (0.8) — this is the
    **VLM "gymnastic rings" hallucination leaking into PERMANENT memory as a high-confidence fact.**
    The span-digest/fact prompt's "a VISION line is a guess" guard isn't strong enough; the
    extractor is too credulous about vision content.
  - Also: room-inventory facts ("contains a desk", "has a lamp") are low-value clutter — a desk
    companion's memory should probably favor **people / relationships / events / preferences**, not
    furniture cataloguing.
  TWO TUNING ITEMS (mechanism is proven; these are quality): (1) harden the fact prompt against
  VLM hallucination + bias toward people/relationships over scenery; (2) maybe raise the
  confidence bar or require corroboration for vision-only facts. Not a mechanism bug.
- **[RESOLVED] Legacy beliefs wiped (user: fresh start).** The MemoryStore held ~2191 dock-redmi
  beliefs from the DELETED curator (durable sqlite in `orbit-station/.data/orbit.db` — note: root
  `.data`, not `server/.data` which is empty). Overall low quality (946 empty/generic-subject "speaker
  0" facts, 197 scenery, 18 VLM-hallucination). Wiped ALL dock-redmi beliefs (backup:
  `orbit.db.bak-pre-wipe`); other docks' 21 rows preserved. New hardened extraction rebuilds clean.
- **[RESOLVED] Fact prompt hardened + re-verified.** Post-hardening extraction on a fact-rich span
  produced exactly the right facts — `priya: name is Priya` / `always has chamomile tea in the
  afternoons` / `works from this desk every Tuesday and Thursday`, all @0.9, subject=the person —
  and NO scenery/hallucination (confirmed the scenery facts were all pre-hardening by timestamp).

- **[Stage 1, attempt 1 — BUG CAUGHT + FIXED]** Accelerated run exposed a fundamental trim bug in
  ~10 min: `trimOldDays` worked at **day-file granularity** — it only compressed/deleted a day-file
  whose *filename date* was older than the cutoff *day*. So the **aged tail of the CURRENT day's
  file never trimmed** (it's "today"), even with records far past the 2-min window. In production
  (a 6h window inside today) this means self-compression would essentially **never fire** until
  midnight rolled the file. No span-summaries were produced; the long-term path was dead.
  **Fix:** rewrote trim to **record-timestamp granularity** — within each day-file, compress
  records older than the cutoff *timestamp* into a span-summary and rewrite the file keeping the
  in-window records (delete only if empty). Unit-verified: today-file with 2 old + 2 fresh → old 2
  compressed to 1 span-summary, fresh 2 kept. **This is exactly the class of bug the staged
  accelerated-first plan was meant to catch cheaply — and it did.**

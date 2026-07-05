# idle-moods — live test runbook

How to watch + verify the dock's idle mood bits (bored / curious / attention / sleepy /
flavor) end-to-end on a real dock. Mirrors [facefollow-live-test.md](facefollow-live-test.md).
Design: the `moods` conducted thing ([conducted.ts](../../orbit-station/server/src/modules/conductor/conducted.ts))
gates WHEN; the `idle-moods` task's pure picker
([picker.ts](../../orbit-station/server/src/tasks/packaged/idle-moods/picker.ts)) picks WHICH.

## Ground truth surfaces

- `GET /api/conductor/<dock>` — the `moods` entry: `desired` / `running` / live `status`
  ("last bit: bored.sigh (spoke)") + tunings. Same view in the console **Conductor tab**
  (each task card shows the live ◉ status line).
- Task log: `.data/brain/<dock>/tasks/<instanceId>/task.log` — one
  `[mood] ts=… bit=<id> speak=<bool> faces=<n>` line per performed bit;
  `preempted mid-bit` / `body busy — skipped a bit` on contention.
  (Instance id from `GET /api/brain/<dock>/instances`.)
- Station log: `[cond] <dock> moods: off→running (start)` transitions, `[lease]` lines
  (a bit holds at **35**, face-follow at 30, brain turn 60), `[wake]`/turn lines for spoken bits.
- `GET /api/bodylink/holder?dock=<dock>` — who drives the body right now.

## Flows

**A. First bit.** Idle the dock ≥ `activateAfterMs` (default 5 min; drop it in the Conductor
tab to speed up). Expect `[cond] … moods: off→running`, then within `bitMinMs..bitMaxMs`
(3–8 min default; 3× sparser in quiet hours — drop them for testing) a `[mood]` line and
visible motion (fidget / slow look / gesture); between bits face-follow re-takes the body
(holder flips task:…@35 → task:…@30). The picker never repeats the same bit twice in a row.

**B. Preemption mid-bit.** Trigger a brain turn (talk to the dock) during a bit: the task is
stopped by the conductor within ~1 s (conversation → `moods off`); if the turn starts
mid-step, the log shows `preempted mid-bit — abandoning` and the body frees ≤ 1 lease TTL
(1.5 s). Body must never fight the brain gesture.

**C. Spoken bit.** Tunings: set `speakMinGapMs: 0`, `speakIdleMinMs: 0`, then **Stop → Run
now** (tunings are a snapshot at task start). Expect a `[mood] … speak=true` line, then the
dock speaks a fresh LLM-authored line (an autonomous self-turn — check the Brain view).
A second spoken bit within 5 min must be refused (`think` returns rate-floored — the
station-side floor beneath the tunable gap). Restore the tunings after.

**D. Quiet hours.** Set `quietStartHour` to the current hour (+ `quietEndHour` past it),
Stop → Run. Only `sleepy.*` bits appear, all `speak=false`. Restore.

**E. Attention.** Sit in view ≥ `attentionAfterMs` (default 3 min) without talking:
`attention.*` bits join the pool (perk / double-take / spoken offer — the offer also needs
the speak gate). Only ONE attention bit plays per presence stretch (leave the room and
return to re-arm it). Walk away: `faces=0` lines and no `attention.*` bits.

**F. Kill/heal.** `kill -9` the idle-moods process: the body frees ≤ 1 TTL, the conductor's
idempotent reconcile restarts it next tick (new instance).

## Notes

- Both conductor tasks (face-follow, idle-moods) count against `brainTaskMax` (default 4).
- Mood thoughts ride `coalesceKey mood:<dock>` + 60 s expiry — a line queued as a
  conversation starts goes stale and is never spoken late.
- The `moods` weights (`wBored` … `wFlavor`) are per-mood multipliers; `0` disables a mood
  live (next task start).

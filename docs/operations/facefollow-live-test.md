# faceFollow — live test protocol

> The **happy-path capability test** on real hardware (dock-redmi: phone + body).
> The unit/sim tests prove the *logic*; this proves the *behaviour on the machine*
> (real detection sparsity, servo response, eye-landmark intermittency). Run it
> deliberately — one flow at a time, each with a clear do→expect→pass — and judge
> from the **ground-truth event log**, not by eyeballing the camera.
>
> Tooling (all in `orbit-station/`):
> - The task emits `[ff-event]` transition lines (acquire/lose/search/relock/yield/
>   resume) + an `[ff-tick]` metric line per tick, under env `FF_MEASURE=1`.
> - `node scripts/ff-validate.mjs <task.log> [--mode salient|named] [--name X]` reads
>   the log and prints PASS/FAIL per flow (judged from numbers, not by eye).
> - `npx tsx scripts/ff-simlog.mjs [--mode …] [--name X]` drives the REAL controller
>   through a scripted world and emits the same log format — a DRY RUN of the validator
>   without hardware (it caught two validator bugs before the first live run).
> Launch mechanics (REST instances endpoint, task.log path): the face-follow howto
> memory + [perception-runbook](perception-runbook.md).

## What we're testing (the user's flows)

Two modes, the SAME flow set:
- **Salient mode** (`target` unset) — follow the most-salient face; on loss, re-pick
  whoever is salient next (could be a different person).
- **Named mode** (`target: "<name>"`) — follow ONLY that person; a salient face never
  substitutes; on loss, keep searching for THEM.

### The flows (each is one deliberate step)

| # | Flow | DO | EXPECT (observable) | PASS criteria (from the log) |
|---|------|----|--------------------|------------------------------|
| F1 | **Acquire** | Stand in front, centered | It points at me + holds | An `acquire` event within ~3 s of a face appearing; then `track` |
| F2 | **Hold-when-still** | Stay centered + still ≥ 20 s | Head holds, no twitch | Over the hold window: 0 (or ≤1) move commands; lock name/pos stable; **no `lose`/`search`** |
| F3 | **Ignore micro-move** | Sway slightly (within deadband) | No head motion | No move commands while error stays < deadband |
| F4 | **Follow significant move** | Step clearly to one side, hold | Head pans/tilts to re-center | A burst of move commands, error returns toward 0, lock retained (same lock id) |
| F5 | **Lose → search** | Leave the frame entirely | After the grace, it sweeps | A `lose` event, then `search` events with a changing sweep pose (foot scanning) |
| F6 | **Re-acquire (salient)** | Re-enter at a different spot (or a different person enters) | It locks onto the now-salient face | A `relock` event onto the visible face; back to `track` |
| F7 | **Lose again → search again** | Leave again | Sweeps again (stable forever-loop) | A second `lose`→`search`, no crash, runs indefinitely |
| F8 | **Hold DURATION + stability** | Sit centered 60 s | Stays locked the whole time | Lock duration ≥ 60 s; name-flip count low; not bouncing track↔search |

### Named-mode delta (re-run F1–F8 with `target:"<name>"`)
| # | Flow | PASS criteria |
|---|------|---------------|
| N1 | **Named acquire** | Acquires ONLY when the named person is matched (lock name == target) |
| N2 | **No substitution** | With a DIFFERENT person in frame (named one absent), it does NOT lock them — stays in `search` |
| N3 | **Named lose → keep searching for THEM** | On loss it searches; a newcomer never becomes the lock |

## Pass/fail is judged by `ff-validate.mjs`, not by eye

The script consumes the `[ff-event]`/`[ff-tick]` log and reports, per flow:
- **acquire latency** (face-seen → acquire), **hold duration**, **move-command count
  during a hold**, **name-flip count**, **track↔search bounce count**, **sweep span**
  during search, and the **named-substitution check** (did a non-target ever get locked).

A flow is GREEN only when its measured numbers meet the criteria above. "I saw it
move once" is not a pass.

## How to run (summary)

1. Sidecars + station up; phone (build ≥16) + body online; perceive stream flowing
   (see the howto / runbook).
2. Launch salient: `POST /api/brain/dock-redmi/instances` `{name:"face-follow",
   params:{tick:"700ms"}}`. Watch `…/tasks/<id>/task.log`.
3. Walk the flows F1–F8 in order; narrate each step so the log timeline is segmentable.
4. `node scripts/ff-validate.mjs <task.log>` → per-flow PASS/FAIL.
5. Stop the instance. Re-launch with `params.target:"<name>"`, repeat for N1–N3.

## Known real-world limits (not failures of these flows)
- Detection is bursty + eye-landmarks intermittent → brief neck dips on eyeless frames;
  the ride-through (asymmetric grace) is what keeps a hold alive. F2/F8 tolerate ≤1 move.
- Off-frontal faces detect poorly → F4 expects a *clear* move, not a profile turn.

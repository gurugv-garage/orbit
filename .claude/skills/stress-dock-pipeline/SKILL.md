---
name: stress-dock-pipeline
description: >-
  Hammer the dock's conversation pipeline to find where it BREAKS — not a happy-path
  demo. Drives real audio from the laptop speaker, taps to address via adb, and judges
  every turn from the station's ground-truth (addressed-decision trace + STT-sidecar
  log) plus screenshots. Use when reproducing/validating a conversation, STT, listening,
  or restart bug: rapid back-to-back turns, disfluent "um/uh" lines, mid-conversation
  taps/barge-in, window-timing edges, and restart cycles — each run MANY times because
  the real bugs are intermittent. Built from the methodology that cracked the
  post-restart no-STT bug (docs/rca/2026-06-22-post-restart-no-stt.md).
---

# stress-dock-pipeline — find where the dock conversation breaks

You (Claude) are the tester. This laptop is one acoustic participant; a real dock is the
other. You **tap it via adb**, **speak via the laptop speaker**, and **judge from the
station**, not from vibes. The goal is to **break it and localize the break** — STT
mishearings, no-reply, listening-but-ignored, restart flakiness, barge-in failures.

## The method that actually works (follow this — it's hard-won)

1. **Instrument, then reproduce — don't theorize.** Every wrong turn on dock bugs came
   from reasoning ahead of evidence. Read the authoritative surfaces:
   - `GET /api/brain/<dock>/conversation` → `{mode, msToExpiry}` (is it listening? how long left?)
   - `GET /api/brain/<dock>/debug/addressed` → why each utterance did/didn't become a turn
     (`RAN-TURN` | `skip:not-addressed` | `skip:garbage` | `skip:no-words` | `skip:recording`)
   - the STT sidecar log (`/tmp/stt-sidecar-parakeet.log`) → did STT actually run? a turn
     with **0 new `/transcribe`** never reached the recognizer.
2. **Tight loops, MANY reps.** Intermittent bugs (the common kind here) only show over
   many runs. Run a scenario 6+ times and report a **rate** (e.g. "3/6 broken"), never a
   single anecdote.
3. **Validate with screenshots, and check the on-screen state MATCHES the logs.** If the
   logs say "broken" but the screen showed green/listening, that mismatch IS the bug
   (e.g. an indicator lying). Don't trust one signal alone.
4. **Start each trial from a known state** (`wait_idle`) — otherwise a stray tap toggles
   the window OFF and you mis-blame the pipeline.
5. **Be honest about which failure class you hit.** "Spoke after the window expired" (UI
   not listening) is EXPECTED, not a bug. "UI shows listening + I spoke in time + no
   reply" is the real bug. The trace's before-state tells them apart.

## Setup (check once)

- Station up (`http://127.0.0.1:8099`); dock online with an **audio** producer:
  `curl -s localhost:8099/api/media/status`.
- Laptop speaker audible to the dock mic (not so loud it clips).
- Device on adb (`adb devices`). Default tap target is screen-center (`TAP_X/TAP_Y` in
  `bin/lib.sh`); adjust if the dock layout differs.
- Set the dock name if not `anne-bot`: `export DOCK=...`. Other knobs: `STATION_BASE`,
  `STT_LOG`, `VOICE`, `RATE`, `SHOTDIR`.

## The scripts (in `bin/`)

- **`lib.sh`** — shared primitives: `mode`, `secs`, `decision`, `producer_audio`,
  `tx_count`, `tap`, `relaunch`, `shot`, `wait_idle`, `wait_producer`, `say_line`, and
  `trial "<line>" [pre_delay]` (address → speak → judge; returns 0 on `RAN-TURN`).
- **`repro-restart.sh [cycles]`** — the restart hammer: force-stop → relaunch → wait
  producer → speak → did a turn run? Reports OK/BROKEN rate. **This is the one that finds
  restart-class bugs.**
- **`hammer-convo.sh [rounds]`** — messy live conversation: disfluent lines, numbers,
  names, topic shifts, rapid back-to-back, plus a **mid-reply barge-in** (tap+speak while
  it's talking). Repeats the set.
- **`probe-window-edge.sh [reps]`** — speak at increasing delays after the tap to probe
  the listening-window timing edge; separates the in-window RACE bug from expected
  expiry.

## How to run a session

1. Confirm setup (station + producer + adb). 
2. Pick the scenario matching the suspected area (restart → `repro-restart.sh`; general
   flakiness → `hammer-convo.sh`; "listening but ignored" → `probe-window-edge.sh`).
3. Run it; **read the printed DECISION + finals per trial**, and open a few screenshots
   from `$SHOTDIR` to confirm the UI matched.
4. For any BROKEN trial, drill in: was there a `/transcribe` (did STT run)? what does the
   addressed trace say? does the screenshot agree? Localize the layer, THEN form a fix.
5. After a fix, **re-run the same scenario the same number of times** and report the
   before/after rate as proof (e.g. "was 3/6 broken → now 0/6").

## What to report

A tally, not anecdotes: trials attempted, OK vs BROKEN rate, the worst examples quoted
as **SAID → HEARD → REPLIED**, and which layer each break is in (capture/STT/addressed/
brain/TTS/UI). Feeds docs/rca/ and docs/findings/.

## Reference

The post-restart no-STT RCA (docs/rca/2026-06-22-post-restart-no-stt.md) is the worked
example of this method — including the two wrong theories it ruled out before the
instrumentation showed a knife-edge VAD threshold. Read it before a similar hunt.

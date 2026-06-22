# Cleanup: single-owner for the dock's face / listening state

**Status:** problem statement + cleanup spec (NOT yet done). Several shipped fixes are
band-aids around this; this doc is the plan for the real fix.

<!-- TOC -->
<!-- /TOC -->

## The problem (one sentence)

The dock's **face/listening visual state has multiple uncoordinated owners** that race
each other, even though the **station is supposed to be the sole owner** of conversation
state — so the on-screen cue (glow / LISTENING pill / countdown) intermittently disagrees
with what the dock is actually doing.

## Why it matters

This is not cosmetic-only. When the visual state is wrong, the user **can't tell whether
it's listening**, so they talk into a dead window (→ "I spoke and it ignored me"), or
don't talk when they could. Every "is it a bug or intended?" question in this area traced
back to this. It also makes the system hard to test/trust: two cues from two sources
means a screenshot and a log can both be "right" and still disagree.

## The owners that currently fight (evidence)

The intended owner is the **station** (`conversation-state.ts`; docs/findings/
conversation-state-design.md: "the phone is a pure RENDERER"). In practice the FaceController
(`FaceState.Listening/Speaking/Idle/...`) is written by several places:

1. **Station conversation frames** → `RemoteBrain` `_convMode` → `PerceptionWiring.renderConvMode`
   → `controller.listen()/silence()`. (The intended path.)
2. **Local TTS edges** → `DockTts.finishUtterance` / `stop()` call `face.silence()` directly
   on the Speaking(false) edge.
3. **Local perception / barge-in** → `DockScreen.bargeIn` calls `tts.stop()` (which silences)
   then we had to re-assert `controller.listen()`; `PerceptionWiring` also drove face from
   face-arrival in the past.
4. **DockTools** (`face.silence()` on turn wind-down) and the dev panel.

Two concrete races already fixed as band-aids (see git log / docs/rca):
- **Glow only triggered from Idle** → station-opened windows from other states showed
  countdown but no glow. (Patched: trigger from any non-Listening state.)
- **Tap-during-speech**: `tts.stop()`'s synchronous `face.silence()` clobbered the station's
  incoming listening update → "stopped speaking but not visibly listening." (Patched: assert
  `controller.listen()` LAST in the barge-in path.)

Both patches work but are **ordering-dependent** — exactly the fragility a single-owner
model removes.

## What a cleanup MUST address

1. **One writer for listening/attending state = the station's conversation mode.** The
   FaceController's Listening/Idle/Followup should be a pure projection of `convMode`
   (idle→Idle, listening/followup→Listening, thinking→a thinking look, speaking→Speaking).
   Local code stops calling `controller.listen()/silence()` to mean "attending."
2. **Separate "is the dock speaking (TTS playing)" from "is it attending."** TTS playback is
   a local fact (the phone owns audio), but it must feed the face as a *speaking* overlay,
   NOT silence the attending state. Today `face.silence()` on TTS-end conflates them.
3. **No ordering dependence.** After the refactor, the order of (TTS-stop, station frame,
   barge-in) must not change the final face state — it's a function of the latest convMode +
   local speaking flag, not a sequence of imperative mutations.
4. **The three cues stay consistent by construction** — glow, LISTENING pill, and countdown
   all read the SAME source (convMode + windowUntil), so they can't disagree.
5. **Don't regress the working behaviors:** auto-followup listening after a reply, tap-to-
   address, tap-interrupt (barge-in) → listening, window countdown, mic-ready indicator.

## Suggested approach (sketch, not prescriptive)

- Make `convMode` (+ `windowUntil`) the single StateFlow the face derives from. A small
  mapper: `convMode → FaceState` for the attending dimension; a separate `ttsSpeaking`
  flow for the speaking overlay.
- Delete the direct `controller.listen()/silence()` calls in PerceptionWiring/bargeIn/
  DockTts that mean "attending"; keep only the station-driven mapper.
- Keep `DockTts` emitting a `speaking` boolean (it already does, via `onSpeakingChanged`)
  but route it to a *speaking overlay*, not to silencing attending.
- Audit `DockTools.face.silence()` and the dev panel — dev/test pokes are fine, but mark
  them as such.

## How to test the cleanup (use the stress skill)

The bugs here are intermittent + ordering-sensitive, so test with the harness +
screenshot validation, MANY reps, cross-checking on-screen state vs the station:

1. **Tap-during-speech (barge-in)** ×10: after the tap, the screenshot must show glow +
   LISTENING pill + countdown, AND `mode=listening`, AND a follow-up spoken immediately is
   `RAN-TURN`. (`stress-dock-pipeline/bin/hammer-convo.sh` has the barge-in probe; add a
   screenshot-assert.)
2. **Back-to-back followup turns** ×10: glow/pill/countdown stay correct across reply→
   followup→next turn with no fl. (hammer-convo).
3. **Restart** ×6 (`repro-restart.sh`): after restart the cues are correct once the stream
   is ready; never green/listening while STT gets 0 transcribes.
4. **Window expiry**: when the window lapses, glow + pill + countdown all clear together
   (no orphaned glow, no stale countdown). (`probe-window-edge.sh` + screenshots.)
5. **Ordering stress**: rapidly tap during speech, then immediately tap again, then speak —
   the final state must be deterministic (listening), not dependent on timing.

Acceptance bar: for each, report a before/after rate and attach 2-3 screenshots proving
the cues agree. No band-aid `controller.listen()`-last hacks should remain.

## Pointers

- Conversation state (the authoritative source): `orbit-station/server/src/modules/brain/
  conversation-state.ts`, docs/findings/conversation-state-design.md.
- Phone render path: `RemoteBrain` (`_convMode`, `_windowUntil`),
  `ui/face/PerceptionWiring.kt` (`renderConvMode`), `ui/face/ListeningGlow.kt`,
  `ui/face/FaceController.kt`, `ui/DockScreen.kt` (bargeIn, the Subtitle/countdown), and
  `tts/DockTts.kt` (`finishUtterance`/`stop` → `face.silence()`).
- Worked RCA in this area: docs/rca/2026-06-22-post-restart-no-stt.md.
- Test harness: `.claude/skills/stress-dock-pipeline/`.

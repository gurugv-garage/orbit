# Finding — voice "stop" ignored when it lands as the reply ends (idle-gate race)

**Date:** 2026-07-21 · **Dock:** dock-redmi (build 57) · **Status:** ROOT-CAUSED, fix
deferred (see below). Sibling to docs/rca/2026-07-21-barge-stop-continues.md.

## Symptom (user, live)

While the dock is telling a long story, saying **"stop"** often does nothing — the reply
keeps going. Confirmed the word DID reach perception correctly:
`"Okay, stop." … comes in perception — doesn't stop`.

## Ground truth (addressed trace, dock-redmi)

Same word, same clean STT (`tier=good`) — the ONLY difference is the conversation `mode`
at the moment the final was processed:

```
16:19:52  mode=idle       dec=skip:not-addressed   tier=good   text='Okay, stop withdrawing. Okay, stop.'   ← ignored
16:19:56  mode=idle       dec=skip:not-addressed   tier=good   text='Okay, stop.'                            ← ignored
16:20:20  mode=thinking   dec=stop:dismiss         tier=shaky  text='Stop, stop, stop.'                      ← STOPPED ✅
```

## Root cause

The reflex voice-stop / dismissal check is gated on **`pre.mode !== 'idle'`**
(`orbit-station/server/src/modules/brain/index.ts`, ~L829). A "stop" utterance takes
~ENDPOINT_MS (1.3s) + STT before it is classified. If, in that ~1.5s, the reply finishes
and the conversation state drops to `idle` (speakUntil expiry / TTS-end), the "stop" is
classified AFTER the state says idle → the whole stop-intent block is skipped → it falls
through to `skip:not-addressed`. The dock may still be AUDIBLY finishing its TTS on the
phone, so to the user it "didn't stop". A "stop" that lands while still `thinking`/
`speaking` works fine (`stop:dismiss`).

## Ruled out (earlier wrong theories this replaces)

- **Echo-masking** (docs/rca/2026-07-21-barge-stop-continues.md): NOT the cause here — the
  "stop" transcribed cleanly at `tier=good`. (Echo-masking is real but is a separate case.)
- **Self-motion mute** (`BARGE_MOTION_MUTE_MS`): red herring — measured body motion during
  a reply was ~1 move in 12s, not continuous. `barge:skip:self-motion` was a one-off.
- **ONSET_RMS threshold**: orthogonal — that change (this commit) fixes FALSE pauses on
  small noise; it does not touch this idle-gate path.

## Fix (deferred — analyzed, NOT applied)

Naive relaxation ("also fire stop-intent in idle") is UNSAFE — it re-opens room-chatter
bugs: a room "stop"/"wait" spoken shortly after any reply would `dismiss` / `tapOpen`
(the `pause` branch opening a listening window is the worst of it). The gate is the line
between "engaged → stop means stop" and "idle → it's just a word someone said."

The SAFE fix is an **overlap-timing check**, not a blanket grace: honor a stop in idle
ONLY if the utterance STARTED while the dock was still speaking — i.e.
`t.startedAt < lastSpeakEndAt` (the user began their "stop" during the reply, even though
the 1.3s endpoint pushed its processing past idle). A word spoken ENTIRELY after the reply
ended fails the check and stays room chatter — so no regression to the room-chatter class.
Also: honor only `dismiss` in this grace, not `pause` (opening a listen window on a grace
"wait" is the risky one). Precondition to implement: confirm a `speakEnd` timestamp
(lastSpokeAt) is available alongside `t.startedAt` — session.ts has `speakEnd()` but no
explicit `lastSpokeAt` field yet; add one.

## Related
- [[barge-clap-onset-fix]] · docs/rca/2026-07-21-barge-stop-continues.md ·
  [[speech-addressed-vs-overheard]] · [[conv-window-debugging]] (instrument, don't theorize —
  this bug was found by reading the trace `mode` column, after several wrong theories).

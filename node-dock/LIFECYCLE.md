# Conversation lifecycle & state transitions

How one back-and-forth flows through the dock, and every state machine
involved. This is the contract the unit tests (`AutoRelistenTest`,
`DockAgentTurnTest`, `DockToolsRealisticTest`, `FaceControllerTest`,
`PerceptionWiringTest`) pin down.

There is **no central state object**. Four small machines run in parallel and
communicate only through [`PerceptionBus`](app/app/src/main/kotlin/dev/orbit/dock/perception/PerceptionBus.kt)
events. Keeping them decoupled is deliberate — each is independently testable.

```
  tap / voice
      │
      ▼
┌──────────────┐  WakeWord/Transcript  ┌──────────────┐
│  Perception  │ ────────────────────▶ │   DockAgent  │
│   Pipeline   │                       │ (one POST →  │
│    + STT     │ ◀──────────────────── │   parse →    │
└──────────────┘  WakeWord (relisten)  │   dispatch)  │
      ▲                                └──────┬───────┘
      │ Speaking(bool)            speak() +   │
      │ onSpeakingChanged         setFace/body▼
      │                                ┌──────────────┐
      └──── AutoRelisten ◀──────────── │   DockTts    │
                                       └──────────────┘
```

Read left→right: a tap/voice utterance enters the **PerceptionPipeline**,
which emits `WakeWord`/`Transcript` events on the **PerceptionBus** to
**DockAgent**; DockAgent streams prose to **DockTts** (`speak()`) and fires
body/face tools (`setFace`); `onSpeakingChanged(false)` feeds **AutoRelisten**,
which re-arms the mic (emits a fresh `WakeWord`) for hands-free conversation.

Read left→right: a tap/voice utterance enters the **PerceptionPipeline**,
which emits `WakeWord`/`Transcript` events on the **PerceptionBus** to
**DockAgent**; DockAgent streams prose to **DockTts** (`speak()`) and fires
body/face tools (`setFace`); `onSpeakingChanged(false)` feeds **AutoRelisten**,
which re-arms the mic (emits a fresh `WakeWord`) for hands-free conversation.

---

## The happy path (voice turn, body connected)

1. **User taps** the screen while Idle → `DockScreen` emits `WakeWord("(tap)")`.
2. **Pipeline** opens a listening session, hands the mic to `SpeechRecognizer`,
   emits `SttListening(armed=true)`. Face → **Listening**.
3. **User speaks.** SR returns a final transcript → `Transcript(isFinal=true)`.
   - Pipeline ends the session, records it as a *voice turn* (`AutoRelisten.onVoiceTranscript`).
   - `PerceptionWiring.onUserUtterance` → `DockAgent.respond(text)`.
4. **DockAgent** (a thin facade over the pi-kt agentic loop in `:agent-core`):
   `respond(text)` → `Agent.prompt` drives a **tool-calling loop** against Ollama
   (`gemma4:e2b`, streaming `/api/chat` via `DockStreamFn`). The model streams
   spoken prose AND emits tool calls (`set_face`, `move_body`, `gesture`,
   `move_sequence` — see `DockToolsAdapter`); the loop executes them, feeds
   results back, and continues until it stops calling tools.
   AgentState: **Idle → Waiting → Thinking → Speaking → Idle** (per-action status
   like "looking left" while a tool runs). See **[UX.md](UX.md)** for the full
   agentic-turn interaction spec.
5. **Translation** (`DockAgent.onAgentEvent`): prose deltas → `speakSentence`
   (sentence-by-sentence TTS via `StreamingReplyExtractor`); `ToolExecutionStart`
   → fire-and-forget body move. **Speech and motion overlap** — neither awaits
   the other; tool results return to the loop immediately.
6. **DockTts** plays audio. `onSpeakingChanged(true/false)` drives Face
   Speaking/Idle as before.
7. **AutoRelisten** sees `Speaking(false)` for a pending voice turn →
   emits `WakeWord("(auto-relisten)")` → back to step 2. Hands-free loop.

(Vision: when a camera frame is available it rides the current user message so
the model can see; never replayed in history. The model decides actions via
native `tool_calls` — the old forced-JSON `{reply,face,body}` schema is gone.)

If the turn was **not** voice-initiated (e.g. a debug `SAY` with no prior
session, or a proactive line), step 7 does **not** fire — the dock returns to
Idle and waits for a tap.

---

## State machine 1 — FaceState (the on-screen face)

Owner: [`FaceController`](app/app/src/main/kotlin/dev/orbit/dock/ui/face/FaceController.kt).
Drives what the face looks like. Five states:

| State | Meaning | Entered by |
|---|---|---|
| `Idle` | breathing/blinking | `silence()` |
| `Engaged` | woke up, not yet listening | `wakeUp()` from Idle |
| `Listening` | mic armed, user talking | `listen()` |
| `Speaking` | TTS playing | `speak()` |
| `Illustrating` | showing content, face in corner | `illustrate()` |

```
        listen()                    speak()
 Idle ──────────▶ Listening ──────────────▶ Speaking
  ▲  ▲                │                         │
  │  │ wakeUp()       │ silence()               │ silence()
  │  └── Engaged      │                         │
  │                   ▼                         ▼
  └──────────────── silence() ◀────────────────┘
```

Transition rules that matter:
- `listen()`, `speak()`, `illustrate()` all call `wakeUp()` first (Idle→Engaged
  guard), so the face never appears asleep mid-interaction.
- Only `silence()` returns to Idle. The pipeline emits exactly **one**
  `session_ended` per empty session so the face drops to Idle once — never
  flickers Idle↔Listening across the recognizer's internal churn.
- A final transcript does **not** silence the face — the agent owns it from
  there until TTS finishes.

## State machine 2 — AgentState (what the agent is doing)

Owner: [`DockAgent`](app/app/src/main/kotlin/dev/orbit/dock/agent/DockAgent.kt).
Surfaced to the UI status line. (`ToolCalling` is emitted transiently by tools.)

```
 Idle ─respond()─▶ Waiting ─first tokens─▶ Thinking ─prose─▶ Speaking ─loop ends─▶ Idle
                                              │  ▲              │
                              tool runs ──────┘  └─ ToolCalling("looking left") ─┘
                                              (loop may iterate: tool → result → more prose/tools)
   any phase ── transport error ──▶ Failed     stop()/supersede ──▶ Idle
```

| State | Meaning |
|---|---|
| `Idle` | no turn in flight |
| `Waiting(model)` | prompt sent, no tokens back yet |
| `Thinking(model)` | model streaming (before first spoken sentence) |
| `ToolCalling(phrase)` | a tool is executing — phrase is human ("looking left") |
| `Speaking` | a sentence was streamed to TTS |
| `Failed(msg)` | model unreachable / errored |

Guarantees (see `DockAgentTurnTest`):
- A new `respond()` **cancelAndJoins** the in-flight turn before starting (pi-kt
  is one-run-at-a-time; the join avoids a "busy" race) and `tools.stopBody()`.
- `stop()` (barge-in / long-press) → cancels turn, `agent.reset()`,
  `tools.silence()`, → Idle.
- Unreachable model → `DockStreamFn` emits an error event → speaks a fallback
  line → Failed, **never hangs** (`TURN_TIMEOUT_MS` ceiling; loop capped too).
- The turn always ends: `finally` flushes the trailing clause + `endTurn()`; if
  nothing was spoken and not Failed, state is forced back to Idle.

(Debug-only `DOCK_EVT` logcat trace timestamps every loop event for on-device
validation — gated behind `BuildConfig.DEBUG`.)

## State machine 3 — Listening session (the mic)

Owner: [`PerceptionPipeline`](app/app/src/main/kotlin/dev/orbit/dock/perception/PerceptionPipeline.kt).
`SpeechRecognizer` is **one-shot**, so a "session" is a single armed shot.

```
            WakeWord                 Transcript(final)
  (idle) ───────────▶ listening ───────────────────────▶ (ended, voice turn)
                          │
                          ├── no-match / timeout ──▶ (ended empty → session_ended)
                          └── StopListening ───────▶ (ended, cancelled)
```

Rules:
- **One tap = one shot.** No auto re-arm on silence — when SR ends empty the
  session is over and the UI drops to Idle; the user re-taps. (The *only*
  re-arm is `AutoRelisten` after a spoken reply.)
- `gotTranscript` guards the trailing `Status("final")` so a real transcript
  doesn't also emit `session_ended` over the agent.
- If the dock starts speaking while SR is somehow still armed, SR is stopped
  (no transcribing its own voice).

## State machine 4 — AutoRelisten (continuous-conversation decision)

Owner: [`AutoRelisten`](app/app/src/main/kotlin/dev/orbit/dock/perception/AutoRelisten.kt).
Pure, no Android deps — fully unit tested. Two booleans:
`sessionActive`, `voiceTurnPending`.

| Event | Effect |
|---|---|
| `onSessionStarted()` | `sessionActive=true`; clears any stale pending |
| `onVoiceTranscript()` | if session active → `voiceTurnPending=true`; `sessionActive=false` |
| `onSessionEndedEmpty()` | clear both (user said nothing → no re-arm) |
| `onCancelled()` | clear both (tap-stop / barge-in → no re-arm) |
| `onSpeakingChanged(false)` | if pending → consume + **return true** (re-arm once) |

Invariant: **re-arm fires at most once per voice turn**, and only when the
transcript that started the turn arrived inside an active session. A new
session (barge-in WakeWord) supersedes a stale pending re-arm, so the trailing
`Speaking(false)` from `tts.stop()` can't double-arm.

---

## Cross-cutting interaction rules (the tap handler)

[`DockScreen`](app/app/src/main/kotlin/dev/orbit/dock/ui/DockScreen.kt) maps a
tap by the **current FaceState**:

| Tap while… | Action |
|---|---|
| `Idle` | `WakeWord("(tap)")` → start listening |
| `Speaking` | **barge-in**: `WakeWord("(barge-in)")` first (opens fresh session, clears pending re-arm), then `tts.stop()` + `agent.stop()` |
| `Listening` / `Engaged` | `StopListening` + `silence()` |
| long-press (any) | `tts.stop()` + `agent.stop()` + `StopListening` + `silence()` |

The barge-in ordering (WakeWord **before** stopping TTS) is the subtle bit:
it guarantees the trailing `Speaking(false)` is absorbed by the new session
instead of triggering a second auto-relisten.

---

## Parallelism: talk while moving

`dispatch()` fires `setFace` → `speak` → `makeBodyMovements` back-to-back
without awaiting. `speak()` returns once the sentence is queued (TTS plays on
its own thread); `makeBodyMovements()` runs the servo sequence in a
fire-and-forget `bodyScope` coroutine tracked by `bodyJob`. So speech and
motion overlap. A new turn / barge-in / stop calls `stopBody()` which cancels
`bodyJob`, truncating a long gesture (verified on hardware: a 6-move "wiggle"
interrupted mid-sequence stopped after 2 moves).

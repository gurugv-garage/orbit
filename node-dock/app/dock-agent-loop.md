> **SUPERSEDED (2026-06): the loop described here moved to the station.**
> `DockAgent` and the on-phone loop were deleted in the server-brain
> cutover — the semantics below now live in
> `orbit-station/server/src/modules/brain/` (see docs/decision-traces/server-brain-impl.md).
> Kept as the design record of those semantics.

# The dock agent loop — lifecycle, state machines, mechanics

How one back-and-forth flows through the dock: from a tap or spoken utterance,
through the agent's tool-calling loop, out to streamed speech + body motion, and
(optionally) back to a re-armed mic. This is the **mechanics** doc; for how a turn
should *feel* (narration rules, restraint, tunables, acceptance criteria) see
[UX.md](UX.md).

**Vocabulary** (session / turn / step / LLM call) is owned by `:agent-core` and
defined in [../../docs/brain.md](../../docs/brain.md); the dock
**adopts** it. In short: a **turn** is one `prompt()` (the dock's complete
response to one trigger); a **step** is one LLM call + its tool executions; a turn
is 1+ steps, so a tool-using turn makes multiple LLM calls. A **session** is the
turns sharing one message history.

Pinned by `DockAgentTurnTest`, `DockAgentStreamingTest`, `DockAgentBodyTurnTest`,
`DockAgentVisionIntentTest`, `AutoRelistenTest`, `FaceControllerTest`,
`PerceptionWiringTest`.

There is **no central state object**. Small machines run in parallel and
communicate only through [`PerceptionBus`](app/src/main/kotlin/dev/orbit/dock/perception/PerceptionBus.kt)
events — decoupled on purpose, each independently testable.

```
  tap / voice
      │
      ▼
┌──────────────┐  WakeWord/Transcript  ┌──────────────┐
│  Perception  │ ────────────────────▶ │   DockAgent  │
│   Pipeline   │                       │ (drives the  │
│    + STT     │ ◀──────────────────── │  agent loop) │
└──────────────┘  WakeWord (relisten)  └──────┬───────┘
      ▲                       speak() +        │
      │ onSpeakingChanged     setFace/body     ▼
      │                                ┌──────────────┐
      └──── AutoRelisten ◀──────────── │   DockTts    │
                                       └──────────────┘
```

A tap/voice utterance enters the **PerceptionPipeline**, which emits
`WakeWord`/`Transcript` events on the **PerceptionBus** to **DockAgent**;
DockAgent streams prose to **DockTts** (`speak()`) and fires body/face tools;
`onSpeakingChanged(false)` feeds **AutoRelisten**, which re-arms the mic (a fresh
`WakeWord`) for hands-free conversation.

---

## Terminology (adopted from agent-core)

The **session / turn / step / LLM call** vocabulary is defined in
[../../docs/brain.md](../../docs/brain.md). What the dock pins down on
top of that abstract model:

- **Trigger** — today a turn is triggered by the user **speaking** or **typing**
  (`DockAgent.respond()`); later: a heartbeat / proactive timer / cross-device event.
- **Turn** — `DockAgent.respond()` / `runTurn()` = one agent-core turn (one `prompt()`).
- **Session** — today it spans from app launch until the next barge-in/long-press
  `stop()` (which calls `agent.reset()`, clearing the message history); normal
  turns accumulate into it. The boundary may change later (idle timeout, "new chat").
- A tool-using turn makes **multiple LLM calls** (one per step). There is **no
  per-turn step cap** — the only bound is `TURN_TIMEOUT_MS` (60s wall-clock); see
  *Superseding, stopping, failing*.

> **Disambiguation:** a **step** (one LLM call + its tools) is unrelated to a
> `move_sequence` **motion step** (one servo move); context distinguishes them.
> And the mic's "listening window" (one armed `SpeechRecognizer` shot) is a
> perception concept — *not* a [Session](../../docs/brain.md).

---

## The happy path (voice turn, body connected)

1. **User taps** the screen while Idle → `DockScreen` emits `WakeWord("(tap)")`.
2. **Pipeline** opens a listening window (one `SpeechRecognizer` shot), hands it
   the mic, emits `SttListening(armed=true)`. Face → **Listening**.
3. **User speaks.** SR returns a final transcript → `Transcript(isFinal=true)`.
   - Pipeline ends the session, records it as a *voice turn* (`AutoRelisten.onVoiceTranscript`).
   - `PerceptionWiring.onUserUtterance` → `DockAgent.respond(text)`.
4. **DockAgent** runs the turn: it drives the agent loop (next sections), which
   streams spoken prose AND emits tool calls (`set_face`, `move_body`, `gesture`,
   `move_sequence`, `compute`), executing them until the model stops calling
   tools. AgentState walks **Idle → Waiting → Thinking → Speaking → Idle**, with
   a per-action status ("looking left") while a tool runs.
5. **Translation** (`onAgentEvent`): prose deltas → `speakSentence` (sentence-by-
   sentence TTS); `ToolExecutionStart` → fire-and-forget body move. **Speech and
   motion overlap** — neither awaits the other; tool results return immediately.
6. **DockTts** plays audio. `onSpeakingChanged(true/false)` drives Face Speaking/Idle.
7. **AutoRelisten** sees `Speaking(false)` for a pending voice turn → emits
   `WakeWord("(auto-relisten)")` → back to step 2. Hands-free loop.

If the turn was **not** voice-initiated (e.g. a debug `SAY`, or a proactive
line), step 7 does **not** fire — the dock returns to Idle and waits for a tap.

The rest of this doc zooms into step 4-5 (the agent mechanics), then documents
the state machines that bracket the turn.

---

## The agent loop: `:agent-core` as a black box

The dock does **not** implement the tool-calling loop itself. It delegates to the
dock-agnostic `:agent-core` module (our own engine; see its
[brain.md](../../docs/brain.md)). Here we rely only on its
**interface** — what you call and what you get back — not how it works inside:

- **In:** you configure it (with a prompt, a model, tools, and a transport — the
  dock supplies all four; see below), then call `prompt(userMessage)`.
- **Out:** while it runs, it emits a stream of **`AgentEvent`s** you subscribe to
  (`MessageUpdate`, `ToolExecutionStart/End`, `TurnEnd`, …). It calls the tools
  you gave it and stops on its own.
- **Constraint:** it's **one run at a time** — a second `prompt` while one is
  active throws `AgentBusyException` (the dock handles this — see *Superseding*).

Everything else — the loop algorithm, how it decides to keep going, context
shape, event ordering — is `:agent-core`'s business and out of scope here.

## What `DockAgent` wires in

[`DockAgent`](app/src/main/kotlin/dev/orbit/dock/agent/DockAgent.kt) is a thin
facade that supplies the four pieces and translates the events into UX:

```
DockAgent (facade)
  ├─ systemPrompt  = DockPrompt.SYSTEM  (terse, tool-first; shared with :bench)
  ├─ model         = OLLAMA_MODEL
  ├─ streamFn      = DockStreamFn       (Ollama NDJSON / OpenAI SSE transport)
  └─ tools         = DockToolsAdapter.tools(dock)
                       set_face · move_body · gesture · move_sequence · compute
        │
        ▼  subscribe(onAgentEvent)
   :agent-core Agent.prompt(userMessage)
```

- **Transport** — [`DockStreamFn`](app/src/main/kotlin/dev/orbit/dock/llm/DockStreamFn.kt)
  builds the dock's Ollama (`/api/chat` NDJSON) or OpenAI (`/v1` SSE) request and
  streams the response back as assistant-message events. Endpoint + key come from
  `BuildConfig` (`keyFor()` picks the bearer token: OpenRouter / Gemini / none-for-local).
- **Tools** — [`DockToolsAdapter`](app/src/main/kotlin/dev/orbit/dock/agent/DockToolsAdapter.kt)
  turns the dock's capabilities into the 5 `AgentTool`s, with enum-constrained
  schemas and part↔state validation against the catalog (a small model may pick a
  valid-but-mismatched pair like `neck,left`). Each side effect lives in
  [`DockTools`](app/src/main/kotlin/dev/orbit/dock/agent/DockTools.kt).
- **Prompt** — `DockPrompt.SYSTEM` (in `dev/orbit/dock/llm/`), the same surface
  the `:bench` harness uses, so the live dock and the benchmark prompt models
  identically.

## A turn, mechanically

`DockAgent.respond(userText)` → `runTurn()`:

1. **Begin.** Cancel leftover body motion (`tools.stopBody()`), reset the
   per-turn sentence streamer, state → `Waiting(model)`, start the turn log.
2. **Ground the prompt.** Append live context (face-present / emotion / gaze from
   `tools.currentContext()`) to the system prompt for this turn only.
3. **Decide on the camera frame** (see *Vision gating*). Attach it to the **user
   message only**, never to history — or send text-only.
4. **Run the loop under a timeout:** `withTimeout(TURN_TIMEOUT_MS) { agent.prompt(…) }`.
   From here the dock is event-driven — `onAgentEvent` does the rest.
5. **Settle (`finally`).** Flush the trailing clause (the last sentence may lack
   terminal punctuation), `tools.endTurn()`, record the turn. If nothing was
   spoken and we didn't fail, force state back to `Idle`.

### Event → UX translation (`onAgentEvent`)

The loop's events are mapped to dock behavior as they arrive. Speech and action
are handled independently and **overlap**.

| `AgentEvent` | What DockAgent does |
|---|---|
| `MessageUpdate` (prose delta) | `Waiting → Thinking` on first bytes; push the delta through `StreamingReplyExtractor`; each completed sentence → `tools.speakSentence` and flip to `Speaking`. Live partial → subtitle. |
| `ToolExecutionStart(name,args)` | State → `ToolCalling("looking left")` via `DockToolsAdapter.statusPhrase` (a human phrase, not the raw tool name). The side effect already fired inside the loop. |
| `MessageEnd` with an error | State → `Failed`; speak the fallback line. |
| `TurnEnd` | If nothing was spoken, settle to `Idle`. |

Every event is timestamped and emitted to `events` (the on-screen live log) and,
in debug builds, to logcat under tag `DOCK_EVT` — so the loop's sequence + timing
is visible both on-device and in the UI.

## Speak and act run in parallel

The defining behavior: nothing in a turn blocks on TTS or on servo travel.

- **Prose** → `tools.speakSentence(sentence)` queues on the TTS thread and returns.
- **A body tool** → `DockTools.makeBodyMovements` launches the servo sequence in a
  fire-and-forget `bodyScope` coroutine (tracked by `bodyJob`) and returns; the
  tool result goes back to the loop immediately so the model can keep talking.

So "Let me look around… there you are!" speaks the first clause, runs the moves
*while still talking*, then speaks the last clause. A new turn / barge-in / `stop()`
calls `stopBody()`, which cancels `bodyJob` and truncates a long gesture
mid-sequence (verified on hardware: a 6-move "wiggle" interrupted stopped after 2).

## Vision gating (why the camera frame isn't always attached)

Small vision models (e.g. `gemma4:e2b`, 5B) **fixate on an always-attached image
and ignore movement commands** — proved live: "look up" + image → "I see a
room…", no tool call. So by default (`gateImageToVisionIntent = true`) the frame
is attached **only on vision-intent turns** ("what do you see", "how do I look"),
detected by the `isVisionIntent` regex; movement/chat turns go text-only. Escape
hatches: a model that can't see (`visionEnabled = false`) never gets a frame; a
strong model that handles image-on-every-turn can flip gating off. The regex is
pure + unit-tested (`DockAgentVisionIntentTest`); iterate it in UX.md.

## Superseding, stopping, failing

- **Supersede (new utterance mid-turn).** `respond()` cancels the in-flight turn
  and **`cancelAndJoin`s** it before starting the new one. The join matters:
  `:agent-core` is one-run-at-a-time and resets its active-run flag in a `finally`
  that runs *after* `cancel()` returns — without the join the new prompt races
  that reset and is rejected as busy (observed live: a second utterance left the
  first orphaned). A stray `AgentBusyException` is swallowed.
- **Stop (barge-in / long-press).** `stop()` cancels the turn, `agent.reset()`
  (clears the active-run flag), `tools.silence()`, → `Idle`.
- **Fail / hang.** The whole turn is bounded by `TURN_TIMEOUT_MS` (60s wall-clock)
  — the **only** bound on the loop; there is no per-turn tool-call count cap. On
  timeout or an unreachable model, it speaks a fallback line, sets `Failed`, and
  settles. It never hangs.

---

## The state machines

Four small machines bracket a turn. They share nothing but `PerceptionBus` events.

### 1 — FaceState (the on-screen face)
Owner: [`FaceController`](app/src/main/kotlin/dev/orbit/dock/ui/face/FaceController.kt).

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

- `listen()`/`speak()`/`illustrate()` all `wakeUp()` first, so the face never
  appears asleep mid-interaction.
- Only `silence()` returns to Idle. The pipeline emits exactly **one**
  `session_ended` per empty session, so the face drops to Idle once — never
  flickers Idle↔Listening across the recognizer's churn.
- A final transcript does **not** silence the face — the agent owns it until TTS finishes.

### 2 — AgentState (what the agent is doing)
Owner: [`DockAgent`](app/src/main/kotlin/dev/orbit/dock/agent/DockAgent.kt). Surfaced to the status line. (Driven by the events in the translation table above.)

```
 Idle ─respond()─▶ Waiting ─first tokens─▶ Thinking ─prose─▶ Speaking ─loop ends─▶ Idle
                                              │  ▲              │
                              tool runs ──────┘  └─ ToolCalling("looking left") ─┘
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

(The supersede / stop / fail guarantees are in *Superseding, stopping, failing* above.)

### 3 — Listening window (the mic)
Owner: [`PerceptionPipeline`](app/src/main/kotlin/dev/orbit/dock/perception/PerceptionPipeline.kt).
`SpeechRecognizer` is **one-shot**, so a listening window is a single armed shot.

> The perception code calls this a "session" (`sessionActive`, `onSessionStarted`,
> `session_ended`) — a **mic listening window**, *not* the conversational
> [Session](../../docs/brain.md) (shared message history). They're
> orthogonal; the name overlap is historical.

```
            WakeWord                 Transcript(final)
  (idle) ───────────▶ listening ───────────────────────▶ (ended, voice turn)
                          │
                          ├── no-match / timeout ──▶ (ended empty → session_ended)
                          └── StopListening ───────▶ (ended, cancelled)
```

- **One tap = one shot.** No auto re-arm on silence — when SR ends empty the
  session is over and the UI drops to Idle; the user re-taps. (The *only* re-arm
  is `AutoRelisten` after a spoken reply.)
- `gotTranscript` guards the trailing `Status("final")` so a real transcript
  doesn't also emit `session_ended` over the agent.
- If the dock starts speaking while SR is somehow still armed, SR is stopped (no
  transcribing its own voice).

### 4 — AutoRelisten (continuous-conversation decision)
Owner: [`AutoRelisten`](app/src/main/kotlin/dev/orbit/dock/perception/AutoRelisten.kt).
Pure, no Android deps. Two booleans: `sessionActive`, `voiceTurnPending`.

| Event | Effect |
|---|---|
| `onSessionStarted()` | `sessionActive=true`; clears any stale pending |
| `onVoiceTranscript()` | if session active → `voiceTurnPending=true`; `sessionActive=false` |
| `onSessionEndedEmpty()` | clear both (user said nothing → no re-arm) |
| `onCancelled()` | clear both (tap-stop / barge-in → no re-arm) |
| `onSpeakingChanged(false)` | if pending → consume + **return true** (re-arm once) |

Invariant: **re-arm fires at most once per voice turn**, and only when the
transcript that started it arrived inside an active session. A barge-in WakeWord
supersedes a stale pending re-arm, so the trailing `Speaking(false)` from
`tts.stop()` can't double-arm.

---

## The tap handler

[`DockScreen`](app/src/main/kotlin/dev/orbit/dock/ui/DockScreen.kt) maps a tap by
the **current FaceState**:

| Tap while… | Action |
|---|---|
| `Idle` | `WakeWord("(tap)")` → start listening |
| `Speaking` | **barge-in**: `WakeWord("(barge-in)")` first (opens a fresh session, clears pending re-arm), then `tts.stop()` + `agent.stop()` |
| `Listening` / `Engaged` | `StopListening` + `silence()` |
| long-press (any) | `tts.stop()` + `agent.stop()` + `StopListening` + `silence()` |

The barge-in ordering (WakeWord **before** stopping TTS) is the subtle bit: it
guarantees the trailing `Speaking(false)` is absorbed by the new session instead
of triggering a second auto-relisten.

---

## Where to look next

| To understand… | Read |
|---|---|
| how a turn should *feel* (timeline, narration, tunables, acceptance) | [UX.md](UX.md) |
| the facade itself | [`agent/DockAgent.kt`](app/src/main/kotlin/dev/orbit/dock/agent/DockAgent.kt) |
| tool schemas + status phrases + validation | [`agent/DockToolsAdapter.kt`](app/src/main/kotlin/dev/orbit/dock/agent/DockToolsAdapter.kt) |
| the side effects (speak, face, body, endTurn) | [`agent/DockTools.kt`](app/src/main/kotlin/dev/orbit/dock/agent/DockTools.kt) |
| the LLM transport (Ollama/OpenAI) | [`llm/DockStreamFn.kt`](app/src/main/kotlin/dev/orbit/dock/llm/DockStreamFn.kt) |
| which model to run as the brain | [bench/README.md](bench/README.md) |

# Agent workflow — how the dock thinks and acts

How one user utterance becomes streamed speech + body motion in the dock app.
This is the dock-specific glue around an **abstract agent loop**; it complements
the other app docs:

- **[LIFECYCLE.md](LIFECYCLE.md)** — the surrounding state machines (mic session,
  FaceState, AutoRelisten) and how a turn is *triggered* and *settled*.
- **[UX.md](UX.md)** — how a turn should *feel* (timeline, narration, tunables).
- **This doc** — what `DockAgent` does *mechanically* between "got an utterance"
  and "turn done".

The implementation is [`agent/DockAgent.kt`](app/src/main/kotlin/dev/orbit/dock/agent/DockAgent.kt)
(+ `DockToolsAdapter`, `DockTools`, `DockStreamFn`). It's pinned by
`DockAgentTurnTest`, `DockAgentStreamingTest`, `DockAgentBodyTurnTest`,
`DockAgentVisionIntentTest`.

---

## The abstract piece: `:agent-core` (treat as a black box)

The dock does **not** implement the tool-calling loop itself. It delegates to a
vendored, dock-agnostic runtime (pi-kt) in the `:agent-core` Gradle module. This
doc only relies on its **interface** — what you call and what you get back — not
how it works inside:

- **In:** you configure it (with a prompt, a model, tools, and a transport — the
  dock supplies all four; see the next section), then call `prompt(userMessage)`.
- **Out:** while it runs, it emits a stream of **`AgentEvent`s** you subscribe to
  (`MessageUpdate`, `ToolExecutionStart/End`, `AgentEnd`, …). It calls the tools
  you gave it and stops on its own.
- **Constraint:** it's **one run at a time** — a second `prompt` while one is
  active throws `AgentBusyException` (the dock handles this — see *Superseding*).

Everything else — the loop algorithm, how it decides to keep going, context
shape, event ordering — is `:agent-core`'s business and out of scope here. The
dock's job is to **supply the configuration** and **translate the events into
UX**.

---

## What `DockAgent` wires in

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
  is the `StreamFn`. It builds the dock's Ollama (`/api/chat` NDJSON) or OpenAI
  (`/v1` SSE) request and streams the response back as assistant-message events.
  Endpoint + key are chosen from `BuildConfig` (`keyFor()` picks the bearer
  token: OpenRouter / Gemini / none-for-local).
- **Tools** — [`DockToolsAdapter`](app/src/main/kotlin/dev/orbit/dock/agent/DockToolsAdapter.kt)
  turns the dock's capabilities into the 5 `AgentTool`s the loop can call, with
  enum-constrained schemas and part↔state validation against the catalog (a
  small model may pick a valid-but-mismatched pair like `neck,left`). Each tool's
  side effect lives in [`DockTools`](app/src/main/kotlin/dev/orbit/dock/agent/DockTools.kt).
- **Prompt** — `DockPrompt.SYSTEM` (in `dev/orbit/dock/llm/`), the same surface
  the `:bench` harness uses, so the live dock and the benchmark prompt models
  identically.

---

## One turn, end to end

`DockAgent.respond(userText)` → `runTurn()`:

1. **Begin.** Cancel any leftover body motion (`tools.stopBody()`), reset the
   per-turn sentence streamer, set state `Waiting(model)`, start the turn log.
2. **Ground the prompt.** Append live context (face-present / emotion / gaze
   from `tools.currentContext()`) to the system prompt for this turn only.
3. **Decide on the camera frame** (see *Vision gating* below). Attach it to the
   **user message only** (never to history), or send text-only.
4. **Run the loop under a timeout.**
   `withTimeout(TURN_TIMEOUT_MS) { agent.prompt(userMessage) }`.
   From here the dock is event-driven — `onAgentEvent` does the rest as the loop
   streams.
5. **Settle (`finally`).** Flush the trailing clause (the last sentence may lack
   terminal punctuation), call `tools.endTurn()`, record the turn. If nothing was
   spoken and we didn't fail, force state back to `Idle`.

```
respond(text)
   │  cancelAndJoin prior turn (see "Superseding")
   ▼
runTurn(text)
   │  Waiting → (ground prompt, maybe attach frame)
   ▼
agent.prompt(text + image?)         ── :agent-core loop ──┐
   ▲                                                       │ emits AgentEvents
   └─────────────── onAgentEvent(event) ◀──────────────────┘
        MessageUpdate  → stream prose → TTS, Thinking→Speaking
        ToolExecStart  → status "looking left" + body moves NOW
        AgentEnd       → settle
   │  finally: flush last clause, endTurn(), → Idle
   ▼
done (LIFECYCLE's AutoRelisten may re-arm the mic)
```

---

## Event → UX translation (`onAgentEvent`)

The loop's events are mapped to dock behavior as they arrive. The key property:
**speech and action are handled independently and overlap.**

| `AgentEvent` | What DockAgent does |
|---|---|
| `MessageUpdate` (streamed prose delta) | `Waiting → Thinking` on first bytes; push the delta through `StreamingReplyExtractor`; each completed sentence → `tools.speakSentence` (TTS) and flips state to `Speaking`. Live partial text → subtitle. |
| `ToolExecutionStart(name,args)` | State → `ToolCalling("looking left")` via `DockToolsAdapter.statusPhrase` (human phrase, not the raw tool name). The tool's side effect already fired inside the loop. |
| `MessageEnd` with an error | State → `Failed`; speak the fallback line. |
| `AgentEnd` | If nothing was spoken, settle to `Idle`. |

Every event is also timestamped and emitted to `events` (the on-screen live log)
and, in debug builds, to logcat under tag `DOCK_EVT` — so the loop's sequence +
timing is visible both on-device and in the UI.

The six `AgentState`s ([`AgentState.kt`](app/src/main/kotlin/dev/orbit/dock/agent/AgentState.kt)) —
`Idle · Waiting · Thinking · ToolCalling · Speaking · Failed` — are surfaced to
the status pill. (Full state-machine rules: LIFECYCLE.md §2.)

---

## Speak and act run in parallel

This is the defining behavior. Nothing in a turn blocks on TTS or on servo travel:

- **Prose** → `tools.speakSentence(sentence)` queues on the TTS thread and
  returns immediately.
- **A body tool** → `DockTools.makeBodyMovements` launches the servo sequence in
  a fire-and-forget `bodyScope` coroutine (tracked by `bodyJob`) and returns; the
  tool result goes back to the loop right away so the model can keep talking.

So "Let me look around… there you are!" speaks the first clause, runs the moves
*while still talking*, then speaks the last clause. A new turn / barge-in / `stop()`
calls `stopBody()`, which cancels `bodyJob` and truncates a long gesture
mid-sequence. (Verified on hardware — see LIFECYCLE.md §"Parallelism".)

---

## Vision gating (why the camera frame isn't always attached)

Small vision models (e.g. `gemma4:e2b`, 5B) **fixate on an always-attached image
and ignore movement commands** — proved live: "look up" + image → "I see a
room…", no tool call. So by default (`gateImageToVisionIntent = true`) the camera
frame is attached **only on vision-intent turns** ("what do you see", "how do I
look"), detected by the `isVisionIntent` regex; movement/chat turns go text-only.
Two escape hatches: a model that can't see at all (`visionEnabled = false`) never
gets a frame; a strong model that handles image-on-every-turn can flip gating off.
The regex is pure + unit-tested (`DockAgentVisionIntentTest`); iterate it in UX.md.

---

## Superseding, stopping, failing

- **Supersede (new utterance mid-turn).** `respond()` cancels the in-flight turn
  and **`cancelAndJoin`s** it before starting the new one. The join matters:
  `:agent-core` is one-run-at-a-time and resets its active-run flag in a `finally`
  that runs *after* `cancel()` returns — without the join the new prompt races
  that reset and is rejected as busy (observed live: a second utterance left the
  first orphaned). An `AgentBusyException` that still slips through is swallowed.
- **Stop (barge-in / long-press).** `stop()` cancels the turn, calls
  `agent.reset()` (clears the active-run flag), silences TTS, → `Idle`.
- **Fail / hang.** The whole turn is bounded by `TURN_TIMEOUT_MS` (60s wall-clock)
  — the **only** bound on the loop; there is no per-turn tool-call count cap. On
  timeout or an unreachable model, it speaks a fallback line, sets `Failed`, and
  settles. It never hangs.

---

## Where to look next

| To understand… | Read |
|---|---|
| how a turn is *triggered* and the mic/face/relisten machines | [LIFECYCLE.md](LIFECYCLE.md) |
| how a turn should *feel* (timeline, tunables, narration rules) | [UX.md](UX.md) |
| the facade itself | [`agent/DockAgent.kt`](app/src/main/kotlin/dev/orbit/dock/agent/DockAgent.kt) |
| the tool schemas + status phrases + validation | [`agent/DockToolsAdapter.kt`](app/src/main/kotlin/dev/orbit/dock/agent/DockToolsAdapter.kt) |
| the side effects (speak, face, body, endTurn) | [`agent/DockTools.kt`](app/src/main/kotlin/dev/orbit/dock/agent/DockTools.kt) |
| the LLM transport (Ollama/OpenAI) | [`llm/DockStreamFn.kt`](app/src/main/kotlin/dev/orbit/dock/llm/DockStreamFn.kt) |
| which model to run as the brain | [bench/README.md](bench/README.md) |

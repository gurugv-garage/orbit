# The agent model — vocabulary & loop

`:agent-core` is a small, **dependency-free** agentic runtime: an LLM tool-calling
loop plus the types around it. It knows nothing about the dock (no Android, no
Ktor, no servos, no UI). Any host embeds it by supplying a prompt, a model, a set
of tools, and a transport, then subscribing to the events it emits.

This file is the **canonical definition** of the vocabulary the loop uses. Other
parts of the project (e.g. the dock app) **adopt these terms** rather than
inventing their own — so "turn" and "step" mean the same thing everywhere.

---

## The four nested concepts

**Session ⊃ Turns ⊃ Steps ⊃ (one LLM call each).**

| Term | Definition | In code |
|---|---|---|
| **Session** | A set of turns that share **one message history** (one conversational context). The history lives in `Agent.state.messages` and persists across turns until `reset()`. A host decides when a session begins/ends (new `Agent`, or `reset()`). | [`harness/Session.kt`](src/main/kotlin/dev/pi/agent/harness/Session.kt), `Agent.state.messages` |
| **Trigger** | The event that **starts a turn**. agent-core itself is trigger-agnostic — a turn starts when the host calls `prompt(...)`. (The dock's triggers today are "user speaks/types"; later a heartbeat, etc.) | `Agent.prompt()` |
| **Turn** | One `prompt()` → the agent's **complete response**: it runs the loop until the model stops calling tools (or a stop condition fires). Bracketed by the events **`TurnStart`** … **`TurnEnd`**. | `runAgentLoop`, `AgentEvent.TurnStart/TurnEnd` |
| **Step** | One **LLM call plus the tool executions it triggers**, within a turn. A turn is **1 or more** steps: step N+1 happens only because step N's response contained tool calls. Bracketed by **`StepStart`** … **`StepEnd`**. | inner loop in `AgentLoop.kt`, `AgentEvent.StepStart/StepEnd` |
| **LLM call** | A single request/response to the model (`streamAssistantResponse`). Exactly **one per step**. | `streamFn` |

So a turn that uses tools makes **multiple LLM calls**:

```
LLM calls in a turn = (steps whose response emitted tool calls) + 1
```

A pure-chat turn ("what's the capital of France?") is 1 step / 1 call. A turn that
calls two tools across the loop is ~2–3 steps / ~2–3 calls.

> **Naming history:** earlier the run-level events were `AgentStart/AgentEnd` and
> the per-LLM-call events were `TurnStart/TurnEnd` — which collided with hosts
> that (correctly) call the whole response a "turn". Renamed so the loop's events
> match this vocabulary: **`TurnStart/End`** = the whole `prompt()`, **`StepStart/End`**
> = one LLM call.

---

## The loop

`prompt(message)` runs `runAgentLoop`:

```
TurnStart
  ┌──────────────────────── step ────────────────────────┐
  │ StepStart                                             │
  │   one LLM call  (streamed: MessageStart/Update/End)   │
  │   if the response has tool calls:                     │
  │       ToolExecutionStart/End per tool                 │
  │ StepEnd                                               │
  └───────────────────────────────────────────────────────┘
        │ response had tool calls?  ── yes ──▶ loop (next step)
        │                            ── no  ──▶ stop
TurnEnd
```

- **Stop conditions:** the loop ends a turn when the model returns a response with
  **no tool calls**, or `shouldStopAfterStep` returns true, or the response stops
  with `ERROR`/`ABORTED`. There is **no built-in step-count cap** — a host that
  wants one bounds the turn itself (the dock uses a wall-clock timeout).
- **Steering / follow-ups:** a host may inject messages between steps
  (`getSteeringMessages` / `getFollowUpMessages`) — the loop folds them in at the
  next step boundary, which is why the outer loop can continue past a would-be stop.
- **One turn at a time:** an `Agent` runs a single turn at a time; calling
  `prompt()` while one is in flight throws `AgentBusyException`. `reset()` clears
  the run flag and the message history (ending the session).

## The events

`AgentEvent` (subscribe via `Agent.subscribe { … }`):

| Event | Fires |
|---|---|
| `TurnStart` / `TurnEnd` | once each, bracketing the whole `prompt()` (the turn) |
| `StepStart` / `StepEnd` | once each **per step** (per LLM call + its tools) |
| `MessageStart` / `MessageUpdate` / `MessageEnd` | streaming of one assistant (or injected) message |
| `ToolExecutionStart` / `ToolExecutionUpdate` / `ToolExecutionEnd` | per tool call executed within a step |

## Hooks (per-step extension points)

`AgentLoopConfig` exposes hooks named for the **step** they act on:

- `shouldStopAfterStep(ShouldStopAfterStepContext) → Boolean` — end the turn early.
- `prepareNextStep(ShouldStopAfterStepContext) → AgentLoopStepUpdate?` — swap the
  context / model / thinking level for the next step.

---

## Embedding it

A host:
1. builds an `Agent(AgentOptions(systemPrompt, model, tools, streamFn))`,
2. `subscribe`s to translate `AgentEvent`s into its own UX,
3. calls `prompt(userMessage)` per turn.

For a worked example, see the dock's facade and its mechanics doc:
[`DockAgent`](../app/src/main/kotlin/dev/orbit/dock/agent/DockAgent.kt) /
[dock-agent-loop.md](../dock-agent-loop.md).

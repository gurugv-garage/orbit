# The agent model — vocabulary, loop & architecture

The **canonical** definition of the dock brain: the vocabulary its loop uses, the
loop itself, and where it runs today. Other parts of the project **adopt these
terms** rather than inventing their own — so "turn" and "step" mean the same thing
everywhere.

The brain is the upstream TypeScript **[pi](https://github.com/earendil-works/pi)**
agent runtime — a dependency-free LLM tool-calling loop — embedded in orbit-station
(`modules/brain/`). It knows nothing about the dock specifically; the station
supplies a prompt, a model, a set of tools, and a transport, then subscribes to the
events it emits.

> **History / decision traces** (why it is this way + the full as-built record):
> [decision-traces/server-brain-design.md](decision-traces/server-brain-design.md)
> (the move off the phone — design + risk analysis),
> [decision-traces/server-brain-impl.md](decision-traces/server-brain-impl.md) (the
> production cutover — stages 1-3, wire protocol, reconnection),
> [decision-traces/server-brain-selfmod.md](decision-traces/server-brain-selfmod.md)
> (pi-native extension surface — Skills, coding tools).

---

## The four nested concepts

**Session ⊃ Turns ⊃ Steps ⊃ (one LLM call each).**

| Term | Definition | In code (`modules/brain/`) |
|---|---|---|
| **Session** | A set of turns that share **one message history** (one conversational context). The history lives in the pi `Agent.state.messages` and persists across turns until the session closes. One **`DockBrainSession` per dock**, opened lazily, idle-closed (summary persisted). | `session.ts` (`DockBrainSession`); `store.ts` (`SessionStore`, JSONL under `.data/brain/`) |
| **Trigger** | The event that **starts a turn**. pi is trigger-agnostic — a turn starts when the host calls `prompt(...)`. The dock's triggers: **`user`** (speaks/types → `turn-request`), **`task`** (a background job signals), **`self`** (the robot's own perception thought). `trigger.kind` is a plain string on `TurnRequest`. | `TurnRequest.trigger`; `handleTurnRequest` / `enqueueAutonomousTurn` |
| **Turn** | One `prompt()` → the agent's **complete response**: the loop runs until the model stops calling tools (or a stop condition fires). Bracketed by **`TurnStart`** … **`TurnEnd`**. | `#runTurn`; pi `agent_start`/`agent_end` → TurnStart/End |
| **Step** | One **LLM call plus the tool executions it triggers**, within a turn. A turn is **1 or more** steps: step N+1 happens only because step N's response had tool calls. Bracketed by **`StepStart`** … **`StepEnd`**. | pi `turn_start`/`turn_end` → Step |
| **LLM call** | A single request/response to the model. Exactly **one per step**. | the pi `streamFn` (pi-ai providers) |

So a tool-using turn makes **multiple LLM calls**: `LLM calls = (steps that emitted
tool calls) + 1`. A pure-chat turn ("capital of France?") is 1 step / 1 call.

> **Vocabulary note — pi's events vs. ours.** Upstream pi calls one LLM-call-plus-tools
> a "turn" and the whole `prompt()` run `agent_*`. Our model (this doc) calls those
> **Step** and **Turn**; `session.ts` `#onAgentEvent` maps pi's names onto ours so the
> obs trace and console speak one vocabulary.

---

## The loop

`prompt(message)` runs the pi agent loop:

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
  **no tool calls**, or it stops with an error/abort. No built-in step-count cap — the
  dock bounds a turn with a **wall-clock timeout** (`brainTurnTimeoutMs`) + a
  per-request `max_tokens` cap (`DOCK_MAX_TOKENS`).
- **One turn at a time:** an `Agent` runs a single turn at a time. A new user
  `turn-request` **supersedes** the in-flight turn (abort, then await the full unwind
  before the next prompt — racing the reset gets pi "busy" rejections), and
  `sanitizeHistory()` repairs the transcript (synthetic `(interrupted)` tool results +
  a user-boundary cap trim) so the next turn stays valid.
- **Autonomous turns:** `task`/`self` turns enter a bounded queue
  (`enqueueAutonomousTurn`) with coalescing + staleness; a **user turn always wins**.
  The `self`-thought routing is in [perception-to-brain](perception-to-brain.md).

## The events

The obs stream (`modules/observability/`):

| Event | Fires |
|---|---|
| `TurnStart` / `TurnEnd` | once each, bracketing the whole `prompt()` (the turn) |
| `StepStart` / `StepEnd` | once each **per step** (per LLM call + its tools) |
| `MessageStart` / `MessageUpdate` / `MessageEnd` | streaming of one assistant message |
| `ToolExecutionStart` / `ToolExecutionEnd` | per tool call executed within a step |

`StepEnd` carries rich timings + cost (TTFT, thinking ms, tokens, $) so a resumed
session's inspector matches the live brain-debug stream exactly.

---

## Where it runs — current architecture

The brain is **server-side**: the phone is perception + face/voice; the station is the
brain + body control. **One WebSocket server in the whole system (the station).**

```
 phone (perception + face/voice)            orbit-station (the one server)
   mic → VAD/wake → Android STT      ──►   modules/brain/  DockBrainSession (per dock)
   RemoteBrain (thin WS client)               ├ pi Agent + pi-ai streamFn
     ├ turn-request {text,context,image?} ──►  ├ prompt builder + sanitizeHistory
     ├ set_face RPC → FaceController  ◄──►      ├ SentenceStreamer
     ├ speak frames → DockTts         ◄──       └ RpcBroker (set_face) + SessionStore
     └ turn-status → face UI          ◄──    modules/bodylink/  (the only body path)
   camera ── WebRTC → SFU ────────────►      modules/perception/ (face/senses, in-proc)
 ESP32 body (client-only, one socket) ──►    modules/observability/ (obs, in-proc)
```

**Tool placement:** `set_face` expression → phone RPC (it owns the screen); `set_face`
gesture + `move` → in-process motion executor → the firmware peer; `compute`,
`remember/recollect/confirm/forget_face` → in-process. **Speech is not a tool** — prose
streams down as `speak` frames; the phone's remote-tool executor handles exactly one
tool (`set_face`), the RPC staying generic for future screen/sound tools.

**Key properties** (full rationale in the traces): full cutover (no Kotlin brain); the
station WS is the robot's spinal cord, so **reconnection is first-class + tested**;
streaming-first on every hop; fire-and-forget actuation; pi sessions with compaction;
brain profiles in the config registry (`brain*` keys); STT/TTS stay on the phone for
now (transcripts up, sentence text down).

**Extension surface** (pi-native — [trace](decision-traces/server-brain-selfmod.md)):
per-dock **Skills** (progressive disclosure) and full pi **coding tools** (the dock can
read/modify station code, gated by `brainGrants` + dock-UI confirmation) are built;
loading third-party extension *modules* is future.

---

## See also

- [perception-to-brain](perception-to-brain.md) — perception feeding the brain
  (thoughts, grounding, memory, tools, the attention gate).
- [tasks.md](tasks.md) — background jobs as separate processes (the `task` trigger).
- [operations/perception-runbook.md](operations/perception-runbook.md) — run + test.

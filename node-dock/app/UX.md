# Dock interaction UX — the agentic turn

How the dock should *behave* during one **turn** — the dock's complete response
to one trigger, which is a multi-**step** tool-calling loop (each step = one LLM
call + its tools), not a single forced-JSON POST. This is the contract the
implementation serves.

**Living document — optimize for a natural feel, iterate freely.** Tunables are
called out explicitly so changing the feel is cheap. This is the *behavior /
feel* spec; for the *mechanics* it serves — the turn lifecycle, the
[terminology](TURN.md#terminology) (session / turn / step / LLM call), the state
machines, how `DockAgent` drives the loop and runs speech + motion in parallel —
see [TURN.md](TURN.md). Read that first; don't duplicate it here.

---

## The model's contract (system prompt + tools)

The model is told: you have a VOICE (speak plain prose, it's said aloud), a FACE,
EYES (camera image attached when present), and a BODY moved via **tools**.

- **Speak by emitting prose** — streamed to TTS sentence-by-sentence. No JSON.
- **Act by calling tools** — face, body, and a safe calculator.
- It may **interleave**: speak a sentence, call a tool, speak again, call again —
  all in one turn. This is what makes the dock feel alive (narrated action).

Tools (enum-constrained; the adapter additionally validates part↔state pairing
against the catalog, since a small model may pick a valid-but-mismatched pair
like `neck,left`). All five are defined in `DockToolSchemas` + wired in
`DockToolsAdapter`:
- `set_face(expression: enum[neutral,happy,curious,concerned,surprised,sad,excited,angry,love])`
- `move_body(part: enum[neck,foot], state: enum[lookUp,lookDown,center,forward,left,right])`
  — one step; the loop chains several for "look around" etc.
- `gesture(name: enum[nod,shake_head,wiggle,look_around,look_up,look_down])` —
  a named multi-step gesture that expands to a validated `move_body` sequence.
- `move_sequence(steps: [...])` — model-authored motion: an array of
  `{part,state,wait_ms?}` so the model composes arbitrary timed sequences.
- `compute(expression)` — evaluate a SAFE arithmetic / random-number expression
  (e.g. `3+4*2`, `random(1,10) > 5`) and get the result back, so the model
  branches on real numbers instead of guessing.

---

## Turn timeline — what the user sees/hears at each phase

| Phase | Trigger (AgentEvent) | Face / Status | Voice | Body |
|---|---|---|---|---|
| **Waiting** | turn starts, no bytes yet | status `Waiting` + thinking dots; face stays Engaged | — | — |
| **Thinking** | first stream activity / reasoning | status `Thinking` | — | — |
| **Speaking** | first prose sentence ready (`MessageUpdate` deltas → sentence boundary) | face → Speaking | speak sentence now (don't wait for turn end) | — |
| **Acting** | `ToolExecutionStart(name,args)` | status shows the **specific action** ("looking left", "nodding", "smiling") | keep speaking queued sentences | fire-and-forget servo move; speech continues in parallel |
| **Reacting** | `ToolExecutionEnd(result)` | (per rule below) | model may speak about the result next | — |
| **Continue** | loop runs another turn (more tools) | back to Thinking/Speaking/Acting | streamed | streamed |
| **Settle** | `AgentEnd` | face → Idle (or auto-relisten if voice turn) | queue drains | last move holds |

Key invariant (preserved from today): **speech and motion overlap** — a body
tool returns immediately; servo travel runs in `DockTools.bodyScope`. Streamed
sentences are never blocked waiting for a move.

---

## The four capabilities — behavior rules

### 1. Narrated multi-step actions
Prose streams across the *whole* turn, not just the first message. If the model
says "Let me look around…" then calls `move_body` ×3 then "…there you are!", the
dock speaks the first clause, does the moves (talking continues), then speaks the
last clause. **Rule:** never buffer all speech to the end; flush each sentence as
it completes (`StreamingReplyExtractor`, fed plain prose deltas).

### 2. React to tool results
A tool returns real state. Default surfacing:
- **Success** (e.g. "moved neck to center") → silent; the move itself is the
  feedback. Do NOT speak the raw tool result.
- **Soft failure** the user should know about (body offline, invalid pair the
  catalog rejected, neck at limit) → the result text is fed back to the model,
  which *may* choose to say something ("I can't turn that far"). We don't force a
  line; we let the model react. A brief face flicker (concerned) on failure is
  allowed per tunable.
- **Never** dump tool JSON into speech (the old failure mode).

### 3. Live per-action status
`AgentState.ToolCalling` carries a **human phrase**, not the raw tool name:
`move_body{neck,lookUp}` → "looking up", `set_face{happy}` → "smiling",
`move_body{foot,left}` → "turning left". Mapping lives in the adapter. The status
line/pill shows it in real time as each tool runs, then returns to Speaking.

### 4. Mid-turn steering
- A **tap while Speaking** = barge-in (today's behavior): hard-cancel + listen.
- A **new utterance arriving mid-turn** (e.g. debug SAY, or future always-listen)
  → `agent.steer(message)` (pi-kt queue) so the loop adapts at the next turn
  boundary instead of hard-cancelling. "No, the other way" refines the action.
- **Long-press** = hard abort always (`stop()` → silence → Idle).

---

## Latency & fallbacks (multi-step reality)

A turn can take several **steps** (each step = model → tool → model again).
Rules so gaps feel intentional, not broken:
- During any model gap > ~400ms with nothing spoken yet → show `Thinking` (dots),
  never a frozen blank.
- If the model is **acting** (tools running) between speech → keep the per-action
  status visible so the user sees *why* it's quiet.
- **Unreachable model / runaway loop** → the turn is bounded by `TURN_TIMEOUT`
  (60s wall-clock, in `DockAgent`); on hit it speaks the fallback line, settles
  to `Failed`/Idle, and never hangs. (There is no per-turn tool-call *count*
  ceiling today — the loop is bounded only by the timeout. A count cap is a
  possible future guard if a model spins on cheap tools within the window.)

---

## Tunables (iterate here)

| Tunable | Default | Effect |
|---|---|---|
| sentence flush | on `.!?…` + space (`StreamingReplyExtractor`) | how eagerly speech starts |
| narration vs silent-act | narrate | whether the model is prompted to talk through actions |
| tool-success speech | silent | speak success results or not |
| failure face flicker | on | concerned flash on soft failure |
| `think` | `false` | gemma latency vs reasoning |
| status phrasing map | adapter table | per-action wording |
| `TURN_TIMEOUT` | 60s | hard hang ceiling |

---

## Acceptance (how we judge it on the phone)

Per "prototype then judge" — drive via `adb … SAY`, watch logcat + the dock:
- "say hi and look left" → speaks a greeting *and* turns; status walks Waiting→
  Thinking→Speaking→"turning left".
- "look around then face me" → **multi-step**: narrates while doing several moves.
- "what do you see" → vision turn (image attached), describes the scene.
- body offline + "nod" → dock *reacts* ("I can't move right now"), not silent/hung.
- tap mid-speech → barge-in; long-press → hard stop.
- measure per-turn latency; if multi-step turns drag, consider a step-count cap
  (none today — only `TURN_TIMEOUT`) or a single-step fast-path for trivial requests.

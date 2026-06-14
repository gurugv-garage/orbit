# Tasks v1 — design + implementation plan

**Status: DESIGN, ready to build. 2026-06-13.**
The consolidated, build-ready spec for **tasks**: long-running background jobs the
dock brain authors, runs, and supervises. Companion to
[SERVER-BRAIN-IMPL.md](SERVER-BRAIN-IMPL.md) (turn lifecycle, wire protocol),
[SERVER-BRAIN-SELFMOD.md](SERVER-BRAIN-SELFMOD.md) (Skills — the pattern this
mirrors), [MEDIA-PROCESSING.md](MEDIA-PROCESSING.md) (SFU tap, FrameGrabber).

---

# Part I — The design

## 1. What a task is

The brain today is request-response: the phone sends a turn-request, one turn
runs, the robot acts only when spoken to. **Tasks** let it take on long-running
background jobs — *"watch me and tell me when I pick up my phone"*, *"remind me
every 5 minutes to drink water"*, *"find me"*.

> A **task** is a `goal` the brain LLM turns into **an actual script** — a single
> heavily-documented `task.ts`. The station **supervises it as a separate OS
> process in a tmux window**, so you can attach and watch live; its **logs are the
> progress indicator**. A task is **resumable** (checkpoint on disk). Each
> `task.ts` is **self-describing** (a goal doc-comment + a manifest), so the LLM
> browses existing tasks and decides **reuse vs. create** — exactly the Skills
> flow.

Four ideas carry the design:

- **One primitive (§3).** Every task is built from `ctx.step(body)` — run one unit
  of work, harness-wrapped with checkpoint + status. *When* it runs is ordinary
  code the body writes (a loop, an event). Control happens at the step boundary.
- **Definition vs. instance (§2).** A `task.ts` is a reusable *template*; running
  it makes an *instance* with its own process + state. One template → many
  instances.
- **A task is a child session (§5).** A running task is its own pi session,
  parented by the dock's conversation, which supervises it (pull status, pause,
  stop) and which the task pushes updates to.
- **Tasks live in src, run as processes.** A `task.ts` sits under
  `orbit-station/server/src/tasks/` so it can `import` station types, but each
  runs as its **own process** — all runtime dock access is over the wire (§7),
  like the phone or a sidecar. Shared src buys type safety, not in-process
  coupling.

## 2. Definition vs. instance

Two different things (like a class vs. its objects):

- A **definition** is the reusable template — a single `task.ts` in the src tree
  (doc-comment spec + manifest + code). Browsed for reuse, edited, shared across
  docks. Addressed by **`name`** (kebab, unique). No runtime state.
- An **instance** is one running job from a definition, on one dock, with concrete
  inputs. Has a child session, `status.md`, `state.json`, `task.log`, a tmux
  process, a lifecycle state. Addressed by a short **`instanceId`** (`t-`+4 chars).

**One definition → many instances** — run `remind-every` for water *and* for
stretching = two instances, one definition. So **`name` addresses definitions;
`instanceId` addresses running jobs.**

### On disk

```
# DEFINITION — shared, in the src tree (keyed by name)
orbit-station/server/src/tasks/<name>/
  task.ts          # the ONE file: doc-comment spec + manifest + runnable (§3)

# INSTANCE — one running job (keyed by instanceId), under the dock's data lane
.data/brain/<dock>/tasks/<instanceId>/
  status.md        # self-maintained progress summary (get_task_status pulls this)
  state.json       # checkpoint — scratch the body persists (resumable)
  task.log         # stdout/stderr (the progress indicator; tailed to console + tmux)
  meta.json        # definition name, inputs, dock, createdAt, parentSessionId, child sessionId
```

The instance's **child pi session** (its history) lives in the same
`SessionStore`, keyed `(dock, parentSessionId, instanceId)`. Both `status.md` and
the child session are torn down when the parent session ends (§5).

### The single file

A definition is **one `task.ts`** — no separate metadata file, so spec and code
can't drift. The **top doc-comment** is the human-readable goal (what the next LLM
reads to decide reuse-vs-create); a typed **`manifest`** export carries the
machine-readable bits, including the **input schema**.

```ts
/**
 * # watch-for-condition
 * Watch the camera and speak when a plain-English condition becomes true.
 *
 * GOAL: loop every `interval` — ctx.step grabs the dock's latest camera frame and
 * asks a cheap vision model whether `condition` is TRUE. Note progress via
 * ctx.status(). On the first false→true transition, ctx.notify(on_trigger). At
 * `timeout`, ctx.finish(). Checkpoint lastAnswer so a restart resumes mid-watch.
 */
import { defineTask, type TaskManifest } from '../_harness/index.js';

export const manifest = {
  name: 'watch-for-condition',
  description: 'Watch the camera and speak when a condition becomes true',
  resumable: true,                   // default true — checkpoint to state.json
  params: [                          // the INPUT SCHEMA — key/vals, validated at run_task
    { name: 'condition',  type: 'string',   required: true },
    { name: 'on_trigger', type: 'string' },
    { name: 'interval',   type: 'duration', default: '5s' },
    { name: 'timeout',    type: 'duration', default: '10m' },
  ],
  // profile: { model: 'google/flash-lite' },  // OPTIONAL — the task's own internal brain (§5)
} satisfies TaskManifest;

export default defineTask(async (ctx) => { /* the §3 body reads ctx.params.* */ });
```

The manifest is small: `name`/`description` (reuse discovery), `resumable`,
optional `profile`, and **`params` — the task's input schema** (the typed key/val
knobs `run_task` fills in, with `required`/`default`). This is the task's
*signature* — the contract a caller satisfies, not redundant with the body any
more than a function's parameter list is. **The `params` keys are decided at
authoring time** (§6). **Cadence and whether-it-pushes are NOT manifest fields** —
they're `ctx.step`/`ctx.notify` calls and ordinary code in the body (§3).

## 3. The task contract — one primitive

Every task is built from **one primitive, `ctx.step(body)`**: run one LLM-authored
unit of work, which the harness wraps with checkpoint + status. **When the step
runs is ordinary code the body writes** — a loop, an event handler, nothing fixed.

```ts
export default defineTask(async (ctx: TaskCtx) => {
  while (!ctx.done) {                          // cadence is CODE — here, a loop
    await ctx.step(async () => {               // ctx.step = run ONE wrapped unit
      const frame = await ctx.client.frame();
      const yes   = await ctx.client.askVlm(ctx.params.condition, frame);
      ctx.status(`checked ${ctx.state.checks ?? 0}× — ${yes ? 'TRUE' : 'false'}`);
      if (yes) await ctx.notify({ text: ctx.params.on_trigger, image: frame });
    });
    await sleep(ctx.params.interval);          // plain sleep — just how THIS body paces itself
  }
});
```

**`ctx.step` is the only step primitive — *when* to call it is the body's code:**

| want | the body writes |
|---|---|
| every N | `while (!ctx.done) { await ctx.step(b); await sleep(N) }` |
| on an event | `ctx.on('battery', () => ctx.step(b))` |
| self-paced / multi-step | call `ctx.step(b)` in your own control flow (a sweep choosing its next pose) |
| one-shot | `await ctx.step(b); ctx.finish()` |

`sleep`, the `while`, the event handler are **ordinary code** the body happens to
use — not framework primitives. A task might have no `sleep` at all.

**Control happens at the step boundary.** The harness's grip on a task is
`ctx.step`: before running a step it checks whether the task should keep going
(paused? stopping?), and the body's `while (!ctx.done)` checks `ctx.done` each lap.
A task that should stop simply doesn't run its next step — it exits with
`finish`/`errored` + a reason. **No abort signal threads through `sleep`, no
mid-step interruption.** If the parent needs to hard-kill, the supervisor **kills
the tmux process** — blunt, always works; the last checkpoint survives.

**`ctx.notify` — optional mid-run push.** Pushes a mid-run update to the parent
(e.g. a watch firing) as an autonomous turn (§7a). Optional: a task that never
calls it is pull-only (the parent reaches in via `get_task_status`). Whether a
task pushes is the body's choice, baked in at authoring — no flag.

**`finish` / `errored` / `stuck` — the three outcomes**, each of which **notifies
the parent** (announcing "done"/"failed"/"I need something" always reaches the
conversation, distinct from discretionary `notify`):

| call | meaning | state after | parent told |
|---|---|---|---|
| `ctx.finish(summary?)` | completed | `done` | "finished — <summary>" |
| `ctx.errored(why)` | non-recoverable failure | `errored` | "failed — <why>" |
| `await ctx.awaitInput(prompt)` | blocked, needs input | `stuck` (recoverable) | "needs: <prompt>" |

**`stuck` is the one child→parent→child loop.** `await ctx.awaitInput('which mug —
red or blue?')` parks the task (`stuck`, checkpoint flushed) and notifies the
parent with the prompt. The user answers in conversation; the parent calls
`provide_input(instanceId, answer)` (§6); the supervisor delivers it, the awaiting
call resolves, the task continues from where it parked.

```ts
interface TaskCtx {
  params: Record<string, unknown>;     // the input values from run_task (against the def's schema)
  state:  Record<string, unknown>;     // checkpoint; mutate freely, harness persists after each step
  client: StationClient;               // over-the-wire dock access (§7) — frame/move/askVlm
  status(md: string): void;            // overwrite status.md (the pull surface)
  log(line: string): void;             // → task.log
  notify(ev: { text: string; image?: string }): Promise<void>;  // optional mid-run push to parent (§7a)
  step(body: () => Promise<void>): Promise<void>;  // run ONE unit, harness-wrapped (checkpoint + status)
  on(topic: string, fn: (ev: unknown) => void): void;  // subscribe a bus/perception event (call step() from it)
  finish(summary?: string): void;      // → 'done' (terminal); sets ctx.done
  errored(why: string): void;          // → 'errored' (terminal); sets ctx.done
  awaitInput(prompt: string): Promise<string>;  // → 'stuck'; resolves when parent provide_input()s
  done: boolean;                        // true after finish()/errored(), or when the harness says stop
}
```

## 4. Profile, memory

By default a task reuses the **dock's own profile** (persona + `brainModel`). A
manifest **may declare its own `profile`** (persona + model) — a strict tidiness
judge, a cheap flash-lite watcher — and the task's *internal* reasoning runs as
that character. Safe because the **user-facing voice is always the parent's**:
every announcement routes through the parent session and is spoken as the dock, so
a task's internal persona never becomes a second self talking to the user.

A task's **memory is its child pi session** — full history, so a watcher genuinely
remembers what it has seen across steps and can reason over it, not just a flat
boolean in `state.json` (`state.json` is for cheap scalar checkpoints).

## 5. Lifetime — tasks live and die under the parent

A running task is its own pi session, child of the one conversational session:

- **One open conversational session per dock** stays the invariant. Task sessions
  nest under it (many allowed), keyed `(dock, parentSessionId, instanceId)`,
  excluded from `openSession`.
- **A session ends only on explicit signals** — the mobile app closing, or "End
  session" in the console. *Not* idle, *not* task activity. (No idle-close guard.)
- **Ending a session kills every task under it** — processes killed, child
  sessions closed, silently.
- **A task ending informs but doesn't disrupt the parent** — `finish`/`errored`/
  `stuck` notify (so the robot says "done"/"failed"/"needs X"); the conversation
  isn't interrupted.
- **Reopening an old session does NOT revive its tasks** — the transcript returns;
  tasks died at close and must be respawned.

> **`SessionStore` is ours, not pi's** (we deliberately don't use pi's session
> repo). pi only sees a stateless `Agent` + the message array we hand it. Child
> task sessions are just *more `Agent`s + transcripts in our store* — no upstream
> coupling. The change: add `kind` + `parentSessionId` to `SessionMeta`; exclude
> task sessions from `openSession`; `close` cascades to children; `reopen`
> restores only the conversation.

## 6. Authoring + tools

### Authoring (interactive, like a coding workflow)

Creating a *new* definition is **not** a silent tool call — it's an interactive
session with the user. It reuses the brain's code/file mutation machinery + the
approve-all gate (`#approveAllMutations`, `filetools.ts`), pointed at
`tasks/<name>/`. When the brain decides to create (reuse failed):

1. **Confirm the intent.** *"I'll make a task that watches X every N and speaks up
   — sound right?"*
2. **Define the input schema + scaffold.** The LLM decides the task's `params`
   here (the keys it reads as `ctx.params.*`, with `required`/`default`). The
   harness provides the plumbing; the LLM never writes it.
3. **Author the `step` body + cadence**, reading `ctx.params.*`, `ctx.notify` as
   needed. **If it needs a dependency, the brain ASKS** (*"needs `node-cron` — ok
   to install?"*), gated by approve-all. Nothing installed silently.
4. **Iterate** — validate by typecheck / dry-import; refine on compile error or a
   behavior change until the user's happy. A definition that never validates is
   never committed.
5. **Confirm before first run.**

**Running a *reused* definition is lightweight** — the heavy
confirm-install-iterate path is paid once per definition.

### Tools (model-facing)

`buildDockTools` gains `getTasks`. **Definition tools take `name`; instance tools
take `instanceId`** — enforced in schemas.

*Definitions (by `name`):*
- **`list_tasks`** — no args; lists available **definitions** (`name: description`)
  and this dock's live **instances** (`instanceId` + definition + state).
- **`run_task`** — `{ name, params }` — instantiate; returns the new `instanceId`.
  **Before calling, the LLM must have a correct value for every required key in the
  definition's `params` schema — and if it doesn't, it ASKS the user first**
  (*"watch for what, exactly?"*) rather than guessing. The harness also validates
  and refuses a missing/ill-typed required param.
- **`write_task`** — `{ name, description, goal }` — opens the authoring session
  (§6), where the LLM also defines the `params` schema. Use only when no existing
  definition fits.
- **`edit_definition`** — `{ name, goal?, params? }` — change the definition,
  regenerate `task.ts`; affects future instances.

*Instances (by `instanceId`):*
- **`get_task_status`** — `{ instanceId }` — the pull: `status.md` + log tail +
  state.
- **`provide_input`** — `{ instanceId, answer }` — unblock a `stuck` task.
- **`pause_task` / `resume_task` / `stop_task`** — `{ instanceId }` (or `"all"`).
- **`reconfigure_task`** — `{ instanceId, params? }` — re-param one live instance;
  restarts from checkpoint.

## 7. The over-the-wire client (`tasks/_harness/station-client.ts`)

A task is a separate process, so it connects to the station `/ws` as a peer.
Typed against the same src (`client.move(steps: MoveStep[])` uses the real
`MoveStep`), but every call is a wire message:

```ts
// inside a ctx.step body — against TaskCtx (§3)
const frame = await ctx.client.frame();                       // → the dock's latest SFU frame
const yes   = await ctx.client.askVlm(ctx.params.condition, frame);  // → station runs the cheap VLM (an RPC)
if (yes) await ctx.notify({ text: ctx.params.on_trigger, image: frame });
await ctx.client.move([{ parts: [{ part: 'foot', degrees: -45 }], duration_ms: 450 }]);
```

The task never calls `speak` — it calls `ctx.notify` (mid-run) or
`finish`/`errored`/`stuck` (terminal). The harness turns any of these into **parent
injection** (§7a).

### 7a. Parent injection (`notify` + outcomes)

The harness injects a **station-originated turn** into the per-dock turn lane with
trigger kind `'task'`, composing with the existing supersede logic
(`handleTurnRequest`) **without touching it**:

```ts
enqueueAutonomousTurn(req: TurnRequest & { expiresAt?: number }): void {
  if (this.#autoQueue.length >= 4) this.#autoQueue.shift();   // drop oldest, log
  this.#autoQueue.push(req);
  void this.#drainAuto();
}

async #drainAuto() {
  if (this.#draining) return;
  this.#draining = true;
  try {
    while (this.#autoQueue.length > 0) {
      while (this.#running) { try { await this.#running; } catch { /* unwound */ } }  // user priority
      const settle = num(this.#d.config('brainTaskSettleMs'), 1500);
      if (Date.now() - this.lastTurnEndedAt < settle) { await sleep(250); continue; }
      const req = this.#autoQueue.shift()!;
      if (req.expiresAt != null && Date.now() > req.expiresAt) continue;  // stale news dropped
      const run = this.#runTurn(req);
      this.#running = run;        // ← a user turn-request can now supersede it normally
      try { await run; } catch { /* logged */ } finally { if (this.#running === run) this.#running = undefined; }
    }
  } finally { this.#draining = false; }
}
```

Why it's safe: **task queued, user speaks** → the loop parks on `await #running`;
users are never starved. **Task turn running, user speaks** → `handleTurnRequest`
supersedes it like any turn (not retried; obs records `announceInterrupted`).
**No interleave gap** — no `await` between the `while(#running)` exit and
`#running = run`. **A notify can never race a closed parent** — a task dies with
its parent (§5), so the target session is always live.

Three `#runTurn` changes: (1) obs `TurnStart` uses `req.trigger.kind` not
hardcoded `'user'`; (2) `trigger.kind==='task'` always attaches the image; (3) the
`accepted` turn-status carries `autonomous: true` when kind ≠ `'user'`.

### 7b. Phone change — autonomous-turn adoption (the only device change)

`RemoteBrain.kt` drops frames whose `turnId != currentTurnId`. Fix in
`onTurnStatus`, before the gate:

```kotlin
if (p.str("state") == "accepted" && p.bool("autonomous") && turnId.isNotEmpty()) {
    if (turnActive) return        // local user turn in flight; station sorts it out
    adoptAutonomousTurn(turnId)   // currentTurnId = lastTurnId = turnId; turnActive = true; reset state
    return                        // Waiting(BRAIN_LABEL); tools.beginTurn(); watchdog
}
```

After adoption every path works untouched. **Version skew degrades gracefully**:
old app + new station → task turns silent but harmless; new app + old station →
`autonomous` never appears.

## 8. Supervisor, config, REST, console

### Supervisor (`modules/brain/tasks/supervisor.ts`) — tmux process per instance

```
start(dock, name, params)   mint instanceId; tmux new-window -n task/<dock>/<instanceId>;
                            spawn `node task.js` w/ INSTANCE_ID + PARAMS + STATION_URL + DOCK. RETURNS instanceId
pause(dock, instanceId)     set a pause flag (checked at the next step boundary) — state: paused
resume(dock, instanceId)    clear the flag — state: running
stop(dock, instanceId)      kill the tmux process; last checkpoint survives — state: stopped
restart(dock, instanceId)   stop → start same def+params; checkpoint makes it seamless
list(dock) / logs(dock, instanceId, n)
```

Instance states: `running`, `paused`, `stuck` (recoverable via `provide_input`),
terminal `done`/`errored`/`stopped`. Crash → restart from `state.json` up to
`brainTaskMaxRestarts`, then `errored`. Runner = `brainTaskRunner`: `tmux`
(attachable, default) or `child` (headless for CI).

### Config keys (`config/registry.ts`, tag `['station']`)

| Key | Type | Default | Notes |
|---|---|---|---|
| `brainTaskMax` | int 0–10 | `3` | max concurrent instances per dock; 0 disables (tools refuse) |
| `brainTaskModel` | text | `''` | model for VLM-style task RPCs; empty = reuse `brainModel` |
| `brainTaskSettleMs` | int 0–10000 | `1500` | quiet gap before an autonomous task turn may start (§7a) |
| `brainTaskRunner` | text | `tmux` | `tmux` (attachable) \| `child` (headless) |
| `brainTaskMaxRestarts` | int 0–10 | `3` | crash-restart budget before `errored` |

### REST + console

Definitions by `name`, instances by `id`:
```
GET/POST/PUT/DELETE /api/brain/tasks[/:name]            # definition CRUD (source = task.ts)
GET  /api/brain/:dock/instances[/:id]                   # list / detail (meta + status + log + state)
GET  /api/brain/:dock/instances/:id/{status,logs}       # the pull + log tail
POST /api/brain/:dock/instances                         # start ({name,params} → run_task)
POST /api/brain/:dock/instances/:id/{pause,resume,stop,restart}
POST /api/brain/:dock/instances/:id/input               # {answer} → provide_input
```

**Console** (`web/src/modules/Brain.tsx`) — a Tasks panel, **two axes separately**:
a **Definitions list** (name/description/params; click → editable `task.ts` source
+ "Run on this dock") and an **Instances list** (id/definition/state badge/uptime/
last log; click → `status.md`, live-tailing log, child-session link, lifecycle
buttons, and — when `stuck` — the prompt + an answer box → `provide_input`).

---

# Part II — Implementation plan

**Structure first, capabilities second; the §11 test suite is the gate.** Steps
0–5 land the execution structure and turn the suite green with fakes only; nothing
touching video/audio/VLM/motion is written until then.

## 9. Build order

0. **SessionStore nesting (§5).** Add `kind: 'conversation' | 'task'` +
   `parentSessionId` to `SessionMeta`; exclude task sessions from `openSession`;
   `close` cascades to child tasks; `reopen` restores only the conversation.
   *Default: a `parentSessionId` column on the flat `sessions.json`.* Foundational.
   **Tests: §11.A.**

1. **Parent-injection bridge (§7a) + phone adoption (§7b).** `enqueueAutonomousTurn`
   / `#drainAuto`, the three `#runTurn` changes, `brainTaskSettleMs`, and the
   `RemoteBrain.kt` change. **Milestone A:** any injected task turn makes the dock
   speak unprompted. **Tests: §11.B (server) + a Kotlin unit test.**

2. **The harness `_harness/` (§3).** `defineTask`, `TaskCtx` (`step`, `on`,
   `notify`, `finish`/`errored`/`awaitInput`, `status`/`log`, `params`/`state`),
   checkpoint-per-step (read on start, write after each step), step-boundary
   control (pause flag + `ctx.done`), the manifest loader (`params` schema parse +
   validate), and the `notify`→parent bridge wiring. **Injectable clock + `Bus`
   only — no capabilities.** *Default error budget: 10 consecutive step failures →
   `errored()`.* **Tests: §11.C, the bulk.**

3. **Supervisor (§8).** tmux spawn / pause(flag) / resume / stop(kill) / restart /
   list / logs; crash-restart budget; `brainTaskRunner` (`child` for headless).
   **Tests: §11.D.**

4. **Manager + tools + REST (§6, §8).** `tasks/manager.ts`
   (`loadTaskDefs`/`writeTaskDef`/`removeTaskDef`, mirroring `skills.ts`), the
   tools (`list/get_status/run/write/edit_definition/reconfigure/provide_input/
   pause/resume/stop`), the prompt block, the REST routes. `brainTaskMax` enforced
   by refusing at `run_task`. **Tests: §11.E.**

5. **The six structure-first task definitions (§10) + the §11 suite GREEN.**
   **Milestone S (the gate):** all six run; cadence, notify/pull, outcomes,
   checkpoint-resume, stuck/resume, lifecycle, concurrency, lifetime-cascade all
   pass with fakes only. **Stop here until rock-solid.**

   — — — *capabilities below this line* — — —

6. **`StationClient` capability surface (§7)** — `frame`/`move`/`askVlm` RPCs +
   the station-side handlers (`askVlm` reuses the `#compactSummary` stateless-Agent
   pattern with `brainTaskModel`).

7. **`watch-for-condition` (§10).** **Milestone B:** "watch me and tell me when I
   raise my hand" → reuse → run → raise hand → dock speaks; "how's it going?" →
   `get_task_status` → dock reports.

8. **`search-for-target` (§10).** **Milestone C:** "find me" sweep on the ESP32
   body; verify pause/resume by talking mid-search.

9. **Console Tasks panel (§8).**

10. **Hardening.** `endSession` cascade; `reopen` restores only conversation; a
    task finishing leaves the parent untouched; obs `trigger.kind:'task'` badge;
    `npm run typecheck`.

## 10. The task definitions (what ships in `tasks/`)

**Six structure-first definitions** (no rich capability — only fakes), each a few
lines of `ctx.step`, doubling as worked examples a future LLM reads:

| `task.ts` | Cadence | Driver input (fakeable) | Goal | Exercises |
|---|---|---|---|---|
| `remind-at-time` | `sleep` to a deadline | injectable clock | *"tell me when it's 12:25"* | one-shot → `notify` → `finish()` |
| `remind-every` | `sleep` loop | injectable clock | *"remind me every 5 min"* | recurring `notify`, never finishes, resume after restart |
| `alert-on-battery` | `ctx.on('battery')` | `Bus` `battery` topic | *"tell me when battery ≤ 20%"* | event → step → threshold **edge** → `notify` |
| `count-then-report` | self-paced loop | none (in-body counter) | *"count to N"* | `step` loop, checkpoint each, resume mid-count, `finish(summary)` |
| `poll-value` | `sleep` loop + poll | mockable fetch/fs | *"tell me when X crosses Y"* | poll → condition → `notify`; poll error → `errored()` |
| `needs-input` | self-paced, blocks | none | *"do X, ask me Y first"* | `awaitInput` → `stuck`; `provide_input` resumes; `finish()` |

**Two capability definitions** (steps 7–8): `watch-for-condition` (a `sleep` loop:
`frame → askVlm → edge-trigger → ctx.notify`; `ctx.finish()` at timeout) and
`search-for-target` (self-paced: each `ctx.step` moves to the next pose, grabs a
frame, `askVlm`, `ctx.notify`s on a hit). Generic-loop concerns live *in the body*:
a VLM cost floor (`max(interval, 2000)ms`), edge-triggering with a refractory, the
consecutive-error budget → `errored()`. For search, pause freezes the sweep at the
step boundary; a user turn's `motion.stop` (last-write-wins on the wire) is
harmless — the body resumes the next pose when unpaused.

Video/audio stream processing arrives later purely as **more `ctx.on` topics**
(`ctx.on('frame'|'audio-vad')`) — the structure does not move.

### 10a. Reference `task.ts` files (copy these shapes)

Three worked examples spanning the surface — the single-file artifact in full
(doc-comment + `manifest` + body). The templates to imitate when writing §10.

**A. `remind-every` — a `sleep` loop that never finishes (recurring).**

```ts
/**
 * # remind-every
 * Remind the user on a fixed interval until stopped.
 *
 * GOAL: every `interval`, ctx.notify a reminder (`message`). Recurring — no
 * completion; the user stops it. Checkpoint the count so a restart resumes the
 * cadence rather than double-reminding.
 */
import { defineTask, sleep, type TaskManifest } from '../_harness/index.js';

export const manifest = {
  name: 'remind-every',
  description: 'Remind the user something on a fixed interval until stopped',
  params: [
    { name: 'message',  type: 'string',   required: true },
    { name: 'interval', type: 'duration', default: '5m' },
  ],
} satisfies TaskManifest;

export default defineTask(async (ctx) => {
  while (!ctx.done) {                                  // recurring: never calls finish()
    await ctx.step(async () => {
      ctx.state.count = (ctx.state.count as number ?? 0) + 1;   // checkpointed each step
      ctx.status(`reminded ${ctx.state.count}× — next in ${ctx.params.interval}`);
      await ctx.notify({ text: ctx.params.message as string });
    });
    await sleep(ctx.params.interval as string);        // plain sleep — ordinary code
  }
});
```

**B. `alert-on-battery` — event-driven, edge-triggered, then finishes.**

```ts
/**
 * # alert-on-battery
 * Tell the user once when battery drops to/below a threshold.
 *
 * GOAL: subscribe to the dock's `battery` events; each event runs a step comparing
 * against `threshold`. ctx.notify only on the FALSE→TRUE edge (don't re-alert while
 * still low), then ctx.finish() — one-shot.
 */
import { defineTask, sleep, type TaskManifest } from '../_harness/index.js';

export const manifest = {
  name: 'alert-on-battery',
  description: 'Notify once when battery reaches a low threshold',
  params: [{ name: 'threshold', type: 'number', default: 20 }],
} satisfies TaskManifest;

export default defineTask(async (ctx) => {
  ctx.on('battery', (ev) => ctx.step(async () => {              // event calls the step
    const pct = (ev as { pct: number }).pct;
    ctx.status(`battery ${pct}% (alert ≤ ${ctx.params.threshold})`);
    if (pct <= (ctx.params.threshold as number)) {             // edge → finish() so it can't re-fire
      await ctx.notify({ text: `Heads up — battery is at ${pct}%.` });
      ctx.finish(`alerted at ${pct}%`);
    }
  }));
  while (!ctx.done) await sleep('1h');  // keep the process alive between events; finish()/stop ends it
});
```

**C. `tidy-desk` — self-paced steps, asks for input, can error, then finishes.**
The richest shape: `awaitInput`/`stuck`, `errored`, and `finish` together.

```ts
/**
 * # tidy-desk
 * Walk a checklist of desk areas; for an ambiguous one, ASK the user; report.
 *
 * GOAL: step through `areas` one at a time (self-paced). For each, look and note
 * status. If ambiguous, ctx.awaitInput() to ask and wait (state → stuck), then
 * continue. If the camera is offline, ctx.errored(). When all done, ctx.finish().
 */
import { defineTask, type TaskManifest } from '../_harness/index.js';

export const manifest = {
  name: 'tidy-desk',
  description: 'Check each desk area, ask when unsure, then summarize',
  params: [{ name: 'areas', type: 'string[]', default: ['left', 'center', 'right'] }],
} satisfies TaskManifest;

export default defineTask(async (ctx) => {
  const areas = ctx.params.areas as string[];
  ctx.state.notes ??= {};                                    // survives restart
  for (const area of areas) {                                // self-paced: the body drives the loop
    if ((ctx.state.notes as Record<string, string>)[area]) continue;  // resume: skip done areas
    await ctx.step(async () => {
      const frame = await ctx.client.frame();
      if (!frame) { ctx.errored('camera offline — cannot inspect the desk'); return; }
      const verdict = await ctx.client.askVlm(`Is the ${area} of the desk tidy, messy, or unclear?`, frame);
      let note = verdict;
      if (/unclear/i.test(verdict)) {                          // BLOCK on the user:
        note = await ctx.awaitInput(`I can't tell about the ${area} side — is it tidy?`);
      }
      (ctx.state.notes as Record<string, string>)[area] = note;
      ctx.status(`checked ${Object.keys(ctx.state.notes as object).length}/${areas.length} areas`);
    });
    if (ctx.done) return;                                      // errored() set ctx.done
  }
  ctx.finish(`desk check: ${JSON.stringify(ctx.state.notes)}`);
});
```

Together these cover every contract member: `step`, `on`, `status`, `notify`,
`client.frame`/`askVlm`, `state` checkpointing, plain `sleep`, and all three
outcomes (`finish`/`errored`/`stuck` via `awaitInput`). The other §10 tasks are
trivial variants.

## 11. Testing

**Why it's testable without machinery:** the harness is a plain in-process module
with its time/IO injected. Tests construct a task and drive it directly, like
`session.test.ts` drives a session — no debug API, no running server, no curl.
Injected deps (real in prod, fake in tests): **time** (`sleep` resolves against an
injected clock; a test advances it by calling a function — no real waits),
**events** (`ctx.on` subscribes to the in-process `Bus`; a test `bus.publish`
delivers synchronously), **capabilities + LLM** (`ctx.client` and `notify`
reasoning use the same seams the brain fakes — a stub `StationClient` and the
scripted `streamFn`; the paid key drives `notify` for real only in smoke).

### The suite (`tasks.test.ts`) — the gate before any capability

**A. SessionStore nesting (step 0)**
- A child task session coexists while `openSession` still returns the *one*
  conversational session (child excluded).
- `close(parent)` cascades — every child task session closes / process stops.
- `reopen` restores the conversation transcript but **no** tasks.

**B. Parent injection (step 1)** — using the §7a queue + scripted `streamFn`
- A `ctx.notify` lands a `trigger.kind:'task'` turn in the parent.
- Task turn queued while a user turn runs → waits; user never starved.
- User turn supersedes a running task turn → `cancelled`, then user `done`,
  `announceInterrupted` recorded; not retried.
- Expired (`expiresAt`) injected turn is dropped, not spoken.
- Two injected turns FIFO.
- *(Kotlin)* `onTurnStatus` adopts an `accepted(autonomous)` turn; ignores it while
  a local user turn is active.

**C. The contract (step 2) — the bulk**
- **Cadence**: a `sleep` loop fires on the injected clock and re-fires; `ctx.on`
  routes a `bus.publish` into a step; a self-paced loop runs to `finish()`; a
  one-shot stops after one step.
- **Notify vs pull**: `ctx.notify` injects (assert via the queue); a pull-only task
  never injects mid-run, and `get_task_status` returns its `status.md`.
- **Outcomes**: `finish(summary)` → `done` + parent notify; `errored(why)` →
  `errored` + notify; both set `ctx.done` — and reach the parent even for an
  otherwise pull-only task.
- **Stuck/resume**: `awaitInput` → `stuck` + parent notify with the prompt;
  `provide_input` resolves and the task continues from checkpoint; a `stuck` task
  survives a process restart still waiting.
- **Checkpoint/resume**: kill mid-run, restart → continues from `state.json`
  (`count-then-report` mid-count) and does **not** re-fire a fired one-shot.
- **Step-boundary control**: a pause flag set between steps halts the next step
  (no advance); cleared → continues. `ctx.done` set externally ends the loop.
- **Error budget**: N consecutive step throws → `errored()` (status + notify),
  never a silent zombie.
- **Concurrency**: two tasks at once FIFO their notifies; `brainTaskMax` refuses
  the (max+1)th at `run_task`.

**D. Supervisor (step 3)**
- `start` mints an `instanceId`, spawns a process (or `child` runner in test),
  records pid/state; `stop` kills it and the last checkpoint survives; `restart`
  resumes from checkpoint; a crashing process restarts up to the budget then
  `errored`. (tmux mocked; `child` runner exercised for real headlessly.)

**E. Manager + tools (step 4)**
- `writeTaskDef` writes + validates-by-reload (bad `task.ts` rolled back, the
  diagnostic surfaced); `loadTaskDefs` parses each manifest (`params` schema);
  `removeTaskDef` is path-containment guarded.
- `run_task` validates inputs against the `params` schema (refuses missing/
  ill-typed required); returns an `instanceId`. `provide_input` routes to the
  right `stuck` instance.

### End-to-end (optional, not the gate)

`npm run smoke:task` runs `remind-every` + `alert-on-battery` through a real
station with a fake clock/bus and prints the unsolicited
`accepted(autonomous)/speak/done`, reusing the `smoke:brain` + `fake-phone.ts`
harness. **The gate is the unit suite above**; smoke is confidence on top.

## 12. Settled (don't re-litigate) / deferred

**Settled:** child-session task model + lifetime (§5); one `ctx.step` primitive,
cadence is code, control at the step boundary, hard-stop = kill the process (§3);
outcomes `finish`/`errored`/`stuck` (§3); one `task.ts` per definition with a
`params` input schema decided at authoring (§2, §6); `name` vs `instanceId` (§2);
per-task `profile` + child-session-as-memory (§4); approve-all-gated interactive
authoring with confirmed dependency installs (§6).

**Deferred (NOT v1):** sandboxed task process (seccomp/container) — v1 trusts the
approve-all gate; auto-respawn on session reopen (persist specs to re-arm). *(Not
deferred because already covered: wall-clock scheduling = a body's `sleep`-and-
check loop; rich memory = the child session; per-task profile = a manifest field.)*

---

# Part III — TODO (living checklist, updated as we build)

The gate is **Milestone S** (step 5): everything below the line stays untouched
until the whole structure block is green with fakes only. Tick boxes as landed;
keep this in sync with the actual work.

## Step 0 — SessionStore nesting  ·  Milestone: foundation  ·  ✅ DONE
- [x] `SessionMeta` gains `kind: 'conversation' | 'task'` + `parentSessionId?`
- [x] `openSession(dock)` returns only the `conversation` session (task sessions excluded)
- [x] `open()` tags `kind:'conversation'`; `openTask()`/`tasksOf()` added; `reopen()` invariant scoped to conversations
- [x] `close(parentSessionId)` cascades: closes child task sessions, returns their instanceIds; `session.ts` calls `stopTasks?.()` (supervisor wired step 3)
- [x] `reopen` restores the conversation transcript only (no task revival; refuses task sessions)
- [x] **Tests §11.A** (`store.test.ts`, 7 cases): coexistence + `openSession` excludes child; close cascade + returns ids; reopen no-revive; cross-parent invariant — **all green; typecheck clean; 15 session tests no regression**

## Step 1 — Parent-injection bridge + phone adoption  ·  Milestone A  ·  ✅ DONE
- [x] `enqueueAutonomousTurn` + `#drainAuto` on `DockBrainSession` (+ `#autoQueue`, `#draining`, module `sleep`)
- [x] `#runTurn`: obs `TurnStart` uses `#triggerKind`; vision-gate bypass for `'task'`; `autonomous:true` on accepted
- [x] 5 `brainTask*` config keys (`Max`/`Model`/`SettleMs`/`Runner`/`MaxRestarts`)
- [x] `RemoteBrain.kt`: `adoptAutonomousTurn` on `accepted(autonomous)` in `onTurnStatus` before the gate
- [x] **Tests §11.B** (`autonomous.test.ts`, 5): inject→speak w/ `autonomous:true` + obs kind task; queued waits for user; user supersedes (cancelled→done); expired dropped; FIFO — **all green**
- [x] **Kotlin** (`RemoteBrainTest`, +3): adopt→TTS; ignored during local turn; non-autonomous stranger still dropped — **BUILD SUCCESSFUL**
- [x] typecheck clean; 30 brain tests no regression
- [x] **Milestone A**: an injected turn makes the dock speak unprompted ✅ (proven by tests; live demo after step 4 tools)

## Step 2 — The harness `_harness/`  ·  the bulk  ·  ✅ DONE
- [x] `defineTask` + `TaskCtx` (`step`, `on`, `notify`, `finish`/`errored`/`awaitInput`, `status`/`log`, `params`/`state`/`done`) — `types.ts`
- [x] plain `sleep(duration)` resolving against an ambient injectable clock (`clock.ts`, AsyncLocalStorage) — fast in tests, real timers standalone
- [x] `runTask` runner: checkpoint after each step; step-boundary control (`host.control`→go/pause/stop); error budget (10→`errored()`); `TaskHalt` unwind; outcomes — `runner.ts`
- [x] manifest input-schema validation (`validateParams`: required/defaults/types/duration) — `manifest.ts`
- [x] parent signals via `host.emit('notify'|'finish'|'errored'|'stuck')`; injectable clock + event `subscribe` seams; `StationClient` stub interface (caps in step 6)
- [x] **Tests §11.C** (`harness.test.ts` 9 + `manifest.test.ts` 5): cadence (sleep-loop/event/self-paced); notify-vs-pull; errored; error-budget; stuck/resume; checkpoint-resume; pause/stop boundary; param validation — **all green; typecheck clean**
- [ ] (deferred → step 4) `notify`→live-queue wiring; `brainTaskMax` enforcement at run_task

## Step 3 — Supervisor  ·  ✅ DONE (inline runtime; process-spawn layered in step 4)
- [x] `instance.ts` — file-backed `TaskHost` (state.json/status.md/task.log), pause/stop control flag, awaitInput resolvers, status/logTail
- [x] `supervisor.ts` — `start` (mint `t-xxxx`, record), `pause`/`resume`/`stop`/`restart` (same id+dir → checkpoint resumes), `provideInput`, `stopForParent` cascade, `list`/`get`/`status`/`logTail`/`countRunning`/`join`
- [x] **Tests §11.D** (`supervisor.test.ts`, 6, real temp dirs + fake clock): start→signals; stop+checkpoint-survives; restart-resumes; pause/resume; provideInput unblocks stuck; stopForParent cascade — **all green; typecheck clean**
- [ ] (step 4) tmux/`child` process SPAWN wrapper + crash-restart budget around the inline runtime; config already in registry

## Step 4 — Manager + tools + REST  ·  ✅ DONE (live, proven against real server + LLM)
- [x] `tasks/manager.ts`: `loadTaskDefs`/`loadTaskDef`/`writeTaskDef`(validate+rollback)/`removeTaskDef`/`taskPromptBlock`/`extractGoal` — `manager.test.ts` 7 green
- [x] `tasks/tools.ts`: `list_tasks`/`run_task`(schema-validate + `brainTaskMax` refusal)/`get_task_status`/`provide_input`/`pause`/`resume`/`stop_task` — gated by `brainTaskMax===0`
- [x] prompt block wired into `session.ts` (browse→reuse→run; relay `[background task …]`)
- [x] `TaskSupervisor` wired into `brainModule`: `onSignal`→`enqueueAutonomousTurn`; `stopTasks` dep; bus `subscribe` for `ctx.on`; `getTaskTools` per-session w/ live parentSessionId
- [x] REST: `GET /tasks`, `GET /tasks/:name`, `GET/POST /:dock/instances`, `GET /:dock/instances/:id(+/status|/logs)`, `POST …/{pause,resume,stop,restart,input}`
- [x] **e2e tests** (`e2e.test.ts`, 2): LLM `run_task`→executes→`finish` spoken as autonomous turn; missing-required-param refusal
- [x] **LIVE smoke** (`smoke:task`): real station + real LLM — task fired every 3s, `accepted(AUTONOMOUS)` adopted, LLM relayed each reminder in-character, REST showed live `running` + status; stop worked ✅
- [x] **`write_task` (create-if-missing)** — the brain CREATES a fitting definition when none exists (scaffolder: `reminder-once`/`reminder-every`/`watch`) instead of refusing. Created defs land in `.data/brain/_tasks/` (NOT the watched src tree → no dev-server restart mid-turn) and import the harness by absolute path; `loadAllTaskDefs`/`findTaskDef` union shipped+user roots.
- [x] **prompt hardened**: "NEVER reply you can't set reminders — browse list_tasks, run a fitting one, or write_task a new one." `remind-at-time` reworked to a friendly `delay` ("in 1 minute") param, not epoch ms.
- [x] **realistic agent-flow tests** (`e2e.test.ts`, +2): user "remind me in 1 minute to take bath" → browse → run; unusual request → write_task → run. **Live on :8099**: the exact failing utterance now CREATES `remind-bath` (delay 1m) and runs it — did not refuse, did not restart the server. ✅
- [ ] (deferred, non-blocking) `edit_definition`/`reconfigure_task`; tmux/`child` process spawn (inline runtime works); reuse-accuracy nudge (LLM sometimes over-creates instead of reusing `remind-every` — prompt tuning).

## Step 5 — Structure-first definitions + GREEN  ·  **Milestone S — ✅ PASSED**
- [x] `remind-at-time`, `remind-every`, `alert-on-battery`, `count-then-report`, `poll-value`, `needs-input` shipped in `src/tasks/`
- [x] **Milestone S** (`milestone-s.test.ts`, 7): every definition runs end-to-end through the supervisor with fakes — cadence, notify/pull, finish/errored, stuck/resume, checkpoint — **all green**
- [x] full server suite `147/147` green; `npx tsc --noEmit` clean
- [x] **Structure is solid — capabilities may now proceed** (live module wiring in step 4 continues in parallel; it's plumbing, not structure)

— — — *capabilities below this line* — — —

## Step 6 — StationClient capability surface  ·  ✅ DONE
- [x] `capability-client.ts`: `frame` (SFU stream via directory+getFaces), `askVlm` (fresh tool-less Agent, `brainTaskModel`→`brainModel`, `resolveModel`/`apiKeyFor` reuse), `move` (in-process `MotionExecutor.runSteps`)
- [x] wired into `brainModule` (replaces the throwing stub); live-served

## Step 7 — `watch-for-condition`  ·  ✅ DONE (structure; live demo needs a camera)
- [x] definition shipped: `intervalStep`-style loop, edge-trigger (false→true), `on_trigger`, `timeout` auto-finish, error budget for a dead camera
- [x] **Tests** (`capability-tasks.test.ts`): edge-trigger→notify→finish; dead camera → errored. *(Milestone B on a real device pending hardware; the chain is proven.)*

## Step 8 — `search-for-target`  ·  ✅ DONE (structure; live demo needs the body)
- [x] definition shipped: center-out pose sweep via `ctx.client.move`, VLM per pose, level+announce on find, return-to-center+not-found on timeout
- [x] **Tests**: sweeps poses (move recorded), finds on YES + announces; times out → center + not-found. *(Milestone C on the ESP32 pending hardware.)*

## Step 9 — Console  ·  ✅ DONE (browser-verified)
- [x] `Brain.tsx` `TasksPanel`: two-axis layout — DEFINITIONS (list + goal + params JSON editor + "run on dock") and RUNNING (instance list w/ state badges, live status, log tail, pause/resume/restart/stop, stuck answer-box); polls every 1.5s
- [x] **Browser-verified** (Playwright + Chrome): all 6 definitions render; started `remind-every` from the UI; instance showed `running` + live status `"reminded 2× — next in 3s"`; autonomous turns appeared in the chat — screenshots captured; web `tsc` clean

## Step 10 — Hardening  ·  ✅ DONE
- [x] `endSession` cascade verified end-to-end (`e2e.test.ts` #3: run task → endSession → instance `stopped`); supervisor is source of truth via `stopTasksForParent`
- [x] reopen no-revive (store.test.ts); obs `TurnStart` carries `trigger.kind:'task'` (autonomous.test.ts)
- [x] `npx tsc --noEmit` clean (server + web); `smoke:task` live pass (real LLM, autonomous turns adopted + spoken)
- [x] full suite **149–153 green** (count varies with async timing; 0 failures)

## Notes / open-while-coding (decide inline, low stakes)
- `parentSessionId` as a column on flat `sessions.json` (vs nested) — lean: column
- error budget = 10 — tune in §11.C
- `brainTaskMax` enforced by refusing at `run_task`

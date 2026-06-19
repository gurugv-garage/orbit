# Tasks — background jobs as separate processes

**Status: BUILT + tested. As-built reference.**

A **task** is a long-running background job the dock brain authors, runs, and
supervises — *"remind me every 5 minutes to drink water"*, *"tell me in 10 minutes
to take a bath"*. Each running task is its **own OS process** that connects back to
the station over the existing WebSocket; all parent↔task communication is messages
on one topic. Companion to [agent-model.md](agent-model.md) (the brain's turn
lifecycle + WS hub; Skills — tasks reuse its progressive-disclosure + authoring
pattern). Why the design is process-per-task and not the original in-process
framework: [decision-traces/tasks-design-history.md](decision-traces/tasks-design-history.md).

---

## 1. The shape

- **A task is a separate process.** Starting one spawns `task.ts` via `tsx`. The
  process connects to the station `/ws` as a peer (role `task`), and every
  parent↔task message flows on the **`tasks` topic**, scoped to that instance.
- **The LLM implements a class.** A `task.ts` declares `class MyTask extends Task`
  and implements just **`run()`** (the work) + **`getStatus()`** (one progress
  line). The base class (`_harness/task.ts`) owns all the plumbing: connect,
  handshake, checkpoint load, the primitives. The file ends with `runTask(MyTask)`.
- **Definition vs. instance.** A `task.ts` is a reusable *definition* (addressed by
  `name`, kebab-case). Running one mints an *instance* (addressed by `instanceId`,
  `t-`+4 hex) — its own process, params, checkpoint, lifecycle state. One
  definition → many instances.
- **Tasks live in the src tree, run as processes.** `task.ts` files sit under
  `server/src/tasks/` so they can `import` the harness with types; each runs as its
  own process, talking to the station only over the wire. Shared src buys type
  safety at authoring time, not in-process coupling.

### Layout

```
server/src/tasks/
  _harness/                 the framework (NOT a task; the leading `_` excludes it)
    task.ts                 the Task base class — what an authored task extends
    run.ts                  runTask(MyTask) — the process entrypoint
    types.ts                TaskManifest / TaskParam / durationMs
    manifest.ts             validateParams (run_task input checking)
    index.ts                public surface: Task, runTask, TaskManifest, durationMs
  packaged/<name>/task.ts   committed, hand-vetted definitions (remind-after, remind-every)
  generated/<name>/task.ts  LLM-authored definitions (gitignored; .gitkeep only)

.data/brain/<dock>/tasks/<instanceId>/
  checkpoint.json           the task's persisted this.state (resume reloads it)
  task.log                  supervisor lifecycle notes + child stdout/stderr
  proc.log                  the task's own stdout/stderr (tmux runner only)
```

Generated tasks are searched **first**, then packaged, so a freshly-authored task
shadows a shipped one of the same name (`taskRoots` in `modules/brain/index.ts`).
Promote a good generated task by moving it into `packaged/`.

---

## 2. The Task base class (`_harness/task.ts`)

What the LLM implements:

```ts
import { Task, runTask, type TaskManifest } from '../../_harness/index.js';

export const manifest = {
  name: 'remind-every',
  description: 'Remind on a fixed interval until stopped.',
  params: [
    { name: 'message',  type: 'string',   required: true },
    { name: 'interval', type: 'duration', default: '5m' },
  ],
} satisfies TaskManifest;

class RemindEveryTask extends Task {
  async run(): Promise<void> {                  // the work — arbitrary code
    while (true) {
      await this.sleep(this.params.interval as string);
      await this.notifyAgent(this.params.message as string);
    }
  }
  getStatus(): string {                         // the pull surface
    return `reminding every ${this.params.interval}`;
  }
}

runTask(RemindEveryTask);
```

**The primitives** (base-class methods — everything that crosses back to the
parent agent, and nothing more):

| call | meaning |
|---|---|
| `this.params.<k>` | the `run_task` inputs (validated against the manifest; typed `unknown`, so cast) |
| `this.state.<k>` + `this.checkpoint()` | a free scratch store; `checkpoint()` persists it so a resume reloads it |
| `this.instance` | what THIS instance is about — `name`, `params`, `startedAt`, `runCount`, `spawnedAt`, `about` |
| `this.status(text)` | set what `get_task_status` returns (the PULL surface) |
| `await this.notifyAgent(text, image?)` | push an update to the user (→ an autonomous turn). Fire-and-forget |
| `await this.askAgentInput(prompt)` | ask the user and AWAIT their answer (the STUCK path) |
| `this.finish(summary?)` / `this.errored(why)` | the terminal outcome |
| `await this.sleep(ms \| "5s")` | wait. **NOT interruptible** — a stop kills the whole process |

There is deliberately **no `askVlm`/`frame`/`move`**. A task is a real Node
process: if it needs the camera or body it sends its own WS message. We don't
curate a capability menu. It can `import` any node module, run shell commands,
call HTTP — it's an ordinary process.

**One-shot vs. recurring is just code.** A one-time job does its work then calls
`this.finish()` so it stops; a recurring job loops forever and is ended by a stop.
The harness imposes no cadence — `sleep`, `while`, the loop are the author's code.

---

## 3. The wire contract (the `tasks` topic)

A task peer says hello as `{ role: 'task', dock, component: 'task:<instanceId>' }`
so `(dock, component)` is its routable address, then publishes/receives on the
`tasks` topic. The brain module routes inbound frames to the supervisor and pushes
directed frames back by `toAddr`.

**task → station** (the base class sends these):

| kind | when | → station effect |
|---|---|---|
| `attach` | right after hello (connection stable) | station replies with `init` |
| `status` | `this.status()` | updates the pull surface |
| `notify` | `this.notifyAgent()` | → autonomous turn (push to user) |
| `ask` | `this.askAgentInput()` | state → `stuck`; → autonomous turn with the prompt |
| `checkpoint` | `this.checkpoint()` | station writes `checkpoint.json` |
| `finish` | `this.finish()` | state → `done`; → autonomous turn |
| `errored` | `this.errored()` / a crash | state → `errored`; → autonomous turn |

**station → task** (directed to the task peer):

| kind | when | task effect |
|---|---|---|
| `init` | on `attach` | delivers `params` + the resume checkpoint + instance descriptor → `run()` starts |
| `input` | `provide_input` / answer a stuck task | resolves the awaiting `askAgentInput` |
| `stop` | (courtesy) | the task exits; the real stop is the supervisor killing the process |

**Identity** is passed to the spawned process via env — `STATION_WS`, `TASK_DOCK`,
`TASK_INSTANCE_ID`, `TASK_NAME`, `TASK_SESSION_ID`. **No token, no auth layer** (a
task is a local process the station itself spawned).

---

## 4. The supervisor (`modules/brain/tasks/supervisor.ts`)

Owns running instances per dock (an in-memory `#byId` map) and drives the
lifecycle. It never touches the WebSocket directly — the brain module routes task
frames in via `onFrame()` and the supervisor pushes `init`/`input` down via the
injected `sendToTask()`.

```
start(dock, name, filePath, params, parentSessionId)  mint instanceId, spawn the process → instanceId
stop(id)        kill the process; state → stopped (no-op + idempotent if already terminal)
resume(id)      respawn from checkpoint (refuses done/errored — would re-run a finished job)
pause(id)       = stop (a free-running process has no mid-run pause)
restart(id)     stop + resume
provideInput(id, answer)   only delivers to a STUCK task; state → running
stopForParent(dock, sessionId)   the session-end cascade (skips already-terminal)
list / get / status / logTail / countRunning / hasRunningUnder
```

**Instance states:** `running`, `stuck` (recoverable via `provide_input`), and the
terminal `done` / `errored` / `stopped`.

**Terminal is STICKY.** Once an instance is terminal, a late `finish`/`notify` from
a dying process is dropped — a finish racing a stop can't flip `stopped`→`done` or
re-signal the user. Lifecycle ops refuse from the wrong state (no resuming a `done`
job; input only to a `stuck` task; never relabel `done` as `stopped`).

**Resume / restart** respawn the same `instanceId` + dir, so the checkpoint carries
over; `runCount` increments (1 on first run, 2+ after a resume/restart). `startedAt`
is the first-start time; `spawnedAt` is the current process's spawn.

### Runner: `child` (default) vs. `tmux`

A task runs as either a **detached child process** (default) or in a **tmux
window** (`brainTaskRunner: 'tmux'`, falls back to child when tmux is absent).

- **child** — dies WITH the station (its WS drops → it self-exits), so a station
  restart leaves no orphans and there's nothing to rehydrate. Spawned as
  `node <tsxBin> task.ts` **directly** (not `npx tsx`) and **detached as its own
  process group**, so `stop()` can `kill(-pid)` the whole group — otherwise a
  SIGKILL hits only the `npx` wrapper and the real task survives as an orphan.
- **tmux** — an attachable window to watch a task live, but a tmux session
  **outlives the station**: after a restart the new supervisor can't see (or kill) a
  long-sleeping task. Opt-in only, for debugging. (`TASK_RUNNER_DEFAULT = 'child'`.)

A task also self-protects: the hub pings every ~2s, and if a task hears nothing for
10s it assumes the station died abruptly and self-exits (the half-open-socket case
the `close` event wouldn't catch promptly). So **no task ever outlives its
station**, on either runner.

---

## 5. Parent injection — task signals become autonomous turns

A task's `notify` / `finish` / `errored` / `stuck` reaches the user by landing a
**station-originated turn** in the dock's conversational session, with
`trigger.kind: 'task'` (`onTaskSignal` in `index.ts` → `enqueueAutonomousTurn` in
`session.ts`). The brain composes it with the normal turn lifecycle:

- A user turn always takes priority — a queued task turn waits; a user message
  supersedes a running task turn like any turn.
- `brainTaskSettleMs` (default 1500) is a quiet gap after a turn ends before an
  autonomous turn may start, so a task doesn't barge into a rapid exchange.
- Stale task news is dropped (`expiresAt`, 120s).
- The accepted turn-status carries `autonomous: true`; the phone adopts it
  (`RemoteBrain.kt`) so the dock speaks the update unprompted. Old app + new station
  degrades gracefully (task turns silent, not broken).

A `stuck` task's prompt is delivered the same way, with a nudge to call
`provide_input(instanceId, answer)` once the user replies.

---

## 6. Authoring + the model-facing tools

The brain gets a small tool set (only when `brainTaskMax > 0`; built per-session in
`tasks/tools.ts`). Definition tools take a `name`; instance tools take an
`instanceId`.

- **`list_tasks`** — available definitions (packaged + generated) AND this dock's
  running instances. Browse before authoring; **reuse** before creating.
- **`run_task`** `{ name, params }` — start an instance. Validates `params` against
  the manifest and refuses a missing/ill-typed required value (the LLM is expected
  to ask the user up front). Enforces `brainTaskMax`. Returns the `instanceId`.
- **`write_task`** `{ name, description, goal, params?, imports?, body, status? }` —
  CREATE a definition when none fits. The LLM writes the **`run()` body** (plain JS
  over `this.*`) + an optional `getStatus()` expression; `scaffold.ts` wraps it into
  a complete `class extends Task` + `manifest` + `runTask(…)`. The file is
  **typechecked** (`tsc --noEmit` on just that file) before it's saved — type errors
  come back for the LLM to fix. `imports` lets the body pull node modules.
- **`get_task_status`** `{ instanceId }` — the pull: `about` + when started + the
  self-kept status + recent log.
- **`provide_input`** `{ instanceId, answer }` — unblock a `stuck` task.
- **`pause_task` / `resume_task` / `stop_task`** `{ instanceId }` (or `"all"`).

Definitions are loaded **statically** — `manager.ts` reads the `manifest` + checks
for `class … extends Task` + `runTask(…)` from source; it never *executes* a
`task.ts` to load it (running one would connect to the station). Validation on
write = typecheck + that static shape check, with rollback on failure.

---

## 7. Lifetime, config, REST, console

**Lifetime.** Tasks belong to the dock's one conversational session
(`parentSessionId`). **Ending the session stops every task under it** (the cascade —
`stopForParent`). An open task keeps the session alive (idle-close is skipped while
`hasRunningTasks`). Tasks are processes, **not** pi sessions — the store has no
task-session concept.

**Config keys** (`config/registry.ts`, tag `station`):

| key | type | default | meaning |
|---|---|---|---|
| `brainTaskMax` | int 0–10 | `3` | max concurrent instances per dock; `0` disables the tools entirely |
| `brainTaskSettleMs` | int 0–10000 | `1500` | quiet gap before an autonomous task turn may start |
| `brainTaskRunner` | `child` \| `tmux` | `child` | how task processes run (see §4) |

**REST** (under `/api/brain`, all instance-by-id routes are dock-scoped — dockA
cannot touch dockB's tasks):

```
GET  /tasks                              all definitions (name, description, params, source)
GET  /tasks/:name                        one definition (+ manifest + goal)
GET  /:dock/instances                    running instances for the dock
POST /:dock/instances                    start ({ name, params }); 409 if no open session
GET  /:dock/instances/:id                detail (info + status + log)
GET  /:dock/instances/:id/{status,logs}  pull surface / log tail
POST /:dock/instances/:id/{pause,resume,stop,restart}
POST /:dock/instances/:id/input          { answer } → provide_input
```

**Console** (`web/src/modules/Brain.tsx`, the Tasks panel): a **DEFINITIONS** list
(name + description + a params JSON editor + "▶ run on \<dock>") and a **RUNNING**
list (instance id + state badge; click → status, live log tail, the lifecycle
buttons, and — when `stuck` — the prompt + an answer box). Note a panel run needs
an **open session** (the same 409 guard), which opens on the first chat turn.

---

## 8. Testing

- **`modules/brain/tasks/supervisor.test.ts`** — the lifecycle state machine under
  adversarial input via a fake spawn seam (no real processes): stop/finish races,
  double-terminal, lifecycle guards, tenancy + unknown-instance + malformed-frame
  drops, cascade scoping, runCount-on-resume.
- **`modules/brain/tasks/process.test.ts`** — REAL task processes over a real Hub:
  connect→init→notify→finish, a throwing task → `errored`, `stop()` kills the whole
  tree (no orphan), `askAgentInput`↔`provideInput` round-trip, a superseded ask, an
  unhandled rejection still reporting `errored`.
- **`modules/brain/tasks/manager.test.ts`** + **`_harness/manifest.test.ts`** —
  static load + typecheck-on-write + rollback + path-guarded removal; param
  validation.
- **`src/dev/e2e-console-tasks.mjs`** (`npm run -w server e2e:console-tasks`) — a
  Playwright drive of the console Tasks panel end to end: run/complete/fire/stop/
  restart/pause/resume/bad-params/chat/**end-session cascade**. Needs a live station
  + `npx playwright install chromium`; `SKIP_CHAT=1` for a deterministic run.
- **`src/dev/smoke-task.ts`** (`npm run -w server smoke:task`) — a fake-phone smoke
  that drives the real LLM path (`--say "remind me in a minute…"`).

---

## 9. Open points / not built

- **`askAgentInput` has no timeout.** A `stuck` task waits indefinitely if the user
  never answers; the only backstop is the session ending (which kills it). A future
  pass could re-notify or time out.
- **Station restart kills running tasks** — by design with the `child` runner (no
  rehydration; nothing to manage). A long "remind me in 2 hours" does **not** survive
  a station restart. Persisting instance specs to re-arm on boot is deferred.
- **No camera/body capability over the wire yet.** A task that needs a frame/VLM/
  motion would send its own `tasks`-topic request and have the station service it;
  that request/response capability layer is a future addition (deliberately not a
  curated `ctx.client` menu).
- **No per-task model/persona.** A task is a script, not a reasoning agent with its
  own brain; if a task needs an LLM call it makes its own (e.g. via an imported
  client). The earlier "child pi session as the task's memory" idea was dropped.

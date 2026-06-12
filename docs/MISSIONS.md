# Missions — long-running background tasks for the dock brain

**Status: DESIGN (not yet implemented). Last updated 2026-06-12.**
Companion to [SERVER-BRAIN-IMPL.md](SERVER-BRAIN-IMPL.md) (turn lifecycle, wire
protocol) and [MEDIA-PROCESSING.md](MEDIA-PROCESSING.md) (SFU tap, FrameGrabber).

## 0. Goal & decisions

The brain today is strictly request-response: the phone sends a
`turn-request`, one turn runs at a time per dock (60 s ceiling), and the robot
only acts when spoken to. We want it to take on **long-running tasks**:

- *"find me"* — actively sweep the body (neck/foot), checking the camera at
  each pose until the target is spotted, then announce it. Bounded, ~10–60 s.
- *"watch me and tell me when I pick up my phone"* / *"watch me study and
  remind me when I get distracted"* — a long-lived watcher that samples frames
  every few seconds, evaluates a natural-language condition, and speaks up
  when it fires.

Use cases are **not baked in**: the design is two generic mission primitives
(`watch`, `search`) the LLM composes via tools, parameterized by plain-English
conditions/targets.

Decisions (made 2026-06-12):

| Decision | Choice | Why |
|---|---|---|
| Concurrency | **Background missions** — conversation continues normally; user turns always win | A desk companion that goes deaf while watching is a worse robot |
| Watch engine | **VLM frame sampling** — grab a frame every N s, ask a cheap vision model the condition as YES/NO | Fully generic: any natural-language condition works; no hand-built detectors. Local/hybrid detectors are a later cost optimization |
| Scope v1 | Both kinds on shared infra | Proves the abstraction is generic |
| Notification | **Speak only** (autonomous turn → TTS on the phone) | Desk companion = user in earshot; console/push channels are future work |
| Mission lifetime | **Dies with the brain session** | An autonomous turn needs a live conversation context (history, persona, the asker). Future: persist specs in `SessionMeta`, re-arm on resume |

All the ingredients exist; only mission lifecycle + autonomous-turn injection
are new:

- **Frames pull-anytime**: `FaceToolsApi.frame(streamId)` returns the latest
  decoded JPEG from the dock's SFU stream (freshness-gated 1.5 s,
  `perception/face/frame-grabber.ts`), ~1–2 fps real decode rate.
- **Motion in-process**: `MotionExecutor.runSteps(dock, steps)`
  (`bodylink/motion.ts`), fire-and-forget, last-write-wins.
- **Cheap one-shot LLM pattern**: `#compactSummary()` (`brain/session.ts`) —
  fresh `Agent`, no tools, `thinkingLevel:'off'`, honors the `streamFn` test
  seam. Mission VLM ticks reuse this exactly.

## 1. Mission model

New file `orbit-station/server/src/modules/brain/missions.ts`:

```ts
type MissionKind   = 'watch' | 'search';
type MissionStatus = 'active' | 'announcing' | 'done';
type MissionResult = 'triggered' | 'found' | 'not-found' | 'timeout'
                   | 'cancelled' | 'error' | 'session-end';

interface Mission {
  id: string;                 // 'm-' + 4 chars — short, the LLM must echo it
  kind: MissionKind;
  dock: string;
  spec: WatchSpec | SearchSpec;
  status: MissionStatus;
  result?: MissionResult;
  createdAt: number;
  deadline: number;           // clamped by brainMissionTimeoutMin
  ticks: number; lastTickAt?: number; lastAnswer?: boolean;
  consecutiveErrors: number;  // no-frame / VLM failures; 10 → finish('error'), spoken
  triggerCount: number;       // repeating watch
  abort: AbortController;     // loops sleep abort-aware; cancel is instant
}
interface WatchSpec  { condition: string; onTrigger?: string; intervalMs: number; once: boolean }
interface SearchSpec { target: string }
```

State machine:

```
(tool/REST start) ──cap+precondition ok──▶ active
active ──VLM YES (watch, edge-triggered)──▶ announcing ─enqueue auto-turn─▶
        once ? done(triggered) : active (refractory max(3×interval, 30 s))
active ──target visible (search)──▶ announcing ─auto-turn "found"─▶ done(found)
active ──deadline──▶ announcing ─auto-turn reporting it─▶ done(timeout | not-found)
active ──10 consecutive error ticks──▶ announcing ─auto-turn─▶ done(error)
any    ──cancel_mission / REST DELETE / endSession──▶ done(cancelled | session-end), silent
```

**Ownership**: `DockBrainSession` constructs a `MissionManager` in its
constructor (sibling of `#baseTools`); exposed as public `readonly missions`
for tools.ts and the REST routes. The manager calls back into the session via
exactly two members: `session.turnActive` (getter) and
`session.enqueueAutonomousTurn(req)`.

**Start-time preconditions** (refusals **throw** — pi turns throws into error
tool results, matching the existing tool contract):
- count cap: `brainMissionMax` (default 3); 0 disables missions entirely
- camera cap resolvable (`directory.resolveCap(dock,'camera')`) for both kinds
- `motion.isOnline(dock)` for `search`

**Session interplay**:
- `endSession(reason)` → `missions.cancelAll('session-end')` — no announcement.
- **Idle-close guard**: `maybeIdleClose()` returns early while
  `missions.activeCount() > 0`. Without this, a silent 2-hour watcher dies at
  the 30-min idle sweep. The mission timeout ceiling bounds the extension, so
  a leaked mission can't pin a session forever.
- Every loop body is wrapped in try/catch → `finish('error')`; a mission crash
  can never take the session down.

## 2. Autonomous turn injection — the queue (the subtle core)

A mission that fires must make the robot speak. It does so by injecting a
**station-originated turn** into the same per-dock turn lane, with a new
trigger kind `'mission'` (alongside `'user'`). The design composes with the
existing supersede logic (`handleTurnRequest`, session.ts ~161–189)
**without touching it**:

```ts
enqueueAutonomousTurn(req: TurnRequest & { expiresAt?: number }): void {
  if (this.#autoQueue.length >= 4) this.#autoQueue.shift();  // drop oldest, log
  this.#autoQueue.push(req);
  void this.#drainAuto();
}

async #drainAuto() {
  if (this.#draining) return;
  this.#draining = true;
  try {
    while (this.#autoQueue.length > 0) {
      // user priority: wait for the WHOLE current chain (including queued
      // user supersede closures) to settle before taking the lane
      while (this.#running) { try { await this.#running; } catch { /* unwound */ } }
      // settle gap: don't barge into a rapid user exchange
      const settle = num(this.#d.config('brainMissionSettleMs'), 1500);
      if (Date.now() - this.lastTurnEndedAt < settle) { await sleep(250); continue; }
      const req = this.#autoQueue.shift()!;
      if (req.expiresAt != null && Date.now() > req.expiresAt) continue; // stale news dropped
      const run = this.#runTurn(req);
      this.#running = run;           // ← a user turn-request can now supersede it normally
      try { await run; } catch { /* logged in #runTurn */ }
      finally { if (this.#running === run) this.#running = undefined; }
    }
  } finally { this.#draining = false; }
}
```

Why it's safe:

- **Mission queued, user speaks** → the drain loop is parked on
  `await #running` (or the settle sleep); the user keeps the lane; the loop
  re-checks. Mission turns only ever start in a free lane — users are never
  starved.
- **Mission turn running, user speaks** → `handleTurnRequest` supersedes it
  exactly like any turn (abort → `cancelled` → phone goes Idle; half-spoken
  announcement dies via the existing no-flush-on-cancel rule). A superseded
  announcement is **not retried** — re-blurting stale news minutes later is
  worse; the obs end event records `announceInterrupted: true`.
- **No `#latestReq` interaction** — autonomous turns never read/write it, so
  queued user-closure semantics (`#latestReq !== req` drop) are unaffected.
- **No interleave gap** — there is no `await` between the `while (#running)`
  exit and `this.#running = run`, so on the single-threaded loop a user
  request cannot slot into the gap.
- **Mission-vs-mission** — simultaneous triggers FIFO through `#autoQueue`.

Three small `#runTurn` changes:
1. The obs `TurnStart` uses `req.trigger.kind` instead of the hardcoded
   `'user'` (the obs `Trigger` type is already kind-agnostic; the console
   badges it for free).
2. **Vision-gate bypass**: `trigger.kind === 'mission'` always attaches the
   image — the triggering frame *is* the evidence, and mission text won't
   match the vision-intent regex.
3. The `accepted` turn-status frame carries **`autonomous: true`** when
   trigger kind ≠ `'user'` — the phone's adoption signal (§5).

Mission trigger payload (built by MissionManager):

```ts
{
  turnId: `auto-${randomUUID()}`,
  trigger: { kind: 'mission', text:
    `[background mission ${id} fired] You were watching for: "${condition}". ` +
    `It just happened (see the attached camera frame). ` +
    (onTrigger ?? 'Briefly tell the user what you noticed.') },
  imageBase64: triggeringFrame,      // the exact frame the VLM said YES to
  expiresAt: Date.now() + 120_000,   // stale news is dropped, not spoken
}
```

Search variants phrase accordingly: found → *"…they're in view now. Greet
them!"*; timeout → *"…You looked around for 45 s and could not find them.
Briefly say so."*

## 3. Tool surface (model-facing)

`buildDockTools` (tools.ts) gains `getMissions: () => MissionManager`; four
tools appended (schemas in schemas.ts, same TypeBox/JSON-schema style):

**`start_watch`** — *"Start a BACKGROUND WATCH: every few seconds you'll check
the camera for a condition while the conversation continues normally. When it
becomes true you wake up and tell the user. Use when asked to
watch/monitor/keep an eye out/remind-me-when. Returns the mission id."*

| arg | type | notes |
|---|---|---|
| `condition` | string, required | plain-English YES/NO condition, e.g. "the person picks up a phone" |
| `on_trigger` | string | what to say/do when it fires, e.g. "gently remind them to get back to studying" |
| `interval_s` | int 2–60 | seconds between checks (default `brainWatchIntervalSec`) |
| `timeout_s` | int 10–3600 | give up after (default 600, clamped by `brainMissionTimeoutMin`) |
| `once` | bool | default true; false = fire each time it newly becomes true |

**`start_search`** — *"Start a BACKGROUND SEARCH: you physically look around
(sweeping neck and foot), checking the camera at each pose until you spot the
target, then announce it. Use when asked to find/look for someone or
something. Returns the mission id."*

| arg | type | notes |
|---|---|---|
| `target` | string, required | e.g. "guru", "a person", "a red mug" |
| `timeout_s` | int 5–120 | default 45 |

**`list_missions`** — no args; one line per mission:
`m-a1b2 watch ACTIVE 42s "person picks up phone" (8 checks)` or
`no background missions running.`

**`cancel_mission`** — `id` (from start/list) or `"all"`.

**prompt.ts** — ~6-line addition to `SYSTEM`: the model can run background
missions while the conversation continues; `start_watch` for "tell me
when…"/"watch me and remind me if…", `start_search` for "find me"/"look
for…"; confirm briefly on start; react to `[background mission]` messages by
speaking to the user; manage with `list_missions`/`cancel_mission`; don't
start duplicates.

## 4. The two loops

New file `brain/vlm.ts` — **`askYesNo(model, question, imageB64)`**: fresh
`Agent` (the `#compactSummary` pattern — empty tools/messages,
`thinkingLevel:'off'`, `getApiKey: apiKeyFor`, honors the `streamFn` seam),
system prompt *"You answer strictly YES or NO."*, user content = text +
`ImageContent`, parse `/^\s*yes/i` → `{ answer: boolean } | { error: string }`.
Model: `brainMissionModel` config; empty ⇒ fall back to `brainModel` via the
existing `resolveModel`/`apiKeyFor`. **Hard floor between calls:
`max(intervalMs, 2000)` measured end-of-call → next call** — the cost guard
holds even when VLM latency exceeds the interval.

Shared per-tick helper **`frame()`**: re-resolve `streamId` via
`directory.resolveCap(dock,'camera')` each tick (streams reconnect), then
`getFaces()?.frame(streamId)`. `undefined` (no stream, or stale > 1.5 s — a
covered/paused camera) counts an error tick.

### Watch loop

A serialized `async` loop with abort-aware sleep — **not `setInterval`**, so a
slow VLM call can never pile up overlapping ticks:

```
while active && now < deadline:
  if session.turnActive or in refractory → sleep 500 ms, continue
      // don't burn VLM calls mid-conversation; the user is engaged anyway
  f = frame(); if !f → errors++ (maybe finish('error')); sleep(interval); continue
  ans = askYesNo("Condition: <condition>. Is this TRUE in the image?", f)
  EDGE-TRIGGERED: fire only on false→true transition (first tick: lastAnswer=false)
  on fire → obs trigger event → enqueueAutonomousTurn(frame attached)
          → once ? finish(triggered) : refractoryUntil = now + max(3×interval, 30 s)
  sleep(remaining interval)
deadline → auto-turn announcing the watch ended without firing → finish(timeout)
```

### Search loop

Sweep poses derived from `DEGREE_LIMITS` (schemas.ts — neck −60…+35°, foot
±90°): foot yaw `[0, −45, −90, 45, 90]` × neck `[0, −25]` — 10 poses,
**center-out** so the common case (user roughly in front) is fast; cycled
until deadline:

```
for pose of cycle(poses):
  while session.turnActive → sleep 400 ms        // PAUSE (see below)
  if done/deadline → break
  try motion.runSteps(dock, [{ parts: [{part:'foot',degrees:yaw},
                                       {part:'neck',degrees:pitch}], duration_ms: 450 }])
  catch → errors++ (body offline mid-mission), sleep 2 s, continue
  sleep ~1000 ms      // servo travel (450) + grabber freshness (~1–2 fps)
  if session.turnActive → continue               // frame may be from a stomped pose
  f = frame(); if !f → errors++, continue
  ans = askYesNo("Is <target> clearly visible in the image?", f)
  if yes → motion.runSteps(level neck at current yaw)
        → auto-turn "found" (frame attached) → finish(found)
deadline → runSteps back to {foot:0, neck:0} → "couldn't find" auto-turn → finish(not-found)
```

**The `motion.stop` conflict, resolved by pause/resume**: every user turn
start calls `motion.stop(dock)` (session.ts `#runTurn`) and any brain `move`
supersedes our sequence (last-write-wins). The sweep is robust *by
construction*: each pose is its own short `runSteps`, gated on
`!session.turnActive`, so a user turn freezes the sweep mid-pose and the next
iteration re-sends the next pose once the lane is idle. The deadline clock
keeps running during pauses — a search shouldn't smolder for minutes.

## 5. Phone change — autonomous-turn adoption (the only device change)

`RemoteBrain.kt` drops any frame whose `turnId != currentTurnId` (`onSpeak`
~:253, `onTurnStatus` ~:303) — today a station-originated turn's speak frames
are silently discarded. Fix in `onTurnStatus`, **before** the gate:

```kotlin
if (p.str("state") == "accepted" && p.bool("autonomous") && turnId.isNotEmpty()) {
    if (turnActive) return        // local user turn in flight; station sorts it out
    adoptAutonomousTurn(turnId)   // currentTurnId = lastTurnId = turnId; turnActive = true;
    return                        // reset spokeThisTurn/replyAcc/turnStartMs;
}                                 // Waiting(BRAIN_LABEL); tools.beginTurn(); watchdog
```

After adoption every existing path works untouched: `onSpeak` passes the gate
→ TTS; terminal `done/failed/cancelled` → `endTurnLocally()`; tap-to-stop
sends `turn-cancel {turnId}` which matches `#activeTurnId` station-side;
`speech-status` markers attribute `TurnSettled` via `lastTurnId`.

**Version skew degrades gracefully both ways**: old app + new station →
mission turns are silent but harmless (frames dropped as today); new app + old
station → `autonomous` never appears.

## 6. Config keys (`config/registry.ts`, tag `['station']`)

| Key | Type | Default | Notes |
|---|---|---|---|
| `brainMissionMax` | int 0–10 | `3` | 0 disables missions (tools refuse) |
| `brainMissionModel` | text | `''` | VLM for ticks, `provider/modelId`; empty = reuse `brainModel`. Suggest a flash-lite-class model |
| `brainWatchIntervalSec` | int 2–60 | `5` | default tick when the tool omits `interval_s` |
| `brainMissionTimeoutMin` | int 1–240 | `60` | hard ceiling clamping any tool-supplied timeout |
| `brainMissionSettleMs` | int 0–10000 | `1500` | quiet gap after a turn before an autonomous turn may start |

## 7. REST + observability

- `GET /api/brain/:dock/missions` → `missions.list()` (id, kind, status,
  result, condition/target, createdAt, deadline, ticks, lastTickAt,
  triggerCount).
- `DELETE /api/brain/:dock/missions/:id` → cancel (`:id = all` supported;
  404 unknown).
- Obs topic, **`kind: 'mission'`** — live-only by construction (the obs store
  only ingests `kind: 'event'`; no store/schema change): payload
  `{ dock, missionId, type: 'start'|'tick'|'trigger'|'end', ts, ...detail }`
  with tick detail `{ answer, vlmMs, poseIdx? }` and end detail
  `{ result, ticks, announceInterrupted? }`.
- The autonomous turn itself lands in the obs store as a regular turn with
  `trigger.kind: 'mission'` for free once §2 item 1 ships.
- (Optional v1.5) `web/src/modules/Brain.tsx`: missions card with cancel
  buttons over the REST routes.

## 8. Implementation order (demoable early)

1. **session.ts queue + trigger plumbing** (`enqueueAutonomousTurn` /
   `#drainAuto`, obs trigger kind, vision-gate bypass, `autonomous: true`) +
   session.test.ts cases: (a) auto turn waits for an in-flight user turn;
   (b) a user request supersedes a running mission turn (`cancelled` then user
   `done`); (c) expired auto turn dropped; (d) two auto turns FIFO.
2. **Phone adoption** (RemoteBrain.kt + Kotlin unit test).
   **Milestone A**: any `enqueueAutonomousTurn` makes the dock speak unprompted.
3. **Config keys + vlm.ts + MissionManager (watch) + tools + prompt + REST +
   obs.** **Milestone B (headline)**: phone streaming to the SFU, say "watch
   me and tell me when I raise my hand" → dock confirms, conversation
   continues, raise hand → dock speaks up.
4. **Search loop.** **Milestone C**: "find me" with the ESP32 body — neck/foot
   sweep, "found you!"; verify pause/resume by talking to it mid-search.
5. **Hardening**: idle-close guard, error-budget path, refractory,
   `endSession` cancelAll, dock-offline (keep the mission; the announcement
   no-ops via `#sendToVoice`'s existing null-target return — log it),
   `npm run typecheck`.
6. (Optional) Brain.tsx missions card.

## 9. Verification

- **Unit** (`npm -w server run test`): missions.test.ts with a fake
  `FaceToolsApi` (canned base64 / `undefined` frames), a scripted `streamFn`
  answering YES/NO (the same seam `makeSession` injects in session.test.ts),
  and a `MotionExecutor` over a real `Bus` + fake roster asserting the sweep's
  `set_target` frames (pattern: session.test.ts `makeSession`).
- **End-to-end, no hardware**: extend `server/src/dev/fake-phone.ts`
  (`npm run smoke:brain`) with a `--watch` mode — send the watch
  turn-request, keep the WS open, print unsolicited
  `accepted(autonomous)/speak/done`; `npm run smoke:media` supplies a fake
  stream.
- **Real device** ([../orbit-station/TESTING.md](../orbit-station/TESTING.md)):
  milestones B/C; confirm tap-to-stop kills an autonomous announcement;
  `DELETE /api/brain/<dock>/missions/all` from the console.

## 10. Risks

| Risk | Mitigation |
|---|---|
| VLM latency > tick interval | serialized loop + 2 s floor ⇒ effective interval `max(interval, vlmLatency)`; noted in the tool description ("checks are approximate") |
| Frame staleness / dead stream | freshness gate returns null; 10-consecutive-error budget converts a dead stream into a *spoken* error, not a silent zombie watcher |
| VLM false positives | edge-trigger + refractory cap spam; if noisy in practice, require 2 consecutive YES ticks (one-line change) |
| `motion.stop` stomping the sweep | pause/resume per §4; residual: a search that times out mostly-paused during a long conversation — acceptable v1 |
| Starved announcements (chatty user) | `expiresAt` (120 s) drops stale news instead of blurting it minutes late |
| Superseded announcement lost | by design (no retry); obs end event records `announceInterrupted` |
| Cost | worst case `brainMissionMax`×(2 s floor) flash-lite calls with one small image; bounded by cap, interval clamps, timeout ceilings; flagged in config descriptions |
| Version skew phone↔station | degrades gracefully both ways (§5) |

## 11. Future work (explicitly out of v1)

- Persist mission specs in `SessionMeta`; re-arm on session resume / station
  restart.
- Console/push notification channel for triggers when out of earshot.
- Hybrid watch engine: local presence/motion detection gating the VLM call
  (cost optimization, same tool surface).
- Cross-dock missions (a granted dock searching with another dock's body) —
  composes with `brainGrants` naturally since `MotionExecutor` is
  dock-parameterized.

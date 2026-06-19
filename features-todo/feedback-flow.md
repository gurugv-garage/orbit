# Feature idea — Feedback flow

> Status: **idea** (not yet built). Captured for a future build session.

## The idea

When a dock session goes well or poorly, capture the moment with as much
surrounding context as possible into a single **markdown file** in a dedicated
**feedback folder**. Later, in offline "review sessions," we go through each
feedback MD and decide what to do (tune prompts, fix bugs, cut latency, etc.).

The value is in *bundling everything we can extract* — session details, brain
Session/Turn/Step traces, latencies/timings, token/cost, transcript, perception
world-state, dock profile, client-side app logs, and **build/version
provenance** — into one self-contained document keyed to a specific session, so
each feedback is reproducible against a known state.

## Decisions (already settled)

- **Triggers (both):**
  1. **App button** — a user-tappable control in the dock face UI that flags the
     current session and ships the device's recent context up to the station.
  2. **Brain tool** — a `record_feedback` tool the LLM can call when the user
     expresses dissatisfaction/praise, following the existing tool pattern
     (`send_to_whatsapp`).
  - Plus an **adb/debug broadcast** to drive the flow end-to-end without a device tap.
- **Storage:** a **non-committed** folder (default `.data/feedback/`, like brain
  sessions — gitignored runtime data). MD files only; no new DB tables.
- **Review surface:** a **web console view is important** — list, open, read full
  MD, delete.
- **Bundle depth:** **full session dump** (everything available).

## Architecture

```
 App button ─┐                              ┌─► feedback MD on disk
             ├─► station `agent` topic ─► feedback module (bundler) ─┤
 record_feedback tool (brain) ─────────────┘                        └─► web "Feedback" console view
```

The **feedback module** is the single bundler. Both triggers funnel into one
internal `captureFeedback({ dock, sessionId, source, reason, detail, clientContext? })`
call that gathers context from the other modules and writes the MD file.

## Server side (orbit-station)

### 1. New module: `server/src/modules/feedback/`

Follow the `observability` / `ota` module shape (factory → `StationModule`).

- **`index.ts`** — `feedbackModule(wiring)` returning `{ name: 'feedback',
  topic: 'feedback', description, init, route }`.
  - `init(bus)`: subscribe to the `agent` topic for `kind: 'feedback'` frames
    from the phone (same `dockOf(msg.source)` tenant-resolution pattern in
    `brain/index.ts` ~L216-260) — resolve dock from the sender's hello, **never**
    the payload.
  - `route(ctx)`: REST mount `/api/feedback` (see §3).
- **`store.ts`** — `FeedbackStore`: list / read / delete MD files under
  `.data/feedback/`. Reuse the data-dir resolution + atomic-write conventions
  (`fileURLToPath(new URL(...))`, tmp+rename) from `brain/store.ts` and
  `core/db.ts`. Optional `index.json`
  (`{ id, dock, sessionId, createdAt, source, reason }[]`) for fast listing.
- **`bundler.ts`** — `captureFeedback(...)`: gathers context (§2) and renders MD
  (§4). The heart of the feature.
- **`types.ts`** — `FeedbackRequest`, `FeedbackItem`, `FeedbackMeta`.

### 2. Context gathering (the "full session dump")

The bundler reads other modules' stores via **function accessors** wired from
`main.ts` (the dependency style brain already uses — `getMemory`, `getGrounding`),
not HTTP self-calls.

- **Observability** — full `SessionRecord` (all turns → steps → tool calls, with
  `ms` / `ttftMs` / `thinkingMs` / `usage{tokens,cost}`) from
  `observability/store.ts`; plus a health-window summary from
  `observability/health.ts`. Add a `getSession(sessionId)` accessor.
- **Brain** — session meta (`openedAt/lastTurnEndedAt/closedAt/turns/summary`)
  and transcript (`AgentMessage[]`) from `brain/store.ts`. Add a read accessor
  (`getSessionDump(dock, sessionId)`).
- **Perception** — latest world-state + the snapshot window across the session's
  time range from `perception/snapshots.ts`.
- **Dock brain profile** — config/composition/system-prompt snapshot (already
  assembled for `GET /api/brain/:dock/profile`).
- **Client context** — the TurnLog + recent app event lines shipped up by the
  phone (§5), embedded verbatim.
- **Build / version provenance** (reproducibility):
  - **Station**: git SHA + branch + dirty flag (`git rev-parse HEAD`,
    `git rev-parse --abbrev-ref HEAD`, `git status --porcelain` — captured once
    at init, cached), station `package.json` version, Node version.
  - **App**: Android `versionName` / `versionCode` + the build's git SHA —
    shipped in the phone's `clientContext` (§5).
  - **Firmware**: the ESP32 body's `BL_FW_BUILD` (OTA gate from
    `include/version.h`), via the dock's last body digest / OTA registry
    (`ota/store.ts`) when available.
  - **Models**: active brain model id + thinking level (from dock profile) and
    the perception sidecar models in play.

If `sessionId` is omitted, the bundler resolves the dock's **currently open**
session from the brain store.

### 3. REST surface (`/api/feedback`)

Mirror observability/brain route handlers (`json(res, status, body)` from
`core/http.ts`):

```
GET    /api/feedback/                 list items (id, dock, sessionId, createdAt, source, reason)
GET    /api/feedback/:id              full MD content (+ parsed frontmatter)
POST   /api/feedback/                 manual/programmatic capture { dock, sessionId?, reason?, detail? }
DELETE /api/feedback/:id              remove one
```

### 4. Markdown format

Per file: `.data/feedback/<createdAt>-<dock>-<sessionId>.md`. YAML frontmatter
(same convention as Skills / the memory system) + sectioned body:

```markdown
---
id: fb-<uuid>
dock: <dock>
sessionId: <sessionId>
createdAt: <ISO-8601>
source: app-button | brain-tool | api
reason: <free text or enum>
station: { gitSha, gitBranch, dirty, version, node }
app: { versionName, versionCode, gitSha }
firmware: { build }
models: { brain, thinking, perception: [...] }
---

## Feedback
<reason / detail>

## Build / versions
<station git SHA+branch+dirty, app version+SHA, firmware build, model ids>

## Session
<meta: openedAt, turns, duration, summary, dock state>

## Turn-by-turn trace
<each turn: trigger, steps with model/ttftMs/ms/thinkingMs, tool calls + timings, usage/cost>

## Health metrics
<TTFT/firstSpeech/settle percentiles, error counts over the session window>

## Transcript
<AgentMessage[] rendered>

## Perception (world-state + snapshot window)
## Dock brain profile (model, thinking level, system prompt digest)
## Client context (app TurnLog + recent event log lines)
```

### 5. Register the module in `main.ts`

Add to the `modules[]` list **after** observability/brain/perception exist (it
depends on their accessors). Construct with the accessor wiring from §2.

### 6. `record_feedback` brain tool

Follow the `send_to_whatsapp` pattern:
- Schema + description in `brain/schemas.ts`: `recordFeedbackSchema`
  (`{ reason: string, detail?: string }`) + `RECORD_FEEDBACK_DESC` ("Record
  feedback about this session for later review. Use when the user is clearly
  unhappy/delighted or flags an issue…").
- `buildFeedbackTools(dock, capture)` in `brain/tools.ts`, returning a
  `tool('record_feedback', …)` that calls the bundler with the **current session
  id** and `source: 'brain-tool'`, then `textResult('Feedback recorded.')`.
- Wire into the tool list in `brain/session.ts` (`agent.state.tools = [...]`),
  gated like the other conditional tools. Pass a `captureFeedback` accessor
  through `BrainWiring` / `DockBrainSession` deps (feedback module exports it;
  `main.ts` passes it into `brainModule({...})`).

## Client side (node-dock/app)

### 7. Feedback button + signal

- **UI**: add a small feedback control to `ui/DockScreen.kt` (status-bar region
  or dev panel) with an `onFeedback(reason: String?)` callback. Minimal — a tap
  (optionally a tiny reason prompt).
- **Transport**: add `sendFeedback(reason: String?)` to `agent/RemoteBrain.kt`,
  sending a **critical** frame
  `link.publishCritical("agent", "feedback", { reason, turnId, clientContext })`
  (the `publishCritical` path used for `tool-result`).
- **Client context**: serialize `TurnLog.current` (transcript, model attempts,
  tool invocations, latencyMs) + the recent `events` replay lines into
  `clientContext`. The station embeds this verbatim in the MD "Client context".
- **App version provenance**: include `BuildConfig.VERSION_NAME` / `VERSION_CODE`
  and the build's git SHA in `clientContext` (expose the SHA via a
  `buildConfigField` in the app's `build.gradle` if not already present). The
  station copies these into the MD frontmatter (`app:`).

### 8. Debug broadcast (testing)

Extend `debug/DebugTestReceiver.kt` with a `dev.orbit.dock.debug.FEEDBACK` action
(`-e reason "…"`) that calls `RemoteBrain.sendFeedback(...)`, so the path is
drivable over adb without a device tap.

## Web console (orbit-station/web) — the review surface

### 9. New "Feedback" view

Follow the `Observability` / `Memory` view pattern:
- `web/src/modules/Feedback.tsx`: list from `GET /api/feedback/` on the left,
  full MD render on the right (`GET /api/feedback/:id`), delete action. Reuse
  `useStationClient()` from `web/src/lib/useStation.ts`.
- Register in `VIEWS[]` in `web/src/App.tsx`:
  `{ id: 'feedback', label: 'Feedback', ico: '💬', el: <Feedback /> }`.

## Out of scope (explicit)

- The offline **review session** itself (going through each MD and acting on it)
  — a human/Claude-Code process over the files, not built here.
- No new DB tables — feedback lives as MD files on disk only.
- No auto-triggering heuristics beyond the LLM's own `record_feedback` judgment.

## Verification (when built)

1. **Server unit**: bundler test — given a fake observability session + brain
   transcript, render an MD with all sections + valid frontmatter (mirror
   `brain/skills.test.ts`).
2. **End-to-end (api)**: `cd orbit-station && npm run dev`, then
   `curl -XPOST localhost:8099/api/feedback -d '{"dock":"web-test"}'` after a
   Brain-view session → MD appears under `.data/feedback/`; `GET /api/feedback/`
   lists it.
3. **Brain tool**: drive a turn and confirm the model can call `record_feedback`.
4. **App path**:
   `adb shell am broadcast -a dev.orbit.dock.debug.FEEDBACK -e reason "head didn't move"`
   → MD appears with the **Client context** section populated from TurnLog.
5. **Console**: open `/#feedback` → list + full-MD render + delete.
6. **Provenance**: every MD's frontmatter carries station git SHA/branch/dirty +
   version, app version+SHA (phone path), and firmware build.

## Key files to touch (reference)

| Area | Path |
|---|---|
| New module | `orbit-station/server/src/modules/feedback/{index,store,bundler,types}.ts` |
| Module registration | `orbit-station/server/src/main.ts` |
| Brain tool | `orbit-station/server/src/modules/brain/{tools,schemas,session}.ts`, `brain/index.ts` (wiring) |
| Observability source | `orbit-station/server/src/modules/observability/{store,health,types}.ts` |
| Brain session source | `orbit-station/server/src/modules/brain/store.ts` |
| Perception source | `orbit-station/server/src/modules/perception/snapshots.ts` |
| App button + transport | `node-dock/app/.../ui/DockScreen.kt`, `.../agent/RemoteBrain.kt`, `.../agent/TurnLog.kt` |
| App debug trigger | `node-dock/app/.../debug/DebugTestReceiver.kt` |
| Web view | `orbit-station/web/src/modules/Feedback.tsx`, `web/src/App.tsx` |

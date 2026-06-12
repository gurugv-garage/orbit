# Server brain — production implementation plan

## 0. Implementation status (living — update as stages land)

**Branch `server-brain` (stage 1 committed: e142852 + 9aaf71c; stage 2 in tree). Last updated 2026-06-12.**

**Stage 1 — station: DONE** (71 tests green; E2E verified via `npm run
smoke:brain` AND a Playwright browser run of the test console; real Gemini
turns: tool fan-out → fake body received the `happy` gesture's `set_target`s
+ heartbeat resends, sentence-split speak frames, TTFT/usage/cost captured).

- ✅ protocol v2 (`component`/`kind`/`caps`, `toAddr`, collision=hardware-swap,
  hub WS ping/pong ~6 s); `agent` topic; `bodyAddr` fully retired
- ✅ dock directory (`modules/docks/directory.ts`): `resolveCap`, auto-learned
  manifest (`.data/docks.json`), directed `presence` fan-out
- ✅ brain module (`modules/brain/`): pi Agent per dock; DockAgent semantics
  ported 1:1 (supersede-await, sanitizeHistory, flush-on-normal-only,
  softened failures, 60 s ceiling, turn-start `motion.stop`); bounded
  sessions (lazy open / idle close → summary / survive restarts — verified);
  obs `source` = dock name; SentenceStreamer + SafeCompute ported against the
  Kotlin test vectors
- ✅ motion executor (`modules/bodylink/motion.ts`): single master
  (brain + console), °→µs with asymmetric neck clamp, 1 Hz/10 Hz idempotent
  heartbeat, `faceGestures` config = the only choreography copy; per-dock
  state cache + ~1 Hz `digest` (directed to face component + console copy)
- ✅ perception `FaceToolsApi` (in-process face tools)
- ✅ config: `brain*` registry entries (incl. `brainThinkingLevel`,
  `brainGrants`); shared ConfigStore; ota retargeted by `kind`
- ✅ **test console** (`web/src/modules/Brain.tsx` + server `brain-debug`
  stream on obs): in-browser fake phone + turn inspector — streaming text,
  thinking, tool timing, TTFT, per-step tokens/cost, timeline, model/thinking
  control. Beyond plan, pulled forward by need. Also: **thinking metrics**
  (per-step `thinkingMs` = first thinking token → first answer token, think
  column + timeline segment) and **session resume** (`POST
  /api/brain/:dock/session/:id/resume` + console "continue" with prior-
  exchange hydration — verified: a resumed session answered a question about
  its pre-resume turns).
- ✅ provider keys: station `.env` (gitignored) loaded by `main.ts`
- ✅ dev fakes: `fake-phone.ts` (`npm run smoke:brain`), smoke-client hello v2

**Protocol additions discovered during implementation** (now part of §2):
- `agent`/`hello` (phone → station, after subscribe): deterministic
  `brain-status` handshake — the peer-joined push races the peer's
  subscribe frame and can be dropped; this reply cannot miss.
- `turn-status`/`turn-end` carry `error` (the provider's actual message,
  e.g. "No API key for provider: google") — misconfig is never opaque.
- obs kind `brain-debug`: the console's rich stream (full deltas, ttft,
  usage) — browsers-only; devices never subscribe obs.

**Stage 2 — phone: DONE** (all `:app` unit tests green incl. 13-case
`RemoteBrainTest`; E2E verified on the **emulator** (emulator-5554) AND the
**physical pad** (nabu) against the live station: hello v2 → deterministic
`brain-status` handshake (~400 ms), adb-injected turns → `set_face` tool-call
dispatch+ack on the phone, sentence-split speak frames → TTS, supersede,
wifi-drop → reconnect → next turn clean; driven via the debug
`DebugTestReceiver` broadcasts).

- ✅ `StationLink`: hello v2 (`component:"phone"`, kind `dock-android-app`,
  caps voice/face/camera), subscribes `agent`+`bodylink`, `onAgentFrame`/
  `onBodyDigest` callbacks, `agent`/`hello` after subscribe,
  `publishCritical` (send-or-fail, bypasses the DROP_OLDEST outbox),
  heartbeat `links` reporting dropped; `BrainLink` interface = test seam
- ✅ `RemoteBrain.kt`: DockAgent's exact public surface; turnId epoch gating
  (stale speak/tool/status dropped); reqId dedupe; canned failure lines per
  `code`/`detail` (timeout / lost-train-of-thought / model-unreachable);
  `stop()` silences locally FIRST then `turn-cancel`; link-drop mid-turn
  fails the turn audibly; 75 s local watchdog (> station's 60 s ceiling);
  transcript pre-warm (≥100 ms throttle, latest-wins, finals always);
  camera frame attached to every turn-request (the BRAIN gates vision now)
- ✅ deletions landed (§4 table): `DockAgent`, `DockStreamFn`, `DockPrompt`,
  `DockToolSchemas`, `SafeCompute`, `ModelCatalog`+`ModelChip` (model picker
  UI gone — the station config owns the model), `StreamingReplyExtractor`,
  `DockToolsAdapter`, `EnrollRetry`, the whole `body/` package (+ DevPanel
  BODY tab, `states.json`), `:agent-core`+`:bench` out of the Gradle build,
  `AppLinks`; `local.properties` → `STATION_URL`+`DOCK_NAME`(+wake-word/
  signing) only; `ConfigCache.INTEREST` → phone-local UX keys only
- ✅ `DockTools` slimmed to face UI + TTS + perception reads;
  `currentContext()` no longer claims body state — the **station** composes
  the `Body: CONNECTED/NOT connected` grounding line from its own directory
  (`session.ts`), since it owns the body link
- ✅ body status LED fed by the `bodylink`/`digest` frames (display-only)

**Fixed during stage 2 (caught by the emulator E2E, regression-tested):**
- **supersede clobber** (`session.ts handleTurnRequest`): awaiting only
  `agent.waitForIdle()` let the superseded turn's `finally` run AFTER the new
  turn started, wiping `#activeTurnId` — the new turn's speak frames then
  shipped with a dead turnId and the phone (correctly) dropped the whole
  reply. Now the previous `#runTurn`'s FULL lifecycle is awaited (`#running`
  promise + `#latestReq` newest-wins). Server tests 72/72.

**Operational notes (stage 2):**
- Two devices helloing the same `(dock, component)` displace each other in a
  loop (collision rule working as designed) — don't leave the emulator and
  the pad running the same dock name; give test devices their own DOCK_NAME.
- The shared Gemini free-tier key hit its DAILY quota during testing;
  `brainModel` flipped to `openrouter/google/gemini-2.5-flash` via the config
  console (OPENROUTER_API_KEY also in station `.env`) — live-switchable, no
  restart.

**Remaining phone work (needs a human / physical setup):** real-mic STT +
wake-word quality, audible TTS verification, real-face recognition flows,
MIUI/doze behavior over hours, release-build OTA path.

**TODO — Stage 3 (firmware), next:**
- [ ] remove BodyLink WS server + `bodyAddr`; hello v2 (`component:"body"`,
      caps `["servo"]`); consume `presence`; staleness tripwire (30 s);
      `BL_FW_BUILD` bump; `test_body.sh` → station REST
- [ ] hardware checklist + chaos suite (§11); re-measure the §7 perf table

**TODO — later (post-cutover):** brain-module integration test (two-dock
tenancy isolation, cross-dock grants), idle-time pi compaction (summary is
currently a tail digest), SFU frame-grab vision, session-summary seeding,
docs cleanup (CLAUDE.md, bench migration decision).

---

**Status: implementation plan (2026-06-12, rev 2).** Supersedes the experiment
framing in [SERVER-BRAIN.md](SERVER-BRAIN.md) §0/§10. Decisions baked in:

1. **No Kotlin fallback.** Full cutover: the phone's agent loop (`DockAgent`,
   `DockStreamFn`, the `llm/` surface, `:agent-core` from `:app`) is deleted.
   No `brainMode` flag, no dual surface.
2. **Reconnection is a first-class design requirement.** With no local brain,
   the station WS is the robot's spinal cord; every disconnect/reconnect path
   has defined, tested behavior (§6).
3. **The station drives the body; the firmware becomes client-only.** The
   ESP32's BodyLink WS server is removed; its existing station WS connection
   carries commands in and state out. Phone and firmware never talk directly.
   The phone only *displays* body status — not latency-sensitive; a
   low-frequency digest suffices. **One WebSocket server in the whole system
   (the station).** The "dial the stable party" rationale that originally made
   the ESP32 a server now points at the station — see the plan.md decision log.
4. **Big-bang cutover.** Fully controlled project, no users in the field, no
   rollout/compatibility requirements. Station, app, and firmware all change
   at once; downtime during the switch is fine. Phasing below is *build
   order*, not compatibility management.
5. **STT/TTS stay on the phone for now** (transcripts up, sentence text down).
   Moving them server-side is a later phase, deliberately not elaborated here —
   see [SERVER-BRAIN.md](SERVER-BRAIN.md) §6 (shadow-mode path).

Everything else from SERVER-BRAIN.md stands: streaming-first on every hop,
fire-and-forget actuation, pi sessions with compaction, profiles in the config
registry, perf budget per its §7.

---

## 1. Target architecture

```
 ┌─ phone (perception + face/voice) ───────────────┐    ┌─ orbit-station (the one server) ─────────────┐
 │ mic → VAD/wake → Android STT                    │    │ modules/brain/                               │
 │   └ partials+final ── agent: transcript ────────┼───►│  ├ DockBrainSession (per dock)               │
 │ RemoteBrain (thin protocol client)              │    │  │   ├ pi Agent + pi-ai streamFn             │
 │   ├ turn-request (text+context+image?) ─────────┼───►│  │   ├ prompt builder + sanitizeHistory      │
 │   ├ set_face RPC → FaceController, ack ─────────┼───►│  │   ├ SentenceStreamer (TS port)            │
 │   ├ speak frames → DockTts ◄────────────────────┼────┤  │   └ per-turn AbortController              │
 │   ├ turn-status → AgentState → face UI ◄────────┼────┤  ├ RpcBroker (reqId map — set_face only now) │
 │   └ body status panel ◄── bodylink: digest ─────┼────┤  └ SessionStore (pi JSONL, .data/brain/)     │
 │ battery/facts ── client topic ──────────────────┼───►│ modules/bodylink/ (+ motion executor)        │
 │ camera ── WebRTC → SFU (unchanged) ─────────────┼───►│  ├ choreography runner (move steps, gestures)│
 └─────────────────────────────────────────────────┘    │  ├ idempotent set_target heartbeat           │
                                                        │  └ body state cache → 1 Hz digest            │
 ┌─ ESP32 body (client-only, ONE socket) ──────────┐    │ modules/perception/ ← face tools in-process  │
 │ station WS: set_target/ping in,                 │───►│ modules/observability/ ← events in-process   │
 │             applied/state/event out             │◄───┤                                              │
 └─────────────────────────────────────────────────┘    └──────────────────────────────────────────────┘
```

**Tool placement after cutover:**

| Tool | Executes | How |
|---|---|---|
| `set_face` | split | expression → phone RPC (`tool-call`, it's the screen), instant ack; gesture choreography → **in-process** motion executor → body |
| `move` | station | **in-process** call into the motion executor → directed `set_target` to the firmware peer. No phone involvement, no RPC. |
| `compute` | station | in-process (TS port of `SafeCompute`) |
| `remember/recollect/confirm/forget_face` | station | in-process calls into the perception module |

Speech is **not a tool** — prose streams down as `speak` frames. The phone's
remote-tool executor handles exactly one tool (`set_face`); the RPC stays
generic because future phone-surface tools (show something on screen, play a
sound) will use it.

---

## 2. Wire protocol v1

### Peer identity & addressing (hello v2) — the tenancy primitive

The deployment shape this must serve: **one station per house; N docks spread
across it; each dock is a *composition of components*** (this dock = one phone
app + one ESP32; another dock = a different setup), all following one
architecture. Most traffic is bound to a *specific component of a specific
dock* — so "dock" alone is not an address. Three identities that today are
conflated get separated:

| Field | What it names | Example | Binds |
|---|---|---|---|
| `dock` | the tenant — the composed unit | `anne-bot` | sessions, history, memory, obs trees |
| `component` | the **slot** within the dock (unique per dock) | `phone`, `body`, `cam-2` | addressing, presence, expected-composition |
| `kind` + `build` | the **software** running in the slot | `dock-android-app` 41, `dock-body-fw` 7 | OTA targeting, console display |
| `id` | the **hardware/instance** (mac, install uuid) | `b4:3a:…` | diagnostics, collision arbitration |

The same software on two different hardwares = same `kind`, different `id` —
and if they claim the same `(dock, component)` that's a hardware *swap*, not
an error (see collision rule below). A completely different app = a new
`kind` in a new (or same) slot; nothing in the station hardcodes app/firmware
anymore.

`hello` v2: `{ role: 'device'|'browser', dock, component, kind, caps,
id, build, label? }`. `caps` is a small list of capability tags the component
serves — e.g. phone: `['voice','face','camera']`, body: `['servo']` — so
station modules route by **capability, not by hardcoded component name**: the
brain sends `speak`/`set_face` to `resolve(dock,'voice'/'face')`, the motion
executor sends `set_target` to `resolve(dock,'servo')`. A future dock with a
different shape (screen-less voice node, two servo clusters) routes correctly
with zero station changes. (`PeerRole`'s `app`/`firmware` values are
retired; `role` keeps only the device-vs-browser distinction.)

**Addressing:** `BusMessage` gains `toAddr?: { dock, component }`, resolved
to the live peer at fan-out by the hub (modules stop resolving peer ids
themselves; `to: <peer id>` remains for low-level cases). State always binds
to the **address**, never the hardware: swap the phone in a dock and the
session, history, and obs stream continue — only `id` changes.

**Linking** (how components become one dock): each device is provisioned with
its `(dock, component)` — app: `local.properties`; firmware: NVS/build flag —
exactly like today's dock name, one more field. The station additionally
holds a **dock manifest** (config registry, json): the *expected* components
per dock. The manifest is what makes absence meaningful — "body expected but
offline" is knowable only because the composition is declared. Unknown docks
auto-register on first hello with manifest = observed (console-editable
afterward); trusted-LAN, no device auth in v1.

### Topics

Telemetry rides the existing `client` topic; turns ride the new `agent`
topic (added to the `Topic` union in
[`protocol.ts`](../orbit-station/server/src/core/protocol.ts)); body command
and state ride the existing `bodylink` topic, promoted from debug-console
relay to the primary motion path. Station→peer frames are bus-directed
(`toAddr`/`to`).

### phone → station, topic `agent`

| kind | payload | notes |
|---|---|---|
| `hello` | `{}` | sent right AFTER subscribing; the brain replies with a directed `brain-status` — the deterministic half of the resync handshake (the peer-joined push can race the subscribe frame). |
| `transcript` | `{ utteranceId, text, isFinal }` | partials throttled (≥100 ms, latest-wins); final always. Pre-warm only — never triggers a turn. |
| `turn-request` | `{ turnId, utteranceId?, trigger: {kind:'user', text}, context: {state, battery?}, image?: {b64, mime} }` | the turn trigger. `context.state` = `PerceptionSnapshot.describe()` at trigger time. |
| `tool-result` | `{ reqId, toolCallId, turnId, content, isError }` | instant ack after fire-and-forget dispatch (set_face UI). |
| `turn-cancel` | `{ turnId }` | tap-to-stop. Idempotent; unknown/finished turnId ignored. |
| `speech-status` | `{ turnId, speaking: bool }` | TTS start/drain — brain emits SpeakStart/SpeakEnd/**TurnSettled** obs markers from these. |

### station → phone, topic `agent` (directed)

| kind | payload | notes |
|---|---|---|
| `tool-call` | `{ reqId, toolCallId, turnId, name, args, timeoutMs }` | at-most-once; never retried. Today: `set_face` only. |
| `speak` | `{ turnId, seq, text }` | one sentence per frame, shipped on sentence-close mid-stream. |
| `turn-status` | `{ turnId, state: 'accepted'\|'thinking'\|'speaking'\|'done'\|'failed'\|'cancelled', code?, detail? }` | drives `AgentState`/face UI. `code` ∈ `timeout`/`llm_error`/`link_lost`/`busy` → phone maps to canned local TTS lines. |
| `brain-status` | `{ ready: true, activeTurnId: null }` | sent on every app peer-join (resync handshake, §6). |

### topic `bodylink` (existing — now the only motion path)

| direction | kind | payload | notes |
|---|---|---|---|
| station → firmware (directed) | `set_target` | BodyLink §3 body (parts → param targets, duration) | sent by the motion executor: immediate intent + idempotent heartbeat resend (1 Hz idle, 10 Hz during motion — the HANDOVER cadence, now station-side). |
| firmware → station | `applied` / `event` / `error` / `profile` | BodyLink §3–4 bodies | same semantics as the retired phone link: per-part idempotent, clamp + `OUT_OF_RANGE`, profile on connect. |
| station → dock's app (directed) + undirected console copy | `digest` | `{ dock, parts: {neck: deg, foot: deg}, online, ts }` | ~1 Hz on-change body status. **Not** real-time by design — display only. Dual-publish mirrors the perception module's pattern: the phone only ever receives **its own** dock's digest; browsers get the undirected copy for the console. (Considered: piggybacking on the station heartbeat; a separate kind on the topic that owns body state is cleaner.) |

### phone → station, topic `client` (existing)

`{ battery, … }` on change + slow heartbeat. The `links` field shrinks: the
phone no longer reports `body`/`llm` links — the station *is* the body link
now, and there is no phone LLM. The mesh view derives body connectivity from
its own roster.

### Ordering, identity, and tenancy rules

- One WS = ordered delivery; `seq` on `speak` is belt-and-braces.
- `turnId` minted by the phone (owns the trigger); `reqId` by the brain (owns
  the RPC). Both UUIDs.
- **Epoch gating:** the phone tracks `currentTurnId`; inbound `speak` /
  `turn-status` / `tool-call` with a non-matching turnId is dropped + logged.
- The brain and motion executor resolve target peer ids **from the live
  roster at every send** — never cached; reconnects need nothing special on
  the send path.
- **Tenant = dock, derived from the roster, never from the payload.** Every
  inbound frame's dock is resolved from the *sender's* hello (`msg.source` →
  roster → dock); a payload field claiming another dock is ignored. A peer
  with no dock publishing on `agent` gets an `error` frame and is ignored.
- **Devices are tenant-locked; the station is the only cross-dock actor.**
  A device frame can only ever act on its own dock's lane. Cross-dock
  interactions (below) happen exclusively *inside* station modules — a buggy
  or hostile device cannot address another dock's components, but a brain
  session or module can, under policy.
- **All hot-path station→peer frames are directed** (`toAddr`). Undirected
  copies exist only for browser consoles and always carry `dock`. A
  component never receives another dock's turn, tool, speak, or digest
  frames unless a station module deliberately routes a cross-dock stream to
  it.
- **Address collision** (two peers helloing the same `(dock, component)`):
  newest hello wins all routing; the displaced peer gets an `error` frame.
  This is deliberately *not* always an error — it's also how a hardware swap
  works (same slot, new `id`); the hub's dead-socket detection retires stale
  sockets within seconds either way.

### Cross-dock interactions (designed in now, used rarely)

Two planned patterns must not require re-architecture later, so their
primitives are baked in v1 even though v1 ships single-dock behavior:

1. **Dock commanding dock** — e.g., the stationary dock drives the rover
   ("rover, go to the kitchen" spoken at the desk). Because every brain
   already runs in the station, this is **not** device-to-device traffic: it
   is dock A's brain session invoking another station module's in-process API
   (motion executor, future rover/nav module), which emits directed frames to
   dock B's components — exactly how dock A's own body is driven, one tenant
   over. What's needed in v1: (a) `toAddr` carries an explicit dock, so
   nothing in the bus assumes same-tenant; (b) module APIs take the target
   dock as a parameter (`motion.runSteps(dock, …)` — already the shape);
   (c) a **cross-dock grant** in the dock's profile config (which other
   docks/capabilities this dock's brain may use, default none) so tool
   exposure is policy, not possibility. The rover itself is then "just
   another dock" whose components declare caps like `drive`/`nav` (its ROS2
   bridging lives behind a station module, per plan.md §7's plat-bridges
   decision — out of scope here, but it lands in this addressing model
   without changes).
2. **Dock-to-dock A/V** — e.g., the rover's camera on the desk dock's
   screen, or room-to-room intercom. Generalize the SFU's viewer side: today
   only browsers subscribe; let **any component with a sink cap**
   (`display`/`speaker`) be a viewer via the same `media`-topic signaling
   (the phone already carries the full WebRTC stack as a producer). Streams
   stay station-fanned — one extra LAN hop (~ms) buys: no device↔device
   coupling, the processing taps (STT/recording/perception) see every
   stream, and the one-server topology holds. Direct P2P WebRTC between
   docks is a *deferred optimization* (the SFU can still broker signaling)
   if fan-through bandwidth ever matters on home Wi-Fi.

---

## 3. Station implementation

### 3.0 Tenancy, composition & session lifecycle

**Tenant model.** The dock is the unit of tenancy: one dock = one brain
session lane, one motion lane, one obs stream, N media streams. A dock is a
**composition of components** (§2): this dock = `phone` + `body`; another
dock = a different shape; the rover = a dock whose components declare
`drive`/`nav` caps. Every station map is keyed by dock name; within a dock,
addressing is by component slot and routing is by **capability** — no module
hardcodes "app" or "firmware". Per-dock invariants: one active turn, one
peer per component slot. Dock/component identities are self-declared in
hello (trusted-LAN model); a device-auth layer is a future concern,
deliberately not v1. Cross-dock action is station-module-only, gated by
per-dock **grants** in profile config (default: none) — see §2 cross-dock.

**Composition awareness (the manifest + presence loop).** The dock manifest
(config registry) declares each dock's expected components. The dock
directory (§3.3) compares manifest against the live roster and feeds
presence **back to the dock's own members**, so every component knows its
siblings are there or not — the app knows the body is offline, the body
knows the app is gone — baked into the existing heartbeat cadence rather
than a new mechanism. Absence is first-class: "expected but offline" renders
in the console and fails capability resolution fast (§6 body rule 3
generalizes to any cap).

**Session lifecycle — now deliberate, not incidental.** Today a session's
boundary is an accident of process lifetime (`obsSessionId` is minted when
`DockAgent` is constructed and dies with the app). Server-side, sessions get
explicit semantics:

- **Open:** lazily, on the first `turn-request` when no session is open for
  that dock. (Phase 2 may add presence-triggered opens — person appears /
  wake word — without protocol changes.)
- **Close:** whichever comes first — **idle timeout** (`brainSessionIdleMin`,
  config registry, default 30 min without a turn), **explicit end**
  (`POST /api/brain/:dock/session/end`, console button), or — phase 2 — a
  perception-fused signal (person left + goodbye intent).
- **On close:** run compaction → persist a session summary alongside the
  JSONL; close the obs session. The *next* turn opens a fresh session
  (phase 2: seeded with the previous summary — the hook where long-term
  dock memory starts).
- **Sessions are decoupled from connections** — deliberately the opposite of
  today. App restarts, reconnects, even station restarts inside the idle
  window continue the *same* session (lazy JSONL reload). A conversation no
  longer dies because a process did.
- Hierarchy, for vocabulary consistency with `AGENT-MODEL.md` and the obs
  module: **Dock (tenant) ⊃ Session (bounded engagement) ⊃ Turn ⊃ Step**.

**Obs identity under multi-tenancy (bug caught by this section):** with the
loop in-process, every dock's events would arrive `source: 'station'` and
collide in the observability tree (today they're distinguished by the
publishing peer's id). Fix: the brain stamps `source` with the **dock name**
on every `AgentEventDto` it emits; sessionId = the brain's session id. The
obs module needs no change (it already keys by sessionId + source).

### 3.1 `modules/brain/` (new)

Registered in [`main.ts`](../orbit-station/server/src/main.ts) after the hub
exists. Deps: `@earendil-works/pi-agent-core`, `@earendil-works/pi-ai`.

| File | Responsibility |
|---|---|
| `index.ts` | module wiring: owns topic `agent`; subscribes `agent`+`client`+`station`; tenant map by dock name; REST: `GET /api/brain/docks` (lanes + open session), `GET /api/brain/:dock/sessions` (incl. summaries), `GET /api/brain/:dock/history`, `POST /api/brain/:dock/session/end` (`reset` = end + open-on-next-turn). |
| `session.ts` | `DockBrainSession`: pi Agent, turn lifecycle (supersede semantics), prompt assembly, `sanitizeHistory`, per-turn `AbortController`, obs emission. |
| `rpc.ts` | `RpcBroker`: reqId→promise map; resolve on `tool-result`, error-result on timeout, reject-all on peer-left; late results logged + dropped. |
| `tools.ts` | pi `AgentTool` defs (schemas ported once from `DockToolSchemas.kt` — becomes the only copy). `set_face` → RPC (UI) **and** in-process `motion.playGesture()`; `move` → in-process `motion.runSteps()`; `compute` → `safe-compute.ts`; face tools → perception module exports. |
| `sentence.ts` | TS port of `StreamingReplyExtractor` + speech sanitation (Kotlin test vectors ported first — they are the spec). |
| `prompt.ts` | ported `DockPrompt.SYSTEM` + per-turn assembly (persona override + `"\n\nCurrent state — " + context`). |
| `safe-compute.ts` | TS port of `SafeCompute`. |
| `store.ts` | pi harness JSONL, one file per session under `.data/brain/<dock>/<sessionId>.jsonl` + session summaries; lazy reload of the open session after restart; session open/close per §3.0; idle-time compaction trigger. |

**Turn lifecycle — port `DockAgent` semantics 1:1, don't redesign:**
supersede = abort + **await full unwind** before the new prompt (the
`cancelAndJoin`/"busy" race); `sanitizeHistory()` before every prompt
(synthetic `"(interrupted)"` results + cap trim at a user-message boundary);
60 s wall-clock ceiling; flush the trailing clause **only on normal
completion**; the softened-failure nuance (turn already spoke/acted → "lost my
train of thought", not "couldn't reach my model"); **turn start calls
`motion.stop(dock)`** (port of `tools.stopBody()` — a new turn cancels the
previous turn's leftover gesture).

**Observability:** brain publishes `AgentEventDto`s on the `obs` bus topic
in-process (`source: 'station'`, sessionId = pi session id), every event (no
WS frame budget). `speech-status` maps to SpeakStart/SpeakEnd; SpeakEnd with
no active turn → **TurnSettled**, preserving the end-to-end metric.

**Profiles:** new registry entries (`brainModel`, `brainPersona`,
`brainTurnTimeoutMs`, `brainMaxHistoryMessages`, `brainVisionGate`,
`brainSessionIdleMin`, `brainGrants` — the cross-dock capability grants,
json, default `{}`), applied at turn start; provider keys are station env
vars. Grants gate *tool exposure*: a dock with `{"rover-1": ["nav"]}` gets
rover tools in its sessions; everyone else never sees them.

### 3.2 Motion executor (grows inside `modules/bodylink/`)

The module already owns the topic and relays console commands; it gains the
brain-facing executor and becomes the body's **single master**:

| File | Responsibility |
|---|---|
| `motion.ts` | exported in-process API: `runSteps(dock, steps[])` (timed sequences — `duration_ms`, `wait_ms`, parallel parts — port of `BodyController` timing), `playGesture(dock, expression)` (looks up `faceGestures` from the config module — **the registry copy becomes the only copy**; `DockTools.defaultGesture()` is deleted), `stop(dock)`, `isOnline(dock)`. Degrees→µs conversion moves here (it lived in the app). |
| `heartbeat.ts` | idempotent `set_target` resend per dock: 1 Hz idle / 10 Hz within 500 ms of motion — recovers lost frames and doubles as the firmware's staleness signal. |
| `state.ts` | body state cache from `applied`/`event` frames; publishes the 1 Hz `digest`; clamps outgoing values against the profile ranges before send. |

Console commands and brain tools now go through the **same executor in the
same process** — the dual-master conflict (phone vs console) is gone by
construction; arbitration is last-write-wins with a log line.

`move`'s tool-result is produced by the executor synchronously (same
fire-and-forget contract as today: status string on dispatch, never waits for
servo travel). If `isOnline(dock)` is false, the tool returns an error result
immediately — the model narrates it; the turn never blocks.

### 3.3 Dock directory (`modules/docks/` grows; bodyAddr brokering retires)

`bodyAddr` brokering dies (nobody needs to find anybody; both ends dial the
station). The module's surviving job — grouping peers under a dock name —
grows into the **directory**, the one place composition lives:

| Concern | Behavior |
|---|---|
| Composition state | `DockInfo` generalizes: `{ name, manifest: [component…], components: Map<component, { kind, caps, id, build, online, lastSeen, ip }> }`. |
| Resolution API (in-process, used by brain/motion/media/ota) | `resolve(dock, component) → peerId`, `resolveCap(dock, cap) → peerId` — always against the live roster; collision rule per §2 (newest wins). |
| Presence fan-out | on composition change + every heartbeat interval: directed `presence` frame to **each online member of that dock** (`{ dock, components: [{component, kind, online, build}…] }`) — this is the sibling-awareness loop; the firmware consumes a bool ("phone present"), the app the full list. Undirected `dock-updated` stays for consoles (and lets any subscriber — a future dock UI — see the whole house). |
| Manifest | json config-registry entry per dock (expected components); unknown docks auto-register with manifest = observed; console-editable. "Expected but offline" → console warning + fast-fail resolution. |

---

## 4. Phone implementation

`RemoteBrain.kt` replaces `DockAgent.kt` behind the same public surface
(`respond/stop/state/events/setSpeaking/setToolCalling/shutdown/isConfigured`)
so UI wiring is untouched:

- `respond(text)` → mint turnId, capture `tools.currentContext()` + optional
  camera JPEG (the `isVisionIntent` regex + `visionEnabled` gate stay
  phone-side for now — it's where the camera is), `publishCritical(turn-request)`,
  state `Waiting`.
- `tool-call` → dedupe by reqId; dispatch `set_face` → `FaceController`
  expression + `statusPhrase` UI; ack `tool-result`. Unknown tool → `isError`
  ack, never a crash.
- `speak` → epoch-gate → `tools.speakSentence`; first sentence → `Speaking`.
- `turn-status failed` → canned local line per `code` (strings on the phone;
  TTS is local).
- `stop()` → `tools.silence()` **first** (instant, local), then
  `publishCritical(turn-cancel)`, state `Idle`.
- TTS callbacks → `speech-status`.
- Body status panel reads the `bodylink`/`digest` frames (subscribe topic) —
  display-only, staleness-tolerant.

**StationLink changes:** add `publishCritical(topic, kind, payload): Boolean`
— direct send-or-fail, bypassing the lossy DROP_OLDEST outbox (a stale
`turn-request` delivered 30 s late would make the robot answer a question
nobody remembers asking; critical frames are fail-fast, never
store-and-forward). Subscribe `agent` + `bodylink`; add `onAgentFrame` /
`onBodyDigest` callbacks (same pattern as `onPerceptionFrame`). Telemetry
keeps the existing outbox semantics.

**Deletions (the simplification payoff — all in the cutover, no window):**

| Delete | Why gone |
|---|---|
| `agent/DockAgent.kt` | replaced by `RemoteBrain.kt` |
| `llm/DockStreamFn.kt`, `llm/ModelCatalog.kt`, `llm/DockPrompt.kt`, `llm/DockToolSchemas.kt`, `llm/SafeCompute.kt` | single TS copy in `brain/` |
| `agent/StreamingReplyExtractor.kt` | sentences arrive pre-split (vectors ported to TS first) |
| `agent/DockToolsAdapter.kt` | keep only `statusPhrase` (→ small `ToolStatus.kt`) |
| **`body/BodyLinkComms.kt`, `body/BodyProtocol.kt`, `BodyController`** (+ degrees→µs, gesture playback, body reconnect loop) | the phone never talks to the firmware again |
| `DockTools.defaultGesture()` + the "keep in sync" duplication | registry `faceGestures` is the only copy, executed at the station |
| enroll/recognize round-trip plumbing in `DockTools` | face tools are in-process at the station |
| `:agent-core` dep from `:app`; then `:agent-core` + `:bench` modules | no loop on the phone; bench runner becomes a TS CLI against `brain/` (can lag the cutover) |
| `AppLinks` body/llm reporting | station owns the body link; there is no phone LLM |
| `OLLAMA_*`, `LLM_API`, `LLM_VISION`, `GEMINI_API_KEY`, `OPENROUTER_API_KEY`, `BODY_HOST` from `local.properties.template`/BuildConfig | `STATION_URL` + `DOCK_NAME` are the app's only required config |

`DockTools` shrinks to: face UI, TTS, perception reads.

---

## 5. Firmware implementation (`dock_body_v0`)

- **Remove the BodyLink WS server** (`esp_http_server` listener on :17317)
  and the `bodyAddr` field from the station hello. The station WS client
  (already live — it registers, takes console commands, does OTA) becomes the
  only socket. *Removal note:* keep the command-handling core
  (`set_target`/`profile`/`applied`/clamps) transport-agnostic when cutting
  the listener out — a standalone-server mode is a parked SDK idea
  ([bodylink/DESIGN.md](../node-dock/bodylink/DESIGN.md) banner) and may
  return as a product of the protocol; delete the socket, not the shape.
- **Port the BodyLink contract to the station connection** (most exists via
  the console path; verify parity): per-part idempotent `set_target`,
  `applied` acks for state-changing commands, range clamp + `OUT_OF_RANGE`,
  `profile` advertisement on connect.
- **Disconnect behavior carries over from DESIGN.md §5.2, applied to the
  station socket:** on disconnect, **hold last commanded pose — do NOT
  auto-home** (homing surprises users; the brain can command home explicitly).
  Reconnect with the existing backoff; re-send `profile` on welcome.
- **Staleness watchdog (DESIGN.md §5.1's placeholder, now implemented):** no
  `set_target` for 30 s while connected → emit `event: stale` and hold. The
  executor's 1 Hz heartbeat means this only fires if the station's executor is
  broken — it's a tripwire, not a control path.
- Firmware-local **idle gestures stay firmware-local** (`idleGestures`
  config) — they keep working with the station down.
- `BL_FW_BUILD` bump; flash over the existing OTA path (verified on
  hardware). `scripts/test_body.sh` re-points at the station REST
  (`/api/bodylink/command`) instead of the dead direct socket.
- `bodylink/sim/` gains a station-client mode (dial the station as a fake
  firmware peer) — or is superseded by `fake-body.ts` (§11) for protocol
  tests, keeping MuJoCo only for mechanics.

---

## 6. Reconnection & liveness (first-class)

Principle unchanged: **turns are bound to the WS connection they started on;
sessions are bound to the dock and survive everything.** Now extended to the
body: **motion sequences are bound to the executor process; the body holds
pose through any disconnect.**

**Phone rules** (as rev 1): link down + active turn → silence, `Failed`,
canned line, discard turnId, never auto-resend; link down idle → offline cue,
mic input gets the canned line; `publishCritical` false at `respond()` = same
path; on reconnect wait for `brain-status` before accepting turns; epoch
gating drops stale frames.

**Station rules** (as rev 1): peer-left → reject in-flight RPCs, abort turn,
sanitize, mark idle (session persists); peer-joined → directed `brain-status`;
station restart → sessions lazy-reload from JSONL, in-flight turns are simply
gone; at-most-once tool-calls, no resends ever.

**Body rules (new):**
1. Firmware socket drops mid-sequence → executor marks the dock body offline,
   cancels the running sequence, logs. The body **holds pose** (firmware
   §5.2). No catch-up replay on reconnect — stale motion is worse than no
   motion.
2. Firmware reconnects → `profile` re-received, executor resumes heartbeat
   with its *current* targets — the per-part idempotent resend re-converges
   the body for free (this is what the heartbeat is for).
3. `move`/gesture issued while body offline → instant error tool-result
   (roster check), model narrates; the turn continues. No queuing of motion.
4. Station restart mid-gesture → sequence dies with the process; body holds
   pose; idle gestures unaffected; heartbeat resumes on firmware redial.

**Liveness:** app heartbeats every 10 s (existing); firmware's effective
liveness signal is the executor heartbeat + `applied` traffic; add hub
WS ping/pong idle timeout (~6 s, the DESIGN.md §5.1 budget, now hub-side) so
silently-dead sockets are detected fast on **both** peer types.

**Sibling awareness rides the same loop:** liveness changes flow into the
directory, which fans directed `presence` frames to the dock's own members
(§3.3) — each component always knows whether its siblings are online, at
heartbeat granularity, with no device→device traffic.

---

## 7. Corner-case catalogue

| # | Case | Defined behavior |
|---|---|---|
| 1 | Second utterance while a turn runs | supersede: abort + await unwind, then new turn; phone epoch-gates the old turn's frames. |
| 2 | `turn-cancel` after turn finished | idempotent no-op. |
| 3 | `tool-result` after RPC timeout | logged + dropped. |
| 4 | `speak` in flight at cancel | dropped by turnId gating. |
| 5 | Half-sentence at cancel/timeout | trailing-clause flush only on normal completion. |
| 6 | LLM dies mid-stream after a tool ran | `failed` with softened code → "lost my train of thought". |
| 7 | Hallucinated tool name | pi validation → error result into the loop; phone-side unknown name → `isError` ack. |
| 8 | Vision turn with missing/oversized image | `turn-request` goes via `publishCritical`; absent image → text-only turn, never blocks. |
| 9 | Partial-transcript flood | ≥100 ms throttle, latest-wins; pre-warm is idempotent. |
| 10 | Hung provider | 60 s ceiling → `failed code=timeout`. |
| 11 | App killed by Android | peer-left → abort; relaunch → hello → `brain-status` → live; history intact server-side. |
| 12 | Station deploy mid-conversation | phones + firmware redial (existing backoff); sessions reload lazily; body holds pose. |
| 13 | Wi-Fi blip | same as 12 — no resume-turn path by design; re-asking is the contract. |
| 14 | Clock skew | obs timestamps stamped server-side on ingest. |
| 15 | Two docks simultaneously | independent sessions + per-dock executor state; no shared mutable state in `tools.ts`/`motion.ts`. |
| 16 | `brainModel` config change mid-turn | applied next turn. |
| 17 | `turn-request` from unknown dock | lazy-create session with defaults. |
| 18 | `move` while body offline | instant error tool-result; model narrates; turn continues (§6 body rule 3). |
| 19 | New turn while a gesture plays | brain calls `motion.stop(dock)` at turn start (port of `stopBody`). |
| 20 | Console slider + brain move at once | same executor, same process: last-write-wins + log. Dual-master is structurally gone. |
| 21 | Body power-cycles mid-sequence | firmware boots → redials → `profile`; executor heartbeat re-converges targets; sequence is not replayed. |
| 22 | Speech/motion sync skew | speak→phone-TTS and set_target→body now fan out from one process; skew ≈ one radio leg each, smaller than TTS engine startup (~141 ms p50). Both were always fire-and-forget; no sync contract exists or is added. |
| 23 | Body digest staleness on the phone | display-only by design; UI shows `online:false` from the digest itself, no liveness logic phone-side. |
| 24 | Two peers hello the same `(dock, component)` | newest wins all routing; displaced peer gets an `error` frame; stale socket retired by the hub's idle timeout. The open session is untouched (it binds to the dock, not the hardware) — this is also the **hardware-swap path**: replace the phone mid-conversation and the session continues on the new device. |
| 25 | Payload claims a different dock than the sender's hello | ignored — tenant is always resolved from the roster (§2). Devices are tenant-locked; only station modules act cross-dock, under grants. |
| 26 | `turn-request` lands just after an idle session closed | a fresh session opens lazily; worst case is lost conversational context, never an error. (Phase-2 summary seeding softens even that.) |
| 27 | Turn in flight when the idle-close timer fires | impossible by construction — the idle clock measures time since the last turn *ended*; an active turn always resets it. |
| 28 | Manifest expects a component that never connects | console warning from the directory; `resolveCap` fails fast → tools targeting that cap return instant error results (generalizes §6 body rule 3); presence frames tell the siblings. |
| 29 | Cross-dock tool against an offline or ungranted target | ungranted → the tool isn't in that dock's session at all (exposure is policy, §2); granted-but-offline → instant error result, model narrates, turn continues. |
| 30 | Device viewer (dock-to-dock A/V) drops mid-stream | SFU cleans up exactly as for browser viewers today; the producer is unaffected; re-subscribe on reconnect via normal `media` signaling. |
| 31 | Component with no caps / unknown cap requested | no route — `resolveCap` returns offline-equivalent error; never a crash, never a broadcast fallback. |

---

## 8. Optimizations

1–3 ship with v1; the rest are measured follow-ups.

1. **Pre-warm on partials**: first `transcript` partial → load session, fold
   `client` facts, build prompt, resolve roster targets; LLM fires the instant
   the final lands.
2. **Sentence + tool pipelining**: `speak` on sentence-close mid-stream;
   tools dispatch on parse. `move` is now in-process — the motion executor
   gets the call *earlier* than the phone ever did (no RPC leg at all).
3. **Partial throttling + tiny frames**: ≥100 ms partials; all hot-path
   frames <1 KB.
4. **Idle-time compaction**: pi summarization when a session is idle ≥60 s;
   the 48-message trim stays as hard cap only.
5. **SFU frame-grab for vision** (next after v1): grab frames server-side
   from the existing video stream; delete the phone's vision regex + JPEG
   upload; the gate decision moves to the brain where the text is.
6. **Provider keep-alive**: verify warm-vs-cold TTFT in the latency report.
7. *(deferred, off)* speculative turn start on stable partials.

## 9. Simplifications

**Taken:**
- One agent surface, one language; prompt/schemas/splitter/compute exist only
  in `brain/`.
- **One WebSocket server in the entire system.** Firmware: one socket instead
  of server+client. Phone: one socket (station) instead of two (station +
  body). The docks module stops brokering addresses.
- **One body master**: console and brain share one executor in one process —
  the phone-vs-console conflict class is deleted, not handled.
- `faceGestures` single copy (config registry), executed where it's stored.
- Face tools collapse to function calls; `speak` is a frame, not a tool.
- Telemetry reuses `client`; motion reuses `bodylink`; one new topic total
  (`agent`).
- No store-and-forward, no resume-turn, no motion replay: turns bind to
  connections, sessions bind to docks, bodies hold pose. Three rules cover
  the whole §7 catalogue.
- Big-bang cutover: no compatibility shims, no flag plumbing, no dual-path
  test matrix.

**Considered and rejected:**
- *Phone keeps a direct body link for latency-sensitive loops*: rejected —
  audited the code; gaze tracking drives **on-screen eyes only**
  (`GazeOffset`), idle gestures are firmware-local, so the phone→body link's
  only users were the LLM tools that now originate at the station anyway.
  Body status on the phone is display-only and tolerates seconds of staleness.
  **Would flip if** a genuinely tight phone-perception→motion loop appears —
  though phase-2 perception fusion (SFU at the station) covers face-following
  server-side with the same hop count.
- *Generic RPC framework / per-tool ack levels*: YAGNI — one fire-and-forget
  shape.
- *Kotlin fallback / local brain*: ruled out by decision.

## 10. Build order (not a rollout)

No compatibility windows — everything changes at once; sequencing exists only
so each stage is testable before the next starts.

- **Stage 1 — station, complete.** `brain/` + motion executor + protocol
  changes + `fake-phone.ts`/fake-body peers. Green: unit tests + `smoke:brain`
  end-to-end with both fakes + latency report against the real provider.
- **Stage 2 — phone rewrite.** `RemoteBrain`, StationLink changes, all §4
  deletions, in one change. Green: phone unit tests + emulator against the
  Stage-1 station.
- **Stage 3 — firmware.** Remove WS server + `bodyAddr`; staleness tripwire;
  OTA-flash. Green: hardware checklist (§11) — real phone + real body + station
  on LAN, then the chaos suite.
- **Later phases (separate decisions, not elaborated here):** server-side
  STT/TTS via the media tap (shadow mode first); SFU vision grab; cross-dock
  memory.

## 11. Testing plan

**Station unit (`tsx --test`):**
- `rpc.test.ts` — resolve/timeout/peer-left/late-result/two-docks.
- `sentence.test.ts` — ported Kotlin vectors; flush-on-complete-only.
- `session.test.ts` — faux streamFn: supersede without "busy" leak; cancel →
  sanitized history; ceiling; soft/hard failure mapping; cap trim; compaction
  trigger; **turn-start calls motion.stop**; session lifecycle (lazy open,
  idle close with fake clock, explicit end, close → summary persisted, next
  turn opens fresh, reload of an open session after restart, obs `source` =
  dock name).
- **Tenancy isolation test** (in `brain-module.test.ts`): two scripted docks
  interleaving turns concurrently — each phone receives only its own
  `speak`/`tool-call`/`turn-status`/`digest` frames; obs trees stay separate
  (distinct sessionId + source); a frame whose payload claims the other dock
  acts on the sender's lane only.
- `directory.test.ts` — `(dock, component)` collision: newest wins +
  displaced error + session survives (hardware swap); `resolveCap` by cap,
  unknown cap, offline component; manifest absent-component warning;
  presence fan-out: directed to members only, fires on change + cadence.
- **Cross-dock grant test** (in `brain-module.test.ts`): dock A granted
  `nav` on dock B → tool present, invocation emits directed frames to B's
  component; dock C ungranted → tool absent from its sessions entirely;
  granted-but-offline → instant error result.
- `tools.test.ts` — schemas, unknown tool, compute parity vectors, face tools
  against faked perception exports, set_face fan-out (RPC + gesture).
- `motion.test.ts` — fake clock: step sequencing (`duration_ms`/`wait_ms`/
  parallel parts), gesture lookup from config, heartbeat cadence (1 Hz↔10 Hz),
  idempotent resend convergence after a fake reconnect, offline → instant
  error, stop() mid-sequence, clamp + OUT_OF_RANGE pass-through, last-write
  arbitration.
- `brain-module.test.ts` — in-memory bus, scripted phone+body peers,
  full turn: transcript → turn-request → set_face RPC + move (no RPC) →
  speak → done; peer-left mid-turn (each peer type); brain-status on join;
  stale-turnId frames ignored.

**Phone unit (JUnit4):**
- `RemoteBrainTest` — fake StationLink: set_face dispatch + ack, dedupe,
  epoch gating, `publishCritical=false` → Failed + canned line, link-drop
  mid-turn, brain-status gate, digest → status model.
- `StationLinkTest` — `publishCritical` fail-fast; telemetry outbox unchanged.

**Smoke (`npm run smoke:brain`):** `dev/fake-phone.ts` + a fake firmware peer
(extend the existing `smoke-client.ts` body fake to answer `set_target` with
`applied`): scripted partials + turn-request, tool answers, prints the
per-turn latency waterfall (request → TTFT → first-speak → first-set_target →
done). Doubles as the perf harness.

**Hardware checklist + chaos (per release):**
1. Kill station mid-turn → phone: link-lost line once, reconnect, next
   utterance works; body holds pose, heartbeat re-converges.
2. Airplane-mode the phone 5 s mid-turn → same from the phone side; body
   unaffected (its link is independent now).
3. Pull body power mid-gesture → `move` tools error instantly; turn continues
   speaking; body re-converges on boot.
4. Force-stop the app mid-turn → station aborts cleanly; relaunch resumes the
   session.
5. Tap-to-stop mid-sentence ×10 → zero post-interrupt failures.
6. Double-utterance ×10 → clean supersede every time.
7. set_face with gesture + simultaneous console slider → no fight, log shows
   arbitration.

**Perf acceptance:** re-measure the SERVER-BRAIN.md §7 table on the standard
utterance set; gate: TurnSettled p50/p95 within ~200 ms of the local-mode
baselines already in `orbit.db`. Expect `move`-bearing turns to *improve*
(in-process dispatch, one radio leg).

**Regression:** obs UI renders brain-sourced sessions; config push to
firmware/app; OTA both targets; existing `npm run smoke` green.

## 12. Change list (by file)

**orbit-station** — new: `modules/brain/{index,session,rpc,tools,sentence,
prompt,safe-compute,store}.ts` + tests; `modules/bodylink/{motion,heartbeat,
state}.ts` + tests; `modules/docks/directory.ts` (+ presence fan-out) +
tests; `dev/fake-phone.ts`. Edits: `core/protocol.ts` (+`agent` topic;
**hello v2**: `component`/`kind`/`caps`, `role` collapses to
device|browser, `bodyAddr` removed), `core/bus.ts` + `core/hub.ts`
(`toAddr {dock, component}` resolution at fan-out; WS ping/pong idle
timeout), `main.ts` (register brain), `modules/config/registry.ts`
(+`brain*` entries incl. `brainGrants`, +`dockManifest`; `bodyAddr` entry
retired), `modules/bodylink/index.ts` (console routes through the executor;
targets `resolveCap(dock,'servo')`), `modules/docks/index.ts` (directory per
§3.3), `modules/media/` (viewer side generalized: any sink-cap component may
subscribe, not just browsers), `modules/perception/index.ts` (export
enroll/recognize), `package.json` (pi deps, `smoke:brain`), README.

**node-dock/app** — new: `agent/RemoteBrain.kt`, `agent/ToolStatus.kt`.
Edits: `station/StationLink.kt` (`publishCritical`, `agent`+`bodylink`
subscribe + callbacks; **hello v2**: `component:"phone"`,
`kind:"dock-android-app"`, `caps:["voice","face","camera"]`; consume
`presence` frames → sibling status in UI), `DockScreen`/wiring, body-status
panel reads digests. Deletes: per §4 table (incl. the whole `body/` package).
`local.properties.template`: `STATION_URL` + `DOCK_NAME` only (component
defaults to `phone`).

**node-dock/body-firmware/dock_body_v0** — remove the WS server + `bodyAddr`
hello field; **hello v2** (`component:"body"`, `kind:"dock-body-fw"`,
`caps:["servo"]`); consume `presence` (a "phone present" bool, available to
future behaviors); `set_target`/`applied`/`profile` parity on the station
socket; staleness tripwire; `BL_FW_BUILD` bump; `scripts/test_body.sh` →
station REST.

**docs** — this file; [plan.md](plan.md) §9 entries (server brain amendment +
"one server" body decision); [SERVER-BRAIN.md](SERVER-BRAIN.md) banner;
[bodylink/DESIGN.md](../node-dock/bodylink/DESIGN.md) banner (topology
retired, contract semantics live on over the station socket); CLAUDE.md
node-dock section at cutover.

# BodyLink — protocol & spec

> **2026-06-12 — topology change planned ([docs/decision-traces/server-brain-impl.md](../../docs/decision-traces/server-brain-impl.md)).**
> The Brain role moves from the phone to **orbit-station**, and the transport
> moves to the body's existing station WS connection — the body's own WS
> *server* (§1.2) is removed; the firmware becomes client-only, and the phone
> never talks to the body. The **contract semantics in this doc survive
> unchanged** (profile advertisement §2, per-part idempotent `set_target` §3,
> errors/events §4, hold-pose-on-disconnect + heartbeat cadence §5) — they are
> re-hosted on the station socket, with the station's motion executor as the
> single Brain. Until that cutover lands, this doc describes the live system.

**What it is.** A small WebSocket protocol that lets a phone (Brain) drive
servos on a separate microcontroller (Body) over Wi-Fi. The Body advertises
its capabilities (parts + parameter ranges + home pose) at handshake; the
Brain sends `set_target` commands and the Body executes them. One command,
per-part idempotent — usable for both immediate intent and periodic heartbeat.

**Where it's used.** [orbit's node-dock](../) — the dock is the reference
implementation. The protocol is deliberately small so a future second body
(a different MCU, a different mechanical layout) can speak it without
rewriting the Brain side.

> **Parked idea — BodyLink as a standalone SDK (noted 2026-06-12).** Part of
> the original motivation for body-as-WS-server was an SDK framing that never
> got written down: *"what's the easiest way to control an ESP32's servos
> over Wi-Fi, out of the box?"* — flash this firmware on the ESP32, point any
> client (a phone, a laptop, a script) at `ws://<body>:17317/`, and you have
> a self-describing servo controller: it advertises its parts/ranges/home and
> obeys `set_target`. In that framing the body *should* be the server —
> pluggable clients connect to it, no broker required. That product idea was
> under-explored and is **parked, not dead**: orbit's own topology moves to
> station-as-single-master (see the banner above), but if BodyLink is ever
> extracted as an independent "servos over Wi-Fi" SDK, the standalone-server
> mode is the heart of it and this spec is already written to support it
> (transport-agnostic contract, capability advertisement, single-master
> `BUSY` rule). Revisit if/when the protocol gets a second user outside orbit.

> **Source-of-truth files** (when this doc and code disagree, code wins):
> - **Body firmware** (canonical implementation): [../body-firmware/dock_body_v0/](../body-firmware/dock_body_v0/) (ESP-IDF, native esp_wifi + esp_http_server + cJSON). Verified end-to-end on hardware.
> - **Body sim** (mirrors firmware): [sim/bodylink_sim.py](sim/bodylink_sim.py).
> - **Live capability profile:** [sim/profiles/dock_companion.json](sim/profiles/dock_companion.json).
> - **Hardware-aligned MJCF:** [sim/bodies/dock_humanoid.xml](sim/bodies/dock_humanoid.xml).
> - **Brain client (Kotlin):** [BodyProtocol.kt](../app/app/src/main/kotlin/dev/orbit/dock/body/BodyProtocol.kt) + [BodyLinkComms.kt](../app/app/src/main/kotlin/dev/orbit/dock/body/BodyLinkComms.kt) — on the current `set_target` protocol (heartbeat + state catalog).
> - **Interactive tester:** [../body-firmware/dock_body_v0/scripts/test_body.sh](../body-firmware/dock_body_v0/scripts/test_body.sh) — works against both the live firmware and the sim.
>
> **2026-05-27 — protocol redesign.** Earlier drafts had the body advertise named
> states (`lookUp`, `forward`, etc.) and push a 10 Hz `state` stream. The body
> now advertises only **parts, their primitive parameters, ranges, and a home
> pose.** All named states live in the brain. The body is a thin executor of
> raw `(part, param, value, duration)` tuples — no named-state catalog, no
> body→brain state stream. The brain uses a single command, `set_target`, for
> both immediate intent and an idempotent periodic heartbeat. See
> [HANDOVER.md](HANDOVER.md) for the Kotlin-side impact.

---

## 0. Frame

Two parties:

- **Brain** — the Android phone running the dock app. WebSocket client. Owns
  the **state catalog** (names → primitive parameter sets), the LLM, camera, UI.
  Sends raw commands to the body.
- **Body** — an ESP32 (today) holding servos. WebSocket server. Single Brain at
  a time. Knows its own physical limits, executes whatever the Brain commands,
  applies safety clamps, reports errors. Holds **no named states** — just parts
  with primitive parameters.

This separation is deliberate. Previously the body held the catalog of named
states; that meant adding a new pose required a firmware rebuild. Now the body
just exposes "here are the parts I have and the parameter ranges they accept,"
and the brain decides what to call those parameter values. The brain's state
catalog can be edited, snapshotted, learned, overridden — without touching the
firmware.

Plat (a future control plane on a laptop) is not in v0. The wire stays
transport-agnostic so it can be added without touching application code.

This document covers:

1. **Messaging protocol** — wire format, framing, message types (§1).
2. **Capability model** — parts, parameters, ranges, home pose (§2).
3. **Commands** — `set_target` (universal: immediate intent + idempotent heartbeat) (§3).
4. **Body → Brain messages** — errors and events only; no state stream (§4).
5. **Reliability** — disconnects, ping/pong, watchdog, safety (§5).
6. **State catalog (brain-owned)** — where named states live (§6).
7. **Latency, benchmarking** (§7).

---

## 1. Messaging protocol

### 1.1 Wire format

JSON, UTF-8, one message per WebSocket frame. ESP32-S3 parses small JSON via
cJSON; the dock app via kotlinx-serialization.

### 1.2 Transport

Wi-Fi WebSocket. ESP32 is the server; phone is the client. Address
`ws://<body-ip>:17317/`. Manual host config for v0 (`BODY_HOST` in
`local.properties`). Exactly one Brain per Body — second connection rejected
with `BUSY` and immediate close.

### 1.3 Envelope

Every message:

```json
{
  "v": 0,
  "type": "<message-type>",
  "id": "<optional-correlation-id>",
  "ts": 1731943244123,
  "body": { ... }
}
```

- `v` — protocol version. `0` for now. Closed system, all clients upgraded
  together — no protocol-version-negotiation policy (see §1.5).
- `type` — discriminator (see §1.4).
- `id` — opaque string, present only for messages expecting a correlated
  reply (`echo` / `echo_reply`). Echoed by the responder.
- `ts` — milliseconds. Brain uses epoch; body uses since-boot. Diagnostic only.
- `body` — type-specific payload, always an object.

### 1.4 Message types

| `type`       | Direction       | Purpose                                                       |
|--------------|-----------------|---------------------------------------------------------------|
| `hello`      | Brain → Body    | Open session, declare protocol version.                       |
| `welcome`    | Body → Brain    | Body identity + proto-version ack.                            |
| `profile`    | Body → Brain    | Capability advertisement (§2). Sent after `welcome`.          |
| `set_target` | Brain → Body    | Move one or more parts. Per-part idempotent — used for both immediate intent and periodic heartbeat (§3.1). |
| `applied`    | Body → Brain    | One-per-message ack of a `set_target` that **changed** state. Echoes the request's `id`. Heartbeat resends that no-op produce no ack. See §3.2. |
| `event`     | Body → Brain    | Async non-fatal notice (boot, clipped value). See §4.1.       |
| `echo`       | Brain → Body    | Diagnostic round-trip probe.                                  |
| `echo_reply` | Body → Brain    | Reply to `echo`.                                              |
| `error`      | either          | Fatal-or-not error with code + message.                       |

**There is no `state` message type.** The body does not push periodic state
to the brain. (Earlier protocol drafts did; removed in the 2026-05-27 redesign
since the brain already knows what it commanded.) The body sends errors and
events only.

### 1.5 Versioning

Closed system — Brain, Body, and Sim are released together. `v: 0` is the
only version today. If we add a field that breaks decoding, we bump it in
all three at once. **No backwards-compat code paths in firmware.**

### 1.6 Handshake

```
Brain                               Body
─────                               ─────
                  (WS connect)
                              ←─    event { kind: "boot" }     (immediate)
hello { v: 0 }                ─→
                              ←─    welcome { device_id, name, fw_version, proto: 0 }
                              ←─    profile { ... }              (§2)
set_target / echo / ...       ⇄
```

Body sends `event:boot` immediately on WS connect, then waits for `hello`.
On `hello` (any `v: 0`), body sends `welcome` then `profile`. After that the
brain may issue commands at any time.

If `hello.v != 0`: body sends `error { code: "BAD_VERSION", fatal: true }`
and closes.

### 1.7 Errors

```json
{ "v":0, "type":"error", "body": { "code": "BAD_VERSION", "message": "...", "fatal": true } }
```

| `code`                | Fatal | Meaning                                                          |
|-----------------------|-------|------------------------------------------------------------------|
| `BAD_VERSION`         | yes   | Protocol version mismatch in `hello`.                            |
| `BAD_MESSAGE`         | no    | Malformed JSON, missing required field. Three in a row → fatal.  |
| `BUSY`                | yes   | Second Brain rejected.                                           |
| `INTERNAL`            | no    | Firmware bug / hardware fault. Stays connected; may emit follow-up `event`. |
| `UNKNOWN_TYPE`        | no    | Unrecognized `type`.                                             |
| `UNKNOWN_PART`        | no    | `set_target` named a part not in the profile.                    |
| `UNKNOWN_PARAM`       | no    | `set_target` named a parameter that part doesn't have.           |
| `OUT_OF_RANGE`        | no    | Value outside the declared range. Body clips silently *and* emits this so the brain knows. |

Non-fatal errors stay connected. Brain may surface them as tool-call errors
or dev-panel warnings.

---

## 2. Capability model — what the body advertises

The body's `profile` message is its self-description. The brain uses it to know
what parts exist, what parameters each accepts, what's safe, and what pose the
body is in at boot.

### 2.1 Shape

```json
{
  "v": 0, "type": "profile", "ts": 12345,
  "body": {
    "device_id": "xiao-esp32-001",
    "name": "dock-body-smoke-v0",
    "fw_version": "0.0.1",
    "parts": {
      "neck": {
        "description": "Single-DOF pitch servo. Nods up/down.",
        "home": { "pulse_width_us": 1500 },
        "params": {
          "pulse_width_us": {
            "type": "int",
            "unit": "us",
            "range": [500, 2500],
            "description": "Servo PWM pulse width. 1500 µs is mechanical center."
          },
          "duration_ms": {
            "type": "int",
            "unit": "ms",
            "range": [0, null],
            "default": 400,
            "description": "Linear interpolation time to reach target pulse_width_us. 0 = snap."
          },
          "velocity_us_per_sec_cap": {
            "type": "int",
            "unit": "us/s",
            "range": [0, 4000],
            "default": 4000,
            "description": "Max rate of change of pulse_width_us. 0 = use device default. Brain must not exceed declared cap."
          }
        }
      },
      "foot": {
        "description": "Yaw servo, full body swivel.",
        "home": { "pulse_width_us": 1500 },
        "params": { /* same shape */ }
      }
    }
  }
}
```

### 2.2 Per-part fields

- **`description`** (string) — human-readable. Brain uses it in LLM tool docs.
- **`home`** (object) — the pose the body parks each part at on boot. Map of
  parameter-name → value. For smoke firmware: `{ "pulse_width_us": 1500 }`.
  Brain may explicitly command-back-to-home with `set_target`.
- **`params`** (object) — keys are parameter names, values are param specs (§2.3).

### 2.3 Per-parameter spec

A `params[name]` value:

| field         | type        | required | meaning                                                            |
|---------------|-------------|----------|--------------------------------------------------------------------|
| `type`        | string      | yes      | `"int"` or `"float"`. (Strings + enums reserved for future params.) |
| `unit`        | string      | yes      | Unit of measure: `"us"`, `"ms"`, `"us/s"`, `"rad"`, etc. Brain may ignore but should display in dev panel. |
| `range`       | `[lo, hi]`  | yes      | Inclusive numeric bounds. `null` on either side = unbounded that direction. `[0, null]` = ≥ 0 with no upper bound. |
| `default`     | number      | no       | Body-recommended default when brain doesn't specify the param. Brain may use directly. |
| `description` | string      | no       | Human-readable hint. |
| `enum`        | array       | no       | If present: legal value set (overrides `range`). Reserved for future use. |

**Body MUST clip incoming values to `range` and emit `error:OUT_OF_RANGE`
on out-of-range commands.** Brain SHOULD validate before sending; the body's
clip is the safety net.

### 2.4 What the body does NOT advertise

- **Named states.** Not present in the profile. Brain owns them (§6).
- **Per-state durations.** Not present. Duration is a param of the command, not a property of a name.
- **Sensor parts.** Not in v0. Profile parts are motion-only.
- **Cross-part constraints.** Body's params are independent. If the brain
  commands two parts to incompatible poses, the body executes both — physics
  is the brain's problem. (Stall sensing would catch the mechanical conflict;
  not in v0.)

---

## 3. Commands

One motion command. Brain decides when to send it.

### 3.1 `set_target` — universal motion command

```json
{
  "v": 0, "type": "set_target", "ts": 1731943244123,
  "body": {
    "parts": {
      "neck": { "pulse_width_us": 1245, "duration_ms": 400 },
      "foot": { "pulse_width_us": 1500 }
    }
  }
}
```

Body behavior, per `(part, params)` pair in `body.parts`:

1. Lookup `part` in the profile. Unknown → `error: UNKNOWN_PART` (non-fatal).
2. For each param key, lookup in the part's `params`. Unknown → `error: UNKNOWN_PARAM` per key.
3. For each numeric value, clip to declared `range`. If clipped, emit `error: OUT_OF_RANGE` + `event: clipped` carrying requested + applied.
4. If the new target values equal the current commanded target: **no-op**. Don't restart the transition.
5. Otherwise begin a transition: capture current as start, set new target + duration (param default if `duration_ms` not provided), linearly interpolate.
6. `duration_ms == 0` → snap to target instantly.
7. If a transition was already in progress on this part: **preempt** — drop the old target, start fresh from current value to the new target with the new duration.

**Replies.** If at least one part's commanded state changed (step 5 fired
for any part), the body emits a single `applied` message after processing
the whole frame — see §3.2. If every part was a no-op (step 4 for every
part), no `applied` is sent. Errors and events (`UNKNOWN_PART`,
`UNKNOWN_PARAM`, `OUT_OF_RANGE`, `event:clipped`) are emitted as before;
the `applied` ack is purely for brain-side request/response correlation
on a per-message basis — it does NOT carry per-part detail.

#### When the brain sends it

Brain uses the same message for two semantic purposes:

| Purpose | Cadence |
|---|---|
| **Edge intent** — user said "look up", time to move | once, on the change |
| **Heartbeat** — periodic catch-up across all parts | ~1 Hz idle, ~5 Hz active |

The body doesn't distinguish — it processes them identically. Per-part
idempotency (step 4 above) makes the heartbeat cost-free when nothing
changed.

The heartbeat exists to recover from packet loss, brief disconnects, and
firmware restarts: the brain holds the source-of-truth for "where the
body should be," and re-asserts it periodically so any drift between
brain intent and body command-state self-corrects within ~1 s.

### 3.2 `applied` — per-message ack for a state-changing `set_target`

```json
{
  "v": 0, "type": "applied", "id": "n-42", "ts": 12345,
  "body": { "status": "applied" }
}
```

One ack per `set_target` envelope that changed body state. Not one ack per
part. The body decides "did anything change?" by checking each part against
step 4 of §3.1; if at least one part transitioned, the body emits exactly
one `applied`.

Semantics:

- **`id`** echoes the request envelope's `id` if the brain set one. Absent
  in the ack if the brain omitted it. Brain SHOULD set `id` when it needs
  request/response correlation (e.g. the agent blocking on a tool result);
  MAY omit it for fire-and-forget heartbeats.
- **`status`** is one of:
  - `applied` — body began at least one transition.
  - `rejected` — frame was structurally invalid and no transition began
    (e.g. all parts unknown). The body has already emitted an `error`
    with the specifics; `applied:rejected` is the matching correlated
    response so the brain doesn't have to fish for the error by `id`.

Per-part outcomes (which part clipped, which param was unknown, which
exact value was applied) are NOT in this ack — they continue to be carried
on the existing `error` + `event:clipped` streams. The ack answers one
question: "did my request land?"

When the brain receives an `applied`, it MAY treat that as definitive
proof of outcome for the matching `id`. The brain SHOULD set a timeout
(suggested: 500 ms) and surface `no_ack` as a tool-call failure.

#### Brain-side per-part UI state machine

Brains driving a UI off `set_target` SHOULD track each part through
three observable phases, in order:

1. `waiting` — `set_target` sent, no `applied` received yet for the
   correlated `id`. UI: dim, show "waiting" or spinner.
2. `moving` — `applied:applied` received. Linearly interpolate
   `progressAt(now)` from `sentAt + durationMs`. UI: live progress bar / %.
3. `settled` — `progressAt >= 1.0`. UI: solid label, no animation.

If the timeout elapses with no ack: `no_ack`. UI: warn, surface failure
to the agent loop. Brain MAY retry on the next heartbeat (which would
either succeed because the body recovered, or stay silent if the body
is genuinely unreachable).

#### When `applied` is NOT emitted

- Frame whose every part is a no-op (step 4 fired for every part).
- Heartbeat resends — by definition, identical-target resends after the
  first state-changing `set_target` are all no-ops.

This keeps the wire quiet under the 1 Hz idle heartbeat.

### 3.2a No state stream

The body does **not** push periodic position-state frames to the brain.
- Brain knows what it commanded; it doesn't need the body to tell it back.
- If the brain wants to display animated motion in sync with the body, it
  extrapolates using `duration_ms` from the last `set_target` (linear).
- If the brain ever needs to know "did the body actually move?", we can
  add an opt-in `event: settled { part }` later. Not in v0.

This is a major shape change from the earlier protocol — see [HANDOVER.md](HANDOVER.md).

### 3.3 `echo` / `echo_reply`

Diagnostic. Latency benchmark.

```json
{ "v": 0, "type": "echo", "id": "abc", "ts": 1000,
  "body": { "seq": 0, "host_ts": 1731943244123 } }
```

Body replies with the same `id`, echoing `seq` and `host_ts`, adding its own clock:

```json
{ "v": 0, "type": "echo_reply", "id": "abc", "ts": 234,
  "body": { "seq": 0, "host_ts": 1731943244123, "device_ts": 234 } }
```

---

## 4. Body → Brain messages

`welcome`, `profile`, `applied`, `event`, `echo_reply`, and `error`. No state stream.

### 4.1 Events

Async, fire-and-forget notices.

| `kind`     | Payload                  | Meaning                                                  |
|------------|--------------------------|----------------------------------------------------------|
| `boot`     | `{}`                     | Body just connected. Sent before `hello`.                |
| `clipped`  | `{ part, param, requested, applied }` | Body received a command that exceeded `range`; clipped it. Brain should adjust its understanding (or fix its catalog). |
| `stall`    | `{ part }`               | Body detected mechanical resistance. v0 advisory only.   |
| `estop`    | `{ source }`             | Emergency stop. All motion frozen.                       |
| `settled`  | `{ part }`               | (Future, opt-in.) The named part finished its transition. Not in v0. |

Events are diagnostic. Brain may surface them in logs, dev panel, or LLM
tool-call results.

---

## 5. Reliability

### 5.1 Heartbeats

**WebSocket ping/pong every 2 s from Brain.** If three pongs miss (~6 s), Brain
declares disconnect and reconnects with exponential backoff (1 s → 2 s → 4 s →
max 30 s). Body-side closes if no ping seen for 6 s.

Currently the Brain has `pingIntervalMillis = 0L` (disabled, legacy of a CLI
quirk). **Action item:** re-enable to 2 s — see [HANDOVER.md](HANDOVER.md).
Until then, brain `connected` may report true after a silent body death.

The body's heartbeat for "is the brain still alive?" is the periodic
`set_target` frame (§3.2). If no `set_target` arrives for 30 s, body emits
`event: stale` and holds. (`event: stale` is a placeholder; not in v0 yet.)

### 5.2 Disconnect behavior

**Body, on brain disconnect:**
- Hold last commanded value on every part.
- Do NOT return to home pose. Returning to home would surprise users; brain
  may explicitly issue `set_target` to home if it wants.
- Listen for the next brain.

**Brain, on body disconnect:**
- `connected` flow → false.
- Brain stops sending until reconnect, then on welcome+profile resumes.
- Cached profile flushed on next welcome (body always re-sends profile).

### 5.3 Safety

The body's safety net is the param `range` clamp (§2.3). Brain SHOULD validate
before sending; body MUST clip and report. If a brain commands a value that's
mechanically dangerous, the firmware author should narrow `range` in the
profile.

Stall detection (`event: stall`) is deferred; needs current-sensing servos.

`estop` (emergency stop) hardware is deferred.

### 5.4 Strict-mode policy

Brain (Kotlin) decodes with `ignoreUnknownKeys = false`. Body MUST NOT emit
fields not in the spec. Closed system; we don't tolerate version skew silently.

---

## 6. State catalog — brain-owned

Named states (`lookUp`, `wave`, `forward`, etc.) live in the brain, not the
body. The brain's catalog maps name → primitive command:

```jsonc
// Example brain-side catalog (app/src/main/assets/states.json)
{
  "version": "1",
  "parts": {
    "neck": {
      "home": "center",
      "states": {
        "center":   { "pulse_width_us": 1500, "duration_ms": 300 },
        "lookUp":   { "pulse_width_us": 1245, "duration_ms": 400 },
        "lookDown": { "pulse_width_us": 1755, "duration_ms": 400 }
      }
    },
    "foot": {
      "home": "forward",
      "states": {
        "forward": { "pulse_width_us": 1500, "duration_ms": 400 },
        "left":    { "pulse_width_us": 1000, "duration_ms": 500 },
        "right":   { "pulse_width_us": 2000, "duration_ms": 500 }
      }
    }
  }
}
```

### 6.1 Properties

- **Where stored:** an asset shipped with the app (default catalog) +
  optional user-writable override file in app data dir. Persistent across
  reboots. Mutable at runtime (settings UI, learned via Brain).
- **Schema validation:** at brain startup, the catalog is validated against
  the body's cached profile. A state that references an unknown part or a
  value outside the part's declared range is dropped (with a warning) so the
  LLM never sees a broken tool.
- **LLM integration:** the brain's `move_body(part, state)` LLM tool draws its
  `state` enum from this catalog. Tool descriptions enumerate the available
  state names per part. (`gesture` and `move_sequence` build on the same
  catalog.)
- **Brain may learn new states.** When the brain wants a custom pose, it
  creates a new entry in the catalog (in the override file), and the LLM
  tool description updates. No firmware change.
- **Snapshot / restore.** The override file is a plain JSON document. User
  can edit it directly, back it up, sync across docks.

### 6.2 What this replaces

Previously the body emitted `profile { parts.head.states: { center, lookUp,
lookDown, ... } }` and the brain sent `set_state { part: "head", state: "lookUp" }`.

Now:
- Body emits `profile { parts.neck.params: { pulse_width_us, duration_ms, ... } }`.
- Brain's catalog defines `lookUp = { pulse_width_us: 1245, duration_ms: 400 }`.
- Brain sends `set_target { parts: { neck: { pulse_width_us: 1245, duration_ms: 400 } } }`.

The body never sees the name `lookUp`.

---

## 7. Latency, benchmark

### 7.1 Per-hop budget (Brain → Body, one way)

| Hop                                | Typical     | Worst plausible |
|------------------------------------|-------------|-----------------|
| App → OS socket buffer             | <1 ms       | 2 ms            |
| Phone Wi-Fi radio queue            | 2–8 ms      | 30 ms           |
| Phone → AP                         | 1–3 ms      | 20 ms           |
| AP → ESP32                         | 1–3 ms      | 20 ms           |
| Body RX → JSON parse               | 0.5–1 ms    | 3 ms            |
| Parse → motion-model update        | <0.5 ms     | 1 ms            |
| **Total**                          | **5–15 ms** | **~75 ms**      |

### 7.2 Without a state stream

The previous protocol had 10 Hz state frames the brain could measure to
infer "command observed by body." We no longer have that. To benchmark
end-to-end latency the brain uses the `echo` round-trip (§3.3). It's not
the same as "command-to-motion" but it's a strict upper bound on the
command path (since `set_target` does strictly less work than `echo`).

A direct "command-to-motion" measurement requires the optional `event:
settled` (deferred) or instrumenting the servo PWM line with an external
logic analyzer.

---

## 8. Out of scope (v0)

- Named-state catalog on body.
- State stream body → brain.
- Sensor parts.
- Cross-part atomic commands.
- Stall detection (needs current-sensing servos).
- E-stop hardware.
- Plat integration.
- OTA firmware update.
- Multi-brain.
- Calibration / NVS-stored offsets.

---

## 9. Sim — MuJoCo body that speaks the protocol

A standalone Python implementation of the Body, useful for development
without hardware.

```bash
# headless
python3 sim/bodylink_sim.py

# with live MuJoCo viewer (macOS: use mjpython, not python3)
mjpython sim/bodylink_sim.py --viewer
```

Drive it the same way you'd drive the firmware:

```bash
../body-firmware/dock_body_v0/scripts/test_body.sh localhost
```

or with raw wscat:

```bash
wscat -c ws://localhost:17317/
> {"v":0,"type":"hello","ts":0,"body":{"protos":[0]}}
> {"v":0,"type":"set_target","ts":0,"body":{"parts":{"neck":{"pulse_width_us":1245,"duration_ms":400}}}}
```

The sim speaks the same wire as the firmware (this doc is canonical for
both). Servo positions get translated to MuJoCo joint angles via the
linear mapping `rad = (us - 1500) / 636.62` clamped to the joint's MJCF
range; that keeps the viewer roughly consistent with what an MG90S
would do.

The MuJoCo model is at [sim/bodies/dock_humanoid.xml](sim/bodies/dock_humanoid.xml)
— 4 joints (foot_yaw, neck_pitch, shoulder_left_pitch, shoulder_right_pitch).
The capability profile the sim loads at boot is at
[sim/profiles/dock_companion.json](sim/profiles/dock_companion.json).

**Stale supporting files** (need rewrite, see [HANDOVER.md](HANDOVER.md) §3):
- `sim/bodylink_cli.py` — interactive CLI; still speaks the old `set_state` protocol.
- `sim/integration_test.py` — protocol-coverage test; still asserts on the old shape.
- `sim/test_profile.py` — offline per-state PNG renderer; based on named-state catalog.

---

## 10. Cross-reference

- **Firmware:** [../body-firmware/dock_body_v0/](../body-firmware/dock_body_v0/) — ESP-IDF. Shipped, verified end-to-end. See [progress.md](../body-firmware/dock_body_v0/progress.md).
- **Brain client (Kotlin):** [BodyProtocol.kt](../app/app/src/main/kotlin/dev/orbit/dock/body/BodyProtocol.kt) + [BodyLinkComms.kt](../app/app/src/main/kotlin/dev/orbit/dock/body/BodyLinkComms.kt) — on the current protocol.
- **Capability profile:** [sim/profiles/dock_companion.json](sim/profiles/dock_companion.json).
- **MuJoCo model:** [sim/bodies/dock_humanoid.xml](sim/bodies/dock_humanoid.xml).
- **Interactive tester (firmware + sim):** [../body-firmware/dock_body_v0/scripts/test_body.sh](../body-firmware/dock_body_v0/scripts/test_body.sh).
- **Project map:** [../README.md](../README.md#project-map).

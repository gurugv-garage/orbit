# BodyLink — handover to Android/Kotlin team

> Context for the IDE/dev who owns the Android dock app + the `bodylink/`
> simulator integration tests. The BodyLink protocol was redesigned on
> 2026-05-27. This doc lists everything that has to change on the Kotlin
> side to stay compatible with the new firmware and sim.

---

## TL;DR — what changed in the protocol

| Before                                | After                                                     |
|---------------------------------------|-----------------------------------------------------------|
| Body advertised named-state catalog   | Body advertises **capability profile** (parts + primitive param ranges + home pose). |
| Brain sent `set_state {part, state}`  | Brain sends `set_target {parts: {<part>: {<param>: <value>, duration_ms}}}` for both immediate intent and periodic heartbeat (per-part idempotent on the body). |
| Body pushed 10 Hz `state` frames      | **No state stream.** Brain owns intent; uses `echo` for timing only. |
| Heartbeat: ping/pong (disabled in app) | Brain sends `set_target` (~1 Hz idle, ~5 Hz active) AND we re-enable WS ping. |
| State catalog source-of-truth = firmware | State catalog source-of-truth = **brain assets + override file**. |

The wire envelope (`{v, type, id, ts, body}`) stays the same. Message types
have changed.

Authoritative spec: [DESIGN.md](DESIGN.md).

---

## 1. Files the Android team needs to update

### 1.1 [BodyProtocol.kt](../app/app/src/main/kotlin/dev/orbit/dock/body/BodyProtocol.kt)

**Remove or deprecate** these `@Serializable` types:

- `SetStateBody` (no more `set_state` message type)
- `ProfileStateBody` (no more named-state nesting)
- `PartStatePayload` (no more state stream — see §3 below for what replaces the StateFlow)
- `StateFrameBody` (no `state` type)
- `StateFlagsBody` — keep but only as a future-state holder; not on the wire today

**Add** these `@Serializable` types:

```kotlin
@Serializable
data class SetTargetBody(
    // part name → {paramName: value}. Each part's payload typically has
    // pulse_width_us and optionally duration_ms. Sent for both immediate
    // intent and periodic heartbeat — body is per-part idempotent.
    val parts: Map<String, JsonObject>,
)

@Serializable
data class ProfileBody(
    @SerialName("device_id") val deviceId: String,
    val name: String,
    @SerialName("fw_version") val fwVersion: String,
    val parts: Map<String, PartCapability>,
)

@Serializable
data class PartCapability(
    val description: String,
    val home: Map<String, JsonElement>,           // home values keyed by param name
    val params: Map<String, ParamSpec>,
)

@Serializable
data class ParamSpec(
    val type: String,                              // "int" | "float"
    val unit: String,
    val range: List<JsonElement?>,                 // [lo, hi]; null = unbounded
    val default: JsonElement? = null,
    val description: String = "",
)
```

`WelcomeBody`, `HelloBody`, `EchoBody`, `EchoReplyBody`, `ErrorBody`,
`EventBody`, `BodyEnvelope` — **unchanged**, except `EventBody` may carry
new fields (`param`, `requested`, `applied`) for the `clipped` event kind.
Add them as nullable optionals.

`ProfileBody.stateHz` — **delete the field.** No state stream means no
`state_hz` is sent.

### 1.2 [BodyProfile.kt](../app/app/src/main/kotlin/dev/orbit/dock/body/BodyProfile.kt)

Replace the Kotlin domain model:

```kotlin
data class BodyProfile(
    val deviceId: String,
    val name: String,
    val fwVersion: String,
    val parts: Map<String, PartCapabilityModel>,
)

data class PartCapabilityModel(
    val description: String,
    val home: Map<String, Double>,
    val params: Map<String, ParamSpecModel>,
)

data class ParamSpecModel(
    val type: String,
    val unit: String,
    val rangeLo: Double?,
    val rangeHi: Double?,
    val default: Double?,
    val description: String,
)
```

`describeForLlm()` no longer enumerates state names from the profile —
state names are owned by the **brain-side catalog** (§2). Rewrite this
function to enumerate names from `BodyStateCatalog` (new, §2.1) and tell
the LLM both the catalog and the param ranges the body will accept.

### 1.3 [BodyState.kt](../app/app/src/main/kotlin/dev/orbit/dock/body/BodyState.kt)

`BodyPartState.{Settled,Transitioning}` and `BodyState`/`BodyFlags` —
**delete**. There's no state stream from the body anymore.

If the UI needs a "what state should the body be in right now" StateFlow,
it's owned by the **brain's intent**, not derived from the body. Add a
new type:

```kotlin
data class BodyIntent(
    val parts: Map<String, PartIntent>,   // what the brain wants the body to be doing
)

data class PartIntent(
    val stateName: String?,               // catalog state name if any, else "<custom>"
    val params: Map<String, Double>,      // raw params last commanded
    val sentAt: Long,                      // brain epoch ms
    val durationMs: Int,                   // expected motion duration
) {
    // For UI animation. Linearly interpolates a placeholder progress 0..1.
    fun progressAt(now: Long): Float =
        if (durationMs == 0) 1f
        else ((now - sentAt).toFloat() / durationMs.toFloat()).coerceIn(0f, 1f)
}
```

`BodyEvent` sealed interface — keep, but add:

```kotlin
data class Clipped(val part: String, val param: String, val requested: Double, val applied: Double) : BodyEvent
data class OutOfRange(val part: String, val param: String, val requested: Double, val applied: Double) : BodyEvent
```

### 1.4 [BodyLinkComms.kt](../app/app/src/main/kotlin/dev/orbit/dock/body/BodyLinkComms.kt)

**API changes:**

```kotlin
class BodyLinkComms(
    private val host: String,
    private val scope: CoroutineScope,
    private val catalog: BodyStateCatalog,     // NEW — see §2
) {
    val profile: StateFlow<BodyProfile?>           // unchanged shape (new capability model)
    val intent:  StateFlow<BodyIntent>             // RENAMED from `state` — now brain-owned
    val events:  SharedFlow<BodyEvent>             // unchanged
    val connected: StateFlow<Boolean>              // unchanged

    fun start()                                     // unchanged
    fun stop()                                      // unchanged

    /**
     * Resolves the named state via the catalog → sends `set_target` for
     * the one part. If the same part name appears in both the asset
     * catalog and the override file, override wins.
     */
    suspend fun setState(part: String, stateName: String)

    /** Lower-level: brain has already resolved the primitive command. */
    suspend fun setTarget(parts: Map<String, Map<String, Double>>, durationMs: Int? = null)
}
```

**Internal changes:**

1. **Connect-loop handshake.** Same: wait for `welcome` + `profile`, then
   handshake_done. No state-stream loop to spawn.

2. **Heartbeat — re-enable WS ping.** Currently `pingIntervalMillis = 0L`.
   Set to `2000L` (2 s). The body's `esp_http_server` responds to pings
   automatically; this gives Kotlin a reliable disconnect signal.

3. **Periodic `set_target` task.** New coroutine: every 1000 ms (idle) or
   100 ms (during active motion), send `set_target` with the brain's
   current `BodyIntent`. The body is per-part idempotent — if the
   target didn't change, this is a free heartbeat; if it did (because
   we missed a packet or the body restarted), this recovers automatically.
   Replaces the old state-stream-based "are we still connected" check.
   Pseudocode:

   ```kotlin
   launch {
     while (isActive) {
       if (connected.value && intent.value.parts.isNotEmpty()) {
         val body = SetTargetBody(parts = intent.value.parts.mapValues {
           buildJsonObject { it.value.params.forEach { (k, v) -> put(k, v) } }
         })
         send(envelope("set_target", body))
       }
       delay(if (activelyMoving()) 100 else 1000)
     }
   }
   ```

4. **Receive loop dispatches** on `welcome`, `profile`, `event`, `error`,
   `echo_reply`. **Remove** any handler for `state`. If the firmware ever
   sends one, log + drop.

5. **`setState(part, stateName)`** flow:
   - Catalog lookup `(part, stateName) → {paramName: value, durationMs}`.
   - If not found → emit `BodyEvent` warning + return.
   - Validate against `profile.parts[part].params` ranges.
   - Send a `set_target` with a single-part payload.
   - Update `intent` StateFlow with a `PartIntent`. The periodic
     heartbeat (§3 above) will keep re-asserting it.

### 1.5 LLM tool integration ([DockTools.kt](../app/app/src/main/kotlin/dev/orbit/dock/agent/DockTools.kt))

- Tool names stay (`setNeckState`, `setFootState`, dropping `setHeadState`
  unless the catalog still defines a `head` group). **Note: firmware
  now exposes parts `neck` and `foot`** (not `head` / `foot` /
  `arm.left` / `arm.right`). Update tool definitions to match.
- Each tool's allowable states list is enumerated from the brain's
  **state catalog** (§2), not the body's profile.
- Tool failure messages should surface `Clipped` / `OutOfRange` /
  `UnknownPart` events.

---

## 2. New: brain-side state catalog

### 2.1 Location

```
app/app/src/main/assets/states.json              # default, ships with APK
<context.filesDir>/states-override.json          # user/learned, writable
```

The brain loads `states.json` as the base; overlays anything in
`states-override.json`. The result is in-memory `BodyStateCatalog`.

### 2.2 Schema

```jsonc
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

A "state" is a primitive command bundle. The brain packs its key/value
pairs into `body.parts[<part>]` of a `set_target` frame. Anything in
the bundle that isn't a known param on the part is dropped with a
one-time warning at load.

### 2.3 Validation

At catalog load:

- For each `part` referenced, confirm the body's profile has a part with
  that name. Drop states referencing missing parts (warn).
- For each param value, confirm it's within the body's declared `range`.
  If outside, clip to range and warn (don't silently drop).

This is the brain's safety net. The body has its own (§5.3 of DESIGN.md).

### 2.4 Persistence

`states-override.json` is the only mutable store. Brain writes here when:
- The user edits a state via Settings UI (future).
- The brain "learns" a state ("remember this pose as 'shy'"). (Future.)

Sync / snapshot / restore is left to the user (it's plain JSON).

---

## 3. Integration tests

[bodylink/sim/integration_test.py](sim/integration_test.py) was written
against the old protocol — many of its assertions check named-state
behavior. It needs a rewrite, or at minimum a replacement.

Suggested new shape:

```
test_handshake_emits_boot_then_welcome_profile
test_busy_on_second_brain
test_set_target_clamps_out_of_range
test_set_target_emits_unknown_part_error
test_set_target_emits_unknown_param_error
test_set_target_idempotent_when_already_at_target
test_set_target_multipart_drives_multiple_parts
test_set_target_recovers_after_dropped_command
test_echo_round_trip
test_profile_has_neck_and_foot_with_correct_params
test_clipped_event_emitted_on_clamp
test_legacy_set_param_returns_unknown_type   # confirms the old type is gone
```

I haven't rewritten these yet — left for the Android/sim handover. The
sim ([bodylink_sim.py](sim/bodylink_sim.py)) is updated and runnable; you
can wscat against it and validate by hand to start.

[bodylink/sim/bodylink_cli.py](sim/bodylink_cli.py) — the interactive
client — still references named states. Needs equivalent rewrite: drive
primitive params via `set_target` (e.g. menu entry "neck → 1245 µs over
400 ms"), or load a brain-side states.json and use the catalog as the
menu. For inspiration see [body-firmware/dock_body_v0/scripts/test_body.sh](../body-firmware/dock_body_v0/scripts/test_body.sh) — a working interactive REPL with `;`-batching that auto-merges parallel motion into one set_target.

---

## 4. Step-by-step manual smoke test

After the Kotlin changes ship, verify the app talks to the new sim:

1. **Start sim:**
   ```bash
   cd bodylink/sim
   python3 bodylink_sim.py --viewer
   ```

2. **Configure app:** set `BODY_HOST=<laptop-ip>:17317` in
   `app/local.properties`. Build + install.

3. **Connect:** open app, watch `connected` badge go green. Profile should
   show `neck` + `foot` parts.

4. **Issue a command:**
   - Say "look up" → brain consults catalog → catalog returns
     `{pulse_width_us: 1245, duration_ms: 400}` for `neck.lookUp`.
   - Brain sends `set_target { parts: { neck: { pulse_width_us: 1245, duration_ms: 400 } } }`.
   - Sim's MuJoCo viewer should animate the head pitching up.

5. **Test catch-up:**
   - Stop and restart the sim while the app is running.
   - On reconnect (app's auto-reconnect kicks in), the brain re-sends
     `welcome` + `profile`, then the next periodic `set_target` puts
     the body back where the brain thought it should be.

6. **Test clipping:**
   - From wscat, manually send
     `{"v":0,"type":"set_target","ts":0,"body":{"parts":{"neck":{"pulse_width_us":99999}}}}`.
   - Sim should clip to 2500 and emit `error: OUT_OF_RANGE` + `event: clipped`.

---

## 5. Firmware side — for your reference

The ESP-IDF firmware lives at [../body-firmware/dock_body_v0/](../body-firmware/dock_body_v0/).
M4 is shipped and verified end-to-end on hardware. You don't need to
modify it. But you'll want to drive it directly while building/testing
the Android changes — see §5.2 below.

### 5.1 Stack + state

- **Stack:** native esp_wifi + esp_http_server (WS) + mcpwm (servo) + cJSON.
- **Hardware:** Seeed XIAO ESP32-S3 + u.FL antenna + 4 × MG90S on external 5V brick PSU. The antenna and external 5V are both mandatory — see `body-firmware/dock_body_v0/progress.md` for the hardware lessons.
- **What it speaks:** matches `sim/profiles/dock_companion.json` exactly (same `device_id="xiao-esp32-001"`, `name="dock-body-smoke-v0"`, `fw_version="0.0.1"`, same `parts.neck` + `parts.foot` capabilities). Accepts `hello`, `set_target`, `echo`. Emits `event`, `error`, `welcome`, `profile`, `echo_reply`. No `state` stream.
- **No fields outside the spec.** Strict-mode Kotlin decode is safe.

### 5.2 Driving the live firmware from your IDE

The firmware repo has PlatformIO + a working bench setup. You don't need
to flash anything — the firmware is already running on the user's XIAO
during this work. You just need to talk to it over Wi-Fi.

**Confirm the body is alive:**

```bash
# Wi-Fi has to be the same LAN as the laptop. Ask the user for the IP if
# 192.168.1.10 isn't current — the XIAO holds a DHCP lease so it usually
# stays the same, but the user's home router may differ.
ping -c 3 192.168.1.10
```

**Easiest interactive tester — already written, works:**

```bash
cd ../body-firmware/dock_body_v0
./scripts/test_body.sh                  # defaults to 192.168.1.10:17317
./scripts/test_body.sh 192.168.1.10     # explicit
./scripts/test_body.sh --help           # full command reference
```

Once connected, type `help`. Useful menu commands while debugging the
Kotlin client:

| Command | What you'll see |
|---|---|
| `help` | full in-session menu |
| `status` | last commanded values + which parts the profile advertises |
| `up` / `down` | neck shortcuts (1245 / 1755 µs over 400 ms) |
| `left` / `right` | foot shortcuts |
| `center` | every part → 1500 µs |
| `home` | every part → declared home pose (reads from profile, future-proof) |
| `neck 1245 400` | manual `set_target` for one part |
| `target neck=1245 foot=2000 ms=500` | multi-part move in one frame |
| `raw neck pulse_width_us=1700 duration_ms=300` | escape hatch for arbitrary params |
| `echo` | RTT probe (prints round-trip ms) |
| `neck 1245; foot 2000` | `;`-batching auto-merges parallel motion into one frame |
| `up; wait 600; down; wait 600; home` | sequenced moves with explicit pauses |
| `json <full envelope>` | send a literal envelope — useful for negative-path tests |
| `quit` | leave |

Every line you type prints both the outgoing JSON and the body's reply
(if any). Colour-coded: green = OK, red = error, cyan = event, yellow = outgoing.

**Useful Kotlin-side debugging recipes:**

```bash
# Watch what the firmware emits during a handshake — useful when
# building BodyProtocol.kt's deserializers.
./scripts/test_body.sh
# (then `quit` immediately) → the handshake produced welcome+profile,
# scroll up to see the exact JSON shape your Kotlin types must decode.

# Provoke an OUT_OF_RANGE event to test your Clipped event handler.
./scripts/test_body.sh
> raw neck pulse_width_us=9999
< error  {"code":"OUT_OF_RANGE","message":"neck.pulse_width_us=9999 clipped to 2500","fatal":false}
< event  {"kind":"clipped","part":"neck","param":"pulse_width_us","requested":9999,"applied":2500}

# Confirm the firmware refuses the obsolete set_param type — useful as
# a regression sentinel if your Kotlin client accidentally sends it.
./scripts/test_body.sh
> json {"v":0,"type":"set_param","ts":0,"body":{"part":"neck","pulse_width_us":1500}}
< error  {"code":"UNKNOWN_TYPE","message":"unknown message type: set_param","fatal":false}

# BUSY rejection — open a second client while the first is connected.
./scripts/test_body.sh &        # client 1
./scripts/test_body.sh          # client 2 → BUSY + close
```

**Raw wscat alternative (no node deps):**

```bash
wscat -c ws://192.168.1.10:17317/
> {"v":0,"type":"hello","ts":0,"body":{"protos":[0]}}
> {"v":0,"type":"set_target","ts":0,"body":{"parts":{"neck":{"pulse_width_us":1245,"duration_ms":400}}}}
> {"v":0,"type":"echo","id":"x","ts":0,"body":{"seq":0,"host_ts":0}}
```

The firmware is per-part idempotent — you can spam the same `set_target`
without servo twitch. Use that to dev-test your Kotlin heartbeat
coroutine: have it send `set_target` at 1 Hz and confirm visually that
the servos hold position cleanly.

### 5.3 Flashing the firmware (only if you need to)

You shouldn't need this — the live build is current. But if the user has
power-cycled or you need to rule out a stale firmware:

```bash
cd ../body-firmware/dock_body_v0

# Cleanest one-shot using the workspace's existing PlatformIO env:
~/.platformio/penv/bin/pio run -t upload --upload-port /dev/cu.usbmodem1101

# Or, from the PlatformIO sidebar in VSCode:
#   Project Tasks → seeed_xiao_esp32s3 → General → Upload

# Quick read of serial without monopolizing the port:
~/.platformio/penv/bin/python3 - <<'PY'
import serial, time, sys
p = serial.Serial('/dev/cu.usbmodem1101', 115200, timeout=1)
p.setRTS(True); p.setDTR(False); time.sleep(0.1); p.setRTS(False)
end = time.time() + 20
while time.time() < end:
    line = p.readline()
    if line: sys.stdout.write(line.decode('utf-8','replace')); sys.stdout.flush()
PY
```

The boot banner shows:
```
servo: all 4 servos initialized — holding at center
wifi_sta: STA associated to 'HackersWebAP' ...
esp_netif_handlers: sta ip: 192.168.1.10, ...
bl_ws: BodyLink WS listening on ws://<this-ip>:17317/
main: ✅ Wi-Fi up; BodyLink WS ready on :17317
```

If you see `4WAY_HANDSHAKE_TIMEOUT` or repeated `AUTH_EXPIRE`, the u.FL
antenna may have come loose — see progress.md hardware notes.

---

## 6. Questions / decisions left

- **Tool naming.** `setHeadState` vs `setNeckState`. Pick one and update
  the LLM tool docs accordingly.
- **State catalog versioning.** First version `"1"`. Bump policy + diff
  strategy when we hit the second version — TBD.
- **States that span multiple parts** (e.g. "wave" = head + arm). Not
  supported by the current catalog schema (one part per state entry).
  Worth adding as a future-state — leave a comment in `states.json`.
- **Out-of-band catalog edits.** When the user edits the override file
  while the app is running, does the brain re-read on next command, or
  only on app restart? Suggest restart-only for v0.

---

## 7. Files touched in this redesign (firmware repo)

For reference / cross-checking:

| File | Status |
|---|---|
| [bodylink/DESIGN.md](DESIGN.md) | **Fully rewritten.** |
| [bodylink/sim/profiles/dock_companion.json](sim/profiles/dock_companion.json) | **Replaced** with capability profile. |
| [bodylink/sim/bodylink_sim.py](sim/bodylink_sim.py) | **Rewritten** to speak the new protocol. |
| [bodylink/HANDOVER.md](HANDOVER.md) | **This file.** New. |
| ~~bodylink/README.md~~ | **Deleted** — consolidated into DESIGN.md as a "what BodyLink is" intro + the §9 Sim section. |
| [bodylink/sim/integration_test.py](sim/integration_test.py) | ✅ **Rewritten** (2026-05-27). 12 new tests, `--host` flag for sim/firmware reuse. 30/30 green against live XIAO. |
| [bodylink/sim/bodylink_cli.py](sim/bodylink_cli.py) | ✅ **Rewritten** (2026-05-27). Primitive `set_target` menu (option a). `--host` flag; smoke-tested against XIAO. |
| `body-firmware/dock_body_v0/*` | ✅ Shipped. Emits new profile, accepts `set_target` (single command for both edge intent and heartbeat), verified end-to-end on hardware. Legacy `set_param` returns `UNKNOWN_TYPE`. |
| `app/app/src/main/kotlin/dev/orbit/dock/body/*` | ✅ **Migrated** (2026-05-27). `BodyProtocol.kt`/`BodyProfile.kt`/`BodyState.kt`/`BodyLinkComms.kt` rewritten; `BodyStateCatalog.kt` + `BodyTestController.kt` added; `ui/BodyBadge.kt` updated for `BodyIntent`. WS ping re-enabled at 2 s; heartbeat coroutine ticks at 1 Hz idle / 100 ms active. |
| `app/app/src/main/assets/states.json` | ✅ **Created**. neck: center/lookUp/lookDown/nodYes; foot: forward/left/right/away. |
| `app/app/src/main/kotlin/dev/orbit/dock/agent/DockTools.kt` | ✅ **Updated**. `setNeckState` + `setFootState`; `setHeadState`/arm tools dropped. Catalog-sourced enums. Surfaces Clipped/OutOfRange/UnknownPart in tool result. |
| `app/app/src/main/kotlin/dev/orbit/dock/ui/devbar/DevPanel.kt` | ✅ **New BODY tab** (debug-only): chips for neck:up/dn/ctr, foot:L/fwd/R, home, oor!. Drives `BodyLinkComms` directly via `BodyTestController` for hardware bring-up. |

---

## 8. Agent prompt — copy/paste into a fresh session

If you're an agent picking this up cold (or a human running an agent),
copy the block below verbatim into the new session. It assumes the
working directory is `node-dock/app/` (the Android
project), gives the full task, and tells you exactly how to verify each
step against the live firmware and against the sim.

```
You are continuing a BodyLink protocol migration. The body-side firmware
and the Python sim are already updated. The Android dock app + the
integration tests still speak the OLD protocol. Your job: update them
to match the NEW protocol the body now speaks.

Read these first, in this order:
  1. ../bodylink/HANDOVER.md   (this file — has the line-by-line plan)
  2. ../bodylink/DESIGN.md     (canonical wire spec)
  3. ../bodylink/sim/bodylink_sim.py   (reference impl in Python)
  4. ../body-firmware/dock_body_v0/src/bodylink_proto.{h,c}
     ../body-firmware/dock_body_v0/src/bodylink_motion.{h,c}
     ../body-firmware/dock_body_v0/src/bodylink_ws.c
     (reference impl in C — what the body actually sends/expects)
  5. app/app/src/main/kotlin/dev/orbit/dock/body/*.kt
     (what you're changing — current Kotlin implementation, OLD protocol)
  6. app/app/src/main/kotlin/dev/orbit/dock/agent/DockTools.kt
     (LLM tools that drive the body; you'll update these too)

What changed in the protocol (high level — full detail in HANDOVER.md §0/§1):
  - Body no longer advertises named states. It advertises parts +
    primitive parameter ranges + a home pose.
  - Brain no longer sends `set_state {part, state}`. It now sends a
    SINGLE motion command, `set_target {parts: {<part>: {pulse_width_us,
    duration_ms, ...}}}`. The body is per-part idempotent — same
    message handles both immediate intent (send once on change) and
    periodic heartbeat (~1 Hz idle, ~5 Hz active).
  - Body no longer pushes a 10 Hz `state` stream. Only errors + events.
  - Re-enable WS ping (pingIntervalMillis = 2000L); body's
    esp_http_server auto-pongs.
  - State catalog (named states like "lookUp") lives in the brain now,
    as a JSON asset + writable override file.
  - device_id = "xiao-esp32-001", name = "dock-body-smoke-v0",
    fw_version = "0.0.1", proto = 0. Closed system — no version
    negotiation; if body's v != 0, just close.

Tasks (in order — each independently testable):

  T1. Update Kotlin wire types in BodyProtocol.kt per HANDOVER.md §1.1.
      Delete: SetStateBody, ProfileStateBody, PartStatePayload,
              StateFrameBody, StateFlagsBody.
      Add:    SetTargetBody, ProfileBody (new shape),
              PartCapability, ParamSpec.
      Keep:   BodyEnvelope, HelloBody, WelcomeBody, EchoBody,
              EchoReplyBody, ErrorBody, EventBody (extend with
              optional `param`, `requested`, `applied` for clipped).
      Confirm Json{} still has ignoreUnknownKeys = false.

      Verify: ./gradlew :app:compileDebugKotlin passes.

  T2. Update the Kotlin domain model in BodyProfile.kt + BodyState.kt
      per HANDOVER.md §1.2 + §1.3.
      Delete: BodyPartState.{Settled, Transitioning}, BodyState,
              BodyFlags (no more body→brain state stream).
      Add:    PartCapabilityModel, ParamSpecModel.
              BodyIntent + PartIntent (brain-owned what-it-wants).
      Extend BodyEvent sealed interface with Clipped + OutOfRange.

      Verify: ./gradlew :app:compileDebugKotlin passes.

  T3. Update BodyLinkComms.kt per HANDOVER.md §1.4.
      - Replace `state: StateFlow<BodyState>` with
        `intent: StateFlow<BodyIntent>`.
      - Delete state-stream receive handler; firmware never sends it.
      - Add setTarget(parts, durationMs?) — fire-and-forget. Single
        motion API; the brain calls it for both immediate intent
        AND periodic heartbeat (body is per-part idempotent).
      - Add setState(part, stateName) that resolves via the catalog
        (T4) into params then calls setTarget for that single part.
      - Add a coroutine that periodically broadcasts `set_target`
        with the current `intent` across ALL parts (1 Hz idle,
        ~5 Hz during active motion — gate on `intent` recently
        changed). This is the heartbeat.
      - Set `pingIntervalMillis = 2000L`.
      - Receive-loop dispatch: welcome, profile, event, error,
        echo_reply. Tolerate (log + drop) anything else, including
        a stray `state` from a stale body.

      Verify: app launches without crash; logcat shows
        `welcome` + `profile` parsing the new shape cleanly.

  T4. Create the brain-side state catalog per HANDOVER.md §2.
      - app/app/src/main/assets/states.json — ship the default
        catalog (neck + foot at minimum; same names the LLM tool
        descriptions need: center/lookUp/lookDown/forward/left/right).
      - Add a loader class BodyStateCatalog that reads the asset,
        overlays any <context.filesDir>/states-override.json,
        validates against profile (drop states referencing missing
        parts or values outside declared range), exposes the merged
        catalog.

      Verify: catalog loads at app start; logcat reports parts +
        state-counts loaded.

  T5. Update DockTools.kt (LLM tools) per HANDOVER.md §1.5.
      - Tool names: setNeckState, setFootState (DROP setHeadState
        unless catalog still defines a `head` group — it shouldn't).
      - Enumerate allowable state names from BodyStateCatalog, not
        from the body's profile.
      - On Clipped / OutOfRange / UnknownPart, surface the detail
        in the tool-call result so the LLM stops.

      Verify: open the app on a phone, say "look up" while the
        firmware is running. Neck servo nods. (See the §4 manual
        smoke test in HANDOVER.md.)

  T6. Rewrite bodylink/sim/integration_test.py per HANDOVER.md §3.
      Tests to write (drop the named-state ones):
        - test_handshake_emits_boot_then_welcome_profile
        - test_busy_on_second_brain
        - test_set_target_clamps_out_of_range  (emits both error
          AND event:clipped)
        - test_set_target_emits_unknown_part_error
        - test_set_target_emits_unknown_param_error
        - test_set_target_idempotent_when_already_at_target
        - test_set_target_multipart_drives_multiple_parts
        - test_set_target_recovers_after_dropped_command
        - test_echo_round_trip
        - test_profile_has_neck_and_foot_with_correct_params
        - test_clipped_event_emitted_on_clamp
        - test_legacy_set_param_returns_unknown_type

      Verify: `python3 sim/integration_test.py` against the running
        sim (`python3 sim/bodylink_sim.py`). All green.
      Then re-point at the live firmware (host=<xiao-ip>) and re-run.
      All green there too (modulo MuJoCo-specific assertions).

  T7. Rewrite bodylink/sim/bodylink_cli.py per HANDOVER.md §3.
      Either:
        (a) menu-drive primitive params via set_target (`neck →
            1245 µs over 400 ms`), OR
        (b) load the brain's app/src/main/assets/states.json catalog
            and let the user pick named states from it.
      (a) is simpler; (b) more useful for hands-on demos. Recommend (a).
      Reference impl: ../body-firmware/dock_body_v0/scripts/test_body.sh.

      Verify: `python3 sim/bodylink_cli.py --host <ip>` works against
        both sim AND firmware.

How to test end-to-end after T1-T5:
  1. On a laptop: `cd bodylink/sim && python3 bodylink_sim.py --viewer`.
  2. In app's local.properties, set BODY_HOST=<laptop-ip>:17317.
  3. ./gradlew :app:installDebug.
  4. Open app. Connection badge → green. Profile shows `neck`, `foot`.
  5. Voice or text "look up" → catalog resolves → set_target sent →
     sim's MuJoCo head pitches up.
  6. Stop the sim; restart. App auto-reconnects within a few seconds;
     periodic set_target re-syncs.
  7. Repeat (1)-(6) but pointing at the live firmware instead of the
     sim. BODY_HOST=<xiao-ip>:17317 — the firmware is at 192.168.1.10
     in the original dev setup; ask the user for current IP.

Driving the live firmware (no flashing required):
  See §5.2 of this doc — `body-firmware/dock_body_v0/scripts/test_body.sh`
  is an interactive REPL that handles the handshake, lets you send
  set_target / echo / batched parallel moves, and prints both sides of
  every exchange. Use it to:
    - Observe the exact welcome+profile JSON your BodyProtocol.kt has
      to decode.
    - Provoke OUT_OF_RANGE / UNKNOWN_PART / UNKNOWN_TYPE for testing
      your Kotlin error handlers.
    - Confirm the firmware is alive before each T-item.

Hardware notes (if testing against the firmware):
  - The XIAO ESP32-S3 needs its u.FL antenna connected, else WiFi
    is unreliable. See body-firmware/dock_body_v0/progress.md.
  - Servos MUST run off an external 5V brick — NOT the XIAO 5V pin.
    USB-VBUS browns out on multi-servo current spikes.

Things to NOT touch in this session:
  - Firmware (../body-firmware/dock_body_v0/). It works.
  - bodylink/DESIGN.md, bodylink/HANDOVER.md, bodylink/sim/bodylink_sim.py,
    bodylink/sim/profiles/dock_companion.json. They're correct.

Things you CAN propose as follow-ups but defer:
  - Stall + estop sensing in firmware.
  - Plat integration.
  - OTA.
  - States that span multiple parts (multi-part atomic moves).
  - Catalog schema versioning.

Commit message style for this repo (see `git log --oneline`):
  lowercase prefix (`node-dock/app:`, `bodylink/sim:`, etc.) + em-dash
  + concise summary. Body has bullets and the Co-Authored-By trailer.

When done, update HANDOVER.md (this file) to mark the T-items as done
and note any decisions/deviations.
```


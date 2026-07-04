# dock_body_v0 — bring-up progress

Living checklist for the ESP-IDF rewrite of the BodyLink dock body
firmware. Each milestone is a smoke test that should be **independently
provable** before we layer the next thing on top.

> **Why this exists.** The earlier Arduino-on-ESP32 version compiled and
> joined a phone hotspot but could not pass the WPA2 4-way handshake
> against the user's Airtel-Nokia G-140W-F GPON ONT (SSID
> `HackersWebAP`). After eliminating every router-side and credential
> variable, we concluded the arduino-esp32 Wi-Fi stack itself was the
> problem. Switched to native ESP-IDF. First IDF probe joined the same
> AP on the first attempt — confirming the stack choice.

## Stack decisions (locked)

| Concern | Choice | Why |
|---|---|---|
| Framework | **ESP-IDF v5.5.3** (via PlatformIO `espressif32@6.13.0`) | arduino-esp32 4-way handshake fails on Airtel ONT; IDF works. |
| Wi-Fi | `esp_wifi` event-driven with PMF capable | Native stack; PMF capable opt-in fixes the ISP-router interop. |
| WebSocket | `esp_http_server` with `CONFIG_HTTPD_WS_SUPPORT=y` | Espressif-blessed, well-tested. |
| Servo PWM | `driver/mcpwm_prelude.h` | Modern IDF servo path. 50 Hz, 500–2500 µs span. |
| JSON | `cJSON` (ESP-IDF stock) | Header-only; available via `PRIV_REQUIRES json`. |
| Console | Native USB-CDC (`CONFIG_ESP_CONSOLE_USB_SERIAL_JTAG=y`) | XIAO ESP32-S3 has native USB; no UART bridge needed. |

## Milestones

### M1 — Wi-Fi smoke ✅

**Goal:** native `esp_wifi` joins `HackersWebAP` (the AP that
arduino-esp32 couldn't pass).

**Result:** ✅ Joined on first attempt.
- Logs: `connected with HackersWebAP, aid=2, channel 6, 40U`
- Auth: WPA2-PSK
- IP: `192.168.1.10`
- Time to first IP: ~17 s (1 retry due to weak RSSI -86)

**Code:** [src/main.c](src/main.c) — `wifi_init_sta()` + event handler
with reason-code logging and capped retry loop (20 retries × ~2 s).

**Key tuning** ([sdkconfig.defaults](sdkconfig.defaults)):
- `pmf_cfg.capable = true, required = false` in `wifi_config_t`
- `CONFIG_ESP_WIFI_DEFAULT_PS_NONE=y` (power-save off during bring-up)
- Static RX buf 16, dynamic RX/TX buf 32 (handshake-friendly)
- `auth_min = WPA2-PSK` in threshold (don't fall back to WPA-only)

### M2 — WebSocket smoke ✅

**Goal:** `esp_http_server` accepts WS connection on :17317 and
round-trips frames.

**Result:** ✅ Round-trip working.
- Server: `ws://192.168.1.10:17317/`
- Echo behavior: any received text frame → reply `pong:<original>`
- Verified via Node `ws` client: `hi → pong:hi`, `foo bar baz → pong:foo bar baz`, etc.

**Code:** [src/main.c](src/main.c) — `ws_handler()` + `start_ws_server()`,
hooked into the `IP_EVENT_STA_GOT_IP` branch of the Wi-Fi event handler.

**Key tuning:**
- `CONFIG_HTTPD_WS_SUPPORT=y` in [sdkconfig.defaults](sdkconfig.defaults)
- `cfg.server_port = 17317`, `cfg.ctrl_port = 18317` (avoid default 32768 collision)
- `httpd_uri_t.is_websocket = true`

### M3 — Servo smoke ✅

**Goal:** four MG90S visibly move under `mcpwm` control, independent of
Wi-Fi/WS.

**Result:** ✅ Boot demo runs cleanly. All 4 channels initialized,
sequential sweep FL → FR → BL → BR executes in ~10 s with correct
timing. Some servos confirmed moving physically; per-servo diagnosis
deferred to M3.5 manual testing.

**Wiring (locked):**
- FL: brown → GND, red → 5V, orange → GPIO 3
- FR: brown → GND, red → 5V, orange → GPIO 4
- BL: brown → GND, red → 5V, orange → GPIO 5
- BR: brown → GND, red → 5V, orange → GPIO 6

**Code:** [src/servo.h](src/servo.h) + [src/servo.c](src/servo.c).
mcpwm driver setup is split across the two mcpwm groups (FL/FR/BL on
group 0, BR on group 1) because each group has a 3-operator limit.

**One-time setup:** the **external u.FL antenna must be plugged in.**
Without it, Wi-Fi RSSI hovers at -85 to -90 dBm and Wi-Fi join is
flaky/slow; **with** it, RSSI is -52 dBm and Wi-Fi joins on first try
in ~1.6 s with 0% packet loss. This is a hardware requirement, not a
firmware change.

### Hardware lessons from M3 bring-up

Two non-firmware issues blocked clean servo motion until we ran out of
firmware-level things to check:

**1. External u.FL antenna is mandatory.** Without it:
- RSSI: -85 to -90 dBm
- Wi-Fi join: 8-20 retries, sometimes failed entirely
- Packet loss to XIAO: 60-70% (WS handshake couldn't complete)

With the u.FL antenna plugged in:
- RSSI: -52 dBm
- Wi-Fi join: 1 attempt, ~1.6 s
- Packet loss: 0%

The XIAO ESP32-S3 has a u.FL connector by default routed to that
external antenna (no solder bridge to change on this revision). No
firmware change required — just plug the antenna in. **The dock body
must always ship with the antenna attached.**

**2. The XIAO 5V pin can't power 4 MG90S servos.** Symptoms when run
on XIAO's USB-VBUS rail:
- Some servos move, others don't
- Servos buzz intermittently
- XIAO itself brown-out resets (USB-CDC drops mid-command)
- Behavior is inconsistent run-to-run

Math: each MG90S peaks ~650-800 mA at stall (the datasheet's stall
current). Four of them can momentarily demand 3 A. USB-2.0 spec is
500 mA, USB-3.0 is 900 mA. The rail sags below the servo's minimum,
the position-feedback loop misreads, controllers reset, behaviour
degrades.

**Fix:** drive servo +5V/GND from a separate brick PSU (or USB power
bank, or hobby BEC). Keep the XIAO on its own USB. **Critical:** tie
the two grounds together so the signal lines (orange wires) have a
shared reference. With external 5V supply for the servos, all four
move cleanly.

This is a hardware topology rule the production assembly will need:
**never power the servos off the MCU.** Separate rail, common ground.

### MG90S characteristics seen on these clones

Datasheet says ±5 µs dead-band. The clones we have show clear idle
hunt at mid-positions (controller never quite settles, makes a low
buzz at 1500 µs). At endpoints (500 µs, 2500 µs) the gearbox jams
against its hard stop, controller stops correcting, buzz disappears.
This is **normal clone behaviour**, not a defect. Mechanical load on
the horn (e.g. once the head is mounted) usually damps the audible
hunt.

If we ever care: the cure is "de-energize when idle" — write 0 µs
(stops the pulse) when no motion is needed. Adds protocol complexity;
deferred.

### ESP32-C3 SuperMini Wi-Fi — the TX-power / rail-sag / range trap

The C3 SuperMini (added as a second body board — RISC-V, cheap, trace
antenna) has a nasty two-sided Wi-Fi problem the S3 doesn't. It cost a
long debugging session, so here's the whole arc and the fix.

**Symptom 1 — close-range handshake failure (rail sag).** At full TX
power (20 dBm default), the C3 *fails to associate* even with a strong
signal: `AUTH_EXPIRE` / `ASSOC_EXPIRE` / `4WAY_HANDSHAKE_TIMEOUT` /
`AUTH_FAIL` at RSSI -52 dBm on a freshly-rebooted AP. Cause: the C3
mini has **light 3V3 power decoupling**, and a full-power TX burst spikes
current enough to **sag the 3V3 rail mid-frame** — browning out the
radio while it transmits, corrupting the timing-critical WPA 4-way
handshake. Counter-intuitive: *closer* is *worse* (strong signal → radio
drives harder → bigger spike). Fix at the time: cap TX power to **8.5 dBm**
(`esp_wifi_set_max_tx_power(34)` in `wifi_sta.c`, C3-only). Smaller bursts,
no sag, handshake completes. This is the widely-reported ESP32-C3 fix.

**Symptom 2 — the cap kills range.** 8.5 dBm is rail-safe but *weak*:
at ~5 m the link degrades badly — **50-100% packet loss**, latency
swinging to 400-540 ms, WS dropping every few minutes (board still
pingable ⇒ RF/link problem, not a socket wedge). The 8.5 dBm cap that
fixed close-range sag can't reach across a room. One knob, two opposing
failure modes:

| TX power | close range | ~5 m range |
|---|---|---|
| 20 dBm (default) | ❌ rail sag, handshake fails | ✅ reaches |
| 8.5 dBm (cap) | ✅ works | ❌ too weak, drops |

**The fix — 3V3 bulk cap + raised TX, found empirically.** The cap
enables the fix; raising TX *is* the fix. Add bulk capacitance right on
the **3V3 rail** (NOT the 5V input — the sag is downstream of the board's
5V→3V3 regulator, on the rail the radio actually runs off) so it absorbs
the TX burst, then raise TX back up. Measured at 5 m against the same AP:

| Firmware | TX power | 3V3 cap | Loss @ 5 m |
|---|---|---|---|
| build 8  | 8.5 dBm (q=34) | none | 50-100% (unusable) |
| build 9  | 11 dBm (q=44)  | none | ~15-20% (better, still marginal) |
| build 10 | **14 dBm (q=56)** | **1× 100 µF** | **0.0%** (120-packet sample) ✅ |

So: **one 100 µF electrolytic across 3V3↔GND, close to the module, +
TX at 14 dBm → 0% loss at 5 m.** The `BL_C3_TX_POWER_Q` #define in
`wifi_sta.c` is the sweep knob (·0.25 dBm; 34→44→56→78). Raising TX
past what the rail can hold re-triggers Symptom 1 — the cap buys the
headroom.

**Follow-up test — how much is the cap actually doing? (2026-07-04).**
To separate the two levers (TX raise vs. cap), we pulled the cap and
re-tested at the same distance, at 14 dBm. Method: force **cold Wi-Fi
handshakes** by unclaim→reclaim (each dock claim reboots the board), 6
cycles, watching whether each reassociates first-try + its RSSI/reconnect
count from the heartbeat.

| Test (14 dBm, same distance) | Result |
|---|---|
| Cap IN, steady-state ping burst | 20/20, 0% loss, RTT ~35 ms avg |
| **Cap OUT, 6× forced cold reconnect** | **6/6 clean, ~11 s each, RSSI −58…−60, `reconnects`=1 (no retries)** |
| Cap OUT, steady-state ping burst | 20/20, 0% loss (RTT max 305 ms — a touch worse jitter) |

**Reading:** the dominant lever was **raising TX 8.5→14 dBm, not the cap.**
At this range/RSSI (−59 dBm) the handshake burst isn't stressed enough to
sag, so the board is fine capless. The cap's specific job (survive the burst)
only bites at weaker signal / higher TX. **Caveats:** n=6; the reboots were
software-triggered (unclaim→reclaim), not power-cycles — a truer cold boot
would make it airtight; and the probe hinted at slightly worse RTT jitter
without the cap (within noise for one sample). Verdict: **cap = margin at
this range, not strictly required** — but kept in as free insurance and
*required* if the dock moves further from the AP or TX goes above 14 dBm.

**Production rules (C3 only; the S3 has a u.FL antenna + better
decoupling and needs none of this):**
- Keep `BL_C3_TX_POWER_Q` at 56 (14 dBm). The bulk cap is **margin** here
  (6/6 clean reconnects without it at −59 dBm) but becomes **required**
  above 14 dBm or at weaker signal — don't raise TX without the cap.
- On the soldered/permanent build, use **2-3× 100 µF soldered close to
  the C3's 3V3 pins** (breadboard contacts blunt the cap; solder + a bit
  more capacitance is the durable margin over temperature/aging). A
  small 0.1 µF ceramic in parallel handles the high-frequency edge.
- The SuperMini's trace antenna is fundamentally weaker than the S3's
  u.FL. If a dock must live far from the AP, prefer the **S3** for that
  spot, or move the AP / add a repeater — TX+cap has a ceiling.

**Aftermath — link-health telemetry.** This session was slow because we
had no visibility into link quality; we inferred it from `ping` loss by
hand. So the heartbeat now carries **rssi / heap_free / reconnects**
(cheap, already-known state) surfaced on the station's dock card, and an
on-demand **conn-health probe** runs an active packet-loss/latency burst.
"Why is it offline?" is now a glance at RSSI, not a debugging session.

### M3.5 — WS servo-command surface ✅

**Goal:** drive each servo individually from `wscat` with a small text
protocol (not BodyLink yet) to verify per-channel wiring and identify
which physical servo maps to which GPIO.

**Result:** ✅ All 25 commands across all forms return correct replies.

**Wire protocol (text, ASCII, single-frame request/response):**

| Form | Example | Reply |
|---|---|---|
| status | `?` | `OK: FL=1500 FR=1500 BL=1500 BR=1500` |
| help | `help` | one-line cheat sheet |
| µs absolute | `FL:1245` | `OK: FL=1245` |
| radians | `FR:-0.3r` | `OK: FR=1309` |
| named preset | `BL:up` / `BR:down` / `FR:center` | `OK: BL=1245` etc. |
| broadcast | `all:up` / `all:center` | `OK: all=1245 (FL=… FR=… …)` |
| missing colon | `badcmd` | `ERR: missing ':' — see help` |
| unknown servo | `XX:1500` | `ERR: unknown servo 'XX'` |
| bad value | `FL:not-a-number` | `ERR: bad value 'not-a-number'` |

`up` = -0.4 rad (1245 µs), `down` = +0.4 rad (1755 µs), `center` = 0
rad (1500 µs). µs clamped to [500, 2500] silently. Radian-to-µs uses
`us = 1500 + r × 636.62` (same formula as the Python sim and the
original Arduino version).

**Test driver:** [scripts/test_servos.sh](scripts/test_servos.sh)
walks each servo through up/down/center, then broadcasts. Run after
the firmware prints its IP; pass the IP as an argument.

**Per-servo diagnosis:** all four servos verified working once on
external 5V supply. FL has the audible idle hunt described above —
normal clone behavior, no defect.

**This is intentionally NOT BodyLink.** M4 replaces this dispatch loop
with the BodyLink JSON envelope + state machine. The servo driver
([src/servo.c](src/servo.c)) is the only thing both layers share.

### Architectural pivot — 2026-05-27

After M3.5 we redesigned the BodyLink protocol. The earlier shape ("body
advertises named states like lookUp/lookDown, brain sends set_state") is
gone. The new shape:

- **Body advertises capabilities only.** Parts + the primitive parameters
  each accepts + ranges + a home pose. No named states on the body.
- **Brain owns the state catalog.** Named states live in a JSON resource
  in the Android app (assets + writable override). Brain can learn,
  override, snapshot.
- **One motion command:** `set_target {parts: {<part>: {pulse_width_us,
  duration_ms, ...}}}`. The body is per-part idempotent — same message
  handles both immediate intent (send once on change) and periodic
  heartbeat (~1 Hz idle, ~5 Hz active). The brain chooses the cadence.
- **No state stream from body.** Body emits only errors (`UNKNOWN_PART`,
  `UNKNOWN_PARAM`, `OUT_OF_RANGE`, `BAD_MESSAGE`, ...) and events (`boot`,
  `clipped`, future `stall`/`settled`). Brain knows what it commanded.
- **Brain re-enables WS ping** (`pingIntervalMillis = 2000`) for reliable
  disconnect detection.

Authoritative spec: [bodylink/DESIGN.md](../../bodylink/DESIGN.md).
Cross-team impact: [bodylink/HANDOVER.md](../../bodylink/HANDOVER.md).

### M4 — BodyLink protocol on ESP-IDF ✅

**Goal:** firmware that speaks the redesigned BodyLink protocol against
the same physical wiring we already smoke-tested.

**Scope (smoke pass):**
- Two parts advertised in the profile: `neck` (GPIO 3) and `foot` (GPIO 4). The firmware initializes all 4 servos (GPIO 3/4/5/6 = `SERVO_NECK` / `SERVO_FOOT` / `SERVO_ARM_LEFT` / `SERVO_ARM_RIGHT`) and parks them at 1500 µs, but only neck and foot are exposed over BodyLink. Arm parts are deferred to the next pass.
- Identity: `device_id="xiao-esp32-001"`, `name="dock-body-smoke-v0"`, `fw_version="0.0.1"`.
- Handshake: `event:boot` (immediate, before hello) → wait for `hello` (any `v:0`) → `welcome` + `profile`.
- Profile carries capability shape from [bodylink/sim/profiles/dock_companion.json](../../bodylink/sim/profiles/dock_companion.json): per-part `pulse_width_us` (500-2500 µs), `duration_ms` (0-30000 ms), `velocity_us_per_sec_cap` (0-4000).
- Per-part `home`: `{pulse_width_us: 1500}`. Firmware parks each part there at boot.
- `set_target` handler: iterate `body.parts`, per-part validate, clip to range (emit `error: OUT_OF_RANGE` + `event: clipped` on clamp), and only restart a transition if the target value actually changed (idempotent on repeats).
- Linear interpolation in µs space over `duration_ms`. mcpwm comparator updates on a 10 ms tick from the motion task.
- **No state stream emit.**
- Single-client enforcement: second connect → `error: BUSY, fatal: true` + close.
- `echo` / `echo_reply` for latency benchmarking (`id` echoed, body carries `seq` + `host_ts` + new `device_ts`).

**Structure (planned):**
- `src/main.c` — entry; NVS + servos + Wi-Fi + WS start. ~80 lines.
- `src/wifi_sta.{h,c}` — Wi-Fi STA layer moved out of main.
- `src/servo.{h,c}` — unchanged; consider renaming `SERVO_FL`→`SERVO_NECK` and `SERVO_FR`→`SERVO_FOOT` for clarity.
- `src/bodylink_proto.{h,c}` — cJSON encode/decode, pure.
- `src/bodylink_motion.{h,c}` — per-part runtime (start/target µs + duration), `bl_motion_set_target`, `bl_motion_tick`. Mutex-guarded.
- `src/bodylink_ws.{h,c}` — HTTPD + WS handler + single-client state + motion tick task (10 ms cadence).

**Verification (all PASS):**
- ✅ Handshake: `event:boot` → `hello` → `welcome` + `profile` (with both `neck` + `foot` advertised).
- ✅ `set_target` drives neck (servo s1, GPIO 3) and foot (servo s3, GPIO 4) — single-part or multi-part payload.
- ✅ `set_target` idempotency — identical resend produces no servo twitch.
- ✅ `set_target` multi-part — both servos start moving in the same frame.
- ✅ OUT_OF_RANGE clipping (high and low) → `error: OUT_OF_RANGE` + `event: clipped`.
- ✅ UNKNOWN_PART, UNKNOWN_PARAM, UNKNOWN_TYPE — non-fatal errors emitted.
- ✅ `echo` round-trip (RTT ~50-60 ms on local LAN).
- ✅ Duplicate `hello` post-handshake → non-fatal BAD_MESSAGE.
- ✅ BUSY rejection of second client + reconnect after first disconnects.
- 🟡 Python sim CLI: rewritten sim works; CLI itself still on old protocol (deferred — see HANDOVER.md §3).
- 🟡 Android end-to-end: Kotlin side still on old protocol (deferred — see HANDOVER.md §1).

**Interactive tester:** [scripts/test_body.sh](scripts/test_body.sh) — REPL with
help, status, neck/foot set_target, up/down/left/right shortcuts, `home`
(reads home from the profile), `;`-batching that auto-merges parallel
motion into one `set_target`, `wait <ms>` for sequenced moves, `echo`
RTT probe, raw envelope escape hatch.

## Open questions / deferred

- **Servo enum rename.** `SERVO_FL`/`SERVO_FR` (bench labels) → `SERVO_NECK`/`SERVO_FOOT`. Defer to first M4 code session.
- **Brain catalog format.** Versioned `states.json`. First version is `"1"`.
- **States that span multiple parts** (e.g. "wave" = head + arm). Not in v0 catalog schema. Add later.
- **Stall + estop.** Body emits placeholders in the future; not in v0 firmware.
- **OTA, BOM doc update.** Out of scope.

## Recovery / undo

Pre-rewrite state of the **Arduino** firmware is preserved as
`stash@{0}: On local/exps: dock_body_v0 arduino-version-snapshot
20260526-1843`. **It is now stale** — the BodyLink protocol changed
(redesign on 2026-05-27: capability-advertising body + single `set_target`
command), and that stash still speaks the old `set_state` protocol
against the old AP that the arduino-esp32 stack couldn't pass anyway.
Kept around as a historical reference, not a real fallback. The
current ESP-IDF firmware is the only live implementation.

# orbit — Working Draft

> Personal robotics platform. Multiple nodes integrated through a central agent.
> Sim-first; hardware after sim is solid. N-node native; 1-node first.
>
> **This is the VISION doc** (architecture + decision log) — kept aspirational.
> Two things below have since been **renamed / built differently**, noted inline
> where they appear: **`plat` is now `orbit-station`** (the central service); and
> the **agent loop runs server-side** with the perception stack built on the media
> tap, not the original LiveKit/Whisper/Piper plan. Current state:
> [agent-model.md](agent-model.md) (the brain), [media-processing.md](media-processing.md)
> + [perception-pipeline.md](perception-pipeline.md) (senses),
> [perception-to-brain.md](perception-to-brain.md) (the bridge), [TODO.md](TODO.md)
> (what's actually done).

---

## 1. The shape of the thing

**orbit** = the whole platform. Two device classes today, one shared platform service.

```
                  ┌──────────────────────────────────┐
                  │   plat (laptop / home server)    │
                  │  agent: LLM, world model, orch.  │
                  │  WebRTC SFU, STT, TTS, VAD       │
                  └─────┬───────────────────────┬────┘
            WebRTC      │                       │      ROS2 bridge
                  ┌────▼──────────────┐    ┌────▼──────────────┐
                  │ node-dock         │    │ node-rover         │
                  │ (desk companion:  │    │ (linorobot2 floor  │
                  │  phone + optional │    │  robot)            │
                  │  servo body)      │    │                    │
                  └───────────────────┘    └────────────────────┘
```

Naming:

- **orbit** — the platform / project umbrella.
- **plat** — central platform service. Agent (LLM, orchestration), WebRTC SFU, world model. Runs on laptop / home server / cloud.
- **node-rover** — mobile floor robot. linorobot2-based. ROS2 internally.
- **node-dock** — stationary desk companion. Phone-based (mic + cam + speaker + screen + sensors all on-device). Optional servo body driven by an MCU for head/eye motion.

Independence:

- **node-rover** standalone: teleop / wander / Nav2 from RViz without plat or any dock.
- **node-dock** standalone: with plat alone (no rover) = always-on voice + visual assistant with active behavior. Multiple docks = multi-room assistant with presence routing.
- **plat** standalone: useless but harmless.

Nodes **never talk directly**. plat is the only bridge.

Multiple docks may interconnect, but always through plat — same hub-and-spoke as everything else.

---

## 2. Capabilities

End-user-visible behaviors and which pieces they need.

| Behavior | node-dock | node-rover | plat |
|---|---|---|---|
| Always-on listen + speak | ✓ | | ✓ |
| Free-form conversation | ✓ | | ✓ |
| Presence detection per location (audio + visual) | ✓ | | ✓ |
| Active gaze / head tracking / idle gestures | ✓ | | (optional) |
| Display info on the dock's screen | ✓ | | ✓ |
| "Rover, come here" (from any dock) | ✓ | ✓ | ✓ |
| Drive / map / navigate | | ✓ | (optional) |
| Avoid obstacles | | ✓ | |
| See / find objects + people (mobile) | | ✓ | ✓ (for "find X") |
| Grip / lift / place | | ✓ | ✓ (for tasks) |
| Fetch and bring | ✓ | ✓ | ✓ |

---

## 3. node-rover

linorobot2-based mobile platform. ROS2 internally.

### Hardware BOM

| Item | Pick | $ |
|---|---|---|
| Motor MCU | Pi Pico (RP2040) | 5 |
| Motor driver | DRV8833 | 4 |
| Motors + encoders | 2× TT + magnetic Hall | 15 |
| IMU | MPU9250 (9-DOF) | 8 |
| SBC | Raspberry Pi 4 4GB + 32GB SD | 63 |
| LIDAR | LDRobot LD06 | 75 |
| Depth + RGB | OAK-D Lite | 169 |
| OAK-D USB-C Y-power splitter | (mandatory — see decision log) | 10 |
| Arm | 3× MG996R + SG90 gripper + PCA9685 | 25 |
| Local mic | USB mic (cheap) | 10 |
| Local speaker | PAM8403 + 4Ω driver | 8 |
| Power | 7V rail, buck converter, switch, fuse | 10 |
| Chassis | Acrylic/plywood + caster + standoffs | 15 |
| Misc | Wires, JST, screws | 10 |
| **Total** | | **~$427** |

### Software stack

- **Pico:** linorobot2 firmware (PWM, encoders, PID, IMU readout, micro-ROS over USB).
- **Pi:** linorobot2 ROS2 stack — kinematics, odom, EKF, LIDAR driver, `depthai-ros`, `slam_toolbox`, Nav2 with LIDAR `/scan` + OAK-D `/oak/points` as observation sources.
- **Arm:** Python node driving PCA9685 over I²C.
- **Local audio:** small node forwards mic stream / receives playback when plat requests.
- **Command interface to plat:** high-level (navigate-to-room, find-person, grab-object), not raw `/cmd_vel`.

### Standalone behavior

Drivable via teleop, runs `wander` node, executes Nav2 goals from RViz — without plat or any dock.

### Key limitations

- **Mirrors / glass at LIDAR height:** both LIDAR and depth cam can be fooled. Tape frosted film at LIDAR height if it bites.
- **Direct bright sunlight:** OAK-D Lite passive stereo can blow out; LIDAR carries.
- **Featureless walls in dim light:** OAK-D Lite has no IR projector — upgrade path is OAK-D Pro ($429), driver-compatible.
- **Stairs / cliffs:** depth cam usually catches but with latency. For real safety: add 2× IR cliff sensors → `twist_mux` `/cmd_vel` override (~$5 hardware, half-day software). Deferred until needed.

---

## 4. node-dock

A stationary desk companion. Phone-based: a Pixel-class Android phone provides mic + camera + speaker + screen + ambient/proximity/accelerometer sensors. Optionally encased in a body with servos driven by an MCU for head pan/tilt and idle gestures.

All I/O happens on the phone. The phone is the dock's brain at the edge — VAD-driven streaming to plat over WebRTC, plays TTS through its own speaker, drives the optional MCU+servo body over USB-OTG / BLE / Wi-Fi.

N-dock native. One dock per location of interest (desk, kitchen, bedroom). First deployment is one dock on the user's desk.

### Per-dock BOM

| Item | Pick | $ |
|---|---|---|
| Phone | Pixel 4a / 5 / 6a (used) — clean Android, predictable background behavior. **Not** Xiaomi/Samsung/OnePlus (OEM background-kill is too aggressive long-term) | 0–150 |
| OS | GrapheneOS or LineageOS preferred (controlled update timing, security patches without policy churn) | 0 |
| Charging | Charge-limited to 80% via AccA (root) or Chargie hardware ($30), or batteries physically removed for USB-direct power | 0–30 |
| **Body (optional)** | 3D-printed shell, mount, hinges | 5–20 |
| **MCU (optional)** | ESP32-S3 or Pi Pico W | 5–10 |
| **Servos (optional)** | 2× SG90 (pan + tilt) or 3× for eye / head differentially | 5–15 |
| **Per dock (passive)** | phone-on-stand | **~$0–180** |
| **Per dock (with body)** | full enclosure + servos + MCU | **~$15–225** |

For first build with a phone already on hand: ~$0–20 (just a mount).

### Why phones (not a Pi + USB mic / camera)

- **Hardware AEC, multi-mic beamforming, noise suppression** all manufacturer-tuned, no DSP work
- **Decent speaker** built-in — no PAM8403 + driver
- **Camera + screen + accelerometer + ambient light + proximity** all integrated
- **Wi-Fi + sufficient CPU** to stream audio + 720p video over WebRTC
- **One physical device** instead of mic+speaker+SBC+power+enclosure
- **AEC architecturally clean:** mic+speaker on same WebRTC endpoint = AEC reference signal is local, just works (standard VoIP topology)

### What runs on the phone

Custom **native Kotlin app**. Browser/PWA kiosk path was investigated and dismissed (Chrome background-tab kill, wake-lock unreliability under thermal pressure, auto-update interruptions). The app does:

- WebRTC client (audio + video tracks, bidirectional)
- Foreground service with `foregroundServiceType="microphone|camera"` (required Android 14+)
- Wake lock + screen on (or always-on display)
- Configured with a dock ID + plat URL
- Plays received TTS audio through phone speaker (WebRTC remote track)
- Optional: small status UI, mute button, on-screen privacy indicator
- **Local active behaviors:** eye contact, gaze tracking, idle gestures, head-following-face — driven on-device without an agent round-trip. plat owns *intent* ("look at the user", "nod"); the dock owns micro-execution.
- **(Optional body) MCU comms:** USB-OTG serial preferred (simplest, no pairing). BLE or local Wi-Fi viable. Sends servo angles / gesture commands.

**No existing app does mic + camera streaming to a local agent.** Closest base to fork: HA Companion app (Kotlin, open source). Estimate ~1–2 weekends to build the streaming client.

### Optional servo body — BodyLink

The phone snaps into a 3D-printed shell with hinges. An **ESP32-S3** drives
small servos for head nod + arm abduction + body yaw. Phone connects to
the ESP32 over **Wi-Fi WebSocket** (ESP32 = server, phone = client; see
[../node-dock/bodylink/DESIGN.md](../node-dock/bodylink/DESIGN.md)). Phone
owns the high-level behavior and sends `set_state(part, state)` commands
referencing the body's self-declared state catalog; ESP32 streams reported
state back at 10 Hz.

Final hardware joint count: **4 DOF** — DS3218 (foot yaw, ±90°), MG90D
(neck pitch), 2× SG90 (lateral shoulder abduction, T-pose direction). BOM
+ assembly + 3D-print SCAD/STL at
[../node-dock/hardware/](../node-dock/hardware/).

Power: USB-C PD into the body splits to phone charge + 5V servo rail. Servo
rail isolated with a cap to absorb stall spikes; the DS3218 + SG90s peak
around 2-3 A under combined load.

Software: the phone app's `dev.orbit.dock.body.BodyLinkComms` Kotlin client
wraps the WebSocket protocol and exposes `profile`/`intent`/`events`/`connected`
StateFlows. The agent drives the body through its `move_body(part,state)` /
`gesture` / `move_sequence` LLM tools, which resolve to `set_target` commands on
the wire. A Python MuJoCo sim at
[../node-dock/bodylink/sim/](../node-dock/bodylink/sim/) implements the
same protocol so the phone-side stack can be developed and verified
without hardware. Gaze tracking uses MediaPipe FaceMesh on-device.

**Status:** Brain side + sim done and end-to-end verified (AVD + physical
phone). **ESP32 firmware live** — native ESP-IDF (esp_wifi + esp_http_server
WS + mcpwm servo), runs on the XIAO ESP32-S3, dials orbit-station, obeys
console commands. Only the physical body assembly remains.

### Self-update (OTA)

Both field devices update over the network with orbit-station as the update
server (no app store, no cable in steady state). See
[ota.md](ota.md) for the full design + decision log.

- **Body (ESP32):** dual-slot A/B partitions + `esp_https_ota`; station offers
  a newer build, the body streams it to the inactive slot, verifies sha256, and
  reboots — marking the image valid only after it rejoins the station, else the
  bootloader rolls back. **Verified on hardware** (build 1→2→3 OTA + rollback).
- **App (Android):** the app receives an offer over the station WS, streams the
  APK, verifies sha256, and installs via `PackageInstaller`; `RelaunchReceiver`
  restarts it into the new build. Silent when the app is device-owner; otherwise
  a one-tap confirm over Wi-Fi. **Verified on hardware** (wireless confirm-install
  on a MIUI phone — note MIUI needs "MIUI optimization" off; Pixel/GrapheneOS has
  no such gate). A wired `adb install` fallback exists for OEMs that block
  app-driven install.
- **Versioning:** one monotonic `build` int per device on the wire (firmware
  `BL_FW_BUILD`, app `versionCode`) is the only thing compared; the station owns
  human labels + release notes (entered at build time). Builds run in an
  attachable tmux session; trigger + watch from the station console's Updates tab.

The one bootstrap cable per device (first ESP32 flash; first app install +
optional device-owner) is one-time provisioning, not part of the update loop.

### What runs at plat (central, for any dock)

- **WebRTC SFU** — LiveKit (recommended, single Go binary, clean track-subscriber APIs) or Pion (lighter, integrate everything in one Go process)
- **Per-stream audio processing:** Silero VAD → utterance chunking → faster-whisper-small STT
- **Per-stream video processing:** MediaPipe BlazeFace (CPU, ~70 FPS single-stream; many docks × 10 FPS is trivial)
- **Presence / activity fusion:** per-dock "user is here" flag from face + voice + ambient
- **Routing:** TTS audio routed to the active dock (highest-confidence user-location)
- **State:** user location, conversation context, per-dock status

### Topic / channel structure

Not MQTT — **WebRTC tracks** per dock, plus a control channel:

| Channel | Direction | Payload |
|---|---|---|
| WebRTC audio track | dock → plat | continuous Opus audio |
| WebRTC video track | dock → plat | continuous H.264 video |
| WebRTC audio track | plat → dock | TTS audio (for playback) |
| WebRTC data channel | bidirectional | dock ID, mute, status, intent commands (look-at, nod, etc.), display content |

### Standalone behavior

One dock + plat = self-hosted always-on voice + visual assistant, optionally with active embodiment. N docks = multi-location assistant with presence routing. Useful end-to-end without the rover.

### Engagement ideas — making the dock feel alive

The dock's "alive-ness" is what separates it from a smart speaker with a screen. Catalog of ideas explored, ordered roughly by engagement-per-effort. Pick from this list whenever we have a polish window; none are blocking.

**No new sensors needed (use what's already running):**

- **Idle whimsy / micro-behaviours.** When nothing's happening, occasionally yawn (mouth opens briefly + eyes close), glance off-screen ("what was that?" — gaze drifts), notice the time ("oh, late"). Pixar-lamp territory: 95% of "endearing" comes from these tiny, unprompted moments. Pure animation on top of FaceController + FaceRenderer. **Highest engagement-per-hour ratio of anything in this list.**
- **Tap-anywhere personality.** Tap-to-wake already exists. Make *where* you tap matter: eyes → blink + look at you. Cheek → blush + happy. Top of screen → looks up curiously. ~30 lines of Compose `pointerInput` math. Tactile, immediate, very different from voice.
- **Sustained gaze → bonding loops.** ML Kit already publishes FaceSeen events. Track how long the user has been looking. After 5s of held gaze, eyes soften and blink rate slows. Look away 30s, eyes go thoughtful/curious. Sustained mutual attention is the closest thing to bonding in robot UX.
- **Time-of-day moods.** Zero sensors — just `Clock`. Morning: energetic, "good morning". Late evening: softer, asks if you want lights dimmed. Midnight: concerned, "you should sleep". Formulaic but it's a huge "feels like a being" win.
- **Reactive ear-cocking to ambient sound.** Audio level + spectral centroid already in the perception stream. Curious expression briefly fires on interesting non-speech sounds (door, doorbell, dog bark). When/if we add a stereo mic later, dock glances toward the source. Currently the VAD bar visual does nothing unless STT engages — wasted signal.
- **"Speaking of which..." memory loop.** Combined with backlog item (A) memory: dock spontaneously brings up earlier topics. "Hey, you mentioned X yesterday — did you finish it?" *The* feature that makes a companion feel like a relationship, not a tool.
- **"Remembers you" via face descriptors.** Not identity recognition. Just ML Kit landmarks → "this looks like the same person I was just seeing." Recognises rough sessions ("you've been here 20 minutes"), greets after a long absence. Privacy-respecting (spatial features in memory, no images persisted).

**One new sensor (small additions):**

- **Proximity → personal-space awareness.** The earpiece IR proximity sensor (binary near/far on most phones) → when you lean in close, eyes widen, voice softens, "hey, what's up?". When you lean out, returns to ambient mode. Distance is a primal social signal — outsized impact for a single `SensorManager` listener.
- **Ambient light → mood with the room.** TYPE_LIGHT sensor (lux). Bright daylight → energetic, faster TTS rate. Dim → softer halo, slower speech, more relaxed expressions. Pitch-dark → "do you want me to be quiet?". Connects the dock to time of day without a clock; feels alive instead of scheduled.

**Bigger lift (research-y / model-bound):**

- **Heart-rate matching via camera (rPPG).** Camera frames + a small rPPG model extract pulse from facial blood-flow color shifts. Dock's existing "breathing" animation syncs to the user's heart rate when they're seated in front of it. Weird, intimate, very different. Real research has done this at ~50ms inference on phones — feasible but ~half-week of work and only earns its place once the simpler items above are done.

**Once we have BodyLink (phone physically moves):**

The sensor-fusion challenge there is that gyroscope / accelerometer / rotation-vector readings will show motion from *both* the BodyLink servo AND the user picking up or shaking the phone. Standard Android sensor framework doesn't expose the distinction. Plan: subscribe to commanded servo motion, subtract it from raw IMU, classify the residual as user-driven. Won't validate this until BodyLink hardware exists.

### Key risks (from research — read carefully)

1. **Battery swelling at 12–18 months.** Phones trickle-charging at 100% in a warm spot is the worst-case lithium stress profile. **Mandatory mitigation:** charge limit to 80% (AccA + root, or Chargie hardware), OR physically remove battery and run on USB direct.
2. **OEM background-kill regression after OS updates.** Most OEMs reset autostart/battery-exemption permissions silently. **Mitigation:** stick to Pixels with GrapheneOS/LineageOS — predictable behavior, controlled update timing.
3. **AEC reliability** depends on keeping mic capture and TTS playback on the same WebRTC endpoint. Don't split — don't play TTS via a separate path. Gate mic during first ~200ms of TTS playback (half-duplex barge-in) to skip AEC cold-start.
4. **Android API churn.** Every ~2 years Google tightens mic/camera background access. Android 15 added 6-hour fg-service caps (mic exempt for now, trending). Mitigation: CI against next year's Android beta; control update timing via LineageOS/GrapheneOS.
5. **Wi-Fi stack rot on old Android.** DHCP renewal failures, stale DNS, requires Wi-Fi toggle to recover. Mitigation: static IP + watchdog ping-and-toggle.
6. **Security:** unpatched old Android on LAN = assume compromised. **VLAN required**, outbound internet blocked at router, disable Google Play Services where possible.
7. **End-to-end latency realistic budget: ~2 seconds.** Sub-1.5s requires streaming at every stage (VAD-driven partial Whisper, streaming LLM, streaming Piper). Design UX around 2s with an audible "thinking" cue or a visible "thinking" gesture on the body.
8. **Operational maintenance:** N-device fleet of OS-updating, battery-aging, Wi-Fi-flaky hardware = **monthly maintenance hour**, ~18-month phone replacement cycle.
9. **Cameras + always-on = significant privacy posture.** Default-off camera with explicit enable, hardware mute switch desirable, retention = 0 (only ephemeral detection results, no recording), clear visual indicator on dock screen.
10. **Servo body, if added:** stall current spikes can brown out USB power; isolate the servo rail and budget the supply for stall, not nominal.

---

## 5. plat (agent + platform service)

> **Renamed `plat` → `orbit-station` (2026-06-02), and split in two.** What's
> built is the **control & observability plane** (`orbit-station/`, Node/TS):
> one WebSocket for all firmware/apps, a browser UI, and modules for
> observability (agent-core traces), config push, the bodylink console, a
> `mind` stub, and the bench viewer. The **media brain** described below
> (WebRTC SFU + VAD + STT + TTS + ROS2 bridge) is **deferred to a separate
> sidecar** — it's a Python/Go GPU-adjacent concern that doesn't belong in the
> Node control process. The text below is retained as the media-brain spec for
> that future sidecar. See the decision log entry "orbit-station split" and
> [`../orbit-station/README.md`](../orbit-station/README.md).

Lives on the laptop (or cloud / dedicated home server later). One process tree:

### What it does

- **WebRTC SFU** (LiveKit or Pion) receives audio + video from all docks
- **Per-stream processing:**
  - Silero VAD → utterance chunking
  - faster-whisper-small → transcripts
  - MediaPipe BlazeFace (CPU) → face presence per dock
- **Presence fusion:** per-dock "user is here" flag from audio + visual + ambient
- **Subscribes to rover** (ROS2 bridge) for position, camera, status
- **LLM** (TBD — "anything works later") receives transcripts + dock + presence + rover state, emits responses + intents
- **TTS** (Piper) generates audio bytes, routed back over WebRTC to the active dock
- **Intent dispatch:**
  - High-level rover commands over ROS2 (navigate-to-room, find-person, grab-object)
  - Dock behavior commands over WebRTC data channel (look-at, nod, idle, display X)
- **Maintains world model:** user location, rover pose, conversation context, location → map-coord mapping
- **Privacy controls:** per-dock camera enable, mute states, recording = none

### Degradation modes

- **No rover:** docks still work — audio + presence assistant + active body.
- **No docks:** rover still drivable via teleop / RViz.
- **No plat:** both nodes still standalone (degraded — no LLM, no presence routing).

---

## 6. Cross-system messaging

| From | To | Substrate | Examples |
|---|---|---|---|
| node-dock | plat | WebRTC | continuous audio + video tracks |
| plat | node-dock | WebRTC | TTS audio track, intent commands via data channel |
| node-rover | plat | ROS2 (bridge or native node on plat host) | position, camera, status |
| plat | node-rover | ROS2 | high-level intents (navigate-to-room, find-person, grab-object) |
| dock ↔ dock | — | — | **No direct link.** plat bridges. |
| dock ↔ rover | — | — | **No direct link.** plat bridges. |

**Why two substrates:** ROS2 is forced by linorobot2/Nav2 on the rover. WebRTC is the right substrate for continuous multi-modal media (audio + video) from many edge devices to one server — designed for exactly this use case (Zoom, doorbell cameras, video baby monitors). Hub-and-spoke through plat keeps each side's internals clean.

---

## 7. Compatible alternatives

Drop-in swaps that don't break the architecture.

| Slot | Alternatives |
|---|---|
| Motor MCU (rover) | ESP32-S3 (enables Wi-Fi micro-ROS); Teensy 4.x deprecated by linorobot2 |
| Motor driver | TB6612FNG, L298N (less efficient), L9110, BTS7960 (larger motors) |
| Motors | N20 metal-gear with encoders if TT too imprecise |
| IMU | MPU6050 (6-DOF, no mag); MPU9150, GY-85, QMI8658 |
| Rover SBC | Pi 5 (more headroom); Jetson Orin Nano (vision GPU); Pi 4 8GB |
| LIDAR | RPLIDAR A1/A2/A3/S1/S2/S3/C1, LD19, STL27L, YDLIDAR |
| Depth camera | OAK-D Pro (+IR projector +IMU, $429); RealSense D435/D435i; Orbbec Astra/Femto |
| Cliff sensors | TCRT5000 IR (~$1) or VL53L0X ToF (~$3) |
| Dock device | **Fallback if Android phone path fails:** ReSpeaker XVF3800 + Pi Zero 2 W + 4Ω speaker ($80/dock, audio only — no camera, no screen, no presence sensing). Or ESPHome ESP32-S3-Box-3 / FutureProofHomes Satellite1 (audio only). |
| Dock OS | GrapheneOS or LineageOS preferred over stock Android |
| Dock body MCU | ESP32-S3, Pi Pico W, Arduino Nano (for servo-only, simplest) |
| Dock-MCU link | USB-OTG serial (default), BLE, local Wi-Fi |
| WebRTC SFU | LiveKit (easiest), Pion (single-Go-process integration), mediasoup (highest perf), Janus (older, plugin-based — skip) |
| plat host | Cloud GPU instance; dedicated home server; laptop (default) |

---

## 8. Open questions

**node-dock**
- Which phones available — Pixel-class with GrapheneOS strongly preferred
- Charge-limiting approach: AccA + root, Chargie hardware, or physical battery removal + USB direct
- Custom Kotlin app — fork HA Companion or write from scratch
- WebRTC SFU: LiveKit (simpler) vs Pion (tighter integration)
- Camera default-off vs default-on; explicit per-dock enable mechanism
- Display use: status only, or show conversational context / images
- **Body** in v1 or deferred (passive phone-on-stand first, body second?)
- DOF count for body v1 (just pan? pan+tilt? +eyes?)
- Servo MCU choice (ESP32-S3 vs Pico W vs Arduino Nano)
- VLAN + outbound-internet-blocked at router — confirmed setup

**node-rover**
- Cliff sensors — add now or defer
- Camera pan-only vs pan+tilt
- Chassis fabrication: 3D-printed vs laser-cut acrylic
- Battery: when to retrofit from wall-wart

**plat**
- ROS2 bridge: rosbridge_server vs native ROS2 node on plat host
- Location → map-coordinate mapping: how does plat know where "kitchen" is?
- LLM choice (deferred — anything works)
- Multi-user / per-user context

**Cross-cutting**
- Build phasing — sim is done for rover; ship hardware rover first, or build dock v1 first?

---

## 9. Decision log

Compact: decision, reason, what would flip it.

### Docks are compositions of addressed components; the station is the only cross-dock actor (2026-06-12)
Deployment shape made primitive in the protocol: one station per house; N docks; **each dock is a composition of components** (this dock = phone + ESP32; another dock = a different shape; the rover = a dock whose components declare `drive`/`nav`). Hello v2 separates four identities that were conflated: `dock` (tenant — sessions/history/obs bind here), `component` (slot within the dock — addressing/presence bind here), `kind`+`build` (the software in the slot — OTA binds here), `id` (the hardware — diagnostics bind here). Same software on two hardwares = same kind, different id; claiming an occupied `(dock, component)` is the **hardware-swap path** (newest wins, session continues), not an error. Components declare **capability tags** (`voice`, `face`, `camera`, `servo`, …) and station modules route by capability via the dock directory (`resolveCap`), so a differently-shaped dock needs zero station changes. The directory holds a per-dock **manifest** (expected components — what makes *absence* meaningful) and fans directed `presence` frames to each dock's own members on the heartbeat cadence, so every component knows its siblings are there or not. **Cross-dock is designed in, used rarely:** devices are tenant-locked (can only act on their own dock); dock-commanding-dock (desk dock → rover) is a station-module in-process call + directed frames — possible because all brains already live in the station — gated by per-dock **grants** (tool exposure is policy, default none); dock-to-dock A/V generalizes the SFU viewer side to any sink-cap component (streams stay station-fanned so the taps see everything; P2P is a deferred optimization). Details: [docs/decision-traces/server-brain-impl.md](decision-traces/server-brain-impl.md) §2/§3. **Would flip if** device count or media fan-through outgrew one Node process — then the directory/grants model survives and only the fan-out moves.

### One WebSocket server: station drives the body, firmware goes client-only (2026-06-12)
The ESP32's BodyLink WS server is removed; its existing station WS connection becomes the only socket it holds, carrying `set_target` in and `applied`/`event`/state out (the BodyLink contract semantics — per-part idempotency, clamps, profile, hold-pose-on-disconnect — survive unchanged on the new transport). The phone never talks to the firmware again; it gets a ~1 Hz body-status digest for display only. **Reasons:** (1) the original ESP32-as-server choice was never documented, and reconstructing it shows it was about *availability and addressability* ("dial the stable party" — Android punishes inbound listeners; the address belongs on the side with a UI), **not** about authority — and the station is now the stablest, most addressable party in the system; (2) with the brain at the station ([docs/decision-traces/server-brain-design.md](decision-traces/server-brain-design.md)), station→body is one radio leg and zero RPCs vs brain→phone→body's two legs plus an RPC; (3) it deletes the dual-master conflict (phone vs console — now one executor in one process), the docks module's `bodyAddr` brokering, the phone's whole `body/` package, and the documented `faceGestures` keep-in-sync duplication (the config-registry copy becomes the only copy, executed where it's stored); (4) audit showed the phone→body link had **no latency-sensitive users**: gaze tracking drives on-screen eyes only, idle gestures are firmware-local — its only callers were LLM tools that now originate at the station anyway. Big-bang cutover with the server-brain work (controlled project, no rollout constraints). Implementation: [docs/decision-traces/server-brain-impl.md](decision-traces/server-brain-impl.md). **Would flip if** a genuinely tight phone-perception→motion loop appears that station-side perception (SFU fusion) can't serve — that would justify re-adding a direct link, not re-adding the server. **Recovered context (same day):** one original motivation *was* authority-shaped after all — a parked idea of shipping BodyLink as a standalone SDK ("flash the ESP32, point any client at it, control servos over Wi-Fi out of the box"), where body-as-server with pluggable clients is the right shape. Parked, not dead; noted in [bodylink/DESIGN.md](../node-dock/bodylink/DESIGN.md). If that SDK is ever pursued, the standalone server mode returns as a *product* of the protocol — orbit's own deployment stays station-mastered regardless.

### Server-side brain experiment (2026-06-11)
Explore moving the dock's LLM orchestration from the phone to orbit-station as a **parallel path behind a `brainMode: local | station` config flag** — phone becomes perception (transcripts, telemetry, camera) + actuation (face, TTS, servos via remote tool-calls), station runs the loop by embedding the original TS pi (`@earendil-works/pi-agent-core` + `pi-ai`, the upstream of our vendored Kotlin port). Per the §10 frame, **capability is the driver, not latency**: brain iteration becomes a server reload instead of an APK sideload, real providers + keys move out of the APK, sessions survive app restarts (with compaction instead of blunt trimming), and the prompt can fuse station-side perception. Measured obs data (320 turns) says the added hops cost ~25–100ms on a ~2455ms p50 turn — noise against LLM TTFT (p50 1334ms), partially offset by `recollect_face` going in-process and the LLM call moving off phone Wi-Fi. **STT/TTS stay on the phone for phase 1** (transcripts up, sentence text down, streaming-first on every hop); a server media brain remains a separate later decision, de-risked via STT shadow mode on the existing SFU tap. Station dependency is accepted as architecture (it was coming anyway); when the station is unreachable in station mode, fail loudly and flip the flag. Full design + risks: [docs/decision-traces/server-brain-design.md](decision-traces/server-brain-design.md). **Would flip if** real-phone measurements show Wi-Fi jitter making turns or interruption feel worse than local mode, or if the Kotlin/TS dual-surface maintenance cost outweighs the iteration win.

**Amended 2026-06-12 — committed to production, no Kotlin fallback.** The flagged-experiment framing is dropped: this is a full cutover (rollout by app build/OTA, not a runtime flag), and the phone's loop (`DockAgent`, `DockStreamFn`, the `llm/` surface, `:agent-core` from `:app`) is deleted at cleanup. Consequences embraced: the dock cannot converse without the station (canned line + offline cue when the link is down), and **reconnection handling is promoted to a first-class requirement** — turns are bound to the WS connection (disconnect = turn dies visibly on both sides), sessions/history are bound to the dock and survive everything, with an explicit resync handshake on every reconnect. Implementation plan: [docs/decision-traces/server-brain-impl.md](decision-traces/server-brain-impl.md). The remaining would-flip is jitter-feel only.

### orbit-station split (2026-06-02)
`plat` was specced as one heavy process doing both the **media brain** (WebRTC SFU + Silero VAD + faster-whisper STT + MediaPipe + Piper TTS + ROS2 bridge) and, implicitly, all the cross-device glue. Building started on the glue and it became clear those are two different animals: the media pipeline is real-time, Python/Go, GPU-adjacent; the glue is a control plane — observability, config, a body console, a supervisor — best as a small Node/TS service with a browser UI. **Split them.** Renamed `plat/` → `orbit-station/` and built the control plane: one WebSocket every firmware/app connects to, an in-process event bus, and modules (observability of agent-core traces, config push-on-change, bodylink console, `mind` stub, bench viewer). Node + TypeScript; backend (`server/`, raw `ws`) + React/Vite UI (`web/`). The media brain is **deferred to a separate sidecar** (still specced in §5). **Transport:** raw WebSocket everywhere (not socket.io) — the ESP32 can't easily speak socket.io, and one trivial framing for all peers beats a JS-centric one + a bridge. **No fakes in the architecture** — the dock app (emulator or physical device, holding a WS) and the ESP32 (WS client; USB is only for PlatformIO flash/monitor) are the real producers; a manual `npm run smoke` poke exists only for eyeballing the UI. **Would flip if** the media work turns out small enough to co-host, or if everything moved to one language.

### orbit terminology (2026-05-18)
Renamed everything for clarity. **orbit** = platform. **node-rover** = mobile robot (was `botz`). **node-dock** = stationary desk companion (was "I/O node" / "deskz"). **plat** = central agent + platform service. Repo layout: `{plat,node-rover,node-dock,docs}/` at the root. The earlier "I/O nodes one per room" framing was folded into node-dock — a dock can sit on a desk, kitchen counter, or bedside table; "one per room" is just N>1 docks. The "dumb edge device" framing was relaxed — a dock can have local active behavior (gaze, idle gestures) that doesn't require a plat round-trip, while plat still owns intent.

### Multi-node architecture (dock + rover + plat)
The original "one bot does everything" framing coupled the conversational stack to a mobile platform — bad for AEC during motion, far-field while moving, and the "no mic where the bot isn't" problem. Decoupled into N nodes + plat. **Would flip if** the project scope shrank to "just the rover" or "just the dock."

### N-node native, 1-dock first
Protocol, message format, and node code assume multiple docks from day one. First deployment is one dock on the user's desk. Avoids retrofitting distributed-system concerns later.

### WebRTC for docks, ROS2 for rover, plat bridges
ROS2/DDS is forced on the rover by linorobot2/Nav2. WebRTC is the right substrate for continuous audio + video from many edge devices to one server. Each node keeps its native substrate; plat is the only cross-protocol point.

(Earlier plan used MQTT for audio-only nodes. Superseded when docks became Android phones with audio + video; MQTT is poorly suited for streaming media.)

### Rover stack: linorobot2 (don't roll our own)
Principle: learn the unsolved parts, don't relearn solved ones. Motor PID, diff-drive kinematics, odometry, Nav2 setup are solved. linorobot2 provides them under standard ROS2 interfaces. **Would flip if** we needed deep base-controller customization, or build speed dominated (then buy TurtleBot 4 / ROSMaster kit).

### Wheels, not legs (for rover)
Legs at hobby budget = 12 servos + payload-limited + gait tuning project. "Slow" is a PWM cap, not a mechanical property.

### Wall-wart power now, battery retrofit later (rover)
Debugging brownouts during software bring-up is the worst time for batteries. Single 7V rail accepts either source — swap is one-evening.

### Encoders day one (rover)
Without them: bot doesn't drive straight, commanded speed ≠ actual speed, `/odom` is fiction. ~$3 extra; the MCU we're already adding handles counting.

### IMU: MPU9250 (not BNO055)
BNO055 isn't supported out of the box by linorobot2 (would need a C++ driver) and its onboard fusion conflicts with linorobot2's `robot_localization` EKF. MPU9250 + EKF gives the same drift-free heading.

### Nav2 + slam_toolbox for navigation
Production-standard ROS2 indoor mobile-robot stack. No meaningfully better open-source alternative for 2D indoor. **Reactive-only escape hatch:** small node consuming `/scan` and emitting `/cmd_vel` if goal-directed nav is never needed.

### LIDAR + depth camera (LD06 + OAK-D Lite)
Production indoor robots universally use both — LIDAR for reliable localization, depth cam for off-plane 3D obstacles + RGB for VLA. Pi 4 USB power foot-gun: USB-C Y-splitter is **mandatory** or the OAK-D's current spikes brown out the Pi.

### Rover's mic downgraded to cheap USB
With docks carrying conversational load, the rover only needs a mic for bot-local commands ("rover, stop") and contributing as a mobile audio source. The $80 ReSpeaker isn't needed on the rover.

### Dock = Android phone (Pixel-class), not Pi+mic boards
Original plan was Pi Zero 2 W + ReSpeaker XVF3800 + speaker per room (~$80/node, audio only). Reframed because:

- Phones bring **camera, screen, ambient sensors, accelerometer, proximity** for ~zero extra cost (if available) or $50–150 used per Pixel
- Phone hardware AEC is manufacturer-tuned and integrated
- "Presence" becomes audio + visual + ambient fusion, much richer than audio-only
- Future display capability (show info on the dock's screen) is free
- One device instead of mic+amp+speaker+SBC+power+enclosure

Research surfaced significant risks (battery swelling, OEM background-kill, Android API churn, ops maintenance) — see §4 risk list. Accepted consciously.

**Would flip to:** Pi Zero 2 W + ReSpeaker XVF3800 audio-only nodes ($80/dock) if the Android client work proves too expensive, or if the available phones are non-Pixel and OEM background-kill is intolerable. Architecture (WebRTC + central plat doing all heavy lifting) stays the same; only dock hardware changes.

### Dock can have local active behavior (not strictly "dumb edge")
A dock has a phone with a multi-core CPU and on-device ML capability. Gaze tracking, eye contact, idle gestures, head-following-face run on-device with no plat round-trip — too latency-sensitive otherwise. plat owns *intent* ("greet the user", "nod yes"); the dock owns *micro-execution* (which servo angles, when, at what speed). **Would flip if** we shipped docks without a phone (e.g., the ReSpeaker fallback) — then plat would have to drive the body directly.

### Dock body is optional and additive
v1 of a dock is a phone on a stand. The body / servos / MCU are an *upgrade*, not a requirement. The phone app's expression module is a no-op if no MCU is connected. This lets us ship a working voice-and-vision dock before committing to fabrication.

### Always-on, VAD-based segmentation (no wake word)
LLM filters whether utterance was addressed to the system. Silero VAD per dock chops audio into utterances.

### Privacy posture: local-only by default
No cloud STT. All inference on local plat (laptop / home server). Per-dock mute + on-screen privacy indicator. **VLAN required** for docks; outbound internet blocked at the router.

### Form factor (rover): floor robot ~25–35 cm
"Comes to you from across the room" is the rover's headline behavior.

### Form factor (dock): desk-resident, optionally expressive
"Sits with you and reacts to what you're doing" is the dock's headline behavior. Stationary; expressiveness (gaze, servo body) is the differentiator from a passive smart speaker.

### Self-update (OTA) rides orbit-station, no app store
Both field devices update over the network with **orbit-station as the update
server** — it already holds the one WebSocket each device connects to, so OTA is
one more module + topic, not a new service or an app store. The wire carries one
monotonic `build` int (the gate); the station owns human labels/notes. Body uses
A/B partitions + `esp_https_ota` with rollback-on-failed-rejoin; app uses
`PackageInstaller` (silent as device-owner, else one Wi-Fi confirm tap). **Not
an app store**: Play/F-Droid add account/review/propagation overhead and cede
update timing — wrong for an appliance the operator controls. Full rationale +
decision log in [ota.md](ota.md).

---

## 10. Where features live — the decision frame

We don't commit to "fat client" vs "thin client" as an architecture. Each
feature is placed where the trade-offs land *for that feature*. When deciding
where a new feature runs (on-device vs on-plat vs on-cloud), make the
trade-off explicit against these criteria — there's no formal scoring, it's a
checklist so the choice isn't accidental:

1. **Latency needs** — round-trip target (ms / sec / "user-perceivable"), hop count tolerable, streaming or one-shot.
2. **Device capability** — CPU/NPU/memory/battery on the candidate device; does the model/library exist for that platform; always-on vs charging-only vs mobile.
3. **Implementation complexity** — how much new plumbing (transport, build target, ops surface); can we reuse what's already there.
4. **Simplest solution possible** — dumbest thing that could work; will a v0 with no infra get 80% there. Pick the simplest option that satisfies the latency + capability constraints, not the most architecturally pure.
5. **Change management** — if we ship it here and later need to move it, what's the cost. Soft tie-breaker toward the more portable option; never blocks on its own.
6. **Best UX** — does an option noticeably improve feel (e.g. on-device wake-word feels instant and works offline).

**In practice:** node-dock can run a local agent for some tasks AND stream to
plat for others — no "everything goes here" rule. plat stays small until a
feature *needs* it (cross-device state, shared world model, GPU-bound
inference). WebRTC, ROS2 bridge, websockets, gRPC are tools picked per-feature,
not declared up front.

**When in doubt:** default to the device closest to where the work happens (mic
input → device with the mic; robot motion → robot; multi-device fusion → plat).
Move it elsewhere only when a criterion above forces it.

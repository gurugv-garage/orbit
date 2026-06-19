# orbit — TODO

Progress tracker for the orbit platform. Pieces per `PLAN.md`: **node-rover** (mobile robot), **node-dock** (desk companion), **plat** (central agent + WebRTC SFU). Within each: sim → real hardware. Check items as they ship.

Legend: `[x]` done · `[~]` in progress · `[ ]` not started · `[?]` open question/blocked

---

## 0 · Dev environment

- [x] Single Docker container with ROS2 Jazzy + linorobot2 + Nav2 + slam_toolbox + foxglove_bridge + Gazebo
- [x] Plain `bin/` shell scripts (no Makefile, no docker-compose)
- [x] `bin/sync` clones linorobot2 + linorobot2_hardware into `ext/` (gitignored)
- [x] `bin/build` builds image `orbit/rover:latest`
- [x] `bin/up` runs container `rover`, auto-starts foxglove bridge on `:8765`
- [x] `bin/ws-build` runs `colcon build` inside container
- [x] `bin/sim` launches Gazebo headless; `bin/sim-stop` cleans up
- [x] `bin/drive` publishes brief `/cmd_vel` to verify motion
- [x] `bin/shell` opens interactive ROS2 shell (multi-terminal supported)
- [x] `bin/status`, `bin/topics`, `bin/sim-log` introspection helpers
- [x] `bin/nuke` for full reset (preserves checked-in helpers)
- [x] Workspace persists across `bin/down`/`bin/up` via named volumes
- [x] From-scratch reproducibility verified end-to-end
- [x] Foxglove layout `foxglove-layout-v5.json` checked in; URDF + TF + LIDAR + camera all render
- [x] README with quickstart + gotchas captured during bring-up
- [ ] Hot-reload dev loop for our own ROS2 nodes (edit on host → re-build in container without restart)
- [ ] CI: smoke test (lint scripts, build image, boot container, check topics, exit) — runs on PR

---

## 1 · node-rover (sim first, then hardware)

### 1.1 Sim — locomotion stack
- [x] linorobot2 builds in container
- [x] `gazebo.launch.py` runs headless on Mac
- [x] `/odom`, `/odom/unfiltered` publishing
- [x] `/imu/data` publishing
- [x] `/cmd_vel` accepted (forward + turn moves robot)
- [x] `/tf`, `/tf_static` populated; URDF tree intact
- [x] EKF (`robot_localization`) fusing odom + IMU → `/odometry/filtered`
- [x] PID tune — N/A in sim, decision in `screenshots/decisions.md`
- [x] Odom 1m-square closure test (`workspace/test_odom_closure.py`): 1.2 cm drift over 4 m

### 1.2 Sim — navigation perception
- [x] LIDAR `/scan` publishing (Gazebo simulated `gpu_lidar`)
- [x] Depth camera point cloud `/camera/depth/color/points` publishing
- [x] RGB camera `/camera/color/image_raw` publishing
- [x] `slam_toolbox` mapping (`bin/slam`) + bounded coverage drive
- [x] Save map (`bin/save-map`) — `maps/playground.yaml` saved
- [x] AMCL localization on saved map (`workspace/init_amcl.py`)
- [x] Nav2 goal sending — `workspace/send_goal.py` reaches goal with status=4
- [x] Depth-cloud as 2nd costmap observation source (in `patch-nav-yaml`)
- [x] Recovery behaviors observed firing (9 recoveries during one run)
- [x] `wander_node.py` + `bin/wander N R` — 4/4 random goals succeeded

### 1.3 Sim — manipulation
- [ ] 3-DOF arm + gripper in URDF (Gazebo physical, not a stub)
- [ ] ros2_control + joint_trajectory_controller
- [ ] Analytical IK
- [ ] Gripper open/close (with sim grasp physics or fixed-joint hack)
- [ ] Pick-place demo against simulated block
  — Earlier "logical arm" stub was removed: the robot has no arm in
    URDF/Gazebo, so the stub misrepresented capabilities. See
    `screenshots/decisions.md`.

### 1.4 Sim — agent interface
- [ ] Action server: NavigateToRoom, FindObject, Grab, Bring
- [ ] Room → coordinate YAML
- [ ] Behavior tree composing nav + perception + manipulation
- [ ] Status publishing for downstream agent consumption
  — Earlier stub agent_node was removed alongside the arm stub.

### 1.5 Hardware (later — sim must be solid first)
- [ ] BOM purchased per `PLAN.md` Section 3
- [ ] Pi 4 imaged, ROS2 Jazzy + linorobot2 packages installed on it
- [ ] Pi Pico flashed with linorobot2 firmware
- [ ] Motor + encoder + DRV8833 wired; `test_motors` calibration done
- [ ] MPU9250 wired; IMU data flowing
- [ ] Power: wall-wart on 7V rail; motors run cleanly
- [ ] Robot drives via teleop on real hardware
- [ ] LD06 LIDAR mounted; `/scan` matches reality
- [ ] OAK-D Lite wired with USB-C Y-power splitter (critical foot-gun)
- [ ] OAK-D RGB + depth streams visible in Foxglove
- [ ] SLAM a real room → save map
- [ ] Nav2 navigation in the mapped room
- [ ] Cliff sensors (TCRT5000 ×2) added via `twist_mux` override — IF stairs are nearby
- [ ] Bumper microswitch — IF furniture-bashing becomes a problem
- [ ] Arm assembled and mounted; PCA9685 + servos working on real hardware
- [ ] End-to-end: navigate to a labeled location and grasp a target object
- [ ] Battery retrofit: 2S Li-ion + BMS + charge port (swap from wall-wart)

---

## 2 · node-dock (Android phone per location, optional servo body)

### 2.1 Single-node MVP (phone at one location → plat)
- [ ] Inventory which phones are available; confirm at least one is Pixel-class
- [ ] OS choice: stock vs GrapheneOS vs LineageOS per device
- [ ] Charge-limiting strategy decided (AccA + root, Chargie hardware, or battery removal)
- [ ] Write minimal Kotlin app:
  - [ ] Foreground service `foregroundServiceType="microphone|camera"`
  - [ ] Wake lock + screen-on policy
  - [ ] WebRTC client (libwebrtc Android)
  - [ ] Publishes audio track + video track to agent
  - [ ] Receives TTS audio track, plays through phone speaker
  - [ ] Data channel for room ID + status + mute
  - [ ] Configurable agent URL + room ID at install
- [ ] LiveKit (or Pion) SFU running on laptop
- [ ] Server-side participant SDK pulls phone tracks into Python pipeline
- [ ] First end-to-end test: speak into phone → see audio frames on agent
- [x] Hardware AEC validated: TTS playback does not get re-transcribed
      (WebRTC ADM, VOICE_COMMUNICATION + HW AEC; verified on-device via the
      STT-based AEC self-test in the dev DEBUG tab — dock speaks a full passage
      with STT armed through it, STT transcribes nothing). See `WebRtcAudio.kt`.
- [~] Voice barge-in during TTS — **wired but dormant**, blocked on the VAD fix
      below. The trigger (VAD hit during TTS → stop TTS + re-listen) is in
      `PerceptionPipeline.runVad`; the AEC keeps the mic open during TTS so it
      can work. An RMS-loudness stopgap was tried and reverted: AEC leaves
      variable residual energy (mic RMS ~0.02–0.19 during TTS), so a loudness
      threshold self-interrupts unpredictably. VAD (like STT) keys on
      speech-structure, which AEC removes — the correct, robust signal.
- [ ] **Fix Silero VAD** (unblocks barge-in) — broken since initial import: LSTM
      state diverges (magnitude ~30) and probability is frozen ~0.0005 for any
      input (incl. a synthetic full-scale signal). Likely the state round-trip
      layout in `SileroVad.kt` or the V5 context-window input requirement.

### 2.2 Multi-node (2+ phones)
- [ ] Deploy second phone with same app, different room ID
- [ ] Agent maintains per-room presence state
- [ ] Loudest-mic-wins user-location estimate working
- [ ] TTS routes to phone for the active room
- [ ] Mute-other-rooms during TTS to prevent cross-room AEC issues
- [ ] NTP sync across all phones validated

### 2.3 Hardening (per `PLAN.md` Section 4 risks)
- [ ] VLAN for phones; outbound internet blocked at router
- [ ] Static IPs configured per phone
- [ ] Wi-Fi watchdog automation per node (auto-recover from stale DNS / DHCP failures)
- [ ] Privacy controls:
  - [ ] On-screen mic-active indicator
  - [ ] On-screen camera-active indicator
  - [ ] Per-phone physical mute (volume-down long-press → app mutes)
  - [ ] Camera default-off (must opt in per session or always)
- [ ] Battery health monitoring (alert when capacity drops past threshold)
- [ ] Replacement schedule documented (~18 months expected)
- [ ] CI: build app against next Android beta to catch API regressions early

### 2.5 Self-update (OTA) — see [ota.md](ota.md)
- [x] orbit-station `ota` module: artifact store, REST (serve/build/announce),
  version-compare on connect + heartbeat, tmux-backed builds, release notes
- [x] Console Updates tab: per-target cards, trigger buttons, live phase bar,
  attachable build session; build numbers on Overview + roster
- [x] **Body OTA** — dual-slot partitions + `esp_https_ota` + sha256 verify +
  rollback-on-failed-rejoin. Verified on hardware (build 1→2→3 + rollback)
- [x] **App OTA** — offer→stream-download→verify→PackageInstaller; RelaunchReceiver
  restarts into the new build. Verified wireless confirm-install on MIUI
  (needs MIUI-optimization off); wired `adb install` fallback for hostile OEMs
- [x] Build-only versioning on the wire; station owns labels + notes
- [x] Bootstrap scripts: gen-keystore, bootstrap-body, bootstrap-app
- [ ] Silent OTA on the real dock phone (Pixel/GrapheneOS device-owner) — the
  intended appliance; MIUI can't go silent (account catch-22)
- [ ] Verify RelaunchReceiver auto-restart on-device (implemented, not yet watched live)
- [ ] CI builds → station artifact store (currently the station host builds on demand)

### 2.4 Fallback path (if Android proves too painful)
- [ ] Pi Zero 2 W + ReSpeaker XVF3800 + speaker setup ready as audio-only fallback
- [ ] Same WebRTC client logic ported to Linux (Python `aiortc`)

---

## 3 · plat → orbit-station (laptop / home server / cloud)

> **Renamed `plat` → `orbit-station` + split (2026-06-02).** The **control
> plane** is built (`orbit-station/`, Node/TS): one WebSocket, browser UI, and
> modules — observability (agent-core trace ingest), config push, bodylink
> console, `mind` stub, bench viewer (moved from `node-dock/app/bench`), ota
> (self-update for body + app, [ota.md](ota.md)). See
> `orbit-station/README.md` + `TESTING.md` and decision log "orbit-station
> split". The **media pipeline below** (WebRTC/STT/TTS) is a deferred separate
> sidecar — the checkboxes still stand for that.

### 3.0 orbit-station control plane
- [x] One WS hub + in-process bus; raw-WS protocol for all peers
- [x] Observability: agent-core Session/Turn/Step trace ingest + live stream
- [x] Config: defaults + push-on-change to firmware/app over WS
- [x] BodyLink console: direct body control (profile-driven), bypassing the app
- [x] Mind: stub subscriber (no actions yet)
- [x] Bench viewer folded in; browser UI (space-themed, responsive); verified in-browser
- [x] Wire real producers: dock app (device) + ESP32 firmware dial the station
  over WS — both verified live (app reports build/heartbeat, ESP32 sends
  profile/state + obeys console commands)
- [x] OTA module + Updates console tab (self-update for body + app, [ota.md](ota.md))
- [x] Config: flat global keys + per-peer interest push + build-time bake
- [ ] `mind` gains triggers (rules, then maybe LLM supervisor)
- [ ] HTTPS in real deployment; auth on the WS for non-LAN

### 3.1 Audio pipeline (centralized at agent — deferred media sidecar)
- [ ] WebRTC SFU (LiveKit) running on laptop
- [ ] Per-stream Silero VAD chunking utterances
- [ ] `faster-whisper-small` STT on GPU (or `base` CPU fallback)
- [ ] Transcript stream tagged with room ID + timestamp
- [ ] Piper TTS for replies
- [ ] Streaming optimization: stream LLM tokens → streaming Piper → low perceived latency

### 3.2 Vision pipeline
- [ ] Per-phone video frame ingestion at ~10 FPS
- [ ] MediaPipe BlazeFace face detection per stream
- [ ] Presence fusion: per-room "user is here" boolean from face + voice + ambient
- [ ] Robot camera ingestion (OAK-D RGB via ROS2 bridge)
- [ ] On-demand object detection (YOLO / OWL-ViT) for "find the X"
- [ ] On-demand VLM (Moondream / SmolVLM) for "what do you see"

### 3.3 LLM orchestration
- [ ] LLM choice decided (local llama vs API) — currently "anything works later"
- [ ] System prompt + tool-use schema (navigate-to-room, grab-object, find-person, speak)
- [ ] Conversation context per user (simple in-memory for now)
- [ ] LLM decides: spoken response only, or robot task, or both
- [ ] Tool calls dispatched to robot or audio system

### 3.4 World model
- [ ] User location: room + DoA + freshness
- [ ] Robot pose: subscribed from `/odom` via ROS2 bridge
- [ ] Conversation context
- [ ] Room → map-coordinate map (manual config file)

### 3.5 Cross-system bridge
- [ ] ROS2 bridge: `rosbridge_server` OR native ROS2 node running on laptop (decide)
- [ ] MQTT for audio? Currently superseded by WebRTC — confirm we don't need MQTT
- [ ] Hub-and-spoke: agent is only path between phones and robot

### 3.6 Degradation modes
- [ ] Audio-only mode (no robot): functions as voice assistant
- [ ] Robot-only mode (no phones): drivable via teleop/RViz
- [ ] Both-up integration tested

---

## 4 · Behaviors (end-user-visible)

Per `PLAN.md` Section 2 capability table:

- [ ] Always-on listen + speak in one room
- [ ] Free-form conversation
- [ ] Presence detection per room (audio + visual)
- [ ] Display info on the room's screen
- [ ] "Robot, come here" — works from any room (routes via agent)
- [x] Drive / map / navigate — *sim: drive + SLAM + Nav2 with saved map all working*
- [x] Avoid obstacles — *sim: Nav2 obstacle layer with LIDAR + depth-cloud; recoveries verified*
- [ ] See / find objects + people (robot camera)
- [ ] Grip / lift / place — *no arm yet*
- [ ] Fetch and bring — *needs nav + grip + speak chained*

---

## 5 · Backlog — features parked for later

Features identified but deferred. See [`PLAN.md`](PLAN.md) §10 ("Where features
live") for the lens used to evaluate where each lives. Each is sized rough-T-shirt
(S/M/L) and tagged with the most likely host: **dock**, **rover**, **plat**,
or **shared**.

### node-dock

- [x] **BodyLink (Brain side) — sim path** — DONE. Protocol designed
  ([../node-dock/bodylink/DESIGN.md](../node-dock/bodylink/DESIGN.md)), Python
  MuJoCo sim built (`node-dock/bodylink/sim/`, 30/30 integration tests pass),
  Kotlin `BodyLinkComms` client wired into the dock app, 4 part-specific LLM
  tools registered, live body-state badge on the main screen. Verified
  end-to-end on AVD + physical phone: LLM picks tools, sim moves, badge
  updates. See [../node-dock/app/PLAN.md](../node-dock/app/PLAN.md)
  §M7 for the full breakdown.
- [ ] **BodyLink stage 3** — Compose schematic robot canvas (replace the
  text body badge with a live stick-figure drawn from BodyState).
- [ ] **BodyLink stage 4** — Kotlin instrumented integration test against
  the sim.
- [ ] **BodyLink disconnect-detection bug** — body badge stays green
  after sim dies (WS keepalive disabled to keep the inquirer CLI happy;
  re-enable for phone-side use).
- [x] **BodyLink ESP32 firmware** — native ESP-IDF on the XIAO ESP32-S3
  (esp_wifi + esp_http_server WS + mcpwm servo + station_link client).
  Runs on hardware, dials orbit-station, obeys console commands. Hardware
  (BOM, assembly, 3D-print SCAD/STL) at
  [../node-dock/hardware/](../node-dock/hardware/); physical body assembly
  still pending.
- [ ] **(A) Persistent memory / conversation history** — S. Local SQLite (or
  JSON) per dock keyed by turn. Surfaced as Koog recall tool. UX win:
  "what did I ask yesterday?". Revisit centralisation once there's >1 dock.
- [ ] **(B) Wake word "hey jarvis"** — S. Porcupine SDK already integrated;
  needs the access key in `local.properties` and wire-up. UX win: no
  more tap-to-wake.
- [ ] **(D) `remember(text)` + `recall(query)` tools** — M. Builds on (A);
  explicit user-managed notes with naive text retrieval. Vector search
  later if scale demands it.
- [~] **(F) Voice barge-in during TTS** — wired, blocked on the VAD fix. WebRTC
  AEC keeps the mic open during TTS (the hard part, done). The RMS-threshold
  approach envisioned here was tried and reverted — AEC residual energy makes
  loudness self-interrupt; VAD (speech-structure) is the right detector. See §2.1.
- [ ] **(G) Smaller APK / signed release build** — S. ABI splits, drop
  unused WebRTC dep, R8 minification, signing config. 245 MB → ~80 MB.
  Required to share the app with anyone outside this laptop.

### node-rover

- [ ] **(E) Sim items 1.3 (manipulation) + 1.4 (agent interface)** — L.
  Already enumerated in §1.3/1.4 above; flagged here for visibility.
  Independent of dock work.

### Shared (dock ↔ rover, first feature that requires plat)

- [ ] **(C) Cross-device awareness** — M. Rover publishes pose; dock
  asks "where are you?". Simplest v0: rover → small HTTP endpoint on
  plat → dock polls. No WebRTC SFU yet — pick that up when streaming
  audio/video is the actual need. First feature where plat earns its
  keep.

---

## 6 · Open questions (from PLAN.md Section 8)

### node-rover
- [?] Cliff sensors — add proactively or defer until autonomy reveals need
- [?] Camera pan-only vs pan+tilt mount
- [?] Chassis fabrication: 3D-printed vs laser-cut acrylic
- [?] Battery retrofit timing (after sim → real hardware milestone)

### node-dock
- [?] Which specific phones are on hand
- [?] Charge-limiting approach finalized
- [?] Fork HA Companion vs write Kotlin app from scratch
- [?] LiveKit vs Pion for SFU
- [?] Camera default-off vs default-on
- [?] Display use: status only vs context/images shown

### plat
- [?] `rosbridge_server` vs native ROS2 node
- [?] Room → map-coordinate config format
- [?] LLM choice (deferred)
- [?] Multi-user / per-user context scoping

### Cross-cutting
- [?] Build phasing — to be decided after architecture stable
- [?] When to graduate from sim to real hardware for the robot

> What already works end-to-end for the rover sim (container, Foxglove
> layout, drive/SLAM/Nav2 with verified results) is documented in
> [`../node-rover/README.md`](../node-rover/README.md) → "Sim verification".

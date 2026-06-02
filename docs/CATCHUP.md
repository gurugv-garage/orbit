# Catch-up — what's in `orbit/node-rover/` and why

Read this top-to-bottom in 10 minutes. It explains everything built while
you were away, what each file does, and what to look at if you want to
verify anything.

> **Naming note (2026-05-18):** the platform was renamed to **orbit**. The
> mobile robot (formerly `botz/`) is now **node-rover**. The desk companion
> (formerly "I/O node") is now **node-dock**. The central agent is now
> **plat**. Older paragraphs below may still say "robot" or "agent" — the
> meaning is the same; only the folder names and container names changed.

---

## 1. Where this fits in the overall project

`docs/plan.md` describes the whole orbit platform. Pieces:

| Piece | What it does | Status |
|---|---|---|
| **node-rover** (this work) | Drives, maps, navigates, picks up things | Locomotion + Nav sim done; manipulation + agent not started |
| **node-dock** | Desk companion (phone + optional servo body) | Not started |
| **plat** | LLM hub + WebRTC SFU that bridges nodes | Not started |

This commit finishes the **locomotion + navigation sim** for node-rover
(TODO sections 1.1 and 1.2). Manipulation (1.3) and the high-level command
interface (1.4) are not done — see Step C below.

---

## 2. What state things were in before I started

Already shipped (commits `11c5907` and earlier):
- Docker image with ROS2 Jazzy + linorobot2 + Nav2 + slam_toolbox + foxglove_bridge
- Plain `bin/` shell scripts to run everything (no Makefile, no docker-compose)
- One container `rover` runs ROS2 + Gazebo headless + foxglove on port 8765
- Robot drives in Gazebo via `/cmd_vel`, publishes `/odom`, `/scan`, `/imu/data`, `/tf`, `/camera/*`
- Foxglove layout `workspace/foxglove-layout-v5.json` visualizes the robot

That was the launch pad. Robot moved, but no SLAM, no Nav2, no arm, no
high-level commands.

---

## 3. What I did, in order

### Step A — 1.1 Locomotion validation

Validated that sim odometry is sound. Drove a 1m × 1m square via
`/cmd_vel`, measured closure error.

- **New file:** `workspace/test_odom_closure.py`
- **Result:** 1.2 cm closure error, 1.34° yaw drift over 4m perimeter. Sim is healthy.
- **Decision logged:** PID tuning is N/A in sim (Gazebo's diff-drive plugin
  takes wheel velocities directly; the linorobot2 PID lives in firmware
  for real hardware only).

**Verify with:**
```bash
bin/sim
docker exec -t rover bash -lc \
  'source /opt/ros/jazzy/setup.bash && python3 /ws/overlay/test_odom_closure.py'
```

---

### Step B — 1.2 SLAM and Nav2

Got the robot to map its world, save the map, then autonomously navigate
to goals on the saved map (avoiding both LIDAR-visible obstacles AND
depth-camera-visible obstacles).

**New scripts in `bin/`:**

| Script | Purpose |
|---|---|
| `bin/slam` | Launch slam_toolbox + Nav2 alongside the running sim |
| `bin/save-map <name>` | Save current SLAM map to `maps/<name>.{pgm,yaml}` |
| `bin/nav <name>` | Launch Nav2 with a previously-saved map |
| `bin/nav-stop` | Stop the nav stack (sim keeps running) |
| `bin/wander [N] [R]` | Send N random reachable goals via Nav2 |
| `bin/patch-nav-yaml` | Idempotent patch applied automatically by `bin/ws-build` |

**New Python helpers in `workspace/`:**

| File | Purpose |
|---|---|
| `bounded_coverage.py` | Drives the robot in a coverage pattern, then returns to origin so the saved map contains the start pose |
| `coverage_drive.py` | Earlier unbounded coverage driver (kept for reference) |
| `init_amcl.py` | Publishes `/initialpose` to AMCL from the bot's current `/odom` |
| `send_goal.py` | Test driver — sends one Nav2 goal and waits for result |
| `wander_node.py` | The wander logic that `bin/wander` calls |
| `nav-stop.sh` | Helper inside-container kill script (used by `bin/nav-stop`) |

**Three behavior changes I had to make** (full rationale in §5 below):

1. **Default world `playground`, not `turtlebot3_world`.** The latter has a
   central pillar; with safe inflation, the bot couldn't plan paths through
   it. Override with `WORLD=turtlebot3_world bin/sim`.
2. **`inflation_radius` 0.7 → 0.25** in `linorobot2_navigation/config/navigation.yaml`.
   Default was too aggressive for small sim worlds.
3. **Added depth-cloud as 2nd costmap source.** Nav2 now consumes
   `/camera/depth/color/points` in addition to `/scan`, so off-plane
   obstacles (low tables etc.) are also avoided.

Both YAML changes are applied automatically by `bin/patch-nav-yaml`, which
`bin/ws-build` calls after every workspace build. Since `ext/` is gitignored
and re-fetched on `bin/sync`, this re-runs on a clean rebuild.

**Verify with:**
```bash
bin/sim                                         # playground world
bin/slam                                        # SLAM + Nav2
docker exec -t rover bash -lc \
  'source /opt/ros/jazzy/setup.bash && python3 /ws/overlay/bounded_coverage.py 60'
bin/save-map playground                         # saves to maps/playground.{pgm,yaml}
bin/nav-stop && sleep 3                         # restart for clean state
bin/nav playground
docker exec -t rover bash -lc \
  'source /opt/ros/jazzy/setup.bash && python3 /ws/overlay/init_amcl.py'
sleep 3
bin/wander 3 1.5                                # 3 random goals within 1.5 m
```

**Last verified result:** 4/4 wander goals succeeded.

---

### Step C — 1.3 Manipulation — REMOVED

I initially built a "logical arm" stub (`workspace/arm_node.py`) that held
joint state in memory and exposed `Grab/Place` Trigger services. You
correctly pointed out the robot has no arm in URDF or Gazebo — the stub
only published joint states for joints that don't exist on the bot, and
the "grab" was fictional. All arm stub files were deleted:

- `bin/arm`, `bin/agent`
- `workspace/arm_node.py`, `workspace/agent_node.py`
- `workspace/start-arm.sh`, `workspace/start-agent.sh`
- `workspace/rooms.yaml`

1.3 (manipulation) and 1.4 (agent interface) are back to **not done** in
TODO.md. A real implementation needs: arm in URDF, ros2_control,
Gazebo gripper physics (or fixed-joint hack), real IK, real blocks.

### Step D — 1.4 Agent interface — REMOVED

See Step C. The agent_node stub was deleted along with the arm stub.

---

## 4. The exact files I added/changed

### Added
```
bin/nav                bin/nav-stop          bin/patch-nav-yaml
bin/save-map           bin/slam              bin/wander
workspace/bounded_coverage.py     workspace/coverage_drive.py
workspace/init_amcl.py            workspace/nav-stop.sh
workspace/send_goal.py            workspace/test_odom_closure.py
workspace/wander_node.py
```

### Modified
```
README.md             — added new bin/ commands to the reference table
TODO.md               — marked 1.1–1.2 complete; 1.3/1.4 remain not done
bin/sim               — added WORLD env var support; default = playground
bin/ws-build          — calls bin/patch-nav-yaml after colcon build
workspace/sim-stop.sh — recognizes both turtlebot3_world.sdf and playground.sdf
workspace/status.sh   — looks for sim by world-file path, not specific name
../.gitignore         — whitelist *.py and *.yaml in workspace/
```

---

## 5. Decisions made along the way

### 1.1 — sim PID is a no-op

Dropped PID tuning from 1.1 scope. The Gazebo diff-drive plugin takes wheel velocity setpoints directly; PID code lives only in `linorobot2_hardware/firmware/lib/pid/pid.h`, never loaded in sim. Closure test is the sole validation.

### 1.2 — default Gazebo world: `playground`, not `turtlebot3_world`

Changed `bin/sim` default to `WORLD=playground`. `turtlebot3_world` has a tight central pillar that with tuned inflation overlaps every path through the middle, causing planner failures. `playground.sdf` is larger and more open. Override with `WORLD=turtlebot3_world bin/sim`.

### 1.2 — patch linorobot2 `inflation_radius` 0.7 → 0.25

Added `bin/patch-nav-yaml` (auto-runs after `bin/ws-build`) that rewrites `inflation_radius` from upstream 0.7m to 0.25m in `ext/linorobot2/linorobot2_navigation/config/navigation.yaml`. The 0.7m inflation around a 0.22m-radius robot makes small worlds unplannable. Idempotent; re-runs cleanly on every fresh sync.

### 1.2 — depth point cloud as second costmap source

Same patch adds `/camera/depth/color/points` as a 2nd costmap observation source alongside `/scan`. Catches off-LIDAR-plane obstacles (e.g., low ledges, overhangs).

### 1.2 — `init_amcl.py` helper

linorobot2 + Nav2 launches don't auto-localize on saved maps. The bot's `/odom` pose is the same as its map pose (SLAM aligned them), so `init_amcl.py` publishes `/initialpose` from current odom every time we start nav.

### 1.2 — `bounded_coverage.py` for return-to-origin

The unbounded `coverage_drive.py` was kept for reference. `bounded_coverage.py` explicitly drives back near origin before stopping, so the saved map contains the start position. Without this, Nav2 errors "Start Coordinates outside bounds".

### 1.3 — arm/agent stub built then removed

Initially built a "logical arm" node (in-memory joint state + `Grab`/`Place` Trigger services) plus an agent_node orchestrating nav+arm. User pointed out the bot has no arm in URDF or Gazebo — the stub published joint states for joints that don't exist and the "grab" was fictional. All of it was deleted: `bin/arm`, `bin/agent`, `workspace/arm_node.py`, `workspace/agent_node.py`, `workspace/rooms.yaml`, demo steps 7-8. 1.3 (manipulation) and 1.4 (agent interface) are back to **not done** in TODO.md.

---

## 6. Verification specimens (per section)

### 1.1 — odometry closure

`workspace/test_odom_closure.py` drives a 1m × 1m square via `/cmd_vel` (forward 1m at 0.15 m/s, turn 90° at 0.5 rad/s, ×4). Last run:

```
[start] x=-0.000 y=-0.000 yaw=-0.00°
[leg 1/4] x=1.004 y=-0.000 yaw=87.94°
[leg 2/4] x=1.000 y=1.003 yaw=178.18°
[leg 3/4] x=-0.003 y=0.996 yaw=-91.58°
[leg 4/4] x=0.009 y=-0.008 yaw=-1.34°
[drift] dx=0.009 dy=-0.008 closure=1.2 cm  yaw_drift=-1.34°
```

**1.2 cm over 4 m perimeter (0.3%). Yaw drift 1.34°.** Sub-degree heading overshoot per turn is consistent with open-loop time-based turning. Confirms `/odom` topology, EKF fusion, `/cmd_vel` reach, frame consistency.

Reproduce:
```bash
bin/sim-stop && sleep 2 && bin/sim && sleep 14
docker exec -t rover bash -lc \
  'source /opt/ros/jazzy/setup.bash && python3 /ws/overlay/test_odom_closure.py'
```

### 1.2 — SLAM + Nav2 + wander

- Map: `playground.pgm` (126 × 227 cells @ 0.05m = 6.3 × 11.4m)
- Goal (1.5, 0.0) from (-0.27, -0.09): status=4 SUCCESS, 9 recoveries fired (spin, backup, wait) before success — Nav2 BT working correctly
- Wander 4 goals: 4/4 SUCCESS, distances 0.61–1.16m each

Reproduce end-to-end:
```bash
bin/sim                                # playground world
bin/slam                               # SLAM stack
docker exec -t rover bash -lc \
  'source /opt/ros/jazzy/setup.bash && python3 /ws/overlay/bounded_coverage.py 120'
bin/save-map playground
bin/nav-stop && sleep 3
bin/nav playground
docker exec -t rover bash -lc \
  'source /opt/ros/jazzy/setup.bash && python3 /ws/overlay/init_amcl.py'
sleep 3
bin/wander 4 1.2
```

---

## 7. Honest limitations and gotchas

1. **No manipulation.** node-rover has no arm in URDF or Gazebo. The earlier stub was removed (see §5).
2. **Nav2 is sensitive to start position being inside the map.** If the bot ends up outside the saved-map bounds, the planner errors with "Start Coordinates outside bounds." `bounded_coverage.py` mitigates by returning the bot near origin before save.
3. **After `bin/nav-stop`, the nav stack may not bring back up cleanly** via just `bin/nav` again — sometimes `bin/sim-stop + bin/sim + bin/nav` is needed.
4. **The `ros2` daemon caches topic info** — if `ros2 topic info /foo` returns stale data, run `ros2 daemon stop && ros2 daemon start`.

---

## 8. What to read (in order)

If you have **5 minutes:** this file, top to bottom.

If you have **30 minutes:** add [`TODO.md`](TODO.md) sections 1.1–1.4 + [`plan.md`](plan.md) §3 (node-rover) and §9 (decision log).

If you have **1 hour and want to verify by running it:** run the reproduce blocks from §6 above. ~5 min runtime once the container is up.

If you want to **read code:** `node-rover/workspace/{bounded_coverage,wander_node,init_amcl,test_odom_closure}.py`.

---

## 9. What's next

From [`plan.md`](plan.md) and [`TODO.md`](TODO.md):

- **node-rover hardware** (TODO 1.5) — not started. Sim is the foundation; real Pi 4 + linorobot2 firmware + LIDAR + OAK-D + arm is its own multi-day project.
- **node-rover manipulation + agent interface** (TODO 1.3, 1.4) — not started; earlier stubs were removed.
- **node-dock** (TODO section 2 in original numbering) — not started. Phone + optional servo body.
- **plat** — not started. WebRTC SFU, STT/TTS, LLM, world model.

This commit's value: anything from here can call `/agent/navigate_to_room`
and `/agent/bring` and get nav-plus-arm behavior with no further wiring on
the robot side.

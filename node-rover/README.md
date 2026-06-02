# node-rover — orbit mobile robot (sim env)

Mobile floor robot node of the [orbit](../) platform.

ROS2 Jazzy + linorobot2 + Nav2 + slam_toolbox + foxglove bridge + Gazebo sim, in one Docker container. Mac (Docker Desktop) friendly. Sim/learning only — no USB hardware on Mac.

The container is named `rover`. Inside it runs the [linorobot2](https://github.com/linorobot/linorobot2) stack against a Gazebo-simulated 2-wheel diff-drive robot.

## Quickstart

```bash
bin/sync       # clone linorobot2 + linorobot2_hardware into ext/
bin/build      # build the docker image (~10 min first time)
bin/up         # start the container (foxglove bridge auto-starts inside)
bin/ws-build   # build linorobot2 inside the container (~1 min, one time)
bin/sim        # launch headless Gazebo sim
# → open Foxglove → ws://localhost:8765
bin/drive      # quick forward+turn motion to verify
bin/sim-stop   # stop the sim (container stays up)
```

## One container, many terminals

A single container called `rover` runs everything. To run multiple ROS2 processes in parallel (sim + teleop + a custom node + …), open multiple `bin/shell` terminals into the same container.

```bash
# Terminal A
bin/shell
root@rover:/$ ros2 topic echo /odom

# Terminal B (in a different window)
bin/shell
root@rover:/$ ros2 topic pub /cmd_vel geometry_msgs/msg/Twist "{linear: {x: 0.3}}" -r 10
```

## All commands

Just shell scripts in `bin/`. Each is a few lines of `docker exec` — readable, no Makefile, no docker-compose.

| Script | What it does |
|---|---|
### Infrastructure
| Script | What it does |
|---|---|
| `bin/sync` | pull/update `linorobot2` + `linorobot2_hardware` into `ext/` |
| `bin/build` | `docker build` the image |
| `bin/up` | start the container (foxglove bridge auto-starts on port 8765) |
| `bin/down` | stop and remove the container (named volumes persist) |
| `bin/shell` | open interactive ROS2 shell inside the container |
| `bin/status` | container + foxglove + sim status |
| `bin/ws-build` | build linorobot2 inside container (auto-runs `bin/patch-nav-yaml`) |
| `bin/patch-nav-yaml` | tighten inflation + add depth-cloud observation source (idempotent) |
| `bin/nuke` | wipe container, image, volumes, `ext/`, `maps/` (keeps `workspace/`) |

### Sim + sensors
| Script | What it does |
|---|---|
| `bin/sim` | launch Gazebo + linorobot2 sim, headless (default world=`playground`; override `WORLD=...`) |
| `bin/sim-stop` | stop the sim (container stays up) |
| `bin/sim-log` | tail the sim's log |
| `bin/topics` | `ros2 topic list` |
| `bin/drive` | publish `/cmd_vel` for 4 s — forward + turn |

### Navigation
| Script | What it does |
|---|---|
| `bin/slam` | launch SLAM + Nav2 alongside the running sim |
| `bin/save-map <name>` | save current SLAM map to `maps/<name>.{pgm,yaml}` |
| `bin/nav <name>` | launch Nav2 with a saved map |
| `bin/nav-stop` | stop SLAM/Nav stack (sim + foxglove stay) |
| `bin/wander [N] [max_r]` | send N random reachable goals via Nav2 |

## Daily flow (after first-time setup)

```bash
bin/up         # if container isn't running
bin/sim        # launch sim
# poke around in Foxglove
bin/sim-stop   # when done
bin/down       # if you want to stop the container
```

## Sim verification (locomotion + navigation)

The locomotion + Nav2 sim is validated end-to-end. To reproduce from a
running container (~5 min):

```bash
bin/sim                                 # playground world
docker exec -t rover bash -lc \
  'source /opt/ros/jazzy/setup.bash && python3 /ws/overlay/test_odom_closure.py'
bin/slam                                # SLAM + Nav2
docker exec -t rover bash -lc \
  'source /opt/ros/jazzy/setup.bash && python3 /ws/overlay/bounded_coverage.py 120'
bin/save-map playground                 # -> maps/playground.{pgm,yaml}
bin/nav-stop && sleep 3
bin/nav playground
docker exec -t rover bash -lc \
  'source /opt/ros/jazzy/setup.bash && python3 /ws/overlay/init_amcl.py'
sleep 3
bin/wander 4 1.2                        # 4 random goals within 1.2 m
```

Last verified results:

- **Odometry closure:** 1m-square drive → 1.2 cm closure error, 1.34° yaw
  drift over the 4 m perimeter (0.3%). Confirms `/odom` topology, EKF fusion,
  `/cmd_vel` reach, frame consistency. (PID tuning is N/A in sim — Gazebo's
  diff-drive plugin takes wheel velocities directly; the linorobot2 PID lives
  in firmware for real hardware only.)
- **Nav2 goal:** (1.5, 0.0) from (-0.27, -0.09) → `status=4` SUCCESS, 9
  recovery behaviors fired (spin/backup/wait) before success — BT working.
- **Wander:** 4/4 random goals SUCCESS.

Two sim-specific tuning changes (applied automatically by `bin/patch-nav-yaml`,
which `bin/ws-build` runs after every workspace build, since `ext/` is
re-fetched on `bin/sync`):

- Default world is `playground`, not `turtlebot3_world` (the latter's central
  pillar makes small-world planning fail under safe inflation).
- `inflation_radius` 0.7 → 0.25 m, and `/camera/depth/color/points` added as a
  2nd costmap observation source (catches off-LIDAR-plane obstacles).

## Layout

```
.
├── Dockerfile              # ROS2 Jazzy + Gazebo + Nav2 + slam_toolbox + foxglove_bridge
├── .env.example
├── bin/                    # shell scripts (sync, build, up, down, sim, …)
├── ext/                    # external repos (gitignored, populated by bin/sync)
├── workspace/              # mounted into /ws/overlay; checked-in helpers
│   ├── sim-stop.sh
│   ├── status.sh
│   └── foxglove-layout-v5.json   # versioned (rename to -v6 etc. when content changes — Foxglove caches by filename)
└── maps/                   # SLAM maps land here (gitignored except .gitkeep)
```

## Foxglove

**Web:** https://app.foxglove.dev → Open Connection → `ws://localhost:8765`
**Desktop:** Foxglove Studio → Open Connection → Foxglove WebSocket → `ws://localhost:8765`

> `foxglove_bridge` 3.2.x uses subprotocol `foxglove.sdk.v1` (not the older `foxglove.websocket.v1`). Foxglove handles this automatically; only matters for custom WebSocket clients.

### Importing the preset layout

Current: `workspace/foxglove-layout-v5.json`.

It pre-configures:
- 3D panel: robot URDF from `/robot_description` topic + grid + `/scan` (LIDAR) + big yellow TF axes + camera follow `base_link`
- Image panel: `/camera/color/image_raw`
- Raw messages panel: `/odom` position

To load: Foxglove → **Layouts** (left sidebar) → **Import from file** → pick `workspace/foxglove-layout-v5.json`.

> **Cache-busting:** Foxglove caches imported layouts by filename. When the content of this file changes, the version suffix is bumped (`-v6.json`, `-v7.json`, …) so Foxglove treats it as a fresh layout instead of using the cached version.

### URDF rendering — what to expect

The robot renders as **simple boxes and cylinders, not detailed meshes**. This is a linorobot2 default — `2wd_properties.urdf.xacro` has `base_mesh_file=""` and the `.dae` mesh lines are commented out. You see:

- Red box = chassis (`base_link`)
- Pink top deck
- Green cylinders = wheels
- Small dark box = LIDAR mount
- TF axes overlaid on every link (red=X, green=Y, blue=Z arrows)

For prettier rendering, uncomment the mesh-file lines in `ext/linorobot2/linorobot2_description/urdf/2wd_properties.urdf.xacro` and `bin/ws-build` again — `foxglove_bridge` already has `asset_uri_allowlist` configured to serve the `.dae` files.

### URDF gotcha (load-bearing)

For the URDF layer to actually fetch the URDF data from the topic, the topic must be **enabled** (visible) in the 3D panel's Topics list. If `/robot_description` is hidden, the URDF layer shows "Invalid topic" — even though the topic exists.

`v5.json` sets `topics["/robot_description"].visible = true` explicitly. If you build a layout from scratch, you must enable `/robot_description` in the Topics section of the 3D panel for the robot to appear.

If you ever see "Invalid topic: /robot_description":
1. Open the 3D panel's Panel settings
2. Scroll to **Topics** section
3. Find `/robot_description` — click its eye icon to make it visible
4. URDF renders within a second

## What `bin/sim` gives you

When the sim is running these topics are live:

| Topic | Type | Notes |
|---|---|---|
| `/scan` | `sensor_msgs/LaserScan` | 360° LIDAR, 364 readings |
| `/odom` | `nav_msgs/Odometry` | EKF-fused odometry |
| `/odom/unfiltered` | `nav_msgs/Odometry` | Raw wheel odometry |
| `/imu/data` | `sensor_msgs/Imu` | Simulated IMU |
| `/camera/color/image_raw` | `sensor_msgs/Image` | RGB camera |
| `/camera/depth/image_rect_raw` | `sensor_msgs/Image` | Depth camera |
| `/camera/depth/color/points` | `sensor_msgs/PointCloud2` | Depth point cloud |
| `/cmd_vel` | `geometry_msgs/Twist` | Drive commands (publish here to move the robot) |
| `/tf`, `/tf_static` | `tf2_msgs/TFMessage` | Robot transforms |
| `/robot_description` | `std_msgs/String` | URDF |
| `/joint_states` | `sensor_msgs/JointState` | Joint angles |
| `/clock` | `rosgraph_msgs/Clock` | Sim time |

## Driving the robot

```bash
bin/drive                                            # canned 4-second forward+turn

# Or from a bin/shell:
ros2 run teleop_twist_keyboard teleop_twist_keyboard # interactive keyboard
ros2 topic pub /cmd_vel geometry_msgs/msg/Twist \
  "{linear: {x: 0.5}, angular: {z: 0.0}}" -r 10
```

## What persists, what doesn't

Across `bin/down` + `bin/up`:

| State | Where | Persists? |
|---|---|---|
| linorobot2 source (`ext/`) | host directory | ✅ |
| Your edits (`workspace/`) | host directory | ✅ |
| Saved SLAM maps (`maps/`) | host directory | ✅ |
| Workspace build artifacts (`/ws/install`, etc.) | named Docker volumes | ✅ |
| Container itself | removed on `bin/down` | ❌ (recreated on `bin/up`) |
| Running processes (sim, etc.) | inside container | ❌ |

`bin/nuke` removes everything including the named volumes.

## Mac / Docker Desktop notes

- **No USB pass-through.** Real Pi Pico / LIDAR / OAK-D can't connect from Mac Docker. Use sim. For real hardware run on the Pi itself or a Linux box.
- **Gazebo runs headless** (`gui:=false`) — no Gazebo GUI window on Mac. View robot state via Foxglove instead.
- **Performance:** sim on Apple Silicon under Docker is fine for learning, slow for precise dynamics work.

## Gotchas (captured here so they don't bite twice)

1. **`foxglove_bridge` 3.2.x subprotocol is `foxglove.sdk.v1`**, not the older `foxglove.websocket.v1`. Foxglove web/desktop handle this automatically.
2. **`pkill -f PATTERN` inside `docker exec` can kill its own parent shell** if `PATTERN` appears in the shell's command line. `bin/sim-stop` and `bin/status` work around this by invoking helper scripts (`workspace/sim-stop.sh`, `workspace/status.sh`) so the pattern strings don't appear in the parent command.
3. **`rosdep` on Ubuntu 24.04 needs `PIP_BREAK_SYSTEM_PACKAGES=1`** (PEP 668). `bin/ws-build` sets this automatically.
4. **`turtlesim` won't run** in this container (Qt needs a display). Doesn't matter — view via Foxglove.
5. **The launch file is `linorobot2_gazebo/gazebo.launch.py`** — there is no `sim.launch.py`.
6. **`gz sim` processes show up as `gz sim ...` in `ps`** (not `ruby ...`). The kill-by-filename pattern `turtlebot3_world.sdf` matches them reliably.
7. **Foxglove Web URDF rendering is unreliable** for fetching `.dae`/`.stl` mesh files via `package://` URLs. Desktop is fine. LIDAR / odom / camera visualization works on both.
9. **linorobot2 ships with URDF meshes disabled** — `2wd_properties.urdf.xacro` sets `base_mesh_file=""`. The robot renders as primitive boxes/cylinders by default, not the nicer `.dae` meshes. Uncomment the `mesh_file` xacro properties in `ext/linorobot2/linorobot2_description/urdf/2wd_properties.urdf.xacro` to enable meshes, then `bin/ws-build`.
10. **The URDF layer in Foxglove must have `sourceType: "topic"` with `topic: "/robot_description"`** — the parameter source (`sourceType: "param"`) doesn't read from live `/robot_state_publisher` and shows "Invalid parameter". The topic source schema is what Foxglove's own Nav2 reference layout uses.
11. **The URDF topic must also be enabled in the 3D panel's Topics list** (`topics["/robot_description"].visible = true` in the layout JSON). Without this, Foxglove's URDF layer says "Invalid topic" even though the topic exists. This is the most subtle and most likely-to-bite gotcha.
8. **`bin/nuke` preserves `workspace/`** — it contains checked-in helper scripts (`sim-stop.sh`, `status.sh`, `foxglove-layout-vN.json`). Earlier versions wiped it accidentally.

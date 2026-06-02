#!/usr/bin/env bash
# Helper for bin/nav-stop. Kill nav stack processes (not the sim).
set +e
PATTERNS=(
  "linorobot2_navigation"
  "slam_toolbox/async_slam_toolbox_node"
  "slam_toolbox/sync_slam_toolbox_node"
  "nav2_controller"
  "nav2_planner"
  "nav2_bt_navigator"
  "nav2_behavior_server"
  "nav2_smoother_server"
  "nav2_waypoint_follower"
  "nav2_velocity_smoother"
  "nav2_amcl"
  "nav2_map_server"
  "nav2_lifecycle_manager"
  "nav2_collision_monitor"
)
for pat in "${PATTERNS[@]}"; do
  for p in $(pgrep -f "$pat"); do kill "$p" 2>/dev/null; done
done
sleep 2
for pat in "${PATTERNS[@]}"; do
  for p in $(pgrep -f "$pat"); do kill -9 "$p" 2>/dev/null; done
done
echo "nav stack stopped"

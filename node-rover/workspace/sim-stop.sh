#!/usr/bin/env bash
# Helper for bin/sim-stop. Lives outside the kill command so its own
# command line doesn't match the patterns being killed.
set +e

PATTERNS=(
  "ros2 launch linorobot2_gazebo"
  "ros_gz_bridge/parameter_bridge"
  "linorobot2_gazebo/command_timeout"
  "ros_gz_sim/create"
  "ekf_node"
  "robot_state_publisher"
  "turtlebot3_world.sdf"
  "playground.sdf"
  "linorobot2_gazebo/share/linorobot2_gazebo"
)

for pat in "${PATTERNS[@]}"; do
  for p in $(pgrep -f "$pat"); do kill "$p" 2>/dev/null; done
done

sleep 2

for pat in "${PATTERNS[@]}"; do
  for p in $(pgrep -f "$pat"); do kill -9 "$p" 2>/dev/null; done
done

echo "sim stopped"

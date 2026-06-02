#!/usr/bin/env bash
# Helper for bin/status. Runs inside the container.
# Patterns checked here must not appear in the parent docker exec command line.
echo -n "foxglove bridge: "
pgrep -x foxglove_bridge >/dev/null && echo "running" || echo "NOT running"
echo -n "sim (gazebo):    "
pgrep -f "linorobot2_gazebo/share/linorobot2_gazebo/worlds" >/dev/null && echo "running" || echo "stopped"

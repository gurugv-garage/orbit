#!/usr/bin/env bash
# repro-restart.sh — hammer the RESTART path: force-stop the app, relaunch, wait for the
# producer, then address + speak and check it actually got a turn. This is the loop that
# caught the post-restart no-STT bug (~50% break rate; see docs/rca/).
#
# Usage: repro-restart.sh [cycles]   (default 6)
set -uo pipefail
source "$(dirname "$0")/lib.sh"
N="${1:-6}"
ok=0; broke=0
echo "=== RESTART REPRO: $N cycles (dock=$DOCK) ==="
for i in $(seq 1 "$N"); do
  relaunch 8
  wait_producer 20 || echo "  (cycle $i: producer never reported audio)"
  sleep 5                                  # small settle; a user would glance then talk
  shot "restart-$i-before"                 # screenshot: validate mic/glow state visually
  if trial "What is eight plus one?" 0.6; then ok=$((ok+1)); r=OK; else broke=$((broke+1)); r=BROKEN; fi
  printf '  cycle %d: %s\n' "$i" "$r"
  sleep 2
done
echo "================ RESTART REPRO: OK=$ok/$N  BROKEN=$broke/$N ================"
echo "(screenshots in $SHOTDIR/restart-*-before.png — confirm the on-screen state MATCHES the result)"

#!/usr/bin/env bash
# probe-window-edge.sh — probe the listening-WINDOW timing edge: speak at increasing
# delays after the tap, so some attempts land inside the window and some after it expires.
# Distinguishes the two failure classes the RCA separated:
#   - in-window but dropped  → an addressed-decision RACE (a real bug)
#   - spoke after expiry      → correctly not-addressed (expected; UI was NOT listening)
# Each trial prints the before-state (mode + secs left) so you can tell which case it is.
#
# Usage: probe-window-edge.sh [reps_per_delay]   (default 3)
set -uo pipefail
source "$(dirname "$0")/lib.sh"
REPS="${1:-3}"
DELAYS=(0.5 3 6 9)   # 0.5/3 in-window; 6 near edge; 9 after expiry (LISTEN_MS ~8s)

for d in "${DELAYS[@]}"; do
  echo "===== delay ${d}s after tap ($REPS reps) ====="
  for _ in $(seq 1 "$REPS"); do
    wait_idle 20 || true
    trial "What is three plus three?" "$d"
    sleep 2
  done
done
echo "Interpretation: a trial whose before-state shows 'listening Ns' (N>0) but DECISION="
echo "skip:not-addressed is the in-window RACE bug. 'idle 0s' + skip = expected (expired)."

#!/usr/bin/env bash
# Interactive body tester — drives the dock body THROUGH ORBIT-STATION.
#
# Since the server-brain cutover the firmware has no WS server: the station's
# motion executor is the single master, and this script just talks to its REST
# surface (orbit-station/server/src/modules/bodylink/). The same path the
# brain's move/gesture tools and the console sliders use.
#
#   POST /api/bodylink/command   { dock, parts:{<part>:{pulse_width_us,duration_ms}} }
#   GET  /api/bodylink/state?dock=
#   GET  /api/bodylink/profile?dock=
#
# Usage:
#   scripts/test_body.sh                              # station http://localhost:8099, dock anne-bot
#   scripts/test_body.sh http://192.168.1.17:8099 anne-bot
#   STATION=http://... DOCK=... scripts/test_body.sh

set -euo pipefail

STATION="${1:-${STATION:-http://localhost:8099}}"
DOCK="${2:-${DOCK:-anne-bot}}"
BASE="$STATION/api/bodylink"

say()  { printf '%s\n' "$*"; }
post() { curl -s -X POST "$BASE/command" -H 'content-type: application/json' -d "$1" | head -c 400; echo; }

move() { # move <part> <us> [duration_ms]
  local part="$1" us="$2" dur="${3:-400}"
  post "{\"dock\":\"$DOCK\",\"parts\":{\"$part\":{\"pulse_width_us\":$us,\"duration_ms\":$dur}}}"
}

say "station: $STATION   dock: $DOCK"
say "profile: $(curl -s "$BASE/profile?dock=$DOCK" | head -c 300)"
say ""
say "commands:  neck <us> | foot <us> | home | oor | state | profile | help | quit"
say "           (center = 1500µs; neck range ≈ 833–1888, foot 500–2500)"

while true; do
  read -r -p "> " cmd arg1 arg2 || break
  case "$cmd" in
    neck|foot) if [ -n "${arg1:-}" ]; then move "$cmd" "$arg1" "${arg2:-400}"; else say "usage: $cmd <us> [ms]"; fi ;;
    home)      post "{\"dock\":\"$DOCK\",\"parts\":{\"neck\":{\"pulse_width_us\":1500,\"duration_ms\":600},\"foot\":{\"pulse_width_us\":1500,\"duration_ms\":600}}}" ;;
    oor)       move neck 9999 200 ;;   # exercise the clamp path (station + firmware)
    state)     curl -s "$BASE/state?dock=$DOCK" | python3 -m json.tool ;;
    profile)   curl -s "$BASE/profile?dock=$DOCK" | python3 -m json.tool ;;
    help)      say "neck/foot <us> [ms] · home · oor (clamp test) · state · profile · quit" ;;
    quit|exit) break ;;
    "")        ;;
    *)         say "? try: help" ;;
  esac
done

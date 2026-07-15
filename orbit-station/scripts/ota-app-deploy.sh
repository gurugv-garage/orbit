#!/usr/bin/env bash
# Deploy the dock app over OTA — build, stage, announce, confirm installed.
#
# Exists because doing this by hand fails silently in three different ways, each
# of which looks exactly like "the code is broken":
#
#  1. STAGE RACE — POST /build returns when the build STATE leaves `building`,
#     but the artifact + meta.json land a moment later. Reading /latest right
#     after returns the PREVIOUS build. (sleep 3 and sleep 6 both raced; poll.)
#  2. ZERO PEERS — announce returns {"announced":0} when the dock is offline or,
#     the common case, mid-install of the previous build with its socket dropped.
#     The station reports that as SUCCESS. Nothing installs. Hit 3x in one day.
#  3. SAME versionCode — the OTA gate. A rebuild at an unchanged versionCode
#     offers nothing and installs nothing.
#
# Usage:  ./scripts/ota-app-deploy.sh <expectedVersionCode> [dock]
# Example: ./scripts/ota-app-deploy.sh 47 dock-redmi
set -euo pipefail

WANT="${1:?usage: ota-app-deploy.sh <versionCode> [dock]}"
DOCK="${2:-dock-redmi}"
S="${STATION_HTTP:-http://localhost:8099}"

build_of_dock() {
  curl -s --max-time 5 "$S/api/docks" 2>/dev/null | python3 -c "
import sys,json
d=json.load(sys.stdin)
b=[c.get('build') for x in d for c in x['components']
   if c['component']=='phone' and c.get('online')]
print(b[0] if b else '')" 2>/dev/null
}
offered() {
  curl -s --max-time 5 "$S/api/ota/app/latest" 2>/dev/null \
    | python3 -c "import sys,json;print(json.load(sys.stdin).get('build',''))" 2>/dev/null
}
build_state() {
  curl -s --max-time 5 "$S/api/ota" 2>/dev/null | python3 -c "
import sys,json
d=json.load(sys.stdin)
print([t['build']['state'] for t in d['targets'] if t['target']=='app'][0])" 2>/dev/null
}

echo "→ building app (want versionCode $WANT)"
curl -s --max-time 30 -X POST "$S/api/ota/app/build" >/dev/null

echo "→ waiting for the build to finish"
until [ "$(build_state)" != "building" ]; do sleep 10; done

# (1) STAGE RACE: poll for the artifact, never sleep-and-hope.
echo "→ waiting for the artifact to stage"
for _ in $(seq 1 12); do
  [ "$(offered)" = "$WANT" ] && break
  sleep 5
done
GOT="$(offered)"
if [ "$GOT" != "$WANT" ]; then
  echo "✗ station offers '$GOT', wanted '$WANT' — did versionCode get bumped? (see gate #3)"
  tail -6 "$(dirname "$0")/../var/ota/app/build-$WANT.log" 2>/dev/null || true
  exit 1
fi
echo "✓ staged: $GOT"

# (2) ZERO PEERS: the dock must be ONLINE before the offer, or nobody hears it.
echo "→ waiting for the dock to be online (it may be mid-install of the last build)"
for _ in $(seq 1 30); do
  b="$(build_of_dock)"; [ -n "$b" ] && break
  sleep 5
done
[ -n "$(build_of_dock)" ] || { echo "✗ dock offline — nothing to announce to"; exit 1; }

for attempt in 1 2 3; do
  RESP="$(curl -s -X POST "$S/api/ota/app/announce")"
  echo "  announce#$attempt: $RESP"
  echo "$RESP" | grep -q '"announced":0' || break
  echo "  ↳ ZERO PEERS heard it (socket dropped?) — retrying in 15s"
  sleep 15
done
echo "$RESP" | grep -q '"announced":0' && { echo "✗ nobody ever heard the offer"; exit 1; }

echo "→ waiting for the dock to come back on $WANT"
for _ in $(seq 1 45); do
  [ "$(build_of_dock)" = "$WANT" ] && { echo "✓ DOCK ON $WANT"; exit 0; }
  sleep 10
done
echo "✗ timeout — dock still on $(build_of_dock)"
exit 1

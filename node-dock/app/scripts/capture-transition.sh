#!/usr/bin/env bash
# Record an expression-transition reel by triggering setFace via the
# debug bar and screenshotting mid-tween. Outputs face_versions/<name>/
# t000.png … t360.png so you can step through the transition frames.
#
# Usage:
#   ./scripts/capture-transition.sh v14_unified_tween-happy-to-angry happy angry
#
# Requires: dev.orbit.dock installed, emulator-5554 booted with permissions.

set -euo pipefail
ADB="${ADB:-$HOME/Library/Android/sdk/platform-tools/adb}"
DEV="${DEVICE:-emulator-5554}"
NAME="${1:?name required, e.g. v14_happy_to_angry}"
FROM="${2:-neutral}"
TO="${3:-happy}"

DEST="$(cd "$(dirname "$0")/.." && pwd)/face_versions/$NAME"
mkdir -p "$DEST"

step() { printf "\033[1;36m[transition]\033[0m %s\n" "$*"; }

step "launching dock..."
$ADB -s "$DEV" shell am force-stop dev.orbit.dock
$ADB -s "$DEV" shell am start -n dev.orbit.dock/.MainActivity >/dev/null
sleep 4

step "warming up to FROM=$FROM"
$ADB -s "$DEV" shell input tap 540 1900
sleep 0.4
$ADB -s "$DEV" shell input text "set%sface%s$FROM" >/dev/null
sleep 0.3
$ADB -s "$DEV" shell input keyevent KEYCODE_ENTER
sleep 18

step "triggering FROM -> TO ($TO) and capturing frames"
$ADB -s "$DEV" shell input tap 540 1900
sleep 0.4
$ADB -s "$DEV" shell input text "act%s$TO" >/dev/null
sleep 0.3
$ADB -s "$DEV" shell input keyevent KEYCODE_ENTER

# Capture every ~40 ms during the 280 ms tween + a few before/after.
for ms in 000 040 080 120 160 200 240 280 320 400 600 1200; do
    sleep 0.04
    $ADB -s "$DEV" shell screencap -p > "$DEST/t${ms}.png"
done
step "saved $DEST"
ls -la "$DEST"

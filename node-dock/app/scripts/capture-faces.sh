#!/usr/bin/env bash
# Capture the FaceGalleryActivity into face_versions/<v>/gallery.png
# on a chosen device (defaults to the emulator).
#
# Usage:
#   ./scripts/capture-faces.sh v0_baseline                 # to emulator
#   ./scripts/capture-faces.sh v3_eyebrows emulator-5554
#   DEVICE=192.168.1.3:35093 ./scripts/capture-faces.sh v5_polish

set -euo pipefail

VERSION="${1:-untagged}"
DEVICE="${2:-${DEVICE:-emulator-5554}}"
ADB="${ADB:-$HOME/Library/Android/sdk/platform-tools/adb}"

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT_DIR="$ROOT/face_versions/$VERSION"
mkdir -p "$OUT_DIR"

step() { printf "\033[1;36m[capture]\033[0m %s\n" "$*"; }

step "device=$DEVICE  out=$OUT_DIR"
"$ADB" -s "$DEVICE" devices >/dev/null

step "force-stop + launch FaceGalleryActivity"
"$ADB" -s "$DEVICE" shell am force-stop dev.orbit.dock || true
"$ADB" -s "$DEVICE" shell am start -n dev.orbit.dock/.FaceGalleryActivity >/dev/null
sleep 3

step "screencap"
"$ADB" -s "$DEVICE" shell screencap -p > "$OUT_DIR/gallery.png"

# Quick sanity: non-zero size
SIZE=$(stat -f%z "$OUT_DIR/gallery.png" 2>/dev/null || stat -c%s "$OUT_DIR/gallery.png")
step "saved $OUT_DIR/gallery.png (${SIZE} bytes)"

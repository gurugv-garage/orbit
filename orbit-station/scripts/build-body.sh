#!/usr/bin/env bash
# OTA build hook — node-dock body (ESP32). docs/OTA.md §2.3.
#
# Runs in a tmux session launched by the ota module (so you can `tmux attach -t
# ota-build-body` and watch/debug live). Builds the firmware, copies the .bin
# into the station's artifact store, and writes built.json {build, version}
# parsed from include/version.h — the SINGLE source of truth (§3.2), so the
# artifact's recorded version can never disagree with the running binary.
#
# This hook is the ONLY thing that touches PlatformIO. A toolchain-less station
# host skips it and hand-drops the .bin + built.json instead (§0.2).
set -euo pipefail

# orbit-station/scripts/ -> repo root
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
FW_DIR="$ROOT/node-dock/body-firmware/dock_body_v0"
OUT_DIR="$ROOT/orbit-station/var/ota/body"
VERSION_H="$FW_DIR/include/version.h"
BIN_SRC="$FW_DIR/.pio/build/seeed_xiao_esp32s3/firmware.bin"

PIO="${PIO:-$HOME/.platformio/penv/bin/pio}"

echo "== ota build: body =="
echo "firmware:   $FW_DIR"
echo "pio:        $PIO"

# Parse the two version notions from version.h (docs/OTA.md §3.2).
BUILD="$(grep -E '#define[[:space:]]+BL_FW_BUILD' "$VERSION_H" | grep -oE '[0-9]+' | head -1)"
VERSION="$(grep -E '#define[[:space:]]+BL_FW_VERSION' "$VERSION_H" | sed -E 's/.*"([^"]+)".*/\1/')"
if [[ -z "$BUILD" || -z "$VERSION" ]]; then
  echo "!! could not parse BL_FW_BUILD / BL_FW_VERSION from $VERSION_H" >&2
  exit 2
fi
echo "build:      $BUILD"
echo "version:    $VERSION"

echo "== pio run =="
( cd "$FW_DIR" && "$PIO" run )

if [[ ! -f "$BIN_SRC" ]]; then
  echo "!! firmware.bin not found at $BIN_SRC after build" >&2
  exit 3
fi

mkdir -p "$OUT_DIR"
cp "$BIN_SRC" "$OUT_DIR/firmware.bin"
# The station's recordFromArtifact() recomputes sha256 + size from the copied
# .bin; we just hand it the build/version it can't infer from bytes.
cat > "$OUT_DIR/built.json" <<EOF
{ "build": $BUILD, "version": "$VERSION" }
EOF

echo "== done: firmware.bin ($(wc -c < "$OUT_DIR/firmware.bin") bytes), build $BUILD =="

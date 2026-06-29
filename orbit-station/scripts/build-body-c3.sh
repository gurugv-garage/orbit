#!/usr/bin/env bash
# OTA build hook — node-dock body, ESP32-C3 variant. docs/OTA.md §2.3.
#
# Same firmware source as build-body.sh, built for the C3 (RISC-V) env instead
# of the S3 (Xtensa) env. The two binaries are NOT interchangeable, so they are
# separate OTA targets (body vs body-c3); a C3 only ever pulls this artifact.
# Mirrors build-body.sh exactly except for the PlatformIO env + the out dir.
set -euo pipefail

# orbit-station/scripts/ -> repo root
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
FW_DIR="$ROOT/node-dock/body-firmware/dock_body_v0"
OUT_DIR="$ROOT/orbit-station/var/ota/body-c3"
VERSION_H="$FW_DIR/include/version.h"
PIO_ENV="esp32c3_mini"
BIN_SRC="$FW_DIR/.pio/build/$PIO_ENV/firmware.bin"

PIO="${PIO:-$HOME/.platformio/penv/bin/pio}"

echo "== ota build: body-c3 =="
echo "firmware:   $FW_DIR"
echo "pio env:    $PIO_ENV"
echo "pio:        $PIO"

# Parse the two version notions from version.h (docs/OTA.md §3.2). build/version
# are shared with the S3 image — it's the same source — but the artifact (and its
# sha256) differs per arch, which is exactly why they're separate targets.
BUILD="$(grep -E '#define[[:space:]]+BL_FW_BUILD' "$VERSION_H" | grep -oE '[0-9]+' | head -1)"
VERSION="$(grep -E '#define[[:space:]]+BL_FW_VERSION' "$VERSION_H" | sed -E 's/.*"([^"]+)".*/\1/')"
if [[ -z "$BUILD" || -z "$VERSION" ]]; then
  echo "!! could not parse BL_FW_BUILD / BL_FW_VERSION from $VERSION_H" >&2
  exit 2
fi
echo "build:      $BUILD"
echo "version:    $VERSION"

echo "== pio run -e $PIO_ENV =="
( cd "$FW_DIR" && "$PIO" run -e "$PIO_ENV" )

if [[ ! -f "$BIN_SRC" ]]; then
  echo "!! firmware.bin not found at $BIN_SRC after build" >&2
  exit 3
fi

mkdir -p "$OUT_DIR"
cp "$BIN_SRC" "$OUT_DIR/firmware.bin"
# recordFromArtifact() recomputes sha256 + size from the copied .bin; we just
# hand it the build/version it can't infer from bytes.
cat > "$OUT_DIR/built.json" <<EOF
{ "build": $BUILD, "version": "$VERSION" }
EOF

echo "== done: firmware.bin ($(wc -c < "$OUT_DIR/firmware.bin") bytes), build $BUILD =="

#!/usr/bin/env bash
# Fetch large model assets that are gitignored (too big to commit).
# Idempotent — skips files that already exist.
#
# Run once after cloning the repo:
#   ./scripts/fetch-models.sh

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DST="$ROOT/app/src/main/assets/models"
mkdir -p "$DST"

step() { printf "\033[1;36m[fetch-models]\033[0m %s\n" "$*"; }

# FER+ (Microsoft) — 8-class facial emotion classifier, 64x64 grayscale.
# Drives the dock's passive emotion mirroring (drop in PerceptionWiring).
FER_URL="https://github.com/onnx/models/raw/main/validated/vision/body_analysis/emotion_ferplus/model/emotion-ferplus-8.onnx"
FER_DST="$DST/emotion_ferplus.onnx"
if [ -f "$FER_DST" ] && [ "$(stat -f%z "$FER_DST" 2>/dev/null || stat -c%s "$FER_DST")" -gt 1000000 ]; then
    step "skip emotion_ferplus.onnx (already present, $(du -h "$FER_DST" | cut -f1))"
else
    step "downloading FER+ (~35 MB)..."
    curl -fL --progress-bar -o "$FER_DST" "$FER_URL"
    step "saved $FER_DST"
fi

step "done"

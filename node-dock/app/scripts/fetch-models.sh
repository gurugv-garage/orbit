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

# (FER+ emotion model retired — the station's face-api reads emotion from the SFU
#  stream now; see docs/decision-traces/thin-client-consolidation.md.)

# MediaPipe Gesture Recognizer (Google) — on-device hand-gesture model bundle.
# Ships trained gestures (Open_Palm, Victory, Thumb_Up, …); we use Open_Palm +
# horizontal hand-oscillation to detect a wave. Drives WaveDetector.
GESTURE_URL="https://storage.googleapis.com/mediapipe-models/gesture_recognizer/gesture_recognizer/float16/1/gesture_recognizer.task"
GESTURE_DST="$DST/gesture_recognizer.task"
if [ -f "$GESTURE_DST" ] && [ "$(stat -f%z "$GESTURE_DST" 2>/dev/null || stat -c%s "$GESTURE_DST")" -gt 1000000 ]; then
    step "skip gesture_recognizer.task (already present, $(du -h "$GESTURE_DST" | cut -f1))"
else
    step "downloading MediaPipe Gesture Recognizer (~8 MB)..."
    curl -fL --progress-bar -o "$GESTURE_DST" "$GESTURE_URL"
    step "saved $GESTURE_DST"
fi

step "done"

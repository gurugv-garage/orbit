#!/usr/bin/env bash
# say.sh — the driver's MOUTH. Speaks a line out the laptop speaker so the production
# dock's mic hears it acoustically (a real, across-the-room utterance). The dock then
# runs a real turn on it. Logs the line + timestamp.
#
# Usage: say.sh "the line to speak" [voice] [rate]
set -euo pipefail
LINE="${1:?usage: say.sh \"text\" [voice] [rate]}"
VOICE="${2:-Samantha}"     # a clear US English voice
RATE="${3:-175}"            # words/min — natural pace
LOG="${TWODOCK_LOG:-/tmp/two-dock.log}"

echo "$(date +%H:%M:%S) DRIVER→ $LINE" | tee -a "$LOG"
# A short lead silence so the dock's VAD catches the onset, then speak.
say -v "$VOICE" -r "$RATE" "$LINE"
echo "$(date +%H:%M:%S) (spoken)" >> "$LOG"

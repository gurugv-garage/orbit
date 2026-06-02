#!/usr/bin/env bash
# STT smoke test: speak a phrase via host TTS while the dock app is
# running, then check logcat for a corresponding Transcript event.
#
# Requirements:
#   - emulator already running (adb devices shows a device)
#   - app installed
#   - Extended Controls → Microphone → "Enable Host Microphone Access" ON
#   - macOS has granted Android Studio Microphone permission
#
# Optional (cleaner — bypasses acoustic loopback):
#   - BlackHole or Loopback installed; macOS default Mic Input set to it
#   - This lets us pipe `afplay` audio directly into the mic stream
#
# Usage:
#   ./scripts/stt-smoke.sh                       # default phrase
#   ./scripts/stt-smoke.sh "what is two plus two"
#
# Exit codes: 0 = transcript matched expected words; 1 = no transcript;
#             2 = adb / device missing; 3 = app not running

set -euo pipefail

PHRASE="${1:-what is the capital of france}"
ADB="${ADB:-$HOME/Library/Android/sdk/platform-tools/adb}"
APP="${APP:-dev.orbit.dock}"
TIMEOUT_S="${TIMEOUT_S:-10}"

step() { printf "\033[1;36m[smoke]\033[0m %s\n" "$*"; }
warn() { printf "\033[1;33m[smoke]\033[0m %s\n" "$*" >&2; }
fail() { printf "\033[1;31m[smoke]\033[0m %s\n" "$*" >&2; exit "${2:-1}"; }

# 1. preconditions
[ -x "$ADB" ] || fail "adb not found at $ADB. Override with ADB=path" 2
DEVICE_LINE=$("$ADB" devices | sed -n '2p')
[ -n "$DEVICE_LINE" ] || fail "no device attached. Start the emulator first." 2

# 2. ensure app is running
if ! "$ADB" shell pidof "$APP" >/dev/null 2>&1; then
    warn "app $APP not running — launching it"
    "$ADB" shell am start -n "$APP/.MainActivity" >/dev/null
    sleep 4
fi

# 3. start logcat capture
LOG=$(mktemp -t stt-smoke.XXXXX.log)
trap 'rm -f "$LOG"' EXIT
"$ADB" logcat -c
"$ADB" logcat -v time | tee "$LOG" >/dev/null &
LOGCAT_PID=$!
trap 'kill $LOGCAT_PID 2>/dev/null; rm -f "$LOG"' EXIT

# 4. trigger a wake — tap-wake equivalent via the speaker indicator (debug
#    builds) at coordinates that work on Pixel 3a landscape (2220x1080).
step "fake-wake to start STT"
"$ADB" shell input tap 555 1040 >/dev/null
sleep 0.5

# 5. speak the phrase through the host
step "speaking via macOS \`say\`: \"$PHRASE\""
say -v Samantha -r 175 "$PHRASE" &
SAY_PID=$!

# 6. wait for transcript
step "waiting up to ${TIMEOUT_S}s for a Transcript event…"
DEADLINE=$(($(date +%s) + TIMEOUT_S))
HEARD=""
while [ "$(date +%s)" -lt "$DEADLINE" ]; do
    if grep -E 'transcript: "[^"]+" final=' "$LOG" 2>/dev/null | tail -1 \
        | grep -oE 'transcript: "[^"]+"' | head -1 > /tmp/stt-smoke-heard 2>/dev/null; then
        HEARD=$(cat /tmp/stt-smoke-heard 2>/dev/null || echo "")
        if [ -n "$HEARD" ]; then break; fi
    fi
    sleep 0.3
done

wait "$SAY_PID" 2>/dev/null || true
kill "$LOGCAT_PID" 2>/dev/null || true

# 7. verify
if [ -z "$HEARD" ]; then
    warn "no transcript heard within ${TIMEOUT_S}s"
    warn ""
    warn "Diagnosis:"
    # Detect specific failure modes from logcat
    if grep -q 'NO_SPEECH_DETECTED\|agsa_transcription_NO_SPEECH' "$LOG" 2>/dev/null; then
        warn "  → SpeechRecognizer reported NO_SPEECH_DETECTED"
        warn "  → mic stream reached the API but contained silence"
        warn "  → root cause: Extended Controls → Microphone →"
        warn "    \"Enable Host Microphone Access\" is OFF, or macOS hasn't"
        warn "    granted Android Studio mic permission"
    elif grep -q 'LANGUAGE_PACK_ERROR\|ERROR_NETWORK' "$LOG" 2>/dev/null; then
        warn "  → SpeechRecognizer hit a service error"
        warn "  → root cause: Google STT language pack missing or network blocked"
        warn "  → fix: launch Google app on emulator once to provision STT"
    else
        warn "  → no STT events observed at all"
        warn "  → root cause: app might not be foregrounded, or fake-wake tap missed"
        warn "  → confirm app is on screen, then re-run"
    fi
    warn ""
    warn "Logcat tail:"
    tail -50 "$LOG" 2>/dev/null | grep -E 'RecognitionClient|DockApp|SpeechRecog|DockAgent|tool\.|transcript' || true
    exit 1
fi

step "heard: $HEARD"
# loose match — STT is lossy
LOWER_HEARD=$(echo "$HEARD" | tr '[:upper:]' '[:lower:]')
LOWER_PHRASE=$(echo "$PHRASE" | tr '[:upper:]' '[:lower:]')
# require at least 2 of the spoken words to appear
HITS=0
for word in $LOWER_PHRASE; do
    if echo "$LOWER_HEARD" | grep -qw "$word"; then HITS=$((HITS + 1)); fi
done
step "matched $HITS words from \"$PHRASE\""
if [ "$HITS" -ge 2 ]; then
    step "PASS"
    exit 0
fi
warn "FAIL: matched only $HITS words — STT may be misfiring"
exit 1

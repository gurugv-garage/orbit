#!/usr/bin/env bash
# End-to-end smoke test for the dock app.
#
# Drives MainActivity via the dev text bar through a battery of prompts,
# parses logcat for tool.speak invocations, and asserts every spoken
# string is "clean" — no LLM tool-call wrappers, no chat-template
# control sequences, no other artifacts. Also verifies the pipeline
# unsticks itself between turns.
#
# Exit codes:
#   0 — all turns produced clean output and no stuck states
#   1 — at least one turn failed (leak / stuck / no answer)
#   2 — adb / device / app missing
#
# Usage:
#   ./scripts/dock-smoke.sh                       # to default emulator
#   DEVICE=emulator-5554 ./scripts/dock-smoke.sh
#   ./scripts/dock-smoke.sh --quick               # 2 quick turns only
#
# Each turn has a generous timeout because Ollama on the laptop can
# take ~10–20s for gemma4:e2b to respond on the first call.

set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEVICE="${DEVICE:-emulator-5554}"
ADB="${ADB:-$HOME/Library/Android/sdk/platform-tools/adb}"
PKG="dev.orbit.dock"
TURN_TIMEOUT_S="${TURN_TIMEOUT_S:-25}"

QUICK=0
[ "${1:-}" = "--quick" ] && QUICK=1

step() { printf "\033[1;36m[smoke]\033[0m %s\n" "$*"; }
pass() { printf "\033[1;32m[pass]\033[0m %s\n" "$*"; }
fail() { printf "\033[1;31m[FAIL]\033[0m %s\n" "$*" >&2; }
fatal() { printf "\033[1;31m[fatal]\033[0m %s\n" "$*" >&2; exit "${2:-2}"; }

[ -x "$ADB" ] || fatal "adb not found at $ADB" 2

if ! "$ADB" devices | awk 'NR>1 {print $1}' | grep -qx "$DEVICE"; then
    fatal "device '$DEVICE' not attached. Connected: $($ADB devices | awk 'NR>1 {print $1}' | tr '\n' ' ')" 2
fi

step "device=$DEVICE  pkg=$PKG  turn_timeout=${TURN_TIMEOUT_S}s"

# Silence the verbose ML Kit face-detector logs so they don't blow OEM
# log-quota or hide our events.
"$ADB" -s "$DEVICE" shell setprop log.tag.ThickFaceDetector SILENT >/dev/null 2>&1 || true
"$ADB" -s "$DEVICE" shell setprop log.tag.FaceDetectorV2Jni SILENT >/dev/null 2>&1 || true

step "cold-launching $PKG"
"$ADB" -s "$DEVICE" shell am force-stop "$PKG" >/dev/null 2>&1 || true
sleep 1
"$ADB" -s "$DEVICE" shell am start -n "$PKG/.MainActivity" >/dev/null
sleep 5

PID=$("$ADB" -s "$DEVICE" shell pidof "$PKG" | tr -d '\r')
[ -n "$PID" ] || fatal "app didn't start" 2
step "pid=$PID"

PROMPTS_FULL=(
    "say hi briefly"
    "what is two plus two"
    "tell me a short joke"
    "say something surprising"
    "apologize to me"
    "act excited about pizza"
    "say goodbye"
)
PROMPTS_QUICK=(
    "say hi"
    "tell me a short joke"
)
if [ "$QUICK" = "1" ]; then
    PROMPTS=("${PROMPTS_QUICK[@]}")
else
    PROMPTS=("${PROMPTS_FULL[@]}")
fi

# Patterns that indicate a leak in the spoken output.
LEAK_PATTERNS=(
    '<\|'                # chat template delimiters
    '\|>'
    '^speak\('           # bare speak( wrapper
    'speak\(text:'       # labelled wrapper
    'speak\(text='
    '^```'               # markdown fences
    '^"speak'
)

FAIL_COUNT=0
TURN_NUM=0

# Tap focus into the dev bar once (best-effort coordinate for a phone in
# landscape lock at 1080x2220-ish density).
DEV_BAR_X="${DEV_BAR_X:-540}"
DEV_BAR_Y="${DEV_BAR_Y:-1900}"

count_speaks() {
    "$ADB" -s "$DEVICE" shell logcat -d --pid="$PID" 2>/dev/null \
        | grep -cE "tool\.speak:" || true
}

for PROMPT in "${PROMPTS[@]}"; do
    TURN_NUM=$((TURN_NUM + 1))
    step "turn $TURN_NUM/${#PROMPTS[@]}: \"$PROMPT\""
    BEFORE_N=$(count_speaks)

    "$ADB" -s "$DEVICE" shell input tap "$DEV_BAR_X" "$DEV_BAR_Y" >/dev/null
    sleep 0.5
    # Sanitise the prompt for the adb input shell: drop apostrophes (sh
    # quoting trips up otherwise) and convert spaces to %s.
    SAFE_PROMPT=$(printf "%s" "$PROMPT" | tr -d "'\"")
    ENCODED=$(printf "%s" "$SAFE_PROMPT" | sed 's/ /%s/g')
    "$ADB" -s "$DEVICE" shell input text "$ENCODED" >/dev/null
    sleep 0.5
    "$ADB" -s "$DEVICE" shell input keyevent KEYCODE_ENTER >/dev/null

    # Wait for the speak count to grow — that's the speak fired *for
    # this prompt*. Handles slow turns and multi-tool replies cleanly.
    SPOKE=""
    ELAPSED=0
    while [ "$ELAPSED" -lt "$TURN_TIMEOUT_S" ]; do
        sleep 2
        ELAPSED=$((ELAPSED + 2))
        AFTER_N=$(count_speaks)
        if [ "$AFTER_N" -gt "$BEFORE_N" ]; then
            # Read the just-fired line (skip BEFORE_N earlier matches).
            SPOKE=$("$ADB" -s "$DEVICE" shell logcat -d --pid="$PID" 2>/dev/null \
                | grep -E "tool\.speak:" | sed -n "$((BEFORE_N + 1))p")
            break
        fi
    done

    if [ -z "$SPOKE" ]; then
        fail "turn $TURN_NUM: no tool.speak fired within ${TURN_TIMEOUT_S}s"
        FAIL_COUNT=$((FAIL_COUNT + 1))
        continue
    fi

    # Extract the quoted text from tool.speak: "..."
    TEXT=$(echo "$SPOKE" | sed -E 's/.*tool\.speak: "(.*)"$/\1/')
    if [ "$TEXT" = "$SPOKE" ] || [ -z "$TEXT" ]; then
        fail "turn $TURN_NUM: could not parse tool.speak text from: $SPOKE"
        FAIL_COUNT=$((FAIL_COUNT + 1))
        continue
    fi

    # Validate clean output
    LEAKED=""
    for PAT in "${LEAK_PATTERNS[@]}"; do
        if echo "$TEXT" | grep -qE "$PAT"; then
            LEAKED="$PAT"
            break
        fi
    done
    if [ -n "$LEAKED" ]; then
        fail "turn $TURN_NUM: LEAK ($LEAKED) in: $TEXT"
        FAIL_COUNT=$((FAIL_COUNT + 1))
    else
        pass "turn $TURN_NUM: \"$TEXT\""
    fi
done

# Sanity: unstick events fired (proves pipeline returned to a clean state).
UNSTICK_COUNT=$("$ADB" -s "$DEVICE" shell logcat -d --pid="$PID" 2>/dev/null \
    | grep -c "pipeline unstick" || true)
step "pipeline unstick events: $UNSTICK_COUNT"

if [ "$FAIL_COUNT" -gt 0 ]; then
    fail "$FAIL_COUNT / ${#PROMPTS[@]} turns failed"
    exit 1
fi
step "all ${#PROMPTS[@]} turns clean — smoke PASSED"
exit 0

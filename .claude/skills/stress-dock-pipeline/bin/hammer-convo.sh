#!/usr/bin/env bash
# hammer-convo.sh — stress the LIVE conversation flow the way a real, messy human does:
# rapid back-to-back turns, disfluent "um/uh" lines, numbers, names, mid-conversation
# taps, and a barge-in (tap + speak while the dock is still replying). Runs the set
# REPEATEDLY (intermittent bugs only show over many reps), judging each via the trace.
#
# Usage: hammer-convo.sh [rounds]   (default 3)
set -uo pipefail
source "$(dirname "$0")/lib.sh"
ROUNDS="${1:-3}"

# Messy, realistic lines — disfluencies, numbers, names, topic shifts. Edit freely.
LINES=(
  "Hey, can you hear me?"
  "Um, what is, uh, seven plus eight?"
  "Remind Amma about the pooja tomorrow."
  "Wait, no, what time is it right now?"
  "Tell me a, um, a quick story about the moon."
  "Okay okay, never mind that — what's the capital of France?"
)

pass=0; fail=0
for r in $(seq 1 "$ROUNDS"); do
  echo "========== ROUND $r/$ROUNDS =========="
  for line in "${LINES[@]}"; do
    wait_idle 15 || true                    # start each from idle (avoid tap-toggle-off)
    if trial "$line" 0.5; then pass=$((pass+1)); else fail=$((fail+1)); fi
    sleep 2
  done

  # --- MID-CONVERSATION TAP / BARGE-IN: tap + speak WHILE the dock is replying ---
  echo "--- barge-in probe (tap+speak during the reply) ---"
  wait_idle 15 || true
  trial "Tell me a long story about the stars and the planets." 0.5 >/dev/null
  sleep 2                                   # let it START speaking…
  before=$(tx_count)
  tap; sleep 0.4; say_line "Stop — actually, what's two plus two?"   # interrupt
  sleep 7
  echo "barge-in: mode=$(mode) finals=$(( $(tx_count) - before )) decision=$(decision)"
  sleep 2
done
echo "================ HAMMER: pass=$pass fail=$fail (over $ROUNDS rounds) ================"
echo "NOTE: judge HEARD vs SAID vs REPLIED for each — a 'pass' here only means a turn RAN;"
echo "read /api/brain/$DOCK/history for the actual reply quality + STT mishearings."

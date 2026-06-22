#!/usr/bin/env bash
# lib.sh — shared primitives for stressing the dock conversation pipeline.
# Source this from the other scripts: `source "$(dirname "$0")/lib.sh"`.
#
# These wrap the ground-truth surfaces that proved reliable while debugging the
# post-restart STT bug (docs/rca/2026-06-22-post-restart-no-stt.md): the STATION's
# conversation state + addressed-decision trace, the STT sidecar's per-utterance log,
# and adb (tap + screenshot). Everything reads from authoritative sources, not guesses.

BASE="${STATION_BASE:-http://127.0.0.1:8099}"
DOCK="${DOCK:-anne-bot}"
STT_LOG="${STT_LOG:-/tmp/stt-sidecar-parakeet.log}"   # set if your sidecar logs elsewhere
SHOTDIR="${SHOTDIR:-/tmp/dock-stress}"
# Tap target = center of the face (full-screen tap-to-address). Override for other layouts.
TAP_X="${TAP_X:-800}"; TAP_Y="${TAP_Y:-1280}"
mkdir -p "$SHOTDIR" 2>/dev/null || true

# --- station reads (authoritative) -----------------------------------------------------
# conv mode + seconds left in the listening window.
conv()  { curl -s -m3 "$BASE/api/brain/$DOCK/conversation" 2>/dev/null; }
mode()  { conv | python3 -c "import sys,json;d=json.load(sys.stdin);print(d.get('mode','?'))" 2>/dev/null; }
secs()  { conv | python3 -c "import sys,json;d=json.load(sys.stdin);print(d.get('msToExpiry',0)//1000)" 2>/dev/null; }
# last addressed-decision: RAN-TURN | skip:not-addressed | skip:garbage | skip:no-words | …
decision() { curl -s -m4 "$BASE/api/brain/$DOCK/debug/addressed" 2>/dev/null \
  | python3 -c "import sys,json;d=json.load(sys.stdin);e=d[-1] if d else {};print(e.get('decision','none'),'|',e.get('text','')[:40])" 2>/dev/null; }
# does the station currently have an audio-bearing producer from this dock?
producer_audio() { curl -s -m3 "$BASE/api/media/status" 2>/dev/null \
  | python3 -c "import sys,json;d=json.load(sys.stdin);p=[x for x in d.get('producers',[]) if x.get('label')=='$DOCK'];print('audio' if (p and p[0].get('tracks',{}).get('audio')) else 'none')" 2>/dev/null; }

# count of STT /transcribe calls so far — the GROUND TRUTH that STT actually ran.
# (A turn that produces 0 new transcribes never reached the recognizer.)
tx_count() { grep -c '/transcribe' "$STT_LOG" 2>/dev/null || echo 0; }

# --- device actions --------------------------------------------------------------------
tap()   { adb shell input tap "$TAP_X" "$TAP_Y" >/dev/null 2>&1; }
relaunch() { adb shell am force-stop dev.orbit.dock >/dev/null 2>&1; sleep "${1:-1}"; \
             adb shell monkey -p dev.orbit.dock -c android.intent.category.LAUNCHER 1 >/dev/null 2>&1; }
# screenshot → $SHOTDIR/<name>.png AND a 3x-zoom crop of the bottom status bar (mic/cam).
shot()  { adb shell screencap -p /sdcard/_s.png >/dev/null 2>&1; adb pull /sdcard/_s.png "$SHOTDIR/$1.png" >/dev/null 2>&1; }
# wait until the dock is idle (so a trial starts from a known state). Returns after timeout.
wait_idle() { for _ in $(seq 1 "${1:-25}"); do [ "$(mode)" = idle ] && return 0; sleep 1; done; return 1; }
# wait until the station has an audio producer (post-restart readiness). NOTE: producer
# audio:true is necessary but NOT sufficient — see the RCA; still validate by speaking.
wait_producer() { for _ in $(seq 1 "${1:-20}"); do [ "$(producer_audio)" = audio ] && return 0; sleep 1; done; return 1; }

# --- driver mouth (laptop speaker → dock mic, acoustic) --------------------------------
say_line() { say -v "${VOICE:-Samantha}" -r "${RATE:-170}" "$1"; }

# RELIABLY get a confirmed-open listening window with enough headroom to speak into,
# then guarantee we ONLY speak while it's actually listening. The hard requirement:
# never speak unless mode==listening/followup with >= MIN_SECS left at speak time.
#
# A tap TOGGLES (opens from idle; CLOSES an already-open window) — so we tap ONLY when
# idle, never when already attending. We then RE-CONFIRM right before returning, with a
# fresh re-address if the window lapsed. Returns 0 with a confirmed window; 1 if it
# couldn't establish one (so the caller reports HARNESS-NOLISTEN, NOT a dock failure).
ensure_listening() {
  local min_secs="${1:-3}"   # require at least this many seconds left before speaking
  for attempt in 1 2 3 4; do
    local m; m=$(mode)
    if [ "$m" != listening ] && [ "$m" != followup ]; then
      [ "$m" = idle ] && tap          # only tap from idle (toggle-safe)
      sleep 0.3
      m=$(mode)
    fi
    if { [ "$m" = listening ] || [ "$m" = followup ]; } && [ "$(secs)" -ge "$min_secs" ]; then
      return 0                         # confirmed open with headroom
    fi
    sleep 0.3
  done
  return 1
}

# --- one trial: address, CONFIRM listening, speak, judge -------------------------------
# Usage: trial "<spoken line>" [pre_delay_s]
#   pre_delay_s = seconds to wait BEFORE speaking, applied THEN re-confirmed. Use a few
#   seconds (>= window length) to probe the expiry edge ON PURPOSE — those will print
#   AFTER-EXPIRY and are an EXPECTED not-addressed, not a failure.
# Prints: SAID / state-at-speak / finals / DECISION. Returns: 0 RAN-TURN; 1 dock failed
#   while genuinely listening (a REAL bug); 2 couldn't speak-while-listening (harness/
#   intentional-expiry — NOT counted as a dock failure).
trial() {
  local line="$1" pre="${2:-0.5}"
  local t0; t0=$(tx_count)
  ensure_listening 3 || true
  sleep "$pre"
  # RE-CONFIRM at the instant of speaking — this is the "reliably know it's listening
  # when I talk" guarantee. If pre pushed us past the window, re-address once more
  # (unless pre was deliberately long to test expiry).
  local m b; m=$(mode); b=$(secs)
  if [ "$m" != listening ] && [ "$m" != followup ]; then
    # not listening at speak time. If pre was short, this is a harness miss → re-address
    # and retry once; if pre was long (>=6s) it's an intentional expiry probe → proceed.
    if awk "BEGIN{exit !($pre < 6)}"; then ensure_listening 3 && { m=$(mode); b=$(secs); }; fi
  fi
  if [ "$m" != listening ] && [ "$m" != followup ]; then
    printf 'SAID="%s"  AT-SPEAK=[%s %ss]  -> NOT-LISTENING (skipped: harness/expiry, not a dock fail)\n' "$line" "$m" "$b"
    say_line "$line"; sleep 7
    return 2
  fi
  say_line "$line"
  sleep 7
  local finals; finals=$(( $(tx_count) - t0 ))
  local dec; dec=$(decision)
  printf 'SAID="%s"  AT-SPEAK=[%s %ss]  finals=%d  DECISION=%s\n' "$line" "$m" "$b" "$finals" "$dec"
  case "$dec" in RAN-TURN*) return 0;; *) return 1;; esac
}

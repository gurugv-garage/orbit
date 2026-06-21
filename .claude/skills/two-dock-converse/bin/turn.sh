#!/usr/bin/env bash
# turn.sh — run ONE clean conversational turn and report the full round-trip, for
# rigorous testing. Opens a listening window (tap), speaks a line, then prints exactly:
#   SAID   — what we spoke
#   HEARD  — the dock's STT of it (the capture result)
#   REPLY  — the dock's reply (the brain result)
# So each turn is judged on its own: did STT get it right? did the brain answer THAT?
#
# Usage: turn.sh "the line" [dock] [voice] [rate]
set -uo pipefail
LINE="${1:?usage: turn.sh \"text\" [dock] [voice] [rate]}"
DOCK="${2:-anne-bot-redmi}"
VOICE="${3:-Samantha}"
RATE="${4:-150}"
BASE="${STATION_BASE:-http://127.0.0.1:8099}"

# baseline: count of heard-speech + assistant turns BEFORE this turn
read -r H0 R0 < <(curl -s -m3 "$BASE/api/perception/snapshots?limit=80&dock=$DOCK" -o /tmp/_s0.json 2>/dev/null
  curl -s -m3 "$BASE/api/brain/$DOCK/history" -o /tmp/_h0.json 2>/dev/null
  python3 - <<'PY'
import json
def load(p):
  try: return json.load(open(p))
  except: return []
s=load('/tmp/_s0.json'); h=load('/tmp/_h0.json')
sp=[x for x in s if x.get('source',{}).get('kind')=='speech']
msgs=h if isinstance(h,list) else h.get('messages',h.get('history',[]))
a=[m for m in msgs if m.get('role')=='assistant']
print(len(sp), len(a))
PY
)

# WAIT until the dock is NOT speaking (its previous reply's TTS must finish, or our
# utterance gets echo-gated/dropped — the #1 cause of "no capture"). Then open a fresh
# listening window, let the tap-beep clear, then speak.
for _ in $(seq 1 20); do
  m=$(curl -s -m3 "$BASE/api/brain/$DOCK/conversation" | python3 -c "import sys,json;print(json.load(sys.stdin).get('mode',''))" 2>/dev/null)
  [ "$m" != "speaking" ] && [ "$m" != "thinking" ] && break
  sleep 1
done
curl -s -m3 -X POST "$BASE/api/brain/$DOCK/debug/event" -H 'content-type: application/json' -d '{"event":"tap"}' >/dev/null
sleep 1.5
echo "SAID   $LINE"
say -v "$VOICE" -r "$RATE" "$LINE"

# wait for a NEW heard-speech AND a NEW reply
END=$(( $(date +%s) + 25 ))
while [ "$(date +%s)" -lt "$END" ]; do
  sleep 2
  curl -s -m3 "$BASE/api/perception/snapshots?limit=80&dock=$DOCK" -o /tmp/_s1.json 2>/dev/null || true
  curl -s -m3 "$BASE/api/brain/$DOCK/history" -o /tmp/_h1.json 2>/dev/null || true
  OUT=$(python3 - "$H0" "$R0" <<'PY'
import json,sys
h0,r0=int(sys.argv[1]),int(sys.argv[2])
def load(p):
  try: return json.load(open(p))
  except: return []
s=load('/tmp/_s1.json'); h=load('/tmp/_h1.json')
sp=[x for x in s if x.get('source',{}).get('kind')=='speech']
msgs=h if isinstance(h,list) else h.get('messages',h.get('history',[]))
a=[m for m in msgs if m.get('role')=='assistant']
def txt(m):
  c=m.get('content','')
  return ' '.join(p.get('text','') for p in c if isinstance(p,dict)) if isinstance(c,list) else str(c)
if len(sp)>h0 and len(a)>r0:
  print('DONE')
  print('HEARD\t'+(sp[-1]['payload'].get('text','') if sp else ''))
  print('REPLY\t'+(txt(a[-1]) if a else ''))
PY
)
  if echo "$OUT" | head -1 | grep -q DONE; then
    echo "$OUT" | awk -F'\t' '/^HEARD/{print "HEARD  "$2} /^REPLY/{print "REPLY  "$2}'
    exit 0
  fi
done
echo "HEARD  (no new utterance captured)"
echo "REPLY  (no reply within 25s)"
exit 1

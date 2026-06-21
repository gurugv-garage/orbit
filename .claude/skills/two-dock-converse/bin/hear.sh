#!/usr/bin/env bash
# hear.sh — the driver's EARS (into the station). After saying a line, poll the station
# until the dock has (a) HEARD something new (a fresh speech snapshot — its STT of my
# line) and (b) REPLIED (a new assistant turn). Prints the round-trip so the driver
# (Claude) can judge whether the dock heard correctly + replied sensibly.
#
# This reads the dock's side from the STATION (100% accurate on the dock's output), so
# any failure is isolated to the dock's INPUT — did it hear me right?
#
# Usage: hear.sh [dock] [timeout_s]
set -euo pipefail
DOCK="${1:-anne-bot-redmi}"
TIMEOUT="${2:-25}"
BASE="${STATION_BASE:-http://127.0.0.1:8099}"
LOG="${TWODOCK_LOG:-/tmp/two-dock.log}"

# baseline counts so we detect NEW heard-speech + NEW reply
read -r HEARD0 REPLY0 < <(curl -s -m3 "$BASE/api/perception/snapshots?limit=80&dock=$DOCK" \
  -o /tmp/_snap.json 2>/dev/null; curl -s -m3 "$BASE/api/brain/$DOCK/history" -o /tmp/_hist.json 2>/dev/null; \
  python3 - "$DOCK" <<'PY'
import json,sys
try: snap=json.load(open('/tmp/_snap.json'))
except: snap=[]
heard=len([x for x in snap if x.get('source',{}).get('kind')=='speech'])
try:
  h=json.load(open('/tmp/_hist.json')); msgs=h if isinstance(h,list) else h.get('messages',h.get('history',[]))
except: msgs=[]
reply=len([m for m in msgs if m.get('role')=='assistant'])
print(heard, reply)
PY
)

END=$(( $(date +%s) + TIMEOUT ))
while [ "$(date +%s)" -lt "$END" ]; do
  sleep 2
  curl -s -m3 "$BASE/api/perception/snapshots?limit=80&dock=$DOCK" -o /tmp/_snap.json 2>/dev/null || true
  curl -s -m3 "$BASE/api/brain/$DOCK/history" -o /tmp/_hist.json 2>/dev/null || true
  OUT=$(python3 - "$HEARD0" "$REPLY0" <<'PY'
import json,sys
heard0,reply0=int(sys.argv[1]),int(sys.argv[2])
try: snap=json.load(open('/tmp/_snap.json'))
except: snap=[]
sp=[x for x in snap if x.get('source',{}).get('kind')=='speech']
try:
  h=json.load(open('/tmp/_hist.json')); msgs=h if isinstance(h,list) else h.get('messages',h.get('history',[]))
except: msgs=[]
asst=[m for m in msgs if m.get('role')=='assistant']
def txt(m):
  c=m.get('content','')
  if isinstance(c,list): return ' '.join(p.get('text','') for p in c if isinstance(p,dict))
  return str(c)
new_heard = len(sp) > heard0
new_reply = len(asst) > reply0
if new_heard and new_reply:
  print('READY')
  print('HEARD\t'+ (sp[-1]['payload'].get('text','') if sp else ''))
  print('REPLY\t'+ (txt(asst[-1]) if asst else ''))
else:
  print('WAIT\theard=%d/%d reply=%d/%d' % (len(sp),heard0,len(asst),reply0))
PY
)
  if echo "$OUT" | head -1 | grep -q READY; then
    HEARD=$(echo "$OUT" | awk -F'\t' '/^HEARD/{$1="";print}' | sed 's/^ //')
    REPLY=$(echo "$OUT" | awk -F'\t' '/^REPLY/{$1="";print}' | sed 's/^ //')
    echo "$(date +%H:%M:%S) DOCK-HEARD: $HEARD" | tee -a "$LOG"
    echo "$(date +%H:%M:%S) DOCK-REPLY: $REPLY" | tee -a "$LOG"
    exit 0
  fi
done
echo "$(date +%H:%M:%S) (no reply within ${TIMEOUT}s — dock may not have heard, or stayed silent)" | tee -a "$LOG"
exit 1

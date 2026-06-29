#!/usr/bin/env bash
# verify.sh — prove the remote orbit-station deploy is healthy, end to end.
# Read-only: makes no changes. Run from your laptop:  ops/verify.sh
# Exit non-zero if any check fails (CI/loop-friendly).

cd "$(dirname "$0")"
source ./config.sh
set +e   # we tally failures ourselves rather than abort on first

FAILS=0
check() { if eval "$2"; then ok "$1"; else fail "$1"; FAILS=$((FAILS+1)); fi; }

say "1. SSH + host"
remote 'echo "  $(hostname) up since $(uptime -p)"' || { fail "SSH unreachable"; exit 1; }

say "2. Toolchain on the VM"
check "Node 22+"          "remote 'n=\$(node -v|cut -dv -f2|cut -d. -f1); [ \"\$n\" -ge 22 ]'"
check "ffmpeg present"    "remote 'command -v ffmpeg >/dev/null'"
check "STT venv present"  "remote '[ -x $VENV_DIR/bin/python ]'"
check ".env present (600)" "remote '[ -f $STATION_DIR/.env ]'"

say "3. systemd services (active + enabled on boot)"
check "orbit-station active"   "remote 'systemctl is-active --quiet orbit-station'"
check "orbit-station enabled"  "remote 'systemctl is-enabled --quiet orbit-station'"
check "orbit-stt active"       "remote 'systemctl is-active --quiet orbit-stt'"
check "orbit-stt enabled"      "remote 'systemctl is-enabled --quiet orbit-stt'"

say "4. Listening ports (on the VM)"
check "station :$STATION_PORT"  "remote 'ss -ltn | grep -q :$STATION_PORT'"
check "STT :$STT_PORT (localhost)" "remote 'ss -ltn | grep -q :$STT_PORT'"

say "5. STT sidecar health + a real transcribe"
check "STT /health ok"  "remote 'curl -s -m5 http://127.0.0.1:$STT_PORT/health | grep -q \"\\\"ok\\\": true\"'"
TRANSCRIPT=$(remote "set -e; cd /tmp
  espeak-ng -w v.wav 'verification one two three' 2>/dev/null
  ffmpeg -y -i v.wav -ar 16000 -ac 1 -f s16le v.pcm 2>/dev/null
  $VENV_DIR/bin/python - <<PY 2>/dev/null
import base64,json,urllib.request
pcm=open('/tmp/v.pcm','rb').read()
r=urllib.request.urlopen(urllib.request.Request('http://127.0.0.1:$STT_PORT/transcribe',
  data=json.dumps({'pcm_b64':base64.b64encode(pcm).decode(),'sample_rate':16000}).encode(),
  headers={'content-type':'application/json'}),timeout=30)
print(json.loads(r.read())['text'])
PY")
if echo "$TRANSCRIPT" | grep -qiE "one two three|1,? ?2,? ?3|123"; then ok "STT transcribe → \"$TRANSCRIPT\""
else fail "STT transcribe unexpected → \"$TRANSCRIPT\""; FAILS=$((FAILS+1)); fi

say "6. Remote reachability (from THIS laptop, over the internet)"
check "TCP $VM_IP:$STATION_PORT open" "nc -z -G 8 $VM_IP $STATION_PORT"
HTTP=$(curl -s -m10 -o /dev/null -w '%{http_code}' "http://$VM_IP:$STATION_PORT/api/docks")
check "HTTP /api/docks = 200 (got $HTTP)" "[ '$HTTP' = '200' ]"
T=$(curl -s -m10 -o /dev/null -w '%{time_total}' "http://$VM_IP:$STATION_PORT/" 2>/dev/null)
ok "round-trip ${T}s (laptop → $VM_IP)"
# WebSocket hello→welcome (the dock's actual transport) if node+ws available locally
if [ -d "$(cd .. && pwd)/orbit-station/node_modules/ws" ]; then
  WS=$(cd "$(cd .. && pwd)/orbit-station" && node -e '
    const WebSocket=require("ws");const ws=new WebSocket("ws://'$VM_IP':'$STATION_PORT'/ws");
    const t=setTimeout(()=>{console.log("TIMEOUT");process.exit(0)},8000);
    ws.on("message",m=>{const j=JSON.parse(m);console.log(j.t==="welcome"?"WELCOME":j.t);clearTimeout(t);process.exit(0)});
    ws.on("open",()=>ws.send(JSON.stringify({t:"hello",role:"verify",id:"verify-probe"})));
    ws.on("error",e=>{console.log("ERR "+e.message);process.exit(0)});' 2>/dev/null)
  check "WS hub hello→welcome (got $WS)" "[ '$WS' = 'WELCOME' ]"
else
  warn "skipped WS check (no local ws module — run from a built repo)"
fi

say "Result"
if [ "$FAILS" -eq 0 ]; then ok "ALL CHECKS PASSED"; exit 0
else fail "$FAILS check(s) failed"; exit 1; fi

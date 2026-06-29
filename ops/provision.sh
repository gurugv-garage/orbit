#!/usr/bin/env bash
# provision.sh — stand up orbit-station + the faster-whisper STT sidecar on a fresh
# E2E (Ubuntu 24.04) VM, exactly as the first bring-up did. Idempotent: safe to re-run.
#
# Prereqs you do MANUALLY first (see docs/operations/remote-deployment.md §10, §12):
#   1. Create the E2E node (Chennai, C3 ~4vCPU/8GB, Ubuntu 24.04), get its IP.
#   2. Add the VM's SSH pubkey as a GitHub deploy key (so `git clone` works on the box).
#   3. Open the firewall: 22 + 8099/tcp + 40000-40100/udp to your IP/dock.
#   4. Set VM_IP (and SSH_KEY if not ~/.ssh/id_ed25519) — see config.sh.
#
# Then run from your laptop:  ops/provision.sh
# It will: install toolchain → clone (or pull) repo → copy .env + the local-only
# files → npm install/build → set up the STT venv → install + start both systemd units.
#
# NOTE: this copies your LAPTOP's orbit-station/.env to the VM. Secrets never go via git.

cd "$(dirname "$0")"
source ./config.sh

LAPTOP_REPO="${LAPTOP_REPO:-$(cd .. && pwd)}"   # this repo on the laptop

say "Target: $VM_USER@$VM_IP  (repo $REPO_DIR)"
remote 'echo "  reachable: $(hostname)"' || { fail "cannot SSH — check VM_IP / SSH_KEY / firewall"; exit 1; }

# 1. System toolchain (Node 22, ffmpeg, python venv, build tools) ------------
say "1/6  System packages (Node 22, ffmpeg, python3-venv, build-essential)"
remote 'set -e
  if ! command -v node >/dev/null || [ "$(node -v | cut -dv -f2 | cut -d. -f1)" -lt 22 ]; then
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null 2>&1
    apt-get install -y nodejs >/dev/null
  fi
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  apt-get install -y -qq ffmpeg git python3-pip python3-venv build-essential espeak-ng >/dev/null
  echo "  node $(node -v) / npm $(npm -v) / $(ffmpeg -version | head -1 | cut -d" " -f1-3)"'
ok "toolchain ready"

# 2. Repo: clone or pull ------------------------------------------------------
say "2/6  Repo at $REPO_DIR"
remote "set -e
  if [ -d '$REPO_DIR/.git' ]; then
    cd '$REPO_DIR' && git pull --ff-only || echo '  (pull skipped — local changes / scp drift; see §13)'
  else
    mkdir -p \"\$(dirname '$REPO_DIR')\" && git clone '$GIT_REMOTE' '$REPO_DIR'
  fi
  cd '$REPO_DIR' && echo '  HEAD:' \$(git log --oneline -1)"
ok "repo present"

# 3. Copy .env + local-only files (the scp'd drift, §13) ----------------------
say "3/6  Copy .env + local-only files (never via git)"
if [ -f "$LAPTOP_REPO/orbit-station/.env" ]; then
  scp -o BatchMode=yes -i "$SSH_KEY" "$LAPTOP_REPO/orbit-station/.env" "$VM_USER@$VM_IP:$STATION_DIR/.env"
  remote "chmod 600 '$STATION_DIR/.env'"
  ok ".env copied (chmod 600)"
else
  warn "no laptop .env at $LAPTOP_REPO/orbit-station/.env — create it on the VM manually (§10.3)"
fi
# Ensure the VM-specific env vars exist (idempotent append)
remote "cd '$STATION_DIR'
  for kv in 'HOST=0.0.0.0' 'PORT=$STATION_PORT' 'PERCEPTION_SIDECAR_URL=http://127.0.0.1:$STT_PORT' \\
            'STUN_URL=stun:stun.l.google.com:19302' 'ICE_PORT_RANGE=40000-40100'; do
    k=\"\${kv%%=*}\"; grep -q \"^\${k}=\" .env 2>/dev/null || echo \"\$kv\" >> .env
  done"
ok "VM env vars ensured"
# Local-only commits not yet pushed (§13) — keep the VM in sync until pushed.
for f in orbit-station/server/src/main.ts models/perception-sidecar/sidecar_fw.py; do
  if [ -f "$LAPTOP_REPO/$f" ]; then
    scp -o BatchMode=yes -i "$SSH_KEY" "$LAPTOP_REPO/$f" "$VM_USER@$VM_IP:$REPO_DIR/$f"
  fi
done
warn "scp'd main.ts + sidecar_fw.py (unpushed commits, §13) — push them and this becomes a no-op"

# 4. Build the station --------------------------------------------------------
say "4/6  npm install + build (orbit-station)"
remote "cd '$STATION_DIR' && npm install --no-audit --no-fund >/dev/null 2>&1 && npm run build >/dev/null 2>&1"
ok "station built"

# 5. STT sidecar venv + model -------------------------------------------------
say "5/6  faster-whisper venv + model ($STT_MODEL)"
remote "set -e
  cd '$SIDECAR_DIR'
  [ -d '$VENV_DIR' ] || python3 -m venv '$VENV_DIR'
  '$VENV_DIR/bin/pip' install -q --upgrade pip
  '$VENV_DIR/bin/pip' install -q faster-whisper numpy
  '$VENV_DIR/bin/python' -c 'import faster_whisper, numpy' && echo '  faster-whisper OK'"
ok "STT sidecar deps ready"

# 6. systemd units ------------------------------------------------------------
say "6/6  systemd units (orbit-station + orbit-stt), enable + start"
remote "cat > /etc/systemd/system/orbit-station.service <<UNIT
[Unit]
Description=orbit-station
After=network-online.target
Wants=network-online.target
[Service]
WorkingDirectory=$STATION_DIR
ExecStart=/usr/bin/npm run start
Restart=always
RestartSec=3
KillMode=control-group
Environment=NODE_ENV=production
[Install]
WantedBy=multi-user.target
UNIT
cat > /etc/systemd/system/orbit-stt.service <<UNIT
[Unit]
Description=orbit STT sidecar (faster-whisper)
After=network-online.target
Wants=network-online.target
[Service]
WorkingDirectory=$SIDECAR_DIR
ExecStart=$VENV_DIR/bin/python sidecar_fw.py --port $STT_PORT --model $STT_MODEL --device cpu --compute-type int8
Restart=always
RestartSec=3
[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable --now orbit-stt orbit-station"
ok "units installed + started"

say "Done. Verify with:  ops/verify.sh"

#!/usr/bin/env bash
# Shared config + helpers for the orbit-station remote-VM ops scripts.
# Sourced by provision.sh and verify.sh. Override any value via the environment.
#
# Secrets (E2E API key/token) live in ops/e2e.keys (gitignored) — only needed if you
# drive the E2E API; the SSH-based scripts here don't require it.

set -euo pipefail

# --- target VM ---------------------------------------------------------------
VM_IP="${VM_IP:?set VM_IP to your VM's public IP (e.g. export VM_IP=1.2.3.4)}"
VM_USER="${VM_USER:-root}"
SSH_KEY="${SSH_KEY:-$HOME/.ssh/id_ed25519}"

# --- paths on the VM ---------------------------------------------------------
REPO_DIR="${REPO_DIR:-/root/code/orbit}"
STATION_DIR="$REPO_DIR/orbit-station"
SIDECAR_DIR="$REPO_DIR/models/perception-sidecar"
VENV_DIR="$SIDECAR_DIR/.venv-fw"

# --- service knobs -----------------------------------------------------------
STATION_PORT="${STATION_PORT:-8099}"
STT_PORT="${STT_PORT:-8078}"
STT_MODEL="${STT_MODEL:-small.en}"
GIT_REMOTE="${GIT_REMOTE:-git@github.com:gurugv-garage/orbit.git}"

# --- ssh wrapper -------------------------------------------------------------
SSH=(ssh -o BatchMode=yes -o ConnectTimeout=15 -i "$SSH_KEY" "$VM_USER@$VM_IP")
remote() { "${SSH[@]}" "$@"; }     # run a command on the VM
say()    { printf '\n\033[1;36m== %s ==\033[0m\n' "$*"; }
ok()     { printf '  \033[32m✓\033[0m %s\n' "$*"; }
warn()   { printf '  \033[33m!\033[0m %s\n' "$*"; }
fail()   { printf '  \033[31m✗\033[0m %s\n' "$*"; }

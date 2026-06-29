# ops — orbit-station remote-VM deployment scripts

Re-runnable scripts for the off-laptop deploy (E2E Chennai today). The full design,
cost, and decisions live in [../docs/operations/remote-deployment.md](../docs/operations/remote-deployment.md);
this folder is **the executable version of §10**.

| File | What |
|---|---|
| `config.sh` | Shared config (VM_IP, SSH key, paths, ports) + helpers. Sourced by the others. Override any value via env. |
| `provision.sh` | Stand up everything on a fresh Ubuntu VM: toolchain → repo → `.env` → build → STT venv → systemd units. **Idempotent** (safe to re-run). |
| `verify.sh` | Read-only health check, end to end (SSH, services, ports, a real STT transcribe, remote HTTP+WS). Exit ≠ 0 on any failure. |
| `e2e.keys` | E2E API key/token — **gitignored**, never committed. Only needed if driving the E2E API (the scripts here use SSH, not the API). |

## Use

```bash
# point at your VM (defaults to the current node)
export VM_IP=151.185.45.155        # and SSH_KEY=... if not ~/.ssh/id_ed25519

ops/verify.sh        # is the remote deploy healthy?  ← run this anytime
ops/provision.sh     # (re)provision a fresh/rebuilt VM, then verify.sh
```

## Before `provision.sh` on a NEW vm (manual, one-time)

Per remote-deployment.md §10 + §12 — the scripts can't do these for you:
1. Create the E2E node (Chennai, C3 ~4vCPU/8GB, Ubuntu 24.04); note its IP → set `VM_IP`.
2. Add the VM's SSH **pubkey as a GitHub deploy key** (so the box can `git clone`).
3. Firewall: open `22` + `8099/tcp` + `40000-40100/udp` to your IP/dock.

`provision.sh` copies your **laptop's** `orbit-station/.env` to the VM (secrets never
travel via git). It also `scp`s two not-yet-pushed files (`main.ts`, `sidecar_fw.py`) —
see remote-deployment.md §13; once those commits are pushed, that step is a no-op.

## Snapshot / stop to save cost

⚠️ On E2E, **power-off does NOT stop billing** — snapshot → terminate → restore is the
cost-saving path. See remote-deployment.md §14.

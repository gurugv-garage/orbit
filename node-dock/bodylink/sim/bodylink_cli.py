"""bodylink_cli — interactive client for the new BodyLink protocol.

Drives primitive `set_target` commands against a sim or the live firmware.
Mirrors the UX of body-firmware/dock_body_v0/scripts/test_body.sh — same
menu shortcuts, `;`-batched parallel motion, full envelope logging.

Run:
    python3 bodylink_cli.py                            # localhost:17317
    python3 bodylink_cli.py --host 192.168.1.10        # live XIAO
    python3 bodylink_cli.py --do "neck 1245 400; foot 2000 400"

Type `help` at the prompt for the in-session menu.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import sys
import time
from typing import Any

from websockets.asyncio.client import ClientConnection, connect

PROTOCOL_VERSION = 0

GREEN = "\033[32m"
RED = "\033[31m"
CYAN = "\033[36m"
YELLOW = "\033[33m"
DIM = "\033[2m"
RST = "\033[0m"

DEFAULT_DURATION_MS = 400
NECK_UP_US = 1245
NECK_DN_US = 1755
NECK_CENTER_US = 1500
FOOT_LEFT_US = 1000
FOOT_RIGHT_US = 2000
FOOT_CENTER_US = 1500


def now_ms() -> int:
    return int(time.time() * 1000)


def envelope(msg_type: str, body: dict[str, Any], *, msg_id: str | None = None) -> str:
    msg: dict[str, Any] = {"v": PROTOCOL_VERSION, "type": msg_type, "ts": now_ms(), "body": body}
    if msg_id is not None:
        msg["id"] = msg_id
    return json.dumps(msg, separators=(",", ":"))


class BrainClient:
    def __init__(self, ws: ClientConnection):
        self.ws = ws
        self.profile: dict[str, Any] = {}
        self.last_commanded: dict[str, dict[str, Any]] = {}
        self._echo_seq = 0
        self._pending_echo: dict[int, int] = {}

    async def handshake(self) -> None:
        await self.ws.send(envelope("hello", {"protos": [PROTOCOL_VERSION]}))
        deadline = time.time() + 6.0
        saw_welcome = False
        while time.time() < deadline and not (saw_welcome and self.profile):
            raw = await asyncio.wait_for(self.ws.recv(), timeout=deadline - time.time())
            msg = json.loads(raw)
            t = msg.get("type")
            body = msg.get("body", {})
            if t == "welcome":
                saw_welcome = True
                print(f"{DIM}welcome:{RST} {body.get('name')} ({body.get('device_id')}, fw {body.get('fw_version')}, proto {body.get('proto')})")
            elif t == "profile":
                self.profile = body
                print(f"{DIM}profile:{RST} parts={list(body.get('parts', {}).keys())}")
            elif t == "event" and body.get("kind") == "boot":
                print(f"{CYAN}<<{RST} event:boot")
            elif t == "error":
                print(f"{RED}<<{RST} error: {body}")
                if body.get("fatal"):
                    raise SystemExit(f"fatal handshake error: {body}")
        if not (saw_welcome and self.profile):
            raise SystemExit("handshake timed out (missing welcome or profile)")

    async def send_set_target(self, parts: dict[str, dict[str, Any]]) -> None:
        env = envelope("set_target", {"parts": parts})
        print(f"{YELLOW}>>{RST} {env}")
        await self.ws.send(env)
        for p, vals in parts.items():
            self.last_commanded[p] = dict(vals)

    async def send_echo(self) -> None:
        self._echo_seq += 1
        seq = self._echo_seq
        host_ts = now_ms()
        self._pending_echo[seq] = host_ts
        env = envelope("echo", {"seq": seq, "host_ts": host_ts}, msg_id=f"e{seq}")
        print(f"{YELLOW}>>{RST} {env}")
        await self.ws.send(env)

    async def send_raw(self, env_str: str) -> None:
        print(f"{YELLOW}>>{RST} {env_str}")
        await self.ws.send(env_str)


async def receive_loop(client: BrainClient) -> None:
    try:
        async for raw in client.ws:
            msg = json.loads(raw)
            t = msg.get("type")
            body = msg.get("body", {})
            colour = {"error": RED, "event": CYAN, "echo_reply": GREEN}.get(t, GREEN)
            if t == "echo_reply":
                seq = body.get("seq")
                host_ts = client._pending_echo.pop(seq, None)
                if host_ts is not None:
                    rtt = now_ms() - host_ts
                    print(f"{colour}<<{RST} echo_reply seq={seq} rtt={rtt}ms device_ts={body.get('device_ts')}")
                else:
                    print(f"{colour}<<{RST} echo_reply {body}")
            else:
                print(f"{colour}<<{RST} {t}  {json.dumps(body, separators=(',', ':'))}")
    except Exception as e:
        print(f"{DIM}receive loop ended: {e}{RST}")


HELP = """\
Commands (separate parallel parts with `;` to merge into one set_target):

  Motion:
    neck <us> [ms]              raw pulse_width_us [+ duration]
    foot <us> [ms]              raw pulse_width_us [+ duration]
    raw <part> k=v k=v ...      arbitrary params

  Shortcuts:
    up / down                   neck → 1245 / 1755 µs
    left / right                foot → 1000 / 2000 µs
    center / home               every part → 1500 µs
    target neck=<us> foot=<us> ms=<ms>    multi-part single frame

  Diagnostics:
    list / status               show profile / last commanded
    echo                        round-trip latency
    wait <ms>                   sleep (useful inside `;`-batches)
    json <full envelope>        raw envelope send
    help / quit
"""


async def handle_command(client: BrainClient, line: str) -> bool:
    line = line.strip()
    if not line or line.startswith("#"):
        return True
    if line in ("help", "?"):
        print(HELP); return True
    if line in ("quit", "exit", "q"):
        return False
    if line == "list":
        print(json.dumps(client.profile, indent=2)); return True
    if line == "status":
        print(json.dumps(client.last_commanded, indent=2)); return True
    if line == "echo":
        await client.send_echo(); return True
    if line.startswith("wait "):
        await asyncio.sleep(int(line.split()[1]) / 1000.0); return True
    if line.startswith("json "):
        await client.send_raw(line[len("json "):]); return True

    if ";" in line:
        merged: dict[str, dict[str, Any]] = {}
        for sub in line.split(";"):
            sub = sub.strip()
            if not sub:
                continue
            if sub.startswith("wait "):
                if merged:
                    await client.send_set_target(merged); merged = {}
                await asyncio.sleep(int(sub.split()[1]) / 1000.0)
                continue
            for p, vals in _line_to_parts(sub).items():
                merged[p] = vals
        if merged:
            await client.send_set_target(merged)
        return True

    parts = _line_to_parts(line)
    if parts:
        await client.send_set_target(parts)
        return True
    print(f"{RED}?? unknown:{RST} {line}  (type `help`)")
    return True


def _line_to_parts(line: str) -> dict[str, dict[str, Any]]:
    toks = line.split()
    if not toks:
        return {}
    head = toks[0].lower()
    if head == "up":
        return {"neck": {"pulse_width_us": NECK_UP_US, "duration_ms": DEFAULT_DURATION_MS}}
    if head == "down":
        return {"neck": {"pulse_width_us": NECK_DN_US, "duration_ms": DEFAULT_DURATION_MS}}
    if head == "left":
        return {"foot": {"pulse_width_us": FOOT_LEFT_US, "duration_ms": 500}}
    if head == "right":
        return {"foot": {"pulse_width_us": FOOT_RIGHT_US, "duration_ms": 500}}
    if head in ("center", "home"):
        return {
            "neck": {"pulse_width_us": NECK_CENTER_US, "duration_ms": DEFAULT_DURATION_MS},
            "foot": {"pulse_width_us": FOOT_CENTER_US, "duration_ms": DEFAULT_DURATION_MS},
        }
    if head in ("neck", "foot") and len(toks) >= 2:
        try:
            us = int(toks[1])
        except ValueError:
            return {}
        ms = int(toks[2]) if len(toks) >= 3 else DEFAULT_DURATION_MS
        return {head: {"pulse_width_us": us, "duration_ms": ms}}
    if head == "target":
        out: dict[str, dict[str, Any]] = {}
        ms = DEFAULT_DURATION_MS
        for tok in toks[1:]:
            if "=" not in tok: continue
            k, v = tok.split("=", 1)
            if k == "ms":
                ms = int(v)
            elif k in ("neck", "foot"):
                out[k] = {"pulse_width_us": int(v)}
        for v in out.values():
            v.setdefault("duration_ms", ms)
        return out
    if head == "raw" and len(toks) >= 3:
        part = toks[1]
        vals: dict[str, Any] = {}
        for tok in toks[2:]:
            if "=" not in tok: continue
            k, v = tok.split("=", 1)
            try:
                vals[k] = float(v) if "." in v else int(v)
            except ValueError:
                vals[k] = v
        return {part: vals}
    return {}


async def main_async(args: argparse.Namespace) -> int:
    uri = f"ws://{args.host}:{args.port}/"
    print(f"{DIM}connecting to{RST} {uri}")
    ws = await connect(uri)
    try:
        client = BrainClient(ws)
        await client.handshake()
        recv_task = asyncio.create_task(receive_loop(client))

        if args.do:
            for cmd in args.do:
                if not await handle_command(client, cmd):
                    break
            await asyncio.sleep(0.5)  # flush replies
        else:
            print(HELP)
            loop = asyncio.get_event_loop()
            while True:
                try:
                    line = await loop.run_in_executor(None, lambda: input("bodylink> "))
                except (EOFError, KeyboardInterrupt):
                    break
                if not await handle_command(client, line):
                    break

        recv_task.cancel()
    finally:
        try:
            await ws.close()
        except Exception:
            pass
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=17317)
    ap.add_argument("--do", action="append", default=[],
                    help="Run a command non-interactively. May be repeated.")
    args = ap.parse_args()
    try:
        return asyncio.run(main_async(args))
    except KeyboardInterrupt:
        return 130


if __name__ == "__main__":
    raise SystemExit(main())

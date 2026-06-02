"""End-to-end integration test for the BodyLink protocol (2026-05-27 redesign).

Drives a Body (sim or live ESP32 firmware) through the full protocol surface.
Each check prints one line ending in PASS / FAIL. Exits 0 if all green.

Run against the local sim:
    python3 bodylink_sim.py             # in one terminal
    python3 integration_test.py         # in another

Or all-in-one:
    python3 integration_test.py --auto-start

Run against the live XIAO firmware (no servo damage — clipping tests stay
within the declared 500..2500 µs range):
    python3 integration_test.py --host 192.168.1.10
"""
from __future__ import annotations

import argparse
import asyncio
import json
import os
import signal
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

import websockets
from websockets.asyncio.client import ClientConnection, connect

HERE = Path(__file__).parent
PROTOCOL_VERSION = 0


def now_ms() -> int:
    return int(time.time() * 1000)


def envelope(msg_type: str, body: dict[str, Any], *, msg_id: str | None = None) -> str:
    msg: dict[str, Any] = {"v": PROTOCOL_VERSION, "type": msg_type, "ts": now_ms(), "body": body}
    if msg_id is not None:
        msg["id"] = msg_id
    return json.dumps(msg, separators=(",", ":"))


# ───────────────────────────────────────────────────────────────────────────
# Test harness
# ───────────────────────────────────────────────────────────────────────────

class Harness:
    def __init__(self) -> None:
        self.passed: list[str] = []
        self.failed: list[tuple[str, str]] = []
        self.skipped: list[tuple[str, str]] = []

    def ok(self, name: str) -> None:
        print(f"  PASS  {name}")
        self.passed.append(name)

    def fail(self, name: str, detail: str) -> None:
        print(f"  FAIL  {name}  — {detail}")
        self.failed.append((name, detail))

    def skip(self, name: str, detail: str) -> None:
        print(f"  SKIP  {name}  — {detail}")
        self.skipped.append((name, detail))

    def report(self) -> int:
        print()
        print(f"results: {len(self.passed)} pass, {len(self.failed)} fail, {len(self.skipped)} skip")
        if self.failed:
            print("\nFAILURES:")
            for name, detail in self.failed:
                print(f"  - {name}: {detail}")
            return 1
        return 0


# ───────────────────────────────────────────────────────────────────────────
# WS primitives
# ───────────────────────────────────────────────────────────────────────────

async def connect_with_hello(
    uri: str,
    protos: list[int] | None = None,
    timeout: float = 8.0,
) -> tuple[ClientConnection, dict[str, Any], dict[str, Any]]:
    """Connect, send hello, return (ws, welcome_body, profile_body).

    Tolerates the body sending event:boot before welcome — the firmware does
    this; the sim also does it after the redesign.
    """
    ws = await asyncio.wait_for(connect(uri), timeout=timeout)
    await ws.send(envelope("hello", {"protos": protos if protos is not None else [PROTOCOL_VERSION]}))
    welcome: dict[str, Any] | None = None
    profile: dict[str, Any] | None = None
    deadline = time.time() + timeout
    while (welcome is None or profile is None) and time.time() < deadline:
        raw = await asyncio.wait_for(ws.recv(), timeout=timeout)
        msg = json.loads(raw)
        t = msg.get("type")
        if t == "welcome":
            welcome = msg.get("body")
        elif t == "profile":
            profile = msg.get("body")
        elif t == "error":
            await ws.close()
            raise RuntimeError(f"handshake error: {msg.get('body')}")
    if welcome is None or profile is None:
        await ws.close()
        raise RuntimeError("handshake timed out: missing welcome or profile")
    return ws, welcome, profile


async def drain_until(ws: ClientConnection, predicate, timeout: float = 3.0) -> Any:
    """Read messages until predicate(msg) returns truthy. Returns it, or None on timeout."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            raw = await asyncio.wait_for(ws.recv(), timeout=max(0.1, deadline - time.time()))
        except asyncio.TimeoutError:
            return None
        msg = json.loads(raw)
        result = predicate(msg)
        if result:
            return result
    return None


async def collect_until_quiet(ws: ClientConnection, quiet_ms: int = 300, hard_timeout: float = 2.0) -> list[dict[str, Any]]:
    """Read frames until `quiet_ms` of silence or `hard_timeout`. Used to gather
    error+event pairs that the body emits back-to-back."""
    out: list[dict[str, Any]] = []
    deadline = time.time() + hard_timeout
    while time.time() < deadline:
        try:
            raw = await asyncio.wait_for(ws.recv(), timeout=quiet_ms / 1000.0)
        except asyncio.TimeoutError:
            return out
        out.append(json.loads(raw))
    return out


async def set_target(ws: ClientConnection, parts: dict[str, dict[str, Any]]) -> None:
    await ws.send(envelope("set_target", {"parts": parts}))


def first_event(msgs: list[dict[str, Any]], kind: str) -> dict[str, Any] | None:
    for m in msgs:
        if m.get("type") == "event" and m.get("body", {}).get("kind") == kind:
            return m["body"]
    return None


def first_error(msgs: list[dict[str, Any]], code: str | None = None) -> dict[str, Any] | None:
    for m in msgs:
        if m.get("type") == "error":
            b = m.get("body", {})
            if code is None or b.get("code") == code:
                return b
    return None


# ───────────────────────────────────────────────────────────────────────────
# Tests
# ───────────────────────────────────────────────────────────────────────────

async def test_handshake_emits_boot_then_welcome_profile(uri: str, h: Harness) -> None:
    print("\n[1] Handshake → boot? + welcome + profile")
    try:
        ws = await connect(uri)
        try:
            # Body may emit event:boot before our hello (firmware does this);
            # may also emit it after. Tolerate either order.
            await ws.send(envelope("hello", {"protos": [PROTOCOL_VERSION]}))
            saw_boot = False
            saw_welcome = False
            saw_profile = False
            deadline = time.time() + 6.0
            while time.time() < deadline and not (saw_welcome and saw_profile):
                raw = await asyncio.wait_for(ws.recv(), timeout=deadline - time.time())
                m = json.loads(raw)
                t = m.get("type")
                if t == "event" and m.get("body", {}).get("kind") == "boot":
                    saw_boot = True
                elif t == "welcome":
                    saw_welcome = True
                    w = m.get("body", {})
                    if w.get("proto") == PROTOCOL_VERSION:
                        h.ok("welcome.proto == 0")
                    else:
                        h.fail("welcome.proto == 0", f"got {w.get('proto')}")
                    for k in ("device_id", "name", "fw_version"):
                        if w.get(k):
                            h.ok(f"welcome.{k}")
                        else:
                            h.fail(f"welcome.{k}", "missing")
                elif t == "profile":
                    saw_profile = True
            if saw_boot:
                h.ok("event:boot emitted")
            else:
                h.skip("event:boot emitted", "not observed in handshake window (acceptable on warm reconnect)")
            if saw_welcome and saw_profile:
                h.ok("welcome + profile both arrived")
            else:
                h.fail("welcome + profile both arrived", f"welcome={saw_welcome} profile={saw_profile}")
        finally:
            await ws.close()
    except Exception as e:
        h.fail("handshake", f"exception: {e}")


async def test_profile_has_neck_and_foot_with_correct_params(uri: str, h: Harness) -> None:
    print("\n[2] Profile shape — parts + params")
    try:
        ws, _, profile = await connect_with_hello(uri)
        try:
            parts = profile.get("parts", {})
            for part_name in ("neck", "foot"):
                if part_name not in parts:
                    h.fail(f"profile has {part_name!r}", f"got parts {list(parts.keys())}")
                    continue
                h.ok(f"profile has {part_name!r}")
                pparams = parts[part_name].get("params", {})
                if "pulse_width_us" in pparams:
                    h.ok(f"{part_name}.pulse_width_us declared")
                else:
                    h.fail(f"{part_name}.pulse_width_us declared", f"params: {list(pparams.keys())}")
                spec = pparams.get("pulse_width_us", {})
                rng = spec.get("range", [])
                if list(rng) == [500, 2500]:
                    h.ok(f"{part_name}.pulse_width_us range == [500, 2500]")
                else:
                    h.fail(f"{part_name}.pulse_width_us range == [500, 2500]", f"got {rng}")
            home = parts.get("neck", {}).get("home", {})
            if home.get("pulse_width_us") == 1500:
                h.ok("neck.home.pulse_width_us == 1500")
            else:
                h.fail("neck.home.pulse_width_us == 1500", f"got {home}")
        finally:
            await ws.close()
    except Exception as e:
        h.fail("profile shape", f"exception: {e}")


async def test_set_target_clamps_out_of_range(uri: str, h: Harness) -> None:
    print("\n[3] set_target clamps out-of-range")
    try:
        ws, _, _ = await connect_with_hello(uri)
        try:
            await set_target(ws, {"neck": {"pulse_width_us": 9999}})
            msgs = await collect_until_quiet(ws, quiet_ms=400, hard_timeout=2.0)
            err = first_error(msgs, "OUT_OF_RANGE")
            if err:
                h.ok("error:OUT_OF_RANGE emitted")
            else:
                h.fail("error:OUT_OF_RANGE emitted", f"got {msgs}")
            ev = first_event(msgs, "clipped")
            if ev:
                h.ok("event:clipped emitted")
                if ev.get("part") == "neck" and ev.get("param") == "pulse_width_us":
                    h.ok("clipped event identifies neck.pulse_width_us")
                else:
                    h.fail("clipped event identifies neck.pulse_width_us", f"got {ev}")
                if int(ev.get("applied", 0)) == 2500:
                    h.ok("clamped to high bound 2500")
                else:
                    h.fail("clamped to high bound 2500", f"got applied={ev.get('applied')}")
            else:
                h.fail("event:clipped emitted", f"got {msgs}")
        finally:
            await ws.close()
    except Exception as e:
        h.fail("clamp", f"exception: {e}")


async def test_clipped_event_emitted_on_clamp(uri: str, h: Harness) -> None:
    print("\n[4] event:clipped on low-side clamp")
    try:
        ws, _, _ = await connect_with_hello(uri)
        try:
            await set_target(ws, {"neck": {"pulse_width_us": 100}})
            msgs = await collect_until_quiet(ws, quiet_ms=400, hard_timeout=2.0)
            ev = first_event(msgs, "clipped")
            if ev and int(ev.get("applied", 0)) == 500:
                h.ok("low-side clamp → applied=500")
            else:
                h.fail("low-side clamp → applied=500", f"got {ev}")
            # Drive back to center so we leave the body settled.
            await set_target(ws, {"neck": {"pulse_width_us": 1500, "duration_ms": 300}})
            await asyncio.sleep(0.4)
        finally:
            await ws.close()
    except Exception as e:
        h.fail("clipped event", f"exception: {e}")


async def test_set_target_emits_unknown_part_error(uri: str, h: Harness) -> None:
    print("\n[5] Unknown part → error:UNKNOWN_PART")
    try:
        ws, _, _ = await connect_with_hello(uri)
        try:
            await set_target(ws, {"nonesuch": {"pulse_width_us": 1500}})
            msgs = await collect_until_quiet(ws, quiet_ms=400, hard_timeout=1.5)
            err = first_error(msgs, "UNKNOWN_PART")
            if err:
                h.ok("error:UNKNOWN_PART emitted")
            else:
                h.fail("error:UNKNOWN_PART emitted", f"got {msgs}")
        finally:
            await ws.close()
    except Exception as e:
        h.fail("unknown part", f"exception: {e}")


async def test_set_target_emits_unknown_param_error(uri: str, h: Harness) -> None:
    print("\n[6] Unknown param → error:UNKNOWN_PARAM")
    try:
        ws, _, _ = await connect_with_hello(uri)
        try:
            await set_target(ws, {"neck": {"frobnicate": 42}})
            msgs = await collect_until_quiet(ws, quiet_ms=400, hard_timeout=1.5)
            err = first_error(msgs, "UNKNOWN_PARAM")
            if err:
                h.ok("error:UNKNOWN_PARAM emitted")
            else:
                h.fail("error:UNKNOWN_PARAM emitted", f"got {msgs}")
        finally:
            await ws.close()
    except Exception as e:
        h.fail("unknown param", f"exception: {e}")


async def test_set_target_idempotent_when_already_at_target(uri: str, h: Harness) -> None:
    print("\n[7] Idempotent repeat — no extra errors")
    try:
        ws, _, _ = await connect_with_hello(uri)
        try:
            # First command: drive to center.
            await set_target(ws, {"neck": {"pulse_width_us": 1500, "duration_ms": 200}})
            await asyncio.sleep(0.4)  # let it settle
            # Second identical command.
            await set_target(ws, {"neck": {"pulse_width_us": 1500, "duration_ms": 200}})
            msgs = await collect_until_quiet(ws, quiet_ms=400, hard_timeout=1.5)
            errors = [m for m in msgs if m.get("type") == "error"]
            if not errors:
                h.ok("repeat command produced no errors")
            else:
                h.fail("repeat command produced no errors", f"got {errors}")
        finally:
            await ws.close()
    except Exception as e:
        h.fail("idempotent", f"exception: {e}")


async def test_set_target_multipart_drives_multiple_parts(uri: str, h: Harness) -> None:
    print("\n[8] Multi-part set_target — one frame, multiple parts")
    try:
        ws, _, _ = await connect_with_hello(uri)
        try:
            await set_target(ws, {
                "neck": {"pulse_width_us": 1245, "duration_ms": 300},
                "foot": {"pulse_width_us": 1700, "duration_ms": 300},
            })
            msgs = await collect_until_quiet(ws, quiet_ms=500, hard_timeout=1.5)
            errors = [m for m in msgs if m.get("type") == "error"]
            if not errors:
                h.ok("multi-part frame accepted without error")
            else:
                h.fail("multi-part frame accepted without error", f"got {errors}")
            # Reset.
            await set_target(ws, {
                "neck": {"pulse_width_us": 1500, "duration_ms": 300},
                "foot": {"pulse_width_us": 1500, "duration_ms": 300},
            })
            await asyncio.sleep(0.4)
        finally:
            await ws.close()
    except Exception as e:
        h.fail("multi-part", f"exception: {e}")


async def test_set_target_recovers_after_dropped_command(uri: str, h: Harness) -> None:
    print("\n[9] Recover after dropped command (heartbeat-style resend)")
    try:
        ws, _, _ = await connect_with_hello(uri)
        try:
            # Simulate dropped frame by sending the SAME target twice with a gap;
            # the body should remain in the requested pose without complaining.
            await set_target(ws, {"neck": {"pulse_width_us": 1245, "duration_ms": 300}})
            await asyncio.sleep(0.5)  # let initial transition complete
            await set_target(ws, {"neck": {"pulse_width_us": 1245, "duration_ms": 300}})  # heartbeat
            msgs = await collect_until_quiet(ws, quiet_ms=300, hard_timeout=1.2)
            errors = [m for m in msgs if m.get("type") == "error"]
            if not errors:
                h.ok("heartbeat-style resend produces no errors")
            else:
                h.fail("heartbeat-style resend", f"errors: {errors}")
            # Reset.
            await set_target(ws, {"neck": {"pulse_width_us": 1500, "duration_ms": 300}})
            await asyncio.sleep(0.4)
        finally:
            await ws.close()
    except Exception as e:
        h.fail("recover", f"exception: {e}")


async def test_busy_on_second_brain(uri: str, h: Harness) -> None:
    print("\n[10] BUSY on second concurrent brain")
    try:
        ws1, _, _ = await connect_with_hello(uri)
        try:
            try:
                ws2 = await connect(uri)
                try:
                    await ws2.send(envelope("hello", {"protos": [PROTOCOL_VERSION]}))
                    err = await drain_until(
                        ws2,
                        lambda m: m.get("body") if m.get("type") == "error" else None,
                        timeout=2.0,
                    )
                    if err and err.get("code") == "BUSY":
                        h.ok("second brain receives BUSY")
                    else:
                        h.fail("second brain receives BUSY", f"got {err}")
                    if err and err.get("fatal") is True:
                        h.ok("BUSY is fatal")
                    else:
                        h.fail("BUSY is fatal", f"got {err}")
                finally:
                    try:
                        await ws2.close()
                    except Exception:
                        pass
            except Exception as e:
                h.fail("second brain connect", f"exception: {e}")
        finally:
            await ws1.close()
    except Exception as e:
        h.fail("busy", f"exception: {e}")


async def test_echo_round_trip(uri: str, h: Harness) -> None:
    print("\n[11] Echo round-trip")
    try:
        ws, _, _ = await connect_with_hello(uri)
        try:
            host_ts = now_ms()
            await ws.send(envelope("echo", {"seq": 1, "host_ts": host_ts}, msg_id="e1"))
            reply = await drain_until(
                ws,
                lambda m: m.get("body") if m.get("type") == "echo_reply" else None,
                timeout=2.0,
            )
            if reply:
                h.ok("echo_reply received")
                if reply.get("seq") == 1 and reply.get("host_ts") == host_ts:
                    h.ok("echo_reply echoes seq + host_ts")
                else:
                    h.fail("echo echo", f"got {reply}")
                if "device_ts" in reply:
                    h.ok("echo_reply carries device_ts")
                else:
                    h.fail("device_ts present", f"got {reply}")
            else:
                h.fail("echo_reply received", "timeout")
        finally:
            await ws.close()
    except Exception as e:
        h.fail("echo", f"exception: {e}")


async def test_applied_ack_on_state_change(uri: str, h: Harness) -> None:
    print("\n[13] `applied` ack on state-changing set_target")
    try:
        ws, _, _ = await connect_with_hello(uri)
        try:
            # Drive to a fresh target with an id; expect one applied:applied back.
            await ws.send(envelope(
                "set_target",
                {"parts": {"neck": {"pulse_width_us": 1245, "duration_ms": 300}}},
                msg_id="ack-1",
            ))
            ack = await drain_until(
                ws,
                lambda m: m if m.get("type") == "applied" else None,
                timeout=1.0,
            )
            if ack:
                h.ok("applied frame received")
                if ack.get("id") == "ack-1":
                    h.ok("applied echoes request id")
                else:
                    h.fail("applied echoes request id", f"got id={ack.get('id')}")
                if ack.get("body", {}).get("status") == "applied":
                    h.ok("applied.status == 'applied'")
                else:
                    h.fail("applied.status == 'applied'", f"got {ack.get('body')}")
            else:
                h.fail("applied frame received", "timeout")
            await asyncio.sleep(0.5)  # let motion settle so next test starts clean
        finally:
            await ws.close()
    except Exception as e:
        h.fail("applied ack", f"exception: {e}")


async def test_applied_silent_on_heartbeat_noop(uri: str, h: Harness) -> None:
    print("\n[14] No `applied` for heartbeat-style no-op resends")
    try:
        ws, _, _ = await connect_with_hello(uri)
        try:
            # First command: drive to a known target. Expect ack.
            await ws.send(envelope(
                "set_target",
                {"parts": {"neck": {"pulse_width_us": 1500, "duration_ms": 200}}},
                msg_id="ack-2a",
            ))
            await drain_until(ws, lambda m: m if m.get("type") == "applied" else None, timeout=1.0)
            await asyncio.sleep(0.4)  # settle
            # Identical resend with a different id — should NOT produce an applied.
            await ws.send(envelope(
                "set_target",
                {"parts": {"neck": {"pulse_width_us": 1500, "duration_ms": 200}}},
                msg_id="ack-2b",
            ))
            msgs = await collect_until_quiet(ws, quiet_ms=300, hard_timeout=1.0)
            applied = next((m for m in msgs if m.get("type") == "applied"), None)
            if applied is None:
                h.ok("no applied for idempotent resend")
            else:
                h.fail("no applied for idempotent resend", f"got {applied}")
        finally:
            await ws.close()
    except Exception as e:
        h.fail("applied silent", f"exception: {e}")


async def test_applied_with_no_id_omits_id(uri: str, h: Harness) -> None:
    print("\n[15] `applied` omits id when request had none")
    try:
        ws, _, _ = await connect_with_hello(uri)
        try:
            # Send without msg_id; ack should also lack id.
            await ws.send(envelope(
                "set_target",
                {"parts": {"neck": {"pulse_width_us": 1300, "duration_ms": 200}}},
            ))
            ack = await drain_until(
                ws,
                lambda m: m if m.get("type") == "applied" else None,
                timeout=1.0,
            )
            if ack and "id" not in ack:
                h.ok("applied has no id field when request had none")
            elif ack:
                h.fail("applied has no id when request had none", f"got id={ack.get('id')}")
            else:
                h.fail("applied frame received", "timeout")
            await asyncio.sleep(0.4)
        finally:
            await ws.close()
    except Exception as e:
        h.fail("applied no-id", f"exception: {e}")


async def test_legacy_set_param_returns_unknown_type(uri: str, h: Harness) -> None:
    print("\n[12] Legacy set_param → error:UNKNOWN_TYPE")
    try:
        ws, _, _ = await connect_with_hello(uri)
        try:
            # Pre-2026-05-27 protocol; body should not accept this anymore.
            await ws.send(envelope("set_param", {"part": "neck", "pulse_width_us": 1500}))
            msgs = await collect_until_quiet(ws, quiet_ms=400, hard_timeout=1.5)
            err = first_error(msgs, "UNKNOWN_TYPE")
            if err:
                h.ok("legacy set_param rejected with UNKNOWN_TYPE")
            else:
                h.fail("legacy set_param rejected with UNKNOWN_TYPE", f"got {msgs}")
            # Bonus: also confirm set_state is rejected (it was the old motion command).
            await ws.send(envelope("set_state", {"part": "neck", "state": "lookUp"}))
            msgs2 = await collect_until_quiet(ws, quiet_ms=400, hard_timeout=1.5)
            if first_error(msgs2, "UNKNOWN_TYPE"):
                h.ok("legacy set_state rejected with UNKNOWN_TYPE")
            else:
                h.fail("legacy set_state rejected", f"got {msgs2}")
        finally:
            await ws.close()
    except Exception as e:
        h.fail("legacy types", f"exception: {e}")


# ───────────────────────────────────────────────────────────────────────────
# Runner
# ───────────────────────────────────────────────────────────────────────────

ALL_TESTS = [
    test_handshake_emits_boot_then_welcome_profile,
    test_profile_has_neck_and_foot_with_correct_params,
    test_set_target_clamps_out_of_range,
    test_clipped_event_emitted_on_clamp,
    test_set_target_emits_unknown_part_error,
    test_set_target_emits_unknown_param_error,
    test_set_target_idempotent_when_already_at_target,
    test_set_target_multipart_drives_multiple_parts,
    test_set_target_recovers_after_dropped_command,
    test_busy_on_second_brain,
    test_echo_round_trip,
    test_applied_ack_on_state_change,
    test_applied_silent_on_heartbeat_noop,
    test_applied_with_no_id_omits_id,
    test_legacy_set_param_returns_unknown_type,
]


async def main_async(args: argparse.Namespace) -> int:
    sim_proc: subprocess.Popen | None = None
    if args.auto_start:
        print(f"starting bodylink_sim.py on port {args.port} ...")
        sim_proc = subprocess.Popen(
            [sys.executable, str(HERE / "bodylink_sim.py"), "--port", str(args.port)],
            preexec_fn=os.setsid,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.STDOUT,
        )
        await asyncio.sleep(1.5)  # give sim a moment to bind

    uri = f"ws://{args.host}:{args.port}/"
    print(f"target: {uri}")
    h = Harness()

    try:
        for t in ALL_TESTS:
            await t(uri, h)
            # Spacing between tests so the body's single-brain gate clears.
            await asyncio.sleep(0.4)
    finally:
        if sim_proc is not None:
            print("\nshutting down sim ...")
            try:
                os.killpg(os.getpgid(sim_proc.pid), signal.SIGTERM)
                sim_proc.wait(timeout=5)
            except Exception:
                sim_proc.kill()

    return h.report()


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--host", default="127.0.0.1", help="Body hostname or IP. 127.0.0.1 for sim, 192.168.1.10 for live XIAO.")
    ap.add_argument("--port", type=int, default=17317)
    ap.add_argument("--auto-start", action="store_true",
                    help="Start bodylink_sim.py in the background for the duration of the test.")
    args = ap.parse_args()

    try:
        return asyncio.run(main_async(args))
    except KeyboardInterrupt:
        return 130


if __name__ == "__main__":
    raise SystemExit(main())

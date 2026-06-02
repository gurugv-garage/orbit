"""bodylink_sim — MuJoCo body that speaks BodyLink protocol over WebSocket.

Pretends to be the ESP32 body. Loads a MuJoCo model + a capability profile,
hosts a WebSocket server on port 17317, drives joints from `set_target`
commands, emits errors and events (no periodic state stream).

Usage:
    python3 bodylink_sim.py
    python3 bodylink_sim.py --port 17317 --profile profiles/dock_companion.json
    python3 bodylink_sim.py --viewer            # MuJoCo viewer

Protocol: see ../DESIGN.md.

2026-05-27 — protocol redesign.
  - Capability profile (parts + primitive params + ranges) replaces named-states.
  - Single command: `set_target` (per-part idempotent; brain uses it for
    both immediate intent and periodic heartbeat).
  - No body→brain state stream.
  - Body clamps to range and emits `error:OUT_OF_RANGE`.

This sim translates incoming pulse_width_us values to MuJoCo joint angles for
visualization. The mapping uses the same linear formula as the firmware:
    radians = (us - 1500) / 636.62, clamped to the joint's MJCF range.
That keeps the viewer roughly in sync with what a real servo would do.

Concurrency model:
    - One asyncio loop.
    - WebSocket I/O on the loop.
    - Physics step is a periodic task at the MuJoCo timestep.
    - One brain at a time; second connection rejected with BUSY.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import logging
import signal
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import mujoco
import numpy as np
import websockets
from websockets.asyncio.server import ServerConnection, serve

HERE = Path(__file__).parent

PROTOCOL_VERSION = 0
LOG = logging.getLogger("bodylink_sim")

# Mapping from sim part name → MuJoCo joint name. The wire protocol speaks
# parts; MuJoCo speaks joints. For v0 the mapping is hand-coded; future
# revisions could carry it in the profile (private field) or a sidecar.
PART_TO_JOINT = {
    "neck": "neck_pitch",
    "foot": "foot_yaw",
    # arm.left / arm.right deferred — not in v0 firmware
}

# Linear pulse_width_us → radians mapping (same as firmware):
#   us = 1500 + r * 636.62
PULSE_CENTER_US = 1500
PULSE_RAD_GAIN  = 636.62

# Body-side defaults for command interpolation when the brain omits them.
DEFAULT_DURATION_MS = 400


# ───────────────────────────────────────────────────────────────────────────
# Envelope helpers
# ───────────────────────────────────────────────────────────────────────────

def now_ms() -> int:
    return int(time.time() * 1000)


def envelope(msg_type: str, body: dict[str, Any], *, msg_id: str | None = None) -> str:
    msg: dict[str, Any] = {"v": PROTOCOL_VERSION, "type": msg_type, "ts": now_ms(), "body": body}
    if msg_id is not None:
        msg["id"] = msg_id
    return json.dumps(msg, separators=(",", ":"))


# ───────────────────────────────────────────────────────────────────────────
# Capability profile loading
# ───────────────────────────────────────────────────────────────────────────

@dataclass
class ParamSpec:
    name: str
    type: str                # "int" | "float"
    unit: str
    range: tuple[float | None, float | None]   # (lo, hi); None = unbounded
    default: float | None = None
    description: str = ""

    def clamp(self, value: float) -> tuple[float, bool]:
        """Return (clamped_value, was_clipped)."""
        lo, hi = self.range
        v = value
        clipped = False
        if lo is not None and v < lo:
            v, clipped = lo, True
        if hi is not None and v > hi:
            v, clipped = hi, True
        if self.type == "int":
            v = int(round(v))
        return v, clipped


@dataclass
class PartSpec:
    name: str
    description: str
    home: dict[str, float]
    params: dict[str, ParamSpec]


@dataclass
class Profile:
    device_id: str
    name: str
    fw_version: str
    parts: dict[str, PartSpec]

    @classmethod
    def load(cls, path: Path) -> "Profile":
        with path.open() as f:
            raw = json.load(f)
        parts: dict[str, PartSpec] = {}
        for pname, pspec in raw.get("parts", {}).items():
            params: dict[str, ParamSpec] = {}
            for paramname, paramspec in pspec.get("params", {}).items():
                r = paramspec.get("range", [None, None])
                params[paramname] = ParamSpec(
                    name=paramname,
                    type=paramspec.get("type", "int"),
                    unit=paramspec.get("unit", ""),
                    range=(r[0] if len(r) > 0 else None,
                           r[1] if len(r) > 1 else None),
                    default=paramspec.get("default"),
                    description=paramspec.get("description", ""),
                )
            parts[pname] = PartSpec(
                name=pname,
                description=pspec.get("description", ""),
                home=dict(pspec.get("home", {})),
                params=params,
            )
        return cls(
            device_id=raw.get("device_id", "mujoco-sim"),
            name=raw.get("name", "dock-sim"),
            fw_version=raw.get("fw_version", "0.0.0"),
            parts=parts,
        )

    def to_wire(self) -> dict[str, Any]:
        """Body of the `profile` message. See DESIGN.md §2."""
        return {
            "device_id": self.device_id,
            "name": self.name,
            "fw_version": self.fw_version,
            "parts": {
                pname: {
                    "description": p.description,
                    "home": p.home,
                    "params": {
                        paramname: {
                            "type": ps.type,
                            "unit": ps.unit,
                            "range": [ps.range[0], ps.range[1]],
                            **({"default": ps.default} if ps.default is not None else {}),
                            "description": ps.description,
                        }
                        for paramname, ps in p.params.items()
                    },
                }
                for pname, p in self.parts.items()
            },
        }


# ───────────────────────────────────────────────────────────────────────────
# Per-part runtime — linear interpolation in primitive param space
# ───────────────────────────────────────────────────────────────────────────

@dataclass
class PartRuntime:
    part: PartSpec
    current: dict[str, float] = field(default_factory=dict)        # current commanded values
    target: dict[str, float] = field(default_factory=dict)         # target values
    started_ms: int = 0
    duration_ms: int = 0
    boot_ms: int = field(default_factory=now_ms)

    def body_clock_ms(self) -> int:
        return now_ms() - self.boot_ms

    def init_home(self) -> None:
        for k, v in self.part.home.items():
            self.current[k] = float(v)
            self.target[k] = float(v)
        self.started_ms = self.body_clock_ms()
        self.duration_ms = 0

    def begin_transition(self, target_vals: dict[str, float], duration_ms: int) -> None:
        # capture current as start, set target, start clock
        for k, v in target_vals.items():
            # leave self.current as the start; target is new
            self.target[k] = float(v)
        self.started_ms = self.body_clock_ms()
        self.duration_ms = max(0, int(duration_ms))
        if self.duration_ms == 0:
            # snap immediately
            for k, v in target_vals.items():
                self.current[k] = float(v)

    def progress(self) -> float:
        if self.duration_ms <= 0:
            return 1.0
        elapsed = self.body_clock_ms() - self.started_ms
        return max(0.0, min(1.0, elapsed / self.duration_ms))

    def tick(self) -> None:
        """Advance current values toward target linearly."""
        p = self.progress()
        for k, tgt in self.target.items():
            start = self.current.get(k, tgt)
            if p >= 1.0:
                self.current[k] = float(tgt)
            else:
                # We linearly interpolate. The "start" for this transition is
                # whatever current was the instant begin_transition fired.
                # We approximate by lerping from current toward target each
                # tick, scaled so it lands on target at p=1.0. This isn't a
                # mathematically-correct linear interp from a fixed start,
                # but it's close enough for sim visualization and matches
                # the firmware's tick-based update.
                remaining_p = 1.0 - p
                if remaining_p > 0:
                    delta_per_tick = (tgt - start) * (1.0 / max(1.0, remaining_p * 10))
                    self.current[k] = start + delta_per_tick


# ───────────────────────────────────────────────────────────────────────────
# Sim — owns MuJoCo model + per-part runtimes
# ───────────────────────────────────────────────────────────────────────────

class Sim:
    def __init__(self, model_path: Path, profile: Profile):
        self.profile = profile
        self.model = mujoco.MjModel.from_xml_path(str(model_path))
        self.data = mujoco.MjData(self.model)

        self.runtime: dict[str, PartRuntime] = {}
        for pname, p in profile.parts.items():
            rt = PartRuntime(part=p)
            rt.init_home()
            self.runtime[pname] = rt

        # Cache actuator ids for the joints we drive.
        self._act_id: dict[str, int] = {}
        for pname in profile.parts:
            joint = PART_TO_JOINT.get(pname)
            if not joint:
                LOG.warning("no MJCF joint mapping for part %r (skipping viz)", pname)
                continue
            act_name = f"a_{joint}"
            aid = mujoco.mj_name2id(self.model, mujoco.mjtObj.mjOBJ_ACTUATOR, act_name)
            if aid < 0:
                LOG.warning("part %r maps to joint %r but actuator %r is missing in MJCF",
                            pname, joint, act_name)
                continue
            self._act_id[pname] = aid

        # Apply each part's home pose to the actuators.
        for pname, rt in self.runtime.items():
            self._push_to_actuator(pname, rt)
        mujoco.mj_forward(self.model, self.data)

    def _push_to_actuator(self, part_name: str, rt: PartRuntime) -> None:
        """Translate current pulse_width_us → joint angle (rad) and write to MuJoCo."""
        aid = self._act_id.get(part_name)
        if aid is None:
            return
        us = rt.current.get("pulse_width_us")
        if us is None:
            return
        rad = (float(us) - PULSE_CENTER_US) / PULSE_RAD_GAIN
        self.data.ctrl[aid] = rad

    def apply_command(
        self,
        part_name: str,
        param_vals: dict[str, float],
    ) -> tuple[list[dict[str, Any]], bool]:
        """Apply `(part, {param: value, ...})`. Returns (emits, changed).

        `emits` carries error/event payloads (UNKNOWN_PART, UNKNOWN_PARAM,
        OUT_OF_RANGE + event:clipped). `changed` is True iff a new transition
        was started (i.e. NOT a no-op against the current target) — drives
        the per-message `applied` ack (DESIGN.md §3.2).
        """
        emits: list[dict[str, Any]] = []
        if part_name not in self.profile.parts:
            emits.append({
                "_kind": "error",
                "code": "UNKNOWN_PART",
                "message": f"unknown part: {part_name!r}",
                "fatal": False,
            })
            return emits, False

        part = self.profile.parts[part_name]
        rt = self.runtime[part_name]

        duration_ms = int(param_vals.get("duration_ms", DEFAULT_DURATION_MS))

        target_vals: dict[str, float] = {}
        for pname, pval in param_vals.items():
            if pname in ("duration_ms", "velocity_us_per_sec_cap"):
                continue
            if pname not in part.params:
                emits.append({
                    "_kind": "error",
                    "code": "UNKNOWN_PARAM",
                    "message": f"part {part_name!r} has no param {pname!r}",
                    "fatal": False,
                })
                continue
            spec = part.params[pname]
            clamped, clipped = spec.clamp(float(pval))
            if clipped:
                emits.append({
                    "_kind": "error",
                    "code": "OUT_OF_RANGE",
                    "message": f"{part_name}.{pname}={pval} clipped to {clamped}",
                    "fatal": False,
                })
                emits.append({
                    "_kind": "event",
                    "kind": "clipped",
                    "part": part_name,
                    "param": pname,
                    "requested": pval,
                    "applied": clamped,
                })
            target_vals[pname] = clamped

        changed = False
        if target_vals:
            # Idempotency: matches firmware semantics — only call begin_transition
            # if the target actually differs from current commanded target.
            for k, v in target_vals.items():
                if rt.target.get(k) != v:
                    changed = True
                    break
            if changed:
                rt.begin_transition(target_vals, duration_ms)

        return emits, changed

    def step(self) -> None:
        mujoco.mj_step(self.model, self.data)
        for pname, rt in self.runtime.items():
            rt.tick()
            self._push_to_actuator(pname, rt)

    def render_snapshot(self, out_path: Path, width: int = 900, height: int = 900,
                        view: str = "front") -> None:
        cam = mujoco.MjvCamera()
        views = {
            "iso":   ((0.80, -0.80, 0.55), (0, 0, 0.20)),
            "side":  ((0.95,  0.00, 0.30), (0, 0, 0.20)),
            "front": ((0.00, -0.95, 0.30), (0, 0, 0.20)),
        }
        cam_pos, lookat = views.get(view, views["front"])
        cam.lookat[:] = lookat
        cam.distance = float(np.linalg.norm(np.array(cam_pos) - np.array(lookat)))
        dx, dy, dz = (np.array(cam_pos) - np.array(lookat))
        cam.azimuth = float(np.degrees(np.arctan2(dy, dx)))
        cam.elevation = float(np.degrees(np.arctan2(dz, np.hypot(dx, dy))))

        renderer = mujoco.Renderer(self.model, height=height, width=width)
        mujoco.mj_forward(self.model, self.data)
        renderer.update_scene(self.data, camera=cam)
        arr = renderer.render()
        renderer.close()

        out_path.parent.mkdir(parents=True, exist_ok=True)
        try:
            import imageio.v3 as iio  # type: ignore
            iio.imwrite(str(out_path), arr)
        except ImportError:
            from PIL import Image  # type: ignore
            Image.fromarray(arr).save(str(out_path))


# ───────────────────────────────────────────────────────────────────────────
# Server — one Brain at a time
# ───────────────────────────────────────────────────────────────────────────

class Server:
    def __init__(self, sim: Sim, port: int):
        self.sim = sim
        self.port = port
        self.current_client: ServerConnection | None = None
        self.outbound_queue: asyncio.Queue[str] = asyncio.Queue()
        self._physics_task: asyncio.Task | None = None
        self._sender_task: asyncio.Task | None = None

    async def physics_loop(self) -> None:
        dt = self.sim.model.opt.timestep
        while True:
            self.sim.step()
            viewer = getattr(self.sim, "_viewer", None)
            if viewer is not None and viewer.is_running():
                viewer.sync()
            await asyncio.sleep(dt)

    async def sender_loop(self) -> None:
        while True:
            msg = await self.outbound_queue.get()
            client = self.current_client
            if client is None:
                continue
            try:
                await client.send(msg)
            except websockets.ConnectionClosed:
                pass

    def _emit(self, payloads: list[dict[str, Any]]) -> None:
        """Convert internal payloads from Sim.apply_command into wire frames."""
        for p in payloads:
            kind = p.pop("_kind")
            if kind == "error":
                self.outbound_queue.put_nowait(envelope("error", p))
            elif kind == "event":
                self.outbound_queue.put_nowait(envelope("event", p))

    async def handle_brain(self, ws: ServerConnection) -> None:
        if self.current_client is not None:
            LOG.warning("rejecting second Brain (already have one)")
            await ws.send(envelope("error", {
                "code": "BUSY",
                "message": "another Brain is already connected",
                "fatal": True,
            }))
            await ws.close()
            return

        LOG.info("Brain connected from %s", ws.remote_address)
        self.current_client = ws
        try:
            # event:boot fires immediately, before handshake.
            await ws.send(envelope("event", {"kind": "boot"}))
            await self._await_hello(ws)
            await ws.send(envelope("welcome", {
                "device_id": self.sim.profile.device_id,
                "name": self.sim.profile.name,
                "fw_version": self.sim.profile.fw_version,
                "proto": PROTOCOL_VERSION,
            }))
            await ws.send(envelope("profile", self.sim.profile.to_wire()))
            LOG.info("handshake complete")

            async for raw in ws:
                await self._handle_message(ws, raw)
        except websockets.ConnectionClosed:
            LOG.info("Brain disconnected")
        except Exception as e:  # noqa: BLE001
            LOG.exception("Brain session error: %s", e)
        finally:
            if self.current_client is ws:
                self.current_client = None
            LOG.info("session ended")

    async def _await_hello(self, ws: ServerConnection) -> None:
        raw = await ws.recv()
        msg = json.loads(raw)
        if msg.get("type") != "hello":
            await ws.send(envelope("error", {
                "code": "BAD_MESSAGE",
                "message": f"expected 'hello', got '{msg.get('type')}'",
                "fatal": True,
            }))
            raise websockets.ConnectionClosed(None, None)
        if msg.get("v") != PROTOCOL_VERSION:
            await ws.send(envelope("error", {
                "code": "BAD_VERSION",
                "message": f"body speaks v{PROTOCOL_VERSION}; brain offered v{msg.get('v')}",
                "fatal": True,
            }))
            raise websockets.ConnectionClosed(None, None)

    async def _handle_message(self, ws: ServerConnection, raw: str) -> None:
        try:
            msg = json.loads(raw)
        except json.JSONDecodeError as e:
            await ws.send(envelope("error", {"code": "BAD_MESSAGE", "message": str(e), "fatal": False}))
            return

        mtype = msg.get("type")
        body = msg.get("body", {}) or {}
        msg_id = msg.get("id")

        if mtype == "set_target":
            parts = body.get("parts", {}) or {}
            if not isinstance(parts, dict):
                await ws.send(envelope("error", {
                    "code": "BAD_MESSAGE",
                    "message": "set_target.body.parts must be an object",
                    "fatal": False,
                }))
                return
            any_changed = False
            for part_name, part_vals in parts.items():
                if not isinstance(part_vals, dict):
                    continue
                emits, changed = self.sim.apply_command(part_name, part_vals)
                self._emit(emits)
                if changed:
                    any_changed = True
            # Per-message applied ack (DESIGN.md §3.2). Only emit if at
            # least one part started a new transition — heartbeat resends
            # that no-op produce no ack, keeping wire quiet.
            if any_changed:
                ack_body = {"status": "applied"}
                self.outbound_queue.put_nowait(envelope("applied", ack_body, msg_id=msg_id))
            LOG.debug("set_target across %d parts (changed=%s)", len(parts), any_changed)

        elif mtype == "echo":
            await ws.send(envelope("echo_reply", {
                "seq": body.get("seq"),
                "host_ts": body.get("host_ts"),
                "device_ts": now_ms(),
            }, msg_id=msg_id))

        elif mtype == "snapshot":
            path = body.get("path", "snapshots/cli/last.png")
            view = body.get("view", "front")
            try:
                out = Path(path)
                self.sim.render_snapshot(out, view=view)
                await ws.send(envelope("snapshot_done", {
                    "path": str(out), "view": view,
                }, msg_id=msg_id))
            except Exception as e:  # noqa: BLE001
                await ws.send(envelope("error", {
                    "code": "INTERNAL",
                    "message": f"snapshot failed: {e}",
                    "fatal": False,
                }))

        elif mtype == "hello":
            await ws.send(envelope("error", {
                "code": "BAD_MESSAGE",
                "message": "duplicate hello",
                "fatal": False,
            }))

        else:
            await ws.send(envelope("error", {
                "code": "UNKNOWN_TYPE",
                "message": f"unknown message type: {mtype}",
                "fatal": False,
            }))

    async def run(self) -> None:
        self._physics_task = asyncio.create_task(self.physics_loop(), name="physics")
        self._sender_task = asyncio.create_task(self.sender_loop(), name="sender")

        LOG.info("bodylink-sim listening on ws://0.0.0.0:%d", self.port)
        async with serve(self.handle_brain, "0.0.0.0", self.port):
            stop = asyncio.get_event_loop().create_future()

            def _on_signal() -> None:
                if not stop.done():
                    stop.set_result(None)

            loop = asyncio.get_event_loop()
            for sig in (signal.SIGINT, signal.SIGTERM):
                try:
                    loop.add_signal_handler(sig, _on_signal)
                except NotImplementedError:
                    pass  # windows

            await stop

        for t in (self._physics_task, self._sender_task):
            if t is not None:
                t.cancel()


# ───────────────────────────────────────────────────────────────────────────
# Entrypoint
# ───────────────────────────────────────────────────────────────────────────

async def main_async(args: argparse.Namespace) -> int:
    profile_path = Path(args.profile)
    model_path = Path(args.model)
    if not profile_path.exists():
        print(f"error: profile not found: {profile_path}", file=sys.stderr)
        return 2
    if not model_path.exists():
        print(f"error: model not found: {model_path}", file=sys.stderr)
        return 2

    profile = Profile.load(profile_path)
    sim = Sim(model_path, profile)

    if args.viewer:
        import mujoco.viewer  # type: ignore
        LOG.info("launching MuJoCo viewer ...")
        sim._viewer = mujoco.viewer.launch_passive(sim.model, sim.data)

    server = Server(sim, port=args.port)
    try:
        await server.run()
    finally:
        viewer = getattr(sim, "_viewer", None)
        if viewer is not None:
            viewer.close()
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--port",    type=int, default=17317)
    ap.add_argument("--profile", default=str(HERE / "profiles" / "dock_companion.json"))
    ap.add_argument("--model",   default=str(HERE / "bodies"   / "dock_humanoid.xml"))
    ap.add_argument("--viewer", action="store_true",
                    help="Launch the MuJoCo interactive viewer alongside the server.")
    ap.add_argument("--headless", action="store_true",
                    help="(default) no viewer; alias for not passing --viewer.")
    ap.add_argument("--verbose",  "-v", action="store_true")
    args = ap.parse_args()

    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    )

    try:
        return asyncio.run(main_async(args))
    except KeyboardInterrupt:
        return 0


if __name__ == "__main__":
    raise SystemExit(main())

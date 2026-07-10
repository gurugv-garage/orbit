#!/usr/bin/env python3
"""
Realistic PERCEPTION injector for the in-station soak.

The soak's conversation path (debug/say) is real, but the ego's OTHER input — what it *sensed*
(vision / speech / identity streams) — was falling back to a rolling summary. This injects
faithful snapshot RECORDS straight into the durable perception JSONL that `recordsSince()` /
`perceptionSince()` read, so a *changing environment* flows through the real perception feed.

FAITHFULNESS (the user's constraint — "realistic based on past data, so you know it can actually
be produced"): the record shape here is copied byte-for-byte from real persisted records
(.data/perception/records/<dock>/<day>.jsonl produced by persistRecord). Same source.kind set
(vision / speech / identity), same model names/endpoints the real processors stamp, same
interval/payload fields. These are records the live pipeline genuinely emits — we only choose
WHEN and WHAT, not a new shape.

A SCENE is a coherent moment (empty room · someone present · someone speaking). Emitting a scene
drops the mix of records that scene really produces: identity ("no one" / "1 person"), a vision
line, and any speech lines. Timestamps are real-now IST, so they land after the ego's last
checkpoint and get read on the next introspection.

Usage (as a library, from soak.py):  emit_scene(dock, scene_dict)
Or standalone:  python3 perceive_inject.py dock-redmi empty|present|speaking "optional caption"
"""
import sys, os, json, time
from datetime import datetime, timezone, timedelta

IST = timezone(timedelta(hours=5, minutes=30))
# station runs from orbit-station/server, so records live relative to that cwd
ROOT_CANDIDATES = [
    "orbit-station/server/.data/perception/records",
    "../../../../orbit-station/server/.data/perception/records",
    os.path.expanduser("~/garage/orbit/orbit-station/server/.data/perception/records"),
]


def _root():
    for c in ROOT_CANDIDATES:
        if os.path.isdir(os.path.dirname(c)) or os.path.isdir(c):
            return c
    return ROOT_CANDIDATES[-1]


def _now_iso():
    return datetime.now(IST).isoformat(timespec="milliseconds")


def _append(dock, rec):
    root = _root()
    d = os.path.join(root, dock)
    os.makedirs(d, exist_ok=True)
    day = rec["interval"]["from"][:10]
    with open(os.path.join(d, f"{day}.jsonl"), "a") as f:
        f.write(json.dumps(rec) + "\n")


def _rec(dock, kind, text, src_id, model_name, endpoint, dur_ms=4000, extra=None):
    """One snapshot record in the exact persisted shape."""
    now = _now_iso()
    to = (datetime.now(IST) + timedelta(milliseconds=dur_ms)).isoformat(timespec="milliseconds")
    payload = {"text": text}
    if extra:
        payload.update(extra)
    return {
        "ts": now, "tz": "IST", "dockId": dock,
        "source": {"id": src_id, "kind": kind, "device": "dock-webrtc", "host": "station"},
        "model": {"name": model_name, "endpoint": endpoint},
        "interval": {"from": now, "to": to, "durationMs": dur_ms},
        "payload": payload,
    }


# Record builders — matched to what each real processor stamps (from past-data inspection).
def vision(dock, text):
    return _rec(dock, "vision", text, "app-soakinject", "qwen2.5-vl-3b-mlx-4bit",
                "http://127.0.0.1:8080/temporal", dur_ms=4700,
                extra={"frames": 1, "singleFrame": True, "camMoving": False, "gateTrigger": "change"})


def speech(dock, text, low=False, addressed=None):
    r = _rec(dock, "speech", text + (" [low-confidence]" if low else ""), "app-soakinject",
             "parakeet-tdt-mlx", "http://127.0.0.1:8081", dur_ms=2500)
    # addressed flag: injected speech via `hear` is OVERHEARD (False) by definition — the brain's
    # real path stamps addressed=True for genuinely-addressed turns (`say`). None = leave unset.
    if addressed is not None:
        r["payload"]["addressed"] = addressed
    return r


def identity(dock, text):
    return _rec(dock, "identity", text, "app-soakinject", "face-api", "in-process", dur_ms=1500)


# SCENES — coherent moments. Each is the mix of records that scene genuinely produces.
SCENES = {
    "empty": lambda dock, cap: [
        identity(dock, "no one"),
        vision(dock, cap or "An empty desk with a monitor and some papers. No one is present."),
    ],
    "present": lambda dock, cap: [
        identity(dock, "1 person"),
        vision(dock, cap or "A person is sitting at the desk, looking at their screen."),
    ],
    "speaking": lambda dock, cap: [
        identity(dock, "1 person"),
        vision(dock, cap or "A person is at the desk, turned toward the camera as if talking."),
    ],
}


def emit_scene(dock, scene):
    """scene = {'kind': 'empty'|'present'|'speaking', 'vision': caption?, 'speech': [lines]?}."""
    kind = scene.get("kind", "empty")
    recs = SCENES.get(kind, SCENES["empty"])(dock, scene.get("vision"))
    for line in scene.get("speech", []):
        recs.append(speech(dock, line))
    for r in recs:
        _append(dock, r)
        time.sleep(0.05)  # keep timestamps monotonic + distinct
    return len(recs)


if __name__ == "__main__":
    dock = sys.argv[1] if len(sys.argv) > 1 else "dock-redmi"
    kind = sys.argv[2] if len(sys.argv) > 2 else "present"
    cap = sys.argv[3] if len(sys.argv) > 3 else None
    n = emit_scene(dock, {"kind": kind, "vision": cap})
    print(f"injected {n} {kind} records for {dock} at {_now_iso()}")

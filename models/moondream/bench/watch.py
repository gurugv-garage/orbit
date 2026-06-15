#!/usr/bin/env python3
"""
On-device VLM monitoring benchmark — webcam → VLM at the dock's *exact* stream
spec, measuring latency and showing the model's structured/NL answer per frame.

Why this exists: orbit's dock streams a low-rate VP8 video that is really a
~1 Hz slideshow of 320×240 face-analysis frames (node-dock app
FaceTracker.kt setTargetResolution(320,240) → FaceFrameCapturer → VideoSource).
A monitoring VLM that runs on the orbit-station side (perception processor →
Ollama) will see frames at THAT resolution. So this harness captures the laptop
webcam and downscales to 320×240 before inference — no surprises vs production.
A 640px variant is included because that's the dock's recognition-still path
(captureRecognitionJpegBase64 maxEdge=640) and the accuracy/latency tradeoff is
the real decision.

Output per frame, per model: latency (ms) + the model's answer. The instruction
is natural language; `--format json` asks the model to return JSON (the
"switchable" structured-vs-NL the orbit processor will use).

Models talk to a local Ollama (http://localhost:11434). Start it and pull:
    ollama serve &
    ollama pull moondream
    ollama pull qwen2.5vl:3b

Run:
    python3 watch.py --models moondream,qwen2.5vl:3b \
        --instruction "Is there a person at the desk? What are they doing?"

This module is also imported by console.py (the interactive driver) — keep the
core (capture, gate, infer) reusable and side-effect free on import.
"""

from __future__ import annotations

import argparse
import base64
import json
import sys
import time
from dataclasses import dataclass, field
from typing import Optional

try:
    import cv2  # opencv-python
    import numpy as np
    import requests
except ImportError as e:  # pragma: no cover - setup guidance
    sys.stderr.write(
        f"Missing dependency: {e.name}. Run: pip install -r requirements.txt\n"
    )
    raise SystemExit(1)


OLLAMA_URL = "http://localhost:11434"

# The dock's live monitoring stream spec — match it exactly (see module docstring).
STREAM_W, STREAM_H = 320, 240
# The dock's recognition-still spec (high-res path), for the tradeoff comparison.
RECOG_MAX_EDGE = 640

DEFAULT_INSTRUCTION = "Describe what you see. Note any people and what they are doing."


# --------------------------------------------------------------------------- #
# Frame capture — match the dock's resolution.
# --------------------------------------------------------------------------- #
@dataclass
class Camera:
    """Laptop webcam, opened once, downscaled per-read to a target resolution."""

    index: int = 0
    _cap: Optional["cv2.VideoCapture"] = field(default=None, repr=False)

    def open(self) -> None:
        self._cap = cv2.VideoCapture(self.index)
        if not self._cap or not self._cap.isOpened():
            raise RuntimeError(
                f"Could not open webcam index {self.index}. "
                "On macOS, grant camera permission to your terminal "
                "(System Settings → Privacy & Security → Camera)."
            )
        # Warm up: the first few frames are often black/garbage.
        for _ in range(5):
            self._cap.read()
            time.sleep(0.05)

    def read(self, w: int = STREAM_W, h: int = STREAM_H) -> "np.ndarray":
        """One BGR frame, resized to (w,h) — the dock's path is a hard resize to
        320×240, so we do the same (no aspect-preserving letterbox)."""
        if self._cap is None:
            raise RuntimeError("Camera not opened")
        ok, frame = self._cap.read()
        if not ok or frame is None:
            raise RuntimeError("Webcam read failed")
        return cv2.resize(frame, (w, h), interpolation=cv2.INTER_AREA)

    def close(self) -> None:
        if self._cap is not None:
            self._cap.release()
            self._cap = None


def frame_to_jpeg_b64(frame: "np.ndarray", quality: int = 80) -> str:
    """Encode a BGR frame as base64 JPEG — the wire form Ollama wants, and the
    same form the dock uses for recognition stills (JPEG q80)."""
    ok, buf = cv2.imencode(".jpg", frame, [int(cv2.IMWRITE_JPEG_QUALITY), quality])
    if not ok:
        raise RuntimeError("JPEG encode failed")
    return base64.b64encode(buf.tobytes()).decode("ascii")


# --------------------------------------------------------------------------- #
# Change gate — the thing that actually keeps the laptop cool. Only run the VLM
# when the scene meaningfully changes (mean abs pixel delta on a tiny gray frame).
# --------------------------------------------------------------------------- #
@dataclass
class ChangeGate:
    threshold: float = 6.0  # mean abs delta (0-255) over a 64×48 gray thumbnail
    _prev: Optional["np.ndarray"] = field(default=None, repr=False)

    def changed(self, frame: "np.ndarray") -> tuple[bool, float]:
        small = cv2.cvtColor(cv2.resize(frame, (64, 48)), cv2.COLOR_BGR2GRAY)
        if self._prev is None:
            self._prev = small
            return True, 255.0
        delta = float(np.mean(cv2.absdiff(small, self._prev)))
        self._prev = small
        return delta >= self.threshold, delta


# --------------------------------------------------------------------------- #
# Inference — one Ollama call. Returns (text, latency_ms, ok).
# --------------------------------------------------------------------------- #
@dataclass
class InferResult:
    model: str
    text: str
    latency_ms: float
    ok: bool
    error: str = ""
    # Ollama timing breakdown (ns → ms) when available.
    load_ms: float = 0.0
    eval_ms: float = 0.0


def build_prompt(instruction: str, want_json: bool) -> str:
    if want_json:
        return (
            f"{instruction}\n\n"
            "Respond ONLY with a compact JSON object. No prose, no markdown fences. "
            'Use this shape: {"answer": <string>, "match": <true|false>, '
            '"objects": [<string>...], "note": <string>}. '
            '"match" = whether the thing the instruction asks about is happening.'
        )
    return instruction


def infer(
    model: str,
    image_b64: str,
    instruction: str,
    want_json: bool = False,
    timeout: float = 120.0,
    keep_alive: str = "10m",
) -> InferResult:
    """Single VLM call against local Ollama. keep_alive holds the model in VRAM
    so we measure steady-state latency, not cold reload, across frames."""
    prompt = build_prompt(instruction, want_json)
    body = {
        "model": model,
        "prompt": prompt,
        "images": [image_b64],
        "stream": False,
        "keep_alive": keep_alive,
        "options": {"temperature": 0.0},
    }
    if want_json:
        body["format"] = "json"  # Ollama-enforced JSON

    t0 = time.perf_counter()
    try:
        r = requests.post(f"{OLLAMA_URL}/api/generate", json=body, timeout=timeout)
        r.raise_for_status()
        data = r.json()
    except Exception as e:  # noqa: BLE001 - report any failure as a result row
        return InferResult(model, "", (time.perf_counter() - t0) * 1e3, False, str(e))

    latency_ms = (time.perf_counter() - t0) * 1e3
    return InferResult(
        model=model,
        text=(data.get("response") or "").strip(),
        latency_ms=latency_ms,
        ok=True,
        load_ms=data.get("load_duration", 0) / 1e6,
        eval_ms=data.get("eval_duration", 0) / 1e6,
    )


def ollama_up() -> bool:
    try:
        requests.get(f"{OLLAMA_URL}/api/tags", timeout=3).raise_for_status()
        return True
    except Exception:  # noqa: BLE001
        return False


def installed_models() -> list[str]:
    try:
        r = requests.get(f"{OLLAMA_URL}/api/tags", timeout=3)
        r.raise_for_status()
        return [m["name"] for m in r.json().get("models", [])]
    except Exception:  # noqa: BLE001
        return []


# --------------------------------------------------------------------------- #
# Latency stats — running summary so you can compare models at the end.
# --------------------------------------------------------------------------- #
@dataclass
class Stats:
    samples: dict[str, list[float]] = field(default_factory=dict)

    def add(self, model: str, latency_ms: float) -> None:
        self.samples.setdefault(model, []).append(latency_ms)

    def summary(self) -> str:
        if not self.samples:
            return "(no samples)"
        lines = ["", "── latency summary (ms) ──", f"{'model':<22} {'n':>4} {'p50':>8} {'p90':>8} {'max':>8}"]
        for model, xs in self.samples.items():
            s = sorted(xs)
            p50 = s[len(s) // 2]
            p90 = s[min(len(s) - 1, int(len(s) * 0.9))]
            lines.append(f"{model:<22} {len(s):>4} {p50:>8.0f} {p90:>8.0f} {max(s):>8.0f}")
        return "\n".join(lines)


# --------------------------------------------------------------------------- #
# CLI loop.
# --------------------------------------------------------------------------- #
def run_loop(args: argparse.Namespace) -> int:
    models = [m.strip() for m in args.models.split(",") if m.strip()]
    sizes: list[tuple[int, int, str]] = [(STREAM_W, STREAM_H, "stream320")]
    if args.also_640:
        sizes.append((RECOG_MAX_EDGE, int(RECOG_MAX_EDGE * 3 / 4), "recog640"))

    if not ollama_up():
        sys.stderr.write(
            "Ollama is not running. Start it:  ollama serve &\n"
        )
        return 1
    have = installed_models()
    missing = [m for m in models if m not in have and f"{m}:latest" not in have]
    if missing:
        sys.stderr.write(
            "Models not pulled: " + ", ".join(missing) + "\n"
            + "Pull them:  " + "  ".join(f"ollama pull {m}" for m in missing) + "\n"
        )
        return 1

    cam = Camera(index=args.camera)
    cam.open()
    gate = ChangeGate(threshold=args.gate)
    stats = Stats()
    print(
        f"Watching webcam #{args.camera} → "
        + ", ".join(f"{w}×{h}({tag})" for w, h, tag in sizes)
        + f" | models: {', '.join(models)} | format: {'json' if args.json else 'nl'}"
        + f" | gate Δ≥{args.gate} | interval {args.interval}s\n"
        + "Ctrl-C to stop.\n"
    )

    n = 0
    try:
        while args.max == 0 or n < args.max:
            loop_t0 = time.perf_counter()
            frame = cam.read()  # 320×240, for the gate
            run, delta = (True, 0.0) if args.no_gate else gate.changed(frame)
            if not run:
                _sleep_remaining(loop_t0, args.interval)
                continue

            n += 1
            ts = time.strftime("%H:%M:%S")
            print(f"[{ts}] frame {n}  Δ={delta:.1f}")
            for w, h, tag in sizes:
                f = frame if (w, h) == (STREAM_W, STREAM_H) else cam.read(w, h)
                img = frame_to_jpeg_b64(f)
                for model in models:
                    res = infer(model, img, args.instruction, want_json=args.json)
                    label = f"{model}@{tag}"
                    stats.add(label, res.latency_ms)
                    if res.ok:
                        print(f"    {label:<28} {res.latency_ms:7.0f}ms  {res.text}")
                    else:
                        print(f"    {label:<28} {res.latency_ms:7.0f}ms  ERROR {res.error}")
            _sleep_remaining(loop_t0, args.interval)
    except KeyboardInterrupt:
        pass
    finally:
        cam.close()
        print(stats.summary())
    return 0


def _sleep_remaining(t0: float, interval: float) -> None:
    rem = interval - (time.perf_counter() - t0)
    if rem > 0:
        time.sleep(rem)


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        description="On-device VLM webcam monitoring benchmark (matches the dock's 320×240 stream).",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    p.add_argument("--models", default="moondream,qwen2.5vl:3b",
                   help="comma-separated Ollama model tags")
    p.add_argument("--instruction", default=DEFAULT_INSTRUCTION,
                   help="natural-language monitoring instruction")
    p.add_argument("--json", action="store_true",
                   help="ask for structured JSON output (Ollama format=json)")
    p.add_argument("--interval", type=float, default=2.0,
                   help="seconds between frames (1-2s = the dock's cadence)")
    p.add_argument("--gate", type=float, default=6.0,
                   help="change threshold (mean pixel delta) to trigger inference")
    p.add_argument("--no-gate", action="store_true",
                   help="run every interval regardless of change (worst-case load)")
    p.add_argument("--also-640", action="store_true",
                   help="ALSO run the 640px recognition-still size for comparison")
    p.add_argument("--camera", type=int, default=0, help="webcam index")
    p.add_argument("--max", type=int, default=0, help="stop after N inferred frames (0 = forever)")
    return p


def main(argv: Optional[list[str]] = None) -> int:
    return run_loop(build_parser().parse_args(argv))


if __name__ == "__main__":
    raise SystemExit(main())

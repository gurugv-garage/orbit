#!/usr/bin/env python3
"""
System-load profiler for the on-device VLMs — answers "which model costs what"
on this Apple-Silicon laptop, not just latency.

For each model it runs N webcam frames (at the dock's 320×240) back-to-back and,
in parallel, samples:
  - GPU active residency + package power via `powermetrics` (needs sudo)
  - the ollama process's CPU% and resident RAM via `ps`
and reports per-model averages alongside latency.

Why powermetrics + sudo: on Apple Silicon the work is on the GPU/ANE, and the
only first-party way to see GPU active-% and watts is `powermetrics`, which is
root-only. CPU%/RAM come from `ps` (no sudo).

Run (it will prompt for your password once, for powermetrics):
    python3 profile_load.py --models moondream,qwen2.5vl:3b --frames 5

If you'd rather not give sudo, use --no-gpu (CPU+RAM only, no password).
"""

from __future__ import annotations

import argparse
import re
import statistics as st
import subprocess
import sys
import threading
import time

import watch as w


# --------------------------------------------------------------------------- #
# powermetrics sampler — runs in a thread, parses GPU active-% and package W.
# --------------------------------------------------------------------------- #
class PowerSampler(threading.Thread):
    """Continuously parse `sudo powermetrics` for GPU residency + power.
    Samples are appended with a timestamp so a caller can slice a time window."""

    def __init__(self, interval_ms: int = 500) -> None:
        super().__init__(daemon=True)
        self.interval_ms = interval_ms
        self.samples: list[tuple[float, float, float]] = []  # (ts, gpu_pct, watts)
        self._stop = threading.Event()
        self._proc: subprocess.Popen | None = None
        self.error: str | None = None

    def run(self) -> None:
        cmd = [
            "sudo", "powermetrics",
            "--samplers", "gpu_power",
            "-i", str(self.interval_ms),
        ]
        try:
            self._proc = subprocess.Popen(
                cmd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True
            )
        except Exception as e:  # noqa: BLE001
            self.error = str(e)
            return
        gpu_pct = None
        for line in self._proc.stdout:  # type: ignore[union-attr]
            if self._stop.is_set():
                break
            m = re.search(r"GPU (?:HW )?active residency:\s+([\d.]+)%", line)
            if m:
                gpu_pct = float(m.group(1))
            mp = re.search(r"(?:Combined|Package|GPU) Power:\s+([\d.]+)\s*mW", line)
            if mp and gpu_pct is not None:
                self.samples.append((time.time(), gpu_pct, float(mp.group(1)) / 1000.0))

    def stop(self) -> None:
        self._stop.set()
        if self._proc:
            try:
                self._proc.terminate()
            except Exception:  # noqa: BLE001
                pass

    def window(self, t0: float, t1: float) -> tuple[float, float]:
        """avg (gpu_pct, watts) over [t0,t1]; (0,0) if no samples landed."""
        xs = [(g, p) for (ts, g, p) in self.samples if t0 <= ts <= t1]
        if not xs:
            return 0.0, 0.0
        return st.mean(g for g, _ in xs), st.mean(p for _, p in xs)


def ollama_rss_mb_and_cpu() -> tuple[float, float]:
    """Resident MB + CPU% summed across ollama processes (the runner that holds
    the model is a child 'ollama runner')."""
    try:
        out = subprocess.run(
            ["ps", "-axo", "rss,%cpu,comm"], capture_output=True, text=True, check=True
        ).stdout
    except Exception:  # noqa: BLE001
        return 0.0, 0.0
    rss = cpu = 0.0
    for line in out.splitlines():
        if "ollama" in line.lower():
            parts = line.split()
            if len(parts) >= 2:
                try:
                    rss += float(parts[0]) / 1024.0
                    cpu += float(parts[1])
                except ValueError:
                    pass
    return rss, cpu


# --------------------------------------------------------------------------- #
def profile(args: argparse.Namespace) -> int:
    models = [m.strip() for m in args.models.split(",") if m.strip()]
    if not w.ollama_up():
        sys.stderr.write("Ollama not running: ollama serve &\n")
        return 1

    sampler = None
    if not args.no_gpu:
        sampler = PowerSampler(interval_ms=500)
        sampler.start()
        time.sleep(2)  # let powermetrics spin up / sudo prompt clear
        if sampler.error:
            sys.stderr.write(f"powermetrics failed ({sampler.error}); falling back to CPU+RAM only\n")
            sampler = None

    cam = w.Camera(index=args.camera)
    cam.open()
    instruction = args.instruction
    rows = []

    for model in models:
        print(f"\n── {model}: warming up …")
        img0 = w.frame_to_jpeg_b64(cam.read())
        w.infer(model, img0, instruction)  # cold load, discarded

        lat, gpu, watts, rss, cpu = [], [], [], [], []
        print(f"   running {args.frames} frames …")
        for i in range(args.frames):
            img = w.frame_to_jpeg_b64(cam.read())
            t0 = time.time()
            res = w.infer(model, img, instruction)
            t1 = time.time()
            lat.append(res.latency_ms)
            r, c = ollama_rss_mb_and_cpu()
            rss.append(r); cpu.append(c)
            if sampler:
                g, p = sampler.window(t0, t1)
                gpu.append(g); watts.append(p)
            print(f"     frame {i+1}: {res.latency_ms:6.0f}ms"
                  + (f"  gpu {gpu[-1]:4.0f}%  {watts[-1]:4.1f}W" if sampler else "")
                  + f"  rss {rss[-1]:5.0f}MB  cpu {cpu[-1]:4.0f}%")

        rows.append({
            "model": model,
            "lat": st.mean(lat),
            "gpu": st.mean(gpu) if gpu else None,
            "watts": st.mean(watts) if watts else None,
            "rss": max(rss),
            "cpu": st.mean(cpu),
        })

    cam.close()
    if sampler:
        sampler.stop()

    # -- report ----------------------------------------------------------- #
    print("\n" + "=" * 72)
    print("LOAD per model (averages over warm frames @ 320×240)")
    print("=" * 72)
    hdr = f"{'model':<18} {'lat ms':>8} {'GPU %':>7} {'power W':>9} {'RAM MB':>8} {'CPU %':>7}"
    print(hdr)
    for r in rows:
        gpu = f"{r['gpu']:.0f}" if r["gpu"] is not None else "n/a"
        watts = f"{r['watts']:.1f}" if r["watts"] is not None else "n/a"
        print(f"{r['model']:<18} {r['lat']:>8.0f} {gpu:>7} {watts:>9} {r['rss']:>8.0f} {r['cpu']:>7.0f}")
    print("\nGPU%/power = while a call is running (peak duty). At a gated 1/min")
    print("cadence the *sustained* load is this × (call_seconds / 60).")
    return 0


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description="Profile system load of local VLMs.")
    p.add_argument("--models", default="moondream,qwen2.5vl:3b")
    p.add_argument("--frames", type=int, default=5, help="warm frames to average per model")
    p.add_argument("--instruction", default="Is there a person in view? What are they doing?")
    p.add_argument("--camera", type=int, default=0)
    p.add_argument("--no-gpu", action="store_true", help="skip powermetrics (no sudo); CPU+RAM only")
    return p


if __name__ == "__main__":
    raise SystemExit(profile(build_parser().parse_args()))

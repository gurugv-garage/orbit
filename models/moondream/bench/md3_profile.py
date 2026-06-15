#!/usr/bin/env python3
"""
Load profile for moondream3 (MLX 4-bit) — the cost side of the md3-for-NL plan.
Measures: model load time, process RSS before/after load, MLX Metal GPU memory
(via mlx.core.metal — no sudo needed), and per-frame inference latency over N
warm frames at the dock's 320×240.

    python3 md3_profile.py --frames 8
"""
from __future__ import annotations
import argparse, os, time
import cv2
from PIL import Image


def rss_mb() -> float:
    import resource
    # macOS ru_maxrss is bytes; this process's peak RSS.
    return resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1e6


def gpu_mb() -> float:
    try:
        import mlx.core as mx
        # active memory currently allocated by MLX on the GPU
        return mx.get_active_memory() / 1e6
    except Exception:
        return 0.0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--frames", type=int, default=8)
    ap.add_argument("--camera", type=int, default=0)
    a = ap.parse_args()

    rss0 = rss_mb()
    from md3 import MD3
    t0 = time.perf_counter()
    m = MD3()
    load_s = time.perf_counter() - t0
    rss1 = rss_mb()
    gpu1 = gpu_mb()
    print(f"load: {load_s:.1f}s   RSS {rss0:.0f}→{rss1:.0f}MB (+{rss1-rss0:.0f})   GPU active {gpu1:.0f}MB")

    cam = cv2.VideoCapture(a.camera)
    for _ in range(5):
        cam.read(); time.sleep(0.05)

    q = "What is in the image and what is happening?"
    # warm
    ok, f = cam.read(); f = cv2.resize(f, (320, 240))
    m.ask(Image.fromarray(cv2.cvtColor(f, cv2.COLOR_BGR2RGB)), q)
    gpu_warm = gpu_mb()

    lat = []
    gpu_peak = gpu_warm
    for i in range(a.frames):
        ok, f = cam.read(); f = cv2.resize(f, (320, 240))
        pil = Image.fromarray(cv2.cvtColor(f, cv2.COLOR_BGR2RGB))
        _, ms = m.ask(pil, q)
        lat.append(ms)
        try:
            import mlx.core as mx
            gpu_peak = max(gpu_peak, mx.get_peak_memory() / 1e6)
        except Exception:
            pass
        print(f"  frame {i+1}: {ms:6.0f}ms")
    cam.release()

    s = sorted(lat)
    p = lambda q: s[min(len(s) - 1, int(len(s) * q))]
    print(f"\nmoondream3-mlx-4bit  n={a.frames}  p50 {p(0.5):.0f}ms  p90 {p(0.9):.0f}ms  "
          f"max {s[-1]:.0f}ms")
    print(f"process RSS after load: {rss1:.0f}MB   GPU active(warm): {gpu_warm:.0f}MB   "
          f"GPU peak: {gpu_peak:.0f}MB")


if __name__ == "__main__":
    main()

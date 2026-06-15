#!/usr/bin/env python3
"""
Head-to-head: moondream2 (Ollama q4) vs moondream3-preview (MLX 4-bit) on the
SAME live frames at the dock's 320×240. For each frame, each model answers an NL
query and the documented "return as json: ..." phrasing; we show answer + latency
side by side so the quality/cost tradeoff is visible.

    python3 compare.py --frames 4
"""
from __future__ import annotations
import argparse, base64, json, time
import cv2, requests
from PIL import Image
from md3 import MD3

OLLAMA = "http://localhost:11434"
W, H = 320, 240
NL = "What is in the image and what is happening?"
JSONP = "return as json: present, activity, unusual"


def md2(prompt, b64, fmt):
    body = {"model": "moondream", "prompt": prompt, "images": [b64], "stream": False,
            "keep_alive": "10m", "options": {"temperature": 0}}
    if fmt:
        body["format"] = "json"
    t = time.perf_counter()
    r = requests.post(f"{OLLAMA}/api/generate", json=body, timeout=120)
    return r.json().get("response", "").strip(), (time.perf_counter() - t) * 1e3


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--frames", type=int, default=4)
    ap.add_argument("--camera", type=int, default=0)
    a = ap.parse_args()

    print("loading moondream3 (MLX) …")
    m3 = MD3()
    print(f"  loaded {m3.load_s:.1f}s\n")

    cam = cv2.VideoCapture(a.camera)
    for _ in range(5):
        cam.read(); time.sleep(0.05)

    for i in range(a.frames):
        ok, frame = cam.read()
        frame = cv2.resize(frame, (W, H))
        b64 = base64.b64encode(cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, 80])[1]).decode()
        pil = Image.fromarray(cv2.cvtColor(frame, cv2.COLOR_BGR2RGB))

        print(f"==================== frame {i+1} ====================")
        # NL
        a2, t2 = md2(NL, b64, False)
        a3, t3 = m3.ask(pil, NL)
        print(f"[NL]  md2 {t2:5.0f}ms : {a2}")
        print(f"      md3 {t3:5.0f}ms : {a3}")
        # documented JSON phrasing (md2 needs format=json; md3 native)
        j2, tj2 = md2(JSONP, b64, True)
        j3, tj3 = m3.ask(pil, JSONP)
        print(f"[JSON] md2 {tj2:5.0f}ms : {j2}")
        print(f"       md3 {tj3:5.0f}ms : {j3}")
        print()

    cam.release()


if __name__ == "__main__":
    main()

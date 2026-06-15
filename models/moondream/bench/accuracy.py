#!/usr/bin/env python3
"""
Proper accuracy comparison: md2 (Ollama) vs md3 (MLX), NL only, on the SAME
frames — and it SAVES each frame to disk (frames/frame_NN.jpg) so the actual
scene can be verified by eye, instead of trusting either model or my assumptions.

For each frame it asks both an open NL question and a few SPECIFIC checkable
questions (count, what's in hand, etc.) so the answers can be graded against the
saved image rather than vibes.

    python3 accuracy.py --frames 6 --interval 2
Then open frames/ and compare answers to what's actually there.
"""
from __future__ import annotations
import argparse, base64, os, time
import cv2, requests
from PIL import Image
from md3 import MD3

OLLAMA = "http://localhost:11434"
W, H = 320, 240
OUT = os.path.join(os.path.dirname(__file__), "frames")

# Open + specific checkable questions.
QUESTIONS = [
    "Describe what is in the image and what is happening.",
    "How many people are in the image?",
    "What is the person holding, if anything?",
]


def md2(prompt, b64):
    body = {"model": "moondream", "prompt": prompt, "images": [b64],
            "stream": False, "keep_alive": "10m", "options": {"temperature": 0}}
    t = time.perf_counter()
    r = requests.post(f"{OLLAMA}/api/generate", json=body, timeout=120)
    return r.json().get("response", "").strip(), (time.perf_counter() - t) * 1e3


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--frames", type=int, default=6)
    ap.add_argument("--interval", type=float, default=2.0)
    ap.add_argument("--camera", type=int, default=0)
    a = ap.parse_args()
    os.makedirs(OUT, exist_ok=True)

    print("loading md3 …")
    m3 = MD3()
    print(f"  {m3.load_s:.1f}s\n")

    cam = cv2.VideoCapture(a.camera)
    for _ in range(5):
        cam.read(); time.sleep(0.05)

    for i in range(a.frames):
        ok, frame = cam.read()
        frame = cv2.resize(frame, (W, H))
        path = os.path.join(OUT, f"frame_{i+1:02d}.jpg")
        cv2.imwrite(path, frame)  # SAVE so we can verify ground truth
        b64 = base64.b64encode(cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, 80])[1]).decode()
        pil = Image.fromarray(cv2.cvtColor(frame, cv2.COLOR_BGR2RGB))

        print(f"===== frame {i+1}  (saved {os.path.relpath(path)}) =====")
        for q in QUESTIONS:
            ans2, _ = md2(q, b64)
            ans3, _ = m3.ask(pil, q)
            print(f"  Q: {q}")
            print(f"    md2: {ans2}")
            print(f"    md3: {ans3}")
        print()
        if i < a.frames - 1:
            time.sleep(a.interval)
    cam.release()
    print(f"Frames saved in {OUT}/ — open them to grade the answers.")


if __name__ == "__main__":
    main()

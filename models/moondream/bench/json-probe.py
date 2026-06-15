#!/usr/bin/env python3
"""
JSON-extraction probe — test moondream's DOCUMENTED json phrasing
("return as json: a, b, c") on the same live frames, several ways, and report
which actually yields parseable JSON. Earlier we failed by demanding a typed
schema with format=json; the moondream docs instead use a plain
"return as json: field, field" instruction. This isolates that.

Strategies tested per frame (moondream2 via Ollama):
  A. docs phrasing, NO format=json   "return as json: present, activity, unusual"
  B. docs phrasing, WITH format=json
  C. typed-schema prompt (our original failing approach), for contrast

Usage:
    python3 json-probe.py --model moondream --frames 5
"""
from __future__ import annotations
import argparse, base64, json, sys, time
import cv2, requests

OLLAMA = "http://localhost:11434"
W, H = 320, 240


def grab(cam) -> str:
    ok, f = cam.read()
    f = cv2.resize(f, (W, H))
    ok2, buf = cv2.imencode(".jpg", f, [cv2.IMWRITE_JPEG_QUALITY, 80])
    return base64.b64encode(buf.tobytes()).decode()


def call(model, prompt, img, fmt_json):
    body = {"model": model, "prompt": prompt, "images": [img], "stream": False,
            "keep_alive": "10m", "options": {"temperature": 0}}
    if fmt_json:
        body["format"] = "json"
    t0 = time.perf_counter()
    r = requests.post(f"{OLLAMA}/api/generate", json=body, timeout=120)
    ms = (time.perf_counter() - t0) * 1e3
    return r.json().get("response", "").strip(), ms


def parses(txt):
    try:
        obj = json.loads(txt)
        return isinstance(obj, dict) and len(obj) > 0, obj
    except Exception:
        return False, None


DOCS = "Return as json: present, activity, unusual"
SCHEMA = ('Describe the scene. Respond ONLY with JSON, keys: '
          '"present" (true/false), "activity" (string), "unusual" (string).')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", default="moondream")
    ap.add_argument("--frames", type=int, default=5)
    ap.add_argument("--camera", type=int, default=0)
    a = ap.parse_args()

    cam = cv2.VideoCapture(a.camera)
    for _ in range(5):
        cam.read(); time.sleep(0.05)

    strategies = [
        ("A docs-phrasing no-format", DOCS, False),
        ("B docs-phrasing +format   ", DOCS, True),
        ("C typed-schema +format    ", SCHEMA, True),
    ]
    score = {name: [0, 0, 0.0] for name, _, _ in strategies}  # ok, n, ms

    print(f"JSON probe: {a.model} @ {W}×{H}, {a.frames} frames\n")
    for i in range(a.frames):
        img = grab(cam)
        print(f"frame {i+1}:")
        for name, prompt, fmt in strategies:
            txt, ms = call(a.model, prompt, img, fmt)
            ok, obj = parses(txt)
            score[name][0] += int(ok); score[name][1] += 1; score[name][2] += ms
            shown = json.dumps(obj) if ok else f'RAW {txt[:90]!r}'
            print(f"  {name}  {ms:6.0f}ms  {'OK ' if ok else 'NO '} {shown}")
        print()
    cam.release()

    print("== summary (parseable-JSON rate) ==")
    for name, (ok, n, ms) in score.items():
        print(f"  {name}  {ok}/{n} ({100*ok//max(n,1)}%)  avg {ms/max(n,1):.0f}ms")


if __name__ == "__main__":
    main()

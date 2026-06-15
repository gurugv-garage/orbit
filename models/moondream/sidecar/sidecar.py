#!/usr/bin/env python3
"""
Moondream vision sidecar — the single local HTTP service the orbit-station
perception processor calls to turn a frame + instruction into an answer.

One interface, two backends (chosen by --backend), so prod can start on md2 and
swap to md3 without the orbit TS side changing:

  --backend md2   moondream2 via a running Ollama (DEFAULT, prod). ~1.3 GB GPU,
                  ~1.1 s/frame. Zero model weights here — just proxies Ollama.
  --backend md3   moondream3-preview via MLX 4-bit, loaded in-process. ~5.4 GB
                  GPU, ~1.3 s/frame, more accurate. Needs mlx-vlm + the model.

API (mirrors the shape the TS processor expects):

  GET  /health            -> {ok, backend, model}
  POST /infer             -> {answer, latency_ms, backend}
       body: {image_b64, instruction, max_tokens?}

The image is expected already at the dock's 320x240 (the processor downsizes to
match the live stream); the sidecar does not resize.

Run:
  python3 sidecar.py --backend md2 --port 8077
  python3 sidecar.py --backend md3 --port 8077

See ../FINDINGS.md for why md2 is the starting prod backend and what md3 buys.
"""
from __future__ import annotations
import argparse, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json as _json

OLLAMA_URL = "http://localhost:11434"


# --------------------------------------------------------------------------- #
# Backends — each is (instruction, image_b64) -> answer string.
# --------------------------------------------------------------------------- #
class Md2Backend:
    """moondream2 via Ollama. Holds no weights; proxies /api/generate."""
    name = "md2"
    model = "moondream"

    def __init__(self) -> None:
        import requests
        self._req = requests
        # warm/keep-alive ping (non-fatal if Ollama is down at boot)
        try:
            requests.post(f"{OLLAMA_URL}/api/generate",
                          json={"model": self.model, "keep_alive": "30m", "prompt": ""},
                          timeout=5)
        except Exception:
            pass

    def infer(self, instruction: str, image_b64: str, max_tokens: int) -> str:
        r = self._req.post(
            f"{OLLAMA_URL}/api/generate",
            json={"model": self.model, "prompt": instruction, "images": [image_b64],
                  "stream": False, "keep_alive": "30m",
                  "options": {"temperature": 0, "num_predict": max_tokens}},
            timeout=120,
        )
        r.raise_for_status()
        return (r.json().get("response") or "").strip()


class Md3Backend:
    """moondream3-preview via MLX 4-bit, loaded in-process (see bench/md3.py)."""
    name = "md3"
    model = "beshkenadze/moondream3-preview-mlx-4bit"

    def __init__(self) -> None:
        import sys, os
        sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "bench"))
        from md3 import MD3  # reuse the benched runner so they can't drift
        self._m = MD3()

    def infer(self, instruction: str, image_b64: str, max_tokens: int) -> str:
        import base64, io
        from PIL import Image
        img = Image.open(io.BytesIO(base64.b64decode(image_b64))).convert("RGB")
        ans, _ = self._m.ask(img, instruction, max_tokens=max_tokens)
        return ans


def make_backend(name: str):
    if name == "md2":
        return Md2Backend()
    if name == "md3":
        return Md3Backend()
    raise SystemExit(f"unknown backend {name!r} (use md2 or md3)")


# --------------------------------------------------------------------------- #
# HTTP server.
# --------------------------------------------------------------------------- #
def make_handler(backend):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *a):  # quiet
            pass

        def _send(self, code, obj):
            body = _json.dumps(obj).encode()
            self.send_response(code)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):
            if self.path == "/health":
                self._send(200, {"ok": True, "backend": backend.name, "model": backend.model})
            else:
                self._send(404, {"error": "not found"})

        def do_POST(self):
            if self.path != "/infer":
                self._send(404, {"error": "not found"})
                return
            n = int(self.headers.get("content-length", 0))
            try:
                req = _json.loads(self.rfile.read(n) or b"{}")
            except Exception as e:
                self._send(400, {"error": f"bad json: {e}"})
                return
            img = req.get("image_b64")
            instr = req.get("instruction")
            if not img or not instr:
                self._send(400, {"error": "image_b64 and instruction required"})
                return
            t0 = time.perf_counter()
            try:
                ans = backend.infer(instr, img, int(req.get("max_tokens", 128)))
            except Exception as e:
                self._send(500, {"error": str(e)})
                return
            self._send(200, {"answer": ans, "latency_ms": (time.perf_counter() - t0) * 1e3,
                             "backend": backend.name})

    return Handler


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--backend", default="md2", choices=["md2", "md3"])
    ap.add_argument("--port", type=int, default=8077)
    ap.add_argument("--host", default="127.0.0.1")
    a = ap.parse_args()

    print(f"loading backend {a.backend} …")
    t0 = time.perf_counter()
    backend = make_backend(a.backend)
    print(f"  ready in {time.perf_counter()-t0:.1f}s — {backend.name} ({backend.model})")
    srv = ThreadingHTTPServer((a.host, a.port), make_handler(backend))
    print(f"sidecar listening on http://{a.host}:{a.port}  (POST /infer, GET /health)")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\nbye")


if __name__ == "__main__":
    main()

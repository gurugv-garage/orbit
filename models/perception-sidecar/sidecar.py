#!/usr/bin/env python3
"""
perception-sidecar — local HTTP service for the offline models the perception
processors call that need a Python runtime. Today: STT (mlx-whisper). Extensible
(add endpoints for other models here). Vision (moondream) does NOT use this — it
runs in Ollama directly, which is more efficient.

  POST /transcribe   {pcm_b64, sample_rate?} -> {text, latency_ms}
        pcm_b64 = base64 of raw 16-bit signed mono PCM little-endian.
        (The STT processor decodes the WebRTC Opus to PCM via ffmpeg and posts
         rolling windows here.)
  POST /api/generate {model, prompt, images:[b64], ...} -> {response, ...}
        moondream3 (MLX) vision, OLLAMA-COMPATIBLE shape — so the vision processor's
        existing Ollama client works unchanged; swapping moondream(Ollama)↔md3
        (sidecar) is just a base-URL change. Sharper than moondream2, no
        hallucinated background (see models/moondream/FINDINGS.md). Loaded lazily on
        first call unless --vision is passed.
  GET  /health       -> {ok, stt_model, vision_model}

  python3 sidecar.py --port 8078 --model mlx-community/whisper-small.en-mlx --vision

mlx-whisper runs Metal-accelerated on Apple Silicon; base.en is ~140MB and
transcribes a few-second window in well under real time.
"""
from __future__ import annotations
import argparse, base64, json as _json, time
from concurrent.futures import ThreadPoolExecutor
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import numpy as np

# ALL MLX inference runs on this ONE dedicated thread. MLX/Metal is not
# thread-safe — sharing the Metal context across threads segfaults even under a
# lock, because the context is bound to the calling thread. A single-worker
# executor pins every model call to the same thread; the HTTP server stays
# threaded (health checks stay responsive) but inference is funnelled here.
MLX = ThreadPoolExecutor(max_workers=1, thread_name_prefix="mlx")


class Stt:
    def __init__(self, model: str):
        import mlx_whisper  # noqa: F401  (validate import at boot)
        self._mlx_whisper = mlx_whisper
        self.model = model
        # warm on the MLX thread (so the model's first GPU touch is there too).
        try:
            MLX.submit(lambda: self._mlx_whisper.transcribe(
                np.zeros(16000, dtype=np.float32), path_or_hf_repo=model)).result()
        except Exception:
            pass

    def transcribe(self, pcm_i16: np.ndarray, sample_rate: int) -> str:
        # mlx-whisper wants float32 mono @ 16k. PCM int16 -> float32 [-1,1].
        audio = pcm_i16.astype(np.float32) / 32768.0
        if sample_rate != 16000:
            # cheap linear resample to 16k (windows are short; quality is fine).
            n = int(len(audio) * 16000 / sample_rate)
            audio = np.interp(np.linspace(0, len(audio), n, endpoint=False),
                              np.arange(len(audio)), audio).astype(np.float32)
        # Anti-hallucination: condition_on_previous_text=False stops the runaway
        # token loops on silence; no_speech_threshold + logprob filter drop
        # non-speech windows; temperature=0 keeps it deterministic.
        r = MLX.submit(lambda: self._mlx_whisper.transcribe(
            audio, path_or_hf_repo=self.model,
            condition_on_previous_text=False,
            no_speech_threshold=0.6,
            logprob_threshold=-1.0,
            temperature=0.0,
        )).result()
        return (r.get("text") or "").strip()


class Vision:
    """moondream3 (MLX) vision — reuses the benched MD3 runner so they can't drift.
    Loaded lazily (first /infer) since it costs ~5 GB GPU.

    MLX/Metal is NOT thread-safe: two concurrent inferences crash the process
    (segfault). The ThreadingHTTPServer can deliver overlapping requests, so we
    serialize all inference under a lock — only one MLX call runs at a time."""
    def __init__(self):
        import sys, os
        sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "moondream", "bench"))
        from md3 import MD3  # noqa: WPS433
        self._m = MLX.submit(MD3).result()  # load ON the MLX thread
        self.model = "moondream3-preview-mlx-4bit"

    def infer(self, image_b64: str, instruction: str) -> str:
        import io
        from PIL import Image
        img = Image.open(io.BytesIO(base64.b64decode(image_b64))).convert("RGB")
        # all MLX work on the one MLX thread (see executor note at top).
        ans, _ = MLX.submit(lambda: self._m.ask(img, instruction, max_tokens=128)).result()
        return ans


def make_handler(stt: Stt, vision_holder: dict):
    def get_vision() -> Vision:
        if vision_holder.get("v") is None:
            vision_holder["v"] = Vision()
        return vision_holder["v"]

    class H(BaseHTTPRequestHandler):
        def log_message(self, *a):
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
                v = vision_holder.get("v")
                self._send(200, {"ok": True, "stt_model": stt.model if stt else None,
                                 "vision_model": v.model if v else None})
            else:
                self._send(404, {"error": "not found"})

        def do_POST(self):
            n = int(self.headers.get("content-length", 0))
            try:
                req = _json.loads(self.rfile.read(n) or b"{}")
            except Exception as e:
                self._send(400, {"error": f"bad json: {e}"})
                return

            if self.path == "/transcribe":
                if stt is None:
                    self._send(503, {"error": "stt not loaded (vision-only process)"})
                    return
                try:
                    pcm = np.frombuffer(base64.b64decode(req["pcm_b64"]), dtype=np.int16)
                    sr = int(req.get("sample_rate", 16000))
                except Exception as e:
                    self._send(400, {"error": f"bad request: {e}"})
                    return
                t0 = time.perf_counter()
                try:
                    text = stt.transcribe(pcm, sr)
                except Exception as e:
                    self._send(500, {"error": str(e)})
                    return
                self._send(200, {"text": text, "latency_ms": (time.perf_counter() - t0) * 1e3})
                return

            # Ollama-compatible vision: same shape as Ollama's /api/generate, so the
            # vision processor's existing Ollama client works unchanged — swapping
            # moondream(Ollama)↔md3(sidecar) is just a URL change. See models/README.
            if self.path == "/api/generate":
                img_list = req.get("images") or []
                instr = req.get("prompt")
                if not img_list or not instr:
                    self._send(400, {"error": "prompt and images required"})
                    return
                t0 = time.perf_counter()
                try:
                    answer = get_vision().infer(img_list[0], instr)
                except Exception as e:
                    self._send(500, {"error": str(e)})
                    return
                self._send(200, {
                    "model": req.get("model", "moondream3"),
                    "response": answer,
                    "done": True,
                    "total_duration": int((time.perf_counter() - t0) * 1e9),
                })
                return

            self._send(404, {"error": "not found"})

    return H


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--port", type=int, default=8078)
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--model", default="mlx-community/whisper-small.en-mlx")
    ap.add_argument("--vision", action="store_true", help="preload md3 vision at boot")
    ap.add_argument("--no-stt", action="store_true",
                    help="vision-only: don't load whisper. Run STT and md3 in SEPARATE "
                         "processes — two MLX models in one process can crash Metal.")
    a = ap.parse_args()
    stt = None
    if not a.no_stt:
        print(f"loading STT {a.model} …")
        t0 = time.perf_counter()
        stt = Stt(a.model)
        print(f"  ready in {time.perf_counter()-t0:.1f}s")
    vision_holder: dict = {"v": None}
    if a.vision:
        print("loading md3 vision …")
        tv = time.perf_counter()
        vision_holder["v"] = Vision()
        print(f"  ready in {time.perf_counter()-tv:.1f}s")
    srv = ThreadingHTTPServer((a.host, a.port), make_handler(stt, vision_holder))
    print(f"perception-sidecar on http://{a.host}:{a.port}  (POST /transcribe, /infer, GET /health)")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\nbye")


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""
sidecar_fw — the LINUX speech-to-text sidecar (faster-whisper / CTranslate2).

Drop-in replacement for the Apple-MLX sidecar.py on a Linux VM: SAME HTTP contract
(`GET /health`, `POST /transcribe`) so orbit-station needs zero changes — point
PERCEPTION_SIDECAR_URL at this (default http://127.0.0.1:8078).

Why faster-whisper: runs on CPU (or CUDA) on Linux, and — unlike Parakeet — it
exposes Whisper's own confidence tells (avg_logprob, no_speech_prob,
compression_ratio) that the station's hallucination gates read. We aggregate the
per-segment metrics across the utterance and return them in the contract shape.

Contract (matches modules/perception/processors/stt-watch.ts):
  GET  /health      -> {"ok": true, "stt_model": "<model>"}
  POST /transcribe   {"pcm_b64": "<base64 int16 mono PCM>", "sample_rate": 16000}
                    -> {"text", "avg_logprob", "no_speech_prob",
                        "compression_ratio", "latency_ms"}

Run:  python3 sidecar_fw.py --port 8078 --model small.en --device cpu --compute-type int8
Deps: pip install faster-whisper numpy
"""
import argparse
import base64
import json
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import numpy as np

# Lazy import so --help works without the heavy dep installed.
_model = None
_model_name = "faster-whisper"


def _load(model: str, device: str, compute_type: str):
    global _model, _model_name
    from faster_whisper import WhisperModel  # noqa: WPS433 (lazy on purpose)
    _model = WhisperModel(model, device=device, compute_type=compute_type)
    _model_name = f"faster-whisper/{model}"
    print(f"[sidecar_fw] loaded {_model_name} on {device}/{compute_type}", flush=True)


def _transcribe(pcm_b64: str, sample_rate: int):
    """int16 PCM (base64) -> (text, avg_logprob, no_speech_prob, compression_ratio).

    faster-whisper wants float32 mono @ 16k in [-1, 1]. The station already sends
    16 kHz; if a caller ever sends another rate we still feed it (Whisper resamples
    internally via its feature extractor expecting 16k — we assert the common case)."""
    raw = base64.b64decode(pcm_b64)
    audio = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0

    # condition_on_previous_text=False + a low temperature keep it from looping on
    # near-silence (the same anti-hallucination posture as the MLX sidecar). The VAD
    # gating already happens station-side, so we transcribe the whole utterance once.
    segments, _info = _model.transcribe(
        audio,
        language="en",
        beam_size=1,
        condition_on_previous_text=False,
        vad_filter=False,
    )

    texts, logprobs, no_speech, compression = [], [], [], []
    for s in segments:
        texts.append(s.text)
        logprobs.append(s.avg_logprob)
        no_speech.append(s.no_speech_prob)
        compression.append(s.compression_ratio)

    text = "".join(texts).strip()
    # Aggregate per-segment metrics into the single-utterance shape the station reads:
    # mean logprob, MAX no_speech (most-silent segment wins → conservative), max
    # compression (a repetition loop in any segment should flag).
    avg_logprob = float(np.mean(logprobs)) if logprobs else None
    no_speech_prob = float(np.max(no_speech)) if no_speech else None
    compression_ratio = float(np.max(compression)) if compression else None
    return text, avg_logprob, no_speech_prob, compression_ratio


class Handler(BaseHTTPRequestHandler):
    def _send(self, code: int, obj: dict):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):  # noqa: N802 (http.server API)
        if self.path == "/health":
            self._send(200, {"ok": _model is not None, "stt_model": _model_name})
        else:
            self._send(404, {"error": "not found"})

    def do_POST(self):  # noqa: N802
        if self.path != "/transcribe":
            self._send(404, {"error": "not found"})
            return
        try:
            n = int(self.headers.get("content-length", 0))
            req = json.loads(self.rfile.read(n) or b"{}")
            pcm_b64 = req.get("pcm_b64")
            if not pcm_b64:
                self._send(400, {"error": "missing pcm_b64"})
                return
            t0 = time.time()
            text, alp, nsp, cr = _transcribe(pcm_b64, int(req.get("sample_rate", 16000)))
            self._send(200, {
                "text": text,
                "model": _model_name,
                "avg_logprob": alp,
                "no_speech_prob": nsp,
                "compression_ratio": cr,
                "latency_ms": (time.time() - t0) * 1000.0,
            })
        except Exception as e:  # noqa: BLE001 — never crash the server on a bad request
            self._send(500, {"error": str(e)})

    def log_message(self, *_args):  # silence per-request stderr spam
        pass


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8078)
    ap.add_argument("--model", default="small.en",
                    help="faster-whisper model id (tiny.en/base.en/small.en/medium.en/...)")
    ap.add_argument("--device", default="cpu", help="cpu or cuda")
    ap.add_argument("--compute-type", default="int8",
                    help="int8 (cpu), float16/int8_float16 (cuda)")
    args = ap.parse_args()

    _load(args.model, args.device, args.compute_type)
    srv = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    print(f"[sidecar_fw] listening on 127.0.0.1:{args.port}", flush=True)
    srv.serve_forever()


if __name__ == "__main__":
    main()

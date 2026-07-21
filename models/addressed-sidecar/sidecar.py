#!/usr/bin/env python3
"""
addressed-sidecar — local HTTP service that scores an STT utterance for
"was this spoken TO the dock?" (addressed vs overheard room chatter), OBSERVE-ONLY.

This is the shadow-mode tap from docs/findings/should-respond-gate/. It does NOT
gate anything — the station stamps the score onto the perception speech record so we
can watch it label real utterances live and calibrate a threshold before it ever
gates. See docs/findings/should-respond-gate/EXPLAINER.md for what/why.

  POST /addressed  {text, context?} -> {addressed: 0..1, latency_ms}
        text    = the STT transcript of the utterance.
        context = optional recent conversation as [{role:'user'|'assistant', text}]
                  (last few turns). More context = better score; empty is fine.
        addressed = P(spoken to the dock), the classifier-head sigmoid output.
  GET  /health     -> {ok, base_model, head_dim}

  python3 sidecar.py --port 8081 --base Qwen/Qwen3-0.6B --head head.npz

Method (proven at CV AUC 0.94 / temporal 0.90, 31ms): run the utterance+context
through the FROZEN base LM, take the last-token hidden state (dim 1024), standardize,
and apply a linear logistic-regression HEAD trained offline. We change NO model
weights — the base is frozen; only the tiny head (head.npz: w, b, mu, sd) decides.
Same MLX/http house style as models/perception-sidecar/sidecar.py.
"""
from __future__ import annotations
import argparse, json as _json, re, time
from concurrent.futures import ThreadPoolExecutor
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import numpy as np

# MLX forward passes serialized on one worker (Metal is single-context here).
MLX = ThreadPoolExecutor(max_workers=1, thread_name_prefix="mlx")


def _fmt_ctx(context: list | None) -> str:
    """Mirror the training prompt's context format EXACTLY (docs/findings)."""
    if not context:
        return ""
    parts = []
    for c in context[-3:]:
        who = "U:" if c.get("role") == "user" else "D:"
        t = re.sub(r"\[face:[a-z]+\]\s*", "", (c.get("text") or "")).strip()[:80]
        parts.append(f"{who}{t}")
    return " / ".join(parts)


def _prompt(text: str, context: list | None) -> str:
    # MUST match extract_features.py / temporal_test.py in the findings dir.
    return (
        f'Conversation so far: {_fmt_ctx(context)}\n'
        f'New utterance heard: "{text}"\n'
        f'Question: was this spoken to the robot?'
    )


class AddressedClassifier:
    """Frozen base LM + a linear head. Loads once at boot."""

    def __init__(self, base: str, head_path: str):
        from mlx_lm import load  # validate import at boot
        import mlx.core as mx
        self._mx = mx
        self._model, self._tok = load(base)
        h = np.load(head_path)
        self._w = h["w"].astype(np.float32)
        self._b = float(h["b"])
        self._mu = h["mu"].astype(np.float32)
        self._sd = h["sd"].astype(np.float32)
        self.base = base
        self.dim = int(self._w.shape[0])
        # warmup (first forward pass compiles the graph)
        self._score("warmup", None)

    def _feature(self, text: str, context: list | None) -> np.ndarray:
        mx = self._mx
        ids = self._tok.encode(_prompt(text, context))
        h = self._model.model(mx.array([ids]))[0, -1, :].astype(mx.float32)
        mx.eval(h)
        return np.array(h)

    def _score(self, text: str, context: list | None) -> float:
        f = (self._feature(text, context) - self._mu) / self._sd
        z = float(f @ self._w + self._b)
        return 1.0 / (1.0 + np.exp(-z))

    def addressed(self, text: str, context: list | None) -> float:
        # run on the MLX worker so calls serialize cleanly
        return MLX.submit(self._score, text, context).result()


class Handler(BaseHTTPRequestHandler):
    clf: AddressedClassifier = None  # set in main()

    def _send(self, code: int, obj: dict):
        body = _json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *_a):  # quiet
        pass

    def do_GET(self):
        if self.path == "/health":
            self._send(200, {"ok": True, "base_model": self.clf.base, "head_dim": self.clf.dim})
        else:
            self._send(404, {"error": "not found"})

    def do_POST(self):
        if self.path != "/addressed":
            self._send(404, {"error": "not found"})
            return
        try:
            n = int(self.headers.get("Content-Length", 0))
            req = _json.loads(self.rfile.read(n) or b"{}")
            text = (req.get("text") or "").strip()
            if not text:
                self._send(400, {"error": "text required"})
                return
            t0 = time.time()
            p = self.clf.addressed(text, req.get("context"))
            self._send(200, {"addressed": round(p, 4), "latency_ms": round((time.time() - t0) * 1000, 1)})
        except Exception as e:  # never crash the server on a bad request
            self._send(500, {"error": str(e)[:200]})


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8081)
    ap.add_argument("--base", default="Qwen/Qwen3-0.6B")
    ap.add_argument("--head", default="head.npz")
    args = ap.parse_args()

    print(f"[addressed-sidecar] loading base={args.base} head={args.head} ...", flush=True)
    Handler.clf = AddressedClassifier(args.base, args.head)
    print(f"[addressed-sidecar] ready on :{args.port}  (base={args.base}, head_dim={Handler.clf.dim})", flush=True)
    ThreadingHTTPServer(("127.0.0.1", args.port), Handler).serve_forever()


if __name__ == "__main__":
    main()

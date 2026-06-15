# moondream sidecar

The local HTTP service orbit-station's perception processor calls to turn a
frame + instruction into an answer. One interface, two backends — prod starts on
md2, swaps to md3 with a flag, and the orbit TS side never changes.

## Run

```bash
pip install -r requirements.txt

python3 sidecar.py --backend md2          # PROD — moondream2 via Ollama (default)
python3 sidecar.py --backend md3          # upgrade — moondream3 via MLX (heavier)
python3 sidecar.py --backend md2 --port 8077 --host 127.0.0.1
```

`md2` requires a running Ollama with `moondream` pulled. `md3` requires
`mlx-vlm` + the model (uncomment them in `requirements.txt`) and loads the
weights in-process (~5.4 GB GPU) — see [../FINDINGS.md](../FINDINGS.md).

## API

```
GET  /health   -> {"ok": true, "backend": "md2", "model": "moondream"}

POST /infer
  body: {"image_b64": "<jpeg base64>", "instruction": "...", "max_tokens": 128?}
  ->   {"answer": "...", "latency_ms": 1100.0, "backend": "md2"}
```

The image is expected **already at 320×240** (the processor resizes to match the
dock's live stream); the sidecar does not resize. JSON is intentionally not
requested from the model — ask an open instruction and derive structure from the
answer (see FINDINGS.md "Structured output").

## Backends

| `--backend` | Model | Runtime | GPU | Latency | Use |
|---|---|---|---|---|---|
| `md2` (default) | moondream2 | Ollama `:11434` | 1.3 GB | ~1.1 s | **prod start** |
| `md3` | moondream3-preview | MLX in-process | 5.4 GB | ~1.3 s | accuracy upgrade |

Both reuse the benched code paths (md3 imports `../bench/md3.py`) so the service
and the benchmarks can't drift.

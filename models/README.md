# models — on-device model implementations & benchmarks

Self-contained home for the ML models orbit runs on-device (vision, and later
STT/others): the runnable implementation, the benchmark/evaluation code, and the
findings that justified each choice. Kept separate from `orbit-station` so model
work (Python, MLX, model weights) doesn't entangle the Node control plane; the
station talks to these via a small local HTTP **sidecar**.

## Layout

| Folder | What |
|---|---|
| [moondream/](moondream/) | The monitoring **VLM** — "watch a frame, answer a natural-language instruction." Prod backend: **moondream2 via Ollama**; upgrade path: **moondream3 via MLX**. See its [README](moondream/README.md) and [FINDINGS.md](moondream/FINDINGS.md). |

## How orbit uses these

The dock streams ~1 Hz 320×240 video to orbit-station's media SFU. A perception
processor (`orbit-station/.../perception/processors/`) grabs a keyframe and POSTs
it to a model **sidecar** here (`POST /infer`), then emits the result as a
`PerceptionResult`. The sidecar is the seam: prod runs the light Ollama backend;
swapping to a heavier MLX model is a sidecar flag, invisible to the station.

## Convention

Each model folder carries its own `sidecar/` (the service), `bench/` (eval
code), `ts/` (any TS shared with the station's processor), `fixtures/` (a few
committed sample frames for reproducible runs), and a `FINDINGS.md` recording
measured benchmarks + the decision. **Update FINDINGS.md whenever a benchmark
conclusion changes** — it's the durable record.

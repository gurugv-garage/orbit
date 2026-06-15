# moondream — monitoring VLM

The on-device vision-language model orbit uses to watch the dock's camera and
answer natural-language instructions ("is someone at the desk? what are they
doing?"), a frame every 1–2 s.

**Prod backend: moondream2 via Ollama** (light, accurate enough, zero extra
runtime). **Upgrade path: moondream3 via MLX** (better seeing, ~4× the memory).
The full benchmark record and the reasoning are in **[FINDINGS.md](FINDINGS.md)** —
read that for the decision.

## Layout

| Folder | What |
|---|---|
| [sidecar/](sidecar/) | **The production service.** One HTTP interface, two backends (`--backend md2`\|`md3`). The orbit perception processor POSTs frames here. |
| [bench/](bench/) | Benchmark + eval scripts (Python): latency/load profilers, accuracy + structure probes, interactive monitor. How every number in FINDINGS.md was produced. |
| [ts/](ts/) | TypeScript port of the client + structure-extraction (the `polarity()` NL→bool parser the station processor reuses). |
| [fixtures/](fixtures/) | A few committed 320×240 frames for reproducible benchmark runs. |

## Quick start (prod backend)

```bash
# 1. Ollama + the model (one time)
ollama serve &
ollama pull moondream

# 2. the sidecar
cd sidecar
pip install -r requirements.txt
python3 sidecar.py --backend md2        # http://127.0.0.1:8077

# 3. call it
curl -s localhost:8077/infer -H 'content-type: application/json' \
  -d '{"image_b64":"<jpeg b64>","instruction":"Describe what is happening."}'
```

See [sidecar/README.md](sidecar/README.md) for the API and the md3 backend.

## Running the benchmarks

```bash
cd bench
pip install -r requirements.txt
python3 watch.py --instruction "is someone at the desk?"   # live monitor (CLI)
python3 console.py                                          # live REPL
python3 accuracy.py --frames 6                              # md2 vs md3, saves frames
```

## Key facts (see FINDINGS.md for detail)

- **Match the dock:** everything runs at **320×240** (the dock's live stream res).
- **md2 memory 1.3 GB, md3 5.4 GB** (~+4 GB); latency ~1.1 s vs ~1.3 s/frame.
- **Don't ask for JSON locally** — md2 returns empty on closed/format prompts and
  loose values under `format=json`. Ask **open** questions, parse the prose.
- **md3 is not in Ollama** (no GGUF / unsupported arch) — it only runs via MLX,
  which is why its sidecar backend loads it in-process.

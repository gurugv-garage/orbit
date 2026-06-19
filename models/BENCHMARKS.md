# Perception model benchmarks — footprint & performance

> These are the **measurements**; the as-built pipeline and the per-component
> decisions they drove are in
> [docs/perception-pipeline.md](../docs/perception-pipeline.md).

The single reference for every model we evaluated for orbit's perception pipeline,
organized **by scenario** (what you're trying to do). All numbers measured on an
Apple-Silicon MacBook at the dock's stream resolution unless noted. "Footprint" =
GPU/unified memory while loaded; "latency" = per-call wall time, warm (cold load
excluded — first call adds 5–15 s while weights load).

> Caveat on accuracy numbers: scene/action accuracy is graded by eye against
> known frames, not a formal metric, except STT which uses WER on standard
> datasets. Vision accuracy depends heavily on camera framing and resolution.

---

## TL;DR — what we shipped, and why

| Scenario | Chosen model | Footprint | Latency | Why |
|---|---|---|---|---|
| Scene + action (temporal) | **Qwen2.5-VL-3B · MLX 4-bit** | ~3 GB | ~6 s / 5-frame | one VLM does scene AND action; real temporal reasoning |
| Speech → text | **Whisper small.en · MLX (quantized)** | ~1 GB | ~0.1–0.7 s / utterance | best accuracy/size; VAD-endpointed |
| Who (identity) | **face-api (TF.js)** | ~0.15 GB | ~tens of ms | embedding match; a VLM can't do identity |

Total always-on ≈ **~4 GB**. (We started at ~10 GB stacking moondream+md3+qwen and
hit 7 GB of swap — see "Overhead" below.)

> **All footprints here are for QUANTIZED models** (the MLX builds are 4-bit; the
> Ollama builds are 4-bit GGUF unless noted). Full-precision (bf16/fp16) versions
> are ~2× larger — e.g. Qwen2.5-VL-3B is ~3 GB at 4-bit but ~6–7 GB at bf16. The
> numbers below assume the 4-bit/quantized weights we actually run. Quantization
> trades a small accuracy hit for ~½ the memory; 8-bit is the middle option if
> accuracy ever matters more than RAM.

---

## Scenario 1 — Per-frame vision ("what's in this frame right now")

Single image → description. Cheap, ~1 Hz. The dock streams 320×240; resolution
matters a lot here.

| Model | Footprint | Latency @512px | Accuracy (320px) | Accuracy (512px) | Notes |
|---|---|---|---|---|---|
| **moondream2** (Ollama, phi2, 4-bit GGUF / Q4_0) | 1.3 GB | ~1.0 s | poor — hallucinates ("gym", "clock") | core right, invents background | Plain VQA. Returns EMPTY on closed/yes-no/JSON prompts. Deterministic. |
| **moondream3-preview** (MLX **4-bit**) | 5.4 GB (peak 6.5) | ~1.5 s | accurate, no hallucination | accurate + reads fine detail (goatee, expression, stripes) | Best per-frame accuracy; native query/detect/point skills. BSL-1.1 license. |
| **Qwen2.5-VL-3B** (MLX **4-bit**) | ~3 GB GPU (~3.7 GB process RSS) | ~5.6 s | accurate, no person-hallucination | accurate | Slower per-frame, but also does temporal (see scenario 2). |

**Key findings (per-frame):**
- **moondream2 hallucinates below 512px** — the dock's 320×240 is part of the
  problem. It plateaus at ~512px (its encoder downsamples internally; 960px wasted).
- **moondream2 is a describer, not a judge** — empty on "Is there a cup?" / JSON;
  works on open "What is in this image?". Steer must be woven as "…including X",
  not appended as a command.
- **md3 is the accuracy winner per-frame** but 4× the RAM of moondream2.
- Latency is ~flat across resolution for moondream (internal resize).

**Decision:** we DROPPED the per-frame pass — Qwen temporal (scenario 2) covers
scene + action in one call, avoiding a second vision model. md3 stays available
(`vision-watch` + the md3 sidecar) if a fast, precise per-frame pass is wanted.

---

## Scenario 2 — Temporal / action ("what is happening over time")

Multiple frames → action (talking, gesturing, eating, leaving). Needs a model that
reasons across frames; single-image models can't.

| Model · path | Footprint | Latency (4–5 frames) | Motion accuracy | Notes |
|---|---|---|---|---|
| moondream/md3 frame-GRID (2×2) | (as per-frame) | ~1.5 s | crude — reads it's a sequence, weak on motion | hack: stitch frames into one image. md3 reliable about *no* motion. |
| **Qwen2.5-VL-3B · Ollama** (4-bit GGUF, separate images) | 3.2 GB | **~37 s** | ❌ WRONG ("circle stationary") | Ollama gives no temporal encoding — frames seen as unrelated. |
| **Qwen2.5-VL-3B · MLX 4-bit** (video path) | ~3 GB | **~3–6 s** | ✅ correct ("circle moves right, bar grows") | **The unlock.** Native temporal position encoding. ~12× faster than Ollama too. |
| **Qwen2.5-VL-7B · Ollama** (4-bit GGUF) | 6.0 GB | ~25 s | ✅ correct | Size compensates for Ollama's weak path; heavier. |

**Key finding:** *how you feed the frames matters as much as model size.* The same
3B model is WRONG via Ollama and CORRECT via MLX, because MLX encodes frame
order/time. Use **Qwen2.5-VL-3B via MLX** — smallest, fastest-correct, ~3 GB.

**Verified live** (person in frame): correctly read "sitting, speaking and
gesturing with right hand", "talking to the camera". Hallucinates a person on
EMPTY frames unless the prompt forbids it (fixed — prompt no longer presumes a
person).

**Latency in the live pipeline ≈ ~5–10 s end-to-end** = up to 4 s waiting for the
next run (cadence) + ~6 s inference. Tunable via `TEMPORAL_PERIOD_MS` /
`TEMPORAL_WINDOW`, trading GPU load / context for snappiness.

---

## Scenario 3 — Speech → text (STT)

WebRTC Opus → 16 kHz PCM → Whisper. Measured by **Word Error Rate** (WER) on
standard datasets, plus latency.

| Model | Footprint | Disk | Latency (per utterance) | WER LibriSpeech (clean) | WER Earnings-22 (hard) | Notes |
|---|---|---|---|---|---|---|
| **Whisper base.en** (MLX, quantized) | ~0.5 GB | 137 MB | ~0.08 s warm | low (clean English) | 41.0% | 68× real-time. |
| **Whisper small.en** (MLX, quantized) | ~1 GB | 459 MB | ~0.1–0.7 s | lower | 37.5% | 8× real-time. **Chosen** — better on accents/jargon, still far faster than RT. |

**Key findings (STT):**
- Whisper isn't bad, it was **mis-fed** — it hallucinates on silence ("Thank you",
  "I'm sorry" loops). Fixed with **VAD endpointing**: detect utterance start→end,
  transcribe the whole utterance once (no fixed rolling windows). Clean transcripts,
  one per utterance, no silence loops.
- Earnings-22 WER looks high (37–41%) because it's *deliberately brutal* (heavy
  accents, finance jargon) and our slicing had a reference-alignment artifact; on
  clean English both are far lower. It's a stress test, not the baseline.
- **small.en chosen**: meaningfully better on hard speech, still 8× real-time.
- Handles disfluency well — keeps self-corrections ("call John, no wait, call
  Jane"), fillers, numbers ("$427"). A >ENDPOINT_MS mid-sentence pause splits an
  utterance (endpoint set to 1.3 s to avoid splitting natural pauses).

---

## Scenario 4 — Text summarization over observations (tier-2, future)

Fuse N per-frame/utterance facts into "what's been happening". moondream/VLMs
CANNOT do this (text-only task; moondream hallucinates an image). Needs a text LLM.

| Model | Footprint | Latency | Notes |
|---|---|---|---|
| moondream (text-only) | — | — | ❌ garbles / hallucinates a scene. Not usable. |
| **gemma (small, Ollama)** | ~7 GB | ~7–10 s | ✅ correct summaries + structured events ("person appeared then left"). Runs rarely (every ~30 s), so cost amortizes. |

Not yet wired — this is the pyramid's tier 2 (see docs/perception-pipeline.md §9).

---

## Scenario 5 — Identity ("who is this")

| Model | Footprint | Latency | Notes |
|---|---|---|---|
| **face-api** (`@vladmandic/face-api`, TF.js) | ~0.15 GB | ~tens of ms | Embedding match vs an enrolled gallery. A VLM can describe "a man" but CANNOT say "Guru" — identity needs enroll-then-match. Already in production; fuses with the VLM/STT at the perception-state layer. |

---

## Overhead — the lesson

Stacking models per-scenario blew up memory:

| Setup | Footprint | Result |
|---|---|---|
| moondream + md3 + qwen + whisper (all loaded) | ~10 GB | **7 GB swap** — laptop thrashing |
| **qwen (temporal, scene+action) + whisper + face-api** | **~4 GB** | no swap |

**MLX/Metal is not thread-safe** — two MLX models in one process (or concurrent
requests to one) segfault. Fixes that hold: (1) run each MLX model in its OWN
process; (2) funnel all MLX calls through ONE worker thread per process (a lock is
NOT enough — the Metal context binds to the calling thread).

The pyramid principle (docs/perception-pipeline.md §9): the cheaper the model, the more
often it runs; expensive ones run rarely / on demand. Don't pin everything at once.

---

## How to reproduce

- Per-frame & resolution: `models/moondream/bench/` (Python) and `models/moondream/ts/`.
- STT WER: `models/perception-sidecar/bench/wer.py --suite librispeech|earnings22`.
- Temporal: `models/perception-sidecar/qwen_video.py` (MLX), or the `/temporal`
  sidecar endpoint.
- Live (all together): the Perception console, `http://localhost:8099/#perception`.

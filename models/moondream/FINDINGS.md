# Moondream benchmark findings

The durable record of what we measured choosing an on-device VLM for orbit's
"watch a frame every 1–2 s, answer a natural-language instruction" monitoring
use case. All numbers measured on an Apple-Silicon MacBook, at the **dock's live
stream resolution (320×240)** — the dock streams a ~1 Hz VP8 slideshow of
320×240 face-analysis frames (`node-dock` `FaceTracker.kt` →
`FaceFrameCapturer` → WebRTC `VideoSource`), so the VLM sees that resolution in
production. Frames captured from the laptop webcam, hard-resized to 320×240 to
match.

> **Decision: ship on moondream2 (md2) first.** It runs in Ollama (zero extra
> runtime), is light (1.3 GB), and is accurate enough for open scene
> description. moondream3 (md3) is the documented upgrade path — better seeing,
> at ~4× the memory and a separate MLX runtime. See the trade table below.

## Models compared

| | **moondream2** (md2) | **moondream3-preview** (md3) |
|---|---|---|
| Exact build | Ollama `moondream:latest` = `moondream:1.8b-v2-q4_0`, **phi2** backbone + CLIP projector, ~1.8B, Q4_0 GGUF, ctx 2048, Apache-2.0 | `beshkenadze/moondream3-preview-mlx-4bit`, **9B MoE / 2B active**, SigLIP vision, ctx 32K, MLX 4-bit, BSL-1.1 |
| Runtime | **Ollama** (HTTP `:11434`) | **MLX** (mlx-vlm, in-process Python) — *not in Ollama; no GGUF exists* |
| GPU memory (resident) | **1.3 GB** | **5.4 GB** (peak 6.5) |
| Disk | 1.7 GB | 5.0 GB |
| Load time | ~10 s cold (then warm) | ~2–7 s |
| **Latency / frame @ 320×240** | **~1.1 s** (p50) | **~1.3 s** (p50), 1.5 s p90 |
| CPU | ~5 % (GPU-bound) | ~5 % (GPU-bound) |

**Memory is the key delta: md3 costs ~+4 GB GPU RAM (≈4×).** Latency is nearly
identical (+~200 ms). On a 16 GB+ Mac md3 fits with headroom but can't co-reside
with another big model (qwen 7 GB / glm 19 GB). md2 leaves room to spare.

## Accuracy (graded against saved frames, NL only)

Same frames, both models, graded by eye against `fixtures/` images:

| Element (ground truth) | md2 | md3 |
|---|---|---|
| person / red shirt / dark hair / indoors | ✅ every frame | ✅ every frame |
| black office chair / headrest | partial | ✅ |
| wicker hanging chair behind | ❌ never | ✅ |
| window with night/city view | ✅ (sometimes) | ✅ |
| hand near head (action) | ❌ ("head resting") | ✅ ("touching his hair") |
| "how many people?" (closed Q) | ❌ **empty** | ✅ "1 person" |
| "what holding?" (closed Q) | ❌ empty | ✅ correct |

- **Open scene description:** md2 ~80 % accurate, md3 ~95 %+. md2 is honestly
  close on the gist; it **invents specifics intermittently** ("two chairs", a
  "cell phone" and "book" that weren't there, "head resting" when the hand was
  raised). md3 got those right.
- **Specific/factual questions:** **md2 largely fails** (returns empty or
  invents); **md3 is reliable.** This is the real gap.

## Structured output — what works, what doesn't

We tried hard to get structured (JSON) output. Findings:

1. **md2 returns EMPTY on closed yes/no questions** ("Is there a person?") — its
   phi2 `Question:/Answer:` template bails on format/closed prompts. It answers
   **open** questions richly. → ask open questions, parse the prose.
2. **md2 + Ollama `format=json`** *does* yield parseable JSON (~260 ms), but the
   **values are loose/wrong** (`{"activity":"punching","unusual":"swing"}`).
   Structure OK, content unreliable. Don't depend on it.
3. **md2 without `format=json`** never volunteers JSON, even with the documented
   `"return as json: a, b, c"` phrasing → empty.
4. **The documented `"return as json:"` is a moondream3 *native skill*** (from
   moondream.ai/skills/query, i.e. md3 / Moondream Cloud). md3's `query`/
   `detect`/`point` skills are **not reachable through mlx-vlm or Ollama** —
   both expose only generic text generation. To get native JSON / bounding
   boxes you'd need the real md3 transformers path (proper quant) or Moondream
   Cloud.

**Conclusion: don't demand JSON locally. Ask an open NL question and derive
structure (present/activity/match) from the answer** with keyword/polarity
parsing (`ts/moondream.ts` `polarity()`), not by asking the model for a schema.

## Why md2 in Ollama, not md3 in Ollama

md3 is a new 64-expert MoE; **no GGUF exists** on HuggingFace and llama.cpp/
Ollama don't support the architecture yet, so md3 cannot run in Ollama today. The
only local md3 path is MLX (Python, in-process) — hence the sidecar's `md3`
backend loads it directly rather than over Ollama.

## How these numbers were produced

All scripts in `bench/` (Python), run against a live webcam at 320×240:

- `profile_load.py` — md2 GPU/CPU/RAM + latency (GPU via `powermetrics`, needs sudo)
- `md3_profile.py` — md3 load, RSS, MLX GPU memory, latency (no sudo)
- `accuracy.py` — md2 vs md3 NL, **saves frames** for ground-truth grading
- `compare.py` — md2 vs md3 NL + JSON, side by side
- `json-probe.py` / `structure-probe.ts` — the structured-output strategies above
- `watch.py` / `console.py` — interactive monitoring (CLI + live REPL)

Re-run any to refresh the record; update this file when conclusions change.

# Dock LLM model benchmark

Living report comparing LLMs as the dock's brain, on the dimensions that
actually matter for an agentic, embodied, voice dock (learned the hard way — see
[VALIDATION.md](VALIDATION.md)). Update an entry whenever you test a model/param
combo. Measured on: Redmi 6 Pro dock + ESP32 XIAO body, laptop host (en0
192.168.1.10), gemma via Ollama :11434, llama.cpp :8081.

> **There's now a runnable harness** — [`app/bench/`](app/bench/). It drives each
> model through the dock's REAL request path (shared `:dock-llm` transport + the
> real tool schemas + system prompt) N times per case, scores objective
> predicates + latency, and writes `results/<ts>.json` + a `viewer.html` matrix.
> Subjective scores in the JSON are Claude's review of the recorded outputs.
> Run: `./gradlew :bench:run --args="--models local --n 10"` (local) /
> `--models cloud --n 3` (OpenRouter). See [app/bench/README](app/bench/) below.
> The hand-written findings here are the narrative; the harness is the evidence.

## Latest snapshot — `baseline-v1`

5 models × 13 **discriminating** cases (the easy ones where everyone scored 100%
were removed — they measure nothing). Each cell carries TWO badges: pass-rate AND
a quality grade (★1-5) Claude assigns from the recorded outputs, because a green
100% can still be low quality. Models + approx cost (in the viewer header):

| Model | Where | Vision | Cost (in/out per Mtok) |
|---|---|---|---|
| gemma4:e2b | Ollama :11434 | ✅ | free (local) |
| Qwen3.6-35B-A3B | llama.cpp :8081 | ❌ | free (local) |
| gemini-2.5-flash | OpenRouter | ✅ | $0.30 / $2.50 |
| claude-haiku-4.5 | OpenRouter | ✅ | $1.00 / $5.00 |
| qwen3-vl-235b | OpenRouter | ✅ | $0.20 / $0.88 |

**Headline: gemini-2.5-flash wins or ties nearly every row** — only model that
counts fingers right (3, vs gemma "5" / haiku "4"), refuses to guess what's behind
it, and turns its *foot* left when asked to "look left" (the neck can't). The
discriminators that separate the field:

- **announce-then-stop (poem)**: gemma passes 90% but ★2 — says "here is a poem"
  and never delivers; gemini/haiku-4.5/qwen3-vl/Qwen3.6 deliver real poems (★5).
  The quality badge exposes what pass-rate hides.
- **over-eager movement**: **qwen3-vl-235b** has the best vision (counts fingers,
  reads expressions) but compulsively moves on pure chat ("I had a rough day" →
  wiggles; "favorite color?" → 10 tool calls, 33s) — fails noMove repeatedly, and
  is slow (runaway loops hit the 70-90s timeout). Strong eyes, poor restraint.
- **honesty (what's behind you?)**: gemini won't guess; gemma hallucinates "empty
  space" and moves; haiku-4.5 / qwen3-vl admit it then guess "probably a wall".
- **impossible action (look left with the neck)**: gemini maps it to the foot;
  gemma/haiku/Qwen3.6 honestly refuse (but trip `validEnums` by attempting it).

Cloud capability facts the harness surfaced as HTTP errors (and we acted on):
**claude-3.5-haiku has no vision** (dropped — cloud is vision-only now), and
**qwen2.5-vl-72b can't tool-call on OpenRouter** (no function-calling provider →
404; replaced by **qwen3-vl-235b**, which does both).

Snapshots embed the exact system prompt — change it, re-run `--snapshot v2`, and
the viewer diffs old vs new. See [app/bench/](app/bench/).

## Dimensions

| Dim | What / why |
|---|---|
| **Vision** | Accepts a camera image? The dock's "eyes". Text-only = blind dock. |
| **Tool-calling** | Emits native `tool_calls` (not prose)? The ONLY way the dock moves. |
| **Tool reliability** | % of move commands that actually produce a tool call (not hallucinated / inlined / ignored). |
| **Instruction-following** | Honors enum values? valid part↔state pairs? says full content vs just announcing? |
| **Latency — cold** | First turn after model load (prompt processing). |
| **Latency — warm** | Subsequent turn, first useful event. The number users feel. |
| **Reasoning control** | How to disable/cap chain-of-thought (huge latency tax on thinking models). |
| **Failure modes** | The specific ways it breaks (so we can prompt/gate around them). |
| **API / config** | Transport (`ollama` NDJSON / `openai` SSE) + the exact params that worked. |

## Results

### gemma4:e2b (Ollama, ~5B vision MoE) — current default for vision
| Dim | Finding |
|---|---|
| Vision | ✅ yes — describes scenes accurately ("living room, blue couch") |
| Tool-calling | ✅ native tool_calls |
| Tool reliability | ⚠️ ~100% text-only; **~33% when an image is attached** (fixates on image, ignores move) → needs image gating |
| Instruction-following | ⚠️ inconsistent enums (honored `neck,left`; invented `nodYes`); needed gesture vocab + part-state validation + "say full content" prompt |
| Latency cold | ~14s (with think:low) / first sentence ~5-15s |
| Latency warm | ~2s to tool, ~2.5s to speech — **fast** |
| Reasoning control | `think: false` (Ollama). NOTE Ollama bug: `think:false` on a thinking model can drop schema — for THIS (tool-calling, not format) it's fine. |
| Failure modes | inlines tool calls as speech under verbose prompts; image-fixation; announce-then-stop after a tool call (all mitigated via prompt + gating) |
| API / config | `ollama` NDJSON, `/api/chat`; `LLM_VISION=true`, image gated to vision-intent turns |

### Qwen3.6-35B-A3B-UD-Q4_K_M (llama.cpp, 35B/3B-active MoE) — text-only, smart
| Dim | Finding |
|---|---|
| Vision | ❌ no — `image input is not supported` (no mmproj). Would need a `-VL` build + mmproj. |
| Tool-calling | ✅ native tool_calls, streams as SSE fragments (reassembled by SseAssistantParser) |
| Tool reliability | ✅ clean (text-only, so no image-fixation problem); also picked `neck,left` once — caught by validation |
| Instruction-following | ✅ stronger than gemma (35B); composes good move_sequence with timing |
| Latency cold | ~44s with thinking on; still several s for first model load |
| Latency warm | **thinking ON: ~6s** · **thinking OFF: ~1.8s to tool, ~2.8s to speech** — on par with gemma, with 35B smarts ✅ |
| Reasoning control | **`chat_template_kwargs: {enable_thinking: false}`** disables CoT — verified to cut warm latency 6s→1.8s. `reasoning_effort:"none"` did NOT work. **Now wired into the openai payload.** |
| Failure modes | slow cold start (first load); otherwise clean with thinking off |
| API / config | `openai` SSE, `/v1/chat/completions`, `enable_thinking:false`; `LLM_API=openai`, `LLM_VISION=false` |

## Open / TODO
- Wire `chat_template_kwargs:{enable_thinking:false}` into the openai payload → re-measure Qwen warm latency (expect ↓).
- Test Qwen3.5-9B (smaller, may be faster, still text-only).
- If vision-on-a-strong-model wanted: get a Qwen-VL/Gemma-VL + mmproj for llama.cpp.
- Consider model routing: vision turns → gemma; chat/action → Qwen.
- Add: tokens/sec, context-window headroom, multi-step (N-tool) reliability, barge-in responsiveness per model.

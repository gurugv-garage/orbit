# :bench — dock-LLM benchmark harness

A runnable "test suite for models". It drives each model through the dock's REAL
request path — the dock LLM transport + the real tool schemas
([`DockToolSchemas`](../app/src/main/kotlin/dev/orbit/dock/llm/DockToolSchemas.kt))
+ the real system prompt ([`DockPrompt`](../app/src/main/kotlin/dev/orbit/dock/llm/DockPrompt.kt))
— N times per case, scores objective predicates + latency percentiles, and writes
a results JSON rendered as a model×case matrix by the viewer, which now lives in
**orbit-station** (`orbit-station/web/public/modules/bench.html`, served at
`/#bench` in the station UI). Copy fresh `results/*.json` into
`orbit-station/server/src/modules/bench/results/` to view them there. Pure-JVM: no
Android, no emulator. Tools are no-ops ([`BenchTools`](src/main/kotlin/dev/orbit/dock/bench/BenchTools.kt))
that record calls and feed back the same validation messages as the live dock, so
this measures MODEL behavior, not servos.

## Analysis & recommendation (snapshot `01-cloud-vision`)

The live matrix compares the fast cloud vision+tools models on all 18 cases:

| Model | Avg pass | Avg p50 | Cost (in/out /Mtok) | Verdict |
|---|---|---|---|---|
| **gemini-2.5-flash** | **93%** | **1.6s** | $0.30 / $2.50 | **Default.** Counts fingers, refuses to hallucinate, restrained on chat, delivers promised content, computes correctly. The one that's fast *and* right. |
| gpt-4o-mini | 70% | 1.9s | $0.15 / $0.60 | Fast + good chat/multistep, but **vision is unreliable** — miscounts fingers, misreads expression, fails object-id. Bad fit for the dock's eyes. |
| gemini-2.5-flash-**lite** | 67% | 3.9s | $0.10 / $0.40 | The cheap downgrade **doesn't hold up**: loops to 20s on compute, hallucinates blind-spots, weaker expression reads. "Lite" drops real reasoning. |

The key finding: **the obvious cheaper swaps don't hold up.** gpt-4o-mini's vision
is too weak and flash-lite loses reasoning (and even loops) — both at >20-point
pass-rate gaps below full flash. Stay on **gemini-2.5-flash**.

gemini's two non-100% cells are honest: `multistep_sequence` (asks the neck to
look left — impossible; gemini correctly turns the foot instead, which trips the
strict `validEnums` predicate) and `ambiguous_dance` 67% (improvises a dance to a
tool that doesn't exist — partial).

### Evaluated & rejected (didn't make the matrix)

All pass the capability gate (vision + native tool_calls on OpenRouter) but were
**rejected on latency** — too slow for a real-time desk robot. The benchmark
itself surfaced this: a model that takes tens of seconds per turn to *bench* is a
model that lags in conversation.

| Model | Why rejected | Cost |
|---|---|---|
| glm-4.6v | Great reasoning + accurate vision, but **runs away to 90s timeouts** on hard cases (impossible-neck 3/3) and ~20s even when it succeeds. | $0.30 / $0.90 |
| minimax-m3 | **8–30s per turn even on plain chat** (joke 16–30s); output-duplication glitches; misread a solid-red image as "black". | $0.30 / $1.20 |
| qwen3-vl-235b | Best eyes of the bunch but **runaway loops + over-eager movement** (10 tool calls on a chat question, p50 ~10s). | $0.20 / $0.88 |
| claude-haiku-4.5 | Fast-ish (~4s) but **over-moves on chat**, miscounts fingers, and weak value at $5/Mtok out. | $1.00 / $5.00 |

Local options (not in this cloud snapshot): **gemma4:e2b** (free, has vision,
fast, but announce-then-stop + miscounts) is the private fallback; **Qwen3.6-35B**
is the strongest local *text* brain but is blind.

**Pattern:** the big cloud models have strong reasoning and vision, **undone by
latency** — they loop on tools and hit multi-second to 90s turns. gemini-2.5-flash
is the outlier that's both correct *and* fast. **Latency is the gate that matters
most for an embodied, real-time dock**, and it's the one most "smart" models fail.

**What separates them (the discriminators, not the easy cases):**
- **Honesty** — only gemini reliably refuses to guess what it can't see ("what's
  behind you?"); the others hallucinate "probably a wall" *and* move.
- **Restraint** — qwen3-vl and (to a lesser degree) haiku compulsively call
  movement tools on pure chat ("I had a rough day" → wiggle). gemini/Qwen3.6 set
  an expressive face at most. Over-eager movement is the single biggest quality
  gap among capable models.
- **Precise vision** — counting 3 fingers split the field: gemini + qwen3-vl got
  it; gemma + haiku said 4. "Describe the scene" is easy; *count* is hard.
- **Announce-then-stop** — gemma says "here's a poem" and never delivers; pass-rate
  hides it, the ★ quality badge exposes it. The reason we grade quality at all.
- **Tooling honesty** (compute-v1) — before the `compute` tool, gemini tried a
  non-existent `run_code` and gave up on "pick a number, if >5 say hi". With
  compute + the unknown-tool nudge, all cloud models now do it 100% and branch
  correctly. Lesson: **give the model the tool it reaches for, safely** — don't
  rely on it to reason around a missing capability.

**Recommendations:**
1. **Default to gemini-2.5-flash.** It's the only model that's correct, honest,
   and restrained across the board, and cents/day at dock traffic.
2. **Local fallback = gemma4:e2b** (private, free, sees) — keep the image gate on
   and the terse prompt; accept it won't count or always deliver promised content.
3. **Don't ship qwen3-vl-235b as the live brain** despite its eyes — 10s turns
   and over-movement make it a poor real-time companion. Good as a vision oracle
   only if latency stops mattering.
4. **Over-eager movement is a prompt problem worth a dedicated fix** — the prompt
   should more strongly gate movement to explicit requests. Add it as a snapshot
   (`--snapshot no-fidget-v1`) and compare the Δ on the chat/empathy/no_move rows.
5. **Re-grade after any prompt change** — quality is hand-assigned, so a new
   prompt = a new snapshot + a fresh review; the compare view shows what moved.

## Run

```bash
# local (Ollama gemma :11434 / llama.cpp Qwen :8081 — run ONE at a time, they
# contend for the machine):
./gradlew :bench:run --args="--models local --n 10"

# cloud ceiling (OpenRouter — needs OPENROUTER_API_KEY in the env):
OPENROUTER_API_KEY=$(grep '^OPENROUTER_API_KEY=' ../local.properties | cut -d= -f2) \
  ./gradlew :bench:run --args="--models cloud --n 3 --snapshot baseline-v1 --merge"

# one model / some cases:
./gradlew :bench:run --args="--models gemma4:e2b --cases vision,tool_calling --n 5"

# re-score stored runs after tightening a predicate (no model calls):
./gradlew :bench:run --args="--rescore"
```

Flags: `--models local|cloud|all|<name,name>` · `--n <runs>` ·
`--cases <substr,substr>` · `--snapshot <name>` (durable named run; default ts) ·
`--merge` (accumulate into the SAME snapshot by model name) · `--note "<text>"` ·
`--rescore` · `--root <dir>`.

## Snapshots (compare prompt versions over time)

A run is a **named snapshot** written to `results/<name>.json` that **embeds the
exact system prompt + tool schemas used**. Change the prompt, run
`--snapshot prompt-v2`, and you have two comparable runs — the viewer's compare
dropdown shows the Δ pass-rate per cell. Snapshots are committed as durable
history; `results/index.json` lists them for the dropdown.

Local backends (Ollama gemma :11434 / llama.cpp Qwen :8081) **can't run at once**
— they contend for the machine. So build one snapshot in pieces with `--merge`:
run gemma, switch the host to llama.cpp, run Qwen `--merge`, then cloud `--merge`,
all into the same `--snapshot`.

> **Merge gotcha:** `--merge` replaces a whole model's results by name. To update
> ONE case for a model, re-run that model's full case set (a single-case run would
> drop its other cases). Per-case merge is a possible future improvement.

## Adding a model

Append an entry to `models.json` — no code change:

```json
{ "name": "my-model", "model": "<wire id>", "baseUrl": "https://openrouter.ai/api",
  "api": "openai", "vision": true, "tier": "cloud", "apiKeyEnv": "OPENROUTER_API_KEY",
  "cost": "$0.30/$2.50 /Mtok" }
```

`cost` is informational, shown in the viewer's column header (`"free"` for local).
For cloud, use the OpenRouter per-token price (`in/out per Mtok`) — pull it from
`GET https://openrouter.ai/api/v1/models` and read `data[].pricing.{prompt,completion}`
(×1e6 for per-Mtok).

`api`: `ollama` (native `/api/chat` NDJSON) or `openai` (`/v1` SSE, used by
llama.cpp AND OpenRouter). `vision:false` makes image cases skip for that model.
`apiKeyEnv` names the env var holding a bearer token (omit for local). `tier`
(`local`/`cloud`) sets the default N and the `--models local|cloud` filter.
Two real OpenRouter gotchas the harness surfaces as HTTP errors: a model may have
no vision (`does not support image input`) or no tool-calling provider
(`No endpoints found that support tool use`) — pick full-capability cloud models.

### Disabling chain-of-thought (latency)

Thinking models pay a big latency tax on every turn — disable CoT for the
real-time dock. The knob differs by backend (both wired into the transport):

- **Ollama** (`gemma4:e2b`): `think: false`. (Ollama bug: `think:false` can drop
  the schema on some models — fine here since we use tool-calling, not a forced
  output format.)
- **llama.cpp openai** (`Qwen3.6-35B`): `chat_template_kwargs:{enable_thinking:false}`
  — verified to cut warm latency ~6s → ~1.8s. `reasoning_effort:"none"` did NOT
  work for this model.

## View

The viewer moved to **orbit-station**. Copy the snapshot(s) you want to view
into the station, then open its UI:

```bash
cp results/<snapshot>.json results/index.json \
   ../../../orbit-station/server/src/modules/bench/results/
cd ../../../orbit-station && npm run build && npm run start   # → http://localhost:8099/#bench
```

Matrix: rows = cases (grouped by capability), columns = models. Each cell has
**two badges** — pass-rate AND Claude's quality grade (★1-5) — plus p50 +
first-event latency; it expands to per-run outputs, tool calls, the vision image,
and the quality note. The **winning cell(s) per row are ringed** (ties on
pass-rate+quality are all marked). A snapshot dropdown + a compare-vs dropdown
(Δ per cell) sit on top, and "show system prompt" reveals the embedded prompt.

## Layout (readable data, not code)

| Path | What |
|---|---|
| `models.json` | Models under test (see Adding a model). Includes `cost` (shown in the header). |
| `cases/*.json` | Cases grouped by capability. Each: `{id, prompt, image?, expect, n?, note}`. |
| `images/` | Test images (internet + dock DUMPFRAME poses); known answers in the case notes. |
| `results/<snapshot>.json` + `latest.json` | Output (gitignored except committed snapshots). Full per-run output/tools/latency kept for debugging. |
| `results/index.json` | Snapshot list for the viewer dropdown. |
| `results/<ts>.log` | Tee of the run console (transport POSTs + per-run trace). |

The matrix viewer (`bench.html`) now lives in
[`orbit-station/web/public/modules/`](../../../orbit-station/web/public/modules/bench.html)
and is served at `/#bench` in the station UI — see the **View** section above.

`expect` predicates (all present fields must hold): `tool:"any"`,
`toolName:"move_body"`, `minToolCalls:N`, `noTool`, `noMove` (no body movement;
an expressive set_face is OK), `keywords:[…]`, `nonEmptySpeech`, `minSpeechChars:N`,
`validEnums`. The runner maps each to a transparent check in
[`Evaluate`](src/main/kotlin/dev/orbit/dock/bench/Evaluate.kt) (unit-tested).

**Cases are chosen to DISCRIMINATE, not to cover** — if every model scores 100%,
the case is dropped (it measures nothing). The interesting cases are traps:
announce-then-stop (poem), impossible-action honesty (look left with the neck),
over-eager movement on chat, and precise vision (count fingers).

Objective numbers + the quality badge are complementary: the predicate says "a
tool fired + speech was non-empty"; whether the promised poem was *actually
delivered* (vs announce-then-stop) is the quality grade Claude writes after
reviewing the recorded outputs.

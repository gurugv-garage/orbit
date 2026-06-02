# LiteRT-LM Koog adapter (design)

The dock app uses [Koog](https://github.com/JetBrains/koog) as its in-app agent framework. Koog ships executors for cloud LLM providers (Anthropic, OpenAI, Gemini, Ollama, OpenRouter, Bedrock) but **not** for on-device runtimes.

This adapter implements Koog's `PromptExecutor` interface in terms of [LiteRT-LM](https://github.com/google-ai-edge/LiteRT-LM) — Google AI Edge's on-device LLM runtime — so on-device Gemma (or any LiteRT-LM-supported model) plugs into Koog's strategy graph like any cloud provider.

**Status:** design doc. No code yet. Captured so the v1 build has a clear target.

---

## 1. Why a custom executor

Koog and LiteRT-LM are aligned on the right primitives — both speak chat messages + tool calls + streaming. They just don't speak the same types. The adapter is a translation layer:

```
┌──────────────────────────────────────┐
│ Koog agent loop / strategy graph     │
└──────────────────────────────────────┘
                 │
                 ▼ Prompt / Tools / Response (Koog types)
┌──────────────────────────────────────┐
│       LiteRtLmExecutor               │  ← this adapter
│   (impl of Koog PromptExecutor)      │
└──────────────────────────────────────┘
                 │
                 ▼ ConversationConfig / ToolSet / streaming output
┌──────────────────────────────────────┐
│         LiteRT-LM runtime            │
│  (Gemma 3 / Gemma 3n .litertlm)      │
└──────────────────────────────────────┘
```

Net effect: the rest of the dock app talks **only** to Koog. Switching local model (Gemma 3n → Phi-3 → Llama-3.2 → MediaPipe LLM → AI Core) means swapping the executor — the strategy graph, tool definitions, and hooks are unchanged.

---

## 2. Interface

Koog's `PromptExecutor` (paraphrased; check `docs.koog.ai` for the exact current signature):

```kotlin
interface PromptExecutor {
    suspend fun execute(prompt: Prompt, model: LLModel, tools: List<ToolDescriptor>): Message.Response
    fun executeStreaming(prompt: Prompt, model: LLModel): Flow<String>
}
```

We implement it as:

```kotlin
class LiteRtLmExecutor(
    private val modelFile: File,
    private val executorPreference: ExecutorPreference = ExecutorPreference.Auto,  // NPU > GPU > CPU
    private val maxContextTokens: Int = 4096,
) : PromptExecutor {

    private val engine: LlmInferenceEngine = LlmInferenceEngine.create(modelFile, executorPreference)

    override suspend fun execute(
        prompt: Prompt,
        model: LLModel,
        tools: List<ToolDescriptor>,
    ): Message.Response = withContext(Dispatchers.Default) {
        val session = engine.startSession(
            conversationConfig = ConversationConfig(
                automaticToolCalling = false,   // we drive the loop from Koog
                tools = tools.toLiteRtToolSet(),
                maxTokens = maxContextTokens,
            )
        )

        prompt.messages.forEach { session.addMessage(it.toLiteRt()) }

        val rawResponse = session.generate()           // blocking call inside Default dispatcher
        rawResponse.toKoogMessageResponse(tools)
    }

    override fun executeStreaming(prompt: Prompt, model: LLModel): Flow<String> = flow {
        val session = engine.startSession(/* no tools — pure text streaming */)
        prompt.messages.forEach { session.addMessage(it.toLiteRt()) }
        session.generateStream().collect { token -> emit(token.text) }
    }.flowOn(Dispatchers.Default)
}

enum class ExecutorPreference { Auto, NpuOnly, GpuOnly, CpuOnly }
```

A few hundred lines once you fill in the type conversions and the streaming-tool-call merge logic.

---

## 3. Type mapping (Koog ↔ LiteRT-LM)

| Koog | LiteRT-LM | Notes |
|---|---|---|
| `Prompt.messages` (chat history) | `Session.addMessage(...)` calls | Roles map directly: system / user / assistant / tool |
| `ToolDescriptor` | LiteRT-LM `Tool` (annotation-style) | Convert Koog's JSON-schema-style param spec to LiteRT-LM's typed `@ToolParam` form |
| `Message.Tool.Call` | LiteRT-LM tool-call event in `Session.generate()` output | LiteRT-LM emits tool calls inline; we collect and return as Koog `Tool.Call`s |
| `Message.Tool.Result` | LiteRT-LM `Session.addToolResult(...)` | After Koog executes the tool, we feed result back |
| Streaming tokens | `Session.generateStream()` `Flow` | 1:1 with text tokens; tool-call deltas (if streamed) are merged into structured calls |
| `LLModel.name` | (informational only) | LiteRT-LM is one model per engine; we ignore Koog's `model` field beyond logging |

Edge cases handled in v1:
- Context overflow: if the conversation exceeds `maxContextTokens`, drop oldest user/assistant pairs (preserve system prompt + last N turns)
- Tool-call parse failure: log + emit `Tool.Call.Malformed`; Koog already handles retry
- Engine creation failure (model file missing / executor unavailable): throw on construction, not first call — fail fast at startup

---

## 4. Performance + executor selection

LiteRT-LM picks where to run: NPU (Qualcomm Hexagon, MediaTek APU, Google Tensor TPU) → GPU → CPU. Adapter exposes:

```kotlin
LiteRtLmExecutor(modelFile, executorPreference = ExecutorPreference.Auto)
```

- **`Auto` (default)** — let LiteRT-LM pick. Best on Pixel 8+/9/10, Galaxy S24+.
- **`NpuOnly`** — fail loudly if NPU unavailable. Useful for benchmarking; not for production.
- **`GpuOnly`** — broader phone coverage than NPU; still fast.
- **`CpuOnly`** — fallback for very old phones or thermal throttling scenarios.

Expected targets (Gemma 3n on Tensor G4, NPU): TTFT ~300-500ms, ~30-50 tokens/s. Adapter doesn't optimize this — LiteRT-LM does. Adapter just plumbs.

### 4.1 Emulator behavior

Per the dock's [emulator-first dev loop](../README.md#11-development-environment--emulator-first), the adapter must work on Android Studio's AVD (no NPU available). With `ExecutorPreference.Auto`:

- NPU path is skipped (not present on emulator)
- GPU path uses host Metal/Vulkan via the emulator (Apple Silicon: usable)
- CPU path always works (slower, fine for dev)

Adapter does **nothing emulator-specific** — `Auto` selects the best available executor on whatever surface it's running on. Dev on emulator validates the full Koog ↔ adapter ↔ LiteRT-LM path with a small model (e.g., Gemma 2B int4); NPU performance measurements happen on a real Pixel.

Recommended dev-mode model: smallest int4 Gemma variant that fits in ~1 GB. Larger models (Gemma 3n 8B, etc.) are physical-device-only.

---

## 5. Hooks + observability

Adapter does not own observability — Koog's feature system does. The adapter just makes sure:
- Latency is measured per call (start of `execute()` → return)
- Token counts are reported back to Koog as `Message.Response.metadata`
- Errors are wrapped as `PromptExecutorException` so Koog's `RetryFeature` can act

Logging the model name, executor (NPU/GPU/CPU), and prompt hash → Koog's `LoggingFeature` handles it generically.

---

## 6. Testing strategy

- **Unit tests** with a fake `LlmInferenceEngine` (interface in adapter, real impl wraps LiteRT-LM): cover type mappings, context-overflow trimming, tool-call merging.
- **Instrumented Android tests** running a tiny test model on emulator + a Pixel device: end-to-end Koog → adapter → LiteRT-LM → response, with one tool call.
- **Manual smoke test:** the dock app's "what time is it" turn must complete under 600ms TTFT on a Pixel 8.

---

## 7. Open questions

- **Function-calling fidelity:** LiteRT-LM's tool calling is best on Gemma family (constrained decoding); other models may emit free-form JSON we have to parse. How robust is parsing? Need to validate before depending on it for body control tool calls.
- **Multi-turn tool loops:** Koog wants to drive the loop (LLM → tool → LLM → ...). LiteRT-LM has `automaticToolCalling = true` for internal loops. We set it to `false` so Koog stays in control — verify this path is supported and performant.
- **Streaming + tools simultaneously:** can LiteRT-LM stream tokens *and* emit a tool call mid-stream? If not, `executeStreaming` falls back to no-tools and tool turns use non-streaming `execute`. Acceptable for v1.
- **Model file distribution:** `.litertlm` model files are 1-4 GB. Ship via APK split / on-first-run download? Verify-on-disk + redownload-on-corruption.
- **Quantization choice:** int4 vs int8. Quality vs speed tradeoff per device class. Default int4; expose as an adapter config knob.

---

## 8. Build order

1. Empty Kotlin module with the `PromptExecutor` interface implementation skeleton — compiles, returns stub responses
2. Type-mapping unit tests (no LiteRT-LM dependency yet)
3. Wire LiteRT-LM SDK; smoke-test a single text-only call
4. Tool calling: one trivial tool, verify Koog → adapter → LiteRT-LM → tool → adapter → Koog cycle
5. Streaming: text-only first
6. Executor preference + benchmarking on real hardware
7. Use it in the dock app for real (first deployment: classify "is this addressed to me?")

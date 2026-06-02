package dev.orbit.dock.llm

import dev.pi.ai.AssistantMessage
import dev.pi.ai.AssistantMessageEvent
import dev.pi.ai.AssistantMessageEventStream
import dev.pi.ai.Content
import dev.pi.ai.Context
import dev.pi.ai.ImageContent
import dev.pi.ai.Message
import dev.pi.ai.Model
import dev.pi.ai.StopReason
import dev.pi.ai.StreamFn
import dev.pi.ai.TextContent
import dev.pi.ai.ToolCall
import dev.pi.ai.ToolResultMessage
import dev.pi.ai.Usage
import dev.pi.ai.UserMessage
import io.ktor.client.HttpClient
import io.ktor.client.engine.okhttp.OkHttp
import io.ktor.client.request.preparePost
import io.ktor.client.request.setBody
import io.ktor.client.statement.bodyAsChannel
import io.ktor.client.statement.bodyAsText
import io.ktor.client.request.header
import io.ktor.http.ContentType
import io.ktor.http.contentType
import io.ktor.http.isSuccess
import io.ktor.utils.io.readUTF8Line
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.add
import kotlinx.serialization.json.addJsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray
import kotlinx.serialization.json.putJsonObject

/**
 * The dock's [StreamFn] for the pi-kt agent loop — streams a model's response
 * over node-dock's OkHttp + Ktor 3 stack, advertising the agent's tools so the
 * model can emit `tool_calls`. Pure-JVM and transport-only: the same copy backs
 * both `:app` (the live dock) and `:bench` (the benchmark harness), so there is
 * one wire format to keep honest.
 *
 * Two dialects, selected by [openAiStyle]:
 *  - **Ollama native `/api/chat`** (NDJSON): each line is one JSON object with an
 *    incremental `message.content` fragment, and `message.tool_calls` arrives as
 *    a **complete object** (not fragmented) — verified live against glm/gemma. We
 *    emit `TextDelta`s as content streams and a single `ToolCallEnd` per call.
 *  - **OpenAI `/v1/chat/completions`** (SSE): for llama.cpp / OpenRouter; tool
 *    calls stream as fragments reassembled by index (see [SseAssistantParser]).
 *
 * Per the [StreamFn] contract it never throws for transport/model failures —
 * they come back as an `Error` event + an error [AssistantMessage].
 *
 * `think:false` keeps gemma responsive (thinking-mode buffers + slows the turn).
 * The per-turn camera image (if any) is attached to the last user message only
 * (the agent loop already keeps history text).
 *
 * Logging goes through [log] (a `(String)->Unit`) so this module carries no
 * Android dependency: `:app` passes a Timber hook; `:bench` passes println/no-op.
 */
class DockStreamFn(
    private val scope: CoroutineScope,
    private val baseUrl: String,
    private val think: Boolean = false,
    /** Transport dialect: false = Ollama native `/api/chat` (NDJSON, whole
     *  tool_calls); true = OpenAI `/v1/chat/completions` (SSE, fragmented
     *  tool_calls) for llama.cpp / OpenRouter. */
    private val openAiStyle: Boolean = false,
    /** Optional bearer token (OpenRouter). Null = no Authorization header. */
    private val apiKey: String? = null,
    /** Logging seam — keeps this module Android-free. */
    private val log: (String) -> Unit = {},
) {
    private val http = HttpClient(OkHttp) {
        engine {
            config {
                callTimeout(java.time.Duration.ofSeconds(70))
                readTimeout(java.time.Duration.ofSeconds(70))
                connectTimeout(java.time.Duration.ofSeconds(5))
            }
        }
    }
    private val json = Json { ignoreUnknownKeys = true; isLenient = true }

    fun close() = runCatching { http.close() }

    val streamFn: StreamFn = { model, context, _ ->
        val out = AssistantMessageEventStream()
        scope.launch(Dispatchers.IO) {
            try {
                val payload = if (openAiStyle) buildOpenAiPayload(model, context) else buildPayload(model, context)
                val url = baseUrl.trimEnd('/') + when {
                    !openAiStyle -> "/api/chat"                               // Ollama native
                    // Google's OpenAI-compat base already ends ".../openai" and
                    // expects /chat/completions (no /v1). OpenRouter (/api) and
                    // llama.cpp (:port) take the standard /v1/chat/completions.
                    baseUrl.trimEnd('/').endsWith("/openai") -> "/chat/completions"
                    else -> "/v1/chat/completions"
                }
                log("dock-stream POST $url model=${model.id} api=${if (openAiStyle) "openai" else "ollama"} tools=${context.tools?.size ?: 0}")
                http.preparePost(url) {
                    contentType(ContentType.Application.Json)
                    apiKey?.let { header("Authorization", "Bearer $it") }
                    setBody(json.encodeToString(JsonObject.serializer(), payload))
                }.execute { resp ->
                    if (!resp.status.isSuccess()) {
                        // Non-2xx (404 bad model, 401 auth, 429 rate-limit): the body
                        // is a JSON error, not a stream — surface it instead of an
                        // empty turn (otherwise the parser just emits an empty Done).
                        val body = runCatching { resp.bodyAsText() }.getOrDefault("")
                        emitError(out, model, "HTTP ${resp.status.value}: ${body.take(300)}")
                    } else if (openAiStyle) consumeSse(model, resp.bodyAsChannel(), out)
                    else consumeNdjson(model, resp.bodyAsChannel(), out)
                }
            } catch (t: Throwable) {
                emitError(out, model, t.message ?: t::class.java.simpleName)
            }
        }
        out
    }

    // ── NDJSON stream → AssistantMessageEvents ────────────────────────────

    private suspend fun consumeNdjson(
        model: Model,
        channel: io.ktor.utils.io.ByteReadChannel,
        out: AssistantMessageEventStream,
    ) {
        val parser = NdjsonAssistantParser(model)
        while (true) {
            val line = channel.readUTF8Line() ?: break
            if (line.isBlank()) continue
            val obj = runCatching { json.parseToJsonElement(line).jsonObject }.getOrNull() ?: continue
            var terminated = false
            for (event in parser.accept(obj)) {
                out.push(event)
                if (event is AssistantMessageEvent.Done || event is AssistantMessageEvent.Error) terminated = true
            }
            if (terminated) return
        }
        for (event in parser.finish()) out.push(event)
    }

    // ── OpenAI SSE stream → AssistantMessageEvents (llama.cpp / OpenRouter) ──

    private suspend fun consumeSse(
        model: Model,
        channel: io.ktor.utils.io.ByteReadChannel,
        out: AssistantMessageEventStream,
    ) {
        val parser = SseAssistantParser(model)
        while (true) {
            val line = channel.readUTF8Line() ?: break
            if (!line.startsWith("data:")) continue  // skip blanks, comments, event: lines
            val payload = line.removePrefix("data:").trim()
            var terminated = false
            for (event in parser.accept(payload)) {
                out.push(event)
                if (event is AssistantMessageEvent.Done || event is AssistantMessageEvent.Error) terminated = true
            }
            if (terminated) return
        }
        for (event in parser.finish()) out.push(event)
    }

    private fun emitError(out: AssistantMessageEventStream, model: Model, raw: String) {
        val hint = if (raw.contains("timeout", true) || raw.contains("refused", true)) {
            " — can't reach $baseUrl (is the server up + bound to 0.0.0.0, device on the same Wi-Fi?)"
        } else ""
        val err = AssistantMessage(
            content = listOf(TextContent("")),
            api = model.api, provider = model.provider, model = model.id,
            usage = Usage.EMPTY, stopReason = StopReason.ERROR, errorMessage = raw + hint,
        )
        out.push(AssistantMessageEvent.Start(err))
        out.push(AssistantMessageEvent.Error(StopReason.ERROR, err))
    }

    // ── request payload ───────────────────────────────────────────────────

    private fun buildPayload(model: Model, context: Context): JsonObject = buildJsonObject {
        put("model", model.id)
        put("stream", true)
        put("keep_alive", "30m")
        put("think", think)
        putJsonObject("options") { put("temperature", 0.5) }
        val lastUserIdx = context.messages.indexOfLast { it.role == "user" }
        putJsonArray("messages") {
            context.systemPrompt?.takeIf { it.isNotBlank() }?.let { sp ->
                addJsonObject { put("role", "system"); put("content", sp) }
            }
            context.messages.forEachIndexed { idx, m -> addMessage(m, attachImagesHere = idx == lastUserIdx) }
        }
        context.tools?.takeIf { it.isNotEmpty() }?.let { tools ->
            putJsonArray("tools") {
                for (t in tools) addJsonObject {
                    put("type", "function")
                    putJsonObject("function") {
                        put("name", t.name)
                        put("description", t.description)
                        put("parameters", t.parameters)
                    }
                }
            }
        }
    }

    private fun kotlinx.serialization.json.JsonArrayBuilder.addMessage(m: Message, attachImagesHere: Boolean) {
        when (m) {
            is UserMessage -> addJsonObject {
                put("role", "user")
                put("content", textOf(m.content))
                // Vision: Ollama /api/chat takes images as a base64 array on the
                // message. Attach only on the current user turn (never history).
                if (attachImagesHere) {
                    val imgs = m.content.filterIsInstance<ImageContent>()
                    if (imgs.isNotEmpty()) putJsonArray("images") { for (img in imgs) add(img.data) }
                }
            }
            is AssistantMessage -> addJsonObject {
                put("role", "assistant")
                put("content", textOf(m.content))
                val calls = m.content.filterIsInstance<ToolCall>()
                if (calls.isNotEmpty()) putJsonArray("tool_calls") {
                    for (c in calls) addJsonObject {
                        put("type", "function")
                        putJsonObject("function") {
                            put("name", c.name)
                            put("arguments", c.arguments)
                        }
                    }
                }
            }
            is ToolResultMessage -> addJsonObject {
                put("role", "tool")
                put("content", textOf(m.content))
            }
            else -> {}
        }
    }

    /** OpenAI `/v1/chat/completions` request (llama.cpp / OpenRouter). Same
     *  tools shape; messages are plain role/content — except a user turn carrying
     *  an [ImageContent] becomes the multimodal `content` array (`image_url`),
     *  which vision-capable OpenRouter models accept. */
    private fun buildOpenAiPayload(model: Model, context: Context): JsonObject = buildJsonObject {
        put("model", model.id)
        put("stream", true)
        put("temperature", 0.3)
        // Disable chain-of-thought on thinking models (Qwen3.x) — extended
        // reasoning is a big latency tax for a real-time dock. This knob works on
        // llama.cpp/OpenRouter (they ignore it for non-thinking models). But
        // Google's OpenAI-compat endpoint STRICTLY rejects unknown fields
        // ("Unknown name chat_template_kwargs" → HTTP 400), so only send it to
        // endpoints that tolerate it — never to googleapis.
        if (!baseUrl.contains("googleapis", ignoreCase = true)) {
            putJsonObject("chat_template_kwargs") { put("enable_thinking", false) }
        }
        val lastUserIdx = context.messages.indexOfLast { it.role == "user" }
        putJsonArray("messages") {
            context.systemPrompt?.takeIf { it.isNotBlank() }?.let { sp ->
                addJsonObject { put("role", "system"); put("content", sp) }
            }
            context.messages.forEachIndexed { idx, m -> addOpenAiMessage(m, attachImagesHere = idx == lastUserIdx) }
        }
        context.tools?.takeIf { it.isNotEmpty() }?.let { tools ->
            putJsonArray("tools") {
                for (t in tools) addJsonObject {
                    put("type", "function")
                    putJsonObject("function") {
                        put("name", t.name)
                        put("description", t.description)
                        put("parameters", t.parameters)
                    }
                }
            }
        }
    }

    private fun kotlinx.serialization.json.JsonArrayBuilder.addOpenAiMessage(m: Message, attachImagesHere: Boolean) {
        when (m) {
            is UserMessage -> addJsonObject {
                put("role", "user")
                val imgs = if (attachImagesHere) m.content.filterIsInstance<ImageContent>() else emptyList()
                if (imgs.isEmpty()) {
                    put("content", textOf(m.content))
                } else {
                    // Multimodal content array: text part + data-URL image parts.
                    putJsonArray("content") {
                        addJsonObject { put("type", "text"); put("text", textOf(m.content)) }
                        for (img in imgs) addJsonObject {
                            put("type", "image_url")
                            putJsonObject("image_url") {
                                put("url", "data:${img.mimeType};base64,${img.data}")
                            }
                        }
                    }
                }
            }
            is AssistantMessage -> addJsonObject {
                put("role", "assistant"); put("content", textOf(m.content))
                val calls = m.content.filterIsInstance<ToolCall>()
                if (calls.isNotEmpty()) putJsonArray("tool_calls") {
                    for (c in calls) addJsonObject {
                        put("id", c.id); put("type", "function")
                        putJsonObject("function") {
                            put("name", c.name)
                            put("arguments", json.encodeToString(JsonObject.serializer(), c.arguments))
                        }
                    }
                }
            }
            is ToolResultMessage -> addJsonObject {
                put("role", "tool"); put("tool_call_id", m.toolCallId); put("content", textOf(m.content))
            }
            else -> {}
        }
    }

    private fun textOf(content: List<Content>): String =
        content.filterIsInstance<TextContent>().joinToString("") { it.text }
}

/**
 * Parses Ollama `/api/chat` NDJSON lines into [AssistantMessageEvent]s. Unlike
 * OpenAI SSE, tool_calls arrive whole, so we emit one [AssistantMessageEvent.ToolCallEnd]
 * per call (no fragment reassembly). Pure (no IO) so it is unit-testable.
 */
class NdjsonAssistantParser(private val model: Model) {
    private val json = Json { ignoreUnknownKeys = true; isLenient = true }
    private var started = false
    private var finished = false
    private val textBuf = StringBuilder()
    private val toolCalls = mutableListOf<ToolCall>()
    private var nextToolIndex = 0

    fun accept(obj: JsonObject): List<AssistantMessageEvent> {
        if (finished) return emptyList()
        val events = mutableListOf<AssistantMessageEvent>()
        if (!started) { started = true; events += AssistantMessageEvent.Start(snapshot()) }

        val message = obj["message"]?.jsonObject
        message?.get("content")?.jsonPrimitive?.contentOrNull?.takeIf { it.isNotEmpty() }?.let { piece ->
            textBuf.append(piece)
            events += AssistantMessageEvent.TextDelta(0, piece, snapshot())
        }
        // tool_calls arrive as a complete array of whole objects in Ollama NDJSON.
        message?.get("tool_calls")?.let { tcEl ->
            runCatching { tcEl.jsonArray }.getOrNull()?.forEach { parseToolCall(it.jsonObject, events) }
        }
        if (obj["done"]?.jsonPrimitive?.contentOrNull == "true") return events + finish()
        return events
    }

    fun finish(): List<AssistantMessageEvent> {
        if (finished) return emptyList()
        finished = true
        return listOf(AssistantMessageEvent.Done(snapshot().stopReason, snapshot()))
    }

    private fun parseToolCall(tc: JsonObject, events: MutableList<AssistantMessageEvent>) {
        val fn = tc["function"]?.jsonObject ?: return
        val name = fn["name"]?.jsonPrimitive?.contentOrNull ?: return
        val args = fn["arguments"]?.let { runCatching { it.jsonObject }.getOrNull() } ?: buildJsonObject {}
        val call = ToolCall(id = "call_${nextToolIndex}", name = name, arguments = args)
        toolCalls.add(call)
        events += AssistantMessageEvent.ToolCallEnd(nextToolIndex, call, snapshot())
        nextToolIndex++
    }

    private fun snapshot(): AssistantMessage {
        val blocks = buildList<Content> {
            if (textBuf.isNotEmpty()) add(TextContent(textBuf.toString()))
            addAll(toolCalls)
        }.ifEmpty { listOf(TextContent("")) }
        return AssistantMessage(
            content = blocks,
            api = model.api, provider = model.provider, model = model.id,
            usage = Usage.EMPTY,
            stopReason = if (toolCalls.isNotEmpty()) StopReason.TOOL_USE else StopReason.STOP,
        )
    }
}

/**
 * Parses OpenAI `/v1/chat/completions` SSE `data:` payloads (llama.cpp /
 * OpenRouter) into [AssistantMessageEvent]s. Unlike Ollama, tool_calls stream as
 * FRAGMENTS — `delta.tool_calls[i]` carries id/name on the opening fragment and
 * `arguments` as JSON-string pieces across many chunks — so we accumulate per
 * index and emit a [AssistantMessageEvent.ToolCallEnd] at the terminal. `[DONE]`
 * ends the stream. Pure (no IO) → unit-testable.
 */
class SseAssistantParser(private val model: Model) {
    private val json = Json { ignoreUnknownKeys = true; isLenient = true }
    private var started = false
    private var finished = false
    private val textBuf = StringBuilder()
    private var finishReason: String? = null
    private class Frag { var id: String? = null; var name: String? = null; val args = StringBuilder() }
    private val frags = LinkedHashMap<Int, Frag>()

    fun accept(payload: String): List<AssistantMessageEvent> {
        if (finished) return emptyList()
        val p = payload.trim()
        if (p.isEmpty()) return emptyList()
        if (p == "[DONE]") return finish()
        val root = runCatching { json.parseToJsonElement(p).jsonObject }.getOrNull() ?: return emptyList()

        root["error"]?.let { err ->
            finished = true
            val msg = err.jsonObject["message"]?.jsonPrimitive?.contentOrNull ?: err.toString()
            val e = AssistantMessage(
                listOf(TextContent("")), model.api, model.provider, model.id,
                Usage.EMPTY, StopReason.ERROR, errorMessage = msg,
            )
            return buildList { if (!started) { started = true; add(AssistantMessageEvent.Start(e)) }; add(AssistantMessageEvent.Error(StopReason.ERROR, e)) }
        }

        val events = mutableListOf<AssistantMessageEvent>()
        if (!started) { started = true; events += AssistantMessageEvent.Start(snapshot()) }
        val choice = root["choices"]?.jsonArray?.firstOrNull()?.jsonObject
        choice?.get("finish_reason")?.jsonPrimitive?.contentOrNull?.let { finishReason = it }
        val delta = choice?.get("delta")?.jsonObject ?: return events

        delta["content"]?.jsonPrimitive?.contentOrNull?.takeIf { it.isNotEmpty() }?.let { piece ->
            textBuf.append(piece)
            events += AssistantMessageEvent.TextDelta(0, piece, snapshot())
        }
        delta["tool_calls"]?.let { runCatching { it.jsonArray }.getOrNull() }?.forEach { tcEl ->
            val tc = tcEl.jsonObject
            val idx = tc["index"]?.jsonPrimitive?.intOrNull ?: 0
            val frag = frags.getOrPut(idx) { Frag() }
            tc["id"]?.jsonPrimitive?.contentOrNull?.let { frag.id = it }
            tc["function"]?.jsonObject?.let { fn ->
                fn["name"]?.jsonPrimitive?.contentOrNull?.let { frag.name = it }
                fn["arguments"]?.jsonPrimitive?.contentOrNull?.let { frag.args.append(it) }
            }
        }
        return events
    }

    fun finish(): List<AssistantMessageEvent> {
        if (finished) return emptyList()
        finished = true
        val snap = snapshot()
        val events = mutableListOf<AssistantMessageEvent>()
        if (!started) { started = true; events += AssistantMessageEvent.Start(snap) }
        // Emit reassembled tool calls as ToolCallEnd before Done.
        snap.content.filterIsInstance<ToolCall>().forEachIndexed { i, c ->
            events += AssistantMessageEvent.ToolCallEnd(i, c, snap)
        }
        events += AssistantMessageEvent.Done(snap.stopReason, snap)
        return events
    }

    private fun snapshot(): AssistantMessage {
        val calls = frags.entries.mapNotNull { (_, f) ->
            val name = f.name ?: return@mapNotNull null
            val args = runCatching { json.parseToJsonElement(f.args.toString().ifBlank { "{}" }).jsonObject }
                .getOrDefault(buildJsonObject {})
            ToolCall(id = f.id ?: "call_$name", name = name, arguments = args)
        }
        val blocks = buildList<Content> {
            if (textBuf.isNotEmpty()) add(TextContent(textBuf.toString()))
            addAll(calls)
        }.ifEmpty { listOf(TextContent("")) }
        return AssistantMessage(
            blocks, model.api, model.provider, model.id, Usage.EMPTY,
            if (calls.isNotEmpty() || finishReason == "tool_calls") StopReason.TOOL_USE else StopReason.STOP,
        )
    }
}

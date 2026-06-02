package dev.orbit.dock.agent

import dev.orbit.dock.BuildConfig
import dev.orbit.dock.llm.DockStreamFn
import dev.orbit.dock.perception.CameraFrameProvider
import dev.pi.agent.Agent
import dev.pi.agent.AgentBusyException
import dev.pi.agent.AgentEvent
import dev.pi.agent.AgentOptions
import dev.pi.agent.ThinkingLevel
import dev.pi.ai.AssistantMessage
import dev.pi.ai.ImageContent
import dev.pi.ai.Model
import dev.pi.ai.TextContent
import dev.pi.ai.UserMessage
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.cancel
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeout
import timber.log.Timber

/**
 * The dock's brain — a thin facade over the pi-kt agentic runtime (`:agent-core`).
 *
 * One user utterance → `Agent.prompt` drives a real tool-calling loop: the model
 * streams spoken prose AND emits `move_body` / `set_face` tool calls, the loop
 * executes them ([DockToolsAdapter]), feeds results back, and continues until it
 * stops calling tools. We translate the loop's [AgentEvent]s into the dock's UX
 * (see UX.md): streamed sentence-by-sentence TTS, live status
 * (Waiting→Thinking→Speaking + per-action), talk-while-moving, multi-step.
 *
 * **Speak and act run in parallel.** Prose deltas → `tools.speakSentence` (TTS
 * thread); tool calls → `DockTools` body scope (fire-and-forget). Neither awaits
 * the other: the body moves the instant the tool fires, speech keeps streaming,
 * and the tool result returns to the loop immediately so the model can speak a
 * follow-up. Nothing blocks on servo travel or on TTS.
 *
 * Public surface is unchanged (`respond`, `stop`, `state`, `setSpeaking`,
 * `setToolCalling`, `shutdown`, `isConfigured`) so the UI wiring is untouched.
 */
class DockAgent(
    private val tools: DockTools,
    private val baseUrl: String = BuildConfig.OLLAMA_BASE_URL,
    private val model: String = BuildConfig.OLLAMA_MODEL,
    systemPrompt: String = DEFAULT_SYSTEM_PROMPT,
    /** Camera frames — attached to the current user message only (never
     *  history). Null → text-only. */
    private val cameraFrame: CameraFrameProvider? = null,
    /**
     * Gate the camera image to vision-intent turns only ("what do you see"),
     * sending movement/chat turns text-only. Small vision models (gemma4:e2b,
     * 5B) fixate on an always-attached image and ignore action commands — proved
     * live: "look up" + image → "I see a room…", no tool call. Gating makes
     * movement reliable while keeping vision when asked. Default ON. Set false
     * for a stronger model that handles image-on-every-turn without derailing.
     */
    private val gateImageToVisionIntent: Boolean = true,
    /** LLM API style: "ollama" (native /api/chat NDJSON) or "openai"
     *  (/v1/chat/completions SSE — llama.cpp). From BuildConfig.LLM_API. */
    private val api: String = BuildConfig.LLM_API,
    /** Whether the model can see — when false, no camera frame is ever attached
     *  (text-only models like Qwen3.6). From BuildConfig.LLM_VISION. */
    private val visionEnabled: Boolean = BuildConfig.LLM_VISION,
    /** Bearer token, chosen by the endpoint: OpenRouter key for openrouter.ai,
     *  Gemini key for Google's OpenAI-compat endpoint, none for local servers.
     *  See [keyFor]. Overridable for tests. */
    private val apiKey: String? = keyFor(baseUrl),
    /** Test seam: override the LLM transport with a faux/scripted [StreamFn] so
     *  the facade → tool-call → body path is unit-testable without a model.
     *  Null → the real [DockStreamFn]. */
    streamFnOverride: dev.pi.ai.StreamFn? = null,
) {
    val isConfigured: Boolean get() = baseUrl.isNotBlank() && model.isNotBlank()

    private val scope = CoroutineScope(Dispatchers.IO)
    private var currentTurn: Job? = null

    private val provider = if (streamFnOverride == null) {
        DockStreamFn(
            scope, baseUrl, think = false,
            openAiStyle = api.equals("openai", ignoreCase = true),
            apiKey = apiKey,
            log = { Timber.i(it) },
        )
    } else null
    private val streamFn: dev.pi.ai.StreamFn = streamFnOverride ?: provider!!.streamFn

    private val _state = MutableStateFlow<AgentState>(AgentState.Idle)
    val state: StateFlow<AgentState> = _state.asStateFlow()

    /** Rolling stream of every emitted loop event as a short line (ms + label),
     *  for the on-screen live log. replay keeps the last [EVENT_LOG_REPLAY] so a
     *  late collector (UI recompose) shows recent history, not a blank box. */
    private val _events = MutableSharedFlow<String>(replay = EVENT_LOG_REPLAY, extraBufferCapacity = 64)
    val events: SharedFlow<String> = _events.asSharedFlow()

    // Per-turn sentence streamer (reset each turn). Fed plain prose deltas.
    private var extractor = StreamingReplyExtractor()
    @Volatile private var spokeThisTurn = false
    @Volatile private var turnStartMs = 0L

    private val agent: Agent = Agent(
        AgentOptions(
            systemPrompt = systemPrompt,
            model = Model(model, model, "openai-completions", "ollama"),
            thinkingLevel = ThinkingLevel.OFF, // think:false — gemma latency
            tools = DockToolsAdapter.tools(tools),
            streamFn = streamFn,
        ),
    ).also { a ->
        a.subscribe { event -> onAgentEvent(event) }
    }

    fun respond(userText: String) {
        if (!isConfigured) {
            tools.speak("I'm not configured with a local model. Set OLLAMA_BASE_URL and OLLAMA_MODEL in local.properties.")
            return
        }
        val prev = currentTurn
        prev?.cancel()
        currentTurn = scope.launch {
            // Wait for the superseded turn to fully unwind before starting — pi-kt's
            // Agent is one-run-at-a-time and resets its `activeRun` flag in a
            // `finally`, which runs asynchronously after cancel(). Without this
            // join the new prompt races that reset and is rejected as "busy"
            // (observed live: a second utterance left the first orphaned).
            try { prev?.cancelAndJoin() } catch (_: Throwable) {}
            runTurn(userText)
        }
    }

    fun stop() {
        currentTurn?.cancel()
        currentTurn = null
        agent.reset()              // clear pi-kt's activeRun so the next turn isn't "busy"
        tools.silence()
        _state.value = AgentState.Idle
    }

    private suspend fun runTurn(userText: String) {
        tools.stopBody()           // cancel any leftover gesture from the prior turn
        tools.beginTurn()
        extractor = StreamingReplyExtractor()
        spokeThisTurn = false
        turnStartMs = System.currentTimeMillis()
        TurnLog.startTurn(userText)
        if (BuildConfig.DEBUG) Timber.tag(EVT).i("+0ms  TURN_START  \"$userText\"")
        _state.value = AgentState.Waiting(model)

        // Live grounding (face-present / emotion / gaze) goes into this turn's
        // system context; the camera frame (if any) rides the user message.
        agent.state.systemPrompt = buildString {
            append(DEFAULT_SYSTEM_PROMPT)
            append("\n\nCurrent state — ").append(tools.currentContext())
        }
        // Camera frame. Never attached if the model can't see (visionEnabled).
        // Otherwise attached every turn UNLESS gating is on (default) and this
        // isn't a vision-intent turn — see [gateImageToVisionIntent]: small
        // vision models ignore movement when an image is always present.
        val wantImage = visionEnabled && (!gateImageToVisionIntent || isVisionIntent(userText))
        val images = if (wantImage) {
            cameraFrame?.latestJpegBase64()?.let { listOf(ImageContent(it, "image/jpeg")) } ?: emptyList()
        } else {
            emptyList()
        }

        try {
            withTimeout(TURN_TIMEOUT_MS) {
                agent.prompt(UserMessage(buildList {
                    add(TextContent(userText)); addAll(images)
                }).let { listOf(it) })
            }
        } catch (t: Throwable) {
            if (t is kotlinx.coroutines.CancellationException) throw t
            if (t is AgentBusyException) { Timber.w("agent busy — ignoring overlapping turn"); return }
            Timber.e(t, "agent turn failed")
            TurnLog.attemptFailed(t.message ?: t::class.simpleName.orEmpty())
            _state.value = AgentState.Failed("model unreachable")
            tools.speakSystem("I couldn't reach my local model. Check it's running.")
        } finally {
            // Flush any trailing clause (last sentence may lack terminal punctuation).
            extractor.flush()?.let(::speak)
            try { tools.endTurn() } catch (_: Throwable) {}
            TurnLog.endTurn(tools.lastSpokenReplyOrNull())
            if (!spokeThisTurn && _state.value !is AgentState.Failed) {
                _state.value = AgentState.Idle
            }
        }
    }

    /**
     * Translate one loop event into dock UX. Speech (prose) and action (tools)
     * are handled independently as their events arrive — they overlap.
     */
    private fun onAgentEvent(event: AgentEvent) {
        traceEvent(event)
        when (event) {
            is AgentEvent.MessageUpdate -> {
                // Streaming assistant prose → live subtitle + sentence-by-sentence TTS.
                val text = assistantText(event.message)
                if (text.isNotEmpty()) {
                    if (_state.value is AgentState.Waiting) _state.value = AgentState.Thinking(model)
                    extractor.liveText(text)?.let { tools.onLiveText(it) }
                    extractor.push(text).forEach(::speak)
                }
            }
            is AgentEvent.ToolExecutionStart -> {
                // Live per-action status (UX capability 3). The tool itself runs
                // fire-and-forget inside DockToolsAdapter → body moves NOW, in
                // parallel with whatever speech is streaming.
                _state.value = AgentState.ToolCalling(DockToolsAdapter.statusPhrase(event.toolName, event.args))
                TurnLog.toolCalled(event.toolName, event.args.toString())
            }
            is AgentEvent.AgentEnd -> {
                if (!spokeThisTurn && _state.value !is AgentState.Failed) _state.value = AgentState.Idle
            }
            is AgentEvent.MessageEnd -> {
                val m = event.message
                if (m is AssistantMessage && m.errorMessage != null) {
                    _state.value = AgentState.Failed("model unreachable")
                    tools.speakSystem("I couldn't reach my local model. Check it's running.")
                }
            }
            else -> {}
        }
    }

    /** Speak one streamed sentence (flips to Speaking on the first). */
    private fun speak(sentence: String) {
        if (!spokeThisTurn) { _state.value = AgentState.Speaking; spokeThisTurn = true }
        if (BuildConfig.DEBUG) Timber.tag(EVT).i("+${System.currentTimeMillis() - turnStartMs}ms  SPEAK  \"$sentence\"")
        tools.speakSentence(sentence)
    }

    /** Timestamped event trace (ms since turn start). Emitted to [events] for the
     *  on-screen live log (always on) and mirrored to logcat (tag DOCK_EVT) in
     *  debug builds, so the loop's sequence + timing is visible both on-device
     *  and in the UI. */
    private fun traceEvent(event: AgentEvent) {
        val dt = System.currentTimeMillis() - turnStartMs
        val line = when (event) {
            is AgentEvent.AgentStart -> "AGENT_START"
            is AgentEvent.TurnStart -> "turn_start"
            is AgentEvent.MessageStart -> "msg_start"
            is AgentEvent.MessageUpdate -> "msg_update (${assistantText(event.message).length} chars)"
            is AgentEvent.MessageEnd -> "msg_end"
            is AgentEvent.ToolExecutionStart -> "TOOL_START ${event.toolName}${event.args}"
            is AgentEvent.ToolExecutionEnd -> "TOOL_END   ${event.toolName} → ${(event.result.content.firstOrNull() as? TextContent)?.text}"
            is AgentEvent.ToolExecutionUpdate -> "tool_update"
            is AgentEvent.TurnEnd -> "turn_end"
            is AgentEvent.AgentEnd -> "AGENT_END"
        }
        _events.tryEmit("+${dt}ms  $line")
        if (BuildConfig.DEBUG) Timber.tag(EVT).i("+${dt}ms  $line")
    }

    /** Plain assistant text (concat of TextContent), ignoring tool-call blocks. */
    private fun assistantText(m: dev.pi.ai.AgentMessage): String =
        (m as? AssistantMessage)?.content?.filterIsInstance<TextContent>()?.joinToString("") { it.text }.orEmpty()

    /** True when the utterance is about what the dock can SEE — the gate for
     *  attaching the camera frame (see [gateImageToVisionIntent]). Pure +
     *  internal so it's unit-tested ([DockAgentVisionIntentTest]). */
    internal fun isVisionIntent(text: String): Boolean = VISION_INTENT.containsMatchIn(text)

    internal fun setToolCalling(name: String?) {
        _state.value = if (name == null) AgentState.Idle else AgentState.ToolCalling(name)
    }

    internal fun setSpeaking(speaking: Boolean) {
        if (speaking) _state.value = AgentState.Speaking
        else if (_state.value is AgentState.Speaking) _state.value = AgentState.Idle
    }

    fun shutdown() {
        currentTurn?.cancel()
        scope.cancel()
        provider?.close()
    }

    companion object {
        /** Pick the bearer token for a base URL: Gemini key for Google's
         *  OpenAI-compat endpoint, OpenRouter key for openrouter.ai, none for
         *  local servers (Ollama/llama.cpp reject an Authorization header). */
        fun keyFor(baseUrl: String): String? = when {
            baseUrl.contains("googleapis", ignoreCase = true) ->
                BuildConfig.GEMINI_API_KEY.takeIf { it.isNotBlank() }
            baseUrl.contains("openrouter", ignoreCase = true) ->
                BuildConfig.OPENROUTER_API_KEY.takeIf { it.isNotBlank() }
            else -> null
        }

        /** logcat tag for the debug-only turn event trace. */
        private const val EVT = "DOCK_EVT"

        /** How many recent event lines the on-screen live log replays to a new
         *  collector (so it isn't blank on recompose). */
        private const val EVENT_LOG_REPLAY = 40

        /** Utterances about SEEING → attach the camera frame (when gating is on).
         *  Catches "what do you see / what's this / how do I look / can you see /
         *  describe / what colour / who's this" while excluding movement verbs
         *  ("look up/left" = move). Iterate in UX.md. */
        private val VISION_INTENT = Regex(
            "\\b(see|seeing|seen|watch|view|camera|picture|image|photo|" +
                "describe|recogni[sz]e|look at|looking at|what colou?r|how do i look|" +
                "what('?s| is| are| do you| are you| am i)\\s.*\\b(this|that|in front|holding|" +
                "wearing|here|around|me)|who('?s| is)\\s)",
            RegexOption.IGNORE_CASE,
        )

        /** Hard ceiling so a hung/looping model can never freeze the dock. The
         *  agentic loop can take several round-trips; 60s clears the worst case
         *  + a cold model load. UX.md `MAX_TURNS` caps the loop separately. */
        private const val TURN_TIMEOUT_MS = 60_000L

        // The dock's system prompt now lives in :dock-llm ([DockPrompt.SYSTEM])
        // so the live dock and the :bench harness prompt models identically.
        // Kept terse + tool-first for small prompt-sensitive models (see
        // DockPrompt's doc for the why).
        const val DEFAULT_SYSTEM_PROMPT = dev.orbit.dock.llm.DockPrompt.SYSTEM
    }
}

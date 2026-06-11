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
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
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
 * One trigger (a user utterance today) → one **turn**: `Agent.prompt` drives the
 * loop where the model streams spoken prose AND emits `move_body` / `set_face`
 * tool calls, the loop executes them ([DockToolsAdapter]), feeds results back,
 * and continues until it stops calling tools. Each LLM call + its tools is a
 * **step**; a turn is 1+ steps. (Vocabulary — session / turn / step / LLM call —
 * is defined and owned by `:agent-core`; see agent-core/AGENT-MODEL.md. The dock
 * adopts it: `AgentEvent.TurnStart/End` brackets the whole `prompt()` run = one
 * dock turn; `StepStart/End` brackets each step.) We translate the loop's
 * [AgentEvent]s into the dock's UX (see app/dock-agent-loop.md / UX.md): streamed
 * sentence-by-sentence TTS, live status (Waiting→Thinking→Speaking + per-action),
 * talk-while-moving.
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
    /** Optional observability sink. When set, every [AgentEvent] is also shipped
     *  to orbit-station's `obs` topic as an AgentEventDto. Null → no station
     *  (the dock is fully functional without it). */
    private val stationLink: dev.orbit.dock.station.StationLink? = null,
    /** Turn wall-clock ceiling. Overridable so tests exercise the timeout path
     *  without waiting a minute. */
    private val turnTimeoutMs: Long = TURN_TIMEOUT_MS,
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
    // A tool ran (successfully) this turn — used to soften the failure line when
    // a LATER step dies: the action happened, so don't announce total failure
    // (seen live: "remember_face → remembered Guru" then step-2 transport error
    // spoke "couldn't reach my model" — wrong message for what the user saw).
    @Volatile private var toolRanThisTurn = false
    // True while runTurn is executing. SpeakEnd after the turn closed = the TTS
    // tail finished → ship the TurnSettled obs marker (end of the whole UX turn).
    @Volatile private var turnActive = false
    // State to restore when a tool finishes. onToolCall(null) used to force
    // Idle, stomping Waiting/Thinking/Speaking mid-turn (UI flashed idle).
    @Volatile private var stateBeforeTool: AgentState? = null

    // Observability threading (orbit-station obs topic). One DockAgent = one
    // session; each turn gets a fresh id; seq orders events within a turn.
    private val obsSessionId = "sess-" + java.util.UUID.randomUUID().toString().take(8)
    @Volatile private var obsTurnId = ""
    // The TRIGGER that started the current turn. A turn is trigger-agnostic
    // (AGENT-MODEL.md): today the only trigger kind is "user" (speaks/types);
    // future kinds (heartbeat, schedule, another node) set a different kind here.
    @Volatile private var obsTriggerKind = "user"
    @Volatile private var obsTriggerText = ""
    private var obsSeq = 0
    // First MessageUpdate of the current step already shipped (see shipToStation).
    @Volatile private var shippedStreamStart = false

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
        // Cancel but KEEP the job reference: a respond() that follows must
        // cancelAndJoin this still-unwinding run, or its prompt races the
        // `activeRun` reset and gets dropped as "busy" (a stop-then-speak
        // immediately after would silently ignore the new utterance).
        currentTurn?.cancel()
        // NOTE: no agent.reset() here — that wiped the whole conversation
        // history on every barge-in/long-press (and never cleared activeRun,
        // which lives in the run's own finally). Cancellation now unwinds
        // cleanly (agent-core rethrows it); the transcript survives the
        // interruption, and sanitizeHistory() patches any tool call the
        // cancellation left unanswered before the next prompt.
        tools.silence()
        _state.value = AgentState.Idle
    }

    private suspend fun runTurn(userText: String) {
        obsTriggerKind = "user"; obsTriggerText = userText   // trigger shipped on the next TurnStart
        tools.stopBody()           // cancel any leftover gesture from the prior turn
        tools.beginTurn()
        extractor = StreamingReplyExtractor()
        spokeThisTurn = false
        toolRanThisTurn = false
        turnActive = true
        turnStartMs = System.currentTimeMillis()
        TurnLog.startTurn(userText)
        if (BuildConfig.DEBUG) Timber.tag(EVT).i("+0ms  TURN_START  \"$userText\"")
        _state.value = AgentState.Waiting(model)
        sanitizeHistory()

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

        var completedNormally = false
        try {
            withTimeout(turnTimeoutMs) {
                agent.prompt(UserMessage(buildList {
                    add(TextContent(userText)); addAll(images)
                }).let { listOf(it) })
            }
            completedNormally = true
        } catch (t: kotlinx.coroutines.TimeoutCancellationException) {
            // The hard 60s ceiling fired (hung model / endless loop). This is a
            // TimeoutCancellationException — which IS a CancellationException —
            // so it must be handled BEFORE the generic cancellation rethrow or
            // the user gets a silent freeze-to-idle with no explanation.
            Timber.e("agent turn timed out after ${turnTimeoutMs}ms")
            TurnLog.attemptFailed("turn timeout")
            _state.value = AgentState.Failed("turn timed out")
            tools.speakSystem("That took too long, sorry — ask me again?")
        } catch (t: Throwable) {
            // User-initiated cancellation (barge-in / superseding utterance):
            // unwind silently — it is not an error and must not speak.
            if (t is kotlinx.coroutines.CancellationException) throw t
            if (t is AgentBusyException) { Timber.w("agent busy — ignoring overlapping turn"); return }
            Timber.e(t, "agent turn failed")
            TurnLog.attemptFailed(t.message ?: t::class.simpleName.orEmpty())
            _state.value = AgentState.Failed("model unreachable")
            tools.speakSystem("I couldn't reach my model. Check the connection.")
        } finally {
            turnActive = false
            // Flush any trailing clause (last sentence may lack terminal
            // punctuation) — but only for a turn that actually finished. A
            // cancelled/timed-out turn must not leak its half-sentence into
            // the next turn's TTS queue.
            if (completedNormally) extractor.flush()?.let(::speak)
            try { tools.endTurn() } catch (_: Throwable) {}
            TurnLog.endTurn(tools.lastSpokenReplyOrNull())
            if (!spokeThisTurn && _state.value !is AgentState.Failed) {
                _state.value = AgentState.Idle
            }
        }
    }

    /**
     * Repair + bound the transcript before a new prompt.
     *
     * 1. An interrupted turn can leave an assistant message whose tool calls
     *    have no ToolResultMessage (the cancellation unwound the loop between
     *    call and result). OpenAI-style endpoints reject such a history, which
     *    would make every turn after an interruption fail — so patch each
     *    unanswered call with a synthetic "(interrupted)" result.
     * 2. Cap the history at [MAX_HISTORY_MESSAGES], trimming whole turns from
     *    the front (cut at a user-message boundary so tool call/result pairs
     *    are never split). Unbounded history made every turn's prompt grow
     *    forever — a per-turn latency tax on a realtime device.
     */
    private fun sanitizeHistory() {
        val msgs = agent.state.messages
        if (msgs.isEmpty()) return
        val answered = msgs.filterIsInstance<dev.pi.ai.ToolResultMessage>().map { it.toolCallId }.toSet()
        val repaired = mutableListOf<dev.pi.ai.AgentMessage>()
        for (m in msgs) {
            repaired.add(m)
            if (m is AssistantMessage) {
                m.content.filterIsInstance<dev.pi.ai.ToolCall>()
                    .filter { it.id !in answered }
                    .forEach { tc ->
                        repaired.add(
                            dev.pi.ai.ToolResultMessage(
                                toolCallId = tc.id, toolName = tc.name,
                                content = listOf(TextContent("(interrupted before completing)")),
                                isError = false,
                            ),
                        )
                    }
            }
        }
        var result: List<dev.pi.ai.AgentMessage> = repaired
        if (result.size > MAX_HISTORY_MESSAGES) {
            // Cut at the first user message at/after the cap boundary, so a
            // turn's assistant/tool-result block is never split. If no user
            // message exists past the boundary (one pathological mega-turn),
            // leave the history alone rather than corrupt it.
            val boundary = (result.size - MAX_HISTORY_MESSAGES until result.size)
                .firstOrNull { result[it] is UserMessage }
            if (boundary != null && boundary > 0) result = result.drop(boundary)
        }
        val changed = result.size != msgs.size || repaired.size != msgs.size
        if (changed) agent.state.messages = result.toMutableList()
    }

    /**
     * Translate one loop event into dock UX. Speech (prose) and action (tools)
     * are handled independently as their events arrive — they overlap.
     */
    private fun onAgentEvent(event: AgentEvent) {
        traceEvent(event)
        shipToStation(event)
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
                setToolCalling(DockToolsAdapter.statusPhrase(event.toolName, event.args))
                TurnLog.toolCalled(event.toolName, event.args.toString())
            }
            is AgentEvent.ToolExecutionEnd -> {
                if (!event.isError) toolRanThisTurn = true
            }
            is AgentEvent.TurnEnd -> {
                if (!spokeThisTurn && _state.value !is AgentState.Failed) _state.value = AgentState.Idle
            }
            is AgentEvent.MessageEnd -> {
                val m = event.message
                if (m is AssistantMessage && m.errorMessage != null) {
                    _state.value = AgentState.Failed("model error")
                    // If the turn already DID something (spoke / ran a tool),
                    // the action succeeded — only the follow-up narration died.
                    // Don't announce total failure over a completed action.
                    tools.speakSystem(
                        if (spokeThisTurn || toolRanThisTurn) "Sorry, I lost my train of thought there."
                        else "I couldn't reach my model. Check the connection.",
                    )
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
            is AgentEvent.TurnStart -> "TURN_START"
            is AgentEvent.StepStart -> "step_start"
            is AgentEvent.MessageStart -> "msg_start"
            is AgentEvent.MessageUpdate -> "msg_update (${assistantText(event.message).length} chars)"
            is AgentEvent.MessageEnd -> "msg_end"
            is AgentEvent.ToolExecutionStart -> "TOOL_START ${event.toolName}${event.args}"
            is AgentEvent.ToolExecutionEnd -> "TOOL_END   ${event.toolName} → ${(event.result.content.firstOrNull() as? TextContent)?.text}"
            is AgentEvent.ToolExecutionUpdate -> "tool_update"
            is AgentEvent.StepEnd -> "step_end"
            is AgentEvent.TurnEnd -> "TURN_END"
        }
        // UI log: no timestamp prefix (cleaner; the params are what matter).
        _events.tryEmit(line)
        // logcat keeps the +Nms timing for debugging.
        if (BuildConfig.DEBUG) Timber.tag(EVT).i("+${dt}ms  $line")
    }

    /**
     * Map one [AgentEvent] to orbit-station's AgentEventDto and publish it on the
     * `obs` topic. No-op when no station is wired. The DTO shape mirrors
     * orbit-station/server/src/modules/observability/types.ts.
     */
    private fun shipToStation(event: AgentEvent) {
        val link = stationLink ?: return
        if (event is AgentEvent.TurnStart) {
            obsTurnId = "turn-" + java.util.UUID.randomUUID().toString().take(8)
            obsSeq = 0
        }
        if (obsTurnId.isEmpty()) return  // events outside a turn (shouldn't happen)
        // MessageUpdate fires per stream delta; the station only uses the FIRST
        // one (streamStartedAt = time-to-first-token). Shipping every delta was
        // one WS frame per token chunk on the hot streaming path — ship one.
        if (event is AgentEvent.MessageUpdate) {
            if (shippedStreamStart) return
            shippedStreamStart = true
        }
        if (event is AgentEvent.StepStart) shippedStreamStart = false

        val kind = when (event) {
            is AgentEvent.TurnStart -> "TurnStart"
            is AgentEvent.TurnEnd -> "TurnEnd"
            is AgentEvent.StepStart -> "StepStart"
            is AgentEvent.StepEnd -> "StepEnd"
            is AgentEvent.MessageStart -> "MessageStart"
            is AgentEvent.MessageUpdate -> "MessageUpdate"
            is AgentEvent.MessageEnd -> "MessageEnd"
            is AgentEvent.ToolExecutionStart -> "ToolExecutionStart"
            is AgentEvent.ToolExecutionUpdate -> "ToolExecutionUpdate"
            is AgentEvent.ToolExecutionEnd -> "ToolExecutionEnd"
        }
        val data: kotlinx.serialization.json.JsonObject? = when (event) {
            is AgentEvent.TurnStart -> buildJsonObject {
                put("trigger", buildJsonObject { put("kind", obsTriggerKind); put("text", obsTriggerText) })
            }
            is AgentEvent.MessageEnd -> buildJsonObject { put("text", assistantText(event.message)) }
            is AgentEvent.ToolExecutionStart -> buildJsonObject {
                put("toolCallId", event.toolCallId)
                put("toolName", event.toolName)
                put("args", event.args)
            }
            is AgentEvent.ToolExecutionEnd -> buildJsonObject {
                put("toolCallId", event.toolCallId)
                put("toolName", event.toolName)
                put("isError", event.isError)
                // the tool's response text, so the timeline can show what it returned.
                put("result", (event.result.content.firstOrNull() as? TextContent)?.text ?: "")
            }
            is AgentEvent.StepEnd -> buildJsonObject {
                put("model", model)
                (event.message as? AssistantMessage)?.let { m ->
                    put("stopReason", m.stopReason.toString())
                    put("usage", buildJsonObject {
                        put("inputTokens", m.usage.input)
                        put("outputTokens", m.usage.output)
                    })
                }
            }
            else -> null
        }

        val dto = buildJsonObject {
            put("sessionId", obsSessionId)
            put("turnId", obsTurnId)
            put("seq", obsSeq++)
            put("kind", kind)
            put("ts", System.currentTimeMillis())
            if (data != null) put("data", data)
        }
        link.emitAgentEvent(dto)
    }

    /** Plain assistant text (concat of TextContent), ignoring tool-call blocks. */
    private fun assistantText(m: dev.pi.ai.AgentMessage): String =
        (m as? AssistantMessage)?.content?.filterIsInstance<TextContent>()?.joinToString("") { it.text }.orEmpty()

    /** True when the utterance is about what the dock can SEE — the gate for
     *  attaching the camera frame (see [gateImageToVisionIntent]). Pure +
     *  internal so it's unit-tested ([DockAgentVisionIntentTest]). */
    internal fun isVisionIntent(text: String): Boolean = VISION_INTENT.containsMatchIn(text)

    internal fun setToolCalling(name: String?) {
        if (name != null) {
            val cur = _state.value
            if (cur !is AgentState.ToolCalling) stateBeforeTool = cur
            _state.value = AgentState.ToolCalling(name)
        } else if (_state.value is AgentState.ToolCalling) {
            // Restore what the turn was doing before the tool — forcing Idle
            // here flashed "idle" mid-stream after every set_face/move and
            // stomped Speaking when a background body sequence finished.
            _state.value = stateBeforeTool ?: AgentState.Idle
        }
    }

    internal fun setSpeaking(speaking: Boolean) {
        if (speaking) _state.value = AgentState.Speaking
        else if (_state.value is AgentState.Speaking) _state.value = AgentState.Idle
        // ship a speech-phase marker to obs (SpeakStart/SpeakEnd) so the timeline
        // can show when the dock was actually talking, separate from LLM/tools.
        shipObsMarker(if (speaking) "SpeakStart" else "SpeakEnd")
        // The TTS tail drained after the turn closed → the WHOLE user-perceived
        // turn is now over. TurnSettled lets the station measure the real
        // end-to-end window (TurnEnd only marks the LLM loop's end) and makes
        // post-turn speech attribution trustworthy.
        if (!speaking && !turnActive) shipObsMarker("TurnSettled")
    }

    /** Emit a synthetic obs event (not an agent-core AgentEvent) on the current
     *  turn — used for speech-phase markers the agent loop doesn't model. */
    private fun shipObsMarker(kind: String) {
        val link = stationLink ?: return
        if (obsTurnId.isEmpty()) return
        link.emitAgentEvent(buildJsonObject {
            put("sessionId", obsSessionId)
            put("turnId", obsTurnId)
            put("seq", obsSeq++)
            put("kind", kind)
            put("ts", System.currentTimeMillis())
        })
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
         *  + a cold model load. This wall-clock timeout is the *only* bound on
         *  the loop today — there is no per-turn tool-call count cap. */
        private const val TURN_TIMEOUT_MS = 60_000L

        /** History cap (messages, not turns) — see [sanitizeHistory]. ~15-20
         *  recent turns at the dock's typical 2-3 messages per turn. */
        private const val MAX_HISTORY_MESSAGES = 48

        // The dock's system prompt lives in dev/orbit/dock/llm ([DockPrompt.SYSTEM])
        // so the live dock and the :bench harness prompt models identically.
        // Kept terse + tool-first for small prompt-sensitive models (see
        // DockPrompt's doc for the why).
        const val DEFAULT_SYSTEM_PROMPT = dev.orbit.dock.llm.DockPrompt.SYSTEM
    }
}

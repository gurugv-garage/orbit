package dev.orbit.dock.agent

import dev.orbit.dock.perception.CameraFrameProvider
import dev.orbit.dock.station.BrainLink
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import timber.log.Timber

/**
 * The dock's brain, remote edition — the phone-side half of the server brain
 * (docs/SERVER-BRAIN-IMPL.md §4). Replaces [DockAgent] behind the same public
 * surface (`respond`, `stop`, `state`, `events`, `setSpeaking`,
 * `setToolCalling`, `shutdown`, `isConfigured`) so the UI wiring is untouched —
 * but the LLM loop itself runs in orbit-station: this class only ships the
 * trigger up and renders the brain's frames as dock UX.
 *
 *   up   (`agent` topic, critical send-or-fail): turn-request, tool-result,
 *        turn-cancel, speech-status; transcript partials ride telemetry.
 *   down (directed):  speak (one sentence per frame, streamed on
 *        sentence-close), tool-call (phone-surface tools: set_face),
 *        turn-status (accepted/thinking/acting/done/failed/cancelled),
 *        brain-status (resync handshake).
 *
 * Latency-critical UX stays LOCAL: [stop] silences TTS before telling the
 * station anything, and canned failure lines are phone-side strings (TTS is
 * local). Inbound frames are epoch-gated by turnId so a superseded turn's
 * stragglers can't speak over the new one.
 */
class RemoteBrain(
    private val tools: DockTools,
    private val link: BrainLink,
    /** Camera frames — attached to the turn-request when available; the BRAIN
     *  gates whether the model actually sees it (brainVisionGate config + its
     *  vision-intent check; face tools may use the frame even on gated turns). */
    private val cameraFrame: CameraFrameProvider? = null,
    /** Local belt-and-braces ceiling: the station enforces its own turn timeout
     *  and reports `failed (timeout)`; this only fires when the station itself
     *  went silent mid-turn (crash without a WS close). > server's 60s. */
    private val turnWatchdogMs: Long = TURN_WATCHDOG_MS,
    /** Injectable for tests (deterministic dispatch); owned + cancelled by
     *  [shutdown] either way. */
    private val scope: CoroutineScope = CoroutineScope(Dispatchers.IO + SupervisorJob()),
) {
    /** A blank STATION_URL means the dock has no brain at all. */
    val isConfigured: Boolean get() = link.enabled

    private val _state = MutableStateFlow<AgentState>(AgentState.Idle)
    val state: StateFlow<AgentState> = _state.asStateFlow()

    /** Rolling stream of brain frames as short lines for the on-screen live
     *  log. replay keeps recent history for late collectors (UI recompose). */
    private val _events = MutableSharedFlow<String>(replay = EVENT_LOG_REPLAY, extraBufferCapacity = 64)
    val events: SharedFlow<String> = _events.asSharedFlow()

    // ── turn epoch ────────────────────────────────────────────────────────
    // currentTurnId gates inbound frames; lastTurnId outlives the turn so the
    // post-turn TTS tail's speech-status still lands on the right turn
    // (TurnSettled attribution at the station).
    @Volatile private var currentTurnId = ""
    @Volatile private var lastTurnId = ""
    @Volatile private var turnActive = false
    @Volatile private var spokeThisTurn = false
    @Volatile private var turnStartMs = 0L
    // The reply so far, for the live subtitle (sentences arrive pre-split; the
    // old per-token StreamingReplyExtractor subtitle path is gone).
    @Volatile private var replyAcc = ""
    private var watchdog: Job? = null

    // reqId dedupe for tool-calls (at-most-once on our side too: a re-routed
    // duplicate must not run the face change twice).
    private val seenReqIds = object : LinkedHashMap<String, Boolean>(64, 0.75f, false) {
        override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, Boolean>?) = size > 64
    }

    // State to restore when a tool finishes (same nuance as DockAgent:
    // onToolCall(null) must not stomp Waiting/Thinking/Speaking mid-turn).
    @Volatile private var stateBeforeTool: AgentState? = null

    @Volatile private var brainReady = false

    // transcript pre-warm throttling (≥100ms between partials, final always)
    @Volatile private var lastTranscriptSentAt = 0L
    @Volatile private var utteranceId = newUtteranceId()
    @Volatile private var utteranceClosed = false

    init {
        // A dropped link mid-turn = the turn is dead and no turn-status will
        // ever say so — fail it locally, visibly.
        scope.launch {
            link.connected.collect { up ->
                if (!up && turnActive) {
                    failLocally("station link lost", "I lost the link to my brain mid-thought — ask me again?")
                }
            }
        }
    }

    // ── public surface (same as DockAgent) ─────────────────────────────────

    fun respond(userText: String) {
        if (!isConfigured) {
            tools.speak("I'm not configured with a station. Set STATION_URL in local.properties.")
            return
        }
        scope.launch { startTurn(userText) }
    }

    fun stop() {
        // Silence is LOCAL FIRST — the user tapped to stop; the sound must die
        // this instant, not after a network round trip.
        tools.silence()
        val turnId = currentTurnId
        endTurnLocally()
        _state.value = AgentState.Idle
        if (turnId.isNotEmpty()) {
            scope.launch {
                link.publishCritical("agent", "turn-cancel", buildJsonObject { put("turnId", turnId) })
            }
        }
    }

    internal fun setToolCalling(name: String?) {
        if (name != null) {
            val cur = _state.value
            if (cur !is AgentState.ToolCalling) stateBeforeTool = cur
            _state.value = AgentState.ToolCalling(name)
        } else if (_state.value is AgentState.ToolCalling) {
            _state.value = stateBeforeTool ?: AgentState.Idle
        }
    }

    internal fun setSpeaking(speaking: Boolean) {
        if (speaking) _state.value = AgentState.Speaking
        else if (_state.value is AgentState.Speaking) _state.value = AgentState.Idle
        // The brain derives SpeakStart/SpeakEnd/TurnSettled obs markers from
        // these — keyed to the turn whose speech this is (lastTurnId: the TTS
        // tail outlives the turn).
        val turnId = lastTurnId
        if (turnId.isEmpty()) return
        scope.launch {
            link.publishCritical("agent", "speech-status", buildJsonObject {
                put("turnId", turnId); put("speaking", speaking)
            })
        }
    }

    fun shutdown() {
        watchdog?.cancel()
        scope.cancel()
    }

    // ── transcript pre-warm (wired from the PerceptionBus in DockScreen) ────

    /** Stream STT transcripts to the brain so it pre-warms (session + profile
     *  load) while the user is still talking. Telemetry path — losing partials
     *  is fine; they never trigger a turn. */
    fun noteTranscript(text: String, isFinal: Boolean) {
        if (!isConfigured) return
        val now = System.currentTimeMillis()
        if (!isFinal && now - lastTranscriptSentAt < TRANSCRIPT_THROTTLE_MS) return
        if (utteranceClosed) {
            utteranceId = newUtteranceId()
            utteranceClosed = false
        }
        lastTranscriptSentAt = now
        if (isFinal) utteranceClosed = true
        link.publish("agent", "transcript", buildJsonObject {
            put("utteranceId", utteranceId)
            put("text", text)
            put("isFinal", isFinal)
        })
    }

    // ── inbound (wired to StationLink.onAgentFrame) ─────────────────────────

    fun onAgentFrame(kind: String, payload: JsonObject) {
        when (kind) {
            "brain-status" -> {
                brainReady = payload.bool("ready")
                trace("brain-status ready=$brainReady")
            }
            "tool-call" -> onToolCall(payload)
            "speak" -> onSpeak(payload)
            "turn-status" -> onTurnStatus(payload)
            "cancelled" -> trace("cancelled (station ack)")
            else -> Timber.d("RemoteBrain: unhandled agent frame '$kind'")
        }
    }

    // ── turn lifecycle ──────────────────────────────────────────────────────

    private suspend fun startTurn(userText: String) {
        val turnId = java.util.UUID.randomUUID().toString()
        currentTurnId = turnId
        lastTurnId = turnId
        turnActive = true
        spokeThisTurn = false
        replyAcc = ""
        turnStartMs = System.currentTimeMillis()
        tools.beginTurn()
        trace("TURN_REQUEST \"$userText\"")
        TurnLog.startTurn(userText)
        _state.value = AgentState.Waiting(BRAIN_LABEL)

        // The camera frame rides every turn-request when the camera is live;
        // vision gating (small-model fixation, brainVisionGate) is the brain's
        // call now — and face tools can use the frame even on gated turns.
        val image = cameraFrame?.latestJpegBase64()
        val sent = link.publishCritical("agent", "turn-request", buildJsonObject {
            put("turnId", turnId)
            put("trigger", buildJsonObject { put("kind", "user"); put("text", userText) })
            put("context", buildJsonObject { put("state", tools.currentContext()) })
            if (image != null) {
                put("imageBase64", image)
                put("imageMime", "image/jpeg")
            }
        })
        if (!sent) {
            failLocally("station unreachable", "I can't reach my brain right now — is the station up?")
            return
        }

        watchdog?.cancel()
        watchdog = scope.launch {
            delay(turnWatchdogMs)
            if (turnActive && currentTurnId == turnId) {
                Timber.e("RemoteBrain: no terminal turn-status after ${turnWatchdogMs}ms")
                failLocally("brain went silent", "That took too long, sorry — ask me again?")
            }
        }
    }

    private fun onSpeak(p: JsonObject) {
        if (p.str("turnId") != currentTurnId) {
            Timber.d("RemoteBrain: dropped stale speak (turn ${p.str("turnId").take(8)})")
            return
        }
        val text = p.str("text")
        if (text.isEmpty()) return
        if (!spokeThisTurn) {
            spokeThisTurn = true
            _state.value = AgentState.Speaking
        }
        trace("+${System.currentTimeMillis() - turnStartMs}ms SPEAK \"$text\"")
        replyAcc = if (replyAcc.isEmpty()) text else "$replyAcc $text"
        tools.onLiveText(replyAcc)
        tools.speakSentence(text)
    }

    private fun onToolCall(p: JsonObject) {
        val reqId = p.str("reqId")
        val turnId = p.str("turnId")
        if (turnId != currentTurnId) {
            Timber.d("RemoteBrain: dropped stale tool-call ${p.str("name")} (turn ${turnId.take(8)})")
            return
        }
        synchronized(seenReqIds) {
            if (seenReqIds.put(reqId, true) != null) return // duplicate
        }
        val name = p.str("name")
        val args = p["args"] as? JsonObject ?: buildJsonObject {}
        trace("TOOL_CALL $name $args")
        // Fire-and-forget contract: dispatch NOW, ack instantly — the brain's
        // loop never waits on actuation, only on this dispatch ack.
        val (content, isError) = when (name) {
            "set_face" -> {
                val expr = args["expression"]?.jsonPrimitive?.content.orEmpty()
                val r = tools.setFace(expr)
                r to r.startsWith("unknown")
            }
            else -> "unknown tool on phone: $name" to true
        }
        TurnLog.toolCalled(name, args.toString())
        scope.launch {
            link.publishCritical("agent", "tool-result", buildJsonObject {
                put("reqId", reqId); put("toolCallId", p.str("toolCallId")); put("turnId", turnId)
                put("content", content); put("isError", isError)
            })
        }
    }

    private fun onTurnStatus(p: JsonObject) {
        val turnId = p.str("turnId")
        if (turnId != currentTurnId) return
        val status = p.str("state")
        trace("turn-status $status${p.str("code").takeIf { it.isNotEmpty() }?.let { " ($it)" } ?: ""}")
        when (status) {
            "accepted" -> {} // already Waiting
            "thinking" -> if (_state.value is AgentState.Waiting) _state.value = AgentState.Thinking(BRAIN_LABEL)
            "acting" -> setToolCalling(actingLabel(p.str("detail")))
            "done" -> {
                endTurnLocally()
                if (!spokeThisTurn && _state.value !is AgentState.Failed) _state.value = AgentState.Idle
            }
            "failed" -> {
                val code = p.str("code")
                val detail = p.str("detail")
                endTurnLocally()
                TurnLog.attemptFailed(p.str("error").ifEmpty { code })
                _state.value = AgentState.Failed(
                    when (code) {
                        "timeout" -> "turn timed out"
                        else -> "model error"
                    },
                )
                // Canned lines live HERE (TTS is local; same words as DockAgent).
                tools.speakSystem(
                    when {
                        code == "timeout" -> "That took too long, sorry — ask me again?"
                        detail == "lost-train-of-thought" -> "Sorry, I lost my train of thought there."
                        else -> "I couldn't reach my model. Check the connection."
                    },
                )
            }
            "cancelled" -> {
                // Normally we initiated this (stop() already silenced + idled);
                // a station-initiated cancel unwinds the same way, silently.
                endTurnLocally()
                if (_state.value !is AgentState.Failed && !spokeThisTurn) _state.value = AgentState.Idle
            }
        }
    }

    /** Close the local turn window (idempotent): epoch off, watchdog off,
     *  DockTools turn bookkeeping closed, TurnLog record closed (every exit
     *  path — done/failed/cancelled/stop — not just the happy one). */
    private fun endTurnLocally() {
        if (!turnActive && currentTurnId.isEmpty()) return
        turnActive = false
        currentTurnId = ""
        watchdog?.cancel()
        watchdog = null
        try { tools.endTurn() } catch (_: Throwable) {}
        TurnLog.endTurn(tools.lastSpokenReplyOrNull())
    }

    private fun failLocally(label: String, spokenLine: String) {
        Timber.w("RemoteBrain: $label")
        trace("FAILED $label")
        endTurnLocally()
        TurnLog.attemptFailed(label)
        _state.value = AgentState.Failed(label)
        tools.speakSystem(spokenLine)
    }

    /** Human label for the live status line while the brain runs a tool that
     *  doesn't surface on the phone (move/compute/face tools run station-side;
     *  only `acting` + the tool name reaches us). */
    private fun actingLabel(toolName: String): String = when (toolName) {
        "move" -> "moving"
        "compute" -> "thinking"
        "set_face" -> "expression"
        "remember_face" -> "remembering"
        "recollect_face" -> "recognizing"
        "confirm_face", "forget_face" -> "updating memory"
        else -> toolName.ifEmpty { "acting" }
    }

    private fun trace(line: String) {
        _events.tryEmit(line)
        Timber.tag(EVT).i(line)
    }

    private fun JsonObject.str(key: String): String =
        (this[key] as? JsonPrimitive)?.content.orEmpty()

    private fun JsonObject.bool(key: String): Boolean =
        (this[key] as? JsonPrimitive)?.content == "true"

    private companion object {
        /** What the AgentState short label shows while the station thinks. */
        const val BRAIN_LABEL = "station"
        const val EVT = "DOCK_EVT"
        const val EVENT_LOG_REPLAY = 40
        const val TRANSCRIPT_THROTTLE_MS = 100L
        /** Local silence ceiling — longer than the station's own 60s turn
         *  timeout, so it only fires when the station truly vanished. */
        const val TURN_WATCHDOG_MS = 75_000L
        fun newUtteranceId() = "u-" + java.util.UUID.randomUUID().toString().take(8)
    }
}

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
    /** Camera frames — attached to the turn-request ONLY when [uploadFrame]
     *  says the brain can't grab one itself; the BRAIN gates whether the model
     *  actually sees it (brainVisionGate + its vision-intent check). */
    private val cameraFrame: CameraFrameProvider? = null,
    /** True → ship the camera JPEG with the turn-request. False (the normal
     *  case: the live SFU stream is up) → skip the upload; the brain grabs
     *  the frame from the stream it's already receiving. */
    private val uploadFrame: () -> Boolean = { true },
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

    /** A pending CONFIRM request from a mutating code/file tool (write/edit/run).
     *  Non-null = the UI must show an approve/deny dialog; the tool is BLOCKED
     *  server-side until [resolveConfirm] acks. Only one is ever pending (the
     *  brain runs one tool at a time). */
    private val _pendingConfirm = MutableStateFlow<ConfirmRequest?>(null)
    val pendingConfirm: StateFlow<ConfirmRequest?> = _pendingConfirm.asStateFlow()

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
        // Camera frame: uploaded only when the brain can't grab it from the
        // live SFU stream (uploadFrame = stream down / not streaming). Vision
        // gating stays the brain's call either way.
        val image = if (uploadFrame()) cameraFrame?.latestJpegBase64() else null
        trace("TURN_REQUEST \"$userText\"" + if (image != null) " (+frame)" else "")
        TurnLog.startTurn(userText)
        _state.value = AgentState.Waiting(BRAIN_LABEL)
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

        // CONFIRM: a mutating code/file tool (write/edit/run) needs the user's
        // OK. Don't ack now — park the request, show a dialog, ack on the tap
        // (resolveConfirm). The brain's tool is blocked until then.
        if (name == "confirm") {
            val req = ConfirmRequest(
                reqId = reqId, toolCallId = p.str("toolCallId"), turnId = turnId,
                summary = args["summary"]?.jsonPrimitive?.content ?: "Allow this action?",
                detail = args["detail"]?.jsonPrimitive?.content.orEmpty(),
            )
            TurnLog.toolCalled(name, args.toString())
            _pendingConfirm.value = req
            return
        }

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

    /** The user's choice on a [pendingConfirm] dialog. `approveAll` latches
     *  session-wide auto-approval at the station (no more prompts this session);
     *  `approved` is a one-shot yes; otherwise deny. */
    fun resolveConfirm(approved: Boolean, approveAll: Boolean = false) {
        val req = _pendingConfirm.value ?: return
        _pendingConfirm.value = null
        val content = when { approveAll -> "approved-all"; approved -> "approved"; else -> "denied" }
        trace("CONFIRM $content ${req.summary}")
        scope.launch {
            link.publishCritical("agent", "tool-result", buildJsonObject {
                put("reqId", req.reqId); put("toolCallId", req.toolCallId); put("turnId", req.turnId)
                put("content", content); put("isError", false)
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
                val rawError = p.str("error")
                endTurnLocally()
                TurnLog.attemptFailed(rawError.ifEmpty { code })
                // Diagnose the ACTUAL provider error so the dock can say what's
                // really wrong (quota, no credits, bad key, …) instead of a
                // blanket "couldn't reach my model".
                val diag = diagnoseTurnFailure(code, detail, rawError)
                _state.value = AgentState.Failed(diag.label)
                // Canned lines are local (TTS is on the phone).
                tools.speakSystem(diag.spoken)
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

/** A diagnosed turn failure: [label] is the short on-screen status; [spoken] is
 *  the (local TTS) line the dock says — specific to the actual cause. */
data class TurnFailure(val label: String, val spoken: String)

/** A parked confirm request from a mutating code/file tool — shown as an
 *  approve/deny dialog; the user's choice acks the [reqId] tool-result. */
data class ConfirmRequest(
    val reqId: String,
    val toolCallId: String,
    val turnId: String,
    val summary: String,
    val detail: String,
)

/**
 * Turn the station's `failed` turn-status into a SPECIFIC, human explanation.
 *
 * The station forwards the provider's real message in `error` (e.g. a 429
 * quota body, a 402 "needs credits", a 401 bad key). The phone used to ignore
 * it and always say "I couldn't reach my model" — unhelpful when the truth is
 * "your Gemini free quota is used up for today". This classifies the raw error
 * so the dock tells you what's actually wrong and what to do about it.
 *
 * Pure + top-level so it's unit-tested (RemoteBrainTest) against real provider
 * error strings.
 */
fun diagnoseTurnFailure(code: String, detail: String, error: String): TurnFailure {
    // structural cases first (these don't carry a provider body)
    if (code == "timeout") {
        return TurnFailure("timed out", "That took too long, sorry — ask me again?")
    }
    if (detail == "lost-train-of-thought") {
        return TurnFailure("lost the thread", "Sorry, I lost my train of thought there.")
    }
    if (code == "link_lost") {
        return TurnFailure("link lost", "I lost my connection to the station. Let me reconnect.")
    }

    val e = error.lowercase()
    fun has(vararg needles: String) = needles.any { it in e }

    return when {
        error.isBlank() ->
            TurnFailure("model error", "I couldn't reach my brain just now. Mind trying again?")

        // rate limit / quota exhausted (429 / RESOURCE_EXHAUSTED)
        has("429", "resource_exhausted", "rate limit", "rate-limit", "too many requests", "quota") -> {
            val daily = has("perday", "per day", "requestsperday", "daily")
            if (daily)
                TurnFailure("daily quota used up",
                    "I've hit my model's daily free limit. It'll reset later, or someone can add credits or switch my model.")
            else
                TurnFailure("rate limited",
                    "I'm being rate-limited right now — too many requests in a row. Give me a few seconds and ask again.")
        }

        // out of credits / billing (402)
        has("402", "more credits", "insufficient", "billing", "payment", "afford") ->
            TurnFailure("out of credits",
                "My model account is out of credits. Someone needs to top it up or switch me to another model.")

        // bad / missing API key (401 / 403)
        has("401", "403", "api key", "api_key", "unauthorized", "permission denied", "invalid key", "no api key") ->
            TurnFailure("bad API key",
                "My model key looks wrong or missing. Check the provider key in the station settings.")

        // model name not found / unavailable (404 / model not found)
        has("404", "not found", "no such model", "does not exist", "unknown model") ->
            TurnFailure("model not found",
                "The model I'm set to use wasn't found. Check the brain model name in the station settings.")

        // provider overloaded / down (500 / 503)
        has("503", "500", "overloaded", "unavailable", "high demand", "service unavailable", "internal error") ->
            TurnFailure("model overloaded",
                "My model provider is overloaded right now. That's usually temporary — try again in a moment.")

        // network to the provider
        has("timeout", "timed out", "econn", "network", "fetch failed", "socket", "dns", "getaddrinfo") ->
            TurnFailure("network error",
                "I couldn't reach my model over the network. Check the station's internet connection.")

        // fallback: surface a trimmed version of whatever the provider said
        else -> {
            val gist = providerGist(error)
            TurnFailure("model error",
                if (gist.isNotBlank()) "My model errored: $gist" else "My model hit an error I didn't recognize. Try again?")
        }
    }
}

/** Pull a short, speakable gist out of a raw provider error (often a nested
 *  JSON blob). Best-effort: find a "message": "..." or fall back to the first
 *  line, trimmed to a sentence-ish length. */
private fun providerGist(error: String): String {
    val m = Regex("\"message\"\\s*:\\s*\"([^\"]{3,200})\"").find(error)?.groupValues?.get(1)
    val raw = (m ?: error.lineSequence().firstOrNull { it.isNotBlank() } ?: "").trim()
    val cleaned = raw.replace(Regex("\\s+"), " ").take(140)
    return cleaned
}

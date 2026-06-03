package dev.orbit.dock.agent

import dev.orbit.dock.body.BodyController
import dev.orbit.dock.tts.Speaker
import dev.orbit.dock.ui.face.FaceController
import dev.orbit.dock.ui.face.FaceExpression
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonPrimitive
import timber.log.Timber
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Side-effecting actions the agent can take on the dock's face, voice, body,
 * and subtitle. [DockAgent] calls these directly after parsing the model's
 * structured-output JSON (reply / face / body).
 *
 * Threading: called from the agent's coroutine on `Dispatchers.IO`. Side
 * effects fan out to UI state flows + the Android TextToSpeech engine (which
 * has its own thread) + the fire-and-forget body scope.
 */
class DockTools(
    private val face: FaceController,
    private val tts: Speaker,
    private val onSubtitle: (String) -> Unit,
    private val onToolCall: (String?) -> Unit = {},
    /** Invoked when a turn settles, so the UI can clear the lingering user
     *  transcript (otherwise an action-only turn leaves it on screen). */
    private val onTurnSettled: () -> Unit = {},
    /**
     * Optional body. When non-null and connected, [makeBodyMovements] forwards
     * moves to it via the brain-side state catalog. When null or disconnected
     * it returns a "no body connected" string so the reply still speaks but no
     * servo commands are sent. A [BodyController] (not the concrete
     * [dev.orbit.dock.body.BodyLinkComms]) so tests can drive a mock body.
     */
    private val body: BodyController? = null,
    /**
     * Optional live senses (camera face-presence, the user's read emotion, gaze
     * direction). When present, [currentContext] tells the model what it can
     * actually see, so "what are you looking at?" / "how do I seem?" are
     * grounded rather than guessed. Null → no visual context (mic-only dock).
     */
    private val perception: PerceptionSnapshot? = null,
) {

    private val spokeThisTurn = AtomicBoolean(false)
    @Volatile private var lastSpoken: String? = null

    // Background scope for body movements. Movement tools dispatch here and
    // return IMMEDIATELY (fire-and-forget) so the agent loop / speech is never
    // blocked waiting for servos — the dock can talk WHILE it moves. Sequenced
    // moves run here too, so a long "wiggle" doesn't stall the conversation.
    private val bodyScope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

    // The currently-running body sequence (a multi-step "wiggle" etc.). Tracked
    // so a NEW command preempts it, and so stopBody() (barge-in / tap-stop /
    // new utterance) can cancel a long gesture instead of letting it twitch on
    // after the conversation has moved on.
    @Volatile private var bodyJob: kotlinx.coroutines.Job? = null

    fun beginTurn() {
        spokeThisTurn.set(false)
        lastSpoken = null
        // Do NOT optimistically set Speaking here. The model may take seconds
        // (or hang) before any audio — showing "Speaking" the whole time looks
        // like the dock is stuck talking silently. DockTts.onStart() flips the
        // face to Speaking the instant real audio begins; until then the
        // AgentState (Thinking) drives the status display.
        onSubtitle("")
    }

    /** Last text passed to `speak()` (real reply, not speakSystem). */
    fun lastSpokenReplyOrNull(): String? = lastSpoken

    /**
     * Settle the dock at the end of a turn. If the turn SPOKE, TTS owns the
     * wind-down (DockTts.onSpeakingChanged(false) → face.silence()). If the turn
     * only ACTED or produced nothing (no TTS callback will ever fire), settle
     * here: drop the face out of Listening/Speaking and clear the stale subtitle
     * so the UI doesn't freeze on the user's transcript / a half state.
     */
    fun endTurn() {
        if (!spokeThisTurn.get()) {
            face.silence()
            onSubtitle("")
        }
        // Always clear the lingering user transcript — by now the reply (spoken)
        // or the action has had its say; leaving "look down" on screen reads as
        // a freeze.
        onTurnSettled()
    }

    fun spokeAnythingThisTurn(): Boolean = spokeThisTurn.get()

    /**
     * A clean snapshot of the dock's current physical/visible state, for the
     * LLM's situational awareness. Injected into each turn's prompt so the
     * model knows whether it has a body right now, what it can move, and what
     * face it's currently wearing. Recomputed per turn (state changes).
     *
     * Example (connected):
     *   "Body: CONNECTED. Parts you can move — neck: lookUp, lookDown,
     *    center; foot: forward, left, right. Current face: happy."
     * Example (offline):
     *   "Body: NOT connected (movement requests will be ignored). Current
     *    face: neutral."
     */
    fun currentContext(): String {
        val sb = StringBuilder()
        val link = body
        if (link != null && link.connected.value) {
            val cat = link.validatedCatalog
            val partsDesc = cat.parts.sorted().joinToString("; ") { part ->
                "$part: ${cat.statesOf(part).joinToString(", ")}"
            }
            sb.append(
                if (partsDesc.isNotBlank())
                    "Body: CONNECTED. Parts you can move — $partsDesc."
                else
                    "Body: CONNECTED (no movable parts reported)."
            )
        } else {
            sb.append("Body: NOT connected (movement requests will be ignored).")
        }
        sb.append(" Current face: ${face.expression.value.name.lowercase()}.")
        // Live senses: what the camera sees right now (face present, the user's
        // read emotion, gaze). Omitted entirely when nothing is in view.
        perception?.describe()?.let { sb.append(' ').append(it) }
        return sb.toString()
    }

    /**
     * Speak a system message (e.g. fallback announcement) without marking
     * the turn as having had a real reply. Lets DockAgent surface
     * retry/failure narration audibly while still treating the turn as
     * "needs a real answer" so subsequent models keep trying.
     */
    fun speakSystem(text: String) {
        val clean = sanitizeForSpeech(text)
        Timber.i("tool.speakSystem: \"$clean\"")
        if (clean.isBlank()) return
        face.speak()
        tts.enqueueSentence(clean)
        onSubtitle(clean)
    }

    // ── tools ──────────────────────────────────────────────────────────

    fun speak(
         text: String,
    ): String {
        val clean = sanitizeForSpeech(text)
        Timber.i("tool.speak: \"$clean\"")
        onToolCall("speak")
        TurnLog.toolCalled("speak", clean)
        if (clean.isBlank()) {
            onToolCall(null)
            return "ok"
        }
        spokeThisTurn.set(true)
        lastSpoken = clean
        face.speak()
        tts.enqueueSentence(clean)
        onSubtitle(clean)
        onToolCall(null)
        return "spoken"
    }

    /**
     * Update the subtitle with the reply text decoded so far, live, as it
     * streams in (see [StreamingReplyExtractor.liveText]). Display only — TTS is
     * driven separately by [speakSentence] on sentence boundaries — so this does
     * NOT touch the turn's spoken state. Sanitized so streamed JSON artifacts
     * never reach the screen.
     */
    fun onLiveText(text: String) {
        val clean = sanitizeForSpeech(text)
        if (clean.isNotBlank()) onSubtitle(clean)
    }

    /**
     * Speak one sentence produced mid-stream (see [StreamingReplyExtractor]).
     * Queues it to TTS and marks the turn as having spoken. The subtitle is
     * driven by [onLiveText] during streaming, so this doesn't set it. Sanitized
     * like [speak].
     */
    fun speakSentence(text: String): String {
        val clean = sanitizeForSpeech(text)
        if (clean.isBlank()) return "ok"
        Timber.i("tool.speakSentence: \"$clean\"")
        spokeThisTurn.set(true)
        lastSpoken = if (lastSpoken.isNullOrBlank()) clean else "$lastSpoken $clean"
        face.speak()
        tts.enqueueSentence(clean)
        return "spoken"
    }

    fun setFace(
         expression: String,
    ): String {
        Timber.i("tool.setFace: $expression")
        onToolCall("setFace")
        TurnLog.toolCalled("setFace", expression)
        val e = when (expression.trim().lowercase()) {
            "neutral" -> FaceExpression.Neutral
            "happy" -> FaceExpression.Happy
            "curious" -> FaceExpression.Curious
            "concerned" -> FaceExpression.Concerned
            "surprised" -> FaceExpression.Surprised
            "sleepy" -> FaceExpression.Sleepy
            "wink" -> {
                // Wink is a brief gesture, not a sustained mood — fire the
                // auto-restoring helper so the face returns to its prior
                // expression after ~700ms.
                face.wink()
                onToolCall(null)
                return "ok"
            }
            "sad" -> FaceExpression.Sad
            "excited" -> FaceExpression.Excited
            "angry" -> FaceExpression.Angry
            "love" -> FaceExpression.Love
            else -> {
                onToolCall(null)
                return "unknown expression: $expression"
            }
        }
        face.setExpression(e)
        onToolCall(null)
        return "ok"
    }

    fun silence(): String {
        Timber.i("tool.silence")
        onToolCall("silence")
        TurnLog.toolCalled("silence", null)
        tts.stop()
        face.silence()
        onSubtitle("")
        stopBody()
        onToolCall(null)
        return "ok"
    }

    /** Cancel any in-flight body sequence. Called on barge-in / tap-stop / a
     *  new utterance so a long gesture (e.g. "wiggle") doesn't keep twitching
     *  after the conversation has moved on. Safe to call when nothing runs. */
    fun stopBody() {
        bodyJob?.cancel()
        bodyJob = null
    }

    // ── BodyLink ──────────────────────────────────────────────────────
    // Drive a connected physical body (sim or ESP32). State names live
    // brain-side in BodyStateCatalog (see app/src/main/assets/states.json).
    // If no body is connected this returns a "not connected" string so the
    // reply still speaks. v0 firmware exposes `neck` + `foot` only.

    fun makeBodyMovements(

        sequence: String,
    ): String {
        val link = body
        if (link == null || !link.connected.value) {
            // Log the intended sequence even when offline, so "why didn't it
            // move?" is debuggable from logcat — the LLM still requested it.
            Timber.i("tool.makeBodyMovements: no body connected — would have run: \"$sequence\"")
            return "no body connected; nothing happened"
        }
        val catalog = link.validatedCatalog
        val steps = sequence.split(";").map { it.trim() }.filter { it.isNotEmpty() }
        if (steps.isEmpty()) return "empty sequence"

        TurnLog.toolCalled("makeBodyMovements", sequence)

        // Validate steps NOW (synchronously) so the LLM gets immediate
        // feedback on bad steps. Build a clean list of executable ops.
        val ops = mutableListOf<MoveOp>()
        val problems = mutableListOf<String>()
        for (step in steps) {
            val p = step.split(":").map { it.trim() }
            if (p.size != 2) { problems.add("bad step '$step'"); continue }
            val (key, value) = p
            when (key.lowercase()) {
                "wait" -> {
                    val ms = value.toLongOrNull()
                    if (ms == null || ms < 0) problems.add("bad wait '$step'")
                    else ops.add(MoveOp(waitMs = ms.coerceAtMost(5000L)))
                }
                "neck", "foot" -> {
                    val cmd = catalog.resolve(key.lowercase(), value)
                    if (cmd == null) problems.add("unknown $key state '$value'")
                    else ops.add(MoveOp(part = key.lowercase(), state = value, travelMs = cmd.durationMs.coerceIn(0, 5000)))
                }
                else -> problems.add("unknown part '$key' in '$step'")
            }
        }

        // FIRE-AND-FORGET: run the timed sequence in the background so the
        // agent loop + speech aren't blocked for the whole gesture. Each move
        // auto-waits its travel time so moves don't preempt each other.
        val moves = ops.count { it.part != null }
        if (ops.isNotEmpty()) {
            onToolCall("sequence")
            // A new sequence preempts any still-running one (e.g. user
            // interrupts a "wiggle" with a new command).
            bodyJob?.cancel()
            bodyJob = bodyScope.launch {
                try {
                    for (op in ops) {
                        if (op.part != null && op.state != null) {
                            link.setState(op.part, op.state)
                            kotlinx.coroutines.delay(op.travelMs + 40L)
                        } else {
                            kotlinx.coroutines.delay(op.waitMs)
                        }
                    }
                } finally {
                    onToolCall(null)
                }
            }
        }
        return if (problems.isEmpty()) "ok — running $moves moves"
               else "running $moves moves; issues: ${problems.joinToString()}"
    }

    /**
     * The `move` tool's executor: an ordered sequence of degree-targeted steps.
     * Each step is `{part, degrees, duration_ms?, wait_ms?}`. The brain converts
     * degrees → µs ([DockToolSchemas.degreesToUs], per-part range), commands the
     * body over `duration_ms`, waits the move's travel time + any `wait_ms`, then
     * proceeds. Fire-and-forget so speech isn't blocked; a new sequence preempts
     * a running one (barge-in). Validates synchronously so the model gets
     * immediate feedback on a bad step.
     */
    fun makeMove(steps: kotlinx.serialization.json.JsonArray): String {
        val link = body
        if (link == null || !link.connected.value) {
            Timber.i("tool.makeMove: no body connected — would have run: $steps")
            return "no body connected; nothing happened"
        }
        TurnLog.toolCalled("move", steps.toString())

        val ops = mutableListOf<MoveOp>()
        val problems = mutableListOf<String>()
        for ((i, el) in steps.withIndex()) {
            val o = el as? JsonObject ?: run { problems.add("step ${i + 1}: not an object"); continue }
            val part = o["part"]?.jsonPrimitive?.content?.lowercase().orEmpty()
            val deg = o["degrees"]?.jsonPrimitive?.content?.toDoubleOrNull()
            val durMs = o["duration_ms"]?.jsonPrimitive?.content?.toIntOrNull()?.coerceIn(0, 5000) ?: 400
            val waitMs = o["wait_ms"]?.jsonPrimitive?.content?.toLongOrNull()?.coerceIn(0, 5000) ?: 0L
            if (part !in dev.orbit.dock.llm.DockToolSchemas.DEGREE_RANGE.keys) {
                problems.add("step ${i + 1}: unknown part '$part'"); continue
            }
            if (deg == null) { problems.add("step ${i + 1}: missing/invalid degrees"); continue }
            val us = dev.orbit.dock.llm.DockToolSchemas.degreesToUs(part, deg)
            val label = "${if (deg > 0) "+" else ""}${deg.toInt()}°"
            ops.add(MoveOp(part = part, pulseWidthUs = us, travelMs = durMs, waitMs = waitMs, label = label))
        }

        val moves = ops.count { it.part != null }
        if (ops.isNotEmpty()) {
            onToolCall("move")
            bodyJob?.cancel()
            bodyJob = bodyScope.launch {
                try {
                    for (op in ops) {
                        if (op.part != null && op.pulseWidthUs != null) {
                            link.setAngle(op.part, op.pulseWidthUs, op.travelMs, op.label ?: "")
                            kotlinx.coroutines.delay(op.travelMs + 40L)
                        }
                        if (op.waitMs > 0) kotlinx.coroutines.delay(op.waitMs)
                    }
                } finally {
                    onToolCall(null)
                }
            }
        }
        return if (moves == 0) "no valid steps; issues: ${problems.joinToString()}"
               else if (problems.isEmpty()) "ok — running $moves step(s)"
               else "running $moves step(s); issues: ${problems.joinToString()}"
    }

    /** One step of a body-movement sequence: a move (part + target with a travel
     *  time) and/or a pause after it. `state` (named) and `pulseWidthUs` (raw,
     *  from the degrees `move` tool) are alternative ways to express the target. */
    private data class MoveOp(
        val part: String? = null,
        val state: String? = null,
        val pulseWidthUs: Int? = null,
        val label: String? = null,
        val travelMs: Int = 0,
        val waitMs: Long = 0L,
    )

}

/**
 * Strip LLM tool-call wrapper artifacts that some Ollama models (e.g.
 * gemma) leak verbatim into the speak() text argument when their
 * tool-call schema parsing slips. Anything that looks like a control
 * delimiter (<|...|>), a wrapping speak(text:...) call, or markdown
 * code fences gets removed; remaining whitespace is collapsed.
 *
 * Idempotent — safe to call on already-clean text.
 */
internal fun sanitizeForSpeech(input: String): String {
    var s = input.trim()
    // <|...|> tokens (chat template delimiters).
    s = s.replace(Regex("""<\|[^|]*\|>"""), "")
    // <|tag> opener-only tokens, e.g. <|im_start|>
    s = s.replace(Regex("""<\|[^>]*>"""), "")
    // Wrapped speak(...) calls — sometimes the model emits the function
    // signature as text rather than as a tool call. Three variants seen
    // in the wild on Ollama gemma4:e2b:
    //   speak(text: "...")       — labelled colon
    //   speak(text="...")        — labelled equals
    //   speak("...")             — bare quoted string
    // Repeat the unwrap a couple of times in case the model nested it.
    repeat(3) {
        // Unescape any \" or \' the model may have wrapped a nested call
        // in (so the next regex pass can see the inner speak(...) plainly).
        val unescaped = s.replace("\\\"", "\"").replace("\\'", "'")
        if (unescaped != s) s = unescaped

        // Note: NOT anchored to end of string. Models sometimes emit
        // `speak("...") setFace(happy)` — a single string with the spoken
        // text plus trailing pseudo-tool-calls. We pull out the first
        // speak(...) content and drop the rest.
        val labelled = Regex(
            """(?is)\bspeak\s*\(\s*text\s*[:=]\s*["'`]?(.*?)["'`]?\s*\)""",
        ).find(s)
        if (labelled != null) {
            s = labelled.groupValues[1].trim()
            return@repeat
        }
        val bare = Regex(
            """(?is)\bspeak\s*\(\s*["'`](.*?)["'`]\s*\)""",
        ).find(s)
        if (bare != null) {
            s = bare.groupValues[1].trim()
            return@repeat
        }
    }
    // Final guard: strip any remaining trailing fake-tool-call signatures
    // (setFace(...), glance(...), etc.) that survived the speak() unwrap.
    s = s.replace(
        Regex("""\b(setFace|glance|showSubtitle|wink|silence)\s*\([^)]*\)""", RegexOption.IGNORE_CASE),
        "",
    ).trim()
    // If a nested speak( wrapper survived (the non-greedy regex stopped at
    // the inner closing quote leaving an unmatched outer paren), strip
    // any remaining `speak(...` prefix and trailing `)`/`"` clutter.
    s = s.replace(Regex("""^\s*\bspeak\s*\(\s*["'`]?""", RegexOption.IGNORE_CASE), "")
        .replace(Regex("""["'`]?\s*\)+\s*$"""), "")
        .trim()
    // Markdown code fences and triple-quoted strings.
    s = s.replace(Regex("""(?s)```[a-zA-Z]*\n?"""), "")
        .replace("```", "")
        .replace("\"\"\"", "")
    // Leading "text:" / "response:" labels.
    s = s.replace(Regex("""(?i)^\s*(text|response|reply|message)\s*[:=]\s*"""), "")
    // Stray surrounding quotes.
    s = s.trim().trim('"', '\'', '`')
    // Collapse whitespace runs.
    s = s.replace(Regex("""\s+"""), " ").trim()
    return s
}

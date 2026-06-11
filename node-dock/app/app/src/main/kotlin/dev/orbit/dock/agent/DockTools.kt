package dev.orbit.dock.agent

import dev.orbit.dock.body.BodyController
import dev.orbit.dock.llm.DockToolSchemas
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

/** One recognized face in the frame: a name (confident), a tentative guess, or
 *  neither (unknown), plus where it sits ("left"/"center"/"right"). */
data class RecognizedFace(val name: String?, val tentative: String?, val confidence: Float, val side: String)

/**
 * Result of a fresh server recognition for recollect_face.
 * - [name]: the primary confident match (we're sure) — for the single-identity cache.
 * - [tentative]: a near-match we should CONFIRM with the user ("are you X?").
 * - [noFace]: nothing recognizable in frame.
 * - [people]: EVERY face detected (multi-person), left-to-right.
 */
data class RecognizeOutcome(
    val name: String?,
    val tentative: String?,
    val confidence: Float,
    val noFace: Boolean,
    val people: List<RecognizedFace> = emptyList(),
)

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
     * Optional body. When non-null and connected, [makeMove] sends the timed
     * degree sequence to it. When null or disconnected it returns a "no body
     * connected" string so the reply still speaks but no servo commands are
     * sent. A [BodyController] (not the concrete
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
    /**
     * Optional station-synced config. When present, [expressionGesture] reads
     * the `dock.faceGestures` choreography from it (live-updatable from the
     * station console); when null or a gesture is absent, the hardcoded
     * [defaultGesture] tables are used. Either way the dock still acts out moods.
     */
    private val config: dev.orbit.dock.config.ConfigCache? = null,
    /**
     * Publishes a face-enrollment request to the station (the `remember_face`
     * tool). The station captures the face the dock is currently streaming and
     * stores it under the given name (overwriting). Null → no station link, so
     * remembering faces is unavailable (the tool says so).
     */
    private val onEnrollRequest: ((String) -> Unit)? = null,
    /**
     * Fresh, authoritative face recognition for `recollect_face`: round-trips to
     * the station ("recognize your current frame now") and returns the result, or
     * null on timeout/no-link. When null, recollect falls back to the snapshot
     * hint. See DockScreen for the publish + await wiring.
     */
    private val onRecognizeRequest: (suspend () -> RecognizeOutcome?)? = null,
    /**
     * `confirm_face`: the user confirmed a tentative identity → ask the station to
     * append the current frame as more training data for that name.
     */
    private val onConfirmRequest: ((String) -> Unit)? = null,
    /** `forget_face`: "that's not me" → tell the station to drop the wrong name. */
    private val onForgetRequest: ((String) -> Unit)? = null,
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

    // Body gesture that accompanies an expression (set_face). Kept SEPARATE from
    // bodyJob so an emotive twitch (a sleepy head-droop, an excited wiggle)
    // doesn't cancel an in-flight `move` the model explicitly asked for — and so
    // a new expression only preempts the previous expression's gesture.
    @Volatile private var faceGestureJob: kotlinx.coroutines.Job? = null

    fun beginTurn() {
        spokeThisTurn.set(false)
        lastSpoken = null
        // Tell the speaker a turn is open: sentences will stream in, so a
        // momentarily-empty TTS queue mid-turn is NOT end-of-speech (the gap
        // between streamed sentences must not drop the speaking signal).
        tts.onTurnBegin()
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
        // Close the speaker's turn window: once the TTS queue drains (or now,
        // if it already has) the speaking signal falls — exactly once, at the
        // true end of the reply.
        tts.onTurnEnd()
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
     * `remember_face` tool: ask the station to remember the person currently in
     * front of the camera under [name] (overwrites a prior face for that name).
     * Local guard: only attempt if a face is actually visible. The actual capture
     * happens server-side on the live stream; we optimistically confirm.
     */
    fun rememberFace(name: String): String {
        val clean = name.trim()
        if (clean.isBlank()) return "I need a name to remember them by."
        val present = perception?.facts?.facePresent ?: false
        if (!present) return "I can't see anyone right now, so there's no face to remember."
        val enroll = onEnrollRequest
            ?: return "I can't save faces right now (no link to my memory)."
        enroll(clean)
        return "Okay, I'll remember this person as $clean."
    }

    /**
     * `recollect_face` tool: who am I talking to? Does a fresh server recognition,
     * updates the cache, and answers from BOTH "is a face visible now" and the
     * remembered last person:
     *   - recognized now            → "This is X."
     *   - low-confidence/tentative  → "I think you might be X, but I'm not sure…"
     *   - face now, unknown         → "Someone I don't recognize — tell me who…"
     *   - NO face now, but cached   → "I don't see anyone now, but last I was talking to X."
     *   - nothing                   → "No one's here and I haven't recognized anyone."
     */
    suspend fun recollectFace(): String {
        val fresh = onRecognizeRequest?.invoke()
        // Cache any confident result for the rest of the conversation.
        if (fresh?.name != null) perception?.onIdentity(fresh.name, fresh.confidence)

        val faceNow = perception?.facts?.facePresent ?: (fresh?.noFace == false)
        // MULTIPLE people in frame → list each by position, naming who we know.
        if (fresh != null && fresh.people.size > 1) {
            return describeCrowd(fresh.people)
        }
        if (fresh != null && !fresh.noFace) {
            return when {
                fresh.name != null -> "This is ${fresh.name}."
                fresh.tentative != null ->
                    "I think you might be ${fresh.tentative}, but I'm not certain. Is that you? " +
                        "(if they say yes, call confirm_face; if they say no, call forget_face)"
                else -> "There's someone here I don't recognize yet. Tell me who you are and I'll remember (remember_face)."
            }
        }
        // No face visible now (or no fresh result): fall back to the remembered person.
        val last = perception?.facts?.identity
        return when {
            faceNow && last != null -> "I think it's $last."           // had a face but no fresh result
            last != null -> "I don't see anyone in front of me right now, but the last person I was talking to was $last."
            else -> "There's no one in front of me right now, and I haven't recognized anyone yet."
        }
    }

    /**
     * Render several faces in one frame as a natural sentence, e.g.
     * "I can see 3 people: Guru on the left, someone I don't recognize in the
     * center (maybe Shweta), and Sia on the right." Faces arrive left-to-right.
     */
    private fun describeCrowd(people: List<RecognizedFace>): String {
        fun who(f: RecognizedFace): String = when {
            f.name != null -> "${f.name} on the ${f.side}"
            f.tentative != null -> "someone on the ${f.side} I think might be ${f.tentative}"
            else -> "someone on the ${f.side} I don't recognize"
        }
        val parts = people.map(::who)
        val joined = when (parts.size) {
            2 -> "${parts[0]} and ${parts[1]}"
            else -> parts.dropLast(1).joinToString(", ") + ", and " + parts.last()
        }
        val known = people.count { it.name != null }
        val tail = if (known < people.size) " Tell me who I don't know and I'll remember them (remember_face)." else ""
        return "I can see ${people.size} people: $joined.$tail"
    }

    /**
     * `confirm_face` tool: the user confirmed they are [name] (after a tentative
     * guess). Tell the station to append the current frame as more training data,
     * so recognition improves. Reuses the enroll-request path with a confirm flag.
     */
    fun confirmFace(name: String): String {
        val clean = name.trim()
        if (clean.isBlank()) return "I need the name to confirm."
        onConfirmRequest?.invoke(clean) ?: return "I can't update my memory right now."
        return "Got it — I'll remember your face better now, $clean."
    }

    /**
     * `forget_face` tool: the user said a guess was wrong ("that's not me"). Drop
     * that name's stored face on the station so it stops mis-matching, and clear
     * the local cache. The agent should then ask who they really are and call
     * remember_face. [name] = the WRONG name we mistakenly used.
     */
    fun forgetFace(name: String): String {
        val clean = name.trim()
        if (clean.isBlank()) return "Which name should I forget?"
        onForgetRequest?.invoke(clean) ?: return "I can't update my memory right now."
        perception?.clearIdentity()
        return "Sorry about that — I've forgotten that. Who are you, so I can remember correctly?"
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
                runExpressionGesture("wink")
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
        // Give the body a personality: a mood implies a little physical tell.
        // Fire-and-forget; no-ops gracefully when no body is connected.
        runExpressionGesture(expression.trim().lowercase())
        onToolCall(null)
        return "ok"
    }

    /**
     * Drive a short, expressive body gesture that matches a facial expression —
     * the dock's body "acts out" the mood (sleepy → head droops; excited →
     * happy wiggle; love → dreamy tilt-sway; surprised → snap back). Runs on its
     * own [faceGestureJob] so it never preempts an explicit `move`, and a new
     * expression preempts only the previous expression's gesture. Each gesture
     * ends near neutral so the body doesn't get stuck in a pose. No-op when no
     * body is connected.
     *
     * Joints (see [DockToolSchemas.DEGREE_LIMITS]): `neck` = head tilt/nod,
     * −60°…+35°; `foot` = base swivel, ±90°. Degrees are absolute from neutral.
     */
    private fun runExpressionGesture(expression: String) {
        val link = body
        if (link == null || !link.connected.value) return
        val ops = expressionGesture(expression)
        if (ops.isEmpty()) return
        faceGestureJob?.cancel()
        faceGestureJob = bodyScope.launch {
            for (op in ops) {
                if (op.targets.isNotEmpty()) {
                    link.setAngles(op.targets, op.travelMs)
                    kotlinx.coroutines.delay(op.travelMs + 40L)
                }
                if (op.waitMs > 0) kotlinx.coroutines.delay(op.waitMs)
            }
        }
    }

    /**
     * Choreography for each expression, as a sequence of [MoveOp]s. Small,
     * readable building blocks: [head]/[base] move one joint; [pose] moves both
     * together; [hold] pauses. Amplitudes stay well inside the joint limits so
     * the motion reads as a tell, not a lunge. Most gestures resolve back toward
     * center so the body settles in a natural rest pose.
     */
    private fun expressionGesture(expression: String): List<MoveOp> {
        // Prefer the station-synced choreography (live-editable); fall back to
        // the baked-in default tables. Same move-step shape as the `move` tool.
        config?.obj("faceGestures")?.get(expression)?.let { el ->
            (el as? JsonArray)?.let { steps ->
                val ops = stepsToOps(steps).first
                if (ops.isNotEmpty()) return ops
            }
        }
        return defaultGesture(expression)
    }

    // NECK SIGN CONVENTION (verified on hardware): positive = head DOWN,
    // negative = head UP (matches DockToolSchemas MOVE_DESC). So drooping moods
    // use POSITIVE neck, looking-up moods use NEGATIVE.
    private fun defaultGesture(expression: String): List<MoveOp> = when (expression) {
        // Drowsy: the head sags forward (DOWN), bobs once as if catching itself,
        // then sinks and rests low — "nodding off".
        "sleepy" -> listOf(
            head(30.0, 900), hold(250),
            head(18.0, 350), head(38.0, 1100), hold(300),
        )
        // Warm: a gentle up-bob (UP) and a small body sway, like a happy look-up.
        "happy" -> listOf(
            pose(neck = -12.0, foot = 12.0, ms = 280),
            pose(neck = 0.0, foot = -12.0, ms = 320),
            pose(neck = -8.0, foot = 0.0, ms = 260), center(300),
        )
        // Giddy: a fast head+body wiggle/vibrate — the "laughing shake". Many
        // quick small alternations (symmetric, direction-agnostic), then settle.
        "excited" -> buildList {
            repeat(8) { i ->
                val s = if (i % 2 == 0) 1 else -1
                add(pose(neck = 9.0 * s, foot = 15.0 * s, ms = 80))
            }
            add(center(180))
        }
        // Smitten: a slow dreamy head-tilt UP to one side with a matching lean.
        "love" -> listOf(
            pose(neck = -22.0, foot = 14.0, ms = 700), hold(500),
            pose(neck = -16.0, foot = 8.0, ms = 600),
        )
        // Inquisitive: cock the head UP and SLOWLY sway the body left↔right in
        // parallel — "hmm, what's this?". Neck holds the tilt while the foot
        // pans side to side.
        "curious" -> listOf(
            pose(neck = -18.0, foot = -22.0, ms = 700), hold(300),
            pose(neck = -14.0, foot = 22.0, ms = 1100), hold(300),
            pose(neck = -18.0, foot = -16.0, ms = 1000),
            pose(neck = -14.0, foot = 0.0, ms = 700),
        )
        // Startled: a quick snap UP-and-back, freeze, then ease down toward level.
        "surprised" -> listOf(
            head(-38.0, 130), hold(450), head(-20.0, 350),
        )
        // Crestfallen: the head sinks low (DOWN) and the body turns slightly away.
        "sad" -> listOf(
            pose(neck = 28.0, foot = 30.0, ms = 1000), hold(400),
            head(34.0, 700),
        )
        // Indignant: sharp little "no!" head-shakes, tense and quick.
        "angry" -> listOf(
            base(-30.0, 130), base(30.0, 130), base(-26.0, 130), base(24.0, 130),
            center(180),
        )
        // Uneasy: a quick little side-to-side "no/no" head shake (foot yaw) —
        // "I'm not sure".
        "concerned" -> listOf(
            base(-16.0, 180), base(16.0, 200), base(-14.0, 180),
            base(12.0, 180), center(220),
        )
        // Playful: a tiny double head-tilt to punctuate the eye-wink.
        "wink" -> listOf(head(16.0, 200), head(0.0, 220))
        // Reset to a calm, square rest pose.
        "neutral" -> listOf(center(450))
        else -> emptyList()
    }

    // ── gesture building blocks (absolute degrees from neutral) ──────────────
    private fun head(deg: Double, ms: Int) =
        MoveOp(targets = mapOf("neck" to (DockToolSchemas.degreesToUs("neck", deg) to fmtDeg(deg))), travelMs = ms)
    private fun base(deg: Double, ms: Int) =
        MoveOp(targets = mapOf("foot" to (DockToolSchemas.degreesToUs("foot", deg) to fmtDeg(deg))), travelMs = ms)
    private fun pose(neck: Double, foot: Double, ms: Int) = MoveOp(
        targets = mapOf(
            "neck" to (DockToolSchemas.degreesToUs("neck", neck) to fmtDeg(neck)),
            "foot" to (DockToolSchemas.degreesToUs("foot", foot) to fmtDeg(foot)),
        ),
        travelMs = ms,
    )
    private fun center(ms: Int) = pose(neck = 0.0, foot = 0.0, ms = ms)
    private fun hold(ms: Long) = MoveOp(targets = emptyMap(), travelMs = 0, waitMs = ms)
    private fun fmtDeg(deg: Double) = "${if (deg > 0) "+" else ""}${deg.toInt()}°"

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
        faceGestureJob?.cancel()
        faceGestureJob = null
    }

    // ── BodyLink ──────────────────────────────────────────────────────
    // Drive a connected physical body (sim or ESP32) via the `move` tool.
    // If no body is connected this returns a "not connected" string so the
    // reply still speaks. v0 firmware exposes `neck` + `foot` only.
    // (The legacy named-state `makeBodyMovements` path was removed — the
    // degree-based `move` tool replaced it and nothing called it anymore.)

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

        val (ops, problems) = stepsToOps(steps)

        if (ops.isNotEmpty()) {
            onToolCall("move")
            bodyJob?.cancel()
            bodyJob = bodyScope.launch {
                try {
                    for (op in ops) {
                        if (op.targets.isNotEmpty()) {
                            // all of this step's joints start together (one set_target).
                            link.setAngles(op.targets, op.travelMs)
                            kotlinx.coroutines.delay(op.travelMs + 40L)
                        }
                        if (op.waitMs > 0) kotlinx.coroutines.delay(op.waitMs)
                    }
                } finally {
                    onToolCall(null)
                }
            }
        }
        val moves = ops.size
        return if (moves == 0) "no valid steps; issues: ${problems.joinToString()}"
               else if (problems.isEmpty()) "ok — running $moves step(s)"
               else "running $moves step(s); issues: ${problems.joinToString()}"
    }

    /**
     * Parse the move-step JSON shape into executable [MoveOp]s. The single
     * vocabulary shared by the `move` tool and config-driven face gestures:
     * each step is `{part,degrees}` or `{parts:[...]}` (joints move together),
     * with optional `duration_ms` (travel) + `wait_ms` (trailing pause); a bare
     * `{wait_ms}` is a pause step. Degrees → µs on the fixed scale, clamped per
     * part. Returns (ops, problems) so callers can surface bad steps.
     */
    private fun stepsToOps(steps: JsonArray): Pair<List<MoveOp>, List<String>> {
        val ops = mutableListOf<MoveOp>()
        val problems = mutableListOf<String>()
        for ((i, el) in steps.withIndex()) {
            val o = el as? JsonObject ?: run { problems.add("step ${i + 1}: not an object"); continue }
            val durMs = o["duration_ms"]?.jsonPrimitive?.content?.toIntOrNull()?.coerceIn(0, 5000) ?: 400
            val waitMs = o["wait_ms"]?.jsonPrimitive?.content?.toLongOrNull()?.coerceIn(0, 5000) ?: 0L

            val jointEls: List<JsonObject> = when {
                o["parts"] is JsonArray -> (o["parts"] as JsonArray).filterIsInstance<JsonObject>()
                o["part"] != null -> listOf(o) // single-joint form: the step itself
                else -> emptyList()
            }

            if (jointEls.isEmpty()) {
                if (waitMs > 0) ops.add(MoveOp(targets = emptyMap(), travelMs = 0, waitMs = waitMs))
                else problems.add("step ${i + 1}: no part/parts and no wait_ms")
                continue
            }

            val targets = LinkedHashMap<String, Pair<Int, String>>()
            for (j in jointEls) {
                val part = j["part"]?.jsonPrimitive?.content?.lowercase().orEmpty()
                val deg = j["degrees"]?.jsonPrimitive?.content?.toDoubleOrNull()
                if (part !in DockToolSchemas.DEGREE_RANGE.keys) {
                    problems.add("step ${i + 1}: unknown part '$part'"); continue
                }
                if (deg == null) { problems.add("step ${i + 1}: $part missing/invalid degrees"); continue }
                targets[part] = DockToolSchemas.degreesToUs(part, deg) to fmtDeg(deg)
            }
            if (targets.isNotEmpty()) ops.add(MoveOp(targets = targets, travelMs = durMs, waitMs = waitMs))
        }
        return ops to problems
    }

    /** One step of a body-movement sequence: a set of joint targets that move
     *  TOGETHER (part → (pulse_width_us, label)) over `travelMs`, then a pause.
     *  A single-joint step is just a one-entry map; an empty map is a pause. */
    private data class MoveOp(
        val targets: Map<String, Pair<Int, String>> = emptyMap(),
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

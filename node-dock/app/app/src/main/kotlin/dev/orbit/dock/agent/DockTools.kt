package dev.orbit.dock.agent

import dev.orbit.dock.tts.Speaker
import dev.orbit.dock.ui.face.FaceController
import dev.orbit.dock.ui.face.FaceExpression
import timber.log.Timber
import java.util.concurrent.atomic.AtomicBoolean

/** One recognized face in the frame: a name (confident), a tentative guess, or
 *  neither (unknown), plus where it sits ("left"/"center"/"right"). */
data class RecognizedFace(val name: String?, val tentative: String?, val confidence: Float, val side: String)

/**
 * Result of a station face recognition (the pre-turn grounding frame).
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
 * The dock's LOCAL effectors — face UI, TTS, subtitle — plus the perception
 * reads that ground each turn. Since the server-brain cutover this is the
 * phone-surface only: the LLM loop, body motion, gestures, and the face-memory
 * tools all run in orbit-station ([RemoteBrain] just renders its frames here).
 *
 * Threading: called from RemoteBrain's IO coroutines and the StationLink
 * reader. Side effects fan out to UI state flows + the Android TextToSpeech
 * engine (which has its own thread).
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
     * Optional live senses (camera face-presence, the user's read emotion, gaze
     * direction). When present, [currentContext] tells the brain what the dock
     * can actually see, so "what are you looking at?" / "how do I seem?" are
     * grounded rather than guessed. Null → no visual context (mic-only dock).
     */
    private val perception: PerceptionSnapshot? = null,
    /** Actuate the camera zoom (the brain's `set_zoom` tool). Returns a human string
     *  echoing the clamped ratio, or an "unavailable" message if no camera is bound.
     *  Default = no camera wired (mic-only dock). */
    private val setZoom: (Float) -> String = { "camera zoom is not available on this dock" },
    /** Float a picture over the face for a while (visual_search's "gotcha"
     *  reveal — the station's show-image frame). null clears. Default = no-op
     *  (headless/test docks). */
    private val onShowImage: (android.graphics.Bitmap?, Long) -> Unit = { _, _ -> },
    /** On-demand HIGH-RES still (base64 JPEG, ≤maxEdge px) — visual_search's
     *  identity escalation: stream frames can't identify across a room. null =
     *  no camera / capture failed. */
    val captureStill: suspend (Int, Int) -> String? = { _, _ -> null },
    /** Fires the visible HEARD flash on the face (the audible pip is played
     *  here in [heardCue]). Default no-op for headless docks. */
    private val onHeard: () -> Unit = {},
) {

    private val spokeThisTurn = AtomicBoolean(false)
    @Volatile private var lastSpoken: String? = null

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

    /**
     * A clean snapshot of the dock's current visible state, shipped with each
     * turn-request as the brain's situational grounding (the brain composes
     * the body half itself — it owns the body link now). Recomputed per turn.
     *
     * Example: "YOUR face: concerned — because you look sad, so I'm concerned
     *           about you. You can see guru; they appear sad."
     *
     * TWO FACES, NAMED APART. This line carries the ROBOT's face and, right after
     * it, the HUMAN's — and they used to arrive as "Current face: angry" beside
     * "they appear sad", one word apart, with no hint which was whose. Result:
     * asked "why are you angry?" the dock confabulated ("my internal feelings
     * show up automatically") when the truth was that a camera had copied the
     * user's anger onto it. So: say YOUR face, say WHY, and never let the two
     * subjects share a word.
     */
    fun currentContext(): String {
        val sb = StringBuilder()
        val reason = face.moodReason.value
        sb.append("YOUR face (the robot's, on your screen): ")
            .append(face.expression.value.name.lowercase())
        sb.append(" — because ").append(reason.why).append('.')
        // A REACTION is a response to the person, not a feeling the dock arrived
        // at on its own. Say so outright: this is the single case where the LLM
        // would otherwise claim it as its own mood — the reported bug.
        if (reason.source == "react") {
            sb.append(" (That's your camera-read reaction to THEM, not a mood you chose —")
                .append(" say so plainly if asked.)")
        }
        // Live senses: what the camera sees right now (face present, the user's
        // read emotion, gaze). Omitted entirely when nothing is in view.
        perception?.describe()?.let { sb.append(' ').append(it) }
        return sb.toString()
    }

    /**
     * Speak a system message (e.g. failure narration) without marking the turn
     * as having had a real reply. Lets RemoteBrain surface failure lines
     * audibly while still treating the turn as "needs a real answer".
     */
    fun speakSystem(text: String) {
        val clean = sanitizeForSpeech(text)
        Timber.i("tool.speakSystem: \"$clean\"")
        if (clean.isBlank()) return
        face.speak()
        tts.enqueueSentence(clean)
        onSubtitle(clean)
    }

    // ── effectors ──────────────────────────────────────────────────────

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
     * Update the subtitle with the reply text so far, as sentences stream in
     * from the brain. Display only — TTS is driven separately by
     * [speakSentence] — so this does NOT touch the turn's spoken state.
     * Sanitized so streamed artifacts never reach the screen.
     */
    fun onLiveText(text: String) {
        val clean = sanitizeForSpeech(text)
        if (clean.isNotBlank()) onSubtitle(clean)
    }

    /**
     * Speak one sentence produced mid-stream (the brain ships them pre-split,
     * one `speak` frame per sentence). Queues it to TTS and marks the turn as
     * having spoken. The subtitle is driven by [onLiveText], so this doesn't
     * set it. Sanitized like [speak].
     */
    @JvmOverloads
    fun speakSentence(text: String, onPlaybackStart: (() -> Unit)? = null): String {
        val clean = sanitizeForSpeech(text)
        if (clean.isBlank()) return "ok"
        Timber.i("tool.speakSentence: \"$clean\"")
        spokeThisTurn.set(true)
        lastSpoken = if (lastSpoken.isNullOrBlank()) clean else "$lastSpoken $clean"
        face.speak()
        tts.enqueueSentence(clean, onPlaybackStart)
        return "spoken"
    }

    /**
     * Fix 5: a sentence's inline mood goes LIVE — called from the TTS playback
     * clock at the exact moment that sentence's audio starts, so the face
     * changes WITH the words (not seconds early at parse). No tool chrome
     * (this is choreography, not a tool call); wink stays the brief overlay.
     */
    /** Decode + float a JPEG over the face for [ttlMs] (the station's
     *  show-image frame). Decode failures are logged and dropped — a bad
     *  payload must never take the face down. */
    fun showImage(jpegB64: String, ttlMs: Long) {
        try {
            val bytes = android.util.Base64.decode(jpegB64, android.util.Base64.DEFAULT)
            val bmp = android.graphics.BitmapFactory.decodeByteArray(bytes, 0, bytes.size)
            if (bmp == null) { Timber.w("showImage: undecodable jpeg (%d bytes)", bytes.size); return }
            onShowImage(bmp, ttlMs)
        } catch (e: Exception) {
            Timber.w(e, "showImage failed")
        }
    }

    /** Your words were captured and the brain is on it — the unmistakable
     *  across-the-room acknowledgment: rising double pip + face flash. Fired
     *  at endpoint→turn-send and on the station's heard-during-turn frame. */
    fun heardCue() {
        runCatching { dev.orbit.dock.ui.face.BeepPlayer.heard() }
        onHeard()
    }

    fun moodLive(expression: String) {
        val why = "it fits what I'm saying right now"
        if (expression.trim().lowercase() == "wink") { face.wink(why = why); return }
        val e = parseExpression(expression) ?: return
        face.setExpression(e, why = why, source = "llm")
    }

    /**
     * @param reason the brain's OWN account of why, in the dock's voice ("you
     *   said the deploy failed"). The LLM is the one setter that actually knows
     *   this, and it used to be discarded at the moment it existed. Passed
     *   through, it comes back next turn in [currentContext] — so "why do you
     *   look concerned?" is answered from the dock's own record, not invented.
     *   Empty → a generic-but-true fallback (an inline `[face:]` tag can't carry
     *   a reason: it's one token, and keeping it cheap is its whole purpose).
     */
    /**
     * @param source who set it — `llm` (the brain), `debug` (a test hook / panel).
     *   NOT cosmetic: it is how a reader tells the dock's own intent from a mood
     *   someone else planted. Defaulting a forced face to "llm" made the dock
     *   claim it had chosen a mood a debug tool pushed — the exact confabulation
     *   this whole change exists to stop.
     */
    @JvmOverloads
    fun setFace(
        expression: String,
        reason: String = "",
        source: String = "llm",
    ): String {
        Timber.i("tool.setFace: $expression${if (reason.isBlank()) "" else " ($reason)"}")
        onToolCall("setFace")
        TurnLog.toolCalled("setFace", expression)
        // A blank reason from the BRAIN means it didn't say why (an inline
        // [face:] tag can't carry one) — that's still true. A blank from any
        // other source must not borrow the brain's voice.
        val why = reason.ifBlank {
            if (source == "llm") "it matched what I was saying" else "something set it without saying why"
        }
        if (expression.trim().lowercase() == "wink") {
            // Wink is a brief gesture, not a sustained mood — fire the
            // auto-restoring helper so the face returns to its prior
            // expression after ~700ms. (The matching BODY gesture is the
            // station's job now — it plays the faceGestures choreography.)
            face.wink(why = why)
            onToolCall(null)
            return "ok"
        }
        val e = parseExpression(expression)
        if (e == null) {
            onToolCall(null)
            return "unknown expression: $expression"
        }
        face.setExpression(e, why = why, source = source)
        onToolCall(null)
        return "ok"
    }

    private fun parseExpression(expression: String): FaceExpression? =
        when (expression.trim().lowercase()) {
            "neutral" -> FaceExpression.Neutral
            "happy" -> FaceExpression.Happy
            "curious" -> FaceExpression.Curious
            "concerned" -> FaceExpression.Concerned
            "surprised" -> FaceExpression.Surprised
            "sleepy" -> FaceExpression.Sleepy
            "sad" -> FaceExpression.Sad
            "excited" -> FaceExpression.Excited
            "angry" -> FaceExpression.Angry
            "love" -> FaceExpression.Love
            else -> null
        }

    /**
     * TEST HOOK — report what the face is ACTUALLY showing, right now.
     *
     * The phone's face state has been unobservable from off-device: this dock has
     * no adb, and nothing reported up. Two bugs shipped straight past review
     * because of it (a wake regression; a "sweat bead" that still rendered as a
     * tear). Anything that can drive the dock can now also SEE it — the station
     * calls this over the existing `face` cap (see docs/testing/face-harness.md).
     *
     * Read-only: touches no state, allocates nothing lasting, safe in release.
     * Deliberately one flat line — greppable in logs and trivially parsed.
     */
    fun faceProbe(): String {
        val expr = face.expression.value.name.lowercase()
        val state = face.state.value.name.lowercase()
        val speaker = face.speaker.value.name.lowercase()
        val style = face.faceId.value
        val privacy = face.privacy.value
        val gaze = face.gaze.value
        val sees = perception?.facts
        return buildString {
            append("expression=").append(expr)
            append(" state=").append(state)
            append(" speaker=").append(speaker)
            append(" style=").append(style)
            append(" privacy=").append(privacy)
            append(" gaze=").append("%.2f,%.2f".format(gaze.x, gaze.y))
            // (userEmotion — the human's camera-read emotion — was retired with the
            // on-device FER path; the station reads emotion from the SFU stream now.)
            append(" facePresent=").append(sees?.facePresent ?: false)
            // WHY the dock wears this face. moodSource is the filterable tag
            // ("mirror" = it's the human's mood, borrowed); moodWhy is the
            // speakable account. Last, and space-joined, so the flat k=v parse
            // upstream keeps working — moodWhy may contain spaces, so it MUST
            // stay the final field.
            append(" moodSource=").append(face.moodReason.value.source)
            append(" moodAgeMs=").append(System.currentTimeMillis() - face.moodReason.value.atMs)
            append(" moodWhy=").append(face.moodReason.value.why)
        }
    }

    /** Switch the dock's whole face appearance + voice (e.g. "be a cat" / Vader).
     *  Persistence + re-voicing happen via FaceController.onFaceStyleChanged. */
    fun setFaceStyle(style: String): String {
        Timber.i("tool.setFaceStyle: $style")
        onToolCall("setFaceStyle")
        TurnLog.toolCalled("setFaceStyle", style)
        val ok = face.setFaceStyle(style.trim().lowercase())
        onToolCall(null)
        return if (ok) "ok" else "unknown style: $style"
    }

    /** Zoom the camera to an absolute [ratio] (1.0 = no zoom). Delegates to the
     *  camera-owning lambda, which clamps to the device's supported range and
     *  returns the applied value. */
    fun zoom(ratio: Float): String {
        Timber.i("tool.zoom: $ratio")
        onToolCall("zoom")
        TurnLog.toolCalled("zoom", ratio.toString())
        val r = setZoom(ratio)
        onToolCall(null)
        return r
    }

    /** Hold / release TTS playback mid-reply (the barge-in "polite pause").
     *  Unlike [silence], nothing is dropped: the queue, the speaking signal and
     *  the turn stay up, and release continues playback where it stopped. */
    fun holdSpeech(hold: Boolean): String {
        Timber.i("tool.holdSpeech hold=$hold")
        if (hold) tts.pause() else tts.resume()
        return "ok"
    }

    fun silence(): String {
        Timber.i("tool.silence")
        onToolCall("silence")
        TurnLog.toolCalled("silence", null)
        tts.stop()
        face.silence()
        onSubtitle("")
        onToolCall(null)
        return "ok"
    }
}

/**
 * Strip LLM tool-call wrapper artifacts that some models leak verbatim into
 * spoken text when their tool-call schema parsing slips. Anything that looks
 * like a control delimiter (<|...|>), a wrapping speak(text:...) call, or
 * markdown code fences gets removed; remaining whitespace is collapsed.
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

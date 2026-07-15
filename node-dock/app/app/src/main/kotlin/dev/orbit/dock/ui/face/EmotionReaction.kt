package dev.orbit.dock.ui.face

import dev.orbit.dock.perception.PerceptionEvent.UserEmotion

/**
 * How the dock REACTS to the emotion it reads on your face.
 *
 * Not a mirror. Mirroring — the old behaviour — copied your expression onto the
 * dock verbatim: you look angry, it looks angry back. That produced the two bugs
 * actually reported. It looked *random* (a 1 Hz classifier flickering onto the
 * screen with nothing asking for it), and it made the dock wear a mood the brain
 * would never choose, then have to explain it away ("why are you angry?" — "I'm
 * not, I was reflecting you"). A person who answers your sadness by pulling a sad
 * face at you is unsettling; the human response is CONCERN. That difference is
 * this whole file.
 *
 * The evidence for "the brain picks better moods than the camera": across 805
 * real inline mood tags the brain sent `neutral`/`curious`/`happy`/`concerned`
 * and **never** `sad` or `angry`. The mirror was the only reason this dock had
 * ever looked angry.
 *
 * No LLM here on purpose — it must land in ~1 frame, cost nothing, and work with
 * the brain offline. It's a lookup table plus two gates.
 */
object EmotionReaction {

    /**
     * The dock's answer to a read emotion, or null for "don't touch the face".
     *
     * Empathy, not echo:
     *  - happy → happy. Joy is the one emotion worth reflecting; it reads as
     *    sharing, not mimicry.
     *  - sad → CONCERNED. The key line. Concern is what care looks like.
     *  - angry → CONCERNED, deliberately NOT angry. Anger mirrored back is
     *    escalation; the dock should look like it noticed and cares. This single
     *    mapping kills the reported bug.
     *  - surprised → surprised. A shared startle is natural, and it's brief.
     *  - sleepy → null. Their drooping eyes are not the dock's mood — and the
     *    dock has its OWN sleepy (the 90s idle timer). Letting a yawn trigger it
     *    would collide two unrelated meanings on one face.
     *  - neutral → neutral. Lets the face settle back once you do.
     */
    fun reactionTo(kind: UserEmotion.Kind): FaceExpression? = when (kind) {
        UserEmotion.Kind.Happy -> FaceExpression.Happy
        UserEmotion.Kind.Sad -> FaceExpression.Concerned
        UserEmotion.Kind.Angry -> FaceExpression.Concerned
        UserEmotion.Kind.Surprised -> FaceExpression.Surprised
        UserEmotion.Kind.Sleepy -> null
        UserEmotion.Kind.Neutral -> FaceExpression.Neutral
    }

    /** One glyph for the emotion read on the USER's face — for the debug overlay.
     *  A word needs reading; an emoji lands at a glance, which is the whole point
     *  of a HUD you check while pulling a face at the camera. */
    fun emojiFor(kind: UserEmotion.Kind): String = when (kind) {
        UserEmotion.Kind.Happy -> "😀"
        UserEmotion.Kind.Sad -> "😢"
        UserEmotion.Kind.Angry -> "😠"
        UserEmotion.Kind.Surprised -> "😮"
        UserEmotion.Kind.Sleepy -> "😴"
        UserEmotion.Kind.Neutral -> "😐"
    }

    /** One glyph for the dock's own resulting face — so the overlay shows the
     *  REACTION, not just the read. Seeing 😠→🙁 side by side is the fix made
     *  visible: your anger, its concern. */
    fun emojiForReaction(e: FaceExpression): String = when (e) {
        FaceExpression.Happy -> "😀"
        FaceExpression.Concerned -> "🙁"
        FaceExpression.Surprised -> "😮"
        FaceExpression.Sad -> "😢"
        FaceExpression.Angry -> "😠"
        FaceExpression.Sleepy -> "😴"
        FaceExpression.Curious -> "🤔"
        FaceExpression.Excited -> "🤩"
        FaceExpression.Love -> "🥰"
        FaceExpression.Wink -> "😉"
        FaceExpression.Neutral -> "😐"
    }

    /** What the dock says when asked why — must be TRUE, and must not claim the
     *  read emotion as the dock's own feeling (that was the confabulation). */
    fun reasonFor(kind: UserEmotion.Kind): String = when (kind) {
        UserEmotion.Kind.Happy -> "you look happy, so I'm happy too"
        UserEmotion.Kind.Sad -> "you look sad, so I'm concerned about you"
        UserEmotion.Kind.Angry -> "you look upset, so I'm concerned — I'm not angry myself"
        UserEmotion.Kind.Surprised -> "you looked surprised, so I did too"
        UserEmotion.Kind.Neutral -> "you look calm, so I settled back to neutral"
        UserEmotion.Kind.Sleepy -> "you look tired"
    }

    /**
     * Confidence floor per emotion. The consumer used to ignore `confidence`
     * ENTIRELY — a coin-flip "angry" hit the face with the same authority as a
     * certain one. That is the "random emotions" bug at its source.
     *
     * CALIBRATE AGAINST THE MODEL, NOT INTUITION. The first cut of these numbers
     * (angry 0.75) was set by gut feel and was **unreachable in practice**: this
     * `confidence` is an EMA-smoothed softmax over 8 FER classes
     * (FaceTracker.classifyEmotion), so probability mass is split and real reads
     * land LOW — a clear neutral measured **0.62** live. FaceTracker's own bar for
     * "confident enough to name an emotion at all" is **0.35**; demanding 0.75
     * meant the dock could literally never react, which is exactly what the user
     * saw. (See memory: "perception hallucination knobs — use the model's own
     * logprob", i.e. the model's scale, not a made-up one.)
     *
     * So these sit just above FaceTracker's own 0.35 floor, staying asymmetric —
     * a wrong `happy` is a cheap, friendly mistake; a wrong `concerned` makes the
     * dock look worried at someone who is fine, which reads as broken. The
     * *persistence* gate (holdMs) is the real noise defence; this floor only
     * rejects the genuinely ambiguous.
     */
    fun minConfidence(kind: UserEmotion.Kind): Float = when (kind) {
        UserEmotion.Kind.Happy -> 0.40f
        UserEmotion.Kind.Surprised -> 0.45f
        UserEmotion.Kind.Sad -> 0.45f
        UserEmotion.Kind.Angry -> 0.50f
        UserEmotion.Kind.Neutral -> 0.35f   // the resting state — easy to fall back to
        UserEmotion.Kind.Sleepy -> 1.1f     // unreachable: never react (see reactionTo)
    }

    /**
     * How long a read must PERSIST before the dock reacts.
     *
     * FER is jittery frame-to-frame but stable over ~a second, and the emit path
     * fires on any change after 300ms — so a single flickered frame used to reach
     * the face. A real mood lasts; a misread doesn't. This is the biggest single
     * lever against the flicker, and it's why the gate is a debounce, not a filter.
     *
     * Neutral settles fast (returning to rest should feel prompt); the strong
     * reads must hold, so a passing grimace is ignored.
     */
    fun holdMs(kind: UserEmotion.Kind): Long = when (kind) {
        UserEmotion.Kind.Neutral -> 800L
        UserEmotion.Kind.Happy -> 1_200L
        else -> 2_000L
    }
}

/**
 * Debounces raw FER reads into a settled reaction.
 *
 * Pure + clock-injected so it's unit-testable with no camera and no device — the
 * face bugs this session all shipped past green tests precisely because the real
 * behaviour lived somewhere untestable.
 */
class EmotionGate(private val nowMs: () -> Long = { System.currentTimeMillis() }) {

    private var candidate: UserEmotion.Kind? = null
    private var candidateSinceMs = 0L
    private var lastReacted: UserEmotion.Kind? = null

    /**
     * Feed one FER read. Returns the expression to show, or null to leave the
     * face alone (low confidence, not held long enough, or already showing it).
     */
    fun onRead(kind: UserEmotion.Kind, confidence: Float): FaceExpression? {
        val now = nowMs()

        // Below the bar for THIS emotion → not evidence of anything. Don't let it
        // reset the candidate either: a low-confidence blip in the middle of a
        // steady read shouldn't restart the clock.
        if (confidence < EmotionReaction.minConfidence(kind)) return null

        if (kind != candidate) {
            candidate = kind
            candidateSinceMs = now
            return null
        }
        if (now - candidateSinceMs < EmotionReaction.holdMs(kind)) return null
        if (kind == lastReacted) return null      // already reacted to this read

        val reaction = EmotionReaction.reactionTo(kind) ?: return null
        lastReacted = kind
        return reaction
    }

    /** The face left the frame — forget everything, so their next arrival is
     *  judged fresh rather than against a stale candidate from minutes ago. */
    fun onFaceLost() {
        candidate = null
        lastReacted = null
    }
}

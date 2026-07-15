package dev.orbit.dock.ui.face

import com.google.common.truth.Truth.assertThat
import dev.orbit.dock.perception.PerceptionEvent.UserEmotion
import org.junit.Test

/**
 * The dock REACTS to your face; it does not mirror it.
 *
 * The old path copied the read emotion straight onto the screen, ungated:
 * `confidence` was ignored entirely and any change after 300ms won. That is both
 * reported bugs — "random emotions keep coming" (a 1 Hz classifier flickering
 * onto the face) and "it looks angry but says it isn't" (the dock wearing a mood
 * the brain would never pick, then explaining it away).
 */
class EmotionReactionTest {

    /** The mapping that IS the fix: anger is met with concern, never echoed. */
    @Test
    fun angerIsMetWithConcernNotEchoed() {
        assertThat(EmotionReaction.reactionTo(UserEmotion.Kind.Angry))
            .isEqualTo(FaceExpression.Concerned)
        assertThat(EmotionReaction.reactionTo(UserEmotion.Kind.Sad))
            .isEqualTo(FaceExpression.Concerned)
        // Joy is the one worth reflecting — it reads as sharing, not mimicry.
        assertThat(EmotionReaction.reactionTo(UserEmotion.Kind.Happy))
            .isEqualTo(FaceExpression.Happy)
        // The dock's OWN sleepy is the 90s idle timer. A yawning user must not
        // collide two unrelated meanings onto one face.
        assertThat(EmotionReaction.reactionTo(UserEmotion.Kind.Sleepy)).isNull()
    }

    /** The dock never claims the read emotion as its own feeling. */
    @Test
    fun theReasonNeverClaimsTheUsersEmotionAsTheDocksOwn() {
        val why = EmotionReaction.reasonFor(UserEmotion.Kind.Angry)
        assertThat(why).contains("you look upset")
        assertThat(why).contains("not angry myself")
    }

    /** A low-confidence read is a coin flip, not evidence. This is the "random
     *  emotions" bug at its source: `confidence` used to be ignored entirely. */
    @Test
    fun aLowConfidenceReadNeverReachesTheFace() {
        var t = 0L
        val gate = EmotionGate { t }
        repeat(20) {
            assertThat(gate.onRead(UserEmotion.Kind.Angry, confidence = 0.4f)).isNull()
            t += 500
        }
    }

    /** A single flickered frame must not reach the face — a real mood persists. */
    @Test
    fun aFlickerIsIgnoredButASustainedReadLands() {
        var t = 0L
        val gate = EmotionGate { t }

        // One confident angry frame, then it's gone. Nothing should happen.
        assertThat(gate.onRead(UserEmotion.Kind.Angry, 0.9f)).isNull()
        t += 300
        assertThat(gate.onRead(UserEmotion.Kind.Neutral, 0.9f)).isNull()

        // Now they're genuinely upset — held past the 2s bar.
        t += 100
        assertThat(gate.onRead(UserEmotion.Kind.Angry, 0.9f)).isNull()
        t += 2_100
        assertThat(gate.onRead(UserEmotion.Kind.Angry, 0.9f))
            .isEqualTo(FaceExpression.Concerned)
    }

    /** React ONCE per read — not on every frame of a sustained expression. */
    @Test
    fun aSustainedReadReactsOnlyOnce() {
        var t = 0L
        val gate = EmotionGate { t }
        gate.onRead(UserEmotion.Kind.Happy, 0.9f)
        t += 1_300
        assertThat(gate.onRead(UserEmotion.Kind.Happy, 0.9f)).isEqualTo(FaceExpression.Happy)
        t += 1_000
        assertThat(gate.onRead(UserEmotion.Kind.Happy, 0.9f)).isNull()  // already reacted
    }

    /** A low-confidence blip mid-read must not restart the hold clock — else a
     *  noisy stream never accumulates enough to react at all. */
    @Test
    fun aLowConfidenceBlipDoesNotRestartTheHold() {
        var t = 0L
        val gate = EmotionGate { t }
        gate.onRead(UserEmotion.Kind.Happy, 0.9f)
        t += 700
        gate.onRead(UserEmotion.Kind.Angry, 0.2f)   // noise, below the bar → ignored
        t += 700                                     // total 1400 > happy's 1200ms
        assertThat(gate.onRead(UserEmotion.Kind.Happy, 0.9f)).isEqualTo(FaceExpression.Happy)
    }

    /** Whoever shows up next is judged fresh, not against a stale candidate. */
    @Test
    fun faceLostResetsTheGate() {
        var t = 0L
        val gate = EmotionGate { t }
        gate.onRead(UserEmotion.Kind.Happy, 0.9f)
        t += 1_300
        assertThat(gate.onRead(UserEmotion.Kind.Happy, 0.9f)).isEqualTo(FaceExpression.Happy)

        gate.onFaceLost()
        // A different person, same emotion: must re-earn it, and CAN react again.
        assertThat(gate.onRead(UserEmotion.Kind.Happy, 0.9f)).isNull()
        t += 1_300
        assertThat(gate.onRead(UserEmotion.Kind.Happy, 0.9f)).isEqualTo(FaceExpression.Happy)
    }

    /** Negative reads must clear a higher bar than positive ones: a wrong `happy`
     *  is a friendly mistake, a wrong `concerned` looks broken. */
    @Test
    fun negativeReadsNeedMoreConfidenceThanPositiveOnes() {
        assertThat(EmotionReaction.minConfidence(UserEmotion.Kind.Angry))
            .isGreaterThan(EmotionReaction.minConfidence(UserEmotion.Kind.Happy))
        assertThat(EmotionReaction.minConfidence(UserEmotion.Kind.Sad))
            .isGreaterThan(EmotionReaction.minConfidence(UserEmotion.Kind.Happy))
    }

    /**
     * The thresholds must live on the FER MODEL's scale, not an invented one.
     *
     * This confidence is an EMA-smoothed softmax over 8 classes, so mass is split
     * and real reads land LOW — a clear neutral measured **0.62** on the live
     * dock. The first cut demanded 0.75 for angry: **unreachable**, so the dock
     * could never react to a real face, which is exactly what the user saw
     * ("I looked annoyed at it, nothing happened").
     *
     * FaceTracker.classifyEmotion's own bar for naming an emotion at all is 0.35.
     * Any floor here must sit near it — a floor far above it means "never".
     */
    @Test
    fun thresholdsSitOnTheFerModelsActualScale() {
        val ferNamesAnEmotionAbove = 0.35f
        // A CLEAR read on the live dock measured 0.62. Every reactive threshold
        // must be reachable by a read like that, or the feature is dead code.
        val aClearRealRead = 0.62f
        for (kind in listOf(
            UserEmotion.Kind.Happy, UserEmotion.Kind.Sad,
            UserEmotion.Kind.Angry, UserEmotion.Kind.Surprised, UserEmotion.Kind.Neutral,
        )) {
            assertThat(EmotionReaction.minConfidence(kind)).isAtLeast(ferNamesAnEmotionAbove)
            assertThat(EmotionReaction.minConfidence(kind)).isLessThan(aClearRealRead)
        }
    }
}

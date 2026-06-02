package dev.orbit.dock.agent

import com.google.common.truth.Truth.assertThat
import org.junit.Test

/**
 * The live-senses snapshot the agent reads per turn so "what are you looking
 * at?" / "how do I seem?" are grounded in the camera, not guessed.
 */
class PerceptionSnapshotTest {

    @Test
    fun emptyByDefaultDescribesNothing() {
        val s = PerceptionSnapshot()
        assertThat(s.facts.facePresent).isFalse()
        assertThat(s.describe()).isNull()
    }

    @Test
    fun faceSeenCenterDescribesPresence() {
        val s = PerceptionSnapshot()
        s.onFaceSeen(0f, 0f)
        assertThat(s.facts.facePresent).isTrue()
        assertThat(s.describe()).isEqualTo("You can see the user (they are toward your center).")
    }

    @Test
    fun gazeDirectionsMapToWords() {
        fun gaze(x: Float, y: Float): String? {
            val s = PerceptionSnapshot(); s.onFaceSeen(x, y); return s.facts.gaze
        }
        assertThat(gaze(-0.8f, 0f)).isEqualTo("left")
        assertThat(gaze(0.8f, 0f)).isEqualTo("right")
        assertThat(gaze(0f, -0.8f)).isEqualTo("top")
        assertThat(gaze(0f, 0.8f)).isEqualTo("bottom")
        assertThat(gaze(0.1f, 0.1f)).isEqualTo("center")
    }

    @Test
    fun emotionIsLowercasedAndIncludedWhenPresent() {
        val s = PerceptionSnapshot()
        s.onFaceSeen(0f, 0f)
        s.onEmotion("Happy")
        assertThat(s.facts.emotion).isEqualTo("happy")
        assertThat(s.describe()).isEqualTo(
            "You can see the user (they are toward your center); they appear happy.",
        )
    }

    @Test
    fun faceLostClearsPresenceAndGazeButKeepsLastEmotion() {
        val s = PerceptionSnapshot()
        s.onFaceSeen(-0.8f, 0f)
        s.onEmotion("Sad")
        s.onFaceLost()
        assertThat(s.facts.facePresent).isFalse()
        assertThat(s.facts.gaze).isNull()
        assertThat(s.facts.emotion).isEqualTo("sad") // retained (stale but harmless)
        // Nothing in view → no description, even with a remembered emotion.
        assertThat(s.describe()).isNull()
    }

    @Test
    fun reappearingFaceDescribesAgainWithRememberedEmotion() {
        val s = PerceptionSnapshot()
        s.onFaceSeen(0f, 0f); s.onEmotion("Surprised"); s.onFaceLost()
        s.onFaceSeen(0.8f, 0f) // back, now to the right
        assertThat(s.describe())
            .isEqualTo("You can see the user (they are toward your right); they appear surprised.")
    }
}

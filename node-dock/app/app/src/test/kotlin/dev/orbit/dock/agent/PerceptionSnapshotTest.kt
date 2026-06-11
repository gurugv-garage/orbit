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
        assertThat(s.describe()).isEqualTo("You can see someone (toward your center) — recollect_face to find out who.")
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
            "You can see someone (toward your center); they appear happy — recollect_face to find out who.",
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
            .isEqualTo("You can see someone (toward your right); they appear surprised — recollect_face to find out who.")
    }

    @Test
    fun verifiedIdentityNamesThePerson() {
        val s = PerceptionSnapshot()
        s.onFaceSeen(0f, 0f)
        s.onIdentity("guru", verified = true)
        s.onEmotion("Happy")
        assertThat(s.facts.identity).isEqualTo("guru")
        assertThat(s.describe())
            .isEqualTo("You can see guru (toward your center); they appear happy.")
    }

    @Test
    fun tentativeIdentityIsHedged() {
        val s = PerceptionSnapshot()
        s.onFaceSeen(0f, 0f)
        s.onIdentity("guru", verified = false) // station's tentative verdict
        assertThat(s.describe())
            .isEqualTo("You can see someone (toward your center) — possibly guru, but people come and go; recollect_face to check who it is.")
    }

    @Test
    fun identityDemotedWhenFaceLeavesAndAnotherAppears() {
        // MULTI-PERSON: Guru leaves, someone else sits down. The cached name
        // must NOT be presented as verified — the new face may be anyone.
        val s = PerceptionSnapshot()
        s.onFaceSeen(0f, 0f); s.onIdentity("guru", verified = true)
        assertThat(s.describe()).isEqualTo("You can see guru (toward your center).")
        s.onFaceLost()
        s.onFaceSeen(0f, 0f) // a face again — possibly a different person
        // the VERDICT survives (Guru WAS confidently matched — that fact still
        // answers "who just asked"); only the sighting continuity breaks, which
        // is what the prompt hedges on.
        assertThat(s.facts.identityVerified).isTrue()
        assertThat(s.facts.sightingContinuous).isFalse()
        assertThat(s.describe())
            .isEqualTo("You can see someone (toward your center) — possibly guru, but people come and go; recollect_face to check who it is.")
        // a fresh confident recollect re-verifies
        s.onIdentity("shweta", verified = true)
        assertThat(s.describe()).isEqualTo("You can see shweta (toward your center).")
    }

    @Test
    fun crowdIsRememberedAndGroundsThePrompt() {
        val s = PerceptionSnapshot()
        s.onFaceSeen(0f, 0f)
        s.onPeople(listOf(
            PerceptionSnapshot.SeenPerson("guru", null, "left"),
            PerceptionSnapshot.SeenPerson(null, "shweta", "center"),
            PerceptionSnapshot.SeenPerson(null, null, "right"),
        ))
        assertThat(s.describe()).isEqualTo(
            "You can see 3 people: guru on the left, possibly shweta on the center, someone unknown on the right. (recollect_face to re-check.)",
        )
        // stale crowd (older than the freshness window) falls back to single-person grounding
        val later = System.currentTimeMillis() + 10 * 60 * 1000
        assertThat(s.describe(now = later)).doesNotContain("3 people")
    }

    @Test
    fun cachedIdentityKeptWhenFaceLeaves_reportedAsLastSeen() {
        // pull-only cache: a confident identity persists; when the face leaves, we
        // report "no one now, but last was X" instead of forgetting.
        val s = PerceptionSnapshot()
        s.onFaceSeen(0f, 0f); s.onIdentity("guru", verified = true)
        s.onFaceLost()
        assertThat(s.facts.identity).isEqualTo("guru") // remembered
        assertThat(s.describe())
            .isEqualTo("No one is in front of you right now; the last person you saw was guru.")
    }

    @Test
    fun nullIdentityDoesNotWipeTheCache() {
        // a "no one / unrecognized" recollect result must NOT erase a known person.
        val s = PerceptionSnapshot()
        s.onFaceSeen(0f, 0f); s.onIdentity("guru", verified = true)
        s.onIdentity(null) // no-op
        assertThat(s.facts.identity).isEqualTo("guru")
    }

    @Test
    fun clearIdentityWipesTheCache() {
        // forget_face / re-enroll explicitly clears.
        val s = PerceptionSnapshot()
        s.onFaceSeen(0f, 0f); s.onIdentity("guru", verified = true)
        s.clearIdentity()
        assertThat(s.facts.identity).isNull()
    }
}

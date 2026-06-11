package dev.orbit.dock.agent

import com.google.common.truth.Truth.assertThat
import dev.orbit.dock.tts.Speaker
import dev.orbit.dock.ui.face.FaceController
import kotlinx.coroutines.test.runTest
import org.junit.Test

/**
 * The recollect_face response matrix — grounding split by owner:
 * LOCAL camera owns "is someone here"; the station's categorical verdict owns
 * "who". Encodes the live failure where a station timeout / station-side
 * detect miss made the dock say "There's no one in front of me" to a person
 * it could plainly see.
 */
class RecollectFaceTest {

    private class FakeSpeaker : Speaker {
        override fun enqueueSentence(text: String) {}
        override fun stop() {}
    }

    private fun tools(
        perception: PerceptionSnapshot?,
        outcome: RecognizeOutcome?,
    ): DockTools = DockTools(
        face = FaceController(kotlinx.coroutines.Dispatchers.Unconfined),
        tts = FakeSpeaker(),
        onSubtitle = {},
        perception = perception,
        onRecognizeRequest = { outcome },
    )

    private fun snapshotWithFace(): PerceptionSnapshot =
        PerceptionSnapshot().apply { onFaceSeen(0f, 0f) }

    @Test
    fun confidentMatchNamesAndCachesVerified() = runTest {
        val p = snapshotWithFace()
        val r = tools(p, RecognizeOutcome("Guru", null, 0.4f, noFace = false)).recollectFace()
        assertThat(r).isEqualTo("This is Guru.")
        assertThat(p.facts.identity).isEqualTo("Guru")
        assertThat(p.facts.identityVerified).isTrue()
    }

    @Test
    fun tentativeMatchHedgesAndCachesUnverified() = runTest {
        val p = snapshotWithFace()
        val r = tools(p, RecognizeOutcome(null, "Shweta", 0.3f, noFace = false)).recollectFace()
        assertThat(r).contains("might be Shweta")
        assertThat(r).contains("confirm_face")
        assertThat(p.facts.identity).isEqualTo("Shweta")
        assertThat(p.facts.identityVerified).isFalse()
    }

    @Test
    fun unknownFacePromptsForName() = runTest {
        val r = tools(snapshotWithFace(), RecognizeOutcome(null, null, 0f, noFace = false)).recollectFace()
        assertThat(r).contains("don't recognize")
        assertThat(r).contains("remember_face")
    }

    @Test
    fun stationTimeoutWithFacePresent_neverDeniesThePerson() = runTest {
        // THE live bug: timeout (null result) + visible face + empty cache used
        // to fall through to "There's no one in front of me right now".
        val r = tools(snapshotWithFace(), outcome = null).recollectFace()
        assertThat(r).contains("Someone's here")
        assertThat(r).doesNotContain("no one")
    }

    @Test
    fun stationTimeoutWithFaceAndCache_mentionsLastKnown() = runTest {
        val p = snapshotWithFace().apply {
            onIdentity("Guru", verified = true, at = System.currentTimeMillis() - 120_000)
        }
        val r = tools(p, outcome = null).recollectFace()
        assertThat(r).contains("Someone's here")
        assertThat(r).contains("Guru")
    }

    @Test
    fun stationNoFaceButLocalFacePresent_presenceOwnedLocally() = runTest {
        // The station's detector missed the face in its frame, but the dock's
        // own camera sees one — presence must stay true.
        val r = tools(snapshotWithFace(), RecognizeOutcome(null, null, 0f, noFace = true)).recollectFace()
        assertThat(r).contains("I can see someone")
        assertThat(r).doesNotContain("no one")
    }

    @Test
    fun noFaceAnywhereWithCache_reportsLastPerson() = runTest {
        val p = PerceptionSnapshot().apply {
            onFaceSeen(0f, 0f)
            onIdentity("Guru", verified = true, at = System.currentTimeMillis() - 120_000)
            onFaceLost()
        }
        val r = tools(p, RecognizeOutcome(null, null, 0f, noFace = true)).recollectFace()
        assertThat(r).contains("last person I was talking to was Guru")
    }

    @Test
    fun nothingAtAll_saysSo() = runTest {
        val p = PerceptionSnapshot() // no face ever, no cache
        val r = tools(p, RecognizeOutcome(null, null, 0f, noFace = true)).recollectFace()
        assertThat(r).contains("no one in front of me")
    }

    // ── ask-time identity (the "who am I, then I walk away" flow) ─────────

    @Test
    fun askThenMoveAway_answersFromPreTurnIdentity_noRoundTrip() = runTest {
        // The pre-turn grounding recognized the speaker as STT armed; they
        // finish talking and step away before the tool runs. The answer is the
        // ASKER — and no second photo/round trip should even happen.
        var roundTrips = 0
        val p = PerceptionSnapshot().apply {
            onFaceSeen(0f, 0f)
            onIdentity("Guru", verified = true)   // just now (pre-turn result)
            onFaceLost()                          // walked away
        }
        val t = DockTools(
            face = FaceController(kotlinx.coroutines.Dispatchers.Unconfined),
            tts = FakeSpeaker(), onSubtitle = {}, perception = p,
            onRecognizeRequest = { roundTrips++; null },
        )
        val r = t.recollectFace()
        assertThat(r).contains("The person you are talking to is Guru")
        assertThat(r).contains("Answer them as Guru")
        assertThat(roundTrips).isEqualTo(0)
    }

    @Test
    fun freshIdentityFaceStillPresent_answersInstantly() = runTest {
        var roundTrips = 0
        val p = snapshotWithFace().apply { onIdentity("Guru", verified = true) }
        val t = DockTools(
            face = FaceController(kotlinx.coroutines.Dispatchers.Unconfined),
            tts = FakeSpeaker(), onSubtitle = {}, perception = p,
            onRecognizeRequest = { roundTrips++; null },
        )
        assertThat(t.recollectFace()).isEqualTo("This is Guru.")
        assertThat(roundTrips).isEqualTo(0)
    }

    @Test
    fun tentativeCacheDoesNotShortCircuit_theRoundTripStillRuns() = runTest {
        var roundTrips = 0
        val p = snapshotWithFace().apply { onIdentity("Guru", verified = false) }
        val t = DockTools(
            face = FaceController(kotlinx.coroutines.Dispatchers.Unconfined),
            tts = FakeSpeaker(), onSubtitle = {}, perception = p,
            onRecognizeRequest = { roundTrips++; RecognizeOutcome("Guru", null, 0.5f, noFace = false) },
        )
        assertThat(t.recollectFace()).isEqualTo("This is Guru.")
        assertThat(roundTrips).isEqualTo(1)
    }

    @Test
    fun recentSightingAfterStationNoFace_saysJustSteppedAway() = runTest {
        // Verified 45s ago (past the 30s fast path, inside the 60s recent
        // window), face gone, station finds nothing → still names them.
        val p = PerceptionSnapshot().apply {
            onFaceSeen(0f, 0f)
            onIdentity("Guru", verified = true, at = System.currentTimeMillis() - 45_000)
            onFaceLost()
        }
        val r = tools(p, RecognizeOutcome(null, null, 0f, noFace = true)).recollectFace()
        assertThat(r).contains("The person you are talking to is Guru")
        assertThat(r).contains("Answer them as Guru")
    }

    @Test
    fun strangerInFrameVoidsTheCachedAsker() = runTest {
        // Guru asked and left; a stranger sits down and asks "who am I".
        // The round trip sees an unmatched face → the cached "Guru" must not
        // answer, now or via the recent-sighting path.
        val p = PerceptionSnapshot().apply {
            onFaceSeen(0f, 0f)
            onIdentity("Guru", verified = true)
            onFaceLost()
            onFaceSeen(0f, 0f) // the stranger
            onUnrecognized()   // … recognized by a recognize-result as nobody
        }
        val r = tools(p, RecognizeOutcome(null, null, 0f, noFace = false)).recollectFace()
        assertThat(r).contains("don't recognize")
        assertThat(r).doesNotContain("Guru")
        // and recency is void for later fallbacks too
        assertThat(p.facts.identityAt).isEqualTo(0L)
    }

    @Test
    fun crowdListsEveryoneAndIsRemembered() = runTest {
        val p = snapshotWithFace()
        val people = listOf(
            RecognizedFace("Guru", null, 0.5f, "left"),
            RecognizedFace(null, "Shweta", 0.3f, "center"),
            RecognizedFace(null, null, 0f, "right"),
        )
        val r = tools(p, RecognizeOutcome("Guru", null, 0.5f, noFace = false, people = people)).recollectFace()
        assertThat(r).contains("3 people")
        assertThat(r).contains("Guru on the left")
        // the sighting is cached for the next turns' prompt grounding
        assertThat(p.facts.people).hasSize(3)
        assertThat(p.describe()).contains("3 people")
    }
}

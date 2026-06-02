package dev.orbit.dock.agent

import com.google.common.truth.Truth.assertThat
import dev.orbit.dock.tts.Speaker
import dev.orbit.dock.ui.face.FaceController
import dev.orbit.dock.ui.face.FaceState
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.setMain
import org.junit.After
import org.junit.Before
import org.junit.Test

/**
 * Realistic-use tests for [DockTools] — the side-effect surface the agent
 * drives. Body is left null (the common "no XIAO connected" case); a fake
 * [Speaker] records what would be spoken so we can assert the reply still
 * comes through even when faces are invalid or the body is offline.
 *
 * The connected-body cases (sequence preemption, barge-in cancelling a live
 * wiggle) need a real BodyLinkComms + servos and are verified on-device.
 */
@OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
class DockToolsRealisticTest {

    private class FakeSpeaker : Speaker {
        val spoken = mutableListOf<String>()
        var stops = 0
        override fun enqueueSentence(text: String) { spoken.add(text) }
        override fun stop() { stops++ }
    }

    private lateinit var face: FaceController
    private lateinit var tts: FakeSpeaker
    private lateinit var tools: DockTools

    @Before
    fun setUp() {
        Dispatchers.setMain(UnconfinedTestDispatcher())
        face = FaceController()
        tts = FakeSpeaker()
        // body = null → simulates the very common "no body connected" state.
        tools = DockTools(face = face, tts = tts, onSubtitle = {}, body = null)
    }

    @After
    fun tearDown() = Dispatchers.resetMain()

    // ── end-of-turn settle (action-only / silent turns) ──────────────────

    @Test
    fun endTurnSettlesFaceAndClearsSubtitleWhenNothingSpoken() {
        // An action-only turn (tool calls, no speech): no TTS callback will ever
        // silence the face, so endTurn must settle it + clear the stale subtitle
        // (otherwise the UI freezes on the user's transcript).
        val subtitles = mutableListOf<String>()
        val t = DockTools(face = face, tts = tts, onSubtitle = { subtitles.add(it) }, body = null)
        t.beginTurn()
        t.setFace("happy")                 // acted, didn't speak
        face.listen()                      // simulate the face left mid-listen
        t.endTurn()
        assertThat(face.state.value).isEqualTo(FaceState.Idle)   // settled, not stuck
        assertThat(subtitles.last()).isEmpty()                   // subtitle cleared
    }

    @Test
    fun endTurnLeavesFaceToTtsWhenSpoken() {
        // When the turn DID speak, endTurn must NOT silence — TTS owns wind-down
        // (silencing here would cut the face out of Speaking mid-audio).
        tools.beginTurn()
        tools.speakSentence("Hi there!")
        val before = face.state.value
        tools.endTurn()
        assertThat(face.state.value).isEqualTo(before)           // unchanged by endTurn
        assertThat(tools.spokeAnythingThisTurn()).isTrue()
    }

    // ── the reply must always be spoken ──────────────────────────────────

    @Test
    fun replyIsSpoken() {
        tools.speak("Hi there!")
        assertThat(tts.spoken).containsExactly("Hi there!")
        assertThat(tools.spokeAnythingThisTurn()).isTrue()
    }

    @Test
    fun speakSentenceQueuesEachSentenceAndTracksFullReply() {
        tools.speakSentence("Hi there!")
        tools.speakSentence("How are you?")
        // Each sentence is queued to TTS separately (sentence-level streaming).
        assertThat(tts.spoken).containsExactly("Hi there!", "How are you?").inOrder()
        assertThat(tools.spokeAnythingThisTurn()).isTrue()
        // The accumulated reply is tracked for history/logging.
        assertThat(tools.lastSpokenReplyOrNull()).isEqualTo("Hi there! How are you?")
    }

    @Test
    fun speakSentenceSkipsBlank() {
        tools.speakSentence("   ")
        assertThat(tts.spoken).isEmpty()
    }

    @Test
    fun onLiveTextDrivesSubtitleNotSpeech() {
        val subtitles = mutableListOf<String>()
        val streamingTools = DockTools(face = face, tts = tts, onSubtitle = { subtitles.add(it) }, body = null)
        streamingTools.onLiveText("Hi the")
        streamingTools.onLiveText("Hi there!")
        // Subtitle reflects the live decoded text; nothing is spoken or marked.
        assertThat(subtitles).containsExactly("Hi the", "Hi there!").inOrder()
        assertThat(tts.spoken).isEmpty()
        assertThat(streamingTools.spokeAnythingThisTurn()).isFalse()
    }

    @Test
    fun bodyOfflineStillSpeaks() {
        // Model asks for a move but there's no body — the move is a no-op, and
        // crucially the spoken reply is unaffected.
        tools.setFace("happy")
        tools.speak("Turning left!")
        val r = tools.makeBodyMovements("foot:left")
        assertThat(tts.spoken).containsExactly("Turning left!")
        assertThat(r).contains("no body connected")
    }

    @Test
    fun invalidFaceDoesNotCrashAndReplyStillSpeaks() {
        // glm has emitted face:"smile" (not in our set). Must degrade, not throw.
        val r = tools.setFace("smile")
        assertThat(r).contains("unknown expression")
        tools.speak("Here you go.")
        assertThat(tts.spoken).containsExactly("Here you go.")
    }

    @Test
    fun blankReplyIsNotSpoken() {
        tools.speak("   ")
        assertThat(tts.spoken).isEmpty()
        assertThat(tools.spokeAnythingThisTurn()).isFalse()
    }

    // ── interruption / cleanup ───────────────────────────────────────────

    @Test
    fun silenceStopsTtsAndIsSafeWithNoBody() {
        tools.speak("talking...")
        tools.silence()
        assertThat(tts.stops).isAtLeast(1)
        assertThat(face.state.value).isEqualTo(FaceState.Idle)
    }

    @Test
    fun stopBodyIsSafeWhenNothingRunning() {
        // Barge-in / new-utterance path calls this even when no gesture is live.
        tools.stopBody()
        tools.stopBody()
        // no exception = pass
    }

    @Test
    fun beginTurnResetsSpokenFlag() {
        tools.speak("first")
        assertThat(tools.spokeAnythingThisTurn()).isTrue()
        tools.beginTurn()
        assertThat(tools.spokeAnythingThisTurn()).isFalse()
        assertThat(tools.lastSpokenReplyOrNull()).isNull()
    }

    // ── body tools with no body never throw ──────────────────────────────

    @Test
    fun makeBodyMovementsWithNoBodyReports() {
        val r = tools.makeBodyMovements("foot:left; foot:right")
        assertThat(r).contains("no body connected")
    }

    // ── situational context for the LLM ──────────────────────────────────

    @Test
    fun contextReportsBodyNotConnectedWhenNull() {
        val ctx = tools.currentContext()
        assertThat(ctx).contains("NOT connected")
        assertThat(ctx).doesNotContain("CONNECTED.")
    }

    @Test
    fun contextReportsCurrentFace() {
        face.setExpression(dev.orbit.dock.ui.face.FaceExpression.Happy)
        assertThat(tools.currentContext()).contains("Current face: happy")

        face.setExpression(dev.orbit.dock.ui.face.FaceExpression.Concerned)
        assertThat(tools.currentContext()).contains("Current face: concerned")
    }

    @Test
    fun contextDefaultFaceIsNeutral() {
        assertThat(tools.currentContext()).contains("Current face: neutral")
    }

    // ── live senses fed into the prompt (grounding) ───────────────────────

    @Test
    fun contextIncludesWhatTheCameraSees() {
        val perception = PerceptionSnapshot().apply {
            onFaceSeen(0f, 0f)
            onEmotion("Happy")
        }
        val t = DockTools(face = face, tts = tts, onSubtitle = {}, body = null, perception = perception)
        val ctx = t.currentContext()
        assertThat(ctx).contains("Current face: neutral")
        assertThat(ctx).contains("You can see the user")
        assertThat(ctx).contains("they appear happy")
    }

    @Test
    fun contextOmitsVisionWhenNoFaceInView() {
        val perception = PerceptionSnapshot() // nothing seen
        val t = DockTools(face = face, tts = tts, onSubtitle = {}, body = null, perception = perception)
        assertThat(t.currentContext()).doesNotContain("You can see the user")
    }
}

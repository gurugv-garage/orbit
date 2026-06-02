package dev.orbit.dock.agent

import com.google.common.truth.Truth.assertThat
import dev.orbit.dock.tts.Speaker
import dev.orbit.dock.ui.face.FaceController
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.setMain
import org.junit.After
import org.junit.Before
import org.junit.Test

/**
 * Turn-lifecycle tests for [DockAgent] against an UNREACHABLE Ollama, so we
 * exercise the realistic "local model is down / laptop asleep" path without a
 * server: the dock must say something, return to a clean state, and never hang.
 *
 * (The happy path — real model, structured reply, talk-while-moving — is
 * covered by the live harness OllamaLiveLifecycleTest + on-device runs.)
 */
@OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
class DockAgentTurnTest {

    private class FakeSpeaker : Speaker {
        val spoken = mutableListOf<String>()
        override fun enqueueSentence(text: String) { synchronized(spoken) { spoken.add(text) } }
        override fun stop() {}
    }

    private lateinit var face: FaceController
    private lateinit var tts: FakeSpeaker
    private lateinit var tools: DockTools
    private lateinit var agent: DockAgent

    @Before
    fun setUp() {
        Dispatchers.setMain(UnconfinedTestDispatcher())
        face = FaceController()
        tts = FakeSpeaker()
        tools = DockTools(face = face, tts = tts, onSubtitle = {}, body = null)
        // Point at a closed port on localhost → connection refused fast.
        agent = DockAgent(
            tools = tools,
            baseUrl = "http://127.0.0.1:1",
            model = "does-not-matter",
            systemPrompt = "test",
        )
    }

    @After
    fun tearDown() {
        agent.shutdown()
        Dispatchers.resetMain()
    }

    private fun waitUntil(timeoutMs: Long = 8_000, cond: () -> Boolean) {
        val end = System.currentTimeMillis() + timeoutMs
        while (System.currentTimeMillis() < end) {
            if (cond()) return
            Thread.sleep(25)
        }
        throw AssertionError("condition not met within ${timeoutMs}ms")
    }

    @Test
    fun unreachableModelSpeaksFallbackAndDoesNotHang() {
        agent.respond("say hi")
        // It should fail fast (connection refused) and speak a fallback line.
        waitUntil { tts.spoken.isNotEmpty() }
        assertThat(tts.spoken.first()).ignoringCase().contains("couldn't reach")
        waitUntil { agent.state.value is AgentState.Failed }
        assertThat(agent.state.value).isInstanceOf(AgentState.Failed::class.java)
    }

    @Test
    fun notConfiguredSpeaksConfigHint() {
        val a = DockAgent(tools = tools, baseUrl = "", model = "", systemPrompt = "test")
        a.respond("hi")
        // synchronous path — no server call
        assertThat(tts.spoken.last()).ignoringCase().contains("not configured")
        a.shutdown()
    }

    @Test
    fun stopReturnsToIdleAndIsSafeMidTurn() {
        agent.respond("say hi")
        agent.stop()
        assertThat(agent.state.value).isEqualTo(AgentState.Idle)
    }

    @Test
    fun newUtteranceSupersedesPrevious() {
        // Fire two in quick succession; the second cancels the first. We only
        // assert no crash + a fallback eventually speaks (model is down).
        agent.respond("first thing")
        agent.respond("second thing")
        waitUntil { tts.spoken.isNotEmpty() }
        // and it settles, not stuck Thinking forever
        waitUntil { agent.state.value !is AgentState.Thinking }
    }
}

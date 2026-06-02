package dev.orbit.dock.agent

import com.google.common.truth.Truth.assertThat
import dev.orbit.dock.tts.Speaker
import dev.orbit.dock.ui.face.FaceController
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.setMain
import org.junit.After
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import androidx.test.ext.junit.runners.AndroidJUnit4
import java.net.ServerSocket
import java.net.SocketException
import java.util.concurrent.CopyOnWriteArrayList
import kotlin.concurrent.thread

/**
 * On-device validation of [DockAgent]'s real streaming turn — the one seam the
 * JVM unit tests can't cover: the actual Ktor socket read of Ollama's NDJSON
 * stream.
 *
 * Instead of needing a live LAN model, we stand up a tiny in-process HTTP server
 * that replays scripted `/api/chat` NDJSON (the exact wire shape Ollama emits
 * for `stream:true`), point a real [DockAgent] at it, and assert that:
 *   - the agent walks Waiting → Thinking → Speaking off the stream's signals,
 *   - reply sentences are spoken incrementally as they stream in,
 *   - the live subtitle text grows as the reply decodes,
 *   - face + body apply from the fully-parsed object.
 *
 * This runs on the emulator (`connectedDebugAndroidTest`) so the Android Ktor
 * engine, threading, and TTS-state plumbing are all real.
 */
@OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
@RunWith(AndroidJUnit4::class)
class DockAgentStreamingTest {

    private class FakeSpeaker : Speaker {
        val spoken = CopyOnWriteArrayList<String>()
        override fun enqueueSentence(text: String) { spoken.add(text) }
        override fun stop() {}
    }

    private lateinit var server: ServerSocket
    @Volatile private var serverThread: Thread? = null
    private lateinit var face: FaceController
    private lateinit var tts: FakeSpeaker
    private lateinit var tools: DockTools
    private val subtitles = CopyOnWriteArrayList<String>()
    private val states = CopyOnWriteArrayList<AgentState>()

    /** NDJSON lines the fake server will stream, one chat-chunk per line. */
    @Volatile private var scriptedLines: List<String> = emptyList()

    @Before
    fun setUp() {
        Dispatchers.setMain(UnconfinedTestDispatcher())
        face = FaceController()
        tts = FakeSpeaker()
        tools = DockTools(
            face = face,
            tts = tts,
            onSubtitle = { subtitles.add(it) },
            body = null,
        )

        // Minimal HTTP/1.1 server on a raw socket (com.sun.net.httpserver isn't
        // on Android). Reads+discards the request, then streams the scripted
        // NDJSON body with `Connection: close` so the client sees end-of-stream.
        server = ServerSocket(0, 0, java.net.InetAddress.getByName("127.0.0.1"))
        serverThread = thread(isDaemon = true) {
            while (!server.isClosed) {
                val socket = try { server.accept() } catch (_: SocketException) { break }
                thread(isDaemon = true) {
                    socket.use { s ->
                        // Drain request headers (until blank line) so the write end is clean.
                        val reader = s.getInputStream().bufferedReader()
                        while (true) {
                            val l = reader.readLine() ?: break
                            if (l.isEmpty()) break
                        }
                        val out = s.getOutputStream()
                        out.write("HTTP/1.1 200 OK\r\n".toByteArray())
                        out.write("Content-Type: application/x-ndjson\r\n".toByteArray())
                        out.write("Connection: close\r\n\r\n".toByteArray())
                        out.flush()
                        for (line in scriptedLines) {
                            out.write((line + "\n").toByteArray())
                            out.flush()
                            Thread.sleep(10) // emulate token-by-token arrival
                        }
                    }
                }
            }
        }
    }

    @After
    fun tearDown() {
        server.close()
        Dispatchers.resetMain()
    }

    private fun newAgent(): DockAgent = DockAgent(
        tools = tools,
        baseUrl = "http://127.0.0.1:${server.localPort}",
        model = "test-model",
        systemPrompt = "test",
    )

    private fun waitUntil(timeoutMs: Long = 10_000, cond: () -> Boolean) {
        val end = System.currentTimeMillis() + timeoutMs
        while (System.currentTimeMillis() < end) {
            if (cond()) return
            Thread.sleep(20)
        }
        throw AssertionError("condition not met within ${timeoutMs}ms")
    }

    /** Build an Ollama `/api/chat` content chunk line. */
    private fun contentChunk(piece: String) =
        """{"message":{"role":"assistant","content":${quote(piece)}}}"""

    private fun thinkingChunk(piece: String) =
        """{"message":{"role":"assistant","thinking":${quote(piece)}}}"""

    private fun doneChunk() = """{"message":{"role":"assistant","content":""},"done":true}"""

    private fun quote(s: String) = "\"" + s.replace("\\", "\\\\").replace("\"", "\\\"") + "\""

    @Test
    fun streamsThinkingThenSpeaksSentencesIncrementally() {
        // The model "thinks" first, then emits the JSON object in fragments.
        scriptedLines = listOf(
            thinkingChunk("Let me consider that"),
            contentChunk("""{"reply":"Hi there. """),
            contentChunk("""How are you?","face":"happy","""),
            contentChunk(""""body":[]}"""),
            doneChunk(),
        )

        val agent = newAgent()
        val collectorJob = collectStates(agent)

        agent.respond("say hi")

        // Both sentences spoken, in order, as they streamed in.
        waitUntil { tts.spoken.size >= 2 }
        assertThat(tts.spoken).containsExactly("Hi there.", "How are you?").inOrder()

        // The status walked through Waiting and Thinking before Speaking.
        waitUntil { states.any { it is AgentState.Speaking } }
        assertThat(states.any { it is AgentState.Waiting }).isTrue()
        assertThat(states.any { it is AgentState.Thinking }).isTrue()
        assertThat(states.any { it is AgentState.Speaking }).isTrue()
        // Waiting came before Speaking.
        val firstWaiting = states.indexOfFirst { it is AgentState.Waiting }
        val firstSpeaking = states.indexOfFirst { it is AgentState.Speaking }
        assertThat(firstWaiting).isLessThan(firstSpeaking)

        // Live subtitle grew with the decoded reply text.
        waitUntil { subtitles.any { it.contains("How are you?") } }
        assertThat(subtitles.last()).contains("Hi there.")

        // Face applied from the parsed object.
        waitUntil { face.expression.value.name.equals("happy", ignoreCase = true) }

        collectorJob.cancel()
        agent.shutdown()
    }

    @Test
    fun speaksImmediatelyWhenNoThinkingPreamble() {
        scriptedLines = listOf(
            contentChunk("""{"reply":"Quick answer. """),
            contentChunk(""""face":"neutral","body":[]}"""),
            doneChunk(),
        )
        val agent = newAgent()
        agent.respond("go")
        waitUntil { tts.spoken.isNotEmpty() }
        assertThat(tts.spoken.first()).isEqualTo("Quick answer.")
        agent.shutdown()
    }

    private fun collectStates(agent: DockAgent) =
        CoroutineScope(Dispatchers.Default).launch {
            agent.state.collect { states.add(it) }
        }
}

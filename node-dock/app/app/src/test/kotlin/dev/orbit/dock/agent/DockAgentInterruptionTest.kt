package dev.orbit.dock.agent

import com.google.common.truth.Truth.assertThat
import dev.orbit.dock.tts.Speaker
import dev.orbit.dock.ui.face.FaceController
import dev.pi.ai.AssistantMessage
import dev.pi.ai.AssistantMessageEvent
import dev.pi.ai.AssistantMessageEventStream
import dev.pi.ai.Context
import dev.pi.ai.StopReason
import dev.pi.ai.StreamFn
import dev.pi.ai.TextContent
import dev.pi.ai.ToolCall
import dev.pi.ai.ToolResultMessage
import dev.pi.ai.Usage
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.setMain
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.After
import org.junit.Before
import org.junit.Test
import java.util.concurrent.CopyOnWriteArrayList

/**
 * Interruption semantics for [DockAgent], against a scripted stream (the
 * `streamFnOverride` seam) — no model, no network.
 *
 * Regression coverage for the live-observed failure family:
 *  - cancelling a turn (barge-in / superseding utterance) used to synthesize a
 *    spoken "couldn't reach my model" error,
 *  - stop() used to wipe the entire conversation history,
 *  - a cancellation mid-tool left dangling tool calls that broke the NEXT turn
 *    on OpenAI-style endpoints,
 *  - a hung model timed out silently (TimeoutCancellationException was
 *    rethrown as a plain cancellation).
 */
@OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
class DockAgentInterruptionTest {

    private class FakeSpeaker : Speaker {
        val spoken = CopyOnWriteArrayList<String>()
        override fun enqueueSentence(text: String) { spoken.add(text) }
        override fun stop() {}
    }

    private val scope = CoroutineScope(Dispatchers.IO)
    private val face = FaceController()
    private val tts = FakeSpeaker()
    /** Every Context the scripted model was called with (per LLM step). */
    private val seenContexts = CopyOnWriteArrayList<Context>()
    private var agent: DockAgent? = null

    @Before
    fun setUp() {
        Dispatchers.setMain(UnconfinedTestDispatcher())
    }

    @After
    fun tearDown() {
        agent?.shutdown()
        Dispatchers.resetMain()
    }

    private fun assistantText(text: String) = AssistantMessage(
        content = listOf(TextContent(text)),
        api = "faux", provider = "faux", model = "mock",
        usage = Usage.EMPTY, stopReason = StopReason.STOP,
    )

    /** Streams [text] as one delta then completes — the shape DockAgent's
     *  sentence extractor actually consumes (MessageUpdate carries the text). */
    private fun pushTextReply(stream: AssistantMessageEventStream, text: String) {
        val msg = assistantText(text)
        scope.launch {
            stream.push(AssistantMessageEvent.Start(msg))
            stream.push(AssistantMessageEvent.TextDelta(0, text, msg))
            stream.push(AssistantMessageEvent.Done(StopReason.STOP, msg))
        }
    }

    /** Replies "ok." instantly to every step — and records the context. */
    private fun echoStream(): StreamFn = { _, context, _ ->
        seenContexts.add(context)
        AssistantMessageEventStream().also { pushTextReply(it, "ok.") }
    }

    /** First call answers; later calls hang forever (a stuck model). */
    private fun answerThenHangStream(): StreamFn = { _, context, _ ->
        seenContexts.add(context)
        val stream = AssistantMessageEventStream()
        if (seenContexts.size == 1) pushTextReply(stream, "first reply.")
        // else: never pushes → the turn hangs until cancelled / timed out
        stream
    }

    /** Calls recollect_face once, then (if asked again) answers with text. */
    private fun callsRecollectStream(): StreamFn = { _, context, _ ->
        seenContexts.add(context)
        val stream = AssistantMessageEventStream()
        val alreadyCalled = context.messages.any { it is ToolResultMessage }
        val msg = if (alreadyCalled) assistantText("done.")
        else AssistantMessage(
            content = listOf(ToolCall("tc-1", "recollect_face", buildJsonObject { put("_", 0) })),
            api = "faux", provider = "faux", model = "mock",
            usage = Usage.EMPTY, stopReason = StopReason.TOOL_USE,
        )
        scope.launch {
            stream.push(AssistantMessageEvent.Start(msg))
            stream.push(AssistantMessageEvent.Done(msg.stopReason, msg))
        }
        stream
    }

    private fun makeAgent(
        streamFn: StreamFn,
        tools: DockTools = DockTools(face = face, tts = tts, onSubtitle = {}, body = null),
        timeoutMs: Long = 60_000,
    ): DockAgent = DockAgent(
        tools = tools,
        baseUrl = "http://test", model = "mock", systemPrompt = "test",
        streamFnOverride = streamFn,
        turnTimeoutMs = timeoutMs,
    ).also { agent = it }

    private fun waitUntil(timeoutMs: Long = 8_000, cond: () -> Boolean) {
        val end = System.currentTimeMillis() + timeoutMs
        while (System.currentTimeMillis() < end) {
            if (cond()) return
            Thread.sleep(20)
        }
        throw AssertionError("condition not met within ${timeoutMs}ms")
    }

    @Test
    fun stopMidTurnIsSilentAndKeepsHistory() {
        val a = makeAgent(answerThenHangStream())
        a.respond("hello")
        waitUntil { tts.spoken.contains("first reply.") }
        waitUntil { a.state.value is AgentState.Idle || a.state.value is AgentState.Speaking }

        a.respond("second")                       // this one hangs
        waitUntil { seenContexts.size == 2 }
        val spokenBeforeStop = tts.spoken.size
        a.stop()
        Thread.sleep(300)                          // let any (wrong) error speech surface

        // Interruption must be SILENT — no "couldn't reach my model".
        assertThat(tts.spoken.size).isEqualTo(spokenBeforeStop)
        assertThat(a.state.value).isEqualTo(AgentState.Idle)

        // And the conversation history must survive the stop: the next turn's
        // context still contains the first exchange.
        a.respond("third")
        waitUntil { seenContexts.size == 3 }
        val texts = seenContexts[2].messages
            .flatMap { (it as? AssistantMessage)?.content ?: emptyList() }
            .filterIsInstance<TextContent>().map { it.text }
        assertThat(texts).contains("first reply.")
        // No synthetic failure message polluted the transcript.
        assertThat(
            seenContexts[2].messages.filterIsInstance<AssistantMessage>()
                .none { it.errorMessage != null },
        ).isTrue()
    }

    @Test
    fun timeoutSpeaksAndFails() {
        val a = makeAgent(answerThenHangStream(), timeoutMs = 400)
        a.respond("hello")
        waitUntil { tts.spoken.contains("first reply.") }
        a.respond("hang now")
        waitUntil { a.state.value is AgentState.Failed }
        waitUntil { tts.spoken.any { it.contains("too long", ignoreCase = true) } }
    }

    @Test
    fun cancellationDuringToolIsPatchedForTheNextTurn() {
        // recollect_face blocks forever (station never answers) → stop() cancels
        // mid-tool → the transcript has an assistant tool call with no result.
        val tools = DockTools(
            face = face, tts = tts, onSubtitle = {}, body = null,
            onRecognizeRequest = { awaitCancellation() },
        )
        val a = makeAgent(callsRecollectStream(), tools = tools)
        a.respond("who am I")
        waitUntil { seenContexts.size == 1 }
        Thread.sleep(200)                          // let the tool start + hang
        a.stop()

        a.respond("hello again")
        waitUntil { seenContexts.size == 2 }
        val ctx = seenContexts[1]
        val callIds = ctx.messages.filterIsInstance<AssistantMessage>()
            .flatMap { it.content }.filterIsInstance<ToolCall>().map { it.id }
        val resultIds = ctx.messages.filterIsInstance<ToolResultMessage>().map { it.toolCallId }
        // every tool call in the history has a result (the dangling one patched)
        assertThat(resultIds).containsAtLeastElementsIn(callIds)
    }

    @Test
    fun historyIsCappedAtTurnBoundary() {
        val a = makeAgent(echoStream())
        repeat(40) { i ->
            a.respond("msg $i")
            waitUntil { seenContexts.size == i + 1 }
        }
        // 40 turns × 2 messages = 80 raw; the cap keeps the prompt bounded.
        val last = seenContexts.last().messages
        assertThat(last.size).isAtMost(50)
        // and it still starts at a user message (no split turn)
        assertThat(last.first().role).isEqualTo("user")
    }
}

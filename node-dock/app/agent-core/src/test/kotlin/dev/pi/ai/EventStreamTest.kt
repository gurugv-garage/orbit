package dev.pi.ai

import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals

/** Port of pi-ai test/stream.test.ts / event-stream behavior. */
class EventStreamTest {

    private fun msg(text: String) = AssistantMessage(
        content = listOf(TextContent(text)),
        api = "faux", provider = "faux", model = "m",
        usage = Usage.EMPTY, stopReason = StopReason.STOP,
    )

    @Test
    fun `result resolves from the done event`() = runTest {
        val stream = AssistantMessageEventStream()
        val final = msg("hello")
        launch {
            stream.push(AssistantMessageEvent.Start(final))
            stream.push(AssistantMessageEvent.Done(StopReason.STOP, final))
        }
        assertEquals(final, stream.result())
    }

    @Test
    fun `result resolves from the error event`() = runTest {
        val stream = AssistantMessageEventStream()
        val errMsg = msg("boom").copy(stopReason = StopReason.ERROR, errorMessage = "boom")
        launch {
            stream.push(AssistantMessageEvent.Start(errMsg))
            stream.push(AssistantMessageEvent.Error(StopReason.ERROR, errMsg))
        }
        assertEquals(errMsg, stream.result())
    }

    @Test
    fun `iteration yields all events in order then closes`() = runTest {
        val stream = AssistantMessageEventStream()
        val final = msg("hi")
        launch {
            stream.push(AssistantMessageEvent.Start(final))
            stream.push(AssistantMessageEvent.TextDelta(0, "hi", final))
            stream.push(AssistantMessageEvent.Done(StopReason.STOP, final))
        }
        val events = stream.collect().toList()
        assertEquals(3, events.size)
        assertEquals(AssistantMessageEvent.Start(final), events[0])
        assertEquals(AssistantMessageEvent.Done(StopReason.STOP, final), events[2])
    }

    @Test
    fun `push after done is ignored`() = runTest {
        val stream = AssistantMessageEventStream()
        val final = msg("x")
        launch {
            stream.push(AssistantMessageEvent.Done(StopReason.STOP, final))
            stream.push(AssistantMessageEvent.TextDelta(0, "late", final))
        }
        val events = stream.collect().toList()
        assertEquals(1, events.size)
    }
}

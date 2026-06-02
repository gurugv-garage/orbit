package dev.orbit.dock.perception

import app.cash.turbine.test
import com.google.common.truth.Truth.assertThat
import kotlinx.coroutines.test.runTest
import org.junit.Test

class PerceptionBusTest {

    @Test
    fun emitsEventsToSubscriber() = runTest {
        PerceptionBus.events.test {
            PerceptionBus.emit(PerceptionEvent.WakeWord("hey jarvis"))
            val event = awaitItem()
            assertThat(event).isInstanceOf(PerceptionEvent.WakeWord::class.java)
            assertThat((event as PerceptionEvent.WakeWord).label).isEqualTo("hey jarvis")
            cancelAndIgnoreRemainingEvents()
        }
    }

    @Test
    fun transcriptFlowsFinalAndPartial() = runTest {
        PerceptionBus.events.test {
            PerceptionBus.emit(PerceptionEvent.Transcript("hel", isFinal = false))
            PerceptionBus.emit(PerceptionEvent.Transcript("hello", isFinal = true))

            val a = awaitItem() as PerceptionEvent.Transcript
            val b = awaitItem() as PerceptionEvent.Transcript
            assertThat(a.text).isEqualTo("hel")
            assertThat(a.isFinal).isFalse()
            assertThat(b.text).isEqualTo("hello")
            assertThat(b.isFinal).isTrue()
            cancelAndIgnoreRemainingEvents()
        }
    }

    @Test
    fun audioLevelEventsCarryFloat() = runTest {
        PerceptionBus.events.test {
            PerceptionBus.emit(PerceptionEvent.AudioLevel(0.42f))
            val event = awaitItem() as PerceptionEvent.AudioLevel
            assertThat(event.level).isWithin(0.0001f).of(0.42f)
            cancelAndIgnoreRemainingEvents()
        }
    }
}

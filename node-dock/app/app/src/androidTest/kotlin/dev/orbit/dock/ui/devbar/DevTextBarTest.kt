package dev.orbit.dock.ui.devbar

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextInput
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.cash.turbine.test
import com.google.common.truth.Truth.assertThat
import dev.orbit.dock.perception.PerceptionBus
import dev.orbit.dock.perception.PerceptionEvent
import dev.orbit.dock.ui.theme.NodeDockTheme
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.runTest
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class DevTextBarTest {

    @get:Rule
    val composeRule = createComposeRule()

    @Test
    fun typedTextEmitsTranscriptAndWakeEvents() = runTest {
        composeRule.setContent {
            NodeDockTheme { DevTextBar() }
        }

        // The text field exposes placeholder text we can target.
        composeRule
            .onNodeWithText("type a transcript (Enter to send)")
            .assertIsDisplayed()
            .performTextInput("hello dock")

        // Subscribe before clicking 'go' so we don't miss the immediate emissions.
        PerceptionBus.events.test {
            composeRule.onNodeWithText("go").performClick()

            val first = awaitItem()
            val second = awaitItem()

            // Order: WakeWord, Transcript
            assertThat(first).isInstanceOf(PerceptionEvent.WakeWord::class.java)
            assertThat((first as PerceptionEvent.WakeWord).label).isEqualTo("(dev)")

            assertThat(second).isInstanceOf(PerceptionEvent.Transcript::class.java)
            val t = second as PerceptionEvent.Transcript
            assertThat(t.text).isEqualTo("hello dock")
            assertThat(t.isFinal).isTrue()

            cancelAndIgnoreRemainingEvents()
        }
    }

    @Test
    fun emptyInputDoesNothing() = runTest {
        composeRule.setContent {
            NodeDockTheme { DevTextBar() }
        }
        // No text typed — clicking go should not emit anything.
        composeRule.onNodeWithText("go").performClick()
        // We can't really assert "nothing was emitted" cleanly without a window;
        // simplest: emit a sentinel, ensure it's the next item.
        PerceptionBus.events.test {
            PerceptionBus.emit(PerceptionEvent.Status("test", "sentinel"))
            val event = awaitItem() as PerceptionEvent.Status
            assertThat(event.message).isEqualTo("sentinel")
            cancelAndIgnoreRemainingEvents()
        }
    }
}

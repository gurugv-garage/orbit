package dev.orbit.dock.perception

import android.os.Bundle
import android.speech.SpeechRecognizer
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import app.cash.turbine.test
import com.google.common.truth.Truth.assertThat
import kotlinx.coroutines.test.runTest
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Tests the STT plumbing — that Google's `RecognitionListener` callbacks
 * are correctly converted into `PerceptionEvent.Transcript` events on the
 * bus. Doesn't require an actual mic / audio input — we invoke the
 * callbacks directly.
 */
@RunWith(AndroidJUnit4::class)
class AndroidSpeechRecognizerSttTest {

    @Test
    fun finalResultEmitsTranscriptWithIsFinalTrue() = runTest {
        val ctx = InstrumentationRegistry.getInstrumentation().targetContext
        val stt = newSttOnMainThread(ctx)

        PerceptionBus.events.test {
            stt.onResults(bundleWith("what is the capital of france"))

            // After onResults: a Transcript(final=true), then a Status(final).
            val event1 = awaitItem()
            assertThat(event1).isInstanceOf(PerceptionEvent.Transcript::class.java)
            val t = event1 as PerceptionEvent.Transcript
            assertThat(t.text).isEqualTo("what is the capital of france")
            assertThat(t.isFinal).isTrue()

            val event2 = awaitItem()
            assertThat(event2).isInstanceOf(PerceptionEvent.Status::class.java)
            assertThat((event2 as PerceptionEvent.Status).message).isEqualTo("final")

            cancelAndIgnoreRemainingEvents()
        }
        stt.close()
    }

    @Test
    fun partialResultEmitsTranscriptWithIsFinalFalse() = runTest {
        val ctx = InstrumentationRegistry.getInstrumentation().targetContext
        val stt = newSttOnMainThread(ctx)

        PerceptionBus.events.test {
            stt.onPartialResults(bundleWith("hello wo"))

            val event = awaitItem() as PerceptionEvent.Transcript
            assertThat(event.text).isEqualTo("hello wo")
            assertThat(event.isFinal).isFalse()

            cancelAndIgnoreRemainingEvents()
        }
        stt.close()
    }

    @Test
    fun emptyResultsEmitOnlyStatus() = runTest {
        val ctx = InstrumentationRegistry.getInstrumentation().targetContext
        val stt = newSttOnMainThread(ctx)

        PerceptionBus.events.test {
            stt.onResults(Bundle())  // no RESULTS_RECOGNITION key

            // No Transcript should fire — but Status(final) should.
            val event = awaitItem() as PerceptionEvent.Status
            assertThat(event.message).isEqualTo("final")

            cancelAndIgnoreRemainingEvents()
        }
        stt.close()
    }

    @Test
    fun errorEmitsErrorEvent() = runTest {
        val ctx = InstrumentationRegistry.getInstrumentation().targetContext
        val stt = newSttOnMainThread(ctx)

        PerceptionBus.events.test {
            stt.onError(SpeechRecognizer.ERROR_NETWORK)

            val event = awaitItem() as PerceptionEvent.Error
            assertThat(event.source).isEqualTo("speech-recognizer")
            assertThat(event.cause.message).contains("network")

            cancelAndIgnoreRemainingEvents()
        }
        stt.close()
    }

    @Test
    fun noSpeechErrorMapsToFriendlyMessage() = runTest {
        val ctx = InstrumentationRegistry.getInstrumentation().targetContext
        val stt = newSttOnMainThread(ctx)

        PerceptionBus.events.test {
            stt.onError(SpeechRecognizer.ERROR_SPEECH_TIMEOUT)

            val event = awaitItem() as PerceptionEvent.Error
            assertThat(event.cause.message).contains("speech timeout")

            cancelAndIgnoreRemainingEvents()
        }
        stt.close()
    }

    private fun bundleWith(text: String): Bundle = Bundle().apply {
        putStringArrayList(
            SpeechRecognizer.RESULTS_RECOGNITION,
            arrayListOf(text),
        )
    }

    /** SpeechRecognizer requires construction on the main looper thread. */
    private fun newSttOnMainThread(ctx: android.content.Context): AndroidSpeechRecognizerStt {
        val ref = java.util.concurrent.atomic.AtomicReference<AndroidSpeechRecognizerStt>()
        val latch = java.util.concurrent.CountDownLatch(1)
        android.os.Handler(android.os.Looper.getMainLooper()).post {
            ref.set(AndroidSpeechRecognizerStt(ctx))
            latch.countDown()
        }
        latch.await(5, java.util.concurrent.TimeUnit.SECONDS)
        return ref.get()
    }
}

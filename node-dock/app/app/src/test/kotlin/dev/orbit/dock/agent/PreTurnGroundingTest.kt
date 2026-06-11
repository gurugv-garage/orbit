package dev.orbit.dock.agent

import com.google.common.truth.Truth.assertThat
import kotlinx.coroutines.async
import kotlinx.coroutines.test.currentTime
import kotlinx.coroutines.test.runTest
import org.junit.Test

/**
 * Turn-start gating on the in-flight STT-arm recognition: zero wait when the
 * result already landed (the normal case — recognition runs while the user
 * talks), bounded wait when it hasn't, no gate when nothing was requested.
 */
@OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
class PreTurnGroundingTest {

    @Test
    fun noPendingRequest_returnsImmediately() = runTest {
        val g = PreTurnGrounding(maxWaitMs = 10_000)
        g.awaitGrounded() // must not hang (virtual time would expose a wait)
        assertThat(currentTime).isEqualTo(0)
    }

    @Test
    fun resultBeforeTranscript_zeroWait() = runTest {
        val g = PreTurnGrounding(maxWaitMs = 10_000)
        g.begin()
        g.complete()      // recognition came home while the user was talking
        g.awaitGrounded()
        assertThat(currentTime).isEqualTo(0)
    }

    @Test
    fun slowRecognition_waitsAtMostTheCap() = runTest {
        val g = PreTurnGrounding(maxWaitMs = 800)
        g.begin()         // never completes
        g.awaitGrounded()
        assertThat(currentTime).isEqualTo(800)
    }

    @Test
    fun lateResultUnblocksEarly() = runTest {
        val g = PreTurnGrounding(maxWaitMs = 800)
        g.begin()
        val turn = async { g.awaitGrounded(); currentTime }
        // result lands 200ms in → the turn starts then, not at the 800ms cap
        kotlinx.coroutines.delay(200)
        g.complete()
        assertThat(turn.await()).isEqualTo(200)
    }

    @Test
    fun cancelledRequest_doesNotGate() = runTest {
        val g = PreTurnGrounding(maxWaitMs = 10_000)
        g.begin()
        g.cancel()        // no photo / no link — nothing will answer
        g.awaitGrounded()
        assertThat(currentTime).isEqualTo(0)
    }

    @Test
    fun newSessionSupersedesTheOld() = runTest {
        val g = PreTurnGrounding(maxWaitMs = 800)
        g.begin()         // session 1, never answers
        g.begin()         // session 2 (re-listen) supersedes
        g.complete()      // session 2's result
        g.awaitGrounded()
        assertThat(currentTime).isEqualTo(0)
    }

    @Test
    fun awaitIsOneShot() = runTest {
        val g = PreTurnGrounding(maxWaitMs = 800)
        g.begin()
        g.awaitGrounded()                       // consumed (timed out)
        val before = currentTime
        g.awaitGrounded()                       // nothing pending now
        assertThat(currentTime).isEqualTo(before)
    }
}

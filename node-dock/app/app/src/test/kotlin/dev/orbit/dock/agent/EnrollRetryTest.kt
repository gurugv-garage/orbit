package dev.orbit.dock.agent

import com.google.common.truth.Truth.assertThat
import org.junit.Test

/** Enroll failure policy: one silent retry with a fresh frame, then a spoken
 *  correction — never a silently-confirmed save that didn't happen. */
class EnrollRetryTest {

    @Test
    fun successIsDone() {
        val e = EnrollRetry()
        e.begin("Guru")
        assertThat(e.onResult("Guru", ok = true)).isEqualTo(EnrollRetry.Action.Done)
        // a stray duplicate result after completion is ignored
        assertThat(e.onResult("Guru", ok = false)).isEqualTo(EnrollRetry.Action.None)
    }

    @Test
    fun firstFailureRetries_secondGivesUpWithSpokenLine() {
        val e = EnrollRetry()
        e.begin("Guru")
        val first = e.onResult("Guru", ok = false)
        assertThat(first).isEqualTo(EnrollRetry.Action.Retry("Guru", 2))
        val second = e.onResult("Guru", ok = false)
        assertThat(second).isInstanceOf(EnrollRetry.Action.GiveUp::class.java)
        assertThat((second as EnrollRetry.Action.GiveUp).line).contains("haven't saved")
    }

    @Test
    fun retryThenSuccessIsDone() {
        val e = EnrollRetry()
        e.begin("Guru")
        e.onResult("Guru", ok = false)
        assertThat(e.onResult("Guru", ok = true)).isEqualTo(EnrollRetry.Action.Done)
    }

    @Test
    fun unrelatedOrUntrackedResultsAreIgnored() {
        val e = EnrollRetry()
        assertThat(e.onResult("Guru", ok = false)).isEqualTo(EnrollRetry.Action.None) // nothing in flight
        e.begin("Guru")
        assertThat(e.onResult("Shweta", ok = false)).isEqualTo(EnrollRetry.Action.None) // different name
    }

    @Test
    fun nameMatchingIsCaseInsensitive_andNullNameAttributesToInFlight() {
        val e = EnrollRetry()
        e.begin("Guru")
        assertThat(e.onResult("guru", ok = true)).isEqualTo(EnrollRetry.Action.Done)
        e.begin("Guru")
        // station's "no photo/no name" failure carries no name — still ours
        assertThat(e.onResult(null, ok = false)).isEqualTo(EnrollRetry.Action.Retry("Guru", 2))
    }

    @Test
    fun newEnrollResetsTheAttemptCount() {
        val e = EnrollRetry()
        e.begin("Guru")
        e.onResult("Guru", ok = false)          // attempt 2 in flight
        e.begin("Guru")                          // user re-initiated → fresh
        assertThat(e.onResult("Guru", ok = false)).isEqualTo(EnrollRetry.Action.Retry("Guru", 2))
    }
}

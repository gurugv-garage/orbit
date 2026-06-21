package dev.orbit.dock.ui.face

import com.google.common.truth.Truth.assertThat
import dev.orbit.dock.ui.face.ListeningArbiter.Source
import org.junit.Test

/**
 * Priority arbitration for listening mode. The headline invariant: a LOW-priority
 * OFF signal (face-leave) must NOT cancel a HIGH-priority ON (follow-up / tap).
 */
class ListeningArbiterTest {

    @Test fun idleByDefault() {
        val a = ListeningArbiter()
        assertThat(a.isListening(0)).isFalse()
        assertThat(a.active(0)).isNull()
    }

    @Test fun aHoldTurnsListeningOn_andExpires() {
        val a = ListeningArbiter()
        a.hold(Source.USER, now = 0, durationMs = 1000)
        assertThat(a.isListening(500)).isTrue()
        assertThat(a.active(500)).isEqualTo(Source.USER)
        assertThat(a.isListening(1001)).isFalse() // expired
    }

    // ── the headline cases: priority arbitration ────────────────────────────

    @Test fun faceLeaveDoesNotCancelFollowup() {
        val a = ListeningArbiter()
        a.hold(Source.FOLLOWUP, now = 0, durationMs = 5000)
        // a face-leave releases only holds at/below FACE_ARRIVAL priority.
        a.release(maxPriority = Source.FACE_ARRIVAL.priority, now = 100)
        assertThat(a.isListening(100)).isTrue()
        assertThat(a.active(100)).isEqualTo(Source.FOLLOWUP) // survived
    }

    @Test fun faceLeaveDoesNotCancelUserTap() {
        val a = ListeningArbiter()
        a.hold(Source.USER, now = 0, durationMs = 8000)
        a.release(maxPriority = Source.FACE_ARRIVAL.priority, now = 50)
        assertThat(a.active(50)).isEqualTo(Source.USER)
    }

    @Test fun followupDoesNotCancelUser_butUserWinsWhenBothHeld() {
        val a = ListeningArbiter()
        a.hold(Source.FOLLOWUP, 0, 5000)
        a.hold(Source.USER, 0, 8000)
        // both held → the higher priority (USER) is the active/winning source.
        assertThat(a.active(100)).isEqualTo(Source.USER)
        // a sentence-end clears USER explicitly → FOLLOWUP still holds.
        a.clear(Source.USER)
        assertThat(a.active(100)).isEqualTo(Source.FOLLOWUP)
    }

    @Test fun aLowPriorityOnDoesNotOverrideAHigherActiveOne() {
        val a = ListeningArbiter()
        a.hold(Source.USER, 0, 8000)
        a.hold(Source.FACE_ARRIVAL, 0, 5000) // face arrives during a tap session
        assertThat(a.active(100)).isEqualTo(Source.USER) // user still wins
    }

    // ── follow-up window behavior ───────────────────────────────────────────

    @Test fun followupExpiresIfNoSpeech() {
        val a = ListeningArbiter()
        a.hold(Source.FOLLOWUP, now = 0, durationMs = 5000)
        assertThat(a.isListening(4999)).isTrue()
        assertThat(a.isListening(5001)).isFalse() // dropped — no VAD activity
    }

    @Test fun vadActivityExtendsTheFollowupWindow() {
        val a = ListeningArbiter()
        a.hold(Source.FOLLOWUP, now = 0, durationMs = 5000)
        // at 4500ms the user starts talking → extend.
        a.extendFollowup(now = 4500)
        // would have died at 5000, now lives to 4500 + FOLLOWUP_VAD_EXTEND (4000).
        assertThat(a.isListening(6000)).isTrue()
        assertThat(a.isListening(8501)).isFalse()
    }

    @Test fun extendFollowupIsNoOpIfFollowupNotHeld() {
        val a = ListeningArbiter()
        a.hold(Source.USER, 0, 1000)
        a.extendFollowup(500) // no FOLLOWUP hold → nothing happens
        assertThat(a.active(500)).isEqualTo(Source.USER)
    }

    // ── release semantics ───────────────────────────────────────────────────

    @Test fun releaseClearsAtOrBelowPriority() {
        val a = ListeningArbiter()
        a.hold(Source.FACE_ARRIVAL, 0, 5000)
        a.hold(Source.FOLLOWUP, 0, 5000)
        // release at FOLLOWUP priority clears FACE_ARRIVAL AND FOLLOWUP, not above.
        a.release(maxPriority = Source.FOLLOWUP.priority, now = 100)
        assertThat(a.isListening(100)).isFalse()
    }

    @Test fun sentenceEndClearsUserButLeavesFollowupToTakeOver() {
        val a = ListeningArbiter()
        a.hold(Source.USER, 0, 8000)
        // user spoke → turn ran → reply → now arm FOLLOWUP, then clear USER (sentence-end).
        a.hold(Source.FOLLOWUP, 0, 5000)
        a.clear(Source.USER)
        assertThat(a.active(100)).isEqualTo(Source.FOLLOWUP)
    }
}

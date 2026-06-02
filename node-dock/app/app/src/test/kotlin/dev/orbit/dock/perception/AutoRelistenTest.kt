package dev.orbit.dock.perception

import com.google.common.truth.Truth.assertThat
import org.junit.Test

/**
 * Tests for [AutoRelisten] — the pure decision state machine behind
 * "continuous conversation": after the dock finishes speaking the reply to a
 * VOICE-initiated turn, re-arm the mic exactly once so the user can keep
 * talking without tapping. A turn that wasn't voice-initiated (no active
 * listening session) must NOT re-arm.
 *
 * The single observable output is the boolean returned by [AutoRelisten.onSpeakingChanged]
 * when speaking ends (active=false): true == "re-arm the mic now".
 */
class AutoRelistenTest {

    @Test
    fun voiceTurnRearmsOnceAfterSpeechEnds() {
        val a = AutoRelisten()
        a.onSessionStarted()           // user tapped → listening
        a.onVoiceTranscript()          // STT produced a final transcript
        a.onSpeakingChanged(true)      // dock starts replying
        val rearm = a.onSpeakingChanged(false)  // dock finished
        assertThat(rearm).isTrue()
    }

    @Test
    fun rearmsOnlyOnceNotEverySpeakingToggle() {
        val a = AutoRelisten()
        a.onSessionStarted()
        a.onVoiceTranscript()
        a.onSpeakingChanged(true)
        assertThat(a.onSpeakingChanged(false)).isTrue()   // first speech-end → rearm
        // A later stray speaking toggle (e.g. a system message) must NOT
        // re-arm again — the pending voice turn was already consumed.
        a.onSpeakingChanged(true)
        assertThat(a.onSpeakingChanged(false)).isFalse()
    }

    @Test
    fun nonVoiceTurnDoesNotRearm() {
        val a = AutoRelisten()
        // No session, no transcript — the dock spoke on its own (e.g. a
        // proactive/system line). Speaking ending must NOT arm the mic.
        a.onSpeakingChanged(true)
        assertThat(a.onSpeakingChanged(false)).isFalse()
    }

    @Test
    fun transcriptWithoutSessionDoesNotRearm() {
        val a = AutoRelisten()
        // A transcript arrived but no listening session was active when it did
        // (shouldn't normally happen, but guard it): treat as non-voice.
        a.onVoiceTranscript()
        a.onSpeakingChanged(true)
        assertThat(a.onSpeakingChanged(false)).isFalse()
    }

    @Test
    fun tapStopBeforeSpeechCancelsRearm() {
        val a = AutoRelisten()
        a.onSessionStarted()
        a.onVoiceTranscript()
        a.onCancelled()                // user tapped to stop / barged in
        a.onSpeakingChanged(true)
        assertThat(a.onSpeakingChanged(false)).isFalse()
    }

    @Test
    fun newSessionBeforeSpeechCancelsStaleRearm() {
        val a = AutoRelisten()
        a.onSessionStarted()
        a.onVoiceTranscript()
        // A brand-new listening session starts (user tapped again) before the
        // old turn finished speaking → the old pending re-arm is moot; the new
        // session governs from here.
        a.onSessionStarted()
        assertThat(a.onSpeakingChanged(false)).isFalse()
    }

    @Test
    fun speechEndWithoutStartStillHonorsPendingVoiceTurn() {
        // Some TTS paths may only emit the (false) edge if a reply was very
        // short. A pending voice turn should still re-arm on the first
        // speaking=false it sees.
        val a = AutoRelisten()
        a.onSessionStarted()
        a.onVoiceTranscript()
        assertThat(a.onSpeakingChanged(false)).isTrue()
    }

    @Test
    fun continuousLoop_secondVoiceTurnAlsoRearms() {
        val a = AutoRelisten()
        // Turn 1
        a.onSessionStarted()
        a.onVoiceTranscript()
        a.onSpeakingChanged(true)
        assertThat(a.onSpeakingChanged(false)).isTrue()
        // The re-arm starts a new session; user speaks again → turn 2 should
        // also re-arm, proving the loop is sustainable.
        a.onSessionStarted()
        a.onVoiceTranscript()
        a.onSpeakingChanged(true)
        assertThat(a.onSpeakingChanged(false)).isTrue()
    }

    @Test
    fun bargeInWakeWordBeforeSpeechFalseDoesNotDoubleArm() {
        // Barge-in emits WakeWord (new session) BEFORE the trailing
        // Speaking(false) from tts.stop(). The new session must absorb the
        // pending re-arm so Speaking(false) does NOT fire a second WakeWord.
        val a = AutoRelisten()
        a.onSessionStarted()
        a.onVoiceTranscript()
        a.onSpeakingChanged(true)        // dock is talking
        a.onSessionStarted()             // barge-in WakeWord (fresh session)
        assertThat(a.onSpeakingChanged(false)).isFalse()  // trailing edge → no re-arm
    }

    @Test
    fun emptySessionThenSilenceDoesNotRearm() {
        val a = AutoRelisten()
        a.onSessionStarted()
        // No transcript (user said nothing); session ends empty.
        a.onSessionEndedEmpty()
        a.onSpeakingChanged(true)   // shouldn't happen, but be safe
        assertThat(a.onSpeakingChanged(false)).isFalse()
    }

    @Test
    fun emptyEndAfterPendingVoiceTurnClearsPending() {
        // Defensive: if an empty-end somehow arrives after a voice transcript
        // (e.g. a late stray status), it clears the pending re-arm.
        val a = AutoRelisten()
        a.onSessionStarted()
        a.onVoiceTranscript()
        a.onSessionEndedEmpty()
        assertThat(a.onSpeakingChanged(false)).isFalse()
    }

    @Test
    fun redundantSpeakingFalseWithNoPendingNeverArms() {
        val a = AutoRelisten()
        // Many speaking=false edges with nothing pending → always false.
        repeat(5) { assertThat(a.onSpeakingChanged(false)).isFalse() }
    }

    @Test
    fun speakingTrueNeverArms() {
        val a = AutoRelisten()
        a.onSessionStarted()
        a.onVoiceTranscript()
        // The active=true edge must never trigger a re-arm, even with a
        // pending voice turn — only the false edge does.
        assertThat(a.onSpeakingChanged(true)).isFalse()
        // and the pending flag survives until the false edge consumes it
        assertThat(a.onSpeakingChanged(false)).isTrue()
    }

    @Test
    fun cancelAfterConsumedRearmIsNoOp() {
        val a = AutoRelisten()
        a.onSessionStarted()
        a.onVoiceTranscript()
        assertThat(a.onSpeakingChanged(false)).isTrue()  // consumed
        a.onCancelled()                                   // safe, nothing pending
        assertThat(a.onSpeakingChanged(false)).isFalse()
    }
}

package dev.orbit.dock.ui.face

/**
 * ListeningArbiter — the single owner of the dock's "addressed listening" mode.
 *
 * The mic is ALWAYS on (A1, server-side STT). "Listening" here = the ADDRESSED
 * window: the dock is attending to the user for a turn (face shows Listening,
 * beeps on/off, a tap is implied). MULTIPLE independent sources turn this on/off —
 * a user tap, "just finished a reply → await follow-up", auto-listen on a face
 * arriving, barge-in, and more to come. Without arbitration they fight: a
 * low-priority OFF (e.g. the user glanced away from the camera) could cancel a
 * high-priority ON (the dock just replied and is awaiting your follow-up).
 *
 * The model: each source registers a **hold** with a **priority** and an
 * **expiry**. Listening is ON iff any unexpired hold exists. The arbiter's state
 * is the MAX-priority active hold. Key rule:
 *
 *   an OFF signal only clears holds AT OR BELOW its own priority.
 *
 * So "face left" (LOW) cannot end "awaiting follow-up" (FOLLOWUP) or a "tap"
 * (USER). A higher-priority source always wins; equal/lower yields.
 *
 * Pure + deterministic: the caller passes `now` (ms). No threads, no I/O — fully
 * unit-testable (ListeningArbiterTest). The UI layer (PerceptionWiring) maps the
 * arbiter's on/off edges to controller.listen()/silence() + the beeps.
 */
class ListeningArbiter {

    /** Why listening is on — ordered by PRIORITY (higher ordinal = higher priority). */
    enum class Source(val priority: Int) {
        /** auto-listen when a new face arrives (ambient, lowest). */
        FACE_ARRIVAL(10),
        /** the dock just finished replying → await a follow-up without a re-tap. */
        FOLLOWUP(50),
        /** explicit user intent: a tap, or a voice barge-in (highest). */
        USER(100),
    }

    /** Tunable timings (ms). Centralized + documented so they're easy to play with. */
    object Cfg {
        /** Follow-up window after a reply: re-listen this long for a hands-free
         *  follow-up. VAD activity extends it (see [FOLLOWUP_VAD_EXTEND_MS]).
         *  Start small; raise for a more relaxed back-and-forth. */
        var FOLLOWUP_MS = 5_000L
        /** While in the follow-up window, each VAD-active tick pushes the expiry out
         *  this far, so a slow speaker isn't cut off mid-sentence. */
        var FOLLOWUP_VAD_EXTEND_MS = 4_000L
        /** A USER (tap) hold with no speech yet — drop after this so a stray tap
         *  can't stick listening on forever. (Mirrors the old LISTEN_ACK_TIMEOUT.) */
        var USER_ACK_MS = 8_000L
        /** A face-arrival auto-listen window. */
        var FACE_ARRIVAL_MS = 5_000L
    }

    private data class Hold(val source: Source, var until: Long)
    private val holds = mutableMapOf<Source, Hold>()

    /** Turn on (or refresh) a hold for [source], expiring at now+durationMs. A
     *  higher-or-equal existing hold of the same source just extends. */
    fun hold(source: Source, now: Long, durationMs: Long) {
        holds[source] = Hold(source, now + durationMs)
    }

    /** Extend the FOLLOWUP hold (VAD activity during the follow-up window) so the
     *  user isn't cut off mid-sentence. No-op if FOLLOWUP isn't currently held. */
    fun extendFollowup(now: Long) {
        val h = holds[Source.FOLLOWUP] ?: return
        if (h.until > now) h.until = maxOf(h.until, now + Cfg.FOLLOWUP_VAD_EXTEND_MS)
    }

    /**
     * Release listening, but ONLY holds at or below [maxPriority] (an OFF signal
     * can't cancel a higher-priority ON). E.g. a face-leave calls
     * release(FACE_ARRIVAL.priority) and leaves FOLLOWUP/USER untouched.
     * `clearSelf=true` also clears exactly [atSource] (e.g. sentence-end clears USER).
     */
    fun release(maxPriority: Int, now: Long) {
        holds.entries.removeAll { (_, h) -> h.source.priority <= maxPriority || h.until <= now }
    }

    /** Explicitly clear one source (e.g. a final transcript clears USER). */
    fun clear(source: Source) { holds.remove(source) }

    /** Drop expired holds (call before reading state). */
    fun prune(now: Long) { holds.entries.removeAll { it.value.until <= now } }

    /** Is listening on right now? */
    fun isListening(now: Long): Boolean { prune(now); return holds.isNotEmpty() }

    /** The current winning (highest-priority) active source, or null if idle. */
    fun active(now: Long): Source? {
        prune(now)
        return holds.values.maxByOrNull { it.source.priority }?.source
    }
}

package dev.orbit.dock.perception

import dev.orbit.dock.station.StationLink
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.launchIn
import kotlinx.coroutines.flow.onEach
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.add
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import timber.log.Timber

/**
 * Forwards the on-device MLKit perception (the rich [PerceptionEvent.PerceiveFrame], plus
 * the latest emotion/gesture/identity) to the station as the **`perceive` stream** — the
 * fast, low-latency face source for faceFollow + the perception pipeline. The phone already
 * computes all of this for its own UI/gaze/emotion; this just stops throwing it away.
 *
 * NOISE CONTROL (the reason this is a forwarder, not an inline publish): the detector runs
 * ~1 Hz and a still face's box jitters a few %, so blindly publishing every tick spams the
 * bus + console. Same shape as the station identity stream's CONFIRM/DROP hysteresis:
 *   • SUPPRESS a frame ~identical to the last SENT one (Δx/Δy/Δsize < ε, same face count +
 *     trackingIds + emotion + gesture + identity);
 *   • RATE-LIMIT fast change to ≥ MIN_INTERVAL_MS between sends (a thrashing signal can't
 *     flood — coalesced to ≤ ~5 Hz);
 *   • always send TRANSITIONS immediately (face appear/disappear, identity change, a new
 *     trackingId) — these are the events that matter;
 *   • HEARTBEAT: send at most every HEARTBEAT_MS even when unchanged, so the station knows
 *     the face is STILL there (not stale) — faceFollow needs presence, not just change.
 *
 * Latest emotion/gesture/identity are folded in from their own bus events (each arrives on a
 * different cadence) so one `perceive` frame is a coherent "what the dock perceives now".
 */
class PerceiveForwarder(
    private val link: () -> StationLink?,
    scope: CoroutineScope,
) {
    // Latest auxiliary signals, folded into the next face frame.
    @Volatile private var emotionKind: String? = null
    @Volatile private var emotionConf = 0f
    @Volatile private var gestureName: String? = null
    @Volatile private var gesturePalm = false
    @Volatile private var gestureScore = 0f
    @Volatile private var identityName: String? = null
    @Volatile private var identityConf = 0f

    // Dedup memory: what we last SENT, and when. (Position deltas are no longer used to gate
    // a present face — we forward every detection so motion isn't lagged — only count/ids/
    // emotion/gesture/identity transitions + presence + the heartbeat gate now.)
    private var lastSentMs = 0L
    private var lastFaceCount = -1
    private var lastIds: List<Int?> = emptyList()
    private var lastEmotion: String? = null
    private var lastGesture: String? = null
    private var lastIdentity: String? = null

    init {
        PerceptionBus.events.onEach { ev ->
            when (ev) {
                is PerceptionEvent.UserEmotion -> { emotionKind = ev.kind.name; emotionConf = ev.confidence }
                is PerceptionEvent.HandGesture -> { gestureName = ev.gesture; gesturePalm = ev.palm; gestureScore = ev.score }
                is PerceptionEvent.UserIdentified -> { identityName = ev.name; identityConf = ev.confidence }
                is PerceptionEvent.PerceiveFrame -> maybeSend(ev)
                is PerceptionEvent.FaceLost -> maybeSendEmpty()
                else -> {}
            }
        }.launchIn(scope)
    }

    /** A PerceiveFrame arrived — decide whether it's worth sending, then publish. */
    private fun maybeSend(f: PerceptionEvent.PerceiveFrame) {
        val now = System.currentTimeMillis()
        val primary = f.faces.maxByOrNull { it.size }
        val ids = f.faces.map { it.trackingId }
        val transition = f.faces.size != lastFaceCount || ids != lastIds ||
            emotionKind != lastEmotion || gestureName != lastGesture || identityName != lastIdentity
        val heartbeatDue = now - lastSentMs >= HEARTBEAT_MS
        // FACE PRESENT → forward EVERY detection (don't suppress small moves): faceFollow needs
        // the freshest position the instant the person STARTS moving, and the detector is only
        // ~1 Hz to begin with, so there's nothing to throttle and suppressing it just adds lag
        // at the worst moment. A still face doesn't twitch the head — the CONTROLLER's deadband
        // handles that, not source-side dedup. We keep only the MIN_INTERVAL floor (anti-flood)
        // and the heartbeat for presence; the no-face idle case is handled by maybeSendEmpty.
        if (primary == null && !transition) {
            // no usable face this frame → only the heartbeat keeps presence fresh.
            if (!heartbeatDue) return
        }
        if (!transition && now - lastSentMs < MIN_INTERVAL_MS) return
        publish(f, now)
        lastSentMs = now
        lastFaceCount = f.faces.size
        lastIds = ids
        lastEmotion = emotionKind; lastGesture = gestureName; lastIdentity = identityName
    }

    /** Face fully lost → send one empty frame so the station drops presence promptly. */
    private fun maybeSendEmpty() {
        if (lastFaceCount == 0) return // already empty; don't spam
        val now = System.currentTimeMillis()
        val link = link() ?: return
        link.publish("perceive", "frame", buildJsonObject {
            put("faces", buildJsonArray { })
            putAux(this)
        })
        lastSentMs = now; lastFaceCount = 0; lastIds = emptyList()
    }

    private fun publish(f: PerceptionEvent.PerceiveFrame, now: Long) {
        val link = link() ?: return
        link.publish("perceive", "frame", buildJsonObject {
            put("faces", buildJsonArray {
                f.faces.forEach { d ->
                    add(buildJsonObject {
                        put("x", d.x); put("y", d.y); put("size", d.size)
                        put("bbox", buildJsonObject { put("l", d.bl); put("t", d.bt); put("r", d.br); put("b", d.bb) })
                        put("yaw", d.yaw); put("pitch", d.pitch); put("roll", d.roll)
                        d.trackingId?.let { put("trackingId", it) }
                        d.smile?.let { put("smile", it) }
                        d.leftEyeOpen?.let { put("leftEyeOpen", it) }
                        d.rightEyeOpen?.let { put("rightEyeOpen", it) }
                        put("landmarks", buildJsonArray {
                            d.landmarks.forEach { lm -> add(buildJsonObject { put("type", lm.type); put("x", lm.x); put("y", lm.y) }) }
                        })
                    })
                }
            })
            put("zoom", buildJsonObject { put("ratio", f.zoomRatio); put("min", f.zoomMin); put("max", f.zoomMax) })
            putAux(this)
        })
    }

    /** Fold the latest emotion/gesture/identity into a frame. */
    private fun putAux(b: kotlinx.serialization.json.JsonObjectBuilder) {
        emotionKind?.let { b.put("emotion", buildJsonObject { put("kind", it); put("confidence", emotionConf) }) }
        gestureName?.let { b.put("gesture", buildJsonObject { put("name", it); put("palm", gesturePalm); put("score", gestureScore) }) }
        identityName?.let { b.put("identity", buildJsonObject { put("name", it); put("confidence", identityConf) }) }
    }

    companion object {
        /** No two sends closer than this (≤ ~5 Hz) — caps a thrashing signal. */
        private const val MIN_INTERVAL_MS = 200L
        /** Heartbeat: re-send current state at least this often so presence isn't stale. */
        private const val HEARTBEAT_MS = 2_500L
    }
}

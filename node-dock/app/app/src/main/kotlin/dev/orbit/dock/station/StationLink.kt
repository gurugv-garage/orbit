package dev.orbit.dock.station

import io.ktor.client.HttpClient
import io.ktor.client.engine.okhttp.OkHttp
import io.ktor.client.plugins.websocket.WebSockets
import io.ktor.client.plugins.websocket.webSocketSession
import io.ktor.websocket.Frame
import io.ktor.websocket.readText
import io.ktor.websocket.send
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.add
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import timber.log.Timber

/**
 * The slice of the station link the brain facade needs — a seam so
 * [dev.orbit.dock.agent.RemoteBrain] is unit-testable with a scripted fake.
 */
interface BrainLink {
    val connected: StateFlow<Boolean>
    /** False when no station URL is configured — the link (and the brain) is off. */
    val enabled: Boolean
    fun publish(topic: String, kind: String, payload: JsonObject)
    suspend fun publishCritical(topic: String, kind: String, payload: JsonObject): Boolean
}

/**
 * The phone's link to orbit-station — since the server-brain cutover this is
 * the dock's REQUIRED nervous system, not an optional telemetry sink: the LLM
 * loop runs in the station ([dev.orbit.dock.agent.RemoteBrain] over the `agent`
 * topic), and body state arrives as a station-fanned `bodylink`/`digest`.
 * The face/TTS/perception UX still degrades gracefully when the link is down
 * (the brain just answers with a canned "can't reach my brain" line).
 *
 * Identity (hello v2, protocol.ts): this peer is the `phone` component of its
 * dock, software kind `dock-android-app`, capabilities voice/face/camera.
 * Station protocol: orbit-station/server/src/core/protocol.ts.
 *
 * Two send paths, deliberately different:
 *  - [publish] — telemetry: ordered, bounded outbox, DROP_OLDEST when the
 *    station is slow; shed rather than queue.
 *  - [publishCritical] — turn-correctness frames (turn-request, tool-result,
 *    turn-cancel, speech-status): direct send-or-fail. A stale turn-request
 *    delivered 30 s late would make the robot answer a question nobody
 *    remembers asking — critical frames are fail-fast, never store-and-forward.
 *
 * @param url   station WS, e.g. "ws://10.0.2.2:8099/ws" (emulator) — empty disables.
 * @param dock  the dock name, e.g. "anne-bot".
 */
class StationLink(
    private val url: String,
    private val dock: String,
    private val appId: String,
    private val scope: CoroutineScope,
    /**
     * Called for each inbound config push/snapshot frame on the `config` topic,
     * with the frame's payload (carrying scope/key/value/lastUpdated). Wired to
     * [dev.orbit.dock.config.ConfigCache.apply]. Default no-op so the station
     * link is usable without config.
     */
    private val onConfigFrame: (JsonObject) -> Unit = {},
    /**
     * The flat config keys this app is interested in. Announced to the station
     * on connect (a `config`/`interest` publish); the station then pushes only
     * these keys (snapshot now + live changes). Empty = announce nothing.
     */
    private val configInterest: List<String> = emptyList(),
    /**
     * OTA gate (docs/OTA.md §3): the app's running build (versionCode). Sent in
     * `hello` + each heartbeat so the station can compare and offer an update.
     * It's the ONLY version on the wire — the station owns build→label metadata.
     * 0 = don't advertise a build.
     */
    private val build: Int = 0,
    /**
     * Called for each `ota/available` offer on the `ota` topic, with the frame
     * payload { target, build, version, url, sha256, size }. Wired to
     * [dev.orbit.dock.ota.OtaUpdater.onOffer]. Default no-op.
     */
    private val onOtaOffer: (JsonObject) -> Unit = {},
    /**
     * Called for each inbound `media` frame (WebRTC signaling) with (kind,
     * payload) — `producer-answer`, `producer-ice`. Wired to
     * [dev.orbit.dock.perception.MediaStreamer]. Default no-op so the link is
     * usable without streaming.
     */
    private val onMediaFrame: (String, JsonObject) -> Unit = { _, _ -> },
    /**
     * Called for each inbound `perception` frame (station stream-processing
     * results) with (kind, payload) — e.g. `identity`, `presence`. Wired in
     * DockScreen to emit onto the PerceptionBus so the agent re-grounds. Default
     * no-op so the link is usable without perception.
     */
    private val onPerceptionFrame: (String, JsonObject) -> Unit = { _, _ -> },
    /**
     * Called for each inbound `agent` frame (the server brain talking to this
     * dock) with (kind, payload) — `tool-call`, `speak`, `turn-status`,
     * `brain-status`. Wired to [dev.orbit.dock.agent.RemoteBrain.onAgentFrame].
     */
    private val onAgentFrame: (String, JsonObject) -> Unit = { _, _ -> },
    /**
     * Called for each `bodylink`/`digest` frame — the station's ~1 Hz body
     * status ({ dock, parts, online, ts }). Display-only by design (the phone
     * never drives the body anymore); staleness-tolerant.
     */
    private val onBodyDigest: (JsonObject) -> Unit = {},
) : BrainLink {
    private val _connected = MutableStateFlow(false)
    override val connected: StateFlow<Boolean> = _connected.asStateFlow()

    override val enabled: Boolean get() = url.isNotBlank()

    private val client = HttpClient(OkHttp) { install(WebSockets) }
    private val json = Json { encodeDefaults = true }

    @Volatile private var session: io.ktor.client.plugins.websocket.DefaultClientWebSocketSession? = null
    private var loopJob: Job? = null
    private var heartbeatJob: Job? = null
    private var senderJob: Job? = null

    // Outgoing TELEMETRY frames, drained by ONE sender coroutine per session so
    // frames leave in publish order (a launch-per-frame sender reordered obs
    // `seq` under load). Bounded + drop-oldest: when the station is slow or
    // unreachable we shed telemetry instead of growing a queue on the phone.
    // Turn-correctness frames bypass this — see [publishCritical].
    private val outbox = kotlinx.coroutines.channels.Channel<String>(
        capacity = 256,
        onBufferOverflow = kotlinx.coroutines.channels.BufferOverflow.DROP_OLDEST,
    )

    /** Begin connecting (and auto-reconnecting). No-op if url is blank. */
    fun start() {
        if (url.isBlank()) {
            Timber.i("StationLink: no station URL — disabled (no station = no brain)")
            return
        }
        loopJob = scope.launch {
            var backoffMs = 1000L
            while (isActive) {
                try {
                    runSession()
                    backoffMs = 1000L
                } catch (t: Throwable) {
                    Timber.d("StationLink: not connected (${t.message}); retrying")
                }
                _connected.value = false
                session = null
                delay(backoffMs)
                backoffMs = (backoffMs * 2).coerceAtMost(15000L)
            }
        }
    }

    private suspend fun runSession() {
        val s = client.webSocketSession(url)
        session = s
        // hello v2 (protocol.ts): this peer = the `phone` slot of its dock.
        s.send(json.encodeToString(JsonObject.serializer(), buildJsonObject {
            put("t", "hello"); put("role", "device"); put("id", appId)
            put("dock", dock); put("component", "phone")
            put("kind", "dock-android-app")
            put("caps", buildJsonArray { add("voice"); add("face"); add("camera") })
            put("label", "$dock phone")
            // OTA gate (docs/OTA.md §3): build is the only version on the wire.
            if (build > 0) put("build", build)
        }))
        s.send(json.encodeToString(JsonObject.serializer(), buildJsonObject {
            put("t", "subscribe")
            put("topics", buildJsonArray {
                add("config"); add("station"); add("ota"); add("media")
                add("perception"); add("agent"); add("bodylink")
            })
        }))
        // Deterministic brain resync: say hello on the agent topic AFTER
        // subscribing — the brain replies with a directed `brain-status`. (The
        // station also pushes brain-status on peer-joined, but that push can
        // race this socket's subscribe frame; this one can't miss.)
        s.send(json.encodeToString(JsonObject.serializer(), buildJsonObject {
            put("t", "publish"); put("topic", "agent"); put("kind", "hello")
            put("payload", buildJsonObject {})
        }))
        // Announce which config keys we care about. The station replies with a
        // directed snapshot of just these, then pushes their changes live.
        if (configInterest.isNotEmpty()) {
            s.send(json.encodeToString(JsonObject.serializer(), buildJsonObject {
                put("t", "publish"); put("topic", "config"); put("kind", "interest")
                put("payload", buildJsonObject {
                    put("keys", buildJsonArray { configInterest.forEach { add(it) } })
                })
            }))
        }
        _connected.value = true
        Timber.i("StationLink: connected to $url (dock=$dock, component=phone); announced ${configInterest.size} config keys")
        heartbeatJob?.cancel()
        heartbeatJob = scope.launch { heartbeatLoop() }
        senderJob?.cancel()
        senderJob = scope.launch {
            for (text in outbox) {
                try {
                    s.send(text)
                } catch (t: Throwable) {
                    Timber.d("StationLink send failed: ${t.message}")
                    break // session is dead; the reconnect loop builds a new sender
                }
            }
        }

        // Drain inbound. Each topic's frames feed their wired callback;
        // everything else keeps the socket healthy and lets us notice closes.
        for (frame in s.incoming) {
            if (frame is Frame.Text) handleInbound(frame.readText())
        }
    }

    private fun handleInbound(text: String) {
        val frame = runCatching { json.parseToJsonElement(text).jsonObject }.getOrNull() ?: return
        // station wraps published events as {t:'event', topic, kind, payload, ...}
        val topic = frame["topic"]?.jsonPrimitive?.content
        val kind = frame["kind"]?.jsonPrimitive?.content
        val payload = frame["payload"] as? JsonObject
        when {
            topic == "config" && payload != null ->
                runCatching { onConfigFrame(payload) }
                    .onFailure { Timber.d("config frame handling failed: ${it.message}") }
            topic == "ota" && kind == "available" && payload != null ->
                runCatching { onOtaOffer(payload) }
                    .onFailure { Timber.d("ota offer handling failed: ${it.message}") }
            topic == "media" && kind != null && payload != null ->
                runCatching { onMediaFrame(kind, payload) }
                    .onFailure { Timber.d("media frame handling failed: ${it.message}") }
            topic == "perception" && kind != null && payload != null ->
                runCatching { onPerceptionFrame(kind, payload) }
                    .onFailure { Timber.d("perception frame handling failed: ${it.message}") }
            topic == "agent" && kind != null && payload != null ->
                runCatching { onAgentFrame(kind, payload) }
                    .onFailure { Timber.w("agent frame ($kind) handling failed: ${it.message}") }
            topic == "bodylink" && kind == "digest" && payload != null ->
                runCatching { onBodyDigest(payload) }
                    .onFailure { Timber.d("body digest handling failed: ${it.message}") }
        }
    }

    private suspend fun heartbeatLoop() {
        while (session != null) {
            publish("station", "heartbeat", buildJsonObject {
                put("component", "phone")
                // OTA build in every heartbeat (docs/OTA.md §3) — keeps the
                // station's version view fresh + self-healing without a full
                // reconnect. Just the gate int; small payload.
                if (build > 0) put("build", build)
            })
            delay(10_000)
        }
    }

    /** Publish one TELEMETRY frame on a topic. Queued in order; silently
     *  dropped if not connected and shed (oldest-first) under backpressure. */
    override fun publish(topic: String, kind: String, payload: JsonObject) {
        if (session == null) return
        outbox.trySend(encodePublish(topic, kind, payload))
    }

    /**
     * Send one CRITICAL frame now — or fail. Bypasses the lossy outbox: no
     * queueing, no replay after reconnect; returns false when the link is down
     * or the send throws, so the caller can fail the user-visible action
     * honestly instead of having it ghost-execute half a minute later.
     */
    override suspend fun publishCritical(topic: String, kind: String, payload: JsonObject): Boolean {
        val s = session ?: return false
        return try {
            s.send(encodePublish(topic, kind, payload))
            true
        } catch (t: Throwable) {
            Timber.w("StationLink critical send ($topic/$kind) failed: ${t.message}")
            false
        }
    }

    private fun encodePublish(topic: String, kind: String, payload: JsonObject): String =
        json.encodeToString(JsonObject.serializer(), buildJsonObject {
            put("t", "publish"); put("topic", topic); put("kind", kind)
            put("payload", payload)
        })

    fun stop() {
        loopJob?.cancel(); heartbeatJob?.cancel(); senderJob?.cancel()
        session = null
        _connected.value = false
        client.close()
    }
}

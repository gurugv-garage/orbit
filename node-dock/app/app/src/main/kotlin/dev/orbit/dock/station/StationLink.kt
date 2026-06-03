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
 * Optional link to orbit-station. The dock works fully without it; if a station
 * URL is reachable, the app dials in (role `app`, declaring its dock name) and
 * publishes its agent-core event stream on the `obs` topic so the station's
 * observability view can render live turns. Also sends a 10 s heartbeat so the
 * station's roster shows the app online with a fresh "last seen".
 *
 * Mirrors [dev.orbit.dock.body.BodyLinkComms]'s ktor-WS + reconnect style.
 * Station protocol: orbit-station/server/src/core/protocol.ts.
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
     * Reports the app's own outgoing links for the station's mesh view: whether
     * the app's BodyLink is connected to the ESP32, and whether its LLM is
     * reachable. Heartbeated to the station so it knows who's connected to what
     * (incl. the app↔body link the station can't observe directly). Defaults to
     * unknown when not supplied.
     */
    private val linkStatus: () -> AppLinks = { AppLinks() },
    /**
     * Called for each inbound config push/snapshot frame on the `config` topic,
     * with the frame's payload (carrying scope/key/value/lastUpdated). Wired to
     * [dev.orbit.dock.config.ConfigCache.apply]. Default no-op so the station
     * link is usable without config.
     */
    private val onConfigFrame: (JsonObject) -> Unit = {},
) {
    private val _connected = MutableStateFlow(false)
    val connected: StateFlow<Boolean> = _connected.asStateFlow()

    private val client = HttpClient(OkHttp) { install(WebSockets) }
    private val json = Json { encodeDefaults = true }

    @Volatile private var session: io.ktor.client.plugins.websocket.DefaultClientWebSocketSession? = null
    private var loopJob: Job? = null
    private var heartbeatJob: Job? = null

    /** Begin connecting (and auto-reconnecting). No-op if url is blank. */
    fun start() {
        if (url.isBlank()) {
            Timber.i("StationLink: no station URL — disabled (dock runs standalone)")
            return
        }
        loopJob = scope.launch {
            var backoffMs = 1000L
            while (isActive) {
                try {
                    runSession()
                    backoffMs = 1000L
                } catch (t: Throwable) {
                    Timber.d("StationLink: not connected (${t.message}); retrying — dock unaffected")
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
        // hello + subscribe (we only listen to config/station; obs is publish-only here)
        s.send(json.encodeToString(JsonObject.serializer(), buildJsonObject {
            put("t", "hello"); put("role", "app"); put("id", appId)
            put("dock", dock); put("label", "$dock phone")
        }))
        s.send(json.encodeToString(JsonObject.serializer(), buildJsonObject {
            put("t", "subscribe")
            put("topics", buildJsonArray { add("config"); add("station") })
        }))
        _connected.value = true
        Timber.i("StationLink: connected to $url (dock=$dock)")
        heartbeatJob?.cancel()
        heartbeatJob = scope.launch { heartbeatLoop() }

        // Drain inbound. Config pushes/snapshots (topic 'config') feed the
        // ConfigCache via onConfigFrame; everything else keeps the socket
        // healthy and lets us notice closes.
        for (frame in s.incoming) {
            if (frame is Frame.Text) handleInbound(frame.readText())
        }
    }

    private fun handleInbound(text: String) {
        val frame = runCatching { json.parseToJsonElement(text).jsonObject }.getOrNull() ?: return
        // station wraps published events as {t:'event', topic, kind, payload, ...}
        val topic = frame["topic"]?.jsonPrimitive?.content
        if (topic == "config") {
            val payload = frame["payload"] as? JsonObject ?: return
            runCatching { onConfigFrame(payload) }
                .onFailure { Timber.d("config frame handling failed: ${it.message}") }
        }
    }

    private suspend fun heartbeatLoop() {
        while (session != null) {
            val links = linkStatus()
            publish("station", "heartbeat", buildJsonObject {
                put("role", "app")
                // links the station can't see itself — drives its mesh view.
                put("links", buildJsonObject {
                    put("body", links.bodyConnected)
                    put("llm", links.llmReachable)
                })
            })
            delay(10_000)
        }
    }

    /** Publish one frame on a topic. Silently dropped if not connected. */
    fun publish(topic: String, kind: String, payload: JsonObject) {
        val s = session ?: return
        scope.launch {
            try {
                s.send(json.encodeToString(JsonObject.serializer(), buildJsonObject {
                    put("t", "publish"); put("topic", topic); put("kind", kind)
                    put("payload", payload)
                }))
            } catch (t: Throwable) {
                Timber.d("StationLink publish failed: ${t.message}")
            }
        }
    }

    /** Publish one agent-core event on the `obs` topic. */
    fun emitAgentEvent(dto: JsonObject) = publish("obs", "event", dto)

    fun stop() {
        loopJob?.cancel(); heartbeatJob?.cancel()
        session = null
        _connected.value = false
        client.close()
    }
}

/** The app's own outgoing link states, reported to the station each heartbeat. */
data class AppLinks(
    val bodyConnected: Boolean = false,
    val llmReachable: Boolean = false,
)

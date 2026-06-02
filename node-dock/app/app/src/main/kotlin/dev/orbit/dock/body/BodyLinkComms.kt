package dev.orbit.dock.body

import io.ktor.client.HttpClient
import io.ktor.client.engine.okhttp.OkHttp
import io.ktor.client.plugins.websocket.WebSockets
import io.ktor.client.plugins.websocket.webSocketSession
import io.ktor.websocket.Frame
import io.ktor.websocket.WebSocketSession
import io.ktor.websocket.close
import io.ktor.websocket.readText
import io.ktor.websocket.send
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonObject
import timber.log.Timber

/**
 * Brain-side BodyLink client (2026-05-27 protocol).
 *
 * Exposes:
 *   - profile : StateFlow<BodyProfile?>     (cached after handshake)
 *   - intent  : StateFlow<BodyIntent>       (brain's last-commanded target per part)
 *   - events  : SharedFlow<BodyEvent>       (clipped, stall, boot, drift…)
 *   - connected : StateFlow<Boolean>
 *
 * Lifecycle:
 *   start()                      — connect, handshake, read loop, heartbeat
 *   setTarget(parts, durationMs) — raw primitive command
 *   setState(part, stateName)    — resolve via catalog, then setTarget
 *   stop()                       — close session
 *
 * Heartbeat: every 1s (idle) / 100ms (within 500ms of an intent change), if
 * connected AND we have a non-empty intent, re-send `set_target` for every
 * part. The body is per-part idempotent — this is a free liveness check
 * when nothing's moving, and a recovery mechanism if a frame was dropped
 * or the body restarted.
 *
 * WS ping is re-enabled at 2s. The firmware's esp_http_server auto-pongs;
 * this gives Kotlin a reliable disconnect signal that doesn't depend on
 * application traffic.
 *
 * Strict unknown-field policy (DESIGN.md §5.4): unknown message types or
 * event kinds emit BodyEvent.ProtocolDrift + best-effort UNKNOWN_TYPE error.
 */
class BodyLinkComms(
    host: String,
    private val scope: CoroutineScope,
    private val catalog: BodyStateCatalog = BodyStateCatalog(emptyMap()),
    /** Invoked (on a coroutine) with the host string each time a handshake
     *  fully succeeds. Used to persist a connect-history of working hosts. */
    private val onConnected: ((String) -> Unit)? = null,
) : BodyController {
    /** Current target host ("ip:port" or "ws://…"). Mutable so the UI can
     *  retarget at runtime via [reconnect] without rebuilding the app. */
    @Volatile private var host: String = host

    /** Exposes the current host for the UI (e.g. to prefill the dialog). */
    val currentHost: String get() = host
    private val _profile = MutableStateFlow<BodyProfile?>(null)
    val profile: StateFlow<BodyProfile?> = _profile.asStateFlow()

    private val _intent = MutableStateFlow(BodyIntent.EMPTY)
    val intent: StateFlow<BodyIntent> = _intent.asStateFlow()

    private val _events = MutableSharedFlow<BodyEvent>(extraBufferCapacity = 32)
    val events: SharedFlow<BodyEvent> = _events.asSharedFlow()

    private val _connected = MutableStateFlow(false)
    override val connected: StateFlow<Boolean> = _connected.asStateFlow()

    /** Validated catalog (post-profile). Falls back to the raw catalog until profile arrives. */
    @Volatile override var validatedCatalog: BodyStateCatalog = catalog
        private set

    private val client by lazy {
        HttpClient(OkHttp) {
            install(WebSockets) {
                // 2s ping. Firmware's esp_http_server auto-pongs; gives us a
                // reliable disconnect signal independent of application traffic.
                pingIntervalMillis = 2_000L
            }
            engine {
                // Faster detection of an ungracefully-vanished body (power-off,
                // Wi-Fi drop with no TCP FIN). Without a tight read timeout the
                // socket can hang ~tens of seconds before the badge flips to
                // offline. With pings every 2s + a 5s read timeout, a silent
                // death surfaces within ~5s.
                config {
                    pingInterval(java.time.Duration.ofSeconds(2))
                    readTimeout(java.time.Duration.ofSeconds(5))
                    connectTimeout(java.time.Duration.ofSeconds(5))
                    callTimeout(java.time.Duration.ofSeconds(0))  // 0 = no overall cap (WS is long-lived)
                }
            }
        }
    }

    private val json = Json {
        ignoreUnknownKeys = false
        isLenient = false
        // HelloBody.protos default = [0]; if encodeDefaults is off the body
        // sees {"protos": []} and rejects with BAD_VERSION.
        encodeDefaults = true
    }

    private var session: WebSocketSession? = null
    private var loopJob: Job? = null
    private var heartbeatJob: Job? = null
    private val sendMutex = Mutex()

    /** Wall-clock of the most recent setTarget/setState. Used to gate heartbeat cadence. */
    @Volatile private var lastIntentChangeMs: Long = 0L

    /** Outstanding `set_target` request ids → parts the brain expects to ack. */
    private val pendingAcks = java.util.concurrent.ConcurrentHashMap<String, PendingAck>()
    private data class PendingAck(val parts: Set<String>, val deadlineMs: Long)
    private val ackSeq = java.util.concurrent.atomic.AtomicInteger(0)

    /** No-ack timeout per DESIGN.md §3.2 (recommended 500 ms). */
    private val ackTimeoutMs = 500L

    /** Start the connect-and-read loop. Idempotent; subsequent calls are no-ops. */
    fun start() {
        if (loopJob?.isActive == true) return
        loopJob = scope.launch {
            var backoffMs = 1_000L
            while (isActive) {
                try {
                    runSession()
                    backoffMs = 1_000L
                } catch (t: Throwable) {
                    Timber.w(t, "bodylink session ended: ${t.message}")
                    _connected.value = false
                }
                delay(backoffMs)
                backoffMs = (backoffMs * 2).coerceAtMost(30_000L)
            }
        }
        if (heartbeatJob?.isActive != true) {
            heartbeatJob = scope.launch { heartbeatLoop() }
        }
    }

    fun stop() {
        loopJob?.cancel(); loopJob = null
        heartbeatJob?.cancel(); heartbeatJob = null
        scope.launch {
            try { session?.close() } catch (_: Throwable) {}
            session = null
            _connected.value = false
        }
    }

    /**
     * Retarget to a new host at runtime. Tears down the current session +
     * loops, swaps the host, and restarts the connect loop. The UI calls
     * this from the connect dialog.
     */
    fun reconnect(newHost: String) {
        Timber.i("bodylink retarget → $newHost")
        host = newHost.trim()
        // Cancel current loops + session, then restart cleanly.
        loopJob?.cancel(); loopJob = null
        heartbeatJob?.cancel(); heartbeatJob = null
        scope.launch {
            try { session?.close() } catch (_: Throwable) {}
            session = null
            _connected.value = false
            _profile.value = null
            start()
        }
    }

    private suspend fun runSession() {
        val url = when {
            host.startsWith("ws://") || host.startsWith("wss://") -> host
            else -> "ws://$host/"
        }
        Timber.i("bodylink connecting to $url")

        val s = client.webSocketSession(url)
        session = s
        try {
            sendEnvelope(s, "hello", json.encodeToJsonElement(HelloBody.serializer(), HelloBody()))

            var gotWelcome = false
            var gotProfile = false
            while (!(gotWelcome && gotProfile)) {
                val raw = s.incoming.receive() as? Frame.Text
                    ?: error("unexpected non-text frame during handshake")
                val env = json.decodeFromString(BodyEnvelope.serializer(), raw.readText())
                when (env.type) {
                    "welcome" -> {
                        val w = json.decodeFromJsonElement(WelcomeBody.serializer(), env.body)
                        Timber.i("welcome: ${w.name} (${w.deviceId}, fw ${w.fwVersion}, proto ${w.proto})")
                        gotWelcome = true
                    }
                    "profile" -> {
                        val p = json.decodeFromJsonElement(ProfileBody.serializer(), env.body)
                        val parsed = BodyProfile.fromWire(p)
                        _profile.value = parsed
                        validatedCatalog = catalog.validatedAgainst(parsed)
                        Timber.i("profile: parts=${p.parts.keys.toList()}")
                        gotProfile = true
                    }
                    "error" -> {
                        val e = json.decodeFromJsonElement(ErrorBody.serializer(), env.body)
                        if (e.fatal) error("fatal during handshake: ${e.code}: ${e.message}")
                        Timber.w("non-fatal error during handshake: ${e.code}: ${e.message}")
                    }
                    else -> handleMessage(env)
                }
            }
            _connected.value = true
            // Handshake fully succeeded — record this host as a working one.
            try { onConnected?.invoke(host) } catch (_: Throwable) {}

            for (frame in s.incoming) {
                if (frame !is Frame.Text) continue
                val env = try {
                    json.decodeFromString(BodyEnvelope.serializer(), frame.readText())
                } catch (t: Throwable) {
                    emitDrift("malformed envelope: ${t.message}")
                    continue
                }
                handleMessage(env)
            }
        } finally {
            _connected.value = false
            try { s.close() } catch (_: Throwable) {}
            session = null
        }
    }

    private suspend fun handleMessage(env: BodyEnvelope) {
        when (env.type) {
            "event" -> decodeAndEmitEvent(env)
            "echo_reply" -> { /* not surfaced yet */ }
            "snapshot_done" -> { /* debug-only */ }
            "applied" -> handleApplied(env)
            "welcome" -> { /* mid-stream welcome — ignore */ }
            "profile" -> {
                try {
                    val p = json.decodeFromJsonElement(ProfileBody.serializer(), env.body)
                    val parsed = BodyProfile.fromWire(p)
                    _profile.value = parsed
                    validatedCatalog = catalog.validatedAgainst(parsed)
                } catch (t: Throwable) { emitDrift("bad re-sent profile: ${t.message}") }
            }
            "state" -> {
                // Legacy protocol — body should not send these. Log + drop.
                Timber.w("legacy 'state' frame received; dropping")
            }
            "error" -> {
                val e = try {
                    json.decodeFromJsonElement(ErrorBody.serializer(), env.body)
                } catch (_: Throwable) { null }
                if (e != null) {
                    Timber.w("body error ${e.code}: ${e.message}")
                    // OUT_OF_RANGE is also surfaced via event:clipped; we
                    // additionally emit BodyEvent.OutOfRange so tool error
                    // handlers can match on either.
                    if (e.code == "OUT_OF_RANGE") {
                        // body.message is "neck.pulse_width_us=9999 clipped to 2500" — parse loosely
                        emitOutOfRangeFromMessage(e.message)
                    } else if (e.code == "UNKNOWN_PART") {
                        // best-effort: extract the offending part from the message
                        _events.emit(BodyEvent.UnknownPart(e.message.substringAfter(":").trim().trim('\'', '"')))
                    } else if (e.code == "UNKNOWN_PARAM") {
                        // message shape: "part 'foo' has no param 'bar'"
                        val parts = Regex("'([^']+)'").findAll(e.message).map { it.groupValues[1] }.toList()
                        if (parts.size >= 2) _events.emit(BodyEvent.UnknownParam(parts[0], parts[1]))
                    }
                    if (e.fatal) error("fatal: ${e.code}: ${e.message}")
                }
            }
            else -> {
                val detail = "unknown message type: ${env.type}"
                emitDrift(detail)
                session?.let { s ->
                    try { sendError(s, "UNKNOWN_TYPE", detail, false) } catch (_: Throwable) {}
                }
            }
        }
    }

    private fun handleApplied(env: BodyEnvelope) {
        val id = env.id ?: return  // no correlation — nothing to resolve
        val pending = pendingAcks.remove(id) ?: return
        val applied = try {
            json.decodeFromJsonElement(AppliedBody.serializer(), env.body)
        } catch (_: Throwable) { return }
        val newPhase = if (applied.status == "applied") PartIntent.Phase.Moving
                       else PartIntent.Phase.Rejected
        _intent.update { current: BodyIntent ->
            val next: MutableMap<String, PartIntent> = current.parts.toMutableMap()
            for (partName in pending.parts) {
                val pi = next[partName] ?: continue
                next[partName] = pi.copy(phase = newPhase)
            }
            BodyIntent(next)
        }
        Timber.d("applied ack id=$id parts=${pending.parts} status=${applied.status}")
    }

    private suspend fun emitOutOfRangeFromMessage(msg: String) {
        // Best-effort parse: "neck.pulse_width_us=9999 clipped to 2500"
        val m = Regex("""([\w.]+)\.([\w_]+)=([-+]?[\d.]+)\s+clipped to\s+([-+]?[\d.]+)""").find(msg)
        if (m != null) {
            val (part, param, req, app) = m.destructured
            _events.emit(BodyEvent.OutOfRange(part, param, req.toDouble(), app.toDouble()))
        }
    }

    private suspend fun decodeAndEmitEvent(env: BodyEnvelope) {
        val e = try {
            json.decodeFromJsonElement(EventBody.serializer(), env.body)
        } catch (t: Throwable) { emitDrift("bad event payload: ${t.message}"); return }
        val mapped: BodyEvent? = when (e.kind) {
            "boot" -> BodyEvent.Boot
            "clipped" -> BodyEvent.Clipped(
                part = e.part.orEmpty(),
                param = e.param.orEmpty(),
                requested = (e.requested as? JsonPrimitive)?.doubleOrNull ?: 0.0,
                applied = (e.applied as? JsonPrimitive)?.doubleOrNull ?: 0.0,
            )
            "stall" -> BodyEvent.Stall(e.part.orEmpty())
            "estop" -> BodyEvent.Estop(e.source.orEmpty())
            "settled" -> null
            else -> { emitDrift("unknown event kind: ${e.kind}"); null }
        }
        if (mapped != null) _events.emit(mapped)
    }

    private suspend fun emitDrift(detail: String) {
        Timber.w("protocol drift: $detail")
        _events.emit(BodyEvent.ProtocolDrift(detail))
    }

    // ── Commands (Brain → Body) ──────────────────────────────────────────

    /**
     * Resolve `(part, stateName)` via the brain-side catalog and send a
     * single-part `set_target`. If the catalog doesn't know the state,
     * emits a warning event and returns.
     */
    override suspend fun setState(part: String, stateName: String) {
        val cat = validatedCatalog
        val cmd = cat.resolve(part, stateName) ?: run {
            Timber.w("setState($part, $stateName): not in catalog (known: ${cat.statesOf(part)})")
            _events.emit(BodyEvent.ProtocolDrift("catalog miss: $part/$stateName"))
            return
        }
        setTarget(mapOf(part to cmd.params), cmd.durationMs, stateName = stateName)
    }

    /**
     * Lower-level: brain has already resolved primitive params.
     * `parts[<partName>]` is a `{paramName: value}` map. If `durationMs` is
     * non-null it's added to every part's payload (and recorded in intent).
     *
     * Returns the request `id` so callers can correlate against the
     * `applied` ack (DESIGN.md §3.2). Heartbeat resends use `correlate=false`
     * so the body doesn't ack them (it wouldn't anyway — they're no-ops).
     */
    suspend fun setTarget(
        parts: Map<String, Map<String, Double>>,
        durationMs: Int? = null,
        stateName: String? = null,
        correlate: Boolean = true,
    ): String? {
        if (parts.isEmpty()) return null

        // Brain-side idempotency check, matching the body's behaviour
        // (DESIGN.md §3.1 step 4). If every part already has these exact
        // params as current intent AND is in a healthy phase (Moving or
        // Settled), the body will silently no-op. Sending with a correlated
        // `id` would then yield NO_ACK after 500 ms — a false negative.
        //
        // For each part, classify:
        //   - "same"   = params unchanged AND current phase is Moving|Settled.
        //                The body will no-op. Don't touch the intent's sentAt
        //                so the UI doesn't restart its progress bar; just
        //                snap to Settled if it isn't already.
        //   - "changed"= params differ OR part wasn't being tracked.
        //                Must update intent + wait for ack.
        val current = _intent.value.parts
        val changedParts = mutableMapOf<String, Map<String, Double>>()
        val sameParts = mutableSetOf<String>()
        for ((partName, params) in parts) {
            val existing = current[partName]
            val sameTarget = existing != null
                    && existing.params == params
                    && (existing.phase == PartIntent.Phase.Moving
                        || existing.phase == PartIntent.Phase.Settled)
            if (sameTarget) sameParts.add(partName) else changedParts[partName] = params
        }

        // Snap "same" parts to Settled in the UI (the body has already settled
        // there; the user just reaffirmed). No wire traffic, no pending ack.
        if (sameParts.isNotEmpty()) {
            _intent.update { c: BodyIntent ->
                val next: MutableMap<String, PartIntent> = c.parts.toMutableMap()
                for (p in sameParts) {
                    val pi = next[p] ?: continue
                    next[p] = pi.copy(phase = PartIntent.Phase.Settled)
                }
                BodyIntent(next)
            }
            Timber.d("setTarget: parts $sameParts already at target — no-op (no wire send)")
        }

        if (changedParts.isEmpty()) {
            // Everything was a no-op — nothing to send, nothing to correlate.
            return null
        }

        val now = System.currentTimeMillis()
        val nextPartIntents = _intent.value.parts.toMutableMap()
        val wirePayload = buildJsonObject {
            putJsonObject("parts") {
                for ((partName, params) in changedParts) {
                    putJsonObject(partName) {
                        for ((k, v) in params) {
                            if (v == v.toLong().toDouble()) put(k, v.toLong()) else put(k, v)
                        }
                        if (durationMs != null && "duration_ms" !in params) {
                            put("duration_ms", durationMs)
                        }
                    }
                    nextPartIntents[partName] = PartIntent(
                        stateName = stateName,
                        params = params,
                        sentAt = now,
                        durationMs = durationMs ?: (params["duration_ms"]?.toInt() ?: 400),
                        phase = if (correlate) PartIntent.Phase.Waiting
                                else PartIntent.Phase.Moving,  // heartbeat: assume moving
                    )
                }
            }
        }
        _intent.value = BodyIntent(nextPartIntents)
        lastIntentChangeMs = now

        val id = if (correlate) "st-${ackSeq.incrementAndGet()}" else null
        if (id != null) {
            pendingAcks[id] = PendingAck(changedParts.keys.toSet(), now + ackTimeoutMs)
        }

        val s = session ?: run {
            Timber.w("setTarget: not connected — intent updated locally, will resync on reconnect")
            return id
        }
        sendEnvelope(s, "set_target", wirePayload, id = id)
        return id
    }

    /**
     * Periodic heartbeat. While connected with a non-empty intent, re-send
     * `set_target` so that:
     *   - the body is robust to dropped frames (it just gets the same intent again)
     *   - a body that restarted lands back where we expect it
     *   - we have application-level liveness in addition to WS ping
     *
     * Body is per-part idempotent — repeating the same payload does NOT
     * restart motion or twitch servos.
     */
    private suspend fun heartbeatLoop() {
        while (scope.isActive) {
            try {
                val s = session
                val current = _intent.value
                if (s != null && _connected.value && current.parts.isNotEmpty()) {
                    val wirePayload = buildJsonObject {
                        putJsonObject("parts") {
                            for ((partName, partIntent) in current.parts) {
                                putJsonObject(partName) {
                                    for ((k, v) in partIntent.params) {
                                        if (v == v.toLong().toDouble()) put(k, v.toLong())
                                        else put(k, v)
                                    }
                                    // Heartbeat resends: send duration_ms only if the
                                    // body needs to re-plan a transition. For
                                    // idempotency we omit it — body sees same params,
                                    // no-op.
                                }
                            }
                        }
                    }
                    // Heartbeat: no id, no correlation; body won't ack idempotent resends.
                    sendEnvelope(s, "set_target", wirePayload, id = null)
                }
            } catch (t: Throwable) {
                Timber.v("heartbeat skipped: ${t.message}")
            }
            // Promote Moving → Settled once the motion duration has elapsed.
            // Body doesn't tell us (no state stream); we just compute it.
            run {
                val now2 = System.currentTimeMillis()
                _intent.update { c: BodyIntent ->
                    var dirty = false
                    val next: MutableMap<String, PartIntent> = c.parts.toMutableMap()
                    for ((p, pi) in c.parts) {
                        if (pi.phase == PartIntent.Phase.Moving && pi.settled) {
                            next[p] = pi.copy(phase = PartIntent.Phase.Settled)
                            dirty = true
                        }
                    }
                    if (dirty) BodyIntent(next) else c
                }
            }
            // Sweep pending acks past their deadline → NoAck.
            val now = System.currentTimeMillis()
            val expired = pendingAcks.entries.filter { it.value.deadlineMs <= now }.map { it.key }
            if (expired.isNotEmpty()) {
                for (eid in expired) {
                    val pa = pendingAcks.remove(eid) ?: continue
                    _intent.update { current: BodyIntent ->
                        val next: MutableMap<String, PartIntent> = current.parts.toMutableMap()
                        for (p in pa.parts) {
                            val pi = next[p] ?: continue
                            if (pi.phase == PartIntent.Phase.Waiting) {
                                next[p] = pi.copy(phase = PartIntent.Phase.NoAck)
                            }
                        }
                        BodyIntent(next)
                    }
                    Timber.w("ack timeout id=$eid parts=${pa.parts}")
                }
            }
            // Active: <500ms since last intent change → tick faster.
            val active = (System.currentTimeMillis() - lastIntentChangeMs) < 500L
            delay(if (active) 100L else 1_000L)
        }
    }

    private suspend fun sendError(
        s: WebSocketSession,
        code: String,
        message: String,
        fatal: Boolean,
    ) {
        val payload = buildJsonObject {
            put("code", code)
            put("message", message)
            put("fatal", fatal)
        }
        sendEnvelope(s, "error", payload, id = null)
    }

    private suspend fun sendEnvelope(
        s: WebSocketSession,
        type: String,
        payloadJson: JsonElement,
        id: String? = null,
    ) {
        val envObj = buildJsonObject {
            put("v", BODYLINK_PROTOCOL_VERSION)
            put("type", type)
            if (id != null) put("id", id)
            put("ts", System.currentTimeMillis())
            put("body", payloadJson)
        }
        val msg = json.encodeToString(JsonElement.serializer(), envObj)
        sendMutex.withLock { s.send(msg) }
    }
}

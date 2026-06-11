package dev.orbit.dock.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.orbit.dock.BuildConfig
import dev.orbit.dock.agent.AgentState
import dev.orbit.dock.agent.DockAgent
import dev.orbit.dock.agent.DockTools
import dev.orbit.dock.body.BodyIntent
import dev.orbit.dock.body.BodyLinkComms
import dev.orbit.dock.body.BodyStateCatalog
import dev.orbit.dock.body.ui.BodyBadge
import dev.orbit.dock.perception.FaceTracker
import dev.orbit.dock.perception.PerceptionBus
import dev.orbit.dock.perception.PerceptionEvent
import dev.orbit.dock.service.PerceptionService
import dev.orbit.dock.tts.DockTts
import dev.orbit.dock.ui.devbar.DevBarHost
import dev.orbit.dock.ui.face.FaceController
import dev.orbit.dock.ui.face.FaceRenderer
import dev.orbit.dock.ui.face.FaceState
import dev.orbit.dock.ui.face.PerceptionWiring
import dev.orbit.dock.ui.perm.rememberPermissions
import dev.orbit.dock.ui.status.StatusBar
import androidx.compose.foundation.layout.width
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.lifecycle.compose.LocalLifecycleOwner
import timber.log.Timber

@Composable
fun DockScreen() {
    val ctx = LocalContext.current
    val controller = remember { FaceController() }
    val scope = rememberCoroutineScope()
    var botSubtitle by remember { mutableStateOf("") }
    // construction order: agent depends on tools+tts; tts callback updates agent state.
    val agentRef = remember { object { var value: DockAgent? = null } }
    // Forward ref: tools is built before wiring but needs to clear the transcript
    // on turn-settle (action-only turns must not leave the user's words on screen).
    val wiringRef = remember { object { var value: PerceptionWiring? = null } }
    val tts = remember {
        DockTts(ctx, controller, onSpeakingChanged = { speaking ->
            agentRef.value?.setSpeaking(speaking)
            // Echo gate: tell the pipeline the dock is/ isn't speaking so STT
            // pauses while talking (no hearing itself) and auto-resumes after
            // — but only if a tap-listening session is still active. This is
            // what gives "talk → I reply → it keeps listening for your next
            // thing" without the dock transcribing its own voice.
            PerceptionBus.emit(PerceptionEvent.Speaking(active = speaking))
        })
    }
    // BodyLink host history (last 5 successful connects, persisted).
    val hostStore = remember { dev.orbit.dock.body.BodyHostStore(ctx) }
    // Station-synced config (faceGestures, bodyAddr, …). Resolves baked-default
    // ← persisted ← live station pushes; works fully offline. Shared by
    // DockTools (gestures), StationLink (feeds pushes), and the body host below.
    val configCache = remember { dev.orbit.dock.config.ConfigCache(ctx) }
    // BodyLink client. Initial host, highest-trust first:
    //   1. dock.bodyAddr from config (station tells us where the body is — the
    //      station learns it each time the body connects; cached/baked offline)
    //   2. last successful host from local history
    //   3. compile-time BODY_HOST default
    //   4. a sensible literal so the badge is always live
    val bodyComms = remember {
        val initialHost = configCache.string("bodyAddr", "").takeIf { it.isNotBlank() }
            ?: hostStore.lastHost()
            ?: BuildConfig.BODY_HOST.takeIf { it.isNotBlank() }
            ?: "192.168.1.10:17317"
        val catalog = BodyStateCatalog.load(ctx)
        BodyLinkComms(
            host = initialHost,
            scope = scope,
            catalog = catalog,
            onConnected = { h -> hostStore.recordSuccess(h) },
        )
    }
    // When the station pushes a new body address (the body reconnected at a new
    // IP), retarget the BodyLink to it. Registered once.
    LaunchedEffect(configCache, bodyComms) {
        configCache.onChange { key ->
            if (key == "bodyAddr") {
                val addr = configCache.string("bodyAddr", "")
                if (addr.isNotBlank() && addr != bodyComms.currentHost) {
                    timber.log.Timber.i("config: body address changed → reconnecting BodyLink to $addr")
                    bodyComms.reconnect(addr)
                }
            }
        }
    }
    var showConnectDialog by remember { mutableStateOf(false) }
    // Live senses shared between perception (writer) and the agent (reader) so
    // the LLM knows what the camera actually sees this turn.
    val perception = remember { dev.orbit.dock.agent.PerceptionSnapshot() }
    // Face tracker doubles as the camera-frame source for vision turns. Created
    // here (before the agent) so the agent can pull the latest frame each turn.
    val faceTracker = remember { FaceTracker(ctx) }
    if (BuildConfig.DEBUG) {
        dev.orbit.dock.perception.CameraFrameProvider.debugInstance = faceTracker
    }
    // Forward ref so DockTools' remember_face can publish via the station link
    // (the link is built below, after the tools).
    val stationLinkRef = remember { mutableStateOf<dev.orbit.dock.station.StationLink?>(null) }
    // In-flight recollect_face requests: reqId → deferred result, resolved by the
    // inbound `recognize-result` frame.
    val pendingRecognize = remember { java.util.concurrent.ConcurrentHashMap<String, kotlinx.coroutines.CompletableDeferred<dev.orbit.dock.agent.RecognizeOutcome>>() }
    val tools = remember(controller, tts, bodyComms, configCache) {
        DockTools(
            controller,
            tts,
            onSubtitle = { botSubtitle = it },
            onToolCall = { name -> agentRef.value?.setToolCalling(name) },
            body = bodyComms,
            perception = perception,
            onTurnSettled = { wiringRef.value?.clearTranscript() },
            config = configCache,
            // remember_face → ask the station to enroll the on-camera face.
            onEnrollRequest = { name ->
                stationLinkRef.value?.publish(
                    "perception", "enroll-request",
                    kotlinx.serialization.json.buildJsonObject {
                        put("name", kotlinx.serialization.json.JsonPrimitive(name))
                    },
                )
            },
            // recollect_face → fresh server recognition: publish a request with a
            // reqId, await the matching recognize-result (≤1s), else null (→ hint).
            onRecognizeRequest = {
                val link = stationLinkRef.value
                if (link == null) null else {
                    val reqId = java.util.UUID.randomUUID().toString()
                    val deferred = kotlinx.coroutines.CompletableDeferred<dev.orbit.dock.agent.RecognizeOutcome>()
                    pendingRecognize[reqId] = deferred
                    link.publish("perception", "recognize-request",
                        kotlinx.serialization.json.buildJsonObject {
                            put("reqId", kotlinx.serialization.json.JsonPrimitive(reqId))
                        })
                    val result = kotlinx.coroutines.withTimeoutOrNull(1200) { deferred.await() }
                    pendingRecognize.remove(reqId)
                    result
                }
            },
            // confirm_face → tell the station the user confirmed a tentative guess
            // (append the current frame as more training data).
            onConfirmRequest = { name ->
                stationLinkRef.value?.publish(
                    "perception", "confirm-request",
                    kotlinx.serialization.json.buildJsonObject {
                        put("name", kotlinx.serialization.json.JsonPrimitive(name))
                    })
            },
            // forget_face → tell the station to drop the wrong name.
            onForgetRequest = { name ->
                stationLinkRef.value?.publish(
                    "perception", "forget-request",
                    kotlinx.serialization.json.buildJsonObject {
                        put("name", kotlinx.serialization.json.JsonPrimitive(name))
                    })
            },
        ).also { dev.orbit.dock.agent.ToolsTestController.tools = it }
    }
    // Runtime model selection (persisted). Changing it rebuilds the agent so the
    // new transport/model takes effect immediately; default comes from the build.
    val modelStore = remember { dev.orbit.dock.agent.ModelStore(ctx) }
    var selectedModel by remember { mutableStateOf(modelStore.selected()) }
    // OTA self-update (docs/OTA.md §5). Holds a forward ref so onOtaOffer below
    // can hand offers to it; the updater publishes progress/result back via the
    // station link. Silent install when the app is device-owner, else a system
    // confirm dialog.
    val otaUpdaterRef = remember { mutableStateOf<dev.orbit.dock.ota.OtaUpdater?>(null) }
    // Live A/V streamer (WebRTC → station SFU). Forward ref so the station link's
    // onMediaFrame can route signaling answers/ICE into it; it's built after the
    // link (publishes via the link).
    val mediaStreamerRef = remember { mutableStateOf<dev.orbit.dock.perception.MediaStreamer?>(null) }
    // Optional orbit-station link (observability + presence). Empty STATION_URL
    // → disabled; the dock is fully functional without it.
    val stationLink = remember {
        dev.orbit.dock.station.StationLink(
            url = BuildConfig.STATION_URL,
            dock = BuildConfig.DOCK_NAME,
            appId = "${BuildConfig.DOCK_NAME}-app",
            scope = scope,
            build = BuildConfig.VERSION_CODE,
            // report our own links so the station knows the full mesh.
            linkStatus = {
                dev.orbit.dock.station.AppLinks(
                    bodyConnected = bodyComms.connected.value,
                    llmReachable = selectedModel.baseUrl.isNotBlank(),
                )
            },
            // feed flat config pushes/snapshots into the cache.
            onConfigFrame = { payload ->
                val key = (payload["key"] as? kotlinx.serialization.json.JsonPrimitive)?.content
                val value = payload["value"]
                val lastUpdated = (payload["lastUpdated"] as? kotlinx.serialization.json.JsonPrimitive)?.content?.toLongOrNull()
                if (key != null && value != null && lastUpdated != null) {
                    configCache.apply(key, value, lastUpdated)
                }
            },
            // announce the keys we care about; the station pushes only these.
            configInterest = dev.orbit.dock.config.ConfigCache.INTEREST,
            // hand `ota/available` offers to the updater (downloads + installs).
            onOtaOffer = { payload ->
                val p = { k: String -> (payload[k] as? kotlinx.serialization.json.JsonPrimitive) }
                otaUpdaterRef.value?.onOffer(
                    target = p("target")?.content,
                    build = p("build")?.content?.toIntOrNull(),
                    url = p("url")?.content,
                    sha256 = p("sha256")?.content,
                )
            },
            // route WebRTC signaling (producer-answer / producer-ice) to the streamer.
            onMediaFrame = { kind, payload -> mediaStreamerRef.value?.onMediaFrame(kind, payload) },
            // station stream-processing results → PerceptionBus → agent re-grounds.
            // payload is the PerceptionResult envelope { kind, payload: {...}, confidence }.
            onPerceptionFrame = { kind, envelope ->
                val inner = envelope["payload"] as? kotlinx.serialization.json.JsonObject
                val conf = (envelope["confidence"] as? kotlinx.serialization.json.JsonPrimitive)
                    ?.content?.toFloatOrNull() ?: 0f
                fun prim(o: kotlinx.serialization.json.JsonObject?, k: String) =
                    o?.get(k) as? kotlinx.serialization.json.JsonPrimitive
                val event = when (kind) {
                    "identity" -> {
                        val name = prim(inner, "name")?.takeIf { it.isString }?.content
                        dev.orbit.dock.perception.PerceptionEvent.UserIdentified(name, conf)
                    }
                    "presence" -> {
                        val present = prim(inner, "present")?.content?.toBooleanStrictOrNull() ?: false
                        dev.orbit.dock.perception.PerceptionEvent.RemotePresence(present)
                    }
                    // Reconnect snapshot: the whole DockWorldState is the payload
                    // (no inner wrapper). Re-ground identity + presence from it.
                    "snapshot" -> {
                        val present = prim(envelope, "present")?.content?.toBooleanStrictOrNull() ?: false
                        val idObj = envelope["identity"] as? kotlinx.serialization.json.JsonObject
                        val name = prim(idObj, "name")?.takeIf { it.isString }?.content
                        dev.orbit.dock.perception.PerceptionBus.emit(
                            dev.orbit.dock.perception.PerceptionEvent.RemotePresence(present))
                        if (name != null)
                            dev.orbit.dock.perception.PerceptionEvent.UserIdentified(name, 0f)
                        else null
                    }
                    // enroll-result: surface a short confirmation/spoken line.
                    "enroll-result" -> {
                        val ok = prim(envelope, "ok")?.content?.toBooleanStrictOrNull() ?: false
                        val nm = prim(envelope, "name")?.content
                        val reason = prim(envelope, "reason")?.content
                        Timber.i("enroll-result: ok=$ok name=$nm reason=$reason")
                        null
                    }
                    // recognize-result: fresh recollect_face answer → resolve the
                    // pending request so the suspended tool returns.
                    "recognize-result" -> {
                        val reqId = prim(envelope, "reqId")?.content
                        val name = prim(envelope, "name")?.takeIf { it.isString }?.content
                        val tentative = prim(envelope, "tentative")?.takeIf { it.isString }?.content
                        val conf = prim(envelope, "confidence")?.content?.toFloatOrNull() ?: 0f
                        val noFace = prim(envelope, "noFace")?.content?.toBooleanStrictOrNull() ?: false
                        val outcome = dev.orbit.dock.agent.RecognizeOutcome(name, tentative, conf, noFace)
                        // Cache a confident result (also feeds the background STT trigger).
                        if (name != null) perception.onIdentity(name, conf)
                        reqId?.let { pendingRecognize.remove(it) }?.complete(outcome)
                        null
                    }
                    else -> null
                }
                event?.let { dev.orbit.dock.perception.PerceptionBus.emit(it) }
            },
        ).also { it.start(); stationLinkRef.value = it }
    }
    // The live A/V streamer. Publishes producer-offer/ICE via the station link.
    val mediaStreamer = remember {
        dev.orbit.dock.perception.MediaStreamer(
            context = ctx,
            faceTracker = faceTracker,
            label = BuildConfig.DOCK_NAME,
            publish = { kind, payload -> stationLink.publish("media", kind, payload) },
        ).also { mediaStreamerRef.value = it }
    }
    // Build the updater now that the link exists (it publishes via the link).
    val otaUpdater = remember {
        dev.orbit.dock.ota.OtaUpdater(
            context = ctx,
            currentVersionCode = BuildConfig.VERSION_CODE,
            publish = { kind, payload -> stationLink.publish("ota", kind, payload) },
        ).also { otaUpdaterRef.value = it }
    }
    // Surface confirm-dialog / failure results from PackageInstaller.
    DisposableEffect(otaUpdater) {
        val unregister = otaUpdater.registerInstallResultReceiver()
        onDispose { unregister() }
    }
    val agent = remember(tools, selectedModel) {
        DockAgent(
            tools,
            baseUrl = selectedModel.baseUrl,
            model = selectedModel.model,
            api = selectedModel.api,
            visionEnabled = selectedModel.vision,
            cameraFrame = faceTracker,
            stationLink = stationLink,
        ).also { agentRef.value = it }
    }

    // Debug-only test harness: register the adb-broadcast receiver so the
    // interaction flow can be driven/validated via `adb shell am broadcast`
    // (Compose tap injection is unreliable). Reflective lookup keeps this out
    // of release builds (the class only exists in src/debug).
    if (BuildConfig.DEBUG) {
        LaunchedEffect(Unit) {
            runCatching {
                val cls = Class.forName("dev.orbit.dock.debug.DebugTestReceiver")
                val instance = cls.getField("INSTANCE").get(null)
                cls.getDeclaredMethod("register", android.content.Context::class.java)
                    .invoke(instance, ctx)
            }
        }
    }

    // Start the BodyLink session lifecycle.
    DisposableEffect(bodyComms) {
        dev.orbit.dock.body.ui.BodyTestController.comms = bodyComms
        bodyComms.start()
        onDispose {
            bodyComms.stop()
            dev.orbit.dock.body.ui.BodyTestController.comms = null
        }
    }
    val bodyConnected by bodyComms.connected.collectAsState()
    val stationConnected by stationLink.connected.collectAsState()
    // perception models warming up on cold start (wake-word/VAD/STT). Until
    // ready, the dock can't hear — show a brief "waking up" hint.
    val perceptionReady by dev.orbit.dock.perception.PerceptionReady.ready.collectAsState()
    val bodyIntent by bodyComms.intent.collectAsState()
    val agentState by agent.state.collectAsState()
    val wiring = remember(controller, agent) {
        PerceptionWiring(
            controller = controller,
            onUserUtterance = { text -> agent.respond(text) },
            onWake = { botSubtitle = "" },
            perception = perception,
        ).also { wiringRef.value = it }
    }

    DisposableEffect(Unit) {
        onDispose {
            agent.shutdown()
            tts.shutdown()
        }
    }

    LaunchedEffect(Unit) { wiring.attach(scope) }

    // Background, NON-BLOCKING recollect on STT start: when listening arms and a
    // face is visible (on-device), fire one recognize-request so the cache is
    // fresh by the time the user finishes speaking. Fire-and-forget — the turn
    // never waits; the async recognize-result updates the snapshot cache.
    LaunchedEffect(Unit) {
        dev.orbit.dock.perception.PerceptionBus.events.collect { ev ->
            if (ev is dev.orbit.dock.perception.PerceptionEvent.SttListening && ev.armed &&
                perception.facts.facePresent
            ) {
                stationLinkRef.value?.publish(
                    "perception", "recognize-request",
                    kotlinx.serialization.json.buildJsonObject {
                        put("reqId", kotlinx.serialization.json.JsonPrimitive("stt-${System.currentTimeMillis()}"))
                    },
                )
            }
        }
    }

    // Start the live A/V stream once the station is connected AND perception is
    // warm (mic ADM up, so WebRtcAudio.sharedFactory has its audio device module).
    // Retry a few times: the ADM can lag perceptionReady by a beat, and start()
    // is idempotent + bails (logs) if the factory isn't up yet. Tearing down on
    // dispose; the shared factory/ADM stay owned by WebRtcAudio.
    LaunchedEffect(stationConnected, perceptionReady) {
        if (stationConnected && perceptionReady) {
            repeat(10) {
                if (mediaStreamer.isStreaming()) return@LaunchedEffect
                mediaStreamer.start()
                kotlinx.coroutines.delay(500)
            }
        }
    }
    DisposableEffect(Unit) { onDispose { mediaStreamer.stop() } }

    val state by controller.state.collectAsState()
    val gaze by controller.gaze.collectAsState()
    val expression by controller.expression.collectAsState()
    val speaker by controller.speaker.collectAsState()
    val privacy by controller.privacy.collectAsState()
    val micMuted by controller.micMuted.collectAsState()
    val camMuted by controller.camMuted.collectAsState()
    val audioLevel by wiring.audioLevel.collectAsState()
    val pipelineStatus by wiring.pipelineStatus.collectAsState()
    val transcript by wiring.transcript.collectAsState()

    val facePresent by wiring.facePresent.collectAsState()
    val sttArmed by wiring.sttArmed.collectAsState()

    // Badge: the last recognized person (from the snapshot cache, updated by
    // recollect / the STT-trigger). Polled so it reflects the single source of
    // truth. Shows "guru" when a face is present, "guru (away)" when remembered
    // but no face now.
    var seenName by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(Unit) {
        while (true) {
            val f = perception.facts
            seenName = f.identity?.let { if (f.facePresent) it else "$it (away)" }
            kotlinx.coroutines.delay(500)
        }
    }

    val perms = rememberPermissions()
    val micGranted = perms.mic
    val camGranted = perms.camera

    // Ground-truth mic state from Android (actual OS recording sessions), not our
    // own model — so the badge is honest about whether the mic is really live.
    val micLiveState = remember { dev.orbit.dock.perception.MicLiveState(ctx) }
    val micLive by micLiveState.live.collectAsState()
    DisposableEffect(Unit) {
        micLiveState.start()
        onDispose { micLiveState.stop() }
    }

    LaunchedEffect(micGranted, micMuted) {
        if (micGranted && !micMuted) PerceptionService.start(ctx)
        else PerceptionService.stop(ctx)
    }

    // Face tracker — bound to the activity lifecycle (created above as the
    // camera-frame source for the agent).
    val lifecycleOwner = LocalLifecycleOwner.current
    DisposableEffect(camGranted, camMuted) {
        if (camGranted && !camMuted) {
            faceTracker.start(lifecycleOwner)
        }
        onDispose { faceTracker.stop() }
    }

    // Barge-in: cut the dock's speech + current turn and immediately start a
    // fresh listening session so the user can talk over it. Shared by the
    // tap-during-speech gesture and the voice-triggered BargeIn event (VAD
    // firing during TTS on echo-cancelled audio).
    //
    // Emit WakeWord FIRST: it opens a fresh listening session (via
    // AutoRelisten.onSessionStarted, clearing any pending voice-turn re-arm) so
    // the trailing Speaking(false) from tts.stop() can't fire a second, racing
    // re-arm. The pipeline's WakeWord handler then stops TTS and waits for the
    // audio route to settle before arming STT (see BARGE_IN_SETTLE_MS) — arming
    // too early, while TTS is still tearing down, gives SR a dead mic.
    val bargeIn = remember {
        {
            PerceptionBus.emit(PerceptionEvent.WakeWord(label = "(barge-in)"))
            tts.stop()
            agentRef.value?.stop()
            PerceptionBus.emit(PerceptionEvent.Speaking(active = false))
        }
    }

    // Voice barge-in: the pipeline emits BargeIn when the user speaks during TTS.
    LaunchedEffect(Unit) {
        PerceptionBus.events.collect { event ->
            if (event is PerceptionEvent.BargeIn) bargeIn()
        }
    }

    // Debug AEC self-test: speak a known phrase out loud and measure whether the
    // mic hears it (echo leaked) or not (AEC cancelled it). Verdict → logcat
    // under the AEC_TEST tag. Triggered by the debug button below.
    val aecTestScope = androidx.compose.runtime.rememberCoroutineScope()
    val aecTest = remember {
        dev.orbit.dock.perception.AecSelfTest(speaker = tts, scope = aecTestScope)
    }
    LaunchedEffect(Unit) {
        PerceptionBus.events.collect { event ->
            if (event is PerceptionEvent.RunAecTest) aecTest.run()
        }
    }

    // The tap-gesture lambda below is set up once (pointerInput keyed on
    // Unit) and captures whatever it closes over at that moment. Reading
    // `state` directly there would use a STALE snapshot (the value at first
    // composition), which made tap-to-wake fire the wrong branch
    // inconsistently. rememberUpdatedState keeps a live reference the
    // long-lived gesture coroutine can read for the *current* state.
    val currentState = androidx.compose.runtime.rememberUpdatedState(state)
    Box(
        modifier = Modifier
            .fillMaxSize()
            .background(MaterialTheme.colorScheme.background)
            .pointerInput(Unit) {
                detectTapGestures(
                    onTap = {
                        when (currentState.value) {
                            FaceState.Speaking -> {
                                // Tap while the dock is talking → barge-in (same
                                // path as the voice-triggered BargeIn event).
                                bargeIn()
                            }
                            FaceState.Idle -> {
                                // Start listening.
                                PerceptionBus.emit(PerceptionEvent.WakeWord(label = "(tap)"))
                            }
                            else -> {
                                // Listening/Engaged → tap stops.
                                PerceptionBus.emit(PerceptionEvent.StopListening)
                                controller.silence()
                            }
                        }
                    },
                    onLongPress = {
                        tts.stop()
                        agentRef.value?.stop()
                        PerceptionBus.emit(PerceptionEvent.StopListening)
                        controller.silence()
                    },
                )
            },
    ) {
        Column(modifier = Modifier.fillMaxSize()) {
            Box(
                modifier = Modifier
                    .fillMaxWidth()
                    .weight(1f)
                    .padding(8.dp),
            ) {
                // Debug HUD: agent loop events overlaid on the LEFT edge, so it
                // doesn't push the face off-centre (it's ambient telemetry around
                // the frame, not a layout column).
                dev.orbit.dock.ui.widgets.EventLog(
                    events = agent.events,
                    modifier = Modifier.align(Alignment.CenterStart),
                )
                Box(modifier = Modifier.fillMaxSize()) {
                    FaceRenderer(
                        state = state,
                        gaze = gaze,
                        expression = expression,
                        privacy = privacy,
                        // Camera off → eyes close (we've gone blind, but
                        // the mic/mouth/everything else stays alive).
                        eyesClosed = camMuted && !privacy,
                    )
                    // Who the station last recognized (lags a new face by ~1-2s).
                    // Right edge, below the model card — clear of the centre READY
                    // pill and the top badges (the whole frame border is debug HUD).
                    seenName?.let { who ->
                        Text(
                            "👤 $who",
                            fontSize = 13.sp,
                            color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.6f),
                            modifier = Modifier
                                .align(Alignment.CenterEnd)
                                .padding(end = 16.dp, bottom = 64.dp), // sits above the model chip
                        )
                    }
                    Subtitle(
                        state = state,
                        privacy = privacy,
                        micGranted = micGranted,
                        pipelineStatus = pipelineStatus,
                        sttArmed = sttArmed,
                        botSubtitle = botSubtitle,
                        transcriptText = transcript.text,
                        transcriptFinal = transcript.isFinal,
                        agentState = agentState,
                        modifier = Modifier
                            .align(Alignment.BottomCenter)
                            .padding(bottom = 12.dp, start = 32.dp, end = 32.dp),
                    )
                    ThinkingDots(
                        agentState = agentState,
                        modifier = Modifier
                            .align(Alignment.BottomCenter)
                            .padding(bottom = 56.dp),
                    )
                    StatePill(
                        faceState = state,
                        agentState = agentState,
                        privacy = privacy,
                        micGranted = micGranted,
                        camGranted = camGranted,
                        facePresent = facePresent,
                        modifier = Modifier
                            .align(Alignment.TopCenter)
                            .padding(top = 16.dp),
                    )
                    if (micGranted && !perceptionReady) {
                        dev.orbit.dock.ui.widgets.WakingUpPill(
                            modifier = Modifier
                                .align(Alignment.Center)
                                .padding(top = 60.dp),
                        )
                    }
                    BodyBadge(
                        connected = bodyConnected,
                        intent = bodyIntent,
                        onTap = { showConnectDialog = true },
                        modifier = Modifier
                            .align(Alignment.TopEnd)
                            .padding(12.dp),
                    )
                    // Version label (top-start) — what build is running, handy
                    // for confirming OTA updates landed. Replaces the old exit X.
                    androidx.compose.material3.Text(
                        text = "v${BuildConfig.VERSION_NAME} · build ${BuildConfig.VERSION_CODE}",
                        color = Color.White.copy(alpha = 0.4f),
                        fontSize = 11.sp,
                        modifier = Modifier
                            .align(Alignment.TopStart)
                            .padding(12.dp),
                    )
                    // The dock's "eye": a live thumbnail of what the camera (and
                    // the vision LLM) sees. Only while the camera is actually on.
                    if (camGranted && !camMuted) {
                        CameraPreview(
                            setSurface = { faceTracker.setPreviewSurface(it) },
                            // bottom-RIGHT so it doesn't sit over the tool-call event
                            // log on the left edge.
                            modifier = Modifier
                                .align(Alignment.BottomEnd)
                                .padding(12.dp),
                        )
                    }
                }
                dev.orbit.dock.ui.widgets.ModelChip(
                    selected = selectedModel,
                    onSelect = { opt -> modelStore.select(opt); selectedModel = opt },
                    modifier = Modifier.align(Alignment.CenterEnd).width(120.dp).padding(8.dp),
                )
            }
            DevBarHost(controller = controller)
            StatusBar(
                audioLevel = audioLevel,
                speaker = speaker,
                // Real OS capture state, not inferred: shows OFF the instant the
                // framework stops/silences our mic, ON whenever it's truly live
                // (incl. during TTS, since AEC keeps it capturing for barge-in).
                micOn = micLive,
                camOn = camGranted && !camMuted,
                bodyConnected = bodyConnected,
                stationConnected = stationConnected,
                stationAddr = BuildConfig.STATION_URL
                    .removePrefix("ws://").removePrefix("wss://").removeSuffix("/ws"),
                onMicToggle = if (micGranted) ({ controller.toggleMic() }) else null,
                onCamToggle = if (camGranted) ({ controller.toggleCam() }) else null,
                onWakeClick = if (BuildConfig.DEBUG) {
                    { PerceptionBus.emit(PerceptionEvent.WakeWord(label = "(debug)")) }
                } else null,
                onLinkClick = { showConnectDialog = true },
            )
        }

        // Connect dialog — opened by tapping the body badge.
        if (showConnectDialog) {
            dev.orbit.dock.body.ui.BodyConnectDialog(
                store = hostStore,
                currentHost = bodyComms.currentHost,
                onConnect = { host ->
                    bodyComms.reconnect(host)
                    showConnectDialog = false
                },
                onDismiss = { showConnectDialog = false },
            )
        }
    }
}

@Composable
private fun Subtitle(
    state: FaceState,
    privacy: Boolean,
    micGranted: Boolean,
    pipelineStatus: String,
    sttArmed: Boolean,
    botSubtitle: String,
    transcriptText: String,
    transcriptFinal: Boolean,
    agentState: AgentState,
    modifier: Modifier = Modifier,
) {
    // Priority:
    //  1) bot is speaking → show what it's saying (bright blue)
    //  2) user transcript live (user text)
    //  3) agent is thinking / tool-calling / failed → show agent status
    //  4) idle state hint
    when {
        botSubtitle.isNotBlank() -> Text(
            text = botSubtitle,
            modifier = modifier,
            color = Color(0xFFB7E4FF),
            textAlign = TextAlign.Center,
            fontSize = 16.sp,
            fontWeight = FontWeight.Medium,
        )
        transcriptText.isNotBlank() -> Text(
            text = transcriptText,
            modifier = modifier,
            color = if (transcriptFinal) {
                MaterialTheme.colorScheme.onBackground
            } else {
                MaterialTheme.colorScheme.onBackground.copy(alpha = 0.55f)
            },
            textAlign = TextAlign.Center,
            fontSize = 15.sp,
            fontWeight = if (transcriptFinal) FontWeight.Medium else FontWeight.Normal,
        )
        agentState !is AgentState.Idle && agentState !is AgentState.Speaking -> Text(
            text = agentStatusText(agentState),
            modifier = modifier.alpha(0.9f),
            color = agentStatusColor(agentState),
            textAlign = TextAlign.Center,
            fontSize = 14.sp,
        )
        else -> Text(
            text = stateHint(state, privacy, micGranted, pipelineStatus, sttArmed),
            modifier = modifier.alpha(0.85f),
            color = Color(0xFFA3B7C2),
            textAlign = TextAlign.Center,
            fontSize = 14.sp,
        )
    }
}

private fun agentStatusText(s: AgentState): String = when (s) {
    is AgentState.Waiting -> "⏳ ${s.shortLabel}"
    is AgentState.Thinking -> "🤔 ${s.shortLabel}"
    is AgentState.ToolCalling -> "🛠 ${s.shortLabel}"
    is AgentState.Failed -> "⚠ ${s.message}"
    else -> ""
}

private fun agentStatusColor(s: AgentState): Color = when (s) {
    is AgentState.Failed -> Color(0xFFFF7B7B)
    is AgentState.Waiting -> Color(0xFFC0C8D0)
    is AgentState.Thinking -> Color(0xFFFFD66B)
    is AgentState.ToolCalling -> Color(0xFF9DDDFF)
    else -> Color(0xFFA3B7C2)
}

private fun stateHint(
    state: FaceState,
    privacy: Boolean,
    micGranted: Boolean,
    pipelineStatus: String,
    sttArmed: Boolean,
): String = when {
    !micGranted -> "mic permission needed — grant to enable listening"
    privacy -> "privacy mode — mic + cam off"
    state == FaceState.Idle -> "tap to talk · $pipelineStatus"
    // One tap = one listening shot. Show "I'm listening" only while the mic is
    // actually armed; the instant it disarms the session is over and the face
    // returns to Idle ("tap to talk"). No fake sustained "listening".
    state == FaceState.Engaged ->
        if (sttArmed) "I'm listening" else "tap to talk"
    state == FaceState.Listening ->
        if (sttArmed) "I'm listening" else "tap to talk"
    state == FaceState.Speaking -> "(speaking…)"
    state == FaceState.Illustrating -> ""
    else -> ""
}

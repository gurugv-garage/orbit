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
    // BodyLink client. Created whenever we have a host: the last successful
    // host from history, else the compile-time BODY_HOST default.
    val bodyComms = remember {
        val initialHost = hostStore.lastHost()
            ?: BuildConfig.BODY_HOST.takeIf { it.isNotBlank() }
            ?: "192.168.1.10:17317"  // sensible default so the badge is always live
        val catalog = BodyStateCatalog.load(ctx)
        BodyLinkComms(
            host = initialHost,
            scope = scope,
            catalog = catalog,
            onConnected = { h -> hostStore.recordSuccess(h) },
        )
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
    // Station-synced config (faceGestures etc.). Resolves baked-default ←
    // persisted ← live station pushes; works fully offline. Shared by DockTools
    // (reads gestures) and StationLink (feeds it pushes).
    val configCache = remember { dev.orbit.dock.config.ConfigCache(ctx) }
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
        ).also { dev.orbit.dock.agent.ToolsTestController.tools = it }
    }
    // Runtime model selection (persisted). Changing it rebuilds the agent so the
    // new transport/model takes effect immediately; default comes from the build.
    val modelStore = remember { dev.orbit.dock.agent.ModelStore(ctx) }
    var selectedModel by remember { mutableStateOf(modelStore.selected()) }
    // Optional orbit-station link (observability + presence). Empty STATION_URL
    // → disabled; the dock is fully functional without it.
    val stationLink = remember {
        dev.orbit.dock.station.StationLink(
            url = BuildConfig.STATION_URL,
            dock = BuildConfig.DOCK_NAME,
            appId = "${BuildConfig.DOCK_NAME}-app",
            scope = scope,
            // report our own links so the station knows the full mesh.
            linkStatus = {
                dev.orbit.dock.station.AppLinks(
                    bodyConnected = bodyComms.connected.value,
                    llmReachable = selectedModel.baseUrl.isNotBlank(),
                )
            },
            // feed config pushes/snapshots into the cache (it ignores stale +
            // keys the dock doesn't care about).
            onConfigFrame = { payload ->
                val scope = (payload["scope"] as? kotlinx.serialization.json.JsonPrimitive)?.content
                val key = (payload["key"] as? kotlinx.serialization.json.JsonPrimitive)?.content
                val value = payload["value"]
                val lastUpdated = (payload["lastUpdated"] as? kotlinx.serialization.json.JsonPrimitive)?.content?.toLongOrNull()
                if (scope != null && key != null && value != null && lastUpdated != null
                    && "$scope.$key" in dev.orbit.dock.config.ConfigCache.DOCK_KEYS) {
                    configCache.apply(scope, key, value, lastUpdated)
                }
            },
        ).also { it.start() }
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

    val perms = rememberPermissions()
    val micGranted = perms.mic
    val camGranted = perms.camera

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
                                // BARGE-IN: tap while the dock is talking → cut
                                // the speech and immediately start listening so
                                // the user can interrupt and talk over it.
                                // Emit WakeWord FIRST: it opens a fresh listening
                                // session (clearing any pending auto-relisten) so
                                // the trailing Speaking(false) from tts.stop()
                                // can't fire a second, racing re-arm.
                                PerceptionBus.emit(PerceptionEvent.WakeWord(label = "(barge-in)"))
                                tts.stop()
                                agentRef.value?.stop()
                                PerceptionBus.emit(PerceptionEvent.Speaking(active = false))
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
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .weight(1f)
                    .padding(8.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                dev.orbit.dock.ui.widgets.EventLog(events = agent.events)
                Box(modifier = Modifier.weight(1f).fillMaxSize()) {
                    FaceRenderer(
                        state = state,
                        gaze = gaze,
                        expression = expression,
                        privacy = privacy,
                        // Camera off → eyes close (we've gone blind, but
                        // the mic/mouth/everything else stays alive).
                        eyesClosed = camMuted && !privacy,
                    )
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
                    BodyBadge(
                        connected = bodyConnected,
                        intent = bodyIntent,
                        onTap = { showConnectDialog = true },
                        modifier = Modifier
                            .align(Alignment.TopEnd)
                            .padding(12.dp),
                    )
                    // The dock's "eye": a live thumbnail of what the camera (and
                    // the vision LLM) sees. Only while the camera is actually on.
                    if (camGranted && !camMuted) {
                        CameraPreview(
                            setSurface = { faceTracker.setPreviewSurface(it) },
                            modifier = Modifier
                                .align(Alignment.BottomStart)
                                .padding(12.dp),
                        )
                    }
                }
                dev.orbit.dock.ui.widgets.ModelChip(
                    selected = selectedModel,
                    onSelect = { opt -> modelStore.select(opt); selectedModel = opt },
                    modifier = Modifier.width(120.dp).padding(8.dp),
                )
            }
            DevBarHost(controller = controller)
            StatusBar(
                audioLevel = audioLevel,
                speaker = speaker,
                micOn = micGranted && !micMuted,
                camOn = camGranted && !camMuted,
                bodyConnected = bodyConnected,
                stationConnected = stationConnected,
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

package dev.orbit.dock.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxHeight
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
import dev.orbit.dock.agent.DockTools
import dev.orbit.dock.agent.RemoteBrain
import dev.orbit.dock.perception.FaceTracker
import dev.orbit.dock.perception.PerceptionBus
import dev.orbit.dock.perception.PerceptionEvent
import dev.orbit.dock.service.PerceptionService
import dev.orbit.dock.tts.DockTts
import dev.orbit.dock.ui.devbar.DevBarHost
import dev.orbit.dock.ui.face.FaceController
import dev.orbit.dock.ui.face.FaceState
import dev.orbit.dock.ui.face.PerceptionWiring
import dev.orbit.dock.ui.perm.rememberPermissions
import dev.orbit.dock.ui.status.StatusBar
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.lifecycle.compose.LocalLifecycleOwner
import kotlinx.coroutines.launch

@Composable
fun DockScreen() {
    val ctx = LocalContext.current
    val controller = remember { FaceController() }
    val scope = rememberCoroutineScope()
    var botSubtitle by remember { mutableStateOf("") }
    // construction order: brain depends on tools+link; tts callback updates brain state.
    val agentRef = remember { object { var value: RemoteBrain? = null } }
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
    // Station-synced config (faceGestures live at the STATION now; the keys left
    // here are dock-local UX). Resolves baked-default ← persisted ← live pushes;
    // works fully offline.
    val configCache = remember { dev.orbit.dock.config.ConfigCache(ctx) }
    // Live senses shared between perception (writer) and the brain (reader) so
    // the LLM knows what the camera actually sees this turn.
    val perception = remember { dev.orbit.dock.agent.PerceptionSnapshot() }
    // Face tracker doubles as the camera-frame source for vision turns. Created
    // here (before the brain) so each turn-request can carry the latest frame.
    val faceTracker = remember { FaceTracker(ctx) }
    if (BuildConfig.DEBUG) {
        dev.orbit.dock.perception.CameraFrameProvider.debugInstance = faceTracker
    }
    // Forward ref so perception wiring below can publish via the station link
    // (the link is built after the tools).
    val stationLinkRef = remember { mutableStateOf<dev.orbit.dock.station.StationLink?>(null) }
    // Pre-turn identity sync: recognition fires when STT arms (parallel with the
    // user's speech); the turn start AWAITS it (bounded) so the prompt is
    // grounded with who's actually talking, not a stale identity.
    val preTurnGrounding = remember { dev.orbit.dock.agent.PreTurnGrounding() }
    // Recognition photos: a FRESH on-demand high-res still (640px), falling back
    // to the latest 320px analysis frame when capture isn't available. The
    // analysis stream stays small — stills cost only when identity is needed.
    val recognitionPhoto: suspend () -> String? = remember {
        { faceTracker.captureRecognitionJpegBase64() ?: faceTracker.latestJpegBase64() }
    }
    val tools = remember(controller, tts) {
        DockTools(
            controller,
            tts,
            onSubtitle = { botSubtitle = it },
            onToolCall = { name -> agentRef.value?.setToolCalling(name) },
            perception = perception,
            onTurnSettled = { wiringRef.value?.clearTranscript() },
        ).also { dev.orbit.dock.agent.ToolsTestController.tools = it }
    }
    // OTA self-update (docs/OTA.md §5). Holds a forward ref so onOtaOffer below
    // can hand offers to it; the updater publishes progress/result back via the
    // station link. Silent install when the app is device-owner, else a system
    // confirm dialog.
    val otaUpdaterRef = remember { mutableStateOf<dev.orbit.dock.ota.OtaUpdater?>(null) }
    // Live A/V streamer (WebRTC → station SFU). Forward ref so the station link's
    // onMediaFrame can route signaling answers/ICE into it; it's built after the
    // link (publishes via the link).
    val mediaStreamerRef = remember { mutableStateOf<dev.orbit.dock.perception.MediaStreamer?>(null) }
    // Body status, display-only: the station drives the body now; the phone just
    // renders the ~1 Hz digest it's sent ({ online, parts }).
    var bodyOnline by remember { mutableStateOf(false) }
    // The station link — the dock's nervous system since the server-brain
    // cutover (the LLM loop lives there). Empty STATION_URL → no brain; the
    // face/perception UX still runs.
    val stationLink = remember {
        dev.orbit.dock.station.StationLink(
            url = BuildConfig.STATION_URL,
            dock = BuildConfig.DOCK_NAME,
            // install UUID, not dock-derived: `id` names the METAL (hello v2) —
            // a swapped/forgotten second phone must not impersonate this one.
            appId = dev.orbit.dock.station.InstallId.get(ctx),
            scope = scope,
            build = BuildConfig.VERSION_CODE,
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
            // station stream-processing results → PerceptionBus → re-grounding.
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
                    // recognize-result: parse (RecognizeResultParser), cache the
                    // categorical verdict, unblock a pending pre-turn grounding.
                    // (The recollect/enroll TOOL round-trips are gone — face
                    // tools run in-process at the station now; only the pre-turn
                    // grounding still asks from the phone.)
                    "recognize-result" -> {
                        val (reqId, outcome) = dev.orbit.dock.agent.RecognizeResultParser.parse(envelope)
                        when {
                            outcome.name != null -> perception.onIdentity(outcome.name, verified = true)
                            outcome.tentative != null -> perception.onIdentity(outcome.tentative, verified = false)
                            // a face that matched NOBODY: a stranger is in frame
                            // now — void the cached identity's recency so "who
                            // am I" can't answer with the previous person.
                            !outcome.noFace -> perception.onUnrecognized()
                        }
                        if (outcome.people.size > 1) {
                            perception.onPeople(outcome.people.map {
                                dev.orbit.dock.agent.PerceptionSnapshot.SeenPerson(it.name, it.tentative, it.side)
                            })
                        }
                        // a pre-turn (STT-arm) recognition came home → the next
                        // turn no longer needs to wait.
                        if (reqId?.startsWith("stt-") == true) preTurnGrounding.complete()
                        null
                    }
                    else -> null
                }
                event?.let { dev.orbit.dock.perception.PerceptionBus.emit(it) }
            },
            // the server brain's frames → the RemoteBrain facade.
            onAgentFrame = { kind, payload -> agentRef.value?.onAgentFrame(kind, payload) },
            // ~1 Hz body digest → status LED (display only).
            onBodyDigest = { payload ->
                bodyOnline = (payload["online"] as? kotlinx.serialization.json.JsonPrimitive)
                    ?.content?.toBooleanStrictOrNull() ?: false
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
    // The brain facade: turns go UP to the station's LLM loop; speak/tool/status
    // frames come back DOWN (StationLink.onAgentFrame above). Same surface as
    // the old on-phone DockAgent, so everything below is unchanged.
    val agent = remember(tools) {
        RemoteBrain(
            tools,
            stationLink,
            cameraFrame = faceTracker,
            // upload the JPEG only when the live A/V stream is DOWN — when
            // it's up the brain grabs frames from the SFU (no per-turn upload).
            uploadFrame = { mediaStreamerRef.value?.isStreaming() != true },
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

    val stationConnected by stationLink.connected.collectAsState()
    // perception models warming up on cold start (wake-word/VAD/STT). Until
    // ready, the dock can't hear — show a brief "waking up" hint.
    val perceptionReady by dev.orbit.dock.perception.PerceptionReady.ready.collectAsState()
    val agentState by agent.state.collectAsState()
    val pendingConfirm by agent.pendingConfirm.collectAsState()
    val debugInfo by agent.debugInfo.collectAsState()
    val wiring = remember(controller, agent) {
        PerceptionWiring(
            controller = controller,
            // Gate the turn on the pre-turn recognition (bounded ~800ms; zero
            // in the normal case — recognition ran while the user spoke). The
            // prompt is then grounded with who's ACTUALLY talking.
            onUserUtterance = { text ->
                scope.launch {
                    preTurnGrounding.awaitGrounded()
                    agent.respond(text)
                }
            },
            onWake = { botSubtitle = "" },
            perception = perception,
        ).also { wiringRef.value = it }
    }

    DisposableEffect(agent) {
        onDispose { agent.shutdown() }
    }
    DisposableEffect(Unit) {
        onDispose { tts.shutdown() }
    }

    // Face skin wiring: a face change (brain tool / dev picker / config / restore)
    // re-points the renderer (faceId flow) AND re-voices the TTS, then persists.
    LaunchedEffect(controller, tts, configCache) {
        controller.onFaceStyleChanged = { id ->
            tts.applyVoice(dev.orbit.dock.ui.face.FaceRegistry.byId(id).voice)
            dev.orbit.dock.ui.face.FaceStylePrefs.set(ctx, id)
        }
        // Restore the last local choice (sticky over a config default).
        controller.restoreFaceStyle(dev.orbit.dock.ui.face.FaceStylePrefs.get(ctx))
        // Apply whatever faceStyle the station already had cached (default if no
        // local override), and keep following pushes.
        configCache.string("faceStyle", "").takeIf { it.isNotBlank() }
            ?.let { controller.applyFaceStyleDefault(it) }
        configCache.onChange { key ->
            if (key == "faceStyle") {
                controller.applyFaceStyleDefault(configCache.string("faceStyle", ""))
            }
        }
    }

    LaunchedEffect(Unit) { wiring.attach(scope) }

    // Rest the screen when nobody's around: dim the backlight after ~1 min with
    // no face, no voice, and no interaction; snap back to full bright on any of
    // them. The dock still never sleeps (FLAG_KEEP_SCREEN_ON) — it just rests dark.
    IdleDimmer(controller = controller, idleAfterMs = 60_000L, dimBrightness = 0.03f)

    // Stream STT transcripts (partials + finals) to the brain so it pre-warms
    // the session while the user is still talking. Pre-warm only — the turn
    // trigger stays onUserUtterance above.
    LaunchedEffect(agent) {
        PerceptionBus.events.collect { ev ->
            if (ev is PerceptionEvent.Transcript) agent.noteTranscript(ev.text, ev.isFinal)
        }
    }

    // Pre-turn recollect: the moment STT arms (the user is about to speak,
    // facing the dock), capture a fresh still and fire one recognize-request.
    // Recognition runs IN PARALLEL with the user's speech; the turn start
    // awaits it (bounded — see onUserUtterance) so the prompt is grounded with
    // who is actually talking. Fire-and-forget was the old behavior, and it
    // raced the transcript: when recognition lost, the LLM got stale identity.
    LaunchedEffect(Unit) {
        dev.orbit.dock.perception.PerceptionBus.events.collect { ev ->
            // NO facePresent gate: the on-device detector runs at 1Hz and was
            // FALSE at arm-time on a real attempt (user walked up + tapped
            // before its next tick) — which silently skipped the pre-turn
            // recognition and left the turn ungrounded. Always capture; the
            // station's detector is the authority on whether a face is there
            // (a faceless photo just answers noFace).
            if (ev is dev.orbit.dock.perception.PerceptionEvent.SttListening && ev.armed) {
                val link = stationLinkRef.value
                if (link == null) {
                    preTurnGrounding.cancel()
                } else {
                    preTurnGrounding.begin()
                    val photo = recognitionPhoto()
                    if (photo == null) {
                        preTurnGrounding.cancel() // nothing to recognize — don't gate the turn
                    } else {
                        link.publish(
                            "perception", "recognize-request",
                            kotlinx.serialization.json.buildJsonObject {
                                put("reqId", kotlinx.serialization.json.JsonPrimitive("stt-${System.currentTimeMillis()}"))
                                put("photo", kotlinx.serialization.json.JsonPrimitive(photo))
                            },
                        )
                    }
                }
            }
        }
    }

    // Start the live A/V stream once the station is connected AND perception is
    // warm (mic ADM up, so WebRtcAudio.sharedFactory has its audio device module).
    // Retry a few times: the ADM can lag perceptionReady by a beat, and start()
    // is idempotent + bails (logs) if the factory isn't up yet. Tearing down on
    // dispose; the shared factory/ADM stay owned by WebRtcAudio.
    // Remember whether we'd already brought the stream up under a PRIOR station
    // session. A station restart flips stationConnected false→true: the SFU we
    // offered to is gone (producers:[]), so isStreaming()==true is STALE — we must
    // re-offer, not bail. First connect: plain start(). Reconnect after we'd already
    // streamed: restart() (tear down the dead PC + send a fresh producer-offer).
    val hadStreamed = remember { mutableStateOf(false) }
    LaunchedEffect(stationConnected, perceptionReady) {
        if (stationConnected && perceptionReady) {
            if (hadStreamed.value && mediaStreamer.isStreaming()) {
                // reconnect to a fresh station/SFU — our previous offer is dead.
                mediaStreamer.restart()
                return@LaunchedEffect
            }
            repeat(10) {
                if (mediaStreamer.isStreaming()) { hadStreamed.value = true; return@LaunchedEffect }
                mediaStreamer.start()
                if (mediaStreamer.isStreaming()) hadStreamed.value = true
                kotlinx.coroutines.delay(500)
            }
        }
    }
    DisposableEffect(Unit) { onDispose { mediaStreamer.stop() } }

    val state by controller.state.collectAsState()
    val gaze by controller.gaze.collectAsState()
    val expression by controller.expression.collectAsState()
    val faceId by controller.faceId.collectAsState()
    val activeFace = dev.orbit.dock.ui.face.FaceRegistry.byId(faceId)
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
    // recollect / the STT-trigger). Observed from the snapshot's StateFlow —
    // shows "guru" when a face is present, "guru (away)" when remembered but
    // no face now.
    val senses by perception.factsFlow.collectAsState()
    val seenName = senses.identity?.let { if (senses.facePresent) it else "$it (away)" }

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
    // camera-frame source for the brain).
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
    // re-arm. The pipeline's WakeWord handler releases the mic (cancelAndJoin)
    // and waits a beat for the input HAL to settle before arming STT — arming
    // too early, while TTS is still tearing down, gives SR a dead mic.
    val bargeIn = remember {
        {
            PerceptionBus.emit(PerceptionEvent.WakeWord(label = "(barge-in)"))
            tts.stop()   // emits the Speaking(false) edge itself (SpeakingEdgeGate)
            agentRef.value?.stop()
            Unit
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
            // Per-face background tint (drawn behind the face AND the left-edge
            // telemetry overlay). Falls back to the theme bg for the default face.
            .background(activeFace.palette.background)
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
                                // Listening/Engaged → tap stops the session.
                                PerceptionBus.emit(PerceptionEvent.StopListening)
                                // If a turn is mid-flight (the face stays
                                // Listening through Waiting/Thinking/tool
                                // calls), tap cancels the turn too — otherwise
                                // the only way out of a slow "thinking…" was
                                // long-press, and taps felt ignored.
                                if (agentRef.value?.state?.value !is AgentState.Idle) {
                                    tts.stop()
                                    agentRef.value?.stop()
                                }
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
                // Left-edge debug telemetry, stacked top→bottom so they don't
                // overlap: the TaskHud (session id + running tasks) sits up top
                // (BELOW the version label — top padding clears it), the scrolling
                // EventLog fills the space below it.
                Column(
                    modifier = Modifier
                        .align(Alignment.TopStart)
                        .fillMaxHeight()
                        .padding(top = 34.dp), // clear the version label above
                ) {
                    dev.orbit.dock.ui.widgets.TaskHud(info = debugInfo)
                    dev.orbit.dock.ui.widgets.EventLog(
                        events = agent.events,
                        modifier = Modifier.weight(1f),
                    )
                }
                Box(modifier = Modifier.fillMaxSize()) {
                    activeFace.Render(
                        modifier = Modifier,
                        state = state,
                        gaze = gaze,
                        expression = expression,
                        privacy = privacy,
                        // Camera off → eyes close (we've gone blind, but
                        // the mic/mouth/everything else stays alive).
                        eyesClosed = camMuted && !privacy,
                        compactFraction = 1f,
                        staticForScreenshot = false,
                    )
                    // Who the station last recognized (lags a new face by ~1-2s).
                    seenName?.let { who ->
                        Text(
                            "👤 $who",
                            fontSize = 13.sp,
                            color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.6f),
                            modifier = Modifier
                                .align(Alignment.CenterEnd)
                                .padding(end = 16.dp, bottom = 64.dp),
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
                // && stationConnected: with the link down the digest is stale —
                // we DON'T know the body state, so don't claim it.
                bodyConnected = stationConnected && bodyOnline,
                stationConnected = stationConnected,
                stationAddr = BuildConfig.STATION_URL
                    .removePrefix("ws://").removePrefix("wss://").removeSuffix("/ws"),
                onMicToggle = if (micGranted) ({ controller.toggleMic() }) else null,
                onCamToggle = if (camGranted) ({ controller.toggleCam() }) else null,
                onWakeClick = if (BuildConfig.DEBUG) {
                    { PerceptionBus.emit(PerceptionEvent.WakeWord(label = "(debug)")) }
                } else null,
            )
        }

        // Approve/deny dialog for a mutating code/file tool (write/edit/run).
        // The brain's tool is blocked until the user taps; deny is the safe
        // default (back-press / dismiss = deny).
        pendingConfirm?.let { req ->
            ConfirmDialog(
                summary = req.summary,
                detail = req.detail,
                onApprove = { agent.resolveConfirm(true) },
                onApproveAll = { agent.resolveConfirm(approved = true, approveAll = true) },
                onDeny = { agent.resolveConfirm(false) },
            )
        }
    }
}

@Composable
private fun ConfirmDialog(
    summary: String,
    detail: String,
    onApprove: () -> Unit,
    onApproveAll: () -> Unit,
    onDeny: () -> Unit,
) {
    androidx.compose.material3.AlertDialog(
        onDismissRequest = onDeny, // dismiss = deny (safe default)
        title = { Text(summary) },
        text = {
            androidx.compose.foundation.layout.Column {
                if (detail.isNotBlank()) {
                    Text(
                        detail,
                        fontFamily = androidx.compose.ui.text.font.FontFamily.Monospace,
                        style = MaterialTheme.typography.bodySmall,
                    )
                }
                // session-wide opt-out of further prompts
                androidx.compose.material3.TextButton(
                    onClick = onApproveAll,
                    modifier = Modifier.padding(top = 8.dp),
                ) { Text("Approve all (this session)") }
            }
        },
        confirmButton = {
            androidx.compose.material3.TextButton(onClick = onApprove) { Text("Approve") }
        },
        dismissButton = {
            androidx.compose.material3.TextButton(onClick = onDeny) { Text("Deny") }
        },
    )
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
    //  3) brain is thinking / tool-calling / failed → show its status
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

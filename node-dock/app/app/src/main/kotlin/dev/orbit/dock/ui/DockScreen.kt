package dev.orbit.dock.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.animation.core.animateFloat
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
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
import timber.log.Timber
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
    // Haptic listening-cue vibrator (replaces the TTS-colliding beep). Idempotent.
    remember(ctx) { dev.orbit.dock.ui.face.HapticCue.init(ctx); Unit }
    val controller = remember { FaceController() }
    val scope = rememberCoroutineScope()
    var botSubtitle by remember { mutableStateOf("") }
    // construction order: brain depends on tools+link; tts callback updates brain state.
    val agentRef = remember { object { var value: RemoteBrain? = null } }
    // Forward ref: tools is built before wiring but needs to clear the transcript
    // on turn-settle (action-only turns must not leave the user's words on screen).
    val wiringRef = remember { object { var value: PerceptionWiring? = null } }
    val tts = remember {
        DockTts(
            ctx, controller,
            onSpeakingChanged = { speaking ->
                agentRef.value?.setSpeaking(speaking)
                // Echo gate: tell the pipeline the dock is/ isn't speaking so STT
                // pauses while talking (no hearing itself) and auto-resumes after
                // — but only if a tap-listening session is still active. This is
                // what gives "talk → I reply → it keeps listening for your next
                // thing" without the dock transcribing its own voice.
                PerceptionBus.emit(PerceptionEvent.Speaking(active = speaking))
            },
            // Keepalive is NOT an edge: station-only (refreshes its speaking cap);
            // no bus re-emit (that reset the barge grace window every 5s).
            onSpeakingKeepalive = { agentRef.value?.speakingKeepalive() },
        )
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
    // Runtime dock binding (docs/modules/runtime-dock-binding.md): the dock
    // name is no longer compiled in. Start from the local cache (or a dev-override
    // BuildConfig.DOCK_NAME), and LEARN/refresh it from the station's welcome frame.
    // null ⇒ UNCLAIMED — drives the "claim me in the console" hint.
    var boundDock by remember {
        mutableStateOf(
            dev.orbit.dock.station.DockBindingCache.resolveInitial(ctx, BuildConfig.DOCK_NAME),
        )
    }
    // Set true the moment we learn our dock CHANGED (a console move). Drives a
    // blocking overlay, then we restart the whole process so nothing dock-specific
    // survives (docs/modules/runtime-dock-binding.md).
    var restarting by remember { mutableStateOf(false) }
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
            setZoom = { r -> faceTracker.setZoom(r) },
        ).also { dev.orbit.dock.agent.ToolsTestController.tools = it }
    }
    // OTA self-update (docs/ota.md §5). Holds a forward ref so onOtaOffer below
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
            // empty/null when unclaimed — the station resolves + sends our dock
            // back via welcome (docs/modules/runtime-dock-binding.md).
            dock = boundDock,
            // ANDROID_ID: the uninstall-stable hardware key the station's
            // deviceId→dock binding is keyed on (DeviceId). `id` names the METAL
            // (hello v2) — a swapped/forgotten second phone must not impersonate this one.
            appId = dev.orbit.dock.station.DeviceId.get(ctx),
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
                    version = p("version")?.content,
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
                    // A1.2 (always-on-mic shift): STT now runs SERVER-SIDE, so the
                    // user's transcript arrives here (not from a local recognizer).
                    // Surface it in the subtitle band via the same Transcript event
                    // the UI already renders. Server STT is utterance-final only.
                    "transcript" -> {
                        val text = prim(inner, "text")?.takeIf { it.isString }?.content ?: ""
                        if (text.isNotBlank())
                            dev.orbit.dock.perception.PerceptionEvent.Transcript(text, isFinal = true)
                        else null
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
            // Runtime dock binding: the station told us our dock (on connect, or
            // when a console claim binds us). Persist it so we re-announce instantly
            // next boot, and update the UI's claimed/unclaimed state.
            onDockLearned = { learnedDock, _ ->
                val prev = boundDock
                when {
                    // A CLAIM — learning a (new or changed) dock — always RESTARTS
                    // the process. One clean code path: the device comes up fresh as
                    // its dock with no stale in-memory trace (MediaStreamer label,
                    // session id/logs, brain). Covers both first-claim (prev == null)
                    // and move (prev != learned). docs/modules/runtime-dock-binding.md
                    learnedDock != null && learnedDock != prev -> {
                        dev.orbit.dock.station.DockBindingCache.set(ctx, learnedDock)
                        Timber.w("claimed dock '$prev' → '$learnedDock' — restarting app")
                        restarting = true
                        dev.orbit.dock.station.AppRestart.now(ctx)
                    }
                    // UNBOUND (learned null while we had a dock) → go idle UNCLAIMED,
                    // no restart (user choice): clear cache so nothing resurrects.
                    learnedDock == null && prev != null -> {
                        boundDock = null
                        dev.orbit.dock.station.DockBindingCache.clear(ctx)
                    }
                    // else: welcome echoing our current dock on a plain reconnect — no-op.
                }
            },
        ).also { it.start(); stationLinkRef.value = it }
    }
    // The live A/V streamer. Publishes producer-offer/ICE via the station link.
    val mediaStreamer = remember {
        dev.orbit.dock.perception.MediaStreamer(
            context = ctx,
            faceTracker = faceTracker,
            // display/grouping label only; for a device stream the station prefers
            // the live peer's dock, so an unclaimed phone ("") still groups right
            // once claimed (docs/modules/runtime-dock-binding.md).
            label = boundDock ?: "",
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
        ).also {
            agentRef.value = it
            // expose to the debug receiver (adb-driven feedback flagging).
            dev.orbit.dock.agent.BrainTestController.brain = it
        }
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
            // A1.2: a tap (wake event) TOGGLES the dock "addressed" listening — the
            // station owns the state machine and emits the conversation mode back.
            onWake = { botSubtitle = ""; agent.addressed() },
            perception = perception,
            // Report raw conversation events UP; the station decides + the phone
            // renders the convMode it sends back (pure renderer).
            sendVad = { active -> agent.sendVad(active) },
            sendFaceArrival = { agent.sendFaceArrival() },
            sendFaceLeft = { agent.sendFaceLeft() },
            convMode = agent.convMode,
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
        // Persist mic mute so "mic off" survives an app restart (a restart must not
        // silently re-open the mic). Restore the last value at startup.
        controller.onMicMutedChanged = { muted -> dev.orbit.dock.ui.face.MicMutePrefs.set(ctx, muted) }
        controller.restoreMicMuted(dev.orbit.dock.ui.face.MicMutePrefs.get(ctx))
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

    // Forward the on-device MLKit perception (face geometry + emotion/gesture/identity) to
    // the station as the `perceive` stream — the fast face source for faceFollow + the
    // pipeline. Dedups/throttles internally (see PerceiveForwarder). Reads the live
    // StationLink each publish so it survives reconnects.
    LaunchedEffect(Unit) {
        dev.orbit.dock.perception.PerceiveForwarder({ stationLinkRef.value }, scope)
    }

    // DEBUG telemetry: publish the FaceTracker's 1 Hz detection-health report over the WS
    // (perceive/telemetry) so a stream STALL is diagnosable station-side without adb.
    LaunchedEffect(Unit) {
        faceTracker.onTelemetry = { framesIn, facePasses, faceHits, lastFaceMsAgo, intervalMs ->
            stationLinkRef.value?.publish("perceive", "telemetry", kotlinx.serialization.json.buildJsonObject {
                put("framesIn", kotlinx.serialization.json.JsonPrimitive(framesIn))
                put("facePasses", kotlinx.serialization.json.JsonPrimitive(facePasses))
                put("faceHits", kotlinx.serialization.json.JsonPrimitive(faceHits))
                put("lastFaceMsAgo", kotlinx.serialization.json.JsonPrimitive(lastFaceMsAgo))
                put("intervalMs", kotlinx.serialization.json.JsonPrimitive(intervalMs))
            })
        }
    }

    // Rest the screen when nobody's around: dim the backlight after ~1 min with
    // no face, no voice, and no interaction; snap back to full bright on any of
    // them. The dock still never sleeps (FLAG_KEEP_SCREEN_ON) — it just rests dark.
    IdleDimmer(controller = controller, idleAfterMs = 60_000L, dimBrightness = 0.03f)

    // (A1.2) The local STT pre-warm is GONE: with the always-on-mic shift, STT
    // runs server-side and Transcript events now arrive FROM the station (rendered
    // in the subtitle band via onPerceptionFrame). Forwarding them back up as
    // pre-warm would loop, and the station already owns the transcript.

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
    // MIC-READY: the audio actually reaches the station only once the WebRTC stream is
    // up (isStreaming) AND the link is connected — NOT merely when the local mic opens.
    // After a restart there's a ~few-second window where the mic is live locally but the
    // stream is still reattaching; the first sentence spoken then is lost. Poll the
    // (non-Flow) isStreaming() into observable state so the mic icon can show "connecting"
    // until it's truly delivering. (docs: lost-first-sentence-after-restart.)
    var streamUp by remember { mutableStateOf(false) }
    LaunchedEffect(stationConnected) {
        while (true) {
            streamUp = stationConnected && mediaStreamer.isStreaming()
            kotlinx.coroutines.delay(500)
        }
    }
    // (micReady is derived below, once micLive is in scope.)
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
    // LIVE interim (partial) user-speech caption streamed from the station while the
    // user is mid-utterance. When present it takes priority over the perception
    // transcript flow (it's the freshest, growing text); it clears the moment the turn
    // leaves listening/followup (RemoteBrain.clearInterim), at which point we fall back
    // to the endpointed perception transcript / bot reply.
    val interimTranscript by agent.interimTranscript.collectAsState()
    // The station's conversation mode. The user-speech caption (interim or endpointed
    // transcript) belongs to an OPEN listening window only — outside it (idle/thinking/
    // speaking) the words are stale and must not paint, which is the "transcribing when
    // not listening" symptom (esp. after a restart, when a window-close 'idle' frame can
    // be missed). We gate the caption on this rather than trust the transcript flow alone.
    val convMode by agent.convMode.collectAsState()
    val listeningWindow = convMode == "listening" || convMode == "followup"
    // Listening-window countdown: the station sends the absolute close time; we tick a
    // local clock so the on-face badge shows seconds remaining. A screenshot then proves
    // BOTH that it's in listening mode AND how long is left (debugging "UI says listening
    // but no reply"). 0 = not in a timed window.
    val windowUntil by agent.windowUntil.collectAsState()
    var nowTick by remember { mutableStateOf(System.currentTimeMillis()) }
    LaunchedEffect(windowUntil) {
        while (windowUntil > 0L) { nowTick = System.currentTimeMillis(); kotlinx.coroutines.delay(250) }
    }
    val listenSecsLeft = if (windowUntil > 0L) ((windowUntil - nowTick + 999) / 1000).coerceAtLeast(0) else 0L
    // A fresh live interim means the USER is speaking again (e.g. a follow-up in the
    // followup window, no palm). The previous reply's botSubtitle is now stale and, by
    // the Subtitle precedence (botSubtitle > transcript), would otherwise mask the live
    // caption — the "response mode shows old text" bug. Clear it so the interim shows.
    LaunchedEffect(interimTranscript) {
        if (interimTranscript.isNotEmpty() && botSubtitle.isNotEmpty()) botSubtitle = ""
    }

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
    // The mic is truly "ready to be heard by the station" only when it's live locally
    // AND the WebRTC stream is delivering (streamUp, polled above). The status-bar mic
    // icon pulses amber until this is true, so the user doesn't speak into the
    // post-restart reconnect window and lose their first sentence.
    val micReady = micLive && streamUp

    LaunchedEffect(micGranted, micMuted) {
        // Mic OFF = ONE real switch: disable the WebRTC audio track so the STATION
        // receives silence (no STT, no listening, no caption) — the station needs to
        // know nothing, it just hears nothing. Also stop the local VAD/wake pipeline
        // (power saving; the on-phone meter goes quiet too).
        mediaStreamerRef.value?.setMuted(micMuted)
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
            // tts.stop()'s wind-down calls face.silence() (DockTts.finishUtterance),
            // which RACES the station's incoming conversation→listening glow update —
            // leaving "stopped speaking but not visibly listening". A barge-in IS a
            // transition INTO listening, so assert it locally now; the station's frame
            // confirms the same state a beat later (idempotent). Fixes the missing glow
            // on tap-during-speech.
            controller.listen()
            Unit
        }
    }

    // Voice barge-in (pipeline BargeIn during TTS) + TTS pause/continue (the
    // barge-in "polite pause": hold playback sample-exact WITHOUT dropping the
    // speaking signal or the turn; release continues where it stopped —
    // production driver is the station's tts-hold frame, this bus path is the
    // debug PAUSETTS/RESUMETTS lever). One collector: bus events fan out to
    // every collector, so rare events share one instead of adding fan-out cost.
    LaunchedEffect(Unit) {
        PerceptionBus.events.collect { event ->
            when (event) {
                is PerceptionEvent.BargeIn -> bargeIn()
                is PerceptionEvent.TtsHold -> if (event.hold) tts.pause() else tts.resume()
                else -> {}
            }
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

    // PALM-to-address / palm-to-interrupt (on-device MediaPipe gesture; see
    // PalmDetector). Showing an open palm ADDRESSES the dock — additive, not a
    // replacement (tap still works):
    //   - speaking          → barge-in (interrupt + re-listen)
    //   - idle              → start listening
    //   - already listening → NO-OP (deliberately).
    // Unlike a tap, a palm NEVER closes an open listening window. A tap toggles
    // (tap-on / tap-off), but palm detection is noisier and naturally re-fires
    // while a hand lingers — routing a 2nd palm to "stop" would tear down the
    // window you JUST opened, right before you speak ("listening but no response").
    // So a palm only ever opens/keeps listening; you stop by silence/timeout or a
    // real tap. Rising-edge detection + a ~2s action debounce keep one raise = one
    // action. Reads currentState (the live face state) to route.
    val lastPalmActionMs = remember { java.util.concurrent.atomic.AtomicLong(0L) }
    LaunchedEffect(Unit) {
        PerceptionBus.events.collect { event ->
            if (event !is PerceptionEvent.HandGesture || !event.palm) return@collect
            val now = System.currentTimeMillis()
            if (now - lastPalmActionMs.get() < PALM_ACTION_DEBOUNCE_MS) return@collect
            lastPalmActionMs.set(now)
            // A palm ALWAYS means "address me / listen" — never "stop listening". It
            // uses the OPEN-ONLY address (addressedOpenOnly → station tapOpen), so it
            // can't toggle a window off the way a tap does. This is the clean fix for
            // the palm-during-speaking bug: the old path routed through bargeIn() →
            // WakeWord → addressed (a TOGGLE), which — when the short TTS had already
            // flipped speaking→followup — landed as tap-OFF → idle, and the user's
            // next utterance was dropped as not-addressed.
            when (currentState.value) {
                FaceState.Speaking -> {
                    // Interrupt: tear down the current TTS + turn, THEN address
                    // open-only so a fresh listening window opens (and can't be
                    // toggled shut by a follow-up palm frame).
                    Timber.i("palm → interrupt + listen (open-only)")
                    botSubtitle = ""
                    tts.stop()
                    agentRef.value?.stop()
                    agentRef.value?.addressedOpenOnly()
                }
                else -> {
                    // Idle / Listening / Followup / Engaged → ensure listening is
                    // open. Open-only is idempotent: re-showing a palm keeps the
                    // window open, never closes it.
                    Timber.i("palm → address + listen (open-only)")
                    botSubtitle = ""
                    agentRef.value?.addressedOpenOnly()
                }
            }
        }
    }

    // DEBUG face-follow indicator: track the live on-device face position so the overlay can
    // show SEARCHING (no face) vs IN-VIEW + how centered. Mirror-corrected NDC from FaceSeen
    // (x,y ∈ [-1,1]); we keep the last seen + whether it's currently present (a short grace
    // so a 1-frame miss doesn't flicker the indicator). Drives FaceFollowIndicator below.
    var ffFaceX by remember { mutableStateOf(0f) }
    var ffFaceY by remember { mutableStateOf(0f) }
    var ffSeenAtMs by remember { mutableStateOf(0L) }
    var ffNowMs by remember { mutableStateOf(0L) }
    LaunchedEffect(Unit) {
        PerceptionBus.events.collect { ev ->
            if (ev is PerceptionEvent.FaceSeen) { ffFaceX = ev.x; ffFaceY = ev.y; ffSeenAtMs = System.currentTimeMillis() }
            else if (ev is PerceptionEvent.FaceLost) { ffSeenAtMs = 0L }
        }
    }
    LaunchedEffect(Unit) { while (true) { ffNowMs = System.currentTimeMillis(); kotlinx.coroutines.delay(200) } }

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
                    // LISTENING glow — a soft breathing edge halo while the dock is
                    // attending (listening/followup), tinted by the active face's eye
                    // glow so it matches every style. Pairs with the haptic + beep cues
                    // as the VISUAL "I'm listening" signal. Fades out otherwise.
                    dev.orbit.dock.ui.face.ListeningGlow(
                        listening = state == FaceState.Listening || state == FaceState.Engaged,
                        accent = activeFace.palette.eyeGlow,
                    )
                    // LISTENING COUNTDOWN badge — unambiguous on a screenshot: shows it's
                    // in a listening window AND the seconds left before it closes. Visible
                    // whenever the station says we're in a timed window (windowUntil>0).
                    if (listenSecsLeft > 0L) {
                        androidx.compose.material3.Text(
                            text = "🎙 listening · ${listenSecsLeft}s",
                            color = Color(0xFF7FE08C),
                            fontSize = 15.sp,
                            fontWeight = FontWeight.Medium,
                            modifier = Modifier
                                .align(Alignment.TopCenter)
                                .padding(top = 52.dp)
                                .background(Color(0xFF0E1A12).copy(alpha = 0.85f), RoundedCornerShape(50))
                                .padding(horizontal = 14.dp, vertical = 5.dp),
                        )
                    }
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
                        // Live interim wins while it's non-empty (freshest growing
                        // partial); otherwise show the endpointed perception transcript.
                        // An interim is never "final" (dim styling); the perception
                        // transcript keeps its own final flag.
                        // GATE: the user-speech caption shows only inside an open
                        // listening/followup window. Outside it the words are stale —
                        // the always-on STT keeps producing transcripts the dock isn't
                        // "listening" to, and a missed window-close frame (restart) would
                        // otherwise leave them painted. The bot reply has its own band.
                        transcriptText = if (listeningWindow) interimTranscript.ifEmpty { transcript.text } else "",
                        transcriptFinal = if (interimTranscript.isNotEmpty()) false else transcript.isFinal,
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
                    // Runtime dock binding (docs/modules/runtime-dock-binding.md):
                    // connected but no dock yet → tell the operator to claim this
                    // device in the station console. The brain/body stay idle until then.
                    if (stationConnected && boundDock == null) {
                        androidx.compose.material3.Text(
                            text = "🔓 unclaimed — claim this device in the station console",
                            color = Color(0xFFE0A030),
                            fontSize = 13.sp,
                            fontWeight = FontWeight.Medium,
                            textAlign = androidx.compose.ui.text.style.TextAlign.Center,
                            modifier = Modifier
                                .align(Alignment.TopCenter)
                                .padding(top = 84.dp, start = 24.dp, end = 24.dp)
                                .background(Color(0xFF1A140A).copy(alpha = 0.9f), RoundedCornerShape(10))
                                .padding(horizontal = 14.dp, vertical = 7.dp),
                        )
                    }
                    // "waking up…" = the perception pipeline is still starting. Don't
                    // show it when the mic is MUTED: perception is stopped on purpose
                    // then (PerceptionService.stop on mute), so !perceptionReady is the
                    // intended OFF state, not a wake-up — the pill there read as "still
                    // coming up" when the user had deliberately turned the mic off.
                    if (micGranted && !micMuted && !perceptionReady) {
                        dev.orbit.dock.ui.widgets.WakingUpPill(
                            modifier = Modifier
                                .align(Alignment.Center)
                                .padding(top = 60.dp),
                        )
                    }
                    // Version label (top-start) — what build is running, handy
                    // for confirming OTA updates landed. Replaces the old exit X.
                    // LONG-PRESS = flag FEEDBACK on this session (feedback-flow):
                    // ships the session up to the station for a full debugging dump.
                    androidx.compose.material3.Text(
                        // Lead with the DOCK NAME so it's obvious at a glance which
                        // device this is (tab vs redmi vs …) — handy with several docks.
                        // Runtime dock binding: the name is learned from the station
                        // now (boundDock), not BuildConfig.DOCK_NAME (empty by default).
                        text = "${boundDock ?: "unclaimed"} · v${BuildConfig.VERSION_NAME} · build ${BuildConfig.VERSION_CODE}",
                        color = Color.White.copy(alpha = 0.4f),
                        fontSize = 11.sp,
                        modifier = Modifier
                            .align(Alignment.TopStart)
                            .padding(12.dp)
                            .pointerInput(Unit) {
                                detectTapGestures(
                                    // TAP the build number = force an OTA update check (ask the
                                    // station to re-offer if this dock is behind). The app is
                                    // otherwise passive; this saves waiting for the next re-announce.
                                    onTap = {
                                        otaUpdater.requestCheck()
                                        android.widget.Toast.makeText(
                                            ctx, "Checking for update…", android.widget.Toast.LENGTH_SHORT,
                                        ).show()
                                    },
                                    onLongPress = {
                                        agentRef.value?.sendFeedback(null)
                                        android.widget.Toast.makeText(
                                            ctx, "Feedback flagged for this session", android.widget.Toast.LENGTH_SHORT,
                                        ).show()
                                    },
                                )
                            },
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
                // The icon reflects the user's INTENT (micMuted), so a mute tap
                // visibly flips it — the whole point of the toggle. (Previously bound
                // to micLive/OS-capture, which never changed on mute, so the tap
                // looked dead.) micReady still drives the "connecting…" amber pulse:
                // the mic is on but the WebRTC stream isn't delivering yet.
                micOn = !micMuted,
                micReady = micReady,
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

        // Dock moved (runtime dock binding) → full-screen blocking overlay while the
        // process self-restarts so nothing stale survives. Covers everything.
        if (restarting) {
            Box(
                modifier = Modifier
                    .fillMaxSize()
                    .background(Color(0xFF0A0A0F).copy(alpha = 0.96f)),
                contentAlignment = Alignment.Center,
            ) {
                androidx.compose.material3.Text(
                    text = "↻ dock changed — restarting…",
                    color = Color(0xFF6EC1FF),
                    fontSize = 18.sp,
                    fontWeight = FontWeight.Medium,
                    textAlign = androidx.compose.ui.text.style.TextAlign.Center,
                )
            }
        }

        // DEBUG face-follow indicator (top-most overlay) — ONLY while a face-follow task is
        // actually running (from the station's task-digest the app already tracks). Four
        // states: SEARCH (red), WAIT (amber pulse, ~30s lost-lock hold), TRACK (amber dot,
        // off-center), LOCK (green dot+ring, centered). In named mode it shows the target
        // name; in salient mode it shows the recognized identity when known.
        val faceFollow = debugInfo.tasks.firstOrNull { it.name == "face-follow" }
        if (faceFollow != null) {
            // target = who it's LOOKING FOR (named mode; empty in salient). seen = who is
            // actually recognized in view right now (station identity). The indicator compares
            // them so it never claims "LOCK Sia" while it's actually seeing — and ignoring —
            // someone else: a wrong person reads as "SEARCH Sia — not them".
            FaceFollowIndicator(
                faceX = ffFaceX, faceY = ffFaceY,
                present = ffSeenAtMs != 0L && (ffNowMs - ffSeenAtMs) < 2500L,
                msSinceSeen = if (ffSeenAtMs == 0L) Long.MAX_VALUE else (ffNowMs - ffSeenAtMs),
                target = faceFollow.target,
                seen = if (senses.facePresent) (senses.identity ?: "") else "",
                modifier = Modifier.align(Alignment.TopEnd),
            )
        }

        // OTA opt-in: when the station offers a newer build, show a TAPPABLE banner instead of
        // AUTO-applying: onOffer() starts the download+install itself. The banner is
        // informational (shows build + live apply progress); a tap just re-triggers the same
        // idempotent apply. Top-start, out of the way.
        val otaAvail by otaUpdater.available.collectAsState()
        otaAvail?.let { upd ->
            androidx.compose.material3.Surface(
                color = Color(0xCC1A2A1A), shape = androidx.compose.foundation.shape.RoundedCornerShape(8.dp),
                modifier = Modifier.align(Alignment.TopStart).padding(8.dp)
                    .pointerInput(upd.build) { detectTapGestures(onTap = { otaUpdater.startPendingUpdate() }) },
            ) {
                androidx.compose.material3.Text(
                    text = upd.progress?.let { "update v${upd.version}: $it" } ?: "⬆ build ${upd.build} — updating…",
                    color = Color(0xFF8FE0A0), fontSize = 11.sp, fontWeight = FontWeight.Medium,
                    modifier = Modifier.padding(horizontal = 10.dp, vertical = 6.dp),
                )
            }
        }
    }
}

/** Small debug overlay: the dock's eye-view. A center crosshair = frame center; a dot at the
 *  live face position (NDC x,y ∈ [-1,1], y+ = down) when present (GREEN, brighter as it nears
 *  center), or a RED "searching" ring when no face. Lets you watch detection + centering live
 *  without instrumentation. Top-right, small, non-interactive. */
@Composable
private fun FaceFollowIndicator(faceX: Float, faceY: Float, present: Boolean, msSinceSeen: Long, target: String = "", seen: String = "", modifier: Modifier = Modifier) {
    // States (debug tool for face-follow), derived on-device:
    //   • LOCK <name>  — following them, centered (green dot + ring)
    //   • TRACK <name> — following them, off-center, correcting (amber dot)
    //   • SEARCH <target> — not them / nobody → sweeping (red ring). In NAMED mode, if it
    //     SEES the wrong person, it says "SEARCH <target> — not them" + a MUTED dot, so it
    //     never falsely reads "LOCK <target>" while actually seeing+ignoring someone else.
    //   • WAIT — lost a face recently (≤30s), holding (amber pulsing ring).
    val box = 96.dp
    // NAMED mode: a present face only counts as the TARGET when the recognized identity matches.
    // A present-but-wrong person (or unrecognized while we want a specific name) is NOT a follow.
    val named = target.isNotEmpty()
    val isTarget = if (named) (seen.isNotEmpty() && seen.equals(target, ignoreCase = true)) else true
    val following = present && isTarget          // genuinely tracking who we want
    val wrongPerson = present && named && !isTarget // sees someone, but not the target
    // HYSTERESIS on LOCK↔TRACK so jitter at the deadband edge doesn't flicker the label.
    val enterBand = 0.20f; val exitBand = 0.30f
    var wasLocked by remember { mutableStateOf(false) }
    val band = if (wasLocked) exitBand else enterBand
    val centered = following && kotlin.math.abs(faceX) < band && kotlin.math.abs(faceY) < band
    if (following) wasLocked = centered
    val waiting = !present && msSinceSeen < 30_000L
    // the name to show: who we're FOLLOWING (target or recognized salient face).
    val who = if (named) target else (seen.ifEmpty { "" })
    val label = when {
        following && centered -> if (who.isNotEmpty()) "LOCK $who" else "LOCK"
        following -> if (who.isNotEmpty()) "TRACK $who" else "TRACK"
        wrongPerson -> if (seen.isNotEmpty()) "SEARCH $target (saw $seen)" else "SEARCH $target — not them"
        waiting -> "WAIT" + (if (who.isNotEmpty()) " $who" else "")
        else -> if (named) "SEARCH $target" else "SEARCH"
    }
    val labelColor = when {
        following && centered -> Color(0xFF49E07A)
        following -> Color(0xFFE0B84A)
        waiting -> Color(0xFFE0B84A)
        else -> Color(0xFFE0504A) // searching / wrong-person → red (not following)
    }
    // pulse for WAITING (a slow breathing alpha so it reads as "holding, not lost")
    val pulse by androidx.compose.animation.core.rememberInfiniteTransition(label = "ffpulse").animateFloat(
        initialValue = 0.25f, targetValue = 0.9f,
        animationSpec = androidx.compose.animation.core.infiniteRepeatable(
            androidx.compose.animation.core.tween(900), androidx.compose.animation.core.RepeatMode.Reverse), label = "ffpulseA")
    Box(modifier = modifier.padding(8.dp).size(box).background(Color(0x66000000), androidx.compose.foundation.shape.RoundedCornerShape(8.dp))) {
        androidx.compose.foundation.Canvas(modifier = Modifier.fillMaxSize().padding(6.dp)) {
            val w = size.width; val h = size.height
            val cx = w / 2f; val cy = h / 2f
            drawCircle(Color(0x55FFFFFF), radius = 4f, center = androidx.compose.ui.geometry.Offset(cx, cy))
            drawLine(Color(0x33FFFFFF), androidx.compose.ui.geometry.Offset(cx, 0f), androidx.compose.ui.geometry.Offset(cx, h), strokeWidth = 1f)
            drawLine(Color(0x33FFFFFF), androidx.compose.ui.geometry.Offset(0f, cy), androidx.compose.ui.geometry.Offset(w, cy), strokeWidth = 1f)
            if (following) {
                // FOLLOWING the target: green (centered/LOCK) or amber (off-center/TRACK) dot.
                val px = cx + (faceX.coerceIn(-1f, 1f)) * (w / 2f)
                val py = cy + (faceY.coerceIn(-1f, 1f)) * (h / 2f)
                val dot = androidx.compose.ui.geometry.Offset(px, py)
                if (centered) {
                    val green = Color(0xFF49E07A)
                    drawLine(green, androidx.compose.ui.geometry.Offset(cx, cy), dot, strokeWidth = 2f)
                    drawCircle(green, radius = 7f, center = dot)
                    drawCircle(green, radius = 14f, center = dot, style = androidx.compose.ui.graphics.drawscope.Stroke(width = 2.5f))
                } else {
                    val amber = Color(0xFFE0B84A)
                    drawLine(amber, androidx.compose.ui.geometry.Offset(cx, cy), dot, strokeWidth = 2f)
                    drawCircle(amber, radius = 7f, center = dot)
                }
            } else if (wrongPerson) {
                // SEES SOMEONE, but NOT the target → a MUTED grey dot at their position (so it's
                // clearly "noticed, not following") + the red searching ring underneath.
                drawCircle(Color(0xFFE0504A), radius = w / 2.6f, center = androidx.compose.ui.geometry.Offset(cx, cy), style = androidx.compose.ui.graphics.drawscope.Stroke(width = 1.5f))
                val px = cx + (faceX.coerceIn(-1f, 1f)) * (w / 2f)
                val py = cy + (faceY.coerceIn(-1f, 1f)) * (h / 2f)
                drawCircle(Color(0x99AAAAAA), radius = 6f, center = androidx.compose.ui.geometry.Offset(px, py))
            } else if (waiting) {
                // WAITING: amber pulsing ring (holding the lost lock, not yet searching).
                drawCircle(Color(0xFFE0B84A).copy(alpha = pulse), radius = w / 2.6f, center = androidx.compose.ui.geometry.Offset(cx, cy), style = androidx.compose.ui.graphics.drawscope.Stroke(width = 2.5f))
            } else {
                // SEARCH: a solid red ring.
                drawCircle(Color(0xFFE0504A), radius = w / 2.6f, center = androidx.compose.ui.geometry.Offset(cx, cy), style = androidx.compose.ui.graphics.drawscope.Stroke(width = 2f))
            }
        }
        androidx.compose.material3.Text(
            text = label, color = labelColor, fontSize = 9.sp, fontWeight = FontWeight.Bold,
            modifier = Modifier.align(Alignment.BottomCenter).padding(bottom = 2.dp),
        )
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

/** Min gap between two palm-triggered actions (address / interrupt / stop). On
 *  top of the detector's own 1.2s palm cooldown — so a single palm raise maps to
 *  exactly ONE action, never a burst. */
private const val PALM_ACTION_DEBOUNCE_MS = 2_000L

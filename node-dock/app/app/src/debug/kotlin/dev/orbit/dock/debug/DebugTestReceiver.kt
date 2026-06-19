package dev.orbit.dock.debug

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import dev.orbit.dock.perception.PerceptionBus
import dev.orbit.dock.perception.PerceptionEvent
import timber.log.Timber

/**
 * DEBUG-ONLY test harness. Lets a developer (or an automated test driver)
 * trigger the dock's interaction flow over `adb shell am broadcast`, since
 * injecting taps into Compose via `adb input tap` is unreliable.
 *
 * Only compiled into debug builds (src/debug). Register via [register] from
 * the UI; it forwards broadcasts onto the PerceptionBus exactly as the real
 * tap/STT paths would.
 *
 * Usage (all actions prefixed dev.orbit.dock.debug.):
 *   adb shell am broadcast -a dev.orbit.dock.debug.LISTEN        # tap-to-start
 *   adb shell am broadcast -a dev.orbit.dock.debug.STOP          # tap-to-stop
 *   adb shell am broadcast -a dev.orbit.dock.debug.SAY -e text "look left and say hi"
 *                                                                # inject a final transcript
 *                                                                # (drives the agent as if heard)
 *   adb shell am broadcast -a dev.orbit.dock.debug.SPEAKING -e active true|false
 */
object DebugTestReceiver {

    private const val PREFIX = "dev.orbit.dock.debug."
    private var receiver: BroadcastReceiver? = null

    fun register(context: Context) {
        if (receiver != null) return
        val r = object : BroadcastReceiver() {
            override fun onReceive(ctx: Context?, intent: Intent?) {
                val action = intent?.action ?: return
                Timber.i("DEBUG broadcast: $action extras=${intent.extras?.keySet()}")
                when (action) {
                    "${PREFIX}LISTEN" ->
                        PerceptionBus.emit(PerceptionEvent.WakeWord(label = "(debug-listen)"))
                    "${PREFIX}ECHOLOOP" -> {
                        // Isolated AEC test: play a probe THROUGH WebRTC (its ADM
                        // renders it = the AEC reference) and capture the AEC'd mic
                        // → echo-loop-residual.wav. If WebRTC AEC cancels its own
                        // playback, the residual is silence. (EchoLoopTest.kt)
                        Timber.i("DEBUG echo-loop test")
                        (ctx ?: context).let { dev.orbit.dock.perception.EchoLoopTest.run(it) }
                    }
                    "${PREFIX}AECPOC" -> {
                        // A1 POC: production-style single ADM (VOICE_COMMUNICATION mic,
                        // SOFTWARE AEC) renders a loopback TTS track + records the AEC'd
                        // samplesReadyCallback mic (= what production sends the station).
                        // Silence residual → A1 works in the real ADM. (AecPocTest.kt)
                        Timber.i("DEBUG aec-poc test")
                        (ctx ?: context).let { dev.orbit.dock.perception.AecPocTest.run(it) }
                    }
                    "${PREFIX}AECPROD" -> {
                        // A1 PROD loopback test: feed a probe through the REAL
                        // WebRtcAudio.renderTtsPcm while live-streaming. Audible +
                        // station should NOT transcribe it. (AecPocTest.pumpThroughProduction)
                        Timber.i("DEBUG aec-prod loopback test")
                        (ctx ?: context).let { dev.orbit.dock.perception.AecPocTest.pumpThroughProduction(it) }
                    }
                    "${PREFIX}STOP" ->
                        PerceptionBus.emit(PerceptionEvent.StopListening)
                    "${PREFIX}SAY" -> {
                        val text = intent.getStringExtra("text").orEmpty()
                        Timber.i("DEBUG inject transcript: \"$text\"")
                        // Mimic STT producing a final transcript.
                        PerceptionBus.emit(PerceptionEvent.Transcript(text, isFinal = true))
                    }
                    "${PREFIX}BARGE" -> {
                        // Voice barge-in mid-speech (the chaos checklist's
                        // tap-to-stop-mid-sentence): same event the VAD emits
                        // when the user talks over TTS.
                        Timber.i("DEBUG barge-in")
                        PerceptionBus.emit(PerceptionEvent.BargeIn)
                    }
                    "${PREFIX}SPEAKING" -> {
                        val active = intent.getStringExtra("active")?.toBoolean() ?: false
                        PerceptionBus.emit(PerceptionEvent.Speaking(active = active))
                    }
                    "${PREFIX}EXIT" -> {
                        // Exercise the in-app Exit teardown path (same call the
                        // Exit button makes): full kill of service + notification
                        // + task. adb ... EXIT
                        Timber.i("DEBUG exit: tearing down")
                        ctx?.let { dev.orbit.dock.service.PerceptionService.exit(it) }
                    }
                    "${PREFIX}SETFACE" -> {
                        // Invoke set_face directly (skips the LLM turn) so the
                        // expression → config-driven body gesture → servos path
                        // is testable on-device:
                        //   adb ... SETFACE -e expression happy
                        val expr = intent.getStringExtra("expression").orEmpty()
                        Timber.i("DEBUG setFace: \"$expr\"")
                        val r = dev.orbit.dock.agent.ToolsTestController.tools?.setFace(expr)
                        Timber.i("DEBUG setFace result: $r")
                    }
                    "${PREFIX}SETFACESTYLE" -> {
                        // Switch the whole face appearance + voice (skips the LLM):
                        //   adb ... SETFACESTYLE -e style vader
                        val style = intent.getStringExtra("style").orEmpty()
                        Timber.i("DEBUG setFaceStyle: \"$style\"")
                        val r = dev.orbit.dock.agent.ToolsTestController.tools?.setFaceStyle(style)
                        Timber.i("DEBUG setFaceStyle result: $r")
                    }
                    "${PREFIX}DUMPFRAME" -> {
                        // Write the exact frame the dock would attach to a turn,
                        // so it can be pulled + eyeballed:
                        //   adb shell am broadcast -a dev.orbit.dock.debug.DUMPFRAME
                        //   adb pull /sdcard/Download/dock_frame.jpg
                        val b64 = dev.orbit.dock.perception.CameraFrameProvider.debugInstance?.latestJpegBase64()
                        if (b64 == null) {
                            Timber.w("DUMPFRAME: no frame available (camera off?)")
                        } else {
                            try {
                                val bytes = android.util.Base64.decode(b64, android.util.Base64.NO_WRAP)
                                // App-internal files dir: always writable, no
                                // storage permission needed (works on API 28+).
                                // Pull with:
                                //   adb shell run-as dev.orbit.dock cat files/dock_frame.jpg > frame.jpg
                                val f = java.io.File(context.filesDir, "dock_frame.jpg")
                                f.writeBytes(bytes)
                                Timber.i("DUMPFRAME: wrote ${bytes.size} bytes → ${f.absolutePath}")
                            } catch (t: Throwable) {
                                Timber.e(t, "DUMPFRAME failed")
                            }
                        }
                    }
                    "${PREFIX}FACE" -> {
                        // Inject a camera face sighting (+ optional emotion) so the
                        // grounded-perception path is testable on the emulator,
                        // whose virtual camera won't trip ML Kit face detection.
                        //   adb ... FACE -e x 0 -e y 0 -e emotion Happy
                        //   adb ... FACE -e lost true
                        if (intent.getStringExtra("lost")?.toBoolean() == true) {
                            PerceptionBus.emit(PerceptionEvent.FaceLost)
                        } else {
                            val x = intent.getStringExtra("x")?.toFloatOrNull() ?: 0f
                            val y = intent.getStringExtra("y")?.toFloatOrNull() ?: 0f
                            PerceptionBus.emit(PerceptionEvent.FaceSeen(x, y, size = 0.3f))
                            intent.getStringExtra("emotion")?.let { name ->
                                val kind = runCatching {
                                    PerceptionEvent.UserEmotion.Kind.valueOf(name)
                                }.getOrNull()
                                if (kind != null) {
                                    PerceptionBus.emit(PerceptionEvent.UserEmotion(kind, 0.9f))
                                }
                            }
                        }
                    }
                }
            }
        }
        val filter = IntentFilter().apply {
            addAction("${PREFIX}LISTEN")
            addAction("${PREFIX}ECHOLOOP")
            addAction("${PREFIX}AECPOC")
            addAction("${PREFIX}AECPROD")
            addAction("${PREFIX}STOP")
            addAction("${PREFIX}SAY")
            addAction("${PREFIX}SPEAKING")
            addAction("${PREFIX}BARGE")
            addAction("${PREFIX}SETFACE")
            addAction("${PREFIX}SETFACESTYLE")
            addAction("${PREFIX}EXIT")
            addAction("${PREFIX}FACE")
            addAction("${PREFIX}DUMPFRAME")
        }
        // RECEIVER_EXPORTED so `adb shell am broadcast` (a different uid) can
        // reach it. Debug builds only.
        if (android.os.Build.VERSION.SDK_INT >= 33) {
            context.registerReceiver(r, filter, Context.RECEIVER_EXPORTED)
        } else {
            @Suppress("UnspecifiedRegisterReceiverFlag")
            context.registerReceiver(r, filter)
        }
        receiver = r
        Timber.i("DebugTestReceiver registered — adb broadcasts active")
    }
}

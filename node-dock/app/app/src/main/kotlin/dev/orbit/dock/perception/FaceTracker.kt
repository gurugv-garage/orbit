package dev.orbit.dock.perception

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Bitmap
import android.graphics.Matrix
import android.util.Size
import androidx.camera.core.Camera
import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.ImageCapture
import androidx.camera.core.ImageCaptureException
import androidx.camera.core.ImageProxy
import androidx.camera.core.Preview
import androidx.camera.core.CameraState
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.core.content.ContextCompat
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.LifecycleRegistry
import com.google.mlkit.vision.common.InputImage
import com.google.mlkit.vision.face.Face
import com.google.mlkit.vision.face.FaceDetection
import com.google.mlkit.vision.face.FaceDetectorOptions
import com.google.mlkit.vision.face.FaceLandmark
import dev.orbit.dock.perception.PerceptionEvent.FaceLost
import dev.orbit.dock.perception.PerceptionEvent.FaceSeen
import timber.log.Timber
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong
import kotlin.coroutines.resume

/**
 * Front-camera face tracking. Emits [FaceSeen] / [FaceLost] events on
 * [PerceptionBus]. Coordinates are mirror-corrected (front camera) so the
 * face's "x" matches user perception: +1 = user's right, -1 = user's left.
 *
 * `start(lifecycleOwner)` must be called from a Context that has CAMERA
 * permission granted. `stop()` shuts the camera and the detector down.
 *
 * Uses ML Kit face-detection in FAST mode + landmark detection (eyes /
 * nose / mouth). Throttles emissions to ~12 Hz to avoid swamping the bus
 * — the gaze controller doesn't need 30 FPS.
 */
class FaceTracker(private val appContext: Context) : CameraFrameProvider, LifecycleOwner {

    // The camera is bound to THIS lifecycle, NOT the Activity's. A dock is a
    // kiosk: the camera ("the dock's eye") should stay live across transient
    // Activity stops (screen dim, brief background, the system reshuffling
    // camera priorities — `Camera2PresenceSrc onCameraAccessPrioritiesChanged`).
    // Binding to the Activity lifecycle made CameraX auto-close the camera on
    // ON_STOP, and the old start() guard never rebound it → the preview froze on
    // its last frame for the rest of the session (the bug this fixes). We drive
    // this registry to STARTED while running and never tear it down on a mere
    // Activity stop; only stop()/shutdown() ends it.
    private val lifecycleRegistry = LifecycleRegistry(this)
    override val lifecycle: Lifecycle get() = lifecycleRegistry

    // Latest camera frame as a base64 JPEG, kept for attaching to a vision LLM
    // turn. Updated (throttled) on the analyzer thread; read on the agent
    // thread. Volatile single-reference swap — no lock needed.
    @Volatile private var latestJpeg: String? = null

    /** [CameraFrameProvider]: most recent frame as base64 JPEG, or null. */
    override fun latestJpegBase64(): String? = latestJpeg

    /**
     * TELEMETRY (debug): a periodic snapshot of the detection pipeline's health, so we can
     * diagnose stream STALLS station-side without adb (the device USB is unreliable). The
     * owner wires this to publish over the station WS. Counters are reset each report.
     *  - framesIn:   ImageAnalysis frames the analyzer received (0 ⇒ CAMERA stalled)
     *  - facePasses: times the face detector actually RAN (0 with framesIn>0 ⇒ gate stuck)
     *  - faceHits:   passes that found ≥1 face
     *  - lastFaceMsAgo: ms since the last successful detection (climbing ⇒ blind)
     *  - intervalMs: the current ADAPTIVE analysis interval (how fast it's trying to run)
     */
    @Volatile var onTelemetry: ((framesIn: Int, facePasses: Int, faceHits: Int, lastFaceMsAgo: Long, intervalMs: Long) -> Unit)? = null
    private val telFramesIn = java.util.concurrent.atomic.AtomicInteger(0)
    private val telFacePasses = java.util.concurrent.atomic.AtomicInteger(0)
    private val telFaceHits = java.util.concurrent.atomic.AtomicInteger(0)
    private var telTimer: java.util.Timer? = null

    /**
     * Optional sink for the raw upright camera [Bitmap], invoked on the analyzer
     * thread (~1 Hz) right as each frame is captured — before JPEG encoding, so
     * the live WebRTC stream ([FaceFrameCapturer]) gets the decoded frame without
     * a re-decode. Null when nothing is streaming. The bitmap is reused/recycled
     * by the caller path, so the sink must copy what it needs synchronously
     * (FaceFrameCapturer converts to I420 immediately).
     */
    @Volatile var onBitmapFrame: ((Bitmap) -> Unit)? = null

    private val executor = Executors.newSingleThreadExecutor()
    private val detector = FaceDetection.getClient(
        FaceDetectorOptions.Builder()
            .setPerformanceMode(FaceDetectorOptions.PERFORMANCE_MODE_FAST)
            .setLandmarkMode(FaceDetectorOptions.LANDMARK_MODE_ALL)
            // ALL gives us smilingProbability + eyes-open probabilities —
            // the bridge that powers passive emotion mirroring (smile back
            // when the user smiles, look sleepy when their eyes droop).
            .setClassificationMode(FaceDetectorOptions.CLASSIFICATION_MODE_ALL)
            .setMinFaceSize(0.15f)
            .enableTracking()
            .build()
    )

    // EMA-smoothed probabilities and a hysteretic emotion tracker. ML Kit's
    // per-frame probabilities can flicker; smoothing + state-machine prevents
    // the dock's expression from twitching every frame.
    private var smileEma = 0f
    private var eyesOpenEma = 1f
    private var lastEmittedKind: PerceptionEvent.UserEmotion.Kind? = null
    private var lastEmotionEmitMs = 0L

    // FER+ classifier (8 emotions). Loaded lazily on the analyzer thread on
    // first successful face detection (no point loading the 35 MB asset if
    // nobody's in front of the dock yet).
    @Volatile private var fer: FerOnnx? = null
    @Volatile private var ferLoadAttempted = false
    private var lastFerNs = 0L
    // Per-class EMAs over softmax probabilities (8 classes).
    private val ferEma = FloatArray(FerOnnx.Emotion.entries.size)

    // Palm detector (MediaPipe Gesture Recognizer). Loaded lazily on the analyzer
    // thread on first frame, like FER+. Runs continuously, throttled to ~6 Hz
    // (PALM_INTERVAL_NS) for snappy edge-detection while leaving CPU for the
    // preview + face/FER path on a modest phone.
    @Volatile private var palm: PalmDetector? = null
    @Volatile private var palmLoadAttempted = false
    private var lastPalmNs = 0L

    private val running = AtomicBoolean(false)
    private val lastEmitNs = AtomicLong(0L)
    private val lastSeenMs = AtomicLong(0L)
    // ADAPTIVE analysis cadence (no fixed-rate guess). The face path runs as fast as the
    // phone can sustain WITHOUT starving the live preview: after each run we measure how long
    // the detect+FER+encode work actually took (EMA), and set the next gate to that cost ×
    // SLACK. A fast phone converges toward FACE_MIN_INTERVAL_NS (snappy ~5 Hz tracking); a
    // slow 2018 phone self-limits to whatever it can afford. Self-regulating → no per-device
    // tuning, and it tracks load (CPU busy ⇒ cost up ⇒ interval up) at runtime. The steadier,
    // higher cadence is exactly the bottleneck the perceive stream → faceFollow needs.
    @Volatile private var lastProcessNs = 0L
    @Volatile private var faceIntervalNs = FACE_START_INTERVAL_NS
    @Volatile private var faceCostEmaNs = FACE_START_INTERVAL_NS.toDouble()
    private var cameraProvider: ProcessCameraProvider? = null
    private var analysis: ImageAnalysis? = null
    private var imageCapture: ImageCapture? = null

    // The activity is sensorLandscape: it flips in-place between the two
    // landscape orientations (configChanges handles it, no recreate). CameraX's
    // setTargetRotation is captured once at bind() and would go stale after a
    // 180° flip — the analysis/capture frames sent to the station would arrive
    // upside-down. This listener re-pushes the live display rotation into every
    // bound use-case whenever the display rotates, keeping frames upright.
    private var displayListener: android.hardware.display.DisplayManager.DisplayListener? = null

    // Optional on-screen preview. The UI's PreviewView hands us its
    // SurfaceProvider; we bind a CameraX Preview use-case alongside the
    // analyzer so the dock can show a live thumbnail of what it sees. Null when
    // no preview is mounted (headless / preview hidden).
    @Volatile private var surfaceProvider: Preview.SurfaceProvider? = null
    private var preview: Preview? = null

    // Latest CameraX zoom framing (read off the bound Camera's zoomState). Carried in
    // the rich PerceiveFrame so the station always knows current framing. Defaults are
    // a no-zoom 1× until a camera is bound. Updated on bind + on zoomState change.
    @Volatile private var zoomRatio = 1f
    @Volatile private var zoomMin = 1f
    @Volatile private var zoomMax = 1f
    // The currently bound Camera — retained so the brain's set_zoom tool can drive
    // cameraControl.setZoomRatio(). Rebound (and re-set) on every bind(); null before start.
    @Volatile private var boundCamera: Camera? = null

    /** Attach (or detach, with null) the on-screen preview surface. Safe to call
     *  before or after [start]; rebinds the camera to include the preview. */
    fun setPreviewSurface(provider: Preview.SurfaceProvider?) {
        surfaceProvider = provider
        val cp = cameraProvider
        if (cp != null) {
            ContextCompat.getMainExecutor(appContext).execute { bind(cp) }
        }
    }

    /**
     * Actuate the camera zoom (the brain's `set_zoom` tool). [ratio] is an absolute
     * factor, clamped to the bound camera's supported [zoomMin]..[zoomMax]. The actual
     * setZoomRatio call is dispatched to the main executor (CameraControl requires it)
     * and completes asynchronously; we return a human-readable result immediately with
     * the CLAMPED value we applied — the zoomState observer then confirms it upstream.
     * Returns an "unavailable" sentinel (starts with "no ") if no camera is bound.
     */
    fun setZoom(ratio: Float): String {
        val cam = boundCamera ?: return "no camera bound right now — can't zoom"
        val clamped = ratio.coerceIn(zoomMin, zoomMax)
        ContextCompat.getMainExecutor(appContext).execute {
            runCatching { cam.cameraControl.setZoomRatio(clamped) }
                .onFailure { Timber.w(it, "FaceTracker: setZoomRatio($clamped) failed") }
        }
        val maxStr = String.format("%.1f", zoomMax)
        return "zoom set to ${String.format("%.1f", clamped)}× (max ${maxStr}×)"
    }

    /**
     * Start (or re-assert) face tracking. Idempotent and RE-BINDABLE: if already
     * running it just rebinds the current provider — it does NOT dead-end the way
     * the old `running` guard did (which left the camera unbound forever after a
     * stop/start race). The [owner] parameter is kept for the call-site contract
     * (callers invoke this from a CAMERA-permitted Context) but the camera is
     * bound to our own [lifecycleRegistry], not [owner], so a transient Activity
     * stop can't kill the eye.
     */
    @SuppressLint("MissingPermission")
    fun start(owner: LifecycleOwner) {
        // Drive our lifecycle to STARTED (idempotent — re-setting the same state
        // is a no-op in LifecycleRegistry). Must run on the main thread.
        ContextCompat.getMainExecutor(appContext).execute {
            if (lifecycleRegistry.currentState != Lifecycle.State.STARTED) {
                lifecycleRegistry.currentState = Lifecycle.State.STARTED
            }
        }
        running.set(true)
        startTelemetry()
        startDisplayListener()
        val existing = cameraProvider
        if (existing != null) {
            // Already have a provider — just rebind (e.g. start() called again
            // after a config flap, or to re-include a newly-mounted preview).
            ContextCompat.getMainExecutor(appContext).execute { bind(existing) }
            return
        }
        val providerFuture = ProcessCameraProvider.getInstance(appContext)
        providerFuture.addListener({
            try {
                if (!running.get()) return@addListener // stopped while we waited
                val provider = providerFuture.get()
                cameraProvider = provider
                bind(provider)
                PerceptionBus.emit(PerceptionEvent.Status("face", "watching"))
            } catch (t: Throwable) {
                Timber.e(t, "FaceTracker bind failed")
                PerceptionBus.emit(PerceptionEvent.Error("face", t))
                running.set(false)
            }
        }, ContextCompat.getMainExecutor(appContext))
    }

    /** Periodic (1 Hz) detection-health report over the telemetry sink, so a stream STALL is
     *  visible station-side: framesIn=0 ⇒ camera stopped; framesIn>0 but facePasses=0 ⇒ gate
     *  stuck; faceHits=0 with you in view ⇒ detector blind. Counters reset each tick. */
    private fun startTelemetry() {
        if (telTimer != null) return
        telTimer = java.util.Timer("ft-telemetry", true).also { t ->
            t.scheduleAtFixedRate(object : java.util.TimerTask() {
                override fun run() {
                    val sink = onTelemetry ?: return
                    val fi = telFramesIn.getAndSet(0)
                    val fp = telFacePasses.getAndSet(0)
                    val fh = telFaceHits.getAndSet(0)
                    val last = lastSeenMs.get()
                    val ago = if (last == 0L) -1L else System.currentTimeMillis() - last
                    val intervalMs = faceIntervalNs / 1_000_000L
                    try { sink(fi, fp, fh, ago, intervalMs) } catch (t: Throwable) { Timber.w(t, "telemetry sink failed") }
                }
            }, 1000L, 1000L)
        }
    }

    private fun stopTelemetry() {
        telTimer?.cancel(); telTimer = null
    }

    /** Watch for display-rotation changes and re-target the bound use-cases, so a
     *  180° landscape flip keeps camera frames upright. Registered on the main
     *  thread; idempotent. */
    private fun startDisplayListener() {
        if (displayListener != null) return
        val dm = appContext.getSystemService(android.content.Context.DISPLAY_SERVICE)
            as? android.hardware.display.DisplayManager ?: return
        val main = ContextCompat.getMainExecutor(appContext)
        val listener = object : android.hardware.display.DisplayManager.DisplayListener {
            override fun onDisplayAdded(displayId: Int) {}
            override fun onDisplayRemoved(displayId: Int) {}
            override fun onDisplayChanged(displayId: Int) {
                val rot = runCatching {
                    val wm = appContext.getSystemService(android.content.Context.WINDOW_SERVICE) as android.view.WindowManager
                    wm.defaultDisplay.rotation
                }.getOrDefault(android.view.Surface.ROTATION_0)
                // setTargetRotation must run on the main thread.
                main.execute {
                    analysis?.targetRotation = rot
                    imageCapture?.targetRotation = rot
                    preview?.targetRotation = rot
                }
            }
        }
        main.execute { runCatching { dm.registerDisplayListener(listener, null) } }
        displayListener = listener
    }

    private fun stopDisplayListener() {
        val l = displayListener ?: return
        val dm = appContext.getSystemService(android.content.Context.DISPLAY_SERVICE)
            as? android.hardware.display.DisplayManager
        runCatching { dm?.unregisterDisplayListener(l) }
        displayListener = null
    }

    fun stop() {
        if (!running.getAndSet(false)) return
        stopTelemetry()
        stopDisplayListener()
        ContextCompat.getMainExecutor(appContext).execute {
            // CREATED (not DESTROYED) so the same FaceTracker can be start()ed
            // again later; CameraX unbinds use-cases when we drop below STARTED.
            lifecycleRegistry.currentState = Lifecycle.State.CREATED
            try {
                cameraProvider?.unbindAll()
            } catch (_: Throwable) {}
            cameraProvider = null
            analysis = null
            imageCapture = null
            preview = null
        }
        PerceptionBus.emit(FaceLost)
    }

    fun shutdown() {
        stop()
        ContextCompat.getMainExecutor(appContext).execute {
            lifecycleRegistry.currentState = Lifecycle.State.DESTROYED
        }
        try { detector.close() } catch (_: Throwable) {}
        try { fer?.close() } catch (_: Throwable) {}
        fer = null
        try { palm?.close() } catch (_: Throwable) {}
        palm = null
        executor.shutdown()
    }

    private fun bind(provider: ProcessCameraProvider) {
        if (!running.get()) return
        provider.unbindAll()
        val selector = CameraSelector.Builder()
            .requireLensFacing(CameraSelector.LENS_FACING_FRONT)
            .build()
        // Target the current DISPLAY rotation so CameraX's rotationDegrees makes
        // each frame upright relative to how the app is shown — device-agnostic,
        // no hardcoded per-device rotation constant (the emulator needed 180°,
        // the Redmi needed 0°; this computes the right value from the display).
        val displayRotation = runCatching {
            val wm = appContext.getSystemService(android.content.Context.WINDOW_SERVICE) as android.view.WindowManager
            wm.defaultDisplay.rotation
        }.getOrDefault(android.view.Surface.ROTATION_0)
        val a = ImageAnalysis.Builder()
            .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
            // 512×384 analysis frames (this is ALSO what feeds recognition
            // photos + the vision LLM, downscaled to ≤512px in
            // encodeJpegBase64). Bumped up from 320×240: the vision model
            // hallucinates objects below ~512px (see docs/perception-pipeline.md
            // and vision-instruction.ts) — this is the resolution the docs
            // always intended. NOTE: keep this and encodeJpegBase64's maxEdge in
            // lockstep, or the frame gets re-downscaled to 320 before the model
            // sees it and the change is invisible. Gallery match thresholds
            // (perception/index.ts MATCH/TENTATIVE) were tuned against 320px
            // crops — re-validate recognition reliability at this size. Extra
            // ISP + WebRTC bandwidth cost on a 2018-class phone.
            .setTargetResolution(Size(512, 384))
            .setTargetRotation(displayRotation)
            .build()
        a.setAnalyzer(executor) { proxy -> process(proxy) }
        analysis = a

        // Optional preview use-case for the on-screen thumbnail. Pin it to a
        // TINY resolution — it's only a ~96dp thumbnail, and analysis is the
        // priority stream (resource-constrained device). Left unconstrained,
        // CameraX picks a large (~1080p) preview surface: a wasteful second
        // camera stream that strains the 2018 ISP. A small surface keeps the
        // two-stream cost down. Preview quality is intentionally low.
        // On-demand high-res still for face RECOGNITION photos (recollect /
        // enroll / confirm). The continuous analysis stream stays small (gaze/
        // emotion don't need pixels and run every second on phone CPU); a still
        // is taken only a few times per conversation, so the station gets a
        // face big enough to embed reliably at zero steady-state cost.
        // preview + analysis + capture is a guaranteed CameraX combination.
        val cap = ImageCapture.Builder()
            .setCaptureMode(ImageCapture.CAPTURE_MODE_MINIMIZE_LATENCY)
            .setTargetResolution(Size(640, 480))
            .setTargetRotation(displayRotation)
            .build()
        imageCapture = cap

        val sp = surfaceProvider
        val useCases = if (sp != null) {
            val p = Preview.Builder()
                .setTargetResolution(Size(240, 320))
                .setTargetRotation(displayRotation)
                .build()
                .also { it.setSurfaceProvider(sp) }
            preview = p
            arrayOf(a, cap, p)
        } else {
            preview = null
            arrayOf(a, cap)
        }
        val camera = provider.bindToLifecycle(this, selector, *useCases)
        boundCamera = camera  // for set_zoom actuation

        // DEFENCE IN DEPTH: even bound to our own (always-STARTED) lifecycle, the
        // camera can still be evicted by the OS — another app opens the front
        // camera, or the HAL drops it. CameraX won't auto-recover from an
        // OPEN-failed/closed state on its own. Observe CameraState and rebind the
        // moment it lands in a recoverable error so the eye self-heals instead of
        // freezing on its last frame.
        // Track CameraX zoom framing for the PerceiveFrame (read-only this build).
        camera.cameraInfo.zoomState.observe(this) { z ->
            if (z != null) { zoomRatio = z.zoomRatio; zoomMin = z.minZoomRatio; zoomMax = z.maxZoomRatio }
        }
        camera.cameraInfo.cameraState.observe(this) { state ->
            val err = state.error
            if (err != null && state.type == CameraState.Type.CLOSED) {
                Timber.w("FaceTracker: camera CLOSED (error code=${err.code}) — rebinding")
                if (running.get()) {
                    ContextCompat.getMainExecutor(appContext).execute {
                        cameraProvider?.let { bind(it) }
                    }
                }
            }
        }
    }

    /**
     * One high-res still for a recognition request, as base64 JPEG (≤[maxEdge]
     * on the long side) — FRESH (taken now, not the ~1s-old analysis frame) and
     * with ~4× the face pixels of the 320×240 stream. Returns null when the
     * camera isn't bound or capture fails; callers fall back to
     * [latestJpegBase64].
     */
    suspend fun captureRecognitionJpegBase64(maxEdge: Int = 640, quality: Int = 80): String? {
        val cap = imageCapture ?: return null
        return try {
            kotlinx.coroutines.suspendCancellableCoroutine { cont ->
                cap.takePicture(executor, object : ImageCapture.OnImageCapturedCallback() {
                    override fun onCaptureSuccess(proxy: ImageProxy) {
                        val b64 = try {
                            proxy.toBitmap().rotated(proxy.imageInfo.rotationDegrees)
                                .let { encodeJpegBase64(it, maxEdge, quality) }
                        } catch (t: Throwable) {
                            Timber.w(t, "hi-res capture decode failed")
                            null
                        } finally {
                            proxy.close()
                        }
                        if (cont.isActive) cont.resume(b64)
                    }

                    override fun onError(e: ImageCaptureException) {
                        Timber.w(e, "hi-res capture failed")
                        if (cont.isActive) cont.resume(null)
                    }
                })
            }
        } catch (t: Throwable) {
            Timber.w(t, "hi-res capture path failed")
            null
        }
    }

    @androidx.camera.core.ExperimentalGetImage
    private fun process(proxy: ImageProxy) {
        telFramesIn.incrementAndGet() // a frame arrived from the camera (telemetry)
        val media = proxy.image
        if (media == null) {
            proxy.close()
            return
        }
        // TWO cadences share ONE decode. The palm detector runs at a fast rate
        // for snappy rising-edge response (~6 Hz, PALM_INTERVAL_NS); the heavy
        // face/FER/JPEG work runs at an ADAPTIVE interval (faceIntervalNs) that
        // floats with measured cost so it goes as fast as the phone affords without
        // starving the preview. Skip the (costly) toBitmap decode entirely when
        // NEITHER is due.
        val nowNsGate = System.nanoTime()
        val palmDue = nowNsGate - lastPalmNs >= PALM_INTERVAL_NS
        val faceDue = nowNsGate - lastProcessNs >= faceIntervalNs
        if (!palmDue && !faceDue) {
            proxy.close()
            return
        }
        val rotation = proxy.imageInfo.rotationDegrees
        // Copy the frame to a bitmap and RELEASE the camera buffer immediately.
        // Previously the proxy stayed open across the whole ML Kit detection
        // (InputImage.fromMediaImage wraps the proxy buffer, closed only in
        // addOnCompleteListener) — holding a scarce camera buffer for ~tens of
        // ms starved the live preview on this 2018 ISP (preview went smooth the
        // moment the analyzer was removed). Detecting from the copy lets us
        // close() in microseconds so the preview keeps its buffers.
        val bitmap: Bitmap? = try {
            proxy.toBitmap().rotated(rotation)
        } catch (t: Throwable) {
            Timber.w(t, "proxy.toBitmap() failed")
            null
        }
        proxy.close()
        if (bitmap == null) return

        // PALM DETECTION (MediaPipe) — the fast path, on the upright bitmap,
        // independent of face detection (a palm shouldn't require a detected
        // face). Lazy-loaded on first frame.
        if (palmDue) {
            lastPalmNs = nowNsGate
            runPalmDetection(bitmap)
        }

        // Everything below is the heavy ~1 Hz face/emotion/vision path.
        if (!faceDue) return
        lastProcessNs = nowNsGate
        telFacePasses.incrementAndGet() // the face detector is about to run (telemetry)

        val imgW = bitmap.width.toFloat()
        val imgH = bitmap.height.toFloat()
        // Recent frame as a base64 JPEG for vision LLM turns (downscaled).
        latestJpeg = encodeJpegBase64(uprightForVision(bitmap))
        // Feed the live stream (if any) the same upright frame, pre-JPEG.
        onBitmapFrame?.let { sink -> try { sink(uprightForVision(bitmap)) } catch (t: Throwable) { Timber.w(t, "frame sink failed") } }

        // Detect from the bitmap copy (rotation already applied → 0 here). On completion,
        // measure the FULL face-path cost (gate→callback: encode + async detect + FER) and
        // adapt the next interval from it — run as fast as that cost × SLACK allows, clamped.
        detector.process(InputImage.fromBitmap(bitmap, 0))
            .addOnSuccessListener { faces -> onFaces(faces, imgW, imgH, bitmap) }
            .addOnFailureListener { t -> Timber.w(t, "face detect failed") }
            .addOnCompleteListener { adaptFaceInterval(System.nanoTime() - nowNsGate) }
    }

    /** Re-derive the adaptive analysis interval from the measured cost of this face-path run.
     *  EMA-smoothed so a single slow frame doesn't lurch the cadence; next interval = cost ×
     *  SLACK (headroom for the preview), clamped to [MIN, MAX]. Self-regulating: idle phone
     *  → fast; busy phone or heavy frame → backs off automatically. No per-device constant. */
    private fun adaptFaceInterval(costNs: Long) {
        faceCostEmaNs = faceCostEmaNs * (1.0 - FACE_COST_ALPHA) + costNs.toDouble() * FACE_COST_ALPHA
        val target = (faceCostEmaNs * FACE_SLACK).toLong()
        faceIntervalNs = target.coerceIn(FACE_MIN_INTERVAL_NS, FACE_MAX_INTERVAL_NS)
    }

    private fun onFaces(faces: List<Face>, imgW: Float, imgH: Float, bitmap: Bitmap?) {
        if (imgW <= 0f || imgH <= 0f) return
        val now = System.currentTimeMillis()
        val nowNs = System.nanoTime()
        if (faces.isEmpty()) {
            // Emit Lost only if it's been quiet for >500 ms (avoid flapping).
            val last = lastSeenMs.get()
            if (last != 0L && now - last > 500L) {
                lastSeenMs.set(0L)
                PerceptionBus.emit(FaceLost)
            }
            return
        }
        lastSeenMs.set(now)
        telFaceHits.incrementAndGet() // this pass found a face (telemetry)
        // (Frame rate is already gated to ~2 Hz in process(), so no extra
        // emit throttle is needed here — every analyzed frame emits.)

        // RICH per-frame detail for ALL faces → the station `perceive` stream (the fast
        // face source for faceFollow + the pipeline). Everything below is already computed
        // by the single detection pass; we just stop discarding it. NDC + mirror-corrected,
        // matching FaceSeen's convention. The forwarder dedups/throttles before the wire.
        PerceptionBus.emit(buildPerceiveFrame(faces, imgW, imgH))

        val face = faces.maxByOrNull { it.boundingBox.width().toLong() * it.boundingBox.height() }
            ?: return
        val box = face.boundingBox
        val cxRaw = (box.left + box.right) * 0.5f
        val cyRaw = (box.top + box.bottom) * 0.5f
        // Front-cam mirror: flip x.
        val ndcX = ((imgW - cxRaw) / imgW * 2f - 1f).coerceIn(-1f, 1f)
        val ndcY = (cyRaw / imgH * 2f - 1f).coerceIn(-1f, 1f)
        val size = (box.width() / imgW).coerceIn(0f, 1f)
        PerceptionBus.emit(FaceSeen(x = ndcX, y = ndcY, size = size))

        // ML Kit signals — kept as a cheap fallback for Sleepy (eyes closed
        // can't be reliably read from FER's 64x64 grayscale crop) and as a
        // bootstrap before FER finishes loading.
        val smile = face.smilingProbability ?: -1f
        val leftEye = face.leftEyeOpenProbability ?: -1f
        val rightEye = face.rightEyeOpenProbability ?: -1f
        if (smile >= 0f) smileEma = smileEma * 0.78f + smile * 0.22f
        if (leftEye >= 0f && rightEye >= 0f) {
            val eyeAvg = (leftEye + rightEye) / 2f
            eyesOpenEma = eyesOpenEma * 0.78f + eyeAvg * 0.22f
        }

        // FER+ inference — heavier than ML Kit so throttled to ~3 Hz. Runs
        // on the analyzer thread (same as detector callbacks). Loads lazily
        // on the first face-seen frame.
        val ferIntervalNs = 330_000_000L
        if (!ferLoadAttempted) {
            ferLoadAttempted = true
            fer = FerOnnx.fromAssets(appContext)
        }
        val ferEngine = fer
        if (ferEngine != null && bitmap != null && nowNs - lastFerNs >= ferIntervalNs) {
            lastFerNs = nowNs
            runFer(ferEngine, bitmap, box, imgW.toInt(), imgH.toInt())
        }

        val kind = classifyEmotion()
        // LEVEL-triggered, not edge-triggered. This used to fire only on a CHANGE
        // of kind (`kind != lastEmittedKind`), so a sustained expression emitted
        // exactly ONCE. The consumer (EmotionGate) debounces on persistence — it
        // needs to see a read HELD across several samples before reacting — so a
        // single emit could never satisfy it and the dock never reacted to a
        // steady face. Re-emit the current read every ~700ms while a face is in
        // frame; a change still fires immediately (the 300ms floor below).
        val changed = kind != lastEmittedKind
        if ((changed && now - lastEmotionEmitMs > 300L) || now - lastEmotionEmitMs > 700L) {
            lastEmittedKind = kind
            lastEmotionEmitMs = now
            val conf = when (kind) {
                PerceptionEvent.UserEmotion.Kind.Sleepy -> 1f - eyesOpenEma
                PerceptionEvent.UserEmotion.Kind.Happy ->
                    maxOf(ferEma[FerOnnx.Emotion.Happiness.ordinal], smileEma)
                PerceptionEvent.UserEmotion.Kind.Sad ->
                    ferEma[FerOnnx.Emotion.Sadness.ordinal]
                PerceptionEvent.UserEmotion.Kind.Surprised ->
                    ferEma[FerOnnx.Emotion.Surprise.ordinal]
                PerceptionEvent.UserEmotion.Kind.Angry ->
                    ferEma[FerOnnx.Emotion.Anger.ordinal]
                PerceptionEvent.UserEmotion.Kind.Neutral ->
                    ferEma[FerOnnx.Emotion.Neutral.ordinal]
            }
            PerceptionBus.emit(PerceptionEvent.UserEmotion(kind, conf.coerceIn(0f, 1f)))
        }
    }

    /**
     * Build the rich [PerceiveFrame] from MLKit's per-face output. Coordinates are NDC
     * (−1..+1), mirror-corrected for the front cam (flip x), matching [FaceSeen]. All
     * values come straight from the [Face] objects MLKit already produced — Euler angles,
     * trackingId, classification probabilities, and the (up to 11) landmark points.
     */
    private fun buildPerceiveFrame(faces: List<Face>, imgW: Float, imgH: Float): PerceptionEvent.PerceiveFrame {
        // x is mirrored (front cam): pxX → NDC with a horizontal flip. y is straight.
        fun ndcX(px: Float) = ((imgW - px) / imgW * 2f - 1f).coerceIn(-1f, 1f)
        fun ndcY(px: Float) = (px / imgH * 2f - 1f).coerceIn(-1f, 1f)
        val details = faces.map { f ->
            val b = f.boundingBox
            val cx = (b.left + b.right) * 0.5f
            val cy = (b.top + b.bottom) * 0.5f
            // bbox: after the x-flip, the box's left/right SWAP (mirror), so bl = flipped right.
            val bl = ndcX(b.right.toFloat()); val br = ndcX(b.left.toFloat())
            val bt = ndcY(b.top.toFloat());  val bb = ndcY(b.bottom.toFloat())
            val lms = f.allLandmarks.mapNotNull { lm ->
                val p = lm.position
                PerceptionEvent.PerceiveFrame.Landmark(landmarkName(lm.landmarkType), ndcX(p.x), ndcY(p.y))
            }
            PerceptionEvent.PerceiveFrame.FaceDetail(
                x = ndcX(cx), y = ndcY(cy), size = (b.width() / imgW).coerceIn(0f, 1f),
                bl = bl, bt = bt, br = br, bb = bb,
                // Front-cam mirror flips the sense of YAW (left/right) and ROLL; pitch is unaffected.
                yaw = -f.headEulerAngleY, pitch = f.headEulerAngleX, roll = -f.headEulerAngleZ,
                trackingId = f.trackingId,
                smile = f.smilingProbability, leftEyeOpen = f.leftEyeOpenProbability,
                rightEyeOpen = f.rightEyeOpenProbability,
                landmarks = lms,
            )
        }
        return PerceptionEvent.PerceiveFrame(details, zoomRatio, zoomMin, zoomMax)
    }

    /**
     * Feed one upright frame to the palm detector (lazy-loaded on first call).
     * Runs synchronously on the analyzer thread (MediaPipe IMAGE mode), like the
     * ML Kit/FER work. Cheap no-op if the model failed to load (palm stays
     * disabled, everything else unaffected).
     *
     * Note: this is gated FASTER than the face path (PALM_INTERVAL_NS ≈ 6 Hz) so
     * a palm raise is caught promptly; the heavier face/FER/JPEG work stays ~1 Hz.
     */
    private fun runPalmDetection(bitmap: Bitmap) {
        if (!palmLoadAttempted) {
            palmLoadAttempted = true
            palm = PalmDetector.fromAssets(appContext)
        }
        val p = palm ?: return
        p.onFrame(bitmap, System.currentTimeMillis())
    }

    /**
     * Run FER+ on a 1.4× expanded crop around the face bounding box. The
     * model was trained on faces with some forehead/chin margin, so a tight
     * bbox crop performs noticeably worse than a slightly padded one.
     */
    private fun runFer(
        engine: FerOnnx,
        bitmap: Bitmap,
        box: android.graphics.Rect,
        bmpW: Int,
        bmpH: Int,
    ) {
        try {
            val cx = (box.left + box.right) / 2
            val cy = (box.top + box.bottom) / 2
            val side = (maxOf(box.width(), box.height()) * 1.35f).toInt()
            val left = (cx - side / 2).coerceIn(0, bmpW - 1)
            val top = (cy - side / 2).coerceIn(0, bmpH - 1)
            val right = (cx + side / 2).coerceIn(left + 1, bmpW)
            val bottom = (cy + side / 2).coerceIn(top + 1, bmpH)
            val crop = Bitmap.createBitmap(bitmap, left, top, right - left, bottom - top)
            val result = engine.classify(crop)
            crop.recycle()
            if (result != null) {
                val alpha = 0.35f
                for (i in ferEma.indices) {
                    ferEma[i] = ferEma[i] * (1f - alpha) + result.probs[i] * alpha
                }
            }
        } catch (t: Throwable) {
            Timber.w(t, "FER crop/inference path failed")
        }
    }

    /**
     * Combine FER+ EMAs and ML Kit eyes-open into the coarse Kind enum the
     * UI uses. ML Kit's eyes-open is more reliable than FER's contempt
     * /disgust signals on small face crops, so Sleepy wins early.
     */
    private fun classifyEmotion(): PerceptionEvent.UserEmotion.Kind {
        if (eyesOpenEma < 0.32f) return PerceptionEvent.UserEmotion.Kind.Sleepy

        // FER probabilities not yet populated? Fall back to smile signal.
        val ferActive = ferEma.any { it > 0.01f }
        if (!ferActive) {
            return if (smileEma > 0.6f) PerceptionEvent.UserEmotion.Kind.Happy
            else PerceptionEvent.UserEmotion.Kind.Neutral
        }

        // Find FER top class with a minimum confidence to avoid noise.
        val topIdx = ferEma.indices.maxBy { ferEma[it] }
        val topProb = ferEma[topIdx]
        if (topProb < 0.35f) return PerceptionEvent.UserEmotion.Kind.Neutral
        return when (FerOnnx.Emotion.entries[topIdx]) {
            FerOnnx.Emotion.Happiness -> PerceptionEvent.UserEmotion.Kind.Happy
            FerOnnx.Emotion.Sadness -> PerceptionEvent.UserEmotion.Kind.Sad
            FerOnnx.Emotion.Anger -> PerceptionEvent.UserEmotion.Kind.Angry
            FerOnnx.Emotion.Surprise -> PerceptionEvent.UserEmotion.Kind.Surprised
            FerOnnx.Emotion.Disgust, FerOnnx.Emotion.Fear,
            FerOnnx.Emotion.Contempt, FerOnnx.Emotion.Neutral ->
                PerceptionEvent.UserEmotion.Kind.Neutral
        }
    }
}

// ADAPTIVE face-analysis cadence — bounds + tuning for the self-regulating interval
// (see faceIntervalNs / adaptFaceInterval). The interval floats between MIN (fast phone,
// cheap frame) and MAX (slow phone / heavy load) at cost × SLACK, so there is NO single
// per-device rate constant to get wrong.
/** Fastest the face path may run (~5 Hz) — snappy enough for smooth head-follow. */
private const val FACE_MIN_INTERVAL_NS = 200_000_000L
/** Slowest it falls back to (~2 Hz) when the phone is heavily loaded — still presence-useful. */
private const val FACE_MAX_INTERVAL_NS = 500_000_000L
/** Where the adaptation STARTS before any cost is measured (~3 Hz). */
private const val FACE_START_INTERVAL_NS = 333_000_000L
/** Headroom multiplier: next interval = measured cost × this, leaving CPU for the preview. */
private const val FACE_SLACK = 1.6
/** EMA weight for the measured-cost smoothing (higher = reacts faster to load changes). */
private const val FACE_COST_ALPHA = 0.3

/** ~6 Hz palm-detection cadence (165 ms) — snappy rising-edge response to a palm
 *  raise. Only the (cheap) frame decode + MediaPipe gesture pass run at this rate;
 *  the heavy ML Kit/FER/JPEG work stays at ANALYSIS_INTERVAL_NS. Tune down if the
 *  preview suffers on a smaller phone. */
private const val PALM_INTERVAL_NS = 165_000_000L

/**
 * Front camera + landscape-locked activity = a fixed, known mis-orientation:
 * the detector bitmap (upright for natural portrait) ends up rotated 90° and
 * horizontally mirrored relative to how a human reads the scene. Deterministic
 * correction (no LLM — see the orientation investigation): rotate by
 * [VISION_EXTRA_ROTATION] then mirror if [VISION_MIRROR]. Constants so a single
 * tune covers a given mount; tuned empirically against a dumped frame.
 */
// With ImageAnalysis.setTargetRotation(display) (see bind()), CameraX's
// rotationDegrees already makes the frame upright relative to the app's
// display, on any device — so no extra rotation is needed. Mirroring is left
// off: the model should see the true (un-mirrored) scene; a self-view mirror is
// only a UX nicety and would flip text. Kept as constants in case a specific
// mount still needs a nudge.
private const val VISION_EXTRA_ROTATION = 0
private const val VISION_MIRROR = false

/** MLKit FaceLandmark type int → a short stable name for the perceive wire. */
private fun landmarkName(type: Int): String = when (type) {
    FaceLandmark.LEFT_EYE -> "leftEye"
    FaceLandmark.RIGHT_EYE -> "rightEye"
    FaceLandmark.LEFT_EAR -> "leftEar"
    FaceLandmark.RIGHT_EAR -> "rightEar"
    FaceLandmark.LEFT_CHEEK -> "leftCheek"
    FaceLandmark.RIGHT_CHEEK -> "rightCheek"
    FaceLandmark.NOSE_BASE -> "noseBase"
    FaceLandmark.MOUTH_LEFT -> "mouthLeft"
    FaceLandmark.MOUTH_RIGHT -> "mouthRight"
    FaceLandmark.MOUTH_BOTTOM -> "mouthBottom"
    else -> "lm$type"
}

private fun uprightForVision(src: Bitmap): Bitmap {
    val m = android.graphics.Matrix()
    if (VISION_EXTRA_ROTATION != 0) m.postRotate(VISION_EXTRA_ROTATION.toFloat())
    if (VISION_MIRROR) m.postScale(-1f, 1f)
    if (m.isIdentity) return src
    return Bitmap.createBitmap(src, 0, 0, src.width, src.height, m, true)
}

/**
 * Downscale to a vision-friendly size and JPEG-encode to base64. ~512px on the
 * long edge + quality 70 keeps a face/scene legible to the vision model (the
 * model hallucinates objects below ~512px) while keeping the prompt reasonable
 * (typically a few KB). Kept in lockstep with the analysis capture resolution
 * (FaceTracker bind()) so frames aren't needlessly re-downscaled. Returns null
 * on failure.
 */
private fun encodeJpegBase64(src: Bitmap, maxEdge: Int = 512, quality: Int = 70): String? = try {
    val scale = maxEdge.toFloat() / maxOf(src.width, src.height)
    val bmp = if (scale < 1f) {
        Bitmap.createScaledBitmap(src, (src.width * scale).toInt(), (src.height * scale).toInt(), true)
    } else src
    val out = java.io.ByteArrayOutputStream()
    bmp.compress(Bitmap.CompressFormat.JPEG, quality, out)
    if (bmp !== src) bmp.recycle()
    android.util.Base64.encodeToString(out.toByteArray(), android.util.Base64.NO_WRAP)
} catch (t: Throwable) {
    Timber.w(t, "encodeJpegBase64 failed")
    null
}

/** Rotate a Bitmap by an integer number of degrees. Returns the same
 *  bitmap if rotation is 0 (cheap no-op). */
private fun Bitmap.rotated(degrees: Int): Bitmap {
    if (degrees == 0) return this
    val m = Matrix().apply { postRotate(degrees.toFloat()) }
    val rotated = Bitmap.createBitmap(this, 0, 0, width, height, m, true)
    if (rotated !== this) recycle()
    return rotated
}

# Findings: on-device MediaPipe gesture + pose detection (client-side)

**Status:** investigation only — not implemented. Captured 2026-06-12.

## Why this came up

The dock's LLM brain moved server-side (the phone is now FACE + perception + a thin
`RemoteBrain` facade — no local agent loop). That freed the CPU/thermal budget the local
LLM used to consume, which makes on-device vision detection viable for the first time.

Question asked: can we now add client-side detections — specifically MediaPipe
([developers.google.com/edge/mediapipe](https://developers.google.com/edge/mediapipe/solutions/guide))?

**Answer: yes.** MediaPipe Solutions/Tasks is on-device inference (TFLite/XNNPACK,
optional GPU delegate), has a first-class Android target, and the dock is well above the
floor: minSdk 26 (Tasks needs 24+), arm64, plugged-in desk dock. The app already ships two
on-device ML stacks — ML Kit (face) and ONNX Runtime (FER + Silero VAD) — so a MediaPipe
`.aar` is the same shape of dependency.

## Decision captured from the user

- Add **two** detectors: **hand gestures** (MediaPipe Gesture Recognizer) and **body pose**
  (MediaPipe Pose Landmarker).
- **Push detections to the server brain** via the existing `perception` WebSocket topic
  (same path `recognize-request`/`identity`/`presence` use). Not local-UX-only, not on the
  turn-request.
- Local UX reaction is out of scope for now (events still land on the bus → possible later).

## Verified architecture (anchors confirmed against the tree)

- **Camera owner:** `FaceTracker` owns the single CameraX `ImageAnalysis`, gated to ~1 Hz
  (`ANALYSIS_INTERVAL_NS = 1_000_000_000L`); preview is separate at 30fps. Each tick makes an
  upright `Bitmap` (FaceTracker.kt:290-297) and fans it out via `onBitmapFrame`
  (FaceTracker.kt:59, invoked :304). **`onBitmapFrame` is already taken** by MediaStreamer
  (MediaStreamer.kt:157) → a new dedicated `onVisionFrame` hook is needed; don't clobber it.
- **Earlier wrong assumption corrected:** analysis is ~1 Hz, **not** 12 Hz (12 Hz was an old
  guess; only preview is 30fps).
- **On-device ML pattern to mirror:** `FerOnnx` — lazy `fromAssets()` reading
  `assets.open(path).readBytes()`, returns `null` on failure ("disabled"), `@Volatile`
  holder, `close()` in shutdown (FerOnnx.kt:79-96).
- **Server push pattern:** `link.publish("perception", "<kind>", buildJsonObject{…})` from a
  `PerceptionBus.events.collect{}` `LaunchedEffect` in `DockScreen` — template is the
  recognize-request effect (DockScreen.kt:319-348). Inbound perception frames already route
  StationLink → `onPerceptionFrame` → DockScreen (:156-212) → `PerceptionBus.emit`.
- **Model fetch convention:** `scripts/fetch-models.sh` (idempotent size-guarded download;
  FER+ at lines 18-21) + `.gitignore` models block (:32-34). Big models fetched on demand,
  **not committed**.
- **Bus:** `PerceptionBus.emit(event)`, `SharedFlow`, DROP_OLDEST, no replay.

## Proposed approach (designed, not built)

1. **Dependency:** `com.google.mediapipe:tasks-vision` in `libs.versions.toml` +
   `app/build.gradle.kts`. Models in `app/src/main/assets/models/`, **uncommitted**, fetched
   via `scripts/fetch-models.sh`: `gesture_recognizer.task` (~8 MB),
   `pose_landmarker_lite.task` (~3 MB — **lite**, full/heavy will thermal-throttle). Add both
   to `.gitignore`. *(User to decide: commit ~11 MB vs fetch-on-clone; default fetch.)*
2. **New file `perception/MediaPipeVision.kt`:** `GestureDetector` + `PoseDetector` wrappers
   mirroring FerOnnx lifecycle. **`RunningMode.IMAGE`** (synchronous `.detect()` on the
   analyzer thread — frames are already ~1 Hz Bitmaps, LIVE_STREAM's async machinery buys
   nothing). **`Delegate.CPU`** to start (GPU is a thermal gamble with preview+ML Kit+ONNX
   contending). A `VisionPipeline` coordinator owns both + interval gates + lazy load, runs
   gesture ~1 Hz and pose ~0.5 Hz, emits onto the bus. Landmark→summary is a pure,
   unit-testable fun.
   - Gesture output: canned `label` (`Thumb_Up`/`Open_Palm`/`Pointing_Up`/`Victory`/…) +
     `score` + `hand`. **"Wave" is temporal, not a single-frame class → out of scope.**
   - Pose output: **compact summary, NOT 33 raw landmarks over WS** — `present`, coarse
     `posture` label (`standing`/`sitting`/`arms_raised`/`unknown`), one mirror-corrected
     `nose` NDC point.
3. **Frame sharing:** add `@Volatile var onVisionFrame: ((Bitmap)->Unit)?` in FaceTracker
   (:59) invoked after `onBitmapFrame` (:304) with `uprightForVision(bitmap)`. Reuse the
   analyzer executor; only split to a dedicated executor if the ~1 Hz tick overruns budget.
4. **New `PerceptionEvent` subclasses:** `HandGesture(label, score, hand)` and
   `BodyPose(present, posture, noseX, noseY)`.
5. **Server push:** one `LaunchedEffect` in DockScreen. `kind="gesture"` (publish on label
   change OR every 3 s) and `kind="pose"` (2 s cadence cap) on topic `"perception"`, plain
   lossy `publish`. Throttle/dedup factored into a pure testable helper.
6. **Lifecycle:** lazy load on first vision frame; `null` from `fromAssets` → detector
   disabled, app boots fine with no models. Dispose from DockScreen teardown.

## REQUIRED separate server change

orbit-station must learn the new `kind`s or the phone publishes into the void (harmless
meanwhile). Locate ingest: `grep -rn "recognize-request\|perception" orbit-station/server/src/modules/`
— likely `modules/brain` (per-dock session context) or a `modules/perception` consumer. Feed
`gesture`/`pose` into the per-dock brain context where `identity`/`presence` already ground
the LLM. Not designed.

## Riskiest parts

1. **MediaPipe native packaging** — first build may need a `packaging.resources.excludes`
   entry for duplicate `.so`/license-merge; blocks everything until resolved.
2. **Analyzer-thread budget** — pose is the heaviest new consumer on the single ~1 Hz
   analyzer thread shared with FER + ML Kit; overrunning it degrades the carefully tuned
   preview/face pipeline. Mitigate: lite/CPU/0.5 Hz, measure (`process()` tick time via
   Timber) before any GPU or cadence bump.

## Files in scope (when implemented)

- `node-dock/app/.../perception/MediaPipeVision.kt` — new
- `node-dock/app/.../perception/FaceTracker.kt` — `onVisionFrame` hook (:59 / :304)
- `node-dock/app/.../perception/PerceptionEvent.kt` — `HandGesture`, `BodyPose`
- `node-dock/app/.../ui/DockScreen.kt` — construct VisionPipeline (~:223), publish effect
  (~:319 template), dispose
- `node-dock/app/app/build.gradle.kts` + `gradle/libs.versions.toml` +
  `scripts/fetch-models.sh` + `.gitignore`
- *(separate)* `orbit-station/server/src/modules/…` — consume `gesture`/`pose`

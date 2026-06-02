# node-dock app — build plan

Working plan for the Android app at `node-dock/app/`. Source of truth for what's being built, in what order, and what's deferred.

**Last updated:** 2026-06-02

---

## Decisions locked

- **IDE:** Android Studio 2025.2 (already installed). VS Code for non-Android files.
- **Language / UI:** Kotlin + Jetpack Compose.
- **Project type:** Standard Android (not KMP). iOS deferred.
- **minSdk:** 26 (Android 8.0) · **targetSdk:** 35 (Android 15).
- **JDK:** 21 (already installed via Temurin).
- **Dev target:** AVD (Pixel 3a API 35 arm64) **and** physical Android device — both verified during the BodyLink integration work. Use `10.0.2.2:<port>` from AVD or the laptop's LAN IP from a real phone.
- **LLM endpoint:** **Ollama local first** (configured via `OLLAMA_BASE_URL` + `OLLAMA_MODEL` in `local.properties`), with **OpenRouter fallback chain** when Ollama is empty/unreachable. Streaming. Model comparison + current pick: [bench/README.md](bench/README.md).
- **Agent framework:** vendored **pi-kt** agentic loop in the `:agent-core` Gradle module (pure-JVM: loop + tools + sessions). The app's `DockAgent` is a thin facade over it; `DockStreamFn` (in `dev/orbit/dock/llm/`) is the transport. (Koog was evaluated and dropped — the pi-kt loop is lighter and Android-free.)
- **STT:** Android `SpeechRecognizer` (Google on-device) for real devices; **dev bypass via text input** for emulator + scripted testing.
- **TTS:** Android `TextToSpeech` (sentence-boundary chunked), also renders as subtitle on face.
- **Camera + gaze:** MediaPipe FaceMesh, works in emulator via AVD `Webcam0` and on physical front camera.
- **Memory:** deferred — add a persistence/recall layer when needed (see the backlog in `../../docs/TODO.md` §5).
- **Body / BodyLink:** firmware shipped end-to-end on hardware; Kotlin Brain client migrated to the current `set_target` protocol. Remaining BodyLink work is the sim integration-test rewrite + the stage 3/4 UI/test items (see M7 + [../bodylink/HANDOVER.md](../bodylink/HANDOVER.md)).
- **Proactive triggers, inter-node, plat:** v2.

---

## v1 scope

A working voice-and-vision desk companion in the emulator (and on a real phone):

- Always-on animated face (Compose)
- Wake word → engage; tap-wake too
- VAD bar live, "who's talking" indicator updates in real time
- Speak to it (via mic on real device, text on emulator), it speaks back
- Eyes track the user's face when camera sees one (M5)
- Touch controls: tap-wake / long-press-silence / two-finger-privacy
- A handful of useful tools: web search, calendar, Slack send, image generation, illustrate
- Foreground service that doesn't get killed
- **BodyLink: connect to a Body (sim or ESP32), drive it via LLM tools, mirror live state in the UI**

Out of scope for v1: memory, proactive triggers, integrations with other nodes, plat server.

---

## Milestones

Six milestones. Each is independently testable in the emulator, each ends with a concrete demo.

### M1 — Skeleton + animated face
- [x] Android Studio 2025.2 confirmed
- [x] `adb` on PATH (zsh)
- [x] Scaffold Android project at `node-dock/app/`
- [x] Compose + landscape lock + full-screen immersive (MainActivity)
- [x] `FaceController` state machine (StateFlow-based) — Idle / Engaged / Listening / Speaking / Illustrating
- [x] `FaceRenderer` Compose — eyes, breath, blink, idle drift, gaze offset, pupil dilation, privacy "closed-eye" mode
- [x] Status bar bottom (mocks): VAD bar, speaker, body, mic/cam, plat link
- [x] Widget column slots (left + right, stub items)
- [x] Touch: tap → wake / silence; long-press → silence
- [x] Subtitle band below face
- [x] Theme + launcher icon (adaptive)
- [x] **Debug build green (`./gradlew assembleDebug`)** → `app/build/outputs/apk/debug/app-debug.apk` (~9 MB)
- [ ] Two-finger tap → privacy mode (deferred to M1.1 — not blocking)
- [x] Foreground service skeleton (landed in M2 — `PerceptionService`)
- [x] AVD with webcam + mic mapped to host (for M2/M5)
- [x] **Manual demo:** open project in Android Studio → run on AVD → face breathes, tap wakes, long-press silences

### M2 — Perception: mic + VAD + wake word
- [x] `RECORD_AUDIO` + `POST_NOTIFICATIONS` runtime permission flow
- [x] `FOREGROUND_SERVICE_MICROPHONE` permission and service type
- [x] `PerceptionService` foreground service with persistent notification
- [x] `MicCapture` — `AudioRecord` 16kHz mono 512-sample frames → `Flow<ShortArray>`
- [x] **Silero VAD V5** — ONNX Runtime Android (1.26.0), stateful per-frame, 0.5/0.35 hysteresis, ~2.3 MB asset
- [x] **Porcupine** wake word (4.0.0, JARVIS built-in) — gated by `PORCUPINE_ACCESS_KEY` in `local.properties`; gracefully disabled when absent
- [x] `PerceptionPipeline` orchestrator wires mic → VAD + wake → `PerceptionBus` (SharedFlow)
- [x] `PerceptionEvent` sealed type: AudioLevel / VoiceActivity / WakeWord / Transcript / Status / Error
- [x] `PerceptionWiring` bridges bus → FaceController; exposes live audio level for VAD bar
- [x] VAD bar in status: 8-segment bar reflecting real RMS, green→yellow→red gradient
- [x] Speaker indicator flips 🧑 user on VAD active
- [x] Wake-word event triggers `FaceController.wake()`
- [x] Debug-only "fake wake" trigger — tap the speaker indicator in debug builds
- [x] **Build verified:** `./gradlew assembleDebug` (~125 MB APK with 4-ABI native libs)
- [x] **Runtime verified on Pixel 3a API 35 AVD:**
  - SileroVad loaded (2272 KB)
  - MicCapture started (sr=16000 frame=512)
  - Foreground service permission granted
  - Debug fake wake → "wake fired: (debug)" → eyes dilate → subtitle "listening…"
  - Live VAD bar visible at bottom
- [ ] **Porcupine real wake word** — needs free AccessKey from console.picovoice.ai pasted into local.properties as `PORCUPINE_ACCESS_KEY=...`
- [ ] Battery-optimization exemption nudge (deferred to cross-cutting work)
- [ ] **Demo:** speak into laptop mic; VAD bar moves (working). Real wake-word ("hey jarvis") needs Porcupine key.

### M3 — STT (with dev bypass)
- [x] `SttEngine` interface — `start()`, `stop()`, emits `Transcript` events
- [x] **`AndroidSpeechRecognizerStt`** — Google's cloud STT (free, networked). Partial + final results, error mapping
- [x] STT lifecycle wired in `PerceptionPipeline`: wake event → start STT; auto-finalizes on end-of-speech; concurrent wakes ignored while busy
- [x] **`DevTextBar`** — debug-only text input. Types a phrase → emits `WakeWord("(dev)")` + `Transcript(text, isFinal=true)`. Same downstream path as real STT. Keyboard auto-dismisses on send
- [x] `DevBarHost` — Compose wrapper that conditionally renders in debug builds only
- [x] `TranscriptState` in `PerceptionWiring` — live transcript snapshot for the UI
- [x] Subtitle band shows transcript live:
  - Final = white, medium weight
  - Partial = grey, lighter
  - Empty = state hint (e.g., "say 'hey jarvis' or tap to wake")
- [x] **Build verified:** `./gradlew assembleDebug` green
- [x] **Runtime verified on Pixel 3a API 35 AVD:**
  - speech-recognizer STT engine initialized (`stt=speech-recognizer` in status)
  - Typed "what is the capital of france" → bus emitted `WakeWord(dev)` + `Transcript(final=true)` → subtitle rendered the text
  - Real `SpeechRecognizer` also starts on wake events (so when user speaks, it captures too)
- [ ] **WhisperCppStt** (NDK + ggml-tiny model) — deferred to M3.1 if SR quality / latency proves insufficient. Both engines plug into the same `SttEngine` interface.

#### M3 — verified end-to-end (2026-05-18)
- 5 instrumented tests covering `AndroidSpeechRecognizerStt` callback → bus event plumbing (all pass)
- `MicCaptureDiagnosticTest` proves AudioRecord captures real audio on the AVD when host mic is ON — measured peak 0.085 (FAINT speech-level) over 7680 samples
- `scripts/stt-smoke.sh` runs `say` → emulator mic → expects matching transcript with diagnostics on failure
- Verified plumbing: STT engine init, partial + final result emission, error mapping, empty-result handling
- Honest gaps: speech volume at host mic affects whether SpeechRecognizer returns a match (FAINT signal often → NO_MATCH); needs you to actually speak near the laptop or pipe audio via BlackHole loopback

#### AVD-specific STT limitation (May 2026)

Tested extensively on Pixel 3a API 35 AVD with `webcam0` mic + macOS Android Studio mic grant:
- ✅ `AudioRecord` captures real audio: peak 0.64 measured during host `say` playback
- ✅ Our `MicCapture` flow delivers PCM frames at 16 kHz with real signal
- ❌ Android's `SpeechRecognizer` (which routes through Google's Soda on-device STT on AOSP emulator images) returns empty results — `agsa_transcription_NO_SPEECH_DETECTED` consistently
- Likely cause: Soda's audio source path on AOSP-flavor AVD doesn't pick up the webcam-mic loopback, even though `AudioRecord` does
- Not fixable from app code (set `EXTRA_PREFER_OFFLINE=false` — ignored on this build)

**Validation path for real STT:**
1. Real Android phone (recommended) — SpeechRecognizer uses the same mic path as AudioRecord on real devices
2. Or M3.1: implement `WhisperCppStt` that reads from our `AudioRecord` stream directly. We've proven that stream works. Whisper bypasses Soda entirely.

The plumbing on our side is correct (5 instrumented tests confirm `RecognitionListener` callbacks → bus events). The AVD's STT engine is the bottleneck.

### M4 — agent loop + Ollama / OpenRouter + TTS — DONE
- [x] OpenRouter API key from `local.properties` → `BuildConfig.OPENROUTER_API_KEY`
- [x] **Ollama local-first**: `OLLAMA_BASE_URL` + `OLLAMA_MODEL` in `local.properties` → `BuildConfig.*`. When set, DockAgent tries Ollama first; when empty/unreachable falls back to OpenRouter.
- [x] `DockAgent` — thin facade over the `:agent-core` pi-kt loop; `DockStreamFn` does the Ollama/OpenAI transport.
- [x] **OpenRouter free-model fallback chain** — when one returns 429/404, try the next.
- [x] `DockTools` — the side-effect surface the agent loop drives (the
  LLM-facing tools in `DockToolsAdapter` call into these):
  - `speak(text)` / `speakSentence(text)` — fire TTS + face speaking state + subtitle
  - `setFace(expression)` — one of the 9 face enums
  - `silence()` — stop TTS + face back to idle
  - `makeBodyMovements(...)` — drive a connected BodyLink body (parsed from
    `move_body`/`gesture`/`move_sequence`). See M7.
  - `endTurn()` — settle the UI when a turn produced no speech
- [x] `DockTts` — Android `TextToSpeech` wrapper, sentence-level queueing,
  utterance progress listener flips face state speaking → idle automatically
- [x] Interruption semantics — a new transcript while a turn is in flight
  cancels the old one and starts the new one
- [x] Bot-spoken subtitle (bright blue) takes priority over user-typed transcript (white)
- [x] Error handling — when all models 429/fail, agent speaks "Sorry, every free model is busy or unavailable right now."
- [x] **Build verified:** `./gradlew assembleDebug` green
- [x] **Runtime verified end-to-end on Pixel 3a API 35 AVD:**
  - Typed "what is the capital of france" in dev bar
  - DeepSeek 429 → Gemma 429 → **Nemotron-3-super-120b succeeded**
  - Model called `setFace(happy)` then `speak("The capital of France is Paris.")`
  - Face turned brighter blue (Speaking state)
  - Subtitle rendered the answer in bright dock-blue
  - Android TTS spoke it through the laptop speakers
- [ ] **Richer agent-loop event logging/metrics** — deferred (text logging via Timber already works)
- [ ] **Streaming TTS (sentence-chunked from token deltas)** — deferred. Current path is one-utterance-per-tool-call which is naturally sentence-sized given the tool design

### M5 — Camera + gaze tracking (works in emulator)
- [ ] AVD configured: front camera = `Webcam0` (laptop FaceTime cam)
- [ ] `CAMERA` runtime permission, `FOREGROUND_SERVICE_CAMERA`
- [ ] CameraX binding — front camera, 720p, 15-30 fps
- [ ] MediaPipe FaceMesh on the camera stream — face landmarks per frame
- [ ] `GazeController` — compute face center in camera frame → map to eye-offset in `FaceRenderer`
- [ ] Eyes in the face composable track the user's face position in real time
- [ ] Gaze + voice trigger: face present + gazing at dock + VAD speech-start within 500ms = engage (skip wake word)
- [ ] Touch indicator: 📷 lit when camera active
- [ ] **Demo:** open emulator, point laptop webcam at yourself, move side to side → face's eyes follow. Look at dock + speak = engage without wake word.

### M6 — Tools: real integrations
- [ ] `webSearch(query)` — Brave Search API direct from phone (`BRAVE_API_KEY` in local.properties)
- [ ] `illustrate(content)` — shows image / list / web snippet in main area, face shrinks to corner avatar (still animated)
- [ ] `imageGenerate(prompt)` — OpenAI Images SDK or via OpenRouter image-out → base64 → `illustrate`
- [ ] `calendarNext(n)` — Google Calendar API + OAuth flow (Sign in with Google, store refresh token)
- [ ] `slackSend(channelOrUser, text)` — Slack Bot Token, direct from phone
- [ ] `slackRead(channelOrDm, since)` — fetch recent for context
- [ ] Filler audio for long tools — `withFiller("let me look that up...") { tool() }`
- [ ] Tool error UX: when a tool fails, agent speaks the error gracefully
- [ ] **Demo:** "search for weather in Bangalore" → web search → speaks result. "show me a corgi" → image generated → displayed. "send Bob 'on my way' on Slack" → DM sent.

### M7 — BodyLink — firmware shipped; Kotlin migrated to current protocol

Brain-side Kotlin client + LLM tools that drive a connected Body. Firmware
shipped end-to-end on hardware; the Kotlin client has been migrated to the
redesigned `set_target` protocol.

Live: [../bodylink/](../bodylink/) (spec + sim) and [../body-firmware/dock_body_v0/](../body-firmware/dock_body_v0/) (firmware).

- [x] **Design doc** — [../bodylink/DESIGN.md](../bodylink/DESIGN.md): single `set_target` motion command (per-part idempotent; used for both intent + heartbeat), capability profile (no named states on body), no body→brain state stream.
- [x] **MuJoCo sim** — Python `bodylink_sim.py` speaks the current protocol and drives the dock humanoid model.
- [x] **Hardware-aligned model** — 4 joints (foot_yaw ±90°, neck_pitch, shoulder_{left,right}_pitch — lateral abduction). Bench setup uses 4× MG90S on XIAO ESP32-S3 (BOM at [../hardware/](../hardware/) is speculative and being rewritten).
- [x] **ESP-IDF firmware shipped** — [../body-firmware/dock_body_v0/](../body-firmware/dock_body_v0/). Native esp_wifi + esp_http_server + mcpwm + cJSON. Accepts `set_target`, drives MG90S servos on GPIO 3/4/5/6 (neck + foot advertised). Verified end-to-end on hardware.
- [x] **Kotlin client migrated** — `BodyLinkComms` (ktor WebSocket) speaks the current protocol: capability `profile` decoding, `set_target` for both intent and periodic heartbeat, `pingIntervalMillis = 2000L` enabled, brain-side state catalog (`assets/states.json` + `BodyStateCatalog`, validated against the body's profile). No `set_state`/state-stream types remain.
- [x] `BODY_HOST` in `local.properties` → `BuildConfig.BODY_HOST`. Empty disables; otherwise connect to `ws://<host>/`.
- [x] **Body driven via the agent's `move_body` / `gesture` / `move_sequence` tools** → `DockTools.makeBodyMovements` → `BodyController.setState(part,state)` → `set_target` on the wire. (Validation against the part↔state catalog lives in `DockToolsAdapter`.)
- [x] `BodyBadge` Compose UI — top-right corner shows green dot + per-part state when connected, red dot when not. Transitioning parts show "<state> (XX%)".
- [x] `usesCleartextTraffic=true` in manifest so `ws://` to LAN sim or ESP32 works.
- [x] **End-to-end verified on real ESP32 (neck + foot)** — "look down", "nod", "wiggle", model-authored `move_sequence` all drive real servos with acks; talk-while-moving confirmed. (See LIFECYCLE.md / the agent tests.)
- [ ] **Rewrite the sim integration tests** (`integration_test.py` still has old `set_state` paths) — T-list in [../bodylink/HANDOVER.md](../bodylink/HANDOVER.md) §3.
- [ ] **Stage 3:** Compose schematic robot canvas (live stick-figure drawn from brain-side intent — UI reads from intent rather than reported state).
- [ ] **Stage 4:** Kotlin instrumented integration test against the sim.
- [ ] **Tool description sharpening:** "look up" sometimes routes to `glance` (eyes-only) instead of `move_body`. Bias the model with stronger wording.

---

## Cross-cutting work (runs alongside milestones)

- [ ] Permissions onboarding wizard — first-run flow walking through all special-access grants from dock README §9
- [ ] Foreground service hardening — battery optimization exemption flow, restart on boot
- [ ] Logging + metrics — Timber + agent-loop event hooks + on-disk audit log + simple Settings screen to view
- [ ] Settings screen — toggle privacy mode, view audit log, change wake word, change model, API keys
- [ ] CI (GitHub Actions later) — lint, unit tests, build APK
- [ ] Debug menu (long-press status bar) — switch model, toggle STT bypass, force face state, inject fake events

---

## Repo layout (after M1 scaffolding)

```
node-dock/app/
├── PLAN.md                      ← this file
├── build.gradle.kts             ← top-level
├── settings.gradle.kts
├── gradle/                      ← gradle wrapper
├── gradlew, gradlew.bat
├── local.properties             ← gitignored: API keys, SDK location
├── .gitignore                   ← Android-standard
└── app/
    ├── build.gradle.kts
    ├── proguard-rules.pro
    └── src/
        ├── main/
        │   ├── AndroidManifest.xml
        │   ├── kotlin/dev/orbit/dock/
        │   │   ├── MainActivity.kt
        │   │   ├── DockApp.kt            ← Application class
        │   │   ├── service/              ← Foreground service
        │   │   ├── ui/
        │   │   │   ├── face/             ← FaceRenderer, FaceController
        │   │   │   ├── status/           ← VAD bar, indicators
        │   │   │   ├── widgets/          ← Left/right widget slots
        │   │   │   └── theme/
        │   │   ├── perception/           ← mic, VAD, wake word, camera, gaze
        │   │   ├── agent/                ← DockAgent (pi-kt facade), tools
        │   │   ├── llm/                  ← transport, schemas, prompt
        │   │   ├── tts/                  ← streaming TTS chunker
        │   │   ├── stt/                  ← whisper.cpp wrapper + dev text bar
        │   │   └── tools/                ← search, calendar, slack, illustrate, imagegen
        │   ├── res/
        │   └── assets/                   ← TFLite models (or downloaded on first run)
        └── debug/                        ← debug-only sources (text-input bar)
```

---

## Risks + mitigations

- **whisper.cpp NDK build complexity** — start with Android `SpeechRecognizer` as M3 fallback; whisper.cpp later if quality needs it. Or stick to text bypass for v1.
- **OpenRouter rate limits / cost during dev** — set a budget cap; default to cheap model (claude-haiku, deepseek) during iteration.
- **AVD camera + mic glitches on Apple Silicon** — known to be slightly flaky; have a "use static test face image / pre-recorded audio" path for CI / headless dev.
- **Compose Preview performance for complex face animation** — fine for static frames, may not render full animation smoothly. Acceptable; we'll just run the app for animation tuning.
- **Foreground service kill on AOSP-emulator** — emulator is more permissive than real OEM Android; M2's hardening only fully validates on physical device.

---

## Status snapshot

**Current state (2026-06-02):** Body firmware (ESP-IDF on XIAO ESP32-S3)
shipped end-to-end on hardware, and the Kotlin Brain client has been
migrated to the current `set_target` protocol — handshake, heartbeat,
and the brain-side state catalog are all in place. The app drives real
servos via the agent's `move_body`/`gesture`/`move_sequence` tools
(log-validated on the ESP32, neck + foot).

**Next concrete actions** (in order):
1. **Rewrite the sim integration tests** — `integration_test.py` still has
   old `set_state` paths; T-list in [../bodylink/HANDOVER.md](../bodylink/HANDOVER.md) §3.
   (`bodylink_cli.py` + `bodylink_sim.py` are already on the current protocol.)
2. **M7 stage 3** — schematic Compose robot canvas on the main screen
   (live stick-figure drawn from brain-side intent).
3. **M7 stage 4** — Kotlin instrumented integration test against the sim.
4. **M5** — camera + gaze. Foundational sensors are in (CameraX +
   MediaPipe) but no eyes-track-face wiring yet.
5. **M6** — real integrations (web search, calendar, Slack, image gen).
6. **(Optional)** Porcupine AccessKey → real "hey jarvis" wake word.

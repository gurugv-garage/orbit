# node-dock app — build plan

Working plan for the Android app at `node-dock/app/`. Source of truth for
what's being built, in what order, and what's deferred. The file map lives in
[../README.md](../README.md#project-map); how a turn works (lifecycle + state
machines + agent mechanics) in [dock-agent-loop.md](dock-agent-loop.md); the interaction contract in
[UX.md](UX.md).

**Last updated:** 2026-06-02

---

## Decisions locked

- **Language / UI:** Kotlin + Jetpack Compose. Standard Android (not KMP); iOS deferred.
- **SDK:** minSdk 26 (Android 8.0) · targetSdk 35 (Android 15) · JDK 21.
- **Dev target:** AVD (Pixel 3a API 35 arm64) **and** physical Android device. Use `10.0.2.2:<port>` from AVD or the laptop's LAN IP from a real phone.
- **LLM endpoint:** **Ollama local-first** (`OLLAMA_BASE_URL` + `OLLAMA_MODEL` in `local.properties`), **OpenRouter fallback chain** when Ollama is empty/unreachable. Streaming. Model comparison + current pick: [bench/README.md](bench/README.md).
- **Agent framework:** our own **`:agent-core`** loop (pure-JVM: loop + tools + sessions; vocabulary in [../../docs/agent-model.md](../../docs/agent-model.md)). `DockAgent` is a thin facade; `DockStreamFn` (in `dev/orbit/dock/llm/`) is the transport. (Koog was evaluated and dropped — this loop is lighter and Android-free.)
- **STT:** Android `SpeechRecognizer` (Google on-device) on real devices; **dev bypass via text input** for emulator + scripted testing.
- **TTS:** Android `TextToSpeech` (sentence-boundary chunked), also rendered as a subtitle on the face.
- **Camera + gaze:** MediaPipe FaceMesh, works in emulator via AVD `Webcam0` and on the physical front camera.
- **Memory:** deferred — add a persistence/recall layer when needed (backlog in `../../docs/TODO.md` §5).
- **Body / BodyLink:** firmware shipped on hardware; Kotlin client migrated to the current `set_target` protocol. Remaining work is the sim integration-test rewrite + stage 3/4 (see M7).
- **Proactive triggers, inter-node, plat:** v2.

---

## v1 scope

A working voice-and-vision desk companion in the emulator and on a real phone:

- Always-on animated face (Compose); wake word → engage; tap-wake.
- Voice conversation with VAD + on-device STT + TTS; barge-in.
- Eyes track the user's face when a camera sees one (M5).
- Touch: tap-wake / long-press-silence / two-finger-privacy.
- A handful of LLM tools: web search, calendar, Slack send, image gen, illustrate (M6).
- Foreground service that doesn't get killed.
- **BodyLink:** connect to a Body (sim or ESP32), drive it via LLM tools, mirror state in the UI.

Out of scope for v1: memory, proactive triggers, inter-node, plat server.

---

## Milestones

Six milestones, each independently testable in the emulator.

### M1 — Skeleton + animated face — ✅ DONE
Compose UI (landscape, immersive), `FaceController` 5-state machine, `FaceRenderer`
(eyes/breath/blink/gaze/pupil/privacy), status bar, tap-wake / long-press-silence,
subtitle band, theme + launcher icon. Debug build green on AVD.
- [ ] Two-finger tap → privacy mode (deferred to M1.1 — not blocking).

### M2 — Perception: mic + VAD + wake word — ✅ DONE
`PerceptionService` foreground service; `MicCapture` (AudioRecord 16 kHz);
**Silero VAD V5** (ONNX Runtime 1.26.0, ~2.3 MB asset, 0.5/0.35 hysteresis);
**Porcupine** wake word (4.0.0, gated by `PORCUPINE_ACCESS_KEY`, gracefully
disabled when absent); `PerceptionPipeline` → `PerceptionBus` (SharedFlow);
live VAD bar. Runtime-verified on AVD.
- [ ] Real "hey jarvis" wake word — needs a free Porcupine AccessKey in `local.properties`.
- [ ] Battery-optimization exemption nudge (→ cross-cutting).

### M3 — STT (with dev bypass) — ✅ DONE
`SttEngine` interface + `AndroidSpeechRecognizerStt` (partial/final, error mapping);
STT lifecycle in `PerceptionPipeline`; debug `DevTextBar` (types a phrase → same
downstream path as real STT); live transcript in the subtitle band. Plumbing
covered by 5 instrumented tests.
- **Known AVD limitation:** Android's `SpeechRecognizer` (Google Soda on AOSP
  emulator images) returns empty on the webcam-mic loopback even though
  `AudioRecord` captures real audio — not fixable from app code. Validate STT on
  a real phone, or implement `WhisperCppStt` (below).
- [ ] **`WhisperCppStt`** (NDK + ggml-tiny) reading directly from our `AudioRecord`
  stream — deferred to M3.1 if SR quality/latency proves insufficient.

### M4 — agent loop + Ollama / OpenRouter + TTS — ✅ DONE
`DockAgent` (facade over the `:agent-core` pi-kt loop) + `DockStreamFn` transport;
Ollama local-first with OpenRouter free-model fallback chain (429/404 → next);
`DockTts` (sentence-queued, drives face speaking↔idle); interruption semantics
(new transcript cancels the in-flight turn). The agent's side-effect surface
(`DockTools`): `speak`/`speakSentence`, `setFace`, `silence`,
`makeBodyMovements`, `endTurn`. Runtime-verified end-to-end on AVD.
- [ ] Streaming TTS (sentence-chunked from token deltas) — deferred; the current
  one-utterance-per-tool-call path is already sentence-sized.

### M5 — Camera + gaze tracking — ~ PARTIAL
Foundational sensors are in (`CameraFrameProvider`, `FaceTracker` via MediaPipe,
`FerOnnx` expression read, `FaceSeen`/`FaceLost` on the bus). Not yet wired:
- [ ] `GazeController` — face center in frame → eye-offset in `FaceRenderer`, so the eyes track the user.
- [ ] Gaze + voice engage: face present + gazing + VAD speech-start within 500 ms → engage without a wake word.
- [ ] `📷` indicator lit when the camera is active.
- [ ] **Demo:** point the webcam at yourself, move side to side → the face's eyes follow.

### M6 — Tools: real integrations — ☐ NOT STARTED
- [ ] `webSearch(query)` — Brave Search API direct from phone.
- [ ] `illustrate(content)` — image / list / web snippet in the main area, face shrinks to a corner avatar.
- [ ] `imageGenerate(prompt)` — OpenAI Images / OpenRouter image-out → `illustrate`.
- [ ] `calendarNext(n)` — Google Calendar API + OAuth.
- [ ] `slackSend` / `slackRead` — Slack Bot Token, direct from phone.
- [ ] Filler audio for long tools; graceful tool-error speech.

### M7 — BodyLink — ✅ migrated to the current protocol (stage 3/4 open)
Brain-side Kotlin client + LLM tools that drive a connected Body. Firmware shipped
on hardware; the Kotlin client speaks the current `set_target` protocol. Live:
[../bodylink/](../bodylink/) (spec + sim), [../body-firmware/dock_body_v0/](../body-firmware/dock_body_v0/) (firmware).

Done:
- [x] **ESP-IDF firmware** — accepts `set_target`, drives MG90S servos on GPIO 3/4/5/6 (neck + foot advertised). Verified on hardware.
- [x] **Kotlin client migrated** — `BodyLinkComms` decodes the capability `profile`, sends `set_target` for both intent and a periodic heartbeat (`pingIntervalMillis = 2000L`), and ships a brain-side state catalog (`assets/states.json` + `BodyStateCatalog`, validated against the body's profile). No `set_state`/state-stream types remain.
- [x] **Body driven via the agent's `move_body` / `gesture` / `move_sequence` tools** → `DockTools.makeBodyMovements` → `BodyController.setState(part,state)` → `set_target`. Part↔state validation in `DockToolsAdapter`.
- [x] `BodyBadge` UI (green/red dot + per-part state, transitions show `<state> (XX%)`); `BODY_HOST` in `local.properties`; `usesCleartextTraffic=true` for `ws://`.
- [x] **End-to-end on real ESP32 (neck + foot)** — "look down", "nod", "wiggle", model-authored `move_sequence` all drive real servos with acks; talk-while-moving confirmed (see [dock-agent-loop.md](dock-agent-loop.md)).

Open:
- [ ] **Rewrite the sim integration tests** — `integration_test.py` still has old `set_state` paths; T-list in [../bodylink/HANDOVER.md](../bodylink/HANDOVER.md) §3.
- [ ] **Stage 3:** Compose schematic robot canvas (live stick-figure from brain-side intent).
- [ ] **Stage 4:** Kotlin instrumented integration test against the sim.
- [ ] **Tool-description sharpening:** "look up" sometimes routes to `glance` (eyes-only) instead of `move_body`.

---

## Cross-cutting work

- [ ] Permissions onboarding wizard — first-run flow for the special-access grants.
- [ ] Foreground-service hardening — battery-optimization exemption, restart on boot.
- [ ] Logging + metrics — Timber + agent-loop event hooks + on-disk audit log.
- [ ] Settings screen — privacy toggle, audit log, change wake word / model / API keys.
- [ ] CI — lint, unit tests, build APK.
- [ ] Debug menu (long-press status bar) — switch model, toggle STT bypass, force face state, inject events.

---

## Risks + mitigations

- **whisper.cpp NDK build complexity** — start with `SpeechRecognizer`; whisper.cpp later if quality needs it.
- **OpenRouter rate limits / cost during dev** — budget cap; default to a cheap model while iterating.
- **AVD camera + mic flakiness on Apple Silicon** — keep a static-test-image / pre-recorded-audio path for headless dev.
- **Foreground-service kill on real OEM Android** — the emulator is permissive; service hardening only fully validates on a physical device.

---

## Status snapshot

**2026-06-02:** M1-M4 done. M7 — firmware shipped on hardware and the Kotlin
client migrated to the current `set_target` protocol (handshake, heartbeat, state
catalog all in place); the app drives real servos via `move_body`/`gesture`/
`move_sequence`, log-validated on the ESP32 (neck + foot).

**Next, in order:**
1. Rewrite the sim integration tests (`integration_test.py`) per [../bodylink/HANDOVER.md](../bodylink/HANDOVER.md) §3.
2. M7 stage 3 — schematic Compose robot canvas.
3. M7 stage 4 — Kotlin instrumented integration test against the sim.
4. M5 — wire camera/face into gaze tracking (sensors already in).
5. M6 — real integrations (web search, calendar, Slack, image gen).
6. (Optional) Porcupine AccessKey → real "hey jarvis".

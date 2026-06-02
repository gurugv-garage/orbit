# node-dock — orbit desk companion

Stationary desk companion node of the [orbit](../) platform.

A phone (Android, sideloaded APK) acts as the dock's eyes + ears + voice + brain.
Wall-powered, fixed to a 3D-printed case. Optionally driven by 4 servos via a
separate ESP32 microcontroller — the phone owns intent, the ESP32 executes
motion.

## Start here

- **Project map** (every directory, what it is, current status): see [Project map](#project-map) below.
- **Drive the live firmware from any IDE:** [body-firmware/dock_body_v0/scripts/test_body.sh](body-firmware/dock_body_v0/scripts/test_body.sh) — interactive REPL over WebSocket.
- **Wire protocol:** [bodylink/DESIGN.md](bodylink/DESIGN.md) (canonical spec).

## Status — 2026-06-02

| Component | Status |
|---|---|
| Body firmware (ESP-IDF on XIAO ESP32-S3) | ✅ shipped, verified end-to-end on hardware |
| Python MuJoCo body sim (`bodylink_sim.py`) | ✅ speaks the current BodyLink protocol |
| Protocol spec | ✅ canonical in [bodylink/DESIGN.md](bodylink/DESIGN.md) |
| Android app (face + agent loop + perception) | ✅ M1-M4 done |
| BodyLink Kotlin client (`BodyLinkComms`) | ✅ migrated to the current protocol: `set_target` + heartbeat (`pingIntervalMillis=2000`) + brain-side state catalog (`states.json` + `BodyStateCatalog`) |
| LLM tools | ✅ 5 tools wired: `set_face`, `move_body`, `gesture`, `move_sequence`, `compute` |
| Sim integration tests (`integration_test.py`) | ⚠️ partially on old `set_state` — rewrite tracked in [bodylink/HANDOVER.md](bodylink/HANDOVER.md) §3 |
| BodyLink stage 3/4 (schematic robot canvas; instrumented sim test) | ⏳ open — see [app/PLAN.md](app/PLAN.md) §M7 |
| Hardware BOM | ⚠️ speculative; bench differs (see [hardware/README.md](hardware/README.md)) |
| Real-phone companion / plat / proactive triggers | ⏳ v2 |

## Product shape

- Always-on listen + watch (privacy-controlled).
- Animated face on screen, voice conversation with interruption.
- Optional physical body: pan, tilt, idle gestures, T-pose arms.
- Touch screen to interrupt / silence; long-press silence, two-finger privacy.
- Highly proactive by default (tunable per user).
- Coordinates with other orbit nodes through [plat](../plat/) (v2).

## Hardware (bench setup as built)

| Item | Pick | Notes |
|---|---|---|
| Phone | Any modern Android (Pixel-class preferred) | Sideloaded APK. Foreground service, mic+cam always, accessibility. |
| Power (phone) | USB-C from wall | Phone always charged; never sleeps. Charge-limit to 80% (AccA / Chargie). |
| MCU (body) | **Seeed XIAO ESP32-S3** + u.FL antenna | Native USB-CDC. Antenna is mandatory. |
| Servos | **4 × MG90S** | Wired to GPIO 3/4/5/6. |
| Servo power | **External 5V brick** | NOT the XIAO 5V pin (USB-VBUS browns out on stall). |
| Case | 3D-printed shell + phone holder | Parametric per phone. Design in [hardware/](hardware/). |

Hardware lessons (the painful ones, in case they bite again): [body-firmware/dock_body_v0/progress.md](body-firmware/dock_body_v0/progress.md).

## How the layers talk

```
┌──────────────────────────────────────────────────────────────┐
│                  Android phone (one process)                 │
│                                                              │
│   Face UI ── agent loop (:agent-core) ── LLM (Ollama/cloud) │
│                  │                                           │
│                  ├── Perception: mic, VAD, wake-word,        │
│                  │   camera, FaceMesh, touch                 │
│                  │                                           │
│                  ├── BodyLinkComms ── WebSocket ── ESP32     │
│                  │                                           │
│                  └── (v2) plat client                        │
└──────────────────────────────────────────────────────────────┘
                                           │
                          ws://<body>:17317/
                                           │
┌──────────────────────────────────────────▼───────────────────┐
│   ESP32 body firmware (ESP-IDF; mcpwm × 4)                   │
│   • Advertises capability profile (parts + param ranges)     │
│   • Accepts `set_target` — idempotent per part               │
│   • Linear interp between commanded pulse-widths             │
└──────────────────────────────────────────────────────────────┘
```

## Where to read for each topic

| You want to … | Read |
|---|---|
| see every file + its current state | [Project map](#project-map) below |
| understand the wire protocol | [bodylink/DESIGN.md](bodylink/DESIGN.md) |
| drive the body from a terminal | [body-firmware/dock_body_v0/scripts/test_body.sh](body-firmware/dock_body_v0/scripts/test_body.sh) (run `--help`) |
| migrate the Android client | [bodylink/HANDOVER.md](bodylink/HANDOVER.md) |
| change the firmware | [body-firmware/dock_body_v0/progress.md](body-firmware/dock_body_v0/progress.md) |
| work on the Android app (face, agent, LLM, perception) | [app/PLAN.md](app/PLAN.md) |
| understand a turn (utterance → speech + motion; state machines) | [app/dock-agent-loop.md](app/dock-agent-loop.md) |
| the agent model + vocabulary (session/turn/step) | [app/agent-core/AGENT-MODEL.md](app/agent-core/AGENT-MODEL.md) |
| build / wire / 3D-print the physical dock | [hardware/README.md](hardware/README.md) |
| compare LLMs as the dock brain (runnable harness) | [app/bench/README.md](app/bench/README.md) |

## v1 scope (the dock, end-to-end)

A working voice-and-vision desk companion in the emulator AND on a real phone:

- Always-on animated face (Compose), wake word → engage, tap-wake.
- Voice conversation with VAD + on-device STT + streaming TTS.
- Eyes track the user's face when a camera sees one (M5, not yet wired).
- Touch: tap-wake / long-press-silence / two-finger-privacy.
- A handful of LLM tools: web search, calendar, Slack send, image gen.
- Foreground service that doesn't get killed.
- **BodyLink:** connect to body (sim or real), drive it via LLM tools.

Out of scope for v1: memory, proactive triggers, inter-node, plat server.

## Out-of-scope v2 ideas (kept here so we don't re-invent them)

- **Plat** (laptop-hosted control plane) — shared world model, inter-node
  messaging, integrations (Slack, FCM push, webhooks). Today the phone does
  everything in-process; plat earns its place when a second node exists.
- **Real-phone companion app** — tiny notification + remote-control app on
  the user's carry-phone (not the dock-phone). Receives FCM, can connect back
  to the dock to view/control.
- **Inter-node coordination** — "rover, come here", "kitchen-dock, tell me
  when the timer goes off", presence-based conversation hand-off.
- **Body language library** — abstract intent ("listen attentively", "be
  concerned") → state catalog entries.
- **Multi-user voice diarisation.**
- **Custom wake words per user.**

These were spec'd in detail in earlier revisions of this README; that
content lived too far ahead of the build and rotted. When the time
comes to revisit, work from a clean spec rather than digging in git.

## Long-term architectural notes (one-liners)

- **Privacy stance:** local-first inference where possible; long-press silences
  mic+cam instantly; two-finger tap enters privacy mode (on-device only, no
  plat audio/video); audit log of recent perception.
- **Permissions stance:** the dock requests every permission that meaningfully
  extends its capability — single-tenant sideloaded device, defense in depth
  comes from the physical controls + a VLAN that only routes to plat.
- **Body safety:** safety lives in the firmware's per-param `range` clamp
  (DESIGN.md §2.3) and the state catalog the brain ships. The body clips
  and reports; the brain learns from the report.
- **Latency budget:** end-to-end voice ≤ ~1.4s typical (TTFT 600-1000ms +
  streaming TTS). End-to-end body command ≤ ~75ms RTT typical.

## Project map

Where each part lives, what it is, and its current state (paths relative to
`node-dock/`):

```
node-dock/
├── README.md                   start-here front page (this file).
│
├── app/                        Android dock app (Kotlin, Compose).
│   ├── PLAN.md                 milestone tracker (M1..M7+). Status at the bottom.
│   ├── dock-agent-loop.md      how a turn works in the dock: lifecycle + state
│   │                           machines + mechanics (utterance → speech + motion).
│   ├── UX.md                   the agentic-turn interaction contract (how it feels).
│   ├── app/src/main/kotlin/dev/orbit/dock/
│   │   ├── body/               BodyLinkComms + protocol types + state catalog
│   │   │                       (Kotlin). ✅ on the current set_target protocol.
│   │   ├── agent/              Agentic brain: DockAgent (facade over :agent-core
│   │   │                       pi-kt loop) + DockToolsAdapter (set_face/move_body/
│   │   │                       gesture/move_sequence/compute) + DockTools.
│   │   │                       Interaction spec: app/UX.md.
│   │   ├── llm/                Dock LLM transport: DockStreamFn (Ollama NDJSON +
│   │   │                       OpenAI SSE), DockToolSchemas, DockPrompt,
│   │   │                       SafeCompute. :bench compiles this same dir.
│   │   ├── ui/                 Compose face + body badge + dev panel.
│   │   └── ...                 perception, audio, UI wiring.
│   ├── agent-core/             :agent-core — pure-JVM Gradle module: the agentic
│   │                           runtime (loop + tools + sessions). No Android/Ktor;
│   │                           independent + reusable. Owns the agent vocabulary —
│   │                           see agent-core/AGENT-MODEL.md.
│   ├── bench/                  :bench — runnable LLM benchmark harness (pure-JVM).
│   │                           Drives models through the real transport + tool
│   │                           schemas. See app/bench/README.md.
│   └── local.properties        BODY_HOST=<ip>:17317 — points the app at
│                               either the sim or the live ESP32.
│
├── bodylink/                   The brain ↔ body protocol + sim.
│   ├── DESIGN.md               ✅ canonical wire spec.
│   ├── HANDOVER.md             ⚠️ historical: the (completed) Kotlin migration
│   │                           plan; one sim-test rewrite item remains.
│   └── sim/                    Python MuJoCo body that speaks the protocol.
│       ├── bodies/             MJCF (4 joints — foot/neck/arm.left/arm.right).
│       ├── profiles/dock_companion.json   capability profile (neck + foot).
│       ├── bodylink_sim.py     ✅ speaks the current set_target protocol.
│       ├── bodylink_cli.py     ✅ on the current set_target protocol.
│       └── integration_test.py ⚠️ partially on old set_state; rewrite
│                               pending — T-list in HANDOVER.md §3.
│
├── body-firmware/              ESP32 firmware projects (one per board build).
│   └── dock_body_v0/           ✅ ESP-IDF firmware, shipped + verified on
│       │                       hardware (XIAO ESP32-S3 + 4× MG90S).
│       │                       Joins Wi-Fi, serves BodyLink WS on :17317.
│       ├── progress.md         milestone log + hardware lessons (antenna +
│       │                       external 5V — both mandatory).
│       ├── platformio.ini      espressif32@6.13.0 (IDF 5.5.3).
│       ├── src/                main.c, servo.{h,c} (mcpwm ×4 on GPIO 3/4/5/6),
│       │                       wifi_sta, bodylink_proto/motion/ws (cJSON).
│       ├── include/secrets.h   ⚠️ gitignored Wi-Fi creds (.example checked in).
│       └── scripts/test_body.sh ✅ interactive REPL; drives firmware AND sim.
│
└── hardware/                   Physical-build artifacts.
    ├── README.md               ⚠️ BOM + assembly (target build). Speculative —
    │                           bench differs (banner inside the doc).
    └── 3dprinting/PLAN.md       OpenSCAD source + STL exports (active).
```

## Naming conventions

- **Brain** = the Android phone (and its software).
- **Body** = the ESP32 + servos.
- **Part** = a logical addressable thing on the body (`neck`, `foot`).
  Currently 1:1 with a servo, but the protocol allows N joints per part.
- **Capability profile** = body's self-description sent at handshake.
  Lists parts, their parameters (with ranges), and home pose.
- **set_target** = the brain's only motion command. Per-part idempotent.
  Used for both immediate intent and periodic heartbeat (~1 Hz).
- **State catalog** = brain-owned mapping of named states ("lookUp") to
  primitive parameter bundles. Lives in the Android app's assets, not
  in the firmware.

## Commit log conventions

Lowercase prefix (`node-dock/body:`, `bodylink:`, `node-dock/app:`)
+ em-dash + concise summary. Body has bullets. Trailer:
`Co-Authored-By: Claude <noreply@anthropic.com>`.

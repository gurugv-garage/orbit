# node-dock — orbit desk companion

Stationary desk companion node of the [orbit](../) platform.

A phone (Android, sideloaded APK) acts as the dock's eyes + ears + voice + brain.
Wall-powered, fixed to a 3D-printed case. Optionally driven by 4 servos via a
separate ESP32 microcontroller — the phone owns intent, the ESP32 executes
motion.

## Start here

- **Project map** (every directory, what it is, current status): [STRUCTURE.md](STRUCTURE.md).
- **Drive the live firmware from any IDE:** [body-firmware/dock_body_v0/scripts/test_body.sh](body-firmware/dock_body_v0/scripts/test_body.sh) — interactive REPL over WebSocket.
- **Migrate the Kotlin client to the redesigned protocol:** [bodylink/HANDOVER.md](bodylink/HANDOVER.md) (has a copy-paste agent prompt at §8).

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
| see every file + its current state | [STRUCTURE.md](STRUCTURE.md) |
| understand the wire protocol | [bodylink/DESIGN.md](bodylink/DESIGN.md) |
| drive the body from a terminal | [body-firmware/dock_body_v0/scripts/test_body.sh](body-firmware/dock_body_v0/scripts/test_body.sh) (run `--help`) |
| migrate the Android client | [bodylink/HANDOVER.md](bodylink/HANDOVER.md) |
| change the firmware | [body-firmware/dock_body_v0/progress.md](body-firmware/dock_body_v0/progress.md) |
| work on the Android app (face, agent, LLM, perception) | [app/PLAN.md](app/PLAN.md) |
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

## Repo layout (one level)

```
node-dock/
├── README.md            ← you are here
├── STRUCTURE.md         project map
├── app/                 Android dock app (Kotlin, Compose) + bench harness
├── bodylink/            protocol spec, sim, handover
├── body-firmware/       ESP32 firmware project(s)
└── hardware/            BOM, wiring, 3D-print
```

— see [STRUCTURE.md](STRUCTURE.md) for the full map.

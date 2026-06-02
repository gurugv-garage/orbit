# node-dock — project structure

Where each part of the dock lives, what it is, and what state it's in.
Read this first when picking up the project cold.

> The dock is a phone (Android, sideloaded APK) that acts as the dock's
> brain (LLM + eyes + ears + voice), optionally controlling a separate
> ESP32-driven body (servos). The phone owns intent, the ESP32 executes
> motion. The two sides communicate over a Wi-Fi WebSocket protocol
> called **BodyLink**.

## Map (everything is relative to `node-dock/`)

```
node-dock/
├── README.md                   start-here front page (~150 lines).
├── STRUCTURE.md                this file.
│
├── app/                        Android dock app (Kotlin, Compose).
│   ├── PLAN.md                 milestone tracker (M1..M7+). Status
│   │                           snapshot at the bottom.
│   ├── app/src/main/kotlin/dev/orbit/dock/
│   │   ├── body/               BodyLinkComms + protocol types (Kotlin).
│   │   │                       ⚠️ Currently on the OLD protocol.
│   │   │                       Migration plan: bodylink/HANDOVER.md.
│   │   ├── agent/              Agentic brain: DockAgent (facade over :agent-core
│   │   │                       pi-kt loop) + DockStreamFn (Ollama tool-calling)
│   │   │                       + DockToolsAdapter (set_face/move_body/gesture/
│   │   │                       move_sequence) + DockTools (side effects).
│   │   │                       Interaction spec: ../UX.md.
│   │   ├── ui/                 Compose face + body badge + dev panel.
│   │   └── ...                 perception, audio, UI wiring.
│   ├── agent-core/             :agent-core — pure-JVM Gradle module: the pi-kt
│   │                           agentic runtime (loop + tools + sessions),
│   │                           vendored. No Android/Ktor; reusable. The app's
│   │                           DockStreamFn/DockToolsAdapter depend on it.
│   └── local.properties        BODY_HOST=<ip>:17317 — points the app at
│                               either the sim or the live ESP32.
│
├── bodylink/                   The brain ↔ body protocol + sim.
│   ├── DESIGN.md               ✅ canonical wire spec; absorbs the old
│   │                           README + sim README content.
│   ├── HANDOVER.md             ✅ Kotlin migration plan + copy-paste agent
│   │                           prompt (§8). Includes recipes for driving
│   │                           the live firmware from any IDE (§5.2).
│   └── sim/                    Python MuJoCo body that speaks the protocol.
│       ├── bodies/             MJCF (4 joints — foot/neck/arm.left/arm.right).
│       ├── profiles/dock_companion.json   capability profile (neck + foot).
│       ├── bodylink_sim.py     ✅ speaks the current protocol.
│       ├── bodylink_cli.py     ⚠️ STALE (old set_state protocol); rewrite
│       │                       pending — see HANDOVER.md §3.
│       └── integration_test.py ⚠️ STALE — same. T-list in HANDOVER.md §3.
│
├── body-firmware/              ESP32 firmware projects (one per board build).
│   └── dock_body_v0/           ✅ ESP-IDF firmware, shipped + verified on
│       │                       hardware (XIAO ESP32-S3 + 4× MG90S).
│       │                       Joins Wi-Fi, serves BodyLink WS on :17317.
│       ├── progress.md         milestone log (M1-M4) + hardware lessons
│       │                       (antenna + external 5V — both mandatory).
│       ├── platformio.ini      espressif32@6.13.0 (IDF 5.5.3).
│       ├── src/
│       │   ├── main.c          NVS + servos + Wi-Fi + WS lifecycle.
│       │   ├── servo.{h,c}     mcpwm × 4 on GPIO 3/4/5/6
│       │   │                   (SERVO_NECK / FOOT / ARM_LEFT / ARM_RIGHT).
│       │   ├── wifi_sta.{h,c}  esp_wifi STA join, retry, GOT_IP callback.
│       │   ├── bodylink_proto.{h,c}  JSON envelope encode/decode (cJSON).
│       │   ├── bodylink_motion.{h,c} per-part runtime + smoke profile +
│       │   │                         10 ms motion tick.
│       │   └── bodylink_ws.{h,c}     esp_http_server + dispatch + single-
│       │                             client enforcement.
│       ├── include/
│       │   ├── secrets.h         ⚠️ gitignored. Wi-Fi creds.
│       │   └── secrets.h.example template, checked in.
│       └── scripts/test_body.sh  ✅ interactive REPL client. Drives both
│                                  the live firmware AND the sim. Use
│                                  `--help` for the menu. `;`-batching
│                                  auto-merges parallel motion.
│
├── hardware/                   Physical-build artifacts.
│   ├── README.md               ⚠️ BOM + assembly + servo-layout (target
│   │                           build). Speculative until the dock is
│   │                           physically assembled — bench differs:
│   │                           XIAO ESP32-S3 + 4× MG90S + external 5V,
│   │                           NOT the ESP32-WROOM / PCA9685 / mixed-servo
│   │                           set listed in this file. Banner inside doc.
│   └── 3dprinting/             OpenSCAD source + STL exports.
│       └── PLAN.md             3D-print design notes (active).
│
└── llm/                        On-device LLM adapter design + Koog wiring.
    └── README.md               LiteRT-LM adapter for Koog (not yet built).
```

## State summary

| Component | Status |
|---|---|
| Firmware (ESP-IDF, XIAO ESP32-S3) | ✅ shipped, verified end-to-end |
| Python MuJoCo sim | ✅ speaks the current protocol |
| Capability profile + spec (DESIGN.md) | ✅ current |
| BodyLink Kotlin client | ⚠️ on the previous protocol; migration in [bodylink/HANDOVER.md](bodylink/HANDOVER.md) |
| Agentic brain (DockAgent + :agent-core pi-kt loop) | ✅ tool-calling on gemma4:e2b: set_face/move_body/gesture/move_sequence; streaming, multi-step, vision, talk-while-moving — log-validated on real ESP32 (neck+foot). Physical eyeball pass pending. |
| Sim CLI + integration tests | ⚠️ stale (old `set_state` protocol) |
| Hardware BOM | ⚠️ speculative; rewrites pending |
| Dock app (the rest — face, perception, UI) | ✅ M1-M4 done |
| Real-phone companion / plat / proactive triggers | ⏳ deferred to v2 |

## Where to land for common tasks

| Task | Read first |
|---|---|
| Working on firmware (PlatformIO) | `body-firmware/dock_body_v0/progress.md` |
| Driving the live body from any IDE | `body-firmware/dock_body_v0/scripts/test_body.sh --help` |
| Adding a new part / param to the protocol | `bodylink/DESIGN.md` then `bodylink/sim/bodylink_sim.py` (reference impl) |
| Migrating the Kotlin client | `bodylink/HANDOVER.md` (has a §8 copy-paste agent prompt) |
| Understanding the overall dock product | `README.md` (this dir) — start-here front page |
| Working on the LLM agent / face / perception | `app/PLAN.md` |
| Physical build / 3D-print / wiring | `hardware/README.md` (BOM + assembly merged here; still speculative) |
| Running the sim or driving the firmware | `bodylink/DESIGN.md` §9 (Sim) — same protocol on both |

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
`Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>`.

See `git log --oneline` for examples.

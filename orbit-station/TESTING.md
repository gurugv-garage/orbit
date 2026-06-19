# orbit-station — test plan

How to exercise the station against each real peer: the dock app on an
**emulator**, the dock app on a **physical device**, the **ESP32 firmware**, and
the **browser UI**. Plus a no-hardware smoke path.

All peers connect to the one WebSocket at `/ws` and speak the frame protocol in
[`server/src/core/protocol.ts`](server/src/core/protocol.ts). The station
tolerates any peer being absent — that's a thing to verify, not an error.

---

## 0. Bring up the station

```bash
npm install
npm run build && npm run start        # single process on :8099
# or: npm run dev                      # Vite :5173 proxying backend :8099
```

The banner prints exactly what to point clients at:

```
  UI       http://localhost:8099/
  WS       ws://localhost:8099/ws
  LAN      ws://192.168.1.10:8099/ws      ← ESP32 + physical phone
  emulator ws://10.0.2.2:8099/ws          ← Android AVD
```

`192.168.1.10` is this laptop's `ipconfig getifaddr en0`. The phone, the ESP32,
and the emulator must reach **one of these three** addresses:

| Peer | Connects to | Why |
|---|---|---|
| Browser (same laptop) | `localhost:8099` | local |
| Android **emulator** | `10.0.2.2:8099` | AVD's alias for the host loopback |
| Physical **phone** | `192.168.1.10:8099` | laptop's LAN IP; phone must be on the same Wi-Fi |
| **ESP32** | `192.168.1.10:8099` | same LAN IP |

If the laptop IP changes (new network), re-read it from the banner.

---

## 1. Browser UI (always available)

1. Open `http://localhost:8099/`.
2. Footer dot is **green / "connected"** → the UI's own WS is up.
3. Click every nav item; each view renders its title. (Smoke-verified in CI via
   Playwright: all six load, zero console errors, desktop + mobile layouts.)
4. Resize to a phone width (or DevTools device mode): sidebar collapses to a
   hamburger; cards go single-column.

**Pass:** all views render, connection indicator green, responsive at 390px.

### 1a. Tasks panel (automated, Playwright)

`npm run -w server e2e:console-tasks` drives the Brain console's TASKS panel in a
real Chromium against a live station (`:8099` must be up): run a definition from
the panel, watch a one-shot **complete** and a recurring task **fire**, **stop** /
**restart** / **pause** / **resume** via the panel buttons, confirm bad params are
**refused**, start a task from the **chat** (real LLM), and verify **end session**
**cascades** — stopping every running instance. Each step asserts against the same
REST the UI uses; screenshots → `/tmp/e2e-ct-*.png`. One-time:
`npx playwright install chromium`. `SKIP_CHAT=1` skips the LLM step for a
deterministic run.

**Pass:** `PASS ✅ all console task operations work`; zero orphan task processes.

---

## 2. No-hardware smoke (fake dock + body)

With the server up:

```bash
npm run smoke
```

This connects two short-lived WS peers: a fake **dock app** emitting agent-core
turns on `obs`, and a fake **ESP32 body** advertising a profile + reporting
state on `bodylink`.

Verify in the UI:
- **Overview** → Peers connected = at least 2 (`app` + `firmware` rows in roster).
- **Observability** → turns appear live, each with steps, model badge, tool calls.
- **BodyLink** → neck + foot controls render; moving a slider updates `cmd`, and
  `reported` tracks it (the fake body echoes).

`Ctrl-C` the smoke client → roster drops those peers within ~1s; the UI shows
"No peers" / "No body connected" gracefully. **This is the disconnection test.**

---

## 3. Dock app on the Android emulator

The app holds a WS connection and publishes agent-core `AgentEvent`s on the
`obs` topic (and listens on `config`).

1. Configure the app's station URL to **`ws://10.0.2.2:8099/ws`**.
2. Launch the AVD + app (`node-dock/app`: `./gradlew :app:installDebug`).
3. In **Overview**, confirm an `app` peer appears with the dock's id.
4. Speak/type to the dock to drive a turn. In **Observability**, the turn should
   stream in: `TurnStart → StepStart → (tool calls) → StepEnd → … → TurnEnd`,
   with the step's model + the `set_face`/`move_body`/etc. tool calls.
5. In **Config**, change a `dock` scope value (e.g. `gazeTracking`) → Save+push.
   Confirm the app receives the `config/changed` push (app-side log / behavior).

**Pass:** real agent turns reconstruct correctly; config push reaches the app.

---

## 4. Dock app on a physical device

Same as §3, but:
1. Phone on the **same Wi-Fi** as the laptop (and not on a guest VLAN that
   blocks LAN peer traffic — see PLAN.md §4 risk 6 re: dock VLAN).
2. Station URL → **`ws://192.168.1.10:8099/ws`** (the LAN address from the banner).
3. If using HTTPS (`npm run certs`), use `wss://…` and trust the self-signed
   cert on the device, or stay on `ws://` for bring-up.
4. Repeat the §3 observability + config checks.

**Pass:** identical behavior to the emulator over the real network. Watch for
Wi-Fi flakiness (PLAN.md §4 risk 5) — the StationClient auto-reconnects; the
roster should recover after a network blip without a restart.

---

## 5. ESP32 firmware (BodyLink over WS)

Per `node-dock/bodylink/DESIGN.md`, the ESP32 is a WS client that dials the
station, sends `hello` (role `firmware`) + its `profile`, then streams `state`
and obeys `command` frames. (USB is only for flashing/monitoring via PlatformIO,
**not** a station transport.)

1. Flash + monitor: `pio run -t upload && pio device monitor` (in
   `node-dock/body-firmware/dock_body_v0`).
2. Set the firmware's station URL → **`ws://192.168.1.10:8099/ws`**.
3. On boot the firmware should connect; **Overview** shows a `firmware` peer.
4. **BodyLink** view renders the real profile (parts, param ranges from the
   firmware's `profile`).
5. Drag a slider / press home → station relays a `set_target`; the servo moves;
   `reported` state from the firmware's `state` stream tracks the commanded value.
6. Power-cycle the ESP32 → peer drops, then reappears on reconnect; "No body
   connected" shows in between.

**Pass:** profile-driven console drives real servos; reported state matches;
clean reconnect.

---

## 6. All together

Run §3/§4 (a dock) + §5 (a body) + the browser simultaneously:
- Overview roster shows all peers with correct roles.
- Drive a turn that calls `move_body` on the dock → Observability shows the tool
  call; the **physical** body moves (the dock commands its own body — the
  station console is an independent path to the same body).
- Push a `body` config change → firmware applies it.
- Kill any one peer → the others are unaffected; UI degrades that section only.

---

## Quick reference — endpoints

```
GET   /api/station/health      liveness + uptime
GET   /api/station/modules     registered modules
GET   /api/station/peers       live roster (post-hello peers only)
GET   /api/observability/sessions[/:id]
POST  /api/observability/events            (HTTP ingest alt to WS)
GET   /api/config  ·  PATCH /api/config/:scope
GET   /api/bodylink/profile · /state  ·  POST /api/bodylink/command
GET   /api/bench/results/:file · /images/:file
```

# Peer contract — what the dock app + ESP32 send to orbit-station

The exact frames a **real** dock app and a **real** ESP32 send so they show up
correctly in the station (dock grouping, body-address brokering, agent traces,
body console). Source of truth: [`server/src/core/protocol.ts`](server/src/core/protocol.ts).

> **Status: both sides implemented.**
> - ESP32 station-client: `node-dock/body-firmware/dock_body_v0/src/station_link.{c,h}`
>   (wired in `main.c`; compiles). Phone-facing :17317 server unchanged.
> - Dock app: `node-dock/app/.../dock/station/StationLink.kt` +
>   `DockAgent.shipToStation()` (wired in `DockScreen.kt`; compiles).
> - Both flip on only when their station URL is set, and fall back to baked-in
>   config otherwise (see below). The exact frames below were replayed against a
>   live station and verified ingested (8/8 contract checks).

## The station is OPTIONAL — never a dependency

> The current app + firmware work **standalone** with their **baked-in IPs**:
> the phone dials its ESP32 at the hardcoded `ws://<esp32-ip>:17317`, no station
> involved. That must keep working.
>
> The station is an **enhancement**. The rule is dead simple — no gymnastics:
>
> 1. On boot, **try** to reach the station WS (a configured/known URL).
> 2. **If reachable:** `hello`, and use what it hands back (e.g. the brokered
>    body address) instead of the baked-in value.
> 3. **If not reachable (timeout/closed):** fall back to the **baked-in config**
>    and run exactly as today. Keep retrying the station in the background; adopt
>    its values if/when it comes up.
>
> Nothing the app or firmware *needs* to function comes only from the station.
> The ESP32 also keeps its phone-facing WS **server** on :17317 unchanged.

## Topology recap

```
            ┌─────────────── orbit-station ───────────────┐
            │  /ws  (registry + observability + console)   │
            └───▲───────────────▲──────────────────▲───────┘
    dials in    │   dials in    │      browser ────┘
        ┌───────┴──┐      ┌──────┴───────┐
        │ dock app │      │   ESP32      │
        └────┬─────┘      │ (also a WS   │
             │  dials     │  SERVER for  │
             └───────────▶│  the phone   │  ws://<esp32>:17317
                          │  on :17317)  │
                          └──────────────┘
```

The app and ESP32 **both dial the station as clients**. The ESP32 *additionally*
remains a WS server for the phone (the direct BodyLink link, unchanged). The
station never connects out to the ESP32.

---

## 1. Dock app (Android) → station

Connect to the station WS (e.g. `ws://10.0.2.2:8099/ws` from the emulator,
`ws://<laptop-lan-ip>:8099/ws` from a device — the station banner prints these).

**On open — `hello`:**
```json
{ "t": "hello", "role": "app", "id": "anne-bot-app",
  "dock": "anne-bot", "label": "anne-bot phone" }
```

**Subscribe to what it cares about:**
```json
{ "t": "subscribe", "topics": ["config", "station"] }
```
- `station` → receives `dock-updated` events; reads `payload.bodyAddr` to learn
  where its ESP32 is (instead of the baked-in IP). See §3.
- `config` → receives `changed` / `snapshot` pushes for the `dock` scope.

**Publish agent-core events** as the loop runs (one per `AgentEvent`):
```json
{ "t": "publish", "topic": "obs", "kind": "event",
  "payload": {
    "sessionId": "sess-…", "turnId": "turn-…", "seq": 0,
    "kind": "TurnStart", "ts": 1781234567890
  } }
```
`payload` is an **`AgentEventDto`** — a direct serialization of agent-core's
`AgentEvent` (see [`server/src/modules/observability/types.ts`](server/src/modules/observability/types.ts)
and `docs/AGENT-MODEL.md`). Emit the full sequence:
`TurnStart → StepStart → (MessageEnd, ToolExecutionStart/End)* → StepEnd → … → TurnEnd`.
Put model/usage on `StepEnd.data`, the spoken text on `MessageEnd.data.text`,
tool name/args on `ToolExecutionStart.data`.

---

## 2. ESP32 firmware → station

Add a station **client** mode (the phone-facing server on :17317 is untouched).
Connect to the configured station WS.

**On open — `hello`** (note `bodyAddr` = its own phone-facing server):
```json
{ "t": "hello", "role": "firmware", "id": "anne-bot-esp32",
  "dock": "anne-bot", "label": "anne-bot body",
  "bodyAddr": "192.168.1.42:17317" }
```

**Subscribe** to receive console commands + config:
```json
{ "t": "subscribe", "topics": ["bodylink", "config"] }
```

**Publish its capability profile once** (the BodyLink profile from
`bodylink_proto.h` / DESIGN.md §2), then **stream reported state**:
```json
{ "t": "publish", "topic": "bodylink", "kind": "profile",
  "payload": { "body": { "device_id": "...", "name": "...", "parts": { ... } } } }

{ "t": "publish", "topic": "bodylink", "kind": "state",
  "payload": { "neck": { "pulse_width_us": 1500 }, "foot": { "pulse_width_us": 1500 } } }
```

**Receive console commands** (the bodylink console sends `set_target`):
```json
{ "t": "event", "topic": "bodylink", "kind": "command",
  "payload": { "parts": { "neck": { "pulse_width_us": 1245, "duration_ms": 400 } } } }
```
Apply it exactly like a `set_target` arriving on the phone link — same motion
code path. (This is the station driving the body directly, an independent path
from the phone.)

> The console drives the body **only if the ESP32 connected to the station**. If
> the firmware is in baked-in/standalone mode (no station), the console simply
> shows "no body connected" — and that's fine, the body still obeys the phone.

---

## 3. What the station hands back — `dock-updated`

Whenever a dock's membership changes, the station publishes on `station`:
```json
{ "t": "event", "topic": "station", "kind": "dock-updated",
  "payload": {
    "name": "anne-bot",
    "bodyAddr": "192.168.1.42:17317",
    "app":      { "role": "app",      "id": "anne-bot-app",   "online": true },
    "firmware": { "role": "firmware", "id": "anne-bot-esp32", "online": true }
  } }
```
The app watches for `payload.name === <its dock>` and, if `payload.bodyAddr` is
present, uses it to reach its ESP32 — **overriding the baked-in IP**. If it never
arrives (station down, or no firmware registered), the app keeps the baked-in IP.
That's the whole handshake.

---

## Frame reference

| Frame | From | Purpose |
|---|---|---|
| `hello {role,id,dock?,bodyAddr?,label?}` | peer | announce + join a dock |
| `subscribe {topics}` / `unsubscribe` | peer | topic interest |
| `publish {topic,kind,payload}` | peer | feed a topic (obs events, body state…) |
| `welcome {id,serverTime}` | station | hello ack |
| `event {topic,kind,payload,ts}` | station | fan-out to subscribers |
| `error {message}` | station | bad frame |

Topics: `obs` · `config` · `bodylink` · `mind` · `station`.
Roles: `browser` · `app` · `firmware`.

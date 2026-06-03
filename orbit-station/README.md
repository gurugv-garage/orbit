# orbit-station — central control & observability plane

The hub the orbiting nodes (docks, rover, firmware) talk to. One Node/TypeScript
process: an HTTP(S) server (browser UI + REST), **one WebSocket** every firmware
and app connects to, and an in-process event bus that ties a set of modules
together. Space-themed, dark, responsive browser UI.

> Renamed from **`plat`** (2026-06-02). The old `plat` was specced as a
> Python/Go real-time **media** brain (WebRTC SFU + STT + TTS + ROS2 bridge,
> see `../docs/plan.md` §5). That role is **not** this service — the media
> pipeline is a separate concern, slated to live as a sidecar later. This
> service is the **control plane**: observability, config, body console, and a
> supervisor. See `../docs/plan.md` §5.

## Layout

```
orbit-station/
  server/        Node/TS backend — raw-WS hub + bus + modules + REST
    src/core/      protocol, bus, hub (ws), http, module contract
    src/modules/   observability, config, bodylink, mind, bench, station
    src/dev/       smoke-client.ts — manual end-to-end poke (not part of runtime)
  web/           React + Vite + TS browser UI (space theme)
    src/lib/       station WS client + protocol mirror + hooks
    src/modules/   one view per backend module
    public/modules/bench.html  the dock-LLM benchmark viewer (moved here)
```

## Modules

| Module | Topic | What |
|---|---|---|
| **observability** | `obs` | Ingests agent-core's `AgentEvent` stream (Session ⊃ Turn ⊃ Step ⊃ LLM-call), reconstructs the tree, streams it live. Vocabulary mirrors `node-dock/app/agent-core/AGENT-MODEL.md`. |
| **config** | `config` | Central config: in-code defaults + runtime overrides, **pushed on change** over WS to the ESP32 + dock app (no polling). Scopes: `station` / `dock` / `body`. |
| **bodylink** | `bodylink` | Direct body-control console, bypassing the dock app. Speaks the BodyLink `set_target` protocol (`node-dock/bodylink/DESIGN.md`); profile-driven sliders, live reported state. |
| **mind** | `mind` | **Stub.** Watches the whole bus; takes no action yet. Will become the awareness/trigger layer. |
| **bench** | — | Serves the dock-LLM benchmark snapshots; the viewer is embedded in the UI. |
| **station** | `station` | Meta: health, module registry, live peer roster. |

## Connecting peers (the one WebSocket)

Everything connects to `/ws` and speaks the JSON frame protocol in
[`server/src/core/protocol.ts`](server/src/core/protocol.ts): `hello` →
`subscribe` → `publish` / receive `event`. Peer roles: `browser`, `app`
(dock), `firmware` (ESP32). Peers come and go freely; modules hold last-known
state, so the console tolerates anything being offline.

The startup banner prints the LAN + Android-emulator URLs to point clients at.

## Run

```bash
npm install            # workspaces: server + web

# dev (two processes, hot reload): Vite UI on :5173 proxying to backend on :8099
npm run dev

# prod-style (single process): build the UI, serve it from the backend
npm run build
npm run start          # → http://localhost:8099

# optional: HTTPS (self-signed dev cert)
npm run certs && npm run start   # → https://localhost:8099

# manual end-to-end smoke (with the server up): fake dock + body peers
npm run smoke
```

Testing across emulator / physical device / firmware / browser:
see [TESTING.md](TESTING.md).

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
| **observability** | `obs` | Ingests agent-core's `AgentEvent` stream (Session ⊃ Turn ⊃ Step ⊃ LLM-call), reconstructs the tree, streams it live. Vocabulary mirrors `docs/AGENT-MODEL.md`. |
| **config** | `config` | Central config: in-code defaults + runtime overrides, **pushed on change** over WS to the ESP32 + dock app (no polling). Scopes: `station` / `dock` / `body`. |
| **bodylink** | `bodylink` | Direct body-control console, bypassing the dock app. Speaks the BodyLink `set_target` protocol (`node-dock/bodylink/DESIGN.md`); profile-driven sliders, live reported state. |
| **mind** | `mind` | **Stub.** Watches the whole bus; takes no action yet. Will become the awareness/trigger layer. |
| **media** | `media` | In-process WebRTC **SFU** + a **processing tap** (in-process or sidecar). `docs/MEDIA-PROCESSING.md`. |
| **perception** | `perception` | On-device understanding on the media tap: five shared-format snapshot streams (👁 vision/🎙 speech/👤 identity/😮 emotion/🤖 bodymotion) → Gemini summarizer; the **Perception Studio** console (`/#perception`) is the playground. `../docs/PERCEPTION-PIPELINE.md`. |
| **bench** | — | Serves the dock-LLM benchmark snapshots; the viewer is embedded in the UI. |
| **station** | `station` | Meta: health, module registry, live peer roster. |

Planned: a **brain** module (`agent` topic) hosting the dock's LLM loop
server-side (full cutover — the phone keeps no local loop). Design/risks:
[`../docs/SERVER-BRAIN.md`](../docs/SERVER-BRAIN.md); implementation plan:
[`../docs/SERVER-BRAIN-IMPL.md`](../docs/SERVER-BRAIN-IMPL.md).

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

# dev — ONE port: backend serves the UI on :8099; web + server both rebuild on
# change. Everything (UI, /api, /ws, devices) is http://localhost:8099
npm run dev

# dev:split — two ports, Vite HMR (faster UI hot-reload): UI :5173 proxying to
# backend :8099. Use only if you want instant UI hot-reload.
npm run dev:split

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

## Configuration (`orbit-station/.env`)

Secrets + integration keys live in a gitignored `orbit-station/.env` (KEY=VALUE
lines; a real environment variable wins over the file). Read at boot by
[server/src/main.ts](server/src/main.ts).

| Key | What |
|---|---|
| `GEMINI_API_KEY` | Google Gemini key (the default brain model). |
| `GEMINI_API_KEY_PAID_ACC` | optional paid-tier Gemini key (the always-paid / quota-fallback path). |
| `OPENROUTER_API_KEY` | OpenRouter key (for `openrouter/*` brain models). |
| `SLACK_BOT_TOKEN` | Slack **bot** token (`xoxb-…`). Enables the brain's `send_to_slack` tool and Slack delivery for `take_photo` / `record_video`. Unset → those Slack paths are simply off (the `send_to_slack` tool isn't even offered). |
| `SLACK_DEFAULT_CHANNEL` | optional channel id (`Cxxxx`) or `#name` used when a tool call doesn't name one. |
| `SLACK_APP_TOKEN` | optional Slack **app-level** token (`xapp-…`) for **inbound** Socket Mode — the dock *hearing* Slack. Unset → outbound still works; only inbound is off. (Ingest only for now; auto-responding is parked.) |

### Slack

The dock can post to Slack with three tools: `send_to_slack` (rich text /
Block Kit), `take_photo` (uploads the photo), and `record_video` (uploads the
clip when it's ready). All use the bot token above.

**Full token setup — [docs/SLACK.md](../docs/SLACK.md).** In short:

1. Create a Slack app at <https://api.slack.com/apps> → *From scratch*.
2. **OAuth & Permissions → Bot Token Scopes**: add `chat:write` (post messages)
   and `files:write` (upload photos/videos). Add `chat:write.public` if you want
   to post to public channels the bot hasn't been invited to.
3. **Install to Workspace** → copy the **Bot User OAuth Token** (`xoxb-…`).
4. Put it in `orbit-station/.env`:
   ```
   SLACK_BOT_TOKEN=xoxb-xxxxxxxx
   SLACK_DEFAULT_CHANNEL=#orbit      # optional
   ```
5. **Invite the bot to the channel** in Slack: `/invite @YourApp` (required
   unless you added `chat:write.public`).
6. Restart the station (the `.env` is read at boot). Now ask the dock to "post
   hello to Slack" / "take a photo and send it to Slack".

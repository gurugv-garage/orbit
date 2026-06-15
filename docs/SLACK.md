# Slack setup — sending photos, videos & messages from the dock

The dock brain can post to Slack with three tools, all in-process on
orbit-station (no sidecar, no per-device token):

| Tool | What it does |
|---|---|
| `send_to_slack` | Post a (rich) text message — Slack mrkdwn + Block Kit. |
| `take_photo` | Snap the camera; if a Slack channel/default is set, upload the photo there, else show it on the dock. |
| `record_video` | Record a short clip (1–30s); when it's ready, upload it to Slack (or show on the dock). Kicks off immediately and shares the clip when done. |

Auth is a single **Slack bot token** read from `orbit-station/.env`
(`SLACK_BOT_TOKEN`). With no token, the Slack paths are simply off — the
`send_to_slack` tool isn't even offered to the model, and `take_photo` /
`record_video` fall back to showing media on the dock.

Implementation: [orbit-station/server/src/integrations/slack.ts](../orbit-station/server/src/integrations/slack.ts).

---

## 1. Create a Slack app

1. Go to <https://api.slack.com/apps> and click **Create New App** →
   **From scratch**.
2. Name it (e.g. *orbit*), pick your workspace, **Create App**.

## 2. Add bot token scopes

In the app's settings → **OAuth & Permissions** → **Scopes** → **Bot Token
Scopes**, add all of these. Only `chat:write` + `files:write` are used today; the
rest cover where we're going (the dock reading channels, replying in threads,
reacting with emoji, DMs, resolving user/channel names). Add them now — picking
up a new scope later means **reinstalling** the app and copying a new token.

| Scope | Why |
|---|---|
| `chat:write` | Post messages (`send_to_slack`, and the comment on file uploads). |
| `chat:write.public` | Post to **public** channels the bot hasn't been invited to. (Without it, `/invite` the bot per channel.) |
| `files:write` | Upload photos and video clips (`take_photo`, `record_video`). |
| `files:read` | Read/download files others post (e.g. an image to look at). |
| `channels:history`, `channels:read` | Read messages in + list **public** channels (resolve ids ↔ names). |
| `groups:history`, `groups:read` | Same, for **private** channels the bot is in. |
| `im:history`, `im:read`, `im:write` | Read + open + reply in **direct messages** to the bot. |
| `mpim:history`, `mpim:read`, `mpim:write` | Same, for **group DMs**. |
| `reactions:read`, `reactions:write` | See and add emoji reactions (👍 / ✅ / custom). |
| `emoji:read` | List the workspace's custom emoji (for reactions / rendering). |
| `users:read` | Resolve user ids ↔ names/display info (who sent a message). |
| `users:read.email` | Map a Slack user to an email (tie to a known person). |
| `team:read` | Workspace info (name, icon, domain). |
| `app_mentions:read` | See `@orbit` mentions (the trigger for "respond when called"). |
| `commands` | Back a slash command (`/orbit …`) if we add one. |

> **Receiving messages needs more than scopes.** To have Slack *push* messages
> to the station (so the dock can respond), you'll also enable **Event
> Subscriptions** (Events API) and subscribe to bot events like
> `message.channels`, `message.im`, `app_mention`, `reaction_added`. That needs
> a public HTTPS endpoint on the station for Slack's request-url verification —
> not wired yet; this is the scope groundwork so the token is ready when we build
> it. (Socket Mode is the alternative if we don't want a public URL — it uses an
> **app-level** token, `xapp-…`, in addition to the bot token.)

## 3. Install & copy the token

1. Top of **OAuth & Permissions** → **Install to Workspace** → **Allow**.
2. Copy the **Bot User OAuth Token** — it starts with `xoxb-`.

> Use the **bot** token (`xoxb-…`) — that's what everything here uses. It's not
> the same as a user token (`xoxp-…`) or the app-level token (`xapp-…`). The
> app-level token is only needed later **if** we use Socket Mode for receiving
> events; we'd add it as a separate `SLACK_APP_TOKEN` then.

## 4. Configure orbit-station

Add to `orbit-station/.env` (gitignored — never commit it):

```
SLACK_BOT_TOKEN=xoxb-your-token-here
SLACK_DEFAULT_CHANNEL=#orbit        # optional: used when a tool doesn't name a channel
```

`SLACK_DEFAULT_CHANNEL` accepts a channel id (`Cxxxxxxxx`, found via the channel's
**View channel details → About → Channel ID**) or a `#name`.

## 5. Invite the bot to the channel

In Slack, in the target channel:

```
/invite @orbit
```

(Required unless you added the `chat:write.public` scope and are posting to a
public channel.)

## 6. Restart & try it

The `.env` is read at boot, so restart the station:

```bash
cd orbit-station && npm run dev
```

Then, from the Brain console or by talking to the dock:

- "post *hello from orbit* to Slack"
- "take a photo and send it to Slack"
- "record a 5 second video"

## Verify the setup (live)

Before wiring it into the dock, prove the token + scopes + channel against your
real workspace with the live check — it runs a numbered sequence (send a message,
rich/Block Kit formatting, add + read an emoji reaction, read the channel back,
list emoji, resolve a user, upload a file) and prints `1..N` with ok / FAIL / SKIP
per step:

```bash
cd orbit-station
npm run slack:check                 # uses SLACK_DEFAULT_CHANNEL
npm run slack:check -- '#orbit'     # or pass a channel id / #name
```

A `SKIP` line means a scope from step 2 isn't added yet (add it + reinstall the
app). No station needed — it reads `orbit-station/.env` itself. Source:
[server/src/dev/slack-check.ts](../orbit-station/server/src/dev/slack-check.ts).

---

## Inbound — the dock *hearing* Slack (Socket Mode)

Everything above is **outbound** (the dock posting to Slack). To also let the
dock *hear* Slack — messages, mentions, DMs — the station uses **Socket Mode**:
it opens an **outbound** WebSocket to Slack, so no public URL / tunnel is needed
(the station is LAN-only). Implementation:
[modules/slack/index.ts](../orbit-station/server/src/modules/slack/index.ts) +
[integrations/slack-socket.ts](../orbit-station/server/src/integrations/slack-socket.ts).

> **Current scope: ingest only.** The station connects and receives events from
> every channel the bot can read, records them (feed + `slack` bus topic), and
> logs `@mention` / DM events as "for the session". It does **not auto-respond
> yet** — plain channel messages are deliberately ignored, and the
> mention/DM → live-session response mechanics are parked until outbound is
> stable. This step is the pipe, wired and observable.

### Enable it

1. **App-level token.** In your app → **Basic Information** → **App-Level
   Tokens** → **Generate Token and Scopes**. Name it (e.g. *socket*), add the
   `connections:write` scope, **Generate**, and copy the token — it starts with
   `xapp-`.
2. **Turn on Socket Mode.** App → **Socket Mode** → toggle **Enable Socket
   Mode** on.
3. **Subscribe to events.** App → **Event Subscriptions** → toggle on, then under
   **Subscribe to bot events** add:
   - `message.channels` — messages in public channels the bot is in
   - `message.groups` — messages in private channels the bot is in
   - `message.im` — direct messages to the bot
   - `app_mention` — `@orbit` mentions
   (Reinstall the app if prompted.)
4. **Configure the station** — add the app token to `orbit-station/.env`:
   ```
   SLACK_APP_TOKEN=xapp-your-token-here
   ```
5. **Restart** the station. On boot you'll see
   `[slack] Socket Mode starting (inbound ingest; responding parked)`; check
   `GET /api/slack/status` (socket = `connected`) and `GET /api/slack/feed` for
   the rolling event feed. Without `SLACK_APP_TOKEN` the inbound side is simply
   off and outbound is unaffected.

`npm run slack:check` also reports whether the app token is present and whether a
Socket Mode connection opens.

---

## How it works (under the hood)

- **Messages** → `chat.postMessage` with `text` (and optional `blocks`).
- **Files** (photo / video) → Slack's current external-upload flow:
  `files.getUploadURLExternal` (reserve a one-time URL for the exact byte length)
  → `POST` the bytes to that URL → `files.completeUploadExternal` (share it into
  the channel). All three steps are in `uploadFile()`.
- Every call throws on Slack's `ok:false`, so a misconfigured token / missing
  scope / un-invited channel surfaces as a clear tool error the brain narrates,
  rather than a silent no-op.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| `send_to_slack` isn't offered / brain says it can't post | `SLACK_BOT_TOKEN` not set (or station not restarted after setting it). |
| `slack chat.postMessage failed: not_in_channel` | Invite the bot to the channel (`/invite @app`) or add `chat:write.public`. |
| `slack chat.postMessage failed: channel_not_found` | Wrong channel id/name, or a private channel the bot isn't in. |
| `... failed: missing_scope` | Add the scope (`files:write` for uploads) and **reinstall** the app. |
| `no Slack channel given and SLACK_DEFAULT_CHANNEL is not set` | Pass a channel in the request or set `SLACK_DEFAULT_CHANNEL`. |

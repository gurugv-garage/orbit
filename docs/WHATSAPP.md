# WhatsApp setup — sending & receiving messages from the dock

> **Status: design + setup doc — NOT yet implemented.** This describes the chosen
> approach and the one-time account setup so the credentials are ready. The
> `orbit-station` code (`integrations/whatsapp.ts`, the `send_to_whatsapp` brain
> tool, the inbound webhook) is **not built yet** — the "How it works" section is
> the spec for building it. Until then, nothing below is live.

The dock brain will talk to WhatsApp with one tool, in-process on orbit-station
(no sidecar, no per-device token):

| Tool | What it does |
|---|---|
| `send_to_whatsapp` | Send a text message to a recipient (default `WHATSAPP_DEFAULT_TO`). |

Sending photos is a planned follow-up (parallel to Slack's `take_photo`).

Auth is a **WhatsApp Cloud API token** read from `orbit-station/.env`
(`WHATSAPP_TOKEN`). With no token, the WhatsApp paths are simply off — the
`send_to_whatsapp` tool isn't even offered to the model (same gate as Slack's
`SLACK_BOT_TOKEN`).

**Why the official Cloud API (and not Baileys / whatsapp-web.js):** orbit's use
case is a personal robot pinging *you* and a couple of known people — not bulk
outreach. The official API is **reliable** (near-zero ban risk when used per
policy) and **free at this volume**: a reply orbit sends within 24h of your
message ("service" conversation) is free and unlimited, plus ~1,000 free service
conversations/month. The unofficial libraries are free and need no Meta setup, but
they drive your *personal* number against Meta's ToS, and 2026 ban-detection flags
automation even on long-stable bots — a ban costs your real WhatsApp account. See
the footnote at the end.

Implementation (planned): `orbit-station/server/src/integrations/whatsapp.ts`.

---

## 1. Create a Meta app

1. Go to <https://developers.facebook.com/apps> and **Create App**. Pick the
   **Business** type when prompted.
2. Name it (e.g. *orbit*), finish creating, then on the app dashboard click
   **Add product** → **WhatsApp** → **Set up**.
3. WhatsApp gives you a free **test number** instantly (good enough for personal
   use). You can register your own number later from the same panel.

## 2. Get credentials

In the app → **WhatsApp** → **API Setup**:

- Copy the **Temporary access token** (top of the panel).
- Copy the **Phone number ID** (under "From", below the test number — this is the
  numeric id, *not* the phone number itself).

> **The temporary token expires in 24h.** For anything beyond a quick test, create
> a permanent token: app → **Business Settings** → **Users → System Users** →
> **Add** a system user → **Generate token**, select this app, grant the
> `whatsapp_business_messaging` (and `whatsapp_business_management`) permissions.
> That token doesn't expire. Use it as `WHATSAPP_TOKEN`.

## 3. Add allowed recipients

On the free/test tier you can only message numbers you've added. In **API Setup**
→ under "To", **Manage phone number list** → add your phone number(s) in E.164
form (e.g. `+15551234567`). WhatsApp sends each a one-time confirmation code.
(Once the business number is fully registered + verified, this allow-list
restriction lifts.)

## 4. Configure orbit-station

Add to `orbit-station/.env` (gitignored — never commit it):

```
WHATSAPP_TOKEN=...                    # the (preferably permanent) access token
WHATSAPP_PHONE_NUMBER_ID=...          # numeric Phone number ID from step 2
WHATSAPP_DEFAULT_TO=+15551234567      # E.164; used when a tool doesn't name a recipient
```

The `.env` is read at boot, so changes require a station restart.

## 5. Two-way — the dock *hearing* WhatsApp (webhook)

Everything above is **outbound** (the dock sending). To also let the dock *hear*
WhatsApp — your replies, messages — orbit uses a **webhook**: Meta sends an HTTP
POST to the station for each inbound message. Unlike Slack's Socket Mode (an
outbound WebSocket, no public URL needed), WhatsApp's webhook needs a **public
HTTPS URL** pointing at the station.

> Receiving also keeps the **free 24h service window** open — orbit's replies stay
> free as long as you've messaged it within the last day.

1. **Expose the station publicly.** A reverse tunnel is fine:
   ```bash
   ngrok http 8099
   # or:  cloudflared tunnel --url http://localhost:8099
   ```
   Use the resulting `https://…` URL below. (For a fixed home setup, use a stable
   named tunnel or a reverse proxy so the URL doesn't change.)
2. **Set the callback URL.** Meta dashboard → app → **WhatsApp** →
   **Configuration** → **Webhook** → **Edit**:
   - **Callback URL:** `<public-url>/api/whatsapp/webhook`
   - **Verify token:** any string you choose.
3. **Configure the station** — add to `orbit-station/.env`:
   ```
   WHATSAPP_VERIFY_TOKEN=<the same string from step 2>
   WHATSAPP_APP_SECRET=<optional: app secret, to validate X-Hub-Signature-256>
   ```
   (The app secret is on the app's **Settings → Basic** page.)
4. **Restart** the station, then click **Verify and save** in the dashboard. Meta
   does a `GET` handshake against the callback URL — it must succeed before the URL
   saves. (If it fails: tunnel down, station not restarted, or verify-token
   mismatch.)
5. **Subscribe to messages.** Same Configuration page → **Webhook fields** →
   subscribe to **`messages`**.

## 6. Restart & try it

```bash
cd orbit-station && npm run dev
```

Then, from the Brain console or by talking to the dock:

- "send *hello from orbit* to my WhatsApp"
- (two-way) send a WhatsApp message to the orbit number and confirm the dock
  reacts.

---

## How it works (under the hood) — implementation spec

This is the design for the not-yet-written code; it mirrors the Slack integration
([integrations/slack.ts](../orbit-station/server/src/integrations/slack.ts)).

- **Outbound** → `POST https://graph.facebook.com/v21.0/<PHONE_NUMBER_ID>/messages`
  with header `Authorization: Bearer <WHATSAPP_TOKEN>` and JSON body:
  ```json
  { "messaging_product": "whatsapp", "to": "<E.164>", "type": "text", "text": { "body": "…" } }
  ```
  Use plain Node `fetch()` and throw on a non-ok response — the same pattern as
  `slack.ts`'s `call()`, so a bad token / unallowed recipient surfaces as a clear
  tool error the brain narrates rather than a silent no-op.
- **Free window** → a reply sent within 24h of the user's last inbound message is
  free. An *unprompted* business-initiated message needs a pre-approved
  **template**; the design defaults to staying inside the free service window
  (orbit replies to you), so templates aren't required for the common case.
- **Inbound** → Meta POSTs events to `/api/whatsapp/webhook`. The handler:
  - `GET` → verification handshake: echo `hub.challenge` when
    `hub.verify_token === WHATSAPP_VERIFY_TOKEN`.
  - `POST` → parse `entry[].changes[].value.messages[]` → sender + text, then feed
    the brain through the **same entry point Slack inbound uses**, so the dock
    "hears" WhatsApp identically. If `WHATSAPP_APP_SECRET` is set, validate the
    `X-Hub-Signature-256` HMAC first. Respond `200` quickly (Meta retries on
    non-200).

Where the code will live:

| Piece | Location | Mirror of |
|---|---|---|
| Integration helper (`whatsappEnabled()`, `sendMessage()`, env readers) | `orbit-station/server/src/integrations/whatsapp.ts` | `integrations/slack.ts` |
| Brain tool (`send_to_whatsapp`, gated on `whatsappEnabled()`, appended to `agent.state.tools` next to `buildSlackTools()`) | `modules/brain/{schemas.ts, tools.ts, session.ts}` | the `send_to_slack` tool |
| Inbound webhook | a `/api/whatsapp` module mount | the `/api/slack` module |

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| `send_to_whatsapp` isn't offered / brain says it can't send | `WHATSAPP_TOKEN` / `WHATSAPP_PHONE_NUMBER_ID` not set (or station not restarted after setting them). |
| Send fails: recipient not in allowed list | On the free tier, add the number under **API Setup → Manage phone number list** (step 3). |
| Send fails: `(#190) access token has expired` | The temporary token lapsed after 24h — switch to a permanent System User token (step 2). |
| Webhook won't save / "verification failed" | Tunnel down, station not restarted, or `WHATSAPP_VERIFY_TOKEN` doesn't match what you typed in the dashboard. |
| Outbound works but inbound is silent | Subscribe to the **`messages`** webhook field (step 5.5); confirm the tunnel URL still matches the callback URL. |
| Send fails: message outside 24h window | The user hasn't messaged in 24h — an unprompted message now needs a pre-approved template. |

---

## Footnote: unofficial libraries (not recommended)

If you genuinely want **zero Meta setup** and accept the risk, libraries like
[Baileys](https://github.com/WhiskeySockets/Baileys) or `whatsapp-web.js` let you
link a WhatsApp account by scanning a QR code — free, no Business account. **But**
they drive an account against Meta's ToS, and 2026 ban-detection bans automation
even on numbers stable for years. **Only do this on a throwaway / burner number**,
never your personal one. This is not orbit's chosen path and isn't wired into the
station.

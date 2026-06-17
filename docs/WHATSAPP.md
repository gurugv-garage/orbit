# WhatsApp setup — sending & receiving messages from the dock

> **Status: outbound BUILT & live; inbound webhook not yet built.** The
> `send_to_whatsapp` brain tool + `integrations/whatsapp.ts` exist and are gated
> on `WHATSAPP_TOKEN`; a live check (`npm run whatsapp:check -w server`) sends a
> real message. The Meta app "orbit" (App ID `1760660891596109`, business
> portfolio "Guru GV", WABA `2488487064924852`) is set up with the free **test
> number +1 555 667 4854** and a permanent System User token. **Still a spec:**
> the inbound webhook (§5) and sending photos.

The dock brain talks to WhatsApp with one tool, in-process on orbit-station (no
sidecar, no per-device token). The as-built design + decisions are in the
**"As-built design"** section below; this top half is the one-time account setup.

| Tool | What it does |
|---|---|
| `send_to_whatsapp` | Send a text message to one recipient (`to`, default `WHATSAPP_DEFAULT_TO`) or the same text to several (`recipients[]`, each a 1:1 chat). |

**No group sends.** The Cloud API can't post to a WhatsApp *group* (Meta's
Groups API is limited-access / not on the test number), so "message the group"
means listing the people — `recipients[]` fans the same text out to each as an
individual chat, collecting per-recipient success/failure. For real group/channel
posting, use Slack (`send_to_slack`).

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

Implementation: [integrations/whatsapp.ts](../orbit-station/server/src/integrations/whatsapp.ts).

---

## As-built design (outbound) & decisions

This is what the committed code does and *why* — the design record for the
outbound path. (Inbound is still the spec in §5 / "How it works".)

**Shape.** One in-process tool, no sidecar, no per-device token — the station
already holds the credential, so the tool just `import`s the integration and
calls `fetch`. This mirrors `integrations/slack.ts` exactly (same `call()` /
gate / "throw on non-ok" pattern), so there's one mental model for both.

**The tool surface.** `send_to_whatsapp` takes `text` plus *either*:
- `to` — one recipient (E.164), or omitted to use `WHATSAPP_DEFAULT_TO`; or
- `recipients[]` — the **same** text fanned out to several people.

**Decision — no group sends; fan-out instead.** The WhatsApp Cloud API cannot
post to a WhatsApp *group*: `to` is always a single phone number, and Meta's
Groups API is limited-access (approved BSPs only, group must be created *by* the
business, not on the free test number). Rather than pretend, "message the group"
is modelled as **fan-out to individuals** — `sendMessageToMany()` sends each as
its own 1:1 chat. The tool description says this explicitly so the model lists
the people instead of inventing a group id, and points at Slack
(`send_to_slack`) for real channel/group posting. *Not allowed by design: any
"send to a WhatsApp group" path — it's a Meta restriction we don't work around.*

**Decision — partial-failure is collected, not fatal.** In a fan-out, each send
is independent; one bad / non-allow-listed number doesn't abort the batch.
`sendMessageToMany()` returns `{ sent[], failed[] }` and the tool reports e.g.
*"Sent to 2 people, but couldn't reach: +1555…"* so the brain narrates the truth.

**Decision — normalize + dedupe recipients.** The model may pass `+91 98442
11401`, `919844211401`, or `0049 151…`; `normalizeTo()` strips `+`, spaces,
dashes and a leading `00`, validates 6–15 digits, and the fan-out dedupes — so
the same person isn't messaged twice and a malformed entry becomes a clean
`failed` row, not a thrown batch.

**Decision — stay inside the free 24h service window.** `sendMessage()` sends a
plain `text` body (free + unlimited within 24h of the user's last inbound). An
*unprompted* message outside that window needs a pre-approved template; we don't
build templates — outside the window Meta returns an error the tool surfaces
verbatim, rather than silently failing.

**Gate.** `whatsappEnabled()` (token **and** phone-number-id present) decides
whether `buildWhatsAppTools()` returns the tool at all — with no creds it's never
offered to the model, so the brain can't claim an ability it lacks (same gate as
Slack's `slackEnabled()`).

**Open design — resolving people → numbers (NOT solved yet).** Today the tool
takes only **E.164 numbers**, so *"send a message to guru"* has nothing to map
"guru" → `+91…`. This differs from Slack, which has a real directory: `slack.ts`'s
`resolveUser()` looks a name/@handle/email up against `users.list` for the whole
workspace, so the model can say "DM guru" and it resolves. WhatsApp has **no such
directory** — the Cloud API gives you a *number*, never a contact book, and
there's no equivalent of `users.list`. So a name→number map has to be *ours*.
For now the brain only sends to a number it's given (or `WHATSAPP_DEFAULT_TO`);
if the user says a bare name, the right behavior is to **ask for the number**
rather than guess. A contacts map is the main pending design piece — see below.

**Verified.** `whatsapp.test.ts` (mocked fetch) covers shaping / normalization /
fan-out / partial failure; `npm run whatsapp:check -w server` does a real live
send; and a real LLM brain turn was confirmed to fire the tool end-to-end.

## Pending / not built

| Item | Notes |
|---|---|
| **Contacts: name → number** | *"Message guru"* can't resolve a name to a number — WhatsApp has no directory (unlike Slack's `resolveUser`), so the map must be ours. **Proposed:** a small contacts table — simplest is env (`WHATSAPP_CONTACTS="guru=+919844211401,amma=+91…"`) parsed into a `resolveContact(name)`; or a JSON file / config-console list when it grows. The tool gains a `name`/`contact` arg (or `to` accepts a known name) that resolves via this map, falling back to "ask for the number" on a miss — never guessing. Could later be unified with perception identities (the dock already names faces) so "tell the person I'm looking at". |
| **Inbound webhook** (`/api/whatsapp`) | The dock *hearing* WhatsApp replies. Design is §5 + "How it works → Inbound"; needs a public HTTPS URL (tunnel) and a `/api/whatsapp` module mounting the verify-handshake + message parse into the same brain entry point Slack inbound uses. |
| **Sending photos** | Parallel to Slack's `take_photo` — upload media + send an `image` message. Not yet wired. |
| **Branding (name + logo)** | The test number shows a raw number; a custom display name + the eyes profile photo need a **registered** business number (see "Branding" under §6). Deferred. |
| **Templates** | For unprompted messages outside the 24h window. Out of scope while orbit only *replies* to the user. |

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

First, a quick standalone live check (no station needed) — proves the token,
phone-number-id, and recipient allow-list are right by sending a real message:

```bash
npm run whatsapp:check -w server                 # sends to WHATSAPP_DEFAULT_TO
npm run whatsapp:check -w server -- +15551234567 # or pass a recipient (E.164)
```

Then, from the Brain console or by talking to the dock:

- "send *hello from orbit* to my WhatsApp"
- (two-way) send a WhatsApp message to the orbit number and confirm the dock
  reacts. *(inbound webhook not built yet — see §5.)*

### Branding (name + logo) — needs a registered number

Recipients see the sender's **number** (no business name/logo) on the free test
number — Meta only allows a custom **display name** + **profile photo** on a
**registered** business number (your own, added + verified in WhatsApp Manager,
display name reviewed by Meta). Deferred until orbit uses a real number.

---

## How it works (under the hood)

Outbound is **built** and mirrors the Slack integration
([integrations/slack.ts](../orbit-station/server/src/integrations/slack.ts));
inbound (the webhook) is still the spec below.

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

| Piece | Location | Mirror of | State |
|---|---|---|---|
| Integration helper (`whatsappEnabled()`, `sendMessage()`, env readers) | [integrations/whatsapp.ts](../orbit-station/server/src/integrations/whatsapp.ts) (+ `whatsapp.test.ts`) | `integrations/slack.ts` | **built** |
| Brain tool (`send_to_whatsapp`, gated on `whatsappEnabled()`, appended to `agent.state.tools` via `buildWhatsAppTools()` next to `buildSlackTools()`) | `modules/brain/{schemas.ts, tools.ts, session.ts}` | the `send_to_slack` tool | **built** |
| Live setup check (`npm run whatsapp:check -w server`) | `server/src/dev/whatsapp-check.ts` | `slack:check` | **built** |
| Inbound webhook | a `/api/whatsapp` module mount | the `/api/slack` module | spec only |

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

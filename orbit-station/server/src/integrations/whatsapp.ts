/**
 * WhatsApp integration — the dock brain's `send_to_whatsapp` tool sends here.
 * In-process, plain `fetch`, no SDK (mirrors integrations/slack.ts).
 *
 * Auth is a WhatsApp Cloud API token (`WHATSAPP_TOKEN`) read from the station's
 * environment (orbit-station/.env), alongside `WHATSAPP_PHONE_NUMBER_ID` (the
 * numeric id of the sending number) and `WHATSAPP_DEFAULT_TO` (the default
 * recipient in E.164). Because tools run in the station process, they just
 * `import` this and call it — no station capability / round-trip.
 *
 * `whatsappEnabled()` is the gate: without a token + phone-number-id the
 * `send_to_whatsapp` tool is not even offered to the model (same gate as Slack's
 * `slackEnabled()`), so the brain never claims an ability it can't perform.
 *
 * FREE WINDOW: a text reply sent within 24h of the user's last inbound message
 * is free and unlimited. An *unprompted* business-initiated message outside that
 * window needs a pre-approved template — sendMessage() sends a plain text body,
 * so it works inside the window; outside it Meta returns an error the brain
 * narrates (rather than a silent no-op).
 *
 * SETUP (how to get a token + number id): see docs/whatsapp.md.
 */

const GRAPH = 'https://graph.facebook.com/v21.0';

/** The Cloud API token, or undefined when WhatsApp isn't configured. */
export function whatsappToken(): string | undefined {
  const t = process.env.WHATSAPP_TOKEN?.trim();
  return t ? t : undefined;
}

/** The sending phone-number id (numeric), or undefined when not configured. */
export function whatsappPhoneNumberId(): string | undefined {
  const id = process.env.WHATSAPP_PHONE_NUMBER_ID?.trim();
  return id ? id : undefined;
}

/** The default recipient (E.164, e.g. +15551234567) when a tool omits one. */
export function whatsappDefaultTo(): string | undefined {
  const to = process.env.WHATSAPP_DEFAULT_TO?.trim();
  return to ? to : undefined;
}

/** Is WhatsApp wired? (token + phone-number-id present.) Gates the tool. */
export function whatsappEnabled(): boolean {
  return whatsappToken() != null && whatsappPhoneNumberId() != null;
}

function token(): string {
  const t = whatsappToken();
  if (!t) throw new Error('WhatsApp is not configured (set WHATSAPP_TOKEN in orbit-station/.env)');
  return t;
}

function phoneNumberId(): string {
  const id = whatsappPhoneNumberId();
  if (!id) throw new Error('WhatsApp is not configured (set WHATSAPP_PHONE_NUMBER_ID in orbit-station/.env)');
  return id;
}

/** Resolve the recipient, preferring an explicit one over the default. */
function resolveTo(to?: string): string {
  const t = to?.trim() || whatsappDefaultTo();
  if (!t) throw new Error('no WhatsApp recipient given and WHATSAPP_DEFAULT_TO is not set');
  return normalizeTo(t);
}

/**
 * Normalize a recipient to the bare digits the Graph API wants. The API accepts
 * E.164 with or without the leading `+`; we strip the `+` (and any spaces /
 * dashes the model may include) so `+91 98123 45678` and `919812345678` are
 * equivalent. A leading `00` international prefix is dropped too.
 */
function normalizeTo(to: string): string {
  let s = to.replace(/[\s\-()]/g, '');
  s = s.replace(/^\+/, '');
  s = s.replace(/^00/, '');
  if (!/^\d{6,15}$/.test(s)) throw new Error(`"${to}" is not a valid phone number (use E.164, e.g. +15551234567)`);
  return s;
}

/**
 * POST to the Cloud API messages endpoint → parsed JSON; throws on a non-ok
 * response with the API's error message, so a bad token / unallowed recipient /
 * outside-the-24h-window surfaces as a clear tool error the brain narrates.
 */
async function call(body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const res = await fetch(`${GRAPH}/${phoneNumberId()}/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token()}` },
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    const err = (data.error as { message?: string; code?: number } | undefined);
    throw new Error(`whatsapp send failed: ${err?.message ?? `HTTP ${res.status}`}`);
  }
  return data;
}

export interface SendMessageOpts {
  /** recipient in E.164 (`+15551234567`); falls back to WHATSAPP_DEFAULT_TO. */
  to?: string;
  /** the message text. WhatsApp supports *bold*, _italic_, ~strike~, ```mono```. */
  text: string;
  /** disable link previews for URLs in the text (default: previews on). */
  noPreview?: boolean;
}

/** Send a plain text message. Returns the recipient + the message id (wamid).
 *  Works free inside the 24h service window; outside it Meta requires a
 *  pre-approved template and returns an error this surfaces. */
export async function sendMessage(opts: SendMessageOpts): Promise<{ to: string; messageId: string }> {
  const to = resolveTo(opts.to);
  const data = await call({
    messaging_product: 'whatsapp',
    to,
    type: 'text',
    text: { body: opts.text, ...(opts.noPreview ? { preview_url: false } : { preview_url: true }) },
  });
  const messages = data.messages as Array<{ id?: string }> | undefined;
  return { to, messageId: String(messages?.[0]?.id ?? '') };
}

export interface SendManyResult {
  /** recipients that received the message, with their wamid. */
  sent: Array<{ to: string; messageId: string }>;
  /** recipients that failed, with the reason (bad number, not allow-listed, …). */
  failed: Array<{ to: string; error: string }>;
}

/**
 * Send the SAME text to several recipients as individual 1:1 messages (WhatsApp
 * has no group send via the Cloud API). Each send is independent: one bad
 * number / unallowed recipient doesn't stop the rest — failures are collected
 * and returned so the caller can report exactly who got it and who didn't.
 *
 * `recipients` may include the raw `+91 …` the model passed; each is normalized
 * (and deduped) before sending. An empty list throws.
 */
export async function sendMessageToMany(recipients: string[], text: string, opts: { noPreview?: boolean } = {}): Promise<SendManyResult> {
  // Normalize + dedupe up front; a malformed entry becomes a `failed` row rather
  // than aborting the whole batch.
  const seen = new Set<string>();
  const targets: Array<{ raw: string; norm?: string; err?: string }> = [];
  for (const raw of recipients) {
    if (!raw?.trim()) continue;
    try {
      const norm = normalizeTo(raw);
      if (seen.has(norm)) continue;
      seen.add(norm);
      targets.push({ raw, norm });
    } catch (err) {
      targets.push({ raw, err: err instanceof Error ? err.message : String(err) });
    }
  }
  if (targets.length === 0) throw new Error('no WhatsApp recipients given');

  const sent: SendManyResult['sent'] = [];
  const failed: SendManyResult['failed'] = [];
  for (const t of targets) {
    if (t.err) { failed.push({ to: t.raw, error: t.err }); continue; }
    try {
      const r = await sendMessage({ to: t.norm, text, noPreview: opts.noPreview });
      sent.push(r);
    } catch (err) {
      failed.push({ to: t.raw, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return { sent, failed };
}

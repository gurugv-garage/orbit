/**
 * Slack Socket Mode client — the INBOUND half (the dock hearing Slack).
 *
 * Slack delivers events two ways: an Events-API webhook (needs a public HTTPS
 * URL) or **Socket Mode** (the app opens an OUTBOUND WebSocket to Slack). The
 * station is LAN-only / behind NAT, so Socket Mode is the fit — no public URL.
 *
 * Protocol (no SDK — just `ws`, like the rest of this integration):
 *   1. POST apps.connections.open with the APP-LEVEL token (xapp-…) → a wss URL.
 *   2. Connect. Slack sends {type:'hello'}, then envelopes:
 *        {type:'events_api', envelope_id, payload:{event:{…}}}
 *        {type:'disconnect', reason}   ← time to reconnect (Slack rotates the URL)
 *   3. ACK every envelope within 3s: send {envelope_id}.
 *   4. On disconnect/close/error → reopen (fetch a fresh URL).
 *
 * SCOPE FOR NOW (ingest-only — responding is parked until sending is stable):
 * we classify each message event and hand it up via `onEvent`; we DON'T act.
 *   - channel message   → kind 'message'  (the module currently ignores these)
 *   - @mention          → kind 'mention'
 *   - DM to the bot     → kind 'dm'
 * Bot's own messages + non-message events are dropped here so the consumer only
 * sees human input it might care about.
 */

import { WebSocket } from 'ws';

const API = 'https://slack.com/api';
/** Slack requires an envelope ack within 3s; reconnect well before idle limits. */
const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;

export interface SlackEvent {
  /** what kind of human input this is. */
  kind: 'message' | 'mention' | 'dm';
  /** the channel id the message is in (Cxxxx / Gxxxx / Dxxxx for a DM). */
  channel: string;
  /** the Slack user id who sent it. */
  user: string;
  /** message text. */
  text: string;
  /** the message ts (also the thread root for a top-level message). */
  ts: string;
  /** the thread this belongs to, if it's a threaded reply. */
  threadTs?: string;
  /** the raw Slack event, for anything the typed fields don't carry. */
  raw: Record<string, unknown>;
}

export interface SlackSocketOpts {
  /** the bot's own user id (from auth.test) — so we drop the bot's own messages. */
  botUserId?: string;
  /** called for each classified human message event. */
  onEvent: (ev: SlackEvent) => void;
  /** connection state changes, for status/logging. */
  onStatus?: (state: 'connecting' | 'connected' | 'disconnected', detail?: string) => void;
  log?: (line: string) => void;
}

/**
 * A self-healing Socket Mode connection. `start()` connects (and keeps
 * reconnecting); `stop()` tears down for good. Uses the app-level token (xapp-).
 */
export class SlackSocket {
  #appToken: string;
  #opts: SlackSocketOpts;
  #ws?: WebSocket;
  #stopped = false;
  #retry = 0;
  #reconnectTimer?: ReturnType<typeof setTimeout>;
  #connected = false;

  constructor(appToken: string, opts: SlackSocketOpts) {
    this.#appToken = appToken;
    this.#opts = opts;
  }

  get connected(): boolean { return this.#connected; }

  start(): void {
    this.#stopped = false;
    void this.#open();
  }

  stop(): void {
    this.#stopped = true;
    if (this.#reconnectTimer) clearTimeout(this.#reconnectTimer);
    try { this.#ws?.close(); } catch { /* */ }
    this.#ws = undefined;
    this.#connected = false;
  }

  async #open(): Promise<void> {
    if (this.#stopped) return;
    this.#opts.onStatus?.('connecting');
    let url: string;
    try {
      url = await this.#openConnection();
    } catch (err) {
      this.#log(`connections.open failed: ${String(err)}`);
      this.#scheduleReconnect();
      return;
    }
    const ws = new WebSocket(url);
    this.#ws = ws;

    ws.on('open', () => {
      this.#retry = 0;
      this.#connected = true;
      this.#opts.onStatus?.('connected');
      this.#log('socket mode connected');
    });
    ws.on('message', (raw) => this.#onMessage(raw.toString()));
    ws.on('error', (e) => this.#log(`ws error: ${String(e)}`));
    ws.on('close', () => {
      this.#connected = false;
      this.#opts.onStatus?.('disconnected');
      if (!this.#stopped) this.#scheduleReconnect();
    });
  }

  /** Ask Slack for a fresh Socket Mode WSS URL (rotates each connection). */
  async #openConnection(): Promise<string> {
    const res = await fetch(`${API}/apps.connections.open`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        authorization: `Bearer ${this.#appToken}`,
      },
    });
    const data = (await res.json()) as { ok?: boolean; error?: string; url?: string };
    if (!data.ok || !data.url) {
      throw new Error(`apps.connections.open: ${String(data.error ?? res.status)}`);
    }
    return data.url;
  }

  #onMessage(raw: string): void {
    let frame: any;
    try { frame = JSON.parse(raw); } catch { return; }
    switch (frame.type) {
      case 'hello':
        // handshake complete — Slack confirms the socket is live.
        return;
      case 'disconnect':
        // Slack is rotating us off this URL; reconnect with a fresh one.
        this.#log(`disconnect (${frame.reason ?? 'unknown'}) — reconnecting`);
        try { this.#ws?.close(); } catch { /* */ }
        return;
      case 'events_api':
        // ACK FIRST (within 3s), then handle — never let processing delay the ack.
        if (frame.envelope_id) this.#send({ envelope_id: frame.envelope_id });
        this.#handleEvent(frame.payload?.event);
        return;
      default:
        // slash_commands / interactive — also need an ack; ignore the body for now.
        if (frame.envelope_id) this.#send({ envelope_id: frame.envelope_id });
        return;
    }
  }

  /** Classify a Slack `event` into a SlackEvent we care about, or drop it. */
  #handleEvent(event: any): void {
    if (!event || typeof event !== 'object') return;
    // We only handle human messages + mentions. Everything else is dropped here.
    const isMessage = event.type === 'message';
    const isMention = event.type === 'app_mention';
    if (!isMessage && !isMention) return;

    // Drop bot/system noise: the bot's own messages, edits/deletes/joins
    // (subtype present), and messages with no user.
    if (event.subtype) return;
    if (event.bot_id) return;
    const user = String(event.user ?? '');
    if (!user || (this.#opts.botUserId && user === this.#opts.botUserId)) return;

    const channel = String(event.channel ?? '');
    const text = String(event.text ?? '');
    const ts = String(event.ts ?? '');
    const threadTs = event.thread_ts ? String(event.thread_ts) : undefined;

    // Classify: app_mention is always a mention; a 'message' in a DM channel
    // (channel_type 'im') is a dm; anything else is a plain channel message.
    const kind: SlackEvent['kind'] = isMention
      ? 'mention'
      : event.channel_type === 'im'
        ? 'dm'
        : 'message';

    try {
      this.#opts.onEvent({ kind, channel, user, text, ts, threadTs, raw: event as Record<string, unknown> });
    } catch (err) {
      this.#log(`onEvent threw: ${String(err)}`);
    }
  }

  #scheduleReconnect(): void {
    if (this.#stopped) return;
    const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** this.#retry++);
    this.#log(`reconnecting in ${delay}ms`);
    this.#reconnectTimer = setTimeout(() => void this.#open(), delay);
    this.#reconnectTimer.unref?.();
  }

  #send(obj: unknown): void {
    try { this.#ws?.send(JSON.stringify(obj)); } catch { /* socket gone */ }
  }

  #log(line: string): void { this.#opts.log?.(`[slack-socket] ${line}`); }
}

/** Read the app-level (xapp-) token from env, or undefined. Distinct from the
 *  bot token: Socket Mode needs an app-level token with connections:write. */
export function slackAppToken(): string | undefined {
  const t = process.env.SLACK_APP_TOKEN?.trim();
  return t ? t : undefined;
}

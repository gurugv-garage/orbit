/**
 * Slack integration — the dock brain's `send_to_slack` / `take_photo` /
 * `record_video` tools post here. In-process, plain `fetch`, no SDK.
 *
 * Auth is a BOT TOKEN (`SLACK_BOT_TOKEN`, `xoxb-…`) read from the station's
 * environment (orbit-station/.env). Because tools run in the station process,
 * they just `import` this and call it — no station capability / round-trip.
 *
 * Two surfaces:
 *   - postMessage(): rich text via `chat.postMessage` (markdown + Block Kit).
 *   - uploadFile():  a real photo/video file via Slack's current upload flow
 *     (files.getUploadURLExternal → PUT bytes → files.completeUploadExternal).
 *
 * `slackEnabled()` is the gate: no token → the `send_to_slack` tool is not even
 * offered to the model (so it never claims an ability it can't perform).
 *
 * SETUP (how to get a token): see orbit-station/README.md "Slack" and the
 * docs/SLACK.md walkthrough.
 */

import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';

const API = 'https://slack.com/api';

/** The bot token, or undefined when Slack isn't configured. */
export function slackToken(): string | undefined {
  const t = process.env.SLACK_BOT_TOKEN?.trim();
  return t ? t : undefined;
}

/** Is Slack wired? (token present.) Gates whether the tool is offered. */
export function slackEnabled(): boolean {
  return slackToken() != null;
}

/** The default channel (id or #name) when a tool doesn't specify one. */
export function slackDefaultChannel(): string | undefined {
  const c = process.env.SLACK_DEFAULT_CHANNEL?.trim();
  return c ? c : undefined;
}

/** Resolve the channel to use, preferring an explicit one over the default. */
function resolveChannel(channel?: string): string {
  const c = channel?.trim() || slackDefaultChannel();
  if (!c) throw new Error('no Slack channel given and SLACK_DEFAULT_CHANNEL is not set');
  return c;
}

function token(): string {
  const t = slackToken();
  if (!t) throw new Error('Slack is not configured (set SLACK_BOT_TOKEN in orbit-station/.env)');
  return t;
}

/** A Web API call returns `{ ok: boolean, error?, ... }`; throw on `ok:false`. */
async function call(method: string, body: unknown): Promise<Record<string, unknown>> {
  const res = await fetch(`${API}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json; charset=utf-8', authorization: `Bearer ${token()}` },
    body: JSON.stringify(body),
  });
  const data = (await res.json()) as Record<string, unknown>;
  if (!data.ok) throw new Error(`slack ${method} failed: ${String(data.error ?? res.status)}`);
  return data;
}

const channelIdCache = new Map<string, string>();

/**
 * Resolve a `#name` (or bare `name`) to a channel ID, since some APIs
 * (files.completeUploadExternal) require the ID, not the name. A value that's
 * already an ID (`C…`/`G…`/`D…`) passes through. Cached per process.
 */
async function resolveChannelId(channel: string): Promise<string> {
  if (/^[CGD][A-Z0-9]{6,}$/.test(channel)) return channel; // already an id
  const name = channel.replace(/^#/, '');
  const cached = channelIdCache.get(name);
  if (cached) return cached;
  // page through the channels the bot can see until we find the name.
  let cursor: string | undefined;
  do {
    const d = await call('conversations.list', {
      limit: 1000, exclude_archived: true,
      types: 'public_channel,private_channel', ...(cursor ? { cursor } : {}),
    });
    for (const c of (d.channels as Array<{ id?: string; name?: string }> | undefined) ?? []) {
      if (c.name && c.id) channelIdCache.set(c.name, c.id);
    }
    cursor = (d.response_metadata as { next_cursor?: string } | undefined)?.next_cursor || undefined;
  } while (cursor && !channelIdCache.has(name));
  const id = channelIdCache.get(name);
  if (!id) throw new Error(`slack channel "${channel}" not found (is the bot in it?)`);
  return id;
}

/** Who the bot is, per auth.test (used to drop the bot's own inbound messages,
 *  and to confirm the token works). Throws if the token is invalid. */
export async function whoAmI(): Promise<{ userId: string; botId?: string; team: string; user: string }> {
  const d = await call('auth.test', {});
  return { userId: String(d.user_id ?? ''), botId: d.bot_id ? String(d.bot_id) : undefined, team: String(d.team ?? ''), user: String(d.user ?? '') };
}

export interface PostMessageOpts {
  /** channel id (Cxxxx) or #name; falls back to SLACK_DEFAULT_CHANNEL. */
  channel?: string;
  /** plain text / mrkdwn (the fallback + simple case). */
  text: string;
  /** optional Block Kit blocks for rich layout (overrides `text` rendering). */
  blocks?: unknown[];
  /** reply inside a thread (the parent message ts). */
  threadTs?: string;
}

/** Post a (possibly rich) message. Returns the channel + ts of the message. */
export async function postMessage(opts: PostMessageOpts): Promise<{ channel: string; ts: string }> {
  const channel = resolveChannel(opts.channel);
  const data = await call('chat.postMessage', {
    channel, text: opts.text,
    ...(opts.blocks ? { blocks: opts.blocks } : {}),
    ...(opts.threadTs ? { thread_ts: opts.threadTs } : {}),
  });
  return { channel: String(data.channel ?? channel), ts: String(data.ts ?? '') };
}

export interface UploadFileOpts {
  channel?: string;
  /** file on disk to upload … */
  filePath?: string;
  /** … OR raw bytes (with `filename`) — e.g. a base64 photo decoded to a Buffer. */
  bytes?: Buffer;
  /** required when `bytes` is given; derived from `filePath` otherwise. */
  filename?: string;
  /** the file's title in Slack. */
  title?: string;
  /** a message posted alongside the file. */
  initialComment?: string;
}

/**
 * Upload a file (photo/video) to a channel using Slack's current external-upload
 * flow: get a one-time upload URL, PUT the bytes to it, then complete the upload
 * (which shares it into the channel). Throws on any step failing.
 */
export async function uploadFile(opts: UploadFileOpts): Promise<{ fileId: string }> {
  // completeUploadExternal needs a channel ID, not a #name — resolve it.
  const channel = await resolveChannelId(resolveChannel(opts.channel));
  const bytes = opts.bytes ?? (opts.filePath ? await readFile(opts.filePath) : undefined);
  if (!bytes) throw new Error('uploadFile needs filePath or bytes');
  const filename = opts.filename ?? (opts.filePath ? basename(opts.filePath) : 'upload.bin');

  // 1) reserve a one-time upload URL for the file's exact byte length
  //    (files.getUploadURLExternal is a GET with query params).
  const url = new URL(`${API}/files.getUploadURLExternal`);
  url.searchParams.set('filename', filename);
  url.searchParams.set('length', String(bytes.byteLength));
  const r1 = await fetch(url, { headers: { authorization: `Bearer ${token()}` } });
  const d1 = (await r1.json()) as { ok?: boolean; error?: string; upload_url?: string; file_id?: string };
  if (!d1.ok || !d1.upload_url || !d1.file_id) {
    throw new Error(`slack files.getUploadURLExternal failed: ${String(d1.error ?? r1.status)}`);
  }

  // 2) PUT the raw bytes to the one-time URL.
  const put = await fetch(d1.upload_url, { method: 'POST', body: bytes });
  if (!put.ok) throw new Error(`slack upload PUT failed: ${put.status}`);

  // 3) complete the upload, sharing it into the channel.
  await call('files.completeUploadExternal', {
    files: [{ id: d1.file_id, ...(opts.title ? { title: opts.title } : {}) }],
    channel_id: channel,
    ...(opts.initialComment ? { initial_comment: opts.initialComment } : {}),
  });
  return { fileId: d1.file_id };
}

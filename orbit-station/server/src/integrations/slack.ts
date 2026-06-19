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
 * docs/slack.md walkthrough.
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

/**
 * A Web API call → `{ ok, error?, ... }`; throws on `ok:false`.
 *
 * Slack's POST methods are FORM-encoded — many read methods (conversations.*,
 * users.*) reject a JSON body with `invalid_arguments`. So we form-encode every
 * field, JSON-stringifying any array/object value (blocks, files), which Slack
 * accepts. (A flat JSON body works for chat.postMessage but not universally, so
 * form is the single safe encoding for all of them.)
 */
async function call(method: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const form = new URLSearchParams();
  for (const [k, v] of Object.entries(body)) {
    if (v == null) continue;
    form.set(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
  }
  const res = await fetch(`${API}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded; charset=utf-8', authorization: `Bearer ${token()}` },
    body: form.toString(),
  });
  const data = (await res.json()) as Record<string, unknown>;
  if (!data.ok) throw new Error(`slack ${method} failed: ${String(data.error ?? res.status)}`);
  return data;
}

const channelIdCache = new Map<string, string>();

interface ListedChannel { id?: string; name?: string; is_member?: boolean; is_archived?: boolean }

/**
 * Resolve a `#name` (or bare `name`) to a channel ID, since some APIs
 * (files.completeUploadExternal) require the ID, not the name. A value already
 * an ID (`C…`/`G…`/`D…`) is VERIFIED (see below) rather than blindly trusted.
 *
 * IMPORTANT: a workspace can have MULTIPLE channels with the same name (an old
 * one archived/left, a new one re-created) — picking the wrong one gives the
 * file API `channel_not_found`. So among same-named matches we PREFER the
 * channel the bot is actually a MEMBER of (and not archived).
 *
 * We also VERIFY a passed-in ID: the model sometimes reuses a STALE channel id
 * it saw earlier (a dead duplicate), which uploads reject. If an id isn't a live
 * channel the bot can reach, we fall back to the configured default channel.
 * Cached per process once resolved.
 */
async function resolveChannelId(channel: string): Promise<string> {
  if (/^[CGD][A-Z0-9]{6,}$/.test(channel)) {
    // A DM channel (Dxxxx) is always taken as-is (not listable). For a C/G id,
    // confirm it's a live channel the bot can use; else fall back to the default.
    if (channel.startsWith('D')) return channel;
    if (await channelIsUsable(channel)) return channel;
    const fallback = slackDefaultChannel();
    if (fallback && fallback.replace(/^#/, '') && !/^[CGD][A-Z0-9]{6,}$/.test(fallback)) {
      return resolveChannelByName(fallback.replace(/^#/, ''), channel);
    }
    return channel; // no usable fallback — let the caller surface the error
  }
  return resolveChannelByName(channel.replace(/^#/, ''), channel);
}

/** Is this channel id one the bot can post/upload to (exists, not archived, member)? */
async function channelIsUsable(id: string): Promise<boolean> {
  try {
    const d = await call('conversations.info', { channel: id });
    const c = d.channel as ListedChannel | undefined;
    return !!c && !c.is_archived && c.is_member !== false;
  } catch { return false; }
}

/** Resolve a bare channel name → id, preferring the channel the bot is in. */
async function resolveChannelByName(name: string, original: string): Promise<string> {
  const cached = channelIdCache.get(name);
  if (cached) return cached;

  const matches: ListedChannel[] = [];
  let cursor: string | undefined;
  do {
    const d = await call('conversations.list', {
      limit: 1000, exclude_archived: true,
      types: 'public_channel,private_channel', ...(cursor ? { cursor } : {}),
    });
    for (const c of (d.channels as ListedChannel[] | undefined) ?? []) {
      if (c.name === name && c.id) matches.push(c);
    }
    cursor = (d.response_metadata as { next_cursor?: string } | undefined)?.next_cursor || undefined;
  } while (cursor);

  // Prefer a channel the bot is a member of; else any non-archived; else any.
  const pick = matches.find((c) => c.is_member && !c.is_archived)
    ?? matches.find((c) => !c.is_archived)
    ?? matches[0];
  if (!pick?.id) throw new Error(`slack channel "${original}" not found (is the bot in it?)`);
  channelIdCache.set(name, pick.id);
  return pick.id;
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

/** Post a (possibly rich) message. Returns the channel + ts of the message.
 *  The channel is resolved/verified (a stale id heals to the default channel),
 *  so the same robustness as uploads applies to plain messages. */
export async function postMessage(opts: PostMessageOpts): Promise<{ channel: string; ts: string }> {
  const channel = await resolveChannelId(resolveChannel(opts.channel));
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

  // 2) PUT the raw bytes to the one-time URL. Pass a Uint8Array view (not the
  //  Buffer directly): under nodenext/es2022 the fetch BodyInit overload rejects
  //  Buffer, though it's a Uint8Array subclass at runtime. (The task-authoring
  //  typecheck compiles this with those flags, so a raw Buffer fails there.)
  const put = await fetch(d1.upload_url, { method: 'POST', body: new Uint8Array(bytes) });
  if (!put.ok) throw new Error(`slack upload PUT failed: ${put.status}`);

  // 3) complete the upload, sharing it into the channel.
  await call('files.completeUploadExternal', {
    files: [{ id: d1.file_id, ...(opts.title ? { title: opts.title } : {}) }],
    channel_id: channel,
    ...(opts.initialComment ? { initial_comment: opts.initialComment } : {}),
  });
  return { fileId: d1.file_id };
}

// ── people: resolve / list members / DM ──────────────────────────────────────

export interface SlackUser {
  id: string;
  /** the @handle (users.list `name`). */
  handle: string;
  /** the chosen display name, else real name, else handle. */
  display: string;
  isBot: boolean;
}

/** id → user, and lowercased handle/display/email → user. Built from users.list,
 *  cached for the process; refreshed on a miss so new people resolve. */
const userById = new Map<string, SlackUser>();
const userByKey = new Map<string, SlackUser>(); // handle/display/email (lowercased)
let usersLoaded = false;

function indexUser(m: any): SlackUser {
  const p = m.profile ?? {};
  const display = String(p.display_name || p.real_name || m.name || m.id);
  const u: SlackUser = { id: String(m.id), handle: String(m.name ?? ''), display, isBot: !!m.is_bot };
  userById.set(u.id, u);
  for (const k of [u.handle, display, p.email].filter(Boolean)) userByKey.set(String(k).toLowerCase(), u);
  return u;
}

/** Load (or refresh) the workspace user directory via users.list (paged). */
async function loadUsers(): Promise<void> {
  let cursor: string | undefined;
  do {
    const d = await call('users.list', { limit: 200, ...(cursor ? { cursor } : {}) });
    for (const m of (d.members as any[] | undefined) ?? []) {
      if (!m?.deleted) indexUser(m);
    }
    cursor = (d.response_metadata as { next_cursor?: string } | undefined)?.next_cursor || undefined;
  } while (cursor);
  usersLoaded = true;
}

/**
 * Resolve a person to a Slack user. Accepts a user id (`U…`), an @handle, a
 * display/real name, or an email — case-insensitive. Returns undefined if no
 * match. Loads the directory on first use; on a miss, refreshes once (a newly
 * added person resolves without a restart).
 */
export async function resolveUser(nameOrIdOrEmail: string): Promise<SlackUser | undefined> {
  const q = nameOrIdOrEmail.trim();
  if (!q) return undefined;
  if (/^U[A-Z0-9]{6,}$/.test(q)) {
    if (userById.has(q)) return userById.get(q);
    // an id we haven't indexed — fetch it directly.
    try { const d = await call('users.info', { user: q }); return indexUser(d.user); } catch { return undefined; }
  }
  const key = q.replace(/^@/, '').toLowerCase();
  if (!usersLoaded) await loadUsers();
  if (userByKey.has(key)) return userByKey.get(key);
  await loadUsers(); // refresh once in case they were added since we cached
  return userByKey.get(key);
}

/** The user IDs in a channel (conversations.members, paged). Channel may be a
 *  `#name` or an id. */
export async function listChannelMembers(channel: string): Promise<SlackUser[]> {
  const channelId = await resolveChannelId(resolveChannel(channel));
  const ids: string[] = [];
  let cursor: string | undefined;
  do {
    const d = await call('conversations.members', { channel: channelId, limit: 200, ...(cursor ? { cursor } : {}) });
    for (const id of (d.members as string[] | undefined) ?? []) ids.push(id);
    cursor = (d.response_metadata as { next_cursor?: string } | undefined)?.next_cursor || undefined;
  } while (cursor);
  // Prime the directory once so each id resolves from cache (not N× users.info).
  if (!usersLoaded) await loadUsers();
  const out: SlackUser[] = [];
  for (const id of ids) { const u = await resolveUser(id); if (u) out.push(u); }
  return out;
}

/** Open (or reuse) a DM with a user and post a message there. `user` may be an
 *  id, @handle, name, or email. Returns the DM channel id + message ts. */
export async function dmUser(user: string, text: string, opts: { blocks?: unknown[] } = {}): Promise<{ channel: string; ts: string }> {
  const u = await resolveUser(user);
  if (!u) throw new Error(`no Slack user matched "${user}"`);
  const open = await call('conversations.open', { users: u.id });
  const channel = String((open.channel as { id?: string } | undefined)?.id ?? '');
  if (!channel) throw new Error('could not open a DM channel');
  return postMessage({ channel, text, ...(opts.blocks ? { blocks: opts.blocks } : {}) });
}

/** A Slack mention token for a resolved user (`<@U123>`), for embedding in text. */
export function mentionOf(user: SlackUser): string {
  return `<@${user.id}>`;
}

/** TEST ONLY: clear the per-process user/channel caches so each test starts
 *  fresh (the directory is otherwise cached for the process lifetime). */
export function __resetCachesForTests(): void {
  userById.clear();
  userByKey.clear();
  channelIdCache.clear();
  usersLoaded = false;
}

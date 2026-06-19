/**
 * slack:check — exercise the LIVE Slack setup end-to-end (messaging, reactions,
 * reading, file upload) against your real workspace, printing a numbered
 * `n..N` pass/fail line per check. Unlike slack.test.ts (which mocks fetch),
 * this hits Slack for real to prove the token + scopes + channel are right.
 *
 * It uses the station's own helper (postMessage/uploadFile) where one exists, and
 * raw Web API calls for the read/reaction surface we haven't wrapped yet — so a
 * green run here also confirms the future-facing scopes from docs/slack.md.
 *
 *   # set SLACK_BOT_TOKEN (+ optionally SLACK_DEFAULT_CHANNEL) in orbit-station/.env
 *   npm run slack:check                 # uses SLACK_DEFAULT_CHANNEL
 *   npm run slack:check -- '#orbit'     # or pass a channel id / #name
 *
 * No station needed. Read-only checks degrade to SKIP if a scope is missing, so
 * you can run it before adding every scope and see exactly what's still pending.
 */
import { readFileSync } from 'node:fs';
import { postMessage, uploadFile, slackToken, slackDefaultChannel, listChannelMembers, resolveUser } from '../integrations/slack.js';
import { SlackSocket, slackAppToken } from '../integrations/slack-socket.js';

// Load orbit-station/.env the same way the station does (real env wins), so this
// runs standalone with just the .env file present.
loadDotEnv(new URL('../../../.env', import.meta.url).pathname);

const API = 'https://slack.com/api';
const channel = process.argv[2] ?? slackDefaultChannel();

/** A raw Web API call (for surface the helper doesn't wrap yet). Form-encoded:
 *  read methods like reactions.get / users.info only parse form params, not JSON. */
async function api(method: string, body?: Record<string, unknown>): Promise<Record<string, any>> {
  const form = new URLSearchParams();
  for (const [k, v] of Object.entries(body ?? {})) form.set(k, String(v));
  const res = await fetch(`${API}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', authorization: `Bearer ${slackToken()}` },
    body: form.toString(),
  });
  return (await res.json()) as Record<string, any>;
}

// ── tiny numbered-test harness ───────────────────────────────────────────────
let n = 0;
let passed = 0;
let failed = 0;
let skipped = 0;
const results: string[] = [];

/** Run one check. Throwing = FAIL; returning the string 'skip:<why>' = SKIP. */
async function check(name: string, fn: () => Promise<string | void>): Promise<void> {
  n++;
  try {
    const r = await fn();
    if (typeof r === 'string' && r.startsWith('skip:')) {
      skipped++;
      results.push(`  ${n}. SKIP  ${name} — ${r.slice('skip:'.length)}`);
    } else {
      passed++;
      results.push(`  ${n}. ok    ${name}${r ? ` — ${r}` : ''}`);
    }
  } catch (err) {
    failed++;
    results.push(`  ${n}. FAIL  ${name} — ${String(err instanceof Error ? err.message : err)}`);
  }
}

/** A Web API call that should succeed; throws Slack's error, or returns it as a
 *  skip when it's the "scope not added yet" case so partial setups read clearly. */
async function ok(method: string, body?: Record<string, unknown>): Promise<Record<string, any>> {
  const d = await api(method, body);
  if (!d.ok) {
    if (d.error === 'missing_scope' || d.error === 'not_allowed_token_type') {
      throw new SkipError(`needs scope (${method}: ${d.error}${d.needed ? `, add ${d.needed}` : ''})`);
    }
    throw new Error(`${method}: ${String(d.error)}`);
  }
  return d;
}
class SkipError extends Error {}

async function main(): Promise<void> {
  console.log('\nslack:check — live Slack setup\n');
  if (!slackToken()) {
    console.error('  SLACK_BOT_TOKEN is not set (orbit-station/.env). Nothing to test.');
    process.exit(1);
  }
  if (!channel) {
    console.error('  No channel: pass one (npm run slack:check -- "#orbit") or set SLACK_DEFAULT_CHANNEL.');
    process.exit(1);
  }
  console.log(`  token: ${slackToken()!.slice(0, 9)}…   channel: ${channel}\n`);

  // shared state across checks (the message we post, then react to / read back).
  let ts = '';
  let resolvedChannel = '';
  const marker = `orbit slack:check ${new Date().toISOString()}`;

  // 1) auth — who am I (proves the token is valid)
  let botUserId = '';
  await check('auth.test (token valid)', async () => {
    const d = await ok('auth.test');
    botUserId = String(d.user_id ?? '');
    return `bot=${d.user} team=${d.team}`;
  });

  // 2) post a plain message
  await check('chat.postMessage (send)', async () => {
    const r = await postMessage({ channel, text: `:wave: ${marker}` });
    ts = r.ts; resolvedChannel = r.channel;
    return `ts=${ts}`;
  });

  // 3) post a RICH message (mrkdwn formatting)
  await check('chat.postMessage (mrkdwn: *bold* _italic_ `code`)', async () => {
    await postMessage({ channel, text: '*bold* _italic_ `code` <https://orbit.local|link> :rocket:' });
  });

  // 4) post Block Kit blocks
  await check('chat.postMessage (Block Kit)', async () => {
    await postMessage({
      channel, text: 'block fallback',
      blocks: [{ type: 'section', text: { type: 'mrkdwn', text: '*orbit* block kit check :white_check_mark:' } }],
    });
  });

  // 5) add an emoji reaction to the message from #2
  await check('reactions.add (emoji 👍)', async () => {
    if (!ts) return 'skip:no message ts (post failed)';
    try { await ok('reactions.add', { channel: resolvedChannel, timestamp: ts, name: 'thumbsup' }); }
    catch (e) { if (e instanceof SkipError) return `skip:${e.message}`; throw e; }
  });

  // 6) read reactions back
  await check('reactions.get (read reactions)', async () => {
    if (!ts) return 'skip:no message ts';
    try {
      const d = await ok('reactions.get', { channel: resolvedChannel, timestamp: ts });
      const names = (d.message?.reactions ?? []).map((r: any) => `:${r.name}:`).join(' ');
      return names || '(none yet)';
    } catch (e) { if (e instanceof SkipError) return `skip:${e.message}`; throw e; }
  });

  // 7) read channel history and find our marker (proves read scope + delivery)
  await check('conversations.history (read back our message)', async () => {
    if (!resolvedChannel) return 'skip:no channel id';
    try {
      const d = await ok('conversations.history', { channel: resolvedChannel, limit: 20 });
      const found = (d.messages ?? []).some((m: any) => typeof m.text === 'string' && m.text.includes(marker));
      if (!found) throw new Error('posted message not found in history');
      return 'found our message';
    } catch (e) { if (e instanceof SkipError) return `skip:${e.message}`; throw e; }
  });

  // 8) list custom emoji (for future reaction/rendering use)
  await check('emoji.list (workspace emoji)', async () => {
    try { const d = await ok('emoji.list'); return `${Object.keys(d.emoji ?? {}).length} custom emoji`; }
    catch (e) { if (e instanceof SkipError) return `skip:${e.message}`; throw e; }
  });

  // 9) resolve a user (users:read) — the bot's own user id is always resolvable
  await check('users.info (resolve a user)', async () => {
    if (!botUserId) return 'skip:no bot user id from auth.test';
    try {
      const d = await ok('users.info', { user: botUserId });
      return `${d.user?.name ?? botUserId}`;
    } catch (e) { if (e instanceof SkipError) return `skip:${e.message}`; throw e; }
  });

  // 10) upload a file (files:write) — a tiny text file stands in for a photo/clip
  await check('files upload (uploadFile)', async () => {
    await uploadFile({
      channel, bytes: Buffer.from(`orbit slack:check upload @ ${new Date().toISOString()}\n`),
      filename: 'orbit-slack-check.txt', title: 'orbit slack:check', initialComment: 'file upload check',
    });
  });

  // 11) list the channel's members (conversations.members + users.list)
  let aMemberName = '';
  await check('list channel members', async () => {
    try {
      const members = await listChannelMembers(channel!);
      const people = members.filter((m) => !m.isBot);
      aMemberName = people[0]?.display ?? '';
      return `${people.length} people${members.length - people.length ? ` (+${members.length - people.length} bot)` : ''}`;
    } catch (e) { if (e instanceof SkipError) return `skip:${e.message}`; throw e; }
  });

  // 12) resolve a person by name (users.list directory)
  await check('resolve a user by name', async () => {
    if (!aMemberName) return 'skip:no human member to resolve';
    const u = await resolveUser(aMemberName);
    if (!u) throw new Error(`could not resolve "${aMemberName}" back to a user`);
    return `${aMemberName} → ${u.id}`;
  });

  // 13) inbound: Socket Mode connects (needs SLACK_APP_TOKEN; SKIP if unset)
  await check('Socket Mode connect (inbound)', async () => {
    const appToken = slackAppToken();
    if (!appToken) return 'skip:SLACK_APP_TOKEN not set (inbound off — see docs/slack.md)';
    const connected = await new Promise<boolean>((resolve) => {
      const sock = new SlackSocket(appToken, {
        botUserId, onEvent: () => {},
        onStatus: (s) => { if (s === 'connected') { sock.stop(); resolve(true); } },
      });
      sock.start();
      setTimeout(() => { sock.stop(); resolve(false); }, 8_000);
    });
    if (!connected) throw new Error('did not connect within 8s (check app token + connections:write + Socket Mode enabled)');
    return 'connected';
  });

  // ── report ─────────────────────────────────────────────────────────────────
  console.log(results.join('\n'));
  console.log(`\n  ${n} checks — ${passed} ok, ${failed} fail, ${skipped} skip`);
  if (failed === 0 && skipped > 0) {
    console.log('  (SKIPs are scopes from docs/slack.md not added yet — add them + reinstall the app.)');
  }
  console.log('');
  process.exit(failed === 0 ? 0 : 1);
}

/** Minimal .env loader (mirrors main.ts) so this runs without the station. */
function loadDotEnv(path: string): void {
  try {
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (!m || line.trim().startsWith('#')) continue;
      if (process.env[m[1]!] == null) process.env[m[1]!] = m[2]!;
    }
  } catch { /* no .env — rely on the real environment */ }
}

main().catch((err) => { console.error('slack:check crashed', err); process.exit(1); });

/**
 * Slack integration unit tests (node:test). No network — global `fetch` is
 * stubbed so we assert the request shaping (endpoint, body) and the enabled gate.
 *
 *   npm test --workspace server
 */

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { postMessage, uploadFile, slackEnabled, slackDefaultChannel, resolveUser, dmUser, listChannelMembers, __resetCachesForTests } from './slack.js';

const realFetch = globalThis.fetch;
let calls: Array<{ url: string; init?: RequestInit }> = [];

/** Decode a captured Web API request body. Web API calls are form-encoded (with
 *  array/object fields JSON-stringified); the upload PUT isn't a Web API call. */
function bodyOf(call: { init?: RequestInit }): Record<string, any> {
  const params = new URLSearchParams(String(call.init?.body ?? ''));
  const out: Record<string, any> = {};
  for (const [k, v] of params) { try { out[k] = JSON.parse(v); } catch { out[k] = v; } }
  return out;
}

/** Stub fetch with a per-URL responder. */
function stubFetch(responder: (url: string, init?: RequestInit) => unknown) {
  calls = [];
  globalThis.fetch = (async (input: any, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    const body = responder(url, init);
    return { ok: true, status: 200, json: async () => body } as Response;
  }) as typeof fetch;
}

beforeEach(() => {
  process.env.SLACK_BOT_TOKEN = 'xoxb-test';
  delete process.env.SLACK_DEFAULT_CHANNEL;
  __resetCachesForTests(); // fresh user/channel caches per test
});
afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env.SLACK_BOT_TOKEN;
  delete process.env.SLACK_DEFAULT_CHANNEL;
});

test('slackEnabled reflects the token', () => {
  assert.equal(slackEnabled(), true);
  delete process.env.SLACK_BOT_TOKEN;
  assert.equal(slackEnabled(), false);
});

test('slackDefaultChannel reads the env (trimmed, optional)', () => {
  assert.equal(slackDefaultChannel(), undefined);
  process.env.SLACK_DEFAULT_CHANNEL = '  #general  ';
  assert.equal(slackDefaultChannel(), '#general');
});

test('postMessage posts to chat.postMessage with the channel + text', async () => {
  stubFetch((url) => {
    if (url.includes('conversations.list')) return { ok: true, channels: [{ id: 'C123', name: 'general', is_member: true }] };
    return { ok: true, channel: 'C123', ts: '1.2' };
  });
  const r = await postMessage({ channel: '#general', text: 'hi *there*' });
  const post = calls.find((c) => c.url.includes('chat.postMessage'))!;
  const body = bodyOf(post);
  assert.equal(body.channel, 'C123', '#general resolved to its id');
  assert.equal(body.text, 'hi *there*');
  assert.deepEqual(r, { channel: 'C123', ts: '1.2' });
});

test('postMessage falls back to the default channel', async () => {
  process.env.SLACK_DEFAULT_CHANNEL = 'C0DEF9999'; // a default id, verified usable
  stubFetch((url) => {
    if (url.includes('conversations.info')) return { ok: true, channel: { id: 'C0DEF9999', is_member: true } };
    return { ok: true, channel: 'C0DEF9999', ts: '1' };
  });
  await postMessage({ text: 'hello' });
  assert.equal(bodyOf(calls.find((c) => c.url.includes('chat.postMessage'))!).channel, 'C0DEF9999');
});

test('postMessage with no channel and no default throws', async () => {
  stubFetch(() => ({ ok: true }));
  await assert.rejects(() => postMessage({ text: 'x' }), /no Slack channel/);
});

test('postMessage throws on Slack ok:false', async () => {
  stubFetch(() => ({ ok: false, error: 'channel_not_found' }));
  await assert.rejects(() => postMessage({ channel: '#x', text: 'y' }), /channel_not_found/);
});

test('uploadFile runs the 3-step external upload flow (a usable channel id is used as-is)', async () => {
  stubFetch((url) => {
    if (url.includes('conversations.info')) return { ok: true, channel: { id: 'C0AB12CD3', is_member: true } };
    if (url.includes('files.getUploadURLExternal')) {
      return { ok: true, upload_url: 'https://files.slack/upload/abc', file_id: 'F1' };
    }
    if (url.includes('files.completeUploadExternal')) return { ok: true };
    if (url.includes('/upload/abc')) return {}; // the PUT
    return { ok: true };
  });
  const r = await uploadFile({ channel: 'C0AB12CD3', bytes: Buffer.from('jpegbytes'), filename: 'p.jpg', title: 'cap' });
  assert.deepEqual(r, { fileId: 'F1' });
  const reserve = calls.find((c) => c.url.includes('files.getUploadURLExternal'))!;
  assert.match(reserve.url, /\?filename=p\.jpg&length=9$/);
  const complete = bodyOf(calls.find((c) => c.url.includes('files.completeUploadExternal'))!);
  assert.equal(complete.channel_id, 'C0AB12CD3', 'a verified id is used as-is');
  assert.deepEqual(complete.files, [{ id: 'F1', title: 'cap' }]);
  assert.ok(!calls.some((c) => c.url.includes('conversations.list')), 'no name lookup for a usable id');
});

test('uploadFile HEALS a stale channel id to the default channel', async () => {
  process.env.SLACK_DEFAULT_CHANNEL = '#orbit';
  stubFetch((url) => {
    // the passed id is dead → conversations.info fails …
    if (url.includes('conversations.info')) return { ok: false, error: 'channel_not_found' };
    // … so we fall back to the default #orbit, which resolves to the live id.
    if (url.includes('conversations.list')) return { ok: true, channels: [{ id: 'C0LIVE99', name: 'orbit', is_member: true }] };
    if (url.includes('files.getUploadURLExternal')) return { ok: true, upload_url: 'https://files.slack/upload/h', file_id: 'F9' };
    if (url.includes('files.completeUploadExternal')) return { ok: true };
    return { ok: true };
  });
  await uploadFile({ channel: 'C0DEADBEEF', bytes: Buffer.from('x'), filename: 'p.jpg' });
  assert.equal(bodyOf(calls.find((c) => c.url.includes('files.completeUploadExternal'))!).channel_id, 'C0LIVE99',
    'stale id healed to the live default channel');
});

test('uploadFile resolves a #name to a channel id (completeUploadExternal needs the id)', async () => {
  stubFetch((url) => {
    if (url.includes('conversations.list')) {
      return { ok: true, channels: [{ id: 'C0ORBIT01', name: 'orbit', is_member: true }] };
    }
    if (url.includes('files.getUploadURLExternal')) {
      return { ok: true, upload_url: 'https://files.slack/upload/xyz', file_id: 'F2' };
    }
    if (url.includes('files.completeUploadExternal')) return { ok: true };
    return { ok: true };
  });
  await uploadFile({ channel: '#orbit', bytes: Buffer.from('x'), filename: 'p.jpg' });
  assert.equal(bodyOf(calls.at(-1)!).channel_id, 'C0ORBIT01', '#orbit resolved to its id');
});

test('resolveChannelId prefers the channel the bot is a MEMBER of among same-named duplicates', async () => {
  // Mirrors the real bug: an old #orbit (left/stale) + the current one the bot
  // joined. The file API only accepts the one the bot is in.
  stubFetch((url) => {
    if (url.includes('conversations.list')) {
      return { ok: true, channels: [
        { id: 'C_STALE', name: 'orbit', is_member: false, is_archived: false },
        { id: 'C_REAL', name: 'orbit', is_member: true, is_archived: false },
      ] };
    }
    if (url.includes('files.getUploadURLExternal')) {
      return { ok: true, upload_url: 'https://files.slack/upload/m', file_id: 'F3' };
    }
    if (url.includes('files.completeUploadExternal')) return { ok: true };
    return { ok: true };
  });
  await uploadFile({ channel: '#orbit', bytes: Buffer.from('x'), filename: 'p.jpg' });
  assert.equal(bodyOf(calls.at(-1)!).channel_id, 'C_REAL', 'picked the member channel, not the stale one');
});

// ── people: resolve / DM / members ───────────────────────────────────────────
// Note: the user directory is cached per process; tests use UNIQUE names so a
// cached entry from one test can't satisfy another, and reset caches per test.

test('resolveUser matches by display name, handle, and email (from users.list)', async () => {
  stubFetch((url) => {
    if (url.includes('users.list')) {
      return { ok: true, members: [
        { id: 'U0ALICE1', name: 'alice', profile: { display_name: 'Alice A', real_name: 'Alice Anderson', email: 'alice@x.com' } },
        { id: 'U0BOB123', name: 'bob', is_bot: false, profile: { display_name: '', real_name: 'Bob B' } },
      ] };
    }
    return { ok: true };
  });
  assert.equal((await resolveUser('Alice A'))?.id, 'U0ALICE1', 'by display name');
  assert.equal((await resolveUser('@alice'))?.id, 'U0ALICE1', 'by @handle');
  assert.equal((await resolveUser('alice@x.com'))?.id, 'U0ALICE1', 'by email');
  assert.equal((await resolveUser('Bob B'))?.id, 'U0BOB123', 'falls back to real_name');
  assert.equal((await resolveUser('U0ALICE1'))?.handle, 'alice', 'an id resolves from cache');
});

test('dmUser opens a DM and posts to the returned channel', async () => {
  stubFetch((url) => {
    if (url.includes('users.list')) return { ok: true, members: [{ id: 'U0CARL12', name: 'carl', profile: { display_name: 'Carl' } }] };
    if (url.includes('conversations.open')) return { ok: true, channel: { id: 'D0CARL12' } };
    if (url.includes('chat.postMessage')) return { ok: true, channel: 'D0CARL12', ts: '9.9' };
    return { ok: true };
  });
  const r = await dmUser('Carl', 'hey privately');
  assert.equal(r.channel, 'D0CARL12');
  const openBody = bodyOf(calls.find((c) => c.url.includes('conversations.open'))!);
  assert.equal(openBody.users, 'U0CARL12', 'opens a DM with the resolved user id');
  const postBody = bodyOf(calls.find((c) => c.url.includes('chat.postMessage'))!);
  assert.equal(postBody.channel, 'D0CARL12', 'posts into the DM channel');
});

test('listChannelMembers resolves member ids to users', async () => {
  stubFetch((url) => {
    if (url.includes('conversations.members')) return { ok: true, members: ['U0DAVE12', 'U0BOTX12'] };
    if (url.includes('users.list')) return { ok: true, members: [
      { id: 'U0DAVE12', name: 'dave', profile: { display_name: 'Dave' } },
      { id: 'U0BOTX12', name: 'botx', is_bot: true, profile: { display_name: 'BotX' } },
    ] };
    return { ok: true };
  });
  const members = await listChannelMembers('C0AB12CD3');
  assert.deepEqual(members.map((m) => m.display).sort(), ['BotX', 'Dave']);
  assert.equal(members.find((m) => m.id === 'U0BOTX12')?.isBot, true);
});

/**
 * Slack integration unit tests (node:test). No network — global `fetch` is
 * stubbed so we assert the request shaping (endpoint, body) and the enabled gate.
 *
 *   npm test --workspace server
 */

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { postMessage, uploadFile, slackEnabled, slackDefaultChannel } from './slack.js';

const realFetch = globalThis.fetch;
let calls: Array<{ url: string; init?: RequestInit }> = [];

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
  stubFetch(() => ({ ok: true, channel: 'C123', ts: '1.2' }));
  const r = await postMessage({ channel: '#general', text: 'hi *there*' });
  assert.equal(calls.length, 1);
  assert.match(calls[0]!.url, /chat\.postMessage$/);
  const body = JSON.parse(String(calls[0]!.init!.body));
  assert.equal(body.channel, '#general');
  assert.equal(body.text, 'hi *there*');
  assert.deepEqual(r, { channel: 'C123', ts: '1.2' });
});

test('postMessage falls back to the default channel', async () => {
  process.env.SLACK_DEFAULT_CHANNEL = 'C999';
  stubFetch(() => ({ ok: true, channel: 'C999', ts: '1' }));
  await postMessage({ text: 'hello' });
  const body = JSON.parse(String(calls[0]!.init!.body));
  assert.equal(body.channel, 'C999');
});

test('postMessage with no channel and no default throws', async () => {
  stubFetch(() => ({ ok: true }));
  await assert.rejects(() => postMessage({ text: 'x' }), /no Slack channel/);
});

test('postMessage throws on Slack ok:false', async () => {
  stubFetch(() => ({ ok: false, error: 'channel_not_found' }));
  await assert.rejects(() => postMessage({ channel: '#x', text: 'y' }), /channel_not_found/);
});

test('uploadFile runs the 3-step external upload flow (channel id passes through)', async () => {
  stubFetch((url) => {
    if (url.includes('files.getUploadURLExternal')) {
      return { ok: true, upload_url: 'https://files.slack/upload/abc', file_id: 'F1' };
    }
    if (url.includes('files.completeUploadExternal')) return { ok: true };
    if (url.includes('/upload/abc')) return {}; // the PUT
    return { ok: true };
  });
  const r = await uploadFile({ channel: 'C0AB12CD3', bytes: Buffer.from('jpegbytes'), filename: 'p.jpg', title: 'cap' });
  assert.deepEqual(r, { fileId: 'F1' });
  // 1) reserve URL (with filename + length), 2) PUT bytes, 3) complete.
  assert.match(calls[0]!.url, /files\.getUploadURLExternal\?filename=p\.jpg&length=9$/);
  assert.equal(calls[1]!.url, 'https://files.slack/upload/abc');
  assert.match(calls[2]!.url, /files\.completeUploadExternal$/);
  const complete = JSON.parse(String(calls[2]!.init!.body));
  assert.equal(complete.channel_id, 'C0AB12CD3', 'an id is used as-is (no lookup)');
  assert.deepEqual(complete.files, [{ id: 'F1', title: 'cap' }]);
  assert.ok(!calls.some((c) => c.url.includes('conversations.list')), 'no name lookup for an id');
});

test('uploadFile resolves a #name to a channel id (completeUploadExternal needs the id)', async () => {
  stubFetch((url) => {
    if (url.includes('conversations.list')) {
      return { ok: true, channels: [{ id: 'C0ORBIT01', name: 'orbit' }] };
    }
    if (url.includes('files.getUploadURLExternal')) {
      return { ok: true, upload_url: 'https://files.slack/upload/xyz', file_id: 'F2' };
    }
    if (url.includes('files.completeUploadExternal')) return { ok: true };
    return { ok: true };
  });
  await uploadFile({ channel: '#orbit', bytes: Buffer.from('x'), filename: 'p.jpg' });
  const complete = JSON.parse(String(calls.at(-1)!.init!.body));
  assert.equal(complete.channel_id, 'C0ORBIT01', '#orbit resolved to its id');
});

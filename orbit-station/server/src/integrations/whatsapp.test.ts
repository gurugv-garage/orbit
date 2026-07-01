/**
 * WhatsApp integration unit tests (node:test). No network — global `fetch` is
 * stubbed so we assert the request shaping (endpoint, body) and the enabled gate.
 *
 *   npm test --workspace server
 */

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { sendMessage, sendMessageToMany, whatsappEnabled, whatsappDefaultTo } from './whatsapp.js';

const realFetch = globalThis.fetch;
let calls: Array<{ url: string; init?: RequestInit }> = [];

function bodyOf(call: { init?: RequestInit }): Record<string, any> {
  try { return JSON.parse(String(call.init?.body ?? '{}')); } catch { return {}; }
}

/** Stub fetch with a per-call responder; default is a successful send reply. */
function stubFetch(responder?: (url: string, init?: RequestInit) => { ok?: boolean; status?: number; body?: unknown }) {
  calls = [];
  globalThis.fetch = (async (input: any, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    const r = responder?.(url, init) ?? {};
    return {
      ok: r.ok ?? true,
      status: r.status ?? 200,
      json: async () => r.body ?? { messaging_product: 'whatsapp', messages: [{ id: 'wamid.TEST' }] },
    } as Response;
  }) as typeof fetch;
}

beforeEach(() => {
  process.env.WHATSAPP_TOKEN = 'EAA-test';
  process.env.WHATSAPP_PHONE_NUMBER_ID = '12345';
  delete process.env.WHATSAPP_DEFAULT_TO;
});
afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env.WHATSAPP_TOKEN;
  delete process.env.WHATSAPP_PHONE_NUMBER_ID;
  delete process.env.WHATSAPP_DEFAULT_TO;
});

test('whatsappEnabled needs both token and phone-number-id', () => {
  assert.equal(whatsappEnabled(), true);
  delete process.env.WHATSAPP_PHONE_NUMBER_ID;
  assert.equal(whatsappEnabled(), false);
  delete process.env.WHATSAPP_TOKEN;
  assert.equal(whatsappEnabled(), false);
});

test('sendMessage posts to the messages endpoint with bearer auth + text body', async () => {
  stubFetch();
  const r = await sendMessage({ to: '+15551234567', text: 'hi there' });
  assert.equal(calls.length, 1);
  assert.match(calls[0]!.url, /\/12345\/messages$/);
  assert.equal((calls[0]!.init?.headers as any).authorization, 'Bearer EAA-test');
  const body = bodyOf(calls[0]!);
  assert.equal(body.messaging_product, 'whatsapp');
  assert.equal(body.type, 'text');
  assert.equal(body.text.body, 'hi there');
  assert.equal(body.to, '15551234567'); // normalized: no '+'
  assert.equal(r.messageId, 'wamid.TEST');
});

test('recipient is normalized (strips +, spaces, dashes, leading 00)', async () => {
  stubFetch();
  await sendMessage({ to: '+91 98123-45678', text: 'x' });
  assert.equal(bodyOf(calls[0]!).to, '919812345678');
  await sendMessage({ to: '0049 151 12345678', text: 'x' });
  assert.equal(bodyOf(calls[1]!).to, '4915112345678');
});

test('falls back to WHATSAPP_DEFAULT_TO when no recipient given', async () => {
  process.env.WHATSAPP_DEFAULT_TO = '+919812345678';
  assert.equal(whatsappDefaultTo(), '+919812345678');
  stubFetch();
  await sendMessage({ text: 'default route' });
  assert.equal(bodyOf(calls[0]!).to, '919812345678');
});

test('throws a clear error when no recipient and no default', async () => {
  stubFetch();
  await assert.rejects(() => sendMessage({ text: 'nowhere' }), /no WhatsApp recipient/);
});

test('rejects an obviously invalid number before calling the API', async () => {
  stubFetch();
  await assert.rejects(() => sendMessage({ to: 'not-a-number', text: 'x' }), /not a valid phone number/);
  assert.equal(calls.length, 0);
});

test('surfaces the Graph API error message on a non-ok response', async () => {
  stubFetch(() => ({ ok: false, status: 400, body: { error: { message: 'Recipient phone number not in allowed list', code: 131030 } } }));
  await assert.rejects(() => sendMessage({ to: '+15551234567', text: 'x' }), /Recipient phone number not in allowed list/);
});

test('sendMessageToMany fans out to each recipient (normalized + deduped)', async () => {
  stubFetch();
  const r = await sendMessageToMany(['+15551234567', '+91 98123-45678', '15551234567'], 'hi all');
  // 3 inputs but #1 and #3 normalize to the same number → 2 unique sends
  assert.equal(r.sent.length, 2);
  assert.equal(r.failed.length, 0);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map((c) => bodyOf(c).to), ['15551234567', '919812345678']);
});

test('sendMessageToMany collects per-recipient failures without aborting the batch', async () => {
  // first recipient errors at the API, second succeeds, third is malformed.
  let i = 0;
  stubFetch(() => (i++ === 0 ? { ok: false, status: 400, body: { error: { message: 'not in allowed list' } } } : {}));
  const r = await sendMessageToMany(['+15550000001', '+15550000002', 'bogus'], 'hi');
  assert.equal(r.sent.length, 1);
  assert.equal(r.sent[0]!.to, '15550000002');
  assert.equal(r.failed.length, 2);
  assert.match(r.failed[0]!.error, /not in allowed list/);
  assert.match(r.failed.find((f) => f.to === 'bogus')!.error, /not a valid phone number/);
});

test('sendMessageToMany throws on an empty recipient list', async () => {
  stubFetch();
  await assert.rejects(() => sendMessageToMany([], 'x'), /no WhatsApp recipients/);
  assert.equal(calls.length, 0);
});

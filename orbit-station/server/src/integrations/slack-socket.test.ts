/**
 * SlackSocket event-classifier tests (node:test). No network — we test the pure
 * `classifyEvent` that the socket runs on each inbound Slack event. Proves human
 * messages/mentions/DMs are surfaced with the right kind, and the bot's own +
 * subtype/system events are dropped (so the dock never reacts to itself).
 *
 *   npm test --workspace server
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyEvent } from './slack-socket.js';

const BOT = 'UBOT';

test('a human channel message → kind=message', () => {
  const ev = classifyEvent(
    { type: 'message', user: 'UHUMAN', channel: 'C1', text: 'hi', ts: '1.1', channel_type: 'channel' }, BOT);
  assert.equal(ev?.kind, 'message');
  assert.equal(ev?.user, 'UHUMAN');
  assert.equal(ev?.channel, 'C1');
});

test('a DM → kind=dm; an app_mention → kind=mention', () => {
  const dm = classifyEvent(
    { type: 'message', user: 'UHUMAN', channel: 'D1', text: 'yo', ts: '2.1', channel_type: 'im' }, BOT);
  const mention = classifyEvent(
    { type: 'app_mention', user: 'UHUMAN', channel: 'C1', text: '<@UBOT> hey', ts: '3.1' }, BOT);
  assert.equal(dm?.kind, 'dm');
  assert.equal(mention?.kind, 'mention');
});

test("drops the bot's OWN messages (by user id and by bot_id)", () => {
  assert.equal(classifyEvent(
    { type: 'message', user: BOT, channel: 'C1', text: 'mine', ts: '4.1', channel_type: 'channel' }, BOT), null);
  assert.equal(classifyEvent(
    { type: 'message', user: 'UHUMAN', bot_id: 'BXYZ', channel: 'C1', text: 'a bot', ts: '4.2' }, BOT), null);
});

test('drops subtype/system + non-message events', () => {
  assert.equal(classifyEvent({ type: 'message', subtype: 'message_changed', channel: 'C1', ts: '5.1' }, BOT), null);
  assert.equal(classifyEvent({ type: 'message', subtype: 'channel_join', user: 'UHUMAN', channel: 'C1', ts: '5.2' }, BOT), null);
  assert.equal(classifyEvent({ type: 'reaction_added', user: 'UHUMAN', item: {} }, BOT), null);
});

test('keeps thread_ts when present (threaded reply)', () => {
  const ev = classifyEvent(
    { type: 'message', user: 'UHUMAN', channel: 'C1', text: 'in thread', ts: '6.2', thread_ts: '6.1', channel_type: 'channel' }, BOT);
  assert.equal(ev?.threadTs, '6.1');
});

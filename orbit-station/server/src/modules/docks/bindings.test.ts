/**
 * BindingStore — the station-owned deviceId→dock mapping that makes a device's
 * dock name survive app uninstall / firmware reflash
 * (docs/decision-traces/runtime-dock-binding.md). Seeded into an isolated
 * in-memory db, same pattern as the observability cost tests.
 *
 *   npm test --workspace server
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { BindingStore } from './bindings.js';

const fresh = () => new BindingStore(new Database(':memory:'));

test('lookup is undefined for an unbound device (unclaimed)', () => {
  const s = fresh();
  assert.equal(s.lookup('android-abc'), undefined);
});

test('bind then lookup round-trips', () => {
  const s = fresh();
  s.bind('android-abc', 'anne-bot');
  assert.equal(s.lookup('android-abc'), 'anne-bot');
});

test('bind is a rebind (rename) — last write wins', () => {
  const s = fresh();
  s.bind('android-abc', 'anne-bot');
  s.bind('android-abc', 'living-room');
  assert.equal(s.lookup('android-abc'), 'living-room');
});

test('unbind re-parks the device as unclaimed', () => {
  const s = fresh();
  s.bind('body-aabbccddeeff', 'anne-bot');
  assert.equal(s.unbind('body-aabbccddeeff'), true);
  assert.equal(s.lookup('body-aabbccddeeff'), undefined);
  assert.equal(s.unbind('body-aabbccddeeff'), false, 'second unbind is a no-op');
});

test('two devices bind to the same dock independently', () => {
  const s = fresh();
  s.bind('android-abc', 'anne-bot');     // phone slot
  s.bind('body-aabbccddeeff', 'anne-bot'); // body slot
  assert.equal(s.lookup('android-abc'), 'anne-bot');
  assert.equal(s.lookup('body-aabbccddeeff'), 'anne-bot');
  assert.equal(s.list().length, 2);
});

test('bindings survive a fresh store over the same db (uninstall/reflash analogue)', () => {
  const db = new Database(':memory:');
  new BindingStore(db).bind('android-abc', 'anne-bot');
  // a brand-new store re-hydrating from the same db file = the device dialing
  // back in after an uninstall/reflash: the binding is still there.
  assert.equal(new BindingStore(db).lookup('android-abc'), 'anne-bot');
});

/**
 * SessionStore lifecycle — the dock's ONE conversational session (open lazily,
 * close on idle/explicit end, reopen to continue). Background TASKS are NOT
 * sessions (they are separate processes the TaskSupervisor tracks), so the store
 * has no task-awareness — this covers only the conversation lifecycle.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionStore } from './store.js';

const DOCK = 'task-bot';
const freshStore = () => new SessionStore(mkdtempSync(join(tmpdir(), 'store-')));

test('openSession returns the one open session, or undefined', () => {
  const store = freshStore();
  assert.equal(store.openSession(DOCK), undefined);
  const conv = store.open(DOCK);
  assert.equal(store.openSession(DOCK)?.sessionId, conv.sessionId);
});

test('close marks the session closed (openSession then finds none)', () => {
  const store = freshStore();
  const conv = store.open(DOCK);
  store.close(DOCK, conv.sessionId, 'bye');
  assert.equal(store.openSession(DOCK), undefined);
});

test('close is idempotent on an already-closed session', () => {
  const store = freshStore();
  const conv = store.open(DOCK);
  store.close(DOCK, conv.sessionId, 'bye');
  store.close(DOCK, conv.sessionId, 'bye again');   // no throw, no resurrection
  assert.equal(store.openSession(DOCK), undefined);
});

test('reopen restores a closed session and resumes its transcript', () => {
  const store = freshStore();
  const conv = store.open(DOCK);
  store.close(DOCK, conv.sessionId, 'bye');
  assert.equal(store.reopen(DOCK, conv.sessionId), true);
  assert.equal(store.openSession(DOCK)?.sessionId, conv.sessionId);
});

test('reopen refuses while another session is open (one open per dock)', () => {
  const store = freshStore();
  const old = store.open(DOCK);
  store.close(DOCK, old.sessionId, 'bye');
  store.open(DOCK);                                   // a new one is now open
  assert.equal(store.reopen(DOCK, old.sessionId), false);
});

test('reopen returns false for an unknown session id', () => {
  const store = freshStore();
  assert.equal(store.reopen(DOCK, 'sess-nope'), false);
});

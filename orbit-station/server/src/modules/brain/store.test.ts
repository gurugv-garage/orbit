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
import { resumableOnPresence } from './session.js';
import { SESSION_IDLE_MIN } from './constants.js';

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

// ── PRESENCE session (§3.0): the phone connecting opens/resumes a session so
// self-initiated things (faceFollow) can attach without the user speaking. The
// resume-vs-fresh boundary is `resumableOnPresence` (pure); the whole-flow
// integration lives in ensurePresenceSession (drives these same store methods).

const IDLE_MS = SESSION_IDLE_MIN * 60_000;
const meta = (over = {}) => ({ sessionId: 's-x', openedAt: 0, lastTurnEndedAt: 0, turns: 0, ...over });

test('resumableOnPresence: undefined (no prior session) → open fresh, do not resume', () => {
  assert.equal(resumableOnPresence(undefined, 1_000_000), false);
});

test('resumableOnPresence: an OPEN session is never a resume target (caller keeps it)', () => {
  assert.equal(resumableOnPresence(meta({ closedAt: undefined }), 1_000), false);
});

test('resumableOnPresence: closed WITHIN the idle window → resume the same session', () => {
  const now = 5_000_000;
  assert.equal(resumableOnPresence(meta({ closedAt: now - 1, lastTurnEndedAt: now - IDLE_MS + 1 }), now), true);
});

test('resumableOnPresence: closed and PAST the idle window → open fresh, do not resume', () => {
  const now = 5_000_000;
  assert.equal(resumableOnPresence(meta({ closedAt: now - 1, lastTurnEndedAt: now - IDLE_MS - 1 }), now), false);
});

test('presence flow: no session yet → phone connect opens a fresh one (via store.open)', () => {
  const store = freshStore();
  assert.equal(store.openSession(DOCK), undefined);            // app open, no session = the bug
  const opened = store.open(DOCK);                             // ensurePresenceSession's else-branch
  assert.equal(store.openSession(DOCK)?.sessionId, opened.sessionId);
});

test('presence flow: a recent closed session is resumed, not duplicated', () => {
  const store = freshStore();
  const first = store.open(DOCK);
  store.close(DOCK, first.sessionId, 'app-gone');
  const recent = store.sessions(DOCK)[0]!;
  assert.ok(resumableOnPresence(recent, Date.now()));         // within window
  assert.equal(store.reopen(DOCK, recent.sessionId), true);
  assert.equal(store.openSession(DOCK)?.sessionId, first.sessionId);  // SAME session, context intact
  assert.equal(store.sessions(DOCK).length, 1);              // not fragmented into two
});

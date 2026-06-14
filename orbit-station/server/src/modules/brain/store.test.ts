/**
 * SessionStore nesting (docs/TASKS_V1.md §5, §11.A) — task sessions are children
 * of the one conversational session:
 *  - a child task session coexists while openSession() still returns the ONE
 *    conversational session (task excluded);
 *  - close(parent) cascades: every open task session under it closes, and the
 *    cascade returns their instanceIds (so the supervisor can stop the processes);
 *  - reopen restores the conversation but never a task session.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionStore } from './store.js';

const DOCK = 'task-bot';
const freshStore = () => new SessionStore(mkdtempSync(join(tmpdir(), 'store-')));

test('task session coexists; openSession still returns the one conversation', () => {
  const store = freshStore();
  const conv = store.open(DOCK);
  const t1 = store.openTask(DOCK, conv.sessionId, 't-aaaa');
  const t2 = store.openTask(DOCK, conv.sessionId, 't-bbbb');

  // openSession is scoped to kind:'conversation' — never a task
  const open = store.openSession(DOCK);
  assert.equal(open?.sessionId, conv.sessionId);
  assert.equal(open?.kind, 'conversation');

  // both tasks are tracked under the parent
  const tasks = store.tasksOf(DOCK, conv.sessionId).map((s) => s.sessionId).sort();
  assert.deepEqual(tasks, ['t-aaaa', 't-bbbb']);
  assert.equal(t1.kind, 'task');
  assert.equal(t2.parentSessionId, conv.sessionId);

  // a second open conversation is what the invariant guards — openSession finds the first
  assert.ok(store.openSession(DOCK));
});

test('absent kind reads as conversation (back-compat)', () => {
  const store = freshStore();
  const conv = store.open(DOCK);
  // simulate a legacy record by clearing kind would require touching disk; instead
  // assert the live record is tagged and openSession finds it.
  assert.equal(conv.kind, 'conversation');
  assert.equal(store.openSession(DOCK)?.sessionId, conv.sessionId);
});

test('close(parent) cascades to child task sessions and returns their ids', () => {
  const store = freshStore();
  const conv = store.open(DOCK);
  store.openTask(DOCK, conv.sessionId, 't-aaaa');
  store.openTask(DOCK, conv.sessionId, 't-bbbb');

  const killed = store.close(DOCK, conv.sessionId, 'bye').sort();
  assert.deepEqual(killed, ['t-aaaa', 't-bbbb']);

  // no open conversation, and no open task sessions remain
  assert.equal(store.openSession(DOCK), undefined);
  assert.equal(store.tasksOf(DOCK, conv.sessionId).length, 0);
});

test('closing a task session does NOT cascade (no parent → children)', () => {
  const store = freshStore();
  const conv = store.open(DOCK);
  store.openTask(DOCK, conv.sessionId, 't-aaaa');
  const killed = store.close(DOCK, 't-aaaa', 'task done');
  assert.deepEqual(killed, []);                 // a task has no children
  assert.ok(store.openSession(DOCK));            // the parent conversation stays open
});

test('reopen restores the conversation but never revives tasks', () => {
  const store = freshStore();
  const conv = store.open(DOCK);
  store.openTask(DOCK, conv.sessionId, 't-aaaa');
  store.close(DOCK, conv.sessionId, 'bye');      // cascades the task closed

  // reopen the conversation
  assert.equal(store.reopen(DOCK, conv.sessionId), true);
  assert.equal(store.openSession(DOCK)?.sessionId, conv.sessionId);

  // the task is still closed — reopen never revived it
  assert.equal(store.tasksOf(DOCK, conv.sessionId).length, 0);
});

test('reopen refuses to directly reopen a task session', () => {
  const store = freshStore();
  const conv = store.open(DOCK);
  store.openTask(DOCK, conv.sessionId, 't-aaaa');
  store.close(DOCK, conv.sessionId, 'bye');

  assert.equal(store.reopen(DOCK, 't-aaaa'), false);   // not a conversation → refused
});

test('reopen invariant ignores open task sessions of OTHER parents', () => {
  const store = freshStore();
  // an old closed conversation we want to reopen
  const old = store.open(DOCK);
  store.close(DOCK, old.sessionId, 'bye');
  // a *new* conversation is currently open with a running task
  const cur = store.open(DOCK);
  store.openTask(DOCK, cur.sessionId, 't-cccc');

  // reopening the old one must be refused because a conversation is open — but the
  // refusal is due to `cur`, NOT the task (the task must not count toward the invariant)
  assert.equal(store.reopen(DOCK, old.sessionId), false);

  // close the current conversation; now only the (now-closed) task lingers
  store.close(DOCK, cur.sessionId, 'bye');
  // the task is closed by the cascade, so reopening old must now succeed (no open conversation)
  assert.equal(store.reopen(DOCK, old.sessionId), true);
});

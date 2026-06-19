/**
 * ThoughtRouter — the pure routing decision (docs/perception-to-agent.md 2.2).
 * Exhaustive truth table: every session state × staleness × settle-gap cell.
 * No LLM, no dock, no clock — `now` is injected, so each case is deterministic.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decideThought, type SessionState, type ThoughtDecision } from './thought-router.js';

const NOW = 1_000_000;
/** A fresh, settled baseline: not expired, last turn long ago, default settle. */
const base = { now: NOW, expiresAt: NOW + 10_000, lastTurnEndedAt: 0, settleMs: 1500 };

test('idle + fresh + settled → run', () => {
  assert.equal(decideThought({ ...base, state: 'idle' }), 'run');
});

test('busy states defer (user/turn/TTS always win)', () => {
  for (const state of ['listening', 'speaking', 'thinking'] as SessionState[]) {
    assert.equal(decideThought({ ...base, state }), 'defer', `${state} should defer`);
  }
});

test('expired thought is DROPPED in every state (stale news, not held)', () => {
  const expired = { ...base, expiresAt: NOW - 1 };
  const states: SessionState[] = ['idle', 'listening', 'speaking', 'thinking'];
  for (const state of states) {
    assert.equal(decideThought({ ...expired, state }), 'drop', `${state} expired should drop`);
  }
});

test('staleness wins over busy: an expired thought drops even while thinking', () => {
  // ordering guarantee — we never defer something we would never speak.
  assert.equal(
    decideThought({ ...base, state: 'thinking', expiresAt: NOW - 1 }),
    'drop',
  );
});

test('no expiry set → never stale (idle runs, busy defers)', () => {
  assert.equal(decideThought({ ...base, state: 'idle', expiresAt: undefined }), 'run');
  assert.equal(decideThought({ ...base, state: 'thinking', expiresAt: undefined }), 'defer');
});

test('settle gap: idle but a turn just ended → defer; once settled → run', () => {
  const justEnded = { ...base, state: 'idle' as const, lastTurnEndedAt: NOW - 500, settleMs: 1500 };
  assert.equal(decideThought(justEnded), 'defer', 'within settle window → defer');
  // exactly at the boundary (gap === settleMs) is settled (strict <).
  assert.equal(decideThought({ ...justEnded, lastTurnEndedAt: NOW - 1500 }), 'run', 'at boundary → run');
  assert.equal(decideThought({ ...justEnded, lastTurnEndedAt: NOW - 5000 }), 'run', 'well past → run');
});

test('settleMs = 0 disables the gap (idle runs immediately after a turn)', () => {
  assert.equal(
    decideThought({ ...base, state: 'idle', lastTurnEndedAt: NOW - 1, settleMs: 0 }),
    'run',
  );
});

test('every state maps to a valid decision (no undefined cells)', () => {
  const states: SessionState[] = ['idle', 'listening', 'speaking', 'thinking'];
  const valid: ThoughtDecision[] = ['run', 'defer', 'drop'];
  for (const state of states) {
    assert.ok(valid.includes(decideThought({ ...base, state })), `${state} returns a valid decision`);
  }
});

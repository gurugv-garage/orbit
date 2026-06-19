/**
 * The proactive attention gate (docs/perception-to-agent.md Decision 1) — the pure
 * cheap-rules judge. Every cell: disabled, cooldown, dedup, priority order
 * (relevance > arrival > emotion), the ego-motion guard, and the relevance stub.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateGate, type GateSignals, type GateConfig } from './gate.js';

const NOW = 1_000_000;
const ON: GateConfig = { cooldownMs: 90_000, enabled: true };

function sig(over: Partial<GateSignals> = {}): GateSignals {
  return {
    now: NOW, presentNames: [], arrivedNames: [], departedNames: [],
    cameraMoving: false, msSinceLastSnapshot: 0, lastRaisedAt: 0, ...over,
  };
}

test('disabled gate never raises', () => {
  const r = evaluateGate(sig({ arrivedNames: ['guru'] }), { ...ON, enabled: false });
  assert.equal(r.raise, false);
});

test('arrival of a known person raises a presence thought', () => {
  const r = evaluateGate(sig({ arrivedNames: ['guru'] }), ON);
  assert.equal(r.raise, true);
  if (r.raise) {
    assert.equal(r.kind, 'self:presence');
    assert.match(r.text, /guru just came into view/);
    assert.equal(r.key, 'arrival:guru');
  }
});

test('arrival of an unknown person raises a generic hello', () => {
  const r = evaluateGate(sig({ arrivedNames: ['someone'] }), ON);
  assert.equal(r.raise, true);
  if (r.raise) assert.match(r.text, /someone you don't recognize/);
});

test('EGO-MOTION guard: arrival while the camera moves does NOT raise', () => {
  // the robot panned and a face entered frame — that's the robot looking around,
  // not someone arriving (Decision 5b). Must stay quiet.
  const r = evaluateGate(sig({ arrivedNames: ['guru'], cameraMoving: true }), ON);
  assert.equal(r.raise, false);
});

test('cooldown: no raise within the window of the last raise', () => {
  const r = evaluateGate(sig({ arrivedNames: ['guru'], lastRaisedAt: NOW - 10_000 }), ON);
  assert.equal(r.raise, false);
  if (!r.raise) assert.equal(r.reason, 'cooldown');
  // past the window → raises
  const r2 = evaluateGate(sig({ arrivedNames: ['guru'], lastRaisedAt: NOW - 100_000 }), ON);
  assert.equal(r2.raise, true);
});

test('dedup: the same arrival key does not raise twice in a row', () => {
  const r = evaluateGate(sig({ arrivedNames: ['guru'], lastRaisedKey: 'arrival:guru' }), ON);
  assert.equal(r.raise, false);
  if (!r.raise) assert.equal(r.reason, 'duplicate of last raise');
  // a DIFFERENT arrival raises
  const r2 = evaluateGate(sig({ arrivedNames: ['alice'], lastRaisedKey: 'arrival:guru' }), ON);
  assert.equal(r2.raise, true);
});

test('strong emotion raises a check-in (lower priority than arrival)', () => {
  const r = evaluateGate(sig({ strongEmotion: { name: 'guru', text: 'guru looked frustrated' } }), ON);
  assert.equal(r.raise, true);
  if (r.raise) { assert.equal(r.kind, 'self:emotion'); assert.match(r.text, /frustrated/); }
});

test('priority: arrival outranks a co-occurring emotion read', () => {
  const r = evaluateGate(sig({
    arrivedNames: ['guru'], strongEmotion: { name: 'guru', text: 'guru looked happy' },
  }), ON);
  assert.equal(r.raise, true);
  if (r.raise) assert.equal(r.kind, 'self:presence'); // arrival wins
});

test('relevance stub outranks everything when present (the A1 future path)', () => {
  const r = evaluateGate(sig({
    arrivedNames: ['guru'],
    relevance: { reason: 'named', text: 'they asked if orbit could remind them' },
  }), ON);
  assert.equal(r.raise, true);
  if (r.raise) { assert.equal(r.kind, 'self:relevance'); assert.equal(r.confidence, 0.9); }
});

test('nothing notable → quiet', () => {
  const r = evaluateGate(sig({ presentNames: ['guru'] }), ON); // present, but nothing changed
  assert.equal(r.raise, false);
  if (!r.raise) assert.equal(r.reason, 'nothing worth raising');
});

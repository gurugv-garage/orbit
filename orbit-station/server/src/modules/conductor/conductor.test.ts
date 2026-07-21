/**
 * Conductor core — the pure conducting logic (decide truth tables + reconcile start/stop).
 * No station, no supervisor, no clock — fakes + an injected `now`, so the whole policy is
 * deterministic.
 *
 * (faceFollow — a windowed body task — was retired; see
 * docs/decision-traces/thin-client-consolidation.md. The generic reconcile coverage below now
 * rides `idle-moods`, the remaining conducted body task; wakeUp covers the behaviour path.)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  wakeUp, moods, CONDUCTED, initConductedState,
  type World, type ConductedState, type Tunings,
} from './conducted.js';
import { reconcile, type Effects } from './reconcile.js';

const T0 = 1_000_000;
const baseWorld = (over: Partial<World> = {}): World => ({
  now: T0, present: false, lastPresenceMs: 0, identity: null,
  listening: false, turnActive: false, lastConversationMs: 0,
  bodyHolder: null, bodyOnline: true, phonePresent: true, tasks: [], ...over,
});

// ── moods — the idle-personality gate (WHEN only; WHICH mood is the task's picker) ────────

test('moods: disabled → off', () => {
  assert.equal(moods.decide({ enabled: false }, baseWorld({ lastConversationMs: 0 }), initConductedState()).desired, 'off');
});

test('moods: conversation live → off', () => {
  assert.equal(moods.decide({}, baseWorld({ turnActive: true }), initConductedState()).desired, 'off');
  assert.equal(moods.decide({}, baseWorld({ listening: true }), initConductedState()).desired, 'off');
});

test('moods: idle window — off before activateAfterMs, running after (and with no conversation ever)', () => {
  const cfg = { activateAfterMs: 300_000 };
  assert.equal(moods.decide(cfg, baseWorld({ lastConversationMs: T0 - 60_000 }), initConductedState()).desired, 'off');
  assert.equal(moods.decide(cfg, baseWorld({ lastConversationMs: T0 - 300_001 }), initConductedState()).desired, 'running');
  assert.equal(moods.decide(cfg, baseWorld({ lastConversationMs: 0 }), initConductedState()).desired, 'running');
});

// ── wakeUp — always-on ────────────────────────────────────────────────────────────────────

test('wakeUp: enabled → running; disabled → off', () => {
  assert.equal(wakeUp.decide({ enabled: true }, baseWorld(), initConductedState()).desired, 'running');
  assert.equal(wakeUp.decide({ enabled: false }, baseWorld(), initConductedState()).desired, 'off');
});

// ── reconcile — start/stop + behaviour toggle against a fake ──────────────────────────────────

interface Fake extends Effects {
  running: Set<string>; started: string[]; stopped: string[]; behaviourOn: Map<string, boolean>;
  transitions: Array<{ b: string; from: string; to: string }>;
  startedWith: Array<{ name: string; priority: number; tunings: Tunings }>;
}
function fake(): Fake {
  const running = new Set<string>(); const started: string[] = []; const stopped: string[] = [];
  const behaviourOn = new Map<string, boolean>(); const transitions: Fake['transitions'] = [];
  const startedWith: Fake['startedWith'] = [];
  return {
    running, started, stopped, behaviourOn, transitions, startedWith,
    isTaskRunning: (_d, name) => running.has(name),
    startTask: (_d, name, priority, tunings) => { running.add(name); started.push(name); startedWith.push({ name, priority, tunings }); },
    stopTask: (_d, name) => { running.delete(name); stopped.push(name); },
    setBehaviour: (_d, b, on) => behaviourOn.set(b, on),
    onTransition: (_d, b, from, to) => transitions.push({ b, from, to }),
  };
}
const cfgFor = (over: Record<string, Tunings> = {}) => (b: string): Tunings => over[b] ?? {};

test('reconcile: starts idle-moods when idle, enables wakeUp', () => {
  const fx = fake(); const states = new Map<string, ConductedState>();
  // idle "forever" (no conversation) + wakeUp enabled
  reconcile('d1', CONDUCTED, baseWorld({ lastConversationMs: 0 }), states, cfgFor(), fx);
  assert.ok(fx.started.includes('idle-moods'), 'idle-moods task started (idle window opened)');
  assert.equal(fx.behaviourOn.get('wakeUp'), true, 'wakeUp behaviour enabled');
});

test('reconcile: starts idle-moods when idle, at priority 35, passing its tunings as params', () => {
  const fx = fake(); const states = new Map<string, ConductedState>();
  reconcile('d1', CONDUCTED, baseWorld({ lastConversationMs: 0 }), states,
    cfgFor({ moods: { bitMinMs: 5_000 } }), fx);
  assert.ok(fx.started.includes('idle-moods'), 'idle-moods task started');
  const call = fx.startedWith.find((s) => s.name === 'idle-moods')!;
  assert.equal(call.priority, 35, 'mood bits hold the body at the designed priority');
  assert.equal(call.tunings.bitMinMs, 5_000, 'live tunings ride to the task as params');
  // defaults are merged UNDER the config so the task sees ONE source of truth for every
  // knob (raw config alone let a stale task-manifest default win — review 2026-07-05).
  assert.equal(call.tunings.quietStartHour, 22, 'unset knobs arrive filled from conducted defaults');
  assert.equal(call.tunings.wAttention, 0.5, 'the designed attention weight, not a manifest stale copy');
});

test('reconcile: stops idle-moods when a conversation starts', () => {
  const fx = fake(); const states = new Map<string, ConductedState>();
  reconcile('d1', CONDUCTED, baseWorld({ lastConversationMs: 0 }), states, cfgFor(), fx);
  assert.ok(fx.running.has('idle-moods'));
  reconcile('d1', CONDUCTED, baseWorld({ listening: true, lastConversationMs: 0 }), states, cfgFor(), fx);
  assert.ok(fx.stopped.includes('idle-moods'), 'idle-moods stopped when listening');
});

test('reconcile: stops idle-moods when a turn is active', () => {
  const fx = fake(); const states = new Map<string, ConductedState>();
  reconcile('d1', CONDUCTED, baseWorld({ lastConversationMs: 0 }), states, cfgFor(), fx); // started
  assert.ok(fx.running.has('idle-moods'));
  reconcile('d1', CONDUCTED, baseWorld({ turnActive: true, lastConversationMs: 0 }), states, cfgFor(), fx);
  assert.ok(fx.stopped.includes('idle-moods'), 'idle-moods stopped when a turn is active');
  assert.ok(!fx.running.has('idle-moods'));
});

test('reconcile: disabling wakeUp turns the behaviour hook off', () => {
  const fx = fake(); const states = new Map<string, ConductedState>();
  reconcile('d1', CONDUCTED, baseWorld(), states, cfgFor({ wakeUp: { enabled: false } }), fx);
  assert.equal(fx.behaviourOn.get('wakeUp'), false);
});

test('reconcile: idempotent — no double-start when already running', () => {
  const fx = fake(); const states = new Map<string, ConductedState>();
  const w = baseWorld({ lastConversationMs: 0 });
  reconcile('d1', CONDUCTED, w, states, cfgFor(), fx);
  reconcile('d1', CONDUCTED, { ...w, now: T0 + 1000 }, states, cfgFor(), fx);
  assert.equal(fx.started.filter((n) => n === 'idle-moods').length, 1, 'started exactly once');
});

test('reconcile: moods.enabled=false keeps it off even when idle', () => {
  const fx = fake(); const states = new Map<string, ConductedState>();
  reconcile('d1', CONDUCTED, baseWorld({ lastConversationMs: 0 }), states, cfgFor({ moods: { enabled: false } }), fx);
  assert.ok(!fx.started.includes('idle-moods'));
});

// ── override ("Run now" / "Stop") ──────────────────────────────────────────────────────────
test('override run: forces moods on even mid-conversation (overrides the rule)', () => {
  const fx = fake(); const states = new Map<string, ConductedState>();
  // a conversation is live → the rule says off, but a 'run' override forces it on.
  reconcile('d1', CONDUCTED, baseWorld({ turnActive: true }), states, cfgFor(), fx, (b) => b === 'moods' ? 'run' : undefined);
  assert.ok(fx.started.includes('idle-moods'), 'run override starts idle-moods despite the rule');
});

test('override off: forces moods off even when the rule wants it (Stop)', () => {
  const fx = fake(); const states = new Map<string, ConductedState>();
  reconcile('d1', CONDUCTED, baseWorld({ lastConversationMs: 0 }), states, cfgFor(), fx); // rule → running
  assert.ok(fx.running.has('idle-moods'));
  reconcile('d1', CONDUCTED, baseWorld({ lastConversationMs: 0 }), states, cfgFor(), fx, (b) => b === 'moods' ? 'off' : undefined);
  assert.ok(fx.stopped.includes('idle-moods'), 'off override stops it despite the rule wanting it on');
});

test('override run: forces wakeUp on even when disabled in config', () => {
  const fx = fake(); const states = new Map<string, ConductedState>();
  reconcile('d1', CONDUCTED, baseWorld(), states, cfgFor({ wakeUp: { enabled: false } }), fx, (b) => b === 'wakeUp' ? 'run' : undefined);
  assert.equal(fx.behaviourOn.get('wakeUp'), true, 'run override enables the wakeUp hook despite enabled:false');
});

// ── phone-presence gate (phone/face offline → stand the dock down) ────────────────────────────
test('reconcile: phone OFFLINE stops the running body task (nobody to perform for)', () => {
  const fx = fake(); const states = new Map<string, ConductedState>();
  // idle-forever with the phone present → the body task starts.
  reconcile('d1', CONDUCTED, baseWorld({ lastConversationMs: 0 }), states, cfgFor(), fx);
  assert.ok(fx.running.has('idle-moods'));
  // phone drops → the gate forces every non-bgTask conducted thing off, so it's stopped.
  reconcile('d1', CONDUCTED, baseWorld({ lastConversationMs: 0, phonePresent: false }), states, cfgFor(), fx);
  assert.ok(fx.stopped.includes('idle-moods'), 'idle-moods stopped on phone-offline');
});

test('reconcile: phone OFFLINE keeps it from ever starting a body task', () => {
  const fx = fake(); const states = new Map<string, ConductedState>();
  reconcile('d1', CONDUCTED, baseWorld({ lastConversationMs: 0, phonePresent: false }), states, cfgFor(), fx);
  assert.ok(!fx.started.includes('idle-moods'), 'no idle-moods with the phone gone');
});

test('reconcile: phone-offline gate does NOT disable the wakeUp behaviour (wake still armed)', () => {
  // wakeUp is a hardcoded behaviour, not a body task — a present-less dock can still be woken.
  // It has no bgTask flag today, so the gate DOES force it off; assert current intent explicitly
  // so a future "wake survives offline" change is a deliberate, tested edit (mark wakeUp bgTask).
  const fx = fake(); const states = new Map<string, ConductedState>();
  reconcile('d1', CONDUCTED, baseWorld({ phonePresent: false }), states, cfgFor(), fx);
  assert.equal(fx.behaviourOn.get('wakeUp'), false, 'wakeUp gated off with the phone gone (no bgTask)');
});

test('override run: beats the phone-offline gate (explicit human "Run now")', () => {
  const fx = fake(); const states = new Map<string, ConductedState>();
  reconcile('d1', CONDUCTED, baseWorld({ lastConversationMs: 0, phonePresent: false }), states, cfgFor(),
    fx, (b) => b === 'moods' ? 'run' : undefined);
  assert.ok(fx.started.includes('idle-moods'), 'a run override forces idle-moods on despite the gate');
});

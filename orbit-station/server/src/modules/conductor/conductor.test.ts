/**
 * Conductor core — the pure conducting logic (decide truth tables + reconcile start/stop).
 * No station, no supervisor, no clock — fakes + an injected `now`, so the whole policy is
 * deterministic.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  faceFollow, wakeUp, moods, CONDUCTED, initConductedState,
  type World, type ConductedState, type Tunings,
} from './conducted.js';
import { reconcile, type Effects } from './reconcile.js';

const T0 = 1_000_000;
const baseWorld = (over: Partial<World> = {}): World => ({
  now: T0, present: false, lastPresenceMs: 0, identity: null,
  listening: false, turnActive: false, lastConversationMs: 0,
  bodyHolder: null, bodyOnline: true, phonePresent: true, tasks: [], ...over,
});

// ── faceFollow — the idle-window state machine ────────────────────────────────────────────

test('faceFollow: disabled → off', () => {
  const r = faceFollow.decide({ enabled: false }, baseWorld(), initConductedState());
  assert.equal(r.desired, 'off');
});

test('faceFollow: conversation live → off (and closes any window)', () => {
  const active = { desired: 'running' as const, windowOpenedAt: T0 };
  assert.equal(faceFollow.decide({}, baseWorld({ turnActive: true }), active).desired, 'off');
  assert.equal(faceFollow.decide({}, baseWorld({ listening: true }), active).self.windowOpenedAt, 0);
});

test('faceFollow: body OFFLINE → off (no crash-respawn churn on an unplugged servo)', () => {
  const r = faceFollow.decide({}, baseWorld({ lastConversationMs: 0, bodyOnline: false }), initConductedState());
  assert.equal(r.desired, 'off');
});

test('faceFollow: NOT idle long enough → off', () => {
  // last conversation 1 min ago, activateAfterMs 5 min → still off.
  const w = baseWorld({ now: T0, lastConversationMs: T0 - 60_000 });
  const r = faceFollow.decide({ activateAfterMs: 300_000 }, w, initConductedState());
  assert.equal(r.desired, 'off');
});

test('faceFollow: idle ≥ activateAfterMs → OPENS a window (cold start scans)', () => {
  const w = baseWorld({ now: T0, lastConversationMs: T0 - 300_001 });
  const r = faceFollow.decide({ activateAfterMs: 300_000 }, w, initConductedState());
  assert.equal(r.desired, 'running');
  assert.equal(r.self.windowOpenedAt, T0, 'records when the window opened');
});

test('faceFollow: never any conversation → idle is infinite → opens', () => {
  const r = faceFollow.decide({ activateAfterMs: 300_000 }, baseWorld({ lastConversationMs: 0 }), initConductedState());
  assert.equal(r.desired, 'running');
});

// ── the attention-director v1 machine: presence keeps it, absence stills it ──────────────

test('faceFollow: someone VISIBLE keeps the window running to runForMs, then it rests', () => {
  const cfg = { activateAfterMs: 300_000, runForMs: 900_000, idleNoFaceMs: 180_000 };
  let st = faceFollow.decide(cfg, baseWorld({ lastConversationMs: 0, present: true, lastPresenceMs: T0 }), initConductedState()).self;
  // 10 min in, person still visible → still tracking
  let r = faceFollow.decide(cfg, baseWorld({ now: T0 + 600_000, lastConversationMs: 0, present: true, lastPresenceMs: T0 + 600_000 }), st);
  assert.equal(r.desired, 'running'); st = r.self;
  // 15 min + 1 → window elapsed → rest (cooldown armed)
  r = faceFollow.decide(cfg, baseWorld({ now: T0 + 900_001, lastConversationMs: 0, present: true, lastPresenceMs: T0 + 900_001 }), st);
  assert.equal(r.desired, 'off');
  assert.equal(r.self.windowOpenedAt, 0, 'window closed');
  // …but with someone STILL visible, it reopens immediately (presence bypasses cooldown).
  r = faceFollow.decide(cfg, baseWorld({ now: T0 + 900_002, lastConversationMs: 0, present: true, lastPresenceMs: T0 + 900_002 }), r.self);
  assert.equal(r.desired, 'running', 'presence reopens instantly after a window rest');
});

test('faceFollow: NOBODY seen for idleNoFaceMs → closes early and goes STILL (no empty-room sweep)', () => {
  const cfg = { activateAfterMs: 300_000, runForMs: 900_000, idleNoFaceMs: 180_000, rescanCooldownMs: 900_000 };
  let st = faceFollow.decide(cfg, baseWorld({ lastConversationMs: 0 }), initConductedState()).self; // opens at T0, nobody ever seen
  // 2 min in, still nobody → still searching (inside the grace)
  let r = faceFollow.decide(cfg, baseWorld({ now: T0 + 120_000, lastConversationMs: 0 }), st);
  assert.equal(r.desired, 'running'); st = r.self;
  // 3 min + 1 with nobody EVER seen → early close + cooldown
  r = faceFollow.decide(cfg, baseWorld({ now: T0 + 180_001, lastConversationMs: 0 }), st);
  assert.equal(r.desired, 'off', 'empty room → still');
  assert.equal(r.self.cooldownUntil, T0 + 180_001 + 900_000, 're-scan cooldown armed');
  // does NOT reopen while the cooldown runs and the room stays empty…
  const again = faceFollow.decide(cfg, baseWorld({ now: T0 + 300_000, lastConversationMs: 0 }), r.self);
  assert.equal(again.desired, 'off', 'no forever-sweep');
  // …but a FACE reopens it immediately, cooldown or not…
  const seen = faceFollow.decide(cfg, baseWorld({ now: T0 + 300_001, lastConversationMs: 0, present: true, lastPresenceMs: T0 + 300_001 }), r.self);
  assert.equal(seen.desired, 'running', 'presence bypasses the cooldown');
  // …and after the cooldown elapses the periodic brief re-scan happens even when empty.
  const rescan = faceFollow.decide(cfg, baseWorld({ now: T0 + 180_001 + 900_001, lastConversationMs: 0 }), r.self);
  assert.equal(rescan.desired, 'running', 'periodic re-scan after cooldown');
});

test('faceFollow: a recent sighting extends the search grace (measured from lastPresenceMs)', () => {
  const cfg = { activateAfterMs: 300_000, runForMs: 900_000, idleNoFaceMs: 180_000 };
  // window opened at T0; person was seen at T0+240_000 then left.
  const st: ConductedState = { desired: 'running', windowOpenedAt: T0 };
  const r = faceFollow.decide(cfg, baseWorld({ now: T0 + 300_000, lastConversationMs: 0, lastPresenceMs: T0 + 240_000 }), st);
  assert.equal(r.desired, 'running', 'only 1 min since the last sighting — keep looking');
  const r2 = faceFollow.decide(cfg, baseWorld({ now: T0 + 240_000 + 180_001, lastConversationMs: 0, lastPresenceMs: T0 + 240_000 }), st);
  assert.equal(r2.desired, 'off', '3 min after the last sighting → rest');
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

test('reconcile: starts faceFollow when idle, enables wakeUp', () => {
  const fx = fake(); const states = new Map<string, ConductedState>();
  // idle "forever" (no conversation) + wakeUp enabled
  reconcile('d1', CONDUCTED, baseWorld({ lastConversationMs: 0 }), states, cfgFor(), fx);
  assert.ok(fx.started.includes('face-follow'), 'faceFollow task started (idle window opened)');
  assert.equal(fx.behaviourOn.get('wakeUp'), true, 'wakeUp behaviour enabled');
});

test('reconcile: starts idle-moods when idle, at priority 35, passing its tunings as params', () => {
  const fx = fake(); const states = new Map<string, ConductedState>();
  reconcile('d1', CONDUCTED, baseWorld({ lastConversationMs: 0 }), states,
    cfgFor({ moods: { bitMinMs: 5_000 } }), fx);
  assert.ok(fx.started.includes('idle-moods'), 'idle-moods task started');
  const call = fx.startedWith.find((s) => s.name === 'idle-moods')!;
  assert.equal(call.priority, 35, 'mood bits outrank the follow reflex');
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

test('reconcile: stops faceFollow when a conversation starts', () => {
  const fx = fake(); const states = new Map<string, ConductedState>();
  reconcile('d1', CONDUCTED, baseWorld({ lastConversationMs: 0 }), states, cfgFor(), fx); // started
  assert.ok(fx.running.has('face-follow'));
  reconcile('d1', CONDUCTED, baseWorld({ turnActive: true, lastConversationMs: 0 }), states, cfgFor(), fx);
  assert.ok(fx.stopped.includes('face-follow'), 'faceFollow stopped when a turn is active');
  assert.ok(!fx.running.has('face-follow'));
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
  assert.equal(fx.started.filter((n) => n === 'face-follow').length, 1, 'started exactly once');
});

test('reconcile: faceFollow.enabled=false keeps it off even when idle', () => {
  const fx = fake(); const states = new Map<string, ConductedState>();
  reconcile('d1', CONDUCTED, baseWorld({ lastConversationMs: 0 }), states, cfgFor({ faceFollow: { enabled: false } }), fx);
  assert.ok(!fx.started.includes('face-follow'));
});

// ── override ("Run now" / "Stop") ──────────────────────────────────────────────────────────
test('override run: forces faceFollow on even mid-conversation (overrides the rule)', () => {
  const fx = fake(); const states = new Map<string, ConductedState>();
  // a conversation is live → the rule says off, but a 'run' override forces it on.
  reconcile('d1', CONDUCTED, baseWorld({ turnActive: true }), states, cfgFor(), fx, (b) => b === 'faceFollow' ? 'run' : undefined);
  assert.ok(fx.started.includes('face-follow'), 'run override starts faceFollow despite the rule');
});

test('override off: forces faceFollow off even when the rule wants it (Stop)', () => {
  const fx = fake(); const states = new Map<string, ConductedState>();
  reconcile('d1', CONDUCTED, baseWorld({ lastConversationMs: 0 }), states, cfgFor(), fx); // rule → running
  assert.ok(fx.running.has('face-follow'));
  reconcile('d1', CONDUCTED, baseWorld({ lastConversationMs: 0 }), states, cfgFor(), fx, (b) => b === 'faceFollow' ? 'off' : undefined);
  assert.ok(fx.stopped.includes('face-follow'), 'off override stops it despite the rule wanting it on');
});

test('override run: forces wakeUp on even when disabled in config', () => {
  const fx = fake(); const states = new Map<string, ConductedState>();
  reconcile('d1', CONDUCTED, baseWorld(), states, cfgFor({ wakeUp: { enabled: false } }), fx, (b) => b === 'wakeUp' ? 'run' : undefined);
  assert.equal(fx.behaviourOn.get('wakeUp'), true, 'run override enables the wakeUp hook despite enabled:false');
});

// ── phone-presence gate (phone/face offline → stand the dock down) ────────────────────────────
test('reconcile: phone OFFLINE stops the running body tasks (nobody to perform for)', () => {
  const fx = fake(); const states = new Map<string, ConductedState>();
  // idle-forever with the phone present → both body tasks start.
  reconcile('d1', CONDUCTED, baseWorld({ lastConversationMs: 0 }), states, cfgFor(), fx);
  assert.ok(fx.running.has('face-follow') && fx.running.has('idle-moods'));
  // phone drops → the gate forces every non-bgTask conducted thing off, so both are stopped.
  reconcile('d1', CONDUCTED, baseWorld({ lastConversationMs: 0, phonePresent: false }), states, cfgFor(), fx);
  assert.ok(fx.stopped.includes('face-follow'), 'faceFollow stopped on phone-offline');
  assert.ok(fx.stopped.includes('idle-moods'), 'idle-moods stopped on phone-offline');
});

test('reconcile: phone OFFLINE keeps it from ever starting a body task', () => {
  const fx = fake(); const states = new Map<string, ConductedState>();
  reconcile('d1', CONDUCTED, baseWorld({ lastConversationMs: 0, phonePresent: false }), states, cfgFor(), fx);
  assert.ok(!fx.started.includes('face-follow'), 'no faceFollow with the phone gone');
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
    fx, (b) => b === 'faceFollow' ? 'run' : undefined);
  assert.ok(fx.started.includes('face-follow'), 'a run override forces faceFollow on despite the gate');
});

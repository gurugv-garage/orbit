import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Bus, type BusMessage } from '../../core/bus.js';
import type { RosterEntry } from '../../core/hub.js';
import { Directory } from '../docks/directory.js';
import { MotionExecutor } from './motion.js';

const DOCK = 'test-bot';

function bodyPeer(): RosterEntry {
  return {
    role: 'device', id: 'esp32-1', dock: DOCK, component: 'body',
    kind: 'dock-body-fw', caps: ['servo'],
    lastSeen: Date.now(), connectedAt: Date.now(), topics: ['bodylink'],
  };
}

function setup(roster: RosterEntry[] = [bodyPeer()]) {
  const bus = new Bus();
  const directory = new Directory(() => roster, join(tmpdir(), `dir-${Math.random()}.json`));
  const motion = new MotionExecutor(bus, directory);
  const sent: BusMessage[] = [];
  bus.on('bodylink', (m) => { if (m.kind === 'command') sent.push(m); });
  return { motion, sent };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('runSteps: clamps, converts °→µs, sends directed set_target per step', async () => {
  const { motion, sent } = setup();
  const status = motion.runSteps(DOCK, [
    { part: 'neck', degrees: -90, duration_ms: 10 },          // clamps to -60° = 833µs
    { parts: [{ part: 'neck', degrees: 0 }, { part: 'foot', degrees: 90 }], duration_ms: 10 },
  ]);
  assert.match(status, /moving/);
  await sleep(60);
  assert.equal(sent.length, 2);
  assert.deepEqual(sent[0]!.toAddr, { dock: DOCK, component: 'body' });
  const p1 = (sent[0]!.payload as { parts: Record<string, { pulse_width_us: number }> }).parts;
  assert.equal(p1.neck!.pulse_width_us, 833); // 1500 + (-60/90)*1000, trunc
  const p2 = (sent[1]!.payload as { parts: Record<string, { pulse_width_us: number }> }).parts;
  assert.equal(p2.neck!.pulse_width_us, 1500);
  assert.equal(p2.foot!.pulse_width_us, 2500);
  motion.shutdown();
});

test('runSteps throws offline / on bad input (the model narrates)', () => {
  const { motion } = setup([]);
  assert.throws(() => motion.runSteps(DOCK, [{ part: 'neck', degrees: 0 }]), /offline/);
  const online = setup();
  assert.throws(() => online.motion.runSteps(DOCK, []), /at least one step/);
  assert.throws(() => online.motion.runSteps(DOCK, [{ part: 'tail', degrees: 0 }]), /unknown part/);
  assert.throws(() => online.motion.runSteps(DOCK, [{}]), /needs joints/);
  online.motion.shutdown();
  motion.shutdown();
});

test('stop() cancels a running sequence; new sequence supersedes the old', async () => {
  const { motion, sent } = setup();
  motion.runSteps(DOCK, [
    { part: 'neck', degrees: 10, duration_ms: 20 },
    { part: 'neck', degrees: 20, duration_ms: 20 },
    { part: 'neck', degrees: 30, duration_ms: 20 },
  ]);
  await sleep(25); // step 1 sent, step 2 maybe
  motion.stop(DOCK);
  const atStop = sent.length;
  await sleep(80);
  assert.equal(sent.length, atStop, 'no further steps after stop');

  // supersede: a new sequence cancels the rest of the old one
  motion.runSteps(DOCK, [{ part: 'foot', degrees: 5, duration_ms: 10 }]);
  await sleep(30);
  const last = (sent.at(-1)!.payload as { parts: Record<string, unknown> }).parts;
  assert.ok('foot' in last);
  motion.shutdown();
});

test('heartbeat re-sends current targets idempotently', async () => {
  const { motion, sent } = setup();
  motion.setTargets(DOCK, { neck: 1400 }, 10);
  await sleep(250); // active window 500ms → 10Hz resend
  assert.ok(sent.length >= 2, `expected heartbeat resends, got ${sent.length}`);
  const all = sent.map((s) => (s.payload as { parts: Record<string, { pulse_width_us: number }> }).parts.neck!.pulse_width_us);
  assert.ok(all.every((us) => us === 1400));
  motion.shutdown();
});

test('gesture: unknown expression or offline body is a silent no-op', async () => {
  const { motion, sent } = setup();
  motion.playGesture(DOCK, 'nonexistent', {});
  motion.playGesture(DOCK, 'happy', { happy: [{ part: 'neck', degrees: -12, duration_ms: 10 }] });
  await sleep(30);
  assert.equal(sent.length, 1);
  motion.shutdown();
});

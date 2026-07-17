import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Bus, type BusMessage } from '../../core/bus.js';
import type { RosterEntry } from '../../core/websocket-gateway.js';
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
  // Durations comfortably above the comfortable-speed floor for these travels, so neither
  // is stretched and the timing is deterministic. This test is about clamp + °→µs, not pacing.
  const status = motion.runSteps(DOCK, [
    { part: 'neck', degrees: -90, duration_ms: 500 },          // clamps to -60° = 833µs
    { parts: [{ part: 'neck', degrees: 0 }, { part: 'foot', degrees: 90 }], duration_ms: 500 },
  ]);
  assert.match(status, /moving/);
  await sleep(600); // both steps dispatched (heartbeats may interleave — match by content)
  const partsOf = (m: BusMessage) => (m.payload as { parts: Record<string, { pulse_width_us: number }> }).parts;
  assert.deepEqual(sent[0]!.toAddr, { dock: DOCK, component: 'body' });
  // step 1: neck clamped -90°→-60° = 833µs (first frame is the real send, before any heartbeat)
  assert.equal(partsOf(sent[0]!).neck!.pulse_width_us, 833); // 1500 + (-60/90)*1000, trunc
  // step 2: the frame that introduces the foot target (neck back to center + foot +90°)
  const step2 = sent.map(partsOf).find((p) => p.foot != null);
  assert.ok(step2, 'step 2 (with foot) was sent');
  assert.equal(step2!.neck!.pulse_width_us, 1500);
  assert.equal(step2!.foot!.pulse_width_us, 2500);
  motion.shutdown();
});

const durOf = (m: BusMessage, part: string) =>
  (m.payload as { parts: Record<string, { duration_ms: number }> }).parts[part]!.duration_ms;

test('runSteps: no explicit duration → paces by travel distance (big sweep slower than small nudge)', async () => {
  const { motion, sent } = setup();
  // From center (1500µs, first move): foot +90° = 2500µs → 1000µs travel → ~500ms.
  motion.runSteps(DOCK, [{ part: 'foot', degrees: 90 }]);
  await sleep(20);
  const bigDur = durOf(sent[0]!, 'foot');
  assert.ok(bigDur > 400, `full sweep should be slower than the old flat 400ms, got ${bigDur}`);

  // A small nudge from there (2500 → 2611? clamped) — use a fresh dock at center for clarity.
  const fresh = setup();
  fresh.motion.runSteps(DOCK, [{ part: 'foot', degrees: 9 }]); // 1600µs → 100µs travel → floors at MIN
  await sleep(20);
  const smallDur = durOf(fresh.sent[0]!, 'foot');
  assert.ok(smallDur < bigDur, `small nudge (${smallDur}) should be quicker than big sweep (${bigDur})`);
  motion.shutdown();
  fresh.motion.shutdown();
});

test('runSteps: explicit duration_ms is honored when above the velocity cap', async () => {
  // foot 0→+30° = 1500→1833µs = 333µs travel. cap-min = ceil(1.5*333/4000*1000)=125ms.
  // 300ms is above that → honored verbatim (an authored snappy-but-legal beat).
  const { motion, sent } = setup();
  motion.runSteps(DOCK, [{ part: 'foot', degrees: 30, duration_ms: 300 }]);
  await sleep(20);
  assert.equal(durOf(sent[0]!, 'foot'), 300, 'legal explicit duration is honored verbatim');
  motion.shutdown();
});

test('runSteps: an explicit duration faster than comfortable is stretched to the comfortable floor', async () => {
  // foot 0→-35° = 1500→1111µs = 389µs travel. comfortable-min = ceil(389/1500*1000)=260ms.
  const { motion, sent } = setup();
  motion.runSteps(DOCK, [{ part: 'foot', degrees: -35, duration_ms: 120 }]);
  await sleep(20);
  assert.equal(durOf(sent[0]!, 'foot'), 260, 'faster-than-comfortable stretched to the comfortable floor');
  motion.shutdown();
});

test('runSteps: a `snap` step opts out of the comfortable floor (bounded only by the hard cap)', async () => {
  // Same foot 0→-35° (389µs). snap skips the 260ms comfortable floor. Hard cap-min =
  // ceil(1.5*389/3000*1000)=195ms. So 120ms → 195ms (cap), NOT 260ms (comfortable).
  const { motion, sent } = setup();
  motion.runSteps(DOCK, [{ part: 'foot', degrees: -35, duration_ms: 120, snap: true }]);
  await sleep(20);
  assert.equal(durOf(sent[0]!, 'foot'), 195, 'snap bypasses comfort floor, still capped');
  motion.shutdown();
});

test('runSteps: a snap full-sweep is still bounded by the HARD velocity cap (never a wiggle)', async () => {
  // foot 0→+90° = 1500→2500µs = 1000µs travel. snap skips the comfortable floor, but the
  // hard cap-min (ceil(1.5*1000/3000*1000)=500ms) still applies — so 120ms → 500ms. This
  // is what keeps a fast sweep from collapsing to a wiggle (station pacing = real travel).
  const { motion, sent } = setup();
  motion.runSteps(DOCK, [{ part: 'foot', degrees: 90, duration_ms: 120, snap: true }]);
  await sleep(20);
  assert.equal(durOf(sent[0]!, 'foot'), 500, 'snap full-sweep stretched to the hard cap minimum');
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

test('runSteps throws when a HIGHER-priority holder owns the body (honest status, not a fake "moving")', () => {
  const { motion } = setup();
  // an emergency holder (100) outranks a brain turn (60): the brain's move must ERROR, so the
  // model says it couldn't move — not report a phantom success.
  motion.acquire(DOCK, 'emergency', 100);
  assert.throws(
    () => motion.runSteps(DOCK, [{ part: 'foot', degrees: 90 }], 'brain-turn'),
    /can't move .* has the body/,
  );
  motion.shutdown();
});

test('runSteps throws when the move is zero-travel (already at the limit — "turn right again")', async () => {
  const { motion } = setup();
  // first "turn right" (foot +90°) from center → real travel, admits and moves.
  assert.match(motion.runSteps(DOCK, [{ part: 'foot', degrees: 90 }], 'brain-turn'), /moving/);
  await sleep(10); // let the send land so the target is recorded at 2500µs
  // "turn right again" → foot +90° is where it already is → THROW so the model says it can't.
  assert.throws(
    () => motion.runSteps(DOCK, [{ part: 'foot', degrees: 90 }], 'brain-turn'),
    /already there|can't move further/,
  );
  // past-the-limit request clamps to the SAME 90° → still zero-travel → throws.
  assert.throws(() => motion.runSteps(DOCK, [{ part: 'foot', degrees: 200 }], 'brain-turn'), /already there/);
  // but a move to a DIFFERENT angle travels and is fine.
  assert.match(motion.runSteps(DOCK, [{ part: 'foot', degrees: 0 }], 'brain-turn'), /moving/);
  motion.shutdown();
});

test('runSteps: a pure wait step (no joints) is exempt from the zero-travel guard', () => {
  const { motion } = setup();
  assert.match(motion.runSteps(DOCK, [{ wait_ms: 200 }], 'brain-turn'), /pausing|moving/);
  motion.shutdown();
});

test('runSteps: RELATIVE moves add a delta to the live pose — "turn right again" keeps moving', async () => {
  const { motion, sent } = setup();
  const partsOf = (m: BusMessage) => (m.payload as { parts: Record<string, { pulse_width_us: number }> }).parts;
  const footUs = () => partsOf(sent.find((m) => partsOf(m).foot)!).foot!.pulse_width_us;
  const near = (got: number, want: number, msg: string) => assert.ok(Math.abs(got - want) <= 2, `${msg} (got ${got}, want ~${want})`);
  // from center (0°): turn right by 30° (relative, negative=right) → -30° ≈ 1166µs.
  motion.runSteps(DOCK, [{ part: 'foot', degrees: -30, relative: true }], 'brain-turn');
  await sleep(20);
  near(footUs(), 1167, 'first relative right → ~-30°');
  // "turn right AGAIN" — another -30° relative → now ≈ -60° ≈ 833µs (NOT stuck; keeps going).
  sent.length = 0;
  motion.runSteps(DOCK, [{ part: 'foot', degrees: -30, relative: true }], 'brain-turn');
  await sleep(20);
  near(footUs(), 833, 'second relative right → ~-60°');
  motion.shutdown();
});

test('runSteps: a relative move CLAMPS at the limit, and once there is a zero-travel no-op (honest)', async () => {
  const { motion } = setup();
  // slam to the right limit via a big relative delta (clamps at -90°).
  assert.match(motion.runSteps(DOCK, [{ part: 'foot', degrees: -200, relative: true }], 'brain-turn'), /moving/);
  await sleep(20);
  // "turn right again" at the limit → still -90° → zero travel → throws (can't go further).
  assert.throws(
    () => motion.runSteps(DOCK, [{ part: 'foot', degrees: -30, relative: true }], 'brain-turn'),
    /already there|can't move further/,
  );
  motion.shutdown();
});

test('pose(): reports facing + angles for the grounding line', async () => {
  const { motion } = setup();
  assert.match(motion.pose(DOCK)!, /facing forward, head level/); // never moved → neutral
  motion.runSteps(DOCK, [{ part: 'foot', degrees: -45 }], 'brain-turn'); // -45° = right
  await sleep(20);
  assert.match(motion.pose(DOCK)!, /facing 45° to the right/);
  motion.shutdown();
});

test('stop() cancels a running sequence; new sequence supersedes the old', async () => {
  const { motion, sent } = setup();
  motion.runSteps(DOCK, [
    { part: 'neck', degrees: 10, duration_ms: 200 },
    { part: 'neck', degrees: 20, duration_ms: 200 },
    { part: 'neck', degrees: 30, duration_ms: 200 },
  ]);
  await sleep(50); // mid-step-1 (200ms), before step 2
  motion.stop(DOCK);
  // no NEW target beyond step 1 should appear (heartbeats resend step 1's target, so
  // assert no neck target past the first, rather than a raw frame count).
  const neckTargets = () => new Set(sent
    .map((s) => (s.payload as { parts: Record<string, { pulse_width_us: number }> }).parts.neck?.pulse_width_us)
    .filter((v) => v != null));
  const atStop = neckTargets();
  assert.equal(atStop.size, 1, 'only step 1 target sent before stop');
  await sleep(120);
  assert.deepEqual(neckTargets(), atStop, 'no further neck targets after stop');

  // supersede: a new sequence cancels the rest of the old one
  motion.runSteps(DOCK, [{ part: 'foot', degrees: 30, duration_ms: 200 }]);
  await sleep(40);
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

test('runStepsAwaited: done resolves only after the sequence actually finishes', async () => {
  const { motion, sent } = setup();
  const t0 = Date.now();
  const { status, done } = motion.runStepsAwaited(DOCK, [
    { part: 'foot', degrees: 30, duration_ms: 300 },
    { part: 'foot', degrees: 0, duration_ms: 300 },
  ]);
  assert.match(status, /moving/);
  await done;
  const elapsed = Date.now() - t0;
  // two 300ms steps (both above the comfort floor for their travel) → ≥600ms
  assert.ok(elapsed >= 550, `done resolved too early (${elapsed}ms)`);
  assert.ok(sent.length >= 2, 'both steps dispatched');
  motion.shutdown();
});

test('runStepsAwaited: done resolves early when a new sequence supersedes it', async () => {
  const { motion } = setup();
  const { done } = motion.runStepsAwaited(DOCK, [
    { part: 'foot', degrees: 60, duration_ms: 400 },
    { part: 'foot', degrees: -60, duration_ms: 400 },
    { part: 'foot', degrees: 0, duration_ms: 400 },
  ]);
  await sleep(50);
  motion.stop(DOCK); // turn cancel — the sequence dies mid-flight
  const t0 = Date.now();
  await done;        // must not wait out the remaining ~1100ms
  assert.ok(Date.now() - t0 < 500, 'done resolved promptly after stop');
  motion.shutdown();
});

test('playGesture: choreography is an OFFSET around the current pose, not absolute', async () => {
  const { motion, sent } = setup();
  // park the body well off-center (visual_search just centered on someone)
  motion.runSteps(DOCK, [{ parts: [{ part: 'foot', degrees: -80 }, { part: 'neck', degrees: -10 }], duration_ms: 200 }]);
  await sleep(450);
  const before = sent.length;
  // a "happy"-shaped gesture authored around 0 — ends at (0,0) in authored terms
  motion.playGesture(DOCK, 'happy', {
    happy: [
      { parts: [{ part: 'foot', degrees: 12 }, { part: 'neck', degrees: -12 }], duration_ms: 150, snap: true },
      { parts: [{ part: 'foot', degrees: 0 }, { part: 'neck', degrees: 0 }], duration_ms: 150, snap: true },
    ],
  });
  await sleep(900);
  const partsOf = (m: BusMessage) => (m.payload as { parts: Record<string, { pulse_width_us: number }> }).parts;
  const frames = sent.slice(before).map(partsOf).filter((p) => p.foot != null);
  assert.ok(frames.length >= 2, 'gesture dispatched');
  // wiggle peak: -80 + 12 = -68° ≈ 744µs ; final: back to -80° ≈ 611µs — NEVER center (1500µs)
  const last = frames[frames.length - 1]!;
  assert.ok(Math.abs(last.foot!.pulse_width_us - 611) < 20, `ends at start pose, got ${last.foot!.pulse_width_us}µs`);
  assert.ok(!frames.some((f) => Math.abs(f.foot!.pulse_width_us - 1500) < 20), 'never teleports to center');
  motion.shutdown();
});

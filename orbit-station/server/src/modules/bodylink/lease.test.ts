/**
 * ActuatorLease — the body's priority arbiter. The make-or-break logic (faceFollow §4), so
 * the arbitration table + TTL expiry + preemption are proven with an injected clock (no real
 * timers): grant/deny by priority, equal = last-write-wins, higher preempts (callback fires),
 * superseded holder's moves are rejected, a crashed holder's lease auto-expires (body frees),
 * renew keeps it, and a stale handle can't release a newer holder.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ActuatorLease, PRIORITY, priorityForSource } from './lease.js';

const DOCK = 'd1';
/** a controllable clock */
function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => { t += ms; } };
}
const mk = (ttlMs = 1000, c = clock()) => ({ lease: new ActuatorLease({ ttlMs, now: c.now }), c });

// ── source → priority map ──────────────────────────────────────────────────────
test('priorityForSource maps the known sources', () => {
  assert.equal(priorityForSource('brain-turn'), PRIORITY.brainTurn);
  assert.equal(priorityForSource('console'), PRIORITY.console);
  assert.equal(priorityForSource('task:t-123'), PRIORITY.continuousTask);
  assert.equal(priorityForSource('emergency'), PRIORITY.emergency);
  assert.equal(priorityForSource('station'), PRIORITY.idle);
});

// ── acquire: grant / deny by priority ──────────────────────────────────────────
test('acquire grants when free; current() reflects the holder', () => {
  const { lease } = mk();
  const l = lease.acquire(DOCK, 'continuousTask', PRIORITY.continuousTask);
  assert.ok(l && l.valid(), 'granted when free');
  assert.deepEqual(lease.current(DOCK), { holder: 'continuousTask', priority: PRIORITY.continuousTask });
});

test('a LOWER priority is DENIED while a higher holds', () => {
  const { lease } = mk();
  lease.acquire(DOCK, 'brain', PRIORITY.brainTurn);          // 60 holds
  const lo = lease.acquire(DOCK, 'continuousTask', PRIORITY.continuousTask); // 30
  assert.equal(lo, null, 'faceFollow(30) denied while brain(60) holds');
});

test('a HIGHER priority PREEMPTS the holder (fires its onPreempt)', () => {
  const { lease } = mk();
  let preempted = false;
  lease.acquire(DOCK, 'continuousTask', PRIORITY.continuousTask, () => { preempted = true; }); // 30 holds
  const hi = lease.acquire(DOCK, 'brain', PRIORITY.brainTurn);                          // 60 preempts
  assert.ok(hi && hi.valid(), 'higher priority granted');
  assert.ok(preempted, 'the preempted holder was notified');
  assert.deepEqual(lease.current(DOCK), { holder: 'brain', priority: PRIORITY.brainTurn });
});

test('EQUAL priority = last-write-wins (new holder takes over)', () => {
  const { lease } = mk();
  const a = lease.acquire(DOCK, 'consoleA', PRIORITY.console);
  const b = lease.acquire(DOCK, 'consoleB', PRIORITY.console);
  assert.ok(b && b.valid(), 'equal-priority acquire granted (last write wins)');
  assert.equal(a!.valid(), false, 'the previous equal holder is superseded');
  assert.equal(lease.current(DOCK)!.holder, 'consoleB');
});

// ── the superseded holder can no longer act ────────────────────────────────────
test('a superseded lease is INVALID (its moves would be rejected)', () => {
  const { lease } = mk();
  const ff = lease.acquire(DOCK, 'continuousTask', PRIORITY.continuousTask);
  lease.acquire(DOCK, 'brain', PRIORITY.brainTurn); // preempts ff
  assert.equal(ff!.valid(), false, 'preempted holder lease is no longer valid');
});

// ── admit() — the fire-and-forget compat path ──────────────────────────────────
test('admit: a normal call goes through when nothing higher contends', () => {
  const { lease } = mk();
  assert.equal(lease.admit(DOCK, 'brain-turn', PRIORITY.brainTurn), true);
});

test('admit: BLOCKED when a higher-priority holder owns the body', () => {
  const { lease } = mk();
  lease.acquire(DOCK, 'emergency', PRIORITY.emergency); // 100 holds
  assert.equal(lease.admit(DOCK, 'brain-turn', PRIORITY.brainTurn), false, 'brain move blocked by emergency');
});

test('admit: a higher-priority move PREEMPTS a lower holder', () => {
  const { lease } = mk();
  let preempted = false;
  lease.acquire(DOCK, 'continuousTask', PRIORITY.continuousTask, () => { preempted = true; });
  assert.equal(lease.admit(DOCK, 'brain-turn', PRIORITY.brainTurn), true, 'brain admits over faceFollow');
  assert.ok(preempted, 'faceFollow was preempted by the brain move');
});

test('admit: the HOLDER\'s own moves always admit (same source)', () => {
  const { lease } = mk();
  lease.acquire(DOCK, 'task:t-1', PRIORITY.continuousTask);
  assert.equal(lease.admit(DOCK, 'task:t-1', PRIORITY.continuousTask), true, 'holder admits its own moves');
});

test('admit: the holder\'s own LOWER-priority move does NOT downgrade its hold (moods@35 fix)', () => {
  const { lease } = mk();
  // an idle-moods task holds at 35; its own move admits at the task-source default (30)
  lease.acquire(DOCK, 'task:t-9', PRIORITY.moodBit);
  assert.equal(lease.admit(DOCK, 'task:t-9', priorityForSource('task:t-9')), true, 'own move admits');
  assert.equal(lease.current(DOCK)!.priority, PRIORITY.moodBit, 'hold priority NOT demoted to 30');
  // an equal-30 waiter (faceFollow) must still be denied mid-bit…
  assert.equal(lease.acquire(DOCK, 'task:t-ff', PRIORITY.continuousTask), null, 'ff(30) denied while bit(35) lives');
  // …and gets the body back after release
  lease.releaseByHolder(DOCK, 'task:t-9');
  assert.ok(lease.acquire(DOCK, 'task:t-ff', PRIORITY.continuousTask), 'ff reclaims after the bit releases');
});

test('admit: a same-holder refresh keeps the LONGER expiry (settle hold not shortened)', () => {
  const { lease, c } = mk(1000);
  assert.equal(lease.admit(DOCK, 'brain-turn', PRIORITY.brainTurn, 3000), true, 'settle hold taken');
  c.advance(500);
  assert.equal(lease.admit(DOCK, 'brain-turn', PRIORITY.brainTurn), true, 'own follow-up move admits');
  c.advance(2000); // 2500 total — inside the original 3000 settle, past the refreshed 500+1000
  assert.equal(lease.current(DOCK)?.holder, 'brain-turn', 'settle hold survived the shorter refresh');
});

test('admit: a SETTLE-grace holdMs keeps a follower yielded past the default TTL (look-right fix)', () => {
  const { lease, c } = mk(1000); // default TTL 1s
  lease.acquire(DOCK, 'task:t-1', PRIORITY.continuousTask); // faceFollow holds
  // user move preempts AND takes a 2.5s settle hold (outlives the default 1s TTL)
  assert.equal(lease.admit(DOCK, 'brain-turn', PRIORITY.brainTurn, 2500), true);
  c.advance(1200); // past the DEFAULT ttl, but inside the settle grace
  // faceFollow tries to reclaim — still denied, so it stays yielded and won't re-center yet
  assert.equal(lease.acquire(DOCK, 'task:t-1', PRIORITY.continuousTask), null, 'follower still yielded during settle');
  assert.equal(lease.current(DOCK)?.holder, 'brain-turn', 'brain move still owns the body');
  c.advance(1400); // 2600 total → past the 2500 settle grace
  assert.equal(lease.current(DOCK), undefined, 'settle grace expired → body free');
  assert.ok(lease.acquire(DOCK, 'task:t-1', PRIORITY.continuousTask), 'follower reclaims + resumes');
});

// ── TTL: the safety property — a crashed holder frees the body ──────────────────
test('TTL EXPIRY: a hold not renewed auto-releases (crashed-holder safety)', () => {
  const { lease, c } = mk(1000);
  lease.acquire(DOCK, 'continuousTask', PRIORITY.continuousTask);
  assert.ok(lease.current(DOCK), 'held now');
  c.advance(1001); // past the TTL, never renewed
  assert.equal(lease.current(DOCK), undefined, 'expired → body free');
  // and a lower-priority caller can now take it
  assert.equal(lease.admit(DOCK, 'console', PRIORITY.console), true, 'console gets the freed body');
});

test('renew() keeps a hold alive across ticks', () => {
  const { lease, c } = mk(1000);
  const l = lease.acquire(DOCK, 'continuousTask', PRIORITY.continuousTask)!;
  c.advance(800); l.renew();
  c.advance(800); // 1600 total, but renewed at 800 → only 800 since renew
  assert.ok(l.valid(), 'still valid after a renew within the TTL');
  assert.ok(lease.current(DOCK), 'still held');
});

test('a renew AFTER expiry does not resurrect (the holder is already gone)', () => {
  const { lease, c } = mk(1000);
  const l = lease.acquire(DOCK, 'continuousTask', PRIORITY.continuousTask)!;
  c.advance(1001);
  l.renew(); // too late
  assert.equal(l.valid(), false, 'expired lease cannot be renewed back to life');
});

// ── release + stale-handle safety ──────────────────────────────────────────────
test('release frees the body for the next acquirer', () => {
  const { lease } = mk();
  const l = lease.acquire(DOCK, 'continuousTask', PRIORITY.continuousTask)!;
  l.release();
  assert.equal(lease.current(DOCK), undefined, 'released → free');
  assert.ok(lease.acquire(DOCK, 'console', PRIORITY.console), 'next acquirer gets it');
});

test('a STALE handle cannot release a NEWER holder', () => {
  const { lease } = mk();
  const old = lease.acquire(DOCK, 'continuousTask', PRIORITY.continuousTask)!;
  lease.acquire(DOCK, 'brain', PRIORITY.brainTurn); // preempts; old is stale
  old.release(); // must NOT free the brain's hold
  assert.equal(lease.current(DOCK)!.holder, 'brain', 'stale release ignored — brain still holds');
});

// ── per-dock isolation ─────────────────────────────────────────────────────────
test('holds are per-dock (one dock\'s holder does not affect another)', () => {
  const { lease } = mk();
  lease.acquire('dA', 'brain', PRIORITY.brainTurn);
  const lB = lease.acquire('dB', 'continuousTask', PRIORITY.continuousTask);
  assert.ok(lB && lB.valid(), 'dock B unaffected by dock A\'s holder');
});

// ── searchHold: visual_search parks its found pose (~10s), ambient can't clobber ──
test('searchHold(50) BLOCKS an ambient move but YIELDS to a brain-turn', () => {
  const { lease } = mk();
  lease.acquire(DOCK, 'search-hold', PRIORITY.searchHold, undefined, 10_000);
  // an idle-moods bit (35) or emotion cannot wiggle the parked gaze
  assert.equal(lease.admit(DOCK, 'task:idle-moods', PRIORITY.moodBit), false, 'moodBit(35) blocked by searchHold(50)');
  // but the user talking (brain-turn 60) still moves the body
  assert.equal(lease.admit(DOCK, 'brain-turn', PRIORITY.brainTurn), true, 'brain-turn(60) preempts searchHold(50)');
});

test('searchHold: an acquire holdMs outlives the default TTL, then auto-expires (body frees)', () => {
  const c = clock();
  const lease = new ActuatorLease({ ttlMs: 1500, now: c.now });
  lease.acquire(DOCK, 'search-hold', PRIORITY.searchHold, undefined, 10_000);
  c.advance(5_000); // well past the 1500ms default TTL
  assert.equal(lease.admit(DOCK, 'task:idle-moods', PRIORITY.moodBit), false, 'still held at 5s (holdMs=10s)');
  c.advance(6_000); // now past 10s total
  assert.equal(lease.admit(DOCK, 'task:idle-moods', PRIORITY.moodBit), true, 'freed after the 10s hold expires');
});

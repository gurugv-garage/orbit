/**
 * remind-at clock parsing + next-occurrence math — the historically brittle
 * part (the old LLM-generated task only matched "7:20PM"). Lock the formats
 * and the "already passed today → tomorrow" roll.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseClock, msUntilNext } from './clock.js';

test('parseClock accepts the common formats', () => {
  assert.deepEqual(parseClock('7:20'), { hours: 7, minutes: 20 });
  assert.deepEqual(parseClock('07:20'), { hours: 7, minutes: 20 });
  assert.deepEqual(parseClock('19:20'), { hours: 19, minutes: 20 });
  assert.deepEqual(parseClock('7:20pm'), { hours: 19, minutes: 20 });
  assert.deepEqual(parseClock('7:20 PM'), { hours: 19, minutes: 20 });
  assert.deepEqual(parseClock('12:00am'), { hours: 0, minutes: 0 });
  assert.deepEqual(parseClock('12:00pm'), { hours: 12, minutes: 0 });
  assert.deepEqual(parseClock('7pm'), { hours: 19, minutes: 0 });
  assert.deepEqual(parseClock('7 am'), { hours: 7, minutes: 0 });
});

test('parseClock rejects garbage', () => {
  assert.equal(parseClock('soon'), null);
  assert.equal(parseClock('25:00'), null);
  assert.equal(parseClock('7:99'), null);
  assert.equal(parseClock('13pm'), null);
});

test('msUntilNext lands on a future time, rolling past today to tomorrow', () => {
  // Anchor "now" at a fixed instant; use UTC so the test is timezone-stable.
  const now = new Date('2026-06-16T10:00:30Z');

  // 10:05 UTC is 4m30s ahead.
  const ahead = msUntilNext({ hours: 10, minutes: 5 }, 'UTC', now);
  assert.equal(ahead, (4 * 60 + 30) * 1000);

  // 09:00 UTC already passed → ~23h ahead (rolls to tomorrow).
  const rolled = msUntilNext({ hours: 9, minutes: 0 }, 'UTC', now);
  assert.ok(rolled > 22 * 3600_000 && rolled < 24 * 3600_000);
});

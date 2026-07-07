/**
 * Wall-clock parsing + next-occurrence math — the harness's ONE implementation
 * of "at TIME of day". Every task (packaged or LLM-generated) must use this
 * (directly or via Task.sleepUntil) rather than hand-rolling clock parsing:
 * hand-rolled versions kept breaking on formats like "4:40 PM".
 */

/**
 * Parse a wall-clock time into {hours 0-23, minutes}. Accepts "7:20", "07:20",
 * "19:20", "7:20pm", "7:20 PM", "7pm", "7 am". Returns null if unparseable —
 * the old LLM-generated task only matched "7:20PM", which was the bug.
 */
export function parseClock(raw: string): { hours: number; minutes: number } | null {
  const s = raw.trim().toLowerCase();
  const m = s.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/);
  if (!m) return null;
  let hours = parseInt(m[1]!, 10);
  const minutes = m[2] ? parseInt(m[2], 10) : 0;
  const ampm = m[3];
  if (minutes > 59) return null;
  if (ampm) {
    if (hours < 1 || hours > 12) return null;
    if (ampm === 'pm' && hours !== 12) hours += 12;
    if (ampm === 'am' && hours === 12) hours = 0;
  } else if (hours > 23) {
    return null;
  }
  return { hours, minutes };
}

/**
 * ms from `now` until the clock next reads {hours,minutes} in `timeZone`. We
 * read the wall clock in that zone via Intl (so DST/offset is handled without a
 * date library) and roll to tomorrow if the time already passed today.
 */
export function msUntilNext(
  target: { hours: number; minutes: number },
  timeZone: string,
  now: Date = new Date(),
): number {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone, hour12: false,
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(now);
  const get = (t: string) => parseInt(parts.find((p) => p.type === t)!.value, 10);
  const nowH = get('hour') % 24, nowMin = get('minute'), nowSec = get('second');

  const nowMinOfDay = nowH * 60 + nowMin;
  const tgtMinOfDay = target.hours * 60 + target.minutes;
  let deltaMin = tgtMinOfDay - nowMinOfDay;
  if (deltaMin <= 0) deltaMin += 24 * 60; // already passed today → tomorrow
  // subtract seconds already elapsed in the current minute so we land on :00
  return deltaMin * 60_000 - nowSec * 1_000;
}

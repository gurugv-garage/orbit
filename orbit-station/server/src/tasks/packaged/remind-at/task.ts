/**
 * # remind-at
 * ONE-SHOT reminder at a specific wall-clock TIME of day (e.g. "remind me at
 * 7:20", "at 7:20pm", "at 19:20"). Computes the delay until the next time that
 * clock reads `time` in the STATION's local timezone, sleeps, notifies, stops.
 *
 * This ships PACKAGED (not LLM-generated) on purpose: absolute-time reminders
 * were the brain's most failure-prone hand-written task — brittle time regexes
 * (only `7:20PM` matched, not `7:20` / `19:20` / `7:20 pm`) and ad-hoc
 * timezone/past-midnight math. The harness's `parseClock` accepts the common
 * forms and the "already passed today → tomorrow" roll is done once, correctly.
 */
import { Task, runTask, parseClock, msUntilNext, type TaskManifest } from '../../_harness/index.js';

export const manifest = {
  name: 'remind-at',
  description:
    'ONE-SHOT reminder at a specific TIME of day, then stop. Use for "remind me at 7:20", '
    + '"at 7:20pm", "at 19:20". `time` is a clock time (24h "19:20" or 12h "7:20pm"); it fires '
    + 'at the NEXT occurrence of that time (today if still ahead, else tomorrow) in local time. '
    + 'For "in N minutes" use remind-after instead.',
  params: [
    { name: 'message', type: 'string', required: true },
    { name: 'time', type: 'string', required: true },
  ],
  // a reminder must still fire after you walk away from the dock — survive phone-offline.
  bgTask: true,
} satisfies TaskManifest;

class RemindAtTask extends Task {
  async run(): Promise<void> {
    const timeStr = this.params.time as string;
    const message = this.params.message as string;
    const clock = parseClock(timeStr);
    if (!clock) {
      this.errored(`Could not understand the time "${timeStr}". Use e.g. "7:20pm" or "19:20".`);
      return;
    }
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
    const delayMs = msUntilNext(clock, tz);
    const hh = String(clock.hours).padStart(2, '0');
    const mm = String(clock.minutes).padStart(2, '0');
    this.status(`waiting until ${hh}:${mm} (${tz}) to remind: ${message}`);
    await this.sleep(delayMs);
    await this.notifyAgent(message);
    this.finish('reminded');
  }
  getStatus(): string {
    return `remind once at ${this.params.time}: ${this.params.message}`;
  }
}

runTask(RemindAtTask);

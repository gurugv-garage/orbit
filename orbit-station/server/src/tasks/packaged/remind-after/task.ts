/**
 * # remind-after
 * Remind the user once, after a delay (e.g. "in 5 minutes").
 *
 * run() waits, then notifies, then finishes. `delay` is a duration string
 * ("5m", "30s", "1h"). Nothing to checkpoint — if the process restarts it just
 * waits the delay again, which is fine for a short reminder.
 */
import { Task, runTask, type TaskManifest } from '../../_harness/index.js';

export const manifest = {
  name: 'remind-after',
  description: 'ONE-SHOT reminder: remind the user once after a delay, then stop. Use for "remind me in N minutes / in an hour / shortly".',
  params: [
    { name: 'message', type: 'string', required: true },
    { name: 'delay', type: 'duration', required: true },
  ],
} satisfies TaskManifest;

class RemindAfterTask extends Task {
  async run(): Promise<void> {
    this.status(`waiting ${this.params.delay} to remind: ${this.params.message}`);
    await this.sleep(this.params.delay as string);
    await this.notifyAgent(this.params.message as string);
    this.finish('reminded');
  }
  getStatus(): string {
    return `remind once after ${this.params.delay}: ${this.params.message}`;
  }
}

runTask(RemindAfterTask);

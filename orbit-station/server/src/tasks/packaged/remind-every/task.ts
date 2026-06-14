/**
 * # remind-every
 * Remind the user on a fixed interval until stopped.
 *
 * run() loops: sleep the interval, then notify. It waits BEFORE the first
 * reminder (so "every 5 min" fires after 5 min, not instantly). It keeps a count
 * in this.state and checkpoints it, so a respawn (resume) doesn't lose the tally.
 * Runs until the user stops it (the supervisor kills the process).
 */
import { Task, runTask, type TaskManifest } from '../../_harness/index.js';

export const manifest = {
  name: 'remind-every',
  description: 'RECURRING reminder: remind the user repeatedly on a fixed interval until they stop it. Use for "remind me every N minutes / hourly". NOT for a one-time reminder — use remind-after for that.',
  params: [
    { name: 'message', type: 'string', required: true },
    { name: 'interval', type: 'duration', default: '5m' },
  ],
} satisfies TaskManifest;

class RemindEveryTask extends Task {
  async run(): Promise<void> {
    this.state.count ??= 0;
    this.status(`reminding every ${this.params.interval}`);
    while (true) {
      await this.sleep(this.params.interval as string);
      this.state.count = (this.state.count as number) + 1;
      this.checkpoint();
      this.status(`reminded ${this.state.count}× — every ${this.params.interval}`);
      await this.notifyAgent(this.params.message as string);
    }
  }
  getStatus(): string {
    return `reminding every ${this.params.interval}: ${this.params.message}`;
  }
}

runTask(RemindEveryTask);

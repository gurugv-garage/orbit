/**
 * Task process entrypoint. A generated/packaged task.ts ends with:
 *
 *   import { runTask } from '../../_harness/index.js';
 *   runTask(MyTask);
 *
 * The supervisor spawns `npx tsx task.ts` (inside a tmux window when available)
 * with the task identity in env. This constructs the task and calls start(),
 * which connects to the station WS, waits for `init`, then runs run().
 */
import { Task, identityFromEnv, type TaskIdentity } from './task.js';

export type TaskClass = new () => Task;

export function runTask(TaskCtor: TaskClass): void {
  const ident: TaskIdentity = identityFromEnv();
  const task = new TaskCtor();
  task.start(ident).then(
    () => process.exit(0),
    (err) => { console.error(`[task ${ident.instanceId}] start failed:`, err); process.exit(1); },
  );
}

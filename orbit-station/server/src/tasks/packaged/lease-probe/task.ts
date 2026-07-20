/**
 * # lease-probe — the MOCK FOLLOWER that validates the actuator lease (the keystone).
 *
 * Not a real behaviour — a deliberately trivial body-holder used ONCE to prove the lease on
 * the real dock before faceFollow is retrofitted onto it (facefollow decision trace §5 step 2,
 * "the make-or-break test"). It:
 *   - acquires the body at faceFollow priority (30),
 *   - pans the `foot` slowly back and forth while HOLDING the lease, renewing each tick,
 *   - on each tick checks whether it STILL holds the body; if a higher-priority mover (a
 *     brain turn at 60) preempted it, it STOPS commanding (and waits to reacquire),
 *   - releases on stop.
 *
 * The three things to verify on the body with this running:
 *   1. it pans back and forth (it holds + drives the body),
 *   2. KILL it (stop the task) → the body FREES within one lease TTL (no frozen pan) → the
 *      brain/console can move it again — the crashed-holder safety property,
 *   3. trigger a brain turn (a gesture) mid-sweep → it PREEMPTS the probe → the probe stops →
 *      after the gesture, the probe reacquires + resumes.
 */
import { Task, runTask, type TaskManifest } from '../../_harness/index.js';

export const manifest = {
  name: 'lease-probe',
  description: 'Lease validation mock: holds the body at a priority and pans foot back and '
    + 'forth, yielding when preempted. For proving the actuator lease — not a real behaviour.',
  params: [
    { name: 'tick', type: 'duration', required: false, default: '500ms' },
    { name: 'priority', type: 'number', required: false, default: 30 }, // faceFollow level
    { name: 'sweepDeg', type: 'number', required: false, default: 20 },  // pan amplitude (±)
    { name: 'step', type: 'number', required: false, default: 10 },      // deg per tick
  ],
} satisfies TaskManifest;

class LeaseProbeTask extends Task {
  async run(): Promise<void> {
    const tick = (this.params.tick as string | undefined) ?? '500ms';
    const priority = Number(this.params.priority ?? 30);
    const amp = Number(this.params.sweepDeg ?? 20);
    const step = Number(this.params.step ?? 10);

    // acquire the body once; if a higher holder owns it, we'll reacquire below.
    let foot = 0; let dir: 1 | -1 = 1; let holding = false;
    while (true) {
      // each tick: are we (still) the holder? bodyHeld renews our hold if so.
      const h = await this.heldOrAcquire(priority);
      if (!h.held) {
        // preempted (or never acquired) → DON'T command. Log who has it, wait, retry.
        this.status(`yielded — body held by ${h.holder ?? 'someone'}; waiting`);
        holding = false;
        await this.sleep(tick);
        continue;
      }
      if (!holding) { this.status('acquired body — sweeping'); holding = true; }
      // drive the pan back and forth.
      foot += dir * step;
      if (foot >= amp) { foot = amp; dir = -1; }
      if (foot <= -amp) { foot = -amp; dir = 1; }
      await this.move([{ parts: [{ part: 'foot', degrees: foot }], duration_ms: 400 }], 'lease-probe');
      this.status(`sweeping foot=${foot}° (holding @${priority})`);
      this.state.foot = foot; this.checkpoint();
      await this.sleep(tick);
    }
  }

  /** Acquire-if-needed + renew; return whether WE hold the body now. */
  private async heldOrAcquire(priority: number): Promise<{ held: boolean; holder: string | null }> {
    try {
      const cur = await this.request<{ held: boolean; holder: string | null }>('bodyHeld');
      if (cur?.held) return cur;
      // not held — try to (re)acquire. Granted iff nothing higher holds it.
      const got = await this.request<{ ok: boolean }>('acquireBody', { priority });
      return { held: !!got?.ok, holder: cur?.holder ?? null };
    } catch {
      return { held: false, holder: null }; // transient capability error → treat as not-held
    }
  }

  // NOTE: no clean-release-on-stop hook by design. A `stop` is a process kill (the harness
  // exits immediately), and the WHOLE POINT of this probe is to prove the body frees on TTL
  // expiry WITHOUT the holder cooperating — the crashed-holder safety property. (`releaseBody`
  // exists for the graceful path faceFollow will use, but we deliberately don't rely on it here.)

  getStatus(): string { return 'lease-probe'; }
}

runTask(LeaseProbeTask);

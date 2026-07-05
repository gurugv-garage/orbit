/**
 * reconcile — the CONDUCTOR's one decision step (pure over injected effects). For each
 * conducted thing (a BEHAVIOUR or a TASK): ask `decide`, compare to what's actually running,
 * and start/stop to match. Same idempotent self-correcting discipline as the lease/heartbeat —
 * a missed start/stop heals next tick. Cadence-driven in v1 (event triggers are a v2 add that
 * call this same function).
 *
 * Effects are injected so this is fully unit-testable with fakes (no supervisor, no brain).
 */
import type { Conducted, ConductedState, World, Tunings } from './conducted.js';

/** What `reconcile` can DO — the conductor wires these to the real supervisor + brain. */
export interface Effects {
  /** is a TASK currently running on this dock? (kind:'task') */
  isTaskRunning(dock: string, taskName: string): boolean;
  /** start a TASK (kind:'task'). `tunings` are the thing's live config, handed to the task
   *  as its params (snapshot at start — a tunings edit applies on the next start). */
  startTask(dock: string, taskName: string, priority: number, tunings: Tunings): void;
  /** stop a TASK (kind:'task'). */
  stopTask(dock: string, taskName: string): void;
  /** enable/disable a BEHAVIOUR (kind:'behaviour') — the hardcoded-in-place reaction, e.g.
   *  wakeUp's wake-phrase check in the brain. */
  setBehaviour(dock: string, name: string, on: boolean, tunings: Tunings): void;
  /** a conducted thing's desired/running transitioned — for the [cond] log. */
  onTransition?(dock: string, name: string, from: string, to: string, why: string): void;
}

/** One reconcile pass for a dock. Mutates `states` (per-item carried state) in place and
 *  enacts via `fx`. `cfgFor` returns the live tunings for a conducted thing (from config). */
export function reconcile(
  dock: string,
  conducted: Conducted[],
  world: World,
  states: Map<string, ConductedState>,
  cfgFor: (name: string) => Tunings,
  fx: Effects,
  /** manual overrides (the "Run now" / "Stop" buttons): force a thing on/off this tick,
   *  overriding its rule. 'run' = force running; 'off' = force off. Absent = follow decide(). */
  override: (name: string) => 'run' | 'off' | undefined = () => undefined,
): void {
  for (const c of conducted) {
    const prev = states.get(c.name) ?? { desired: 'off' as const, windowOpenedAt: 0 };
    // Merge the descriptor's defaults UNDER the live config so downstream consumers (the
    // task's params, a behaviour's hook) see ONE source of truth for every knob — raw
    // config alone let a task manifest's stale default win silently (review 2026-07-05).
    const tunings = { ...c.defaults, ...cfgFor(c.name) };
    const decided = c.decide(tunings, world, prev);
    // a manual override wins over the rule; otherwise the rule decides.
    const ov = override(c.name);
    const desired = ov === 'run' ? 'running' : ov === 'off' ? 'off' : decided.desired;
    const self = decided.self.desired === desired ? decided.self : { ...decided.self, desired };
    states.set(c.name, self);

    if (c.kind === 'task') {
      const running = fx.isTaskRunning(dock, c.taskName!);
      // Log only on a genuine DESIRED edge (off↔running), not every tick — a persistent
      // can't-start (e.g. no open session yet) keeps RE-ATTEMPTING (idempotent, self-healing)
      // but must NOT spam the log. The start/stop calls below run each tick regardless.
      const edge = desired !== prev.desired;
      if (desired === 'running' && !running) {
        fx.startTask(dock, c.taskName!, c.priority ?? 0, tunings);
        if (edge) fx.onTransition?.(dock, c.name, prev.desired, 'running', 'start');
      } else if (desired === 'off' && running) {
        fx.stopTask(dock, c.taskName!);
        if (edge) fx.onTransition?.(dock, c.name, prev.desired, 'off', 'stop');
      } else if (edge) {
        fx.onTransition?.(dock, c.name, prev.desired, desired, desired === 'running' ? 'running (already up)' : 'off');
      }
    } else {
      // behaviour: enact every tick (idempotent setter) so a live config edit applies; log
      // only on a desired transition. The descriptor's prepareTunings (if any) normalizes
      // the merged tunings — reconcile stays name-agnostic.
      fx.setBehaviour(dock, c.name, desired === 'running', c.prepareTunings ? c.prepareTunings(tunings) : tunings);
      if (desired !== prev.desired) {
        fx.onTransition?.(dock, c.name, prev.desired, desired, `behaviour ${desired === 'running' ? 'enabled' : 'disabled'}`);
      }
    }
  }
}

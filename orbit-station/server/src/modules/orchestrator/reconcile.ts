/**
 * reconcile — the orchestrator's one decision step (pure over injected effects). For each
 * behaviour: ask `decide`, compare to what's actually running, and start/stop to match. Same
 * idempotent self-correcting discipline as the lease/heartbeat — a missed start/stop heals
 * next tick. Cadence-driven in v1 (event triggers are a v2 add that call this same function).
 *
 * Effects are injected so this is fully unit-testable with fakes (no supervisor, no brain).
 */
import type { Behaviour, BehaviourState, World, Tunings } from './behaviours.js';
import { wakeTunings } from './behaviours.js';

/** What `reconcile` can DO — the orchestrator wires these to the real supervisor + brain. */
export interface Effects {
  /** is a behaviour's task currently running on this dock? (kind:'task') */
  isTaskRunning(dock: string, taskName: string): boolean;
  /** start a behaviour's task (kind:'task'). */
  startTask(dock: string, taskName: string, priority: number): void;
  /** stop a behaviour's task (kind:'task'). */
  stopTask(dock: string, taskName: string): void;
  /** enable/disable an in-process behaviour (kind:'inproc') — e.g. wakeUp's brain hook. */
  setInproc(dock: string, behaviour: string, on: boolean, tunings: Tunings): void;
  /** a behaviour's desired/running transitioned — for the [orch] log. */
  onTransition?(dock: string, behaviour: string, from: string, to: string, why: string): void;
}

/** One reconcile pass for a dock. Mutates `states` (per-behaviour carried state) in place and
 *  enacts via `fx`. `cfgFor` returns the live tunings for a behaviour (from config). */
export function reconcile(
  dock: string,
  behaviours: Behaviour[],
  world: World,
  states: Map<string, BehaviourState>,
  cfgFor: (behaviour: string) => Tunings,
  fx: Effects,
): void {
  for (const b of behaviours) {
    const prev = states.get(b.name) ?? { desired: 'off' as const, windowOpenedAt: 0 };
    const tunings = cfgFor(b.name);
    const { desired, self } = b.decide(tunings, world, prev);
    states.set(b.name, self);

    if (b.kind === 'task') {
      const running = fx.isTaskRunning(dock, b.taskName!);
      // Log only on a genuine DESIRED edge (off↔running), not every tick — a persistent
      // can't-start (e.g. no open session yet) keeps RE-ATTEMPTING (idempotent, self-healing)
      // but must NOT spam the log. The start/stop calls below run each tick regardless.
      const edge = desired !== prev.desired;
      if (desired === 'running' && !running) {
        fx.startTask(dock, b.taskName!, b.priority ?? 0);
        if (edge) fx.onTransition?.(dock, b.name, prev.desired, 'running', 'start');
      } else if (desired === 'off' && running) {
        fx.stopTask(dock, b.taskName!);
        if (edge) fx.onTransition?.(dock, b.name, prev.desired, 'off', 'stop');
      } else if (edge) {
        fx.onTransition?.(dock, b.name, prev.desired, desired, desired === 'running' ? 'running (already up)' : 'off');
      }
    } else {
      // inproc: enact every tick (idempotent setter) so a live config edit applies; log only
      // on a desired transition.
      fx.setInproc(dock, b.name, desired === 'running', b.name === 'wakeUp' ? wakeTunings(tunings) : tunings);
      if (desired !== prev.desired) {
        fx.onTransition?.(dock, b.name, prev.desired, desired, `inproc ${desired === 'running' ? 'enabled' : 'disabled'}`);
      }
    }
  }
}

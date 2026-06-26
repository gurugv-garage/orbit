/**
 * Behaviours + the pure decision logic for the per-dock orchestrator
 * (docs/decision-traces/orchestrator-v1-design.md). PURE + time-injectable so the whole
 * conducting policy is unit-testable without a station, supervisor, or clock.
 *
 * A Behaviour is a named intent the conductor turns on/off by a RULE (`decide`). Two KINDS:
 *   • 'task'   — its work is a spawned task process (faceFollow → the `face-follow` task).
 *   • 'inproc' — its work is a tiny in-process hook the orchestrator toggles (wakeUp → the
 *                brain's wake-phrase check). No process.
 *
 * `decide(tunings, world, self) → 'off' | 'running'` is the only behaviour-specific logic —
 * arithmetic / rules over the tunings + cheap world reads + the behaviour's own carried state.
 * (v1 conducting is fixed structure + tunable parameters; the same seam later admits learned
 * params or richer code-logic — see the design doc.)
 */

export type Desired = 'off' | 'running';

/** The cheap world snapshot handed to every `decide` (design §3a). Assembled each tick. */
export interface World {
  now: number;
  present: boolean;
  lastPresenceMs: number;        // epoch of the last presence arrival (0 = never)
  identity: string | null;
  listening: boolean;
  turnActive: boolean;
  /** epoch of the last conversation activity (turn/listening). 0 = none seen. */
  lastConversationMs: number;
  bodyHolder: { holder: string; priority: number } | null;
  tasks: Array<{ name: string; instanceId: string; initiator: 'user' | 'brain' | 'self'; ageMs: number }>;
}

/** Per-behaviour state the orchestrator carries between ticks (so `decide` stays pure — it's
 *  handed the state and returns the next one alongside its decision). */
export interface BehaviourState {
  desired: Desired;              // last decision (for transition logging)
  /** for windowed behaviours (faceFollow): epoch the current ACTIVE window opened, 0 = not active. */
  windowOpenedAt: number;
}

export const initBehaviourState = (): BehaviourState => ({ desired: 'off', windowOpenedAt: 0 });

/** A behaviour's tunings — a free bag of knobs from config (validated per-behaviour in decide). */
export type Tunings = Record<string, unknown>;

export interface Behaviour {
  name: string;
  kind: 'task' | 'inproc';
  /** for kind:'task' — the task definition name + lease priority it runs at. */
  taskName?: string;
  priority?: number;
  /** decide: pure. Returns the desired state + the (possibly updated) carried state. */
  decide(t: Tunings, world: World, self: BehaviourState): { desired: Desired; self: BehaviourState };
  /** config defaults (also the documented knobs). */
  defaults: Tunings;
}

const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const bool = (v: unknown, d: boolean) => (typeof v === 'boolean' ? v : d);
const str = (v: unknown, d: string) => (typeof v === 'string' && v ? v : d);

// ── faceFollow — a periodic "look around" window (body behaviour) ──────────────────────────
// Idle = NO conversation (no active turn, not listening). After `activateAfterMs` of idle →
// open a window (running) for up to `runForMs`, then sleep until another idle stretch. Never
// runs during a conversation.
export const faceFollowBehaviour: Behaviour = {
  name: 'faceFollow', kind: 'task', taskName: 'face-follow', priority: 30,
  defaults: { enabled: true, activateAfterMs: 300_000, runForMs: 900_000 },
  decide(t, world, self) {
    const enabled = bool(t.enabled, true);
    const activateAfterMs = num(t.activateAfterMs, 300_000);
    const runForMs = num(t.runForMs, 900_000);
    // disabled, or a conversation is live → off (and close any window).
    if (!enabled || world.turnActive || world.listening) {
      return { desired: 'off', self: { ...self, desired: 'off', windowOpenedAt: 0 } };
    }
    // currently in an active window?
    if (self.windowOpenedAt > 0) {
      if (world.now - self.windowOpenedAt >= runForMs) {
        // window elapsed → sleep (won't reopen until another full idle stretch).
        return { desired: 'off', self: { ...self, desired: 'off', windowOpenedAt: 0 } };
      }
      return { desired: 'running', self: { ...self, desired: 'running' } };
    }
    // not active → open a window once conversation has been idle long enough.
    const idleFor = world.lastConversationMs === 0 ? Infinity : world.now - world.lastConversationMs;
    if (idleFor >= activateAfterMs) {
      return { desired: 'running', self: { ...self, desired: 'running', windowOpenedAt: world.now } };
    }
    return { desired: 'off', self: { ...self, desired: 'off' } };
  },
};

// ── wakeUp — always-on "hey orbit" (conversation behaviour, no body, in-process) ────────────
export const wakeUpBehaviour: Behaviour = {
  name: 'wakeUp', kind: 'inproc',
  defaults: { enabled: true, phrase: 'hey orbit', prompt: 'did you call me?' },
  decide(t, _world, self) {
    const desired: Desired = bool(t.enabled, true) ? 'running' : 'off';
    return { desired, self: { ...self, desired } };
  },
};

/** Read a behaviour's wakeUp tunings as a typed config (for the inproc effect). */
export function wakeTunings(t: Tunings): { enabled: boolean; phrase: string; prompt: string } {
  return { enabled: bool(t.enabled, true), phrase: str(t.phrase, 'hey orbit'), prompt: str(t.prompt, 'did you call me?') };
}

/** The v1 behaviour registry (fixed set; pluggable loading is a later generalization). */
export const BEHAVIOURS: Behaviour[] = [faceFollowBehaviour, wakeUpBehaviour];

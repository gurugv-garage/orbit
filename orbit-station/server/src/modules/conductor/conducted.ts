/**
 * The CONDUCTED things + the pure decision logic for the per-dock CONDUCTOR
 * (docs/decision-traces/conductor-v1-design.md). PURE + time-injectable so the whole
 * conducting policy is unit-testable without a station, supervisor, or clock.
 *
 * The vocabulary (locked):
 *   • CONDUCTOR — one per dock. The cheap rules+tunings loop that GOVERNS lifecycle + config
 *     of the things below. It is NOT itself a "behaviour".
 *   • BEHAVIOUR (kind:'behaviour') — reaction logic HARDCODED into the right code path at
 *     design time; the conductor only enables/disables/tunes it (wakeUp → the wake-phrase
 *     check woven into the brain's transcript handler; see brain/index.ts matchesWake +
 *     onAddressedFinal, brain/session.ts wake()). No process — it runs where it's instrumented.
 *   • TASK (kind:'task') — a generic SPAWNABLE process the conductor starts/stops (faceFollow
 *     → the `face-follow` task, lease-arbitrated). Runs however it runs.
 *
 * `decide(tunings, world, self) → 'off' | 'running'` is the only conducted-thing-specific
 * logic — arithmetic / rules over the tunings + cheap world reads + its own carried state.
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

/** Per-item state the conductor carries between ticks (so `decide` stays pure — it's handed
 *  the state and returns the next one alongside its decision). */
export interface ConductedState {
  desired: Desired;              // last decision (for transition logging)
  /** for windowed items (faceFollow): epoch the current ACTIVE window opened, 0 = not active. */
  windowOpenedAt: number;
}

export const initConductedState = (): ConductedState => ({ desired: 'off', windowOpenedAt: 0 });

/** Tunings — a free bag of knobs from config (validated per-item in decide). */
export type Tunings = Record<string, unknown>;

/** A thing the conductor conducts: a BEHAVIOUR (hardcoded-in-place reaction) or a TASK
 *  (spawnable process). `kind` selects how the conductor ENACTS a 'running' decision. */
export interface Conducted {
  name: string;
  kind: 'behaviour' | 'task';
  /** for kind:'task' — the task definition name + lease priority it runs at. */
  taskName?: string;
  priority?: number;
  /** for kind:'behaviour' — a human note on WHERE in the code it's instrumented (shown in the
   *  console so the hardcoded reaction is discoverable). */
  instrumentedAt?: string;
  /** decide: pure. Returns the desired state + the (possibly updated) carried state. */
  decide(t: Tunings, world: World, self: ConductedState): { desired: Desired; self: ConductedState };
  /** config defaults (also the documented knobs). */
  defaults: Tunings;
}

const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const bool = (v: unknown, d: boolean) => (typeof v === 'boolean' ? v : d);
const str = (v: unknown, d: string) => (typeof v === 'string' && v ? v : d);

// ── faceFollow — a TASK: a periodic "look around" window (drives the body) ──────────────────
// Idle = NO conversation (no active turn, not listening). After `activateAfterMs` of idle →
// open a window (running) for up to `runForMs`, then sleep until another idle stretch. Never
// runs during a conversation.
export const faceFollow: Conducted = {
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

// ── wakeUp — a BEHAVIOUR: always-on "hey orbit" (hardcoded in the brain, no process) ─────────
export const wakeUp: Conducted = {
  name: 'wakeUp', kind: 'behaviour',
  instrumentedAt: 'brain/index.ts: matchesWake() in onAddressedFinal → session.wake()',
  defaults: { enabled: true, phrase: 'hey orbit', prompt: 'did you call me?', aliases: '' },
  decide(t, _world, self) {
    const desired: Desired = bool(t.enabled, true) ? 'running' : 'off';
    return { desired, self: { ...self, desired } };
  },
};

/** Read wakeUp's tunings as a typed config (for the behaviour-enable effect). `aliases` is a
 *  human-friendly comma/space-separated string in the console ("albert, robert or bit") that we
 *  split into the extra accepted name renderings; blank → none. */
export function wakeTunings(t: Tunings): { enabled: boolean; phrase: string; prompt: string; aliases: string[] } {
  const aliases = str(t.aliases, '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  return { enabled: bool(t.enabled, true), phrase: str(t.phrase, 'hey orbit'), prompt: str(t.prompt, 'did you call me?'), aliases };
}

/** The v1 conducted set (fixed; pluggable loading is a later generalization). */
export const CONDUCTED: Conducted[] = [faceFollow, wakeUp];

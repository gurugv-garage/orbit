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
  /** the servo component is online right now — a BODY task must not run without it
   *  (starting one anyway = a silent crash-restart churn loop, one spawn per tick). */
  bodyOnline: boolean;
  tasks: Array<{ name: string; instanceId: string; initiator: 'user' | 'brain' | 'self'; ageMs: number }>;
}

/** Per-item state the conductor carries between ticks (so `decide` stays pure — it's handed
 *  the state and returns the next one alongside its decision). */
export interface ConductedState {
  desired: Desired;              // last decision (for transition logging)
  /** for windowed items (faceFollow): epoch the current ACTIVE window opened, 0 = not active. */
  windowOpenedAt: number;
  /** faceFollow: after a window closes with NOBODY seen, don't re-scan until this epoch
   *  (presence bypasses it) — an empty room gets a brief scan every rescanCooldownMs, not
   *  a forever-sweep (the attention-director v1 change, 2026-07-05). 0/absent = no cooldown. */
  cooldownUntil?: number;
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
  /** config defaults (also the documented knobs). Reconcile merges these UNDER the live
   *  config before handing tunings anywhere — this is the single source of truth for a
   *  knob's default (task manifests may mirror them only as a manual-run fallback). */
  defaults: Tunings;
  /** optional normalization of the merged tunings before they're enacted (e.g. wakeUp
   *  splits its comma-separated aliases string) — keeps reconcile name-agnostic. */
  prepareTunings?: (t: Tunings) => Tunings;
}

const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const bool = (v: unknown, d: boolean) => (typeof v === 'boolean' ? v : d);
const str = (v: unknown, d: string) => (typeof v === 'string' && v ? v : d);

// ── faceFollow — a TASK: presence-aware attention (drives the body) ─────────────────────────
// The attention-director v1 rule (2026-07-05, replaces the blind periodic window): TRACK
// while someone is around; when NOBODY has been seen for `idleNoFaceMs`, close the window
// and go STILL (an empty room must not get a forever-sweeping scanner — servo wear + the
// "surveillance" read); re-scan briefly every `rescanCooldownMs`; the moment a face appears
// (world.present), reopen IMMEDIATELY regardless of cooldown. Never during a conversation.
// Mood-modulated eagerness (bored → lazy glances) is the deferred director v2.
export const faceFollow: Conducted = {
  name: 'faceFollow', kind: 'task', taskName: 'face-follow', priority: 30,
  defaults: {
    enabled: true, activateAfterMs: 300_000, runForMs: 900_000,
    idleNoFaceMs: 180_000, rescanCooldownMs: 900_000,
  },
  decide(t, world, self) {
    const enabled = bool(t.enabled, true);
    const activateAfterMs = num(t.activateAfterMs, 300_000);
    const runForMs = num(t.runForMs, 900_000);
    const idleNoFaceMs = num(t.idleNoFaceMs, 180_000);
    const rescanCooldownMs = num(t.rescanCooldownMs, 900_000);
    // disabled, body offline, or a conversation live → off (and close any window; no
    // cooldown — tracking should resume the moment the blocker clears). The body check
    // stops the silent crash-respawn churn a servo task hits on an offline body.
    if (!enabled || !world.bodyOnline || world.turnActive || world.listening) {
      return { desired: 'off', self: { ...self, desired: 'off', windowOpenedAt: 0, cooldownUntil: 0 } };
    }
    // currently in an active window?
    if (self.windowOpenedAt > 0) {
      // nobody seen for idleNoFaceMs (measured from the last sighting, or the window
      // open if nobody was EVER seen) → close early + arm the re-scan cooldown.
      const sinceFace = world.lastPresenceMs > 0
        ? world.now - world.lastPresenceMs
        : world.now - self.windowOpenedAt;
      if (!world.present && sinceFace >= idleNoFaceMs) {
        return { desired: 'off', self: { ...self, desired: 'off', windowOpenedAt: 0, cooldownUntil: world.now + rescanCooldownMs } };
      }
      if (world.now - self.windowOpenedAt >= runForMs) {
        // window elapsed → sleep (same cooldown so an occupied room resumes on presence).
        return { desired: 'off', self: { ...self, desired: 'off', windowOpenedAt: 0, cooldownUntil: world.now + rescanCooldownMs } };
      }
      return { desired: 'running', self: { ...self, desired: 'running' } };
    }
    // not active → open once conversation-idle long enough AND (someone is visible now,
    // OR the re-scan cooldown has elapsed — the periodic brief look-around).
    const idleFor = world.lastConversationMs === 0 ? Infinity : world.now - world.lastConversationMs;
    if (idleFor >= activateAfterMs && (world.present || world.now >= (self.cooldownUntil ?? 0))) {
      return { desired: 'running', self: { ...self, desired: 'running', windowOpenedAt: world.now, cooldownUntil: 0 } };
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
  prepareTunings: (t) => wakeTunings(t),
};

/** Read wakeUp's tunings as a typed config (for the behaviour-enable effect). `aliases` is a
 *  human-friendly comma/space-separated string in the console ("albert, robert or bit") that we
 *  split into the extra accepted name renderings; blank → none. */
export function wakeTunings(t: Tunings): { enabled: boolean; phrase: string; prompt: string; aliases: string[] } {
  const aliases = str(t.aliases, '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  return { enabled: bool(t.enabled, true), phrase: str(t.phrase, 'hey orbit'), prompt: str(t.prompt, 'did you call me?'), aliases };
}

// ── moods — a TASK: the dock's idle personality (bored/curious/attention/sleepy/flavor bits) ─
// The conductor only decides WHEN it may run: conversation idle ≥ activateAfterMs, never
// during a conversation. WHICH mood plays (presence, quiet hours, speak gate, weights) is the
// idle-moods task's own pure picker — capability work stays in the task (vision doc §4). The
// tunings below ride to the task as its params (snapshot at start). Body contention with
// faceFollow is the LEASE's job: a bit briefly holds at 35 over faceFollow's 30.
export const moods: Conducted = {
  name: 'moods', kind: 'task', taskName: 'idle-moods', priority: 35,
  defaults: {
    enabled: true, activateAfterMs: 300_000,
    // creatures are mostly still — a bit every 3–8 min (3× sparser in quiet hours), speech
    // at most hourly (2026-07-05 lived-with critique: 45–120 s read as a scanner).
    bitMinMs: 180_000, bitMaxMs: 480_000,
    speakMinGapMs: 3_600_000, speakIdleMinMs: 600_000,
    quietStartHour: 22, quietEndHour: 7, attentionAfterMs: 180_000,
    wBored: 1, wCurious: 1, wAttention: 0.5, wSleepy: 1, wFlavor: 0.08,
  },
  decide(t, world, self) {
    const enabled = bool(t.enabled, true);
    if (!enabled || world.turnActive || world.listening) {
      return { desired: 'off', self: { ...self, desired: 'off' } };
    }
    const idleFor = world.lastConversationMs === 0 ? Infinity : world.now - world.lastConversationMs;
    const desired: Desired = idleFor >= num(t.activateAfterMs, 300_000) ? 'running' : 'off';
    return { desired, self: { ...self, desired } };
  },
};

/** The v1 conducted set (fixed; pluggable loading is a later generalization). */
export const CONDUCTED: Conducted[] = [faceFollow, wakeUp, moods];

/**
 * MotionExecutor — the body's single master (docs/decision-traces/server-brain-impl.md §3.2).
 *
 * The brain's `move`/gesture tools and the console both come through here, in
 * one process — the dual-master conflict (phone vs console) is gone by
 * construction. Commands go to the firmware as directed `set_target` frames
 * on the `bodylink` topic over its station socket (the BodyLink contract —
 * per-part idempotency, clamping, hold-pose-on-disconnect — re-hosted from
 * the retired phone↔ESP32 link, see node-dock/bodylink/DESIGN.md banner).
 *
 *   runSteps(dock, steps)      timed choreography — returns its status string
 *                              IMMEDIATELY (fire-and-forget)
 *   runStepsAwaited(...)       same + a completion promise (the brain's `move`
 *                              tool awaits real servo travel — motion-speech-timing)
 *   playGesture(dock, expr)    faceGestures choreography for set_face — the
 *                              config-registry copy is the ONLY copy now
 *   stop(dock)                 cancel the running sequence (turn start / cancel)
 *
 * Reliability: an idempotent `set_target` heartbeat re-sends current targets
 * (1 Hz idle, 10 Hz within 500 ms of motion) — recovers lost frames and
 * re-converges the body after a power-cycle/reconnect for free. No motion
 * replay: a sequence interrupted by disconnect dies; the body holds pose.
 */

import type { Bus } from '../../core/bus.js';
import type { Directory } from '../docks/directory.js';
import { DEGREE_LIMITS, degreesToUs, stepJoints, type MoveStep, type MoveJoint } from '../brain/schemas.js';

/** Inverse of degreesToUs' universal scale (500µs=-90°, 1500µs=0°, 2500µs=+90°). Used to read
 *  the body's CURRENT angle so a relative delta can be added to it. Not clamped per-part — it's
 *  a raw scale read of where the joint actually is; the caller clamps the resulting target. */
function usToDegrees(us: number): number {
  return ((us - 1500) / 1000) * 90;
}
import { ActuatorLease, priorityForSource, type Lease, type LeaseOpts } from './lease.js';

const IDLE_HEARTBEAT_MS = 1_000;
const ACTIVE_HEARTBEAT_MS = 100;
const ACTIVE_WINDOW_MS = 500;
const DEFAULT_STEP_DURATION_MS = 400;

/**
 * Speed-based pacing (docs/decision-traces/server-brain-impl.md §3.2, turn-timing
 * revision). A move is time-driven at the wire (`duration_ms` = lerp time), but a
 * FIXED duration makes big sweeps whip: −90→+90 (2000µs) in 400ms is 6× the angular
 * speed of a 30° nudge (333µs) in the same 400ms. So when a step has NO explicit
 * `duration_ms`, we derive it from the TRAVEL DISTANCE so angular speed stays ~constant:
 * a small glance finishes sooner, a full sweep takes longer — both move at the same rate.
 * An explicit `duration_ms` from the brain/gesture author still wins (a snappy nod is
 * *meant* to be fast). The firmware velocity cap is the un-bypassable safety floor beneath
 * this; this layer is about natural feel.
 */
const DEFAULT_SPEED_US_PER_SEC = 1_500; // 1500µs/s → a full ±90° swing (2000µs) in ~1.3s. Tempered
                                        // down from 2000 — the faster envelope felt tippy on hardware.
const MIN_SCALED_DURATION_MS = 150; // floor: even a tiny move gets a perceptible, un-jittery ramp
const MAX_SCALED_DURATION_MS = 1_800; // ceiling: the biggest sweep still completes in ≤1.8s

/**
 * SETTLE GRACE for an explicit user move (source 'brain-turn'). A one-shot move mints a lease
 * hold this long — enough to outlast the biggest sweep (MAX_SCALED_DURATION_MS) PLUS a beat for
 * the pose to be SEEN — so a continuous follower (faceFollow @30) stays yielded until the
 * commanded pose has landed, then reclaims and resumes. Without this the follower's next tick
 * (~700ms) snaps the body back to the tracked face and the user's move looks like it did nothing.
 * Mirrors faceFollow's yield-on-preempt: it's the brain-move analogue of the follow cooldown.
 */
const BRAIN_MOVE_SETTLE_MS = MAX_SCALED_DURATION_MS + 1_500; // ≤1.8s travel + ~1.5s settle grace

/**
 * Velocity SAFETY CAP — must mirror the firmware's `velocity_us_per_sec_cap` spec
 * default (bodylink_motion.c). The firmware silently STRETCHES any transition whose
 * requested duration is too short for its travel; the station must apply the SAME
 * stretch so its sequence pacing (the pause before the next step) matches how long the
 * body actually takes to travel. Otherwise an explicit fast `duration_ms` fires the next
 * target before the body has moved — the leg gets preempted mid-ramp and you see a tiny
 * wiggle instead of the move. Smoothstep peak speed is 1.5× the linear average, so the
 * shortest legal duration for a given travel is 1.5·travel/cap.
 */
const VELOCITY_CAP_US_PER_SEC = 3_000; // hard peak-speed ceiling — must match the firmware spec
                                       // default. Tempered 4000→3000 so even snap beats stay planted.
const SMOOTHSTEP_PEAK_FACTOR = 1.5;

/**
 * COMFORTABLE-speed floor for EXPLICIT durations. The velocity cap above is the hard
 * safety limit (~4000µs/s); this is the softer "feels calm" rate (same as the auto-pace
 * speed) that an explicit `duration_ms` shouldn't casually beat. Console/brain gestures
 * were authored with ad-hoc fast durations before pacing existed; stretching anything
 * faster than comfortable brings them in line. A step MEANT to be snappy (a startle, a
 * dance beat) opts out with `snap: true` and is bounded only by the hard cap. Auto-paced
 * moves already run at exactly this speed, so this is a no-op for them.
 */
const COMFORTABLE_SPEED_US_PER_SEC = DEFAULT_SPEED_US_PER_SEC; // 2000µs/s ≈ 180°/s
/** the capability tag the servo-bearing component declares in hello. */
const SERVO_CAP = 'servo';

/** Who issued the last real motion command — so a standing behaviour (faceFollow) can tell
 *  when ANOTHER mover (a brain turn's gesture, the console, a different task) took the body,
 *  and yield + cool down. `tag` is a free-form source id: 'brain-turn', 'console',
 *  `task:<instanceId>`, or 'station'. The actuator-lease groundwork (facefollow decision
 *  trace) in its lightest form: observe who's driving, don't hard-lock. */
export interface Mover { tag: string; at: number }

/** A pose in DEGREES (neck = pitch/tilt, foot = pan/yaw). */
export interface BodyPoseDeg { neck: number; foot: number }

/** SOURCE-AUTHORED metadata attached to a body command — carried VERBATIM to the audit
 *  log. The executor never derives these; the caller (brain move tool, a task, the console)
 *  declares them. Open by design so callers can add fields (a `reason` for the move, the
 *  originating `bit`, etc.) without touching the executor or the log. The executor adds only
 *  what it alone owns (outcome, priority, base/target pose) — see BodyCmdSinkEntry. */
export interface BodyCmdMeta {
  /** did the source AUTHOR this as a delta (relative), vs an absolute target? */
  relative?: boolean;
  [k: string]: unknown;
}

/**
 * WHY the body moved — a REQUIRED argument on every executor entry point (runSteps,
 * runStepsAwaited, playGesture, setTargets). No command moves the body anonymously: the
 * caller must say why (the compiler enforces it at every call site). Free-form, but use a
 * stable `namespace:detail` shape so the audit log groups cleanly:
 *   'mood:curious.tilt' · 'follow:guru' · 'follow:searching' · 'face:happy' ·
 *   'move-tool' · 'search:red mug' · 'console:play' · 'console:slider' · 'lease-probe'
 */
export type BodyReason = string;

/** The body-command AUDIT sink — one entry per servo command, accepted OR rejected.
 *  main.ts bridges this to perception's bodycmd log; motion.ts stays decoupled from
 *  perception (it only knows this shape). base/target are ABSOLUTE degrees. */
export interface BodyCmdSinkEntry {
  dock: string;
  source: string;
  priority: number;
  outcome: 'accepted' | 'rejected-priority' | 'dropped-offline';
  blockedBy?: { holder: string; priority: number };
  // ── physical facts the EXECUTOR owns (authoritative — never source-supplied) ──
  base: BodyPoseDeg;
  target: BodyPoseDeg;
  durationMs?: number;
  // ── SOURCE-authored metadata, carried verbatim (relative?, reason?, …) ──
  meta: BodyCmdMeta;
}
export type BodyCmdSink = (e: BodyCmdSinkEntry) => void;

interface DockMotion {
  /** current per-part target (µs) — what the heartbeat re-sends. */
  targets: Record<string, number>;
  /** last time a real motion command was sent (drives heartbeat cadence). */
  lastMotionAt: number;
  lastHeartbeatAt: number;
  /** who last commanded a REAL move (not a heartbeat) + when. */
  lastMover?: Mover;
  /** the running sequence's cancel handle (one sequence per dock). */
  sequence?: { cancelled: boolean };
}

export class MotionExecutor {
  #bus: Bus;
  #directory: Directory;
  #docks = new Map<string, DockMotion>();
  #timer: NodeJS.Timeout;
  #lease: ActuatorLease;
  #cmdSink?: BodyCmdSink;
  #taskName?: (instanceId: string) => string | undefined;

  constructor(bus: Bus, directory: Directory, leaseOpts?: LeaseOpts) {
    this.#bus = bus;
    this.#directory = directory;
    this.#lease = new ActuatorLease({ log: (l) => console.log(l), ...leaseOpts });
    this.#timer = setInterval(() => this.#heartbeatSweep(), ACTIVE_HEARTBEAT_MS);
    this.#timer.unref?.();
  }

  /** Wire the body-command AUDIT sink (main.ts → perception's bodycmd log). Every servo
   *  command — accepted or rejected — is reported here. Optional: unset = no logging.
   *  `taskName` resolves a `task:<id>` source's instance id → its task name for the log. */
  setCmdSink(sink: BodyCmdSink, taskName?: (instanceId: string) => string | undefined): void {
    this.#cmdSink = sink;
    this.#taskName = taskName;
  }

  /** Enrich a `task:<id>` source with its task name → `task:<name>(<id>)` (e.g.
   *  `task:idle-moods(t-3602)`), so the log shows WHICH task moved the body. Other
   *  sources (brain-turn/console/…) pass through unchanged. */
  #labelSource(source: string): string {
    if (!source.startsWith('task:')) return source;
    const id = source.slice('task:'.length);
    const name = this.#taskName?.(id);
    return name ? `task:${name}(${id})` : source;
  }

  /** Current pose (degrees) for the log's base/target. Never-moved joint = 0° (1500µs). */
  #poseDeg(dock: string): BodyPoseDeg {
    const t = this.#docks.get(dock)?.targets ?? {};
    return { neck: usToDegrees(t.neck ?? 1500), foot: usToDegrees(t.foot ?? 1500) };
  }

  /** Report a REJECTED / dropped command to the audit sink (no pose change occurred). */
  #logReject(dock: string, source: string, outcome: 'rejected-priority' | 'dropped-offline', meta: BodyCmdMeta = {}): void {
    if (!this.#cmdSink) return;
    const base = this.#poseDeg(dock);
    this.#cmdSink({
      dock, source: this.#labelSource(source), priority: priorityForSource(source), outcome,
      blockedBy: outcome === 'rejected-priority' ? this.#lease.current(dock) : undefined,
      base, target: base, // rejected → body stayed where it was
      meta,
    });
  }

  /** EXPLICIT lease for a continuous body-holder (faceFollow): acquire at a priority, renew
   *  each tick, release when done; `onPreempt` fires if a higher priority takes the body.
   *  Returns null if a higher-priority holder currently owns it. The body's arbiter (§4 of
   *  the facefollow decision trace). Fire-and-forget callers don't need this — they go
   *  through the implicit admit() path inside runSteps/setTargets/playGesture. */
  acquire(dock: string, holder: string, priority: number, onPreempt?: () => void): Lease | null {
    return this.#lease.acquire(dock, holder, priority, onPreempt);
  }

  /** The current effective body-holder of a dock (after TTL expiry), for the console/debug. */
  bodyHolder(dock: string): { holder: string; priority: number } | undefined {
    return this.#lease.current(dock);
  }

  /** Release a hold by its holder tag (the task's `releaseBody`). No-op if not the holder. */
  releaseBody(dock: string, holder: string): void {
    this.#lease.releaseByHolder(dock, holder);
  }

  /** Is a servo-bearing component of this dock online? */
  isOnline(dock: string): boolean {
    return this.#directory.resolveCap(dock, SERVO_CAP) != null;
  }

  /**
   * Execute a `move` tool call: validate, clamp, dispatch the sequence
   * asynchronously, return the status string immediately. Throws when the
   * body is offline or the steps are unusable (pi turns throws into error
   * tool results — the model narrates, the turn continues).
   */
  runSteps(dock: string, steps: MoveStep[], reason: BodyReason, source = 'station', meta?: BodyCmdMeta): string {
    return this.runStepsAwaited(dock, steps, reason, source, meta).status;
  }

  /**
   * Same as runSteps, but also hands back the sequence's COMPLETION promise so
   * a caller can know when the body actually finished (the brain's move tool:
   * "did I shake it well?" must come after the shake, not during — see
   * docs/decision-traces/motion-speech-timing.md). `done` resolves when the
   * sequence finishes OR is cancelled/superseded; it never rejects. The
   * fire-and-forget contract stays the default for every other caller.
   */
  runStepsAwaited(dock: string, steps: MoveStep[], reason: BodyReason, source = 'station', meta?: BodyCmdMeta): { status: string; done: Promise<void> } {
    if (!this.isOnline(dock)) throw new Error(`the body of ${dock} is not responding (offline)`);
    if (!Array.isArray(steps) || steps.length === 0) throw new Error('move needs at least one step');
    // `reason` (required) + optional meta. If the source didn't say whether this was relative,
    // DERIVE it from the steps (an executor-known fact); everything else is carried verbatim.
    const anyRelative = steps.some((s) => s.relative || stepJoints(s).some((j) => j.relative));
    const cmdMeta: BodyCmdMeta = { relative: anyRelative, ...meta, reason };
    // LEASE: a higher-priority holder owns the body → this move can't run. THROW (like the
    // offline case) so the tool surfaces an ERROR result — the model then narrates that it
    // couldn't move, instead of the old success-shaped "body busy" string that made the brain
    // claim it moved when it didn't. Equal/higher admits (last-write-wins).
    //
    // A user's explicit move ('brain-turn') takes a SETTLE-length hold so a continuous
    // follower stays yielded until the commanded pose lands (see BRAIN_MOVE_SETTLE_MS);
    // other sources keep the default momentary TTL.
    const holdMs = source === 'brain-turn' ? BRAIN_MOVE_SETTLE_MS : undefined;
    if (!this.#lease.admit(dock, source, priorityForSource(source), holdMs)) {
      this.#logReject(dock, source, 'rejected-priority', cmdMeta);
      const h = this.#lease.current(dock);
      throw new Error(`can't move ${dock} right now — ${h?.holder ?? 'another holder'} has the body`);
    }
    // Resolve RELATIVE deltas → absolute degrees against the live pose, so everything downstream
    // (the saturation guard + #runSequence) works purely in absolutes. A relative step means
    // "from wherever the joint is NOW" — this is how "turn more/again" keeps moving without the
    // model tracking angles or guessing a sign (the flip-flop bug).
    const resolved = this.#resolveSteps(dock, steps);
    const described: string[] = [];
    let commandsAnyJoint = false;    // did the move ask for ANY joint motion (vs pure waits)?
    let anyTravel = false;          // will ANY commanded joint actually move from where it is?
    // Where each part will be by the end of the sequence, so a later step that re-commands the
    // same part is judged against the earlier step's target (not the body's start pose).
    const projected: Record<string, number> = { ...(this.#docks.get(dock)?.targets ?? {}) };
    for (const step of resolved) {
      const joints = stepJoints(step);
      for (const j of joints) {
        // degreesToUs CLAMPS to the joint's limit, so a request past the limit lands ON the
        // limit — if the joint is already there, this step is zero-travel (the "turn right
        // again" saturation case). Compare the clamped target to where the part will be.
        const targetUs = degreesToUs(j.part, j.degrees);
        if (projected[j.part] == null || projected[j.part] !== targetUs) anyTravel = true;
        projected[j.part] = targetUs;
      }
      if (joints.length === 0 && step.wait_ms == null) throw new Error('a step needs joints (part/parts) or a wait_ms');
      if (joints.length > 0) { commandsAnyJoint = true; described.push(joints.map((j) => `${j.part}→${Math.round(j.degrees)}°`).join('+')); }
    }
    // The move commands joints but NONE of them travel — the body is already there (typically at
    // a limit after "turn right", then "turn right" again). THROW so the model tells the user it
    // can't move further in that direction, instead of a phantom "moving" it never performs. A
    // pure wait (no joints) is exempt — a deliberate pause is a legitimate no-travel move.
    if (commandsAnyJoint && !anyTravel) {
      throw new Error(`already there — ${described.join(', ')} is where the body already is (can't move further that way)`);
    }
    const done = this.#runSequence(dock, resolved, source, cmdMeta);
    return { status: `moving: ${described.join(', ') || 'pausing'}`, done };
  }

  /**
   * Turn any RELATIVE joints into ABSOLUTE-degree steps by adding the delta to where the joint
   * is NOW (or will be after earlier steps in this same sequence). Validates part/degrees while
   * it's here (throws just like the old inline checks). Pure waits pass through untouched.
   * Returns a NEW step array — the input is not mutated (faceGestures config steps are shared).
   */
  #resolveSteps(dock: string, steps: MoveStep[]): MoveStep[] {
    // running pose in DEGREES so chained relative steps stack (right, then right again).
    const poseUs = { ...(this.#docks.get(dock)?.targets ?? {}) };
    const curDeg = (part: string): number => usToDegrees(poseUs[part] ?? 1500); // 1500µs = 0° = never-moved center
    const resolveJoint = (j: MoveJoint): MoveJoint => {
      if (!(j.part in DEGREE_LIMITS)) throw new Error(`unknown part "${j.part}"`);
      if (typeof j.degrees !== 'number' || Number.isNaN(j.degrees)) throw new Error(`bad degrees for ${j.part}`);
      const abs = j.relative ? curDeg(j.part) + j.degrees : j.degrees;
      poseUs[j.part] = degreesToUs(j.part, abs); // advance the running pose (clamped, as the body will land)
      return { part: j.part, degrees: abs };     // drop `relative` — now absolute
    };
    return steps.map((step) => {
      const joints = stepJoints(step);
      if (joints.length === 0) return step; // pure wait — untouched
      const resolvedJoints = joints.map(resolveJoint);
      // preserve step-level fields; emit as `parts` so a resolved single-joint step is uniform.
      return { parts: resolvedJoints, duration_ms: step.duration_ms, wait_ms: step.wait_ms, snap: step.snap };
    });
  }

  /**
   * Play the body choreography for a face expression (the set_face fan-out).
   * Gestures come from the faceGestures config — the single copy. Unknown
   * expression or offline body is a silent no-op (the face still changes on
   * the phone; emotion choreography is best-effort by design).
   *
   * Gesture degrees are OFFSETS from the pose the body is in when the gesture
   * starts — a mood is a wiggle AROUND the current gaze, never a teleport.
   * (Found live, turn-1d02dd98: visual_search centered on Guru at −86°, then
   * the "Found you!" happy gesture — authored around 0 — swung the gaze back
   * to center, undoing the find.) Offsets clamp at joint limits per-step from
   * a FIXED base, so repeated gestures can't drift.
   */
  playGesture(dock: string, expression: string, gestures: Record<string, MoveStep[]>, reason: BodyReason, source = 'brain-turn', meta?: BodyCmdMeta): void {
    const steps = gestures[expression];
    if (!steps || steps.length === 0 || !this.isOnline(dock)) return;
    // A gesture is authored as OFFSETS around the current gaze (relative in spirit). `reason`
    // (required) says WHY it's playing (e.g. 'face:happy', 'mood:attention.perk').
    const cmdMeta: BodyCmdMeta = { relative: true, ...meta, reason };
    if (!this.#lease.admit(dock, source, priorityForSource(source))) { this.#logReject(dock, source, 'rejected-priority', cmdMeta); return; } // a higher holder owns the body
    const base = this.#docks.get(dock)?.targets ?? {};
    const baseDeg = (part: string) => usToDegrees(base[part] ?? 1500);
    const rebased = steps.map((step) => {
      const joints = stepJoints(step);
      if (joints.length === 0) return step; // pure wait
      return {
        parts: joints.map((j) => ({ part: j.part, degrees: baseDeg(j.part) + j.degrees })),
        duration_ms: step.duration_ms, wait_ms: step.wait_ms, snap: step.snap,
      };
    });
    void this.#runSequence(dock, rebased, source, cmdMeta);
  }

  /** Cancel the running sequence (new turn / turn-cancel / dock offline). */
  stop(dock: string): void {
    const m = this.#docks.get(dock);
    if (m?.sequence) m.sequence.cancelled = true;
  }

  /** current targets (tests + console). */
  targets(dock: string): Record<string, number> {
    return { ...(this.#docks.get(dock)?.targets ?? {}) };
  }

  /** Who last commanded a REAL move on this dock (+ when), or undefined if none yet. A
   *  standing behaviour reads this to detect a foreign mover and yield. */
  lastMover(dock: string): Mover | undefined {
    return this.#docks.get(dock)?.lastMover;
  }

  /** Did the body move within the last `withinMs`? The camera-motion signal perception
   *  needs (the bodymotion snapshot stream never gets faceFollow's pans — no ego-motion
   *  loop-closure there). Used to tell "the WORLD changed" from "I panned my own head":
   *  a change-gate trigger while recently-moved is likely self-motion, same scene. The
   *  window should cover a move + settle (a step is ~500ms). */
  recentlyMoved(dock: string, withinMs = 1200): boolean {
    const at = this.#docks.get(dock)?.lastMotionAt ?? 0;
    return at > 0 && Date.now() - at < withinMs;
  }

  /** A short human-readable CURRENT pose for the brain's grounding (facing + angles), so it can
   *  reason about "turn more" absolutely if it wants and knows where "again" starts from. Reads
   *  the last commanded targets; a never-moved joint reports its neutral (0°). Returns undefined
   *  if the body has no targets yet AND is offline (nothing meaningful to say). */
  pose(dock: string): string | undefined {
    const t = this.#docks.get(dock)?.targets ?? {};
    const footDeg = Math.round(usToDegrees(t.foot ?? 1500));
    const neckDeg = Math.round(usToDegrees(t.neck ?? 1500));
    // foot: negative = right, positive = left (matches the schema labels).
    const facing = footDeg === 0 ? 'facing forward'
      : `facing ${Math.abs(footDeg)}° to the ${footDeg < 0 ? 'right' : 'left'}`;
    const tilt = neckDeg === 0 ? 'head level'
      : `head tilted ${Math.abs(neckDeg)}° ${neckDeg < 0 ? 'up' : 'down'}`;
    return `${facing}, ${tilt} (foot ${footDeg}°, neck ${neckDeg}°)`;
  }

  /** Direct single set_target (the console's slider path) — same master. Absolute targets. */
  setTargets(dock: string, partsUs: Record<string, number>, reason: BodyReason, durationMs = DEFAULT_STEP_DURATION_MS, source = 'console', meta?: BodyCmdMeta): void {
    const cmdMeta: BodyCmdMeta = { relative: false, ...meta, reason }; // a slider sets an absolute target
    if (!this.#lease.admit(dock, source, priorityForSource(source))) { this.#logReject(dock, source, 'rejected-priority', cmdMeta); return; } // a higher holder owns the body
    this.stop(dock); // a manual command supersedes a running sequence (last write wins)
    this.#send(dock, partsUs, durationMs, source, cmdMeta);
  }

  shutdown(): void {
    clearInterval(this.#timer);
  }

  async #runSequence(dock: string, steps: MoveStep[], source = 'station', meta: BodyCmdMeta = {}): Promise<void> {
    const m = this.#dock(dock);
    // one sequence per dock: starting a new one cancels the previous
    // (last-write-wins, logged — corner case 20).
    if (m.sequence) {
      m.sequence.cancelled = true;
      console.log(`[motion] ${dock}: new sequence supersedes the running one`);
    }
    const seq = { cancelled: false };
    m.sequence = seq;
    for (const step of steps) {
      if (seq.cancelled) return;
      const joints = stepJoints(step);
      if (joints.length > 0) {
        const partsUs: Record<string, number> = {};
        for (const j of joints) partsUs[j.part] = degreesToUs(j.part, j.degrees);
        // Explicit duration wins (authored gesture beats); otherwise derive it from the
        // FARTHEST-travelling joint in this step so every joint moves at ~the same speed
        // and arrives together — none whips (#scaledDuration handles the min/max clamp).
        const requested = step.duration_ms ?? this.#scaledDuration(dock, partsUs);
        // Apply the comfortable-speed floor (unless the step opts out with `snap`), then
        // the firmware velocity cap. Mirroring the firmware's stretch here keeps our pause
        // matched to the body's ACTUAL travel time so the next step doesn't preempt this
        // one mid-ramp (else a fast full sweep collapses to a wiggle).
        const duration = this.#effectiveDuration(dock, partsUs, requested, step.snap === true);
        this.#send(dock, partsUs, duration, source, meta);
        const pause = duration + (step.wait_ms ?? 0);
        if (pause > 0) await sleep(pause);
      } else {
        // wait-only step: no motion, just the pause.
        const pause = step.wait_ms ?? 0;
        if (pause > 0) await sleep(pause);
      }
    }
    if (m.sequence === seq) m.sequence = undefined;
  }

  /**
   * Duration (ms) for a move at the default angular speed, based on the FARTHEST
   * joint's travel from where it is now to its new target. Constant speed → a big
   * sweep takes longer, a small nudge finishes sooner; both feel the same rate.
   * Travel is measured from the last commanded target (what the body is at or
   * heading to); if a part has never moved, we measure from mechanical center
   * (1500µs) so the very first move is still paced. Clamped to [MIN, MAX].
   */
  #scaledDuration(dock: string, targetsUs: Record<string, number>, from?: Record<string, number>): number {
    const current = from ?? this.#docks.get(dock)?.targets ?? {};
    let maxTravel = 0;
    for (const [part, us] of Object.entries(targetsUs)) {
      maxTravel = Math.max(maxTravel, Math.abs(us - (current[part] ?? 1500)));
    }
    if (maxTravel === 0) return MIN_SCALED_DURATION_MS; // no travel (idempotent re-target)
    const ms = (maxTravel / DEFAULT_SPEED_US_PER_SEC) * 1000;
    return Math.round(Math.min(Math.max(ms, MIN_SCALED_DURATION_MS), MAX_SCALED_DURATION_MS));
  }

  /**
   * The duration the BODY will actually take, given the velocity cap the firmware
   * enforces. If `requested` is too short for the farthest joint's travel, stretch it to
   * the cap-minimum (1.5·travel/cap for smoothstep). Mirrors the firmware exactly so the
   * station's pause between steps equals the body's real travel time. Auto-paced moves
   * (#scaledDuration) are already under the cap, so this is a no-op for them; it only
   * bites an explicit fast `duration_ms`.
   */
  #effectiveDuration(dock: string, targetsUs: Record<string, number>, requested: number, snap = false, from?: Record<string, number>): number {
    const current = from ?? this.#docks.get(dock)?.targets ?? {};
    let maxTravel = 0;
    for (const [part, us] of Object.entries(targetsUs)) {
      maxTravel = Math.max(maxTravel, Math.abs(us - (current[part] ?? 1500)));
    }
    if (maxTravel === 0) return requested;
    // Soft comfortable floor (skipped for a `snap` beat): don't let an explicit duration
    // run faster than the comfortable rate. Then the HARD firmware cap, always enforced.
    const comfortMin = snap ? 0 : Math.ceil((maxTravel / COMFORTABLE_SPEED_US_PER_SEC) * 1000);
    const capMin = Math.ceil((SMOOTHSTEP_PEAK_FACTOR * maxTravel) / VELOCITY_CAP_US_PER_SEC * 1000);
    return Math.max(requested, comfortMin, capMin);
  }

  /**
   * The wall-clock ms #runSequence will actually take to play `steps` starting from the
   * CURRENT pose — the same per-step pacing (#scaledDuration for unauthored durations,
   * then the #effectiveDuration comfort/velocity stretch) plus waits, measured against a
   * ROLLING pose so chained steps are judged from the previous step's target. For callers
   * that must HOLD the body lease through a fire-and-forget sequence (the task `gesture`
   * capability): authored durations on fast gestures under-count real travel time by 2×+,
   * which released the body mid-choreography (found in review 2026-07-05).
   */
  estimateSequenceMs(dock: string, steps: MoveStep[]): number {
    const pose = { ...(this.#docks.get(dock)?.targets ?? {}) };
    let total = 0;
    for (const step of steps) {
      const joints = stepJoints(step);
      if (joints.length > 0) {
        const partsUs: Record<string, number> = {};
        for (const j of joints) partsUs[j.part] = degreesToUs(j.part, j.degrees);
        const requested = step.duration_ms ?? this.#scaledDuration(dock, partsUs, pose);
        total += this.#effectiveDuration(dock, partsUs, requested, step.snap === true, pose);
        Object.assign(pose, partsUs);
      }
      total += step.wait_ms ?? 0;
    }
    return total;
  }

  /** Publish one set_target (directed to the servo component) + record targets + mover. */
  #send(dock: string, partsUs: Record<string, number>, durationMs: number, source = 'station', meta: BodyCmdMeta = {}): void {
    const target = this.#directory.resolveCap(dock, SERVO_CAP);
    if (!target?.component) { this.#logReject(dock, source, 'dropped-offline', meta); return; } // offline — body holds pose
    const m = this.#dock(dock);
    const base = this.#poseDeg(dock); // where the body is BEFORE this step (the pose it applies ON)
    Object.assign(m.targets, partsUs);
    m.lastMotionAt = Date.now();
    m.lastMover = { tag: source, at: m.lastMotionAt }; // who's driving (faceFollow yield signal)
    this.#publishSetTarget(dock, target.component, m.targets, durationMs);
    // AUDIT: one 'accepted' bodycmd per step (raw wire truth — an abandoned mid-bit shows
    // the last step that fired and the missing home step). base = pre-step pose, target =
    // the resulting pose (post Object.assign).
    this.#cmdSink?.({
      dock, source: this.#labelSource(source), priority: priorityForSource(source), outcome: 'accepted',
      base, target: this.#poseDeg(dock), durationMs, meta,
    });
  }

  #publishSetTarget(dock: string, component: string, targets: Record<string, number>, durationMs: number): void {
    const parts: Record<string, Record<string, number>> = {};
    for (const [part, us] of Object.entries(targets)) {
      parts[part] = { pulse_width_us: us, duration_ms: durationMs };
    }
    this.#bus.publish({
      topic: 'bodylink', kind: 'command', payload: { parts },
      source: 'station', toAddr: { dock, component },
    });
    const m = this.#dock(dock);
    m.lastHeartbeatAt = Date.now();
  }

  /** Idempotent re-send of current targets: 10 Hz near motion, 1 Hz idle.
   *  The firmware is per-part idempotent, so an unchanged resend is a free
   *  liveness/recovery signal (BodyLink §3.2 semantics, station-side now). */
  #heartbeatSweep(): void {
    const now = Date.now();
    for (const [dock, m] of this.#docks) {
      if (Object.keys(m.targets).length === 0) continue;
      const active = now - m.lastMotionAt < ACTIVE_WINDOW_MS;
      const interval = active ? ACTIVE_HEARTBEAT_MS : IDLE_HEARTBEAT_MS;
      if (now - m.lastHeartbeatAt < interval) continue;
      const target = this.#directory.resolveCap(dock, SERVO_CAP);
      if (!target?.component) continue; // offline: nothing to send; reconnect re-converges
      this.#publishSetTarget(dock, target.component, m.targets, DEFAULT_STEP_DURATION_MS);
    }
  }

  #dock(dock: string): DockMotion {
    let m = this.#docks.get(dock);
    if (!m) {
      m = { targets: {}, lastMotionAt: 0, lastHeartbeatAt: 0 };
      this.#docks.set(dock, m);
    }
    return m;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Convert a faceGestures config value (degree steps, same vocabulary as the
 *  move tool — see config registry) into MoveSteps. It already IS the move
 *  vocabulary; this just types it. */
export function gesturesFromConfig(value: unknown): Record<string, MoveStep[]> {
  if (value == null || typeof value !== 'object') return {};
  return value as Record<string, MoveStep[]>;
}

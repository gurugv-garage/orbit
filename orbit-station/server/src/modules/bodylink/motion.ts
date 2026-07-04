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
 *   runSteps(dock, steps)      timed choreography (the `move` tool) — returns
 *                              its status string IMMEDIATELY (fire-and-forget;
 *                              the loop never waits on servo travel)
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
import { DEGREE_LIMITS, degreesToUs, stepJoints, type MoveStep } from '../brain/schemas.js';
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

  constructor(bus: Bus, directory: Directory, leaseOpts?: LeaseOpts) {
    this.#bus = bus;
    this.#directory = directory;
    this.#lease = new ActuatorLease({ log: (l) => console.log(l), ...leaseOpts });
    this.#timer = setInterval(() => this.#heartbeatSweep(), ACTIVE_HEARTBEAT_MS);
    this.#timer.unref?.();
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
  runSteps(dock: string, steps: MoveStep[], source = 'station'): string {
    if (!this.isOnline(dock)) throw new Error(`the body of ${dock} is not responding (offline)`);
    if (!Array.isArray(steps) || steps.length === 0) throw new Error('move needs at least one step');
    // LEASE: a higher-priority holder owns the body → this move is declined (not an error —
    // the caller simply doesn't get the body right now). Equal/higher admits (last-write-wins).
    if (!this.#lease.admit(dock, source, priorityForSource(source))) {
      const h = this.#lease.current(dock);
      return `body busy: ${h?.holder ?? 'another holder'} has it`;
    }
    const described: string[] = [];
    for (const step of steps) {
      const joints = stepJoints(step);
      for (const j of joints) {
        if (!(j.part in DEGREE_LIMITS)) throw new Error(`unknown part "${j.part}"`);
        if (typeof j.degrees !== 'number' || Number.isNaN(j.degrees)) throw new Error(`bad degrees for ${j.part}`);
      }
      if (joints.length === 0 && step.wait_ms == null) throw new Error('a step needs joints (part/parts) or a wait_ms');
      if (joints.length > 0) described.push(joints.map((j) => `${j.part}→${Math.round(j.degrees)}°`).join('+'));
    }
    void this.#runSequence(dock, steps, source);
    return `moving: ${described.join(', ') || 'pausing'}`;
  }

  /**
   * Play the body choreography for a face expression (the set_face fan-out).
   * Gestures come from the faceGestures config — the single copy. Unknown
   * expression or offline body is a silent no-op (the face still changes on
   * the phone; emotion choreography is best-effort by design).
   */
  playGesture(dock: string, expression: string, gestures: Record<string, MoveStep[]>, source = 'brain-turn'): void {
    const steps = gestures[expression];
    if (!steps || steps.length === 0 || !this.isOnline(dock)) return;
    if (!this.#lease.admit(dock, source, priorityForSource(source))) return; // a higher holder owns the body
    void this.#runSequence(dock, steps, source);
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

  /** Direct single set_target (the console's slider path) — same master. */
  setTargets(dock: string, partsUs: Record<string, number>, durationMs = DEFAULT_STEP_DURATION_MS, source = 'console'): void {
    if (!this.#lease.admit(dock, source, priorityForSource(source))) return; // a higher holder owns the body
    this.stop(dock); // a manual command supersedes a running sequence (last write wins)
    this.#send(dock, partsUs, durationMs, source);
  }

  shutdown(): void {
    clearInterval(this.#timer);
  }

  async #runSequence(dock: string, steps: MoveStep[], source = 'station'): Promise<void> {
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
        this.#send(dock, partsUs, duration, source);
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
  #scaledDuration(dock: string, targetsUs: Record<string, number>): number {
    const current = this.#docks.get(dock)?.targets ?? {};
    let maxTravel = 0;
    for (const [part, us] of Object.entries(targetsUs)) {
      const from = current[part] ?? 1500;
      maxTravel = Math.max(maxTravel, Math.abs(us - from));
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
  #effectiveDuration(dock: string, targetsUs: Record<string, number>, requested: number, snap = false): number {
    const current = this.#docks.get(dock)?.targets ?? {};
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

  /** Publish one set_target (directed to the servo component) + record targets + mover. */
  #send(dock: string, partsUs: Record<string, number>, durationMs: number, source = 'station'): void {
    const target = this.#directory.resolveCap(dock, SERVO_CAP);
    if (!target?.component) return; // went offline mid-sequence — body holds pose
    const m = this.#dock(dock);
    Object.assign(m.targets, partsUs);
    m.lastMotionAt = Date.now();
    m.lastMover = { tag: source, at: m.lastMotionAt }; // who's driving (faceFollow yield signal)
    this.#publishSetTarget(dock, target.component, m.targets, durationMs);
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

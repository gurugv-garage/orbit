/**
 * MotionExecutor — the body's single master (docs/SERVER-BRAIN-IMPL.md §3.2).
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

const IDLE_HEARTBEAT_MS = 1_000;
const ACTIVE_HEARTBEAT_MS = 100;
const ACTIVE_WINDOW_MS = 500;
const DEFAULT_STEP_DURATION_MS = 400;
/** the capability tag the servo-bearing component declares in hello. */
const SERVO_CAP = 'servo';

interface DockMotion {
  /** current per-part target (µs) — what the heartbeat re-sends. */
  targets: Record<string, number>;
  /** last time a real motion command was sent (drives heartbeat cadence). */
  lastMotionAt: number;
  lastHeartbeatAt: number;
  /** the running sequence's cancel handle (one sequence per dock). */
  sequence?: { cancelled: boolean };
}

export class MotionExecutor {
  #bus: Bus;
  #directory: Directory;
  #docks = new Map<string, DockMotion>();
  #timer: NodeJS.Timeout;

  constructor(bus: Bus, directory: Directory) {
    this.#bus = bus;
    this.#directory = directory;
    this.#timer = setInterval(() => this.#heartbeatSweep(), ACTIVE_HEARTBEAT_MS);
    this.#timer.unref?.();
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
  runSteps(dock: string, steps: MoveStep[]): string {
    if (!this.isOnline(dock)) throw new Error(`the body of ${dock} is not responding (offline)`);
    if (!Array.isArray(steps) || steps.length === 0) throw new Error('move needs at least one step');
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
    void this.#runSequence(dock, steps);
    return `moving: ${described.join(', ') || 'pausing'}`;
  }

  /**
   * Play the body choreography for a face expression (the set_face fan-out).
   * Gestures come from the faceGestures config — the single copy. Unknown
   * expression or offline body is a silent no-op (the face still changes on
   * the phone; emotion choreography is best-effort by design).
   */
  playGesture(dock: string, expression: string, gestures: Record<string, MoveStep[]>): void {
    const steps = gestures[expression];
    if (!steps || steps.length === 0 || !this.isOnline(dock)) return;
    void this.#runSequence(dock, steps);
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

  /** Direct single set_target (the console's slider path) — same master. */
  setTargets(dock: string, partsUs: Record<string, number>, durationMs = DEFAULT_STEP_DURATION_MS): void {
    this.stop(dock); // a manual command supersedes a running sequence (last write wins)
    this.#send(dock, partsUs, durationMs);
  }

  shutdown(): void {
    clearInterval(this.#timer);
  }

  async #runSequence(dock: string, steps: MoveStep[]): Promise<void> {
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
      const duration = step.duration_ms ?? (joints.length > 0 ? DEFAULT_STEP_DURATION_MS : 0);
      if (joints.length > 0) {
        const partsUs: Record<string, number> = {};
        for (const j of joints) partsUs[j.part] = degreesToUs(j.part, j.degrees);
        this.#send(dock, partsUs, duration);
      }
      const pause = duration + (step.wait_ms ?? 0);
      if (pause > 0) await sleep(pause);
    }
    if (m.sequence === seq) m.sequence = undefined;
  }

  /** Publish one set_target (directed to the servo component) + record targets. */
  #send(dock: string, partsUs: Record<string, number>, durationMs: number): void {
    const target = this.#directory.resolveCap(dock, SERVO_CAP);
    if (!target?.component) return; // went offline mid-sequence — body holds pose
    const m = this.#dock(dock);
    Object.assign(m.targets, partsUs);
    m.lastMotionAt = Date.now();
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

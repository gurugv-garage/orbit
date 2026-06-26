/**
 * # face-follow
 * The dock follows a face with its head — the first ACTION behaviour, built as a
 * plain TASK for v1 (docs/decision-traces/facefollow-and-actuator-lease.md). No lease
 * yet: it drives the body directly via the `move` capability, so don't run it
 * mid-conversation (the brain's gestures would contend — that's the deferred lease's
 * job). 2 DOF: pan (foot ±90°) + tilt (neck −60..+35°); head-tracking, not pursuit.
 *
 * Loop: recognize() → faces[] (with boxes) → pick a target (named if `target` set, else
 * most-salient, LOCKED by continuity so a crowd doesn't make it oscillate) → ADAPTIVE
 * trial-and-adjust move toward center (NO degrees↔pixels mapping — it discovers the
 * machine's responsiveness live; see adaptive.ts). When no target is visible, SEARCH-
 * sweep (dwell-then-step) from the last-known position outward. Holds still when centered.
 *
 * All the selection + control math is in control.ts (pure, tested); this file is the
 * loop + the body I/O.
 */
import { Task, runTask, type TaskManifest } from '../../_harness/index.js';
import {
  stepFollow, initialFollowState, type Face, type Pose, type FollowState,
} from './control.js';
import { DEFAULT_AXIS, type AxisCfg } from './adaptive.js';

export const manifest = {
  name: 'face-follow',
  description: 'Follow a face with the head (pan + tilt) — a named person if given, else the '
    + 'most salient; search-sweeps when no one is visible. v1: drives the body directly (no '
    + 'lease) — run when not mid-conversation. Loops until stopped.',
  params: [
    { name: 'target', type: 'string', required: false },          // a person to follow; omit → most-salient
    { name: 'tick', type: 'duration', required: false, default: '700ms' }, // control-loop period (slow/gentle)
    { name: 'lostAfter', type: 'number', required: false, default: 8 },    // ticks unseen → search (grace through flicker)
    { name: 'lostAfterCentered', type: 'number', required: false },        // LONGER grace when we were centered (MLKit drops a still face for seconds); omit → 4× lostAfter
    // STEP-AND-SETTLE control — tunable live (omit → DEFAULT_AXIS). deadband = "centered →
    // hold" zone; step = the small fixed move toward the face per correction; settleTicks =
    // ticks to hold still after a move so a FRESH (non-stale) look lands before deciding again.
    { name: 'deadband', type: 'number', required: false },        // 0..1 "centered → hold" zone (both axes)
    { name: 'step', type: 'number', required: false },            // fixed step toward the face per move (deg, small)
    { name: 'settleTicks', type: 'number', required: false },     // ticks to hold still after a move (anti-overshoot)
    // search sweep — dwell at each scan position so perception can catch a face before
    // the head pans past it (the latency fix).
    { name: 'sweepDeg', type: 'number', required: false },        // degrees per sweep step (small = finer)
    { name: 'sweepDwell', type: 'number', required: false },      // ticks to hold + look at each sweep position
    { name: 'smooth', type: 'number', required: false },          // target EMA 0..1 (low = smoother, less twitch)
  ],
} satisfies TaskManifest;

interface FaceTrackOut { faces?: Face[]; noFace?: boolean }

class FaceFollowTask extends Task {
  async run(): Promise<void> {
    const target = (this.params.target as string | undefined) || undefined;
    const tick = (this.params.tick as string | undefined) ?? '700ms';
    const lostAfter = Number(this.params.lostAfter ?? 8);
    // per-instance adaptive-control overrides (fall back to DEFAULT_AXIS via ??). Both axes
    // share the same shape; we apply the same overrides to pan + tilt (they can diverge
    // live via env if needed, but the task surface keeps it simple).
    const n = (k: string, d: number) => (this.params[k] != null ? Number(this.params[k]) : d);
    const axis: AxisCfg = {
      deadband: n('deadband', DEFAULT_AXIS.deadband),
      step: n('step', DEFAULT_AXIS.step),
      settleTicks: n('settleTicks', DEFAULT_AXIS.settleTicks),
    };
    const cfg: Parameters<typeof stepFollow>[2] = {
      target, lostAfter, panAxis: axis, tiltAxis: axis,
      ...(this.params.lostAfterCentered != null ? { lostAfterCentered: Number(this.params.lostAfterCentered) } : {}),
      ...(this.params.sweepDeg != null ? { sweepDeg: Number(this.params.sweepDeg) } : {}),
      ...(this.params.sweepDwell != null ? { sweepDwell: Number(this.params.sweepDwell) } : {}),
      ...(this.params.smooth != null ? { smooth: Number(this.params.smooth) } : {}),
    };

    // resume the believed pose; the rest of the loop state is transient.
    let state: FollowState = initialFollowState((this.state.pose as Pose | undefined) ?? { foot: 0, neck: 0 });

    // VALIDATION HOOK (FF_MEASURE=1): two log streams that scripts/ff-validate.mjs consumes
    // to judge the live-test flows (docs/operations/facefollow-live-test.md) from GROUND
    // TRUTH, not by eye:
    //  • [ff-event] — emitted ONLY on a state TRANSITION (acquire / lose / search / relock /
    //    yield / resume). Makes the timeline readable: each use-case flow is a labelled
    //    transition, not buried in per-tick spam.
    //  • [ff-tick]  — one compact metric line per tick (mode, faces, lock, err, pose, cmd) so
    //    the validator can measure hold duration, move-command rate, name flips, sweep span.
    const measure = process.env.FF_MEASURE === '1';
    // Our own move-source tag (the move capability stamps moves as `task:<instanceId>`); a
    // mover whose tag isn't ours = a FOREIGN mover (brain turn / console / other task) → yield.
    const myTag = `task:${process.env.TASK_INSTANCE_ID ?? ''}`;
    // Seed the watermark to NOW: only moves AFTER we start count as foreign. A STALE
    // lastMover left on the executor by an earlier brain turn (e.g. the turn that opened the
    // session) must NOT make us yield at cold start — cold start follows immediately.
    let lastMoverAt = Date.now();
    let tickNo = 0;
    let prevPhase = '';                 // mode|lockName|hasLock — the transition signature
    let prevLockName: string | null = null;
    while (true) {
      const faces = await this.faces();
      // YIELD signal: did someone OTHER than us drive the body since we last checked?
      const foreignMover = await this.foreignMover(myTag, lastMoverAt);
      if (foreignMover) lastMoverAt = foreignMover.at; // consume it so we don't re-trigger
      const r = stepFollow(state, faces, cfg, { foreignMover: !!foreignMover });
      state = r.state;
      // Track our OWN successful command's timestamp window: after we move, the executor's
      // lastMover becomes ours — advance the watermark so our own move isn't read as foreign.
      if (r.command) { await this.moveTo(r.command); lastMoverAt = Date.now(); }
      this.status(r.status);
      if (measure) {
        tickNo++;
        const lk = state.lock;
        const ts = Date.now();
        const lockStr = lk ? `${lk.name ?? '?'}@${lk.at.x.toFixed(2)},${lk.at.y.toFixed(2)}` : '-';
        // TRANSITION event — phase = mode|lockName|hasLock; log only on a change.
        const phase = `${state.mode}|${lk?.name ?? ''}|${lk ? 'L' : '-'}`;
        if (phase !== prevPhase) {
          const kind = ffEventKind(prevPhase, phase, prevLockName, lk?.name ?? null);
          console.log(`[ff-event] ts=${ts} ${kind} from="${prevPhase || 'init'}" to="${phase}" lock=${lockStr}`);
          prevPhase = phase; prevLockName = lk?.name ?? null;
        }
        // per-tick metric line
        const fs = faces.map((f) => `${f.name ?? '?'}@${(f.box.x + f.box.w / 2).toFixed(2)},${(f.box.y + f.box.h / 2).toFixed(2)}`).join(' ');
        const errx = lk ? (lk.at.x - 0.5).toFixed(2) : '-';
        const erry = lk ? (lk.at.y - 0.5).toFixed(2) : '-';
        const cmd = r.command ? `foot${r.command.foot.toFixed(0)}/neck${r.command.neck.toFixed(0)}` : '-';
        console.log(`[ff-tick] ts=${ts} #${tickNo} mode=${state.mode} nf=${faces.length} faces=[${fs}] lock=${lockStr} err=(${errx},${erry}) pose=foot${state.pose.foot.toFixed(0)}/neck${state.pose.neck.toFixed(0)} cmd=${cmd}`);
      }
      this.state.pose = state.pose; this.checkpoint();
      await this.sleep(tick);
    }
  }

  /** One face-track read → the latest on-device `perceive` faces with boxes (empty on
   *  no-face / error). The fast source: MLKit on the phone, not station face-api
   *  (docs/decision-traces/facefollow-and-actuator-lease.md §7). Each Face may carry an
   *  `eyeMid` anchor — control.ts prefers it over the box center. */
  private async faces(): Promise<Face[]> {
    try {
      const out = await this.request<FaceTrackOut>('face-track');
      return (out?.faces ?? []).filter((p) => p.box);
    } catch {
      return []; // a transient read failure = "no target this tick", not a crash
    }
  }

  /** Read who last drove the body; return the mover IFF it's FOREIGN (not our own task tag)
   *  and NEWER than the last one we accounted for. Null otherwise. This is the yield trigger:
   *  a brain-turn gesture, the console, or another task taking the body. */
  private async foreignMover(myTag: string, since: number): Promise<{ tag: string; at: number } | null> {
    try {
      const mv = await this.request<{ tag: string; at: number } | null>('bodyMover');
      if (mv && mv.tag !== myTag && mv.at > since) return mv;
      return null;
    } catch {
      return null; // can't read → assume no contention this tick (don't yield on a glitch)
    }
  }

  /** Command an absolute pose (both joints in one timed step). */
  private async moveTo(p: Pose): Promise<void> {
    // travel over ~most of the tick so motion is smooth + the servo settles before the
    // next recognize read (don't chase a stale, mid-travel frame).
    await this.move([{ parts: [{ part: 'foot', degrees: p.foot }, { part: 'neck', degrees: p.neck }], duration_ms: 500 }]);
    // NOTE (v1): no ego-motion loop-closure here — perception's bodymotion stream isn't
    // a task capability yet, and we re-recognize every tick so a panned-past face is
    // re-found next tick anyway. The proper pushCommand loop-closure rides with the
    // lease work (facefollow-and-actuator-lease.md), when faceFollow runs in-process.
  }

  getStatus(): string {
    return `face-follow${this.params.target ? `: ${this.params.target}` : ''}`;
  }
}

/** Classify a phase transition into a labelled event KIND for the validator. Phase string is
 *  `mode|lockName|hasLock`. The kinds map 1:1 to the live-test flows: acquire (gained a lock),
 *  relock (lock changed person), lose (had a lock, now none), search (entered sweep), yield/
 *  resume (cooldown), track-resume (back to track from search). */
function ffEventKind(prev: string, next: string, prevName: string | null, nextName: string | null): string {
  const [, , prevHas] = (prev || '||-').split('|');
  const [nextMode, , nextHas] = next.split('|');
  const had = prevHas === 'L';
  const has = nextHas === 'L';
  if (nextMode === 'yielded') return 'yield';
  if (prev.startsWith('yielded') && nextMode !== 'yielded') return 'resume';
  if (!had && has) return 'acquire';
  if (had && !has) return 'lose';
  if (had && has && prevName !== nextName) return 'relock';     // switched person (salient) / matched named
  if (nextMode === 'search') return 'search';
  if (nextMode === 'track') return 'track';
  return 'phase';
}

runTask(FaceFollowTask);

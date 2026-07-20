/**
 * BodyCmdLog — the AUDIT trail of every body (servo) command the station issued.
 *
 * NOT to be confused with the 'bodymotion' stream (bodymotion-watch.ts), which is the
 * CAMERA-is-moving ego signal for the vision pipeline, keyed by the WebRTC streamId and
 * alive only while a video stream is up. THIS stream is proprioception: it is keyed by
 * DOCK and records commands whether or not any camera streams — a servo-only body (the
 * C3) has no video at all, yet its neck/foot still move (and can stick).
 *
 * One record PER command issued at the MotionExecutor choke point (per-step: the raw wire
 * truth, so an abandoned mid-bit shows the last step that fired and the missing home step
 * — the "why does the head rest looking up" signature). Every record carries:
 *   source     who issued it — 'brain-turn' | 'console' | 'task:<id>' | 'faceFollow' | 'station'
 *   priority   the priority that source held (console 70 … idle 0)
 *   outcome    'accepted' | 'rejected-priority' | 'dropped-offline'
 *   blockedBy  on a priority reject: the holder that won { holder, priority }
 *   base       the pose the command was applied ON (degrees) — { neck, foot }
 *   target     the pose it commanded (degrees) — { neck, foot }
 *   gaze       derived from the RESULTING pose (accepted) or base (rejected): pan/tilt/facing
 *
 * The gaze fields are why the settled body state can finally say "looking up-left" instead
 * of just "stationary". This is a plain producer into the shared SnapshotStore — no media,
 * no stream lifecycle. main.ts wires MotionExecutor → setBodyCmdSink → this.
 */

import { makeSnapshot, type SnapshotStore } from '../snapshots.js';

/** A per-joint pose in DEGREES (neck = pitch/tilt, foot = pan/yaw). */
export interface BodyPose { neck: number; foot: number }

export type BodyCmdOutcome = 'accepted' | 'rejected-priority' | 'dropped-offline';

/** Source-authored metadata carried verbatim from the MotionExecutor (open by design). */
export interface BodyCmdMeta {
  relative?: boolean;       // did the SOURCE author a delta (relative) vs an absolute target?
  reason?: string;          // why the source moved (free prose / 'gesture:happy' / 'mood:curious')
  [k: string]: unknown;
}

/** One body command as the MotionExecutor sees it — the station's contract to this log. */
export interface BodyCmdEntry {
  dock: string;
  source: string;
  priority: number;
  outcome: BodyCmdOutcome;
  blockedBy?: { holder: string; priority: number };
  base: BodyPose;           // absolute pose the command applied ON (executor-owned fact)
  target: BodyPose;         // absolute resulting pose (executor-owned fact)
  meta?: BodyCmdMeta;       // source-authored (relative?, reason?, …)
  durationMs?: number;
  at?: number;              // epoch ms the command was issued (default: now)
}

/** Sign convention (matches schemas.ts DEGREE_LIMITS + bodylink motion.pose):
 *   neck: negative = UP, positive = down, 0 = level.
 *   foot: negative = right, positive = left, 0 = forward. */
function facingPhrase(p: BodyPose): string {
  const foot = Math.round(p.foot);
  const neck = Math.round(p.neck);
  const pan = foot === 0 ? 'ahead' : `${Math.abs(foot)}° ${foot < 0 ? 'right' : 'left'}`;
  const tilt = neck === 0 ? '' : `, ${Math.abs(neck)}° ${neck < 0 ? 'up' : 'down'}`;
  return `${pan}${tilt}`;
}

/** Signed degrees with an explicit + for deltas (so "+18" reads as motion, "18" as a target). */
const signed = (d: number) => `${d > 0 ? '+' : ''}${Math.round(d)}`;

/**
 * Per-joint motion phrase, told the way the SOURCE authored it (italics = COMPUTED, not
 * spoken):
 *   source authored ABSOLUTE → "neck 0→-18 (*Δ-18*)"  — from→to spoken, delta computed.
 *   source authored RELATIVE → "neck Δ-18 → -18 (*from 0*)" — delta+to spoken, from computed.
 * A joint that didn't move is omitted. Returns '' if nothing moved.
 */
function motionPhrase(base: BodyPose, target: BodyPose, relative: boolean): string {
  const parts: string[] = [];
  for (const j of ['neck', 'foot'] as const) {
    const from = Math.round(base[j]);
    const to = Math.round(target[j]);
    if (from === to) continue;
    const delta = to - from;
    parts.push(relative
      ? `${j} Δ${signed(delta)} → ${to} (*from ${from}*)`
      : `${j} ${from}→${to} (*Δ${signed(delta)}*)`);
  }
  return parts.join(', ');
}

/** A readable one-line phrase for the timeline `text`. */
function phraseFor(e: BodyCmdEntry): string {
  const who = e.source;
  const why = e.meta?.reason ? ` [${e.meta.reason}]` : '';
  if (e.outcome === 'rejected-priority') {
    const by = e.blockedBy ? `${e.blockedBy.holder}(${e.blockedBy.priority})` : 'a higher holder';
    return `${who}(${e.priority}) move REJECTED — ${by} holds${why}`;
  }
  if (e.outcome === 'dropped-offline') return `${who} move dropped — body offline${why}`;
  const motion = motionPhrase(e.base, e.target, e.meta?.relative ?? false);
  const how = motion || `no travel (already at ${facingPhrase(e.target)})`;
  return `${who} moved ${how} → looking ${facingPhrase(e.target)}${why}`;
}

export interface BodyCmdLog {
  /** Record one body command (accepted or rejected) into the perception timeline. */
  push(entry: BodyCmdEntry): void;
}

export function bodyCmdLog(store: SnapshotStore): BodyCmdLog {
  return {
    push(e) {
      // On an accepted move the resulting gaze is the TARGET; a rejected/dropped command
      // didn't move the body, so its gaze is where the body already was (the BASE).
      const gazePose = e.outcome === 'accepted' ? e.target : e.base;
      const at = new Date(e.at ?? Date.now());
      store.add(makeSnapshot({
        dockId: e.dock,
        source: { id: `${e.dock}:body`, kind: 'bodymotion', device: 'dock-body', host: 'station' },
        model: { name: 'motion-executor', endpoint: 'in-process' },
        from: at, to: at,
        payload: {
          text: phraseFor(e),
          source: e.source,
          priority: e.priority,
          outcome: e.outcome,
          ...(e.blockedBy ? { blockedBy: e.blockedBy } : {}),
          base: e.base,
          target: e.target,
          // delta = target − base (per joint) — always computed; whether it or from→to is the
          // AUTHORED value is `relative` (source-declared). The UI italicizes the computed one.
          delta: { neck: Math.round(e.target.neck - e.base.neck), foot: Math.round(e.target.foot - e.base.foot) },
          relative: e.meta?.relative ?? false,
          ...(e.meta?.reason ? { reason: e.meta.reason } : {}),
          pan: Math.round(gazePose.foot),
          tilt: Math.round(gazePose.neck),
          facing: facingPhrase(gazePose),
          ...(e.durationMs != null ? { durationMs: e.durationMs } : {}),
        },
      }));
    },
  };
}

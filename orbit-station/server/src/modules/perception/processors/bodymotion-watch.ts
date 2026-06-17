/**
 * BodyMotionWatchProcessor — the EGOCENTRIC stream. The camera lives on a robot
 * that can pan, tilt, and drive, so a change in the view has TWO possible causes:
 *   • world change  — a person actually left / arrived / moved, OR
 *   • ego-motion     — the ROBOT moved (panned away, drove to another room).
 * The other streams (identity "they left", vision "the scene changed") and the
 * summarizer cannot tell these apart on their own. This stream supplies the missing
 * signal — "is the camera moving / just moved" — so they can.
 *
 * PROPRIOCEPTION, not estimation. The robot COMMANDS its own motion, so it simply
 * knows when it moved — there's no reason to infer it from pixels. The station feeds
 * us discrete MOTION COMMANDS (see MotionCommand) as they're issued; we have no
 * "stationary command" — absence of commands IS stationary.
 *
 * THE SUBTLETY (why this isn't just "record the command"): a command is a sub-second
 * blip, but the consumers reason over ~2 s windows (identity samples every 2 s; the
 * summarizer over minutes). If `current()` only reported "moving" during the literal
 * command, a 400 ms pan that ends between identity samples would be missed and the
 * panned-past person wrongly dropped. So a command marks the camera unsettled for its
 * duration PLUS a short SETTLE TAIL — covering the motion-blur + the next sample or
 * two. current() returns 'moving' for that whole span. Overlapping/bursty commands
 * (a search sweep) naturally extend one continuous unsettled span.
 *
 * To test without a robot, inject mock commands via pushCommand() (wired to a REST
 * poke in the perception module).
 */

import type { MediaKind } from '../../media/tap.js';
import type { StreamContext, StreamProcessor } from '../processor.js';
import { makeSnapshot, type SnapshotStore } from '../snapshots.js';

/** Coarse derived state the consumers act on. */
export type MotionState = 'stationary' | 'moving';

/**
 * One motion command the robot issued — the station's CONTRACT to this stream.
 * Fields are intentionally OPEN strings (not enums): the body may morph and what a
 * motion means can be reconfigured, so the station sends whatever its current config
 * means and we don't hard-code a taxonomy. Conventions (extend freely):
 *   mode:      'pan' | 'tilt' | 'drive' | … (how the camera/body moved)
 *   direction: 'left' | 'right' | 'up' | 'down' | 'forward' | 'back' | …
 */
export interface MotionCommand {
  mode: string;                 // e.g. 'pan', 'tilt', 'drive'
  direction?: string;           // e.g. 'left', 'right', 'up', 'forward'
  durationMs: number;           // how long the move takes (sub-second typical)
  amount?: number;              // optional magnitude (degrees / metres) — robot's units
  label?: string;               // optional human phrase ("scanning the room"); else synthesized
  at?: number;                  // optional epoch ms the move started (default: now)
}

/** Mark the camera unsettled for this long AFTER a command's motion ends, to cover
 *  motion-blur settling + the next consumer sample(s). */
const SETTLE_TAIL_MS = Number(process.env.BODYMOTION_SETTLE_TAIL_MS ?? 600);

interface StreamState {
  ctx: StreamContext;
  /** Epoch ms until which the camera is considered unsettled ('moving'). 0 = settled. */
  movingUntil: number;
  last: MotionState;            // last EMITTED state (so we emit only on change)
}

/** A readable phrase for a command (used when the robot didn't supply a label). */
function phraseFor(c: MotionCommand): string {
  if (c.label) return c.label;
  const dir = c.direction ? ` ${c.direction}` : '';
  // "pan left" → "turning to look left"; "drive forward" → "moving forward".
  if (c.mode === 'drive') return `moving${dir}`;
  if (c.mode === 'pan' || c.mode === 'tilt') return `turning to look${dir}`;
  return `${c.mode}${dir}`.trim();
}

export function bodyMotionWatchProcessor(store: SnapshotStore): StreamProcessor & {
  /** Station seam: the robot issued a motion command. Records a 'camera moving'
   *  snapshot and keeps the camera 'moving' for the command's duration + settle tail. */
  pushCommand(streamId: string, cmd: MotionCommand): boolean;
  /** Current derived motion state — 'moving' through a command's duration+settle tail,
   *  else 'stationary'. Consumers (identity, etc.) read this to be ego-motion aware. */
  current(streamId: string): MotionState;
} {
  const streams = new Map<string, StreamState>();

  const record = (s: StreamState, text: string, state: MotionState, extra: Record<string, unknown> = {}) => {
    store.add(makeSnapshot({
      dockId: s.ctx.dockId,
      source: { id: s.ctx.streamId, kind: 'bodymotion', device: 'dock-webrtc', host: 'station' },
      model: { name: 'robot-proprioception', endpoint: 'in-process' },
      from: new Date(), to: new Date(),
      payload: { text, state, ...extra },
    }));
  };

  /** Lazily emit the 'settled' (stationary) transition once the unsettled span ends.
   *  Called from current() (consumers poll it every couple seconds) so we don't need
   *  our own timer — the next reader after movingUntil flips it back. */
  const settleIfDue = (s: StreamState) => {
    if (s.last === 'moving' && Date.now() >= s.movingUntil) {
      s.last = 'stationary';
      record(s, 'stationary', 'stationary');
    }
  };

  return {
    pushCommand(streamId, cmd) {
      const s = streams.get(streamId);
      if (!s) return false;
      const start = cmd.at ?? Date.now();
      s.movingUntil = Math.max(s.movingUntil, start + Math.max(0, cmd.durationMs) + SETTLE_TAIL_MS);
      // Emit a 'camera moving' record on the rising edge (bursts extend the span,
      // they don't spam — each command still records WHAT moved for the timeline).
      if (s.last !== 'moving') s.last = 'moving';
      record(s, phraseFor(cmd), 'moving',
        { mode: cmd.mode, direction: cmd.direction, amount: cmd.amount, durationMs: cmd.durationMs });
      return true;
    },
    current(streamId) {
      const s = streams.get(streamId);
      if (!s) return 'stationary';
      settleIfDue(s);
      return Date.now() < s.movingUntil ? 'moving' : 'stationary';
    },

    id: 'bodymotion-watch',
    sources: '*',
    // No media — proprioception comes via pushCommand(). mediaKinds:[] = the hub's
    // lifecycle-only path (onStreamStart/End on the first track, no RTP). This means
    // ego-motion is no longer incidentally coupled to the stream having VIDEO.
    mediaKinds: [] as readonly MediaKind[],
    channels: [],

    onStreamStart(ctx: StreamContext) {
      const st: StreamState = { ctx, movingUntil: 0, last: 'stationary' };
      // Seed a baseline so the window always has a reading (until the robot reports).
      record(st, 'stationary', 'stationary');
      streams.set(ctx.streamId, st);
    },

    // No onRtp — body-motion is proprioception, not derived from the video stream.

    onStreamEnd(streamId: string) {
      streams.delete(streamId);
    },
  };
}

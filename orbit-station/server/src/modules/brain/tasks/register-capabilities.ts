/**
 * The station capabilities a task can invoke (docs/tasks.md).
 *
 * MENTAL MODEL: a task is just another entry point into the STATION'S ENVIRONMENT,
 * running limited LLM-authored code on the same machine, with the same `.env`
 * (provider keys), node_modules, and filesystem. So a capability is ONLY for the
 * things that need the station's LIVE IN-PROCESS RUNTIME STATE — the decoded SFU
 * video sitting in the FrameGrabber, the body's MotionExecutor connection, the
 * face gallery. Anything that needs merely the environment (run an LLM with the
 * key from .env, import a module, call HTTP, execute code) the task does ITSELF —
 * e.g. to reason about a frame, it imports pi and runs its own Agent (vision,
 * multi-step, tools), not a station round-trip.
 *
 * Shipped: frame / recognize (need 'camera'), move (needs 'servo'). Add a new
 * capability = one `register(...)` call. `hasDockCap` is
 * `directory.resolveCap(dock, cap) != null`, so a dock not serving that component
 * never sees or runs the capability.
 */
import type { Directory } from '../../docks/directory.js';
import type { MotionExecutor } from '../../bodylink/motion.js';
import type { FaceToolsApi } from '../../perception/index.js';
import type { PerceiveStore } from '../../perception/perceive.js';
import type { MoveStep } from '../schemas.js';
import { CapabilityRegistry } from './capabilities.js';

export interface CapabilityDeps {
  directory: Directory;
  motion: MotionExecutor;
  getFaces: () => FaceToolsApi | undefined;
  /** the live per-dock on-device face-track store (the `perceive` stream) — the FAST
   *  face source the faceFollow `face-track` capability reads. */
  getPerceive: () => PerceiveStore | undefined;
}

/** The dock's live camera streamId (the SFU producer serving 'camera'), or undefined. */
function streamFor(d: CapabilityDeps, dock: string): string | undefined {
  return d.directory.resolveCap(dock, 'camera')?.id;
}

/** Pull the latest decoded frame of the dock's live stream as a base64 JPEG. */
function currentFrame(d: CapabilityDeps, dock: string): string | undefined {
  const streamId = streamFor(d, dock);
  return streamId ? d.getFaces()?.frame(streamId) : undefined;
}

/** Build the registry with the station's task capabilities wired to live APIs. */
export function buildCapabilityRegistry(d: CapabilityDeps): CapabilityRegistry {
  const hasDockCap = (dock: string, cap: string) => d.directory.resolveCap(dock, cap) != null;
  const reg = new CapabilityRegistry(hasDockCap);

  reg.register({
    op: 'frame', requires: 'camera',
    describe: 'await this.frame() → the dock\'s latest camera JPEG (base64). undefined means the camera '
      + 'stream is momentarily DOWN (NOT that the dock lacks a camera — this op only exists because it '
      + 'has one); just keep retrying, the stream usually comes back',
    when: 'when you need the pixels of what the camera sees right now (then reason about them yourself — run your own pi Agent for vision, the model key is in the environment)',
    handler: (ctx) => currentFrame(d, ctx.dock),
  });

  reg.register({
    op: 'recognize', requires: 'camera',
    describe: 'await this.request("recognize") → who is currently in frame (known faces)',
    when: 'to tell WHO is present, not just that someone is',
    handler: (ctx) => d.getFaces()?.recognize({ streamId: streamFor(d, ctx.dock) }),
  });

  // The on-device MLKit face-track (the `perceive` stream, docs/decision-traces/
  // facefollow-and-actuator-lease.md §7) — the FAST, low-latency face source for the
  // faceFollow control loop. Requires 'face' (the phone's on-device perception cap)
  // rather than 'camera': this reads the phone's MLKit output, not the SFU video.
  reg.register({
    op: 'face-track', requires: 'face',
    describe: 'await this.request("face-track") → { faces, noFace } — the latest on-device '
      + 'face boxes (each with an eye-midpoint anchor). The fast tracking source (~5 Hz), not station face-api',
    when: 'for a tight control loop that needs WHERE faces are right now (e.g. faceFollow)',
    handler: (ctx) => {
      const store = d.getPerceive();
      const faces = store?.toFollowFaces(store.latest(ctx.dock)) ?? [];
      return { faces, noFace: faces.length === 0 };
    },
  });

  reg.register({
    op: 'move', requires: 'servo',
    describe: 'await this.move(steps) → drive the body through timed move steps',
    when: 'to physically turn/gesture the body (e.g. sweep to find someone, nod)',
    handler: (ctx, args) => {
      const steps = (Array.isArray(args.steps) ? args.steps : []) as MoveStep[];
      // TAG the move with this task's id so a standing behaviour (faceFollow) can tell its
      // OWN moves from a foreign mover (a brain turn / console / another task) and yield.
      d.motion.runSteps(ctx.dock, steps, `task:${ctx.instanceId}`);
      return { ok: true };
    },
  });

  reg.register({
    op: 'bodyMover', requires: 'servo',
    describe: 'await this.request("bodyMover") → { tag, at } | null — who last drove the body',
    when: 'to detect when ANOTHER mover took the body (a standing behaviour yields + cools down)',
    handler: (ctx) => {
      const mv = d.motion.lastMover(ctx.dock);
      return mv ? { tag: mv.tag, at: mv.at } : null;
    },
  });

  // NOTE: memory is NOT a capability. It's a sqlite file (`.data/orbit.db`) + an
  // embedder that needs only the env GEMINI key — all reconstructible from the SHARED
  // code + `.env` a task already has. So a task reaches memory DIRECTLY (a `this.memory`
  // store on the Task base class), like it runs its own LLM. Capabilities are reserved
  // for the station's LIVE in-process state (decoded video, the body link) that a
  // separate process genuinely can't reconstruct. See tasks.md "direct vs. the wire".

  return reg;
}

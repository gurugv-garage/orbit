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
  /** ms since the last SALIENT perception event for a dock (confident speech, notable
   *  sound, vision change, identity/motion transition), or null when unknown — the
   *  boredom-on-coherence pulse (coherence-layer.md step 5). */
  msSinceSalient: (dock: string) => number | null;
  /** the live faceGestures choreography table (config-backed) — the `gesture` capability. */
  getGestures: () => Record<string, MoveStep[]>;
  /** enqueue a self-thought autonomous turn on the dock's brain session (the `think`
   *  capability) — the brain authors + speaks the actual line, with all its usual
   *  deferral rules (user turns win, defers while listening/speaking, stale drops).
   *  `via` = the raising source (e.g. "mood:curious.wonder") for the obs trace. */
  enqueueThought: (dock: string, text: string, coalesceKey?: string, via?: string) => void;
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
      // A task may pass `reason` (e.g. the bit that chose the move) — carried to the audit log.
      const meta = typeof args.reason === 'string' ? { reason: args.reason } : undefined;
      d.motion.runSteps(ctx.dock, steps, `task:${ctx.instanceId}`, meta);
      return { ok: true };
    },
  });

  reg.register({
    op: 'perception-pulse', requires: 'face',
    describe: 'await this.request("perception-pulse") → { msSinceSalient } — how long since the '
      + 'dock last perceived a genuine HAPPENING (confident speech, a notable sound, a visual '
      + 'change). null = unknown (perception cold)',
    when: 'to gate reactive spoken bits on whether anything actually happened recently',
    handler: (ctx) => ({ msSinceSalient: d.msSinceSalient(ctx.dock) }),
  });

  reg.register({
    op: 'gesture', requires: 'servo',
    describe: 'await this.request("gesture", {expression}) → play a named faceGestures body '
      + 'choreography (e.g. "curious", "sleepy", "happy", "surprised") — authored expressive '
      + 'moves without hand-writing steps',
    when: 'a quick expressive body bit (a curious tilt, a sleepy droop) — cheaper than authoring steps',
    handler: (ctx, args) => {
      const expression = String(args.expression ?? '');
      const gestures = d.getGestures();
      const steps = gestures[expression];
      if (!steps) return { ok: false, reason: `unknown gesture '${expression}'` };
      // Estimate BEFORE dispatch (the estimate rolls from the current pose; dispatching
      // first would race the pose updates). playGesture is fire-and-forget — the caller
      // HOLDS (and renews) its body lease for durationMs so the moves actually finish.
      // Must be the executor's own paced estimate, not the authored sum: fast gestures
      // stretch 2×+ under the velocity/comfort floor (review finding 2026-07-05).
      const durationMs = d.motion.estimateSequenceMs(ctx.dock, steps);
      // same source tag as `move`, so the lease arbitrates it like any task motion. A task may
      // pass `reason` (the bit) to override the default `gesture:<expression>` in the audit log.
      const meta = typeof args.reason === 'string' ? { reason: args.reason } : undefined;
      d.motion.playGesture(ctx.dock, expression, gestures, `task:${ctx.instanceId}`, meta);
      return { ok: true, durationMs };
    },
  });

  // A task-initiated SPOKEN thought. The task never synthesizes speech — it hands the brain
  // a self-thought prompt; the brain's autonomous turn authors the line with live perception
  // grounding + session context and speaks it (ThoughtRouter defers while a user is talking,
  // drops stale). A station-side per-dock FLOOR guards against a buggy/restarting task
  // chattering; the real (tunable) cadence policy lives in the calling task.
  const lastThinkAt = new Map<string, number>();
  const THINK_FLOOR_MS = 5 * 60_000;
  reg.register({
    op: 'think', requires: 'voice',
    describe: 'await this.request("think", {text, coalesceKey?}) → { ok } — enqueue a self-thought '
      + 'the brain will speak in its own words (deferred while a user is talking; '
      + 'rate-floored station-side to one per 5 min per dock)',
    when: 'a RARE spoken bit — say something unprompted, grounded in what the dock currently knows',
    handler: (ctx, args) => {
      const at = lastThinkAt.get(ctx.dock) ?? 0;
      if (Date.now() - at < THINK_FLOOR_MS) return { ok: false, reason: 'rate-floored' };
      const text = String(args.text ?? '').trim();
      if (!text) return { ok: false, reason: 'empty text' };
      lastThinkAt.set(ctx.dock, Date.now());
      const key = typeof args.coalesceKey === 'string' && args.coalesceKey ? `${args.coalesceKey}:${ctx.dock}` : undefined;
      const via = typeof args.via === 'string' && args.via ? args.via : `task:${ctx.instanceId}`;
      d.enqueueThought(ctx.dock, text, key, via);
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

  // ACTUATOR LEASE (facefollow decision trace §4) — a continuous body-holder (faceFollow,
  // the mock follower) acquires the body at a PRIORITY, renews it each tick, and checks
  // whether it still holds it (a higher-priority mover — a brain turn — preempts). The lease
  // is keyed to this task's source tag (`task:<id>`), so the task's own `move`s admit and a
  // crash auto-releases the body within one TTL.
  reg.register({
    op: 'acquireBody', requires: 'servo',
    describe: 'await this.request("acquireBody", {priority}) → { ok } — hold the body at a priority',
    when: 'a continuous behaviour that drives the body (faceFollow) — call once before tracking',
    handler: (ctx, args) => {
      const priority = typeof args.priority === 'number' ? args.priority : 30;
      const lease = d.motion.acquire(ctx.dock, `task:${ctx.instanceId}`, priority);
      return { ok: lease != null };
    },
  });
  reg.register({
    op: 'bodyHeld', requires: 'servo',
    describe: 'await this.request("bodyHeld") → { held, holder } — do WE still hold the body? (renews)',
    when: 'each control tick: renew our hold + detect a preempt (held=false → a higher mover took it)',
    handler: (ctx) => {
      // renew (via a fresh acquire at our priority — admit/acquire is idempotent for the same
      // holder) and report whether WE are the current holder.
      const cur = d.motion.bodyHolder(ctx.dock);
      const mine = `task:${ctx.instanceId}`;
      const held = cur?.holder === mine;
      if (held) d.motion.acquire(ctx.dock, mine, cur!.priority); // renew
      return { held, holder: cur?.holder ?? null };
    },
  });
  reg.register({
    op: 'releaseBody', requires: 'servo',
    describe: 'await this.request("releaseBody") → { ok } — give the body back',
    when: 'when a behaviour stops driving the body (so a waiter can take it immediately)',
    handler: (ctx) => { d.motion.releaseBody(ctx.dock, `task:${ctx.instanceId}`); return { ok: true }; },
  });

  // NOTE: memory is NOT a capability. It's a sqlite file (`.data/orbit.db`) + an
  // embedder that needs only the env GEMINI key — all reconstructible from the SHARED
  // code + `.env` a task already has. So a task reaches memory DIRECTLY (a `this.memory`
  // store on the Task base class), like it runs its own LLM. Capabilities are reserved
  // for the station's LIVE in-process state (decoded video, the body link) that a
  // separate process genuinely can't reconstruct. See tasks.md "direct vs. the wire".

  return reg;
}

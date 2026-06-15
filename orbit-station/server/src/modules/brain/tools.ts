/**
 * The dock brain's tools — schemas from schemas.ts (the single model-facing
 * copy), execution wired per the placement table (docs/SERVER-BRAIN-IMPL.md §1):
 *
 *   set_face   phone RPC (it's the screen) + in-process gesture choreography
 *   move       in-process MotionExecutor → directed set_target to the body
 *   compute    in-process SafeCompute
 *   *_face     in-process perception module (no round-trip)
 *
 * Every tool keeps the fire-and-forget actuation contract: the result is the
 * dispatch status, never actuation completion. Tools throw on failure — pi
 * turns throws into error tool results, the model narrates, the turn
 * continues.
 */

import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core';
import type { FaceToolsApi, RecognizeOut } from '../perception/index.js';
import type { MotionExecutor } from '../bodylink/motion.js';
import type { MoveStep } from './schemas.js';
import type { RpcBroker } from './rpc.js';
import { SafeCompute } from './safe-compute.js';
import * as S from './schemas.js';

/** Per-turn context the tools read at execution time (set by the session). */
export interface ToolTurnContext {
  turnId: string;
  /** the turn's attached camera JPEG (base64), if any. */
  imageBase64?: string;
  /** the dock's live camera stream id (the producing peer), if streaming. */
  streamId?: string;
}

export interface ToolDeps {
  dock: string;
  rpc: RpcBroker;
  motion: MotionExecutor;
  getFaces: () => FaceToolsApi | undefined;
  getGestures: () => Record<string, MoveStep[]>;
  getTurnContext: () => ToolTurnContext;
}

const compute = new SafeCompute();

function textResult(text: string): AgentToolResult<unknown> {
  return { content: [{ type: 'text', text }], details: undefined };
}

/* pi's Tool.parameters is TypeBox — plain JSON Schema at runtime; our ported
 * schemas cast cleanly. */
function tool(
  name: string,
  description: string,
  parameters: object,
  execute: (toolCallId: string, args: any) => Promise<AgentToolResult<unknown>>,
): AgentTool<any> {
  return { name, label: name, description, parameters: parameters as never, execute };
}

/**
 * Cross-dock tools, by GRANT (docs/SERVER-BRAIN-IMPL.md §2 "cross-dock
 * interactions"): tool exposure is policy, not possibility. `brainGrants`
 * (config, json) maps  { <thisDock>: { <targetDock>: [caps…] } } — a dock's
 * brain gets a `move_<target>` tool ONLY for targets granted 'servo'. The
 * motion executor is the same single master; only the tenant differs.
 */
export function buildGrantTools(
  dock: string,
  grants: Record<string, string[]>,
  motion: ToolDeps['motion'],
): AgentTool<any>[] {
  const out: AgentTool<any>[] = [];
  for (const [target, caps] of Object.entries(grants)) {
    if (target === dock || !Array.isArray(caps) || !caps.includes('servo')) continue;
    const name = `move_${target.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
    out.push(tool(
      name,
      `Move the body of "${target}" — another robot you are allowed to control. ${S.MOVE_DESC}`,
      S.moveSchema,
      async (_toolCallId, args: { steps: MoveStep[] }) =>
        textResult(motion.runSteps(target, (args as { steps: MoveStep[] }).steps ?? [])),
    ));
  }
  return out;
}

export function buildDockTools(deps: ToolDeps): AgentTool<any>[] {
  const faces = (): FaceToolsApi => {
    const f = deps.getFaces();
    if (!f) throw new Error('face recognition is not available right now');
    return f;
  };
  /** photo-first (this turn's attached frame), live SFU frame as fallback. */
  const frameOpts = () => {
    const ctx = deps.getTurnContext();
    return { photo: ctx.imageBase64, streamId: ctx.streamId };
  };

  return [
    tool('set_face', S.SET_FACE_DESC, S.setFaceSchema, async (toolCallId, args: { expression: string }) => {
      if (!S.FACES.includes(args.expression as never)) {
        throw new Error(`unknown expression "${args.expression}"`);
      }
      // gesture choreography in-process (best-effort), face UI via phone RPC.
      deps.motion.playGesture(deps.dock, args.expression, deps.getGestures());
      const ack = await deps.rpc.call({
        dock: deps.dock, cap: 'face', turnId: deps.getTurnContext().turnId,
        toolCallId, name: 'set_face', args,
      });
      if (ack.isError) throw new Error(ack.content);
      return textResult(ack.content || `face set to ${args.expression}`);
    }),

    tool('set_face_style', S.SET_FACE_STYLE_DESC, S.setFaceStyleSchema, async (toolCallId, args: { style: string }) => {
      if (!S.FACE_STYLES.includes(args.style as never)) {
        throw new Error(`unknown face style "${args.style}"`);
      }
      // Appearance + voice only — no body gesture. Phone owns the screen.
      const ack = await deps.rpc.call({
        dock: deps.dock, cap: 'face', turnId: deps.getTurnContext().turnId,
        toolCallId, name: 'set_face_style', args,
      });
      if (ack.isError) throw new Error(ack.content);
      return textResult(ack.content || `face style set to ${args.style}`);
    }),

    tool('move', S.MOVE_DESC, S.moveSchema, async (_toolCallId, args: { steps: MoveStep[] }) => {
      return textResult(deps.motion.runSteps(deps.dock, args.steps ?? []));
    }),

    tool('compute', S.COMPUTE_DESC, S.computeSchema, async (_toolCallId, args: { expression: string }) => {
      return textResult(compute.eval(args.expression ?? ''));
    }),

    tool('remember_face', S.REMEMBER_FACE_DESC, S.rememberFaceSchema, async (_id, args: { name: string }) => {
      const r = await faces().enroll({ name: args.name ?? '', ...frameOpts() });
      if (!r.ok) throw new Error(r.reason ?? 'could not store the face');
      return textResult(`Okay, I'll remember this person as ${args.name}.`);
    }),

    tool('recollect_face', S.RECOLLECT_FACE_DESC, S.recollectFaceSchema, async () => {
      const r = await faces().recognize(frameOpts());
      return textResult(describeRecognition(r));
    }),

    tool('confirm_face', S.CONFIRM_FACE_DESC, S.confirmFaceSchema, async (_id, args: { name: string }) => {
      const r = await faces().confirm({ name: args.name ?? '', ...frameOpts() });
      if (!r.ok) throw new Error('could not confirm — no usable face capture');
      return textResult(`Got it — I'll recognize ${args.name} better from now on.`);
    }),

    tool('forget_face', S.FORGET_FACE_DESC, S.forgetFaceSchema, async (_id, args: { name: string }) => {
      const r = await faces().forget({ name: args.name ?? '', streamId: deps.getTurnContext().streamId });
      return textResult(r.ok ? `Okay, I've forgotten ${args.name}.` : `I don't have anyone stored as ${args.name}.`);
    }),
  ];
}

/** Render a recognition result as the tool's answer-to-the-model. Mirrors the
 *  phrasing contract in the tool descriptions (confident name / tentative
 *  "I think you might be X" / unknown / no one). */
export function describeRecognition(r: RecognizeOut): string {
  if (r.noFace) return 'No one is in front of you right now.';
  if (r.people.length > 1) {
    const parts = r.people.map((p) => {
      const who = p.name ?? (p.tentative ? `possibly ${p.tentative}` : "someone you don't recognize");
      return `${who} (${p.side})`;
    });
    return `You can see ${r.people.length} people: ${parts.join(', ')}.`;
  }
  if (r.name) return `It's ${r.name} in front of you.`;
  if (r.tentative) return `I think you might be looking at ${r.tentative} — but you're not sure. Ask them.`;
  return "There's someone in front of you, but you don't recognize them yet.";
}

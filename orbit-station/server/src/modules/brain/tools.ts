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

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core';
import type { FaceToolsApi, RecognizeOut } from '../perception/index.js';
import type { MotionExecutor } from '../bodylink/motion.js';
import type { MoveStep } from './schemas.js';
import type { RpcBroker } from './rpc.js';
import { SafeCompute } from './safe-compute.js';
import * as S from './schemas.js';
import * as slack from '../../integrations/slack.js';
import * as whatsapp from '../../integrations/whatsapp.js';

/** Capture a live clip, then hand the finished file to a watcher. The session
 *  provides this; record_video kicks it off and returns immediately. */
export interface RecordVideoDeps {
  /** record `seconds` of the dock's live stream → a clip on disk. */
  record(streamId: string, seconds: number): Promise<{ path: string; dockId: string }>;
  /** called (off the turn) when a clip is ready — uploads / notifies. */
  onClipReady(info: { path: string; caption?: string; slackChannel?: string }): void;
}

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
  /** live video recording (record_video). Undefined → the tool isn't offered. */
  recordVideo?: RecordVideoDeps;
}

const compute = new SafeCompute();
const execFileP = promisify(execFile);

/** Current local date/time via the system `date` command (shell-backed, per the
 *  brain's need to know "now" before scheduling reminders). Falls back to a JS
 *  date string if `date` is unavailable (e.g. a non-unix host). */
async function nowFromShell(): Promise<string> {
  try {
    const { stdout } = await execFileP('date', ['+%A %Y-%m-%d %H:%M:%S %Z'], { timeout: 2000 });
    return stdout.trim();
  } catch {
    return new Date().toString();
  }
}

/** How to refer to the Slack channel in a tool result — what the USER said (a
 *  #name or the default), never a resolved id. Echoing a raw channel id taught
 *  the model to reuse a stale id in later calls (→ channel_not_found on upload). */
function channelLabel(channel?: string): string {
  const c = channel?.trim() || slack.slackDefaultChannel();
  if (!c) return 'Slack';
  // a raw id (Cxxxx) → just say "Slack" rather than echo the id back.
  return /^[CGD][A-Z0-9]{6,}$/.test(c) ? 'Slack' : c;
}

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

/**
 * The `send_to_slack` tool — only offered when Slack is configured
 * (`SLACK_BOT_TOKEN`), so the model never claims an ability it can't perform.
 * The session appends this conditionally (like cross-dock grant tools).
 */
export function buildSlackTools(): AgentTool<any>[] {
  if (!slack.slackEnabled()) return [];
  return [
    tool('send_to_slack', S.SEND_TO_SLACK_DESC, S.sendToSlackSchema, async (_id, args: { text: string; channel?: string; mention?: string[] }) => {
      let text = args.text ?? '';
      // Resolve any requested @mentions to Slack tokens and prepend them.
      const mentions: string[] = [];
      for (const who of args.mention ?? []) {
        const u = await slack.resolveUser(who);
        if (u) mentions.push(slack.mentionOf(u));
        else return textResult(`Couldn't find a Slack user matching "${who}" — message not sent.`);
      }
      if (mentions.length) text = `${mentions.join(' ')} ${text}`;
      await slack.postMessage({ text, channel: args.channel });
      // Report the channel AS THE USER REFERRED TO IT — never the resolved id, so
      // the model doesn't learn + reuse a volatile channel id from our reply.
      return textResult(`Sent to ${channelLabel(args.channel)}${mentions.length ? `, mentioning ${mentions.length}` : ''}.`);
    }),

    tool('dm_slack_user', S.DM_SLACK_USER_DESC, S.dmSlackUserSchema, async (_id, args: { user: string; text: string }) => {
      const u = await slack.resolveUser(args.user ?? '');
      if (!u) return textResult(`Couldn't find a Slack user matching "${args.user}".`);
      if (u.isBot) return textResult(`"${u.display}" is a bot — you can't DM a bot on Slack.`);
      await slack.dmUser(u.id, args.text ?? '');
      return textResult(`Sent a DM to ${u.display}.`);
    }),

    tool('list_slack_members', S.LIST_SLACK_MEMBERS_DESC, S.listSlackMembersSchema, async (_id, args: { channel?: string }) => {
      const members = await slack.listChannelMembers(args.channel ?? '');
      const people = members.filter((m) => !m.isBot).map((m) => m.display);
      const bots = members.filter((m) => m.isBot).length;
      return textResult(
        people.length
          ? `${people.length} people in the channel: ${people.join(', ')}${bots ? ` (+${bots} bot${bots > 1 ? 's' : ''})` : ''}.`
          : 'No people found in that channel.',
      );
    }),
  ];
}

/**
 * The `send_to_whatsapp` tool — only offered when WhatsApp is configured
 * (`WHATSAPP_TOKEN` + `WHATSAPP_PHONE_NUMBER_ID`), so the model never claims an
 * ability it can't perform. Appended conditionally next to the Slack tools.
 */
export function buildWhatsAppTools(): AgentTool<any>[] {
  if (!whatsapp.whatsappEnabled()) return [];
  return [
    tool('send_to_whatsapp', S.SEND_TO_WHATSAPP_DESC, S.sendToWhatsAppSchema, async (_id, args: { text: string; to?: string; recipients?: string[] }) => {
      const text = args.text ?? '';
      if (!text.trim()) return textResult('Nothing to send — the message text was empty.');

      // Several recipients → fan out to individual 1:1 chats, reporting who got
      // it and who didn't (one bad number doesn't sink the rest).
      const many = (args.recipients ?? []).filter((r) => r?.trim());
      if (many.length > 0) {
        const { sent, failed } = await whatsapp.sendMessageToMany(many, text);
        if (sent.length === 0) return textResult(`Couldn't send the WhatsApp message to anyone: ${failed.map((f) => `${f.to} (${f.error})`).join('; ')}`);
        const okPart = `Sent on WhatsApp to ${sent.length} ${sent.length === 1 ? 'person' : 'people'}`;
        return textResult(failed.length ? `${okPart}, but couldn't reach: ${failed.map((f) => f.to).join(', ')}.` : `${okPart}.`);
      }

      // Single recipient (or the configured default).
      try {
        await whatsapp.sendMessage({ text, to: args.to });
      } catch (err) {
        // A bad recipient / expired token / outside-the-24h-window surfaces here;
        // hand the reason to the brain to narrate rather than failing silently.
        return textResult(`Couldn't send the WhatsApp message: ${err instanceof Error ? err.message : String(err)}`);
      }
      // Say WHO it went to only when the user named a recipient — otherwise just
      // "WhatsApp", so the model doesn't echo a raw default phone number back.
      return textResult(`Sent on WhatsApp${args.to ? ` to ${args.to}` : ''}.`);
    }),
  ];
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

    tool('get_date_time', S.GET_DATE_TIME_DESC, S.getDateTimeSchema, async () => {
      return textResult(await nowFromShell());
    }),

    tool('take_photo', S.TAKE_PHOTO_DESC, S.takePhotoSchema, async (_id, args: { caption?: string; slackChannel?: string }) => {
      // The same live frame source the vision tools use (turn-attached photo first).
      const ctx = deps.getTurnContext();
      const jpegB64 = ctx.imageBase64 ?? (ctx.streamId ? deps.getFaces()?.frame(ctx.streamId) : undefined);
      if (!jpegB64) throw new Error('no camera frame available right now — the stream may be down');
      const channel = args.slackChannel ?? slack.slackDefaultChannel();
      if (slack.slackEnabled() && channel) {
        await slack.uploadFile({
          channel, bytes: Buffer.from(jpegB64, 'base64'), filename: `photo-${Date.now()}.jpg`,
          title: args.caption, initialComment: args.caption,
        });
        return textResult(`Photo sent to Slack${args.caption ? `: ${args.caption}` : ''}.`);
      }
      // No Slack target → return the image so the brain sees + narrates it on the dock.
      return {
        content: [
          { type: 'text', text: args.caption ? `Photo taken: ${args.caption}` : 'Photo taken.' },
          { type: 'image', data: jpegB64, mimeType: 'image/jpeg' },
        ],
        details: undefined,
      } as AgentToolResult<unknown>;
    }),

    tool('record_video', S.RECORD_VIDEO_DESC, S.recordVideoSchema, async (_id, args: { seconds?: number; caption?: string; slackChannel?: string }) => {
      const rec = deps.recordVideo;
      if (!rec) throw new Error('video recording is not available right now');
      const ctx = deps.getTurnContext();
      if (!ctx.streamId) throw new Error('the dock is not streaming video right now');
      const seconds = Math.max(1, Math.min(30, Math.floor(args.seconds ?? 5)));
      // Kick off + return immediately; the watcher uploads/notifies when ready.
      rec.record(ctx.streamId, seconds).then(
        ({ path }) => rec.onClipReady({ path, caption: args.caption, slackChannel: args.slackChannel }),
        (err) => console.error(`[brain] ${deps.dock}: record_video failed`, err),
      );
      const dest = (slack.slackEnabled() && (args.slackChannel ?? slack.slackDefaultChannel())) ? ' and send it to Slack' : '';
      return textResult(`Recording ${seconds}s of video now — I'll share it${dest} when it's ready.`);
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

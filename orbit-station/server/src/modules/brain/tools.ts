/**
 * The dock brain's tools — schemas from schemas.ts (the single model-facing
 * copy), execution wired per the placement table (docs/decision-traces/server-brain-impl.md §1):
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
import { mkdirSync, writeFileSync, readdirSync, unlinkSync, readFileSync } from 'node:fs';
import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core';
import type { FaceToolsApi, PerceptionGroundingApi, MemoryApi, RecognizeOut, RecognizedPerson } from '../perception/index.js';
import type { MemoryRow } from '../perception/memory/store.js';
import type { MotionExecutor } from '../bodylink/motion.js';
import { PRIORITY } from '../bodylink/lease.js';
import type { GateOutcome } from './speech-gate.js';
import type { MoveStep, MoveTiming } from './schemas.js';
import { runVisualSearch, stepsFor, describePose, type Verdict } from './visual-search.js';
import type { RpcBroker } from './rpc.js';
import { SafeCompute } from './safe-compute.js';
import * as S from './schemas.js';
import * as slack from '../../integrations/slack.js';
import * as whatsapp from '../../integrations/whatsapp.js';
import * as last30days from '../../integrations/last30days.js';
import * as websearch from '../../integrations/websearch.js';
import { geminiVision, geminiVisionAgent } from '../perception/summarizer.js';
import { dataPath } from '../../core/data-dir.js';

/** force_get_current summarizes only this tight window around its fresh capture, so
 *  "right now" means now — not the 60s background window (which the LLM already has
 *  passively via grounding). Small enough that the just-captured frame dominates. */
const FORCE_GET_WINDOW_MS = Number(process.env.FORCE_GET_WINDOW_MS ?? 6_000);

// Post-move settle timing for the live-frame capture tools (settledFrame). After a body move,
// wait for the servo to settle (SETTLE_MS) THEN for a frame decoded after that instant, polling
// up to FRAME_DECODE_MAX_MS (the grabber decodes ~1-2 fps, so a fresh frame lands within ~1s).
const SETTLE_MS = Number(process.env.PHOTO_SETTLE_MS ?? 350);       // servo settle (matches visual_search DWELL)
const FRAME_DECODE_MAX_MS = Number(process.env.PHOTO_DECODE_MAX_MS ?? 1_200); // budget to await a post-settle frame
const FRAME_POLL_MS = 80;                                            // poll cadence while awaiting it

/**
 * Choose a LIVE frame that is post-settle if the body moved recently. Pure/testable core of
 * settledFrame (deps injected). `movedAt` = epoch of the last body move (0 = never).
 *   • no recent move (or the whole settle+decode budget already elapsed) → latest frame.
 *   • otherwise poll frameSince(settleInstant) until a post-settle frame lands or the budget
 *     runs out, then fall back to latest. `now`/`sleep` are injectable so tests are deterministic.
 */
export async function pickSettledFrame(opts: {
  movedAt: number;
  latest: () => string | undefined;
  frameSince: (minTs: number) => string | undefined;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  settleMs?: number;
  decodeMaxMs?: number;
  pollMs?: number;
}): Promise<string | undefined> {
  const now = opts.now ?? (() => Date.now());
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const settleMs = opts.settleMs ?? SETTLE_MS;
  const decodeMaxMs = opts.decodeMaxMs ?? FRAME_DECODE_MAX_MS;
  const pollMs = opts.pollMs ?? FRAME_POLL_MS;
  const settleBy = opts.movedAt + settleMs;
  const deadline = settleBy + decodeMaxMs;
  if (!opts.movedAt || now() >= deadline) return opts.latest();
  for (;;) {
    const fresh = opts.frameSince(settleBy);
    if (fresh) return fresh;
    if (now() >= deadline) break;
    await sleep(pollMs);
  }
  return opts.latest();
}

/** how long visual_search's per-pose debug shots live on disk (swept on save). */
const SEARCH_SHOT_TTL_MS = Number(process.env.VS_SHOT_TTL_MS ?? 48 * 3600_000);
/** where visual_search saves found-view shots (cwd-relative to the station process). The photo
 *  tools re-open these by BASENAME so "find X … send it" a few turns later sends the exact
 *  validated frame, not a fresh re-capture (frame-provenance audit, 2026-07-21). */
const SEARCH_SHOT_DIR = dataPath('search');

/** Read a saved found-view shot by basename → base64 JPEG. Basename-only (no separators /
 *  traversal) so a model-supplied handle can't escape the shots dir. undefined if gone. */
function readSearchShot(basename: string): string | undefined {
  if (!/^[a-zA-Z0-9._-]+\.jpg$/.test(basename)) return undefined;
  try { return readFileSync(`${SEARCH_SHOT_DIR}/${basename}`).toString('base64'); }
  catch { return undefined; }
}

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
  /** the triggering utterance's voice fingerprint — lets face tools answer with
   *  BOTH channels ("no one in view, but by voice this is Guru"). */
  voice?: { name: string; score?: number; match?: boolean };
  /** aborted when the TURN dies (cancel / barge-in supersede / dock offline /
   *  timeout). Long-running tools (visual_search) must check it between steps
   *  and stop — the LLM abort alone can't reach a loop inside a tool handler. */
  signal?: AbortSignal;
}

export interface ToolDeps {
  dock: string;
  rpc: RpcBroker;
  motion: MotionExecutor;
  getFaces: () => FaceToolsApi | undefined;
  /** perception grounding facade (force_get_current). Undefined → tool not offered. */
  getGrounding?: () => PerceptionGroundingApi | undefined;
  getGestures: () => Record<string, MoveStep[]>;
  getTurnContext: () => ToolTurnContext;
  /** live video recording (record_video). Undefined → the tool isn't offered. */
  recordVideo?: RecordVideoDeps;
  /** Motion-speech timing (docs/decision-traces/motion-speech-timing.md): the
   *  session's audio-clock barriers the move tool awaits so the body acts in
   *  step with the spoken words. Undefined (tests, bare harnesses) → moves
   *  dispatch immediately, the old behavior. */
  /** Show a picture on the dock's face briefly (the found-view reveal).
   *  Session-wired (a directed show-image frame); optional — old app builds
   *  ignore the frame. */
  showOnFace?: (jpegB64: string, ttlMs: number) => void;
  speech?: {
    /** did this STEP emit spoken text before the tool call? (the part-order default) */
    textThisStep(): boolean;
    /** consume the pending [move] tag's sentence seq, if the reply carried one. */
    takeAnchor(): number | undefined;
    /** resolves when everything spoken so far has finished playing. */
    waitQuiet(): Promise<GateOutcome>;
    /** resolves when sentence `seq` starts playing. */
    waitAnchor(seq: number): Promise<GateOutcome>;
  };
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
 * Cross-dock tools, by GRANT (docs/decision-traces/server-brain-impl.md §2 "cross-dock
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
        textResult(motion.runSteps(target, (args as { steps: MoveStep[] }).steps ?? [], 'move-tool', 'brain-turn')),
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

/**
 * The `web_search` tool — Gemini google_search grounding (integrations/websearch.ts).
 * Only offered when a Gemini key is present. Exists because headless-browser
 * searches are bot-blocked by every engine; the browse skill defers to this.
 */
export function buildWebSearchTools(dock: string): AgentTool<any>[] {
  if (!websearch.webSearchEnabled()) return [];
  return [
    tool('web_search', S.WEB_SEARCH_DESC, S.webSearchSchema, async (_id, args: { query: string }) => {
      try {
        return textResult(await websearch.webSearch(args.query ?? '', dock));
      } catch (err) {
        return textResult(`Couldn't search the web right now: ${err instanceof Error ? err.message : String(err)}`);
      }
    }),
  ];
}

/**
 * The `research_recent` tool — only offered when the last30days CLI is wired
 * (script path configured + a Python 3.12+ on PATH), so the model never claims
 * an ability it can't perform. Appended conditionally next to Slack/WhatsApp.
 */
export function buildResearchTools(): AgentTool<any>[] {
  if (!last30days.last30daysEnabled()) return [];
  return [
    tool('research_recent', S.RESEARCH_RECENT_DESC, S.researchRecentSchema, async (_id, args: { topic: string; context?: string; depth?: 'quick' | 'deep'; days?: number }) => {
      try {
        const brief = await last30days.research({ topic: args.topic, context: args.context, depth: args.depth, days: args.days });
        return textResult(brief);
      } catch (err) {
        // A timeout / bad topic / CLI failure surfaces here; hand the reason to
        // the brain to narrate rather than failing the whole turn silently.
        return textResult(`Couldn't research that right now: ${err instanceof Error ? err.message : String(err)}`);
      }
    }),
  ];
}

/** The capture entrypoint the record_feedback tool calls (the feedback module
 *  implements it). Kept as a plain function type to avoid a module cycle. */
export type FeedbackCaptureFn = (req: {
  dock: string; sessionId?: string; source: 'brain-tool'; reason?: string; detail?: string; turnId?: string;
}) => Promise<{ id: string; file: string }>;

/**
 * record_feedback — the agent's path to flag feedback (docs/features-todo/
 * feedback-flow.md). Snapshots the whole session (handled station-side: the
 * bundler reads the enriched obs record) and writes an MD with the user's words.
 * The DESC tells the model to ask one quick clarifying question when the reason
 * is vague before recording. Built only when the capture fn is wired.
 */
export function buildFeedbackTools(dock: string, sessionId: () => string | undefined, capture?: FeedbackCaptureFn, turnId?: () => string | undefined): AgentTool<any>[] {
  if (!capture) return [];
  return [
    tool('record_feedback', S.RECORD_FEEDBACK_DESC, S.recordFeedbackSchema, async (_id, args: { reason: string; detail?: string }) => {
      try {
        const out = await capture({
          dock, sessionId: sessionId(), source: 'brain-tool',
          reason: args.reason, detail: args.detail, turnId: turnId?.(),
        });
        return textResult(`Feedback recorded (${out.id}) and saved to the feedback folder (.data/feedback/${out.file}) for analysis whenever you'd like to go through it.`);
      } catch (err) {
        return textResult(`Couldn't record the feedback right now: ${err instanceof Error ? err.message : String(err)}`);
      }
    }),
  ];
}

/** end_session — the spoken "start over" / "kill this session". The tool only
 *  MARKS the end (requestEnd): an immediate close would cancel the very turn
 *  it's running in and eat the model's sign-off. The lane closes the session
 *  at turn-settle (the same chokepoint the busy-queue drain uses), so the
 *  goodbye drains first; transitions may look quirky but always recover. */
export function buildSessionTools(requestEnd: () => void, hasTasks: () => boolean): AgentTool<any>[] {
  return [
    tool('end_session', S.END_SESSION_DESC, S.endSessionSchema, async () => {
      const tasks = hasTasks();
      requestEnd();
      return textResult(
        'Session end is scheduled: it closes as soon as you finish speaking this turn. '
        + 'Say a brief sign-off; the next thing anyone says opens a fresh session '
        + '(a short memory note of this conversation carries over).'
        + (tasks ? ' HEADS UP: background tasks running under this session will be STOPPED by the close — mention that.' : ''),
      );
    }),
  ];
}

/** keep_quiet — the agent's "go silent" tool (🤐). Like end_session it only
 *  SETS a flag; the quiet takes hold from the NEXT utterance on, so this turn's
 *  acknowledgement ("okay, going quiet") is still spoken. `setQuiet(untilMs)`:
 *  a future epoch-ms for a timed lock, Infinity for indefinite. The dock can't
 *  un-quiet itself — the person does (voice re-engage isn't wired: quiet skips
 *  turns whole, so there's no LLM to hear "you can talk now"; the UI toggle or a
 *  timed expiry ends it). */
export function buildQuietTools(setQuiet: (untilMs: number) => void): AgentTool<any>[] {
  return [
    tool('keep_quiet', S.KEEP_QUIET_DESC, S.keepQuietSchema, async (_id, args: { minutes?: number }) => {
      const mins = typeof args.minutes === 'number' && args.minutes > 0 ? args.minutes : undefined;
      setQuiet(mins != null ? Date.now() + mins * 60_000 : Infinity);
      return textResult(
        `Quiet mode is scheduled — it starts as soon as you finish speaking this turn. `
        + `Say a brief acknowledgement now (e.g. "okay, going quiet 🤐")`
        + (mins != null
          ? `; you'll go quiet for about ${mins} minute${mins === 1 ? '' : 's'}, then speak again on your own.`
          : ` and go quiet until the person asks you to talk again.`),
      );
    }),
  ];
}

/** Read-only observability access for the inspect tool. */
export interface ObsToolApi {
  /** the enriched session record (turns + enrichment) for a session id. */
  session(sessionId: string): import('../observability/types.js').SessionRecord | undefined;
  /** UX-health summary over a set of turns. */
  health(turns: import('../observability/types.js').TurnRecord[]): import('../observability/health.js').HealthSummary;
  /** a fresh provenance snapshot (version/build/models). */
  provenance(dock: string): unknown;
}

/**
 * inspect_observability — the agent's STRUCTURED SELF-KNOWLEDGE tool. Lets the
 * model answer "what version are you / how fast were you / did you error" and
 * help the user give precise feedback, by reading the same observability the
 * console shows. Returns compact facts (not a raw dump) for the model to narrate.
 */
export function buildObsTools(dock: string, sessionId: () => string | undefined, obs?: ObsToolApi): AgentTool<any>[] {
  if (!obs) return [];
  return [
    tool('inspect_observability', S.INSPECT_OBSERVABILITY_DESC, S.inspectObservabilitySchema, async (_id, args: { aspect: 'version' | 'health' | 'session' | 'all' }) => {
      const want = args.aspect || 'all';
      const sid = sessionId();
      const rec = sid ? obs.session(sid) : undefined;
      const parts: string[] = [];

      if (want === 'version' || want === 'all') {
        parts.push(`VERSION: ${JSON.stringify(obs.provenance(dock))}`);
      }
      if ((want === 'health' || want === 'all') && rec) {
        parts.push(`HEALTH (last ${rec.turns.length} turns): ${JSON.stringify(obs.health(rec.turns))}`);
      }
      if ((want === 'session' || want === 'all') && rec) {
        const turns = rec.turns.map((t, i) => {
          const dur = t.endedAt ? t.endedAt - t.startedAt : undefined;
          const ttft = t.steps.map((s) => s.ttftMs).find((x) => x != null);
          const err = t.steps.some((s) => s.error || s.tools.some((tc) => tc.isError));
          return `  turn ${i + 1} (${t.trigger?.kind ?? '?'}): ${dur ?? '?'}ms${ttft != null ? `, ttft ${ttft}ms` : ''}${err ? ', HAD ERROR' : ''}`;
        }).join('\n');
        parts.push(`SESSION ${rec.sessionId} timings:\n${turns || '  (no turns yet)'}`);
      }
      if (!parts.length) parts.push('No observability data for this session yet (no completed turns).');
      return textResult(parts.join('\n\n'));
    }),
    tool('explain_turn', S.EXPLAIN_TURN_DESC, S.explainTurnSchema, async (_id, args: { back?: number; match?: string }) => {
      const sid = sessionId();
      const rec = sid ? obs.session(sid) : undefined;
      if (!rec) return textResult('No trace for this session yet — nothing to explain.');
      // Completed turns only, newest first. The in-flight turn (this explain_turn
      // call itself) has no endedAt, so it's naturally excluded.
      const done = rec.turns.filter((t) => t.endedAt != null).reverse();
      if (!done.length) return textResult('No completed turns yet — nothing to explain.');
      let turn;
      if (args.match) {
        const needle = args.match.toLowerCase();
        turn = done.find((t) => (t.trigger?.text ?? '').toLowerCase().includes(needle));
        if (!turn) return textResult(`No completed turn matched "${args.match}". Recent triggers: ${done.slice(0, 6).map((t) => JSON.stringify(t.trigger?.text ?? t.trigger?.kind ?? '?')).join(', ')}.`);
      } else {
        const back = Math.max(1, Math.floor(args.back ?? 1));
        turn = done[back - 1];
        if (!turn) return textResult(`Only ${done.length} completed turn(s) exist — can't look back ${back}.`);
      }
      return textResult(renderTurnExplanation(turn));
    }),
  ];
}

/** One compact, model-shaped rendering of a single turn's trace: trigger, each
 *  step's assistant text + tool calls (args/results, truncated), timings, cost.
 *  This is the whole point of explain_turn — one call returns everything the
 *  model needs to answer "why did you do that", so it never has to spelunk raw
 *  obs JSON over multiple slow curls (which blew the turn budget in testing). */
function renderTurnExplanation(t: import('../observability/types.js').TurnRecord): string {
  const clip = (s: unknown, n: number): string => {
    const str = typeof s === 'string' ? s : JSON.stringify(s ?? '');
    return str.length > n ? str.slice(0, n) + '…' : str;
  };
  const dur = t.endedAt ? t.endedAt - t.startedAt : undefined;
  const cost = t.steps.reduce((sum, s) => sum + (s.usage?.cost ?? 0), 0);
  const ttft = t.steps.map((s) => s.ttftMs).find((x) => x != null);
  const lines: string[] = [];
  lines.push(`TURN ${t.turnId} — ${t.state ?? 'unknown state'}`);
  lines.push(`Triggered by: ${t.trigger?.kind ?? '?'}${t.trigger?.text ? ` — "${clip(t.trigger.text, 200)}"` : ''}`);
  const timing = [dur != null ? `${dur}ms total` : null, ttft != null ? `first token ${ttft}ms` : null, `${t.steps.length} step(s)`].filter(Boolean).join(', ');
  lines.push(`Timing/cost: ${timing}${cost ? `, $${cost.toFixed(5)}` : ''}`);
  t.steps.forEach((s, i) => {
    const bits: string[] = [`Step ${i + 1}${s.model ? ` [${s.model}]` : ''}${s.stopReason ? ` (${s.stopReason})` : ''}`];
    if (s.error) bits.push(`  ERROR: ${clip(s.error, 200)}`);
    if (s.text) bits.push(`  said/thought: "${clip(s.text, 240)}"`);
    for (const tc of s.tools) {
      bits.push(`  → ${tc.toolName}(${clip(tc.args, 160)})${tc.isError ? ' [FAILED]' : ''}`);
      if (tc.result != null) bits.push(`     ⇒ ${clip(tc.result, 200)}`);
    }
    lines.push(bits.join('\n'));
  });
  return lines.join('\n');
}

/** Render a memory for the model: id (so it can inspect/update/forget), the claim,
 *  subject, confidence, and when it took effect. Short — the model reads many. */
function fmtMemory(m: MemoryRow): string {
  const when = new Date(m.validFrom).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  const subj = m.subject ? ` about ${m.subject}` : '';
  return `[${m.id.slice(0, 8)}] (${m.type}${subj}, conf ${m.confidence.toFixed(2)}, ${when}) ${m.claim}`;
}

/**
 * The MEMORY tools (docs/perception-to-brain.md 3.2 + Decision 4) — the agent's
 * discover/recall/inspect/mutate surface over its unified per-dock memory. Built
 * conditionally (empty when the memory facade isn't wired), mirroring the Slack/
 * WhatsApp tool sets. Every tool maps to a natural agent intent.
 */
export function buildMemoryTools(dock: string, getMemory: () => MemoryApi | undefined): AgentTool<any>[] {
  const mem = (): MemoryApi => {
    const m = getMemory();
    if (!m) throw new Error('memory is not available right now');
    return m;
  };
  return [
    tool('recall_memory', S.RECALL_MEMORY_DESC, S.recallMemorySchema, async (_id, args: { query?: string; subject?: string; type?: string }) => {
      const rows = await mem().recall({
        dockId: dock, query: args.query, subject: args.subject,
        type: args.type as MemoryRow['type'] | undefined, limit: 12,
      });
      if (rows.length === 0) return textResult('You don\'t have any memories matching that.');
      return textResult(`Your memories:\n${rows.map(fmtMemory).join('\n')}`);
    }),

    tool('list_subjects', S.LIST_SUBJECTS_DESC, { type: 'object', properties: {} }, async () => {
      const subs = mem().subjects(dock);
      return textResult(subs.length ? `You have memories about: ${subs.join(', ')}.` : 'You don\'t have memories about anyone or anything yet.');
    }),

    tool('list_recent', S.LIST_RECENT_DESC, S.listRecentSchema, async (_id, args: { limit?: number }) => {
      const rows = mem().recent(dock, Math.max(1, Math.min(30, Math.floor(args.limit ?? 10))));
      return textResult(rows.length ? `Recent memories:\n${rows.map(fmtMemory).join('\n')}` : 'Nothing in memory yet.');
    }),

    tool('inspect_memory', S.INSPECT_MEMORY_DESC, S.inspectMemorySchema, async (_id, args: { id: string }) => {
      const got = mem().inspect(resolveId(mem(), dock, args.id));
      if (!got) return textResult('No memory with that id.');
      const { memory, lineage } = got;
      const src = lineage.length ? lineage.map((e) => `${e.sourceKind}:${e.sourceId}`).join(', ') : 'something you were told / inferred directly (no recorded source)';
      return textResult(
        `"${memory.claim}" — ${memory.derivation}, confidence ${memory.confidence.toFixed(2)}, ` +
        `learned ${new Date(memory.createdAt).toLocaleString()}. Derived from: ${src}.`,
      );
    }),

    tool('remember', S.REMEMBER_DESC, S.rememberSchema, async (_id, args: { claim: string; subject?: string; type?: string }) => {
      if (!args.claim?.trim()) throw new Error('nothing to remember — the claim was empty');
      await mem().remember({ dockId: dock, type: (args.type as MemoryRow['type']) || 'fact', subject: args.subject, claim: args.claim.trim(), confidence: 0.7 });
      return textResult(`Okay, I'll remember that${args.subject ? ` about ${args.subject}` : ''}.`);
    }),

    tool('update_memory', S.UPDATE_MEMORY_DESC, S.updateMemorySchema, async (_id, args: { id: string; claim: string }) => {
      const newId = await mem().update(resolveId(mem(), dock, args.id), { claim: args.claim });
      return textResult(newId ? 'Updated — that\'s what I\'ll remember now (I kept the old version in my history).' : 'I couldn\'t find that memory to update.');
    }),

    tool('forget_memory', S.FORGET_MEMORY_DESC, S.forgetMemorySchema, async (_id, args: { id: string }) => {
      const ok = mem().forget(resolveId(mem(), dock, args.id));
      return textResult(ok ? 'Done — I\'ve let that go.' : 'I couldn\'t find that memory to forget.');
    }),
  ];
}

/** Resolve a possibly-truncated id (the model sees `[8-char]` prefixes in lists)
 *  to a full id by matching against this dock's recent memories. Falls back to the
 *  raw arg (a full id passed straight through). */
function resolveId(api: MemoryApi, dock: string, idArg: string): string {
  const id = (idArg ?? '').trim();
  if (id.length >= 32) return id; // already a full uuid
  const hit = api.recent(dock, 100).find((m) => m.id.startsWith(id));
  return hit?.id ?? id;
}

/** The face fan-out shared by the set_face TOOL and the inline mood tag
 *  (session #applyMood): body gesture in-process (best-effort) + face UI via
 *  phone RPC, fire-and-forget — the graphic is best-effort UX and must never
 *  block a reply (WI-3); errors go to the log. Single owner so the two mood
 *  paths can't drift (code-review finding). */
export function fireFace(opts: {
  dock: string; motion: MotionExecutor; rpc: RpcBroker;
  gestures: Record<string, MoveStep[]>; turnId: string; toolCallId: string;
  expression: string; warn: (msg: string) => void;
  /** The model's OWN account of why (set_face's `reason`). Carried to the phone
   *  so the face has provenance and the dock can answer "why do you look sad?"
   *  from its record instead of inventing one. Inline `[face:]` tags can't carry
   *  one — they're a single token by design — so they land without it. */
  reason?: string;
}): void {
  try { opts.motion.playGesture(opts.dock, opts.expression, opts.gestures, `face:${opts.expression}`); }
  catch { /* body offline — face still changes */ }
  void opts.rpc.call({
    dock: opts.dock, cap: 'face', turnId: opts.turnId,
    toolCallId: opts.toolCallId, name: 'set_face',
    args: { expression: opts.expression, ...(opts.reason ? { reason: opts.reason } : {}) },
  }).then((ack) => {
    if (ack.isError) opts.warn(`set_face rpc failed: ${ack.content}`);
  }).catch((err) => opts.warn(`set_face rpc failed: ${String(err)}`));
}

/** visual_search's PERSON judge: face-api recognition on the sweep frame.
 *  A confirmed name match lands ≥0.7 (above the engine's found bar); a
 *  tentative match lands in the ambiguous band so the engine takes one
 *  re-look instead of asserting. `offset` = bbox center vs frame center,
 *  −1..1 both axes — what the centering nudges consume. */
/** Identity is UNRELIABLE below this face width in PIXELS: 13-30px faces
 *  matched different household names on consecutive frames of the same scene
 *  (turn-eb459016 → /recognize adjudication over a full sweep). Pixel-based —
 *  not normalized — so a 1280px capture_still legitimately clears the bar
 *  where the 640px stream frame can't. Below the floor a face can still be
 *  REPORTED ("someone too far away"), never identified. */
const MIN_ID_FACE_PX = Number(process.env.VS_MIN_FACE_PX ?? 36);

/** JPEG pixel width from a base64 payload — a bounded SOF-marker scan (no
 *  decoder). Undefined when no SOF is found in the first ~64KB. */
export function jpegWidth(b64: string): number | undefined {
  const buf = Buffer.from(b64.slice(0, 90_000), 'base64');
  for (let i = 2; i < buf.length - 9; ) {
    if (buf[i] !== 0xff) { i++; continue; }
    const marker = buf[i + 1]!;
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return buf.readUInt16BE(i + 7); // SOFn: [len][precision][height][width]
    }
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd9)) { i += 2; continue; }
    i += 2 + (buf.readUInt16BE(i + 2) || 0);
  }
  return undefined;
}

export async function personJudge(f: FaceToolsApi, frameB64: string, target: string, anyone: boolean): Promise<Verdict> {
  const r = await f.recognize({ photo: frameB64 });
  const t = target.toLowerCase();
  const width = jpegWidth(frameB64) ?? 640; // conservative fallback
  const facePx = (p: RecognizedPerson) => p.box.w * width;
  const offsetOf = (p: RecognizedPerson) => ({
    x: (p.box.x + p.box.w / 2 - 0.5) * 2,
    y: (p.box.y + p.box.h / 2 - 0.5) * 2,
  });
  let farFaces = 0;
  for (const p of r.people) {
    if (anyone) {
      // "find anyone": a close-enough face IS the target, named or not.
      if (facePx(p) >= MIN_ID_FACE_PX) {
        return { match: true, confidence: 0.7, label: p.name ?? (p.tentative ? `possibly ${p.tentative}` : 'someone'), offset: offsetOf(p) };
      }
      farFaces++;
      continue;
    }
    if (facePx(p) < MIN_ID_FACE_PX) {
      // too small to trust ANY name the recognizer attaches — count, don't claim.
      farFaces++;
      continue;
    }
    if (p.name?.toLowerCase() === t) {
      // REAL confidence, no floor: a weak confirmed match lands in the
      // ambiguous band and earns a re-look instead of an instant "gotcha".
      return { match: true, confidence: p.confidence, label: p.name, offset: offsetOf(p) };
    }
    if (p.tentative?.toLowerCase() === t) {
      return { match: true, confidence: 0.45, label: `possibly ${p.tentative}`, offset: offsetOf(p) };
    }
  }
  const near = r.people.length - farFaces;
  const bits = [
    near > 0 ? `${near} other ${near === 1 ? 'person' : 'people'} in view` : '',
    farFaces > 0 ? `${farFaces} ${farFaces === 1 ? 'person' : 'people'} too far away to identify` : '',
  ].filter(Boolean);
  return { match: false, confidence: 0, ...(bits.length ? { note: bits.join('; ') } : {}) };
}

/** Parse the VLM judge's strict-JSON verdict; tolerant of fenced/prefixed
 *  output. Returns undefined on garbage (caller retries once, then skips). */
export function parseVlmVerdict(text: string): Verdict | undefined {
  const m = /\{[\s\S]*\}/.exec(text);
  if (!m) return undefined;
  try {
    const j = JSON.parse(m[0]) as { present?: boolean; confidence?: number; label?: string; x?: number; y?: number; note?: string };
    if (typeof j.present !== 'boolean') return undefined;
    const conf = Math.max(0, Math.min(1, Number(j.confidence ?? 0)));
    const clamp1 = (n: unknown) => Math.max(-1, Math.min(1, Number(n ?? 0)));
    return {
      match: j.present,
      confidence: j.present ? conf : 0,
      ...(j.label ? { label: String(j.label).slice(0, 60) } : {}),
      ...(j.present ? { offset: { x: clamp1(j.x), y: clamp1(j.y) } } : {}),
      ...(j.note ? { note: String(j.note).slice(0, 120) } : {}),
    };
  } catch { return undefined; }
}

/** visual_search's OBJECT/open-query judge: gemini flash-lite on the frame,
 *  raw user query passed through — "the white cup", "the TV", "someone in
 *  red". The LLM-side creativity IS the router; no per-case code (P2 design,
 *  2026-07-17). Identity stays face-api's job: the prompt tells the VLM it
 *  cannot verify names, so "find Ramesh" (unenrolled) reports "a person, name
 *  unverifiable" instead of guessing. */
export async function vlmJudge(dock: string, frameB64: string, query: string): Promise<Verdict> {
  const prompt =
    `You are the eyes of a small desk robot scanning a room, one camera frame at a time.\n` +
    `TARGET: "${query}"\n` +
    `Is the target visible in THIS frame? Reply STRICT JSON only, no prose:\n` +
    `{"present":true|false,"confidence":0..1,"label":"short name of what you found",` +
    `"x":-1..1,"y":-1..1,"note":"one short honest observation"}\n` +
    `x,y = target center relative to the FRAME center (+x right, +y down). ` +
    `Be conservative: confidence > 0.6 only when clearly visible. If the target names a ` +
    `SPECIFIC person, you cannot verify identity from a face — report a person's presence ` +
    `in note but present=false unless identity is irrelevant to the ask.`;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const out = await geminiVision(prompt, frameB64, dock);
      const v = parseVlmVerdict(out);
      if (v) return v;
    } catch { /* fall through to retry / give-up */ }
  }
  return { match: false, confidence: 0, note: 'vision judge unavailable for this frame' };
}

/** THE per-frame judge (2026-07-17 simplification, user design): one small
 *  agentic LLM call per photo. The model sees the photo + the raw user query,
 *  and MAY call identify_faces (the robot's face-recognition on the SAME
 *  photo) when identity matters — then answers a strict-JSON verdict. This
 *  replaced hand-fused routing/gates/phantom-checks: the judge weighs the
 *  recognizer's claims against what it can actually SEE (a "Guru" box on a
 *  bookshelf gets disbelieved), and identity is only asserted when a nameable
 *  face is in THIS photo. */
export async function judgeFrame(dock: string, f: FaceToolsApi, frameB64: string, query: string): Promise<Verdict> {
  const known = (f.knownNames?.() ?? []).join(', ') || 'none enrolled';
  const prompt =
    `You are the eyes of a small desk robot scanning a room, one camera photo at a time.
` +
    `TARGET: "${query}"
` +
    `Decide whether the TARGET is visible in THIS photo. Work VISION-FIRST:
` +
    `STEP 1 — from the photo ALONE: how many humans are clearly visible? If the target is a ` +
    `person and you can see NO human, answer {"present":false,...} IMMEDIATELY and do NOT call ` +
    `identify_faces — face recognizers hallucinate faces in furniture and shadows; your own ` +
    `eyes outrank them.
` +
    `STEP 2 — only when a human IS visible and the target names a person (known people: ` +
    `${known}; or "anyone"): call identify_faces to learn who. Trust it only where you can ` +
    `SEE a real face, and treat matches on faces smaller than ~5% of the frame width as unreliable.
` +
    `- For objects/descriptions, judge directly from the photo.
` +
    `Then reply STRICT JSON only, no prose:
` +
    `{"present":true|false,"confidence":0..1,"label":"short name of what you found",` +
    `"x":-1..1,"y":-1..1,"note":"one short honest observation"}
` +
    `x,y = target center relative to the FRAME center (+x right, +y down). Be conservative: ` +
    `confidence > 0.6 only when clearly visible (for a named person: face identified as them).`;
  try {
    const out = await geminiVisionAgent(prompt, frameB64, dock, {
      name: 'identify_faces',
      description: "Run the robot's face recognition on this same photo. Returns each recognized person with name (or 'unknown'), match confidence, position and face size.",
      parameters: { type: 'object', properties: {} },
      run: async () => {
        const r = await f.recognize({ photo: frameB64 });
        if (!r.people.length) return 'no human faces detected in this photo';
        return r.people.map((p) => {
          const who = p.name ?? (p.tentative ? `possibly ${p.tentative}` : 'unknown');
          return `${who} (match ${p.confidence.toFixed(2)}, ${p.side} side, face ${Math.round(p.box.w * 100)}% of frame width)`;
        }).join('; ');
      },
    });
    return parseVlmVerdict(out) ?? { match: false, confidence: 0, note: 'judge answer unparseable for this frame' };
  } catch (e) {
    return { match: false, confidence: 0, note: `judge unavailable (${e instanceof Error ? e.message.slice(0, 60) : 'error'})` };
  }
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

  // The frame visual_search last VALIDATED a target in (the judge's exact frame). "find X and
  // take a photo" must send THIS frame, not a fresh re-capture — otherwise the recognition
  // verdict ("found Guru") is stapled to a different, possibly-stale frame (the balcony bug:
  // provenance drift, docs/decision-traces/thin-client-consolidation.md / the frame-provenance
  // audit). Consumed by the photo tools while fresh (same turn / a few seconds), then cleared.
  let lastFound: { jpeg: string; at: number } | undefined;
  const LAST_FOUND_FRESH_MS = 8_000;
  const takeFoundFrame = (): string | undefined => {
    if (lastFound && Date.now() - lastFound.at < LAST_FOUND_FRESH_MS) {
      const j = lastFound.jpeg; lastFound = undefined; return j; // one-shot: bind to THIS photo only
    }
    return undefined;
  };

  /**
   * A LIVE frame that is POST-SETTLE if the body just moved. `latest()` is the freshest
   * DECODED frame, but the grabber decodes at ~1-2 fps — so right after a body turn (a
   * move tool, or a visual_search that centred on someone) `latest()` is still the
   * PRE-TURN frame. That is the "found you, turned to you, then photographed the empty
   * balcony" bug: take_photo/capture_photo grabbed the stale frame.
   *
   * Fix: if the body moved within a settle window, wait (short budget) for a frame decoded
   * AFTER the move settled — the same post-settle discipline visual_search already uses via
   * frameSince. If nothing moved, or no fresh post-settle frame arrives in time, fall back to
   * latest() so the tool still produces a frame rather than failing.
   */
  const settledFrame = async (streamId: string): Promise<string | undefined> => {
    const f = deps.getFaces();
    if (!f) return undefined;
    return pickSettledFrame({
      movedAt: deps.motion.lastMotionAt(deps.dock),
      latest: () => f.frame(streamId),
      frameSince: (minTs) => f.frameSince(streamId, minTs),
    });
  };

  // OBSERVABILITY: capture tools record HOW the frame was chosen — whether the body had just
  // moved, whether the post-settle wait engaged, and how long it waited. This lands in the obs
  // ToolExecutionEnd result text (session.ts), so a stale-frame regression ("photographed the
  // old view after turning") is diagnosable from the trace, not just from staring at the photo.
  const captureFrame = async (streamId: string): Promise<{ jpeg?: string; obs: string }> => {
    const movedAt = deps.motion.lastMotionAt(deps.dock);
    const t0 = Date.now();
    const jpeg = await settledFrame(streamId);
    const waitedMs = Date.now() - t0;
    const sinceMoveMs = movedAt ? t0 - movedAt : -1;
    const settleEngaged = movedAt > 0 && sinceMoveMs < SETTLE_MS + FRAME_DECODE_MAX_MS;
    const obs = `[frame: ${movedAt ? `moved ${sinceMoveMs}ms ago, ` : 'no recent move, '}settle ${settleEngaged ? `waited ${waitedMs}ms` : 'skipped'}]`;
    return { jpeg, obs };
  };

  return [
    tool('set_face', S.SET_FACE_DESC, S.setFaceSchema, async (
      toolCallId, args: { expression: string; reason?: string },
    ) => {
      if (!S.FACES.includes(args.expression as never)) {
        throw new Error(`unknown expression "${args.expression}"`);
      }
      fireFace({
        dock: deps.dock, motion: deps.motion, rpc: deps.rpc, gestures: deps.getGestures(),
        turnId: deps.getTurnContext().turnId, toolCallId, expression: args.expression,
        reason: args.reason,
        warn: (msg) => console.warn(`[brain] ${deps.dock}: ${msg}`),
      });
      return textResult(`face set to ${args.expression}`);
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

    tool('set_zoom', S.SET_ZOOM_DESC, S.setZoomSchema, async (toolCallId, args: { ratio: number }) => {
      if (!Number.isFinite(args.ratio) || args.ratio <= 0) {
        throw new Error(`invalid zoom ratio "${args.ratio}" — must be a positive number (1.0 = no zoom)`);
      }
      // Camera lives on the phone; RPC down and let it clamp to the device's supported range.
      const ack = await deps.rpc.call({
        dock: deps.dock, cap: 'camera', turnId: deps.getTurnContext().turnId,
        toolCallId, name: 'set_zoom', args,
      });
      if (ack.isError) throw new Error(ack.content);
      return textResult(ack.content || `zoom set to ${args.ratio}×`);
    }),

    tool('move', S.MOVE_DESC, S.moveSchema, async (_toolCallId, args: { steps: MoveStep[]; timing?: MoveTiming }) => {
      // Motion-speech timing (motion-speech-timing.md). Three constructs, in
      // precedence order:
      //   [move] tag in the reply → start when THAT sentence starts playing;
      //   timing:"after_speech"   → start when everything said has been spoken;
      //   default (no timing)     → part order: spoke first this step → after
      //                             those words; tool-first → immediately;
      //   timing:"now"            → immediately (gesture WHILE talking).
      // Every gate falls back to a TTS-length timeout — a lost frame delays a
      // move, never wedges the turn. 'cancelled' means a barge-in/abort won:
      // do NOT move into the interruption.
      const sp = deps.speech;
      const timing = args.timing ?? 'auto';
      if (sp && timing !== 'now') {
        const anchor = timing === 'after_speech' ? undefined : sp.takeAnchor();
        let outcome: GateOutcome | undefined;
        if (anchor != null) outcome = await sp.waitAnchor(anchor);
        else if (timing === 'after_speech' || timing === 'at_tag' || sp.textThisStep()) {
          outcome = await sp.waitQuiet(); // at_tag with no tag → the nearest honest gate
        }
        if (outcome === 'cancelled') {
          return textResult('move skipped — the turn was interrupted before the body started moving');
        }
      }
      // Await ACTUAL servo travel, so the next step's words land after the
      // motion they follow ("did I shake it well?" comes after the shake).
      const { status, done } = deps.motion.runStepsAwaited(deps.dock, args.steps ?? [], 'move-tool', 'brain-turn');
      await done;
      return textResult(status.replace(/^moving:/, 'moved:'));
    }),

    tool('compute', S.COMPUTE_DESC, S.computeSchema, async (_toolCallId, args: { expression: string }) => {
      return textResult(compute.eval(args.expression ?? ''));
    }),

    tool('get_date_time', S.GET_DATE_TIME_DESC, S.getDateTimeSchema, async () => {
      return textResult(await nowFromShell());
    }),

    tool('take_photo', S.TAKE_PHOTO_DESC, S.takePhotoSchema, async (_id, args: { caption?: string; slackChannel?: string; from_shot?: string }) => {
      const ctx = deps.getTurnContext();
      // Frame source, in provenance-preferred order (frame-provenance audit, 2026-07-21):
      //  1. from_shot — an explicit saved found-view handle (durable 48h, survives ACROSS turns:
      //     "find X" now, "send it" a minute later still sends the exact validated frame).
      //  2. lastFound — a same-turn visual_search find (the zero-effort default).
      //  3. turn-attached photo, then 4. a POST-SETTLE live frame (never the pre-turn view).
      const shotName = args.from_shot?.trim().replace(/^.*\//, ''); // basename only
      const fromShot = shotName ? readSearchShot(shotName) : undefined;
      const found = fromShot ? undefined : takeFoundFrame();
      const cap = fromShot ? { jpeg: fromShot, obs: `[frame: from saved shot ${shotName}]` }
        : found ? { jpeg: found, obs: '[frame: visual_search found-view]' }
        : ctx.imageBase64 ? { jpeg: ctx.imageBase64, obs: '[frame: turn-attached photo]' }
        : (ctx.streamId ? await captureFrame(ctx.streamId) : { jpeg: undefined, obs: '[frame: no stream]' });
      // an explicit from_shot that no longer exists is a hard error — don't silently re-shoot
      // a different frame, which is the exact provenance bug we're fixing.
      if (shotName && !fromShot) throw new Error(`that saved view (${shotName}) is no longer available — take a fresh photo instead`);
      const jpegB64 = cap.jpeg;
      if (!jpegB64) throw new Error('no camera frame available right now — the stream may be down');
      const channel = args.slackChannel ?? slack.slackDefaultChannel();
      if (slack.slackEnabled() && channel) {
        await slack.uploadFile({
          channel, bytes: Buffer.from(jpegB64, 'base64'), filename: `photo-${Date.now()}.jpg`,
          title: args.caption, initialComment: args.caption,
        });
        return textResult(`Photo sent to Slack${args.caption ? `: ${args.caption}` : ''}. ${cap.obs}`);
      }
      // No Slack target → return the image so the brain sees + narrates it on the dock.
      return {
        content: [
          { type: 'text', text: (args.caption ? `Photo taken: ${args.caption}` : 'Photo taken.') + ` ${cap.obs}` },
          { type: 'image', data: jpegB64, mimeType: 'image/jpeg' },
        ],
        details: undefined,
      } as AgentToolResult<unknown>;
    }),

    tool('capture_photo', S.CAPTURE_PHOTO_DESC, S.capturePhotoSchema, async (_id, args: { secondsAgo?: number; caption?: string; slackChannel?: string }) => {
      const ctx = deps.getTurnContext();
      const secondsAgo = Math.max(0, Number(args.secondsAgo) || 0);
      // secondsAgo 0 → live frame (same source as take_photo); >0 → look back into the ring.
      // If the requested moment predates the ring, fall back to the live frame so the tool
      // still produces a photo rather than failing (and note the fallback in the caption).
      let jpegB64: string | undefined;
      let missedMoment = false;
      let obs = `[frame: ${secondsAgo}s ago from ring]`;
      if (secondsAgo === 0) {
        // "now" → prefer a just-found frame (visual_search's validated view), else the
        // turn-attached photo, else a POST-SETTLE live frame (never the pre-turn view).
        const found = takeFoundFrame();
        if (found) { jpegB64 = found; obs = '[frame: visual_search found-view]'; }
        else if (ctx.imageBase64) { jpegB64 = ctx.imageBase64; obs = '[frame: turn-attached photo]'; }
        else if (ctx.streamId) { const c = await captureFrame(ctx.streamId); jpegB64 = c.jpeg; obs = c.obs; }
      } else if (ctx.streamId) {
        jpegB64 = deps.getFaces()?.frameAt(ctx.streamId, Date.now() - secondsAgo * 1000);
        if (!jpegB64) { missedMoment = true; const c = await captureFrame(ctx.streamId); jpegB64 = c.jpeg; obs = `[frame: ${secondsAgo}s ago MISSED (past ring) → ${c.obs.slice(1)}`; }
      }
      if (!jpegB64) throw new Error('no camera frame available right now — the stream may be down');
      const when = secondsAgo === 0 ? '' : missedMoment ? ' (that moment is past what I kept — this is the latest)' : ` (from ${secondsAgo}s ago)`;
      const channel = args.slackChannel ?? slack.slackDefaultChannel();
      if (slack.slackEnabled() && channel) {
        await slack.uploadFile({
          channel, bytes: Buffer.from(jpegB64, 'base64'), filename: `photo-${Date.now()}.jpg`,
          title: args.caption, initialComment: args.caption,
        });
        return textResult(`Photo sent to Slack${args.caption ? `: ${args.caption}` : ''}${when}. ${obs}`);
      }
      return {
        content: [
          { type: 'text', text: (args.caption ? `Photo taken: ${args.caption}` : 'Photo taken.') + when + ` ${obs}` },
          { type: 'image', data: jpegB64, mimeType: 'image/jpeg' },
        ],
        details: undefined,
      } as AgentToolResult<unknown>;
    }),

    tool('visual_query', S.VISUAL_QUERY_DESC, S.visualQuerySchema, async (_id, args: { question?: string; secondsAgo?: number }) => {
      const question = (args.question ?? '').trim();
      if (!question) throw new Error('visual_query needs a question');
      const ctx = deps.getTurnContext();
      const secondsAgo = Math.max(0, Number(args.secondsAgo) || 0);
      let frameB64: string | undefined;
      let missedMoment = false;
      let obs = `[frame: ${secondsAgo}s ago from ring]`;
      if (secondsAgo === 0) {
        if (ctx.imageBase64) { frameB64 = ctx.imageBase64; obs = '[frame: turn-attached photo]'; }
        else if (ctx.streamId) { const c = await captureFrame(ctx.streamId); frameB64 = c.jpeg; obs = c.obs; }
      } else if (ctx.streamId) {
        frameB64 = deps.getFaces()?.frameAt(ctx.streamId, Date.now() - secondsAgo * 1000);
        if (!frameB64) { missedMoment = true; const c = await captureFrame(ctx.streamId); frameB64 = c.jpeg; obs = `[frame: ${secondsAgo}s ago MISSED (past ring) → ${c.obs.slice(1)}`; }
      }
      if (!frameB64) throw new Error('no camera frame available right now — the stream may be down');
      // Free-form answer from the single chosen frame (geminiVision = the raw VLM read,
      // not the strict-JSON present/absent verdict the search judges use).
      const prompt =
        `You are the eyes of a small desk robot. Look at THIS single camera frame and answer the ` +
        `question in one or two plain sentences, honestly. If the frame doesn't show enough to answer, ` +
        `say so briefly.\nQUESTION: ${question}`;
      const answer = await geminiVision(prompt, frameB64, deps.dock);
      const note = missedMoment ? ' (that moment is past what I kept, so this is the latest frame)' : '';
      return textResult((answer?.trim() || "I couldn't make anything out in that frame.") + note + ` ${obs}`);
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

    // PERCEPTION (docs/perception-to-brain.md 3.2). force_get_current: a fresh read of
    // THE LIVE MOMENT. It captures a new frame now, then summarizes only a TIGHT window
    // around that capture (FORCE_GET_WINDOW_MS) — NOT the 60s background window. The
    // tool's contract is "right now", and the minute-long "background sense" already
    // rides along in grounding, so the LLM has both cleanly separated: passive 60s
    // context vs. this on-demand instant. (Bug it fixes: a 60s summary drowned a
    // just-held-up hand in a minute of "person at a laptop", so "what do you see now?"
    // described the stale scene.) Offered only when the grounding facade is wired.
    ...(deps.getGrounding ? [
      tool('force_get_current', S.FORCE_GET_CURRENT_DESC, S.forceGetCurrentSchema, async () => {
        const g = deps.getGrounding!();
        if (!g) throw new Error('perception is not available right now');
        const streamId = deps.getTurnContext().streamId;
        const r = await g.forceCurrent(deps.dock, streamId, FORCE_GET_WINDOW_MS);
        if (r.error) throw new Error(`couldn't get a fresh read: ${r.error}`);
        const from = r.window.from.slice(11, 19), to = r.window.to.slice(11, 19);
        return textResult(`Right now (${from}–${to} IST): ${r.summary || '(nothing notable)'}`);
      }),
    ] : []),

    tool('remember_face', S.REMEMBER_FACE_DESC, S.rememberFaceSchema, async (_id, args: { name: string }) => {
      const r = await faces().enroll({ name: args.name ?? '', ...frameOpts() });
      if (!r.ok) throw new Error(r.reason ?? 'could not store the face');
      return textResult(`Okay, I'll remember this person as ${args.name}.`);
    }),

    tool('visual_search', S.VISUAL_SEARCH_DESC, S.visualSearchSchema, async (_id, args: {
      query: string; budget_s?: number; tilt?: 'level' | 'down' | 'up' | 'all';
      resume?: boolean; exclude_current?: boolean;
    }) => {
      const f = faces();
      const ctx = deps.getTurnContext();
      // streamId = the camera PEER id (presence, not stream health). Stills are
      // the sensor, so the search works even when the WebRTC stream is down —
      // only a fully offline phone blocks it.
      if (!ctx.streamId) throw new Error("the phone (my camera) is offline right now — I can't look around");
      if (!deps.motion.isOnline(deps.dock)) throw new Error('the body is offline — I can only check the current view (use recollect_face)');
      const streamId = ctx.streamId;
      const query = (args.query ?? '').trim();
      if (!query) throw new Error('visual_search needs a query (who to find)');
      const anyone = /^(anyone|someone|people|person|a face|faces)$/i.test(query);
      const personQuery = anyone || f.knowsPerson(query); // for the voice-channel note only
      // per-pose cost is ~4-5s (still capture + the agentic judge). User-set
      // floor: cap 45s ("search budget at least 45 seconds"); the session's
      // brainTurnTimeoutMs must leave narration headroom above this.
      const budgetMs = Math.min(Math.max((args.budget_s ?? 30) * 1000, 6_000), 45_000);
      const outcome = await runVisualSearch(deps.dock, {
        pose: () => {
          const t = deps.motion.targets(deps.dock);
          const deg = (us?: number) => ((us ?? 1500) - 1500) / 1000 * 90;
          return { pan: deg(t.foot), tilt: deg(t.neck) };
        },
        moveTo: async (pose) => {
          // CALM scan pacing (user: the sweep felt "super jerky"): pace each hop
          // by travel at ~16ms/° (30° hop ≈ 500ms) instead of the snappier
          // auto-pace, floor 400ms so even a nudge reads as deliberate.
          const t = deps.motion.targets(deps.dock);
          const deg = (us?: number) => ((us ?? 1500) - 1500) / 1000 * 90;
          const travel = Math.max(Math.abs(pose.pan - deg(t.foot)), Math.abs(pose.tilt - deg(t.neck)));
          const duration = Math.min(Math.max(Math.round(travel * 16), 400), 1_600);
          const steps = stepsFor(pose).map((s) => ({ ...s, duration_ms: duration }));
          await deps.motion.runStepsAwaited(deps.dock, steps, `search:${query}`, 'brain-turn').done;
        },
        frameSince: (minTs) => f.frameSince(streamId, minTs),
        judge: (frame) => judgeFrame(deps.dock, f, frame, query),
        captureStill: async () => {
          // identity escalation: a fresh 1280px still from the phone (RPC).
          // Old app builds error the call → undefined → no escalation.
          try {
            const ack = await deps.rpc.call({
              dock: deps.dock, cap: 'camera', turnId: ctx.turnId,
              toolCallId: `still_${Date.now()}`, name: 'capture_still', args: { maxEdge: 1280, quality: 80 },
            });
            return !ack.isError && ack.content && ack.content.length > 10_000 ? ack.content : undefined;
          } catch { return undefined; }
        },
        saveShot: (frame, tag) => {
          // EVERY judged view lands on disk + in the trace (user ask: verify
          // "gotcha"/"not found" against what was actually seen). Time-bounded:
          // shots older than SHOT_TTL are swept on each save, so the debug
          // record self-cleans instead of growing forever.
          const dir = SEARCH_SHOT_DIR;
          mkdirSync(dir, { recursive: true });
          try {
            const cutoff = Date.now() - SEARCH_SHOT_TTL_MS;
            for (const f of readdirSync(dir)) {
              const ts = Number(/-(\d{13})-/.exec(f)?.[1]);
              if (ts && ts < cutoff) { try { unlinkSync(`${dir}/${f}`); } catch { /* */ } }
            }
          } catch { /* best-effort sweep */ }
          const safe = tag.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 24);
          const file = `${dir}/${deps.dock}-${Date.now()}-${safe}.jpg`;
          writeFileSync(file, Buffer.from(frame, 'base64'));
          return file;
        },
        signal: ctx.signal,
        log: (l) => console.log(l),
      }, {
        query, budgetMs, tilt: args.tilt,
        resume: args.resume === true || args.exclude_current === true,
        excludeCurrent: args.exclude_current === true,
      });
      const cov = `(looked at ${outcome.coverage.posesVisited} of ${outcome.coverage.posesPlanned} poses in ${Math.round(outcome.coverage.ms / 1000)}s)`;
      if (outcome.found && outcome.foundFrameB64) {
        // the "gotcha" reveal: float the found view on the face for a few
        // seconds so the user can SEE what the robot saw (user ask 2026-07-17).
        deps.showOnFace?.(outcome.foundFrameB64, 10_000);
        // stash the VALIDATED frame so a following take_photo/capture_photo sends THIS exact
        // frame (the one the judge confirmed the target in) rather than a racy re-capture.
        lastFound = { jpeg: outcome.foundFrameB64, at: Date.now() };
      }
      if (outcome.found) {
        // PARK the found pose with a lease so nothing AMBIENT can wiggle the gaze
        // off what we just centered on (the soft "don't emit a [face:] tag" guard
        // below is advisory; this is the hard one). searchHold(50) outranks
        // moodBit/idle/emotion but yields to a real brain-turn(60) — so the user
        // talking still moves the body — and auto-expires after ~10s, after which
        // whoever wants the body takes it. releaseByHolder on 'search-hold'.
        deps.motion.acquire(deps.dock, 'search-hold', PRIORITY.searchHold, undefined, 10_000);
        // The FACE celebrates, the BODY holds: a [face:] tag in the reply fires
        // gesture choreography that wiggles the gaze off the person we just
        // centered on ("it stops at a different place"). So the tool sets the
        // face VISUALLY here — no playGesture — and the result below forbids
        // the tag. Fire-and-forget; the reply must not wait on the phone.
        void deps.rpc.call({
          dock: deps.dock, cap: 'face', turnId: ctx.turnId,
          toolCallId: `face_${Date.now()}`, name: 'set_face',
          args: { expression: 'excited', reason: `just found ${outcome.candidate?.label ?? 'them'}` },
        }).catch(() => { /* face is cosmetic here */ });
      }
      if (outcome.found && outcome.candidate) {
        const extra = outcome.otherCandidates.length
          ? ` Also spotted: ${outcome.otherCandidates.map((c) => `${c.label} ${describePose(c.pose)}`).join('; ')}.` : '';
        const shotName = outcome.shotPath ? outcome.shotPath.replace(/^.*\//, '') : '';
        const shot = shotName
          ? ` The FOUND VIEW — the exact frame you spotted them in — is saved as "${shotName}". ` +
            `To send a picture of what you found (now OR in a later turn, e.g. the user says "send it" ` +
            `after), call take_photo with from_shot="${shotName}" — that sends THAT validated frame, ` +
            `not a fresh look that might have changed. Never read the handle aloud.`
          : '';
        return textResult(`${outcome.summary} — you are facing them now, and your face is ALREADY set to excited. ` +
          `IMPORTANT: do NOT start this reply with any [face:NAME] tag — a face tag plays body choreography that ` +
          `would swing your gaze off the person you just found. Just speak. ${cov}${extra}${shot}`);
      }
      // person not SEEN — but a matched voice is still an honest signal.
      const v = ctx.voice;
      const heard = personQuery && !anyone && v?.match && v.name.toLowerCase() === query.toLowerCase()
        ? ` You cannot see ${query}, but you can HEAR them — they are nearby, maybe out of view.` : '';
      return textResult(`${outcome.summary} ${cov}${heard}`);
    }),

    tool('recollect_face', S.RECOLLECT_FACE_DESC, S.recollectFaceSchema, async () => {
      const r = await faces().recognize(frameOpts());
      // BOTH channels: the camera not seeing anyone doesn't mean the speaker is
      // unknown — a matched voice identifies them (live turn-4400f066: the model
      // deflected "step into view" at a 47% voice match because this result read
      // as authoritative absence). Same for a visible-but-unrecognized face.
      const v = deps.getTurnContext().voice;
      const byVoice = v?.match && (r.noFace || (!r.name && r.people.length <= 1))
        ? ` By voice, the person speaking is ${v.name}.` : '';
      // Pin the frame recognition ran on, so a follow-up "take a photo of them" sends the
      // frame the verdict was formed in, not a fresh (possibly-changed) view (BUG-3 / the
      // frame-provenance audit). Only when a face was actually seen in it.
      if (r.frameB64 && !r.noFace) lastFound = { jpeg: r.frameB64, at: Date.now() };
      return textResult(describeRecognition(r) + byVoice);
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

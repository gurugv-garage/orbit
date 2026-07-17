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
import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core';
import type { FaceToolsApi, PerceptionGroundingApi, MemoryApi, RecognizeOut } from '../perception/index.js';
import type { MemoryRow } from '../perception/memory/store.js';
import type { MotionExecutor } from '../bodylink/motion.js';
import type { MoveStep } from './schemas.js';
import type { RpcBroker } from './rpc.js';
import { SafeCompute } from './safe-compute.js';
import * as S from './schemas.js';
import * as slack from '../../integrations/slack.js';
import * as whatsapp from '../../integrations/whatsapp.js';
import * as last30days from '../../integrations/last30days.js';

import * as websearch from '../../integrations/websearch.js';
/** force_get_current summarizes only this tight window around its fresh capture, so
 *  "right now" means now — not the 60s background window (which the LLM already has
 *  passively via grounding). Small enough that the just-captured frame dominates. */
const FORCE_GET_WINDOW_MS = Number(process.env.FORCE_GET_WINDOW_MS ?? 6_000);

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
        textResult(motion.runSteps(target, (args as { steps: MoveStep[] }).steps ?? [], 'brain-turn')),
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
  try { opts.motion.playGesture(opts.dock, opts.expression, opts.gestures); }
  catch { /* body offline — face still changes */ }
  void opts.rpc.call({
    dock: opts.dock, cap: 'face', turnId: opts.turnId,
    toolCallId: opts.toolCallId, name: 'set_face',
    args: { expression: opts.expression, ...(opts.reason ? { reason: opts.reason } : {}) },
  }).then((ack) => {
    if (ack.isError) opts.warn(`set_face rpc failed: ${ack.content}`);
  }).catch((err) => opts.warn(`set_face rpc failed: ${String(err)}`));
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

    tool('move', S.MOVE_DESC, S.moveSchema, async (_toolCallId, args: { steps: MoveStep[] }) => {
      return textResult(deps.motion.runSteps(deps.dock, args.steps ?? [], 'brain-turn'));
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

    tool('recollect_face', S.RECOLLECT_FACE_DESC, S.recollectFaceSchema, async () => {
      const r = await faces().recognize(frameOpts());
      // BOTH channels: the camera not seeing anyone doesn't mean the speaker is
      // unknown — a matched voice identifies them (live turn-4400f066: the model
      // deflected "step into view" at a 47% voice match because this result read
      // as authoritative absence). Same for a visible-but-unrecognized face.
      const v = deps.getTurnContext().voice;
      const byVoice = v?.match && (r.noFace || (!r.name && r.people.length <= 1))
        ? ` By voice, the person speaking is ${v.name}.` : '';
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

/**
 * Benchmark runner — exercises the SAME brain code the live dock runs
 * (modules/brain: system prompt, tool schemas, the pi transport) against a set
 * of models, scores each case, and grades answer quality with Claude.
 *
 * Unlike a live turn there's no body: the dock tools are STUBBED to record the
 * call (and feed back a canned/case-specified result) so the loop continues —
 * we're measuring the model's decisions, not actuation. This is the win over
 * the old Kotlin bench: one model-facing surface, tested where it ships.
 */

import {
  Agent,
  type AgentMessage,
  type AgentTool,
  type AgentToolResult,
  type StreamFn,
} from '@earendil-works/pi-agent-core';
import type { TextContent, ImageContent } from '@earendil-works/pi-ai';
import { buildSystemPrompt } from '../brain/prompt.js';
import { resolveModel, apiKeyFor, cappedStreamFn } from '../brain/session.js';
import * as S from '../brain/schemas.js';
import { score, caseImageBase64, type TurnObservation } from './cases.js';
import { gradeCases } from './grader.js';
import type {
  BenchCase, BenchModelSpec, CaseResult, ModelResult, RunResult, Snapshot,
} from './types.js';

const RUNS_PER_CASE = 3;

/** A tool that records its call + returns a case-defined or canned result so
 *  the loop proceeds. Mirrors the real tool's name + schema (so the model sees
 *  exactly the live surface) but never touches hardware. */
function recordingTool(
  name: string,
  description: string,
  parameters: object,
  reply: (args: Record<string, unknown>) => string,
  sink: Array<{ name: string; args: Record<string, unknown> }>,
): AgentTool<any> {
  return {
    name, label: name, description, parameters: parameters as never,
    async execute(_id: string, args: any): Promise<AgentToolResult<unknown>> {
      sink.push({ name, args });
      return { content: [{ type: 'text', text: reply(args) }], details: undefined };
    },
  };
}

/** The full dock tool surface as recording stubs (the live names + schemas). */
function benchTools(
  c: BenchCase,
  sink: Array<{ name: string; args: Record<string, unknown> }>,
): AgentTool<any>[] {
  const replies = c.expect.toolReplies ?? {};
  const r = (tool: string, fallback: string) => () => replies[tool] ?? fallback;
  const tools: AgentTool<any>[] = [
    recordingTool('set_face', S.SET_FACE_DESC, S.setFaceSchema, r('set_face', 'ok'), sink),
    recordingTool('move', S.MOVE_DESC, S.moveSchema,
      (a) => replies.move ?? `ok — running ${(a.steps as unknown[] | undefined)?.length ?? 0} step(s)`, sink),
    recordingTool('compute', S.COMPUTE_DESC, S.computeSchema, r('compute', '42'), sink),
    recordingTool('remember_face', S.REMEMBER_FACE_DESC, S.rememberFaceSchema,
      (a) => replies.remember_face ?? `Okay, I'll remember this person as ${a.name}.`, sink),
    recordingTool('recollect_face', S.RECOLLECT_FACE_DESC, S.recollectFaceSchema,
      r('recollect_face', 'This is Guru.'), sink),
    recordingTool('confirm_face', S.CONFIRM_FACE_DESC, S.confirmFaceSchema,
      (a) => replies.confirm_face ?? `Got it — I'll remember your face better now, ${a.name}.`, sink),
    recordingTool('forget_face', S.FORGET_FACE_DESC, S.forgetFaceSchema,
      r('forget_face', "Sorry about that — I've forgotten it."), sink),
  ];
  // a cross-dock grant case gets the granted move_<target> tool (policy = the
  // brain exposes it only under a grant; here we hand it in directly).
  if (c.expect.grant) {
    const t = c.expect.grant.dock;
    tools.push(recordingTool(`move_${t}`, `Move the body of "${t}" (granted). ${S.MOVE_DESC}`,
      S.moveSchema, () => replies[`move_${t}`] ?? 'ok', sink));
  }
  return tools;
}

/** One model turn for one case → a normalized observation + raw run record. */
async function runOnce(
  spec: BenchModelSpec, c: BenchCase, streamFn?: StreamFn,
): Promise<{ obs: TurnObservation; run: RunResult }> {
  const sink: Array<{ name: string; args: Record<string, unknown> }> = [];
  const model = resolveModel(spec.model);
  const memory = c.expect.seedMemory;
  const agent = new Agent({
    initialState: {
      systemPrompt: buildSystemPrompt({ memory }),
      model, thinkingLevel: 'off',
      tools: benchTools(c, sink) as never,
      messages: [],
    },
    getApiKey: (provider: string) => apiKeyFor(provider),
    streamFn: streamFn ?? cappedStreamFn(),
  } as never);

  const content: (TextContent | ImageContent)[] = [{ type: 'text', text: c.prompt }];
  if (c.image && spec.vision) {
    const b64 = caseImageBase64(c.image);
    if (b64) content.push({ type: 'image', data: b64, mimeType: 'image/jpeg' });
  }

  const t0 = Date.now();
  let firstEventMs = 0;
  const sub = agent.subscribe(() => { if (firstEventMs === 0) firstEventMs = Date.now() - t0; });
  let error: string | null = null;
  try {
    await agent.prompt([{ role: 'user', content, timestamp: Date.now() } as AgentMessage]);
    error = agent.state.errorMessage ?? null;
  } catch (err) {
    error = String(err);
  }
  sub?.();
  const ms = Date.now() - t0;

  const speech = (agent.state.messages
    .filter((m) => (m as { role?: string }).role === 'assistant')
    .flatMap((m) => ((m as { content?: Array<{ type?: string; text?: string }> }).content ?? []))
    .filter((p) => p.type === 'text').map((p) => p.text ?? '').join(' ')).trim();

  const obs: TurnObservation = { speech, toolCalls: sink, error };
  const reasons = score(c.expect, obs);
  return {
    obs,
    run: {
      pass: reasons.length === 0, ms, firstEventMs, output: speech,
      toolCalls: sink.map((t) => ({ name: t.name, args: JSON.stringify(t.args) })),
      error, failReasons: reasons.length ? reasons : undefined,
    },
  };
}

function pct(xs: number[], p: number): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const k = (s.length - 1) * (p / 100);
  const f = Math.floor(k);
  return Math.round(s[f]! + (s[Math.min(f + 1, s.length - 1)]! - s[f]!) * (k - f));
}

export interface RunnerHooks {
  onCase?: (model: string, caseId: string, passRate: number) => void;
  onGrading?: (model: string) => void;
  /** test seam: scripted transport (skips real provider + grader). */
  streamFn?: StreamFn;
  /** skip the Claude quality grade (faster smoke runs). */
  noGrade?: boolean;
  runsPerCase?: number;
}

/** Run every case against one model, N times each, then quality-grade. */
export async function runModel(
  spec: BenchModelSpec, cases: BenchCase[], hooks: RunnerHooks = {},
): Promise<ModelResult> {
  const reps = hooks.runsPerCase ?? RUNS_PER_CASE;
  const results: CaseResult[] = [];
  for (const c of cases) {
    if (c.image && !spec.vision) continue; // text-only model skips vision cases
    const runs: RunResult[] = [];
    for (let i = 0; i < reps; i++) runs.push((await runOnce(spec, c, hooks.streamFn)).run);
    const passRate = runs.filter((r) => r.pass).length / runs.length;
    const lat = runs.map((r) => r.ms);
    results.push({
      id: c.id, capability: c.capability, prompt: c.prompt, image: c.image ?? null,
      n: runs.length, passRate,
      latency: {
        p50: pct(lat, 50), p90: pct(lat, 90), min: Math.min(...lat), max: Math.max(...lat),
        mean: Math.round(lat.reduce((a, b) => a + b, 0) / lat.length),
        firstEventP50: pct(runs.map((r) => r.firstEventMs), 50),
      },
      objective: {
        toolCallRate: `${runs.filter((r) => r.toolCalls.length > 0).length}/${runs.length}`,
        spokeRate: `${runs.filter((r) => r.output.trim().length > 0).length}/${runs.length}`,
        errors: `${runs.filter((r) => r.error).length}/${runs.length}`,
      },
      runs,
    });
    hooks.onCase?.(spec.name, c.id, passRate);
  }

  // quality grade (Claude): one batched call judging the best run per case.
  const issues: string[] = [];
  if (!hooks.noGrade && !hooks.streamFn) {
    hooks.onGrading?.(spec.name);
    try {
      const grades = await gradeCases(spec.name, results);
      for (const r of results) {
        const g = grades[`${r.capability}/${r.id}`];
        if (g) r.quality = g;
      }
    } catch (err) {
      issues.push(`grading failed: ${String(err)}`);
    }
  }

  return {
    name: spec.name, model: spec.model, api: spec.api, vision: spec.vision,
    tier: spec.tier, cost: spec.cost, issues, cases: results,
  };
}

/** Run the whole suite → a snapshot (the viewer's data shape, unchanged). */
export async function runSuite(opts: {
  snapshot: string;
  models: BenchModelSpec[];
  cases: BenchCase[];
  note?: string;
  hooks?: RunnerHooks;
}): Promise<Snapshot> {
  const models: ModelResult[] = [];
  for (const spec of opts.models) {
    models.push(await runModel(spec, opts.cases, opts.hooks));
  }
  return {
    run: {
      snapshot: opts.snapshot, ts: new Date().toISOString(),
      host: process.env.HOSTNAME ?? 'station', note: opts.note ?? null,
      systemPrompt: buildSystemPrompt({}),
    },
    models,
  };
}

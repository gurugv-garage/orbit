/**
 * Quality grader — objective pass/fail says "did it call the right tool"; this
 * says "was the SPOKEN answer actually good". One Claude call per model judges
 * the representative run of each case on a 1–5 scale with a short note. The
 * objective score is the gate; this is the taste test.
 */

import { Agent, type AgentMessage } from '@earendil-works/pi-agent-core';
import type { TextContent } from '@earendil-works/pi-ai';
import { resolveModel, apiKeyFor, cappedStreamFn } from '../brain/session.js';
import type { CaseResult, QualityGrade } from './types.js';

/** Model used to grade (Claude via OpenRouter; falls back through apiKeyFor). */
const GRADER_SPEC = process.env.BENCH_GRADER ?? 'openrouter/anthropic/claude-haiku-4.5';

const GRADER_PROMPT = `You are grading a small desk robot's spoken replies for QUALITY (not correctness — that's already scored separately). The robot speaks aloud, so good = warm, brief, natural, a complete thought; bad = flat, robotic, cut off, or rambling. For each case you get the user's prompt and the robot's best reply. Return ONLY a JSON object mapping "capability/id" → {"score": 1-5, "notes": "<8 words"}. 5 = delightful, 3 = fine, 1 = poor. No prose outside the JSON.`;

export async function gradeCases(
  _modelName: string, results: CaseResult[],
): Promise<Record<string, QualityGrade>> {
  // pick the representative run per case: a passing one if any, else the first.
  const items = results.map((r) => {
    const best = r.runs.find((x) => x.pass) ?? r.runs[0];
    return { key: `${r.capability}/${r.id}`, prompt: r.prompt, reply: best?.output ?? '' };
  }).filter((i) => i.reply.trim().length > 0);
  if (items.length === 0) return {};

  const agent = new Agent({
    initialState: {
      systemPrompt: GRADER_PROMPT,
      model: resolveModel(GRADER_SPEC),
      thinkingLevel: 'off', tools: [], messages: [],
    },
    getApiKey: (provider: string) => apiKeyFor(provider),
    streamFn: cappedStreamFn(4096), // larger: the grade is a JSON object over all cases
  } as never);

  const body = items.map((i) => `[${i.key}]\nuser: ${i.prompt}\nrobot: ${i.reply}`).join('\n\n');
  await agent.prompt([{ role: 'user', content: [{ type: 'text', text: body } as TextContent], timestamp: Date.now() } as AgentMessage]);

  const text = (agent.state.messages.at(-1) as { content?: Array<{ type?: string; text?: string }> })
    ?.content?.filter((c) => c.type === 'text').map((c) => c.text ?? '').join('') ?? '';
  return parseGrades(text);
}

/** Pull the JSON object out of the grader's reply (tolerates code fences). */
function parseGrades(text: string): Record<string, QualityGrade> {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return {};
  try {
    const raw = JSON.parse(m[0]) as Record<string, { score?: number; notes?: string }>;
    const out: Record<string, QualityGrade> = {};
    for (const [k, v] of Object.entries(raw)) {
      const score = typeof v.score === 'number' ? Math.max(1, Math.min(5, Math.round(v.score))) : null;
      out[k] = { score, notes: String(v.notes ?? '') };
    }
    return out;
  } catch {
    return {};
  }
}

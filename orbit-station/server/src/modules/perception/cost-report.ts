/**
 * cost-report — make perception's own Gemini spend visible in the Cost tab.
 *
 * The brain's LLM turns roll up into the Cost tab because they ingest agent-core
 * Session/Turn/Step events (observability sums each StepEnd's `usage`). Perception's
 * Gemini calls (background STT, the window summarizer, the memory embedder) are raw
 * `fetch`es that never emitted any of that — so all of perception's spend was
 * INVISIBLE to the rollup.
 *
 * This helper closes that gap. Given a Gemini response's `usageMetadata`, it
 * computes a list-price cost from a small price table and ingests a SYNTHETIC
 * one-step Turn (TurnStart → StepEnd[usage] → TurnEnd) under the owning dock. The
 * existing `costRollup` then sums it like any brain step — no schema or UI change.
 *
 * Pricing: Gemini returns only token counts, and AUDIO input is priced higher than
 * TEXT input, so we split the prompt tokens by the `promptTokensDetails` modality
 * breakdown. Rates below are Google AI list prices as of 2026-06 (USD per 1M
 * tokens) — update the table when Google changes them.
 */

import { getObsAccess } from '../observability/index.js';
import type { AgentEventDto } from '../observability/types.js';

/** USD per 1,000,000 tokens. `audioIn` defaults to `textIn` when a model has no
 *  separate audio rate (e.g. embeddings, which take no audio). */
interface Price { textIn: number; audioIn?: number; out: number }

// Google AI (Gemini API) list prices, USD / 1M tokens, as of 2026-06.
// Keep keys as the bare model id (no `models/` prefix); matched by prefix so a
// dated/suffixed id (`gemini-2.5-flash-lite-preview-…`) still resolves.
const PRICES: Record<string, Price> = {
  'gemini-2.5-flash-lite': { textIn: 0.10, audioIn: 0.30, out: 0.40 },
  'gemini-2.5-flash':      { textIn: 0.30, audioIn: 1.00, out: 2.50 },
  'gemini-2.5-pro':        { textIn: 1.25, audioIn: 1.25, out: 10.00 },
  'gemini-2.0-flash':      { textIn: 0.10, audioIn: 0.70, out: 0.40 },
  'gemini-2.0-flash-lite': { textIn: 0.075, audioIn: 0.075, out: 0.30 },
  // embeddings (no audio; output isn't billed)
  'gemini-embedding-001':  { textIn: 0.15, out: 0 },
  'text-embedding-004':    { textIn: 0.15, out: 0 },
};

/** Look up a price by longest matching model-id prefix (handles dated suffixes). */
function priceFor(model: string): Price | undefined {
  const id = model.replace(/^models\//, '');
  let best: Price | undefined; let bestLen = 0;
  for (const [k, v] of Object.entries(PRICES)) {
    if (id.startsWith(k) && k.length > bestLen) { best = v; bestLen = k.length; }
  }
  return best;
}

/** The token shape Gemini returns under `usageMetadata`. */
export interface GeminiUsage {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  totalTokenCount?: number;
  /** per-modality prompt breakdown ([{modality:'AUDIO',tokenCount},…]). */
  promptTokensDetails?: Array<{ modality?: string; tokenCount?: number }>;
}

/** input/output token counts + a list-price USD cost from a Gemini usage block. */
export function geminiCost(model: string, usage: GeminiUsage): {
  inputTokens: number; outputTokens: number; cost: number;
} {
  const inputTokens = usage.promptTokenCount ?? 0;
  const outputTokens = usage.candidatesTokenCount ?? 0;
  const price = priceFor(model);
  if (!price) return { inputTokens, outputTokens, cost: 0 }; // unknown model → tokens only
  const audioIn = (usage.promptTokensDetails ?? [])
    .filter((d) => d.modality === 'AUDIO')
    .reduce((n, d) => n + (d.tokenCount ?? 0), 0);
  const textIn = Math.max(0, inputTokens - audioIn);
  const cost =
    (textIn * price.textIn + audioIn * (price.audioIn ?? price.textIn) + outputTokens * price.out) / 1e6;
  return { inputTokens, outputTokens, cost };
}

/** A short, deterministic-enough id from a string + counter (no Math.random in
 *  the hot path; just needs to be unique within a session's turns). */
let seq = 0;
function turnId(label: string): string {
  seq = (seq + 1) % 1e9;
  return `perc-${label}-${seq}`;
}

/**
 * Record one perception Gemini call as a synthetic Turn so it shows up in the Cost
 * tab. `dockId` is the owning dock (the rollup's `source`). `label` (e.g. 'bg-stt')
 * is suffixed onto the model name so the by-model view separates perception spend
 * from brain turns. Best-effort: never throws into the caller (a missing obs
 * module, or a response with no usage, is silently skipped).
 */
export function reportGeminiCost(
  dockId: string, model: string, label: string, usage: GeminiUsage | undefined, ts: number,
): void {
  if (!usage || usage.promptTokenCount == null) return; // no usage → nothing to bill
  const obs = getObsAccess();
  if (!obs) return;
  const { inputTokens, outputTokens, cost } = geminiCost(model, usage);
  const sessionId = `perception:${dockId}`;     // one rolling session per dock
  const id = turnId(label);
  const base = { sessionId, source: dockId, turnId: id };
  const ev = (over: Partial<AgentEventDto>): AgentEventDto =>
    ({ ...base, seq: 0, kind: 'TurnStart', ts, ...over } as AgentEventDto);
  // model name carries the call's role so the by-model breakdown is self-describing.
  const labeledModel = `${model.replace(/^models\//, '')} (${label})`;
  // trigger.text carries the role tag (e.g. 'bg-stt') so the Cost tab's use-case
  // axis can classify it without parsing the model-name suffix.
  obs.ingest(ev({ kind: 'TurnStart', data: { trigger: { kind: 'perception', text: label } } }), dockId);
  obs.ingest(ev({ kind: 'StepStart' }), dockId);
  obs.ingest(ev({ kind: 'StepEnd', data: { model: labeledModel, usage: { inputTokens, outputTokens, cost } } }), dockId);
  obs.ingest(ev({ kind: 'TurnEnd' }), dockId);
}

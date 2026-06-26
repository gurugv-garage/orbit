/**
 * CONSOLIDATE — the long-term memory curator's CREATE op
 * (docs/decision-traces/long-term-memory-curator.md §2/§5/§6).
 *
 * Promotes the salient bits of a SOURCE window (short-term memory) into NEW durable
 * beliefs (long-term), event-time aligned, with lineage back to the observations.
 *
 * This is the CREATE side — the one that can fabricate from a noisy feed — so:
 *  • salience is the LLM's call over the (aligned) window (§6), conservative bar;
 *  • it's handed "what you already know" so it adds only the genuinely new (de-dup);
 *  • each belief carries modest confidence + lineage; reconcile prunes later (§4).
 *
 * Pure: prompt + parse + plan are side-effect-free; the loop injects the LLM + store.
 *
 * QUALITY BACKLOG (observed on the first live flood — mechanism is solid, these are
 * tuning; tracked in long-term-memory-curator.md §8a):
 *  • SUBJECT (who a belief is about) is intentionally NOT forced — identity/vision is
 *    not yet stable, so demanding "who" would attach wrong names. The prompt uses
 *    present-at WHEN available and omits otherwise. Revisit once vision/identity is
 *    stable enough to anchor reliably.
 *  • DE-DUP / MERGE across passes is weak — related utterances can become several
 *    near-duplicate beliefs. We pass "already known" + ask to merge, but it leaks;
 *    reconcile is meant to collapse the rest and doesn't fully yet.
 *  • HALLUCINATION on thin/garbled transcript — the grounding-guard proves a belief
 *    traces to SOME utterance, not that the utterance MEANT it. Mitigated by the
 *    conservative prompt + the confidence CLAMP (a one-window distill can't assert
 *    near-certainty) + reconcile pruning; not eliminated (accepted, per §4).
 */
import type { Observation } from './sources.js';
import type { BeliefHit } from './reconcile.js';

/** A belief the LLM proposes promoting. `support` lists the observation lineageIds it
 *  was drawn from (must be ones we showed it — the grounding guard). */
export interface ProposedBelief {
  type?: string;
  subject?: string;
  claim: string;
  confidence?: number;
  support?: string[];
}

export interface ConsolidateVerdict {
  beliefs?: ProposedBelief[];
}

/** A validated belief to write: claim + axes + the lineage edges (snapshot back-links). */
export interface NewBeliefPlan {
  type: string;
  subject?: string;
  claim: string;
  confidence: number;
  lineage: Array<{ sourceKind: string; sourceId: string }>;
}

/** Default confidence for a derived belief when the LLM gives none — modest, because a
 *  belief distilled from a noisy live transcript is uncertain; reconcile + corroboration
 *  adjust it later (§4). Env-tunable, one knob (not a farm). */
export const CONSOLIDATE_CONFIDENCE = Number(process.env.PERCEPTION_CONSOLIDATE_CONF ?? 0.4);
/** Cap on how confident a single-pass derived belief may claim to be — a fresh distill
 *  from one short window should NOT assert near-certainty (observed: the model returning
 *  0.8 on a thin transcript fragment). Corroboration over time can raise it past this via
 *  reconcile; consolidate itself is clamped. */
export const CONSOLIDATE_CONFIDENCE_MAX = Number(process.env.PERCEPTION_CONSOLIDATE_CONF_MAX ?? 0.6);

const TYPES = new Set(['person', 'preference', 'event', 'fact', 'place', 'summary']);

/** Build the consolidate prompt: the event-time-aligned window + what we already know
 *  (so it ADDS only the new), asking the LLM to judge salience itself (§6). */
export function consolidatePrompt(observations: Observation[], known: BeliefHit[]): string {
  const obs = observations
    .map((o) => {
      const who = o.presentAt ? ` [present: ${o.presentAt}]` : '';
      const spk = o.speaker != null ? ` (speaker ${o.speaker})` : '';
      const raw = o.raw ? `  (raw: "${o.raw}")` : '';
      return `- [${o.lineageId}] ${o.atIso}${who}${spk}: "${o.text}"${raw}`;
    })
    .join('\n');
  const knownList = known.length
    ? known.map((b) => `- (${b.type}${b.subject ? `, ${b.subject}` : ''}) ${b.claim}`).join('\n')
    : '(none yet)';
  return (
    'You are the long-term memory of a small desk robot, deciding what from a window of '
    + 'recent observations is worth REMEMBERING durably.\n\n'
    + '=== ALREADY KNOWN (do NOT repeat or restate these; only add what is genuinely new) ===\n'
    + `${knownList}\n\n`
    + '=== RECENT OBSERVATIONS (each prefixed with [lineageId], the time, and — when known '
    + '— who was present / the speaker) ===\n'
    + `${obs}\n\n`
    + 'Decide what genuinely deserves durable memory — a stated preference, plan, goal, '
    + 'opinion, or a notable fact/event. You judge salience; most chit-chat is NOT worth '
    + 'keeping.\n\n'
    + 'RULES:\n'
    + '• Be CONSERVATIVE — only what is clearly supported by the observations; never infer '
    + 'or invent. If a transcript fragment is unclear, skip it rather than guess.\n'
    + '• Each claim is a COMPLETE, standalone sentence that reads on its own (not a fragment, '
    + 'not starting mid-thought). MERGE several utterances on one topic into ONE belief rather '
    + 'than emitting many tiny overlapping ones.\n'
    + '• SUBJECT is optional — set it only when you actually know who/what the belief is about '
    + '(a present person or a clear speaker). When unknown, OMIT it; do NOT invent a name or '
    + 'guess. (Identity is not always available.)\n'
    + '• CONFIDENCE reflects how clearly the observations support the belief — a one-window '
    + 'distill from a live transcript is rarely certain; use ~0.3–0.5 for most, higher only '
    + 'when explicit and unambiguous.\n'
    + '• Cite the observation [lineageId]s each belief came from in "support".\n'
    + 'Return STRICT JSON (no prose, no code fence):\n'
    + '{\n'
    + '  "beliefs": [ { "type": "person|preference|event|fact|place|summary", '
    + '"subject": "who/what, or omit if unknown", "claim": "a complete sentence", '
    + '"confidence": 0.0-1.0, "support": ["<lineageId>", ...] } ]\n'
    + '}\n'
    + 'If nothing is worth keeping, return {} or an empty array.'
  );
}

export function parseConsolidate(text: string): ConsolidateVerdict {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) return {};
  try {
    const obj = JSON.parse(text.slice(start, end + 1)) as ConsolidateVerdict;
    return obj && typeof obj === 'object' ? obj : {};
  } catch {
    return {};
  }
}

/**
 * Validate proposed beliefs into a write plan. GROUNDING GUARD: drop a belief with no
 * `support` that maps to an observation we actually showed (so a belief invented out of
 * nothing — not traceable to any observation — is rejected). Lineage edges are built
 * from the validated support ids. Empty claims dropped; type defaulted/clamped.
 */
export function consolidatePlan(
  v: ConsolidateVerdict, knownLineageIds: ReadonlySet<string>, confMax = CONSOLIDATE_CONFIDENCE_MAX,
): NewBeliefPlan[] {
  const out: NewBeliefPlan[] = [];
  for (const b of v.beliefs ?? []) {
    const claim = b?.claim?.trim();
    if (!claim) continue;
    const support = (b.support ?? []).filter((s) => knownLineageIds.has(s));
    if (support.length === 0) continue; // ungrounded → reject (the consolidate guard)
    const type = b.type && TYPES.has(b.type) ? b.type : 'fact';
    // clamp into [0, MAX] — a single-pass distill must not assert near-certainty
    // (reconcile/corroboration can raise it past MAX over time, consolidate cannot).
    const raw = typeof b.confidence === 'number' ? b.confidence : CONSOLIDATE_CONFIDENCE;
    const confidence = Math.max(0, Math.min(confMax, raw));
    out.push({
      type,
      subject: b.subject?.trim() || undefined,
      claim,
      confidence,
      lineage: support.map((sourceId) => ({ sourceKind: 'snapshot', sourceId })),
    });
  }
  return out;
}

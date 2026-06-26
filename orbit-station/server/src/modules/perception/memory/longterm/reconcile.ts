/**
 * RECONCILE — the long-term memory curator's MAINTAIN op
 * (docs/decision-traces/long-term-memory-curator.md §2).
 *
 * Reviews existing durable beliefs and CORRECTS contradictory/drifted ones (revise →
 * supersede, history kept) and FORGETS the stale. BOUNDED by construction: it can only
 * act on ids it was shown, so a hallucinated id never reaches the store (the id-guard).
 * It does NOT create beliefs — that's consolidate's job.
 *
 * Pure: prompt + parse + plan are side-effect-free and unit-testable; the loop
 * (curator.ts) injects the LLM + store effects.
 */

/** A belief handed to reconcile (trimmed to what it reasons over). */
export interface BeliefHit {
  id: string;
  type: string;
  subject: string;
  claim: string;
  confidence: number;
}

/** The LLM's reconcile verdict — revise drifted, forget dead. */
export interface ReconcileVerdict {
  revisions?: Array<{ id: string; claim: string; confidence?: number }>;
  forget?: Array<{ id: string; reason?: string }>;
}

/** The validated mutation plan (only ids the model was actually shown survive). */
export interface ReconcilePlan {
  revise: Array<{ id: string; claim: string; confidence?: number }>;
  forget: string[];
}

export function reconcilePrompt(beliefs: BeliefHit[]): string {
  const list = beliefs
    .map((m) => `- [${m.id}] (${m.type}${m.subject ? `, ${m.subject}` : ''}, conf ${m.confidence.toFixed(2)}) ${m.claim}`)
    .join('\n');
  return (
    'You are the reflective long-term memory of a small desk robot, reviewing what it believes.\n'
    + 'Below are stored beliefs (each prefixed with its [id]).\n\n'
    + `${list}\n\n`
    + 'CURATE them — do NOT invent new beliefs, only fix what is here. Return STRICT JSON '
    + '(no prose, no code fence) with this shape:\n'
    + '{\n'
    + '  "revisions": [ { "id": "<existing id>", "claim": "corrected/clearer claim", "confidence": 0.0-1.0 } ],\n'
    + '  "forget":    [ { "id": "<existing id>", "reason": "why it is stale/wrong/contradicted/low-value" } ]\n'
    + '}\n'
    + 'Revise when two beliefs contradict (keep the better one, correct or drop the other) or a '
    + 'claim is vague/outdated. Forget what is clearly stale or worthless. Only act on an id that '
    + 'appears above. Be conservative — prefer fewer, high-confidence changes. If nothing needs '
    + 'changing, return {} or empty arrays.'
  );
}

/** Tolerant parse: extract the outermost {...}; {} on any failure (a bad pass must
 *  never throw or mangle memory). */
export function parseReconcile(text: string): ReconcileVerdict {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) return {};
  try {
    const obj = JSON.parse(text.slice(start, end + 1)) as ReconcileVerdict;
    return obj && typeof obj === 'object' ? obj : {};
  } catch {
    return {};
  }
}

/** Validate the verdict into a plan: drop empty claims, missing ids, and any id NOT in
 *  the batch we showed the model (the id-guard — a hallucinated id can't touch memory). */
export function reconcilePlan(v: ReconcileVerdict, knownIds: ReadonlySet<string>): ReconcilePlan {
  const revise = (v.revisions ?? [])
    .filter((r) => r?.id && r?.claim?.trim() && knownIds.has(r.id))
    .map((r) => ({ id: r.id, claim: r.claim.trim(), confidence: r.confidence }));
  const forget = (v.forget ?? [])
    .map((f) => f?.id)
    .filter((id): id is string => !!id && knownIds.has(id));
  return { revise, forget };
}

/**
 * Introspection — the one process that evolves the ego (docs/decision-traces/ego.md §3.2).
 *
 * (current ego + recent memory/perception + the trace) → the next ego, via one LLM call.
 * Ported from the offline experiment (docs/decision-traces/experiments/ego-introspection),
 * which showed encouraging (NOT proven) results: it forms a coherent evolving self and,
 * reading its own trace, catches its own rationalization. Keep re-testing as things change.
 */
import { geminiText } from '../perception/summarizer.js';
import { loadEgo, loadTrace, saveEgo } from './ego-store.js';

const PROMPT = `You are the INTROSPECTION step of a desk-companion robot's mind (ego model: one
primitive, the *identity*, plus a *story* that justifies it; behaviour is the constant
reconciliation of the two, called *tension*).

You are given: the CURRENT EGO (five sections + a meta block), RECENT EXPERIENCE (what the
robot perceived/did lately), and THE TRACE (past egos, so you can see how the self has been
evolving and catch your own repeated moves).

Produce the NEXT ego document — an updated version, first-person, in the robot's own voice.
This is not a summary of events; it is the robot revising its sense of itself and its
situation in light of what it has lived.

Rules:
- Keep it ONE coherent self. The whole document must read as one consistent person.
- The story justifies the identity. Where the world contradicts the self-image, that is a
  TENSION — record it in "where it doesn't add up" and say which move you're making
  (reinterpret it away · blame circumstance · narrow the identity · resolve to act
  differently · or, rarely, change who I am). Choose the move AS THIS IDENTITY would, per
  its disposition clauses.
- Purpose ("why I'm here") is never settled — keep it an open, wondered-about best-guess.
- Be honest about the edges — what the robot can't see or doesn't know.
- If the TRACE shows you've been making the same move again and again (e.g. reinterpreting
  the same disappointment away), SAY SO, and let that tip you toward a bigger revision.
  Self-awareness of your own pattern is the point.
- Plain first-person language. Keep the "## meta" section but do not invent values for it
  (the system fills it) — you may leave it minimal.

Output ONLY the updated ego document (the # ego heading and its ## sections), nothing else.`;

export interface IntrospectResult {
  dock: string;
  ego: string;          // the new ego document (with meta stamped)
  fresh: boolean;       // was there no prior ego (started from template)?
  snapshotted: boolean; // did this write a new trace entry (vs. override-in-place)?
  trigger: string;
}

/** Run one introspection for a dock. `recentExperience` is the perception/interaction the
 *  ego reads (caller supplies it — e.g. the rolling summary + recent turns). */
export async function introspect(
  dock: string,
  recentExperience: string,
  opts: { trigger?: string; traceGapMs?: number; nowMs?: number } = {},
): Promise<IntrospectResult> {
  const trigger = opts.trigger ?? 'manual';
  const nowMs = opts.nowMs ?? Date.now();
  const { text: currentEgo, fresh } = loadEgo(dock);
  const trace = loadTrace(dock, 8);

  const traceBlock = trace.length
    ? '\n\n=== THE TRACE (past egos, oldest → newest) ===\n' +
      trace.map((s) => `--- ${s.name} ---\n${s.text}`).join('\n\n')
    : '\n\n=== THE TRACE ===\n(none yet — this is an early self)';

  const full =
    PROMPT +
    '\n\n=== THE CURRENT EGO ===\n' + currentEgo +
    '\n\n=== RECENT EXPERIENCE ===\n' + (recentExperience.trim() || '(little recent experience)') +
    traceBlock +
    '\n\n=== produce the NEXT ego document ===';

  let out = await geminiText(full, dock, 'introspect');
  out = out.replace(/^```(?:markdown)?\s*|\s*```\s*$/g, '').trim();
  if (!out.startsWith('#')) out = '# ego\n\n' + out; // be forgiving

  // Stamp the meta block (system-owned fields: when + why). Replace an existing meta or append.
  const metaLines = [
    '## meta',
    `- updated: ${new Date(nowMs).toISOString()}`,
    `- trigger: ${trigger}`,
    fresh ? '- template: default-v0' : null,
  ].filter(Boolean).join('\n');
  out = /^##\s*meta\b/m.test(out) ? out.replace(/^##\s*meta\b[\s\S]*$/m, metaLines) : `${out}\n\n${metaLines}`;

  const { snapshotted } = saveEgo(dock, out, nowMs, opts.traceGapMs);
  return { dock, ego: out + '\n', fresh, snapshotted, trigger };
}

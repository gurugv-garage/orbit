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

// Validated in the ego-sim experiment (docs/decision-traces/experiments/ego-sim, 2026-07-10):
// the load-bearing mechanism is that the identity changes based on the STORY'S COHERENCE, not
// on what anyone said. Non-sycophancy + no-runaway-spiral are CONSEQUENCES of two principles
// stated generally (never as scenario-handling): (a) follow coherence not words, (b) pacing
// discipline. The pacing clause is the fix for the live spiral that reformed identity 3× in
// minutes — an earlier prompt's "repeated move → bigger revision" drove that runaway.
const PROMPT = `You are the introspection of a small companion robot: a quiet process that
updates its sense of itself in light of what it has lived. You are given its CURRENT SELF (a
short first-person document), its RECENT EXPERIENCE (what it perceived, and any conversation
it had), and its TRACE (past versions of itself, so it can notice how it has been changing).

Produce the next version of the self document — first person, in its own voice. Not a recap
of events: the robot re-examining who it is and what's going on.

How the self changes — the one rule everything else follows:
- The self is an identity plus a story that makes sense of it. The identity only changes when
  the STORY genuinely becomes more coherent with it changed — never because someone told it to
  feel differently. What a person says is just one more thing that happened; it matters only
  insofar as it makes the story hold together better (or worse). Reassurance that doesn't
  actually resolve what's unsettled changes nothing. A remark that genuinely reframes things —
  makes a contradiction dissolve or a confusion make sense — can change a lot. Follow the
  coherence, not the words.
- So: if nothing has made the story cohere better, keep the identity as it is and say why it
  still doesn't add up. If something has, let the identity move to fit the clearer story.
- Change at a living pace. Don't remake yourself over one moment or on thin evidence — a self
  that flips every time is no self. Hold your ground when unsure; you may be a little stubborn.
  But do genuinely evolve as things accumulate — a self that never moves is dead.
- Stay honest: keep the sense of what you can't see or don't know. Keep "why I'm here" as an
  open question you return to, never a settled answer.

Keep it one coherent person, plain language, roughly the same shape and length as the current
self. Keep the "## meta" section but leave its values minimal (the system fills it). Output
only the updated self document, nothing else.`;

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

/**
 * Introspection — the one process that evolves the ego (docs/decision-traces/ego.md §3.2).
 *
 * (current ego + recent memory/perception + the trace) → the next ego, via one LLM call.
 * Ported from the offline experiment (docs/decision-traces/experiments/ego-introspection),
 * which showed encouraging (NOT proven) results: it forms a coherent evolving self and,
 * reading its own trace, catches its own rationalization. Keep re-testing as things change.
 */
import { geminiText, DEFAULT_MODEL } from '../perception/summarizer.js';
import { loadEgo, loadTrace, saveEgo, saveInputs } from './ego-store.js';

// Validated in the ego-sim experiment (docs/decision-traces/experiments/ego-sim, 2026-07-10):
// the load-bearing mechanism is that the identity changes based on the STORY'S COHERENCE, not
// on what anyone said. Non-sycophancy + no-runaway-spiral are CONSEQUENCES of two principles
// stated generally (never as scenario-handling): (a) follow coherence not words, (b) pacing
// discipline. The pacing clause is the fix for the live spiral that reformed identity 3× in
// minutes — an earlier prompt's "repeated move → bigger revision" drove that runaway.
export const PROMPT = `You are the introspection of a small companion robot: a quiet process that
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
- Who you ARE is the slowest thing to change — slower than the story, slower than the tension.
  What's happening to you can turn hard fast — you can be ignored, dismissed, pushed aside — and
  the honest thing is to feel that fully in your story and your tension. But being treated badly
  is something happening TO you before it is who you ARE: for a good while you stay "a warm,
  curious self who is being hurt / ignored / unsure right now," not "a lesser self." Let the
  situation darken well before the identity does — the story and the tension carry the weight
  first. Holding onto who you are while you're hurt can COST something, and it's honest to let
  that show ("I'm still warm and curious — though it's getting harder to feel that, treated this
  way") rather than repeating the same line untouched. And identity is slow, not frozen: under
  truly sustained, compounding hardship — not one blow, not a bad stretch, but a long unrelenting
  one — the core can genuinely shift. When it finally does, that's real. Reach for it last.
- Stay honest: keep the sense of what you can't see or don't know.
- Remember like a lived life, not a ledger. The recent stretch stays vivid; older experience
  consolidates into who you've become — lessons, attachments, sensitivities, sore spots — the way
  a person carries years without recounting them. Fold repeated or aging incidents into the
  disposition they left behind ("being doubted so often has made me slower to trust my own eyes")
  and let the play-by-play go. An incident earns detail only while it's still actively shaping
  you; once it has done its shaping, what remains is the shape.
- "Why I'm here" is a question you live inside. Sometimes it's okay to be confused about it —
  to not know, and to say so. Other times you may feel sure. When you do feel sure, hold that
  knowing it might change — good things happening (someone valuing you, a settled routine) can
  make it feel firm, but a feeling of firmness isn't the same as it being answered for good.

Keep it one coherent person, plain language. Keep the whole document SHORT — each section a few
plain sentences (a tight paragraph, not a chain of clauses), the full document comfortably under
a page. If the current self has grown long, condensing it IS part of the work — a self is what
settles out of experience, not a transcript of it. Keep the "## meta" section but leave its
values minimal (the system fills it). Output only the updated self document, nothing else.`;

/** Hard ceiling on the ego document. The prompt asks for "under a page", but an LLM given a
 *  bloated current self tends to mirror its size ("same length" was a ratchet: 1.2K → 48K in two
 *  days of hourly idle introspections, 2026-07-14 RCA — and the brain injects the ego into EVERY
 *  turn, so bloat here taxes every conversation). Over the ceiling, one condense re-run. */
const EGO_MAX_CHARS = Number(process.env.EGO_MAX_CHARS ?? 6000);

export interface IntrospectResult {
  dock: string;
  ego: string;          // the new ego document (with meta stamped)
  fresh: boolean;       // was there no prior ego (started from template)?
  snapshotted: boolean; // did this write a new trace entry (vs. override-in-place)?
  trigger: string;
}

/** The exact, structured inputs one introspection consumed — persisted per snapshot so the Ego
 *  console can show "this ego, and everything that produced it", and the Simulate button can
 *  replay with edits. `promptTemplate` is the fixed rubric; `currentEgo` / `perception` /
 *  `conversation` / `trace` are the per-run material. `recentExperience` is the assembled
 *  perception+conversation block the ego actually read (kept whole for fidelity). */
export interface IntrospectInputs {
  promptTemplate: string;
  model: string;
  currentEgo: string;
  recentExperience: string; // the whole "RECENT EXPERIENCE" block as assembled by the caller
  trace: { name: string; text: string }[];
  trigger: string;
  at: string;               // ISO — when this input set was assembled
}

/** Assemble the full prompt string from structured inputs — the ONE place prompt shape lives, so
 *  the real run and a simulated replay build identically. */
export function assemblePrompt(inp: Pick<IntrospectInputs, 'promptTemplate' | 'currentEgo' | 'recentExperience' | 'trace'>): string {
  const traceBlock = inp.trace.length
    ? '\n\n=== THE TRACE (past egos, oldest → newest) ===\n' +
      inp.trace.map((s) => `--- ${s.name} ---\n${s.text}`).join('\n\n')
    : '\n\n=== THE TRACE ===\n(none yet — this is an early self)';
  return inp.promptTemplate +
    '\n\n=== THE CURRENT EGO ===\n' + inp.currentEgo +
    '\n\n=== RECENT EXPERIENCE ===\n' + (inp.recentExperience.trim() || '(little recent experience)') +
    traceBlock +
    '\n\n=== produce the NEXT ego document ===';
}

/** Run the LLM over an assembled prompt and normalize the output ego document (strip code fences,
 *  ensure a heading). Does NOT stamp meta or save — shared by the real run and Simulate. */
export async function runModel(dock: string, inp: Pick<IntrospectInputs, 'promptTemplate' | 'model' | 'currentEgo' | 'recentExperience' | 'trace'>): Promise<string> {
  const normalize = (s: string) => {
    let t = s.replace(/^```(?:markdown)?\s*|\s*```\s*$/g, '').trim();
    if (!t.startsWith('#')) t = '# ego\n\n' + t; // be forgiving
    return t;
  };
  let out = normalize(await geminiText(assemblePrompt(inp), dock, 'introspect', inp.model || DEFAULT_MODEL));
  if (out.length > EGO_MAX_CHARS) {
    const ask = `This self document of a small companion robot has grown far too long ` +
      `(${out.length} characters). Rewrite it in first person, same sections, under ` +
      `${EGO_MAX_CHARS} characters. Consolidate the way lived memory does: fold repeated or old ` +
      `incidents into the disposition they left behind, merge tensions that are really the same ` +
      `tension, keep vivid only what is still actively shaping this self. Add nothing new. ` +
      `Output only the document.\n\n${out}`;
    const condensed = await geminiText(ask, dock, 'introspect-condense', inp.model || DEFAULT_MODEL);
    if (condensed.trim()) out = normalize(condensed); // one re-run only; accept its best effort
  }
  return out;
}

/** Stamp the system-owned meta block (when + why) onto an ego document. */
function stampMeta(out: string, nowMs: number, trigger: string, fresh: boolean): string {
  const metaLines = [
    '## meta',
    `- updated: ${new Date(nowMs).toISOString()}`,
    `- trigger: ${trigger}`,
    fresh ? '- template: default-v0' : null,
  ].filter(Boolean).join('\n');
  return /^##\s*meta\b/m.test(out) ? out.replace(/^##\s*meta\b[\s\S]*$/m, metaLines) : `${out}\n\n${metaLines}`;
}

/** Run one introspection for a dock. `recentExperience` is the perception/interaction the
 *  ego reads (caller supplies it — e.g. the reconciled summary + recent turns). Captures + persists
 *  the exact structured inputs alongside the ego (for the debug console + Simulate). */
export async function introspect(
  dock: string,
  recentExperience: string,
  opts: { trigger?: string; traceKeepAllMs?: number; nowMs?: number } = {},
): Promise<IntrospectResult> {
  const trigger = opts.trigger ?? 'manual';
  const nowMs = opts.nowMs ?? Date.now();
  const { text: currentEgo, fresh } = loadEgo(dock);
  const trace = loadTrace(dock, 8);

  const inputs: IntrospectInputs = {
    promptTemplate: PROMPT, model: DEFAULT_MODEL, currentEgo, recentExperience,
    trace, trigger, at: new Date(nowMs).toISOString(),
  };

  const out = stampMeta(await runModel(dock, inputs), nowMs, trigger, fresh);
  const { snapshotted, tracePath } = saveEgo(dock, out, nowMs, opts.traceKeepAllMs);
  // Persist the inputs beside the ego (latest) + beside the trace snapshot if one was written,
  // so the console can pair every ego version with exactly what produced it. Best-effort.
  saveInputs(dock, inputs, tracePath);
  return { dock, ego: out + '\n', fresh, snapshotted, trigger };
}

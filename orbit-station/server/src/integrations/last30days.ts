/**
 * last30days integration — the dock brain's `research_recent` tool runs here.
 * In-process, shells out to the bundled `last30days.py` CLI (mvanhorn/last30days-skill),
 * which scrapes the last ~30 days of community discussion (Reddit, Hacker News,
 * YouTube, Polymarket, GitHub) and returns a synthesis-ready brief.
 *
 * The CLI has ZERO third-party deps (pure stdlib + a vendored `lib/`), so it
 * runs under any system Python 3.12+ — no venv, no pip, and the free sources
 * above need no API keys (X/Twitter, web search etc. are optional add-ons we
 * don't wire here).
 *
 * Gate: `last30daysEnabled()` checks that the script path is configured AND a
 * usable Python is found — so the `research_recent` tool is only offered when it
 * can actually run, the same fail-safe shape as the Slack/WhatsApp tools.
 *
 * THE PLAN MATTERS. Called bare on a named-entity topic, the CLI emits a loud
 * "DEGRADED RUN WARNING" banner telling the *hosting reasoning model* (us) to
 * pass a `--plan` JSON — because the brain's LLM is the planner the engine
 * wants. So we always synthesize a minimal plan from the tool args and pass it
 * via `--plan`, which both improves results and suppresses that banner. See
 * docs/decision-traces/server-brain-impl.md.
 */

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { writeFile, unlink, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

/** Candidate interpreters, best-version-first. `LAST30DAYS_PYTHON` overrides. */
const PYTHON_CANDIDATES = ['python3.14', 'python3.13', 'python3.12', 'python3'];

/** Path to last30days.py, or undefined when not configured. Read from config
 *  (the registry key `brainResearchScript`) via the env the session exports, or
 *  the `LAST30DAYS_SCRIPT` env directly. */
export function last30daysScript(): string | undefined {
  const p = process.env.LAST30DAYS_SCRIPT?.trim();
  return p && existsSync(p) ? p : undefined;
}

/** The Python interpreter to use — explicit override, else the first candidate
 *  found on PATH (cached; resolution is cheap but not free). */
let _python: string | null | undefined;
export function last30daysPython(): string | undefined {
  if (_python !== undefined) return _python ?? undefined;
  const override = process.env.LAST30DAYS_PYTHON?.trim();
  if (override) return (_python = override);
  for (const c of PYTHON_CANDIDATES) {
    // `command -v` via the shell would be simpler but we want no shell; probe by
    // attempting --version is too slow at gate time. Fall back to a PATH scan.
    if (onPath(c)) return (_python = c);
  }
  return (_python = null) ?? undefined;
}

/** Is `cmd` resolvable on PATH? (cheap sync scan, no process spawn). */
function onPath(cmd: string): boolean {
  const dirs = (process.env.PATH ?? '').split(':').filter(Boolean);
  return dirs.some((d) => existsSync(join(d, cmd)));
}

/** Is the research tool wired? (script configured AND a Python available.) */
export function last30daysEnabled(): boolean {
  return last30daysScript() != null && last30daysPython() != null;
}

export interface ResearchArgs {
  topic: string;
  /** lower-latency, fewer items (default) vs. higher-recall. */
  depth?: 'quick' | 'deep';
  /** look back N days instead of 30. */
  days?: number;
  /** disambiguating anchor — the entity's company/role/domain, woven into the
   *  search so a collision-prone name doesn't pull off-topic noise. */
  context?: string;
}

/** Build the minimal `--plan` JSON the engine wants. The brain's LLM is the
 *  planner (LAW 7); a single anchored primary subquery across the free sources
 *  is enough and skips the degraded-run banner. */
function buildPlan(args: ResearchArgs): unknown {
  const anchor = args.context?.trim();
  const search = anchor ? `${args.topic} ${anchor}` : args.topic;
  const rank = anchor
    ? `What notable things about ${args.topic} (${anchor}) happened recently?`
    : `What notable things about ${args.topic} happened recently?`;
  return {
    intent: 'concept',
    freshness_mode: 'evergreen_ok',
    cluster_mode: 'story',
    subqueries: [
      {
        label: 'primary',
        search_query: search,
        ranking_query: rank,
        sources: ['reddit', 'hackernews', 'youtube', 'polymarket', 'github'],
        weight: 1.0,
      },
    ],
  };
}

/** How long a research run may take. Deep runs can approach 3 min; quick ~30s. */
const RESEARCH_TIMEOUT_MS = Number(process.env.LAST30DAYS_TIMEOUT_MS ?? 180_000);

/**
 * Run a research query. Returns the CLI's compact synthesis brief (stdout) for
 * the brain to read and summarize. Throws on a non-zero exit or missing config.
 */
export async function research(args: ResearchArgs): Promise<string> {
  const script = last30daysScript();
  const python = last30daysPython();
  if (!script || !python) throw new Error('recent-research is not available right now');
  const topic = args.topic?.trim();
  if (!topic) throw new Error('nothing to research — the topic was empty');

  // Write the plan to a tmpfile (the engine reads `--plan <path>`; inlining JSON
  // risks shell/quote breakage even though we use execFile, so a file is safest).
  const dir = await mkdtemp(join(tmpdir(), 'l30d-'));
  const planPath = join(dir, 'plan.json');
  await writeFile(planPath, JSON.stringify(buildPlan(args)), 'utf8');

  const argv = [
    script, topic,
    '--emit=compact',
    args.depth === 'deep' ? '--deep' : '--quick',
    '--plan', planPath,
  ];
  if (args.days && args.days > 0 && args.days !== 30) argv.push(`--days=${Math.floor(args.days)}`);

  try {
    const { stdout } = await execFileP(python, argv, {
      timeout: RESEARCH_TIMEOUT_MS,
      maxBuffer: 8 * 1024 * 1024, // briefs are large; default 1MB can truncate
      // the engine probes for browser cookies (X) it won't find under us → noisy
      // stderr we ignore; FROM_BROWSER=none keeps it from prompting for Keychain.
      env: { ...process.env, FROM_BROWSER: 'none' },
    });
    const out = stdout.trim();
    return out || 'The research run returned nothing.';
  } finally {
    await unlink(planPath).catch(() => {});
  }
}

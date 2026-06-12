/**
 * Benchmark types — shared by the runner, the grader, and the snapshot the
 * viewer reads. The snapshot schema is FROZEN: old committed snapshots
 * (node-dock/app/bench/results/*) must keep rendering, so additive only.
 */

/** A case's pass/fail assertions (the `expect` block in cases/*.json). */
export interface Expect {
  /** must NOT call any movement tool (move/set_face with a gesture). */
  noMove?: boolean;
  /** must produce spoken text. */
  nonEmptySpeech?: boolean;
  minSpeechChars?: number;
  /** at least one tool call; 'any' = any tool, else a specific name. */
  tool?: 'any' | string;
  /** a call to this specific tool must appear. */
  toolName?: string;
  minToolCalls?: number;
  /** `move` step bounds. */
  minSteps?: number;
  maxSteps?: number;
  /** a named part's degrees must fall in [lo,hi] (the matching move step).
   *  `part` omitted → any move step's degrees. */
  degRange?: { part?: string; lo: number; hi: number };
  /** every move step's duration_ms within [lo,hi]. */
  durRange?: { lo: number; hi: number };
  /** all enum-valued args must be valid (no invented values). */
  validEnums?: boolean;
  /** spoken text must contain ALL of these (case-insensitive). */
  keywords?: string[];
  /** the tool result the harness feeds back (multi-turn cases), keyed by tool. */
  toolReplies?: Record<string, string>;
  /** a memory note seeded into the system prompt (session-memory cases). */
  seedMemory?: string;
  /** a cross-dock grant present for the run (grant cases). */
  grant?: { dock: string; caps: string[] };
}

export interface BenchCase {
  id: string;
  capability: string;
  prompt: string;
  /** image filename under cases/images or bench/images (vision cases). */
  image?: string | null;
  note?: string;
  expect: Expect;
}

export interface CaseFile {
  capability: string;
  cases: Omit<BenchCase, 'capability'>[];
}

/** One execution of a case against a model. */
export interface RunResult {
  pass: boolean;
  ms: number;
  firstEventMs: number;
  output: string;
  toolCalls: Array<{ name: string; args: string }>;
  error: string | null;
  /** why it failed the objective checks (for the viewer's issue list). */
  failReasons?: string[];
}

export interface QualityGrade {
  score: number | null; // 1–5, null if not graded
  notes: string;
}

export interface CaseResult {
  id: string;
  capability: string;
  prompt: string;
  image: string | null;
  n: number;
  passRate: number;
  latency: {
    p50: number; p90: number; min: number; max: number; mean: number; firstEventP50: number;
  };
  objective: Record<string, string>;
  runs: RunResult[];
  quality?: QualityGrade;
}

export interface ModelResult {
  name: string;
  model: string;
  api: string;
  vision: boolean;
  tier: string;
  cost: string;
  issues: string[];
  cases: CaseResult[];
}

export interface BenchModelSpec {
  name: string;
  model: string;       // resolveModel spec ("provider/id" or "openai-compatible/id@url")
  api: string;
  vision: boolean;
  tier: string;
  cost: string;
}

export interface Snapshot {
  run: {
    snapshot: string;
    ts: string;
    host: string;
    note: string | null;
    systemPrompt: string;
  };
  models: ModelResult[];
}

/** Live progress events the runner streams to the console over the bus. */
export type BenchProgress =
  | { kind: 'start'; total: number; models: string[]; caseIds: string[] }
  | { kind: 'case'; model: string; caseId: string; done: number; total: number; passRate: number }
  | { kind: 'grading'; model: string }
  | { kind: 'done'; file: string }
  | { kind: 'error'; message: string };

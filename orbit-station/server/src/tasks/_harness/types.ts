/**
 * Task harness types.
 *
 * A task definition is a single `task.ts`: a doc-comment goal, a `manifest`
 * (name/description/params), and a CLASS that `extends Task` (see ./task.ts) and
 * implements run() + getStatus(). The file ends with `runTask(MyTask)`. The task
 * runs as its OWN process and talks to the station over the WS `tasks` topic.
 */

/** One typed input knob declared by a definition's manifest. */
export interface TaskParam {
  name: string;
  type: 'string' | 'number' | 'boolean' | 'duration' | 'string[]';
  required?: boolean;
  default?: unknown;
  description?: string;
}

export interface TaskManifest {
  name: string;
  description: string;
  /** the input schema — key/vals validated at run_task. */
  params?: TaskParam[];
  /** The LLM this task's own reasoning (this.ask / this.agent / vision sugar) runs
   *  on, as a "provider/model" spec (e.g. "google/gemini-2.5-flash-lite"). Baked in
   *  at authoring time: the author picks from the dock's allowed task models trading
   *  SPEED (a tight camera-watch loop wants a fast/cheap model) against ACCURACY (a
   *  careful judgement wants a stronger one). Omitted = the dock's default brain
   *  model. The user changes it like any other task edit (just ask the brain). */
  model?: string;
}

/** Parse a duration string ("5s", "10m", "1h", "500ms") or a number (ms) to ms. */
export function durationMs(v: unknown): number {
  if (typeof v === 'number') return v;
  if (typeof v !== 'string') return 0;
  const m = v.trim().match(/^(\d+(?:\.\d+)?)\s*(ms|s|m|h)?$/i);
  if (!m) return 0;
  const n = parseFloat(m[1]!);
  switch ((m[2] ?? 'ms').toLowerCase()) {
    case 'h': return n * 3_600_000;
    case 'm': return n * 60_000;
    case 's': return n * 1_000;
    default: return n;
  }
}

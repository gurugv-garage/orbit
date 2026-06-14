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

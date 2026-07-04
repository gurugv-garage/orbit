/**
 * Conductor module — one cheap per-dock CONDUCTOR (docs/decision-traces/conductor-v1-design.md).
 *
 * Ticks ~1 Hz per dock: assemble the cheap `world`, run `reconcile` over the registered
 * CONDUCTED things (the pure core in conducted.ts/reconcile.ts), enacting via the supervisor
 * (a TASK, kind:'task' → faceFollow) and the brain's WakeApi (a BEHAVIOUR, kind:'behaviour' →
 * wakeUp's hardcoded wake-phrase check). No always-on LLM. Body contention is the lease's job;
 * the conductor only decides WHETHER a thing runs.
 *
 * Reads are LAZY getters (same pattern as the brain's getBrainAccess/getWakeApi) so module
 * load order doesn't matter. The conducting POLICY is the tested pure core; this file is the
 * I/O glue + the ~1 Hz loop + REST.
 */
import { json } from '../../core/http.js';
import type { RouteContext, StationModule } from '../../core/module.js';
import { CONDUCTED, wakeTunings, type ConductedState, type World, type Tunings } from './conducted.js';
import { reconcile, type Effects } from './reconcile.js';

const TICK_MS = 1000;

export interface ConductorWiring {
  /** docks to conduct (live roster). */
  docks: () => string[];
  /** the `conductor` config json: { dock: { name: {tunings} } }. */
  config: () => Record<string, Record<string, Tunings>> | undefined;
  /** conversation mode for a dock ('idle'|'listening'|'thinking'|'speaking'|'followup') or null. */
  convMode: (dock: string) => string | null;
  /** running task instances on a dock (for world.tasks + the task-kind effects). */
  tasks: (dock: string) => Array<{ name: string; instanceId: string; parentSessionId?: string; startedAt: number; state: string }>;
  /** start/stop a task by NAME (the conductor owns one instance per conducted task). */
  startTask: (dock: string, taskName: string) => void;
  stopTask: (dock: string, instanceId: string) => void;
  /** lease holder of a dock's body (the bodylink motion executor). */
  bodyHolder: (dock: string) => { holder: string; priority: number } | null;
  /** set/clear a dock's wakeUp config (the brain's WakeApi) — enacting the wakeUp BEHAVIOUR. */
  setWake: (dock: string, cfg: { enabled: boolean; phrase: string; prompt: string; aliases?: string[] } | null) => void;
  /** best-effort presence (someone in view) — optional; v1 conducted things don't require it. */
  present?: (dock: string) => boolean;
}

interface DockState {
  conducted: Map<string, ConductedState>;
  /** epoch of the last NON-idle conversation mode (drives faceFollow's idle clock). */
  lastConversationMs: number;
  /** manual overrides (the "Run now"/"Stop" buttons): name → forced state, overriding its rule
   *  until cleared. A 'run' pin holds it on; an 'off' pin holds it off. */
  override: Map<string, 'run' | 'off'>;
}

export function conductorModule(w: ConductorWiring): StationModule {
  const docks = new Map<string, DockState>();
  let timer: NodeJS.Timeout | undefined;

  const dockState = (dock: string): DockState => {
    let s = docks.get(dock);
    if (!s) { s = { conducted: new Map(), lastConversationMs: 0, override: new Map() }; docks.set(dock, s); }
    return s;
  };

  /** map a task's origin to who started it: the conductor's own tasks → 'self'; a task under
   *  an open conversation session → 'brain' (refine to 'user' later). */
  const initiatorOf = (taskName: string): 'user' | 'brain' | 'self' =>
    CONDUCTED.some((c) => c.kind === 'task' && c.taskName === taskName) ? 'self' : 'brain';

  const assembleWorld = (dock: string, st: DockState, now: number): World => {
    const mode = w.convMode(dock) ?? 'idle';
    const listening = mode === 'listening' || mode === 'followup';
    const turnActive = mode === 'thinking' || mode === 'speaking' || listening;
    if (turnActive) st.lastConversationMs = now; // stamp activity → resets faceFollow's idle clock
    const tasks = w.tasks(dock).filter((t) => t.state === 'running').map((t) => ({
      name: t.name, instanceId: t.instanceId, initiator: initiatorOf(t.name), ageMs: now - t.startedAt,
    }));
    return {
      now, present: w.present?.(dock) ?? false, lastPresenceMs: 0, identity: null,
      listening, turnActive, lastConversationMs: st.lastConversationMs,
      bodyHolder: w.bodyHolder(dock), tasks,
    };
  };

  const tunFor = (dock: string) => (name: string): Tunings => {
    const cfg = w.config() ?? {};
    return cfg[dock]?.[name] ?? {};
  };

  const fx = (dock: string): Effects => ({
    isTaskRunning: (_d, taskName) => w.tasks(dock).some((t) => t.name === taskName && t.state === 'running'),
    startTask: (_d, taskName) => w.startTask(dock, taskName),
    stopTask: (_d, taskName) => {
      for (const t of w.tasks(dock)) if (t.name === taskName && t.state === 'running') w.stopTask(dock, t.instanceId);
    },
    setBehaviour: (_d, name, on, tunings) => {
      if (name === 'wakeUp') {
        const wt = wakeTunings(tunings);
        w.setWake(dock, on ? { enabled: true, phrase: wt.phrase, prompt: wt.prompt, aliases: wt.aliases } : null);
      }
    },
    onTransition: (_d, name, from, to, why) => {
      console.log(`[cond] ${dock} ${name}: ${from}→${to} (${why})`);
    },
  });

  const tick = () => {
    const now = Date.now();
    for (const dock of w.docks()) {
      const st = dockState(dock);
      try {
        reconcile(dock, CONDUCTED, assembleWorld(dock, st, now), st.conducted, tunFor(dock), fx(dock),
          (name) => st.override.get(name));
      } catch (err) {
        console.error(`[cond] ${dock}: reconcile failed`, err);
      }
    }
  };

  /** A read-only snapshot of a dock's conducted things for the REST/console surface. */
  const snapshot = (dock: string) => {
    const st = docks.get(dock);
    const cfg = (w.config() ?? {})[dock] ?? {};
    return CONDUCTED.map((c) => {
      const tunings = { ...c.defaults, ...(cfg[c.name] ?? {}) };
      const self = st?.conducted.get(c.name);
      const running = c.kind === 'task'
        ? w.tasks(dock).some((t) => t.name === c.taskName && t.state === 'running')
        : self?.desired === 'running';
      return { name: c.name, kind: c.kind, desired: self?.desired ?? 'off', running, tunings,
        override: st?.override.get(c.name) ?? null,
        instrumentedAt: c.instrumentedAt ?? null, taskName: c.taskName ?? null };
    });
  };

  return {
    name: 'conductor',
    topic: 'conductor',
    description: 'per-dock conductor: governs lifecycle + config of behaviours (wakeUp) + tasks (faceFollow) by tunable rules',
    async init() {
      timer = setInterval(tick, TICK_MS);
      timer.unref?.(); // never block process exit; no explicit shutdown hook in StationModule
    },
    route(ctx: RouteContext): boolean {
      const { req, res, subPath } = ctx;
      // GET /api/conductor/:dock — each conducted thing's live state + tunings + any override.
      const g = subPath.match(/^\/([^/]+)$/);
      if (g && req.method === 'GET') {
        json(res, 200, { dock: decodeURIComponent(g[1]!), conducted: snapshot(decodeURIComponent(g[1]!)) });
        return true;
      }
      // POST /api/conductor/:dock/:name/(run|stop|auto) — manual override (the "Run now" /
      // "Stop" / "Auto" buttons). run = force on; stop = force off; auto = clear the override
      // (back to the rule). Applied immediately.
      const a = subPath.match(/^\/([^/]+)\/([^/]+)\/(run|stop|auto)$/);
      if (a && req.method === 'POST') {
        const dock = decodeURIComponent(a[1]!); const name = decodeURIComponent(a[2]!); const action = a[3]!;
        if (!CONDUCTED.some((c) => c.name === name)) { json(res, 404, { error: 'unknown conducted thing' }); return true; }
        const st = dockState(dock);
        if (action === 'auto') st.override.delete(name);
        else st.override.set(name, action === 'run' ? 'run' : 'off');
        console.log(`[cond] ${dock} ${name}: override → ${action}`);
        tick(); // apply immediately, don't wait for the next cadence tick
        json(res, 200, { dock, name, override: st.override.get(name) ?? null });
        return true;
      }
      return false;
    },
  };
}

/**
 * Orchestrator module — one cheap per-dock conductor (docs/decision-traces/orchestrator-v1-design.md).
 *
 * Ticks ~1 Hz per dock: assemble the cheap `world`, run `reconcile` over the registered
 * behaviours (the pure core in behaviours.ts/reconcile.ts), enacting via the supervisor
 * (kind:'task') and the brain's WakeApi (kind:'inproc'). No always-on LLM. Body contention is
 * the lease's job; the orchestrator only decides WHETHER a behaviour runs.
 *
 * Reads are LAZY getters (same pattern as the brain's getBrainAccess/getWakeApi) so module
 * load order doesn't matter. The conducting POLICY is the tested pure core; this file is the
 * I/O glue + the ~1 Hz loop + REST.
 */
import { json } from '../../core/http.js';
import type { RouteContext, StationModule } from '../../core/module.js';
import { BEHAVIOURS, initBehaviourState, type BehaviourState, type World, type Tunings } from './behaviours.js';
import { reconcile, type Effects } from './reconcile.js';

const TICK_MS = 1000;

export interface OrchestratorWiring {
  /** docks to conduct (live roster). */
  docks: () => string[];
  /** the `orchestrator` config json: { dock: { behaviour: {tunings} } }. */
  config: () => Record<string, Record<string, Tunings>> | undefined;
  /** conversation mode for a dock ('idle'|'listening'|'thinking'|'speaking'|'followup') or null. */
  convMode: (dock: string) => string | null;
  /** running task instances on a dock (for world.tasks + the task-kind effects). */
  tasks: (dock: string) => Array<{ name: string; instanceId: string; parentSessionId?: string; startedAt: number; state: string }>;
  /** start/stop a task by NAME (the orchestrator owns one instance per behaviour task). */
  startTask: (dock: string, taskName: string) => void;
  stopTask: (dock: string, instanceId: string) => void;
  /** lease holder of a dock's body (the bodylink motion executor). */
  bodyHolder: (dock: string) => { holder: string; priority: number } | null;
  /** set/clear a dock's wakeUp config (the brain's WakeApi). */
  setWake: (dock: string, cfg: { enabled: boolean; phrase: string; prompt: string } | null) => void;
  /** best-effort presence (someone in view) — optional; v1 behaviours don't require it. */
  present?: (dock: string) => boolean;
}

interface DockState {
  behaviours: Map<string, BehaviourState>;
  /** epoch of the last NON-idle conversation mode (drives faceFollow's idle clock). */
  lastConversationMs: number;
}

export function orchestratorModule(w: OrchestratorWiring): StationModule {
  const docks = new Map<string, DockState>();
  let timer: NodeJS.Timeout | undefined;

  const dockState = (dock: string): DockState => {
    let s = docks.get(dock);
    if (!s) { s = { behaviours: new Map(), lastConversationMs: 0 }; docks.set(dock, s); }
    return s;
  };

  /** map a task's origin to who started it: the orchestrator's own behaviour tasks → 'self';
   *  a task under an open conversation session → 'user'/'brain'. v1 marks orchestrator-owned
   *  faceFollow as 'self', everything else 'brain' (refine later). */
  const initiatorOf = (taskName: string): 'user' | 'brain' | 'self' =>
    BEHAVIOURS.some((b) => b.kind === 'task' && b.taskName === taskName) ? 'self' : 'brain';

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

  const tunFor = (dock: string) => (behaviour: string): Tunings => {
    const cfg = w.config() ?? {};
    return cfg[dock]?.[behaviour] ?? {};
  };

  const fx = (dock: string, st: DockState): Effects => ({
    isTaskRunning: (_d, taskName) => w.tasks(dock).some((t) => t.name === taskName && t.state === 'running'),
    startTask: (_d, taskName) => w.startTask(dock, taskName),
    stopTask: (_d, taskName) => {
      for (const t of w.tasks(dock)) if (t.name === taskName && t.state === 'running') w.stopTask(dock, t.instanceId);
    },
    setInproc: (_d, behaviour, on, tunings) => {
      if (behaviour === 'wakeUp') {
        w.setWake(dock, on ? { enabled: true, phrase: String(tunings.phrase ?? 'hey orbit'), prompt: String(tunings.prompt ?? 'did you call me?') } : null);
      }
    },
    onTransition: (_d, behaviour, from, to, why) => {
      console.log(`[orch] ${dock} ${behaviour}: ${from}→${to} (${why})`);
    },
  });

  const tick = () => {
    const now = Date.now();
    for (const dock of w.docks()) {
      const st = dockState(dock);
      try {
        reconcile(dock, BEHAVIOURS, assembleWorld(dock, st, now), st.behaviours, tunFor(dock), fx(dock, st));
      } catch (err) {
        console.error(`[orch] ${dock}: reconcile failed`, err);
      }
    }
  };

  /** A read-only snapshot of a dock's behaviours for the REST/console surface. */
  const snapshot = (dock: string) => {
    const st = docks.get(dock);
    const cfg = (w.config() ?? {})[dock] ?? {};
    return BEHAVIOURS.map((b) => {
      const tunings = { ...b.defaults, ...(cfg[b.name] ?? {}) };
      const self = st?.behaviours.get(b.name);
      const running = b.kind === 'task'
        ? w.tasks(dock).some((t) => t.name === b.taskName && t.state === 'running')
        : self?.desired === 'running';
      return { name: b.name, kind: b.kind, desired: self?.desired ?? 'off', running, tunings };
    });
  };

  return {
    name: 'orchestrator',
    topic: 'orchestrator',
    description: 'per-dock conductor: arms/runs standing behaviours (faceFollow, wakeUp) by tunable rules',
    async init() {
      timer = setInterval(tick, TICK_MS);
      timer.unref?.(); // never block process exit; no explicit shutdown hook in StationModule
    },
    route(ctx: RouteContext): boolean {
      const { req, res, subPath } = ctx;
      // GET /api/orchestrator/:dock — each behaviour's live state + tunings.
      const m = subPath.match(/^\/([^/]+)$/);
      if (m && req.method === 'GET') {
        json(res, 200, { dock: decodeURIComponent(m[1]!), behaviours: snapshot(decodeURIComponent(m[1]!)) });
        return true;
      }
      return false;
    },
  };
}

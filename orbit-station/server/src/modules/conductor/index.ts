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
import { CONDUCTED, type ConductedState, type World, type Tunings } from './conducted.js';
import { reconcile, type Effects } from './reconcile.js';

const TICK_MS = 1000;

export interface ConductorWiring {
  /** docks to conduct (live roster). */
  docks: () => string[];
  /** the `conductor` config json: { dock: { name: {tunings} } }. */
  config: () => Record<string, Record<string, Tunings>> | undefined;
  /** conversation mode for a dock ('idle'|'listening'|'thinking'|'speaking'|'followup') or null. */
  convMode: (dock: string) => string | null;
  /** running task instances on a dock (for world.tasks + the task-kind effects).
   *  `status` = the instance's live status line (surfaced per conducted thing in REST/console). */
  tasks: (dock: string) => Array<{ name: string; instanceId: string; parentSessionId?: string; startedAt: number; state: string; status?: string }>;
  /** start/stop a task by NAME (the conductor owns one instance per conducted task).
   *  `params` = the conducted thing's tunings, handed to the task (snapshot at start). */
  startTask: (dock: string, taskName: string, params: Record<string, unknown>) => void;
  stopTask: (dock: string, instanceId: string) => void;
  /** lease holder of a dock's body (the bodylink motion executor). */
  bodyHolder: (dock: string) => { holder: string; priority: number } | null;
  /** is the dock's servo component online right now? (gates body-driving tasks). */
  bodyOnline?: (dock: string) => boolean;
  /** is the dock's PHONE (face) component WS-online right now? Its absence stands the dock
   *  down (non-bgTask conducted things forced off + their tasks killed). Unset → treated as
   *  present, so a dock with no phone concept isn't perpetually gated off. */
  phoneOnline?: (dock: string) => boolean;
  /** set/clear a dock's wakeUp config (the brain's WakeApi) — enacting the wakeUp BEHAVIOUR. */
  setWake: (dock: string, cfg: { enabled: boolean; phrase: string; prompt: string; aliases?: string[] } | null) => void;
  /** best-effort presence (someone in view) — optional; v1 conducted things don't require it. */
  present?: (dock: string) => boolean;
}

interface DockState {
  conducted: Map<string, ConductedState>;
  /** epoch of the last NON-idle conversation mode (drives faceFollow's idle clock). */
  lastConversationMs: number;
  /** epoch someone was last VISIBLE (drives faceFollow's presence gate). 0 = never seen. */
  lastPresenceMs: number;
  /** manual overrides (the "Run now"/"Stop" buttons): name → forced state, overriding its rule
   *  until cleared. A 'run' pin holds it on; an 'off' pin holds it off. */
  override: Map<string, 'run' | 'off'>;
  /** per-thing ACTIVITY LOG (newest last): lifecycle transitions + the running task's status
   *  changes ("last bit: bored.sigh", "tracking guru", "yielded …") — the console's time-log.
   *  In-memory only; bounded. `norm` is the precomputed coalesce key (digits stripped). */
  history: Map<string, Array<{ ts: number; text: string; norm: string }>>;
}

const HISTORY_MAX = 30;
/** Coalesce key: digits stripped, so "searching (pan 72°)" → "searching (pan #°)" and a
 *  per-tick angle change UPDATES the latest entry instead of flooding the log. */
const normEvent = (s: string) => s.replace(/-?\d+(\.\d+)?/g, '#');

function pushEvent(st: DockState, name: string, ts: number, text: string): void {
  if (!text) return;
  let log = st.history.get(name);
  if (!log) { log = []; st.history.set(name, log); }
  const norm = normEvent(text);
  const last = log[log.length - 1];
  if (last && last.norm === norm) { last.text = text; return; } // same event, fresher numbers
  log.push({ ts, text, norm });
  if (log.length > HISTORY_MAX) log.splice(0, log.length - HISTORY_MAX);
}

export function conductorModule(w: ConductorWiring): StationModule {
  const docks = new Map<string, DockState>();
  let timer: NodeJS.Timeout | undefined;

  const dockState = (dock: string): DockState => {
    let s = docks.get(dock);
    if (!s) { s = { conducted: new Map(), lastConversationMs: 0, lastPresenceMs: 0, override: new Map(), history: new Map() }; docks.set(dock, s); }
    return s;
  };

  /** map a task's origin to who started it: the conductor's own tasks → 'self'; a task under
   *  an open conversation session → 'brain' (refine to 'user' later). */
  const initiatorOf = (taskName: string): 'user' | 'brain' | 'self' =>
    CONDUCTED.some((c) => c.kind === 'task' && c.taskName === taskName) ? 'self' : 'brain';

  const assembleWorld = (dock: string, st: DockState, now: number, taskList: ReturnType<ConductorWiring['tasks']>): World => {
    const mode = w.convMode(dock) ?? 'idle';
    const listening = mode === 'listening' || mode === 'followup';
    const turnActive = mode === 'thinking' || mode === 'speaking' || listening;
    if (turnActive) st.lastConversationMs = now; // stamp activity → resets faceFollow's idle clock
    const tasks = taskList.filter((t) => t.state === 'running').map((t) => ({
      name: t.name, instanceId: t.instanceId, initiator: initiatorOf(t.name), ageMs: now - t.startedAt,
    }));
    const present = w.present?.(dock) ?? false;
    if (present) st.lastPresenceMs = now; // stamp sightings → drives faceFollow's presence gate
    return {
      now, present, lastPresenceMs: st.lastPresenceMs, identity: null,
      listening, turnActive, lastConversationMs: st.lastConversationMs,
      bodyHolder: w.bodyHolder(dock), bodyOnline: w.bodyOnline?.(dock) ?? true,
      phonePresent: w.phoneOnline?.(dock) ?? true, tasks,
    };
  };

  const tunFor = (dock: string) => (name: string): Tunings => {
    const cfg = w.config() ?? {};
    return cfg[dock]?.[name] ?? {};
  };

  // `taskList` is the tick's ONE read of w.tasks(dock) — threaded through so world
  // assembly, the effects, and the history fold don't each rebuild the same array
  // (it was read 4× per tick; review 2026-07-05).
  const fx = (dock: string, taskList: ReturnType<ConductorWiring['tasks']>): Effects => ({
    isTaskRunning: (_d, taskName) => taskList.some((t) => t.name === taskName && t.state === 'running'),
    startTask: (_d, taskName, _priority, tunings) => w.startTask(dock, taskName, tunings),
    stopTask: (_d, taskName) => {
      for (const t of taskList) if (t.name === taskName && t.state === 'running') w.stopTask(dock, t.instanceId);
    },
    setBehaviour: (_d, name, on, tunings) => {
      if (name === 'wakeUp') {
        // tunings arrive PREPARED by the descriptor's prepareTunings (wakeTunings shape).
        const t = tunings as { phrase?: string; prompt?: string; aliases?: string[] };
        w.setWake(dock, on ? {
          enabled: true, phrase: String(t.phrase ?? 'hey orbit'),
          prompt: String(t.prompt ?? 'did you call me?'),
          aliases: Array.isArray(t.aliases) ? t.aliases : [],
        } : null);
      }
    },
    onTransition: (_d, name, from, to, why) => {
      console.log(`[cond] ${dock} ${name}: ${from}→${to} (${why})`);
      pushEvent(dockState(dock), name, Date.now(), `${from} → ${to} (${why})`);
    },
  });

  const tick = () => {
    const now = Date.now();
    for (const dock of w.docks()) {
      const st = dockState(dock);
      try {
        const taskList = w.tasks(dock);
        reconcile(dock, CONDUCTED, assembleWorld(dock, st, now, taskList), st.conducted, tunFor(dock),
          fx(dock, taskList), (name) => st.override.get(name));
        // ACTIVITY LOG: fold each running conducted task's status line into its history
        // (digit-coalesced, so a per-tick angle refresh updates in place, not floods).
        for (const c of CONDUCTED) {
          if (c.kind !== 'task') continue;
          const inst = taskList.find((t) => t.name === c.taskName && t.state === 'running');
          if (inst?.status) pushEvent(st, c.name, now, inst.status);
        }
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
      const inst = c.kind === 'task'
        ? w.tasks(dock).find((t) => t.name === c.taskName && t.state === 'running')
        : undefined;
      const running = c.kind === 'task' ? inst != null : self?.desired === 'running';
      return { name: c.name, kind: c.kind, desired: self?.desired ?? 'off', running, tunings,
        override: st?.override.get(c.name) ?? null,
        instrumentedAt: c.instrumentedAt ?? null, taskName: c.taskName ?? null,
        // the lease priority this thing's body motion runs at (kind:'task' only) — so the
        // console can show who outranks whom (brain turn 60 / console 70 always win).
        priority: c.priority ?? null,
        // the running instance's live status line ("tracking guru", "last bit: bored.sigh") —
        // the per-thing console widget's one-line window into what the thing is DOING.
        status: inst?.status ?? null,
        // the per-thing ACTIVITY LOG, newest first (transitions + status changes) — the
        // console's "what's been happening" time-log (norm is internal, stripped here).
        history: [...(st?.history.get(c.name) ?? [])].reverse().map(({ ts, text }) => ({ ts, text })) };
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

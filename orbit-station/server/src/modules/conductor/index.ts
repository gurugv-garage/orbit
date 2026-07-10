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
/** IDLE INTROSPECTION cadence (ego.md §3.2). The dock introspects when it's been idle at least
 *  INTROSPECT_IDLE_MS, and at most once every INTROSPECT_MIN_GAP_MS. Coarse by design — the ego
 *  evolves on the SAME ~hourly rhythm as the perception self-compression (span-summaries), so it
 *  reflects when a fresh hour of memory has consolidated, not every few minutes (avoids a "moody",
 *  churning self). A strong EVENT can still trigger an earlier introspection out-of-band (recovery
 *  / de-settle must not wait up to an hour); per-turn responses are always live regardless. Traces
 *  from the past hour are all retained (ego-store), so event-driven extra introspections are
 *  visible to the next one as churn, not silently overwritten. */
const INTROSPECT_IDLE_MS = Number(process.env.EGO_INTROSPECT_IDLE_MS ?? 900_000);    // idle ≥ 15 min
const INTROSPECT_MIN_GAP_MS = Number(process.env.EGO_INTROSPECT_GAP_MS ?? 3_600_000); // ≤ once / hour
/** Anti-spam floor for EVENT-triggered introspections: even a strong event can't re-introspect
 *  more often than this (a burst of events shouldn't churn the self). Well under the hourly idle
 *  gap — the point of an event trigger is to react sooner than an hour, not every minute. */
const EVENT_INTROSPECT_FLOOR_MS = Number(process.env.EGO_INTROSPECT_EVENT_FLOOR_MS ?? 5 * 60_000); // ≥ 5 min apart
const INTROSPECT_ENABLED = process.env.EGO_INTROSPECT !== '0';

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
  /** IDLE INTROSPECTION (ego.md §3.2): fire one introspection for the dock. Called by the
   *  tick when the dock has been idle a while, at most every INTROSPECT_MIN_GAP_MS. Async +
   *  fire-and-forget; the ego module owns the work + its own trace cooldown. Unset → disabled. */
  introspect?: (dock: string, trigger: string) => Promise<unknown>;
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
  /** epoch of the last INTROSPECTION the conductor fired for this dock (0 = never). Gates the
   *  idle introspection heartbeat so it fires at most every INTROSPECT_MIN_GAP_MS. */
  lastIntrospectMs: number;
  /** true while an async introspection is in flight (don't overlap — it's an LLM call). */
  introspecting: boolean;
  /** was someone present on the PREVIOUS tick — to detect a departure (present→absent) as a
   *  strong event that can trigger an early introspection. undefined until the first tick. */
  wasPresent?: boolean;
  /** epoch someone first became continuously present (reset on each absence) — so a departure only
   *  counts as a "strong event" after a SUSTAINED presence spell, not a detection flicker. */
  presentSinceMs?: number;
}

/** A departure counts as a "strong event" only after REAL, sustained presence (someone was around
 *  a while), not a momentary flicker — so a face-detection blip doesn't trigger introspection. */
const DEPARTURE_MIN_PRESENCE_MS = 60_000; // present ≥ 1 min continuously before a departure is "real"

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
    if (!s) { s = { conducted: new Map(), lastConversationMs: 0, lastPresenceMs: 0, override: new Map(), history: new Map(), lastIntrospectMs: 0, introspecting: false }; docks.set(dock, s); }
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

  /** IDLE INTROSPECTION heartbeat (ego.md §3.2). Independent of the conducted-things
   *  reconcile: introspection is background cognition, not a start/stop lifecycle thing. Fire
   *  one when the dock has been idle ≥ INTROSPECT_IDLE_MS and it's been ≥ INTROSPECT_MIN_GAP_MS
   *  since the last one. Fire-and-forget (async LLM); `introspecting` guards against overlap. */
  /** Fire an introspection now (shared by the idle heartbeat and the event-trigger). Respects the
   *  hard guards — never mid-conversation, never overlapping — but the CALLER decides the cadence
   *  gate (`idle` obeys the hourly gap; a strong `trigger` bypasses it). */
  const runIntrospect = (dock: string, st: DockState, now: number, trigger: string) => {
    st.introspecting = true; st.lastIntrospectMs = now;
    pushEvent(st, 'introspect', now, `introspecting (${trigger})…`);
    void Promise.resolve(w.introspect!(dock, trigger))
      .then(() => pushEvent(dockState(dock), 'introspect', Date.now(), 'introspected'))
      .catch((e) => pushEvent(dockState(dock), 'introspect', Date.now(), `introspect failed: ${String(e).slice(0, 80)}`))
      .finally(() => { dockState(dock).introspecting = false; });
  };

  const maybeIntrospect = (dock: string, st: DockState, now: number, world: World) => {
    if (!INTROSPECT_ENABLED || !w.introspect || st.introspecting) return;
    if (world.turnActive || world.listening) return;                 // never mid-conversation
    const idleFor = st.lastConversationMs === 0 ? Infinity : now - st.lastConversationMs;
    if (idleFor < INTROSPECT_IDLE_MS) return;                         // not idle long enough
    if (now - st.lastIntrospectMs < INTROSPECT_MIN_GAP_MS) return;    // too soon since last (hourly)
    runIntrospect(dock, st, now, 'idle');
  };

  /** EVENT-TRIGGERED introspection (ego.md §3.2): a strong event (a departure after real presence,
   *  a sharp conflict, a big change) can introspect EARLIER than the hourly idle gap — recovery /
   *  de-settle must not wait up to an hour. Still respects the hard guards (not mid-conversation,
   *  not overlapping) and a short floor so a burst of events can't spam. The past-hour traces are
   *  all retained (ego-store), so an event introspection is visible to the next as churn. Returns
   *  whether it fired. (The classifier that DECIDES an event is strong enough is a caller concern —
   *  this is the seam it calls.) */
  const triggerIntrospect = (dock: string, trigger: string): boolean => {
    if (!INTROSPECT_ENABLED || !w.introspect) return false;
    const st = dockState(dock);
    const now = Date.now();
    if (st.introspecting) return false;
    const world = assembleWorld(dock, st, now, w.tasks(dock));
    if (world.turnActive || world.listening) return false;           // never mid-conversation
    if (now - st.lastIntrospectMs < EVENT_INTROSPECT_FLOOR_MS) return false; // anti-spam floor
    runIntrospect(dock, st, now, trigger);
    return true;
  };

  const tick = () => {
    const now = Date.now();
    for (const dock of w.docks()) {
      const st = dockState(dock);
      try {
        const taskList = w.tasks(dock);
        const world = assembleWorld(dock, st, now, taskList);
        reconcile(dock, CONDUCTED, world, st.conducted, tunFor(dock),
          fx(dock, taskList), (name) => st.override.get(name));
        // EVENT: a departure (present→absent after SUSTAINED presence) is a strong event →
        // introspect early (bypasses the hourly idle gap; still floor-limited + not mid-
        // conversation). Track a continuous-presence clock so a flicker doesn't count.
        if (world.present) {
          if (!st.wasPresent) st.presentSinceMs = now;        // presence began
        } else if (st.wasPresent) {                            // departure edge
          const spell = now - (st.presentSinceMs ?? now);
          if (spell >= DEPARTURE_MIN_PRESENCE_MS) triggerIntrospect(dock, 'departure');
          st.presentSinceMs = undefined;
        }
        st.wasPresent = world.present;
        maybeIntrospect(dock, st, now, world);
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

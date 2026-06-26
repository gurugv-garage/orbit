/**
 * The LONG-TERM MEMORY CURATOR loop — organizes + maintains durable memory from
 * selectable short-term sources (docs/decision-traces/long-term-memory-curator.md).
 *
 * Two operations on different clocks (§6a):
 *   • consolidate — ACCUMULATION-driven: when ≥K new source records landed, promote the
 *     salient window into new derived beliefs (lineage). Read before the ring drops it.
 *   • reconcile  — slow INTERVAL: revise/forget existing beliefs to keep them honest.
 *
 * In-process (reaches the MemoryStore + SnapshotStore ring directly); all heavy effects
 * (the LLM, the store reads/writes, the source window) are INJECTED, so the loop +
 * the pure decisions are unit-testable without Gemini/sqlite/a live ring.
 *
 * Console surface: enable toggle + run-now + a recent-passes feed (§8). Same shape the
 * first `curator.ts` cut proved; this is the ground-up rewrite for two-ops + sources.
 */
import { reconcilePrompt, parseReconcile, reconcilePlan, type BeliefHit } from './reconcile.js';
import { consolidatePrompt, parseConsolidate, consolidatePlan, CONSOLIDATE_CONFIDENCE_MAX } from './consolidate.js';
import {
  decideConsolidate, batchSize, type ConsolidateReason, type CadenceCfg,
  CONSOLIDATE_BATCH_AT, CONSOLIDATE_MAX_AGE_MS, CONSOLIDATE_QUIET_MS, CONSOLIDATE_FLOOR_MS, CONSOLIDATE_MAX_BATCH,
} from './cadence.js';
import type { Observation } from './sources.js';

// ── reconcile cadence (consolidate's lives in cadence.ts — load-aware) ──────────
export const RECONCILE_INTERVAL_MS = Number(process.env.PERCEPTION_RECONCILE_MS ?? 30 * 60_000);
export const RECONCILE_MIN_BELIEFS = Number(process.env.PERCEPTION_RECONCILE_MIN ?? 4);

/** reconcile fires on a slow interval, with a few beliefs to be worth a pass. */
export function shouldReconcile(
  beliefCount: number, lastAt: number, now: number,
  intervalMs = RECONCILE_INTERVAL_MS, minBeliefs = RECONCILE_MIN_BELIEFS,
): boolean {
  return beliefCount >= minBeliefs && now - lastAt >= intervalMs;
}

/**
 * The curator's LIVE-tunable knobs. Held in a mutable object the loop reads EACH PASS
 * (not load-time consts), so a console edit takes effect on the very next tick — no
 * restart. Env values seed the defaults. Which knobs are live vs. restart-only is
 * explicit (see CuratorHandle.configMeta) so the UI can be honest about what applies.
 */
export interface CuratorConfig {
  // consolidate cadence (cadence.ts CadenceCfg + the batch cap)
  batchAt: number;        // ≥ this many pending → flood
  maxAgeMs: number;       // oldest pending older than this → age-flush (overrides floor)
  quietMs: number;        // speech stopped this long + pending → quiet-flush
  floorMs: number;        // min gap between consolidate passes
  maxBatch: number;       // cap per pass (flood drains over ticks)
  // confidence
  confMax: number;        // clamp ceiling for a single-pass derived belief
  // reconcile cadence
  reconcileMs: number;    // slow interval
  reconcileMin: number;   // min beliefs to bother
}

export function defaultCuratorConfig(): CuratorConfig {
  return {
    batchAt: CONSOLIDATE_BATCH_AT, maxAgeMs: CONSOLIDATE_MAX_AGE_MS, quietMs: CONSOLIDATE_QUIET_MS,
    floorMs: CONSOLIDATE_FLOOR_MS, maxBatch: CONSOLIDATE_MAX_BATCH, confMax: CONSOLIDATE_CONFIDENCE_MAX,
    reconcileMs: RECONCILE_INTERVAL_MS, reconcileMin: RECONCILE_MIN_BELIEFS,
  };
}

/** Per-knob bounds + a one-line note — drives validation AND the console's field hints,
 *  so the UI shows exactly what's tunable and within what range (honest feedback). */
export const CONFIG_META: Record<keyof CuratorConfig, { min: number; max: number; unit: string; note: string }> = {
  batchAt:     { min: 1, max: 100, unit: 'utterances', note: 'flood trigger: consolidate when this many pending' },
  maxAgeMs:    { min: 5_000, max: 3_600_000, unit: 'ms', note: 'age flush: oldest pending older than this (overrides floor)' },
  quietMs:     { min: 1_000, max: 600_000, unit: 'ms', note: 'quiet flush: consolidate after speech stops this long' },
  floorMs:     { min: 0, max: 600_000, unit: 'ms', note: 'min gap between consolidate passes' },
  maxBatch:    { min: 1, max: 200, unit: 'utterances', note: 'cap per pass; a flood drains over ticks' },
  confMax:     { min: 0, max: 1, unit: '0–1', note: 'confidence ceiling for a one-pass derived belief' },
  reconcileMs: { min: 60_000, max: 86_400_000, unit: 'ms', note: 'reconcile (revise/forget) interval' },
  reconcileMin:{ min: 1, max: 100, unit: 'beliefs', note: 'min beliefs before a reconcile pass' },
};

// ── console feed ────────────────────────────────────────────────────────────────
export interface CuratorPass {
  ts: number;
  dockId: string;
  op: 'consolidate' | 'reconcile';
  reviewed: number;                 // observations (consolidate) or beliefs (reconcile)
  created?: number;
  revised?: number;
  forgot?: number;
  reason?: ConsolidateReason;       // why consolidate fired (flood/age/quiet) — for the console
  skipped?: string;
  changes: Array<{ kind: 'create' | 'revise' | 'forget'; claim?: string; id?: string }>;
}

export interface CuratorHandle {
  stop(): void;
  tick(now?: number): Promise<void>;
  setEnabled(on: boolean): void;
  isEnabled(): boolean;
  recent(limit?: number): CuratorPass[];
  /** the live config (read each pass) + a patch that applies on the NEXT tick (no restart). */
  getConfig(): CuratorConfig;
  setConfig(patch: Partial<CuratorConfig>): CuratorConfig;
}

interface DockState { watermarkIso: string; consolidateAt: number; reconcileAt: number }

/** Pending-speech stats for the cadence decision (count + oldest, post-watermark). */
export interface PendingStats { count: number; oldestIso: string; newestIso: string }

/** Effects the loop needs — all injected (testable). */
export interface CuratorDeps {
  /** docks worth curating (have memory OR are actively observed). */
  activeDocks: () => string[];
  /** pending (unconsolidated, post-watermark) speech stats — drives the load-aware
   *  consolidate cadence. `newestIso` lets us compute since-last-speech. */
  pendingStats: (dockId: string, watermarkIso: string) => PendingStats;
  /** the bounded, oldest-first pending observations to consolidate THIS pass
   *  (event-time-aligned). Returns ≤ limit; advances exactly-once via the watermark. */
  pendingObservations: (dockId: string, watermarkIso: string, limit: number) => Observation[];
  /** RESTART-SAFE watermark seed: the newest source event-time this dock has ALREADY
   *  consolidated from (derived from belief lineage), or '' if none. Called ONCE per
   *  dock to initialise its watermark, so a restart resumes where it left off instead
   *  of re-consolidating the ring into duplicate beliefs. The durable beliefs are the
   *  checkpoint — no separate stored cursor. */
  watermarkSeed: (dockId: string) => string;
  /** beliefs the dock already holds (for reconcile + consolidate de-dup). */
  beliefs: (dockId: string, limit: number) => Promise<BeliefHit[]>;
  /** the LLM (the summarizer's gemini path); `purpose` tags the spend. */
  reflect: (prompt: string, dockId: string, purpose: string) => Promise<string>;
  /** write a new derived belief (with lineage). Returns the new id. */
  create: (dockId: string, b: { type: string; subject?: string; claim: string; confidence: number; lineage: Array<{ sourceKind: string; sourceId: string }> }) => Promise<string>;
  revise: (id: string, patch: { claim?: string; confidence?: number }) => Promise<string | null>;
  forget: (id: string) => boolean;
  batch?: number;
  pollMs?: number;
  enabled?: boolean;
  /** seed the live config (else env/defaults). */
  config?: Partial<CuratorConfig>;
  now?: () => number;
  log?: (m: string) => void;
}

const RECENT_CAP = 50;

/** Snapshot event-time iso ("…+05:30") → ms epoch. The offset is honoured (Date parses
 *  it), so two records compare correctly regardless of the box's local TZ. */
function isoMs(iso: string): number {
  const t = new Date(iso).getTime();
  return Number.isFinite(t) ? t : 0;
}

export function startLongTermMemoryCurator(d: CuratorDeps): CuratorHandle {
  const batch = d.batch ?? 30;
  const pollMs = d.pollMs ?? 60_000;
  const now = d.now ?? (() => Date.now());
  let enabled = d.enabled ?? true;
  // LIVE config — read each pass, so a console patch applies next tick (no restart).
  const config: CuratorConfig = { ...defaultCuratorConfig(), ...(d.config ?? {}) };
  const cadenceCfg = (): CadenceCfg =>
    ({ batchAt: config.batchAt, maxAgeMs: config.maxAgeMs, quietMs: config.quietMs, floorMs: config.floorMs });
  const states = new Map<string, DockState>();
  const stateOf = (k: string): DockState => {
    let s = states.get(k);
    if (!s) {
      // first sight of this dock (incl. after a restart): seed the watermark from what
      // it has ALREADY consolidated (belief lineage), so we resume — not re-process.
      s = { watermarkIso: d.watermarkSeed(k), consolidateAt: 0, reconcileAt: 0 };
      states.set(k, s);
    }
    return s;
  };
  const recent: CuratorPass[] = [];
  const record = (p: CuratorPass) => { recent.unshift(p); if (recent.length > RECENT_CAP) recent.length = RECENT_CAP; };

  // ── consolidate one dock (CREATE) — load-aware, exactly-once via the watermark ──
  const consolidate = async (dock: string, atMs: number, st: DockState, reason: ConsolidateReason): Promise<void> => {
    // bounded, oldest-first pending span — never the whole ring (flood-safe).
    const take = batchSize(d.pendingStats(dock, st.watermarkIso).count, cadenceCfg(), config.maxBatch);
    const obs = d.pendingObservations(dock, st.watermarkIso, take);
    if (obs.length === 0) return;
    const known = await d.beliefs(dock, batch);
    let verdict;
    try {
      verdict = parseConsolidate(await d.reflect(consolidatePrompt(obs, known), dock, 'consolidate'));
    } catch (err) {
      // DON'T advance the watermark on error — retry this span next pass (no data loss).
      record({ ts: atMs, dockId: dock, op: 'consolidate', reviewed: obs.length, skipped: `error: ${String(err)}`, changes: [] });
      return;
    }
    const plan = consolidatePlan(verdict, new Set(obs.map((o) => o.lineageId)), config.confMax);
    const changes: CuratorPass['changes'] = [];
    let created = 0;
    for (const b of plan) {
      try { await d.create(dock, b); created++; changes.push({ kind: 'create', claim: b.claim }); }
      catch { /* a single write failure shouldn't sink the pass */ }
    }
    // advance the watermark over EXACTLY what we sent (the newest obs we processed), so
    // these utterances are never re-sent and the rest of a flood drains next tick.
    st.watermarkIso = obs[obs.length - 1]!.atIso;
    st.consolidateAt = atMs;
    states.set(dock, st);
    record({ ts: atMs, dockId: dock, op: 'consolidate', reviewed: obs.length, created, changes, reason });
    if (created > 0) d.log?.(`[perception] consolidated ${dock} (${reason}): +${created} beliefs, ${obs.length} reviewed`);
  };

  // ── reconcile one dock (MAINTAIN) ──
  const reconcile = async (dock: string, atMs: number, beliefs: BeliefHit[]): Promise<void> => {
    let verdict;
    try {
      verdict = parseReconcile(await d.reflect(reconcilePrompt(beliefs), dock, 'reconcile'));
    } catch (err) {
      record({ ts: atMs, dockId: dock, op: 'reconcile', reviewed: beliefs.length, skipped: `error: ${String(err)}`, changes: [] });
      return;
    }
    const plan = reconcilePlan(verdict, new Set(beliefs.map((b) => b.id)));
    const changes: CuratorPass['changes'] = [];
    let revised = 0; let forgot = 0;
    for (const r of plan.revise) {
      if (await d.revise(r.id, { claim: r.claim, confidence: r.confidence })) { revised++; changes.push({ kind: 'revise', id: r.id, claim: r.claim }); }
    }
    for (const id of plan.forget) {
      if (d.forget(id)) { forgot++; changes.push({ kind: 'forget', id }); }
    }
    record({ ts: atMs, dockId: dock, op: 'reconcile', reviewed: beliefs.length, revised, forgot, changes });
    if (revised + forgot > 0) d.log?.(`[perception] reconciled ${dock}: ~${revised} revised, -${forgot} forgotten`);
  };

  let running = false;
  /** `force` (run-now) bypasses the cadence gates so a console click always does work. */
  const evaluate = async (atMs: number, force = false): Promise<void> => {
    if (running || !enabled) return;
    running = true;
    try {
      for (const dock of d.activeDocks()) {
        const st = stateOf(dock);

        // consolidate — LOAD-AWARE: flood (≥batch) / age (don't strand) / quiet (exchange
        // ended). decideConsolidate is pure over pending stats; consolidate() takes a
        // bounded oldest chunk so a flood drains over ticks, not one giant prompt.
        const ps = d.pendingStats(dock, st.watermarkIso);
        const reason = decideConsolidate({
          pendingCount: ps.count,
          oldestPendingAgeMs: ps.oldestIso ? atMs - isoMs(ps.oldestIso) : 0,
          sinceLastSpeechMs: ps.newestIso ? atMs - isoMs(ps.newestIso) : Infinity,
          sinceLastPassMs: atMs - st.consolidateAt,
        }, cadenceCfg(), force);
        if (reason) await consolidate(dock, atMs, st, reason);

        // reconcile — slow interval (runs after consolidate so it sees fresh beliefs)
        const beliefs = await d.beliefs(dock, batch);
        if (force || shouldReconcile(beliefs.length, st.reconcileAt, atMs, config.reconcileMs, config.reconcileMin)) {
          st.reconcileAt = atMs;
          states.set(dock, st);
          await reconcile(dock, atMs, beliefs);
        }
      }
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => { void evaluate(now()); }, pollMs);
  if (typeof timer === 'object' && 'unref' in timer) (timer as { unref(): void }).unref();
  return {
    stop: () => clearInterval(timer),
    tick: (atMs?: number) => evaluate(atMs ?? now(), true),
    setEnabled: (on) => { enabled = on; },
    isEnabled: () => enabled,
    recent: (limit = 20) => recent.slice(0, limit),
    getConfig: () => ({ ...config }),
    // patch only known keys, clamped to CONFIG_META bounds — applies on the next tick.
    setConfig: (patch) => {
      for (const [k, meta] of Object.entries(CONFIG_META) as Array<[keyof CuratorConfig, typeof CONFIG_META[keyof CuratorConfig]]>) {
        const v = patch[k];
        if (typeof v === 'number' && Number.isFinite(v)) config[k] = Math.max(meta.min, Math.min(meta.max, v));
      }
      return { ...config };
    },
  };
}

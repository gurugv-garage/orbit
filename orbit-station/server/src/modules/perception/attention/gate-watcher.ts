/**
 * The attention-gate WATCHER (docs/perception-to-brain.md Decision 1) — feeds the
 * pure gate (gate.ts) from the live perception stream and raises a self-thought when
 * it fires.
 *
 * Flow: subscribe to the SnapshotStore → on each new record, build a GateSignals
 * snapshot for that dock (detecting arrivals/departures by diffing the present set,
 * reading the latest emotion + camera-motion) → evaluateGate → on RAISE, call the
 * injected `raise` (which the brain wires to enqueueAutonomousTurn). A short debounce
 * coalesces bursts.
 *
 * Signal EXTRACTION (deriveSignals) is split out as a PURE function so the
 * arrival/departure diffing is unit-testable without a store or a clock.
 */

import type { SnapshotRecord, SnapshotStore } from '../snapshots.js';
import { evaluateGate, type GateSignals, type GateConfig, type GateOutcome } from './gate.js';

/** Per-dock watcher state: the last present set + the last raise (cooldown/dedup). */
interface DockState {
  presentNames: string[];
  lastRaisedAt: number;
  lastRaisedKey?: string;
}

/** What the watcher hands the brain on a raise. */
export interface RaisedThought { dockId: string; kind: string; key: string; text: string; confidence: number }

/** Names present in an identity record (unknown faces → 'someone'). */
export function namesIn(rec: SnapshotRecord | undefined): string[] {
  if (!rec || rec.source.kind !== 'identity') return [];
  const faces = (rec.payload.faces as Array<{ name: string | null }> | undefined) ?? [];
  if (faces.length === 0) return [];
  return faces.map((f) => f.name ?? 'someone');
}

/**
 * PURE signal extraction: given the latest records (most-recent-first slice) for a
 * dock and the prior present-set, derive the GateSignals. Arrivals/departures are the
 * diff of the newest identity reading vs. what we last knew. Camera motion + emotion
 * come from the newest record of each kind. No store, no global clock.
 */
export function deriveSignals(args: {
  now: number;
  latestIdentity?: SnapshotRecord;
  latestEmotion?: SnapshotRecord;
  /** did the head move recently? A true time-decayed flag from MotionExecutor.recentlyMoved —
   *  NOT inferred from a (possibly stale) bodymotion record's text. Suppresses arrival-raise
   *  while the robot is panning (a face entering/leaving frame is ego-motion, not the world). */
  cameraMoving: boolean;
  prevPresent: string[];
  msSinceLastSnapshot: number;
  lastRaisedAt: number;
  lastRaisedKey?: string;
}): GateSignals {
  const present = namesIn(args.latestIdentity);
  const prev = new Set(args.prevPresent);
  const cur = new Set(present);
  const arrivedNames = present.filter((n) => !prev.has(n));
  const departedNames = args.prevPresent.filter((n) => !cur.has(n));

  const cameraMoving = args.cameraMoving;

  // a STRONG emotion = an emotion record whose text reads "looked X" (the upstream
  // emotion stream only emits "looked" for confident reads; "seemed a little" is soft).
  let strongEmotion: GateSignals['strongEmotion'];
  const et = args.latestEmotion?.payload.text;
  if (typeof et === 'string' && /\blooked\b/.test(et)) {
    const name = et.split(' ')[0] || 'someone';
    strongEmotion = { name, text: et };
  }

  return {
    now: args.now,
    presentNames: present,
    arrivedNames, departedNames,
    strongEmotion,
    cameraMoving,
    msSinceLastSnapshot: args.msSinceLastSnapshot,
    lastRaisedAt: args.lastRaisedAt,
    lastRaisedKey: args.lastRaisedKey,
    // relevance stays undefined until A1 (the mic shift).
  };
}

const DEBOUNCE_MS = 400;

/**
 * The live watcher. `getConfig` is read each evaluation (so the console toggle
 * applies immediately); `raise` is called on a RAISE (the brain wires it to
 * enqueueAutonomousTurn). `onDecision` (optional) gets EVERY outcome for the
 * console's recent-decisions log. Returns a disposer.
 */
export function startGateWatcher(
  store: SnapshotStore,
  getConfig: () => GateConfig,
  raise: (t: RaisedThought) => void,
  onDecision?: (dockId: string, outcome: GateOutcome) => void,
  /** did the dock's head move recently? (MotionExecutor.recentlyMoved via setCameraMoving.)
   *  Suppresses arrival-raises while the robot is panning. Default: never-moving. */
  cameraMoving: (dockId: string) => boolean = () => false,
): () => void {
  const docks = new Map<string, DockState>();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();

  const state = (dockId: string): DockState => {
    let s = docks.get(dockId);
    if (!s) { s = { presentNames: [], lastRaisedAt: 0 }; docks.set(dockId, s); }
    return s;
  };

  const evaluate = (dockId: string) => {
    const cfg = getConfig();
    const s = state(dockId);
    const recs = store.list().filter((r) => r.dockId === dockId);
    const latestOf = (kind: SnapshotRecord['source']['kind']) =>
      [...recs].reverse().find((r) => r.source.kind === kind);
    const last = recs[recs.length - 1];

    const signals = deriveSignals({
      now: Date.now(),
      latestIdentity: latestOf('identity'),
      cameraMoving: cameraMoving(dockId),
      latestEmotion: latestOf('emotion'),
      prevPresent: s.presentNames,
      msSinceLastSnapshot: last ? Date.now() - new Date(last.interval.to.replace('+05:30', 'Z')).getTime() : Infinity,
      lastRaisedAt: s.lastRaisedAt,
      lastRaisedKey: s.lastRaisedKey,
    });

    const outcome = evaluateGate(signals, cfg);
    onDecision?.(dockId, outcome);

    // update the present-set AFTER deriving (so the next diff is vs. this reading).
    s.presentNames = signals.presentNames;

    if (outcome.raise) {
      s.lastRaisedAt = signals.now;
      s.lastRaisedKey = outcome.key;
      raise({ dockId, kind: outcome.kind, key: outcome.key, text: outcome.text, confidence: outcome.confidence });
    }
  };

  const unsub = store.subscribe((rec) => {
    // only the kinds that drive the gate today (identity/emotion/bodymotion).
    if (!['identity', 'emotion', 'bodymotion'].includes(rec.source.kind)) return;
    const dockId = rec.dockId;
    clearTimeout(timers.get(dockId));
    timers.set(dockId, setTimeout(() => { timers.delete(dockId); evaluate(dockId); }, DEBOUNCE_MS));
  });

  return () => {
    unsub();
    for (const t of timers.values()) clearTimeout(t);
    timers.clear();
  };
}

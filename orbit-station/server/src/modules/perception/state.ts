/**
 * PerceptionState — the per-dock rolling "world state". It folds every processor's
 * PerceptionResult into a compact picture of each dock (who's present, identity,
 * emotion, recent transcript) so the console and other server consumers see one
 * source of truth. The dock's agent gets the per-result deltas directly (the hub
 * directs them); this aggregate is what the console renders and what future
 * temporal/aggregate processors (category c) build on.
 *
 * Identity fusion lives here: face + voice (+ later) results are reconciled into a
 * single current identity with a small debounce, so a single mis-frame doesn't
 * rename the user mid-conversation.
 */

import type { Bus } from '../../core/bus.js';
import type { PerceptionResult } from './result.js';

export interface DockWorldState {
  dockId: string;
  present: boolean;
  identity?: { name: string; confidence: number; since: number };
  emotion?: { kind: string; confidence: number };
  recentTranscript: { text: string; ts: number }[];
  lastUpdated: number;
}

/** Recent transcript ring-buffer size. */
const TRANSCRIPT_KEEP = 10;

export class PerceptionState {
  #bus: Bus;
  #docks = new Map<string, DockWorldState>();
  /** per-dock pending identity vote: { name, count }. */

  constructor(bus: Bus) {
    this.#bus = bus;
    // Consume the undirected result copies the hub broadcasts (source 'station').
    // Skip our own 'state' aggregate (we publish that) to avoid a feedback loop.
    this.#bus.on('perception', (m) => {
      if (m.source !== 'station' || m.to != null || m.kind === 'state') return;
      this.apply(m.payload as PerceptionResult);
    });
  }

  get(dockId: string): DockWorldState | undefined { return this.#docks.get(dockId); }
  all(): DockWorldState[] { return [...this.#docks.values()]; }

  /** Fold one result into its dock's world state, then broadcast the new state. */
  apply(r: PerceptionResult): void {
    if (!r || typeof r.dockId !== 'string') return;
    const s = this.#docks.get(r.dockId) ?? this.#fresh(r.dockId);
    const p = r.payload as any;

    switch (r.kind) {
      case 'presence':
        s.present = !!p?.present;
        if (!s.present) s.identity = undefined;
        break;
      case 'identity':
        this.#applyIdentity(s, p?.name ?? null, r.confidence ?? 0);
        break;
      case 'emotion':
        if (p?.kind) s.emotion = { kind: p.kind, confidence: r.confidence ?? 0 };
        break;
      case 'transcript':
        if (p?.text) {
          s.recentTranscript.push({ text: p.text, ts: r.ts });
          if (s.recentTranscript.length > TRANSCRIPT_KEEP) s.recentTranscript.shift();
        }
        break;
      // other kinds fold in as processors land (addressing, speaker, …)
    }

    s.lastUpdated = r.ts;
    this.#docks.set(r.dockId, s);
    this.#broadcast(s);
  }

  // ── identity fusion (debounced) ────────────────────────────────────────────

  #applyIdentity(s: DockWorldState, name: string | null, confidence: number): void {
    // The face processor already debounces (emits a STABLE identity on change),
    // so we trust it directly. null = unrecognized → keep the current identity
    // (a brief non-match shouldn't wipe the name) until presence drops.
    if (!name) return;
    if (s.identity?.name === name) s.identity.confidence = confidence;
    else s.identity = { name, confidence, since: Date.now() };
  }

  #fresh(dockId: string): DockWorldState {
    return { dockId, present: false, recentTranscript: [], lastUpdated: Date.now() };
  }

  /** Publish the aggregated state (kind 'state') so the console panel renders it. */
  #broadcast(s: DockWorldState): void {
    this.#bus.publish({ topic: 'perception', kind: 'state', payload: s, source: 'station' });
  }
}

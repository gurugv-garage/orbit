/**
 * Observations — the rolling ~500-entry log of raw perception facts (vision
 * `scene` descriptions + `stt` transcripts), per dock, newest-last. This is the
 * tier-1 output the perception pyramid (docs/PERCEPTION-PYRAMID.md) produces and
 * the console renders; hierarchical roll-up (tier 2/3) consumes it later.
 *
 * It subscribes to the same undirected `perception` results the PerceptionState
 * aggregator does, but keeps the time-series (not a folded snapshot). Cap is a
 * ring so memory is bounded regardless of stream length.
 */

import type { Bus } from '../../core/bus.js';
import type { PerceptionResult } from './result.js';

export interface Observation {
  ts: number;
  dockId: string;
  /** the sensor modality. */
  modality: 'vision' | 'speech' | 'action';
  /** the human-readable fact (scene description or transcript text). */
  text: string;
  /** modality-specific extras, e.g. { present } for vision. */
  meta?: Record<string, unknown>;
  source: string;
}

const CAP = Number(process.env.PERCEPTION_OBS_CAP ?? 500);

export class Observations {
  #byDock = new Map<string, Observation[]>();
  #listeners = new Set<(o: Observation) => void>();

  constructor(bus: Bus) {
    bus.on('perception', (m) => {
      // Only the undirected station copies, and only the sensor kinds we log.
      if (m.source !== 'station' || m.to != null) return;
      if (m.kind !== 'scene' && m.kind !== 'transcript' && m.kind !== 'action') return;
      this.#add(m.payload as PerceptionResult);
    });
  }

  #add(r: PerceptionResult): void {
    if (!r || typeof r.dockId !== 'string') return;
    const p = r.payload as any;
    let obs: Observation;
    if (r.kind === 'scene') {
      obs = { ts: r.ts, dockId: r.dockId, modality: 'vision',
        text: String(p?.description ?? ''), meta: { present: p?.present }, source: r.source };
    } else if (r.kind === 'action') {
      obs = { ts: r.ts, dockId: r.dockId, modality: 'action',
        text: String(p?.description ?? ''), source: r.source };
    } else {
      obs = { ts: r.ts, dockId: r.dockId, modality: 'speech',
        text: String(p?.text ?? ''), source: r.source };
    }
    if (!obs.text) return;

    const list = this.#byDock.get(r.dockId) ?? [];
    list.push(obs);
    if (list.length > CAP) list.splice(0, list.length - CAP); // ring
    this.#byDock.set(r.dockId, list);
    for (const l of this.#listeners) { try { l(obs); } catch { /* */ } }
  }

  /** Most recent observations for a dock (or all docks merged), newest-last. */
  list(dockId?: string, limit = CAP): Observation[] {
    const all = dockId
      ? (this.#byDock.get(dockId) ?? [])
      : [...this.#byDock.values()].flat().sort((a, b) => a.ts - b.ts);
    return all.slice(-limit);
  }

  /** Wipe the buffer (a dock, or all). Console "Clear" calls this. */
  clear(dockId?: string): void {
    if (dockId) this.#byDock.delete(dockId);
    else this.#byDock.clear();
  }

  /** Live subscription for SSE/console push. Returns an unsubscribe fn. */
  subscribe(fn: (o: Observation) => void): () => void {
    this.#listeners.add(fn);
    return () => this.#listeners.delete(fn);
  }
}

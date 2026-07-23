/**
 * BusyQueue — utterances heard while the dock was mid-turn (THINKING/SPEAKING),
 * held until the lane settles, then run TOGETHER as one combined turn.
 *
 * WI-1 of docs/findings/2026-07-13-busy-queue-black-hole.md (Addendum 3). The
 * previous inline version (a per-dock batch with a single `firstAt` clock) had
 * two structural defects the RCA proved live: the drain re-entered the
 * addressed decision (whose grace check then rejected the by-now-stale batch),
 * and the batch clock reset on every bounce, so one orphaned item silently
 * killed everything queued after it. This version:
 *
 *  - keeps ONE timestamp per item (its own `endedAt`) — staleness is judged
 *    per item at drain time, never batch-wide, and never resets;
 *  - is pure state: the drain policy (who runs, who's dropped, what's traced)
 *    lives with the caller, so every cell is unit-testable without a live LLM
 *    (the thought-router.ts precedent).
 *
 * Why a pure class (not inline in the brain module): the RCA showed drops here
 * MUST be visible and testable — inline closure state is what made the old
 * black hole invisible.
 */

/** A finalized utterance as the brain hears it (mirrors onAddressedFinal's t). */
export interface HeardUtterance {
  dockId: string;
  text: string;
  startedAt: number;
  endedAt: number;
  /** segmentation-minted correlation id (`<dockId>:<audioStartMs>`) — threads the
   *  audio segment through the addressed trace + turn trigger + obs. */
  utteranceId?: string;
  /** wall-clock the transcript landed (vs endedAt = when the sound stopped). */
  sttFinalAt?: number;
  confTier?: string;
  avgLogprob?: number | null;
  noSpeechProb?: number | null;
  compressionRatio?: number | null;
  /** voice fingerprint (hearing-identity): best enrolled candidate + match flag. */
  voice?: { name: string; score?: number; match?: boolean };
}

export class BusyQueue {
  #q = new Map<string, HeardUtterance[]>();

  /** Queue an utterance heard while the dock was busy. Order preserved. */
  add(u: HeardUtterance): void {
    const list = this.#q.get(u.dockId);
    if (list) list.push(u);
    else this.#q.set(u.dockId, [u]);
  }

  /** Remove + return everything queued for a dock (empty array if none). */
  take(dock: string): HeardUtterance[] {
    const list = this.#q.get(dock) ?? [];
    this.#q.delete(dock);
    return list;
  }

  /** Put items back at the FRONT (a held drain) — anything queued meanwhile
   *  stays behind them, preserving spoken order. */
  putBack(dock: string, items: HeardUtterance[]): void {
    if (items.length === 0) return;
    const newer = this.#q.get(dock) ?? [];
    this.#q.set(dock, [...items, ...newer]);
  }

  size(dock: string): number {
    return this.#q.get(dock)?.length ?? 0;
  }
}

/** Split items into those still fresh enough to run vs. per-item stale.
 *  Pure: staleness is each item's OWN age (now - endedAt) against the cap —
 *  an old ghost can never poison a fresh follow-up queued with it. */
export function splitByAge(items: HeardUtterance[], now: number, maxAgeMs: number):
  { fresh: HeardUtterance[]; stale: HeardUtterance[] } {
  const fresh: HeardUtterance[] = [];
  const stale: HeardUtterance[] = [];
  for (const u of items) (now - u.endedAt <= maxAgeMs ? fresh : stale).push(u);
  return { fresh, stale };
}

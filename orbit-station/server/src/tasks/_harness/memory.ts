/**
 * DockMemory — a task's DIRECT, dock-scoped handle on the station's durable memory.
 *
 * Memory is a sqlite file (`.data/orbit.db`) + an embedder that needs only the env
 * GEMINI key — all reconstructible from the SHARED code + `.env` a task process
 * already has. So a task reaches it DIRECTLY here (same `MemoryStore` class the
 * station uses), NOT over the wire — the wire (capabilities) is reserved for the
 * station's live in-process state. See tasks.md "direct vs. the wire".
 *
 * The dock is BOUND at construction (the task's verified identity, never an
 * argument), so every op is implicitly scoped to this task's own dock — a task can
 * neither read nor mutate another dock's beliefs.
 *
 * Heavy deps (the store, the embedder, sqlite) are imported lazily on first use, so a
 * task that never touches memory pays nothing.
 */
import type { MemoryStore, MemoryType, MemoryRow } from '../../modules/perception/memory/store.js';

/** One recalled belief (the author-facing subset). */
export interface MemoryHit {
  id: string;
  type: string;
  subject: string;
  claim: string;
  confidence: number;
  createdAt: number;
}

const trim = (r: MemoryRow): MemoryHit =>
  ({ id: r.id, type: r.type, subject: r.subject, claim: r.claim, confidence: r.confidence, createdAt: r.createdAt });

export class DockMemory {
  #store?: MemoryStore;
  /** `store` is injectable for tests (an in-memory MemoryStore); production omits it
   *  and the SAME store the station uses is opened lazily from shared code + `.env`. */
  constructor(private readonly dock: string, store?: MemoryStore) { this.#store = store; }

  /** Lazily open the SAME store the station uses (shared code + `.env` + db file). */
  async #s(): Promise<MemoryStore> {
    if (!this.#store) {
      const { MemoryStore } = await import('../../modules/perception/memory/store.js');
      const { orbitDb } = await import('../../core/db.js');
      const { geminiEmbedder } = await import('../../modules/perception/memory/embedder.js');
      this.#store = new MemoryStore(orbitDb(), geminiEmbedder());
    }
    return this.#store;
  }

  /** Recall this dock's beliefs. `query` ⇒ semantic; subject/type filter. */
  async recall(f: { query?: string; subject?: string; type?: string; limit?: number; includeInactive?: boolean } = {}): Promise<MemoryHit[]> {
    const s = await this.#s();
    const rows = await s.recall({
      dockId: this.dock,
      query: f.query, subject: f.subject, type: f.type as MemoryType | undefined,
      limit: f.limit, includeInactive: f.includeInactive,
    });
    return rows.map(trim);
  }

  /** Record a NEW durable belief; returns the new memory id. */
  async remember(m: { type: string; claim: string; subject?: string; confidence?: number }): Promise<string> {
    const claim = m.claim?.trim();
    if (!claim) throw new Error('remember needs a non-empty claim');
    const s = await this.#s();
    return s.remember({ dockId: this.dock, type: m.type as MemoryType, claim, subject: m.subject, confidence: m.confidence });
  }

  /** CORRECT a belief (supersedes; history kept). Returns the new id, or null if unknown.
   *  Refuses an id that belongs to another dock (defence-in-depth, though the store is
   *  the same one — keeps the dock-scoping contract honest). */
  async revise(id: string, patch: { claim?: string; confidence?: number; subject?: string }): Promise<string | null> {
    const s = await this.#s();
    const existing = s.get(id);
    if (existing && existing.dockId !== this.dock) throw new Error('that memory belongs to another dock');
    return s.revise(id, patch);
  }

  /** Retire a belief from active recall (history preserved). */
  async forget(id: string): Promise<boolean> {
    const s = await this.#s();
    const existing = s.get(id);
    if (existing && existing.dockId !== this.dock) throw new Error('that memory belongs to another dock');
    return s.forget(id);
  }

  /** Inspect a belief + its lineage ("why do I believe this"). */
  async inspect(id: string) {
    const s = await this.#s();
    const m = s.get(id);
    if (!m || m.dockId !== this.dock) return undefined;
    return { memory: m, lineage: s.lineage(id) };
  }
}

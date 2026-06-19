/**
 * The dock MEMORY store — the unified, per-dock, evolving memory sub-system
 * (docs/perception-to-agent.md Decision 4). One sqlite-backed store of MEMORIES,
 * each described by three axes + confidence, every derived one carrying LINEAGE,
 * and everything mutable: revise (supersede, history kept) and forget (purge),
 * never mutate-in-place. Recall has two modes — structured (exact filters) and
 * semantic (in-process cosine over per-memory embeddings, from v1).
 *
 * We GENERALIZE the face gallery's proven pattern (evolving, provenance-carrying,
 * per-dock) rather than invent a new one; the gallery folds in as `type:'person'`
 * later (4.5) behind the same surface.
 *
 * Design choices realized here:
 *  • axes are SEPARATE columns (type/subject/derivation) — never conflated; subject
 *    is an exact normalized string (NOT a vector — vectors fuzz an exact lookup);
 *  • SUPERSEDE, not delete: a revision inserts a new row + marks the old `revised`,
 *    linked by `supersedes`, so "what did you believe last week?" stays answerable;
 *  • embeddings BLOB on every memory; recall does a brute-force cosine scan over the
 *    dock's bounded set (hundreds–low-thousands of rows) — sub-ms, no vector DB;
 *  • the db handle + the embedder are INJECTED, so tests run against `:memory:` with
 *    a deterministic fake embedder (no file, no network).
 */

import type { Database } from 'better-sqlite3';
import { randomUUID } from 'node:crypto';

/** The memory taxonomy (Decision 4.3). `person` = the face-gallery kind. Open by
 *  design — retention/revision policy is keyed on this (a `summary` ages out; a
 *  `person` is revised, rarely purged). v1 set; extend as needs surface. */
export type MemoryType = 'person' | 'summary' | 'event' | 'preference' | 'fact' | 'place';

/** Straight from a snapshot stream vs. a summary/inference (derived → carries lineage). */
export type Derivation = 'observed' | 'derived';

/** A memory's lifecycle: the current best belief (`active`), a superseded prior
 *  version (`revised`, kept for lineage/history), or purged (`forgotten`). */
export type MemoryStatus = 'active' | 'revised' | 'forgotten';

/** One lineage edge: what a DERIVED memory was built from (a snapshot record, a
 *  summary, another memory…). `source_kind` is free ('snapshot'|'memory'|…). */
export interface LineageEdge { sourceKind: string; sourceId: string }

export interface MemoryRow {
  id: string;
  dockId: string;
  type: MemoryType;
  subject: string;          // normalized entity tag ('guru', 'kitchen'); '' if none
  claim: string;            // the human-readable belief ("prefers tea")
  valueJson: unknown;       // structured extra (free-form), or null
  confidence: number;       // 0..1, first-class on EVERY memory
  derivation: Derivation;
  status: MemoryStatus;
  createdAt: number;        // ms
  validFrom: number;        // ms — when this belief took effect
  validTo: number | null;   // ms — when superseded/forgotten; null while active
  supersedes: string | null; // the prior memory id this revised, if any
}

export interface NewMemory {
  dockId: string;
  type: MemoryType;
  subject?: string;
  claim: string;
  value?: unknown;
  confidence?: number;        // default 0.6
  derivation?: Derivation;    // default 'observed'
  validFrom?: number;         // default now
  lineage?: LineageEdge[];    // for derived memories
}

export interface RecallFilter {
  dockId: string;
  type?: MemoryType;
  subject?: string;
  /** [fromMs, toMs] overlap on a memory's valid interval. */
  interval?: { from?: number; to?: number };
  /** natural-language query → semantic cosine ranking over embeddings. */
  query?: string;
  /** include superseded/forgotten too (default: active only). */
  includeInactive?: boolean;
  limit?: number;             // default 20
}

/** A pluggable text→vector embedder. Returns null on failure (the memory is still
 *  stored, just not semantically recallable until re-embedded). Injected so tests
 *  use a deterministic local fake and prod uses a real model/API. */
export type Embedder = (text: string) => Promise<Float32Array | null>;

/** Cosine similarity of two equal-length vectors; 0 if either is empty/mismatched. */
export function cosine(a: Float32Array, b: Float32Array): number {
  if (a.length === 0 || a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i]! * b[i]!; na += a[i]! * a[i]!; nb += b[i]! * b[i]!; }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** Normalize a subject tag to an exact-match key: lowercased, trimmed, collapsed. */
export function normSubject(s: string | undefined): string {
  return (s ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function f32ToBlob(v: Float32Array): Buffer {
  return Buffer.from(v.buffer, v.byteOffset, v.byteLength);
}
function blobToF32(b: Buffer | null): Float32Array | null {
  if (!b || b.length === 0) return null;
  // copy so the Float32Array doesn't alias a reused sqlite buffer
  return new Float32Array(new Uint8Array(b).slice().buffer);
}

export class MemoryStore {
  #db: Database;
  #embed: Embedder;

  /** `db` and `embed` are injected (tests pass `:memory:` + a fake embedder). */
  constructor(db: Database, embed: Embedder) {
    this.#db = db;
    this.#embed = embed;
    this.#initSchema();
  }

  #initSchema(): void {
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS memory (
        id TEXT PRIMARY KEY,
        dock_id TEXT NOT NULL,
        type TEXT NOT NULL,
        subject TEXT NOT NULL DEFAULT '',
        claim TEXT NOT NULL,
        value_json TEXT,
        confidence REAL NOT NULL DEFAULT 0.6,
        derivation TEXT NOT NULL DEFAULT 'observed',
        status TEXT NOT NULL DEFAULT 'active',
        created_at INTEGER NOT NULL,
        valid_from INTEGER NOT NULL,
        valid_to INTEGER,
        supersedes TEXT,
        embedding BLOB
      );
      CREATE INDEX IF NOT EXISTS memory_dock_status ON memory (dock_id, status);
      CREATE INDEX IF NOT EXISTS memory_dock_subject ON memory (dock_id, subject);
      CREATE INDEX IF NOT EXISTS memory_dock_type ON memory (dock_id, type);
      CREATE TABLE IF NOT EXISTS memory_lineage (
        memory_id TEXT NOT NULL,
        source_kind TEXT NOT NULL,
        source_id TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS memory_lineage_mid ON memory_lineage (memory_id);
    `);
  }

  /** Record a NEW memory. Derived memories should pass `lineage`. Returns the id. */
  async remember(m: NewMemory): Promise<string> {
    const id = randomUUID();
    const now = Date.now();
    const emb = await this.#embed(`${m.subject ? m.subject + ': ' : ''}${m.claim}`).catch(() => null);
    this.#db.prepare(`
      INSERT INTO memory (id, dock_id, type, subject, claim, value_json, confidence,
        derivation, status, created_at, valid_from, valid_to, supersedes, embedding)
      VALUES (@id, @dock, @type, @subject, @claim, @value, @confidence,
        @derivation, 'active', @now, @validFrom, NULL, NULL, @embedding)
    `).run({
      id, dock: m.dockId, type: m.type, subject: normSubject(m.subject),
      claim: m.claim, value: m.value != null ? JSON.stringify(m.value) : null,
      confidence: m.confidence ?? 0.6, derivation: m.derivation ?? 'observed',
      now, validFrom: m.validFrom ?? now,
      embedding: emb ? f32ToBlob(emb) : null,
    });
    if (m.lineage?.length) this.#insertLineage(id, m.lineage);
    return id;
  }

  #insertLineage(memoryId: string, edges: LineageEdge[]): void {
    const stmt = this.#db.prepare(
      `INSERT INTO memory_lineage (memory_id, source_kind, source_id) VALUES (?, ?, ?)`);
    for (const e of edges) stmt.run(memoryId, e.sourceKind, e.sourceId);
  }

  /** Get one memory by id (any status), or undefined. */
  get(id: string): MemoryRow | undefined {
    const r = this.#db.prepare(`SELECT * FROM memory WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
    return r ? rowToMemory(r) : undefined;
  }

  /** A memory's lineage edges (what it was derived from). */
  lineage(id: string): LineageEdge[] {
    const rows = this.#db.prepare(
      `SELECT source_kind, source_id FROM memory_lineage WHERE memory_id = ?`).all(id) as Array<{ source_kind: string; source_id: string }>;
    return rows.map((r) => ({ sourceKind: r.source_kind, sourceId: r.source_id }));
  }

  /**
   * REVISE a memory: insert a new active version (carrying over axes unless
   * overridden) and mark the old one `revised` (kept for history), linked via
   * `supersedes`. Returns the new id, or null if `id` isn't an active memory.
   */
  async revise(id: string, patch: { claim?: string; value?: unknown; confidence?: number; subject?: string }): Promise<string | null> {
    const old = this.get(id);
    if (!old || old.status !== 'active') return null;
    const now = Date.now();
    const newId = randomUUID();
    const claim = patch.claim ?? old.claim;
    const subject = patch.subject ?? old.subject;
    const emb = await this.#embed(`${subject ? subject + ': ' : ''}${claim}`).catch(() => null);
    const tx = this.#db.transaction(() => {
      this.#db.prepare(`UPDATE memory SET status='revised', valid_to=@now WHERE id=@id`).run({ now, id });
      this.#db.prepare(`
        INSERT INTO memory (id, dock_id, type, subject, claim, value_json, confidence,
          derivation, status, created_at, valid_from, valid_to, supersedes, embedding)
        VALUES (@id, @dock, @type, @subject, @claim, @value, @confidence,
          @derivation, 'active', @now, @now, NULL, @supersedes, @embedding)
      `).run({
        id: newId, dock: old.dockId, type: old.type, subject: normSubject(subject),
        claim, value: patch.value !== undefined ? (patch.value != null ? JSON.stringify(patch.value) : null) : (old.valueJson != null ? JSON.stringify(old.valueJson) : null),
        confidence: patch.confidence ?? old.confidence, derivation: old.derivation,
        now, supersedes: id, embedding: emb ? f32ToBlob(emb) : null,
      });
    });
    tx();
    return newId;
  }

  /** FORGET (purge): mark a memory `forgotten`. History stays (not a row delete),
   *  but it drops out of active recall. Returns false if `id` is unknown. */
  forget(id: string): boolean {
    const r = this.#db.prepare(
      `UPDATE memory SET status='forgotten', valid_to=COALESCE(valid_to, @now) WHERE id=@id AND status != 'forgotten'`)
      .run({ now: Date.now(), id });
    return r.changes > 0;
  }

  /**
   * RECALL — structured filters AND/OR a semantic query. Active-only by default.
   * Structured filters narrow the candidate set (indexed); a `query` then ranks the
   * survivors by cosine over their embeddings (best first). Without a query, results
   * are most-recent-first.
   */
  async recall(f: RecallFilter): Promise<MemoryRow[]> {
    const where: string[] = ['dock_id = @dock'];
    const params: Record<string, unknown> = { dock: f.dockId };
    if (!f.includeInactive) where.push(`status = 'active'`);
    if (f.type) { where.push('type = @type'); params.type = f.type; }
    if (f.subject) { where.push('subject = @subject'); params.subject = normSubject(f.subject); }
    // interval = WHEN the belief took effect (valid_from in [from,to]) — the
    // intuitive "what happened / what did I learn in this window" grammar, not an
    // open-ended-validity overlap (an active memory's validity runs to ∞, which
    // would match every window and drown the recent ones).
    if (f.interval?.from != null) { where.push('valid_from >= @from'); params.from = f.interval.from; }
    if (f.interval?.to != null) { where.push('valid_from <= @to'); params.to = f.interval.to; }

    // rowid DESC tiebreaks same-ms inserts deterministically (newest first).
    const rows = this.#db.prepare(
      `SELECT * FROM memory WHERE ${where.join(' AND ')} ORDER BY valid_from DESC, rowid DESC`)
      .all(params) as Array<Record<string, unknown>>;
    const memories = rows.map(rowToMemory);
    const limit = f.limit ?? 20;

    if (!f.query) return memories.slice(0, limit);

    // semantic rank: embed the query, cosine against each candidate's stored vector.
    const qv = await this.#embed(f.query).catch(() => null);
    if (!qv) return memories.slice(0, limit); // embedder down → fall back to recency
    const scored = rows.map((r, i) => ({
      m: memories[i]!, score: cosine(qv, blobToF32(r.embedding as Buffer | null) ?? new Float32Array()),
    }));
    return scored.sort((a, b) => b.score - a.score).slice(0, limit).map((s) => s.m);
  }

  /** Distinct subjects this dock has active memories about (orientation tool). */
  subjects(dockId: string): string[] {
    const rows = this.#db.prepare(
      `SELECT DISTINCT subject FROM memory WHERE dock_id = ? AND status='active' AND subject != '' ORDER BY subject`)
      .all(dockId) as Array<{ subject: string }>;
    return rows.map((r) => r.subject);
  }

  /** The most recent active memories (orientation tool). */
  recent(dockId: string, limit = 10): MemoryRow[] {
    const rows = this.#db.prepare(
      `SELECT * FROM memory WHERE dock_id = ? AND status='active' ORDER BY valid_from DESC, rowid DESC LIMIT ?`)
      .all(dockId, limit) as Array<Record<string, unknown>>;
    return rows.map(rowToMemory);
  }

  /** Count of active memories for a dock (cheap health/console stat). */
  count(dockId: string): number {
    const r = this.#db.prepare(
      `SELECT COUNT(*) AS n FROM memory WHERE dock_id = ? AND status='active'`).get(dockId) as { n: number };
    return r.n;
  }
}

function rowToMemory(r: Record<string, unknown>): MemoryRow {
  return {
    id: r.id as string,
    dockId: r.dock_id as string,
    type: r.type as MemoryType,
    subject: r.subject as string,
    claim: r.claim as string,
    valueJson: r.value_json != null ? JSON.parse(r.value_json as string) : null,
    confidence: r.confidence as number,
    derivation: r.derivation as Derivation,
    status: r.status as MemoryStatus,
    createdAt: r.created_at as number,
    validFrom: r.valid_from as number,
    validTo: (r.valid_to as number | null) ?? null,
    supersedes: (r.supersedes as string | null) ?? null,
  };
}

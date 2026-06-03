/**
 * Config persistence + validation, backed by orbit.db (config_entries).
 *
 * Keys are FLAT/global (no scope). The REGISTRY declares every knob (type, Zod
 * schema, default, UI tags). The store holds the live effective value per key:
 * default unless overridden, with a `lastUpdated` stamp on every write. Writes
 * are VALIDATED against the entry's Zod schema before they land. Hydrates
 * overrides from the db on boot; a fresh db means every key is its baked
 * default.
 */

import type Database from 'better-sqlite3';
import { z } from 'zod';
import { orbitDb } from '../../core/db.js';
import { REGISTRY, findEntry, type ConfigEntry, type Tag } from './registry.js';

export interface EffectiveEntry {
  key: string;
  type: ConfigEntry['type'];
  value: unknown;
  lastUpdated: number;
  isDefault: boolean;       // true = no override; still the baked default
  tags: Tag[];
  label?: string;
  description?: string;
  jsonSchema?: unknown;     // for type 'json' editors
}

export interface ValidationError {
  error: string;
  issues?: unknown;
}

export class ConfigStore {
  #db: Database.Database;
  /** key → { value, lastUpdated } for overridden keys only. */
  #overrides = new Map<string, { value: unknown; lastUpdated: number }>();

  constructor() {
    this.#db = orbitDb();
    this.#initSchema();
    this.#hydrate();
  }

  #initSchema(): void {
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS config_entries (
        key TEXT PRIMARY KEY, value TEXT, type TEXT, last_updated INTEGER
      );
    `);
  }

  #hydrate(): void {
    const rows = this.#db
      .prepare(`SELECT key, value, last_updated FROM config_entries`)
      .all() as Array<{ key: string; value: string; last_updated: number }>;
    for (const r of rows) {
      if (!findEntry(r.key)) continue; // key dropped from registry — ignore
      this.#overrides.set(r.key, { value: JSON.parse(r.value), lastUpdated: r.last_updated });
    }
  }

  #effective(e: ConfigEntry): EffectiveEntry {
    const ov = this.#overrides.get(e.key);
    return {
      key: e.key, type: e.type,
      value: ov ? ov.value : e.default,
      lastUpdated: ov ? ov.lastUpdated : 0,
      isDefault: !ov,
      tags: e.tags,
      label: e.label, description: e.description,
      jsonSchema: e.type === 'json' ? (e.jsonSchema ?? z.toJSONSchema(e.schema)) : undefined,
    };
  }

  /** All effective entries, optionally filtered to a set of keys. */
  list(keys?: Set<string>): EffectiveEntry[] {
    return REGISTRY.filter((e) => !keys || keys.has(e.key)).map((e) => this.#effective(e));
  }

  get(key: string): EffectiveEntry | undefined {
    const e = findEntry(key);
    return e ? this.#effective(e) : undefined;
  }

  /** Flat export for the build bake: key → value (defaults included). */
  export(): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const e of this.list()) out[e.key] = e.value;
    return out;
  }

  /**
   * Validate + persist one key. Returns the new effective entry, or a
   * ValidationError if the value fails the entry's schema / the key is unknown.
   * Always stamps a fresh lastUpdated (so a re-save bumps the version).
   */
  set(key: string, value: unknown): EffectiveEntry | ValidationError {
    const e = findEntry(key);
    if (!e) return { error: `unknown config key ${key}` };
    const parsed = e.schema.safeParse(value);
    if (!parsed.success) return { error: `invalid value for ${key}`, issues: parsed.error.issues };

    const now = Date.now();
    this.#overrides.set(key, { value: parsed.data, lastUpdated: now });
    this.#db
      .prepare(
        `INSERT INTO config_entries(key,value,type,last_updated) VALUES(?,?,?,?)
         ON CONFLICT(key) DO UPDATE SET value=excluded.value, last_updated=excluded.last_updated`,
      )
      .run(key, JSON.stringify(parsed.data), e.type, now);
    return this.#effective(e);
  }

  /** Reset a key to its registry default (drops the override). */
  reset(key: string): EffectiveEntry | ValidationError {
    const e = findEntry(key);
    if (!e) return { error: `unknown config key ${key}` };
    this.#overrides.delete(key);
    this.#db.prepare(`DELETE FROM config_entries WHERE key=?`).run(key);
    return this.#effective(e);
  }
}

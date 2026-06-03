/**
 * Config persistence + validation, backed by orbit.db (config_entries).
 *
 * The REGISTRY declares every knob (type, Zod schema, default). The store holds
 * the live effective value per key: default unless overridden, with a
 * `lastUpdated` stamp on every write. Writes are VALIDATED against the entry's
 * Zod schema before they land. Hydrates overrides from the db on boot; a fresh
 * db means every key resolves to its baked default.
 */

import type Database from 'better-sqlite3';
import { z } from 'zod';
import { orbitDb } from '../../core/db.js';
import { REGISTRY, findEntry, type ConfigEntry, type Scope } from './registry.js';

export interface EffectiveEntry {
  scope: Scope;
  key: string;
  type: ConfigEntry['type'];
  value: unknown;
  lastUpdated: number;
  isDefault: boolean;       // true = no override; still the baked default
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
  /** scope.key → { value, lastUpdated } for overridden keys only. */
  #overrides = new Map<string, { value: unknown; lastUpdated: number }>();

  constructor() {
    this.#db = orbitDb();
    this.#initSchema();
    this.#hydrate();
  }

  #initSchema(): void {
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS config_entries (
        scope TEXT, key TEXT, value TEXT, type TEXT, last_updated INTEGER,
        PRIMARY KEY (scope, key)
      );
    `);
  }

  #hydrate(): void {
    const rows = this.#db
      .prepare(`SELECT scope, key, value, last_updated FROM config_entries`)
      .all() as Array<{ scope: string; key: string; value: string; last_updated: number }>;
    for (const r of rows) {
      // ignore rows for keys no longer in the registry (schema evolved).
      if (!findEntry(r.scope, r.key)) continue;
      this.#overrides.set(`${r.scope}.${r.key}`, { value: JSON.parse(r.value), lastUpdated: r.last_updated });
    }
  }

  /** One effective entry (override if present, else the registry default). */
  #effective(e: ConfigEntry): EffectiveEntry {
    const ov = this.#overrides.get(`${e.scope}.${e.key}`);
    return {
      scope: e.scope, key: e.key, type: e.type,
      value: ov ? ov.value : e.default,
      lastUpdated: ov ? ov.lastUpdated : 0,
      isDefault: !ov,
      label: e.label, description: e.description,
      jsonSchema: e.type === 'json' ? (e.jsonSchema ?? z.toJSONSchema(e.schema)) : undefined,
    };
  }

  /** All effective entries, optionally filtered to one scope. */
  list(scope?: Scope): EffectiveEntry[] {
    return REGISTRY.filter((e) => !scope || e.scope === scope).map((e) => this.#effective(e));
  }

  get(scope: string, key: string): EffectiveEntry | undefined {
    const e = findEntry(scope, key);
    return e ? this.#effective(e) : undefined;
  }

  /** Flat export for the build bake: scope → key → value. Defaults included. */
  export(): Record<string, Record<string, unknown>> {
    const out: Record<string, Record<string, unknown>> = {};
    for (const e of this.list()) (out[e.scope] ??= {})[e.key] = e.value;
    return out;
  }

  /**
   * Validate + persist one key. Returns the new effective entry, or a
   * ValidationError if the value fails the entry's schema / the key is unknown.
   * Always stamps a fresh lastUpdated (so a re-save of the same value still
   * bumps the version — handy alongside forcePush).
   */
  set(scope: string, key: string, value: unknown): EffectiveEntry | ValidationError {
    const e = findEntry(scope, key);
    if (!e) return { error: `unknown config key ${scope}.${key}` };
    const parsed = e.schema.safeParse(value);
    if (!parsed.success) return { error: `invalid value for ${scope}.${key}`, issues: parsed.error.issues };

    const now = Date.now();
    this.#overrides.set(`${scope}.${key}`, { value: parsed.data, lastUpdated: now });
    this.#db
      .prepare(
        `INSERT INTO config_entries(scope,key,value,type,last_updated) VALUES(?,?,?,?,?)
         ON CONFLICT(scope,key) DO UPDATE SET value=excluded.value, last_updated=excluded.last_updated`,
      )
      .run(scope, key, JSON.stringify(parsed.data), e.type, now);
    return this.#effective(e);
  }

  /** Reset a key to its registry default (drops the override). */
  reset(scope: string, key: string): EffectiveEntry | ValidationError {
    const e = findEntry(scope, key);
    if (!e) return { error: `unknown config key ${scope}.${key}` };
    this.#overrides.delete(`${scope}.${key}`);
    this.#db.prepare(`DELETE FROM config_entries WHERE scope=? AND key=?`).run(scope, key);
    return this.#effective(e);
  }
}

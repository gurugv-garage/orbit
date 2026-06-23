/**
 * Device→dock bindings — the station-owned source of truth for which dock a
 * physical device belongs to (docs/modules/runtime-dock-binding.md).
 *
 * The dock name used to be compiled into each device (app local.properties,
 * firmware secrets.h). Instead, a device now dials in with only its STABLE
 * hardware id (phone: Settings.Secure.ANDROID_ID; body: full MAC) and learns
 * its dock name back from the station. This table is that mapping; it survives
 * app uninstall / firmware reflash because it lives here, not on the device.
 *
 * The slot/component is NOT stored — it's derived from the device's hello
 * `kind` (dock-android-app → phone, dock-body-fw → body), so a part can come
 * from any matching hardware and the operator only ever picks a dock NAME.
 *
 * Backed by the shared orbit.db (table `dock_bindings`), same pattern as
 * config's store.
 */

import type Database from 'better-sqlite3';
import { orbitDb } from '../../core/db.js';

export interface DockBinding {
  deviceId: string;
  dock: string;
  lastUpdated: number;
}

export class BindingStore {
  #db: Database.Database;
  /** deviceId → dock, hydrated from the db; the live lookup path. */
  #cache = new Map<string, string>();

  /** Defaults to the shared orbit.db; tests pass an in-memory Database. */
  constructor(db: Database.Database = orbitDb()) {
    this.#db = db;
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS dock_bindings (
        device_id TEXT PRIMARY KEY, dock TEXT NOT NULL, last_updated INTEGER
      );
    `);
    const rows = this.#db
      .prepare(`SELECT device_id, dock FROM dock_bindings`)
      .all() as Array<{ device_id: string; dock: string }>;
    for (const r of rows) this.#cache.set(r.device_id, r.dock);
  }

  /** The dock a device is bound to, or undefined (unclaimed). */
  lookup(deviceId: string): string | undefined {
    return this.#cache.get(deviceId);
  }

  /** Bind (or rebind) a device to a dock. Idempotent; bumps last_updated. */
  bind(deviceId: string, dock: string): void {
    const now = Date.now();
    this.#db
      .prepare(
        `INSERT INTO dock_bindings(device_id, dock, last_updated) VALUES(?,?,?)
         ON CONFLICT(device_id) DO UPDATE SET dock=excluded.dock, last_updated=excluded.last_updated`,
      )
      .run(deviceId, dock, now);
    this.#cache.set(deviceId, dock);
  }

  /** Forget a device's binding — it re-parks unclaimed on next hello. */
  unbind(deviceId: string): boolean {
    const r = this.#db.prepare(`DELETE FROM dock_bindings WHERE device_id = ?`).run(deviceId);
    this.#cache.delete(deviceId);
    return r.changes > 0;
  }

  /** All bindings (for the console / debugging). */
  list(): DockBinding[] {
    return (
      this.#db
        .prepare(`SELECT device_id, dock, last_updated FROM dock_bindings ORDER BY last_updated DESC`)
        .all() as Array<{ device_id: string; dock: string; last_updated: number }>
    ).map((r) => ({ deviceId: r.device_id, dock: r.dock, lastUpdated: r.last_updated }));
  }
}

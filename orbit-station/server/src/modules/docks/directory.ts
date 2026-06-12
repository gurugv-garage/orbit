/**
 * The dock directory — the one place dock COMPOSITION lives.
 *
 * A dock is a named composition of components (docs/SERVER-BRAIN-IMPL.md §2):
 * the directory tracks which slots a dock is expected to have (the manifest),
 * which peer currently fills each slot (from the live roster), and resolves
 * addresses for the rest of the station:
 *
 *   resolve(dock, component)  → the online peer filling a slot
 *   resolveCap(dock, cap)     → the online peer serving a capability
 *
 * Modules route by capability ("send speak to whoever serves 'voice'"), so a
 * differently-shaped dock needs no station changes.
 *
 * Manifests are auto-learned (first hello of an unknown slot adds it) and
 * console-editable; they persist to .data/docks.json along with the last-known
 * view of each component so offline members still render ("body expected but
 * offline" is knowable only because composition is declared).
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { RosterEntry } from '../../core/hub.js';
import type { DockComponent, DockInfo } from '../../core/protocol.js';

interface PersistedDock {
  manifest: string[];
  /** last-known view per slot, kept so offline components render. */
  lastKnown: Record<string, Omit<DockComponent, 'online'>>;
}

export class Directory {
  #getRoster: () => RosterEntry[];
  #file: string;
  #docks = new Map<string, PersistedDock>();

  constructor(getRoster: () => RosterEntry[], file = '.data/docks.json') {
    this.#getRoster = getRoster;
    this.#file = file;
    this.#load();
  }

  /** The online peer filling (dock, component), if any. */
  resolve(dock: string, component: string): RosterEntry | undefined {
    // Newest-wins on collision is enforced by the hub (it terminates the
    // displaced peer), so at most one live peer matches an address.
    return this.#getRoster().find(
      (p) => p.role !== 'browser' && p.dock === dock && p.component === component,
    );
  }

  /** The online peer in `dock` serving capability `cap`, if any. */
  resolveCap(dock: string, cap: string): RosterEntry | undefined {
    return this.#getRoster().find(
      (p) => p.role !== 'browser' && p.dock === dock && (p.caps ?? []).includes(cap),
    );
  }

  /** Record a sighting of a component (on peer-joined): learns unknown slots
   *  into the manifest and refreshes the last-known view. Returns true if the
   *  dock's persisted shape changed (manifest grew or component identity
   *  changed). */
  noteSeen(p: RosterEntry): boolean {
    if (!p.dock || !p.component) return false;
    const d = this.#dock(p.dock);
    let changed = false;
    if (!d.manifest.includes(p.component)) {
      d.manifest.push(p.component);
      changed = true;
    }
    const prev = d.lastKnown[p.component];
    const next = snapshot(p);
    if (JSON.stringify(prev) !== JSON.stringify(next)) {
      d.lastKnown[p.component] = next;
      changed = true;
    }
    if (changed) this.#save();
    return changed;
  }

  /** Current composed view of one dock: manifest ∪ observed, live state merged. */
  dockInfo(name: string): DockInfo {
    const d = this.#docks.get(name) ?? { manifest: [], lastKnown: {} };
    const live = this.#getRoster().filter((p) => p.role !== 'browser' && p.dock === name);
    const slots = new Set<string>([...d.manifest, ...Object.keys(d.lastKnown)]);
    for (const p of live) if (p.component) slots.add(p.component);

    const components: DockComponent[] = [...slots].map((slot) => {
      const onlinePeer = live.find((p) => p.component === slot);
      if (onlinePeer) return { ...snapshot(onlinePeer), online: true };
      const known = d.lastKnown[slot];
      if (known) return { ...known, online: false };
      // declared in the manifest but never seen
      return { component: slot, id: '', online: false };
    });
    return { name, manifest: [...d.manifest], components };
  }

  /** All docks the directory knows (persisted ∪ live). */
  docks(): DockInfo[] {
    const names = new Set<string>(this.#docks.keys());
    for (const p of this.#getRoster()) if (p.role !== 'browser' && p.dock) names.add(p.dock);
    return [...names].map((n) => this.dockInfo(n));
  }

  /** Forget a dock entirely (test docks, retired hardware). Refused while
   *  any of its components is live — disconnect first, then forget. */
  forget(name: string): boolean {
    if (this.#getRoster().some((p) => p.role !== 'browser' && p.dock === name)) return false;
    const had = this.#docks.delete(name);
    if (had) this.#save();
    return had;
  }

  /** Console edit: replace a dock's expected composition. */
  setManifest(dock: string, manifest: string[]): void {
    this.#dock(dock).manifest = [...new Set(manifest)];
    this.#save();
  }

  #dock(name: string): PersistedDock {
    let d = this.#docks.get(name);
    if (!d) {
      d = { manifest: [], lastKnown: {} };
      this.#docks.set(name, d);
    }
    return d;
  }

  #load(): void {
    try {
      const raw = JSON.parse(readFileSync(this.#file, 'utf8')) as Record<string, PersistedDock>;
      for (const [name, d] of Object.entries(raw)) this.#docks.set(name, d);
    } catch {
      /* first run / unreadable → start empty */
    }
  }

  #save(): void {
    try {
      mkdirSync(dirname(this.#file), { recursive: true });
      writeFileSync(this.#file, JSON.stringify(Object.fromEntries(this.#docks), null, 2));
    } catch (err) {
      console.error('[docks] persist failed', err);
    }
  }
}

function snapshot(p: RosterEntry): Omit<DockComponent, 'online'> {
  return {
    component: p.component!,
    kind: p.kind,
    caps: p.caps,
    id: p.id,
    label: p.label,
    ip: p.ip,
    lastSeen: p.lastSeen,
    build: p.build,
    links: p.links,
  };
}

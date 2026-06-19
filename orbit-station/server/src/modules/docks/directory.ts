/**
 * The dock directory — the one place dock COMPOSITION lives.
 *
 * A dock is a named composition of components (docs/decision-traces/server-brain-impl.md §2):
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

/** A task process registers as a dock peer with component `task:<instanceId>`
 *  so the station can route directed frames to it — but a task is a transient
 *  background job, NOT part of the dock's composition. We never learn it into a
 *  manifest, persist it as a last-known component, or render it as a dock slot;
 *  the Tasks view (GET /api/brain/:dock/instances) is where tasks belong. */
function isTaskComponent(component?: string): boolean {
  return !!component && component.startsWith('task:');
}

/** loopback IPs — a peer dialing in from here is a test/web/sim client, never
 *  real hardware (real phones + the ESP32 connect over the LAN). */
function isLoopback(ip?: string): boolean {
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}

/**
 * Is this peer EPHEMERAL — show-while-live, never persist? A real dock component
 * (an actual phone app / ESP32 body) reports a firmware/app `build` over the LAN;
 * the test harness, browser `web-test-phone`, smoke runs and body sims all dial in
 * from loopback with NO build. So: loopback AND no build ⇒ ephemeral. Such a peer
 * renders only while connected and is never written to disk, so the moment it
 * disconnects its dock disappears — exactly "only real stuff shows when offline".
 */
function isEphemeralPeer(p: { ip?: string; build?: number }): boolean {
  return isLoopback(p.ip) && p.build == null;
}

/** Same test against a persisted last-known snapshot (no live `online` flag). */
function isEphemeralSnapshot(c: Omit<DockComponent, 'online'>): boolean {
  return isLoopback(c.ip) && c.build == null;
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
    // task peers are not dock composition — never learn or persist them.
    if (isTaskComponent(p.component)) return false;
    // EPHEMERAL peers (test/web/sim — loopback, no build) are show-while-live
    // only: never persisted, so their dock vanishes the moment they disconnect.
    // Only real hardware/app docks survive offline.
    if (isEphemeralPeer(p)) return false;
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
    // task peers connect under the dock but aren't dock slots — keep them out of
    // the composition view (they live in the Tasks view instead).
    const live = this.#getRoster().filter(
      (p) => p.role !== 'browser' && p.dock === name && !isTaskComponent(p.component),
    );
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

  /** Does this dock still exist in the directory — persisted, or with a live
   *  (non-browser) peer? After an ephemeral dock's last peer leaves it's neither,
   *  so the module emits dock-removed instead of a ghost announce. */
  dockExists(name: string): boolean {
    if (this.#docks.has(name)) return true;
    return this.#getRoster().some((p) => p.role !== 'browser' && p.dock === name);
  }

  /** Forget a dock entirely (test docks, retired hardware). Refused while
   *  any of its components is live — disconnect first, then forget. */
  forget(name: string): boolean {
    if (this.#getRoster().some((p) => p.role !== 'browser' && p.dock === name)) return false;
    const had = this.#docks.delete(name);
    if (had) this.#save();
    return had;
  }

  /** Drop persisted docks that are nothing but EPHEMERAL (test/web/sim) cruft —
   *  every persisted component is loopback + buildless and no REAL component is
   *  live. Going forward such peers are never persisted (see noteSeen), so this
   *  is mainly a one-time cleanup of docks captured by older builds; it also runs
   *  whenever a test dock's last real-looking trace is gone. A dock with a real
   *  persisted component (a phone/body that reported a build) is always kept so it
   *  still shows offline. Returns the names it forgot. */
  pruneEphemeral(): string[] {
    // docks with a REAL (non-ephemeral) component live right now are never pruned.
    const realLive = new Set(
      this.#getRoster()
        .filter((p) => p.role !== 'browser' && p.dock && !isEphemeralPeer(p))
        .map((p) => p.dock!),
    );
    const gone: string[] = [];
    for (const [name, d] of [...this.#docks]) {
      if (realLive.has(name)) continue;
      const comps = Object.values(d.lastKnown);
      // keep if it has any real persisted component (real hardware/app dock).
      if (comps.some((c) => !isEphemeralSnapshot(c))) continue;
      // all-ephemeral (or empty) persisted footprint → not a real dock; drop it.
      this.#docks.delete(name);
      gone.push(name);
    }
    if (gone.length) this.#save();
    return gone;
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
      let pruned = false;
      for (const [name, d] of Object.entries(raw)) {
        // one-time cleanup: earlier builds persisted task:<id> peers as dock
        // components. Drop them on load so old docks stop showing dead tasks.
        const manifest = (d.manifest ?? []).filter((c) => !isTaskComponent(c));
        const lastKnown: PersistedDock['lastKnown'] = {};
        for (const [slot, comp] of Object.entries(d.lastKnown ?? {})) {
          if (isTaskComponent(slot)) pruned = true;
          else lastKnown[slot] = comp;
        }
        if (manifest.length !== (d.manifest ?? []).length) pruned = true;
        this.#docks.set(name, { manifest, lastKnown });
      }
      if (pruned) this.#save();
      // drop test/web/sim docks captured by older builds (loopback + no build):
      // only real hardware/app docks should persist + show when offline.
      this.pruneEphemeral();
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

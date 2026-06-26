/**
 * ActuatorLease — the body's PRIORITY arbiter (the keystone, faceFollow decision trace §4).
 *
 * `MotionExecutor` is "the body's single master, last-write-wins". That's fine for
 * fire-and-forget callers (a brain gesture, a console nudge), but the moment a behaviour
 * (faceFollow) drives the body CONTINUOUSLY, N masters fight: thrash, and a crashed
 * follower could freeze the body mid-pan. The lease sits in front of every motion call and
 * arbitrates by PRIORITY:
 *
 *   - A caller holds the body at a priority. The HIGHEST active priority wins.
 *   - A higher-priority acquire PREEMPTS the current holder (fires its preempt callback so
 *     it stops cleanly — e.g. faceFollow pauses, then auto-resumes when the body is released).
 *   - EQUAL priority = last-write-wins (today's behaviour, preserved) — the new acquirer
 *     simply becomes the holder.
 *   - A motion call from a SUPERSEDED holder is REJECTED (no thrash).
 *   - LEASE TTL: a hold auto-EXPIRES unless renewed. So a crashed/hung holder releases the
 *     body within one TTL (the safety property) — it can never freeze the body forever.
 *
 * TWO usage modes, both arbitrated by the same table:
 *   - IMPLICIT (compat): fire-and-forget callers (brain/console/task) don't manage a lease;
 *     `admit(source)` mints a momentary hold at the source's priority on each motion call, so
 *     today's behaviour is unchanged when nothing else contends. The lease only BITES when a
 *     continuous holder is active.
 *   - EXPLICIT (a continuous behaviour): `acquire()` returns a Lease handle the holder
 *     `renew()`s each tick and `release()`s when done; it gets a `onPreempt` callback.
 *
 * Pure + time-injectable (`now`) so the arbitration table + TTL expiry are unit-testable
 * without real timers.
 */

/** Priority levels (higher wins). Indicative — tune in the build. */
export const PRIORITY = {
  emergency: 100,   // future: "stop, about to fall" — outranks even the brain
  brainTurn: 60,    // a conversation gesture / explicit user `move`
  faceFollow: 30,   // the reflex — yields to the brain, outranks idle/console
  console: 20,      // manual sliders
  idle: 0,          // heartbeat / nothing
} as const;

/** Map a motion `source` tag (already threaded through MotionExecutor) → a priority. A
 *  `task:<id>` source defaults to faceFollow level (the only continuous task today); refine
 *  per-task later if other body-driving tasks appear. Unknown → console (a manual-ish nudge). */
export function priorityForSource(source: string): number {
  if (source === 'brain-turn') return PRIORITY.brainTurn;
  if (source === 'console') return PRIORITY.console;
  if (source === 'emergency') return PRIORITY.emergency;
  if (source.startsWith('task:')) return PRIORITY.faceFollow;
  if (source === 'station') return PRIORITY.idle; // heartbeat / system — yields to everything real
  return PRIORITY.console;
}

/** A live hold on a dock's body. The holder renews/releases; the arbiter expires it. */
export interface Lease {
  readonly dock: string;
  readonly holder: string;   // a label for logs ('faceFollow', `task:<id>`, …)
  readonly priority: number;
  /** still the current holder AND not expired? motion calls check this. */
  valid(): boolean;
  /** push the TTL out (call each control tick). No-op if already superseded. */
  renew(): void;
  /** give the body back; the highest waiter (if any) is NOT auto-promoted — waiters
   *  re-acquire on their next attempt (callers are loop-driven). */
  release(): void;
}

interface Hold {
  holder: string;
  priority: number;
  expiresAt: number;          // epoch ms; renew() pushes this out
  onPreempt?: () => void;     // fired when a higher priority takes the body
  token: object;              // identity (so a stale Lease handle can't act after release)
}

export interface LeaseOpts {
  /** ms a hold survives without a renew (crashed-holder safety). Default 1500. */
  ttlMs?: number;
  now?: () => number;
  log?: (line: string) => void;
}

export class ActuatorLease {
  #holds = new Map<string, Hold>();   // dock → current hold (undefined = free)
  #ttl: number;
  #now: () => number;
  #log: (line: string) => void;

  constructor(opts: LeaseOpts = {}) {
    this.#ttl = opts.ttlMs ?? 1500;
    this.#now = opts.now ?? (() => Date.now());
    this.#log = opts.log ?? (() => {});
  }

  /** The current effective holder of a dock's body (after expiry), or undefined if free. */
  current(dock: string): { holder: string; priority: number } | undefined {
    const h = this.#liveHold(dock);
    return h ? { holder: h.holder, priority: h.priority } : undefined;
  }

  /**
   * EXPLICIT acquire for a continuous holder (e.g. faceFollow). Granted iff `priority` >=
   * the current live holder's. A strictly-higher priority PREEMPTS (fires the old holder's
   * onPreempt). Equal priority = last-write-wins (the new holder takes over). Returns a
   * Lease handle, or null if a HIGHER-priority holder currently has the body.
   */
  acquire(dock: string, holder: string, priority: number, onPreempt?: () => void): Lease | null {
    const live = this.#liveHold(dock);
    if (live && priority < live.priority) {
      this.#log(`[lease] ${dock}: ${holder}(${priority}) denied — ${live.holder}(${live.priority}) holds`);
      return null; // a higher-priority holder owns the body
    }
    if (live && live.holder !== holder && priority > live.priority) {
      this.#log(`[lease] ${dock}: ${holder}(${priority}) PREEMPTS ${live.holder}(${live.priority})`);
      try { live.onPreempt?.(); } catch { /* a holder's preempt handler must not break arbitration */ }
    }
    const token = {};
    const hold: Hold = { holder, priority, onPreempt, token, expiresAt: this.#now() + this.#ttl };
    this.#holds.set(dock, hold);
    return this.#leaseFor(dock, hold);
  }

  /**
   * IMPLICIT admit for a fire-and-forget motion call (compat path). Mints/refreshes a
   * momentary hold at the source's priority so a single call goes through when nothing
   * higher contends — preserving today's last-write-wins for ordinary callers. Returns true
   * if the call is ADMITTED (caller proceeds), false if a higher-priority holder blocks it.
   */
  admit(dock: string, source: string, priority: number): boolean {
    const live = this.#liveHold(dock);
    if (live && live.holder !== source && priority < live.priority) {
      this.#log(`[lease] ${dock}: ${source}(${priority}) move blocked — ${live.holder}(${live.priority}) holds`);
      return false;
    }
    // equal-or-higher: this call becomes/refreshes the momentary holder (last-write-wins).
    if (live && live.holder !== source && priority > live.priority) {
      try { live.onPreempt?.(); } catch { /* */ }
    }
    this.#holds.set(dock, { holder: source, priority, token: {}, expiresAt: this.#now() + this.#ttl });
    return true;
  }

  /** Drop a dock's hold if it belongs to `token` (so a stale handle can't release a newer
   *  holder). Used by Lease.release(). */
  #release(dock: string, token: object): void {
    const h = this.#holds.get(dock);
    if (h && h.token === token) this.#holds.delete(dock);
  }

  /** Release iff `holder` is the current holder (the over-the-wire release path — a task can't
   *  hold a token object across the process boundary, so it releases by its holder tag). */
  releaseByHolder(dock: string, holder: string): void {
    const h = this.#holds.get(dock);
    if (h && h.holder === holder) { this.#holds.delete(dock); this.#log(`[lease] ${dock}: ${holder} released`); }
  }

  /** The current hold IF it hasn't expired; expiry frees the body (crashed-holder safety). */
  #liveHold(dock: string): Hold | undefined {
    const h = this.#holds.get(dock);
    if (!h) return undefined;
    if (this.#now() >= h.expiresAt) { this.#holds.delete(dock); this.#log(`[lease] ${dock}: ${h.holder} hold EXPIRED (ttl) — body free`); return undefined; }
    return h;
  }

  #leaseFor(dock: string, hold: Hold): Lease {
    const self = this;
    return {
      dock, holder: hold.holder, priority: hold.priority,
      valid() { return self.#holds.get(dock)?.token === hold.token && self.#now() < hold.expiresAt; },
      // renew only if STILL the holder AND not already expired — a renew after the TTL lapsed
      // must NOT resurrect a dead hold (the body was already free; someone else may take it).
      renew() {
        if (self.#holds.get(dock)?.token === hold.token && self.#now() < hold.expiresAt) {
          hold.expiresAt = self.#now() + self.#ttl;
        }
      },
      release() { self.#release(dock, hold.token); },
    };
  }
}

/**
 * Dock CONDITIONS — a generic, station-wide registry of ambient faults that
 * aren't tied to a single turn but that the user should be TOLD about.
 *
 * The motivating case: the STT sidecar is down, so the dock can't hear — every
 * utterance is silently dropped (transcribe() returns null) and no turn ever
 * starts. The error is real and known (the fetch threw ECONNREFUSED) but it
 * happens BEFORE any turn exists, so the turn-status failure path can't carry
 * it. This registry is where any layer records "this dock is currently broken
 * because X", so the next time the user tries to interact the dock can say the
 * real reason instead of sitting mute.
 *
 * Generic on purpose: a condition is just { code, message }. STT wires the
 * first cases (sidecar unreachable); vision / summarizer / others can report
 * their own faults the same way later. The brain reads it (on the addressed
 * tap) and forwards {code,message} to the phone, which speaks it — the same
 * "say the actual error" philosophy as diagnoseTurnFailure, for non-turn errors.
 */

export interface DockCondition {
  /** stable machine code, e.g. 'stt_unreachable'. */
  code: string;
  /** a short, user-facing explanation the dock can speak verbatim. */
  message: string;
  /** when it was (re)reported (epoch ms). */
  ts: number;
}

class DockConditions {
  /** dock → code → condition. Keyed by code so one layer's fault doesn't clobber
   *  another's, and clearing is precise. */
  #byDock = new Map<string, Map<string, DockCondition>>();

  /** Record (or refresh) a fault for a dock. Idempotent per code. */
  report(dock: string, code: string, message: string): void {
    let m = this.#byDock.get(dock);
    if (!m) { m = new Map(); this.#byDock.set(dock, m); }
    m.set(code, { code, message, ts: Date.now() });
  }

  /** Clear a specific fault once the layer recovers (e.g. a transcribe succeeded). */
  clear(dock: string, code: string): void {
    this.#byDock.get(dock)?.delete(code);
  }

  /** The most-relevant active condition for a dock (newest), or undefined when
   *  the dock is healthy. The brain speaks this when the user tries to interact. */
  current(dock: string): DockCondition | undefined {
    const m = this.#byDock.get(dock);
    if (!m || m.size === 0) return undefined;
    return [...m.values()].sort((a, b) => b.ts - a.ts)[0];
  }

  /** All active conditions for a dock (console / diagnostics). */
  all(dock: string): DockCondition[] {
    return [...(this.#byDock.get(dock)?.values() ?? [])];
  }
}

/** Process-wide singleton — any module imports this and reports/reads. */
export const dockConditions = new DockConditions();

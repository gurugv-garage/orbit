/**
 * Session CONTEXT composer — the one place that knows how to reach all the
 * station-side state that belongs to a session for debugging: build/version
 * provenance, the effective config, the active models, the live profile
 * (system prompt/composition), and a windowed slice of perception (with
 * STT/vision confidences + raw payloads), plus the gate/addressed decision
 * rings and the world-state grounding.
 *
 * Observability is the source of truth: the brain calls `composeEnrichment`
 * on turn end to SNAPSHOT this onto the session record (so historical sessions
 * keep their state), and the feedback flow / inspect_observability tool call it
 * (or read the stored snapshot) ON DEMAND. Whether a given field is stored vs
 * pulled live is a per-use-case choice that can evolve — this composer serves
 * both. All sources are injected accessors (wired in main.ts), each optional
 * and defensive: a missing source omits its field rather than failing.
 */

import type { SessionEnrichment, SessionRecord } from './types.js';

/** Accessors the composer reads. Wired in main.ts from the live modules. */
export interface ContextSources {
  /** build/version provenance (station git/version/node; merged app/firmware). */
  provenance?: (dock: string) => unknown;
  /** the dock's effective brain config snapshot. */
  config?: (dock: string) => Record<string, unknown> | undefined;
  /** active models: brain model + thinking + perception sidecar models. */
  models?: (dock: string) => SessionEnrichment['models'];
  /** the dock's live profile (system prompt / composition). */
  profile?: (dock: string) => Promise<unknown>;
  /** perception snapshots overlapping [fromIso,toIso] for the dock. */
  snapshots?: (fromIso: string, toIso: string, dock: string) => unknown[];
  /** recent attention-gate decisions. */
  gateDecisions?: (limit?: number) => unknown[];
  /** recent addressed-decisions for the dock. */
  addressed?: (dock: string) => unknown[];
  /** world-state / grounding text. */
  grounding?: (dock: string) => string | null | undefined;
}

/** Compose the full per-session enrichment snapshot for a dock. `span` bounds
 *  the perception window (epoch ms); defaults to the last 5 minutes. */
export async function composeEnrichment(
  dock: string,
  sources: ContextSources,
  span?: { from: number; to: number },
): Promise<Partial<SessionEnrichment>> {
  const from = span?.from ?? Date.now() - 5 * 60_000;
  const to = span?.to ?? Date.now();
  let profile: unknown;
  if (sources.profile) {
    try { profile = await sources.profile(dock); } catch { /* profile optional */ }
  }
  let perception: unknown[] | undefined;
  if (sources.snapshots) {
    try { perception = sources.snapshots(isoIst(from - 5_000), isoIst(to + 5_000), dock); } catch { /* none */ }
  }
  return {
    provenance: sources.provenance?.(dock),
    config: sources.config?.(dock),
    models: sources.models?.(dock),
    profile,
    perception,
    gateDecisions: sources.gateDecisions?.(50),
    addressed: sources.addressed?.(dock),
    grounding: sources.grounding?.(dock) ?? null,
  };
}

/** Span helper: the perception window for a session is its trace span (padded). */
export function sessionSpan(trace: SessionRecord | undefined): { from: number; to: number } | undefined {
  if (!trace) return undefined;
  return { from: trace.firstSeen, to: trace.lastSeen || trace.firstSeen };
}

/** IST ISO string for an epoch-ms timestamp (matches the snapshot store's tz). */
export function isoIst(epochMs: number): string {
  const d = new Date(epochMs + 5.5 * 3600_000);
  return d.toISOString().replace('Z', '+05:30');
}

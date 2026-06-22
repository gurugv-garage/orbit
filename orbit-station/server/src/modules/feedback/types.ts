/**
 * Feedback module types — a feedback is a full, self-contained debugging dump
 * of one dock session, written as a markdown file for offline review.
 *
 * The point is breadth: capture EVERYTHING that could matter when we later sit
 * down and ask "what went right/wrong here" — traces, timings, token/cost, the
 * perception snapshot window (STT/vision confidences + raw payloads), the
 * effective config + system prompt, and the exact build/version provenance so
 * the dump is reproducible against a known state.
 */

/** What triggered a feedback capture. */
export type FeedbackSource = 'app-button' | 'brain-tool' | 'api';

/** A capture request — the minimal input; the bundler enriches the rest. */
export interface FeedbackRequest {
  dock: string;
  /** the session to dump; omitted → the dock's currently-open session. */
  sessionId?: string;
  source: FeedbackSource;
  /** free-text reason / category from the user or the model. */
  reason?: string;
  /** longer explanation. */
  detail?: string;
  /** the turn the feedback is about (when known) — highlighted in the dump. */
  turnId?: string;
  /** verbatim device-side context (TurnLog + event log + app version), shipped
   *  up by the phone on the app-button path. Embedded as-is. */
  clientContext?: unknown;
}

/** Build/version provenance — so a feedback reproduces against a known state. */
export interface Provenance {
  station: { gitSha?: string; gitBranch?: string; dirty?: boolean; version?: string; node: string };
  /** app version/SHA come from the phone's clientContext when present. */
  app?: { versionName?: string; versionCode?: number | string; gitSha?: string };
  firmware?: { build?: number | string };
  models: { brain?: string; thinking?: string; perception: Array<{ name: string; endpoint: string }> };
}

/** A feedback list item (frontmatter projection for the console list). */
export interface FeedbackMeta {
  id: string;
  dock: string;
  sessionId?: string;
  turnId?: string;
  createdAt: string; // ISO-8601
  source: FeedbackSource;
  reason?: string;
}

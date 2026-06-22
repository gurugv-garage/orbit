/**
 * The bundler — a THIN layer over the enriched observability session.
 *
 * Observability is the source of truth: every session is instrumented with a
 * SessionEnrichment snapshot (provenance, config, models, profile, perception
 * window with STT/vision confidences, gate/addressed rings, grounding) on each
 * turn end. The feedback flow READS that enriched session and adds only what's
 * feedback-specific: the user's words, a FRESH static snapshot at flag time
 * (git version etc. — in case the session enrichment is stale or absent), and
 * the verbatim client context. Then it renders one markdown document.
 *
 * If a session has no stored enrichment yet (flagged mid-first-turn, before the
 * first turn-end enrich), the bundler composes it live via `sessionContext`.
 */

import { randomUUID } from 'node:crypto';
import { composeEnrichment, sessionSpan, type ContextSources } from '../observability/context.js';
import { healthSummary, type HealthSummary } from '../observability/health.js';
import type { SessionEnrichment, SessionRecord } from '../observability/types.js';
import type { FeedbackMeta, FeedbackRequest, Provenance } from './types.js';

/** Accessors the bundler reads. All optional/defensive — a missing source just
 *  omits its section rather than failing the capture. */
export interface FeedbackWiring {
  /** the enriched observability Session/Turn/Step tree for a session id. */
  getTrace?: (sessionId: string) => SessionRecord | undefined;
  /** UX-health summary over the session's turns. */
  health?: (turns: SessionRecord['turns']) => HealthSummary;
  /** the dock's currently-open session id (when the request omits one). */
  openSessionId?: (dock: string) => string | undefined;
  /** brain session meta (index entry) + transcript (AgentMessage[]). */
  getSession?: (dock: string, sessionId: string) => { meta?: unknown; transcript?: unknown };
  /** the shared source-of-truth context composer sources (for the live
   *  fallback when a session has no stored enrichment yet). */
  sessionContext?: ContextSources;
  /** a FRESH static provenance snapshot at flag time. */
  provenance?: (dock: string) => Provenance;
  /** recent memory rows for a dock (not part of the per-turn enrichment). */
  memory?: (dock: string, limit?: number) => unknown[];
  /** env-tunable constants worth recording for reference. */
  constants?: () => Record<string, unknown>;
}

/** The fully-gathered context the renderer turns into markdown. */
interface RenderModel {
  meta: FeedbackMeta;
  detail?: string;
  /** fresh static snapshot at flag time. */
  provenance: Provenance;
  trace?: SessionRecord;
  health?: HealthSummary;
  session?: { meta?: unknown; transcript?: unknown };
  /** the per-session enrichment (stored on the trace, or composed live). */
  enrichment?: Partial<SessionEnrichment>;
  /** whether the enrichment was the stored snapshot or composed live now. */
  enrichmentSource: 'stored' | 'live' | 'none';
  memory?: unknown[];
  clientContext?: unknown;
  constants?: Record<string, unknown>;
}

/** Gather + render in one shot — returns the id, filename key, meta, and MD. */
export async function buildFeedback(req: FeedbackRequest, w: FeedbackWiring): Promise<{ id: string; key: string; markdown: string; meta: FeedbackMeta }> {
  const createdAt = new Date().toISOString();
  const sessionId = req.sessionId ?? (req.dock ? w.openSessionId?.(req.dock) : undefined);
  const id = `fb-${randomUUID().slice(0, 8)}`;
  const key = `${createdAt.replace(/[:.]/g, '-')}-${req.dock}-${sessionId ?? 'nosession'}-${id}`;

  const meta: FeedbackMeta = {
    id, dock: req.dock, sessionId, turnId: req.turnId,
    createdAt, source: req.source, reason: req.reason,
  };

  const trace = sessionId ? w.getTrace?.(sessionId) : undefined;

  // enrichment: prefer the stored snapshot on the session; else compose live.
  let enrichment: Partial<SessionEnrichment> | undefined = trace?.enrichment;
  let enrichmentSource: RenderModel['enrichmentSource'] = enrichment ? 'stored' : 'none';
  if (!enrichment && w.sessionContext) {
    try {
      enrichment = await composeEnrichment(req.dock, w.sessionContext, sessionSpan(trace));
      enrichmentSource = 'live';
    } catch { /* leave 'none' */ }
  }

  const model: RenderModel = {
    meta,
    detail: req.detail,
    provenance: w.provenance?.(req.dock) ?? { station: { node: process.version }, models: { perception: [] } },
    trace,
    health: trace && w.health ? w.health(trace.turns) : undefined,
    session: sessionId ? w.getSession?.(req.dock, sessionId) : undefined,
    enrichment,
    enrichmentSource,
    memory: w.memory?.(req.dock, 50),
    clientContext: req.clientContext,
    constants: w.constants?.(),
  };

  return { id, key, meta, markdown: render(model) };
}

/** Re-export so tests / callers can build a health summary the same way. */
export { healthSummary };

// ── rendering ───────────────────────────────────────────────────────────────

function render(b: RenderModel): string {
  const out: string[] = [];
  out.push(frontmatter(b));
  out.push('');
  out.push('## Feedback');
  out.push(b.meta.reason ? `**${b.meta.reason}**` : '_(no reason given)_');
  if (b.detail) out.push('', b.detail);
  out.push('', `- source: \`${b.meta.source}\``);
  out.push(`- dock: \`${b.meta.dock}\``);
  if (b.meta.sessionId) out.push(`- session: \`${b.meta.sessionId}\``);
  if (b.meta.turnId) out.push(`- turn: \`${b.meta.turnId}\``);
  out.push(`- captured: ${b.meta.createdAt}`);

  out.push('', '## Build / versions (snapshot at flag time)');
  out.push(...versionLines(b.provenance));

  if (b.trace) {
    out.push('', '## Session trace (timings · tokens · cost)');
    out.push(traceSummary(b.trace));
    out.push('', '### Turn-by-turn');
    out.push(...b.trace.turns.map(turnBlock));
  } else {
    out.push('', '## Session trace', '_no observability trace for this session._');
  }

  if (b.health) {
    out.push('', '## Health metrics');
    out.push(codeJson(b.health));
  }

  if (b.session?.meta || b.session?.transcript) {
    out.push('', '## Brain session');
    if (b.session.meta) out.push('### Meta', codeJson(b.session.meta));
    if (b.session.transcript) out.push('### Transcript', codeJson(b.session.transcript));
  }

  const e = b.enrichment;
  if (e) {
    out.push('', `## Session context (${b.enrichmentSource === 'stored' ? 'instrumented per session' : 'composed live at capture'})`);
    if (e.config) out.push('### Effective config', codeJson(e.config));
    if (e.models) out.push('### Models', codeJson(e.models));
    if (e.grounding) out.push('### World-state / grounding', '```', String(e.grounding), '```');
    if (Array.isArray(e.perception) && e.perception.length) out.push(`### Perception snapshot window (${e.perception.length} records — STT/vision confidences + raw payloads)`, codeJson(e.perception));
    if (Array.isArray(e.gateDecisions) && e.gateDecisions.length) out.push('### Attention-gate decisions', codeJson(e.gateDecisions));
    if (Array.isArray(e.addressed) && e.addressed.length) out.push('### Addressed-decisions', codeJson(e.addressed));
    if (e.profile) out.push('### Dock brain profile (config · composition · system prompt)', codeJson(e.profile));
  }

  if (b.memory?.length) {
    out.push('', '## Memory (recent)', codeJson(b.memory));
  }

  if (b.constants) {
    out.push('', '## Constants / tunables (reference)', codeJson(b.constants));
  }

  if (b.clientContext != null) {
    out.push('', '## Client context (device — TurnLog · event log · app version)', codeJson(b.clientContext));
  }

  return out.join('\n') + '\n';
}

function frontmatter(b: RenderModel): string {
  const m = b.meta;
  const p = b.provenance;
  const lines = [
    '---',
    `id: ${m.id}`,
    `dock: ${m.dock}`,
    m.sessionId ? `sessionId: ${m.sessionId}` : undefined,
    m.turnId ? `turnId: ${m.turnId}` : undefined,
    `createdAt: ${m.createdAt}`,
    `source: ${m.source}`,
    m.reason ? `reason: ${yamlInline(m.reason)}` : undefined,
    `station: ${yamlInline(JSON.stringify(p.station))}`,
    p.app ? `app: ${yamlInline(JSON.stringify(p.app))}` : undefined,
    p.firmware?.build != null ? `firmware: ${yamlInline(JSON.stringify(p.firmware))}` : undefined,
    `models: ${yamlInline(JSON.stringify(p.models))}`,
    '---',
  ].filter(Boolean);
  return lines.join('\n');
}

function versionLines(p: Provenance): string[] {
  const s = p.station;
  const out = [
    `- **station**: ${s.gitBranch ?? '?'} @ \`${(s.gitSha ?? '?').slice(0, 12)}\`${s.dirty ? ' (dirty)' : ''} · v${s.version ?? '?'} · node ${s.node}`,
  ];
  if (p.app) out.push(`- **app**: ${p.app.versionName ?? '?'} (${p.app.versionCode ?? '?'})${p.app.gitSha ? ` @ \`${String(p.app.gitSha).slice(0, 12)}\`` : ''}`);
  if (p.firmware?.build != null) out.push(`- **firmware**: build ${p.firmware.build}`);
  out.push(`- **brain model**: ${p.models.brain ?? '?'}${p.models.thinking ? ` · thinking ${p.models.thinking}` : ''}`);
  if (p.models.perception.length) out.push(`- **perception models**: ${p.models.perception.map((m) => `${m.name}`).join(', ')}`);
  return out;
}

function traceSummary(t: SessionRecord): string {
  const turns = t.turns.length;
  const steps = t.turns.reduce((n, tn) => n + tn.steps.length, 0);
  const cost = t.turns.reduce((c, tn) => c + tn.steps.reduce((s, st) => s + (st.usage?.cost ?? 0), 0), 0);
  const inTok = t.turns.reduce((c, tn) => c + tn.steps.reduce((s, st) => s + (st.usage?.inputTokens ?? 0), 0), 0);
  const outTok = t.turns.reduce((c, tn) => c + tn.steps.reduce((s, st) => s + (st.usage?.outputTokens ?? 0), 0), 0);
  return [
    `- turns: ${turns} · steps: ${steps}`,
    `- tokens: ${inTok} in / ${outTok} out`,
    `- cost: $${cost.toFixed(4)}`,
    `- span: ${new Date(t.firstSeen).toISOString()} → ${new Date(t.lastSeen).toISOString()}`,
  ].join('\n');
}

function turnBlock(t: SessionRecord['turns'][number], i: number): string {
  const dur = t.endedAt ? `${t.endedAt - t.startedAt}ms` : 'unfinished';
  const settle = t.settledAt ? ` · settle ${t.settledAt - t.startedAt}ms` : '';
  const lines = [
    `\n#### Turn ${i + 1} — ${t.trigger?.kind ?? '?'}${t.trigger?.text ? `: ${truncate(t.trigger.text, 120)}` : ''}`,
    `- ${dur}${settle} · ${t.steps.length} step(s) · ${t.llmCalls} llm call(s)`,
  ];
  for (const s of t.steps) {
    const timings = [
      s.ms != null ? `${s.ms}ms` : undefined,
      s.ttftMs != null ? `ttft ${s.ttftMs}ms` : undefined,
      s.thinkingMs != null ? `think ${s.thinkingMs}ms` : undefined,
      s.ttftTextMs != null ? `ttftText ${s.ttftTextMs}ms` : undefined,
    ].filter(Boolean).join(' · ');
    const usage = s.usage ? ` · ${s.usage.inputTokens ?? 0}/${s.usage.outputTokens ?? 0} tok${s.usage.cost != null ? ` · $${s.usage.cost.toFixed(4)}` : ''}` : '';
    lines.push(`  - step ${s.index} [${s.model ?? '?'}] ${timings}${usage}${s.stopReason ? ` · stop=${s.stopReason}` : ''}${s.error ? ` · ERROR: ${s.error}` : ''}`);
    for (const tc of s.tools) {
      const td = tc.endedAt ? `${tc.endedAt - tc.startedAt}ms` : '…';
      lines.push(`    - 🔧 ${tc.toolName} (${td})${tc.isError ? ' ⚠️' : ''} args=${truncate(JSON.stringify(tc.args ?? {}), 200)}`);
      if (tc.result) lines.push(`         → ${truncate(tc.result, 200)}`);
    }
  }
  if (t.speech?.length) lines.push(`  - 🔊 speech windows: ${t.speech.map((s) => `${s.startedAt - t.startedAt}–${s.endedAt != null ? s.endedAt - t.startedAt : '…'}ms`).join(', ')}`);
  return lines.join('\n');
}

function codeJson(v: unknown): string {
  return '```json\n' + JSON.stringify(v, null, 2) + '\n```';
}

function yamlInline(s: string): string {
  return JSON.stringify(s);
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + '…' : s;
}

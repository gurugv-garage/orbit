/**
 * Incident-bundle markdown renderer — the human/LLM-readable form of
 * GET /api/observability/incident. One chronological timeline interleaving
 * conv events (phone/perception/brain/conv lanes), brain turns (with steps +
 * tools), and perception snapshots — so "what happened between t1 and t2" is
 * ONE document you can read top to bottom or paste to an LLM to debug.
 */

import type { StoredConvEvent } from './conv-events.js';
import type { TurnRecord } from './types.js';

interface IncidentBundle {
  dock: string;
  from: number;
  to: number;
  generatedAt: number;
  events: StoredConvEvent[];
  turns: Array<TurnRecord & { source: string }>;
  snapshots: unknown[];
}

/** HH:MM:SS.mmm in IST (the project's log timezone). */
function t(ms: number): string {
  return new Date(ms + 5.5 * 3600_000).toISOString().slice(11, 23);
}

function eventLine(e: StoredConvEvent): string {
  const bits = [`**${t(e.ts)}** \`${e.lane}\` ${e.type}`];
  if (e.verdict) bits.push(`→ **${e.verdict}**`);
  if (e.text) bits.push(`"${e.text}"`);
  if (e.audioStartAt && e.audioEndAt) {
    bits.push(`(audio ${t(e.audioStartAt)}–${t(e.audioEndAt)}${e.sttFinalAt ? `, stt +${e.sttFinalAt - e.audioEndAt}ms` : ''})`);
  }
  if (e.deviceTs) bits.push(`(device clock ${t(e.deviceTs)}, skew ${e.ts - e.deviceTs}ms)`);
  if (e.utteranceId) bits.push(`[u:${e.utteranceId}]`);
  if (e.turnId) bits.push(`[turn:${e.turnId}]`);
  if (e.detail && Object.keys(e.detail).length) bits.push(`\`${JSON.stringify(e.detail)}\``);
  return `- ${bits.join(' ')}`;
}

function turnBlock(turn: TurnRecord & { source: string }): string {
  const lines: string[] = [];
  const state = turn.state ?? 'open';
  lines.push(`### ${t(turn.startedAt)} TURN ${turn.turnId} (${turn.source}) — ${state}`);
  if (turn.trigger) {
    const w = turn.trigger.window;
    lines.push(`- trigger: kind=${turn.trigger.kind}${turn.trigger.via ? ` via=${turn.trigger.via}` : ''}`
      + `${w ? ` admit=${w.rule} window=${w.windowSrc}/${w.openedBy} msToExpiry=${w.msToExpiry}` : ''}`);
    if (turn.trigger.text) lines.push(`- trigger text: "${turn.trigger.text}"`);
  }
  for (const s of turn.steps) {
    const usage = s.usage ? ` ${s.usage.inputTokens ?? '?'}in/${s.usage.outputTokens ?? '?'}out` : '';
    lines.push(`- step ${s.index}: ${s.model ?? '?'} ${s.ms ?? '?'}ms (ttft ${s.ttftMs ?? '?'}ms)${usage}`
      + `${s.stopReason ? ` stop=${s.stopReason}` : ''}${s.error ? ` ERROR=${s.error}` : ''}`);
    if (s.text) lines.push(`  - said: ${s.text.replace(/\n/g, ' ').slice(0, 500)}`);
    for (const tc of s.tools) {
      lines.push(`  - tool ${tc.toolName}(${JSON.stringify(tc.args ?? {}).slice(0, 200)})`
        + `${tc.isError ? ' ERROR' : ''}${tc.result ? ` → ${String(tc.result).replace(/\n/g, ' ').slice(0, 200)}` : ''}`);
    }
  }
  if (turn.speech?.length) {
    lines.push(`- tts windows: ${turn.speech.map((w) => `${t(w.startedAt)}–${w.endedAt ? t(w.endedAt) : '…'}`).join(', ')}`);
  }
  if (turn.endedAt) lines.push(`- ended ${t(turn.endedAt)}${turn.settledAt ? `, settled ${t(turn.settledAt)}` : ''}`);
  return lines.join('\n');
}

export function renderIncidentMarkdown(b: IncidentBundle): string {
  const out: string[] = [];
  out.push(`# Incident bundle — dock ${b.dock}`);
  out.push(`Window ${new Date(b.from).toISOString()} → ${new Date(b.to).toISOString()} (times below are IST HH:MM:SS.mmm).`);
  out.push('');
  out.push('Sources: `conv_events` (every gate verdict/state transition across phone, perception,');
  out.push('brain, and the conversation state machine), obs turns (full Session/Turn/Step detail),');
  out.push('and perception snapshots. `audio …–…` = when the SOUND happened; `stt +Nms` = how much');
  out.push('later the transcript landed — decisions between those two saw no text yet.');
  out.push('');

  // one merged chronology: events + turn blocks, ordered by time.
  type Item = { ts: number; md: string; kind: 'event' | 'turn' };
  const items: Item[] = [
    ...b.events.map((e) => ({ ts: e.ts, md: eventLine(e), kind: 'event' as const })),
    ...b.turns.map((turn) => ({ ts: turn.startedAt, md: turnBlock(turn), kind: 'turn' as const })),
  ].sort((a, z) => a.ts - z.ts);

  out.push(`## Timeline (${b.events.length} events, ${b.turns.length} turns)`);
  out.push('');
  for (const it of items) {
    out.push(it.md);
    if (it.kind === 'turn') out.push('');
  }
  out.push('');

  if (b.snapshots.length) {
    out.push(`## Perception snapshots (${b.snapshots.length})`);
    for (const s of b.snapshots as Array<{ interval?: { from?: string; to?: string }; source?: { kind?: string }; payload?: Record<string, unknown> }>) {
      const p = s.payload ?? {};
      const bits = [s.interval?.from ?? '?', `\`${s.source?.kind ?? '?'}\``];
      if (typeof p.text === 'string' && p.text) bits.push(`"${String(p.text).slice(0, 300)}"`);
      if (p.confTier) bits.push(`tier=${String(p.confTier)}`);
      if (p.dropped) bits.push(`DROPPED=${String(p.dropped)}`);
      if (p.addressedP != null) bits.push(`addressedP=${String(p.addressedP)}`);
      out.push(`- ${bits.join(' ')}`);
    }
  }
  return out.join('\n');
}

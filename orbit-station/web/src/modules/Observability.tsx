import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useStationEvents } from '../lib/useStation';
import { api } from '../lib/station';
import type { AgentEventDto } from '../lib/protocol';

// ── view models (mirror the server store) ────────────────────────────────────
interface ToolVM { id: string; name: string; args?: unknown; result?: string; isError?: boolean; startedAt?: number; endedAt?: number }
interface StepVM { idx: number; model?: string; stopReason?: string; text?: string; tools: ToolVM[]; inTok?: number; outTok?: number; startedAt?: number; endedAt?: number }
interface TurnVM { id: string; sessionId: string; source?: string; startedAt: number; endedAt?: number; ended: boolean; steps: StepVM[] }

// server-stored shapes (observability/types.ts) for backfill
interface StoredTool { toolCallId: string; toolName: string; args?: unknown; result?: string; isError?: boolean; startedAt?: number; endedAt?: number }
interface StoredStep { index: number; model?: string; stopReason?: string; text?: string; tools: StoredTool[]; usage?: { inputTokens?: number; outputTokens?: number }; startedAt?: number; endedAt?: number }
interface StoredTurn { turnId: string; sessionId: string; startedAt: number; endedAt?: number; steps: StoredStep[] }
interface StoredSession { sessionId: string; source?: string; turns: StoredTurn[] }
interface SessionSummary { sessionId: string; source?: string }

export function Observability() {
  const [turns, setTurns] = useState<TurnVM[]>([]);
  const turnIndex = useRef(new Map<string, number>());
  const [selected, setSelected] = useState<string | null>(null);

  // filters
  const [fSource, setFSource] = useState('');     // dock/source
  const [fTool, setFTool] = useState('');         // tool name
  const [fErrors, setFErrors] = useState(false);  // errors only
  const [fSearch, setFSearch] = useState('');     // text in speech/args/result
  const [fSlow, setFSlow] = useState(false);      // sort by duration desc

  // backfill stored turns on mount
  useEffect(() => {
    let cancelled = false;
    api.get<SessionSummary[]>('/observability/sessions').then(async (list) => {
      if (!list?.length) return;
      const detailed = await Promise.all(
        list.slice(0, 8).map((s) => api.get<StoredSession>(`/observability/sessions/${encodeURIComponent(s.sessionId)}`).catch(() => null)),
      );
      if (cancelled) return;
      const vms: TurnVM[] = [];
      for (const sess of detailed) if (sess?.turns) for (const t of sess.turns) vms.push(storedToVM(t, sess.source));
      vms.sort((a, b) => a.startedAt - b.startedAt);
      setTurns((live) => {
        const have = new Set(live.map((t) => t.id));
        const merged = [...vms.filter((t) => !have.has(t.id)), ...live].slice(-200);
        turnIndex.current.clear();
        merged.forEach((t, i) => turnIndex.current.set(t.id, i));
        return merged;
      });
    }).catch(() => {});
    return () => { cancelled = true; };
  }, []);

  const onEvent = useCallback((frame: { payload: unknown }) => {
    const ev = frame.payload as AgentEventDto;
    setTurns((prev) => {
      const next = prev.slice();
      let i = turnIndex.current.get(ev.turnId);
      if (i == null) {
        i = next.length;
        turnIndex.current.set(ev.turnId, i);
        next.push({ id: ev.turnId, sessionId: ev.sessionId, startedAt: ev.ts, ended: false, steps: [] });
      }
      const turn = { ...next[i]!, steps: next[i]!.steps.slice() };
      applyEvent(turn, ev);
      next[i] = turn;
      return next.slice(-200);
    });
  }, []);
  useStationEvents('obs', onEvent);

  const sources = useMemo(() => [...new Set(turns.map((t) => t.source).filter(Boolean))] as string[], [turns]);
  const tools = useMemo(() => [...new Set(turns.flatMap((t) => t.steps.flatMap((s) => s.tools.map((x) => x.name))))], [turns]);

  const filtered = useMemo(() => {
    let r = turns.filter((t) => {
      if (fSource && t.source !== fSource) return false;
      if (fTool && !t.steps.some((s) => s.tools.some((x) => x.name === fTool))) return false;
      if (fErrors && !t.steps.some((s) => s.tools.some((x) => x.isError))) return false;
      if (fSearch) {
        const hay = JSON.stringify(t).toLowerCase();
        if (!hay.includes(fSearch.toLowerCase())) return false;
      }
      return true;
    });
    r = r.slice().sort((a, b) => (fSlow ? dur(b) - dur(a) : b.startedAt - a.startedAt));
    return r;
  }, [turns, fSource, fTool, fErrors, fSearch, fSlow]);

  const sel = filtered.find((t) => t.id === selected) ?? filtered[0];

  return (
    <section className="obs">
      <h2 className="title">Observability</h2>
      <p className="subtitle">agent-core Session ⊃ Turn ⊃ Step ⊃ LLM-call · {turns.length} turns</p>

      <div className="obs-filters">
        <select value={fSource} onChange={(e) => setFSource(e.target.value)}>
          <option value="">all docks</option>
          {sources.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
        <select value={fTool} onChange={(e) => setFTool(e.target.value)}>
          <option value="">all tools</option>
          {tools.map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
        <label className="obs-chk"><input type="checkbox" checked={fErrors} onChange={(e) => setFErrors(e.target.checked)} /> errors</label>
        <label className="obs-chk"><input type="checkbox" checked={fSlow} onChange={(e) => setFSlow(e.target.checked)} /> slowest</label>
        <input className="obs-search" placeholder="search text / args / result…" value={fSearch} onChange={(e) => setFSearch(e.target.value)} />
        <span className="muted obs-count">{filtered.length}</span>
      </div>

      <div className="obs-split">
        <div className="obs-list">
          {filtered.length === 0 ? <div className="empty">No turns. Run the dock app (publishes on <code>obs</code>) or <code>npm run smoke</code>.</div> :
            filtered.map((t) => (
              <button key={t.id} className={`obs-row${sel?.id === t.id ? ' sel' : ''}`} onClick={() => setSelected(t.id)}>
                <span className="obs-row-time">{clock(t.startedAt)}</span>
                <span className="obs-row-id mono">{t.id.replace('turn-', '')}</span>
                <span className="obs-row-src">{t.source ?? t.sessionId.replace('sess-', '')}</span>
                <span className={`obs-row-dur${dur(t) > 4000 ? ' slow' : ''}`}>{fmtMs(dur(t))}</span>
                <span className="obs-row-meta">{t.steps.length}s</span>
                {t.steps.some((s) => s.tools.some((x) => x.isError)) && <span className="dot off" title="error" />}
                {!t.ended && <span className="dot wait" title="running" />}
              </button>
            ))}
        </div>
        <div className="obs-detail">
          {sel ? <TurnTimeline turn={sel} /> : <div className="empty">Select a turn.</div>}
        </div>
      </div>
    </section>
  );
}

// ── turn timeline (right panel) ──────────────────────────────────────────────
function TurnTimeline({ turn }: { turn: TurnVM }) {
  const t0 = turn.startedAt;
  const total = Math.max(dur(turn), 1);
  return (
    <div>
      <div className="obs-th">
        <b className="mono">{turn.id}</b>
        <span className="muted">· {turn.source ?? turn.sessionId}</span>
        <span className={`pill ${turn.ended ? 'good' : 'warn'}`}>{turn.ended ? 'done' : 'running'}</span>
        <span className="muted">· {turn.steps.length} steps · {fmtMs(dur(turn))}</span>
        <span className="muted">· {new Date(turn.startedAt).toLocaleString()}</span>
      </div>
      {turn.steps.map((s) => {
        const sStart = (s.startedAt ?? t0) - t0;
        const sDur = (s.endedAt ?? t0 + total) - (s.startedAt ?? t0);
        return (
          <div key={s.idx} className="obs-step">
            <div className="obs-step-head">
              <span className="obs-step-n">step {s.idx}</span>
              {s.model && <span className="pill acc sm">{s.model.split('/').pop()}</span>}
              {s.stopReason && <span className="muted mono sm">{s.stopReason}</span>}
              {(s.inTok || s.outTok) != null && <span className="muted sm">{s.inTok ?? '?'}→{s.outTok ?? '?'} tok</span>}
              <span className="muted sm">{fmtMs(sDur)}</span>
            </div>
            <Bar start={sStart} len={sDur} total={total} kind="step" />
            {s.text && <div className="obs-text">“{s.text}”</div>}
            {s.tools.map((tc) => {
              const tcStart = (tc.startedAt ?? t0) - t0;
              const tcDur = (tc.endedAt ?? tc.startedAt ?? t0) - (tc.startedAt ?? t0);
              return (
                <details key={tc.id} className="obs-tool">
                  <summary>
                    <span className={`obs-tool-name ${tc.isError ? 'err' : ''}`}>⚙ {tc.name}</span>
                    <span className="muted sm">{fmtMs(tcDur)}</span>
                    {tc.isError && <span className="pill bad sm">error</span>}
                    <span className="obs-tool-bar"><Bar start={tcStart} len={tcDur} total={total} kind="tool" /></span>
                  </summary>
                  <div className="obs-kv"><span>args</span><pre>{pretty(tc.args)}</pre></div>
                  {tc.result != null && <div className="obs-kv"><span>response</span><pre>{tc.result}</pre></div>}
                </details>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}

function Bar({ start, len, total, kind }: { start: number; len: number; total: number; kind: 'step' | 'tool' }) {
  const left = Math.max(0, (start / total) * 100);
  const width = Math.max(0.8, (len / total) * 100);
  return (
    <div className="obs-track">
      <div className={`obs-bar ${kind}`} style={{ left: `${left}%`, width: `${Math.min(width, 100 - left)}%` }} />
    </div>
  );
}

// ── helpers ──────────────────────────────────────────────────────────────────
function dur(t: TurnVM): number { return (t.endedAt ?? t.steps.at(-1)?.endedAt ?? t.startedAt) - t.startedAt; }
function fmtMs(ms: number): string { return ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${ms}ms`; }
function clock(ts: number): string { return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }); }
function pretty(v: unknown): string { try { return typeof v === 'string' ? v : JSON.stringify(v, null, 1); } catch { return String(v); } }

function storedToVM(t: StoredTurn, source?: string): TurnVM {
  return {
    id: t.turnId, sessionId: t.sessionId, source, startedAt: t.startedAt, endedAt: t.endedAt, ended: t.endedAt != null,
    steps: t.steps.map((s) => ({
      idx: s.index, model: s.model, stopReason: s.stopReason, text: s.text,
      inTok: s.usage?.inputTokens, outTok: s.usage?.outputTokens, startedAt: s.startedAt, endedAt: s.endedAt,
      tools: s.tools.map((tc) => ({ id: tc.toolCallId, name: tc.toolName, args: tc.args, result: tc.result, isError: tc.isError, startedAt: tc.startedAt, endedAt: tc.endedAt })),
    })),
  };
}

function applyEvent(turn: TurnVM, ev: AgentEventDto): void {
  const last = turn.steps[turn.steps.length - 1];
  switch (ev.kind) {
    case 'TurnEnd': turn.ended = true; turn.endedAt = ev.ts; break;
    case 'StepStart': turn.steps.push({ idx: turn.steps.length, tools: [], startedAt: ev.ts }); break;
    case 'StepEnd':
      if (last) {
        last.endedAt = ev.ts; last.model = ev.data?.model; last.stopReason = ev.data?.stopReason;
        last.inTok = ev.data?.usage?.inputTokens; last.outTok = ev.data?.usage?.outputTokens;
      }
      break;
    case 'MessageEnd': if (last && ev.data?.text != null) last.text = ev.data.text; break;
    case 'ToolExecutionStart':
      if (last && ev.data?.toolCallId) last.tools.push({ id: ev.data.toolCallId, name: ev.data.toolName ?? '?', args: ev.data.args, startedAt: ev.ts });
      break;
    case 'ToolExecutionEnd': {
      const tc = last?.tools.find((t) => t.id === ev.data?.toolCallId);
      if (tc) { tc.endedAt = ev.ts; tc.isError = ev.data?.isError; tc.result = ev.data?.result as string | undefined; }
      break;
    }
  }
}

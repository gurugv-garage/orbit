import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useStationEvents } from '../lib/useStation';
import { api } from '../lib/station';
import type { AgentEventDto } from '../lib/protocol';

// ── view models (mirror the server store) ────────────────────────────────────
interface ToolVM { id: string; name: string; args?: unknown; result?: string; isError?: boolean; startedAt?: number; endedAt?: number }
interface StepVM { idx: number; model?: string; stopReason?: string; text?: string; tools: ToolVM[]; inTok?: number; outTok?: number; startedAt?: number; endedAt?: number }
interface TurnVM { id: string; sessionId: string; source?: string; prompt?: string; startedAt: number; endedAt?: number; ended: boolean; steps: StepVM[] }

interface StoredTool { toolCallId: string; toolName: string; args?: unknown; result?: string; isError?: boolean; startedAt?: number; endedAt?: number }
interface StoredStep { index: number; model?: string; stopReason?: string; text?: string; tools: StoredTool[]; usage?: { inputTokens?: number; outputTokens?: number }; startedAt?: number; endedAt?: number }
interface StoredTurn { turnId: string; sessionId: string; prompt?: string; startedAt: number; endedAt?: number; steps: StoredStep[] }
interface StoredSession { sessionId: string; source?: string; turns: StoredTurn[] }
interface SessionSummary { sessionId: string; source?: string }

const IST = 'Asia/Kolkata';

export function Observability() {
  const [turns, setTurns] = useState<TurnVM[]>([]);
  const turnIndex = useRef(new Map<string, number>());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());     // expanded turn ids
  const [collapsedSessions, setCollapsedSessions] = useState<Set<string>>(new Set());

  // filters
  const [fSession, setFSession] = useState('');
  const [fSource, setFSource] = useState('');
  const [fTool, setFTool] = useState('');
  const [fErrors, setFErrors] = useState(false);
  const [fSlow, setFSlow] = useState(false);
  const [fSearch, setFSearch] = useState('');

  useEffect(() => {
    let cancelled = false;
    api.get<SessionSummary[]>('/observability/sessions').then(async (list) => {
      if (!list?.length) return;
      const detailed = await Promise.all(
        list.slice(0, 12).map((s) => api.get<StoredSession>(`/observability/sessions/${encodeURIComponent(s.sessionId)}`).catch(() => null)),
      );
      if (cancelled) return;
      const vms: TurnVM[] = [];
      for (const sess of detailed) if (sess?.turns) for (const t of sess.turns) vms.push(storedToVM(t, sess.source));
      vms.sort((a, b) => a.startedAt - b.startedAt);
      setTurns((live) => {
        const have = new Set(live.map((t) => t.id));
        const merged = [...vms.filter((t) => !have.has(t.id)), ...live].slice(-300);
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
      return next.slice(-300);
    });
  }, []);
  useStationEvents('obs', onEvent);

  const sessions = useMemo(() => [...new Set(turns.map((t) => t.sessionId))], [turns]);
  const sources = useMemo(() => [...new Set(turns.map((t) => t.source).filter(Boolean))] as string[], [turns]);
  const toolNames = useMemo(() => [...new Set(turns.flatMap((t) => t.steps.flatMap((s) => s.tools.map((x) => x.name))))], [turns]);

  const filtered = useMemo(() => turns.filter((t) => {
    if (fSession && t.sessionId !== fSession) return false;
    if (fSource && t.source !== fSource) return false;
    if (fTool && !t.steps.some((s) => s.tools.some((x) => x.name === fTool))) return false;
    if (fErrors && !t.steps.some((s) => s.tools.some((x) => x.isError))) return false;
    if (fSearch && !JSON.stringify(t).toLowerCase().includes(fSearch.toLowerCase())) return false;
    return true;
  }), [turns, fSession, fSource, fTool, fErrors, fSearch]);

  // group filtered turns by session (newest session + newest turn first)
  const groups = useMemo(() => {
    const m = new Map<string, TurnVM[]>();
    for (const t of filtered) (m.get(t.sessionId) ?? m.set(t.sessionId, []).get(t.sessionId)!).push(t);
    const arr = [...m.entries()].map(([sid, ts]) => {
      const sorted = ts.slice().sort((a, b) => (fSlow ? dur(b) - dur(a) : b.startedAt - a.startedAt));
      return { sid, source: ts[0]?.source, turns: sorted, started: Math.min(...ts.map((t) => t.startedAt)), last: Math.max(...ts.map((t) => t.startedAt)) };
    });
    arr.sort((a, b) => b.last - a.last);
    return arr;
  }, [filtered, fSlow]);

  const toggleTurn = (id: string) => setExpanded((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const toggleSession = (sid: string) => setCollapsedSessions((s) => { const n = new Set(s); n.has(sid) ? n.delete(sid) : n.add(sid); return n; });

  return (
    <section className="obs">
      <h2 className="title">Observability</h2>
      <p className="subtitle">agent-core Session ⊃ Turn ⊃ Step ⊃ LLM-call · {sessions.length} sessions · {turns.length} turns · IST</p>

      <div className="obs-filters">
        <select value={fSession} onChange={(e) => setFSession(e.target.value)}>
          <option value="">all sessions</option>
          {sessions.map((s) => <option key={s} value={s}>{s.replace('sess-', '')}</option>)}
        </select>
        <select value={fSource} onChange={(e) => setFSource(e.target.value)}>
          <option value="">all docks</option>
          {sources.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
        <select value={fTool} onChange={(e) => setFTool(e.target.value)}>
          <option value="">all tools</option>
          {toolNames.map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
        <label className="obs-chk"><input type="checkbox" checked={fErrors} onChange={(e) => setFErrors(e.target.checked)} /> errors</label>
        <label className="obs-chk"><input type="checkbox" checked={fSlow} onChange={(e) => setFSlow(e.target.checked)} /> slowest</label>
        <input className="obs-search" placeholder="search text / args / result…" value={fSearch} onChange={(e) => setFSearch(e.target.value)} />
      </div>

      {groups.length === 0 ? <div className="empty">No turns. Run the dock app or <code>npm run smoke</code>.</div> :
        <div className="obs-sessions">
          {groups.map((g) => {
            const collapsed = collapsedSessions.has(g.sid);
            return (
              <div key={g.sid} className="obs-session">
                <button className="obs-session-head" onClick={() => toggleSession(g.sid)}>
                  <span className="obs-caret">{collapsed ? '▸' : '▾'}</span>
                  <span className="mono obs-session-id">{g.sid}</span>
                  <span className="pill acc sm">{g.source ?? '—'}</span>
                  <span className="muted sm">{g.turns.length} turns</span>
                  <span className="muted sm">· {clock(g.started)}–{clock(g.last)}</span>
                </button>
                {!collapsed && g.turns.map((t) => (
                  <TurnRow key={t.id} turn={t} open={expanded.has(t.id)} onToggle={() => toggleTurn(t.id)} />
                ))}
              </div>
            );
          })}
        </div>}
    </section>
  );
}

// ── one turn: header row + in-place expandable detail ────────────────────────
function TurnRow({ turn, open, onToggle }: { turn: TurnVM; open: boolean; onToggle: () => void }) {
  const err = turn.steps.some((s) => s.tools.some((x) => x.isError));
  return (
    <div className={`obs-turn${open ? ' open' : ''}`}>
      <button className="obs-turn-head" onClick={onToggle}>
        <span className="obs-caret">{open ? '▾' : '▸'}</span>
        <span className="obs-turn-time mono">{clockMs(turn.startedAt)}</span>
        <span className="obs-turn-id mono">{turn.id.replace('turn-', '')}</span>
        {turn.prompt && <span className="obs-turn-prompt" title={turn.prompt}>“{turn.prompt}”</span>}
        <span className={`obs-turn-dur${dur(turn) > 4000 ? ' slow' : ''}`}>{fmtMs(dur(turn))}</span>
        <span className="muted sm">{turn.steps.length} step{turn.steps.length !== 1 ? 's' : ''}</span>
        {turn.steps.flatMap((s) => s.tools).map((tc) => (
          <span key={tc.id} className={`pill sm ${tc.isError ? 'bad' : 'acc'}`}>{tc.name}</span>
        ))}
        {err && <span className="dot off" title="error" />}
        {!turn.ended && <span className="dot wait" title="running" />}
        <span className="spacer" />
        <span className="muted sm obs-turn-fulltime">{fullTime(turn.startedAt)}</span>
      </button>
      {open && <TurnTimeline turn={turn} />}
    </div>
  );
}

function TurnTimeline({ turn }: { turn: TurnVM }) {
  const t0 = turn.startedAt;
  const total = Math.max(dur(turn), 1);
  return (
    <div className="obs-timeline">
      {/* the user message that triggered this turn */}
      {turn.prompt && (
        <div className="obs-msg user"><span className="obs-msg-who">user</span><span className="obs-msg-text">{turn.prompt}</span></div>
      )}

      {/* Timeline: one labeled lane per step (and nested tool call). Each lane
          shows WHAT it is, its bar, and clock-time + duration inline. */}
      <div className="obs-lanes">
        <div className="obs-lane axis">
          <span className="obs-lane-label" />
          <span className="obs-lane-track"><span className="obs-axis-start">{clockMs(turn.startedAt)}</span><span className="obs-axis-end">+{fmtMs(total)}</span></span>
          <span className="obs-lane-when" />
        </div>
        {turn.steps.map((s) => {
          const a = (s.startedAt ?? t0) - t0;
          const b = (s.endedAt ?? t0 + total) - t0;
          const kind = s.tools.length ? 'tool' : 'speak';
          return (
            <div key={`lane${s.idx}`}>
              <div className="obs-lane">
                <span className={`obs-lane-label ${kind}`}>step {s.idx} · {kind === 'tool' ? 'tool call' : 'reply'}</span>
                <span className="obs-lane-track"><Bar start={a} len={b - a} total={total} cls={`step ${kind}`} title={`step ${s.idx}`} /></span>
                <span className="obs-lane-when mono">@{fmtMs(a)} · {fmtMs(b - a)}</span>
              </div>
              {s.tools.map((tc) => {
                const ta = (tc.startedAt ?? t0) - t0;
                const tw = (tc.endedAt ?? tc.startedAt ?? t0) - (tc.startedAt ?? t0);
                return (
                  <div key={tc.id} className="obs-lane tool">
                    <span className={`obs-lane-label tool${tc.isError ? ' err' : ''}`}>⚙ {tc.name}</span>
                    <span className="obs-lane-track"><Bar start={ta} len={tw} total={total} cls={`tool${tc.isError ? ' err' : ''}`} title={tc.name} /></span>
                    <span className="obs-lane-when mono">@{fmtMs(ta)} · {fmtMs(tw)}</span>
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>

      {/* per-step detail (no individual track now — the bar above is the timeline) */}
      {turn.steps.map((s, si) => {
        const sStart = (s.startedAt ?? t0) - t0;
        const sEnd = (s.endedAt ?? t0 + total) - t0;
        const firstTool = s.tools[0];
        const think = firstTool?.startedAt != null ? firstTool.startedAt - (s.startedAt ?? t0) : sEnd - sStart;
        const kind = s.tools.length ? 'tool' : 'speak';
        return (
          <div key={s.idx} className={`obs-step kind-${kind}`}>
            <div className="obs-step-head">
              <span className={`obs-step-tag ${kind}`}>step {s.idx}</span>
              {s.model && <span className="pill acc sm">{s.model.split('/').pop()}</span>}
              {s.stopReason && <span className="muted mono sm">{s.stopReason}</span>}
              <span className="muted sm">tok {tok(s.inTok)}→{tok(s.outTok)}</span>
              <span className="muted sm">think {fmtMs(Math.max(0, think))}</span>
              <span className="muted sm mono">[{fmtMs(sStart)}–{fmtMs(sEnd)}]</span>
            </div>
            {s.text && <div className="obs-msg bot"><span className="obs-msg-who">bot</span><span className="obs-msg-text">{s.text}</span></div>}
            {s.tools.map((tc) => {
              const a = (tc.startedAt ?? t0) - t0;
              const w = (tc.endedAt ?? tc.startedAt ?? t0) - (tc.startedAt ?? t0);
              return (
                <details key={tc.id} className="obs-tool" open={si === 0}>
                  <summary>
                    <span className={`obs-tool-name ${tc.isError ? 'err' : ''}`}>⚙ {tc.name}</span>
                    <span className="muted sm mono">start {fmtMs(a)} · end {fmtMs(a + w)} · {fmtMs(w)}</span>
                    {tc.isError && <span className="pill bad sm">error</span>}
                  </summary>
                  <div className="obs-kv"><span>params</span><pre>{pretty(tc.args)}</pre></div>
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

function Bar({ start, len, total, cls, title }: { start: number; len: number; total: number; cls: string; title?: string }) {
  const left = Math.max(0, (start / total) * 100);
  const width = Math.max(0.8, (len / total) * 100);
  return <div className={`obs-bar ${cls}`} style={{ left: `${left}%`, width: `${Math.min(width, 100 - left)}%` }} title={title} />;
}

// ── helpers ──────────────────────────────────────────────────────────────────
function dur(t: TurnVM): number { return (t.endedAt ?? t.steps.at(-1)?.endedAt ?? t.startedAt) - t.startedAt; }
function fmtMs(ms: number): string { return ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${Math.round(ms)}ms`; }
function tok(n?: number): string { return n != null && n > 0 ? String(n) : 'n/a'; }
function clock(ts: number): string { return new Date(ts).toLocaleTimeString('en-GB', { timeZone: IST, hour: '2-digit', minute: '2-digit', second: '2-digit' }); }
function clockMs(ts: number): string { return `${clock(ts)}.${String(ts % 1000).padStart(3, '0')}`; }
function fullTime(ts: number): string { return new Date(ts).toLocaleString('en-GB', { timeZone: IST, hour12: false }) + ' IST'; }
function pretty(v: unknown): string { try { return typeof v === 'string' ? v : JSON.stringify(v, null, 1); } catch { return String(v); } }

function storedToVM(t: StoredTurn, source?: string): TurnVM {
  return {
    id: t.turnId, sessionId: t.sessionId, source, prompt: t.prompt, startedAt: t.startedAt, endedAt: t.endedAt, ended: t.endedAt != null,
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
    case 'TurnStart': if (ev.data?.prompt != null) turn.prompt = ev.data.prompt as string; break;
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

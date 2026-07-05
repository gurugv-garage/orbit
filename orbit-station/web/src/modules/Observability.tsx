import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { MouseEvent as ReactMouseEvent, ReactNode } from 'react';
import { useStationEvents } from '../lib/useStation';
import { api } from '../lib/station';
import type { AgentEventDto } from '../lib/protocol';

// feedback overlay (GET /api/feedback/) — just the fields the trace badges need.
interface FeedbackMeta { id: string; sessionId?: string; turnId?: string; source: string; reason?: string }

// ── view models (mirror the server store) ────────────────────────────────────
interface ToolVM { id: string; name: string; args?: unknown; result?: string; isError?: boolean; startedAt?: number; endedAt?: number }
interface StepVM { idx: number; model?: string; stopReason?: string; text?: string; tools: ToolVM[]; inTok?: number; outTok?: number; startedAt?: number; streamStartedAt?: number; endedAt?: number }
interface SpeechVM { startedAt: number; endedAt?: number }
interface TriggerVM { kind: string; text?: string; via?: string }
interface TurnVM { id: string; sessionId: string; source?: string; trigger?: TriggerVM; startedAt: number; endedAt?: number; ended: boolean; steps: StepVM[]; speech: SpeechVM[] }

interface StoredTool { toolCallId: string; toolName: string; args?: unknown; result?: string; isError?: boolean; startedAt?: number; endedAt?: number }
interface StoredStep { index: number; model?: string; stopReason?: string; text?: string; tools: StoredTool[]; usage?: { inputTokens?: number; outputTokens?: number }; startedAt?: number; streamStartedAt?: number; endedAt?: number }
interface StoredTurn { turnId: string; sessionId: string; trigger?: { kind: string; text?: string }; speech?: { startedAt: number; endedAt?: number }[]; startedAt: number; endedAt?: number; steps: StoredStep[] }
interface StoredSession { sessionId: string; source?: string; turns: StoredTurn[] }
interface SessionSummary { sessionId: string; source?: string }

const IST = 'Asia/Kolkata';

/** Copy-on-click chip for an id/value living inside a clickable header button.
 *  Stops propagation so copying doesn't also toggle the row, and flashes ✓ on
 *  success. Renders a <span> (not a nested <button>) so it's valid inside a
 *  <button>. */
function CopyChip({ value, className, label }: { value: string; className?: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => () => clearTimeout(timer.current), []);
  const copy = (e: ReactMouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    navigator.clipboard?.writeText(value).then(() => {
      setCopied(true);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 1000);
    }).catch(() => {});
  };
  return (
    <span
      role="button"
      tabIndex={0}
      className={`obs-copy${copied ? ' copied' : ''}${className ? ` ${className}` : ''}`}
      title={`click to copy ${label ?? value}`}
      onClick={copy}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') copy(e as unknown as ReactMouseEvent); }}
    >
      {label ?? value}
      <span className="obs-copy-ico" aria-hidden>{copied ? '✓' : '⧉'}</span>
    </span>
  );
}

/** A bare copy icon that sits after selectable text (the text stays selectable;
 *  this is the "copy the whole thing" shortcut). Flashes ✓ on success. */
function CopyIco({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => () => clearTimeout(timer.current), []);
  return (
    <span
      role="button"
      tabIndex={0}
      className={`obs-copy-ico standalone${copied ? ' copied' : ''}`}
      title="copy"
      onClick={(e) => {
        e.stopPropagation();
        navigator.clipboard?.writeText(value).then(() => {
          setCopied(true);
          clearTimeout(timer.current);
          timer.current = setTimeout(() => setCopied(false), 1000);
        }).catch(() => {});
      }}
    >
      {copied ? ' ✓' : ' ⧉'}
    </span>
  );
}

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
        const have = new Set(live.map((t) => turnKey(t.sessionId, t.id)));
        const merged = [...vms.filter((t) => !have.has(turnKey(t.sessionId, t.id))), ...live].slice(-300);
        turnIndex.current.clear();
        merged.forEach((t, i) => turnIndex.current.set(turnKey(t.sessionId, t.id), i));
        return merged;
      });
    }).catch(() => {});
    return () => { cancelled = true; };
  }, []);

  // FEEDBACK overlay: fetch all feedback once + on the live `feedback` topic, and
  // index it so the trace can show 💬(count) per session and 💬(text) per turn.
  const [feedback, setFeedback] = useState<FeedbackMeta[]>([]);
  const refreshFeedback = useCallback(() => {
    api.get<FeedbackMeta[]>('/feedback/').then(setFeedback).catch(() => {});
  }, []);
  useEffect(() => { refreshFeedback(); }, [refreshFeedback]);
  useStationEvents('feedback', refreshFeedback);

  // sessionId → count; sessionId+turnId → the feedbacks on that exact turn.
  const fbBySession = useMemo(() => {
    const m = new Map<string, FeedbackMeta[]>();
    for (const f of feedback) if (f.sessionId) (m.get(f.sessionId) ?? m.set(f.sessionId, []).get(f.sessionId)!).push(f);
    return m;
  }, [feedback]);
  const fbByTurn = useMemo(() => {
    const m = new Map<string, FeedbackMeta[]>();
    for (const f of feedback) if (f.sessionId && f.turnId) (m.get(turnKey(f.sessionId, f.turnId)) ?? m.set(turnKey(f.sessionId, f.turnId), []).get(turnKey(f.sessionId, f.turnId))!).push(f);
    return m;
  }, [feedback]);

  // LIVE perception models — what the dock is actually perceiving with right now
  // (the two MLX sidecars + their up/down state). Shown atop the perception lane.
  const [percModels, setPercModels] = useState<Array<{ name: string; kind: string; up: boolean }>>([]);
  useEffect(() => {
    const load = () => api.get<Array<{ name: string; kind: string; up: boolean }>>('/perception/sidecars').then((s) => setPercModels(s ?? [])).catch(() => {});
    load();
    const iv = setInterval(load, 10_000); // refresh so up/down stays current
    return () => clearInterval(iv);
  }, []);

  const onEvent = useCallback((frame: { payload: unknown }) => {
    const ev = frame.payload as AgentEventDto;
    setTurns((prev) => {
      const next = prev.slice();
      // key by session+turn: turn ids are unique only within a session, so two
      // sessions reusing an id must not merge into one row.
      const key = turnKey(ev.sessionId, ev.turnId);
      let i = turnIndex.current.get(key);
      // The index can be STALE: the slice(-300) truncation below shifts array positions
      // (and the initial-load merge can race a live event) — dereferencing a stale index
      // hit undefined and crashed the module on EVERY live event once the day crossed
      // 300 turns (seen 2026-07-05). Verify the indexed entry actually matches; re-find
      // or append when it doesn't.
      if (i == null || next[i] == null || turnKey(next[i]!.sessionId, next[i]!.id) !== key) {
        const found = next.findIndex((t) => turnKey(t.sessionId, t.id) === key);
        if (found >= 0) { i = found; } else {
          i = next.length;
          next.push({ id: ev.turnId, sessionId: ev.sessionId, startedAt: ev.ts, ended: false, steps: [], speech: [] });
        }
        turnIndex.current.set(key, i);
      }
      const turn = { ...next[i]!, steps: next[i]!.steps.slice() };
      applyEvent(turn, ev);
      next[i] = turn;
      const out = next.slice(-300);
      if (out.length !== next.length) {
        // truncation shifted every index — rebuild so the next event can't go stale.
        turnIndex.current.clear();
        out.forEach((t, idx) => turnIndex.current.set(turnKey(t.sessionId, t.id), idx));
      }
      return out;
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

  // group filtered turns by session. Sessions are ordered newest-first (below),
  // but turns WITHIN a session read chronologically — oldest at top, newest at
  // the bottom — so a conversation flows top-to-bottom. ("slowest" overrides to
  // slowest-first since that's the point of the filter.)
  const allGroups = useMemo(() => {
    const m = new Map<string, TurnVM[]>();
    for (const t of filtered) (m.get(t.sessionId) ?? m.set(t.sessionId, []).get(t.sessionId)!).push(t);
    const arr = [...m.entries()].map(([sid, ts]) => {
      const sorted = ts.slice().sort((a, b) => (fSlow ? dur(b) - dur(a) : a.startedAt - b.startedAt));
      return { sid, source: ts[0]?.source, turns: sorted, started: Math.min(...ts.map((t) => t.startedAt)), last: Math.max(...ts.map((t) => t.startedAt)) };
    });
    arr.sort((a, b) => b.last - a.last);
    return arr;
  }, [filtered, fSlow]);

  // Perception's own Gemini activity (background STT / summarizer / embedder) is
  // logged as a rolling `perception:<dock>` session for COST tracking — it's not a
  // conversation, so split it into its own collapsed lane instead of polluting the
  // conversation traces. (cost-report.ts on the server emits these.)
  const isPerc = (sid: string) => sid.startsWith('perception:');
  const groups = useMemo(() => allGroups.filter((g) => !isPerc(g.sid)), [allGroups]);
  const percGroups = useMemo(() => allGroups.filter((g) => isPerc(g.sid)), [allGroups]);

  const toggleTurn = (id: string) => setExpanded((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const toggleSession = (sid: string) => setCollapsedSessions((s) => { const n = new Set(s); n.has(sid) ? n.delete(sid) : n.add(sid); return n; });

  // perception sessions start COLLAPSED (they're cost noise, not conversation) —
  // seed the collapsed set once when a new perception session first appears.
  const seededCollapse = useRef(new Set<string>());
  useEffect(() => {
    const fresh = percGroups.map((g) => g.sid).filter((sid) => !seededCollapse.current.has(sid));
    if (fresh.length) {
      fresh.forEach((sid) => seededCollapse.current.add(sid));
      setCollapsedSessions((s) => { const n = new Set(s); fresh.forEach((sid) => n.add(sid)); return n; });
    }
  }, [percGroups]);

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
                  <CopyChip value={g.sid} className="mono obs-session-id" label={g.sid} />
                  <span className="pill acc sm">{g.source ?? '—'}</span>
                  <span className="muted sm">{g.turns.length} turns</span>
                  {(fbBySession.get(g.sid)?.length ?? 0) > 0 && (
                    <span className="pill acc sm" title="feedback recorded on this session">💬 {fbBySession.get(g.sid)!.length}</span>
                  )}
                  <span className="muted sm">· {clock(g.started)}–{clock(g.last)}</span>
                </button>
                {!collapsed && g.turns.map((t) => (
                  <TurnRow key={t.id} turn={t} open={expanded.has(t.id)} onToggle={() => toggleTurn(t.id)} feedback={fbByTurn.get(turnKey(t.sessionId, t.id))} />
                ))}
              </div>
            );
          })}
        </div>}

      {/* PERCEPTION lane — distinct + collapsed, so the dock's own background
          model activity (cost noise) doesn't pollute the conversation traces.
          Header shows what the dock is perceiving with right now. */}
      {(percGroups.length > 0 || percModels.length > 0) && (
        <div className="obs-perc-lane" style={{ marginTop: 18, borderTop: '1px solid var(--line)', paddingTop: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 8 }}>
            <strong style={{ fontSize: 12 }}>🧠 Perception activity</strong>
            <span className="muted sm">the dock's own background models — not conversation</span>
            <span className="spacer" style={{ flex: 1 }} />
            {percModels.map((m) => (
              <span key={m.name} className={`pill sm ${m.up ? 'good' : 'bad'}`} title={`${m.name}: ${m.kind} — ${m.up ? 'running' : 'DOWN'}`}>
                {m.up ? '●' : '○'} {m.name} · {m.kind}
              </span>
            ))}
          </div>
          <div className="obs-sessions">
            {percGroups.map((g) => {
              const collapsed = collapsedSessions.has(g.sid);
              return (
                <div key={g.sid} className="obs-session">
                  <button className="obs-session-head" onClick={() => toggleSession(g.sid)}>
                    <span className="obs-caret">{collapsed ? '▸' : '▾'}</span>
                    <CopyChip value={g.sid} className="mono obs-session-id" label={g.sid} />
                    <span className="pill sm">{g.source ?? '—'}</span>
                    <span className="muted sm">{g.turns.length} calls</span>
                    <span className="muted sm">· {clock(g.started)}–{clock(g.last)}</span>
                  </button>
                  {!collapsed && g.turns.map((t) => (
                    <TurnRow key={t.id} turn={t} open={expanded.has(t.id)} onToggle={() => toggleTurn(t.id)} feedback={fbByTurn.get(turnKey(t.sessionId, t.id))} />
                  ))}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </section>
  );
}

// ── one turn: header row + in-place expandable detail ────────────────────────
function TurnRow({ turn, open, onToggle, feedback }: { turn: TurnVM; open: boolean; onToggle: () => void; feedback?: FeedbackMeta[] }) {
  const err = turn.steps.some((s) => s.tools.some((x) => x.isError));
  return (
    <div className={`obs-turn${open ? ' open' : ''}`}>
      <button className="obs-turn-head" onClick={onToggle}>
        <span className="obs-caret">{open ? '▾' : '▸'}</span>
        <span className="obs-turn-time mono">{clockMs(turn.startedAt)}</span>
        <CopyChip value={turn.id} className="obs-turn-id mono" label={turn.id.replace('turn-', '')} />
        {/* trigger-kind tag on the COLLAPSED line too (self/task/wake…) — 'user' stays
            implicit (it's the default and would just be noise on every row). `via` names
            the RAISING source (mood:curious.wonder / gate:arrival:x / face-follow:errored). */}
        {turn.trigger?.kind && turn.trigger.kind !== 'user' && (
          <span className={`obs-turn-kind trigger-${turn.trigger.kind}`} title={turn.trigger.via ?? turn.trigger.kind}>
            {turn.trigger.kind}{turn.trigger.via ? `·${turn.trigger.via.split(':')[0]}` : ''}
          </span>
        )}
        {turn.trigger?.text && <span className="obs-turn-prompt" title={turn.trigger.text}>“{turn.trigger.text}”</span>}
        <span className={`obs-turn-dur${dur(turn) > 4000 ? ' slow' : ''}`}>{fmtMs(dur(turn))}</span>
        <span className="muted sm">{turn.steps.length} step{turn.steps.length !== 1 ? 's' : ''}</span>
        {turn.steps.flatMap((s) => s.tools).map((tc) => (
          <span key={tc.id} className={`pill sm ${tc.isError ? 'bad' : 'acc'}`}>{tc.name}</span>
        ))}
        {err && <span className="dot off" title="error" />}
        {!turn.ended && <span className="dot wait" title="running" />}
        {feedback?.map((f) => (
          <span key={f.id} className="pill acc sm" title={`feedback (${f.source}): ${f.reason ?? ''}`}>💬 {f.reason ?? 'feedback'}</span>
        ))}
        <span className="spacer" />
        <span className="muted sm obs-turn-fulltime">{fullTime(turn.startedAt)}</span>
      </button>
      {open && <TurnTimeline turn={turn} />}
    </div>
  );
}

// One row in the vertical timeline.
interface Ev { lane: 'llm' | 'tool' | 'speech'; cls: string; label: string; start: number; end: number; detail?: ReactNode }

function TurnTimeline({ turn }: { turn: TurnVM }) {
  const t0 = turn.startedAt;
  const total = Math.max(turnSpan(turn), 1);

  // Build a flat, time-ordered event list. Each LLM step splits into
  // WaitForToken (StepStart→first token = time-to-first-token / model latency)
  // + stream (first token→step end).
  const evs: Ev[] = [];
  for (const s of turn.steps) {
    const a = (s.startedAt ?? t0) - t0;
    const e = (s.endedAt ?? t0 + total) - t0;
    const stream = s.streamStartedAt != null ? s.streamStartedAt - t0 : e; // wait→stream boundary
    evs.push({
      lane: 'llm', cls: 'gen', label: `step ${s.idx} · WaitForToken`, start: a, end: stream,
      detail: <>{s.model && <span className="pill acc sm">{s.model.split('/').pop()}</span>}{s.stopReason && <span className="muted sm mono">{s.stopReason}</span>}<span className="muted sm">tok {tok(s.inTok)}→{tok(s.outTok)}</span></>,
    });
    if (stream < e) {
      evs.push({
        lane: 'llm', cls: 'stream', label: `step ${s.idx} · stream reply`, start: stream, end: e,
        detail: s.text ? <span className="obs-ev-text obs-copytext" title="select text, or click ⧉ to copy all">“{s.text}”<CopyIco value={s.text} /></span> : undefined,
      });
    }
    for (const tc of s.tools) {
      const ta = (tc.startedAt ?? t0) - t0;
      const tb = (tc.endedAt ?? tc.startedAt ?? t0) - t0;
      evs.push({
        lane: 'tool', cls: `tool${tc.isError ? ' err' : ''}`, label: `⚙ ${tc.name}`, start: ta, end: tb,
        detail: (
          <details className="obs-ev-tool">
            <summary className="muted sm">
              {tc.isError ? 'error · ' : ''}params / response
              <span className="obs-ev-peek mono">{inlinePeek(tc.args, tc.result)}</span>
            </summary>
            <div className="obs-kv"><span>params</span><pre>{pretty(tc.args)}</pre></div>
            {tc.result != null && <div className="obs-kv"><span>response</span><pre>{tc.result}</pre></div>}
          </details>
        ),
      });
    }
  }
  for (const w of turn.speech) {
    const start = w.startedAt - t0;
    const end = (w.endedAt ?? t0 + total) - t0;   // open window clamps to turn span
    evs.push({ lane: 'speech', cls: 'speech', label: '🔊 speaking', start, end: Math.max(end, start) });
  }
  evs.sort((x, y) => x.start - y.start || x.end - y.end);

  return (
    <div className="obs-timeline">
      {turn.trigger && (
        <div className={`obs-msg trigger-${turn.trigger.kind}`}>
          <span className="obs-msg-who">{turn.trigger.kind}</span>
          {/* the raising source, in full (e.g. mood:curious.wonder, gate:arrival:guru) */}
          {turn.trigger.via && <span className="obs-msg-via mono">{turn.trigger.via}</span>}
          {turn.trigger.text && <span className="obs-msg-text obs-copytext" title="double-click a word to select · click ⧉ to copy all">{turn.trigger.text}<CopyIco value={turn.trigger.text} /></span>}
        </div>
      )}
      <div className="obs-vaxis">{clockMs(turn.startedAt)} → +{fmtMs(total)} · {evs.length} events</div>
      <div className="obs-vt">
        {evs.map((ev, i) => {
          const leftPct = (ev.start / total) * 100;
          const widPct = Math.max(1.5, ((ev.end - ev.start) / total) * 100);
          return (
            <div key={i} className={`obs-ev lane-${ev.lane}`}>
              <span className="obs-ev-when mono">@{fmtMs(ev.start)}</span>
              <span className={`obs-ev-lbl ${ev.cls}`}>{ev.label}</span>
              <span className="obs-ev-dur mono">{fmtMs(ev.end - ev.start)}</span>
              <span className="obs-ev-track">
                <span className={`obs-ev-bar ${ev.cls}`} style={{ left: `${leftPct}%`, width: `${Math.min(widPct, 100 - leftPct)}%` }} />
              </span>
            </div>
          );
        }).reduce<ReactNode[]>((acc, row, i) => {
          // interleave the detail (text/params) under its row
          acc.push(row);
          const d = evs[i]!.detail;
          if (d) acc.push(<div key={`d${i}`} className="obs-ev-detail">{d}</div>);
          return acc;
        }, [])}
      </div>
    </div>
  );
}

// ── helpers ──────────────────────────────────────────────────────────────────
function dur(t: TurnVM): number { return (t.endedAt ?? t.steps.at(-1)?.endedAt ?? t.startedAt) - t.startedAt; }
/** turn span including any (post-TurnEnd) speech windows. */
function turnSpan(t: TurnVM): number {
  const ends = [t.endedAt ?? 0, ...t.speech.map((w) => w.endedAt ?? w.startedAt)];
  return Math.max(...ends, t.startedAt) - t.startedAt;
}
function fmtMs(ms: number): string { return ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${Math.round(ms)}ms`; }
function tok(n?: number): string { return n != null && n > 0 ? String(n) : 'n/a'; }
function clock(ts: number): string { return new Date(ts).toLocaleTimeString('en-GB', { timeZone: IST, hour: '2-digit', minute: '2-digit', second: '2-digit' }); }
function clockMs(ts: number): string { return `${clock(ts)}.${String(ts % 1000).padStart(3, '0')}`; }
function fullTime(ts: number): string { return new Date(ts).toLocaleString('en-GB', { timeZone: IST, hour12: false }) + ' IST'; }
function pretty(v: unknown): string { try { return typeof v === 'string' ? v : JSON.stringify(v, null, 1); } catch { return String(v); } }
/** Compact one-line preview of a tool's args (+ result) shown next to the
 *  "params / response" summary — collapsed whitespace, truncated. */
function inlinePeek(args: unknown, result?: string): string {
  const compact = (v: unknown) => {
    const s = typeof v === 'string' ? v : (() => { try { return JSON.stringify(v); } catch { return String(v); } })();
    return (s ?? '').replace(/\s+/g, ' ').trim();
  };
  let s = compact(args);
  if (result) s += (s ? '  →  ' : '→ ') + compact(result);
  return s.length > 160 ? s.slice(0, 160) + '…' : s;
}
/** turn ids are unique only within a session — key the live index by both. */
function turnKey(sessionId: string, turnId: string): string { return `${sessionId} ${turnId}`; }

function storedToVM(t: StoredTurn, source?: string): TurnVM {
  return {
    id: t.turnId, sessionId: t.sessionId, source, trigger: t.trigger, startedAt: t.startedAt, endedAt: t.endedAt, ended: t.endedAt != null,
    speech: t.speech ?? [],
    steps: t.steps.map((s) => ({
      idx: s.index, model: s.model, stopReason: s.stopReason, text: s.text,
      inTok: s.usage?.inputTokens, outTok: s.usage?.outputTokens, startedAt: s.startedAt, streamStartedAt: s.streamStartedAt, endedAt: s.endedAt,
      tools: s.tools.map((tc) => ({ id: tc.toolCallId, name: tc.toolName, args: tc.args, result: tc.result, isError: tc.isError, startedAt: tc.startedAt, endedAt: tc.endedAt })),
    })),
  };
}

function applyEvent(turn: TurnVM, ev: AgentEventDto): void {
  const last = turn.steps[turn.steps.length - 1];
  switch (ev.kind) {
    case 'TurnStart': if (ev.data?.trigger != null) turn.trigger = ev.data.trigger as TriggerVM; break;
    case 'TurnEnd': turn.ended = true; turn.endedAt = ev.ts; break;
    case 'StepStart': turn.steps.push({ idx: turn.steps.length, tools: [], startedAt: ev.ts }); break;
    case 'StepEnd':
      if (last) {
        last.endedAt = ev.ts; last.model = ev.data?.model; last.stopReason = ev.data?.stopReason;
        last.inTok = ev.data?.usage?.inputTokens; last.outTok = ev.data?.usage?.outputTokens;
      }
      break;
    case 'MessageUpdate': if (last && last.streamStartedAt == null) last.streamStartedAt = ev.ts; break;
    case 'MessageEnd': if (last && ev.data?.text != null) last.text = ev.data.text; break;
    case 'SpeakStart': {
      const prev = [...turn.speech].reverse().find((x) => x.endedAt == null); if (prev) prev.endedAt = ev.ts;
      turn.speech.push({ startedAt: ev.ts }); break;
    }
    case 'SpeakEnd': { const w = [...turn.speech].reverse().find((x) => x.endedAt == null); if (w) w.endedAt = ev.ts; break; }
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

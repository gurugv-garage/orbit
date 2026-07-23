import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { MouseEvent as ReactMouseEvent, ReactNode } from 'react';
import { useStationEvents } from '../lib/useStation';
import { api } from '../lib/station';
import type { AgentEventDto } from '../lib/protocol';
import { EventChip, fmtT, type ConvEvent } from './Timeline';

// feedback overlay (GET /api/feedback/) — just the fields the trace badges need.
interface FeedbackMeta { id: string; sessionId?: string; turnId?: string; source: string; reason?: string }

// ── view models (mirror the server store) ────────────────────────────────────
interface ToolVM { id: string; name: string; args?: unknown; result?: string; isError?: boolean; startedAt?: number; endedAt?: number }
interface StepVM { idx: number; model?: string; stopReason?: string; text?: string; rawText?: string; tools: ToolVM[]; inTok?: number; outTok?: number; cacheRead?: number; cost?: number; thinkTok?: number; thinkingMs?: number; startedAt?: number; streamStartedAt?: number; endedAt?: number }
interface SpeechVM { startedAt: number; endedAt?: number }
/** admit provenance for addressed user turns — which rule/window let the utterance in
 *  (server: brain/conversation-state.ts AdmitTrace, riding trigger.window). */
interface AdmitVM { rule?: string; mode?: string; windowSrc?: string; openedBy?: string; openedAt?: number; msToExpiry?: number }
interface TriggerVM { kind: string; text?: string; via?: string; window?: AdmitVM; utteranceId?: string }
interface SttVM { confTier?: string; avgLogprob?: number | null; noSpeechProb?: number | null; compressionRatio?: number | null; voice?: { name: string; score?: number; match?: boolean } }
interface TurnVM { id: string; sessionId: string; source?: string; trigger?: TriggerVM; startedAt: number; endedAt?: number; ended: boolean; steps: StepVM[]; speech: SpeechVM[]; image?: string; stt?: SttVM }

interface StoredTool { toolCallId: string; toolName: string; args?: unknown; result?: string; isError?: boolean; startedAt?: number; endedAt?: number }
interface StoredStep { index: number; model?: string; stopReason?: string; text?: string; rawText?: string; tools: StoredTool[]; usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number; cost?: number; cacheRead?: number; thinkingTokens?: number }; thinkingMs?: number; startedAt?: number; streamStartedAt?: number; endedAt?: number }
interface StoredTurn { turnId: string; sessionId: string; trigger?: TriggerVM; speech?: { startedAt: number; endedAt?: number }[]; startedAt: number; endedAt?: number; steps: StoredStep[]; image?: string; stt?: SttVM }
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

// ── exact-request viewer ─────────────────────────────────────────────────────
// What one LLM step ACTUALLY sent (systemPrompt + message window + tool names),
// recorded at the brain's streamFn seam into a bounded ring — fetched lazily on
// first expand (the blobs are ~50 KB and must not ride the live obs stream).
interface RecordedRequest { systemPrompt?: string; tools?: string[]; messages?: Array<{ role?: string; content?: unknown }> }

function msgPreview(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((p) => {
      const item = p as { type?: string; text?: string; toolName?: string; omitted?: string };
      if (item.type === 'text') return item.text ?? '';
      if (item.type === 'toolCall') return `⚙ ${item.toolName ?? 'tool'}`;
      if (item.type === 'image') return '📷 [image]';
      return `[${item.type ?? '?'}]`;
    }).join(' ');
  }
  return '';
}

/** Rough token count for one message (text/4 + ~800/image) — used to place the
 *  cache boundary. The provider caches a byte PREFIX of (system + messages in
 *  order); we walk in that order until the reported cacheRead is consumed. An
 *  ESTIMATE (real tokenization differs) — labeled as such in the UI. */
function estMsgTokens(m: { content?: unknown }): number {
  const c = m.content;
  if (typeof c === 'string') return Math.round(c.length / 4);
  if (!Array.isArray(c)) return 8;
  let tok = 8;
  for (const p of c as Array<{ type?: string; text?: string }>) {
    if (typeof p.text === 'string') tok += Math.round(p.text.length / 4);
    if (p.type === 'image') tok += 800;
    if (p.type === 'toolCall') tok += 60;
  }
  return tok;
}

function RequestPeek({ sessionId, turnId, stepIdx, cacheRead, inputTokens }: { sessionId: string; turnId: string; stepIdx: number; cacheRead?: number; inputTokens?: number }) {
  const [state, setState] = useState<'idle' | 'loading' | 'ok' | 'missing'>('idle');
  const [reqData, setReqData] = useState<RecordedRequest | null>(null);
  const load = () => {
    if (state !== 'idle') return;
    setState('loading');
    fetch(`/api/observability/requests/${encodeURIComponent(sessionId)}/${encodeURIComponent(turnId)}/${stepIdx}`)
      .then(async (r) => {
        if (!r.ok) { setState('missing'); return; }
        setReqData(await r.json() as RecordedRequest);
        setState('ok');
      })
      .catch(() => setState('missing'));
  };
  const cr = cacheRead ?? 0;
  const fresh = inputTokens != null ? (inputTokens > cr ? inputTokens - cr : inputTokens) : undefined;
  const total = fresh != null ? cr + fresh : undefined;
  return (
    <details className="obs-ev-tool obs-req obs-convctx" onToggle={(e) => { if ((e.target as HTMLDetailsElement).open) load(); }}>
      <summary className="muted sm">
        📨 request — the exact bytes this LLM step sent
        {total != null && <> · {fmtTok(total)} tok in{cr > 0 ? ` (${Math.round(100 * cr / total)}% cached)` : ''}</>}
        {reqData && <> · {reqData.messages?.length ?? 0} msgs · {reqData.tools?.length ?? 0} tools</>}
      </summary>
      {state === 'loading' && <div className="muted sm">loading…</div>}
      {state === 'missing' && <div className="muted sm">not recorded (pre-dates capture, or evicted from the ring)</div>}
      {state === 'ok' && reqData && (() => {
        // estimated cache boundary: walk system prompt then messages in order,
        // consuming the step's reported cacheRead tokens.
        const sysTok = Math.round((reqData.systemPrompt?.length ?? 0) / 4);
        let remaining = (cacheRead ?? 0) - sysTok;
        const sysCached = (cacheRead ?? 0) > 0 && remaining >= -sysTok * 0.2; // system cached if cacheRead reaches ~it
        const cachedIdx = new Set<number>();
        reqData.messages?.forEach((m, i) => {
          if (remaining <= 0) return;
          const t = estMsgTokens(m);
          if (remaining >= t * 0.5) cachedIdx.add(i); // >half its tokens covered → call it cached
          remaining -= t;
        });
        return (
        <div className="obs-req-body">
          {(cacheRead ?? 0) >= 0 && inputTokens != null && (() => {
            const cr = cacheRead ?? 0;
            // Gemini excludes cached tokens from inputTokens on a hit — fresh is
            // whichever interpretation keeps the parts non-negative.
            const fresh = inputTokens > cr ? inputTokens - cr : inputTokens;
            const total = cr + fresh;
            return (
              <div className="muted sm" style={{ margin: '2px 0 6px' }}>
                <span style={{ color: 'rgb(110,220,160)' }}>■ cached</span> ~{fmtTok(cr)} of {fmtTok(total)} input tokens
                ({total > 0 ? Math.round(100 * cr / total) : 0}%) ·{' '}
                <span style={{ color: 'rgb(255,180,70)' }}>■ fresh</span> {fmtTok(fresh)} —
                boundary placement is an estimate from char/image counts
              </div>
            );
          })()}
          {reqData.tools && reqData.tools.length > 0 && (
            <div className="obs-kv"><span>tools ({reqData.tools.length})</span><pre>{reqData.tools.join(', ')}</pre></div>
          )}
          {reqData.systemPrompt != null && (
            <details className="obs-req-msg" style={{ borderLeft: `3px solid ${sysCached ? 'rgba(110,220,160,0.8)' : 'rgba(255,180,70,0.8)'}`, paddingLeft: 6 }}>
              <summary className="muted sm" title={sysCached ? 'served from prompt cache (estimated)' : 'NOT cached (estimated) — this prefix changed since the previous request'}>system prompt · {fmtTok(Math.round(reqData.systemPrompt.length / 4))} tok est · {reqData.systemPrompt.length.toLocaleString()} chars</summary>
              <pre className="obs-req-pre">{reqData.systemPrompt}</pre>
            </details>
          )}
          <div className="muted sm" style={{ margin: '4px 0 2px' }}>{reqData.messages?.length ?? 0} messages in window</div>
          {reqData.messages?.map((m, i) => {
            const imgs = Array.isArray(m.content)
              ? (m.content as Array<{ type?: string; imageRef?: string }>).filter((piece) => piece.type === 'image' && piece.imageRef)
              : [];
            return (
              <details key={i} className="obs-req-msg"
                style={{ borderLeft: `3px solid ${cachedIdx.has(i) ? 'rgba(110,220,160,0.8)' : 'rgba(255,180,70,0.8)'}`, paddingLeft: 6 }}>
                <summary className="muted sm" title={cachedIdx.has(i) ? 'served from prompt cache (estimated boundary)' : 'fresh tokens (estimated boundary)'}>
                  <span className="mono">{i}</span> · <strong>{m.role ?? '?'}</strong>
                  {imgs.length > 0 && <span> 📷{imgs.length > 1 ? `×${imgs.length}` : ''}</span>}
                  <span className="obs-ev-peek mono"> {msgPreview(m.content).slice(0, 140)}</span>
                </summary>
                {imgs.map((piece) => (
                  <a key={piece.imageRef} href={`/api/observability/req-image?f=${encodeURIComponent(piece.imageRef!)}`} target="_blank" rel="noreferrer">
                    <img src={`/api/observability/req-image?f=${encodeURIComponent(piece.imageRef!)}`}
                      alt="frame sent to the model" style={{ maxHeight: 110, borderRadius: 4, margin: '4px 6px 4px 0' }} />
                  </a>
                ))}
                <pre className="obs-req-pre">{pretty(m)}</pre>
              </details>
            );
          })}
        </div>
        );
      })()}
    </details>
  );
}

export function Observability() {
  const [turns, setTurns] = useState<TurnVM[]>([]);
  const turnIndex = useRef(new Map<string, number>());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());     // expanded turn ids
  const [collapsedSessions, setCollapsedSessions] = useState<Set<string>>(new Set());
  // source-turn ids whose nested REPLAY rows are shown (collapsed by default)
  const [openReplays, setOpenReplays] = useState<Set<string>>(new Set());

  // filters
  const [fSession, setFSession] = useState('');
  // deep link from the Timeline: #observability?session=<sid>&turn=<tid>
  useEffect(() => {
    const q = new URLSearchParams(location.hash.split('?')[1] ?? '');
    const sid = q.get('session'); const tid = q.get('turn');
    if (sid) setFSession(sid);
    if (sid && tid) {
      setExpanded((prev) => new Set(prev).add(tid)); // expanded is keyed by BARE turn id
      // scroll once the row exists (data loads async; poll briefly).
      const key = turnKey(sid, tid);
      let tries = 0;
      const iv = setInterval(() => {
        // re-scroll for a few ticks: rows above load async and shift the layout
        // after the first scroll lands.
        // NOTE: turnKey joins with a NUL byte (same idiom as the server's FTS
        // key) — CSS.escape maps NUL to U+FFFD, so a querySelector match is
        // impossible; compare attribute strings in JS instead.
        const el = [...document.querySelectorAll('[data-turnkey]')]
          .find((e) => e.getAttribute('data-turnkey') === key);
        if (el) el.scrollIntoView({ block: 'center' });
        if (++tries > 14) clearInterval(iv);
      }, 300);
      return () => clearInterval(iv);
    }
  }, []);
  const [fSource, setFSource] = useState('');
  const [fTool, setFTool] = useState('');
  const [fErrors, setFErrors] = useState(false);
  const [fSlow, setFSlow] = useState(false);
  const [fSearch, setFSearch] = useState('');

  // Download a session's transcript as pi-harness-compatible v3 JSONL (openable
  // with `pi --session <file>`). Streams the file from the brain module and
  // saves it via a temporary object-URL anchor — can't use the `api` helper,
  // which JSON-parses. Needs both the dock (session `source`) and sessionId.
  const dumpSession = async (dock: string, sessionId: string) => {
    const r = await fetch(`/api/brain/${encodeURIComponent(dock)}/session/${encodeURIComponent(sessionId)}/dump`);
    if (!r.ok) { window.alert(`Dump failed (${r.status}).`); return; }
    const blob = await r.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${sessionId}.jsonl`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

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

  // LIVE brain lanes — which session each dock has OPEN right now, so the trace
  // can badge the live session and offer the end-session control in place.
  interface BrainLane { dock: string; sessionId: string; turnActive?: boolean; state?: string }
  const [lanes, setLanes] = useState<BrainLane[]>([]);
  const refreshLanes = useCallback(() => {
    api.get<BrainLane[]>('/brain/docks').then((l) => setLanes(Array.isArray(l) ? l : [])).catch(() => {});
  }, []);
  useEffect(() => {
    refreshLanes();
    const iv = setInterval(refreshLanes, 10_000); // keep the badge honest (idle closes are lazy)
    return () => clearInterval(iv);
  }, [refreshLanes]);
  const endSession = async (dock: string) => {
    await fetch(`/api/brain/${encodeURIComponent(dock)}/session/end`, { method: 'POST' }).catch(() => {});
    refreshLanes();
  };

  // LIVE perception models — what the dock is actually perceiving with right now
  // (the two MLX sidecars + their up/down state). Shown atop the perception lane.
  const [percModels, setPercModels] = useState<Array<{ name: string; kind: string; up: boolean }>>([]);
  useEffect(() => {
    const load = () => api.get<Array<{ name: string; kind: string; up: boolean }>>('/perception/sidecars').then((s) => setPercModels(s ?? [])).catch(() => {});
    load();
    const iv = setInterval(load, 10_000); // refresh so up/down stays current
    return () => clearInterval(iv);
  }, []);

  const onEvent = useCallback((frame: { kind?: string; payload: unknown }) => {
    // obs carries OTHER kinds too (the Brain view's 'brain-debug' stream, keyed
    // by the WIRE turnId) — treating those as trace events created ghost turn
    // rows (0 steps, running forever) under a different id. Events only.
    if (frame.kind !== 'event') return;
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

  const toggleReplays = (key: string) => setOpenReplays((s) => { const n = new Set(s); n.has(key) ? n.delete(key) : n.add(key); return n; });
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
            const live = lanes.find((l) => l.dock === g.source && l.sessionId === g.sid);
            return (
              <div key={g.sid} className="obs-session">
                <button className="obs-session-head" onClick={() => toggleSession(g.sid)}>
                  <span className="obs-caret">{collapsed ? '▸' : '▾'}</span>
                  <CopyChip value={g.sid} className="mono obs-session-id" label={g.sid} />
                  <span className="pill acc sm">{g.source ?? '—'}</span>
                  {live && (
                    <>
                      <span className="pill good sm" title={`the dock's OPEN brain session — state: ${live.state ?? 'idle'}`}>
                        ● open{live.turnActive ? ' · turn running' : ''}
                      </span>
                      <span
                        role="button"
                        tabIndex={0}
                        className="pill bad sm obs-endsess"
                        title="end this session now — it compacts to a memory note and the next turn opens fresh"
                        onClick={(e) => { e.stopPropagation(); void endSession(live.dock); }}
                        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.stopPropagation(); void endSession(live.dock); } }}
                      >
                        ✖ end session
                      </span>
                    </>
                  )}
                  <span className="muted sm">{g.turns.length} turns</span>
                  <UsageChip u={sumUsage(g.turns)} title="session total" />
                  {(fbBySession.get(g.sid)?.length ?? 0) > 0 && (
                    <span className="pill acc sm" title="feedback recorded on this session">💬 {fbBySession.get(g.sid)!.length}</span>
                  )}
                  <span className="muted sm">· {clock(g.started)}–{clock(g.last)}</span>
                  <span className="spacer" style={{ flex: 1 }} />
                  <span
                    role="button"
                    tabIndex={0}
                    className="pill sm obs-dump"
                    title={g.source ? 'download pi-harness JSONL (open with `pi --session`)' : 'no dock — cannot dump'}
                    aria-disabled={!g.source}
                    style={g.source ? { cursor: 'pointer' } : { opacity: 0.4, cursor: 'not-allowed' }}
                    onClick={(e) => { e.stopPropagation(); if (g.source) void dumpSession(g.source, g.sid); }}
                  >
                    ⬇ dump
                  </span>
                </button>
                {!collapsed && (() => {
                  // REPLAY rows nest under their source turn (via = "srcSession:srcTurn")
                  // when the source is in this list; orphans (source in another
                  // session / evicted) stay inline. Collapsed by default behind a
                  // "↳ N replays" line — a LIVE (running) replay always shows.
                  const ids = new Set(g.turns.map((t) => t.id));
                  const srcOf = (t: TurnVM): string | undefined =>
                    t.trigger?.kind === 'replay' ? t.trigger.via?.split(':')[1] : undefined;
                  const nested = new Map<string, TurnVM[]>();
                  for (const t of g.turns) {
                    const src = srcOf(t);
                    if (src && ids.has(src)) nested.set(src, [...(nested.get(src) ?? []), t]);
                  }
                  const isNested = (t: TurnVM) => { const s = srcOf(t); return s != null && ids.has(s); };
                  const row = (t: TurnVM) => (
                    <TurnRow key={t.id} turn={t} open={expanded.has(t.id)} onToggle={() => toggleTurn(t.id)} feedback={fbByTurn.get(turnKey(t.sessionId, t.id))} dock={g.source} />
                  );
                  return g.turns.filter((t) => !isNested(t)).map((t) => {
                    const reps = nested.get(t.id) ?? [];
                    if (reps.length === 0) return row(t);
                    const live = reps.filter((r) => !r.ended);
                    const shown = openReplays.has(turnKey(g.sid, t.id)) ? reps : live;
                    return (
                      <div key={t.id}>
                        {row(t)}
                        {shown.length < reps.length && (
                          <button className="obs-replays-toggle" onClick={() => toggleReplays(turnKey(g.sid, t.id))}
                            title="re-runs of this turn (recorded responses through live code)">
                            ↳ {reps.length} replay{reps.length !== 1 ? 's' : ''}
                          </button>
                        )}
                        {shown.map((r) => <div key={r.id} className="obs-replay-nest">{row(r)}</div>)}
                        {shown.length === reps.length && reps.length > live.length && (
                          <button className="obs-replays-toggle" onClick={() => toggleReplays(turnKey(g.sid, t.id))}>
                            ↳ hide replays
                          </button>
                        )}
                      </div>
                    );
                  });
                })()}
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
                    <UsageChip u={sumUsage(g.turns)} title="session total" />
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

/** Synthetic TAG rows vs real LLM tool calls. inline_mood entries are the
 *  station's trace of an inline [face:] control token going live on the phone
 *  (and a [move] anchor rides the same mechanism) — they are NOT tool calls
 *  the model made. Render them as 🏷 with the tag's own syntax so the trace
 *  never conflates the two. */
function tagLabel(tc: ToolVM): string | undefined {
  if (tc.name !== 'inline_mood') return undefined;
  const a = tc.args as { expression?: string; appliedBy?: string } | undefined;
  return `[face:${a?.expression ?? '?'}]`;
}

/** visual_search saves the FOUND view under .data/search and cites it in the
 *  result — extract the basename so the trace can render the actual image. */
function searchShot(result?: string): string | undefined {
  const m = result?.match(/\.data\/search\/([a-zA-Z0-9._-]+\.jpg)/);
  return m?.[1];
}

/** The WHOLE sweep's judged views (found or not) for one visual_search call —
 *  lazy-fetched by dock + the tool's time window, rendered as a thumbnail
 *  strip. MATCH frames get the accent border; -still frames are the hi-res
 *  escalations. The "why didn't it see me" panel. */
function SearchShotStrip({ dock, from, to }: { dock: string; from: number; to: number }) {
  const [shots, setShots] = useState<Array<{ f: string; ts: number; tag: string }> | null>(null);
  const load = () => {
    if (shots !== null) return;
    fetch(`/api/observability/search-shots?dock=${encodeURIComponent(dock)}&from=${from - 2000}&to=${to + 2000}`)
      .then(async (r) => setShots(((await r.json()) as { shots?: Array<{ f: string; ts: number; tag: string }> }).shots ?? []))
      .catch(() => setShots([]));
  };
  return (
    <details className="obs-ev-tool" onToggle={(e) => { if ((e.target as HTMLDetailsElement).open) load(); }}>
      <summary className="muted sm">judged views (every pose the sweep looked at)</summary>
      {shots === null && <div className="muted sm">…</div>}
      {shots?.length === 0 && <div className="muted sm">no shots recorded for this window</div>}
      {!!shots?.length && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 6 }}>
          {shots.map((s) => (
            <a key={s.f} href={`/api/observability/search-shot?f=${encodeURIComponent(s.f)}`} target="_blank" rel="noreferrer"
              style={{ textAlign: 'center', textDecoration: 'none' }}>
              <img src={`/api/observability/search-shot?f=${encodeURIComponent(s.f)}`} alt={s.tag}
                style={{ width: 108, borderRadius: 5, display: 'block',
                  border: /match/i.test(s.tag) ? '2px solid var(--acc, #6c6)' : '1px solid #3333' }} />
              <span className="muted" style={{ fontSize: 10 }}>{s.tag.replace(/^pose/, '')}</span>
            </a>
          ))}
        </div>
      )}
    </details>
  );
}

// ── one turn: header row + in-place expandable detail ────────────────────────
function TurnRow({ turn, open, onToggle, feedback, dock }: { turn: TurnVM; open: boolean; onToggle: () => void; feedback?: FeedbackMeta[]; dock?: string }) {
  const err = turn.steps.some((s) => s.tools.some((x) => x.isError));
  // ▶ REPLAY (conversation lane only — `dock` is passed there): re-run this
  // recorded turn on the dock through the LIVE pipeline with no LLM calls.
  const replay = async (e: { stopPropagation: () => void }) => {
    e.stopPropagation();
    if (!dock) return;
    try {
      const r = await fetch(`/api/brain/${encodeURIComponent(dock)}/replay`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: turn.sessionId, turnId: turn.id }),
      });
      const j = (await r.json().catch(() => ({}))) as { error?: string; degraded?: boolean };
      if (!r.ok) alert(`replay failed: ${j.error ?? `HTTP ${r.status}`}`);
      else if (j.degraded) alert('replay started — DEGRADED: transcript slice not found, [face:]/[move] tags were lost (obs text only)');
    } catch (err2) {
      alert(`replay failed: ${String(err2)}`);
    }
  };
  return (
    <div className={`obs-turn${open ? ' open' : ''}`} data-turnkey={turnKey(turn.sessionId, turn.id)}>
      <button className="obs-turn-head" onClick={onToggle}>
        <span className="obs-caret">{open ? '▾' : '▸'}</span>
        <span className="obs-turn-time mono">{clockMs(turn.startedAt)}</span>
        <CopyChip value={turn.id} className="obs-turn-id mono" label={turn.id.replace('turn-', '')} />
        {/* trigger-kind tag on the COLLAPSED line too (self/task/wake…) — 'user' stays
            implicit (it's the default and would just be noise on every row). `via` names
            the RAISING source (mood:curious.wonder / gate:arrival:x / face-follow:errored). */}
        {turn.trigger?.kind && turn.trigger.kind !== 'user' && (
          <span className={`obs-turn-kind trigger-${turn.trigger.kind}`} title={kindTitle(turn.trigger)}>
            {/* replay via = "srcSession:srcTurn" — the TURN is the informative half
                (replays usually target the same session); other kinds badge the source. */}
            {turn.trigger.kind}
            {turn.trigger.via ? `·${(turn.trigger.kind === 'replay'
              ? (turn.trigger.via.split(':')[1] ?? turn.trigger.via).replace('turn-', '')
              : turn.trigger.via.split(':')[0])}` : ''}
          </span>
        )}
        {/* USER turns badge the ADMITTING window (why did this turn run) — EVERY
            admit, tap included: an unbadged row must mean exactly one thing,
            "recorded before provenance existed", never "hidden by the UI"
            (user-reported 2026-07-22: a hidden tap chip read as an unmarked turn).
            followup/busy-drain/grace are the "suddenly it speaks" answers. */}
        {turn.trigger?.kind === 'user' && turn.trigger.via && (
          <span className={`obs-turn-kind trigger-user via-${turn.trigger.via.replace('-window', '')}`} title={admitTitle(turn.trigger)}>
            {turn.trigger.via.replace('-window', '')}
            {turn.trigger.window?.rule === 'started-in-window' ? '·grace' : ''}
          </span>
        )}
        {(turn.trigger?.utteranceId?.startsWith('debug:') || turn.trigger?.via === 'phone:turn-request') && (
          <span className="pill sm" title="programmatic trigger (debug REST API / phone debug broadcast) — no real audio behind this turn"
            style={{ borderColor: 'rgba(255,120,200,0.6)' }}>
            💉 {turn.trigger?.utteranceId?.startsWith('debug:') ? 'debug-api' : 'phone-debug'}
          </span>
        )}
        {turn.trigger?.text && <span className="obs-turn-prompt" title={turn.trigger.text}>“{turn.trigger.text}”</span>}
        <span className={`obs-turn-dur${dur(turn) > 4000 ? ' slow' : ''}`}>{fmtMs(dur(turn))}</span>
        <span className="muted sm">{turn.steps.length} step{turn.steps.length !== 1 ? 's' : ''}</span>
        <UsageChip u={turnUsage(turn)} title="turn total" />
        {turn.steps.flatMap((s) => s.tools).map((tc) => {
          const tag = tagLabel(tc);
          return (
            <span key={tc.id} className={`pill sm ${tc.isError ? 'bad' : tag ? '' : 'acc'}`}
              title={tag ? 'inline tag (applied by the phone at playback) — not an LLM tool call' : 'LLM tool call'}>
              {tag ? `🏷 ${tag}` : `⚙ ${tc.name}`}
            </span>
          );
        })}
        {silentTurnInfo(turn) && <span className="pill sm" title="finished cleanly, chose to say nothing (expand for why)">🤫 silent</span>}
        {err && <span className="dot off" title="error" />}
        {!turn.ended && <span className="dot wait" title="running" />}
        {feedback?.map((f) => (
          <span key={f.id} className="pill acc sm" title={`feedback (${f.source}): ${f.reason ?? ''}`}>💬 {f.reason ?? 'feedback'}</span>
        ))}
        {dock && turn.ended && turn.trigger?.kind !== 'replay' && (
          <span
            role="button"
            tabIndex={0}
            className="pill sm obs-replay"
            title="re-run this turn on the dock — recorded responses through the LIVE pipeline, no LLM calls (speaks + moves for real)"
            onClick={(e) => { void replay(e); }}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { void replay(e); } }}
          >
            ▶ replay
          </span>
        )}
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
      detail: <>{s.model && <span className="pill acc sm">{s.model.split('/').pop()}</span>}{s.stopReason && <span className="muted sm mono">{s.stopReason}</span>}<span className="muted sm">tok {tok(s.inTok)}→{tok(s.outTok)}</span>{s.cacheRead != null && s.cacheRead > 0 && <span className="muted sm" title="input tokens served from prompt cache">⚡ {fmtTok(s.cacheRead)} cached</span>}{(s.thinkTok ?? 0) > 0 && <span className="muted sm" title="thinking tokens (estimated from streamed thoughts; billed inside output)">🧠 ~{fmtTok(s.thinkTok!)}{s.thinkingMs != null ? ` · ${fmtMs(s.thinkingMs)}` : ''}</span>}{s.cost != null && s.cost > 0 && <span className="muted sm mono">{fmtCost(s.cost)}</span>}<RequestPeek sessionId={turn.sessionId} turnId={turn.id} stepIdx={s.idx} cacheRead={s.cacheRead} inputTokens={s.inTok} /></>,
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
      const tag = tagLabel(tc);
      evs.push({
        lane: 'tool', cls: `tool${tc.isError ? ' err' : ''}`,
        label: tag ? `🏷 ${tag} · inline tag` : `⚙ ${tc.name} · tool call`, start: ta, end: tb,
        detail: (
          <details className="obs-ev-tool">
            <summary className="muted sm">
              {tc.isError ? 'error · ' : ''}{tag ? 'applied at playback · ' : ''}params / response
              <span className="obs-ev-peek mono">{inlinePeek(tc.args, tc.result)}</span>
            </summary>
            <div className="obs-kv"><span>params</span><pre>{pretty(tc.args)}</pre></div>
            {tc.result != null && <div className="obs-kv"><span>response</span><pre>{tc.result}</pre></div>}
            {searchShot(tc.result) && (
              <div className="obs-kv"><span>found view</span>
                {/* plain link-out for the big version — no in-page zoom state
                    to get stuck in (user-reported: zoomed in, couldn't zoom out) */}
                <a href={`/api/observability/search-shot?f=${encodeURIComponent(searchShot(tc.result)!)}`}
                  target="_blank" rel="noreferrer" title="open full size in a new tab">
                  <img src={`/api/observability/search-shot?f=${encodeURIComponent(searchShot(tc.result)!)}`}
                    alt="what visual_search saw at the find"
                    style={{ maxWidth: 320, borderRadius: 6, display: 'block', cursor: 'zoom-in' }} />
                </a>
              </div>
            )}
            {tc.name === 'visual_search' && (
              <SearchShotStrip dock={turn.source ?? ''}
                from={tc.startedAt ?? turn.startedAt}
                to={tc.endedAt ?? (tc.startedAt ?? turn.startedAt) + 60_000} />
            )}
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
          <span className="obs-msg-who" title={kindTitle(turn.trigger)}>{turn.trigger.kind}</span>
          {/* the raising source, in full (e.g. mood:curious.wonder, gate:arrival:guru) */}
          {turn.trigger.via && <span className="obs-msg-via mono" title={admitTitle(turn.trigger)}>{turn.trigger.via}</span>}
          {turn.trigger.text && <span className="obs-msg-text obs-copytext" title="double-click a word to select · click ⧉ to copy all">{turn.trigger.text}<CopyIco value={turn.trigger.text} /></span>}
        </div>
      )}
      {(() => {
        const si = silentTurnInfo(turn);
        if (!si) return null;
        return (
          <div className="obs-msg" style={{ opacity: 0.9 }}>
            <span className="obs-msg-who" title="the model completed this turn cleanly and deliberately produced no speech">🤫 silent</span>
            <span className="muted sm">
              model finished cleanly (no errors) and returned no speech
              {si.tags ? <> — output was only <span className="mono">{si.tags.slice(0, 80)}</span></> : ' — empty output'}
              {si.reason && <>. Likely why: {si.reason}.</>}
            </span>
          </div>
        );
      })()}
      {/* STT EVIDENCE for a heard turn: the actual audio the transcript came
          from (utteranceId suffix = the clip WAV key) + the engine's own
          confidence — so "what did it really hear, and how sure was it" is
          answered in place, next to the text it produced. */}
      {(() => {
        const uid = turn.trigger?.utteranceId;
        const m = uid && !uid.startsWith('debug:') ? uid.match(/:(\d{13})$/) : null;
        const clipUrl = m && turn.source
          ? `/api/perception/utterance-audio/${encodeURIComponent(turn.source)}/${m[1]}` : null;
        const stt = turn.stt;
        if (!clipUrl && !stt) return null;
        return (
          <div className="obs-msg trigger-user obs-sttev" style={{ alignItems: 'center', flexWrap: 'wrap' }}>
            <span className="obs-msg-who" title="the audio + STT evidence behind the trigger text, and the admit verdict that let it run">🎙 heard</span>
            {clipUrl && <audio controls preload="none" src={clipUrl} style={{ height: 26, maxWidth: 240 }} />}
            {stt?.confTier && (
              <span className={`pill sm${stt.confTier === 'garbage' ? ' bad' : stt.confTier === 'shaky' ? '' : ' acc'}`}
                title="the STT engine's own confidence tier (good / shaky / garbage)">{stt.confTier}</span>
            )}
            {stt?.avgLogprob != null && <span className="muted sm mono" title="mean token log-prob (whisper only; very negative = unsure)">logprob {stt.avgLogprob.toFixed(2)}</span>}
            {stt?.noSpeechProb != null && <span className="muted sm mono" title="P(silence/noise) — high = likely hallucination">noSpeech {stt.noSpeechProb.toFixed(2)}</span>}
            {stt?.compressionRatio != null && <span className="muted sm mono" title="gzip ratio — high = repetition loop">compr {stt.compressionRatio.toFixed(2)}</span>}
            {stt?.voice && (
              <span className="pill sm" title={`voice fingerprint: best enrolled match${stt.voice.score != null ? ` (score ${stt.voice.score.toFixed(2)})` : ''}${stt.voice.match ? '' : ' — below the match bar'}`}>
                👤 {stt.voice.name}{stt.voice.match ? '' : '?'}
              </span>
            )}
            {/* the admit verdict rides HERE when there's a heard row to host it —
                one evidence line ("what it heard + why that ran") instead of two. */}
            {turn.trigger?.window && (
              <span className="obs-msg-via mono" style={{ opacity: 0.8 }} title={admitTitle(turn.trigger)}>
                · admitted: {admitSummary(turn.trigger.window)}
              </span>
            )}
          </div>
        );
      })()}
      {/* admit provenance — the full WHY for an addressed user turn: which rule +
          which window let the utterance in, how that window opened, time left. */}
      {turn.trigger?.window && !hasHeardRow(turn) && (
        <div className="obs-msg trigger-user" style={{ opacity: 0.85 }}>
          <span className="obs-msg-who" title="ConversationState admit verdict — why this utterance became a turn">admitted</span>
          {/* the compact verdict, with the full plain-language explanation on hover */}
          <span className="obs-msg-via mono" title={admitTitle(turn.trigger)}>
            {admitSummary(turn.trigger.window)}
          </span>
        </div>
      )}
      {/* the EXACT input frame this turn's model saw (vision turns) — request
          ring strips image bytes, so this dump is the only visual evidence. */}
      {turn.image && (
        <div className="obs-msg" style={{ alignItems: 'flex-start' }}>
          <span className="obs-msg-who" title="the input frame attached to this turn's LLM request">📷 saw</span>
          <a href={`/api/observability/turn-image?f=${encodeURIComponent(turn.image)}`} target="_blank" rel="noreferrer">
            <img src={`/api/observability/turn-image?f=${encodeURIComponent(turn.image)}`}
              alt="turn input frame" style={{ maxHeight: 120, borderRadius: 4 }} />
          </a>
        </div>
      )}
      <ConvContext turn={turn} />
      <div className="obs-vaxis">{clockMs(turn.startedAt)} → +{fmtMs(total)} · {evs.length} events</div>
      <div className="obs-vt">
        {evs.map((ev, i) => {
          const leftPct = (ev.start / total) * 100;
          const widPct = Math.max(1.5, ((ev.end - ev.start) / total) * 100);
          return (
            <div key={i} className={`obs-ev lane-${ev.lane}`}>
              <span className="obs-ev-when mono"
                title={`${clockMs(turn.startedAt + ev.start)} → ${clockMs(turn.startedAt + ev.end)} (wall clock)`}>
                {ev.end > ev.start ? `@${fmtMs(ev.start)}→${fmtMs(ev.end)}` : `@${fmtMs(ev.start)}`}
              </span>
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
function fmtTok(n: number): string { return n >= 10_000 ? `${Math.round(n / 1000)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n); }
function fmtCost(c: number): string { return c >= 0.1 ? `$${c.toFixed(2)}` : c >= 0.001 ? `$${c.toFixed(3)}` : c > 0 ? `$${c.toFixed(4)}` : '$0'; }

/** Sum usage across a turn's steps (steps without usage = no LLM call → skipped). */
interface UsageAgg { inTok: number; outTok: number; cacheRead: number; cost: number; thinkTok: number; calls: number }
function turnUsage(t: TurnVM): UsageAgg {
  const u: UsageAgg = { inTok: 0, outTok: 0, cacheRead: 0, cost: 0, thinkTok: 0, calls: 0 };
  for (const s of t.steps) {
    if (s.inTok == null && s.outTok == null && s.cost == null) continue;
    u.inTok += s.inTok ?? 0; u.outTok += s.outTok ?? 0;
    u.cacheRead += s.cacheRead ?? 0; u.cost += s.cost ?? 0;
    u.thinkTok += s.thinkTok ?? 0; u.calls += 1;
  }
  return u;
}
function sumUsage(turns: TurnVM[]): UsageAgg {
  return turns.map(turnUsage).reduce((a, b) => ({
    inTok: a.inTok + b.inTok, outTok: a.outTok + b.outTok,
    cacheRead: a.cacheRead + b.cacheRead, cost: a.cost + b.cost,
    thinkTok: a.thinkTok + b.thinkTok, calls: a.calls + b.calls,
  }), { inTok: 0, outTok: 0, cacheRead: 0, cost: 0, thinkTok: 0, calls: 0 });
}

/** Compact `tokens · cache% · cost` chip used on turn + session headers. */
function UsageChip({ u, title }: { u: UsageAgg; title: string }) {
  if (u.calls === 0) return null;
  // fresh = inTok minus cached when inTok includes it; when the provider reports
  // inTok EXCLUDING cached (Gemini on a hit: 908 in + 24.5k cached), inTok IS the
  // fresh part — without this, the chip showed 2705%.
  const cacheFresh = u.inTok > u.cacheRead ? u.inTok - u.cacheRead : u.inTok;
  const cachePct = u.cacheRead > 0 ? Math.round((u.cacheRead / (u.cacheRead + cacheFresh)) * 100) : 0;
  return (
    <span className="muted sm mono" title={`${title}: ${u.inTok.toLocaleString()} in → ${u.outTok.toLocaleString()} out · ${u.cacheRead.toLocaleString()} cached · ~${u.thinkTok.toLocaleString()} thinking (est, billed inside out) · ${u.calls} LLM call${u.calls !== 1 ? 's' : ''}`}>
      {fmtTok(u.inTok)}→{fmtTok(u.outTok)}
      {cachePct > 0 && <span title={`${u.cacheRead.toLocaleString()} input tokens served from prompt cache`}> ⚡{cachePct}%</span>}
      {u.thinkTok > 0 && <span title={`~${u.thinkTok.toLocaleString()} thinking tokens (estimated from streamed thoughts; billed inside output)`}> 🧠~{fmtTok(u.thinkTok)}</span>}
      {u.cost > 0 && <> · {fmtCost(u.cost)}</>}
    </span>
  );
}
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

// ── trigger glossary — plain-language tooltips for every chip/badge ──────────
// "Why did this turn run" must be readable without remembering the vocabulary:
// each chip's title explains EXACTLY what its value means (user request
// 2026-07-22 — "I will keep forgetting what they mean").

/** trigger.kind — WHO/WHAT raised the turn. */
const KIND_EXPLAIN: Record<string, string> = {
  user: 'A person spoke (or typed) and the utterance was admitted as addressed to the dock.',
  self: "The dock's OWN impulse — nobody spoke. An internal raiser (perception gate / idle mood / console poke) started this turn; the via names it.",
  task: 'A background task (separate OS process) reported back and raised this turn to speak its result.',
  replay: 'A re-run of a recorded turn through the LIVE pipeline — no LLM calls; via = source session:turn.',
};

/** trigger.via — the ADMITTING window (user turns) or the raising source (self/task). */
const VIA_EXPLAIN: Record<string, string> = {
  'tap-window': 'Admitted by a listening window opened DELIBERATELY by a screen tap. The most intentional path: tap → listen → your words ran.',
  'palm-window': 'Admitted by a listening window opened by the open-palm WAVE gesture (open-only: a palm never closes a window).',
  'face-window': 'Admitted by the low-priority window that opens when a face ARRIVES in view (wake-on-look). Yields to tap/followup windows.',
  'followup-window': "Admitted by the AUTO re-listen window that opens after the dock's own reply — NOT a deliberate signal. Anything audible in the room (a TV, a video, other people) can land here, so the brain frames it possibly-overheard and may stay silent, which ends the chain.",
  'busy-drain': 'Heard WHILE the dock was thinking/speaking → queued in the busy-queue → run as one combined turn when the reply settled. Possibly-overheard framing (you may not have been talking to it).',
  'wake+command': 'The wake phrase + a command in ONE breath ("hey orbit, look right"): the name was stripped, the remainder ran as the turn.',
  'phone:turn-request': 'The PHONE originated this turn itself (debug console / adb SAY / typed input) — no station window decision was involved.',
};

/** via PREFIXES for self/task raisers (via = "<prefix>:<detail>"). */
const VIA_PREFIX_EXPLAIN: Record<string, string> = {
  gate: 'Raised by the perception gate-watcher: an auto self-thought reacting to what the dock is perceiving (arrival, a change, idle-loneliness…). Detail = the gate rule that fired.',
  mood: 'Raised by the idle-moods conductor (a mood bit acted out). Detail = the mood/bit id.',
  console: 'Poked manually from the web console (Brain view). Detail = the poke kind.',
  greet: 'The greet-on-arrival raiser: a known face arrived while idle.',
};

/** AdmitTrace.rule — WHICH state-machine rule admitted the utterance. */
const RULE_EXPLAIN: Record<string, string> = {
  'window-open': 'A listening/followup window was OPEN when the final transcript landed — the straightforward admit.',
  'started-in-window': 'GRACE rescue: the window had already closed when the transcript arrived, but the utterance BEGAN while it was open (STT adds a ~1.3s silence tail before finalizing). Without this rule, long/late-finalized speech would be dropped as overheard.',
};

/** AdmitTrace.openedBy — WHAT opened the admitting window. */
const OPENER_EXPLAIN: Record<string, string> = {
  tap: 'a deliberate screen tap while idle',
  'tap-interrupt': 'a tap DURING a reply — interrupted it and opened a fresh window',
  'palm-address': 'the open-palm wave gesture',
  'palm-interrupt': 'a palm shown DURING a reply — interrupted it and opened a window',
  'reply-followup': "the dock's own reply ending (auto re-listen so you can follow up hands-free)",
  'speak-timeout': 'the lost-tts-end recovery: the phone never reported speech ended, the safety cap opened the followup window instead',
  'face-arrival': 'a face arriving in camera view',
};

/** Multi-line tooltip for a trigger chip: what the via means + which rule/window/
 *  opener admitted it + time left. Newlines render in the native title tooltip. */
function admitTitle(tr: TriggerVM): string {
  const lines: string[] = [];
  if (tr.via) {
    const prefix = tr.via.split(':')[0]!;
    lines.push(VIA_EXPLAIN[tr.via] ?? VIA_PREFIX_EXPLAIN[prefix] ?? `raised via ${tr.via}`);
  }
  const w = tr.window;
  if (w) {
    if (w.rule) lines.push(`rule ${w.rule}: ${RULE_EXPLAIN[w.rule] ?? w.rule}`);
    if (w.openedBy) lines.push(`window opened by: ${OPENER_EXPLAIN[w.openedBy] ?? w.openedBy}`);
    if (w.msToExpiry != null) {
      lines.push(w.msToExpiry <= 0
        ? 'window already EXPIRED at admit (grace path let it through)'
        : `${fmtMs(w.msToExpiry)} of the window left at admit`);
    }
  }
  return lines.join('\n');
}

/** Tooltip for the kind badge (self/task/replay + user): what the kind means,
 *  plus the raiser explanation when via is present. */
function kindTitle(tr: TriggerVM): string {
  const lines: string[] = [];
  lines.push(KIND_EXPLAIN[tr.kind] ?? `trigger kind: ${tr.kind}`);
  if (tr.via) {
    const prefix = tr.via.split(':')[0]!;
    const via = VIA_EXPLAIN[tr.via] ?? VIA_PREFIX_EXPLAIN[prefix];
    lines.push(via ? `via ${tr.via}: ${via}` : `via: ${tr.via}`);
  }
  return lines.join('\n');
}

/** The ±30s of conversation-pipeline events AROUND a turn (conv_events): what
 *  was heard/dropped before it, the window that admitted it, barge/stop events
 *  during its TTS. Fetched lazily when the turn expands — the cross-component
 *  timeline coming to the turn view instead of being a separate destination. */
function ConvContext({ turn }: { turn: TurnVM }) {
  const [events, setEvents] = useState<ConvEvent[] | null>(null);
  useEffect(() => {
    const from = turn.startedAt - 30_000;
    const to = (turn.endedAt ?? turn.startedAt) + 30_000;
    const q = new URLSearchParams({ from: String(from), to: String(to) });
    if (turn.source) q.set('dock', turn.source);
    fetch(`/api/observability/conv-events?${q}`)
      .then((r) => r.json())
      .then((j: { events: ConvEvent[] }) => setEvents(j.events ?? []))
      .catch(() => setEvents([]));
  }, [turn.id, turn.sessionId]);
  if (events == null) return <div className="muted sm">loading conversation context…</div>;
  if (events.length === 0) return null;
  const uid = turn.trigger?.utteranceId;
  return (
    <details className="obs-convctx">
      <summary className="muted sm">
        🧵 conversation context — {events.length} pipeline events ±30s around this turn
        {turn.source && (
          <a style={{ marginLeft: 8 }} href={`#timeline?dock=${encodeURIComponent(turn.source)}&t=${turn.startedAt}`}
            title="open the full cross-component timeline around this moment">full timeline →</a>
        )}
      </summary>
      {events.map((ev) => (
        <div key={ev.id} className={`tl-line${uid && ev.utteranceId === uid ? ' tl-inturn' : ''}`}
          title={uid && ev.utteranceId === uid ? 'THIS turn\u2019s own utterance' : undefined}>
          <span className="tl-time mono">{fmtT(ev.ts)}</span>
          <span className={`tl-lanebadge mono lb-${ev.lane}`}>{ev.lane}</span>
          <EventChip ev={ev} />
        </div>
      ))}
    </details>
  );
}

/** A turn that finished CLEANLY but spoke nothing — the model chose silence.
 *  Distinct from failed/cancelled: without this, "done, 0 words" reads as a
 *  mystery ("why didn't it respond?"), when the trace shows a healthy LLM call
 *  that returned only face/move tags. Reason derived when the framing explains
 *  it (possibly-overheard windows + shaky STT); else just the clean-finish fact. */
function silentTurnInfo(turn: TurnVM): { tags: string; reason?: string } | null {
  if (!turn.ended || turn.steps.length === 0) return null;
  const failed = turn.steps.some((st) => st.stopReason === 'error' || st.tools.some((tc) => tc.isError));
  if (failed) return null; // real errors render their own path
  if (turn.steps.some((st) => (st.text ?? '').trim().length > 0)) return null;
  const raw = turn.steps.map((st) => st.rawText ?? '').join(' ').trim();
  const overheard = turn.trigger?.via === 'followup-window' || turn.trigger?.via === 'busy-drain';
  const shaky = turn.stt?.confTier && turn.stt.confTier !== 'good';
  const reason = overheard && shaky
    ? `possibly-overheard framing (${turn.trigger?.via}) + ${turn.stt?.confTier} transcript — the prompt says to stay silent unless clearly addressed`
    : overheard ? `possibly-overheard framing (${turn.trigger?.via}) — the prompt says to stay silent unless clearly addressed`
    : shaky ? `${turn.stt?.confTier} transcript` : undefined;
  return { tags: raw, reason };
}

/** Compact one-line admit verdict (full plain-language version is the hover). */
function admitSummary(w: NonNullable<TriggerVM['window']>): string {
  return [w.rule, w.windowSrc && `${w.windowSrc} window`,
    w.openedBy && `opened by ${w.openedBy}`,
    w.msToExpiry != null && (w.msToExpiry <= 0 ? 'expired at admit' : `${fmtMs(w.msToExpiry)} left`),
  ].filter(Boolean).join(' · ');
}

/** True when the 🎙 heard evidence row renders — it hosts the admit verdict, so
 *  the standalone "admitted" row would be a duplicate second line. */
function hasHeardRow(turn: TurnVM): boolean {
  const uid = turn.trigger?.utteranceId;
  const hasClip = !!uid && !uid.startsWith('debug:') && /:(\d{13})$/.test(uid) && !!turn.source;
  return hasClip || !!turn.stt;
}

function storedToVM(t: StoredTurn, source?: string): TurnVM {
  return {
    id: t.turnId, sessionId: t.sessionId, source, trigger: t.trigger, startedAt: t.startedAt, endedAt: t.endedAt, ended: t.endedAt != null, image: t.image, stt: t.stt,
    speech: t.speech ?? [],
    steps: t.steps.map((s) => ({
      idx: s.index, model: s.model, stopReason: s.stopReason, text: s.text, rawText: s.rawText,
      inTok: s.usage?.inputTokens, outTok: s.usage?.outputTokens, cacheRead: s.usage?.cacheRead, cost: s.usage?.cost, thinkTok: s.usage?.thinkingTokens, thinkingMs: s.thinkingMs, startedAt: s.startedAt, streamStartedAt: s.streamStartedAt, endedAt: s.endedAt,
      tools: s.tools.map((tc) => ({ id: tc.toolCallId, name: tc.toolName, args: tc.args, result: tc.result, isError: tc.isError, startedAt: tc.startedAt, endedAt: tc.endedAt })),
    })),
  };
}

function applyEvent(turn: TurnVM, ev: AgentEventDto): void {
  const last = turn.steps[turn.steps.length - 1];
  switch (ev.kind) {
    case 'TurnStart':
      if (ev.data?.trigger != null) turn.trigger = ev.data.trigger as TriggerVM;
      if (typeof ev.data?.image === 'string') turn.image = ev.data.image;
      if (ev.data?.stt != null) turn.stt = ev.data.stt as SttVM;
      break;
    case 'TurnEnd': turn.ended = true; turn.endedAt = ev.ts; break;
    case 'StepStart': turn.steps.push({ idx: turn.steps.length, tools: [], startedAt: ev.ts }); break;
    case 'StepEnd':
      if (last) {
        last.endedAt = ev.ts; last.model = ev.data?.model; last.stopReason = ev.data?.stopReason;
        last.inTok = ev.data?.usage?.inputTokens; last.outTok = ev.data?.usage?.outputTokens;
        last.cacheRead = ev.data?.usage?.cacheRead; last.cost = ev.data?.usage?.cost;
        last.thinkTok = ev.data?.usage?.thinkingTokens; last.thinkingMs = ev.data?.thinkingMs;
      }
      break;
    case 'MessageUpdate': if (last && last.streamStartedAt == null) last.streamStartedAt = ev.ts; break;
    case 'MessageEnd':
      if (last && ev.data?.text != null) last.text = ev.data.text;
      if (last && typeof ev.data?.rawText === 'string') last.rawText = ev.data.rawText;
      break;
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

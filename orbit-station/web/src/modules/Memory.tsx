import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../lib/station';
import { useDocks, useNow, relTime } from '../lib/useDocks';

/**
 * Memory — the dock's persistent, per-dock store (docs/memory.md). A clean,
 * full-page console over the perception memory REST surface
 * (/api/perception/memory*): browse + semantic search, filter by type/subject,
 * peek the supersede history, inspect a memory's lineage ("why do I believe
 * this"), and curate (add / revise / forget). Read-only-by-default layout — the
 * add/revise forms appear on demand so the default view stays uncluttered.
 *
 * The Brain view keeps its own slim inline inspector for in-context peeks; this
 * is the standalone home that exercises the whole capability set.
 */

type MemoryType = 'person' | 'summary' | 'event' | 'preference' | 'fact' | 'place';
type Derivation = 'observed' | 'derived';
type MemoryStatus = 'active' | 'revised' | 'forgotten';
const TYPES: MemoryType[] = ['person', 'summary', 'event', 'preference', 'fact', 'place'];

interface MemoryRow {
  id: string; type: MemoryType; subject: string; claim: string; confidence: number;
  derivation: Derivation; status: MemoryStatus; createdAt: number;
  validFrom: number; validTo: number | null; supersedes: string | null;
}
interface MemoryView { count: number; subjects: string[]; memories: MemoryRow[] }
interface LineageEdge { sourceKind: string; sourceId: string }
interface MemoryDetail { memory: MemoryRow; lineage: LineageEdge[] }

/** Which theme accent each type pill leans on — low-saturation, just enough to scan by kind. */
const TYPE_TONE: Record<MemoryType, string> = {
  person: 'var(--accent-2)', preference: 'var(--good)', fact: 'var(--accent)',
  event: 'var(--warn)', place: 'var(--accent)', summary: 'var(--dim)',
};

export function Memory() {
  const docks = useDocks();
  const now = useNow(15000);

  const [dock, setDock] = useState('');
  const [data, setData] = useState<MemoryView | null>(null);
  const [sel, setSel] = useState<MemoryDetail | null>(null);

  // filters
  const [query, setQuery] = useState('');
  const [typeFilter, setTypeFilter] = useState<MemoryType | ''>('');
  const [subjectFilter, setSubjectFilter] = useState('');
  const [includeInactive, setIncludeInactive] = useState(false);

  // add / revise drafts (each opens on demand)
  const [adding, setAdding] = useState(false);
  const [add, setAdd] = useState<{ claim: string; type: MemoryType; subject: string; confidence: string }>(
    { claim: '', type: 'fact', subject: '', confidence: '' });
  const [editing, setEditing] = useState(false);
  const [edit, setEdit] = useState<{ claim: string; subject: string; confidence: string }>(
    { claim: '', subject: '', confidence: '' });

  // pick a default dock once the directory loads
  useEffect(() => {
    if (!dock && docks.length) setDock(docks[0]!.name);
  }, [docks, dock]);

  const load = useCallback(async (d = dock, q = query) => {
    if (!d) return;
    const u = new URL('/api/perception/memory', location.origin);
    u.searchParams.set('dock', d);
    if (q.trim()) u.searchParams.set('query', q.trim());
    if (typeFilter) u.searchParams.set('type', typeFilter);
    if (subjectFilter) u.searchParams.set('subject', subjectFilter);
    if (includeInactive) u.searchParams.set('inactive', '1');
    try {
      const r = await fetch(u.toString());
      if (r.ok) setData(await r.json() as MemoryView);
    } catch { /* station down */ }
  }, [dock, query, typeFilter, subjectFilter, includeInactive]);

  // reload whenever the dock or any filter changes; clear the selection on dock switch
  useEffect(() => { void load(); }, [load]);
  useEffect(() => { setSel(null); }, [dock]);

  const inspect = async (id: string) => {
    setEditing(false);
    try {
      const r = await fetch(`/api/perception/memory/item/${encodeURIComponent(id)}`);
      if (r.ok) setSel(await r.json() as MemoryDetail);
    } catch { /* ignore */ }
  };

  const submitAdd = async () => {
    if (!add.claim.trim() || !dock) return;
    await api.post('/perception/memory', {
      dock, claim: add.claim.trim(), type: add.type,
      subject: add.subject.trim() || undefined,
      confidence: add.confidence ? Number(add.confidence) : undefined,
    });
    setAdd({ claim: '', type: 'fact', subject: '', confidence: '' });
    setAdding(false);
    void load();
  };

  const submitEdit = async () => {
    if (!sel) return;
    const patch: Record<string, unknown> = {};
    if (edit.claim.trim() && edit.claim.trim() !== sel.memory.claim) patch.claim = edit.claim.trim();
    if (edit.subject.trim() !== sel.memory.subject) patch.subject = edit.subject.trim();
    if (edit.confidence) patch.confidence = Number(edit.confidence);
    const r = await api.patch<{ ok: boolean; id: string | null }>(
      `/perception/memory/item/${encodeURIComponent(sel.memory.id)}`, patch);
    setEditing(false);
    await load();
    if (r.id) void inspect(r.id); else setSel(null);
  };

  const forget = async (id: string) => {
    await api.del(`/perception/memory/item/${encodeURIComponent(id)}`);
    setSel(null);
    void load();
  };

  const startEdit = () => {
    if (!sel) return;
    setEdit({ claim: sel.memory.claim, subject: sel.memory.subject, confidence: String(sel.memory.confidence) });
    setEditing(true);
  };

  const rows = data?.memories ?? [];
  const subjects = useMemo(() => data?.subjects ?? [], [data]);

  return (
    <section className="mem">
      <style>{CSS}</style>

      <header className="mem-head">
        <div>
          <h2 className="title">Memory</h2>
          <p className="subtitle">The dock's persistent, per-dock store — what it remembers across sessions.</p>
        </div>
        <label className="mem-dockpick">
          <span>dock</span>
          <select value={dock} onChange={(e) => setDock(e.target.value)}>
            {docks.length === 0 && <option value="">no docks</option>}
            {docks.map((d) => <option key={d.name} value={d.name}>{d.name}</option>)}
          </select>
        </label>
      </header>

      {/* search + filters — calm single row; controls reveal on demand */}
      <div className="mem-bar">
        <input className="mem-search" value={query}
          placeholder="semantic search — e.g. “what do I know about guru”"
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') void load(dock, query); }} />
        {query && <button className="mem-ghost" onClick={() => { setQuery(''); void load(dock, ''); }}>clear</button>}
        <button className="mem-add-btn" onClick={() => setAdding((v) => !v)}>{adding ? '×' : '+ remember'}</button>
      </div>

      <div className="mem-chips">
        <button className={`mem-chip ${!typeFilter ? 'on' : ''}`} onClick={() => setTypeFilter('')}>all</button>
        {TYPES.map((t) => (
          <button key={t} className={`mem-chip ${typeFilter === t ? 'on' : ''}`}
            style={typeFilter === t ? { color: TYPE_TONE[t], borderColor: TYPE_TONE[t] } : undefined}
            onClick={() => setTypeFilter((p) => (p === t ? '' : t))}>{t}</button>
        ))}
        <span className="mem-chip-sep" />
        <button className={`mem-chip ${includeInactive ? 'on' : ''}`} onClick={() => setIncludeInactive((v) => !v)}>
          history
        </button>
      </div>

      {subjects.length > 0 && (
        <div className="mem-subjects">
          <span className="mem-subjects-label">about</span>
          {subjects.map((s) => (
            <button key={s} className={`mem-subj ${subjectFilter === s ? 'on' : ''}`}
              onClick={() => setSubjectFilter((p) => (p === s ? '' : s))}>{s}</button>
          ))}
        </div>
      )}

      {/* add form — appears only when invoked */}
      {adding && (
        <div className="mem-form">
          <input className="mem-form-claim" autoFocus placeholder="the belief — e.g. “prefers tea”"
            value={add.claim} onChange={(e) => setAdd({ ...add, claim: e.target.value })}
            onKeyDown={(e) => { if (e.key === 'Enter') void submitAdd(); }} />
          <select value={add.type} onChange={(e) => setAdd({ ...add, type: e.target.value as MemoryType })}>
            {TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
          <input className="mem-form-sm" placeholder="subject" value={add.subject}
            onChange={(e) => setAdd({ ...add, subject: e.target.value })} />
          <input className="mem-form-sm" placeholder="conf" value={add.confidence} inputMode="decimal"
            onChange={(e) => setAdd({ ...add, confidence: e.target.value })} />
          <button className="primary" disabled={!add.claim.trim()} onClick={() => void submitAdd()}>remember</button>
        </div>
      )}

      <div className="mem-body">
        {/* the list */}
        <div className="mem-list">
          <div className="mem-list-count">{data?.count ?? 0} memories{includeInactive ? ' · incl. history' : ''}</div>
          {rows.length === 0
            ? <div className="empty">{dock ? 'nothing here yet' : 'pick a dock'}</div>
            : rows.map((m) => (
              <button key={m.id} className={`mem-row ${sel?.memory.id === m.id ? 'sel' : ''} st-${m.status}`}
                onClick={() => void inspect(m.id)}>
                <span className="mem-pill" style={{ color: TYPE_TONE[m.type], borderColor: TYPE_TONE[m.type] }}>{m.type}</span>
                <span className="mem-claim">{m.claim}</span>
                {m.subject && <span className="mem-subj-tag">{m.subject}</span>}
                {m.status !== 'active' && <span className={`mem-status ${m.status}`}>{m.status}</span>}
                <span className="mem-conf" title={`confidence ${m.confidence.toFixed(2)}`}>
                  <span className="mem-conf-bar" style={{ width: `${Math.round(m.confidence * 100)}%` }} />
                </span>
              </button>
            ))}
        </div>

        {/* the detail / lineage pane */}
        {sel ? (
          <aside className="mem-detail">
            <div className="mem-detail-top">
              <span className="mem-detail-eyebrow">why I believe this</span>
              <div className="mem-detail-actions">
                {sel.memory.status === 'active' && <button className="mini" onClick={startEdit}>✎ revise</button>}
                <button className="mini ghost" onClick={() => setSel(null)}>×</button>
              </div>
            </div>

            <blockquote className="mem-quote">“{sel.memory.claim}”</blockquote>

            <dl className="mem-kv">
              <dt>type</dt><dd>{sel.memory.type}{sel.memory.subject ? ` · ${sel.memory.subject}` : ''}</dd>
              <dt>confidence</dt><dd>{sel.memory.confidence.toFixed(2)} · {sel.memory.derivation}</dd>
              <dt>status</dt><dd className={`st-${sel.memory.status}`}>{sel.memory.status}</dd>
              <dt>when</dt><dd>{relTime(sel.memory.createdAt, now)} · {new Date(sel.memory.createdAt).toLocaleString()}</dd>
              {sel.memory.validTo && <><dt>valid to</dt><dd>{new Date(sel.memory.validTo).toLocaleString()}</dd></>}
              {sel.memory.supersedes && (
                <><dt>supersedes</dt>
                  <dd><button className="mem-link mono" onClick={() => void inspect(sel.memory.supersedes!)}>
                    {sel.memory.supersedes.slice(0, 8)}…</button></dd></>
              )}
            </dl>

            <div className="mem-detail-eyebrow">lineage</div>
            {sel.lineage.length === 0
              ? <div className="dim mem-lin-empty">told / inferred directly — no recorded source</div>
              : <ul className="mem-lin">{sel.lineage.map((e, i) =>
                  <li key={i} className="mono">{e.sourceKind}<span className="dim">:</span>{e.sourceId}</li>)}</ul>}

            {editing && (
              <div className="mem-edit">
                <textarea className="mem-edit-claim" value={edit.claim}
                  onChange={(e) => setEdit({ ...edit, claim: e.target.value })} />
                <div className="row">
                  <input className="mem-form-sm" placeholder="subject" value={edit.subject}
                    onChange={(e) => setEdit({ ...edit, subject: e.target.value })} />
                  <input className="mem-form-sm" placeholder="conf" value={edit.confidence} inputMode="decimal"
                    onChange={(e) => setEdit({ ...edit, confidence: e.target.value })} />
                  <button className="primary" onClick={() => void submitEdit()}>save (supersede)</button>
                  <button className="mini ghost" onClick={() => setEditing(false)}>cancel</button>
                </div>
              </div>
            )}

            {sel.memory.status === 'active' && !editing && (
              <button className="mem-forget" onClick={() => void forget(sel.memory.id)}>forget this</button>
            )}
          </aside>
        ) : (
          <aside className="mem-detail mem-detail-empty">
            <div className="dim">select a memory to see its lineage</div>
          </aside>
        )}
      </div>
    </section>
  );
}

const CSS = `
.mem-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; }
.mem-dockpick { display: flex; flex-direction: column; gap: 4px; font-size: 10px; color: var(--dim);
  text-transform: uppercase; letter-spacing: .1em; }
.mem-dockpick select { min-width: 160px; }

.mem-bar { display: flex; gap: 8px; align-items: center; margin: 6px 0 12px; }
.mem-search { flex: 1; }
.mem-ghost { background: transparent; }
.mem-add-btn { background: var(--panel-2); white-space: nowrap; }

.mem-chips { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; margin-bottom: 10px; }
.mem-chip { font-size: 12px; padding: 3px 11px; border-radius: 20px; color: var(--dim);
  background: transparent; border: 1px solid var(--line); cursor: pointer; transition: color .15s, border-color .15s; }
.mem-chip:hover { color: var(--fg); box-shadow: none; }
.mem-chip.on { color: var(--fg); border-color: var(--accent); background: #5db8ff10; box-shadow: none; }
.mem-chip-sep { flex: 1; }

.mem-subjects { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; margin-bottom: 14px; }
.mem-subjects-label { font-size: 10px; color: var(--dim); text-transform: uppercase; letter-spacing: .1em; }
.mem-subj { font-size: 11px; padding: 2px 9px; border-radius: 20px; color: var(--accent-2);
  background: transparent; border: 1px solid #8f7bff33; cursor: pointer; }
.mem-subj.on { background: #8f7bff1c; box-shadow: none; }

.mem-form { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin-bottom: 14px;
  padding: 12px; border: 1px solid var(--line); border-radius: var(--radius); background: var(--bg-2); }
.mem-form-claim { flex: 1; min-width: 220px; }
.mem-form-sm { width: 92px; }

.mem-body { display: grid; grid-template-columns: 1fr 340px; gap: 16px; align-items: start; }
@media (max-width: 860px) { .mem-body { grid-template-columns: 1fr; } }

.mem-list { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.mem-list-count { font-size: 10px; color: var(--dim); text-transform: uppercase; letter-spacing: .1em; margin-bottom: 2px; }
.mem-row { display: flex; align-items: center; gap: 10px; width: 100%; text-align: left;
  padding: 11px 14px; border: 1px solid var(--line); border-left: 3px solid transparent;
  border-radius: var(--radius); background: linear-gradient(180deg, var(--panel), var(--bg-2));
  cursor: pointer; transition: transform .12s, border-color .12s, box-shadow .12s; }
.mem-row:hover { transform: translateY(-1px); border-color: #5db8ff44; box-shadow: var(--glow); }
.mem-row.sel { border-left-color: var(--accent); background: var(--panel-2); box-shadow: none; }
.mem-row.st-forgotten, .mem-row.st-revised { opacity: .55; }

.mem-pill { flex: none; font-size: 10px; padding: 1px 8px; border-radius: 20px; border: 1px solid var(--line); }
.mem-claim { flex: 1; min-width: 0; color: var(--fg); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mem-subj-tag { flex: none; font-size: 11px; color: var(--accent-2); }
.mem-status { flex: none; font-size: 9px; text-transform: uppercase; letter-spacing: .06em; }
.mem-status.revised { color: var(--warn); }
.mem-status.forgotten { color: var(--bad); }
.mem-conf { flex: none; width: 40px; height: 4px; border-radius: 3px; background: #ffffff10; overflow: hidden; }
.mem-conf-bar { display: block; height: 100%; background: var(--accent); border-radius: 3px; }

.mem-detail { position: sticky; top: 0; border: 1px solid var(--line); border-radius: var(--radius);
  background: linear-gradient(180deg, var(--panel), var(--bg-2)); padding: 16px 18px; display: flex;
  flex-direction: column; gap: 10px; }
.mem-detail-empty { align-items: center; justify-content: center; min-height: 120px; text-align: center; }
.mem-detail-top { display: flex; align-items: center; justify-content: space-between; }
.mem-detail-actions { display: flex; gap: 6px; }
.mem-detail-eyebrow { font-size: 10px; color: var(--dim); text-transform: uppercase; letter-spacing: .12em; }
.mem-quote { margin: 0; font-size: 16px; line-height: 1.5; color: var(--fg); font-weight: 500; }

.mem-kv { display: grid; grid-template-columns: 78px 1fr; gap: 4px 10px; margin: 0; font-size: 12px; }
.mem-kv dt { color: var(--dim); }
.mem-kv dd { margin: 0; color: var(--fg); }
.mem-kv dd.st-revised { color: var(--warn); }
.mem-kv dd.st-forgotten { color: var(--bad); }
.mem-link { background: none; border: none; padding: 0; color: var(--accent); cursor: pointer; text-decoration: underline; }

.mem-lin { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; }
.mem-lin li { font-size: 11px; color: var(--accent-2); padding-left: 10px; border-left: 2px solid #8f7bff44; }
.mem-lin-empty { font-size: 12px; }

.mem-edit { display: flex; flex-direction: column; gap: 8px; border-top: 1px solid var(--line); padding-top: 10px; }
.mem-edit-claim { width: 100%; resize: vertical; min-height: 56px; background: var(--bg); color: var(--fg);
  border: 1px solid var(--line); border-radius: 8px; padding: 8px; font: inherit; }

.mem-forget { align-self: flex-start; background: transparent; color: var(--bad); border-color: #ff6b8155;
  font-size: 12px; padding: 5px 12px; }
.mem-forget:hover { border-color: var(--bad); box-shadow: 0 0 12px #ff6b8133; }

.mini { font-size: 11px; padding: 3px 10px; border-radius: 6px; }
.mini.ghost { background: transparent; }
`;

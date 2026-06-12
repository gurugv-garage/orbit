/**
 * Benchmarks — runs the dock-LLM suite against the live brain code and shows
 * the results. Replaces the old iframe'd static viewer with a native console
 * view: a run bar (live progress), per-model summary, and a capability-grouped
 * matrix where each cell is a compact pass%+quality badge that expands to the
 * runs on click. Reads the same snapshot schema the runner writes.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../lib/station';
import { useStationEvents } from '../lib/useStation';
import './bench.css';

interface IndexEntry { file: string; snapshot: string; ts: string; note?: string | null }
interface Latency { p50: number; p90: number; firstEventP50: number }
interface Quality { score: number | null; notes: string }
interface RunRow { pass: boolean; ms: number; output: string; toolCalls: { name: string; args: string }[]; error: string | null; failReasons?: string[] }
interface CaseResult {
  id: string; capability: string; prompt: string; image: string | null;
  n: number; passRate: number; latency: Latency; objective: Record<string, string>;
  runs: RunRow[]; quality?: Quality;
}
interface ModelResult {
  name: string; model: string; api: string; vision: boolean; tier: string; cost: string;
  issues: string[]; cases: CaseResult[];
}
interface Snapshot { run: { snapshot: string; ts: string; host: string; note: string | null; systemPrompt: string }; models: ModelResult[] }
interface ModelSpec { name: string; tier: string; cost: string }
type Progress =
  | { kind: 'start'; total: number; models: string[]; caseIds: string[] }
  | { kind: 'case'; model: string; caseId: string; passRate: number }
  | { kind: 'grading'; model: string }
  | { kind: 'done'; file: string }
  | { kind: 'error'; message: string };

const fmtMs = (ms: number) => (ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`);
const passColor = (r: number) => `hsl(${Math.round(r * 125)}, 60%, 45%)`;
const qColor = (q: number | null) => (q == null ? 'var(--dim)' : `hsl(${Math.round(((q - 1) / 4) * 125)}, 55%, 48%)`);

export function Bench() {
  const [index, setIndex] = useState<IndexEntry[]>([]);
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [models, setModels] = useState<ModelSpec[]>([]);
  const [pick, setPick] = useState<Set<string>>(new Set());
  const [run, setRun] = useState<{ active: boolean; done: number; total: number; phase: string }>(
    { active: false, done: 0, total: 0, phase: '' });
  const [showPrompt, setShowPrompt] = useState(false);

  const loadIndex = useCallback(async () => {
    const idx = await api.get<IndexEntry[]>('/bench/results/index.json').catch(() => []);
    setIndex(idx);
    if (idx[0]) setSnap(await api.get<Snapshot>(`/bench/results/${idx[0].file}`).catch(() => null));
  }, []);

  useEffect(() => {
    void loadIndex();
    void api.get<ModelSpec[]>('/bench/models').then((m) => { setModels(m); setPick(new Set(m.map((x) => x.name))); }).catch(() => {});
  }, [loadIndex]);

  // live run progress on the station topic (kind 'bench')
  useStationEvents('station', useCallback((e) => {
    if (e.kind !== 'bench') return;
    const p = e.payload as Progress;
    if (p.kind === 'start') setRun({ active: true, done: 0, total: p.total, phase: 'running' });
    else if (p.kind === 'case') setRun((r) => ({ ...r, done: r.done + 1, phase: `${p.model}: ${p.caseId}` }));
    else if (p.kind === 'grading') setRun((r) => ({ ...r, phase: `grading ${p.model}…` }));
    else if (p.kind === 'done') { setRun({ active: false, done: 0, total: 0, phase: '' }); void loadIndex(); }
    else if (p.kind === 'error') setRun({ active: false, done: 0, total: 0, phase: `error: ${p.message}` });
  }, [loadIndex]));

  const start = async () => {
    setRun({ active: true, done: 0, total: 0, phase: 'starting…' });
    await api.post('/bench/run', { models: [...pick] }).catch((err) => setRun({ active: false, done: 0, total: 0, phase: String(err) }));
  };

  return (
    <section className="bench">
      <div className="be-bar">
        <h2 className="title" style={{ margin: 0 }}>Benchmarks</h2>
        <div className="be-spacer" />
        {!run.active && (
          <>
            <div className="be-models">
              {models.map((m) => (
                <button key={m.name} className={`be-chip ${pick.has(m.name) ? 'on' : ''}`}
                  onClick={() => setPick((s) => { const n = new Set(s); if (n.has(m.name)) n.delete(m.name); else n.add(m.name); return n; })}>
                  {m.name}
                </button>
              ))}
            </div>
            <button className="be-run" disabled={pick.size === 0} onClick={start}>▶ run {pick.size} model{pick.size === 1 ? '' : 's'}</button>
          </>
        )}
        {run.active && (
          <div className="be-prog">
            <div className="be-prog-bar"><div style={{ width: run.total ? `${(run.done / run.total) * 100}%` : '8%' }} /></div>
            <span className="be-prog-txt">{run.phase}{run.total ? ` · ${run.done}/${run.total}` : ''}</span>
          </div>
        )}
      </div>

      <div className="be-sub">
        <label>snapshot</label>
        <select value={index.find((i) => snap && i.snapshot === snap.run.snapshot)?.file ?? ''}
          onChange={async (e) => setSnap(await api.get<Snapshot>(`/bench/results/${e.target.value}`).catch(() => null))}>
          {index.map((i) => <option key={i.file} value={i.file}>{i.snapshot} · {i.ts.slice(0, 16).replace('T', ' ')}</option>)}
        </select>
        {snap && <span className="be-meta">{snap.run.host}{snap.run.note ? ` · ${snap.run.note}` : ''}</span>}
        {snap && <button className="be-link" onClick={() => setShowPrompt((v) => !v)}>{showPrompt ? 'hide' : 'show'} system prompt</button>}
      </div>
      {showPrompt && snap && <pre className="be-prompt">{snap.run.systemPrompt}</pre>}

      {!snap ? <div className="empty">No snapshots yet — pick model(s) and hit run.</div>
        : <Matrix snap={snap} />}
    </section>
  );
}

function Matrix({ snap }: { snap: Snapshot }) {
  const { models } = snap;
  const order = useMemo(() => {
    const seen = new Set<string>(); const rows: { capability: string; id: string; prompt: string; image: string | null }[] = [];
    for (const m of models) for (const c of m.cases) {
      const k = `${c.capability}/${c.id}`;
      if (!seen.has(k)) { seen.add(k); rows.push({ capability: c.capability, id: c.id, prompt: c.prompt, image: c.image }); }
    }
    return rows;
  }, [models]);

  const summary = (m: ModelResult) => {
    const rate = m.cases.reduce((a, c) => a + c.passRate, 0) / (m.cases.length || 1);
    const qs = m.cases.map((c) => c.quality?.score).filter((x): x is number => x != null);
    const q = qs.length ? qs.reduce((a, b) => a + b, 0) / qs.length : null;
    return { rate, q };
  };

  let lastCap = '';
  return (
    <table className="be-matrix">
      <thead>
        <tr>
          <th className="be-th-case">case</th>
          {models.map((m) => {
            const s = summary(m);
            return (
              <th key={m.name}>
                <div className="be-mname">{m.name}{m.vision && <span title="vision"> 👁</span>}</div>
                <div className="be-msum">
                  <span style={{ color: passColor(s.rate) }}>{Math.round(s.rate * 100)}%</span>
                  {s.q != null && <span className="be-q" style={{ background: qColor(s.q) }}>★{s.q.toFixed(1)}</span>}
                </div>
                <div className="be-mcost">{m.cost || m.tier}</div>
                {m.issues.length > 0 && <div className="be-issues" title={m.issues.join('\n')}>⚠ {m.issues.length}</div>}
              </th>
            );
          })}
        </tr>
      </thead>
      <tbody>
        {order.map((row) => {
          const cells = models.map((m) => m.cases.find((c) => c.id === row.id && c.capability === row.capability));
          const best = Math.max(...cells.map((c) => (c ? c.passRate * 100 + (c.quality?.score ?? 0) : -1)));
          const head = row.capability !== lastCap ? (lastCap = row.capability) : null;
          return <Row key={`${row.capability}/${row.id}`} row={row} cells={cells} models={models} best={best} capHead={head} />;
        })}
      </tbody>
    </table>
  );
}

function Row({ row, cells, models, best, capHead }: {
  row: { capability: string; id: string; prompt: string; image: string | null };
  cells: (CaseResult | undefined)[]; models: ModelResult[]; best: number; capHead: string | null;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      {capHead && <tr className="be-cap"><td colSpan={models.length + 1}>{capHead}</td></tr>}
      <tr className={`be-row ${open ? 'open' : ''}`} onClick={() => setOpen((v) => !v)}>
        <td className="be-case">
          <span className="be-tw">{open ? '▾' : '▸'}</span>
          <b>{row.id}</b>
          <div className="be-prompt-s">{row.prompt}</div>
        </td>
        {cells.map((c, i) => {
          if (!c) return <td key={i} className="be-dim">—</td>;
          const score = c.passRate * 100 + (c.quality?.score ?? 0);
          const win = Math.abs(score - best) < 1e-6 && c.passRate > 0;
          return (
            <td key={i} className={win ? 'be-win' : ''}>
              <div className="be-badges">
                <span className="be-pass" style={{ color: passColor(c.passRate) }}>{Math.round(c.passRate * 100)}%</span>
                {c.quality?.score != null && <span className="be-q" style={{ background: qColor(c.quality.score) }}>★{c.quality.score}</span>}
              </div>
              <div className="be-lat">{fmtMs(c.latency.p50)}</div>
            </td>
          );
        })}
      </tr>
      {open && (
        <tr className="be-detail">
          <td colSpan={models.length + 1}>
            {row.image && <img className="be-frame" src={`/api/bench/images/${row.image}`} alt={row.image} />}
            <div className="be-grid">
              {models.map((m, i) => {
                const c = cells[i];
                if (!c) return null;
                return (
                  <div key={m.name} className="be-mdetail">
                    <div className="be-mdh">{m.name} · {Math.round(c.passRate * 100)}%
                      {c.quality && <span className="be-qn" style={{ borderColor: qColor(c.quality.score) }}>★{c.quality.score ?? '—'} {c.quality.notes}</span>}
                    </div>
                    {c.runs.map((r, j) => (
                      <div key={j} className={`be-run-row ${r.error ? 'err' : r.pass ? 'ok' : 'no'}`}>
                        <span className="be-verdict">{r.error ? 'ERR' : r.pass ? 'PASS' : 'fail'}</span>
                        <span className="be-rms">{fmtMs(r.ms)}</span>
                        {r.toolCalls.length > 0 && <div className="be-tools">▶ {r.toolCalls.map((t) => `${t.name}${t.args !== '{}' ? ' ' + t.args : ''}`).join(' , ')}</div>}
                        {r.output && <div className="be-out">{r.output}</div>}
                        {r.failReasons?.length ? <div className="be-fail">✗ {r.failReasons.join(' · ')}</div> : null}
                        {r.error && <div className="be-fail">{r.error}</div>}
                      </div>
                    ))}
                  </div>
                );
              })}
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

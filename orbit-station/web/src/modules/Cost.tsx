/**
 * Cost — LLM spend dashboard. Reads the observability cost rollups
 * (/api/observability/cost/{summary,series}); pi computes per-call cost from its
 * model pricing table, the station sums it. Breakdowns by dock (source), kind
 * (user session vs background task), and model, plus a per-day stacked chart.
 *
 * Costs are pi's LIST pricing over the obs retention window — not invoiced
 * amounts (free-tier keys still show list cost).
 */
import { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/station';
import './cost.css';

type GroupBy = 'source' | 'kind' | 'model';

interface CostBucket { group?: string; cost: number; inputTokens: number; outputTokens: number; calls: number }
interface CostSummary { from: number; to: number; total: CostBucket; groupBy: string; groups: CostBucket[] }
interface CostSeriesPoint { day: string; byGroup: Record<string, number> }

const WINDOWS: Array<{ label: string; days: number }> = [
  { label: '24h', days: 1 },
  { label: '7d', days: 7 },
  { label: '30d', days: 30 },
];

const fmtUsd = (c: number) => (c === 0 ? '$0' : c < 0.01 ? `$${c.toFixed(5)}` : `$${c.toFixed(4)}`);
const fmtTok = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`);

// stable-ish palette for stacked segments / legend.
const COLORS = ['#6ea8ff', '#7ee0c0', '#ffb86b', '#ff7eb6', '#c98bff', '#9be36b', '#ffd166', '#7fd1ff'];
const colorFor = (key: string, keys: string[]) => COLORS[keys.indexOf(key) % COLORS.length];

export function Cost() {
  const [days, setDays] = useState(7);
  const [groupBy, setGroupBy] = useState<GroupBy>('source');
  const [summary, setSummary] = useState<CostSummary | null>(null);
  const [series, setSeries] = useState<CostSeriesPoint[]>([]);
  const [loading, setLoading] = useState(false);

  const load = useCallback(() => {
    const to = Date.now();
    const from = to - days * 24 * 3600_000;
    const qs = `from=${from}&to=${to}&groupBy=${groupBy}`;
    setLoading(true);
    Promise.all([
      api.get<CostSummary>(`/observability/cost/summary?${qs}`).catch(() => null),
      api.get<CostSeriesPoint[]>(`/observability/cost/series?${qs}`).catch(() => []),
    ]).then(([s, ser]) => {
      setSummary(s);
      setSeries(ser ?? []);
      setLoading(false);
    });
  }, [days, groupBy]);

  useEffect(() => { load(); }, [load]);

  const total = summary?.total;
  const groups = summary?.groups ?? [];
  const seriesKeys = [...new Set(series.flatMap((p) => Object.keys(p.byGroup)))];

  return (
    <section>
      <h2 className="title">Cost</h2>
      <p className="subtitle">LLM spend across the fleet — pi list pricing, summed by the station. Last {days === 1 ? '24h' : `${days}d`}.</p>

      <div style={{ display: 'flex', gap: 16, alignItems: 'center', flexWrap: 'wrap', margin: '4px 0 18px' }}>
        <Segmented value={String(days)} onChange={(v) => setDays(Number(v))}
          opts={WINDOWS.map((w) => ({ value: String(w.days), label: w.label }))} />
        <span className="muted" style={{ marginLeft: 'auto' }}>break down by</span>
        <Segmented value={groupBy} onChange={(v) => setGroupBy(v as GroupBy)}
          opts={[{ value: 'source', label: 'Dock' }, { value: 'kind', label: 'User / Task' }, { value: 'model', label: 'Model' }]} />
        <button className="btn" onClick={load} disabled={loading}>{loading ? '…' : '↻'}</button>
      </div>

      <div className="grid">
        <div className="card"><h3>Total spend</h3><div className="stat">{total ? fmtUsd(total.cost) : '—'}</div><div className="muted">{total?.calls ?? 0} LLM calls</div></div>
        <div className="card"><h3>Input tokens</h3><div className="stat">{total ? fmtTok(total.inputTokens) : '—'}</div><div className="muted">prompt + context</div></div>
        <div className="card"><h3>Output tokens</h3><div className="stat">{total ? fmtTok(total.outputTokens) : '—'}</div><div className="muted">generated</div></div>
        <div className="card"><h3>Avg / call</h3><div className="stat">{total && total.calls ? fmtUsd(total.cost / total.calls) : '—'}</div><div className="muted">mean step cost</div></div>
      </div>

      <h3 style={{ margin: '24px 0 10px', color: 'var(--accent)' }}>Spend per day</h3>
      {series.length === 0
        ? <div className="empty">No LLM spend recorded in this window.</div>
        : <StackedChart series={series} keys={seriesKeys} />}

      <h3 style={{ margin: '24px 0 10px', color: 'var(--accent)' }}>
        By {groupBy === 'source' ? 'dock' : groupBy === 'kind' ? 'user / task' : 'model'}
      </h3>
      {groups.length === 0
        ? <div className="empty">Nothing to break down yet.</div>
        : (
          <table className="cost-tbl" style={{ width: '100%' }}>
            <thead><tr><th style={{ textAlign: 'left' }}>{groupBy}</th><th>cost</th><th>%</th><th>calls</th><th>in</th><th>out</th></tr></thead>
            <tbody>
              {groups.map((g) => {
                const pct = total && total.cost > 0 ? (g.cost / total.cost) * 100 : 0;
                return (
                  <tr key={g.group ?? '?'}>
                    <td style={{ textAlign: 'left' }}>
                      <span style={{ display: 'inline-block', width: 9, height: 9, borderRadius: 2, marginRight: 7, background: colorFor(g.group ?? '?', groups.map((x) => x.group ?? '?')) }} />
                      {g.group ?? '(unknown)'}
                    </td>
                    <td className="mono">{fmtUsd(g.cost)}</td>
                    <td className="muted">{pct.toFixed(0)}%</td>
                    <td className="mono">{g.calls}</td>
                    <td className="mono muted">{fmtTok(g.inputTokens)}</td>
                    <td className="mono muted">{fmtTok(g.outputTokens)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
    </section>
  );
}

// ── stacked per-day bar chart (dependency-free inline SVG) ────────────────────
function StackedChart({ series, keys }: { series: CostSeriesPoint[]; keys: string[] }) {
  const W = 720, H = 200, PAD = 28, GAP = 6;
  const dayTotal = (p: CostSeriesPoint) => Object.values(p.byGroup).reduce((a, b) => a + b, 0);
  const max = Math.max(...series.map(dayTotal), 1e-9);
  const bw = (W - PAD * 2) / series.length - GAP;
  const y = (v: number) => (H - PAD) - (v / max) * (H - PAD * 2);

  return (
    <div className="card" style={{ overflowX: 'auto' }}>
      <svg width={W} height={H} role="img" aria-label="spend per day">
        {/* baseline */}
        <line x1={PAD} y1={H - PAD} x2={W - PAD} y2={H - PAD} stroke="var(--line)" />
        {series.map((p, i) => {
          const x = PAD + i * ((W - PAD * 2) / series.length) + GAP / 2;
          let acc = 0;
          return (
            <g key={p.day}>
              {keys.map((k) => {
                const v = p.byGroup[k] ?? 0;
                if (v <= 0) return null;
                const yTop = y(acc + v), yBot = y(acc);
                acc += v;
                return <rect key={k} x={x} y={yTop} width={bw} height={Math.max(0, yBot - yTop)} fill={colorFor(k, keys)}>
                  <title>{p.day} · {k}: {fmtUsd(v)}</title>
                </rect>;
              })}
              <text x={x + bw / 2} y={H - PAD + 14} textAnchor="middle" fontSize={10} fill="var(--dim)">{p.day.slice(5)}</text>
            </g>
          );
        })}
        <text x={PAD} y={PAD - 10} fontSize={11} fill="var(--dim)">max/day {fmtUsd(max)}</text>
      </svg>
      <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', marginTop: 8 }}>
        {keys.map((k) => (
          <span key={k} className="muted" style={{ fontSize: 12 }}>
            <span style={{ display: 'inline-block', width: 9, height: 9, borderRadius: 2, marginRight: 6, background: colorFor(k, keys) }} />{k}
          </span>
        ))}
      </div>
    </div>
  );
}

// ── small segmented control ──────────────────────────────────────────────────
function Segmented({ value, onChange, opts }: { value: string; onChange: (v: string) => void; opts: Array<{ value: string; label: string }> }) {
  return (
    <div style={{ display: 'inline-flex', border: '1px solid var(--line)', borderRadius: 8, overflow: 'hidden' }}>
      {opts.map((o) => (
        <button key={o.value} onClick={() => onChange(o.value)}
          style={{
            padding: '5px 12px', border: 'none', cursor: 'pointer', fontSize: 13,
            background: value === o.value ? 'var(--accent)' : 'transparent',
            color: value === o.value ? '#0b0f1a' : 'var(--fg)',
          }}>{o.label}</button>
      ))}
    </div>
  );
}

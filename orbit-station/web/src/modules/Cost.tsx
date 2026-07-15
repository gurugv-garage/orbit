/**
 * Cost — LLM spend dashboard. Reads the observability cost rollups
 * (/api/observability/cost/{summary,series}); pi computes per-call cost from its
 * model pricing table, the station sums it. Breakdowns by dock (source), use case
 * (Conversation / Speech-to-text / Summarizer / Memory / Background tasks), and
 * model, plus a per-day stacked chart and a window-total donut.
 *
 * Filters (window + grouping) persist in the URL hash query (#cost?window=7d&
 * group=usecase) so a refresh — and a shared link — restores the same view.
 *
 * Costs are pi's LIST pricing over the obs retention window — not invoiced
 * amounts (free-tier keys still show list cost).
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../lib/station';
import './cost.css';

type GroupBy = 'source' | 'usecase' | 'model';

interface CostBucket { group?: string; cost: number; inputTokens: number; outputTokens: number; calls: number }
interface CostSummary { from: number; to: number; total: CostBucket; groupBy: string; groups: CostBucket[] }
interface CostSeriesPoint { day: string; byGroup: Record<string, number> }

// `from(to)` lets a window be calendar-anchored rather than a rolling multiple of
// 24h: "Today" means since local midnight, which is what someone checking the
// day's spend expects (the rolling 24h window would fold in yesterday evening).
const WINDOWS: Array<{ id: string; label: string; blurb: string; singleDay?: boolean; from: (to: number) => number }> = [
  { id: 'today', label: 'Today', blurb: 'since midnight', singleDay: true, from: () => new Date().setHours(0, 0, 0, 0) },
  { id: '24h', label: '24h', blurb: 'last 24h', singleDay: true, from: (to) => to - 24 * 3600_000 },
  { id: '7d', label: '7d', blurb: 'last 7d', from: (to) => to - 7 * 24 * 3600_000 },
  { id: '30d', label: '30d', blurb: 'last 30d', from: (to) => to - 30 * 24 * 3600_000 },
];
const DEFAULT_WINDOW = WINDOWS.find((w) => w.id === '7d')!;

const GROUPS: Array<{ value: GroupBy; label: string; noun: string }> = [
  { value: 'source', label: 'Dock', noun: 'dock' },
  { value: 'usecase', label: 'Use case', noun: 'use case' },
  { value: 'model', label: 'Model', noun: 'model' },
];

const fmtUsd = (c: number) => (c === 0 ? '$0' : c < 0.01 ? `$${c.toFixed(5)}` : `$${c.toFixed(4)}`);
const fmtTok = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`);

// stable-ish palette for stacked segments / legend.
const COLORS = ['#6ea8ff', '#7ee0c0', '#ffb86b', '#ff7eb6', '#c98bff', '#9be36b', '#ffd166', '#7fd1ff', '#ff9e7d', '#a0e8af'];
const colorFor = (key: string, keys: string[]) => COLORS[Math.max(0, keys.indexOf(key)) % COLORS.length]!;

// ── URL-hash filter persistence ───────────────────────────────────────────────
function readHashFilters(): { windowId: string; groupBy: GroupBy } {
  const q = new URLSearchParams((location.hash.split('?')[1] ?? ''));
  const w = WINDOWS.find((x) => x.id === q.get('window'));
  const g = GROUPS.find((x) => x.value === q.get('group'));
  return { windowId: (w ?? DEFAULT_WINDOW).id, groupBy: g?.value ?? 'source' };
}
function writeHashFilters(windowId: string, groupBy: GroupBy): void {
  const view = (location.hash.replace('#', '').split('?')[0] || 'cost');
  const q = new URLSearchParams();
  q.set('window', windowId);
  q.set('group', groupBy);
  // replaceState so filter tweaks don't pile up in browser history (but survive refresh).
  history.replaceState(null, '', `#${view}?${q.toString()}`);
}

// shared hover state: a key (group) currently highlighted across donut + table + legend.
interface Tip { x: number; y: number; label: string; cost: number; pct: number }

export function Cost() {
  const initial = readHashFilters();
  const [windowId, setWindowId] = useState(initial.windowId);
  const [groupBy, setGroupBy] = useState<GroupBy>(initial.groupBy);
  const win = WINDOWS.find((w) => w.id === windowId) ?? DEFAULT_WINDOW;
  const [summary, setSummary] = useState<CostSummary | null>(null);
  const [series, setSeries] = useState<CostSeriesPoint[]>([]);
  const [loading, setLoading] = useState(false);
  const [hover, setHover] = useState<string | null>(null);
  const [tip, setTip] = useState<Tip | null>(null);

  const load = useCallback(() => {
    const to = Date.now();
    // resolved at click/refresh time, not render time — a "Today" tab left open
    // across midnight picks up the new day on its next refresh.
    const from = (WINDOWS.find((w) => w.id === windowId) ?? DEFAULT_WINDOW).from(to);
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
  }, [windowId, groupBy]);

  useEffect(() => { load(); }, [load]);
  // keep the URL in sync with the active filters (refresh- and share-safe).
  useEffect(() => { writeHashFilters(windowId, groupBy); }, [windowId, groupBy]);

  const total = summary?.total;
  const groups = useMemo(() => summary?.groups ?? [], [summary]);
  const groupKeys = useMemo(() => groups.map((g) => g.group ?? '(unknown)'), [groups]);
  const seriesKeys = useMemo(
    () => [...new Set(series.flatMap((p) => Object.keys(p.byGroup)))],
    [series],
  );
  const noun = GROUPS.find((g) => g.value === groupBy)?.noun ?? 'group';

  return (
    <section onMouseMove={(e) => tip && setTip((t) => (t ? { ...t, x: e.clientX, y: e.clientY } : t))}>
      <h2 className="title">Cost</h2>
      <p className="subtitle">LLM spend across the fleet — pi list pricing, summed by the station. {win.id === 'today' ? 'Today, since midnight.' : `Last ${win.label}.`}</p>

      <div className="cost-controls">
        <Segmented value={windowId} onChange={setWindowId}
          opts={WINDOWS.map((w) => ({ value: w.id, label: w.label, title: w.blurb }))} />
        <span className="muted cost-byline">break down by</span>
        <Segmented value={groupBy} onChange={(v) => setGroupBy(v as GroupBy)}
          opts={GROUPS.map((g) => ({ value: g.value, label: g.label }))} />
        <button className="btn" onClick={load} disabled={loading} title="Refresh">{loading ? '…' : '↻'}</button>
      </div>

      <div className="grid">
        <div className="card"><h3>Total spend</h3><div className="stat">{total ? fmtUsd(total.cost) : '—'}</div><div className="muted">{total?.calls ?? 0} LLM calls</div></div>
        <div className="card"><h3>Input tokens</h3><div className="stat">{total ? fmtTok(total.inputTokens) : '—'}</div><div className="muted">prompt + context</div></div>
        <div className="card"><h3>Output tokens</h3><div className="stat">{total ? fmtTok(total.outputTokens) : '—'}</div><div className="muted">generated</div></div>
        <div className="card"><h3>Avg / call</h3><div className="stat">{total && total.calls ? fmtUsd(total.cost / total.calls) : '—'}</div><div className="muted">mean step cost</div></div>
      </div>

      {/* Single-day windows skip the per-day chart: one bar says nothing the total
          doesn't, and the server buckets days in UTC — west of UTC a local "Today"
          straddles two UTC buckets and would render a bar stamped yesterday. */}
      {!win.singleDay && (
        <>
          <h3 className="cost-h">Spend per day</h3>
          {series.length === 0
            ? <div className="empty">No LLM spend recorded in this window.</div>
            : <StackedChart series={series} keys={seriesKeys} hover={hover} setHover={setHover} setTip={setTip} />}
        </>
      )}

      <h3 className="cost-h">By {noun}</h3>
      {groups.length === 0
        ? <div className="empty">Nothing to break down yet.</div>
        : (
          <div className="cost-breakdown">
            <Donut groups={groups} keys={groupKeys} total={total?.cost ?? 0}
              hover={hover} setHover={setHover} setTip={setTip} />
            <table className="cost-tbl">
              <thead><tr><th className="l">{noun}</th><th>cost</th><th>share</th><th>calls</th><th>in</th><th>out</th></tr></thead>
              <tbody>
                {groups.map((g) => {
                  const key = g.group ?? '(unknown)';
                  const pct = total && total.cost > 0 ? (g.cost / total.cost) * 100 : 0;
                  return (
                    <tr key={key} className={hover === key ? 'hot' : hover ? 'dim' : ''}
                      onMouseEnter={() => setHover(key)} onMouseLeave={() => setHover(null)}>
                      <td className="l">
                        <span className="swatch" style={{ background: colorFor(key, groupKeys) }} />
                        {key}
                      </td>
                      <td className="mono">{fmtUsd(g.cost)}</td>
                      <td><Bar pct={pct} color={colorFor(key, groupKeys)} /></td>
                      <td className="mono">{g.calls}</td>
                      <td className="mono muted">{fmtTok(g.inputTokens)}</td>
                      <td className="mono muted">{fmtTok(g.outputTokens)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

      {tip && <Tooltip tip={tip} />}
    </section>
  );
}

// ── floating tooltip (instant, cursor-following — replaces native SVG <title>) ──
function Tooltip({ tip }: { tip: Tip }) {
  // clamp near the right/bottom edges so the box stays on-screen.
  const x = Math.min(tip.x + 14, window.innerWidth - 180);
  const y = Math.min(tip.y + 14, window.innerHeight - 60);
  return (
    <div className="cost-tip" style={{ left: x, top: y }}>
      <div className="cost-tip-label">{tip.label}</div>
      <div className="cost-tip-val">{fmtUsd(tip.cost)} · {tip.pct.toFixed(1)}%</div>
    </div>
  );
}

// ── donut: window-total share by the active grouping ─────────────────────────
function Donut({ groups, keys, total, hover, setHover, setTip }: {
  groups: CostBucket[]; keys: string[]; total: number;
  hover: string | null; setHover: (k: string | null) => void;
  setTip: (t: Tip | null) => void;
}) {
  const R = 78, r = 50, C = 96; // outer radius, inner radius, center
  const sum = total || groups.reduce((a, g) => a + g.cost, 0) || 1e-9;
  // long tails (many docks) would repeat the 9-color palette into mush — fold
  // everything past the top 8 into one "Other" slice so each slice is legible.
  const TOP = 8;
  const positive = groups.filter((g) => g.cost > 0);
  const head = positive.slice(0, TOP);
  const tail = positive.slice(TOP);
  const slices: Array<{ key: string; cost: number; color: string }> = head.map((g) => {
    const key = g.group ?? '(unknown)';
    return { key, cost: g.cost, color: colorFor(key, keys) };
  });
  if (tail.length) slices.push({ key: `Other (${tail.length})`, cost: tail.reduce((a, g) => a + g.cost, 0), color: 'var(--dim)' });
  let acc = 0;
  const arcs = slices.map((s) => {
    const a0 = (acc / sum) * Math.PI * 2;
    acc += s.cost;
    const a1 = (acc / sum) * Math.PI * 2;
    return { ...s, a0, a1, pct: (s.cost / sum) * 100 };
  });

  const arcPath = (a0: number, a1: number) => {
    // a near-full single slice can't be drawn as one arc — nudge it just under 2π.
    const span = Math.min(a1 - a0, Math.PI * 2 - 1e-3);
    const s = a0 - Math.PI / 2, e = a0 + span - Math.PI / 2;
    const large = span > Math.PI ? 1 : 0;
    const xo0 = C + R * Math.cos(s), yo0 = C + R * Math.sin(s);
    const xo1 = C + R * Math.cos(e), yo1 = C + R * Math.sin(e);
    const xi1 = C + r * Math.cos(e), yi1 = C + r * Math.sin(e);
    const xi0 = C + r * Math.cos(s), yi0 = C + r * Math.sin(s);
    return `M ${xo0} ${yo0} A ${R} ${R} 0 ${large} 1 ${xo1} ${yo1} L ${xi1} ${yi1} A ${r} ${r} 0 ${large} 0 ${xi0} ${yi0} Z`;
  };

  const topShare = arcs[0];
  return (
    <div className="card cost-donut-card">
      <svg width={C * 2} height={C * 2} viewBox={`0 0 ${C * 2} ${C * 2}`} role="img" aria-label="cost share">
        {arcs.map((a) => {
          const dimmed = hover && hover !== a.key;
          return (
            <path key={a.key} d={arcPath(a.a0, a.a1)} fill={a.color}
              className="cost-arc" opacity={dimmed ? 0.25 : 1}
              onMouseEnter={(e) => { setHover(a.key); setTip({ x: e.clientX, y: e.clientY, label: a.key, cost: a.cost, pct: a.pct }); }}
              onMouseLeave={() => { setHover(null); setTip(null); }} />
          );
        })}
        {/* center label: total, or the hovered slice's share */}
        <text x={C} y={C - 4} textAnchor="middle" className="cost-donut-c1">
          {hover ? `${(arcs.find((a) => a.key === hover)?.pct ?? 0).toFixed(0)}%` : fmtUsd(sum)}
        </text>
        <text x={C} y={C + 14} textAnchor="middle" className="cost-donut-c2">
          {hover ?? (topShare ? `top ${topShare.pct.toFixed(0)}%` : 'total')}
        </text>
      </svg>
      <div className="cost-legend">
        {arcs.map((a) => (
          <span key={a.key} className={`cost-legend-item ${hover === a.key ? 'hot' : hover ? 'dim' : ''}`}
            onMouseEnter={() => setHover(a.key)} onMouseLeave={() => setHover(null)}>
            <span className="swatch" style={{ background: a.color }} />
            <span className="cost-legend-name">{a.key}</span>
            <span className="cost-legend-pct mono">{a.pct.toFixed(0)}%</span>
          </span>
        ))}
      </div>
    </div>
  );
}

// inline share bar inside the table's "share" column.
function Bar({ pct, color }: { pct: number; color: string }) {
  return (
    <span className="cost-rowbar" title={`${pct.toFixed(1)}%`}>
      <span className="cost-rowbar-fill" style={{ width: `${Math.max(2, pct)}%`, background: color }} />
      <span className="cost-rowbar-num">{pct.toFixed(0)}%</span>
    </span>
  );
}

// ── stacked per-day bar chart (dependency-free inline SVG) ────────────────────
function StackedChart({ series, keys, hover, setHover, setTip }: {
  series: CostSeriesPoint[]; keys: string[];
  hover: string | null; setHover: (k: string | null) => void; setTip: (t: Tip | null) => void;
}) {
  const W = 760, H = 210, PAD = 30, GAP = 6;
  const dayTotal = (p: CostSeriesPoint) => Object.values(p.byGroup).reduce((a, b) => a + b, 0);
  const max = Math.max(...series.map(dayTotal), 1e-9);
  const bw = (W - PAD * 2) / series.length - GAP;
  const y = (v: number) => (H - PAD) - (v / max) * (H - PAD * 2);

  return (
    <div className="card cost-chart">
      <svg width="100%" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="spend per day" preserveAspectRatio="xMidYMid meet">
        {/* y gridlines at 0/50/100% of max */}
        {[0, 0.5, 1].map((f) => (
          <g key={f}>
            <line x1={PAD} y1={y(max * f)} x2={W - PAD} y2={y(max * f)} stroke="var(--line)" strokeDasharray={f === 0 ? '' : '3 4'} opacity={f === 0 ? 1 : 0.5} />
            {f > 0 && <text x={PAD - 4} y={y(max * f) + 3} textAnchor="end" className="cost-axis">{fmtUsd(max * f)}</text>}
          </g>
        ))}
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
                const dimmed = hover && hover !== k;
                return <rect key={k} x={x} y={yTop} width={bw} height={Math.max(0, yBot - yTop)} fill={colorFor(k, keys)}
                  opacity={dimmed ? 0.25 : 1} className="cost-bar"
                  onMouseEnter={(e) => { setHover(k); setTip({ x: e.clientX, y: e.clientY, label: `${p.day} · ${k}`, cost: v, pct: (v / dayTotal(p)) * 100 }); }}
                  onMouseLeave={() => { setHover(null); setTip(null); }} />;
              })}
              <text x={x + bw / 2} y={H - PAD + 14} textAnchor="middle" className="cost-axis">{p.day.slice(5)}</text>
            </g>
          );
        })}
      </svg>
      <div className="cost-legend cost-legend-row">
        {keys.map((k) => (
          <span key={k} className={`cost-legend-item ${hover === k ? 'hot' : hover ? 'dim' : ''}`}
            onMouseEnter={() => setHover(k)} onMouseLeave={() => setHover(null)}>
            <span className="swatch" style={{ background: colorFor(k, keys) }} />{k}
          </span>
        ))}
      </div>
    </div>
  );
}

// ── small segmented control ──────────────────────────────────────────────────
function Segmented({ value, onChange, opts }: { value: string; onChange: (v: string) => void; opts: Array<{ value: string; label: string; title?: string }> }) {
  return (
    <div className="cost-seg">
      {opts.map((o) => (
        <button key={o.value} onClick={() => onChange(o.value)} title={o.title} className={value === o.value ? 'on' : ''}>{o.label}</button>
      ))}
    </div>
  );
}

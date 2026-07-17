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

// Entity-stable colors: a category keeps its color forever — across windows,
// groupings, and views — never assigned by rank or appearance order (rank changes
// day to day; identity doesn't). Known use cases are pinned; anything new (docks,
// models, future use cases) gets a deterministic hashed pastel hue. The folded
// "Other" bucket is always gray — it's a remainder, not an identity.
const PINNED: Record<string, string> = {
  // CVD-checked as a set (dataviz validator, dark surface): worst adjacent pair
  // sits in the 6-8 ΔE band, legal because segments also carry gaps + labels.
  'Conversation': '#6ea8ff',
  'audio-enricher': '#7ee0c0',
  'introspect': '#ffb86b',
  'Background tasks': '#c98bff',
  'bg-audio': '#f45c9a',
  'summary': '#52c26d',
  'consolidate': '#ffd166',
  'span-digest': '#7fd1ff',
  'fact-extract': '#ff9e7d',
  'reconcile': '#a0e8af',
  'introspect-condense': '#9d7ce8',
  'enrich': '#d9a54a',
  'web-search': '#63b3a0',
};
const hashHue = (key: string) => {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = ((h * 31 + key.charCodeAt(i)) >>> 0);
  return (h * 137.508) % 360; // golden-angle spread keeps hashed hues far apart
};
const colorFor = (key: string) =>
  key.startsWith('Other (') ? 'var(--dim)' : (PINNED[key] ?? `hsl(${hashHue(key).toFixed(1)} 62% 72%)`);

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
  // chart keys ranked by window cost (matches the donut's ordering — biggest
  // spender stacks at the bottom), with the long tail folded into a gray "Other"
  // so the stack and its legend stay legible.
  const chart = useMemo(() => {
    const totals = new Map<string, number>();
    for (const p of series) for (const [k, v] of Object.entries(p.byGroup)) totals.set(k, (totals.get(k) ?? 0) + v);
    const ranked = [...totals.keys()].sort((a, b) => (totals.get(b)! - totals.get(a)!));
    const TOP = 9;
    if (ranked.length <= TOP + 1) return { series, keys: ranked };
    const head = new Set(ranked.slice(0, TOP));
    const otherKey = `Other (${ranked.length - TOP})`;
    const folded = series.map((p) => {
      const byGroup: Record<string, number> = {};
      let other = 0;
      for (const [k, v] of Object.entries(p.byGroup)) head.has(k) ? (byGroup[k] = v) : (other += v);
      if (other > 0) byGroup[otherKey] = other;
      return { ...p, byGroup };
    });
    return { series: folded, keys: [...ranked.slice(0, TOP), otherKey] };
  }, [series]);
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
            : <StackedChart series={chart.series} keys={chart.keys} hover={hover} setHover={setHover} setTip={setTip} />}
        </>
      )}

      <h3 className="cost-h">By {noun}</h3>
      {groups.length === 0
        ? <div className="empty">Nothing to break down yet.</div>
        : (
          <div className="cost-breakdown">
            <Donut groups={groups} total={total?.cost ?? 0}
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
                        <span className="swatch" style={{ background: colorFor(key) }} />
                        {key}
                      </td>
                      <td className="mono">{fmtUsd(g.cost)}</td>
                      <td><Bar pct={pct} color={colorFor(key)} /></td>
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
function Donut({ groups, total, hover, setHover, setTip }: {
  groups: CostBucket[]; total: number;
  hover: string | null; setHover: (k: string | null) => void;
  setTip: (t: Tip | null) => void;
}) {
  const R = 78, r = 50, C = 96; // outer radius, inner radius, center
  const sum = total || groups.reduce((a, g) => a + g.cost, 0) || 1e-9;
  // fold everything past the top 8 into one "Other" slice so each slice is legible.
  const TOP = 8;
  const positive = groups.filter((g) => g.cost > 0);
  const head = positive.slice(0, TOP);
  const tail = positive.slice(TOP);
  const slices: Array<{ key: string; cost: number; color: string }> = head.map((g) => {
    const key = g.group ?? '(unknown)';
    return { key, cost: g.cost, color: colorFor(key) };
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

// compact money for on-chart labels (bar caps, in-segment) — 2-3 significant chars.
const fmtUsdShort = (v: number) => (v >= 100 ? `$${v.toFixed(0)}` : v >= 10 ? `$${v.toFixed(1)}` : `$${v.toFixed(2)}`);
// axis ticks are clean numbers, so drop trailing zeros ($5, $2.50).
const fmtAxis = (v: number) => `$${(+v.toFixed(2)).toString()}`;
// round a max up to a clean tick ceiling — steps fine enough that a value just
// over a round number doesn't double the scale ($10.02 → $12, not $20).
function niceCeil(v: number): number {
  const mag = Math.pow(10, Math.floor(Math.log10(v)));
  for (const s of [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) if (s * mag >= v) return s * mag;
  return 10 * mag;
}

// ── stacked per-day bar chart (dependency-free inline SVG) ────────────────────
function StackedChart({ series, keys, hover, setHover, setTip }: {
  series: CostSeriesPoint[]; keys: string[];
  hover: string | null; setHover: (k: string | null) => void; setTip: (t: Tip | null) => void;
}) {
  const W = 760, H = 230, PADL = 46, PADR = 12, PADT = 22, PADB = 26;
  const dayTotal = (p: CostSeriesPoint) => Object.values(p.byGroup).reduce((a, b) => a + b, 0);
  // scale to a clean ceiling so the gridline labels are round numbers.
  const max = niceCeil(Math.max(...series.map(dayTotal), 1e-9));
  const slot = (W - PADL - PADR) / series.length;
  const bw = Math.min(slot - 6, 46); // cap bar width — wide windows get slim bars, 7d stays readable
  const y = (v: number) => (H - PADB) - (v / max) * (H - PADT - PADB);
  // rough label width at the on-bar font sizes; labels that don't fit are skipped, not clipped.
  const textW = (s: string) => s.length * 5;
  // thin x labels when slots get narrow (30d) so dates don't collide.
  const dayEvery = Math.max(1, Math.ceil(34 / slot));
  // anti-overlap for bar-cap totals, biggest-first so peaks always keep their
  // label and smaller neighbors yield (their totals stay reachable via hover).
  const totalBoxes = series.map((p, i) => {
    const total = dayTotal(p);
    const cx = PADL + i * slot + slot / 2, w = textW(fmtUsdShort(total));
    return { i, total, start: cx - w / 2, end: cx + w / 2, top: y(total) - 5 };
  });
  const showTotalIdx = new Set<number>();
  const placed: typeof totalBoxes = [];
  for (const b of [...totalBoxes].sort((a, c) => c.total - a.total)) {
    if (b.total < 0.005) continue; // would render as $0.00
    // collides only when boxes overlap horizontally AND sit at a similar height
    if (placed.every((a) => b.end + 3 < a.start || b.start - 3 > a.end || Math.abs(a.top - b.top) > 10)) {
      showTotalIdx.add(b.i);
      placed.push(b);
    }
  }

  return (
    <div className="card cost-chart">
      <svg width="100%" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="spend per day" preserveAspectRatio="xMidYMid meet">
        {/* y gridlines at 0/25/50/75/100% of the clean max */}
        {[0, 0.25, 0.5, 0.75, 1].map((f) => (
          <g key={f}>
            <line x1={PADL} y1={y(max * f)} x2={W - PADR} y2={y(max * f)} stroke="var(--line)" opacity={f === 0 ? 1 : 0.45} />
            {f > 0 && <text x={PADL - 6} y={y(max * f) + 3} textAnchor="end" className="cost-axis">{fmtAxis(max * f)}</text>}
          </g>
        ))}
        {series.map((p, i) => {
          const x = PADL + i * slot + (slot - bw) / 2;
          const total = dayTotal(p);
          const segs = keys.map((k) => ({ k, v: p.byGroup[k] ?? 0 })).filter((s) => s.v > 0);
          let acc = 0;
          const totalLabel = fmtUsdShort(total);
          return (
            <g key={p.day}>
              {segs.map(({ k, v }, si) => {
                const yTop = y(acc + v), yBot = y(acc);
                acc += v;
                const h = Math.max(0, yBot - yTop);
                // 2px surface gap between stacked segments (skip the topmost — its cap is the bar total)
                const inset = si < segs.length - 1 && h > 5 ? 2 : 0;
                const dimmed = hover && hover !== k;
                const label = fmtUsdShort(v);
                const labelFits = h >= 13 && textW(label) <= bw - 8;
                return (
                  <g key={k}>
                    <rect x={x} y={yTop + inset} width={bw} height={Math.max(0.5, h - inset)} fill={colorFor(k)}
                      opacity={dimmed ? 0.25 : 1} className="cost-bar"
                      onMouseEnter={(e) => { setHover(k); setTip({ x: e.clientX, y: e.clientY, label: `${p.day} · ${k}`, cost: v, pct: (v / total) * 100 }); }}
                      onMouseLeave={() => { setHover(null); setTip(null); }} />
                    {/* in-segment cost, only where it fits; hover/tooltip carries the rest */}
                    {labelFits && (
                      <text x={x + bw / 2} y={(yTop + inset + yBot) / 2 + 3.5} textAnchor="middle"
                        className="cost-seg-label" opacity={dimmed ? 0.25 : 1}>{label}</text>
                    )}
                  </g>
                );
              })}
              {/* day total on the bar cap (skipped when it would collide with a neighbor's) */}
              {showTotalIdx.has(i) && (
                <text x={x + bw / 2} y={y(total) - 5} textAnchor="middle" className="cost-bar-total">{totalLabel}</text>
              )}
              {i % dayEvery === 0 && (
                <text x={x + bw / 2} y={H - PADB + 14} textAnchor="middle" className="cost-axis">{p.day.slice(5)}</text>
              )}
            </g>
          );
        })}
      </svg>
      <div className="cost-legend cost-legend-row">
        {keys.map((k) => (
          <span key={k} className={`cost-legend-item ${hover === k ? 'hot' : hover ? 'dim' : ''}`}
            onMouseEnter={() => setHover(k)} onMouseLeave={() => setHover(null)}>
            <span className="swatch" style={{ background: colorFor(k) }} />{k}
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

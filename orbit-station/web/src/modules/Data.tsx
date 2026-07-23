import { useCallback, useEffect, useMemo, useState } from 'react';

/**
 * Data console — how much disk orbit is using on this machine, split by use
 * case (media clips, runtime state, model weights, build output, scratch).
 *
 * Scanning walks a few hundred thousand files, so it is never automatic: the
 * view renders the LAST cached scan (the server keeps it on disk across
 * restarts) with its age, and "Calculate" re-runs it. Individual rows can be
 * re-measured on their own via the ↻ on the row.
 */

type Area = 'runtime' | 'media' | 'models' | 'build' | 'scratch';

interface Row {
  id: string;
  label: string;
  area: Area;
  path: string;
  abs: string;
  note: string;
  disposable?: boolean;
  exists: boolean;
  bytes: number;
  ownBytes: number;
  files: number;
  newest: number;
  contains: string[];
  error?: string;
}

interface Scan {
  cached: boolean;
  scanning?: boolean;
  root: string;
  scannedAt: number;
  durationMs: number;
  totalBytes: number;
  rows: Row[];
}

const AREA: Record<Area, { label: string; ico: string; color: string; blurb?: string }> = {
  runtime: {
    label: 'Application data', ico: '🧠', color: '#8fd6a0',
    blurb: 'what the station needs to RUN — its memory, sessions and identity. Deleting this is amnesia.',
  },
  media:   { label: 'Media & clips',    ico: '🎞', color: '#7aa2ff' },
  models:  { label: 'Model weights',    ico: '🧬', color: '#d4a3ff' },
  build:   { label: 'Build artifacts',  ico: '🔧', color: '#ffc46b' },
  scratch: { label: 'Scratch',          ico: '🗒', color: '#ff9a9a' },
};
const AREA_ORDER: Area[] = ['runtime', 'media', 'models', 'build', 'scratch'];

/** The one area that is NOT disposable — the app's own persistent state. It
 *  stays expanded; everything else (regenerable bytes: caches, weights, build
 *  output, scratch) collapses, so the view opens on what actually matters. */
const ALWAYS_OPEN: Area = 'runtime';

export function Data() {
  const [scan, setScan] = useState<Scan | null>(null);
  const [busy, setBusy] = useState(false);
  const [busyRow, setBusyRow] = useState<string | null>(null);
  // Only the application-data group starts open (see ALWAYS_OPEN); the rest are
  // regenerable and collapse to a one-line total until you ask for detail.
  const [open, setOpen] = useState<Set<Area>>(new Set([ALWAYS_OPEN]));
  const toggle = useCallback((a: Area) => {
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(a)) next.delete(a); else next.add(a);
      return next;
    });
  }, []);

  const load = useCallback(async () => {
    try {
      const r = await fetch('/api/data/');
      if (r.ok) setScan(await r.json());
    } catch { /* ignore */ }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const calculate = useCallback(async (only?: string[]) => {
    if (only) setBusyRow(only[0] ?? null); else setBusy(true);
    try {
      const r = await fetch('/api/data/scan', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(only ? { only } : {}),
      });
      if (r.ok) setScan(await r.json());
    } catch { /* ignore */ } finally { setBusy(false); setBusyRow(null); }
  }, []);

  // Group into areas, biggest area first, biggest row first within an area.
  // Sizing uses ownBytes so nested entries (models/ containing
  // models/perception-sidecar) are never counted twice in a subtotal.
  const groups = useMemo(() => {
    const rows = scan?.rows ?? [];
    return AREA_ORDER
      .map((area) => {
        const items = rows.filter((r) => r.area === area).sort((a, b) => b.ownBytes - a.ownBytes);
        return { area, items, bytes: items.reduce((n, r) => n + r.ownBytes, 0) };
      })
      .filter((g) => g.items.length > 0)
      // size-ordered, EXCEPT application data which pins to the top regardless of
      // size — it's the smallest group and the only one you can't regenerate.
      .sort((a, b) =>
        a.area === ALWAYS_OPEN ? -1 : b.area === ALWAYS_OPEN ? 1 : b.bytes - a.bytes);
  }, [scan]);

  const total = scan?.totalBytes ?? 0;
  const has = Boolean(scan?.cached);

  return (
    <div style={{ maxWidth: 1000 }}>
      {/* header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap', marginBottom: 6 }}>
        <div>
          <div style={{ fontSize: 34, fontWeight: 700, lineHeight: 1.1 }}>
            {has ? fmtBytes(total) : <span style={{ opacity: 0.3 }}>— GB</span>}
          </div>
          <div style={{ fontSize: 12, opacity: 0.5 }}>
            {has
              ? <>across {scan!.rows.filter((r) => r.exists).length} locations · measured {fmtAgo(scan!.scannedAt)} · took {(scan!.durationMs / 1000).toFixed(1)}s</>
              : 'never measured on this station'}
          </div>
        </div>
        <button onClick={() => void calculate()} disabled={busy} style={btnPrimary}>
          {busy ? 'Scanning…' : has ? '↻ Recalculate' : 'Calculate'}
        </button>
      </div>
      <div style={{ fontSize: 12, opacity: 0.45, marginBottom: 18, lineHeight: 1.5 }}>
        Untracked bytes only — nothing here is in git. Sizes are apparent size (sum of file
        sizes), so <code>du</code> reads a little higher. A full scan walks every file and
        takes seconds; the result is cached until you recalculate.
      </div>

      {/* area bar */}
      {has && total > 0 && (
        <div style={{ display: 'flex', height: 10, borderRadius: 5, overflow: 'hidden', marginBottom: 8 }}>
          {groups.map((g) => (
            <div key={g.area} title={`${AREA[g.area].label} — ${fmtBytes(g.bytes)}`}
              style={{ width: `${(g.bytes / total) * 100}%`, background: AREA[g.area].color }} />
          ))}
        </div>
      )}
      {has && total > 0 && (
        <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', fontSize: 12, opacity: 0.7, marginBottom: 20 }}>
          {groups.map((g) => (
            <span key={g.area}>
              <span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: 2, background: AREA[g.area].color, marginRight: 6 }} />
              {AREA[g.area].label} <strong>{fmtBytes(g.bytes)}</strong>
              <span style={{ opacity: 0.5 }}> · {pct(g.bytes, total)}</span>
            </span>
          ))}
        </div>
      )}

      {/* groups */}
      {groups.map((g) => (
        <div key={g.area} style={{ marginBottom: 22 }}>
          <button
            type="button"
            data-group={g.area}
            aria-expanded={open.has(g.area)}
            onClick={() => toggle(g.area)}
            style={{
              display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 8, cursor: 'pointer',
              userSelect: 'none', background: 'transparent', border: 0, color: 'inherit',
              font: 'inherit', padding: 0, width: '100%', textAlign: 'left',
            }}
          >
            <span style={{ fontSize: 11, opacity: 0.5, width: 10 }}>{open.has(g.area) ? '▾' : '▸'}</span>
            <span style={{ fontSize: 15 }}>{AREA[g.area].ico}</span>
            <strong style={{ fontSize: 14 }}>{AREA[g.area].label}</strong>
            <span style={{ opacity: 0.5, fontSize: 13 }}>{has ? fmtBytes(g.bytes) : ''}</span>
            {!open.has(g.area) && (
              <span style={{ opacity: 0.35, fontSize: 12 }}>
                · {g.items.length} location{g.items.length > 1 ? 's' : ''}
              </span>
            )}
          </button>
          {AREA[g.area].blurb && open.has(g.area) && (
            <div style={{ fontSize: 11, opacity: 0.45, margin: '-4px 0 8px 18px' }}>{AREA[g.area].blurb}</div>
          )}
          {open.has(g.area) && g.items.map((r) => {
            const share = total > 0 ? r.ownBytes / total : 0;
            return (
              <div key={r.id} style={{
                display: 'grid', gridTemplateColumns: '1fr 110px 90px 30px', gap: 10, alignItems: 'center',
                padding: '8px 10px', marginBottom: 4, borderRadius: 8,
                background: '#ffffff06', border: '1px solid #ffffff10',
                opacity: has && !r.exists ? 0.4 : 1,
              }}>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 600 }}>
                    {r.label}
                    {r.disposable && <span title="regenerable — safe to delete" style={{ marginLeft: 6, fontSize: 11, opacity: 0.6 }}>🧹</span>}
                    {has && !r.exists && <span style={{ marginLeft: 6, fontSize: 11, opacity: 0.7 }}>(not present)</span>}
                  </div>
                  <div style={{ fontSize: 11, opacity: 0.5, marginTop: 2 }}>{r.note}</div>
                  <div
                    title="click to copy the full path"
                    onClick={() => navigator.clipboard?.writeText(r.abs || r.path)}
                    style={{ fontSize: 10, opacity: 0.4, fontFamily: 'monospace', marginTop: 3, cursor: 'pointer', wordBreak: 'break-all' }}
                  >📁 {r.path}</div>
                  {r.contains.length > 0 && (
                    <div style={{ fontSize: 10, opacity: 0.35, marginTop: 2 }}>
                      shown minus {r.contains.length} nested row{r.contains.length > 1 ? 's' : ''} (subtree {fmtBytes(r.bytes)})
                    </div>
                  )}
                  {r.error && <div style={{ fontSize: 10, color: '#ff9a9a', marginTop: 2 }}>{r.error}</div>}
                </div>
                <div>
                  <div style={{ fontSize: 14, fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>
                    {has ? fmtBytes(r.ownBytes) : <span style={{ opacity: 0.25 }}>—</span>}
                  </div>
                  {has && (
                    <div style={{ height: 3, borderRadius: 2, marginTop: 4, background: '#ffffff14' }}>
                      <div style={{ width: `${Math.min(100, share * 100)}%`, height: '100%', borderRadius: 2, background: AREA[g.area].color }} />
                    </div>
                  )}
                </div>
                <div style={{ fontSize: 11, opacity: 0.5, textAlign: 'right' }}>
                  {has && r.exists ? <>{r.files.toLocaleString()} files<br />{r.newest ? fmtAgo(r.newest) : ''}</> : ''}
                </div>
                <button
                  title="re-measure just this location"
                  onClick={() => void calculate([r.id])}
                  disabled={busy || busyRow === r.id}
                  style={btnGhost}
                >{busyRow === r.id ? '…' : '↻'}</button>
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}

function fmtBytes(n: number): string {
  if (n <= 0) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(u.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  const v = n / 1024 ** i;
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${u[i]}`;
}

function pct(n: number, total: number): string {
  return total > 0 ? `${((n / total) * 100).toFixed(0)}%` : '0%';
}

function fmtAgo(ms: number): string {
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 90) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

const btnPrimary: React.CSSProperties = {
  background: '#7aa2ff22', border: '1px solid #7aa2ff66', color: '#cfe0ff',
  borderRadius: 8, cursor: 'pointer', padding: '8px 16px', fontSize: 13, fontWeight: 600,
};
const btnGhost: React.CSSProperties = {
  background: 'transparent', border: '1px solid #ffffff22', color: '#fff',
  borderRadius: 6, cursor: 'pointer', padding: '2px 6px', fontSize: 11,
};

import { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/station';
import { useDocks } from '../lib/useDocks';

/**
 * Ego — the dock's per-dock ego document (identity + story), its introspection, and its
 * trace. See docs/decision-traces/ego.md. Slice 1: view the current ego, run a manual
 * introspection (the Introspect button), and browse past introspections (the trace).
 *
 * Introspection is "encouraging, not proven" (see the offline experiments) — this console
 * is how we watch a real dock's self form and evolve, cautiously.
 */

interface EgoResp { dock: string; ego: string; exists: boolean }
interface TraceResp { dock: string; entries: { name: string; ts: string }[] }
interface IntrospectResp { ok: boolean; fresh?: boolean; snapshotted?: boolean; ego?: string; error?: string }

/** Render the ego markdown lightly — bold the ## section headers, keep prose. */
function EgoDoc({ text }: { text: string }) {
  return (
    <pre style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', margin: 0, fontSize: 13,
      lineHeight: 1.55, fontFamily: 'inherit' }}>
      {text.split('\n').map((line, i) => {
        if (line.startsWith('## ')) return <b key={i} style={{ color: 'var(--accent)', display: 'block', marginTop: 10 }}>{line.slice(3)}</b>;
        if (line.startsWith('# ')) return <span key={i} style={{ color: 'var(--dim)' }}>{line}{'\n'}</span>;
        return <span key={i}>{line}{'\n'}</span>;
      })}
    </pre>
  );
}

export function Ego() {
  const docks = useDocks();
  const [dock, setDock] = useState('');
  const [ego, setEgo] = useState<EgoResp | null>(null);
  const [trace, setTrace] = useState<TraceResp['entries']>([]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [openSnap, setOpenSnap] = useState<string | null>(null);
  const [snapText, setSnapText] = useState('');

  useEffect(() => { if (!dock && docks.length) setDock(docks[0]!.name); }, [dock, docks]);

  const refresh = useCallback(async (d: string) => {
    if (!d) return;
    const [e, t] = await Promise.all([
      api.get<EgoResp>(`/ego/${d}`).catch(() => null),
      api.get<TraceResp>(`/ego/${d}/trace`).catch(() => null),
    ]);
    setEgo(e); setTrace(t?.entries ?? []);
  }, []);

  useEffect(() => { void refresh(dock); }, [dock, refresh]);

  const introspect = useCallback(async () => {
    if (!dock) return;
    setBusy(true); setMsg('introspecting… (an LLM call — a few seconds)');
    try {
      const r = await api.post<IntrospectResp>(`/ego/${dock}/introspect`, {});
      if (r.ok) {
        setMsg(`done — ${r.fresh ? 'built from template' : 'updated'}${r.snapshotted ? ' + trace snapshot' : ' (override, no new snapshot)'}`);
        await refresh(dock);
      } else setMsg(`failed: ${r.error}`);
    } catch (e) { setMsg(`failed: ${String((e as Error).message)}`); }
    finally { setBusy(false); }
  }, [dock, refresh]);

  const openSnapshot = useCallback(async (name: string) => {
    if (openSnap === name) { setOpenSnap(null); return; }
    const r = await api.get<{ ego: string }>(`/ego/${dock}/trace/${name}`).catch(() => null);
    setSnapText(r?.ego ?? '(could not load)'); setOpenSnap(name);
  }, [dock, openSnap]);

  const prettyTs = (name: string) => name.replace('T', '  ').replace(/-(\d{2})-(\d{2})-\d{3}Z$/, ':$1:$2').replace(/(\d{4})-(\d{2})-(\d{2})/, '$3/$2');

  return (
    <div style={{ padding: '18px 22px', maxWidth: 1100 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 14 }}>
        <h2 style={{ margin: 0 }}>🪞 Ego</h2>
        <select value={dock} onChange={(e) => setDock(e.target.value)}
          style={{ padding: '4px 8px', borderRadius: 6 }}>
          {docks.length === 0 && <option value="">no docks</option>}
          {docks.map((d) => <option key={d.name} value={d.name}>{d.name}</option>)}
        </select>
        <button onClick={introspect} disabled={busy || !dock}
          style={{ padding: '6px 14px', borderRadius: 8, background: busy ? '#26324a' : '#13243a',
            color: '#cfe', border: '1px solid #2c405e', cursor: busy ? 'wait' : 'pointer', fontWeight: 600 }}>
          {busy ? '◌ introspecting…' : '✦ Introspect'}
        </button>
        <span style={{ fontSize: 12, color: 'var(--dim)' }}>{msg}</span>
      </div>
      <p style={{ fontSize: 12, color: 'var(--dim)', marginTop: 0 }}>
        The dock's self, updated only by introspection (idle/manual). Re-introspecting within
        ~10&nbsp;min overrides in place; the <b>trace</b> keeps checkpoints of how the self evolved.
      </p>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 320px', gap: 18, alignItems: 'start' }}>
        {/* current ego */}
        <div style={{ background: '#0b0e16', border: '1px solid #1c2233', borderRadius: 10, padding: 16 }}>
          <div style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '.06em', color: 'var(--dim)', marginBottom: 8 }}>
            current ego {ego && !ego.exists && '· (template — no introspection yet)'}
          </div>
          {ego ? <EgoDoc text={ego.ego} /> : <div style={{ color: 'var(--dim)' }}>loading…</div>}
        </div>

        {/* trace — past introspections */}
        <div>
          <div style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '.06em', color: 'var(--dim)', marginBottom: 8 }}>
            trace — past introspections ({trace.length})
          </div>
          {trace.length === 0 && <div style={{ fontSize: 12, color: 'var(--dim)' }}>no snapshots yet — introspect a few times over time.</div>}
          {trace.map((e) => (
            <div key={e.name} style={{ marginBottom: 6 }}>
              <button onClick={() => openSnapshot(e.name)}
                style={{ width: '100%', textAlign: 'left', padding: '6px 10px', borderRadius: 6, fontSize: 12,
                  background: openSnap === e.name ? '#13243a' : '#0d1420', color: '#bcd',
                  border: '1px solid #1c2233', cursor: 'pointer', fontVariantNumeric: 'tabular-nums' }}>
                {openSnap === e.name ? '▾' : '▸'} {prettyTs(e.name)}
              </button>
              {openSnap === e.name && (
                <div style={{ background: '#0b0e16', border: '1px solid #1c2233', borderTop: 'none',
                  borderRadius: '0 0 6px 6px', padding: 10, maxHeight: 360, overflow: 'auto' }}>
                  <EgoDoc text={snapText} />
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

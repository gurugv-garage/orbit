import { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/station';
import { useDocks } from '../lib/useDocks';

/**
 * Behaviour tab — the orchestrator's governable surface (docs/decision-traces/orchestrator-v1-design.md).
 * Per dock: each standing behaviour (faceFollow, wakeUp) with its LIVE state (off / running)
 * and its TUNING variables — editable in real time. Reads GET /api/orchestrator/:dock for the
 * live state; writes the per-dock tunings back through the existing config key `orchestrator`
 * (POST /api/config), which the conductor reads on its next ~1Hz tick.
 *
 * (Distinct from the Tasks tab — that's the low-level running-process view; this is the
 * high-level "which standing intents are armed/running + their knobs".)
 */

interface BehaviourView {
  name: string;
  kind: 'task' | 'inproc';
  desired: 'off' | 'running';
  running: boolean;
  tunings: Record<string, unknown>;
}

export function Behaviours() {
  const docks = useDocks();
  const [dock, setDock] = useState<string>('');
  const [views, setViews] = useState<BehaviourView[]>([]);
  // the full `orchestrator` config json { dock: { behaviour: {tunings} } } — we edit + POST it.
  const [cfg, setCfg] = useState<Record<string, Record<string, Record<string, unknown>>>>({});
  const [flash, setFlash] = useState<string | null>(null);

  // pick the first dock once the roster loads.
  useEffect(() => { if (!dock && docks.length) setDock(docks[0]!.name); }, [docks, dock]);

  const refresh = useCallback(() => {
    if (!dock) return;
    api.get<{ behaviours: BehaviourView[] }>(`/orchestrator/${encodeURIComponent(dock)}`)
      .then((r) => setViews(r.behaviours ?? [])).catch(() => setViews([]));
    api.get<{ entries: Array<{ key: string; value: unknown }> }>('/config')
      .then((r) => {
        const o = r.entries.find((e) => e.key === 'orchestrator')?.value;
        setCfg((o && typeof o === 'object' ? o : {}) as typeof cfg);
      }).catch(() => {});
  }, [dock]);

  useEffect(() => { refresh(); const t = setInterval(refresh, 2000); return () => clearInterval(t); }, [refresh]);

  // write a single tuning for (dock, behaviour) → merge into the orchestrator config + POST.
  const setTuning = async (behaviour: string, key: string, value: unknown) => {
    const next = { ...cfg, [dock]: { ...(cfg[dock] ?? {}), [behaviour]: { ...((cfg[dock] ?? {})[behaviour] ?? {}), [key]: value } } };
    setCfg(next);
    try {
      await api.post('/config', { orchestrator: next });
      setFlash(`saved ${behaviour}.${key}`); setTimeout(() => setFlash(null), 1500);
      refresh();
    } catch { setFlash('save failed'); }
  };

  return (
    <div className="view">
      <h2 className="title">Behaviours</h2>
      <p className="subtitle">
        Standing behaviours the per-dock <b>orchestrator</b> arms + runs by tunable rules
        (<code>docs/decision-traces/orchestrator-v1-design.md</code>). Edits apply live (next ~1 s tick).
      </p>

      <div className="row" style={{ gap: 12, alignItems: 'center', marginBottom: 12 }}>
        <label className="muted">Dock</label>
        <select value={dock} onChange={(e) => setDock(e.target.value)}>
          {docks.map((d) => <option key={d.name} value={d.name}>{d.name}</option>)}
        </select>
        {flash && <span className="muted" style={{ fontSize: 12 }}>{flash}</span>}
      </div>

      {views.length === 0 && <p className="muted">No behaviours (dock offline, or the orchestrator hasn't ticked yet).</p>}

      <div className="cards">
        {views.map((b) => <BehaviourCard key={b.name} b={b} onTune={setTuning} />)}
      </div>
    </div>
  );
}

function StatePill({ b }: { b: BehaviourView }) {
  // running (green) / armed-but-not-running (amber) / off (grey).
  const [bg, label] = b.running ? ['#2e7d32', 'RUNNING'] : b.desired === 'running' ? ['#b8860b', 'ARMING'] : ['#444', 'OFF'];
  return <span style={{ background: bg, color: '#fff', borderRadius: 6, padding: '2px 8px', fontSize: 11, fontWeight: 700 }}>{label}</span>;
}

function BehaviourCard({ b, onTune }: { b: BehaviourView; onTune: (behaviour: string, key: string, value: unknown) => void }) {
  const enabled = b.tunings.enabled !== false;
  return (
    <div className="card" style={{ minWidth: 280 }}>
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
        <h3 style={{ margin: 0 }}>{b.name} <span className="muted mono" style={{ fontSize: 11 }}>· {b.kind}</span></h3>
        <StatePill b={b} />
      </div>
      <label className="row" style={{ gap: 8, alignItems: 'center', marginTop: 10 }}>
        <input type="checkbox" checked={enabled} onChange={(e) => onTune(b.name, 'enabled', e.target.checked)} />
        <span>enabled</span>
      </label>
      <div style={{ marginTop: 8 }}>
        {Object.entries(b.tunings).filter(([k]) => k !== 'enabled').map(([k, v]) => (
          <Knob key={k} bName={b.name} k={k} v={v} onTune={onTune} />
        ))}
      </div>
    </div>
  );
}

function Knob({ bName, k, v, onTune }: { bName: string; k: string; v: unknown; onTune: (b: string, k: string, value: unknown) => void }) {
  const [draft, setDraft] = useState(String(v ?? ''));
  useEffect(() => { setDraft(String(v ?? '')); }, [v]);
  const isNum = typeof v === 'number';
  const commit = () => {
    const value: unknown = isNum ? Number(draft) : draft;
    if (isNum && Number.isNaN(value as number)) return;
    if (value !== v) onTune(bName, k, value);
  };
  return (
    <div className="row" style={{ gap: 8, alignItems: 'center', margin: '4px 0' }}>
      <label className="muted mono" style={{ fontSize: 11, minWidth: 130 }}>{k}{isNum && k.endsWith('Ms') ? ' (ms)' : ''}</label>
      <input
        value={draft} onChange={(e) => setDraft(e.target.value)}
        onBlur={commit} onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
        style={{ width: 160 }}
      />
    </div>
  );
}

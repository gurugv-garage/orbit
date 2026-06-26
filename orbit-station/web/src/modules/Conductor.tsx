import { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/station';
import { useDocks } from '../lib/useDocks';

/**
 * Conductor tab — the per-dock conductor's governable surface
 * (docs/decision-traces/conductor-v1-design.md). One CONDUCTOR per dock governs a set of
 * CONDUCTED things, each either a TASK (a generic spawnable process, e.g. faceFollow) or a
 * BEHAVIOUR (a reaction hardcoded in-place at design time, e.g. wakeUp — woven into the brain).
 * Per dock: each conducted thing's LIVE state (off / running), its KIND, where a behaviour is
 * INSTRUMENTED in the code, and its TUNING variables — editable in real time. Reads
 * GET /api/conductor/:dock for the live state; writes the per-dock tunings back through the
 * config key `conductor` (POST /api/config), which the conductor reads on its next ~1Hz tick.
 *
 * (Distinct from the Tasks tab — that's the low-level running-process view; this is the
 * high-level "which standing intents are armed/running + their knobs".)
 */

interface ConductedView {
  name: string;
  kind: 'task' | 'behaviour';
  desired: 'off' | 'running';
  running: boolean;
  tunings: Record<string, unknown>;
  override: 'run' | 'off' | null;
  /** where a behaviour is hardcoded in the code (kind:'behaviour' only). */
  instrumentedAt: string | null;
  /** the packaged task this conducts (kind:'task' only). */
  taskName: string | null;
}

export function Conductor() {
  const docks = useDocks();
  const [dock, setDock] = useState<string>('');
  const [views, setViews] = useState<ConductedView[]>([]);
  // the full `conductor` config json { dock: { name: {tunings} } } — we edit + POST it.
  const [cfg, setCfg] = useState<Record<string, Record<string, Record<string, unknown>>>>({});
  const [flash, setFlash] = useState<string | null>(null);

  // pick the first dock once the roster loads.
  useEffect(() => { if (!dock && docks.length) setDock(docks[0]!.name); }, [docks, dock]);

  const refresh = useCallback(() => {
    if (!dock) return;
    api.get<{ conducted: ConductedView[] }>(`/conductor/${encodeURIComponent(dock)}`)
      .then((r) => setViews(r.conducted ?? [])).catch(() => setViews([]));
    api.get<{ entries: Array<{ key: string; value: unknown }> }>('/config')
      .then((r) => {
        const o = r.entries.find((e) => e.key === 'conductor')?.value;
        setCfg((o && typeof o === 'object' ? o : {}) as typeof cfg);
      }).catch(() => {});
  }, [dock]);

  useEffect(() => { refresh(); const t = setInterval(refresh, 2000); return () => clearInterval(t); }, [refresh]);

  // write a single tuning for (dock, name) → merge into the conductor config + POST.
  const setTuning = async (name: string, key: string, value: unknown) => {
    const next = { ...cfg, [dock]: { ...(cfg[dock] ?? {}), [name]: { ...((cfg[dock] ?? {})[name] ?? {}), [key]: value } } };
    setCfg(next);
    try {
      await api.post('/config', { conductor: next });
      setFlash(`saved ${name}.${key}`); setTimeout(() => setFlash(null), 1500);
      refresh();
    } catch { setFlash('save failed'); }
  };

  return (
    <div className="view">
      <h2 className="title">Conductor</h2>
      <p className="subtitle">
        The per-dock <b>conductor</b> governs a set of conducted things — <b>tasks</b> (spawned
        processes) and <b>behaviours</b> (reactions hardcoded in-place) — by tunable rules
        (<code>docs/decision-traces/conductor-v1-design.md</code>). Edits apply live (next ~1 s tick).
      </p>

      <div className="row" style={{ gap: 12, alignItems: 'center', marginBottom: 12 }}>
        <label className="muted">Dock</label>
        <select value={dock} onChange={(e) => setDock(e.target.value)}>
          {docks.map((d) => <option key={d.name} value={d.name}>{d.name}</option>)}
        </select>
        {flash && <span className="muted" style={{ fontSize: 12 }}>{flash}</span>}
      </div>

      {views.length === 0 && <p className="muted">Nothing conducted (dock offline, or the conductor hasn't ticked yet).</p>}

      <div className="cards">
        {views.map((c) => <ConductedCard key={c.name} dock={dock} c={c} onTune={setTuning} onChanged={refresh} />)}
      </div>
    </div>
  );
}

function StatePill({ c }: { c: ConductedView }) {
  // running (green) / armed-but-not-running (amber) / off (grey).
  const [bg, label] = c.running ? ['#2e7d32', 'RUNNING'] : c.desired === 'running' ? ['#b8860b', 'ARMING'] : ['#444', 'OFF'];
  return <span style={{ background: bg, color: '#fff', borderRadius: 6, padding: '2px 8px', fontSize: 11, fontWeight: 700 }}>{label}</span>;
}

function KindTag({ c }: { c: ConductedView }) {
  // a clear task/behaviour badge — the two are governed the same but built differently.
  const isTask = c.kind === 'task';
  const [bg, label] = isTask ? ['#1d4e89', '⚙ TASK'] : ['#5a3e85', '✦ BEHAVIOUR'];
  return <span title={isTask ? 'a spawned process' : 'a reaction hardcoded in-place'}
    style={{ background: bg, color: '#fff', borderRadius: 6, padding: '2px 8px', fontSize: 10, fontWeight: 700 }}>{label}</span>;
}

function ConductedCard({ dock, c, onTune, onChanged }: {
  dock: string; c: ConductedView; onTune: (name: string, key: string, value: unknown) => void; onChanged: () => void;
}) {
  const enabled = c.tunings.enabled !== false;
  const act = async (action: 'run' | 'stop' | 'auto') => {
    try { await api.post(`/conductor/${encodeURIComponent(dock)}/${encodeURIComponent(c.name)}/${action}`, {}); onChanged(); } catch { /* */ }
  };
  return (
    <div className="card" style={{ minWidth: 300 }}>
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
        <div className="row" style={{ gap: 8, alignItems: 'center' }}>
          <h3 style={{ margin: 0 }}>{c.name}</h3>
          <KindTag c={c} />
        </div>
        <StatePill c={c} />
      </div>
      {/* where it lives in the code — a behaviour is hardcoded in-place; a task is a process. */}
      {c.kind === 'behaviour' && c.instrumentedAt && (
        <div className="muted mono" style={{ fontSize: 10, marginTop: 6, wordBreak: 'break-word' }}>
          instrumented: {c.instrumentedAt}
        </div>
      )}
      {c.kind === 'task' && c.taskName && (
        <div className="muted mono" style={{ fontSize: 10, marginTop: 6 }}>task: {c.taskName}</div>
      )}
      {/* manual override — RUN NOW forces it on regardless of the rule; STOP forces off;
          AUTO returns to the rule. The current pin (if any) is shown. */}
      <div className="row" style={{ gap: 6, alignItems: 'center', marginTop: 10 }}>
        <button onClick={() => act('run')} style={{ fontSize: 12 }}>▶ Run now</button>
        <button onClick={() => act('stop')} style={{ fontSize: 12 }}>■ Stop</button>
        <button onClick={() => act('auto')} style={{ fontSize: 12 }} disabled={!c.override}>↺ Auto</button>
        {c.override && <span className="muted" style={{ fontSize: 11 }}>pinned: {c.override === 'run' ? 'ON' : 'OFF'}</span>}
      </div>
      <label className="row" style={{ gap: 8, alignItems: 'center', marginTop: 10 }}>
        <input type="checkbox" checked={enabled} onChange={(e) => onTune(c.name, 'enabled', e.target.checked)} />
        <span>enabled</span>
      </label>
      <div style={{ marginTop: 8 }}>
        {Object.entries(c.tunings).filter(([k]) => k !== 'enabled').map(([k, v]) => (
          <Knob key={k} name={c.name} k={k} v={v} onTune={onTune} />
        ))}
      </div>
    </div>
  );
}

function Knob({ name, k, v, onTune }: { name: string; k: string; v: unknown; onTune: (name: string, k: string, value: unknown) => void }) {
  const [draft, setDraft] = useState(String(v ?? ''));
  useEffect(() => { setDraft(String(v ?? '')); }, [v]);
  const isNum = typeof v === 'number';
  const commit = () => {
    const value: unknown = isNum ? Number(draft) : draft;
    if (isNum && Number.isNaN(value as number)) return;
    if (value !== v) onTune(name, k, value);
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

import { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/station';
import { useStationEvents } from '../lib/useStation';

type Scope = 'station' | 'dock' | 'body';
type ScopeCfg = Record<string, unknown>;
interface ConfigResp { defaults: Record<Scope, ScopeCfg>; effective: Record<Scope, ScopeCfg>; }

export function Config() {
  const [cfg, setCfg] = useState<ConfigResp | null>(null);
  const [pushed, setPushed] = useState<string | null>(null);

  const load = useCallback(() => { api.get<ConfigResp>('/config').then(setCfg).catch(() => {}); }, []);
  useEffect(load, [load]);

  // reflect pushes from anywhere (another console editing)
  useStationEvents('config', useCallback((e) => {
    if (e.kind === 'changed') {
      const p = e.payload as { scope: string };
      setPushed(`pushed ${p.scope} · ${new Date(e.ts).toLocaleTimeString()}`);
      load();
    }
  }, [load]));

  if (!cfg) return <section><h2 className="title">Config</h2><p className="subtitle">loading…</p></section>;

  const scopes = Object.keys(cfg.effective) as Scope[];

  return (
    <section>
      <h2 className="title">Config</h2>
      <p className="subtitle">Defaults + live overrides. Saving pushes the delta to firmware &amp; app over WS.</p>
      {pushed && <div className="row" style={{ marginBottom: 10 }}><span className="pill good">{pushed}</span></div>}
      <div className="grid">
        {scopes.map((s) => (
          <ScopeCard key={s} scope={s} effective={cfg.effective[s]} defaults={cfg.defaults[s]} onSaved={load} />
        ))}
      </div>
    </section>
  );
}

function ScopeCard({ scope, effective, defaults, onSaved }: { scope: Scope; effective: ScopeCfg; defaults: ScopeCfg; onSaved: () => void }) {
  const [draft, setDraft] = useState<ScopeCfg>(effective);
  const [saving, setSaving] = useState(false);
  useEffect(() => setDraft(effective), [effective]);

  const dirty = JSON.stringify(draft) !== JSON.stringify(effective);

  const save = async () => {
    setSaving(true);
    const delta: ScopeCfg = {};
    for (const k of Object.keys(draft)) if (draft[k] !== effective[k]) delta[k] = draft[k];
    await api.patch(`/config/${scope}`, delta);
    setSaving(false);
    onSaved();
  };

  return (
    <div className="card">
      <h3>{scope}</h3>
      {Object.entries(draft).map(([k, v]) => (
        <div key={k} style={{ marginBottom: 8 }}>
          <label className="field">
            {k}
            <Field value={v} dflt={defaults[k]} onChange={(nv) => setDraft((d) => ({ ...d, [k]: nv }))} />
          </label>
        </div>
      ))}
      <div className="row">
        <button className="primary" disabled={!dirty || saving} onClick={save}>{saving ? 'pushing…' : 'save + push'}</button>
        {dirty && <span className="muted">unsaved</span>}
      </div>
    </div>
  );
}

function Field({ value, dflt, onChange }: { value: unknown; dflt: unknown; onChange: (v: unknown) => void }) {
  const type = typeof (dflt ?? value);
  if (type === 'boolean') {
    return <input type="checkbox" checked={!!value} onChange={(e) => onChange(e.target.checked)} />;
  }
  if (type === 'number') {
    return <input type="number" value={Number(value)} onChange={(e) => onChange(Number(e.target.value))} />;
  }
  return <input type="text" value={String(value)} onChange={(e) => onChange(e.target.value)} />;
}

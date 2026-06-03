import { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/station';
import { useStationEvents } from '../lib/useStation';

type ValueType = 'number' | 'boolean' | 'text' | 'json';
interface Entry {
  key: string; type: ValueType; value: unknown;
  lastUpdated: number; isDefault: boolean;
  tags: string[];
  /** ids of peers currently registered interest in this key (live). */
  interested: string[];
  label?: string; description?: string; jsonSchema?: unknown;
}
interface ConfigResp { entries: Entry[]; }

const TAG_ORDER = ['station', 'brain', 'body'];

export function Config() {
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [flash, setFlash] = useState<string | null>(null);

  const load = useCallback(() => {
    api.get<ConfigResp>('/config').then((r) => setEntries(r.entries)).catch(() => {});
  }, []);
  useEffect(load, [load]);

  // reflect pushes from anywhere (another console editing, a force-push)
  useStationEvents('config', useCallback((e) => {
    if (e.kind === 'changed') {
      const p = e.payload as { key: string };
      setFlash(`pushed ${p.key} · ${new Date(e.ts).toLocaleTimeString()}`);
      load();
    }
  }, [load]));

  if (!entries) return <section><h2 className="title">Config</h2><p className="subtitle">loading…</p></section>;

  // group by primary tag (UI only). Keys are flat/global and may be shared by
  // several components; a key shows under its first tag.
  const tags = [...new Set(entries.flatMap((e) => e.tags))]
    .sort((a, b) => (TAG_ORDER.indexOf(a) + 1 || 99) - (TAG_ORDER.indexOf(b) + 1 || 99));

  return (
    <section>
      <h2 className="title">Config</h2>
      <p className="subtitle">Typed, versioned, flat config keys. Saving validates &amp; pushes to peers that registered interest. Tags group keys; “wants” shows who’s live-subscribed.</p>
      {flash && <div className="row" style={{ marginBottom: 10 }}><span className="pill good">{flash}</span></div>}
      <div className="grid">
        {tags.map((tag) => (
          <div key={tag} className="card">
            <h3>{tag}</h3>
            {entries.filter((e) => e.tags[0] === tag).map((e) => (
              <EntryRow key={e.key} entry={e} onChanged={load} />
            ))}
          </div>
        ))}
      </div>
    </section>
  );
}

function EntryRow({ entry, onChanged }: { entry: Entry; onChanged: () => void }) {
  const [draft, setDraft] = useState<unknown>(entry.value);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { setDraft(entry.value); setErr(null); }, [entry.value, entry.lastUpdated]);

  const dirty = JSON.stringify(draft) !== JSON.stringify(entry.value);

  const save = async () => {
    setBusy(true); setErr(null);
    try {
      const r = await api.patch<{ applied: Entry[]; errors: Record<string, unknown> }>(`/config`, { [entry.key]: draft });
      if (r.errors && r.errors[entry.key]) setErr(fmtIssues(r.errors[entry.key]));
      else onChanged();
    } catch (e) { setErr(String(e)); }
    setBusy(false);
  };

  const forcePush = async () => {
    setBusy(true);
    try { await api.post(`/config/${encodeURIComponent(entry.key)}/push`, {}); } catch { /* flash via WS */ }
    setBusy(false);
  };

  const reset = async () => {
    setBusy(true);
    try { await api.post(`/config/${encodeURIComponent(entry.key)}/reset`, {}); onChanged(); } catch { /* */ }
    setBusy(false);
  };

  return (
    <div className="cfg-entry">
      <div className="cfg-entry-head">
        <span className="cfg-key" title={entry.description}>{entry.label ?? entry.key}</span>
        <span className="pill sm">{entry.type}</span>
        {entry.isDefault
          ? <span className="muted sm" title="no override; the baked default">default</span>
          : <span className="muted sm" title={new Date(entry.lastUpdated).toLocaleString()}>edited {rel(entry.lastUpdated)}</span>}
        {entry.interested.length > 0 && (
          <span className="muted sm" title={`live subscribers: ${entry.interested.join(', ')}`}>
            wants {entry.interested.length}
          </span>
        )}
      </div>
      <ValueEditor type={entry.type} value={draft} schema={entry.jsonSchema} onChange={setDraft} onError={setErr} />
      {err && <div className="cfg-err">{err}</div>}
      <div className="row cfg-actions">
        <button className="primary" disabled={!dirty || busy} onClick={save}>{busy ? '…' : 'save + push'}</button>
        <button disabled={busy} onClick={forcePush} title="re-send current value to devices">force push</button>
        {!entry.isDefault && <button disabled={busy} onClick={reset} title="drop override → baked default">reset</button>}
        {dirty && <span className="muted sm">unsaved</span>}
      </div>
    </div>
  );
}

function ValueEditor({ type, value, schema, onChange, onError }: {
  type: ValueType; value: unknown; schema?: unknown;
  onChange: (v: unknown) => void; onError: (e: string | null) => void;
}) {
  if (type === 'boolean') {
    return <label className="cfg-bool"><input type="checkbox" checked={!!value} onChange={(e) => onChange(e.target.checked)} /> {String(!!value)}</label>;
  }
  if (type === 'number') {
    return <input type="number" value={Number(value)} onChange={(e) => onChange(Number(e.target.value))} />;
  }
  if (type === 'json') return <JsonEditor value={value} schema={schema} onChange={onChange} onError={onError} />;
  return <input type="text" value={String(value ?? '')} onChange={(e) => onChange(e.target.value)} />;
}

/** Textarea JSON editor with live parse-validation; schema is shown as a hint. */
function JsonEditor({ value, schema, onChange, onError }: {
  value: unknown; schema?: unknown; onChange: (v: unknown) => void; onError: (e: string | null) => void;
}) {
  const [text, setText] = useState(() => JSON.stringify(value, null, 2));
  const [showSchema, setShowSchema] = useState(false);
  useEffect(() => { setText(JSON.stringify(value, null, 2)); }, [value]);

  const onText = (t: string) => {
    setText(t);
    try { onChange(JSON.parse(t)); onError(null); }
    catch (e) { onError(`invalid JSON: ${(e as Error).message}`); }
  };

  return (
    <div className="cfg-json">
      <textarea className="mono" rows={Math.min(20, text.split('\n').length + 1)} value={text} onChange={(e) => onText(e.target.value)} spellCheck={false} />
      {schema != null && (
        <div className="cfg-schema">
          <button className="linklike sm" onClick={() => setShowSchema((s) => !s)}>{showSchema ? 'hide' : 'show'} schema</button>
          {showSchema && <pre className="mono sm">{JSON.stringify(schema, null, 2)}</pre>}
        </div>
      )}
    </div>
  );
}

function fmtIssues(issues: unknown): string {
  if (Array.isArray(issues)) return issues.map((i: { path?: unknown[]; message?: string }) => `${(i.path ?? []).join('.') || '(root)'}: ${i.message}`).join('; ');
  return String(issues);
}
function rel(ts: number): string {
  if (!ts) return '';
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

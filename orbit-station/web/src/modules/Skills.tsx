import { useCallback, useEffect, useState } from 'react';

/**
 * Skills console (docs/SERVER-BRAIN-SELFMOD.md §1a) — install/list/remove a
 * dock's pi Skills. Tenancy is the folder: each dock has its own skills lane;
 * an installed SKILL.md is picked up by that dock's NEXT brain session.
 */

interface SkillInfo { name: string; description: string; sizeBytes: number; }

const SAMPLE = `---
name: tea-brewing
description: How to brew the perfect cup of tea. Use when the user asks about making tea, steep times, or temperatures.
---

# Brewing tea

When the user asks how to brew tea:
- Green tea: 80°C, 2 minutes.
- Black tea: 95°C, 4 minutes.
- Herbal: boiling, 5+ minutes.

Always ask which kind they have, then give the matching guidance in one short, warm sentence.
`;

export function Skills() {
  const [docks, setDocks] = useState<string[]>([]);
  const [dock, setDock] = useState('');
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const [draft, setDraft] = useState(SAMPLE);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  // discover docks with a brain lane; keep the field editable for new ones.
  useEffect(() => {
    (async () => {
      try {
        const r = await fetch('/api/brain/docks');
        if (r.ok) {
          const lanes = (await r.json()) as { dock: string }[];
          const names = lanes.map((l) => l.dock);
          setDocks(names);
          if (!dock && names.length > 0) setDock(names[0]!);
        }
      } catch { /* ignore */ }
    })();
  }, [dock]);

  const refresh = useCallback(async (d: string) => {
    if (!d.trim()) { setSkills([]); return; }
    try {
      const r = await fetch(`/api/brain/${encodeURIComponent(d)}/skills`);
      if (r.ok) setSkills(await r.json());
      else setSkills([]);
    } catch { setSkills([]); }
  }, []);

  useEffect(() => { void refresh(dock); }, [dock, refresh]);

  const install = useCallback(async () => {
    if (!dock.trim() || !draft.trim()) return;
    setBusy(true); setMsg(null);
    try {
      const r = await fetch(`/api/brain/${encodeURIComponent(dock)}/skills`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content: draft }),
      });
      const body = await r.json();
      if (r.ok) {
        setMsg({ kind: 'ok', text: `Installed "${body.name}". The dock's next session will pick it up.` });
        await refresh(dock);
      } else {
        setMsg({ kind: 'err', text: body.error ?? 'install failed' });
      }
    } catch (e) {
      setMsg({ kind: 'err', text: String(e) });
    } finally {
      setBusy(false);
    }
  }, [dock, draft, refresh]);

  const remove = useCallback(async (name: string) => {
    if (!confirm(`Remove skill "${name}" from ${dock}?`)) return;
    try {
      const r = await fetch(`/api/brain/${encodeURIComponent(dock)}/skills/${encodeURIComponent(name)}`, { method: 'DELETE' });
      if (r.ok) { setMsg({ kind: 'ok', text: `Removed "${name}".` }); await refresh(dock); }
      else setMsg({ kind: 'err', text: 'remove failed' });
    } catch (e) { setMsg({ kind: 'err', text: String(e) }); }
  }, [dock, refresh]);

  return (
    <section>
      <h2 className="title">Skills</h2>
      <p className="subtitle">
        Per-dock pi Skills — install a <code>SKILL.md</code> and the dock loads it on its next session
        (progressive disclosure: names in the prompt, full body pulled via <code>invoke_skill</code>).
        Tenancy is the folder; one dock never sees another's skills.
      </p>

      <div className="card">
        <h3>Dock</h3>
        <div className="row" style={{ gap: 8, alignItems: 'center' }}>
          {docks.length > 0 && (
            <select value={docks.includes(dock) ? dock : ''} onChange={(e) => setDock(e.target.value)}>
              <option value="">— pick a dock —</option>
              {docks.map((d) => <option key={d} value={d}>{d}</option>)}
            </select>
          )}
          <input
            placeholder="dock name (e.g. web-test)"
            value={dock}
            onChange={(e) => setDock(e.target.value)}
            style={{ minWidth: 200 }}
          />
        </div>
      </div>

      <div className="card">
        <h3>Installed{dock ? ` — ${dock}` : ''}</h3>
        {!dock.trim() ? (
          <div className="muted">Pick a dock to see its skills.</div>
        ) : skills.length === 0 ? (
          <div className="muted">No skills installed. Add one below.</div>
        ) : (
          <div className="feed">
            {skills.map((s) => (
              <div className="ln" key={s.name} style={{ alignItems: 'baseline' }}>
                <span className="tp mono">{s.name}</span>
                <span className="muted" style={{ flex: 1 }}>{s.description}</span>
                <span className="muted mono">{(s.sizeBytes / 1024).toFixed(1)} KB</span>
                <button onClick={() => void remove(s.name)}>remove</button>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="card">
        <h3>Install a skill</h3>
        <p className="muted">
          Paste a <code>SKILL.md</code> — YAML frontmatter (<code>name</code>, <code>description</code>) then markdown instructions.
        </p>
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          spellCheck={false}
          rows={16}
          style={{ width: '100%', fontFamily: 'monospace', fontSize: 13 }}
        />
        <div className="row" style={{ gap: 8, marginTop: 8, alignItems: 'center' }}>
          <button onClick={() => void install()} disabled={busy || !dock.trim() || !draft.trim()}>
            {busy ? 'Installing…' : `Install to ${dock || '…'}`}
          </button>
          {msg && <span className={msg.kind === 'ok' ? 'muted' : 'err'}>{msg.text}</span>}
        </div>
      </div>
    </section>
  );
}

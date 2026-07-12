import { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/station';
import { useDocks } from '../lib/useDocks';

/**
 * Ego — the dock's per-dock ego document (identity + story), its introspection, and its trace.
 * See docs/decision-traces/ego.md.
 *
 * Debuggability: each ego version (current + past) is shown WITH the exact inputs that produced
 * it — the prompt template, model, the reconciled perception feed, the addressed conversation,
 * and the trace. The Simulate button replays introspection with edited inputs (or re-pulled live
 * perception) WITHOUT saving, so you can see what the output would have been.
 */

interface EgoResp { dock: string; ego: string; exists: boolean }
interface TraceResp { dock: string; entries: { name: string; ts: string }[] }
interface IntrospectResp { ok: boolean; fresh?: boolean; snapshotted?: boolean; ego?: string; error?: string }

/** The structured inputs one introspection consumed (mirrors server IntrospectInputs). */
interface Inputs {
  promptTemplate: string;
  model: string;
  currentEgo: string;
  recentExperience: string;
  trace: { name: string; text: string }[];
  trigger: string;
  at: string;
}

const card = { background: '#0b0e16', border: '1px solid #1c2233', borderRadius: 10 } as const;
const label = { fontSize: 11, textTransform: 'uppercase', letterSpacing: '.06em', color: 'var(--dim)' } as const;

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

/** The perception feed the ego read is one string with labelled blocks — split it for readability
 *  ("WHAT YOU SENSED …", "A CONVERSATION YOU HAD …", "EARLIER …", offline markers). */
function ExperienceView({ text }: { text: string }) {
  if (!text.trim()) return <div style={{ fontSize: 12, color: 'var(--dim)' }}>(no recent experience — the ego introspected on little/none)</div>;
  return (
    <pre style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', margin: 0, fontSize: 12, lineHeight: 1.5,
      fontFamily: 'ui-monospace, SFMono-Regular, monospace', color: '#cdd6e5' }}>
      {text.split('\n').map((line, i) => {
        const isHdr = /^(WHAT YOU SENSED|A CONVERSATION|EARLIER|RECENTLY|JUST NOW)/.test(line);
        const isOffline = line.includes('offline') && line.includes('DOWNTIME');
        const isAddr = line.includes('[→ TO YOU]');
        const isOverheard = line.includes('[overheard');
        return <span key={i} style={{
          display: 'block',
          color: isHdr ? 'var(--accent)' : isOffline ? '#e6a23c' : isAddr ? '#7fd18b' : isOverheard ? '#8894a8' : undefined,
          fontWeight: isHdr ? 700 : undefined,
        }}>{line || ' '}</span>;
      })}
    </pre>
  );
}

/** A collapsible section header. */
function Fold({ title, sub, open, onClick }: { title: string; sub?: string; open: boolean; onClick: () => void }) {
  return (
    <button onClick={onClick} style={{ width: '100%', textAlign: 'left', padding: '7px 10px', borderRadius: 6,
      background: open ? '#13243a' : '#0d1420', color: '#bcd', border: '1px solid #1c2233', cursor: 'pointer',
      display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
      <span>{open ? '▾' : '▸'} <b style={{ fontSize: 12 }}>{title}</b></span>
      {sub && <span style={{ fontSize: 11, color: 'var(--dim)' }}>{sub}</span>}
    </button>
  );
}

/** The structured inputs panel — shows every input that produced an ego, each foldable. */
function InputsPanel({ inputs }: { inputs: Inputs | null }) {
  const [open, setOpen] = useState<string | null>('experience');
  if (!inputs) return <div style={{ fontSize: 12, color: 'var(--dim)', padding: 8 }}>no captured inputs for this version (predates input-capture, or never introspected).</div>;
  const tog = (k: string) => setOpen(open === k ? null : k);
  const expChars = inputs.recentExperience?.length ?? 0;
  const convoLines = (inputs.recentExperience.match(/^(person|me):/gm) ?? []).length;
  return (
    <div>
      <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', fontSize: 12, color: 'var(--dim)', marginBottom: 8 }}>
        <span>model <b style={{ color: '#bcd' }}>{inputs.model}</b></span>
        <span>trigger <b style={{ color: '#bcd' }}>{inputs.trigger}</b></span>
        <span>at <b style={{ color: '#bcd', fontVariantNumeric: 'tabular-nums' }}>{inputs.at?.slice(0, 19).replace('T', ' ')}</b></span>
      </div>

      <Fold title="🌊 recent experience (the perception + conversation it read)" sub={`${expChars} chars · ${convoLines} convo lines`} open={open === 'experience'} onClick={() => tog('experience')} />
      {open === 'experience' && <div style={{ ...card, padding: 10, marginBottom: 6, maxHeight: 320, overflow: 'auto' }}><ExperienceView text={inputs.recentExperience} /></div>}

      <Fold title="🪞 current ego (what it was before)" open={open === 'ego'} onClick={() => tog('ego')} />
      {open === 'ego' && <div style={{ ...card, padding: 10, marginBottom: 6, maxHeight: 280, overflow: 'auto' }}><EgoDoc text={inputs.currentEgo} /></div>}

      <Fold title="🧵 trace fed in (past egos)" sub={`${inputs.trace?.length ?? 0} snapshots`} open={open === 'trace'} onClick={() => tog('trace')} />
      {open === 'trace' && (
        <div style={{ ...card, padding: 10, marginBottom: 6, maxHeight: 280, overflow: 'auto' }}>
          {(inputs.trace ?? []).map((t) => <div key={t.name} style={{ marginBottom: 8 }}>
            <div style={{ fontSize: 11, color: 'var(--dim)' }}>--- {t.name} ---</div>
            <EgoDoc text={t.text} />
          </div>)}
          {!inputs.trace?.length && <span style={{ fontSize: 12, color: 'var(--dim)' }}>(no trace fed in — early self)</span>}
        </div>
      )}

      <Fold title="📜 prompt template (the rubric)" sub={`${inputs.promptTemplate?.length ?? 0} chars`} open={open === 'prompt'} onClick={() => tog('prompt')} />
      {open === 'prompt' && <div style={{ ...card, padding: 10, marginBottom: 6, maxHeight: 320, overflow: 'auto' }}>
        <pre style={{ whiteSpace: 'pre-wrap', margin: 0, fontSize: 12, lineHeight: 1.5, color: '#aeb8c8' }}>{inputs.promptTemplate}</pre>
      </div>}
    </div>
  );
}

/** The Simulate modal — edit any input, optionally re-pull perception live, run, see the alt output. */
function SimulateModal({ dock, base, onClose }: { dock: string; base: Inputs; onClose: () => void }) {
  const [prompt, setPrompt] = useState(base.promptTemplate);
  const [model, setModel] = useState(base.model);
  const [currentEgo, setCurrentEgo] = useState(base.currentEgo);
  const [experience, setExperience] = useState(base.recentExperience);
  const [refreshPerception, setRefreshPerception] = useState(false);
  const [out, setOut] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const run = useCallback(async () => {
    setBusy(true); setErr(''); setOut('');
    try {
      const r = await api.post<{ ok: boolean; ego?: string; error?: string; usedInputs?: Inputs }>(`/ego/${dock}/simulate`, {
        refreshPerception,
        inputs: {
          promptTemplate: prompt, model, currentEgo,
          // when re-pulling live, don't send the (stale) experience — let the server fill it
          ...(refreshPerception ? {} : { recentExperience: experience }),
        },
      });
      if (r.ok) { setOut(r.ego ?? ''); if (refreshPerception && r.usedInputs) setExperience(r.usedInputs.recentExperience); }
      else setErr(r.error ?? 'failed');
    } catch (e) { setErr(String((e as Error).message)); }
    finally { setBusy(false); }
  }, [dock, prompt, model, currentEgo, experience, refreshPerception]);

  const ta = { width: '100%', background: '#0a0d14', color: '#cdd6e5', border: '1px solid #1c2233',
    borderRadius: 6, padding: 8, fontSize: 12, fontFamily: 'ui-monospace, monospace', lineHeight: 1.5, resize: 'vertical' as const };

  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(2,4,10,.72)', zIndex: 50,
      display: 'flex', alignItems: 'flex-start', justifyContent: 'center', padding: '3vh 2vw', overflow: 'auto' }}>
      <div onClick={(e) => e.stopPropagation()} style={{ ...card, width: 'min(1200px, 96vw)', padding: 18 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 }}>
          <h3 style={{ margin: 0 }}>🧪 Simulate introspection</h3>
          <span style={{ fontSize: 12, color: 'var(--dim)' }}>edit any input, run, see the would-be ego — never saved</span>
          <button onClick={onClose} style={{ marginLeft: 'auto', padding: '4px 10px', borderRadius: 6, background: '#13243a', color: '#bcd', border: '1px solid #2c405e', cursor: 'pointer' }}>✕ close</button>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
          {/* inputs (editable) */}
          <div>
            <div style={{ ...label, marginBottom: 6 }}>inputs</div>
            <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 8 }}>
              <span style={{ fontSize: 12, color: 'var(--dim)' }}>model</span>
              <select value={model} onChange={(e) => setModel(e.target.value)} style={{ padding: '4px 8px', borderRadius: 6, background: '#0a0d14', color: '#cdd6e5', border: '1px solid #1c2233' }}>
                <option value="gemini-2.5-flash">gemini-2.5-flash</option>
                <option value="gemini-2.5-pro">gemini-2.5-pro</option>
                <option value="gemini-2.0-flash">gemini-2.0-flash</option>
              </select>
              <label style={{ fontSize: 12, color: 'var(--dim)', display: 'flex', gap: 5, alignItems: 'center', cursor: 'pointer' }}>
                <input type="checkbox" checked={refreshPerception} onChange={(e) => setRefreshPerception(e.target.checked)} />
                re-pull perception LIVE (test against now)
              </label>
            </div>
            <div style={{ ...label, marginBottom: 4 }}>recent experience {refreshPerception && <span style={{ color: '#e6a23c' }}>· will be re-pulled live on run</span>}</div>
            <textarea value={experience} disabled={refreshPerception} onChange={(e) => setExperience(e.target.value)} rows={10} style={{ ...ta, marginBottom: 10, opacity: refreshPerception ? 0.5 : 1 }} />
            <div style={{ ...label, marginBottom: 4 }}>current ego</div>
            <textarea value={currentEgo} onChange={(e) => setCurrentEgo(e.target.value)} rows={8} style={{ ...ta, marginBottom: 10 }} />
            <div style={{ ...label, marginBottom: 4 }}>prompt template</div>
            <textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} rows={8} style={ta} />
            <button onClick={run} disabled={busy} style={{ marginTop: 12, padding: '8px 18px', borderRadius: 8,
              background: busy ? '#26324a' : '#153a2a', color: '#cfe', border: '1px solid #2c5e40', cursor: busy ? 'wait' : 'pointer', fontWeight: 600 }}>
              {busy ? '◌ running…' : '▶ Run simulation'}
            </button>
          </div>

          {/* output (would-be ego) */}
          <div>
            <div style={{ ...label, marginBottom: 6 }}>would-be ego (not saved)</div>
            <div style={{ ...card, padding: 12, minHeight: 300, maxHeight: '68vh', overflow: 'auto' }}>
              {err && <div style={{ color: '#e26a6a', fontSize: 13 }}>{err}</div>}
              {out ? <EgoDoc text={out} /> : !err && <div style={{ color: 'var(--dim)', fontSize: 13 }}>run a simulation to see the output the model would produce with these inputs.</div>}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export function Ego() {
  const docks = useDocks();
  const [dock, setDock] = useState('');
  const [ego, setEgo] = useState<EgoResp | null>(null);
  const [inputs, setInputs] = useState<Inputs | null>(null);
  const [trace, setTrace] = useState<TraceResp['entries']>([]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [openSnap, setOpenSnap] = useState<string | null>(null);
  const [snapText, setSnapText] = useState('');
  const [snapInputs, setSnapInputs] = useState<Inputs | null>(null);
  const [showInputs, setShowInputs] = useState(true);
  const [simOpen, setSimOpen] = useState(false);

  useEffect(() => { if (!dock && docks.length) setDock(docks[0]!.name); }, [dock, docks]);

  const refresh = useCallback(async (d: string) => {
    if (!d) return;
    const [e, t, i] = await Promise.all([
      api.get<EgoResp>(`/ego/${d}`).catch(() => null),
      api.get<TraceResp>(`/ego/${d}/trace`).catch(() => null),
      api.get<{ inputs: Inputs | null }>(`/ego/${d}/inputs`).catch(() => null),
    ]);
    setEgo(e); setTrace(t?.entries ?? []); setInputs(i?.inputs ?? null);
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
    const [e, i] = await Promise.all([
      api.get<{ ego: string }>(`/ego/${dock}/trace/${name}`).catch(() => null),
      api.get<{ inputs: Inputs | null }>(`/ego/${dock}/trace/${name}/inputs`).catch(() => null),
    ]);
    setSnapText(e?.ego ?? '(could not load)'); setSnapInputs(i?.inputs ?? null); setOpenSnap(name);
  }, [dock, openSnap]);

  const prettyTs = (name: string) => name.replace('T', '  ').replace(/-(\d{2})-(\d{2})-\d{3}Z$/, ':$1:$2').replace(/(\d{4})-(\d{2})-(\d{2})/, '$3/$2');

  return (
    <div style={{ padding: '18px 22px', maxWidth: 1280 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 14 }}>
        <h2 style={{ margin: 0 }}>🪞 Ego</h2>
        <select value={dock} onChange={(e) => setDock(e.target.value)} style={{ padding: '4px 8px', borderRadius: 6 }}>
          {docks.length === 0 && <option value="">no docks</option>}
          {docks.map((d) => <option key={d.name} value={d.name}>{d.name}</option>)}
        </select>
        <button onClick={introspect} disabled={busy || !dock}
          style={{ padding: '6px 14px', borderRadius: 8, background: busy ? '#26324a' : '#13243a',
            color: '#cfe', border: '1px solid #2c405e', cursor: busy ? 'wait' : 'pointer', fontWeight: 600 }}>
          {busy ? '◌ introspecting…' : '✦ Introspect'}
        </button>
        <button onClick={() => setSimOpen(true)} disabled={!dock}
          style={{ padding: '6px 14px', borderRadius: 8, background: '#153a2a', color: '#cfe',
            border: '1px solid #2c5e40', cursor: dock ? 'pointer' : 'not-allowed', fontWeight: 600 }}>
          🧪 Simulate
        </button>
        <label style={{ fontSize: 12, color: 'var(--dim)', display: 'flex', gap: 5, alignItems: 'center', cursor: 'pointer' }}>
          <input type="checkbox" checked={showInputs} onChange={(e) => setShowInputs(e.target.checked)} /> show inputs
        </label>
        <span style={{ fontSize: 12, color: 'var(--dim)' }}>{msg}</span>
      </div>
      <p style={{ fontSize: 12, color: 'var(--dim)', marginTop: 0 }}>
        The dock's self, updated only by introspection. Each version is shown with the exact
        inputs that produced it (prompt · model · perception · conversation · trace) for
        debuggability. <b>Simulate</b> replays with edited inputs without saving.
      </p>

      <div style={{ display: 'grid', gridTemplateColumns: showInputs ? '1fr 1fr 300px' : '1fr 300px', gap: 18, alignItems: 'start' }}>
        {/* current ego */}
        <div style={{ ...card, padding: 16 }}>
          <div style={{ ...label, marginBottom: 8 }}>current ego {ego && !ego.exists && '· (template — no introspection yet)'}</div>
          {ego ? <EgoDoc text={ego.ego} /> : <div style={{ color: 'var(--dim)' }}>loading…</div>}
        </div>

        {/* inputs for the current ego */}
        {showInputs && (
          <div style={{ ...card, padding: 16 }}>
            <div style={{ ...label, marginBottom: 8 }}>inputs → this ego</div>
            <InputsPanel inputs={inputs} />
          </div>
        )}

        {/* trace — past introspections, each with its own inputs */}
        <div>
          <div style={{ ...label, marginBottom: 8 }}>trace — past introspections ({trace.length})</div>
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
                <div style={{ ...card, borderTop: 'none', borderRadius: '0 0 6px 6px', padding: 10, maxHeight: 460, overflow: 'auto' }}>
                  <EgoDoc text={snapText} />
                  <div style={{ ...label, margin: '12px 0 6px', borderTop: '1px solid #1c2233', paddingTop: 10 }}>inputs → this version</div>
                  <InputsPanel inputs={snapInputs} />
                </div>
              )}
            </div>
          ))}
        </div>
      </div>

      {simOpen && dock && (
        <SimulateModal dock={dock} onClose={() => setSimOpen(false)} base={inputs ?? {
          promptTemplate: '', model: 'gemini-2.5-flash', currentEgo: ego?.ego ?? '', recentExperience: '',
          trace: [], trigger: 'simulate', at: new Date().toISOString(),
        }} />
      )}
    </div>
  );
}

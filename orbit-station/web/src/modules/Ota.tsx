/**
 * OTA / Updates console — trigger builds + watch self-update status for both
 * targets (the dock body ESP32 and the dock app). See docs/OTA.md §7.
 *
 * Reads the snapshot over REST (GET /api/ota), then stays live off the `ota`
 * bus topic: `state` (artifact + per-device build/status + build session),
 * `progress` (the phase bar), `result` (settle done/failed/rolledback).
 *
 * Versions on the wire are build-only (docs/OTA.md §3): a device reports just
 * its monotonic `build`. The human label / release notes / build time are
 * STATION-owned metadata, recorded in meta.json at build time and shown here.
 */

import { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/station';
import { useStationEvents } from '../lib/useStation';

type Target = 'body' | 'app';
const TARGETS: Target[] = ['body', 'app'];
const TARGET_LABEL: Record<Target, string> = { body: 'Body', app: 'App' };
const TARGET_SUB: Record<Target, string> = { body: 'ESP32 firmware', app: 'Android' };

interface ArtifactMeta { build: number; version: string; notes?: string; sha256: string; size: number; builtAt: string; }
interface DevicePeer { id: string; dock?: string; label?: string; build?: number; status?: string; }
interface BuildStatus { state: 'idle' | 'running' | 'done' | 'failed'; session: string; attach: string; logTail?: string; exitCode?: number; }
interface TargetState { artifact: ArtifactMeta | null; peers: DevicePeer[]; build: BuildStatus; }

const PHASES = ['building', 'downloading', 'verifying', 'applying', 'rebooting', 'validating', 'done'] as const;
const PHASE_LABEL: Record<string, string> = {
  building: 'Build', downloading: 'Download', verifying: 'Verify',
  applying: 'Apply', rebooting: 'Reboot', validating: 'Validate', done: 'Done',
};

interface Live { phase?: string; pct?: number; error?: string; rolledback?: boolean; tail?: string }

export function Ota() {
  const idle = (t: Target): BuildStatus => ({ state: 'idle', session: `ota-build-${t}`, attach: `tmux attach -t ota-build-${t}` });
  const [state, setState] = useState<Record<Target, TargetState>>({
    body: { artifact: null, peers: [], build: idle('body') },
    app: { artifact: null, peers: [], build: idle('app') },
  });
  const [live, setLive] = useState<Record<Target, Live>>({ body: {}, app: {} });

  const load = useCallback(() => {
    api.get<{ targets: { target: Target; artifact: ArtifactMeta | null; build: BuildStatus; peers: DevicePeer[] }[] }>('/ota')
      .then((r) => setState((prev) => {
        const next = { ...prev };
        for (const t of r.targets) next[t.target] = { artifact: t.artifact, peers: t.peers ?? [], build: t.build };
        return next;
      })).catch(() => {});
  }, []);
  useEffect(load, [load]);

  useStationEvents('ota', useCallback((e) => {
    const p = e.payload as { target?: Target } & Record<string, unknown>;
    const target = p?.target;
    if (target !== 'body' && target !== 'app') return;

    if (e.kind === 'state') {
      setState((prev) => ({ ...prev, [target]: {
        artifact: (p.artifact as ArtifactMeta) ?? null,
        peers: (p.peers as DevicePeer[]) ?? [],
        build: (p.build as BuildStatus) ?? prev[target].build,
      } }));
    } else if (e.kind === 'progress') {
      setLive((prev) => ({ ...prev, [target]: {
        ...prev[target],
        phase: (p.phase as string) ?? prev[target].phase,
        pct: typeof p.pct === 'number' ? (p.pct as number) : prev[target].pct,
        tail: (p.tail as string) ?? prev[target].tail,
      } }));
    } else if (e.kind === 'result') {
      const ok = p.ok as boolean;
      setLive((prev) => ({ ...prev, [target]: {
        ...prev[target],
        phase: ok ? 'done' : (p.phase === 'rolledback' ? 'rolledback' : 'failed'),
        error: (p.error as string) ?? undefined,
        rolledback: p.phase === 'rolledback',
      } }));
    }
  }, []));

  return (
    <section>
      <h2 className="title">Updates</h2>
      <p className="subtitle">Build, push, and watch over-the-air updates. Devices report a build number; release notes live here.</p>
      <div className="ota-grid">
        {TARGETS.map((t) => <OtaCard key={t} target={t} st={state[t]} live={live[t]} onChange={load} />)}
      </div>
    </section>
  );
}

function OtaCard({ target, st, live, onChange }: { target: Target; st: TargetState; live: Live; onChange: () => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [showNotes, setShowNotes] = useState(false);
  const [notes, setNotes] = useState('');
  const artifact = st.artifact;

  const post = async (action: string, body?: unknown, key = action) => {
    setBusy(key);
    try { await api.post(`/ota/${target}/${action}`, body ?? {}); }
    finally { setBusy(null); onChange(); }
  };
  const startBuild = async () => {
    await post('build', { notes: notes.trim() || undefined }, 'build');
    setShowNotes(false); setNotes('');
  };

  const phase = live.phase;
  const running = st.build.state === 'running' || (phase && !['done', 'failed', 'rolledback'].includes(phase));
  const behindPeers = artifact ? st.peers.filter((d) => d.build != null && d.build < artifact.build) : [];

  // Show the phase timeline only while there's something to watch: an update in
  // flight, or a failure/rollback that needs attention. Once it's done AND every
  // device has caught up (nothing behind), the bar has served its purpose — hide
  // it so a settled card stays quiet.
  const converged = phase === 'done' && behindPeers.length === 0;
  const showPhases = !!phase && !converged;

  return (
    <div className="ota-card">
      <header className="ota-card-head">
        <div>
          <h3>{TARGET_LABEL[target]}</h3>
          <span className="ota-sub">{TARGET_SUB[target]}</span>
        </div>
        {artifact && <span className="ota-build-tag">build {artifact.build}</span>}
      </header>

      {/* artifact */}
      <div className="ota-section">
        <div className="ota-row"><span className="ota-key">Artifact</span>
          {artifact
            ? <span className="ota-val">build {artifact.build}{artifact.version ? ` · ${artifact.version}` : ''} · {fmtSize(artifact.size)}</span>
            : <span className="ota-val dim">none built yet</span>}
        </div>
        {artifact && (
          <div className="ota-row"><span className="ota-key">Built</span>
            <span className="ota-val dim">{new Date(artifact.builtAt).toLocaleString()}</span>
          </div>
        )}
        {artifact?.notes && (
          <div className="ota-row"><span className="ota-key">Notes</span>
            <span className="ota-val ota-notes">{artifact.notes}</span>
          </div>
        )}
      </div>

      {/* devices */}
      <div className="ota-section">
        <div className="ota-key ota-section-label">Devices</div>
        {st.peers.length === 0
          ? <div className="ota-val dim">No {target === 'body' ? 'firmware' : 'app'} connected.</div>
          : st.peers.map((d) => (
            <div className="ota-row ota-device" key={d.id}>
              <span className="ota-val">{d.dock ?? d.label ?? d.id} · build {d.build ?? '?'}</span>
              <DeviceBadge artifact={artifact} dev={d} />
              {artifact && d.build != null && d.build < artifact.build && (
                <button className="mini" disabled={!!busy} onClick={() => post(`announce?to=${encodeURIComponent(d.id)}`, undefined, 'announce' + d.id)}>update</button>
              )}
            </div>
          ))}
      </div>

      {/* actions */}
      {showNotes ? (
        <div className="ota-notes-form">
          <label className="ota-key">Release notes <span className="dim">(optional)</span></label>
          <textarea className="ota-notes-input" rows={2} placeholder="What changed in this build?" value={notes}
            onChange={(e) => setNotes(e.target.value)} autoFocus />
          <div className="ota-actions">
            <button className="primary" disabled={busy === 'build'} onClick={startBuild}>{busy === 'build' ? 'Starting…' : 'Build & Announce'}</button>
            <button onClick={() => { setShowNotes(false); setNotes(''); }}>Cancel</button>
          </div>
        </div>
      ) : (
        <div className="ota-actions">
          <button className="primary" disabled={!!busy || !!running} onClick={() => setShowNotes(true)}>
            {running ? 'Building…' : 'Build & Announce'}
          </button>
          <button disabled={!!busy || !artifact || behindPeers.length === 0} onClick={() => post('announce')}>
            Re-announce{behindPeers.length ? ` (${behindPeers.length})` : ''}
          </button>
        </div>
      )}

      {/* live phase timeline — only while in-flight or needing attention */}
      {showPhases && <PhaseBar live={live} />}

      {/* build session */}
      <BuildStrip build={st.build} live={live} />
    </div>
  );
}

function DeviceBadge({ artifact, dev }: { artifact: ArtifactMeta | null; dev: DevicePeer }) {
  if (!artifact || dev.build == null) return <span className="pill">unknown</span>;
  if (dev.build > artifact.build) return <span className="pill acc">ahead</span>;
  if (dev.build < artifact.build) return <span className="pill warn">behind</span>;
  return <span className="pill good">up-to-date</span>;
}

function PhaseBar({ live }: { live: Live }) {
  const failed = live.phase === 'failed' || live.phase === 'rolledback';
  const complete = live.phase === 'done';
  const activeIdx = PHASES.indexOf((live.phase as typeof PHASES[number]) ?? 'building');
  const pctText = live.phase === 'downloading' && typeof live.pct === 'number' ? ` ${live.pct}%` : '';
  return (
    <div className={`ota-phasebar${failed ? ' failed' : ''}`}>
      <div className="ota-phasebar-track">
        {PHASES.map((ph, i) => {
          // When complete, every phase (incl. Done) is solid-green, none pulses.
          // Otherwise: phases before the cursor are done, the cursor pulses.
          const isDone = complete || (i < activeIdx && !failed);
          const isActive = !complete && !failed && i === activeIdx;
          return (
            <span key={ph} className={`ota-phase${isDone ? ' done' : ''}${isActive ? ' active' : ''}`}>
              {PHASE_LABEL[ph]}
            </span>
          );
        })}
      </div>
      {!failed && live.phase !== 'done' && (
        <div className="ota-phase-now">{PHASE_LABEL[live.phase ?? ''] ?? live.phase}{pctText}…</div>
      )}
      {failed && (
        <div className="ota-phase-fail">
          {live.phase === 'rolledback' ? '↩ rolled back to last-good image' : `✗ ${live.error ?? 'failed'}`}
        </div>
      )}
    </div>
  );
}

function BuildStrip({ build, live }: { build: BuildStatus; live: Live }) {
  const tail = live.tail ?? build.logTail;
  const [open, setOpen] = useState(false);
  if (build.state === 'idle' && !tail) return null;
  const label = build.state === 'running' ? 'running'
    : build.state === 'failed' ? `exited ${build.exitCode ?? '?'}`
    : build.state === 'done' ? 'exited 0' : build.state;

  return (
    <div className="ota-buildstrip">
      <div className="ota-row">
        <span className={`ota-dot ${build.state}`} />
        <span className="ota-val">build {label}</span>
        <button className="mini" onClick={() => navigator.clipboard?.writeText(build.attach)}>copy attach</button>
        {tail && <button className="mini ghost" onClick={() => setOpen((o) => !o)}>{open ? 'hide log' : 'log'}</button>}
      </div>
      {open && tail && <pre className="ota-log">{tail}</pre>}
    </div>
  );
}

function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

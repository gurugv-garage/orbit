/**
 * Capture — the capture-judging console (docs/findings/recall-reliability.md).
 *
 * Record a chosen dock's live A/V from the station (recording mode = the dock won't
 * respond), then play it back with the perception snapshot timeline SYNCED to the
 * playhead — so you can judge, moment by moment, whether STT + the vision snapshots
 * matched reality. Reprocess-with-other-models + compare + judge-marks land next.
 */
import { useEffect, useRef, useState } from 'react';
import { api } from '../lib/station';

interface Producer { streamId: string; label: string; tracks: { audio: boolean; video: boolean } }
interface SessionRow { id: string; dock: string; startedAt: string; durationMs: number; runs: number; snapshots: number }
interface Snapshot {
  source: { kind: string; ids?: string[] };
  interval: { from: string; to: string; durationMs: number };
  payload: { text?: string; caption?: string; label?: string; confTier?: string; avgLogprob?: number; noSpeechProb?: number; compressionRatio?: number } & Record<string, unknown>;
}

const TIER_STYLE: Record<string, { color: string; tag: string }> = {
  garbage: { color: '#f87171', tag: '🗑 unclear' },
  shaky: { color: '#fbbf24', tag: '~ shaky' },
  good: { color: '#cfe', tag: '' },
};
interface Run { label: string; model?: string; prompt?: string; createdAt: string; snapshots: Snapshot[] }
interface Manifest {
  id: string; dock: string; startedAt: string; startedAtEpoch: number;
  endedAt: string; durationMs: number; video: string; audio: string; runs: Run[];
}

const KIND_ICON: Record<string, string> = {
  vision: '👁', speech: '🎙', identity: '👤', emotion: '😮', bodymotion: '🤖',
};
const istClock = (iso: string) => (iso || '').slice(11, 19);

/** Group speech snapshots into time BINS of `binSec` seconds (bin index = floor(sec/binSec)).
 *  Wider bins line up sparse-segmenting models (medium) against dense ones (small). */
function bucketBySecond(snaps: Snapshot[], startSec: (s: Snapshot) => number, binSec = 1): Map<number, Snapshot[]> {
  const m = new Map<number, Snapshot[]>();
  for (const s of snaps) {
    const bin = Math.floor(startSec(s) / binSec) * binSec;
    (m.get(bin) ?? m.set(bin, []).get(bin)!).push(s);
  }
  return m;
}

export function Capture() {
  const [producers, setProducers] = useState<Producer[]>([]);
  const [dock, setDock] = useState<string>('');
  const [live, setLive] = useState<{ id: string; dock: string }[]>([]);
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [openId, setOpenId] = useState<string>('');
  const [manifest, setManifest] = useState<Manifest | null>(null);
  const [busy, setBusy] = useState(false);
  const [playMs, setPlayMs] = useState(0); // ms since recording start (the sync clock)
  const [runIdx, setRunIdx] = useState(0); // which result run to show on the single timeline
  const [compareAll, setCompareAll] = useState(true); // per-second grid of ALL runs
  const [hiddenRuns, setHiddenRuns] = useState<Set<string>>(new Set()); // toggled-off columns
  const [binSec, setBinSec] = useState(1); // grid row granularity (s) — widen to align sparse runs
  const [model, setModel] = useState('mlx-community/whisper-small.en-mlx');
  const [prompt, setPrompt] = useState('');
  const [reproc, setReproc] = useState(false);
  const [progress, setProgress] = useState(0); // 0..1 while reprocessing
  const [cleaning, setCleaning] = useState(''); // "<run>:<mode>" while an LLM clean runs

  const videoRef = useRef<HTMLVideoElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);

  // Poll producers (the docks we can record) + the session list + live state.
  useEffect(() => {
    const load = () => {
      api.get<{ producers?: Producer[] }>('/media/status')
        .then((r) => { const ps = r.producers ?? []; setProducers(ps); setDock((d) => d || ps[0]?.label || ''); })
        .catch(() => {});
      api.get<{ live: { id: string; dock: string }[]; sessions: SessionRow[] }>('/capture')
        .then((r) => { setLive(r.live ?? []); setSessions(r.sessions ?? []); }).catch(() => {});
    };
    load();
    const t = setInterval(load, 2000);
    return () => clearInterval(t);
  }, []);

  // Load a session's manifest when one is opened.
  useEffect(() => {
    if (!openId) { setManifest(null); return; }
    setRunIdx(0);
    api.get<Manifest>(`/capture/${openId}`).then(setManifest).catch(() => setManifest(null));
  }, [openId]);

  const liveForDock = live.find((l) => l.dock === dock);

  const start = async () => {
    if (!dock) return;
    setBusy(true);
    try { await api.post('/capture/start', { dock }); } finally { setBusy(false); }
  };
  const stop = async (id: string) => {
    setBusy(true);
    try { await api.post('/capture/stop', { id }); setOpenId(id); } finally { setBusy(false); }
  };

  // Keep video+audio playing together; drive the sync clock off the video element.
  const onTimeUpdate = () => {
    const v = videoRef.current; if (!v) return;
    setPlayMs(v.currentTime * 1000);
    const a = audioRef.current;
    if (a && Math.abs(a.currentTime - v.currentTime) > 0.25) a.currentTime = v.currentTime;
  };
  const play = () => { videoRef.current?.play(); audioRef.current?.play(); };
  const pause = () => { videoRef.current?.pause(); audioRef.current?.pause(); };

  // The run we're judging (selectable; defaults to the first).
  const run = manifest?.runs?.[Math.min(runIdx, (manifest?.runs?.length ?? 1) - 1)];

  const reprocess = async () => {
    if (!manifest) return;
    setReproc(true);
    setProgress(0);
    const job = `job-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    // Poll the sidecar progress while the (awaited) transcription runs.
    const poll = setInterval(() => {
      api.get<{ progress: number }>(`/capture/progress?job=${job}`)
        .then((r) => setProgress(r.progress ?? 0)).catch(() => {});
    }, 700);
    try {
      const label = (model.split('/').pop() ?? 'run') + (prompt ? '+ctx' : '');
      await api.post(`/capture/${manifest.id}/reprocess`, { model, prompt: prompt || undefined, label, job });
      const m = await api.get<Manifest>(`/capture/${manifest.id}`);
      setManifest(m);
      setRunIdx(m.runs.findIndex((r) => r.label === label)); // jump to the new run
    } finally { clearInterval(poll); setReproc(false); setProgress(0); }
  };

  // LLM-clean a raw run → a cleaned run (drop low-conf, or keep+score).
  const clean = async (sourceRun: string, mode: 'scored' | 'drop') => {
    if (!manifest || cleaning) return;
    setCleaning(`${sourceRun}:${mode}`);
    try {
      const r = await api.post<{ label?: string; error?: string }>(`/capture/${manifest.id}/clean`, { sourceRun, mode });
      const m = await api.get<Manifest>(`/capture/${manifest.id}`);
      setManifest(m);
      if (r.label) setRunIdx(m.runs.findIndex((x) => x.label === r.label));
    } finally { setCleaning(''); }
  };

  const startEpoch = manifest?.startedAtEpoch ?? 0;
  // A snapshot is "active" if the playhead time falls within its interval.
  const snapAtPlayhead = (s: Snapshot) => {
    const from = new Date(s.interval.from).getTime() - startEpoch;
    const to = new Date(s.interval.to).getTime() - startEpoch;
    return playMs >= from - 200 && playMs <= to + 800; // small grace
  };
  const snapText = (s: Snapshot) => s.payload.text ?? s.payload.caption ?? s.payload.label ?? JSON.stringify(s.payload).slice(0, 80);
  // A 0..1 confidence score from Whisper's avg logprob (lp 0 → 1.0, lp -1 → 0).
  const confScore = (s: Snapshot): number | null =>
    s.payload.avgLogprob != null ? Math.max(0, Math.min(1, 1 + s.payload.avgLogprob)) : null;
  const startSec = (s: Snapshot) => Math.max(0, Math.round((new Date(s.interval.from).getTime() - startEpoch) / 1000));

  // PER-SECOND COMPARISON GRID: rows = each second any run has SPEECH; one column
  // per run. Each cell shows that run's text at that second + its confidence score.
  const speechRuns = (manifest?.runs ?? [])
    .filter((r) => !hiddenRuns.has(r.label))
    .map((r) => ({
      ...r, byScond: bucketBySecond(r.snapshots.filter((s) => s.source.kind === 'speech'), startSec, binSec),
    }));
  const allSeconds = Array.from(new Set(speechRuns.flatMap((r) => [...r.byScond.keys()]))).sort((a, b) => a - b);

  return (
    <div className="view">
      <h1>Capture <span style={{ opacity: 0.5, fontSize: 14, fontWeight: 400 }}>— record real A/V + judge what perception captured</span></h1>

      {/* RECORD BAR */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginBottom: 16,
        background: '#10141f', border: '1px solid #1c2233', borderRadius: 10, padding: '10px 14px' }}>
        <span style={{ opacity: 0.7, fontSize: 13 }}>Dock</span>
        <select value={dock} onChange={(e) => setDock(e.target.value)}
          style={{ fontSize: 13, background: '#0b0e16', color: '#cfe', border: '1px solid #1c2233', borderRadius: 7, padding: '4px 8px' }}>
          {producers.length === 0 && <option value="">(no dock streaming)</option>}
          {producers.map((p) => (
            <option key={p.streamId} value={p.label}>
              📱 {p.label} {p.tracks.audio ? '🎙' : ''}{p.tracks.video ? '📹' : ''}
            </option>
          ))}
        </select>
        {liveForDock
          ? <button disabled={busy} onClick={() => stop(liveForDock.id)}
              style={{ padding: '6px 16px', borderRadius: 8, background: '#3a1320', color: '#f9a', border: '1px solid #5a2230', cursor: 'pointer', fontWeight: 600 }}>
              ⏹ Stop recording
            </button>
          : <button disabled={busy || !dock} onClick={start}
              style={{ padding: '6px 16px', borderRadius: 8, background: '#13243a', color: '#cfe', border: '1px solid #1c2233', cursor: 'pointer', fontWeight: 600 }}>
              ● Record
            </button>}
        {liveForDock && <span style={{ color: '#f9a', fontSize: 13 }}>🔴 recording — the dock won't respond</span>}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '260px 1fr', gap: 16 }}>
        {/* SESSION LIST */}
        <div>
          <div className="side-section-label" style={{ marginBottom: 8 }}>Recordings ({sessions.length})</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {sessions.length === 0 && <div className="empty" style={{ fontSize: 12 }}>No recordings yet. Pick a dock and hit Record.</div>}
            {sessions.map((s) => (
              <button key={s.id} onClick={() => setOpenId(s.id)}
                style={{ textAlign: 'left', padding: '8px 10px', borderRadius: 8, cursor: 'pointer',
                  background: openId === s.id ? '#13243a' : '#10141f', color: '#cfe',
                  border: `1px solid ${openId === s.id ? '#2a4a6a' : '#1c2233'}` }}>
                <div style={{ fontSize: 12, fontWeight: 600 }}>📱 {s.dock}</div>
                <div style={{ fontSize: 11, opacity: 0.6 }}>{istClock(s.startedAt)} · {(s.durationMs / 1000).toFixed(0)}s · {s.snapshots} snaps</div>
              </button>
            ))}
          </div>
        </div>

        {/* PLAYER + SYNCED TIMELINE */}
        <div>
          {!manifest
            ? <div className="empty">Select a recording to play it back with the synced snapshot timeline.</div>
            : <div>
                <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start', flexWrap: 'wrap' }}>
                  {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
                  <video ref={videoRef} src={`/api/capture/${manifest.id}/video`} onTimeUpdate={onTimeUpdate}
                    controls onPlay={play} onPause={pause}
                    style={{ width: 360, background: '#000', borderRadius: 10, border: '1px solid #1c2233' }} />
                  {/* audio is a separate track (we record them separately); keep it in sync with the video */}
                  <audio ref={audioRef} src={`/api/capture/${manifest.id}/audio`} style={{ display: 'none' }} />

                  {/* WHAT PERCEPTION SAW AT THE PLAYHEAD */}
                  <div style={{ flex: 1, minWidth: 280 }}>
                    <div className="side-section-label" style={{ marginBottom: 6 }}>
                      At {(playMs / 1000).toFixed(1)}s — what perception captured
                    </div>
                    {(run?.snapshots ?? []).filter(snapAtPlayhead).length === 0
                      ? <div className="empty" style={{ fontSize: 12 }}>(no snapshot at this moment)</div>
                      : (run?.snapshots ?? []).filter(snapAtPlayhead).map((s, i) => (
                          <div key={i} style={{ display: 'flex', gap: 8, padding: '4px 0', alignItems: 'baseline' }}>
                            <span>{KIND_ICON[s.source.kind] ?? '•'}</span>
                            <span style={{ fontSize: 13 }}>{snapText(s)}</span>
                          </div>
                        ))}
                  </div>
                </div>

                {/* REPROCESS BAR — re-run STT with a chosen model + context prompt */}
                <div style={{ marginTop: 14, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap',
                  background: '#10141f', border: '1px solid #1c2233', borderRadius: 10, padding: '8px 12px' }}>
                  <span style={{ fontSize: 12, opacity: 0.7 }}>Re-transcribe with</span>
                  <select value={model} onChange={(e) => setModel(e.target.value)}
                    style={{ fontSize: 12, background: '#0b0e16', color: '#cfe', border: '1px solid #1c2233', borderRadius: 6, padding: '3px 6px' }}>
                    <option value="mlx-community/whisper-small.en-mlx">whisper small.en</option>
                    <option value="mlx-community/whisper-base.en-mlx">whisper base.en</option>
                    <option value="mlx-community/whisper-medium.en-mlx">whisper medium.en</option>
                    <option value="mlx-community/whisper-large-v3-mlx">whisper large-v3</option>
                  </select>
                  <input value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="context prompt (names, topic) — optional"
                    style={{ flex: 1, minWidth: 180, fontSize: 12, background: '#0b0e16', color: '#cfe', border: '1px solid #1c2233', borderRadius: 6, padding: '4px 8px' }} />
                  <button disabled={reproc} onClick={reprocess}
                    style={{ padding: '5px 14px', borderRadius: 7, position: 'relative', overflow: 'hidden',
                      background: '#13243a', color: '#cfe', border: '1px solid #1c2233', cursor: reproc ? 'default' : 'pointer', fontWeight: 600, minWidth: 130 }}>
                    {reproc && <span style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: `${Math.round(progress * 100)}%`,
                      background: '#1d4ed8', opacity: 0.45, transition: 'width 0.3s' }} />}
                    <span style={{ position: 'relative' }}>
                      {reproc ? `… ${Math.round(progress * 100)}%` : '↻ Reprocess'}
                    </span>
                  </button>
                </div>

                {/* RUNS — each run's model + ctx prompt + an LLM-clean control per raw run */}
                <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 4 }}>
                  {(manifest.runs ?? []).map((r) => {
                    const isClean = r.label.includes('→clean');
                    return (
                      <div key={r.label} style={{ fontSize: 12, display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}>
                        <span style={{ fontWeight: 600, color: isClean ? '#9f9' : '#cfe', minWidth: 130 }}>{isClean ? '🧹 ' : ''}{r.label}</span>
                        <span style={{ opacity: 0.5 }}>{r.model?.split('/').pop() ?? '—'} · {r.snapshots.filter((s) => s.source.kind === 'speech').length} speech</span>
                        {r.prompt && <span style={{ opacity: 0.7, color: '#9cf', fontStyle: 'italic' }}>ctx: "{r.prompt}"</span>}
                        {!isClean && (
                          <span style={{ display: 'flex', gap: 5 }}>
                            <button disabled={!!cleaning} onClick={() => clean(r.label, 'drop')} title="LLM clean — drop what it can't confidently reconstruct"
                              style={{ fontSize: 10.5, padding: '1px 7px', borderRadius: 10, cursor: cleaning ? 'default' : 'pointer',
                                background: cleaning === `${r.label}:drop` ? '#1d4ed8' : '#11202e', color: '#9cf', border: '1px solid #1c3344' }}>
                              {cleaning === `${r.label}:drop` ? '… cleaning' : '🧹 clean (drop)'}
                            </button>
                            <button disabled={!!cleaning} onClick={() => clean(r.label, 'scored')} title="LLM clean — keep all + a confidence score per segment"
                              style={{ fontSize: 10.5, padding: '1px 7px', borderRadius: 10, cursor: cleaning ? 'default' : 'pointer',
                                background: cleaning === `${r.label}:scored` ? '#1d4ed8' : '#11202e', color: '#9cf', border: '1px solid #1c3344' }}>
                              {cleaning === `${r.label}:scored` ? '… cleaning' : '🧹 clean (scored)'}
                            </button>
                          </span>
                        )}
                      </div>
                    );
                  })}
                </div>

                {/* VIEW TOGGLE + COLUMN TOGGLES */}
                <div style={{ marginTop: 12, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                  <span className="side-section-label">Transcript</span>
                  <label style={{ fontSize: 12, display: 'flex', gap: 5, cursor: 'pointer' }}>
                    <input type="checkbox" checked={compareAll} onChange={(e) => setCompareAll(e.target.checked)} />
                    compare all runs
                  </label>
                  {compareAll && (
                    <label style={{ fontSize: 12, display: 'flex', gap: 5, alignItems: 'center', opacity: 0.8 }}>
                      bin
                      <select value={binSec} onChange={(e) => setBinSec(Number(e.target.value))}
                        style={{ fontSize: 11, background: '#0b0e16', color: '#cfe', border: '1px solid #1c2233', borderRadius: 6, padding: '2px 5px' }}>
                        <option value={1}>1s</option>
                        <option value={2}>2s</option>
                        <option value={5}>5s</option>
                        <option value={10}>10s</option>
                      </select>
                    </label>
                  )}
                  {compareAll
                    ? /* COLUMN toggles: click a run to show/hide its column */
                      (manifest.runs ?? []).map((r) => {
                        const shown = !hiddenRuns.has(r.label);
                        return (
                          <button key={r.label} onClick={() => setHiddenRuns((h) => {
                            const n = new Set(h); if (n.has(r.label)) n.delete(r.label); else n.add(r.label); return n;
                          })}
                            title={shown ? 'click to hide this column' : 'click to show this column'}
                            style={{ fontSize: 11, padding: '2px 9px', borderRadius: 12, cursor: 'pointer',
                              background: shown ? '#13243a' : 'transparent', color: shown ? '#cfe' : '#566',
                              border: `1px solid ${shown ? '#2a4a6a' : '#1c2233'}`, textDecoration: shown ? 'none' : 'line-through' }}>
                            {shown ? '' : '🚫 '}{r.label}
                          </button>
                        );
                      })
                    : /* SINGLE-run picker */
                      (manifest.runs ?? []).map((r, i) => (
                        <button key={r.label} onClick={() => setRunIdx(i)}
                          style={{ fontSize: 11, padding: '2px 9px', borderRadius: 12, cursor: 'pointer',
                            background: i === runIdx ? '#13243a' : 'transparent', color: i === runIdx ? '#cfe' : '#89a',
                            border: `1px solid ${i === runIdx ? '#2a4a6a' : '#1c2233'}` }}>
                          {r.label}
                        </button>
                      ))}
                </div>

                {compareAll
                  ? /* PER-SECOND COMPARISON GRID — rows=seconds, columns=runs, conf-scored */
                    <div style={{ marginTop: 8, maxHeight: 420, overflowY: 'auto', background: '#0b0e16', borderRadius: 10 }}>
                      <div style={{ display: 'grid', gridTemplateColumns: `54px repeat(${speechRuns.length}, 1fr)`,
                        position: 'sticky', top: 0, background: '#0b0e16', borderBottom: '1px solid #1c2233', zIndex: 1 }}>
                        <div style={{ fontSize: 11, opacity: 0.5, padding: '6px 8px' }}>time</div>
                        {speechRuns.map((r) => {
                          const secs = [...r.byScond.keys()].sort((a, b) => a - b);
                          const span = secs.length ? `${Math.floor(secs[0]! / 60)}:${String(secs[0]! % 60).padStart(2, '0')}–${Math.floor(secs[secs.length - 1]! / 60)}:${String(secs[secs.length - 1]! % 60).padStart(2, '0')}` : 'no speech';
                          return (
                            <div key={r.label} style={{ fontSize: 11, padding: '6px 8px' }}>
                              <div style={{ fontWeight: 600, color: '#9cf' }}>{r.label}</div>
                              <div style={{ opacity: 0.4, fontSize: 10 }}>{r.snapshots.filter((s) => s.source.kind === 'speech').length} segs · {span}</div>
                            </div>
                          );
                        })}
                      </div>
                      {allSeconds.map((sec) => {
                        const active = Math.floor(playMs / 1000) === sec;
                        return (
                          <div key={sec} onClick={() => { if (videoRef.current) videoRef.current.currentTime = sec; }}
                            style={{ display: 'grid', gridTemplateColumns: `54px repeat(${speechRuns.length}, 1fr)`, cursor: 'pointer',
                              background: active ? '#13243a' : 'transparent', borderBottom: '1px solid #11151f' }}>
                            <div style={{ fontSize: 11, opacity: 0.5, padding: '5px 8px', fontVariantNumeric: 'tabular-nums' }}>
                              {Math.floor(sec / 60)}:{String(sec % 60).padStart(2, '0')}
                            </div>
                            {speechRuns.map((r) => {
                              const cell = r.byScond.get(sec) ?? [];
                              return (
                                <div key={r.label} style={{ padding: '5px 8px', fontSize: 12.5, borderLeft: '1px solid #11151f' }}>
                                  {cell.length === 0 && <span style={{ opacity: 0.12 }}>·</span>}
                                  {cell.map((s, j) => {
                                    const tier = s.payload.confTier ?? 'good';
                                    const ts = TIER_STYLE[tier] ?? TIER_STYLE.good!;
                                    const sc = confScore(s);
                                    return (
                                      <div key={j} title={s.payload.avgLogprob != null ? `lp ${s.payload.avgLogprob.toFixed(2)} · ns ${(s.payload.noSpeechProb ?? 0).toFixed(2)} · cr ${(s.payload.compressionRatio ?? 0).toFixed(1)}` : ''}>
                                        <span style={{ color: ts.color, opacity: tier === 'garbage' ? 0.7 : 1 }}>
                                          {tier === 'garbage' ? <em>{snapText(s)}</em> : snapText(s)}
                                        </span>
                                        {sc != null && <span style={{ fontSize: 10, opacity: 0.45, marginLeft: 5, fontVariantNumeric: 'tabular-nums' }}>
                                          {Math.round(sc * 100)}%{ts.tag ? ` ${ts.tag}` : ''}
                                        </span>}
                                      </div>
                                    );
                                  })}
                                </div>
                              );
                            })}
                          </div>
                        );
                      })}
                      {allSeconds.length === 0 && <div className="empty" style={{ fontSize: 12, padding: 12 }}>No speech in any run.</div>}
                    </div>
                  : /* SINGLE-RUN timeline (all snapshot kinds) */
                    <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 3, maxHeight: 420, overflowY: 'auto',
                      background: '#0b0e16', borderRadius: 10, padding: 10 }}>
                      {(run?.snapshots ?? []).map((s, i) => {
                        const active = snapAtPlayhead(s);
                        const tMs = new Date(s.interval.from).getTime() - startEpoch;
                        const tier = s.source.kind === 'speech' ? (s.payload.confTier ?? 'good') : 'good';
                        const ts = TIER_STYLE[tier] ?? TIER_STYLE.good!;
                        const sc = s.source.kind === 'speech' ? confScore(s) : null;
                        return (
                          <div key={i} onClick={() => { if (videoRef.current) videoRef.current.currentTime = Math.max(0, tMs / 1000); }}
                            style={{ display: 'flex', gap: 8, fontSize: 13, padding: '3px 6px', borderRadius: 6, cursor: 'pointer',
                              background: active ? '#13243a' : 'transparent', border: `1px solid ${active ? '#2a4a6a' : 'transparent'}` }}>
                            <span style={{ opacity: 0.5, fontVariantNumeric: 'tabular-nums', width: 54 }}>{(Math.max(0, tMs) / 1000).toFixed(1)}s</span>
                            <span>{KIND_ICON[s.source.kind] ?? '•'}</span>
                            <span style={{ flex: 1, color: ts.color, opacity: tier === 'garbage' ? 0.7 : 1 }}>
                              {tier === 'garbage' ? <em>{snapText(s)}</em> : snapText(s)}
                              {ts.tag && <span style={{ fontSize: 11, marginLeft: 6, opacity: 0.8 }}>{ts.tag}</span>}
                            </span>
                            {sc != null && <span style={{ fontSize: 10, opacity: 0.45, fontVariantNumeric: 'tabular-nums' }}>{Math.round(sc * 100)}%</span>}
                          </div>
                        );
                      })}
                    </div>}
              </div>}
        </div>
      </div>
    </div>
  );
}

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
  payload: { text?: string; caption?: string; label?: string } & Record<string, unknown>;
}
interface Run { label: string; model?: string; createdAt: string; snapshots: Snapshot[] }
interface Manifest {
  id: string; dock: string; startedAt: string; startedAtEpoch: number;
  endedAt: string; durationMs: number; video: string; audio: string; runs: Run[];
}

const KIND_ICON: Record<string, string> = {
  vision: '👁', speech: '🎙', identity: '👤', emotion: '😮', bodymotion: '🤖',
};
const istClock = (iso: string) => (iso || '').slice(11, 19);

export function Capture() {
  const [producers, setProducers] = useState<Producer[]>([]);
  const [dock, setDock] = useState<string>('');
  const [live, setLive] = useState<{ id: string; dock: string }[]>([]);
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [openId, setOpenId] = useState<string>('');
  const [manifest, setManifest] = useState<Manifest | null>(null);
  const [busy, setBusy] = useState(false);
  const [playMs, setPlayMs] = useState(0); // ms since recording start (the sync clock)

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

  // The run we're judging (first run = 'live' for now).
  const run = manifest?.runs?.[0];
  const startEpoch = manifest?.startedAtEpoch ?? 0;
  // A snapshot is "active" if the playhead time falls within its interval.
  const snapAtPlayhead = (s: Snapshot) => {
    const from = new Date(s.interval.from).getTime() - startEpoch;
    const to = new Date(s.interval.to).getTime() - startEpoch;
    return playMs >= from - 200 && playMs <= to + 800; // small grace
  };
  const snapText = (s: Snapshot) => s.payload.text ?? s.payload.caption ?? s.payload.label ?? JSON.stringify(s.payload).slice(0, 80);

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

                {/* TIMELINE — every snapshot as a marker; the active one highlights */}
                <div style={{ marginTop: 14 }}>
                  <div className="side-section-label" style={{ marginBottom: 6 }}>
                    Snapshot timeline ({run?.snapshots.length ?? 0}) · run: {run?.label ?? '—'}
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 3, maxHeight: 320, overflowY: 'auto',
                    background: '#0b0e16', borderRadius: 10, padding: 10 }}>
                    {(run?.snapshots ?? []).map((s, i) => {
                      const active = snapAtPlayhead(s);
                      const tMs = new Date(s.interval.from).getTime() - startEpoch;
                      return (
                        <div key={i} onClick={() => { if (videoRef.current) videoRef.current.currentTime = Math.max(0, tMs / 1000); }}
                          style={{ display: 'flex', gap: 8, fontSize: 13, padding: '3px 6px', borderRadius: 6, cursor: 'pointer',
                            background: active ? '#13243a' : 'transparent', border: `1px solid ${active ? '#2a4a6a' : 'transparent'}` }}>
                          <span style={{ opacity: 0.5, fontVariantNumeric: 'tabular-nums', width: 54 }}>
                            {(Math.max(0, tMs) / 1000).toFixed(1)}s
                          </span>
                          <span>{KIND_ICON[s.source.kind] ?? '•'}</span>
                          <span style={{ flex: 1 }}>{snapText(s)}</span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>}
        </div>
      </div>
    </div>
  );
}

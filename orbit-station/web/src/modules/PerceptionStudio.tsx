/**
 * PerceptionStudio — the single console for the always-on perception PoC
 * (docs/PERCEPTION-PYRAMID.md). One place for INPUT and OUTPUT:
 *   • publish this laptop's mic+cam to the SFU as a producer (320×240 video to
 *     match the dock; Opus audio), started/stopped here;
 *   • steer the vision instruction live (base shown read-only + an editable
 *     extra, POSTed to /api/perception/instruction);
 *   • watch the rolling ~500 observations stream in (vision scene + STT
 *     transcript) over the /observations/stream SSE.
 *
 * Reuses the media `producer-offer/answer/ice` handshake the dock app uses, so
 * the perception processors (vision-watch, stt-watch) tap it like a real dock.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useStationClient, useStationEvents } from '../lib/useStation';
import { api } from '../lib/station';

interface Observation {
  ts: number; dockId: string; modality: 'vision' | 'speech' | 'action';
  text: string; meta?: { present?: boolean }; source: string;
}

const ICON: Record<Observation['modality'], string> = { vision: '👁', speech: '🎙', action: '🎬' };

const STREAM_ID = 'console-perception'; // this console's producer peer id

export function PerceptionStudio() {
  const client = useStationClient();
  const [publishing, setPublishing] = useState(false);
  const [base, setBase] = useState('');
  const [extra, setExtra] = useState('');
  const [obs, setObs] = useState<Observation[]>([]);
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const mediaRef = useRef<MediaStream | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const [saved, setSaved] = useState(false);
  const [tracks, setTracks] = useState<{ audio: boolean; video: boolean }>({ audio: false, video: false });
  const [micLevel, setMicLevel] = useState(0);
  const [autoScroll, setAutoScroll] = useState(true);
  const [showVision, setShowVision] = useState(true);
  const [showSpeech, setShowSpeech] = useState(true);
  const [showAction, setShowAction] = useState(true);
  const [visionModel, setVisionModel] = useState<'moondream' | 'md3'>('moondream');
  const [resolution, setResolution] = useState<320 | 512>(320);
  const feedRef = useRef<HTMLDivElement>(null);

  // Load current instruction + recent observations once.
  useEffect(() => {
    api.get<{ base: string; extra: string }>('/perception/instruction')
      .then((r) => { setBase(r.base); setExtra(r.extra); }).catch(() => {});
    api.get<Observation[]>('/perception/observations')
      .then((r) => setObs(r.slice(-200))).catch(() => {});
    api.get<{ model: 'moondream' | 'md3' }>('/perception/vision-config')
      .then((r) => setVisionModel(r.model)).catch(() => {});
  }, []);

  // Live observations via SSE.
  useEffect(() => {
    const es = new EventSource('/api/perception/observations/stream');
    es.onmessage = (e) => {
      try { const o = JSON.parse(e.data) as Observation; setObs((prev) => [...prev.slice(-499), o]); }
      catch { /* ignore */ }
    };
    return () => es.close();
  }, []);

  // Live mic VU meter — proves the mic is actually capturing audio (a flat 0
  // while talking = no real mic input, the root of "audio not coming").
  const meterRef = useRef<number | null>(null);
  const startMicMeter = useCallback((media: MediaStream) => {
    const aTrack = media.getAudioTracks()[0];
    if (!aTrack) return;
    const acx = new AudioContext();
    const src = acx.createMediaStreamSource(new MediaStream([aTrack]));
    const an = acx.createAnalyser(); an.fftSize = 512;
    src.connect(an);
    const data = new Uint8Array(an.frequencyBinCount);
    const loop = () => {
      an.getByteTimeDomainData(data);
      let peak = 0;
      for (const v of data) peak = Math.max(peak, Math.abs(v - 128));
      setMicLevel(peak / 128);
      meterRef.current = requestAnimationFrame(loop);
    };
    loop();
  }, []);

  // ---- publish this laptop's mic+cam as a producer ---------------------- //
  const start = useCallback(async () => {
    const media = await navigator.mediaDevices.getUserMedia({
      video: { width: resolution, height: Math.round(resolution * 0.75), frameRate: 15 },
      audio: { channelCount: 1, sampleRate: 48000, echoCancellation: true },
    });
    mediaRef.current = media;
    if (videoRef.current) { videoRef.current.srcObject = media; void videoRef.current.play().catch(() => {}); }

    // Show what we actually captured (diagnoses "no mic": if audio is false here,
    // getUserMedia didn't grant a mic track at all).
    setTracks({ audio: media.getAudioTracks().length > 0, video: media.getVideoTracks().length > 0 });
    startMicMeter(media);

    const pc = new RTCPeerConnection();
    pcRef.current = pc;
    for (const track of media.getTracks()) pc.addTrack(track, media);
    pc.onicecandidate = (e) => {
      if (e.candidate) client.publish('media', 'producer-ice', { streamId: STREAM_ID, candidate: e.candidate.toJSON() });
    };
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    client.publish('media', 'producer-offer', { streamId: STREAM_ID, label: 'console-perception', sdp: offer.sdp });
    setPublishing(true);
  }, [client, resolution]);

  const stop = useCallback(() => {
    client.publish('media', 'bye', { role: 'app', streamId: STREAM_ID });
    pcRef.current?.close(); pcRef.current = null;
    mediaRef.current?.getTracks().forEach((t) => t.stop()); mediaRef.current = null;
    if (meterRef.current) cancelAnimationFrame(meterRef.current);
    setTracks({ audio: false, video: false }); setMicLevel(0);
    setPublishing(false);
  }, [client]);

  useEffect(() => () => stop(), [stop]);

  // SFU's producer-answer/ice. The SFU keys our producer by our WS peer id (the
  // `source`), NOT the payload streamId, and signals back with THAT id — which the
  // browser doesn't know. Since this console has exactly one producer PC, we apply
  // any producer-answer/ice to it (directed `to:` us already scopes it).
  useStationEvents('media', useCallback((e) => {
    const p = e.payload as Record<string, unknown> | null;
    const pc = pcRef.current;
    if (!pc) return;
    if (e.kind === 'producer-answer' && p?.sdp) {
      void pc.setRemoteDescription({ type: 'answer', sdp: p.sdp as string }).catch(() => {});
    } else if (e.kind === 'producer-ice' && p?.candidate) {
      void pc.addIceCandidate(p.candidate as RTCIceCandidateInit).catch(() => {});
    }
  }, []));

  // Auto-scroll the feed to newest when enabled; new obs / filter changes trigger it.
  useEffect(() => {
    if (autoScroll && feedRef.current) feedRef.current.scrollTop = feedRef.current.scrollHeight;
  }, [obs, autoScroll, showVision, showSpeech, showAction]);

  // Manual scroll: leaving the bottom turns auto-scroll OFF; returning to the
  // bottom turns it back ON (so you can scroll up to read, then snap back).
  const onFeedScroll = useCallback(() => {
    const el = feedRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
    setAutoScroll(atBottom);
  }, []);

  const saveInstruction = useCallback(async () => {
    const r = await api.post<{ base: string; extra: string }>('/perception/instruction', { extra });
    setExtra(r.extra);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000); // brief "Applied ✓" confirmation
  }, [extra]);

  // Switch vision model (moondream ↔ md3) live — server applies it next frame.
  const switchModel = useCallback(async (m: 'moondream' | 'md3') => {
    const r = await api.post<{ model: 'moondream' | 'md3' }>('/perception/vision-config', { model: m });
    setVisionModel(r.model);
  }, []);

  // Change capture resolution — must republish the stream so the new res reaches
  // the model (upscaling server-side wouldn't add real detail).
  const switchResolution = useCallback((res: 320 | 512) => {
    setResolution(res);
    if (publishing) { stop(); setTimeout(() => void start(), 300); }
  }, [publishing, stop, start]);

  // Latest of each modality — shown as prominent "live now" captions so you can
  // follow what's happening without reading the scrolling log.
  const latestVision = [...obs].reverse().find((o) => o.modality === 'vision');
  const latestSpeech = [...obs].reverse().find((o) => o.modality === 'speech');
  const latestAction = [...obs].reverse().find((o) => o.modality === 'action');

  // Log filtered by the modality toggles (all on by default).
  const show = { vision: showVision, speech: showSpeech, action: showAction };
  const filtered = obs.filter((o) => show[o.modality]);

  const clearObs = useCallback(async () => {
    setObs([]); // clear UI immediately
    try { await api.post('/perception/observations/clear', {}); } catch { /* */ }
  }, []);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* TOP: live video + its live caption | instruction */}
      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, width: 360 }}>
          <video ref={videoRef} muted playsInline
            style={{ width: 360, height: 270, background: '#070a11', borderRadius: 10, objectFit: 'cover', display: 'block' }} />
          <button onClick={publishing ? stop : start}
            style={{ padding: '8px 14px', borderRadius: 8, background: publishing ? '#3a1320' : '#13243a', color: '#cfe', border: '1px solid #1c2233' }}>
            {publishing ? '■ Stop stream' : '● Start stream (mic + cam)'}
          </button>
          {publishing && (
            <div style={{ fontSize: 12, display: 'flex', alignItems: 'center', gap: 10 }}>
              <span>📹 {tracks.video ? <b style={{ color: '#6f6' }}>on</b> : <b style={{ color: '#f66' }}>off</b>}</span>
              <span>🎙 {tracks.audio ? <b style={{ color: '#6f6' }}>on</b> : <b style={{ color: '#f66' }}>off</b>}</span>
              <div style={{ flex: 1, height: 6, background: '#1c2233', borderRadius: 3, overflow: 'hidden' }}>
                <div style={{ height: '100%', width: `${Math.min(100, micLevel * 300)}%`, background: '#6f6', transition: 'width 80ms' }} />
              </div>
            </div>
          )}
        </div>
        <div style={{ flex: 1, minWidth: 280, display: 'flex', flexDirection: 'column', gap: 6 }}>
          {/* Vision model + resolution toggles */}
          <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginBottom: 4 }}>
            <Toggle label="Model" value={visionModel}
              options={[['moondream', 'moondream (fast)'], ['md3', 'md3 (sharp)']]}
              onChange={(v) => void switchModel(v as 'moondream' | 'md3')} />
            <Toggle label="Resolution" value={String(resolution)}
              options={[['320', '320px'], ['512', '512px']]}
              onChange={(v) => switchResolution(Number(v) as 320 | 512)} />
          </div>
          <div className="side-section-label">Vision instruction</div>
          <div style={{ fontSize: 12, opacity: 0.6, lineHeight: 1.5 }}>{base}</div>
          <textarea value={extra} onChange={(e) => setExtra(e.target.value)}
            placeholder="Steer it… e.g. 'flag when he holds a cup' or 'watch the door'"
            style={{ minHeight: 56, background: '#0b0e16', color: '#cfe', border: '1px solid #1c2233', borderRadius: 8, padding: 8, fontSize: 13 }} />
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <button onClick={saveInstruction}
              style={{ padding: '6px 12px', borderRadius: 8, background: '#13243a', color: '#cfe', border: '1px solid #1c2233' }}>
              Apply to live stream
            </button>
            {saved && <span style={{ color: '#6f6', fontSize: 13 }}>✓ Applied</span>}
          </div>
          {/* LIVE captions — the latest of each, prominent and readable */}
          <div style={{ marginTop: 6 }}>
            <div className="side-section-label">🎙 Latest speech</div>
            <div style={{ marginTop: 4, padding: '10px 12px', minHeight: 40, background: '#0b0e16',
              border: '1px solid #1c2233', borderRadius: 8, fontSize: 15, lineHeight: 1.4,
              color: latestSpeech ? '#9ecbff' : '#566' }}>
              {latestSpeech ? latestSpeech.text : 'waiting for speech…'}
            </div>
          </div>
          <div>
            <div className="side-section-label">👁 Latest vision</div>
            <div style={{ marginTop: 4, padding: '10px 12px', minHeight: 56, background: '#0b0e16',
              border: '1px solid #1c2233', borderRadius: 8, fontSize: 14, lineHeight: 1.45,
              color: latestVision && !latestVision.text.startsWith('(') ? '#dfe' : '#566' }}>
              {latestVision ? latestVision.text : 'waiting for video…'}
            </div>
          </div>
          <div>
            <div className="side-section-label">🎬 Latest action (temporal)</div>
            <div style={{ marginTop: 4, padding: '10px 12px', minHeight: 40, background: '#0b0e16',
              border: '1px solid #2a2233', borderRadius: 8, fontSize: 14, lineHeight: 1.45,
              color: latestAction ? '#e9c9ff' : '#566' }}>
              {latestAction ? latestAction.text : 'watching for actions over time…'}
            </div>
          </div>
        </div>
      </div>

      {/* OUTPUT: rolling observations log */}
      <div>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
          <div className="side-section-label">Observations ({filtered.length})</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 14, fontSize: 12, opacity: 0.85 }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 5, cursor: 'pointer' }}>
              <input type="checkbox" checked={showVision} onChange={(e) => setShowVision(e.target.checked)} />
              👁 video
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 5, cursor: 'pointer' }}>
              <input type="checkbox" checked={showSpeech} onChange={(e) => setShowSpeech(e.target.checked)} />
              🎙 mic
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 5, cursor: 'pointer' }}>
              <input type="checkbox" checked={showAction} onChange={(e) => setShowAction(e.target.checked)} />
              🎬 action
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
              <input type="checkbox" checked={autoScroll} onChange={(e) => setAutoScroll(e.target.checked)} />
              Auto-scroll
            </label>
            <button onClick={clearObs}
              style={{ padding: '3px 10px', borderRadius: 6, background: '#1a1320', color: '#e9a', border: '1px solid #3a2230', cursor: 'pointer', fontSize: 12 }}>
              Clear
            </button>
          </div>
        </div>
        <div ref={feedRef} onScroll={onFeedScroll}
          style={{ maxHeight: 360, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 4,
            background: '#0b0e16', borderRadius: 10, padding: 10, fontSize: 13, lineHeight: 1.5 }}>
          {filtered.length === 0
            ? <div className="empty">No observations yet. Start the stream — vision runs every ~1s, speech every ~2s.</div>
            : filtered.map((o, i) => {
              const color = o.modality === 'speech' ? '#9ecbff'
                : o.modality === 'action' ? '#e9c9ff' : '#cfe';
              const dim = o.text.startsWith('(') ? 0.4 : 1; // "(nothing notable)" muted
              return (
                <div key={i} style={{ display: 'flex', gap: 8, opacity: dim, color }}>
                  <span style={{ opacity: 0.4, fontVariantNumeric: 'tabular-nums' }}>{new Date(o.ts).toLocaleTimeString()}</span>
                  <span style={{ width: 18 }}>{ICON[o.modality]}</span>
                  <span style={{ flex: 1 }}>{o.text}</span>
                </div>
              );
            })}
        </div>
      </div>
    </div>
  );
}

/** A small segmented toggle (label + pill buttons). */
function Toggle({ label, value, options, onChange }: {
  label: string; value: string; options: [string, string][]; onChange: (v: string) => void;
}) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <span style={{ fontSize: 12, opacity: 0.6 }}>{label}</span>
      <div style={{ display: 'flex', gap: 2, background: '#0b0e16', borderRadius: 8, padding: 2 }}>
        {options.map(([val, lbl]) => (
          <button key={val} onClick={() => onChange(val)}
            style={{ padding: '4px 10px', borderRadius: 6, fontSize: 12, border: 'none', cursor: 'pointer',
              background: value === val ? '#1f6feb' : 'transparent',
              color: value === val ? '#fff' : '#9ab' }}>
            {lbl}
          </button>
        ))}
      </div>
    </div>
  );
}

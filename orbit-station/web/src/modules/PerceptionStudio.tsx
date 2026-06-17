/**
 * PerceptionStudio — the single console for the WebRTC perception pipeline.
 *
 * ONE path: this console publishes the laptop's mic+cam to the station SFU over
 * WebRTC; the perception processors tap that stream — vision (qwen, scene+action,
 * latency-bound windows) and speech (whisper utterances) — and emit shared-format
 * SNAPSHOT records. This panel:
 *   • publishes/stops the mic+cam stream (resolution toggle changes what the model
 *     sees, so it republishes);
 *   • steers the vision instruction live;
 *   • shows the merged snapshot feed (vision + speech, ordered by start, with IST
 *     from–to + duration).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useStationClient, useStationEvents } from '../lib/useStation';
import { api } from '../lib/station';

const STREAM_ID = 'console-perception'; // this console's producer peer id

interface Snapshot {
  ts: string; tz: string;
  source: { id: string; kind: 'vision' | 'speech' | 'identity' | 'emotion' | 'bodymotion'; device: string; host: string };
  model: { name: string; endpoint?: string };
  interval: { from: string; to: string; durationMs: number };
  payload: {
    text: string; latencyMs?: number; frames?: number; faces?: unknown[];
    inferMs?: number | null; confidence?: number; // perf + match confidence (all streams)
    // speech: low-confidence flag + Whisper's own metrics (for the playground)
    lowConfidence?: boolean; avgLogprob?: number | null; noSpeechProb?: number | null; compressionRatio?: number | null;
  };
}

const KIND_ICON: Record<Snapshot['source']['kind'], string> = { vision: '👁', speech: '🎙', identity: '👤', emotion: '😮', bodymotion: '🤖' };
const KIND_COLOR: Record<Snapshot['source']['kind'], string> = { vision: '#dfe', speech: '#9ecbff', identity: '#ffd9a0', emotion: '#ff9ed4', bodymotion: '#a0e0c0' };

/** Trim a model id to its recognizable short name (drops the org/quant suffix). */
function MODEL_SHORT(name: string): string {
  return name.replace(/^.*\//, '').replace(/-mlx.*$/i, '').replace(/-preview$/i, '');
}
/** Compact latency: ms under 1s, else seconds. */
function fmtMs(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}

interface SummaryResult {
  summary: string; model: string; withKeyframes: boolean; error?: string;
  counts: { vision: number; speech: number; identity: number; emotion: number; bodymotion: number; keyframes: number };
  prompt: { system: string; transcript: string };
  window?: { from: string; to: string }; // exact IST bounds the server filtered on
}

/** now − ms, as IST ISO (+05:30) — matches the server's isoIst() exactly. */
function istIso(msAgo = 0): string {
  return new Date(Date.now() - msAgo + 5.5 * 3600_000).toISOString().replace('Z', '+05:30');
}

const WINDOWS: [number, string][] = [
  [60_000, '1m'], [300_000, '5m'], [600_000, '10m'], [1_800_000, '30m'], [3_600_000, '1h'],
];

/** A saved (frozen) snapshot bundle's metadata, for the A/B replay list. */
interface TakeMeta {
  name: string; savedAt: string;
  range: { from: string; to: string };
  counts: { vision: number; speech: number; identity: number; emotion: number; bodymotion: number; keyframes: number };
}

export function PerceptionStudio() {
  const client = useStationClient();
  const [publishing, setPublishing] = useState(false);
  const [base, setBase] = useState('');
  const [extra, setExtra] = useState('');
  const [saved, setSaved] = useState(false);
  const [tracks, setTracks] = useState<{ audio: boolean; video: boolean }>({ audio: false, video: false });
  const [micLevel, setMicLevel] = useState(0);
  const [resolution, setResolution] = useState<320 | 512>(512);
  const [snaps, setSnaps] = useState<Snapshot[]>([]);
  const [showVision, setShowVision] = useState(true);
  const [showSpeech, setShowSpeech] = useState(true);
  const [showIdentity, setShowIdentity] = useState(true);
  const [autoScroll, setAutoScroll] = useState(true);
  const [limitToWindow, setLimitToWindow] = useState(false);
  const [enrollName, setEnrollName] = useState('');
  const [enrollMsg, setEnrollMsg] = useState('');
  // Frozen-take A/B replay: saved bundles + which one is loaded (null = live).
  const [takes, setTakes] = useState<TakeMeta[]>([]);
  const [activeTake, setActiveTake] = useState<string | null>(null);

  const pcRef = useRef<RTCPeerConnection | null>(null);
  const mediaRef = useRef<MediaStream | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const meterRef = useRef<number | null>(null);
  const feedRef = useRef<HTMLDivElement>(null);

  // Load instruction once.
  useEffect(() => {
    api.get<{ base: string; extra: string }>('/perception/instruction')
      .then((r) => { setBase(r.base); setExtra(r.extra); }).catch(() => {});
  }, []);

  // Poll the LIVE snapshot ring (ordered by interval.from). Paused while a take is
  // loaded — then the feed holds the take's frozen records, not the live ring.
  useEffect(() => {
    if (activeTake) return; // showing frozen data; don't clobber it
    let alive = true;
    const load = () => api.get<Snapshot[]>('/perception/snapshots?limit=400')
      .then((r) => { if (alive) setSnaps(r); }).catch(() => {});
    load();
    const t = setInterval(load, 1500);
    return () => { alive = false; clearInterval(t); };
  }, [activeTake]);

  useEffect(() => {
    if (autoScroll && feedRef.current) feedRef.current.scrollTop = feedRef.current.scrollHeight;
  }, [snaps, autoScroll, showVision, showSpeech, showIdentity]);

  const onFeedScroll = useCallback(() => {
    const el = feedRef.current;
    if (!el) return;
    setAutoScroll(el.scrollHeight - el.scrollTop - el.clientHeight < 24);
  }, []);

  // Live mic VU meter — confirms the mic is actually capturing.
  const startMicMeter = useCallback((media: MediaStream) => {
    const aTrack = media.getAudioTracks()[0];
    if (!aTrack) return;
    const acx = new AudioContext();
    const an = acx.createAnalyser(); an.fftSize = 512;
    acx.createMediaStreamSource(new MediaStream([aTrack])).connect(an);
    const data = new Uint8Array(an.frequencyBinCount);
    const loop = () => {
      an.getByteTimeDomainData(data);
      let peak = 0; for (const v of data) peak = Math.max(peak, Math.abs(v - 128));
      setMicLevel(peak / 128);
      meterRef.current = requestAnimationFrame(loop);
    };
    loop();
  }, []);

  // ---- publish mic+cam to the SFU (the one capture path) ----------------- //
  const start = useCallback(async () => {
    const media = await navigator.mediaDevices.getUserMedia({
      video: { width: resolution, height: Math.round(resolution * 0.75), frameRate: 15 },
      audio: { channelCount: 1, sampleRate: 48000, echoCancellation: true },
    });
    mediaRef.current = media;
    if (videoRef.current) { videoRef.current.srcObject = media; void videoRef.current.play().catch(() => {}); }
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
  }, [client, resolution, startMicMeter]);

  const stop = useCallback(() => {
    client.publish('media', 'bye', { role: 'app', streamId: STREAM_ID });
    pcRef.current?.close(); pcRef.current = null;
    mediaRef.current?.getTracks().forEach((t) => t.stop()); mediaRef.current = null;
    if (meterRef.current) cancelAnimationFrame(meterRef.current);
    setTracks({ audio: false, video: false }); setMicLevel(0);
    setPublishing(false);
  }, [client]);

  useEffect(() => () => stop(), [stop]);

  // SFU's producer-answer/ice for our one producer PC.
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

  // Resolution change → republish so the new res reaches the model.
  const switchResolution = useCallback((res: 320 | 512) => {
    setResolution(res);
    if (publishing) { stop(); setTimeout(() => void start(), 300); }
  }, [publishing, stop, start]);

  const saveInstruction = useCallback(async () => {
    const r = await api.post<{ base: string; extra: string }>('/perception/instruction', { extra });
    setExtra(r.extra);
    setSaved(true); setTimeout(() => setSaved(false), 2000);
  }, [extra]);

  const clearSnaps = useCallback(async () => {
    setSnaps([]);
    try { await api.post('/perception/snapshots/clear', {}); } catch { /* */ }
  }, []);

  // ---- summarization playground ----------------------------------------- //
  const [sumWindow, setSumWindow] = useState(60_000); // ms
  const [sumKeyframes, setSumKeyframes] = useState(false);
  const [sumModel, setSumModel] = useState('gemini-2.5-flash');
  const [sumBusy, setSumBusy] = useState(false);
  const [sumResult, setSumResult] = useState<SummaryResult | null>(null);
  const [showPrompt, setShowPrompt] = useState(false);
  // Progress phase shown while a Summarize is running (null when idle).
  const [sumPhase, setSumPhase] = useState<null | 'flushing' | 'thinking'>(null);
  // The window FROZEN at the last Summarize click — the log pins to this (not a
  // sliding now−w), so what you see == what the LLM got. null = follow live.
  const [pinnedWindow, setPinnedWindow] = useState<{ from: string; to: string } | null>(null);

  // A take is a FROZEN snapshot bundle. When one is loaded, Summarize runs against
  // the take (same fixed input) instead of the live window — true A/B comparison.
  const refreshTakes = useCallback(async () => {
    try { setTakes(await api.get<TakeMeta[]>('/perception/takes')); } catch { /* */ }
  }, []);
  useEffect(() => { void refreshTakes(); }, [refreshTakes]);

  const runSummary = useCallback(async () => {
    setSumBusy(true); setSumResult(null);
    try {
      let r: SummaryResult;
      if (activeTake) {
        // Frozen take: bounds are the take's own; nothing to flush or pin.
        setSumPhase('thinking');
        r = await api.post<SummaryResult>('/perception/takes/summarize',
          { name: activeTake, withKeyframes: sumKeyframes, maxKeyframes: 6, model: sumModel });
      } else {
        // 1) FLUSH the in-flight tail: force-commit the open utterance + a fresh
        //    one-shot vision analysis, so the freshest moment ("right now") is in
        //    the store. Without this, the loop's in-flight cycle (~3-6s) is missed.
        setSumPhase('flushing');
        const realStreamId = snaps[snaps.length - 1]?.source.id;
        try { await api.post('/perception/snapshots/flush', { streamId: realStreamId }); }
        catch { /* flush is best-effort; summarize what's there */ }
        // 2) Pin the window NOW (after the flush committed) and summarize that exact
        //    range — the log freezes to the same window the server filtered.
        setSumPhase('thinking');
        const to = istIso(0), from = istIso(sumWindow);
        setPinnedWindow({ from, to });
        r = await api.post<SummaryResult>('/perception/snapshots/summarize',
          { fromIso: from, toIso: to, withKeyframes: sumKeyframes, maxKeyframes: 6, model: sumModel });
      }
      setSumResult(r);
    } catch (e) { setSumResult({ summary: '', error: String(e), model: '', withKeyframes: false,
      counts: { vision: 0, speech: 0, identity: 0, emotion: 0, bodymotion: 0, keyframes: 0 }, prompt: { system: '', transcript: '' } }); }
    setSumPhase(null); setSumBusy(false);
  }, [sumWindow, sumKeyframes, sumModel, activeTake, snaps]);

  // Changing the window picker (or window-only toggle off) un-pins → log follows live again.
  const pickWindow = useCallback((ms: number) => { setSumWindow(ms); setPinnedWindow(null); }, []);

  // Save the current view to a named take. If a take is loaded, save the live
  // window; otherwise freeze the selected summarize window.
  const saveTake = useCallback(async () => {
    const name = window.prompt('Name this take (e.g. "coding-session", "two-people"):');
    if (!name?.trim()) return;
    try {
      await api.post('/perception/takes/save', { name: name.trim(), windowMs: sumWindow });
      await refreshTakes();
    } catch (e) { window.alert(`save failed: ${e}`); }
  }, [sumWindow, refreshTakes]);

  // Load a take's records into the log (so the feed shows exactly the frozen data),
  // and pin Summarize to it. Click the active take again to return to live.
  const loadTake = useCallback(async (name: string) => {
    if (activeTake === name) { setActiveTake(null); return; } // toggle back to live
    try {
      const t = await api.get<{ records: Snapshot[] }>(`/perception/takes/load?name=${encodeURIComponent(name)}`);
      setSnaps(t.records); setActiveTake(name); setSumResult(null);
    } catch (e) { window.alert(`load failed: ${e}`); }
  }, [activeTake]);

  const deleteTake = useCallback(async (name: string) => {
    if (!window.confirm(`Delete take "${name}"?`)) return;
    try { await api.post('/perception/takes/delete', { name }); if (activeTake === name) setActiveTake(null); await refreshTakes(); }
    catch { /* */ }
  }, [activeTake, refreshTakes]);

  // Enroll the face in the live stream under a name (so vision says "Guru", not
  // "a person"). Uses the running WebRTC producer's current frame.
  const enroll = useCallback(async () => {
    const name = enrollName.trim();
    if (!name) return;
    // Use the REAL stream id the processors see (the WS peer id), read from the
    // latest snapshot's source — not our payload STREAM_ID, which the SFU rekeys.
    const realStreamId = snaps[snaps.length - 1]?.source.id;
    if (!realStreamId) { setEnrollMsg('✗ no live stream yet'); setTimeout(() => setEnrollMsg(''), 3000); return; }
    try {
      const r = await api.post<{ ok: boolean; reason?: string }>('/perception/enroll',
        { streamId: realStreamId, name });
      setEnrollMsg(r.ok ? `✓ enrolled ${name}` : `✗ ${r.reason ?? 'failed'}`);
      if (r.ok) setEnrollName('');
    } catch { setEnrollMsg('✗ error'); }
    setTimeout(() => setEnrollMsg(''), 3000);
  }, [enrollName, snaps]);

  // Ordered by start; latest of each modality for the live captions.
  const ordered = [...snaps].sort((a, b) =>
    a.interval.from < b.interval.from ? -1 : a.interval.from > b.interval.from ? 1 : 0);
  const showByKind: Record<Snapshot['source']['kind'], boolean> =
    { vision: showVision, speech: showSpeech, identity: showIdentity, emotion: showIdentity, bodymotion: showIdentity };
  // When "limit to window" is on, show ONLY the records the LLM would get. After a
  // Summarize, pin to the FROZEN window the server actually used (pinnedWindow /
  // sumResult.window) so the log matches the summary exactly; before that, preview
  // the sliding now−w window. Overlap-based (a record counts if any part is inside),
  // matching the server's store.inWindow — so straddling records aren't dropped.
  const win = sumResult?.window ?? pinnedWindow;
  const from = win?.from ?? istIso(sumWindow);
  const to = win?.to ?? istIso(0);
  const filtered = ordered
    .filter((s) => showByKind[s.source.kind])
    .filter((s) => !limitToWindow || (s.interval.to >= from && s.interval.from <= to));
  const latestVision = [...ordered].reverse().find((s) => s.source.kind === 'vision');
  const latestSpeech = [...ordered].reverse().find((s) => s.source.kind === 'speech');
  const istTime = (iso: string) => iso.slice(11, 19);
  const secs = (ms: number) => `${(ms / 1000).toFixed(1)}s`;
  const visionModel = latestVision?.model.name ?? snaps.find((s) => s.source.kind === 'vision')?.model.name ?? 'qwen2.5-vl';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <style>{`
        @keyframes perc-spin { to { transform: rotate(360deg); } }
        .perc-spin { animation: perc-spin 0.7s linear infinite; }
        @keyframes perc-indeterminate { 0% { left: -30px; } 100% { left: 80px; } }
        .perc-indeterminate { animation: perc-indeterminate 1s ease-in-out infinite; }
      `}</style>
      {/* TOP: live video + publish | instruction + live captions */}
      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, width: 360 }}>
          <video ref={videoRef} muted playsInline
            style={{ width: 360, height: 270, background: '#070a11', borderRadius: 10, objectFit: 'cover', display: 'block' }} />
          <button onClick={publishing ? stop : start}
            style={{ padding: '8px 14px', borderRadius: 8, background: publishing ? '#3a1320' : '#13243a', color: '#cfe', border: '1px solid #1c2233' }}>
            {publishing ? '■ Stop stream' : '● Start stream (mic + cam over WebRTC)'}
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
          {/* model is fixed (qwen); resolution is real — it changes what the model sees */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 14, fontSize: 12 }}>
            <span style={{ opacity: 0.6 }}>model: <b style={{ color: '#cfe' }}>{visionModel}</b></span>
            <Toggle label="Resolution" value={String(resolution)}
              options={[['320', '320px'], ['512', '512px']]}
              onChange={(v) => switchResolution(Number(v) as 320 | 512)} />
          </div>
          {/* Enroll a face → name (so vision says the name, not "a person") */}
          {publishing && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
              <input value={enrollName} onChange={(e) => setEnrollName(e.target.value)}
                placeholder="name this face…"
                style={{ flex: 1, background: '#0b0e16', color: '#cfe', border: '1px solid #1c2233', borderRadius: 6, padding: '4px 8px', fontSize: 12 }} />
              <button onClick={enroll}
                style={{ padding: '4px 10px', borderRadius: 6, background: '#13243a', color: '#cfe', border: '1px solid #1c2233', cursor: 'pointer' }}>
                Enroll
              </button>
              {enrollMsg && <span style={{ color: enrollMsg.startsWith('✓') ? '#6f6' : '#f88' }}>{enrollMsg}</span>}
            </div>
          )}
        </div>

        <div style={{ flex: 1, minWidth: 280, display: 'flex', flexDirection: 'column', gap: 6 }}>
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
          <div style={{ marginTop: 6 }}>
            <div className="side-section-label">🎙 Latest speech</div>
            <div style={{ marginTop: 4, padding: '10px 12px', minHeight: 40, background: '#0b0e16',
              border: '1px solid #1c2233', borderRadius: 8, fontSize: 15, lineHeight: 1.4,
              color: latestSpeech ? '#9ecbff' : '#566' }}>
              {latestSpeech ? latestSpeech.payload.text : 'waiting for speech…'}
            </div>
          </div>
          <div>
            <div className="side-section-label">👁 Latest vision</div>
            <div style={{ marginTop: 4, padding: '10px 12px', minHeight: 56, background: '#0b0e16',
              border: '1px solid #1c2233', borderRadius: 8, fontSize: 14, lineHeight: 1.45,
              color: latestVision ? '#dfe' : '#566' }}>
              {latestVision ? latestVision.payload.text : 'waiting for video…'}
            </div>
          </div>
        </div>
      </div>

      {/* SUMMARIZE — the playground: window + model + keyframes, full prompt shown */}
      <div style={{ border: '1px solid #1c2233', borderRadius: 10, padding: 12, background: '#0a0d14' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
          <div className="side-section-label">🧠 Summarize</div>
          <div style={{ display: 'flex', gap: 2, background: '#0b0e16', borderRadius: 8, padding: 2 }}>
            {WINDOWS.map(([ms, lbl]) => (
              <button key={ms} onClick={() => pickWindow(ms)}
                style={{ padding: '4px 12px', borderRadius: 6, fontSize: 12, border: 'none', cursor: 'pointer',
                  background: sumWindow === ms ? '#2563eb' : 'transparent', color: sumWindow === ms ? '#fff' : '#9ab' }}>
                {lbl}
              </button>
            ))}
          </div>
          <select value={sumModel} onChange={(e) => setSumModel(e.target.value)}
            style={{ background: '#0b0e16', color: '#cfe', border: '1px solid #1c2233', borderRadius: 6, padding: '4px 8px', fontSize: 12 }}>
            <option value="gemini-2.5-flash">gemini-2.5-flash</option>
            <option value="gemini-2.5-flash-lite">gemini-2.5-flash-lite</option>
            <option value="gemini-2.5-pro">gemini-2.5-pro</option>
            <option value="gemini-2.0-flash">gemini-2.0-flash</option>
          </select>
          <label style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 12, cursor: 'pointer' }}>
            <input type="checkbox" checked={sumKeyframes} onChange={(e) => setSumKeyframes(e.target.checked)} /> + keyframes
          </label>
          <button onClick={runSummary} disabled={sumBusy}
            style={{ padding: '6px 16px', borderRadius: 8, background: sumBusy ? '#1c2233' : '#1e3a5f', color: '#cfe', border: '1px solid #2c4a6f', cursor: sumBusy ? 'default' : 'pointer' }}>
            {sumBusy ? '…' : activeTake ? `Summarize take` : 'Summarize'}
          </button>
          <button onClick={saveTake} disabled={sumBusy} title="Freeze the selected window to disk for A/B replay"
            style={{ padding: '6px 12px', borderRadius: 8, background: 'transparent', color: '#9cb', border: '1px solid #1c3322', cursor: sumBusy ? 'default' : 'pointer', fontSize: 12, opacity: sumBusy ? 0.4 : 1 }}>
            💾 Save take
          </button>
          {/* PROGRESS indicator — which phase the summarize is in (so it's never a
              silent wait). Animated dot + label + indeterminate bar. */}
          {sumBusy && (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 12, color: '#9ecbff' }}>
              <span className="perc-spin" style={{ width: 11, height: 11, borderRadius: '50%',
                border: '2px solid #2c4a6f', borderTopColor: '#9ecbff', display: 'inline-block' }} />
              {sumPhase === 'flushing' ? 'capturing the current moment…'
                : sumPhase === 'thinking' ? `thinking (${MODEL_SHORT(sumModel)})…`
                : 'working…'}
              <span style={{ position: 'relative', width: 80, height: 3, background: '#1c2233', borderRadius: 2, overflow: 'hidden' }}>
                <span className="perc-indeterminate" style={{ position: 'absolute', height: '100%', width: 30, background: '#9ecbff', borderRadius: 2 }} />
              </span>
            </span>
          )}
          {!sumBusy && sumResult && <span style={{ fontSize: 11, opacity: 0.6 }}>
            {sumResult.model} · 👁{sumResult.counts.vision} 🎙{sumResult.counts.speech} 👤{sumResult.counts.identity}
            {sumResult.counts.emotion > 0 ? ` 😮${sumResult.counts.emotion}` : ''}
            {sumResult.counts.bodymotion > 0 ? ` 🤖${sumResult.counts.bodymotion}` : ''}
            {sumResult.counts.keyframes > 0 ? ` · 🖼${sumResult.counts.keyframes}` : ''}
          </span>}
        </div>

        {/* Saved takes — frozen bundles for apples-to-apples A/B (same input, vary
            prompt/model/keyframes). Click to load (pins Summarize to it); click the
            active one to return to live. */}
        {takes.length > 0 && (
          <div style={{ marginTop: 8, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 11, opacity: 0.55 }}>takes:</span>
            {activeTake && <span style={{ fontSize: 11, color: '#7ec699' }}>● replaying frozen data — Summarize/window use the take</span>}
            {takes.map((t) => {
              const on = activeTake === t.name;
              return (
                <span key={t.name} style={{ display: 'inline-flex', alignItems: 'center', gap: 4,
                  padding: '2px 4px 2px 8px', borderRadius: 6, fontSize: 12,
                  background: on ? '#13301f' : '#0b0e16', border: `1px solid ${on ? '#2c6f4a' : '#1c2233'}` }}>
                  <button onClick={() => loadTake(t.name)} title={`${t.range.from.slice(11,19)}–${t.range.to.slice(11,19)} · 👁${t.counts.vision} 🎙${t.counts.speech} 👤${t.counts.identity}`}
                    style={{ background: 'transparent', border: 'none', color: on ? '#9fe' : '#bcd', cursor: 'pointer', fontSize: 12, padding: 0 }}>
                    {on ? '▣' : '▢'} {t.name}
                  </button>
                  <button onClick={() => deleteTake(t.name)} title="delete take"
                    style={{ background: 'transparent', border: 'none', color: '#a66', cursor: 'pointer', fontSize: 11, padding: '0 2px' }}>✕</button>
                </span>
              );
            })}
          </div>
        )}

        {!sumBusy && sumResult && (
          <div style={{ marginTop: 10 }}>
            {/* WINDOW the summary covers — the exact IST range that was summarized. */}
            {sumResult.window && !sumResult.error && (
              <div style={{ fontSize: 11, color: '#8fb3d9', marginBottom: 4, fontVariantNumeric: 'tabular-nums' }}>
                🕒 window {sumResult.window.from.slice(11, 19)}–{sumResult.window.to.slice(11, 19)} IST
                <span style={{ opacity: 0.55 }}> ({secs(new Date(sumResult.window.to).getTime() - new Date(sumResult.window.from).getTime())}) · summarized {istTime(istIso(0))}</span>
              </div>
            )}
            {sumResult.error
              ? <div style={{ color: '#f88', fontSize: 13 }}>error: {sumResult.error}</div>
              : <div style={{ padding: '12px 14px', background: '#0b0e16', border: '1px solid #1c2233', borderRadius: 8,
                  fontSize: 14, lineHeight: 1.55, color: '#dfe', whiteSpace: 'pre-wrap' }}>{sumResult.summary}</div>}
            {/* collapsible: the exact prompt + stitched transcript that was sent */}
            <button onClick={() => setShowPrompt((v) => !v)}
              style={{ marginTop: 8, padding: '3px 10px', borderRadius: 6, background: 'transparent', color: '#9ab', border: '1px solid #1c2233', cursor: 'pointer', fontSize: 12 }}>
              {showPrompt ? '▾ hide' : '▸ show'} prompt + stitched input
            </button>
            {showPrompt && (
              <div style={{ marginTop: 6, display: 'flex', flexDirection: 'column', gap: 8 }}>
                <details open>
                  <summary style={{ cursor: 'pointer', fontSize: 12, opacity: 0.7 }}>system prompt</summary>
                  <pre style={{ margin: '4px 0', padding: 10, background: '#070a11', borderRadius: 6, fontSize: 11, color: '#9ab', whiteSpace: 'pre-wrap', overflow: 'auto', maxHeight: 200 }}>{sumResult.prompt.system}</pre>
                </details>
                <details open>
                  <summary style={{ cursor: 'pointer', fontSize: 12, opacity: 0.7 }}>stitched timeline (sent to model)</summary>
                  <pre style={{ margin: '4px 0', padding: 10, background: '#070a11', borderRadius: 6, fontSize: 11, color: '#bcd', whiteSpace: 'pre-wrap', overflow: 'auto', maxHeight: 260 }}>{sumResult.prompt.transcript}</pre>
                </details>
              </div>
            )}
          </div>
        )}
      </div>

      {/* OUTPUT: the single snapshot timeline (vision + speech, by start, IST) */}
      <div>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
          <div className="side-section-label">Snapshots ({filtered.length}) · ordered by start · IST</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 14, fontSize: 12, opacity: 0.85 }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 5, cursor: 'pointer' }}>
              <input type="checkbox" checked={showVision} onChange={(e) => setShowVision(e.target.checked)} /> 👁 vision
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 5, cursor: 'pointer' }}>
              <input type="checkbox" checked={showSpeech} onChange={(e) => setShowSpeech(e.target.checked)} /> 🎙 speech
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 5, cursor: 'pointer' }}>
              <input type="checkbox" checked={showIdentity} onChange={(e) => setShowIdentity(e.target.checked)} /> 👤 who
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}
              title={win ? `Pinned to the window the last Summarize used: ${win.from.slice(11,19)}–${win.to.slice(11,19)} IST` : 'Show ONLY records inside the selected Summarize window — exactly what goes to the LLM'}>
              <input type="checkbox" checked={limitToWindow} onChange={(e) => setLimitToWindow(e.target.checked)} />
              ⏱ window only{limitToWindow
                ? win
                  ? ` 📌 ${win.from.slice(11, 19)}–${win.to.slice(11, 19)}`
                  : ` (${WINDOWS.find(([ms]) => ms === sumWindow)?.[1] ?? ''})`
                : ''}
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
              <input type="checkbox" checked={autoScroll} onChange={(e) => setAutoScroll(e.target.checked)} /> Auto-scroll
            </label>
            <button onClick={clearSnaps}
              style={{ padding: '3px 10px', borderRadius: 6, background: '#1a1320', color: '#e9a', border: '1px solid #3a2230', cursor: 'pointer', fontSize: 12 }}>
              Clear
            </button>
          </div>
        </div>
        <div ref={feedRef} onScroll={onFeedScroll}
          style={{ maxHeight: 380, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 4,
            background: '#0b0e16', borderRadius: 10, padding: 10, fontSize: 13, lineHeight: 1.5 }}>
          {filtered.length === 0
            ? <div className="empty">No snapshots yet. Start the stream — vision runs latency-bound, speech per utterance.</div>
            : filtered.map((s, i) => {
              const p = s.payload;
              const conf = p.confidence != null ? `${Math.round(p.confidence * 100)}%` : null;
              return (
                <div key={i} style={{ display: 'flex', gap: 8, color: KIND_COLOR[s.source.kind], alignItems: 'baseline' }}>
                  <span style={{ opacity: 0.45, fontVariantNumeric: 'tabular-nums', width: 138, fontSize: 12 }}>
                    {istTime(s.interval.from)}–{istTime(s.interval.to)}
                    <span style={{ opacity: 0.6 }}> ({secs(s.interval.durationMs)})</span>
                  </span>
                  <span style={{ width: 18 }}>{KIND_ICON[s.source.kind]}</span>
                  {/* WHAT MODEL produced this (the actual model in use) */}
                  <span title={s.model.endpoint ?? ''}
                    style={{ width: 116, opacity: 0.5, fontSize: 11, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {MODEL_SHORT(s.model.name)}
                  </span>
                  <span style={{ flex: 1 }}>
                    {p.text}
                    {s.source.kind === 'speech' && p.lowConfidence && (
                      <span title="Whisper flagged this transcript as shaky (sent to the LLM tagged [low-confidence])"
                        style={{ marginLeft: 6, fontSize: 10, color: '#e0a060', border: '1px solid #5a3d20', borderRadius: 4, padding: '0 4px' }}>
                        low-conf
                      </span>
                    )}
                  </span>
                  {/* PERF + CONFIDENCE meta, right-aligned, tabular */}
                  <span style={{ fontVariantNumeric: 'tabular-nums', fontSize: 10, opacity: 0.5, textAlign: 'right', whiteSpace: 'nowrap', display: 'flex', gap: 8 }}>
                    {conf && <span title="match/expression confidence">◷ {conf}</span>}
                    {p.inferMs != null && <span title="inference latency (sidecar/in-process compute)">⚡{fmtMs(p.inferMs)}</span>}
                    {s.source.kind === 'vision' && p.frames != null && <span title="frames sampled this window">🎞{p.frames}</span>}
                    {s.source.kind === 'speech' && p.noSpeechProb != null && (
                      <span title="Whisper metrics — avg_logprob / no_speech_prob / compression_ratio">
                        lp{p.avgLogprob?.toFixed(2)} ns{p.noSpeechProb.toFixed(2)} cr{p.compressionRatio?.toFixed(1)}
                      </span>
                    )}
                  </span>
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
              background: value === val ? '#2563eb' : 'transparent', color: value === val ? '#fff' : '#9ab' }}>
            {lbl}
          </button>
        ))}
      </div>
    </div>
  );
}

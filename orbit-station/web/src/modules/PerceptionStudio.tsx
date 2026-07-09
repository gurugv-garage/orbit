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
import React from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useStationClient, useStationEvents } from '../lib/useStation';
import { api } from '../lib/station';
import { LiveTile } from './LiveTile';

const STREAM_ID = 'console-perception'; // this console's producer peer id

// `kind` is an open string, NOT a fixed union: the view is data-driven so a NEW
// perception pipeline (battery, temperature, …) that emits snapshots in this shared
// format gets its own lane + timeline rows automatically, with no UI change. Known
// kinds get a curated icon/color/label; unknown kinds fall back to a generic style.
type StreamKind = string;
interface Snapshot {
  ts: string; tz: string;
  source: { id: string; kind: StreamKind; device: string; host: string };
  model: { name: string; endpoint?: string };
  interval: { from: string; to: string; durationMs: number };
  payload: {
    text: string; latencyMs?: number; frames?: number; faces?: unknown[];
    inferMs?: number | null; confidence?: number; // perf + match confidence (all streams)
    // speech: low-confidence flag + Whisper's own metrics (for the playground)
    lowConfidence?: boolean; avgLogprob?: number | null; noSpeechProb?: number | null; compressionRatio?: number | null;
    // background AUDIO interpretation (bg-audio-summarizer.md): the acoustic event
    // fields patched onto a speech snapshot (or carried by a standalone 'sound'
    // snapshot). bgModel marks an upgraded record; audioModel is the interpreter
    // engine (distinct from source.model, the live STT engine). `speaker` survives
    // only on OLD records (per-clip diarization is retired).
    bgModel?: boolean; audioModel?: string; speaker?: number;
    audioKind?: string; salience?: string; summary?: string; trigger?: string;
    // vision: the model's structured "what changed vs the previous window" field.
    change?: string;
    // audio: dock-directed intent observed in the clip + the model's self-reported
    // confidences (a vibe, not a probability — but shown so nothing is hidden).
    addressedToRobot?: boolean; directive?: string;
    audioKindConf?: number; salienceConf?: number; addressConf?: number;
    bgTranscript?: string; gatedProbes?: number; confTier?: string;
    // summary pulses: exact lineage (the stitched input the summarizer digested).
    inputs?: string; inputCount?: number;
    // vision: why this analysis ran (scene-change / local-change / sense-wake / heartbeat).
    gateTrigger?: string;
    // vision leak-hunt: the exact frame qwen saw + the prompt it received.
    inputImage?: string; inputPrompt?: string;
    // the RAW STT transcript, preserved when the interpreter upgrades `text` — so the
    // 🎙 STT row shows what the live engine heard and the 🔊 audio row shows the
    // upgraded read. Absent on un-upgraded records (then the STT row uses `text`).
    sttText?: string;
  };
}

/** Per-kind presentation. Add an entry to give a new pipeline a curated look;
 *  anything not listed still renders via KIND_FALLBACK (so the UI never breaks on
 *  an unknown stream). label = human name shown in the lane header. */
const KIND_META: Record<string, { icon: string; color: string; label: string }> = {
  vision:     { icon: '👁', color: '#dfe',    label: 'vision' },
  // STT and the background AUDIO interpretation are SEPARATE concepts, though they
  // ride the same 'speech' snapshot: STT = the live transcript (parakeet/whisper);
  // audio = the background interpreter's read (what KIND of sound, how salient, a
  // cleaner transcript). Standalone non-speech events land as 'sound' snapshots.
  stt:         { icon: '🎙', color: '#9ecbff', label: 'STT' },
  audio:       { icon: '🔊', color: '#c9b6ff', label: 'audio' },
  sound:       { icon: '🔊', color: '#c9b6ff', label: 'sound' },
  identity:   { icon: '👤', color: '#ffd9a0', label: 'identity' },
  emotion:    { icon: '😮', color: '#ff9ed4', label: 'emotion' },
  bodymotion: { icon: '🤖', color: '#a0e0c0', label: 'bodymotion' },
};
const KIND_FALLBACK = { icon: '◇', color: '#bcd', label: '' };
function kindMeta(kind: string) {
  return KIND_META[kind] ?? { ...KIND_FALLBACK, label: kind };
}
/** Preferred lane/filter order; unknown (future) kinds sort after, alphabetically. */
const KIND_ORDER = ['vision', 'stt', 'audio', 'sound', 'identity', 'emotion', 'bodymotion'];

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

/** Read a param from the hash query (e.g. #perception?src=dock-redmi&hide=vision). */
function hashParam(key: string): string | null {
  const q = location.hash.split('?')[1];
  return q ? new URLSearchParams(q).get(key) : null;
}
/** Merge params into the hash query, preserving the bare view id. Empty value drops
 *  the key. Replaces history (no new entry per filter click). */
function setHashParams(patch: Record<string, string>): void {
  const [view, q] = location.hash.replace(/^#/, '').split('?');
  const params = new URLSearchParams(q ?? '');
  for (const [k, v] of Object.entries(patch)) { if (v) params.set(k, v); else params.delete(k); }
  const qs = params.toString();
  history.replaceState(null, '', `#${view}${qs ? `?${qs}` : ''}`);
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

/** Known-faces gallery: each person has N enrolled samples (descriptor + maybe a
 *  photo). Legacy entries carry one shared photo, so most samples are photo-less. */
interface GallerySample { index: number; photo?: string }
interface GalleryPerson { name: string; samples: GallerySample[] }

/** GET /api/perception/:dockId/perceive — the latest on-device MLKit face-track frame
 *  (the `perceive` stream, §7). `payload` mirrors the wire envelope; we read a glance. */
interface PerceiveFrame {
  ts: number;
  payload?: {
    faces?: Array<{ x: number; y: number; size: number; yaw?: number }>;
    zoom?: { ratio: number; min: number; max: number };
    emotion?: { kind: string; confidence: number };
    gesture?: { name: string; score: number };
    identity?: { name: string; confidence: number };
  };
}

/** GET /api/perception/sidecars — health of the two MLX apps. */
interface SidecarHealth {
  name: string; kind: string; url: string; up: boolean;
  model?: string | null; latencyMs?: number; error?: string;
}

/** One memory-curator pass (GET /api/perception/curator → recent[]). */
interface CuratePass {
  ts: number; dockId: string; op: 'consolidate' | 'reconcile';
  reviewed: number; created?: number; revised?: number; forgot?: number;
  reason?: 'flood' | 'age' | 'quiet';
  skipped?: string; changes: Array<{ kind: 'create' | 'revise' | 'forget'; id?: string; claim?: string }>;
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
  // Which SINGLE source the tab is scoped to: a dock/stream label (e.g. 'dock-redmi'
  // = a phone, 'console-perception' = this browser's cam/mic). One stream at a time —
  // to watch several at once, open multiple browser tabs with ?src=… . Empty until a
  // default is picked (first live dock, else this browser). Survives refresh via the
  // URL. The processors always run on EVERY live stream; this just focuses the view.
  const [source, setSource] = useState<string>(() => hashParam('src') ?? '');
  const [producers, setProducers] = useState<{ streamId: string; label: string; tracks: { audio: boolean; video: boolean } }[]>([]);
  // Timeline filter: the set of view-kinds currently HIDDEN (a checkbox per type,
  // data-driven — any kind present can be toggled, incl. future ones). Empty = all on.
  // Initialized from the URL so filters survive refreshes.
  const [hiddenKinds, setHiddenKinds] = useState<Set<string>>(
    () => new Set((hashParam('hide') ?? '').split(',').filter(Boolean)));
  // Summarize controls are collapsed by default — a compact button that expands its
  // window/model/keyframes inline, so the controls area stays small.
  const [showSummarizer, setShowSummarizer] = useState(false);
  // Sidecar detail panel (model/latency + start/stop/restart) — collapsed; the bar
  // shows just status dots until opened.
  const [showSidecars, setShowSidecars] = useState(false);
  // Vision-instruction editor — collapsed by default (the prompt is long); a bar
  // button reveals it below.
  const [showInstruction, setShowInstruction] = useState(false);
  // Known-faces gallery — collapsed; a bar button reveals it (enroll + manage).
  const [showFaces, setShowFaces] = useState(false);
  const [gallery, setGallery] = useState<GalleryPerson[]>([]);
  const [galleryOpen, setGalleryOpen] = useState<Set<string>>(new Set());
  // LIVE STT — pushed on the `perception` bus the instant the STT processor emits
  // (final on VAD endpoint, + interims during a turn), so the studio shows speech in
  // REAL TIME instead of waiting for the 1.5s snapshot poll. Keyed by dockId.
  const [liveStt, setLiveStt] = useState<{ dockId: string; text: string; isFinal: boolean; ts: number } | null>(null);
  // LIVE on-device FACE-TRACK (the `perceive` stream, §7) for the selected dock — the
  // fast MLKit signal faceFollow steers on. Polled (not bus-pushed) since it's a glance,
  // not a log. Null = nothing arrived (or this source is the browser, not a dock).
  const [perceive, setPerceive] = useState<PerceiveFrame | null>(null);
  const [autoScroll, setAutoScroll] = useState(true);
  const [limitToWindow, setLimitToWindow] = useState(false);
  const [enrollName, setEnrollName] = useState('');
  const [enrollMsg, setEnrollMsg] = useState('');
  // Frozen-take A/B replay: saved bundles + which one is loaded (null = live).
  const [takes, setTakes] = useState<TakeMeta[]>([]);
  const [activeTake, setActiveTake] = useState<string | null>(null);
  // Sidecar health (the two MLX apps — the only out-of-process pieces). Polled so
  // the studio shows up/down + model, with start/stop/restart buttons.
  const [sidecars, setSidecars] = useState<SidecarHealth[]>([]);
  const [sidecarBusy, setSidecarBusy] = useState<string | null>(null); // "<name>:<op>"
  // Background AUDIO interpreter (Gemini) — a live runtime toggle. enabled =
  // interpret significant acoustic windows online (kind/salience/summary + a cleaner
  // transcript; off = local Whisper only.
  const [bgAudio, setBgAudio] = useState<{ enabled: boolean; model: string }>({ enabled: false, model: 'gemini-2.5-flash-lite' });
  const [bgAudioBusy, setBgAudioBusy] = useState(false);
  // MEMORY CURATOR — the pipeline's belief-maintenance loop. Live toggle + a feed of
  // recent passes (what it revised/forgot) + a "run now" debug button.
  const [showCurator, setShowCurator] = useState(false);
  const [curator, setCurator] = useState<{ enabled: boolean; recent: CuratePass[] }>({ enabled: false, recent: [] });
  const [curatorBusy, setCuratorBusy] = useState(false);
  // curator live-tunable config (ALL docks) + per-knob bounds/notes from the server.
  const [curatorCfg, setCuratorCfg] = useState<Record<string, number>>({});
  const [curatorMeta, setCuratorMeta] = useState<Record<string, { min: number; max: number; unit: string; note: string }>>({});
  const [cfgSaved, setCfgSaved] = useState<string | null>(null); // last-applied knob (flash "✓")

  const pcRef = useRef<RTCPeerConnection | null>(null);
  const mediaRef = useRef<MediaStream | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const meterRef = useRef<number | null>(null);
  const feedRef = useRef<HTMLDivElement>(null);

  // Load instruction + bg-audio state once.
  useEffect(() => {
    api.get<{ base: string; extra: string }>('/perception/instruction')
      .then((r) => { setBase(r.base); setExtra(r.extra); }).catch(() => {});
    api.get<{ enabled: boolean; model: string }>('/perception/bg-audio')
      .then(setBgAudio).catch(() => {});
  }, []);

  // LIVE on-device face-track for the selected dock (the `perceive` stream): poll ~1 Hz
  // (it arrives ~1 Hz, deduped on the phone). Only for a real dock source — the browser
  // console stream has no on-device MLKit pass. Clears when the source changes.
  useEffect(() => {
    setPerceive(null);
    if (!source || source === STREAM_ID) return;
    let alive = true;
    const tick = () => api.get<PerceiveFrame>(`/perception/${encodeURIComponent(source)}/perceive`)
      .then((r) => { if (alive) setPerceive(r.payload ? r : null); }).catch(() => {});
    tick();
    const t = setInterval(tick, 1000);
    return () => { alive = false; clearInterval(t); };
  }, [source]);

  // Memory curator — load on mount, poll while the panel is open (so the recent feed
  // stays live), and expose toggle + run-now.
  const loadCurator = useCallback(() => {
    api.get<{ enabled: boolean; recent: CuratePass[] }>('/perception/curator')
      .then(setCurator).catch(() => {});
  }, []);
  useEffect(loadCurator, [loadCurator]);
  useEffect(() => {
    if (!showCurator) return;
    const t = setInterval(loadCurator, 4000);
    return () => clearInterval(t);
  }, [showCurator, loadCurator]);
  const toggleCurator = useCallback(async () => {
    setCuratorBusy(true);
    try { const r = await api.post<{ enabled: boolean }>('/perception/curator', { enabled: !curator.enabled });
      setCurator((c) => ({ ...c, enabled: r.enabled })); }
    finally { setCuratorBusy(false); }
  }, [curator.enabled]);
  const runCurator = useCallback(async () => {
    setCuratorBusy(true);
    try { await api.post('/perception/curator/run', {}); loadCurator(); }
    finally { setCuratorBusy(false); }
  }, [loadCurator]);
  // curator config (knobs) — load when the panel opens; apply a single knob live.
  const loadCuratorCfg = useCallback(() => {
    api.get<{ config: Record<string, number>; meta: typeof curatorMeta }>('/perception/curator/config')
      .then((r) => { setCuratorCfg(r.config); setCuratorMeta(r.meta); }).catch(() => {});
  }, []);
  useEffect(() => { if (showCurator) loadCuratorCfg(); }, [showCurator, loadCuratorCfg]);
  const applyKnob = useCallback(async (key: string, value: number) => {
    // server clamps to bounds + returns the resulting config — we adopt THAT (honest feedback:
    // the field shows what actually applied, not what was typed, if clamped).
    const r = await api.post<{ config: Record<string, number> }>('/perception/curator/config', { [key]: value });
    setCuratorCfg(r.config);
    setCfgSaved(key); setTimeout(() => setCfgSaved((k) => (k === key ? null : k)), 1500);
  }, []);

  // Known-faces gallery (load once + after each enroll).
  const loadGallery = useCallback(() => {
    api.get<{ people?: GalleryPerson[]; names?: string[] }>('/perception/gallery')
      .then((g) => setGallery(g.people ?? (g.names ?? []).map((name) => ({ name, samples: [] }))))
      .catch(() => {});
  }, []);
  useEffect(loadGallery, [loadGallery]);
  const forgetFace = useCallback((name: string) => {
    api.post('/perception/gallery/remove', { name }).then(loadGallery).catch(() => {});
  }, [loadGallery]);
  const removeFaceSample = useCallback((name: string, index: number) => {
    api.post('/perception/gallery/sample/remove', { name, index }).then(loadGallery).catch(() => {});
  }, [loadGallery]);
  // Move ONE photo to another person (or a NEW name → creates them). Lets you fix
  // mislabeled captures + split a wrong photo out into the right person.
  const reassignSample = useCallback(async (from: string, index: number) => {
    const to = window.prompt(`This photo is actually… (type a name — new or existing):`)?.trim();
    if (!to) return;
    try {
      await api.post('/perception/gallery/sample/reassign', { from, index, to });
      loadGallery();
    } catch { /* */ }
  }, [loadGallery]);
  const renameFace = useCallback(async (from: string) => {
    const to = window.prompt(`Rename "${from}" to:`, from)?.trim();
    if (!to || to.toLowerCase() === from.toLowerCase()) {
      // same name, different case → still apply (canonicalizes display)
      if (to && to !== from) { await api.post('/perception/gallery/rename', { from, to }).catch(() => {}); loadGallery(); }
      return;
    }
    try {
      const r = await api.post<{ ok: boolean; merged: boolean }>('/perception/gallery/rename', { from, to });
      if (r.merged) window.alert(`Merged "${from}" into existing "${to}".`);
      loadGallery();
    } catch { /* */ }
  }, [loadGallery]);
  const toggleFace = useCallback((name: string) => setGalleryOpen((prev) => {
    const n = new Set(prev); n.has(name) ? n.delete(name) : n.add(name); return n;
  }), []);
  const cleanGallery = useCallback(async () => {
    // Drop photo-less samples too (the pre-fix descriptor-only ones) so every kept
    // sample is viewable. They still work for matching, so warn about the tradeoff.
    if (!window.confirm('Remove samples that have no photo?\n\nThey still help face matching, but can\'t be shown. Re-enrolling a person captures a photo on every angle.')) return;
    try {
      const r = await api.post<{ samples: number; people: number }>('/perception/gallery/clean', { photoless: true });
      window.alert(r.samples || r.people ? `Removed ${r.samples} photo-less/corrupt sample(s), ${r.people} now-empty person(s).` : 'Nothing to remove — every sample has a photo.');
      loadGallery();
    } catch { /* */ }
  }, [loadGallery]);

  // Persist source + timeline filters in the URL so they survive a refresh.
  useEffect(() => {
    setHashParams({
      src: source,
      hide: [...hiddenKinds].join(','),
    });
  }, [source, hiddenKinds]);

  // Flip the background audio interpreter (or change its model) live.
  const setBgAudioState = useCallback(async (patch: { enabled?: boolean; model?: string }) => {
    setBgAudioBusy(true);
    try { setBgAudio(await api.post<{ enabled: boolean; model: string }>('/perception/bg-audio', patch)); }
    catch { /* leave prior state */ }
    finally { setBgAudioBusy(false); }
  }, []);

  // Poll the LIVE snapshot ring (ordered by interval.from). Paused while a take is
  // loaded — then the feed holds the take's frozen records, not the live ring.
  useEffect(() => {
    if (activeTake) return; // showing frozen data; don't clobber it
    if (!source) { setSnaps([]); return; } // no source picked yet
    let alive = true;
    const q = `limit=400&dock=${encodeURIComponent(source)}`;
    const load = () => api.get<Snapshot[]>(`/perception/snapshots?${q}`)
      .then((r) => { if (alive) setSnaps(r); }).catch(() => {});
    load();
    const t = setInterval(load, 1500);
    return () => { alive = false; clearInterval(t); };
  }, [activeTake, source]);

  // Poll the live producers (the sources to choose from): every dock streaming +
  // this console's own browser stream if started. (perception-pipeline §1a)
  useEffect(() => {
    let alive = true;
    const load = () => api.get<{ producers?: { streamId: string; label: string; tracks: { audio: boolean; video: boolean } }[] }>('/media/status')
      .then((r) => { if (alive) setProducers(r.producers ?? []); }).catch(() => {});
    load();
    const t = setInterval(load, 3000);
    return () => { alive = false; clearInterval(t); };
  }, []);

  // Default the source once producers are known (no ?src= in the URL): prefer the
  // first live remote dock, else this browser. Single-stream view — no 'all'.
  useEffect(() => {
    if (source) return;
    const dock = producers.find((p) => p.label !== STREAM_ID);
    if (dock) setSource(dock.label);
    else if (producers.some((p) => p.label === STREAM_ID)) setSource(STREAM_ID);
  }, [producers, source]);

  // Poll sidecar health (every 4s — a /health ping each; cheap).
  useEffect(() => {
    let alive = true;
    const load = () => api.get<SidecarHealth[]>('/perception/sidecars')
      .then((r) => { if (alive) setSidecars(r); }).catch(() => {});
    load();
    const t = setInterval(load, 4000);
    return () => { alive = false; clearInterval(t); };
  }, []);

  // Start/stop/restart a sidecar, then refresh health (the new state shows after the
  // model loads — qwen ~10s; the 4s poll will catch it, this nudges it faster).
  const sidecarOp = useCallback(async (name: string, op: 'start' | 'stop' | 'restart') => {
    setSidecarBusy(`${name}:${op}`);
    try { await api.post(`/perception/sidecars/${name}/${op}`, {}); }
    catch { /* surfaced via the next health poll */ }
    finally {
      setSidecarBusy(null);
      try { setSidecars(await api.get<SidecarHealth[]>('/perception/sidecars')); } catch { /* */ }
    }
  }, []);

  useEffect(() => {
    if (autoScroll && feedRef.current) feedRef.current.scrollTop = feedRef.current.scrollHeight;
  }, [snaps, autoScroll, hiddenKinds]);

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

  // LIVE STT push — the perception bus emits a `transcript` result the moment STT
  // produces text (no poll wait). Show it instantly in ● Now for the selected source.
  useStationEvents('perception', useCallback((e) => {
    if (e.kind === 'enroll-result') { loadGallery(); return; }
    if (e.kind !== 'transcript') return;
    const r = e.payload as { dockId?: string; ts?: number; payload?: { text?: string; isFinal?: boolean } } | null;
    const text = r?.payload?.text?.trim();
    if (!r?.dockId || !text) return;
    setLiveStt({ dockId: r.dockId, text, isFinal: !!r.payload?.isFinal, ts: r.ts ?? 0 });
  }, [loadGallery]));

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
          { fromIso: from, toIso: to, withKeyframes: sumKeyframes, maxKeyframes: 6, model: sumModel, dock: source });
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
      if (r.ok) { setEnrollName(''); loadGallery(); } // reflect the new face immediately
    } catch { setEnrollMsg('✗ error'); }
    setTimeout(() => setEnrollMsg(''), 3000);
  }, [enrollName, snaps, loadGallery]);

  // The remote dock currently in view (undefined for 'this browser' → local preview,
  // or if the selected source isn't producing right now). Single stream — one tile.
  const selectedProducer = source && source !== STREAM_ID
    ? producers.find((p) => p.label === source) : undefined;

  // Ordered by start; latest of each modality for the live captions.
  const ordered = [...snaps].sort((a, b) =>
    a.interval.from < b.interval.from ? -1 : a.interval.from > b.interval.from ? 1 : 0);

  // Expand snapshots into TIMELINE ROWS. STT and the background AUDIO read are
  // separate row types even though they ride one 'speech' snapshot: an upgraded
  // utterance yields BOTH a 🎙 STT row (the live engine's transcript) AND a 🔊 audio
  // row (the interpreter's kind/salience/summary + cleaner transcript). Every other
  // kind (incl. standalone 'sound' events) is one row, keyed by its own kind.
  const rows: { snap: Snapshot; viewKind: string }[] = ordered.flatMap((s) => {
    if (s.source.kind === 'speech') {
      const out = [{ snap: s, viewKind: 'stt' }];
      if (s.payload.bgModel) out.push({ snap: s, viewKind: 'audio' });
      return out;
    }
    return [{ snap: s, viewKind: s.source.kind }];
  });
  // The view-kinds actually present (for the data-driven filter checkboxes), in
  // preferred order, then any unknown kind alphabetically.
  const presentKinds = [...new Set(rows.map((r) => r.viewKind))].sort((a, b) => {
    const ia = KIND_ORDER.indexOf(a), ib = KIND_ORDER.indexOf(b);
    if (ia !== -1 || ib !== -1) return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
    return a.localeCompare(b);
  });
  // When "limit to window" is on, show ONLY the records the LLM would get. After a
  // Summarize, pin to the FROZEN window the server actually used (pinnedWindow /
  // sumResult.window) so the log matches the summary exactly; before that, preview
  // the sliding now−w window. Overlap-based (a record counts if any part is inside),
  // matching the server's store.inWindow — so straddling records aren't dropped.
  const win = sumResult?.window ?? pinnedWindow;
  const from = win?.from ?? istIso(sumWindow);
  const to = win?.to ?? istIso(0);
  const filtered = rows
    .filter((r) => !hiddenKinds.has(r.viewKind))
    .filter((r) => !limitToWindow || (r.snap.interval.to >= from && r.snap.interval.from <= to));
  const latestVision = [...ordered].reverse().find((s) => s.source.kind === 'vision');
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
      {/* ONE compact control bar. Left: SOURCE chips (the primary control — what you're
          watching). Right (secondary): Summarize, the bg-audio toggle, and tiny
          sidecar status dots. Everything that expands (Summarize options, takes,
          result) drops BELOW this bar, only when opened — so the resting height is one
          row, not three stacked panels. */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
        padding: '6px 10px', background: '#0b0e16', border: '1px solid #1c2233', borderRadius: 10 }}>
        {/* SOURCE chips — one live stream at a time. (Watch several → open more tabs
            with ?src=… ; there is no merged 'all' view.) */}
        {producers.filter((p) => p.label !== STREAM_ID).map((p) => (
          <SourceChip key={p.streamId} active={source === p.label} onClick={() => setSource(p.label)}
            title={`${p.tracks.audio ? '🎙 audio ' : ''}${p.tracks.video ? '📹 video' : ''}`}>
            📱 {p.label}{p.tracks.video ? ' 📹' : ''}{p.tracks.audio ? ' 🎙' : ''}
          </SourceChip>
        ))}
        <SourceChip active={source === STREAM_ID} onClick={() => setSource(STREAM_ID)}
          title={publishing ? 'this laptop is streaming' : 'start the stream below to feed it'}>
          🖥 this browser{publishing ? ' ●' : ''}
        </SourceChip>
        {!selectedProducer && source && source !== STREAM_ID &&
          <span style={{ fontSize: 11, color: '#ffc454' }} title="The selected source isn't producing right now">⚠ offline</span>}

        {/* secondary controls, pushed right — compact, small font, each labeled */}
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', fontSize: 11 }}>
          {/* VISION INSTRUCTION — toggles the prompt editor below the bar */}
          <button onClick={() => setShowInstruction((v) => !v)}
            title="Steer the vision model's instruction"
            style={{ padding: '4px 10px', borderRadius: 8, fontSize: 11, cursor: 'pointer',
              background: showInstruction ? '#1e3a5f' : '#13243a', color: '#cfe', border: '1px solid #2c4a6f' }}>
            👁 vision prompt {showInstruction ? '▾' : '▸'}
          </button>
          {/* KNOWN FACES — enroll + manage the gallery, below the bar */}
          <button onClick={() => setShowFaces((v) => !v)}
            title="Enrolled faces — enroll the current source, view/forget"
            style={{ padding: '4px 10px', borderRadius: 8, fontSize: 11, cursor: 'pointer',
              background: showFaces ? '#1e3a5f' : '#13243a', color: '#cfe', border: '1px solid #2c4a6f' }}>
            👤 faces ({gallery.length}) {showFaces ? '▾' : '▸'}
          </button>
          {/* SUMMARIZE — toggles its options/result below the bar */}
          <button onClick={() => setShowSummarizer((v) => !v)} disabled={sumBusy}
            title="Summarize the recent window (expand for window/model/keyframes)"
            style={{ padding: '4px 10px', borderRadius: 8, fontSize: 11, cursor: sumBusy ? 'default' : 'pointer',
              background: showSummarizer ? '#1e3a5f' : '#13243a', color: '#cfe', border: '1px solid #2c4a6f' }}>
            🧠 summarize {showSummarizer ? '▾' : '▸'}
          </button>
          {/* BACKGROUND AUDIO INTERPRETER toggle */}
          <button disabled={bgAudioBusy} onClick={() => void setBgAudioState({ enabled: !bgAudio.enabled })}
            title={bgAudio.enabled ? `background audio interpreter ON (${bgAudio.model}) — click to turn off` : 'background audio interpreter OFF (local STT only) — click to turn on'}
            style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '4px 10px', borderRadius: 8, fontSize: 11, cursor: bgAudioBusy ? 'default' : 'pointer',
              background: bgAudio.enabled ? '#13301f' : '#10182a', color: bgAudio.enabled ? '#7ee0a0' : '#9cd',
              border: `1px solid ${bgAudio.enabled ? '#2c6f4a' : '#1c2233'}` }}>
            <span style={{ width: 7, height: 7, borderRadius: '50%', background: bgAudio.enabled ? '#3ad29f' : '#5a6172' }} />
            🔊 bg audio {bgAudioBusy ? '…' : bgAudio.enabled ? 'on' : 'off'}
          </button>
          {/* SIDECARS — status dots + label; click for the full panel */}
          <button onClick={() => setShowSidecars((v) => !v)} title="sidecar health (vision / speech) — click for controls"
            style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '4px 10px', borderRadius: 8, fontSize: 11,
              background: '#10141f', color: '#9ab', border: '1px solid #161c2b', cursor: 'pointer' }}>
            ⚙ sidecars {sidecars.length === 0 ? <span style={{ opacity: 0.5 }}>…</span> : sidecars.map((s) => (
              <span key={s.name} style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
                <span style={{ width: 7, height: 7, borderRadius: '50%', background: s.up ? '#3ad29f' : '#f6555a' }} />
                {s.name === 'vision' ? '👁' : '🎙'}
              </span>
            ))} {showSidecars ? '▾' : '▸'}
          </button>
          {/* MEMORY CURATOR — status dot + label; click for the control/watch panel */}
          <button onClick={() => setShowCurator((v) => !v)}
            title="Memory curator — the pipeline's belief-maintenance loop; click to toggle/watch/run"
            style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '4px 10px', borderRadius: 8, fontSize: 11,
              background: '#10141f', color: '#9ab', border: '1px solid #161c2b', cursor: 'pointer' }}>
            <span style={{ width: 7, height: 7, borderRadius: '50%', background: curator.enabled ? '#3ad29f' : '#5a6172' }} />
            🧹 curator {showCurator ? '▾' : '▸'}
          </button>
        </div>
      </div>

      {/* MEMORY CURATOR panel — enable toggle, run-now, and the recent-passes feed
          (what it reviewed/revised/forgot). The "watchable/debuggable" surface. */}
      {showCurator && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8,
          padding: '8px 12px', background: '#0b0e16', border: '1px solid #1c2233', borderRadius: 10 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 11, letterSpacing: '.12em', textTransform: 'uppercase', opacity: 0.6 }}>🧹 Memory curator</span>
            <span title="this config applies to ALL docks (the curator is one station-wide loop), not a single dock"
              style={{ fontSize: 10, padding: '1px 6px', borderRadius: 4, background: '#1a2433', color: '#8ab', border: '1px solid #243245' }}>all docks</span>
            <button disabled={curatorBusy} onClick={() => void toggleCurator()}
              title={curator.enabled ? 'maintenance ON — click to pause' : 'maintenance OFF — click to enable'}
              style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '3px 10px', borderRadius: 8, fontSize: 11, cursor: curatorBusy ? 'default' : 'pointer',
                background: curator.enabled ? '#13301f' : '#10182a', color: curator.enabled ? '#7ee0a0' : '#9cd',
                border: `1px solid ${curator.enabled ? '#2c6f4a' : '#1c2233'}` }}>
              <span style={{ width: 7, height: 7, borderRadius: '50%', background: curator.enabled ? '#3ad29f' : '#5a6172' }} />
              {curatorBusy ? '…' : curator.enabled ? 'on' : 'off'}
            </button>
            <button disabled={curatorBusy} onClick={() => void runCurator()} title="Force a curation pass now (bypasses the interval)"
              style={{ padding: '3px 10px', borderRadius: 8, fontSize: 11, cursor: curatorBusy ? 'default' : 'pointer',
                background: '#10182a', color: '#9cd', border: '1px solid #1c2233', opacity: curatorBusy ? 0.5 : 1 }}>▶ run now</button>
            <span style={{ fontSize: 11, opacity: 0.5 }}>consolidate speech → beliefs, reconcile (revise/forget) — long-term memory</span>
          </div>
          {/* live-tunable knobs (ALL docks) — each applies on the NEXT pass, no restart.
              The server clamps to bounds + returns the result, so the field reflects what
              ACTUALLY applied (honest feedback) and flashes ✓. */}
          {Object.keys(curatorCfg).length > 0 && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, padding: '2px 0' }}>
              {Object.entries(curatorCfg).map(([key, val]) => {
                const m = curatorMeta[key];
                return (
                  <label key={key} title={m ? `${m.note} (${m.min}–${m.max} ${m.unit})` : key}
                    style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, color: '#9ab' }}>
                    {key}
                    <input type="number" defaultValue={val} min={m?.min} max={m?.max}
                      key={`${key}:${val}`} /* re-mount when server value changes so clamps show */
                      onBlur={(e) => { const n = Number(e.target.value); if (Number.isFinite(n) && n !== val) void applyKnob(key, n); }}
                      onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
                      style={{ width: 74, padding: '2px 5px', fontSize: 11, borderRadius: 5,
                        background: '#0b0e16', color: '#cfe', border: '1px solid #243245' }} />
                    {cfgSaved === key && <span style={{ color: '#7ee0a0', fontSize: 11 }}>✓</span>}
                    {m && <span style={{ opacity: 0.35, fontSize: 10 }}>{m.unit}</span>}
                  </label>
                );
              })}
            </div>
          )}
          {/* recent passes feed */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4, maxHeight: 200, overflowY: 'auto' }}>
            {curator.recent.length === 0
              ? <span style={{ fontSize: 11, opacity: 0.4 }}>no passes yet</span>
              : curator.recent.map((p, i) => (
                <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11,
                  padding: '3px 8px', background: '#10141f', borderRadius: 6, border: '1px solid #161c2b' }}>
                  <span style={{ opacity: 0.5, fontVariantNumeric: 'tabular-nums' }}>{new Date(p.ts).toLocaleTimeString()}</span>
                  <span style={{ color: '#cfe' }}>{p.dockId}</span>
                  <span style={{ padding: '0 5px', borderRadius: 4, fontSize: 10,
                    background: p.op === 'consolidate' ? '#13243a' : '#1a1330',
                    color: p.op === 'consolidate' ? '#8cf' : '#c9a0ff' }}>{p.op}</span>
                  {p.reason && <span style={{ opacity: 0.45, fontSize: 10 }}>{p.reason}</span>}
                  <span style={{ opacity: 0.6 }}>reviewed {p.reviewed}</span>
                  {(p.created ?? 0) > 0 && <span style={{ color: '#7ee0a0' }}>+{p.created} created</span>}
                  {(p.revised ?? 0) > 0 && <span style={{ color: '#ffc454' }}>~{p.revised} revised</span>}
                  {(p.forgot ?? 0) > 0 && <span style={{ color: '#f88' }}>-{p.forgot} forgotten</span>}
                  {p.skipped && <span style={{ opacity: 0.5, fontStyle: 'italic' }}>skipped: {p.skipped}</span>}
                </div>
              ))}
          </div>
        </div>
      )}

      {/* SIDECAR panel — expanded on demand: model/latency + start/stop/restart. */}
      {showSidecars && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap',
          padding: '8px 12px', background: '#0b0e16', border: '1px solid #1c2233', borderRadius: 10 }}>
          <span style={{ fontSize: 11, letterSpacing: '.12em', textTransform: 'uppercase', opacity: 0.6 }}>⚙ Sidecars</span>
          {sidecars.map((s) => {
            const busy = sidecarBusy?.startsWith(`${s.name}:`);
            const btn = (op: 'start' | 'stop' | 'restart', label: string, color: string) => (
              <button key={op} disabled={!!sidecarBusy} onClick={() => void sidecarOp(s.name, op)}
                title={op} style={{ padding: '2px 8px', borderRadius: 6, fontSize: 11, cursor: sidecarBusy ? 'default' : 'pointer',
                  background: '#10182a', color, border: '1px solid #1c2233', opacity: sidecarBusy ? 0.5 : 1 }}>{label}</button>
            );
            return (
              <div key={s.name} style={{ display: 'flex', alignItems: 'center', gap: 8,
                padding: '4px 8px', background: '#10141f', borderRadius: 8, border: '1px solid #161c2b' }}>
                <span style={{ width: 8, height: 8, borderRadius: '50%',
                  background: s.up ? '#3ad29f' : '#f6555a', boxShadow: s.up ? '0 0 6px #3ad29f' : 'none' }} />
                <span style={{ fontSize: 12, fontWeight: 600, color: '#cfe' }}>{s.name === 'vision' ? '👁' : '🎙'} {s.name}</span>
                <span style={{ fontSize: 11, opacity: 0.55 }}>
                  {busy ? <b style={{ color: '#ffc454' }}>{sidecarBusy!.split(':')[1]}…</b>
                    : s.up ? `${(s.model ?? s.kind).split('/').pop()} · ${s.latencyMs}ms`
                    : (s.error ?? 'down')}
                </span>
                {s.up
                  ? <>{btn('restart', '↻', '#9cd')}{btn('stop', '■', '#f88')}</>
                  : btn('start', '▶ start', '#6f6')}
              </div>
            );
          })}
        </div>
      )}

      {/* SUMMARIZE options + result — only when expanded, dropping below the bar. */}
      {(showSummarizer || sumBusy || sumResult || takes.length > 0) && (
      <div style={{ border: '1px solid #1c2233', borderRadius: 10, padding: '8px 12px', background: '#0a0d14' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          {showSummarizer && <>
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
          </>}
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
      )}

      {/* VISION INSTRUCTION — collapsed by default (long prompt); toggled from the bar. */}
      {showInstruction && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: '10px 12px',
          background: '#0a0d14', border: '1px solid #1c2233', borderRadius: 10 }}>
          <div className="side-section-label">👁 Vision instruction</div>
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
            <span style={{ marginLeft: 'auto', fontSize: 12, opacity: 0.6 }}>vision model: <b style={{ color: '#cfe' }}>{visionModel}</b></span>
          </div>
        </div>
      )}

      {/* KNOWN FACES — collapsible: enroll the current source + manage the gallery. */}
      {showFaces && (
        <KnownFaces
          gallery={gallery} open={galleryOpen} onToggle={toggleFace}
          onForget={forgetFace} onRemoveSample={removeFaceSample} onClean={cleanGallery} onRename={renameFace} onReassign={reassignSample}
          enrollName={enrollName} setEnrollName={setEnrollName} onEnroll={enroll} enrollMsg={enrollMsg}
          canEnroll={!!snaps.length} />
      )}

      {/* VIDEO + ● NOW side by side — the live tile (selected dock, or this browser's
          own publish preview) on the left; the live per-stream read on the right. */}
      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'flex-start' }}>
        {source === STREAM_ID ? (
          // this browser: the local cam/mic preview + publish controls
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, width: 420 }}>
            <video ref={videoRef} muted playsInline
              style={{ width: 420, aspectRatio: '4 / 3', background: '#070a11', borderRadius: 10, objectFit: 'cover', display: 'block' }} />
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
            <div style={{ display: 'flex', alignItems: 'center', gap: 14, fontSize: 12 }}>
              <Toggle label="Resolution" value={String(resolution)}
                options={[['320', '320px'], ['512', '512px']]}
                onChange={(v) => switchResolution(Number(v) as 320 | 512)} />
            </div>
            {/* enrollment moved to the 👤 faces control up top */}
          </div>
        ) : selectedProducer ? (
          // a dock: its recvonly live tile (video + per-tile audio + enroll)
          <div style={{ width: 420, maxWidth: '100%' }}>
            <LiveTile streamId={selectedProducer.streamId} label={selectedProducer.label} />
          </div>
        ) : (
          <div style={{ width: 420, aspectRatio: '4 / 3', display: 'grid', placeItems: 'center',
            background: '#0b0e16', border: '1px solid #1c2233', borderRadius: 10, color: '#566', fontSize: 13 }}>
            {producers.length ? 'pick a source above' : 'no stream yet'}
          </div>
        )}

        {/* NOW — the live at-a-glance: latest result per active stream, beside the
            video. liveStt is the REAL-TIME STT push (no poll wait) for this source. */}
        <div style={{ flex: 1, minWidth: 280 }}>
          <LiveNow snaps={ordered} liveStt={liveStt && liveStt.dockId === source ? liveStt : null} />
          {/* On-device face-track (the `perceive` stream, §7) — the fast MLKit signal
              faceFollow steers on. A glance: count + the primary face's pose + the
              frame-level emotion/gesture/identity/zoom. */}
          {perceive?.payload && <PerceiveGlance frame={perceive} />}
        </div>
      </div>
      {/* OUTPUT: the single snapshot timeline (vision + speech, by start, IST) */}
      <div>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8, flexWrap: 'wrap', gap: 8 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <div className="side-section-label">
              Snapshots ({filtered.length}) · by start · IST
              {source && <span style={{ opacity: 0.6 }}> · {source === STREAM_ID ? '🖥 this browser' : `📱 ${source}`}</span>}
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, fontSize: 12, opacity: 0.85, flexWrap: 'wrap' }}>
            {/* ONE checkbox per row type present (data-driven — STT, audio, sound,
                vision, identity, emotion, bodymotion, + any future kind). */}
            {presentKinds.map((k) => {
              const km = kindMeta(k);
              const on = !hiddenKinds.has(k);
              return (
                <span key={k} style={{ display: 'inline-flex', alignItems: 'center', border: `1px solid ${on ? km.color : '#333'}`, borderRadius: 6, overflow: 'hidden', opacity: on ? 1 : 0.45 }}>
                  {/* the chip toggles this kind on/off */}
                  <button onClick={() => setHiddenKinds((prev) => { const n = new Set(prev); on ? n.add(k) : n.delete(k); return n; })}
                    style={{ background: 'none', border: 'none', color: km.color, cursor: 'pointer', padding: '2px 7px', fontSize: 12 }}
                    title={on ? `hide ${km.label}` : `show ${km.label}`}>
                    {km.icon} {km.label}
                  </button>
                  {/* explicit ONLY — one click to solo this kind */}
                  <button onClick={() => setHiddenKinds(new Set(presentKinds.filter((x) => x !== k)))}
                    style={{ background: '#1c2634', border: 'none', borderLeft: '1px solid #333', color: '#8fa8c8', cursor: 'pointer', padding: '2px 6px', fontSize: 10 }}
                    title={`show ONLY ${km.label}`}>only</button>
                </span>
              );
            })}
            {hiddenKinds.size > 0 && (
              <button onClick={() => setHiddenKinds(new Set())}
                style={{ background: '#1c2634', border: '1px solid #333', borderRadius: 6, color: '#b8c8dc', cursor: 'pointer', padding: '2px 8px', fontSize: 11 }}
                title="show every kind">show all</button>
            )}
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
            : filtered.map(({ snap: s, viewKind }, i) => {
              const p = s.payload;
              const m = kindMeta(viewKind);
              const isAudio = viewKind === 'audio';
              const isStt = viewKind === 'stt';
              // model per row type: the audio row → the interpreter engine; everything
              // else (incl. STT) → the snapshot's own model.
              const modelName = isAudio ? (p.audioModel ?? 'gemini') : s.model.name;
              const conf = p.confidence != null ? `${Math.round(p.confidence * 100)}%` : null;
              // STT row shows the RAW transcript (preserved); the audio row shows the
              // interpreter's read. When the words are identical, show the acoustic
              // SUMMARY instead of repeating them.
              const sttText = p.sttText ?? p.text;
              const audioSameWords = isAudio && p.text.trim() === sttText.trim();
              return (
                <div key={i} style={{ display: 'flex', gap: 8, color: m.color, alignItems: 'baseline',
                  // the audio row is a CHILD of its STT row — indent + dim so the pair
                  // reads as "utterance → interpreted acoustically", not two equals.
                  ...(isAudio ? { opacity: 0.82, paddingLeft: 14 } : {}) }}>
                  <span style={{ opacity: 0.45, fontVariantNumeric: 'tabular-nums', width: isAudio ? 124 : 138, fontSize: 12 }}>
                    {isAudio
                      ? <span style={{ opacity: 0.7 }}>↳ audio</span>
                      : <>{istTime(s.interval.from)}–{istTime(s.interval.to)}<span style={{ opacity: 0.6 }}> ({secs(s.interval.durationMs)})</span></>}
                  </span>
                  <span style={{ width: 18 }} title={m.label}>{m.icon}</span>
                  {/* WHAT MODEL produced this row */}
                  <span title={s.model.endpoint ?? ''}
                    style={{ width: 116, opacity: 0.5, fontSize: 11, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {MODEL_SHORT(modelName)}
                  </span>
                  <span style={{ flex: 1 }}>
                    {/* AUDIO row: structured chips — kind, salience (when it matters), and
                        dock-directed intent — each visually distinct. */}
                    {(isAudio || viewKind === 'sound') && p.audioKind && (
                      <span title="acoustic kind"
                        style={{ marginRight: 5, fontSize: 10, fontWeight: 700, color: '#7ee0a0', border: '1px solid #2c6f4a', borderRadius: 4, padding: '0 5px' }}>
                        {p.audioKind}
                      </span>
                    )}
                    {(isAudio || viewKind === 'sound') && (p.salience === 'notable' || p.salience === 'startling') && (
                      <span title="salience — would a head turn?"
                        style={{ marginRight: 5, fontSize: 10, fontWeight: 700, color: p.salience === 'startling' ? '#ff9e6b' : '#ffd9a0',
                          border: `1px solid ${p.salience === 'startling' ? '#7a3d20' : '#5a4a20'}`, borderRadius: 4, padding: '0 5px' }}>
                        {p.salience}{p.salience === 'startling' ? ' ⚡' : ''}
                      </span>
                    )}
                    {(isAudio || viewKind === 'sound') && p.addressedToRobot && (
                      <span title="the clip audibly addresses the robot (observation — the brain still decides)"
                        style={{ marginRight: 5, fontSize: 10, fontWeight: 700, color: '#7ec8ff', border: '1px solid #2c4a6f', borderRadius: 4, padding: '0 5px' }}>
                        → orbit{p.directive ? `: ${p.directive}` : ''}
                      </span>
                    )}
                    {isAudio
                      ? (audioSameWords
                          ? <span style={{ opacity: 0.6, fontStyle: 'italic' }}>{p.summary || '(same words)'}</span>
                          : p.text)
                      : sttText}
                    {/* HUMAN-READABLE full output: every field the producer emitted,
                        as plain-English fragments — not JSON. Only fields that exist. */}
                    {(() => {
                      const pct = (v: unknown) => (typeof v === 'number' ? `${Math.round(v * 100)}%` : '');
                      const bits: string[] = [];
                      if (viewKind === 'audio' || viewKind === 'sound') {
                        if (p.audioKind) bits.push(`heard: ${p.audioKind}${p.audioKindConf != null ? ` (${pct(p.audioKindConf)} sure)` : ''}`);
                        if (p.salience) bits.push(`salience: ${p.salience}${p.salienceConf != null ? ` (${pct(p.salienceConf)})` : ''}`);
                        if (p.addressedToRobot) bits.push(`spoke TO orbit${p.directive ? ` — ${p.directive}` : ''}${p.addressConf != null ? ` (${pct(p.addressConf)})` : ''}`);
                        if (p.summary && p.summary !== p.text) bits.push(`in short: ${p.summary}`);
                        if (p.trigger) bits.push(`woken by: ${p.trigger}`);
                        if (p.bgTranscript && p.bgTranscript !== p.text) bits.push(`alt hearing: “${p.bgTranscript}”`);
                      } else if (viewKind === 'vision') {
                        if (p.gateTrigger) bits.push(`looked because: ${String(p.gateTrigger).replace('local-change', 'something moved locally').replace('scene-change', 'the scene changed').replace('sense-wake', 'it heard something').replace('first-look', 'first look').replace('heartbeat', 'periodic re-check')}`);
                        if (p.gatedProbes) bits.push(`${p.gatedProbes} quiet checks before this`);
                        if (p.inferMs) bits.push(`took ${(Number(p.inferMs) / 1000).toFixed(1)}s`);
                      } else if (viewKind === 'summary') {
                        if (p.inputCount != null) bits.push(`fused ${p.inputCount} records into this`);
                      } else if (viewKind === 'stt') {
                        if (p.confTier && p.confTier !== 'good') bits.push(`engine unsure (${p.confTier})`);
                        if (p.inferMs) bits.push(`transcribed in ${(Number(p.inferMs) / 1000).toFixed(1)}s`);
                      }
                      return bits.length ? (
                        <div style={{ fontSize: 10.5, color: '#7a8ca8', marginTop: 2, lineHeight: 1.5 }}>{bits.join('  ·  ')}</div>
                      ) : null;
                    })()}
                    {/* summary pulse: collapsible EXACT lineage — the stitched input the
                        summarizer digested (how this coherence line was built). */}
                    {viewKind === 'summary' && p.inputs && (
                      <details style={{ marginTop: 4 }}>
                        <summary style={{ cursor: 'pointer', fontSize: 10, color: '#8fa8c8' }}>
                          ⛓ digested {p.inputCount ?? '?'} records — show exact input
                        </summary>
                        <pre style={{ fontSize: 10, whiteSpace: 'pre-wrap', color: '#9ab', margin: '4px 0 0', maxHeight: 220, overflow: 'auto', background: '#0d1420', padding: 6, borderRadius: 4 }}>{p.inputs}</pre>
                      </details>
                    )}
                    {/* vision: the structured what-changed field — a distinct Δ pill. */}
                    {viewKind === 'vision' && p.change && (
                      <span title="what changed vs the previous window"
                        style={{ marginLeft: 8, fontSize: 10, color: '#ffd9a0', border: '1px solid #5a4a20', borderRadius: 4, padding: '1px 6px', whiteSpace: 'nowrap' }}>
                        Δ {p.change}
                      </span>
                    )}
                    {/* vision LEAK-HUNT: the EXACT frame qwen saw + the prompt it got, so a
                        hallucinated description is diagnosable ("was it in the image?"). */}
                    {viewKind === 'vision' && (p.inputImage || p.inputPrompt) && (
                      <details style={{ marginTop: 4 }}>
                        <summary style={{ cursor: 'pointer', fontSize: 10, color: '#7a8ca8' }}>🖼 what qwen saw + prompt</summary>
                        <div style={{ display: 'flex', gap: 10, marginTop: 4, alignItems: 'flex-start', flexWrap: 'wrap' }}>
                          {p.inputImage && (
                            <img src={`data:image/jpeg;base64,${p.inputImage}`} alt="qwen input frame"
                              style={{ width: 240, maxWidth: '100%', borderRadius: 6, border: '1px solid #223' }} />
                          )}
                          {p.inputPrompt && (
                            <pre style={{ flex: 1, minWidth: 240, fontSize: 10, whiteSpace: 'pre-wrap', color: '#9ab',
                              margin: 0, maxHeight: 220, overflow: 'auto', background: '#0d1420', padding: 8, borderRadius: 4 }}>{p.inputPrompt}</pre>
                          )}
                        </div>
                      </details>
                    )}
                    {/* low-confidence is an STT (Whisper/parakeet) tell — only on the STT row. */}
                    {isStt && p.lowConfidence && (
                      <span title="the STT engine flagged this transcript as shaky (sent to the LLM tagged [low-confidence])"
                        style={{ marginLeft: 6, fontSize: 10, color: '#e0a060', border: '1px solid #5a3d20', borderRadius: 4, padding: '0 4px' }}>
                        low-conf
                      </span>
                    )}
                  </span>
                  {/* PERF + CONFIDENCE meta, right-aligned, tabular */}
                  <span style={{ fontVariantNumeric: 'tabular-nums', fontSize: 10, opacity: 0.5, textAlign: 'right', whiteSpace: 'nowrap', display: 'flex', gap: 8 }}>
                    {conf && <span title="match/expression confidence">◷ {conf}</span>}
                    {!isAudio && p.inferMs != null && <span title="inference latency (sidecar/in-process compute)">⚡{fmtMs(p.inferMs)}</span>}
                    {viewKind === 'vision' && p.frames != null && <span title="frames sampled this window">🎞{p.frames}</span>}
                    {viewKind === 'vision' && p.gateTrigger && <span title="why this analysis ran (the change gate's trigger)" style={{ fontSize: 10, color: '#8fa8c8' }}>⚑{p.gateTrigger}</span>}
                    {isStt && p.noSpeechProb != null && (
                      <span title="STT metrics — avg_logprob / no_speech_prob / compression_ratio">
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

/** NOW — compact live read: the latest result per active stream. STT and the audio
 *  read shown separately (audio shows the acoustic kind). Data-driven: any present kind
 *  (incl. future ones) gets a line; nothing present → a waiting hint. */
/** A glance at the dock's latest on-device face-track (the `perceive` stream, §7) — the
 *  fast MLKit signal faceFollow steers on: face count + the primary face's NDC pose, and
 *  the frame-level emotion/gesture/identity/zoom. Live state, not the snapshot log. */
function PerceiveGlance({ frame }: { frame: PerceiveFrame }) {
  const p = frame.payload!;
  const faces = p.faces ?? [];
  const primary = faces[0];
  const ageS = ((Date.now() - frame.ts) / 1000).toFixed(1);
  const line = (label: string, value: string) => (
    <div style={{ display: 'flex', gap: 8, fontSize: 13 }}>
      <span style={{ width: 64, opacity: 0.6 }}>{label}</span>
      <span style={{ flex: 1, color: '#cfe' }}>{value}</span>
    </div>
  );
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 3, padding: '8px 10px', marginTop: 8,
      background: '#0b0e16', border: '1px solid #1c2233', borderRadius: 10 }}>
      <div className="side-section-label" style={{ marginBottom: 2 }}>👤 Face-track (on-device · {ageS}s ago)</div>
      {line('faces', String(faces.length))}
      {primary && line('primary', `x ${primary.x.toFixed(2)} · y ${primary.y.toFixed(2)} · size ${primary.size.toFixed(2)}`
        + (primary.yaw != null ? ` · yaw ${primary.yaw.toFixed(0)}°` : ''))}
      {p.identity && line('identity', `${p.identity.name} (${p.identity.confidence.toFixed(2)})`)}
      {p.emotion && line('emotion', `${p.emotion.kind} (${p.emotion.confidence.toFixed(2)})`)}
      {p.gesture && line('gesture', `${p.gesture.name} (${p.gesture.score.toFixed(2)})`)}
      {p.zoom && line('zoom', `${p.zoom.ratio.toFixed(1)}× (${p.zoom.min.toFixed(1)}–${p.zoom.max.toFixed(1)})`)}
    </div>
  );
}

function LiveNow({ snaps, liveStt }: {
  snaps: Snapshot[];
  liveStt?: { text: string; isFinal: boolean } | null;
}) {
  // latest snapshot per view-kind (speech → both stt + its interpreted audio form).
  const latest = new Map<string, Snapshot>();
  for (const s of snaps) {
    if (s.source.kind === 'speech') {
      latest.set('stt', s);
      if (s.payload.bgModel) latest.set('audio', s);
    } else latest.set(s.source.kind, s);
  }
  const kinds = [...latest.keys()].sort((a, b) => {
    const ia = KIND_ORDER.indexOf(a), ib = KIND_ORDER.indexOf(b);
    if (ia !== -1 || ib !== -1) return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
    return a.localeCompare(b);
  });
  // The STT line prefers the LIVE push (instant) over the polled snapshot (≤1.5s old).
  const sttMeta = kindMeta('stt');
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, padding: '8px 10px',
      background: '#0b0e16', border: '1px solid #1c2233', borderRadius: 10 }}>
      <div className="side-section-label" style={{ marginBottom: 2 }}>● Now</div>
      {/* Real-time STT line — shown the instant the bus pushes it (even before the
          poll). A non-final (interim) transcript is dimmed + marked '…'. */}
      {liveStt && (
        <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', color: sttMeta.color, fontSize: 14, lineHeight: 1.35 }}>
          <span title="live STT" style={{ width: 20 }}>{sttMeta.icon}</span>
          <span style={{ flex: 1, opacity: liveStt.isFinal ? 1 : 0.7, fontStyle: liveStt.isFinal ? 'normal' : 'italic' }}>
            {liveStt.text}{!liveStt.isFinal && ' …'}
          </span>
          <span style={{ fontSize: 9, opacity: 0.5, color: '#7ee0a0' }}>live</span>
        </div>
      )}
      {kinds.length === 0 && !liveStt
        ? <div style={{ fontSize: 13, color: '#566' }}>waiting for the stream…</div>
        : kinds.map((k) => {
          // the live push already covers STT — skip the (staler) polled STT line.
          if (k === 'stt' && liveStt) return null;
          const s = latest.get(k)!;
          const m = kindMeta(k);
          const p = s.payload;
          const text = k === 'stt' ? (p.sttText ?? p.text) : p.text;
          return (
            <div key={k} style={{ display: 'flex', gap: 8, alignItems: 'baseline', color: m.color, fontSize: 14, lineHeight: 1.35 }}>
              <span title={m.label} style={{ width: 20 }}>{m.icon}</span>
              <span style={{ flex: 1 }}>
                {(k === 'audio' || k === 'sound') && p.audioKind && <b style={{ marginRight: 5, color: p.salience === 'startling' ? '#ff9e6b' : '#7ee0a0' }}>{p.audioKind}</b>}
                {text || <span style={{ opacity: 0.4 }}>…</span>}
              </span>
              <span style={{ fontSize: 10, opacity: 0.35, fontVariantNumeric: 'tabular-nums' }}>{s.interval.from.slice(11, 19)}</span>
            </div>
          );
        })}
    </div>
  );
}

/** KNOWN FACES — enroll the current source + manage the gallery. Photo-less samples
 *  (valid descriptors with no captured image — from "yes that's me" confirmations)
 *  are NOT shown as empty 👤 boxes; they're summarized as a "+N no photo" note. */
function KnownFaces({ gallery, open, onToggle, onForget, onRemoveSample, onClean, onRename, onReassign, enrollName, setEnrollName, onEnroll, enrollMsg, canEnroll }: {
  gallery: GalleryPerson[]; open: Set<string>; onToggle: (n: string) => void;
  onForget: (n: string) => void; onRemoveSample: (n: string, i: number) => void; onClean: () => void;
  onRename: (n: string) => void; onReassign: (n: string, i: number) => void;
  enrollName: string; setEnrollName: (s: string) => void; onEnroll: () => void; enrollMsg: string;
  canEnroll: boolean;
}) {
  // Lightbox: the base64 photo currently zoomed (null = closed). Esc closes it.
  const [zoom, setZoom] = useState<string | null>(null);
  useEffect(() => {
    if (!zoom) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setZoom(null); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [zoom]);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: '10px 12px',
      background: '#0a0d14', border: '1px solid #1c2233', borderRadius: 10 }}>
      {/* Enroll the face currently on the selected source. */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <div className="side-section-label">👤 Known faces ({gallery.length})</div>
        <input value={enrollName} onChange={(e) => setEnrollName(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') onEnroll(); }}
          placeholder={canEnroll ? 'name the face on screen…' : 'start/select a stream first'}
          disabled={!canEnroll}
          style={{ width: 200, background: '#0b0e16', color: '#cfe', border: '1px solid #1c2233', borderRadius: 6, padding: '4px 8px', fontSize: 12, opacity: canEnroll ? 1 : 0.5 }} />
        <button onClick={onEnroll} disabled={!canEnroll || !enrollName.trim()}
          style={{ padding: '4px 12px', borderRadius: 6, fontSize: 12, background: '#13243a', color: '#cfe', border: '1px solid #1c2233',
            cursor: canEnroll && enrollName.trim() ? 'pointer' : 'default', opacity: canEnroll && enrollName.trim() ? 1 : 0.5 }}>
          🪪 Enroll
        </button>
        {enrollMsg && <span style={{ fontSize: 12, color: enrollMsg.startsWith('✓') ? '#6f6' : '#f88' }}>{enrollMsg}</span>}
        {gallery.length > 0 && (
          <button onClick={onClean} title="Prune corrupt samples (bad descriptors) + empty people"
            style={{ marginLeft: 'auto', padding: '4px 10px', borderRadius: 6, fontSize: 11, background: 'transparent', color: '#9ab', border: '1px solid #1c2233', cursor: 'pointer' }}>
            🧹 clean
          </button>
        )}
      </div>

      {gallery.length === 0
        ? <div className="empty">No one enrolled yet. Name the face on screen above, or tell the dock "remember I'm &lt;name&gt;".</div>
        : (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12 }}>
          {gallery.map((p) => {
            const withPhoto = p.samples.filter((s) => s.photo);
            const noPhoto = p.samples.length - withPhoto.length;
            const cover = withPhoto[0];
            const isOpen = open.has(p.name);
            return (
              <div key={p.name} style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: 8, borderRadius: 12, background: '#0b0e16', alignItems: 'center' }}>
                {/* cover photo — click to ZOOM (lightbox). */}
                {cover?.photo
                  ? <img src={`data:image/jpeg;base64,${cover.photo}`} alt={p.name} onClick={() => setZoom(cover.photo!)}
                      title="Click to zoom"
                      style={{ width: 72, height: 72, borderRadius: 10, objectFit: 'cover', background: '#070a11', cursor: 'zoom-in' }} />
                  : <div style={{ width: 72, height: 72, borderRadius: 10, background: '#070a11', display: 'grid', placeItems: 'center', fontSize: 28 }}>👤</div>}
                <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                  <span className="mono" style={{ fontSize: 12 }}>{p.name}</span>
                  {/* ×N also expands/collapses the per-sample photos. */}
                  <button onClick={() => onToggle(p.name)} title={isOpen ? 'Collapse' : `Show all ${withPhoto.length} photo${withPhoto.length === 1 ? '' : 's'}`}
                    style={{ fontSize: 11, opacity: 0.6, background: 'transparent', border: 'none', color: 'inherit', cursor: 'pointer', padding: 0 }}>
                    ×{p.samples.length} {withPhoto.length > 1 ? (isOpen ? '▾' : '▸') : ''}
                  </button>
                  <button onClick={() => onRename(p.name)} title={`Rename ${p.name}`} style={{ padding: '0 4px' }}>✎</button>
                  <button onClick={() => onForget(p.name)} title={`Forget ${p.name} entirely`} style={{ padding: '0 4px' }}>✕</button>
                </div>

                {/* Expanded: each photo sample — click to ZOOM; ✎ reassign, ✕ delete. */}
                {isOpen && (
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, maxWidth: 168, justifyContent: 'center', borderTop: '1px solid #1c2233', paddingTop: 6 }}>
                    {withPhoto.map((s) => (
                      <div key={s.index} style={{ position: 'relative' }}>
                        <img src={`data:image/jpeg;base64,${s.photo}`} alt={`${p.name} #${s.index}`} onClick={() => setZoom(s.photo!)}
                          title="Click to zoom"
                          style={{ width: 48, height: 48, borderRadius: 8, objectFit: 'cover', background: '#070a11', cursor: 'zoom-in' }} />
                        <button onClick={() => onReassign(p.name, s.index)} title="This photo is actually someone else → move it"
                          style={{ position: 'absolute', top: -4, left: -4, width: 18, height: 18, lineHeight: '14px', padding: 0, borderRadius: 9, fontSize: 10 }}>✎</button>
                        <button onClick={() => onRemoveSample(p.name, s.index)} title="Delete this face"
                          style={{ position: 'absolute', top: -4, right: -4, width: 18, height: 18, lineHeight: '14px', padding: 0, borderRadius: 9, fontSize: 11 }}>✕</button>
                      </div>
                    ))}
                    {noPhoto > 0 && (
                      <span style={{ fontSize: 10, opacity: 0.5, alignSelf: 'center' }}
                        title="extra fingerprints captured without a photo (still used for matching)">+{noPhoto} no photo</span>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* LIGHTBOX — click any photo to zoom; click the backdrop (or Esc) to close. */}
      {zoom && (
        <div onClick={() => setZoom(null)}
          style={{ position: 'fixed', inset: 0, zIndex: 1000, background: 'rgba(0,0,0,0.85)',
            display: 'grid', placeItems: 'center', cursor: 'zoom-out' }}>
          <img src={`data:image/jpeg;base64,${zoom}`} alt="zoomed face"
            style={{ maxWidth: '90vw', maxHeight: '90vh', borderRadius: 12, boxShadow: '0 8px 40px #000' }} />
        </div>
      )}
    </div>
  );
}

/** A source-selector pill (the top dock chips). */
function SourceChip({ active, onClick, title, children }: {
  active: boolean; onClick: () => void; title?: string; children: React.ReactNode;
}) {
  return (
    <button onClick={onClick} title={title}
      style={{ padding: '5px 12px', borderRadius: 999, fontSize: 13, cursor: 'pointer',
        background: active ? '#2563eb' : '#10141f', color: active ? '#fff' : '#9ab',
        border: `1px solid ${active ? '#2563eb' : '#1c2233'}`, fontWeight: active ? 600 : 400 }}>
      {children}
    </button>
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

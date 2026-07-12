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
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
    inputImages?: string[]; inputPrompt?: string; reused?: boolean;
    // reused row: inputImages = [current probe frame, original analyzed frame]; reusedFromB64
    // names the original; reusedDist is the embedding match distance that triggered the reuse.
    reusedFromB64?: string; reusedDist?: number;
    // window-dedup: sampledFrames = frames grabbed; frames = distinct frames actually sent to
    // qwen after collapsing consecutive near-identical ones. singleFrame = collapsed to one.
    sampledFrames?: number; singleFrame?: boolean;
    // frame accounting: frameTimes[] = ms epoch of each SENT frame (parallels inputImages);
    // frameFrom/frameTo = the sampled window's true bounds. gap=true marks a COLLAPSED span row
    // (frames the VLM did NOT run): gapKind = 'no-change' (dinov2 gated) | 'self-motion'
    // (deferred while panning); gapProbes = how many probes the span covered.
    frameTimes?: number[]; frameFrom?: number; frameTo?: number;
    gap?: boolean; gapKind?: 'no-change' | 'self-motion'; gapProbes?: number;
    // the RAW STT transcript, preserved when the interpreter upgrades `text` — so the
    // 🎙 STT row shows what the live engine heard and the 🔊 audio row shows the
    // upgraded read. Absent on un-upgraded records (then the STT row uses `text`).
    sttText?: string;
    // ── AUDIO ENRICHER (merged path) ── the authoritative context-aware records. `enriched`
    // marks an enricher segment (clean transcript + diarization); `audioSource` says whether it
    // was real in-room speech, played media (a TV/video/song), or a non-speech sound. `liveOnly`
    // marks the parakeet record as superseded (kept for the live addressed-latch/console, but the
    // enricher's record is the durable truth). `armedBy` = what triggered the batch.
    enriched?: boolean; audioSource?: 'speech' | 'media' | 'sound'; liveOnly?: boolean; armedBy?: string;
    // the enricher's own confidence the transcript is what was really said (0..1). Low = the model
    // was guessing on unclear/far audio — shown but visually de-emphasised, not hidden.
    transcriptConf?: number;
    // DEBUG (enricher): voicedPct = how much of the batch window was actually voiced (low = the
    // window was mostly silence, so a full "conversation" here is a hallucination); sttWindow = the
    // raw parakeet STT that overlapped this window (compare enricher vs live STT; empty = no speech).
    voicedPct?: number; sttWindow?: string;
    // stamped by the brain when THIS addressed utterance actually WOKE the robot (a turn fired).
    wokeRobot?: boolean;
  };
}

/** Per-kind presentation. Add an entry to give a new pipeline a curated look;
 *  anything not listed still renders via KIND_FALLBACK (so the UI never breaks on
 *  an unknown stream). label = human name shown in the lane header. */
const KIND_META: Record<string, { icon: string; color: string; label: string }> = {
  vision:     { icon: '👁', color: '#dfe',    label: 'vision' },
  // 👂 enriched = the AUDIO ENRICHER's ONE lane — same record kind for speech / media / sound; the
  // content-type shows as an emoji badge on the row (🗣/📺/🎵/💥…). 🎙 STT = parakeet's live-only
  // reflex transcript (dimmed, superseded by the enricher). 🔊 sound = LEGACY standalone sound
  // records (pre-merge history) — new enricher sounds ride the enriched lane.
  enriched:    { icon: '👂', color: '#c9b6ff', label: 'enriched' },
  stt:         { icon: '🎙', color: '#9ecbff', label: 'STT (live)' },
  sound:       { icon: '🔊', color: '#b6d4ff', label: 'sound (legacy)' },
  identity:   { icon: '👤', color: '#ffd9a0', label: 'identity' },
  emotion:    { icon: '😮', color: '#ff9ed4', label: 'emotion' },
  bodymotion: { icon: '🤖', color: '#a0e0c0', label: 'bodymotion' },
};
const KIND_FALLBACK = { icon: '◇', color: '#bcd', label: '' };
function kindMeta(kind: string) {
  return KIND_META[kind] ?? { ...KIND_FALLBACK, label: kind };
}
/** Preferred lane/filter order; unknown (future) kinds sort after, alphabetically. */
const KIND_ORDER = ['vision', 'enriched', 'stt', 'sound', 'identity', 'emotion', 'bodymotion'];

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

/** One dock's on-disk perception history extent — from GET /api/perception/docks. Lets the console
 *  OFFER an offline dock as a source and bound its time-range picker (mirrors retention.ts DockHistory). */
interface DockHistory {
  dock: string;
  from: string | null; to: string | null; lastSeen: string | null;
  hasSummaries: boolean; days: number; bytes?: number; // bytes = on-disk size (vision frames dominate)
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
  // Docks with PERSISTED history on disk (§7c) — the offline sources the console can review even
  // when nothing is live-streaming. Merged with `producers` below to build the selector, so an
  // offline dock is still selectable. Polled slowly (history changes slowly). [] until loaded.
  const [histDocks, setHistDocks] = useState<DockHistory[]>([]);
  // When the selected source is OFFLINE (history mode), the pinned window we're reviewing. null =
  // the dock's full retained span (the default the /history route fills in). Set by the range picker.
  const [histWindow, setHistWindow] = useState<{ from: string; to: string } | null>(null);
  // "Load earlier" for a LIVE dock: when on, the persisted history is fetched and merged BEHIND the
  // live ring, so a live dock's timeline reaches back past the ~1000-record ring into its on-disk
  // past — without leaving live mode (the video tile / enroll / flush stay). Off by default (the
  // resting live view is just "now"). Holds the fetched older records; [] when off / none.
  const [showLiveHistory, setShowLiveHistory] = useState(false);
  const [liveHistSnaps, setLiveHistSnaps] = useState<Snapshot[]>([]);

  // The SOURCE SELECTOR = live producers ∪ docks-with-history, deduped by dock label. A dock that
  // is BOTH live and has history shows once, marked live. Live-first, then history by recency.
  // (Declared before the effects that read the derived mode below.)
  const liveLabels = useMemo(
    () => new Set(producers.filter((p) => p.label !== STREAM_ID).map((p) => p.label)), [producers]);
  const sourceList = useMemo(() => {
    const live = producers.filter((p) => p.label !== STREAM_ID)
      .map((p) => ({ label: p.label, live: true, tracks: p.tracks, hist: histDocks.find((h) => h.dock === p.label) }));
    const historyOnly = histDocks.filter((h) => !liveLabels.has(h.dock))
      .map((h) => ({ label: h.dock, live: false, tracks: { audio: false, video: false }, hist: h }));
    return [...live, ...historyOnly];
  }, [producers, histDocks, liveLabels]);
  // Is the currently-selected source LIVE (an active producer / the browser) or OFFLINE (history)?
  // Everything live-only (the video tile, enroll, flush-NOW, perceive) keys off this.
  const sourceIsLive = source === STREAM_ID || liveLabels.has(source);
  const historyMode = !!source && !sourceIsLive;
  const selectedHist = historyMode ? histDocks.find((h) => h.dock === source) : undefined;
  // Timeline filter: the set of view-kinds currently HIDDEN (a checkbox per type,
  // data-driven — any kind present can be toggled, incl. future ones). Empty = all on.
  // Initialized from the URL so filters survive refreshes.
  const [hiddenKinds, setHiddenKinds] = useState<Set<string>>(
    () => new Set((hashParam('hide') ?? '').split(',').filter(Boolean)));
  // Summarize controls are collapsed by default — a compact button that expands its
  // window/model/keyframes inline, so the controls area stays small.
  const [showSummarizer, setShowSummarizer] = useState(false);
  // Audio enricher config panel (model select) — collapsed; the bar button toggles it.
  const [showEnricher, setShowEnricher] = useState(false);
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
  // Timeline image lightbox: the base64 frame currently viewed at original size (null = closed).
  // Any timeline thumbnail (gap sample, reused frames, filmstrip) opens it; Esc / click closes.
  const [zoomImg, setZoomImg] = useState<string | null>(null);
  // Per-row toggle: reveal the STT utterance a speech-details (audio) row rode on, inline.
  // ▶ enricher row audio: which rowKey is currently playing + one shared <audio> element.
  const [playingAudio, setPlayingAudio] = useState<string | null>(null);
  const audioElRef = useRef<HTMLAudioElement | null>(null);
  useEffect(() => {
    if (!zoomImg) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setZoomImg(null); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [zoomImg]);
  const [autoScroll, setAutoScroll] = useState(true);
  const [limitToWindow, setLimitToWindow] = useState(false);
  // Collapse the top VIDEO + NOW block to reclaim vertical space for the snapshot timeline
  // (which then fills the remaining viewport). Persisted so the choice sticks across reloads.
  const [collapseTop, setCollapseTop] = useState<boolean>(() => localStorage.getItem('perc.collapseTop') === '1');
  useEffect(() => { localStorage.setItem('perc.collapseTop', collapseTop ? '1' : '0'); }, [collapseTop]);
  // Timeline order: newest-first (top) by default so the latest is visible without scrolling.
  // Toggle to chronological (oldest→newest). Persisted. Auto-scroll follows the "new" end.
  const [newestFirst, setNewestFirst] = useState<boolean>(() => localStorage.getItem('perc.newestFirst') !== '0');
  useEffect(() => { localStorage.setItem('perc.newestFirst', newestFirst ? '1' : '0'); }, [newestFirst]);
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
    if (!source || source === STREAM_ID || !sourceIsLive) return; // no live face-track for an offline dock
    let alive = true;
    const tick = () => api.get<PerceiveFrame>(`/perception/${encodeURIComponent(source)}/perceive`)
      .then((r) => { if (alive) setPerceive(r.payload ? r : null); }).catch(() => {});
    tick();
    const t = setInterval(tick, 1000);
    return () => { alive = false; clearInterval(t); };
  }, [source, sourceIsLive]);

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
    // OFFLINE: read the persisted timeline from disk once (history doesn't move) for the pinned
    // window (or the dock's full retained span if none picked). LIVE: poll the in-memory ring.
    if (historyMode) {
      const qs = new URLSearchParams({ dock: source });
      if (histWindow) { qs.set('from', histWindow.from); qs.set('to', histWindow.to); }
      api.get<{ records: Snapshot[] }>(`/perception/history?${qs.toString()}`)
        .then((r) => { if (alive) setSnaps(r.records ?? []); }).catch(() => { if (alive) setSnaps([]); });
      return () => { alive = false; };
    }
    const q = `limit=400&dock=${encodeURIComponent(source)}`;
    const load = () => api.get<Snapshot[]>(`/perception/snapshots?${q}`)
      .then((r) => { if (alive) setSnaps(r); }).catch(() => {});
    load();
    const t = setInterval(load, 1500);
    return () => { alive = false; clearInterval(t); };
  }, [activeTake, source, historyMode, histWindow]);

  // LIVE + "load earlier": fetch the dock's persisted history ONCE (it's the past — doesn't move)
  // when the toggle is on, to merge behind the ring below. Cleared when off / source changes / take.
  useEffect(() => {
    if (!showLiveHistory || historyMode || activeTake || !source || source === STREAM_ID) {
      setLiveHistSnaps([]); return;
    }
    let alive = true;
    api.get<{ records: Snapshot[] }>(`/perception/history?dock=${encodeURIComponent(source)}`)
      .then((r) => { if (alive) setLiveHistSnaps(r.records ?? []); }).catch(() => { if (alive) setLiveHistSnaps([]); });
    return () => { alive = false; };
  }, [showLiveHistory, historyMode, activeTake, source]);
  // Reset the live-history toggle when the source changes (a new dock, fetch afresh on demand).
  useEffect(() => { setShowLiveHistory(false); }, [source]);

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

  // Poll the docks with PERSISTED history (the OFFLINE sources). Slow — history changes slowly and
  // this only gates what's selectable, not the live feed. (perception-pipeline §7c)
  useEffect(() => {
    let alive = true;
    const load = () => api.get<DockHistory[]>('/perception/docks')
      .then((r) => { if (alive) setHistDocks(Array.isArray(r) ? r : []); }).catch(() => {});
    load();
    const t = setInterval(load, 15_000);
    return () => { alive = false; clearInterval(t); };
  }, []);

  // Default the source once sources are known (no ?src= in the URL): prefer the first live remote
  // dock, else this browser if it's streaming, else the most-recent dock with history. So the
  // console is useful even with nothing live right now. Single-stream view — no 'all'.
  useEffect(() => {
    if (source) return;
    const dock = producers.find((p) => p.label !== STREAM_ID);
    if (dock) setSource(dock.label);
    else if (producers.some((p) => p.label === STREAM_ID)) setSource(STREAM_ID);
    else if (histDocks.length) setSource(histDocks[0]!.dock); // most-recently-seen (server-sorted)
  }, [producers, histDocks, source]);

  // Reset the history window when the source changes (a new dock has a different span).
  useEffect(() => { setHistWindow(null); }, [source]);

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

  // The list no longer has its own scroll — the page (<main>) scrolls. Auto-scroll follows the
  // "new" end by scrolling main: newest-first → to the top of the list; chronological → bottom.
  const scroller = () => feedRef.current?.closest('main') ?? null;
  useEffect(() => {
    if (!autoScroll) return;
    const m = scroller(); const list = feedRef.current;
    if (!m || !list) return;
    m.scrollTop = newestFirst ? 0 : m.scrollHeight;
  }, [snaps, autoScroll, hiddenKinds, newestFirst, collapseTop]);

  useEffect(() => {
    const m = scroller();
    if (!m) return;
    const onScroll = () => {
      // "at the new end?" — near the top when newest-first, near the bottom when chronological.
      const atNewEnd = newestFirst ? m.scrollTop < 40 : m.scrollHeight - m.scrollTop - m.clientHeight < 40;
      setAutoScroll(atNewEnd);
    };
    m.addEventListener('scroll', onScroll, { passive: true });
    return () => m.removeEventListener('scroll', onScroll);
  }, [newestFirst]);

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
      } else if (historyMode) {
        // OFFLINE: nothing to flush (no live stream). Summarize the pinned history window (or the
        // dock's full retained span). The server's summarize route falls back to on-disk records
        // for an offline dock, so this re-narrates persisted history through the same summarizer.
        setSumPhase('thinking');
        const from = histWindow?.from ?? selectedHist?.from ?? istIso(sumWindow);
        const to = histWindow?.to ?? selectedHist?.to ?? istIso(0);
        setPinnedWindow({ from, to });
        r = await api.post<SummaryResult>('/perception/snapshots/summarize',
          { fromIso: from, toIso: to, withKeyframes: sumKeyframes, maxKeyframes: 6, model: sumModel, dock: source });
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
  }, [sumWindow, sumKeyframes, sumModel, activeTake, snaps, source, historyMode, histWindow, selectedHist]);

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

  // Ordered by start; latest of each modality for the live captions. In LIVE + "load earlier" mode,
  // merge the on-disk history BEHIND the ring (older records the ring no longer holds). DEDUP the
  // whole set by content key (from|to|source.id|kind), which removes BOTH the live↔history overlap
  // (a record persisted to disk AND still in the ring) AND within-history duplicates (a crash-replay
  // can append the same span-summary twice). The live copy is seen first so it wins. Without this,
  // the boundary rows render twice and the day-divider lands on the wrong instance.
  const recKey = (r: Snapshot) => `${r.interval.from}|${r.interval.to}|${r.source.id}|${r.source.kind}`;
  const seenKeys = new Set<string>();
  const merged = (liveHistSnaps.length ? [...snaps, ...liveHistSnaps] : snaps)
    .filter((r) => { const k = recKey(r); if (seenKeys.has(k)) return false; seenKeys.add(k); return true; });
  // Per-row ORIGIN: in "load earlier" mode a live dock's timeline mixes ring rows (live) with
  // rows fetched from disk (liveHistSnaps) merged behind them. Keys that came ONLY from the disk
  // fetch mark the from-disk rows, so each row can show a small live-vs-history indicator bar.
  // (A whole offline dock is uniformly history; a live dock without "load earlier" is uniformly live.)
  const liveHistKeys = new Set(liveHistSnaps.map(recKey));
  const rowIsHistory = (r: Snapshot) => historyMode || liveHistKeys.has(recKey(r));
  const ordered = [...merged].sort((a, b) =>
    a.interval.from < b.interval.from ? -1 : a.interval.from > b.interval.from ? 1 : 0);

  // Expand snapshots into TIMELINE ROWS. STT and the background AUDIO read are
  // separate row types even though they ride one 'speech' snapshot: an upgraded
  // utterance yields BOTH a 🎙 STT row (the live engine's transcript) AND a 🔊 audio
  // row (the interpreter's kind/salience/summary + cleaner transcript). Every other
  // kind (incl. standalone 'sound' events) is one row, keyed by its own kind.
  const rows: { snap: Snapshot; viewKind: string }[] = ordered.flatMap((s) => {
    // ONE 👂 enriched lane for EVERYTHING the audio enricher emits — speech, played media, or a
    // non-speech sound. It's one record kind ('enriched'); WHAT it contains is the `audioSource`
    // field, shown as an emoji badge on the row (not a separate lane).
    if (s.source.kind === 'enriched') return [{ snap: s, viewKind: 'enriched' }];
    // parakeet's live-only record → the 🎙 STT lane (dimmed, superseded by the enricher).
    if (s.source.kind === 'speech') return [{ snap: s, viewKind: 'stt' }];
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
  const filteredRaw = rows
    .filter((r) => !hiddenKinds.has(r.viewKind))
    .filter((r) => !limitToWindow || (r.snap.interval.to >= from && r.snap.interval.from <= to));
  // COLLAPSE consecutive frame-accounting GAP rows of the same kind into ONE line. The server
  // flushes a static stretch every ~30s (GAP_MAX_MS), so a long quiet period lands as several
  // adjacent no-change records — but the reader wants a single "nothing from A to B" line, not
  // a stack. Merge runs of the same gapKind (broken by any inference/self-motion/other row):
  // widen the interval to [firstFrom, lastTo] and sum the probe counts.
  const filtered: typeof filteredRaw = [];
  for (const r of filteredRaw) {
    const p = r.snap.payload as { gap?: boolean; gapKind?: string; gapProbes?: number };
    const prev = filtered[filtered.length - 1];
    const pp = prev?.snap.payload as { gap?: boolean; gapKind?: string; gapProbes?: number } | undefined;
    if (p.gap && pp?.gap && pp.gapKind === p.gapKind) {
      // extend the previous merged gap row in place (clone so we don't mutate the store)
      const merged = { ...prev!, snap: { ...prev!.snap,
        interval: { ...prev!.snap.interval, to: r.snap.interval.to,
          durationMs: new Date(r.snap.interval.to).getTime() - new Date(prev!.snap.interval.from).getTime() },
        payload: { ...prev!.snap.payload, gapProbes: (pp.gapProbes ?? 0) + (p.gapProbes ?? 0) } } };
      filtered[filtered.length - 1] = merged;
    } else {
      filtered.push(r);
    }
  }
  // Reverse AFTER collapsing (collapse needs chronological adjacency) so newest is on top.
  if (newestFirst) filtered.reverse();
  const latestVision = [...ordered].reverse().find((s) => s.source.kind === 'vision');
  const istTime = (iso: string) => iso.slice(11, 19);
  // The DAY of a row (YYYY-MM-DD). Rows show TIME only (compact); a date DIVIDER is inserted
  // wherever the day changes down the list — so a timeline that spans days (e.g. live "now" merged
  // with loaded history from days ago) is never ambiguous, without dating every single row.
  const istDay = (iso: string) => iso.slice(0, 10);
  const dayLabel = (iso: string) => new Date(`${iso.slice(0, 10)}T00:00:00+05:30`)
    .toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
  // For each displayed row index, the day-divider label to render BEFORE it (null = same day as prev).
  // The first row always gets its date, so the reader is never guessing the top of the list.
  const dividerBefore: (string | null)[] = filtered.map(({ snap }, i) =>
    (i === 0 || istDay(snap.interval.from) !== istDay(filtered[i - 1]!.snap.interval.from))
      ? dayLabel(snap.interval.from) : null);
  const secs = (ms: number) => `${(ms / 1000).toFixed(1)}s`;
  // epoch ms → IST clock. `full` keeps milliseconds (HH:MM:SS.mmm) for the summary line;
  // default is HH:MM:SS for the small per-frame chips. IST because the whole console is IST
  // (matches the row timestamps, which are the server's isoIst()).
  const istClockMs = (ms: number, full = false) =>
    new Date(ms + 5.5 * 3600_000).toISOString().slice(11, full ? 23 : 19);
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
        {/* SOURCE chips — one stream at a time. LIVE producers + docks with persisted HISTORY
            (offline, reviewable). A live dock is marked ●; a history-only dock 🕓 with its span.
            (Watch several → open more tabs with ?src=… ; there is no merged 'all' view.) */}
        {sourceList.map((s) => (
          <SourceChip key={s.label} active={source === s.label} onClick={() => setSource(s.label)}
            title={s.live
              ? `live — ${s.tracks.audio ? '🎙 audio ' : ''}${s.tracks.video ? '📹 video' : ''}`
              : `offline — persisted history${s.hist?.lastSeen ? `, last seen ${s.hist.lastSeen.slice(0, 16).replace('T', ' ')}` : ''}`}>
            {s.live ? '📱' : '🕓'} {s.label}
            {s.live
              ? <>{s.tracks.video ? ' 📹' : ''}{s.tracks.audio ? ' 🎙' : ''} ●</>
              : <span style={{ opacity: 0.6 }}> history</span>}
          </SourceChip>
        ))}
        <SourceChip active={source === STREAM_ID} onClick={() => setSource(STREAM_ID)}
          title={publishing ? 'this laptop is streaming' : 'start the stream below to feed it'}>
          🖥 this browser{publishing ? ' ●' : ''}
        </SourceChip>
        {historyMode &&
          <span style={{ fontSize: 11, color: '#ffc454' }}
            title="This dock isn't streaming now — showing its persisted perception history">🕓 offline · history</span>}

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
          {/* AUDIO ENRICHER — always on (the sole authoritative audio path). Click to open its
              config panel (model select) below the bar, like the other config buttons. */}
          <button onClick={() => setShowEnricher((v) => !v)}
            title={`audio enricher · model ${bgAudio.model} — click for config`}
            style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '4px 10px', borderRadius: 8, fontSize: 11, cursor: 'pointer',
              background: showEnricher ? '#1e3a5f' : '#13301f', color: '#7ee0a0', border: '1px solid #2c6f4a' }}>
            <span style={{ width: 7, height: 7, borderRadius: '50%', background: '#3ad29f' }} />
            👂 enricher {bgAudioBusy ? '…' : bgAudio.model.includes('lite') ? '(lite)' : '(flash)'} {showEnricher ? '▾' : '▸'}
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
        </div>
      </div>

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

      {/* AUDIO ENRICHER config — model select (applied live via POST /perception/enricher). */}
      {showEnricher && (
      <div style={{ border: '1px solid #2c6f4a', borderRadius: 10, padding: '10px 12px', background: '#0a120d' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 12, color: '#7ee0a0', fontWeight: 600 }}>👂 audio enricher</span>
          <span style={{ fontSize: 11, color: '#7a8ca8' }}>
            always on — the sole authoritative audio path (context-aware transcript · diarization · acoustic read).
            Parakeet stays live-only.
          </span>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ fontSize: 11, color: '#9ab' }}>model:</span>
            <select value={bgAudio.model} disabled={bgAudioBusy}
              onChange={(e) => void setBgAudioState({ model: e.target.value })}
              style={{ background: '#0b1a12', color: '#cfe', border: '1px solid #2c6f4a', borderRadius: 6, fontSize: 11, padding: '3px 6px' }}>
              <option value="gemini-2.5-flash">gemini-2.5-flash (better transcription)</option>
              <option value="gemini-2.5-flash-lite">gemini-2.5-flash-lite (cheaper, weaker)</option>
            </select>
            {bgAudioBusy && <span style={{ fontSize: 11, color: '#7a8ca8' }}>saving…</span>}
          </div>
        </div>
        <div style={{ fontSize: 10.5, color: '#6a7a8a', marginTop: 6 }}>
          flash-lite is cheaper but hallucinates more (repetition loops, weaker timestamps). flash gives cleaner,
          more coherent transcripts. Changes apply to the NEXT batch (no restart).
        </div>
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
            {/* TODO: facts-extracted readout — fact-extraction now runs inside the summarizer
                at trim time; when the summarize response carries the extracted facts, show them here. */}
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
          canEnroll={!!snaps.length && sourceIsLive} />
      )}

      {/* VIDEO + ● NOW side by side — the live tile (selected dock, or this browser's
          own publish preview) on the left; the live per-stream read on the right.
          Collapsible via the ⛶ toggle in the Snapshots header (zero extra vertical space). */}
      {!collapseTop && (
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
        ) : historyMode ? (
          // OFFLINE dock: no live video. Show a history card — the dock's retained span + a
          // time-range picker that pins the window the timeline + Summarize read from disk.
          <div style={{ width: 420, maxWidth: '100%', background: '#0b0e16', border: '1px solid #1c2233',
            borderRadius: 10, padding: 14, display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div style={{ fontSize: 13, color: '#ffc454' }}>🕓 {source} — offline (persisted history)</div>
            <div style={{ fontSize: 11, color: '#7a8699', lineHeight: 1.5 }}>
              {selectedHist?.lastSeen
                ? <>last seen <b style={{ color: '#aeb9cc' }}>{selectedHist.lastSeen.slice(0, 16).replace('T', ' ')}</b> · {selectedHist.days} day{selectedHist.days === 1 ? '' : 's'} of records{selectedHist.hasSummaries ? ' · + hourly digests' : ''}{selectedHist.bytes != null ? <> · <span title="On-disk size of this dock's raw records + hourly digests. Vision records carry the frames qwen saw (inputImages/reusedFromB64) — ~99% of the bytes are those JPEGs. Raw is trimmed after PERCEPTION_RETAIN_MS (6h default), so this reflects the live tail, not unbounded growth.">{selectedHist.bytes >= 1e9 ? `${(selectedHist.bytes / 1e9).toFixed(1)} GB` : selectedHist.bytes >= 1e6 ? `${Math.round(selectedHist.bytes / 1e6)} MB` : `${Math.max(1, Math.round(selectedHist.bytes / 1e3))} KB`} on disk</span></> : null}</>
                : 'compressed hourly digests only (raw records aged out)'}
              <br />No live video — reviewing what this dock perceived. Older spans show as 🔊 hourly summaries.
            </div>
            <HistoryRange hist={selectedHist} value={histWindow} onChange={setHistWindow} />
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
      )}
      {/* OUTPUT: the single snapshot timeline (vision + speech, by start, IST). */}
      <div>
        {/* The header + filter bar STICKS to the top of the page scroll (main is the scroller)
            so the controls stay visible while the list scrolls — one scrollbar, not two.
            Negative margins + padding bleed the sticky bar over main's 22/26px padding so it
            covers the full width and there's no see-through gap above it. */}
        <div style={{ position: 'sticky', top: -22, zIndex: 5, background: 'var(--bg, #0a0e1c)',
          margin: '0 -26px', padding: '10px 26px 8px',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <div className="side-section-label">
              {/* Collapse the top stream+NOW block from HERE — inline, so the control adds no
                  vertical space of its own (the earlier standalone button defeated its purpose). */}
              <button onClick={() => setCollapseTop((v) => !v)}
                title={collapseTop ? 'Show stream + live read' : 'Hide stream + live read (more room for the timeline)'}
                style={{ background: 'none', border: 'none', color: 'inherit', font: 'inherit', cursor: 'pointer', padding: 0, marginRight: 6 }}>
                {collapseTop ? '⤢' : '⤡'}
              </button>
              Snapshots ({filtered.length}) ·{' '}
              <button onClick={() => setNewestFirst((v) => !v)} title="toggle timeline order"
                style={{ background: 'none', border: 'none', color: 'inherit', font: 'inherit', cursor: 'pointer', textDecoration: 'underline dotted', padding: 0 }}>
                {newestFirst ? 'newest first ▲' : 'oldest first ▼'}
              </button> · IST
              {source && <span style={{ opacity: 0.6 }}> · {source === STREAM_ID ? '🖥 this browser' : `📱 ${source}`}</span>}
            </div>
            {/* LOAD EARLIER — a LIVE dock's timeline is just the ring (now). Toggle to merge its
                on-disk persisted history behind the ring, so it reaches back into its past too.
                Only for a live remote dock (offline already shows history; the browser has none). */}
            {sourceIsLive && source !== STREAM_ID && (
              <button onClick={() => setShowLiveHistory((v) => !v)}
                title={showLiveHistory ? 'Hide persisted history — show just the live ring (now)' : 'Load this dock’s persisted history and merge it behind the live feed'}
                style={{ padding: '3px 9px', borderRadius: 6, fontSize: 11, cursor: 'pointer',
                  background: showLiveHistory ? '#2563eb' : '#10141f', color: showLiveHistory ? '#fff' : '#9ab',
                  border: `1px solid ${showLiveHistory ? '#2563eb' : '#1c2233'}` }}>
                🕓 {showLiveHistory ? `history on${liveHistSnaps.length ? ` (+${liveHistSnaps.length})` : ''}` : 'load earlier'}
              </button>
            )}
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
        {/* NO inner scroll — the list grows naturally and the PAGE (main) scrolls it, so there's
            a single scrollbar. The sticky header above keeps the controls in view. */}
        <div ref={feedRef}
          style={{ display: 'flex', flexDirection: 'column', gap: 4,
            background: '#0b0e16', borderRadius: 10, padding: 10, fontSize: 13, lineHeight: 1.5 }}>
          {filtered.length === 0
            ? <div className="empty">No snapshots yet. Start the stream — vision runs latency-bound, speech per utterance.</div>
            : filtered.map(({ snap: s, viewKind }, rowIdx) => {
              const p = s.payload;
              // The day-divider to render before this row (a new calendar day, or the list top).
              const divider = dividerBefore[rowIdx];
              const withDivider = (el: React.ReactNode) => divider
                ? <React.Fragment key={`day-${s.interval.from}-${viewKind}`}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10, margin: '8px 2px 2px',
                      color: '#5f6f8a', fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.5 }}>
                      <span style={{ height: 1, flex: '0 0 14px', background: '#233048' }} />
                      <span style={{ whiteSpace: 'nowrap' }}>{divider}</span>
                      <span style={{ height: 1, flex: 1, background: '#233048' }} />
                    </div>
                    {el}
                  </React.Fragment>
                : el;
              // STABLE key from the snapshot's own identity (start + stream + kind), NOT the
              // array index. With newest-first, a new row is inserted at index 0, which shifts
              // every index → index keys made React re-render the whole list ("refills
              // everything"). A stable key means only the new row mounts; the rest stay put.
              const rowKey = `${s.interval.from}|${s.interval.to}|${s.source.id}|${viewKind}|${(p as { gap?: boolean }).gap ? 'gap' : ''}`;
              // ORIGIN INDICATOR: a thin left bar marks each row's source — amber = replayed from
              // DISK history, teal = LIVE (from the ring). Only meaningful when the two are mixed
              // (a live dock with "load earlier" on, or a wholly-offline dock); a plain live view is
              // all-teal and reads as no bar to speak of. Applied as a left border on the row.
              const isHistoryRow = rowIsHistory(s);
              const originBar = {
                borderLeft: `2px solid ${isHistoryRow ? '#c08a2e' : '#2f7d63'}`,
                paddingLeft: 8, marginLeft: 2,
              } as const;
              const originTitle = isHistoryRow ? 'from disk (persisted history)' : 'live (from the ring)';
              const m = kindMeta(viewKind);
              const isStt = viewKind === 'stt' || viewKind === 'enriched';
              // ENRICHER awareness: 'enriched' lane = the authoritative context-aware record
              // (clean transcript + speaker + source). A 'stt' lane speech row is parakeet's
              // live-only reflex transcript → dim it so the enriched row reads as the truth.
              const isEnriched = viewKind === 'enriched';
              const isLiveOnly = viewKind === 'stt' && p.liveOnly === true;
              const isMedia = p.audioSource === 'media';
              const modelName = s.model.name;
              const conf = p.confidence != null ? `${Math.round(p.confidence * 100)}%` : null;
              const sttText = p.sttText ?? p.text;
              // FRAME-ACCOUNTING GAP ROW: a collapsed span of frames the VLM did NOT run
              // (dinov2 no-change gating, or self-motion deferral). Rendered compact + dimmed
              // as a "nothing was sent here, and here's why" strip — one thumbnail + the time
              // range + probe count — so the timeline accounts for EVERY frame, no silent drops.
              if (viewKind === 'vision' && p.gap) {
                const label = p.gapKind === 'self-motion' ? 'self-motion (panning)' : 'no change (gated)';
                const thumb = p.inputImages?.[0];
                return withDivider(
                  <div key={rowKey} title={originTitle} style={{ display: 'flex', gap: 8, alignItems: 'center', opacity: 0.5,
                    color: '#7a8ca8', fontStyle: 'italic', ...originBar }}>
                    <span style={{ fontVariantNumeric: 'tabular-nums', width: 138, fontSize: 12 }}>
                      {istTime(s.interval.from)}–{istTime(s.interval.to)}<span style={{ opacity: 0.6 }}> ({secs(s.interval.durationMs)})</span>
                    </span>
                    <span style={{ width: 18 }} title="frames not sent to the VLM (accounted-for gap)">⋯</span>
                    {thumb && <img src={`data:image/jpeg;base64,${thumb}`} alt="gap sample" title="click to view original size"
                      onClick={() => setZoomImg(thumb)}
                      style={{ width: 40, height: 30, objectFit: 'cover', borderRadius: 3, border: '1px dashed #2a3550', opacity: 0.8, cursor: 'zoom-in' }} />}
                    <span style={{ flex: 1, fontSize: 12 }}>
                      {label}{p.gapProbes ? ` — ${p.gapProbes} probes, no inference` : ''}
                    </span>
                  </div>,
                );
              }
              return withDivider(
                <div key={rowKey} title={isLiveOnly ? 'live-only (parakeet) — superseded by the audio enricher\'s record' : originTitle}
                  style={{ display: 'flex', gap: 8, color: m.color, alignItems: 'baseline',
                  ...originBar,
                  // liveOnly parakeet rows are superseded by the enricher → dim + strike.
                  ...(isLiveOnly ? { opacity: 0.4 } : {}) }}>
                  <span style={{ opacity: 0.45, fontVariantNumeric: 'tabular-nums', width: 138, fontSize: 12 }}>
                    {istTime(s.interval.from)}–{istTime(s.interval.to)}<span style={{ opacity: 0.6 }}> ({secs(s.interval.durationMs)})</span>
                  </span>
                  <span style={{ width: 18 }} title={m.label}>{m.icon}</span>
                  {/* WHAT MODEL produced this row. On a REUSED vision row the model was NOT
                      called — so we strike + dim its name and tag "· cached" to make it read at
                      a glance as "no VLM ran here" versus a fresh qwen inference. */}
                  <span title={p.reused ? `${modelName} was NOT called — description reused from a recently-analyzed near-identical view` : (s.model.endpoint ?? '')}
                    style={{ width: 116, fontSize: 11, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                      ...(p.reused
                        ? { opacity: 0.7, color: '#7ee0a0' }
                        : { opacity: 0.5 }) }}>
                    <span style={p.reused ? { textDecoration: 'line-through', opacity: 0.55, fontStyle: 'italic' } : undefined}>{MODEL_SHORT(modelName)}</span>
                    {p.reused && <span style={{ opacity: 0.9 }}> · cached</span>}
                  </span>
                  <span style={{ flex: 1 }}>
                    {/* CONTENT-TYPE emoji — what this ONE 'enriched' record contains: real in-room
                        speech, played media (TV/song), or a non-speech sound (crash/laughter/…).
                        It's a field on the record, shown here (not a separate lane). */}
                    {isEnriched && (() => {
                      const src = p.audioSource ?? 'speech';
                      const k = (p.audioKind ?? '').toLowerCase();
                      const emoji = src === 'media' ? '📺' : src === 'sound'
                        ? (k.includes('music') ? '🎵' : k.includes('impact') || k.includes('crash') ? '💥'
                          : k.includes('laugh') ? '😆' : k.includes('alarm') || k.includes('bell') ? '🔔' : '🔊')
                        : '🗣';
                      const label = src === 'speech' ? 'in-room speech' : src === 'media' ? `played media${k ? ` (${k})` : ''}` : `sound${k ? ` (${k})` : ''}`;
                      return <span title={label} style={{ marginRight: 5, fontSize: 12 }}>{emoji}</span>;
                    })()}
                    {/* ENRICHER row: speaker badge (diarized). */}
                    {isEnriched && p.speaker != null && (
                      <span title="diarized speaker (audio enricher)"
                        style={{ marginRight: 5, fontSize: 10, fontWeight: 700, color: '#c9b6ff', border: '1px solid #4a3f6a', borderRadius: 4, padding: '0 5px' }}>
                        S{p.speaker}
                      </span>
                    )}
                    {/* TRANSCRIPT CONFIDENCE — the enricher's own certainty the words are real.
                        Illustrated as a color pill + a tiny bar; low-conf text is dimmed (kept, not
                        hidden — so you SEE the model was guessing on unclear/far audio). */}
                    {isEnriched && p.transcriptConf != null && (() => {
                      const c = p.transcriptConf;
                      const col = c >= 0.75 ? '#7ee0a0' : c >= 0.45 ? '#ffd9a0' : '#ff8a8a';
                      const bd = c >= 0.75 ? '#2c6f4a' : c >= 0.45 ? '#5a4a20' : '#7a2c2c';
                      return (
                        <span title={`transcript confidence ${Math.round(c * 100)}% — the enricher's own certainty the words are what was actually said`}
                          style={{ marginRight: 6, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                          <span style={{ fontSize: 9.5, fontWeight: 700, color: col, border: `1px solid ${bd}`, borderRadius: 4, padding: '0 4px' }}>
                            {Math.round(c * 100)}%
                          </span>
                          <span style={{ display: 'inline-block', width: 26, height: 4, borderRadius: 2, background: '#1c2233', overflow: 'hidden' }}>
                            <span style={{ display: 'block', width: `${Math.round(c * 100)}%`, height: '100%', background: col }} />
                          </span>
                        </span>
                      );
                    })()}
                    {isEnriched && isMedia && (
                      <span title="played media (a TV/video/song), NOT a person in the room"
                        style={{ marginRight: 5, fontSize: 10, fontWeight: 700, color: '#8fb0d8', border: '1px solid #34506a', borderRadius: 4, padding: '0 5px' }}>
                        📺 media
                      </span>
                    )}
                    {isLiveOnly && (
                      <span title="live-only parakeet — superseded by the enricher's record"
                        style={{ marginRight: 5, fontSize: 9.5, opacity: 0.7, border: '1px solid #444', borderRadius: 4, padding: '0 4px' }}>
                        live-only
                      </span>
                    )}
                    {/* salience on an ENRICHED speech row too (not just audio/sound). */}
                    {isEnriched && (p.salience === 'notable' || p.salience === 'startling') && (
                      <span title="salience — would a head turn?"
                        style={{ marginRight: 5, fontSize: 10, fontWeight: 700, color: p.salience === 'startling' ? '#ff9e6b' : '#ffd9a0',
                          border: `1px solid ${p.salience === 'startling' ? '#7a3d20' : '#5a4a20'}`, borderRadius: 4, padding: '0 5px' }}>
                        {p.salience}{p.salience === 'startling' ? ' ⚡' : ''}
                      </span>
                    )}
                    {/* ADDRESSED TO ROBOT — the most salient thing: someone spoke TO orbit. Shows the
                        directive if the enricher captured what they want. (Observation only — the
                        brain's addressed latch is the authority on whether it becomes a turn.) */}
                    {isEnriched && p.addressedToRobot && (
                      <span title={`the enricher heard this addressed to orbit${p.addressConf != null ? ` (${Math.round(p.addressConf * 100)}% sure)` : ''} — an observation; the brain decides if it acts`}
                        style={{ marginRight: 5, fontSize: 10, fontWeight: 700, color: '#7ec8ff', border: '1px solid #2c4a6f', borderRadius: 4, padding: '0 5px' }}>
                        → orbit{p.directive ? `: ${p.directive}` : ''}
                      </span>
                    )}
                    {/* WOKE THE ROBOT — the brain stamped this record when it actually fired a turn
                        from this utterance (downstream of the record write). The 🤖 = "this is the
                        one that woke it", distinct from the enricher's softer → orbit observation. */}
                    {isEnriched && p.wokeRobot && (
                      <span title="this utterance WOKE the robot — a turn fired from it"
                        style={{ marginRight: 5, fontSize: 10, fontWeight: 700, color: '#7ee0a0', border: '1px solid #2c6f4a', borderRadius: 4, padding: '0 5px' }}>
                        🤖 woke
                      </span>
                    )}
                    {/* LEGACY SOUND row (pre-merge standalone 'sound' records): kind + salience +
                        addressed chips. New audio rides the 'enriched' lane (badges above). */}
                    {viewKind === 'sound' && p.audioKind && (
                      <span title="acoustic kind"
                        style={{ marginRight: 5, fontSize: 10, fontWeight: 700, color: '#7ee0a0', border: '1px solid #2c6f4a', borderRadius: 4, padding: '0 5px' }}>
                        {p.audioKind}
                      </span>
                    )}
                    {viewKind === 'sound' && (p.salience === 'notable' || p.salience === 'startling') && (
                      <span title="salience — would a head turn?"
                        style={{ marginRight: 5, fontSize: 10, fontWeight: 700, color: p.salience === 'startling' ? '#ff9e6b' : '#ffd9a0',
                          border: `1px solid ${p.salience === 'startling' ? '#7a3d20' : '#5a4a20'}`, borderRadius: 4, padding: '0 5px' }}>
                        {p.salience}{p.salience === 'startling' ? ' ⚡' : ''}
                      </span>
                    )}
                    {viewKind === 'sound' && p.addressedToRobot && (
                      <span title="the clip audibly addresses the robot (observation — the brain still decides)"
                        style={{ marginRight: 5, fontSize: 10, fontWeight: 700, color: '#7ec8ff', border: '1px solid #2c4a6f', borderRadius: 4, padding: '0 5px' }}>
                        → orbit{p.directive ? `: ${p.directive}` : ''}
                      </span>
                    )}
                    {/* The transcript. Low-confidence enriched text is dimmed + italic so you SEE the
                        model was unsure (kept in the stream, not hidden — the ego weights it down). */}
                    {isEnriched && p.transcriptConf != null && p.transcriptConf < 0.45
                      ? <span style={{ opacity: 0.5, fontStyle: 'italic' }} title="low-confidence — the enricher was unsure of these words">{sttText}</span>
                      : sttText}
                    {/* LEGACY SOUND: the acoustic fields as a clean KEY–VALUE list. */}
                    {viewKind === 'sound' && (() => {
                      const pct = (v: unknown) => (typeof v === 'number' ? `${Math.round(v * 100)}%` : '');
                      const kv: { k: string; v: React.ReactNode }[] = [];
                      if (p.audioKind) kv.push({ k: 'heard', v: <>{p.audioKind}{p.audioKindConf != null ? <span style={{ opacity: 0.6 }}> · {pct(p.audioKindConf)} sure</span> : null}</> });
                      if (p.salience) kv.push({ k: 'salience', v: <><span style={{ color: p.salience === 'startling' ? '#ff9e6b' : p.salience === 'notable' ? '#ffd9a0' : undefined }}>{p.salience}</span>{p.salienceConf != null ? <span style={{ opacity: 0.6 }}> · {pct(p.salienceConf)}</span> : null}</> });
                      if (p.addressedToRobot) kv.push({ k: 'addressed', v: <><b style={{ color: '#7fd0ff' }}>spoke to orbit</b>{p.directive ? ` — ${p.directive}` : ''}{p.addressConf != null ? <span style={{ opacity: 0.6 }}> · {pct(p.addressConf)}</span> : null}</> });
                      if (p.summary && p.summary !== p.text) kv.push({ k: 'in short', v: p.summary });
                      if (p.trigger) kv.push({ k: 'woken by', v: p.trigger });
                      if (p.bgTranscript && p.bgTranscript !== p.text) kv.push({ k: 'alt hearing', v: <span style={{ fontStyle: 'italic' }}>“{p.bgTranscript}”</span> });
                      if (!kv.length) return null;
                      return (
                        <div style={{ display: 'grid', gridTemplateColumns: 'max-content 1fr', columnGap: 8, rowGap: 1,
                          fontSize: 10.5, color: '#8ba0bd', marginTop: 3, lineHeight: 1.5 }}>
                          {kv.map(({ k, v }, i) => (
                            <React.Fragment key={i}>
                              <span style={{ color: '#5f728c', textAlign: 'right', opacity: 0.85, fontFamily: 'var(--mono)' }}>{k}</span>
                              <span>{v}</span>
                            </React.Fragment>
                          ))}
                        </div>
                      );
                    })()}
                    {/* ENRICHER DEBUG: trigger reason + how much of the window was voiced + the raw
                        parakeet STT for the same audio (empty STT + low voiced = a hallucination). */}
                    {isEnriched && (
                      <div style={{ marginTop: 3, fontSize: 10.5, color: '#7a8ca8', display: 'flex', flexWrap: 'wrap', gap: '2px 10px', alignItems: 'baseline' }}>
                        {/* ▶ PLAY the exact audio this row was made from (if saved). Lets you verify
                            the enricher's text against the real sound, right in the row. */}
                        {(() => {
                          const ms = Date.parse(s.interval.from);
                          const src = source && source !== STREAM_ID ? `/api/perception/enrich-audio/${encodeURIComponent(source)}/${ms}` : '';
                          if (!src) return null;
                          const playing = playingAudio === rowKey;
                          return <span
                            onClick={() => {
                              if (playing) { audioElRef.current?.pause(); setPlayingAudio(null); return; }
                              if (audioElRef.current) { audioElRef.current.src = src; audioElRef.current.play().then(() => setPlayingAudio(rowKey)).catch(() => setPlayingAudio(null)); }
                            }}
                            title="play the exact audio window this row was made from"
                            style={{ cursor: 'pointer', color: playing ? '#7ee0a0' : '#7fa8d8', fontWeight: 700 }}>
                            {playing ? '⏸ playing' : '▶ play audio'}</span>;
                        })()}
                        <span title="what triggered this batch">⚡ {p.armedBy === 'acoustic' ? 'acoustic event' : 'speech endpoint'}</span>
                        {p.voicedPct != null && (
                          <span title="how much of the batch window was actually voiced — low % + confident text = likely hallucinated"
                            style={{ color: p.voicedPct < 15 ? '#ff8a8a' : p.voicedPct < 40 ? '#ffd9a0' : '#7ee0a0' }}>
                            🔊 {p.voicedPct}% voiced{p.voicedPct < 15 ? ' ⚠ mostly silent' : ''}
                          </span>
                        )}
                        {p.sttWindow
                          ? <span style={{ opacity: 0.85 }}>🎙 raw STT: <span style={{ fontStyle: 'italic' }}>“{p.sttWindow}”</span></span>
                          : <span style={{ opacity: 0.6, fontStyle: 'italic' }}>🎙 no raw STT for this window</span>}
                      </div>
                    )}
                    {/* Expandable COMPLETE JSON (pretty-printed) for any enriched/sound row. */}
                    {(isEnriched || viewKind === 'sound') && (
                      <details style={{ marginTop: 2 }}>
                        <summary style={{ cursor: 'pointer', fontSize: 10, color: '#8fa8c8', listStyle: 'none' }}>⛓ full JSON</summary>
                        <pre style={{ fontSize: 10, whiteSpace: 'pre-wrap', color: '#9ab', margin: '3px 0 0', maxHeight: 260, overflow: 'auto', background: '#0d1420', padding: 6, borderRadius: 4, border: '1px solid #1c2233' }}>
                          {JSON.stringify({ ts: s.interval.from, to: s.interval.to, durationMs: s.interval.durationMs, model: s.model, payload: p }, null, 2)}
                        </pre>
                      </details>
                    )}
                    {(() => {
                      const bits: string[] = [];
                      if (viewKind === 'vision') {
                        if (p.reused) bits.push('REUSED a recently-seen view — no VLM call (saved ~5s)');
                        else if (p.gateTrigger) bits.push(`looked because: ${String(p.gateTrigger).replace('local-change', 'something moved locally').replace('scene-change', 'the scene changed').replace('sense-wake', 'it heard something').replace('first-look', 'first look').replace('heartbeat', 'periodic re-check')}`);
                        if (p.gatedProbes) bits.push(`${p.gatedProbes} quiet checks before this`);
                        if (!p.reused && p.inferMs) bits.push(`took ${(Number(p.inferMs) / 1000).toFixed(1)}s`);
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
                    {/* REUSED vision row: show CURRENT frame vs the ORIGINAL analyzed frame side
                        by side, so the reuse is verifiable by eye — "yes, same view, fair to reuse"
                        (or catch a bad match). inputImages = [current, original]; reusedDist is the
                        embedding match distance. */}
                    {viewKind === 'vision' && p.reused && p.inputImages && p.inputImages.length >= 2 && (
                      <details style={{ marginTop: 4 }} open>
                        <summary style={{ cursor: 'pointer', fontSize: 10, color: '#7ee0a0' }}>
                          ♻ reused view{p.reusedDist != null ? ` — match d=${p.reusedDist.toFixed(3)}` : ''} (current vs original)
                        </summary>
                        <div style={{ marginTop: 4, display: 'flex', gap: 8, overflowX: 'auto', paddingBottom: 4 }}>
                          {[
                            { img: p.inputImages[0]!, label: 'now', tint: '#2c6f4a' },
                            { img: p.inputImages[1]!, label: 'original (reused from)', tint: '#3a4a6a' },
                          ].map((f, i) => (
                            <div key={i} style={{ position: 'relative', flexShrink: 0 }}>
                              <img src={`data:image/jpeg;base64,${f.img}`} alt={f.label} title="click to view original size"
                                onClick={() => setZoomImg(f.img)}
                                style={{ width: 170, borderRadius: 5, border: `1px solid ${f.tint}`, cursor: 'zoom-in' }} />
                              <span style={{ position: 'absolute', top: 2, left: 2, fontSize: 9, background: '#000b', color: '#cfe', borderRadius: 3, padding: '1px 5px' }}>{f.label}</span>
                            </div>
                          ))}
                        </div>
                      </details>
                    )}
                    {/* vision LEAK-HUNT: the EXACT frame qwen saw + the prompt it got, so a
                        hallucinated description is diagnosable ("was it in the image?"). Not on
                        reused rows — those get the current-vs-original comparison above. */}
                    {viewKind === 'vision' && !p.reused && ((p.inputImages && p.inputImages.length) || p.inputPrompt) && (
                      <details style={{ marginTop: 4 }}>
                        <summary style={{ cursor: 'pointer', fontSize: 10, color: '#7a8ca8' }}>
                          🖼 what qwen saw{p.inputImages?.length ? ` (${p.inputImages.length} frame${p.inputImages.length === 1 ? '' : 's'})` : ''} + prompt
                          {p.sampledFrames != null && p.sampledFrames > (p.inputImages?.length ?? p.sampledFrames) && (
                            <span title={`window dedup: sampled ${p.sampledFrames} frames, sent ${p.inputImages?.length} distinct (consecutive near-identical frames collapsed → fewer visual tokens)`}
                              style={{ marginLeft: 6, color: '#7ee0a0' }}>
                              ✂ {p.sampledFrames}→{p.inputImages?.length}{p.singleFrame ? ' (still)' : ''}
                            </span>
                          )}
                        </summary>
                        <div style={{ marginTop: 4 }}>
                          {/* PER-INFERENCE TIMELINE: window start–end, run time. So each row shows
                              exactly when the frames were grabbed and how long the VLM took. */}
                          {(p.frameFrom != null || p.inferMs != null) && (
                            <div style={{ fontSize: 10, color: '#7a8ca8', fontVariantNumeric: 'tabular-nums', marginBottom: 4 }}>
                              {p.frameFrom != null && p.frameTo != null
                                ? <>frames {istClockMs(p.frameFrom, true)} → {istClockMs(p.frameTo, true)} <span style={{ opacity: 0.6 }}>IST ({secs(p.frameTo - p.frameFrom)} span)</span></>
                                : null}
                              {p.inferMs != null && <span style={{ marginLeft: p.frameFrom != null ? 8 : 0 }}>· run {secs(Number(p.inferMs))}</span>}
                            </div>
                          )}
                          {/* the actual filmstrip qwen reasoned over — ALL window frames, in order,
                              each stamped with its own capture time (real spacing, not nominal). */}
                          {p.inputImages && p.inputImages.length > 0 && (
                            <div style={{ display: 'flex', gap: 4, overflowX: 'auto', paddingBottom: 4 }}>
                              {p.inputImages.map((img, i) => (
                                <div key={i} style={{ position: 'relative', flexShrink: 0 }}>
                                  <img src={`data:image/jpeg;base64,${img}`} alt={`qwen frame ${i + 1}`} title="click to view original size"
                                    onClick={() => setZoomImg(img)}
                                    style={{ width: 150, borderRadius: 5, border: '1px solid #223', cursor: 'zoom-in' }} />
                                  <span style={{ position: 'absolute', top: 2, left: 2, fontSize: 9, background: '#000a', color: '#9ab', borderRadius: 3, padding: '0 4px' }}>{i + 1}/{p.inputImages!.length}</span>
                                  {p.frameTimes?.[i] != null && (
                                    <span title={`${istClockMs(p.frameTimes[i]!, true)} IST`}
                                      style={{ position: 'absolute', bottom: 2, left: 2, right: 2, fontSize: 9, background: '#000b', color: '#9ab', borderRadius: 3, padding: '0 4px', textAlign: 'center', fontVariantNumeric: 'tabular-nums' }}>{istClockMs(p.frameTimes[i]!)}</span>
                                  )}
                                </div>
                              ))}
                            </div>
                          )}
                          {p.inputPrompt && (
                            <pre style={{ fontSize: 10, whiteSpace: 'pre-wrap', color: '#9ab', margin: '6px 0 0',
                              maxHeight: 220, overflow: 'auto', background: '#0d1420', padding: 8, borderRadius: 4 }}>{p.inputPrompt}</pre>
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
                    {p.inferMs != null && <span title="inference latency (sidecar/in-process compute)">⚡{fmtMs(p.inferMs)}</span>}
                    {viewKind === 'vision' && p.frames != null && <span title="frames sampled this window">🎞{p.frames}</span>}
                    {viewKind === 'vision' && p.reused && <span title="reused a recently-analyzed near-identical view (no VLM call)" style={{ fontSize: 10, color: '#7ee0a0', border: '1px solid #2c6f4a', borderRadius: 4, padding: '0 5px' }}>♻ reused</span>}
                    {viewKind === 'vision' && p.gateTrigger && !p.reused && <span title="why this analysis ran (the change gate's trigger)" style={{ fontSize: 10, color: '#8fa8c8' }}>⚑{p.gateTrigger}</span>}
                    {isStt && p.noSpeechProb != null && (
                      <span title="STT metrics — avg_logprob / no_speech_prob / compression_ratio">
                        lp{p.avgLogprob?.toFixed(2)} ns{p.noSpeechProb.toFixed(2)} cr{p.compressionRatio?.toFixed(1)}
                      </span>
                    )}
                  </span>
                </div>,
              );
            })}
        </div>
      </div>
      {/* TIMELINE LIGHTBOX — any frame thumbnail (gap sample, reused, filmstrip) opens here at
          ORIGINAL size. If the image is larger than the viewport the box scrolls; click the
          backdrop or press Esc to close. Natural size (no downscale) so pixels are inspectable. */}
      {/* shared audio element for the ▶ play-audio buttons on enricher rows. */}
      <audio ref={audioElRef} onEnded={() => setPlayingAudio(null)} onError={() => setPlayingAudio(null)} style={{ display: 'none' }} />
      {zoomImg && (
        <div onClick={() => setZoomImg(null)}
          style={{ position: 'fixed', inset: 0, zIndex: 1000, background: 'rgba(0,0,0,0.88)',
            display: 'grid', placeItems: 'center', overflow: 'auto', cursor: 'zoom-out' }}>
          <img src={`data:image/jpeg;base64,${zoomImg}`} alt="frame (original size)"
            onClick={(e) => e.stopPropagation()}
            style={{ display: 'block', margin: 'auto', borderRadius: 6, boxShadow: '0 8px 40px #000', cursor: 'default' }} />
        </div>
      )}
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

/** OFFLINE history time-range picker. Presets bounded by the dock's retained span (`hist.from/to`).
 *  `null` value = the full span (the /history default). Emits explicit {from,to} for narrower picks. */
function HistoryRange({ hist, value, onChange }: {
  hist?: DockHistory; value: { from: string; to: string } | null;
  onChange: (w: { from: string; to: string } | null) => void;
}) {
  const to = hist?.to ?? istIso(0);
  // A preset's `from` is clamped to the dock's earliest retained record — asking for "last 6h" on a
  // dock with only 2h of history just shows those 2h, never an empty window.
  const clampFrom = (msBack: number): string => {
    const want = new Date(new Date(to.replace('+05:30', 'Z')).getTime() - msBack).toISOString().replace('Z', '+05:30');
    return hist?.from && want < hist.from ? hist.from : want;
  };
  const presets: [string, string | null][] = [
    ['Full span', null], ['Last 6h', clampFrom(6 * 3600_000)], ['Last 1h', clampFrom(3600_000)],
  ];
  const activeFrom = value?.from ?? null;
  return (
    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
      <span style={{ fontSize: 11, color: '#7a8699' }}>window</span>
      {presets.map(([lbl, from]) => {
        const active = from === activeFrom || (from === null && value === null);
        return (
          <button key={lbl} onClick={() => onChange(from === null ? null : { from, to })}
            style={{ padding: '3px 9px', borderRadius: 6, fontSize: 11, cursor: 'pointer',
              background: active ? '#2563eb' : '#10141f', color: active ? '#fff' : '#9ab',
              border: `1px solid ${active ? '#2563eb' : '#1c2233'}` }}>
            {lbl}
          </button>
        );
      })}
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

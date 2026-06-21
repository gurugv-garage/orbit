/**
 * capture — the CAPTURE-JUDGING harness (docs/findings/recall-reliability.md).
 *
 * Records a chosen dock's live WebRTC A/V (video → .webm, audio → .wav) for a
 * window, captures every perception snapshot produced during it, and writes a
 * self-contained `session.json` artifact. The web "Capture" console plays the A/V
 * back with the snapshot timeline synced to the playhead, so a human (LLM-assisted)
 * can judge: did STT + the vision snapshots match reality, moment by moment?
 *
 * RECORDING MODE: while a dock is being recorded, the dock should NOT respond (we
 * want clean ambient perception, not the dock reacting). The capture module flips a
 * per-dock `recording` flag the brain checks before running a turn, and pushes a
 * `recording` frame to the phone so its UI reflects the mode.
 *
 *   POST /api/capture/start   { dock }            → begins a session, returns { id }
 *   POST /api/capture/stop    { id }              → ends it, finalizes the artifact
 *   GET  /api/capture                              → list sessions (newest first)
 *   GET  /api/capture/:id                          → one session's manifest (+snapshots)
 *   GET  /api/capture/:id/video                    → the .webm
 *   GET  /api/capture/:id/audio                    → the .wav
 *   POST /api/capture/:id/judge { marks }          → persist judge marks
 */

import { createReadStream } from 'node:fs';
import { mkdir, writeFile, readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Bus } from '../../core/bus.js';
import { json } from '../../core/http.js';
import type { StationModule, RouteContext } from '../../core/module.js';
import type { Directory } from '../docks/directory.js';
import type { ProcessingHub } from '../perception/hub.js';
import { getSnapshotsApi } from '../perception/index.js';
import { isoIst } from '../perception/snapshots.js';
import { startAudioRecording, type AudioRecordHandle } from './audio-recorder.js';
import { startVideoRecording, type VideoRecordHandle } from './video-recorder.js';

export interface CaptureWiring {
  getHub: () => ProcessingHub;
  directory: Directory;
  /** absolute dir for capture artifacts (created on first use). */
  dir: string;
}

interface LiveSession {
  id: string;
  dock: string;
  streamId: string;
  startedAtEpoch: number;
  video: VideoRecordHandle;
  audio: AudioRecordHandle;
}

interface Manifest {
  id: string;
  dock: string;
  startedAt: string;        // IST
  startedAtEpoch: number;
  endedAt: string;          // IST
  endedAtEpoch: number;
  durationMs: number;
  video: string;            // filename
  audio: string;            // filename
  // Processing RESULT RUNS over this raw A/V. The recorder seeds one 'live' run (the
  // snapshots the production pipeline produced while recording); the reprocess step
  // (re-run STT/vision with a chosen model) appends more runs for side-by-side compare.
  runs: ResultRun[];
  marks?: Record<string, unknown>;
}

interface ResultRun {
  label: string;            // 'live', or a model id like 'whisper-small.en' / 'qwen2.5-vl'
  model?: string;
  createdAt: string;        // IST
  snapshots: unknown[];     // SnapshotRecord[] produced by this run
}

/** Per-dock recording flag, read by the brain to SUPPRESS turns while recording. */
const recording = new Set<string>();
/** True if `dock` is currently being recorded (the brain should not respond). */
export function isRecording(dock: string): boolean { return recording.has(dock); }

export function captureModule(w: CaptureWiring): StationModule {
  const live = new Map<string, LiveSession>();
  let bus: Bus;
  const sessionDir = (id: string) => join(w.dir, id);

  const pushRecordingMode = (dock: string, on: boolean) => {
    // Tell the dock's phone it's in recording mode (UI reflects it; the brain also
    // gates turns via isRecording()). Directed to the voice component.
    bus.publish({
      topic: 'agent', kind: 'recording', payload: { recording: on },
      source: 'station', toAddr: { dock, component: 'phone' },
    });
  };

  return {
    name: 'capture',
    // No dedicated bus topic — it only does directed `agent` pushes (recording mode)
    // + REST. Declare 'agent' so the module contract is satisfied without expanding
    // the Topic union for a module that owns no topic of its own.
    topic: 'agent',
    description: 'capture-judging harness: record a dock\'s A/V + snapshots for replay',

    init(b: Bus) { bus = b; },

    async route(ctx: RouteContext): Promise<boolean> {
      const { req, res, subPath } = ctx;
      const readBody = async <T>(): Promise<T> => {
        const chunks: Buffer[] = [];
        for await (const c of req) chunks.push(c as Buffer);
        return JSON.parse(Buffer.concat(chunks).toString() || '{}') as T;
      };

      // POST /start { dock } → begin a recording session.
      if (req.method === 'POST' && subPath === '/start') {
        const { dock } = await readBody<{ dock?: string }>();
        if (!dock) { json(res, 400, { error: 'dock required' }); return true; }
        const cam = w.directory.resolveCap(dock, 'camera');
        if (!cam) { json(res, 409, { error: `dock "${dock}" has no online camera peer` }); return true; }
        const id = `cap-${Date.now()}-${randomUUID().slice(0, 6)}`;
        await mkdir(sessionDir(id), { recursive: true });
        const hub = w.getHub();
        const video = startVideoRecording(hub, cam.id, join(sessionDir(id), 'video.webm'));
        const audio = startAudioRecording(hub, cam.id, join(sessionDir(id), 'audio.wav'));
        live.set(id, { id, dock, streamId: cam.id, startedAtEpoch: Date.now(), video, audio });
        recording.add(dock);
        pushRecordingMode(dock, true);
        json(res, 200, { id, dock, recording: true });
        return true;
      }

      // POST /stop { id } → finalize the session + artifact.
      if (req.method === 'POST' && subPath === '/stop') {
        const { id } = await readBody<{ id?: string }>();
        const s = id ? live.get(id) : undefined;
        if (!s) { json(res, 404, { error: 'no such live session' }); return true; }
        live.delete(s.id);
        recording.delete(s.dock);
        pushRecordingMode(s.dock, false);
        const endedAtEpoch = Date.now();
        // media actually started a beat after start(); use the recorder's start if known.
        const startedAtEpoch = s.video.startedAt() || s.audio.startedAt() || s.startedAtEpoch;
        await Promise.allSettled([s.video.stop(), s.audio.stop()]);
        // Snapshots produced during the window (overlapping [start, end]).
        const fromIso = isoIst(new Date(startedAtEpoch));
        const toIso = isoIst(new Date(endedAtEpoch));
        const snapshots = getSnapshotsApi()?.inWindow(fromIso, toIso, s.dock) ?? [];
        const manifest: Manifest = {
          id: s.id, dock: s.dock,
          startedAt: fromIso, startedAtEpoch, endedAt: toIso, endedAtEpoch,
          durationMs: endedAtEpoch - startedAtEpoch,
          video: 'video.webm', audio: 'audio.wav',
          // The 'live' run = what the production pipeline produced during recording.
          // Reprocess runs (other models) get appended here later for compare.
          runs: [{ label: 'live', createdAt: toIso, snapshots }],
        };
        await writeFile(join(sessionDir(s.id), 'session.json'), JSON.stringify(manifest, null, 2));
        json(res, 200, { ok: true, id: s.id, durationMs: manifest.durationMs, snapshots: snapshots.length });
        return true;
      }

      // GET / → list sessions (newest first), with live status.
      if (req.method === 'GET' && subPath === '/') {
        await mkdir(w.dir, { recursive: true });
        const entries = await readdir(w.dir).catch(() => [] as string[]);
        const sessions: unknown[] = [];
        for (const id of entries) {
          const man = await readManifest(w.dir, id);
          if (man) sessions.push({ id: man.id, dock: man.dock, startedAt: man.startedAt, durationMs: man.durationMs, runs: (man.runs ?? []).length, snapshots: (man.runs?.[0]?.snapshots ?? []).length });
        }
        sessions.sort((a, b) => String((b as { startedAt: string }).startedAt).localeCompare(String((a as { startedAt: string }).startedAt)));
        const liveList = [...live.values()].map((s) => ({ id: s.id, dock: s.dock, live: true, startedAtEpoch: s.startedAtEpoch }));
        json(res, 200, { live: liveList, sessions });
        return true;
      }

      // GET /:id → one session manifest (+ snapshots). /:id/video /:id/audio serve files.
      let m = subPath.match(/^\/([^/]+)\/(video|audio)$/);
      if (m && req.method === 'GET') {
        const file = m[2] === 'video' ? 'video.webm' : 'audio.wav';
        const path = join(sessionDir(m[1]!), file);
        const ok = await stat(path).then(() => true).catch(() => false);
        if (!ok) { json(res, 404, { error: 'not found' }); return true; }
        res.writeHead(200, { 'content-type': m[2] === 'video' ? 'video/webm' : 'audio/wav' });
        createReadStream(path).pipe(res);
        return true;
      }
      m = subPath.match(/^\/([^/]+)\/judge$/);
      if (m && req.method === 'POST') {
        const body = await readBody<{ marks?: Record<string, unknown> }>();
        const man = await readManifest(w.dir, m[1]!);
        if (!man) { json(res, 404, { error: 'not found' }); return true; }
        man.marks = body.marks ?? {};
        await writeFile(join(sessionDir(m[1]!), 'session.json'), JSON.stringify(man, null, 2));
        json(res, 200, { ok: true });
        return true;
      }
      m = subPath.match(/^\/([^/]+)$/);
      if (m && req.method === 'GET') {
        const man = await readManifest(w.dir, m[1]!);
        if (!man) { json(res, 404, { error: 'not found' }); return true; }
        json(res, 200, man);
        return true;
      }

      return false;
    },
  };
}

async function readManifest(dir: string, id: string): Promise<Manifest | undefined> {
  try {
    const raw = await readFile(join(dir, id, 'session.json'), 'utf8');
    return JSON.parse(raw) as Manifest;
  } catch { return undefined; }
}

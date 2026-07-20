/**
 * orbit-station entrypoint.
 *
 * One process: HTTP(S) server (browser UI + REST/ingest) + one WebSocket hub
 * (device/browser peers) + an in-process bus that ties the modules together.
 * Since the server-brain cutover (docs/decision-traces/server-brain-impl.md) this process is
 * also the dock's BRAIN (pi agent sessions) and the body's single master
 * (motion executor) — the station is the one WebSocket server in the system.
 */

import { networkInterfaces } from 'node:os';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Bus } from './core/bus.js';
import { WebSocketGateway } from './core/websocket-gateway.js';
import { createServer } from './core/http.js';
import { startWebWatch, stopWebWatch } from './core/web-watch.js';
import type { StationModule } from './core/module.js';
import { observabilityModule, getObsAccess } from './modules/observability/index.js';
import { configModule } from './modules/config/index.js';
import { ConfigStore } from './modules/config/store.js';
import { bodylinkModule } from './modules/bodylink/index.js';
import { MotionExecutor } from './modules/bodylink/motion.js';
import { mediaModule } from './modules/media/index.js';
import { PerceptionProcessingHub } from './modules/perception/perception-processing-hub.js';
import { perceptionModule, setCameraMoving, bodyCmdSink } from './modules/perception/index.js';
import { buildVideoRecorder } from './modules/perception/record/recorder.js';
import { captureModule } from './modules/capture/index.js';
import { slackModule } from './modules/slack/index.js';
import { benchModule } from './modules/bench/index.js';
import { docksModule } from './modules/docks/index.js';
import { Directory } from './modules/docks/directory.js';
import { BindingStore } from './modules/docks/bindings.js';
import { brainModule, getBrainAccess, getWakeApi, getConductorAccess } from './modules/brain/index.js';
import { conductorModule } from './modules/conductor/index.js';
import { feedbackModule, getFeedbackCapture } from './modules/feedback/index.js';
import { healthSummary } from './modules/observability/health.js';
import { composeEnrichment, type ContextSources } from './modules/observability/context.js';
import { stationProvenance } from './modules/feedback/provenance.js';
import type { Provenance } from './modules/feedback/types.js';
import {
  getPerceptionGrounding, getSnapshotsApi, getMemoryApi, getGateApi, getPerceiveStore,
} from './modules/perception/index.js';
import { otaModule } from './modules/ota/index.js';
import { egoModule, introspectDock } from './modules/ego/index.js';
import { stationModule } from './modules/station.js';

// LLM provider keys live in the STATION's environment now (never in device
// builds — docs/decision-traces/server-brain-impl.md §3.1). For dev convenience they load
// from a gitignored `orbit-station/.env` (KEY=VALUE lines; real env wins).
loadDotEnv(new URL('../../.env', import.meta.url).pathname);
console.log(`orbit-station starting with Node ${process.version}`);
const PORT = Number(process.env.PORT ?? 8099);
const HOST = process.env.HOST ?? '0.0.0.0';

function loadDotEnv(path: string): void {
  // Boot-visible either way: a missing/late-created .env once cost a debugging
  // session (the watcher doesn't watch .env — touch main.ts to reload it).
  try {
    let n = 0;
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (!m || line.trim().startsWith('#')) continue;
      if (process.env[m[1]!] == null) process.env[m[1]!] = m[2]!;
      n++;
    }
    console.log(`  .env: ${n} key(s) loaded`);
  } catch {
    console.log('  .env: none (provider keys must come from the environment)');
  }
}

async function main() {
  const bus = new Bus();

  // Shared building blocks wired here (modules otherwise touch only the bus):
  //  - ConfigStore: one sqlite handle; config module owns writes, the brain
  //    reads effective values in-process.
  //  - Directory: dock composition + capability addressing (docks module
  //    publishes it; brain/bodylink/media resolve through it).
  //  - MotionExecutor: the body's single master (brain tools + console).
  //  - PerceptionProcessingHub: the SFU's media tap (perception processors).
  const configStore = new ConfigStore();
  // deviceId→dock bindings: the station-owned source of truth for which dock a
  // device belongs to (docs/modules/runtime-dock-binding.md).
  const bindings = new BindingStore();
  let perceptionProcessingHub: PerceptionProcessingHub | undefined;
  // SFU streamId→published-label lookup (set once the media module's SFU exists),
  // so a browser stream resolves to its stable label (e.g. 'console-perception')
  // for perception grouping instead of its ephemeral WS peer id.
  let labelOf: ((streamId: string) => string | undefined) | undefined;

  const modules: StationModule[] = [
    observabilityModule(),
    configModule(configStore),
    mediaModule(() => perceptionProcessingHub, (fn) => { labelOf = fn; }),   // WebRTC SFU; tap = the processing hub (or MEDIA_SINK fallback).
    slackModule(),                       // inbound Slack via Socket Mode (ingest only for now)
    benchModule(),
  ];

  const { server, secure } = createServer(modules);
  const hub = new WebSocketGateway(server, bus, bindings);

  // Roster-dependent wiring (needs the hub).
  const directory = new Directory(() => hub.roster());
  const motion = new MotionExecutor(bus, directory);
  // resolveDock(streamId): the stable identity a snapshot is grouped under.
  //  1. a dock WS peer → its dock name (e.g. 'anne-bot');
  //  2. else the SFU producer's published label (a browser stream → 'console-perception');
  //  3. else the raw streamId (last resort — an unlabelled/ephemeral source).
  // Without (2) a browser stream landed under its random WS id (ui-xxxxx), so the
  // console source selector (which filters by the stable label) never matched it.
  perceptionProcessingHub = new PerceptionProcessingHub(
    bus,
    (streamId) =>
      hub.roster().find((p) => p.id === streamId)?.dock
        ?? labelOf?.(streamId)
        ?? streamId,
    // dockReady: gate out UNCLAIMED *device* streams (a dock device peer with no
    // dock binding), so perception never files snapshots under a raw ws id. A
    // browser console stream (role 'browser', e.g. the Perception studio publishing
    // this laptop) is NOT a device — it's always ready, else its mic/cam never gets
    // STT/vision. A stream with no matching roster peer is ready too.
    // (docs/modules/runtime-dock-binding.md)
    (streamId) => {
      const peer = hub.roster().find((p) => p.id === streamId);
      return !peer || peer.role === 'browser' || !!peer.dock;
    },
  );
  // record_video: capture a dock's live SFU stream to a WebM clip (under data/recordings/).
  const recordingsDir = fileURLToPath(new URL('../data/recordings', import.meta.url));
  const videoRecorder = buildVideoRecorder(perceptionProcessingHub, recordingsDir);
  const captureDir = fileURLToPath(new URL('../data/captures', import.meta.url));

  modules.push(perceptionModule(() => perceptionProcessingHub!));
  // Feed the body's "my head just moved" signal into perception (self-motion vs world
  // change) — the executor's lastMotionAt is the real signal; faceFollow's pans never
  // reach the bodymotion snapshot stream. Keeps perception decoupled from bodylink. The
  // window (VISION_SELFMOTION_WINDOW_MS, default 2500) spans a pan (~1.4s) PLUS the VLM's
  // own latency, so a call that STARTED while moving is still recognised as self-motion —
  // measured 2026-07-09: at 1200ms most probes landed post-settle (pans finish fast).
  const selfMotionWindow = Number(process.env.VISION_SELFMOTION_WINDOW_MS ?? 2500);
  setCameraMoving((dock) => motion.recentlyMoved(dock, selfMotionWindow));
  // AUDIT: every servo command (accepted or rejected) → perception's bodymotion timeline.
  // Dock-keyed, camera-independent — the log of who moved the body, from where, to where,
  // and what got blocked by priority. Keeps bodylink decoupled from perception (main bridges).
  motion.setCmdSink(bodyCmdSink(), (instanceId) => getBrainAccess()?.taskName(instanceId));
  modules.push(docksModule(directory, () => hub, bindings));
  modules.push(bodylinkModule({ directory, motion, getHub: () => hub }));

  // ── SESSION CONTEXT: the one source-of-truth wiring ────────────────────────
  // Observability owns per-session context. These accessors let it (and the
  // feedback flow + the agent's inspect_observability tool) reach all the live
  // station state — configs, versions, models, perception, gate/addressed,
  // grounding — whether snapshotted onto the session or pulled on demand.
  const firmwareBuild = (dock: string): number | string | undefined =>
    hub.roster().find((p) => p.dock === dock && p.kind === 'dock-body-fw')?.build ?? undefined;
  const provenanceFor = (dock: string): Provenance => ({
    station: stationProvenance(),
    firmware: { build: firmwareBuild(dock) },
    models: { ...(getBrainAccess()?.models(dock) ?? {}), perception: perceptionModelsInPlay() },
  });
  const contextSources: ContextSources = {
    provenance: (dock) => provenanceFor(dock),
    config: (dock) => { void dock; return brainConfigSnapshot(configStore); },
    models: (dock) => ({ ...(getBrainAccess()?.models(dock) ?? {}), perception: perceptionModelsInPlay() }),
    profile: async (dock) => getBrainAccess()?.profile(dock),
    snapshots: (fromIso, toIso, dock) => getSnapshotsApi()?.inWindow(fromIso, toIso, dock) ?? [],
    gateDecisions: (limit) => getGateApi()?.recentDecisions(limit) ?? [],
    addressed: (dock) => getBrainAccess()?.addressed(dock) ?? [],
    grounding: (dock) => getPerceptionGrounding()?.forDock(dock),
  };
  // the brain enriches each session on turn end via this composer (instrumented
  // for EVERY session, not just when feedback is flagged).
  const enrichSession = async (dock: string, sessionId: string, span?: { from: number; to: number }) => {
    const patch = await composeEnrichment(dock, contextSources, span);
    getObsAccess()?.enrich(sessionId, dock, patch);
  };

  modules.push(brainModule({
    directory, motion, getHub: () => hub,
    config: (key) => configStore.get(key)?.value,
    recordVideo: videoRecorder,
    enrichSession,
    sessionContext: contextSources,
    // record_feedback → the feedback module's capture (wired below; lazy so the
    // ordering — feedback module is pushed after brain — doesn't matter).
    feedbackCapture: (req) => {
      const cap = getFeedbackCapture();
      if (!cap) throw new Error('feedback module not ready');
      return cap.capture(req);
    },
    // inspect_observability → the obs store + a fresh provenance snapshot.
    obs: {
      session: (sessionId) => getObsAccess()?.get(sessionId),
      health: (turns) => healthSummary(turns),
      provenance: (dock) => provenanceFor(dock),
    },
    // exact-request capture (obs request ring): what each LLM step sent.
    recordRequest: (sessionId, turnId, stepIndex, json) =>
      getObsAccess()?.recordRequest(sessionId, turnId, stepIndex, json),
  }));
  // conductor: one cheap per-dock governor that arms/runs the conducted things —
  // BEHAVIOURS (faceFollow's body-grant gate is a task; wakeUp is a hardcoded in-brain
  // reaction) and TASKS (faceFollow) — by tunable rules. Reads the brain's conversation
  // mode + task ops (ConductorAccess), the body lease holder (motion), and the WakeApi;
  // tunings from the `conductor` config key. Pushed after brain so its accessors exist.
  modules.push(conductorModule({
    // Conduct only docks with at least one ONLINE component — no point arming things on a
    // phantom/offline dock (and faceFollow needs the body/phone present anyway).
    docks: () => directory.docks().filter((d) => d.components.some((c) => c.online)).map((d) => d.name),
    config: () => configStore.get('conductor')?.value as Record<string, Record<string, Record<string, unknown>>> | undefined,
    convMode: (dock) => getConductorAccess()?.convMode(dock) ?? null,
    tasks: (dock) => getConductorAccess()?.listTasks(dock) ?? [],
    startTask: (dock, taskName, params) => { getConductorAccess()?.startTask(dock, taskName, params); },
    stopTask: (dock, instanceId) => { getConductorAccess()?.stopTask(dock, instanceId); },
    bodyHolder: (dock) => motion.bodyHolder(dock) ?? null,
    bodyOnline: (dock) => motion.isOnline(dock),
    // phone (face) WS-online → gates body-driving conducted things. Its absence stands the
    // dock down: non-bgTask things go off + their tasks are killed (nobody to perform for,
    // no perception source). A dock that has no phone slot at all reads as present (no gate).
    phoneOnline: (dock) => {
      const d = directory.docks().find((x) => x.name === dock);
      const phone = d?.components.find((c) => c.component === 'phone');
      return phone ? phone.online : true;
    },
    setWake: (dock, cfg) => { getWakeApi()?.setWakeConfig(dock, cfg); },
    // someone visible RIGHT NOW: the on-device MLKit perceive stream (~1 Hz), fresh within
    // 5 s. Drives faceFollow's presence gate (attention-director v1) — a stale frame or no
    // perceive stream reads as absent, which only makes the dock stiller, never wrong.
    present: (dock) => {
      const store = getPerceiveStore();
      const entry = store?.latest(dock);
      if (!store || !entry || Date.now() - entry.ts > 5_000) return false;
      return store.toFollowFaces(entry).length > 0;
    },
    // IDLE INTROSPECTION (ego.md §3.2): the conductor fires one when the dock's been idle a
    // while. The ego module assembles the dock's recent experience + owns the trace cooldown.
    introspect: (dock, trigger) => introspectDock(dock, trigger),
  }));
  // feedback: a THIN layer over the enriched obs session — read the session's
  // stored context, add the user's words + a fresh static snapshot, write MD.
  modules.push(feedbackModule({
    dockOf: (peerId) => getBrainAccess()?.dockOf(peerId),
    getTrace: (sessionId) => getObsAccess()?.get(sessionId),
    health: (turns) => healthSummary(turns),
    openSessionId: (dock) => getBrainAccess()?.openSessionId(dock),
    getSession: (dock, sessionId) => getBrainAccess()?.sessionDump(dock, sessionId) ?? {},
    sessionContext: contextSources,
    provenance: (dock) => provenanceFor(dock),
    memory: (dock, limit) => getMemoryApi()?.recent(dock, limit) ?? [],
    constants: () => feedbackConstants(),
  }));
  // capture-judging harness: record a dock's A/V + snapshots for replay/judging.
  modules.push(captureModule({ getHub: () => perceptionProcessingHub!, directory, dir: captureDir }));
  modules.push(otaModule(() => hub));   // OTA: version-compare against live roster
  modules.push(egoModule());            // per-dock ego document + introspection + trace
  // station meta module needs the registry + hub; add it last.
  modules.push(stationModule(() => modules, () => hub));

  for (const m of modules) await m.init(bus);

  server.listen(PORT, HOST, () => {
    const scheme = secure ? 'https' : 'http';
    const wss = secure ? 'wss' : 'ws';
    const lan = lanAddress();
    console.log(`\n  orbit-station up`);
    console.log(`  UI      ${scheme}://localhost:${PORT}/`);
    console.log(`  WS      ${wss}://localhost:${PORT}/ws`);
    if (lan) {
      // What the dock app + ESP32 connect to. Android emulator: use 10.0.2.2.
      console.log(`  LAN     ${wss}://${lan}:${PORT}/ws      ← ESP32 + phone`);
      console.log(`  emulator ${wss}://10.0.2.2:${PORT}/ws   ← Android AVD`);
    }
    console.log(`  modules: ${modules.map((m) => m.name).join(', ')}`);
    if (!secure) console.log(`  (http — run \`npm run certs\` for https)\n`);
    // Dev: own the web build watcher as a child (the `dev` script sets the flag),
    // so there's no `concurrently` sibling to orphan. Production `start` never sets it.
    if (process.env.STATION_WEB_WATCH === '1') startWebWatch();
  });

  // GRACEFUL SHUTDOWN: on Ctrl-C / SIGTERM (and `tsx watch` reloads) close the WS
  // hub + HTTP server so the process actually EXITS, instead of hanging on open
  // sockets (the "Process didn't exit in 5s. Force killing…" loop). A hard-exit
  // fallback guards against any straggling handle.
  let shuttingDown = false;
  const shutdown = (sig: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n  ${sig} — shutting down…`);
    const hardExit = setTimeout(() => process.exit(0), 2_000);
    hardExit.unref();
    try { stopWebWatch(); } catch { /* */ }
    try { hub.close(); } catch { /* */ }
    server.close(() => { clearTimeout(hardExit); process.exit(0); });
  };
  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));
  process.once('SIGHUP', () => shutdown('SIGHUP'));
  // BACKSTOP for the dev tree (tsx watch → us): if a kill signal never propagates
  // down, the parent's stdin pipe still closes when the parent dies — exit on that
  // so we never orphan and hold the port. Gate on STATION_WEB_WATCH (set only by the
  // dev runner, never by production `start`): under systemd, production `start` is
  // also non-TTY with an immediately-closing /dev/null stdin, so the old
  // `!isTTY` guard misfired and self-terminated the server right after boot.
  if (process.env.STATION_WEB_WATCH === '1' && !process.stdin.isTTY) {
    const onParentGone = () => shutdown('parent-exit');
    process.stdin.on('end', onParentGone);
    process.stdin.on('close', onParentGone);
    process.stdin.resume();
  }
}

/** First non-internal IPv4 — what phones/ESP32 on the LAN dial into. */
function lanAddress(): string | undefined {
  const ifaces = networkInterfaces();
  for (const addrs of Object.values(ifaces)) {
    for (const a of addrs ?? []) {
      if (a.family === 'IPv4' && !a.internal) return a.address;
    }
  }
  return undefined;
}

/** Distinct perception sidecar models currently producing snapshots (derived
 *  from the recent snapshot window — no extra registry needed). */
function perceptionModelsInPlay(): Array<{ name: string; endpoint: string }> {
  const since = new Date(Date.now() - 10 * 60_000 + 5.5 * 3600_000).toISOString().replace('Z', '+05:30');
  const now = new Date(Date.now() + 5.5 * 3600_000).toISOString().replace('Z', '+05:30');
  const recs = (getSnapshotsApi()?.inWindow(since, now) ?? []) as Array<{ model?: { name: string; endpoint: string } }>;
  const seen = new Map<string, { name: string; endpoint: string }>();
  for (const r of recs) {
    if (r.model?.name) seen.set(`${r.model.name}@${r.model.endpoint}`, r.model);
  }
  return [...seen.values()];
}

/** The dock's effective brain config (the `brain*` keys) as a flat snapshot. */
function brainConfigSnapshot(configStore: ConfigStore): Record<string, unknown> {
  const all = configStore.export();
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(all)) {
    if (k.startsWith('brain') || k.startsWith('perception')) out[k] = v;
  }
  return out;
}

/** Env-tunable constants worth recording in a feedback dump for reference. */
function feedbackConstants(): Record<string, unknown> {
  return {
    FORCE_GET_WINDOW_MS: process.env.FORCE_GET_WINDOW_MS,
    PERCEPTION_SNAPSHOT_CAP: process.env.PERCEPTION_SNAPSHOT_CAP,
    PERCEPTION_KEYFRAME_CAP: process.env.PERCEPTION_KEYFRAME_CAP,
    PORT: process.env.PORT ?? '8099',
  };
}

main().catch((err) => {
  console.error('orbit-station failed to start', err);
  process.exit(1);
});

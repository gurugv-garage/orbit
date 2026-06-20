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
import { Hub } from './core/hub.js';
import { createServer } from './core/http.js';
import { startWebWatch, stopWebWatch } from './core/web-watch.js';
import type { StationModule } from './core/module.js';
import { observabilityModule } from './modules/observability/index.js';
import { configModule } from './modules/config/index.js';
import { ConfigStore } from './modules/config/store.js';
import { bodylinkModule } from './modules/bodylink/index.js';
import { MotionExecutor } from './modules/bodylink/motion.js';
import { mediaModule } from './modules/media/index.js';
import { ProcessingHub } from './modules/perception/hub.js';
import { perceptionModule } from './modules/perception/index.js';
import { buildVideoRecorder } from './modules/perception/record/recorder.js';
import { slackModule } from './modules/slack/index.js';
import { benchModule } from './modules/bench/index.js';
import { docksModule } from './modules/docks/index.js';
import { Directory } from './modules/docks/directory.js';
import { brainModule } from './modules/brain/index.js';
import { otaModule } from './modules/ota/index.js';
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
  //  - ProcessingHub: the SFU's media tap (perception processors).
  const configStore = new ConfigStore();
  let processingHub: ProcessingHub | undefined;
  // SFU streamId→published-label lookup (set once the media module's SFU exists),
  // so a browser stream resolves to its stable label (e.g. 'console-perception')
  // for perception grouping instead of its ephemeral WS peer id.
  let labelOf: ((streamId: string) => string | undefined) | undefined;

  const modules: StationModule[] = [
    observabilityModule(),
    configModule(configStore),
    mediaModule(() => processingHub, (fn) => { labelOf = fn; }),   // WebRTC SFU; tap = the processing hub (or MEDIA_SINK fallback).
    slackModule(),                       // inbound Slack via Socket Mode (ingest only for now)
    benchModule(),
  ];

  const { server, secure } = createServer(modules);
  const hub = new Hub(server, bus);

  // Roster-dependent wiring (needs the hub).
  const directory = new Directory(() => hub.roster());
  const motion = new MotionExecutor(bus, directory);
  // resolveDock(streamId): the stable identity a snapshot is grouped under.
  //  1. a dock WS peer → its dock name (e.g. 'anne-bot');
  //  2. else the SFU producer's published label (a browser stream → 'console-perception');
  //  3. else the raw streamId (last resort — an unlabelled/ephemeral source).
  // Without (2) a browser stream landed under its random WS id (ui-xxxxx), so the
  // console source selector (which filters by the stable label) never matched it.
  processingHub = new ProcessingHub(bus, (streamId) =>
    hub.roster().find((p) => p.id === streamId)?.dock
      ?? labelOf?.(streamId)
      ?? streamId);
  // record_video: capture a dock's live SFU stream to a WebM clip (under data/recordings/).
  const recordingsDir = fileURLToPath(new URL('../data/recordings', import.meta.url));
  const videoRecorder = buildVideoRecorder(processingHub, recordingsDir);

  modules.push(perceptionModule(() => processingHub!));
  modules.push(docksModule(directory, () => hub));
  modules.push(bodylinkModule({ directory, motion, getHub: () => hub }));
  modules.push(brainModule({
    directory, motion, getHub: () => hub,
    config: (key) => configStore.get(key)?.value,
    recordVideo: videoRecorder,
  }));
  modules.push(otaModule(() => hub));   // OTA: version-compare against live roster
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
  // so we never orphan and hold the port. (Skipped under a real TTY / production
  // `start`.) The web watcher is our own child now, so it dies with us via stopWebWatch.
  if (!process.stdin.isTTY) {
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

main().catch((err) => {
  console.error('orbit-station failed to start', err);
  process.exit(1);
});

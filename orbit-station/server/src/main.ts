/**
 * orbit-station entrypoint.
 *
 * One process: HTTP(S) server (browser UI + REST/ingest) + one WebSocket hub
 * (firmware/app/browser peers) + an in-process bus that ties the modules
 * together. Replaces the old `plat` stub; the real-time media pipeline
 * (WebRTC/STT/TTS) is a separate concern, slated to live as a sidecar later.
 */

import { networkInterfaces } from 'node:os';
import { Bus } from './core/bus.js';
import { Hub } from './core/hub.js';
import { createServer } from './core/http.js';
import type { StationModule } from './core/module.js';
import { observabilityModule } from './modules/observability/index.js';
import { configModule } from './modules/config/index.js';
import { bodylinkModule } from './modules/bodylink/index.js';
import { mediaModule } from './modules/media/index.js';
import { ProcessingHub } from './modules/perception/hub.js';
import { perceptionModule } from './modules/perception/index.js';
import { mindModule } from './modules/mind/index.js';
import { benchModule } from './modules/bench/index.js';
import { docksModule } from './modules/docks/index.js';
import { otaModule } from './modules/ota/index.js';
import { stationModule } from './modules/station.js';

const PORT = Number(process.env.PORT ?? 8099);
const HOST = process.env.HOST ?? '0.0.0.0';

async function main() {
  const bus = new Bus();

  // The stream-processing hub IS the SFU's media tap; it fans media + WS facts to
  // registered processors. Built lazily here so it can resolve streamId→dockId from
  // the live roster (set after the WS hub exists). Phase 0: zero processors → no
  // behavior change; the perception module registers processors in init().
  let processingHub: ProcessingHub | undefined;

  // Module registry. Order doesn't matter; each owns a topic + optional routes.
  const modules: StationModule[] = [
    observabilityModule(),
    configModule(),
    bodylinkModule(),
    mediaModule(() => processingHub),   // WebRTC SFU; tap = the processing hub (or MEDIA_SINK fallback).
    mindModule(),
    benchModule(),
  ];

  const { server, secure } = createServer(modules);
  const hub = new Hub(server, bus);

  // Now the roster exists → build the processing hub (resolves peer id → dock name).
  processingHub = new ProcessingHub(bus, (streamId) =>
    hub.roster().find((p) => p.id === streamId)?.dock ?? streamId);

  // Perception registers processors onto the processing hub (built above).
  modules.push(perceptionModule(() => processingHub!));

  // these need the hub (live roster); add after it exists.
  modules.push(docksModule(() => hub));
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
  });
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

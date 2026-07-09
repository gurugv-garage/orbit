/**
 * OTA module — serve update artifacts, announce availability, drive builds.
 * See docs/ota.md §2 + §7. Mirrors the `config` module's shape.
 *
 * Two devices self-update by pulling from here:
 *   - the dock app (Android, PackageInstaller silent install)
 *   - the dock body (ESP32, esp_https_ota + rollback)
 *
 * The small "an update exists at URL, sha256 Y" signal rides the `ota` bus
 * topic (directed to the relevant peer); the multi-MB bytes download over plain
 * REST. The console subscribes to `ota` for the live build/device status (§7).
 *
 * REST (under /api/ota):
 *   GET  /                    both targets: artifact meta + per-peer status + build session
 *   GET  /:target/latest      meta.json for body|app
 *   GET  /:target/firmware.bin | /:target/app.apk   raw artifact (streamed)
 *   POST /:target/build       run the tmux build hook → record meta → announce
 *   POST /:target/announce     re-emit `available` to that target's peers (?to=peerId for one)
 */

import { createReadStream, existsSync, readFileSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { spawn } from 'node:child_process';
import type { IncomingMessage } from 'node:http';
import type { Bus } from '../../core/bus.js';
import { json } from '../../core/http.js';
import type { WebSocketGateway, RosterEntry } from '../../core/websocket-gateway.js';
import type { RouteContext, StationModule } from '../../core/module.js';
import { OtaStore, ARTIFACT_FILE, type OtaMeta, type OtaTarget } from './store.js';
import { launchBuild, isRunning, attachCmd, sessionName } from './build.js';

const TARGETS: OtaTarget[] = ['body', 'body-c3', 'app'];
const isTarget = (s: string): s is OtaTarget => (TARGETS as string[]).includes(s);

/** The software `kind` (hello v2) that owns each target — OTA targets the
 *  software in a slot, not a role. `body` and `body-c3` are the same firmware
 *  for two non-interchangeable chips, so they carry distinct kinds and a board
 *  only ever matches (and is offered) its own architecture's artifact. */
const TARGET_KIND: Record<OtaTarget, string> = {
  body: 'dock-body-fw',
  'body-c3': 'dock-body-fw-c3',
  app: 'dock-android-app',
};

/** Per-target live build-session status for the console (§7.4). */
interface BuildStatus {
  state: 'idle' | 'running' | 'done' | 'failed';
  session: string;
  attach: string;
  logTail?: string;
  exitCode?: number;
}

export function otaModule(getHub: () => WebSocketGateway): StationModule {
  const store = new OtaStore();
  let bus: Bus;
  const build: Record<OtaTarget, BuildStatus> = {
    body: { state: 'idle', session: sessionName('body'), attach: attachCmd('body') },
    'body-c3': { state: 'idle', session: sessionName('body-c3'), attach: attachCmd('body-c3') },
    app: { state: 'idle', session: sessionName('app'), attach: attachCmd('app') },
  };

  /** LAN IP the devices dial — same logic main.ts uses for the WS URL. */
  function lanHost(): string {
    for (const addrs of Object.values(networkInterfaces())) {
      for (const a of addrs ?? []) if (a.family === 'IPv4' && !a.internal) return a.address;
    }
    return 'localhost';
  }

  /** Absolute URL a device fetches the artifact from (docs/ota.md §1: url is absolute). */
  function artifactUrl(target: OtaTarget): string {
    const port = Number(process.env.PORT ?? 8099);
    return `http://${lanHost()}:${port}/api/ota/${target}/${ARTIFACT_FILE[target]}`;
  }

  /** The connected peers running a target's software (matched by hello kind). */
  function peersFor(target: OtaTarget): RosterEntry[] {
    return getHub().roster().filter((p) => p.kind === TARGET_KIND[target]);
  }

  /** Send an `available` offer to one peer (directed). docs/ota.md §1. */
  function offer(target: OtaTarget, meta: OtaMeta, peerId: string): void {
    bus.publish({
      topic: 'ota',
      kind: 'available',
      source: 'station',
      to: peerId,
      payload: {
        target,
        build: meta.build,
        version: meta.version,
        url: artifactUrl(target),
        sha256: meta.sha256,
        size: meta.size,
      },
    });
  }

  /** Offer the current artifact to every behind peer (or one specific peer). */
  function announce(target: OtaTarget, onlyPeer?: string): number {
    const meta = store.meta(target);
    if (!meta) return 0;
    let sent = 0;
    for (const p of peersFor(target)) {
      if (onlyPeer && p.id !== onlyPeer) continue;
      // gate: only offer to peers strictly behind (or unknown build = treat as
      // behind so a device that didn't report a build still gets offered).
      const behind = p.build == null || p.build < meta.build;
      if (behind) {
        offer(target, meta, p.id);
        sent++;
      }
    }
    return sent;
  }

  /** Broadcast a console snapshot of a target's artifact + peers + build state. */
  function emitState(target: OtaTarget): void {
    const meta = store.meta(target);
    const peers = peersFor(target).map((p) => ({
      id: p.id,
      dock: p.dock,
      label: p.label,
      build: p.build,
      online: true,
      status: !meta ? 'unknown' : p.build == null ? 'unknown'
        : p.build > meta.build ? 'ahead'
        : p.build < meta.build ? 'behind' : 'uptodate',
    }));
    bus.publish({
      topic: 'ota',
      kind: 'state',
      source: 'station',
      payload: { target, artifact: meta, peers, build: build[target] },
    });
  }

  /**
   * WIRED app install over USB: `adb install -r <apk>`. The fallback for OEMs
   * that block app-driven self-install (MIUI rejects PackageInstaller.commit);
   * adb is the privileged path that works while the phone is tethered. Streams
   * `ota` progress/result so the console phase bar reflects it, same as a
   * wireless OTA — just driven from the host instead of the device.
   */
  function adbInstall(apk: string, build: number): void {
    const emit = (kind: string, payload: object) =>
      bus.publish({ topic: 'ota', kind, source: 'station', payload: { target: 'app', ...payload } });
    emit('progress', { phase: 'applying', via: 'adb' });
    const adb = process.env.ADB ?? 'adb';
    const p = spawn(adb, ['install', '-r', apk]);
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (out += d));
    p.on('error', (e) => emit('result', { build, ok: false, error: `adb spawn failed: ${e.message}` }));
    p.on('close', (code) => {
      const ok = code === 0 && /Success/i.test(out);
      if (ok) emit('result', { build, ok: true, via: 'adb' });
      else emit('result', { build, ok: false, error: out.trim().split('\n').slice(-3).join(' ') || `adb exited ${code}` });
      emitState('app');
    });
  }

  return {
    name: 'ota',
    topic: 'ota',
    description: 'self-update: artifact store, availability offers, tmux builds (docs/ota.md)',

    init(b) {
      bus = b;

      // A device connected/reconnected (peer-joined) OR its heartbeat reported a
      // new build (peer-updated) → if it's behind the current artifact, offer
      // right away. The "peer (re)appears while behind" half of the symmetric
      // trigger (docs/ota.md §3.4); peer-updated also keeps the console fresh
      // after an OTA reboot without waiting for a full reconnect.
      bus.on('station', (msg) => {
        if (msg.source !== 'station') return;
        if (msg.kind !== 'peer-joined' && msg.kind !== 'peer-updated') return;
        const p = msg.payload as { kind?: string };
        const target = TARGETS.find((t) => TARGET_KIND[t] === p.kind);
        if (!target) return;
        announce(target);     // offers only to behind peers; safe to call broadly
        emitState(target);    // refresh the console card
      });
      bus.on('station', (msg) => {
        if (msg.source === 'station' && msg.kind === 'peer-left') {
          const p = msg.payload as { kind?: string };
          const target = TARGETS.find((t) => TARGET_KIND[t] === p.kind);
          if (target) emitState(target);
        }
      });

      // Re-broadcast device-originated progress/result so the console (which
      // subscribes to `ota`) sees it. The hub already forwards peer publishes
      // onto the bus; we additionally refresh `state` on a `result` (the device
      // version may have moved). Nothing to do for `progress` (it's already on
      // the bus for subscribers); we only react to `result`.
      bus.on('ota', (msg) => {
        if (msg.source === 'station') return;            // our own emissions
        if (msg.kind === 'result') {
          const target = (msg.payload as { target?: string })?.target;
          if (target && isTarget(target)) {
            // peer's hello build updates on its next (re)connect; refresh now too.
            setTimeout(() => emitState(target), 250);
          }
        }
        // MANUAL CHECK: a device tapped its build number → re-offer if it's behind.
        // Same gate as the peer-join re-announce, but directed only at the requester
        // (msg.source) so an idle dock can poke the station without waiting for the
        // next heartbeat. No-op if it's already up to date (announce skips it).
        if (msg.kind === 'check') {
          const target = (msg.payload as { target?: string })?.target;
          if (target && isTarget(target)) announce(target, msg.source);
        }
      });
    },

    async route(ctx: RouteContext) {
      const { req, res, subPath, url } = ctx;

      // GET / — full snapshot for the console mount.
      if (subPath === '/' && req.method === 'GET') {
        const out = TARGETS.map((target) => ({
          target,
          artifact: store.meta(target),
          build: build[target],
          peers: peersFor(target).map((p) => ({
            id: p.id, dock: p.dock, label: p.label, build: p.build,
          })),
        }));
        json(res, 200, { targets: out, urls: Object.fromEntries(TARGETS.map((t) => [t, artifactUrl(t)])) });
        return true;
      }

      const m = subPath.match(/^\/([^/]+)\/(.+)$/);
      if (!m) return false;
      const target = m[1]!;
      const rest = m[2]!;
      if (!isTarget(target)) { json(res, 404, { error: 'unknown target' }); return true; }

      // GET /:target/latest — meta.json
      if (rest === 'latest' && req.method === 'GET') {
        const meta = store.meta(target);
        if (!meta) { json(res, 404, { error: 'no artifact built yet' }); return true; }
        json(res, 200, meta);
        return true;
      }

      // GET /:target/<artifact-file> — raw download (streamed)
      if (rest === ARTIFACT_FILE[target] && req.method === 'GET') {
        const file = store.artifactPath(target);
        const meta = store.meta(target);
        if (!existsSync(file) || !meta) { json(res, 404, { error: 'no artifact' }); return true; }
        res.writeHead(200, {
          'content-type': 'application/octet-stream',
          'content-length': String(meta.size),
          'content-disposition': `attachment; filename="${ARTIFACT_FILE[target]}"`,
        });
        createReadStream(file).pipe(res);
        return true;
      }

      // POST /:target/build — run the tmux build hook
      if (rest === 'build' && req.method === 'POST') {
        if (await isRunning(target)) {
          json(res, 409, { error: 'build already running', attach: attachCmd(target) });
          return true;
        }
        // Release details entered in the console at build time (docs/ota.md §3).
        // The station records them as build metadata; devices never see them.
        const body = await readBody(req).catch(() => '');
        const notes = (() => {
          try { return (JSON.parse(body || '{}') as { notes?: string }).notes?.trim() || undefined; }
          catch { return undefined; }
        })();
        // The build number we'll stamp: next after the current artifact (or 1).
        const nextBuild = (store.meta(target)?.build ?? 0) + 1;
        const logPath = store.logPath(target, nextBuild);

        const launched = await launchBuild(target, logPath, {
          onTail: (tail) => {
            build[target] = { ...build[target], state: 'running', logTail: tail };
            bus.publish({ topic: 'ota', kind: 'progress', source: 'station',
              payload: { target, phase: 'building', tail } });
          },
          onDone: (ok, exitCode, tail) => {
            if (ok) {
              // The hook wrote built.json {build, version} next to the artifact.
              const built = readBuilt(store.dir(target));
              const b = built?.build ?? nextBuild;
              const v = built?.version ?? String(b);
              try {
                const meta = store.recordFromArtifact(target, b, v, notes);
                build[target] = { ...build[target], state: 'done', exitCode, logTail: tail };
                emitState(target);
                const sent = announce(target);
                bus.publish({ topic: 'ota', kind: 'result', source: 'station',
                  payload: { target, build: meta.build, version: meta.version, ok: true, offered: sent } });
              } catch (e) {
                build[target] = { ...build[target], state: 'failed', exitCode, logTail: tail };
                bus.publish({ topic: 'ota', kind: 'result', source: 'station',
                  payload: { target, ok: false, error: `artifact missing after build: ${String(e)}` } });
              }
            } else {
              build[target] = { ...build[target], state: 'failed', exitCode, logTail: tail };
              bus.publish({ topic: 'ota', kind: 'result', source: 'station',
                payload: { target, ok: false, error: `build exited ${exitCode}`, tail } });
            }
            emitState(target);
          },
        });

        if (!launched.started) { json(res, 400, launched); return true; }
        build[target] = { state: 'running', session: launched.session, attach: launched.attach };
        emitState(target);
        json(res, 202, { building: true, ...launched });
        return true;
      }

      // POST /:target/announce[?to=peerId] — re-offer current artifact
      if (rest === 'announce' && req.method === 'POST') {
        const to = url.searchParams.get('to') ?? undefined;
        const meta = store.meta(target);
        if (!meta) { json(res, 404, { error: 'no artifact to announce' }); return true; }
        const sent = announce(target, to);
        json(res, 200, { announced: sent, build: meta.build });
        return true;
      }

      // POST /:target/install-adb — WIRED install over USB (app only).
      // The app can't self-install on every OEM (e.g. MIUI blocks app-driven
      // PackageInstaller); `adb install -r` is the privileged path that always
      // works while the phone is tethered. The station shells out to adb on the
      // host and streams the result as ota progress/result for the console.
      if (rest === 'install-adb' && req.method === 'POST' && target === 'app') {
        const meta = store.meta('app');
        const apk = store.artifactPath('app');
        if (!meta || !existsSync(apk)) { json(res, 404, { error: 'no app artifact built yet' }); return true; }
        adbInstall(apk, meta.build);
        json(res, 202, { installing: true, build: meta.build, via: 'adb' });
        return true;
      }

      return false;
    },
  };
}

/** Read the {build, version} the build hook recorded for the fresh artifact. */
/** Read a request body to a string (small JSON payloads only). */
function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function readBuilt(dir: string): { build?: number; version?: string } | null {
  const p = `${dir}/built.json`;
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

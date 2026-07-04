/**
 * BodyLink module — the body's command path + state cache, per dock.
 *
 * The MotionExecutor (motion.ts) is the body's SINGLE MASTER: the brain's
 * move/gesture tools and the console sliders both route through it, in one
 * process (the phone↔ESP32 link is retired — see node-dock/bodylink/DESIGN.md
 * banner). The firmware holds ONE socket (to the station) and speaks the
 * BodyLink vocabulary on this topic:
 *
 *   station → body:  kind 'command'  payload = set_target body (directed toAddr)
 *                    kind 'ping'  { seq } → body echoes it back (conn-health burst)
 *   body → station:  kind 'profile'  capability profile (on connect)
 *                    kind 'state' / 'applied'  reported per-part state
 *                    kind 'event' / 'error'    async notices
 *                    kind 'pong'  { seq } → echo of a ping (station times RTT + loss)
 *
 * Passive link-health (rssi/heap/reconnects) rides the heartbeat → hub → dock
 * card + digest (a live glance, no button). The ping/pong burst is the on-demand
 * deep-dive — real packet-loss% + RTT on the station↔body WS, measured from the
 * station (the side that can count) — see progress.md §"ESP32-C3 SuperMini Wi-Fi".
 *
 * Phone/console awareness is a ~1 Hz `digest` — body status is DISPLAY-ONLY
 * and staleness-tolerant by design (impl plan corner case 23): directed to
 * the dock's face component + an undirected copy for browser consoles.
 *
 *   GET  /api/bodylink/profile?dock=    capability profile
 *   GET  /api/bodylink/state?dock=      latest reported state
 *   POST /api/bodylink/command          { dock?, parts } → executor (clamped)
 *   POST /api/bodylink/play             { dock?, steps } → runSteps (choreography)
 *   POST /api/bodylink/health-check     { dock? } → active conn-health probe report
 */

import type { Bus } from '../../core/bus.js';
import { json } from '../../core/http.js';
import type { IncomingMessage } from 'node:http';
import type { Hub } from '../../core/hub.js';
import type { RouteContext, StationModule } from '../../core/module.js';
import type { Directory } from '../docks/directory.js';
import type { MotionExecutor } from './motion.js';
import type { MoveStep } from '../brain/schemas.js';

const DIGEST_MIN_INTERVAL_MS = 1_000;

interface ParamSpec {
  type: 'int' | 'float';
  unit: string;
  range: [number | null, number | null];
  default?: number;
}
interface BodyProfile {
  body: {
    device_id: string;
    name: string;
    parts: Record<string, { description?: string; home?: Record<string, number>; params: Record<string, ParamSpec> }>;
  };
}

interface DockBody {
  profile: BodyProfile | null;
  state: Record<string, Record<string, number>>;
  lastDigestAt: number;
}

export function bodylinkModule(deps: {
  directory: Directory;
  motion: MotionExecutor;
  getHub: () => Hub;
}): StationModule {
  let bus: Bus;
  const docks = new Map<string, DockBody>();
  // in-flight ping seqs → monotonic-clock send time. A returning `pong` looks
  // its seq up here to compute RTT (then deletes it); seqs still present after
  // the drain window = dropped packets.
  const pendingPings = new Map<number, number>();
  const rttBySeq = new Map<number, number>();   // seq → round-trip ms (drained per burst)
  let pingSeq = 0;

  interface HealthReport {
    sent: number; received: number; lossPct: number;
    rttMin?: number; rttAvg?: number; rttMax?: number;
  }

  /** Active packet-loss/latency probe on the station↔body WS link. Fires N
   *  `ping` frames, the body echoes each as `pong`; we count echoes (loss %)
   *  and time each round-trip (RTT). Measured from the station because it's
   *  the side that can count, and it tests the link that actually flaps —
   *  NOT body↔AP. (The passive rssi/heap/reconnects ride the heartbeat.) */
  async function probePackets(dock: string, count = 20, gapMs = 50, drainMs = 1_500): Promise<HealthReport> {
    const target = deps.directory.resolveCap(dock, 'servo');
    if (!target?.component) throw new Error('no online body for this dock');
    const addr = { dock, component: target.component };
    const firstSeq = pingSeq;
    for (let i = 0; i < count; i++) {
      const seq = pingSeq++;
      pendingPings.set(seq, performance.now());
      bus.publish({ topic: 'bodylink', kind: 'ping', payload: { seq }, source: 'station', toAddr: addr });
      await new Promise((r) => setTimeout(r, gapMs));
    }
    // drain window: let the last pongs return before we tally.
    await new Promise((r) => setTimeout(r, drainMs));
    const rtts: number[] = [];
    for (let seq = firstSeq; seq < pingSeq; seq++) {
      pendingPings.delete(seq);                 // clear whatever's left (drops)
      const rtt = rttBySeq.get(seq);
      if (rtt !== undefined) { rtts.push(rtt); rttBySeq.delete(seq); }
    }
    const received = rtts.length;
    const lossPct = count === 0 ? 0 : Math.round(((count - received) / count) * 1000) / 10;
    const rep: HealthReport = { sent: count, received, lossPct };
    if (received) {
      rep.rttMin = Math.round(Math.min(...rtts));
      rep.rttMax = Math.round(Math.max(...rtts));
      rep.rttAvg = Math.round(rtts.reduce((a, b) => a + b, 0) / received);
    }
    return rep;
  }

  function body(dock: string): DockBody {
    let d = docks.get(dock);
    if (!d) {
      d = { profile: null, state: {}, lastDigestAt: 0 };
      docks.set(dock, d);
    }
    return d;
  }

  /** the sender's dock, from its hello (tenancy: never from the payload). */
  function dockOf(peerId: string): string | undefined {
    return deps.getHub().roster().find((p) => p.id === peerId)?.dock;
  }

  function clampToProfile(dock: string, parts: Record<string, Record<string, number>>): Record<string, Record<string, number>> {
    const profile = body(dock).profile;
    if (!profile) return parts;
    const out: Record<string, Record<string, number>> = {};
    for (const [part, params] of Object.entries(parts)) {
      const spec = profile.body.parts[part];
      if (!spec) continue; // UNKNOWN_PART — drop; body would also reject
      out[part] = {};
      for (const [k, v] of Object.entries(params)) {
        const ps = spec.params[k];
        if (!ps) continue;
        let val = v;
        const [lo, hi] = ps.range;
        if (lo != null && val < lo) val = lo;
        if (hi != null && val > hi) val = hi;
        out[part]![k] = val;
      }
    }
    return out;
  }

  /** ~1 Hz body-status digest: directed to the dock's face component (the
   *  phone's status panel) + undirected for consoles. */
  function maybeDigest(dock: string, force = false): void {
    const d = body(dock);
    const now = Date.now();
    if (!force && now - d.lastDigestAt < DIGEST_MIN_INTERVAL_MS) return;
    d.lastDigestAt = now;
    const online = deps.motion.isOnline(dock);
    // Fold the body peer's latest heartbeat health (rssi/heap/reconnects) into
    // the digest so consoles show link quality LIVE — no button needed. The
    // health-check button is only for the extra active loss/RTT measurement.
    const health = deps.directory.resolveCap(dock, 'servo')?.health;
    const payload = { dock, online, state: d.state, targets: deps.motion.targets(dock), health, ts: now };
    bus.publish({ topic: 'bodylink', kind: 'digest', payload, source: 'station' });
    const face = deps.directory.resolveCap(dock, 'face');
    if (face?.component) {
      bus.publish({
        topic: 'bodylink', kind: 'digest', payload, source: 'station',
        toAddr: { dock, component: face.component },
      });
    }
  }

  return {
    name: 'bodylink',
    topic: 'bodylink',
    description: 'body command path + state cache (motion executor = the single master)',

    init(b) {
      bus = b;
      bus.on('bodylink', (msg) => {
        if (msg.source === 'station') return;
        const dock = dockOf(msg.source);
        if (!dock) return;
        const d = body(dock);
        if (msg.kind === 'profile') {
          d.profile = msg.payload as BodyProfile;
          maybeDigest(dock, true);
        } else if (msg.kind === 'state' || msg.kind === 'applied') {
          if (msg.kind === 'state') d.state = msg.payload as Record<string, Record<string, number>>;
          else Object.assign(d.state, (msg.payload as { parts?: Record<string, Record<string, number>> })?.parts ?? {});
          maybeDigest(dock);
        } else if (msg.kind === 'pong') {
          // echo of a conn-health ping → RTT = now − send time. Record it; the
          // probe tallies loss (missing seqs) + RTT after its drain window.
          const seq = (msg.payload as { seq?: number } | null)?.seq;
          if (typeof seq === 'number') {
            const sentAt = pendingPings.get(seq);
            if (sentAt !== undefined) {
              rttBySeq.set(seq, performance.now() - sentAt);
              pendingPings.delete(seq);
            }
          }
        }
      });

      // presence flips (body on/offline) are digest-worthy immediately
      bus.on('station', (msg) => {
        if (msg.source !== 'station') return;
        if (msg.kind !== 'peer-joined' && msg.kind !== 'peer-left') return;
        const p = msg.payload as { dock?: string; caps?: string[] } | null;
        if (p?.dock && (p.caps ?? []).includes('servo')) maybeDigest(p.dock, true);
      });
    },

    async route(ctx: RouteContext) {
      const { req, res, subPath, url } = ctx;
      const dockParam = url.searchParams.get('dock') ?? undefined;
      /** default when no ?dock=: the one dock with an ONLINE body wins; else
       *  the single known dock (console back-compat). Smoke/test docks linger
       *  in the directory, so "exactly one known" almost never holds — online
       *  servo presence is the signal that matters. */
      function pickDock(): string | undefined {
        if (dockParam) return dockParam;
        const online = deps.directory.docks().map((d) => d.name)
          .filter((name) => deps.motion.isOnline(name));
        if (online.length === 1) return online[0];
        const known = [...new Set([...docks.keys(), ...deps.directory.docks().map((d) => d.name)])];
        return known.length === 1 ? known[0] : undefined;
      }

      if (subPath === '/profile' && req.method === 'GET') {
        const dock = pickDock();
        json(res, 200, (dock && body(dock).profile) ?? { error: 'no body connected', dock });
        return true;
      }
      if (subPath === '/state' && req.method === 'GET') {
        const dock = pickDock();
        json(res, 200, dock ? { dock, online: deps.motion.isOnline(dock), state: body(dock).state, targets: deps.motion.targets(dock) } : {});
        return true;
      }
      // who currently HOLDS the body (the actuator lease) + last real mover — for watching
      // acquire/preempt/expire during lease validation, and a future console badge.
      if (subPath === '/holder' && req.method === 'GET') {
        const dock = pickDock();
        json(res, 200, dock ? { dock, holder: deps.motion.bodyHolder(dock) ?? null, lastMover: deps.motion.lastMover(dock) ?? null } : {});
        return true;
      }
      // operator-driven timed choreography → the brain's `move` runner (the
      // console's dance/gesture buttons). Fire-and-forget like the move tool:
      // returns the status string immediately; the sequence runs server-side
      // with the normal heartbeat. A new play/command supersedes it.
      if (subPath === '/play' && req.method === 'POST') {
        const cmd = JSON.parse(await readBody(req)) as { dock?: string; steps?: unknown; source?: string };
        const dock = cmd.dock ?? pickDock();
        if (!dock) { json(res, 400, { error: 'which dock? pass {dock}' }); return true; }
        try {
          // forward an optional `source` so the lease arbitrates this move at the right
          // priority (default 'console'); lets the console / a test drive any priority.
          const status = deps.motion.runSteps(dock, (cmd.steps ?? []) as MoveStep[], cmd.source ?? 'console');
          maybeDigest(dock, true);
          json(res, 200, { dock, status });
        } catch (e) {
          json(res, 400, { error: e instanceof Error ? e.message : String(e) });
        }
        return true;
      }
      // operator set_target → the same master the brain uses (last write wins).
      if (subPath === '/command' && req.method === 'POST') {
        const cmd = JSON.parse(await readBody(req)) as { dock?: string; parts: Record<string, Record<string, number>> };
        const dock = cmd.dock ?? pickDock();
        if (!dock) { json(res, 400, { error: 'which dock? pass {dock}' }); return true; }
        const parts = clampToProfile(dock, cmd.parts ?? {});
        const partsUs: Record<string, number> = {};
        let durationMs: number | undefined;
        for (const [part, params] of Object.entries(parts)) {
          if (typeof params.pulse_width_us === 'number') partsUs[part] = params.pulse_width_us;
          if (typeof params.duration_ms === 'number') durationMs = params.duration_ms;
        }
        deps.motion.setTargets(dock, partsUs, durationMs);
        maybeDigest(dock, true);
        json(res, 200, { sent: { dock, parts } });
        return true;
      }
      // on-demand conn-health probe (the console's "Check conn health" button):
      // fire a ping-burst on the station↔body WS and return real loss% + RTT.
      // The passive rssi/heap/reconnects (heartbeat → dock card) is the glance;
      // this is the deep-dive that actually measures packet loss on the link.
      if (subPath === '/health-check' && req.method === 'POST') {
        const dock = pickDock();
        if (!dock) { json(res, 400, { error: 'which dock? pass ?dock=' }); return true; }
        try {
          const report = await probePackets(dock);
          json(res, 200, { dock, at: Date.now(), report });
        } catch (e) {
          json(res, 503, { dock, error: e instanceof Error ? e.message : String(e) });
        }
        return true;
      }
      return false;
    },
  };
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

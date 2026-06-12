/**
 * Brain module — the dock's LLM loop, server-side (docs/SERVER-BRAIN-IMPL.md).
 *
 * Owns the `agent` topic. One DockBrainSession per dock (lazy). Tenancy rule:
 * a frame's dock is resolved from the SENDER's hello via the roster — never
 * from the payload — so a device can only ever act on its own lane.
 *
 *   phone → station:  transcript (partials pre-warm), turn-request,
 *                     tool-result (handled by RpcBroker), turn-cancel,
 *                     speech-status
 *   station → phone:  tool-call, speak, turn-status, brain-status (directed)
 *
 *   GET  /api/brain/docks                lanes + open session
 *   GET  /api/brain/:dock/sessions       session index (incl. summaries)
 *   GET  /api/brain/:dock/history        open session transcript
 *   POST /api/brain/:dock/session/end    close now (next turn opens fresh)
 */

import type { Bus } from '../../core/bus.js';
import { json } from '../../core/http.js';
import type { Hub } from '../../core/hub.js';
import type { RouteContext, StationModule } from '../../core/module.js';
import type { Directory } from '../docks/directory.js';
import type { MotionExecutor } from '../bodylink/motion.js';
import { getFaceTools } from '../perception/index.js';
import { RpcBroker } from './rpc.js';
import { DockBrainSession, type TurnRequest } from './session.js';
import { SessionStore } from './store.js';

const IDLE_SWEEP_MS = 60_000;

export interface BrainWiring {
  directory: Directory;
  motion: MotionExecutor;
  getHub: () => Hub;
  /** effective config value by key (the shared ConfigStore). */
  config: (key: string) => unknown;
}

export function brainModule(w: BrainWiring): StationModule {
  const store = new SessionStore();
  const sessions = new Map<string, DockBrainSession>();
  let bus: Bus;
  let rpc: RpcBroker;

  function session(dock: string): DockBrainSession {
    let s = sessions.get(dock);
    if (!s) {
      s = new DockBrainSession(dock, {
        bus, directory: w.directory, rpc, motion: w.motion, store,
        getFaces: getFaceTools, config: w.config,
        log: (line) => console.log(line),
      });
      sessions.set(dock, s);
    }
    return s;
  }

  /** TENANT RESOLUTION: the sender's dock, from its hello — never the payload. */
  function dockOf(peerId: string): string | undefined {
    return w.getHub().roster().find((p) => p.id === peerId)?.dock;
  }

  return {
    name: 'brain',
    topic: 'agent',
    description: 'the dock brain: per-dock pi agent sessions; transcripts up, tool-calls/speak down',

    init(b) {
      bus = b;
      rpc = new RpcBroker(bus, w.directory);

      bus.on('agent', (msg) => {
        if (msg.source === 'station') return;
        const dock = dockOf(msg.source);
        if (!dock) {
          bus.publish({
            topic: 'agent', kind: 'error',
            payload: { message: 'agent frames need a dock identity (hello.dock)' },
            source: 'station', to: msg.source,
          });
          return;
        }
        const p = msg.payload as Record<string, unknown> | null;
        switch (msg.kind) {
          case 'hello':
            // The deterministic half of the resync handshake: the peer-joined
            // push below can RACE the peer's subscribe frame (both arrive
            // back-to-back; the directed reply fans out before the topic
            // registration lands) — so the phone also says hello on the agent
            // topic AFTER subscribing, and this reply can't miss.
            bus.publish({
              topic: 'agent', kind: 'brain-status',
              payload: { ready: true, activeTurnId: null },
              source: 'station', to: msg.source,
            });
            break;
          case 'transcript':
            if (p?.isFinal !== true) session(dock).preWarm();
            break;
          case 'turn-request':
            void session(dock).handleTurnRequest(p as unknown as TurnRequest).catch((err) => {
              console.error(`[brain] ${dock}: turn crashed`, err);
            });
            break;
          case 'turn-cancel':
            session(dock).cancel(typeof p?.turnId === 'string' ? p.turnId : undefined);
            break;
          case 'speech-status':
            session(dock).noteSpeech(p?.speaking === true);
            break;
          // 'tool-result' is consumed by the RpcBroker's own subscription
          default:
            break;
        }
      });

      // resync handshake + turn-abort on voice-component connectivity
      bus.on('station', (msg) => {
        if (msg.source !== 'station') return;
        const p = msg.payload as { id?: string; dock?: string; caps?: string[]; component?: string } | null;
        if (!p?.dock) return;
        if (msg.kind === 'peer-joined' && (p.caps ?? []).includes('voice')) {
          // best-effort (may race the peer's subscribe — the agent/hello
          // handler above is the guaranteed path)
          bus.publish({
            topic: 'agent', kind: 'brain-status',
            payload: { ready: true, activeTurnId: null },
            source: 'station', to: p.id,
          });
        }
        if (msg.kind === 'peer-left') {
          const s = sessions.get(p.dock);
          if (!s) return;
          // any component loss aborts in-flight tool RPCs for safety; voice
          // loss kills the turn itself (the conversation has no mouth).
          rpc.rejectAllForDock(p.dock, 'dock component went offline');
          s.onDockOffline();
        }
      });

      const sweep = setInterval(() => {
        for (const s of sessions.values()) s.maybeIdleClose();
      }, IDLE_SWEEP_MS);
      sweep.unref?.();
    },

    async route(ctx: RouteContext) {
      const { req, res, subPath } = ctx;
      if (req.method === 'GET' && subPath === '/docks') {
        const lanes = [...sessions.values()].map((s) => ({
          dock: s.dock, sessionId: s.sessionId ?? null,
          turnActive: s.turnActive, lastTurnEndedAt: s.lastTurnEndedAt,
          inflightToolCalls: rpc.inflight(s.dock),
        }));
        json(res, 200, lanes);
        return true;
      }
      let m = subPath.match(/^\/([^/]+)\/sessions$/);
      if (m && req.method === 'GET') {
        json(res, 200, store.sessions(decodeURIComponent(m[1]!)));
        return true;
      }
      m = subPath.match(/^\/([^/]+)\/history$/);
      if (m && req.method === 'GET') {
        const dock = decodeURIComponent(m[1]!);
        const open = store.openSession(dock);
        json(res, 200, open ? store.messages(dock, open.sessionId) : []);
        return true;
      }
      m = subPath.match(/^\/([^/]+)\/session\/end$/);
      if (m && req.method === 'POST') {
        const dock = decodeURIComponent(m[1]!);
        sessions.get(dock)?.endSession('console');
        json(res, 200, { ok: true });
        return true;
      }
      m = subPath.match(/^\/([^/]+)\/session\/([^/]+)\/resume$/);
      if (m && req.method === 'POST') {
        // session(dock) (not sessions.get): the lane may not exist yet after
        // a station restart — resuming must still work.
        const ok = session(decodeURIComponent(m[1]!)).resume(decodeURIComponent(m[2]!));
        json(res, ok ? 200 : 404, { ok });
        return true;
      }
      return false;
    },
  };
}

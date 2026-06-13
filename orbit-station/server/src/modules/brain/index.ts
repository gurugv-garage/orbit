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
 *   GET    /api/brain/docks                lanes + open session
 *   GET    /api/brain/keystatus            which API key the current model uses
 *   GET    /api/brain/:dock/sessions       session index (incl. summaries)
 *   GET    /api/brain/:dock/history        open session transcript
 *   POST   /api/brain/:dock/session/end    close now (next turn opens fresh)
 *   GET    /api/brain/:dock/skills         installed skills (name+description)
 *   POST   /api/brain/:dock/skills         install a SKILL.md ({ content })
 *   DELETE /api/brain/:dock/skills/:name   remove an installed skill
 */

import type { Bus } from '../../core/bus.js';
import { json } from '../../core/http.js';
import type { Hub } from '../../core/hub.js';
import type { RouteContext, StationModule } from '../../core/module.js';
import type { Directory } from '../docks/directory.js';
import type { MotionExecutor } from '../bodylink/motion.js';
import { getFaceTools } from '../perception/index.js';
import { RpcBroker } from './rpc.js';
import { DockBrainSession, type TurnRequest, keyStatusFor } from './session.js';
import { SessionStore } from './store.js';
import { installDockSkill, listDockSkills, removeDockSkill } from './skills.js';
import type { IncomingMessage } from 'node:http';

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
      // which API key the brain will use for the current model (name + set/unset
      // + the paid fallback) — surfaced in the console so the active key is
      // never a mystery.
      if (req.method === 'GET' && subPath === '/keystatus') {
        const model = typeof w.config('brainModel') === 'string' ? (w.config('brainModel') as string) : '';
        json(res, 200, keyStatusFor(model, w.config('brainAlwaysPaid') === true));
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
      // delete a specific session (transcript + index entry). Refuses the
      // currently-open one; the obs trace is dropped via the obs DELETE route.
      m = subPath.match(/^\/([^/]+)\/session\/([^/]+)$/);
      if (m && req.method === 'DELETE') {
        const dock = decodeURIComponent(m[1]!);
        const sid = decodeURIComponent(m[2]!);
        const r = store.delete(dock, sid);
        json(res, r === 'deleted' ? 200 : r === 'open' ? 409 : 404, { ok: r === 'deleted', reason: r });
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
      // ── skills (docs/SERVER-BRAIN-SELFMOD.md §1a) — per-dock install/list/remove.
      // The dock's NEXT session picks up an installed skill (loaded per turn).
      m = subPath.match(/^\/([^/]+)\/skills$/);
      if (m && req.method === 'GET') {
        json(res, 200, await listDockSkills(store.root, decodeURIComponent(m[1]!)));
        return true;
      }
      if (m && req.method === 'POST') {
        const dock = decodeURIComponent(m[1]!);
        try {
          const body = JSON.parse(await readBody(req)) as { content?: string };
          if (typeof body.content !== 'string' || body.content.trim().length === 0) {
            json(res, 400, { error: 'body.content (the SKILL.md text) is required' });
            return true;
          }
          const name = await installDockSkill(store.root, dock, body.content);
          json(res, 200, { ok: true, name });
        } catch (err) {
          json(res, 400, { error: String(err instanceof Error ? err.message : err) });
        }
        return true;
      }
      m = subPath.match(/^\/([^/]+)\/skills\/([^/]+)$/);
      if (m && req.method === 'DELETE') {
        const ok = await removeDockSkill(store.root, decodeURIComponent(m[1]!), decodeURIComponent(m[2]!));
        json(res, ok ? 200 : 404, { ok });
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

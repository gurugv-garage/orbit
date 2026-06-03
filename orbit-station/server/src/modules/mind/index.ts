/**
 * Mind module — STUB.
 *
 * Eventually: the station's awareness layer. It watches everything on the bus
 * (agent traces, config changes, body state, peer presence) and can *trigger*
 * things — nudge a dock, flag drift, surface a pattern. The plan deferred the
 * intelligence; for now mind only observes and keeps a small rolling activity
 * feed that the console can show, proving the wiring works end to end.
 *
 * It takes NO actions. When we give it teeth, it will publish on 'mind' with
 * kind 'trigger' and modules/peers will act on those. Today it only emits
 * 'observation' so the UI has something to render.
 */

import type { Bus, BusMessage } from '../../core/bus.js';
import { json } from '../../core/http.js';
import type { RouteContext, StationModule } from '../../core/module.js';

const FEED_MAX = 100;

export function mindModule(): StationModule {
  const feed: Array<{ ts: number; topic: string; kind: string; source: string }> = [];

  return {
    name: 'mind',
    topic: 'mind',
    description: 'station awareness (stub — observes the bus, takes no action yet)',

    init(bus: Bus) {
      // Watch everything except our own emissions.
      bus.on('*', (msg: BusMessage) => {
        if (msg.topic === 'mind') return;
        feed.push({ ts: msg.ts, topic: msg.topic, kind: msg.kind, source: msg.source });
        if (feed.length > FEED_MAX) feed.shift();
        // Surface a passive observation so the console can show mind is alive.
        // NO trigger/action — that's deliberately deferred.
        bus.publish({
          topic: 'mind',
          kind: 'observation',
          payload: { saw: { topic: msg.topic, kind: msg.kind, source: msg.source } },
          source: 'station',
        });
      });
    },

    async route(ctx: RouteContext) {
      if (ctx.subPath === '/feed' && ctx.req.method === 'GET') {
        json(ctx.res, 200, feed.slice().reverse());
        return true;
      }
      return false;
    },
  };
}

/**
 * Media module — an in-process WebRTC **SFU**. The dock app publishes ONE live
 * A/V stream (AEC'd mic + camera) to the station; this module ingests it and
 * fans it out to N browser viewers (and later other docks). It is the small
 * first step of the "media brain" that plan.md §5 defers to a sidecar — kept
 * light (pure-TS werift) and isolated so it can move out of process unchanged.
 *
 * **Process-portable by design:** this module touches the outside world ONLY via
 * the bus (`media` topic for signaling, `station` topic for peer-left teardown)
 * and an HTTP status route. No import of another module, no hub, no shared state.
 * The bus is the sole coupling, so the same files run behind a bus proxy in a
 * sidecar later (see the plan's "Design rule").
 *
 * Signaling rides the existing /ws on the `media` topic (generic publish/event):
 *
 *   dock → SFU:   producer-offer {streamId, sdp}   producer-ice {candidate}
 *   SFU → dock:   producer-answer {streamId, sdp}   producer-ice {candidate}   (directed `to: dockId`)
 *   browser→SFU:  viewer-ready {}   viewer-answer {sdp}   viewer-ice {candidate}
 *   SFU→browser:  viewer-offer {streamId, sdp}   viewer-ice {candidate}        (directed `to: browserId`)
 *   any → SFU:    bye {role}
 *
 * Media itself flows over the WebRTC/SRTP transports directly (dock↔SFU, SFU↔
 * browser) — only signaling is on the bus. The SFU is NOT a WS peer; it talks to
 * the bus in-process and the hub relays (honoring the directed `to` field).
 */

import type { Bus } from '../../core/bus.js';
import { json } from '../../core/http.js';
import type { RouteContext, StationModule } from '../../core/module.js';
import { Sfu } from './sfu.js';
import { tapFromEnv } from './tap.js';

export function mediaModule(): StationModule {
  let sfu: Sfu;

  return {
    name: 'media',
    topic: 'media',
    description: 'WebRTC live A/V SFU (dock → station → viewers)',

    init(bus: Bus) {
      // Optional processing tap. With MEDIA_SINK set (e.g. udp://127.0.0.1:5004)
      // every producer's media is forwarded to a sidecar for STT/vision/recording.
      // For SAME-BOX processing instead, swap tapFromEnv() for
      //   new InProcessTap((streamId, kind, rtp) => { /* your handler */ })
      // (import it from './tap.js'). See docs/MEDIA-PROCESSING.md.
      const tap = tapFromEnv() ?? undefined;

      // The SFU emits signaling by publishing directed `media` frames; the hub
      // delivers each to the addressed peer (dock or browser).
      sfu = new Sfu({
        signal: (kind, payload, to) =>
          bus.publish({ topic: 'media', kind, payload, source: 'station', to }),
        tap,
      });

      bus.on('media', (msg) => {
        if (msg.source === 'station') return; // ignore our own emissions
        const p = msg.payload as Record<string, unknown> | null;
        switch (msg.kind) {
          case 'producer-offer': sfu.onProducerOffer(msg.source, p); break;
          case 'producer-ice':   sfu.onProducerIce(msg.source, p); break;
          case 'viewer-ready':   sfu.onViewerReady(msg.source, p); break;
          case 'viewer-answer':  sfu.onViewerAnswer(msg.source, p); break;
          case 'viewer-ice':     sfu.onViewerIce(msg.source, p); break;
          case 'viewer-leave':   sfu.onViewerLeave(msg.source, p); break;
          case 'bye':            sfu.onBye(msg.source); break;
        }
      });

      // Browsers (and docks) don't always send `bye` — reap on disconnect.
      bus.on('station', (msg) => {
        if (msg.kind !== 'peer-left') return;
        const id = (msg.payload as { id?: string } | null)?.id;
        if (id) sfu.onBye(id);
      });
    },

    route(ctx: RouteContext) {
      const { req, res, subPath } = ctx;
      if (subPath === '/status' && req.method === 'GET') {
        json(res, 200, sfu.status());
        return true;
      }
      return false;
    },
  };
}

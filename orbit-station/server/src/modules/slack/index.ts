/**
 * Slack module — the dock HEARING Slack (inbound), via Socket Mode.
 *
 * Outbound Slack (post / upload / react) is the stateless `integrations/slack.ts`
 * helper the brain tools call directly. THIS module is the inbound side: it opens
 * a Socket Mode connection (when `SLACK_APP_TOKEN` is set) and receives messages
 * from every channel the bot can read.
 *
 * SCOPE (v1 — ingest only; RESPONDING IS PARKED until sending is stable):
 *   - It keeps a rolling feed + publishes every classified event on the `slack`
 *     bus topic, so the console/mind can see Slack is flowing.
 *   - Plain CHANNEL messages are recorded but otherwise IGNORED (we don't act,
 *     don't even wake the brain) — matches "hears any channel, processes none yet".
 *   - @MENTIONS and DMs are flagged (`forSession: true`) as the things we WILL
 *     route into the dock's live session later. For now we only mark + log them;
 *     the actual respond mechanics come in a follow-up once outbound is stable.
 *
 *   GET /api/slack/status   token presence + socket state + counts
 *   GET /api/slack/feed     the rolling recent-events feed (newest first)
 *
 * No `SLACK_APP_TOKEN` → the module is inert (status reports it), exactly like a
 * dock with no Slack configured.
 */

import type { Bus } from '../../core/bus.js';
import { json } from '../../core/http.js';
import type { RouteContext, StationModule } from '../../core/module.js';
import { slackEnabled, whoAmI } from '../../integrations/slack.js';
import { SlackSocket, slackAppToken, type SlackEvent } from '../../integrations/slack-socket.js';

const FEED_MAX = 100;

interface FeedItem {
  ts: number;
  kind: SlackEvent['kind'];
  channel: string;
  user: string;
  text: string;
  /** true for mention/dm — what we'll route to the session once responding lands. */
  forSession: boolean;
}

export function slackModule(): StationModule {
  const feed: FeedItem[] = [];
  let bus: Bus;
  let socket: SlackSocket | undefined;
  let socketState: 'off' | 'connecting' | 'connected' | 'disconnected' = 'off';
  let botUserId = '';
  const counts = { message: 0, mention: 0, dm: 0 };

  const record = (ev: SlackEvent): void => {
    const forSession = ev.kind === 'mention' || ev.kind === 'dm';
    counts[ev.kind]++;
    feed.push({ ts: Date.now(), kind: ev.kind, channel: ev.channel, user: ev.user, text: ev.text, forSession });
    if (feed.length > FEED_MAX) feed.shift();

    // Surface on the bus so the console/mind can see Slack traffic. Directed at
    // nobody — purely observational for now.
    bus.publish({
      topic: 'slack', kind: ev.kind,
      payload: { channel: ev.channel, user: ev.user, text: ev.text, ts: ev.ts, threadTs: ev.threadTs ?? null, forSession },
      source: 'station',
    });

    // RESPONDING IS PARKED. We only LOG intent here — no brain turn yet.
    //  - channel message: ignored on purpose (the dock hears it, does nothing).
    //  - mention / dm: this is where we'll route into the dock's live session
    //    once outbound is stable. Left as a marker so the wiring point is obvious.
    if (forSession) {
      console.log(`[slack] ${ev.kind} from ${ev.user} in ${ev.channel}: ${ev.text.slice(0, 120)} (respond: parked)`);
    }
  };

  return {
    name: 'slack',
    topic: 'slack',
    description: 'inbound Slack via Socket Mode (ingest only — responding parked)',

    async init(b: Bus) {
      bus = b;
      const appToken = slackAppToken();
      if (!appToken) {
        // No app token → inbound is off. (Outbound tools still work via the helper.)
        socketState = 'off';
        return;
      }
      if (!slackEnabled()) {
        console.log('[slack] SLACK_APP_TOKEN set but SLACK_BOT_TOKEN missing — inbound disabled');
        socketState = 'off';
        return;
      }
      // Learn the bot's own user id so we drop its own messages from the stream.
      try { botUserId = (await whoAmI()).userId; } catch (err) {
        console.log(`[slack] auth.test failed: ${String(err)} — inbound disabled`);
        socketState = 'off';
        return;
      }
      socket = new SlackSocket(appToken, {
        botUserId,
        onEvent: record,
        onStatus: (s) => { socketState = s; },
        log: (line) => console.log(line),
      });
      socketState = 'connecting';
      socket.start();
      console.log('[slack] Socket Mode starting (inbound ingest; responding parked)');
    },

    route(ctx: RouteContext) {
      const { req, res, subPath } = ctx;
      if (req.method === 'GET' && subPath === '/status') {
        json(res, 200, {
          botToken: slackEnabled(),
          appToken: slackAppToken() != null,
          socket: socketState,
          connected: socket?.connected ?? false,
          botUserId: botUserId || null,
          counts,
          note: 'inbound ingest only — channel msgs ignored; mentions/DMs flagged but responding is parked',
        });
        return true;
      }
      if (req.method === 'GET' && subPath === '/feed') {
        json(res, 200, feed.slice().reverse());
        return true;
      }
      return false;
    },
  };
}

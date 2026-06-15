/**
 * Slack module — the dock HEARING Slack (inbound), via Socket Mode.
 *
 * Outbound Slack (post / upload / react) is the stateless `integrations/slack.ts`
 * helper the brain tools call directly. THIS module is the inbound side: it opens
 * a Socket Mode connection (when `SLACK_APP_TOKEN` is set) and receives messages
 * from every channel the bot can read.
 *
 * SCOPE (v1 — the REAL respond-in-session logic is still parked):
 *   - It keeps a rolling feed + publishes every classified event on the `slack`
 *     bus topic, so the console/mind can see Slack is flowing.
 *   - Plain CHANNEL messages are recorded but otherwise IGNORED (we don't act,
 *     don't even wake the brain) — matches "hears any channel, processes none yet".
 *   - @MENTIONS and DMs get an immediate CANNED reply ("feature coming soon"),
 *     so the inbound→outbound loop is closed end to end. Routing them into the
 *     dock's live conversational session (a real answer) comes in a follow-up.
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
import { slackEnabled, whoAmI, postMessage } from '../../integrations/slack.js';
import { SlackSocket, slackAppToken, type SlackEvent } from '../../integrations/slack-socket.js';

const FEED_MAX = 100;

/** Placeholder reply sent when someone @mentions or DMs orbit, until the real
 *  respond-in-session logic lands. */
const CANNED_REPLY = 'Feature coming soon — will talk to you soon! 🛰️';

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

    // RESPONDING: routing into the dock's live session is still PARKED. For now,
    // a @mention or DM gets an immediate CANNED reply so the loop is closed end
    // to end (someone pings orbit → orbit answers). Plain channel messages stay
    // ignored. The real "respond in session" logic replaces this block later.
    if (forSession) {
      console.log(`[slack] ${ev.kind} from ${ev.user} in ${ev.channel}: ${ev.text.slice(0, 120)} → canned reply`);
      void autoReply(ev);
    }
  };

  /** Post the canned placeholder back where the message came from: into a DM
   *  channel as-is; in a channel, @mention the person and reply in-thread if the
   *  mention was threaded. Best-effort — a failure just logs. */
  async function autoReply(ev: SlackEvent): Promise<void> {
    try {
      const text = ev.kind === 'dm' ? CANNED_REPLY : `<@${ev.user}> ${CANNED_REPLY}`;
      await postMessage({
        channel: ev.channel,
        text,
        // keep a channel reply in the same thread; in a DM there are no threads.
        ...(ev.kind !== 'dm' ? { threadTs: ev.threadTs ?? ev.ts } : {}),
      });
    } catch (err) {
      console.log(`[slack] auto-reply failed: ${String(err)}`);
    }
  }

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
      console.log('[slack] Socket Mode starting (inbound; mentions/DMs get a canned reply)');
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
          note: 'channel msgs ignored; mentions/DMs get a canned reply (real session routing parked)',
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

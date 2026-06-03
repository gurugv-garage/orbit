/**
 * Module contract. orbit-station is a registry of modules; each owns a topic,
 * optionally some HTTP routes (REST/ingest), and reacts to the bus.
 *
 * A module is independent unless it explicitly subscribes to another's topic.
 * `mind` is the one designed to subscribe broadly.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Bus } from './bus.js';
import type { Topic } from './protocol.js';

export interface RouteContext {
  req: IncomingMessage;
  res: ServerResponse;
  /** Path after the module mount point, e.g. "/traces". Always starts with "/". */
  subPath: string;
  url: URL;
}

/** Return true if the route was handled. */
export type RouteHandler = (ctx: RouteContext) => boolean | Promise<boolean>;

export interface StationModule {
  /** kebab-case, also the HTTP mount: /api/<name>/... */
  name: string;
  /** The bus topic this module owns. */
  topic: Topic;
  /** One-line description for the /api/station/modules listing. */
  description: string;
  /** Called once at startup with the shared bus. */
  init(bus: Bus): void | Promise<void>;
  /** Optional HTTP handler under /api/<name>/. */
  route?: RouteHandler;
}

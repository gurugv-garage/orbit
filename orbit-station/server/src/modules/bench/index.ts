/**
 * Benchmark module — folds the dock-LLM benchmark viewer into the station.
 *
 * The viewer UI is served as a static page (public/modules/bench.html). This
 * module serves the snapshot data the viewer fetches:
 *   GET /api/bench/results/index.json   the snapshot list
 *   GET /api/bench/results/:file        one snapshot
 *   GET /api/bench/images/:file         case images referenced by snapshots
 *
 * Snapshot files are committed history (per CLAUDE.md), copied here from
 * node-dock/app/bench/results.
 */

import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { StationModule, RouteContext } from '../../core/module.js';

const DIR = fileURLToPath(new URL('.', import.meta.url));
const RESULTS = join(DIR, 'results');
const IMAGES = join(DIR, 'images');

const MIME: Record<string, string> = {
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
};

export function benchModule(): StationModule {
  return {
    name: 'bench',
    topic: 'station', // no live topic of its own; static data only
    description: 'dock-LLM benchmark viewer data (snapshots + images)',

    init() {
      /* static-only */
    },

    async route(ctx: RouteContext) {
      const { res, subPath } = ctx;
      const results = subPath.match(/^\/results\/(.+)$/);
      const images = subPath.match(/^\/images\/(.+)$/);
      const base = results ? RESULTS : images ? IMAGES : null;
      const name = (results ?? images)?.[1];
      if (!base || !name) return false;

      const file = join(base, normalize(name).replace(/^(\.\.[/\\])+/, ''));
      if (!file.startsWith(base)) {
        res.writeHead(403).end('forbidden');
        return true;
      }
      try {
        const body = await readFile(file);
        res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' });
        res.end(body);
      } catch {
        res.writeHead(404).end('not found');
      }
      return true;
    },
  };
}

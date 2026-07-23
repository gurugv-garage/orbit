/**
 * Data module — what orbit is storing on this machine, by use case.
 *
 * Scanning a few hundred thousand files is slow (seconds), and the answer is
 * rarely needed, so nothing runs at startup: the console shows the LAST scan
 * (cached to disk, so it survives a restart) and a "Calculate" button re-runs it.
 *
 *   GET  /api/data/            cached scan (or { rows: [], cached: false } if never run)
 *   POST /api/data/scan        run a scan now, cache it, return it
 *                              body: { only?: string[] } to rescan just some ids
 *
 * The inventory itself lives in inventory.ts — add a row there when a new
 * feature starts writing untracked bytes.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { dataPath } from '../../core/data-dir.js';
import type { IncomingMessage } from 'node:http';
import type { Bus } from '../../core/bus.js';
import { json } from '../../core/http.js';
import type { RouteContext, StationModule } from '../../core/module.js';
import { INVENTORY } from './inventory.js';
import { scanStorage, type ScanResult } from './scan.js';

/** Cached scan, under the shared station data root (core/data-dir.ts — never
 *  re-derive the `../` chain here; that drift is what created the second folder
 *  this module exists to report on). */
const CACHE_PATH = dataPath('storage-scan.json');

function readCache(): ScanResult | undefined {
  try {
    return JSON.parse(readFileSync(CACHE_PATH, 'utf8')) as ScanResult;
  } catch {
    return undefined;
  }
}

function writeCache(result: ScanResult): void {
  try {
    mkdirSync(dirname(CACHE_PATH), { recursive: true });
    writeFileSync(CACHE_PATH, JSON.stringify(result, null, 2));
  } catch (err) {
    console.error('[data] could not cache scan', err);
  }
}

export function dataModule(): StationModule {
  let cache = readCache();
  /** in-flight scan, so two clicks don't start two walks */
  let running: Promise<ScanResult> | undefined;

  async function scan(only?: string[]): Promise<ScanResult> {
    if (running) return running;
    running = (async () => {
      const fresh = await scanStorage(only);
      // A partial rescan patches the cached rows rather than replacing them,
      // so re-measuring one big folder doesn't throw away the rest.
      const merged: ScanResult =
        only?.length && cache
          ? {
              ...fresh,
              rows: cache.rows.map((old) => fresh.rows.find((r) => r.id === old.id) ?? old),
              totalBytes: 0,
            }
          : fresh;
      if (only?.length && cache) merged.totalBytes = merged.rows.reduce((n, r) => n + r.ownBytes, 0);
      cache = merged;
      writeCache(merged);
      console.log(
        `[data] scan ${only?.length ? `(${only.length} of ${INVENTORY.length})` : `(${INVENTORY.length} areas)`} ` +
          `→ ${(merged.totalBytes / 1e9).toFixed(2)} GB in ${fresh.durationMs}ms`,
      );
      return merged;
    })();
    try {
      return await running;
    } finally {
      running = undefined;
    }
  }

  return {
    name: 'data',
    topic: 'data',
    description: 'local storage inventory — what orbit keeps on disk, by use case (on-demand scan)',

    init(_bus: Bus) {
      /* nothing periodic — scanning is explicit, see POST /api/data/scan */
    },

    async route(ctx: RouteContext) {
      const { req, res, subPath } = ctx;

      if (subPath === '/' && req.method === 'GET') {
        json(res, 200, cache
          ? { ...cache, cached: true, scanning: Boolean(running) }
          : {
              cached: false,
              scanning: Boolean(running),
              root: '',
              scannedAt: 0,
              durationMs: 0,
              totalBytes: 0,
              // Still describe the inventory so the UI can render the rows greyed out.
              rows: INVENTORY.map((e) => ({
                ...e, abs: '', exists: false, bytes: 0, ownBytes: 0, files: 0, newest: 0, contains: [],
              })),
            });
        return true;
      }

      if (subPath === '/scan' && req.method === 'POST') {
        const body = JSON.parse((await readBody(req)) || '{}') as { only?: string[] };
        const only = Array.isArray(body.only) ? body.only.filter((s) => typeof s === 'string') : undefined;
        json(res, 200, { ...(await scan(only)), cached: false, scanning: false });
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

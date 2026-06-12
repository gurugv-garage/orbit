/**
 * Benchmark module — runs the dock-LLM suite against the SAME brain code the
 * live dock uses (modules/brain), and serves the snapshots a viewer reads.
 *
 *   GET  /api/bench/results/index.json   the snapshot list
 *   GET  /api/bench/results/:file        one snapshot
 *   GET  /api/bench/images/:file         case images referenced by snapshots
 *   GET  /api/bench/cases                the loaded case set (id/capability/prompt)
 *   GET  /api/bench/models               the configured model roster
 *   POST /api/bench/run  { models?, note? }  run + write a snapshot (streams
 *                          progress on the `station` topic, kind 'bench')
 *
 * Snapshots are committed history (CLAUDE.md). The runner writes new ones into
 * results/ and appends to index.json. Legacy snapshots (from the retired Kotlin
 * bench) keep rendering — the schema is frozen.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { IncomingMessage } from 'node:http';
import type { Bus } from '../../core/bus.js';
import { json } from '../../core/http.js';
import type { StationModule, RouteContext } from '../../core/module.js';
import { loadCases } from './cases.js';
import { runSuite } from './runner.js';
import type { BenchModelSpec, BenchProgress, Snapshot } from './types.js';

const DIR = fileURLToPath(new URL('.', import.meta.url));
const RESULTS = join(DIR, 'results');
const IMAGES = join(DIR, 'images');
const MODELS_FILE = join(DIR, 'models.json');

const MIME: Record<string, string> = {
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
};

/** The model roster (bench/models.json). resolveModel reads the `model` spec. */
function loadModels(): BenchModelSpec[] {
  try {
    return JSON.parse(readFileSync(MODELS_FILE, 'utf8')) as BenchModelSpec[];
  } catch {
    return [];
  }
}

export function benchModule(): StationModule {
  let bus: Bus;
  let running = false;

  function progress(p: BenchProgress): void {
    bus.publish({ topic: 'station', kind: 'bench', payload: p, source: 'station' });
  }

  async function appendIndex(file: string, snap: Snapshot): Promise<void> {
    let idx: Array<Record<string, unknown>> = [];
    try { idx = JSON.parse(await readFile(join(RESULTS, 'index.json'), 'utf8')); } catch { /* fresh */ }
    idx.unshift({ file, snapshot: snap.run.snapshot, ts: snap.run.ts, note: snap.run.note });
    await writeFile(join(RESULTS, 'index.json'), JSON.stringify(idx, null, 1));
  }

  return {
    name: 'bench',
    topic: 'station', // progress rides the station topic (kind 'bench')
    description: 'dock-LLM benchmark: run against the live brain code + snapshot viewer data',

    init(b: Bus) {
      bus = b;
    },

    async route(ctx: RouteContext) {
      const { req, res, subPath } = ctx;

      if (req.method === 'GET' && subPath === '/cases') {
        json(res, 200, loadCases().map((c) => ({
          id: c.id, capability: c.capability, prompt: c.prompt, note: c.note, image: c.image ?? null,
        })));
        return true;
      }
      if (req.method === 'GET' && subPath === '/models') {
        json(res, 200, loadModels());
        return true;
      }

      if (req.method === 'POST' && subPath === '/run') {
        if (running) { json(res, 409, { error: 'a benchmark is already running' }); return true; }
        const body = JSON.parse((await readBody(req)) || '{}') as { models?: string[]; note?: string };
        const allModels = loadModels();
        const models = body.models?.length
          ? allModels.filter((m) => body.models!.includes(m.name)) : allModels;
        if (!models.length) { json(res, 400, { error: 'no models selected/configured' }); return true; }

        const cases = loadCases();
        running = true;
        // respond immediately; the run streams progress + writes the snapshot.
        json(res, 202, { started: true, models: models.map((m) => m.name), cases: cases.length });
        void (async () => {
          progress({ kind: 'start', total: models.length * cases.length, models: models.map((m) => m.name), caseIds: cases.map((c) => c.id) });
          try {
            const snap = await runSuite({
              snapshot: `run-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}`,
              models, cases, note: body.note,
              hooks: {
                onCase: (model, caseId, passRate) => progress({ kind: 'case', model, caseId, done: 0, total: 0, passRate }),
                onGrading: (model) => progress({ kind: 'grading', model }),
              },
            });
            const file = `${snap.run.snapshot}.json`;
            await writeFile(join(RESULTS, file), JSON.stringify(snap, null, 1));
            await appendIndex(file, snap);
            progress({ kind: 'done', file });
          } catch (err) {
            progress({ kind: 'error', message: String(err) });
          } finally {
            running = false;
          }
        })();
        return true;
      }

      // ── static snapshot + image serving (unchanged) ──────────────────────
      const results = subPath.match(/^\/results\/(.+)$/);
      const images = subPath.match(/^\/images\/(.+)$/);
      const base = results ? RESULTS : images ? IMAGES : null;
      const name = (results ?? images)?.[1];
      if (!base || !name) return false;

      const file = join(base, normalize(name).replace(/^(\.\.[/\\])+/, ''));
      if (!file.startsWith(base)) { res.writeHead(403).end('forbidden'); return true; }
      // case images can also live under cases/images — fall through to it.
      const candidate = images && !existsSync(file) ? join(DIR, 'cases', 'images', name) : file;
      try {
        const buf = await readFile(candidate);
        res.writeHead(200, { 'content-type': MIME[extname(candidate)] ?? 'application/octet-stream' });
        res.end(buf);
      } catch {
        res.writeHead(404).end('not found');
      }
      return true;
    },
  };
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let d = '';
    req.on('data', (c) => (d += c));
    req.on('end', () => resolve(d));
    req.on('error', reject);
  });
}

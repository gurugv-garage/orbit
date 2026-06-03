/**
 * HTTP(S) server: serves the browser UI (public/) and routes /api/<module>/...
 * to the owning module. HTTPS when certs/ exists, else HTTP (dev fallback) so
 * the thing runs out of the box without cert setup.
 */

import { createServer as createHttp, type IncomingMessage, type ServerResponse } from 'node:http';
import { createServer as createHttps } from 'node:https';
import { readFile, stat } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { StationModule, RouteContext } from './module.js';

// this file: server/src/core/http.ts  → '../../' = server/  → '../../../' = orbit-station/
const SERVER_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const STATION_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
// Prod: serve the built React app (web/dist); the static bench viewer ships
// inside it. Dev: run Vite on :5173 and proxy /api + /ws to this server.
const PUBLIC = join(STATION_ROOT, 'web', 'dist');
const CERT_DIR = join(SERVER_ROOT, 'certs');

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
};

export function json(res: ServerResponse, status: number, body: unknown): void {
  const s = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(s);
}

export function createServer(modules: StationModule[]) {
  const handler = (req: IncomingMessage, res: ServerResponse) => {
    void route(req, res, modules);
  };

  const key = join(CERT_DIR, 'key.pem');
  const cert = join(CERT_DIR, 'cert.pem');
  if (existsSync(key) && existsSync(cert)) {
    return {
      server: createHttps({ key: readFileSync(key), cert: readFileSync(cert) }, handler),
      secure: true,
    };
  }
  return { server: createHttp(handler), secure: false };
}

async function route(req: IncomingMessage, res: ServerResponse, modules: StationModule[]): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const path = url.pathname;

  // /api/<module>/...
  if (path.startsWith('/api/')) {
    const rest = path.slice('/api/'.length);
    const slash = rest.indexOf('/');
    const name = slash === -1 ? rest : rest.slice(0, slash);
    const subPath = slash === -1 ? '/' : rest.slice(slash);
    const mod = modules.find((m) => m.name === name);
    if (mod?.route) {
      const ctx: RouteContext = { req, res, subPath, url };
      const handled = await mod.route(ctx);
      if (handled) return;
    }
    if (!res.writableEnded) json(res, 404, { error: `no api route for ${path}` });
    return;
  }

  await serveStatic(path, res);
}

async function serveStatic(path: string, res: ServerResponse): Promise<void> {
  const rel = path === '/' ? '/index.html' : path;
  // prevent path traversal
  const safe = normalize(rel).replace(/^(\.\.[/\\])+/, '');
  const file = join(PUBLIC, safe);
  if (!file.startsWith(PUBLIC)) {
    res.writeHead(403).end('forbidden');
    return;
  }
  try {
    const s = await stat(file);
    if (s.isDirectory()) return serveStatic(join(path, 'index.html'), res);
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' });
    res.end(body);
  } catch {
    // SPA fallback: an extensionless path that doesn't exist on disk is a
    // client route → serve index.html. A missing asset (has an extension) 404s.
    if (!extname(safe) && existsSync(join(PUBLIC, 'index.html'))) {
      const body = await readFile(join(PUBLIC, 'index.html'));
      res.writeHead(200, { 'content-type': MIME['.html']! });
      res.end(body);
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
  }
}

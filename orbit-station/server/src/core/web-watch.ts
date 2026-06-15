/**
 * Dev-only: the server owns the web build watcher.
 *
 * In dev the Node server SERVES the React UI from web/dist (see core/http.ts), so
 * that folder has to be kept fresh as you edit web code. The norm for a
 * single-server-serves-built-UI setup is: the server spawns the bundler's watch
 * as a CHILD it owns — not a sibling glued on by `concurrently`. That collapses
 * the dev process tree (no concurrently, no extra npm wrapper) so the listener is
 * one hop below `tsx watch`, and Ctrl-C / a tsx reload reaches it cleanly instead
 * of orphaning a server that keeps holding the port.
 *
 * Started from main() only when STATION_WEB_WATCH=1 (the `dev` script sets it);
 * production `start` never calls it. The child is killed on server shutdown.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const WEB_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'web');

let child: ChildProcess | undefined;

/** Spawn `vite build --watch` in web/, inheriting our stdio so its rebuild logs
 *  interleave with the server's. Returns a stop() that kills the child. No-op if
 *  already running. */
export function startWebWatch(): () => void {
  if (child) return stopWebWatch;
  // `npm exec` resolves the workspace-local vite without hardcoding a path — but
  // that means our direct child is the `npm` wrapper, and SIGTERM to npm is NOT
  // forwarded to the vite→esbuild it spawned. So `detached: true` puts the whole
  // chain in its own process group, and stopWebWatch() signals the group (not just
  // npm) — otherwise vite + esbuild orphan on every reload and pile up.
  child = spawn('npm', ['exec', '--', 'vite', 'build', '--watch'], {
    cwd: WEB_DIR,
    stdio: ['ignore', 'inherit', 'inherit'],
    env: process.env,
    detached: true,
  });
  child.on('exit', (code) => {
    if (code && code !== 0) console.error(`[web-watch] vite exited with code ${code}`);
    child = undefined;
  });
  console.log('  web     vite build --watch (server-owned child)');
  return stopWebWatch;
}

/** Kill the web-watch child if running (called from the server's shutdown).
 *  Signals the whole process group (negative pid) so vite + esbuild die with the
 *  npm wrapper instead of orphaning. Falls back to a plain child kill if the pid
 *  is gone or group signalling isn't supported. */
export function stopWebWatch(): void {
  if (!child) return;
  const pid = child.pid;
  try {
    if (pid) process.kill(-pid, 'SIGTERM'); // -pid = the child's process group
    else child.kill('SIGTERM');
  } catch {
    try { child.kill('SIGTERM'); } catch { /* gone */ }
  }
  child = undefined;
}

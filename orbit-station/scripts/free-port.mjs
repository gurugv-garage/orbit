#!/usr/bin/env node
/**
 * Free the dev port before `npm run dev` starts — so a leftover server from a
 * previous run (orphaned when a deep npm/concurrently/tsx-watch tree didn't
 * propagate the kill signal) never crashes the new one with EADDRINUSE.
 *
 * Best-effort + cross-platform-ish: finds the PID listening on the port and
 * SIGTERMs it, then SIGKILLs if it lingers. No-op when the port is free.
 *
 * Usage: node scripts/free-port.mjs [port]   (default 8099)
 */
import { execSync } from 'node:child_process';

const port = Number(process.argv[2] || process.env.PORT || 8099);

function pidsOnPort(p) {
  try {
    // -t = terse (pids only); LISTEN only so we don't kill clients
    const out = execSync(`lsof -tiTCP:${p} -sTCP:LISTEN`, { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString().trim();
    return out ? out.split('\n').map((s) => Number(s.trim())).filter(Boolean) : [];
  } catch {
    return []; // lsof exits non-zero when nothing matches
  }
}

const pids = pidsOnPort(port);
if (pids.length === 0) {
  process.exit(0); // port already free — the normal case
}

console.log(`[free-port] port ${port} held by pid(s) ${pids.join(', ')} — terminating a stale dev server`);
for (const pid of pids) {
  try { process.kill(pid, 'SIGTERM'); } catch { /* gone */ }
}

// give them ~1.5s to exit cleanly, then force any survivors
const deadline = Date.now() + 1500;
while (Date.now() < deadline && pidsOnPort(port).length > 0) {
  // tiny busy-wait (sync; this script is short-lived)
  try { execSync('sleep 0.1'); } catch { /* */ }
}
for (const pid of pidsOnPort(port)) {
  try { process.kill(pid, 'SIGKILL'); } catch { /* */ }
}

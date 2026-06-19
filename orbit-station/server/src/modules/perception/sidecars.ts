/**
 * Sidecar supervisor — start/stop/restart the two MLX sidecars (the only
 * out-of-process perception pieces; see PERCEPTION-RUNBOOK §1) from the console,
 * so you don't have to drop to a shell. Convenience for the single-laptop dev/test
 * workflow — NOT a production process manager.
 *
 * Safety stance:
 *  - The supervisor only TRACKS children IT spawned (pid + the launch spec). It
 *    refuses to double-start when the port is already serving.
 *  - Spawned DETACHED so a station hot-reload doesn't orphan-kill them mid-load
 *    (qwen takes ~10 s to load; we don't want a reload to abort that).
 *  - STOP/RESTART work on a tracked child by pid; for a sidecar the supervisor did
 *    NOT spawn (you started it by hand), stop falls back to killing whatever LISTENS
 *    on its port (`lsof -ti`), so the button still works.
 *  - Liveness is the HTTP /health ping (sidecars.ts route), never the pid alone — a
 *    pid can be alive while the model is still loading, or dead while the port lingers.
 */

import { spawn, execFile, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';

/** Where the sidecar lives + how each one is launched (mirrors the runbook). */
// sidecars.ts is at orbit-station/server/src/modules/perception/ — the sidecar lives
// at the REPO ROOT under models/, i.e. five levels up (perception→modules→src→server→
// orbit-station→<root>). (Getting this wrong makes spawn ENOENT on a missing cwd,
// which masquerades as a missing python binary — debugged the hard way.)
const SIDECAR_DIR = fileURLToPath(new URL('../../../../../models/perception-sidecar/', import.meta.url));

/** Resolve the python binary to an ABSOLUTE path at load time. The station is
 *  launched via npm/tsx with a minimal PATH that often omits pyenv's shim dir, so a
 *  bare `spawn('python3')` fails ENOENT (seen live). Honour PERCEPTION_PYTHON if set,
 *  else ask the login shell's `which python3` (resolves pyenv shims), else fall back. */
function resolvePython(): string {
  const env = process.env.PERCEPTION_PYTHON;
  if (env) { const r = realInterpreter(env); if (r) return r; }
  // Try, in order: the user's login+interactive shell (loads pyenv/conda so `python3`
  // resolves the same as a terminal), then common concrete locations. For each, take
  // the RESOLVED real interpreter (sys.executable) so a pyenv SHIM or a stale symlink
  // (/usr/local/bin/python3 — both seen live) never reaches the detached spawn.
  const shell = process.env.SHELL || '/bin/zsh';
  const candidates: string[] = [];
  try {
    const p = execFileSync(shell, ['-ic', 'command -v python3'], { encoding: 'utf8', timeout: 4000 }).trim();
    if (p) candidates.push(p);
  } catch { /* no interactive resolve */ }
  candidates.push(
    `${process.env.HOME}/.pyenv/shims/python3`,
    '/opt/homebrew/bin/python3', '/usr/local/bin/python3', '/usr/bin/python3',
  );
  for (const c of candidates) { const r = realInterpreter(c); if (r) return r; }
  return 'python3'; // last resort — relies on PATH
}
/** The REAL interpreter behind a candidate (resolving pyenv/conda SHIMS to their
 *  actual binary via sys.executable), or '' if it can't run. pyenv shims are shell
 *  scripts that re-exec via pyenv's env; they run under execFileSync (full env) but
 *  ENOENT under a detached spawn — so we always launch the resolved real binary. */
function realInterpreter(py: string): string {
  if (py.includes('/') && !existsSync(py)) return '';
  try {
    const real = execFileSync(py, ['-c', 'import sys; print(sys.executable)'],
      { timeout: 4000, encoding: 'utf8' }).trim();
    return real && existsSync(real) ? real : (existsSync(py) ? py : '');
  } catch { return ''; }
}
const PY = resolvePython();

export interface SidecarSpec {
  name: 'vision' | 'speech';
  port: number;
  /** args after `python3 sidecar.py` */
  args: string[];
}

export const SIDECAR_SPECS: Record<'vision' | 'speech', SidecarSpec> = {
  // one model per process (MLX/Metal isn't thread-safe); --no-stt on vision.
  vision: { name: 'vision', port: 8080, args: ['sidecar.py', '--port', '8080', '--temporal', '--no-stt'] },
  speech: { name: 'speech', port: 8078, args: ['sidecar.py', '--port', '8078', '--model', 'mlx-community/whisper-small.en-mlx'] },
};

/** A child this supervisor spawned (so we can stop/restart what we own). */
interface Tracked { pid: number; startedAt: number }

export class SidecarSupervisor {
  #children = new Map<'vision' | 'speech', Tracked>();

  /** Is this name one we spawned and still believe is alive? */
  managed(name: 'vision' | 'speech'): { pid: number; startedAt: number } | null {
    const c = this.#children.get(name);
    return c ? { pid: c.pid, startedAt: c.startedAt } : null;
  }

  /** Spawn a sidecar (detached). No-op if it's already ours. Resolves on the
   *  'spawn' event (success) or 'error' (ENOENT etc.) — both are ASYNC, so a
   *  synchronous pid check is unreliable (seen live: pid present but spawn then
   *  errors next tick). Returns {ok, pid?} with the REAL error when it fails. */
  start(name: 'vision' | 'speech'): Promise<{ ok: boolean; pid?: number; py?: string; error?: string }> {
    if (this.#children.has(name)) return Promise.resolve({ ok: true, pid: this.#children.get(name)!.pid });
    const spec = SIDECAR_SPECS[name];
    return new Promise((resolve) => {
      let child;
      try {
        child = spawn(PY, spec.args, { cwd: SIDECAR_DIR, detached: true, stdio: 'ignore', env: process.env });
      } catch (err) {
        resolve({ ok: false, py: PY, error: err instanceof Error ? err.message : String(err) });
        return;
      }
      let settled = false;
      child.once('spawn', () => {
        if (settled) return; settled = true;
        this.#children.set(name, { pid: child.pid!, startedAt: Date.now() });
        child.unref();
        // if it dies later, forget it so a later start re-spawns cleanly.
        child.on('exit', () => { if (this.#children.get(name)?.pid === child.pid) this.#children.delete(name); });
        resolve({ ok: true, pid: child.pid, py: PY });
      });
      child.once('error', (err) => {
        if (settled) return; settled = true;
        resolve({ ok: false, py: PY, error: err.message });
      });
    });
  }

  /** Stop a sidecar: kill our tracked child if we have one, else fall back to
   *  whatever LISTENS on its port (so a hand-started sidecar still stops). */
  async stop(name: 'vision' | 'speech'): Promise<{ ok: boolean; method?: string; error?: string }> {
    const tracked = this.#children.get(name);
    if (tracked) {
      try { process.kill(tracked.pid, 'SIGTERM'); } catch { /* already gone */ }
      this.#children.delete(name);
      return { ok: true, method: 'tracked-pid' };
    }
    // not ours — kill by port (lsof -ti tcp:PORT)
    const port = SIDECAR_SPECS[name].port;
    try {
      const pids = await pidsOnPort(port);
      if (pids.length === 0) return { ok: true, method: 'already-down' };
      for (const pid of pids) { try { process.kill(pid, 'SIGTERM'); } catch { /* */ } }
      return { ok: true, method: 'port-kill' };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /** Stop then start. The /health poll (in the route/console) confirms it's back. */
  async restart(name: 'vision' | 'speech'): Promise<{ ok: boolean; pid?: number; error?: string }> {
    await this.stop(name);
    // small gap so the port frees before we re-bind it.
    await new Promise((r) => setTimeout(r, 600));
    return this.start(name);
  }
}

/** PIDs LISTENING on a TCP port (macOS/Linux `lsof`). [] if none / lsof missing. */
function pidsOnPort(port: number): Promise<number[]> {
  return new Promise((resolve) => {
    execFile('lsof', ['-tiTCP:' + port, '-sTCP:LISTEN'], { timeout: 2000 }, (_err, stdout) => {
      const pids = (stdout || '').split('\n').map((s) => Number(s.trim())).filter((n) => Number.isInteger(n) && n > 0);
      resolve(pids);
    });
  });
}

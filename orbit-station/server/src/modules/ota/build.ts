/**
 * tmux-backed build runner. See docs/ota.md §2.4.
 *
 * A build is NOT a detached child of the Node process (a black box when it
 * hangs). It runs in a NAMED tmux session so a human can `tmux attach` to the
 * live toolchain output and re-run by hand on failure. The session lingers on
 * exit (the hook script ends with `exec bash`) so a failed build leaves an
 * attachable shell sitting in the build dir.
 *
 * This module: launches the session, watches it (poll `has-session` + tail the
 * log), and reports `progress {phase:"building"}` while it runs, then a
 * completion callback with the exit status + log tail.
 */

import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import type { OtaTarget } from './store.js';

const STATION_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
/** The hook scripts the build sessions run. docs/ota.md §2.3. */
const HOOK = (target: OtaTarget) => join(STATION_ROOT, 'scripts', `build-${target}.sh`);

export const sessionName = (target: OtaTarget) => `ota-build-${target}`;
export const attachCmd = (target: OtaTarget) => `tmux attach -t ${sessionName(target)}`;

function sh(cmd: string, args: string[]): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    const p = spawn(cmd, args);
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (out += d));
    p.on('close', (code) => resolve({ code: code ?? -1, out }));
    p.on('error', () => resolve({ code: -1, out }));
  });
}

export async function tmuxAvailable(): Promise<boolean> {
  return (await sh('tmux', ['-V'])).code === 0;
}

/** True if a tmux session for this target exists at all (running OR lingering). */
async function hasSession(target: OtaTarget): Promise<boolean> {
  return (await sh('tmux', ['has-session', '-t', sessionName(target)])).code === 0;
}

/**
 * True only if a build is ACTIVELY running. A finished build's session lingers
 * (it ends in `exec bash` so you can attach to debug — docs/ota.md §2.4), so
 * "session exists" alone over-reports. We treat a session whose tmux pane
 * already shows the "[exit N]" marker as NOT running — it's just lingering.
 */
export async function isRunning(target: OtaTarget): Promise<boolean> {
  if (!(await hasSession(target))) return false;
  // capture the pane; if it carries the exit marker, the build is done.
  const pane = await sh('tmux', ['capture-pane', '-p', '-t', sessionName(target)]);
  return !/\[exit -?\d+\]/.test(pane.out);
}

/** Kill a lingering (finished) session so a fresh build can take the name. */
export async function killSession(target: OtaTarget): Promise<void> {
  await sh('tmux', ['kill-session', '-t', sessionName(target)]);
}

export interface BuildCallbacks {
  /** Emitted periodically while building, with the latest log tail. */
  onTail: (tail: string) => void;
  /** Build finished (session ended). ok = exit 0 AND artifact present. */
  onDone: (ok: boolean, exitCode: number, logTail: string) => void;
}

/** Last N lines of a file (for the live tail + completion summary). */
function tailFile(path: string, n = 12): string {
  if (!existsSync(path)) return '';
  const lines = readFileSync(path, 'utf8').split('\n');
  return lines.slice(-n).join('\n');
}

/**
 * Launch a build in its tmux session and watch it to completion. Resolves the
 * moment the session is launched (not when the build finishes) so the caller
 * can return to the HTTP request immediately; completion arrives via callbacks.
 *
 * Returns { started, session, attach, log } or { started:false, error } if the
 * hook is missing / tmux unavailable / a build is already running.
 */
export async function launchBuild(
  target: OtaTarget,
  logPath: string,
  cb: BuildCallbacks,
): Promise<{ started: boolean; session: string; attach: string; log: string; error?: string }> {
  const session = sessionName(target);
  const attach = attachCmd(target);
  const result = { started: false, session, attach, log: logPath };

  if (!(await tmuxAvailable())) return { ...result, error: 'tmux not installed on the station host' };
  if (await isRunning(target)) return { ...result, error: 'a build is already running for this target' };
  if (!existsSync(HOOK(target))) return { ...result, error: `build hook missing: ${HOOK(target)}` };
  // A finished build's session lingers for debugging (§2.4). Reap it so this
  // fresh build can take the session name — isRunning already confirmed it's
  // not actively building.
  await killSession(target);

  // The session: run the hook, tee to the log, then APPEND the exit marker to
  // the SAME log (not just the pane) — the watch loop tails the log for it.
  // Finally drop into a lingering shell so a failed build is inspectable on
  // attach (docs/ota.md §2.4).
  const inner =
    `bash ${HOOK(target)} 2>&1 | tee ${logPath}; ` +
    `echo "[exit \${PIPESTATUS[0]}] — session stays open for inspection" | tee -a ${logPath}; ` +
    `exec bash`;
  const launch = await sh('tmux', ['new-session', '-d', '-s', session, 'bash', '-lc', inner]);
  if (launch.code !== 0) return { ...result, error: `tmux launch failed: ${launch.out.trim()}` };

  // Watch loop: poll the session; tail the log for progress. When the hook
  // finishes, the log carries the "[exit N]" marker even though the shell
  // lingers — that's our completion signal (we don't wait for the human to
  // close the session).
  const poll = setInterval(async () => {
    const tail = tailFile(logPath);
    cb.onTail(tail);
    const exitMatch = tail.match(/\[exit (-?\d+)\]/);
    if (exitMatch) {
      clearInterval(poll);
      const exitCode = Number(exitMatch[1]);
      cb.onDone(exitCode === 0, exitCode, tail);
    } else if (!(await isRunning(target))) {
      // session gone without an exit marker (killed/crashed) — treat as failure.
      clearInterval(poll);
      cb.onDone(false, -1, tail || 'build session ended unexpectedly');
    }
  }, 1500);

  return { ...result, started: true };
}

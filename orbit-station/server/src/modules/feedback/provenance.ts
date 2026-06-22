/**
 * Build/version provenance — captured once at module init (git is a process
 * spawn; the SHA doesn't change while the station runs) and reused for every
 * feedback. App + firmware versions arrive per-capture (from the phone's
 * clientContext / the OTA registry) and are merged in by the bundler.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export interface StationProvenance {
  gitSha?: string;
  gitBranch?: string;
  dirty?: boolean;
  version?: string;
  node: string;
}

function git(args: string[]): string | undefined {
  try {
    return execFileSync('git', args, { encoding: 'utf8', timeout: 2000 }).trim();
  } catch {
    return undefined;
  }
}

let cached: StationProvenance | undefined;

/** The station's own build provenance (cached for the process lifetime). */
export function stationProvenance(): StationProvenance {
  if (cached) return cached;
  let version: string | undefined;
  try {
    const pkg = JSON.parse(readFileSync(fileURLToPath(new URL('../../../package.json', import.meta.url)), 'utf8'));
    version = typeof pkg.version === 'string' ? pkg.version : undefined;
  } catch { /* no package.json version */ }
  const status = git(['status', '--porcelain']);
  cached = {
    gitSha: git(['rev-parse', 'HEAD']),
    gitBranch: git(['rev-parse', '--abbrev-ref', 'HEAD']),
    dirty: status != null ? status.length > 0 : undefined,
    version,
    node: process.version,
  };
  return cached;
}

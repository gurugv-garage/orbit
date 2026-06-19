/**
 * OTA artifact store — the on-disk source of truth for "what's the latest"
 * per target. See docs/ota.md §2.1 + §3.3.
 *
 *   var/ota/
 *     body/  firmware.bin  meta.json
 *     app/   app.apk        meta.json
 *
 * meta.json (written by the build hooks, never hand-typed):
 *   { target, build, version, sha256, size, builtAt }
 *
 * `build` (monotonic int) is the ONLY field the OTA comparator reads; `version`
 * is the human label; `sha256` is the integrity the device checks before boot.
 */

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export type OtaTarget = 'body' | 'app';

export interface OtaMeta {
  target: OtaTarget;
  /** monotonic compare integer — the gate AND the device's wire identity. */
  build: number;
  /**
   * Station-owned build metadata (devices never send these — docs/ota.md §3):
   *   version — human label (SemVer-ish), optional
   *   notes   — release details entered at build time
   *   builtAt — ISO timestamp the artifact was produced
   */
  version: string;
  notes?: string;
  sha256: string;
  size: number;
  builtAt: string;
}

/** The artifact filename per target (matches the REST download path). */
export const ARTIFACT_FILE: Record<OtaTarget, string> = {
  body: 'firmware.bin',
  app: 'app.apk',
};

// server/src/modules/ota/store.ts → '../../../../' = orbit-station/
const STATION_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const OTA_DIR = join(STATION_ROOT, 'var', 'ota');

export class OtaStore {
  constructor(private readonly root = OTA_DIR) {
    mkdirSync(join(root, 'body'), { recursive: true });
    mkdirSync(join(root, 'app'), { recursive: true });
  }

  dir(target: OtaTarget): string {
    return join(this.root, target);
  }

  artifactPath(target: OtaTarget): string {
    return join(this.dir(target), ARTIFACT_FILE[target]);
  }

  metaPath(target: OtaTarget): string {
    return join(this.dir(target), 'meta.json');
  }

  logPath(target: OtaTarget, build: number): string {
    return join(this.dir(target), `build-${build}.log`);
  }

  /** Current artifact meta, or null if nothing built/dropped yet. */
  meta(target: OtaTarget): OtaMeta | null {
    const p = this.metaPath(target);
    if (!existsSync(p)) return null;
    try {
      const m = JSON.parse(readFileSync(p, 'utf8')) as OtaMeta;
      // sanity: the recorded artifact must actually be on disk.
      if (!existsSync(this.artifactPath(target))) return null;
      return m;
    } catch {
      return null;
    }
  }

  /**
   * Recompute meta from the artifact on disk (size + sha256), merging the
   * caller-supplied build/version. Used by the build hook completion so meta
   * can never disagree with the bytes. Returns the written meta.
   */
  recordFromArtifact(target: OtaTarget, build: number, version: string, notes?: string): OtaMeta {
    const file = this.artifactPath(target);
    const buf = readFileSync(file);
    const meta: OtaMeta = {
      target,
      build,
      version,
      ...(notes ? { notes } : {}),
      sha256: createHash('sha256').update(buf).digest('hex'),
      size: statSync(file).size,
      builtAt: new Date().toISOString(),
    };
    // written atomically enough for a single-writer station
    writeFileSync(this.metaPath(target), JSON.stringify(meta, null, 2));
    return meta;
  }
}

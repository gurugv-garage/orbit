/**
 * The storage inventory — the declared list of places orbit writes bytes that
 * git does not track. Each entry is one "use case" row in the Data console.
 *
 * Paths are resolved relative to the REPO ROOT — five levels up from this file
 * (modules/data → modules → src → server → orbit-station → repo root).
 * A missing path is not an error; it scans as 0 bytes / `exists: false`.
 */

import { fileURLToPath } from 'node:url';

/** Repo root, resolved from this module's own location (cwd-independent). */
export const REPO_ROOT = fileURLToPath(new URL('../../../../../', import.meta.url));

export type Area = 'runtime' | 'media' | 'models' | 'build' | 'scratch';

export interface StorageEntry {
  /** stable id — also the REST scan key */
  id: string;
  /** human label for the row */
  label: string;
  /** grouping bucket in the UI */
  area: Area;
  /** repo-root-relative path */
  path: string;
  /** what accumulates here, and what it costs to delete it */
  note: string;
  /** true when the bytes are regenerable/disposable (UI shows a 🧹 hint) */
  disposable?: boolean;
}

/**
 * Ordered roughly by "how likely this is what's eating the disk".
 * Keep in sync with the .gitignore — everything here MUST be untracked.
 */
export const INVENTORY: StorageEntry[] = [
  // ---- runtime: what the station accumulates while it runs ----
  {
    id: 'utterance-audio',
    label: 'Utterance audio',
    area: 'media',
    path: 'orbit-station/.data/utterance-audio',
    note: 'Per-utterance WAV clips kept for the recall record and re-transcribe.',
    disposable: true,
  },
  {
    id: 'enrich-audio',
    label: 'Enricher audio',
    area: 'media',
    path: 'orbit-station/.data/enrich-audio',
    note: 'Audio handed to the background enricher / diarized re-transcribe.',
    disposable: true,
  },
  {
    id: 'captures',
    label: 'Captures (A/V replay)',
    area: 'media',
    path: 'orbit-station/server/data/captures',
    note: 'Recorded dock A/V + snapshots for the capture-judging harness.',
    disposable: true,
  },
  {
    id: 'voice-clips',
    label: 'Voice clips',
    area: 'media',
    path: 'orbit-station/server/data/voice-clips',
    note: 'Speaker-fingerprint reference clips behind the voice gallery.',
  },
  {
    id: 'turn-images',
    label: 'Turn images',
    area: 'media',
    path: 'orbit-station/.data/turn-images',
    note: 'Frames attached to a turn, shown in the observability trace.',
    disposable: true,
  },
  {
    id: 'req-images',
    label: 'Request images',
    area: 'media',
    path: 'orbit-station/.data/req-images',
    note: 'Images as sent to the LLM, kept by the obs request ring.',
    disposable: true,
  },
  {
    id: 'brain',
    label: 'Brain sessions',
    area: 'runtime',
    path: 'orbit-station/.data/brain',
    note: 'Persisted bounded pi sessions per dock, plus per-dock skills.',
  },
  {
    id: 'perception',
    label: 'Perception snapshots',
    area: 'runtime',
    path: 'orbit-station/.data/perception',
    note: 'The durable perception record (day-bucketed JSONL + span-summaries) — the dock\'s memory of what it saw and heard.',
  },
  {
    id: 'ego',
    label: 'Ego documents',
    area: 'runtime',
    path: 'orbit-station/.data/ego',
    note: 'Per-dock ego document + introspection trace.',
  },
  {
    id: 'feedback',
    label: 'Feedback dumps',
    area: 'runtime',
    path: 'orbit-station/.data/feedback',
    note: 'One markdown debugging dump per flagged session.',
  },
  {
    id: 'search',
    label: 'Search index',
    area: 'runtime',
    path: 'orbit-station/.data/search',
    note: 'Search/embedding index over the recall record.',
    disposable: true,
  },
  {
    id: 'browser',
    label: 'Browser profile',
    area: 'runtime',
    path: 'orbit-station/.data/browser',
    note: 'Headless browser profile/cache for the browse tool.',
    disposable: true,
  },
  {
    id: 'debug',
    label: 'Debug dumps',
    area: 'runtime',
    path: 'orbit-station/server/var/debug',
    note: 'Face-tracking and ad-hoc debug frame dumps.',
    disposable: true,
  },
  {
    id: 'galleries',
    label: 'Face + voice galleries',
    area: 'runtime',
    path: 'orbit-station/server/data',
    note: 'Identity galleries (JSON). Sized as the data dir minus its subfolders.',
  },
  {
    id: 'orbit-db',
    label: 'orbit.db (SQLite)',
    area: 'runtime',
    path: 'orbit-station/.data/orbit.db',
    note: 'THE shared store — obs traces, config, conv-events, dock bindings. Live; never delete.',
  },
  {
    id: 'orbit-db-wal',
    label: 'orbit.db WAL',
    area: 'runtime',
    path: 'orbit-station/.data/orbit.db-wal',
    note: 'Write-ahead log; checkpoints back into orbit.db. Grows between checkpoints.',
  },
  {
    id: 'station-skills',
    label: 'Station skills',
    area: 'runtime',
    path: 'orbit-station/.data/skills',
    note: 'Installed skill packages (pi Skills surface), incl. their vendored deps.',
  },
  {
    id: 'db-backup',
    label: 'orbit.db pre-wipe backup',
    area: 'scratch',
    path: 'orbit-station/.data/orbit.db.bak-pre-wipe',
    note: 'One-off manual backup taken before a wipe. Delete once you trust the live db.',
    disposable: true,
  },
  {
    id: 'docks-registry',
    label: 'Dock registry',
    area: 'runtime',
    path: 'orbit-station/.data/docks.json',
    note: 'The known docks and their components — the registry the console lists.',
  },
  {
    id: 'data-archives',
    label: '.data archives + remainder',
    area: 'scratch',
    path: 'orbit-station/.data',
    note:
      'THE station data root (one folder since the 2026-07-23 merge — see core/data-dir.ts). ' +
      'Everything above is a row of its own; this remainder is the _archive/_mix_arch folders.',
  },

  // ---- models: fetched weights, never committed ----
  {
    id: 'models-eou',
    label: 'EOU POC models',
    area: 'models',
    path: 'models/eou-poc',
    note: 'End-of-utterance POC weights. Parked work — safe to delete and refetch.',
    disposable: true,
  },
  {
    id: 'models-embed',
    label: 'Embedding models',
    area: 'models',
    path: 'orbit-station/server/models',
    note: 'Local embedding weights used by the search index.',
    disposable: true,
  },
  {
    id: 'models-perception',
    label: 'Perception sidecar models',
    area: 'models',
    path: 'models/perception-sidecar',
    note: 'Speaker-embedding ONNX etc. Refetchable from sherpa-onnx releases.',
    disposable: true,
  },
  {
    id: 'models-other',
    label: 'Other models',
    area: 'models',
    path: 'models',
    note: 'Whole models root — moondream, addressed-sidecar, and the rest.',
  },

  // ---- build + distribution artifacts ----
  {
    id: 'ota',
    label: 'OTA payloads',
    area: 'build',
    path: 'orbit-station/var/ota',
    note: 'Served APK + firmware binaries and their build logs.',
    disposable: true,
  },
  {
    id: 'app-build',
    label: 'Android build output',
    area: 'build',
    path: 'node-dock/app/app/build',
    note: 'Gradle :app build dir. Regenerated by ./gradlew :app:installDebug.',
    disposable: true,
  },
  {
    id: 'gradle-cache',
    label: 'Gradle cache',
    area: 'build',
    path: 'node-dock/app/.gradle',
    note: 'Per-project Gradle caches.',
    disposable: true,
  },
  {
    id: 'firmware-build',
    label: 'Firmware build (.pio)',
    area: 'build',
    path: 'node-dock/body-firmware/dock_body_v0/.pio',
    note: 'PlatformIO/ESP-IDF build tree. Regenerated by pio run.',
    disposable: true,
  },
  {
    id: 'node-modules',
    label: 'node_modules',
    area: 'build',
    path: 'orbit-station/node_modules',
    note: 'npm workspace install. Regenerated by npm install.',
    disposable: true,
  },
  {
    id: 'webrtc-aar',
    label: 'WebRTC AAR',
    area: 'build',
    path: '.webrtc-aar',
    note: 'Prebuilt WebRTC android archive.',
  },

  // ---- scratch: dictation notes and review scratch ----
  {
    id: 'scrap-plan',
    label: 'scrap-plan',
    area: 'scratch',
    path: 'scrap-plan',
    note: 'Transient planning scratch — not tracked, safe to prune.',
    disposable: true,
  },
  {
    id: 'scrap-review',
    label: 'scrap-review',
    area: 'scratch',
    path: 'scrap-review',
    note: 'Review scratch output.',
    disposable: true,
  },
  {
    id: 'scrap-review-fixer',
    label: 'scrap-review-fixer',
    area: 'scratch',
    path: 'scrap-review-fixer',
    note: 'Review-fixer scratch output.',
    disposable: true,
  },
];

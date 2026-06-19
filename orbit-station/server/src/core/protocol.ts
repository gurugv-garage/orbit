/**
 * orbit-station wire protocol — the single WebSocket vocabulary.
 *
 * ONE WebSocket endpoint (`/ws`) serves two kinds of peer:
 *   - browser UI   (the dashboard; subscribes to topics, sends control commands)
 *   - device       (a dock component: the phone app, the ESP32 body, a future
 *                   rover part — anything physical that dials in)
 *
 * Every frame is JSON with a `t` (type) discriminator and a `topic`. A peer
 * announces itself with `hello`, then subscribes to topics. The hub fans out
 * `event` frames to every subscriber of a topic. Modules own their topics.
 *
 * ## Identity model (hello v2 — see docs/decision-traces/server-brain-impl.md §2)
 *
 * A **dock** is the tenant: a named composition of components ("anne-bot" =
 * phone + body; the rover = a dock whose parts declare drive/nav). Four
 * identities, deliberately separate:
 *   - `dock`       which composed unit this peer belongs to (tenant)
 *   - `component`  the slot within the dock ("phone", "body", "cam-2")
 *   - `kind`+`build` the software running in that slot (OTA targets this)
 *   - `id`         the hardware/instance (mac, install uuid — diagnostics)
 * Address = (dock, component). State binds to the address, never the
 * hardware: swapping the phone in a slot continues the same sessions.
 * Components also declare `caps` (capability tags) so station modules route
 * by capability — nothing hardcodes "app" or "firmware".
 *
 * This file is the contract; keep it dependency-free so a firmware/app author
 * can read just this to integrate.
 */

/** What a connecting peer claims to be. `fake` = dev/smoke peers;
 *  `task` = a spawned background-task process (a WS client like any other). */
export type PeerRole = 'browser' | 'device' | 'fake' | 'task';

/** Topic namespaces, one per module. Subscriptions are exact-match on these. */
export type Topic =
  | 'obs'          // observability: agent Session/Turn/Step/event stream
  | 'config'       // config push: defaults + live changes
  | 'bodylink'     // body command path: set_target in, applied/state/digest out
  | 'station'      // station-level: peer presence, dock directory, health
  | 'ota'          // self-update: availability offers + progress/result (docs/ota.md)
  | 'media'        // WebRTC live A/V: SDP/ICE signaling for the in-process SFU
  | 'client'       // dock → station client facts (battery, on-device vad/face)
  | 'agent'        // the dock brain: transcripts/turns up, tool-calls/speak down
  | 'tasks'        // background-task processes: attach/status/notify/ask/finish up, init/input/stop down
  | 'perception'   // processor results (identity/presence/…) → dock agent + console
  | 'slack';       // inbound Slack (Socket Mode) events: message/mention/dm (ingest only for now)

// ── peer → station ─────────────────────────────────────────────────────────

export interface HelloFrame {
  t: 'hello';
  role: PeerRole;
  /** Stable hardware/instance id (firmware mac, app install uuid, "ui-xxxx"). */
  id: string;
  /** The named dock this peer belongs to (e.g. "anne-bot"). Devices only. */
  dock?: string;
  /**
   * The slot this peer fills within its dock (e.g. "phone", "body") — unique
   * per dock. (dock, component) is the peer's ADDRESS; directed traffic and
   * presence are keyed by it. Devices only.
   */
  component?: string;
  /**
   * The software running in the slot, e.g. "dock-android-app",
   * "dock-body-fw". With `build`, this is what OTA targets.
   */
  kind?: string;
  /**
   * Capability tags this component serves — e.g. phone: ["voice","face",
   * "camera"], body: ["servo"]. Station modules route by capability
   * (directory `resolveCap`), so differently-shaped docks need no station
   * changes.
   */
  caps?: string[];
  /** Optional human label for the console. */
  label?: string;
  /**
   * OTA gate (docs/ota.md §3): monotonic build number of the running artifact
   * (app: versionCode; firmware: BL_FW_BUILD). The ONLY version a device sends —
   * the station owns build→label metadata (release notes, build time) in its
   * meta.json. The ota module compares this against the latest artifact to
   * decide whether to offer an update. `browser` peers omit it.
   */
  build?: number;
}

export interface SubscribeFrame {
  t: 'subscribe';
  topics: Topic[];
}

export interface UnsubscribeFrame {
  t: 'unsubscribe';
  topics: Topic[];
}

/** A peer publishing into a topic (e.g. app pushing an agent event, firmware reporting state). */
export interface PublishFrame {
  t: 'publish';
  topic: Topic;
  /** Module-defined message kind within the topic. */
  kind: string;
  payload: unknown;
}

export type InboundFrame = HelloFrame | SubscribeFrame | UnsubscribeFrame | PublishFrame;

// ── station → peer ─────────────────────────────────────────────────────────

export interface WelcomeFrame {
  t: 'welcome';
  /** The id the station assigned/accepted for this peer. */
  id: string;
  serverTime: number;
}

/** Fan-out of a topic message to subscribers. */
export interface EventFrame {
  t: 'event';
  topic: Topic;
  kind: string;
  payload: unknown;
  /** station receive timestamp (ms epoch). */
  ts: number;
}

export interface ErrorFrame {
  t: 'error';
  message: string;
}

export type OutboundFrame = WelcomeFrame | EventFrame | ErrorFrame;

export function isInboundFrame(v: unknown): v is InboundFrame {
  return !!v && typeof v === 'object' && typeof (v as { t?: unknown }).t === 'string';
}

// ── addressing ───────────────────────────────────────────────────────────────

/** A component address: which slot of which dock. Resolved to the live peer
 *  by the hub at fan-out time (see BusMessage.toAddr). */
export interface ComponentAddr {
  dock: string;
  component: string;
}

// ── dock directory ───────────────────────────────────────────────────────────

/** One component of a dock, as the station currently sees it. */
export interface DockComponent {
  /** the slot name within the dock ("phone", "body", …). */
  component: string;
  /** the software in the slot ("dock-android-app", "dock-body-fw"). */
  kind?: string;
  /** capability tags this component serves ("voice", "servo", …). */
  caps?: string[];
  /** hardware/instance id currently filling the slot. */
  id: string;
  label?: string;
  online: boolean;
  /** remote IP (captured server-side). */
  ip?: string;
  /** ms epoch of the last frame seen from this component (incl. heartbeats). */
  lastSeen?: number;
  /** OTA running build (docs/ota.md §3) — the device's monotonic version. */
  build?: number;
  /** mesh links this component reports in its heartbeat. */
  links?: Record<string, boolean>;
}

/**
 * What the station knows about one named dock: its expected composition (the
 * manifest) and the live state of each component. Published on the `station`
 * topic (kind `dock-updated`) whenever it changes; per-member `presence`
 * frames are additionally directed to the dock's own components so every
 * component knows whether its siblings are online.
 */
export interface DockInfo {
  /** the dock name from peers' hello, e.g. "anne-bot". */
  name: string;
  /** expected component slots (from the dockManifest config; observed slots
   *  are merged in so an undeclared dock still renders). */
  manifest: string[];
  components: DockComponent[];
}

/** The per-member sibling-presence frame (station topic, kind `presence`,
 *  directed to each online component of the dock). */
export interface PresenceFrame {
  dock: string;
  components: Array<Pick<DockComponent, 'component' | 'kind' | 'online' | 'build'>>;
}

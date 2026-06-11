/**
 * orbit-station wire protocol — the single WebSocket vocabulary.
 *
 * ONE WebSocket endpoint (`/ws`) serves three kinds of peer:
 *   - browser UI   (the dashboard; subscribes to topics, sends control commands)
 *   - firmware     (ESP32 body; subscribes to config, reports body state)
 *   - app          (the dock Android app; reports agent traces, listens to config)
 *
 * Every frame is JSON with a `t` (type) discriminator and a `topic`. A peer
 * announces itself with `hello`, then subscribes to topics. The hub fans out
 * `event` frames to every subscriber of a topic. Modules own their topics.
 *
 * This file is the contract; keep it dependency-free so a firmware/app author
 * can read just this to integrate.
 */

/** What a connecting peer claims to be. Drives which topics it may publish to. */
export type PeerRole = 'browser' | 'firmware' | 'app' | 'fake';

/** Topic namespaces, one per module. Subscriptions are exact-match on these. */
export type Topic =
  | 'obs'          // observability: agent-core Session/Turn/Step/event stream
  | 'config'       // config push: defaults + live changes
  | 'bodylink'     // direct body control + reported state
  | 'mind'         // mind module's awareness/announcements (stub for now)
  | 'station'      // station-level: peer presence, health
  | 'ota'          // self-update: availability offers + progress/result (docs/OTA.md)
  | 'media'        // WebRTC live A/V: SDP/ICE signaling for the in-process SFU
  | 'client'       // dock → station client facts (battery, on-device vad/face) for processing
  | 'perception';  // processor results (identity/presence/…) → dock agent + console

// ── peer → station ─────────────────────────────────────────────────────────

export interface HelloFrame {
  t: 'hello';
  role: PeerRole;
  /** Stable id for this peer (firmware mac, app instance, "ui-xxxx", etc.). */
  id: string;
  /**
   * The named dock this peer belongs to (e.g. "anne-bot"). A dock = one app +
   * one firmware. The station groups peers by this name. `browser` peers omit
   * it. Set/flashed on each device.
   */
  dock?: string;
  /**
   * Firmware only: the peer's own phone-facing BodyLink server address
   * ("<ip>:17317"). The ESP32 is a WS *server* for the phone (BodyLink design);
   * it dials the station purely to register. The station brokers this address
   * to the matching dock's app so the app knows where its body is.
   */
  bodyAddr?: string;
  /** Optional human label for the console. */
  label?: string;
  /**
   * OTA gate (docs/OTA.md §3): monotonic build number of the running artifact
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

// ── dock directory ───────────────────────────────────────────────────────────

/** A member of a dock, as the station currently sees it. */
export interface DockMember {
  role: PeerRole;
  id: string;
  label?: string;
  online: boolean;
  /** remote IP (captured server-side). */
  ip?: string;
  /** ms epoch of the last frame seen from this member (incl. heartbeats). */
  lastSeen?: number;
  /** OTA running build (docs/OTA.md §3) — the device's monotonic version. */
  build?: number;
  /** mesh links this member reports (app: body/llm; firmware: phoneClient). */
  links?: Record<string, boolean>;
}

/**
 * What the station knows about one named dock = one app + one firmware.
 * Published on the `station` topic (kind `dock-updated`) whenever it changes,
 * so the app learns its body's address and the console renders the dock.
 */
export interface DockInfo {
  /** the dock name from peers' hello, e.g. "anne-bot". */
  name: string;
  /** the firmware's phone-facing BodyLink address ("<ip>:17317"), if known. */
  bodyAddr?: string;
  app?: DockMember;
  firmware?: DockMember;
}

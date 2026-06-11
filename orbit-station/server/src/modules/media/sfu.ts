/**
 * The SFU engine — werift wrapper. Each dock publishes its own A/V stream
 * (keyed by `streamId` = dock name); we ingest every stream and forward its live
 * tracks onto a fresh PeerConnection per (browser, stream) the viewer selects.
 * Multiple docks stream concurrently; a browser can watch several at once. All
 * werift specifics live here behind a tiny surface so the engine can be swapped
 * (e.g. mediasoup) without touching the module/signaling.
 *
 * werift facts proven by self-test (see plan "Unknowns — verified"):
 *   - ingestPc.onTrack → egressPc.addTrack(track) relays RTP end-to-end
 *   - MediaStreamTrack carries inbound RTP straight to the outbound sender
 *
 * Threading: forwarding is RTP rewrite + SRTP only (no transcode); at the dock's
 * envelope (~60 pkt/s in) this is <1% of a core even across many docks/viewers.
 *
 * Routing: signaling carries `streamId` so a browser addresses a specific stream.
 * The `streamId` is the PRODUCER'S UNIQUE PEER ID (the dock app's appId), so two
 * phones flashed with the same dock name never collide; the dock name rides along
 * as a display `label` only. A producer is keyed by its peer id; a viewer by
 * `${browserId}|${streamId}`.
 */

import {
  RTCPeerConnection,
  type MediaStreamTrack,
  type RTCIceCandidateInit,
} from 'werift';
import type { MediaKind, MediaTap } from './tap.js';

/** How the engine emits signaling: a directed `media` publish to one peer. */
export interface SfuSignal {
  (kind: string, payload: unknown, to: string): void;
}

interface Producer {
  /** the producer's unique peer id — also THE streamId. */
  streamId: string;
  /** friendly display name (the dock name); may repeat across producers. */
  label: string;
  pc: RTCPeerConnection;
  audio?: MediaStreamTrack;
  video?: MediaStreamTrack;
  /** periodic RTCP PLI timer (keeps fresh keyframes coming). */
  pli?: ReturnType<typeof setInterval>;
}

/** how often the SFU asks the dock for a fresh keyframe (RTCP PLI). */
const KEYFRAME_REQUEST_MS = 2000;

interface Viewer {
  browserId: string;
  streamId: string;
  pc: RTCPeerConnection;
}

const ICE_SERVERS = process.env.STUN_URL
  ? [{ urls: process.env.STUN_URL }]
  : []; // LAN: host candidates suffice. STUN_URL is the escape hatch.

/** Compose the viewer map key — one PeerConnection per (browser, stream). */
const vkey = (browserId: string, streamId: string) => `${browserId}|${streamId}`;

export class Sfu {
  #signal: SfuSignal;
  /** streamId (= producer peer id) → its live producer. Many stream at once. */
  #producers = new Map<string, Producer>();
  /** "browserId|streamId" → that viewer's egress PC. */
  #viewers = new Map<string, Viewer>();
  /** "browserId|streamId" the browser asked for before the stream had tracks. */
  #waiting = new Set<string>();
  /** optional processor tapping every producer's inbound media (STT/vision/…). */
  #tap?: MediaTap;

  constructor(opts: { signal: SfuSignal; tap?: MediaTap }) {
    this.#signal = opts.signal;
    this.#tap = opts.tap;
  }

  // ── producers (the docks) ──────────────────────────────────────────────────

  async onProducerOffer(dockId: string, payload: Record<string, unknown> | null): Promise<void> {
    const sdp = payload?.sdp as string | undefined;
    if (!sdp) return;
    // The streamId IS the producer's unique peer id — never collides across docks.
    const streamId = dockId;
    const label = (payload?.label as string | undefined)
      ?? (payload?.streamId as string | undefined) // back-compat: old docks sent dock name here
      ?? dockId;

    // Same peer re-offering (reconnect / restart) → replace just its producer.
    if (this.#producers.has(streamId)) this.#closeProducer(streamId);

    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    const producer: Producer = { streamId, label, pc };
    this.#producers.set(streamId, producer);

    pc.onIceCandidate.subscribe((c) => {
      if (c) this.#signal('producer-ice', { streamId, candidate: c.toJSON() }, dockId);
    });

    pc.onTrack.subscribe((track) => {
      if (track.kind === 'audio') producer.audio = track;
      else if (track.kind === 'video') {
        producer.video = track;
        // Request keyframes periodically (RTCP PLI). The dock only sends a
        // keyframe at connect; without fresh keyframes the decoded P-frames smear
        // into garbage under any packet loss (the "corrupted frame" recognition
        // saw). A PLI forces a clean keyframe so the decoder re-syncs — keeping
        // the processor's frames sharp. ~every 2s is plenty at our ~1-2fps.
        this.#startKeyframeRequests(streamId, pc, track);
      }
      // Hand the track to the processing tap (if any) — STT/vision/recording see
      // the same inbound RTP the SFU forwards to viewers. See tap.ts.
      this.#tap?.onTrack(streamId, track.kind as MediaKind, track);
      // A new track arrived — admit waiters for THIS stream + (re)offer its viewers.
      this.#admitWaiting(streamId);
      for (const v of this.#viewersOf(streamId)) void this.#offerViewer(v);
    });

    await pc.setRemoteDescription({ type: 'offer', sdp });
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    this.#signal('producer-answer', { streamId, sdp: pc.localDescription?.sdp }, dockId);
  }

  onProducerIce(dockId: string, payload: Record<string, unknown> | null): void {
    const producer = this.#producers.get(dockId); // streamId === dockId
    const candidate = payload?.candidate as RTCIceCandidateInit | undefined;
    if (producer && candidate) void producer.pc.addIceCandidate(candidate);
  }

  // ── viewers (browsers, later other docks) ──────────────────────────────────

  onViewerReady(browserId: string, payload: Record<string, unknown> | null): void {
    const streamId = payload?.streamId as string | undefined;
    if (!streamId) return; // a browser must name the dock it wants to watch
    const key = vkey(browserId, streamId);
    if (this.#viewers.has(key)) return;
    if (!this.#hasTracks(streamId)) {
      this.#waiting.add(key); // offer once the producer's tracks arrive
      return;
    }
    void this.#createViewer(browserId, streamId);
  }

  onViewerAnswer(browserId: string, payload: Record<string, unknown> | null): void {
    const streamId = payload?.streamId as string | undefined;
    const sdp = payload?.sdp as string | undefined;
    if (!streamId || !sdp) return;
    const v = this.#viewers.get(vkey(browserId, streamId));
    if (v) void v.pc.setRemoteDescription({ type: 'answer', sdp });
  }

  onViewerIce(browserId: string, payload: Record<string, unknown> | null): void {
    const streamId = payload?.streamId as string | undefined;
    const candidate = payload?.candidate as RTCIceCandidateInit | undefined;
    if (!streamId || !candidate) return;
    const v = this.#viewers.get(vkey(browserId, streamId));
    if (v) void v.pc.addIceCandidate(candidate);
  }

  /** A browser stopped watching one stream (or all, if no streamId). */
  onViewerLeave(browserId: string, payload: Record<string, unknown> | null): void {
    const streamId = payload?.streamId as string | undefined;
    if (streamId) this.#dropViewer(browserId, streamId);
    else this.#dropAllViewers(browserId);
  }

  // ── teardown ───────────────────────────────────────────────────────────────

  /** A peer disconnected (or sent bye with no stream): reap it as producer + viewer. */
  onBye(peerId: string): void {
    if (this.#producers.has(peerId)) this.#closeProducer(peerId);
    this.#dropAllViewers(peerId);
  }

  status() {
    return {
      producers: [...this.#producers.values()].map((p) => ({
        streamId: p.streamId,
        label: p.label,
        tracks: { audio: !!p.audio, video: !!p.video },
        viewers: this.#viewersOf(p.streamId).length,
      })),
      viewers: [...this.#viewers.keys()],
      waiting: [...this.#waiting],
    };
  }

  // ── internals ──────────────────────────────────────────────────────────────

  #hasTracks(streamId: string): boolean {
    const p = this.#producers.get(streamId);
    return !!(p && (p.audio || p.video));
  }

  #viewersOf(streamId: string): Viewer[] {
    return [...this.#viewers.values()].filter((v) => v.streamId === streamId);
  }

  #admitWaiting(streamId: string): void {
    if (!this.#hasTracks(streamId)) return;
    for (const key of [...this.#waiting]) {
      const [browserId, sid] = key.split('|');
      if (sid !== streamId) continue;
      this.#waiting.delete(key);
      void this.#createViewer(browserId!, streamId);
    }
  }

  async #createViewer(browserId: string, streamId: string): Promise<void> {
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    const viewer: Viewer = { browserId, streamId, pc };
    this.#viewers.set(vkey(browserId, streamId), viewer);
    pc.onIceCandidate.subscribe((c) => {
      if (c) this.#signal('viewer-ice', { streamId, candidate: c.toJSON() }, browserId);
    });
    await this.#offerViewer(viewer);
  }

  /** Attach the stream's current tracks and (re)offer this viewer. */
  async #offerViewer(viewer: Viewer): Promise<void> {
    const p = this.#producers.get(viewer.streamId);
    if (!p) return;
    const have = new Set(viewer.pc.getSenders().map((s) => s.track?.kind).filter(Boolean));
    if (p.audio && !have.has('audio')) viewer.pc.addTrack(p.audio);
    if (p.video && !have.has('video')) viewer.pc.addTrack(p.video);

    const offer = await viewer.pc.createOffer();
    await viewer.pc.setLocalDescription(offer);
    this.#signal(
      'viewer-offer',
      { streamId: viewer.streamId, sdp: viewer.pc.localDescription?.sdp },
      viewer.browserId,
    );
  }

  #dropViewer(browserId: string, streamId: string): void {
    const key = vkey(browserId, streamId);
    const v = this.#viewers.get(key);
    if (v) { void v.pc.close(); this.#viewers.delete(key); }
    this.#waiting.delete(key);
  }

  #dropAllViewers(browserId: string): void {
    for (const key of [...this.#viewers.keys()]) {
      if (key.startsWith(`${browserId}|`)) this.#dropViewer(browserId, key.slice(browserId.length + 1));
    }
    for (const key of [...this.#waiting]) {
      if (key.startsWith(`${browserId}|`)) this.#waiting.delete(key);
    }
  }

  /**
   * Ask the dock for a fresh keyframe (RTCP PLI) every KEYFRAME_REQUEST_MS, so the
   * decoder re-syncs and the processor's frames stay sharp (P-frames smear under
   * loss without periodic keyframes). Finds the receiver carrying this track and
   * PLIs its ssrc.
   */
  #startKeyframeRequests(streamId: string, pc: RTCPeerConnection, track: MediaStreamTrack): void {
    const p = this.#producers.get(streamId);
    if (!p) return;
    if (p.pli) clearInterval(p.pli);
    const pli = () => {
      try {
        const recv = pc.getReceivers().find((r) => r.tracks.includes(track));
        const ssrc = (track as unknown as { ssrc?: number }).ssrc;
        if (recv && ssrc != null) void recv.sendRtcpPLI(ssrc);
      } catch { /* receiver/ssrc not ready yet — next tick */ }
    };
    pli(); // ask immediately so the first usable keyframe comes fast
    p.pli = setInterval(pli, KEYFRAME_REQUEST_MS);
  }

  #closeProducer(streamId: string): void {
    const p = this.#producers.get(streamId);
    if (!p) return;
    if (p.pli) clearInterval(p.pli);
    this.#tap?.onProducerGone(streamId); // let the processor flush/close per-stream state
    void p.pc.close();
    this.#producers.delete(streamId);
    // Tear down everyone watching this stream — their tracks are gone. The UI
    // re-`viewer-ready`s if the dock comes back.
    for (const v of this.#viewersOf(streamId)) this.#dropViewer(v.browserId, v.streamId);
  }
}

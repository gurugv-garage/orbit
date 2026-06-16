/**
 * VisionWatchProcessor — TIER 1 vision sensor of the perception pyramid
 * (docs/PERCEPTION-PYRAMID.md). Always-on: per producer it decodes the VP8 stream
 * to ~1 fps JPEGs (reusing the face module's FrameGrabber → ffmpeg), sends each
 * frame + a natural-language instruction to the moondream sidecar
 * (models/moondream/sidecar, POST /infer), and emits a `scene` PerceptionResult
 * with the description + a derived `present` boolean.
 *
 * Cheap-by-design, per the pyramid:
 *  - one inference per ~INTERVAL_MS (not per RTP packet),
 *  - a change-gate skips near-identical frames (static scene → near-idle),
 *  - on failure it stays silent rather than spamming the bus,
 *  - it asks an OPEN question and derives structure from the prose (moondream
 *    returns empty on closed/JSON prompts — see models/moondream/FINDINGS.md).
 *
 * It deliberately does NOT summarize across time — that's tier 2. This processor
 * only produces the per-frame fact; the roll-up/escalation consume `scene`
 * results downstream.
 */

import type { MediaKind } from '../../media/tap.js';
import type { RtpPacket } from 'werift';
import type { StreamContext, StreamProcessor } from '../processor.js';
import { FrameGrabber } from '../face/frame-grabber.js';

/** Where the moondream sidecar listens (models/moondream/sidecar). */
const SIDECAR_URL = process.env.MOONDREAM_SIDECAR_URL ?? 'http://127.0.0.1:8077';

/** Min gap between inferences per stream — moondream is ~1 s/frame, the dock
 *  streams ~1 Hz, so "as fast as possible" ≈ once a second. */
const INTERVAL_MS = Number(process.env.VISION_WATCH_INTERVAL_MS ?? 1000);

/** The always-on instruction. Open question (not closed/JSON) on purpose. */
const INSTRUCTION =
  process.env.VISION_WATCH_PROMPT ??
  'What person is in the image, and what are they doing? Describe briefly.';

interface StreamState {
  ctx: StreamContext;
  grabber: FrameGrabber;
  busy: boolean;
  lastInfer: number;
  lastPresent: boolean | null;
  timer: ReturnType<typeof setInterval> | null;
}

/** Derive presence from moondream's prose (negation dominates) — same logic as
 *  models/moondream/ts/moondream.ts polarity(). */
export function presentFromText(text: string): boolean | null {
  const t = ` ${text.toLowerCase()} `;
  const neg = /\bno\b|\bnot\b|there (?:is|are) no|isn't|aren't|nobody|no one|empty/.test(t);
  const pos = /there (?:is|are|appears)|a person|a man|a woman|someone|i can see|people/.test(t);
  if (neg && !pos) return false;
  if (pos && !neg) return true;
  if (neg && pos) return false;
  return null;
}

async function infer(jpeg: Buffer): Promise<string | null> {
  try {
    const r = await fetch(`${SIDECAR_URL}/infer`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ image_b64: jpeg.toString('base64'), instruction: INSTRUCTION }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!r.ok) return null;
    const data = (await r.json()) as { answer?: string };
    return (data.answer ?? '').trim() || null;
  } catch {
    return null; // sidecar down / timeout → stay silent (tier-1 is best-effort)
  }
}

export function visionWatchProcessor(): StreamProcessor {
  const streams = new Map<string, StreamState>();

  const tick = async (streamId: string) => {
    const s = streams.get(streamId);
    if (!s || s.busy) return;
    if (Date.now() - s.lastInfer < INTERVAL_MS) return;
    const jpeg = s.grabber.latest();
    if (!jpeg) return;

    s.busy = true;
    s.lastInfer = Date.now();
    try {
      const answer = await infer(jpeg);
      if (!answer) return;
      const present = presentFromText(answer);
      // Tier-1 fact: always emit the scene description; include derived present.
      s.ctx.emit({
        kind: 'scene',
        source: 'vision-watch',
        payload: { description: answer, present },
        confidence: present == null ? 0.5 : 0.8,
      });
      // Cheap change signal for the roll-up: note presence transitions.
      if (present != null && present !== s.lastPresent) {
        s.ctx.publish('vision.present', { present, description: answer });
        s.lastPresent = present;
      }
    } finally {
      s.busy = false;
    }
  };

  return {
    id: 'vision-watch',
    sources: '*',
    mediaKinds: ['video'],
    channels: [],

    onStreamStart(ctx: StreamContext) {
      const grabber = new FrameGrabber();
      grabber.start();
      const state: StreamState = {
        ctx, grabber, busy: false, lastInfer: 0, lastPresent: null, timer: null,
      };
      // Drive inference on a timer (decoupled from RTP arrival rate).
      state.timer = setInterval(() => void tick(ctx.streamId), Math.min(INTERVAL_MS, 500));
      streams.set(ctx.streamId, state);
    },

    onRtp(streamId: string, _kind: MediaKind, rtp: RtpPacket) {
      streams.get(streamId)?.grabber.feed(rtp); // keep the latest frame decoded
    },

    onStreamEnd(streamId: string) {
      const s = streams.get(streamId);
      if (s?.timer) clearInterval(s.timer);
      s?.grabber.stop();
      streams.delete(streamId);
    },
  };
}

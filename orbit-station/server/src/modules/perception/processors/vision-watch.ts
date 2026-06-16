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
import { visionInstruction } from '../vision-instruction.js';
import { visionBackend } from '../vision-config.js';

/** Min gap between inferences per stream — moondream is ~1 s/frame, the dock
 *  streams ~1 Hz, so "as fast as possible" ≈ once a second. */
const INTERVAL_MS = Number(process.env.VISION_WATCH_INTERVAL_MS ?? 1000);

interface StreamState {
  ctx: StreamContext;
  grabber: FrameGrabber;
  busy: boolean;
  lastInfer: number;
  lastPresent: boolean | null;
  emptyStreak: number; // consecutive empty moondream responses
  timer: ReturnType<typeof setInterval> | null;
}

/** Only surface "(nothing notable)" after this many CONSECUTIVE empty responses —
 *  moondream flakes empty on the occasional good frame, so a single empty must not
 *  spam the feed when a person is plainly there. */
const EMPTY_STREAK_TO_REPORT = 5;

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
    const backend = visionBackend(); // moondream(Ollama) or md3(sidecar), live-switchable
    const r = await fetch(`${backend.url}/api/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: backend.model,
        prompt: visionInstruction(), // steerable: base + console/task extra
        images: [jpeg.toString('base64')],
        stream: false,
        keep_alive: '30m',
        options: { temperature: 0 },
      }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!r.ok) return null;
    const data = (await r.json()) as { response?: string };
    return (data.response ?? '').trim() || null;
  } catch {
    return null; // Ollama down / timeout → stay silent (tier-1 is best-effort)
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
      // moondream flakes empty on the occasional good frame; don't spam "(nothing
      // notable)" on every empty. Only report it after a sustained empty streak
      // (genuinely nothing in view), and only once per streak.
      if (!answer) {
        s.emptyStreak++;
        if (s.emptyStreak === EMPTY_STREAK_TO_REPORT) {
          s.ctx.emit({ kind: 'scene', source: 'vision-watch',
            payload: { description: '(nothing notable in view)', present: false }, confidence: 0.2 });
        }
        return;
      }
      s.emptyStreak = 0;
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
        ctx, grabber, busy: false, lastInfer: 0, lastPresent: null, emptyStreak: 0, timer: null,
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

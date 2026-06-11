/**
 * PresenceProcessor — the trivial first processor (no ML, no decode). It emits
 * `presence: true` when a dock's video stream starts and `presence: false` when it
 * ends. Its only job is to prove the whole loop end-to-end — processor → result →
 * perception state → dock agent + console — before any model is involved.
 *
 * "Presence" here = "the dock is streaming video", a coarse proxy. A real presence
 * signal (a face is actually visible) comes from the face processor in Phase 2;
 * this one is the smoke test for the pipeline.
 */

import type { StreamContext, StreamProcessor } from '../processor.js';

export function presenceProcessor(): StreamProcessor {
  const ctxByStream = new Map<string, StreamContext>();
  return {
    id: 'presence',
    sources: '*',
    mediaKinds: ['video'],
    channels: [],

    onStreamStart(ctx) {
      ctxByStream.set(ctx.streamId, ctx);
      ctx.emit({ kind: 'presence', payload: { present: true }, source: 'presence', confidence: 1 });
    },

    onStreamEnd(streamId) {
      const ctx = ctxByStream.get(streamId);
      ctx?.emit({ kind: 'presence', payload: { present: false }, source: 'presence', confidence: 1 });
      ctxByStream.delete(streamId);
    },
  };
}

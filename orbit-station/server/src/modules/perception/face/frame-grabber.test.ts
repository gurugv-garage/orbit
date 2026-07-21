/**
 * FrameGrabber rolling-window logic — the pure ring helpers behind frameAt()
 * (the "look back to a moment" capture). ffmpeg/RTP decode is not exercised here;
 * these test the window/eviction policy + nearest-frame-at-t lookup deterministically.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pushToRing, frameAtIn, type StampedFrame } from './frame-grabber.js';

const f = (at: number, tag: string): StampedFrame => ({ jpeg: Buffer.from(tag), at });
const tag = (b: Buffer | null) => (b ? b.toString() : null);

const WINDOW = 60_000;
const MAX = 240;

// ── pushToRing: eviction by age ──────────────────────────────────────────────
test('pushToRing keeps frames within the window, evicts older ones', () => {
  const ring: StampedFrame[] = [];
  pushToRing(ring, f(1_000, 'a'), WINDOW, MAX);
  pushToRing(ring, f(30_000, 'b'), WINDOW, MAX);
  pushToRing(ring, f(61_500, 'c'), WINDOW, MAX); // newest; cutoff = 1_500 → 'a'(1000) evicted
  assert.deepEqual(ring.map((x) => tag(x.jpeg)), ['b', 'c'], "the frame older than 60s before newest is gone");
});

test('pushToRing keeps everything when all frames are inside the window', () => {
  const ring: StampedFrame[] = [];
  for (let i = 0; i < 5; i++) pushToRing(ring, f(i * 1000, `f${i}`), WINDOW, MAX);
  assert.equal(ring.length, 5, 'all 5 within 60s retained');
});

// ── pushToRing: hard count cap (burst protection) ────────────────────────────
test('pushToRing enforces the hard frame cap even inside the window', () => {
  const ring: StampedFrame[] = [];
  // 300 frames 10ms apart → all within the window, but cap is 3 here.
  for (let i = 0; i < 300; i++) pushToRing(ring, f(i * 10, `f${i}`), WINDOW, 3);
  assert.equal(ring.length, 3, 'never exceeds maxFrames');
  assert.deepEqual(ring.map((x) => tag(x.jpeg)), ['f297', 'f298', 'f299'], 'keeps the newest 3');
});

// ── frameAtIn: nearest frame at/before t ─────────────────────────────────────
test('frameAtIn returns the frame the camera showed AT t (newest at/just-before)', () => {
  const ring: StampedFrame[] = [];
  [1000, 2000, 3000, 4000].forEach((t, i) => pushToRing(ring, f(t, `f${i}`), WINDOW, MAX));
  // ask about t=2500 with no tolerance → the frame at 2000 (f1) was on screen.
  assert.equal(tag(frameAtIn(ring, 2500, 0)), 'f1');
  // exactly on a frame boundary → that frame.
  assert.equal(tag(frameAtIn(ring, 3000, 0)), 'f2');
});

test('frameAtIn tolerance snaps a t just after the last frame to that frame', () => {
  const ring: StampedFrame[] = [];
  pushToRing(ring, f(1000, 'only'), WINDOW, MAX);
  // t is 1200 — 200ms after the frame; within 1500ms tolerance → snaps to it.
  assert.equal(tag(frameAtIn(ring, 1200, 1500)), 'only');
  // t is 3000 — 2000ms after, beyond tolerance → still returns it (nothing newer exists,
  // and it's the newest at/just-before once tolerance is applied)… but at 0 tolerance and
  // a t BEFORE the only frame, it must be null:
  assert.equal(frameAtIn(ring, 500, 0), null, 't predates every frame → null');
});

test('frameAtIn returns null on an empty ring', () => {
  assert.equal(frameAtIn([], 1000, 1500), null);
});

test('frameAtIn on a t older than the whole (evicted) window is null', () => {
  const ring: StampedFrame[] = [];
  // fill past the window so early frames are evicted, then ask about an evicted moment.
  for (let i = 0; i < 100; i++) pushToRing(ring, f(i * 1000, `f${i}`), WINDOW, MAX);
  // newest is 99_000; cutoff 39_000 → frames < 39_000 evicted. Ask about t=10_000.
  assert.equal(frameAtIn(ring, 10_000, 0), null, 'the moment scrolled out of the window');
});

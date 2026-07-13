/**
 * audio-trigger — truth tables for the cheap audio-enricher triggers (pure, injected
 * time): impulse fires on a sharp jump over baseline (not from a gradual rise, not
 * mid-utterance, not twice within the refractory), sustained fires once per long
 * energetic stretch and re-arms after quiet.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AudioTrigger, DEFAULT_TRIGGER_CFG } from './audio-trigger.js';

const FRAME = 30; // ms, like the VAD

function run(t: AudioTrigger, spec: Array<{ rms: number; ms: number; inSpeech?: boolean }>): string[] {
  const out: string[] = [];
  let now = 0;
  for (const s of spec) {
    for (let e = 0; e < s.ms; e += FRAME) {
      const f = t.frame(s.rms, FRAME, now, s.inSpeech ?? false);
      if (f) out.push(`${now}:${f}`);
      now += FRAME;
    }
  }
  return out;
}

test('impulse: a bang over a quiet baseline fires once, then respects the refractory', () => {
  const t = new AudioTrigger();
  const events = run(t, [
    { rms: 0.005, ms: 2_000 },  // quiet room
    { rms: 0.3, ms: 60 },       // BANG
    { rms: 0.005, ms: 1_000 },
    { rms: 0.3, ms: 60 },       // second bang inside the 5 s refractory → suppressed
    { rms: 0.005, ms: 5_000 },
    { rms: 0.3, ms: 60 },       // third bang after refractory → fires
  ]);
  assert.equal(events.filter((e) => e.includes('impulse')).length, 2, `events: ${events}`);
});

test('impulse: does NOT fire mid-utterance (the speech endpoint owns that audio)', () => {
  const t = new AudioTrigger();
  const events = run(t, [
    { rms: 0.005, ms: 2_000 },
    { rms: 0.3, ms: 60, inSpeech: true },
  ]);
  assert.deepEqual(events, []);
});

test('impulse: a gradual rise raises the baseline instead of firing', () => {
  const t = new AudioTrigger();
  const spec = [];
  for (let r = 0.005; r < 0.06; r += 0.002) spec.push({ rms: r, ms: 300 });
  const events = run(t, spec);
  assert.deepEqual(events.filter((e) => e.includes('impulse')), []);
});

test('sustained: long continuous energy fires once per stretch, re-arms after quiet', () => {
  const t = new AudioTrigger();
  const events = run(t, [
    { rms: 0.03, ms: 10_000 },  // music for 10 s → one sustained (at ~8 s)
    { rms: 0.03, ms: 10_000 },  // still the same stretch → no second fire
    { rms: 0.005, ms: 6_000 },  // quiet (also clears the refractory)
    { rms: 0.03, ms: 10_000 },  // music again → fires again
  ]);
  assert.equal(events.filter((e) => e.includes('sustained')).length, 2, `events: ${events}`);
});

test('sustained: short bursts below sustainedMs never fire', () => {
  const t = new AudioTrigger();
  const events = run(t, [
    { rms: 0.03, ms: 4_000 },
    { rms: 0.005, ms: 1_000 },
    { rms: 0.03, ms: 4_000 },
    { rms: 0.005, ms: 1_000 },
  ]);
  assert.deepEqual(events.filter((e) => e.includes('sustained')), []);
});

test('defaults are exported for the processor to reuse', () => {
  assert.ok(DEFAULT_TRIGGER_CFG.sustainedMs > DEFAULT_TRIGGER_CFG.refractoryMs);
});

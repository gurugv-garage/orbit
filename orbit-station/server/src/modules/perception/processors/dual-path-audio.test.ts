// Integration test for the DUAL-PATH enricher batching, driven by REAL sample audio (checked-in
// WAVs in __fixtures__/) fed through the actual RMS/VAD path — not synthetic frames. Proves the
// speech-vs-non-speech distinction end-to-end at the detector level:
//   • real spoken audio → RMS endpoints → (parakeet=words, mimicked) → SPEECH path, fires fast.
//   • a low mechanical hum → NOT speech (parakeet '' , mimicked) → never arms the fast speech path.
// The parakeet verdict is injected (we don't run the sidecar in a unit test); everything else —
// framing, RMS voicing, endpointing, the batch state machine — is the real code.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { UtteranceDetector } from './vad-endpoint.js';

const FX = join(import.meta.dirname, '__fixtures__');

/** Load a 16 kHz mono 16-bit WAV fixture as Int16 PCM (skip the 44-byte header). */
function loadWavPcm(name: string): Int16Array {
  const buf = readFileSync(join(FX, name));
  // minimal WAV: data starts at 44 for our canonical afconvert output.
  const pcmBytes = buf.subarray(44);
  return new Int16Array(pcmBytes.buffer, pcmBytes.byteOffset, Math.floor(pcmBytes.byteLength / 2));
}

const silence = (ms: number) => new Int16Array(Math.round((16000 * ms) / 1000)); // 16 kHz

/** A loud broadband burst (deterministic seeded noise) — trips the RMS AudioTrigger's impulse
 *  path (a bang/clunk), the real acoustic (non-speech) signal. Not speech: parakeet returns ''. */
function burst(ms: number, amp = 0.3): Int16Array {
  const n = Math.round((16000 * ms) / 1000);
  const out = new Int16Array(n);
  let s = 12345; // fixed seed → reproducible
  for (let i = 0; i < n; i++) { s = (s * 1103515245 + 12345) & 0x7fffffff; out[i] = Math.round(((s / 0x7fffffff) * 2 - 1) * amp * 32767); }
  return out;
}

function harness(hasWords: boolean) {
  const fires: Array<{ ms: number; armedBy: 'speech' | 'acoustic' }> = [];
  const d = new UtteranceDetector(() => { d.speechEndpoint(hasWords); }); // inject parakeet's verdict
  d.onEnrich = (w, _s, armedBy) => { fires.push({ ms: w.length / 16, armedBy }); d.enrichDone(); };
  return { d, fires };
}

test('REAL speech audio → SPEECH path fires (armedBy speech), from the actual RMS endpoint', () => {
  const speech = loadWavPcm('speech-16k.wav'); // ~2.1s of "Hey orbit, what is the weather today"
  const { d, fires } = harness(true);          // parakeet would return words for real speech
  d.feedPcm(speech);
  d.feedPcm(silence(6000));                     // trailing quiet → endpoint + 3s lull → FIRE
  assert.equal(fires.length, 1, 'the real spoken clip fired via the speech path');
  assert.equal(fires[0]!.armedBy, 'speech', 'armed by a word-bearing speech endpoint');
});

test('REAL non-speech hum → speech path NEVER arms (parakeet would return "")', () => {
  const hum = loadWavPcm('hum-16k.wav');        // ~3s low mechanical hum — energy, but no words
  const { d, fires } = harness(false);          // parakeet returns '' on non-speech
  d.feedPcm(hum);
  d.feedPcm(silence(6000));                      // even with an RMS endpoint + quiet, no words → no speech fire
  const speechFires = fires.filter((f) => f.armedBy === 'speech');
  assert.equal(speechFires.length, 0, 'a hum must NOT fire the fast speech path (no words)');
});

// ── ENRICH-PATH GATES (console toggles: speech / non-speech triggers) ──────────────────────────
// setEnrichPaths gates each path at its ARM point, so a disabled path never produces a clip.
// The acoustic path is driven by a real RMS burst (a clunk), not the hum fixture — a steady 90 Hz
// hum sits below the impulse/sustained thresholds and never trips the AudioTrigger on its own.

test('non-speech ENABLED → an acoustic burst fires an acoustic clip', () => {
  const { d, fires } = harness(false); // not speech (parakeet '')
  d.setEnrichPaths({ speech: true, nonSpeech: true });
  d.feedPcm(silence(500));
  d.feedPcm(burst(200));                        // loud clunk → impulse → opens the acoustic window
  d.feedPcm(silence(31_000));                    // past the 30s window → fires
  assert.equal(fires.filter((f) => f.armedBy === 'acoustic').length, 1, 'non-speech on → the burst fires an acoustic clip');
});

test('non-speech DISABLED (default) → the same burst opens NO window, fires nothing', () => {
  const { d, fires } = harness(false);
  d.setEnrichPaths({ speech: true, nonSpeech: false }); // the shipped default
  d.feedPcm(silence(500));
  d.feedPcm(burst(200));                        // identical clunk
  d.feedPcm(silence(35_000));                    // well past the 30s window — would fire if armed
  assert.equal(fires.length, 0, 'non-speech off → an acoustic event never fires a clip');
});

test('speech DISABLED → real speech does NOT arm the speech path', () => {
  const speech = loadWavPcm('speech-16k.wav');
  const { d, fires } = harness(true); // parakeet WOULD return words
  d.setEnrichPaths({ speech: false, nonSpeech: false });
  d.feedPcm(speech);
  d.feedPcm(silence(6000));
  assert.equal(fires.filter((f) => f.armedBy === 'speech').length, 0, 'speech off → no speech-armed clip');
});

test('disabling non-speech mid-window retires an already-open acoustic window', () => {
  const { d, fires } = harness(false);
  d.setEnrichPaths({ speech: true, nonSpeech: true });
  d.feedPcm(silence(500));
  d.feedPcm(burst(200));                        // opens a 30s acoustic window
  d.feedPcm(silence(5_000));                     // window still open (not yet at 30s)
  d.setEnrichPaths({ speech: true, nonSpeech: false }); // toggle off mid-window
  d.feedPcm(silence(30_000));                    // past when it WOULD have fired
  assert.equal(fires.length, 0, 'a live acoustic window is retired when non-speech is turned off');
});

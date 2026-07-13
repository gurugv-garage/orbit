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

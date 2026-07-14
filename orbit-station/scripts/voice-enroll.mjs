#!/usr/bin/env node
/**
 * Bootstrap voice enrollment from wav files (16kHz mono int16) — for seeding the
 * voice gallery before the Studio enroll UI has live audio to work with.
 * The normal path is the Studio: speak to the dock, then name your utterances.
 *
 *   node scripts/voice-enroll.mjs <name> <file.wav> [more.wav ...]
 *
 * Each wav becomes one gallery sample (embedded by the STT sidecar, which must be
 * running with --embed-model). Writes server/data/voice-gallery.json directly —
 * restart the station (or enroll before boot) so it reloads the file.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const SIDECAR = process.env.PERCEPTION_SIDECAR_URL ?? 'http://127.0.0.1:8078';
const GALLERY = fileURLToPath(new URL('../server/data/voice-gallery.json', import.meta.url));

const [name, ...files] = process.argv.slice(2);
if (!name || !files.length) {
  console.error('usage: node scripts/voice-enroll.mjs <name> <file.wav> [more.wav ...]');
  process.exit(1);
}

/** Minimal wav reader: assumes canonical 16kHz mono 16-bit PCM (the enrich-audio dumps). */
function wavPcm(path) {
  const b = readFileSync(path);
  const dataIx = b.indexOf(Buffer.from('data'));
  if (b.toString('ascii', 0, 4) !== 'RIFF' || dataIx < 0) throw new Error(`${path}: not a wav`);
  const rate = b.readUInt32LE(24);
  return { pcm: b.subarray(dataIx + 8), rate };
}

const entryName = name.trim().toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
const samples = [];
for (const f of files) {
  const { pcm, rate } = wavPcm(f);
  const r = await fetch(`${SIDECAR}/transcribe`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ pcm_b64: pcm.toString('base64'), sample_rate: rate, embed: true }),
  });
  const j = await r.json();
  if (!Array.isArray(j.embedding)) throw new Error(`${f}: sidecar returned no embedding (running with --embed-model?)`);
  samples.push({ embedding: j.embedding, text: j.text ?? undefined, addedAt: Date.now() });
  console.log(`${f}: "${(j.text ?? '').slice(0, 60)}" → sample ${samples.length}`);
}

const gallery = existsSync(GALLERY) ? JSON.parse(readFileSync(GALLERY, 'utf-8')) : [];
const key = entryName.toLowerCase();
const prev = gallery.find((e) => e.name.trim().toLowerCase() === key);
if (prev) prev.samples = [...prev.samples, ...samples].slice(-8);
else gallery.push({ name: entryName, samples, enrolledAt: Date.now() });
writeFileSync(GALLERY, JSON.stringify(gallery, null, 2));
console.log(`enrolled ${samples.length} sample(s) for "${entryName}" → ${GALLERY}`);

/**
 * Load profile for moondream via the TS path — latency + ollama RSS over N warm
 * frames at the dock's 320×240. (GPU%/watts need `sudo powermetrics`, which a
 * non-interactive run can't prompt for; latency is the load proxy and RSS is the
 * footprint. The Python profiler bench/vlm/profile_load.py has the GPU sampler
 * for an interactive run.)
 *
 *   npx tsx src/dev/vlm/profile.ts --frames 8
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ask, captureFrame, ollamaUp, STREAM_W, STREAM_H } from './moondream.js';

const pexec = promisify(execFile);

async function ollamaRssMb(): Promise<number> {
  try {
    const { stdout } = await pexec('ps', ['-axo', 'rss,comm']);
    let rss = 0;
    for (const line of stdout.split('\n')) {
      if (/ollama/i.test(line)) {
        const kb = Number(line.trim().split(/\s+/)[0]);
        if (!Number.isNaN(kb)) rss += kb / 1024;
      }
    }
    return rss;
  } catch {
    return 0;
  }
}

async function main() {
  const frames = Number(process.argv[process.argv.indexOf('--frames') + 1]) || 8;
  if (!(await ollamaUp())) { console.error('Ollama not running'); process.exit(1); }

  const q = 'What person is in the image, and what are they doing?';
  console.log(`Profiling moondream (TS) @ ${STREAM_W}×${STREAM_H}, ${frames} warm frames.`);

  // warm
  await ask(q, (await captureFrame()).toString('base64'));

  const lat: number[] = [];
  let rssMax = 0;
  for (let i = 0; i < frames; i++) {
    const b64 = (await captureFrame()).toString('base64');
    const r = await ask(q, b64);
    lat.push(r.latencyMs);
    rssMax = Math.max(rssMax, await ollamaRssMb());
    console.log(`  frame ${i + 1}: ${r.latencyMs.toFixed(0)}ms (eval ${r.evalMs.toFixed(0)}ms)`);
  }

  const s = [...lat].sort((a, b) => a - b);
  const p = (q: number) => s[Math.min(s.length - 1, Math.floor(s.length * q))] ?? 0;
  const max = s.at(-1) ?? 0;
  console.log(`\nmoondream  n=${frames}  p50 ${p(0.5).toFixed(0)}ms  p90 ${p(0.9).toFixed(0)}ms  max ${max.toFixed(0)}ms  RSS(max) ${rssMax.toFixed(0)}MB`);
}

main().catch((e) => { console.error(e); process.exit(1); });

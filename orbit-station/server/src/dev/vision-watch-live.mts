/**
 * Live try-out for the tier-1 vision-watch processor WITHOUT a dock/SFU.
 *
 * The real processor decodes VP8 RTP via FrameGrabber; here we skip that (it's
 * proven by the face processor) and instead feed the SAME inference path live
 * webcam frames, so you can watch continuous tier-1 perception stream: each tick
 * captures a 320×240 frame (the dock's stream res, via ffmpeg), POSTs it to the
 * moondream sidecar, derives presence, and prints the `scene` result the
 * processor would emit — plus presence-transition events.
 *
 * Prereqs: moondream sidecar running (models/moondream/sidecar, :8077) + Ollama.
 *   npx tsx src/dev/vision-watch-live.mts
 */
import { spawn } from 'node:child_process';
import { presentFromText } from '../modules/perception/processors/vision-watch.js';

const SIDECAR = process.env.MOONDREAM_SIDECAR_URL ?? 'http://127.0.0.1:8077';
const INSTRUCTION = 'What person is in the image, and what are they doing? Describe briefly.';
const INTERVAL_MS = 1500;
const CAMERA = process.env.CAMERA ?? '0';

function captureFrame(): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const ff = spawn('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-f', 'avfoundation',
      '-framerate', '30', '-i', CAMERA, '-frames:v', '1',
      '-vf', 'scale=320:240', '-q:v', '5', '-f', 'image2', 'pipe:1',
    ]);
    const chunks: Buffer[] = [];
    ff.stdout.on('data', (c) => chunks.push(c));
    ff.on('error', reject);
    ff.on('close', (code) =>
      code === 0 && chunks.length ? resolve(Buffer.concat(chunks)) : reject(new Error(`ffmpeg ${code}`)));
  });
}

async function infer(jpeg: Buffer): Promise<string | null> {
  try {
    const r = await fetch(`${SIDECAR}/infer`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ image_b64: jpeg.toString('base64'), instruction: INSTRUCTION }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!r.ok) return null;
    return ((await r.json()) as { answer?: string }).answer?.trim() || null;
  } catch { return null; }
}

// stand-in for the hub: print what the processor would emit / publish.
const ctx = {
  emit: (r: any) => console.log(`  emit scene: present=${r.payload.present} conf=${r.confidence}\n    "${r.payload.description}"`),
  publish: (ch: string, p: any) => console.log(`  >> EVENT ${ch}: present=${p.present}`),
};

async function main() {
  try { await fetch(`${SIDECAR}/health`); }
  catch { console.error(`sidecar not up at ${SIDECAR} — run models/moondream/sidecar/sidecar.py`); process.exit(1); }

  console.log(`vision-watch LIVE — webcam #${CAMERA} → moondream @320×240, every ${INTERVAL_MS}ms. Ctrl-C to stop.\n`);
  let lastPresent: boolean | null = null;
  let busy = false;
  setInterval(async () => {
    if (busy) return;
    busy = true;
    try {
      const jpeg = await captureFrame();
      const t0 = performance.now();
      const answer = await infer(jpeg);
      const ms = Math.round(performance.now() - t0);
      if (!answer) { console.log(`[${new Date().toLocaleTimeString()}] (no answer)`); return; }
      const present = presentFromText(answer);
      console.log(`[${new Date().toLocaleTimeString()}] ${ms}ms`);
      ctx.emit({ kind: 'scene', source: 'vision-watch', payload: { description: answer, present }, confidence: present == null ? 0.5 : 0.8 });
      if (present != null && present !== lastPresent) { ctx.publish('vision.present', { present, description: answer }); lastPresent = present; }
    } finally { busy = false; }
  }, INTERVAL_MS);
}
main();

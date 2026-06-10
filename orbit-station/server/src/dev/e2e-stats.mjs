/**
 * Deep getStats probe: opens the Live Wall, watches the dock, and reads the real
 * RTCPeerConnection inbound-rtp stats (bytes/packets received, frames decoded) for
 * BOTH audio and video — proving media actually decodes, not just attaches.
 * Hooks RTCPeerConnection at page-init to capture the pc the app creates.
 */
import { chromium } from 'playwright';

const BASE = process.env.BASE ?? 'http://localhost:8099';
const log = (...a) => console.log('[stats]', ...a);

async function main() {
  const browser = await chromium.launch({
    args: ['--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'],
  });
  const page = await (await browser.newContext()).newPage();

  // Capture every RTCPeerConnection the app constructs, before app code runs.
  await page.addInitScript(() => {
    window.__pcs = [];
    const Orig = window.RTCPeerConnection;
    window.RTCPeerConnection = function (...args) {
      const pc = new Orig(...args);
      window.__pcs.push(pc);
      return pc;
    };
    window.RTCPeerConnection.prototype = Orig.prototype;
  });

  await page.goto(`${BASE}/#live`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1500);

  const cb = page.locator('input[type="checkbox"]').first();
  await cb.waitFor({ state: 'visible', timeout: 15000 });
  await cb.check();
  log('watching; letting media flow for 14s…');
  await page.waitForTimeout(14000);

  const stats = await page.evaluate(async () => {
    const pc = (window.__pcs ?? []).at(-1);
    if (!pc) return { error: 'no pc captured' };
    const report = await pc.getStats();
    const out = { audio: null, video: null, conn: null };
    report.forEach((s) => {
      if (s.type === 'inbound-rtp' && s.kind === 'audio')
        out.audio = { packets: s.packetsReceived, bytes: s.bytesReceived };
      if (s.type === 'inbound-rtp' && s.kind === 'video')
        out.video = { packets: s.packetsReceived, bytes: s.bytesReceived, framesDecoded: s.framesDecoded, frameWidth: s.frameWidth, frameHeight: s.frameHeight };
      if (s.type === 'candidate-pair' && s.state === 'succeeded')
        out.conn = { rtt: s.currentRoundTripTime };
    });
    return out;
  });

  await browser.close();
  console.log('\n=== getStats (real RTCPeerConnection) ===');
  console.log('audio inbound:', JSON.stringify(stats.audio));
  console.log('video inbound:', JSON.stringify(stats.video));
  console.log('connection   :', JSON.stringify(stats.conn));
  const audioOk = (stats.audio?.packets ?? 0) > 0;
  const videoOk = (stats.video?.framesDecoded ?? 0) > 0;
  console.log(`\naudio flowing: ${audioOk}   video decoding: ${videoOk}`);
  console.log(audioOk && videoOk ? 'PASS: both audio + video decode end-to-end' : (videoOk ? 'PARTIAL: video ok, audio not seen' : 'FAIL'));
  process.exit(audioOk && videoOk ? 0 : 1);
}
main().catch((e) => { console.error('[stats] ERROR:', e.message); process.exit(2); });

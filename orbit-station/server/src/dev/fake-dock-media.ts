/**
 * Fake-dock media producer + headless viewer — a SELF-TEST for the media SFU,
 * NOT part of the running system. Stands in for the node-dock app so the whole
 * server-side path (WS signaling → werift SFU ingest → fan-out → viewer) can be
 * verified end-to-end without a phone or browser.
 *
 *   1. connects to /ws as role 'app' (dock "fake-dock"), builds a werift PC with
 *      an Opus audio track + VP8 video track, pumps synthetic RTP into them, and
 *      runs the producer-offer/answer/ice handshake on the `media` topic.
 *   2. connects a second WS peer as role 'browser', sends `viewer-ready`, answers
 *      the SFU's offer, and counts RTP packets it receives back.
 *
 * PASS = the viewer receives audio (and video) RTP relayed through the station.
 *
 *   npm run dev   (or start) in one shell, then:
 *   STATION_WS=ws://localhost:8199/ws npx tsx src/dev/fake-dock-media.ts
 */

import { WebSocket } from 'ws';
import {
  RTCPeerConnection,
  MediaStreamTrack,
  RtpPacket,
  RtpHeader,
} from 'werift';

const URL = process.env.STATION_WS ?? 'ws://localhost:8099/ws';
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Frame { t: string; topic?: string; kind?: string; payload?: any; id?: string }

/** A station WS peer with topic-scoped publish + a `media` event callback. */
function peer(role: string, id: string, extra: Record<string, unknown>) {
  const ws = new WebSocket(URL, { rejectUnauthorized: false });
  const onMedia: Array<(kind: string, payload: any) => void> = [];
  const ready = new Promise<void>((resolve) => {
    ws.on('open', () => {
      ws.send(JSON.stringify({ t: 'hello', role, id, label: id, ...extra }));
      ws.send(JSON.stringify({ t: 'subscribe', topics: ['media'] }));
      resolve();
    });
  });
  ws.on('message', (data) => {
    let f: Frame;
    try { f = JSON.parse(data.toString()); } catch { return; }
    if (f.t === 'event' && f.topic === 'media') onMedia.forEach((cb) => cb(f.kind!, f.payload));
  });
  ws.on('error', (e) => console.error(`[${id}]`, (e as Error).message));
  const publish = (kind: string, payload: unknown) =>
    ws.send(JSON.stringify({ t: 'publish', topic: 'media', kind, payload }));
  return { ws, ready, publish, onMedia: (cb: (k: string, p: any) => void) => onMedia.push(cb) };
}

/** Drive synthetic RTP into a track at a fixed packet rate. */
function pump(track: MediaStreamTrack, payloadType: number, tsStep: number, intervalMs: number, ssrc: number) {
  let seq = 0, ts = 0;
  return setInterval(() => {
    const hdr = new RtpHeader({ payloadType, sequenceNumber: seq++ & 0xffff, timestamp: (ts += tsStep) >>> 0, ssrc });
    try { track.writeRtp(new RtpPacket(hdr, Buffer.alloc(120, 0xab))); } catch { /* pre-connect */ }
  }, intervalMs);
}

async function main() {
  // ── producer: the fake dock ────────────────────────────────────────────────
  const dock = peer('app', 'fake-dock-app', { dock: 'fake-dock' });
  await dock.ready;

  const prodPc = new RTCPeerConnection({});
  const audio = new MediaStreamTrack({ kind: 'audio' });
  const video = new MediaStreamTrack({ kind: 'video' });
  prodPc.addTrack(audio);
  prodPc.addTrack(video);

  prodPc.onIceCandidate.subscribe((c) => { if (c) dock.publish('producer-ice', { candidate: c.toJSON() }); });
  dock.onMedia((kind, p) => {
    if (kind === 'producer-answer' && p?.sdp) void prodPc.setRemoteDescription({ type: 'answer', sdp: p.sdp });
    else if (kind === 'producer-ice' && p?.candidate) void prodPc.addIceCandidate(p.candidate).catch(() => {});
  });

  const offer = await prodPc.createOffer();
  await prodPc.setLocalDescription(offer);
  dock.publish('producer-offer', { label: 'fake-dock', sdp: prodPc.localDescription?.sdp });
  console.log('[producer] offer sent; pumping audio+video RTP');
  const aTimer = pump(audio, 96, 960, 20, 1111);   // ~50 pkt/s, Opus-ish
  const vTimer = pump(video, 97, 3000, 66, 2222);  // ~15 pkt/s, VP8-ish

  await wait(1500);

  // ── viewer: a headless browser ─────────────────────────────────────────────
  const view = peer('browser', 'fake-viewer', {});
  await view.ready;

  const viewPc = new RTCPeerConnection({});
  let audioRtp = 0, videoRtp = 0;
  viewPc.onTrack.subscribe((t) => {
    console.log('[viewer] received track:', t.kind);
    t.onReceiveRtp.subscribe(() => { if (t.kind === 'audio') audioRtp++; else videoRtp++; });
  });
  viewPc.onIceCandidate.subscribe((c) => { if (c) view.publish('viewer-ice', { candidate: c.toJSON() }); });
  view.onMedia((kind, p) => {
    if (p?.streamId !== 'fake-dock-app') return;
    if (kind === 'viewer-offer' && p?.sdp) {
      void (async () => {
        await viewPc.setRemoteDescription({ type: 'offer', sdp: p.sdp });
        const ans = await viewPc.createAnswer();
        await viewPc.setLocalDescription(ans);
        view.publish('viewer-answer', { streamId: 'fake-dock-app', sdp: viewPc.localDescription?.sdp });
      })();
    } else if (kind === 'viewer-ice' && p?.candidate) {
      void viewPc.addIceCandidate(p.candidate).catch(() => {});
    }
  });
  view.publish('viewer-ready', { streamId: 'fake-dock-app' });
  console.log('[viewer] viewer-ready sent (streamId=fake-dock)');

  await wait(4000);
  clearInterval(aTimer); clearInterval(vTimer);

  console.log('\n=== RESULT (relayed through the real station WS + SFU) ===');
  console.log('viewer audio RTP packets:', audioRtp);
  console.log('viewer video RTP packets:', videoRtp);
  const pass = audioRtp > 0 && videoRtp > 0;
  console.log(pass ? '\nPASS: audio+video relayed dock → SFU → viewer' : '\nFAIL: media did not reach the viewer');

  dock.ws.close(); view.ws.close();
  await prodPc.close(); await viewPc.close();
  process.exit(pass ? 0 : 1);
}

main().catch((e) => { console.error('ERROR:', e); process.exit(2); });

/**
 * Example media-processing SIDECAR (separate box). Receives the station's
 * ForwardingTap UDP stream and reports per-(streamId,kind) RTP arrival — stand-in
 * for real STT/vision/recording. NOT part of the running system.
 *
 * Run the sidecar, then point the station at it:
 *   node src/dev/media-sidecar.mjs            # listens on udp://0.0.0.0:5004
 *   MEDIA_SINK=udp://127.0.0.1:5004 npm start  # (in orbit-station) tap forwards here
 *
 * Wire framing (see modules/media/tap.ts → ForwardingTap):
 *   byte0      kind (0=audio, 1=video)
 *   byte1      streamId length L
 *   [2..2+L)   streamId (utf-8)
 *   [2+L..]    the serialized RTP packet (header + encoded payload)
 *
 * A real sidecar would reassemble each (streamId,kind) RTP flow and decode it —
 * the encoded payload is VP8 (video) / Opus (audio). The standard move is to feed
 * the RTP straight into ffmpeg/GStreamer, e.g. write an SDP and:
 *   ffmpeg -protocol_whitelist file,udp,rtp -i stream.sdp -f s16le - | your-stt
 * Here we just count packets and print a heartbeat so you can see media arriving.
 */
import { createSocket } from 'node:dgram';

const PORT = Number(process.env.PORT ?? 5004);
const KIND = ['audio', 'video'];
const stats = new Map(); // "streamId|kind" -> { packets, bytes, lastSeq }

const sock = createSocket('udp4');
sock.on('message', (msg) => {
  const kind = KIND[msg[0]] ?? 'audio';
  const idLen = msg[1];
  const streamId = msg.subarray(2, 2 + idLen).toString('utf-8');
  const rtp = msg.subarray(2 + idLen); // serialized RTP — hand to your decoder
  const key = `${streamId}|${kind}`;
  const s = stats.get(key) ?? { packets: 0, bytes: 0 };
  s.packets++; s.bytes += rtp.length;
  stats.set(key, s);
  // === YOUR PROCESSING HERE ===
  // e.g. push `rtp` into a per-key jitter buffer → depacketize → decode → STT/CV.
});
sock.on('listening', () => console.log(`[sidecar] listening udp://0.0.0.0:${PORT} — waiting for the station's MEDIA_SINK forward…`));
sock.bind(PORT);

// Heartbeat so you can watch media flow in.
setInterval(() => {
  if (stats.size === 0) return;
  const lines = [...stats.entries()].map(([k, s]) => `  ${k}: ${s.packets} pkt / ${(s.bytes / 1024).toFixed(1)} KB`);
  console.log(`[sidecar] streams:\n${lines.join('\n')}`);
}, 3000);

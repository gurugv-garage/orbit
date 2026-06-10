# orbit — Processing a live media stream

> How to **tap a dock's live audio/video** for processing — STT, vision,
> recording, anything — either **in the same process** as orbit-station or in a
> **separate box / sidecar**. This is the reason the media path runs through a
> server-side SFU (orbit-station/server/src/modules/media) instead of going
> peer-to-peer: every producer's media passes through one place, so a processor
> can observe it without the dock or the browser viewers being involved.
>
> Code: `modules/media/tap.ts` (the seam), `modules/media/sfu.ts` (calls it),
> `modules/media/index.ts` (wires it). Runnable sidecar: `src/dev/media-sidecar.mjs`.

---

## 0. Where the tap sits

```
 dock app ──RTP──▶  station SFU (werift)  ──RTP──▶  browser viewers
                          │
                          │ same inbound RTP, per producer
                          ▼
                       MediaTap  ──▶  your processing (STT / vision / record)
```

When a dock's track arrives, the SFU calls `tap.onTrack(streamId, kind, track)`
once; the tap subscribes to `track.onReceiveRtp` and sees **every inbound RTP
packet** — the exact packets the SFU forwards to viewers. `streamId` is the dock's
unique producer id (so multiple docks are distinguishable); `kind` is
`'audio'` (Opus) or `'video'` (VP8). On producer disconnect the SFU calls
`tap.onProducerGone(streamId)` so the tap can flush/close per-stream resources.

The contract is one small interface (`MediaTap` in `tap.ts`); everything below is
just two implementations of it.

---

## 1. Same box — process inside orbit-station

Use when the processing is light, or you want to decode with werift right here.
Construct an `InProcessTap` with a callback and pass it to the SFU. In
`modules/media/index.ts`:

```ts
import { InProcessTap } from './tap.js';

// inside init():
const tap = new InProcessTap((streamId, kind, rtp) => {
  // rtp.payload is the ENCODED frame (VP8 / Opus). rtp.header has seq/timestamp.
  // Light work only — this runs on the main event loop.
  // e.g. count, or post the Buffer to a worker_thread for decode + ML.
});
sfu = new Sfu({ signal, tap });
```

To get **decoded samples/frames** (not encoded RTP), use werift's `nonstandard`
helpers in the callback — `dePacketizeRtpPackets` turns RTP into encoded frames,
and `MediaRecorder` writes WebM/MP4:

```ts
import { MediaRecorder } from 'werift/nonstandard';
// per streamId: new MediaRecorder([...tracks], `/tmp/${streamId}.webm`)
```

> ⚠ **Threading.** The callback is on Node's single main thread, shared with the
> WS hub and every other module. Decoding + ML there will stall media for all
> viewers. Keep the callback to buffering/handoff and do heavy work in a
> `worker_thread` (or move to a sidecar, §2). At the dock's envelope (~60 pkt/s)
> a counter or a `worker.postMessage(buffer)` is free; an inline Whisper call is
> not. See the "Load on the single Node thread" note in the plan.

---

## 2. Separate box — forward to a sidecar

Use when processing is heavy (GPU STT/vision), needs another language
(Python/Go), or should run on a different machine. The `ForwardingTap` serializes
each RTP packet and sends it over **UDP** to a sidecar; the station stays light
and non-blocking (UDP drops under a slow consumer rather than back-pressuring the
media path).

Turn it on with an env var — **no code change**:

```bash
# the sidecar (any box on the network)
node src/dev/media-sidecar.mjs                 # listens udp://0.0.0.0:5004

# the station, pointed at it
MEDIA_SINK=udp://<sidecar-host>:5004 npm start  # tap forwards every packet there
```

`tapFromEnv()` (already wired in `index.ts`) reads `MEDIA_SINK` and builds the
`ForwardingTap` when it's set; unset = no processing.

### Wire framing

Each datagram is one RTP packet with a tiny prefix so the sidecar knows which
stream it belongs to:

```
 byte 0      kind          0 = audio (Opus), 1 = video (VP8)
 byte 1      streamId len  L
 [2 .. 2+L)  streamId      utf-8 (the dock's producer id)
 [2+L .. ]   RTP packet    serialized (header + encoded payload)
```

### Decoding in the sidecar

The forwarded bytes are standard RTP, so a sidecar reassembles per-(streamId,kind)
flows and feeds them to any RTP-aware decoder. The pragmatic path is **ffmpeg /
GStreamer**, which take RTP directly — write a one-line SDP per stream and:

```bash
# audio (Opus) → 16 kHz mono PCM on stdout → your STT
ffmpeg -protocol_whitelist file,udp,rtp -i opus.sdp -ar 16000 -ac 1 -f s16le -
# video (VP8) → raw frames → your vision model
ffmpeg -protocol_whitelist file,udp,rtp -i vp8.sdp  -f rawvideo -pix_fmt rgb24 -
```

A minimal Python sidecar skeleton (parse framing → per-stream depacketize/decode):

```python
import socket
sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
sock.bind(("0.0.0.0", 5004))
while True:
    data, _ = sock.recvfrom(2048)
    kind = "audio" if data[0] == 0 else "video"
    L = data[1]
    stream_id = data[2:2+L].decode()
    rtp = data[2+L:]                      # serialized RTP → your jitter buffer/decoder
    # feed (stream_id, kind, rtp) into your STT / vision pipeline
```

`src/dev/media-sidecar.mjs` is a runnable Node version that parses the framing and
prints per-stream packet/byte counts — start there to confirm media is arriving,
then replace the body with your decoder.

---

## 3. Choosing

| | Same box (`InProcessTap`) | Separate box (`ForwardingTap`) |
|---|---|---|
| Setup | construct in `index.ts` with a callback | set `MEDIA_SINK`, run a sidecar |
| Cost | shares the station's event loop | off this machine entirely |
| Decode | werift `nonstandard`, or worker_thread | ffmpeg/GStreamer in any language |
| Use for | light taps, recording, quick prototypes | GPU STT/vision, Python/Go ML, scale |
| Risk | blocking the loop → stalls all viewers | a network hop + UDP loss tolerance |

Both implement the same `MediaTap` interface, so you can start in-process and move
to a sidecar later by swapping which tap `index.ts` constructs — the SFU,
signaling, dock, and browser are untouched. This mirrors the module's own
"process-portable" design (the whole `media` module can move to a sidecar too; see
plan.md "Design rule").

---

## Decision log

- **Tap inbound RTP, not decoded frames** — the SFU already has the encoded RTP
  with zero extra cost; decoding is the processor's choice (and the expensive
  part, which we keep out of the station). A tap that wanted samples can decode
  with werift `nonstandard` or ffmpeg.
- **UDP for the sidecar forward** — real-time media wants drop-on-overload, not
  back-pressure; UDP keeps the station's event loop free of a slow consumer. A
  TCP/WS variant (reliable, ordered, with per-stream session close in
  `onProducerGone`) is a drop-in alternative if loss matters more than latency.
- **Env-selected (`MEDIA_SINK`)** — deployment picks where processing runs, not
  code; the station ships with no processor and gains one by configuration.
```

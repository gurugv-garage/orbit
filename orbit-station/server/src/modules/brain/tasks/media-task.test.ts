/**
 * Media capability, end to end with REAL decode — a committed VP8 video file is
 * fed into the REAL FrameGrabber (depacketize + ffmpeg → JPEG), exposed through
 * the REAL capability registry + broker, and a REAL task process pulls it via
 * this.frame(). Nothing internal is mocked: the only stand-in is the SOURCE (an
 * .ivf file instead of a phone's live WebRTC), which is the whole point — we test
 * the actual pipeline a vision task depends on.
 *
 * (Requires ffmpeg on PATH, same as production frame-grab.)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Bus } from '../../../core/bus.js';
import { WebSocketGateway } from '../../../core/websocket-gateway.js';
import { TaskSupervisor, type SignalKind } from './supervisor.js';
import { CapabilityBroker } from './capabilities.js';
import { buildCapabilityRegistry } from './register-capabilities.js';
import { faceRecognitionProcessor } from '../../perception/processors/face-recognition.js';
import { Gallery } from '../../perception/face/gallery.js';
import { defaultTasksRoot } from './manager.js';
import { ivfToRtp } from '../../../dev/ivf-producer.js';

const DOCK = 'media-bot';
const STREAM = 'media-bot-stream';
const FIXTURE = join(fileURLToPath(new URL('./__fixtures__/testclip.ivf', import.meta.url)));
const tick = () => new Promise((r) => setTimeout(r, 25));

test('a task pulls a REAL decoded camera frame (committed VP8 file → grabber → frame())', async () => {
  // ── real perception: feed the committed .ivf into the REAL FrameGrabber ──────
  const gallery = new Gallery(join(mkdtempSync(join(tmpdir(), 'gal-')), 'gallery.json'));
  const face = faceRecognitionProcessor(gallery);
  face.onStreamStart({ streamId: STREAM, dockId: DOCK, emit: () => {} } as never);
  // pump the file's frames as VP8 RTP (the grabber decodes ~real fps); re-pump on a
  // timer so a fresh frame stays within the grabber's freshness window.
  const packets = ivfToRtp(FIXTURE);
  const pump = () => { for (const p of packets) face.onRtp?.(STREAM, 'video', p); };
  pump();
  const pumper = setInterval(pump, 400);

  // ── real station: WebSocketGateway + Bus + supervisor + capability broker ─────────────────
  const http = await new Promise<Server>((res) => { const s = createServer(); s.listen(0, '127.0.0.1', () => res(s)); });
  const port = (http.address() as { port: number }).port;
  const bus = new Bus();
  const hub = new WebSocketGateway(http, bus);
  const signals: Array<{ kind: SignalKind; text: string }> = [];
  const sendToTask = (dock: string, instanceId: string, kind: string, payload: Record<string, unknown>) =>
    bus.publish({ topic: 'tasks', kind, payload: { instanceId, ...payload }, source: 'station', toAddr: { dock, component: `task:${instanceId}` } });
  const supervisor = new TaskSupervisor({
    root: mkdtempSync(join(tmpdir(), 'media-')), stationWsUrl: `ws://127.0.0.1:${port}/ws`,
    onSignal: (_d, _i, kind, ev) => signals.push({ kind, text: ev.text }), sendToTask,
  });

  // REAL capability registry: dock has 'camera' resolving to our STREAM id, and the
  // real FaceTools.frame(streamId) reads the grabber's latest decoded JPEG.
  const directory = {
    resolveCap: (dock: string, cap: string) =>
      dock === DOCK && cap === 'camera' ? { id: STREAM } : undefined,
  } as never;
  const getFaces = () => ({ frame: (id: string) => face.currentFrame(id)?.toString('base64') } as never);
  const registry = buildCapabilityRegistry({
    directory, motion: {} as never, getFaces, getPerceive: () => undefined,
    getGestures: () => ({}),
    msSinceSalient: () => null, enqueueThought: () => {},
  });
  const broker = new CapabilityBroker(registry, sendToTask);

  bus.on('tasks', (msg) => {
    if (msg.source === 'station') return;
    const dock = hub.roster().find((p) => p.id === msg.source)?.dock;
    if (!dock) return;
    const p = (msg.payload ?? {}) as Record<string, unknown>;
    const instanceId = typeof p.instanceId === 'string' ? p.instanceId : '';
    if (!instanceId) return;
    if (msg.kind === 'request') { void broker.handle(dock, instanceId, p); return; }
    supervisor.onFrame(dock, { instanceId, kind: msg.kind, payload: p });
  });

  // ── a REAL task process pulls the frame + reports what it got ────────────────
  const dir = mkdtempSync(join(tmpdir(), 'mfix-'));
  const harness = join(defaultTasksRoot(), '..', '_harness', 'index.js');
  writeFileSync(join(dir, 'task.ts'), `import { Task, runTask, type TaskManifest } from '${harness}';
export const manifest = { name: 'm', description: 'x', params: [] } satisfies TaskManifest;
class M extends Task {
  async run(): Promise<void> {
    // poll until the grabber has produced a frame (ffmpeg + keyframe take a beat).
    let img: string | undefined;
    for (let i = 0; i < 40 && !img; i++) { img = await this.frame(); if (!img) await this.sleep(250); }
    const jpeg = img && Buffer.from(img, 'base64').subarray(0, 3).toString('hex') === 'ffd8ff';
    await this.notifyAgent('frame ' + (img ? img.length + 'b jpeg=' + jpeg : 'NONE'));
    this.finish();
  }
  getStatus(): string { return 'grabbing'; }
}
runTask(M);`);
  const id = supervisor.start({ dock: DOCK, name: 'm', filePath: join(dir, 'task.ts'), params: {}, parentSessionId: 'sess-m' });

  // wait for the task to report (real process boot + real decode)
  for (let i = 0; i < 800 && !signals.some((s) => s.kind === 'finish'); i++) await tick();

  const note = signals.find((s) => s.kind === 'notify');
  assert.ok(note, 'the task reported back');
  assert.match(note!.text, /jpeg=true/, 'this.frame() returned a REAL decoded JPEG from the video file');
  assert.equal(supervisor.get(id)?.state, 'done');

  // cleanup
  supervisor.stop(id);
  clearInterval(pumper);
  face.onStreamEnd?.(STREAM);
  rmSync(dir, { recursive: true, force: true });
  await new Promise<void>((r) => http.close(() => r()));
});

/**
 * SFU engine unit tests (node:test). These exercise the multi-producer / multi-
 * viewer signaling logic with a fake signal sink and real werift PeerConnections
 * (offer/answer creation is fast and needs no ICE). We assert on what the SFU
 * emits and its status() bookkeeping — not on live RTP (that's the manual
 * end-to-end self-test, `npm run smoke:media`).
 *
 *   npm test --workspace server
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RTCPeerConnection, MediaStreamTrack } from 'werift';
import { Sfu } from './sfu.js';

interface Sig { kind: string; payload: any; to: string }

/** A test harness: an Sfu wired to a recording signal sink. */
function harness() {
  const sent: Sig[] = [];
  const sfu = new Sfu({ signal: (kind, payload, to) => sent.push({ kind, payload, to }) });
  return {
    sfu,
    sent,
    /** the most recent signal of a kind (optionally to a peer). */
    last: (kind: string, to?: string) =>
      [...sent].reverse().find((s) => s.kind === kind && (to == null || s.to === to)),
    sentTo: (to: string) => sent.filter((s) => s.to === to),
    clear: () => { sent.length = 0; },
  };
}

/** Make a real SDP offer carrying audio+video sendonly, as a dock would. */
async function dockOffer(withTracks = true): Promise<string> {
  const pc = new RTCPeerConnection({});
  if (withTracks) {
    pc.addTrack(new MediaStreamTrack({ kind: 'audio' }));
    pc.addTrack(new MediaStreamTrack({ kind: 'video' }));
  } else {
    pc.addTransceiver('audio', { direction: 'sendonly' });
  }
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  const sdp = pc.localDescription!.sdp;
  await pc.close();
  return sdp;
}

const tick = () => new Promise((r) => setTimeout(r, 30));

test('producer offer → answer is sent back, directed to the dock', async () => {
  const h = harness();
  await h.sfu.onProducerOffer('anne-app', { label: 'anne-bot', sdp: await dockOffer() });

  const answer = h.last('producer-answer', 'anne-app');
  assert.ok(answer, 'producer-answer emitted to the dock');
  assert.equal(answer!.payload.streamId, 'anne-app', 'streamId is the dock peer id');
  assert.match(answer!.payload.sdp, /v=0/, 'carries an SDP answer');

  const st = h.sfu.status();
  assert.equal(st.producers.length, 1);
  assert.equal(st.producers[0]!.streamId, 'anne-app');
  assert.equal(st.producers[0]!.label, 'anne-bot', 'dock name kept as display label');
});

test('streamId is the unique peer id — two docks with the SAME name do not collide', async () => {
  const h = harness();
  // both flashed DOCK_NAME=anne-bot, but distinct peer ids
  await h.sfu.onProducerOffer('phone-1', { label: 'anne-bot', sdp: await dockOffer() });
  await h.sfu.onProducerOffer('phone-2', { label: 'anne-bot', sdp: await dockOffer() });

  const st = h.sfu.status();
  assert.equal(st.producers.length, 2, 'both producers coexist');
  const ids = st.producers.map((p) => p.streamId).sort();
  assert.deepEqual(ids, ['phone-1', 'phone-2']);
  assert.ok(st.producers.every((p) => p.label === 'anne-bot'), 'same display label, distinct streams');
});

test('same peer re-offering replaces its own producer (reconnect), not others', async () => {
  const h = harness();
  await h.sfu.onProducerOffer('beta', { label: 'beta', sdp: await dockOffer() });
  await h.sfu.onProducerOffer('alpha', { label: 'alpha', sdp: await dockOffer() });
  assert.equal(h.sfu.status().producers.length, 2);

  // alpha reconnects
  await h.sfu.onProducerOffer('alpha', { label: 'alpha', sdp: await dockOffer() });
  const st = h.sfu.status();
  assert.equal(st.producers.length, 2, 'still two — alpha replaced itself');
  assert.ok(st.producers.some((p) => p.streamId === 'beta'), 'beta untouched');
});

test('viewer joining BEFORE a producer is queued, then offered when tracks arrive', async () => {
  const h = harness();
  // viewer asks first — no producer yet
  h.sfu.onViewerReady('ui-1', { streamId: 'anne-app' });
  assert.equal(h.sfu.status().waiting.length, 1, 'viewer is waiting');
  assert.ok(!h.last('viewer-offer', 'ui-1'), 'no offer yet');

  // producer arrives with tracks
  await h.sfu.onProducerOffer('anne-app', { label: 'anne-bot', sdp: await dockOffer() });
  await tick(); // let onTrack fire + admitWaiting run

  assert.ok(h.last('viewer-offer', 'ui-1'), 'waiting viewer got an offer once tracks arrived');
  const st = h.sfu.status();
  assert.equal(st.waiting.length, 0, 'no longer waiting');
  assert.ok(st.viewers.includes('ui-1|anne-app'), 'viewer registered for the stream');
});

test('viewer joining AFTER a producer gets an offer immediately', async () => {
  const h = harness();
  await h.sfu.onProducerOffer('anne-app', { label: 'anne-bot', sdp: await dockOffer() });
  await tick();
  h.clear();

  h.sfu.onViewerReady('ui-2', { streamId: 'anne-app' });
  await tick();
  const offer = h.last('viewer-offer', 'ui-2');
  assert.ok(offer, 'viewer-offer emitted to the browser');
  assert.equal(offer!.payload.streamId, 'anne-app');
});

test('viewer-ready without a streamId is ignored (browser must pick a dock)', async () => {
  const h = harness();
  await h.sfu.onProducerOffer('anne-app', { label: 'anne-bot', sdp: await dockOffer() });
  await tick();
  h.clear();

  h.sfu.onViewerReady('ui-3', {});      // no streamId
  h.sfu.onViewerReady('ui-3', null);    // no payload
  await tick();
  assert.equal(h.sfu.status().viewers.length, 0, 'nothing joined');
  assert.ok(!h.last('viewer-offer'), 'no offer sent');
});

test('two viewers can watch the same stream independently (fan-out)', async () => {
  const h = harness();
  await h.sfu.onProducerOffer('anne-app', { label: 'anne-bot', sdp: await dockOffer() });
  await tick();

  h.sfu.onViewerReady('ui-a', { streamId: 'anne-app' });
  h.sfu.onViewerReady('ui-b', { streamId: 'anne-app' });
  await tick();

  assert.ok(h.last('viewer-offer', 'ui-a'), 'ui-a offered');
  assert.ok(h.last('viewer-offer', 'ui-b'), 'ui-b offered');
  const st = h.sfu.status();
  assert.equal(st.producers[0]!.viewers, 2, 'producer reports 2 viewers');
});

test('one browser can watch multiple docks at once (grid)', async () => {
  const h = harness();
  await h.sfu.onProducerOffer('alpha', { label: 'alpha', sdp: await dockOffer() });
  await h.sfu.onProducerOffer('beta', { label: 'beta', sdp: await dockOffer() });
  await tick();

  h.sfu.onViewerReady('ui-1', { streamId: 'alpha' });
  h.sfu.onViewerReady('ui-1', { streamId: 'beta' });
  await tick();

  const st = h.sfu.status();
  assert.ok(st.viewers.includes('ui-1|alpha'));
  assert.ok(st.viewers.includes('ui-1|beta'));
  assert.equal(st.viewers.length, 2, 'same browser, two streams');
});

test('viewer-leave drops just that (browser, stream) pair', async () => {
  const h = harness();
  await h.sfu.onProducerOffer('alpha', { label: 'alpha', sdp: await dockOffer() });
  await h.sfu.onProducerOffer('beta', { label: 'beta', sdp: await dockOffer() });
  await tick();
  h.sfu.onViewerReady('ui-1', { streamId: 'alpha' });
  h.sfu.onViewerReady('ui-1', { streamId: 'beta' });
  await tick();

  h.sfu.onViewerLeave('ui-1', { streamId: 'alpha' });
  const st = h.sfu.status();
  assert.ok(!st.viewers.includes('ui-1|alpha'), 'alpha dropped');
  assert.ok(st.viewers.includes('ui-1|beta'), 'beta kept');
});

test('producer bye/disconnect tears down its viewers, leaves other docks alone', async () => {
  const h = harness();
  await h.sfu.onProducerOffer('alpha', { label: 'alpha', sdp: await dockOffer() });
  await h.sfu.onProducerOffer('beta', { label: 'beta', sdp: await dockOffer() });
  await tick();
  h.sfu.onViewerReady('ui-1', { streamId: 'alpha' });
  h.sfu.onViewerReady('ui-2', { streamId: 'beta' });
  await tick();

  h.sfu.onBye('alpha'); // alpha's phone dropped
  const st = h.sfu.status();
  assert.ok(!st.producers.some((p) => p.streamId === 'alpha'), 'alpha producer gone');
  assert.ok(!st.viewers.includes('ui-1|alpha'), 'its viewer torn down');
  assert.ok(st.producers.some((p) => p.streamId === 'beta'), 'beta producer intact');
  assert.ok(st.viewers.includes('ui-2|beta'), 'beta viewer intact');
});

test('browser disconnect (bye) drops all of that browser\'s viewers', async () => {
  const h = harness();
  await h.sfu.onProducerOffer('alpha', { label: 'alpha', sdp: await dockOffer() });
  await h.sfu.onProducerOffer('beta', { label: 'beta', sdp: await dockOffer() });
  await tick();
  h.sfu.onViewerReady('ui-1', { streamId: 'alpha' });
  h.sfu.onViewerReady('ui-1', { streamId: 'beta' });
  await tick();

  h.sfu.onBye('ui-1');
  assert.equal(h.sfu.status().viewers.length, 0, 'all of ui-1 gone');
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SnapshotStore, makeSnapshot } from './snapshots.js';

function speechRec(text: string, fromMs = 0) {
  return makeSnapshot({
    dockId: 'd1',
    source: { id: 's1', kind: 'speech', device: 'dock-webrtc', host: 'station' },
    model: { name: 'whisper-small.en-mlx', endpoint: 'local' },
    from: new Date(fromMs), to: new Date(fromMs + 1000),
    payload: { text, lowConfidence: false },
  });
}

// The background-STT upgrade path: a snapshot lands with Whisper text, then update()
// patches it in place with the better diarized transcript + speaker (+ re-notifies).
test('SnapshotStore.update patches a record in place and re-notifies', () => {
  const store = new SnapshotStore();
  const seen: string[] = [];
  store.subscribe((r) => seen.push((r.payload as { text: string }).text));

  const rec = speechRec('mai rite is like you do not'); // garbled Whisper text
  store.add(rec);

  const ok = store.update(rec, { text: 'S0: My right is that you do not', speaker: 0, bgModel: true });
  assert.equal(ok, true, 'record found + patched');

  const stored = store.list().find((r) => r === rec)!;
  assert.equal((stored.payload as { text: string }).text, 'S0: My right is that you do not', 'text upgraded');
  assert.equal((stored.payload as { speaker?: number }).speaker, 0, 'speaker stored');
  assert.equal((stored.payload as { bgModel?: boolean }).bgModel, true, 'bgModel flag set');
  // listeners fired twice: once on add, once on update.
  assert.deepEqual(seen, ['mai rite is like you do not', 'S0: My right is that you do not']);
});

test('SnapshotStore.update on a missing record is a safe no-op', () => {
  const store = new SnapshotStore();
  const orphan = speechRec('never added');
  assert.equal(store.update(orphan, { text: 'x' }), false, 'returns false, no throw');
});

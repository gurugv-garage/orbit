import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Directory } from './directory.js';
import type { RosterEntry } from '../../core/hub.js';

function peer(p: Partial<RosterEntry> & { dock: string; component: string }): RosterEntry {
  return {
    role: 'device', id: `${p.dock}-${p.component}`, lastSeen: Date.now(),
    connectedAt: Date.now(), topics: [], ...p,
  } as RosterEntry;
}

function tmpFile(): string {
  return join(mkdtempSync(join(tmpdir(), 'docks-')), 'docks.json');
}

test('task peers are not learned as dock components', () => {
  const roster: RosterEntry[] = [
    peer({ dock: 'anne-bot', component: 'phone' }),
    peer({ dock: 'anne-bot', component: 'task:t-1234', role: 'task' }),
  ];
  const dir = new Directory(() => roster, tmpFile());
  for (const p of roster) dir.noteSeen(p);

  const info = dir.dockInfo('anne-bot');
  const slots = info.components.map((c) => c.component);
  assert.deepEqual(slots, ['phone'], 'task:* peer must not appear as a dock slot');
  assert.ok(!info.manifest.includes('task:t-1234'), 'task:* never enters the manifest');
});

test('load() prunes already-persisted task:* cruft', () => {
  const file = tmpFile();
  writeFileSync(file, JSON.stringify({
    'anne-bot': {
      manifest: ['phone', 'task:t-aaaa'],
      lastKnown: {
        phone: { component: 'phone', id: 'p', lastSeen: Date.now() },
        'task:t-aaaa': { component: 'task:t-aaaa', id: 't', lastSeen: Date.now() },
      },
    },
  }));
  const dir = new Directory(() => [], file);
  const info = dir.dockInfo('anne-bot');
  assert.deepEqual(info.components.map((c) => c.component), ['phone']);
  // and the cleanup was persisted back to disk
  const onDisk = JSON.parse(readFileSync(file, 'utf8'));
  assert.deepEqual(onDisk['anne-bot'].manifest, ['phone']);
  assert.ok(!('task:t-aaaa' in onDisk['anne-bot'].lastKnown));
});

test('ephemeral peers (loopback, no build) are never persisted', () => {
  const dir = new Directory(() => [], tmpFile());
  // a real LAN phone with a build → persisted
  assert.equal(dir.noteSeen(peer({ dock: 'anne-bot', component: 'phone', ip: '192.168.1.90', build: 3 })), true);
  // a test/web phone from loopback with no build → not persisted
  assert.equal(dir.noteSeen(peer({ dock: 'web-test', component: 'phone', ip: '127.0.0.1' })), false);
  assert.deepEqual(dir.docks().map((d) => d.name), ['anne-bot']);
});

test('a live ephemeral dock still shows while connected, vanishes when its peer is gone', () => {
  let roster: RosterEntry[] = [peer({ dock: 'web-test', component: 'phone', ip: '127.0.0.1' })];
  const dir = new Directory(() => roster, tmpFile());
  dir.noteSeen(roster[0]!); // not persisted, but live
  assert.ok(dir.docks().some((d) => d.name === 'web-test'), 'shows while the peer is live');
  assert.equal(dir.dockExists('web-test'), true);
  roster = []; // peer disconnects
  assert.equal(dir.dockExists('web-test'), false, 'gone once the only peer leaves');
  assert.ok(!dir.docks().some((d) => d.name === 'web-test'));
});

test('forgetComponentEverywhere reaps a device from old docks, keeps exceptDock + siblings', () => {
  const file = tmpFile();
  writeFileSync(file, JSON.stringify({
    // device X haunts two old docks as an offline phone ghost…
    'old-a':   { manifest: ['phone'], lastKnown: { phone: { component: 'phone', id: 'X', ip: '192.168.1.9', build: 3 } } },
    'old-b':   { manifest: ['phone'], lastKnown: { phone: { component: 'phone', id: 'X', ip: '192.168.1.9', build: 3 } } },
    // …and 'keep' has BOTH X's stale phone AND a real body that must survive.
    'keep':    { manifest: ['phone', 'body'], lastKnown: {
      phone: { component: 'phone', id: 'X', ip: '192.168.1.9', build: 3 },
      body:  { component: 'body',  id: 'B', ip: '192.168.1.5', build: 5 },
    } },
    // X's CURRENT dock (it's live here now) — must be left untouched.
    'new-x':   { manifest: ['phone'], lastKnown: { phone: { component: 'phone', id: 'X', ip: '192.168.1.9', build: 3 } } },
  }));
  const dir = new Directory(() => [], file);

  const touched = dir.forgetComponentEverywhere('X', 'new-x').sort();
  assert.deepEqual(touched, ['keep', 'old-a', 'old-b'], 'reaped from every dock except new-x');

  const names = dir.docks().map((d) => d.name).sort();
  assert.ok(!names.includes('old-a'), 'old-a emptied → dropped');
  assert.ok(!names.includes('old-b'), 'old-b emptied → dropped');
  assert.ok(names.includes('new-x'), 'current dock untouched');
  // 'keep' loses the phone ghost but keeps its real body
  const keep = dir.dockInfo('keep');
  assert.deepEqual(keep.components.map((c) => c.component), ['body'], 'phone ghost reaped, body kept');

  // persisted to disk
  const onDisk = JSON.parse(readFileSync(file, 'utf8'));
  assert.ok(!('old-a' in onDisk) && !('old-b' in onDisk), 'emptied docks removed on disk');
  assert.ok(!('phone' in onDisk['keep'].lastKnown), 'keep.phone ghost gone on disk');
  assert.equal(onDisk['new-x'].lastKnown.phone.id, 'X', 'exceptDock preserved on disk');
});

test('pruneEphemeral drops persisted test/web cruft, keeps real + live-real docks', () => {
  const file = tmpFile();
  writeFileSync(file, JSON.stringify({
    'anne-bot':  { manifest: ['phone', 'body'], lastKnown: {
      phone: { component: 'phone', id: 'p', ip: '192.168.1.90', build: 3 },
      body:  { component: 'body',  id: 'b', ip: '192.168.1.5',  build: 5 },
    } },
    'web-test':  { manifest: ['phone'], lastKnown: { phone: { component: 'phone', id: 'p', ip: '127.0.0.1' } } },
    'smoke-task':{ manifest: ['phone'], lastKnown: { phone: { component: 'phone', id: 'p', ip: '127.0.0.1' } } },
    'live-real': { manifest: ['phone'], lastKnown: { phone: { component: 'phone', id: 'p', ip: '127.0.0.1' } } },
  }));
  // live-real has a REAL (LAN + build) peer connected right now → must be kept.
  const roster = [peer({ dock: 'live-real', component: 'body', ip: '10.0.0.4', build: 7 })];
  // pruneEphemeral runs inside the constructor (#load) too; call again is idempotent.
  const dir = new Directory(() => roster, file);
  const gone = dir.pruneEphemeral();
  assert.deepEqual(gone, []); // already pruned on load

  const names = dir.docks().map((d) => d.name).sort();
  assert.ok(names.includes('anne-bot'), 'real dock kept (offline ok)');
  assert.ok(names.includes('live-real'), 'dock with a real live peer kept');
  assert.ok(!names.includes('web-test'), 'web cruft dropped');
  assert.ok(!names.includes('smoke-task'), 'test cruft dropped');
});

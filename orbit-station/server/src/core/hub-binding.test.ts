/**
 * Hub ↔ runtime dock binding (docs/modules/runtime-dock-binding.md).
 *
 * Exercises the real WS path end-to-end against a live Hub:
 *   - a device that dials in with NO dock gets a welcome { dock: null } (UNCLAIMED)
 *   - with a pre-seeded binding, the same hello resolves the dock + a slot
 *     derived from `kind`, echoed in the welcome
 *   - a device that DID carry a dock self-binds (persisted for next time)
 *   - hub.claim() mutates the live peer, persists the binding, announces
 *     peer-updated, and pushes a fresh welcome so the device adopts live
 *
 *   npm test --workspace server
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { WebSocket } from 'ws';
import Database from 'better-sqlite3';
import { Bus, type BusMessage } from './bus.js';
import { Hub } from './hub.js';
import { BindingStore } from '../modules/docks/bindings.js';

interface Rig {
  url: string;
  hub: Hub;
  bus: Bus;
  bindings: BindingStore;
  close: () => Promise<void>;
}

async function makeRig(): Promise<Rig> {
  const http = await new Promise<Server>((resolve) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => resolve(s));
  });
  const port = (http.address() as { port: number }).port;
  const bus = new Bus();
  const bindings = new BindingStore(new Database(':memory:'));
  const hub = new Hub(http, bus, bindings);
  return {
    url: `ws://127.0.0.1:${port}/ws`,
    hub, bus, bindings,
    close: () =>
      new Promise<void>((resolve) => {
        hub.close();
        http.close(() => resolve());
      }),
  };
}

/** Open a WS, send `hello`, and resolve with the first `welcome` frame. */
function helloAndWelcome(
  url: string,
  hello: Record<string, unknown>,
): Promise<{ ws: WebSocket; welcome: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const timer = setTimeout(() => reject(new Error('no welcome in 2s')), 2000);
    ws.on('open', () => ws.send(JSON.stringify({ t: 'hello', ...hello })));
    ws.on('message', (raw) => {
      const f = JSON.parse(raw.toString());
      if (f.t === 'welcome') {
        clearTimeout(timer);
        resolve({ ws, welcome: f });
      }
    });
    ws.on('error', reject);
  });
}

const PHONE = { role: 'device', kind: 'dock-android-app', caps: ['voice', 'face'] };

test('an unbound device dials in UNCLAIMED — welcome carries dock: null', async () => {
  const rig = await makeRig();
  try {
    const { ws, welcome } = await helloAndWelcome(rig.url, { id: 'android-new', ...PHONE });
    assert.equal(welcome.dock, null, 'no binding → unclaimed');
    assert.equal(welcome.component, null);
    ws.close();
  } finally {
    await rig.close();
  }
});

test('a pre-seeded binding resolves on hello — dock + slot derived from kind', async () => {
  const rig = await makeRig();
  try {
    rig.bindings.bind('android-known', 'anne-bot');
    const { ws, welcome } = await helloAndWelcome(rig.url, { id: 'android-known', ...PHONE });
    assert.equal(welcome.dock, 'anne-bot', 'binding resolved');
    assert.equal(welcome.component, 'phone', 'slot derived from dock-android-app');
    ws.close();
  } finally {
    await rig.close();
  }
});

test('a device carrying its own dock (dev override) self-binds for next time', async () => {
  const rig = await makeRig();
  try {
    const { ws } = await helloAndWelcome(rig.url, {
      id: 'android-override', dock: 'lab-dock', component: 'phone', ...PHONE,
    });
    assert.equal(rig.bindings.lookup('android-override'), 'lab-dock', 'self-bound');
    ws.close();
  } finally {
    await rig.close();
  }
});

test('an existing binding WINS over a device-asserted hello.dock (claim is source of truth)', async () => {
  // Regression: a device reinstalled/OTA'd with a stale baked DOCK_NAME used to
  // silently overwrite a console claim. The binding must win and the device
  // must be corrected to the bound name via welcome.
  const rig = await makeRig();
  try {
    rig.bindings.bind('android-claimed', 'dock-tab'); // operator claimed it
    const { ws, welcome } = await helloAndWelcome(rig.url, {
      id: 'android-claimed', dock: 'anne-bot', component: 'phone', ...PHONE, // stale baked name
    });
    assert.equal(welcome.dock, 'dock-tab', 'binding wins over hello.dock');
    assert.equal(rig.bindings.lookup('android-claimed'), 'dock-tab', 'binding NOT overwritten');
    ws.close();
  } finally {
    await rig.close();
  }
});

test('claim() mutates the live peer, persists the binding, announces peer-updated', async () => {
  const rig = await makeRig();
  try {
    const updates: BusMessage[] = [];
    rig.bus.on('station', (m) => { if (m.kind === 'peer-updated') updates.push(m); });

    // Dial in unclaimed, then claim from the "console".
    const { ws } = await helloAndWelcome(rig.url, { id: 'android-claim', ...PHONE });

    // a second welcome is pushed by claim() — capture it
    const reWelcome = new Promise<Record<string, unknown>>((resolve) => {
      ws.on('message', (raw) => {
        const f = JSON.parse(raw.toString());
        if (f.t === 'welcome' && f.dock) resolve(f);
      });
    });

    const claimed = rig.hub.claim('android-claim', 'anne-bot');
    assert.deepEqual(claimed, { dock: 'anne-bot', component: 'phone' });
    assert.equal(rig.bindings.lookup('android-claim'), 'anne-bot', 'binding persisted');

    const w = await reWelcome;
    assert.equal(w.dock, 'anne-bot', 'device learns dock via pushed welcome');
    assert.equal(w.component, 'phone');

    // peer-updated announced so dock-keyed modules re-resolve
    assert.equal(updates.length, 1);
    assert.equal((updates[0]!.payload as { dock?: string }).dock, 'anne-bot');

    // roster now shows the peer as claimed
    const entry = rig.hub.roster().find((p) => p.id === 'android-claim');
    assert.equal(entry?.dock, 'anne-bot');
    assert.equal(entry?.component, 'phone');
    ws.close();
  } finally {
    await rig.close();
  }
});

test('claiming into an occupied slot re-parks the old one UNCLAIMED (welcome{null} before drop — no re-seed loop)', async () => {
  const rig = await makeRig();
  try {
    // Phone X already owns anne-bot/phone.
    rig.bindings.bind('phone-x', 'anne-bot');
    const x = await helloAndWelcome(rig.url, { id: 'phone-x', ...PHONE });
    assert.equal(x.welcome.dock, 'anne-bot');

    // X MUST receive a welcome{dock:null} BEFORE its socket closes — that's what
    // tells the device to clear its cache so it redials unclaimed instead of
    // re-asserting 'anne-bot' and ping-ponging the slot with Y.
    let xGotUnclaimWelcome = false;
    const xClosed = new Promise<void>((resolve) => {
      x.ws.on('message', (raw) => {
        const f = JSON.parse(raw.toString());
        if (f.t === 'welcome' && f.dock === null) xGotUnclaimWelcome = true;
      });
      x.ws.on('close', () => resolve());
    });

    // Phone Y dials in unclaimed, then is claimed into anne-bot (displacing X).
    const y = await helloAndWelcome(rig.url, { id: 'phone-y', ...PHONE });
    assert.equal(y.welcome.dock, null, 'Y starts unclaimed');
    rig.hub.claim('phone-y', 'anne-bot');

    await xClosed;
    assert.ok(xGotUnclaimWelcome, 'X was told dock:null before being dropped');
    assert.equal(rig.bindings.lookup('phone-x'), undefined, 'X binding forgotten');
    assert.equal(rig.hub.roster().find((p) => p.id === 'phone-y')?.dock, 'anne-bot', 'Y owns the slot');

    y.ws.close();
  } finally {
    await rig.close();
  }
});

test('unclaim() re-parks a live peer in place — welcome{null}, dock cleared, binding caller-removed', async () => {
  const rig = await makeRig();
  try {
    rig.bindings.bind('phone-z', 'anne-bot');
    const z = await helloAndWelcome(rig.url, { id: 'phone-z', ...PHONE });
    assert.equal(z.welcome.dock, 'anne-bot');

    const reWelcome = new Promise<Record<string, unknown>>((resolve) => {
      z.ws.on('message', (raw) => {
        const f = JSON.parse(raw.toString());
        if (f.t === 'welcome' && f.dock === null) resolve(f);
      });
    });

    const ok = rig.hub.unclaim('phone-z');
    assert.equal(ok, true, 'live peer was re-parked');
    const w = await reWelcome;
    assert.equal(w.dock, null, 'device told it is now unclaimed');
    assert.equal(rig.hub.roster().find((p) => p.id === 'phone-z')?.dock, undefined, 'roster dock cleared');

    // unclaim() of an offline / unknown id is a no-op false.
    assert.equal(rig.hub.unclaim('nobody'), false);

    z.ws.close();
  } finally {
    await rig.close();
  }
});

test('claim() of an offline device returns undefined but still records the binding via REST path', async () => {
  const rig = await makeRig();
  try {
    assert.equal(rig.hub.claim('ghost-id', 'anne-bot'), undefined, 'no live peer');
  } finally {
    await rig.close();
  }
});

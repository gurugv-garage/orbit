// Playwright E2E: build & announce an app OTA through the browser, then observe
// both online phones take the update while KEEPING their dock names (the whole
// point of runtime dock binding — docs/decision-traces/runtime-dock-binding.md).
//
// Run from orbit-station/:  node scripts/ota-e2e.mjs
import { chromium } from 'playwright';

const BASE = 'http://localhost:8099';
const api = async (p) => (await fetch(`${BASE}${p}`)).json();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

const dockSnapshot = async () => {
  const docks = await api('/api/docks');
  return docks.map((d) => `${d.name}::${d.components.map((c) => `${c.component}(${(c.id||'').slice(0,14)},b${c.build??'?'},${c.online?'on':'off'})`).join('+')}`).join('  |  ');
};
const appPeers = async () => {
  const ota = await api('/api/ota');
  const app = ota.targets.find((t) => t.target === 'app');
  return { artifact: app.artifact?.build, peers: app.peers.map((p) => ({ id: p.id.slice(0,14), dock: p.dock, build: p.build })) };
};

const browser = await chromium.launch();
const page = await browser.newPage();
page.on('console', (m) => { if (m.type() === 'error') log('  [browser-console-error]', m.text()); });

try {
  log('=== BEFORE ===');
  log('docks:', await dockSnapshot());
  log('app  :', JSON.stringify(await appPeers()));

  // 1) Updates page → Build & Announce on the APP card (the 2nd of the two cards).
  await page.goto(`${BASE}/#ota`);
  await page.waitForLoadState('networkidle');
  await sleep(800);
  log('opening app build panel…');
  // Two "Build & Announce" .primary buttons (body, app). nth(1) = app card.
  // Clicking it opens a notes textarea + [Build & Announce confirm] + [Cancel].
  await page.locator('button.primary', { hasText: /Build & Announce/ }).nth(1).click();
  await sleep(400);
  const notes = page.locator('textarea').first();
  if (await notes.count()) await notes.fill('e2e: name-display + binding-precedence + version-sync');
  // The confirm is the primary "Build & Announce" that sits next to Cancel — it's
  // the LAST such primary button now visible (body=0, app-open=1, confirm=2).
  const confirms = page.locator('button.primary', { hasText: /Build & Announce|Starting/ });
  await confirms.last().click();
  log('build confirmed — gradle starting');

  // 2) Poll the API until the artifact build increments (build finished + recorded)
  const startArtifact = (await appPeers()).artifact;
  log(`waiting for app artifact to advance past build ${startArtifact} (gradle ~45-90s)…`);
  let newBuild = startArtifact;
  for (let i = 0; i < 60; i++) {           // up to ~10 min
    await sleep(10000);
    const a = await appPeers();
    if (a.artifact && a.artifact > startArtifact) { newBuild = a.artifact; break; }
    if (i % 3 === 0) log(`  …still building (artifact=${a.artifact})`);
  }
  log(`>>> artifact now build ${newBuild}`);

  // 3) Watch Docks page + API as phones take the OTA (build → newBuild) and
  //    KEEP their dock names. Phones must download (~290MB) + install + reboot.
  await page.goto(`${BASE}/#docks`);
  await page.waitForLoadState('networkidle');
  log('=== watching devices update (dock names must persist) ===');
  for (let i = 0; i < 90; i++) {           // up to ~15 min for download+install+reboot
    await sleep(10000);
    const a = await appPeers();
    log(`docks: ${await dockSnapshot()}`);
    const onCurrent = a.peers.filter((p) => p.build === newBuild);
    if (onCurrent.length >= 2 && a.peers.length >= 2) { log('>>> both phones on new build — DONE'); break; }
  }

  log('=== AFTER ===');
  log('docks:', await dockSnapshot());
  log('app  :', JSON.stringify(await appPeers()));
  await page.screenshot({ path: 'scripts/ota-e2e-docks.png', fullPage: true });
  log('screenshot: scripts/ota-e2e-docks.png');
} catch (e) {
  log('ERROR', e.message);
  await page.screenshot({ path: 'scripts/ota-e2e-error.png', fullPage: true }).catch(()=>{});
} finally {
  await browser.close();
}

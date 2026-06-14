/**
 * Playwright end-to-end driver for the Brain console's TASKS panel. NOT part of
 * the running system — an automated regression for the task lifecycle as a user
 * drives it in the browser (docs/TASKS_V1.md §8).
 *
 * Opens the station console in a real Chromium, connects a console test-phone
 * (which opens a brain session), then exercises the task panel end to end:
 *   1. run a definition from the panel        → instance appears RUNNING
 *   2. watch a one-shot reminder COMPLETE      → state=done, notified
 *   3. watch a recurring reminder FIRE         → lastSignal=notify, keeps running
 *   4. STOP a running task via the panel        → state=stopped
 *   5. RESTART via the panel                    → respawns, runCount increments
 *   6. PAUSE then RESUME via the panel          → stopped → running (runCount++)
 *   7. bad params are REFUSED                    → no instance, error surfaced
 *   8. (smoke) start from the CHAT (real LLM)    → the brain runs a task
 *   9. END SESSION cascades                       → ALL running tasks stopped
 * Each step asserts against the same REST the UI uses. Screenshots → /tmp/e2e-ct-*.
 * Prints per-step PASS/FAIL and exits non-zero on any failure.
 *
 *   npm run -w server start                 # station up on :8099 (another shell)
 *   npm run -w server e2e:console-tasks     # (or: node src/dev/e2e-console-tasks.mjs)
 *
 * Needs Playwright's Chromium: `npx playwright install chromium` once.
 * Env: BASE=http://localhost:8099  DOCK=pw-ct  SKIP_CHAT=1 (skip the LLM step)
 */
import { chromium } from 'playwright';

const BASE = process.env.BASE ?? 'http://localhost:8099';
const DOCK = process.env.DOCK ?? 'pw-ct';
const SKIP_CHAT = process.env.SKIP_CHAT === '1';
const SHOT = (n) => `/tmp/e2e-ct-${n}.png`;
const log = (...a) => console.log('[e2e]', ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rest = async (p, init) => {
  const r = await fetch(`${BASE}${p}`, init);
  try { return { status: r.status, json: await r.json() }; } catch { return { status: r.status, json: null }; }
};
const instances = async () => (await rest(`/api/brain/${DOCK}/instances`)).json ?? [];
const byId = async (id) => (await instances()).find((x) => x.instanceId === id);

let failures = 0;
const check = (cond, msg) => { if (cond) log('  ✓', msg); else { failures++; log('  ✗ FAIL:', msg); } };
/** poll until pred() is truthy or timeout; returns the last value seen. */
async function until(fn, pred, ms = 20000, step = 1000) {
  const end = Date.now() + ms;
  let v;
  do { v = await fn(); if (pred(v)) return v; await sleep(step); } while (Date.now() < end);
  return v;
}

/** Select a definition row, fill its params, click "run on <dock>". Returns the
 *  NEW instanceId (diffed against a pre-snapshot). */
async function runDef(page, name, paramsJson) {
  const before = new Set((await instances()).map((x) => x.instanceId));
  await page.locator(`.tk-row:has-text("${name}")`).first().click();
  await page.waitForSelector('textarea.tk-params', { timeout: 5000 });
  await page.locator('textarea.tk-params').fill(paramsJson);
  await page.locator(`button.br-btn.acc:has-text("run on ${DOCK}")`).click();
  const fresh = await until(
    async () => (await instances()).filter((x) => !before.has(x.instanceId)),
    (a) => a.length > 0, 8000, 500,
  );
  return fresh[0]?.instanceId;
}

/** Select a running instance's row, wait for its detail panel + lifecycle buttons
 *  to render, then click the named button (scoped to the detail panel). */
async function panelOp(page, id, label) {
  const row = page.locator('.tk-row').filter({ hasText: id }).first();
  await row.click();
  // the lifecycle buttons only render once `detail && selInst` resolves — wait for
  // the detail panel AND the selected row to reflect THIS id before clicking.
  await page.locator('.tk-row.sel').filter({ hasText: id }).first().waitFor({ timeout: 5000 });
  const btn = page.locator('.tk-detail button.br-btn', { hasText: new RegExp(`^${label}$`) }).first();
  await btn.waitFor({ timeout: 5000 });
  await btn.click();
}

async function main() {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  page.on('console', (m) => { if (m.type() === 'error') log('  [page err]', m.text()); });

  try {
    // ── open console, set dock, connect (opens a brain session) ──────────────
    await page.goto(BASE, { waitUntil: 'networkidle' });
    for (const sel of ['text=Brain', 'a:has-text("Brain")', 'button:has-text("Brain")']) {
      const el = page.locator(sel).first();
      if (await el.count() && await el.isVisible().catch(() => false)) { await el.click(); break; }
    }
    await sleep(400);
    await page.locator('input.br-dock').fill(DOCK);
    await page.locator('button.br-btn.acc:has-text("connect")').click();
    await page.waitForSelector('button:has-text("disconnect")', { timeout: 8000 });
    const tk = page.locator('button.br-btn:has-text("tasks")').first();
    if (await tk.count() && await tk.isVisible()) await tk.click();
    await page.waitForSelector('.tk-h:has-text("DEFINITIONS")', { timeout: 8000 });
    log('connected as', DOCK, '— tasks panel open');

    // a brain SESSION opens lazily on the first turn — running a task from the
    // panel needs one (REST refuses with 409 otherwise). Send one chat message to
    // open it; we only wait for the session to exist, not for the LLM reply.
    await page.locator('.br-composer input').fill('hello');
    await page.locator('button.br-btn.acc:has-text("send")').click();
    const opened = await until(
      async () => (await rest(`/api/brain/${DOCK}/sessions`)).json ?? [],
      (ss) => ss.some((s) => s.closedAt == null), 15000,
    );
    check(opened.some((s) => s.closedAt == null), 'a brain session is open (panel runs are allowed)');
    await page.screenshot({ path: SHOT('0-connected') });

    // ── 1+2. run a one-shot from the panel; watch it COMPLETE ────────────────
    log('1+2. run remind-after from panel → complete');
    const id1 = await runDef(page, 'remind-after', '{"message":"e2e console reminder","delay":"4s"}');
    check(!!id1, `one-shot started from panel (${id1})`);
    await page.screenshot({ path: SHOT('1-running') });
    const m1 = await until(() => byId(id1), (x) => x?.state === 'done', 20000);
    check(m1?.state === 'done', `one-shot COMPLETED (state=done, lastSignal="${m1?.lastSignal}")`);
    await page.screenshot({ path: SHOT('2-done') });

    // ── 3. run a recurring; watch it FIRE and keep running ───────────────────
    log('3. run remind-every from panel → fires + keeps running');
    const id2 = await runDef(page, 'remind-every', '{"message":"e2e water","interval":"2s"}');
    check(!!id2, `recurring started from panel (${id2})`);
    const m2 = await until(() => byId(id2), (x) => /notify|reminded/i.test(x?.lastSignal || ''), 10000);
    check(/notify|reminded/i.test(m2?.lastSignal || ''), `recurring FIRED (lastSignal="${m2?.lastSignal}")`);
    check((await byId(id2))?.state === 'running', 'recurring still RUNNING after firing');
    await page.screenshot({ path: SHOT('3-recurring') });

    // ── 4. STOP it via the panel ─────────────────────────────────────────────
    log('4. stop via panel');
    await panelOp(page, id2, 'stop');
    const s2 = await until(() => byId(id2), (x) => x?.state === 'stopped', 8000);
    check(s2?.state === 'stopped', 'STOPPED via panel button');
    await page.screenshot({ path: SHOT('4-stopped') });

    // ── 5. RESTART via the panel (respawn from checkpoint, runCount++) ────────
    log('5. restart via panel');
    const id5 = await runDef(page, 'remind-every', '{"message":"e2e restart","interval":"3s"}');
    const rc0 = (await byId(id5))?.runCount;
    await panelOp(page, id5, 'restart');
    const r5 = await until(() => byId(id5), (x) => x?.state === 'running' && x.runCount > rc0, 10000);
    check(r5?.state === 'running' && r5.runCount > rc0, `RESTART respawned (runCount ${rc0}→${r5?.runCount})`);
    await panelOp(page, id5, 'stop');

    // ── 6. PAUSE then RESUME via the panel ───────────────────────────────────
    log('6. pause + resume via panel');
    const id6 = await runDef(page, 'remind-every', '{"message":"e2e pz","interval":"3s"}');
    const rc6 = (await byId(id6))?.runCount;
    await panelOp(page, id6, 'pause');
    const p6 = await until(() => byId(id6), (x) => x?.state === 'stopped', 8000);
    check(p6?.state === 'stopped', 'PAUSE → stopped');
    await panelOp(page, id6, 'resume');
    const rs6 = await until(() => byId(id6), (x) => x?.state === 'running' && x.runCount > rc6, 8000);
    check(rs6?.state === 'running' && rs6.runCount > rc6, `RESUME → running (runCount ${rc6}→${rs6?.runCount})`);
    await panelOp(page, id6, 'stop');
    await page.screenshot({ path: SHOT('6-paused-resumed') });

    // ── 7. bad params are REFUSED (no instance started) ──────────────────────
    log('7. bad params refused');
    const before7 = (await instances()).length;
    await page.locator('.tk-row:has-text("remind-after")').first().click();
    await page.waitForSelector('textarea.tk-params');
    await page.locator('textarea.tk-params').fill('{"message":"no delay given"}'); // missing required `delay`
    await page.locator(`button.br-btn.acc:has-text("run on ${DOCK}")`).click();
    await sleep(1500);
    const after7 = (await instances()).length;
    check(after7 === before7, 'bad params did NOT start an instance (required `delay` enforced)');

    // ── 8. (smoke) start from the CHAT — real LLM authors/runs a task ─────────
    if (!SKIP_CHAT) {
      log('8. chat → LLM runs a task (smoke; nondeterministic choice)');
      const before8 = new Set((await instances()).map((x) => x.instanceId));
      await page.locator('.br-composer input').fill('remind me in 5 seconds to stretch');
      await page.locator('button.br-btn.acc:has-text("send")').click();
      const fresh8 = await until(
        async () => (await instances()).filter((x) => !before8.has(x.instanceId)),
        (a) => a.length > 0, 30000,
      );
      check(fresh8.length > 0, `chat started a task (${fresh8[0]?.name})`);
      // let it reach the user (complete or fire), then stop if still running
      if (fresh8[0]) {
        const id8 = fresh8[0].instanceId;
        const m8 = await until(() => byId(id8), (x) => x?.state === 'done' || /notify|reminded|finish/i.test(x?.lastSignal || ''), 15000);
        check(!!m8 && (m8.state === 'done' || /notify|reminded|finish/i.test(m8.lastSignal || '')),
          `chat task reached the user (state=${m8?.state}, lastSignal="${m8?.lastSignal}")`);
        if ((await byId(id8))?.state === 'running') await rest(`/api/brain/${DOCK}/instances/${id8}/stop`, { method: 'POST' });
      }
      await page.screenshot({ path: SHOT('8-chat') });
    }

    // ── 9. END SESSION cascades — start a few tasks, then click "end session"
    //       in the console and assert EVERY running instance is stopped. ───────
    log('9. end session → cascade stops all running tasks');
    await runDef(page, 'remind-every', '{"message":"e2e cascade A","interval":"5s"}');
    await runDef(page, 'remind-every', '{"message":"e2e cascade B","interval":"5s"}');
    await runDef(page, 'remind-after', '{"message":"e2e cascade C","delay":"5m"}');
    await sleep(1000);
    const runningBefore = (await instances()).filter((x) => x.state === 'running' || x.state === 'stuck');
    check(runningBefore.length >= 3, `have ${runningBefore.length} running tasks before end session`);
    // click "end session" in the console
    const endBtn = page.locator('button.br-btn:has-text("end session")');
    check(await endBtn.count() > 0, 'end session button present');
    await endBtn.first().click();
    log('clicked end session');
    // every task under that session must stop (the lifetime cascade)
    const stoppedAll = await until(
      async () => (await instances()).filter((x) => x.state === 'running' || x.state === 'stuck'),
      (a) => a.length === 0, 12000,
    );
    check(stoppedAll.length === 0, `END SESSION stopped ALL tasks (${stoppedAll.length} still running)`);
    // and the prior tasks are now in a terminal state
    const cascaded = (await instances()).filter((x) => runningBefore.some((r) => r.instanceId === x.instanceId));
    check(cascaded.every((x) => ['stopped', 'done', 'errored'].includes(x.state)),
      `cascaded tasks are terminal (${cascaded.map((x) => x.instanceId + '=' + x.state).join(', ')})`);
    await page.screenshot({ path: SHOT('9-end-session') });
  } catch (e) {
    failures++;
    log('THREW:', e.message);
    await page.screenshot({ path: SHOT('ERROR') }).catch(() => {});
  } finally {
    await browser.close();
  }

  console.log(`\n[e2e] ${failures === 0 ? 'PASS ✅ all console task operations work' : `FAIL ❌ ${failures} check(s) failed`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main();

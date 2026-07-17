#!/usr/bin/env node
// browse.mjs — a one-shot headless-browser driver for the brain's `self` skills.
//
// The brain's run_command tool is single-shot (no state between calls), so a REPL
// won't work: instead the brain hands this ONE script a JSON plan and gets back a
// JSON result + a saved screenshot it can read. Deterministic, no persistent
// browser, safe to invoke from run_command.
//
//   node src/tools/browse.mjs '<json-plan>'
//
// Plan shape:
//   {
//     "url": "http://localhost:8099/#perception",   // required, first navigation
//     "steps": [                                      // optional, run in order
//       { "click": "text=Sidecars" },                //  click a selector
//       { "type": ["input#q", "hello"] },            //  fill a selector
//       { "press": "Enter" },
//       { "waitFor": "css=.result" },                //  wait for a selector
//       { "wait": 800 },                              //  wait ms
//       { "goto": "http://example.com" }             //  navigate again
//     ],
//     "extract": "text" | "title" | "css=<selector>",// what to read back (default: text)
//     "shot": ".data/browser/console.png",            // screenshot path (default: auto)
//     "fullPage": true,                               // full-page screenshot (default false)
//     "viewport": [1400, 900]                         // optional
//   }
//
// Prints one JSON object: { ok, url, title, shot, text, error? }. The brain reads
// `text` (trimmed/capped) to understand the page, and can read the `shot` PNG with
// its own image-capable read to SEE it.
//
// NOTE: run with `node`, not tsx (tsx's TS-path resolver mishandles the hoisted
// playwright module from this cwd). cwd is orbit-station/server.

import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const CAP = 12000; // max chars of extracted text returned to the model

function fail(msg, extra = {}) {
  process.stdout.write(JSON.stringify({ ok: false, error: String(msg), ...extra }) + '\n');
  process.exit(0); // exit 0 so run_command sees the JSON, not a shell error
}

const raw = process.argv[2];
if (!raw) fail('usage: node src/tools/browse.mjs \'<json-plan>\'');

let plan;
try { plan = JSON.parse(raw); } catch (e) { fail(`plan is not valid JSON: ${e.message}`); }
if (!plan.url) fail('plan.url is required (the first page to open)');

const shot = plan.shot || `.data/browser/shot-${Date.now()}.png`;
try { mkdirSync(dirname(shot), { recursive: true }); } catch { /* ok */ }

const NAV = { waitUntil: 'domcontentloaded', timeout: 20000 };
let browser;
try {
  browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext(
    Array.isArray(plan.viewport) ? { viewport: { width: plan.viewport[0], height: plan.viewport[1] } } : {},
  );
  const page = await ctx.newPage();
  const consoleErrors = [];
  page.on('pageerror', (e) => consoleErrors.push(String(e)));

  await page.goto(plan.url, NAV);

  // click/press can kick off a navigation (Enter in a search box, clicking a
  // link). Arm the wait BEFORE acting, then await it — tolerating the case
  // where no navigation happens at all (SPA clicks, plain keys).
  const armNav = () => page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 5000 }).catch(() => {});

  for (const step of plan.steps || []) {
    if (step.goto) await page.goto(step.goto, NAV);
    else if (step.click) {
      const nav = armNav();
      await page.click(step.click, { timeout: 8000 });
      await nav;
    } else if (step.type) await page.fill(step.type[0], step.type[1], { timeout: 8000 });
    else if (step.press) {
      const nav = armNav();
      await page.keyboard.press(step.press);
      await nav;
    } else if (step.waitFor) await page.waitForSelector(step.waitFor, { timeout: 12000 });
    else if (step.wait) await page.waitForTimeout(Math.min(Number(step.wait) || 0, 10000));
  }

  // Extraction races any still-committing navigation ("Execution context was
  // destroyed") — settle first, and on failure re-settle and retry.
  const settle = () => page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
  await settle();

  const extract = plan.extract || 'text';
  let text = '';
  for (let attempt = 0; ; attempt++) {
    try {
      if (extract === 'title') text = await page.title();
      else if (extract.startsWith('css=') || extract.startsWith('text=') || extract.startsWith('//')) {
        const els = await page.$$(extract.replace(/^css=/, ''));
        text = (await Promise.all(els.map((el) => el.innerText().catch(() => '')))).join('\n');
      } else {
        text = await page.evaluate(() => document.body?.innerText || '');
      }
      break;
    } catch (e) {
      if (attempt >= 2) throw e;
      await page.waitForTimeout(500);
      await settle();
    }
  }

  await page.screenshot({ path: shot, fullPage: !!plan.fullPage });
  const title = await page.title();
  const url = page.url();
  await browser.close();

  process.stdout.write(JSON.stringify({
    ok: true, url, title, shot,
    text: (text || '').trim().slice(0, CAP),
    truncated: (text || '').length > CAP,
    ...(consoleErrors.length ? { pageErrors: consoleErrors.slice(0, 5) } : {}),
  }) + '\n');
} catch (e) {
  try { await browser?.close(); } catch { /* ok */ }
  fail(e?.message || e, { shot });
}

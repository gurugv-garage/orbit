---
name: browse
description: >-
  Open a real web browser (headless) to look at web pages and your own station
  console — invoke when asked to visit/open/check a website or URL, look
  something up on a specific page, read what a page says, take a screenshot of a
  page, or inspect/see your own control console (the station dashboard). You can
  navigate, click, type, wait, read the page text, AND capture a screenshot you
  can then actually SEE.
---

# Browsing with a real headless browser

You drive a real Chromium browser (headless) through one helper script. Your
`run_command` is single-shot, so you can't hold a browser open between calls —
instead you hand the script ONE plan (open this URL, do these steps, read this,
screenshot it) and get back JSON + a saved PNG.

## How to run it

From `run_command` (cwd is already `orbit-station/server`):

```
node src/tools/browse.mjs '<json-plan>'
```

Plan fields:
- `url` (required) — the first page to open.
- `steps` (optional, in order): `{"goto":"<url>"}`, `{"click":"<selector>"}`,
  `{"type":["<selector>","<text>"]}`, `{"press":"Enter"}`,
  `{"waitFor":"<selector>"}`, `{"wait":<ms>}`.
- `extract` — what text to read back: `"text"` (whole page, default), `"title"`,
  or a selector `"css=.some-class"`.
- `shot` — screenshot path (default auto under `.data/browser/`). Give a stable
  name like `.data/browser/page.png` when you want to look at it.
- `fullPage: true` — capture the whole scrollable page.
- `viewport: [1400, 900]` — window size.

Selectors: Playwright syntax — `"text=Cost"` (by visible text), `"css=button.save"`,
`"#id"`, `"input[name=q]"`.

It prints ONE JSON line: `{ ok, url, title, shot, text, truncated?, pageErrors? }`.

## The two-part move (read AND see)

1. Run the script → read the returned `text` to understand the page.
2. If you need to SEE it (layout, a chart, a screenshot the user asked for),
   read the `shot` PNG file with your normal file read — you can view images.

Speak the short conclusion, not the raw JSON.

## Examples

- Open a site and read it:
  `node src/tools/browse.mjs '{"url":"https://example.com","extract":"text"}'`
- Search-style flow (type + submit + read results):
  `node src/tools/browse.mjs '{"url":"https://duckduckgo.com","steps":[{"type":["input[name=q]","orbit robot"]},{"press":"Enter"},{"waitFor":"css=article"}],"extract":"text"}'`
- Screenshot a page to look at:
  `node src/tools/browse.mjs '{"url":"https://news.ycombinator.com","shot":".data/browser/hn.png","fullPage":true}'`
  then read `.data/browser/hn.png`.

## Driving YOUR OWN console (the station dashboard)

Your control console is a web app at **http://localhost:8099** — the same one the
user sees. Open it with this browser to SEE your own state, not just curl it. It's
a single-page app; views are URL hashes:

- `http://localhost:8099/#overview` — fleet overview
- `http://localhost:8099/#cost` — your LLM spend (charts)
- `http://localhost:8099/#observability` — session/turn traces
- `http://localhost:8099/#perception` — the live perception studio (what you see/hear)
- `http://localhost:8099/#body` — body/servo state
- `http://localhost:8099/#brain` — your brain sessions
- `http://localhost:8099/#config` — your settings
- `http://localhost:8099/#ego` — your evolving self-document

Give the SPA a moment to render live data: add `{"wait":1500}` before extracting.
Example — screenshot your own cost dashboard and read it back:
`node src/tools/browse.mjs '{"url":"http://localhost:8099/#cost","steps":[{"wait":1500}],"shot":".data/browser/mycost.png"}'`
then read `.data/browser/mycost.png` to see the chart.

For quick FACTS about yourself (cost number, config value, why-you-said) the API
recipes in your `self` skill are faster than the browser. Use the browser when the
ask is visual — "show me", "take a screenshot", "what does your dashboard look
like", "does the console look right" — or to check the UI the user is looking at.

## Rules

- Read-only browsing and looking at your own console is fine to do freely.
- Do NOT log into sites, submit forms with someone's credentials, make purchases,
  or POST changes through a website. If the task needs that, say so and stop.
- Screenshots and page text land in `.data/browser/` — mention the path if the
  user wants the image.
- If the script returns `ok:false`, read its `error` and say what failed plainly;
  don't invent what the page said.

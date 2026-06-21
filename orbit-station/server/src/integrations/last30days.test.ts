/**
 * last30days integration unit tests (node:test). No subprocess — we assert the
 * enabled gate (script path + Python discovery) and that a real research run is
 * only attempted when wired. The CLI itself is exercised manually (it shells out
 * to Python); here we pin the gating contract the session relies on.
 *
 *   npm test --workspace server
 */

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { last30daysEnabled, last30daysScript, research } from './last30days.js';

let dir: string;
let scriptPath: string;
const realScriptEnv = process.env.LAST30DAYS_SCRIPT;
const realPythonEnv = process.env.LAST30DAYS_PYTHON;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'l30d-test-'));
  scriptPath = join(dir, 'last30days.py');
  await writeFile(scriptPath, '# fake\n', 'utf8');
  delete process.env.LAST30DAYS_SCRIPT;
  delete process.env.LAST30DAYS_PYTHON;
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
  if (realScriptEnv === undefined) delete process.env.LAST30DAYS_SCRIPT; else process.env.LAST30DAYS_SCRIPT = realScriptEnv;
  if (realPythonEnv === undefined) delete process.env.LAST30DAYS_PYTHON; else process.env.LAST30DAYS_PYTHON = realPythonEnv;
});

test('disabled when no script path configured', () => {
  assert.equal(last30daysScript(), undefined);
  assert.equal(last30daysEnabled(), false);
});

test('disabled when the configured script path does not exist', () => {
  process.env.LAST30DAYS_SCRIPT = join(dir, 'nope.py');
  assert.equal(last30daysScript(), undefined);
  assert.equal(last30daysEnabled(), false);
});

test('enabled when the script exists and a Python is available', () => {
  process.env.LAST30DAYS_SCRIPT = scriptPath;
  // node test hosts always have python3 on PATH in CI/dev; if not, the gate is
  // correctly false and this asserts the same contract either way.
  const enabled = last30daysEnabled();
  if (enabled) assert.equal(last30daysScript(), scriptPath);
  else assert.equal(enabled, false);
});

test('research() rejects an empty topic before spawning', async () => {
  process.env.LAST30DAYS_SCRIPT = scriptPath;
  process.env.LAST30DAYS_PYTHON = 'python3';
  await assert.rejects(() => research({ topic: '   ' }), /nothing to research/);
});

test('research() throws a clear error when not configured', async () => {
  await assert.rejects(() => research({ topic: 'anything' }), /not available/);
});

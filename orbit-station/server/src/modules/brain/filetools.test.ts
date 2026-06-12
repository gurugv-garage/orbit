/**
 * Full pi coding tools (docs/SERVER-BRAIN-SELFMOD.md Tier 4):
 *  - read_file works WITHOUT confirmation (ask about the code freely);
 *  - write/edit/run REQUIRE confirmation and abort on a decline;
 *  - the FILE_TOOLS_PROMPT advertises the capability to the model.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildFileTools, FILE_TOOLS_PROMPT, type ConfirmFn } from './filetools.js';

function tools(confirm: ConfirmFn) {
  const map = new Map(buildFileTools({ confirm }).map((t) => [t.name, t]));
  return map;
}
const text = (r: { content: readonly unknown[] }) =>
  r.content.map((c) => (c as { text?: string }).text ?? '').join('');

test('read_file needs no confirmation', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ft-'));
  const f = join(dir, 'hello.txt');
  writeFileSync(f, 'secret contents');
  let asked = false;
  const t = tools(async () => { asked = true; return true; });
  const r = await t.get('read_file')!.execute('1', { path: f } as never);
  assert.match(text(r), /secret contents/);
  assert.equal(asked, false, 'read must not prompt for confirmation');
});

test('write_file applies on approve, aborts on decline', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ft-'));
  const f = join(dir, 'out.txt');

  // decline → throws, file not written
  const denied = tools(async () => false);
  await assert.rejects(() => denied.get('write_file')!.execute('1', { path: f, content: 'nope' } as never));
  assert.throws(() => readFileSync(f, 'utf8')); // never created

  // approve → written
  const ok = tools(async () => true);
  await ok.get('write_file')!.execute('2', { path: f, content: 'yes' } as never);
  assert.equal(readFileSync(f, 'utf8'), 'yes');
});

test('edit_file confirms, enforces unique old_string', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ft-'));
  const f = join(dir, 'code.ts');
  writeFileSync(f, 'const x = 1;\nconst y = 2;\n');

  const ok = tools(async () => true);
  await ok.get('edit_file')!.execute('1', { path: f, old_string: 'const x = 1;', new_string: 'const x = 42;' } as never);
  assert.match(readFileSync(f, 'utf8'), /const x = 42;/);

  // ambiguous → error (before any confirm)
  writeFileSync(f, 'dup\ndup\n');
  await assert.rejects(() => ok.get('edit_file')!.execute('2', { path: f, old_string: 'dup', new_string: 'x' } as never));

  // decline blocks a valid edit
  writeFileSync(f, 'unique-line');
  const denied = tools(async () => false);
  await assert.rejects(() => denied.get('edit_file')!.execute('3', { path: f, old_string: 'unique-line', new_string: 'changed' } as never));
  assert.equal(readFileSync(f, 'utf8'), 'unique-line');
});

test('run_command confirms then runs', async () => {
  const denied = tools(async () => false);
  await assert.rejects(() => denied.get('run_command')!.execute('1', { command: 'echo hi' } as never));

  const ok = tools(async () => true);
  const r = await ok.get('run_command')!.execute('2', { command: 'echo orbit-test-123' } as never);
  assert.match(text(r), /orbit-test-123/);
  assert.match(text(r), /\[exit 0\]/);
});

test('the capability is advertised to the model', () => {
  assert.match(FILE_TOOLS_PROMPT, /FULL ACCESS/);
  assert.match(FILE_TOOLS_PROMPT, /modify yourself|write_file|edit_file/);
  assert.match(FILE_TOOLS_PROMPT, /confirm/i);
});

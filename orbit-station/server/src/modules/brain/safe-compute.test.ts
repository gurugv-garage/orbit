/**
 * Ported from the dock's SafeComputeTest.kt — the compute tool's evaluator
 * must do the arithmetic/random/branch a model needs and REJECT anything
 * resembling general code (names, calls, statements).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SafeCompute } from './safe-compute.js';

/** deterministic rng for repeatable vectors (mulberry32). */
function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const c = new SafeCompute(seeded(42));

test('arithmetic with precedence', () => {
  assert.equal(c.eval('3 + 4 * 2'), '11');
  assert.equal(c.eval('(3 + 4) * 2'), '14');
  assert.equal(c.eval('10 / 4'), '2.5');
  assert.equal(c.eval('10 % 3'), '1');
  assert.equal(c.eval('-5 + 2'), '-3');
});

test('comparisons return bool', () => {
  assert.equal(c.eval('7 > 5'), 'true');
  assert.equal(c.eval('3 >= 5'), 'false');
  assert.equal(c.eval('4 == 4'), 'true');
  assert.equal(c.eval('4 != 4'), 'false');
});

test('random is in range inclusive', () => {
  for (let seed = 0; seed < 50; seed++) {
    const v = Number(new SafeCompute(seeded(seed)).eval('random(1,10)'));
    assert.ok(v >= 1, `seed ${seed}: ${v} >= 1`);
    assert.ok(v <= 10, `seed ${seed}: ${v} <= 10`);
  }
});

test('random branch comparison', () => {
  const r = c.eval('random(1,10) > 5');
  assert.ok(r === 'true' || r === 'false', r);
});

test('rejects general code', () => {
  assert.match(c.eval('import random'), /^error/);
  assert.match(c.eval("print('hi')"), /^error/);
  assert.match(c.eval('x = 5'), /^error/);
  assert.match(c.eval("os.system('rm')"), /^error/);
  assert.match(c.eval(''), /^error/);
});

test('rejects malformed', () => {
  assert.match(c.eval('3 +'), /^error/);
  assert.match(c.eval('random(5,1)'), /^error/);   // a>b
  assert.match(c.eval('(3 + 4'), /^error/);        // unbalanced
});

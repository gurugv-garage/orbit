/**
 * Objective scorer — the pass/fail logic the runner uses. Pure, no model.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { score, loadCases, type TurnObservation } from './cases.js';

const obs = (o: Partial<TurnObservation>): TurnObservation =>
  ({ speech: '', toolCalls: [], error: null, ...o });

test('noMove fails when a movement tool was called', () => {
  assert.deepEqual(score({ noMove: true }, obs({ toolCalls: [{ name: 'set_face', args: {} }] })),
    ["moved when it shouldn't (set_face)"]);
  assert.deepEqual(score({ noMove: true }, obs({ speech: 'hi' })), []);
});

test('toolName requires that specific tool', () => {
  assert.deepEqual(score({ toolName: 'compute' }, obs({ speech: 'it is 391' })),
    ["expected 'compute' not called"]);
  assert.deepEqual(score({ toolName: 'compute' }, obs({ toolCalls: [{ name: 'compute', args: { expression: '17*23' } }] })), []);
});

test('validEnums catches invented faces + parts', () => {
  const r = score({ validEnums: true }, obs({ toolCalls: [{ name: 'set_face', args: { expression: 'smug' } }] }));
  assert.ok(r.some((x) => x.includes("invalid face 'smug'")));
  assert.deepEqual(score({ validEnums: true }, obs({ toolCalls: [{ name: 'set_face', args: { expression: 'happy' } }] })), []);
});

test('move step bounds: count, degrees, duration', () => {
  const call = (steps: unknown[]) => obs({ toolCalls: [{ name: 'move', args: { steps } }] });
  assert.deepEqual(score({ minSteps: 2 }, call([{ part: 'neck', degrees: 10 }])), ['too few move steps (1 < 2)']);
  assert.ok(score({ degRange: { part: 'neck', lo: -60, hi: 35 } }, call([{ part: 'neck', degrees: 90 }])).some((x) => x.includes('no neck step in')));
  assert.deepEqual(score({ degRange: { part: 'neck', lo: -60, hi: 35 } }, call([{ part: 'neck', degrees: 20 }])), []);
});

test('keywords are case-insensitive ANY-of (alternatives, not all-required)', () => {
  // any alternative present → pass
  assert.deepEqual(score({ keywords: ['3', 'three'] }, obs({ speech: 'I see 3 fingers' })), []);
  assert.deepEqual(score({ keywords: ['Earl Grey'] }, obs({ speech: 'Your favorite is earl grey.' })), []);
  // none present → fail (lists the alternatives)
  assert.deepEqual(score({ keywords: ['cake', 'dessert'] }, obs({ speech: 'nothing here' })),
    ['none of [cake, dessert] in speech']);
});

test('loadCases reads every capability file incl. the new ones', () => {
  const cases = loadCases();
  const caps = new Set(cases.map((c) => c.capability));
  for (const expected of ['chat', 'move', 'tool_calling', 'vision', 'compute', 'face_memory', 'capabilities']) {
    assert.ok(caps.has(expected), `missing capability ${expected}`);
  }
  // every case has a non-empty prompt + an expect block
  for (const c of cases) {
    assert.ok(c.prompt.length > 0, `${c.id} has no prompt`);
    assert.ok(c.expect && typeof c.expect === 'object', `${c.id} has no expect`);
  }
});

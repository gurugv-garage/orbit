#!/usr/bin/env node
/**
 * ff-simlog — drive the REAL faceFollow controller through a scripted world and emit the
 * exact [ff-event]/[ff-tick] log the live task produces, so we can dry-run ff-validate.mjs
 * WITHOUT hardware. This proves the validator judges the flows correctly before a real test.
 *
 *   node scripts/ff-simlog.mjs [--mode salient|named] [--name X] > /tmp/sim.log
 *
 * The world models the closed loop (panning the head moves the face in-frame), like
 * closed-loop.test.ts. A scripted timeline exercises every flow: acquire → hold → move →
 * follow → leave → search → re-enter elsewhere → re-lock → leave again → search.
 */
import { stepFollow, initialFollowState } from '../server/src/tasks/packaged/face-follow/control.ts';

const args = process.argv.slice(2);
const mode = args.includes('--mode') ? args[args.indexOf('--mode') + 1] : 'salient';
const target = args.includes('--name') ? args[args.indexOf('--name') + 1] : (mode === 'named' ? 'guru' : null);

const FOV_X = 60, FOV_Y = 45;
const apparent = (w, pose) => {
  const ax = 0.5 + (w.wx - pose.foot) / FOV_X;
  const ay = 0.5 + (w.wy - pose.neck) / FOV_Y;
  if (ax < 0 || ax > 1 || ay < 0 || ay > 1) return null;
  const size = w.size ?? 0.25;
  return { name: w.name ?? null, confidence: 0.8, box: { x: ax - size / 2, y: ay - size / 2, w: size, h: size } };
};

// Scripted world per tick (≈700ms each). null = nobody visible at that world point.
function worldAt(i) {
  if (i < 12) return [{ wx: 0, wy: 0, name: target }];          // F1/F2: centered, still → acquire + hold
  if (i < 22) return [{ wx: Math.min(40, (i - 12) * 5), wy: 0, name: target }]; // F4: steps to the side → follow
  if (i < 38) return [];                                         // F5: gone → search/sweep
  if (i < 55) return [{ wx: -55, wy: 10, name: mode === 'named' ? target : 'aanya' }]; // F6: re-enters elsewhere → re-lock
  if (i < 70) return [];                                         // F7: gone again → search again
  return [{ wx: 20, wy: -5, name: target }];                     // settle
}

let state = initialFollowState();
let prevPhase = '', prevLockName = null;
const T0 = 1_700_000_000_000;
function ffEventKind(prev, next, pName, nName) {
  const prevHas = (prev || '||-').split('|')[2];
  const [nextMode, , nextHas] = next.split('|');
  if (nextMode === 'yielded') return 'yield';
  if (prev.startsWith('yielded') && nextMode !== 'yielded') return 'resume';
  if (prevHas !== 'L' && nextHas === 'L') return 'acquire';
  if (prevHas === 'L' && nextHas !== 'L') return 'lose';
  if (prevHas === 'L' && nextHas === 'L' && pName !== nName) return 'relock';
  if (nextMode === 'search') return 'search';
  if (nextMode === 'track') return 'track';
  return 'phase';
}

for (let i = 0; i < 85; i++) {
  const ts = T0 + i * 700;
  const seen = worldAt(i).map((w) => apparent(w, state.pose)).filter(Boolean);
  const r = stepFollow(state, seen, { target, lostAfter: 6, lostAfterCentered: 18 }, { now: ts });
  state = r.state;
  const lk = state.lock;
  const lockStr = lk ? `${lk.name ?? '?'}@${lk.at.x.toFixed(2)},${lk.at.y.toFixed(2)}` : '-';
  const phase = `${state.mode}|${lk?.name ?? ''}|${lk ? 'L' : '-'}`;
  if (phase !== prevPhase) {
    console.log(`[ff-event] ts=${ts} ${ffEventKind(prevPhase, phase, prevLockName, lk?.name ?? null)} from="${prevPhase || 'init'}" to="${phase}" lock=${lockStr}`);
    prevPhase = phase; prevLockName = lk?.name ?? null;
  }
  const fs = seen.map((f) => `${f.name ?? '?'}@${(f.box.x + f.box.w / 2).toFixed(2)},${(f.box.y + f.box.h / 2).toFixed(2)}`).join(' ');
  const errx = lk ? (lk.at.x - 0.5).toFixed(2) : '-';
  const erry = lk ? (lk.at.y - 0.5).toFixed(2) : '-';
  const cmd = r.command ? `foot${r.command.foot.toFixed(0)}/neck${r.command.neck.toFixed(0)}` : '-';
  console.log(`[ff-tick] ts=${ts} #${i + 1} mode=${state.mode} nf=${seen.length} faces=[${fs}] lock=${lockStr} err=(${errx},${erry}) pose=foot${state.pose.foot.toFixed(0)}/neck${state.pose.neck.toFixed(0)} cmd=${cmd}`);
}

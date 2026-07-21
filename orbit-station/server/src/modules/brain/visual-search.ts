/**
 * visual-search — the "look around and find X" engine (2026-07-17 design
 * session; the bounded in-turn behaviour pattern).
 *
 * THE SHAPE (deliberate, and meant to generalize):
 *   LLM (before):  chooses the knobs — query, budget, tilt hint, resume —
 *                  from the user's words ("search properly" → bigger budget,
 *                  "the fan" → tilt up).
 *   CODE (here):   owns the loop — plan a 2-DOF grid, move (awaited), dwell,
 *                  grab a POST-SETTLE frame, judge, decide. State is written
 *                  INCREMENTALLY so an abort loses nothing.
 *   LLM (after):   narrates the outcome; the user's next words ("not that
 *                  one", "look left") become a resume call — steering rides
 *                  the existing abort+merge machinery, no streaming channel.
 *
 * The LLM is deliberately NOT the inner-loop controller: at ~3-8s per
 * decision it made searches slow and unreliable (live turns 81/82 — swept
 * blind, then confabulated a sweep). Judges are pluggable per query kind:
 * face-api for people (P1), a VLM verdict for open queries (P2).
 *
 * NOT a task: a search is bounded (seconds), conversational (its result IS
 * the reply), and dies with the turn — a separate process lifecycle would be
 * pure overhead. See docs/decision-traces/ (visual-search) for the trade-offs.
 */

import type { MoveStep } from './schemas.js';

/** One camera pose. pan = foot degrees (±90, +left), tilt = neck degrees
 *  (−60 up … +35 down) — the dock's full 2 DOF. */
export interface Pose { pan: number; tilt: number }

/** A judge's read of one frame. `offset` is the target's center relative to
 *  the FRAME center, both axes −1..1 (+x right, +y down) — what centering
 *  consumes. */
export interface Verdict {
  match: boolean;
  confidence: number;      // 0..1
  label?: string;          // what was seen ("Guru", "white mug")
  offset?: { x: number; y: number };
  note?: string;           // honest extra ("someone unrecognized")
}

export interface SearchDeps {
  /** where the body is NOW (start of search) — the plan spirals out from here. */
  pose(): Pose;
  /** move to an absolute pose and resolve when the SERVOS have finished. */
  moveTo(pose: Pose): Promise<void>;
  /** a frame decoded at/after `minTs` (base64 JPEG), or null if none arrived. */
  frameSince(minTs: number): string | undefined;
  /** judge one frame against the query. */
  judge(frameB64: string): Promise<Verdict>;
  /** a fresh HIGH-RES still from the phone (base64 JPEG) — the identity
   *  escalation when stream-frame faces are too small to name. Undefined =
   *  unsupported (old app) or capture failed. */
  captureStill?(): Promise<string | undefined>;
  /** persist a frame worth keeping (the FOUND view) — returns where it went.
   *  Lands in the trace so "gotcha" is verifiable against what was actually
   *  seen (user ask, 2026-07-17). Optional; failures are swallowed. */
  saveShot?(frameB64: string, tag: string): string | undefined;
  /** the turn's abort signal — checked between every step. */
  signal?: AbortSignal;
  log?: (line: string) => void;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export interface SearchOpts {
  query: string;
  budgetMs: number;                       // clamped by the tool (≤30s)
  tilt?: 'level' | 'down' | 'up' | 'all'; // rows to cover (default level+down)
  resume?: boolean;                       // continue a recent search's coverage
  excludeCurrent?: boolean;               // "not that one" — skip the centered candidate
}

export interface Candidate {
  id: number;
  pose: Pose;
  label: string;
  confidence: number;
  centered?: boolean;
}

/** The durable state of one search — survives turns (steering/resume), dies by TTL. */
export interface SearchContext {
  query: string;
  startedAt: number;
  updatedAt: number;
  plan: Pose[];
  /** poses already judged (resume skips them). */
  visited: Array<{ pose: Pose; at: number; verdict: Verdict }>;
  candidates: Candidate[];
  excludedIds: number[];
  budgetUsedMs: number;
  judgeCalls: number;
}

export interface SearchOutcome {
  found: boolean;
  /** honest, narratable summary — the tool result text is built from this. */
  summary: string;
  candidate?: Candidate;
  otherCandidates: Candidate[];
  coverage: { posesVisited: number; posesPlanned: number; ms: number; judgeCalls: number };
  aborted: boolean;
  /** where the FOUND frame was persisted (deps.saveShot), if it was. */
  shotPath?: string;
  /** the FOUND frame itself (base64 JPEG) — the dock face shows it briefly. */
  foundFrameB64?: string;
}

// ── tunables ─────────────────────────────────────────────────────────────────
// ABSOLUTE pan grid. 20° spacing (user-tuned down from 30°: recognition only
// really lands on reasonably-frontal, reasonably-central faces, so 30° hops
// slipped past people sitting between stops). Ordered nearest-first from the
// current heading at plan time — NOT offsets from it: offset-stops clamped at
// the limits, so a search starting at +90° never looked at the negative half
// of the room (live turn-bc616ed1). Found-early + the budget keep the denser
// grid from costing much in practice.
// stops stay 10° short of the ±90 mechanical limits — the edge stops still SEE
// past ±90 (half-FOV ≈ 30°), and centering never starts from a clamped joint.
const PAN_STOPS = [-80, -60, -40, -20, 0, 20, 40, 60, 80];
const TILT_ROW: Record<string, number[]> = {
  level: [0],
  down: [0, 22],       // desks / floor edge (neck + = down)
  up: [0, -30],        // shelves / fan
  all: [0, 22, -30],
};
const DWELL_MS = 350;                // settle + exposure after a move
/** save EVERY judged frame (not just the found one) — the per-pose ground
 *  truth for "it looked right at me and didn't see me" reports. Default ON
 *  while the feature is young; ~50KB per pose. */
const DEBUG_SHOTS = (process.env.VS_DEBUG_SHOTS ?? '1') === '1';
const CONF_HI = 0.6;                 // ≥ → found (face-api match scores land well above)
const CONF_AMBIGUOUS = 0.35;         // ≥ → worth ONE re-look before moving on
const CONTEXT_TTL_MS = 5 * 60_000;   // "not that one" must arrive within this
/** resume skips a pose only if it was judged THIS recently. People move:
 *  "find me" minutes after an exhausted sweep must RE-look, not inherit dead
 *  coverage (live turn-482ba4c8: resume:true + fully-visited plan → two quick
 *  hops, instant "not found", stale 27-pose coverage claim). */
const RECENT_VISIT_MS = 45_000;

// ── per-dock context registry (module-scoped; survives turns, not restarts) ──
const contexts = new Map<string, SearchContext>();

export function searchContext(dock: string, now = Date.now()): SearchContext | undefined {
  const c = contexts.get(dock);
  if (!c) return undefined;
  if (now - c.updatedAt > CONTEXT_TTL_MS) { contexts.delete(dock); return undefined; }
  return c;
}
export function clearSearchContext(dock: string): void { contexts.delete(dock); }

/** The 2-DOF plan: level row first (most targets live at eye height), then the
 *  hinted rows. SERPENTINE ordering — from the current heading sweep out to
 *  one edge, then one reversal covers the other side; each next row continues
 *  from where the last ended (snake). The old nearest-first order PING-PONGED
 *  around the start with growing amplitude (0→−20→+20→−40→+40…), so late hops
 *  were 100°+ lunges — the user-felt "it moves in one big sweep". Serpentine
 *  hops are one grid step except a single reversal per row. */
export function planPoses(from: Pose, tilt: SearchOpts['tilt'] = 'down'): Pose[] {
  const rows = TILT_ROW[tilt ?? 'down'] ?? TILT_ROW.down!;
  const asc = [...PAN_STOPS].sort((a, b) => a - b);
  // start at the stop NEAREST the current heading, walk to the nearer edge
  // first (short out-pass), then one reversal sweeps the rest — every hop is
  // one grid step except that single reversal.
  let idx = 0;
  for (let i = 1; i < asc.length; i++) {
    if (Math.abs(asc[i]! - from.pan) < Math.abs(asc[idx]! - from.pan)) idx = i;
  }
  const toLeft = asc.slice(0, idx + 1).reverse();  // nearest → left edge
  const toRight = asc.slice(idx);                  // nearest → right edge
  const order = toLeft.length <= toRight.length
    ? [...toLeft, ...asc.slice(idx + 1)]           // short left pass, then sweep right
    : [...toRight, ...asc.slice(0, idx).reverse()]; // short right pass, then sweep left
  const poses: Pose[] = [];
  let current = order;
  for (const row of rows) {
    poses.push(...current.map((pan) => ({ pan, tilt: row })));
    current = [...current].reverse(); // snake: next row starts where this one ended
  }
  return poses;
}

const clampPan = (d: number) => Math.max(-90, Math.min(90, Math.round(d)));
const clampTilt = (d: number) => Math.max(-60, Math.min(35, Math.round(d)));
const samePose = (a: Pose, b: Pose) => Math.abs(a.pan - b.pan) <= 5 && Math.abs(a.tilt - b.tilt) <= 5;

/** Run one search (or resume one). Writes the dock's SearchContext incrementally. */
export async function runVisualSearch(dock: string, deps: SearchDeps, opts: SearchOpts): Promise<SearchOutcome> {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const log = deps.log ?? (() => {});
  const t0 = now();
  const startPose = deps.pose(); // give-ups return here — never park at the ceiling

  // context: resume a live one for the same query, else start fresh.
  let ctx = opts.resume ? searchContext(dock, t0) : undefined;
  if (ctx && ctx.query !== opts.query && !opts.excludeCurrent) ctx = undefined; // new target → new search
  if (!ctx) {
    ctx = {
      query: opts.query, startedAt: t0, updatedAt: t0,
      plan: planPoses(deps.pose(), opts.tilt),
      visited: [], candidates: [], excludedIds: [], budgetUsedMs: 0, judgeCalls: 0,
    };
  }
  contexts.set(dock, ctx);

  // "not that one": exclude the candidate we centered on last time.
  if (opts.excludeCurrent) {
    const centered = ctx.candidates.filter((c) => c.centered && !ctx!.excludedIds.includes(c.id));
    for (const c of centered) ctx.excludedIds.push(c.id);
  }

  let lastFrame: string | undefined; // the most recent judged frame — saved on a find
  const spent = () => now() - t0;
  const giveUpDetail = () => {
    const seen = ctx!.candidates.filter((c) => !ctx!.excludedIds.includes(c.id)).map((c) => c.label);
    const notes = [...new Set(ctx!.visited.filter((v) => v.at >= t0)
      .map((v) => v.verdict.note).filter((n): n is string => !!n))];
    return (seen.length ? `; saw: ${[...new Set(seen)].join(', ')}` : '') +
      (notes.length ? `; noticed: ${notes.slice(0, 3).join('; ')}` : '');
  };
  /** a FAILED search must not leave the gaze wherever the plan ended (live:
   *  parked staring at the ceiling after the up-row) — come back to the pose
   *  the search started from. Best-effort. */
  const returnHome = async () => { try { await deps.moveTo(startPose); } catch { /* offline/blocked — leave it */ } };
  const overBudget = () => spent() >= opts.budgetMs;
  const abortedNow = () => deps.signal?.aborted === true;
  const touch = () => { ctx!.updatedAt = now(); ctx!.budgetUsedMs += 0; };

  const finish = (found: boolean, cand: Candidate | undefined, why: string, aborted = false): SearchOutcome => {
    ctx!.updatedAt = now();
    ctx!.budgetUsedMs += spent();
    const others = ctx!.candidates.filter((c) => c !== cand && !ctx!.excludedIds.includes(c.id));
    let shotPath: string | undefined;
    if (found && lastFrame && deps.saveShot) {
      try { shotPath = deps.saveShot(lastFrame, cand?.label ?? 'found'); } catch { /* best-effort */ }
    }
    return {
      found, candidate: cand, otherCandidates: others, aborted, shotPath,
      ...(found && lastFrame ? { foundFrameB64: lastFrame } : {}),
      summary: why,
      coverage: {
        posesVisited: ctx!.visited.filter((v) => v.at >= t0).length, // THIS run, not lifetime
        posesPlanned: ctx!.plan.length, ms: spent(), judgeCalls: ctx!.judgeCalls,
      },
    };
  };

  // 0. Known-but-unvisited candidates first (the "find another one" fast path).
  const pending = ctx.candidates.filter((c) => !ctx!.excludedIds.includes(c.id) && !c.centered);
  for (const cand of pending) {
    if (abortedNow()) { await returnHome(); return finish(false, undefined, 'search interrupted', true); }
    const ok = await visitAndConfirm(cand.pose, cand);
    if (ok) return finish(true, ok, `found ${ok.label} at ${describePose(ok.pose)} (a previously seen candidate)`);
  }

  // 1. Sweep the plan (resume = skip what's already judged).
  for (const pose of ctx.plan) {
    if (abortedNow()) { await returnHome(); return finish(false, undefined, 'search interrupted — coverage kept for a resume', true); }
    if (overBudget()) {
      await returnHome();
      return finish(false, undefined,
        `time budget spent (${Math.round(opts.budgetMs / 1000)}s)${giveUpDetail()} — ` +
        `say "keep looking" to continue where I left off`);
    }
    if (ctx.visited.some((v) => samePose(v.pose, pose) && now() - v.at < RECENT_VISIT_MS)) continue;

    const verdict = await lookAt(pose);
    if (verdict == null) continue; // frame never arrived — recorded inside lookAt
    if (!verdict.match) continue;

    const cand: Candidate = {
      id: ctx.candidates.length + 1, pose: { ...pose },
      label: verdict.label ?? opts.query, confidence: verdict.confidence,
    };
    ctx.candidates.push(cand); touch();
    if (ctx.excludedIds.includes(cand.id)) continue; // can't happen for fresh ids; safety
    if (verdict.confidence >= CONF_HI) {
      const centered = await center(cand, verdict);
      return finish(true, centered, `found ${centered.label} at ${describePose(centered.pose)}`);
    }
    // ambiguous: ONE re-look at the same pose before trusting or dismissing.
    const second = await lookAt(pose, /*reVisit*/ true);
    if (second?.match && second.confidence >= CONF_AMBIGUOUS) {
      const cand2 = { ...cand, confidence: Math.max(cand.confidence, second.confidence) };
      const centered = await center(cand2, second);
      return finish(true, centered,
        `probably found ${centered.label} at ${describePose(centered.pose)} (not fully sure)`);
    }
  }

  const excluded = ctx.excludedIds.length;
  await returnHome();
  return finish(false, undefined,
    `not found — covered ${ctx.visited.filter((v) => v.at >= t0).length} poses over ${Math.round(spent() / 1000)}s` +
    giveUpDetail() +
    (excluded ? `; ${excluded} candidate(s) ruled out by you` : ''));

  // ── inner helpers ──────────────────────────────────────────────────────────
  /** move → dwell → post-settle frame → judge. Returns null when no frame came. */
  async function lookAt(pose: Pose, reVisit = false): Promise<Verdict | null> {
    const target = { pan: clampPan(pose.pan), tilt: clampTilt(pose.tilt) };
    // already looking there → just look (moveTo would throw its zero-travel
    // guard — live turn-da34f2c1: the plan's FIRST pose is the current pose).
    if (!samePose(deps.pose(), target)) {
      try {
        await deps.moveTo(target);
      } catch (err) {
        // a blocked/failed move skips THIS pose, it doesn't kill the search
        log(`[search] ${dock}: move to ${describePose(target)} failed (${err instanceof Error ? err.message : err}) — skipping`);
        if (!reVisit) record(pose, { match: false, confidence: 0, note: 'could not move here' });
        return null;
      }
    }
    await sleep(DWELL_MS);
    if (abortedNow()) return null;
    // ONE sharp still is the sensor (2026-07-17 simplification); the stream
    // frame is only the no-still fallback. The judged image, the saved image,
    // and the pose we end up facing are all THE SAME picture — the old
    // stream-lag/escalation layers made them drift apart.
    const frame = (await deps.captureStill?.().catch(() => undefined)) ?? deps.frameSince(now() - 1_500);
    if (!frame) {
      log(`[search] ${dock}: no frame at ${describePose(pose)} — skipping`);
      if (!reVisit) record(pose, { match: false, confidence: 0, note: 'camera gave no frame here' });
      return null;
    }
    lastFrame = frame;
    const verdict = await deps.judge(frame);
    ctx!.judgeCalls += 1;
    if (DEBUG_SHOTS && deps.saveShot) {
      try { deps.saveShot(frame, `pose${pose.pan}x${pose.tilt}${verdict.match ? '-MATCH' : ''}`); } catch { /* */ }
    }
    if (!reVisit) record(pose, verdict);
    log(`[search] ${dock}: ${describePose(pose)} → ${verdict.match ? `MATCH ${verdict.label} ${verdict.confidence.toFixed(2)}` : 'no'}`);
    return verdict;
  }

  function record(pose: Pose, verdict: Verdict): void {
    ctx!.visited.push({ pose: { ...pose }, at: now(), verdict });
    ctx!.updatedAt = now();
  }

  /** Re-visit a KNOWN candidate's pose ("find another one" fast path): one
   *  look; still there → center and hand it back, else null. */
  async function visitAndConfirm(pose: Pose, cand: Candidate): Promise<Candidate | null> {
    const v = await lookAt(pose, /*reVisit*/ true);
    if (!v?.match || v.confidence < CONF_AMBIGUOUS) return null;
    cand.confidence = Math.max(cand.confidence, v.confidence);
    return center(cand, v);
  }

  /** SIMPLIFIED centering (2026-07-17): face the pose that SAW the target —
   *  it is within ±half-FOV by construction. The old nudge-and-relook dance
   *  needed a mirror-sign guess that was wrong live twice ("found you" while
   *  staring elsewhere); offsets are reported in words, not chased. */
  async function center(cand: Candidate, _verdict: Verdict): Promise<Candidate> {
    if (!samePose(deps.pose(), cand.pose)) {
      try { await deps.moveTo(cand.pose); } catch { /* offline/blocked — leave it */ }
    }
    cand.centered = true;
    ctx!.updatedAt = now();
    return cand;
  }
}

export function describePose(p: Pose): string {
  const pan = p.pan === 0 ? 'straight ahead'
    : `${Math.abs(Math.round(p.pan))}° to the ${p.pan > 0 ? 'left' : 'right'}`;
  const tilt = p.tilt === 0 ? '' : p.tilt < 0 ? ', looking up' : ', looking down';
  return pan + tilt;
}

/** The move-tool step for one pose (both joints together, auto-paced). */
export function stepsFor(pose: Pose): MoveStep[] {
  return [{ parts: [{ part: 'foot', degrees: pose.pan }, { part: 'neck', degrees: pose.tilt }] }];
}

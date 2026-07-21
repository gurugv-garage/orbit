/**
 * The `perceive` stream — the phone's ON-DEVICE MLKit face perception, forwarded to
 * the station as the FAST face source for faceFollow (docs/decision-traces/
 * facefollow-and-actuator-lease.md §7). MLKit runs on the phone (low latency,
 * mirror-corrected, good at off-frontal faces — exactly what tracking needs), where the
 * station-side face-api path was the wrong source (missed off-frontal faces, read box `y`
 * far too low → neck-dive).
 *
 * This is a LIVE LATEST-STATE signal — the per-dock "last face frame" — NOT the heavy
 * 1000-cap SnapshotStore memory ring. The presence gate reads "the latest perceive faces"
 * (main.ts present()); nobody needs the history, so we keep only the most recent frame per
 * dock (a tiny Map, not a ring). Only identity (a kind the ring already models) might ALSO
 * land as snapshots — the geometry never does.
 */

/** A face in the neutral "who's visible" shape (name/confidence + NDC box + optional
 *  eye-midpoint anchor). Produced by `toFollowFaces` from the raw MLKit `perceive` frame;
 *  consumed by the presence gate (main.ts `present()`) that the conductor reads. */
export interface Face {
  name: string | null;
  confidence: number;
  box: { x: number; y: number; w: number; h: number }; // normalized 0..1
  /** eye-midpoint anchor (perceive §7), 0..1 — present when both eyes were visible. */
  eyeMid?: { x: number; y: number };
}

/** One face as the phone's MLKit pass reports it (envelope §7). NDC throughout:
 *  x,y ∈ [-1,+1], x+ = the user's RIGHT, y+ = DOWN; `size` = box width fraction 0..1. */
export interface PerceiveFace {
  x: number; y: number; size: number;     // NDC box center + width frac
  bbox?: { l: number; t: number; r: number; b: number }; // NDC rect
  yaw?: number; pitch?: number; roll?: number;            // head Euler degrees
  trackingId?: number;                     // stable across frames → continuity lock
  smile?: number; leftEyeOpen?: number; rightEyeOpen?: number; // MLKit probs 0..1
  landmarks?: Array<{ type: string; x: number; y: number }>;   // NDC; types per §7
}

/** The full `perceive` frame payload (envelope §7). Everything MLKit already computes —
 *  zero new inference; faces empty ⇒ face lost. */
export interface PerceivePayload {
  faces: PerceiveFace[];
  zoom?: { ratio: number; min: number; max: number };
  // (emotion is no longer forwarded on the perceive stream — the station's face-api
  // reads it from the SFU stream; see docs/decision-traces/thin-client-consolidation.md.)
  gesture?: { name: string; palm?: string; score: number };
  identity?: { name: string; confidence: number };
}

/** The latest frame held for a dock, with the station's receive timestamp (ms epoch) so
 *  a consumer can tell how stale the read is. */
export interface PerceiveEntry { ts: number; payload: PerceivePayload }

/**
 * NDC center (−1..+1, y+ down) → the faceFollow box convention. faceFollow's `Face.box`
 * is normalized 0..1 with x/y = the TOP-LEFT corner (so its center is `box.x + box.w/2`),
 * while the phone sends the NDC CENTER + width frac. Map: x ∈ [-1,1] → (x+1)/2 ∈ [0,1],
 * then back off half the size to the top-left. y maps the same way (both are y+ = down, so
 * no flip). Width and height both = `size` (MLKit boxes are ~square; `size` is the width
 * frac and the only size we get cheaply).
 */
function boxFromCenter(f: PerceiveFace): Face['box'] {
  const cx = (f.x + 1) / 2;
  const cy = (f.y + 1) / 2;
  return { x: cx - f.size / 2, y: cy - f.size / 2, w: f.size, h: f.size };
}

/** The EYE-MIDPOINT anchor (envelope §7): the midpoint of the leftEye+rightEye landmarks,
 *  mapped to the same 0..1 space as the box. The box GEOMETRIC center reads low (the box
 *  bottom sags onto the jaw/neck) and is what made the neck dive; the eye midpoint is the
 *  stable anchor to center the head on. Returns undefined when both eyes aren't present
 *  (the caller falls back to the box center). */
function eyeMidFrom(f: PerceiveFace): { x: number; y: number } | undefined {
  const eyes = f.landmarks?.filter((l) => l.type === 'leftEye' || l.type === 'rightEye');
  if (!eyes || eyes.length < 2) return undefined;
  const l = eyes.find((e) => e.type === 'leftEye');
  const r = eyes.find((e) => e.type === 'rightEye');
  if (!l || !r) return undefined;
  // landmarks are NDC like the rest of the frame → same (v+1)/2 mapping into 0..1.
  return { x: ((l.x + r.x) / 2 + 1) / 2, y: ((l.y + r.y) / 2 + 1) / 2 };
}

/**
 * Per-dock latest `perceive` frame — live state, NOT a ring. Holds one entry per dock and
 * notifies subscribers (the console/SSE) on each update. faceFollow reads it via the
 * `face-track` capability (toFollowFaces below); the console reads `latest`/`list`.
 */
export class PerceiveStore {
  #byDock = new Map<string, PerceiveEntry>();
  #listeners = new Set<(dockId: string, entry: PerceiveEntry) => void>();

  /** Replace the dock's latest frame (the phone publishes ~1 Hz, deduped on its side). */
  update(dockId: string, payload: PerceivePayload): void {
    const entry: PerceiveEntry = { ts: Date.now(), payload };
    this.#byDock.set(dockId, entry);
    for (const l of this.#listeners) { try { l(dockId, entry); } catch { /* */ } }
  }

  /** The dock's latest frame, or undefined if none seen yet. */
  latest(dockId: string): PerceiveEntry | undefined {
    return this.#byDock.get(dockId);
  }

  /** All docks' latest frames (for the console). */
  list(): Array<{ dockId: string } & PerceiveEntry> {
    return [...this.#byDock.entries()].map(([dockId, e]) => ({ dockId, ...e }));
  }

  subscribe(fn: (dockId: string, entry: PerceiveEntry) => void): () => void {
    this.#listeners.add(fn);
    return () => this.#listeners.delete(fn);
  }

  /**
   * The dock's latest faces in faceFollow's `Face` shape (the control loop's input):
   *  • name/confidence from the frame's `identity` (one per frame on this cam — the phone
   *    runs one identity pass, not per-face), falling back to `size` as a rough confidence
   *    so a salient close face still outranks a far one when no identity is known;
   *  • box from the NDC center→top-left mapping;
   *  • `eyeMid` attached when both eyes are visible — the better centering anchor (the
   *    direct fix for the neck-dive); absent ⇒ the controller uses the box center.
   * Empty when there's no frame or no faces (faceFollow then searches).
   */
  toFollowFaces(entry: PerceiveEntry | undefined): Face[] {
    if (!entry) return [];
    const id = entry.payload.identity;
    return entry.payload.faces.map((f) => ({
      name: id?.name ?? null,
      confidence: id?.confidence ?? f.size,
      box: boxFromCenter(f),
      eyeMid: eyeMidFrom(f),
    }));
  }
}

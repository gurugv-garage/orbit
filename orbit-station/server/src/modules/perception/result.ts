/**
 * PerceptionResult — the single typed envelope every processor emits.
 *
 * One `perception` bus topic carries ALL results, discriminated by `kind`. Adding
 * a new processor adds a `kind`, never a new topic. The result is directed to its
 * dock (the bus honors `to:`) so the dock's agent re-grounds on it, and the
 * per-dock world-state ([state.ts]) re-broadcasts an aggregate for the console.
 *
 * `source` identifies the producing processor (provenance / debugging);
 * `dockId`+`streamId` identify who the result is ABOUT (routing + grouping).
 */

/** Known result kinds. Open-ended (string) so processors can add their own. */
export type PerceptionResultKind =
  | 'identity'      // who is this person (face/voice fused) — { name, confidence }
  | 'presence'      // is someone present — { present }
  | 'emotion'       // { kind, confidence }
  | 'transcript'    // STT — { text, isFinal }
  | 'addressing'    // is the user talking TO the robot — { addressing, confidence }
  | 'speaker'       // diarization turn — { speakerId, name? }
  | 'scene'         // scene/object summary — { labels }
  | 'attention'     // gaze/attention — { onRobot, confidence }
  | 'watcher-event' // a dynamic watcher fired — { goal, detail }
  | (string & {});

export interface PerceptionResult {
  /** discriminator — what this result asserts. */
  kind: PerceptionResultKind;
  /** the dock this result is about (routing target + console grouping). */
  dockId: string;
  /** the producer peer id this result is about (provenance). */
  streamId: string;
  /** station receive/emit time (ms epoch). */
  ts: number;
  /** 0..1 where meaningful. */
  confidence?: number;
  /** kind-specific body, e.g. { name: 'guru' } for identity. */
  payload: unknown;
  /** which processor produced it, e.g. 'face-recognition'. */
  source: string;
}

/** Build a result, stamping `ts` if not given. */
export function makeResult(r: Omit<PerceptionResult, 'ts'> & { ts?: number }): PerceptionResult {
  return { ...r, ts: r.ts ?? Date.now() };
}

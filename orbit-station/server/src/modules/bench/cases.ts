/**
 * Case loading + objective scoring. The `expect` assertions are a 1:1 port of
 * the Kotlin bench's checks (node-dock/app/bench), now run against the SAME
 * brain code the live dock uses (modules/brain schemas + prompt + tools).
 */

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { FACES, DEGREE_LIMITS } from '../brain/schemas.js';
import type { BenchCase, CaseFile, Expect } from './types.js';

const DIR = dirname(fileURLToPath(import.meta.url));
export const CASES_DIR = join(DIR, 'cases');
export const IMAGES_DIR = join(DIR, 'images');

/** All cases across cases/*.json, in capability-file order. */
export function loadCases(): BenchCase[] {
  const out: BenchCase[] = [];
  for (const f of readdirSync(CASES_DIR).filter((n) => n.endsWith('.json')).sort()) {
    const file = JSON.parse(readFileSync(join(CASES_DIR, f), 'utf8')) as CaseFile;
    for (const c of file.cases) out.push({ ...c, capability: file.capability });
  }
  return out;
}

/** A normalized view of one model turn, for scoring. */
export interface TurnObservation {
  speech: string;
  toolCalls: Array<{ name: string; args: Record<string, unknown> }>;
  error: string | null;
}

/** Score a turn against a case's expectations. Returns the fail reasons ([] =
 *  pass), so the viewer can show exactly what broke. */
export function score(expect: Expect, obs: TurnObservation): string[] {
  const reasons: string[] = [];
  const moveTools = obs.toolCalls.filter((t) => t.name === 'move' || t.name === 'set_face');

  if (expect.noMove && moveTools.length > 0) {
    reasons.push(`moved when it shouldn't (${moveTools.map((t) => t.name).join(', ')})`);
  }
  if (expect.nonEmptySpeech && obs.speech.trim().length === 0) reasons.push('no speech');
  if (expect.minSpeechChars != null && obs.speech.trim().length < expect.minSpeechChars) {
    reasons.push(`speech too short (${obs.speech.trim().length} < ${expect.minSpeechChars})`);
  }
  if (expect.tool === 'any' && obs.toolCalls.length === 0) reasons.push('no tool called');
  else if (typeof expect.tool === 'string' && expect.tool !== 'any'
    && !obs.toolCalls.some((t) => t.name === expect.tool)) {
    reasons.push(`expected tool '${expect.tool}' not called`);
  }
  if (expect.toolName && !obs.toolCalls.some((t) => t.name === expect.toolName)) {
    reasons.push(`expected '${expect.toolName}' not called`);
  }
  if (expect.minToolCalls != null && obs.toolCalls.length < expect.minToolCalls) {
    reasons.push(`too few tool calls (${obs.toolCalls.length} < ${expect.minToolCalls})`);
  }

  // flatten every move step to {part, degrees, duration_ms}: a step is either
  // {part, degrees, …} or {parts:[{part,degrees}…], …} (joints moving together).
  const moveSteps: Array<{ part?: string; degrees?: number; duration_ms?: number }> = [];
  for (const t of obs.toolCalls) {
    if (t.name !== 'move') continue;
    const steps = (t.args as { steps?: unknown }).steps;
    if (!Array.isArray(steps)) continue;
    for (const raw of steps as Array<Record<string, unknown>>) {
      const dur = raw.duration_ms == null ? undefined : Number(raw.duration_ms);
      if (Array.isArray(raw.parts)) {
        for (const j of raw.parts as Array<Record<string, unknown>>) {
          moveSteps.push({ part: String(j.part ?? ''), degrees: Number(j.degrees), duration_ms: dur });
        }
      } else {
        moveSteps.push({ part: String(raw.part ?? ''), degrees: Number(raw.degrees), duration_ms: dur });
      }
    }
  }

  const topLevelStepCount = obs.toolCalls
    .filter((t) => t.name === 'move')
    .reduce((n, t) => n + (Array.isArray((t.args as { steps?: unknown }).steps)
      ? (t.args as { steps: unknown[] }).steps.length : 0), 0);
  if (expect.minSteps != null && topLevelStepCount < expect.minSteps) {
    reasons.push(`too few move steps (${topLevelStepCount} < ${expect.minSteps})`);
  }
  if (expect.maxSteps != null && topLevelStepCount > expect.maxSteps) {
    reasons.push(`too many move steps (${topLevelStepCount} > ${expect.maxSteps})`);
  }
  if (expect.degRange) {
    const { part, lo, hi } = expect.degRange;
    const candidates = (part ? moveSteps.filter((s) => s.part === part) : moveSteps)
      .map((s) => Number(s.degrees)).filter((d) => Number.isFinite(d));
    // ANY matching step satisfies it (Kotlin parity) — the model can add other
    // steps too. Fail only if NONE of the relevant steps land in range.
    if (!candidates.some((d) => d >= lo && d <= hi)) {
      reasons.push(`no ${part ?? 'move'} step in [${lo},${hi}]°${candidates.length ? ` (saw ${candidates.join(', ')})` : ''}`);
    }
  }
  if (expect.durRange) {
    const { lo, hi } = expect.durRange;
    const durs = moveSteps.map((s) => (s.duration_ms == null ? null : Number(s.duration_ms)))
      .filter((d): d is number => d != null && Number.isFinite(d));
    if (durs.length && !durs.some((d) => d >= lo && d <= hi)) {
      reasons.push(`no step with duration in [${lo},${hi}]ms (saw ${durs.join(', ')})`);
    }
  }
  if (expect.validEnums) {
    for (const t of obs.toolCalls) {
      if (t.name === 'set_face') {
        const e = String((t.args as { expression?: unknown }).expression ?? '');
        if (e && !(FACES as readonly string[]).includes(e)) reasons.push(`invalid face '${e}'`);
      }
      if (t.name === 'move') {
        for (const s of (Array.isArray((t.args as { steps?: unknown }).steps)
          ? (t.args as { steps: Array<Record<string, unknown>> }).steps : [])) {
          const part = String(s.part ?? '');
          if (part && !(part in DEGREE_LIMITS)) reasons.push(`invalid part '${part}'`);
        }
      }
    }
  }
  if (expect.keywords && expect.keywords.length) {
    // ANY-of: the keyword list is alternatives (e.g. ["3","three"]) — a port
    // bug had this as all-required, which tanked every model unfairly.
    const low = obs.speech.toLowerCase();
    if (!expect.keywords.some((k) => low.includes(k.toLowerCase()))) {
      reasons.push(`none of [${expect.keywords.join(', ')}] in speech`);
    }
  }
  if (obs.error) reasons.push(`error: ${obs.error}`);
  return reasons;
}

/** base64 of a case image (cases/images first, then the legacy bench/images). */
export function caseImageBase64(image: string | null | undefined): string | undefined {
  if (!image) return undefined;
  for (const dir of [IMAGES_DIR, join(DIR, '..', '..', '..', '..', '..', 'node-dock', 'app', 'bench', 'images')]) {
    const p = join(dir, image);
    if (existsSync(p)) return readFileSync(p).toString('base64');
  }
  return undefined;
}

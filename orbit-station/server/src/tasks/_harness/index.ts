/**
 * Task harness public surface. A `task.ts` imports `Task` (to subclass),
 * `runTask` (the entrypoint), the `TaskManifest` type, and `durationMs`.
 */
export { Task } from './task.js';
export type { TaskIdentity } from './task.js';
export type { DockMemory, MemoryHit } from './memory.js';
export { runTask } from './run.js';
export type { TaskClass } from './run.js';
export { askVision, isTrueInImage } from './vision.js';
export { durationMs } from './types.js';
export type { TaskManifest, TaskParam } from './types.js';
export { validateParams } from './manifest.js';
export type { ValidationResult } from './manifest.js';

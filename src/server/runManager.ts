/**
 * The run manager's NODE FACE. The manager itself — runKeyFor,
 * resolveRunInput, the runs/<runKey>.json cache, the in-memory registry and
 * the queued/running/done/error protocol — moved whole to
 * src/store/runManager.ts in Phase 4 of the browser port, where it is
 * environment-neutral and runs against either storage driver and either kind
 * of worker. The worker_threads execution path it left behind lives in
 * services.ts (the node wiring); this module re-exports every name this path
 * always exported, so the routes, the search pool, the scorers and the tests
 * keep one import path and identical behaviour.
 *
 * If you are looking for the WHY of any function here, it is on the function
 * in src/store/runManager.ts — moved, not rewritten.
 */
import type { RunProgress, RunRequest, RunResult } from '../shared/types';
import { services } from './services';

// The one cache-key function; see its comment in src/store/runManager.ts.
export { runKeyFor } from '../store/runManager';

const manager = services.runManager;

/** See src/store/runManager.ts (readCachedResult). */
export const readCachedResult: (runKey: string) => Promise<RunResult | null> =
  manager.readCachedResult;
/** See src/store/runManager.ts (lookupCachedRun). */
export const lookupCachedRun: (req: RunRequest) => Promise<RunResult | null> =
  manager.lookupCachedRun;
/** See src/store/runManager.ts (startRun). */
export const startRun: (req: RunRequest) => Promise<{ runId: string }> = manager.startRun;
/** See src/store/runManager.ts (getRun). */
export const getRun: (runId: string) => Promise<RunProgress | null> = manager.getRun;

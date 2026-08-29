/**
 * worker_threads entry point: runs one simulation off the main thread so the
 * HTTP server (and the UI it feeds) stays responsive.
 *
 * Spawned by runManager as
 *   new Worker(new URL('./simWorker.ts', import.meta.url), { workerData, execArgv: ['--import', 'tsx'] })
 * so the TypeScript source runs directly under the tsx loader.
 *
 * workerData is the full SimulationInput. Messages posted back:
 *   { type: 'progress', frac, message? }  — throttled to ~every 2%
 *   { type: 'done', result }              — the engine's RunResult
 *   { type: 'error', error }              — message + stack on failure
 */
import { parentPort, workerData } from 'node:worker_threads';
import { execute } from '../engine/index';
import type { SimulationInput } from '../shared/types';
import type { SimWorkerMessage } from '../shared/simWorkerProtocol';

// Re-exported so runManager keeps importing the protocol from the worker it
// spawns; the definition lives in shared/simWorkerProtocol so the browser
// worker speaks the SAME type rather than a copy (see that file's header).
export type { SimWorkerMessage } from '../shared/simWorkerProtocol';

function post(msg: SimWorkerMessage): void {
  parentPort?.postMessage(msg);
}

try {
  const input = workerData as SimulationInput;
  let lastPostedFrac = -1;
  const result = execute(input, (frac: number, message?: string) => {
    // Throttle: only post when progress advanced by >= 2% (or hit completion).
    if (frac - lastPostedFrac >= 0.02 || frac >= 1) {
      lastPostedFrac = frac;
      post({ type: 'progress', frac, message });
    }
  });
  post({ type: 'done', result });
} catch (err) {
  const error =
    err instanceof Error ? `${err.message}\n${err.stack ?? ''}`.trimEnd() : String(err);
  post({ type: 'error', error });
}

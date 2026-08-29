/**
 * Web Worker entry point: runs simulations off the main thread so the UI
 * stays responsive — the browser counterpart of src/server/simWorker.ts,
 * speaking the SAME protocol (shared/simWorkerProtocol) so the run manager
 * can drive either kind without caring which environment it is in.
 *
 * Spawned as
 *   new Worker(new URL('./simWorker.ts', import.meta.url), { type: 'module' })
 * which is Vite's native worker syntax: the worker is bundled ahead of time
 * with the engine compiled in, replacing the Node side's
 * `execArgv: ['--import', 'tsx']` boot (and its measured ~99ms/spawn cost).
 *
 * Web Workers have no `workerData`, so the input arrives as a MESSAGE: every
 * message posted to this worker is one complete SimulationInput, and each one
 * produces one run's worth of replies (progress* then done|error). That makes
 * the worker REUSABLE — the browser run manager keeps one worker alive and
 * posts successive inputs, rather than paying a spawn per run — and because
 * execute() is synchronous, queued messages cannot interleave: the browser
 * delivers the next message only after the current handler returns.
 *
 * The worker is deliberately PURE: no DOM, no fetch, no file access. Whatever
 * the input needs (the parsed historical-returns table above all) must arrive
 * INSIDE the SimulationInput — the same contract the Node worker has always
 * had via workerData. A worker that quietly fetched its own data would fork
 * the byte-parity guarantee between environments at the first stale cache.
 */
import { execute } from '../../engine/index';
import type { SimulationInput } from '../../shared/types';
import type { SimWorkerMessage } from '../../shared/simWorkerProtocol';

// The narrow slice of DedicatedWorkerGlobalScope this file uses, typed
// locally: the repo compiles one program against lib "DOM" (for the React UI),
// and lib "WebWorker" cannot be mixed into the same program without the two
// declaring `self` incompatibly.
const workerScope = self as unknown as {
  onmessage: ((ev: MessageEvent<SimulationInput>) => void) | null;
  postMessage(msg: SimWorkerMessage): void;
};

function post(msg: SimWorkerMessage): void {
  workerScope.postMessage(msg);
}

workerScope.onmessage = (ev: MessageEvent<SimulationInput>) => {
  try {
    const input = ev.data;
    // Per-RUN throttle state, reset for every message: a reused worker whose
    // lastPostedFrac survived from the previous run would swallow the next
    // run's early progress (0.00..0.98 all "behind" the old 1.0).
    let lastPostedFrac = -1;
    const result = execute(input, (frac: number, message?: string) => {
      // Throttle: only post when progress advanced by >= 2% (or hit
      // completion) — same rule, same constant as the Node worker.
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
};

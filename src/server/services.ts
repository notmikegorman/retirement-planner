/**
 * The node wiring of the service layer: THE run manager and THE scorers,
 * composed once over the node stores — the sibling of stores.ts, one layer
 * up, and deliberately just as tiny.
 *
 * The one genuinely node-specific thing in the whole service layer lives
 * here: the worker_threads executor. Everything else (cache, registry,
 * polling, attach rules) is the environment-neutral code in src/store/*, and
 * the faces (runManager.ts, scoreRunner.ts, snapshotScorer.ts,
 * planHistoryScorer.ts) re-export this one instance's methods under their
 * historical names so every existing importer — routes, tests — keeps its
 * import path and its behaviour.
 */
import { Worker } from 'node:worker_threads';
import type { RunResult, SimulationInput } from '../shared/types';
import { createServices, type Services } from '../store/services';
import type { RunExecutor } from '../store/runManager';
import type { SimWorkerMessage } from './simWorker';
import { stores } from './stores';

/**
 * The worker_threads executor: one spawn per run, exactly as the old
 * spawnWorker did. The message handlers translate the worker protocol into
 * the executor contract — resolve on 'done', reject with the same strings the
 * registry always stored on 'error' (the worker's message+stack string, a
 * thrown error with its stack, or the unexpected-exit sentence). A promise
 * settles once, which is the `settled` flag it replaces: an exit event after
 * 'done' changes nothing.
 */
const nodeExecutor: RunExecutor = {
  run(input: SimulationInput, onProgress): Promise<RunResult> {
    return new Promise<RunResult>((resolve, reject) => {
      // This project runs under the tsx loader (npm start = tsx src/server/server.ts),
      // so the worker must also boot tsx to execute the .ts entry directly.
      const worker = new Worker(new URL('./simWorker.ts', import.meta.url), {
        workerData: input,
        execArgv: ['--import', 'tsx'],
      });

      worker.on('message', (msg: SimWorkerMessage) => {
        if (msg.type === 'progress') onProgress(msg.frac, msg.message);
        else if (msg.type === 'done') resolve(msg.result);
        else if (msg.type === 'error') reject(new Error(msg.error));
      });

      worker.on('error', (err) => {
        reject(new Error(err.stack ?? err.message));
      });

      worker.on('exit', (code) => {
        if (code !== 0) {
          reject(new Error(`Simulation worker exited unexpectedly with code ${code}`));
        }
      });
    });
  },
};

/** The one composed service set every server module delegates to. */
export const services: Services = createServices(stores, nodeExecutor);

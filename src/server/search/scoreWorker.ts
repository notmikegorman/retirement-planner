/**
 * A POOL worker: boots once, keeps the profile and assumptions in memory, and
 * answers simulation jobs until it is told to stop.
 *
 * Deliberately not simWorker.ts. That one is one-worker-per-run, which is right
 * for the interactive app (a run is a user action and the worker dies with it)
 * and wrong for a search: booting a worker under the tsx loader costs a
 * measured 99ms, so spawning one per evaluation would add about five minutes of
 * pure startup to a twenty-minute search. It would also re-send the profile and
 * the whole assumptions bundle — including the historical return series — on
 * every single evaluation.
 *
 * It replies with the SLIM score only (see scoreStore.ts). Posting a full
 * RunResult back would structured-clone ~472KB across the thread boundary
 * thousands of times for data nothing in the search reads.
 */
import { parentPort, workerData } from 'node:worker_threads';
import { runSimulation } from '../../engine/simulate';
import type { Assumptions, Profile } from '../../shared/types';
import { scoreFromResult } from '../../store/search/scoreStore';
import type { ScoreJob, ScoreWorkerMessage } from '../../store/search/workerProtocol';

// The protocol moved to src/store/search/workerProtocol.ts in Phase 5 (the
// browser pool worker speaks it too); re-exported so the pool and every other
// historical importer keeps this path.
export type { ScoreJob, ScoreWorkerMessage } from '../../store/search/workerProtocol';

interface WorkerInit {
  profile: Profile;
  assumptions: Assumptions;
}

const init = workerData as WorkerInit;

parentPort?.on('message', (job: ScoreJob | { type: 'stop' }) => {
  if ('type' in job && job.type === 'stop') {
    parentPort?.close();
    return;
  }
  const j = job as ScoreJob;
  try {
    // runSimulation, not execute: candidates never carry a solver (the compiler
    // strips it), and going through execute would let one recurse.
    const result = runSimulation({
      profile: init.profile,
      assumptions: init.assumptions,
      scenario: j.scenario,
      mode: j.mode,
      paths: j.paths,
      seed: j.seed,
    });
    const msg: ScoreWorkerMessage = {
      type: 'done',
      jobId: j.jobId,
      score: scoreFromResult(j.runKey, result),
    };
    parentPort?.postMessage(msg);
  } catch (err) {
    const error =
      err instanceof Error ? `${err.message}\n${err.stack ?? ''}`.trimEnd() : String(err);
    const msg: ScoreWorkerMessage = { type: 'error', jobId: j.jobId, error };
    parentPort?.postMessage(msg);
  }
});

parentPort?.postMessage({ type: 'ready' } satisfies ScoreWorkerMessage);

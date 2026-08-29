/**
 * The browser POOL worker: boots once, receives {profile, assumptions} as its
 * FIRST message, and answers simulation jobs with slim scores until it is
 * told to stop — the Web Worker counterpart of
 * src/server/search/scoreWorker.ts, speaking the SAME protocol
 * (store/search/workerProtocol) so the two pools can never find their workers
 * disagreeing on shape.
 *
 * Deliberately not simWorker.ts. That one answers with full RunResults for
 * the interactive app, where a human looks at one run at a time; a search
 * asks by the thousand and reads eight numbers per answer, so posting a full
 * result would structured-clone ~472KB across the boundary thousands of times
 * for data nothing in the search reads. The init-once design is the other
 * half of the same economy: the profile and the whole assumptions bundle —
 * historical return series included — cross the boundary once per worker,
 * not once per evaluation (the node side's per-eval alternative measured 99ms
 * of boot each; Vite's precompiled workers make spawn cheaper here, but
 * re-cloning the assumptions per job would still be pure waste).
 *
 * Same purity rule as simWorker.ts: no DOM, no fetch, no file access. A
 * worker that quietly fetched its own data would fork the byte-parity
 * guarantee between environments at the first stale cache.
 */
import { runSimulation } from '../../engine/simulate';
import type { Assumptions, Profile } from '../../shared/types';
import { scoreFromResult } from '../../store/search/scoreStore';
import type {
  ScoreJob,
  ScoreWorkerCommand,
  ScoreWorkerMessage,
} from '../../store/search/workerProtocol';

// The narrow slice of DedicatedWorkerGlobalScope this file uses, typed
// locally — same reasoning as simWorker.ts (one program, lib "DOM").
const workerScope = self as unknown as {
  onmessage: ((ev: MessageEvent<ScoreWorkerCommand>) => void) | null;
  postMessage(msg: ScoreWorkerMessage): void;
  close(): void;
};

function post(msg: ScoreWorkerMessage): void {
  workerScope.postMessage(msg);
}

let init: { profile: Profile; assumptions: Assumptions } | null = null;

workerScope.onmessage = (ev: MessageEvent<ScoreWorkerCommand>) => {
  const msg = ev.data;
  if ('type' in msg) {
    if (msg.type === 'init') {
      init = { profile: msg.profile, assumptions: msg.assumptions };
      post({ type: 'ready' });
      return;
    }
    // 'stop': drain — mirrors the node worker's parentPort.close().
    workerScope.close();
    return;
  }
  const j: ScoreJob = msg;
  if (!init) {
    post({
      type: 'error',
      jobId: j.jobId,
      error: 'Score worker received a job before its init message',
    });
    return;
  }
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
    post({ type: 'done', jobId: j.jobId, score: scoreFromResult(j.runKey, result) });
  } catch (err) {
    const error =
      err instanceof Error ? `${err.message}\n${err.stack ?? ''}`.trimEnd() : String(err);
    post({ type: 'error', jobId: j.jobId, error });
  }
};

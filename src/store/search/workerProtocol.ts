/**
 * The message protocol both SCORE workers speak — the Node pool worker
 * (src/server/search/scoreWorker.ts, worker_threads) and the browser pool
 * worker (src/ui/workers/searchScoreWorker.ts, Web Worker) — the sibling of
 * shared/simWorkerProtocol.ts, for the same reason: one definition, imported
 * by both, so the two pools can never find their workers disagreeing on
 * shape. It lives beside the search core rather than under src/shared because
 * the reply carries a SearchScore, whose home is ./scoreStore — and a shared
 * module importing upward from the store layer would invert the layering.
 *
 * The protocol, per worker lifetime:
 *   ScoreJob in  — one simulation ask; the worker replies exactly once per
 *     job with 'done' (the SLIM score — never the ~472KB RunResult, which
 *     would structured-clone across the boundary thousands of times for data
 *     nothing in the search reads) or 'error' (message + stack as ONE string;
 *     structured clone of Error objects differs between worker_threads and
 *     Web Workers).
 *   { type: 'stop' } — drain: the worker closes its own end.
 *   { type: 'ready' } out — informational; the pools do not gate on it.
 *
 * How the INIT {profile, assumptions} arrives differs by environment and is
 * deliberately half in this type: worker_threads delivers it as `workerData`
 * at spawn; Web Workers have no workerData, so it arrives as the FIRST posted
 * message (ScoreWorkerInit below — the node worker never sees one). Keeping
 * the init out of the per-job shape is the point of a persistent pool: the
 * profile and the whole assumptions bundle — historical return series
 * included — cross the boundary once per worker, not once per evaluation.
 */
import type { Assumptions, Profile, RunMode, Scenario } from '../../shared/types';
import type { SearchScore } from './scoreStore';

export interface ScoreJob {
  /** Correlation id chosen by the pool. */
  jobId: number;
  /** The cache key this result belongs to, echoed back into the score. */
  runKey: string;
  scenario: Scenario;
  mode: RunMode;
  paths: number;
  seed: number;
}

export type ScoreWorkerMessage =
  | { type: 'ready' }
  | { type: 'done'; jobId: number; score: SearchScore }
  | { type: 'error'; jobId: number; error: string };

/** The browser worker's first message; node delivers the same via workerData. */
export interface ScoreWorkerInit {
  type: 'init';
  profile: Profile;
  assumptions: Assumptions;
}

/** Everything a browser score worker can be sent after init. */
export type ScoreWorkerCommand = ScoreJob | ScoreWorkerInit | { type: 'stop' };

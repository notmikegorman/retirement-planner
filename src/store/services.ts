/**
 * The service layer, composed: one call wires the run manager, the score
 * runner and both scorers to a store set and an execution seam. The sibling
 * of createStores (./index.ts), one layer up —
 *
 *   - src/server/services.ts binds it to the node stores and a worker_threads
 *     executor, and the node faces re-export the instance methods under the
 *     exact module surface the server and its tests always had;
 *   - the browser's local backend binds it to the picked-folder/OPFS stores
 *     and the reusable Web Worker executor.
 *
 * One composition function for the same reason createStores is one: the
 * services reference EACH OTHER (both scorers poll through the one run
 * manager's registry, and their ScoringDeps must be built from THAT instance,
 * not a second one with an empty registry) — two half-wired instances would
 * poll a manager that never heard of their runs, and every score would
 * "disappear before it produced a result".
 */
import type { Stores } from './index';
import { createPlanHistoryScorer, type PlanHistoryScorer } from './planHistoryScorer';
import { createRunManager, type RunExecutor, type RunManager } from './runManager';
import {
  createScoreRunner,
  realScoringDeps,
  type ScoreRunner,
  type ScoringDeps,
} from './scoreRunner';
import { createSnapshotScorer, type SnapshotScorer } from './snapshotScorer';

export interface Services {
  runManager: RunManager;
  scoreRunner: ScoreRunner;
  /** The real deps both scorers default to — built from THIS run manager. */
  scoringDeps: ScoringDeps;
  snapshotScorer: SnapshotScorer;
  planHistoryScorer: PlanHistoryScorer;
}

export function createServices(stores: Stores, executor: RunExecutor): Services {
  const runManager = createRunManager({ data: stores.data, executor });
  const scoreRunner = createScoreRunner(stores.data);
  const scoringDeps = realScoringDeps(runManager);
  const snapshotScorer = createSnapshotScorer({
    networth: stores.networth,
    planHistory: stores.planHistory,
    plan: stores.plan,
    runner: scoreRunner,
    defaultDeps: scoringDeps,
  });
  const planHistoryScorer = createPlanHistoryScorer({
    planHistory: stores.planHistory,
    runner: scoreRunner,
    defaultDeps: scoringDeps,
  });
  return { runManager, scoreRunner, scoringDeps, snapshotScorer, planHistoryScorer };
}

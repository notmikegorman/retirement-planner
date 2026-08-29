/**
 * The search executor's NODE FACE. The successive-halving orchestration — the
 * calibration ladder, the disjoint seed sets, the paired deltas, the honest
 * verdicts, cancellation, all of it — moved whole to
 * src/store/search/execute.ts in Phase 5 of the browser port, where it is
 * environment-neutral and runs identically inside the browser's coordinator
 * worker. If you are looking for the WHY of anything the search does, it is
 * there — moved, not rewritten.
 *
 * What this face OWNS is the node environment: the worker_threads pool, the
 * os.cpus() sizing, and the folder-bound evaluator, injected through the
 * SearchEnv seam so runSearch keeps the four-argument signature every caller
 * and test always had. The imports from './pool' are deliberate — the
 * executor and manager tests substitute their modelled worlds by mocking that
 * module, and this face is where the substitution takes effect.
 */
import type { SearchReport, SearchRequest } from '../../shared/types';
import {
  runSearch as runSearchCore,
  type SearchDeps,
  type SearchHooks,
} from '../../store/search/execute';
import { CachedEvaluator, SimPool, defaultPoolSize } from './pool';

export {
  CancelledError,
  DEFAULT_BUDGET,
  buildSchedule,
  type SearchDeps,
  type SearchEnv,
  type SearchEvaluator,
  type SearchHooks,
} from '../../store/search/execute';

export function runSearch(
  searchId: string,
  request: SearchRequest,
  deps: SearchDeps,
  hooks: SearchHooks,
): Promise<SearchReport> {
  return runSearchCore(searchId, request, deps, hooks, {
    defaultPoolSize,
    createPool: (size, init) => new SimPool(size, init),
    createEvaluator: (pool, profile, assumptions) =>
      new CachedEvaluator(pool, profile, assumptions),
  });
}

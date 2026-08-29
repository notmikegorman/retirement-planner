/**
 * The search manager's NODE FACE. The lifecycle — start, poll, cancel,
 * persist, list, reopen — moved whole to src/store/searchManager.ts in Phase
 * 5 of the browser port, where it is environment-neutral and runs against
 * either storage driver and either kind of search runner. What this face owns
 * is the node wiring: the node stores, and a runner that executes the search
 * in-process over the worker_threads pool (via the execute face, so the
 * search tests' pool substitution keeps taking effect). Every name this path
 * always exported is re-exported from the one composed instance, so the
 * routes and the tests keep one import path and identical behaviour.
 *
 * If you are looking for the WHY of any function here, it is on the function
 * in src/store/searchManager.ts — moved, not rewritten.
 */
import type { SearchProgress, SearchReport, SearchRequest, SearchSummary } from '../shared/types';
import { createSearchManager, type SearchRunner } from '../store/searchManager';
import { runSearch } from './search/execute';
import { stores } from './stores';

/**
 * In-process runner: the executor's promise IS the handle, and the
 * cooperative cancel flag is a closure boolean the executor polls between
 * chunks — exactly the wiring startSearch always had inline.
 */
const nodeRunner: SearchRunner = (searchId, request, deps, onProgress) => {
  let cancelled = false;
  const report = runSearch(searchId, request, deps, {
    update: onProgress,
    cancelled: () => cancelled,
  });
  return {
    report,
    cancel: () => {
      cancelled = true;
    },
  };
};

const manager = createSearchManager({ data: stores.data, runner: nodeRunner });

/** See src/store/searchManager.ts (startSearch). */
export const startSearch: (request: SearchRequest) => Promise<{ searchId: string }> =
  manager.startSearch;
/** See src/store/searchManager.ts (getSearch). */
export const getSearch: (searchId: string) => Promise<SearchProgress | null> = manager.getSearch;
/** See src/store/searchManager.ts (cancelSearch). */
export const cancelSearch: (searchId: string) => boolean = manager.cancelSearch;
/** See src/store/searchManager.ts (listSearches). */
export const listSearches: () => Promise<SearchSummary[]> = manager.listSearches;
/** See src/store/searchManager.ts (getSearchReport). */
export const getSearchReport: (searchId: string) => Promise<SearchReport> =
  manager.getSearchReport;

/**
 * Search lifecycle: start, poll, cancel, persist, list — ENVIRONMENT-NEUTRAL
 * since Phase 5 of the browser port.
 *
 * This is the same module that lived whole at src/server/searchManager.ts,
 * with one structural change and no behavioural ones: everything environment-
 * specific arrives as a parameter. The DataStore carries the folder (the
 * searches/<id>.json reports and the profile/assumptions resolution), and the
 * actual RUNNING of a search — the executor over a worker_threads pool under
 * node, the executor inside a dedicated coordinator worker in the browser —
 * arrives as a `SearchRunner`. The registry is per-INSTANCE now rather than
 * per-module, which changes nothing under node (the server composes exactly
 * one) and is the point in the browser: one tab, one folder, one registry.
 *
 * A search takes minutes, so it cannot be a request/response. startSearch
 * returns a searchId immediately and the work runs in the background; the UI
 * polls getSearch for a SearchProgress that carries the stage, the counters,
 * the live leaderboard and — once it exists — the whole report.
 *
 * CANCELLATION IS A FIRST-CLASS OUTCOME, not an error. A twenty-minute run
 * that the user stops after eight minutes still writes a report, clearly
 * labelled with the precision it actually reached. The alternative — throwing
 * the work away — teaches them not to start one.
 *
 * Reports are persisted to searches/<id>.json so a finished search survives a
 * restart (of the server process, or of the tab) and can be reopened,
 * compared, and mined for scenarios to save. The slim per-evaluation scores
 * live beside them in searches/scores/ (see search/scoreStore.ts).
 */
import { randomHex } from '../shared/random';
import type {
  SearchProgress,
  SearchReport,
  SearchRequest,
  SearchSummary,
} from '../shared/types';
import { missingQuotesMessage } from '../shared/holdings';
import { FileNotFoundError } from '../shared/fileStore';
import { NotFoundError, ValidationError, type DataStore } from './dataStore';
import type { SearchDeps } from './search/execute';

const SEARCH_ID_RE = /^[a-z0-9]{8,40}$/;

/**
 * One search in flight, from the manager's side of the environment seam.
 * `report` settles when the search does — with a report even when cancelled
 * (the executor's contract); `cancel()` is the cooperative flag, checked by
 * the executor between chunks. Under node it flips a closure boolean; in the
 * browser it crosses into the coordinator worker as a message. Either way the
 * search finishes the batch it is in and then writes what it has.
 */
export interface SearchRunHandle {
  report: Promise<SearchReport>;
  cancel(): void;
}

export type SearchRunner = (
  searchId: string,
  request: SearchRequest,
  deps: SearchDeps,
  onProgress: (patch: Partial<SearchProgress>) => void,
) => SearchRunHandle;

export interface SearchManager {
  startSearch(request: SearchRequest): Promise<{ searchId: string }>;
  getSearch(searchId: string): Promise<SearchProgress | null>;
  cancelSearch(searchId: string): boolean;
  listSearches(): Promise<SearchSummary[]>;
  getSearchReport(searchId: string): Promise<SearchReport>;
}

export interface SearchManagerOptions {
  data: DataStore;
  runner: SearchRunner;
  /** Where non-fatal failures go (default console.error). */
  onLog?: (message: string) => void;
}

interface Entry {
  progress: SearchProgress;
  cancelled: boolean;
  handle: SearchRunHandle | null;
}

function reportPath(searchId: string): string {
  if (!SEARCH_ID_RE.test(searchId)) throw new NotFoundError(`Unknown search "${searchId}"`);
  return `searches/${searchId}.json`;
}

function newSearchId(): string {
  return `${Date.now().toString(36)}${randomHex(4)}`.toLowerCase();
}

function initialProgress(searchId: string): SearchProgress {
  return {
    searchId,
    status: 'queued',
    stage: 'queued',
    stageLabel: 'starting',
    evaluated: 0,
    total: 0,
    cacheHits: 0,
    ratePerSec: 0,
    startedAt: new Date().toISOString(),
    elapsedMs: 0,
    rounds: [],
    leaderboard: [],
  };
}

export function createSearchManager(opts: SearchManagerOptions): SearchManager {
  const { data, runner, onLog = (m) => console.error(m) } = opts;

  /** In-memory, keyed by searchId. Finished searches also live on disk. */
  const searches = new Map<string, Entry>();

  /**
   * Start a search. Returns as soon as the id exists; the work continues in
   * the background and is observed through getSearch().
   */
  async function startSearch(request: SearchRequest): Promise<{ searchId: string }> {
    // Profile and assumptions are resolved ONCE, here, and handed to every
    // worker in the pool. They are not search axes — the backend owns them —
    // and loading them per evaluation would re-read and re-validate the whole
    // assumptions bundle thousands of times. RESOLVED, like a run: the search
    // compiler reads profile.accounts (currentPortfolioMix, the stockShare
    // axis), so holdings must already be priced here — and priced COMPLETELY,
    // because a thousand evaluations against a stale cache would poison every
    // score at once.
    const { profile, missing } = await data.loadResolvedProfile();
    if (missing.length > 0) throw new ValidationError(missingQuotesMessage(missing));
    const assumptions = await data.loadAssumptions();

    const searchId = newSearchId();
    const entry: Entry = { progress: initialProgress(searchId), cancelled: false, handle: null };
    searches.set(searchId, entry);

    const onProgress = (patch: Partial<SearchProgress>): void => {
      entry.progress = { ...entry.progress, ...patch, searchId };
    };

    entry.progress = { ...entry.progress, status: 'running' };
    const handle = runner(searchId, request, { profile, assumptions }, onProgress);
    entry.handle = handle;

    void handle.report.then(
      async (report) => {
        entry.progress = {
          ...entry.progress,
          status: report.truncated ? 'cancelled' : 'done',
          stage: report.truncated ? 'cancelled' : 'done',
          stageLabel: report.truncated ? 'stopped early — partial report' : 'done',
          report,
          elapsedMs: report.elapsedMs,
        };
        await persistReport(report);
      },
      (err: unknown) => {
        entry.progress = {
          ...entry.progress,
          status: 'error',
          stage: 'error',
          stageLabel: 'failed',
          error: err instanceof Error ? (err.stack ?? err.message) : String(err),
        };
        onLog(`Search ${searchId} failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
      },
    );

    return { searchId };
  }

  /** Live progress, falling back to a persisted report after a restart. */
  async function getSearch(searchId: string): Promise<SearchProgress | null> {
    const entry = searches.get(searchId);
    if (entry) return entry.progress;
    if (!SEARCH_ID_RE.test(searchId)) return null;
    const report = await readReport(searchId);
    if (!report) return null;
    return {
      searchId,
      status: report.truncated ? 'cancelled' : 'done',
      stage: report.truncated ? 'cancelled' : 'done',
      stageLabel: report.truncated ? 'stopped early — partial report' : 'done',
      evaluated: report.evaluations + report.cacheHits,
      total: report.evaluations + report.cacheHits,
      cacheHits: report.cacheHits,
      ratePerSec: 0,
      startedAt: report.createdAt,
      elapsedMs: report.elapsedMs,
      rounds: report.rounds,
      leaderboard: [],
      calibration: report.calibration,
      report,
    };
  }

  /**
   * Ask a running search to stop. It finishes the batch it is in and then
   * writes the partial report, so this returns immediately and the caller
   * keeps polling.
   */
  function cancelSearch(searchId: string): boolean {
    const entry = searches.get(searchId);
    if (!entry) return false;
    if (entry.progress.status === 'done' || entry.progress.status === 'error') return false;
    entry.cancelled = true;
    entry.progress = { ...entry.progress, stageLabel: 'stopping — writing what it has' };
    entry.handle?.cancel();
    return true;
  }

  async function persistReport(report: SearchReport): Promise<void> {
    try {
      await data.files.mkdir('searches');
      await data.files.writeText(
        reportPath(report.searchId),
        `${JSON.stringify(report, null, 2)}\n`,
      );
    } catch (err) {
      onLog(`Failed to persist search report ${report.searchId}: ${String(err)}`);
    }
  }

  async function readReport(searchId: string): Promise<SearchReport | null> {
    try {
      const text = await data.files.readText(reportPath(searchId));
      return JSON.parse(text) as SearchReport;
    } catch {
      return null;
    }
  }

  /** Newest first. Summaries only — a full report is ~100KB of JSON. */
  async function listSearches(): Promise<SearchSummary[]> {
    let names: string[];
    try {
      names = (await data.files.list('searches')).map((e) => e.name);
    } catch (err) {
      if (err instanceof FileNotFoundError) return [];
      throw err;
    }
    const out: SearchSummary[] = [];
    for (const name of names.filter((n) => n.endsWith('.json'))) {
      const id = name.slice(0, -'.json'.length);
      if (!SEARCH_ID_RE.test(id)) continue;
      const report = await readReport(id);
      if (!report) continue;
      out.push({
        searchId: report.searchId,
        ...(report.label !== undefined ? { label: report.label } : {}),
        createdAt: report.createdAt,
        engineVersion: report.engineVersion,
        spaceHash: report.spaceHash,
        dims: report.axes.map((a) => a.dim),
        candidatesGenerated: report.candidatesGenerated,
        ...(report.finalists[0] ? { winnerLabel: report.finalists[0].label } : {}),
        truncated: report.truncated,
        elapsedMs: report.elapsedMs,
      });
    }
    out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return out;
  }

  /** The full stored report, for reopening a finished search. */
  async function getSearchReport(searchId: string): Promise<SearchReport> {
    const live = searches.get(searchId)?.progress.report;
    if (live) return live;
    const stored = await readReport(searchId);
    if (!stored) throw new NotFoundError(`No report for search "${searchId}"`);
    return stored;
  }

  return { startSearch, getSearch, cancelSearch, listSearches, getSearchReport };
}

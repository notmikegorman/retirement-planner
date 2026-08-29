/**
 * Search lifecycle: start, poll, cancel, persist, list.
 *
 * A search takes minutes, so it cannot be an HTTP request. POST /api/search
 * returns a searchId immediately and the work runs in the background; the UI
 * polls GET /api/search/:id for a SearchProgress that carries the stage, the
 * counters, the live leaderboard and — once it exists — the whole report.
 *
 * CANCELLATION IS A FIRST-CLASS OUTCOME, not an error. A twenty-minute run that
 * the user stops after eight minutes still writes a report, clearly labelled
 * with the precision it actually reached. The alternative — throwing the work
 * away — teaches them not to start one.
 *
 * Reports are persisted to searches/<id>.json so a finished search survives a
 * server restart and can be reopened, compared, and mined for scenarios to
 * save. The slim per-evaluation scores live beside them in searches/scores/
 * (see search/scoreStore.ts).
 */
import { randomBytes } from 'node:crypto';
import type { SearchProgress, SearchReport, SearchRequest, SearchSummary } from '../shared/types';
import { missingQuotesMessage } from '../shared/holdings';
import { ValidationError, loadAssumptions, loadResolvedProfile, NotFoundError } from './dataStore';
import { FileNotFoundError, dataFiles } from './fileStore';
import { runSearch } from './search/execute';

const SEARCH_ID_RE = /^[a-z0-9]{8,40}$/;

interface Entry {
  progress: SearchProgress;
  cancelled: boolean;
}

/** In-memory, keyed by searchId. Finished searches also live on disk. */
const searches = new Map<string, Entry>();

function reportPath(searchId: string): string {
  if (!SEARCH_ID_RE.test(searchId)) throw new NotFoundError(`Unknown search "${searchId}"`);
  return `searches/${searchId}.json`;
}

function newSearchId(): string {
  return `${Date.now().toString(36)}${randomBytes(4).toString('hex')}`.toLowerCase();
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

/**
 * Start a search. Returns as soon as the id exists; the work continues in the
 * background and is observed through getSearch().
 */
export async function startSearch(request: SearchRequest): Promise<{ searchId: string }> {
  // Profile and assumptions are resolved ONCE, here, and handed to every worker
  // in the pool. They are not search axes — the server owns them — and loading
  // them per evaluation would re-read and re-validate the whole assumptions
  // bundle thousands of times. RESOLVED, like a run: the search compiler reads
  // profile.accounts (currentPortfolioMix, the stockShare axis), so holdings
  // must already be priced here — and priced COMPLETELY, because a thousand
  // evaluations against a stale cache would poison every score at once.
  const { profile, missing } = await loadResolvedProfile();
  if (missing.length > 0) throw new ValidationError(missingQuotesMessage(missing));
  const assumptions = await loadAssumptions();

  const searchId = newSearchId();
  const entry: Entry = { progress: initialProgress(searchId), cancelled: false };
  searches.set(searchId, entry);

  const hooks = {
    update(patch: Partial<SearchProgress>): void {
      entry.progress = { ...entry.progress, ...patch, searchId };
    },
    cancelled(): boolean {
      return entry.cancelled;
    },
  };

  void (async () => {
    try {
      entry.progress = { ...entry.progress, status: 'running' };
      const report = await runSearch(searchId, request, { profile, assumptions }, hooks);
      entry.progress = {
        ...entry.progress,
        status: report.truncated ? 'cancelled' : 'done',
        stage: report.truncated ? 'cancelled' : 'done',
        stageLabel: report.truncated ? 'stopped early — partial report' : 'done',
        report,
        elapsedMs: report.elapsedMs,
      };
      await persistReport(report);
    } catch (err) {
      entry.progress = {
        ...entry.progress,
        status: 'error',
        stage: 'error',
        stageLabel: 'failed',
        error: err instanceof Error ? (err.stack ?? err.message) : String(err),
      };
      console.error(`Search ${searchId} failed:`, err);
    }
  })();

  return { searchId };
}

/** Live progress, falling back to a persisted report after a restart. */
export async function getSearch(searchId: string): Promise<SearchProgress | null> {
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
 * Ask a running search to stop. It finishes the batch it is in and then writes
 * the partial report, so this returns immediately and the caller keeps polling.
 */
export function cancelSearch(searchId: string): boolean {
  const entry = searches.get(searchId);
  if (!entry) return false;
  if (entry.progress.status === 'done' || entry.progress.status === 'error') return false;
  entry.cancelled = true;
  entry.progress = { ...entry.progress, stageLabel: 'stopping — writing what it has' };
  return true;
}

async function persistReport(report: SearchReport): Promise<void> {
  try {
    await dataFiles.mkdir('searches');
    await dataFiles.writeText(reportPath(report.searchId), `${JSON.stringify(report, null, 2)}\n`);
  } catch (err) {
    console.error(`Failed to persist search report ${report.searchId}:`, err);
  }
}

async function readReport(searchId: string): Promise<SearchReport | null> {
  try {
    const text = await dataFiles.readText(reportPath(searchId));
    return JSON.parse(text) as SearchReport;
  } catch {
    return null;
  }
}

/** Newest first. Summaries only — a full report is ~100KB of JSON. */
export async function listSearches(): Promise<SearchSummary[]> {
  let names: string[];
  try {
    names = (await dataFiles.list('searches')).map((e) => e.name);
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
export async function getSearchReport(searchId: string): Promise<SearchReport> {
  const live = searches.get(searchId)?.progress.report;
  if (live) return live;
  const stored = await readReport(searchId);
  if (!stored) throw new NotFoundError(`No report for search "${searchId}"`);
  return stored;
}

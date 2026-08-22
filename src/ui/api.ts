/**
 * Typed API client. The server (src/server) implements exactly these routes.
 * All responses are JSON; errors come back as { error: string } with a 4xx/5xx
 * status and are thrown as Error(message).
 */
import type {
  Assumptions,
  CachedRunResponse,
  DerivedProfileResponse,
  MarketAssumptions,
  NetWorthSnapshot,
  Profile,
  QuoteRefreshResult,
  QuotesFile,
  PlanHistoryEntry,
  PlanRestoreResponse,
  RunProgress,
  RunRequest,
  Scenario,
  SearchProgress,
  SearchReport,
  SearchRequest,
  SearchSummary,
} from '../shared/types';

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  // Only declare a JSON body when there actually is one: Fastify rejects a
  // request that advertises `application/json` but sends nothing ("Body cannot
  // be empty when content-type is set to 'application/json'"), which is what a
  // bodyless request (every GET here) would otherwise do.
  const res = await fetch(path, {
    ...init,
    headers: {
      ...(init?.body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...init?.headers,
    },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(
      typeof (body as { error?: string }).error === 'string'
        ? (body as { error: string }).error
        : `${res.status} ${res.statusText}`,
    );
  }
  return body as T;
}

export interface ServerMeta {
  dataDir: string;
  engineVersion: string;
  dataDirInitialized: boolean;
}

export const api = {
  meta: () => request<ServerMeta>('/api/meta'),

  getProfile: () => request<Profile>('/api/profile'),
  putProfile: (profile: Profile) =>
    request<{ ok: true }>('/api/profile', { method: 'PUT', body: JSON.stringify(profile) }),

  /** Per-account derived holdings detail (price + asOf behind every figure). */
  getDerivedProfile: () => request<DerivedProfileResponse>('/api/profile/derived'),

  // ----- Quotes -----------------------------------------------------------
  /** The stored quotes — what every derived balance is priced from. */
  getQuotes: () => request<QuotesFile>('/api/quotes'),
  /**
   * The one network step in the app. No symbols = every symbol any account
   * holds. Per-symbol failures come back in `results`, never as a batch error.
   */
  refreshQuotes: (symbols?: string[]) =>
    request<QuoteRefreshResult>('/api/quotes/refresh', {
      method: 'POST',
      body: JSON.stringify(symbols === undefined ? {} : { symbols }),
    }),

  // ----- Net worth --------------------------------------------------------
  getNetWorth: () => request<NetWorthSnapshot[]>('/api/networth'),
  /** Server refreshes quotes first, then records the snapshot. */
  takeNetWorthSnapshot: (body: { homeValue: number; note?: string }) =>
    request<NetWorthSnapshot>('/api/networth/snapshot', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  deleteNetWorthSnapshot: (id: string) =>
    request<{ ok: true }>(`/api/networth/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  /**
   * Which rows have a baseline simulation in flight. The snapshot POST returns
   * the moment the row is written, so this is how the page tells "scoring…"
   * from "no score, and none is coming" — two states that look identical on a
   * row and mean opposite things.
   */
  getNetWorthScoring: () => request<{ scoring: string[] }>('/api/networth/scoring'),
  /*
   * THERE IS NO RE-SCORE. A row is scored once, by the run the snapshot POST
   * starts, and a row whose run died stays unmeasured — permanently, and the
   * page says so. The button that used to be here scored TODAY's plan and filed
   * the answer on a row recorded on a different day, which is a number that was
   * never true of that row. The route behind it is gone too.
   */

  getAssumptions: () => request<Assumptions>('/api/assumptions'),
  putMarket: (market: MarketAssumptions) =>
    request<{ ok: true }>('/api/assumptions/market', {
      method: 'PUT',
      body: JSON.stringify(market),
    }),

  /**
   * The one plan. There is no list, no id, and no naming: getPlan seeds it on
   * first read and putPlan is called on every knob turn, which is what makes
   * the app always pick up where it left off.
   */
  getPlan: () => request<Scenario>('/api/plan'),
  putPlan: (plan: Scenario) =>
    request<{ ok: true }>('/api/plan', { method: 'PUT', body: JSON.stringify(plan) }),

  /** Kick off a run; returns immediately with a runId to poll. */
  startRun: (req: RunRequest) =>
    request<{ runId: string }>('/api/run', { method: 'POST', body: JSON.stringify(req) }),
  getRun: (runId: string) => request<RunProgress>(`/api/run/${encodeURIComponent(runId)}`),
  /**
   * The run already computed for these exact inputs, or null. IT STARTS
   * NOTHING — which is the whole difference from startRun, whose cache hit is
   * just as instant but whose MISS spawns the simulation.
   *
   * That difference is why this route exists at all. The Workbench asks it on
   * every load, and asking with startRun would mean a page load that had no
   * cached answer quietly began a 10,000-path run nobody clicked for.
   */
  lookupCachedRun: (req: RunRequest) =>
    request<CachedRunResponse>('/api/run/cached', {
      method: 'POST',
      body: JSON.stringify(req),
    }),

  // ----- The plan's history -----------------------------------------------
  /**
   * Every version of the plan there has been, newest first. Filed by the server
   * on the day's first change — the client never asks for a restore point and
   * cannot forget to.
   */
  planHistory: () => request<PlanHistoryEntry[]>('/api/plan/history'),
  /** File a plan WITHOUT making it the plan — where a search finalist goes. */
  keepPlan: (body: { plan: Scenario; label?: string }) =>
    request<PlanHistoryEntry>('/api/plan/history', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  /** Make a stored version the plan again. The version it replaces is filed. */
  restorePlan: (id: string) =>
    request<PlanRestoreResponse>(`/api/plan/history/${encodeURIComponent(id)}/restore`, {
      method: 'POST',
    }),
  /**
   * Score one stored version. Answers immediately; the number lands later.
   *
   * ONLY A BLANK. A version that already carries a score comes back 409 with a
   * sentence saying why — a recorded number is a record of the day it was
   * measured on, and nothing overwrites one. The History tab draws no button on
   * a scored row, so this is the belt to that pair of braces.
   */
  scorePlanVersion: (id: string) =>
    request<{ ok: true; scoring: boolean }>(
      `/api/plan/history/${encodeURIComponent(id)}/score`,
      { method: 'POST' },
    ),
  /** Which versions have a run in flight right now (memory-only, server-side). */
  planVersionsScoring: () => request<{ scoring: string[] }>('/api/plan/history/scoring'),

  // ----- Search -----------------------------------------------------------
  /**
   * A search runs for minutes, so POST hands back an id and the work continues
   * server-side: closing the tab does not stop it, and re-opening the page
   * re-attaches to it (SearchPage does exactly that).
   */
  startSearch: (req: SearchRequest) =>
    request<{ searchId: string }>('/api/search', { method: 'POST', body: JSON.stringify(req) }),
  getSearch: (searchId: string) =>
    request<SearchProgress>(`/api/search/${encodeURIComponent(searchId)}`),
  getSearchReport: (searchId: string) =>
    request<SearchReport>(`/api/search/${encodeURIComponent(searchId)}/report`),
  cancelSearch: (searchId: string) =>
    request<{ ok: true; stopping: boolean; status?: string }>(
      `/api/search/${encodeURIComponent(searchId)}/cancel`,
      { method: 'POST' },
    ),
  listSearches: () => request<SearchSummary[]>('/api/searches'),
};

/** Poll a run until done/error. Calls onProgress on each tick. */
export async function pollRun(
  runId: string,
  onProgress?: (p: RunProgress) => void,
  intervalMs = 300,
): Promise<RunProgress> {
  for (;;) {
    const p = await api.getRun(runId);
    onProgress?.(p);
    if (p.status === 'done' || p.status === 'error') return p;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

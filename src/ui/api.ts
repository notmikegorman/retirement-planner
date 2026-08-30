/**
 * THE ONE CLIENT — and, since Phase 4 of the browser port, the app's backend
 * SEAM. Every call the UI makes goes through the `api` object below; nothing
 * under src/ui fetches anywhere else. That single point is what makes the
 * whole app swappable between two backends the pages cannot tell apart:
 *
 *   - HTTP (the default): exactly the client this file has always been. The
 *     server (src/server) implements exactly these routes; all responses are
 *     JSON; errors come back as { error: string } with a 4xx/5xx status and
 *     are thrown as Error(message). Nothing about this path changed.
 *   - LOCAL (opt-in): each method calls the in-browser services directly —
 *     the same stores and scorers, composed over the OPFS folder behind the
 *     writer guard (src/ui/local/localBackend.ts). Errors are the same
 *     classes the server maps to statuses, thrown with the same messages, so
 *     a component reading `err.message` sees identical text either way.
 *
 * SELECTION IS EXPLICIT, AT BOOT: `?backend=local` in the URL (remembered in
 * localStorage so in-app navigation and reloads stay in the chosen mode;
 * `?backend=http` clears it), or a build with VITE_FPLAN_BACKEND=local.
 * resolveBackendMode below is the whole rule, in one pure function. Phase 7
 * split the DEFAULT by build: the Pages deploy (build:pages) bakes local;
 * the repo's own builds — npm run dev, npm start, the parked legacy server —
 * stay HTTP, pinned by tests/ui/backendMode.test.ts.
 *
 * The local implementation is a DYNAMIC import: an HTTP-mode session loads
 * not one byte of the engine/stores bundle, and today's served app behaves
 * byte-for-byte as before this seam existed.
 */
import type {
  Assumptions,
  CachedRunResponse,
  DerivedProfileResponse,
  InterruptedScoring,
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
  ScoringTargetKind,
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
  /**
   * Local mode only (decision D7): the runs/ cache is unbounded — exactly
   * what the Node server always did — so its cost is made VISIBLE instead:
   * measured at ask time, shown on the Profile > Settings data card. The
   * HTTP server omits it and the card simply doesn't draw the row.
   */
  runCache?: { files: number; bytes: number };
  /**
   * Local mode only (zero-start): whether the folder holds a profile.json,
   * asked live. `false` is what sends main.tsx's boot to the first-run setup
   * step; the legacy server seeds a profile unconditionally and omits the
   * field, which reads as "present" (undefined !== false).
   */
  profileExists?: boolean;
}

const httpApi = {
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

  // ----- Interrupted scoring ----------------------------------------------
  /**
   * Records whose scoring run was interrupted (a restart, a killed tab) and
   * still verifies completable against today's inputs — the rows the pages
   * draw as Interrupted with a Finish-scoring offer. The backend's boot
   * healer has already stamped-and-retired every intent whose inputs moved.
   */
  getScoringIntents: () => request<{ intents: InterruptedScoring[] }>('/api/scoring/intents'),
  /**
   * Finish one interrupted record (decision D4's one-click button). The
   * backend re-verifies the intent's runKey against today's inputs first:
   * 'identical' completes the SAME measurement as a blank-fill; 'moved'
   * stamps the honest reason instead. Answers immediately, like every
   * scoring start — the row reads "scoring…" through the ordinary polls.
   */
  finishScoring: (body: { kind: ScoringTargetKind; id: string }) =>
    request<{ ok: true; scoring: boolean }>('/api/scoring/finish', {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  // ----- Search -----------------------------------------------------------
  /**
   * A search runs for minutes, so POST hands back an id and the work continues
   * server-side: closing the tab does not stop it, and re-opening the page
   * re-attaches to it (SearchPage does exactly that).
   *
   * HONESTY NOTE, because the two backends genuinely differ here: that
   * closing-the-tab promise is the SERVER's. In local mode the tab is the
   * process — the search runs in a coordinator worker that dies with the tab
   * (decision D5: no checkpointing; a beforeunload warning is the guard), a
   * killed tab loses that search's progress, and on reopen the forgotten
   * bookmark 404s rather than pretending anything survived. A CANCELLED
   * search keeps its partial report in both modes.
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

/**
 * The backend contract IS the HTTP client's surface: the local backend
 * implements exactly this type, so a method added to one without the other
 * fails to compile rather than quietly forking the app.
 */
export type Api = typeof httpApi;

export type BackendMode = 'http' | 'local';

const BACKEND_STORAGE_KEY = 'fplan-backend';

/**
 * Which backend this session boots — the whole rule, pure so it is testable:
 *
 *   1. `?backend=local|http` in the URL wins, and is REMEMBERED: the app's
 *      router rewrites the URL on every navigation (pushState paths carry no
 *      query), so without persistence a reload from /workbench would silently
 *      fall back to HTTP mid-session — the one thing a mode switch must never
 *      do. `?backend=http` both selects and forgets, so it stays the
 *      one-query-parameter escape hatch the dual-boot exists for.
 *   2. Otherwise the remembered choice.
 *   3. Otherwise the build's default (VITE_FPLAN_BACKEND — 'local' in the
 *      shipped Pages build, unset in the repo's own builds), else HTTP.
 */
export function resolveBackendMode(opts: {
  queryBackend: string | null;
  stored: string | null;
  buildDefault: string | undefined;
}): { mode: BackendMode; remember: BackendMode | null } {
  if (opts.queryBackend === 'local') return { mode: 'local', remember: 'local' };
  if (opts.queryBackend === 'http') return { mode: 'http', remember: 'http' };
  if (opts.stored === 'local') return { mode: 'local', remember: null };
  if (opts.buildDefault === 'local') return { mode: 'local', remember: null };
  return { mode: 'http', remember: null };
}

function decideBackendMode(): BackendMode {
  // Importable under node (unit tests import pages that import this module):
  // no browser environment means no choice to make — HTTP, the default.
  if (typeof location === 'undefined') return 'http';
  let stored: string | null = null;
  try {
    stored = localStorage.getItem(BACKEND_STORAGE_KEY);
  } catch {
    stored = null;
  }
  const { mode, remember } = resolveBackendMode({
    queryBackend: new URLSearchParams(location.search).get('backend'),
    stored,
    buildDefault: import.meta.env?.VITE_FPLAN_BACKEND as string | undefined,
  });
  try {
    if (remember === 'local') localStorage.setItem(BACKEND_STORAGE_KEY, 'local');
    else if (remember === 'http') localStorage.removeItem(BACKEND_STORAGE_KEY);
  } catch {
    // Storage disabled: the mode holds for this load; a reload re-reads the URL.
  }
  return mode;
}

/** The mode this session booted in. Decided once; never changes mid-session. */
export const backendMode: BackendMode = decideBackendMode();

/**
 * The seam's capability declaration, read by the Search page (never
 * `backendMode`). Phase 5 of the browser port made search real in local mode
 * — the coordinator worker, the Web Worker pool, the persisted reports — so
 * the declaration no longer varies: flipping this constant was the entire
 * page-side change, exactly as designed. The shape stays declared (rather
 * than deleted) because it is the pattern any future capability gap will use,
 * and because the page's honest-refusal branch should keep compiling against
 * a real type, not a memory.
 */
export const searchAvailability: { available: boolean; reason?: string } = { available: true };

/**
 * The local backend, booted lazily and once: folder opened, writer guard
 * acquired (in its worker), folder seeded/migrated, services composed. Lazy
 * so the guard/boot work runs exactly when the first caller needs it — and a
 * FAILED boot is forgotten, so a "another tab is writing" refusal can be
 * retried after that tab closes without reloading this one.
 */
let localBackendPromise: Promise<Api> | null = null;

function localBackend(): Promise<Api> {
  localBackendPromise ??= import('./local/localBackend')
    .then((m) => m.bootLocalBackend())
    .catch((err: unknown) => {
      localBackendPromise = null;
      throw err;
    });
  return localBackendPromise;
}

/**
 * main.tsx's boot gate awaits this in local mode so a guard refusal renders
 * as a page, not as 27 methods failing one by one. In HTTP mode it is a no-op.
 */
export function ensureBackendReady(): Promise<void> {
  return backendMode === 'local' ? localBackend().then(() => undefined) : Promise.resolve();
}

/**
 * The local facade: every method awaits the booted backend and delegates.
 * Written out one line per method — the compiler holds it to the full Api
 * surface, so a new route cannot be added to the HTTP client and forgotten
 * here.
 */
function localApi(): Api {
  const b = localBackend;
  return {
    meta: () => b().then((x) => x.meta()),
    getProfile: () => b().then((x) => x.getProfile()),
    putProfile: (profile) => b().then((x) => x.putProfile(profile)),
    getDerivedProfile: () => b().then((x) => x.getDerivedProfile()),
    getQuotes: () => b().then((x) => x.getQuotes()),
    refreshQuotes: (symbols) => b().then((x) => x.refreshQuotes(symbols)),
    getNetWorth: () => b().then((x) => x.getNetWorth()),
    takeNetWorthSnapshot: (body) => b().then((x) => x.takeNetWorthSnapshot(body)),
    deleteNetWorthSnapshot: (id) => b().then((x) => x.deleteNetWorthSnapshot(id)),
    getNetWorthScoring: () => b().then((x) => x.getNetWorthScoring()),
    getAssumptions: () => b().then((x) => x.getAssumptions()),
    putMarket: (market) => b().then((x) => x.putMarket(market)),
    getPlan: () => b().then((x) => x.getPlan()),
    putPlan: (plan) => b().then((x) => x.putPlan(plan)),
    startRun: (req) => b().then((x) => x.startRun(req)),
    getRun: (runId) => b().then((x) => x.getRun(runId)),
    lookupCachedRun: (req) => b().then((x) => x.lookupCachedRun(req)),
    planHistory: () => b().then((x) => x.planHistory()),
    keepPlan: (body) => b().then((x) => x.keepPlan(body)),
    restorePlan: (id) => b().then((x) => x.restorePlan(id)),
    scorePlanVersion: (id) => b().then((x) => x.scorePlanVersion(id)),
    planVersionsScoring: () => b().then((x) => x.planVersionsScoring()),
    getScoringIntents: () => b().then((x) => x.getScoringIntents()),
    finishScoring: (body) => b().then((x) => x.finishScoring(body)),
    startSearch: (req) => b().then((x) => x.startSearch(req)),
    getSearch: (searchId) => b().then((x) => x.getSearch(searchId)),
    getSearchReport: (searchId) => b().then((x) => x.getSearchReport(searchId)),
    cancelSearch: (searchId) => b().then((x) => x.cancelSearch(searchId)),
    listSearches: () => b().then((x) => x.listSearches()),
  };
}

/** The client the whole UI calls. Pages import THIS and never choose a mode. */
export const api: Api = backendMode === 'local' ? localApi() : httpApi;

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

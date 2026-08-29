/**
 * THE LOCAL BACKEND: every api.ts method as a direct in-browser call — the
 * same stores, the same services, the same guards as the Fastify server, over
 * the browser drivers instead of HTTP. This module is the browser's
 * server.ts: it does the wiring and the per-"route" glue (validate, compose,
 * fire-and-forget the scorer) and adds no policy of its own — every rule
 * lives in src/store/*, where both backends share it.
 *
 * BOOT ORDER IS THE CONTRACT. The writer guard is acquired BEFORE any store
 * touches the folder — the same position acquireDataDirLock holds in
 * server.ts, and for the same reason: initDataDir is not merely a read (it
 * backfills assumption files and runs the giving-split pass, raw and outside
 * every write chain), and a second writer starting under a live one would do
 * that to files being written. A guard refusal rejects the boot with the
 * guard's own message; main.tsx renders it instead of the app.
 *
 * THE FOLDER is OPFS (navigator.storage.getDirectory()) in this phase — real
 * FileSystemDirectoryHandle storage, zero prompts, private to the origin. The
 * picked real folder arrives with Phase 7's PWA work; nothing here may care
 * which one it is handed (the driver's own rule, fsaFileStore.ts).
 *
 * QUOTES HAVE NO NETWORK YET, honestly. The one network step in the app needs
 * the Phase-6 CORS proxy — browsers cannot call Yahoo's endpoint (no CORS
 * header, mandatory User-Agent) — so until it ships, the default fetcher
 * fails EVERY symbol with a message naming the proxy as the missing piece.
 * Per-symbol failure is data, not a thrown refresh (the store's own rule), so
 * a refresh "succeeds" with every symbol reporting why it could not, stored
 * quotes keep working with their honest asOf, and runs still refuse on
 * missing quotes. Tests (and Phase 6) inject a working fetcher through
 * `globalThis.__fplanLocalOptions` — the injection seam the quote service has
 * always had, reachable from outside the bundle.
 */
import type { z } from 'zod';
import type {
  Assumptions,
  MarketAssumptions,
  NetWorthSnapshot,
  Profile,
  QuoteRefreshResult,
  Scenario,
  SearchRequest,
} from '../../shared/types';
import { ENGINE_VERSION } from '../../shared/types';
import {
  netWorthSnapshotWriteSchema,
  parseOrThrow,
  planKeepSchema,
  profileSchema,
  quotesRefreshRequestSchema,
  scenarioSchema,
  searchRequestSchema,
} from '../../shared/schemas';
import { holdingsSymbols } from '../../shared/holdings';
import { createStores, type Stores } from '../../store';
import { NotFoundError, ValidationError } from '../../store/dataStore';
import type { FetchLike } from '../../store/quotes';
import { defaultRefreshSymbols } from '../../store/quotes';
import { createServices, type Services } from '../../store/services';
import { createScoreStore } from '../../store/search/scoreStore';
import { createSearchManager } from '../../store/searchManager';
import { randomHex } from '../../shared/random';
import { createFsaFileStore } from '../io/fsaFileStore';
import type { Api } from '../api';
import { bundledDefaults } from './bundledDefaults';
import { createBrowserRunExecutor } from './browserRunExecutor';
import { createBrowserSearchRunner } from './searchClient';
import { acquireGuardInWorker } from './guardClient';

/** The OPFS directory the local backend keeps the data folder in. */
const OPFS_FOLDER = 'fplan-data';

/** Web-Lock scope: one folder, one writer, per browser profile. */
const FOLDER_ID = `opfs:${OPFS_FOLDER}`;

const CLIENT_ID_KEY = 'fplan-writer-client-id';

/**
 * Options injectable from OUTSIDE the bundle, read once at boot. The one
 * consumer today is the dual-stack gate (and, later, Phase 6's proxy work),
 * which injects a deterministic quote fetcher; nothing else looks here.
 */
export interface LocalBackendOptions {
  quoteFetcher?: FetchLike;
}

/** Thrown when the writer guard refuses the folder; main.tsx renders it. */
export class LocalBootRefusedError extends Error {
  constructor(
    public readonly reason: 'tab' | 'held' | 'sync-conflict',
    message: string,
  ) {
    super(message);
  }
}

/**
 * This installation's stable writer identity — the browser's stand-in for
 * pid+hostname, minted once and kept in localStorage so a reload re-adopts
 * its own lease instead of reading it as a foreign writer's.
 */
function writerIdentity(): { clientId: string; label: string } {
  let clientId: string | null = null;
  try {
    clientId = localStorage.getItem(CLIENT_ID_KEY);
    if (clientId === null) {
      clientId = `web-${randomHex(8)}`;
      localStorage.setItem(CLIENT_ID_KEY, clientId);
    }
  } catch {
    clientId = `web-${randomHex(8)}`; // storage disabled: identity lasts the tab
  }
  return { clientId, label: 'Finance Planner (browser tab)' };
}

/** The one network step's stand-in until Phase 6 — see the module header. */
const proxyMissingFetcher: FetchLike = async () => {
  throw new Error(
    'quote refresh needs the quote proxy, which is not deployed yet — a browser page ' +
      'cannot reach Yahoo directly (no CORS header, and the User-Agent Yahoo requires ' +
      'cannot be set from a page). Stored quotes keep working with their recorded asOf.',
  );
};

/**
 * Boot the local backend: folder → guard → seed/migrate → compose. Called
 * once per tab by api.ts (lazily, behind a dynamic import) and memoized
 * there; a thrown LocalBootRefusedError carries the guard's message.
 */
export async function bootLocalBackend(): Promise<Api> {
  const options: LocalBackendOptions =
    ((globalThis as Record<string, unknown>).__fplanLocalOptions as
      | LocalBackendOptions
      | undefined) ?? {};

  const opfs = await navigator.storage.getDirectory();
  const handle = await opfs.getDirectoryHandle(OPFS_FOLDER, { create: true });

  // The guard FIRST — before initDataDir can touch a byte. The heartbeat (and
  // the Web Lock) live in a dedicated worker so a backgrounded tab's throttled
  // timers cannot let the lease go stale under a live writer.
  const acquisition = await acquireGuardInWorker({
    handle,
    folderId: FOLDER_ID,
    self: writerIdentity(),
    onLog: (message) => console.log(`[writer guard] ${message}`),
    onLeaseLost: () =>
      console.warn(
        '[writer guard] the folder lease was lost to another writer — this tab was ' +
          'presumably frozen past its own staleness window. Treat the folder as contested.',
      ),
  });
  if (!acquisition.ok) throw new LocalBootRefusedError(acquisition.reason, acquisition.message);

  const files = createFsaFileStore(handle, '(browser data folder)');
  const stores: Stores = createStores({ files, defaults: await bundledDefaults() });
  const init = await stores.data.initDataDir();
  const services: Services = createServices(stores, createBrowserRunExecutor());

  /**
   * SEARCH, live in local mode since Phase 5: the neutral manager over this
   * folder's stores, its runner the coordinator-worker client. The IO trio
   * handed to the runner is built HERE, from THIS composed store set — the
   * coordinator's every folder touch comes back through these three calls, on
   * this guarded context, which is what keeps the search inside the
   * single-writer discipline (see searchClient.ts / searchWorker.ts).
   */
  const scoreStore = createScoreStore(stores.data.files);
  const searchManager = createSearchManager({
    data: stores.data,
    runner: createBrowserSearchRunner({
      readScore: scoreStore.readScore,
      writeScore: scoreStore.writeScore,
      readCachedResult: (runKey) => services.runManager.readCachedResult(runKey),
    }),
  });

  const quoteFetcher = options.quoteFetcher ?? proxyMissingFetcher;

  /** parseOrThrow, rethrown as ValidationError — server.ts's validateBody. */
  function validateBody<T>(schema: z.ZodType<T>, body: unknown, label: string): T {
    try {
      return parseOrThrow(schema, body, label);
    } catch (err) {
      throw new ValidationError((err as Error).message);
    }
  }

  async function refreshQuotes(symbols?: string[]): Promise<QuoteRefreshResult> {
    const body = validateBody(
      quotesRefreshRequestSchema,
      symbols === undefined ? {} : { symbols },
      'quotes refresh',
    );
    const batch =
      body.symbols ?? defaultRefreshSymbols((await stores.data.loadResolvedProfile()).profile);
    return stores.quotes.refreshQuotes(batch, { fetchImpl: quoteFetcher });
  }

  return {
    // ----- Meta -------------------------------------------------------------
    meta: async () => ({
      dataDir: init.dataDir,
      engineVersion: ENGINE_VERSION,
      dataDirInitialized: init.existedBefore,
    }),

    // ----- Profile ----------------------------------------------------------
    getProfile: async () => (await stores.data.loadResolvedProfile()).profile,
    putProfile: async (profile: Profile) => {
      await stores.data.saveProfile(validateBody(profileSchema, profile, 'profile'));
      return { ok: true as const };
    },
    getDerivedProfile: async () => {
      const { derived, missing } = await stores.data.loadResolvedProfile();
      return { accounts: derived, missing };
    },

    // ----- Quotes -----------------------------------------------------------
    getQuotes: () => stores.data.loadQuotes(),
    refreshQuotes,

    // ----- Net worth --------------------------------------------------------
    getNetWorth: () => stores.networth.listSnapshots(),
    /**
     * The same choreography as POST /api/networth/snapshot: refresh prices
     * for every holdings symbol FIRST (a snapshot must record today's prices,
     * not August's), write the row, and start scoring WITHOUT awaiting it —
     * the row answers now, the score lands when the simulation does. In this
     * environment "fire and forget" lives exactly as long as the tab; a
     * killed tab leaves a scoreless row, re-scorable only where the rules
     * have always allowed (never — a snapshot is scored once, at formation).
     * The write-ahead intent file that lets a reopened tab resolve the
     * interruption is Phase 6, deliberately not here.
     */
    takeNetWorthSnapshot: async (body: { homeValue: number; note?: string }) => {
      const write = validateBody(netWorthSnapshotWriteSchema, body, 'net worth snapshot');
      const symbols = holdingsSymbols((await stores.data.loadResolvedProfile()).profile);
      if (symbols.length > 0) await refreshQuotes(symbols);
      const snapshot: NetWorthSnapshot = await stores.networth.takeSnapshot(write);
      void services.snapshotScorer.startScoring(snapshot.id);
      return snapshot;
    },
    deleteNetWorthSnapshot: async (id: string) => {
      await stores.networth.deleteSnapshot(id);
      return { ok: true as const };
    },
    getNetWorthScoring: async () => ({
      scoring: services.snapshotScorer.snapshotsBeingScored(),
    }),

    // ----- Assumptions ------------------------------------------------------
    getAssumptions: (): Promise<Assumptions> => stores.data.loadAssumptions(),
    putMarket: async (market: MarketAssumptions) => {
      await stores.data.saveMarket(market);
      return { ok: true as const };
    },

    // ----- Plan -------------------------------------------------------------
    getPlan: () => stores.plan.loadPlan(),
    putPlan: async (plan: Scenario) => {
      await stores.plan.savePlan(validateBody(scenarioSchema, plan, 'plan'));
      return { ok: true as const };
    },

    // ----- Runs -------------------------------------------------------------
    startRun: (req) => services.runManager.startRun(req),
    getRun: async (runId: string) => {
      const progress = await services.runManager.getRun(runId);
      if (!progress) throw new NotFoundError(`Unknown run "${runId}"`);
      return progress;
    },
    lookupCachedRun: async (req) => ({ result: await services.runManager.lookupCachedRun(req) }),

    // ----- The plan's history -----------------------------------------------
    planHistory: () => stores.planHistory.listPlanHistory(),
    keepPlan: async (body: { plan: Scenario; label?: string }) => {
      const keep = validateBody(planKeepSchema, body, 'plan to keep');
      return stores.planHistory.keepPlan(keep.plan, keep.label);
    },
    restorePlan: async (id: string) => {
      const { plan, restoredFrom } = await stores.plan.restorePlan(id);
      return { ok: true as const, plan, restoredFrom };
    },
    scorePlanVersion: (id: string) => services.planHistoryScorer.scorePlanVersion(id),
    planVersionsScoring: async () => ({
      scoring: services.planHistoryScorer.versionsBeingScored(),
    }),

    // ----- Search -----------------------------------------------------------
    // The same per-"route" glue as the server's search routes: validate the
    // request, translate a null progress into the route's NotFound sentence,
    // and let a cancel of something already finished say so without erroring.
    startSearch: async (req: SearchRequest) =>
      searchManager.startSearch(
        validateBody(
          searchRequestSchema as unknown as z.ZodType<SearchRequest>,
          req,
          'search request',
        ),
      ),
    getSearch: async (searchId: string) => {
      const progress = await searchManager.getSearch(searchId);
      if (!progress) throw new NotFoundError(`Unknown search "${searchId}"`);
      return progress;
    },
    getSearchReport: (searchId: string) => searchManager.getSearchReport(searchId),
    cancelSearch: async (searchId: string) => {
      const stopping = searchManager.cancelSearch(searchId);
      if (!stopping) {
        // Already finished, already failed, or never existed. Not an error:
        // the owner pressed stop and the search is not running, which is what
        // they wanted either way.
        const progress = await searchManager.getSearch(searchId);
        if (!progress) throw new NotFoundError(`Unknown search "${searchId}"`);
        return { ok: true as const, stopping: false, status: progress.status };
      }
      return { ok: true as const, stopping: true };
    },
    listSearches: () => searchManager.listSearches(),
  };
}

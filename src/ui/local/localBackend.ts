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
 * THE FOLDER comes from the boot gate (Phase 7, storageChoice.ts): either
 * the PICKED real folder (showDirectoryPicker — since the 2026-08-29
 * chooser cut, the only visible answer on a picker browser) or the OPFS
 * folder (browser-private storage — the D8 demo fallback, any choice
 * remembered from before the cut, and what every automated test drives,
 * since a picker cannot be scripted headlessly). Nothing here may care
 * which one it was handed (the driver's own rule, fsaFileStore.ts).
 *
 * QUOTES GO THROUGH THE PHASE-6 PROXY, once one is configured. Browsers
 * cannot call Yahoo's endpoint directly (no CORS header, mandatory
 * User-Agent), so the one network step routes through the ~15-line Cloudflare
 * Worker in workers/quote-proxy via proxyQuoteFetcher.ts — which also owns
 * where the proxy URL comes from (VITE_FPLAN_QUOTE_PROXY at build time, the
 * localStorage override for deploy-then-point without a rebuild). Until a URL
 * is configured, the default fetcher fails EVERY symbol with a message naming
 * exactly what to deploy and where the instructions live. Per-symbol failure
 * is data, not a thrown refresh (the store's own rule), so a refresh
 * "succeeds" with every symbol reporting why it could not, stored quotes keep
 * working with their honest asOf, and runs still refuse on missing quotes.
 * Tests inject their own fetcher through `globalThis.__fplanLocalOptions` —
 * the injection seam the quote service has always had, reachable from outside
 * the bundle.
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
  finishScoringRequestSchema,
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
import { sweepSwapArtifacts } from '../io/swapArtifacts';
import { resolveStorageForBoot, supportsFolderPicker } from './storageChoice';
import type { Api } from '../api';
import { bundledDefaults } from './bundledDefaults';
import { createBrowserRunExecutor } from './browserRunExecutor';
import { createBrowserSearchRunner } from './searchClient';
import { acquireGuardInWorker } from './guardClient';
import {
  QUOTE_PROXY_STORAGE_KEY,
  createProxyQuoteFetcher,
  resolveQuoteProxyUrl,
} from './proxyQuoteFetcher';
import { setScoringInFlight } from './scoringGuard';

const CLIENT_ID_KEY = 'fplan-writer-client-id';

/**
 * Options injectable from OUTSIDE the bundle, read once at boot. The one
 * consumer today is the dual-stack gate (and, later, Phase 6's proxy work),
 * which injects a deterministic quote fetcher; nothing else looks here.
 */
export interface LocalBackendOptions {
  quoteFetcher?: FetchLike;
}

/**
 * Thrown when the writer guard refuses the folder; main.tsx renders it.
 * Recognised there BY NAME (never instanceof), because main.tsx must not
 * statically import this lazily-loaded chunk just to identify an error.
 */
export class LocalBootRefusedError extends Error {
  override readonly name = 'LocalBootRefusedError';
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

/** The stand-in while no proxy URL is configured — see the module header. */
const proxyMissingFetcher: FetchLike = async () => {
  throw new Error(
    'quote refresh needs the quote proxy, and no proxy URL is configured — a browser page ' +
      'cannot reach Yahoo directly (no CORS header, and the User-Agent Yahoo requires ' +
      'cannot be set from a page). Deploy the Worker in workers/quote-proxy (one command: ' +
      'npx wrangler deploy) and point this app at the printed URL — ' +
      'workers/quote-proxy/README.md has both steps. Stored quotes keep working with their ' +
      'recorded asOf.',
  );
};

/**
 * The production quote fetcher: the proxy client when a URL is configured
 * (build-time VITE var or the localStorage override — proxyQuoteFetcher.ts
 * owns the rule and its safety argument), the honest refusal otherwise.
 */
function configuredQuoteFetcher(): FetchLike {
  let stored: string | null = null;
  try {
    stored = localStorage.getItem(QUOTE_PROXY_STORAGE_KEY);
  } catch {
    stored = null; // storage disabled: the build-time default still applies
  }
  const { url, rejected } = resolveQuoteProxyUrl({
    stored,
    buildDefault: import.meta.env?.VITE_FPLAN_QUOTE_PROXY as string | undefined,
  });
  if (rejected !== null) {
    console.warn(
      `[quotes] ignoring a quote-proxy URL that is not https (or http on localhost): ` +
        `"${rejected}" — the proxy sees every symbol the portfolio holds, so only a ` +
        `trustworthy scheme may receive it.`,
    );
  }
  return url === null ? proxyMissingFetcher : createProxyQuoteFetcher(url);
}

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

  // Which storage — the boot gate's approved answer (Phase 7): the picked
  // real folder, or the OPFS folder the automated lane and the demo fallback
  // drive. Everything below is identical either way — the driver's own rule.
  const storage = await resolveStorageForBoot();
  const handle = storage.handle;

  // The guard FIRST — before initDataDir can touch a byte. The heartbeat (and
  // the Web Lock) live in a dedicated worker so a backgrounded tab's throttled
  // timers cannot let the lease go stale under a live writer.
  const acquisition = await acquireGuardInWorker({
    handle,
    folderId: storage.folderId,
    self: writerIdentity(),
    onLog: (message) => console.log(`[writer guard] ${message}`),
    onLeaseLost: () =>
      console.warn(
        '[writer guard] the folder lease was lost to another writer — this tab was ' +
          'presumably frozen past its own staleness window. Treat the folder as contested.',
      ),
  });
  if (!acquisition.ok) throw new LocalBootRefusedError(acquisition.reason, acquisition.message);

  // Orphaned `.crswap` staging files sweep NOW — guard held (so nothing can
  // be mid-write), stores not yet reading (so nothing has listed the debris).
  // swapArtifacts.ts carries the whole policy.
  const sweptSwapFiles = await sweepSwapArtifacts(handle);
  if (sweptSwapFiles.length > 0) {
    console.log(
      `[storage] swept ${sweptSwapFiles.length} orphaned .crswap staging file(s) ` +
        `left by an interrupted write: ${sweptSwapFiles.join(', ')}`,
    );
  }

  const files = createFsaFileStore(handle, storage.label);
  const stores: Stores = createStores({ files, defaults: await bundledDefaults() });
  /*
   * ZERO-START: only the D8 demo fallback still seeds the fictional starter
   * household — its purpose is a filled example. Every other boot (the picked
   * folder; OPFS reached through the lane seam or a pre-cut choice) leaves an
   * empty folder profile-less, and main.tsx renders the setup step
   * (profileSetupNeeded in storageChoice.ts) before the app. `demo` is the
   * same fact resolveBootGate computes: OPFS on a browser with no picker.
   */
  const demo = storage.kind === 'opfs' && !supportsFolderPicker();
  const init = await stores.data.initDataDir({ seedStarterProfile: demo });
  const services: Services = createServices(stores, createBrowserRunExecutor(), {
    // The beforeunload warning, armed exactly while any scoring is in flight
    // (scoringGuard.ts — the same discipline as the search guard).
    onScoringInFlightChange: setScoringInFlight,
  });

  // Orphaned write-ahead scoring intents resolve BEFORE the first call can
  // answer — the same position the server's boot gives this, for the same
  // reason: no page may read a row whose fate is still being decided
  // (store/scoringIntent.ts; the Aug-20 loss is the incident this closes).
  await services.scoringIntents.heal();

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

  const quoteFetcher = options.quoteFetcher ?? configuredQuoteFetcher();

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

  /**
   * Decision D7, made visible: the runs/ cache stays UNBOUNDED (exactly what
   * the Node server did — picked-folder writes are quota-exempt real disk),
   * and in exchange its size is measured at every meta() ask and shown on
   * the Dashboard. Measured straight off the handle (getFile().size — no
   * bytes read) rather than through the FileStore seam, which deliberately
   * has no stat call: this is a metric about the folder, not a record read.
   */
  async function measureRunCache(): Promise<{ files: number; bytes: number }> {
    try {
      const runsDir = await handle.getDirectoryHandle('runs');
      let files = 0;
      let bytes = 0;
      for await (const entry of runsDir.values()) {
        if (entry.kind !== 'file') continue;
        files += 1;
        bytes += (await (entry as FileSystemFileHandle).getFile()).size;
      }
      return { files, bytes };
    } catch {
      return { files: 0, bytes: 0 }; // no runs/ yet: an honest zero
    }
  }

  return {
    // ----- Meta -------------------------------------------------------------
    meta: async () => ({
      dataDir: init.dataDir,
      engineVersion: ENGINE_VERSION,
      dataDirInitialized: init.existedBefore,
      runCache: await measureRunCache(),
      // Asked LIVE, not snapshotted at boot: the setup step's submit writes
      // the profile through putProfile, and the very next meta() must say so
      // or the boot flow would loop on a stale answer. Local mode only — the
      // legacy server seeds a profile unconditionally, so its absence there
      // is unrepresentable and the field stays optional (like runCache).
      profileExists: await stores.data.pathExists('profile.json'),
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
     * environment "fire and forget" lives exactly as long as the tab — which
     * is why the scorer records a write-ahead intent before each run (Phase
     * 6, store/scoringIntent.ts): a killed tab leaves a row the reopened tab
     * resolves explicitly — Interrupted with a Finish-scoring offer while
     * today's inputs still produce the same run, honestly-unmeasured with
     * the reason once they don't. Never a silent permanent blank.
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

    // ----- Interrupted scoring ----------------------------------------------
    // The same two "routes" the server registers, over the same shared
    // service — the boot healer above has already retired everything that is
    // not honestly finishable or still undecided.
    getScoringIntents: async () => ({ intents: await services.scoringIntents.list() }),
    finishScoring: async (body: { kind: 'snapshot' | 'plan-version'; id: string }) =>
      services.scoringIntents.finish(
        validateBody(finishScoringRequestSchema, body, 'finish scoring'),
      ),

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

/**
 * Local HTTP server (SPEC §2): file IO on the data folder + simulation runs.
 * Implements exactly the routes in src/ui/api.ts and serves the built UI from
 * <repoRoot>/dist/ui when present.
 *
 * Entry point: `npm start` / `npm run dev` -> tsx src/server/server.ts
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import type { z } from 'zod';
import { ENGINE_VERSION } from '../shared/types';
import type { MarketAssumptions, RunRequest, SearchRequest } from '../shared/types';
import {
  finishScoringRequestSchema,
  netWorthSnapshotWriteSchema,
  parseOrThrow,
  planKeepSchema,
  profileSchema,
  quotesRefreshRequestSchema,
  scenarioSchema,
  searchRequestSchema,
} from '../shared/schemas';
import { holdingsSymbols } from '../shared/holdings';
import {
  ConflictError,
  NotFoundError,
  ValidationError,
  getDataDir,
  initDataDir,
  loadAssumptions,
  loadQuotes,
  loadResolvedProfile,
  saveMarket,
  saveProfile,
} from './dataStore';
import { loadPlan, restorePlan, savePlan } from './planStore';
import { keepPlan, listPlanHistory } from './planHistoryStore';
import { defaultRefreshSymbols, refreshQuotes } from './quotes';
import { deleteSnapshot, listSnapshots, takeSnapshot } from './networthStore';
import { snapshotsBeingScored, startScoring } from './snapshotScorer';
import { scorePlanVersion, versionsBeingScored } from './planHistoryScorer';
import { finishScoring, healScoringIntents, listScoringIntents } from './scoringIntents';
import { getRun, lookupCachedRun, startRun } from './runManager';
import { cancelSearch, getSearch, getSearchReport, listSearches, startSearch } from './searchManager';
import {
  ListenConfigError,
  displayHost,
  exposureWarning,
  resolveHost,
  resolvePort,
} from './listenConfig';
import { DataDirLockedError, acquireDataDirLock } from './singleWriter';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));

/** Validate a request body against a zod schema; failures map to HTTP 400. */
function validateBody<T>(schema: z.ZodType<T>, body: unknown, label: string): T {
  try {
    return parseOrThrow(schema, body, label);
  } catch (err) {
    throw new ValidationError((err as Error).message);
  }
}

/**
 * Whether to auto-open a browser tab on boot.
 *
 * Opening on EVERY start is wrong under `npm run dev` (`tsx watch`), which
 * restarts the server on every source-file change — an editing session then
 * buries you in tabs, each one stealing focus. Two guards:
 *   1. FPLAN_NO_OPEN=1 disables it outright (the dev script sets this).
 *   2. A timestamp marker in the data folder suppresses a re-open within
 *      REOPEN_COOLDOWN_MS, so any rapid restart loop opens at most one tab
 *      regardless of how the server was launched.
 * Closing the tab and restarting after the cooldown still opens a fresh one.
 */
const REOPEN_COOLDOWN_MS = 5 * 60 * 1000;

function shouldOpenBrowser(dataDir: string, port: number): boolean {
  if (process.env.FPLAN_NO_OPEN) return false;
  const marker = path.join(dataDir, '.last-browser-open');
  const now = Date.now();
  try {
    const prev = JSON.parse(readFileSync(marker, 'utf8')) as { at?: number; port?: number };
    if (prev.port === port && typeof prev.at === 'number' && now - prev.at < REOPEN_COOLDOWN_MS) {
      return false;
    }
  } catch {
    // No marker (or unreadable) -> this is a fresh start; fall through and open.
  }
  try {
    writeFileSync(marker, JSON.stringify({ at: now, port }));
  } catch {
    // Best-effort: an unwritable marker must not stop the server booting.
  }
  return true;
}

function openBrowser(url: string): void {
  const platform = process.platform;
  const cmd = platform === 'darwin' ? 'open' : platform === 'win32' ? 'start' : 'xdg-open';
  try {
    // 'start' is a cmd.exe builtin, hence shell on win32. Errors are ignored:
    // opening a browser is best-effort convenience only.
    const child = spawn(cmd, [url], {
      detached: true,
      stdio: 'ignore',
      shell: platform === 'win32',
    });
    child.on('error', () => {});
    child.unref();
  } catch {
    // ignore
  }
}

async function main(): Promise<void> {
  // Resolved FIRST, before anything writes: an unusable FPLAN_PORT should stop
  // the boot while the folder is still untouched, not after a migration has run
  // against it on a port nobody asked for. See listenConfig.ts.
  const port = resolvePort(process.env.FPLAN_PORT);
  const host = resolveHost(process.env.FPLAN_HOST);

  // AND BEFORE initDataDir(), which is not merely a read: it backfills the
  // assumption files and runs migrateGivingSplitFiles(), which rewrites
  // plan.json raw and outside every in-process write chain. A second server
  // starting under a live one would do that to a file being written. The whole
  // argument, and what the existing serializers do and do not cover, is in
  // singleWriter.ts.
  await acquireDataDirLock({
    dataDir: getDataDir(),
    port,
    appDir: repoRoot,
    onStaleLock: (owner) => {
      console.log(
        `Cleared a lock left by pid ${owner?.pid ?? '?'}, which is no longer running.`,
      );
    },
  });

  const init = await initDataDir();

  // Orphaned write-ahead scoring intents resolve BEFORE the first route can
  // answer: a page must never read a row whose fate is still being decided.
  // Clearly-moved intents stamp their honest reason; completable ones stay,
  // and the pages offer Finish scoring (store/scoringIntent.ts — the Aug-20
  // restart-mid-solve loss is the incident this closes).
  await healScoringIntents();

  const app = Fastify({ logger: false });

  app.setErrorHandler((err: unknown, _req, reply) => {
    if (err instanceof NotFoundError) {
      return reply.status(404).send({ error: err.message });
    }
    if (err instanceof ValidationError) {
      return reply.status(400).send({ error: err.message });
    }
    // 409: the request is fine and the record refuses it. The one case today
    // is scoring a version that already carries a score — see planHistoryScorer
    // for why refusing beats overwriting, and why it beats silence.
    if (err instanceof ConflictError) {
      return reply.status(409).send({ error: err.message });
    }
    // Fastify's own 4xx errors (e.g. malformed JSON body -> 400).
    const e = err as { statusCode?: number; message?: string; stack?: string };
    if (typeof e.statusCode === 'number' && e.statusCode >= 400 && e.statusCode < 500) {
      return reply.status(e.statusCode).send({ error: e.message ?? 'Bad request' });
    }
    console.error(e.stack ?? err);
    return reply.status(500).send({ error: e.message || 'Internal server error' });
  });

  // ----- Meta -------------------------------------------------------------
  app.get('/api/meta', async () => ({
    dataDir: init.dataDir,
    engineVersion: ENGINE_VERSION,
    dataDirInitialized: init.existedBefore,
  }));

  // ----- Profile ----------------------------------------------------------
  // The RESOLVED profile: holdings-mode accounts carry balances/allocations
  // derived from stored quotes, so every reader of this route — the editor,
  // the dashboard, the workbench's client-side input hash — sees the same
  // numbers a run would use. Accounts whose symbols have no stored quote keep
  // their last-resolved figures (the editor must render before the first
  // refresh); only the RUN routes treat that as fatal.
  app.get('/api/profile', async () => (await loadResolvedProfile()).profile);

  // The derived detail behind those numbers: per-account holdings views with
  // each price and its asOf moment, so the UI can label every figure with its
  // condition ("$318.62 as of Mar 14, 4:00 PM ET — delayed") instead of
  // presenting a stored price as a live one.
  app.get('/api/profile/derived', async () => {
    const { derived, missing } = await loadResolvedProfile();
    return { accounts: derived, missing };
  });

  app.put('/api/profile', async (req) => {
    const profile = validateBody(profileSchema, req.body, 'profile');
    await saveProfile(profile);
    return { ok: true as const };
  });

  // ----- Quotes -----------------------------------------------------------
  // The ONLY network step in the app. Stored quotes feed everything else; a
  // run never fetches (see quotes.ts). Per-symbol failures come back as data
  // in `results`, never as a batch error — one delisted ticker must not stop
  // the other nine prices from landing.
  app.get('/api/quotes', async () => loadQuotes());

  app.post('/api/quotes/refresh', async (req) => {
    const body = validateBody(quotesRefreshRequestSchema, req.body ?? {}, 'quotes refresh');
    const symbols = body.symbols ?? defaultRefreshSymbols((await loadResolvedProfile()).profile);
    return refreshQuotes(symbols);
  });

  // ----- Net worth --------------------------------------------------------
  // Append-only snapshots. The POST refreshes quotes for every holdings
  // symbol FIRST (a snapshot must record today's prices, not August's), then
  // prices the accounts through the same resolver runs use. A refresh failure
  // for a symbol is survivable when an older quote exists — the snapshot's
  // per-symbol asOf tells the truth about what it knew — but a symbol with no
  // quote at all fails the snapshot with the fix named.
  app.get('/api/networth', async () => listSnapshots());

  /*
   * The row is written and returned IMMEDIATELY; the plan's score is attached
   * later, by a simulation this route does not wait for.
   *
   * 10,000 paths is minutes of work, and the two halves of a snapshot are not
   * equally recoverable: the balances and prices record a market moment that
   * has passed, while a score can be recomputed at any time. Blocking the
   * response on the run would risk the irreplaceable half for the sake of the
   * repeatable one — a timeout, a closed browser or a crashed worker would
   * take the whole snapshot with it. So `startScoring` is deliberately not
   * awaited, and a row whose run never lands stays a perfectly good net-worth
   * record that reads as unmeasured.
   *
   * THIS IS THE ONLY PLACE A ROW IS EVER SCORED. There was a POST
   * /api/networth/:id/score behind a per-row button, and it scored TODAY's plan
   * and filed the answer on a row recorded on a different day — a number that
   * was never true of that row. This run is the record being FORMED, which is
   * the whole difference.
   */
  app.post('/api/networth/snapshot', async (req) => {
    const body = validateBody(netWorthSnapshotWriteSchema, req.body, 'net worth snapshot');
    const symbols = holdingsSymbols((await loadResolvedProfile()).profile);
    if (symbols.length > 0) await refreshQuotes(symbols);
    const snapshot = await takeSnapshot(body);
    void startScoring(snapshot.id);
    return snapshot;
  });

  // Which rows have a simulation in flight, so the page can show "scoring…"
  // on those and nothing on the rest. Memory-only and therefore empty after a
  // restart — which is the truth: no run survived it.
  app.get('/api/networth/scoring', async () => ({ scoring: snapshotsBeingScored() }));

  app.delete<{ Params: { id: string } }>('/api/networth/:id', async (req) => {
    await deleteSnapshot(req.params.id);
    return { ok: true as const };
  });

  // ----- Assumptions ------------------------------------------------------
  app.get('/api/assumptions', async () => loadAssumptions());

  app.put('/api/assumptions/market', async (req) => {
    // saveMarket performs the structural (required-keys) validation.
    await saveMarket(req.body as MarketAssumptions);
    return { ok: true as const };
  });

  // ----- Plan -------------------------------------------------------------
  // One plan, no library: GET seeds it on first read, PUT overwrites it. The
  // UI calls PUT on every knob turn, which is what makes "always pick up where
  // I left off" true without a save button.
  //
  // The PUT is also where the plan's history is kept honest: savePlan files the
  // version it replaces when the day has no restore point yet. That guard is
  // deliberately behind the route rather than in front of it — a client that
  // could forget to ask for a restore point would eventually forget.
  app.get('/api/plan', async () => loadPlan());

  app.put('/api/plan', async (req) => {
    const plan = validateBody(scenarioSchema, req.body, 'plan');
    await savePlan(plan);
    return { ok: true as const };
  });

  // ----- The plan's history -----------------------------------------------
  // Every version of the plan there has been, newest first. Restoring copies an
  // entry forward onto plan.json and files what it replaced, so it is itself
  // undoable and no entry is ever consumed or rewritten.
  app.get('/api/plan/history', async () => listPlanHistory());

  // File a plan WITHOUT making it the plan — where a search finalist goes when
  // it is worth remembering but the workbench is staying where it is.
  app.post('/api/plan/history', async (req) => {
    const body = validateBody(planKeepSchema, req.body, 'plan to keep');
    return keepPlan(body.plan, body.label);
  });

  app.post<{ Params: { id: string } }>('/api/plan/history/:id/restore', async (req) => {
    const { plan, restoredFrom } = await restorePlan(req.params.id);
    return { ok: true as const, plan, restoredFrom };
  });

  // Score one stored version on demand — the History tab is meant to be
  // recognised from, and a list of dates with no numbers is not recognisable.
  // Like a snapshot's score this answers in the background; the row fills in.
  //
  // ONCE PER VERSION. A version that already carries a score is refused with a
  // 409 and a sentence saying so; only a blank — never scored, or scored and
  // failed — can be written into. The History tab draws no button on a scored
  // row, and this is what makes that true rather than merely drawn.
  app.post<{ Params: { id: string } }>('/api/plan/history/:id/score', async (req) =>
    scorePlanVersion(req.params.id),
  );

  // Memory-only, and therefore empty after a restart — which is the truth: no
  // run survived it.
  app.get('/api/plan/history/scoring', async () => ({ scoring: versionsBeingScored() }));

  // ----- Interrupted scoring ----------------------------------------------
  // The records whose scoring run was interrupted (a restart, a killed tab)
  // and still verifies completable against today's inputs. The boot healer
  // above has already retired every intent that was satisfied or whose
  // inputs moved, so what this lists is exactly the rows the pages should
  // draw as Interrupted with a Finish-scoring offer.
  app.get('/api/scoring/intents', async () => ({ intents: await listScoringIntents() }));

  // Finish one interrupted record. The backend re-verifies the intent's
  // runKey against today's inputs before a single path runs: 'identical'
  // completes the SAME measurement (a blank-fill under the scored-once
  // rules), 'moved' stamps the honest reason instead. Answers immediately;
  // the row reads "scoring…" through the same registries as a forming run.
  app.post('/api/scoring/finish', async (req) =>
    finishScoring(validateBody(finishScoringRequestSchema, req.body, 'finish scoring')),
  );

  // ----- Runs -------------------------------------------------------------
  app.post('/api/run', async (req) => {
    const { runId } = await startRun(req.body as RunRequest);
    return { runId };
  });

  /*
   * ASK WHETHER THIS RUN ALREADY EXISTS, WITHOUT STARTING IT.
   *
   * The Workbench calls this before every interactive run so a final-quality
   * answer already on disk is shown instead of a quick one that disagrees with
   * it — a user ran at 10,000 paths, refreshed the browser, and watched
   * 94.2% revert to 93.1% because nothing ever looked.
   *
   * It is a POST because the question is the whole simulation input and the
   * plan does not fit in a query string, NOT because anything changes: this
   * route reads files and hashes them, and that is all. POST /api/run right
   * above answers just as instantly on a hit, but its miss spawns the
   * simulation — which on a page load is precisely the 10,000-path run this
   * route exists to not start.
   */
  app.post('/api/run/cached', async (req) => ({
    result: await lookupCachedRun(req.body as RunRequest),
  }));

  app.get<{ Params: { runId: string } }>('/api/run/:runId', async (req) => {
    const progress = await getRun(req.params.runId);
    if (!progress) throw new NotFoundError(`Unknown run "${req.params.runId}"`);
    return progress;
  });

  // ----- Search -----------------------------------------------------------
  // A search runs for minutes, so POST returns an id and the work continues in
  // the background. Poll GET /api/search/:id; cancel with POST .../cancel — a
  // cancelled search still writes a report, labelled with the precision it
  // reached.
  app.post('/api/search', async (req) => {
    const request = validateBody(
      searchRequestSchema as unknown as z.ZodType<SearchRequest>,
      req.body,
      'search request',
    );
    return startSearch(request);
  });

  app.get('/api/searches', async () => listSearches());

  app.get<{ Params: { searchId: string } }>('/api/search/:searchId', async (req) => {
    const progress = await getSearch(req.params.searchId);
    if (!progress) throw new NotFoundError(`Unknown search "${req.params.searchId}"`);
    return progress;
  });

  app.get<{ Params: { searchId: string } }>('/api/search/:searchId/report', async (req) =>
    getSearchReport(req.params.searchId),
  );

  app.post<{ Params: { searchId: string } }>('/api/search/:searchId/cancel', async (req) => {
    const stopping = cancelSearch(req.params.searchId);
    if (!stopping) {
      // Already finished, already failed, or never existed. Not an error: the
      // owner pressed stop and the search is not running, which is what they
      // wanted either way.
      const progress = await getSearch(req.params.searchId);
      if (!progress) throw new NotFoundError(`Unknown search "${req.params.searchId}"`);
      return { ok: true as const, stopping: false, status: progress.status };
    }
    return { ok: true as const, stopping: true };
  });

  // ----- Static UI --------------------------------------------------------
  const distUi = path.join(repoRoot, 'dist', 'ui');
  const hasBuiltUi = existsSync(path.join(distUi, 'index.html'));

  /*
   * UNDER `npm run dev`, THIS PORT MUST NOT SERVE THE UI. dist/ui is a build
   * artifact frozen at whatever moment something last ran `vite build`, and
   * this server happily serves it while tsx watch keeps the API current — so
   * the user's browser shows last week's interface over today's engine and
   * nothing on screen says so. That exact split has now bitten twice: once as
   * engine 1.10.0 under a 1.11.0 UI, once as "I asked for the category column
   * to be removed and it still appears" while the removal sat built-and-tested
   * on the OTHER port. The user browses :5599 by habit; redirecting is what
   * makes that habit correct. dev.mjs sets FPLAN_VITE_URL, so this branch only
   * exists while the hot-reloading UI is actually running; `npm run preview`
   * and `npm start` set nothing and serve dist/ui exactly as before.
   */
  const viteUrl = process.env.FPLAN_VITE_URL;
  if (viteUrl) {
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/')) {
        return reply.status(404).send({ error: `Not found: ${req.method} ${req.url}` });
      }
      // 307 keeps method + path, so a deep link like /profile/expenses lands on
      // the same view on the live port rather than on its root.
      return reply.redirect(`${viteUrl}${req.url}`, 307);
    });
  } else if (hasBuiltUi) {
    await app.register(fastifyStatic, { root: distUi });
    // SPA fallback: unknown non-API paths get index.html; API 404s stay JSON.
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/')) {
        return reply.status(404).send({ error: `Not found: ${req.method} ${req.url}` });
      }
      return reply.sendFile('index.html');
    });
  } else {
    app.get('/', async (_req, reply) =>
      reply.type('text/html').send(
        `<!doctype html><html><head><meta charset="utf-8"><title>Finance Planner</title></head>
<body style="font-family: system-ui, sans-serif; max-width: 40rem; margin: 4rem auto;">
<h1>UI not built</h1>
<p>UI not built &mdash; run: <code>npm start</code> (or <code>npm run dev:ui</code> for the dev server).</p>
<p>The API is live at <code>/api/*</code>.</p>
</body></html>`,
      ),
    );
    app.setNotFoundHandler((req, reply) =>
      reply.status(404).send({ error: `Not found: ${req.method} ${req.url}` }),
    );
  }

  // ----- Listen -----------------------------------------------------------
  await app.listen({ port, host });

  // 0.0.0.0 and :: are bind wildcards rather than addresses you can visit, so
  // the banner (and the browser we may be about to open) needs the loopback
  // form instead.
  const url = `http://${displayHost(host)}:${port}/`;
  console.log(`Finance planner running at ${url}`);
  console.log(`Data folder: ${init.dataDir}`);
  if (!existsSync(path.join(init.dataDir, '.git'))) {
    console.log(
      `Tip: your data folder is not version-controlled. Run: git init ${init.dataDir}`,
    );
  }
  // Last, so it is the thing left on screen: an unauthenticated financial
  // dossier has just been made reachable from the network. Silent when the
  // bind is loopback, which is every ordinary install.
  const warning = exposureWarning(host);
  if (warning) console.warn(warning);
  if (shouldOpenBrowser(init.dataDir, port)) openBrowser(url);
}

main().catch((err) => {
  // A locked data folder and an unusable FPLAN_PORT are operator problems that
  // already carry a complete explanation. Printing the Error object as well
  // buries that explanation under a stack trace of this file, which tells the
  // person reading it nothing they can act on.
  if (err instanceof DataDirLockedError || err instanceof ListenConfigError) {
    console.error(`\n${err.message}\n`);
  } else {
    console.error(err);
  }
  process.exit(1);
});

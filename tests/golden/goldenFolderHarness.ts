/**
 * THE GOLDEN-FOLDER HARNESS: one scripted session over the full store surface,
 * producing a data folder whose bytes are the refactoring gate.
 *
 * Run it at two commits (the storage-seam refactor's parent and its HEAD),
 * byte-diff the folders with goldenFolderDiff.ts, and the diff IS the verdict:
 * identical folders — modulo the enumerated fields the stores stamp from real
 * clocks with no injection seam — or the refactor changed behaviour. This is a
 * script rather than a vitest test because it must be runnable, unchanged, at
 * ANY commit whose exported store surface matches (the seam refactor keeps
 * every export), from a throwaway worktree:
 *
 *     npx tsx tests/golden/goldenFolderHarness.ts /tmp/golden-parent
 *     npx tsx tests/golden/goldenFolderDiff.ts /tmp/golden-parent /tmp/golden-head
 *
 * Its real purpose is Phase 3 of the browser port: the same session driven
 * through the FileSystemDirectoryHandle driver must produce the same bytes,
 * and this harness is the Node half of that comparison.
 *
 * WHAT IS PINNED AND WHAT IS NOT. Every clock the stores let us inject is
 * injected (savePlan/keepPlan/restorePlan's `now`, refreshQuotes' deps,
 * acquireDataDirLock's now/pid/hostname). Three stamps have NO injection seam
 * today and are normalized — field by field, never wholesale — by the diff:
 *   1. networth.json rows: `id` (Date.now + randomBytes) and `takenAt`
 *      (new Date()) — takeSnapshot reads the real clock.
 *   2. plan-history.json entries: the randomBytes(3) SUFFIX of `id` only; the
 *      time36 prefix is pinned by the injected clock and stays compared.
 *   3. runs/<runKey>.json: `meta.createdAt` (finishRun stamps wall clock) and
 *      top-level `elapsedMs` (wall-clock simulation time).
 * Everything else in every file must match byte for byte, including the
 * runs/<runKey>.json FILENAME itself — a runKey drift is a missing-file diff.
 *
 * NEVER run this against a real data folder: it takes an output directory,
 * refuses one that already has contents, and sets FPLAN_DATA_DIR itself.
 */
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const defaultsDir = path.join(repoRoot, 'data-defaults');

function fail(message: string): never {
  console.error(`GOLDEN HARNESS FAILED: ${message}`);
  process.exit(1);
}

function assert(cond: unknown, message: string): asserts cond {
  if (!cond) fail(message);
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  const outDir = process.argv[2];
  if (!outDir) fail('usage: tsx tests/golden/goldenFolderHarness.ts <outDir>');
  const out = path.resolve(outDir);

  // Refuse a non-empty target: this harness owns its folder entirely, and a
  // half-written previous attempt (or, catastrophically, a real data folder)
  // must never be mistaken for a fresh canvas.
  await fsp.mkdir(out, { recursive: true });
  if ((await fsp.readdir(out)).length > 0) fail(`${out} is not empty — refusing to write into it`);

  const freshDir = path.join(out, 'fresh');
  const legacyDir = path.join(out, 'legacy');

  // Imports are dynamic and AFTER argument validation so a bad invocation
  // cannot touch anything. Module-level store state (write chains, run map) is
  // per-process and harmless here: one process, one scripted session.
  process.env.FPLAN_DATA_DIR = freshDir;
  const dataStore = await import('../../src/server/dataStore');
  const planStore = await import('../../src/server/planStore');
  const planHistoryStore = await import('../../src/server/planHistoryStore');
  const networthStore = await import('../../src/server/networthStore');
  const quotes = await import('../../src/server/quotes');
  const runManager = await import('../../src/server/runManager');
  const scoreStore = await import('../../src/server/search/scoreStore');
  const singleWriter = await import('../../src/server/singleWriter');
  const { ENGINE_VERSION } = await import('../../src/shared/types');
  type Scenario = import('../../src/shared/types').Scenario;

  // ==========================================================================
  // PHASE 1 — the fresh folder: seeding and every record-write path.
  // ==========================================================================
  process.env.FPLAN_DATA_DIR = freshDir;

  // --- Seed an empty dir ----------------------------------------------------
  const init = await dataStore.initDataDir();
  assert(init.existedBefore === false, 'fresh folder reported existedBefore=true');
  assert(init.dataDir === freshDir, `initDataDir dataDir mismatch: ${init.dataDir}`);

  // --- First read seeds the plan -------------------------------------------
  const seededPlan = await planStore.loadPlan();

  // --- Quotes: injected fetch + clock, one success and one per-symbol failure
  const vtiFixture = JSON.parse(
    await fsp.readFile(path.join(repoRoot, 'tests', 'fixtures', 'yahoo-chart-vti.json'), 'utf8'),
  ) as unknown;
  const fetchImpl = async (url: string): Promise<{ ok: boolean; status: number; json(): Promise<unknown> }> => {
    if (url.includes('/VTI?')) return { ok: true, status: 200, json: async () => vtiFixture };
    return { ok: false, status: 404, json: async () => ({}) };
  };
  const refreshOutcome = await quotes.refreshQuotes(['VTI', 'GOLDENBAD'], {
    fetchImpl,
    now: () => new Date('2026-08-24T13:00:00.000Z'),
  });
  assert(refreshOutcome.results.length === 2, 'expected two per-symbol refresh outcomes');
  assert(refreshOutcome.results[0].ok && !refreshOutcome.results[1].ok, 'expected VTI ok, GOLDENBAD failed');

  // --- The plan and its daily guard, on injected clocks ---------------------
  // Local-time constructors so localDayKey (which reads local getters) and the
  // ISO takenAt (UTC) are both deterministic on the machine running the diff.
  const dayA = new Date(2026, 7, 24, 9, 0, 0); // Aug 24, 09:00 local
  const dayALater = new Date(2026, 7, 24, 11, 30, 0);
  const dayAKeep = new Date(2026, 7, 24, 12, 0, 0);
  const dayB = new Date(2026, 7, 25, 8, 15, 0); // Aug 25
  const dayBLater = new Date(2026, 7, 25, 10, 0, 0);

  const v2: Scenario = { ...seededPlan, description: 'golden v2' };
  const v3: Scenario = { ...seededPlan, description: 'golden v3' };
  const v4: Scenario = { ...seededPlan, description: 'golden v4' };

  await planStore.savePlan(v2, dayA); // guard files the seeded plan as dayA's day-start
  await planStore.savePlan(v3, dayALater); // dayA already covered -> no new entry
  await planHistoryStore.keepPlan(v2, 'golden keep', dayAKeep); // an explicit 'kept' entry
  await planStore.savePlan(v4, dayB); // guard files v3 as dayB's day-start

  const history = await planHistoryStore.listPlanHistory();
  assert(history.length === 3, `expected 3 history entries, got ${history.length}`);
  const dayAStart = history.find(
    (e) => e.kind === 'day-start' && e.takenAt === dayA.toISOString(),
  );
  assert(dayAStart, 'dayA day-start entry not found');
  const keptEntry = history.find((e) => e.kind === 'kept');
  assert(keptEntry, 'kept entry not found');

  // --- Restore a version (an ordinary guarded save of entry.plan) -----------
  const restored = await planStore.restorePlan(dayAStart.id, dayBLater);
  assert(restored.restoredFrom.id === dayAStart.id, 'restore returned the wrong entry');

  // --- Score attachment on history: a number, its spend, and a failure ------
  await (async () => {
    const score = {
      success: 0.923,
      medianTerminalReal: 1_500_000,
      mode: 'montecarlo' as const,
      paths: 10_000,
      seed: 20260812,
      engineVersion: ENGINE_VERSION,
      scoredAt: '2026-08-24T14:00:00.000Z',
    };
    const wrote = await planHistoryStore.attachPlanHistoryScore(dayAStart.id, { score });
    assert(wrote === 'attached', `history score write returned ${wrote}`);
    const spendWrote = await planHistoryStore.attachPlanHistorySpend(dayAStart.id, {
      sustainableSpend: 91_000,
      sustainableSpendPaths: 2_000,
    });
    assert(spendWrote === true, 'history spend write refused');
    const refused = await planHistoryStore.attachPlanHistoryScore(dayAStart.id, { score });
    assert(refused === 'already_scored', 'a recorded score was not refused');
    const errWrote = await planHistoryStore.attachPlanHistoryScore(keptEntry.id, {
      error: 'golden: scoring failed on purpose',
    });
    assert(errWrote === 'attached', `history error write returned ${errWrote}`);
  })();

  // --- Net-worth rows: append, score, spend, error, delete ------------------
  const row1 = await networthStore.takeSnapshot({ homeValue: 850_000, note: 'golden row one' });
  const row2 = await networthStore.takeSnapshot({ homeValue: 860_000 });
  const row3 = await networthStore.takeSnapshot({ homeValue: 870_000, note: 'golden doomed row' });
  await (async () => {
    const score = {
      success: 0.911,
      medianTerminalReal: 1_400_000,
      mode: 'montecarlo' as const,
      paths: 10_000,
      seed: 20260812,
      engineVersion: ENGINE_VERSION,
      scoredAt: '2026-08-24T15:00:00.000Z',
      planHash: planHistoryStore.planHash(v4),
    };
    const wrote = await networthStore.attachScore(row1.id, { score });
    assert(wrote === 'attached', `snapshot score write returned ${wrote}`);
    const spendWrote = await networthStore.attachSustainableSpend(row1.id, {
      sustainableSpend: 89_000,
      sustainableSpendPaths: 2_000,
    });
    assert(spendWrote === true, 'snapshot spend write refused');
    const errWrote = await networthStore.attachScore(row2.id, {
      error: 'golden: no measurement on purpose',
    });
    assert(errWrote === 'attached', `snapshot error write returned ${errWrote}`);
  })();
  await networthStore.deleteSnapshot(row3.id);
  const rows = await networthStore.listSnapshots();
  assert(rows.length === 2, `expected 2 net-worth rows after delete, got ${rows.length}`);

  // --- The run cache: a real deterministic run through the worker -----------
  const currentPlan = await planStore.loadPlan();
  const runReq = { scenario: currentPlan, mode: 'deterministic' as const };
  const { runId } = await runManager.startRun(runReq);
  for (;;) {
    const progress = await runManager.getRun(runId);
    assert(progress, `run ${runId} vanished`);
    if (progress.status === 'done') break;
    if (progress.status === 'error') fail(`run failed: ${progress.error ?? 'unknown'}`);
    await sleep(200);
  }
  const cachedByKey = await runManager.readCachedResult(runId);
  assert(cachedByKey, 'readCachedResult missed a run just written');
  const looked = await runManager.lookupCachedRun(runReq);
  assert(looked && looked.meta.runKey === runId, 'lookupCachedRun missed the cached run');

  // --- The slim search score cache ------------------------------------------
  // elapsedMs is overwritten with a constant: it is the one nondeterministic
  // field scoreFromResult copies out of the run, and this file has no
  // normalization pass — its bytes must match exactly.
  const slim = { ...scoreStore.scoreFromResult(runId, cachedByKey), elapsedMs: 1234 };
  await scoreStore.writeScore(slim);
  const slimBack = await scoreStore.readScore(runId);
  assert(slimBack && slimBack.elapsedMs === 1234, 'slim score roundtrip failed');

  // --- The single-writer lock: take, verify, release ------------------------
  const release = await singleWriter.acquireDataDirLock({
    dataDir: freshDir,
    port: 5599,
    appDir: '/golden-harness',
    waitMs: 0,
    sleep: async () => {},
    now: () => new Date('2026-08-24T16:00:00.000Z').getTime(),
    hostname: 'golden-host',
    pid: process.pid,
  });
  const lockRaw = await fsp.readFile(path.join(freshDir, singleWriter.LOCK_FILENAME), 'utf8');
  assert(singleWriter.parseOwner(lockRaw)?.pid === process.pid, 'lock does not name this process');
  release();
  await fsp.access(path.join(freshDir, singleWriter.LOCK_FILENAME)).then(
    () => fail('.writer.lock still present after release'),
    () => undefined,
  );

  // ==========================================================================
  // PHASE 2 — the legacy folder: every startup migration path.
  // ==========================================================================
  process.env.FPLAN_DATA_DIR = legacyDir;
  await fsp.mkdir(legacyDir, { recursive: true });

  // Seed assumptions/ as full copies of the repo defaults, then damage them in
  // exactly the ways the migrations exist to heal: a missing key in
  // market.json (backfillMissingKeys) and a 5-column historical CSV
  // (backfillHistoricalBaaColumn's join-by-year).
  await fsp.cp(path.join(defaultsDir, 'assumptions'), path.join(legacyDir, 'assumptions'), {
    recursive: true,
  });
  const marketPath = path.join(legacyDir, 'assumptions', 'market.json');
  const market = JSON.parse(await fsp.readFile(marketPath, 'utf8')) as Record<string, unknown>;
  delete market.rentGrowthRealSpread;
  await fsp.writeFile(marketPath, `${JSON.stringify(market, null, 2)}\n`, 'utf8');
  const csvPath = path.join(legacyDir, 'assumptions', 'historical-returns.csv');
  const defaultCsv = await fsp.readFile(path.join(defaultsDir, 'assumptions', 'historical-returns.csv'), 'utf8');
  const fiveCol = defaultCsv
    .split(/\r?\n/)
    .map((line) => {
      const t = line.trim();
      if (t.length === 0 || t.startsWith('#')) return line;
      const parts = line.split(',');
      return parts.length === 6 ? parts.slice(0, 5).join(',') : line;
    })
    .join('\n');
  await fsp.writeFile(csvPath, fiveCol, 'utf8');

  // A legacy-shaped profile: every migrateProfile rule firing at once, PLUS
  // the bundled tithe rule — which is the gate migrateGivingSplitFiles' trap
  // rule consults, so it must still be present when initDataDir runs.
  const starter = JSON.parse(
    await fsp.readFile(path.join(defaultsDir, 'profile.starter.json'), 'utf8'),
  ) as Record<string, any>;
  const legacyProfile = structuredClone(starter);
  const p0 = legacyProfile.people[0];
  delete p0.piaMonthlyAtFraIfWorkingTo62;
  delete p0.piaMonthlyAtFraIfStoppingNow;
  p0.piaMonthlyAtFra = 2900;
  delete legacyProfile.accounts[0].name;
  legacyProfile.settings.withdrawalPolicy.pretaxPreference = 'rule_of_55_first';
  legacyProfile.expenses = {
    annualBaseline: 96_000,
    categories: { housing: 2_000 },
    retirementGiving: { type: 'tithe_account', percent: 0.1, deferYears: 5, seedFromExistingGains: true },
  };
  delete legacyProfile.health.employerPremiumShareMonthly;
  legacyProfile.health.acaBenchmarkMonthly = 1750;
  await fsp.writeFile(
    path.join(legacyDir, 'profile.json'),
    `${JSON.stringify(legacyProfile, null, 2)}\n`,
    'utf8',
  );

  // plan.json carrying a bundled tithe OVERRIDE -> becomes ongoing + explicit pot.
  const legacyPlan = {
    name: 'Plan',
    events: [],
    assumption_overrides: {
      expenses: {
        retirementGiving: { type: 'tithe_account', percent: 0.1, deferYears: 3, seedFromExistingGains: false },
      },
    },
  };
  await fsp.writeFile(
    path.join(legacyDir, 'plan.json'),
    `${JSON.stringify(legacyPlan, null, 2)}\n`,
    'utf8',
  );

  // Two cabinet files: a wrapped scenario with a NON-tithe override (the trap
  // rule — it used to suppress the pot by replacing the whole bundled rule,
  // so it must get an explicit { enabled: false }), and a legacy BARE Scenario
  // with a tithe bundle (the else branch of the wrapper detection).
  await fsp.mkdir(path.join(legacyDir, 'scenarios'), { recursive: true });
  const wrapped = {
    name: 'trap case',
    savedAt: '2026-01-01T00:00:00.000Z',
    scenario: {
      name: 'trap case',
      events: [],
      assumption_overrides: { expenses: { retirementGiving: { type: 'none' } } },
    },
  };
  await fsp.writeFile(
    path.join(legacyDir, 'scenarios', 'trap-case.json'),
    `${JSON.stringify(wrapped, null, 2)}\n`,
    'utf8',
  );
  const bare = {
    name: 'bare legacy',
    events: [],
    assumption_overrides: {
      expenses: {
        retirementGiving: { type: 'tithe_account', percent: 0.05, deferYears: 0, seedFromExistingGains: true },
      },
    },
  };
  await fsp.writeFile(
    path.join(legacyDir, 'scenarios', 'bare-legacy.json'),
    `${JSON.stringify(bare, null, 2)}\n`,
    'utf8',
  );

  // Startup: seeding (copy-if-missing must NOT overwrite), backfills, and the
  // one-time ordered giving-split pass over profile + plan + cabinet.
  const legacyInit = await dataStore.initDataDir();
  assert(legacyInit.existedBefore === true, 'legacy folder reported existedBefore=false');

  // The migrated folder must load cleanly through every validating door, and
  // idempotently: none of these loads may write another byte.
  await dataStore.loadProfile();
  await dataStore.loadAssumptions();
  await planStore.loadPlan();
  const secondBackfill = await dataStore.backfillAssumptionDefaults();
  assert(secondBackfill.length === 0, `backfill not idempotent: ${secondBackfill.join('; ')}`);

  console.log(`GOLDEN HARNESS OK: ${out}`);
  process.exit(0);
}

main().catch((err) => {
  console.error('GOLDEN HARNESS CRASHED:', err);
  process.exit(1);
});

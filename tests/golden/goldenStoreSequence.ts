/**
 * THE CROSS-DRIVER GOLDEN SEQUENCE: one scripted session over the PORTED
 * store surface, written once and executed against both drivers, so the
 * resulting trees can be byte-compared.
 *
 * This is the browser-port half of what tests/golden/goldenFolderHarness.ts
 * does across commits: that script proves "same code, different COMMIT, same
 * bytes"; this module proves "same code, different DRIVER, same bytes" — the
 * node:fs folder and the Chromium/OPFS folder must come out identical, modulo
 * the same enumerated masks the harness documents (real-clock/randomness
 * stamps with no injection seam). tests/browser/stores.test.ts runs the
 * comparison.
 *
 * WHAT IS DELIBERATELY NOT HERE, versus the full harness: the run cache
 * (runManager spawns node worker_threads), the slim search score store, and
 * .writer.lock (singleWriter) — none of those modules ported in Phase 3, so
 * a sequence touching them could not run in the browser at all. They stay in
 * the node-only harness; their browser equivalents arrive with Phases 4-5.
 * The lease, their Phase-3 replacement for the lock, IS exercised: taken at
 * the start (pinned clock, no heartbeat), released at the end, leaving no
 * file — like the harness's lock take/verify/release.
 *
 * Environment-neutral by construction: no node imports, no vitest; fixture
 * files are built THROUGH the FileStore under test, assertions come from
 * tests/store/check.
 */
import { FileNotFoundError, type FileStore } from '../../src/shared/fileStore';
import { ENGINE_VERSION, type Scenario } from '../../src/shared/types';
import type { Stores } from '../../src/store';
import { planHash } from '../../src/store/planHistoryStore';
import { acquireWriterLease, LEASE_FILENAME } from '../../src/store/writerLease';
import { eq, is, ok } from '../store/check';

export interface GoldenSequenceContext {
  stores: Stores;
  files: FileStore;
  defaults: FileStore;
  /** Parsed tests/fixtures/yahoo-chart-vti.json. */
  vtiFixture: unknown;
}

// ---------------------------------------------------------------------------
// The fresh folder: seeding and every ported record-write path
// ---------------------------------------------------------------------------

export async function runGoldenFreshSequence(ctx: GoldenSequenceContext): Promise<void> {
  const { stores, files } = ctx;

  // --- The lease: take (pinned clock, no heartbeat), verify, release later --
  const lease = await acquireWriterLease({
    files,
    self: { clientId: 'golden-client', label: 'golden-sequence' },
    now: () => new Date('2026-08-24T08:00:00.000Z'),
    schedule: () => 0, // never beats — the sequence is single-pass
    cancel: () => undefined,
    onLog: () => undefined,
  });
  ok(lease.ok, 'the golden sequence could not take a fresh folder’s lease');

  // --- Seed an empty folder -------------------------------------------------
  const init = await stores.data.initDataDir();
  is(init.existedBefore, false, 'fresh folder reported existedBefore=true');

  // --- First read seeds the plan -------------------------------------------
  const seededPlan = await stores.plan.loadPlan();

  // --- Quotes: injected fetch + clock, one success and one per-symbol failure
  const fetchImpl = async (
    url: string,
  ): Promise<{ ok: boolean; status: number; json(): Promise<unknown> }> => {
    if (url.includes('/VTI?')) return { ok: true, status: 200, json: async () => ctx.vtiFixture };
    return { ok: false, status: 404, json: async () => ({}) };
  };
  const refresh = await stores.quotes.refreshQuotes(['VTI', 'GOLDENBAD'], {
    fetchImpl,
    now: () => new Date('2026-08-24T13:00:00.000Z'),
  });
  is(refresh.results.length, 2, 'expected two per-symbol refresh outcomes');
  ok(refresh.results[0].ok && !refresh.results[1].ok, 'expected VTI ok, GOLDENBAD failed');

  // --- The plan and its daily guard, on injected clocks ---------------------
  // Local-time constructors so localDayKey (local getters) and the ISO
  // takenAt (UTC) are both deterministic on the machine running the diff.
  const dayA = new Date(2026, 7, 24, 9, 0, 0);
  const dayALater = new Date(2026, 7, 24, 11, 30, 0);
  const dayAKeep = new Date(2026, 7, 24, 12, 0, 0);
  const dayB = new Date(2026, 7, 25, 8, 15, 0);
  const dayBLater = new Date(2026, 7, 25, 10, 0, 0);

  const v2: Scenario = { ...seededPlan, description: 'golden v2' };
  const v3: Scenario = { ...seededPlan, description: 'golden v3' };
  const v4: Scenario = { ...seededPlan, description: 'golden v4' };

  await stores.plan.savePlan(v2, dayA); // guard files the seeded plan as dayA's day-start
  await stores.plan.savePlan(v3, dayALater); // dayA already covered -> no new entry
  await stores.planHistory.keepPlan(v2, 'golden keep', dayAKeep);
  await stores.plan.savePlan(v4, dayB); // guard files v3 as dayB's day-start

  const history = await stores.planHistory.listPlanHistory();
  is(history.length, 3, `expected 3 history entries, got ${history.length}`);
  const dayAStart = history.find((e) => e.kind === 'day-start' && e.takenAt === dayA.toISOString());
  ok(dayAStart, 'dayA day-start entry not found');
  const keptEntry = history.find((e) => e.kind === 'kept');
  ok(keptEntry, 'kept entry not found');

  // --- Restore a version (an ordinary guarded save of entry.plan) -----------
  const restored = await stores.plan.restorePlan(dayAStart.id, dayBLater);
  is(restored.restoredFrom.id, dayAStart.id, 'restore returned the wrong entry');

  // --- Score attachment on history: a number, its spend, and a failure ------
  const historyScore = {
    success: 0.923,
    medianTerminalReal: 1_500_000,
    mode: 'montecarlo' as const,
    paths: 10_000,
    seed: 20260812,
    engineVersion: ENGINE_VERSION,
    scoredAt: '2026-08-24T14:00:00.000Z',
  };
  is(
    await stores.planHistory.attachPlanHistoryScore(dayAStart.id, { score: historyScore }),
    'attached',
    'history score write refused',
  );
  is(
    await stores.planHistory.attachPlanHistorySpend(dayAStart.id, {
      sustainableSpend: 91_000,
      sustainableSpendPaths: 2_000,
    }),
    true,
    'history spend write refused',
  );
  is(
    await stores.planHistory.attachPlanHistoryScore(dayAStart.id, { score: historyScore }),
    'already_scored',
    'a recorded score was not refused',
  );
  is(
    await stores.planHistory.attachPlanHistoryScore(keptEntry.id, {
      error: 'golden: scoring failed on purpose',
    }),
    'attached',
    'history error write refused',
  );

  // --- Net-worth rows: append, score, spend, error, delete ------------------
  const row1 = await stores.networth.takeSnapshot({ homeValue: 850_000, note: 'golden row one' });
  const row2 = await stores.networth.takeSnapshot({ homeValue: 860_000 });
  const row3 = await stores.networth.takeSnapshot({ homeValue: 870_000, note: 'golden doomed row' });
  const rowScore = {
    success: 0.911,
    medianTerminalReal: 1_400_000,
    mode: 'montecarlo' as const,
    paths: 10_000,
    seed: 20260812,
    engineVersion: ENGINE_VERSION,
    scoredAt: '2026-08-24T15:00:00.000Z',
    planHash: planHash(v4),
  };
  is(await stores.networth.attachScore(row1.id, { score: rowScore }), 'attached', 'snapshot score refused');
  is(
    await stores.networth.attachSustainableSpend(row1.id, {
      sustainableSpend: 89_000,
      sustainableSpendPaths: 2_000,
    }),
    true,
    'snapshot spend refused',
  );
  is(
    await stores.networth.attachScore(row2.id, { error: 'golden: no measurement on purpose' }),
    'attached',
    'snapshot error refused',
  );
  await stores.networth.deleteSnapshot(row3.id);
  is((await stores.networth.listSnapshots()).length, 2, 'expected 2 net-worth rows after delete');

  // --- Release the lease: like the harness's lock, it must leave no file ----
  await lease.guard.release();
  is(await files.exists(LEASE_FILENAME), false, `${LEASE_FILENAME} still present after release`);
}

// ---------------------------------------------------------------------------
// The legacy folder: every ported startup-migration path
// ---------------------------------------------------------------------------

export async function runGoldenLegacySequence(ctx: GoldenSequenceContext): Promise<void> {
  const { stores, files, defaults } = ctx;

  // Seed assumptions/ as full copies of the repo defaults, then damage them
  // in exactly the ways the migrations exist to heal: a missing key in
  // market.json (backfillMissingKeys) and a 5-column historical CSV
  // (backfillHistoricalBaaColumn's join-by-year).
  async function copyTree(srcRel: string, destRel: string): Promise<void> {
    await files.mkdir(destRel);
    for (const entry of await defaults.list(srcRel)) {
      const src = `${srcRel}/${entry.name}`;
      const dest = `${destRel}/${entry.name}`;
      if (entry.kind === 'directory') await copyTree(src, dest);
      else await files.writeBytes(dest, await defaults.readBytes(src));
    }
  }
  await copyTree('assumptions', 'assumptions');

  const market = JSON.parse(await files.readText('assumptions/market.json')) as Record<string, unknown>;
  delete market.rentGrowthRealSpread;
  await files.writeText('assumptions/market.json', `${JSON.stringify(market, null, 2)}\n`);

  const defaultCsv = await defaults.readText('assumptions/historical-returns.csv');
  const fiveCol = defaultCsv
    .split(/\r?\n/)
    .map((line) => {
      const t = line.trim();
      if (t.length === 0 || t.startsWith('#')) return line;
      const parts = line.split(',');
      return parts.length === 6 ? parts.slice(0, 5).join(',') : line;
    })
    .join('\n');
  await files.writeText('assumptions/historical-returns.csv', fiveCol);

  // A legacy-shaped profile: every migrateProfile rule firing at once, PLUS
  // the bundled tithe rule — which is the gate migrateGivingSplitFiles' trap
  // rule consults, so it must still be present when initDataDir runs.
  const starter = JSON.parse(await defaults.readText('profile.starter.json')) as Record<string, any>;
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
  await files.writeText('profile.json', `${JSON.stringify(legacyProfile, null, 2)}\n`);

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
  await files.writeText('plan.json', `${JSON.stringify(legacyPlan, null, 2)}\n`);

  // Two cabinet files: a wrapped scenario with a NON-tithe override (the trap
  // rule) and a legacy BARE Scenario with a tithe bundle.
  await files.mkdir('scenarios');
  const wrapped = {
    name: 'trap case',
    savedAt: '2026-01-01T00:00:00.000Z',
    scenario: {
      name: 'trap case',
      events: [],
      assumption_overrides: { expenses: { retirementGiving: { type: 'none' } } },
    },
  };
  await files.writeText('scenarios/trap-case.json', `${JSON.stringify(wrapped, null, 2)}\n`);
  const bare = {
    name: 'bare legacy',
    events: [],
    assumption_overrides: {
      expenses: {
        retirementGiving: { type: 'tithe_account', percent: 0.05, deferYears: 0, seedFromExistingGains: true },
      },
    },
  };
  await files.writeText('scenarios/bare-legacy.json', `${JSON.stringify(bare, null, 2)}\n`);

  // Startup: seeding (copy-if-missing must NOT overwrite), backfills, and the
  // one-time ordered giving-split pass over profile + plan + cabinet.
  const legacyInit = await stores.data.initDataDir();
  is(legacyInit.existedBefore, true, 'legacy folder reported existedBefore=false');

  // The migrated folder must load cleanly through every validating door, and
  // idempotently: none of these loads may write another byte.
  await stores.data.loadProfile();
  await stores.data.loadAssumptions();
  await stores.plan.loadPlan();
  eq(await stores.data.backfillAssumptionDefaults(), [], 'backfill not idempotent');
}

// ---------------------------------------------------------------------------
// Tree snapshot + masks
// ---------------------------------------------------------------------------

/**
 * Every file under the store's root as {relPath → text}, keys sorted. Text,
 * not bytes: everything the sequence writes is UTF-8 JSON/CSV, and the diff's
 * job is to point at a LINE when something differs.
 */
export async function treeSnapshot(files: FileStore): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  async function walk(relDir: string): Promise<void> {
    let entries;
    try {
      entries = await files.list(relDir);
    } catch (err) {
      if (err instanceof FileNotFoundError) return;
      throw err;
    }
    for (const entry of entries) {
      const rel = relDir === '' ? entry.name : `${relDir}/${entry.name}`;
      if (entry.kind === 'directory') await walk(rel);
      else out[rel] = await files.readText(rel);
    }
  }
  await walk('');
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => (a < b ? -1 : 1)));
}

/**
 * The enumerated masks, IDENTICAL in spirit to goldenFolderDiff.ts (keep the
 * two lists in sync): field-by-field regex replacement on raw text, never
 * parse-and-restringify — reserialization would silently forgive formatting
 * drift, which is exactly what the gate exists to catch.
 *
 *   networth.json       rows[].id (Date.now+randomHex, no seam),
 *                       rows[].takenAt (real clock, no seam)
 *   plan-history.json   the 6-hex randomHex suffix of entries[].id only;
 *                       the time36 prefix is pinned by the injected clock
 *                       and stays compared.
 */
export function maskGoldenTree(tree: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [rel, text] of Object.entries(tree)) {
    let masked = text;
    if (rel === 'networth.json') {
      masked = masked.replace(/"id": "nw-[0-9a-z]+-[0-9a-f]{6}"/g, '"id": "nw-MASKED"');
      masked = masked.replace(/^(\s*)"takenAt": "[^"]+"/gm, '$1"takenAt": "MASKED"');
    }
    if (rel === 'plan-history.json') {
      masked = masked.replace(/("id": "ph-[0-9a-z]+-)[0-9a-f]{6}"/g, '$1MASKED"');
    }
    out[rel] = masked;
  }
  return out;
}

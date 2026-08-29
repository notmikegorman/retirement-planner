/**
 * THE PORTED STORE SUITE: the store-behaviour tests from
 * tests/server/{planHistory,planStore,networth,quotes,dataStore}.test.ts,
 * re-phrased once as environment-neutral cases and run against every driver —
 *
 *   in-memory + node:fs   tests/store/storeSuite.test.ts (node lane)
 *   OPFS in Chromium      tests/browser/stores.test.ts (browser lane)
 *
 * The originals stay where they are, still running against the node wrappers
 * — they are the proof that src/server's delegation layer changed nothing.
 * THIS file is the proof that the store LOGIC is driver-independent: same
 * guard, same refusals, same error text, whichever FileStore is underneath.
 * A case that cannot be phrased neutrally (spawns worker_threads, reads the
 * process env, drives the HTTP layer) does not belong here and stays
 * node-only in its original file.
 *
 * Every case receives a FRESH context: empty data folder, real defaults
 * store, freshly composed stores. Fixture setup that the originals did with
 * node:fs goes through ctx.files — which is itself part of the port's claim:
 * the stores must behave over files written by ANY writer, not just their
 * own.
 */
import type { FileStore } from '../../src/shared/fileStore';
import type { Stores } from '../../src/store';
import {
  NotFoundError,
  ValidationError,
  migrateProfile,
  migrateScenarioGivingInPlace,
} from '../../src/store/dataStore';
import { localDayKey, planHash } from '../../src/store/planHistoryStore';
import { PLAN_NAME } from '../../src/store/planStore';
import { fetchYahooQuote, parseYahooChart, type FetchLike } from '../../src/store/quotes';
import type {
  PlanScore,
  Profile,
  QuotesFile,
  Scenario,
  ScenarioEvent,
} from '../../src/shared/types';
import { eq, includes, is, ok, rejects, throws } from './check';

export interface StoreSuiteContext {
  stores: Stores;
  /** The data folder the stores are bound to. */
  files: FileStore;
  /** The defaults store the stores seed from. */
  defaults: FileStore;
  /** Parsed tests/fixtures/yahoo-chart-vti.json (a REAL captured response). */
  vtiFixture: unknown;
}

export interface StoreCase {
  name: string;
  run(ctx: StoreSuiteContext): Promise<void>;
}

// ---------------------------------------------------------------------------
// Shared fixtures (verbatim from the originals)
// ---------------------------------------------------------------------------

const plan = (over: Partial<Scenario> = {}): Scenario => ({
  name: 'Plan',
  events: [{ type: 'retire', person: 'p1', date: '2031-07' }],
  ...over,
});

const score = (over: Partial<PlanScore> = {}): PlanScore => ({
  success: 0.938,
  medianTerminalReal: 1_284_510.4471935,
  mode: 'montecarlo',
  paths: 1000,
  seed: 20260812,
  engineVersion: '1.21.0',
  scoredAt: '2026-08-18T21:41:17.203Z',
  ...over,
});

const QUOTES: QuotesFile = {
  VTI: {
    price: 379.04,
    currency: 'USD',
    asOf: '2026-08-18T20:00:00.000Z',
    source: 'yahoo',
    fetchedAt: '2026-08-18T21:00:00.000Z',
  },
  BND: {
    price: 72.1,
    currency: 'USD',
    asOf: '2026-08-18T20:00:00.000Z',
    source: 'yahoo',
    fetchedAt: '2026-08-18T21:00:00.000Z',
  },
};

const IRA_DERIVED = 100 * 379.04 + 200 * 72.1 + 50;

/** Two moments on the same local calendar day, and one on the next. */
const MORNING = new Date(2026, 7, 20, 8, 30);
const EARLIER = new Date(2026, 7, 20, 7, 15);
const EVENING = new Date(2026, 7, 20, 21, 15);
const NEXT_DAY = new Date(2026, 7, 21, 9, 0);

/**
 * The default plan the seeder must write for the STARTER profile —
 * hand-computed in tests/server/planStore.test.ts (see the derivation there;
 * p1 born 1975-03, p2 born 1977-09, retire at 62, household claims on the
 * primary's FRA date).
 */
const EXPECTED_SEEDED_EVENTS: ScenarioEvent[] = [
  { type: 'retire', person: 'p1', date: '2037-03' },
  { type: 'retire', person: 'p2', date: '2039-09' },
  { type: 'claim_social_security', person: 'p1', date: '2042-03' },
  { type: 'claim_social_security', person: 'p2', date: '2042-03' },
];

/** Put a plan on disk the way the file itself holds it — no guard, no history. */
async function writePlanFile(ctx: StoreSuiteContext, p: Scenario): Promise<void> {
  await ctx.files.writeText('plan.json', `${JSON.stringify(p, null, 2)}\n`);
}

/** Seed the folder and put a known plan on disk WITHOUT arming the guard. */
async function startWith(ctx: StoreSuiteContext, events: ScenarioEvent[]): Promise<Scenario> {
  await ctx.stores.data.initDataDir();
  const p: Scenario = { name: PLAN_NAME, events };
  await writePlanFile(ctx, p);
  return p;
}

/** Switch the seeded starter profile's IRA to holdings mode and save it. */
async function holdingsProfile(ctx: StoreSuiteContext): Promise<Profile> {
  const profile = await ctx.stores.data.loadProfile();
  const ira = profile.accounts.find((a) => a.id === 'ira1')!;
  ira.holdings = [
    { symbol: 'VTI', quantity: 100, assetClass: 'stocks' },
    { symbol: 'BND', quantity: 200, assetClass: 'bonds' },
  ];
  ira.cash = 50;
  await ctx.stores.data.saveProfile(profile);
  return profile;
}

/** A FetchLike that answers every URL with the given JSON body. */
function fetchReturning(body: unknown, status = 200): FetchLike {
  return async () => ({ ok: status >= 200 && status < 300, status, json: async () => body });
}

/** Clone the vti fixture with a mutator applied to chart.result[0].meta. */
function fixtureWithMeta(
  ctx: StoreSuiteContext,
  mutate: (meta: Record<string, unknown>) => void,
): unknown {
  const clone = structuredClone(ctx.vtiFixture) as {
    chart: { result: Array<{ meta: Record<string, unknown> }> };
  };
  mutate(clone.chart.result[0].meta);
  return clone;
}

/** The old-shape profile fixture from dataStore.test.ts, verbatim. */
function oldShapeProfile(): Record<string, unknown> {
  return {
    people: [
      { id: 'p1', name: 'Alex', birthYear: 1971, birthMonth: 6, piaMonthlyAtFra: 3180, hasOwnBenefit: true },
      { id: 'p2', name: 'Jordan', birthYear: 1971, birthMonth: 6, piaMonthlyAtFra: 0, hasOwnBenefit: false },
    ],
    filing: { status: 'mfj', state: 'va' },
    accounts: [
      {
        id: 'k401',
        type: '401k',
        owner: 'p1',
        balance: 850000,
        allocation: { stocks: 1, bonds: 0, bills: 0 },
        currentEmployer: true,
        ruleOf55Eligible: true,
        allowsPartialWithdrawals: null,
      },
      { id: 'ira1', type: 'traditional_ira', owner: 'p1', balance: 250000, allocation: { stocks: 1, bonds: 0, bills: 0 } },
      { id: 'savings', type: 'savings', owner: 'p1', balance: 35000, allocation: { stocks: 0, bonds: 0, bills: 1 } },
    ],
    home: {
      value: 550000,
      costBasis: 350000,
      state: 'va',
      propertyTaxAnnual: 4400,
      insuranceAnnual: 1800,
      maintenancePctOfValue: 0.01,
      sellingCostPct: 0.06,
      mortgage: null,
    },
    income: { salaries: { p1: 150000, p2: 0 }, contribution401k: 24000, employerMatch401k: 6000 },
    expenses: { annualBaseline: 72000, categories: {} },
    health: { acaBenchmarkMonthly: 1750, acaQuoteYear: 2026, partDPlanMonthly: 45 },
    settings: {
      horizonAge: 95,
      successTarget: 0.85,
      mcPathsInteractive: 1000,
      mcPathsFinal: 10000,
      seed: 20260812,
      spendingPolicy: { type: 'fixed_real' },
      withdrawalPolicy: { order: ['cash', 'taxable', 'pretax', 'roth'], pretaxPreference: 'rule_of_55_first' },
    },
  };
}

/** A current-shape profile carrying the legacy bundled tithe rule. */
async function legacyProfile(ctx: StoreSuiteContext): Promise<Record<string, unknown>> {
  const starter = JSON.parse(await ctx.defaults.readText('profile.starter.json')) as Record<
    string,
    unknown
  >;
  return {
    ...starter,
    expenses: {
      livingMonthly: 8200,
      charitableMonthly: 2300,
      investingMonthly: 1250,
      retirementGiving: { type: 'tithe_account', percent: 0.1, deferYears: 11, seedFromExistingGains: true },
    },
  };
}

// ---------------------------------------------------------------------------
// The cases
// ---------------------------------------------------------------------------

export function storeSuiteCases(): StoreCase[] {
  const cases: StoreCase[] = [];
  const c = (name: string, run: (ctx: StoreSuiteContext) => Promise<void>): void => {
    cases.push({ name, run });
  };

  // ----- plan history: the file --------------------------------------------

  c('history: an empty history when the file does not exist', async (ctx) => {
    eq(await ctx.stores.planHistory.listPlanHistory(), [], 'a folder with no past is not an error');
  });

  c('history: malformed file fails loudly and names itself', async (ctx) => {
    await ctx.files.writeText('plan-history.json', '[{ "id": OOPS }]');
    const err = await rejects(ctx.stores.planHistory.listPlanHistory(), 'malformed history', {
      instanceOf: ValidationError,
    });
    includes(err.message, ctx.files.describe('plan-history.json'), 'error must name the file');
  });

  c('history: reads newest first, whatever order the file is in', async (ctx) => {
    await ctx.files.writeText(
      'plan-history.json',
      JSON.stringify([
        { id: 'ph-late', takenAt: '2026-08-20T09:00:00.000Z', kind: 'day-start', plan: plan(), planHash: planHash(plan()) },
        { id: 'ph-early', takenAt: '2026-08-18T09:00:00.000Z', kind: 'kept', plan: plan(), planHash: planHash(plan()) },
      ]),
    );
    eq(
      (await ctx.stores.planHistory.listPlanHistory()).map((e) => e.id),
      ['ph-late', 'ph-early'],
      'newest first must come from the read, not the writer',
    );
  });

  c('history: unknown id is a 404, a known one comes back whole', async (ctx) => {
    const kept = await ctx.stores.planHistory.keepPlan(plan(), 'Search winner');
    eq((await ctx.stores.planHistory.getPlanHistoryEntry(kept.id)).plan, plan(), 'entry must round-trip');
    await rejects(ctx.stores.planHistory.getPlanHistoryEntry('ph-nope'), 'unknown id', {
      instanceOf: NotFoundError,
      msgIncludes: 'Unknown plan version',
    });
  });

  c('localDayKey: the LOCAL calendar day, padded, evening not tomorrow', async () => {
    is(localDayKey(new Date(2026, 7, 20, 21, 30)), '2026-08-20', '9pm is still today locally');
    is(localDayKey(new Date(2026, 7, 20, 0, 1)), '2026-08-20', 'past-midnight is today');
    is(localDayKey(new Date(2026, 0, 5, 12, 0)), '2026-01-05', 'single digits padded');
  });

  c('planHash: identity rule — rename/description are not a different plan', async () => {
    is(planHash(plan({ name: 'Search finalist' })), planHash(plan()), 'name excluded');
    is(planHash(plan({ description: 'the one I mean' })), planHash(plan()), 'description excluded');
    const reordered: Scenario = { events: plan().events, name: 'Plan' };
    is(planHash(reordered), planHash(plan()), 'key order excluded');
    ok(planHash(plan({ autoSepp: false })) !== planHash(plan()), 'engine-read fields included');
    ok(
      planHash(plan({ assumption_overrides: { expenses: { livingMonthly: 9_000 } } })) !==
        planHash(plan()),
      'overrides included',
    );
  });

  // ----- plan history: scores ----------------------------------------------

  c('history score: absent until attached — never a zero standing in', async (ctx) => {
    const entry = await ctx.stores.planHistory.keepPlan(plan(), 'Kept');
    is(entry.score, undefined, 'fresh entry has no score');
    is(entry.scoreError, undefined, 'fresh entry has no error');
    const stored = await ctx.stores.planHistory.getPlanHistoryEntry(entry.id);
    is('score' in stored, false, 'the key itself must be absent on disk');
  });

  c('history score: attaches without touching what the entry IS', async (ctx) => {
    const entry = await ctx.stores.planHistory.keepPlan(plan(), 'Kept');
    is(await ctx.stores.planHistory.attachPlanHistoryScore(entry.id, { score: score() }), 'attached', 'attach');
    const stored = await ctx.stores.planHistory.getPlanHistoryEntry(entry.id);
    eq(stored.score, score(), 'score stored as given');
    eq(stored.plan, entry.plan, 'plan untouched');
    is(stored.takenAt, entry.takenAt, 'takenAt untouched');
    is(stored.planHash, entry.planHash, 'planHash untouched');
    is(stored.label, 'Kept', 'label untouched');
  });

  c('history score: a success clears the previous failure', async (ctx) => {
    const entry = await ctx.stores.planHistory.keepPlan(plan());
    await ctx.stores.planHistory.attachPlanHistoryScore(entry.id, { error: 'The simulation failed: worker died' });
    includes(
      (await ctx.stores.planHistory.getPlanHistoryEntry(entry.id)).scoreError ?? '',
      'worker died',
      'failure recorded',
    );
    await ctx.stores.planHistory.attachPlanHistoryScore(entry.id, { score: score() });
    const stored = await ctx.stores.planHistory.getPlanHistoryEntry(entry.id);
    is(stored.score?.success, 0.938, 'success stored');
    is(stored.scoreError, undefined, 'never a number beside a complaint about not having one');
  });

  c('history score: merges a spend figure into the score already there', async (ctx) => {
    const entry = await ctx.stores.planHistory.keepPlan(plan());
    await ctx.stores.planHistory.attachPlanHistoryScore(entry.id, { score: score() });
    is(
      await ctx.stores.planHistory.attachPlanHistorySpend(entry.id, { sustainableSpend: 118_000, sustainableSpendPaths: 2_000 }),
      true,
      'spend attach',
    );
    eq(
      (await ctx.stores.planHistory.getPlanHistoryEntry(entry.id)).score,
      { ...score(), sustainableSpend: 118_000, sustainableSpendPaths: 2_000 },
      'the two halves merged, nothing else touched',
    );
  });

  c('history score: nowhere to put a spend figure on a version with no score', async (ctx) => {
    const entry = await ctx.stores.planHistory.keepPlan(plan());
    is(
      await ctx.stores.planHistory.attachPlanHistorySpend(entry.id, { sustainableSpend: 118_000, sustainableSpendPaths: 2_000 }),
      false,
      'a spend level with no probability beside it says nothing',
    );
    is((await ctx.stores.planHistory.getPlanHistoryEntry(entry.id)).score, undefined, 'still blank');
  });

  c('history score: entry_gone rather than a throw when the entry is missing', async (ctx) => {
    is(
      await ctx.stores.planHistory.attachPlanHistoryScore('ph-nope', { score: score() }),
      'entry_gone',
      'lands from a background task nobody is watching',
    );
  });

  c('history score: refuses a second score, and says THAT — a recorded number is final', async (ctx) => {
    const entry = await ctx.stores.planHistory.keepPlan(plan(), 'Kept');
    await ctx.stores.planHistory.attachPlanHistoryScore(entry.id, { score: score() });
    is(
      await ctx.stores.planHistory.attachPlanHistoryScore(entry.id, { score: { ...score(), success: 0.5 } }),
      'already_scored',
      'a second number would make one row report two moments as one',
    );
    is(
      await ctx.stores.planHistory.attachPlanHistoryScore(entry.id, { error: 'a later run died' }),
      'already_scored',
      'a failure cannot erase a good number either',
    );
    const stored = await ctx.stores.planHistory.getPlanHistoryEntry(entry.id);
    eq(stored.score, score(), 'the recorded number survives');
    is(stored.scoreError, undefined, 'no complaint attached');
  });

  c('history score: still replaces a FAILURE — a failure records no measurement', async (ctx) => {
    const entry = await ctx.stores.planHistory.keepPlan(plan());
    await ctx.stores.planHistory.attachPlanHistoryScore(entry.id, { error: 'worker died' });
    is(
      await ctx.stores.planHistory.attachPlanHistoryScore(entry.id, { error: 'worker died again' }),
      'attached',
      'filling a blank is allowed',
    );
    is((await ctx.stores.planHistory.getPlanHistoryEntry(entry.id)).scoreError, 'worker died again', 'latest failure stands');
  });

  c('recordDayStart: files the first call of a day and refuses the rest', async (ctx) => {
    const morning = new Date(2026, 7, 20, 8, 0);
    const evening = new Date(2026, 7, 20, 22, 0);
    ok((await ctx.stores.planHistory.recordDayStart(plan(), morning)) !== null, 'first files');
    is(await ctx.stores.planHistory.recordDayStart(plan({ autoSepp: false }), evening), null, 'second refused');
    is((await ctx.stores.planHistory.listPlanHistory()).length, 1, 'one entry for the day');
  });

  c('recordDayStart: two first-edits landing together file ONE entry, not two', async (ctx) => {
    const now = new Date(2026, 7, 20, 8, 0);
    const [a, b] = await Promise.all([
      ctx.stores.planHistory.recordDayStart(plan(), now),
      ctx.stores.planHistory.recordDayStart(plan(), now),
    ]);
    is([a, b].filter((e) => e !== null).length, 1, 'the serial chain must make this impossible');
    is((await ctx.stores.planHistory.listPlanHistory()).length, 1, 'one entry on disk');
  });

  // ----- the plan file -----------------------------------------------------

  c('plan: seeds plan.json when absent — default decisions, no extra events', async (ctx) => {
    await ctx.stores.data.initDataDir();
    is(await ctx.files.exists('plan.json'), false, 'not seeded by init');
    const p = await ctx.stores.plan.loadPlan();
    eq(p.events, EXPECTED_SEEDED_EVENTS, 'exactly the four default-decision events');
    is(p.name, PLAN_NAME, 'internal constant name');
    is(p.description, undefined, 'no description');
    const raw = await ctx.files.readText('plan.json');
    ok(raw.startsWith('{\n  "'), 'pretty-printed');
    ok(raw.endsWith('\n'), 'trailing newline');
    eq(JSON.parse(raw), p, 'reads back identically');
  });

  c('plan: a second load returns the stored plan unchanged — never reseeds', async (ctx) => {
    await ctx.stores.data.initDataDir();
    await ctx.stores.plan.loadPlan();
    const edited: Scenario = {
      name: PLAN_NAME,
      events: [
        { type: 'retire', person: 'p1', date: '2029-09' },
        { type: 'one_time_expense', date: '2030-03', amount: 25000 },
      ],
    };
    await ctx.stores.plan.savePlan(edited);
    const before = await ctx.files.readText('plan.json');
    const reloaded = await ctx.stores.plan.loadPlan();
    is(await ctx.files.readText('plan.json'), before, 'byte-identical after reload');
    eq(reloaded, edited, 'the edit survives');
  });

  c('plan: round-trips save→load, pinning the internal name and stripping stray keys', async (ctx) => {
    await ctx.stores.data.initDataDir();
    const p = await ctx.stores.plan.loadPlan();
    const next: Scenario = {
      ...p,
      events: [...p.events, { type: 'state_change', date: '2034-01', state: 'sc' }],
      autoSepp: false,
      assumption_overrides: { expenses: { livingMonthly: 7200 } },
    };
    await ctx.stores.plan.savePlan(next);
    eq(await ctx.stores.plan.loadPlan(), next, 'round trip');
    await ctx.stores.plan.savePlan({ ...next, name: 'Whatever the UI sent', id: 'base-case' } as Scenario);
    const stored = JSON.parse(await ctx.files.readText('plan.json')) as Record<string, unknown>;
    is(stored.name, PLAN_NAME, 'invented name replaced by the constant');
    is('id' in stored, false, 'stray id stripped by validation');
  });

  c('plan: malformed plan.json is a helpful error naming the file, not a crash', async (ctx) => {
    await ctx.stores.data.initDataDir();
    await ctx.files.writeText('plan.json', '{ "name": "Plan", events: OOPS }');
    const err = await rejects(ctx.stores.plan.loadPlan(), 'malformed plan', {
      instanceOf: ValidationError,
      msgIncludes: 'Malformed JSON',
    });
    includes(err.message, ctx.files.describe('plan.json'), 'names the file');
    is(
      await ctx.files.readText('plan.json'),
      '{ "name": "Plan", events: OOPS }',
      'reported, never silently reseeded over the top',
    );
  });

  c('plan: schema-invalid plan.json names the file and the offending field', async (ctx) => {
    await ctx.stores.data.initDataDir();
    await ctx.files.writeText('plan.json', '{ "name": "Plan" }');
    const err = await rejects(ctx.stores.plan.loadPlan(), 'schema-invalid plan', {
      instanceOf: ValidationError,
      msgIncludes: 'Invalid plan',
    });
    includes(err.message, ctx.files.describe('plan.json'), 'names the file');
    includes(err.message, 'events', 'names the field');
  });

  c('plan: savePlan validates before writing', async (ctx) => {
    await ctx.stores.data.initDataDir();
    const invalid = {
      name: PLAN_NAME,
      events: [{ type: 'retire', person: 'p1', date: 'not-a-date' }],
    } as unknown as Scenario;
    await rejects(ctx.stores.plan.savePlan(invalid), 'invalid save', { instanceOf: ValidationError });
    is(await ctx.files.exists('plan.json'), false, 'nothing written');
  });

  // ----- the daily guard ---------------------------------------------------

  c('guard: files the pre-change plan on the first change of a day', async (ctx) => {
    const before = await startWith(ctx, [{ type: 'retire', person: 'p1', date: '2033-06' }]);
    await ctx.stores.plan.savePlan({ ...before, events: [{ type: 'retire', person: 'p1', date: '2029-06' }] }, MORNING);
    const history = await ctx.stores.planHistory.listPlanHistory();
    is(history.length, 1, 'one entry filed');
    eq(history[0].plan, before, 'the entry holds what was there BEFORE the change');
    is(history[0].kind, 'day-start', 'kind');
    is(history[0].takenAt, MORNING.toISOString(), 'stamped with the injected clock');
    is(history[0].planHash, planHash(before), 'hash of the filed plan');
    eq(
      (await ctx.stores.plan.loadPlan()).events[0],
      { type: 'retire', person: 'p1', date: '2029-06' },
      'the new plan is what the file now holds',
    );
  });

  c('guard: files nothing on the second change of the same day', async (ctx) => {
    const before = await startWith(ctx, [{ type: 'retire', person: 'p1', date: '2033-06' }]);
    await ctx.stores.plan.savePlan({ ...before, events: [{ type: 'retire', person: 'p1', date: '2029-06' }] }, MORNING);
    const afterFirst = await ctx.stores.planHistory.listPlanHistory();
    await ctx.stores.plan.savePlan({ ...before, events: [{ type: 'retire', person: 'p1', date: '2030-06' }] }, EVENING);
    await ctx.stores.plan.savePlan({ ...before, events: [{ type: 'retire', person: 'p1', date: '2031-06' }] }, EVENING);
    eq(await ctx.stores.planHistory.listPlanHistory(), afterFirst, 'one restore point, not one per edit');
  });

  c("guard: files again on the next day, holding that day's own starting point", async (ctx) => {
    const before = await startWith(ctx, [{ type: 'retire', person: 'p1', date: '2033-06' }]);
    const mondayEnd: Scenario = { ...before, events: [{ type: 'retire', person: 'p1', date: '2029-06' }] };
    await ctx.stores.plan.savePlan(mondayEnd, MORNING);
    await ctx.stores.plan.savePlan({ ...before, events: [{ type: 'retire', person: 'p1', date: '2027-06' }] }, NEXT_DAY);
    const history = await ctx.stores.planHistory.listPlanHistory();
    is(history.length, 2, 'two days, two entries');
    eq(history[0].plan, mondayEnd, "Tuesday's entry holds where Monday left off");
    eq(history[1].plan, before, "Monday's entry untouched");
  });

  c('guard: files one when the history is empty — the first change ever is the most valuable', async (ctx) => {
    await ctx.stores.data.initDataDir();
    const seeded = await ctx.stores.plan.loadPlan();
    eq(await ctx.stores.planHistory.listPlanHistory(), [], 'empty history');
    await ctx.stores.plan.savePlan({ ...seeded, events: [] }, MORNING);
    const history = await ctx.stores.planHistory.listPlanHistory();
    is(history.length, 1, 'one entry');
    eq(history[0].plan, seeded, 'holds the seeded plan');
  });

  c('guard: files nothing when the plan does not change — a no-op autosave is free', async (ctx) => {
    const p = await startWith(ctx, [{ type: 'retire', person: 'p1', date: '2033-06' }]);
    await ctx.stores.plan.savePlan(p, MORNING);
    await ctx.stores.plan.savePlan({ ...p, name: 'Whatever the UI sent' }, EVENING);
    eq(await ctx.stores.planHistory.listPlanHistory(), [], 'no entries');
  });

  c('guard: files a description-only edit, which plan IDENTITY would call no change', async (ctx) => {
    const p = await startWith(ctx, [{ type: 'retire', person: 'p1', date: '2033-06' }]);
    const noted = { ...p, description: 'Northbridge is a values call, not a solvency call.' };
    await ctx.stores.plan.savePlan(noted, MORNING);
    const history = await ctx.stores.planHistory.listPlanHistory();
    is(history.length, 1, 'the guard asks the WIDER question');
    is(history[0].plan.description, undefined, 'holds the pre-edit plan');
    is(history[0].planHash, planHash(noted), 'identity unchanged — the two questions differ');
  });

  c('guard: does not file the seeding write — no previous version to keep', async (ctx) => {
    await ctx.stores.data.initDataDir();
    await ctx.stores.plan.loadPlan();
    eq(await ctx.stores.planHistory.listPlanHistory(), [], 'seeding files nothing');
  });

  c("guard: an explicitly KEPT plan does not stand in for the day's restore point", async (ctx) => {
    const before = await startWith(ctx, [{ type: 'retire', person: 'p1', date: '2033-06' }]);
    await ctx.stores.planHistory.keepPlan({ name: 'Finalist', events: [] }, 'Search winner', EARLIER);
    await ctx.stores.plan.savePlan({ ...before, events: [] }, MORNING);
    const history = await ctx.stores.planHistory.listPlanHistory();
    eq(history.map((e) => e.kind), ['day-start', 'kept'], 'both entries, day-start on top');
    eq(history[0].plan, before, 'the day-start holds the pre-change plan');
  });

  // ----- restore -----------------------------------------------------------

  const twoVersions = async (ctx: StoreSuiteContext): Promise<{ first: Scenario; second: Scenario }> => {
    await ctx.stores.data.initDataDir();
    const first: Scenario = { name: PLAN_NAME, events: [{ type: 'retire', person: 'p1', date: '2033-06' }] };
    await writePlanFile(ctx, first);
    const second: Scenario = { name: PLAN_NAME, events: [{ type: 'retire', person: 'p1', date: '2029-06' }] };
    await ctx.stores.plan.savePlan(second, MORNING);
    return { first, second };
  };

  c('restore: makes the stored version the plan again', async (ctx) => {
    const { first } = await twoVersions(ctx);
    const [entry] = await ctx.stores.planHistory.listPlanHistory();
    const restored = await ctx.stores.plan.restorePlan(entry.id, EVENING);
    eq(restored.plan, first, 'the plan again');
    is(restored.restoredFrom.id, entry.id, 'reports its source');
    eq(await ctx.stores.plan.loadPlan(), first, 'on disk too');
  });

  c('restore: is itself undoable — the replaced version is filed like any change', async (ctx) => {
    const { first, second } = await twoVersions(ctx);
    const [entry] = await ctx.stores.planHistory.listPlanHistory();
    await ctx.stores.plan.restorePlan(entry.id, NEXT_DAY);
    const history = await ctx.stores.planHistory.listPlanHistory();
    is(history.length, 2, 'the guard filed the replaced version');
    eq(history[0].plan, second, 'what the restore replaced');
    eq(history[1].plan, first, 'the version restored, untouched');
  });

  c('restore: never mutates, consumes or reorders the entry it restores', async (ctx) => {
    const { first } = await twoVersions(ctx);
    const before = await ctx.stores.planHistory.listPlanHistory();
    await ctx.stores.plan.restorePlan(before[0].id, EVENING);
    await ctx.stores.plan.savePlan({ ...first, events: [] }, EVENING);
    const after = await ctx.stores.planHistory.listPlanHistory();
    eq(after.at(-1), before.at(-1), 'oldest entry untouched');
    ok(after.some((e) => e.id === before[0].id), 'the restored entry still exists');
  });

  c('restore: brings back the version it was ASKED for, not the newest or oldest', async (ctx) => {
    await ctx.stores.data.initDataDir();
    const versions: Scenario[] = ['2029-06', '2031-06', '2033-06'].map((date) => ({
      name: PLAN_NAME,
      events: [{ type: 'retire', person: 'p1', date } as ScenarioEvent],
    }));
    const kept = [];
    for (const [i, p] of versions.entries()) kept.push(await ctx.stores.planHistory.keepPlan(p, `v${i + 1}`));
    const target = kept[1]; // the MIDDLE one — neither end can stand in for it
    const restored = await ctx.stores.plan.restorePlan(target.id, MORNING);
    is(restored.restoredFrom.id, target.id, 'reports the asked-for id');
    eq(restored.plan, versions[1], 'restores the asked-for plan');
    eq(await ctx.stores.plan.loadPlan(), versions[1], 'on disk too');
    eq(restored.plan.events, restored.restoredFrom.plan.events, 'the banner cannot be made to lie');
  });

  c('restore: pins the plan name on the way back in, like every other save', async (ctx) => {
    await ctx.stores.data.initDataDir();
    await ctx.stores.plan.loadPlan();
    const kept = await ctx.stores.planHistory.keepPlan({ name: 'Search finalist', events: [] }, 'Rank 1');
    const restored = await ctx.stores.plan.restorePlan(kept.id, MORNING);
    is(restored.plan.name, PLAN_NAME, 'name pinned');
    is(
      (await ctx.stores.planHistory.listPlanHistory()).find((e) => e.id === kept.id)?.plan.name,
      'Search finalist',
      'the entry keeps its own name — restoring copies forward, it does not move',
    );
  });

  c('restore: an unknown version is a 404, not an empty answer', async (ctx) => {
    await ctx.stores.data.initDataDir();
    await ctx.stores.plan.loadPlan();
    await rejects(ctx.stores.plan.restorePlan('ph-nope'), 'unknown version', { instanceOf: NotFoundError });
  });

  // ----- net worth ---------------------------------------------------------

  c('resolved profile: derives holdings balances from stored quotes, manual accounts alone', async (ctx) => {
    await ctx.stores.data.initDataDir();
    await holdingsProfile(ctx);
    await ctx.stores.data.saveQuotes(QUOTES);
    const raw = await ctx.stores.data.loadProfile();
    const { profile, missing } = await ctx.stores.data.loadResolvedProfile();
    eq(missing, [], 'nothing missing');
    const ira = profile.accounts.find((a) => a.id === 'ira1')!;
    ok(Math.abs(ira.balance - IRA_DERIVED) < 1e-6, `derived balance ${ira.balance} != ${IRA_DERIVED}`);
    ok(
      Math.abs(ira.allocation.stocks - (100 * 379.04) / IRA_DERIVED) < 1e-12,
      'allocation re-derived from holdings',
    );
    for (const a of profile.accounts.filter((x) => x.id !== 'ira1')) {
      eq(a, raw.accounts.find((x) => x.id === a.id), `account ${a.id} must be exactly the stored file's`);
    }
  });

  c('resolved profile: lenient about missing quotes — stored figures survive, symbols reported', async (ctx) => {
    await ctx.stores.data.initDataDir();
    const before = await holdingsProfile(ctx);
    const storedBalance = before.accounts.find((a) => a.id === 'ira1')!.balance;
    const { profile, missing } = await ctx.stores.data.loadResolvedProfile();
    eq(missing, ['BND', 'VTI'], 'missing symbols reported');
    is(profile.accounts.find((a) => a.id === 'ira1')!.balance, storedBalance, 'stored figure survives');
  });

  c('snapshot: totals every account plus the typed home value, records the prices used', async (ctx) => {
    await ctx.stores.data.initDataDir();
    await holdingsProfile(ctx);
    await ctx.stores.data.saveQuotes(QUOTES);
    const { profile } = await ctx.stores.data.loadResolvedProfile();
    const portfolio = profile.accounts.reduce((s, a) => s + a.balance, 0);
    const snap = await ctx.stores.networth.takeSnapshot({ homeValue: 1_200_000, note: '  first look  ' });
    ok(Math.abs(snap.total - (portfolio + 1_200_000)) < 1e-6, 'total = portfolio + home');
    is(snap.homeValue, 1_200_000, 'home value as typed');
    eq(
      snap.accounts.map((a) => a.id).sort(),
      profile.accounts.map((a) => a.id).sort(),
      'every account present',
    );
    eq(
      snap.prices,
      {
        VTI: { price: 379.04, asOf: '2026-08-18T20:00:00.000Z' },
        BND: { price: 72.1, asOf: '2026-08-18T20:00:00.000Z' },
      },
      'the prices behind the derived balances, with their own asOf moments',
    );
    is(snap.note, 'first look', 'note trimmed');
    ok(/^\d{4}-\d{2}-\d{2}T/.test(snap.takenAt), 'takenAt is an ISO stamp');
  });

  c('snapshot: refuses to record when a holdings symbol has no stored quote', async (ctx) => {
    await ctx.stores.data.initDataDir();
    await holdingsProfile(ctx);
    await rejects(ctx.stores.networth.takeSnapshot({ homeValue: 1_000_000 }), 'no quotes', {
      instanceOf: ValidationError,
      msgIncludes: 'Refresh prices on the Profile tab',
    });
    eq(await ctx.stores.networth.listSnapshots(), [], 'a refused snapshot leaves no half-row behind');
  });

  c('snapshot: append-only round trip; delete removes exactly its row', async (ctx) => {
    await ctx.stores.data.initDataDir();
    await holdingsProfile(ctx);
    await ctx.stores.data.saveQuotes(QUOTES);
    const first = await ctx.stores.networth.takeSnapshot({ homeValue: 1_000_000 });
    const second = await ctx.stores.networth.takeSnapshot({ homeValue: 900_000, note: 'later' });
    const listed = await ctx.stores.networth.listSnapshots();
    eq(listed.map((s) => s.id), [first.id, second.id], 'both rows, in order');
    ok(listed[0].id !== listed[1].id, 'distinct ids');
    await ctx.stores.networth.deleteSnapshot(first.id);
    eq((await ctx.stores.networth.listSnapshots()).map((s) => s.id), [second.id], 'exactly one gone');
    await rejects(ctx.stores.networth.deleteSnapshot(first.id), 'second delete', { instanceOf: NotFoundError });
  });

  c('snapshot: a manual-only profile snapshots without any quotes at all', async (ctx) => {
    await ctx.stores.data.initDataDir();
    const snap = await ctx.stores.networth.takeSnapshot({ homeValue: 550_000 });
    const profile = await ctx.stores.data.loadProfile();
    const portfolio = profile.accounts.reduce((s, a) => s + a.balance, 0);
    ok(Math.abs(snap.total - (portfolio + 550_000)) < 1e-6, 'total without prices');
    eq(snap.prices, {}, 'no prices recorded — none priced anything');
  });

  // ----- quotes ------------------------------------------------------------

  c('parseYahooChart: reads price, currency and time from the real captured response', async (ctx) => {
    const q = parseYahooChart('VTI', ctx.vtiFixture);
    is(q.price, 379.04, 'price');
    is(q.currency, 'USD', 'currency');
    is(q.asOf, new Date(1787083200 * 1000).toISOString(), 'asOf from regularMarketTime seconds');
  });

  c("parseYahooChart: surfaces Yahoo's own error description for a bad symbol", async () => {
    const body = {
      chart: { result: null, error: { code: 'Not Found', description: 'No data found, symbol may be delisted' } },
    };
    throws(() => parseYahooChart('NOPE', body), 'yahoo verdict', 'symbol may be delisted');
  });

  c('parseYahooChart: refuses responses missing needed fields, naming the symbol', async (ctx) => {
    throws(() => parseYahooChart('VTI', {}), 'empty body', 'VTI');
    throws(
      () => parseYahooChart('VTI', fixtureWithMeta(ctx, (m) => delete m.regularMarketPrice)),
      'missing price',
      'regularMarketPrice',
    );
    throws(
      () => parseYahooChart('VTI', fixtureWithMeta(ctx, (m) => (m.regularMarketPrice = 0))),
      'zero price',
      'regularMarketPrice',
    );
    throws(() => parseYahooChart('VTI', fixtureWithMeta(ctx, (m) => delete m.currency)), 'missing currency', 'currency');
    throws(
      () => parseYahooChart('VTI', fixtureWithMeta(ctx, (m) => delete m.regularMarketTime)),
      'missing time',
      'regularMarketTime',
    );
  });

  c('fetchYahooQuote: sends the load-bearing User-Agent and parses through', async (ctx) => {
    let seenUrl = '';
    let seenUa: string | undefined;
    const fetchImpl: FetchLike = async (url, init) => {
      seenUrl = url;
      seenUa = (init.headers as Record<string, string>)['User-Agent'];
      return { ok: true, status: 200, json: async () => ctx.vtiFixture };
    };
    const q = await fetchYahooQuote('VTI', fetchImpl);
    is(q.price, 379.04, 'parsed through');
    is(seenUrl, 'https://query1.finance.yahoo.com/v8/finance/chart/VTI?interval=1d&range=1d', 'exact URL');
    is(seenUa, 'Mozilla/5.0', "Yahoo's edge 429s clients that send none — the header is not decoration");
  });

  c('fetchYahooQuote: reports an HTTP failure with its status', async () => {
    await rejects(fetchYahooQuote('VTI', fetchReturning({}, 429)), 'http failure', { msgIncludes: 'HTTP 429' });
  });

  c('fetchYahooQuote: turns the abort of a hung request into a plain-English timeout', async () => {
    const never: FetchLike = (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () =>
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
        );
      });
    await rejects(fetchYahooQuote('VTI', never, 10), 'timeout', { msgIncludes: 'Timed out fetching VTI' });
  });

  c('refreshQuotes: stores a USD quote with asOf from the exchange, fetchedAt from the clock', async (ctx) => {
    const now = (): Date => new Date('2026-08-18T21:30:00.000Z');
    const res = await ctx.stores.quotes.refreshQuotes(['VTI'], { fetchImpl: fetchReturning(ctx.vtiFixture), now });
    eq(
      res.results,
      [
        {
          symbol: 'VTI',
          ok: true,
          quote: {
            price: 379.04,
            currency: 'USD',
            asOf: new Date(1787083200 * 1000).toISOString(),
            source: 'yahoo',
            fetchedAt: '2026-08-18T21:30:00.000Z',
          },
        },
      ],
      'the per-symbol outcome',
    );
    eq(await ctx.stores.data.loadQuotes(), res.quotes, 'persisted: a fresh load sees what the result carried');
  });

  c('refreshQuotes: rejects a non-USD quote per symbol, naming the currency, storing nothing', async (ctx) => {
    const cad = fixtureWithMeta(ctx, (m) => (m.currency = 'CAD'));
    const res = await ctx.stores.quotes.refreshQuotes(['VTI'], { fetchImpl: fetchReturning(cad) });
    is(res.results[0].ok, false, 'refused');
    const failure = res.results[0] as { error: string };
    includes(failure.error, 'CAD', 'names the currency');
    includes(failure.error, 'USD-only', 'names the rule');
    eq(await ctx.stores.data.loadQuotes(), {}, 'nothing stored');
  });

  c("refreshQuotes: isolates one symbol's failure — the batch survives", async (ctx) => {
    const fetchImpl: FetchLike = async (url) => {
      if (url.includes('/GHOST?')) throw new Error('connection reset');
      return { ok: true, status: 200, json: async () => ctx.vtiFixture };
    };
    const res = await ctx.stores.quotes.refreshQuotes(['VTI', 'GHOST', 'BND'], { fetchImpl });
    eq(res.results.map((r) => r.ok), [true, false, true], 'one failed, two stored');
    eq(Object.keys(await ctx.stores.data.loadQuotes()).sort(), ['BND', 'VTI'], 'the rest are stored');
  });

  c("refreshQuotes: a failed refresh leaves the symbol's PREVIOUS quote untouched", async (ctx) => {
    await ctx.stores.quotes.refreshQuotes(['VTI'], { fetchImpl: fetchReturning(ctx.vtiFixture) });
    const res = await ctx.stores.quotes.refreshQuotes(['VTI'], { fetchImpl: fetchReturning({}, 500) });
    is(res.results[0].ok, false, 'second refresh failed');
    is((await ctx.stores.data.loadQuotes()).VTI.price, 379.04, 'stale-but-honest stored quote survives');
  });

  // ----- seeding + init ----------------------------------------------------

  c('init: seeds profile, starter reference, assumptions and runs/ — but no scenarios/', async (ctx) => {
    const { existedBefore } = await ctx.stores.data.initDataDir();
    is(existedBefore, false, 'fresh folder');
    is(
      await ctx.files.readText('profile.json'),
      await ctx.defaults.readText('profile.starter.json'),
      'profile seeded byte-for-byte from the starter',
    );
    is(await ctx.files.exists('profile.starter.json'), true, 'pristine starter alongside');
    for (const rel of [
      'assumptions/market.json',
      'assumptions/historical-returns.csv',
      'assumptions/social-security.json',
      'assumptions/medicare-2026.json',
      'assumptions/aca-2026.json',
      'assumptions/rmd-table.json',
      'assumptions/tax/federal-2026.json',
      'assumptions/tax/va-2026.json',
      'assumptions/tax/sc-2026.json',
      'assumptions/tax/nc-2026.json',
    ]) {
      is(await ctx.files.exists(rel), true, `${rel} must be seeded`);
    }
    is(await ctx.files.exists('scenarios'), false, 'one plan, not a library: no scenarios/');
    is(await ctx.files.exists('runs'), true, 'runs/ cache dir exists');
  });

  c('init: a second init never overwrites user-modified files, and reports existedBefore', async (ctx) => {
    await ctx.stores.data.initDataDir();
    const profile = await ctx.stores.data.loadProfile();
    profile.expenses.livingMonthly = 12345;
    await ctx.stores.data.saveProfile(profile);
    const p = await ctx.stores.plan.loadPlan();
    await ctx.stores.plan.savePlan({ ...p, events: [...p.events, { type: 'sell_house', date: '2035-04' }] });
    const second = await ctx.stores.data.initDataDir();
    is(second.existedBefore, true, 'recognized as initialized');
    is((await ctx.stores.data.loadProfile()).expenses.livingMonthly, 12345, 'profile edit survives');
    is((await ctx.stores.plan.loadPlan()).events.length, p.events.length + 1, 'plan edit survives');
  });

  // ----- baa-column backfill -----------------------------------------------

  /** Strip the seeded CSV back to the pre-baa 5-column format. */
  const writePreBaaCsv = async (
    ctx: StoreSuiteContext,
    mutate?: (lines: string[]) => string[],
  ): Promise<void> => {
    const seeded = await ctx.defaults.readText('assumptions/historical-returns.csv');
    let lines = seeded
      .split(/\r?\n/)
      .filter((l) => !l.trim().startsWith('#'))
      .filter((l) => l.trim().length > 0)
      .map((l) =>
        /^year\s*,/i.test(l.trim())
          ? 'year,stocks,bonds10,tbills,cpi'
          : l.split(',').slice(0, 5).join(','),
      );
    lines = ['# the user annotated this file', ...(mutate ? mutate(lines) : lines)];
    await ctx.files.mkdir('assumptions');
    await ctx.files.writeText('assumptions/historical-returns.csv', lines.join('\n'));
  };

  c('baa backfill: appends the column by year, preserving user edits and comments', async (ctx) => {
    await ctx.stores.data.initDataDir();
    await writePreBaaCsv(ctx, (lines) =>
      lines.map((l) => (l.startsWith('1928,') ? '1928,0.9999,0.0084,0.0308,-0.0116' : l)),
    );
    await ctx.stores.data.initDataDir(); // second init runs the backfill
    const healed = await ctx.files.readText('assumptions/historical-returns.csv');
    const lines = healed.split('\n');
    is(lines[0], '# the user annotated this file', 'comment verbatim');
    is(lines[1], 'year,stocks,bonds10,tbills,cpi,baa', 'header gains the column');
    is(lines[2], '1928,0.9999,0.0084,0.0308,-0.0116,0.0322', "the user's edit survives byte-for-byte, default baa appended");
  });

  c('baa backfill: idempotent — a healed 6-column file is left byte-for-byte alone', async (ctx) => {
    await ctx.stores.data.initDataDir();
    await writePreBaaCsv(ctx);
    await ctx.stores.data.initDataDir();
    const once = await ctx.files.readText('assumptions/historical-returns.csv');
    await ctx.stores.data.initDataDir();
    is(await ctx.files.readText('assumptions/historical-returns.csv'), once, 'third init changes nothing');
  });

  c('baa backfill: an unknown year leaves the file untouched — never invent a return', async (ctx) => {
    await ctx.stores.data.initDataDir();
    await writePreBaaCsv(ctx, (lines) => [...lines, '2099,0.05,0.02,0.01,0.02']);
    const before = await ctx.files.readText('assumptions/historical-returns.csv');
    await ctx.stores.data.initDataDir();
    is(await ctx.files.readText('assumptions/historical-returns.csv'), before, 'hands off, fail loudly later');
  });

  // ----- profile -----------------------------------------------------------

  c('profile: round-trips save → load exactly, pretty-printed', async (ctx) => {
    await ctx.stores.data.initDataDir();
    const profile = await ctx.stores.data.loadProfile();
    profile.expenses.livingMonthly = 9876.54;
    profile.settings.seed = 42424242;
    await ctx.stores.data.saveProfile(profile);
    eq(await ctx.stores.data.loadProfile(), profile, 'round trip');
    const raw = await ctx.files.readText('profile.json');
    ok(raw.startsWith('{\n  "'), 'pretty-printed');
    ok(raw.endsWith('\n'), 'trailing newline');
  });

  c('profile: malformed JSON produces a helpful error naming the file', async (ctx) => {
    await ctx.stores.data.initDataDir();
    await ctx.files.writeText('profile.json', '{ "people": [oops');
    const err = await rejects(ctx.stores.data.loadProfile(), 'malformed profile', {
      instanceOf: ValidationError,
      msgIncludes: 'Malformed JSON',
    });
    includes(err.message, ctx.files.describe('profile.json'), 'names the file');
  });

  c('profile: schema-invalid file produces a helpful error naming the file', async (ctx) => {
    await ctx.stores.data.initDataDir();
    await ctx.files.writeText('profile.json', '{ "people": [] }');
    const err = await rejects(ctx.stores.data.loadProfile(), 'schema-invalid profile', {
      instanceOf: ValidationError,
      msgIncludes: 'Invalid profile',
    });
    includes(err.message, ctx.files.describe('profile.json'), 'names the file');
  });

  // ----- profile migration (pure rules + the in-place load) ----------------

  c('migrateProfile: old shape migrates, live values (PIA 3180, "Alex") preserved', async () => {
    const { profile, changed } = migrateProfile(oldShapeProfile());
    ok(changed.length > 0, 'changes reported');
    const p = profile as {
      people: Array<Record<string, unknown>>;
      accounts: Array<Record<string, unknown>>;
      expenses: Record<string, unknown>;
      health: Record<string, unknown>;
      settings: { withdrawalPolicy: Record<string, unknown> };
    };
    is(p.people[0].piaMonthlyAtFraIfWorkingTo62, 3180, 'PIA copied into the working-to-62 field');
    is(p.people[0].piaMonthlyAtFraIfStoppingNow, 3180, 'PIA copied into the stopping-now field');
    is(p.people[0].name, 'Alex', 'name untouched');
    is('piaMonthlyAtFra' in p.people[0], false, 'old key deleted');
    is(p.accounts[0].name, 'k401', 'account name defaulted to id');
    is(p.accounts[0].ruleOf55Eligible, true, 'deprecated fields tolerated in place');
    eq(p.expenses, { livingMonthly: 6000, charitableMonthly: 0, investingMonthly: 0 }, 'annualBaseline split');
    is(p.health.acaBenchmarkMonthly, 1480, 'exact 1750 placeholder rewritten');
    is(p.health.employerPremiumShareMonthly, 0, 'employer share defaulted');
    ok(changed.includes('acaBenchmarkMonthly 1750→1480 (starter SLCSP benchmark)'), 'change named');
    is(p.settings.withdrawalPolicy.pretaxPreference, 'ira_first', 'rule_of_55_first → ira_first');
    const second = migrateProfile(profile);
    eq(second.changed, [], 'idempotent');
    eq(second.profile, profile, 'second pass leaves it alone');
  });

  c('migrateProfile: does NOT touch a non-placeholder ACA benchmark', async () => {
    const fixture = oldShapeProfile();
    (fixture.health as Record<string, unknown>).acaBenchmarkMonthly = 1800;
    const { profile, changed } = migrateProfile(fixture);
    is((profile as { health: Record<string, unknown> }).health.acaBenchmarkMonthly, 1800, 'only the exact 1750');
    ok(!changed.join(';').includes('acaBenchmarkMonthly'), 'no change reported for it');
  });

  c('migrateProfile: new-shape starter passes through unchanged', async (ctx) => {
    const starter = JSON.parse(await ctx.defaults.readText('profile.starter.json')) as unknown;
    const { profile, changed } = migrateProfile(starter);
    eq(changed, [], 'no changes');
    eq(profile, starter, 'untouched');
  });

  c("migrateProfile: leaves the owner's shape alone — no paired values invented (note 19)", async (ctx) => {
    const starter = JSON.parse(await ctx.defaults.readText('profile.starter.json')) as Record<string, unknown>;
    const owner = {
      ...starter,
      expenses: { livingMonthly: 8200, charitableMonthly: 2300, investingMonthly: 1250 },
    };
    const before = JSON.stringify(owner);
    const { profile, changed } = migrateProfile(owner);
    eq(changed, [], 'a pure no-op');
    is(JSON.stringify(profile), before, 'byte-identical, key order included');
    const p = profile as { expenses: Record<string, unknown>; income: Record<string, unknown> };
    for (const key of ['livingMonthlyRetired', 'investingMonthlyRetired', 'retirementGiving']) {
      is(key in p.expenses, false, `${key} must not materialize`);
    }
    for (const key of ['retirementMonthly', 'retirementIncomeTaxable']) {
      is(key in p.income, false, `${key} must not materialize`);
    }
    is(JSON.stringify(owner), before, 'the input object itself never mutated');
  });

  c('migrateProfile: carries paired values and retirement income through when SET', async (ctx) => {
    const starter = JSON.parse(await ctx.defaults.readText('profile.starter.json')) as Record<string, any>;
    const filled = {
      ...starter,
      expenses: {
        livingMonthly: 8200,
        livingMonthlyRetired: 7200,
        charitableMonthly: 2300,
        investingMonthly: 1250,
        investingMonthlyRetired: 400,
        retirementGiving: { type: 'amount', monthly: 1800 },
      },
      income: { ...starter.income, retirementMonthly: 2000, retirementIncomeTaxable: false },
    };
    const { profile, changed } = migrateProfile(filled);
    eq(changed, [], 'no normalization');
    eq(profile, filled, 'nothing rounded or dropped');
  });

  c('loadProfile: migrates old files in place — parses, saves back pretty JSON', async (ctx) => {
    await ctx.stores.data.initDataDir();
    await ctx.files.writeText('profile.json', JSON.stringify(oldShapeProfile()));
    const loaded = await ctx.stores.data.loadProfile();
    is(loaded.people[0].piaMonthlyAtFraIfWorkingTo62, 3180, 'migrated');
    is(loaded.expenses.livingMonthly, 6000, 'expenses split');
    is(loaded.health.acaBenchmarkMonthly, 1480, 'placeholder rewritten');
    is(loaded.settings.withdrawalPolicy.pretaxPreference, 'ira_first', 'policy migrated');
    const raw = await ctx.files.readText('profile.json');
    ok(raw.startsWith('{\n  "'), 'written back pretty');
    ok(!raw.includes('piaMonthlyAtFra"'), 'old key gone from disk');
    ok(!raw.includes('annualBaseline'), 'old expenses gone from disk');
    eq(migrateProfile(JSON.parse(raw)).changed, [], 'what landed is fully migrated');
    eq(await ctx.stores.data.loadProfile(), loaded, 'loading again is a no-op migration');
  });

  // ----- the giving split --------------------------------------------------

  c('giving split: migrateProfile splits the bundle into the pair it always meant', async (ctx) => {
    const { profile, changed } = migrateProfile(await legacyProfile(ctx));
    const e = (profile as { expenses: Record<string, unknown> }).expenses;
    eq(e.retirementGiving, { type: 'percent_of_growth', percent: 0.1 }, 'ongoing half');
    eq(e.untithedPot, { percent: 0.1, holdYears: 11, seedFromGains: true }, 'pot half — required fields explicit, optional absent');
    includes(changed.join(';'), "'tithe_account' → ongoing percent_of_growth + untithedPot", 'change named');
    const second = migrateProfile(profile);
    eq(second.changed, [], 'idempotent');
    eq(second.profile, profile, 'stable');
  });

  c('giving split: optional bundle fields carried only when they were present', async (ctx) => {
    const fixture = await legacyProfile(ctx);
    (fixture.expenses as Record<string, unknown>).retirementGiving = {
      type: 'tithe_account',
      percent: 0.12,
      deferYears: 5,
      seedFromExistingGains: false,
      distributeYears: 7,
      earlyRelease: false,
      allocation: { stocks: 0.6, bonds: 0.4, bills: 0 },
    };
    const { profile } = migrateProfile(fixture);
    eq(
      (profile as { expenses: Record<string, unknown> }).expenses.untithedPot,
      {
        percent: 0.12,
        holdYears: 5,
        seedFromGains: false,
        distributeYears: 7,
        earlyRelease: false,
        allocation: { stocks: 0.6, bonds: 0.4, bills: 0 },
      },
      'optional fields carried',
    );
  });

  c('giving split: a bundle override becomes ongoing + an EXPLICIT pot', async () => {
    const scenario: Record<string, any> = {
      name: 'Plan',
      events: [],
      assumption_overrides: {
        expenses: {
          retirementGiving: { type: 'tithe_account', percent: 0.08, deferYears: 0, seedFromExistingGains: true },
        },
      },
    };
    const changed = migrateScenarioGivingInPlace(scenario, { disableInheritedPot: true });
    is(changed.length, 1, 'one change');
    const e = scenario.assumption_overrides.expenses;
    eq(e.retirementGiving, { type: 'percent_of_growth', percent: 0.08 }, 'ongoing half');
    eq(e.untithedPot, { percent: 0.08, holdYears: 0, seedFromGains: true }, 'explicit, not inherited');
    eq(migrateScenarioGivingInPlace(scenario, { disableInheritedPot: true }), [], 'idempotent');
  });

  c('giving split: THE TRAP — a pre-split non-tithe override gets the explicit disable', async () => {
    const scenario: Record<string, any> = {
      name: 'Plan',
      events: [],
      assumption_overrides: { expenses: { retirementGiving: { type: 'percent_of_growth', percent: 0.1 } } },
    };
    const changed = migrateScenarioGivingInPlace(scenario, { disableInheritedPot: true });
    is(changed.length, 1, 'one change');
    eq(scenario.assumption_overrides.expenses.untithedPot, { enabled: false }, 'the disable written in');
    eq(
      scenario.assumption_overrides.expenses.retirementGiving,
      { type: 'percent_of_growth', percent: 0.1 },
      'the override itself untouched',
    );
  });

  c('giving split: the trap fires ONLY during the gated one-time pass', async () => {
    const scenario: Record<string, any> = {
      name: 'Plan',
      events: [],
      assumption_overrides: { expenses: { retirementGiving: { type: 'percent_of_growth', percent: 0.1 } } },
    };
    eq(migrateScenarioGivingInPlace(scenario, { disableInheritedPot: false }), [], 'ungated: nothing changes');
    is('untithedPot' in scenario.assumption_overrides.expenses, false, 'no disable written');
    const explicit: Record<string, any> = {
      name: 'Plan',
      events: [],
      assumption_overrides: {
        expenses: { retirementGiving: { type: 'none' }, untithedPot: { holdYears: 3 } },
      },
    };
    eq(migrateScenarioGivingInPlace(explicit, { disableInheritedPot: true }), [], 'user values always win');
    eq(explicit.assumption_overrides.expenses.untithedPot, { holdYears: 3 }, 'untouched');
  });

  c('giving split: the one-time pass sweeps profile + plan + cabinet in one ordered breath', async (ctx) => {
    await ctx.stores.data.initDataDir();
    await ctx.files.writeText('profile.json', JSON.stringify(await legacyProfile(ctx)));
    await ctx.files.writeText(
      'plan.json',
      JSON.stringify({
        name: 'Plan',
        events: [],
        assumption_overrides: { expenses: { retirementGiving: { type: 'percent_of_growth', percent: 0.1 } } },
      }),
    );
    await ctx.files.mkdir('scenarios');
    await ctx.files.writeText(
      'scenarios/bundle.json',
      JSON.stringify({
        name: 'Bundle',
        savedAt: '2026-01-01T00:00:00.000Z',
        scenario: {
          name: 'Bundle',
          events: [],
          assumption_overrides: {
            expenses: {
              retirementGiving: { type: 'tithe_account', percent: 0.08, deferYears: 2, seedFromExistingGains: false },
            },
          },
        },
      }),
    );
    await ctx.files.writeText(
      'scenarios/legacy-bare.json',
      JSON.stringify({
        name: 'Bare',
        events: [],
        assumption_overrides: { expenses: { retirementGiving: { type: 'none' } } },
      }),
    );

    const changes = await ctx.stores.data.migrateGivingSplitFiles();
    ok(changes.length >= 4, `plan + 2 cabinet files + profile, got ${changes.length}`);

    const planRaw = JSON.parse(await ctx.files.readText('plan.json')) as any;
    eq(planRaw.assumption_overrides.expenses.untithedPot, { enabled: false }, 'plan got the disable');

    const bundle = JSON.parse(await ctx.files.readText('scenarios/bundle.json')) as any;
    eq(
      bundle.scenario.assumption_overrides.expenses.retirementGiving,
      { type: 'percent_of_growth', percent: 0.08 },
      'wrapped cabinet file: ongoing half',
    );
    eq(
      bundle.scenario.assumption_overrides.expenses.untithedPot,
      { percent: 0.08, holdYears: 2, seedFromGains: false },
      'wrapped cabinet file: explicit pot',
    );

    const bare = JSON.parse(await ctx.files.readText('scenarios/legacy-bare.json')) as any;
    eq(bare.assumption_overrides.expenses.untithedPot, { enabled: false }, 'bare legacy file got the disable');

    const profileRaw = JSON.parse(await ctx.files.readText('profile.json')) as any;
    eq(profileRaw.expenses.retirementGiving, { type: 'percent_of_growth', percent: 0.1 }, 'profile migrated in the pass');
    eq(profileRaw.expenses.untithedPot, { percent: 0.1, holdYears: 11, seedFromGains: true }, 'profile pot');

    eq(await ctx.stores.data.migrateGivingSplitFiles(), [], 'a second pass is a no-op');
    await ctx.files.writeText(
      'plan.json',
      JSON.stringify({
        name: 'Plan',
        events: [],
        assumption_overrides: { expenses: { retirementGiving: { type: 'amount', monthly: 500 } } },
      }),
    );
    eq(await ctx.stores.data.migrateGivingSplitFiles(), [], 'the gate is false forever after');
    const untouched = JSON.parse(await ctx.files.readText('plan.json')) as any;
    is('untithedPot' in untouched.assumption_overrides.expenses, false, 'a new-semantics plan is never re-clobbered');
  });

  c('giving split: initDataDir runs the pass before anything is served', async (ctx) => {
    await ctx.files.mkdir('');
    await ctx.files.writeText('profile.json', JSON.stringify(await legacyProfile(ctx)));
    await ctx.files.writeText(
      'plan.json',
      JSON.stringify({
        name: 'Plan',
        events: [],
        assumption_overrides: { expenses: { retirementGiving: { type: 'percent_of_income', percent: 0.05 } } },
      }),
    );
    await ctx.stores.data.initDataDir();
    const planRaw = JSON.parse(await ctx.files.readText('plan.json')) as any;
    eq(planRaw.assumption_overrides.expenses.untithedPot, { enabled: false }, 'plan migrated at init');
    const profileRaw = JSON.parse(await ctx.files.readText('profile.json')) as any;
    eq(profileRaw.expenses.untithedPot, { percent: 0.1, holdYears: 11, seedFromGains: true }, 'profile migrated at init');
    ok(await ctx.stores.data.loadProfile(), 'what init wrote parses under the strict schemas');
    ok(await ctx.stores.plan.loadPlan(), 'plan too');
  });

  // ----- the old scenarios/ folder -----------------------------------------

  c("old scenarios/: the user's files survive init, seeding, and saves byte-identical", async (ctx) => {
    const OLD_FILES: Record<string, string> = {
      'base-case.json':
        '{\n  "name": "Base case",\n  "events": [{ "type": "retire", "person": "p1", "date": "2026-07" }]\n}\n',
      'half-finished.json': '{"name":"Half finished","events":[],"stray":true}',
    };
    await ctx.files.mkdir('scenarios');
    for (const [name, text] of Object.entries(OLD_FILES)) {
      await ctx.files.writeText(`scenarios/${name}`, text);
    }
    const expectUntouched = async (): Promise<void> => {
      const names = (await ctx.files.list('scenarios')).map((e) => e.name).sort();
      eq(names, Object.keys(OLD_FILES).sort(), 'no file added or removed');
      for (const [name, text] of Object.entries(OLD_FILES)) {
        is(await ctx.files.readText(`scenarios/${name}`), text, `${name} byte-identical`);
      }
    };
    await ctx.stores.data.initDataDir();
    await expectUntouched();
    const p = await ctx.stores.plan.loadPlan();
    await expectUntouched();
    await ctx.stores.plan.savePlan({ ...p, events: [] });
    await ctx.stores.plan.savePlan({ ...p, events: [{ type: 'sell_house', date: '2031-05' }] });
    await expectUntouched();
    await ctx.stores.data.initDataDir();
    await expectUntouched();
  });

  return cases;
}

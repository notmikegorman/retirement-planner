/**
 * Tests for the HousingPlan (src/engine/housingPlan.ts + scenario.housing).
 *
 * THE CLAIM UNDER TEST IS "THIS IS A RE-SKIN, NOT A REWRITE". A move used to be
 * three hand-written events — sell_house, rent, buy_house — and is now one
 * config object that COMPILES DOWN to exactly those three. Everything the
 * planner already trusted (the §121 exclusion, selling costs, PMI below 20%
 * down, amortization, the cash-first withdrawal order, the SPEC §9.3 sweep of
 * unspent proceeds into the brokerage) is meant to be untouched machinery.
 *
 * So the strongest test in this file is not an assertion about a number: it is
 * that a plan and its hand-written equivalent produce a BIT-IDENTICAL reference
 * path, deterministic and Monte Carlo alike (§1). If that ever stops holding,
 * the plan has grown a second housing engine and this whole design has failed.
 *
 * The rest, in order:
 *  1. equivalence — plan == hand-written events, to the last digit
 *  2. supersede — a plan DISCARDS hand-written housing events in the same
 *     scenario (merging would double-sell the house)
 *  3. absent — a scenario with no plan is byte-for-byte the PRE-PLAN engine.
 *     The digest below was computed by running the housing scenario against
 *     git HEAD (the commit before scenario.housing existed), so this is a real
 *     regression pin and not a snapshot of the code that produced it.
 *  4. compilation — the events a plan becomes, the derived purchase date
 *     (including rentMonths 0, which must emit NO rent event at all), and the
 *     engine defaults that live in code rather than in the schema
 *  5. the sale price — profile value compounded at the plan's rate over FULL
 *     years owned, hand-computed here, and not stacked on top of CPI growth
 *  6. the insurance estimate — the figure the UI shows IS the figure modelled
 *  7. CASH: a purchase above the cash on hand takes the remainder from the IRA,
 *     and one below it takes nothing
 *  8. MORTGAGE: only the down payment leaves, the rest is lived on before the
 *     IRA is touched, and 20% down avoids PMI while 10% does not
 *  9. the end-to-end case — retire mid-2027, sell, rent 12 months, buy 2028 —
 *     where the retirement year is funded by the house, not the IRA
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { runSimulation } from '../../src/engine/simulate';
import { loadHistoricalCsv } from '../../src/engine/returns';
import { annuityMonthlyPayment } from '../../src/engine/housing';
import {
  compileHousingPlan,
  estimateHomeInsuranceAnnual,
  eventsWithHousingPlan,
  planHomeGrowthRate,
  planInsuranceAnnual,
  purchaseDate,
  survivorHousingPlan,
  DEFAULT_DOWN_PCT,
  DEFAULT_MORTGAGE_RATE,
  DEFAULT_MORTGAGE_TERM_YEARS,
  HOME_INSURANCE_RATE_OF_PRICE,
} from '../../src/engine/housingPlan';
import { runSolver, scenarioWithDeath } from '../../src/engine/solvers';
import type {
  AcaData,
  Account,
  Assumptions,
  FederalTaxData,
  HousingPlan,
  MarketAssumptions,
  MedicareData,
  Profile,
  RmdTableData,
  RunResult,
  Scenario,
  ScenarioEvent,
  SocialSecurityData,
  StateTaxData,
  YearMonth,
} from '../../src/shared/types';
import marketJson from '../../data-defaults/assumptions/market.json';
import federalJson from '../../data-defaults/assumptions/tax/federal-2026.json';
import vaJson from '../../data-defaults/assumptions/tax/va-2026.json';
import scJson from '../../data-defaults/assumptions/tax/sc-2026.json';
import ncJson from '../../data-defaults/assumptions/tax/nc-2026.json';
import ssJson from '../../data-defaults/assumptions/social-security.json';
import medicareJson from '../../data-defaults/assumptions/medicare-2026.json';
import acaJson from '../../data-defaults/assumptions/aca-2026.json';
import rmdJson from '../../data-defaults/assumptions/rmd-table.json';

const historical = loadHistoricalCsv(
  readFileSync(
    new URL('../../data-defaults/assumptions/historical-returns.csv', import.meta.url),
    'utf8',
  ),
);

function assumptions(): Assumptions {
  return {
    market: marketJson as unknown as MarketAssumptions,
    historical,
    federal: federalJson as unknown as FederalTaxData,
    states: {
      va: vaJson as unknown as StateTaxData,
      sc: scJson as unknown as StateTaxData,
      nc: ncJson as unknown as StateTaxData,
    },
    socialSecurity: ssJson as unknown as SocialSecurityData,
    medicare: medicareJson as unknown as MedicareData,
    aca: acaJson as unknown as AcaData,
    rmd: rmdJson as unknown as RmdTableData,
  };
}

function run(
  profile: Profile,
  scenario: Scenario,
  over?: { mode?: 'deterministic' | 'montecarlo'; paths?: number },
): RunResult {
  return runSimulation({
    profile,
    assumptions: assumptions(),
    scenario,
    mode: over?.mode ?? 'deterministic',
    paths: over?.paths ?? 1,
    seed: 42,
  });
}

const digest = (value: unknown): string =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');

/**
 * A REFERENCE HOUSEHOLD, written INTO the test rather than read from a live
 * data folder: a test that reads the data folder starts failing the day
 * someone edits a balance. The point of these numbers is the SHAPE of the
 * problem they describe — a seven-figure IRA against a five-figure pile of
 * liquid money and a house worth more than either — not that they are anyone's
 * balances.
 */
function referenceProfile(): Profile {
  return {
    people: [
      {
        id: 'p1',
        name: 'Owner',
        birthYear: 1971,
        birthMonth: 6,
        piaMonthlyAtFraIfWorkingTo62: 3320,
        piaMonthlyAtFraIfStoppingNow: 3180,
        hasOwnBenefit: true,
      },
      {
        id: 'p2',
        name: 'Spouse',
        birthYear: 1971,
        birthMonth: 6,
        piaMonthlyAtFraIfWorkingTo62: 0,
        piaMonthlyAtFraIfStoppingNow: 0,
        hasOwnBenefit: false,
      },
    ],
    filing: { status: 'mfj', state: 'va' },
    accounts: [
      {
        id: 'k401',
        name: '401(k)',
        type: '401k',
        owner: 'p1',
        balance: 162400,
        lifetimeContributions: 80000,
        allocation: { stocks: 0.68, bonds: 0.32, bills: 0 },
        currentEmployer: true,
      },
      {
        id: 'ira1',
        name: 'IRA',
        type: 'traditional_ira',
        owner: 'p1',
        balance: 1985000,
        lifetimeContributions: 430000,
        allocation: { stocks: 1, bonds: 0, bills: 0 },
      },
      {
        id: 'roth1',
        name: 'Roth IRA',
        type: 'roth_ira',
        owner: 'p2',
        balance: 96200,
        lifetimeContributions: 49488,
        allocation: { stocks: 1, bonds: 0, bills: 0 },
        rothBasis: { contributions: 49486, conversions: [] },
      },
      {
        id: 'brokerage',
        name: 'Brokerage',
        type: 'taxable_brokerage',
        owner: 'p1',
        balance: 71500,
        costBasis: 56800,
        allocation: { stocks: 1, bonds: 0, bills: 0 },
      },
      {
        id: 'savings',
        name: 'Savings',
        type: 'savings',
        owner: 'p1',
        balance: 31400,
        allocation: { stocks: 0, bonds: 0, bills: 1 },
      },
    ],
    home: {
      value: 1200000,
      costBasis: 860000,
      state: 'va',
      propertyTaxAnnual: 10400,
      insuranceAnnual: 2070,
      maintenancePctOfValue: 0.01,
      sellingCostPct: 0.06,
      mortgage: null,
    },
    income: { salaries: { p1: 265000, p2: 0 }, contribution401k: 23500, employerMatch401k: 14800 },
    expenses: {
      livingMonthly: 7100,
      charitableMonthly: 2300,
      investingMonthly: 1250,
      retirementGiving: { type: 'percent_of_growth', percent: 0.1 },
    },
    health: {
      acaBenchmarkMonthly: 1572,
      acaQuoteYear: 2026,
      partDPlanMonthly: 45,
      employerPremiumShareMonthly: 0,
    },
    settings: {
      horizonAge: 90,
      successTarget: 0.85,
      mcPathsInteractive: 1000,
      mcPathsFinal: 10000,
      seed: 20260812,
      spendingPolicy: { type: 'fixed_real' },
      withdrawalPolicy: {
        order: ['cash', 'taxable', 'pretax', 'roth'],
        pretaxPreference: 'ira_first',
      },
    },
  };
}

/** Retire and claim, the parts of the plan that are not the move. */
const OWNER_EVENTS: ScenarioEvent[] = [
  { type: 'retire', person: 'p1', date: '2027-06' },
  { type: 'retire', person: 'p2', date: '2027-06' },
  { type: 'claim_social_security', person: 'p1', date: '2038-06' },
  { type: 'claim_social_security', person: 'p2', date: '2038-06' },
];

/**
 * A household with no income, no health premiums and (unless a test says
 * otherwise) a home whose only interesting property is its value: every
 * carrying-cost percentage is 0, so a figure that appears in a housing row got
 * there from the plan and nowhere else.
 */
function toyProfile(p: {
  accounts: Account[];
  annualLiving: number;
  horizonAge: number;
  home?: Partial<Profile['home']>;
}): Profile {
  const person = (id: string) => ({
    id,
    name: id.toUpperCase(),
    birthYear: 1971,
    birthMonth: 6,
    piaMonthlyAtFraIfWorkingTo62: 0,
    piaMonthlyAtFraIfStoppingNow: 0,
    hasOwnBenefit: false,
  });
  return {
    people: [person('p1'), person('p2')],
    filing: { status: 'mfj', state: 'va' },
    accounts: p.accounts,
    home: {
      value: 1000000,
      costBasis: 1000000,
      state: 'va',
      propertyTaxAnnual: 0,
      insuranceAnnual: 0,
      maintenancePctOfValue: 0,
      sellingCostPct: 0,
      mortgage: null,
      ...p.home,
    },
    income: { salaries: { p1: 0, p2: 0 }, contribution401k: 0, employerMatch401k: 0 },
    expenses: { livingMonthly: p.annualLiving / 12, charitableMonthly: 0, investingMonthly: 0 },
    health: {
      acaBenchmarkMonthly: 0,
      acaQuoteYear: 2026,
      partDPlanMonthly: 0,
      employerPremiumShareMonthly: 0,
    },
    settings: {
      horizonAge: p.horizonAge,
      successTarget: 0.85,
      mcPathsInteractive: 1000,
      mcPathsFinal: 10000,
      seed: 1,
      spendingPolicy: { type: 'fixed_real' },
      withdrawalPolicy: {
        order: ['cash', 'taxable', 'pretax', 'roth'],
        pretaxPreference: 'ira_first',
      },
    },
  };
}

const savings = (balance: number): Account => ({
  id: 'savings',
  name: 'Savings',
  type: 'savings',
  owner: 'p1',
  balance,
  allocation: { stocks: 0, bonds: 0, bills: 1 },
});
const brokerage = (balance: number): Account => ({
  id: 'brokerage',
  name: 'Brokerage',
  type: 'taxable_brokerage',
  owner: 'p1',
  balance,
  costBasis: balance,
  // Bills: interest is DISTRIBUTED as cash and the price stays flat, so the
  // balance moves only when money is put in or taken out. That is what lets the
  // §9.3 sweep below be asserted to the cent.
  allocation: { stocks: 0, bonds: 0, bills: 1 },
});
const ira = (balance: number): Account => ({
  id: 'ira',
  name: 'IRA',
  type: 'traditional_ira',
  owner: 'p1',
  balance,
  allocation: { stocks: 0, bonds: 0, bills: 1 },
});
const roth = (balance: number): Account => ({
  id: 'roth',
  name: 'Roth IRA',
  type: 'roth_ira',
  owner: 'p1',
  balance,
  allocation: { stocks: 0, bonds: 0, bills: 1 },
  rothBasis: { contributions: balance, conversions: [] },
});

// ---------------------------------------------------------------------------
// 1. Equivalence: the plan IS the three events
// ---------------------------------------------------------------------------

describe('a housing plan behaves exactly like the events it compiles to', () => {
  /*
   * The same move stated twice. The plan carries no `appreciationRate`, which
   * is deliberate: an override would change the home's growth rate and the two
   * scenarios would no longer be describing the same thing. Everything else is
   * matched by hand — insurance 1,980 is the estimate the plan will compute
   * (0.22% x 900,000), and the purchase date is the sale month plus 12 rental
   * months.
   */
  const plan: HousingPlan = {
    sellDate: '2027-06',
    rentMonths: 12,
    rentMonthly: 3000,
    purchasePrice: 900000,
    propertyTaxAnnual: 7500,
    financing: { type: 'cash' },
  };
  const planScenario: Scenario = { name: 'move', housing: plan, events: OWNER_EVENTS };
  const handWritten: Scenario = {
    name: 'move',
    events: [
      ...OWNER_EVENTS,
      { type: 'sell_house', date: '2027-06' },
      { type: 'rent', start: '2027-06', months: 12, monthlyCost: 3000 },
      {
        type: 'buy_house',
        date: '2028-06',
        price: 900000,
        financing: 'cash',
        propertyTaxAnnual: 7500,
        insuranceAnnual: 1980,
      },
    ],
  };

  it('produces a bit-identical reference path in deterministic mode', () => {
    const fromPlan = run(referenceProfile(), planScenario);
    const fromEvents = run(referenceProfile(), handWritten);

    // Not "close": identical. Every year, every account, every tax line, and
    // the eventsFired labels in the same order.
    expect(digest(fromPlan.referencePath)).toBe(digest(fromEvents.referencePath));
    expect(fromPlan.medianTerminalReal).toBe(fromEvents.medianTerminalReal);
    expect(fromPlan.success).toBe(fromEvents.success);
    expect(digest(fromPlan.charitableLegacy)).toBe(digest(fromEvents.charitableLegacy));

    // Sanity that the fixture is actually exercising the move rather than
    // agreeing about an empty run.
    const sale = fromPlan.referencePath.find((r) => r.housing.saleProceeds > 0)!;
    expect(sale.year).toBe(2027);
    expect(fromPlan.referencePath[2].eventsFired).toContain('buy_house');
  });

  it('produces an identical Monte Carlo fan too (the plan changes no per-path behaviour)', () => {
    const fromPlan = run(referenceProfile(), planScenario, { mode: 'montecarlo', paths: 40 });
    const fromEvents = run(referenceProfile(), handWritten, { mode: 'montecarlo', paths: 40 });
    expect(digest(fromPlan.fan)).toBe(digest(fromEvents.fan));
    expect(fromPlan.success).toBe(fromEvents.success);
  });

  it('is nonetheless a DIFFERENT cache key — same answer, different input', () => {
    // The two scenarios are not the same document, so they must not collide in
    // the run cache; the identical numbers above are a property of the engine,
    // not of the hash.
    const fromPlan = run(referenceProfile(), planScenario);
    const fromEvents = run(referenceProfile(), handWritten);
    expect(fromPlan.meta.hashes.scenario).not.toBe(fromEvents.meta.hashes.scenario);
    expect(fromPlan.meta.runKey).not.toBe(fromEvents.meta.runKey);
  });
});

// ---------------------------------------------------------------------------
// 2. Supersede
// ---------------------------------------------------------------------------

describe('a housing plan supersedes hand-written housing events', () => {
  const plan: HousingPlan = {
    sellDate: '2027-06',
    rentMonths: 12,
    rentMonthly: 3000,
    purchasePrice: 900000,
    propertyTaxAnnual: 7500,
    financing: { type: 'cash' },
  };
  /** Leftovers that contradict the plan in every field they share. */
  const leftovers: ScenarioEvent[] = [
    { type: 'sell_house', date: '2031-01' },
    { type: 'rent', start: '2031-01', months: 60, monthlyCost: 9000 },
    {
      type: 'buy_house',
      date: '2036-01',
      price: 2500000,
      financing: { downPct: 0.05, rate: 0.09, termYears: 15 },
      propertyTaxAnnual: 40000,
      insuranceAnnual: 30000,
    },
  ];

  it('drops them entirely: the run equals the plan on its own', () => {
    const planOnly = run(referenceProfile(), { name: 'move', housing: plan, events: OWNER_EVENTS });
    const withLeftovers = run(referenceProfile(), {
      name: 'move',
      housing: plan,
      events: [...OWNER_EVENTS, ...leftovers],
    });
    expect(digest(withLeftovers.referencePath)).toBe(digest(planOnly.referencePath));
  });

  it('sells once and buys once — no double sale, no second house', () => {
    const res = run(referenceProfile(), {
      name: 'move',
      housing: plan,
      events: [...OWNER_EVENTS, ...leftovers],
    });
    const saleYears = res.referencePath.filter((r) => r.housing.saleProceeds > 0).map((r) => r.year);
    expect(saleYears).toEqual([2027]);
    // The labels come from the compiled events only: one sell_house, one rent,
    // one buy_house across the whole run, and the leftovers' 2031/2036 dates
    // never appear.
    const fired = res.referencePath.flatMap((r) => r.eventsFired);
    expect(fired.filter((f) => f === 'sell_house')).toHaveLength(1);
    expect(fired.filter((f) => f === 'rent')).toHaveLength(1);
    expect(fired.filter((f) => f === 'buy_house')).toHaveLength(1);
    expect(res.referencePath.find((r) => r.year === 2031)!.housing.rent).toBe(0);
  });

  it('keeps every non-housing event the scenario carries', () => {
    // Supersede means "the plan owns the move", not "the plan owns the
    // scenario": a retirement, a state change or an allocation event sitting
    // next to leftover housing events must survive the purge.
    const events: ScenarioEvent[] = [
      ...OWNER_EVENTS,
      { type: 'state_change', date: '2029-01', state: 'sc' },
      ...leftovers,
    ];
    const kept = eventsWithHousingPlan(events, plan);
    expect(kept.filter((e) => e.type === 'state_change')).toHaveLength(1);
    expect(kept.filter((e) => e.type === 'retire')).toHaveLength(2);
    expect(kept.filter((e) => e.type === 'claim_social_security')).toHaveLength(2);
    // ...and the survivors keep their original relative order, with the
    // compiled move appended after them.
    expect(kept.slice(0, 5)).toEqual(events.slice(0, 5));
    expect(kept.slice(5).map((e) => e.type)).toEqual(['sell_house', 'rent', 'buy_house']);
  });
});

// ---------------------------------------------------------------------------
// 3. Absent plan: the pre-plan engine, byte for byte
// ---------------------------------------------------------------------------

describe('with no housing plan, hand-written moves are untouched', () => {
  it('returns the scenario’s own event array, by reference', () => {
    // Reference equality, not deep equality: the absent-plan path must not even
    // allocate, let alone reorder or rewrite.
    const events: ScenarioEvent[] = [
      ...OWNER_EVENTS,
      { type: 'sell_house', date: '2027-06' },
      { type: 'rent', start: '2027-06', months: 12, monthlyCost: 3000 },
    ];
    expect(eventsWithHousingPlan(events, undefined)).toBe(events);
    expect(planHomeGrowthRate(undefined)).toBeNull();
  });

  it('reproduces the PRE-PLAN engine to the byte on a hand-written-events plan shape', () => {
    /*
     * The digest below was produced by running this exact fixture against git
     * HEAD — the commit BEFORE scenario.housing existed — so it is a genuine
     * before/after pin rather than a snapshot of whatever the current code
     * happens to do.
     *
     * The pin below moved ONCE, when the de-personalisation pass rebased this
     * fixture's balances and home value from one real household's to invented
     * ones. The input changed; the engine did not (it changed only inside
     * comments, and every golden digest passed unchanged under the edited
     * engine before any fixture was touched). If it moves again, find out why.
     *
     * The fixture is the hand-written-events plan shape: retire and claim, a 2026
     * allocation change, and the move written the old way with a
     * `price: 'sale_proceeds'` cash purchase. It is the file he is running
     * today, and it has to keep producing the same answer until he chooses to
     * convert it.
     *
     * If this fails, something changed a run that has no housing plan in it.
     * Do not re-pin it without finding out what.
     *
     * RE-PINNED ONCE, deliberately: savings cash gained a configurable yield,
     * and in a sale year the proceeds now earn interest for the months they are
     * actually held (a June sale of $1.2M previously earned nothing all year).
     * That is an engine-wide change reaching a no-housing-plan path, so this
     * digest moved for a reason with nothing to do with housing — which is
     * exactly what this pin exists to make someone explain rather than wave
     * through.
     */
    const scenario: Scenario = {
      name: 'hand-written move',
      events: [
        ...OWNER_EVENTS,
        { type: 'allocation_change', date: '2026-06', mix: { stocks: 0.6, bonds: 0.4, bills: 0 } },
        { type: 'sell_house', date: '2027-06' },
        { type: 'rent', start: '2027-06', months: 12, monthlyCost: 3000 },
        {
          type: 'buy_house',
          date: '2028-06',
          price: 'sale_proceeds',
          financing: 'cash',
          propertyTaxAnnual: 7500,
          insuranceAnnual: 1850,
        },
      ],
    };
    const res = run(referenceProfile(), scenario);
    expect(res.referencePath).toHaveLength(36); // 2026..2061 (horizon age 90)
    expect(
      digest({
        referencePath: res.referencePath,
        success: res.success,
        medianTerminalReal: res.medianTerminalReal,
        fan: res.fan,
        charitableLegacy: res.charitableLegacy,
        worstDecileShortfallYears: res.worstDecileShortfallYears,
      }),
      'a scenario with NO housing plan changed its numbers — the plan work was ' +
        'supposed to leave that path bit-for-bit alone',
    ).toBe('fdefc764419b19bf72035cd4b6128c73241ea04d12fa4642fb228aaa00b8e155');
  });
});

// ---------------------------------------------------------------------------
// 4. Compilation: the events a plan becomes
// ---------------------------------------------------------------------------

describe('compiling a plan into events', () => {
  const base: HousingPlan = {
    sellDate: '2027-06',
    rentMonths: 12,
    rentMonthly: 3000,
    purchasePrice: 900000,
    propertyTaxAnnual: 7500,
    financing: { type: 'mortgage' },
  };

  it('emits sell, rent and buy — with the mortgage defaults filled in from code', () => {
    // The defaults deliberately do NOT live in the zod schema: putting them
    // there would freeze today's 6.67% PMMS rate into every file the moment it
    // was saved. So an absent field must arrive here, not at parse time.
    expect(compileHousingPlan(base)).toEqual([
      { type: 'sell_house', date: '2027-06' },
      { type: 'rent', start: '2027-06', months: 12, monthlyCost: 3000 },
      {
        type: 'buy_house',
        date: '2028-06',
        price: 900000,
        financing: {
          downPct: DEFAULT_DOWN_PCT,
          rate: DEFAULT_MORTGAGE_RATE,
          termYears: DEFAULT_MORTGAGE_TERM_YEARS,
        },
        propertyTaxAnnual: 7500,
        insuranceAnnual: 1980, // 0.22% x 900,000
      },
    ]);
    expect(DEFAULT_DOWN_PCT).toBe(0.2); // the conventional no-PMI line
    expect(DEFAULT_MORTGAGE_TERM_YEARS).toBe(30);
  });

  it('honours the financing fields a plan does name', () => {
    const [, , buy] = compileHousingPlan({
      ...base,
      financing: { type: 'mortgage', downPct: 0.1, rate: 0.055, termYears: 15 },
    });
    expect(buy).toMatchObject({
      type: 'buy_house',
      financing: { downPct: 0.1, rate: 0.055, termYears: 15 },
    });
  });

  it('states a PRICE, never “sale_proceeds”', () => {
    // A user chooses what house to buy; whether the money is there is the
    // withdrawal solver's problem. (This is also the one behavioural difference
    // from his current plan.json, which prices the purchase at the proceeds —
    // see the end-to-end tests below.)
    const [, , buy] = compileHousingPlan({ ...base, financing: { type: 'cash' } });
    expect(buy).toMatchObject({ type: 'buy_house', price: 900000, financing: 'cash' });
  });

  it('derives the purchase date as sale month + rental months', () => {
    expect(purchaseDate({ ...base, sellDate: '2027-06', rentMonths: 12 })).toBe('2028-06');
    expect(purchaseDate({ ...base, sellDate: '2027-06', rentMonths: 7 })).toBe('2028-01');
    expect(purchaseDate({ ...base, sellDate: '2027-12', rentMonths: 1 })).toBe('2028-01');
    expect(purchaseDate({ ...base, sellDate: '2027-06', rentMonths: 24 })).toBe('2029-06');
    // Zero months = buy in the month you sell.
    expect(purchaseDate({ ...base, sellDate: '2027-06', rentMonths: 0 })).toBe('2027-06');
  });

  it('emits NO rent event when rentMonths is 0', () => {
    // A zero-month rent event would still land in the year's eventsFired list
    // and claim the household moved into a rental it never had.
    const events = compileHousingPlan({ ...base, rentMonths: 0 });
    expect(events.map((e) => e.type)).toEqual(['sell_house', 'buy_house']);
    expect(events[1]).toMatchObject({ date: '2027-06' });
  });

  it('carries that through the engine: same-month sale and purchase, no rent', () => {
    const profile = toyProfile({
      accounts: [savings(100000), ira(1500000)],
      annualLiving: 60000,
      horizonAge: 58, // 2026..2029
    });
    const res = run(profile, {
      name: 'sell-and-buy-same-month',
      housing: {
        sellDate: '2027-06',
        appreciationRate: 0,
        rentMonths: 0,
        rentMonthly: 0,
        purchasePrice: 900000,
        propertyTaxAnnual: 0,
        insuranceAnnual: 0,
        financing: { type: 'cash' },
      },
      events: [],
    });
    const y2027 = res.referencePath[1];
    expect(y2027.eventsFired).toEqual(['sell_house', 'buy_house']);
    expect(res.referencePath.every((r) => r.housing.rent === 0)).toBe(true);
  });

  it('leaves the engine’s own home growth alone unless the plan names a rate', () => {
    expect(planHomeGrowthRate({ ...base })).toBeNull();
    expect(planHomeGrowthRate({ ...base, appreciationRate: 0.03 })).toBe(0.03);
    // 0 is a rate, not an absence: "assume the house does not appreciate".
    expect(planHomeGrowthRate({ ...base, appreciationRate: 0 })).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 5. The sale price
// ---------------------------------------------------------------------------

describe('the projected sale price', () => {
  /**
   * Home 1,200,000 (basis 860,000, 6% selling costs), sold June 2029 with a
   * 3%/yr plan rate. The simulation starts in 2026 and the housing module
   * appreciates at the end of every FULL year of ownership — the sale year
   * itself does not appreciate — so the exponent is 2029 - 2026 = 3:
   *
   *   2026 end  1,200,000 x 1.03           = 1,236,000
   *   2027 end  1,236,000 x 1.03           = 1,273,080
   *   2028 end  1,273,080 x 1.03           = 1,311,272.40
   *   2029 sale 1,311,272.40 x (1 - 0.06)  = 1,232,596.056
   *
   * (Gain over the 860,000 basis is 372,596.06, comfortably inside the §121
   * exclusion, so no LTCG muddies the figure.)
   */
  const profile = () =>
    toyProfile({
      accounts: [savings(100000), ira(1500000)],
      annualLiving: 60000,
      horizonAge: 59, // 2026..2030, one year past the sale
      home: { value: 1200000, costBasis: 860000, sellingCostPct: 0.06 },
    });
  const plan = (appreciationRate?: number): HousingPlan => ({
    sellDate: '2029-06',
    ...(appreciationRate === undefined ? {} : { appreciationRate }),
    rentMonths: 0,
    rentMonthly: 0,
    purchasePrice: 500000,
    propertyTaxAnnual: 0,
    insuranceAnnual: 0,
    financing: { type: 'cash' },
  });

  it('is the profile value compounded at the plan’s rate over full years owned', () => {
    const rows = run(profile(), { name: 'apprec', housing: plan(0.03), events: [] }).referencePath;
    expect(rows[0].housing.homeValue).toBeCloseTo(1236000, 6);
    expect(rows[1].housing.homeValue).toBeCloseTo(1273080, 6);
    expect(rows[2].housing.homeValue).toBeCloseTo(1311272.4, 6);
    expect(rows[3].housing.saleProceeds).toBeCloseTo(1232596.056, 6);
    // The closed form the UI is allowed to show next to the field:
    expect(rows[3].housing.saleProceeds).toBeCloseTo(1200000 * 1.03 ** 3 * 0.94, 6);
  });

  it('REPLACES the CPI-linked growth instead of compounding on top of it', () => {
    // Without an override the home grows at CPI (2.5%) + homeAppreciationRealSpread
    // (0 in the shipped market file): 1,200,000 x 1.025^3 x 0.94 = 1,214,732.63.
    // A stacked rate would be (1.03 x 1.025)^3 = 1,412,097 before costs —
    // more than 85,000 of growth the household never had.
    const rows = run(profile(), { name: 'no-override', housing: plan(), events: [] }).referencePath;
    expect(rows[0].housing.homeValue).toBeCloseTo(1230000, 6);
    expect(rows[3].housing.saleProceeds).toBeCloseTo(1200000 * 1.025 ** 3 * 0.94, 6);

    const stacked = 1200000 * (1.03 * 1.025) ** 3 * 0.94;
    const overridden = run(profile(), { name: 'apprec', housing: plan(0.03), events: [] })
      .referencePath[3].housing.saleProceeds;
    expect(overridden).toBeLessThan(stacked - 85000);
  });

  it('governs the replacement house too — one rate for the whole run', () => {
    // Bought for 500,000 in the sale month (rentMonths 0), so it starts growing
    // the following year: 500,000 x 1.03 = 515,000 at the end of 2030.
    const rows = run(profile(), { name: 'apprec', housing: plan(0.03), events: [] }).referencePath;
    expect(rows[3].housing.homeValue).toBeCloseTo(500000, 6);
    expect(rows[4].housing.homeValue).toBeCloseTo(515000, 6);
    // ...where the un-overridden run would have used CPI on the new house too.
    const cpiRows = run(profile(), { name: 'no-override', housing: plan(), events: [] }).referencePath;
    expect(cpiRows[4].housing.homeValue).toBeCloseTo(512500, 6);
  });
});

// ---------------------------------------------------------------------------
// 6. The insurance estimate
// ---------------------------------------------------------------------------

describe('the homeowners-insurance estimate', () => {
  it('is 0.22% of the purchase price, rounded to whole dollars', () => {
    expect(HOME_INSURANCE_RATE_OF_PRICE).toBe(0.0022);
    expect(estimateHomeInsuranceAnnual(900000)).toBe(1980);
    // The calibrating quote is the 900,000 case above: a real policy on an
    // inland risk came to 1,950/yr, 0.217% of value, which is what makes 0.22%
    // defensible rather than invented (see HOME_INSURANCE_RATE_OF_PRICE).
    expect(estimateHomeInsuranceAnnual(1200000)).toBe(2640);
    // Rounded, so the displayed figure and the modelled figure are the same
    // number rather than merely close: 999,999 x 0.0022 = 2,199.9978.
    expect(estimateHomeInsuranceAnnual(999999)).toBe(2200);
    expect(estimateHomeInsuranceAnnual(0)).toBe(0);
    expect(estimateHomeInsuranceAnnual(-5)).toBe(0);
  });

  it('yields to an explicit premium when the plan carries a real quote', () => {
    const plan: HousingPlan = {
      sellDate: '2027-06',
      rentMonths: 0,
      rentMonthly: 0,
      purchasePrice: 900000,
      propertyTaxAnnual: 7500,
      financing: { type: 'cash' },
    };
    expect(planInsuranceAnnual(plan)).toBe(1980);
    expect(planInsuranceAnnual({ ...plan, insuranceAnnual: 3125 })).toBe(3125);
    // 0 is a quote, not an absence (a paid-up policy, or a household modelling
    // insurance elsewhere).
    expect(planInsuranceAnnual({ ...plan, insuranceAnnual: 0 })).toBe(0);
  });

  it('is exactly what the engine charges in the purchase year', () => {
    // Bought June 2028 after a 2027 sale, so the year carries (13 - 6)/12 of the
    // annual figures and nothing from the old house:
    //   insurance    1,980 x 7/12 = 1,155
    //   property tax 7,500 x 7/12 = 4,375
    const res = run(referenceProfile(), {
      name: 'move',
      housing: {
        sellDate: '2027-06',
        rentMonths: 12,
        rentMonthly: 3000,
        purchasePrice: 900000,
        propertyTaxAnnual: 7500,
        financing: { type: 'cash' },
      },
      events: OWNER_EVENTS,
    });
    const purchaseYear = res.referencePath[2];
    expect(purchaseYear.eventsFired).toContain('buy_house');
    expect(purchaseYear.housing.insurance).toBeCloseTo((1980 * 7) / 12, 8);
    expect(purchaseYear.housing.propertyTax).toBeCloseTo((7500 * 7) / 12, 8);
  });
});

// ---------------------------------------------------------------------------
// 7. Cash
// ---------------------------------------------------------------------------

describe('a CASH purchase spends the cash first and the IRA only for the rest', () => {
  /*
   * Savings 100,000, IRA 1,500,000, Roth 100,000; living 60,000/yr; a
   * 1,000,000 house sold June 2027 with 0% selling costs and the plan's
   * appreciation pinned to 0, so the proceeds are exactly 1,000,000 and every
   * figure below is hand-checkable.
   *
   * 2026: interest 100,000 x 0.030125 = 3,012.50 (distributed, never
   *   compounded), tax 0, cash draw 60,000 - 3,012.50 = 56,987.50,
   *   savings end 43,012.50.
   * 2027: the proceeds land in savings -> 1,043,012.50 available.
   */
  const profile = () =>
    toyProfile({
      accounts: [savings(100000), ira(1500000), roth(100000)],
      annualLiving: 60000,
      horizonAge: 58, // 2026..2029
    });
  const plan = (purchasePrice: number): HousingPlan => ({
    sellDate: '2027-06',
    appreciationRate: 0,
    rentMonths: 0,
    rentMonthly: 0,
    purchasePrice,
    propertyTaxAnnual: 0,
    insuranceAnnual: 0,
    financing: { type: 'cash' },
  });

  it('takes nothing from the IRA when the cash covers the price', () => {
    const rows = run(profile(), { name: 'cash-affordable', housing: plan(900000), events: [] })
      .referencePath;
    expect(rows[0].balances.byAccount['savings']).toBeCloseTo(43012.5, 6);
    expect(rows[1].housing.saleProceeds).toBe(1000000);
    expect(rows[1].withdrawals.pretax).toBe(0);
    expect(rows[1].withdrawals.roth).toBe(0);
    expect(rows[1].balances.byAccount['savings']).toBeGreaterThan(0);
    expect(rows[1].balances.byAccount['ira']).toBeGreaterThan(1500000); // untouched, still growing
  });

  it('drains the cash, then the IRA, when the price is above it', () => {
    const rows = run(profile(), { name: 'cash-stretch', housing: plan(1400000), events: [] })
      .referencePath;
    const buyYear = rows[1];

    // Every dollar of savings — the 43,012.50 carried in plus the 1,000,000 of
    // proceeds — goes first.
    expect(buyYear.withdrawals.cash).toBeCloseTo(43012.5 + 1000000, 6);
    expect(buyYear.balances.byAccount['savings']).toBeCloseTo(0, 6);

    // The remainder comes from the IRA. It is BIGGER than the arithmetic
    // shortfall (1,400,000 + the year's living - the cash above) because the
    // withdrawal has to carry its own income tax and, at 56, the 10% early
    // withdrawal penalty.
    const shortfall = 1400000 - buyYear.withdrawals.cash;
    expect(buyYear.withdrawals.pretax).toBeGreaterThan(shortfall);
    expect(buyYear.withdrawals.penaltyBase).toBeGreaterThan(0);
    expect(buyYear.flags).toContain('penalty');

    // The Roth sits behind the IRA in the withdrawal order and is never reached.
    expect(buyYear.withdrawals.roth).toBe(0);
    expect(buyYear.balances.byAccount['roth']).toBeGreaterThan(100000);

    // The house is real: the purchase outflow bought equity, it was not spent.
    expect(buyYear.housing.homeValue).toBe(1400000);
  });
});

// ---------------------------------------------------------------------------
// 8. Mortgage
// ---------------------------------------------------------------------------

describe('a MORTGAGE purchase leaves the rest of the proceeds to live on', () => {
  /*
   * Savings 120,000, brokerage 1,000, IRA 1,500,000; living 60,000/yr; a
   * 1,000,000 house (0% selling costs, appreciation pinned to 0) sold June
   * 2027, 12 months of rent at 2,000, then an 800,000 house bought June 2028.
   * Horizon age 62 -> 2026..2033.
   *
   * At 20% down the purchase takes 160,000 out of the household and leaves
   * 1,000,000 - 160,000 = 840,000 of proceeds, which SPEC §9.3 moves from
   * savings into the brokerage. Everything in the brokerage is in bills, whose
   * interest is distributed rather than compounded, so its balance moves only
   * by draws — which makes the sweep assertable to the cent.
   */
  const profile = () =>
    toyProfile({
      accounts: [savings(120000), brokerage(1000), ira(1500000)],
      annualLiving: 60000,
      horizonAge: 62,
    });
  const plan = (downPct?: number): HousingPlan => ({
    sellDate: '2027-06',
    appreciationRate: 0,
    rentMonths: 12,
    rentMonthly: 2000,
    purchasePrice: 800000,
    propertyTaxAnnual: 0,
    insuranceAnnual: 6000,
    financing: downPct === undefined ? { type: 'mortgage' } : { type: 'mortgage', downPct },
  });

  it('only the down payment leaves; the rest is invested and lived on before the IRA', () => {
    const rows = run(profile(), { name: 'mortgage', housing: plan(), events: [] }).referencePath;
    const buyYear = rows.find((r) => r.year === 2028)!;

    // 1,000 of pre-existing brokerage + 840,000 swept in, less whatever the
    // year's spending had to sell back out of it.
    expect(buyYear.balances.byAccount['brokerage'] + buyYear.withdrawals.taxable).toBeCloseTo(
      1000 + (1000000 - 0.2 * 800000),
      6,
    );
    expect(buyYear.balances.byAccount['savings']).toBeCloseTo(0, 6);

    // The IRA is never touched — not in the purchase year and not in any of the
    // five years afterwards, which live off the invested proceeds while paying
    // a mortgage.
    expect(rows.every((r) => r.withdrawals.pretax === 0)).toBe(true);
    expect(rows.filter((r) => r.year > 2028).every((r) => r.withdrawals.taxable > 0)).toBe(true);
    expect(rows.at(-1)!.balances.byAccount['ira']).toBeGreaterThan(1500000);
  });

  it('borrows the remainder at the engine’s stated default terms', () => {
    const rows = run(profile(), { name: 'mortgage', housing: plan(), events: [] }).referencePath;
    // 2029 is the first FULL year of payments: 12 x the standard annuity on a
    // 640,000 loan at 6.67% over 30 years.
    const monthly = annuityMonthlyPayment(
      800000 * (1 - DEFAULT_DOWN_PCT),
      DEFAULT_MORTGAGE_RATE,
      DEFAULT_MORTGAGE_TERM_YEARS,
    );
    expect(rows.find((r) => r.year === 2029)!.housing.mortgagePayment).toBeCloseTo(monthly * 12, 6);
    // The purchase year carries 7 of the 12 payments (June).
    expect(rows.find((r) => r.year === 2028)!.housing.mortgagePayment).toBeGreaterThan(monthly * 6);
    expect(rows.find((r) => r.year === 2028)!.housing.mortgagePayment).toBeLessThan(monthly * 7.5);
  });

  it('20% down carries no PMI; 10% down carries exactly the 0.5% charge', () => {
    const at20 = run(profile(), { name: 'pmi-20', housing: plan(), events: [] }).referencePath;
    const at10 = run(profile(), { name: 'pmi-10', housing: plan(0.1), events: [] }).referencePath;

    // Purchase year, June: 7/12 of a year of everything.
    //   20% down: insurance is the premium alone, 6,000 x 7/12 = 3,500.
    //   10% down: + 0.5%/yr of the 720,000 loan x 7/12 = 2,100 of PMI, which
    //   the housing module reports inside `insurance`.
    const ins20 = at20.find((r) => r.year === 2028)!.housing.insurance;
    const ins10 = at10.find((r) => r.year === 2028)!.housing.insurance;
    expect(ins20).toBeCloseTo((6000 * 7) / 12, 8);
    expect(ins10 - ins20).toBeCloseTo(0.005 * (800000 * 0.9) * (7 / 12), 8);

    // It is not a one-off: the charge keeps running on the amortizing balance,
    // and the 20% loan never picks it up.
    const next20 = at20.find((r) => r.year === 2029)!.housing.insurance;
    const next10 = at10.find((r) => r.year === 2029)!.housing.insurance;
    expect(next20).toBeCloseTo(6000 * 1.025, 8); // premium indexed to CPI, no PMI
    const pmi2029 = next10 - next20;
    expect(pmi2029).toBeGreaterThan(0);
    // A full year on a balance that has amortized below the original 720,000.
    expect(pmi2029).toBeLessThan(0.005 * 720000);
    expect(pmi2029).toBeGreaterThan(0.005 * 700000);
  });
});

// ---------------------------------------------------------------------------
// 9. The user's case
// ---------------------------------------------------------------------------

describe('an end-to-end move: retire mid-2027, sell, rent 12 months, buy 2028', () => {
  const plan = (purchasePrice: number): HousingPlan => ({
    sellDate: '2027-06',
    rentMonths: 12,
    rentMonthly: 3000,
    purchasePrice,
    propertyTaxAnnual: 7500,
    financing: { type: 'cash' },
  });

  it('lives off the house, not the IRA, in the retirement year', () => {
    /*
     * THE RULE THE PLAN IS SUPPOSED TO EXPRESS: when the retirement date is at
     * or before the sale, the proceeds are spent before the IRA is opened. It
     * is not special-cased anywhere — the sale lands in savings, and the
     * household's own cash-first withdrawal order does the rest.
     *
     * 2027 sale price: 1,200,000 x 1.025 (one full year owned) = 1,230,000,
     * less 6% selling costs = 1,156,200 into savings, against an 860,000 basis
     * whose 296,200 gain is inside the §121 exclusion.
     */
    const rows = run(referenceProfile(), {
      name: 'owner move',
      housing: plan(600000),
      events: OWNER_EVENTS,
    }).referencePath;
    const retirementYear = rows.find((r) => r.year === 2027)!;

    expect(retirementYear.housing.saleProceeds).toBeCloseTo(1156200, 6);
    expect(retirementYear.eventsFired).toEqual([
      'retire:p1',
      'retire:p2',
      'sell_house',
      'rent',
      'rollover-401k',
    ]);
    // THE ASSERTION THIS SECTION EXISTS FOR.
    expect(retirementYear.withdrawals.pretax).toBe(0);
    expect(retirementYear.withdrawals.roth).toBe(0);
    expect(retirementYear.withdrawals.cash).toBeGreaterThan(0);
    expect(retirementYear.withdrawals.penaltyBase).toBe(0);

    // The purchase year and the year after it stay off the IRA as well: the
    // proceeds cover the house and the brokerage covers the rest.
    const buyYear = rows.find((r) => r.year === 2028)!;
    expect(buyYear.eventsFired).toEqual(['buy_house']);
    expect(buyYear.withdrawals.pretax).toBe(0);
    expect(rows.find((r) => r.year === 2029)!.withdrawals.pretax).toBe(0);

    // Rent ran for exactly the 12 months named, split across the two years:
    // 7 months of 2027 at 3,000, then 5 months of 2028 grown one year at CPI
    // 2.5% + the 0.5% rent spread -> 3,000 x 5 x 1.03 = 15,450.
    expect(retirementYear.housing.rent).toBeCloseTo(21000, 6);
    expect(buyYear.housing.rent).toBeCloseTo(15450, 6);
    expect(rows.find((r) => r.year === 2029)!.housing.rent).toBe(0);
  });

  it('when the house IS a commitment, the 72(t) bridge elects — and still never raids the IRA', () => {
    /*
     * A DIFFERENCE THE OWNER SHOULD KNOW ABOUT, pinned here so it cannot change
     * silently. His current plan.json prices the purchase at `sale_proceeds`,
     * which the automatic-72(t) estimator treats as a RESIDUAL claim (buy
     * whatever survived) and therefore ignores. A HousingPlan always states a
     * price, and a stated price is a COMMITMENT — money that has to be there on
     * the day — so the bridge subtracts it from the accessible cash, finds the
     * remaining years short, and elects a series in the retirement year.
     *
     * The result is pre-tax dollars in the retirement year. They are NOT the
     * plan raiding the IRA to buy a house: they are the fixed annual SEPP
     * payment, identical every year, penalty-free by construction.
     */
    const rows = run(referenceProfile(), {
      name: 'owner move, dearer house',
      housing: plan(900000),
      events: OWNER_EVENTS,
    }).referencePath;
    const [y2027, y2028, y2029] = [2027, 2028, 2029].map((y) => rows.find((r) => r.year === y)!);

    expect(y2027.eventsFired).toContain('auto-sepp');
    expect(y2027.flags).toContain('sepp');
    const payment = y2027.withdrawals.pretax;
    expect(payment).toBeGreaterThan(0);
    expect(y2028.withdrawals.pretax).toBeCloseTo(payment, 8);
    expect(y2029.withdrawals.pretax).toBeCloseTo(payment, 8);
    // Fixed, penalty-free, and small next to the house: the household is still
    // buying with cash, not with the IRA.
    expect(payment).toBeLessThan(0.05 * 900000);
    expect([y2027, y2028, y2029].every((r) => r.withdrawals.penaltyBase === 0)).toBe(true);
    expect(y2028.withdrawals.cash).toBeGreaterThan(800000); // the house came from cash
  });
});

// ---------------------------------------------------------------------------
// 10. The survivor's own purchase (survivorPurchasePrice)
// ---------------------------------------------------------------------------

describe('survivorPurchasePrice: a death before the purchase buys at HER price', () => {
  /*
   * WHY THIS EXISTS. The widow score used to model the survivor executing the
   * deceased's purchase exactly as written — his $1.75M house without his last
   * two salary years, a thing she would never do. The field lets the plan say
   * what she WOULD do, and the switch happens at the one place the compiled
   * purchase price enters the pipeline (survivorHousingPlan, called by
   * eventsWithHousingPlan), so every price-derived figure — the buy event, the
   * insurance estimate, the funding trace, the 72(t) reservation — agrees.
   */

  // Compile-level fixture: buy month is 2028-06 (2027-06 + 12 rental months).
  const compilePlan = (over?: Partial<HousingPlan>): HousingPlan => ({
    sellDate: '2027-06',
    rentMonths: 12,
    rentMonthly: 3000,
    purchasePrice: 1_750_000,
    survivorPurchasePrice: 900_000,
    propertyTaxAnnual: 7500,
    financing: { type: 'cash' },
    ...over,
  });
  const death = (date: YearMonth): ScenarioEvent => ({ type: 'death', person: 'p1', date });
  const buyOf = (events: ScenarioEvent[]) =>
    events.find((e) => e.type === 'buy_house') as Extract<ScenarioEvent, { type: 'buy_house' }>;

  it('switches the compiled price — and the insurance estimate with it — strictly before the buy month', () => {
    const buy = buyOf(eventsWithHousingPlan([death('2028-05')], compilePlan()));
    expect(buy.price).toBe(900_000);
    // The estimate follows the EFFECTIVE price (0.22% x 900,000)...
    expect(buy.insuranceAnnual).toBe(1980);
    // ...while property tax stays exactly as the plan states it. The plan owns
    // that figure; a rescale here would show a number nobody entered.
    expect(buy.propertyTaxAnnual).toBe(7500);
    // The purchase date does not move: she buys HER house on the plan's date.
    expect(buy.date).toBe('2028-06');
  });

  it('a death IN the buy month, after it, or never leaves the plan price alone', () => {
    // Strictly before: a June death against a June purchase is a household
    // that completed its move, so nothing switches.
    for (const events of [[death('2028-06')], [death('2028-07')], [death('2035-01')], []]) {
      const buy = buyOf(eventsWithHousingPlan(events, compilePlan()));
      expect(buy.price).toBe(1_750_000);
      expect(buy.insuranceAnnual).toBe(estimateHomeInsuranceAnnual(1_750_000)); // 3,850
    }
  });

  it("'sale_proceeds' compiles through as the residual claim it is", () => {
    const buy = buyOf(
      eventsWithHousingPlan([death('2026-01')], compilePlan({ survivorPurchasePrice: 'sale_proceeds' })),
    );
    expect(buy.price).toBe('sale_proceeds');
  });

  it('returns the SAME reference when nothing switches — the absent field cannot leak', () => {
    const noField = compilePlan();
    delete noField.survivorPurchasePrice;
    // Absent field, death present: untouched object, not an equal copy.
    expect(survivorHousingPlan(noField, [death('2026-01')])).toBe(noField);
    // Field present but no qualifying death: also untouched.
    const withField = compilePlan();
    expect(survivorHousingPlan(withField, [])).toBe(withField);
    expect(survivorHousingPlan(withField, [death('2028-06')])).toBe(withField);
    // A rent-forever plan has no purchase for anyone to re-price.
    const rentForever = compilePlan({ purchasePrice: 'none' });
    expect(survivorHousingPlan(rentForever, [death('2026-01')])).toBe(rentForever);
  });

  it('a survivor price of 0 falls into the "0 is the same statement as none" rule', () => {
    // The same trap-closure the plan price has: a zero must not model a
    // household that owns nothing, rents nothing and pays no housing costs.
    const events = eventsWithHousingPlan(
      [death('2026-01')],
      compilePlan({ survivorPurchasePrice: 0 }),
    );
    expect(events.some((e) => e.type === 'buy_house')).toBe(false);
    expect(events.some((e) => e.type === 'rent')).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Through the engine: the switched price is the one the run lives in
  // -------------------------------------------------------------------------

  /*
   * Savings 100,000, IRA 1,500,000; living 60,000/yr; a 1,000,000 house with
   * 0% selling costs and appreciation pinned to 0, so the 2027 sale nets
   * exactly 1,000,000. The plan then commits to a 2,000,000 replacement — far
   * beyond the proceeds — while the survivor price is a 600,000 house the
   * cash covers outright.
   */
  const engineProfile = () =>
    toyProfile({
      accounts: [savings(100000), ira(1500000)],
      annualLiving: 60000,
      horizonAge: 62, // 2026..2033
    });
  const enginePlan = (over?: Partial<HousingPlan>): HousingPlan => ({
    sellDate: '2027-06',
    appreciationRate: 0,
    rentMonths: 12,
    rentMonthly: 2000,
    purchasePrice: 2_000_000,
    survivorPurchasePrice: 600_000,
    propertyTaxAnnual: 0,
    insuranceAnnual: 0,
    financing: { type: 'cash' },
    ...over,
  });
  const withoutField = (over?: Partial<HousingPlan>): HousingPlan => {
    const p = enginePlan(over);
    delete p.survivorPurchasePrice;
    return p;
  };

  it('death before the buy month: the run buys at 600,000 and the funding trace says so', () => {
    const res = run(engineProfile(), {
      name: 'survivor buys her own house',
      housing: enginePlan(),
      events: [death('2027-01')],
    });
    const buyYear = res.referencePath.find((r) => r.year === 2028)!;
    expect(buyYear.housing.homeValue).toBe(600_000);
    // The IRA is never opened: the proceeds cover her house with room to spare.
    expect(buyYear.withdrawals.pretax).toBe(0);
    // The trace records the SWITCHED outflow — the number and the assumption
    // travel together all the way into the Housing card's readout.
    expect(res.purchaseFunding!.purchasePrice).toBe(600_000);
    expect(res.purchaseFunding!.cashOutflow).toBe(600_000);
    expect(res.purchaseFunding!.surplus).toBeGreaterThan(0);

    // The same death against the plan WITHOUT the field executes the 2,000,000
    // commitment and raids the IRA for the difference — the exact modelling
    // error the field exists to correct.
    const asWritten = run(engineProfile(), {
      name: 'survivor executes his plan',
      housing: withoutField(),
      events: [death('2027-01')],
    });
    const asWrittenBuy = asWritten.referencePath.find((r) => r.year === 2028)!;
    expect(asWrittenBuy.housing.homeValue).toBe(2_000_000);
    expect(asWrittenBuy.withdrawals.pretax).toBeGreaterThan(0);
    expect(asWritten.purchaseFunding!.cashOutflow).toBe(2_000_000);
  });

  it('death in the buy month or after: bit-identical to the plan without the field', () => {
    for (const when of ['2028-06', '2030-01'] as const) {
      const withF = run(engineProfile(), {
        name: 'field inert',
        housing: enginePlan(),
        events: [death(when)],
      });
      const withoutF = run(engineProfile(), {
        name: 'field inert',
        housing: withoutField(),
        events: [death(when)],
      });
      expect(digest(withF.referencePath), `death ${when} must not switch`).toBe(
        digest(withoutF.referencePath),
      );
    }
  });

  it('no death: bit-identical to the plan without the field', () => {
    const withF = run(engineProfile(), { name: 'no death', housing: enginePlan(), events: [] });
    const withoutF = run(engineProfile(), {
      name: 'no death',
      housing: withoutField(),
      events: [],
    });
    expect(digest(withF.referencePath)).toBe(digest(withoutF.referencePath));
    expect(withF.success).toBe(withoutF.success);
  });

  it('ABSENT means "the plan price", verbatim: identical to stating the plan price explicitly', () => {
    // The semantics the docs promise, as a digest: with a pre-purchase death,
    // no field and survivorPurchasePrice === purchasePrice are the same run.
    const absent = run(engineProfile(), {
      name: 'absent',
      housing: withoutField(),
      events: [death('2027-01')],
    });
    const explicit = run(engineProfile(), {
      name: 'explicit',
      housing: enginePlan({ survivorPurchasePrice: 2_000_000 }),
      events: [death('2027-01')],
    });
    expect(digest(absent.referencePath)).toBe(digest(explicit.referencePath));
  });

  it("'sale_proceeds' behaves exactly like a plan priced at the proceeds", () => {
    const survivorResidual = run(engineProfile(), {
      name: 'survivor residual',
      housing: enginePlan({ survivorPurchasePrice: 'sale_proceeds' }),
      events: [death('2027-01')],
    });
    const planResidual = run(engineProfile(), {
      name: 'plan residual',
      housing: withoutField({ purchasePrice: 'sale_proceeds' }),
      events: [death('2027-01')],
    });
    expect(digest(survivorResidual.referencePath)).toBe(digest(planResidual.referencePath));
    // And it really is a residual claim: a year of renting and living came out
    // of the 1,000,000 first, so the house is what survived — not the headline.
    const buyYear = survivorResidual.referencePath.find((r) => r.year === 2028)!;
    expect(buyYear.housing.homeValue).toBeGreaterThan(0);
    expect(buyYear.housing.homeValue).toBeLessThan(1_000_000);
    expect(buyYear.withdrawals.pretax).toBe(0);
  });

  it('the widow sweep picks it up on every pre-purchase probe year', () => {
    /*
     * A 3,000,000 commitment the household cannot possibly meet (100,000 of
     * savings + 1,000,000 of proceeds + a 1,500,000 IRA), so every run that
     * executes the plan price fails; the survivor price is the proceeds, so
     * every run that switches passes. Deterministic mode makes the curve a
     * step function whose LOCATION is the assertion: probes are July deaths,
     * the buy month is 2028-06, so 2027 is the last switching year and 2028 —
     * death one month AFTER the purchase — is the first that fails.
     */
    const scenario = (housing: HousingPlan): Scenario => ({
      name: 'widow sweep over the move',
      housing,
      events: [],
      solver: { type: 'widow_score', person: 'p1', from: 2026, to: 2030 },
    });
    const sweep = (housing: HousingPlan) =>
      runSolver({
        profile: engineProfile(),
        assumptions: assumptions(),
        scenario: scenario(housing),
        mode: 'deterministic',
        paths: 1,
        seed: 42,
      }).solverOutput!.points;

    const plan3m = enginePlan({ purchasePrice: 3_000_000, survivorPurchasePrice: 'sale_proceeds' });
    const withField = sweep(plan3m);
    const asWritten = sweep(withoutField({ purchasePrice: 3_000_000 }));

    expect(withField.map((p) => p.x)).toEqual([2026, 2027, 2028, 2029, 2030]);
    // Every pre-purchase probe switched and passed; every later one is the
    // household's own failure, identical to the no-field sweep.
    expect(withField.map((p) => p.success)).toEqual([1, 1, 0, 0, 0]);
    expect(asWritten.map((p) => p.success)).toEqual([0, 0, 0, 0, 0]);
    for (const [i, p] of withField.entries()) {
      if (p.x < 2028) {
        expect(p.medianTerminalReal).not.toBe(asWritten[i].medianTerminalReal);
      } else {
        expect(p.medianTerminalReal).toBe(asWritten[i].medianTerminalReal);
      }
    }

    // The probe reaches the switch through the SAME event path as any other
    // death: each sweep point reproduces a plain run of scenarioWithDeath.
    const direct = runSimulation({
      profile: engineProfile(),
      assumptions: assumptions(),
      scenario: scenarioWithDeath(scenario(plan3m), 'p1', 2027),
      mode: 'deterministic',
      paths: 1,
      seed: 42,
    });
    expect(withField[1].success).toBe(direct.success);
    expect(withField[1].medianTerminalReal).toBe(direct.medianTerminalReal);
  });
});

describe('topic 4 fixes', () => {
  it('bills twelve months of housing in a sell-and-buy year, not thirteen', () => {
    /*
     * The sold home is charged months 1..sellMonth and a purchase months
     * buyMonth..12, so a same-month move billed the shared month twice: with
     * $12,000/yr on both houses, $13,150 of property tax in one calendar year.
     * Now $12,150 — six months of the old house at one year of CPI (6,150) plus
     * six of the new (6,000).
     */
    const profile = referenceProfile();
    profile.home = {
      ...profile.home,
      value: 1_000_000,
      costBasis: 1_000_000,
      propertyTaxAnnual: 12000,
      insuranceAnnual: 0,
      maintenancePctOfValue: 0,
      sellingCostPct: 0,
      mortgage: null,
    };
    const rows = run(profile, {
      name: 'same-month',
      events: [],
      housing: {
        sellDate: '2027-06',
        rentMonths: 0,
        rentMonthly: 0,
        purchasePrice: 1_000_000,
        propertyTaxAnnual: 12000,
        insuranceAnnual: 0,
        financing: { type: 'cash' },
      },
    }).referencePath;
    const y = rows.find((r) => r.year === 2027)!;
    expect(y.housing.propertyTax).toBeCloseTo(12000 * 1.025 * 0.5 + 12000 * 0.5, 2);
  });

  it('sells and rents to the horizon when there is no purchase', () => {
    // Both spellings: 'none' is the honest one, 0 is what people type when the
    // field wants a number and they do not mean to buy. They must agree, or the
    // obvious input models free accommodation for life.
    for (const purchasePrice of ['none', 0] as const) {
      const rows = run(referenceProfile(), {
        name: 'rent-forever',
        events: [],
        housing: {
          sellDate: '2027-06',
          rentMonths: 12,
          rentMonthly: 2000,
          purchasePrice,
          propertyTaxAnnual: 0,
          financing: { type: 'cash' },
        },
      }).referencePath;
      const last = rows[rows.length - 1];
      expect(last.housing.homeValue).toBe(0);
      // Still renting decades later, and the rent has grown with inflation.
      expect(last.housing.rent).toBeGreaterThan(2000 * 12);
      expect(rows.find((r) => r.year === 2040)!.housing.rent).toBeGreaterThan(0);
    }
  });

  it('buys a house costing more than the sale paid for, funding the rest from the IRA', () => {
    // The user's stated case: a set price above the proceeds, paying cash. The
    // shortfall has to come from somewhere, and pre-tax is the only place left
    // once savings and the brokerage are spent.
    const rows = run(referenceProfile(), {
      name: 'trade-up',
      events: [...OWNER_EVENTS],
      housing: {
        sellDate: '2027-06',
        rentMonths: 12,
        rentMonthly: 3000,
        purchasePrice: 2_000_000, // far above the ~$1.25M of proceeds
        propertyTaxAnnual: 12000,
        financing: { type: 'cash' },
      },
    }).referencePath;
    const buyYear = rows.find((r) => r.year === 2028)!;
    expect(buyYear.housing.homeValue).toBeCloseTo(2_000_000, 2);
    expect(buyYear.withdrawals.pretax).toBeGreaterThan(0);
  });
});

/**
 * PER-LINE SURVIVOR SPENDING: what a widow actually spends, line by line.
 *
 * The engine used to apply ONE fraction — 0.75, or whatever the death event
 * named — to the whole living baseline. A household with ONE CAR does not see
 * its $610 payment fall by a quarter when one of two people dies; it does not
 * fall at all, and no single fraction of the couple's baseline can say so. The itemised
 * budget can, because each line carries its own survivor figure.
 *
 * The three sources rank: an explicit `livingFraction` on the death event beats
 * the budget (it is the user asking a specific what-if, and a what-if the
 * budget could override would not be one), the budget beats
 * DEFAULT_SURVIVOR_LIVING_FRACTION, and that constant is what a profile with no
 * budget still gets. Each rung is asserted below, because a precedence rule
 * nobody tests is a precedence rule that quietly inverts.
 *
 * The fixture is two living lines and nothing else — a car that does not
 * shrink and groceries that halve — so every figure here is one addition.
 *
 * Contents:
 *  1. the one car: the survivor's living cost is the sum of the lines
 *  2. precedence: the event wins, then the lines, then the constant
 *  3. the retired column: a survivor figure inherits the state in force
 *  4. inside a real run, including the death year and the retirement year
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseEvents } from '../../src/engine/events';
import { prepareHousehold, SIM_START_YEAR } from '../../src/engine/household';
import { runSimulation } from '../../src/engine/simulate';
import { loadHistoricalCsv } from '../../src/engine/returns';
import { DEFAULT_SURVIVOR_LIVING_FRACTION } from '../../src/shared/types';
import type {
  AcaData,
  Assumptions,
  ExpenseLine,
  FederalTaxData,
  MarketAssumptions,
  MedicareData,
  Profile,
  RmdTableData,
  Scenario,
  ScenarioEvent,
  RunResult,
  SocialSecurityData,
  StateTaxData,
  YearRow,
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

const ssData = ssJson as unknown as SocialSecurityData;
const medicareData = medicareJson as unknown as MedicareData;
const acaData = acaJson as unknown as AcaData;

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
    socialSecurity: ssData,
    medicare: medicareData,
    aca: acaData,
    rmd: rmdJson as unknown as RmdTableData,
  };
}

/**
 * THE ONE CAR, and the line that does behave the way a fraction expects.
 *
 * The car payment is a household-level cost with one payer either way. The
 * groceries line is per-person and halves. A global 0.75 gets both wrong in
 * opposite directions and lands somewhere in between by accident.
 */
const CAR = 610;
const GROCERIES_NOW = 1_200;
const GROCERIES_SURVIVOR = 600;
/** 1,810/mo for the couple; 1,210/mo for the survivor. */
const COUPLE_WORKING = CAR + GROCERIES_NOW;
const SURVIVOR_WORKING = CAR + GROCERIES_SURVIVOR;

const LINES: ExpenseLine[] = [
  {
    id: 'car',
    label: 'Car payment',
    category: 'living',
    monthlyNow: CAR,
    // The whole reason per-line amounts exist: unchanged, explicitly.
    monthlySurvivor: CAR,
  },
  {
    id: 'groceries',
    label: 'Groceries',
    category: 'living',
    monthlyNow: GROCERIES_NOW,
    monthlySurvivor: GROCERIES_SURVIVOR,
  },
];

function household(over?: {
  lines?: ExpenseLine[];
  salaries?: Record<string, number>;
  livingMonthly?: number;
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
  const expenses: Profile['expenses'] = {
    // The scalar the budget derives; stated here as the sum it derives TO, so
    // nothing in this file turns on the derivation itself.
    livingMonthly: over?.livingMonthly ?? COUPLE_WORKING,
    charitableMonthly: 0,
    investingMonthly: 0,
  };
  if (over?.lines !== undefined) expenses.lines = over.lines;
  return {
    people: [person('p1'), person('p2')],
    filing: { status: 'mfj', state: 'va' },
    accounts: [
      {
        id: 'savings',
        name: 'Savings',
        type: 'savings',
        owner: 'joint',
        balance: 3_000_000,
        allocation: { stocks: 0, bonds: 0, bills: 1 },
      },
    ],
    home: {
      value: 0,
      costBasis: 0,
      state: 'va',
      propertyTaxAnnual: 0,
      insuranceAnnual: 0,
      maintenancePctOfValue: 0,
      sellingCostPct: 0,
      mortgage: null,
    },
    income: {
      salaries: over?.salaries ?? { p1: 0, p2: 0 },
      contribution401k: 0,
      employerMatch401k: 0,
    },
    expenses,
    health: {
      acaBenchmarkMonthly: 0,
      acaQuoteYear: 2026,
      partDPlanMonthly: 0,
      employerPremiumShareMonthly: 0,
    },
    settings: {
      horizonAge: 64,
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

const prepared = (profile: Profile, events: ScenarioEvent[], horizonYears = 10) =>
  prepareHousehold(profile, parseEvents(events), ssData, medicareData, acaData, SIM_START_YEAR, horizonYears);

function run(profile: Profile, events: ScenarioEvent[]): RunResult {
  const scenario: Scenario = {
    name: 'per-line survivor',
    autoSepp: false,
    events,
    // Zero inflation and zero returns, so a monthly figure times 12 is the
    // year's spending and nothing has to be deflated to read it.
    assumption_overrides: {
      market: {
        deterministicReal: { stocks: 0, bonds: 0, bills: 0 },
        deterministicInflation: 0,
        cashYieldNominal: 0,
      },
    },
  };
  return runSimulation({
    profile,
    assumptions: assumptions(),
    scenario,
    mode: 'deterministic',
    paths: 1,
    seed: 1,
  });
}

const yearIndex = (year: number): number => year - SIM_START_YEAR;
const rowFor = (rows: YearRow[], year: number): YearRow => rows.find((r) => r.year === year)!;

// ---------------------------------------------------------------------------
// 1. The one car
// ---------------------------------------------------------------------------

describe('the survivor spends the sum of her lines, not a fraction of the couple', () => {
  const events: ScenarioEvent[] = [{ type: 'death', person: 'p1', date: '2030-01' }];

  it('keeps the car payment whole and halves the groceries', () => {
    const h = prepared(household({ lines: LINES }), events);
    // 1,210 / 1,810 = 0.668508..., which is not 0.75 and could not have been.
    expect(h.livingFactorByYear[yearIndex(2031)]).toBeCloseTo(
      SURVIVOR_WORKING / COUPLE_WORKING,
      12,
    );
    expect(h.death?.survivorLiving.source).toBe('lines');
  });

  it('costs the household REAL money against the global fraction — this is not a rounding', () => {
    /*
     * The default would have spent 0.75 x 1,810 = 1,357.50/mo. The budget
     * says 1,210. Over a widowhood of any length that difference is the whole
     * point of typing the budget in: 147.50/mo, every month, in the direction
     * that makes the plan look worse than it is.
     */
    const withLines = prepared(household({ lines: LINES }), events);
    const without = prepared(household(), events);
    const perMonth =
      withLines.livingFactorByYear[yearIndex(2031)] * COUPLE_WORKING -
      without.livingFactorByYear[yearIndex(2031)] * COUPLE_WORKING;
    expect(perMonth).toBeCloseTo(SURVIVOR_WORKING - DEFAULT_SURVIVOR_LIVING_FRACTION * COUPLE_WORKING, 9);
    expect(perMonth).toBeCloseTo(-147.5, 9);
  });

  it('is exactly 1 before the death, as it is in every run that has none', () => {
    const h = prepared(household({ lines: LINES }), events);
    expect(h.livingFactorByYear.slice(0, yearIndex(2030)).every((f) => f === 1)).toBe(true);
    const noDeath = prepared(household({ lines: LINES }), []);
    expect(noDeath.livingFactorByYear.every((f) => f === 1)).toBe(true);
    expect(noDeath.death).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 2. Precedence
// ---------------------------------------------------------------------------

describe('an explicit livingFraction outranks the budget, and the budget outranks the constant', () => {
  it('the event’s own figure wins even when every line names a survivor amount', () => {
    // A user asking "what if her costs did not fall at all" must get that
    // answer, not the budget's. A what-if the profile could override would not
    // be a what-if.
    const h = prepared(household({ lines: LINES }), [
      { type: 'death', person: 'p1', date: '2030-01', livingFraction: 1 },
    ]);
    expect(h.death?.survivorLiving.source).toBe('event');
    expect(h.livingFactorByYear[yearIndex(2031)]).toBe(1);
  });

  it('a profile with no lines still gets DEFAULT_SURVIVOR_LIVING_FRACTION', () => {
    const h = prepared(household(), [{ type: 'death', person: 'p1', date: '2030-01' }]);
    expect(h.death?.survivorLiving.source).toBe('default');
    expect(h.livingFactorByYear[yearIndex(2031)]).toBe(DEFAULT_SURVIVOR_LIVING_FRACTION);
  });

  it('an EMPTY lines array is the same as no lines at all', () => {
    // The contract says absent-or-empty means the scalars are the truth. An
    // empty array reaching the ratio would divide 0 by 0 and spend NaN.
    const h = prepared(household({ lines: [] }), [{ type: 'death', person: 'p1', date: '2030-01' }]);
    expect(h.death?.survivorLiving.source).toBe('default');
    expect(h.livingFactorByYear[yearIndex(2031)]).toBe(DEFAULT_SURVIVOR_LIVING_FRACTION);
  });

  it('only living lines count: giving and investing have their own streams', () => {
    /*
     * A charitable line with a survivor amount must not drag the LIVING
     * fraction — giving in retirement is a rule, not a share of the baseline,
     * and 'modeled_elsewhere' rows exist precisely so they are never summed.
     */
    const h = prepared(
      household({
        lines: [
          ...LINES,
          { id: 'tithe', label: 'Giving', category: 'charitable', monthlyNow: 2_300, monthlySurvivor: 0 },
          {
            id: 'ptax',
            label: 'Property tax',
            category: 'modeled_elsewhere',
            monthlyNow: 800,
            monthlySurvivor: 800,
          },
        ],
      }),
      [{ type: 'death', person: 'p1', date: '2030-01' }],
    );
    expect(h.livingFactorByYear[yearIndex(2031)]).toBeCloseTo(
      SURVIVOR_WORKING / COUPLE_WORKING,
      12,
    );
  });
});

// ---------------------------------------------------------------------------
// 3. The retired column
// ---------------------------------------------------------------------------

describe('a survivor amount inherits whichever state is in force', () => {
  /*
   * Groceries fall to 1,000 in retirement but name no survivor figure, so the
   * widow's groceries are 1,000 while she is retired and 1,200 while a salary
   * is still coming in. The car names one and keeps it in both. So the
   * survivor's total is 1,610 retired and 1,810 working — the couple's own,
   * because on this budget nothing about her differs except through the lines
   * that say so.
   */
  const retiredLines: ExpenseLine[] = [
    { id: 'car', label: 'Car payment', category: 'living', monthlyNow: CAR, monthlySurvivor: CAR },
    {
      id: 'groceries',
      label: 'Groceries',
      category: 'living',
      monthlyNow: GROCERIES_NOW,
      monthlyRetired: 1_000,
    },
  ];

  it('gives the two states different fractions when the lines say they differ', () => {
    const h = prepared(household({ lines: retiredLines }), [
      { type: 'death', person: 'p1', date: '2030-01' },
    ]);
    // Nobody works in this fixture, so every year reads the retired fraction —
    // and with no survivor figure on groceries it is exactly 1.
    expect(h.livingFactorByYear[yearIndex(2031)]).toBe(1);
    expect(h.death?.survivorLiving.working).toBe(1);
    expect(h.death?.survivorLiving.retired).toBe(1);
  });

  it('reads the survivor figure against the RETIRED base, not the working one', () => {
    // The chain is survivor -> retired -> now. A survivor figure of 900 against
    // a retired base of 1,610 is 0.559 of it, not 0.497 of the working 1,810 —
    // and getting that wrong walks a widow's spending back up to the couple's
    // pre-retirement level.
    const lines: ExpenseLine[] = [
      { id: 'car', label: 'Car payment', category: 'living', monthlyNow: CAR, monthlySurvivor: CAR },
      {
        id: 'groceries',
        label: 'Groceries',
        category: 'living',
        monthlyNow: GROCERIES_NOW,
        monthlyRetired: 1_000,
        monthlySurvivor: 900,
      },
    ];
    const h = prepared(household({ lines }), [{ type: 'death', person: 'p1', date: '2030-01' }]);
    expect(h.death?.survivorLiving.retired).toBeCloseTo((CAR + 900) / (CAR + 1_000), 12);
    expect(h.death?.survivorLiving.working).toBeCloseTo((CAR + 900) / (CAR + GROCERIES_NOW), 12);
  });
});

// ---------------------------------------------------------------------------
// 4. Inside a real run
// ---------------------------------------------------------------------------

describe('a full run spends the survivor’s own budget', () => {
  it('a year after the death costs exactly her monthly total x 12', () => {
    const res = run(household({ lines: LINES }), [
      { type: 'death', person: 'p1', date: '2030-01' },
    ]);
    // Inflation is 0 in this fixture, so the nominal figure IS the real one.
    expect(rowFor(res.referencePath, 2031).expenses.baseline).toBeCloseTo(
      SURVIVOR_WORKING * 12,
      6,
    );
    // And before it, the couple's.
    expect(rowFor(res.referencePath, 2029).expenses.baseline).toBeCloseTo(COUPLE_WORKING * 12, 6);
  });

  it('the death year is prorated by the month, not switched at the year boundary', () => {
    // Consumption is a per-month flow. A death in July leaves six months of the
    // couple's spending and six of the survivor's: (6 x 1,810 + 6 x 1,210) x 1.
    const res = run(household({ lines: LINES }), [
      { type: 'death', person: 'p1', date: '2030-07' },
    ]);
    expect(rowFor(res.referencePath, 2030).expenses.baseline).toBeCloseTo(
      6 * COUPLE_WORKING + 6 * SURVIVOR_WORKING,
      6,
    );
  });

  it('a part-worked year lands on her own total, whatever the calendar did', () => {
    /*
     * THE CASE THE BLEND EXISTS FOR. Retiring in July 2030 splits the year
     * between a working baseline of 1,810/mo and a retired one of 1,610/mo, and
     * the survivor fractions against those two bases are different numbers
     * (0.6685 and 0.7516). Blend them by the same worked months the baseline is
     * blended by and the year costs exactly what the lines say: 1,210/mo for
     * twelve months, because on this budget her figure does not depend on
     * whether anyone was still earning.
     */
    const lines: ExpenseLine[] = [
      { id: 'car', label: 'Car payment', category: 'living', monthlyNow: CAR, monthlySurvivor: CAR },
      {
        id: 'groceries',
        label: 'Groceries',
        category: 'living',
        monthlyNow: GROCERIES_NOW,
        monthlyRetired: 1_000,
        monthlySurvivor: GROCERIES_SURVIVOR,
      },
    ];
    // p2 carries the salary and retires mid-2030; p1 died in 2029, so the
    // household is a lone survivor who still works six months of the year.
    const profile = household({ lines, salaries: { p1: 0, p2: 200_000 } });
    const res = run(profile, [
      { type: 'retire', person: 'p2', date: '2030-07' },
      { type: 'death', person: 'p1', date: '2029-01' },
    ]);
    expect(rowFor(res.referencePath, 2030).expenses.baseline).toBeCloseTo(SURVIVOR_WORKING * 12, 6);
    // The blend really ran: the year's factor is neither of the two fractions.
    const h = prepared(profile, [
      { type: 'retire', person: 'p2', date: '2030-07' },
      { type: 'death', person: 'p1', date: '2029-01' },
    ]);
    const f = h.livingFactorByYear[yearIndex(2030)];
    expect(f).toBeGreaterThan(h.death!.survivorLiving.working);
    expect(f).toBeLessThan(h.death!.survivorLiving.retired);
  });
});

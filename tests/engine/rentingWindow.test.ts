/**
 * The renting column and the between-homes cash banking (notes 23-24):
 * ExpenseLine.monthlyRenting, the sale→purchase window, the savings-bound
 * investing redirect, the banked living reduction, and the purchase-funding
 * trace the Housing card reads.
 *
 * The properties under test, in order:
 *
 *  1. MONTH-ACCURATE BLEND. The window spans calendar years (June to June),
 *     and each year's living stream must price exactly its own in-window
 *     months at the renting totals — 7 + 5 = 12, never 6 + 6, and never a
 *     whole year of either figure. Both halves are hand-computed here.
 *  2. THE RETIRED SIDE OF THE BLEND. A household that retires before the
 *     window prices its renting months off the retired base (a blank renting
 *     cell inherits the RETIRED figure there), and the retirement year mixes
 *     all the states month by month.
 *  3. ABSENT MEANS BIT-IDENTICAL. Renting values on a plan with no window, a
 *     rent-to-the-horizon plan, or under a wholesale living override change
 *     NOTHING — same digest, to the byte. This is the migration promise every
 *     optional column in this codebase has had to keep.
 *  4. BANKING LANDS IN SAVINGS ONLY INSIDE THE WINDOW, only while a purchase
 *     is pending: the investing stream's in-window share is redirected, the
 *     living reduction is parked, and a rent-to-horizon plan keeps the old
 *     consumption rule everywhere.
 *  5. THE READOUT'S COMPONENTS SUM to the displayed total and match the
 *     engine's own rows — the summing test the Housing card's breakdown
 *     leans on.
 *  6. A DEATH DURING THE WINDOW: the survivor column governs from the death
 *     year and the renting column is ignored — pinned as digest equality
 *     between a widowed run with renting values and the same run without.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { runSimulation } from '../../src/engine/simulate';
import { loadHistoricalCsv } from '../../src/engine/returns';
import type {
  AcaData,
  Account,
  Assumptions,
  ExpenseLine,
  FederalTaxData,
  MarketAssumptions,
  MedicareData,
  Profile,
  RmdTableData,
  RunResult,
  Scenario,
  ScenarioEvent,
  SocialSecurityData,
  StateTaxData,
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

/** Deterministic CPI (market.json): every hand computation below inflates by it. */
const CPI = (marketJson as { deterministicInflation: number }).deterministicInflation;

function run(profile: Profile, scenario: Scenario): RunResult {
  return runSimulation({
    profile,
    assumptions: assumptions(),
    scenario,
    mode: 'deterministic',
    paths: 1,
    seed: 42,
  });
}

/**
 * Everything arithmetic about a run, hashed — the same field list the other
 * golden pins use, PLUS purchaseFunding, because these tests are exactly the
 * ones asserting when that record may and may not move.
 */
const digest = (res: RunResult): string =>
  createHash('sha256')
    .update(
      JSON.stringify({
        success: res.success,
        fan: res.fan,
        medianTerminalReal: res.medianTerminalReal,
        charitableLegacy: res.charitableLegacy,
        referencePath: res.referencePath,
        purchaseFunding: res.purchaseFunding ?? null,
      }),
    )
    .digest('hex');

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * THE BUDGET, with a representative examples: heating oil and the security
 * system go to zero in an apartment, electricity roughly halves, and the rest
 * of the household does not notice the dwelling.
 * Base living 4,500/mo; renting living 4,150/mo; reduction 350/mo.
 */
function rentingLines(): ExpenseLine[] {
  return [
    { id: 'household', label: 'Household', category: 'living', monthlyNow: 4000 },
    { id: 'oil', label: 'Heating oil', category: 'living', monthlyNow: 200, monthlyRenting: 0 },
    {
      id: 'electric',
      label: 'Electricity',
      category: 'living',
      monthlyNow: 300,
      monthlyRenting: 150,
    },
  ];
}

/** The same lines with the renting column stripped — the bit-identity control. */
function strippedLines(): ExpenseLine[] {
  return rentingLines().map(({ monthlyRenting: _renting, ...rest }) => rest);
}

const person = (id: string, salary: boolean) => ({
  id,
  name: id.toUpperCase(),
  birthYear: 1971,
  birthMonth: 6,
  piaMonthlyAtFraIfWorkingTo62: salary ? 3000 : 0,
  piaMonthlyAtFraIfStoppingNow: salary ? 2800 : 0,
  hasOwnBenefit: salary,
});

const ACCOUNTS: Account[] = [
  {
    id: 'ira1',
    name: 'IRA',
    type: 'traditional_ira',
    owner: 'p1',
    balance: 1_500_000,
    allocation: { stocks: 0.7, bonds: 0.3, bills: 0 },
  },
  {
    id: 'brokerage',
    name: 'Brokerage',
    type: 'taxable_brokerage',
    owner: 'p1',
    balance: 300_000,
    costBasis: 250_000,
    allocation: { stocks: 1, bonds: 0, bills: 0 },
  },
  {
    id: 'savings',
    name: 'Savings',
    type: 'savings',
    owner: 'p1',
    balance: 50_000,
    allocation: { stocks: 0, bonds: 0, bills: 1 },
  },
];

function profile(over?: Partial<Profile> & { lines?: ExpenseLine[] }): Profile {
  const { lines, ...rest } = over ?? {};
  return {
    people: [person('p1', true), person('p2', false)],
    filing: { status: 'mfj', state: 'va' },
    accounts: ACCOUNTS.map((a) => ({ ...a })),
    home: {
      value: 1_000_000,
      costBasis: 1_000_000,
      state: 'va',
      propertyTaxAnnual: 0,
      insuranceAnnual: 0,
      maintenancePctOfValue: 0,
      sellingCostPct: 0,
      mortgage: null,
    },
    income: { salaries: { p1: 265_000, p2: 0 }, contribution401k: 0, employerMatch401k: 0 },
    expenses: {
      livingMonthly: 4500,
      charitableMonthly: 0,
      investingMonthly: 0,
      ...(lines !== undefined ? { lines } : {}),
    },
    health: {
      acaBenchmarkMonthly: 1500,
      acaQuoteYear: 2026,
      partDPlanMonthly: 45,
      employerPremiumShareMonthly: 0,
    },
    settings: {
      horizonAge: 62, // 2026..2033 — short on purpose, these are unit fixtures
      successTarget: 0.85,
      mcPathsInteractive: 1000,
      mcPathsFinal: 10000,
      seed: 42,
      spendingPolicy: { type: 'fixed_real' },
      withdrawalPolicy: {
        order: ['cash', 'taxable', 'pretax', 'roth'],
        pretaxPreference: 'ira_first',
      },
    },
    ...rest,
  };
}

/** Sell June 2027, rent 12 months, buy June 2028 — the user's window shape. */
const MOVE: ScenarioEvent[] = [
  { type: 'sell_house', date: '2027-06' },
  { type: 'rent', start: '2027-06', months: 12, monthlyCost: 3000 },
  {
    type: 'buy_house',
    date: '2028-06',
    price: 900_000,
    financing: 'cash',
    propertyTaxAnnual: 7_000,
    insuranceAnnual: 2_000,
  },
];

/** Salary runs through the whole window (retire 2029-07), 72(t) held out of the way. */
function scenario(events: ScenarioEvent[], over?: Partial<Scenario>): Scenario {
  return {
    name: 'renting-window',
    autoSepp: false,
    events: [{ type: 'retire', person: 'p1', date: '2029-07' }, ...events],
    ...over,
  };
}

const rowFor = (res: RunResult, year: number) => {
  const row = res.referencePath.find((r) => r.year === year);
  expect(row, `no ${year} row`).toBeDefined();
  return row!;
};

// ---------------------------------------------------------------------------
// 1. The blend is month-accurate across the two calendar years
// ---------------------------------------------------------------------------

describe('the renting blend prices exactly the in-window months (note 23)', () => {
  const res = run(profile({ lines: rentingLines() }), scenario(MOVE));

  it('prices 2026 wholly at the base — the window has not opened', () => {
    expect(rowFor(res, 2026).expenses.baseline).toBeCloseTo(4500 * 12, 6);
    expect(rowFor(res, 2026).banked).toBeUndefined();
  });

  it('prices 2027 as 5 base months + 7 renting months', () => {
    // Sold June: months 6..12 are between homes. 4,500 × 5 + 4,150 × 7 =
    // 51,550, inflated one year. A 6/6 split (the classic off-by-one) would
    // read 51,900 — the assertion resolves the difference easily.
    expect(rowFor(res, 2027).expenses.baseline).toBeCloseTo(51_550 * (1 + CPI), 6);
  });

  it('prices 2028 as 5 renting months + 7 base months — 12 renting months in all', () => {
    // Bought June: months 1..5 still renting, the buy month is not.
    expect(rowFor(res, 2028).expenses.baseline).toBeCloseTo(
      (4150 * 5 + 4500 * 7) * (1 + CPI) ** 2,
      6,
    );
  });

  it('prices 2029 wholly at the base again — the window is closed', () => {
    // 2029 is also the retirement year; with no retired column the base runs
    // through it unchanged, so any residue of the renting figures here is a
    // leak.
    expect(rowFor(res, 2029).expenses.baseline).toBeCloseTo(4500 * 12 * (1 + CPI) ** 3, 6);
    expect(rowFor(res, 2029).banked).toBeUndefined();
  });

  it('banks the living reduction in savings for the 2027 window months', () => {
    // 350/mo freed × 7 in-window months, inflated — parked, not consumed:
    // the whole reason the column exists (note 24b).
    expect(rowFor(res, 2027).banked?.livingReduction).toBeCloseTo(350 * 7 * (1 + CPI), 6);
    // No investing stream in this fixture, so the redirect leg is 0.
    expect(rowFor(res, 2027).banked?.investing ?? 0).toBe(0);
  });

  it('consumes the same unbudgeted leftover as the no-column run — banking is not a raid', () => {
    // The reduction lowers the baseline AND is banked, so what remains for
    // note 20's consumption is unchanged: the banked cash is exactly the
    // spending the household did not do, never a slice of the leftover it
    // would have consumed anyway.
    const stripped = run(profile({ lines: strippedLines() }), scenario(MOVE));
    expect(rowFor(res, 2027).unbudgeted).toBeCloseTo(rowFor(stripped, 2027).unbudgeted, 6);
  });
});

// ---------------------------------------------------------------------------
// 2. The retired side of the blend
// ---------------------------------------------------------------------------

describe('renting months after the last paycheck price off the retired base', () => {
  /*
   * Retire 2027-06, sell 2027-06: every window month is retired. Lines name a
   * retired figure (household 4,000 → 3,800), so the blank renting cells
   * inherit the RETIRED base in those months:
   *   base working 4,500 · base retired 4,300 · renting-retired 3,950
   *   (0 oil + 150 electricity + 3,800 household).
   */
  const retiredLines: ExpenseLine[] = [
    {
      id: 'household',
      label: 'Household',
      category: 'living',
      monthlyNow: 4000,
      monthlyRetired: 3800,
    },
    { id: 'oil', label: 'Heating oil', category: 'living', monthlyNow: 200, monthlyRenting: 0 },
    {
      id: 'electric',
      label: 'Electricity',
      category: 'living',
      monthlyNow: 300,
      monthlyRenting: 150,
    },
  ];
  const res = run(
    profile({ lines: retiredLines }),
    scenario(MOVE, {
      events: [{ type: 'retire', person: 'p1', date: '2027-06' }, ...MOVE],
    }),
  );

  it('mixes all the states in the retirement year, month by month', () => {
    // 2027: months 1-5 worked at the working base (the window opens with the
    // June sale, after the May paycheck), months 6-12 retired AND renting:
    // 4,500 × 5 + 3,950 × 7 = 50,150.
    expect(rowFor(res, 2027).expenses.baseline).toBeCloseTo(50_150 * (1 + CPI), 6);
  });

  it('prices the buy year as 5 retired-renting months + 7 retired months', () => {
    // 3,950 × 5 + 4,300 × 7 = 49,850.
    expect(rowFor(res, 2028).expenses.baseline).toBeCloseTo(49_850 * (1 + CPI) ** 2, 6);
  });
});

// ---------------------------------------------------------------------------
// 3. Absent means bit-identical
// ---------------------------------------------------------------------------

describe('the renting column is inert everywhere it has no window (note 23)', () => {
  it('changes nothing on a plan with no move at all', () => {
    const plain = scenario([]);
    expect(digest(run(profile({ lines: rentingLines() }), plain))).toBe(
      digest(run(profile({ lines: strippedLines() }), plain)),
    );
  });

  it('changes nothing on a rent-to-the-horizon plan — no purchase is pending', () => {
    // Sell and rent forever: the household is not BETWEEN homes, the rental
    // IS the home, so the column must not discount it — and no banking may
    // start for a purchase that never comes.
    const rentForever = scenario([
      { type: 'sell_house', date: '2027-06' },
      { type: 'rent', start: '2027-06', months: 600, monthlyCost: 3000 },
    ]);
    const withColumn = run(profile({ lines: rentingLines() }), rentForever);
    expect(digest(withColumn)).toBe(digest(run(profile({ lines: strippedLines() }), rentForever)));
    expect(withColumn.purchaseFunding).toBeUndefined();
    expect(withColumn.referencePath.every((r) => r.banked === undefined)).toBe(true);
  });

  it('changes nothing on a same-month sale and purchase — no months between homes', () => {
    const sameMonth = scenario([
      { type: 'sell_house', date: '2027-06' },
      { ...MOVE[2], date: '2027-06' } as ScenarioEvent,
    ]);
    const withColumn = run(profile({ lines: rentingLines() }), sameMonth);
    expect(digest(withColumn)).toBe(digest(run(profile({ lines: strippedLines() }), sameMonth)));
    // The no-rental-window shape must also record no funding story: this is
    // the fixture class whose golden digests elsewhere must never move.
    expect(withColumn.purchaseFunding).toBeUndefined();
  });

  it('is disabled by a wholesale living override — the solvers sweep that scalar', () => {
    const overridden = scenario(MOVE, {
      assumption_overrides: { expenses: { livingMonthly: 5200 } },
    });
    expect(digest(run(profile({ lines: rentingLines() }), overridden))).toBe(
      digest(run(profile({ lines: strippedLines() }), overridden)),
    );
  });

  it('is never consulted under the fixed_percent spending policy', () => {
    const pct = (p: Profile): Profile => ({
      ...p,
      settings: { ...p.settings, spendingPolicy: { type: 'fixed_percent', percent: 0.04 } },
    });
    expect(digest(run(pct(profile({ lines: rentingLines() })), scenario(MOVE)))).toBe(
      digest(run(pct(profile({ lines: strippedLines() })), scenario(MOVE))),
    );
  });
});

// ---------------------------------------------------------------------------
// 4. Banking: the investing redirect
// ---------------------------------------------------------------------------

describe('the investing stream banks to savings inside the window (note 24a)', () => {
  const investing = (p?: Partial<Profile> & { lines?: ExpenseLine[] }): Profile => {
    const base = profile(p);
    return { ...base, expenses: { ...base.expenses, investingMonthly: 1250 } };
  };
  const res = run(investing(), scenario(MOVE));

  it('sends the whole transfer to the brokerage before the window', () => {
    expect(rowFor(res, 2026).investing).toBeCloseTo(1250 * 12, 6);
    expect(rowFor(res, 2026).banked).toBeUndefined();
  });

  it('redirects exactly the in-window months to savings in the sale year', () => {
    // 12 worked months of transfer, 7 of them between homes: the July-onward
    // slice is purchase money and goes to cash, the rest buys shares.
    const row = rowFor(res, 2027);
    expect(row.investing).toBeCloseTo(1250 * 12 * (1 + CPI), 6);
    expect(row.banked?.investing).toBeCloseTo(1250 * 7 * (1 + CPI), 6);
  });

  it('banks nothing in the buy year — the purchase consumed the surplus', () => {
    // The 900k outflow makes 2028 a withdrawal year: the solve takes only
    // what is needed, surplus is ~0, and the transfer (capped at surplus, as
    // it always was) is ~0 with it. The reduction cap works the same way:
    // banking never manufactures cash a year does not have.
    expect(rowFor(res, 2028).investing).toBeLessThan(1);
    expect(rowFor(res, 2028).banked?.investing ?? 0).toBeLessThan(1);
  });

  it('still banks the in-window share when the household holds no brokerage', () => {
    // Out of the window the old rule stands (no brokerage, no transfer); in
    // it, cash can always be parked.
    const noBrokerage = investing();
    noBrokerage.accounts = noBrokerage.accounts.filter((a) => a.type !== 'taxable_brokerage');
    const r2 = run(noBrokerage, scenario(MOVE));
    expect(rowFor(r2, 2026).investing).toBe(0);
    expect(rowFor(r2, 2027).investing).toBeCloseTo(1250 * 7 * (1 + CPI), 6);
    expect(rowFor(r2, 2027).banked?.investing).toBeCloseTo(1250 * 7 * (1 + CPI), 6);
  });

  it('keeps the transfer in the brokerage on a rent-to-the-horizon plan', () => {
    const rentForever = scenario([
      { type: 'sell_house', date: '2027-06' },
      { type: 'rent', start: '2027-06', months: 600, monthlyCost: 3000 },
    ]);
    const r2 = run(investing(), rentForever);
    expect(rowFor(r2, 2027).investing).toBeCloseTo(1250 * 12 * (1 + CPI), 6);
    expect(r2.referencePath.every((r) => r.banked === undefined)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 5. The purchase-funding readout
// ---------------------------------------------------------------------------

describe('the funding trace sums to its total and matches the rows (note 24)', () => {
  const withInvesting = (): Profile => {
    const p = profile({ lines: rentingLines() });
    return { ...p, expenses: { ...p.expenses, investingMonthly: 1250 } };
  };
  const res = run(withInvesting(), scenario(MOVE));
  const f = res.purchaseFunding!;

  it('records the window as the engine ran it', () => {
    expect(f).toBeDefined();
    expect(f.sellDate).toBe('2027-06');
    expect(f.buyDate).toBe('2028-06');
    expect(f.windowMonths).toBe(12);
    expect(f.financing).toBe('cash');
  });

  it('sums the five components to the displayed total, exactly', () => {
    // Same terms in the same order as the engine's own sum, so the equality
    // is bit-exact — the Housing card adds no arithmetic of its own.
    expect(
      f.preExistingSavings +
        f.netSaleProceeds +
        f.bankedInvesting +
        f.bankedLivingReduction +
        f.interestEarned,
    ).toBe(f.totalCash);
    expect(f.surplus).toBe(f.totalCash - f.cashOutflow);
  });

  it('matches every component against the reference path', () => {
    // Pre-existing savings: the balance at the start of the sale year. 2026
    // is a working year (leftovers consumed, interest distributed as cash),
    // so the opening 50,000 is still exactly what the sale year inherits.
    expect(f.preExistingSavings).toBe(50_000);
    // Proceeds: the sale-year row's own figure.
    expect(f.netSaleProceeds).toBe(rowFor(res, 2027).housing.saleProceeds);
    // The banked legs: the sum of the rows' banked blocks.
    const sum = (pick: (b: { investing: number; livingReduction: number }) => number): number =>
      res.referencePath.reduce((n, r) => n + (r.banked === undefined ? 0 : pick(r.banked)), 0);
    expect(f.bankedInvesting).toBeCloseTo(
      sum((b) => b.investing),
      9,
    );
    expect(f.bankedLivingReduction).toBeCloseTo(
      sum((b) => b.livingReduction),
      9,
    );
    // The purchase: the configured 900k, paid in full, in cash.
    expect(f.purchasePrice).toBe(900_000);
    expect(f.cashOutflow).toBe(900_000);
  });

  it('reports interest only for the window, prorating the buy year to the buy month', () => {
    // Bounded rather than re-derived: the exact figure is the engine's
    // (start-of-year balances × the cash yield + the proceeds' partial-year
    // credit), and re-computing it here would just copy the implementation.
    // It must be positive — ~1.3M sat in savings for a year — and less than a
    // full second year of interest on the whole pot.
    expect(f.interestEarned).toBeGreaterThan(0);
    const cashYield =
      (marketJson as { cashYieldNominal?: number }).cashYieldNominal ?? 0.04;
    expect(f.interestEarned).toBeLessThan((f.preExistingSavings + f.netSaleProceeds) * cashYield * 2);
  });

  it('is absent — not zeros — when the plan has no window', () => {
    expect(run(withInvesting(), scenario([])).purchaseFunding).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 6. A death during the window
// ---------------------------------------------------------------------------

describe('after a death the survivor column governs and renting is ignored', () => {
  const withSurvivor = (lines: ExpenseLine[]): ExpenseLine[] =>
    lines.map((l) => (l.id === 'household' ? { ...l, monthlySurvivor: 3000 } : l));

  it('a death DURING the window: digest-identical with and without renting values', () => {
    // Death 2027-09, mid-window. The rule (see the blend site in simulate.ts):
    // from the death YEAR the survivor machinery is the only voice, so the
    // renting column — whose window opens in that same year — never speaks at
    // all, and the whole run is bit-for-bit the run of a budget without it.
    const death: ScenarioEvent = { type: 'death', person: 'p1', date: '2027-09' };
    expect(
      digest(run(profile({ lines: withSurvivor(rentingLines()) }), scenario([...MOVE, death]))),
    ).toBe(
      digest(run(profile({ lines: withSurvivor(strippedLines()) }), scenario([...MOVE, death]))),
    );
  });

  it('a death AFTER the window leaves the window years priced by the column', () => {
    const death: ScenarioEvent = { type: 'death', person: 'p1', date: '2031-03' };
    const res = run(profile({ lines: withSurvivor(rentingLines()) }), scenario([...MOVE, death]));
    // 2027 still blends: the household is intact through the whole window.
    expect(rowFor(res, 2027).expenses.baseline).toBeCloseTo(51_550 * (1 + CPI), 6);
    // And the survivor years afterwards are governed by the survivor factor,
    // exactly as they would be with no renting column anywhere.
    const stripped = run(
      profile({ lines: withSurvivor(strippedLines()) }),
      scenario([...MOVE, death]),
    );
    expect(rowFor(res, 2032).expenses.baseline).toBeCloseTo(
      rowFor(stripped, 2032).expenses.baseline,
      6,
    );
  });
});

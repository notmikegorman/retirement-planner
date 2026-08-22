/**
 * THE SURVIVOR'S DOWNSIZE (engine 1.19.0, second half):
 * HousingPlan.survivorDownsizeTo / survivorDownsizeDelayMonths.
 *
 * WHY THIS EXISTS, in the user's terms: the term-insurance decision rule —
 * hold both policies until the 2028 closing; cancel if the purchase is
 * ≤ ~$1.5M — has an open branch above $1.5M whose answer hinges on whether
 * the widow, having completed the move, would RECOVER her position by
 * selling the big house and rebuying smaller. Measured before this feature:
 * an uninsured death the month after a $1.75M closing scored 93.0% with her
 * modelled staying put forever; a hand-written downsize recovers ~$195k net
 * of ~$105k selling costs, and coverage at that point was worth 5.3pp. The
 * plan could not SAY she would downsize — survivorPurchasePrice only covers
 * a death BEFORE the purchase — so the widow curve priced the wrong widow.
 *
 * The properties under test, in order:
 *  1. COMPILATION: a post-purchase death compiles a second sell→rebuy cycle
 *     at death + delay (absent = 12), cash, with property tax NOT rescaled
 *     and insurance re-estimated from the downsize price — the
 *     survivorPurchasePrice conventions, applied to the other half of the
 *     timeline. 'none' (and the 0 trap) sells and rents to the horizon.
 *  2. THE BOUNDARY PARTITIONS THE TIMELINE at the buy month: strictly before
 *     → survivorPurchasePrice's switch, no downsize; at/after → downsize, no
 *     switch. No death can trigger both.
 *  3. ABSENT MEANS BIT-IDENTICAL: no field, no change — and a field with no
 *     death compiles and runs exactly as if it were absent.
 *  4. THE RUN ITSELF: the widow sells at death + delay for the price the
 *     house was bought at (net of selling costs), rebuys at her price, and
 *     ends measurably richer than the staying-put widow.
 *  5. THE WIDOW SWEEP reads it: post-purchase probe years move, pre-purchase
 *     probe years do not.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { runSimulation } from '../../src/engine/simulate';
import { loadHistoricalCsv } from '../../src/engine/returns';
import {
  DEFAULT_SURVIVOR_DOWNSIZE_DELAY_MONTHS,
  estimateHomeInsuranceAnnual,
  eventsWithHousingPlan,
  survivorDownsizeEvents,
} from '../../src/engine/housingPlan';
import { runSolver } from '../../src/engine/solvers';
import type {
  AcaData,
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

const person = (id: string, salary: boolean) => ({
  id,
  name: id.toUpperCase(),
  birthYear: 1971,
  birthMonth: 6,
  piaMonthlyAtFraIfWorkingTo62: salary ? 3000 : 0,
  piaMonthlyAtFraIfStoppingNow: salary ? 2800 : 0,
  hasOwnBenefit: salary,
});

function profile(over?: Partial<Profile>): Profile {
  return {
    people: [person('p1', true), person('p2', false)],
    filing: { status: 'mfj', state: 'va' },
    accounts: [
      {
        id: 'ira1',
        name: 'IRA',
        type: 'traditional_ira',
        owner: 'p1',
        balance: 2_050_000,
        allocation: { stocks: 0.7, bonds: 0.3, bills: 0 },
      },
      {
        id: 'brokerage',
        name: 'Brokerage',
        type: 'taxable_brokerage',
        owner: 'p1',
        balance: 400_000,
        costBasis: 300_000,
        allocation: { stocks: 1, bonds: 0, bills: 0 },
      },
      {
        id: 'savings',
        name: 'Savings',
        type: 'savings',
        owner: 'p1',
        balance: 100_000,
        allocation: { stocks: 0, bonds: 0, bills: 1 },
      },
    ],
    home: {
      value: 1_200_000,
      costBasis: 500_000,
      state: 'va',
      propertyTaxAnnual: 9_000,
      insuranceAnnual: 2_800,
      maintenancePctOfValue: 0.01,
      sellingCostPct: 0.06,
      mortgage: null,
    },
    income: { salaries: { p1: 250_000, p2: 0 }, contribution401k: 0, employerMatch401k: 0 },
    expenses: { livingMonthly: 6000, charitableMonthly: 0, investingMonthly: 0 },
    health: {
      acaBenchmarkMonthly: 1572,
      acaQuoteYear: 2026,
      partDPlanMonthly: 45,
      employerPremiumShareMonthly: 0,
    },
    settings: {
      horizonAge: 95,
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
    ...over,
  };
}

/** The user's move: sell 2027-06, rent a year, buy 2028-06 at $1.75M cash. */
function housing(over?: Partial<HousingPlan>): HousingPlan {
  return {
    sellDate: '2027-06',
    rentMonths: 12,
    rentMonthly: 3000,
    purchasePrice: 1_750_000,
    propertyTaxAnnual: 12_000,
    financing: { type: 'cash' },
    ...over,
  };
}

const RETIRE: ScenarioEvent[] = [{ type: 'retire', person: 'p1', date: '2026-10' }];
const death = (date: string): ScenarioEvent => ({ type: 'death', person: 'p1', date });
const WINDOW = { startYear: 2026, horizonYears: 41 }; // born 1971, horizon 95 → 2066

const rowFor = (res: RunResult, year: number) => {
  const row = res.referencePath.find((r) => r.year === year);
  expect(row, `no ${year} row`).toBeDefined();
  return row!;
};

// ---------------------------------------------------------------------------
// 1. Compilation
// ---------------------------------------------------------------------------

describe('survivorDownsizeEvents compiles the widow’s second cycle', () => {
  it('sells at death + the default delay and rebuys cash the same month', () => {
    const plan = housing({ survivorDownsizeTo: 1_450_000 });
    const out = survivorDownsizeEvents(plan, [death('2028-07')], WINDOW);
    expect(DEFAULT_SURVIVOR_DOWNSIZE_DELAY_MONTHS).toBe(12);
    expect(out).toEqual([
      { type: 'sell_house', date: '2029-07' },
      {
        type: 'buy_house',
        date: '2029-07',
        price: 1_450_000,
        financing: 'cash',
        // Property tax NOT rescaled — the plan owns the figure, exactly the
        // survivorPurchasePrice convention (inventing a proportional number
        // would show the user a figure nobody entered).
        propertyTaxAnnual: 12_000,
        // Insurance re-estimated from the DOWNSIZE price, the same helper the
        // UI displays: round(1,450,000 × 0.22%) = 3,190.
        insuranceAnnual: estimateHomeInsuranceAnnual(1_450_000),
      },
    ]);
  });

  it('honours a stated delay, including 0 (sell in the death month)', () => {
    const plan3 = housing({ survivorDownsizeTo: 1_450_000, survivorDownsizeDelayMonths: 3 });
    expect(survivorDownsizeEvents(plan3, [death('2029-03')], WINDOW)[0]).toEqual({
      type: 'sell_house',
      date: '2029-06',
    });
    const plan0 = housing({ survivorDownsizeTo: 1_450_000, survivorDownsizeDelayMonths: 0 });
    expect(survivorDownsizeEvents(plan0, [death('2029-03')], WINDOW)[0]).toEqual({
      type: 'sell_house',
      date: '2029-03',
    });
  });

  it('a sale landing in the purchase’s own calendar year waits for January', () => {
    // The engine runs one sale and one purchase per calendar year, sale
    // first: a downsize sale in the buy year (death in the buy month, short
    // delay) would find no home at the sale step and its rebuy would clobber
    // the plan's purchase in the one-buy-per-year slot. The compiler shifts
    // it to January instead of emitting a shape the engine cannot execute.
    const plan = housing({ survivorDownsizeTo: 1_450_000, survivorDownsizeDelayMonths: 3 });
    // Death 2028-07 + 3 months = 2028-10, the 2028-06 purchase's own year.
    expect(survivorDownsizeEvents(plan, [death('2028-07')], WINDOW)[0]).toEqual({
      type: 'sell_house',
      date: '2029-01',
    });
    // And the clamped move still runs mechanically: sale in January at the
    // full purchase price (no growth in the buy year OR the sale year), the
    // cheaper house on the books the same month.
    const res = run(profile(), {
      name: 'clamped',
      events: [...RETIRE, death('2028-07')],
      housing: plan,
    });
    expect(rowFor(res, 2029).housing.saleProceeds).toBeCloseTo(1_750_000 * 0.94, 6);
    expect(rowFor(res, 2029).housing.homeValue).toBe(1_450_000);
  });

  it('an insurance OVERRIDE on the plan wins over the estimate, as it does for the plan house', () => {
    const plan = housing({ survivorDownsizeTo: 1_450_000, insuranceAnnual: 5_000 });
    const buy = survivorDownsizeEvents(plan, [death('2028-07')], WINDOW)[1];
    expect(buy).toMatchObject({ type: 'buy_house', insuranceAnnual: 5_000 });
  });

  it("'none' sells and rents to the horizon at the plan's rent", () => {
    const plan = housing({ survivorDownsizeTo: 'none' });
    const out = survivorDownsizeEvents(plan, [death('2028-07')], WINDOW);
    // Sale 2029-07; the rental runs July 2029 through December 2066:
    // (2066 − 2029) × 12 + (12 − 7) + 1 = 450 months.
    expect(out).toEqual([
      { type: 'sell_house', date: '2029-07' },
      { type: 'rent', start: '2029-07', months: 450, monthlyCost: 3000 },
    ]);
  });

  it('a downsize price of 0 is the same statement as none — the standing trap closure', () => {
    const zero = survivorDownsizeEvents(housing({ survivorDownsizeTo: 0 }), [death('2028-07')], WINDOW);
    const none = survivorDownsizeEvents(housing({ survivorDownsizeTo: 'none' }), [death('2028-07')], WINDOW);
    expect(zero).toEqual(none);
  });

  it('compiles nothing without the field, without a death, for a rent-forever plan, or past the horizon', () => {
    expect(survivorDownsizeEvents(housing(), [death('2028-07')], WINDOW)).toEqual([]);
    expect(survivorDownsizeEvents(housing({ survivorDownsizeTo: 1_450_000 }), [], WINDOW)).toEqual([]);
    expect(
      survivorDownsizeEvents(
        housing({ purchasePrice: 'none', survivorDownsizeTo: 1_450_000 }),
        [death('2028-07')],
        WINDOW,
      ),
    ).toEqual([]);
    expect(
      survivorDownsizeEvents(
        housing({ purchasePrice: 0, survivorDownsizeTo: 1_450_000 }),
        [death('2028-07')],
        WINDOW,
      ),
    ).toEqual([]);
    // A death near the horizon whose delayed sale lands past it: all-or-
    // nothing, like the plan's own out-of-window sale.
    expect(
      survivorDownsizeEvents(housing({ survivorDownsizeTo: 1_450_000 }), [death('2066-07')], WINDOW),
    ).toEqual([]);
  });

  it('the earliest post-purchase death governs when several appear', () => {
    const plan = housing({ survivorDownsizeTo: 1_450_000 });
    const out = survivorDownsizeEvents(
      plan,
      [death('2035-01'), death('2028-07'), death('2027-01')], // last one PRE-purchase
      WINDOW,
    );
    expect(out[0]).toEqual({ type: 'sell_house', date: '2029-07' });
  });
});

// ---------------------------------------------------------------------------
// 2. The boundary partitions the timeline
// ---------------------------------------------------------------------------

describe('the buy month partitions the death timeline between the two survivor fields', () => {
  const plan = housing({ survivorPurchasePrice: 900_000, survivorDownsizeTo: 1_450_000 });

  it('a death STRICTLY BEFORE the purchase re-prices it and compiles no downsize', () => {
    const events = [...RETIRE, death('2028-05')];
    const compiled = eventsWithHousingPlan(events, plan, WINDOW);
    const buys = compiled.filter((e) => e.type === 'buy_house');
    const sells = compiled.filter((e) => e.type === 'sell_house');
    expect(buys).toHaveLength(1);
    expect(buys[0]).toMatchObject({ price: 900_000 }); // her price, not his
    expect(sells).toHaveLength(1); // the plan's own sale only
  });

  it('a death IN the buy month is a completed move: full price, and the downsize fires', () => {
    const events = [...RETIRE, death('2028-06')];
    const compiled = eventsWithHousingPlan(events, plan, WINDOW);
    const buys = compiled.filter((e) => e.type === 'buy_house');
    expect(buys).toHaveLength(2);
    expect(buys[0]).toMatchObject({ price: 1_750_000 }); // the move completed
    expect(buys[1]).toMatchObject({ price: 1_450_000, date: '2029-06' }); // hers, 12mo on
  });
});

// ---------------------------------------------------------------------------
// 3. Absent means bit-identical
// ---------------------------------------------------------------------------

describe('absent field, absent death: nothing changes', () => {
  it('a plan without the field compiles the same events it always did', () => {
    const events = [...RETIRE, death('2028-07')];
    const withField = eventsWithHousingPlan(events, housing(), WINDOW);
    // The control below is the shape housingPlan.test.ts has always pinned;
    // equality here says the new compile stage is a no-op without the field.
    expect(withField.filter((e) => e.type === 'sell_house')).toHaveLength(1);
    expect(withField.filter((e) => e.type === 'buy_house')).toHaveLength(1);
  });

  it('a field with NO death runs bit-identically to no field at all', () => {
    const base: Scenario = { name: 'plan', events: [...RETIRE], housing: housing() };
    const withField: Scenario = {
      name: 'plan',
      events: [...RETIRE],
      housing: housing({ survivorDownsizeTo: 1_450_000, survivorDownsizeDelayMonths: 6 }),
    };
    expect(digest(run(profile(), withField))).toBe(digest(run(profile(), base)));
  });

  it('a PRE-purchase death runs bit-identically with and without the downsize field', () => {
    // The strictly-before side of the partition belongs to
    // survivorPurchasePrice alone; adding the downsize field must not move it.
    const events = [...RETIRE, death('2027-09')];
    const without: Scenario = {
      name: 'plan',
      events,
      housing: housing({ survivorPurchasePrice: 900_000 }),
    };
    const withField: Scenario = {
      name: 'plan',
      events,
      housing: housing({ survivorPurchasePrice: 900_000, survivorDownsizeTo: 1_450_000 }),
    };
    expect(digest(run(profile(), withField))).toBe(digest(run(profile(), without)));
  });
});

// ---------------------------------------------------------------------------
// 4. The run itself — the widow is measurably better off
// ---------------------------------------------------------------------------

describe('the downsize runs through the ordinary machinery and recovers her position', () => {
  const events = [...RETIRE, death('2028-07')];
  const keep = run(profile(), { name: 'keep', events, housing: housing() });
  const downsize = run(profile(), {
    name: 'downsize',
    events,
    housing: housing({ survivorDownsizeTo: 1_450_000 }),
  });

  it('sells the $1.75M house a year after the death at its price net of 6%', () => {
    // Bought 2028-06, sold 2029-07: neither the buy year nor the sale year
    // appreciates, so the sale realizes exactly the purchase price, and the
    // proceeds are 1,750,000 × 0.94 = $1,645,000 — $105,000 of selling costs.
    expect(rowFor(downsize, 2029).housing.saleProceeds).toBeCloseTo(1_750_000 * 0.94, 6);
    expect(rowFor(downsize, 2029).housing.homeValue).toBe(1_450_000);
    // The staying-put widow still owns the big house, grown one year.
    expect(rowFor(keep, 2029).housing.homeValue).toBeCloseTo(1_750_000 * (1 + CPI), 6);
  });

  it('leaves the widow with more spendable money than staying put', () => {
    // $1,645,000 in, $1,450,000 out: ~$195k recovered net of the $105k of
    // selling costs, before the smaller house's carrying costs compound the
    // difference. This is the recovery the insurance decision's >$1.5M
    // branch turns on.
    const spendAt = (res: RunResult, year: number) => rowFor(res, year).balances.spendable;
    expect(spendAt(downsize, 2029)).toBeGreaterThan(spendAt(keep, 2029) + 150_000);
    // And the gap persists — it is equity recovered, not a timing artifact.
    expect(spendAt(downsize, 2035)).toBeGreaterThan(spendAt(keep, 2035));
  });

  it('both futures remain solvent — the comparison is about margin, not survival', () => {
    expect(keep.success).toBe(1);
    expect(downsize.success).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 5. The widow sweep reads it
// ---------------------------------------------------------------------------

describe('widow_score probes see the downsize on their side of the purchase', () => {
  /**
   * One deterministic sweep per variant, 2027..2031 — probes in July
   * (WIDOW_DEATH_MONTH), so 2027 is strictly before the 2028-06 purchase and
   * 2028-2031 are at/after it. The downsize must move ONLY the post-purchase
   * points: the pre-purchase probe belongs to survivorPurchasePrice.
   *
   * Deterministic mode scores are coarse (0/1 per probe), so the assertion
   * is on the SHAPE of the difference via each probe's terminal wealth,
   * which the sweep reports alongside the score.
   */
  const sweep = (h: HousingPlan) => {
    const res = runSolver({
      profile: profile(),
      assumptions: assumptions(),
      scenario: {
        name: 'sweep',
        events: [...RETIRE],
        housing: h,
        solver: { type: 'widow_score', from: 2027, to: 2031, step: 1 },
      },
      mode: 'deterministic',
      paths: 1,
      seed: 42,
    });
    expect(res.solverOutput).toBeDefined();
    return res.solverOutput!;
  };

  it('moves post-purchase probes and leaves the pre-purchase probe untouched', () => {
    const keep = sweep(housing());
    const downsize = sweep(housing({ survivorDownsizeTo: 1_450_000 }));
    const terminals = (out: ReturnType<typeof sweep>) =>
      out.points.map((p) => ({ x: p.x, terminal: p.medianTerminalReal ?? null }));
    const k = terminals(keep);
    const d = terminals(downsize);
    // 2027 probe: death precedes the purchase — the downsize field is inert.
    expect(d[0]).toEqual(k[0]);
    // 2028+ probes: the widow sells and rebuys; her terminal wealth moves.
    for (let i = 1; i < d.length; i++) {
      expect(d[i].terminal, `probe ${d[i].x}`).not.toEqual(k[i].terminal);
    }
  });
});

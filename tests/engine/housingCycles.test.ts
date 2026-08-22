/**
 * N SELL→RENT→BUY CYCLES (engine 1.19.0, first half).
 *
 * THE BUG THIS PINS AGAINST: parseEvents kept only the LAST sell_house — the
 * field was a single `YM | null` slot — so a plan with two cycles silently
 * dropped its FIRST sale. The household never sold, the later buy_house
 * REPLACED the still-owned home (housing.ts: "a buy_house while a home is
 * still owned replaces it"), and the home's entire equity vanished from the
 * balance sheet without a sale. Measured on the user's shape — sell 2027-06,
 * rent 12mo, buy 2028-06 at $1.75M cash, death 2028-07, then the widow's
 * hand-written downsize (sell 2029-07, rent 3mo, buy 2029-10 at $1.45M) —
 * the plan scored 0.0% while ~$1.28M of home-1 equity evaporated in the
 * first buy year and the auto-SEPP busted beside it. The year's own
 * fired-events list said "sell_house" while no sale ran, which is what made
 * it so hard to see by eye.
 *
 * WHY THIS MATTERS BEYOND HAND-WRITTEN EVENTS: the survivor-downsize field
 * (survivorDownsizeTo, the second half of 1.19.0) compiles EXACTLY this
 * two-cycle shape, and the user's term-insurance decision — hold both
 * policies to the 2028 closing; cancel if the purchase is ≤ ~$1.5M — has an
 * open branch above $1.5M whose answer hinges on whether widow-downsizing
 * recovers her position. A two-cycle plan that mechanically breaks cannot
 * price that branch at all.
 *
 * The properties under test, in order:
 *  1. THE PARSER KEEPS EVERY SALE, chronologically, however they are listed.
 *  2. TWO CYCLES RUN MECHANICALLY, hand-reconciled to the dollar: both sales
 *     fire at the grown value net of selling costs, both purchases land, and
 *     the years BEFORE the second cycle are bit-identical to a one-cycle run
 *     (the second cycle is invisible until it starts).
 *  3. THREE CYCLES run the same way — the fix is N, not "two".
 *  4. THE BANKING APPLIES PER WINDOW (notes 23-24): the renting column's
 *     living reduction is banked inside EACH window, not just the first.
 *  5. THE FUNDING STORY NARRATES THE FIRST WINDOW — the Housing card's
 *     readout describes the plan's own move, not the widow's later one.
 *  6. THE 72(t) CALENDAR RESERVE WALKS THE CYCLES: the second scheduled sale
 *     (of the home the first purchase buys, at its known price) is credited
 *     against the second committed purchase, so the election is NOT declined
 *     for a gap the calendar itself pays — the user's repro elects in the
 *     retirement year, never busts, and scores 100%.
 *  7. ORDER INDEPENDENCE: the same events listed in any order digest
 *     identically (the old slot made the LAST listed sale win).
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { runSimulation } from '../../src/engine/simulate';
import { parseEvents } from '../../src/engine/events';
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

/** Deterministic CPI — the home's growth rate too (homeAppreciationRealSpread is 0). */
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

/** The same arithmetic field list the other golden pins hash. */
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

const savings = (balance: number): Account => ({
  id: 'savings',
  name: 'Savings',
  type: 'savings',
  owner: 'p1',
  balance,
  allocation: { stocks: 0, bonds: 0, bills: 1 },
});

/** Bills-only so the balance moves only when money moves — cent-exact sums. */
const brokerage = (balance: number): Account => ({
  id: 'brokerage',
  name: 'Brokerage',
  type: 'taxable_brokerage',
  owner: 'p1',
  balance,
  costBasis: balance,
  allocation: { stocks: 0, bonds: 0, bills: 1 },
});

const ira = (balance: number): Account => ({
  id: 'ira1',
  name: 'IRA',
  type: 'traditional_ira',
  owner: 'p1',
  balance,
  allocation: { stocks: 0.7, bonds: 0.3, bills: 0 },
});

/**
 * Zero carrying costs except the 6% selling convention, so every housing
 * figure in a row is attributable to the events under test and the sale
 * arithmetic is hand-checkable: proceeds = grown value × 0.94.
 */
function profile(over?: Partial<Profile> & { lines?: ExpenseLine[] }): Profile {
  const { lines, ...rest } = over ?? {};
  return {
    people: [person('p1', true), person('p2', false)],
    filing: { status: 'mfj', state: 'va' },
    accounts: [ira(1_500_000), brokerage(300_000), savings(50_000)],
    home: {
      value: 1_000_000,
      costBasis: 1_000_000,
      state: 'va',
      propertyTaxAnnual: 0,
      insuranceAnnual: 0,
      maintenancePctOfValue: 0,
      sellingCostPct: 0.06,
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
      horizonAge: 64, // 2026..2035 — unit-fixture short
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

/** Cycle 1: the couple's own move (the rentingWindow fixture's shape). */
const CYCLE_1: ScenarioEvent[] = [
  { type: 'sell_house', date: '2027-06' },
  { type: 'rent', start: '2027-06', months: 12, monthlyCost: 3000 },
  {
    type: 'buy_house',
    date: '2028-06',
    price: 600_000,
    financing: 'cash',
    propertyTaxAnnual: 0,
    insuranceAnnual: 0,
  },
];

/** Cycle 2: a later downsize, same year sale-and-buy with a 3-month rental. */
const CYCLE_2: ScenarioEvent[] = [
  { type: 'sell_house', date: '2029-07' },
  { type: 'rent', start: '2029-07', months: 3, monthlyCost: 3000 },
  {
    type: 'buy_house',
    date: '2029-10',
    price: 400_000,
    financing: 'cash',
    propertyTaxAnnual: 0,
    insuranceAnnual: 0,
  },
];

/** Salary through every window (retire 2031), 72(t) held out of the way. */
function scenario(events: ScenarioEvent[], over?: Partial<Scenario>): Scenario {
  return {
    name: 'housing-cycles',
    autoSepp: false,
    events: [{ type: 'retire', person: 'p1', date: '2031-07' }, ...events],
    ...over,
  };
}

const rowFor = (res: RunResult, year: number) => {
  const row = res.referencePath.find((r) => r.year === year);
  expect(row, `no ${year} row`).toBeDefined();
  return row!;
};

// ---------------------------------------------------------------------------
// 1. The parser keeps every sale
// ---------------------------------------------------------------------------

describe('parseEvents keeps every sell_house, chronologically', () => {
  it('returns both sales of a two-cycle plan in date order', () => {
    const parsed = parseEvents([...CYCLE_1, ...CYCLE_2]);
    expect(parsed.sellHouses).toEqual([
      { year: 2027, month: 6 },
      { year: 2029, month: 7 },
    ]);
  });

  it('sorts sales listed out of order — the old slot kept whichever came LAST', () => {
    const parsed = parseEvents([...CYCLE_2, ...CYCLE_1]);
    expect(parsed.sellHouses).toEqual([
      { year: 2027, month: 6 },
      { year: 2029, month: 7 },
    ]);
  });

  it('a plan with no sale parses to an empty list', () => {
    expect(parseEvents([]).sellHouses).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 2. Two cycles run mechanically, to the dollar
// ---------------------------------------------------------------------------

describe('a two-cycle plan sells, buys, sells and buys again — hand-reconciled', () => {
  const res = run(profile(), scenario([...CYCLE_1, ...CYCLE_2]));

  it('fires the FIRST sale at the grown value net of selling costs', () => {
    // Owned through 2026, so one year of growth: $1,000,000 × 1.025 =
    // $1,025,000, × 0.94 = $963,500. Under the old parser this year showed
    // "sell_house" in its fired-events list while NO sale ran — proceeds 0,
    // home still on the books.
    expect(rowFor(res, 2027).housing.saleProceeds).toBeCloseTo(1_000_000 * (1 + CPI) * 0.94, 6);
    expect(rowFor(res, 2027).housing.homeValue).toBe(0);
  });

  it('buys the first replacement at its price, which never grows in the buy year', () => {
    expect(rowFor(res, 2028).housing.homeValue).toBe(600_000);
  });

  it('fires the SECOND sale at the first replacement price — no growth yet', () => {
    // Bought mid-2028 (no growth in the buy year), sold mid-2029 (no growth
    // in a sale year): the sale realizes exactly the $600,000 it cost,
    // × 0.94 = $564,000. This is the sale the old parser dropped… no — the
    // old parser dropped the FIRST one and ran this one against a home it
    // should not still have owned. Both must fire for either to mean much.
    expect(rowFor(res, 2029).housing.saleProceeds).toBeCloseTo(600_000 * 0.94, 6);
    expect(rowFor(res, 2029).housing.homeValue).toBe(400_000);
  });

  it('charges the second rental for exactly its three window months', () => {
    // Rent rebased to its own start year: 3 × $3,000 at index 1.0.
    expect(rowFor(res, 2029).housing.rent).toBeCloseTo(3 * 3000, 6);
  });

  it('stays solvent — the equity that used to vanish is on the balance sheet', () => {
    // Deterministic single-path mode: success 1 means the one path was never
    // insolvent in any year. The pre-fix run scored 0.
    expect(res.success).toBe(1);
  });

  it('walks years before the second cycle bit-identically to the one-cycle plan', () => {
    // The second cycle must be INVISIBLE until it starts: 2026-2028 rows of
    // the two-cycle run and the one-cycle run are the same bytes. (The 2029
    // rent event exists in the two-cycle scenario but charges nothing before
    // 2029, and the second window opens at the 2029-07 sale.)
    const oneCycle = run(profile(), scenario([...CYCLE_1]));
    const pre = (r: RunResult) => JSON.stringify(r.referencePath.filter((row) => row.year <= 2028));
    expect(pre(res)).toBe(pre(oneCycle));
  });
});

// ---------------------------------------------------------------------------
// 3. Three cycles — the fix is N, not "two"
// ---------------------------------------------------------------------------

describe('three cycles run end to end', () => {
  const CYCLE_3: ScenarioEvent[] = [
    { type: 'sell_house', date: '2031-06' },
    {
      type: 'buy_house',
      date: '2032-06',
      price: 300_000,
      financing: 'cash',
      propertyTaxAnnual: 0,
      insuranceAnnual: 0,
    },
  ];
  const res = run(profile(), scenario([...CYCLE_1, ...CYCLE_2, ...CYCLE_3]));

  it('fires all three sales at hand-computed values', () => {
    expect(rowFor(res, 2027).housing.saleProceeds).toBeCloseTo(1_000_000 * (1 + CPI) * 0.94, 6);
    expect(rowFor(res, 2029).housing.saleProceeds).toBeCloseTo(600_000 * 0.94, 6);
    // The $400k home bought 2029-10 grows through 2030 (its first full year)
    // and sells mid-2031: $400,000 × 1.025 × 0.94.
    expect(rowFor(res, 2031).housing.saleProceeds).toBeCloseTo(400_000 * (1 + CPI) * 0.94, 6);
    expect(rowFor(res, 2032).housing.homeValue).toBe(300_000);
    expect(res.success).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 4. The banking applies per window
// ---------------------------------------------------------------------------

describe('the renting column banks inside EACH window (notes 23-24)', () => {
  // The rentingWindow fixture's budget: living 4,500/mo, renting 4,150/mo,
  // reduction 350/mo — heating oil and half the electricity stop in an
  // apartment.
  const lines: ExpenseLine[] = [
    { id: 'household', label: 'Household', category: 'living', monthlyNow: 4000 },
    { id: 'oil', label: 'Heating oil', category: 'living', monthlyNow: 200, monthlyRenting: 0 },
    { id: 'electric', label: 'Electricity', category: 'living', monthlyNow: 300, monthlyRenting: 150 },
  ];
  // Cycle 2 spans a year boundary here (sell 2029-07, rent 12, buy 2030-07):
  // banking is recorded out of a year's SURPLUS, and a buy year's purchase
  // outflow swallows it (pre-existing behavior, window 1 included), so the
  // observable banking year is the sale year — which must therefore not also
  // be the buy year.
  const CYCLE_2_SPANNING: ScenarioEvent[] = [
    { type: 'sell_house', date: '2029-07' },
    { type: 'rent', start: '2029-07', months: 12, monthlyCost: 3000 },
    {
      type: 'buy_house',
      date: '2030-07',
      price: 400_000,
      financing: 'cash',
      propertyTaxAnnual: 0,
      insuranceAnnual: 0,
    },
  ];
  const res = run(profile({ lines }), scenario([...CYCLE_1, ...CYCLE_2_SPANNING]));

  it('banks the first window months in the sale year, as it always did', () => {
    // 7 in-window months of 2027 (June-December), $350/mo, one year of CPI.
    expect(rowFor(res, 2027).banked?.livingReduction).toBeCloseTo(350 * 7 * (1 + CPI), 6);
  });

  it('banks the SECOND window months too — the fix, not a leftover', () => {
    // 6 in-window months of 2029 (July-December), $350/mo, three years of
    // CPI. Under a single-window model these months banked nothing: the
    // machinery had one window and it was 2027-2028's.
    expect(rowFor(res, 2029).banked?.livingReduction).toBeCloseTo(350 * 6 * (1 + CPI) ** 3, 6);
  });

  it('banks nothing outside the windows', () => {
    expect(rowFor(res, 2026).banked).toBeUndefined(); // before any window
    expect(rowFor(res, 2031).banked).toBeUndefined(); // both windows closed
  });

  it('a second sale in an intra-year window’s own year opens no phantom window', () => {
    // The one shape only the slot rule stops: cycle 1 opens AND closes inside
    // 2027 (sell March, buy June — a 3-month window), then a second 2027 sale
    // lands in September. It is not inside window 1 (September ≥ June) and
    // window 1 did not span years, but the year's one-sale slot went to March
    // — the September sale never mechanically fires, so the renting blend
    // must price exactly 3 renting months in 2027, not 7.
    const intraYear = run(
      profile({ lines }),
      scenario([
        { type: 'sell_house', date: '2027-03' },
        { type: 'rent', start: '2027-03', months: 3, monthlyCost: 3000 },
        {
          type: 'buy_house',
          date: '2027-06',
          price: 500_000,
          financing: 'cash',
          propertyTaxAnnual: 0,
          insuranceAnnual: 0,
        },
        { type: 'sell_house', date: '2027-09' },
        {
          type: 'buy_house',
          date: '2028-06',
          price: 600_000,
          financing: 'cash',
          propertyTaxAnnual: 0,
          insuranceAnnual: 0,
        },
      ]),
    );
    // 3 renting months (Mar-May) + 9 base months, one year of CPI. A phantom
    // September window would re-price Sep-Dec at the renting figure too.
    expect(rowFor(intraYear, 2027).expenses.baseline).toBeCloseTo(
      (4150 * 3 + 4500 * 9) * (1 + CPI),
      6,
    );
    // And the September "sale" sold nothing: the June house is on the books
    // until the 2028 purchase replaces it (the documented replace semantics
    // for a buy while owned — the event list here is a user error, and the
    // engine's job is to not invent a window for it).
    expect(rowFor(intraYear, 2027).housing.homeValue).toBe(500_000);
  });

  it('a sale the engine cannot run opens no phantom window', () => {
    // A second sell_house in the FIRST window's buy year (2028-09, after the
    // 2028-06 purchase of a window that spanned years): the engine runs one
    // sale per year, BEFORE the buy, so this sale finds no home and never
    // fires — the banking gates must not open for its months. The renting
    // column would otherwise bank Sep-Dec 2028 against a sale that never
    // happened.
    const phantom = run(
      profile({ lines }),
      scenario([
        ...CYCLE_1,
        { type: 'sell_house', date: '2028-09' },
        {
          type: 'buy_house',
          date: '2030-03',
          price: 400_000,
          financing: 'cash',
          propertyTaxAnnual: 0,
          insuranceAnnual: 0,
        },
      ]),
    );
    // No sale fired in 2028-09: the June-bought home is still on the books,
    // grown through 2029.
    expect(rowFor(phantom, 2028).housing.saleProceeds).toBe(0);
    expect(rowFor(phantom, 2029).housing.homeValue).toBeCloseTo(600_000 * (1 + CPI), 6);
    // And 2029 banks nothing — there is no window between the June-2028
    // purchase and the horizon, whatever the dangling buy_house suggests.
    expect(rowFor(phantom, 2029).banked).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 5. The funding story narrates the first window
// ---------------------------------------------------------------------------

describe('purchaseFunding describes the plan’s own move, not the later cycle', () => {
  it('keeps the first window’s dates and months with a second cycle present', () => {
    const res = run(profile(), scenario([...CYCLE_1, ...CYCLE_2]));
    expect(res.purchaseFunding).not.toBeNull();
    expect(res.purchaseFunding!.sellDate).toBe('2027-06');
    expect(res.purchaseFunding!.buyDate).toBe('2028-06');
    expect(res.purchaseFunding!.windowMonths).toBe(12);
    // And the story it tells is the FIRST purchase's: the readout's price is
    // cycle 1's $600k, not cycle 2's $400k.
    expect(res.purchaseFunding!.purchasePrice).toBe(600_000);
  });

  it('is bit-identical to the one-cycle run’s story', () => {
    const two = run(profile(), scenario([...CYCLE_1, ...CYCLE_2]));
    const one = run(profile(), scenario([...CYCLE_1]));
    expect(JSON.stringify(two.purchaseFunding)).toBe(JSON.stringify(one.purchaseFunding));
  });
});

// ---------------------------------------------------------------------------
// 6. The 72(t) calendar reserve walks the cycles — the user's repro
// ---------------------------------------------------------------------------

describe('the auto-SEPP election credits every scheduled sale (the 0.0% repro)', () => {
  /**
   * The user's shape, verbatim from the incident: retire 2026-10 with the
   * IRA dominant, sell 2027-06, rent a year, buy 2028-06 at $1.75M CASH,
   * death 2028-07, then the widow's hand-written downsize — sell 2029-07,
   * rent 3 months, buy 2029-10 at $1.45M cash.
   *
   * WHY THIS EXISTS: the insurance decision rule — hold both term policies
   * until the 2028 closing; cancel if the purchase is ≤ ~$1.5M — has an open
   * branch above $1.5M that only a working widow-downsize model can price
   * (coverage there was measured worth 5.3pp against a 93.0% staying-put
   * score). Before the fix this scenario scored 0.0%: the 2027 sale never
   * ran, ~$1.28M of home-1 equity vanished when the $1.75M purchase replaced
   * the unsold home, and the auto-SEPP busted the same year.
   */
  const repro = (): { profile: Profile; scenario: Scenario } => ({
    profile: profile({
      accounts: [ira(2_050_000), brokerage(400_000), savings(100_000)],
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
    }),
    scenario: {
      name: 'owner-repro',
      // autoSepp ABSENT — on, the whole point.
      events: [
        { type: 'retire', person: 'p1', date: '2026-10' },
        { type: 'sell_house', date: '2027-06' },
        { type: 'rent', start: '2027-06', months: 12, monthlyCost: 3000 },
        {
          type: 'buy_house',
          date: '2028-06',
          price: 1_750_000,
          financing: 'cash',
          propertyTaxAnnual: 12_000,
          insuranceAnnual: 3_850,
        },
        { type: 'death', person: 'p1', date: '2028-07' },
        { type: 'sell_house', date: '2029-07' },
        { type: 'rent', start: '2029-07', months: 3, monthlyCost: 3000 },
        {
          type: 'buy_house',
          date: '2029-10',
          price: 1_450_000,
          financing: 'cash',
          propertyTaxAnnual: 10_000,
          insuranceAnnual: 3_200,
        },
      ],
    },
  });

  const { profile: p, scenario: s } = repro();
  const res = run(p, s);

  it('scores 100% — not 0.0%', () => {
    // Deterministic single-path mode: success 1 means the one path was never
    // insolvent in any year.
    expect(res.success).toBe(1);
  });

  it('elects the series in the retirement year — the reserve walk credits BOTH sales', () => {
    // committedInLock is $1.75M + $1.45M ≈ $3.2M against ~$500k of non-IRA
    // money. Crediting only the first sale (~$1.22M projected) leaves a
    // ~$1.5M phantom gap, grosses it up for tax and penalty, and DECLINES the
    // 2026 election. The walk credits the 2029 sale of the $1.75M house the
    // 2028 purchase buys (~$1.65M), the committed draw is 0, and the election
    // proceeds on the bridge arithmetic alone.
    expect(rowFor(res, 2026).eventsFired).toContain('auto-sepp');
  });

  it('never busts the series — the calendar was priced, not hit', () => {
    for (const row of res.referencePath) {
      expect(row.eventsFired ?? []).not.toContain('sepp-busted');
    }
  });

  it('runs both sales at their hand-computed values', () => {
    // Home 1: $1.2M grown one year, net of 6%: 1,200,000 × 1.025 × 0.94.
    expect(rowFor(res, 2027).housing.saleProceeds).toBeCloseTo(1_200_000 * (1 + CPI) * 0.94, 6);
    // Home 2: bought 2028-06 for $1.75M, sold 2029-07 before any growth
    // (buy year and sale year both skip appreciation): × 0.94 exactly.
    expect(rowFor(res, 2029).housing.saleProceeds).toBeCloseTo(1_750_000 * 0.94, 6);
  });
});

// ---------------------------------------------------------------------------
// 7. Order independence
// ---------------------------------------------------------------------------

describe('event order does not change the answer', () => {
  it('digests identically with the cycles listed second-first', () => {
    // The old slot kept whichever sell_house came LAST in the array, so
    // listing cycle 2 first silently swapped which sale survived.
    const forward = run(profile(), scenario([...CYCLE_1, ...CYCLE_2]));
    const reversed = run(profile(), scenario([...CYCLE_2, ...CYCLE_1]));
    expect(digest(reversed)).toBe(digest(forward));
  });

  it('a second sell_house in an already-sold year is a no-op, windows included', () => {
    // The engine runs one sale per calendar year — the FIRST, the only one
    // with a home to act on. A duplicate 2027-09 sale must change nothing:
    // not the mechanics (the slot ignores it) and not the WINDOWS (it must
    // not claim the second cycle's purchase for a phantom window). The lines
    // give the renting column something to bank, so a phantom window would
    // move the digest.
    const lines: ExpenseLine[] = [
      { id: 'household', label: 'Household', category: 'living', monthlyNow: 4000 },
      { id: 'oil', label: 'Heating oil', category: 'living', monthlyNow: 200, monthlyRenting: 0 },
      { id: 'electric', label: 'Electricity', category: 'living', monthlyNow: 300, monthlyRenting: 150 },
    ];
    const clean = run(profile({ lines }), scenario([...CYCLE_1, ...CYCLE_2]));
    const withDuplicate = run(
      profile({ lines }),
      scenario([...CYCLE_1, { type: 'sell_house', date: '2027-09' }, ...CYCLE_2]),
    );
    // The duplicate DOES appear in the fired-events label list — it was
    // written, and the list reports what the scenario says — so the equality
    // is on the ARITHMETIC: every number in every row, labels excluded.
    const arithmetic = (res: RunResult): string =>
      createHash('sha256')
        .update(
          JSON.stringify({
            success: res.success,
            fan: res.fan,
            medianTerminalReal: res.medianTerminalReal,
            purchaseFunding: res.purchaseFunding ?? null,
            referencePath: res.referencePath.map(({ eventsFired: _fired, ...row }) => row),
          }),
        )
        .digest('hex');
    expect(arithmetic(withDuplicate)).toBe(arithmetic(clean));
  });
});

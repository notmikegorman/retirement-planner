/**
 * The two 72(t) fixes that retired the 0.0% incident (ENGINE 1.17.0):
 *
 * FIX A — THE ELECTION RESPECTS THE CALENDAR: an automatic 72(t) election
 * caps its carve so the un-carved remainder can produce the committed one-off
 * outflows (numeric-price house purchases above all) scheduled inside the
 * prospective lock window, grossed up for the tax and penalty the producing
 * draw will itself owe; an election the cap zeroes is DECLINED that year and
 * re-offered the next.
 *
 * FIX B — BUSTING THE SERIES IS A PRICE, NOT A WALL: a year that cannot be
 * met after every source the withdrawal ordering may touch — the tithe pot's
 * last-resort seat included — busts a live series rather than failing: the
 * lock lifts permanently, the draw proceeds under ordinary penalty rules, and
 * the year is charged the IRC 72(t)(4) recapture (10% of every pre-59 1/2
 * payment, plus interest at the path's own T-bill return per elapsed year).
 *
 * THE HEADLINE PROPERTY (the incident, DECISIONS.md): on the user repro
 * shape — retire 2026-10, a numeric-price cash house purchase in 2028,
 * autoSepp on vs off — ON must score within noise of OFF or better, never
 * zero. An option that exists to HELP can only sanely reduce the score by
 * roughly its penalty costs.
 *
 * EACH FIX IS INDEPENDENTLY LOAD-BEARING (the mutation pair):
 * - A without B: on the repro shape the election caps, the purchase funds,
 *   and NO bust ever fires — the cap alone avoids the zero.
 * - B without A: the same shape under an EXPLICIT start_72t — a hand-written
 *   election is the user asking for exactly that series, so Fix A never
 *   touches it (that is what "A disabled" means for a real plan) — busts in
 *   the purchase year and funds it, avoiding the zero via the price instead.
 *
 * NON-SEPP PLANS ARE BIT-IDENTICAL: pinned by the existing golden digests
 * (mfjUnchanged, both preExpenseLinesUnchanged digests, housingPlan's pins,
 * tithePair's equivalence digests), all of which held across this change
 * WITHOUT a re-pin.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { runSimulation } from '../../src/engine/simulate';
import { loadHistoricalCsv } from '../../src/engine/returns';
import type {
  AcaData,
  Account,
  Assumptions,
  FederalTaxData,
  MarketAssumptions,
  MedicareData,
  Person,
  Profile,
  RmdTableData,
  Scenario,
  SimulationInput,
  SocialSecurityData,
  StateTaxData,
  UntithedPotSetting,
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
  readFileSync(new URL('../../data-defaults/assumptions/historical-returns.csv', import.meta.url), 'utf8'),
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

/** Both born June 1971: 59 1/2 in Dec 2030, penalty-free from 2031 (annual steps). */
function person(id: string, over?: Partial<Person>): Person {
  return {
    id,
    name: id.toUpperCase(),
    birthYear: 1971,
    birthMonth: 6,
    piaMonthlyAtFraIfWorkingTo62: 0,
    piaMonthlyAtFraIfStoppingNow: 0,
    hasOwnBenefit: false,
    ...over,
  };
}

const BILLS = { stocks: 0, bonds: 0, bills: 1 } as const;
/** Deterministic-mode nominal growth of a 100% bills account (matches simulate.test.ts). */
const BILLS_GROW = 1.030125;
/**
 * Fixed-amortization payment per dollar of principal at the default 5% rate
 * and N = 31.6 (single life at attained age 55 in 2026):
 *   19,084.0218 / 300,000 — the constant every hand-computed SEPP golden in
 * simulate.test.ts is built on.
 */
const K55 = 19084.0218 / 300000;

function account(a: Omit<Account, 'name' | 'allocation'> & { name?: string; allocation?: Account['allocation'] }): Account {
  return { name: a.id, allocation: { ...BILLS }, ...a };
}

function profile(over: {
  accounts: Account[];
  annualLiving: number;
  horizonAge: number;
  home?: Partial<Profile['home']>;
  untithedPot?: UntithedPotSetting;
}): Profile {
  const p: Profile = {
    people: [person('p1'), person('p2')],
    filing: { status: 'mfj', state: 'va' },
    accounts: over.accounts,
    home: {
      value: 0,
      costBasis: 0,
      state: 'va',
      propertyTaxAnnual: 0,
      insuranceAnnual: 0,
      maintenancePctOfValue: 0,
      sellingCostPct: 0,
      ...over.home,
    },
    income: { salaries: { p1: 0, p2: 0 }, contribution401k: 0, employerMatch401k: 0 },
    expenses: {
      livingMonthly: over.annualLiving / 12,
      charitableMonthly: 0,
      investingMonthly: 0,
    },
    health: {
      acaBenchmarkMonthly: 0,
      acaQuoteYear: 2026,
      partDPlanMonthly: 0,
      employerPremiumShareMonthly: 0,
    },
    settings: {
      horizonAge: over.horizonAge,
      successTarget: 0.9,
      mcPathsInteractive: 200,
      mcPathsFinal: 200,
      seed: 42,
      spendingPolicy: { type: 'fixed_real' },
      withdrawalPolicy: { order: ['cash', 'taxable', 'pretax', 'roth'], pretaxPreference: 'ira_first' },
    },
  };
  if (over.untithedPot !== undefined) p.expenses.untithedPot = over.untithedPot;
  return p;
}

function input(p: Profile, scenario: Scenario, over?: Partial<SimulationInput>): SimulationInput {
  return {
    profile: p,
    assumptions: assumptions(),
    scenario,
    mode: 'deterministic',
    paths: 1,
    seed: 42,
    ...over,
  };
}

const traceLabels = (row: YearRow): string[] => (row.taxes.trace ?? []).map((l) => l.label);

// ---------------------------------------------------------------------------
// The headline property: the user repro shape
// ---------------------------------------------------------------------------

describe('the 0.0% incident repro: autoSepp ON scores within noise of OFF, never zero', () => {
  /**
   * The incident's shape, scaled to a hand-checkable toy: retire 2026-10
   * before 59 1/2, a $1.75M numeric-price CASH house purchase in 2028-06, a
   * $2.6M IRA and $700k of cash. This is the shape that zeroed the user's
   * plan: the pre-fix election sized its payment to the bridge need alone,
   * carved the principal that payment required into the locked series, and
   * the purchase year was stamped insolvent beside seven figures of IRA the
   * engine refused to touch — autoSepp ON scored 0.0% while OFF scored 69.6%.
   */
  const reproProfile = (): Profile =>
    profile({
      accounts: [
        account({ id: 'ira', type: 'traditional_ira', owner: 'p1', balance: 2_600_000 }),
        account({ id: 'savings', type: 'savings', owner: 'p1', balance: 700_000 }),
      ],
      annualLiving: 60_000,
      horizonAge: 60, // 2026..2031: the purchase, then the rest of the lock
    });
  const reproScenario: Scenario = {
    name: 'repro',
    events: [
      { type: 'retire', person: 'p1', date: '2026-10' },
      {
        type: 'buy_house',
        date: '2028-06',
        price: 1_750_000,
        financing: 'cash',
        propertyTaxAnnual: 0,
        insuranceAnnual: 0,
      },
    ],
  };

  it('FIX A ALONE carries the deterministic path: capped election, purchase funded, no bust', () => {
    const rows = runSimulation(input(reproProfile(), reproScenario)).referencePath;

    // The election fires in the retirement year and the carve is CAPPED by
    // the calendar — the trace says so in the election year.
    expect(rows[0].year).toBe(2026);
    expect(rows[0].eventsFired).toContain('auto-sepp');
    expect(traceLabels(rows[0])).toContain(
      'Carve CAPPED by the calendar: committed outflows inside the lock window',
    );

    // The capped payment is a fraction of what the pre-fix sizing would have
    // elected (the bridge need is ~$45k/yr and the 75%-of-max ceiling ~$124k):
    // the reserve holds back the purchase gap AND the living the reserved
    // cash can no longer carry, both grossed up. The exact closed-form
    // arithmetic is pinned in the tax-free fixture below; here the point is
    // the SHAPE — a small, capped series instead of a purchase-swallowing one.
    const payment = rows[0].withdrawals.byAccount['ira-sepp'];
    expect(payment).toBeGreaterThan(0);
    expect(payment).toBeLessThan(30_000);

    // The purchase year FUNDS — the property the incident violated — and it
    // funds WITHOUT busting the series: Fix A alone avoids the zero.
    expect(rows[2].year).toBe(2028);
    expect(rows[2].expenses.oneTime).toBe(0); // the house is a purchase, not an expense
    for (const row of rows) {
      expect(row.flags).not.toContain('insolvent');
      expect(row.eventsFired).not.toContain('sepp-busted');
    }
  });

  it('FIX B ALONE carries the explicit-election variant: the series busts and the purchase funds', () => {
    /*
     * A hand-written start_72t is the user asking for exactly that series,
     * so Fix A's calendar cap never touches it — the whole IRA goes under
     * the lock, exactly the pre-fix shape. This is "Fix A disabled" for a
     * real plan, and the zero must now be avoided the OTHER way: the 2028
     * purchase busts the series, pays the recapture, and proceeds.
     */
    const rows = runSimulation(
      input(reproProfile(), {
        name: 'repro-explicit',
        events: [
          { type: 'retire', person: 'p1', date: '2026-10' },
          { type: 'start_72t', date: '2026-11', account: 'ira' },
          {
            type: 'buy_house',
            date: '2028-06',
            price: 1_750_000,
            financing: 'cash',
            propertyTaxAnnual: 0,
            insuranceAnnual: 0,
          },
        ],
      }),
    ).referencePath;

    // Whole account locked (no annualAmount -> no split).
    expect(rows[0].balances.byAccount['ira-sepp']).toBeUndefined();
    // The purchase year busts rather than failing beside $2M+ of IRA.
    expect(rows[2].year).toBe(2028);
    expect(rows[2].eventsFired).toContain('sepp-busted');
    expect(traceLabels(rows[2]).some((l) => l.startsWith('72(t) series BUSTED'))).toBe(true);
    // And the path never goes insolvent: the bust is a price, not a failure.
    for (const row of rows) expect(row.flags).not.toContain('insolvent');
    // Permanence: after the bust the IRA is ordinary money — no forced
    // payment, no sepp flag, freely drawn in the years that follow.
    for (let yi = 3; yi < rows.length; yi++) {
      expect(rows[yi].flags).not.toContain('sepp');
    }
    expect(rows.slice(3).some((r) => (r.withdrawals.byAccount['ira'] ?? 0) > 0)).toBe(true);
  });

  it('Monte Carlo: ON scores within noise of OFF or better — never zero', () => {
    const mc = { mode: 'montecarlo' as const, paths: 200 };
    const on = runSimulation(input(reproProfile(), reproScenario, mc));
    const off = runSimulation(
      input(reproProfile(), { ...reproScenario, name: 'repro-off', autoSepp: false }, mc),
    );

    // The incident: ON was 0.0% while OFF scored 69.6%. The fixed engine may
    // trail OFF by at most its penalty costs (noise band), and must never
    // collapse to zero.
    expect(on.success).toBeGreaterThan(0.25);
    expect(on.success).toBeGreaterThanOrEqual(off.success - 0.1);
  });
});

// ---------------------------------------------------------------------------
// Fix A: cap arithmetic, decline-and-re-offer
// ---------------------------------------------------------------------------

describe('Fix A: the calendar-aware carve cap', () => {
  it('caps the carve by the closed-form reserve, remainder equal to it to the cent', () => {
    /*
     * The tax-free zone (the same trick the AUTO_PAYMENT golden uses), so
     * every input to the closed-form cap is hand-known. IRA 300,000, savings
     * 50,000, living 18,000/yr, a 120,000 CASH purchase in 2028-06 — inside
     * the lock window 2026..2031. Living is 18,000 — not the golden's 20,000
     * — because the election-year AGI (target + 1,506.25 of interest) must
     * stay under BOTH the 32,200 federal standard deduction AND Virginia's
     * 17,500 + 1,860 exemptions; at 20,000 of AGI Virginia collects ~$13 and
     * the target stops being hand-exact.
     *
     * TARGET (the bridge need, exactly as the existing golden): the purchase
     * commits every accessible dollar, so the bridge spread is 0 and
     *   T = 18,000 - 1,506.25 (savings interest) - 0 taxes = 16,493.75.
     * THE CAP (the closed-form solve, g = 1/(1 - 0.10 - 0.40) = 2, n = 3
     * years 2026..2028, K = K55):
     *   gap       = 120,000 - 50,000                   =  70,000
     *   numerator = 300,000 - 2 x 70,000 - 2 x 3 x T   =  61,037.50
     *   denom     = 1 - 2 x 3 x K55                    =   0.6183195640
     *   principal = numerator / denom                  =  98,714.0343
     *   payment   = principal x K55                    =   6,279.55
     * (the uncapped request would be min(T, 75% of the 19,084.02 formula
     * maximum) = 14,313.02 — the CALENDAR is the binding cap.) The remainder
     * is the reserve to the cent: 300,000 - 98,714.0343 = 201,285.9657.
     */
    const T = 16_493.75;
    const principal = (300_000 - 2 * 70_000 - 2 * 3 * T) / (1 - 2 * 3 * K55);
    const payment = principal * K55;

    const p = profile({
      accounts: [
        account({ id: 'ira', type: 'traditional_ira', owner: 'p1', balance: 300_000 }),
        account({ id: 'savings', type: 'savings', owner: 'p1', balance: 50_000 }),
      ],
      annualLiving: 18_000,
      horizonAge: 60, // 2026..2031
    });
    const rows = runSimulation(
      input(p, {
        name: 'cap-arithmetic',
        events: [
          { type: 'retire', person: 'p1', date: '2026-07' },
          {
            type: 'buy_house',
            date: '2028-06',
            price: 120_000,
            financing: 'cash',
            propertyTaxAnnual: 0,
            insuranceAnnual: 0,
          },
        ],
      }),
    ).referencePath;

    expect(rows[0].eventsFired).toContain('auto-sepp');
    expect(rows[0].withdrawals.byAccount['ira-sepp']).toBeCloseTo(payment, 4);
    // The remainder keeps the original id and holds the reserve exactly; the
    // 2026 cash need (18,000 - 6,280 payment - 1,506 interest ~ 10.2k) came
    // out of savings, so nothing touched the remainder before growth.
    expect(rows[0].balances.byAccount['ira']).toBeCloseTo((300_000 - principal) * BILLS_GROW, 2);
    expect(rows[0].balances.byAccount['ira-sepp']).toBeCloseTo(
      (principal - payment) * BILLS_GROW,
      2,
    );
    // The election-year trace states the cap and the reserve it held back.
    const cap = (rows[0].taxes.trace ?? []).find((l) =>
      l.label.startsWith('Carve CAPPED by the calendar'),
    );
    expect(cap).toBeDefined();
    expect(cap!.amount).toBeCloseTo(300_000 - principal, 2);
    // And the reserve does its job: the purchase year neither fails nor
    // busts, and no year after it does either.
    expect(rows[2].year).toBe(2028);
    for (const row of rows) {
      expect(row.flags).not.toContain('insolvent');
      expect(row.eventsFired).not.toContain('sepp-busted');
    }
  });

  it('declines the election when the cap leaves no payment, and re-offers next bridge year', () => {
    /*
     * IRA 250,000 and savings 120,000 against a 2,250,000 purchase in
     * 2028-12, funded mostly by SELLING the 2,000,000 home in 2028-06 (the
     * home grows at CPI — homeAppreciationRealSpread is 0 in the shipped
     * assumptions). The projection nets the sale at TODAY's value:
     *   2026: gap = 2,250,000 - 120,000 - 2,000,000 = 130,000; grossed and
     *         joined by the reserved-living term, the reserve overruns the
     *         whole 250,000 IRA -> DECLINED (the trace says so).
     *   2027: the home is worth 2,050,000 now, but the gap (~119k) still
     *         reserves past the IRA -> DECLINED again.
     *   2028: the purchase is this year's own (already excluded), so nothing
     *         is committed ahead — but the banked sale proceeds make the
     *         bridge self-funding, so nothing is elected either.
     *   2029: the proceeds are spent; the bridge finally needs pre-tax money
     *         and the offer — still standing, because a decline never burns
     *         it — is taken.
     */
    const p = profile({
      accounts: [
        account({ id: 'ira', type: 'traditional_ira', owner: 'p1', balance: 250_000 }),
        account({ id: 'savings', type: 'savings', owner: 'p1', balance: 120_000 }),
      ],
      annualLiving: 40_000,
      horizonAge: 58, // 2026..2029
      home: { value: 2_000_000, costBasis: 2_000_000 },
    });
    const rows = runSimulation(
      input(p, {
        name: 'decline-reoffer',
        events: [
          { type: 'retire', person: 'p1', date: '2026-07' },
          { type: 'sell_house', date: '2028-06' },
          {
            type: 'buy_house',
            date: '2028-12',
            price: 2_250_000,
            financing: 'cash',
            propertyTaxAnnual: 0,
            insuranceAnnual: 0,
          },
        ],
      }),
    ).referencePath;

    // 2026 and 2027: declined, with the trace naming the reason.
    for (const yi of [0, 1]) {
      expect(rows[yi].eventsFired).not.toContain('auto-sepp');
      expect(traceLabels(rows[yi])).toContain('Automatic 72(t) election DECLINED this year');
    }
    // The offer survives the declines: exactly one election, after the
    // purchase year has passed.
    const electionYears = rows
      .filter((r) => r.eventsFired.includes('auto-sepp'))
      .map((r) => r.year);
    expect(electionYears).toHaveLength(1);
    expect(electionYears[0]).toBeGreaterThan(2028);
    // A decline is not a failure: the plan stays solvent throughout.
    for (const row of rows) expect(row.flags).not.toContain('insolvent');
  });
});

// ---------------------------------------------------------------------------
// Fix B: recapture arithmetic and ordering
// ---------------------------------------------------------------------------

describe('Fix B: busting a series is a price', () => {
  it('recaptures only pre-59 1/2 payments, and a post-59 1/2 busting draw takes no penalty', () => {
    /*
     * An explicit series started 2028-06 (age 57) locks through 2032 — the
     * later of five payments (2032) and the penalty-free year (2031) — so a
     * 2032 crisis busts AFTER the user turned 59 1/2:
     * - recaptured: the 2028, 2029, 2030 payments (made before 2031), each
     *   with interest at the deterministic bills rate for its elapsed years
     *   (4, 3, 2 respectively);
     * - NOT recaptured: the 2031 and 2032 payments — they were never
     *   penalty-protected, having been made at/after 59 1/2;
     * - the busting draw itself: penalty-free (the user is 61), so the
     *   year's ONLY penalty is the recapture.
     * The IRA compounds untouched at the bills rate until the election, so
     *   B(2028) = 300,000 x 1.030125^2, N(57) = 29.8,
     *   P = B x 0.05 / (1 - 1.05^-29.8).
     */
    const p = profile({
      accounts: [
        account({ id: 'ira', type: 'traditional_ira', owner: 'p1', balance: 300_000 }),
        account({ id: 'savings', type: 'savings', owner: 'p1', balance: 250_000 }),
      ],
      annualLiving: 20_000,
      horizonAge: 62, // 2026..2033
    });
    const rows = runSimulation(
      input(p, {
        name: 'recapture-age',
        events: [
          { type: 'retire', person: 'p1', date: '2026-07' },
          { type: 'start_72t', date: '2028-06', account: 'ira' },
          { type: 'one_time_expense', date: '2032-04', amount: 600_000 },
        ],
      }),
    ).referencePath;

    const B = 300_000 * BILLS_GROW * BILLS_GROW;
    const P = (B * 0.05) / (1 - Math.pow(1.05, -29.8));
    // Sanity: the series paid its fixed P from 2028.
    expect(rows[2].year).toBe(2028);
    expect(rows[2].withdrawals.byAccount['ira']).toBeCloseTo(P, 2);

    // 2032: the crisis busts, and the recapture base is EXACTLY the three
    // pre-59 1/2 payments with their elapsed-year interest.
    const bustRow = rows[6];
    expect(bustRow.year).toBe(2032);
    expect(bustRow.eventsFired).toContain('sepp-busted');
    const expectedBase =
      P * Math.pow(BILLS_GROW, 4) + P * Math.pow(BILLS_GROW, 3) + P * Math.pow(BILLS_GROW, 2);
    const base = (bustRow.taxes.trace ?? []).find((l) => l.label.startsWith('Recapture base'));
    expect(base!.amount).toBeCloseTo(expectedBase, 2);
    // A user is past 59 1/2: the busting draw is penalty-free, so the
    // year's penalties are the recapture and NOTHING else.
    expect(bustRow.taxes.penalties).toBeCloseTo(0.1 * expectedBase, 2);
    expect(bustRow.withdrawals.penaltyBase).toBe(0);
  });

  it('busts only past the tithe pot: the promise absorbs the crisis first', () => {
    /*
     * A soft-window tithe carve-out (the last-resort seat) beside an explicit
     * whole-account series. The withdrawal order for a crisis year is
     * cash -> unlocked pretax -> [tithe seat] -> bust, and the two crisis
     * sizes pin the boundary:
     * - a crisis the unlocked money and the pot can absorb fires NO bust;
     * - a crisis past the pot busts — and the pot is EMPTY in the bust year,
     *   because a promise absorbed is cheaper than a recapture.
     */
    const pot: UntithedPotSetting = { holdYears: 6, earlyRelease: false };
    const mk = (crisis: number): SimulationInput =>
      input(
        profile({
          accounts: [
            account({ id: 'ira1', type: 'traditional_ira', owner: 'p1', balance: 300_000 }),
            account({
              id: 'ira2',
              type: 'traditional_ira',
              owner: 'p1',
              balance: 100_000,
              lifetimeContributions: 0,
            }),
            account({ id: 'savings', type: 'savings', owner: 'p1', balance: 50_000 }),
          ],
          annualLiving: 30_000,
          horizonAge: 62,
          untithedPot: pot,
        }),
        {
          name: `tithe-order-${crisis}`,
          events: [
            { type: 'retire', person: 'p1', date: '2026-07' },
            { type: 'start_72t', date: '2026-08', account: 'ira1' },
            { type: 'one_time_expense', date: '2028-04', amount: crisis },
          ],
        },
      );

    // Leg 1: 60,000 fits inside cash + the unlocked IRA (+ the seat if
    // needed): no bust.
    const small = runSimulation(mk(60_000)).referencePath;
    expect(small.some((r) => r.eventsFired.includes('sepp-busted'))).toBe(false);
    expect(small[2].flags).not.toContain('insolvent');

    // Leg 2: 250,000 exhausts everything the ordering may touch. The bust
    // DECISION honoured the ordering — it fired only after a full solve in
    // which the pot's seat had been drained dry still fell short — and the
    // pot really was tapped in the final ledger too (tithe.drawn > 0, the
    // 'tithe-drawn' flag). The final balance need not be exactly zero: once
    // the bust unlocks the series' money, the re-solve draws it in the
    // ordinary pretax order and takes from the seat only what is STILL
    // missing, which can leave a sliver of the promise standing.
    const big = runSimulation(mk(250_000)).referencePath;
    const bustRow = big.find((r) => r.eventsFired.includes('sepp-busted'));
    expect(bustRow).toBeDefined();
    expect(bustRow!.year).toBe(2028);
    expect(bustRow!.tithe).toBeDefined();
    expect(bustRow!.tithe!.drawn).toBeGreaterThan(0);
    expect(bustRow!.flags).toContain('tithe-drawn');
    expect(bustRow!.flags).not.toContain('insolvent');
    // The lock is lifted for good: ira1 is ordinary money afterwards.
    const after = big.slice(big.indexOf(bustRow!) + 1);
    for (const row of after) expect(row.flags).not.toContain('sepp');
  });
});

/**
 * payoffOverYears — the scheduled pay-down of a financed purchase.
 *
 * The contract under test:
 *
 *   1. THE SCHEDULE ARITHMETIC. Slice k retires balance / slicesLeft of what
 *      is still owed in the slot month; the regular payment carries on between
 *      slices; the last slice clears the loan. Pinned against a hand
 *      computation from the closed-form annuity, and the one-slice schedule is
 *      the old single lump to the float.
 *   2. THE ENGINE CHARGES THE PROJECTION. Slices land in the purchase month,
 *      one a year, at exactly projectedPayoffSchedule's figures; intermediate
 *      years fire 'mortgage-paydown', the last 'mortgage-payoff'; payments and
 *      interest run on the shrinking balance and stop after the last slice.
 *   3. ABSENT = 1 = THE SINGLE LUMP, digest-equal.
 *   4. THE CLAMP: a schedule whose last slice would land at/past the term is
 *      shortened to end in the final year before maturity.
 *   5. A SALE ENDS THE SCHEDULE: the sale's net retires what is owed, and no
 *      later slice fires.
 *   6. THE 72(t) CARVE SEES EVERY SLICE inside the lock window, not just the
 *      first.
 *   7. THE PLAN COMPILER CARRIES THE FIELD.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { runSimulation } from '../../src/engine/simulate';
import { loadHistoricalCsv } from '../../src/engine/returns';
import {
  annuityMonthlyPayment,
  originationPayoff,
  payoffSchedule,
  projectedPayoffLump,
  projectedPayoffSchedule,
} from '../../src/engine/housing';
import { compileHousingPlan } from '../../src/engine/housingPlan';
import type {
  AcaData,
  Account,
  Assumptions,
  FederalTaxData,
  HousingPlan,
  MarketAssumptions,
  MedicareData,
  Person,
  Profile,
  RmdTableData,
  Scenario,
  ScenarioEvent,
  SimulationInput,
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
function person(id: string): Person {
  return {
    id,
    name: id.toUpperCase(),
    birthYear: 1971,
    birthMonth: 6,
    piaMonthlyAtFraIfWorkingTo62: 0,
    piaMonthlyAtFraIfStoppingNow: 0,
    hasOwnBenefit: false,
  };
}

const BILLS = { stocks: 0, bonds: 0, bills: 1 } as const;

function account(a: Omit<Account, 'name' | 'allocation'> & { name?: string }): Account {
  return { name: a.id, allocation: { ...BILLS }, ...a };
}

function profile(over: {
  accounts: Account[];
  annualLiving: number;
  horizonAge: number;
}): Profile {
  return {
    people: [person('p1'), person('p2')],
    filing: { status: 'mfj', state: 'va' },
    accounts: over.accounts,
    home: {
      value: 0, // no starting home: every housing figure comes from the purchase
      costBasis: 0,
      state: 'va',
      propertyTaxAnnual: 0,
      insuranceAnnual: 0,
      maintenancePctOfValue: 0,
      sellingCostPct: 0,
    },
    income: { salaries: { p1: 0, p2: 0 }, contribution401k: 0, employerMatch401k: 0 },
    expenses: { livingMonthly: over.annualLiving / 12, charitableMonthly: 0, investingMonthly: 0 },
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

const digest = (value: unknown): string =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');

const PAYOFF_TRACE = 'Mortgage paid off early — remaining principal in one lump';

const payoffTraceAmount = (row: YearRow): number | null => {
  const line = (row.taxes.trace ?? []).find((l) => l.label === PAYOFF_TRACE);
  return line?.amount ?? null;
};


const sliceTrace = (row: YearRow): number | null => {
  const line = (row.taxes.trace ?? []).find((l) => l.label.startsWith('Mortgage paid off early'));
  return line?.amount ?? null;
};

/** Balance after k level payments on balance b — the closed-form annuity identity. */
function afterPayments(b: number, annualRate: number, pay: number, k: number): number {
  const r = annualRate / 12;
  return b * Math.pow(1 + r, k) - (pay * (Math.pow(1 + r, k) - 1)) / r;
}

// ---------------------------------------------------------------------------
// 1. Schedule arithmetic
// ---------------------------------------------------------------------------

describe('the pay-down schedule: equal shares of what is owed, the payment carrying on between', () => {
  const FIN = { downPct: 0.2, rate: 0.06, termYears: 30, payoffAfterYears: 3 } as const;
  const pay = annuityMonthlyPayment(800_000, 0.06, 30);

  it('one slice is the single lump, to the float', () => {
    const one = projectedPayoffSchedule(1_000_000, FIN);
    expect(one).toHaveLength(1);
    expect(one[0].yearsAfter).toBe(3);
    expect(one[0].amount).toBe(projectedPayoffLump(1_000_000, FIN));
    expect(projectedPayoffSchedule(1_000_000, { ...FIN, payoffOverYears: 1 })).toEqual(one);
  });

  it('three slices match the hand computation and clear the loan', () => {
    const s = projectedPayoffSchedule(1_000_000, { ...FIN, payoffOverYears: 3 });
    expect(s.map((x) => x.yearsAfter)).toEqual([3, 4, 5]);
    // Slot 1: the balance after 36 payments (768,672.5607, pinned in
    // mortgagePayoff.test.ts), one third of it.
    const b36 = afterPayments(800_000, 0.06, pay, 36);
    expect(s[0].amount).toBeCloseTo(b36 / 3, 4);
    // Slot 2: two thirds remain, twelve more level payments, half of that.
    const b48 = afterPayments((b36 * 2) / 3, 0.06, pay, 12);
    expect(s[1].amount).toBeCloseTo(b48 / 2, 4);
    // Slot 3: the rest, after twelve more.
    const b60 = afterPayments(b48 / 2, 0.06, pay, 12);
    expect(s[2].amount).toBeCloseTo(b60, 4);
    // The payment keeps retiring principal between slices, so each slice is
    // a little smaller than the last.
    expect(s[1].amount).toBeLessThan(s[0].amount);
    expect(s[2].amount).toBeLessThan(s[1].amount);
  });

  it('projects a held loan from its own counters (what the carve reads mid-loan)', () => {
    const start = originationPayoff({ termYears: 30, payoffAfterYears: 3, payoffOverYears: 3 });
    const held = {
      balance: afterPayments(800_000, 0.06, pay, 19),
      rate: 0.06,
      monthlyPayment: pay,
      downPctAtOrigination: 0.2,
      monthsElapsed: 19,
      ...start,
    };
    const s = payoffSchedule(held);
    expect(s.map((x) => x.monthsAhead)).toEqual([17, 29, 41]);
    const fromOrigination = projectedPayoffSchedule(1_000_000, { ...FIN, payoffOverYears: 3 });
    s.forEach((x, i) => expect(x.amount).toBeCloseTo(fromOrigination[i].amount, 4));
    // Pure: the state handed in is not advanced.
    expect(held.monthsElapsed).toBe(19);
    expect(held.payoffSlicesLeft).toBe(3);
  });

  it('no payoff, no loan, or a payoff at the term: no slices', () => {
    expect(projectedPayoffSchedule(1_000_000, { downPct: 0.2, rate: 0.06, termYears: 30 })).toEqual([]);
    expect(projectedPayoffSchedule(1_000_000, { ...FIN, downPct: 1, payoffOverYears: 3 })).toEqual([]);
    expect(
      projectedPayoffSchedule(1_000_000, { ...FIN, payoffAfterYears: 30, payoffOverYears: 3 }),
    ).toEqual([]);
  });

  it('clamps a schedule that would run past the term to end in the last year before maturity', () => {
    expect(originationPayoff({ termYears: 10, payoffAfterYears: 8, payoffOverYears: 5 })).toEqual({
      payoffAfterMonths: 96,
      payoffSlicesLeft: 2,
    });
    const s = projectedPayoffSchedule(1_000_000, {
      downPct: 0.2,
      rate: 0.06,
      termYears: 10,
      payoffAfterYears: 8,
      payoffOverYears: 5,
    });
    // Only ONE slice fires: halving the balance in year 8 leaves the regular
    // payment — sized to clear the whole loan by year 10 — to finish the
    // other half before year 9's slot. A prepayment shortens the loan; the
    // schedule never charges a slice on a loan that is already paid.
    expect(s.map((x) => x.yearsAfter)).toEqual([8]);
    // Clamped from 5 to 3 slots (27, 28, 29) on a 30-year loan; near
    // maturity the payment again finishes the last share early, so the
    // schedule may end sooner — but never at or past the term.
    expect(
      originationPayoff({ termYears: 30, payoffAfterYears: 27, payoffOverYears: 5 })
        .payoffSlicesLeft,
    ).toBe(3);
    const long = projectedPayoffSchedule(1_000_000, {
      downPct: 0.2,
      rate: 0.06,
      termYears: 30,
      payoffAfterYears: 27,
      payoffOverYears: 5,
    });
    expect(long[0].yearsAfter).toBe(27);
    for (const sl of long) expect(sl.yearsAfter).toBeLessThan(30);
  });
});

// ---------------------------------------------------------------------------
// 2–5. The engine
// ---------------------------------------------------------------------------

describe('the engine charges the projected slices, one a year in the purchase month', () => {
  const FIN = { downPct: 0.2, rate: 0.06, termYears: 30, payoffAfterYears: 3 } as const;
  const buy = (financing: object): ScenarioEvent => ({
    type: 'buy_house',
    date: '2027-06',
    price: 1_000_000,
    financing: financing as never,
    propertyTaxAnnual: 0,
    insuranceAnnual: 0,
  });
  const p = () =>
    profile({
      accounts: [account({ id: 'savings', type: 'savings', owner: 'p1', balance: 3_000_000 })],
      annualLiving: 24_000,
      horizonAge: 65, // 2026..2036
    });
  const runWith = (financing: object, extra: ScenarioEvent[] = []) =>
    runSimulation(input(p(), { name: 'paydown', events: [buy(financing), ...extra] })).referencePath;
  const rows = runWith({ ...FIN, payoffOverYears: 3 });
  const byYear = new Map(rows.map((r) => [r.year, r]));
  const pay = annuityMonthlyPayment(800_000, 0.06, 30);
  const projected = projectedPayoffSchedule(1_000_000, { ...FIN, payoffOverYears: 3 });

  it('fires pay-down chips in 2030 and 2031 and the payoff chip in 2032', () => {
    for (const row of rows) {
      expect(row.eventsFired.includes('mortgage-paydown'), `paydown ${row.year}`).toBe(
        row.year === 2030 || row.year === 2031,
      );
      expect(row.eventsFired.includes('mortgage-payoff'), `payoff ${row.year}`).toBe(
        row.year === 2032,
      );
    }
  });

  it('charges exactly the projected slices', () => {
    expect(sliceTrace(byYear.get(2030)!)!).toBeCloseTo(projected[0].amount, 6);
    expect(sliceTrace(byYear.get(2031)!)!).toBeCloseTo(projected[1].amount, 6);
    expect(sliceTrace(byYear.get(2032)!)!).toBeCloseTo(projected[2].amount, 6);
    expect(sliceTrace(byYear.get(2029)!)).toBeNull();
    expect(sliceTrace(byYear.get(2033)!)).toBeNull();
  });

  it('keeps paying all twelve months in a slice year, five in the last, none after', () => {
    expect(byYear.get(2030)!.housing.mortgagePayment).toBeCloseTo(12 * pay, 4);
    expect(byYear.get(2031)!.housing.mortgagePayment).toBeCloseTo(12 * pay, 4);
    expect(byYear.get(2032)!.housing.mortgagePayment).toBeCloseTo(5 * pay, 4);
    for (let year = 2033; year <= 2036; year++) {
      expect(byYear.get(year)!.housing.mortgagePayment, `payment in ${year}`).toBe(0);
      expect(byYear.get(year)!.housing.mortgageInterest, `interest in ${year}`).toBe(0);
    }
    // Interest falls with each slice: the 2031 bill is well under 2029's.
    expect(byYear.get(2031)!.housing.mortgageInterest).toBeLessThan(
      0.7 * byYear.get(2029)!.housing.mortgageInterest,
    );
  });

  it('absent and 1 are the single lump, digest-equal', () => {
    const lump = digest(runWith(FIN));
    expect(digest(runWith({ ...FIN, payoffOverYears: 1 }))).toBe(lump);
  });

  it('a sale between slices ends the schedule — the sale net retires the balance', () => {
    const sold = runWith({ ...FIN, payoffOverYears: 3 }, [{ type: 'sell_house', date: '2031-03' }]);
    const y2030 = sold.find((r) => r.year === 2030)!;
    expect(y2030.eventsFired).toContain('mortgage-paydown');
    for (const row of sold.filter((r) => r.year >= 2031)) {
      expect(row.eventsFired).not.toContain('mortgage-paydown');
      expect(row.eventsFired).not.toContain('mortgage-payoff');
    }
    const y2031 = sold.find((r) => r.year === 2031)!;
    // Two thirds of the 2030 balance (less two payments of principal) came
    // off the sale's realized amount.
    expect(y2031.housing.saleProceeds).toBeLessThan(1_000_000 - 0.6 * (2 / 3) * projected[0].amount * 3);
  });
});

// ---------------------------------------------------------------------------
// 6. The 72(t) carve sees every slice
// ---------------------------------------------------------------------------

describe('the automatic 72(t) carve counts every slice inside the lock window', () => {
  // The future-buy fixture from mortgagePayoff.test.ts (tax-free zone, the cap
  // binds and the payment survives), with the payoff after ONE year so a
  // two-slice pay-down puts slices in 2029 AND 2030 — both inside the
  // 2026..2030 lock window.
  const FIN = { downPct: 0.45, rate: 0.06, termYears: 30, payoffAfterYears: 1 } as const;
  const run = (payoffOverYears?: number) => {
    const p = profile({
      accounts: [
        account({ id: 'ira', type: 'traditional_ira', owner: 'p1', balance: 300_000 }),
        account({ id: 'savings', type: 'savings', owner: 'p1', balance: 50_000 }),
      ],
      annualLiving: 18_000,
      horizonAge: 60,
    });
    return runSimulation(
      input(p, {
        name: `paydown-carve-${payoffOverYears ?? 'lump'}`,
        events: [
          { type: 'retire', person: 'p1', date: '2026-07' },
          {
            type: 'buy_house',
            date: '2028-06',
            price: 80_000,
            financing: { ...FIN, ...(payoffOverYears ? { payoffOverYears } : {}) },
            propertyTaxAnnual: 0,
            insuranceAnnual: 0,
          },
        ],
      }),
    ).referencePath;
  };
  const capOf = (rows: YearRow[]): number | undefined =>
    (rows[0].taxes.trace ?? []).find((l) => l.label.startsWith('Carve CAPPED by the calendar'))
      ?.amount;

  it('reserves for both slices — at least what the single lump of the same loan reserves', () => {
    const lump = run();
    const spread = run(2);
    expect(spread[0].eventsFired).toContain('auto-sepp');
    const lumpCap = capOf(lump);
    const spreadCap = capOf(spread);
    expect(lumpCap).toBeDefined();
    expect(spreadCap).toBeDefined();
    // The two slices sum to about the lump (a year of payments apart), and
    // the later slice pushes the last commitment a year out — so the spread
    // reserve is at least the lump's. Counting only the first slice would
    // drop roughly half the gap and land well under it.
    expect(spreadCap!).toBeGreaterThanOrEqual(lumpCap!);
    for (const row of spread) {
      expect(row.flags).not.toContain('insolvent');
      expect(row.eventsFired).not.toContain('sepp-busted');
    }
    expect(spread.find((r) => r.year === 2029)!.eventsFired).toContain('mortgage-paydown');
    expect(spread.find((r) => r.year === 2030)!.eventsFired).toContain('mortgage-payoff');
  });
});

// ---------------------------------------------------------------------------
// 7. The plan compiler
// ---------------------------------------------------------------------------

describe('compileHousingPlan carries payoffOverYears to the buy_house event', () => {
  const plan = (financing: HousingPlan['financing']): HousingPlan => ({
    sellDate: '2027-06',
    rentMonths: 12,
    rentMonthly: 3_000,
    purchasePrice: 900_000,
    propertyTaxAnnual: 7_500,
    financing,
  });

  it('states the pay-down on the compiled event, and keeps an absent one absent', () => {
    const spread = compileHousingPlan(
      plan({ type: 'mortgage', payoffAfterYears: 3, payoffOverYears: 4 }),
    ).find((e) => e.type === 'buy_house')!;
    expect(spread.financing).toMatchObject({ payoffAfterYears: 3, payoffOverYears: 4 });
    const lump = compileHousingPlan(plan({ type: 'mortgage', payoffAfterYears: 3 })).find(
      (e) => e.type === 'buy_house',
    )!;
    expect('payoffOverYears' in (lump.financing as object)).toBe(false);
  });
});

/**
 * payoffAfterYears — the scheduled lump payoff of a financed purchase.
 *
 * The contract under test, end to end:
 *
 *   1. AMORTIZATION ARITHMETIC. remainingBalanceAfterPayments is the engine's
 *      own loop run on a copy, so it must equal the closed-form annuity
 *      balance B(k) = P(1+r)^k - pay x ((1+r)^k - 1)/r — pinned by hand for a
 *      known loan so a regression in either the loop or the closed form is
 *      caught against a constant, not against the other implementation.
 *   2. THE LUMP LANDS IN THE RIGHT YEAR AND EQUALS THAT BALANCE. Origination
 *      June 2027 with payoffAfterYears 3 pays through May 2030 and retires
 *      the remaining principal in June 2030 — the same calendar month, N
 *      years later. Interest, payments and the loan itself stop from that
 *      month; the recorded-cash identity closes with the lump as its own
 *      term, which is the proof it went through the ordinary withdrawal
 *      machinery rather than around it.
 *   3. ABSENT = FULL TERM, BIT-IDENTICAL — and a payoff at/past the term is
 *      the same statement as absent (the engine-clamp ruling in housing.ts):
 *      digest-equal reference paths, no phantom chip.
 *   4. AN UNAFFORDABLE PAYOFF YEAR IS A SHORTFALL, NOT A WALL. The run
 *      completes, the year flags insolvent through the ordinary path, and
 *      the payoff chip still says what was attempted. This codebase has paid
 *      for walls twice (DECISIONS.md, the SEPP 0.0% incident); the lump must
 *      never become the third.
 *   5. THE 72(t) CALENDAR-AWARE CARVE SEES THE LUMP as a committed outflow
 *      inside the lock window, exactly as it sees a numeric-price purchase:
 *      an election beside a scheduled payoff is capped (the trace says so)
 *      and the path funds without busting; the same payoff scheduled BEYOND
 *      the lock window reserves nothing.
 *   6. THE PLAN COMPILER CARRIES THE FIELD to the buy_house event it emits,
 *      and an absent field stays absent (no `payoffAfterYears: undefined`
 *      key to fragment hashes).
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { runSimulation } from '../../src/engine/simulate';
import { loadHistoricalCsv } from '../../src/engine/returns';
import {
  annuityMonthlyPayment,
  projectedPayoffLump,
  remainingBalanceAfterPayments,
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

/** Closed-form annuity balance after k payments — the independent check. */
function closedFormBalance(principal: number, annualRate: number, termYears: number, k: number): number {
  const r = annualRate / 12;
  const pay = annuityMonthlyPayment(principal, annualRate, termYears);
  if (r === 0) return principal - pay * k;
  return principal * Math.pow(1 + r, k) - (pay * (Math.pow(1 + r, k) - 1)) / r;
}

// ---------------------------------------------------------------------------
// 1. Amortization arithmetic, pinned by hand
// ---------------------------------------------------------------------------

describe('remainingBalanceAfterPayments: the engine loop equals the closed form', () => {
  it('matches the hand-pinned balance of an $800,000 loan at 6% over 30 years', () => {
    // Hand-computed (annuity closed form, r = 0.005, n = 360):
    //   monthly payment          = 4,796.404201
    //   balance after 60 months  = 744,434.8546
    //   balance after 36 months  = 768,672.5607
    const monthly = annuityMonthlyPayment(800_000, 0.06, 30);
    expect(monthly).toBeCloseTo(4_796.404201, 4);
    expect(remainingBalanceAfterPayments(800_000, 0.06, monthly, 60)).toBeCloseTo(744_434.8546, 2);
    expect(remainingBalanceAfterPayments(800_000, 0.06, monthly, 36)).toBeCloseTo(768_672.5607, 2);
  });

  it('agrees with the closed form across rates, terms and payment counts', () => {
    for (const [principal, rate, term, k] of [
      [800_000, 0.06, 30, 60],
      [1_400_000, 0.0667, 30, 24],
      [250_000, 0.03, 15, 120],
      [500_000, 0.08, 20, 1],
    ] as const) {
      const monthly = annuityMonthlyPayment(principal, rate, term);
      expect(remainingBalanceAfterPayments(principal, rate, monthly, k)).toBeCloseTo(
        closedFormBalance(principal, rate, term, k),
        4,
      );
    }
  });

  it('handles a 0% note linearly, and a full term to zero', () => {
    const monthly = annuityMonthlyPayment(360_000, 0, 30); // = 1,000/mo
    expect(monthly).toBeCloseTo(1_000, 10);
    expect(remainingBalanceAfterPayments(360_000, 0, monthly, 120)).toBeCloseTo(240_000, 6);
    // Full term amortizes to zero (the min() on the final payment).
    const m6 = annuityMonthlyPayment(800_000, 0.06, 30);
    expect(remainingBalanceAfterPayments(800_000, 0.06, m6, 360)).toBeCloseTo(0, 4);
  });

  it('projectedPayoffLump prices the loan the down payment leaves — and only when a payoff can act', () => {
    const fin = { downPct: 0.2, rate: 0.06, termYears: 30, payoffAfterYears: 5 };
    // $1M price, 20% down -> the $800k loan pinned above, after 60 payments.
    expect(projectedPayoffLump(1_000_000, fin)).toBeCloseTo(744_434.8546, 2);
    // No payoff, payoff at/past term, or no loan at all: null, not zero — the
    // callers use null to mean "no committed lump exists".
    expect(projectedPayoffLump(1_000_000, { downPct: 0.2, rate: 0.06, termYears: 30 })).toBeNull();
    expect(
      projectedPayoffLump(1_000_000, { downPct: 0.2, rate: 0.06, termYears: 30, payoffAfterYears: 30 }),
    ).toBeNull();
    expect(
      projectedPayoffLump(1_000_000, { downPct: 1, rate: 0.06, termYears: 30, payoffAfterYears: 5 }),
    ).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 2. The lump lands in the right year and equals the pinned balance
// ---------------------------------------------------------------------------

describe('the lump lands in the payoff month year and interest stops after it', () => {
  const FIN = { downPct: 0.2, rate: 0.06, termYears: 30, payoffAfterYears: 3 } as const;
  const buy: ScenarioEvent = {
    type: 'buy_house',
    date: '2027-06',
    price: 1_000_000,
    financing: { ...FIN },
    propertyTaxAnnual: 0,
    insuranceAnnual: 0,
  };
  const p = () =>
    profile({
      accounts: [account({ id: 'savings', type: 'savings', owner: 'p1', balance: 3_000_000 })],
      annualLiving: 24_000,
      horizonAge: 65, // 2026..2036
    });
  const rows = runSimulation(input(p(), { name: 'payoff', events: [buy] })).referencePath;
  const byYear = new Map(rows.map((r) => [r.year, r]));
  const monthly = annuityMonthlyPayment(800_000, 0.06, 30);

  it('fires in June 2030 — the purchase month, three years later — and nowhere else', () => {
    for (const row of rows) {
      if (row.year === 2030) expect(row.eventsFired).toContain('mortgage-payoff');
      else expect(row.eventsFired).not.toContain('mortgage-payoff');
    }
  });

  it('pays exactly the hand-pinned remaining balance after 36 payments', () => {
    // 7 payments in 2027 (Jun–Dec), 12 in 2028, 12 in 2029, 5 in 2030
    // (Jan–May) = 36; the lump replaces payment 37 in June 2030.
    const lump = payoffTraceAmount(byYear.get(2030)!);
    expect(lump).not.toBeNull();
    expect(lump!).toBeCloseTo(768_672.5607, 2);
    // And it is the SAME figure the pure projection helper gives the UI/carve.
    expect(lump!).toBeCloseTo(projectedPayoffLump(1_000_000, FIN)!, 6);
  });

  it('amortizes 5 months in the payoff year, full years before, nothing after', () => {
    expect(byYear.get(2029)!.housing.mortgagePayment).toBeCloseTo(12 * monthly, 4);
    expect(byYear.get(2030)!.housing.mortgagePayment).toBeCloseTo(5 * monthly, 4);
    for (let year = 2031; year <= 2036; year++) {
      expect(byYear.get(year)!.housing.mortgagePayment, `payment in ${year}`).toBe(0);
      expect(byYear.get(year)!.housing.mortgageInterest, `interest in ${year}`).toBe(0);
    }
  });

  it('closes the recorded-cash identity with the lump as its own term (the ordinary machinery proof)', () => {
    // Retired household, no forced distributions, no investing stream: for the
    // payoff year the identity is
    //   income + gross withdrawals = expenses.total + taxes + LUMP
    // to the cent. If the lump had bypassed the withdrawal solve (a balance
    // write-down, a phantom expense) this cannot balance.
    const row = byYear.get(2030)!;
    const income =
      row.income.wages +
      row.income.socialSecurity +
      row.income.taxableInterest +
      row.income.dividends +
      row.income.other +
      row.income.retirement;
    const gross =
      row.withdrawals.cash + row.withdrawals.taxable + row.withdrawals.pretax + row.withdrawals.roth;
    const lump = payoffTraceAmount(row)!;
    expect(income + gross).toBeCloseTo(
      row.expenses.total + row.taxes.totalTax + row.investing + row.unbudgeted + lump,
      2,
    );
    // The purchase-year identity carries the DOWN PAYMENT the same way.
    const buyRow = byYear.get(2027)!;
    const buyIncome =
      buyRow.income.wages +
      buyRow.income.socialSecurity +
      buyRow.income.taxableInterest +
      buyRow.income.dividends +
      buyRow.income.other +
      buyRow.income.retirement;
    const buyGross =
      buyRow.withdrawals.cash +
      buyRow.withdrawals.taxable +
      buyRow.withdrawals.pretax +
      buyRow.withdrawals.roth;
    expect(buyIncome + buyGross).toBeCloseTo(
      buyRow.expenses.total + buyRow.taxes.totalTax + buyRow.investing + buyRow.unbudgeted + 200_000,
      2,
    );
  });

  it('keeps the lump OUT of expenses.housing — a capital outflow, not a carrying cost', () => {
    const row = byYear.get(2030)!;
    // Housing expense = 5 payments only (tax/insurance/maintenance are all 0
    // in this toy); nowhere near the ~$768k lump.
    expect(row.expenses.housing).toBeCloseTo(5 * monthly, 4);
  });
});

// ---------------------------------------------------------------------------
// 3. Absent = full term, bit-identical; at/past-term payoff is ignored
// ---------------------------------------------------------------------------

describe('absent payoffAfterYears is bit-identical, and at/past-term is the same statement', () => {
  const buyWith = (payoffAfterYears?: number): ScenarioEvent => ({
    type: 'buy_house',
    date: '2027-06',
    price: 1_000_000,
    financing: {
      downPct: 0.2,
      rate: 0.06,
      termYears: 30,
      ...(payoffAfterYears !== undefined ? { payoffAfterYears } : {}),
    },
    propertyTaxAnnual: 0,
    insuranceAnnual: 0,
  });
  const p = () =>
    profile({
      accounts: [account({ id: 'savings', type: 'savings', owner: 'p1', balance: 3_000_000 })],
      annualLiving: 24_000,
      horizonAge: 65,
    });
  const run = (e: ScenarioEvent) =>
    runSimulation(input(p(), { name: 'clamp', events: [e] })).referencePath;

  it('payoff at the term (30/30) and past it (35/30) are digest-identical to no payoff at all', () => {
    // The schema rejects these when stated; the engine, which can be fed
    // events built in code, IGNORES them (housing.ts: at maturity the
    // schedule already amortizes to zero — a clamp to 29 would invent a lump
    // nobody asked for).
    const absent = run(buyWith());
    expect(digest(run(buyWith(30)))).toBe(digest(absent));
    expect(digest(run(buyWith(35)))).toBe(digest(absent));
    for (const row of absent) expect(row.eventsFired).not.toContain('mortgage-payoff');
  });

  it('a SHORT-term at/past-term payoff is ignored too — where a clamp-to-term-1 lump would land IN-horizon', () => {
    // The 30-year cases above cannot tell "ignored" from "clamped to 29":
    // a clamped lump would land in 2056, far past this fixture's horizon, and
    // the digests would match either way. A 5-year term puts the lump a clamp
    // would invent (after 4 years: June 2031) squarely inside the window, so
    // this digest genuinely pins the IGNORE ruling, not just the horizon.
    const shortTerm = (payoffAfterYears?: number): ScenarioEvent => ({
      type: 'buy_house',
      date: '2027-06',
      price: 1_000_000,
      financing: {
        downPct: 0.2,
        rate: 0.06,
        termYears: 5,
        ...(payoffAfterYears !== undefined ? { payoffAfterYears } : {}),
      },
      propertyTaxAnnual: 0,
      insuranceAnnual: 0,
    });
    const absent = run(shortTerm());
    expect(digest(run(shortTerm(5)))).toBe(digest(absent));
    expect(digest(run(shortTerm(9)))).toBe(digest(absent));
    for (const row of absent) expect(row.eventsFired).not.toContain('mortgage-payoff');
  });

  it('Monte Carlo fan is identical too — the field changes no per-path behaviour when inert', () => {
    const mc = { mode: 'montecarlo' as const, paths: 60 };
    const absent = runSimulation(input(p(), { name: 'clamp', events: [buyWith()] }, mc));
    const atTerm = runSimulation(input(p(), { name: 'clamp', events: [buyWith(30)] }, mc));
    expect(digest(atTerm.fan)).toBe(digest(absent.fan));
    expect(atTerm.success).toBe(absent.success);
  });
});

// ---------------------------------------------------------------------------
// 4. An unaffordable payoff year is a shortfall, not a wall
// ---------------------------------------------------------------------------

describe('a payoff year the portfolio cannot afford degrades to the ordinary shortfall path', () => {
  it('completes the run, flags insolvent, and still stamps the payoff chip for what was attempted', () => {
    const p = profile({
      // $400k of savings against a $200k down payment (2027) and a ~$780k
      // lump (2029): the down payment funds, the lump cannot.
      accounts: [account({ id: 'savings', type: 'savings', owner: 'p1', balance: 400_000 })],
      annualLiving: 12_000,
      horizonAge: 65, // 2026..2036 — years BEYOND the failure must still exist
    });
    const result = runSimulation(
      input(p, {
        name: 'unaffordable',
        events: [
          {
            type: 'buy_house',
            date: '2027-06',
            price: 1_000_000,
            financing: { downPct: 0.2, rate: 0.06, termYears: 30, payoffAfterYears: 2 },
            propertyTaxAnnual: 0,
            insuranceAnnual: 0,
          },
        ],
      }),
    );
    const rows = result.referencePath;
    // The run reaches the horizon — no thrown wall, no truncated path.
    expect(rows.length).toBe(11);
    expect(rows[rows.length - 1].year).toBe(2036);
    // The payoff year (June 2029) is the year the money runs out, through the
    // ordinary insolvency flag every other unaffordable year uses.
    const y2029 = rows.find((r) => r.year === 2029)!;
    expect(y2029.eventsFired).toContain('mortgage-payoff');
    expect(rows.some((r) => r.flags.includes('insolvent'))).toBe(true);
    expect(result.success).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 5. The 72(t) calendar-aware carve sees the lump
// ---------------------------------------------------------------------------

describe('the automatic 72(t) carve treats a scheduled payoff as a committed outflow', () => {
  /**
   * The tax-free-zone shape the existing Fix A cap test uses (income under
   * every bracket, so the mechanics are visible without a tax model in the
   * way): IRA 300,000, savings 50,000, living 18,000/yr, retire 2026-07
   * before 59 1/2, buy 2028-06 at 80,000 with 45% down (36,000 — deliberately
   * UNDER the 50,000 of cash, so the down payment alone commits nothing the
   * cash cannot cover). The only difference between the two runs is WHEN the
   * payoff lands: after 2 years (June 2030, ~$43k — inside the 2026..2031
   * lock window) or after 20 (2048 — decades outside it). If the carve did
   * not see the lump, the two elections would be identical.
   *
   * SIZED SO THE CAP BINDS *AND* THE PAYMENT SURVIVES: the closed-form cap
   * subtracts g x gap + g x n x T from the balance (g = 2, n = 5 years
   * 2026..2030 because the LUMP extends the last-commitment year, T ~ 16.5k),
   * so a gap much above ~65k zeroes the payment and the election is DECLINED
   * outright — a real behaviour, but not the one under test. The ~29k gap
   * this fixture produces sits inside the band where the election fires
   * capped, which is the property the payoff must trigger.
   */
  const FIN = { downPct: 0.45, rate: 0.06, termYears: 30 } as const;
  const run = (payoffAfterYears: number) => {
    const p = profile({
      accounts: [
        account({ id: 'ira', type: 'traditional_ira', owner: 'p1', balance: 300_000 }),
        account({ id: 'savings', type: 'savings', owner: 'p1', balance: 50_000 }),
      ],
      annualLiving: 18_000,
      horizonAge: 60, // 2026..2031: the down payment, then the in-window lump
    });
    return runSimulation(
      input(p, {
        name: `payoff-${payoffAfterYears}`,
        events: [
          { type: 'retire', person: 'p1', date: '2026-07' },
          {
            type: 'buy_house',
            date: '2028-06',
            price: 80_000,
            financing: { ...FIN, payoffAfterYears },
            propertyTaxAnnual: 0,
            insuranceAnnual: 0,
          },
        ],
      }),
    ).referencePath;
  };

  it('caps the election for an in-window payoff — the trace names the reserve — and the path funds', () => {
    const rows = run(2);
    expect(rows[0].year).toBe(2026);
    expect(rows[0].eventsFired).toContain('auto-sepp');
    // The committed outflows are the 36,000 down payment PLUS the ~42,900
    // lump; cash covers 50,000, so ~29k must come from the IRA and the cap
    // fires. Without the lump in committedInLock the gap would be NEGATIVE
    // and no cap could exist at all (the sibling test below proves exactly
    // that).
    const cap = (rows[0].taxes.trace ?? []).find((l) =>
      l.label.startsWith('Carve CAPPED by the calendar'),
    );
    expect(cap).toBeDefined();
    // The reserved remainder holds at least the grossed-up gap the lump
    // created (~2 x 29k).
    expect(cap!.amount!).toBeGreaterThan(55_000);
    // The lump fires in 2030 at the projected figure, and the path neither
    // fails nor busts: the reserve did exactly what Fix A exists to do.
    const y2030 = rows.find((r) => r.year === 2030)!;
    expect(y2030.eventsFired).toContain('mortgage-payoff');
    expect(payoffTraceAmount(y2030)!).toBeCloseTo(
      projectedPayoffLump(80_000, { ...FIN, payoffAfterYears: 2 })!,
      2,
    );
    for (const row of rows) {
      expect(row.flags).not.toContain('insolvent');
      expect(row.eventsFired).not.toContain('sepp-busted');
    }
  });

  /** The election-year SEPP payment, read from the §7 trace line. */
  const seppPaymentOf = (rows: YearRow[]): number => {
    const el = rows.find((r) => r.eventsFired.includes('auto-sepp'))!;
    expect(el).toBeDefined();
    const line = (el.taxes.trace ?? []).find((l) => l.label.startsWith('72(t) SEPP distribution'));
    expect(line?.amount).toBeDefined();
    return line!.amount!;
  };

  it('sees the HELD loan: an election AFTER the purchase reserves for the lump the loan already carries', () => {
    // Same shape as above, but retirement — and with it the election — comes
    // AFTER the buy: the auto-72(t) elects with the mortgage already on the
    // books. At that point the buyByYear loop (which starts at the election
    // year) cannot see the 2027 purchase — only the held-mortgage projection
    // can price the June 2029 lump, in BOTH windows: the bridge projection
    // sizes the payment UP against the lump, and the lock projection caps the
    // carve (the trace says so). Dropping either one is visible here.
    //
    // Sized (160k price, 45% down -> ~85.6k lump; 150k savings run out right
    // at the 2028 election) so the cap BINDS and the payment survives —
    // the same band the future-buy fixture above sits in.
    const runHeld = (payoffAfterYears: number) => {
      const p = profile({
        accounts: [
          account({ id: 'ira', type: 'traditional_ira', owner: 'p1', balance: 300_000 }),
          account({ id: 'savings', type: 'savings', owner: 'p1', balance: 150_000 }),
        ],
        annualLiving: 18_000,
        horizonAge: 62, // 2026..2033: buy 2027, election 2028, lump 2029
      });
      return runSimulation(
        input(p, {
          name: `held-payoff-${payoffAfterYears}`,
          events: [
            { type: 'retire', person: 'p1', date: '2028-07' },
            {
              type: 'buy_house',
              date: '2027-06',
              price: 160_000,
              financing: { ...FIN, payoffAfterYears },
              propertyTaxAnnual: 0,
              insuranceAnnual: 0,
            },
          ],
        }),
      ).referencePath;
    };
    const rows = runHeld(2);
    const electionRow = rows.find((r) => r.eventsFired.includes('auto-sepp'))!;
    expect(electionRow).toBeDefined();
    // The election lands AFTER the purchase year — that ordering is the whole
    // point of this fixture (the future-buy loop cannot see this loan).
    expect(electionRow.year).toBe(2028);
    const cap = (electionRow.taxes.trace ?? []).find((l) =>
      l.label.startsWith('Carve CAPPED by the calendar'),
    );
    expect(cap, 'the held loan’s June 2029 lump must cap the election').toBeDefined();
    // The reserved remainder must hold at least the lump itself (it actually
    // holds the grossed-up IRA gap plus the living top-ups).
    expect(cap!.amount!).toBeGreaterThan(85_000);
    const y2029 = rows.find((r) => r.year === 2029)!;
    expect(y2029.eventsFired).toContain('mortgage-payoff');
    expect(payoffTraceAmount(y2029)!).toBeCloseTo(
      projectedPayoffLump(160_000, { ...FIN, payoffAfterYears: 2 })!,
      2,
    );
    for (const row of rows) {
      expect(row.flags).not.toContain('insolvent');
      expect(row.eventsFired).not.toContain('sepp-busted');
    }
    // Control: the same loan paying off in year 20 commits nothing in-window —
    // the same election fires uncapped, and the payment it sizes is SMALLER
    // (no lump for the bridge to fund). The strict inequality is what proves
    // the bridge-side held-loan projection is live, not just the lock cap.
    const farRows = runHeld(20);
    const far = farRows.find((r) => r.eventsFired.includes('auto-sepp'))!;
    expect(far.year).toBe(2028);
    expect(
      (far.taxes.trace ?? []).some((l) => l.label.startsWith('Carve CAPPED by the calendar')),
    ).toBe(false);
    expect(seppPaymentOf(rows)).toBeGreaterThan(seppPaymentOf(farRows));
  });

  it('sees the FIRED lump: an election in the payoff year itself sizes against the lump being paid', () => {
    // Retirement in the lump year: housing has already FIRED the June 2029
    // lump when the election runs, but the money has not left the balances —
    // the withdrawal solve pays it later that same year. The carve must count
    // hres.mortgagePayoff like this year's one-time expenses, and the visible
    // consequence is the payment sizing UP against the payoff-in-year-20
    // control (whose loan keeps amortizing quietly instead).
    const runFired = (payoffAfterYears: number) => {
      const p = profile({
        accounts: [
          account({ id: 'ira', type: 'traditional_ira', owner: 'p1', balance: 300_000 }),
          account({ id: 'savings', type: 'savings', owner: 'p1', balance: 108_000 }),
        ],
        annualLiving: 18_000,
        horizonAge: 62,
      });
      return runSimulation(
        input(p, {
          name: `fired-lump-${payoffAfterYears}`,
          events: [
            { type: 'retire', person: 'p1', date: '2029-07' },
            {
              type: 'buy_house',
              date: '2027-06',
              price: 80_000,
              financing: { ...FIN, payoffAfterYears },
              propertyTaxAnnual: 0,
              insuranceAnnual: 0,
            },
          ],
        }),
      ).referencePath;
    };
    const rows = runFired(2);
    const y2029 = rows.find((r) => r.year === 2029)!;
    expect(y2029.eventsFired).toContain('mortgage-payoff');
    expect(y2029.eventsFired, 'the election must land in the lump year for this test to bite').toContain(
      'auto-sepp',
    );
    for (const row of rows) {
      expect(row.flags).not.toContain('insolvent');
      expect(row.eventsFired).not.toContain('sepp-busted');
    }
    expect(seppPaymentOf(rows)).toBeGreaterThan(seppPaymentOf(runFired(20)));
  });

  it('reserves nothing for the same payoff scheduled beyond the lock window', () => {
    const rows = run(20);
    expect(rows[0].eventsFired).toContain('auto-sepp');
    // Committed outflows inside the lock are just the 36,000 down payment,
    // fully covered by the 50,000 of cash — no calendar cap, no reserve trace.
    expect(
      (rows[0].taxes.trace ?? []).some((l) => l.label.startsWith('Carve CAPPED by the calendar')),
    ).toBe(false);
    // And no lump fires inside this run's horizon (2048 is beyond 2031).
    for (const row of rows) expect(row.eventsFired).not.toContain('mortgage-payoff');
  });
});

// ---------------------------------------------------------------------------
// 6. The housing-plan compiler carries the field
// ---------------------------------------------------------------------------

describe('compileHousingPlan carries payoffAfterYears to the buy_house event', () => {
  const plan = (financing: HousingPlan['financing']): HousingPlan => ({
    sellDate: '2027-06',
    rentMonths: 12,
    rentMonthly: 3_000,
    purchasePrice: 900_000,
    propertyTaxAnnual: 7_500,
    financing,
  });

  it('states the payoff on the compiled event exactly as the plan wrote it', () => {
    const events = compileHousingPlan(plan({ type: 'mortgage', downPct: 0.24, payoffAfterYears: 7 }));
    const buy = events.find((e) => e.type === 'buy_house')!;
    expect(buy.financing).toMatchObject({ downPct: 0.24, payoffAfterYears: 7 });
  });

  it('keeps an absent field ABSENT — no undefined-valued key to fragment a hash', () => {
    const events = compileHousingPlan(plan({ type: 'mortgage' }));
    const buy = events.find((e) => e.type === 'buy_house')!;
    expect(buy.financing).not.toBe('cash');
    expect('payoffAfterYears' in (buy.financing as object)).toBe(false);
  });
});

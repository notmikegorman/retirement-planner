/**
 * Tests for src/engine/simulate.ts (SPEC §8 engine tests):
 *  1. deterministic 3-year toy series reproduced to the dollar
 *  2. MC determinism: same seed -> bit-identical runKey and fan
 *  3. historical mode path count = rows - horizon + 1
 *  4. forced RMD in 2046 with zero spending need
 *  5. SS claiming factors (62 vs 67, spousal clamped to the worker's filing)
 *  6. PIA by retirement date (note 3): checkpoints + monotonicity across a
 *     retire-year sweep
 *  7. 401(k) -> IRA rollover at separation (note 7)
 *  8. target-date-fund auto-glide (note 8) and its per-account override
 *  9. expense streams: living / charitable / investing + the employee share of
 *     the employer health premium (notes 12, 13), and the scenario-level
 *     assumption_overrides.expenses that replace them for a single run
 * 9b. giving in retirement (note 18): the absent field reproducing today's
 *     numbers bit for bit, 'none', 'percent_of_growth' (hand-computed, a down
 *     year, smoothing, a binding cap), 'percent_of_income', the
 *     retirement-year proration, the charitable deduction, and the automatic
 *     72(t) payment shrinking when the rule cuts giving
 * 9c. paired streams + retirement income (note 19): the owner-shaped profile
 *     reproducing the PRE-CHANGE reference path bit for bit (two pinned
 *     digests), retired living taking over with the retirement year prorated,
 *     retired investing capped by surplus, the 'amount' giving rule, and the
 *     retirement income stream's cash and tax effects (taxable and not)
 * 10. 72(t)/SEPP (note 16): amortization golden, lock window, cap, forced
 *     stream, and the no-extra-draw rule
 * 10b. the AUTOMATIC 72(t) bridge (scenario.autoSepp, absent = ON): when it
 *     elects, the payment sized to the bridge need instead of the formula
 *     maximum, the proportionally smaller carve-out, the collapse in bridge
 *     penalties, an explicit start_72t winning, and a pinned autoSepp:false
 *     baseline proving the toggle-off path is the pre-change engine
 * 10c. surplus reinvestment: the sweep lands in the brokerage (balance AND
 *     basis) and a later sale realizes gains on the raised basis
 * 10d. NOTE 20 — leftover cash while working is CONSUMED, not accumulated:
 *     only the explicit investing stream banks anything while a salary is
 *     coming in, the retirement year follows the working rule whole, a
 *     retired year still reinvests a forced distribution it did not need,
 *     and a shortfall still runs the withdrawal machinery
 * 11. sell_house §121: gain above $500k becomes LTCG; proceeds land in savings
 * 12. recorded-cash conservation identity
 * 13. 1,000-path performance smoke bound
 * 14. THE TITHE ACCOUNT (note 21): the seed's untithed base (present,
 *     absent and underwater contribution figures, and through a 401(k)
 *     rollover), the high-water mark refusing to tithe a recovery, the defer
 *     window giving exactly 0 while the carve-out grows, disbursement
 *     resuming in cash, the carve-out never funding an expense nor rescuing
 *     a failing path (with the break-glass figure that says what that cost),
 *     the RMD still running off the undivided balance, the terminal balance
 *     reported as a charitable legacy, the cash identity, and two fast-check
 *     properties over hand-generated return paths
 *
 * Real data-defaults files are used (JSON imports + fs read of the CSV) with
 * tiny synthetic profiles where hand-computation needs it.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  prepareSim,
  retirementGivingAnnual,
  retirementGivingBase,
  runSimulation,
  simulatePath,
  targetDateMix,
} from '../../src/engine/simulate';
import { effectivePiaMonthly } from '../../src/engine/household';
import { runHousingYear, type HousingState } from '../../src/engine/housing';
import { deterministicPath, loadHistoricalCsv } from '../../src/engine/returns';
import type {
  AcaData,
  Account,
  Assumptions,
  FederalTaxData,
  MarketAssumptions,
  MedicareData,
  Person,
  Profile,
  RetirementGivingRule,
  RmdTableData,
  Scenario,
  SimulationInput,
  SocialSecurityData,
  StateTaxData,
  YearReturns,
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
import profileJson from '../../data-defaults/profile.starter.json';

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

const starterProfile = profileJson as unknown as Profile;

/** Both spouses born June 1971; no Social Security unless a test says otherwise. */
function toyPerson(id: string, over?: Partial<Person>): Person {
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

/** Account with the required display name defaulted from the id. */
function toyAccount(
  a: Omit<Account, 'name'> & { name?: string },
): Account {
  return { name: a.id, ...a };
}

/**
 * Minimal synthetic household: both born 1971-06, no salaries, no SS, no
 * housing costs, no health premiums.
 *
 * `annualLiving` is the ANNUAL living-expense stream (note 12 split the old
 * annualBaseline into three monthly streams, so the fixture stores
 * livingMonthly = annualLiving / 12); charitable and investing default to 0,
 * as does the employee share of the employer health premium, so every
 * pre-existing hand-computed expectation is untouched by the new streams.
 *
 * The retired sides of the pairs (note 19) — livingMonthlyRetired,
 * investingMonthlyRetired — and the retirement income stream are OMITTED
 * unless a test names them, so the fixture keeps producing the pre-pair
 * numbers by default.
 */
function toyProfile(partial?: {
  accounts?: Profile['accounts'];
  annualLiving?: number;
  livingMonthlyRetired?: number;
  lifeInsuranceMonthly?: number;
  charitableMonthly?: number;
  investingMonthly?: number;
  investingMonthlyRetired?: number;
  employerPremiumShareMonthly?: number;
  income?: Profile['income'];
  retirementMonthly?: number;
  retirementIncomeTaxable?: boolean;
  horizonAge?: number;
  people?: Profile['people'];
  home?: Profile['home'];
}): Profile {
  const expenses: Profile['expenses'] = {
    livingMonthly: (partial?.annualLiving ?? 30000) / 12,
    charitableMonthly: partial?.charitableMonthly ?? 0,
    investingMonthly: partial?.investingMonthly ?? 0,
  };
  if (partial?.livingMonthlyRetired !== undefined) {
    expenses.livingMonthlyRetired = partial.livingMonthlyRetired;
  }
  if (partial?.lifeInsuranceMonthly !== undefined) {
    expenses.lifeInsuranceMonthly = partial.lifeInsuranceMonthly;
  }
  if (partial?.investingMonthlyRetired !== undefined) {
    expenses.investingMonthlyRetired = partial.investingMonthlyRetired;
  }
  const income: Profile['income'] = {
    ...(partial?.income ?? { salaries: { p1: 0, p2: 0 }, contribution401k: 0, employerMatch401k: 0 }),
  };
  if (partial?.retirementMonthly !== undefined) income.retirementMonthly = partial.retirementMonthly;
  if (partial?.retirementIncomeTaxable !== undefined) {
    income.retirementIncomeTaxable = partial.retirementIncomeTaxable;
  }
  return {
    people: partial?.people ?? [toyPerson('p1'), toyPerson('p2')],
    filing: { status: 'mfj', state: 'va' },
    accounts: partial?.accounts ?? [
      toyAccount({
        id: 'savings',
        name: 'savings',
        type: 'savings',
        owner: 'p1',
        balance: 200000,
        allocation: { stocks: 0, bonds: 0, bills: 1 },
      }),
    ],
    home: partial?.home ?? {
      value: 0,
      costBasis: 0,
      state: 'va',
      propertyTaxAnnual: 0,
      insuranceAnnual: 0,
      maintenancePctOfValue: 0,
      sellingCostPct: 0,
      mortgage: null,
    },
    income,
    expenses,
    health: {
      acaBenchmarkMonthly: 0,
      acaQuoteYear: 2026,
      partDPlanMonthly: 0,
      employerPremiumShareMonthly: partial?.employerPremiumShareMonthly ?? 0,
    },
    settings: {
      horizonAge: partial?.horizonAge ?? 57,
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

function simInput(profile: Profile, scenario: Scenario, over?: Partial<SimulationInput>): SimulationInput {
  return {
    profile,
    assumptions: assumptions(),
    scenario,
    mode: 'deterministic',
    paths: 1,
    seed: 42,
    ...over,
  };
}

// Deterministic nominal bills return: (1 + 0.005 real) x (1 + 0.025 infl) - 1,
// minus the 0 bills expense ratio = 0.030125.
const BILLS_NOM = (1 + 0.005) * (1 + 0.025) - 1;

describe('deterministic 3-year toy series (hand-computed to the dollar)', () => {
  it('reproduces savings balances, zero tax, and real-dollar conversion', () => {
    // Profile: one savings account of 200,000 (bills), fixed real spending
    // 30,000/yr, no income besides distributed savings interest, VA.
    // Horizon: age 57 -> 2028 -> three years 2026..2028.
    //
    // Interest is DISTRIBUTED cash (balance never compounds); withdrawals
    // come from savings; federal AGI stays under the 32,200 standard
    // deduction and VA taxable under the 17,500 VA standard deduction +
    // 2 x 930 exemptions, so every year's tax is exactly 0.
    //
    // 2026 (CPI index 1):
    //   interest = 200,000 x 0.030125            =   6,025.00
    //   spending = 30,000 x 1                     =  30,000.00
    //   withdrawal = 30,000 - 6,025               =  23,975.00
    //   end balance = 200,000 - 23,975            = 176,025.00
    // 2027 (index 1.025):
    //   interest = 176,025 x 0.030125             =   5,302.753125
    //   spending = 30,000 x 1.025                 =  30,750.00
    //   withdrawal = 30,750 - 5,302.753125        =  25,447.246875
    //   end balance = 176,025 - 25,447.246875     = 150,577.753125
    // 2028 (index 1.025^2 = 1.050625):
    //   interest = 150,577.753125 x 0.030125      =   4,536.154813
    //   spending = 30,000 x 1.050625              =  31,518.75
    //   withdrawal = 31,518.75 - 4,536.154813     =  26,982.595187
    //   end balance = 150,577.753125 - 26,982.595187 = 123,595.157938
    const result = runSimulation(simInput(toyProfile(), { name: 'toy', events: [] }));
    const rows = result.referencePath;
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.year)).toEqual([2026, 2027, 2028]);

    let bal = 200000;
    let idx = 1;
    const expected: Array<{ interest: number; withdrawal: number; end: number; idx: number }> = [];
    for (let y = 0; y < 3; y++) {
      const interest = bal * BILLS_NOM;
      const spending = 30000 * idx;
      const withdrawal = spending - interest;
      bal -= withdrawal;
      expected.push({ interest, withdrawal, end: bal, idx });
      idx *= 1.025;
    }

    for (let y = 0; y < 3; y++) {
      const row = rows[y];
      expect(row.taxes.totalTax).toBe(0); // AGI below every deduction
      expect(row.taxes.aca?.netPremium ?? 0).toBe(0); // benchmark quote is 0
      expect(row.income.taxableInterest).toBeCloseTo(expected[y].interest, 6);
      expect(row.expenses.baseline).toBeCloseTo(30000 * expected[y].idx, 6);
      expect(row.withdrawals.cash).toBeCloseTo(expected[y].withdrawal, 6);
      expect(row.balances.byAccount['savings']).toBeCloseTo(expected[y].end, 6);
      expect(row.balances.total).toBeCloseTo(expected[y].end, 6);
      expect(row.inflationIndex).toBeCloseTo(expected[y].idx, 12);
      expect(row.balances.totalReal).toBeCloseTo(expected[y].end / expected[y].idx, 6);
      expect(row.flags).toEqual([]);
    }
    // 2028 end balance to the dollar: 123,595.16.
    expect(rows[2].balances.total).toBeCloseTo(123595.157938, 4);
    expect(result.success).toBe(1);
  });
});

describe('Monte Carlo determinism (SPEC §8: fixed seed is bit-identical)', () => {
  it('same seed twice -> identical runKey and bit-identical fan', () => {
    const scenario: Scenario = {
      name: 'mc-determinism',
      assumption_overrides: { settings: { horizonAge: 60 } },
      events: [
        { type: 'retire', person: 'p1', date: '2026-07' },
        { type: 'retire', person: 'p2', date: '2026-07' },
      ],
    };
    const run = () =>
      runSimulation(simInput(starterProfile, scenario, { mode: 'montecarlo', paths: 60, seed: 12345 }));
    const a = run();
    const b = run();
    expect(a.meta.runKey).toBe(b.meta.runKey);
    expect(JSON.stringify(a.fan)).toBe(JSON.stringify(b.fan));
    expect(a.success).toBe(b.success);
    expect(a.medianTerminalReal).toBe(b.medianTerminalReal);
    expect(a.meta.paths).toBe(60);

    // A different seed changes the runKey (and, in practice, the fan).
    const c = runSimulation(
      simInput(starterProfile, scenario, { mode: 'montecarlo', paths: 60, seed: 54321 }),
    );
    expect(c.meta.runKey).not.toBe(a.meta.runKey);
  });
});

describe('historical mode', () => {
  it('path count = rows - horizon + 1 (input.paths ignored)', () => {
    const scenario: Scenario = {
      name: 'hist',
      assumption_overrides: { settings: { horizonAge: 60 } }, // horizon 2037 -> 12 years
      events: [
        { type: 'retire', person: 'p1', date: '2026-07' },
        { type: 'retire', person: 'p2', date: '2026-07' },
      ],
    };
    const result = runSimulation(
      simInput(starterProfile, scenario, { mode: 'historical', paths: 999 }),
    );
    expect(result.horizonYears).toBe(12);
    expect(result.meta.paths).toBe(historical.length - 12 + 1);
    expect(result.fan.years).toHaveLength(12);
    expect(result.fan.years[0]).toBe(2026);
    // The reference path is the traced deterministic companion.
    expect(result.referencePath).toHaveLength(12);
    expect(result.referencePath[0].taxes.trace).toBeDefined();
  });
});

describe('forced RMDs at age 75 (year 2046)', () => {
  it('takes prior-year-end pretax balance / 24.6 with zero spending need', () => {
    const profile = toyProfile({
      accounts: [
        {
          id: 'ira',
          name: 'ira',
          type: 'traditional_ira',
          owner: 'p1',
          balance: 200000,
          allocation: { stocks: 1, bonds: 0, bills: 0 },
        },
        {
          id: 'savings',
          name: 'savings',
          type: 'savings',
          owner: 'p1',
          balance: 100000,
          allocation: { stocks: 0, bonds: 0, bills: 1 },
        },
      ],
      annualLiving: 0, // zero spending: the RMD must still be forced
      horizonAge: 75, // horizon 2046: 21 years, 2046 is index 20
    });
    const result = runSimulation(simInput(profile, { name: 'rmd', events: [] }));
    const rows = result.referencePath;
    expect(rows).toHaveLength(21);

    const row2045 = rows[19];
    const row2046 = rows[20];
    expect(row2045.withdrawals.rmd).toBe(0); // age 74: not yet
    // Age at end of 2046 = 75 -> divisor 24.6 on the prior-Dec-31 balance.
    const expectedRmd = row2045.balances.byAccount['ira'] / 24.6;
    expect(row2046.withdrawals.rmd).toBeCloseTo(expectedRmd, 6);
    expect(expectedRmd).toBeGreaterThan(0);
    // The RMD is a forced pretax distribution even though spending is zero.
    expect(row2046.withdrawals.pretax).toBeCloseTo(expectedRmd, 6);
    expect(row2046.withdrawals.byAccount['ira']).toBeCloseTo(expectedRmd, 6);
    // It is forced ordinary income: taxable income appears despite no spending.
    expect(row2046.taxes.federal.agi).toBeGreaterThan(expectedRmd * 0.9);
  });
});

describe('Social Security claiming factors flow through (COLA = simulated CPI)', () => {
  const people: Profile['people'] = [
    { id: 'p1', name: 'P1', birthYear: 1971, birthMonth: 6, piaMonthlyAtFraIfWorkingTo62: 2000, piaMonthlyAtFraIfStoppingNow: 2000, hasOwnBenefit: true },
    { id: 'p2', name: 'P2', birthYear: 1971, birthMonth: 6, piaMonthlyAtFraIfWorkingTo62: 0, piaMonthlyAtFraIfStoppingNow: 0, hasOwnBenefit: false },
  ];
  const accounts: Profile['accounts'] = [
    {
      id: 'savings',
      name: 'savings',
      type: 'savings',
      owner: 'p1',
      balance: 2000000,
      allocation: { stocks: 0, bonds: 0, bills: 1 },
    },
  ];

  it('claim at 62: factor 0.70, prorated 7 months in the claim year', () => {
    // FRA 67, claim 2033-06 at exactly 62y0m -> 60 months early:
    // reduction = 36 x 5/9% + 24 x 5/12% = 20% + 10% = 30% -> factor 0.70.
    const profile = toyProfile({ people, accounts, annualLiving: 40000, horizonAge: 63 });
    const result = runSimulation(
      simInput(profile, {
        name: 'ss62',
        events: [{ type: 'claim_social_security', person: 'p1', date: '2033-06' }],
      }),
    );
    const rows = result.referencePath;
    const idx2033 = Math.pow(1.025, 7); // cumulative CPI at the start of 2033
    const idx2034 = Math.pow(1.025, 8);
    // 2033: 7 months (June-Dec) x 2,000 x 0.70 x COLA index.
    expect(rows[7].income.socialSecurity).toBeCloseTo(2000 * 0.7 * 7 * idx2033, 4);
    // 2034: full year, 2,000 x 0.70 x 12 x COLA index.
    expect(rows[8].income.socialSecurity).toBeCloseTo(2000 * 0.7 * 12 * idx2034, 4);
  });

  it('claim at FRA 67: factor 1.00, and the spousal benefit is clamped to the worker filing', () => {
    // p1 files 2038-06 at 67 (factor 1.0). p2's spousal claim is dated
    // 2033-06 but CANNOT start before the worker files -> clamped to
    // 2038-06; at p2's age 67 the spousal factor is the full 50% of the
    // worker PIA (no delayed credits on spousal).
    const profile = toyProfile({ people, accounts, annualLiving: 40000, horizonAge: 68 });
    const result = runSimulation(
      simInput(profile, {
        name: 'ss67',
        events: [
          { type: 'claim_social_security', person: 'p1', date: '2038-06' },
          { type: 'claim_social_security', person: 'p2', date: '2033-06' },
        ],
      }),
    );
    const rows = result.referencePath;
    // 2037 (index 11): nothing yet — the spousal claim did NOT start in 2033.
    expect(rows[11].income.socialSecurity).toBe(0);
    // 2039 (full year, index 13): (2,000 x 1.0 + 2,000 x 0.5) x 12 x COLA.
    const idx2039 = Math.pow(1.025, 13);
    expect(rows[13].income.socialSecurity).toBeCloseTo((2000 + 1000) * 12 * idx2039, 4);
  });
});

describe('PIA by retirement date (note 3)', () => {
  // Statement figure (keeps earning to 62) 3,000/mo; $0-future-earnings
  // figure 2,400/mo. Born 1971 -> age 62 in 2033; sim starts 2026.
  const p1 = toyPerson('p1', {
    piaMonthlyAtFraIfWorkingTo62: 3000,
    piaMonthlyAtFraIfStoppingNow: 2400,
    hasOwnBenefit: true,
  });
  const p2 = toyPerson('p2'); // no credits: spousal only

  it('effectivePiaMonthly interpolates linearly between the two SSA figures', () => {
    // Never retiring, or retiring at/after 62, earns the statement figure.
    expect(effectivePiaMonthly(p1, null)).toBe(3000);
    expect(effectivePiaMonthly(p1, 2033)).toBe(3000);
    expect(effectivePiaMonthly(p1, 2040)).toBe(3000);
    // Retiring in (or before) the first simulated year earns the $0-earnings figure.
    expect(effectivePiaMonthly(p1, 2026)).toBe(2400);
    expect(effectivePiaMonthly(p1, 2020)).toBe(2400);
    // In between: fraction of the 7 years 2026->2033 actually worked.
    //   2029 -> 3/7:  2,400 + 600 x 3/7 = 2,400 + 257.142857 = 2,657.142857
    //   2030 -> 4/7:  2,400 + 600 x 4/7 = 2,400 + 342.857143 = 2,742.857143
    //   2032 -> 6/7:  2,400 + 600 x 6/7 = 2,400 + 514.285714 = 2,914.285714
    expect(effectivePiaMonthly(p1, 2029)).toBeCloseTo(2657.142857, 6);
    expect(effectivePiaMonthly(p1, 2030)).toBeCloseTo(2742.857143, 6);
    expect(effectivePiaMonthly(p1, 2032)).toBeCloseTo(2914.285714, 6);
  });

  it('the sweep of retirement years produces monotonically larger benefits', () => {
    // Both claim at FRA (2038-06, factor 1.00 worker / 0.50 spousal off the
    // WORKER's effective PIA), so 2039 is a full benefit year:
    //   household monthly = pia x (1 + 0.5) = 1.5 x pia
    //   2039 income       = 1.5 x pia x 12 x CPI index (1.025^13)
    const idx2039 = Math.pow(1.025, 13);
    const ssIn2039 = (retireYear: number): number => {
      const profile = toyProfile({
        people: [p1, p2],
        accounts: [
          toyAccount({
            id: 'savings',
            type: 'savings',
            owner: 'p1',
            balance: 2000000,
            allocation: { stocks: 0, bonds: 0, bills: 1 },
          }),
        ],
        income: { salaries: { p1: 100000, p2: 0 }, contribution401k: 0, employerMatch401k: 0 },
        annualLiving: 40000,
        horizonAge: 68, // 2026..2039
      });
      const result = runSimulation(
        simInput(profile, {
          name: `retire-${retireYear}`,
          events: [
            { type: 'retire', person: 'p1', date: `${retireYear}-07` },
            { type: 'retire', person: 'p2', date: `${retireYear}-07` },
            { type: 'claim_social_security', person: 'p1', date: '2038-06' },
            { type: 'claim_social_security', person: 'p2', date: '2038-06' },
          ],
        }),
      );
      const row2039 = result.referencePath[13];
      expect(row2039.year).toBe(2039);
      return row2039.income.socialSecurity;
    };

    // Checkpoints: 2,400 stopping now, the 3/7 interpolation, 3,000 at 62.
    expect(ssIn2039(2026)).toBeCloseTo(1.5 * 2400 * 12 * idx2039, 4);
    expect(ssIn2039(2029)).toBeCloseTo(1.5 * 2657.142857 * 12 * idx2039, 3);
    expect(ssIn2039(2033)).toBeCloseTo(1.5 * 3000 * 12 * idx2039, 4);

    // The whole sweep: retiring later never lowers the benefit, and the
    // endpoints differ (the bias the old single-PIA field hid).
    const sweep = [2026, 2027, 2028, 2029, 2030, 2031, 2032, 2033].map(ssIn2039);
    for (let i = 1; i < sweep.length; i++) {
      expect(sweep[i]).toBeGreaterThan(sweep[i - 1]);
    }
    expect(sweep[sweep.length - 1] / sweep[0]).toBeCloseTo(3000 / 2400, 10);
  });
});

describe('401(k) -> IRA rollover at separation (note 7)', () => {
  /**
   * p1 earns 120,000 with a 12,000 deferral + 6,000 match, retires 2027-07
   * (6 worked months). Every account is 100% bills, so balances compound at
   * exactly 1.030125 and nothing is withdrawn (salary + savings cover
   * spending — asserted below).
   *
   * 2026: k401 = (100,000 + 12,000 deferral + 6,000 match) x 1.030125
   *            = 118,000 x 1.030125            = 121,554.75
   *       ira1 = 50,000 x 1.030125             =  51,506.25
   * 2027: rollover at the top of the year merges the 401(k) into the IRA:
   *       ira1 = 51,506.25 + 121,554.75        = 173,061.00, k401 = 0
   *       that year's prorated contributions follow the money into the IRA:
   *       deferral min(12,000 x 6/12, wages) = 6,000 + match 3,000 = 9,000
   *       ira1 = (173,061 + 9,000) x 1.030125  = 187,545.587625
   *
   * autoSepp is OFF in both scenarios below. Retiring in 2027 is before the
   * 2031 penalty-free year, so the automatic bridge would otherwise elect —
   * and since note 20 stopped working years from banking their leftover pay,
   * the 100,000 of savings no longer looks like enough to self-fund the
   * bridge, so it now genuinely does elect. A carve-out splitting the
   * destination IRA would make the rollover arithmetic above untestable, and
   * the bridge has its own eight-test describe block; this one is about the
   * rollover.
   */
  const accounts = (): Profile['accounts'] => [
    toyAccount({
      id: 'k401',
      name: "P1's 401(k)",
      type: '401k',
      owner: 'p1',
      balance: 100000,
      allocation: { stocks: 0, bonds: 0, bills: 1 },
      currentEmployer: true,
    }),
    toyAccount({
      id: 'ira1',
      type: 'traditional_ira',
      owner: 'p1',
      balance: 50000,
      allocation: { stocks: 0, bonds: 0, bills: 1 },
    }),
    toyAccount({
      id: 'savings',
      type: 'savings',
      owner: 'p1',
      balance: 100000,
      allocation: { stocks: 0, bonds: 0, bills: 1 },
    }),
  ];

  it('merges the 401(k) into the traditional IRA in the retirement year', () => {
    const profile = toyProfile({
      accounts: accounts(),
      income: { salaries: { p1: 120000, p2: 0 }, contribution401k: 12000, employerMatch401k: 6000 },
      annualLiving: 30000,
      horizonAge: 57, // 2026..2028
    });
    const rows = runSimulation(
      simInput(profile, {
        name: 'rollover',
        autoSepp: false,
        events: [{ type: 'retire', person: 'p1', date: '2027-07' }],
      }),
    ).referencePath;
    const [r26, r27, r28] = rows;

    // Nothing is withdrawn from the retirement accounts in any year.
    expect(r26.withdrawals.pretax).toBe(0);
    expect(r27.withdrawals.pretax).toBe(0);

    // 2026: still employed, both accounts grow on their own.
    expect(r26.balances.byAccount['k401']).toBeCloseTo(121554.75, 6);
    expect(r26.balances.byAccount['ira1']).toBeCloseTo(51506.25, 6);

    // 2027: the 401(k) is emptied into the IRA but still reported at 0.
    expect(r27.balances.byAccount['k401']).toBe(0);
    expect(r27.balances.byAccount['ira1']).toBeCloseTo(187545.587625, 6);
    expect(r27.eventsFired).toContain('rollover-401k');
    expect(r27.eventsFired).toContain('retire:p1');
    // 2026 fired no rollover (the event year is what matters).
    expect(r26.eventsFired).not.toContain('rollover-401k');

    // 2028: the emptied 401(k) stays at 0 and the IRA keeps compounding.
    expect(r28.balances.byAccount['k401']).toBe(0);
    expect(r28.balances.byAccount['ira1']).toBeCloseTo(187545.587625 * 1.030125, 5);
  });

  it('creates a synthetic destination IRA when the user has none', () => {
    const profile = toyProfile({
      accounts: [
        toyAccount({
          id: 'k401',
          name: "P1's 401(k)",
          type: '401k',
          owner: 'p1',
          balance: 100000,
          allocation: { stocks: 0, bonds: 0, bills: 1 },
        }),
        toyAccount({
          id: 'savings',
          type: 'savings',
          owner: 'p1',
          balance: 100000,
          allocation: { stocks: 0, bonds: 0, bills: 1 },
        }),
      ],
      income: { salaries: { p1: 120000, p2: 0 }, contribution401k: 12000, employerMatch401k: 6000 },
      annualLiving: 30000,
      horizonAge: 57,
    });
    const rows = runSimulation(
      simInput(profile, {
        name: 'rollover-synthetic',
        autoSepp: false,
        events: [{ type: 'retire', person: 'p1', date: '2027-07' }],
      }),
    ).referencePath;
    const r27 = rows[1];
    // Same arithmetic, minus the 50,000 IRA this household does not have:
    //   2026 k401 = (100,000 + 18,000) x 1.030125 = 121,554.75
    //   2027 synthetic IRA = (121,554.75 + 9,000 contributions) x 1.030125
    //                      = 130,554.75 x 1.030125 = 134,487.71184375
    expect(r27.balances.byAccount['k401']).toBe(0);
    expect(r27.balances.byAccount['k401-rollover-ira']).toBeCloseTo(134487.71184375, 6);
    expect(r27.eventsFired).toContain('rollover-401k');
  });
});

describe('target-date-fund auto-glide (note 8)', () => {
  const START: { stocks: number; bonds: number; bills: number } = {
    stocks: 0.68,
    bonds: 0.32,
    bills: 0,
  };

  it('glides start mix -> 50/50 at the target year -> 30/70 seven years later, then holds', () => {
    // Linear by year, anchored on the sim's first year (2026) and a 2035 fund:
    //   2026            -> the profile's own mix, 0.68 / 0.32
    //   2030 (4 of 9)   -> 0.68 - 0.18 x 4/9 = 0.60 stocks, 0.40 bonds
    //   2035            -> 0.50 / 0.50
    //   2038 (3 of 7)   -> 0.50 - 0.20 x 3/7 = 0.4142857 stocks, 0.5857143 bonds
    //   2042 (+7 years) -> 0.30 / 0.70, and held from then on
    expect(targetDateMix(START, 2026, 2035, 2026)).toEqual(START);
    expect(targetDateMix(START, 2026, 2035, 2030).stocks).toBeCloseTo(0.6, 12);
    expect(targetDateMix(START, 2026, 2035, 2030).bonds).toBeCloseTo(0.4, 12);
    expect(targetDateMix(START, 2026, 2035, 2035)).toEqual({ stocks: 0.5, bonds: 0.5, bills: 0 });
    expect(targetDateMix(START, 2026, 2035, 2038).stocks).toBeCloseTo(0.4142857143, 9);
    expect(targetDateMix(START, 2026, 2035, 2038).bonds).toBeCloseTo(0.5857142857, 9);
    expect(targetDateMix(START, 2026, 2035, 2042)).toEqual({ stocks: 0.3, bonds: 0.7, bills: 0 });
    expect(targetDateMix(START, 2026, 2035, 2060)).toEqual({ stocks: 0.3, bonds: 0.7, bills: 0 });
    // Every waypoint is still a valid mix.
    for (const y of [2026, 2030, 2035, 2038, 2042, 2060]) {
      const m = targetDateMix(START, 2026, 2035, y);
      expect(m.stocks + m.bonds + m.bills).toBeCloseTo(1, 12);
    }
  });

  const tdfProfile = (): Profile =>
    toyProfile({
      accounts: [
        toyAccount({
          id: 'tdf',
          name: 'VTTHX 2035',
          type: 'traditional_ira',
          owner: 'p1',
          balance: 100000,
          allocation: { ...START },
          targetDateFund: { targetYear: 2035 },
        }),
        toyAccount({
          id: 'static',
          type: 'traditional_ira',
          owner: 'p1',
          balance: 100000,
          allocation: { ...START },
        }),
        toyAccount({
          id: 'savings',
          type: 'savings',
          owner: 'p1',
          balance: 50000,
          allocation: { stocks: 0, bonds: 0, bills: 1 },
        }),
      ],
      annualLiving: 0,
      horizonAge: 58, // 2026..2029
    });

  it('prepareSim schedules the glide for the TDF account only', () => {
    const ctx = prepareSim(simInput(tdfProfile(), { name: 'tdf', events: [] }));
    expect(ctx.tdfMixByYear[0]).toEqual([{ accountId: 'tdf', mix: START }]);
    // 2027 = 1 of the 9 years to 2035: 0.68 - 0.18/9 = 0.66 stocks.
    expect(ctx.tdfMixByYear[1][0].mix.stocks).toBeCloseTo(0.66, 12);
    expect(ctx.tdfMixByYear[1][0].mix.bonds).toBeCloseTo(0.34, 12);
    // No untargeted event, so nothing governs the other accounts.
    expect(ctx.mixByYear.every((m) => m === null)).toBe(true);
    expect(ctx.targetedMixByYear.every((t) => t.length === 0)).toBe(true);
  });

  it('an account-targeted allocation event switches the auto-glide off from its date', () => {
    const ctx = prepareSim(
      simInput(tdfProfile(), {
        name: 'tdf-override',
        events: [
          {
            type: 'allocation_change',
            date: '2028-01',
            mix: { stocks: 1, bonds: 0, bills: 0 },
            account: 'tdf',
          },
        ],
      }),
    );
    // Glide runs 2026-2027 and stops the year the event takes effect.
    expect(ctx.tdfMixByYear[0]).toHaveLength(1);
    expect(ctx.tdfMixByYear[1]).toHaveLength(1);
    expect(ctx.tdfMixByYear[2]).toHaveLength(0);
    expect(ctx.tdfMixByYear[3]).toHaveLength(0);
    // ...and the targeted event governs that account instead, leaving every
    // other account alone (the untargeted schedule stays empty).
    expect(ctx.targetedMixByYear[2]).toEqual([
      { accountId: 'tdf', mix: { stocks: 1, bonds: 0, bills: 0 } },
    ]);
    expect(ctx.mixByYear.every((m) => m === null)).toBe(true);
  });

  it('an untargeted glidepath sweeps every non-savings account and also stops the auto-glide', () => {
    const ctx = prepareSim(
      simInput(tdfProfile(), {
        name: 'tdf-global',
        events: [
          {
            type: 'glidepath',
            start: '2027-01',
            end: '2029-01',
            fromMix: { stocks: 0.6, bonds: 0.4, bills: 0 },
            toMix: { stocks: 0.4, bonds: 0.6, bills: 0 },
          },
        ],
      }),
    );
    expect(ctx.tdfMixByYear[0]).toHaveLength(1); // 2026: still gliding
    expect(ctx.tdfMixByYear[1]).toHaveLength(0); // 2027: the event took over
    // Untargeted glidepath: 2028 is 1 of its 2 years -> 0.5 / 0.5.
    expect(ctx.mixByYear[2]).toEqual({ stocks: 0.5, bonds: 0.5, bills: 0 });
  });

  it('an account-targeted allocation_change moves only its own account', () => {
    // The event retargets 'static' to 100% bills from 2027 and must leave the
    // TDF account gliding on its own schedule:
    //   2026 both 0.68/0.32          -> x 1.075845
    //   2027 static all bills        -> x 1.030125
    //   2027 tdf 0.66/0.34 (gliding) -> x 1.0748775
    const rows = runSimulation(
      simInput(tdfProfile(), {
        name: 'tdf-targeted-sim',
        events: [
          {
            type: 'allocation_change',
            date: '2027-01',
            mix: { stocks: 0, bonds: 0, bills: 1 },
            account: 'static',
          },
        ],
      }),
    ).referencePath;
    expect(rows[0].balances.byAccount['static']).toBeCloseTo(100000 * 1.075845, 6);
    expect(rows[1].balances.byAccount['static']).toBeCloseTo(100000 * 1.075845 * 1.030125, 6);
    expect(rows[1].balances.byAccount['tdf']).toBeCloseTo(100000 * 1.075845 * 1.0748775, 6);
  });

  it('the glide actually moves money: the TDF twin grows differently from a static one', () => {
    // Deterministic nominal returns: stocks (1.065 x 1.025) - 1 - 0.0003 =
    // 0.091325, bonds (1.018 x 1.025) - 1 - 0.0005 = 0.042950. Retirement
    // accounts compound the full blend, and with zero spending nothing is
    // withdrawn.
    //   2026 both 0.68/0.32: g = 0.68 x 0.091325 + 0.32 x 0.04295 = 0.075845
    //   2027 TDF 0.66/0.34:  g = 0.66 x 0.091325 + 0.34 x 0.04295 = 0.0748775
    //   2027 static stays at 0.075845
    const rows = runSimulation(
      simInput(tdfProfile(), { name: 'tdf-growth', events: [] }),
    ).referencePath;
    expect(rows[0].withdrawals.pretax).toBe(0);
    expect(rows[0].balances.byAccount['tdf']).toBeCloseTo(100000 * 1.075845, 6);
    expect(rows[0].balances.byAccount['static']).toBeCloseTo(100000 * 1.075845, 6);
    expect(rows[1].balances.byAccount['tdf']).toBeCloseTo(100000 * 1.075845 * 1.0748775, 6);
    expect(rows[1].balances.byAccount['static']).toBeCloseTo(100000 * 1.075845 ** 2, 6);
    expect(rows[1].balances.byAccount['tdf']).toBeLessThan(rows[1].balances.byAccount['static']);
  });
});

describe('expense streams: charitable giving (note 12)', () => {
  const givingProfile = (charitableMonthly: number): Profile =>
    toyProfile({
      accounts: [
        toyAccount({
          id: 'savings',
          type: 'savings',
          owner: 'p1',
          balance: 500000,
          allocation: { stocks: 0, bonds: 0, bills: 1 },
        }),
      ],
      income: { salaries: { p1: 100000, p2: 0 }, contribution401k: 0, employerMatch401k: 0 },
      annualLiving: 30000,
      charitableMonthly,
      horizonAge: 58, // 2026..2029
    });

  it('is its own inflating stream inside expenses.total, and feeds the tax deduction', () => {
    const giving = runSimulation(
      simInput(givingProfile(500), { name: 'giving', events: [] }),
    ).referencePath;
    const none = runSimulation(
      simInput(givingProfile(0), { name: 'no-giving', events: [] }),
    ).referencePath;

    // 500/mo -> 6,000/yr in 2026 dollars, growing with CPI.
    expect(giving[0].expenses.charitable).toBeCloseTo(6000, 8);
    expect(giving[1].expenses.charitable).toBeCloseTo(6000 * 1.025, 8);
    expect(giving[2].expenses.charitable).toBeCloseTo(6000 * 1.025 ** 2, 8);
    // Living is untouched by the charitable stream: 30,000 x CPI.
    expect(giving[1].expenses.baseline).toBeCloseTo(30000 * 1.025, 8);
    // expenses.total is exactly the five components.
    expect(giving[0].expenses.total).toBeCloseTo(
      giving[0].expenses.baseline +
        giving[0].expenses.charitable +
        giving[0].expenses.housing +
        giving[0].expenses.health +
        giving[0].expenses.oneTime,
      8,
    );
    expect(none[0].expenses.charitable).toBe(0);

    // Tax side: wages 100,000 puts the household well over the standard
    // deduction, and 6,000 of cash gifts exceeds the $2,000 MFJ non-itemizer
    // charitable deduction, so taxable income drops by exactly 2,000 while
    // AGI (and therefore every MAGI variant) is unchanged.
    expect(giving[0].taxes.federal.deductionUsed).toBe('standard');
    expect(giving[0].taxes.federal.agi).toBeCloseTo(none[0].taxes.federal.agi, 6);
    expect(none[0].taxes.federal.taxableIncome - giving[0].taxes.federal.taxableIncome).toBeCloseTo(
      2000,
      6,
    );
    expect(giving[0].taxes.federal.total).toBeLessThan(none[0].taxes.federal.total);
  });

  it("an expense_change with category 'charitable' retargets only that stream", () => {
    const rows = runSimulation(
      simInput(givingProfile(500), {
        name: 'giving-stop',
        events: [
          { type: 'expense_change', date: '2028-01', multiplier: 0, category: 'charitable' },
          { type: 'expense_change', date: '2028-01', multiplier: 0.9, category: 'living' },
        ],
      }),
    ).referencePath;
    // 2027: both streams still at their full values.
    expect(rows[1].expenses.charitable).toBeCloseTo(6000 * 1.025, 8);
    expect(rows[1].expenses.baseline).toBeCloseTo(30000 * 1.025, 8);
    // 2028: giving stops entirely; living takes its own 0.9 multiplier.
    expect(rows[2].expenses.charitable).toBe(0);
    expect(rows[2].expenses.baseline).toBeCloseTo(30000 * 1.025 ** 2 * 0.9, 8);
    expect(rows[2].taxes.federal.taxableIncome).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Giving in retirement (note 18)
// ---------------------------------------------------------------------------

/**
 * Savings-only household with NO salary in any year, so `employerMonthsByYear`
 * is 0 from the first year and the retirement giving rule governs the whole
 * run. Every figure is hand-derivable:
 *   - the bills sleeve's return is DISTRIBUTED as interest (savings never
 *     compounds), so the year's nominal investment gain is exactly
 *     start balance x BILLS_NOM and nothing else moves the balance except the
 *     year's withdrawal;
 *   - AGI is that interest alone, far below the 32,200 federal standard
 *     deduction and the VA standard deduction + exemptions, so every year's
 *     tax is 0 and no health premium applies (benchmark quote 0);
 *   - therefore withdrawal = living + giving - interest, from savings (cash).
 * Real growth for the year = interest - start balance x 0.025 (CPI).
 */
function givingRuleToy(retirementGiving: Profile['expenses']['retirementGiving']): Profile {
  const p = toyProfile({
    accounts: [
      toyAccount({
        id: 'savings',
        type: 'savings',
        owner: 'p1',
        balance: 200000,
        allocation: { stocks: 0, bonds: 0, bills: 1 },
      }),
    ],
    annualLiving: 30000,
    horizonAge: 60, // 2026..2031
  });
  p.expenses.retirementGiving = retirementGiving;
  return p;
}

/**
 * Replica of the toy's arithmetic (independent of the engine): returns each
 * year's interest, giving, withdrawal, end balance and real growth.
 * `givingFor(yearIndex, realGrowthSoFar, cpiIndex)` supplies the rule.
 */
function givingRuleToyYears(
  years: number,
  givingFor: (yi: number, growth: number[], idx: number) => number,
  billsNom: number = BILLS_NOM,
): Array<{ interest: number; giving: number; withdrawal: number; end: number; growth: number }> {
  let bal = 200000;
  let idx = 1;
  const growth: number[] = [];
  const out = [];
  for (let yi = 0; yi < years; yi++) {
    const interest = bal * billsNom;
    const giving = givingFor(yi, growth, idx);
    const withdrawal = 30000 * idx + giving - interest;
    const end = bal - withdrawal;
    growth.push(interest - bal * 0.025);
    out.push({ interest, giving, withdrawal, end, growth: growth[yi] });
    bal = end;
    idx *= 1.025;
  }
  return out;
}

describe('giving in retirement: the default is unchanged behavior (note 18)', () => {
  // Starter profile with a real tithe attached (10% of the 150,000 salary),
  // retiring mid-2028 — the full engine: 401(k) rollover, automatic 72(t),
  // ACA, Medicare, RMDs, Social Security.
  const tithingStarter = (): Profile => ({
    ...starterProfile,
    expenses: { ...starterProfile.expenses, charitableMonthly: 1250 },
  });
  const retireScenario: Scenario = {
    name: 'retire-2028',
    events: [
      { type: 'retire', person: 'p1', date: '2028-07' },
      { type: 'retire', person: 'p2', date: '2028-07' },
      { type: 'claim_social_security', person: 'p1', date: '2038-06' },
      { type: 'claim_social_security', person: 'p2', date: '2038-06' },
    ],
  };

  it("an absent retirementGiving is bit-for-bit identical to an explicit 'continue'", () => {
    const absent = runSimulation(simInput(tithingStarter(), retireScenario));
    const explicitProfile = tithingStarter();
    explicitProfile.expenses.retirementGiving = { type: 'continue' };
    const explicit = runSimulation(simInput(explicitProfile, retireScenario));
    // Same numbers to the last bit, not merely close.
    expect(JSON.stringify(explicit.referencePath)).toBe(JSON.stringify(absent.referencePath));
    expect(explicit.success).toBe(absent.success);
    expect(explicit.medianTerminalReal).toBe(absent.medianTerminalReal);

    // A scenario-level override reaches the same place.
    const overridden = runSimulation(
      simInput(tithingStarter(), {
        ...retireScenario,
        assumption_overrides: { expenses: { retirementGiving: { type: 'continue' } } },
      }),
    );
    expect(JSON.stringify(overridden.referencePath)).toBe(JSON.stringify(absent.referencePath));

    // And the behavior it preserves: the paycheck stream runs for life,
    // 1,250/mo = 15,000/yr in 2026 dollars x CPI, long after the last salary.
    const rows = absent.referencePath;
    const y = (year: number) => rows.find((r) => r.year === year)!;
    expect(y(2026).expenses.charitable).toBeCloseTo(15000, 6);
    expect(y(2029).expenses.charitable).toBeCloseTo(15000 * 1.025 ** 3, 6); // 16,153.359375
    expect(y(2040).expenses.charitable).toBeCloseTo(15000 * 1.025 ** 14, 6);
    // Nothing is flagged: 'continue' IS the paycheck stream, so no year's
    // giving came from a rule.
    expect(rows.some((r) => r.flags.includes('giving-rule'))).toBe(false);
  });
});

describe("giving in retirement: 'none' (note 18)", () => {
  /**
   * 100,000 salary for p1 retiring 2028-07 (6 worked months in 2028, 0 from
   * 2029), 500/mo of giving, savings-only so no automatic 72(t) can elect.
   */
  const noneProfile = (rule: Profile['expenses']['retirementGiving']): Profile => {
    const p = toyProfile({
      accounts: [
        toyAccount({
          id: 'savings',
          type: 'savings',
          owner: 'p1',
          balance: 500000,
          allocation: { stocks: 0, bonds: 0, bills: 1 },
        }),
      ],
      income: { salaries: { p1: 100000, p2: 0 }, contribution401k: 0, employerMatch401k: 0 },
      annualLiving: 30000,
      charitableMonthly: 500,
      horizonAge: 58, // 2026..2029
    });
    p.expenses.retirementGiving = rule;
    return p;
  };

  it('leaves working years alone, prorates the retirement year, then gives 0', () => {
    const rows = runSimulation(
      simInput(noneProfile({ type: 'none' }), {
        name: 'giving-none',
        events: [{ type: 'retire', person: 'p1', date: '2028-07' }],
      }),
    ).referencePath;

    // 2026, 2027: somebody is earning all 12 months -> the paycheck stream,
    // untouched: 6,000 and 6,000 x 1.025 = 6,150.
    expect(rows[0].expenses.charitable).toBeCloseTo(6000, 8);
    expect(rows[1].expenses.charitable).toBeCloseTo(6150, 8);
    expect(rows[0].flags).not.toContain('giving-rule');
    expect(rows[1].flags).not.toContain('giving-rule');

    // 2028: retirement year, 6 worked months ->
    //   6,000 x 1.025^2 x 6/12 + 0 x 6/12 = 6,303.75 x 0.5 = 3,151.875
    expect(rows[2].expenses.charitable).toBeCloseTo(3151.875, 8);
    expect(rows[2].flags).toContain('giving-rule');

    // 2029: nobody has earned a dollar all year -> exactly 0.
    expect(rows[3].expenses.charitable).toBe(0);
    expect(rows[3].flags).toContain('giving-rule');
    // expenses.total keeps its five-component contract either way.
    for (const row of rows) {
      expect(row.expenses.total).toBeCloseTo(
        row.expenses.baseline +
          row.expenses.charitable +
          row.expenses.housing +
          row.expenses.health +
          row.expenses.oneTime,
        8,
      );
    }
  });

  it('is selectable per scenario without touching the profile', () => {
    const profile = noneProfile(undefined); // profile default = 'continue'
    const events: Scenario['events'] = [{ type: 'retire', person: 'p1', date: '2028-07' }];
    const kept = runSimulation(simInput(profile, { name: 'keep', events })).referencePath;
    const stopped = runSimulation(
      simInput(profile, {
        name: 'stop',
        events,
        assumption_overrides: { expenses: { retirementGiving: { type: 'none' } } },
      }),
    ).referencePath;
    expect(kept[3].expenses.charitable).toBeCloseTo(6000 * 1.025 ** 3, 8); // 6,461.34375
    expect(stopped[3].expenses.charitable).toBe(0);
    // The profile object is never mutated by the override.
    expect(profile.expenses.retirementGiving).toBeUndefined();
  });
});

describe("giving in retirement: 'percent_of_growth' (note 18)", () => {
  it('gives 10% of the PRIOR year’s real portfolio growth, hand-computed', () => {
    /*
     * Savings 200,000 at BILLS_NOM = 0.030125, CPI 0.025, living 30,000 real,
     * no salary in any year -> the rule governs from 2026.
     *
     * 2026: no completed year yet -> giving 0.
     *   interest    = 200,000 x 0.030125          =  6,025.00
     *   withdrawal  = 30,000 + 0 - 6,025          = 23,975.00
     *   end balance = 200,000 - 23,975            = 176,025.00
     *   REAL GROWTH = 6,025 - 200,000 x 0.025     =  1,025.00
     * 2027: giving = 10% x 1,025                  =    102.50
     *   interest    = 176,025 x 0.030125          =  5,302.753125
     *   withdrawal  = 30,750 + 102.50 - 5,302.753125 = 25,549.746875
     *   end balance = 176,025 - 25,549.746875     = 150,475.253125
     *   REAL GROWTH = 5,302.753125 - 176,025 x 0.025 = 902.128125
     * 2028: giving = 10% x 902.128125             =     90.2128125
     *   interest    = 150,475.253125 x 0.030125   =  4,533.06700039...
     *   end balance = 123,399.35731289...
     */
    const rows = runSimulation(
      simInput(givingRuleToy({ type: 'percent_of_growth', percent: 0.1 }), {
        name: 'growth-10',
        events: [],
      }),
    ).referencePath;
    const expected = givingRuleToyYears(6, (yi, growth) =>
      yi === 0 ? 0 : Math.max(0, 0.1 * growth[yi - 1]),
    );

    expect(rows[0].expenses.charitable).toBe(0); // no prior year to give on
    expect(rows[1].expenses.charitable).toBeCloseTo(102.5, 8);
    expect(rows[2].expenses.charitable).toBeCloseTo(90.2128125, 8);
    expect(rows[1].balances.total).toBeCloseTo(150475.253125, 6);
    for (let yi = 0; yi < rows.length; yi++) {
      expect(rows[yi].expenses.charitable).toBeCloseTo(expected[yi].giving, 6);
      expect(rows[yi].income.taxableInterest).toBeCloseTo(expected[yi].interest, 6);
      expect(rows[yi].withdrawals.cash).toBeCloseTo(expected[yi].withdrawal, 6);
      expect(rows[yi].balances.total).toBeCloseTo(expected[yi].end, 6);
      expect(rows[yi].flags).toContain('giving-rule');
    }

    // Auditability: the traced year states the rule, the base, and the year
    // the base came from — 2027's real growth of 902.128125 drove 2028.
    const trace = rows[2].taxes.trace!;
    const headline = trace.find((t) => t.label.startsWith('Charitable giving'))!;
    expect(headline.label).toContain('10.00% of real portfolio growth');
    expect(headline.amount).toBeCloseTo(90.2128125, 8);
    const base = trace.find((t) => t.label.startsWith('Base'))!;
    expect(base.label).toBe('Base — 2027 real portfolio growth');
    expect(base.amount).toBeCloseTo(902.128125, 6);
  });

  it('gives exactly 0 after a DOWN year (a real loss is never a negative gift)', () => {
    // Bills real return -2%: nominal = 0.98 x 1.025 - 1 = 0.0045, well under
    // the 2.5% CPI, so real growth is negative every year.
    //   2026: interest = 200,000 x 0.0045 = 900
    //         real growth = 900 - 5,000 = -4,100
    //   2027: 10% x (-4,100) = -410 -> floored to 0
    const downMarket = { deterministicReal: { stocks: -0.1, bonds: -0.05, bills: -0.02 } };
    const rows = runSimulation(
      simInput(givingRuleToy({ type: 'percent_of_growth', percent: 0.1 }), {
        name: 'growth-down',
        events: [],
        assumption_overrides: { market: downMarket },
      }),
    ).referencePath;
    const billsNom = (1 - 0.02) * 1.025 - 1;
    expect(rows[0].income.taxableInterest).toBeCloseTo(200000 * billsNom, 6); // 900
    expect(rows[0].expenses.charitable).toBe(0);
    expect(rows[1].expenses.charitable).toBe(0); // 10% of -4,100, floored
    expect(rows[2].expenses.charitable).toBe(0);
    // The trace still shows the (negative) base that produced the zero.
    const base = rows[1].taxes.trace!.find((t) => t.label.startsWith('Base'))!;
    expect(base.amount).toBeCloseTo(200000 * billsNom - 200000 * 0.025, 6); // -4,100
  });

  it('smoothingYears 3 averages exactly the last three years of real growth', () => {
    const rows = runSimulation(
      simInput(
        givingRuleToy({ type: 'percent_of_growth', percent: 0.1, smoothingYears: 3 }),
        { name: 'growth-smoothed', events: [] },
      ),
    ).referencePath;
    const expected = givingRuleToyYears(6, (yi, growth) => {
      const n = Math.min(3, yi);
      if (n === 0) return 0;
      let sum = 0;
      for (let k = yi - n; k < yi; k++) sum += growth[k];
      return Math.max(0, 0.1 * (sum / n));
    });

    // 2026: nothing to average -> 0.
    expect(rows[0].expenses.charitable).toBe(0);
    // 2027: only 2026 exists -> 10% x 1,025 = 102.50 (same as unsmoothed).
    expect(rows[1].expenses.charitable).toBeCloseTo(102.5, 8);
    // 2028: mean of 2026 and 2027 = (1,025 + 902.128125) / 2 = 963.5640625
    //       -> 96.35640625
    expect(rows[2].expenses.charitable).toBeCloseTo(96.35640625, 8);
    // 2029: the first full three-year window, 2026-2028. Its 2028 growth is
    //       the SMOOTHED path's own (giving changed the withdrawal), so the
    //       replica supplies it: mean 899.4379324218 -> 89.9437932422.
    expect(rows[3].expenses.charitable).toBeCloseTo(89.94379324218284, 8);
    expect(rows[3].expenses.charitable).toBeCloseTo(expected[3].giving, 8);
    // 2030 rolls the window forward to 2027-2029 (2026 drops out).
    expect(rows[4].expenses.charitable).toBeCloseTo(expected[4].giving, 8);
    expect(rows[4].expenses.charitable).toBeCloseTo(76.85680058587, 8);
    for (let yi = 0; yi < rows.length; yi++) {
      expect(rows[yi].balances.total).toBeCloseTo(expected[yi].end, 6);
    }
    const base = rows[3].taxes.trace!.find((t) => t.label.startsWith('Base'))!;
    expect(base.label).toBe('Base — mean real portfolio growth, 2026-2028 (3 years)');
    expect(base.amount).toBeCloseTo(899.4379324218284, 6);
  });

  it('capMonthly binds, in today’s dollars, before any proration', () => {
    // Cap 5/mo = 60/yr in 2026 dollars.
    //   2027: uncapped 102.50 -> capped at 60 x 1.025          =  61.50
    //   2028: uncapped 90.21... -> capped at 60 x 1.025^2      =  63.0375
    // By 2031 the uncapped figure has fallen below the cap and the cap stops
    // binding: 48.59... < 60 x 1.025^5.
    const rows = runSimulation(
      simInput(givingRuleToy({ type: 'percent_of_growth', percent: 0.1, capMonthly: 5 }), {
        name: 'growth-capped',
        events: [],
      }),
    ).referencePath;
    const expected = givingRuleToyYears(6, (yi, growth, idx) => {
      const raw = yi === 0 ? 0 : Math.max(0, 0.1 * growth[yi - 1]);
      return Math.min(raw, 5 * 12 * idx);
    });
    expect(rows[1].expenses.charitable).toBeCloseTo(61.5, 8);
    expect(rows[2].expenses.charitable).toBeCloseTo(63.0375, 8);
    expect(rows[5].expenses.charitable).toBeCloseTo(48.59367774807511, 8);
    expect(rows[5].expenses.charitable).toBeLessThan(5 * 12 * 1.025 ** 5); // cap released
    for (let yi = 0; yi < rows.length; yi++) {
      expect(rows[yi].expenses.charitable).toBeCloseTo(expected[yi].giving, 6);
      expect(rows[yi].balances.total).toBeCloseTo(expected[yi].end, 6);
    }
    // An uncapped run gives strictly more in a bound year.
    const uncapped = runSimulation(
      simInput(givingRuleToy({ type: 'percent_of_growth', percent: 0.1 }), {
        name: 'growth-uncapped',
        events: [],
      }),
    ).referencePath;
    expect(uncapped[1].expenses.charitable).toBeGreaterThan(rows[1].expenses.charitable);
  });
});

describe("giving in retirement: 'percent_of_income' and the retirement-year proration (note 18)", () => {
  it('gives 5% of the prior year’s Social Security + gross withdrawals', () => {
    /*
     * Savings 200,000 (bills), living 30,000 real, giving 500/mo while
     * working, p1 earning 8,000 and retiring 2028-07. The salary is small on
     * purpose: AGI stays under every deduction, so tax is 0 and each year's
     * only draw is from savings (the cash bucket) — which makes the income
     * base exactly the recorded withdrawal.
     *
     * 2026 (12 worked months): giving = paycheck 6,000.
     *   interest   = 200,000 x 0.030125            =  6,025.00
     *   withdrawal = 30,000 + 6,000 - 6,025 - 8,000 = 21,975.00
     *   end        = 178,025.00     income base 2026 = 21,975.00
     * 2027 (12): giving = 6,150 (paycheck; the rule does not govern yet).
     *   interest   = 178,025 x 0.030125            =  5,363.003125
     *   withdrawal = 30,750 + 6,150 - 5,363.003125 - 8,000 = 23,536.996875
     *   end        = 154,488.003125  income base 2027 = 23,536.996875
     * 2028 (6 worked months): PRORATED.
     *   paycheck stream  = 6,000 x 1.025^2         =  6,303.75
     *   rule (full year) = 5% x 23,536.996875      =  1,176.849843750
     *   giving = 6,303.75 x 6/12 + 1,176.84984375 x 6/12 = 3,740.2999218750
     *   interest   = 154,488.003125 x 0.030125     =  4,653.951094141
     *   wages      = 8,000 x 6/12                  =  4,000.00
     *   withdrawal = 31,518.75 + 3,740.2999218750 - 4,653.951094141 - 4,000
     *              = 26,605.098827734
     * 2029 (0 worked months): the rule alone.
     *   giving = 5% x 26,605.098827734             =  1,330.254941387
     */
    const p = toyProfile({
      accounts: [
        toyAccount({
          id: 'savings',
          type: 'savings',
          owner: 'p1',
          balance: 200000,
          allocation: { stocks: 0, bonds: 0, bills: 1 },
        }),
      ],
      income: { salaries: { p1: 8000, p2: 0 }, contribution401k: 0, employerMatch401k: 0 },
      annualLiving: 30000,
      charitableMonthly: 500,
      horizonAge: 58, // 2026..2029
    });
    p.expenses.retirementGiving = { type: 'percent_of_income', percent: 0.05 };
    const rows = runSimulation(
      simInput(p, {
        name: 'income-5',
        events: [{ type: 'retire', person: 'p1', date: '2028-07' }],
      }),
    ).referencePath;

    expect(rows.every((r) => r.taxes.totalTax === 0)).toBe(true);
    expect(rows[0].expenses.charitable).toBeCloseTo(6000, 8);
    expect(rows[1].expenses.charitable).toBeCloseTo(6150, 8);
    expect(rows[0].withdrawals.cash).toBeCloseTo(21975, 6);
    expect(rows[1].withdrawals.cash).toBeCloseTo(23536.996875, 6);
    // The prorated retirement year, to the cent.
    expect(rows[2].expenses.charitable).toBeCloseTo(3740.299921875, 8);
    expect(rows[2].flags).toContain('giving-rule');
    // The first fully-retired year: the rule on 2028's income base.
    expect(rows[3].expenses.charitable).toBeCloseTo(1330.2549413867188, 8);

    // Written against the general base (Social Security + every withdrawal
    // bucket); SS is 0 in this toy and every draw is cash, but the assertion
    // holds for the general expression the rule is defined on.
    const grossIncome = (r: (typeof rows)[number]): number =>
      r.income.socialSecurity +
      r.withdrawals.cash +
      r.withdrawals.taxable +
      r.withdrawals.pretax +
      r.withdrawals.roth;
    expect(rows[3].expenses.charitable).toBeCloseTo(0.05 * grossIncome(rows[2]), 8);
    const base = rows[3].taxes.trace!.find((t) => t.label.startsWith('Base'))!;
    expect(base.label).toBe('Base — 2028 Social Security + gross withdrawals');
    expect(base.amount).toBeCloseTo(grossIncome(rows[2]), 6);
    // The retirement year names both halves of the proration.
    const prorated = rows[2].taxes.trace!.find((t) => t.label.startsWith('Retirement year'))!;
    expect(prorated.label).toContain('6 months of paycheck giving + 6 months of the rule');
    expect(prorated.amount).toBeCloseTo(3740.299921875, 8);
  });
});

describe('giving in retirement: the tax deduction and the 72(t) bridge still see it (note 18)', () => {
  it('rule-driven giving still drives the OBBBA non-itemizer charitable deduction', () => {
    /*
     * 5,000,000 of savings, no salary, plus 100,000 of taxable one-time income
     * in 2027 to put the household well above the standard deduction.
     *   2026 real growth = 5,000,000 x 0.030125 - 5,000,000 x 0.025
     *                    = 150,625 - 125,000 = 25,625
     *   2027 giving (10%) = 2,562.50, above the 2,000 MFJ non-itemizer cap.
     * 2026 is identical in both runs (no prior year -> giving 0), so 2027's
     * AGI is identical and the ONLY difference is the deduction: itemizing
     * (2,562.50 less the 0.5%-of-AGI floor) is nowhere near the standard
     * deduction, so the standard deduction is used and taxable income falls by
     * exactly the 2,000 cap.
     */
    const build = (rule: Profile['expenses']['retirementGiving']): Profile => {
      const p = toyProfile({
        accounts: [
          toyAccount({
            id: 'savings',
            type: 'savings',
            owner: 'p1',
            balance: 5000000,
            allocation: { stocks: 0, bonds: 0, bills: 1 },
          }),
        ],
        annualLiving: 30000,
        horizonAge: 57, // 2026..2028
      });
      p.expenses.retirementGiving = rule;
      return p;
    };
    const events: Scenario['events'] = [
      { type: 'one_time_income', date: '2027-01', amount: 100000, taxable: true },
    ];
    const giving = runSimulation(
      simInput(build({ type: 'percent_of_growth', percent: 0.1 }), { name: 'give', events }),
    ).referencePath;
    const none = runSimulation(
      simInput(build({ type: 'none' }), { name: 'no-give', events }),
    ).referencePath;

    expect(giving[0].expenses.charitable).toBe(0);
    expect(none[0].expenses.charitable).toBe(0);
    expect(giving[1].expenses.charitable).toBeCloseTo(2562.5, 6);
    expect(none[1].expenses.charitable).toBe(0);

    // Same AGI (the giving is spent, not earned) — the deduction is the only
    // moving part, and it moves by exactly the 2,000 non-itemizer cap.
    expect(giving[1].taxes.federal.deductionUsed).toBe('standard');
    expect(giving[1].taxes.federal.agi).toBeCloseTo(none[1].taxes.federal.agi, 6);
    expect(
      none[1].taxes.federal.taxableIncome - giving[1].taxes.federal.taxableIncome,
    ).toBeCloseTo(2000, 6);
    expect(giving[1].taxes.federal.total).toBeLessThan(none[1].taxes.federal.total);
    // The engine's charitable input is the rule's output, not the profile's
    // (zero) paycheck stream.
    expect(giving[1].taxes.trace!.some((t) => t.label.includes('charitable'))).toBe(true);
  });

  it('a rule that cuts giving shrinks the automatic 72(t) payment it sizes', () => {
    // Retiring in 2028 is before the 2031 penalty-free year, so the engine
    // elects an automatic 72(t) sized to the household's projected FULL-YEAR
    // retired need — which includes the giving that year would carry. Dropping
    // giving in retirement must therefore shrink the payment, otherwise the
    // series would be locked at the paycheck level of giving for its whole
    // term.
    //
    // The 401(k) is scaled to 2,000,000 so the whole-account formula maximum
    // (166,512.51 at the 2028 election) leaves both payments clear of the
    // MAX_AUTO_SEPP_FRACTION cap — at 1,200,000 BOTH payments pinned exactly to
    // 0.75 x maximum, which is the degradation the assertion below exists to
    // catch. That matters since note 20: working years no
    // longer bank their leftover pay, so the household reaches 2028 with far
    // less accessible cash, the projected bridge need is correspondingly
    // larger, and on the starter balances the 'continue' payment would clamp
    // to 0.75 x the formula maximum — flattening the very difference this test
    // measures. The assertion below pins that the cap is not binding, so this
    // cannot quietly degrade again.
    const build = (rule: Profile['expenses']['retirementGiving']): Profile => ({
      ...starterProfile,
      accounts: starterProfile.accounts.map((a) =>
        a.id === 'k401' ? { ...a, balance: 2000000 } : a,
      ),
      expenses: { ...starterProfile.expenses, charitableMonthly: 1250, retirementGiving: rule },
    });
    const scenario: Scenario = {
      name: 'auto-sepp-giving',
      events: [
        { type: 'retire', person: 'p1', date: '2028-07' },
        { type: 'retire', person: 'p2', date: '2028-07' },
      ],
    };
    const paymentIn2029 = (rule: Profile['expenses']['retirementGiving']): number => {
      const rows = runSimulation(simInput(build(rule), scenario)).referencePath;
      const row = rows.find((r) => r.year === 2029)!;
      expect(row.flags).toContain('sepp');
      // The election year's trace states the formula maximum the payment was
      // measured against; assert the 0.75 cap is NOT what set the payment, or
      // the comparison below would be measuring the cap, not the giving.
      const note = rows
        .find((r) => r.year === 2028)!
        .taxes.trace!.find((l) => l.label.startsWith('Annual payment'))!.note!;
      const maxPayment = Number(/formula maximum ([\d.]+)/.exec(note)![1]);
      const seppId = Object.keys(row.withdrawals.byAccount).find((id) => id.includes('-sepp'))!;
      const payment = row.withdrawals.byAccount[seppId];
      expect(payment).toBeLessThan(0.75 * maxPayment);
      return payment;
    };
    const kept = paymentIn2029({ type: 'continue' });
    const stopped = paymentIn2029({ type: 'none' });
    expect(kept).toBeGreaterThan(0);
    expect(stopped).toBeGreaterThan(0);
    /*
     * How much must the payment shed? The estimator prices a FULLY RETIRED
     * year — wages 0, ACA for every non-Medicare month — and the payment it
     * fixes is nominal for the whole term. A retired 2028 carries
     * 1,250/mo x 12 x 1.025^2 = 15,759.375 of giving under 'continue' and 0
     * under 'none', and the pre-tax distribution funding it is itself taxed,
     * so the gap is at least that full-year figure.
     *
     * This is the assertion that pins the wiring: feeding the estimator the
     * retirement year's PRORATED giving instead (six months of paycheck
     * giving, ~7,880) sheds only about half as much and leaves the series
     * sized, for its whole term, around giving that has already stopped.
     */
    expect(kept - stopped).toBeGreaterThan(15759.375);
  });

  it('stays deterministic under Monte Carlo with a rule attached', () => {
    const profile: Profile = {
      ...starterProfile,
      expenses: {
        ...starterProfile.expenses,
        charitableMonthly: 1250,
        retirementGiving: { type: 'percent_of_growth', percent: 0.1, smoothingYears: 3 },
      },
    };
    const scenario: Scenario = {
      name: 'giving-mc',
      assumption_overrides: { settings: { horizonAge: 70 } },
      events: [
        { type: 'retire', person: 'p1', date: '2028-07' },
        { type: 'retire', person: 'p2', date: '2028-07' },
      ],
    };
    const run = () =>
      runSimulation(simInput(profile, scenario, { mode: 'montecarlo', paths: 40, seed: 99 }));
    const a = run();
    const b = run();
    expect(a.meta.runKey).toBe(b.meta.runKey);
    expect(JSON.stringify(a.fan)).toBe(JSON.stringify(b.fan));
    expect(a.success).toBe(b.success);
  });
});

describe('expense streams: investing transfer (note 12)', () => {
  const investingProfile = (over?: { investingMonthly?: number }): Profile =>
    toyProfile({
      accounts: [
        toyAccount({
          id: 'savings',
          type: 'savings',
          owner: 'p1',
          balance: 50000,
          allocation: { stocks: 0, bonds: 0, bills: 1 },
        }),
        toyAccount({
          id: 'brokerage',
          type: 'taxable_brokerage',
          owner: 'p1',
          balance: 100000,
          costBasis: 100000,
          // 100% bills: the sleeve's return is distributed as interest and the
          // price stays flat, so the balance moves ONLY via the transfer.
          allocation: { stocks: 0, bonds: 0, bills: 1 },
        }),
      ],
      income: { salaries: { p1: 100000, p2: 0 }, contribution401k: 0, employerMatch401k: 0 },
      annualLiving: 30000,
      investingMonthly: over?.investingMonthly ?? 1000,
      horizonAge: 59, // 2026..2030
    });

  it('moves cash into the brokerage (balance AND basis) and stops at retirement', () => {
    const rows = runSimulation(
      simInput(investingProfile(), {
        name: 'investing',
        events: [
          { type: 'retire', person: 'p1', date: '2028-07' },
          // 2029: drain savings so the brokerage is actually sold, which
          // exposes whether the transferred cash raised the basis with it.
          { type: 'one_time_expense', date: '2029-06', amount: 200000 },
        ],
      }),
    ).referencePath;

    // 2026: 1,000/mo x 12 worked months x CPI 1.0 = 12,000, well under the
    // salary surplus, so the whole stream lands in the brokerage.
    expect(rows[0].investing).toBeCloseTo(12000, 6);
    // NOTE 20: the rest of the surplus goes NOWHERE. This is a working year,
    // so what the paycheck left over is CONSUMED — the irregular costs the
    // 30,000 budget baseline does not carry — and the brokerage rises by the
    // explicit stream and not a penny more:
    //   income   = wages 100,000 + interest (50,000 + 100,000) x 0.030125
    //            = 100,000 + 4,518.75                    = 104,518.75
    //   federal  = (104,518.75 - 32,200 std) = 72,318.75 taxable
    //            = 0.10 x 24,800 + 0.12 x (72,318.75 - 24,800)
    //            = 2,480 + 5,702.25                      =   8,182.25
    //   VA       = (104,518.75 - 17,500 std - 1,860 exemptions) = 85,158.75
    //            = 60 + 60 + 600 + 0.0575 x (85,158.75 - 17,000)
    //            = 720 + 3,919.128125                    =   4,639.128125
    //   surplus  = 104,518.75 - 30,000 - 12,821.378125   =  61,697.371875
    //   investing                                        =  12,000
    //   unbudgeted = 61,697.371875 - 12,000              =  49,697.371875
    //   brokerage end = 100,000 + 12,000                 = 112,000
    //     (100% bills, so the price is flat and nothing compounds)
    expect(rows[0].taxes.totalTax).toBeCloseTo(12821.378125, 4);
    expect(rows[0].unbudgeted).toBeCloseTo(49697.371875, 4);
    expect(rows[0].balances.byAccount['brokerage']).toBeCloseTo(112000, 4);
    // ...and savings is untouched: nothing is parked there either.
    expect(rows[0].withdrawals.cash).toBe(0);
    expect(rows[0].balances.byAccount['savings']).toBeCloseTo(50000, 6);
    // 2027: the stream is 12,000 x 1.025 = 12,300 and, again, ONLY the stream
    // moves the brokerage:
    //   interest = (50,000 + 112,000) x 0.030125         =   4,880.25
    //   brokerage end = 112,000 + 12,300                 = 124,300
    //   unbudgeted = 100,000 + 4,880.25 - 30,750 - tax - 12,300
    expect(rows[1].investing).toBeCloseTo(12300, 6);
    expect(rows[1].income.taxableInterest).toBeCloseTo(4880.25, 4);
    expect(rows[1].balances.byAccount['brokerage']).toBeCloseTo(124300, 4);
    expect(rows[1].unbudgeted).toBeCloseTo(
      100000 + 4880.25 - 30750 - rows[1].taxes.totalTax - 12300,
      4,
    );
    // 2028: retires in July -> 6 worked months: 1,000 x 6 x 1.025^2 = 6,303.75.
    expect(rows[2].investing).toBeCloseTo(6303.75, 6);
    // Still a WORKING year by the note-20 rule (worked months > 0), so the
    // retirement year sweeps nothing either — the leftover is consumed whole.
    expect(rows[2].unbudgeted).toBeGreaterThan(0);
    expect(rows[2].balances.byAccount['brokerage']).toBeCloseTo(124300 + 6303.75, 4);
    // 2029-2030: nobody earns, so the retired rule applies again — but these
    // years are drawing down, not sweeping, so nothing is consumed either.
    expect(rows[3].unbudgeted).toBe(0);
    expect(rows[4].unbudgeted).toBe(0);
    // 2029-2030: no earner, no transfer.
    expect(rows[3].investing).toBe(0);
    expect(rows[4].investing).toBe(0);

    // Basis rose with the cash (balance AND costBasis += amount), so the
    // 2029 forced sale realizes no phantom gain at all: basis == balance.
    expect(rows[3].withdrawals.taxable).toBeGreaterThan(0);
    expect(rows[3].withdrawals.realizedLtcg).toBeCloseTo(0, 6);

    // Investing is NOT consumption: it never enters expenses.total.
    for (const row of rows) {
      expect(row.expenses.total).toBeCloseTo(
        row.expenses.baseline +
          row.expenses.charitable +
          row.expenses.housing +
          row.expenses.health +
          row.expenses.oneTime,
        8,
      );
    }
  });

  it('is capped at the surplus: a big one-time expense shrinks it, a bigger one zeroes it', () => {
    // 2026 income = 100,000 wages + 150,000 x 0.030125 = 4,518.75 interest.
    // A 55,000 one-time expense on top of 30,000 living leaves only a sliver
    // of surplus after tax — less than the 12,000 the stream wants — and the
    // engine may never borrow (withdraw) to invest.
    const partial = runSimulation(
      simInput(investingProfile(), {
        name: 'investing-capped',
        events: [{ type: 'one_time_expense', date: '2026-06', amount: 55000 }],
      }),
    ).referencePath[0];
    expect(partial.investing).toBeGreaterThan(0);
    expect(partial.investing).toBeLessThan(12000);
    // The transfer equals the surplus exactly: nothing was swept to savings,
    // and savings only moved by the year's cash draws (0 here).
    expect(partial.withdrawals.cash).toBe(0);
    expect(partial.balances.byAccount['savings']).toBeCloseTo(50000, 6);
    expect(partial.balances.byAccount['brokerage']).toBeCloseTo(100000 + partial.investing, 6);

    // A 200,000 one-time expense forces withdrawals: no surplus, no transfer.
    const none = runSimulation(
      simInput(investingProfile(), {
        name: 'investing-zero',
        events: [{ type: 'one_time_expense', date: '2026-06', amount: 200000 }],
      }),
    ).referencePath[0];
    expect(none.investing).toBe(0);
    expect(none.withdrawals.cash).toBeGreaterThan(0);
  });
});

describe('scenario expense overrides (assumption_overrides.expenses)', () => {
  /**
   * The property that matters: an override must produce EXACTLY the run the
   * equivalent profile edit produces — the workbench drags spending without
   * rewriting profile.json, and the numbers must not care which door the
   * value came through.
   */
  it('livingMonthly override == the same value written into the profile', () => {
    // Same fixture as the golden 3-year series at the top of this file
    // (200,000 in savings, bills only, no income, VA, horizon age 57 ->
    // 2026..2028, every year zero-tax because AGI = interest <= 6,025 is
    // under the 32,200 federal standard deduction and VA taxable is negative).
    // Profile says 30,000/yr; the scenario overrides to 36,000/yr
    // (livingMonthly 3,000). Zero-tax drawdown recurrence:
    //   B_{y+1} = B_y - (36,000 x 1.025^y - B_y x 0.030125)
    // 2026: interest 200,000 x 0.030125            =  6,025.00
    //       spending 36,000 x 1                    = 36,000.00
    //       withdrawal                             = 29,975.00
    //       end balance                            = 170,025.00
    // 2027: interest 170,025 x 0.030125            =  5,122.003125
    //       spending 36,000 x 1.025                = 36,900.00
    //       withdrawal                             = 31,777.996875
    //       end balance                            = 138,247.003125
    // 2028: interest 138,247.003125 x 0.030125     =  4,164.690969
    //       spending 36,000 x 1.050625             = 37,822.50
    //       withdrawal                             = 33,657.809031
    //       end balance                            = 104,589.194094
    const overridden = runSimulation(
      simInput(toyProfile(), {
        name: 'living-override',
        assumption_overrides: { expenses: { livingMonthly: 3000 } },
        events: [],
      }),
    );
    const rows = overridden.referencePath;
    expect(rows.map((r) => r.year)).toEqual([2026, 2027, 2028]);
    expect(rows[0].expenses.baseline).toBeCloseTo(36000, 8);
    expect(rows[1].expenses.baseline).toBeCloseTo(36900, 8);
    expect(rows[2].expenses.baseline).toBeCloseTo(37822.5, 8);
    expect(rows[0].balances.total).toBeCloseTo(170025, 6);
    expect(rows[1].balances.total).toBeCloseTo(138247.003125, 6);
    expect(rows[2].balances.total).toBeCloseTo(104589.194094, 4);

    // The meaningful property: identical to the profile carrying 36,000/yr.
    const edited = runSimulation(
      simInput(toyProfile({ annualLiving: 36000 }), { name: 'living-in-profile', events: [] }),
    );
    expect(JSON.stringify(overridden.referencePath)).toBe(JSON.stringify(edited.referencePath));
    expect(overridden.success).toBe(edited.success);
    expect(overridden.medianTerminalReal).toBe(edited.medianTerminalReal);
    expect(JSON.stringify(overridden.fan)).toBe(JSON.stringify(edited.fan));

    // ...and genuinely different from the un-overridden profile (30,000/yr,
    // whose 2026 baseline is 30,000 and 2028 end balance 123,595.16).
    const base = runSimulation(simInput(toyProfile(), { name: 'living-base', events: [] }));
    expect(base.referencePath[0].expenses.baseline).toBeCloseTo(30000, 8);
    expect(base.referencePath[2].balances.total).toBeCloseTo(123595.157938, 4);

    // The override is a WORKING COPY, not a profile edit: the run hashes the
    // household's real profile (unchanged — same hash as the base run) and
    // carries the override in the scenario hash instead, so the run cache
    // still separates the two runs.
    expect(overridden.meta.hashes.profile).toBe(base.meta.hashes.profile);
    expect(overridden.meta.hashes.profile).not.toBe(edited.meta.hashes.profile);
    expect(overridden.meta.hashes.scenario).not.toBe(base.meta.hashes.scenario);
    expect(overridden.meta.runKey).not.toBe(base.meta.runKey);
  });

  it('charitable and investing overrides reach their streams too', () => {
    // Salary + brokerage so both streams are live: investing only runs while
    // someone works, and only into a taxable brokerage.
    const streams = (over?: { charitableMonthly?: number; investingMonthly?: number }): Profile =>
      toyProfile({
        accounts: [
          toyAccount({
            id: 'savings',
            type: 'savings',
            owner: 'p1',
            balance: 50000,
            allocation: { stocks: 0, bonds: 0, bills: 1 },
          }),
          toyAccount({
            id: 'brokerage',
            type: 'taxable_brokerage',
            owner: 'p1',
            balance: 100000,
            costBasis: 100000,
            allocation: { stocks: 0, bonds: 0, bills: 1 },
          }),
        ],
        income: { salaries: { p1: 100000, p2: 0 }, contribution401k: 0, employerMatch401k: 0 },
        annualLiving: 30000,
        charitableMonthly: over?.charitableMonthly ?? 0,
        investingMonthly: over?.investingMonthly ?? 0,
        horizonAge: 57, // 2026..2028
      });

    const overridden = runSimulation(
      simInput(streams(), {
        name: 'streams-override',
        assumption_overrides: { expenses: { charitableMonthly: 500, investingMonthly: 1000 } },
        events: [],
      }),
    );
    const rows = overridden.referencePath;
    // 500/mo -> 6,000/yr in 2026 dollars, inflating with CPI.
    expect(rows[0].expenses.charitable).toBeCloseTo(6000, 8);
    expect(rows[1].expenses.charitable).toBeCloseTo(6150, 8); // 6,000 x 1.025
    // 1,000/mo x 12 worked months x CPI: nobody retires, so all 12 months
    // count, and the salary surplus (~100,000 + 4,518.75 interest, less
    // 30,000 living + 6,000 giving + tax) far exceeds the transfer's cap.
    expect(rows[0].investing).toBeCloseTo(12000, 6);
    expect(rows[1].investing).toBeCloseTo(12300, 6); // 12,000 x 1.025

    const edited = runSimulation(
      simInput(streams({ charitableMonthly: 500, investingMonthly: 1000 }), {
        name: 'streams-in-profile',
        events: [],
      }),
    );
    expect(JSON.stringify(overridden.referencePath)).toBe(JSON.stringify(edited.referencePath));
  });

  it('overrides only the fields it names, and never mutates the caller profile', () => {
    const profile = toyProfile({ annualLiving: 30000, charitableMonthly: 400 });
    const overridden = runSimulation(
      simInput(profile, {
        name: 'partial-override',
        // charitableMonthly explicitly undefined: it must fall through to the
        // profile's 400/mo, not erase the stream.
        assumption_overrides: {
          expenses: { livingMonthly: 3000, charitableMonthly: undefined },
        },
        events: [],
      }),
    ).referencePath;
    expect(overridden[0].expenses.baseline).toBeCloseTo(36000, 8); // overridden
    expect(overridden[0].expenses.charitable).toBeCloseTo(4800, 8); // 400 x 12, from the profile

    // prepareSim is pure: the caller's profile still says 30,000/yr.
    expect(profile.expenses.livingMonthly).toBe(2500);
    expect(profile.expenses.charitableMonthly).toBe(400);

    // An empty override object changes nothing at all.
    const empty = runSimulation(
      simInput(profile, {
        name: 'empty-override',
        assumption_overrides: { expenses: {} },
        events: [],
      }),
    ).referencePath;
    const none = runSimulation(
      simInput(profile, { name: 'no-override', events: [] }),
    ).referencePath;
    expect(JSON.stringify(empty)).toBe(JSON.stringify(none));
  });
});

// ---------------------------------------------------------------------------
// Paired streams + retirement income (note 19)
// ---------------------------------------------------------------------------

/**
 * A FULLY-STREAMED SHAPE: living 8,200/mo, giving 2,300/mo, investing 1,250/mo,
 * retiring mid-2028, claiming at FRA. Used twice — once on the shipped starter
 * balances (which run out) and once on a funded household (which does not, so
 * the path exercises the investing stream, the automatic 72(t), ACA, Medicare,
 * RMDs and Social Security).
 */
const STREAMED_EXPENSES: Profile['expenses'] = {
  livingMonthly: 8200,
  charitableMonthly: 2300,
  investingMonthly: 1250,
};

const streamedStarter = (): Profile => ({ ...starterProfile, expenses: { ...STREAMED_EXPENSES } });

const streamedFunded = (): Profile => {
  const scale: Record<string, number> = {
    k401: 2_200_000,
    ira1: 600_000,
    roth1: 300_000,
    roth2: 80_000,
    brokerage: 420_000,
    savings: 150_000,
  };
  return {
    ...starterProfile,
    expenses: { ...STREAMED_EXPENSES },
    income: { ...starterProfile.income, salaries: { p1: 260000, p2: 0 } },
    accounts: starterProfile.accounts.map((a) => {
      const balance = scale[a.id] ?? a.balance;
      return a.id === 'brokerage' ? { ...a, balance, costBasis: 250_000 } : { ...a, balance };
    }),
  };
};

const streamedPlan: Scenario = {
  name: 'streamed-shape',
  events: [
    { type: 'retire', person: 'p1', date: '2028-07' },
    { type: 'retire', person: 'p2', date: '2028-07' },
    // FRA 67 for the starter's two birthdates: 1975-03 -> 2042-03, 1977-09 -> 2044-09.
    { type: 'claim_social_security', person: 'p1', date: '2042-03' },
    { type: 'claim_social_security', person: 'p2', date: '2044-09' },
  ],
};

describe('paired streams: an untouched profile takes every default (notes 19, 20)', () => {
  /**
   * What note 19's defaults mean, pinned on the fully-streamed shape: living keeps
   * the working figure for life, investing falls to 0 with the paycheck, giving
   * keeps its 'continue' rule, and retirement income is nothing. A profile that
   * names none of the retired-side fields must behave exactly as if they did
   * not exist.
   *
   * HISTORY. Until note 20 this block also pinned a LEGACY digest: the same
   * fixture hashed against the engine as it stood BEFORE the paired values
   * existed, proving the defaults changed not one bit. Note 20 deliberately
   * ends that guarantee — a working year no longer banks its leftover pay, so
   * every working-year balance on this path moved on purpose. Reviving the
   * legacy pin would only assert the bug it corrected. What survives is the
   * stronger half: a full-path digest against the CURRENT engine, so any
   * unintended drift in any number of any year still fails loudly, plus the
   * explicit note-20 assertions below (which a digest alone would not explain).
   *
   * NOTE 21 RE-PINNED BOTH DIGESTS, and it is worth being precise about why,
   * because "the golden hash moved" is exactly the sentence that hides a
   * regression. The Tithe Account added three fields to YearRow.balances
   * (tithe / spendable / spendableReal). A JSON digest hashes the SHAPE of the
   * row as well as its values, so both hashes moved even though not one number
   * on either path changed: verified by re-running both fixtures against the
   * pre-note-21 engine and diffing every row field by field, key order
   * ignored — 0 differences on every year of both. The horizon is 2026..2072:
   * the LATER of the two people reaching 95 (p2, born 1977).
   *
   * THE DE-PERSONALISATION PASS RE-PINNED BOTH DIGESTS, for the same class of
   * reason and with the same care. The starter profile's two people used to
   * share one birth date; they now have two different invented ones, which
   * moves the horizon (41 -> 47 years), the FRA claim dates, the age-rated ACA
   * factors and every age-dependent divisor. The INPUT changed, so the digest
   * must. The ENGINE did not: every engine golden that does NOT read the
   * starter profile — mfjUnchanged, both preExpenseLinesUnchanged digests,
   * housingPlan, housingCycles, rentingWindow, guardrails §7, tithePair,
   * mortgagePayoff, survivorDownsize, bondComposition — passed across the same
   * change WITHOUT a re-pin. Everything these two tests assert by name (the
   * 98,400 baseline, the 27,600 giving, the unbudgeted years and amounts)
   * still holds unchanged; only the whole-path hash moved.
   * This fixture
   * carries no giving rule at all, so the whole feature is inert on it:
   * `tithe` is 0, `spendable` equals `total` and `spendableReal` equals
   * `totalReal` in every year, and no `tithe` block is emitted.
   */
  const pathDigest = (rows: YearRow[]): string =>
    createHash('sha256').update(JSON.stringify(rows)).digest('hex');

  it('holds every default on the starter balances', () => {
    const result = runSimulation(simInput(streamedStarter(), streamedPlan));
    const rows = result.referencePath;
    expect(rows).toHaveLength(47); // 2026..2072 (p2 born 1977, age 95)
    // Nothing configured -> no retirement income in any year.
    expect(rows.every((r) => r.income.retirement === 0)).toBe(true);
    // Living never switches: 8,200 x 12 = 98,400 in 2026, inflating for life,
    // retirement year and all (an absent livingMonthlyRetired means "the same").
    expect(rows[0].expenses.baseline).toBeCloseTo(98400, 8);
    expect(rows.find((r) => r.year === 2029)!.expenses.baseline).toBeCloseTo(
      98400 * 1.025 ** 3,
      6,
    );
    // Giving never switches either: 2,300 x 12 = 27,600, inflating for life.
    expect(rows[0].expenses.charitable).toBeCloseTo(27600, 8);
    expect(rows.some((r) => r.flags.includes('giving-rule'))).toBe(false);
    // On the shipped starter balances the 150,000 salary never covers
    // 101,400 of living plus 27,600 of giving, so there is no leftover in any
    // working year: nothing to invest and nothing to consume (note 20).
    expect(rows.every((r) => r.unbudgeted === 0)).toBe(true);
    expect(rows.every((r) => r.investing === 0)).toBe(true);
    expect(pathDigest(rows)).toBe(
      '70b4922fd419d33514e66b924d7825dd7721a4f672b4000b44a782f319ba5aee',
    );
  });

  it('holds them on a funded household that exercises every stream', () => {
    const result = runSimulation(simInput(streamedFunded(), streamedPlan));
    const rows = result.referencePath;
    expect(result.success).toBe(1); // solvent to the horizon
    // 1,250/mo x 12 worked months = 15,000 of investing in 2026...
    expect(rows[0].investing).toBeCloseTo(15000, 6);
    // ...and none at all once nobody works (absent investingMonthlyRetired = 0).
    expect(rows.filter((r) => r.year >= 2029).every((r) => r.investing === 0)).toBe(true);
    expect(rows.every((r) => r.income.retirement === 0)).toBe(true);
    // NOTE 20 on a household that really does have money left over: the
    // 260,000 salary leaves 45,504.03 in 2026 and 42,670.74 in 2027 after
    // taxes, expenses and the 15,000/15,375 investing stream — and every cent
    // of it is CONSUMED, not banked. 2028 (the retirement year) has no
    // leftover at all: half a year of salary no longer covers a full year of
    // spending, so it withdraws instead, which is also why its investing
    // transfer is 0 rather than a prorated 6,303-ish figure.
    const unbudgetedYears = rows.filter((r) => r.unbudgeted > 0).map((r) => r.year);
    expect(unbudgetedYears).toEqual([2026, 2027]);
    expect(rows[0].unbudgeted).toBeCloseTo(45504.03, 2);
    expect(rows[1].unbudgeted).toBeCloseTo(42670.74, 2);
    // Every year the household still earns is a no-sweep year, so nothing the
    // owner did not ask for accumulates.
    expect(rows.filter((r) => r.income.wages > 0).every((r) => r.unbudgeted >= 0)).toBe(true);
    expect(rows.filter((r) => r.income.wages === 0).every((r) => r.unbudgeted === 0)).toBe(true);
    expect(pathDigest(rows)).toBe(
      '2b37d6032724769dafff14df17f09dd715532f8ee038d50e2ead50c35fbfaef3',
    );
  });
});

describe('paired living expenses (note 19)', () => {
  /**
   * 100,000 salary for p1 retiring 2028-07 (6 worked months in 2028, 0 from
   * 2029), savings-only so no automatic 72(t) can elect, horizon 2026..2029.
   * Living is 30,000/yr while working; tests pass the retired figure.
   */
  const livingProfile = (livingMonthlyRetired?: number): Profile =>
    toyProfile({
      accounts: [
        toyAccount({
          id: 'savings',
          type: 'savings',
          owner: 'p1',
          balance: 500000,
          allocation: { stocks: 0, bonds: 0, bills: 1 },
        }),
      ],
      income: { salaries: { p1: 100000, p2: 0 }, contribution401k: 0, employerMatch401k: 0 },
      annualLiving: 30000,
      livingMonthlyRetired,
      horizonAge: 58, // 2026..2029
    });

  const retireMidYear: Scenario['events'] = [
    { type: 'retire', person: 'p1', date: '2028-07' },
  ];

  it('switches to the retired figure, prorating the retirement year', () => {
    /*
     * Working 2,500/mo = 30,000/yr; retired 2,000/mo = 24,000/yr.
     *   2026 (12 worked): 30,000 x 1                          = 30,000.00
     *   2027 (12 worked): 30,000 x 1.025                      = 30,750.00
     *   2028 ( 6 worked): working 30,000 x 1.025^2 = 31,518.75
     *                     retired 24,000 x 1.025^2 = 25,215.00
     *                     31,518.75 x 6/12 + 25,215 x 6/12    = 28,366.875
     *   2029 ( 0 worked): 24,000 x 1.025^3                    = 25,845.375
     */
    const rows = runSimulation(
      simInput(livingProfile(2000), { name: 'living-pair', events: retireMidYear }),
    ).referencePath;
    expect(rows[0].expenses.baseline).toBeCloseTo(30000, 8);
    expect(rows[1].expenses.baseline).toBeCloseTo(30750, 8);
    expect(rows[2].expenses.baseline).toBeCloseTo(28366.875, 8);
    expect(rows[3].expenses.baseline).toBeCloseTo(25845.375, 8);
    // Living is consumption: expenses.total keeps its five-component contract.
    for (const row of rows) {
      expect(row.expenses.total).toBeCloseTo(
        row.expenses.baseline +
          row.expenses.charitable +
          row.expenses.housing +
          row.expenses.health +
          row.expenses.oneTime,
        8,
      );
    }
  });

  it('an absent retired figure keeps the WORKING figure for life', () => {
    // The honest default: costs do not fall the day the salary stops.
    //   2028 = 30,000 x 1.025^2 = 31,518.75 (no proration at all)
    //   2029 = 30,000 x 1.025^3 = 32,306.71875
    const rows = runSimulation(
      simInput(livingProfile(undefined), { name: 'living-default', events: retireMidYear }),
    ).referencePath;
    expect(rows[2].expenses.baseline).toBeCloseTo(31518.75, 8);
    expect(rows[3].expenses.baseline).toBeCloseTo(32306.71875, 8);
    // A retired figure EQUAL to the working one is the same plan by hand.
    const same = runSimulation(
      simInput(livingProfile(2500), { name: 'living-same', events: retireMidYear }),
    ).referencePath;
    expect(same[2].expenses.baseline).toBeCloseTo(31518.75, 8);
    expect(same[3].expenses.baseline).toBeCloseTo(32306.71875, 8);
  });

  it("'living' expense_change events still multiply whatever the pair produced", () => {
    // 0.9 multiplier from 2029: 24,000 x 1.025^3 x 0.9 = 23,260.8375.
    const rows = runSimulation(
      simInput(livingProfile(2000), {
        name: 'living-pair-event',
        events: [
          ...retireMidYear,
          { type: 'expense_change', date: '2029-01', multiplier: 0.9, category: 'living' },
        ],
      }),
    ).referencePath;
    expect(rows[2].expenses.baseline).toBeCloseTo(28366.875, 8); // unchanged in 2028
    expect(rows[3].expenses.baseline).toBeCloseTo(23260.8375, 8);
  });

  it('is overridable per plan, identically to the profile edit', () => {
    const profile = livingProfile(undefined);
    const overridden = runSimulation(
      simInput(profile, {
        name: 'living-retired-override',
        assumption_overrides: { expenses: { livingMonthlyRetired: 2000 } },
        events: retireMidYear,
      }),
    );
    const edited = runSimulation(
      simInput(livingProfile(2000), { name: 'living-retired-profile', events: retireMidYear }),
    );
    expect(JSON.stringify(overridden.referencePath)).toBe(JSON.stringify(edited.referencePath));
    // The profile is a working copy, never mutated.
    expect(profile.expenses.livingMonthlyRetired).toBeUndefined();
    // ...and the run really differs from the un-overridden profile.
    const base = runSimulation(
      simInput(profile, { name: 'living-retired-base', events: retireMidYear }),
    );
    expect(base.referencePath[3].expenses.baseline).toBeCloseTo(32306.71875, 8);
    expect(overridden.meta.hashes.profile).toBe(base.meta.hashes.profile);
    expect(overridden.meta.runKey).not.toBe(base.meta.runKey);
  });
});

describe('paired investing transfer (note 19)', () => {
  /**
   * Savings 1,000,000 (bills) + brokerage 200,000 (100% bills, so its sleeve
   * return is DISTRIBUTED and the price stays flat — the balance moves only by
   * transfers), p1 earning 60,000 and retiring 2028-07, living 12,000/yr.
   * Retirement income is nil, so the retired years' surplus is pure interest
   * less spending — comfortably more than the retired stream wants.
   */
  const investProfile = (investingMonthlyRetired?: number): Profile =>
    toyProfile({
      accounts: [
        toyAccount({
          id: 'savings',
          type: 'savings',
          owner: 'p1',
          balance: 1000000,
          allocation: { stocks: 0, bonds: 0, bills: 1 },
        }),
        toyAccount({
          id: 'brokerage',
          type: 'taxable_brokerage',
          owner: 'p1',
          balance: 200000,
          costBasis: 200000,
          allocation: { stocks: 0, bonds: 0, bills: 1 },
        }),
      ],
      income: { salaries: { p1: 60000, p2: 0 }, contribution401k: 0, employerMatch401k: 0 },
      annualLiving: 12000,
      investingMonthly: 1000,
      investingMonthlyRetired,
      horizonAge: 58, // 2026..2029
    });

  const retireMidYear: Scenario['events'] = [{ type: 'retire', person: 'p1', date: '2028-07' }];

  it('keeps investing after retirement, prorating the retirement year', () => {
    /*
     * Working 1,000/mo, retired 500/mo:
     *   2026 (12 worked): 1,000 x 12 x 1            = 12,000.00
     *   2027 (12 worked): 12,000 x 1.025            = 12,300.00
     *   2028 ( 6 worked): (1,000 x 6 + 500 x 6) x 1.025^2
     *                   = 9,000 x 1.050625          =  9,455.625
     *   2029 ( 0 worked): 500 x 12 x 1.025^3        =  6,461.34375
     * Every one of those is below the year's surplus, so none is capped.
     */
    const rows = runSimulation(
      simInput(investProfile(500), { name: 'investing-pair', events: retireMidYear }),
    ).referencePath;
    expect(rows[0].investing).toBeCloseTo(12000, 6);
    expect(rows[1].investing).toBeCloseTo(12300, 6);
    expect(rows[2].investing).toBeCloseTo(9455.625, 6);
    expect(rows[3].investing).toBeCloseTo(6461.34375, 6);
    // Still a transfer, not consumption: never in expenses.total, and the
    // brokerage took the cash as balance AND basis (100% bills, so no growth
    // and no realized gain muddies it).
    for (const row of rows) {
      expect(row.expenses.total).toBeCloseTo(
        row.expenses.baseline +
          row.expenses.charitable +
          row.expenses.housing +
          row.expenses.health +
          row.expenses.oneTime,
        8,
      );
    }
    expect(rows[3].withdrawals.cash).toBe(0); // funded from surplus, never a draw

    // Absent = 0: the stream still ends with the paycheck.
    const stops = runSimulation(
      simInput(investProfile(undefined), { name: 'investing-default', events: retireMidYear }),
    ).referencePath;
    expect(stops[2].investing).toBeCloseTo(6303.75, 6); // 1,000 x 6 x 1.025^2
    expect(stops[3].investing).toBe(0);
  });

  it('is capped by the surplus in retirement, exactly like the working stream', () => {
    // 5,000/mo retired wants 60,000 x 1.025^3 = 64,613.4375 in 2029 — far more
    // than the year's surplus. The engine may never borrow to invest, so the
    // transfer is the surplus itself and not a dollar more.
    const rows = runSimulation(
      simInput(investProfile(5000), { name: 'investing-capped', events: retireMidYear }),
    ).referencePath;
    const y2029 = rows[3];
    expect(y2029.investing).toBeGreaterThan(0);
    expect(y2029.investing).toBeLessThan(60000 * 1.025 ** 3);
    // No withdrawal at all, and the whole surplus went into the transfer:
    // surplus = income - (expenses.total + taxes), with no draws in the year.
    expect(y2029.withdrawals.cash).toBe(0);
    expect(y2029.withdrawals.taxable).toBe(0);
    const surplus =
      y2029.income.taxableInterest +
      y2029.income.dividends -
      (y2029.expenses.total + y2029.taxes.totalTax);
    expect(y2029.investing).toBeCloseTo(surplus, 6);
  });

  it('is overridable per plan, identically to the profile edit', () => {
    const profile = investProfile(undefined);
    const overridden = runSimulation(
      simInput(profile, {
        name: 'investing-retired-override',
        assumption_overrides: { expenses: { investingMonthlyRetired: 500 } },
        events: retireMidYear,
      }),
    );
    const edited = runSimulation(
      simInput(investProfile(500), { name: 'investing-retired-profile', events: retireMidYear }),
    );
    expect(JSON.stringify(overridden.referencePath)).toBe(JSON.stringify(edited.referencePath));
    expect(profile.expenses.investingMonthlyRetired).toBeUndefined();
  });
});

describe("giving in retirement: 'amount' — a plain different figure (note 19)", () => {
  /**
   * Same shape as the 'none' fixture: 100,000 salary for p1 retiring 2028-07,
   * 500/mo of giving while working, savings-only, 2026..2029.
   */
  const amountProfile = (rule: Profile['expenses']['retirementGiving']): Profile => {
    const p = toyProfile({
      accounts: [
        toyAccount({
          id: 'savings',
          type: 'savings',
          owner: 'p1',
          balance: 500000,
          allocation: { stocks: 0, bonds: 0, bills: 1 },
        }),
      ],
      income: { salaries: { p1: 100000, p2: 0 }, contribution401k: 0, employerMatch401k: 0 },
      annualLiving: 30000,
      charitableMonthly: 500,
      horizonAge: 58, // 2026..2029
    });
    p.expenses.retirementGiving = rule;
    return p;
  };

  const retireMidYear: Scenario['events'] = [{ type: 'retire', person: 'p1', date: '2028-07' }];

  it('gives the stated amount in today’s dollars, inflation-adjusted', () => {
    /*
     * Paycheck giving 500/mo = 6,000/yr; the rule says 200/mo = 2,400/yr.
     *   2026, 2027 (12 worked): 6,000 and 6,150 — the paycheck stream.
     *   2028 ( 6 worked): 6,000 x 1.025^2 x 6/12 + 2,400 x 1.025^2 x 6/12
     *                   = 3,151.875 + 1,260.75          = 4,412.625
     *   2029 ( 0 worked): 2,400 x 1.025^3               = 2,584.5375
     */
    const rows = runSimulation(
      simInput(amountProfile({ type: 'amount', monthly: 200 }), {
        name: 'giving-amount',
        events: retireMidYear,
      }),
    ).referencePath;
    expect(rows[0].expenses.charitable).toBeCloseTo(6000, 8);
    expect(rows[1].expenses.charitable).toBeCloseTo(6150, 8);
    expect(rows[2].expenses.charitable).toBeCloseTo(4412.625, 8);
    expect(rows[3].expenses.charitable).toBeCloseTo(2584.5375, 8);
    expect(rows[0].flags).not.toContain('giving-rule');
    expect(rows[2].flags).toContain('giving-rule');
    expect(rows[3].flags).toContain('giving-rule');

    // Auditability: the traced year names the rule and shows the arithmetic.
    const trace = rows[3].taxes.trace!;
    const headline = trace.find((t) => t.label.startsWith('Charitable giving'))!;
    expect(headline.label).toContain('200/month in 2026 dollars');
    expect(headline.amount).toBeCloseTo(2584.5375, 8);
    const ruleLine = trace.find((t) => t.label.startsWith('Rule amount'))!;
    expect(ruleLine.amount).toBeCloseTo(2584.5375, 8);
    // No prior-year base is read at all — this rule has none.
    expect(trace.some((t) => t.label.startsWith('Base'))).toBe(false);
  });

  it('an amount equal to the paycheck stream IS the continue rule, to the cent', () => {
    const events = retireMidYear;
    const amount = runSimulation(
      simInput(amountProfile({ type: 'amount', monthly: 500 }), { name: 'amount-500', events }),
    ).referencePath;
    const kept = runSimulation(
      simInput(amountProfile({ type: 'continue' }), { name: 'continue', events }),
    ).referencePath;
    for (let yi = 0; yi < amount.length; yi++) {
      expect(amount[yi].expenses.charitable).toBeCloseTo(kept[yi].expenses.charitable, 10);
      expect(amount[yi].balances.total).toBeCloseTo(kept[yi].balances.total, 6);
    }
  });

  it('feeds the charitable deduction and is selectable per plan', () => {
    const profile = amountProfile(undefined); // profile default = 'continue'
    const overridden = runSimulation(
      simInput(profile, {
        name: 'amount-override',
        assumption_overrides: { expenses: { retirementGiving: { type: 'amount', monthly: 200 } } },
        events: retireMidYear,
      }),
    ).referencePath;
    expect(overridden[3].expenses.charitable).toBeCloseTo(2584.5375, 8);
    expect(profile.expenses.retirementGiving).toBeUndefined();

    // The tax side still sees it: giving 2,584.54 against a year whose only
    // income is savings interest, so the OBBBA non-itemizer deduction applies
    // (capped at 2,000 MFJ) exactly as it does for the paycheck stream.
    const none = runSimulation(
      simInput(amountProfile({ type: 'none' }), { name: 'amount-none', events: retireMidYear }),
    ).referencePath;
    expect(none[3].expenses.charitable).toBe(0);
    expect(overridden[3].taxes.federal.agi).toBeGreaterThan(0);
  });
});

describe('retirement income stream (note 19)', () => {
  /**
   * Fully retired from the first year (no salaries at all), savings 400,000 in
   * bills, living 96,000/yr — a household whose only other income is the
   * distributed savings interest, so every figure below is hand-computable:
   *   interest 2026 = 400,000 x 0.030125 = 12,050.00
   */
  const incomeProfile = (over?: {
    retirementMonthly?: number;
    retirementIncomeTaxable?: boolean;
  }): Profile =>
    toyProfile({
      accounts: [
        toyAccount({
          id: 'savings',
          type: 'savings',
          owner: 'p1',
          balance: 400000,
          allocation: { stocks: 0, bonds: 0, bills: 1 },
        }),
      ],
      annualLiving: 96000,
      retirementMonthly: over?.retirementMonthly,
      retirementIncomeTaxable: over?.retirementIncomeTaxable,
      horizonAge: 57, // 2026..2028
    });

  const run = (over?: { retirementMonthly?: number; retirementIncomeTaxable?: boolean }) =>
    runSimulation(simInput(incomeProfile(over), { name: 'retirement-income', events: [] }))
      .referencePath;

  it('reduces the withdrawal the year needs and, when taxable, raises AGI', () => {
    /*
     * 2026, all three runs share the same start balance, so interest is the
     * same 12,050.00 in each.
     *
     * A — no retirement income:
     *   AGI = 12,050, below the 32,200 federal standard deduction and below
     *   the VA standard deduction (17,500) + exemptions (2 x 930), so tax = 0.
     *   withdrawal = 96,000 - 12,050                        = 83,950.00
     *
     * B — 5,000/mo = 60,000/yr, TAXABLE (the default):
     *   AGI = 12,050 + 60,000                               = 72,050.00
     *   federal taxable = 72,050 - 32,200                   = 39,850.00
     *     tax = 0.10 x 24,800 + 0.12 x (39,850 - 24,800)
     *         = 2,480 + 1,806                               =  4,286.00
     *   VA taxable = 72,050 - 17,500 - 1,860                = 52,690.00
     *     tax = 60 + 60 + 600 + 0.0575 x (52,690 - 17,000)
     *         = 720 + 2,052.175                             =  2,772.175
     *   total tax                                           =  7,058.175
     *   withdrawal = 96,000 + 7,058.175 - 12,050 - 60,000   = 31,008.175
     */
    const a = run();
    const b = run({ retirementMonthly: 5000 });

    expect(a[0].income.retirement).toBe(0);
    expect(b[0].income.retirement).toBeCloseTo(60000, 8);
    expect(a[0].taxes.totalTax).toBe(0);
    expect(a[0].withdrawals.cash).toBeCloseTo(83950, 6);

    // The tax effect, hand-computed above.
    expect(b[0].taxes.federal.agi).toBeCloseTo(72050, 6);
    expect(b[0].taxes.federal.agi - a[0].taxes.federal.agi).toBeCloseTo(60000, 6);
    expect(b[0].taxes.federal.total).toBeCloseTo(4286, 4);
    expect(b[0].taxes.state.total).toBeCloseTo(2772.175, 4);
    expect(b[0].taxes.totalTax).toBeCloseTo(7058.175, 4);
    // The cash effect: 60,000 less to withdraw, plus the tax it now owes.
    expect(b[0].withdrawals.cash).toBeCloseTo(31008.175, 4);
    expect(b[0].withdrawals.cash).toBeCloseTo(
      a[0].withdrawals.cash - 60000 + b[0].taxes.totalTax,
      6,
    );
    // ...and the balance that is left is bigger, year after year.
    expect(b[2].balances.total).toBeGreaterThan(a[2].balances.total);

    // The recorded-cash identity still closes with the new component counted
    // exactly once (no surplus and no investing in these years, so:
    // income + withdrawals = expenses.total + taxes):
    //   12,050 + 60,000 + 31,008.175 = 96,000 + 7,058.175
    for (const row of b) {
      const income =
        row.income.wages +
        row.income.socialSecurity +
        row.income.retirement +
        row.income.taxableInterest +
        row.income.dividends +
        row.income.other;
      const gross =
        row.withdrawals.cash +
        row.withdrawals.taxable +
        row.withdrawals.pretax +
        row.withdrawals.roth;
      expect(income + gross).toBeCloseTo(
        row.expenses.total + row.taxes.totalTax + row.investing,
        6,
      );
    }
  });

  it('retirementIncomeTaxable false raises neither AGI nor any MAGI', () => {
    // C — 60,000/yr of NON-taxable cash (a return of capital, a gift): the
    // withdrawal falls by exactly 60,000 and no tax figure moves at all.
    const a = run();
    const c = run({ retirementMonthly: 5000, retirementIncomeTaxable: false });

    expect(c[0].income.retirement).toBeCloseTo(60000, 8);
    expect(c[0].withdrawals.cash).toBeCloseTo(23950, 6); // 83,950 - 60,000
    expect(c[0].withdrawals.cash).toBeCloseTo(a[0].withdrawals.cash - 60000, 6);
    expect(c[0].taxes.totalTax).toBe(0);
    expect(c[0].taxes.federal.agi).toBeCloseTo(a[0].taxes.federal.agi, 8);
    expect(c[0].taxes.federal.taxableIncome).toBeCloseTo(a[0].taxes.federal.taxableIncome, 8);
    // Every MAGI variant: ACA (the subsidy cliff), IRMAA, NIIT.
    expect(c[0].taxes.magi.acaMagi).toBeCloseTo(a[0].taxes.magi.acaMagi, 8);
    expect(c[0].taxes.magi.irmaaMagi).toBeCloseTo(a[0].taxes.magi.irmaaMagi, 8);
    expect(c[0].taxes.magi.niitMagi).toBeCloseTo(a[0].taxes.magi.niitMagi, 8);
    // The taxable twin moves all of them.
    const b = run({ retirementMonthly: 5000 });
    expect(b[0].taxes.magi.acaMagi - c[0].taxes.magi.acaMagi).toBeCloseTo(60000, 6);
    expect(b[0].taxes.magi.irmaaMagi - c[0].taxes.magi.irmaaMagi).toBeCloseTo(60000, 6);
  });

  it('starts the first year nobody earns, prorated in the retirement year, for life', () => {
    /*
     * p1 earns 100,000 and retires 2028-07 -> 6 worked months in 2028, none
     * after. Retirement income 1,000/mo:
     *   2026, 2027: nobody has stopped working -> 0
     *   2028: 1,000 x 6 months x 1.025^2   = 6,000 x 1.050625 = 6,303.75
     *   2029: 1,000 x 12 x 1.025^3         = 12,000 x 1.076890625 = 12,922.6875
     */
    const p = toyProfile({
      accounts: [
        toyAccount({
          id: 'savings',
          type: 'savings',
          owner: 'p1',
          balance: 400000,
          allocation: { stocks: 0, bonds: 0, bills: 1 },
        }),
      ],
      income: { salaries: { p1: 100000, p2: 0 }, contribution401k: 0, employerMatch401k: 0 },
      annualLiving: 96000,
      retirementMonthly: 1000,
      horizonAge: 58, // 2026..2029
    });
    const rows = runSimulation(
      simInput(p, {
        name: 'retirement-income-proration',
        events: [{ type: 'retire', person: 'p1', date: '2028-07' }],
      }),
    ).referencePath;
    expect(rows[0].income.retirement).toBe(0);
    expect(rows[1].income.retirement).toBe(0);
    expect(rows[2].income.retirement).toBeCloseTo(6303.75, 8);
    expect(rows[3].income.retirement).toBeCloseTo(12922.6875, 8);
    // Wages and retirement income are separate components; the retirement
    // stream never lands in `other` (one-time income).
    expect(rows[2].income.wages).toBeCloseTo(50000, 6); // 100,000 x 6/12
    expect(rows.every((r) => r.income.other === 0)).toBe(true);
  });

  it('shrinks the automatic 72(t) the bridge sizes, and locks up less of the IRA', () => {
    /*
     * A 3,000,000 IRA (bills) plus 50,000 of savings, p1 earning 100,000 and
     * retiring 2028-07 — well before the 2031 penalty-free year, so the bridge
     * elects automatically. Living 96,000/yr. The IRA is large enough that the
     * formula maximum (and the 75% ceiling on it) never binds, so the payment
     * is the household's projected retired NEED — which is exactly what
     * retirement income reduces.
     */
    const build = (retirementMonthly?: number): Profile =>
      toyProfile({
        accounts: [
          toyAccount({
            id: 'savings',
            type: 'savings',
            owner: 'p1',
            balance: 50000,
            allocation: { stocks: 0, bonds: 0, bills: 1 },
          }),
          toyAccount({
            id: 'ira',
            type: 'traditional_ira',
            owner: 'p1',
            balance: 3000000,
            allocation: { stocks: 0, bonds: 0, bills: 1 },
          }),
        ],
        income: { salaries: { p1: 100000, p2: 0 }, contribution401k: 0, employerMatch401k: 0 },
        annualLiving: 96000,
        retirementMonthly,
        horizonAge: 62, // 2026..2033, covering the whole lock
      });
    const scenario: Scenario = {
      name: 'auto-sepp-retirement-income',
      events: [{ type: 'retire', person: 'p1', date: '2028-07' }],
    };
    const rowIn2029 = (retirementMonthly?: number): YearRow => {
      const rows = runSimulation(simInput(build(retirementMonthly), scenario)).referencePath;
      const row = rows.find((r) => r.year === 2029)!;
      expect(row.flags).toContain('sepp');
      return row;
    };
    const without = rowIn2029();
    const withIncome = rowIn2029(3000);
    const payment = (row: YearRow): number => row.withdrawals.byAccount['ira-sepp'];
    expect(payment(without)).toBeCloseTo(100429.05, 1);
    expect(payment(withIncome)).toBeCloseTo(62613.83, 1);
    /*
     * A full retired year of that income is 3,000 x 12 x 1.025^2 = 37,822.50,
     * and the series sheds essentially all of it: the SEPP dollars it replaces
     * were ordinary income taxed at the same rate, so the swap is nearly
     * one-for-one (the 7.28 residual is that second-order tax difference).
     */
    expect(payment(without) - payment(withIncome)).toBeCloseTo(37815.22, 1);
    expect(payment(without) - payment(withIncome)).toBeLessThan(37822.5);
    // Less of the IRA is locked, too: the carve-out is sized to the payment.
    expect(withIncome.balances.byAccount['ira-sepp']).toBeLessThan(
      without.balances.byAccount['ira-sepp'],
    );
    expect(withIncome.balances.byAccount['ira']).toBeGreaterThan(
      without.balances.byAccount['ira'],
    );
  });

  it('is overridable per plan — the amount and its taxability', () => {
    const profile = incomeProfile();
    const overridden = runSimulation(
      simInput(profile, {
        name: 'income-override',
        assumption_overrides: { income: { retirementMonthly: 5000 } },
        events: [],
      }),
    );
    const edited = runSimulation(
      simInput(incomeProfile({ retirementMonthly: 5000 }), {
        name: 'income-profile',
        events: [],
      }),
    );
    expect(JSON.stringify(overridden.referencePath)).toBe(JSON.stringify(edited.referencePath));

    // Taxability is overridable on its own, on top of a profile amount.
    const taxFree = runSimulation(
      simInput(incomeProfile({ retirementMonthly: 5000 }), {
        name: 'income-taxfree-override',
        assumption_overrides: { income: { retirementIncomeTaxable: false } },
        events: [],
      }),
    ).referencePath;
    expect(taxFree[0].income.retirement).toBeCloseTo(60000, 8);
    expect(taxFree[0].taxes.totalTax).toBe(0);

    // The caller's profile is untouched, and an empty income override is a no-op.
    expect(profile.income.retirementMonthly).toBeUndefined();
    const empty = runSimulation(
      simInput(profile, { name: 'income-empty', assumption_overrides: { income: {} }, events: [] }),
    ).referencePath;
    const none = runSimulation(
      simInput(profile, { name: 'income-none', events: [] }),
    ).referencePath;
    expect(JSON.stringify(empty)).toBe(JSON.stringify(none));
  });
});

describe('employee share of the employer health premium (note 13)', () => {
  const shareProfile = (employerPremiumShareMonthly: number): Profile =>
    toyProfile({
      accounts: [
        toyAccount({
          id: 'savings',
          type: 'savings',
          owner: 'p1',
          balance: 100000,
          allocation: { stocks: 0, bonds: 0, bills: 1 },
        }),
        // The deferral needs somewhere to land, so the household has a 401(k).
        toyAccount({
          id: 'k401',
          type: '401k',
          owner: 'p1',
          balance: 0,
          allocation: { stocks: 0, bonds: 0, bills: 1 },
        }),
      ],
      income: { salaries: { p1: 100000, p2: 0 }, contribution401k: 10000, employerMatch401k: 0 },
      annualLiving: 30000,
      employerPremiumShareMonthly,
      horizonAge: 57, // 2026..2028
    });

  it('reduces W-2 wages like the 401(k) deferral, is never a health expense, and ends at retirement', () => {
    const events: Scenario['events'] = [{ type: 'retire', person: 'p1', date: '2027-07' }];
    const paying = runSimulation(
      simInput(shareProfile(300), { name: 'premium-share', events }),
    ).referencePath;
    const free = runSimulation(
      simInput(shareProfile(0), { name: 'no-premium-share', events }),
    ).referencePath;

    // 2026: wages after the 10,000 deferral = 90,000; the share is
    // 300 x 12 x CPI 1.0 = 3,600, so reported wages = 86,400.
    expect(paying[0].income.employerHealthPremiumShare).toBeCloseTo(3600, 8);
    expect(paying[0].income.wages).toBeCloseTo(86400, 8);
    expect(free[0].income.wages).toBeCloseTo(90000, 8);
    // Taxed on the reduced wages (Section 125): AGI = wages + savings interest.
    expect(paying[0].taxes.federal.agi).toBeCloseTo(86400 + 100000 * BILLS_NOM, 6);
    expect(free[0].taxes.federal.agi - paying[0].taxes.federal.agi).toBeCloseTo(3600, 6);
    // It is a payroll deduction, NOT a health expense (employer coverage all year).
    expect(paying[0].expenses.health).toBe(0);
    expect(paying[0].expenses.total).toBeCloseTo(free[0].expenses.total, 8);
    // And it really is cash out the door. Note 20 means a working year banks
    // nothing (savings is identical at 100,000 in both runs), so the effect
    // now shows up where the leftover actually goes: the household that pays
    // the share has exactly 3,600 less of it, net of the tax the deduction
    // saved.
    expect(paying[0].balances.byAccount['savings']).toBeCloseTo(100000, 6);
    expect(free[0].balances.byAccount['savings']).toBeCloseTo(100000, 6);
    expect(paying[0].unbudgeted).toBeLessThan(free[0].unbudgeted);
    expect(free[0].unbudgeted - paying[0].unbudgeted).toBeCloseTo(
      3600 - (free[0].taxes.totalTax - paying[0].taxes.totalTax),
      6,
    );

    // 2027: retires in July -> 6 worked months. Deferral min(10,000 x 6/12,
    // 50,000) = 5,000 -> 45,000 of wages; share = 300 x 6 x 1.025 = 1,845.
    expect(paying[1].income.employerHealthPremiumShare).toBeCloseTo(1845, 8);
    expect(paying[1].income.wages).toBeCloseTo(45000 - 1845, 8);
    // 2028: nobody works -> no wages and no premium share.
    expect(paying[2].income.wages).toBe(0);
    expect(paying[2].income.employerHealthPremiumShare).toBe(0);
  });
});

describe('72(t)/SEPP (note 16)', () => {
  /**
   * Hand-computed payment for every case below (fixed amortization):
   *   B = 300,000 at election, r = 0.05 (Notice 2022-6 default),
   *   N = 31.6 (single life expectancy at the user's attained age 55 in 2026)
   *   1.05^31.6 = e^(31.6 x 0.0487901642) = 4.67285011
   *   P = 300,000 x 0.05 / (1 - 1/4.67285011)
   *     = 15,000 / 0.78599784 = 19,084.0218
   */
  const SEPP_PAYMENT = 19084.0218;

  const seppProfile = (over?: { savings?: number; annualLiving?: number }): Profile =>
    toyProfile({
      accounts: [
        toyAccount({
          id: 'ira',
          name: 'Traditional IRA',
          type: 'traditional_ira',
          owner: 'p1',
          balance: 300000,
          // 100% bills: the IRA compounds at exactly 1.030125 a year.
          allocation: { stocks: 0, bonds: 0, bills: 1 },
        }),
        toyAccount({
          id: 'savings',
          type: 'savings',
          owner: 'p1',
          balance: over?.savings ?? 50000,
          allocation: { stocks: 0, bonds: 0, bills: 1 },
        }),
      ],
      annualLiving: over?.annualLiving ?? 20000,
      horizonAge: 62, // 2026..2033
    });

  it('forces the amortized payment every year of the lock, then releases the account', () => {
    const rows = runSimulation(
      simInput(seppProfile(), {
        name: 'sepp',
        events: [{ type: 'start_72t', date: '2026-06', account: 'ira' }],
      }),
    ).referencePath;

    // Lock = the LATER of five payments (2026..2030) and the first
    // penalty-free year (59 1/2 in Dec 2030 -> 2031): 2026 through 2031.
    for (let yi = 0; yi <= 5; yi++) {
      expect(rows[yi].year).toBe(2026 + yi);
      expect(rows[yi].withdrawals.byAccount['ira']).toBeCloseTo(SEPP_PAYMENT, 3);
      expect(rows[yi].withdrawals.pretax).toBeCloseTo(SEPP_PAYMENT, 3);
      expect(rows[yi].flags).toContain('sepp');
      // The exception applies: no 10% penalty on any of it.
      expect(rows[yi].taxes.penalties).toBe(0);
      expect(rows[yi].flags).not.toContain('penalty');
    }
    // It is forced income even though spending is well covered: the surplus
    // sweeps into savings instead of staying in the IRA.
    expect(rows[0].taxes.federal.agi).toBeGreaterThan(SEPP_PAYMENT);
    expect(rows[0].balances.byAccount['savings']).toBeGreaterThan(50000);

    // 2032-2033: the lock is over. No payment is forced any more, and the
    // account is simply a normal IRA again — available on demand, and
    // penalty-free now that the user is past 59 1/2 (2033 is the year
    // savings finally runs out, so the engine taps it).
    expect(rows[6].year).toBe(2032);
    expect(rows[6].withdrawals.byAccount['ira'] ?? 0).toBe(0);
    expect(rows[6].flags).not.toContain('sepp');
    expect(rows[7].withdrawals.byAccount['ira']).toBeGreaterThan(0);
    expect(rows[7].flags).not.toContain('sepp');
    expect(rows[7].taxes.penalties).toBe(0);

    // Balance path: 300,000 - P, compounded at the bills rate.
    expect(rows[0].balances.byAccount['ira']).toBeCloseTo((300000 - SEPP_PAYMENT) * 1.030125, 2);
    expect(rows[1].balances.byAccount['ira']).toBeCloseTo(
      ((300000 - SEPP_PAYMENT) * 1.030125 - SEPP_PAYMENT) * 1.030125,
      2,
    );

    // The trace carries the amortization inputs on the reference path.
    const trace = rows[0].taxes.trace!;
    const start = trace.findIndex((l) => l.label.includes('72(t) SEPP distribution'));
    expect(start).toBeGreaterThanOrEqual(0);
    const block = trace.slice(start, start + 6);
    const amountOf = (frag: string) => block.find((l) => l.label.includes(frag))?.amount;
    expect(block[0].amount).toBeCloseTo(SEPP_PAYMENT, 3);
    expect(amountOf('B — account balance at election')).toBeCloseTo(300000, 6);
    expect(amountOf('r — amortization interest rate')).toBe(0.05);
    expect(amountOf('N — single life expectancy at age 55')).toBe(31.6);
    expect(block.some((l) => (l.note ?? '').includes('120% of the federal mid-term AFR'))).toBe(true);
  });

  it('takes the smaller of the requested amount and the formula maximum', () => {
    const smaller = runSimulation(
      simInput(seppProfile(), {
        name: 'sepp-requested',
        events: [
          { type: 'start_72t', date: '2026-06', account: 'ira', annualAmount: 10000 },
        ],
      }),
    ).referencePath;
    // 10,000 < 19,084.02 -> the split-IRA technique: the payment comes out of
    // a SEPP IRA carved off for exactly that payment, and the account keeping
    // the original id is the (untouched, unlocked) remainder.
    //   fraction  = 10,000 / 19,084.0218          = 0.5240341
    //   principal = 0.5240341 x 300,000           = 157,199.5687
    //   remainder = 300,000 - 157,199.5687        = 142,800.4313
    expect(smaller[0].withdrawals.byAccount['ira-sepp']).toBeCloseTo(10000, 6);
    expect(smaller[3].withdrawals.byAccount['ira-sepp']).toBeCloseTo(10000, 6);
    // 50,000 of savings against 20,000/yr of spending plus a 10,000 payment:
    // nothing needs to come out of the remainder in these years.
    expect(smaller[0].withdrawals.byAccount['ira'] ?? 0).toBe(0);
    expect(smaller[0].balances.byAccount['ira']).toBeCloseTo(142800.4313 * 1.030125, 2);
    expect(smaller[0].balances.byAccount['ira-sepp']).toBeCloseTo(
      (157199.5687 - 10000) * 1.030125,
      2,
    );

    const capped = runSimulation(
      simInput(seppProfile(), {
        name: 'sepp-capped',
        events: [
          { type: 'start_72t', date: '2026-06', account: 'ira', annualAmount: 50000 },
        ],
      }),
    ).referencePath;
    // 50,000 > the maximum -> capped at 19,084.02, which needs the WHOLE
    // balance to support it: fraction 1, so there is no split and no carve-out.
    expect(capped[0].withdrawals.byAccount['ira']).toBeCloseTo(SEPP_PAYMENT, 3);
    expect(capped[0].balances.byAccount['ira-sepp']).toBeUndefined();

    // A lower rate amortizes to a smaller payment:
    //   1.03^31.6 = e^(31.6 x 0.0295588022) = e^0.9340581 = 2.5447628
    //   P = 300,000 x 0.03 / (1 - 1/2.5447628) = 9,000 / 0.60703... = 14,825.6
    const lowRate = runSimulation(
      simInput(seppProfile(), {
        name: 'sepp-rate',
        events: [
          { type: 'start_72t', date: '2026-06', account: 'ira', interestRate: 0.03 },
        ],
      }),
    ).referencePath;
    expect(lowRate[0].withdrawals.byAccount['ira']).toBeCloseTo(14825.6, 0);
    expect(lowRate[0].withdrawals.byAccount['ira']).toBeLessThan(SEPP_PAYMENT);
  });

  it('BUSTS the series rather than failing beside its own money (the wall became a price)', () => {
    /*
     * RENAMED FROM "never draws anything EXTRA from the locked account, even
     * facing insolvency" — the property this pinned was the WALL, and the wall
     * is what the 0.0% incident retired (DECISIONS.md): an automatic election
     * could score a plan zero while it held $1.6M+. The ordering still never
     * reaches into a locked account mid-order (the pure-function tests in
     * withdrawals.test.ts keep that pin); what changed is the LAST RESORT — a
     * year that cannot be met after every unlocked source busts the series,
     * pays the IRC 72(t)(4) recapture, and spends its own money.
     *
     * 5,000 of cash against 60,000/yr of spending, with 40,000 in an IRA
     * under a full 72(t) (no annualAmount -> no split, whole account locked):
     *   P = 40,000 x 0.05 / 0.78599784 = 2,544.5362
     * 2026 pays the fixed P, comes up short, and busts in the same year:
     *   recapture base = 2,544.5362 (this year's payment; zero elapsed years,
     *   so no interest), recapture = 254.4536
     *   busting draw    = 40,000 - 2,544.5362 = 37,455.4638, penalized 10%
     *   total penalties = 0.10 x 40,000 = 4,000.00 exactly
     */
    const profile = toyProfile({
      accounts: [
        toyAccount({
          id: 'ira',
          type: 'traditional_ira',
          owner: 'p1',
          balance: 40000,
          allocation: { stocks: 0, bonds: 0, bills: 1 },
        }),
        toyAccount({
          id: 'savings',
          type: 'savings',
          owner: 'p1',
          balance: 5000,
          allocation: { stocks: 0, bonds: 0, bills: 1 },
        }),
      ],
      annualLiving: 60000,
      horizonAge: 60, // 2026..2031
    });
    const rows = runSimulation(
      simInput(profile, {
        name: 'sepp-locked',
        events: [{ type: 'start_72t', date: '2026-06', account: 'ira' }],
      }),
    ).referencePath;

    // The fixed payment still went out first, and the bust took the rest.
    expect(rows[0].withdrawals.byAccount['ira']).toBeCloseTo(40000, 3);
    expect(rows[0].flags).toContain('sepp');
    expect(rows[0].eventsFired).toContain('sepp-busted');
    expect(rows[0].balances.byAccount['ira-sepp']).toBeUndefined(); // no split
    // The price: 10% of the recaptured payment + 10% of the busting draw.
    expect(rows[0].taxes.penalties).toBeCloseTo(4000, 2);
    // Even the bust cannot make 45,000 cover 60,000+: the path still fails —
    // honestly, with its own money spent rather than walled off.
    expect(rows[0].flags).toContain('insolvent');
    expect(rows[0].balances.byAccount['ira']).toBe(0);

    // The series is OVER, permanently: no forced payment ever again, no lock,
    // and no sepp-depleted flag (the account did not run dry — it was spent).
    for (let yi = 1; yi < rows.length; yi++) {
      expect(rows[yi].withdrawals.byAccount['ira'] ?? 0).toBe(0);
      expect(rows[yi].flags).not.toContain('sepp');
      expect(rows[yi].flags).not.toContain('sepp-depleted');
      expect(rows[yi].eventsFired).not.toContain('sepp-busted');
    }

    // The trace itemises the price in the bust year.
    const trace = rows[0].taxes.trace!;
    const bust = trace.find((l) => l.label.startsWith('72(t) series BUSTED'));
    expect(bust).toBeDefined();
    expect(bust!.amount).toBeCloseTo(254.4536, 3);
    const base = trace.find((l) => l.label.startsWith('Recapture base'));
    expect(base!.amount).toBeCloseTo(2544.5362, 3);
  });

  it('stops the series (sepp-depleted) only when the SEPP IRA genuinely runs dry', () => {
    // Catastrophic fixed returns (-50% real on stocks, i.e. -48.75% nominal
    // after 2.5% inflation) against a payment fixed at the 2026 election:
    //   P = 300,000 x 0.05 / 0.78599784 = 19,084.0218 every year
    //   end 2026 = (300,000.0000 - 19,084.0218) x 0.5125 = 143,969.4388
    //   end 2027 = (143,969.4388 - 19,084.0218) x 0.5125 =  64,003.7762
    //   end 2028 = ( 64,003.7762 - 19,084.0218) x 0.5125 =  23,021.3741
    //   end 2029 = ( 23,021.3741 - 19,084.0218) x 0.5125 =   2,017.8931
    //   2030: only 2,017.89 available against a 19,084.02 payment -> the
    //   series pays out the last of the account and dies. Exhausting the
    //   assets is not a "modification" (Rev. Rul. 2002-62 §2.02(e)), so that
    //   final partial payment keeps the exception and 2031 pays nothing.
    const assume = assumptions();
    assume.market = {
      ...assume.market,
      deterministicReal: { stocks: -0.5, bonds: 0, bills: 0.005 },
      // Zero drag so the factor is exactly (1 - 0.5) x 1.025 = 0.5125.
      expenseRatios: { stocks: 0, bonds: 0, bills: 0 },
    };
    const profile = toyProfile({
      accounts: [
        toyAccount({
          id: 'ira',
          type: 'traditional_ira',
          owner: 'p1',
          balance: 300000,
          allocation: { stocks: 1, bonds: 0, bills: 0 },
        }),
      ],
      annualLiving: 0,
      horizonAge: 60, // 2026..2031
    });
    const rows = runSimulation(
      simInput(
        profile,
        { name: 'sepp-dry', events: [{ type: 'start_72t', date: '2026-06', account: 'ira' }] },
        { assumptions: assume },
      ),
    ).referencePath;

    expect(rows[3].withdrawals.byAccount['ira']).toBeCloseTo(19084.0218, 3);
    expect(rows[3].balances.byAccount['ira']).toBeCloseTo(2017.8931, 2);
    expect(rows[4].withdrawals.byAccount['ira']).toBeCloseTo(2017.8931, 2);
    expect(rows[4].taxes.penalties).toBe(0); // still excepted
    expect(rows[4].flags).toContain('sepp-depleted');
    expect(rows[4].balances.byAccount['ira']).toBe(0);
    expect(rows[5].withdrawals.byAccount['ira'] ?? 0).toBe(0);
    expect(rows[5].flags).toContain('sepp-depleted');
  });

  it('splits the IRA: only the carve-out is locked, the remainder stays withdrawable', () => {
    // The split-IRA technique, hand-computed. B = 1,000,000 at the 2026
    // election, r = 5%, N = 31.6 (single life at the user's attained age 55):
    //   maxPayment = 1,000,000 x 0.05 / (1 - 1.05^-31.6)
    //              = 1,000,000 x 0.05 / 0.78599784 = 63,613.4061
    // Asking for HALF of that carves off half the account:
    //   fraction  = 31,806.7030 / 63,613.4061 = 0.5
    //   principal = 500,000  -> its own formula maximum IS 31,806.7030
    //   remainder = 500,000  -> an ordinary traditional IRA, fully accessible
    // Spending is 90,000/yr against 10,000 of savings, so after the payment
    // the household must reach into the remainder — pre-59 1/2, so those
    // dollars carry the 10% penalty, while the SEPP payment carries none.
    const profile = toyProfile({
      accounts: [
        toyAccount({
          id: 'ira',
          name: 'Traditional IRA',
          type: 'traditional_ira',
          owner: 'p1',
          balance: 1000000,
          // 100% bills: both halves compound at exactly 1.030125 a year.
          allocation: { stocks: 0, bonds: 0, bills: 1 },
        }),
        toyAccount({
          id: 'savings',
          type: 'savings',
          owner: 'p1',
          balance: 10000,
          allocation: { stocks: 0, bonds: 0, bills: 1 },
        }),
      ],
      annualLiving: 90000,
      horizonAge: 58, // 2026..2029
    });
    const rows = runSimulation(
      simInput(profile, {
        name: 'sepp-split',
        events: [
          { type: 'start_72t', date: '2026-06', account: 'ira', annualAmount: 31806.703 },
        ],
      }),
    ).referencePath;

    const row = rows[0];
    // The carve-out pays exactly the requested amount — never a dollar more.
    expect(row.withdrawals.byAccount['ira-sepp']).toBeCloseTo(31806.703, 6);
    // 500,000 of it stayed behind as an ordinary IRA and the ordering used it.
    expect(row.withdrawals.byAccount['ira']).toBeGreaterThan(0);
    // Balances: SEPP end = (500,000 - 31,806.703) x 1.030125 = 482,297.6195;
    // the remainder is 500,000 less the ordinary draw, then compounded.
    expect(row.balances.byAccount['ira-sepp']).toBeCloseTo(482297.6195, 2);
    expect(row.balances.byAccount['ira']).toBeCloseTo(
      (500000 - row.withdrawals.byAccount['ira']) * 1.030125,
      2,
    );
    // The two halves still add up to the original account.
    expect(
      row.balances.byAccount['ira'] + row.balances.byAccount['ira-sepp'],
    ).toBeCloseTo((1000000 - 31806.703 - row.withdrawals.byAccount['ira']) * 1.030125, 2);

    // Penalties: withdrawals.penaltyBase counts ONLY the on-demand plan draws,
    // so it is exactly the remainder draw — the SEPP payment is excepted.
    expect(row.withdrawals.penaltyBase).toBeCloseTo(row.withdrawals.byAccount['ira'], 6);
    expect(row.taxes.penalties).toBeCloseTo(0.1 * row.withdrawals.byAccount['ira'], 6);
    expect(row.flags).toContain('sepp');
    expect(row.flags).toContain('penalty');
    // Reaching the remainder is exactly what keeps the household solvent.
    expect(row.flags).not.toContain('insolvent');

    // Every year of the lock behaves the same way.
    for (let yi = 0; yi < 4; yi++) {
      expect(rows[yi].withdrawals.byAccount['ira-sepp']).toBeCloseTo(31806.703, 6);
      expect(rows[yi].withdrawals.byAccount['ira']).toBeGreaterThan(0);
      expect(rows[yi].flags).not.toContain('insolvent');
    }

    // The trace names the split explicitly on the reference path.
    const trace = rows[0].taxes.trace!;
    const b = trace.find((l) => l.label.includes('B — account balance at election'));
    expect(b?.amount).toBeCloseTo(500000, 2); // the CARVE-OUT is what is amortized
    const splitLine = trace.find((l) => l.label.includes('Split-IRA technique'));
    expect(splitLine?.amount).toBeCloseTo(500000, 2); // remainder left outside
  });

  it('a crisis year busts the series with hand-computed recapture interest, then fails honestly', () => {
    /*
     * RENAMED FROM "insolvency never zeroes a funded account (the locked SEPP
     * survives it)" — the survival of a locked SEPP IRA through a shortfall
     * year was exactly the wall behaviour this spec retired (the 0.0%
     * incident, DECISIONS.md). A locked TITHE escrow still survives a failing
     * year — that pin lives in the note-21 suite — but a household's own SEPP
     * money is now spent, at the recapture price, before the path is allowed
     * to fail.
     *
     * Same fixture as before: 300,000 IRA under a full 72(t)
     * (P = 19,084.0218), 20,000 savings, 20,000/yr living, and a 400,000
     * one-time expense in 2027 that nothing can cover. 2026 pays normally;
     * 2027 pays, busts, drains the IRA into the crisis, and STILL fails.
     *
     * RECAPTURE ARITHMETIC (the property this test now pins): the 2026
     * payment is one elapsed year old, so it carries one year of interest at
     * the path's own T-bill return (1.030125 in this all-bills fixture);
     * the 2027 payment is current-year and carries none.
     *   base = 19,084.0218 x 1.030125 + 19,084.0218 = 38,742.9666
     *   recapture = 3,874.2967
     */
    const profile = toyProfile({
      accounts: [
        toyAccount({
          id: 'ira',
          type: 'traditional_ira',
          owner: 'p1',
          balance: 300000,
          allocation: { stocks: 0, bonds: 0, bills: 1 },
        }),
        toyAccount({
          id: 'savings',
          type: 'savings',
          owner: 'p1',
          balance: 20000,
          allocation: { stocks: 0, bonds: 0, bills: 1 },
        }),
      ],
      annualLiving: 20000,
      horizonAge: 60, // 2026..2031
    });
    const result = runSimulation(
      simInput(profile, {
        name: 'sepp-shortfall',
        events: [
          { type: 'start_72t', date: '2026-06', account: 'ira' },
          { type: 'one_time_expense', date: '2027-04', amount: 400000 },
        ],
      }),
    );
    const rows = result.referencePath;

    // 2026: a perfectly ordinary series year — no bust, no penalties.
    expect(rows[0].eventsFired).not.toContain('sepp-busted');
    expect(rows[0].taxes.penalties).toBe(0);
    expect(rows[0].balances.byAccount['ira']).toBeCloseTo(280915.9782 * 1.030125, 2);

    // 2027: the crisis year busts, and the recapture matches the
    // hand-computed base above to the cent.
    expect(rows[1].year).toBe(2027);
    expect(rows[1].eventsFired).toContain('sepp-busted');
    const trace = rows[1].taxes.trace!;
    const base = trace.find((l) => l.label.startsWith('Recapture base'));
    expect(base!.amount).toBeCloseTo(19084.0218 * 1.030125 + 19084.0218, 2);
    const bust = trace.find((l) => l.label.startsWith('72(t) series BUSTED'));
    expect(bust!.amount).toBeCloseTo(0.1 * (19084.0218 * 1.030125 + 19084.0218), 2);
    // The busting draw is an ordinary pre-59 1/2 IRA distribution: the year's
    // penalties are the recapture PLUS 10% of the drained remainder.
    //   start 2027 = (300,000 - 19,084.0218) x 1.030125 = 289,378.5720
    const ira2027 = (300000 - 19084.0218) * 1.030125;
    expect(rows[1].withdrawals.byAccount['ira']).toBeCloseTo(ira2027, 2);
    expect(rows[1].taxes.penalties).toBeCloseTo(
      0.1 * (19084.0218 * 1.030125 + 19084.0218) + 0.1 * (ira2027 - 19084.0218),
      2,
    );
    // Even the whole IRA cannot cover 400,000: the path fails honestly, with
    // the money SPENT into the crisis rather than walled off beside it.
    expect(rows[1].flags).toContain('insolvent');
    expect(rows[1].balances.byAccount['ira']).toBe(0);
    expect(result.success).toBe(0); // insolvencyYear still means failure

    // Permanent: the series never pays or locks again.
    for (let yi = 2; yi < rows.length; yi++) {
      expect(rows[yi].withdrawals.byAccount['ira'] ?? 0).toBe(0);
      expect(rows[yi].flags).not.toContain('sepp');
    }
  });

  it('reaches for the Roth rather than the locked IRA when cash runs short', () => {
    // Same lock, but with Roth contribution basis available: the ordering
    // (cash -> taxable -> pretax -> roth) skips the locked IRA and lands on
    // the Roth, which is always tax- and penalty-free basis first.
    const profile = toyProfile({
      accounts: [
        toyAccount({
          id: 'ira',
          type: 'traditional_ira',
          owner: 'p1',
          balance: 300000,
          allocation: { stocks: 0, bonds: 0, bills: 1 },
        }),
        toyAccount({
          id: 'roth',
          type: 'roth_ira',
          owner: 'p1',
          balance: 200000,
          allocation: { stocks: 0, bonds: 0, bills: 1 },
          rothBasis: { contributions: 200000, conversions: [] },
        }),
        toyAccount({
          id: 'savings',
          type: 'savings',
          owner: 'p1',
          balance: 20000,
          allocation: { stocks: 0, bonds: 0, bills: 1 },
        }),
      ],
      annualLiving: 60000,
      horizonAge: 58, // 2026..2029
    });
    const rows = runSimulation(
      simInput(profile, {
        name: 'sepp-roth',
        events: [{ type: 'start_72t', date: '2026-06', account: 'ira' }],
      }),
    ).referencePath;

    expect(rows[0].withdrawals.byAccount['ira']).toBeCloseTo(SEPP_PAYMENT, 3);
    expect(rows[0].withdrawals.roth).toBeGreaterThan(0);
    expect(rows[0].flags).not.toContain('insolvent');
    expect(rows[0].taxes.penalties).toBe(0);
    // Second year: still exactly one payment out of the IRA.
    expect(rows[1].withdrawals.byAccount['ira']).toBeCloseTo(SEPP_PAYMENT, 3);
    expect(rows[1].withdrawals.roth).toBeGreaterThan(0);
  });

  it('sizes the payment on the post-rollover balance when both fire the same year', () => {
    // p1 retires 2027-07: the 100,000 401(k) merges into the 50,000 IRA
    // FIRST, and only then is the 72(t) amortized — on the merged balance.
    // 2026 growth at the bills rate: 401(k) 100,000 x 1.030125 = 103,012.50,
    // IRA 50,000 x 1.030125 = 51,506.25; merged = 154,518.75.
    // N = 30.6 (single life expectancy at the user's attained age 56):
    //   1.05^30.6 = e^(30.6 x 0.0487901642) = e^1.4929790 = 4.4503355
    //   1/4.4503355                                       = 0.2247021
    //   1 - 0.2247021                                     = 0.7752979
    //   P = 154,518.75 x 0.05 / 0.7752979 = 7,725.9375 / 0.7752979
    //     = 9,965.12
    const profile = toyProfile({
      accounts: [
        toyAccount({
          id: 'k401',
          type: '401k',
          owner: 'p1',
          balance: 100000,
          allocation: { stocks: 0, bonds: 0, bills: 1 },
        }),
        toyAccount({
          id: 'ira',
          type: 'traditional_ira',
          owner: 'p1',
          balance: 50000,
          allocation: { stocks: 0, bonds: 0, bills: 1 },
        }),
        toyAccount({
          id: 'savings',
          type: 'savings',
          owner: 'p1',
          balance: 100000,
          allocation: { stocks: 0, bonds: 0, bills: 1 },
        }),
      ],
      income: { salaries: { p1: 60000, p2: 0 }, contribution401k: 0, employerMatch401k: 0 },
      annualLiving: 20000,
      horizonAge: 58, // 2026..2029
    });
    const rows = runSimulation(
      simInput(profile, {
        name: 'sepp-after-rollover',
        events: [
          { type: 'retire', person: 'p1', date: '2027-07' },
          { type: 'start_72t', date: '2027-08', account: 'ira' },
        ],
      }),
    ).referencePath;

    expect(rows[1].balances.byAccount['k401']).toBe(0); // rolled over first
    expect(rows[1].withdrawals.byAccount['ira']).toBeCloseTo(9965.12, 1);
    // Sizing on the merged balance is the whole point: amortizing the IRA
    // alone (51,506.25) would have paid barely a third of that.
    expect(rows[1].withdrawals.byAccount['ira']).toBeGreaterThan(3000 * 3);
    expect(rows[1].flags).toContain('sepp');
    expect(rows[1].eventsFired).toContain('rollover-401k');
  });
});

describe('automatic 72(t)/SEPP bridge (scenario.autoSepp; absent means ON)', () => {
  /**
   * One toy household, hand-computed end to end. Both spouses born 1971-06, so
   * the penalty-free year is 2031 (59 1/2 in Dec 2030, annual steps -> the
   * following year). p1 retires 2026-07, which is the bridge: 2026..2030.
   *
   * Accounts: a 300,000 traditional IRA and 50,000 of savings, both 100%
   * bills, so everything compounds at exactly 1.030125 a year. Living costs
   * 20,000/yr; no salary, no Social Security, no charitable giving, no
   * housing, and an ACA benchmark of 0 -> zero health premiums.
   *
   * TARGET ANNUAL NEED at the 2026 election (the payment the engine picks):
   *   living                                             = 20,000.00
   *   + housing 0 + charitable 0 + health 0
   *   - interest (savings 50,000 x 0.030125)              =  1,506.25
   *   - accessible balances / bridge years (50,000 / 5)   = 10,000.00
   *   - taxes                                             =      0.00
   *     (AGI = 8,493.75 SEPP + 1,506.25 interest = 10,000, under the 32,200
   *      federal standard deduction and under VA's 17,500 + 1,860 exemptions,
   *      so both passes of the gross-up loop land on the same number)
   *   = 8,493.75  <- the fixed annual payment
   *
   * SIZING vs the formula maximum: amortizing the WHOLE 300,000 at 5% over
   * N = 31.6 (single life at attained age 55) gives SEPP_PAYMENT = 19,084.0218
   * — more than twice what the household actually needs. The split-IRA
   * technique therefore carves out only:
   *   fraction  = 8,493.75 / 19,084.0218          = 0.44507128
   *   principal = 0.44507128 x 300,000            = 133,521.3837
   *   remainder = 300,000 - 133,521.3837          = 166,478.6163 (ordinary IRA)
   */
  const AUTO_PAYMENT = 8493.75;
  const AUTO_PRINCIPAL = 133521.3837;
  const AUTO_MAX = 19084.0218; // formula maximum on the whole 300,000

  const bridgeProfile = (): Profile =>
    toyProfile({
      accounts: [
        toyAccount({
          id: 'ira',
          name: 'Traditional IRA',
          type: 'traditional_ira',
          owner: 'p1',
          balance: 300000,
          allocation: { stocks: 0, bonds: 0, bills: 1 },
        }),
        toyAccount({
          id: 'savings',
          type: 'savings',
          owner: 'p1',
          balance: 50000,
          allocation: { stocks: 0, bonds: 0, bills: 1 },
        }),
      ],
      annualLiving: 20000,
      horizonAge: 61, // 2026..2032 — one year past the 2031 lock
    });

  const retireEarly: Scenario = {
    name: 'auto',
    events: [{ type: 'retire', person: 'p1', date: '2026-07' }],
  };

  it('waits for the year the cash runs out, then elects', () => {
    /*
     * REGRESSION, found on the user's real plan and invisible from the
     * outside: toggling the 72(t) on changed the success rate and the terminal
     * value by exactly nothing, to the dollar, while the household paid $52,607
     * of early-withdrawal penalties either way.
     *
     * The cause was that the election ran ONCE, in the retirement year, and a
     * household holding house-sale proceeds needs no series that year — so the
     * estimated need came out negative, the election was skipped for good, and
     * the toggle became a no-op while the plan later went back to the IRA at 57
     * and paid the penalty anyway.
     *
     * The fix is not to elect earlier; it is to keep offering. The series is
     * offered every bridge year and elects in the first one that actually needs
     * pre-tax money — which is the honest answer to "when should this start",
     * because a 72(t) is irrevocable and starting it early forces taxable
     * income in a year that did not want any.
     *
     * Here: sell in the retirement year, rent, buy for cash the year after.
     * The proceeds carry the household for a while, so the election waits —
     * but it must HAPPEN, and it must beat leaving the toggle off.
     */
    const profile = bridgeProfile();
    profile.home = {
      ...profile.home,
      value: 400_000,
      costBasis: 400_000, // no gain, so the sale is a pure cash shuffle
      mortgage: null,
      sellingCostPct: 0,
    };
    const move: Scenario = {
      name: 'auto-move',
      events: [
        { type: 'retire', person: 'p1', date: '2026-07' },
        { type: 'sell_house', date: '2026-08' },
        { type: 'rent', start: '2026-08', months: 12, monthlyCost: 1000 },
        {
          type: 'buy_house',
          date: '2027-08',
          price: 'sale_proceeds',
          financing: 'cash',
          propertyTaxAnnual: 4000,
          insuranceAnnual: 1200,
        },
      ],
    };
    const rows = runSimulation(simInput(profile, move)).referencePath;

    // It elects SOMEWHERE in the bridge — the year is the engine's call — but
    // not in the retirement year, when the proceeds are still in hand.
    const electionYears = rows.filter((r) => r.eventsFired.includes('auto-sepp')).map((r) => r.year);
    expect(electionYears).toHaveLength(1);
    expect(electionYears[0]).toBeGreaterThan(2026);
    expect(electionYears[0]).toBeLessThan(2031); // still inside the bridge
    // And the retirement year draws nothing from pre-tax: that is the point.
    expect(rows[0].withdrawals.pretax).toBe(0);

    // The series it elects is real: it pays out in the years after, which is
    // what makes the election worth anything at all.
    const seppYears = rows.filter((r) => r.flags.includes('sepp')).map((r) => r.year);
    expect(seppYears.length).toBeGreaterThan(1);
    expect(Math.min(...seppYears)).toBe(electionYears[0]);

    // Turning it OFF elects nothing — the toggle is not decorative.
    const off = runSimulation(simInput(profile, { ...move, autoSepp: false })).referencePath;
    expect(off.some((r) => r.eventsFired.includes('auto-sepp'))).toBe(false);
    expect(off.some((r) => r.flags.includes('sepp'))).toBe(false);

    /*
     * Deliberately NOT asserted here: that the series saves penalty money on
     * this toy. Once the proceeds carry the household through the early bridge,
     * this fixture barely touches pre-tax either way, so both numbers are noise
     * — and a threshold fitted to noise is a test that fails on an unrelated
     * change. The penalty claim belongs to a household that actually needs the
     * bridge, which the sibling case above covers.
     */
  });

  it('elects in the retirement year, sized to the bridge need rather than the formula maximum', () => {
    const rows = runSimulation(simInput(bridgeProfile(), retireEarly)).referencePath;

    // Fired, flagged, and visible to the UI.
    expect(rows[0].year).toBe(2026);
    expect(rows[0].eventsFired).toContain('auto-sepp');
    expect(rows[0].eventsFired).toContain('retire:p1');
    expect(rows[0].flags).toContain('sepp');

    // The payment is the hand-computed bridge need, NOT the formula maximum,
    // and it is materially below it: 8,493.75 is 44.5% of 19,084.02.
    expect(rows[0].withdrawals.byAccount['ira-sepp']).toBeCloseTo(AUTO_PAYMENT, 6);
    expect(rows[0].withdrawals.pretax).toBeCloseTo(AUTO_PAYMENT, 6);
    expect(AUTO_PAYMENT).toBeLessThan(0.5 * AUTO_MAX);

    // The carve-out is proportionally smaller for exactly the same reason:
    // 44.5% of the IRA is locked, 55.5% stays an ordinary accessible IRA.
    //   sepp end 2026 = (133,521.3838 - 8,493.75) x 1.030125 = 128,794.0912
    //   ira  end 2026 =  166,478.6162            x 1.030125 = 171,493.7846
    expect(rows[0].balances.byAccount['ira-sepp']).toBeCloseTo(
      (AUTO_PRINCIPAL - AUTO_PAYMENT) * 1.030125,
      2,
    );
    expect(rows[0].balances.byAccount['ira']).toBeCloseTo((300000 - AUTO_PRINCIPAL) * 1.030125, 2);
    expect(rows[0].balances.byAccount['ira-sepp']).toBeCloseTo(128794.0912, 2);
    expect(rows[0].balances.byAccount['ira']).toBeCloseTo(171493.7846, 2);

    // The remainder really is accessible: nothing forced it open in 2026, and
    // the cash need came out of savings (20,000 living - 10,000 of income).
    expect(rows[0].withdrawals.byAccount['ira'] ?? 0).toBe(0);
    expect(rows[0].withdrawals.cash).toBeCloseTo(10000, 6);
    expect(rows[0].balances.byAccount['savings']).toBeCloseTo(40000, 6);
    expect(rows[0].taxes.totalTax).toBe(0);

    // Lock window: five payments (2026..2030) OR the penalty-free year,
    // whichever is later -> 2031. Every one of those years pays exactly the
    // same nominal amount; 2032 pays nothing and the flag is gone.
    for (let yi = 0; yi <= 5; yi++) {
      expect(rows[yi].year).toBe(2026 + yi);
      expect(rows[yi].withdrawals.byAccount['ira-sepp']).toBeCloseTo(AUTO_PAYMENT, 6);
      expect(rows[yi].flags).toContain('sepp');
      // Only the election year announces itself.
      expect(rows[yi].eventsFired.includes('auto-sepp')).toBe(yi === 0);
    }
    expect(rows[6].year).toBe(2032);
    expect(rows[6].withdrawals.byAccount['ira-sepp'] ?? 0).toBe(0);
    expect(rows[6].flags).not.toContain('sepp');

    // The trace carries the same amortization block a hand-written election
    // gets — on the CARVE-OUT, which is what was amortized — plus the split.
    const trace = rows[0].taxes.trace!;
    const start = trace.findIndex((l) => l.label.includes('72(t) SEPP distribution'));
    expect(start).toBeGreaterThanOrEqual(0);
    const block = trace.slice(start, start + 7);
    const amountOf = (frag: string) => block.find((l) => l.label.includes(frag))?.amount;
    expect(block[0].amount).toBeCloseTo(AUTO_PAYMENT, 6);
    expect(block[0].note).toContain('automatic bridge election');
    expect(amountOf('B — account balance at election')).toBeCloseTo(AUTO_PRINCIPAL, 2);
    expect(amountOf('r — amortization interest rate')).toBe(0.05);
    expect(amountOf('N — single life expectancy at age 55')).toBe(31.6);
    expect(amountOf('Annual payment')).toBeCloseTo(AUTO_PAYMENT, 6);
    expect(amountOf('Split-IRA technique')).toBeCloseTo(300000 - AUTO_PRINCIPAL, 2);
  });

  it('does not elect when the retirement year is at or after the penalty-free year', () => {
    // Retiring in 2031 — the first penalty-free year — leaves no bridge to
    // cross, so nothing is elected and the IRA is never split.
    const rows = runSimulation(
      simInput(bridgeProfile(), {
        name: 'auto-late',
        events: [{ type: 'retire', person: 'p1', date: '2031-07' }],
      }),
    ).referencePath;
    for (const row of rows) {
      expect(row.eventsFired).not.toContain('auto-sepp');
      expect(row.flags).not.toContain('sepp');
      expect(row.balances.byAccount['ira-sepp']).toBeUndefined();
    }
  });

  it('an explicit start_72t wins: the person gets one election, not two', () => {
    const rows = runSimulation(
      simInput(bridgeProfile(), {
        name: 'manual-wins',
        events: [
          { type: 'retire', person: 'p1', date: '2026-07' },
          { type: 'start_72t', date: '2026-07', account: 'ira' },
        ],
      }),
    ).referencePath;

    // The hand-written election has no annualAmount, so it takes the whole
    // formula maximum and does not split the account at all — which is
    // precisely what the automatic sizing would NOT have done.
    expect(rows[0].eventsFired).toContain('start_72t');
    expect(rows[0].eventsFired).not.toContain('auto-sepp');
    expect(rows[0].withdrawals.byAccount['ira']).toBeCloseTo(AUTO_MAX, 3);
    expect(rows[0].balances.byAccount['ira-sepp']).toBeUndefined();
    // One series, one payment: the pre-tax total is the manual payment alone.
    expect(rows[0].withdrawals.pretax).toBeCloseTo(AUTO_MAX, 3);
  });

  it('collapses the bridge penalties against autoSepp: false', () => {
    const auto = runSimulation(simInput(bridgeProfile(), retireEarly)).referencePath;
    const off = runSimulation(
      simInput(bridgeProfile(), { ...retireEarly, name: 'auto-off', autoSepp: false }),
    ).referencePath;

    // Bridge years 2026..2030 (rows 0..4).
    const sum = (rows: typeof auto) =>
      rows.slice(0, 5).reduce((s, r) => s + r.taxes.penalties, 0);
    // Un-bridged, the same spending has to come out of the IRA at a 10%
    // penalty as soon as savings runs out (2028 onwards):
    //   2028 966.32 + 2029 2,401.60 + 2030 2,536.11 = 5,904.04
    expect(sum(off)).toBeCloseTo(5904.0389, 2);
    expect(off.slice(2, 5).every((r) => r.flags.includes('penalty'))).toBe(true);
    // Bridged, the SEPP covers the gap: the only penalty left is the 2030
    // top-up after savings finally empties, 975.91 — a sixth of the above.
    expect(sum(auto)).toBeCloseTo(975.9066, 2);
    expect(sum(auto)).toBeLessThan(0.2 * sum(off));
    expect(auto.slice(0, 4).every((r) => r.taxes.penalties === 0)).toBe(true);
  });

  it('picks the largest traditional IRA — the one the 401(k) just rolled into', () => {
    // p1 owns a 400,000 401(k), a 20,000 IRA (first in profile order, so the
    // rollover destination) and a 200,000 IRA. At the 2026-07 retirement the
    // 401(k) merges into IRA A FIRST, making it 420,000 — the largest — so
    // that is the account the automatic election lands on.
    //
    // Wages are excluded from the sizing by construction (the bridge years
    // are retired years), so the 100,000 salary does not enlarge the payment:
    //   living 20,000 - interest (40,000 x 0.030125 = 1,205)
    //     - savings 40,000 / 5 bridge years = 8,000        -> 10,795.00
    //   (AGI = 10,795 + 1,205 = 12,000: no federal or VA tax, as above)
    //   maximum on 420,000 = 1.4 x 19,084.02182091 = 26,717.63054928
    //     (the unrounded whole-account maximum; AUTO_MAX above is the same
    //      number quoted to four decimals)
    //   fraction  = 10,795 / 26,717.63054928        = 0.40404032012
    //   principal = 0.40404032012 x 420,000         = 169,696.93445
    const profile = toyProfile({
      accounts: [
        toyAccount({
          id: 'k401',
          name: '401(k)',
          type: '401k',
          owner: 'p1',
          balance: 400000,
          allocation: { stocks: 0, bonds: 0, bills: 1 },
        }),
        toyAccount({
          id: 'ira-a',
          name: 'IRA A',
          type: 'traditional_ira',
          owner: 'p1',
          balance: 20000,
          allocation: { stocks: 0, bonds: 0, bills: 1 },
        }),
        toyAccount({
          id: 'ira-b',
          name: 'IRA B',
          type: 'traditional_ira',
          owner: 'p1',
          balance: 200000,
          allocation: { stocks: 0, bonds: 0, bills: 1 },
        }),
        toyAccount({
          id: 'savings',
          type: 'savings',
          owner: 'p1',
          balance: 40000,
          allocation: { stocks: 0, bonds: 0, bills: 1 },
        }),
      ],
      income: { salaries: { p1: 100000, p2: 0 }, contribution401k: 0, employerMatch401k: 0 },
      annualLiving: 20000,
      horizonAge: 58, // 2026..2029
    });
    const rows = runSimulation(
      simInput(profile, {
        name: 'auto-rollover',
        events: [{ type: 'retire', person: 'p1', date: '2026-07' }],
      }),
    ).referencePath;

    expect(rows[0].eventsFired).toContain('rollover-401k');
    expect(rows[0].eventsFired).toContain('auto-sepp');
    expect(rows[0].balances.byAccount['k401']).toBe(0);
    // The series is on IRA A's carve-out; IRA B was never touched.
    expect(rows[0].withdrawals.byAccount['ira-a-sepp']).toBeCloseTo(10795, 6);
    expect(rows[0].balances.byAccount['ira-b-sepp']).toBeUndefined();
    expect(rows[0].balances.byAccount['ira-b']).toBeCloseTo(200000 * 1.030125, 6);
    //   sepp  end = (169,696.93445 - 10,795)   x 1.030125 = 163,688.85523
    //   ira-a end = (420,000 - 169,696.93445)  x 1.030125 = 257,843.44540
    expect(rows[0].balances.byAccount['ira-a-sepp']).toBeCloseTo(163688.85523, 3);
    expect(rows[0].balances.byAccount['ira-a']).toBeCloseTo(257843.4454, 3);
    // Sizing off the merged balance is the point: amortizing IRA A alone
    // (20,000) could never have produced a 10,795 payment.
    expect(10795).toBeGreaterThan((20000 / 300000) * AUTO_MAX);
  });

  it('two spouses retiring together size their series against each other, not twice over', () => {
    // Both retire 2026-07 and each owns a 300,000 IRA; 50,000 of savings and
    // 40,000/yr of living. The household gap is ONE gap:
    //   40,000 - interest 1,506.25 - savings 50,000 / 5 = 28,493.75 (+ tax)
    //
    // Each spouse's series is capped at MAX_AUTO_SEPP_FRACTION (0.75) of their
    // own whole-account maximum, so neither locks a whole IRA:
    //   0.75 x 19,084.0218 = 14,313.0164 each.
    // The point of the test survives the cap: p2 sizes against what is LEFT
    // after p1's payment, so the two together are ONE household gap plus its
    // tax (28,626.03), not two gaps (56,987.50). Savings covers the rest.
    // Split arithmetic, exactly: the carve-out takes 75% of the 300,000
    // (225,000), pays 14,313.0164, and grows at the deterministic bill rate
    // (1.005 x 1.025 = 1.030125) -> 217,033.93. The 25% remainder is untouched:
    //   75,000 x 1.030125 = 77,259.375.
    const profile = toyProfile({
      accounts: [
        toyAccount({
          id: 'ira1',
          name: 'IRA1',
          type: 'traditional_ira',
          owner: 'p1',
          balance: 300000,
          allocation: { stocks: 0, bonds: 0, bills: 1 },
        }),
        toyAccount({
          id: 'ira2',
          name: 'IRA2',
          type: 'traditional_ira',
          owner: 'p2',
          balance: 300000,
          allocation: { stocks: 0, bonds: 0, bills: 1 },
        }),
        toyAccount({
          id: 'savings',
          type: 'savings',
          owner: 'p1',
          balance: 50000,
          allocation: { stocks: 0, bonds: 0, bills: 1 },
        }),
      ],
      annualLiving: 40000,
      horizonAge: 57, // 2026..2028
    });
    const row = runSimulation(
      simInput(profile, {
        name: 'auto-both',
        events: [
          { type: 'retire', person: 'p1', date: '2026-07' },
          { type: 'retire', person: 'p2', date: '2026-07' },
        ],
      }),
    ).referencePath[0];

    const capped = AUTO_MAX * 0.75; // 14,313.0164
    expect(row.withdrawals.byAccount['ira1-sepp']).toBeCloseTo(capped, 3);
    expect(row.withdrawals.byAccount['ira2-sepp']).toBeCloseTo(capped, 3);
    // Neither IRA is fully committed: a quarter of each stays reachable.
    expect(row.balances.byAccount['ira1']).toBeCloseTo(77259.375, 3);
    expect(row.balances.byAccount['ira2']).toBeCloseTo(77259.375, 3);
    expect(row.balances.byAccount['ira1-sepp']).toBeCloseTo(217033.929, 2);
    // Neither remainder is touched this year — the series covers the recurring gap.
    expect(row.withdrawals.byAccount['ira1'] ?? 0).toBe(0);
    expect(row.withdrawals.byAccount['ira2'] ?? 0).toBe(0);
    // THE POINT: one household gap between them, not two.
    const both =
      row.withdrawals.byAccount['ira1-sepp'] + row.withdrawals.byAccount['ira2-sepp'];
    expect(both).toBeCloseTo(2 * capped, 3);
    expect(both).toBeLessThan(28493.75 + row.taxes.totalTax); // under one gap+tax
    expect(both).toBeLessThan(2 * 28493.75); // and nowhere near two
    // Savings covers the residual the capped series leaves — close to the
    // 10,000/yr the sizing budgeted for it (10,276.33 with the extra tax).
    expect(row.withdrawals.cash).toBeCloseTo(10276.33, 1);
    // Two elections, one chip.
    expect(row.eventsFired.filter((e) => e === 'auto-sepp')).toHaveLength(1);
  });

  it('autoSepp: false reproduces the pre-change engine bit for bit', () => {
    // PINNED BASELINE. Every number below was captured by running this exact
    // fixture against the engine as it stood BEFORE the automatic bridge and
    // the surplus-reinvestment change (48376d0, the last commit to touch the
    // engine before them), and compared digit for digit. Any future change
    // that moves these numbers changes the un-bridged engine, which is exactly
    // what this test exists to catch.
    // The household deliberately holds NO taxable brokerage, so the
    // surplus sweep still falls back to savings exactly as it used to — this
    // asserts that turning the toggle off leaves the old engine untouched.
    const profile = toyProfile({
      accounts: [
        toyAccount({
          id: 'ira',
          name: 'Traditional IRA',
          type: 'traditional_ira',
          owner: 'p1',
          balance: 300000,
          allocation: { stocks: 0, bonds: 0, bills: 1 },
        }),
        toyAccount({
          id: 'roth',
          type: 'roth_ira',
          owner: 'p1',
          balance: 100000,
          allocation: { stocks: 0, bonds: 0, bills: 1 },
          rothBasis: { contributions: 60000, conversions: [] },
        }),
        toyAccount({
          id: 'savings',
          type: 'savings',
          owner: 'p1',
          balance: 50000,
          allocation: { stocks: 0, bonds: 0, bills: 1 },
        }),
      ],
      annualLiving: 40000,
      horizonAge: 61, // 2026..2032
    });
    const result = runSimulation(
      simInput(profile, {
        name: 'pin',
        autoSepp: false,
        events: [{ type: 'retire', person: 'p1', date: '2026-07' }],
      }),
    );
    const rows = result.referencePath;

    expect(rows.map((r) => r.balances.total)).toEqual([
      423556.2499999999, 390461.2925753003, 350602.64598984434, 308202.99069748505,
      262147.1392927046, 220031.3536495554, 175374.8199714382,
    ]);
    expect(rows.map((r) => r.withdrawals.pretax)).toEqual([
      0, 33007.36675131609, 50111.6787033485, 51412.75088246888, 53722.08858103835,
      48550.38778239712, 49785.1990843927,
    ]);
    expect(rows.map((r) => r.withdrawals.cash)).toEqual([
      38493.750000000015, 11506.249999999985, 0, 0, 0, 0, 0,
    ]);
    expect(rows.map((r) => r.taxes.penalties)).toEqual([
      0, 3300.7366751316094, 5011.167870334851, 5141.275088246888, 5372.208858103835, 0, 0,
    ]);
    expect(rows.map((r) => r.taxes.totalTax)).toEqual([
      0, 3860.3355550165224, 8086.79476611224, 8337.245539735737, 9569.710301804877,
      3294.101630219735, 3397.5060491463437,
    ]);
    expect(result.medianTerminalReal).toBe(151225.15762975888);
    // ...and nothing was elected or split.
    for (const row of rows) {
      expect(row.eventsFired).not.toContain('auto-sepp');
      expect(row.balances.byAccount['ira-sepp']).toBeUndefined();
    }
  });
});

describe('surplus is reinvested in the brokerage, not parked in cash', () => {
  it('raises balance AND basis, so a later sale realizes gains on the raised basis', () => {
    /**
     * savings 50,000 and a brokerage of 100,000 with ZERO basis, both 100%
     * bills (interest is distributed, price flat), living 20,000/yr, no
     * salary. A tax-free 100,000 windfall in 2026 creates a large surplus;
     * a 120,000 one-time expense in 2028 forces the brokerage to be sold.
     *
     * 2026: interest = (50,000 + 100,000) x 0.030125          =   4,518.75
     *       income   = 4,518.75 + 100,000 (non-taxable)       = 104,518.75
     *       tax      = 0 (AGI is the 4,518.75 of interest)
     *       surplus  = 104,518.75 - 20,000                    =  84,518.75
     *   -> brokerage 100,000 + 84,518.75 = 184,518.75, basis 0 + 84,518.75,
     *      and savings is untouched at 50,000.
     * 2028 sale: gain fraction = 1 - 84,518.75 / 184,518.75
     *                          = 100,000 / 184,518.75         = 0.54195034
     *   -> the original 100,000 of unrealized gain, and not a dollar more.
     */
    const profile = toyProfile({
      accounts: [
        toyAccount({
          id: 'savings',
          type: 'savings',
          owner: 'p1',
          balance: 50000,
          allocation: { stocks: 0, bonds: 0, bills: 1 },
        }),
        toyAccount({
          id: 'brokerage',
          type: 'taxable_brokerage',
          owner: 'p1',
          balance: 100000,
          costBasis: 0,
          allocation: { stocks: 0, bonds: 0, bills: 1 },
        }),
      ],
      annualLiving: 20000,
      horizonAge: 59, // 2026..2030
    });
    const rows = runSimulation(
      simInput(profile, {
        name: 'sweep',
        events: [
          { type: 'one_time_income', date: '2026-06', amount: 100000, taxable: false },
          { type: 'one_time_expense', date: '2028-06', amount: 120000 },
        ],
      }),
    ).referencePath;

    // 2026: the surplus went into the brokerage, and savings did not move.
    expect(rows[0].taxes.totalTax).toBe(0);
    expect(rows[0].balances.byAccount['brokerage']).toBeCloseTo(184518.75, 4);
    expect(rows[0].balances.byAccount['savings']).toBeCloseTo(50000, 6);
    expect(rows[0].withdrawals.cash).toBe(0);

    // 2027: no surplus (living exceeds the interest), so cash is drawn and the
    // brokerage sits still — the sweep is one-directional.
    expect(rows[1].balances.byAccount['brokerage']).toBeCloseTo(184518.75, 4);
    expect(rows[1].withdrawals.cash).toBeGreaterThan(0);

    // 2028: savings empties and the brokerage is sold. The realized gain uses
    // the RAISED basis — 54.195% of each dollar sold, not 100% of it.
    const sold = rows[2].withdrawals.taxable;
    expect(sold).toBeGreaterThan(0);
    expect(rows[2].withdrawals.realizedLtcg).toBeCloseTo(sold * (100000 / 184518.75), 4);
    expect(rows[2].withdrawals.realizedLtcg).toBeLessThan(0.6 * sold);
    // Had the surplus been parked in savings the basis would still be 0 and
    // every dollar sold would have been gain.
    expect(rows[2].withdrawals.realizedLtcg).toBeLessThan(sold);
  });

  it('falls back to savings when the household holds no brokerage at all', () => {
    // Same windfall, but the only accounts are savings and an IRA: the sweep
    // has nowhere else to go, so it behaves exactly as it always did.
    const profile = toyProfile({
      accounts: [
        toyAccount({
          id: 'savings',
          type: 'savings',
          owner: 'p1',
          balance: 50000,
          allocation: { stocks: 0, bonds: 0, bills: 1 },
        }),
        toyAccount({
          id: 'ira',
          type: 'traditional_ira',
          owner: 'p1',
          balance: 100000,
          allocation: { stocks: 0, bonds: 0, bills: 1 },
        }),
      ],
      annualLiving: 20000,
      horizonAge: 57, // 2026..2028
    });
    const rows = runSimulation(
      simInput(profile, {
        name: 'sweep-no-brokerage',
        events: [{ type: 'one_time_income', date: '2026-06', amount: 100000, taxable: false }],
      }),
    ).referencePath;
    // interest = (50,000 + 100,000 IRA is not cash) -> savings 50,000 x 0.030125
    //          = 1,506.25; surplus = 1,506.25 + 100,000 - 20,000 = 81,506.25
    //   savings end = 50,000 + 81,506.25 = 131,506.25
    expect(rows[0].taxes.totalTax).toBe(0);
    expect(rows[0].balances.byAccount['savings']).toBeCloseTo(131506.25, 4);
    expect(rows[0].withdrawals.cash).toBe(0);
  });
});

describe('leftover cash while working is consumed, not accumulated (note 20)', () => {
  /**
   * The user's correction. `livingMonthly` is a BUDGET BASELINE: it does not
   * carry the irregular, lumpy costs a real year brings — a new air
   * conditioner, a car repair, a trip, home maintenance beyond the modeled
   * percentage — and those are exactly where the leftover of a paycheck goes.
   * So in any year someone earns a salary, the engine may assume NO
   * accumulation beyond the amount the household says it invests. The leftover
   * is consumed and recorded as YearRow.unbudgeted, which keeps the cash
   * identity exact instead of letting the money vanish.
   *
   * Retired years are a different thing entirely and keep the old behavior:
   * the withdrawal solve takes only what the year needs, so a surplus there
   * can only be a FORCED distribution (an RMD or a 72(t) payment) the year did
   * not need — real money, genuinely reinvested.
   *
   * Shared fixture (all 100% bills, so sleeve returns are DISTRIBUTED as
   * interest and prices stay flat: an account balance moves only when cash
   * actually moves): savings 50,000, brokerage 100,000 at full basis, salary
   * 100,000, living 30,000/yr.
   */
  const workingProfile = (investingMonthly: number): Profile =>
    toyProfile({
      accounts: [
        toyAccount({
          id: 'savings',
          type: 'savings',
          owner: 'p1',
          balance: 50000,
          allocation: { stocks: 0, bonds: 0, bills: 1 },
        }),
        toyAccount({
          id: 'brokerage',
          type: 'taxable_brokerage',
          owner: 'p1',
          balance: 100000,
          costBasis: 100000,
          allocation: { stocks: 0, bonds: 0, bills: 1 },
        }),
      ],
      income: { salaries: { p1: 100000, p2: 0 }, contribution401k: 0, employerMatch401k: 0 },
      annualLiving: 30000,
      investingMonthly,
      horizonAge: 55, // 2026 only
    });

  /*
   * 2026, hand-computed (identical in both tests below — the investing
   * transfer is a transfer, so it changes no tax):
   *   income   = wages 100,000 + interest (50,000 + 100,000) x 0.030125
   *            = 100,000 + 4,518.75                    = 104,518.75
   *   federal  = (104,518.75 - 32,200 std) = 72,318.75 taxable
   *            = 0.10 x 24,800 + 0.12 x (72,318.75 - 24,800)
   *            = 2,480 + 5,702.25                      =   8,182.25
   *   VA       = (104,518.75 - 17,500 std - 1,860 exemptions) = 85,158.75
   *            = 60 + 60 + 600 + 0.0575 x (85,158.75 - 17,000)
   *            = 720 + 3,919.128125                    =   4,639.128125
   *   tax      = 8,182.25 + 4,639.128125               =  12,821.378125
   *   leftover = 104,518.75 - 30,000 - 12,821.378125   =  61,697.371875
   */
  const TAX_2026 = 12821.378125;
  const LEFTOVER_2026 = 61697.371875;

  it('banks EXACTLY the explicit investing stream and consumes the rest', () => {
    const row = runSimulation(
      simInput(workingProfile(1000), { name: 'note20-working', events: [] }),
    ).referencePath[0];

    expect(row.taxes.totalTax).toBeCloseTo(TAX_2026, 6);
    // 1,000/mo x 12 worked months x CPI 1.0 = 12,000 — what the user SAYS he
    // invests, and the only thing that lands anywhere.
    expect(row.investing).toBeCloseTo(12000, 6);
    // The brokerage rises by the transfer and NOT ONE PENNY MORE.
    expect(row.balances.byAccount['brokerage']).toBeCloseTo(112000, 6);
    // Savings is untouched: nothing is parked there either, and nothing was
    // drawn (this year is nowhere near needing a withdrawal).
    expect(row.balances.byAccount['savings']).toBeCloseTo(50000, 6);
    expect(row.withdrawals.cash).toBe(0);
    expect(row.withdrawals.taxable).toBe(0);
    // The consumed figure is the arithmetic leftover, to the cent:
    //   61,697.371875 - 12,000 = 49,697.371875
    expect(row.unbudgeted).toBeCloseTo(LEFTOVER_2026 - 12000, 6);
    expect(row.unbudgeted).toBeCloseTo(49697.371875, 6);
    // ...and it is recoverable from the row's own recorded numbers, which is
    // what makes the cashflow table's "Unbudgeted / not invested" line honest.
    const income =
      row.income.wages +
      row.income.socialSecurity +
      row.income.taxableInterest +
      row.income.dividends +
      row.income.other +
      row.income.retirement;
    expect(row.unbudgeted).toBeCloseTo(
      income - row.expenses.total - row.taxes.totalTax - row.investing,
      6,
    );
    // It is NOT an expense: expenses.total stays the five component fields.
    expect(row.expenses.total).toBeCloseTo(
      row.expenses.baseline +
        row.expenses.charitable +
        row.expenses.housing +
        row.expenses.health +
        row.expenses.oneTime,
      8,
    );
  });

  it('moves the brokerage NOT AT ALL when investingMonthly is 0', () => {
    const row = runSimulation(
      simInput(workingProfile(0), { name: 'note20-no-investing', events: [] }),
    ).referencePath[0];

    expect(row.taxes.totalTax).toBeCloseTo(TAX_2026, 6); // same tax, same year
    expect(row.investing).toBe(0);
    // Every account is exactly where it started. A household that says it
    // invests nothing invests nothing.
    expect(row.balances.byAccount['brokerage']).toBeCloseTo(100000, 6);
    expect(row.balances.byAccount['savings']).toBeCloseTo(50000, 6);
    // The WHOLE leftover is consumed — 12,000 more than the run above.
    expect(row.unbudgeted).toBeCloseTo(LEFTOVER_2026, 6);
  });

  it('follows the WORKING rule for the whole retirement year — no sweep', () => {
    /*
     * THE DECISION, PINNED. 0 < worked months < 12 is the retirement year, and
     * it takes the working rule whole rather than being prorated. Living,
     * giving, investing and retirement income are all per-month flows, so
     * splitting them 6/12 means something; a surplus is not a per-month flow,
     * it is one undifferentiated pool of year-end cash. Prorating it would
     * assign salary dollars to the retired rule in whatever ratio the calendar
     * produced — arithmetic without a meaning — so the conservative reading
     * wins: in any year a paycheck arrives, leftover cash is consumed.
     *
     * Salary 200,000, p1 retires 2027-07 (6 worked months), no pre-tax
     * account at all so no automatic 72(t) can elect and muddy the year.
     *   2027 income   = wages 100,000 + interest (50,000 + 112,000) x 0.030125
     *                 = 100,000 + 4,880.25             = 104,880.25
     *        living   = 30,000 x 1.025                 =  30,750
     *        investing = 1,000 x 6 months x 1.025      =   6,150
     *        leftover = 104,880.25 - 30,750 - tax - 6,150
     */
    const profile = toyProfile({
      accounts: [
        toyAccount({
          id: 'savings',
          type: 'savings',
          owner: 'p1',
          balance: 50000,
          allocation: { stocks: 0, bonds: 0, bills: 1 },
        }),
        toyAccount({
          id: 'brokerage',
          type: 'taxable_brokerage',
          owner: 'p1',
          balance: 100000,
          costBasis: 100000,
          allocation: { stocks: 0, bonds: 0, bills: 1 },
        }),
      ],
      income: { salaries: { p1: 200000, p2: 0 }, contribution401k: 0, employerMatch401k: 0 },
      annualLiving: 30000,
      investingMonthly: 1000,
      horizonAge: 57, // 2026..2028
    });
    const rows = runSimulation(
      simInput(profile, {
        name: 'note20-retirement-year',
        events: [{ type: 'retire', person: 'p1', date: '2027-07' }],
      }),
    ).referencePath;

    // 2026, a full working year: brokerage takes the 12,000 stream only.
    expect(rows[0].investing).toBeCloseTo(12000, 6);
    expect(rows[0].balances.byAccount['brokerage']).toBeCloseTo(112000, 6);
    expect(rows[0].unbudgeted).toBeCloseTo(124795.496875, 6);

    // 2027, THE RETIREMENT YEAR. The investing stream IS prorated (6 worked
    // months, the paired-stream rule)...
    expect(rows[1].income.wages).toBeCloseTo(100000, 6);
    expect(rows[1].investing).toBeCloseTo(6150, 6);
    // ...but the surplus is NOT: the brokerage moves by the prorated stream
    // and nothing else, and the whole remaining leftover is consumed.
    expect(rows[1].balances.byAccount['brokerage']).toBeCloseTo(118150, 6);
    expect(rows[1].balances.byAccount['savings']).toBeCloseTo(50000, 6);
    expect(rows[1].income.taxableInterest).toBeCloseTo(4880.25, 6);
    expect(rows[1].unbudgeted).toBeCloseTo(
      104880.25 - 30750 - rows[1].taxes.totalTax - 6150,
      6,
    );
    expect(rows[1].unbudgeted).toBeCloseTo(55255.455625, 6);
    // The rejected alternative, made concrete: prorating by the 6 retired
    // months would have swept half of that 55,255.455625 — 27,627.73 — into
    // the brokerage, landing it at 145,777.73. It did not.
    expect(rows[1].balances.byAccount['brokerage']).toBeLessThan(
      118150 + 55255.455625 / 2 - 1,
    );

    // 2028, fully retired and drawing down: nothing to consume, nothing to
    // sweep, and savings pays the bills.
    expect(rows[2].income.wages).toBe(0);
    expect(rows[2].unbudgeted).toBe(0);
    expect(rows[2].investing).toBe(0);
    expect(rows[2].balances.byAccount['brokerage']).toBeCloseTo(118150, 6);
    expect(rows[2].withdrawals.cash).toBeGreaterThan(0);
  });

  it('still runs the withdrawal machinery when a working year falls short', () => {
    // A 200,000 one-time expense against a 100,000 salary: income cannot cover
    // taxes + expenses, so the year behaves exactly as it always did — the
    // ordering draws cash first, then the taxable brokerage. Nothing about
    // note 20 touches the shortfall path.
    const row = runSimulation(
      simInput(workingProfile(1000), {
        name: 'note20-shortfall',
        events: [{ type: 'one_time_expense', date: '2026-06', amount: 200000 }],
      }),
    ).referencePath[0];

    expect(row.withdrawals.cash).toBeGreaterThan(0);
    expect(row.withdrawals.cash + row.withdrawals.taxable).toBeGreaterThan(100000);
    // No surplus means no transfer and nothing consumed — and the investing
    // stream never borrows to fund itself.
    expect(row.investing).toBe(0);
    expect(row.unbudgeted).toBe(0);
    // The consumed figure can never go negative: a shortfall is a withdrawal,
    // not "negative unbudgeted spending".
    expect(row.unbudgeted).toBeGreaterThanOrEqual(0);
  });

  it('a retired year still reinvests a forced 72(t) it did not need, basis and all', () => {
    /*
     * The other half of the rule, unchanged. Both retire 2026-01, so every
     * year here is fully retired. A hand-written 72(t) forces 38,168.04 a year
     * out of a 600,000 IRA against 30,000 of living, so each year runs a real
     * surplus — money the household did not ask for and cannot refuse. It is
     * REINVESTED, and the basis rises with it, which is what stops a later
     * sale realizing phantom gain.
     *
     * The brokerage starts at 100,000 with ZERO basis, and everything is 100%
     * bills, so its balance moves only by the swept surplus:
     *   2026 end = 109,792.9143   2027 end = 119,216.6258
     *   2028 end = 128,204.7765
     * The unrealized gain is therefore STILL exactly the original 100,000,
     * and an 80,000 one-time expense in 2029 forces a partial sale whose
     * realized gain is exactly that fraction of it:
     *   100,000 / 128,204.7765 = 0.78000315...
     * Had the swept surplus not raised basis, every dollar sold would have
     * been gain (fraction 1.0).
     */
    const profile = toyProfile({
      accounts: [
        toyAccount({
          id: 'savings',
          type: 'savings',
          owner: 'p1',
          balance: 20000,
          allocation: { stocks: 0, bonds: 0, bills: 1 },
        }),
        toyAccount({
          id: 'brokerage',
          type: 'taxable_brokerage',
          owner: 'p1',
          balance: 100000,
          costBasis: 0,
          allocation: { stocks: 0, bonds: 0, bills: 1 },
        }),
        toyAccount({
          id: 'ira',
          type: 'traditional_ira',
          owner: 'p1',
          balance: 600000,
          allocation: { stocks: 0, bonds: 0, bills: 1 },
        }),
      ],
      annualLiving: 30000,
      horizonAge: 59, // 2026..2030
    });
    const rows = runSimulation(
      simInput(profile, {
        name: 'note20-retired-sweep',
        events: [
          { type: 'retire', person: 'p1', date: '2026-01' },
          { type: 'retire', person: 'p2', date: '2026-01' },
          { type: 'start_72t', date: '2026-01', account: 'ira', annualAmount: 60000 },
          { type: 'one_time_expense', date: '2029-06', amount: 80000 },
        ],
      }),
    ).referencePath;

    // Nobody earns in any year, so nothing is ever consumed...
    expect(rows.every((r) => r.income.wages === 0)).toBe(true);
    expect(rows.every((r) => r.unbudgeted === 0)).toBe(true);
    // ...and the forced payment's excess is swept in, year after year.
    expect(rows[0].flags).toContain('sepp');
    expect(rows[0].balances.byAccount['brokerage']).toBeCloseTo(109792.9143, 4);
    expect(rows[1].balances.byAccount['brokerage']).toBeCloseTo(119216.6258, 4);
    expect(rows[2].balances.byAccount['brokerage']).toBeCloseTo(128204.7765, 4);
    // Savings never moved: the sweep goes to the brokerage, not to cash.
    expect(rows[2].balances.byAccount['savings']).toBeCloseTo(20000, 6);

    // 2029: the forced sale. Basis rose with every swept dollar, so the gain
    // fraction is the ORIGINAL 100,000 over the balance — not 100%.
    const sold = rows[3].withdrawals.taxable;
    expect(sold).toBeGreaterThan(0);
    expect(rows[3].flags).not.toContain('insolvent');
    expect(rows[3].withdrawals.realizedLtcg).toBeCloseTo(sold * (100000 / 128204.7765), 4);
    expect(rows[3].withdrawals.realizedLtcg).toBeLessThan(0.79 * sold);
  });

  it('keeps the recorded-cash identity exact in every year, working through retired', () => {
    /*
     * One deterministic run spanning all three regimes, with the identity
     * checked to the cent in every single year:
     *   2026-2028  working      -> unbudgeted > 0, nothing swept
     *   2029       retirement yr -> unbudgeted > 0, nothing swept (the working
     *                               rule, whole)
     *   2030-2032  retired       -> a forced 72(t) exceeds the need, so the
     *                               excess is swept; nothing consumed
     *   2033       retired       -> neither
     *
     * Everything is 100% bills, so returns are DISTRIBUTED as interest and
     * balances are price-flat. That makes the swept amount recoverable from
     * the brokerage exactly (no growth factor to divide back out), which is
     * what lets this assert to the cent rather than to the dollar.
     */
    const profile = toyProfile({
      accounts: [
        toyAccount({
          id: 'savings',
          type: 'savings',
          owner: 'p1',
          balance: 100000,
          allocation: { stocks: 0, bonds: 0, bills: 1 },
        }),
        toyAccount({
          id: 'brokerage',
          type: 'taxable_brokerage',
          owner: 'p1',
          balance: 300000,
          costBasis: 200000,
          allocation: { stocks: 0, bonds: 0, bills: 1 },
        }),
        toyAccount({
          id: 'ira',
          type: 'traditional_ira',
          owner: 'p1',
          balance: 900000,
          allocation: { stocks: 0, bonds: 0, bills: 1 },
        }),
      ],
      income: { salaries: { p1: 150000, p2: 0 }, contribution401k: 0, employerMatch401k: 0 },
      annualLiving: 60000,
      charitableMonthly: 200,
      investingMonthly: 500,
      horizonAge: 62, // 2026..2033
    });
    const result = runSimulation(
      simInput(profile, {
        name: 'note20-identity',
        events: [
          { type: 'retire', person: 'p1', date: '2029-07' },
          { type: 'retire', person: 'p2', date: '2029-07' },
          { type: 'start_72t', date: '2030-01', account: 'ira', annualAmount: 120000 },
        ],
      }),
    );
    const rows = result.referencePath;
    expect(rows).toHaveLength(8);
    expect(result.success).toBe(1); // solvent throughout: no shortfall leg

    let brokeragePrev = 300000;
    const workingUnbudgeted: number[] = [];
    const retiredSwept: number[] = [];
    for (const row of rows) {
      expect(row.flags).not.toContain('insolvent');
      const brokerageEnd = row.balances.byAccount['brokerage'] ?? 0;
      // Price-flat sleeve: the only flows are taxable draws out, the investing
      // transfer in, and the swept surplus in.
      const swept = brokerageEnd - brokeragePrev + row.withdrawals.taxable - row.investing;
      const income =
        row.income.wages +
        row.income.socialSecurity +
        row.income.taxableInterest +
        row.income.dividends +
        row.income.other +
        row.income.retirement;
      const gross =
        row.withdrawals.cash +
        row.withdrawals.taxable +
        row.withdrawals.pretax + // includes the forced 72(t) payments
        row.withdrawals.roth;
      //   income + gross withdrawals
      //     = expenses.total + taxes + investing + swept + unbudgeted
      expect(
        Math.abs(
          income -
            (row.expenses.total + row.taxes.totalTax + row.investing + swept + row.unbudgeted) +
            gross,
        ),
      ).toBeLessThan(0.01);
      // Exactly one route is ever live, and which one is decided by whether
      // anyone earned.
      if (row.income.wages > 0) {
        expect(Math.abs(swept)).toBeLessThan(0.01);
        workingUnbudgeted.push(row.unbudgeted);
      } else {
        expect(row.unbudgeted).toBe(0);
        retiredSwept.push(swept);
      }
      brokeragePrev = brokerageEnd;
    }

    // The run really did span all three regimes.
    expect(rows.filter((r) => r.income.wages > 0).map((r) => r.year)).toEqual([
      2026, 2027, 2028, 2029,
    ]);
    expect(rows.find((r) => r.year === 2029)!.income.wages).toBeCloseTo(75000, 6); // 6 months
    expect(workingUnbudgeted.every((u) => u > 0)).toBe(true); // incl. the retirement year
    expect(retiredSwept.some((s) => s > 1)).toBe(true); // forced 72(t) excess
    expect(rows.filter((r) => r.flags.includes('sepp')).length).toBeGreaterThan(0);
  });
});

describe('cash yield and mid-year sale proceeds (topic 1)', () => {
  /*
   * Two properties the user's ACA cliff turns on.
   *
   * (1) Savings cash earns what the plan says it earns. A household parking
   *     house-sale proceeds does not leave them at the T-bill rate by accident,
   *     and the interest lands in MAGI — which is what decides whether the one
   *     reachable year of premium tax credit survives.
   * (2) Proceeds arriving mid-year earn for the months they are held. Interest
   *     is otherwise charged on start-of-year balances, so a June sale earned
   *     nothing for the rest of that year: on a representative plan a $1.23M
   *     sale produced $2,346 of interest for a year it was held for six months.
   */
  const soldProfile = () =>
    toyProfile({
      accounts: [
        toyAccount({
          id: 'savings',
          type: 'savings',
          owner: 'p1',
          balance: 100000,
          allocation: { stocks: 0, bonds: 0, bills: 1 },
        }),
      ],
      home: {
        value: 1000000,
        costBasis: 1000000, // no gain: keeps LTCG out of the arithmetic
        state: 'va',
        propertyTaxAnnual: 0,
        insuranceAnnual: 0,
        maintenancePctOfValue: 0,
        sellingCostPct: 0,
        mortgage: null,
      },
      annualLiving: 0,
      horizonAge: 58,
    });

  const sellIn = (month: string, cashYieldNominal?: number) =>
    runSimulation(
      simInput(soldProfile(), {
        name: 'sell',
        events: [{ type: 'sell_house', date: `2027-${month}` }],
        ...(cashYieldNominal === undefined
          ? {}
          : { assumption_overrides: { market: { cashYieldNominal } } }),
      }),
    ).referencePath;

  it('credits a mid-year sale for the months the proceeds are actually held', () => {
    // The home is 1,000,000 and grows one full year before a June 2027 sale:
    // 1,000,000 x 1.025 = 1,025,000 of proceeds, held 6 of 12 months.
    // Interest has two terms: the START-OF-YEAR savings balance for the whole
    // year, plus the proceeds for the months held. The opening balance is read
    // from 2026's close rather than assumed — 2026's own interest compounds
    // into it, so it is not still the 100,000 the fixture started with.
    const rows = sellIn('06');
    const proceeds = rows[1].housing.saleProceeds;
    const opening = rows[0].balances.byAccount['savings'];
    expect(proceeds).toBeCloseTo(1025000, 2);
    expect(rows[1].income.taxableInterest).toBeCloseTo(
      opening * BILLS_NOM + proceeds * BILLS_NOM * 0.5,
      4,
    );
  });

  it('gives a December sale almost no interest and a January sale nearly a full year', () => {
    // The month is the whole point: the same sale, the same money, and an
    // eleven-twelfths difference in what it earns that year.
    const dec = sellIn('12');
    const jan = sellIn('01');
    expect(dec[1].income.taxableInterest).toBeCloseTo(
      dec[0].balances.byAccount['savings'] * BILLS_NOM +
        dec[1].housing.saleProceeds * BILLS_NOM * (0 / 12),
      4,
    );
    expect(jan[1].income.taxableInterest).toBeCloseTo(
      jan[0].balances.byAccount['savings'] * BILLS_NOM +
        jan[1].housing.saleProceeds * BILLS_NOM * (11 / 12),
      4,
    );
    expect(jan[1].income.taxableInterest).toBeGreaterThan(dec[1].income.taxableInterest);
  });

  it('applies the configured cash yield to savings, and ONLY to savings', () => {
    // 4.5% instead of the 3.0125% bills rate, on both terms.
    const rows = sellIn('06', 0.045);
    const proceeds = rows[1].housing.saleProceeds;
    expect(rows[1].income.taxableInterest).toBeCloseTo(
      rows[0].balances.byAccount['savings'] * 0.045 + proceeds * 0.045 * 0.5,
      4,
    );
    // The bills SLEEVE of an investment allocation is a market fact, not a
    // choice about where to park cash, so it keeps the market's own return.
    const withBrokerage = runSimulation(
      simInput(
        toyProfile({
          accounts: [
            toyAccount({
              id: 'brokerage',
              type: 'taxable_brokerage',
              owner: 'p1',
              balance: 100000,
              costBasis: 100000,
              allocation: { stocks: 0, bonds: 0, bills: 1 },
            }),
          ],
          annualLiving: 0,
          horizonAge: 57,
        }),
        {
          name: 'bills-sleeve',
          events: [],
          assumption_overrides: { market: { cashYieldNominal: 0.045 } },
        },
      ),
    ).referencePath;
    expect(withBrokerage[0].income.taxableInterest).toBeCloseTo(100000 * BILLS_NOM, 6);
  });
});

describe('sell_house with the §121 exclusion', () => {
  it('gain above $500k becomes LTCG; net proceeds land in savings', () => {
    // Home: value 1,200,000, basis 300,000, selling costs 6%.
    // 2026: value grows by CPI + 0 spread -> 1,200,000 x 1.025 = 1,230,000.
    // 2027 sale: amount realized = 1,230,000 x 0.94        = 1,156,200
    //   gain = 1,156,200 - 300,000                          =   856,200
    //   §121 exclusion (MFJ)                                =   500,000
    //   taxable LTCG                                        =   356,200
    //   net cash (no mortgage)                              = 1,156,200 -> savings
    const profile = toyProfile({
      accounts: [
        {
          id: 'savings',
          name: 'savings',
          type: 'savings',
          owner: 'p1',
          balance: 300000,
          allocation: { stocks: 0, bonds: 0, bills: 1 },
        },
      ],
      annualLiving: 40000,
      horizonAge: 58, // 2026..2029
      home: {
        value: 1200000,
        costBasis: 300000,
        state: 'va',
        propertyTaxAnnual: 4000,
        insuranceAnnual: 1500,
        maintenancePctOfValue: 0.01,
        sellingCostPct: 0.06,
        mortgage: null,
      },
    });
    const result = runSimulation(
      simInput(profile, { name: 'sell', events: [{ type: 'sell_house', date: '2027-06' }] }),
    );
    const rows = result.referencePath;

    // 2026 sanity: full-year ownership costs =
    //   4,000 property tax + 1,500 insurance + 0.01 x 1,200,000 maintenance = 17,500;
    //   interest = 300,000 x 0.030125 = 9,037.50; tax 0 (AGI under deductions);
    //   withdrawal = 40,000 + 17,500 - 9,037.50 = 48,462.50;
    //   savings end = 300,000 - 48,462.50 = 251,537.50.
    expect(rows[0].taxes.totalTax).toBe(0);
    expect(rows[0].balances.byAccount['savings']).toBeCloseTo(251537.5, 4);
    expect(rows[0].housing.homeValue).toBeCloseTo(1230000, 2);

    const row = rows[1]; // 2027
    expect(row.housing.saleProceeds).toBeCloseTo(1156200, 2);
    expect(row.housing.homeValue).toBe(0);
    // Ownership costs prorated to 6/12 in the sale year:
    //   (4,000 + 1,500) x 1.025 x 0.5 + 0.01 x 1,230,000 x 0.5 = 2,818.75 + 6,150 = 8,968.75.
    expect(row.housing.propertyTax).toBeCloseTo(4000 * 1.025 * 0.5, 4);
    expect(row.housing.maintenance).toBeCloseTo(6150, 2);
    // The 356,200 excess gain is the year's LTCG: AGI = savings interest + LTCG.
    //
    // Savings interest has TWO terms in a sale year. The start-of-year balance
    // earns the full year, and the proceeds — which land in June — earn the six
    // months they are actually held. Before that second term a $1.16M mid-year
    // sale contributed nothing to the year's interest at all.
    //   start-of-year: 251,537.50 x 0.030125            =  7,577.5671875
    //   proceeds:      1,156,200 x 0.030125 x 6/12      = 17,415.2625
    const interest2027 = 251537.5 * BILLS_NOM + 1156200 * BILLS_NOM * 0.5;
    expect(row.income.taxableInterest).toBeCloseTo(interest2027, 4);
    expect(row.taxes.federal.agi).toBeCloseTo(interest2027 + 356200, 2);
    expect(row.taxes.federal.ltcgTax).toBeGreaterThan(0);
    // Proceeds landed in savings: end = 251,537.50 + 1,156,200 - cash withdrawals.
    expect(row.balances.byAccount['savings']).toBeCloseTo(
      251537.5 + 1156200 - row.withdrawals.cash,
      4,
    );
    expect(row.balances.byAccount['savings']).toBeGreaterThan(1000000);
    // MAGI is far over 400% FPL: the ACA cliff fires (and is flagged).
    expect(row.taxes.aca?.cliffApplied).toBe(true);
    expect(row.flags).toContain('aca-cliff');

    // SPEC §7 auditability: the sale-year trace carries the §121 walkthrough
    // with the housing module's actual numbers — amount realized 1,156,200
    // (= 1,230,000 x 0.94), basis 300,000, gain 856,200, exclusion 500,000,
    // taxable excess 356,200 (the LTCG asserted above).
    const trace = row.taxes.trace!;
    expect(trace).toBeDefined();
    const start = trace.findIndex((l) => l.label.includes('Home sale'));
    expect(start).toBeGreaterThanOrEqual(0);
    const sale = trace.slice(start, start + 6);
    const amountOf = (frag: string) => sale.find((l) => l.label.includes(frag))?.amount;
    expect(amountOf('Amount realized')).toBeCloseTo(1156200, 2);
    expect(amountOf('Cost basis')).toBeCloseTo(300000, 2);
    expect(amountOf('Realized gain')).toBeCloseTo(856200, 2);
    expect(amountOf('§121 exclusion applied')).toBeCloseTo(500000, 2);
    expect(amountOf('Taxable excess')).toBeCloseTo(356200, 2);
    // Non-sale years carry no home-sale block.
    expect(rows[0].taxes.trace!.some((l) => l.label.includes('Home sale'))).toBe(false);
  });
});

describe('runHousingYear purchase frees unconsumed sale proceeds (SPEC §9.3)', () => {
  const emptyState = (): HousingState => ({
    home: null,
    defaultMaintenancePct: 0.01,
    defaultSellingCostPct: 0.06,
  });
  const buyArgs = (
    financing: 'cash' | { downPct: number; rate: number; termYears: number },
    // Defaults to "the cash is all still there", which is what these cases are
    // about; the case where living costs ate into it has its own test below.
    cashAvailable = 500000,
  ) => ({
    year: 2028,
    idx: 1,
    sellMonth: null,
    buy: {
      ym: { year: 2028, month: 6 },
      price: 'sale_proceeds' as const,
      financing,
      propertyTaxAnnual: 0,
      insuranceAnnual: 0,
    },
    saleProceedsAvailable: 500000,
    cashAvailable,
    rentNominal: 0,
    homeSaleExclusion: 500000,
    homeGrowthRate: 0.025,
  });

  it('financed 20% down: outflow = down payment, remainder freed for investment', () => {
    // price = tracked proceeds 500,000; down = 0.2 x 500,000 = 100,000
    // (the purchase outflow); freed remainder = 500,000 - 100,000 = 400,000;
    // tracked proceeds are fully consumed by the purchase.
    const state = emptyState();
    const res = runHousingYear(state, buyArgs({ downPct: 0.2, rate: 0.065, termYears: 30 }));
    expect(res.purchaseOutflow).toBeCloseTo(100000, 10);
    expect(res.proceedsToInvest).toBeCloseTo(400000, 10);
    expect(res.saleProceedsRemaining).toBe(0);
    expect(state.home!.value).toBeCloseTo(500000, 10);
    // Loan principal = 500,000 - 100,000 = 400,000 (less 7 months' principal).
    expect(state.home!.mortgage!.balance).toBeLessThan(400000);
    expect(state.home!.mortgage!.balance).toBeGreaterThan(390000);
  });

  it('a cash purchase cannot outspend the cash that survived living on it', () => {
    /*
     * The household sold for 500,000 and then lived on the proceeds for a year
     * while renting, so only 420,000 is left when it buys. The tracked figure
     * still says 500,000 — it is a memory of the sale, not a balance — and
     * buying at it would spend 80,000 that is not there, which in the full
     * simulation means an IRA withdrawal to complete a house purchase.
     *
     * Living comes first and the house gets what survived: a 420,000 house.
     */
    const state = emptyState();
    const res = runHousingYear(state, buyArgs('cash', 420000));
    expect(res.purchaseOutflow).toBeCloseTo(420000, 10);
    expect(state.home!.value).toBeCloseTo(420000, 10);
    // Nothing is "freed for investment": the shortfall was already spent.
    expect(res.proceedsToInvest).toBeCloseTo(80000, 10);
    expect(res.saleProceedsRemaining).toBe(0);
  });

  it('a FINANCED purchase is not capped by this year\'s cash', () => {
    // Only the down payment is due now, so shrinking the house to the cash on
    // hand would understate what the household can afford.
    const state = emptyState();
    const res = runHousingYear(state, buyArgs({ downPct: 0.2, rate: 0.065, termYears: 30 }, 120000));
    expect(state.home!.value).toBeCloseTo(500000, 10);
    expect(res.purchaseOutflow).toBeCloseTo(100000, 10);
  });

  it('cash purchase of the full proceeds: nothing left to invest', () => {
    // Outflow = full price 500,000 = the tracked proceeds -> remainder 0.
    const state = emptyState();
    const res = runHousingYear(state, buyArgs('cash'));
    expect(res.purchaseOutflow).toBeCloseTo(500000, 10);
    expect(res.proceedsToInvest).toBe(0);
    expect(res.saleProceedsRemaining).toBe(0);
    expect(state.home!.mortgage).toBeNull();
  });
});

describe('financed buy_house invests the remaining sale proceeds (SPEC §9.3)', () => {
  /**
   * Household: savings 200,000 (bills), brokerage 50,000 with basis 0 and a
   * 100% bills allocation (its interest is distributed and the price stays
   * flat, so the balance only moves via draws and the proceeds sweep), home
   * 500,000 (basis 300,000, zero carrying costs, zero selling costs).
   * Baseline 40,000; horizon age 58 -> 2026..2029.
   *
   * Hand-computed (billsNom = 0.030125, CPI 2.5%):
   * 2026: interest = 250,000 x 0.030125 = 7,531.25; tax 0 (AGI 7,531 is
   *   under every deduction); cash draw = 40,000 - 7,531.25 = 32,468.75;
   *   savings end = 167,531.25; home value 500,000 x 1.025 = 512,500.
   * 2027 (sale in June, no selling costs): amount realized = 512,500;
   *   gain = 212,500, fully inside §121 -> LTCG 0; net cash 512,500 -> savings.
   *   interest = (167,531.25 + 50,000) x 0.030125 = 6,553.12890625; tax 0;
   *   The sale lands in JUNE, so the proceeds earn half a year at the cash
   *   yield (the bills rate here): 512,500 x 0.030125 x 6/12 = 7,719.53125.
   *   Interest is otherwise charged on start-of-year balances, so before that
   *   term a mid-year sale of half a million dollars earned nothing at all.
   *   total interest = 6,553.12890625 + 7,719.53125 = 14,272.66015625;
   *   draw = 41,000 - 14,272.66015625 = 26,727.33984375;
   *   savings end = 167,531.25 + 512,500 - 26,727.33984375 = 653,303.91015625.
   * 2028 (buy at 'sale_proceeds', 20% down, 6.5%/30yr): price = tracked
   *   proceeds 512,500; down payment (the purchase outflow) = 102,500;
   *   freed remainder = 512,500 - 102,500 = 410,000 moves savings ->
   *   brokerage, raising balance AND basis by exactly 410,000 in the buy year.
   */
  const accounts: Profile['accounts'] = [
    {
      id: 'savings',
      name: 'savings',
      type: 'savings',
      owner: 'p1',
      balance: 200000,
      allocation: { stocks: 0, bonds: 0, bills: 1 },
    },
    {
      id: 'brokerage',
      name: 'brokerage',
      type: 'taxable_brokerage',
      owner: 'p1',
      balance: 50000,
      costBasis: 0,
      allocation: { stocks: 0, bonds: 0, bills: 1 },
    },
  ];
  const home: Profile['home'] = {
    value: 500000,
    costBasis: 300000,
    state: 'va',
    propertyTaxAnnual: 0,
    insuranceAnnual: 0,
    maintenancePctOfValue: 0,
    sellingCostPct: 0,
    mortgage: null,
  };
  const SAVINGS_END_2027 = 653303.91015625;

  it('financed at 20% down: savings drops by the remainder; brokerage balance and basis rise by it', () => {
    const profile = toyProfile({ accounts, home, annualLiving: 40000, horizonAge: 58 });
    const result = runSimulation(
      simInput(profile, {
        name: 'buy-financed',
        events: [
          { type: 'sell_house', date: '2027-06' },
          {
            type: 'buy_house',
            date: '2028-06',
            price: 'sale_proceeds',
            financing: { downPct: 0.2, rate: 0.065, termYears: 30 },
            propertyTaxAnnual: 0,
            insuranceAnnual: 0,
          },
          // 2029: a one-time expense large enough to drain savings and force
          // brokerage sales, exposing the swept-in basis via realized LTCG.
          { type: 'one_time_expense', date: '2029-06', amount: 150000 },
        ],
      }),
    );
    const rows = result.referencePath;
    expect(rows).toHaveLength(4);
    const [r26, r27, r28, r29] = rows;

    expect(r26.taxes.totalTax).toBe(0);
    expect(r26.balances.byAccount['savings']).toBeCloseTo(167531.25, 4);
    expect(r27.taxes.totalTax).toBe(0); // gain fully excluded, AGI under deductions
    expect(r27.housing.saleProceeds).toBeCloseTo(512500, 4);
    expect(r27.balances.byAccount['savings']).toBeCloseTo(SAVINGS_END_2027, 4);
    expect(r27.balances.byAccount['brokerage']).toBeCloseTo(50000, 6);

    // Buy year: the freed remainder (410,000) moved savings -> brokerage.
    expect(r28.withdrawals.taxable).toBe(0); // savings covered every draw
    expect(r28.balances.byAccount['brokerage']).toBeCloseTo(460000, 4);
    // Savings = end-2027 balance - 410,000 sweep - the year's cash draws
    // (which include the 102,500 down payment via the purchase outflow).
    expect(r28.balances.byAccount['savings']).toBeCloseTo(
      SAVINGS_END_2027 - 410000 - r28.withdrawals.cash,
      4,
    );
    expect(r28.withdrawals.cash).toBeGreaterThan(102500);
    expect(r28.housing.homeValue).toBeCloseTo(512500, 4); // bought this year: grows next year

    // Basis moved with the cash: brokerage basis = 0 + 410,000 on a 460,000
    // balance, so 2029 sales realize LTCG at gain fraction 50,000/460,000.
    expect(r29.withdrawals.taxable).toBeGreaterThan(0);
    expect(r29.withdrawals.realizedLtcg).toBeCloseTo(
      r29.withdrawals.taxable * (50000 / 460000),
      4,
    );
  });

  it('cash purchase consuming the full proceeds leaves no sweep', () => {
    const profile = toyProfile({ accounts, home, annualLiving: 40000, horizonAge: 58 });
    const result = runSimulation(
      simInput(profile, {
        name: 'buy-cash',
        events: [
          { type: 'sell_house', date: '2027-06' },
          {
            type: 'buy_house',
            date: '2028-06',
            price: 'sale_proceeds',
            financing: 'cash',
            propertyTaxAnnual: 0,
            insuranceAnnual: 0,
          },
        ],
      }),
    );
    const rows = result.referencePath;
    const r27 = rows[1];
    const r28 = rows[2];
    expect(r27.balances.byAccount['savings']).toBeCloseTo(SAVINGS_END_2027, 4);

    // The full 512,500 price is the purchase outflow: no remainder, so the
    // brokerage is untouched and savings only moves via the cash draws.
    expect(r28.withdrawals.taxable).toBe(0);
    expect(r28.balances.byAccount['brokerage']).toBeCloseTo(50000, 6);
    expect(r28.balances.byAccount['savings']).toBeCloseTo(
      SAVINGS_END_2027 - r28.withdrawals.cash,
      4,
    );
    expect(r28.withdrawals.cash).toBeGreaterThan(512500);
    expect(r28.housing.homeValue).toBeCloseTo(512500, 4);
  });
});

describe('recorded-cash identity: expenses.total excludes taxes and investing', () => {
  it('income + gross withdrawals = expenses.total + taxes + investing + swept + unbudgeted, every year', () => {
    // Rich solvent household exercising EVERY leg of the identity and every
    // stream added by the test-drive notes: savings 300,000 (bills),
    // brokerage 400,000 basis 200,000 (100% stocks -> dividends + realized
    // LTCG), 401(k) 300,000 that rolls into the IRA at the 2028 retirement,
    // IRA 700,000 (forced RMDs from 2046), a 72(t) elected in 2029 (locked
    // through 2033), wages 150,000 with a 12,000 deferral, a 6,000 match, a
    // 300/mo employee premium share, 400/mo of giving, 500/mo of investing,
    // and Social Security at FRA 2038. Deterministic, horizon 79 -> 2050.
    const profile = toyProfile({
      people: [
        toyPerson('p1', {
          piaMonthlyAtFraIfWorkingTo62: 2000,
          piaMonthlyAtFraIfStoppingNow: 1800,
          hasOwnBenefit: true,
        }),
        toyPerson('p2'),
      ],
      accounts: [
        toyAccount({
          id: 'savings',
          type: 'savings',
          owner: 'p1',
          balance: 300000,
          allocation: { stocks: 0, bonds: 0, bills: 1 },
        }),
        toyAccount({
          id: 'brokerage',
          type: 'taxable_brokerage',
          owner: 'p1',
          balance: 400000,
          costBasis: 200000,
          allocation: { stocks: 1, bonds: 0, bills: 0 },
        }),
        toyAccount({
          id: 'k401',
          type: '401k',
          owner: 'p1',
          balance: 300000,
          allocation: { stocks: 1, bonds: 0, bills: 0 },
          currentEmployer: true,
        }),
        toyAccount({
          id: 'ira',
          type: 'traditional_ira',
          owner: 'p1',
          balance: 700000,
          allocation: { stocks: 1, bonds: 0, bills: 0 },
        }),
      ],
      income: { salaries: { p1: 150000, p2: 0 }, contribution401k: 12000, employerMatch401k: 6000 },
      annualLiving: 70000,
      charitableMonthly: 400,
      investingMonthly: 500,
      employerPremiumShareMonthly: 300,
      horizonAge: 79,
    });
    const result = runSimulation(
      simInput(profile, {
        name: 'identity',
        events: [
          { type: 'retire', person: 'p1', date: '2028-07' },
          { type: 'retire', person: 'p2', date: '2028-07' },
          { type: 'start_72t', date: '2029-03', account: 'ira' },
          { type: 'claim_social_security', person: 'p1', date: '2038-06' },
          { type: 'claim_social_security', person: 'p2', date: '2038-06' },
        ],
      }),
    );
    const rows = result.referencePath;
    expect(rows).toHaveLength(25); // 2026..2050

    let savingsPrev = 300000;
    let brokeragePrev = 400000;
    let sawSurplus = false;
    let sawUnbudgeted = false;
    for (const row of rows) {
      expect(row.flags).not.toContain('insolvent');
      // Shared-types contract: total is EXACTLY the five component fields —
      // the investing transfer is NOT one of them.
      expect(row.expenses.total).toBeCloseTo(
        row.expenses.baseline +
          row.expenses.charitable +
          row.expenses.housing +
          row.expenses.health +
          row.expenses.oneTime,
        8,
      );
      // A RETIRED year's surplus is REINVESTED in the brokerage, so recover it
      // from there. The brokerage is 100% stocks, its dividends are distributed
      // (not compounded) and this run has no house sales/purchases, so its
      // only flows are the year's taxable draws (out), the investing transfer
      // and the swept surplus (in), all before growth:
      //   end = (prev - taxable draws + investing + swept) x (1 + g),
      //   g   = stocks return - the distributed dividend yield
      // => swept = end / (1 + g) - prev + taxable draws - investing.
      const g = row.returns.stocks - marketJson.stockDividendYield;
      const brokerageEnd = row.balances.byAccount['brokerage'] ?? 0;
      const swept =
        brokerageEnd / (1 + g) - brokeragePrev + row.withdrawals.taxable - row.investing;
      if (swept > 1) sawSurplus = true;
      if (row.unbudgeted > 1) sawUnbudgeted = true;
      // NOTE 20 — the two leftover routes are mutually exclusive, and which
      // one a year uses is decided by whether anyone earned. Wages are the
      // observable signal on the row (p1 retires 2028-07, so 2026-2028 have
      // wages and 2029+ do not).
      if (row.income.wages > 0) {
        // A working year consumes its leftover: nothing is swept anywhere.
        expect(Math.abs(swept)).toBeLessThan(1);
      } else {
        // A retired year sweeps: nothing is consumed.
        expect(row.unbudgeted).toBe(0);
      }
      // And savings now moves ONLY by the year's cash draws — nothing is
      // parked there any more.
      const savingsEnd = row.balances.byAccount['savings'] ?? 0;
      expect(savingsEnd).toBeCloseTo(savingsPrev - row.withdrawals.cash, 4);
      // Wages are already net of BOTH payroll deductions (401(k) deferral and
      // the employee premium share), so the share never appears here.
      const income =
        row.income.wages +
        row.income.socialSecurity +
        row.income.taxableInterest +
        row.income.dividends +
        row.income.other;
      const gross =
        row.withdrawals.cash +
        row.withdrawals.taxable +
        row.withdrawals.pretax + // includes forced RMDs and 72(t) payments
        row.withdrawals.roth;
      // The recorded-cash identity (no purchase outflows in this run):
      //   income.total + gross withdrawals
      //     = expenses.total + taxes.totalTax + investing
      //       + surplus swept (retired years) + unbudgeted (working years).
      // Note 20 made the consumed leftover an EXPLICIT recorded figure rather
      // than something that quietly disappears.
      const residual =
        income +
        gross -
        (row.expenses.total + row.taxes.totalTax + row.investing + swept + row.unbudgeted);
      // The only slack is the withdrawal solve's own convergence tolerance:
      // the plan is sized against the previous iteration's taxes, so a year
      // with no surplus can land a fraction of a dollar SHORT of its need
      // (never over — the engine cannot invent cash). That bound is $1 by
      // construction and predates note 20.
      expect(residual).toBeLessThan(0.01);
      expect(residual).toBeGreaterThan(-1);
      // Whenever there IS leftover cash, every cent of it is accounted for:
      // no surplus is ever silently dropped, whichever route it took.
      if (row.unbudgeted > 0 || swept > 0.5) {
        expect(Math.abs(residual)).toBeLessThan(0.01);
      }
      savingsPrev = savingsEnd;
      brokeragePrev = brokerageEnd;
    }

    // The run really exercised every leg of the identity:
    expect(rows.some((r) => r.withdrawals.rmd > 0)).toBe(true); // forced RMDs 2046+
    expect(rows.some((r) => r.flags.includes('sepp'))).toBe(true); // 72(t) payments
    expect(rows.some((r) => r.eventsFired.includes('rollover-401k'))).toBe(true);
    expect(rows.some((r) => r.expenses.health > 0)).toBe(true); // Medicare premiums
    expect(rows.every((r) => r.expenses.charitable > 0)).toBe(true); // giving never stops
    expect(rows.some((r) => r.investing > 0)).toBe(true); // working years invest
    expect(rows.some((r) => r.income.employerHealthPremiumShare > 0)).toBe(true);
    expect(rows.some((r) => r.withdrawals.realizedLtcg > 0)).toBe(true); // taxable draws
    expect(rows.some((r) => r.income.wages > 0)).toBe(true);
    expect(rows.some((r) => r.taxes.totalTax > 0)).toBe(true);
    expect(rows.some((r) => r.income.socialSecurity > 0)).toBe(true);
    expect(sawSurplus).toBe(true); // forced-distribution years sweep the excess
    expect(sawUnbudgeted).toBe(true); // working years consume theirs (note 20)
    // ...and the run really did span both regimes, in that order.
    expect(rows.filter((r) => r.unbudgeted > 0).every((r) => r.income.wages > 0)).toBe(true);
  });
});

describe('performance smoke bound (SPEC §2)', () => {
  it('1,000 MC paths x 41 years complete well under the 10s/10k budget (< 3s here)', () => {
    const scenario: Scenario = {
      name: 'perf',
      events: [
        { type: 'retire', person: 'p1', date: '2026-07' },
        { type: 'retire', person: 'p2', date: '2026-07' },
        { type: 'claim_social_security', person: 'p1', date: '2042-03' },
        { type: 'claim_social_security', person: 'p2', date: '2044-09' },
      ],
    };
    const result = runSimulation(
      simInput(starterProfile, scenario, { mode: 'montecarlo', paths: 1000, seed: 7 }),
    );
    expect(result.horizonYears).toBe(47); // 2026..2072 (p2 born 1977, age 95)
    expect(result.meta.paths).toBe(1000);
    // 3s for 1,000 x 47yr extrapolates to ~10s+ headroom for 10,000 paths
    // relative to the SPEC §2 target on this machine.
    expect(result.elapsedMs).toBeLessThan(3000);
    // Sanity: the fan is monotone across percentiles at the terminal year.
    const last = result.fan.years.length - 1;
    expect(result.fan.p10[last]).toBeLessThanOrEqual(result.fan.p50[last]);
    expect(result.fan.p50[last]).toBeLessThanOrEqual(result.fan.p90[last]);
  });
});

describe('prepareSim / simulatePath contract', () => {
  it('simulatePath is reusable across paths without mutating the prepared context', () => {
    const input = simInput(toyProfile(), { name: 'ctx-reuse', events: [] });
    const ctx = prepareSim(input);
    const path = deterministicPath(input.assumptions.market, ctx.horizonYears);
    const a = simulatePath(ctx, path, { trace: false });
    const b = simulatePath(ctx, path, { trace: true });
    expect(a.yearRows).toBeNull();
    expect(b.yearRows).not.toBeNull();
    expect(a.terminalReal).toBe(b.terminalReal);
    expect(a.balancesRealByYear).toEqual(b.balancesRealByYear);
    expect(a.insolvencyYear).toBeNull();
  });

  it('drains to insolvency and keeps simulating with zero balances', () => {
    // 50,000 of savings against 60,000/yr spending: insolvent in year 1..2,
    // then the fan shows zeros through the horizon.
    const profile = toyProfile({ annualLiving: 60000 });
    profile.accounts[0].balance = 50000;
    const result = runSimulation(simInput(profile, { name: 'broke', events: [] }));
    const rows = result.referencePath;
    const insolventRow = rows.find((r) => r.flags.includes('insolvent'));
    expect(insolventRow).toBeDefined();
    expect(rows[rows.length - 1].balances.total).toBe(0);
    expect(result.success).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 14. THE TITHE ACCOUNT (note 21)
// ---------------------------------------------------------------------------

/** The tithe variant on its own, so its four parameters can be named. */
type TitheRule = Extract<RetirementGivingRule, { type: 'tithe_account' }>;

/**
 * Tithe-rule household. NO salary in any year unless a test supplies one, so
 * `employerMonthsByYear` is 0 from the first row: the household is fully
 * retired in 2026, the rule governs every year, and — with no `retire` event
 * to trigger one — no automatic 72(t) can elect against the seed.
 *
 * Both spouses born 1971-06, so within the default 10-year horizon nobody
 * reaches Medicare (65) or an RMD (75), and with `annualLiving` left at 0 and
 * the benchmark ACA quote at 0 NOTHING leaves the portfolio at all. Every
 * balance is then pure growth arithmetic and the high-water mark is
 * hand-checkable to the cent — which is the whole reason the fixture is this
 * bare. Tests that need the machinery (RMDs, a 72(t), a salary that stops)
 * turn it on one piece at a time.
 *
 * The default accounts hold both kinds of retirement wrapper, because the seed
 * base spans pre-tax AND Roth: an IRA of 1,000,000 with 400,000 contributed,
 * and a Roth of 100,000 with 60,000 contributed — 640,000 of untithed gains.
 */
function titheProfile(
  rule: TitheRule,
  partial?: {
    accounts?: Profile['accounts'];
    annualLiving?: number;
    charitableMonthly?: number;
    investingMonthly?: number;
    employerPremiumShareMonthly?: number;
    income?: Profile['income'];
    people?: Profile['people'];
    horizonAge?: number;
  },
): Profile {
  const p = toyProfile({
    accounts: partial?.accounts ?? [
      toyAccount({
        id: 'ira',
        name: 'Traditional IRA',
        type: 'traditional_ira',
        owner: 'p1',
        balance: 1_000_000,
        lifetimeContributions: 400_000,
        allocation: { stocks: 0, bonds: 0, bills: 1 },
      }),
      toyAccount({
        id: 'roth',
        name: 'Roth IRA',
        type: 'roth_ira',
        owner: 'p2',
        balance: 100_000,
        lifetimeContributions: 60_000,
        allocation: { stocks: 0, bonds: 0, bills: 1 },
      }),
    ],
    annualLiving: partial?.annualLiving ?? 0,
    charitableMonthly: partial?.charitableMonthly,
    investingMonthly: partial?.investingMonthly,
    employerPremiumShareMonthly: partial?.employerPremiumShareMonthly,
    income: partial?.income,
    people: partial?.people,
    horizonAge: partial?.horizonAge ?? 64, // 2026..2035, ages 55..64
  });
  p.expenses.retirementGiving = rule;
  return p;
}

/** The carve-out's end-of-year balance, or 0 in a plan that never opened one. */
const titheOf = (row: YearRow): number => row.balances.tithe;

describe('the Tithe Account: the seed on retirement day (note 21)', () => {
  it('seeds percent x (balance - lifetime contributions) across every retirement wrapper', () => {
    /*
     * IRA 1,000,000 (400,000 contributed) + Roth 100,000 (60,000 contributed),
     * both 100% bills so both compound at BILLS_NOM = 0.030125. No spending,
     * no income, no tax: nothing leaves the portfolio in the seed year.
     *
     * UNTITHED BASE  = (1,000,000 - 400,000) + (100,000 - 60,000) = 640,000
     * SEED (10%)     =                                               64,000
     *   -> the parent IRA is relabelled, not distributed:
     *      ira        1,000,000 - 64,000                        =   936,000
     *      ira-tithe                                            =    64,000
     * GROWTH (x 1.030125 on every account):
     *      ira          936,000 x 1.030125                      = 964,197.00
     *      ira-tithe     64,000 x 1.030125                       =  65,928.00
     *      roth         100,000 x 1.030125                       = 103,012.50
     *      total                                                = 1,133,137.50
     * THE BASE IS REAL GAIN, so the year's 2.5% inflation is netted off:
     *      spendable gain   28,197.00 + 3,012.50               =  31,209.50
     *      inflation on the spendable side, which excludes the seed just cut
     *      out of it:       1,036,000 x 0.025                  = -25,900.00
     *      real gain                                           =   5,309.50
     * TRANSFER (10% of the base)                               =     530.95
     *      ira        964,197.00 - 530.95                       = 963,666.05
     *      ira-tithe   65,928.00 + 530.95                       =  66,458.95
     *
     * Not 3,120.95 — a tenth of the NOMINAL gain, which is what a mark on the
     * balance produced here before inflation was netted off properly.
     */
    const rows = runSimulation(
      simInput(
        titheProfile({ type: 'tithe_account', percent: 0.1, deferYears: 3, seedFromExistingGains: true }),
        { name: 'tithe-seed', events: [] },
      ),
    ).referencePath;
    const seedYear = rows[0];
    expect(seedYear.year).toBe(2026);

    expect(seedYear.tithe).toBeDefined();
    expect(seedYear.tithe!.accountId).toBe('ira-tithe'); // <parentId>-tithe
    expect(seedYear.tithe!.seeded).toBeCloseTo(64000, 8);
    expect(seedYear.tithe!.accrued).toBeCloseTo(530.95, 8);
    expect(seedYear.balances.byAccount['ira']).toBeCloseTo(963666.05, 6);
    expect(seedYear.balances.byAccount['ira-tithe']).toBeCloseTo(66458.95, 6);
    expect(seedYear.balances.byAccount['roth']).toBeCloseTo(103012.5, 6);

    // The seed and the transfer are INTERNAL: one IRA balance down, another
    // up. The household's total is untouched by both, which is the whole
    // reason a carve-out costs nothing where funding a giving account out of
    // an IRA would cost a taxable distribution.
    expect(seedYear.balances.total).toBeCloseTo(1133137.5, 6);
    expect(seedYear.balances.tithe).toBeCloseTo(66458.95, 6);
    /*
     * CHANGED WITH THE SOFT WINDOW (the seed no longer removes spendable
     * money on retirement day — the exact defect the redesign fixed):
     * through the defer window the carve-out COUNTS, so `spendable` equals
     * `total`, not total minus the seed. The pot is broken out in
     * balances.tithe and locked out of spendable only from distribution
     * start.
     */
    expect(seedYear.tithe!.locked).toBe(false);
    expect(seedYear.balances.spendable).toBeCloseTo(seedYear.balances.total, 8);
    expect(seedYear.balances.spendableReal).toBeCloseTo(1133137.5, 6); // CPI index 1
    // No cash moved: not an expense, not a withdrawal, not income, not tax.
    expect(seedYear.expenses.charitable).toBe(0);
    expect(seedYear.withdrawals.byAccount['ira-tithe'] ?? 0).toBe(0);
    expect(seedYear.withdrawals.pretax).toBe(0);
    expect(seedYear.taxes.totalTax).toBe(0);

    // It is a one-off, and it is announced.
    expect(seedYear.eventsFired).toContain('tithe-seeded');
    expect(rows.slice(1).some((r) => r.eventsFired.includes('tithe-seeded'))).toBe(false);
    expect(rows.slice(1).every((r) => r.tithe!.seeded === 0)).toBe(true);
    const opened = seedYear.taxes.trace!.find((t) => t.label.startsWith('Tithe Account opened'))!;
    expect(opened.label).toContain('ira');
    expect(opened.amount).toBeCloseTo(64000, 8);

    // The carve-out inherits the parent's mix, so it grows at the parent's
    // rate: 100% bills either side.
    const y2027 = rows[1];
    const grownFrom2026 = titheOf(y2027) - y2027.tithe!.accrued;
    expect(grownFrom2026 / titheOf(seedYear) - 1).toBeCloseTo(BILLS_NOM, 12);
  });

  it('takes the percentage it is given, and 0% opens the carve-out at nothing', () => {
    const at = (percent: number) =>
      runSimulation(
        simInput(
          titheProfile({ type: 'tithe_account', percent, deferYears: 3, seedFromExistingGains: true }),
          { name: `tithe-pct-${percent}`, events: [] },
        ),
      ).referencePath[0];
    expect(at(0.05).tithe!.seeded).toBeCloseTo(32000, 8); // 5% of 640,000
    expect(at(0.25).tithe!.seeded).toBeCloseTo(160000, 8);
    // A 0% rule still OPENS the account (deferYears > 0 asks for one) — it
    // simply never puts anything in it, which is a different statement from
    // "the household has no tithe account".
    const zero = at(0);
    expect(zero.tithe).toBeDefined();
    expect(zero.tithe!.seeded).toBe(0);
    expect(zero.tithe!.accrued).toBe(0);
    expect(zero.balances.tithe).toBe(0);
    expect(zero.balances.spendable).toBeCloseTo(zero.balances.total, 8);
  });

  it('counts an account with no lifetime-contribution figure as 0 untithed, and says so', () => {
    // The Roth's figure is missing. ABSENT MEANS UNKNOWN, so it contributes
    // nothing rather than being read as "all gain" (100,000) or "all
    // principal" (0 gain, which is what happens, but for a stated reason).
    // Base = the IRA's 600,000 alone -> seed 60,000, not 64,000.
    const accounts: Profile['accounts'] = [
      toyAccount({
        id: 'ira',
        type: 'traditional_ira',
        owner: 'p1',
        balance: 1_000_000,
        lifetimeContributions: 400_000,
        allocation: { stocks: 0, bonds: 0, bills: 1 },
      }),
      toyAccount({
        id: 'roth',
        type: 'roth_ira',
        owner: 'p2',
        balance: 100_000,
        allocation: { stocks: 0, bonds: 0, bills: 1 },
      }),
    ];
    const rows = runSimulation(
      simInput(
        titheProfile(
          { type: 'tithe_account', percent: 0.1, deferYears: 3, seedFromExistingGains: true },
          { accounts },
        ),
        { name: 'tithe-basis-missing', events: [] },
      ),
    ).referencePath;

    expect(rows[0].tithe!.seeded).toBeCloseTo(60000, 8);
    // Flagged in the seed year, and only there — it is a fact about the seed,
    // not a standing property of the plan.
    expect(rows[0].flags).toContain('tithe-basis-missing');
    expect(rows.slice(1).some((r) => r.flags.includes('tithe-basis-missing'))).toBe(false);
    expect(
      rows[0].taxes.trace!.some((t) => t.label === 'Some accounts had no lifetime-contribution figure'),
    ).toBe(true);
  });

  it('floors an underwater account at zero untithed instead of subtracting a loss', () => {
    // The Roth has contributed 150,000 and is worth 100,000: a 50,000 loss.
    // max(0, balance - contributions) keeps that loss out of the base — a
    // household does not get to reduce the tithe on one account's gains by
    // another account's fall. Base = the IRA's 600,000 -> seed 60,000, the
    // same figure as the missing-figure case above but for a different
    // reason, and WITHOUT the flag: nothing here is unknown.
    const accounts: Profile['accounts'] = [
      toyAccount({
        id: 'ira',
        type: 'traditional_ira',
        owner: 'p1',
        balance: 1_000_000,
        lifetimeContributions: 400_000,
        allocation: { stocks: 0, bonds: 0, bills: 1 },
      }),
      toyAccount({
        id: 'roth',
        type: 'roth_ira',
        owner: 'p2',
        balance: 100_000,
        lifetimeContributions: 150_000,
        allocation: { stocks: 0, bonds: 0, bills: 1 },
      }),
    ];
    const rows = runSimulation(
      simInput(
        titheProfile(
          { type: 'tithe_account', percent: 0.1, deferYears: 3, seedFromExistingGains: true },
          { accounts },
        ),
        { name: 'tithe-underwater', events: [] },
      ),
    ).referencePath;
    expect(rows[0].tithe!.seeded).toBeCloseTo(60000, 8);
    expect(rows[0].flags).not.toContain('tithe-basis-missing');
  });

  it('seedFromExistingGains false opens the carve-out empty and tithes only what comes next', () => {
    const rows = runSimulation(
      simInput(
        titheProfile({ type: 'tithe_account', percent: 0.1, deferYears: 3, seedFromExistingGains: false }),
        { name: 'tithe-no-seed', events: [] },
      ),
    ).referencePath;
    // The account exists (the defer window needs somewhere to put the money)
    // but the past is let lie: nothing is carried into it on day one.
    expect(rows[0].tithe).toBeDefined();
    expect(rows[0].tithe!.seeded).toBe(0);
    // Nothing was cut out of the portfolio, so the whole 1,100,000 earns and
    // is charged inflation: gain 1,100,000 x 0.030125 = 33,137.50, less
    // 1,100,000 x 0.025 = 27,500 of inflation, leaves 5,637.50 of REAL gain —
    // a tenth of which moves across. (A tenth of the nominal 33,137.50 would
    // be 3,313.75, which is what a mark on the balance produced before
    // inflation was netted off.)
    expect(rows[0].tithe!.accrued).toBeCloseTo(563.75, 8);
    expect(rows[0].balances.tithe).toBeCloseTo(563.75, 8);
  });

  it('opens no carve-out at all when the household holds no divisible pre-tax account', () => {
    // Savings + a Roth: there is no traditional IRA or 401(k) to carve a
    // second IRA out of, so the balance side of the rule simply never starts.
    // The CASH side still runs — the rule is not disabled, it just never
    // accumulates. Documented limitation, pinned here so it stays deliberate.
    const accounts: Profile['accounts'] = [
      toyAccount({
        id: 'savings',
        type: 'savings',
        owner: 'p1',
        balance: 200_000,
        allocation: { stocks: 0, bonds: 0, bills: 1 },
      }),
      toyAccount({
        id: 'roth',
        type: 'roth_ira',
        owner: 'p2',
        balance: 300_000,
        lifetimeContributions: 100_000,
        allocation: { stocks: 0, bonds: 0, bills: 1 },
      }),
    ];
    const result = runSimulation(
      simInput(
        titheProfile(
          { type: 'tithe_account', percent: 0.1, deferYears: 2, seedFromExistingGains: true },
          { accounts, horizonAge: 62 },
        ),
        { name: 'tithe-no-pretax', events: [] },
      ),
    );
    const rows = result.referencePath;
    expect(rows.every((r) => r.tithe === undefined)).toBe(true);
    expect(rows.every((r) => r.balances.tithe === 0)).toBe(true);
    expect(rows.every((r) => r.balances.spendable === r.balances.total)).toBe(true);
    expect(rows.some((r) => r.eventsFired.includes('tithe-seeded'))).toBe(false);
    // Defer window (2026-2027) gives nothing, and so does the 2028 handover
    // year — cash giving still arrives after, from a portfolio that never held
    // a carve-out at all.
    expect(rows[0].expenses.charitable).toBe(0);
    expect(rows[1].expenses.charitable).toBe(0);
    expect(rows[2].expenses.charitable).toBe(0);
    expect(rows[3].expenses.charitable).toBeGreaterThan(0);
    expect(result.charitableLegacy.terminalTitheReal).toBe(0);
    expect(result.charitableLegacy.cashGivenReal).toBeGreaterThan(0);
  });

  it('reads the 401(k)’s contribution history through the rollover into the IRA', () => {
    /*
     * Note 7 rolls the 401(k) into the traditional IRA in the retirement year,
     * BEFORE the seed. If the contribution history did not travel with the
     * dollars, the merged IRA would look like pure gain and the seed would be
     * wildly overstated — so the rollover carries it, and this is the test
     * that says so.
     *
     * 401(k) 400,000 (250,000 contributed) + IRA 600,000 (200,000 contributed)
     * merge into one IRA with 450,000 contributed. p1 retires 2027-12, so 2028
     * is the first fully retired year and the seed reads the merged balance.
     */
    const accounts: Profile['accounts'] = [
      toyAccount({
        id: 'k401',
        type: '401k',
        owner: 'p1',
        balance: 400_000,
        lifetimeContributions: 250_000,
        currentEmployer: true,
        allocation: { stocks: 0, bonds: 0, bills: 1 },
      }),
      toyAccount({
        id: 'ira',
        type: 'traditional_ira',
        owner: 'p1',
        balance: 600_000,
        lifetimeContributions: 200_000,
        allocation: { stocks: 0, bonds: 0, bills: 1 },
      }),
      toyAccount({
        id: 'savings',
        type: 'savings',
        owner: 'p1',
        balance: 300_000,
        allocation: { stocks: 0, bonds: 0, bills: 1 },
      }),
    ];
    const rows = runSimulation(
      simInput(
        titheProfile(
          { type: 'tithe_account', percent: 0.1, deferYears: 5, seedFromExistingGains: true },
          {
            accounts,
            annualLiving: 30_000,
            horizonAge: 60,
            income: { salaries: { p1: 120_000, p2: 0 }, contribution401k: 0, employerMatch401k: 0 },
          },
        ),
        {
          name: 'tithe-rollover',
          autoSepp: false, // keep the 72(t) machinery out of the arithmetic
          events: [{ type: 'retire', person: 'p1', date: '2027-12' }],
        },
      ),
    ).referencePath;

    const rolloverYear = rows.find((r) => r.eventsFired.includes('rollover-401k'))!;
    expect(rolloverYear.year).toBe(2027);
    expect(rolloverYear.balances.byAccount['k401']).toBe(0);

    const seedRow = rows.find((r) => r.eventsFired.includes('tithe-seeded'))!;
    expect(seedRow.year).toBe(2028);
    // The seed reads the MERGED balance against the MERGED contributions.
    const merged = rows[1].balances.byAccount['ira']; // end of 2027 = start of 2028
    expect(seedRow.tithe!.seeded).toBeCloseTo(0.1 * (merged - 450_000), 6);
    expect(seedRow.tithe!.seeded).toBeCloseTo(61115.752, 3);
    // Nothing about the merge was a guess, so nothing is flagged.
    expect(rows.some((r) => r.flags.includes('tithe-basis-missing'))).toBe(false);
  });

  it('bumps the id rather than colliding with an account that already owns it', () => {
    // The household happens to hold something called `ira-tithe` already (an
    // old export, a hand-edited file, a second carve-out in a future change).
    // The carve-out takes `-tithe2`, exactly as the automatic 72(t) takes
    // `-sepp2` — two accounts silently sharing an id would corrupt every
    // per-account figure downstream.
    const rows = runSimulation(
      simInput(
        titheProfile(
          { type: 'tithe_account', percent: 0.1, deferYears: 3, seedFromExistingGains: true },
          {
            accounts: [
              toyAccount({
                id: 'ira-tithe',
                name: 'Not the tithe account',
                type: 'savings',
                owner: 'p1',
                balance: 10_000,
                allocation: { stocks: 0, bonds: 0, bills: 1 },
              }),
              toyAccount({
                id: 'ira',
                type: 'traditional_ira',
                owner: 'p1',
                balance: 1_000_000,
                lifetimeContributions: 400_000,
                allocation: { stocks: 0, bonds: 0, bills: 1 },
              }),
            ],
            horizonAge: 58,
          },
        ),
        { name: 'tithe-id-bump', events: [] },
      ),
    ).referencePath;
    expect(rows[0].tithe!.accountId).toBe('ira-tithe2');
    expect(rows[0].balances.byAccount['ira-tithe2']).toBeGreaterThan(0);
    // The impostor is untouched — still savings, still growing at the bills
    // rate, still counted as spendable.
    expect(rows[0].balances.byAccount['ira-tithe']).toBeCloseTo(10_000 * BILLS_NOM + 10_000, 6);
    expect(rows[0].balances.tithe).toBeCloseTo(rows[0].balances.byAccount['ira-tithe2'], 8);
  });

  it('carves out of the LARGEST divisible pre-tax account and transfers only from it', () => {
    // Two IRAs, one each. The parent is the bigger one, and the yearly
    // transfer is a relabelling INSIDE it: the other IRA is a different
    // person's account and is never touched while the parent can cover it.
    // earlyRelease: false — this fixture has no spending, so it sets a new
    // real high every year and the default release would close the window
    // after year one; the accrual mechanics under test need it open.
    const rows = runSimulation(
      simInput(
        titheProfile(
          {
            type: 'tithe_account',
            percent: 0.1,
            deferYears: 3,
            seedFromExistingGains: true,
            earlyRelease: false,
          },
          {
            accounts: [
              toyAccount({
                id: 'ira-small',
                name: "P2's IRA",
                type: 'traditional_ira',
                owner: 'p2',
                balance: 200_000,
                lifetimeContributions: 50_000,
                allocation: { stocks: 0, bonds: 0, bills: 1 },
              }),
              toyAccount({
                id: 'ira-big',
                name: "P1's IRA",
                type: 'traditional_ira',
                owner: 'p1',
                balance: 900_000,
                lifetimeContributions: 300_000,
                allocation: { stocks: 0, bonds: 0, bills: 1 },
              }),
            ],
            horizonAge: 58, // 2026..2029
          },
        ),
        { name: 'tithe-two-iras', events: [] },
      ),
    ).referencePath;

    // Base spans BOTH accounts — the tithe is owed by the portfolio, not by
    // one account: (900,000 - 300,000) + (200,000 - 50,000) = 750,000 -> 75,000.
    expect(rows[0].tithe!.accountId).toBe('ira-big-tithe');
    expect(rows[0].tithe!.seeded).toBeCloseTo(75_000, 8);
    // ...but the carve-out comes out of the parent alone. The other IRA moves
    // ONLY by recorded withdrawals and its own growth — never by a transfer,
    // which would be an unrecorded balance leaving the account.
    //   end = (start - withdrawn) x (1 + bills), withdrawals applied first.
    let small = 200_000;
    for (const row of rows) {
      small = (small - (row.withdrawals.byAccount['ira-small'] ?? 0)) * (1 + BILLS_NOM);
      expect(row.balances.byAccount['ira-small']).toBeCloseTo(small, 6);
    }
    // Through the defer window nothing draws on it at all — the accrual is
    // satisfied by the parent every year.
    for (const row of rows.filter((r) => r.year < 2029)) {
      expect(row.withdrawals.byAccount['ira-small'] ?? 0).toBe(0);
      expect(row.tithe!.accrued).toBeGreaterThan(0);
    }
  });

  it('reads the same untithed base whether or not a 72(t) has split the IRA', () => {
    /*
     * The automatic bridge elects in the retirement year and SPLITS the IRA
     * before the seed runs, so the seed sees two accounts where the profile
     * described one. The contribution history has to follow the dollars into
     * both halves, pro rata: if it stayed behind on the remainder, the
     * carve-out half would look like pure gain (and the remainder like pure
     * principal), and the base would come out wrong in BOTH directions at once
     * — understating the seed and raising a false 'tithe-basis-missing'.
     *
     * IRA 300,000 with 200,000 contributed -> 100,000 untithed -> a 10,000
     * seed, split or not.
     */
    const build = (): Profile => {
      const p = toyProfile({
        accounts: [
          toyAccount({
            id: 'savings',
            type: 'savings',
            owner: 'p1',
            balance: 50_000,
            allocation: { stocks: 0, bonds: 0, bills: 1 },
          }),
          toyAccount({
            id: 'ira',
            type: 'traditional_ira',
            owner: 'p1',
            balance: 300_000,
            lifetimeContributions: 200_000,
            allocation: { stocks: 0, bonds: 0, bills: 1 },
          }),
        ],
        annualLiving: 20_000,
        horizonAge: 61,
      });
      p.expenses.retirementGiving = {
        type: 'tithe_account',
        percent: 0.1,
        deferYears: 30,
        seedFromExistingGains: true,
      };
      return p;
    };
    const events: Scenario['events'] = [{ type: 'retire', person: 'p1', date: '2026-07' }];
    const split = runSimulation(
      simInput(build(), { name: 'tithe-sepp-basis', events }),
    ).referencePath[0];
    const whole = runSimulation(
      simInput(build(), { name: 'tithe-sepp-basis-control', autoSepp: false, events }),
    ).referencePath[0];

    expect(split.flags).toContain('sepp'); // the bridge really did elect
    expect(split.balances.byAccount['ira-sepp']).toBeGreaterThan(0);
    expect(whole.balances.byAccount['ira-sepp']).toBeUndefined();
    expect(split.tithe!.seeded).toBeCloseTo(10_000, 8);
    expect(split.tithe!.seeded).toBeCloseTo(whole.tithe!.seeded, 8);
    expect(split.flags).not.toContain('tithe-basis-missing');
  });

  it('a rollover that merges a known figure with an unknown one reports UNKNOWN', () => {
    // Same household, except the 401(k) carries no contribution history. A
    // merged total of "200,000 plus something" is not 200,000, and reporting
    // it as such would invent certainty: the merged IRA becomes unknown, the
    // seed falls to 0 and the year is flagged.
    const accounts: Profile['accounts'] = [
      toyAccount({
        id: 'k401',
        type: '401k',
        owner: 'p1',
        balance: 400_000,
        currentEmployer: true,
        allocation: { stocks: 0, bonds: 0, bills: 1 },
      }),
      toyAccount({
        id: 'ira',
        type: 'traditional_ira',
        owner: 'p1',
        balance: 600_000,
        lifetimeContributions: 200_000,
        allocation: { stocks: 0, bonds: 0, bills: 1 },
      }),
      toyAccount({
        id: 'savings',
        type: 'savings',
        owner: 'p1',
        balance: 300_000,
        allocation: { stocks: 0, bonds: 0, bills: 1 },
      }),
    ];
    const rows = runSimulation(
      simInput(
        titheProfile(
          { type: 'tithe_account', percent: 0.1, deferYears: 5, seedFromExistingGains: true },
          {
            accounts,
            annualLiving: 30_000,
            horizonAge: 60,
            income: { salaries: { p1: 120_000, p2: 0 }, contribution401k: 0, employerMatch401k: 0 },
          },
        ),
        {
          name: 'tithe-rollover-unknown',
          autoSepp: false,
          events: [{ type: 'retire', person: 'p1', date: '2027-12' }],
        },
      ),
    ).referencePath;
    const seedRow = rows.find((r) => r.year === 2028)!;
    expect(seedRow.tithe!.seeded).toBe(0);
    expect(seedRow.flags).toContain('tithe-basis-missing');
  });
});

describe('the Tithe Account: the high-water mark (note 21)', () => {
  /**
   * A single 1,000,000 IRA, 100% stocks, no spending and no income, driven by
   * a hand-written return path with CPI pinned at 0 — so real IS nominal, the
   * cumulative index stays 1, and every figure below is exact rather than
   * close. The rule never seeds and never disburses (deferYears 20 outlives
   * the horizon), which leaves exactly one mechanism in play: the accrual.
   */
  const hwmProfile = () =>
    titheProfile(
      // earlyRelease: false — the +50% year would otherwise release the
      // window immediately (it IS a new real high) and freeze the accrual
      // machinery this whole describe exists to pin.
      {
        type: 'tithe_account',
        percent: 0.1,
        deferYears: 20,
        seedFromExistingGains: false,
        earlyRelease: false,
      },
      {
        accounts: [
          toyAccount({
            id: 'ira',
            type: 'traditional_ira',
            owner: 'p1',
            balance: 1_000_000,
            lifetimeContributions: 0,
            allocation: { stocks: 1, bonds: 0, bills: 0 },
          }),
        ],
        horizonAge: 59, // 2026..2030 — five years, one per hand-written return
      },
    );
  const flat = (stocks: number[]): YearReturns[] =>
    stocks.map((s) => ({ stocks: s, bonds: 0, bills: 0, cpi: 0 }));

  it('accrues NOTHING on a recovery — the whole point of the mark', () => {
    /*
     * 0%, +50%, -50%, +100%, +20% on 1,000,000, inflation pinned at 0. The mark
     * rides CUMULATIVE REAL GAIN, so track the gain each year, not the balance:
     *
     *  2026  x1.00  gain        0   cum       0   mark 0   base 0   move 0
     *  2027  x1.50  gain  500,000   cum 500,000   base 500,000  -> move 50,000
     *                              mark -> 500,000; spendable 1,450,000
     *  2028  x0.50  gain -725,000   cum -225,000  base 0 (deep under the mark)
     *                              mark HOLDS at 500,000; spendable 725,000
     *  2029  x2.00  gain  725,000   cum  500,000  THE PORTFOLIO DOUBLED AND
     *                              OWES NOTHING — the cumulative gain is back
     *                              to exactly the 500,000 already tithed on,
     *                              and re-earned ground is not tithed twice.
     *  2030  x1.20  gain  290,000   cum  790,000  base = 790,000 - 500,000
     *                              = 290,000 -> move 29,000
     *
     * The carve-out rides the same returns but its gain is OUTSIDE the base:
     * 50,000 -> 25,000 -> 50,000 -> 60,000, plus 29,000 moved in = 89,000.
     */
    const ctx = prepareSim(simInput(hwmProfile(), { name: 'tithe-hwm', events: [] }));
    expect(ctx.horizonYears).toBe(5);
    const rows = simulatePath(ctx, flat([0, 0.5, -0.5, 1.0, 0.2]), { trace: true }).yearRows!;

    const accrued = rows.map((r) => r.tithe!.accrued);
    expect(accrued).toEqual([0, 50000, 0, 0, 29000]);
    expect(rows.map((r) => r.balances.tithe)).toEqual([0, 50000, 25000, 50000, 89000]);
    // SOFT WINDOW: spendable includes the carve-out (the whole portfolio),
    // so the series is the TOTAL, not total-minus-pot as the hard carve
    // reported. The ex-pot arithmetic lives in balances.byAccount['ira'].
    expect(rows.map((r) => r.balances.spendable)).toEqual([
      1000000, 1500000, 750000, 1500000, 1800000,
    ]);
    expect(rows.map((r) => r.balances.byAccount['ira'])).toEqual([
      1000000, 1450000, 725000, 1450000, 1711000,
    ]);

    // The headline, stated on its own: 2029 doubled the portfolio and moved
    // not one dollar across, because it merely got back to where it had been.
    const recovery = rows[3];
    expect(recovery.balances.spendable / rows[2].balances.spendable).toBe(2);
    expect(recovery.tithe!.accrued).toBe(0);
    expect(recovery.expenses.charitable).toBe(0);

    // And the invariant behind it: the mark is monotone, so the bases
    // telescope. Everything ever transferred equals percent x the household's
    // cumulative real gain — never more, however violent the ride. Note this
    // is the sum of the GAINS (790,000), not the rise in the balance: the
    // 50,000 already handed over is a gift delivered, not growth undone, and
    // must not have to be re-earned before giving resumes.
    const totalAccrued = accrued.reduce((a, b) => a + b, 0);
    expect(totalAccrued).toBe(79000);
    const cumulativeGain = 0 + 500_000 - 725_000 + 725_000 + 290_000;
    expect(totalAccrued).toBeCloseTo(0.1 * cumulativeGain, 8);
  });

  it('tithes each year’s gain once, and never re-tithes a gain already given on', () => {
    // Two years of +10% on the nose, inflation 0.
    //   2026: gain 100,000; cum 100,000; base 100,000; move 10,000
    //         spendable 1,100,000 - 10,000 = 1,090,000; mark -> 100,000
    //   2027: gain 1,090,000 x 10% = 109,000; cum 209,000
    //         base = 209,000 - 100,000 = 109,000; move 10,900
    //
    // Each year's gain is tithed exactly once and no year's gain is revisited.
    // The 10,000 handed over in 2026 is NOT re-earned first: a gift delivered
    // is not growth undone, and making the household climb back over it before
    // giving again would tithe less than the rule promises.
    const ctx = prepareSim(simInput(hwmProfile(), { name: 'tithe-hwm-pre', events: [] }));
    const rows = simulatePath(ctx, flat([0.1, 0.1, 0, 0, 0]), { trace: true }).yearRows!;
    expect(rows[0].tithe!.accrued).toBeCloseTo(10000, 8);
    // The EX-POT balance carries the arithmetic (soft-window `spendable` now
    // includes the carve-out, so it is the total and proves nothing here).
    expect(rows[0].balances.byAccount['ira']).toBeCloseTo(1_090_000, 8);
    expect(rows[1].balances.byAccount['ira'] + rows[1].tithe!.accrued).toBeCloseTo(1_199_000, 8);
    expect(rows[1].tithe!.accrued).toBeCloseTo(10900, 8);
    // Together they are a tenth of the two years' gains and not a penny more.
    expect(rows[0].tithe!.accrued + rows[1].tithe!.accrued).toBeCloseTo(
      0.1 * (100_000 + 109_000),
      8,
    );
    // Flat years after that owe nothing: no gain, so no base.
    expect(rows[2].tithe!.accrued).toBe(0);
    expect(rows[3].tithe!.accrued).toBe(0);
  });

  it('never tithes the tithe: the carve-out’s own growth is outside the base', () => {
    // +10%, then flat. In 2027 the SPENDABLE side is flat, so the base is 0 —
    // even though the household's TOTAL balance still rose, because the
    // carve-out itself grew. Sizing the base off the total would have the plan
    // tithing its own gift, compounding forever.
    const ctx = prepareSim(simInput(hwmProfile(), { name: 'tithe-not-tithed', events: [] }));
    const rows = simulatePath(ctx, flat([0.1, 0.1, 0, 0, 0]), { trace: true }).yearRows!;
    const y2028 = rows[2]; // 0% year
    expect(y2028.returns.stocks).toBe(0);
    expect(y2028.balances.spendable).toBeCloseTo(rows[1].balances.spendable, 8);
    expect(y2028.tithe!.accrued).toBe(0);
    // The carve-out is not frozen — it is simply not part of the measurement.
    const grew = rows.map((r) => r.balances.tithe);
    expect(grew[1]).toBeGreaterThan(grew[0]);
  });

  it('a portfolio that only keeps up with inflation accrues nothing, ever', () => {
    /*
     * 0% real, 5% inflation: the balance rises 5% a year and buys exactly the
     * same basket forever. A mark kept in nominal dollars would ratchet up on
     * that alone and tithe money the household never gained. Nothing is owed
     * in any year, including the first.
     *
     * The first year used to be a documented exception — it transferred 5,000,
     * a tenth of the year's NOMINAL 50,000 — because the balance-based mark
     * was primed from a START-of-year balance while every later base compared
     * two END-of-year balances, a one-year deflator mismatch. Riding cumulative
     * real GAIN removes it at the root: the year's gain net of inflation on the
     * opening balance is 1,000,000 x 5% - 1,000,000 x 5% = exactly 0, with no
     * priming step to disagree with anything. The deviation is gone rather than
     * pinned, which is why this test now asserts 0 from the very first year.
     */
    const rows = runSimulation(
      simInput(
        titheProfile(
          { type: 'tithe_account', percent: 0.1, deferYears: 20, seedFromExistingGains: false },
          {
            accounts: [
              toyAccount({
                id: 'ira',
                type: 'traditional_ira',
                owner: 'p1',
                balance: 1_000_000,
                lifetimeContributions: 0,
                allocation: { stocks: 0, bonds: 0, bills: 1 },
              }),
            ],
            horizonAge: 61, // 2026..2032
          },
        ),
        {
          name: 'tithe-flat-real',
          events: [],
          assumption_overrides: {
            market: {
              deterministicReal: { stocks: 0, bonds: 0, bills: 0 },
              deterministicInflation: 0.05,
            },
          },
        },
      ),
    ).referencePath;

    expect(rows[0].tithe!.accrued).toBeCloseTo(0, 6); // no exception any more
    for (const row of rows.slice(1)) {
      expect(row.tithe!.accrued).toBeCloseTo(0, 6);
      // Purchasing power never moves, so the mark is never beaten.
      // 1,050,000, not 1,045,000: nothing is transferred out any more, so the
      // spendable side keeps the whole (constant, real) balance.
      expect(row.balances.spendableReal).toBeCloseTo(1_050_000, 6);
      // ...while the nominal balance climbs every single year.
      expect(row.balances.spendable).toBeGreaterThan(rows[0].balances.spendable);
    }
  });
});

describe('the Tithe Account: how the carve-out is invested (note 21)', () => {
  // Every rule below carries earlyRelease: false: with nothing spent, this
  // fixture sets a new real high every year, and the default release would
  // lock the account and start draining it through the pot distribution —
  // the growth-rate arithmetic here needs the balance moved only by returns
  // and accruals.
  const oneIra = (rule: TitheRule): Profile =>
    titheProfile(rule, {
      accounts: [
        toyAccount({
          id: 'ira',
          type: 'traditional_ira',
          owner: 'p1',
          balance: 1_000_000,
          lifetimeContributions: 0,
          allocation: { stocks: 0, bonds: 0, bills: 1 }, // parent: 3.0125% nominal
        }),
      ],
      horizonAge: 59, // 2026..2030
    });
  /** 100% stocks nominal: (1 + 0.065)(1 + 0.025) - 1 - the 0.0003 expense ratio. */
  const STOCKS_NOM = (1 + 0.065) * 1.025 - 1 - 0.0003;
  /** The carve-out's own return for a year, net of what was transferred in. */
  const growthRate = (prev: YearRow, now: YearRow) =>
    (now.balances.tithe - now.tithe!.accrued) / prev.balances.tithe - 1;

  it('takes the parent’s mix by default', () => {
    const rows = runSimulation(
      simInput(
        oneIra({
          type: 'tithe_account',
          percent: 0.1,
          deferYears: 30,
          seedFromExistingGains: true,
          earlyRelease: false,
        }),
        { name: 'tithe-mix-parent', events: [] },
      ),
    ).referencePath;
    for (let yi = 1; yi < rows.length; yi++) {
      expect(growthRate(rows[yi - 1], rows[yi])).toBeCloseTo(BILLS_NOM, 12);
    }
  });

  it('takes the rule’s own mix when it names one — the gift can be invested differently', () => {
    // A longer horizon than the money that has to fund a retirement argues for
    // more equity in the carve-out; the rule sets the STARTING mix and the
    // parent keeps its own.
    const rows = runSimulation(
      simInput(
        oneIra({
          type: 'tithe_account',
          percent: 0.1,
          deferYears: 30,
          seedFromExistingGains: true,
          earlyRelease: false,
          allocation: { stocks: 1, bonds: 0, bills: 0 },
        }),
        { name: 'tithe-mix-own', events: [] },
      ),
    ).referencePath;
    for (let yi = 1; yi < rows.length; yi++) {
      expect(growthRate(rows[yi - 1], rows[yi])).toBeCloseTo(STOCKS_NOM, 12);
      // The parent is still on bills — only the carve-out moved.
      const parent = rows[yi].balances.byAccount['ira'];
      const parentBefore = rows[yi - 1].balances.byAccount['ira'];
      expect((parent + rows[yi].tithe!.accrued) / parentBefore - 1).toBeCloseTo(BILLS_NOM, 12);
    }
  });

  it('follows an allocation event aimed at the parent IRA', () => {
    // A targeted instruction names an account the user actually HOLDS, so it
    // reaches the carve-out too — exactly as it reaches a 72(t) carve-out. If
    // it did not, a glidepath would leave the tithe on a stale mix and feed a
    // wrong growth number back into the accrual that measures it.
    const rows = runSimulation(
      simInput(
        oneIra({
          type: 'tithe_account',
          percent: 0.1,
          deferYears: 30,
          seedFromExistingGains: true,
          earlyRelease: false,
        }),
        {
          name: 'tithe-mix-event',
          events: [
            { type: 'allocation_change', date: '2028-01', account: 'ira', mix: { stocks: 1, bonds: 0, bills: 0 } },
          ],
        },
      ),
    ).referencePath;
    expect(growthRate(rows[0], rows[1])).toBeCloseTo(BILLS_NOM, 12); // 2027, before
    expect(growthRate(rows[1], rows[2])).toBeCloseTo(STOCKS_NOM, 12); // 2028, after
    expect(growthRate(rows[2], rows[3])).toBeCloseTo(STOCKS_NOM, 12);
  });
});

describe('the Tithe Account: the defer window gives no cash (note 21)', () => {
  /**
   * 800,000 IRA (300,000 contributed, 100% stocks) + 400,000 of savings, a
   * 100,000 salary for p1 ending 2028-07, 40,000/yr of living costs and a
   * 500/mo paycheck giving stream. deferYears 3, so:
   *   2026-2027  working      — the paycheck stream, untouched
   *   2028       retirement   — prorated, the rule's own figure still 0
   *   2029-2031  DEFER        — cash giving exactly 0, the carve-out grows
   *   2032+      LOCK + DISBURSE — transfers stop; the pot starts paying out
   *              (2032, its first instalment) and the growth stream follows
   *              (2033, the first base no accrual touched)
   * `autoSepp: false` keeps the bridge machinery out of the picture; savings
   * covers the whole cash need, so no pre-59 1/2 penalty muddies the numbers.
   * `earlyRelease: false`, because the stocks-heavy IRA outruns the spending
   * and would otherwise release the window after one good year — the fixed
   * 2029-2031 window is what these expectations are written against.
   */
  const deferRun = () =>
    runSimulation(
      simInput(
        titheProfile(
          {
            type: 'tithe_account',
            percent: 0.1,
            deferYears: 3,
            seedFromExistingGains: true,
            earlyRelease: false,
          },
          {
            accounts: [
              toyAccount({
                id: 'savings',
                type: 'savings',
                owner: 'p1',
                balance: 400_000,
                allocation: { stocks: 0, bonds: 0, bills: 1 },
              }),
              toyAccount({
                id: 'ira',
                type: 'traditional_ira',
                owner: 'p1',
                balance: 800_000,
                lifetimeContributions: 300_000,
                allocation: { stocks: 1, bonds: 0, bills: 0 },
              }),
            ],
            annualLiving: 40_000,
            charitableMonthly: 500,
            income: { salaries: { p1: 100_000, p2: 0 }, contribution401k: 0, employerMatch401k: 0 },
            horizonAge: 64, // 2026..2035
          },
        ),
        {
          name: 'tithe-defer',
          autoSepp: false,
          events: [{ type: 'retire', person: 'p1', date: '2028-07' }],
        },
      ),
    );

  it('runs the paycheck stream to the last salary, then gives exactly 0 while the balance grows', () => {
    const rows = deferRun().referencePath;
    const y = (year: number) => rows.find((r) => r.year === year)!;

    // Working years: the rule has not started, so nothing about them changed.
    expect(y(2026).expenses.charitable).toBeCloseTo(6000, 8);
    expect(y(2027).expenses.charitable).toBeCloseTo(6150, 8);
    expect(y(2026).tithe).toBeUndefined();
    expect(y(2027).tithe).toBeUndefined();

    // The retirement year is prorated exactly like every other non-'continue'
    // rule: six months of paycheck giving, six months of a rule that is not
    // giving yet. The carve-out does NOT open in a part-worked year.
    expect(y(2028).expenses.charitable).toBeCloseTo(6000 * 1.025 ** 2 * 0.5, 8);
    expect(y(2028).tithe).toBeUndefined();
    expect(y(2028).flags).toContain('giving-rule');

    // 2029 is the first year nobody earned: the carve-out opens and the cash
    // stops dead. NOT "nearly zero" — zero.
    const seeded = y(2029).tithe!.seeded;
    expect(seeded).toBeCloseTo(0.1 * (y(2028).balances.byAccount['ira'] - 300_000), 6);
    expect(seeded).toBeGreaterThan(70_000);
    for (const year of [2029, 2030, 2031]) {
      expect(y(year).expenses.charitable).toBe(0);
      expect(y(year).tithe!.given).toBe(0);
      expect(y(year).tithe!.accrued).toBeGreaterThan(0); // ...and it is accumulating
      expect(y(year).flags).toContain('giving-rule');
      // The trace names the window rather than leaving a silent zero. "up
      // to": the label must not promise a wait the safe-zone release (off in
      // this fixture, on by default) would not keep.
      const deferLine = y(year).taxes.trace!.find((t) => t.label.startsWith('Deferred — retired year'))!;
      expect(deferLine.label).toBe(`Deferred — retired year ${year - 2028} of up to 3`);
      expect(deferLine.amount).toBe(0);
    }
    // The balance climbs through the whole window.
    expect(titheOf(y(2030))).toBeGreaterThan(titheOf(y(2029)));
    expect(titheOf(y(2031))).toBeGreaterThan(titheOf(y(2030)));

    // Giving is a real expense line, so a year that gives nothing spends less:
    // the defer years' expenses.total is exactly baseline + housing + health.
    for (const year of [2029, 2030, 2031]) {
      const row = y(year);
      expect(row.expenses.total).toBeCloseTo(
        row.expenses.baseline + row.expenses.housing + row.expenses.health + row.expenses.oneTime,
        8,
      );
    }
  });

  it('counts the window from the first FULLY retired year, not from the retire event', () => {
    // p1 stops in July 2028, but 2028 is a part-worked year: the window is
    // 2029-2031 — one year later than counting from the event would give. The
    // origin is "the first year nobody earned".
    //
    // UPDATED WITH THE POT DISTRIBUTION: cash now starts in 2032, the lock
    // year, because the POT's first instalment pays there — cash giving
    // genuinely begins when the deferral ends. The GROWTH stream still waits
    // for 2033: 2032 would price itself off 2031's growth, and 2031 is the
    // last accrual year — that growth is already inside the carve-out, and
    // paying cash on it would tithe the same dollars twice. So the first
    // growth-stream gift reads 2032's growth, the first no transfer claimed.
    const rows = deferRun().referencePath;
    const firstCash = rows.find((r) => r.year >= 2029 && r.expenses.charitable > 0)!;
    expect(firstCash.year).toBe(2032);
    expect(firstCash.tithe!.distributed).toBeGreaterThan(0);
    expect(firstCash.tithe!.given).toBe(0); // the growth stream is not speaking yet
    expect(firstCash.eventsFired).toContain('tithe-locked');
    expect(firstCash.eventsFired).not.toContain('tithe-early-release'); // the calendar closed it
    const firstGrowthCash = rows.find((r) => (r.tithe?.given ?? 0) > 0)!;
    expect(firstGrowthCash.year).toBe(2033);
  });
});

describe('the Tithe Account: disbursement after the defer window (note 21)', () => {
  it('stops transferring in and starts giving percent of the prior year’s high-water base', () => {
    // earlyRelease: false pins the window at 2029-2031 (see the defer
    // describe above for why this fixture would otherwise release early).
    const rows = runSimulation(
      simInput(
        titheProfile(
          {
            type: 'tithe_account',
            percent: 0.1,
            deferYears: 3,
            seedFromExistingGains: true,
            earlyRelease: false,
          },
          {
            accounts: [
              toyAccount({
                id: 'savings',
                type: 'savings',
                owner: 'p1',
                balance: 400_000,
                allocation: { stocks: 0, bonds: 0, bills: 1 },
              }),
              toyAccount({
                id: 'ira',
                type: 'traditional_ira',
                owner: 'p1',
                balance: 800_000,
                lifetimeContributions: 300_000,
                allocation: { stocks: 1, bonds: 0, bills: 0 },
              }),
            ],
            annualLiving: 40_000,
            charitableMonthly: 500,
            income: { salaries: { p1: 100_000, p2: 0 }, contribution401k: 0, employerMatch401k: 0 },
            horizonAge: 64,
          },
        ),
        {
          name: 'tithe-disburse',
          autoSepp: false,
          events: [{ type: 'retire', person: 'p1', date: '2028-07' }],
        },
      ),
    ).referencePath;
    // 2032 is the LOCK year: the growth stream gives nothing (its base would
    // be 2031's growth, which the last accrual year already moved into the
    // carve-out) but the POT's first instalment pays — a tenth of the escrow,
    // under the default 10-year schedule.
    const lockYear = rows.find((r) => r.year === 2032)!;
    expect(lockYear.tithe!.locked).toBe(true);
    expect(lockYear.tithe!.given).toBe(0);
    expect(lockYear.tithe!.distributed).toBeGreaterThan(0);
    expect(lockYear.expenses.charitable).toBeCloseTo(lockYear.tithe!.distributed, 8);
    const disbursing = rows.filter((r) => r.year >= 2033);
    expect(disbursing).toHaveLength(3); // 2033..2035

    for (const row of disbursing) {
      // The carve-out is LOCKED: nothing more goes in, ever.
      expect(row.tithe!.accrued).toBe(0);
      expect(row.tithe!.locked).toBe(true);
      // ...and the year's gift is the growth stream PLUS the pot instalment.
      expect(row.tithe!.given).toBeGreaterThan(0);
      expect(row.tithe!.distributed).toBeGreaterThan(0);
      expect(row.expenses.charitable).toBeCloseTo(row.tithe!.given + row.tithe!.distributed, 8);
      // Cross-check against the audit trace: the base it reports (already
      // re-inflated to this year's dollars) times the percentage IS the
      // growth stream's own gift.
      const base = row.taxes.trace!.find((t) => t.label.startsWith('Base —'))!;
      expect(base.label).toBe(`Base — ${row.year - 1} growth above the portfolio's previous real high`);
      expect(row.tithe!.given).toBeCloseTo(0.1 * base.amount!, 6);
      // Cash giving is an expense like any other and lands in the total.
      expect(row.expenses.total).toBeCloseTo(
        row.expenses.baseline +
          row.expenses.charitable +
          row.expenses.housing +
          row.expenses.health +
          row.expenses.oneTime,
        8,
      );
    }
    // CHANGED WITH THE POT DISTRIBUTION: the escrow no longer sits until
    // death — each instalment (balance / years-remaining, ~10-11% here)
    // outruns the market growth, so the balance FALLS while it disburses.
    // That decline is the design: the pot reaching charity in life, not at
    // the horizon.
    expect(titheOf(rows[rows.length - 1])).toBeLessThan(titheOf(rows[rows.length - 2]));
  });

  it('still feeds the charitable deduction once the cash starts', () => {
    /*
     * A giving rule that produced an untaxed gift would be a silent modelling
     * hole. Same shape as the note-18 deduction test, so the two are directly
     * comparable: 5,000,000 of savings, no salary, and 100,000 of taxable
     * one-time income in 2027 to lift the household clear of the standard
     * deduction. seedFromExistingGains false with deferYears 0 means no
     * carve-out is opened at all — this is purely the cash side of the rule.
     *
     * 2026 gives 0 in BOTH runs (no completed year under the rule), so the
     * 2027 start balance, its interest and therefore its AGI are identical and
     * the deduction is the only moving part. The 2027 gift is well above the
     * 2,000 MFJ non-itemizer cap, so taxable income falls by exactly 2,000.
     */
    const build = (rule: Profile['expenses']['retirementGiving']): Profile => {
      const p = toyProfile({
        accounts: [
          toyAccount({
            id: 'savings',
            type: 'savings',
            owner: 'p1',
            balance: 5_000_000,
            allocation: { stocks: 0, bonds: 0, bills: 1 },
          }),
        ],
        annualLiving: 30_000,
        horizonAge: 57, // 2026..2028
      });
      p.expenses.retirementGiving = rule;
      return p;
    };
    const events: Scenario['events'] = [
      { type: 'one_time_income', date: '2027-01', amount: 100_000, taxable: true },
    ];
    const giving = runSimulation(
      simInput(
        build({ type: 'tithe_account', percent: 0.1, deferYears: 0, seedFromExistingGains: false }),
        { name: 'tithe-deduction', events },
      ),
    ).referencePath;
    const none = runSimulation(
      simInput(build({ type: 'none' }), { name: 'tithe-deduction-none', events }),
    ).referencePath;

    expect(giving[0].expenses.charitable).toBe(0);
    expect(giving[1].expenses.charitable).toBeGreaterThan(2000);
    expect(none[1].expenses.charitable).toBe(0);

    expect(giving[1].taxes.federal.agi).toBeCloseTo(none[1].taxes.federal.agi, 6);
    expect(
      none[1].taxes.federal.taxableIncome - giving[1].taxes.federal.taxableIncome,
    ).toBeCloseTo(2000, 6);
    expect(giving[1].taxes.federal.total).toBeLessThan(none[1].taxes.federal.total);
  });

  it('deferYears 0 gives from the first retired year — on the year’s new high, not the whole portfolio', () => {
    /*
     * REGRESSION. With no seed and no defer window there is no carve-out at
     * all, and the first year must still not read the household's entire net
     * worth as one year of growth and prescribe a tenth of everything owned.
     * Riding cumulative GAIN makes that structurally impossible — a balance the
     * household already had was never a gain — but the case is pinned anyway,
     * because it is the shape of the bug and cheap to keep watching.
     *
     * IRA 1,000,000 + savings 200,000, all bills, no spending. Savings interest
     * is distributed rather than compounded, so it reaches the gain as cash:
     *   2026 gives 0 (no completed year to look back at)
     *        gain 200,000 x 0.030125 + 1,000,000 x 0.030125  =  36,150
     *        inflation 1,200,000 x 0.025                     = -30,000
     *        real gain -> base                               =   6,150
     *   2027 gives 10% x 6,150 x 1.025 = 630.375       <- not 123,615
     */
    const rows = runSimulation(
      simInput(
        titheProfile(
          { type: 'tithe_account', percent: 0.1, deferYears: 0, seedFromExistingGains: false },
          {
            accounts: [
              toyAccount({
                id: 'ira',
                type: 'traditional_ira',
                owner: 'p1',
                balance: 1_000_000,
                lifetimeContributions: 400_000,
                allocation: { stocks: 0, bonds: 0, bills: 1 },
              }),
              toyAccount({
                id: 'savings',
                type: 'savings',
                owner: 'p1',
                balance: 200_000,
                allocation: { stocks: 0, bonds: 0, bills: 1 },
              }),
            ],
            horizonAge: 62,
          },
        ),
        { name: 'tithe-nodefer', events: [] },
      ),
    ).referencePath;

    // No seed and no window asked for: no account is created.
    expect(rows.every((r) => r.tithe === undefined)).toBe(true);
    expect(rows.every((r) => r.balances.tithe === 0)).toBe(true);

    expect(rows[0].expenses.charitable).toBe(0);
    expect(rows[1].expenses.charitable).toBeCloseTo(630.375, 6);
    // The shape of the bug this pins: a tenth of net worth would be ~123,615.
    expect(rows[1].expenses.charitable).toBeLessThan(0.01 * rows[0].balances.total);
    // And every later year gives on a genuine new high, so the figures stay in
    // the same order of magnitude instead of the portfolio being given away.
    for (const row of rows.slice(2)) {
      expect(row.expenses.charitable).toBeLessThan(0.01 * row.balances.total);
    }
  });
});

describe('the Tithe Account: the contribution history keeps up (note 21)', () => {
  /*
   * A household still working goes on contributing between today and the day it
   * retires, and the seed is taken as balance MINUS what was contributed. If
   * the history never advances, every one of those deferrals lands in the
   * untithed bucket and the household is asked to give on paychecks it already
   * gave on — a second tithe on the same gross pay, which is the one thing
   * "tithe the gross, once" forbids.
   *
   * The employer match is the deliberate other half: it never appeared in
   * anyone's gross, so it never passed under a tithe, and leaving it OUT of the
   * history is what correctly leaves it IN the untithed base.
   *
   * Allocations are all-bills with the market pinned flat below, so the only
   * thing that can move a balance is a contribution — which makes the expected
   * seed exact arithmetic rather than an approximation.
   */
  const DEFERRAL = 20_000;
  const MATCH = 10_000;

  const contribRun = () =>
    runSimulation(
      simInput(
        titheProfile(
          { type: 'tithe_account', percent: 0.1, deferYears: 1, seedFromExistingGains: true },
          {
            accounts: [
              toyAccount({
                id: 'k401',
                name: '401(k)',
                type: '401k',
                owner: 'p1',
                balance: 500_000,
                // Fully accounted for: nothing untithed on day one, so every
                // dollar of untithed base the seed finds was created in-sim.
                lifetimeContributions: 500_000,
                currentEmployer: true,
                allocation: { stocks: 0, bonds: 0, bills: 1 },
              }),
              toyAccount({
                id: 'cash',
                type: 'savings',
                owner: 'p1',
                balance: 400_000,
                allocation: { stocks: 0, bonds: 0, bills: 1 },
              }),
            ],
            annualLiving: 20_000,
            income: {
              salaries: { p1: 200_000, p2: 0 },
              contribution401k: DEFERRAL,
              employerMatch401k: MATCH,
            },
            horizonAge: 64,
          },
        ),
        {
          name: 'tithe-contrib',
          autoSepp: false,
          // Retires 1 Jan 2030 — four whole contributing years, 2026-2029.
          events: [{ type: 'retire', person: 'p1', date: '2030-01' }],
          assumption_overrides: {
            market: {
              deterministicReal: { stocks: 0, bonds: 0, bills: 0 },
              deterministicInflation: 0,
            },
          },
        },
      ),
    ).referencePath;

  it('counts in-sim employer match as untithed, and in-sim deferrals as already tithed', () => {
    const rows = contribRun();
    const seedRow = rows.find((r) => r.eventsFired.includes('tithe-seeded'))!;
    expect(seedRow).toBeDefined();
    // Four contributing years of match, and NOT a dollar of the deferrals.
    // Were the history left stale, the base would be 4 x (20,000 + 10,000) and
    // the seed 12,000 — three times too much, all of it a second tithe.
    expect(seedRow.tithe!.seeded).toBeCloseTo(0.1 * 4 * MATCH, 6);
    expect(rows.some((r) => r.flags.includes('tithe-basis-missing'))).toBe(false);
  });
});

describe('the Tithe Account: no year of growth is tithed twice (note 21)', () => {
  /*
   * The handover between the two phases is the one place "tithe the gross,
   * once" can quietly break, and it did: the accrual consumes THIS year's base
   * (it is an internal transfer, so nothing about it is circular) while cash
   * giving can only consume a COMPLETED year's base like every other percentage
   * rule. Run the two windows adjacent and they overlap by exactly one year —
   * the last accrual year's growth is moved into the carve-out AND then given
   * away as cash, tithing the same dollars twice.
   *
   * It is invisible in a total: both phases are supposed to give, so the year
   * looks busy rather than wrong. What identifies it is the SOURCE year each
   * phase draws on, which is why these tests assert on indices rather than
   * amounts.
   */
  const boundaryRun = (deferYears: number) =>
    runSimulation(
      simInput(
        titheProfile(
          { type: 'tithe_account', percent: 0.1, deferYears, seedFromExistingGains: true },
          {
            charitableMonthly: 500,
            income: { salaries: { p1: 100_000, p2: 0 }, contribution401k: 0, employerMatch401k: 0 },
            horizonAge: 70,
          },
        ),
        {
          name: 'tithe-boundary',
          autoSepp: false,
          events: [{ type: 'retire', person: 'p1', date: '2028-07' }],
        },
      ),
    ).referencePath;

  /** The year whose growth a cash gift was computed from, read off the trace. */
  const baseYearOf = (row: (typeof boundaryRun extends never ? never : ReturnType<typeof boundaryRun>)[number]) => {
    const line = row.taxes.trace?.find((t) => t.label.startsWith('Base —'));
    if (!line) return null;
    const m = /Base — (\d{4})/.exec(line.label);
    return m ? Number(m[1]) : null;
  };

  for (const deferYears of [1, 2, 3, 5]) {
    it(`draws accrual and cash from disjoint years (deferYears ${deferYears})`, () => {
      const rows = boundaryRun(deferYears);
      // Years the carve-out actually took a transfer in.
      const accrualYears = rows.filter((r) => (r.tithe?.accrued ?? 0) > 0).map((r) => r.year);
      // Years a cash gift was paid, and the year each one priced itself off.
      const cashSourceYears = rows
        .filter((r) => r.expenses.charitable > 0 && (r.tithe?.given ?? 0) > 0)
        .map((r) => baseYearOf(r))
        .filter((y): y is number => y !== null);

      expect(cashSourceYears.length).toBeGreaterThan(0);
      // THE INVARIANT: no year of growth funds both a transfer and a gift.
      const overlap = cashSourceYears.filter((y) => accrualYears.includes(y));
      expect(overlap).toEqual([]);
      // And the two windows are strictly ordered — cash never reaches back
      // behind the accrual window either.
      if (accrualYears.length > 0) {
        expect(Math.min(...cashSourceYears)).toBeGreaterThan(Math.max(...accrualYears));
      }
    });
  }

  it('never lets a base year go to two places even when the windows abut', () => {
    // deferYears 2 with retirement mid-2028: window 2029-2030, so 2030's growth
    // is the last one accrued. 2031 would have been the first cash year under
    // the off-by-one, pricing itself off 2030 — the exact collision.
    //
    // The filter reads tithe.given, NOT expenses.charitable: since the pot
    // distribution the lock year itself pays cash (an instalment of the
    // escrow, priced off no base year at all), and only the GROWTH stream
    // reads the base series this invariant protects.
    const rows = boundaryRun(2);
    const lastAccrual = Math.max(...rows.filter((r) => (r.tithe?.accrued ?? 0) > 0).map((r) => r.year));
    const firstCash = rows.find((r) => (r.tithe?.given ?? 0) > 0 && r.year > 2028)!;
    expect(baseYearOf(firstCash)).toBe(lastAccrual + 1);
  });
});

describe('the Tithe Account: what the audit trace says (note 21)', () => {
  const labelRun = (deferYears: number) =>
    runSimulation(
      simInput(
        titheProfile(
          // earlyRelease: false — the bare fixture sets a new real high every
          // year and would otherwise lock after year one; the labels under
          // test narrate a full window.
          {
            type: 'tithe_account',
            percent: 0.1,
            deferYears,
            seedFromExistingGains: deferYears > 0,
            earlyRelease: false,
          },
          {
            accounts: [
              toyAccount({
                id: 'ira',
                type: 'traditional_ira',
                owner: 'p1',
                balance: 1_000_000,
                lifetimeContributions: 400_000,
                allocation: { stocks: 0, bonds: 0, bills: 1 },
              }),
            ],
            horizonAge: 60, // 2026..2031
          },
        ),
        { name: `tithe-label-${deferYears}`, events: [] },
      ),
    ).referencePath;

  it('names the rule, its window and its unit in the owner’s own terms', () => {
    // The trace is what the cashflow table points the user at when it says a
    // year's giving came from the rule, so the sentence has to stand alone.
    // "up to": the safe-zone release can close the window early, and the label
    // must not promise a wait the engine will not keep.
    const head = (rows: YearRow[]) =>
      rows[1].taxes.trace!.find((t) => t.label.startsWith('Charitable giving'))!.label;
    expect(head(labelRun(3))).toBe(
      'Charitable giving — retirement rule: 10.00% of new real portfolio highs into a tithe ' +
        'account, held for up to the first 3 retired years (a last resort meanwhile), then ' +
        'locked and given in cash — the pot over 10 years, plus the growth stream',
    );
    // Singular for a one-year window — the sentence is read, not parsed.
    expect(head(labelRun(1))).toContain(
      'held for up to the first 1 retired year (a last resort meanwhile)',
    );
    // No window at all: the escrow starts on retirement day.
    expect(head(labelRun(0))).toBe(
      'Charitable giving — retirement rule: 10.00% of new real portfolio highs into a tithe ' +
        'account, locked at retirement and given in cash — the pot over 10 years, plus the ' +
        'growth stream',
    );
  });

  it('says whether a year moved money in, and stops claiming to once the account locks', () => {
    const rows = labelRun(3);
    const transferLine = (row: YearRow) =>
      row.taxes.trace!.find((t) => t.label.startsWith('Tithe Account — transferred in'));
    const lockedLine = (row: YearRow) =>
      row.taxes.trace!.find((t) => t.label === 'Tithe Account — locked: no further transfers in');

    // 2026-2028: the window. The line reports the amount AND the balance, so a
    // year that moved nothing (a portfolio below its old high) is still
    // visibly a deliberate zero rather than a missing line.
    for (const row of rows.slice(0, 3)) {
      expect(transferLine(row)).toBeDefined();
      expect(transferLine(row)!.amount).toBeCloseTo(row.tithe!.accrued, 8);
      expect(lockedLine(row)).toBeUndefined();
    }
    // 2029 onwards: locked, and it says so rather than reporting a 0 transfer.
    for (const row of rows.slice(3)) {
      expect(lockedLine(row)).toBeDefined();
      expect(lockedLine(row)!.amount).toBe(0);
      expect(transferLine(row)).toBeUndefined();
    }
    // The lock year itself announces the state change and the pot's payout.
    const lockYear = rows[3];
    expect(lockYear.eventsFired).toContain('tithe-locked');
    expect(
      lockYear.taxes.trace!.some((t) => t.label === 'Tithe Account — locked: distribution starts'),
    ).toBe(true);
    expect(
      lockYear.taxes.trace!.some((t) =>
        t.label.startsWith('Tithe Account — pot distribution 1 of 10'),
      ),
    ).toBe(true);
  });
});

describe('the Tithe Account through the soft window and the lock (note 21)', () => {
  /**
   * A household with 100,000 of savings and a 500,000 IRA (100,000
   * contributed, all bills) against 26,000/yr of living costs, run to age 74.
   * Sized deliberately at the edge: under the OLD hard carve this exact plan
   * ran out in 2045 holding a five-figure carve-out it was forbidden to touch
   * — the drag landed on the fragile years the deferral was designed to
   * protect. Under the soft window the pot is the last money touched, and the
   * same plan survives on it. Both behaviours are pinned below, each where it
   * now belongs: the rescue during the soft window, the refusal after the
   * lock.
   */
  const edgeProfile = (rule: Profile['expenses']['retirementGiving']): Profile => {
    const p = toyProfile({
      accounts: [
        toyAccount({
          id: 'savings',
          type: 'savings',
          owner: 'p1',
          balance: 100_000,
          allocation: { stocks: 0, bonds: 0, bills: 1 },
        }),
        toyAccount({
          id: 'ira',
          type: 'traditional_ira',
          owner: 'p1',
          balance: 500_000,
          lifetimeContributions: 100_000,
          allocation: { stocks: 0, bonds: 0, bills: 1 },
        }),
      ],
      annualLiving: 26_000,
      horizonAge: 74, // 2026..2045, one year short of the first RMD
    });
    p.expenses.retirementGiving = rule;
    return p;
  };
  const titheRule: TitheRule = {
    type: 'tithe_account',
    percent: 0.1,
    deferYears: 30,
    seedFromExistingGains: true,
  };

  it('a plan that failed under the hard lock now survives on the pot, and the draw shrinks it', () => {
    /*
     * THE HEADLINE OF THE REDESIGN. deferYears 30 outlives the horizon and
     * the declining real balance never trips the release, so the whole run is
     * one long soft window: the pot counts, and when savings and the IRA
     * remainder run dry the ordering reaches it — LAST. The plan that
     * previously scored 0 while holding a $40k+ escrow now survives to the
     * horizon, which is precisely "the promise absorbs the emergency".
     */
    const withTithe = runSimulation(
      simInput(edgeProfile(titheRule), { name: 'tithe-edge', events: [] }),
    );
    const control = runSimulation(
      simInput(edgeProfile({ type: 'none' }), { name: 'tithe-edge-control', events: [] }),
    );
    const rows = withTithe.referencePath;

    // The control — the same household with the same (zero) cash giving, but
    // no promise — makes it to the horizon...
    expect(control.success).toBe(1);
    // ...and now so does the promising household: the pot was reachable.
    expect(withTithe.success).toBe(1);
    expect(rows.some((r) => r.flags.includes('insolvent'))).toBe(false);
    expect(withTithe.breakGlassReal).toBeNull(); // no failing year, no figure

    // The rescue is real and visible: the ordering drew the carve-out, the
    // year is flagged, and the draw shrank the pot for good (the balance
    // would otherwise only compound upward on all-bills returns).
    const drawYears = rows.filter((r) => (r.tithe?.drawn ?? 0) > 0);
    expect(drawYears.length).toBeGreaterThan(0);
    for (const row of drawYears) {
      expect(row.flags).toContain('tithe-drawn');
      expect(row.tithe!.locked).toBe(false);
      expect(row.withdrawals.byAccount['ira-tithe']).toBeCloseTo(row.tithe!.drawn, 8);
    }
    const firstDraw = drawYears[0];
    const before = rows[rows.indexOf(firstDraw) - 1];
    expect(firstDraw.balances.tithe).toBeLessThan(before.balances.tithe);

    // Soft-window accounting: the pot counts in spendable every year.
    for (const row of rows) {
      expect(row.balances.spendable).toBeCloseTo(row.balances.total, 8);
    }
  });

  it('draws the pot only when every other bucket is dry — a promise is the last money touched', () => {
    const rows = runSimulation(
      simInput(edgeProfile(titheRule), { name: 'tithe-draw-order', events: [] }),
    ).referencePath;
    const drawYears = rows.filter((r) => (r.tithe?.drawn ?? 0) > 0);
    expect(drawYears.length).toBeGreaterThan(0);
    for (const row of drawYears) {
      // In any year the pot was touched, every OTHER account the ordering can
      // reach ended the year empty — cash, taxable, pretax and Roth alike.
      // (Growth is applied after withdrawals, but 0 grows to exactly 0.)
      for (const [id, balance] of Object.entries(row.balances.byAccount)) {
        if (id === row.tithe!.accountId) continue;
        expect(balance, `${id} still held money in a year the pot was drawn`).toBeCloseTo(0, 6);
      }
    }
    // And in every earlier year with money elsewhere, the pot went untouched.
    const firstDrawYear = drawYears[0].year;
    for (const row of rows.filter((r) => r.year < firstDrawYear)) {
      expect(row.tithe?.drawn ?? 0).toBe(0);
    }
  });

  it('a path that fails even after exhausting the pot reports break glass of ~0', () => {
    /*
     * Spending far beyond what the whole portfolio (pot included) can carry:
     * the ordering drains everything, the pot last, and the plan still falls
     * short. The break-glass figure keeps its meaning — "what sat in the
     * account when the path first fell short" — and the answer is now ~0,
     * because the soft window already spent the reserve before failing. A
     * plan cannot fail during the soft window while holding tithe money.
     */
    const p = edgeProfile(titheRule);
    p.expenses.livingMonthly = 5_000; // 60,000/yr against ~600,000 all-bills
    const result = runSimulation(simInput(p, { name: 'tithe-edge-exhausted', events: [] }));
    const rows = result.referencePath;
    expect(result.success).toBe(0);
    const failed = rows.find((r) => r.flags.includes('insolvent'))!;
    expect(failed.tithe!.locked).toBe(false);
    expect(failed.balances.tithe).toBeCloseTo(0, 6);
    expect(result.breakGlassReal).not.toBeNull();
    expect(result.breakGlassReal!).toBeCloseTo(0, 6);
  });

  it('locks at distribution start: no draws after, and a post-lock failure leaves the escrow standing', () => {
    /*
     * deferYears 0 locks the carve-out on retirement day — the old hard-carve
     * behaviour, now the LOCKED phase — and distributeYears 30 stretches the
     * payout past the failure so there is a live escrow to refuse. Spending
     * sized so the plan fails mid-payout: the engine must let it fail holding
     * the pot, because locked money is charity's, not the household's.
     */
    const rule: TitheRule = {
      type: 'tithe_account',
      percent: 0.1,
      deferYears: 0,
      seedFromExistingGains: true,
      distributeYears: 30,
    };
    const p = edgeProfile(rule);
    p.expenses.livingMonthly = 3_000; // 36,000/yr: fails inside the 30-year payout window
    const result = runSimulation(simInput(p, { name: 'tithe-locked-fail', events: [] }));
    const rows = result.referencePath;

    expect(result.success).toBe(0);
    const failed = rows.find((r) => r.flags.includes('insolvent'))!;
    expect(failed.tithe!.locked).toBe(true);

    // The ONLY dollars that ever leave the locked carve-out are its scheduled
    // instalments (given away, not spent) — never an on-demand draw, even in
    // the year the plan fell short. RMDs cannot occur (horizon stops at 74).
    for (const row of rows) {
      expect(row.tithe!.drawn).toBe(0);
      expect(row.withdrawals.byAccount['ira-tithe'] ?? 0).toBeCloseTo(
        row.tithe!.distributed + row.tithe!.forcedDistributionGiven,
        8,
      );
    }

    // The escrow stands in the failing year, excluded from spendable, and the
    // break-glass figure reports exactly what refusing to break it cost.
    expect(failed.balances.tithe).toBeGreaterThan(0);
    expect(failed.balances.spendable).toBeCloseTo(
      failed.balances.total - failed.balances.tithe,
      6,
    );
    expect(result.breakGlassReal).not.toBeNull();
    expect(result.breakGlassReal!).toBeCloseTo(failed.balances.tithe / failed.inflationIndex, 6);
  });

  it('is out of the fan, the terminal value and the success rate — but still on the balance sheet', () => {
    const result = runSimulation(
      simInput(
        titheProfile({ type: 'tithe_account', percent: 0.1, deferYears: 3, seedFromExistingGains: true }),
        { name: 'tithe-metrics', events: [] },
      ),
    );
    const last = result.referencePath[result.referencePath.length - 1];

    // The carve-out is real money the household owns: `total` counts it.
    expect(last.balances.total).toBeCloseTo(last.balances.spendable + last.balances.tithe, 8);
    expect(last.balances.tithe).toBeGreaterThan(0);
    expect(last.balances.totalReal).toBeGreaterThan(last.balances.spendableReal);
    expect(
      Object.values(last.balances.byAccount).reduce((a, b) => a + b, 0),
    ).toBeCloseTo(last.balances.total, 6);

    // Every metric that decides whether the plan works uses the SPENDABLE
    // series instead — deterministic mode is one path, so median == that path.
    expect(result.medianTerminalReal).toBeCloseTo(last.balances.spendableReal, 8);
    expect(result.medianTerminalReal).toBeLessThan(last.balances.totalReal);
    expect(result.fan.p50[result.fan.p50.length - 1]).toBeCloseTo(last.balances.spendableReal, 8);
    for (const row of result.referencePath) {
      expect(row.balances.spendableReal).toBeCloseTo(row.balances.spendable / row.inflationIndex, 6);
    }
  });

  it('funds fixed_percent living through the soft window, and stops the day it locks', () => {
    /*
     * The `fixed_percent` policy spends a share of the START-of-year
     * SPENDABLE portfolio — and what counts as spendable now follows the
     * lock. Through the soft window the pot is the household's last-resort
     * money, so the policy prices off the WHOLE portfolio (excluding it was
     * the old hard carve's front-loaded drag). From the lock year the pot is
     * escrow: 4% of a portfolio whose carve-out is ~80,000 is ~3,300/yr of
     * difference, far outside any rounding, and the test asserts the exact
     * figure both ways round on both sides of the boundary.
     *
     * The 4% draw outruns the all-bills real return, so the release trigger
     * never fires and the lock lands exactly when the deferral ends: 2029.
     */
    const profile = titheProfile(
      { type: 'tithe_account', percent: 0.1, deferYears: 3, seedFromExistingGains: true },
      {
        accounts: [
          toyAccount({
            id: 'savings',
            type: 'savings',
            owner: 'p1',
            balance: 300_000,
            allocation: { stocks: 0, bonds: 0, bills: 1 },
          }),
          toyAccount({
            id: 'ira',
            type: 'traditional_ira',
            owner: 'p1',
            balance: 1_000_000,
            lifetimeContributions: 200_000,
            allocation: { stocks: 0, bonds: 0, bills: 1 },
          }),
        ],
        horizonAge: 61, // 2026..2032
      },
    );
    profile.settings.spendingPolicy = { type: 'fixed_percent', percent: 0.04 };
    const rows = runSimulation(
      simInput(profile, { name: 'tithe-fixed-percent', events: [] }),
    ).referencePath;

    // The seed year prices its living costs before the carve-out exists, so
    // the comparison starts once there is a carve-out to speak of.
    for (let yi = 1; yi < rows.length; yi++) {
      const prev = rows[yi - 1];
      const row = rows[yi];
      expect(prev.balances.tithe).toBeGreaterThan(0);
      if (!row.tithe!.locked) {
        // Soft window: the pot counts, so spendable IS total and the policy
        // prices off the whole portfolio.
        expect(row.expenses.baseline).toBeCloseTo(0.04 * prev.balances.total, 6);
        expect(prev.balances.spendable).toBeCloseTo(prev.balances.total, 8);
      } else {
        // Locked: the escrow is out. The start-of-year figure is the prior
        // year's total MINUS the carve-out — computed directly rather than
        // from prev.spendable, because the LOCK year's own prior row was
        // still soft and recorded spendable == total.
        expect(row.expenses.baseline).toBeCloseTo(
          0.04 * (prev.balances.total - prev.balances.tithe),
          6,
        );
        expect(row.expenses.baseline).not.toBeCloseTo(0.04 * prev.balances.total, 2);
      }
    }
    // Both regimes actually appeared in the run (2027-2028 soft, 2029+ locked).
    expect(rows.filter((r) => r.tithe !== undefined && !r.tithe.locked).length).toBeGreaterThan(1);
    expect(rows.filter((r) => r.tithe?.locked === true).length).toBeGreaterThan(1);
    expect(rows.find((r) => r.tithe?.locked === true)!.year).toBe(2029);
  });

  it('is never converted to Roth', () => {
    // `locked` hides the carve-out from the Roth-conversion planner as well as
    // from the withdrawal ordering: a conversion is a distribution, and the
    // household has promised these dollars away.
    const rows = runSimulation(
      simInput(
        titheProfile(
          { type: 'tithe_account', percent: 0.1, deferYears: 30, seedFromExistingGains: true },
          {
            accounts: [
              toyAccount({
                id: 'savings',
                type: 'savings',
                owner: 'p1',
                balance: 300_000,
                allocation: { stocks: 0, bonds: 0, bills: 1 },
              }),
              toyAccount({
                id: 'ira',
                type: 'traditional_ira',
                owner: 'p1',
                balance: 800_000,
                lifetimeContributions: 0,
                allocation: { stocks: 0, bonds: 0, bills: 1 },
              }),
            ],
            annualLiving: 20_000,
            horizonAge: 62,
          },
        ),
        {
          name: 'tithe-conversion',
          events: [{ type: 'roth_conversion', date: '2027-01', amount: 50_000 }],
        },
      ),
    ).referencePath;
    const converted = rows.find((r) => r.withdrawals.rothConversion > 0)!;
    expect(converted.year).toBe(2027);
    expect(converted.withdrawals.rothConversion).toBeCloseTo(50_000, 6);
    // The whole conversion came out of the ordinary IRA.
    expect(converted.withdrawals.byAccount['ira']).toBeCloseTo(50_000, 6);
    expect(rows.every((r) => (r.withdrawals.byAccount['ira-tithe'] ?? 0) === 0)).toBe(true);
  });

  it('neither shrinks the automatic 72(t) bridge nor is elected on by it', () => {
    /*
     * The seed runs AFTER the 72(t) machinery on purpose: the bridge that
     * keeps a pre-59 1/2 retirement solvent must size itself against the
     * undivided IRA, because the tithe is not the household's money to borrow
     * against. Same household twice — once tithing, once not — and the SEPP
     * carve-out and its payment must come out identical.
     */
    const build = (rule: Profile['expenses']['retirementGiving']): Profile => {
      const p = toyProfile({
        accounts: [
          toyAccount({
            id: 'savings',
            type: 'savings',
            owner: 'p1',
            balance: 50_000,
            allocation: { stocks: 0, bonds: 0, bills: 1 },
          }),
          toyAccount({
            id: 'ira',
            type: 'traditional_ira',
            owner: 'p1',
            balance: 300_000,
            lifetimeContributions: 0,
            allocation: { stocks: 0, bonds: 0, bills: 1 },
          }),
        ],
        annualLiving: 20_000,
        horizonAge: 61,
      });
      p.expenses.retirementGiving = rule;
      return p;
    };
    const events: Scenario['events'] = [{ type: 'retire', person: 'p1', date: '2026-07' }];
    const tithing = runSimulation(
      simInput(build({ ...titheRule }), { name: 'tithe-autosepp', events }),
    ).referencePath;
    const control = runSimulation(
      simInput(build({ type: 'none' }), { name: 'tithe-autosepp-control', events }),
    ).referencePath;

    // Both elected, both carved the same SEPP IRA, both pay the same amount.
    expect(tithing[0].eventsFired).toEqual(expect.arrayContaining(['auto-sepp', 'tithe-seeded']));
    for (let yi = 0; yi < tithing.length; yi++) {
      expect(tithing[yi].withdrawals.byAccount['ira-sepp'] ?? 0).toBeCloseTo(
        control[yi].withdrawals.byAccount['ira-sepp'] ?? 0,
        8,
      );
    }
    expect(tithing[0].balances.byAccount['ira-sepp']).toBeCloseTo(
      control[0].balances.byAccount['ira-sepp'],
      8,
    );
    // The seed came out of the REMAINDER, not out of the locked series, and
    // the series was never elected on the carve-out.
    expect(tithing[0].balances.byAccount['ira-tithe']).toBeGreaterThan(0);
    expect(tithing[0].balances.byAccount['ira-tithe-sepp']).toBeUndefined();
    expect(
      control[0].balances.byAccount['ira'] - tithing[0].balances.byAccount['ira'],
    ).toBeCloseTo(tithing[0].balances.byAccount['ira-tithe'], 6);
  });
});

describe('the Tithe Account is still an IRA for the IRS (note 21)', () => {
  it('is inside the RMD base, and its forced share is given away rather than spent', () => {
    /*
     * `locked` guards withdrawals and conversions; it does NOT guard RMDs, and
     * it must not — the Service sees one IRA and the required distribution
     * runs off the whole balance. Summed across the split, the household's RMD
     * is exactly what it would have been undivided: same owner, same age, same
     * divisor. p1 turns 75 in 2046, so the divisor is 24.6.
     *
     * deferYears 30 means the rule itself prescribes no cash, which isolates
     * the forced distribution: every dollar of charitable giving in 2046 is
     * the carve-out's RMD and nothing else.
     */
    const rows = runSimulation(
      simInput(
        titheProfile(
          { type: 'tithe_account', percent: 0.1, deferYears: 30, seedFromExistingGains: true },
          {
            accounts: [
              toyAccount({
                id: 'savings',
                type: 'savings',
                owner: 'p1',
                balance: 50_000,
                allocation: { stocks: 0, bonds: 0, bills: 1 },
              }),
              toyAccount({
                id: 'ira',
                type: 'traditional_ira',
                owner: 'p1',
                balance: 1_000_000,
                lifetimeContributions: 400_000,
                allocation: { stocks: 0, bonds: 0, bills: 1 },
              }),
            ],
            annualLiving: 20_000,
            horizonAge: 76, // 2026..2047 — two RMD years
          },
        ),
        { name: 'tithe-rmd', events: [] },
      ),
    ).referencePath;
    const y2045 = rows.find((r) => r.year === 2045)!;
    const y2046 = rows.find((r) => r.year === 2046)!;
    expect(y2045.withdrawals.rmd).toBe(0); // age 74: not yet

    // THE INVARIANT: the household's RMD is the undivided prior-year-end
    // balance over the divisor. Splitting the IRA changes the attribution and
    // nothing else.
    const undivided = y2045.balances.byAccount['ira'] + y2045.balances.byAccount['ira-tithe'];
    expect(y2046.withdrawals.rmd).toBeCloseTo(undivided / 24.6, 6);
    // ...and the carve-out is distributed off its OWN balance, pro rata.
    const titheRmd = y2046.withdrawals.byAccount['ira-tithe'];
    expect(titheRmd).toBeCloseTo(y2045.balances.byAccount['ira-tithe'] / 24.6, 6);
    expect(titheRmd).toBeGreaterThan(0);
    expect(titheRmd / y2046.withdrawals.rmd).toBeCloseTo(
      y2045.balances.byAccount['ira-tithe'] / undivided,
      10,
    );

    // Those dollars cannot go back in and are not the household's to spend, so
    // they are given away in cash the same year — the ONLY giving this rule
    // does inside its defer window, and the reason the cash identity stays
    // closed rather than opening by exactly this amount.
    expect(y2046.tithe!.forcedDistributionGiven).toBeCloseTo(titheRmd, 8);
    expect(y2046.expenses.charitable).toBeCloseTo(titheRmd, 8);
    expect(y2046.tithe!.given).toBe(0); // not the rule's prescription
    expect(
      y2046.taxes.trace!.some((t) =>
        t.label.startsWith('Tithe Account — required minimum distribution'),
      ),
    ).toBe(true);
    // The years before RMDs began gave nothing at all, forced or otherwise.
    for (const row of rows.filter((r) => r.year < 2046)) {
      expect(row.expenses.charitable).toBe(0);
      expect(row.tithe!.forcedDistributionGiven).toBe(0);
    }
  });
});

describe('the Tithe Account at death (note 21)', () => {
  it('reports the terminal balance as a charitable legacy instead of terminal wealth', () => {
    const result = runSimulation(
      simInput(
        titheProfile({ type: 'tithe_account', percent: 0.1, deferYears: 3, seedFromExistingGains: true }),
        { name: 'tithe-legacy', events: [] },
      ),
    );
    const rows = result.referencePath;
    const last = rows[rows.length - 1];

    // The engine models no estate, so "100% of it goes to charity on death" is
    // settled by keeping the balance out of terminal wealth and reporting it
    // here. Deflated on the final year's own index, like every other real
    // figure on that row.
    expect(result.charitableLegacy.terminalTitheReal).toBeCloseTo(
      last.balances.tithe / last.inflationIndex,
      6,
    );
    expect(result.charitableLegacy.terminalTitheReal).toBeGreaterThan(0);

    // The cash half is every gift the run actually made, deflated.
    const cash = rows.reduce((sum, r) => sum + r.expenses.charitable / r.inflationIndex, 0);
    expect(result.charitableLegacy.cashGivenReal).toBeCloseTo(cash, 6);
    expect(result.charitableLegacy.totalReal).toBeCloseTo(
      result.charitableLegacy.cashGivenReal + result.charitableLegacy.terminalTitheReal,
      8,
    );
    // The two halves are reported apart because they are different promises:
    // one already kept, one only intended.
    expect(result.charitableLegacy.totalReal).toBeGreaterThan(
      result.charitableLegacy.cashGivenReal,
    );

    // A plan with no rule at all gives nothing and leaves nothing.
    const none = runSimulation(
      simInput(toyProfile({ annualLiving: 0, horizonAge: 64 }), { name: 'tithe-legacy-none', events: [] }),
    );
    expect(none.charitableLegacy.terminalTitheReal).toBe(0);
    expect(none.charitableLegacy.cashGivenReal).toBe(0);
    expect(none.breakGlassReal).toBeNull();
  });

  it('reports break glass of ~0 under Monte Carlo when failures happen inside the soft window', () => {
    // earlyRelease: false keeps every path's window soft through the horizon,
    // so a failing path has BY CONSTRUCTION spent its pot before falling
    // short — the median break-glass figure over failures is the design
    // working, not a missing number. (A lucky path that triggered the release
    // and then crashed post-lock would muddy the median, which is exactly the
    // behaviour the companion test below isolates.)
    const profile = titheProfile(
      {
        type: 'tithe_account',
        percent: 0.1,
        deferYears: 30,
        seedFromExistingGains: true,
        earlyRelease: false,
      },
      {
        accounts: [
          toyAccount({
            id: 'savings',
            type: 'savings',
            owner: 'p1',
            balance: 100_000,
            allocation: { stocks: 0, bonds: 0, bills: 1 },
          }),
          toyAccount({
            id: 'ira',
            type: 'traditional_ira',
            owner: 'p1',
            balance: 500_000,
            lifetimeContributions: 100_000,
            allocation: { stocks: 1, bonds: 0, bills: 0 },
          }),
        ],
        annualLiving: 60_000,
        horizonAge: 74,
      },
    );
    const scenario: Scenario = { name: 'tithe-mc', events: [] };
    const a = runSimulation(simInput(profile, scenario, { mode: 'montecarlo', paths: 60, seed: 4242 }));
    const b = runSimulation(simInput(profile, scenario, { mode: 'montecarlo', paths: 60, seed: 4242 }));
    // A rule that carves accounts mid-path must not cost determinism.
    expect(a.meta.runKey).toBe(b.meta.runKey);
    expect(JSON.stringify(a.fan)).toBe(JSON.stringify(b.fan));
    expect(a.breakGlassReal).toBe(b.breakGlassReal);

    expect(a.success).toBeLessThan(1); // some paths fail at this spending rate
    expect(a.breakGlassReal).not.toBeNull();
    expect(a.breakGlassReal!).toBeCloseTo(0, 4);
  });

  it('reports a positive break-glass median when failures happen after the lock', () => {
    // deferYears 0 locks every path's carve-out on day one and the 30-year
    // payout keeps an escrow alive through the horizon: a failing path now
    // fails HOLDING promised money, and the figure prices the choice it
    // declined to make.
    const profile = titheProfile(
      {
        type: 'tithe_account',
        percent: 0.1,
        deferYears: 0,
        seedFromExistingGains: true,
        distributeYears: 30,
      },
      {
        accounts: [
          toyAccount({
            id: 'savings',
            type: 'savings',
            owner: 'p1',
            balance: 100_000,
            allocation: { stocks: 0, bonds: 0, bills: 1 },
          }),
          toyAccount({
            id: 'ira',
            type: 'traditional_ira',
            owner: 'p1',
            balance: 500_000,
            lifetimeContributions: 100_000,
            allocation: { stocks: 1, bonds: 0, bills: 0 },
          }),
        ],
        annualLiving: 60_000,
        horizonAge: 74,
      },
    );
    const result = runSimulation(
      simInput(profile, { name: 'tithe-mc-locked', events: [] }, { mode: 'montecarlo', paths: 60, seed: 4242 }),
    );
    expect(result.success).toBeLessThan(1);
    expect(result.breakGlassReal).not.toBeNull();
    expect(result.breakGlassReal!).toBeGreaterThan(0);
  });
});

describe('the Tithe Account: the pot distributes over distributeYears (note 21)', () => {
  /**
   * An 800,000 IRA (200,000 contributed) beside 5,000,000 of savings, all
   * bills, no spending, with deferYears 2 / distributeYears 3 / earlyRelease
   * off — so the calendar is fixed: soft 2026-2027, lock 2028, instalments
   * 2028-2030, empty after. All-bills keeps every figure a plain product of
   * BILLS_NOM, and the savings pile does two jobs: its interest lifts the
   * household well clear of the standard deduction (the tax test below
   * compares taxable incomes) and it pays each instalment year's tax bill in
   * NON-taxable cash, so the instalment is the only thing moving AGI.
   */
  const scheduleAccounts = (): Profile['accounts'] => [
    toyAccount({
      id: 'savings',
      type: 'savings',
      owner: 'p1',
      balance: 5_000_000,
      allocation: { stocks: 0, bonds: 0, bills: 1 },
    }),
    toyAccount({
      id: 'ira',
      type: 'traditional_ira',
      owner: 'p1',
      balance: 800_000,
      lifetimeContributions: 200_000,
      allocation: { stocks: 0, bonds: 0, bills: 1 },
    }),
  ];
  const scheduleRun = () =>
    runSimulation(
      simInput(
        titheProfile(
          {
            type: 'tithe_account',
            percent: 0.1,
            deferYears: 2,
            seedFromExistingGains: true,
            distributeYears: 3,
            earlyRelease: false,
          },
          {
            accounts: scheduleAccounts(),
            horizonAge: 62, // 2026..2033
          },
        ),
        { name: 'tithe-schedule', events: [] },
      ),
    ).referencePath;

  it('pays balance / years-remaining each year, and the growth is distributed too', () => {
    const rows = scheduleRun();
    const y = (year: number) => rows.find((r) => r.year === year)!;

    // Soft years: no instalments, no lock.
    for (const year of [2026, 2027]) {
      expect(y(year).tithe!.locked).toBe(false);
      expect(y(year).tithe!.distributed).toBe(0);
    }
    /*
     * Each instalment divides the balance AS OF THE PAYMENT (start of year,
     * net of nothing else here) by the years remaining: 1/3, then 1/2, then
     * the whole remainder. The recurrence end = (start - inst) x (1 + bills)
     * makes the expected figures products of the prior END balances, so the
     * mid-distribution growth demonstrably reaches charity instead of being
     * stranded — the reason balance/remaining beat a flat pot/N.
     */
    expect(y(2028).tithe!.distributed).toBeCloseTo(y(2027).balances.tithe / 3, 6);
    expect(y(2029).tithe!.distributed).toBeCloseTo(y(2028).balances.tithe / 2, 6);
    expect(y(2030).tithe!.distributed).toBeCloseTo(y(2029).balances.tithe, 6);
    // Exactly empty on schedule: (start - start/1) x growth = 0, no residue.
    expect(y(2030).balances.tithe).toBe(0);

    // Pot exhausted -> ONLY the growth stream remains, and the account never
    // refills (the lock stopped the transfers for good).
    for (const year of [2031, 2032, 2033]) {
      const row = y(year);
      expect(row.tithe!.distributed).toBe(0);
      expect(row.tithe!.accrued).toBe(0);
      expect(row.balances.tithe).toBe(0);
      expect(row.expenses.charitable).toBeCloseTo(row.tithe!.given, 8);
    }
    // The growth stream genuinely survived the pot: new real highs keep
    // giving (all-bills is a positive real return with nothing spent).
    expect(y(2032).tithe!.given).toBeGreaterThan(0);
  });

  it('each instalment is ordinary income with the owner’s own penalty rules — and deductible', () => {
    /*
     * The instalment is a REAL IRA distribution, not bookkeeping: it raises
     * AGI by its full amount, is penalized before the user's 59 1/2 year
     * (2028: p1 is 57 — an early release or a short window can genuinely put
     * instalments before 59 1/2, and pretending otherwise would understate
     * the cost), and feeds the charitable deduction, whose non-itemizer cap
     * of $2,000 MFJ is what shows in taxable income.
     *
     * The control is the SAME household whose window simply never closes
     * (deferYears 30, no release): identical balances and identical interest
     * through 2028, so the instalment is the only moving part.
     */
    const control = runSimulation(
      simInput(
        titheProfile(
          {
            type: 'tithe_account',
            percent: 0.1,
            deferYears: 30,
            seedFromExistingGains: true,
            earlyRelease: false,
          },
          {
            accounts: scheduleAccounts(),
            horizonAge: 62,
          },
        ),
        { name: 'tithe-schedule-control', events: [] },
      ),
    ).referencePath;
    const rows = scheduleRun();
    const lockYear = rows.find((r) => r.year === 2028)!;
    const controlYear = control.find((r) => r.year === 2028)!;
    const instalment = lockYear.tithe!.distributed;
    expect(instalment).toBeGreaterThan(2_000);

    // AGI rises by exactly the instalment (everything else is identical).
    expect(lockYear.taxes.federal.agi - controlYear.taxes.federal.agi).toBeCloseTo(instalment, 4);
    // The gift claims the $2,000 non-itemizer cap the control could not.
    expect(
      controlYear.taxes.federal.taxableIncome - (lockYear.taxes.federal.taxableIncome - instalment),
    ).toBeCloseTo(2_000, 4);
    // Penalized at 10%: 2028 is before p1's 2031 penalty-free year, and the
    // control run has no distribution to penalize.
    expect(lockYear.taxes.penalties - controlYear.taxes.penalties).toBeCloseTo(0.1 * instalment, 4);
    expect(lockYear.flags).toContain('penalty');
  });
});

describe('the Tithe Account: the safe-zone early release (note 21)', () => {
  /**
   * A single all-stocks IRA driven by hand-written returns with CPI pinned at
   * 4%, so nominal and real diverge sharply: two +2%-nominal years RISE in
   * nominal terms and FALL in real terms — the exact case a nominal trigger
   * would get wrong — then a +30% year sets an unmistakable real high.
   */
  const releaseProfile = (earlyRelease: boolean) =>
    titheProfile(
      {
        type: 'tithe_account',
        percent: 0.1,
        deferYears: 10,
        seedFromExistingGains: true,
        distributeYears: 5,
        earlyRelease,
      },
      {
        accounts: [
          toyAccount({
            id: 'ira',
            type: 'traditional_ira',
            owner: 'p1',
            balance: 1_000_000,
            lifetimeContributions: 400_000,
            allocation: { stocks: 1, bonds: 0, bills: 0 },
          }),
        ],
        horizonAge: 63, // 2026..2034 — nine hand-written years
      },
    );
  const path = (stocks: number[]): YearReturns[] =>
    stocks.map((s) => ({ stocks: s, bonds: 0, bills: 0, cpi: 0.04 }));
  const STOCKS = [0.05, 0.02, 0.02, 0.3, 0, 0, 0, 0, 0];

  it('triggers on a REAL spendable high — nominal highs do not count', () => {
    const ctx = prepareSim(simInput(releaseProfile(true), { name: 'tithe-release', events: [] }));
    expect(ctx.horizonYears).toBe(9);
    const rows = simulatePath(ctx, path(STOCKS), { trace: true }).yearRows!;

    /*
     * 2027 and 2028 both set NOMINAL highs (+2% on a growing balance) while
     * REAL spendable falls (2% nominal under 4% CPI): the trigger must not
     * fire, or every mildly-inflationary year would end every window.
     */
    for (const yi of [1, 2]) {
      expect(rows[yi].balances.total).toBeGreaterThan(rows[yi - 1].balances.total); // nominal high
      expect(rows[yi].balances.spendableReal).toBeLessThan(rows[0].balances.spendableReal);
      expect(rows[yi].tithe!.locked).toBe(false);
      expect(rows[yi].eventsFired).not.toContain('tithe-locked');
    }
    // 2029's +30% closes above the first retired year's REAL close: the
    // fragile window is provably over, and the lock lands the NEXT year.
    expect(rows[3].balances.spendableReal).toBeGreaterThan(rows[0].balances.spendableReal);
    expect(rows[3].tithe!.locked).toBe(false); // the trigger year's books are already written
    const lockRow = rows[4];
    expect(lockRow.tithe!.locked).toBe(true);
    expect(lockRow.eventsFired).toContain('tithe-locked');
    expect(lockRow.eventsFired).toContain('tithe-early-release');
    // Distribution starts with the lock: first of the 5 instalments, sized
    // off the pot as it stood at the start of the lock year.
    expect(lockRow.tithe!.distributed).toBeCloseTo(rows[3].balances.tithe / 5, 6);
    // And the trace says which door the lock came through.
    expect(
      lockRow.taxes.trace!.find((t) => t.label === 'Tithe Account — locked: distribution starts')!
        .note,
    ).toContain('SAFE-ZONE RELEASE');
    // Accrual ended with the soft window.
    for (const row of rows.slice(4)) expect(row.tithe!.accrued).toBe(0);
  });

  it('earlyRelease false waits out the full deferral however good the year', () => {
    const ctx = prepareSim(
      simInput(releaseProfile(false), { name: 'tithe-release-off', events: [] }),
    );
    const rows = simulatePath(ctx, path(STOCKS), { trace: true }).yearRows!;
    // The same +30% year comes and goes; with the release off the window
    // holds for the whole horizon (deferYears 10 outlives the 9 sim years).
    for (const row of rows) {
      expect(row.tithe!.locked).toBe(false);
      expect(row.tithe!.distributed).toBe(0);
      expect(row.eventsFired).not.toContain('tithe-locked');
    }
    // ...and the +30% year still accrues into the pot instead (a new real
    // high IS a base, whatever it does to the trigger).
    expect(rows[3].tithe!.accrued).toBeGreaterThan(0);
  });
});

describe('the Tithe Account at a death mid-soft-window (note 21)', () => {
  it('the pot changes hands but not purpose: still promised, still charity’s at the end', () => {
    /*
     * p1 dies in 2029, two years into a soft window that outlives the
     * horizon. The carve-out passes to p2 by spousal rollover like the IRA it
     * lives inside — but a promise to charity does not die with the promisor:
     * the account keeps its tithe identity, keeps accruing, keeps being the
     * survivor's LAST-RESORT money only, and whatever remains at the horizon
     * is reported as charitable legacy, not as her wealth.
     */
    const profile = titheProfile(
      {
        type: 'tithe_account',
        percent: 0.1,
        deferYears: 30,
        seedFromExistingGains: true,
        earlyRelease: false,
      },
      {
        accounts: [
          toyAccount({
            id: 'savings',
            type: 'savings',
            owner: 'p1',
            balance: 400_000,
            allocation: { stocks: 0, bonds: 0, bills: 1 },
          }),
          toyAccount({
            id: 'ira',
            type: 'traditional_ira',
            owner: 'p1',
            balance: 900_000,
            lifetimeContributions: 300_000,
            allocation: { stocks: 0, bonds: 0, bills: 1 },
          }),
        ],
        annualLiving: 40_000,
        horizonAge: 64, // 2026..2035
      },
    );
    const result = runSimulation(
      simInput(profile, {
        name: 'tithe-death-soft',
        events: [{ type: 'death', person: 'p1', date: '2029-06' }],
      }),
    );
    const rows = result.referencePath;
    const deathYear = rows.find((r) => r.year === 2029)!;
    expect(deathYear.eventsFired).toContain('spousal-rollover');
    expect(deathYear.tithe!.locked).toBe(false); // mid-soft-window, as constructed

    // The carve-out survives the death: still on the books, still accruing in
    // later soft years, still counted spendable (the soft window's meaning).
    const last = rows[rows.length - 1];
    expect(last.balances.tithe).toBeGreaterThan(0);
    expect(rows.slice(rows.indexOf(deathYear)).every((r) => r.tithe !== undefined)).toBe(true);
    expect(last.balances.spendable).toBeCloseTo(last.balances.total, 6);

    // ...and at the horizon it goes to charity, not to the survivor: the
    // legacy reports it and the terminal wealth metric does not lose it
    // (soft window: spendable includes the pot right through the end).
    expect(result.charitableLegacy.terminalTitheReal).toBeCloseTo(
      last.balances.tithe / last.inflationIndex,
      6,
    );
    expect(result.charitableLegacy.terminalTitheReal).toBeGreaterThan(0);
  });
});

describe('the Tithe Account keeps the recorded-cash identity exact (note 21)', () => {
  it('income + gross withdrawals still balance every year, through defer, gift and RMD', () => {
    /*
     * The seed and the yearly transfer are intra-portfolio balance moves — one
     * IRA balance down, another up — so they add NO term to the identity, in
     * exactly the way the 72(t) split adds none. The two tithe flows that ARE
     * cash (the disbursement-phase gift and the carve-out's forced RMD) both
     * arrive as expenses.charitable, a term the identity already had.
     *
     * Same rich household as the note-20 identity test, with the rule bolted
     * on: wages, a 401(k) that rolls over, a brokerage that realizes gains,
     * Social Security, Medicare, RMDs from 2046 — and a defer window (2029-32)
     * followed by thirteen disbursement years.
     */
    const profile = titheProfile(
      // distributeYears 30 (the cap) keeps the escrow paying instalments right
      // through the 2046 RMD year, so the identity is exercised with the
      // instalment AND the forced RMD flowing in the same years. earlyRelease
      // stays on its default: the identity must close under the release too.
      {
        type: 'tithe_account',
        percent: 0.1,
        deferYears: 4,
        seedFromExistingGains: true,
        distributeYears: 30,
      },
      {
        people: [
          toyPerson('p1', {
            piaMonthlyAtFraIfWorkingTo62: 2000,
            piaMonthlyAtFraIfStoppingNow: 1800,
            hasOwnBenefit: true,
          }),
          toyPerson('p2'),
        ],
        accounts: [
          toyAccount({
            id: 'savings',
            type: 'savings',
            owner: 'p1',
            balance: 300_000,
            allocation: { stocks: 0, bonds: 0, bills: 1 },
          }),
          toyAccount({
            id: 'brokerage',
            type: 'taxable_brokerage',
            owner: 'p1',
            balance: 400_000,
            costBasis: 200_000,
            allocation: { stocks: 1, bonds: 0, bills: 0 },
          }),
          toyAccount({
            id: 'k401',
            type: '401k',
            owner: 'p1',
            balance: 300_000,
            lifetimeContributions: 200_000,
            currentEmployer: true,
            allocation: { stocks: 1, bonds: 0, bills: 0 },
          }),
          toyAccount({
            id: 'ira',
            type: 'traditional_ira',
            owner: 'p1',
            balance: 700_000,
            lifetimeContributions: 250_000,
            allocation: { stocks: 1, bonds: 0, bills: 0 },
          }),
          toyAccount({
            id: 'roth',
            type: 'roth_ira',
            owner: 'p2',
            balance: 120_000,
            lifetimeContributions: 80_000,
            allocation: { stocks: 1, bonds: 0, bills: 0 },
          }),
        ],
        annualLiving: 70_000,
        charitableMonthly: 400,
        investingMonthly: 500,
        employerPremiumShareMonthly: 300,
        income: { salaries: { p1: 150_000, p2: 0 }, contribution401k: 12_000, employerMatch401k: 6_000 },
        horizonAge: 79, // 2026..2050
      },
    );
    const rows = runSimulation(
      simInput(profile, {
        name: 'tithe-identity',
        events: [
          { type: 'retire', person: 'p1', date: '2028-07' },
          { type: 'retire', person: 'p2', date: '2028-07' },
          { type: 'claim_social_security', person: 'p1', date: '2038-06' },
          { type: 'claim_social_security', person: 'p2', date: '2038-06' },
        ],
      }),
    ).referencePath;
    expect(rows).toHaveLength(25);

    let brokeragePrev = 400_000;
    for (const row of rows) {
      expect(row.flags).not.toContain('insolvent');
      // Recover the retired year's swept surplus from the brokerage, exactly
      // as the note-20 identity test does.
      const g = row.returns.stocks - marketJson.stockDividendYield;
      const brokerageEnd = row.balances.byAccount['brokerage'] ?? 0;
      const swept =
        brokerageEnd / (1 + g) - brokeragePrev + row.withdrawals.taxable - row.investing;
      const income =
        row.income.wages +
        row.income.socialSecurity +
        row.income.taxableInterest +
        row.income.dividends +
        row.income.other;
      const gross =
        row.withdrawals.cash +
        row.withdrawals.taxable +
        row.withdrawals.pretax +
        row.withdrawals.roth;
      const residual =
        income +
        gross -
        (row.expenses.total + row.taxes.totalTax + row.investing + swept + row.unbudgeted);
      // Same bound the note-20 test uses: the only slack is the withdrawal
      // solve's own convergence tolerance, and it can only fall short.
      expect(residual).toBeLessThan(0.01);
      expect(residual).toBeGreaterThan(-1);
      // The balance sheet closes too: the carve-out is part of `total`, so
      // splitting it out must not lose or invent a dollar. `spendable` drops
      // the pot only from the lock year — through the soft window it IS the
      // total, which is the redesign's whole point.
      expect(row.balances.total).toBeCloseTo(
        row.balances.spendable + (row.tithe?.locked ? row.balances.tithe : 0),
        6,
      );
      expect(
        Object.values(row.balances.byAccount).reduce((a, b) => a + b, 0),
      ).toBeCloseTo(row.balances.total, 6);
      brokeragePrev = brokerageEnd;
    }

    // The run really did exercise all three tithe regimes, plus the machinery
    // the identity is most fragile around.
    expect(rows.some((r) => r.eventsFired.includes('tithe-seeded'))).toBe(true);
    expect(rows.some((r) => (r.tithe?.accrued ?? 0) > 0)).toBe(true); // defer
    expect(rows.some((r) => (r.tithe?.given ?? 0) > 0)).toBe(true); // disbursement
    expect(rows.some((r) => (r.tithe?.distributed ?? 0) > 0)).toBe(true); // pot instalments
    expect(rows.some((r) => (r.tithe?.forcedDistributionGiven ?? 0) > 0)).toBe(true); // RMD
    expect(rows.some((r) => r.withdrawals.rmd > 0)).toBe(true);
    expect(rows.some((r) => r.eventsFired.includes('rollover-401k'))).toBe(true);
    expect(rows.some((r) => r.income.socialSecurity > 0)).toBe(true);
  });
});

describe('the pot-paired growth tithe: the rule functions in isolation (note 21)', () => {
  // The stream half of the old bundled rule: percent_of_growth, switched onto
  // the high-water-mark base by the history's `growthStream` marker (which
  // simulate.ts sets whenever a pot pairs with a growth ongoing method).
  const rule = { type: 'percent_of_growth', percent: 0.1 } as const;
  // Retirement in sim year 1, lock when the 2-year hold ends (yi 3); the
  // year-end bases the engine would have written.
  const history = {
    growthStream: 'accrue_to_pot' as const,
    firstRetiredYi: 1,
    lockYi: 3,
    baseRealByYear: [0, 1000, 2000, 3000, 4000],
  };

  it('reads LAST year’s real high-water base, and nothing in the first simulated year', () => {
    expect(retirementGivingBase(rule, 0, [], [], history)).toBe(0);
    expect(retirementGivingBase(rule, 2, [], [], history)).toBe(1000);
    expect(retirementGivingBase(rule, 4, [], [], history)).toBe(3000);
    // A year past the end of the series has no base rather than an undefined.
    expect(retirementGivingBase(rule, 9, [], [], history)).toBe(0);
    // It reads the tithe history and nothing else — the growth and income
    // series belong to the pot-less rules and are inert here.
    expect(retirementGivingBase(rule, 2, [999999], [999999], history)).toBe(1000);
    // WITHOUT the pot marker the same rule reads the plain growth series —
    // the pre-split percent_of_growth, bit-for-bit.
    expect(retirementGivingBase(rule, 2, [500, 700], [999999])).toBe(700);
  });

  it('gives 0 before retirement and through the lock year, then percent x base x CPI', () => {
    // Never retired: no origin, so no giving, exactly like every other rule.
    expect(
      retirementGivingAnnual(rule, 5, 1.2, [], [], {
        growthStream: 'accrue_to_pot',
        firstRetiredYi: null,
        lockYi: null,
        baseRealByYear: [],
      }),
    ).toBe(0);
    // Retired years 1 and 2 of a 2-year hold (yi 1 and 2): nothing.
    expect(retirementGivingAnnual(rule, 1, 1, [], [], history)).toBe(0);
    expect(retirementGivingAnnual(rule, 2, 1, [], [], history)).toBe(0);
    // yi 3 — the LOCK year — still gives no GROWTH cash, and this is the
    // whole boundary rule.
    //
    // The accrual consumed base[1] and base[2] (the soft years). yi 3 would
    // read base[2] — the base the last accrual year just moved into the
    // carve-out — so paying growth cash on it would give the same growth away
    // twice. The trailing stream therefore starts one year after the lock, on
    // base[3], the first base no transfer ever touched. (The lock year is not
    // silent in-engine: the POT's first instalment pays there, but that is
    // simulate.ts's addition, not this stream's prescription.)
    expect(retirementGivingAnnual(rule, 3, 1.05, [], [], history)).toBe(0);
    expect(retirementGivingAnnual(rule, 4, 1.1, [], [], history)).toBeCloseTo(0.1 * 3000 * 1.1, 10);
    // A lock on retirement day (holdYears 0 -> lockYi === firstRetiredYi):
    // growth cash from the second retired year — the first still has no
    // completed year under the rule to read.
    const eagerHistory = { ...history, lockYi: 1 };
    expect(retirementGivingAnnual(rule, 1, 1, [], [], eagerHistory)).toBe(0);
    expect(retirementGivingAnnual(rule, 2, 1, [], [], eagerHistory)).toBeCloseTo(100, 10);
    // An early release pulls the same boundary earlier: lock at yi 2 starts
    // the growth stream at yi 3, on base[2] — which under THIS lock was never
    // accrued (accrual stops strictly before the lock year).
    const released = { ...history, lockYi: 2 };
    expect(retirementGivingAnnual(rule, 2, 1, [], [], released)).toBe(0);
    expect(retirementGivingAnnual(rule, 3, 1, [], [], released)).toBeCloseTo(0.1 * 2000, 10);
    // A hold still open (lock date unknown) gives nothing, however late.
    const unlocked = { ...history, lockYi: null };
    expect(retirementGivingAnnual(rule, 4, 1, [], [], unlocked)).toBe(0);
  });

  it("give_cash pays from retirement day on the same base, ungated by the lock", () => {
    // The new capability: no accrual ever touches a base, so cash simply
    // reads base[yi - 1] every year — including the hold and the lock year.
    const giveCash = { ...history, growthStream: 'give_cash' as const };
    expect(retirementGivingAnnual(rule, 1, 1, [], [], giveCash)).toBe(0); // base[0] = 0
    expect(retirementGivingAnnual(rule, 2, 1, [], [], giveCash)).toBeCloseTo(100, 10);
    expect(retirementGivingAnnual(rule, 3, 1, [], [], giveCash)).toBeCloseTo(200, 10);
    expect(retirementGivingAnnual(rule, 4, 1.1, [], [], giveCash)).toBeCloseTo(
      0.1 * 3000 * 1.1,
      10,
    );
  });
});

describe('the Tithe Account: property tests (note 21)', () => {
  /**
   * fast-check over hand-generated return paths. Deliberately violent ranges
   * (stocks -40%..+40%, deflation through 8% inflation) because the carve-out
   * is supposed to be untouchable in every one of them, not merely in the
   * ones a market model would draw.
   *
   * Seeded so a failure is reproducible; numRuns is modest because each run is
   * a full 26-year simulation with taxes, RMDs and the withdrawal solve.
   */
  const SEED = 20260814;
  const propertyProfile = (rule: TitheRule): Profile =>
    titheProfile(rule, {
      accounts: [
        toyAccount({
          id: 'savings',
          type: 'savings',
          owner: 'p1',
          balance: 150_000,
          allocation: { stocks: 0, bonds: 0, bills: 1 },
        }),
        toyAccount({
          id: 'ira',
          type: 'traditional_ira',
          owner: 'p1',
          balance: 900_000,
          lifetimeContributions: 350_000,
          // A blended mix, fixed for the whole run (no allocation events), so
          // the carve-out's own return is computable outside the engine.
          allocation: { stocks: 0.6, bonds: 0.3, bills: 0.1 },
        }),
        toyAccount({
          id: 'roth',
          type: 'roth_ira',
          owner: 'p2',
          balance: 150_000,
          lifetimeContributions: 90_000,
          allocation: { stocks: 1, bonds: 0, bills: 0 },
        }),
      ],
      annualLiving: 55_000,
      horizonAge: 80, // 2026..2051, so RMDs at 75 are inside the window
    });
  const MIX = { stocks: 0.6, bonds: 0.3, bills: 0.1 };

  const arbReturns = (n: number) =>
    fc.array(
      fc.record({
        stocks: fc.double({ min: -0.4, max: 0.4, noNaN: true }),
        bonds: fc.double({ min: -0.1, max: 0.15, noNaN: true }),
        bills: fc.double({ min: 0, max: 0.08, noNaN: true }),
        cpi: fc.double({ min: -0.01, max: 0.08, noNaN: true }),
      }),
      { minLength: n, maxLength: n },
    );

  it('moves only five ways: market return, transfers in, RMD/instalment/last-resort out', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0, max: 0.25, noNaN: true }),
        fc.integer({ min: 0, max: 8 }),
        fc.boolean(),
        fc.boolean(),
        fc.integer({ min: 1, max: 30 }),
        fc.constant(0).chain(() => arbReturns(26)),
        (percent, deferYears, seedFromExistingGains, earlyRelease, distributeYears, returns) => {
          const ctx = prepareSim(
            simInput(
              propertyProfile({
                type: 'tithe_account',
                percent,
                deferYears,
                seedFromExistingGains,
                earlyRelease,
                distributeYears,
              }),
              { name: 'tithe-property', events: [] },
            ),
          );
          const rows = simulatePath(ctx, returns as YearReturns[], { trace: true }).yearRows!;

          let prev = 0;
          for (let yi = 0; yi < rows.length; yi++) {
            const row = rows[yi];
            if (!row.tithe) {
              // Before the carve-out exists (or in a plan that never opens
              // one) the two balance views are the same figure.
              expect(row.balances.tithe).toBe(0);
              expect(row.balances.spendable).toBe(row.balances.total);
              continue;
            }
            const r = row.returns;
            const g = MIX.stocks * r.stocks + MIX.bonds * r.bonds + MIX.bills * r.bills;
            const out = row.withdrawals.byAccount[row.tithe.accountId] ?? 0;

            // THE RECURRENCE. The seed lands before the year's growth, every
            // outflow (RMD, pot instalment, last-resort draw) is taken before
            // it, and the transfer lands after it. If any OTHER machinery
            // could reach the account — a 72(t) payment, a Roth conversion, a
            // surplus sweep — this breaks.
            const expected = (prev + row.tithe.seeded - out) * (1 + g) + row.tithe.accrued;
            expect(row.balances.tithe).toBeCloseTo(expected, 6);

            // Every outflow is one of exactly three named things, and the two
            // gift-shaped ones are given away in full the same year.
            const drawn = out - row.tithe.forcedDistributionGiven - row.tithe.distributed;
            expect(drawn).toBeCloseTo(row.tithe.drawn, 6);
            expect(drawn).toBeGreaterThanOrEqual(-1e-6);
            // A LOCKED year never sees a last-resort draw; a SOFT year never
            // sees an instalment.
            if (row.tithe.locked) expect(row.tithe.drawn).toBe(0);
            else expect(row.tithe.distributed).toBe(0);
            // With no paycheck stream in this fixture, the year's whole
            // charitable expense decomposes into the three tithe gifts.
            expect(row.expenses.charitable).toBeCloseTo(
              row.tithe.given + row.tithe.distributed + row.tithe.forcedDistributionGiven,
              6,
            );

            // Transfers in happen inside the soft window and nowhere else.
            const retiredYears = yi; // no salary in this fixture: retired from 2026
            if (retiredYears >= deferYears) expect(row.tithe.accrued).toBe(0);
            if (row.tithe.locked) expect(row.tithe.accrued).toBe(0);
            expect(row.tithe.accrued).toBeGreaterThanOrEqual(0);

            // The two balance views agree, always — and which way they agree
            // follows the lock.
            expect(row.balances.spendable).toBeCloseTo(
              row.balances.total - (row.tithe.locked ? row.balances.tithe : 0),
              6,
            );
            expect(row.balances.spendableReal).toBeCloseTo(
              row.balances.spendable / row.inflationIndex,
              6,
            );
            prev = row.balances.tithe;
          }
        },
      ),
      { numRuns: 25, seed: SEED },
    );
  });

  it('never falls except on a market loss or money recorded as leaving it', () => {
    fc.assert(
      fc.property(arbReturns(26), (returns) => {
        const ctx = prepareSim(
          simInput(
            propertyProfile({
              type: 'tithe_account',
              percent: 0.1,
              deferYears: 6,
              seedFromExistingGains: true,
            }),
            { name: 'tithe-monotone', events: [] },
          ),
        );
        const rows = simulatePath(ctx, returns as YearReturns[], { trace: true }).yearRows!;
        let prev = 0;
        for (const row of rows) {
          if (!row.tithe) continue;
          const r = row.returns;
          const g = MIX.stocks * r.stocks + MIX.bonds * r.bonds + MIX.bills * r.bills;
          // EVERY outflow — RMD share, pot instalment, last-resort draw — is
          // recorded in withdrawals.byAccount; nothing may leave off-book.
          const out = row.withdrawals.byAccount[row.tithe.accountId] ?? 0;
          if (g >= 0 && out === 0) {
            // Nothing else can take a dollar out of it.
            expect(row.balances.tithe).toBeGreaterThanOrEqual(prev - 1e-6);
          }
          expect(row.balances.tithe).toBeGreaterThanOrEqual(0);
          prev = row.balances.tithe;
        }
      }),
      { numRuns: 25, seed: SEED },
    );
  });
});

describe('life insurance ends with the paycheck (topic 6)', () => {
  /*
   * Term life is income replacement, so the premium is charged for the months
   * somebody worked and nothing after — prorated in the retirement year like
   * every other stream, and zero for the rest of the run.
   */
  const insured = (lifeInsuranceMonthly?: number) =>
    runSimulation(
      simInput(
        toyProfile({
          accounts: [
            toyAccount({
              id: 'savings',
              type: 'savings',
              owner: 'p1',
              balance: 2_000_000,
              allocation: { stocks: 0, bonds: 0, bills: 1 },
            }),
          ],
          annualLiving: 60000,
          income: { salaries: { p1: 100_000, p2: 0 }, contribution401k: 0, employerMatch401k: 0 },
          horizonAge: 60, // 2026..2031
          ...(lifeInsuranceMonthly === undefined ? {} : { lifeInsuranceMonthly }),
        }),
        { name: 'life', autoSepp: false, events: [{ type: 'retire', person: 'p1', date: '2028-07' }] },
      ),
    ).referencePath;

  it('charges it while working, prorates the retirement year, then stops for good', () => {
    const withIt = insured(320);
    const without = insured(undefined);
    const gap = (y: number) => {
      const a = withIt.find((r) => r.year === y)!;
      const b = without.find((r) => r.year === y)!;
      return a.expenses.baseline - b.expenses.baseline;
    };
    // 2026-2027: a full year of premium, in that year's dollars.
    expect(gap(2026)).toBeCloseTo(320 * 12, 6);
    expect(gap(2027)).toBeCloseTo(320 * 12 * withIt.find((r) => r.year === 2027)!.inflationIndex, 6);
    // 2028: retires 1 July, so six worked months -> half a year of premium.
    expect(gap(2028)).toBeCloseTo(
      320 * 12 * 0.5 * withIt.find((r) => r.year === 2028)!.inflationIndex,
      6,
    );
    // 2029 onward: nothing, forever.
    for (const y of [2029, 2030, 2031]) expect(gap(y)).toBeCloseTo(0, 8);
  });

  it('is absent-means-zero, leaving every older profile untouched', () => {
    const none = insured(undefined);
    const zero = insured(0);
    expect(none.map((r) => r.expenses.baseline)).toEqual(zero.map((r) => r.expenses.baseline));
  });
});

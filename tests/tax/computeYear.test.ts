/**
 * Integration tests for src/tax/computeYear.ts — the SPEC §7 entry point —
 * against the verified 2026 default data files (federal + VA/SC/NC + ACA +
 * Medicare). Every expected value is hand-computed with the arithmetic in a
 * comment; these become part of the frozen §8 suite.
 *
 * Orchestration under test: preliminary standard-deduction federal pass ->
 * state tax -> final federal with state tax in SALT -> ACA PTC on ACA MAGI ->
 * Medicare -> totalTax = federal + state + penalties (premiums are expenses).
 */

import { describe, expect, it } from 'vitest';
import { computeYear } from '../../src/tax/computeYear';
import type {
  AcaData,
  FederalTaxData,
  MedicareData,
  RetirementDistribution,
  StateTaxData,
  TaxDataBundle,
  TaxYearInputs,
} from '../../src/shared/types';
import federalJson from '../../data-defaults/assumptions/tax/federal-2026.json';
import vaJson from '../../data-defaults/assumptions/tax/va-2026.json';
import scJson from '../../data-defaults/assumptions/tax/sc-2026.json';
import ncJson from '../../data-defaults/assumptions/tax/nc-2026.json';
import acaJson from '../../data-defaults/assumptions/aca-2026.json';
import medicareJson from '../../data-defaults/assumptions/medicare-2026.json';

const data: TaxDataBundle = {
  federal: federalJson as unknown as FederalTaxData,
  states: {
    va: vaJson as unknown as StateTaxData,
    sc: scJson as unknown as StateTaxData,
    nc: ncJson as unknown as StateTaxData,
  },
  aca: acaJson as unknown as AcaData,
  medicare: medicareJson as unknown as MedicareData,
};

function inputs(partial: Partial<TaxYearInputs> = {}): TaxYearInputs {
  return {
    year: 2026,
    filingStatus: 'mfj',
    state: 'va',
    birthYears: [1971, 1971],
    agesAtYearEnd: [55, 55],
    wages: 0,
    taxableInterest: 0,
    ordinaryDividends: 0,
    qualifiedDividends: 0,
    pretaxDistributions: 0,
    rothConversionAmount: 0,
    ltcg: 0,
    socialSecurityGross: 0,
    distributions: [],
    taxExemptInterest: 0,
    otherOrdinaryIncome: 0,
    charitableGiving: 0,
    itemizable: { mortgageInterest: 0, propertyTax: 0 },
    aca: null,
    medicare: null,
    inflationIndex: 1,
    ...partial,
  };
}

function ruleOf55Dist(amount: number): RetirementDistribution {
  return {
    personId: 'p1',
    accountType: '401k',
    amount,
    taxableAmount: amount,
    penaltyException: 'rule_of_55',
    penaltyBase: 0,
  };
}

/** The bridge year the household actually faces: retired, living off the 401(k). */
function bridge2027(pretax: number, partial: Partial<TaxYearInputs> = {}): TaxYearInputs {
  return inputs({
    year: 2027,
    agesAtYearEnd: [56, 56],
    pretaxDistributions: pretax,
    distributions: [ruleOf55Dist(pretax)],
    aca: {
      enrolledMonths: 12,
      benchmarkAnnualPremium: 24_000,
      grossAnnualPremium: 24_000,
    },
    ...partial,
  });
}

// ---------------------------------------------------------------------------
// Full 2027 VA bridge year
// ---------------------------------------------------------------------------

describe('computeYear: 2027 VA bridge year (rule-of-55 401k withdrawals)', () => {
  it('90k of distributions: federal 6,440 + VA 3,752.55, no penalty, over the ACA cliff', () => {
    // Federal (index 1): other income = 90,000; no SS -> AGI = 90,000.
    //   SD = 32,200; VA tax feeds SALT: itemized = 0 + min(0 + 3,752.55,
    //   cap 40,804) = 3,752.55 < 32,200 -> standard. Taxable = 57,800.
    //   Tax = 10% x 24,800 + 12% x 33,000 = 2,480 + 3,960 = 6,440.
    // VA (from the preliminary standard pass; VA starts from AGI; the 2027
    //   scheduled standard deduction is 18,400 per va-2026.json byYear):
    //   90,000 - 18,400 (std) - 1,860 (2 x 930 exemptions) = 69,740.
    //   Tax = 2% x 3,000 + 3% x 2,000 + 5% x 12,000 + 5.75% x (69,740 - 17,000)
    //       = 720 + 5.75% x 52,740 = 720 + 3,032.55 = 3,752.55.
    // Penalty: rule of 55 -> penalty base 0 -> 0.
    // totalTax = 6,440 + 3,752.55 + 0 = 10,192.55.
    // ACA: acaMagi = 90,000; FPL(2-person) = 21,150 -> 425.5% FPL > 400% ->
    //   the pre-ARPA cliff forfeits the whole credit (2026 cliff law).
    const r = computeYear(bridge2027(90_000), data);
    expect(r.federal.agi).toBeCloseTo(90_000, 9);
    expect(r.federal.deductionUsed).toBe('standard');
    expect(r.federal.itemizedDeduction).toBeCloseTo(3_752.55, 6); // proves state tax reached SALT
    expect(r.federal.taxableIncome).toBeCloseTo(57_800, 9);
    expect(r.federal.total).toBeCloseTo(6_440, 9);
    expect(r.state.code).toBe('va');
    expect(r.state.taxableIncome).toBeCloseTo(69_740, 9);
    expect(r.state.total).toBeCloseTo(3_752.55, 9);
    expect(r.penalties).toBe(0);
    expect(r.totalTax).toBeCloseTo(10_192.55, 9);
    expect(r.aca).not.toBeNull();
    expect(r.aca?.cliffApplied).toBe(true);
    expect(r.aca?.ptc).toBe(0);
    expect(r.aca?.netPremium).toBeCloseTo(24_000, 9);
    // Headroom to the 84,600 cliff: 84,600 - 90,000 = -5,400 (over).
    expect(r.aca?.cliffHeadroom).toBeCloseTo(-5_400, 9);
    expect(r.medicare).toBeNull();
  });

  it('63,450 of distributions: PTC at exactly 300% FPL, totalTax composition holds', () => {
    // Federal: AGI = 63,450; SD 32,200 -> taxable 31,250.
    //   Tax = 2,480 + 12% x 6,450 = 2,480 + 774 = 3,254.
    // VA (2027 scheduled std 18,400): 63,450 - 18,400 - 1,860 = 43,190.
    //   Tax = 720 + 5.75% x (43,190 - 17,000) = 720 + 1,505.925 = 2,225.925.
    // totalTax = 3,254 + 2,225.925 + 0 = 5,479.925.
    // ACA: acaMagi = 63,450 = 3.0 x FPL (21,150). Applicable pct at 300% FPL
    //   (standard schedule, 3.0-4.0 row, flat) = 9.96%.
    //   Expected contribution = 0.0996 x 63,450 = 6,319.62.
    //   PTC = 24,000 - 6,319.62 = 17,680.38; net premium = 6,319.62.
    const r = computeYear(bridge2027(63_450), data);
    expect(r.federal.total).toBeCloseTo(3_254, 9);
    expect(r.state.total).toBeCloseTo(2_225.925, 9);
    expect(r.penalties).toBe(0);
    expect(r.totalTax).toBeCloseTo(5_479.925, 9);
    expect(r.totalTax).toBeCloseTo(r.federal.total + r.state.total + r.penalties, 12);
    expect(r.aca?.cliffApplied).toBe(false);
    expect(r.aca?.fplPct).toBeCloseTo(3.0, 9);
    expect(r.aca?.applicablePct).toBeCloseTo(0.0996, 9);
    expect(r.aca?.ptc).toBeCloseTo(17_680.38, 6);
    expect(r.aca?.netPremium).toBeCloseTo(6_319.62, 6);
    // ACA premiums are expense-side: totalTax must NOT include the net premium.
    expect(r.totalTax).toBeCloseTo(5_479.925, 9);
    expect(r.magi.acaMagi).toBeCloseTo(63_450, 9);
  });

  it('a penalized IRA withdrawal adds 10% to totalTax', () => {
    // Same 90k year but 10,000 of it from an IRA with no exception:
    // penalty = 10% x 10,000 = 1,000. Income taxes unchanged (same AGI).
    // totalTax = 6,440 + 3,752.55 + 1,000 = 11,192.55.
    const r = computeYear(
      bridge2027(90_000, {
        distributions: [
          ruleOf55Dist(80_000),
          {
            personId: 'p1',
            accountType: 'traditional_ira',
            amount: 10_000,
            taxableAmount: 10_000,
            penaltyException: 'none',
            penaltyBase: 10_000,
          },
        ],
      }),
      data,
    );
    expect(r.penalties).toBeCloseTo(1_000, 9);
    expect(r.totalTax).toBeCloseTo(11_192.55, 9);
  });
});

// ---------------------------------------------------------------------------
// State tax feeding the federal SALT itemization
// ---------------------------------------------------------------------------

describe('computeYear: state tax flows into the federal itemized deduction', () => {
  it('2026 VA, wages 150k, mortgage 25k + property tax 5k -> itemized wins', () => {
    // VA (starts from AGI; unaffected by the federal deduction choice):
    //   150,000 - 17,500 - 1,860 = 130,640.
    //   Tax = 720 + 5.75% x (130,640 - 17,000) = 720 + 6,534.30 = 7,254.30.
    // Federal: itemized = 25,000 + min(5,000 + 7,254.30, cap 40,400)
    //   = 25,000 + 12,254.30 = 37,254.30 > SD 32,200 -> itemized.
    //   Taxable = 150,000 - 37,254.30 = 112,745.70.
    //   Tax = 2,480 + 9,120 + 22% x (112,745.70 - 100,800)
    //       = 11,600 + 22% x 11,945.70 = 11,600 + 2,628.054 = 14,228.054.
    // totalTax = 14,228.054 + 7,254.30 = 21,482.354.
    const r = computeYear(
      inputs({
        wages: 150_000,
        itemizable: { mortgageInterest: 25_000, propertyTax: 5_000 },
      }),
      data,
    );
    expect(r.state.total).toBeCloseTo(7_254.3, 9);
    expect(r.federal.itemizedDeduction).toBeCloseTo(37_254.3, 6);
    expect(r.federal.deductionUsed).toBe('itemized');
    expect(r.federal.taxableIncome).toBeCloseTo(112_745.7, 6);
    expect(r.federal.total).toBeCloseTo(14_228.054, 6);
    expect(r.totalTax).toBeCloseTo(21_482.354, 6);
  });
});

// ---------------------------------------------------------------------------
// Charitable giving is FEDERAL-ONLY in this model
// ---------------------------------------------------------------------------

describe('computeYear: charitable giving never reaches state tax', () => {
  it('2026 VA, wages 150k, mortgage 25k + property 5k, gifts 12k', () => {
    // VA is computed from the PRELIMINARY standard-deduction federal pass and
    // starts from federal AGI, which charitable giving does not move (§170(p)
    // is a §63(b)(4) taxable-income deduction, and the itemized charitable
    // component is a federal itemized deduction VA does not follow — VA uses
    // its own standard deduction). So VA is bit-identical to the no-giving run:
    //   150,000 - 17,500 (VA std, TY2026) - 1,860 (2 x 930 exemptions)
    //     = 130,640.
    //   Tax = 2% x 3,000 + 3% x 2,000 + 5% x 12,000 + 5.75% x (130,640 - 17,000)
    //       = 720 + 5.75% x 113,640 = 720 + 6,534.30 = 7,254.30.
    // Federal: AGI = 150,000; floor = 0.005 x 150,000 = 750; ceiling =
    //   0.60 x 150,000 = 90,000 -> charitable = min(12,000, 90,000) - 750
    //   = 11,250.
    //   Itemized = 25,000 + min(5,000 + 7,254.30, cap 40,400) (= 12,254.30)
    //     + 11,250 = 48,504.30 > SD 32,200 -> itemized.
    //   Taxable = 150,000 - 48,504.30 = 101,495.70.
    //   Tax = 2,480 + 9,120 + 22% x (101,495.70 - 100,800 = 695.70)
    //       (= 153.054) = 11,753.054.
    // totalTax = 11,753.054 + 7,254.30 = 19,007.354.
    const r = computeYear(
      inputs({
        wages: 150_000,
        charitableGiving: 12_000,
        itemizable: { mortgageInterest: 25_000, propertyTax: 5_000 },
      }),
      data,
    );
    expect(r.state.taxableIncome).toBeCloseTo(130_640, 9);
    expect(r.state.total).toBeCloseTo(7_254.3, 9);
    expect(r.federal.itemizedDeduction).toBeCloseTo(48_504.3, 6);
    expect(r.federal.deductionUsed).toBe('itemized');
    expect(r.federal.taxableIncome).toBeCloseTo(101_495.7, 6);
    expect(r.federal.total).toBeCloseTo(11_753.054, 6);
    expect(r.totalTax).toBeCloseTo(19_007.354, 6);
    expect(r.magi.agi).toBeCloseTo(150_000, 9);
  });

  it('state tax is invariant to giving in all three states (itemizer and non-itemizer)', () => {
    // Both the itemized charitable component and the §170(p) non-itemizer
    // deduction are federal-only: VA subtracts its own standard deduction,
    // SC starts from federal AGI and applies the SCIAD, NC applies its own
    // standard deduction. None of them sees a federal charitable number, so
    // state taxable income and state tax must be identical with and without
    // giving — for an itemizing filer AND a standard-deduction filer.
    for (const state of ['va', 'sc', 'nc'] as const) {
      for (const itemizable of [
        { mortgageInterest: 25_000, propertyTax: 5_000 }, // itemizer
        { mortgageInterest: 0, propertyTax: 0 }, // non-itemizer
      ]) {
        const none = computeYear(
          inputs({ wages: 150_000, state, itemizable, charitableGiving: 0 }),
          data,
        );
        const giving = computeYear(
          inputs({ wages: 150_000, state, itemizable, charitableGiving: 12_000 }),
          data,
        );
        expect(giving.state.taxableIncome).toBe(none.state.taxableIncome);
        expect(giving.state.total).toBe(none.state.total);
        // ...and the federal bill really did fall, so the test is not vacuous.
        expect(giving.federal.total).toBeLessThan(none.federal.total);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Other states route through data.states correctly
// ---------------------------------------------------------------------------

describe('computeYear: SC and NC routing', () => {
  it('2027 SC bridge year: SCIAD phase-out + retirement deduction', () => {
    // Federal: AGI 90,000 -> taxable 57,800 -> tax 6,440 (as in the VA case;
    //   SC tax 2,145.79 stays under the 32,200 SD, so still standard).
    // SC: SCIAD factor = 1 - (90,000 - 80,000)/110,000 = 10/11
    //   -> SCIAD = 30,000 x 10/11 = 27,272.727272...
    //   Retirement deduction (p1, under 65, 401k taxable 90,000) = min(90,000,
    //   3,000) = 3,000.
    //   Taxable = 90,000 - 27,272.7272... - 3,000 = 59,727.272727...
    //   Tax = 1.99% x 30,000 + 5.21% x 29,727.2727... = 597 + 1,548.790909...
    //       = 2,145.790909... (cross-check: 5.21% x 59,727.27 - 966 = 2,145.79).
    // totalTax = 6,440 + 2,145.790909... = 8,585.790909...
    const r = computeYear(bridge2027(90_000, { state: 'sc', aca: null }), data);
    expect(r.state.code).toBe('sc');
    expect(r.state.taxableIncome).toBeCloseTo(59_727.272727272728, 6);
    expect(r.state.total).toBeCloseTo(2_145.7909090909, 6);
    expect(r.federal.total).toBeCloseTo(6_440, 9);
    expect(r.totalTax).toBeCloseTo(8_585.7909090909, 6);
  });

  it('2026 NC: flat 3.99% after the 25,500 standard deduction', () => {
    // NC: 100,000 - 25,500 = 74,500 -> tax = 74,500 x 3.99% = 2,972.55.
    // Federal: itemized = min(2,972.55, 40,400) = 2,972.55 < 32,200 -> standard.
    //   Taxable = 67,800 -> tax = 2,480 + 12% x 43,000 = 7,640.
    // totalTax = 7,640 + 2,972.55 = 10,612.55.
    const r = computeYear(inputs({ state: 'nc', wages: 100_000 }), data);
    expect(r.state.code).toBe('nc');
    expect(r.state.taxableIncome).toBeCloseTo(74_500, 9);
    expect(r.state.total).toBeCloseTo(2_972.55, 9);
    expect(r.federal.total).toBeCloseTo(7_640, 9);
    expect(r.totalTax).toBeCloseTo(10_612.55, 9);
  });
});

// ---------------------------------------------------------------------------
// Social Security plumbing through federal AND state
// ---------------------------------------------------------------------------

describe('computeYear: Social Security year (2036, both 65)', () => {
  it('taxable SS reaches the federal side and is exempted by the state', () => {
    // SS 40,000 gross + 20,000 pretax: PI = 20,000 + 20,000 = 40,000 ->
    //   taxable SS = min(0.5 x 8,000, 20,000) = 4,000. AGI = 24,000.
    // Federal: SD = 32,200 + 2 x 1,650 = 35,500 > AGI -> taxable 0, tax 0.
    // VA: 24,000 - 4,000 (SS exempt) - 17,500 - 3,460 (2x930 + 2x800) is
    //   already negative before the age deduction -> taxable 0, tax 0.
    const r = computeYear(
      inputs({
        year: 2036,
        agesAtYearEnd: [65, 65],
        pretaxDistributions: 20_000,
        socialSecurityGross: 40_000,
      }),
      data,
    );
    expect(r.federal.ssTaxableAmount).toBeCloseTo(4_000, 9);
    expect(r.federal.agi).toBeCloseTo(24_000, 9);
    expect(r.federal.standardDeduction).toBeCloseTo(35_500, 9);
    expect(r.federal.taxableIncome).toBe(0);
    expect(r.state.taxableIncome).toBe(0);
    expect(r.totalTax).toBe(0);
    // MAGI variants: acaMagi adds back the 36,000 of untaxed SS.
    expect(r.magi.acaMagi).toBeCloseTo(60_000, 9);
    expect(r.magi.irmaaMagi).toBeCloseTo(24_000, 9);
  });
});

// ---------------------------------------------------------------------------
// Medicare year
// ---------------------------------------------------------------------------

describe('computeYear: Medicare year (2036, both enrolled all year)', () => {
  it('premiums computed but excluded from totalTax (expense-side)', () => {
    // Index held at 1 to keep the arithmetic transparent.
    // Federal: AGI 50,000; SD 35,500 -> taxable 14,500 -> tax = 10% x 14,500
    //   = 1,450.
    // VA (2036 is past the legislated schedule -> 6,000 fallback std):
    //   50,000 - 6,000 - 3,460 - age deduction 24,000 (AFAGI 50,000 <
    //   75,000 -> full 2 x 12,000) = 16,540.
    //   Tax = 2% x 3,000 + 3% x 2,000 + 5% x (16,540 - 5,000)
    //       = 60 + 60 + 577 = 697.
    // totalTax = 1,450 + 697 = 2,147.
    // Medicare (MAGI lookback 100,000 <= 218,000 -> no IRMAA):
    //   Part B = 202.90 x 24 person-months = 4,869.60.
    //   Part D plan = 40 x 24 = 960. Total premiums = 5,829.60.
    const r = computeYear(
      inputs({
        year: 2036,
        agesAtYearEnd: [65, 65],
        pretaxDistributions: 50_000,
        medicare: {
          enrolledMonthsPerPerson: [12, 12],
          magiTwoYearsPrior: 100_000,
          partDPlanMonthly: 40,
          premiumIndex: 1,
        },
      }),
      data,
    );
    expect(r.federal.total).toBeCloseTo(1_450, 9);
    expect(r.state.total).toBeCloseTo(697, 9);
    expect(r.totalTax).toBeCloseTo(2_147, 9);
    expect(r.medicare).not.toBeNull();
    expect(r.medicare?.partB).toBeCloseTo(4_869.6, 6);
    expect(r.medicare?.partDPlan).toBeCloseTo(960, 9);
    expect(r.medicare?.irmaaPartB).toBe(0);
    expect(r.medicare?.tierIndex).toBe(0);
    expect(r.medicare?.total).toBeCloseTo(5_829.6, 6);
    expect(r.aca).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Trace behavior
// ---------------------------------------------------------------------------

describe('computeYear: trace', () => {
  it('opts.trace collects federal, state, and ACA lines in reading order', () => {
    const r = computeYear(bridge2027(63_450), data, { trace: true });
    expect(r.trace).toBeDefined();
    const labels = (r.trace ?? []).map((l) => l.label);
    expect(labels.length).toBeGreaterThan(0);
    expect(labels[0]).toContain('Tax year 2027');
    expect(labels).toContain('Federal income tax (2027)');
    expect(labels).toContain('Virginia state tax (2027)');
    expect(labels).toContain('ACA premium tax credit (Form 8962 true-up)');
    expect(labels[labels.length - 1]).toBe('Total tax (federal + state + penalties)');
    // Federal lines precede state lines even though state is computed first.
    expect(labels.indexOf('Federal income tax (2027)')).toBeLessThan(
      labels.indexOf('Virginia state tax (2027)'),
    );
    // The final total line carries the returned amount.
    const totalLine = (r.trace ?? []).find(
      (l) => l.label === 'Total tax (federal + state + penalties)',
    );
    expect(totalLine?.amount).toBeCloseTo(r.totalTax, 9);
  });

  it('the ACA cliff is flagged in the trace when it applies', () => {
    const r = computeYear(bridge2027(90_000), data, { trace: true });
    const hasCliffLine = (r.trace ?? []).some((l) => l.label.toLowerCase().includes('cliff'));
    expect(hasCliffLine).toBe(true);
  });

  it('no trace field and identical numbers when tracing is off', () => {
    const traced = computeYear(bridge2027(63_450), data, { trace: true });
    const untraced = computeYear(bridge2027(63_450), data);
    const explicitlyOff = computeYear(bridge2027(63_450), data, { trace: false });
    expect(untraced.trace).toBeUndefined();
    expect(explicitlyOff.trace).toBeUndefined();
    const { trace: _trace, ...tracedRest } = traced;
    expect(tracedRest).toEqual(untraced);
  });
});

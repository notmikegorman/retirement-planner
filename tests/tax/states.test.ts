/**
 * Unit tests for src/tax/states.ts (VA / SC / NC state income tax, TY2026 law).
 *
 * Every expected value is hand-computed; the arithmetic is spelled out in a
 * comment above each assertion. Data comes from the verified default data
 * files so the tests double as regression tests on those files.
 */

import { describe, expect, it } from 'vitest';
import { computeStateTax, type FederalSummaryForState } from '../../src/tax/states';
import type {
  RetirementDistribution,
  StateTaxData,
  TaxYearInputs,
  TraceLine,
} from '../../src/shared/types';
import vaJson from '../../data-defaults/assumptions/tax/va-2026.json';
import scJson from '../../data-defaults/assumptions/tax/sc-2026.json';
import ncJson from '../../data-defaults/assumptions/tax/nc-2026.json';

const va = vaJson as unknown as StateTaxData;
const sc = scJson as unknown as StateTaxData;
const nc = ncJson as unknown as StateTaxData;

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

function fed(partial: Partial<FederalSummaryForState> = {}): FederalSummaryForState {
  return {
    agi: 0,
    taxableIncome: 0,
    ssTaxableAmount: 0,
    standardDeduction: 32200,
    itemizedDeduction: 0,
    deductionUsed: 'standard',
    ...partial,
  };
}

function dist(
  personId: string,
  accountType: RetirementDistribution['accountType'],
  taxableAmount: number,
): RetirementDistribution {
  return {
    personId,
    accountType,
    amount: taxableAmount,
    taxableAmount,
    penaltyException: 'age_59_5',
    penaltyBase: 0,
  };
}

// ---------------------------------------------------------------------------
// Virginia
// ---------------------------------------------------------------------------

describe('Virginia (2026)', () => {
  it('65+, AFAGI under the age-deduction phaseout: full $24,000 age deduction', () => {
    // Both age 65 (year 2036 — past the legislated schedule, so the $6,000
    // post-2029 fallback standard deduction applies).
    // AGI = 80,000; federally taxable SS = 10,000.
    // AFAGI = 80,000 - 10,000 = 70,000 < 75,000 -> full age deduction 2 x 12,000 = 24,000.
    // Exemptions = 2 x 930 + 2 x 800 = 1,860 + 1,600 = 3,460.
    // Taxable = 80,000 - 10,000 (SS) - 6,000 (std fallback) - 3,460 - 24,000 = 36,540.
    // Tax = 2% x 3,000 + 3% x 2,000 + 5% x 12,000 + 5.75% x (36,540 - 17,000)
    //     = 60 + 60 + 600 + 5.75% x 19,540 = 720 + 1,123.55 = 1,843.55.
    const r = computeStateTax(
      inputs({ year: 2036, agesAtYearEnd: [65, 65] }),
      va,
      fed({ agi: 80_000, ssTaxableAmount: 10_000 }),
    );
    expect(r.taxableIncome).toBeCloseTo(36_540, 6);
    expect(r.total).toBeCloseTo(1_843.55, 6);
  });

  it('65+, AFAGI partially into the phaseout: age deduction reduced $1-for-$1', () => {
    // Year 2036 -> $6,000 fallback standard deduction.
    // AGI = 95,000; taxable SS = 5,000. AFAGI = 90,000 -> excess over 75,000 = 15,000.
    // Age deduction = max(0, 24,000 - 15,000) = 9,000. Exemptions = 3,460.
    // Taxable = 95,000 - 5,000 - 6,000 - 3,460 - 9,000 = 71,540.
    // Tax = 720 + 5.75% x (71,540 - 17,000) = 720 + 5.75% x 54,540 = 720 + 3,136.05 = 3,856.05.
    const r = computeStateTax(
      inputs({ year: 2036, agesAtYearEnd: [65, 65] }),
      va,
      fed({ agi: 95_000, ssTaxableAmount: 5_000 }),
    );
    expect(r.taxableIncome).toBeCloseTo(71_540, 6);
    expect(r.total).toBeCloseTo(3_856.05, 6);
  });

  it('65+, AFAGI far over the phaseout: age deduction fully eliminated', () => {
    // Year 2036 -> $6,000 fallback standard deduction.
    // AGI = 110,000; taxable SS = 5,000. AFAGI = 105,000 -> excess = 30,000 > 24,000.
    // Age deduction = max(0, 24,000 - 30,000) = 0. Exemptions = 3,460.
    // Taxable = 110,000 - 5,000 - 6,000 - 3,460 = 95,540.
    // Tax = 720 + 5.75% x (95,540 - 17,000) = 720 + 5.75% x 78,540 = 720 + 4,516.05 = 5,236.05.
    const r = computeStateTax(
      inputs({ year: 2036, agesAtYearEnd: [65, 65] }),
      va,
      fed({ agi: 110_000, ssTaxableAmount: 5_000 }),
    );
    expect(r.taxableIncome).toBeCloseTo(95_540, 6);
    expect(r.total).toBeCloseTo(5_236.05, 6);
  });

  it('age 55: no age deduction, no 65+ exemption add-on', () => {
    // AGI = 100,000; no SS. Exemptions = 2 x 930 = 1,860 (no 800 add-ons).
    // Taxable = 100,000 - 17,500 - 1,860 = 80,640.
    // Tax = 720 + 5.75% x (80,640 - 17,000) = 720 + 5.75% x 63,640 = 720 + 3,659.30 = 4,379.30.
    const r = computeStateTax(inputs(), va, fed({ agi: 100_000 }));
    expect(r.taxableIncome).toBeCloseTo(80_640, 6);
    expect(r.total).toBeCloseTo(4_379.3, 6);
  });

  it('tax is exactly the sum of the sub-5.75% brackets at the $17,000 boundary', () => {
    // Choose AGI so taxable lands exactly on the top of the 5% bracket:
    // AGI - 17,500 - 1,860 = 17,000 -> AGI = 36,360.
    // Tax = 2% x 3,000 + 3% x 2,000 + 5% x 12,000 = 60 + 60 + 600 = 720.
    const r = computeStateTax(inputs(), va, fed({ agi: 36_360 }));
    expect(r.taxableIncome).toBeCloseTo(17_000, 6);
    expect(r.total).toBeCloseTo(720, 6);
  });

  it('unindexed data ignores inflationIndex', () => {
    // Same case as the age-55 test but with inflationIndex 1.5: indexed=false
    // so thresholds and deductions must NOT scale -> identical result.
    const r = computeStateTax(inputs({ inflationIndex: 1.5 }), va, fed({ agi: 100_000 }));
    expect(r.taxableIncome).toBeCloseTo(80_640, 6);
    expect(r.total).toBeCloseTo(4_379.3, 6);
  });
});

describe('Virginia standard-deduction schedule (2026 Appropriation Act, §58.1-322.03)', () => {
  // Age 55, AGI = 100,000, no SS. Exemptions = 2 x 930 = 1,860.
  // Taxable = 100,000 - std(year) - 1,860; the year is the only variable.
  // Sub-5.75% brackets always contribute 60 + 60 + 600 = 720.
  const cases: Array<{ year: number; std: number; taxable: number; tax: number }> = [
    // 2026 -> 17,500: taxable = 100,000 - 17,500 - 1,860 = 80,640.
    //   Tax = 720 + 5.75% x (80,640 - 17,000) = 720 + 3,659.30 = 4,379.30.
    { year: 2026, std: 17_500, taxable: 80_640, tax: 4_379.3 },
    // 2027 -> 18,400: taxable = 100,000 - 18,400 - 1,860 = 79,740.
    //   Tax = 720 + 5.75% x (79,740 - 17,000) = 720 + 3,607.55 = 4,327.55.
    { year: 2027, std: 18_400, taxable: 79_740, tax: 4_327.55 },
    // 2029 -> 18,600: taxable = 100,000 - 18,600 - 1,860 = 79,540.
    //   Tax = 720 + 5.75% x (79,540 - 17,000) = 720 + 3,596.05 = 4,316.05.
    { year: 2029, std: 18_600, taxable: 79_540, tax: 4_316.05 },
    // 2031 -> statutory reversion, standardDeductionMfj fallback 6,000:
    //   taxable = 100,000 - 6,000 - 1,860 = 92,140.
    //   Tax = 720 + 5.75% x (92,140 - 17,000) = 720 + 4,320.55 = 5,040.55.
    { year: 2031, std: 6_000, taxable: 92_140, tax: 5_040.55 },
  ];

  for (const c of cases) {
    it(`${c.year}: standard deduction ${c.std}`, () => {
      const r = computeStateTax(inputs({ year: c.year }), va, fed({ agi: 100_000 }));
      expect(r.taxableIncome).toBeCloseTo(c.taxable, 6);
      expect(r.total).toBeCloseTo(c.tax, 6);
    });
  }

  it('the byYear map takes precedence over standardDeductionMfj for mapped years', () => {
    // The shipped file has standardDeductionMfj 6,000 (fallback) but maps
    // 2026 -> 17,500; the mapped value must win for 2026.
    expect(va.standardDeductionMfj).toBe(6_000);
    expect(va.standardDeductionMfjByYear?.['2026']).toBe(17_500);
    const r = computeStateTax(inputs({ year: 2026 }), va, fed({ agi: 100_000 }));
    expect(r.taxableIncome).toBeCloseTo(80_640, 6);
  });
});

// ---------------------------------------------------------------------------
// South Carolina (TY2026, H.4216)
// ---------------------------------------------------------------------------

describe('South Carolina (2026)', () => {
  it('SCIAD intact (FAGI < 80k); under-65 retirement deduction capped at $3,000; Roth ignored', () => {
    // Ages 55/55. AGI = 70,000, no SS.
    // p1 takes 20,000 taxable from the 401(k) (rule of 55) -> retirement
    // deduction min(20,000, 3,000) = 3,000. A Roth distribution must NOT count.
    // SCIAD: FAGI 70,000 < 80,000 -> full 30,000.
    // Taxable = 70,000 - 30,000 - 3,000 = 37,000.
    // Tax = 1.99% x 30,000 + 5.21% x 7,000 = 597 + 364.70 = 961.70.
    // Cross-check vs statutory form: 5.21% x 37,000 - 966 = 1,927.70 - 966 = 961.70.
    const r = computeStateTax(
      inputs({
        state: 'sc',
        distributions: [dist('p1', '401k', 20_000), dist('p1', 'roth_ira', 2_000)],
      }),
      sc,
      fed({ agi: 70_000 }),
    );
    expect(r.taxableIncome).toBeCloseTo(37_000, 6);
    expect(r.total).toBeCloseTo(961.7, 6);
  });

  it('SCIAD half phased out at FAGI 135,000', () => {
    // Ages 55/55, no distributions, no SS. FAGI = 135,000.
    // Phaseout factor = 1 - (135,000 - 80,000) / 110,000 = 1 - 0.5 = 0.5.
    // SCIAD = 30,000 x 0.5 = 15,000. Taxable = 135,000 - 15,000 = 120,000.
    // Tax = 1.99% x 30,000 + 5.21% x 90,000 = 597 + 4,689 = 5,286.
    // Cross-check: 5.21% x 120,000 - 966 = 6,252 - 966 = 5,286.
    const r = computeStateTax(inputs({ state: 'sc' }), sc, fed({ agi: 135_000 }));
    expect(r.taxableIncome).toBeCloseTo(120_000, 6);
    expect(r.total).toBeCloseTo(5_286, 6);
  });

  it('SCIAD fully phased out at FAGI >= 190,000', () => {
    // FAGI = 200,000 -> factor = max(0, 1 - 120,000/110,000) = 0 -> SCIAD = 0.
    // Taxable = 200,000. Tax = 597 + 5.21% x 170,000 = 597 + 8,857 = 9,454.
    const r = computeStateTax(inputs({ state: 'sc' }), sc, fed({ agi: 200_000 }));
    expect(r.taxableIncome).toBeCloseTo(200_000, 6);
    expect(r.total).toBeCloseTo(9_454, 6);
  });

  it('65+: retirement deduction ($10k cap) and senior deduction interplay', () => {
    // Ages 65/65 (year 2036). AGI = 135,000; federally taxable SS = 20,000.
    // Distributions: p1 traditional IRA 40,000 taxable; p2 401(k) 4,000 taxable.
    // Retirement deduction: p1 min(40,000, 10,000) = 10,000; p2 min(4,000, 10,000) = 4,000
    //   -> total 14,000.
    // Senior deduction: p1 max(0, 15,000 - 10,000) = 5,000; p2 max(0, 15,000 - 4,000) = 11,000
    //   -> total 16,000.
    // SCIAD: FAGI 135,000 -> factor 0.5 -> 15,000.
    // Taxable = 135,000 - 20,000 (SS) - 15,000 (SCIAD) - 14,000 - 16,000 = 70,000.
    // Tax = 1.99% x 30,000 + 5.21% x 40,000 = 597 + 2,084 = 2,681.
    // Cross-check: 5.21% x 70,000 - 966 = 3,647 - 966 = 2,681.
    const r = computeStateTax(
      inputs({
        year: 2036,
        agesAtYearEnd: [65, 65],
        state: 'sc',
        distributions: [dist('p1', 'traditional_ira', 40_000), dist('p2', '401k', 4_000)],
      }),
      sc,
      fed({ agi: 135_000, ssTaxableAmount: 20_000 }),
    );
    expect(r.taxableIncome).toBeCloseTo(70_000, 6);
    expect(r.total).toBeCloseTo(2_681, 6);
  });

  it('65+: person with no distributions gets the full $15,000 senior deduction', () => {
    // Ages 65/65. AGI = 100,000; taxable SS = 10,000. Only p1 distributes:
    // traditional IRA 8,000 taxable -> retirement deduction min(8,000, 10,000) = 8,000.
    // Senior: p1 = 15,000 - 8,000 = 7,000; p2 (claimed 0) = 15,000 -> total 22,000.
    // SCIAD: factor = 1 - (100,000 - 80,000)/110,000 = 1 - 2/11 = 9/11
    //   -> SCIAD = 30,000 x 9/11 = 24,545.454545...
    // Taxable = 100,000 - 10,000 - 24,545.454545... - 8,000 - 22,000 = 35,454.545454...
    // Tax = 597 + 5.21% x (35,454.5454... - 30,000) = 597 + 5.21% x 5,454.5454...
    //     = 597 + 284.181818... = 881.181818...
    // Cross-check: 5.21% x 35,454.5454... - 966 = 1,847.1818... - 966 = 881.1818...
    const r = computeStateTax(
      inputs({
        year: 2036,
        agesAtYearEnd: [65, 65],
        state: 'sc',
        distributions: [dist('p1', 'traditional_ira', 8_000)],
      }),
      sc,
      fed({ agi: 100_000, ssTaxableAmount: 10_000 }),
    );
    expect(r.taxableIncome).toBeCloseTo(35_454.545454545456, 6);
    expect(r.total).toBeCloseTo(881.1818181818182, 6);
  });
});

// ---------------------------------------------------------------------------
// North Carolina
// ---------------------------------------------------------------------------

describe('North Carolina', () => {
  it('2026: flat 3.99% on AGI minus SS minus $25,500 standard deduction', () => {
    // AGI = 100,000; taxable SS = 12,000.
    // Taxable = 100,000 - 12,000 - 25,500 = 62,500.
    // Tax = 62,500 x 3.99% = 2,493.75.
    const r = computeStateTax(
      inputs({ state: 'nc' }),
      nc,
      fed({ agi: 100_000, ssTaxableAmount: 12_000 }),
    );
    expect(r.taxableIncome).toBeCloseTo(62_500, 6);
    expect(r.total).toBeCloseTo(2_493.75, 6);
  });

  it('year in flatRateByYear map is used (2025 -> 4.25%)', () => {
    // Taxable = 100,000 - 12,000 - 25,500 = 62,500. Tax = 62,500 x 4.25% = 2,656.25.
    const r = computeStateTax(
      inputs({ state: 'nc', year: 2025 }),
      nc,
      fed({ agi: 100_000, ssTaxableAmount: 12_000 }),
    );
    expect(r.total).toBeCloseTo(2_656.25, 6);
  });

  it('year beyond the map falls back to flatRateFallback', () => {
    // Modified copy: fallback 3.5% so the fallback path is observable.
    // Year 2040 not in map -> 62,500 x 3.5% = 2,187.50.
    const ncMod: StateTaxData = { ...nc, flatRateFallback: 0.035 };
    const r = computeStateTax(
      inputs({ state: 'nc', year: 2040 }),
      ncMod,
      fed({ agi: 100_000, ssTaxableAmount: 12_000 }),
    );
    expect(r.taxableIncome).toBeCloseTo(62_500, 6);
    expect(r.total).toBeCloseTo(2_187.5, 6);
  });
});

// ---------------------------------------------------------------------------
// Cross-state mechanics
// ---------------------------------------------------------------------------

describe('Social Security exemption (all three states)', () => {
  it('adding $10,000 of federally taxable SS reduces state taxable income by exactly $10,000', () => {
    // Hold AGI fixed and flip ssTaxableAmount 0 -> 10,000. In VA use age 55 so
    // the age deduction cannot interact (AFAGI is irrelevant under 65).
    const cases: Array<{ data: StateTaxData; agi: number }> = [
      { data: va, agi: 100_000 }, // 80,640 vs 70,640
      { data: sc, agi: 70_000 }, // 40,000 vs 30,000 (SCIAD keys off FAGI, unchanged)
      { data: nc, agi: 100_000 }, // 74,500 vs 64,500
    ];
    for (const c of cases) {
      const base = computeStateTax(inputs({ state: c.data.state }), c.data, fed({ agi: c.agi }));
      const withSs = computeStateTax(
        inputs({ state: c.data.state }),
        c.data,
        fed({ agi: c.agi, ssTaxableAmount: 10_000 }),
      );
      expect(base.taxableIncome - withSs.taxableIncome).toBeCloseTo(10_000, 6);
      expect(withSs.total).toBeLessThan(base.total);
    }
  });

  it('SC: taxable income of exactly $30,000 taxes entirely at 1.99% (bracket edge)', () => {
    // AGI 70,000, SS 10,000 -> 70,000 - 10,000 - 30,000 (SCIAD) = 30,000.
    // Tax = 1.99% x 30,000 = 597 exactly; nothing reaches the 5.21% bracket.
    const r = computeStateTax(
      inputs({ state: 'sc' }),
      sc,
      fed({ agi: 70_000, ssTaxableAmount: 10_000 }),
    );
    expect(r.taxableIncome).toBeCloseTo(30_000, 6);
    expect(r.total).toBeCloseTo(597, 6);
  });
});

describe('zero-income floors', () => {
  it('taxable income and tax floor at 0 in all three states', () => {
    // VA: 15,000 - 17,500 - 1,860 < 0 -> 0.
    // SC: 25,000 - 30,000 < 0 -> 0.
    // NC: 20,000 - 25,500 < 0 -> 0.
    const cases: Array<{ data: StateTaxData; agi: number }> = [
      { data: va, agi: 15_000 },
      { data: sc, agi: 25_000 },
      { data: nc, agi: 20_000 },
    ];
    for (const c of cases) {
      const r = computeStateTax(inputs({ state: c.data.state }), c.data, fed({ agi: c.agi }));
      expect(r.taxableIncome).toBe(0);
      expect(r.total).toBe(0);
    }
  });

  it('zero AGI yields zero tax', () => {
    const r = computeStateTax(inputs(), va, fed({ agi: 0 }));
    expect(r.taxableIncome).toBe(0);
    expect(r.total).toBe(0);
  });
});

describe('generic mechanics', () => {
  it("startingPoint 'federal_taxable_income' uses fed.taxableIncome and skips the state standard deduction", () => {
    // Hypothetical state: flat-ish single 5% bracket, standard deduction
    // present but must be IGNORED because the starting point already nets out
    // the federal deduction. SS still subtracted.
    // Taxable = 50,000 (fed taxable income) - 5,000 (SS) = 45,000. AGI (90,000) unused.
    // Tax = 5% x 45,000 = 2,250.
    const hypo: StateTaxData = {
      state: 'sc',
      baseYear: 2026,
      kind: 'brackets',
      brackets: [{ rate: 0.05, upTo: null }],
      standardDeductionMfj: 12_345,
      startingPoint: 'federal_taxable_income',
      socialSecurityTaxed: false,
      indexed: false,
    };
    const r = computeStateTax(
      inputs({ state: 'sc' }),
      hypo,
      fed({ agi: 90_000, taxableIncome: 50_000, ssTaxableAmount: 5_000 }),
    );
    expect(r.taxableIncome).toBeCloseTo(45_000, 6);
    expect(r.total).toBeCloseTo(2_250, 6);
  });

  it('indexed=true scales bracket thresholds (and deductions) by inflationIndex', () => {
    // Hypothetical indexed state, inflationIndex = 2:
    // 2% bracket top 3,000 -> 6,000; standard deduction 5,000 -> 10,000.
    // AGI 30,000 -> taxable = 30,000 - 10,000 = 20,000.
    // Tax = 2% x 6,000 + 5.75% x (20,000 - 6,000) = 120 + 805 = 925.
    const hypo: StateTaxData = {
      state: 'va',
      baseYear: 2026,
      kind: 'brackets',
      brackets: [
        { rate: 0.02, upTo: 3_000 },
        { rate: 0.0575, upTo: null },
      ],
      standardDeductionMfj: 5_000,
      startingPoint: 'federal_agi',
      socialSecurityTaxed: false,
      indexed: true,
    };
    const r = computeStateTax(inputs({ inflationIndex: 2 }), hypo, fed({ agi: 30_000 }));
    expect(r.taxableIncome).toBeCloseTo(20_000, 6);
    expect(r.total).toBeCloseTo(925, 6);
  });
});

// ---------------------------------------------------------------------------
// Trace
// ---------------------------------------------------------------------------

describe('trace', () => {
  it('populates a readable walkthrough when a trace array is provided', () => {
    const trace: TraceLine[] = [];
    const r = computeStateTax(
      inputs({ year: 2036, agesAtYearEnd: [65, 65] }),
      va,
      fed({ agi: 80_000, ssTaxableAmount: 10_000 }),
      trace,
    );
    const labels = trace.map((l) => l.label);
    expect(labels[0]).toBe('Virginia state tax (2036)');
    expect(labels).toContain('Starting point: federal AGI');
    expect(labels).toContain('Less: federally taxable Social Security (state-exempt)');
    expect(labels).toContain('Less: Virginia standard deduction (MFJ)');
    expect(labels).toContain('Less: personal exemptions');
    expect(labels).toContain('Less: age deduction (65+)');
    // The taxable-income and final-tax lines carry the returned amounts.
    const taxableLine = trace.find((l) => l.label === 'Virginia taxable income');
    expect(taxableLine?.amount).toBeCloseTo(r.taxableIncome, 6);
    const taxLine = trace.find((l) => l.label === 'Virginia tax');
    expect(taxLine?.amount).toBeCloseTo(r.total, 6);
    // Bracket detail rows are present (36,540 spans all four VA brackets).
    expect(labels.filter((l) => l.endsWith('bracket')).length).toBe(4);
  });

  it('result is identical with and without tracing', () => {
    const trace: TraceLine[] = [];
    const args = [
      inputs({
        year: 2036,
        agesAtYearEnd: [65, 65],
        state: 'sc',
        distributions: [dist('p1', 'traditional_ira', 40_000), dist('p2', '401k', 4_000)],
      }),
      sc,
      fed({ agi: 135_000, ssTaxableAmount: 20_000 }),
    ] as const;
    const traced = computeStateTax(args[0], args[1], args[2], trace);
    const untraced = computeStateTax(args[0], args[1], args[2]);
    expect(traced).toEqual(untraced);
    expect(trace.length).toBeGreaterThan(0);
  });
});

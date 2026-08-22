/**
 * Unit tests for src/tax/federal.ts against the verified TY2026 numbers in
 * data-defaults/assumptions/tax/federal-2026.json.
 *
 * Every expected value is hand-computed; the arithmetic is spelled out in a
 * comment above each assertion. These become part of the frozen §8 suite.
 *
 * 2026 reference numbers used throughout:
 *   MFJ brackets: 10% to 24,800; 12% to 100,800; 22% to 211,400; 24% to
 *     403,550; 32% to 512,450; 35% to 768,700; 37% above.
 *   Standard deduction 32,200 (+1,650 per spouse 65+).
 *   LTCG breakpoints: 0% top 98,900; 15% top 613,700.
 *   NIIT: 3.8% over 250,000 MAGI (statutory). SS thresholds 32,000/44,000
 *     (statutory). SALT cap 2026: 40,400 (phase-down 30% over 505,000 MAGI,
 *     floor 10,000); fallback 10,000.
 */

import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  bracketTax,
  computeFederal,
  computeFederalIncomePieces,
  indexAmount,
  saltCap,
  ssTaxableWorksheet,
} from '../../src/tax/federal';
import type {
  FederalTaxData,
  RetirementDistribution,
  TaxYearInputs,
  TraceLine,
} from '../../src/shared/types';
import federalJson from '../../data-defaults/assumptions/tax/federal-2026.json';

const fedData = federalJson as unknown as FederalTaxData;
const SS_THRESHOLDS = fedData.ssTaxationThresholdsMfj; // { tier1: 32000, tier2: 44000 }

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

function dist(
  accountType: RetirementDistribution['accountType'],
  amount: number,
  penaltyException: RetirementDistribution['penaltyException'],
  penaltyBase: number,
): RetirementDistribution {
  return {
    personId: 'p1',
    accountType,
    amount,
    taxableAmount: amount,
    penaltyException,
    penaltyBase,
  };
}

// ---------------------------------------------------------------------------
// indexAmount / bracketTax
// ---------------------------------------------------------------------------

describe('indexAmount', () => {
  it('scales linearly by the CPI index', () => {
    expect(indexAmount(100, 1.5)).toBe(150);
    expect(indexAmount(24_800, 1)).toBe(24_800);
  });
});

describe('bracketTax', () => {
  it('hand-computed 2026 MFJ: taxable 117,800 -> 15,340', () => {
    // 10% x 24,800 = 2,480; 12% x (100,800 - 24,800) = 12% x 76,000 = 9,120;
    // 22% x (117,800 - 100,800) = 22% x 17,000 = 3,740. Total 15,340.
    expect(bracketTax(117_800, fedData.bracketsMfj, 1)).toBeCloseTo(15_340, 9);
  });

  it('is exact at bracket edges and continuous across them', () => {
    // Top of 10%: 10% x 24,800 = 2,480.
    expect(bracketTax(24_800, fedData.bracketsMfj, 1)).toBeCloseTo(2_480, 9);
    // Top of 12%: 2,480 + 12% x 76,000 = 11,600.
    expect(bracketTax(100_800, fedData.bracketsMfj, 1)).toBeCloseTo(11_600, 9);
    // $1 past the edge adds 22 cents, not a jump: 11,600 + 0.22.
    expect(bracketTax(100_801, fedData.bracketsMfj, 1)).toBeCloseTo(11_600.22, 9);
  });

  it('zero and negative taxable produce zero tax', () => {
    expect(bracketTax(0, fedData.bracketsMfj, 1)).toBe(0);
    expect(bracketTax(-5_000, fedData.bracketsMfj, 1)).toBe(0);
  });

  it('thresholds scale by the index; rates fixed (piecewise-linear homogeneity)', () => {
    // With index 1.5 every threshold is 1.5x, so tax(1.5x) = 1.5 x tax(x):
    // 117,800 x 1.5 = 176,700 -> 15,340 x 1.5 = 23,010.
    expect(bracketTax(176_700, fedData.bracketsMfj, 1.5)).toBeCloseTo(23_010, 9);
  });

  it('property: nondecreasing and marginal rate never exceeds the 37% top rate', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0, max: 2_000_000, noNaN: true }),
        fc.double({ min: 0, max: 100_000, noNaN: true }),
        (a, d) => {
          const t1 = bracketTax(a, fedData.bracketsMfj, 1);
          const t2 = bracketTax(a + d, fedData.bracketsMfj, 1);
          expect(t2).toBeGreaterThanOrEqual(t1 - 1e-9);
          expect(t2 - t1).toBeLessThanOrEqual(0.37 * d + 1e-6);
        },
      ),
      { seed: 4242, numRuns: 300 },
    );
  });
});

// ---------------------------------------------------------------------------
// Social Security worksheet (statutory thresholds 32,000 / 44,000)
// ---------------------------------------------------------------------------

describe('ssTaxableWorksheet', () => {
  it('tier 0: provisional income at or under 32,000 -> nothing taxable', () => {
    // PI = 10,000 + 0 + 0.5 x 20,000 = 20,000 <= 32,000 -> 0.
    expect(ssTaxableWorksheet(20_000, 10_000, 0, SS_THRESHOLDS)).toBe(0);
    // Exactly at the threshold: PI = 12,000 + 0.5 x 40,000 = 32,000 -> 0.
    expect(ssTaxableWorksheet(40_000, 12_000, 0, SS_THRESHOLDS)).toBe(0);
  });

  it('tier 1 (50%): SS 40k, other 20k -> 4,000 taxable', () => {
    // PI = 20,000 + 0.5 x 40,000 = 40,000; 32,000 < PI <= 44,000.
    // min(0.5 x (40,000 - 32,000) = 4,000, 0.5 x 40,000 = 20,000) = 4,000.
    expect(ssTaxableWorksheet(40_000, 20_000, 0, SS_THRESHOLDS)).toBeCloseTo(4_000, 9);
  });

  it('tier 1 upper edge: PI exactly 44,000 -> 6,000', () => {
    // PI = 24,000 + 20,000 = 44,000 -> min(0.5 x 12,000 = 6,000, 20,000) = 6,000.
    expect(ssTaxableWorksheet(40_000, 24_000, 0, SS_THRESHOLDS)).toBeCloseTo(6_000, 9);
  });

  it('tier 2 (85%), formula branch: SS 40k, other 26k -> 7,700', () => {
    // PI = 26,000 + 20,000 = 46,000 > 44,000.
    // tier-1 amount = min(0.5 x (46,000 - 32,000) = 7,000, 20,000) = 7,000.
    // capped tier-1 = min(7,000, 0.5 x 12,000 = 6,000) = 6,000.
    // formula = 0.85 x (46,000 - 44,000) + 6,000 = 1,700 + 6,000 = 7,700.
    // min(0.85 x 40,000 = 34,000, 7,700) = 7,700.
    expect(ssTaxableWorksheet(40_000, 26_000, 0, SS_THRESHOLDS)).toBeCloseTo(7_700, 9);
  });

  it('tier 2 (85%), cap branch: SS 40k, other 60k -> 34,000 (85% cap binds)', () => {
    // PI = 60,000 + 20,000 = 80,000.
    // min(0.5 x 48,000 = 24,000, 20,000) = 20,000 -> capped at 6,000.
    // formula = 0.85 x (80,000 - 44,000) + 6,000 = 30,600 + 6,000 = 36,600.
    // min(0.85 x 40,000 = 34,000, 36,600) = 34,000.
    expect(ssTaxableWorksheet(40_000, 60_000, 0, SS_THRESHOLDS)).toBeCloseTo(34_000, 9);
  });

  it('worksheet is continuous at the 44,000 threshold', () => {
    // Just above the tier-1/tier-2 boundary (other = 24,001): PI = 44,001.
    // tier-1 amount = min(0.5 x 12,001 = 6,000.50, 20,000) -> capped at 6,000.
    // formula = 0.85 x 1 + 6,000 = 6,000.85 -> min(34,000, 6,000.85) = 6,000.85.
    // Continuous with the 6,000 at PI = 44,000 (slope 0.85 per extra dollar).
    expect(ssTaxableWorksheet(40_000, 24_001, 0, SS_THRESHOLDS)).toBeCloseTo(6_000.85, 9);
  });

  it('tax-exempt interest counts toward provisional income', () => {
    // other 20,000 + TEI 4,000 + 20,000 = PI 44,000 -> 6,000 (same as edge case).
    expect(ssTaxableWorksheet(40_000, 20_000, 4_000, SS_THRESHOLDS)).toBeCloseTo(6_000, 9);
  });

  it('zero SS -> zero taxable regardless of other income', () => {
    expect(ssTaxableWorksheet(0, 500_000, 10_000, SS_THRESHOLDS)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// saltCap
// ---------------------------------------------------------------------------

describe('saltCap', () => {
  it('elevated cap year, MAGI under the phase-down threshold -> full 40,400', () => {
    expect(saltCap(fedData, 2026, 400_000, 1)).toBe(40_400);
  });

  it('phase-down: MAGI 600,000 -> 40,400 - 30% x 95,000 = 11,900', () => {
    // excess = 600,000 - 505,000 = 95,000; 40,400 - 0.3 x 95,000 = 11,900 > floor.
    expect(saltCap(fedData, 2026, 600_000, 1)).toBeCloseTo(11_900, 9);
  });

  it('phase-down floors at 10,000 for very high MAGI', () => {
    // 40,400 - 0.3 x (2,000,000 - 505,000) is deeply negative -> floor 10,000.
    expect(saltCap(fedData, 2026, 2_000_000, 1)).toBe(10_000);
  });

  it('years past the table use the unindexed fallback with no phase-down', () => {
    expect(saltCap(fedData, 2035, 600_000, 1)).toBe(10_000);
    expect(saltCap(fedData, 2035, 50_000, 2)).toBe(10_000);
  });

  it('phase-down MAGI threshold is CPI-indexed', () => {
    // Index 1.2: threshold = 505,000 x 1.2 = 606,000 > MAGI 600,000 -> no
    // phase-down, full 40,400.
    expect(saltCap(fedData, 2026, 600_000, 1.2)).toBe(40_400);
  });
});

// ---------------------------------------------------------------------------
// computeFederal — ordinary income
// ---------------------------------------------------------------------------

describe('computeFederal: ordinary-only MFJ', () => {
  it('wages 150k, both 55 -> tax 15,340', () => {
    // AGI = 150,000. SD = 32,200 (no 65+ add-on). Itemized = 0 -> standard.
    // Taxable = 117,800, all ordinary.
    // Tax = 10% x 24,800 + 12% x 76,000 + 22% x 17,000
    //     = 2,480 + 9,120 + 3,740 = 15,340.
    const r = computeFederal(inputs({ wages: 150_000 }), fedData, 0);
    expect(r.agi).toBeCloseTo(150_000, 9);
    expect(r.standardDeduction).toBeCloseTo(32_200, 9);
    expect(r.deductionUsed).toBe('standard');
    expect(r.taxableIncome).toBeCloseTo(117_800, 9);
    expect(r.taxableOrdinaryIncome).toBeCloseTo(117_800, 9);
    expect(r.ordinaryTax).toBeCloseTo(15_340, 9);
    expect(r.ltcgTax).toBe(0);
    expect(r.niit).toBe(0);
    expect(r.total).toBeCloseTo(15_340, 9);
    expect(r.penalties).toBe(0);
    // No TEI, no SS -> every MAGI variant equals AGI.
    expect(r.magi).toEqual({
      agi: 150_000,
      acaMagi: 150_000,
      irmaaMagi: 150_000,
      niitMagi: 150_000,
    });
  });
});

// ---------------------------------------------------------------------------
// computeFederal — LTCG stacking (named test case, SPEC §7)
// ---------------------------------------------------------------------------

describe('computeFederal: LTCG stacking', () => {
  it('straddles the 0%/15% breakpoint: O 80,000 + LTCG 40,000', () => {
    // Wages 112,200 + LTCG 40,000: AGI = 152,200; taxable = 120,000.
    // P = 40,000; O = 80,000.
    // Ordinary tax on 80,000 = 2,480 + 12% x 55,200 = 2,480 + 6,624 = 9,104.
    // Stacking: 0% amount = clamp(98,900 - 80,000, 0, 40,000) = 18,900;
    //           15% amount = clamp(613,700 - 98,900, 0, 40,000 - 18,900) = 21,100;
    //           20% amount = 0.
    // ltcgTax = 15% x 21,100 = 3,165. NIIT: MAGI 152,200 < 250,000 -> 0.
    const r = computeFederal(inputs({ wages: 112_200, ltcg: 40_000 }), fedData, 0);
    expect(r.taxableIncome).toBeCloseTo(120_000, 9);
    expect(r.taxableOrdinaryIncome).toBeCloseTo(80_000, 9);
    expect(r.ordinaryTax).toBeCloseTo(9_104, 9);
    expect(r.ltcgTax).toBeCloseTo(3_165, 9);
    expect(r.niit).toBe(0);
    expect(r.total).toBeCloseTo(12_269, 9);
  });

  it('ordinary tax is unchanged by the gains (gains stack on top)', () => {
    // Same wages without the LTCG: taxable = 112,200 - 32,200 = 80,000, all
    // ordinary -> same 9,104 of ordinary tax as the straddle case.
    const withGains = computeFederal(inputs({ wages: 112_200, ltcg: 40_000 }), fedData, 0);
    const noGains = computeFederal(inputs({ wages: 112_200 }), fedData, 0);
    expect(noGains.ordinaryTax).toBeCloseTo(9_104, 9);
    expect(withGains.ordinaryTax).toBeCloseTo(noGains.ordinaryTax, 9);
  });

  it('reaches the 20% rate above the 613,700 breakpoint', () => {
    // Wages 632,200 + LTCG 50,000: AGI = 682,200; taxable = 650,000;
    // P = 50,000; O = 600,000.
    // Ordinary tax on 600,000 = 2,480 + 9,120 + 22% x 110,600 (= 24,332)
    //   + 24% x 192,150 (= 46,116) + 32% x 108,900 (= 34,848)
    //   + 35% x 87,550 (= 30,642.50) = 147,538.50.
    // Stacking: 0% = 0 (O > 98,900); 15% = clamp(613,700 - 600,000, 0, 50,000)
    //   = 13,700 -> 2,055; 20% = 36,300 -> 7,260. ltcgTax = 9,315.
    // NIIT = 3.8% x min(NII 50,000, 682,200 - 250,000) = 3.8% x 50,000 = 1,900.
    const r = computeFederal(inputs({ wages: 632_200, ltcg: 50_000 }), fedData, 0);
    expect(r.ordinaryTax).toBeCloseTo(147_538.5, 9);
    expect(r.ltcgTax).toBeCloseTo(9_315, 9);
    expect(r.niit).toBeCloseTo(1_900, 9);
    expect(r.total).toBeCloseTo(158_753.5, 9);
  });

  it('deduction eats ordinary income first: QD-heavy low earner pays zero', () => {
    // Wages 20,000 + qualified dividends 30,000: AGI = 50,000; SD 32,200 ->
    // taxable = 17,800 < P (30,000) -> P clamps to 17,800, O = 0.
    // Stacking from O = 0: all 17,800 sits under the 98,900 0% breakpoint.
    // Ordinary tax = 0; ltcgTax = 0; total = 0.
    const r = computeFederal(
      inputs({ wages: 20_000, ordinaryDividends: 30_000, qualifiedDividends: 30_000 }),
      fedData,
      0,
    );
    expect(r.taxableIncome).toBeCloseTo(17_800, 9);
    expect(r.taxableOrdinaryIncome).toBe(0);
    expect(r.ordinaryTax).toBe(0);
    expect(r.ltcgTax).toBe(0);
    expect(r.total).toBe(0);
  });

  it('LTCG breakpoints scale with the CPI index', () => {
    // Index 1.5 version of the straddle case, all inputs x1.5:
    // wages 168,300 + LTCG 60,000 -> AGI 228,300; SD = 48,300; taxable 180,000;
    // P = 60,000; O = 120,000. zeroTop = 148,350; fifteenTop = 920,550.
    // 0% amount = 148,350 - 120,000 = 28,350; 15% amount = 31,650.
    // ltcgTax = 15% x 31,650 = 4,747.50 (= 3,165 x 1.5).
    // NIIT: MAGI 228,300 < 250,000 (unindexed) -> 0.
    const r = computeFederal(
      inputs({ wages: 168_300, ltcg: 60_000, inflationIndex: 1.5 }),
      fedData,
      0,
    );
    expect(r.taxableIncome).toBeCloseTo(180_000, 9);
    expect(r.ltcgTax).toBeCloseTo(4_747.5, 9);
    expect(r.niit).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// computeFederal — capital-loss cap
// ---------------------------------------------------------------------------

describe('computeFederal: net capital losses', () => {
  it('losses offset at most 3,000 of ordinary income (no carryforward)', () => {
    // Wages 100,000, LTCG -10,000 -> only -3,000 counts: AGI = 97,000.
    // Taxable = 64,800; tax = 2,480 + 12% x 40,000 = 7,280. P = 0 (no
    // preferential income from a net loss).
    const r = computeFederal(inputs({ wages: 100_000, ltcg: -10_000 }), fedData, 0);
    expect(r.agi).toBeCloseTo(97_000, 9);
    expect(r.taxableIncome).toBeCloseTo(64_800, 9);
    expect(r.taxableOrdinaryIncome).toBeCloseTo(64_800, 9);
    expect(r.ordinaryTax).toBeCloseTo(7_280, 9);
    expect(r.ltcgTax).toBe(0);
  });

  it('losses under the cap apply in full', () => {
    // LTCG -2,000 -> AGI = 100,000 - 2,000 = 98,000.
    const r = computeFederal(inputs({ wages: 100_000, ltcg: -2_000 }), fedData, 0);
    expect(r.agi).toBeCloseTo(98_000, 9);
  });
});

// ---------------------------------------------------------------------------
// computeFederal — NIIT
// ---------------------------------------------------------------------------

describe('computeFederal: NIIT', () => {
  it('3.8% on min(NII, MAGI - 250,000): MAGI 260k, NII 30k -> 380', () => {
    // Wages 230,000 + interest 10,000 + dividends 10,000 + LTCG 10,000:
    // AGI = 260,000. NII = 10,000 + 10,000 + 10,000 = 30,000.
    // Excess MAGI = 10,000 < NII -> NIIT = 3.8% x 10,000 = 380.
    const r = computeFederal(
      inputs({
        wages: 230_000,
        taxableInterest: 10_000,
        ordinaryDividends: 10_000,
        ltcg: 10_000,
      }),
      fedData,
      0,
    );
    expect(r.magi.niitMagi).toBeCloseTo(260_000, 9);
    expect(r.niit).toBeCloseTo(380, 9);
  });

  it('zero at the threshold boundary (MAGI exactly 250,000)', () => {
    // Wages 240,000 + interest 10,000 -> MAGI 250,000; excess = 0 -> NIIT 0.
    const r = computeFederal(inputs({ wages: 240_000, taxableInterest: 10_000 }), fedData, 0);
    expect(r.niit).toBe(0);
  });

  it('threshold is statutory — NOT indexed', () => {
    // Same 380 case with inflationIndex 1.5: threshold stays 250,000, AGI is
    // unchanged by indexing -> NIIT still 380.
    const r = computeFederal(
      inputs({
        wages: 230_000,
        taxableInterest: 10_000,
        ordinaryDividends: 10_000,
        ltcg: 10_000,
        inflationIndex: 1.5,
      }),
      fedData,
      0,
    );
    expect(r.niit).toBeCloseTo(380, 9);
  });
});

// ---------------------------------------------------------------------------
// computeFederal — early-withdrawal penalty
// ---------------------------------------------------------------------------

describe('computeFederal: early-withdrawal penalty', () => {
  it('10% of the penalty base: 20,000 base -> 2,000', () => {
    const r = computeFederal(
      inputs({
        pretaxDistributions: 20_000,
        distributions: [dist('traditional_ira', 20_000, 'none', 20_000)],
      }),
      fedData,
      0,
    );
    expect(r.penalties).toBeCloseTo(2_000, 9);
  });

  it('rule of 55 zeroes the penalty base -> no penalty', () => {
    const r = computeFederal(
      inputs({
        pretaxDistributions: 20_000,
        distributions: [dist('401k', 20_000, 'rule_of_55', 0)],
      }),
      fedData,
      0,
    );
    expect(r.penalties).toBe(0);
  });

  it('multiple distributions sum their penalty bases', () => {
    // 10% x (15,000 + 0 + 5,000) = 2,000.
    const r = computeFederal(
      inputs({
        pretaxDistributions: 45_000,
        distributions: [
          dist('traditional_ira', 15_000, 'none', 15_000),
          dist('401k', 25_000, 'rule_of_55', 0),
          dist('traditional_ira', 5_000, 'none', 5_000),
        ],
      }),
      fedData,
      0,
    );
    expect(r.penalties).toBeCloseTo(2_000, 9);
    // Penalties are reported separately, NOT inside federal total.
    expect(r.total).toBeCloseTo(
      r.ordinaryTax + r.ltcgTax + r.niit,
      12,
    );
  });
});

// ---------------------------------------------------------------------------
// Standard deduction 65+ and the indexing split
// ---------------------------------------------------------------------------

describe('standard deduction (65+ add-on and indexing)', () => {
  it('both 65 -> 32,200 + 2 x 1,650 = 35,500', () => {
    const p = computeFederalIncomePieces(inputs({ agesAtYearEnd: [65, 65] }), fedData);
    expect(p.standardDeduction).toBeCloseTo(35_500, 9);
  });

  it('one 65, one 64 -> 32,200 + 1,650 = 33,850', () => {
    const p = computeFederalIncomePieces(inputs({ agesAtYearEnd: [65, 64] }), fedData);
    expect(p.standardDeduction).toBeCloseTo(33_850, 9);
  });

  it('scales by the CPI index: 35,500 x 1.3 = 46,150', () => {
    const p = computeFederalIncomePieces(
      inputs({ agesAtYearEnd: [65, 65], inflationIndex: 1.3 }),
      fedData,
    );
    expect(p.standardDeduction).toBeCloseTo(46_150, 9);
  });
});

describe('indexing split (index 1.5)', () => {
  it('brackets and standard deduction scale: wages 225,000 -> tax 23,010', () => {
    // Everything x1.5 of the 150k ordinary-only case: SD = 48,300; taxable =
    // 176,700 = 117,800 x 1.5; tax = 15,340 x 1.5 = 23,010 by homogeneity.
    const r = computeFederal(inputs({ wages: 225_000, inflationIndex: 1.5 }), fedData, 0);
    expect(r.standardDeduction).toBeCloseTo(48_300, 9);
    expect(r.taxableIncome).toBeCloseTo(176_700, 9);
    expect(r.ordinaryTax).toBeCloseTo(23_010, 9);
  });

  it('SS provisional-income thresholds do NOT index', () => {
    // SS 40k, other 20k at index 1.5: PI = 40,000 against the SAME 32,000 /
    // 44,000 statutory thresholds -> taxable SS still 4,000; AGI 24,000.
    const r = computeFederal(
      inputs({ pretaxDistributions: 20_000, socialSecurityGross: 40_000, inflationIndex: 1.5 }),
      fedData,
      0,
    );
    expect(r.ssTaxableAmount).toBeCloseTo(4_000, 9);
    expect(r.agi).toBeCloseTo(24_000, 9);
  });
});

// ---------------------------------------------------------------------------
// Itemized vs standard
// ---------------------------------------------------------------------------

describe('computeFederal: itemize-vs-standard', () => {
  it('mortgage 25k + property tax 5k + state tax 6k flips to itemized', () => {
    // Itemized = 25,000 + min(5,000 + 6,000, 40,400) = 36,000 > SD 32,200.
    // Taxable = 150,000 - 36,000 = 114,000.
    // Tax = 2,480 + 9,120 + 22% x 13,200 = 2,480 + 9,120 + 2,904 = 14,504.
    const r = computeFederal(
      inputs({ wages: 150_000, itemizable: { mortgageInterest: 25_000, propertyTax: 5_000 } }),
      fedData,
      6_000,
    );
    expect(r.itemizedDeduction).toBeCloseTo(36_000, 9);
    expect(r.deductionUsed).toBe('itemized');
    expect(r.taxableIncome).toBeCloseTo(114_000, 9);
    expect(r.ordinaryTax).toBeCloseTo(14_504, 9);
  });

  it('without the state tax the standard deduction wins', () => {
    // Itemized = 25,000 + min(5,000, 40,400) = 30,000 < 32,200 -> standard;
    // taxable = 117,800; tax = 15,340 (the ordinary-only case).
    const r = computeFederal(
      inputs({ wages: 150_000, itemizable: { mortgageInterest: 25_000, propertyTax: 5_000 } }),
      fedData,
      0,
    );
    expect(r.itemizedDeduction).toBeCloseTo(30_000, 9);
    expect(r.deductionUsed).toBe('standard');
    expect(r.ordinaryTax).toBeCloseTo(15_340, 9);
  });

  it('SALT is capped: huge property tax cannot blow past the cap', () => {
    // Property tax 50,000 + state 10,000 = 60,000 -> capped at 40,400 (2026,
    // MAGI 150,000 under the phase-down threshold).
    // Itemized = 0 + 40,400 = 40,400.
    const r = computeFederal(
      inputs({ wages: 150_000, itemizable: { mortgageInterest: 0, propertyTax: 50_000 } }),
      fedData,
      10_000,
    );
    expect(r.itemizedDeduction).toBeCloseTo(40_400, 9);
    expect(r.deductionUsed).toBe('itemized');
  });
});

// ---------------------------------------------------------------------------
// Charitable deductions (OBBBA, TY2026+)
//
// Verified 2026-08-12 (see VERIFICATIONS.md "Charitable"):
//   - Itemizers: IRC §170(b)(1)(G)(i) caps cash gifts at 60% of AGI (permanent,
//     no 2026 sunset); IRC §170(b)(1)(I) then disallows the first 0.5% of AGI.
//     Order is ceiling FIRST, floor SECOND:
//       deductible = max(0, min(gifts, 0.60 x AGI) - 0.005 x AGI).
//   - Non-itemizers: IRC §170(p) allows $2,000 MFJ of CASH gifts, and IRC
//     §63(b)(4) subtracts it in computing TAXABLE INCOME — it is NOT in
//     §62(a), so AGI (and therefore every MAGI variant) is untouched.
//     Statutory, never indexed for inflation.
//
// Constants from federal-2026.json: nonItemizerDeductionMfj 2,000;
// itemizerAgiFloor 0.005; standard deduction 32,200 (ages 55/55).
// ---------------------------------------------------------------------------

describe('computeFederal: charitable — itemizer path (60% ceiling, 0.5% floor)', () => {
  it('AGI 200k, mortgage 30k, gifts 20k -> charitable component 19,000', () => {
    // AGI = 200,000 (wages only).
    // 60% ceiling = 0.60 x 200,000 = 120,000; min(20,000, 120,000) = 20,000.
    // 0.5% floor  = 0.005 x 200,000 = 1,000.
    // Charitable component = 20,000 - 1,000 = 19,000.
    // Itemized = 30,000 mortgage + SALT min(0 + 0, 40,400) = 0 + 19,000
    //          = 49,000 > SD 32,200 -> itemized (no non-itemizer deduction).
    // Taxable = 200,000 - 49,000 = 151,000, all ordinary.
    // Tax = 10% x 24,800 (= 2,480) + 12% x 76,000 (= 9,120)
    //     + 22% x (151,000 - 100,800 = 50,200) (= 11,044) = 22,644.
    const r = computeFederal(
      inputs({
        wages: 200_000,
        charitableGiving: 20_000,
        itemizable: { mortgageInterest: 30_000, propertyTax: 0 },
      }),
      fedData,
      0,
    );
    expect(r.agi).toBeCloseTo(200_000, 9);
    expect(r.itemizedDeduction).toBeCloseTo(49_000, 9);
    // Charitable component isolated: itemized minus mortgage minus SALT (0).
    expect(r.itemizedDeduction - 30_000).toBeCloseTo(19_000, 9);
    expect(r.deductionUsed).toBe('itemized');
    expect(r.taxableIncome).toBeCloseTo(151_000, 9);
    expect(r.ordinaryTax).toBeCloseTo(22_644, 9);
    expect(r.total).toBeCloseTo(22_644, 9);
    // The itemizer path never touches AGI either.
    expect(r.magi.agi).toBeCloseTo(200_000, 9);
  });

  it('floor edge: gifts 800 at AGI 200k are entirely below the 1,000 floor -> 0', () => {
    // Floor = 0.005 x 200,000 = 1,000 > 800 gifts, so
    // max(0, min(800, 120,000) - 1,000) = max(0, -200) = 0.
    // Mortgage 40,000 alone already beats SD 32,200, so this is a pure
    // itemizer and the non-itemizer deduction cannot mask the floor.
    // Itemized = 40,000 + 0 + 0 = 40,000; taxable = 200,000 - 40,000 = 160,000.
    const base = { wages: 200_000, itemizable: { mortgageInterest: 40_000, propertyTax: 0 } };
    const r = computeFederal(inputs({ ...base, charitableGiving: 800 }), fedData, 0);
    expect(r.deductionUsed).toBe('itemized');
    expect(r.itemizedDeduction).toBeCloseTo(40_000, 9);
    expect(r.taxableIncome).toBeCloseTo(160_000, 9);
    // Identical to giving nothing at all.
    const none = computeFederal(inputs({ ...base, charitableGiving: 0 }), fedData, 0);
    expect(r.itemizedDeduction).toBeCloseTo(none.itemizedDeduction, 9);
    expect(r.total).toBeCloseTo(none.total, 9);
  });

  it('floor is a knife edge, not a cliff: 1,000 -> 0 deductible, 1,001 -> 1.00', () => {
    // At exactly the floor: min(1,000, 120,000) - 1,000 = 0.
    // One dollar over: min(1,001, 120,000) - 1,000 = 1.
    const base = { wages: 200_000, itemizable: { mortgageInterest: 40_000, propertyTax: 0 } };
    const at = computeFederal(inputs({ ...base, charitableGiving: 1_000 }), fedData, 0);
    const over = computeFederal(inputs({ ...base, charitableGiving: 1_001 }), fedData, 0);
    expect(at.itemizedDeduction).toBeCloseTo(40_000, 9);
    expect(over.itemizedDeduction).toBeCloseTo(40_001, 9);
  });

  it('60%-of-AGI ceiling engages: gifts 150k at AGI 200k -> 119,000', () => {
    // Ceiling FIRST: min(150,000, 0.60 x 200,000 = 120,000) = 120,000
    //   (the excess 30,000 carries forward — carryforwards are not modeled).
    // Floor SECOND: 120,000 - 0.005 x 200,000 (= 1,000) = 119,000.
    // Itemized = 30,000 + 0 + 119,000 = 149,000 -> itemized.
    // Taxable = 200,000 - 149,000 = 51,000.
    // Tax = 10% x 24,800 (= 2,480) + 12% x (51,000 - 24,800 = 26,200)
    //     (= 3,144) = 5,624.
    const r = computeFederal(
      inputs({
        wages: 200_000,
        charitableGiving: 150_000,
        itemizable: { mortgageInterest: 30_000, propertyTax: 0 },
      }),
      fedData,
      0,
    );
    expect(r.itemizedDeduction).toBeCloseTo(149_000, 9);
    expect(r.itemizedDeduction - 30_000).toBeCloseTo(119_000, 9);
    expect(r.deductionUsed).toBe('itemized');
    expect(r.taxableIncome).toBeCloseTo(51_000, 9);
    expect(r.ordinaryTax).toBeCloseTo(5_624, 9);
  });

  it('gifts flip a standard-deduction filer into itemizing', () => {
    // Without gifts: itemized = 25,000 mortgage + min(5,000 property + 0
    //   state, 40,400) = 30,000 < SD 32,200 -> standard, taxable 117,800,
    //   tax 15,340 (the plain 150k case).
    // With 5,000 of gifts at AGI 150,000: floor = 0.005 x 150,000 = 750;
    //   charitable = min(5,000, 90,000) - 750 = 4,250;
    //   itemized = 30,000 + 4,250 = 34,250 > 32,200 -> ITEMIZED, and the
    //   §170(p) non-itemizer deduction is therefore unavailable.
    //   (Itemizing is genuinely the better election here: standard + the
    //   2,000 §170(p) cap = 34,200 < 34,250.)
    // Taxable = 150,000 - 34,250 = 115,750.
    // Tax = 2,480 + 9,120 + 22% x (115,750 - 100,800 = 14,950) (= 3,289)
    //     = 14,889.
    const base = {
      wages: 150_000,
      itemizable: { mortgageInterest: 25_000, propertyTax: 5_000 },
    };
    const none = computeFederal(inputs({ ...base, charitableGiving: 0 }), fedData, 0);
    expect(none.deductionUsed).toBe('standard');
    expect(none.taxableIncome).toBeCloseTo(117_800, 9);
    expect(none.ordinaryTax).toBeCloseTo(15_340, 9);

    const r = computeFederal(inputs({ ...base, charitableGiving: 5_000 }), fedData, 0);
    expect(r.itemizedDeduction).toBeCloseTo(34_250, 9);
    expect(r.deductionUsed).toBe('itemized');
    expect(r.taxableIncome).toBeCloseTo(115_750, 9);
    expect(r.ordinaryTax).toBeCloseTo(14_889, 9);
  });
});

describe('computeFederal: charitable — non-itemizer §170(p) deduction', () => {
  it('10k of gifts cuts TAXABLE INCOME by exactly 2,000 (the MFJ cap)', () => {
    // AGI = 150,000. Itemized = 0 mortgage + 0 SALT + charitable
    //   max(0, min(10,000, 90,000) - 750) = 9,250 -> 9,250 < SD 32,200, so
    //   the standard deduction wins and §170(p) applies:
    //   min(10,000 cash gifts, 2,000 MFJ cap) = 2,000.
    // Taxable = 150,000 - 32,200 - 2,000 = 115,800 (vs 117,800 with no
    //   giving: exactly 2,000 lower).
    // Tax = 2,480 + 9,120 + 22% x (115,800 - 100,800 = 15,000) (= 3,300)
    //     = 14,900 (vs 15,340: exactly 22% x 2,000 = 440 less).
    const none = computeFederal(inputs({ wages: 150_000, charitableGiving: 0 }), fedData, 0);
    const r = computeFederal(inputs({ wages: 150_000, charitableGiving: 10_000 }), fedData, 0);
    expect(r.deductionUsed).toBe('standard');
    expect(r.standardDeduction).toBeCloseTo(32_200, 9);
    expect(r.taxableIncome).toBeCloseTo(115_800, 9);
    expect(none.taxableIncome - r.taxableIncome).toBeCloseTo(2_000, 9);
    expect(r.ordinaryTax).toBeCloseTo(14_900, 9);
    expect(none.ordinaryTax - r.ordinaryTax).toBeCloseTo(440, 9);
    // AGI and every MAGI variant are untouched (§63(b)(4), not §62(a)).
    expect(r.agi).toBeCloseTo(150_000, 9);
    expect(r.magi).toEqual(none.magi);
  });

  it('gifts under the cap deduct in full: 1,500 -> taxable income 1,500 lower', () => {
    // Itemized = charitable max(0, 1,500 - 750) = 750 < 32,200 -> standard.
    // §170(p) = min(1,500, 2,000) = 1,500.
    // Taxable = 150,000 - 32,200 - 1,500 = 116,300.
    // Tax = 2,480 + 9,120 + 22% x (116,300 - 100,800 = 15,500) (= 3,410)
    //     = 15,010 (= 15,340 - 22% x 1,500 = 15,340 - 330).
    const r = computeFederal(inputs({ wages: 150_000, charitableGiving: 1_500 }), fedData, 0);
    expect(r.deductionUsed).toBe('standard');
    expect(r.taxableIncome).toBeCloseTo(116_300, 9);
    expect(r.ordinaryTax).toBeCloseTo(15_010, 9);
  });

  it('the 2,000 MFJ cap is statutory — NOT indexed (index 1.5)', () => {
    // Index 1.5: SD = 32,200 x 1.5 = 48,300, brackets x1.5, but the §170(p)
    // cap stays 2,000 (never indexed).
    // AGI 225,000; itemized = max(0, min(10,000, 135,000) - 0.005 x 225,000
    //   = 1,125) = 8,875 < 48,300 -> standard.
    // Taxable = 225,000 - 48,300 - 2,000 = 174,700 (vs 176,700 with no
    //   giving: exactly 2,000 lower, NOT 3,000).
    // Indexed brackets: 10% to 37,200; 12% to 151,200; 22% to 317,100.
    // Tax = 10% x 37,200 (= 3,720) + 12% x 114,000 (= 13,680)
    //     + 22% x (174,700 - 151,200 = 23,500) (= 5,170) = 22,570
    //     (vs 23,010 with no giving: exactly 22% x 2,000 = 440 less).
    const r = computeFederal(
      inputs({ wages: 225_000, charitableGiving: 10_000, inflationIndex: 1.5 }),
      fedData,
      0,
    );
    expect(r.standardDeduction).toBeCloseTo(48_300, 9);
    expect(r.deductionUsed).toBe('standard');
    expect(r.taxableIncome).toBeCloseTo(174_700, 9);
    expect(r.ordinaryTax).toBeCloseTo(22_570, 9);
  });

  it('does not move AGI, ACA MAGI, IRMAA MAGI or NIIT MAGI (cliff safety)', () => {
    // Wages 90,000 + SS 40,000 + tax-exempt interest 5,000, gifts 10,000.
    // PI = 90,000 + 5,000 + 20,000 = 115,000 > 44,000 -> tier 2:
    //   tier-1 amount = min(0.5 x 83,000 = 41,500, 0.5 x 40,000 = 20,000)
    //     = 20,000, capped at 0.5 x 12,000 = 6,000;
    //   formula = 0.85 x (115,000 - 44,000) + 6,000 = 60,350 + 6,000 = 66,350;
    //   min(0.85 x 40,000 = 34,000, 66,350) = 34,000 taxable SS.
    // AGI = 90,000 + 34,000 = 124,000.
    //   acaMagi   = 124,000 + 5,000 + (40,000 - 34,000) = 135,000.
    //   irmaaMagi = 124,000 + 5,000 = 129,000. niitMagi = 124,000.
    // Itemized = max(0, min(10,000, 0.60 x 124,000 = 74,400)
    //   - 0.005 x 124,000 = 620) = 9,380 < 32,200 -> standard + §170(p) 2,000.
    // Taxable = 124,000 - 32,200 - 2,000 = 89,800 (2,000 below the 91,800
    //   a non-giver would have).
    // Tax = 2,480 + 12% x (89,800 - 24,800 = 65,000) (= 7,800) = 10,280
    //     (vs 2,480 + 12% x 67,000 = 10,520: exactly 240 = 12% x 2,000 less).
    const base = { wages: 90_000, socialSecurityGross: 40_000, taxExemptInterest: 5_000 };
    const none = computeFederal(inputs({ ...base, charitableGiving: 0 }), fedData, 0);
    const r = computeFederal(inputs({ ...base, charitableGiving: 10_000 }), fedData, 0);

    expect(r.ssTaxableAmount).toBeCloseTo(34_000, 9);
    expect(r.agi).toBeCloseTo(124_000, 9);
    expect(r.magi.acaMagi).toBeCloseTo(135_000, 9);
    expect(r.magi.irmaaMagi).toBeCloseTo(129_000, 9);
    expect(r.magi.niitMagi).toBeCloseTo(124_000, 9);
    // Byte-for-byte identical MAGI to the no-giving run: the ACA cliff and
    // the IRMAA tiers cannot be dodged with charitable giving.
    expect(r.magi).toEqual(none.magi);
    expect(r.agi).toBe(none.agi);

    expect(none.taxableIncome).toBeCloseTo(91_800, 9);
    expect(r.taxableIncome).toBeCloseTo(89_800, 9);
    expect(none.ordinaryTax).toBeCloseTo(10_520, 9);
    expect(r.ordinaryTax).toBeCloseTo(10_280, 9);
  });
});

describe('computeFederal: charitable — zero-giving regression', () => {
  it('charitableGiving 0 reproduces the pre-charitable results exactly', () => {
    // Standard-deduction case: taxable 117,800, tax 15,340 (hand-computed
    // above, unchanged by the OBBBA charitable code).
    const std = computeFederal(inputs({ wages: 150_000, charitableGiving: 0 }), fedData, 0);
    expect(std.itemizedDeduction).toBe(0);
    expect(std.deductionUsed).toBe('standard');
    expect(std.taxableIncome).toBeCloseTo(117_800, 9);
    expect(std.ordinaryTax).toBeCloseTo(15_340, 9);

    // Itemizing case: itemized = 25,000 + min(5,000 + 6,000, 40,400) = 36,000;
    // taxable = 114,000; tax = 2,480 + 9,120 + 22% x 13,200 = 14,504.
    const item = computeFederal(
      inputs({
        wages: 150_000,
        charitableGiving: 0,
        itemizable: { mortgageInterest: 25_000, propertyTax: 5_000 },
      }),
      fedData,
      6_000,
    );
    expect(item.itemizedDeduction).toBeCloseTo(36_000, 9);
    expect(item.deductionUsed).toBe('itemized');
    expect(item.taxableIncome).toBeCloseTo(114_000, 9);
    expect(item.ordinaryTax).toBeCloseTo(14_504, 9);
  });

  it('negative giving is clamped to zero (defensive)', () => {
    const r = computeFederal(inputs({ wages: 150_000, charitableGiving: -5_000 }), fedData, 0);
    const none = computeFederal(inputs({ wages: 150_000, charitableGiving: 0 }), fedData, 0);
    expect(r.itemizedDeduction).toBe(0);
    expect(r.taxableIncome).toBeCloseTo(none.taxableIncome, 9);
    expect(r.total).toBeCloseTo(none.total, 9);
  });
});

// ---------------------------------------------------------------------------
// MAGI variants
// ---------------------------------------------------------------------------

describe('MAGI variants', () => {
  it('acaMagi adds back tax-exempt interest AND untaxed SS; irmaaMagi only TEI', () => {
    // Pretax 20,000 + SS 40,000 + TEI 5,000.
    // PI = 20,000 + 5,000 + 20,000 = 45,000 > 44,000 -> tier 2:
    //   tier-1 amount = min(0.5 x 13,000 = 6,500, 20,000) -> capped at 6,000;
    //   formula = 0.85 x 1,000 + 6,000 = 6,850; min(34,000, 6,850) = 6,850.
    // AGI = 20,000 + 6,850 = 26,850.
    // acaMagi = 26,850 + 5,000 + (40,000 - 6,850) = 65,000.
    // irmaaMagi = 26,850 + 5,000 = 31,850. niitMagi = AGI = 26,850.
    const r = computeFederal(
      inputs({
        pretaxDistributions: 20_000,
        socialSecurityGross: 40_000,
        taxExemptInterest: 5_000,
      }),
      fedData,
      0,
    );
    expect(r.ssTaxableAmount).toBeCloseTo(6_850, 9);
    expect(r.magi.agi).toBeCloseTo(26_850, 9);
    expect(r.magi.acaMagi).toBeCloseTo(65_000, 9);
    expect(r.magi.irmaaMagi).toBeCloseTo(31_850, 9);
    expect(r.magi.niitMagi).toBeCloseTo(26_850, 9);
  });
});

// ---------------------------------------------------------------------------
// Trace
// ---------------------------------------------------------------------------

describe('trace', () => {
  // A case that exercises the worksheet, brackets, stacking, and penalty:
  // wages 40,000 + pretax 20,000 (no exception, base 20,000) + SS 40,000 +
  // LTCG 50,000. Other income = 110,000; PI = 130,000 -> 85% cap -> SS
  // taxable 34,000; AGI 144,000; taxable 111,800; P 50,000; O 61,800.
  // Stacking: 0% on 37,100, 15% on 12,900.
  const traceInputs = () =>
    inputs({
      wages: 40_000,
      pretaxDistributions: 20_000,
      socialSecurityGross: 40_000,
      ltcg: 50_000,
      distributions: [dist('traditional_ira', 20_000, 'none', 20_000)],
    });

  it('pushes a readable walkthrough when a trace array is provided', () => {
    const trace: TraceLine[] = [];
    const r = computeFederal(traceInputs(), fedData, 0, trace);
    const labels = trace.map((l) => l.label);
    expect(labels[0]).toBe('Federal income tax (2026)');
    expect(labels).toContain('Social Security taxation worksheet');
    expect(labels).toContain('Tier: up to 85% taxable');
    expect(labels).toContain('Adjusted gross income (AGI)');
    expect(labels).toContain('Standard deduction');
    expect(labels).toContain('Itemized deduction');
    expect(labels).toContain('Deduction used: standard (the larger)');
    // Bracket-by-bracket rows: O = 61,800 spans the 10% and 12% brackets.
    expect(labels).toContain('10% bracket');
    expect(labels).toContain('12% bracket');
    // Stacking segments at each rate.
    expect(labels).toContain('Taxed at 0%');
    expect(labels).toContain('Taxed at 15%');
    expect(labels).toContain('Taxed at 20%');
    // Per-distribution penalty line with its exception.
    expect(labels.some((l) => l.includes('exception: none'))).toBe(true);
    // Amounts on key lines match the returned values.
    expect(trace.find((l) => l.label === 'Adjusted gross income (AGI)')?.amount).toBeCloseTo(
      r.agi,
      9,
    );
    expect(trace.find((l) => l.label === 'Ordinary tax')?.amount).toBeCloseTo(r.ordinaryTax, 9);
    expect(trace.find((l) => l.label === 'Total penalty')?.amount).toBeCloseTo(r.penalties, 9);
  });

  it('result is identical with and without tracing', () => {
    const trace: TraceLine[] = [];
    const traced = computeFederal(traceInputs(), fedData, 0, trace);
    const untraced = computeFederal(traceInputs(), fedData, 0);
    expect(traced).toEqual(untraced);
    expect(trace.length).toBeGreaterThan(0);
  });

  it('explains the non-itemizer charitable deduction with its 2,000 amount', () => {
    // Wages 150,000 + gifts 10,000 -> standard deduction + §170(p) 2,000
    // (hand-computed in the charitable section above).
    const trace: TraceLine[] = [];
    computeFederal(inputs({ wages: 150_000, charitableGiving: 10_000 }), fedData, 0, trace);
    const line = trace.find((l) => l.label === 'Non-itemizer charitable deduction');
    expect(line).toBeDefined();
    expect(line?.amount).toBeCloseTo(2_000, 9);
  });

  it('explains the itemized charitable component with its 19,000 amount', () => {
    // AGI 200,000, mortgage 30,000, gifts 20,000 -> 20,000 - 1,000 = 19,000.
    const trace: TraceLine[] = [];
    computeFederal(
      inputs({
        wages: 200_000,
        charitableGiving: 20_000,
        itemizable: { mortgageInterest: 30_000, propertyTax: 0 },
      }),
      fedData,
      0,
      trace,
    );
    const line = trace.find((l) => l.label === 'Charitable (itemized component)');
    expect(line).toBeDefined();
    expect(line?.amount).toBeCloseTo(19_000, 9);
    // The non-itemizer line must NOT appear for an itemizer.
    expect(trace.some((l) => l.label === 'Non-itemizer charitable deduction')).toBe(false);
  });

  it('emits no charitable lines when nothing was given', () => {
    const trace: TraceLine[] = [];
    computeFederal(inputs({ wages: 150_000, charitableGiving: 0 }), fedData, 0, trace);
    expect(trace.some((l) => l.label.startsWith('Charitable'))).toBe(false);
    expect(trace.some((l) => l.label === 'Non-itemizer charitable deduction')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Property: no accidental cliffs
// ---------------------------------------------------------------------------

describe('property: more income never yields less after-tax income', () => {
  it('total federal tax is nondecreasing in wages and never grows faster than income', () => {
    const base = {
      taxableInterest: 5_000,
      ordinaryDividends: 20_000,
      qualifiedDividends: 20_000,
      ltcg: 30_000,
      socialSecurityGross: 30_000,
    };
    fc.assert(
      fc.property(
        fc.double({ min: 0, max: 1_000_000, noNaN: true }),
        fc.double({ min: 0, max: 50_000, noNaN: true }),
        (wages, d) => {
          const t1 = computeFederal(inputs({ ...base, wages }), fedData, 0).total;
          const t2 = computeFederal(inputs({ ...base, wages: wages + d }), fedData, 0).total;
          expect(t2).toBeGreaterThanOrEqual(t1 - 1e-9);
          expect(t2 - t1).toBeLessThanOrEqual(d + 1e-6);
        },
      ),
      { seed: 4242, numRuns: 300 },
    );
  });
});

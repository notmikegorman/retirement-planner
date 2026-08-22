/**
 * SPEC §8 acceptance suite — frozen tax fixtures.
 *
 * >= 12 regression cases against the REAL verified 2026 data files in
 * data-defaults/assumptions/ (loaded with fs + JSON.parse, assembled into a
 * TaxDataBundle). Every expected value below is HAND-COMPUTED from the
 * verified constants, with the worksheet arithmetic in comments citing the
 * constant used. These are regression freezes: the expected numbers are
 * hardcoded, never derived from the code under test. Assertions are within
 * $0.50 per SPEC §8.
 *
 * Verified 2026 constants used throughout (data-defaults/assumptions/):
 * - federal-2026.json: MFJ brackets 10% to 24,800 / 12% to 100,800 / 22% to
 *   211,400 / 24% to 403,550 / 32% to 512,450 / 35% to 768,700 / 37% up;
 *   standard deduction 32,200 (+1,650 per spouse 65+); LTCG breakpoints
 *   0% top 98,900, 15% top 613,700; NIIT 3.8% over 250,000 MAGI (statutory);
 *   SS thresholds 32,000/44,000 (statutory); penalty 10%; SALT cap 40,400
 *   (2026) / 40,804 (2027) / 10,000 fallback.
 * - va-2026.json: brackets 2% to 3,000 / 3% to 5,000 / 5% to 17,000 / 5.75%
 *   up; standard deduction is a legislated schedule: 17,500 (TY2025-26),
 *   18,400 (TY2027), 18,600 (TY2028-29), statutory reversion to the 6,000
 *   fallback from TY2030; exemptions 930/person + 800 per 65+;
 *   age deduction 12,000 per 65+ phased $1-for-$1 over AFAGI 75,000.
 * - sc-2026.json: 1.99% to 30,000 / 5.21% up; SCIAD 30,000 phased out over
 *   FAGI 80,000-190,000; retirement deduction 3,000 (<65) / 10,000 (65+).
 * - nc-2026.json: flat 3.99% (2026); standard deduction 25,500.
 * - aca-2026.json: FPL(2) = 21,150 -> 400% cliff at 84,600; standard
 *   applicable-pct table (flat 9.96% for 300-400% FPL); enhanced=false.
 * - medicare-2026.json: Part B standard 202.90/mo; tier-1 IRMAA over MAGI
 *   218,000 -> Part B total 284.10/mo, Part D add-on 14.50/mo.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { computeYear } from '../../src/tax';
import type {
  AcaData,
  FederalTaxData,
  MedicareData,
  RetirementDistribution,
  StateTaxData,
  TaxDataBundle,
  TaxYearInputs,
} from '../../src/shared/types';

// ---------------------------------------------------------------------------
// Load the REAL verified data files (fs + JSON.parse)
// ---------------------------------------------------------------------------

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

function loadJson<T>(rel: string): T {
  return JSON.parse(readFileSync(join(ROOT, 'data-defaults', 'assumptions', rel), 'utf8')) as T;
}

const data: TaxDataBundle = {
  federal: loadJson<FederalTaxData>('tax/federal-2026.json'),
  states: {
    va: loadJson<StateTaxData>('tax/va-2026.json'),
    sc: loadJson<StateTaxData>('tax/sc-2026.json'),
    nc: loadJson<StateTaxData>('tax/nc-2026.json'),
  },
  aca: loadJson<AcaData>('aca-2026.json'),
  medicare: loadJson<MedicareData>('medicare-2026.json'),
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
  return { personId: 'p1', accountType, amount, taxableAmount: amount, penaltyException, penaltyBase };
}

/** SPEC §8: frozen fixtures assert to within $0.50. */
function expectMoney(actual: number | undefined, expected: number): void {
  expect(actual).toBeDefined();
  expect(Math.abs((actual as number) - expected)).toBeLessThanOrEqual(0.5);
}

// ---------------------------------------------------------------------------
// (1) Ordinary income only
// ---------------------------------------------------------------------------

describe('fixture 1: ordinary-only (wages 100k, VA, 2026)', () => {
  it('federal 7,640.00 + VA 4,379.30 = 12,019.30', () => {
    // Federal: AGI = 100,000. Standard deduction 32,200 (federal-2026.json)
    //   beats itemized (SALT-only = VA tax 4,379.30) -> taxable = 67,800.
    //   Tax = 10% x 24,800 + 12% x (67,800 - 24,800)
    //       = 2,480 + 12% x 43,000 = 2,480 + 5,160 = 7,640.
    // VA (va-2026.json; starts from federal AGI): 100,000 - 17,500 (std)
    //   - 2 x 930 (exemptions) = 80,640.
    //   Tax = 2% x 3,000 + 3% x 2,000 + 5% x 12,000 + 5.75% x (80,640 - 17,000)
    //       = 60 + 60 + 600 + 5.75% x 63,640 = 720 + 3,659.30 = 4,379.30.
    // totalTax = 7,640 + 4,379.30 + 0 penalties = 12,019.30.
    const r = computeYear(inputs({ wages: 100_000 }), data);
    expectMoney(r.federal.agi, 100_000);
    expect(r.federal.deductionUsed).toBe('standard');
    expectMoney(r.federal.taxableIncome, 67_800);
    expectMoney(r.federal.ordinaryTax, 7_640);
    expect(r.federal.ltcgTax).toBe(0);
    expect(r.federal.niit).toBe(0);
    expectMoney(r.federal.total, 7_640);
    expectMoney(r.state.taxableIncome, 80_640);
    expectMoney(r.state.total, 4_379.3);
    expect(r.penalties).toBe(0);
    expectMoney(r.totalTax, 12_019.3);
  });
});

// ---------------------------------------------------------------------------
// (2) LTCG stacking straddling the 0%/15% breakpoint
// ---------------------------------------------------------------------------

describe('fixture 2: LTCG stack straddles the 98,900 zero-rate top (wages 100k + LTCG 60k, VA, 2026)', () => {
  it('31,100 of gain at 0%, 28,900 at 15% -> LTCG tax 4,335.00', () => {
    // Federal: AGI = 160,000; standard deduction 32,200 -> taxable = 127,800.
    //   Preferential = 60,000 LTCG; ordinary taxable = 67,800.
    //   Ordinary tax = 2,480 + 12% x 43,000 = 7,640 (same as fixture 1).
    //   Stacking against ltcgBreakpointsMfj.zeroRateTop = 98,900
    //   (federal-2026.json): 0% slice = 98,900 - 67,800 = 31,100;
    //   15% slice = 60,000 - 31,100 = 28,900 (all under fifteenRateTop
    //   613,700). LTCG tax = 15% x 28,900 = 4,335.
    //   NIIT: MAGI 160,000 < 250,000 threshold -> 0.
    //   Federal total = 7,640 + 4,335 = 11,975.
    // VA: 160,000 - 17,500 - 1,860 = 140,640.
    //   Tax = 720 + 5.75% x (140,640 - 17,000) = 720 + 7,109.30 = 7,829.30.
    // totalTax = 11,975 + 7,829.30 = 19,804.30.
    const r = computeYear(inputs({ wages: 100_000, ltcg: 60_000 }), data);
    expectMoney(r.federal.taxableIncome, 127_800);
    expectMoney(r.federal.taxableOrdinaryIncome, 67_800);
    expectMoney(r.federal.ordinaryTax, 7_640);
    expectMoney(r.federal.ltcgTax, 4_335);
    expect(r.federal.niit).toBe(0);
    expectMoney(r.federal.total, 11_975);
    expectMoney(r.state.total, 7_829.3);
    expectMoney(r.totalTax, 19_804.3);
  });
});

// ---------------------------------------------------------------------------
// (3)-(5) Social Security taxation tiers: 0% / 50% / 85%
// ---------------------------------------------------------------------------

describe('fixtures 3-5: SS taxation tiers (VA, 2034, ages 63)', () => {
  it('fixture 3: provisional income under 32,000 -> 0% of SS taxable', () => {
    // Worksheet (federal-2026.json ssTaxationThresholdsMfj 32,000/44,000,
    // statutory, never indexed): other income = 20,000 pretax; provisional
    // income PI = 20,000 + 50% x 20,000 SS = 30,000 <= 32,000 -> taxable SS
    // = 0. AGI = 20,000; standard deduction 32,200 -> federal taxable 0,
    // federal tax 0.
    // VA (2034 is past the legislated schedule -> 6,000 fallback std):
    //   20,000 - 0 (SS exempt, none federally taxed anyway) - 6,000 (std)
    //   - 1,860 (2 x 930) = 12,140.
    //   Tax = 2% x 3,000 + 3% x 2,000 + 5% x (12,140 - 5,000)
    //       = 60 + 60 + 357 = 477.
    // totalTax = 0 + 477 = 477.
    const r = computeYear(
      inputs({
        year: 2034,
        agesAtYearEnd: [63, 63],
        pretaxDistributions: 20_000,
        socialSecurityGross: 20_000,
      }),
      data,
    );
    expect(r.federal.ssTaxableAmount).toBe(0);
    expectMoney(r.federal.agi, 20_000);
    expect(r.federal.taxableIncome).toBe(0);
    expect(r.federal.total).toBe(0);
    expectMoney(r.state.taxableIncome, 12_140);
    expectMoney(r.state.total, 477);
    expectMoney(r.totalTax, 477);
  });

  it('fixture 4: provisional income 40,000 lands in the 50% tier -> 4,000 of SS taxable', () => {
    // PI = 30,000 pretax + 50% x 20,000 SS = 40,000; 32,000 < PI <= 44,000
    // -> taxable SS = min(50% x (40,000 - 32,000), 50% x 20,000)
    //              = min(4,000, 10,000) = 4,000.
    // AGI = 30,000 + 4,000 = 34,000. Federal taxable = 34,000 - 32,200
    // = 1,800 -> tax = 10% x 1,800 = 180.
    // VA (2034 -> 6,000 fallback std): 34,000 - 4,000 (SS exempt) - 6,000
    //   - 1,860 = 22,140.
    //   Tax = 2% x 3,000 + 3% x 2,000 + 5% x 12,000 + 5.75% x (22,140 - 17,000)
    //       = 60 + 60 + 600 + 295.55 = 1,015.55.
    // totalTax = 180 + 1,015.55 = 1,195.55.
    const r = computeYear(
      inputs({
        year: 2034,
        agesAtYearEnd: [63, 63],
        pretaxDistributions: 30_000,
        socialSecurityGross: 20_000,
      }),
      data,
    );
    expectMoney(r.federal.ssTaxableAmount, 4_000);
    expectMoney(r.federal.agi, 34_000);
    expectMoney(r.federal.total, 180);
    expectMoney(r.state.taxableIncome, 22_140);
    expectMoney(r.state.total, 1_015.55);
    expectMoney(r.totalTax, 1_195.55);
  });

  it('fixture 5: provisional income 80,000 lands in the 85% tier -> the 85% cap binds', () => {
    // PI = 60,000 pretax + 50% x 40,000 SS = 80,000 > 44,000.
    //   Formula = 85% x (80,000 - 44,000) + min(min(50% x (80,000 - 32,000),
    //   50% x 40,000), 50% x (44,000 - 32,000))
    //           = 30,600 + min(min(24,000, 20,000), 6,000) = 30,600 + 6,000
    //           = 36,600.
    //   Cap = 85% x 40,000 = 34,000 < 36,600 -> taxable SS = 34,000
    //   (exactly 85% of gross: the cap binds).
    // AGI = 60,000 + 34,000 = 94,000. Federal taxable = 94,000 - 32,200
    // = 61,800 -> tax = 2,480 + 12% x 37,000 = 2,480 + 4,440 = 6,920.
    // VA (2034 -> 6,000 fallback std): 94,000 - 34,000 (SS exempt) - 6,000
    //   - 1,860 = 52,140.
    //   Tax = 720 + 5.75% x (52,140 - 17,000) = 720 + 2,020.55 = 2,740.55.
    // totalTax = 6,920 + 2,740.55 = 9,660.55.
    const r = computeYear(
      inputs({
        year: 2034,
        agesAtYearEnd: [63, 63],
        pretaxDistributions: 60_000,
        socialSecurityGross: 40_000,
      }),
      data,
    );
    expectMoney(r.federal.ssTaxableAmount, 34_000);
    // The cap is exactly 0.85 x gross.
    expect(r.federal.ssTaxableAmount).toBeCloseTo(0.85 * 40_000, 6);
    expectMoney(r.federal.agi, 94_000);
    expectMoney(r.federal.total, 6_920);
    expectMoney(r.state.taxableIncome, 52_140);
    expectMoney(r.state.total, 2_740.55);
    expectMoney(r.totalTax, 9_660.55);
  });
});

// ---------------------------------------------------------------------------
// (6)-(7) ACA cliff: $1 under vs $1 over 400% FPL
// ---------------------------------------------------------------------------

describe('fixtures 6-7: ACA cliff at MAGI 84,600 (4.0 x FPL 21,150), 2027 bridge year', () => {
  const aca = { enrolledMonths: 12, benchmarkAnnualPremium: 24_000, grossAnnualPremium: 24_000 };

  it('fixture 6: MAGI 84,599 ($1 under) keeps the full credit: PTC 15,573.94', () => {
    // ACA (aca-2026.json): FPL(2-person) = 21,150; 84,599 / 21,150 = 399.995%
    //   FPL -> standard table row 300-400% is flat 9.96%.
    //   Expected contribution = 9.96% x 84,599 = 8,426.0604.
    //   PTC = 24,000 benchmark - 8,426.0604 = 15,573.9396.
    //   Net premium = 24,000 - 15,573.9396 = 8,426.0604.
    //   Cliff headroom = 84,600 - 84,599 = 1.
    // Federal: AGI 84,599 - 32,200 = 52,399 taxable.
    //   Tax = 2,480 + 12% x (52,399 - 24,800) = 2,480 + 3,311.88 = 5,791.88.
    // VA (2027 -> scheduled std 18,400): 84,599 - 18,400 - 1,860 = 64,339.
    //   Tax = 720 + 5.75% x (64,339 - 17,000) = 720 + 2,721.9925 = 3,441.9925.
    // totalTax = 5,791.88 + 3,441.9925 = 9,233.8725 (premiums are expenses).
    const r = computeYear(
      inputs({
        year: 2027,
        agesAtYearEnd: [56, 56],
        pretaxDistributions: 84_599,
        distributions: [dist('401k', 84_599, 'rule_of_55', 0)],
        aca,
      }),
      data,
    );
    expect(r.aca).not.toBeNull();
    expect(r.aca?.cliffApplied).toBe(false);
    expectMoney(r.magi.acaMagi, 84_599);
    expect(r.aca?.applicablePct).toBeCloseTo(0.0996, 9);
    expectMoney(r.aca?.ptc, 15_573.94);
    expectMoney(r.aca?.netPremium, 8_426.06);
    expect(r.aca?.cliffHeadroom).toBeCloseTo(1, 6);
    expectMoney(r.federal.total, 5_791.88);
    expectMoney(r.state.total, 3_441.99);
    expectMoney(r.totalTax, 9_233.87);
  });

  it('fixture 7: MAGI 84,601 ($1 over) forfeits the ENTIRE credit and sets cliffApplied', () => {
    // ACA: 84,601 / 21,150 = 400.005% FPL > 400% -> pre-ARPA cliff: the whole
    //   PTC is forfeited. PTC = 0; net premium = gross = 24,000.
    //   Cliff headroom = 84,600 - 84,601 = -1.
    // Federal: taxable = 84,601 - 32,200 = 52,401.
    //   Tax = 2,480 + 12% x 27,601 = 2,480 + 3,312.12 = 5,792.12.
    // VA (2027 std 18,400): 84,601 - 18,400 - 1,860 = 64,341
    //   -> 720 + 5.75% x 47,341 = 720 + 2,722.1075 = 3,442.1075.
    // totalTax = 5,792.12 + 3,442.1075 = 9,234.2275.
    const r = computeYear(
      inputs({
        year: 2027,
        agesAtYearEnd: [56, 56],
        pretaxDistributions: 84_601,
        distributions: [dist('401k', 84_601, 'rule_of_55', 0)],
        aca,
      }),
      data,
    );
    expect(r.aca).not.toBeNull();
    expect(r.aca?.cliffApplied).toBe(true);
    expect(r.aca?.ptc).toBe(0);
    expect(r.aca?.applicablePct).toBeNull();
    expectMoney(r.aca?.netPremium, 24_000);
    expect(r.aca?.cliffHeadroom).toBeCloseTo(-1, 6);
    expectMoney(r.federal.total, 5_792.12);
    expectMoney(r.totalTax, 9_234.23);
  });
});

// ---------------------------------------------------------------------------
// (8) IRMAA tier boundary: $1 under vs over 218,000 two-year-prior MAGI
// ---------------------------------------------------------------------------

describe('fixture 8: IRMAA tier-1 boundary at 218,000 lookback MAGI (2036, inflationIndex 1)', () => {
  // Frozen case per SPEC: inflationIndex 1 keeps the tier-1 threshold at its
  // base-year 218,000 (medicare-2026.json; thresholds index by plain CPI).
  // premiumIndex 1.5 stands in for 2036 premium growth (CPI + medical spread);
  // premium AMOUNTS scale by premiumIndex, thresholds do NOT.
  function medicareYear(magiTwoYearsPrior: number): TaxYearInputs {
    return inputs({
      year: 2036,
      agesAtYearEnd: [65, 65],
      pretaxDistributions: 50_000,
      medicare: {
        enrolledMonthsPerPerson: [12, 12],
        magiTwoYearsPrior,
        partDPlanMonthly: 40, // current-year dollars, never re-indexed
        premiumIndex: 1.5,
      },
    });
  }

  it('MAGI 217,999 ($1 under): no IRMAA; premiums 8,264.40', () => {
    // Part B = 202.90 base x 1.5 premium index = 304.35/mo
    //   x 24 person-months (2 people x 12) = 7,304.40.
    // Part D plan = 40/mo x 24 = 960.
    // IRMAA = 0 (217,999 <= 218,000 tier-1 threshold x CPI index 1).
    // Total premiums = 7,304.40 + 960 = 8,264.40.
    const r = computeYear(medicareYear(217_999), data);
    expect(r.medicare).not.toBeNull();
    expect(r.medicare?.tierIndex).toBe(0);
    expectMoney(r.medicare?.partB, 7_304.4);
    expectMoney(r.medicare?.partDPlan, 960);
    expect(r.medicare?.irmaaPartB).toBe(0);
    expect(r.medicare?.irmaaPartD).toBe(0);
    expectMoney(r.medicare?.total, 8_264.4);
  });

  it('MAGI 218,001 ($1 over): tier 1 IRMAA; premiums 11,709.60', () => {
    // Tier 1 (medicare-2026.json): Part B total 284.10 -> surcharge
    //   (284.10 - 202.90) = 81.20/mo base-year x 1.5 = 121.80/mo
    //   x 24 person-months = 2,923.20.
    // Part D add-on 14.50/mo x 1.5 = 21.75/mo x 24 = 522.00.
    // Base Part B 7,304.40 and Part D plan 960 as in the under case.
    // Total = 7,304.40 + 2,923.20 + 960 + 522 = 11,709.60.
    const r = computeYear(medicareYear(218_001), data);
    expect(r.medicare?.tierIndex).toBe(1);
    expectMoney(r.medicare?.partB, 7_304.4);
    expectMoney(r.medicare?.irmaaPartB, 2_923.2);
    expectMoney(r.medicare?.irmaaPartD, 522);
    expectMoney(r.medicare?.total, 11_709.6);
    // Premiums are expense-side: totalTax must be identical either side of
    // the IRMAA boundary (same current-year income both cases).
    const under = computeYear(medicareYear(217_999), data);
    expect(r.totalTax).toBeCloseTo(under.totalTax, 9);
  });
});

// ---------------------------------------------------------------------------
// (9)-(10) Early 401(k) withdrawal: rule of 55 vs no exception
// ---------------------------------------------------------------------------

describe('fixtures 9-10: early withdrawal at 56 (2027, VA, 60k distribution)', () => {
  // Shared income tax arithmetic (identical in both fixtures):
  // Federal: AGI 60,000 - 32,200 = 27,800 taxable.
  //   Tax = 2,480 + 12% x (27,800 - 24,800) = 2,480 + 360 = 2,840.
  // VA (2027 -> scheduled std 18,400): 60,000 - 18,400 - 1,860 = 39,740.
  //   Tax = 720 + 5.75% x (39,740 - 17,000) = 720 + 1,307.55 = 2,027.55.

  it('fixture 9: rule of 55 -> no penalty; totalTax 4,867.55', () => {
    // Penalty base 0 (rule_of_55 exception, engine-computed) -> penalties 0.
    // totalTax = 2,840 + 2,027.55 + 0 = 4,867.55.
    const r = computeYear(
      inputs({
        year: 2027,
        agesAtYearEnd: [56, 56],
        pretaxDistributions: 60_000,
        distributions: [dist('401k', 60_000, 'rule_of_55', 0)],
      }),
      data,
    );
    expect(r.penalties).toBe(0);
    expectMoney(r.federal.total, 2_840);
    expectMoney(r.state.total, 2_027.55);
    expectMoney(r.totalTax, 4_867.55);
  });

  it('fixture 10: no exception -> 10% penalty on the full 60,000; totalTax 10,867.55', () => {
    // Penalty = earlyWithdrawalPenaltyRate 10% (federal-2026.json) x 60,000
    //         = 6,000. Income taxes unchanged (penalty is not income tax).
    // totalTax = 2,840 + 2,027.55 + 6,000 = 10,867.55.
    const r = computeYear(
      inputs({
        year: 2027,
        agesAtYearEnd: [56, 56],
        pretaxDistributions: 60_000,
        distributions: [dist('traditional_ira', 60_000, 'none', 60_000)],
      }),
      data,
    );
    expectMoney(r.penalties, 6_000);
    expectMoney(r.federal.total, 2_840);
    expectMoney(r.state.total, 2_027.55);
    expectMoney(r.totalTax, 10_867.55);
  });
});

// ---------------------------------------------------------------------------
// (11) RMD-year composition
// ---------------------------------------------------------------------------

describe('fixture 11: RMD year (2046, both 75, 65+ standard deduction)', () => {
  it('80k forced pretax + 50k SS: federal 9,944.00 + VA 2,706.05', () => {
    // SS worksheet: PI = 80,000 + 50% x 50,000 = 105,000 > 44,000.
    //   Formula = 85% x (105,000 - 44,000) + min(min(50% x 73,000, 25,000),
    //   6,000) = 51,850 + 6,000 = 57,850; cap = 85% x 50,000 = 42,500 ->
    //   taxable SS = 42,500.
    // AGI = 80,000 + 42,500 = 122,500.
    // Standard deduction = 32,200 + 2 x 1,650 (both 65+, federal-2026.json)
    //   = 35,500. Taxable = 87,000.
    //   Tax = 2,480 + 12% x (87,000 - 24,800) = 2,480 + 7,464 = 9,944.
    // VA (2046 is past the legislated schedule -> 6,000 fallback std):
    //   122,500 - 42,500 (SS exempt) - 6,000 (std)
    //   - 3,460 (2 x 930 + 2 x 800 65+ exemptions) = 70,540.
    //   Age deduction: AFAGI = AGI - taxable SS = 80,000; over the 75,000
    //   threshold by 5,000 -> 2 x 12,000 - 5,000 = 19,000.
    //   Taxable = 70,540 - 19,000 = 51,540.
    //   Tax = 720 + 5.75% x (51,540 - 17,000) = 720 + 1,986.05 = 2,706.05.
    // totalTax = 9,944 + 2,706.05 = 12,650.05. No penalty at 75.
    const r = computeYear(
      inputs({
        year: 2046,
        agesAtYearEnd: [75, 75],
        pretaxDistributions: 80_000,
        socialSecurityGross: 50_000,
        distributions: [dist('traditional_ira', 80_000, 'age_59_5', 0)],
      }),
      data,
    );
    expectMoney(r.federal.ssTaxableAmount, 42_500);
    expectMoney(r.federal.agi, 122_500);
    expectMoney(r.federal.standardDeduction, 35_500);
    expectMoney(r.federal.taxableIncome, 87_000);
    expectMoney(r.federal.total, 9_944);
    expectMoney(r.state.taxableIncome, 51_540);
    expectMoney(r.state.total, 2_706.05);
    expect(r.penalties).toBe(0);
    expectMoney(r.totalTax, 12_650.05);
  });
});

// ---------------------------------------------------------------------------
// (12) VA vs SC vs NC on identical income
// ---------------------------------------------------------------------------

describe('fixture 12: VA vs SC vs NC, same 120k wages (2026)', () => {
  // Federal is identical in all three states (each state tax stays under the
  // 32,200 standard deduction, so the deduction choice never flips):
  //   Taxable = 120,000 - 32,200 = 87,800.
  //   Tax = 2,480 + 12% x (87,800 - 24,800) = 2,480 + 7,560 = 10,040.
  const base = { wages: 120_000 };

  it('VA: 5,529.30', () => {
    // 120,000 - 17,500 - 1,860 = 100,640.
    // Tax = 720 + 5.75% x (100,640 - 17,000) = 720 + 4,809.30 = 5,529.30.
    const r = computeYear(inputs({ ...base, state: 'va' }), data);
    expectMoney(r.federal.total, 10_040);
    expectMoney(r.state.taxableIncome, 100_640);
    expectMoney(r.state.total, 5_529.3);
    expectMoney(r.totalTax, 15_569.3);
  });

  it('SC: 4,291.36 (SCIAD partially phased out)', () => {
    // SCIAD (sc-2026.json): FAGI 120,000 is 40,000 into the 80,000-190,000
    //   phase-out -> factor = 1 - 40,000/110,000 = 7/11.
    //   SCIAD = 30,000 x 7/11 = 19,090.909091.
    //   No retirement distributions -> retirement deduction 0.
    //   Taxable = 120,000 - 19,090.909091 = 100,909.090909.
    //   Tax = 1.99% x 30,000 + 5.21% x (100,909.090909 - 30,000)
    //       = 597 + 5.21% x 70,909.090909 = 597 + 3,694.363636 = 4,291.363636.
    const r = computeYear(inputs({ ...base, state: 'sc' }), data);
    expectMoney(r.federal.total, 10_040);
    expectMoney(r.state.taxableIncome, 100_909.09);
    expectMoney(r.state.total, 4_291.36);
    expectMoney(r.totalTax, 14_331.36);
  });

  it('NC: 3,770.55 (flat 3.99%); state ordering NC < SC < VA', () => {
    // NC (nc-2026.json): 120,000 - 25,500 = 94,500 x 3.99% = 3,770.55.
    const va = computeYear(inputs({ ...base, state: 'va' }), data);
    const sc = computeYear(inputs({ ...base, state: 'sc' }), data);
    const nc = computeYear(inputs({ ...base, state: 'nc' }), data);
    expectMoney(nc.federal.total, 10_040);
    expectMoney(nc.state.taxableIncome, 94_500);
    expectMoney(nc.state.total, 3_770.55);
    expectMoney(nc.totalTax, 13_810.55);
    // Same federal everywhere; states rank NC < SC < VA at this income.
    expect(va.federal.total).toBeCloseTo(sc.federal.total, 9);
    expect(sc.federal.total).toBeCloseTo(nc.federal.total, 9);
    expect(nc.state.total).toBeLessThan(sc.state.total);
    expect(sc.state.total).toBeLessThan(va.state.total);
  });
});

// ---------------------------------------------------------------------------
// (13) NIIT boundary
// ---------------------------------------------------------------------------

describe('fixture 13: NIIT boundary at 250,000 MAGI (statutory, unindexed)', () => {
  it('MAGI 249,000: NIIT 0; MAGI 260,000: NIIT 380.00', () => {
    // Under (wages 189,000 + LTCG 60,000): MAGI = AGI = 249,000 < 250,000
    //   -> NIIT = 0.
    //   Federal detail: taxable = 249,000 - 32,200 = 216,800; ordinary
    //   = 156,800 -> tax = 2,480 + 9,120 + 22% x (156,800 - 100,800)
    //   = 11,600 + 12,320 = 23,920. LTCG all above 98,900 zero-top -> 15% x
    //   60,000 = 9,000. Federal total = 23,920 + 9,000 + 0 = 32,920.
    // Over (wages 200,000 + LTCG 60,000): MAGI = 260,000.
    //   NII = 60,000 (LTCG); excess MAGI = 260,000 - 250,000 = 10,000.
    //   NIIT = 3.8% x min(60,000, 10,000) = 380.
    //   Ordinary = 195,600... detail: taxable = 227,800; ordinary = 167,800
    //   -> tax = 11,600 + 22% x 67,000 = 11,600 + 14,740 = 26,340.
    //   LTCG tax = 15% x 60,000 = 9,000.
    //   Federal total = 26,340 + 9,000 + 380 = 35,720.
    const under = computeYear(inputs({ wages: 189_000, ltcg: 60_000 }), data);
    const over = computeYear(inputs({ wages: 200_000, ltcg: 60_000 }), data);
    expect(under.federal.niit).toBe(0);
    expectMoney(under.federal.total, 32_920);
    expectMoney(over.federal.niit, 380);
    expectMoney(over.federal.total, 35_720);
    expectMoney(over.magi.niitMagi, 260_000);
  });
});

// ---------------------------------------------------------------------------
// (14) Itemize-vs-standard flip
// ---------------------------------------------------------------------------

describe('fixture 14: itemize-vs-standard flip (wages 100k, VA, 2026)', () => {
  // VA tax is unaffected by federal itemization (VA starts from AGI):
  //   4,379.30 as computed in fixture 1.
  // SALT = min(6,000 property tax + 4,379.30 state income tax, cap 40,400)
  //      = 10,379.30 in both cases.

  it('mortgage interest 30k -> itemized 40,379.30 beats the 32,200 standard', () => {
    // Itemized = 30,000 + 10,379.30 = 40,379.30 > 32,200 -> itemize.
    // Taxable = 100,000 - 40,379.30 = 59,620.70.
    // Tax = 2,480 + 12% x (59,620.70 - 24,800) = 2,480 + 4,178.484
    //     = 6,658.484.
    // totalTax = 6,658.484 + 4,379.30 = 11,037.784.
    const r = computeYear(
      inputs({
        wages: 100_000,
        itemizable: { mortgageInterest: 30_000, propertyTax: 6_000 },
      }),
      data,
    );
    expect(r.federal.deductionUsed).toBe('itemized');
    expectMoney(r.federal.itemizedDeduction, 40_379.3);
    expectMoney(r.federal.taxableIncome, 59_620.7);
    expectMoney(r.federal.total, 6_658.48);
    expectMoney(r.state.total, 4_379.3);
    expectMoney(r.totalTax, 11_037.78);
  });

  it('mortgage interest 20k -> itemized 30,379.30 loses; standard applies', () => {
    // Itemized = 20,000 + 10,379.30 = 30,379.30 < 32,200 -> standard.
    // Federal identical to fixture 1: taxable 67,800 -> tax 7,640.
    // totalTax = 7,640 + 4,379.30 = 12,019.30.
    const r = computeYear(
      inputs({
        wages: 100_000,
        itemizable: { mortgageInterest: 20_000, propertyTax: 6_000 },
      }),
      data,
    );
    expect(r.federal.deductionUsed).toBe('standard');
    expectMoney(r.federal.itemizedDeduction, 30_379.3);
    expectMoney(r.federal.taxableIncome, 67_800);
    expectMoney(r.federal.total, 7_640);
    expectMoney(r.totalTax, 12_019.3);
  });
});

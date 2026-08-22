/**
 * Hand-computed unit tests for src/tax/acaMedicare.ts.
 *
 * The ACA/Medicare fixtures below mirror the verified data files
 * data-defaults/assumptions/aca-2026.json and medicare-2026.json exactly
 * (a consistency test pins that), so every expected value is arithmetic
 * on the shipped 2026 numbers. The math is spelled out in comments.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { computeAca, computeMedicare } from '../../src/tax/acaMedicare';
import type { AcaData, MedicareData, TaxYearInputs, TraceLine } from '../../src/shared/types';

// ---------------------------------------------------------------------------
// Fixtures (mirror the verified 2026 data files)
// ---------------------------------------------------------------------------

const acaData: AcaData = {
  baseYear: 2026,
  fpl2Person: 21150,
  /*
   * The SURVIVOR's denominator, and REQUIRED rather than optional on purpose:
   * a data file that forgot the one-person figure must fail to load, not
   * quietly hand a widow the couple's poverty level and tell her she is
   * comfortably under a cliff she is $20,000 over. Same reasoning as
   * irmaaTiersSingle below and the single tables in federal-2026.json.
   */
  fpl1Person: 15650,
  applicablePctTable: [
    { fplFrom: 0, fplTo: 1.33, pctFrom: 0.021, pctTo: 0.021 },
    { fplFrom: 1.33, fplTo: 1.5, pctFrom: 0.0314, pctTo: 0.0419 },
    { fplFrom: 1.5, fplTo: 2.0, pctFrom: 0.0419, pctTo: 0.066 },
    { fplFrom: 2.0, fplTo: 2.5, pctFrom: 0.066, pctTo: 0.0844 },
    { fplFrom: 2.5, fplTo: 3.0, pctFrom: 0.0844, pctTo: 0.0996 },
    { fplFrom: 3.0, fplTo: 4.0, pctFrom: 0.0996, pctTo: 0.0996 },
  ],
  applicablePctTableEnhanced: [
    { fplFrom: 0, fplTo: 1.5, pctFrom: 0, pctTo: 0 },
    { fplFrom: 1.5, fplTo: 2.0, pctFrom: 0, pctTo: 0.02 },
    { fplFrom: 2.0, fplTo: 2.5, pctFrom: 0.02, pctTo: 0.04 },
    { fplFrom: 2.5, fplTo: 3.0, pctFrom: 0.04, pctTo: 0.06 },
    { fplFrom: 3.0, fplTo: 4.0, pctFrom: 0.06, pctTo: 0.085 },
    { fplFrom: 4.0, fplTo: null, pctFrom: 0.085, pctTo: 0.085 },
  ],
  enhancedCreditsExtended: false,
  medicaidExpansion: { va: true, sc: false, nc: true },
  medicaidThresholdFpl: 1.38,
  ageCurve: { '55': 2.23, '64': 3.0 },
};

const medicareData: MedicareData = {
  baseYear: 2026,
  partBStandardMonthly: 202.9,
  partDBaseMonthly: 38.99,
  irmaaTiersMfj: [
    { magiOver: 218000, partBTotalMonthly: 284.1, partDAddOnMonthly: 14.5 },
    { magiOver: 274000, partBTotalMonthly: 405.8, partDAddOnMonthly: 37.5 },
    { magiOver: 342000, partBTotalMonthly: 527.5, partDAddOnMonthly: 60.4 },
    { magiOver: 410000, partBTotalMonthly: 649.2, partDAddOnMonthly: 83.3 },
    { magiOver: 750000, partBTotalMonthly: 689.9, partDAddOnMonthly: 91.0 },
  ],
  /*
   * SINGLE tiers, mirroring medicare-2026.json. The premium amounts are
   * identical tier for tier; only the MAGI thresholds move — which is how a
   * widow drawing unchanged income jumps one or two tiers the year after the
   * death. Note the last row: $500,000 single against $750,000 MFJ. HALF of
   * the MFJ figure would be $375,000, and a "divide by two" implementation
   * would overcharge every widow with MAGI between $375,000 and $500,000.
   */
  irmaaTiersSingle: [
    { magiOver: 109000, partBTotalMonthly: 284.1, partDAddOnMonthly: 14.5 },
    { magiOver: 137000, partBTotalMonthly: 405.8, partDAddOnMonthly: 37.5 },
    { magiOver: 171000, partBTotalMonthly: 527.5, partDAddOnMonthly: 60.4 },
    { magiOver: 205000, partBTotalMonthly: 649.2, partDAddOnMonthly: 83.3 },
    { magiOver: 500000, partBTotalMonthly: 689.9, partDAddOnMonthly: 91.0 },
  ],
  medicareStartAge: 65,
  magiLookbackYears: 2,
};

function baseInputs(overrides: Partial<TaxYearInputs> = {}): TaxYearInputs {
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
    ...overrides,
  };
}

/** 12 months on ACA, household buys the $21,000/yr benchmark plan. */
function acaInputs(
  acaOverrides: Partial<NonNullable<TaxYearInputs['aca']>> = {},
  inputOverrides: Partial<TaxYearInputs> = {},
): TaxYearInputs {
  return baseInputs({
    aca: {
      enrolledMonths: 12,
      benchmarkAnnualPremium: 21000,
      grossAnnualPremium: 21000,
      ...acaOverrides,
    },
    ...inputOverrides,
  });
}

function medicareInputs(
  medOverrides: Partial<NonNullable<TaxYearInputs['medicare']>> = {},
  inputOverrides: Partial<TaxYearInputs> = {},
): TaxYearInputs {
  return baseInputs({
    medicare: {
      enrolledMonthsPerPerson: [12, 12],
      magiTwoYearsPrior: 100000,
      partDPlanMonthly: 40,
      premiumIndex: 1,
      ...medOverrides,
    },
    ...inputOverrides,
  });
}

// ---------------------------------------------------------------------------
// Fixture <-> shipped-data consistency
// ---------------------------------------------------------------------------

describe('fixtures match the shipped data-defaults files', () => {
  it('aca-2026.json', () => {
    const shipped = JSON.parse(
      readFileSync(new URL('../../data-defaults/assumptions/aca-2026.json', import.meta.url), 'utf8'),
    );
    expect(shipped.fpl2Person).toBe(acaData.fpl2Person);
    // The survivor's denominator has to be pinned to the shipped file too, or
    // the fixture could drift and every widow-side expectation below would be
    // arithmetic on a number the engine never sees.
    expect(shipped.fpl1Person).toBe(acaData.fpl1Person);
    expect(shipped.applicablePctTable).toEqual(acaData.applicablePctTable);
    expect(shipped.applicablePctTableEnhanced).toEqual(acaData.applicablePctTableEnhanced);
    expect(shipped.enhancedCreditsExtended).toBe(false);
    expect(shipped.medicaidExpansion).toEqual(acaData.medicaidExpansion);
    expect(shipped.medicaidThresholdFpl).toBe(acaData.medicaidThresholdFpl);
  });

  it('medicare-2026.json', () => {
    const shipped = JSON.parse(
      readFileSync(
        new URL('../../data-defaults/assumptions/medicare-2026.json', import.meta.url),
        'utf8',
      ),
    );
    expect(shipped.partBStandardMonthly).toBe(medicareData.partBStandardMonthly);
    expect(shipped.irmaaTiersMfj).toEqual(medicareData.irmaaTiersMfj);
    expect(shipped.irmaaTiersSingle).toEqual(medicareData.irmaaTiersSingle);
    expect(shipped.magiLookbackYears).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// computeAca
// ---------------------------------------------------------------------------

describe('computeAca', () => {
  it('returns null when not on ACA or enrolled 0 months', () => {
    expect(computeAca(baseInputs(), acaData, 50000)).toBeNull();
    expect(computeAca(acaInputs({ enrolledMonths: 0 }), acaData, 50000)).toBeNull();
  });

  it('interpolates the applicable percentage mid-band (225% FPL)', () => {
    // FPL = 21,150 (index 1.0). MAGI = 2.25 x 21,150 = 47,587.50 -> fplPct 2.25.
    // Band 2.0-2.5 (6.60% -> 8.44%): pct = 0.066 + (0.0844-0.066) x (2.25-2.0)/0.5
    //   = 0.066 + 0.0184 x 0.5 = 0.0752.
    // Expected contribution = 0.0752 x 47,587.50 = 3,578.58.
    // PTC = 21,000 - 3,578.58 = 17,421.42.
    // Net premium = 21,000 - 17,421.42 = 3,578.58.
    // Cliff headroom = 4 x 21,150 - 47,587.50 = 84,600 - 47,587.50 = 37,012.50.
    const res = computeAca(acaInputs(), acaData, 47587.5);
    expect(res).not.toBeNull();
    expect(res!.enrolled).toBe(true);
    expect(res!.fplPct).toBeCloseTo(2.25, 10);
    expect(res!.applicablePct).toBeCloseTo(0.0752, 10);
    expect(res!.expectedContribution).toBeCloseTo(3578.58, 6);
    expect(res!.ptc).toBeCloseTo(17421.42, 6);
    expect(res!.grossPremium).toBeCloseTo(21000, 10);
    expect(res!.netPremium).toBeCloseTo(3578.58, 6);
    expect(res!.cliffApplied).toBe(false);
    expect(res!.cliffHeadroom).toBeCloseTo(37012.5, 6);
  });

  it('keeps the credit at exactly 400% FPL (9.96% flat band)', () => {
    // MAGI = 4.0 x 21,150 = 84,600 exactly -> NOT over the cliff (strict >).
    // Applicable pct = 9.96% (flat 300-400 band).
    // Expected contribution = 0.0996 x 84,600 = 8,426.16.
    // PTC = 21,000 - 8,426.16 = 12,573.84. Headroom = 84,600 - 84,600 = 0.
    const res = computeAca(acaInputs(), acaData, 84600);
    expect(res!.cliffApplied).toBe(false);
    expect(res!.applicablePct).toBeCloseTo(0.0996, 10);
    expect(res!.expectedContribution).toBeCloseTo(8426.16, 6);
    expect(res!.ptc).toBeCloseTo(12573.84, 6);
    expect(res!.cliffHeadroom).toBeCloseTo(0, 10);
  });

  it('forfeits the entire credit $1 over the 400% cliff and traces it', () => {
    // MAGI = 84,601 -> fplPct = 84,601/21,150 > 4.0 -> cliff.
    // PTC = 0; net premium = gross premium = 21,000; headroom = 84,600 - 84,601 = -1.
    const trace: TraceLine[] = [];
    const res = computeAca(acaInputs(), acaData, 84601, trace);
    expect(res!.cliffApplied).toBe(true);
    expect(res!.applicablePct).toBeNull();
    expect(res!.expectedContribution).toBe(0);
    expect(res!.ptc).toBe(0);
    expect(res!.grossPremium).toBeCloseTo(21000, 10);
    expect(res!.netPremium).toBeCloseTo(21000, 10);
    expect(res!.cliffHeadroom).toBe(-1);
    // Property tests grep the trace for the cliff.
    expect(trace.some((l) => `${l.label} ${l.note ?? ''}`.includes('cliff'))).toBe(true);
  });

  it('never mentions the cliff in the trace when the cliff did not apply', () => {
    // The cliff must be the only flagged discontinuity: a just-under-the-cliff
    // year (and an enhanced-credits year) must not trip the property-test grep.
    for (const [data, magi] of [
      [acaData, 84600],
      [{ ...acaData, enhancedCreditsExtended: true }, 95175],
    ] as Array<[AcaData, number]>) {
      const trace: TraceLine[] = [];
      const res = computeAca(acaInputs(), data, magi, trace);
      expect(res!.cliffApplied).toBe(false);
      expect(trace.some((l) => `${l.label} ${l.note ?? ''}`.includes('cliff'))).toBe(false);
    }
  });

  it('applies the enhanced 8.5% cap with no cliff at 450% FPL', () => {
    // Enhanced table, MAGI = 4.5 x 21,150 = 95,175 -> flat 8.5% band (fplTo null).
    // Expected contribution = 0.085 x 95,175 = 8,089.875.
    // PTC = 21,000 - 8,089.875 = 12,910.125. cliffHeadroom is null (no cliff exists).
    const enhanced: AcaData = { ...acaData, enhancedCreditsExtended: true };
    const res = computeAca(acaInputs(), enhanced, 95175);
    expect(res!.cliffApplied).toBe(false);
    expect(res!.applicablePct).toBeCloseTo(0.085, 10);
    expect(res!.expectedContribution).toBeCloseTo(8089.875, 6);
    expect(res!.ptc).toBeCloseTo(12910.125, 6);
    expect(res!.cliffHeadroom).toBeNull();
  });

  it('prorates both benchmark and contribution by enrolled months (6/12)', () => {
    // Same 225% FPL case as above (annual contribution 3,578.58) but 6 months:
    // PTC = max(0, 21,000 x 6/12 - 3,578.58 x 6/12) = 10,500 - 1,789.29 = 8,710.71.
    // Gross premium = 21,000 x 6/12 = 10,500. Net = 10,500 - 8,710.71 = 1,789.29.
    // expectedContribution is reported as the ANNUAL amount (3,578.58).
    const res = computeAca(acaInputs({ enrolledMonths: 6 }), acaData, 47587.5);
    expect(res!.expectedContribution).toBeCloseTo(3578.58, 6);
    expect(res!.ptc).toBeCloseTo(8710.71, 6);
    expect(res!.grossPremium).toBeCloseTo(10500, 10);
    expect(res!.netPremium).toBeCloseTo(1789.29, 6);
  });

  it('SC (never expanded): NO credit below 100% FPL — the coverage gap, with a trace note', () => {
    // SC at 90% FPL: MAGI = 0.9 x 21,150 = 19,035 -> fplPct 0.9 < 1.0. SC is
    // NOT a Medicaid-expansion state, so no Medicaid short-circuit; under
    // IRC §36B (pre-ARPA rules, 2026 law) a household under 100% FPL is not
    // an applicable taxpayer: PTC = 0, applicablePct = null, net premium =
    // full gross 21,000. cliffApplied stays false (that flag means the 400%
    // cliff). Headroom = 4 x 21,150 - 19,035 = 84,600 - 19,035 = 65,565.
    const trace: TraceLine[] = [];
    const res = computeAca(acaInputs({}, { state: 'sc' }), acaData, 19035, trace);
    expect(res!.enrolled).toBe(true);
    expect(res!.applicablePct).toBeNull();
    expect(res!.expectedContribution).toBe(0);
    expect(res!.ptc).toBe(0);
    expect(res!.grossPremium).toBeCloseTo(21000, 10);
    expect(res!.netPremium).toBeCloseTo(21000, 10);
    expect(res!.cliffApplied).toBe(false);
    expect(res!.cliffHeadroom).toBeCloseTo(65565, 6);
    expect(trace.some((l) => `${l.label} ${l.note ?? ''}`.includes('below 100% FPL'))).toBe(true);
    // Not the 400% cliff: the trace must not trip the property-test grep.
    expect(trace.some((l) => `${l.label} ${l.note ?? ''}`.toLowerCase().includes('cliff'))).toBe(
      false,
    );
  });

  it('SC at 120% FPL: PTC per the standard table (flat 2.1% in the 100-133 band)', () => {
    // SC (non-expansion) at 120% FPL: MAGI = 1.2 x 21,150 = 25,380. No
    // Medicaid short-circuit and fplPct >= 1.0, so the normal table applies.
    // Row 0-1.33 is flat 2.1% -> expected contribution = 0.021 x 25,380
    // = 532.98. PTC = 21,000 - 532.98 = 20,467.02. Net premium = 532.98.
    // Headroom = 84,600 - 25,380 = 59,220.
    const res = computeAca(acaInputs({}, { state: 'sc' }), acaData, 25380);
    expect(res!.fplPct).toBeCloseTo(1.2, 10);
    expect(res!.applicablePct).toBeCloseTo(0.021, 10);
    expect(res!.expectedContribution).toBeCloseTo(532.98, 6);
    expect(res!.ptc).toBeCloseTo(20467.02, 6);
    expect(res!.grossPremium).toBeCloseTo(21000, 10);
    expect(res!.netPremium).toBeCloseTo(532.98, 6);
    expect(res!.cliffApplied).toBe(false);
    expect(res!.cliffHeadroom).toBeCloseTo(59220, 6);
  });

  it('VA (expansion state) at 90% FPL: Medicaid — $0 premium, no PTC, "Medicaid" trace', () => {
    // VA at 90% FPL: MAGI = 0.9 x 21,150 = 19,035 -> fplPct 0.9 < 1.38 and VA
    // expanded Medicaid (2019): modeled as Medicaid — grossPremium = 0,
    // netPremium = 0, ptc = 0, applicablePct = null. Not the 400% cliff.
    // Headroom = 84,600 - 19,035 = 65,565 (still reported).
    const trace: TraceLine[] = [];
    const res = computeAca(acaInputs(), acaData, 19035, trace);
    expect(res!.enrolled).toBe(true);
    expect(res!.fplPct).toBeCloseTo(0.9, 10);
    expect(res!.applicablePct).toBeNull();
    expect(res!.expectedContribution).toBe(0);
    expect(res!.ptc).toBe(0);
    expect(res!.grossPremium).toBe(0);
    expect(res!.netPremium).toBe(0);
    expect(res!.cliffApplied).toBe(false);
    expect(res!.cliffHeadroom).toBeCloseTo(65565, 6);
    expect(trace.some((l) => `${l.label} ${l.note ?? ''}`.includes('Medicaid'))).toBe(true);
    // Not the 400% cliff: the trace must not trip the property-test grep.
    expect(trace.some((l) => `${l.label} ${l.note ?? ''}`.toLowerCase().includes('cliff'))).toBe(
      false,
    );
  });

  it('VA at 150% FPL: above the Medicaid line, normal PTC applies', () => {
    // VA at 150% FPL: MAGI = 1.5 x 21,150 = 31,725 -> fplPct 1.5 >= 1.38, so
    // no Medicaid. Rows are half-open [from, to): 1.5 falls in the 1.5-2.0
    // band at its start -> pct = 4.19%. Expected contribution = 0.0419 x
    // 31,725 = 1,329.2775. PTC = 21,000 - 1,329.2775 = 19,670.7225.
    // Net premium = 1,329.2775. Headroom = 84,600 - 31,725 = 52,875.
    const res = computeAca(acaInputs(), acaData, 31725);
    expect(res!.fplPct).toBeCloseTo(1.5, 10);
    expect(res!.applicablePct).toBeCloseTo(0.0419, 10);
    expect(res!.expectedContribution).toBeCloseTo(1329.2775, 6);
    expect(res!.ptc).toBeCloseTo(19670.7225, 6);
    expect(res!.netPremium).toBeCloseTo(1329.2775, 6);
    expect(res!.cliffApplied).toBe(false);
    expect(res!.cliffHeadroom).toBeCloseTo(52875, 6);
  });

  it('NC (expanded 2023) at 130% FPL: Medicaid — $0 premium below 138%', () => {
    // NC at 130% FPL: MAGI = 1.3 x 21,150 = 27,495 -> fplPct 1.3 < 1.38 and
    // NC expanded Medicaid (2023): $0 premium, no PTC. Note 130% is ABOVE
    // 100% FPL — in a non-expansion state this would be a normal PTC year,
    // but Medicaid eligibility displaces the marketplace up to 138%.
    // Headroom = 84,600 - 27,495 = 57,105.
    const res = computeAca(acaInputs({}, { state: 'nc' }), acaData, 27495);
    expect(res!.fplPct).toBeCloseTo(1.3, 10);
    expect(res!.applicablePct).toBeNull();
    expect(res!.ptc).toBe(0);
    expect(res!.grossPremium).toBe(0);
    expect(res!.netPremium).toBe(0);
    expect(res!.cliffApplied).toBe(false);
    expect(res!.cliffHeadroom).toBeCloseTo(57105, 6);
  });

  it('enhanced regime, VA at 90% FPL: Medicaid still wins (ARPA does not change Medicaid)', () => {
    // Enhanced credits change the PTC schedule, not Medicaid eligibility:
    // VA at 90% FPL (MAGI 19,035) is Medicaid regardless of regime — $0
    // premium, no PTC. cliffHeadroom is null (no cliff in the enhanced regime).
    const enhanced: AcaData = { ...acaData, enhancedCreditsExtended: true };
    const trace: TraceLine[] = [];
    const res = computeAca(acaInputs(), enhanced, 19035, trace);
    expect(res!.applicablePct).toBeNull();
    expect(res!.ptc).toBe(0);
    expect(res!.grossPremium).toBe(0);
    expect(res!.netPremium).toBe(0);
    expect(res!.cliffApplied).toBe(false);
    expect(res!.cliffHeadroom).toBeNull();
    expect(trace.some((l) => `${l.label} ${l.note ?? ''}`.includes('Medicaid'))).toBe(true);
  });

  it('SC below 100% FPL stays eligible at 0% under the enhanced (ARPA) schedule', () => {
    // Enhanced regime, SC (non-expansion) at 80% FPL: MAGI = 0.8 x 21,150
    // = 16,920. No Medicaid short-circuit (SC never expanded); the enhanced
    // table row 0-1.5 is flat 0% -> expected contribution = 0.
    // PTC = 21,000 - 0 = 21,000 (full benchmark); net premium = 0.
    // cliffHeadroom is null (no cliff exists in the enhanced regime).
    const enhanced: AcaData = { ...acaData, enhancedCreditsExtended: true };
    const res = computeAca(acaInputs({}, { state: 'sc' }), enhanced, 16920);
    expect(res!.applicablePct).toBe(0);
    expect(res!.expectedContribution).toBe(0);
    expect(res!.ptc).toBeCloseTo(21000, 10);
    expect(res!.netPremium).toBeCloseTo(0, 10);
    expect(res!.cliffApplied).toBe(false);
    expect(res!.cliffHeadroom).toBeNull();
  });

  it('indexes the FPL (and therefore the cliff) by inflationIndex', () => {
    // MAGI 90,000 at index 1.0: fplPct = 90,000/21,150 = 4.2553 -> over the cliff.
    const at1 = computeAca(acaInputs(), acaData, 90000);
    expect(at1!.cliffApplied).toBe(true);
    // At index 1.2: FPL = 21,150 x 1.2 = 25,380; fplPct = 90,000/25,380 = 3.546 -> under.
    // Flat 9.96% band: contribution = 0.0996 x 90,000 = 8,964.
    // PTC = 21,000 - 8,964 = 12,036. Headroom = 4 x 25,380 - 90,000 = 11,520.
    const at12 = computeAca(acaInputs({}, { inflationIndex: 1.2 }), acaData, 90000);
    expect(at12!.cliffApplied).toBe(false);
    expect(at12!.fplPct).toBeCloseTo(90000 / 25380, 10);
    expect(at12!.applicablePct).toBeCloseTo(0.0996, 10);
    expect(at12!.expectedContribution).toBeCloseTo(8964, 6);
    expect(at12!.ptc).toBeCloseTo(12036, 6);
    expect(at12!.cliffHeadroom).toBeCloseTo(11520, 6);
  });

  it('nets a pricier-than-benchmark plan against the benchmark-based credit', () => {
    // Gross plan 24,000/yr but benchmark 21,000/yr; 225% FPL as above.
    // PTC = 21,000 - 3,578.58 = 17,421.42 (benchmark-based).
    // Net premium = 24,000 - 17,421.42 = 6,578.58.
    const res = computeAca(acaInputs({ grossAnnualPremium: 24000 }), acaData, 47587.5);
    expect(res!.ptc).toBeCloseTo(17421.42, 6);
    expect(res!.grossPremium).toBeCloseTo(24000, 10);
    expect(res!.netPremium).toBeCloseTo(6578.58, 6);
  });

  it('returns identical results with and without a trace array', () => {
    const trace: TraceLine[] = [];
    const withTrace = computeAca(acaInputs(), acaData, 47587.5, trace);
    const withoutTrace = computeAca(acaInputs(), acaData, 47587.5);
    expect(withTrace).toEqual(withoutTrace);
    expect(trace.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// computeMedicare
// ---------------------------------------------------------------------------

describe('computeMedicare', () => {
  it('returns null when not on Medicare or all enrolled months are 0', () => {
    expect(computeMedicare(baseInputs(), medicareData)).toBeNull();
    expect(
      computeMedicare(medicareInputs({ enrolledMonthsPerPerson: [0, 0] }), medicareData),
    ).toBeNull();
  });

  it('charges standard premiums at exactly the tier-1 threshold (strict >)', () => {
    // MAGI = 218,000 exactly -> NOT > 218,000 -> tier 0 (standard).
    // Part B = 202.90 x (12+12) = 4,869.60. Part D plan = 40 x 24 = 960.
    // Total = 4,869.60 + 960 = 5,829.60.
    const res = computeMedicare(medicareInputs({ magiTwoYearsPrior: 218000 }), medicareData);
    expect(res!.tierIndex).toBe(0);
    expect(res!.partB).toBeCloseTo(4869.6, 6);
    expect(res!.irmaaPartB).toBe(0);
    expect(res!.partDPlan).toBeCloseTo(960, 10);
    expect(res!.irmaaPartD).toBe(0);
    expect(res!.total).toBeCloseTo(5829.6, 6);
  });

  it('applies tier 1 when MAGI is $1 over the threshold', () => {
    // MAGI = 218,001 > 218,000 -> tier 1: Part B total 284.10, D add-on 14.50.
    // Part B base = 202.90 x 24 = 4,869.60.
    // Part B IRMAA = (284.10 - 202.90) x 24 = 81.20 x 24 = 1,948.80.
    // Part D plan = 40 x 24 = 960. Part D IRMAA = 14.50 x 24 = 348.
    // Total = 4,869.60 + 1,948.80 + 960 + 348 = 8,126.40.
    const trace: TraceLine[] = [];
    const res = computeMedicare(
      medicareInputs({ magiTwoYearsPrior: 218001 }),
      medicareData,
      trace,
    );
    expect(res!.tierIndex).toBe(1);
    expect(res!.partB).toBeCloseTo(4869.6, 6);
    expect(res!.irmaaPartB).toBeCloseTo(1948.8, 6);
    expect(res!.partDPlan).toBeCloseTo(960, 10);
    expect(res!.irmaaPartD).toBeCloseTo(348, 6);
    expect(res!.total).toBeCloseTo(8126.4, 6);
    // Trace covers the 2-year-lookback MAGI and the tier boundary comparison.
    expect(trace.some((l) => l.label.includes('2 years prior') && l.amount === 218001)).toBe(true);
    expect(trace.some((l) => `${l.label} ${l.note ?? ''}`.includes('tier-1 threshold'))).toBe(true);
    expect(trace.some((l) => l.label.includes('enrolled months'))).toBe(true);
  });

  it('CPI-indexes the IRMAA thresholds via inflationIndex', () => {
    // Index 1.2 -> tier-1 threshold = 218,000 x 1.2 = 261,600.
    // MAGI 250,000 (tier 1 at index 1.0) stays standard: 250,000 < 261,600.
    // Premium amounts are NOT scaled by inflationIndex (only premiumIndex does that):
    // Part B = 202.90 x 24 = 4,869.60.
    const res = computeMedicare(
      medicareInputs({ magiTwoYearsPrior: 250000 }, { inflationIndex: 1.2 }),
      medicareData,
    );
    expect(res!.tierIndex).toBe(0);
    expect(res!.irmaaPartB).toBe(0);
    expect(res!.partB).toBeCloseTo(4869.6, 6);
  });

  it('scales premiums by premiumIndex but never the Part D plan premium', () => {
    // premiumIndex 1.5, MAGI 250,000 -> tier 1 (index 1.0), person 1 only 12 mo.
    // Part B base = 202.90 x 1.5 x 12 = 3,652.20.
    // Part B IRMAA = (284.10 - 202.90) x 1.5 x 12 = 81.20 x 1.5 x 12 = 1,461.60.
    // Part D plan = 40 x 12 = 480 (current-year dollars — NOT x1.5, else 720).
    // Part D IRMAA = 14.50 x 1.5 x 12 = 261.
    // Total = 3,652.20 + 1,461.60 + 480 + 261 = 5,854.80.
    const res = computeMedicare(
      medicareInputs({
        magiTwoYearsPrior: 250000,
        premiumIndex: 1.5,
        enrolledMonthsPerPerson: [12, 0],
      }),
      medicareData,
    );
    expect(res!.tierIndex).toBe(1);
    expect(res!.partB).toBeCloseTo(3652.2, 6);
    expect(res!.irmaaPartB).toBeCloseTo(1461.6, 6);
    expect(res!.partDPlan).toBeCloseTo(480, 10);
    expect(res!.irmaaPartD).toBeCloseTo(261, 6);
    expect(res!.total).toBeCloseTo(5854.8, 6);
  });

  it('sums per-person enrolled months (12 and 6 — the 2036 transition year)', () => {
    // Standard tier, months [12, 6] = 18 person-months.
    // Part B = 202.90 x 18 = 3,652.20. Part D plan = 40 x 18 = 720.
    // Total = 3,652.20 + 720 = 4,372.20.
    const res = computeMedicare(
      medicareInputs({ enrolledMonthsPerPerson: [12, 6] }),
      medicareData,
    );
    expect(res!.partB).toBeCloseTo(3652.2, 6);
    expect(res!.partDPlan).toBeCloseTo(720, 10);
    expect(res!.total).toBeCloseTo(4372.2, 6);
  });

  it('picks the highest exceeded tier (MAGI $800k -> tier 5)', () => {
    // 800,000 > 750,000 -> tier 5: Part B total 689.90, D add-on 91.00.
    // Part B base = 202.90 x 24 = 4,869.60.
    // Part B IRMAA = (689.90 - 202.90) x 24 = 487 x 24 = 11,688.
    // Part D plan = 40 x 24 = 960. Part D IRMAA = 91 x 24 = 2,184.
    // Total = 4,869.60 + 11,688 + 960 + 2,184 = 19,701.60.
    const res = computeMedicare(medicareInputs({ magiTwoYearsPrior: 800000 }), medicareData);
    expect(res!.tierIndex).toBe(5);
    expect(res!.partB).toBeCloseTo(4869.6, 6);
    expect(res!.irmaaPartB).toBeCloseTo(11688, 6);
    expect(res!.irmaaPartD).toBeCloseTo(2184, 6);
    expect(res!.total).toBeCloseTo(19701.6, 6);
  });

  it('returns identical results with and without a trace array', () => {
    const trace: TraceLine[] = [];
    const withTrace = computeMedicare(
      medicareInputs({ magiTwoYearsPrior: 300000 }),
      medicareData,
      trace,
    );
    const withoutTrace = computeMedicare(medicareInputs({ magiTwoYearsPrior: 300000 }), medicareData);
    expect(withTrace).toEqual(withoutTrace);
    expect(trace.length).toBeGreaterThan(0);
  });
});

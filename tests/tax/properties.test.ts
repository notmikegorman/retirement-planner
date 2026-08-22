/**
 * SPEC §8 acceptance suite — property tests for the tax engine (fast-check).
 *
 * Properties, per SPEC §8:
 * 1. MONOTONICITY — for random income mixes WITHOUT ACA enrollment,
 *    increasing any single income component never decreases after-tax income
 *    (income - totalTax), tolerance $0.01. The ACA cliff is the only intended
 *    violation and is verified separately (property 3).
 * 2. CONTINUITY — total federal tax as a function of wages is continuous
 *    across every 2026 MFJ bracket boundary (evaluate +/- $0.01, |dTax| <
 *    $0.05); same across the LTCG 0%/15% (and 15%/20%) breakpoints holding
 *    ordinary income fixed.
 * 3. ACA CLIFF — the only intended discontinuity: with ACA enrollment,
 *    crossing 400% FPL drops after-tax income by roughly the full PTC, and
 *    computeYear's trace (opts.trace) flags the cliff.
 * 4. SS WORKSHEET BOUNDS — taxable SS is always within [0, 0.85 x gross], and
 *    state taxable income never includes Social Security in va/sc/nc.
 * 5. 100%-FPL ELIGIBILITY EDGE — in a NON-expansion state (SC) under 2026
 *    (pre-ARPA) law a household below 100% FPL gets NO PTC (the coverage
 *    gap), so after-tax-after-premium income JUMPS UP as MAGI crosses 100%
 *    FPL. A beneficial discontinuity (never a monotonicity violation) and
 *    the trace flags the below-100% ineligibility. Complement: in an
 *    expansion state (VA) below 138% FPL is Medicaid at a $0 premium, and
 *    crossing 138% moves to a modest subsidized net premium — no jump of
 *    gross-premium magnitude.
 *
 * Data: the REAL verified 2026 files from data-defaults/assumptions/ (fs +
 * JSON.parse). fast-check runs are seeded and kept modest (numRuns 200) so
 * the suite stays fast and deterministic.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { computeYear } from '../../src/tax';
import type {
  AcaData,
  FederalTaxData,
  MedicareData,
  StateCode,
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

const NUM_RUNS = 200;
const SEED = 20260812; // deterministic fast-check runs

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

function money(opts: { max: number; min?: number }) {
  return fc.double({ min: opts.min ?? 0, max: opts.max, noNaN: true });
}

// ---------------------------------------------------------------------------
// 1. Monotonicity: more income never yields less after-tax income (no ACA)
// ---------------------------------------------------------------------------

type IncomeComponent = 'wages' | 'ltcg' | 'socialSecurityGross' | 'pretaxDistributions';

const COMPONENTS: IncomeComponent[] = [
  'wages',
  'ltcg',
  'socialSecurityGross',
  'pretaxDistributions',
];

/** Gross cash income across the four varied components. */
function grossIncome(i: TaxYearInputs): number {
  return i.wages + i.ltcg + i.socialSecurityGross + i.pretaxDistributions;
}

describe('property 1: monotonicity (SPEC §8 — no accidental cliffs)', () => {
  it('increasing any single income component by delta never decreases after-tax income', () => {
    fc.assert(
      fc.property(
        fc.record({
          wages: money({ max: 300_000 }),
          ltcg: money({ max: 200_000 }),
          socialSecurityGross: money({ max: 60_000 }),
          pretaxDistributions: money({ max: 200_000 }),
          delta: money({ min: 0.01, max: 25_000 }),
          which: fc.constantFrom<IncomeComponent>(...COMPONENTS),
          state: fc.constantFrom<StateCode>('va', 'sc', 'nc'),
          age: fc.constantFrom(55, 65, 75),
          inflationIndex: fc.double({ min: 1, max: 1.8, noNaN: true }),
        }),
        ({ wages, ltcg, socialSecurityGross, pretaxDistributions, delta, which, state, age, inflationIndex }) => {
          const base = inputs({
            wages,
            ltcg,
            socialSecurityGross,
            pretaxDistributions,
            state,
            agesAtYearEnd: [age, age],
            inflationIndex,
            aca: null, // WITHOUT ACA enrollment: the cliff is the only intended violation
          });
          const bumped: TaxYearInputs = { ...base, [which]: base[which] + delta };

          const afterTaxBase = grossIncome(base) - computeYear(base, data).totalTax;
          const afterTaxBumped = grossIncome(bumped) - computeYear(bumped, data).totalTax;

          // Tolerance $0.01 (SPEC §8).
          expect(afterTaxBumped).toBeGreaterThanOrEqual(afterTaxBase - 0.01);
        },
      ),
      { numRuns: NUM_RUNS, seed: SEED },
    );
  });
});

// ---------------------------------------------------------------------------
// 2. Continuity at bracket edges
// ---------------------------------------------------------------------------

describe('property 2: continuity at 2026 MFJ bracket boundaries', () => {
  // With wages-only income, zero itemizables, and inflationIndex 1, the
  // standard deduction (32,200) always wins (VA state tax stays under it, and
  // at the top boundaries the SALT cap phase-down pins itemized at/below
  // 10,000 + state tax... in every checked case itemized < 32,200), so
  // federal taxable income = wages - 32,200 exactly. Each ordinary-bracket
  // upper bound `upTo` is therefore crossed at wages = upTo + 32,200.
  const STD = 32_200;

  it('federal tax is continuous in wages across every ordinary-bracket boundary', () => {
    const finiteBounds = data.federal.bracketsMfj
      .map((b) => b.upTo)
      .filter((u): u is number => u !== null); // [24,800, 100,800, 211,400, 403,550, 512,450, 768,700]
    expect(finiteBounds.length).toBe(6);

    for (const upTo of finiteBounds) {
      const boundaryWages = upTo + STD;
      const below = computeYear(inputs({ wages: boundaryWages - 0.01 }), data);
      const above = computeYear(inputs({ wages: boundaryWages + 0.01 }), data);
      // Sanity: the deduction really is standard on both sides, so the
      // boundary sits exactly where this test thinks it does.
      expect(below.federal.deductionUsed).toBe('standard');
      expect(above.federal.deductionUsed).toBe('standard');
      // |dTax| < $0.05 across the 2-cent step (SPEC §8).
      expect(Math.abs(above.federal.total - below.federal.total)).toBeLessThan(0.05);
      // The full tax bill is continuous there too.
      expect(Math.abs(above.totalTax - below.totalTax)).toBeLessThan(0.05);
    }
  });

  it('federal tax is continuous in LTCG across the 0%/15% and 15%/20% breakpoints, ordinary income held fixed', () => {
    // Hold wages at 60,000 -> ordinary taxable income = 60,000 - 32,200
    // = 27,800 (standard deduction wins throughout). Preferential income
    // stacks on top, so the stack crosses:
    //   zeroRateTop 98,900   at ltcg = 98,900 - 27,800  = 71,100
    //   fifteenRateTop 613,700 at ltcg = 613,700 - 27,800 = 585,900
    const wages = 60_000;
    const ordinaryTaxable = wages - STD;
    const breakpoints = [
      data.federal.ltcgBreakpointsMfj.zeroRateTop - ordinaryTaxable,
      data.federal.ltcgBreakpointsMfj.fifteenRateTop - ordinaryTaxable,
    ];
    for (const ltcgAtBoundary of breakpoints) {
      const below = computeYear(inputs({ wages, ltcg: ltcgAtBoundary - 0.01 }), data);
      const above = computeYear(inputs({ wages, ltcg: ltcgAtBoundary + 0.01 }), data);
      expect(below.federal.deductionUsed).toBe('standard');
      expect(above.federal.deductionUsed).toBe('standard');
      expect(Math.abs(above.federal.total - below.federal.total)).toBeLessThan(0.05);
    }
  });
});

// ---------------------------------------------------------------------------
// 3. The ACA cliff is the only intended discontinuity — and it is flagged
// ---------------------------------------------------------------------------

describe('property 3: the ACA 400%-FPL cliff (the single intended discontinuity)', () => {
  // 400% FPL for 2 people at inflationIndex 1 = 4.0 x 21,150 = 84,600 MAGI
  // (aca-2026.json, enhancedCreditsExtended false).
  const aca = { enrolledMonths: 12, benchmarkAnnualPremium: 24_000, grossAnnualPremium: 24_000 };

  function acaYear(pretax: number): TaxYearInputs {
    return inputs({
      year: 2027,
      agesAtYearEnd: [56, 56],
      pretaxDistributions: pretax,
      distributions: [
        {
          personId: 'p1',
          accountType: '401k',
          amount: pretax,
          taxableAmount: pretax,
          penaltyException: 'rule_of_55',
          penaltyBase: 0,
        },
      ],
      aca,
    });
  }

  /** After-tax, after-premium income: the quantity the cliff actually dents. */
  function netIncome(i: TaxYearInputs): number {
    const r = computeYear(i, data);
    return grossIncome(i) - r.totalTax - (r.aca ? r.aca.netPremium : 0);
  }

  it('crossing 400% FPL drops after-tax income by roughly the full PTC', () => {
    const underInputs = acaYear(84_599); // $1 under the cliff
    const overInputs = acaYear(84_601); // $1 over the cliff

    const under = computeYear(underInputs, data);
    const over = computeYear(overInputs, data);
    expect(under.aca?.cliffApplied).toBe(false);
    expect(over.aca?.cliffApplied).toBe(true);
    expect(over.aca?.ptc).toBe(0);

    const ptcForfeited = under.aca?.ptc ?? 0;
    expect(ptcForfeited).toBeGreaterThan(10_000); // the cliff is material here

    // $2 more gross income leaves the household ~the whole PTC poorer:
    // a genuine discontinuity, sized by the forfeited credit (within $10 —
    // the $2 of income and ~$0.36 of marginal tax are the only other movers).
    const drop = netIncome(underInputs) - netIncome(overInputs);
    expect(drop).toBeGreaterThan(0.9 * ptcForfeited);
    expect(Math.abs(drop - ptcForfeited)).toBeLessThan(10);
  });

  it('the cliff is flagged in the detailTrace (SPEC §8), and only when it applies', () => {
    const over = computeYear(acaYear(84_601), data, { trace: true });
    expect(over.trace).toBeDefined();
    const mentionsCliff = (over.trace ?? []).some(
      (l) => l.label.toLowerCase().includes('cliff') || (l.note ?? '').toLowerCase().includes('cliff'),
    );
    expect(mentionsCliff).toBe(true);

    // Just under the cliff: no cliff line (the flag means "applied", not "near").
    const under = computeYear(acaYear(84_599), data, { trace: true });
    const underMentionsCliff = (under.trace ?? []).some(
      (l) => l.label.toLowerCase().includes('cliff') || (l.note ?? '').toLowerCase().includes('cliff'),
    );
    expect(underMentionsCliff).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 4. Social Security worksheet bounds and state exclusion
// ---------------------------------------------------------------------------

describe('property 4: SS worksheet bounds and state SS exclusion', () => {
  it('taxable SS is always within [0, 0.85 x gross]; state taxable income never includes SS (va/sc/nc)', () => {
    fc.assert(
      fc.property(
        fc.record({
          wages: money({ max: 300_000 }),
          pretaxDistributions: money({ max: 150_000 }),
          socialSecurityGross: money({ max: 120_000 }),
          taxExemptInterest: money({ max: 30_000 }),
          age: fc.constantFrom(55, 65, 75),
          inflationIndex: fc.double({ min: 1, max: 1.8, noNaN: true }),
        }),
        ({ wages, pretaxDistributions, socialSecurityGross, taxExemptInterest, age, inflationIndex }) => {
          for (const state of ['va', 'sc', 'nc'] as const) {
            const r = computeYear(
              inputs({
                wages,
                pretaxDistributions,
                socialSecurityGross,
                taxExemptInterest,
                state,
                agesAtYearEnd: [age, age],
                inflationIndex,
              }),
              data,
            );
            // Worksheet bounds: 0 <= taxable SS <= 85% of gross benefits.
            expect(r.federal.ssTaxableAmount).toBeGreaterThanOrEqual(0);
            expect(r.federal.ssTaxableAmount).toBeLessThanOrEqual(
              0.85 * socialSecurityGross + 1e-6,
            );
            // All three states start from federal AGI and subtract the
            // federally taxable SS, so state taxable income can never exceed
            // AGI minus taxable SS (i.e., SS never leaks into the state base).
            expect(r.state.taxableIncome).toBeLessThanOrEqual(
              r.federal.agi - r.federal.ssTaxableAmount + 1e-6,
            );
          }
        },
      ),
      { numRuns: NUM_RUNS, seed: SEED },
    );
  });

  it('SS-only income yields zero state taxable income in all three states', () => {
    // With 60,000 of SS and nothing else: provisional income = 30,000 < the
    // 32,000 tier-1 threshold -> 0 federally taxable, AGI = 0, and each state
    // exempts SS anyway -> state taxable income 0 and state tax 0.
    for (const state of ['va', 'sc', 'nc'] as const) {
      const r = computeYear(inputs({ socialSecurityGross: 60_000, state }), data);
      expect(r.federal.ssTaxableAmount).toBe(0);
      expect(r.state.taxableIncome).toBe(0);
      expect(r.state.total).toBe(0);
    }
  });
});

// ---------------------------------------------------------------------------
// 5. Below-100%-FPL PTC ineligibility: a beneficial jump UP at 100% FPL
// ---------------------------------------------------------------------------

describe('property 5: PTC eligibility begins at 100% FPL (2026 pre-ARPA law, non-expansion state)', () => {
  // 100% FPL for 2 people at inflationIndex 1 = 21,150 MAGI (aca-2026.json,
  // enhancedCreditsExtended false). The 100%-FPL jump exists only in a
  // NON-expansion state — SC never expanded Medicaid, so below 100% FPL the
  // household is not an applicable taxpayer -> PTC 0 and the full gross
  // premium is owed; at/above it the 2.1% band applies and the PTC is nearly
  // the whole benchmark. (In VA/NC, Medicaid covers everything below 138%
  // FPL at $0 — verified in the complementary VA property below.)
  const FPL = 21_150;
  const aca = { enrolledMonths: 12, benchmarkAnnualPremium: 24_000, grossAnnualPremium: 24_000 };

  function acaYear(pretax: number, state: StateCode = 'sc'): TaxYearInputs {
    return inputs({
      year: 2027,
      agesAtYearEnd: [56, 56],
      state,
      pretaxDistributions: pretax,
      distributions: [
        {
          personId: 'p1',
          accountType: '401k',
          amount: pretax,
          taxableAmount: pretax,
          penaltyException: 'rule_of_55',
          penaltyBase: 0,
        },
      ],
      aca,
    });
  }

  /** After-tax, after-premium income: the quantity the eligibility edge moves. */
  function netIncome(i: TaxYearInputs): number {
    const r = computeYear(i, data);
    return grossIncome(i) - r.totalTax - (r.aca ? r.aca.netPremium : 0);
  }

  it('after-tax-after-premium income JUMPS UP crossing 100% FPL (90% -> 110%)', () => {
    // 90% FPL (19,035): no PTC, net premium = full 24,000 gross.
    const at90 = computeYear(acaYear(0.9 * FPL), data);
    expect(at90.aca?.ptc).toBe(0);
    expect(at90.aca?.applicablePct).toBeNull();
    expect(at90.aca?.netPremium).toBeCloseTo(24_000, 6);
    expect(at90.aca?.cliffApplied).toBe(false); // NOT the 400% cliff

    // 110% FPL (23,265): eligible in the flat 2.1% band.
    const at110 = computeYear(acaYear(1.1 * FPL), data);
    expect(at110.aca?.applicablePct).toBeCloseTo(0.021, 9);
    expect(at110.aca?.ptc).toBeGreaterThan(20_000);

    // The discontinuity sits exactly at 100% FPL: $1 under vs $1 over.
    const underInputs = acaYear(FPL - 1);
    const overInputs = acaYear(FPL + 1);
    const under = computeYear(underInputs, data);
    const over = computeYear(overInputs, data);
    expect(under.aca?.ptc).toBe(0);
    const ptcGained = over.aca?.ptc ?? 0;
    // 2.1% band at ~100% FPL: PTC = 24,000 - 0.021 x 21,151 = 23,555.83.
    expect(ptcGained).toBeGreaterThan(20_000);

    // $2 more gross income leaves the household ~the whole PTC richer: a
    // beneficial discontinuity, sized by the gained credit (within $10 — the
    // $2 of income and pennies of marginal state tax are the only other
    // movers; federal tax is 0 on both sides at this income).
    const jump = netIncome(overInputs) - netIncome(underInputs);
    expect(jump).toBeGreaterThan(0.9 * ptcGained);
    expect(Math.abs(jump - ptcGained)).toBeLessThan(10);
  });

  it('the trace flags below-100%-FPL ineligibility (and never calls it a cliff)', () => {
    const r = computeYear(acaYear(0.9 * FPL), data, { trace: true });
    expect(r.trace).toBeDefined();
    const lines = (r.trace ?? []).map((l) => `${l.label} ${l.note ?? ''}`);
    expect(lines.some((l) => l.includes('below 100% FPL'))).toBe(true);
    // The 400% cliff remains the ONLY discontinuity flagged as "cliff".
    expect(lines.some((l) => l.toLowerCase().includes('cliff'))).toBe(false);
  });

  it('VA (expansion state): crossing 138% FPL swaps $0 Medicaid for a modest subsidized premium', () => {
    // Below 138% FPL in VA (expanded 2019): Medicaid — $0 premium, no PTC,
    // and the trace says so.
    const below = computeYear(acaYear(1.37 * FPL, 'va'), data, { trace: true });
    expect(below.aca?.ptc).toBe(0);
    expect(below.aca?.grossPremium).toBe(0);
    expect(below.aca?.netPremium).toBe(0);
    expect(below.aca?.cliffApplied).toBe(false);
    const lines = (below.trace ?? []).map((l) => `${l.label} ${l.note ?? ''}`);
    expect(lines.some((l) => l.includes('Medicaid'))).toBe(true);
    expect(lines.some((l) => l.toLowerCase().includes('cliff'))).toBe(false);

    // Just above 138% FPL: back on the marketplace with a near-full PTC.
    // MAGI = 1.39 x 21,150 = 29,398.50; band 1.33-1.5: pct = 0.0314 +
    // (0.0419 - 0.0314) x (1.39 - 1.33)/(1.5 - 1.33) = 0.0351059.
    // Net premium = expected contribution = 0.0351059 x 29,398.50 = 1,032.06
    // -- > $0 but ~4% of the 24,000 gross premium. No gross-premium-sized
    // jump here: the Medicaid edge is a modest step, not a cliff-like one.
    const above = computeYear(acaYear(1.39 * FPL, 'va'), data);
    expect(above.aca?.netPremium).toBeGreaterThan(0);
    expect(above.aca?.netPremium ?? Infinity).toBeLessThan(
      0.1 * (above.aca?.grossPremium ?? 0),
    );
    expect(above.aca?.netPremium).toBeCloseTo(1032.06, 1);
    expect(above.aca?.grossPremium).toBeCloseTo(24_000, 6);
  });
});

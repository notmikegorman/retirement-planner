/**
 * SINGLE-FILER FEDERAL AND STATE TAX, hand-computed — and THE WIDOW PENALTY
 * MADE VISIBLE.
 *
 * This file exists because the whole survivor feature rests on one claim: that
 * a widow's tax is computed on the single schedules, not on the joint ones
 * scaled by something. If that claim is wrong the widow score is not merely
 * imprecise, it is WRONG IN THE FLATTERING DIRECTION — it would report that
 * dropping a life-insurance policy is safe when it is not. So every figure
 * below is arithmetic spelled out in the comment above it, on the verified
 * TY2026 numbers in data-defaults/assumptions/, and most assertions come in
 * pairs: the same dollars, filed both ways.
 *
 * 2026 reference numbers used throughout:
 *   SINGLE brackets: 10% to 12,400; 12% to 50,400; 22% to 105,700; 24% to
 *     201,775; 32% to 256,225; 35% to 640,600; 37% above.
 *   MFJ brackets:    10% to 24,800; 12% to 100,800; 22% to 211,400; 24% to
 *     403,550; 32% to 512,450; 35% to 768,700; 37% above.
 *   Standard deduction 16,100 single (+2,050 per person 65+, the UNMARRIED
 *     rate) against 32,200 MFJ (+1,650 per spouse).
 *   LTCG breakpoints: 0% top 49,450 / 15% top 545,500 single;
 *     98,900 / 613,700 MFJ.
 *   NIIT 3.8% over 200,000 single, 250,000 MFJ — statutory, never indexed.
 *   SS provisional thresholds 25,000/34,000 single, 32,000/44,000 MFJ —
 *     statutory, never indexed.
 *   VA standard deduction 2026: 8,750 single / 17,500 MFJ; age-deduction AFAGI
 *     threshold 50,000 single / 75,000 MFJ.
 *   SC SCIAD 15,000 phasing from 40,000 over 55,000 (single) against 30,000
 *     from 80,000 over 110,000 (MFJ). NC standard deduction 12,750 / 25,500.
 *   ACA FPL 15,650 one person / 21,150 two. IRMAA single tiers start at
 *     109,000 and top out at 500,000 (MFJ: 218,000 / 750,000).
 */

import { describe, expect, it } from 'vitest';
import {
  bracketTax,
  bracketsFor,
  computeFederal,
  homeSaleExclusionFor,
  ltcgBreakpointsFor,
  niitThresholdFor,
  nonItemizerCharitableCap,
  saltCap,
  ssTaxableWorksheet,
  ssThresholdsFor,
  standardDeductionParts,
} from '../../src/tax/federal';
import { computeYear } from '../../src/tax/computeYear';
import { computeAca, computeMedicare } from '../../src/tax/acaMedicare';
import type {
  AcaData,
  FederalTaxData,
  FilingStatus,
  MedicareData,
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

const fed = federalJson as unknown as FederalTaxData;
const acaData = acaJson as unknown as AcaData;
const medicareData = medicareJson as unknown as MedicareData;

const bundle: TaxDataBundle = {
  federal: fed,
  states: {
    va: vaJson as unknown as StateTaxData,
    sc: scJson as unknown as StateTaxData,
    nc: ncJson as unknown as StateTaxData,
  },
  aca: acaData,
  medicare: medicareData,
};

/**
 * A tax year. `filingStatus` and `agesAtYearEnd` are the two things a death
 * changes, and they move TOGETHER — a widow files single AND is one person in
 * the tax household — so the helper takes the pair and every paired assertion
 * below flips both, never one.
 */
function inputs(status: FilingStatus, partial: Partial<TaxYearInputs> = {}): TaxYearInputs {
  const people = status === 'single' ? 1 : 2;
  return {
    year: 2026,
    filingStatus: status,
    state: 'va',
    birthYears: new Array(people).fill(1971),
    agesAtYearEnd: new Array(people).fill(55),
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

// ---------------------------------------------------------------------------
// 1. Brackets
// ---------------------------------------------------------------------------

describe('single ordinary brackets', () => {
  it('hand-computed at 60,000 taxable: 7,912 single against 6,704 MFJ', () => {
    // SINGLE: 10% x 12,400 = 1,240; 12% x (50,400 - 12,400) = 12% x 38,000 =
    // 4,560; 22% x (60,000 - 50,400) = 22% x 9,600 = 2,112. Total 7,912.
    expect(bracketTax(60_000, fed.bracketsSingle, 1)).toBeCloseTo(7_912, 9);
    // MFJ on the same income: 10% x 24,800 = 2,480; 12% x 35,200 = 4,224.
    // Total 6,704 — the same 60,000 costs 1,208 more filed alone.
    expect(bracketTax(60_000, fed.bracketsMfj, 1)).toBeCloseTo(6_704, 9);
  });

  it('hand-computed at 250,000 taxable: 56,456 single against 45,196 MFJ', () => {
    // SINGLE, cumulative through the table:
    //   10% x 12,400                       =  1,240   (cum  1,240)
    //   12% x (50,400 - 12,400) = 38,000   =  4,560   (cum  5,800)
    //   22% x (105,700 - 50,400) = 55,300  = 12,166   (cum 17,966)
    //   24% x (201,775 - 105,700) = 96,075 = 23,058   (cum 41,024)
    //   32% x (250,000 - 201,775) = 48,225 = 15,432   (cum 56,456)
    expect(bracketTax(250_000, fed.bracketsSingle, 1)).toBeCloseTo(56_456, 9);
    // MFJ: 2,480 + 12% x 76,000 = 11,600; + 22% x 110,600 = 35,932;
    //      + 24% x 38,600 = 45,196. A 11,260 gap on identical income.
    expect(bracketTax(250_000, fed.bracketsMfj, 1)).toBeCloseTo(45_196, 9);
  });

  it('is exact at every single-filer bracket edge', () => {
    const edges: Array<[number, number]> = [
      [12_400, 1_240], // top of 10%
      [50_400, 5_800], // 1,240 + 4,560
      [105_700, 17_966], // 5,800 + 12,166
      [201_775, 41_024], // 17,966 + 23,058
      [256_225, 58_448], // 41,024 + 32% x 54,450 = 41,024 + 17,424
      [640_600, 192_979.25], // 58,448 + 35% x 384,375 = 58,448 + 134,531.25
    ];
    for (const [taxable, tax] of edges) {
      expect(bracketTax(taxable, fed.bracketsSingle, 1)).toBeCloseTo(tax, 6);
    }
    // Continuity: $1 past the 640,600 edge adds 37 cents, not a jump.
    expect(bracketTax(640_601, fed.bracketsSingle, 1)).toBeCloseTo(192_979.62, 6);
  });

  it('the 37% entry is NOT half the MFJ one — halving would give the MFS figure', () => {
    /*
     * The trap this data file was written to avoid. The first five single
     * thresholds ARE exactly half of MFJ, which makes "just halve it" look
     * safe; the 35%/37% boundary is not. 640,600 single against 768,700 MFJ is
     * a ratio of 0.8334, and half of the MFJ figure — 384,350 — is the MARRIED
     * FILING SEPARATELY threshold, a status this planner does not model. A
     * halving implementation would understate the top of a widow's bracket run
     * by 256,250 dollars.
     */
    const single = bracketsFor(fed, 'single');
    const mfj = bracketsFor(fed, 'mfj');
    for (let i = 0; i < 5; i++) {
      expect(single[i].upTo).toBe((mfj[i].upTo as number) / 2);
    }
    expect(single[5].upTo).toBe(640_600);
    expect(mfj[5].upTo).toBe(768_700);
    expect(single[5].upTo).not.toBe((mfj[5].upTo as number) / 2);
    expect((mfj[5].upTo as number) / 2).toBe(384_350); // the MFS figure, for the record
    // Rates are identical; only the thresholds move.
    expect(single.map((b) => b.rate)).toEqual(mfj.map((b) => b.rate));
  });

  it('resolves the table from the status, so nothing has to remember the pairing', () => {
    expect(bracketsFor(fed, 'single')).toBe(fed.bracketsSingle);
    expect(bracketsFor(fed, 'mfj')).toBe(fed.bracketsMfj);
  });
});

// ---------------------------------------------------------------------------
// 2. Standard deduction, including the §63(f) unmarried 65+ rate
// ---------------------------------------------------------------------------

describe('single standard deduction', () => {
  it('16,100 base, and the 65+ add-on is the 2,050 UNMARRIED rate, not 1,650', () => {
    /*
     * §63(f) sets the additional standard deduction at $1,650 per aged
     * individual and raises it to $2,050 "if the individual is also unmarried
     * and not a surviving spouse", where "surviving spouse" is the §2(a)
     * status that REQUIRES a dependent child. A childless widow is unmarried
     * and not a §2(a) surviving spouse, so they get the larger figure. Reusing
     * the married per-spouse amount would quietly cost them $400 of deduction
     * every year for the rest of their life — the one crumb of comfort in the
     * widow penalty, and easy to drop.
     */
    expect(standardDeductionParts(fed, 'single')).toEqual({ base: 16_100, per65: 2_050 });
    expect(standardDeductionParts(fed, 'mfj')).toEqual({ base: 32_200, per65: 1_650 });
  });

  it('a widow at 70 gets 18,150 against the couple’s 35,500 — a ratio of 0.5113, not 0.5', () => {
    // Single at 70:  16,100 + 1 x 2,050 = 18,150.
    // MFJ, both 70:  32,200 + 2 x 1,650 = 35,500.
    // 18,150 / 35,500 = 0.51127. The deduction does NOT simply halve, because
    // the unmarried 65+ rate is 400 higher per person. Everything else about
    // the survivor's return got worse; this one line got very slightly better.
    const single = computeFederal(
      inputs('single', { agesAtYearEnd: [70], pretaxDistributions: 100_000 }),
      fed,
      0,
    );
    const joint = computeFederal(
      inputs('mfj', { agesAtYearEnd: [70, 70], pretaxDistributions: 100_000 }),
      fed,
      0,
    );
    expect(single.standardDeduction).toBeCloseTo(18_150, 9);
    expect(joint.standardDeduction).toBeCloseTo(35_500, 9);
    expect(single.standardDeduction / joint.standardDeduction).toBeCloseTo(0.5112676056, 9);
  });

  it('indexes with CPI like the joint one: (16,100 + 2,050) x 1.6 = 29,040', () => {
    const res = computeFederal(
      inputs('single', {
        agesAtYearEnd: [70],
        pretaxDistributions: 100_000,
        inflationIndex: 1.6,
      }),
      fed,
      0,
    );
    expect(res.standardDeduction).toBeCloseTo(29_040, 9);
  });

  it('counts 65+ add-ons from the TAX HOUSEHOLD, so the death year still gets two', () => {
    // agesAtYearEnd carries the year's tax household (2 through the year of
    // death, 1 after), and this is the line that reads it. A death-year return
    // is still joint AND still counts both spouses' age add-ons.
    const deathYear = computeFederal(
      inputs('mfj', { agesAtYearEnd: [70, 70], pretaxDistributions: 100_000 }),
      fed,
      0,
    );
    const yearAfter = computeFederal(
      inputs('single', { agesAtYearEnd: [70], pretaxDistributions: 100_000 }),
      fed,
      0,
    );
    expect(deathYear.standardDeduction - yearAfter.standardDeduction).toBeCloseTo(17_350, 9);
  });
});

// ---------------------------------------------------------------------------
// 3. LTCG / qualified-dividend stacking
// ---------------------------------------------------------------------------

describe('single LTCG stacking', () => {
  it('breakpoints: the 0% top halves but the 15% top does NOT', () => {
    // 49,450 IS half of 98,900. 545,500 is not half of 613,700 (that would be
    // 306,850 — the MFS figure again). Same trap, one module over.
    expect(ltcgBreakpointsFor(fed, 'single')).toEqual({
      zeroRateTop: 49_450,
      fifteenRateTop: 545_500,
    });
    expect(ltcgBreakpointsFor(fed, 'mfj')).toEqual({
      zeroRateTop: 98_900,
      fifteenRateTop: 613_700,
    });
    expect(ltcgBreakpointsFor(fed, 'single').fifteenRateTop).not.toBe(613_700 / 2);
  });

  it('the same 30,000 gain is entirely tax-free jointly and costs 3,082.50 single', () => {
    /*
     * Inputs both ways: 56,100 of IRA distributions + a 30,000 long-term gain,
     * nobody 65 yet, no state tax in the SALT slot.
     *
     * SINGLE: AGI = 86,100; standard deduction 16,100; taxable 70,000.
     *   Preferential = 30,000 -> ordinary taxable = 40,000.
     *   Ordinary tax = 1,240 + 12% x 27,600 = 1,240 + 3,312 = 4,552.
     *   Stacking: 0% band runs to 49,450, of which 40,000 is used by ordinary
     *     income, so 9,450 of the gain is at 0% and the remaining 20,550 at
     *     15% = 3,082.50. (15% top 545,500 is far away; nothing at 20%.)
     *   Federal total = 4,552 + 3,082.50 = 7,634.50.
     *
     * MFJ: AGI = 86,100; standard deduction 32,200; taxable 53,900.
     *   Preferential = 30,000 -> ordinary taxable = 23,900.
     *   Ordinary tax = 10% x 23,900 = 2,390.
     *   Stacking: 0% band runs to 98,900 and only 23,900 is used, leaving
     *     75,000 of room — the whole 30,000 gain is taxed at 0%.
     *   Federal total = 2,390.
     *
     * Same dollars, 3.19x the federal tax. NIIT is 0 both ways (MAGI 86,100).
     */
    const common = { pretaxDistributions: 56_100, ltcg: 30_000 };
    const single = computeFederal(inputs('single', common), fed, 0);
    const joint = computeFederal(inputs('mfj', common), fed, 0);

    expect(single.taxableIncome).toBeCloseTo(70_000, 9);
    expect(single.taxableOrdinaryIncome).toBeCloseTo(40_000, 9);
    expect(single.ordinaryTax).toBeCloseTo(4_552, 9);
    expect(single.ltcgTax).toBeCloseTo(3_082.5, 9);
    expect(single.total).toBeCloseTo(7_634.5, 9);

    expect(joint.taxableIncome).toBeCloseTo(53_900, 9);
    expect(joint.taxableOrdinaryIncome).toBeCloseTo(23_900, 9);
    expect(joint.ordinaryTax).toBeCloseTo(2_390, 9);
    expect(joint.ltcgTax).toBe(0);
    expect(joint.total).toBeCloseTo(2_390, 9);
  });

  it('reaches the 20% band: 500,000 ordinary + 100,000 preferential -> 17,725 of LTCG tax', () => {
    /*
     * SINGLE. AGI = 616,100 (516,100 of distributions + a 100,000 gain);
     * standard deduction 16,100; taxable 600,000, of which 100,000 is
     * preferential and 500,000 ordinary.
     *
     * Ordinary tax = 58,448 (cumulative to 256,225) + 35% x 243,775
     *              = 58,448 + 85,321.25 = 143,769.25.
     * Stacking: ordinary income already fills the 0% band and all but 45,500
     *   of the 15% band (545,500 - 500,000), so 45,500 at 15% = 6,825 and the
     *   remaining 54,500 at 20% = 10,900. LTCG tax 17,725.
     * NIIT: NII = 100,000; MAGI 616,100 is 416,100 over the 200,000 single
     *   threshold, so the whole NII is hit: 3.8% x 100,000 = 3,800.
     * Federal total = 143,769.25 + 17,725 + 3,800 = 165,294.25.
     */
    const res = computeFederal(
      inputs('single', { pretaxDistributions: 516_100, ltcg: 100_000 }),
      fed,
      0,
    );
    expect(res.taxableIncome).toBeCloseTo(600_000, 9);
    expect(res.taxableOrdinaryIncome).toBeCloseTo(500_000, 9);
    expect(res.ordinaryTax).toBeCloseTo(143_769.25, 6);
    expect(res.ltcgTax).toBeCloseTo(17_725, 6);
    expect(res.niit).toBeCloseTo(3_800, 9);
    expect(res.total).toBeCloseTo(165_294.25, 6);
  });
});

// ---------------------------------------------------------------------------
// 4. NIIT
// ---------------------------------------------------------------------------

describe('single NIIT', () => {
  it('threshold is 200,000 — statutory, and NOT indexed', () => {
    expect(niitThresholdFor(fed, 'single')).toBe(200_000);
    expect(niitThresholdFor(fed, 'mfj')).toBe(250_000);
    // §1411(b)(1) gives the 250,000 figure to a joint return OR a §2(a)
    // surviving spouse. A widow with no dependent child is neither, from the
    // first full year after the death — she drops 50,000 of threshold.
  });

  it('MAGI 220,000 with 50,000 of NII: 760 single, nothing MFJ', () => {
    // 170,000 of IRA distributions + 50,000 of taxable interest -> AGI 220,000.
    // NII = interest 50,000 (no dividends, no gains).
    // SINGLE: excess over 200,000 = 20,000; 3.8% x min(50,000, 20,000) = 760.
    // MFJ:    excess over 250,000 = 0, so no NIIT at all.
    const common = { pretaxDistributions: 170_000, taxableInterest: 50_000 };
    expect(computeFederal(inputs('single', common), fed, 0).niit).toBeCloseTo(760, 9);
    expect(computeFederal(inputs('mfj', common), fed, 0).niit).toBe(0);
  });

  it('the threshold does not move with CPI — that is the point of "statutory"', () => {
    /*
     * With inflationIndex 2.0, brackets and deductions double but the NIIT
     * threshold stays at 200,000 nominal. So a survivor 30 years out is hit on
     * an income that is unremarkable in real terms — the same slow tightening
     * that makes Social Security taxation creep. Inputs: 220,000 AGI again,
     * doubled index.
     */
    const res = computeFederal(
      inputs('single', {
        pretaxDistributions: 170_000,
        taxableInterest: 50_000,
        inflationIndex: 2,
      }),
      fed,
      0,
    );
    expect(res.niit).toBeCloseTo(760, 9); // identical to the index-1 case
  });
});

// ---------------------------------------------------------------------------
// 5. The Social Security provisional-income worksheet
// ---------------------------------------------------------------------------

describe('single Social Security taxation worksheet (IRC §86)', () => {
  it('thresholds are 25,000 / 34,000 — 7,000 below MFJ at BOTH tiers', () => {
    expect(ssThresholdsFor(fed, 'single')).toEqual({ tier1: 25_000, tier2: 34_000 });
    expect(ssThresholdsFor(fed, 'mfj')).toEqual({ tier1: 32_000, tier2: 44_000 });
  });

  it('the same benefit becomes taxable 7,000 of provisional income sooner', () => {
    // 24,000 of benefits, 18,000 of other income.
    // PI = 18,000 + 0.5 x 24,000 = 30,000.
    // SINGLE: 25,000 < 30,000 <= 34,000, so the 50% tier applies:
    //   min(0.5 x (30,000 - 25,000) = 2,500, 0.5 x 24,000 = 12,000) = 2,500.
    // MFJ: 30,000 <= 32,000, so NOTHING is taxable.
    expect(
      ssTaxableWorksheet(24_000, 18_000, 0, ssThresholdsFor(fed, 'single')),
    ).toBeCloseTo(2_500, 9);
    expect(ssTaxableWorksheet(24_000, 18_000, 0, ssThresholdsFor(fed, 'mfj'))).toBe(0);
  });

  it('mid-range: 9,600 taxable single against 4,000 MFJ on the same 40,000 benefit', () => {
    // 40,000 of benefits, 20,000 of other income. PI = 20,000 + 20,000 = 40,000.
    // SINGLE (PI > 34,000, the 85% tier):
    //   tier-1 amount = min(0.5 x (40,000 - 25,000) = 7,500, 0.5 x 40,000) = 7,500
    //   capped at 0.5 x (34,000 - 25,000) = 4,500
    //   formula = 0.85 x (40,000 - 34,000) + 4,500 = 5,100 + 4,500 = 9,600
    //   taxable = min(0.85 x 40,000 = 34,000, 9,600) = 9,600.
    // MFJ (32,000 < PI <= 44,000, the 50% tier):
    //   min(0.5 x (40,000 - 32,000) = 4,000, 20,000) = 4,000.
    // 2.4x as much of the same cheque, purely from the filing change.
    expect(ssTaxableWorksheet(40_000, 20_000, 0, ssThresholdsFor(fed, 'single'))).toBeCloseTo(
      9_600,
      9,
    );
    expect(ssTaxableWorksheet(40_000, 20_000, 0, ssThresholdsFor(fed, 'mfj'))).toBeCloseTo(
      4_000,
      9,
    );
  });

  it('the 85% ceiling still binds for both statuses at high income', () => {
    // 40,000 of benefits, 100,000 of other income. PI = 120,000.
    // SINGLE formula = 0.85 x 86,000 + 4,500 = 77,600, capped at 0.85 x 40,000.
    // MFJ    formula = 0.85 x 76,000 + 6,000 = 70,600, capped the same way.
    // Both land on 34,000 — the widow penalty in this line is real but bounded.
    expect(ssTaxableWorksheet(40_000, 100_000, 0, ssThresholdsFor(fed, 'single'))).toBeCloseTo(
      34_000,
      9,
    );
    expect(ssTaxableWorksheet(40_000, 100_000, 0, ssThresholdsFor(fed, 'mfj'))).toBeCloseTo(
      34_000,
      9,
    );
  });

  it('runs through computeFederal on the status, not on a caller-passed table', () => {
    // Same wiring check as bracketsFor: the worksheet must read the status off
    // the inputs. 24,000 of benefits + 18,000 of distributions.
    const common = { socialSecurityGross: 24_000, pretaxDistributions: 18_000 };
    expect(computeFederal(inputs('single', common), fed, 0).ssTaxableAmount).toBeCloseTo(2_500, 9);
    expect(computeFederal(inputs('mfj', common), fed, 0).ssTaxableAmount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 6. The charitable cap, §121, and the SALT cap that does NOT move
// ---------------------------------------------------------------------------

describe('single-filer odds and ends', () => {
  it('non-itemizer charitable deduction: 1,000 single, 2,000 MFJ (IRC 170(p))', () => {
    expect(nonItemizerCharitableCap(fed, 'single')).toBe(1_000);
    expect(nonItemizerCharitableCap(fed, 'mfj')).toBe(2_000);

    // 60,000 of distributions, 5,000 given in cash, nothing itemizable.
    // SINGLE: itemized would be only the charitable component
    //   max(0, min(5,000, 60% x 60,000) - 0.5% x 60,000) = 5,000 - 300 = 4,700,
    //   well under the 16,100 standard deduction, so the standard is used and
    //   the non-itemizer deduction adds min(5,000, 1,000) = 1,000.
    //   Taxable = 60,000 - 16,100 - 1,000 = 42,900.
    //   Tax = 1,240 + 12% x 30,500 = 1,240 + 3,660 = 4,900.
    // MFJ: taxable = 60,000 - 32,200 - 2,000 = 25,800.
    //   Tax = 2,480 + 12% x 1,000 = 2,600.
    const common = { pretaxDistributions: 60_000, charitableGiving: 5_000 };
    const single = computeFederal(inputs('single', common), fed, 0);
    const joint = computeFederal(inputs('mfj', common), fed, 0);
    expect(single.deductionUsed).toBe('standard');
    expect(single.taxableIncome).toBeCloseTo(42_900, 9);
    expect(single.ordinaryTax).toBeCloseTo(4_900, 9);
    expect(joint.taxableIncome).toBeCloseTo(25_800, 9);
    expect(joint.ordinaryTax).toBeCloseTo(2_600, 9);
  });

  it('§121: a widow keeps the FULL 500,000 exclusion for two years after the death', () => {
    /*
     * §121(b)(1) gives an unmarried filer 250,000 — but §121(b)(4) preserves
     * the whole 500,000 when the sale "occurs not later than 2 years after the
     * date of death of such spouse". A household planning to sell around
     * retirement lives inside that window, and modelling her sale at a flat
     * 250,000 would overstate her tax in exactly the scenario the widow score
     * exists to test.
     *
     * The annual engine reads the two-year test as saleYear <= deathYear + 2,
     * the generous end of the range for a sale late in year+2 — deliberate,
     * and asserted here so the boundary is a decision on the record rather
     * than an accident.
     */
    expect(homeSaleExclusionFor(fed, 'mfj', 2030, null)).toBe(500_000);
    expect(homeSaleExclusionFor(fed, 'mfj', 2030, 2029)).toBe(500_000);
    expect(homeSaleExclusionFor(fed, 'single', 2030, null)).toBe(250_000);
    expect(homeSaleExclusionFor(fed, 'single', 2029, 2029)).toBe(500_000); // same year
    expect(homeSaleExclusionFor(fed, 'single', 2031, 2029)).toBe(500_000); // +2, inside
    expect(homeSaleExclusionFor(fed, 'single', 2032, 2029)).toBe(250_000); // +3, outside
  });

  it('the SALT cap is NOT filing-status dependent — the tempting wrong answer', () => {
    /*
     * IRC 164(b)(6) gives single and joint filers the SAME applicable
     * limitation amount and the same phase-down threshold; only MARRIED FILING
     * SEPARATELY takes half of each, and this planner does not model that
     * status. "Surely it halves like everything else" is wrong, and it is the
     * kind of wrong that hides: a widow itemizing on a halved cap would look
     * plausible in every column.
     *
     * 30,000 of property tax + 20,000 of state income tax = 50,000 of SALT
     * against the 2026 cap of 40,400 (no phase-down under 505,000 of MAGI),
     * for BOTH statuses. Itemized = 0 mortgage + 40,400 + 0 charitable.
     */
    expect(saltCap(fed, 2026, 300_000, 1)).toBe(40_400);
    const common = {
      pretaxDistributions: 300_000,
      itemizable: { mortgageInterest: 0, propertyTax: 30_000 },
    };
    const single = computeFederal(inputs('single', common), fed, 20_000);
    const joint = computeFederal(inputs('mfj', common), fed, 20_000);
    expect(single.itemizedDeduction).toBeCloseTo(40_400, 9);
    expect(joint.itemizedDeduction).toBeCloseTo(40_400, 9);
    expect(single.itemizedDeduction).toBe(joint.itemizedDeduction);
    // Both itemize (40,400 beats either standard deduction), so the ONLY
    // remaining difference at this income is the bracket run.
    expect(single.deductionUsed).toBe('itemized');
    expect(joint.deductionUsed).toBe('itemized');
  });
});

// ---------------------------------------------------------------------------
// 7. ACA and IRMAA read one-person thresholds
// ---------------------------------------------------------------------------

describe('one-person ACA and IRMAA thresholds', () => {
  const acaYear = (status: FilingStatus, magi: number) =>
    computeAca(
      inputs(status, {
        aca: { enrolledMonths: 12, benchmarkAnnualPremium: 21_000, grossAnnualPremium: 21_000 },
      }),
      acaData,
      magi,
    );

  it('the 400% cliff is 62,600 for one person against 84,600 for the couple', () => {
    // FPL 15,650 x 4 = 62,600; 21,150 x 4 = 84,600.
    expect(acaData.fpl1Person * 4).toBe(62_600);
    expect(acaData.fpl2Person * 4).toBe(84_600);
  });

  it('70,000 of MAGI: a 14,028 credit jointly, and NOTHING single', () => {
    /*
     * THE SINGLE BIGGEST LINE IN A WIDOW SCORE for a household that retires in
     * its mid-fifties and sits on the exchange for a decade.
     *
     * MFJ: 70,000 / 21,150 = 331.0% of FPL, inside the 300-400% band whose
     *   applicable percentage is a flat 9.96%. Expected contribution =
     *   0.0996 x 70,000 = 6,972; PTC = 21,000 - 6,972 = 14,028; net premium
     *   6,972. Headroom to the cliff: 84,600 - 70,000 = 14,600.
     * SINGLE: 70,000 / 15,650 = 447.3% of FPL. Over 400%, so under 2026 law
     *   (enhanced credits expired) the ENTIRE credit is forfeited: PTC 0, net
     *   premium the full 21,000, headroom -7,400.
     *
     * The same withdrawal that cleared the cliff by 14,600 as a couple is
     * 7,400 over it as a widow, and the household pays 14,028 more for the
     * identical coverage.
     */
    const joint = acaYear('mfj', 70_000)!;
    expect(joint.fplPct).toBeCloseTo(70_000 / 21_150, 12);
    expect(joint.applicablePct).toBeCloseTo(0.0996, 12);
    expect(joint.expectedContribution).toBeCloseTo(6_972, 9);
    expect(joint.ptc).toBeCloseTo(14_028, 9);
    expect(joint.netPremium).toBeCloseTo(6_972, 9);
    expect(joint.cliffApplied).toBe(false);
    expect(joint.cliffHeadroom).toBeCloseTo(14_600, 9);

    const widow = acaYear('single', 70_000)!;
    expect(widow.fplPct).toBeCloseTo(70_000 / 15_650, 12);
    expect(widow.cliffApplied).toBe(true);
    expect(widow.ptc).toBe(0);
    expect(widow.netPremium).toBeCloseTo(21_000, 9);
    expect(widow.cliffHeadroom).toBeCloseTo(-7_400, 9);
  });

  it('IRMAA: 150,000 of lookback MAGI is no surcharge jointly and tier 2 single', () => {
    /*
     * IRMAA reads MAGI from two years prior, so the surcharge from their last
     * JOINT years follows her into her first single ones — on the single tier
     * table, which starts at 109,000 instead of 218,000.
     *
     * MFJ, two enrollees, 12 months each, premium index 1, Part D plan 45/mo:
     *   150,000 <= 218,000, no tier. Part B = 202.90 x 24 = 4,869.60;
     *   Part D plan = 45 x 24 = 1,080. Total 5,949.60, tierIndex 0.
     * SINGLE, one enrollee, 12 months:
     *   137,000 < 150,000 <= 171,000 -> tier 2. Part B base = 202.90 x 12 =
     *   2,434.80; surcharge (405.80 - 202.90) x 12 = 2,434.80 — the base
     *   DOUBLES per person. Part D plan 540 + Part D IRMAA 37.50 x 12 = 450.
     *   Total 5,859.60, tierIndex 2.
     *
     * The household total barely moves (one person instead of two), which is
     * exactly why the per-person figure is the one asserted: her Part B cost
     * is 4,869.60 where his and hers together were 4,869.60.
     */
    const med = (status: FilingStatus, people: number) =>
      computeMedicare(
        inputs(status, {
          medicare: {
            enrolledMonthsPerPerson: new Array(people).fill(12),
            magiTwoYearsPrior: 150_000,
            partDPlanMonthly: 45,
            premiumIndex: 1,
          },
        }),
        medicareData,
      )!;

    const joint = med('mfj', 2);
    expect(joint.tierIndex).toBe(0);
    expect(joint.partB).toBeCloseTo(4_869.6, 6);
    expect(joint.irmaaPartB).toBe(0);
    expect(joint.irmaaPartD).toBe(0);
    expect(joint.total).toBeCloseTo(5_949.6, 6);

    const widow = med('single', 1);
    expect(widow.tierIndex).toBe(2);
    expect(widow.partB).toBeCloseTo(2_434.8, 6);
    expect(widow.irmaaPartB).toBeCloseTo(2_434.8, 6);
    expect(widow.irmaaPartD).toBeCloseTo(450, 6);
    expect(widow.total).toBeCloseTo(5_859.6, 6);
    // Per person, Part B exactly doubles: 2,434.80 -> 4,869.60.
    expect(widow.partB + widow.irmaaPartB).toBeCloseTo(joint.partB, 6);
  });

  it('the top single IRMAA tier is 500,000, not half of the MFJ 750,000', () => {
    /*
     * The same trap as the 37% bracket, one module over. The first four single
     * thresholds ARE half the MFJ ones (218/274/342/410 -> 109/137/171/205),
     * and the top is 500,000 against 750,000. A halving implementation would
     * put it at 375,000 and charge the top tier to every widow with MAGI
     * between 375,000 and 500,000. 400,000 is inside that gap: tier 4, not 5.
     */
    for (let i = 0; i < 4; i++) {
      expect(medicareData.irmaaTiersSingle[i].magiOver).toBe(
        medicareData.irmaaTiersMfj[i].magiOver / 2,
      );
    }
    expect(medicareData.irmaaTiersSingle[4].magiOver).toBe(500_000);
    expect(medicareData.irmaaTiersMfj[4].magiOver).toBe(750_000);
    const res = computeMedicare(
      inputs('single', {
        medicare: {
          enrolledMonthsPerPerson: [12],
          magiTwoYearsPrior: 400_000,
          partDPlanMonthly: 45,
          premiumIndex: 1,
        },
      }),
      medicareData,
    )!;
    expect(res.tierIndex).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// 8. State tax
// ---------------------------------------------------------------------------

describe('single-filer state tax', () => {
  it('VA: the deduction halves and the age-deduction threshold falls by a THIRD', () => {
    /*
     * Virginia taxes "every individual" on one bracket table (§58.1-320), so
     * the state-level widow penalty is a deductions story:
     *   standard deduction 2026: 17,500 MFJ -> 8,750 single (halves)
     *   age-deduction AFAGI threshold: 75,000 -> 50,000 (§58.1-322.03(5.b)
     *     says "$50,000 for single taxpayers or $75,000 for married" — a third
     *     off, NOT half, so she starts losing the deduction 25,000 of income
     *     sooner than a halving rule would predict)
     * Personal exemptions and the 65+ add-ons are per PERSON and need no
     * single-filer data at all — they simply see a one-person household.
     */
    const va = bundle.states.va;
    expect(va.standardDeductionMfjByYear?.['2026']).toBe(17_500);
    expect(va.standardDeductionSingleByYear?.['2026']).toBe(8_750);
    expect(va.vaAgeDeduction?.afagiThresholdMfj).toBe(75_000);
    expect(va.vaAgeDeduction?.afagiThresholdSingle).toBe(50_000);
    expect(va.vaAgeDeduction?.afagiThresholdSingle).not.toBe(75_000 / 2);
  });

  it('SC: the SCIAD trio halves, and the bracket threshold does not move', () => {
    const sc = bundle.states.sc.scDeductions?.sciad;
    expect(sc).toEqual({
      amountMfj: 30_000,
      phaseoutStartMfj: 80_000,
      phaseoutRangeMfj: 110_000,
      amountSingle: 15_000,
      phaseoutStartSingle: 40_000,
      phaseoutRangeSingle: 55_000,
    });
    // The 30,000 bracket threshold is status-independent in SC law, which is
    // why there is no single bracket table here to get wrong.
    expect(bundle.states.sc.brackets?.[0].upTo).toBe(30_000);
  });

  it('NC: the flat rate is shared and only the standard deduction halves', () => {
    expect(bundle.states.nc.standardDeductionMfj).toBe(25_500);
    expect(bundle.states.nc.standardDeductionSingle).toBe(12_750);
    expect(bundle.states.nc.flatRateByYear?.['2026']).toBe(0.0399);
  });
});

// ---------------------------------------------------------------------------
// 9. THE HEADLINE: the widow penalty, end to end
// ---------------------------------------------------------------------------

describe('THE WIDOW PENALTY: the same income, taxed as one person', () => {
  /**
   * The whole reason single-filer support exists. Identical dollars, identical
   * state, identical portfolio — the ONLY difference is that one return counts
   * two people and the other counts one.
   *
   * The household: 120,000 of IRA distributions, 60,000 of Social Security,
   * 5,000 of taxable interest, everyone 70, Virginia, CPI index 1. That is a
   * perfectly ordinary retired year, not a contrived one.
   */
  const income = {
    pretaxDistributions: 120_000,
    socialSecurityGross: 60_000,
    taxableInterest: 5_000,
  };
  const joint = computeYear(
    inputs('mfj', { ...income, agesAtYearEnd: [70, 70] }),
    bundle,
  );
  const widow = computeYear(inputs('single', { ...income, agesAtYearEnd: [70] }), bundle);

  it('federal: 20,334 filed jointly becomes 30,482 filed alone (+49.9%)', () => {
    /*
     * BOTH: other income = 120,000 + 5,000 = 125,000; provisional income =
     * 125,000 + 30,000 = 155,000, which is high enough that the 85% ceiling
     * binds either way — taxable SS = 0.85 x 60,000 = 51,000. AGI = 176,000.
     * (The SS worksheet is NOT where this year's penalty lands; at this income
     * both statuses are already at the ceiling. It lands in the deduction and
     * the brackets, which is the ordinary case.)
     *
     * MFJ: deduction 32,200 + 2 x 1,650 = 35,500 -> taxable 140,500.
     *   Tax = 2,480 + 12% x 76,000 = 11,600 (through 100,800)
     *       + 22% x (140,500 - 100,800) = 22% x 39,700 = 8,734
     *       = 20,334.
     * SINGLE: deduction 16,100 + 2,050 = 18,150 -> taxable 157,850.
     *   Tax = 17,966 (cumulative through 105,700)
     *       + 24% x (157,850 - 105,700) = 24% x 52,150 = 12,516
     *       = 30,482.
     *
     * She is in the 24% bracket on income that put the couple in the 22%, on
     * 17,350 less deduction. NIIT is 0 both ways (MAGI 176,000 is under even
     * the 200,000 single threshold), so this gap is brackets and deduction
     * alone — the plainest possible statement of the penalty.
     */
    expect(joint.federal.agi).toBeCloseTo(176_000, 9);
    expect(widow.federal.agi).toBeCloseTo(176_000, 9);
    expect(joint.federal.ssTaxableAmount).toBeCloseTo(51_000, 9);
    expect(widow.federal.ssTaxableAmount).toBeCloseTo(51_000, 9);

    expect(joint.federal.standardDeduction).toBeCloseTo(35_500, 9);
    expect(widow.federal.standardDeduction).toBeCloseTo(18_150, 9);
    expect(joint.federal.taxableIncome).toBeCloseTo(140_500, 9);
    expect(widow.federal.taxableIncome).toBeCloseTo(157_850, 9);

    expect(joint.federal.total).toBeCloseTo(20_334, 6);
    expect(widow.federal.total).toBeCloseTo(30_482, 6);
    expect(widow.federal.total - joint.federal.total).toBeCloseTo(10_148, 6);
    expect(widow.federal.niit).toBe(0);
    expect(joint.federal.niit).toBe(0);
  });

  it('Virginia: 5,724.80 becomes 6,327.40', () => {
    /*
     * VA starts from federal AGI 176,000 and subtracts the federally taxable
     * Social Security (51,000, state-exempt) -> 125,000 both ways.
     *
     * MFJ: less standard deduction 17,500 -> 107,500; less exemptions
     *   2 x 930 + 2 x 800 = 3,460 -> 104,040. Age deduction: AFAGI =
     *   176,000 - 51,000 = 125,000, which is 50,000 over the 75,000 threshold
     *   against a gross of 2 x 12,000 = 24,000 — fully phased out, 0.
     *   Tax = 2% x 3,000 + 3% x 2,000 + 5% x 12,000 + 5.75% x (104,040 - 17,000)
     *       = 60 + 60 + 600 + 5,004.80 = 5,724.80.
     * SINGLE: less 8,750 -> 116,250; less 930 + 800 = 1,730 -> 114,520.
     *   Age deduction: AFAGI 125,000 is 75,000 over the 50,000 threshold
     *   against a gross of 12,000 — also fully phased out.
     *   Tax = 720 + 5.75% x (114,520 - 17,000) = 720 + 5,607.40 = 6,327.40.
     */
    expect(joint.state.taxableIncome).toBeCloseTo(104_040, 6);
    expect(widow.state.taxableIncome).toBeCloseTo(114_520, 6);
    expect(joint.state.total).toBeCloseTo(5_724.8, 6);
    expect(widow.state.total).toBeCloseTo(6_327.4, 6);
  });

  it('total tax rises 10,750.60 a year — 41.3% more, on unchanged income', () => {
    // 20,334 + 5,724.80 = 26,058.80 jointly.
    // 30,482 + 6,327.40 = 36,809.40 alone. No penalties either way.
    expect(joint.totalTax).toBeCloseTo(26_058.8, 6);
    expect(widow.totalTax).toBeCloseTo(36_809.4, 6);
    expect(widow.totalTax - joint.totalTax).toBeCloseTo(10_750.6, 6);
    expect(widow.totalTax / joint.totalTax).toBeCloseTo(1.41255, 5);
    /*
     * 10,750.60 a year, every year, from a portfolio that did not change and
     * a Social Security benefit that (in this fixture) did not change either —
     * before the benefit itself falls by a third, which is the OTHER half of
     * the survivor's problem and lives in socialSecurity.ts. A model that ran
     * her cash flows through joint brackets would hand back a widow score too
     * high by roughly this much of spending a year, and could tell a household
     * it is safe to drop a policy that is the only thing holding the plan up.
     */
  });

  it('holds at every income, and bites HARDEST in proportion on a modest one', () => {
    /*
     * The gap is not an artifact of one income. Swept across a realistic band
     * of IRA distributions against the same 60,000 of Social Security, all
     * ages 70, Virginia:
     *
     *   distributions   MFJ tax     single tax    ratio   extra $
     *      40,000       3,416.00      7,990.90    2.34x    4,574.90
     *      80,000      13,008.80     23,421.90    1.80x   10,413.10
     *     120,000      24,671.30     35,321.90    1.43x   10,650.60
     *     200,000      46,953.30     61,607.90    1.31x   14,654.60
     *     320,000      82,653.30    109,806.65    1.33x   27,153.35
     *
     * TWO THINGS WORTH KNOWING, and they point in opposite directions. The
     * RATIO is worst at the bottom — 2.34x on a 40,000 draw — because the
     * 17,350 of lost deduction and the far more taxable Social Security are a
     * huge share of a small tax bill, and because a modest joint income sits
     * in the 10-12% brackets while the same money single is already at 22%.
     * The DOLLAR gap does the opposite and grows with income.
     *
     * Which matters depends on the plan. A survivor living on a modest draw
     * feels the ratio: her tax more than doubles on income she cannot easily
     * reduce. A survivor with a large IRA and RMDs she cannot avoid feels the
     * dollars. Both are the reason the widow score has to run the real tax
     * module rather than scale a household number.
     *
     * Pinned to the cent because they are the headline claim of this feature,
     * and derived, not hand-rolled: the arithmetic behind the 120,000 row is
     * spelled out line by line in the three tests above it.
     */
    const table: Array<[number, number, number]> = [
      [40_000, 3_416.0, 7_990.9],
      [80_000, 13_008.8, 23_421.9],
      [120_000, 24_671.3, 35_321.9],
      [200_000, 46_953.3, 61_607.9],
      [320_000, 82_653.3, 109_806.65],
    ];
    let previousRatio = Infinity;
    let previousGap = 0;
    for (const [dist, expectJoint, expectWidow] of table) {
      const j = computeYear(
        inputs('mfj', {
          pretaxDistributions: dist,
          socialSecurityGross: 60_000,
          agesAtYearEnd: [70, 70],
        }),
        bundle,
      );
      const w = computeYear(
        inputs('single', {
          pretaxDistributions: dist,
          socialSecurityGross: 60_000,
          agesAtYearEnd: [70],
        }),
        bundle,
      );
      expect(j.totalTax).toBeCloseTo(expectJoint, 2);
      expect(w.totalTax).toBeCloseTo(expectWidow, 2);
      // NEVER cheaper to file alone. If this ever flips, a resolver is reading
      // the wrong table and the widow score is flattering the survivor.
      expect(w.totalTax).toBeGreaterThan(j.totalTax);
      const ratio = w.totalTax / j.totalTax;
      const gap = w.totalTax - j.totalTax;
      // Ratio falls as income rises; the dollar gap climbs. (The last row's
      // ratio ticks up as the 32% single bracket opens at 256,225 against the
      // joint 512,450, which is why the ratio check is bounded to the first
      // four rows and the gap check runs the whole table.)
      if (dist <= 200_000) expect(ratio).toBeLessThan(previousRatio);
      expect(gap).toBeGreaterThan(previousGap);
      previousRatio = ratio;
      previousGap = gap;
    }
  });
});

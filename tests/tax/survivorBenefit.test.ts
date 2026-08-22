/**
 * SURVIVOR (widow/widower) Social Security benefit math — src/tax/socialSecurity.ts.
 *
 * Kept apart from socialSecurity.test.ts, which owns the worker and spousal
 * factors, for the same reason the source has separate functions: a survivor
 * benefit is not a larger spousal benefit and shares almost nothing with
 * either. It is 100% of the deceased's PIA rather than 50%, it can start at 60
 * rather than 62, it uses a DIFFERENT full-retirement-age table, its reduction
 * has no 36-month kink, and it earns no delayed credits for the survivor's own delay.
 *
 * Reusing workerFactor or spousalFactor for a widow is wrong at every claim
 * age, and each of the four ways is asserted below with the wrong answer
 * spelled out beside the right one — because "it looked about right" is
 * exactly how a survivor's income gets modelled 20% too high, and a widow
 * score computed on a benefit 20% too high is worse than no widow score.
 *
 * The shipped data file is used throughout, so these tests pin its values too:
 *   survivorMinClaimAge 60, survivorMaxReduction 0.285, survivor FRA 67 for
 *   anyone born 1962 or later, RIB-LIM floor 82.5% of PIA, lump sum $255.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Person, SocialSecurityData } from '../../src/shared/types';
import {
  claimAgeMonths,
  fraMonths,
  monthlyBenefitAtClaim,
  spousalFactor,
  survivorFactor,
  survivorFraMonths,
  survivorMonthlyBenefit,
  workerFactor,
} from '../../src/tax/socialSecurity';

const data: SocialSecurityData = JSON.parse(
  readFileSync(
    new URL('../../data-defaults/assumptions/social-security.json', import.meta.url),
    'utf8',
  ),
) as SocialSecurityData;

/** Survivor FRA in months for anyone born 1962 or later: 67y x 12. */
const SURVIVOR_FRA = 804;
/** Ages in months, for readability. */
const AGE_60 = 720;
const AGE_62 = 744;
const AGE_63 = 756;
const AGE_65 = 780;
const AGE_66 = 792;
const AGE_67 = 804;
const AGE_70 = 840;

function person(birthYear: number, birthMonth = 6): Person {
  return {
    id: 'p',
    name: 'Test Person',
    birthYear,
    birthMonth,
    piaMonthlyAtFraIfWorkingTo62: 2000,
    piaMonthlyAtFraIfStoppingNow: 2000,
    hasOwnBenefit: true,
  };
}

// ---------------------------------------------------------------------------
// The shipped data
// ---------------------------------------------------------------------------

describe('shipped survivor parameters', () => {
  it('are the statutory ones, and are their own fields', () => {
    expect(data.survivorMinClaimAge).toBe(60); // 20 CFR 404.409(c), not 62
    expect(data.survivorMaxReduction).toBe(0.285); // 20 CFR 404.410(c)(1)
    expect(data.survivorRibLimFloorPctOfPia).toBe(0.825); // POMS RS 00615.320
    expect(data.survivorFraDefaultYears).toBe(67);
    expect(data.lumpSumDeathPayment).toBe(255); // SSA §202(i), frozen since 1981
  });

  it('the per-month reduction for survivor FRA 67 is 19/56 of 1% exactly', () => {
    // 20 CFR 404.410(c)(1) spreads the 28.5% maximum EVENLY across the window
    // from 60 to survivor FRA. For FRA 67 that window is 84 months, so the
    // published per-month fraction is 0.285 / 84 = 0.0033928571..., i.e.
    // 19/56 of 1%. There is no 36-month kink to get wrong.
    const window = SURVIVOR_FRA - data.survivorMinClaimAge * 12;
    expect(window).toBe(84);
    expect(data.survivorMaxReduction / window).toBeCloseTo(19 / 56 / 100, 15);
  });
});

// ---------------------------------------------------------------------------
// survivorFraMonths — its own table
// ---------------------------------------------------------------------------

describe('survivorFraMonths', () => {
  it('born 1971 -> 804 months, same as the retirement table for this household', () => {
    expect(survivorFraMonths(person(1971), data)).toBe(804);
    expect(fraMonths(person(1971), data)).toBe(804);
  });

  it('reads the SURVIVOR table, not the retirement one — they really are separate', () => {
    /*
     * 20 CFR 404.409 carries two tables. The retirement one reaches 67 for
     * anyone born 1/2/1960 or later; the widow's reaches 67 only for 1/2/1962
     * or later, and the intermediate steps differ (FRA 66 covers 1943-1955 for
     * retirement but 1945-1957 for survivors). For a 1971 birth year both say
     * 67, so THIS household pays nothing for the distinction — which is
     * exactly the situation in which a shared table would go unnoticed until a
     * profile with an older spouse silently got the wrong reduction window.
     *
     * Forced apart here with a synthetic data file: same person, two tables,
     * two answers.
     */
    const split: SocialSecurityData = {
      ...data,
      fraYearsByBirthYear: { '1943': 66, '1960': 67 },
      survivorFraYearsByBirthYear: { '1945': 66, '1962': 67 },
    };
    const born1961 = person(1961);
    expect(fraMonths(born1961, split)).toBe(804); // retirement: 1960 key -> 67y
    expect(survivorFraMonths(born1961, split)).toBe(792); // survivor: 1945 key -> 66y
  });
});

// ---------------------------------------------------------------------------
// survivorFactor — the four ways reuse goes wrong
// ---------------------------------------------------------------------------

describe('survivorFactor', () => {
  it('0.715 at 60 — and the worker/spousal factors cannot even express a claim at 60', () => {
    /*
     * Reduction = 0.285 x (months early) / (window from 60 to survivor FRA)
     *           = 0.285 x 84 / 84 = 0.285, so the factor is 1 - 0.285 = 0.715.
     *
     * THE TRAP: workerFactor and spousalFactor clamp claim age to
     * [minClaimAge, maxClaimAge] = [62, 70], so feeding a survivor claim at 60
     * into either silently REPRICES IT AS A CLAIM AT 62 — 0.796 where 0.715 is
     * right (worker would say 0.70, which is wrong in the other direction).
     * Both wrong answers are asserted here so the clamp cannot quietly change.
     */
    expect(survivorFactor(AGE_60, SURVIVOR_FRA, data)).toBeCloseTo(0.715, 12);
    expect(workerFactor(AGE_60, SURVIVOR_FRA, data)).toBeCloseTo(0.7, 12); // clamped to 62
    expect(spousalFactor(AGE_60, SURVIVOR_FRA, data)).toBeCloseTo(0.325, 12); // clamped to 62
  });

  it('checkpoints between 60 and FRA, hand-computed', () => {
    // reduction = 0.285 x monthsEarly / 84
    //   62 (744): monthsEarly 60 -> 0.2035714286 -> 0.7964285714
    //   63 (756): monthsEarly 48 -> 0.1628571429 -> 0.8371428571
    //   65 (780): monthsEarly 24 -> 0.0814285714 -> 0.9185714286
    //   66 (792): monthsEarly 12 -> 0.0407142857 -> 0.9592857143
    expect(survivorFactor(AGE_62, SURVIVOR_FRA, data)).toBeCloseTo(0.7964285714, 9);
    expect(survivorFactor(AGE_63, SURVIVOR_FRA, data)).toBeCloseTo(0.8371428571, 9);
    expect(survivorFactor(AGE_65, SURVIVOR_FRA, data)).toBeCloseTo(0.9185714286, 9);
    expect(survivorFactor(AGE_66, SURVIVOR_FRA, data)).toBeCloseTo(0.9592857143, 9);
    expect(survivorFactor(AGE_67, SURVIVOR_FRA, data)).toBe(1);
  });

  it('is FLAT past FRA — no delayed credits for HER delay (worker would add 24%)', () => {
    /*
     * Delayed retirement credits belong to the number holder's own old-age
     * benefit (20 CFR 404.313(a)). A widow's benefit picks up HIS credits
     * (404.338(b)) and nothing else, so delaying a survivor benefit past
     * survivor FRA is pure loss. Reusing workerFactor here would add 2/3 of 1%
     * a month to 70 and overstate a delayed widow's benefit by 24% — the
     * single largest of the four errors, and the easiest to miss because the
     * number it produces looks perfectly reasonable.
     */
    expect(survivorFactor(AGE_67, SURVIVOR_FRA, data)).toBe(1);
    expect(survivorFactor(AGE_70, SURVIVOR_FRA, data)).toBe(1);
    expect(survivorFactor(1200, SURVIVOR_FRA, data)).toBe(1); // age 100, still 1
    expect(workerFactor(AGE_70, SURVIVOR_FRA, data)).toBeCloseTo(1.24, 12); // the wrong answer
  });

  it('the reduction is LINEAR in months early — the worker reduction is not', () => {
    /*
     * The 36-month kink is the structural difference. The survivor reduction
     * is one straight line from 0.715 at 60 to 1.000 at FRA, so the factor at
     * the midpoint age is the midpoint of the factors:
     *   midpoint age = (720 + 804) / 2 = 762 -> monthsEarly 42
     *   factor = 1 - 0.285 x 42 / 84 = 0.8575 = (0.715 + 1.000) / 2   exactly.
     *
     * The worker factor fails the same test, because 5/9 of 1% for the first
     * 36 months early gives way to 5/12 of 1% beyond:
     *   at 62 (744) = 0.700, at 66 (792) = 0.9333333
     *   midpoint age 768 -> worker 0.800, but (0.700 + 0.9333333)/2 = 0.8166667.
     */
    const mid = (AGE_60 + SURVIVOR_FRA) / 2;
    expect(survivorFactor(mid, SURVIVOR_FRA, data)).toBeCloseTo(0.8575, 12);
    expect(survivorFactor(mid, SURVIVOR_FRA, data)).toBeCloseTo(
      (survivorFactor(AGE_60, SURVIVOR_FRA, data) + survivorFactor(AGE_67, SURVIVOR_FRA, data)) / 2,
      12,
    );
    const workerMid = (AGE_62 + AGE_66) / 2;
    expect(workerFactor(workerMid, SURVIVOR_FRA, data)).toBeCloseTo(0.8, 12);
    expect(
      (workerFactor(AGE_62, SURVIVOR_FRA, data) + workerFactor(AGE_66, SURVIVOR_FRA, data)) / 2,
    ).toBeCloseTo(0.8166666667, 9);
  });

  it('is 100% of PIA, not 50% — the household loses a THIRD of its benefit', () => {
    /*
     * The headline arithmetic of the whole feature. A household drawing the
     * worker's benefit plus a 50% spousal top-up collects 1.5 x PIA. After the
     * worker's death the survivor is paid the larger of their own benefit and
     * 1.0 x PIA — and with no record of their own, that is 1.0 x PIA. It loses
     * exactly a third of its Social Security, permanently, in the same year it
     * starts filing single.
     */
    const pia = 3_180.47;
    const household = pia + monthlyBenefitAtClaim('spousal', pia, AGE_67, 804, data);
    const survivor = monthlyBenefitAtClaim('survivor', pia, AGE_67, SURVIVOR_FRA, data);
    expect(household).toBeCloseTo(1.5 * pia, 9);
    expect(survivor).toBeCloseTo(pia, 9);
    expect(survivor / household).toBeCloseTo(2 / 3, 12);
    // In representative units: 1.5 x 3,180.47 x 12 = 57,248.46/yr becomes
    // 3,180.47 x 12 = 38,165.64/yr — a permanent cut of 19,082.82 a year.
    expect(household * 12 - survivor * 12).toBeCloseTo(19_082.82, 2);
  });

  it('a claim at 60 in the profile’s own units: 27,288.43 a year', () => {
    // 3,180.47 x 0.715 x 12 = 27,288.4326, i.e. $27,288.43. This is the figure
    // the survivor work's acceptance scenario reproduces, pinned here at the
    // level it is actually computed — full float precision, no SSA rounding
    // (see the module header in src/tax/socialSecurity.ts).
    expect(3_180.47 * survivorFactor(AGE_60, SURVIVOR_FRA, data) * 12).toBeCloseTo(
      27_288.4326,
      4,
    );
  });
});

// ---------------------------------------------------------------------------
// survivorMonthlyBenefit — RIB-LIM and the credits the worker lived to earn
// ---------------------------------------------------------------------------

describe('survivorMonthlyBenefit', () => {
  const PIA = 4_000;

  it('the worker never claimed: the survivor benefit is the full PIA, reduced only for the SURVIVOR’s early claim', () => {
    // 20 CFR 404.338(c) conditions RIB-LIM on the insured having CHOSEN to
    // take old-age benefits before FRA. A man who died before claiming made no
    // such choice, so nothing caps it.
    expect(survivorMonthlyBenefit(PIA, null, AGE_67, SURVIVOR_FRA, data)).toBeCloseTo(4_000, 9);
    expect(survivorMonthlyBenefit(PIA, null, AGE_60, SURVIVOR_FRA, data)).toBeCloseTo(2_860, 9);
    // 4,000 x 0.715 = 2,860.
  });

  it('the worker delayed and lived to earn credits: they follow the survivor', () => {
    // The worker died at 68 having never claimed: 12 months of delayed credits
    // were due and not received, so the notional benefit is
    // 4,000 x (1 + 12 x 2/3 of 1%) = 4,000 x 1.08 = 4,320, and the survivor
    // benefit at survivor FRA is that full figure. (Whether those 12 months
    // were really EARNED — months after the death are not — is the caller's
    // accounting,
    // done in engine/household.ts where the death date is known.)
    expect(survivorMonthlyBenefit(PIA, 4_320, AGE_67, SURVIVOR_FRA, data)).toBeCloseTo(4_320, 9);
    // And the survivor's own early claim still reduces it: 4,320 x 0.715 = 3,088.80.
    expect(survivorMonthlyBenefit(PIA, 4_320, AGE_60, SURVIVOR_FRA, data)).toBeCloseTo(3_088.8, 9);
  });

  it('RIB-LIM is a FLOOR when the worker claimed steeply early: 3,300, not 2,800', () => {
    /*
     * The worker claimed at 62 and was drawing 4,000 x 0.70 = 2,800. RIB-LIM
     * (POMS RS 00615.320) pays the survivor the LARGER of 82.5% of the
     * worker's PIA and the reduced amount actually being received:
     * max(0.825 x 4,000 = 3,300, 2,800) = 3,300. The survivor of someone who
     * claimed at 62 is NOT dropped to that reduced cheque — treating the rule
     * as a pure cap would understate the survivor by 500 a month for life.
     */
    const workerActual = PIA * workerFactor(AGE_62, 804, data);
    expect(workerActual).toBeCloseTo(2_800, 9);
    expect(survivorMonthlyBenefit(PIA, workerActual, AGE_67, SURVIVOR_FRA, data)).toBeCloseTo(
      3_300,
      9,
    );
  });

  it('RIB-LIM is a CAP when the reduction was mild: the worker’s own 3,733.33', () => {
    // Claimed at 66: factor 1 - 12 x 5/9 of 1% = 0.9333333, so the worker drew
    // 3,733.33. That is above the 3,300 floor, so the floor is inert and the
    // survivor gets that actual benefit — the "cap" half of the same rule.
    const workerActual = PIA * workerFactor(AGE_66, 804, data);
    expect(workerActual).toBeCloseTo(3_733.3333333, 6);
    expect(survivorMonthlyBenefit(PIA, workerActual, AGE_67, SURVIVOR_FRA, data)).toBeCloseTo(
      3_733.3333333,
      6,
    );
  });

  it('RIB-LIM does not apply at all when the worker claimed AT FRA', () => {
    // Drawing exactly the PIA is neither above nor below it, so no branch
    // fires and the base is that PIA.
    expect(survivorMonthlyBenefit(PIA, PIA, AGE_67, SURVIVOR_FRA, data)).toBeCloseTo(4_000, 9);
  });

  it('no PIA, no survivor benefit — and no NaN', () => {
    expect(survivorMonthlyBenefit(0, null, AGE_67, SURVIVOR_FRA, data)).toBe(0);
    expect(survivorMonthlyBenefit(0, 1_000, AGE_60, SURVIVOR_FRA, data)).toBe(0);
  });

  it('claim-age plumbing: born 1971-06 claiming 2031-06 is exactly age 60', () => {
    const survivor = person(1971, 6);
    const ageM = claimAgeMonths(survivor, 2031, 6);
    expect(ageM).toBe(720);
    expect(survivorMonthlyBenefit(PIA, null, ageM, survivorFraMonths(survivor, data), data)).toBeCloseTo(
      2_860,
      9,
    );
    // A claim before 60 cannot buy a bigger reduction — there is no
    // entitlement at all below 60, so the factor clamps at 0.715 rather than
    // running off the bottom of the schedule.
    expect(survivorFactor(claimAgeMonths(survivor, 2029, 6), SURVIVOR_FRA, data)).toBeCloseTo(0.715, 12);
  });
});

/**
 * Tests for Social Security claiming-factor math (src/tax/socialSecurity.ts).
 *
 * Canonical checkpoints for FRA 67 are hand-computed in comments below.
 * The SocialSecurityData used is the real shipped default
 * (data-defaults/assumptions/social-security.json), so these tests also pin
 * the data file's values.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Person, SocialSecurityData } from '../../src/shared/types';
import {
  claimAgeMonths,
  fraMonths,
  monthlyBenefitAtClaim,
  spousalFactor,
  workerFactor,
} from '../../src/tax/socialSecurity';

const data: SocialSecurityData = JSON.parse(
  readFileSync(new URL('../../data-defaults/assumptions/social-security.json', import.meta.url), 'utf8'),
) as SocialSecurityData;

const FRA = 804; // 67y * 12

function person(birthYear: number, birthMonth: number): Person {
  return {
    id: 'p1',
    name: 'Test Person',
    birthYear,
    birthMonth,
    // Both PIA figures are 2,000 here: src/tax/socialSecurity.ts takes a raw
    // PIA number, so which figure the engine picks (working-to-62 vs
    // stopping-now) is deliberately out of scope for these factor tests.
    piaMonthlyAtFraIfWorkingTo62: 2000,
    piaMonthlyAtFraIfStoppingNow: 2000,
    hasOwnBenefit: true,
  };
}

describe('data defaults sanity', () => {
  it('shipped per-month rates match the statutory fractions', () => {
    expect(data.workerReductionFirst36PerMonth).toBeCloseTo(5 / 9 / 100, 15); // 5/9 of 1%
    expect(data.workerReductionBeyond36PerMonth).toBeCloseTo(5 / 12 / 100, 15); // 5/12 of 1%
    expect(data.delayedCreditPerMonth).toBeCloseTo(2 / 3 / 100, 15); // 2/3 of 1%
    expect(data.spousalReductionFirst36PerMonth).toBeCloseTo(25 / 36 / 100, 15); // 25/36 of 1%
    expect(data.spousalReductionBeyond36PerMonth).toBeCloseTo(5 / 12 / 100, 15); // 5/12 of 1%
    expect(data.spousalMaxPctOfPia).toBe(0.5);
  });
});

describe('fraMonths', () => {
  it('born 1971 (>= 1960 threshold) -> FRA 67y = 804 months', () => {
    expect(fraMonths(person(1971, 6), data)).toBe(804);
  });

  it('threshold lookup: largest birth-year key <= birthYear wins; fallback to default', () => {
    const d: SocialSecurityData = { ...data, fraYearsByBirthYear: { '1960': 67 }, fraDefaultYears: 66 };
    expect(fraMonths(person(1971, 6), d)).toBe(804); // 1960 threshold applies -> 67y
    expect(fraMonths(person(1960, 1), d)).toBe(804); // boundary: 1960 itself -> 67y
    expect(fraMonths(person(1955, 1), d)).toBe(792); // below every threshold -> default 66y = 792
  });

  it('tolerates a "1960+" spelled key (types.ts comment style)', () => {
    const d: SocialSecurityData = { ...data, fraYearsByBirthYear: { '1960+': 67 }, fraDefaultYears: 66 };
    expect(fraMonths(person(1971, 6), d)).toBe(804);
  });
});

describe('claimAgeMonths', () => {
  it('born 1971-06, claiming 2033-06 -> (2033-1971)*12 + (6-6) = 744 (62y0m)', () => {
    expect(claimAgeMonths(person(1971, 6), 2033, 6)).toBe(744);
  });

  it('born 1971-06, claiming 2036-01 -> (2036-1971)*12 + (1-6) = 780 - 5 = 775 (64y7m)', () => {
    expect(claimAgeMonths(person(1971, 6), 2036, 1)).toBe(775);
  });

  it('born 1971-06, claiming 2041-06 -> 70*12 = 840', () => {
    expect(claimAgeMonths(person(1971, 6), 2041, 6)).toBe(840);
  });
});

describe('workerFactor (FRA 67)', () => {
  // Early reduction = min(monthsEarly,36) * 5/9% + max(monthsEarly-36,0) * 5/12%
  it('62y0m (744, 60 months early): 36*(5/9)/100 + 24*(5/12)/100 = 0.20 + 0.10 = 0.30 -> 0.70', () => {
    expect(workerFactor(744, FRA, data)).toBeCloseTo(0.7, 12);
  });

  it('63y0m (756, 48 early): 36*(5/9)/100 + 12*(5/12)/100 = 0.20 + 0.05 = 0.25 -> 0.75', () => {
    expect(workerFactor(756, FRA, data)).toBeCloseTo(0.75, 12);
  });

  it('64y0m (768, 36 early): 36*(5/9)/100 = 0.20 -> 0.80', () => {
    expect(workerFactor(768, FRA, data)).toBeCloseTo(0.8, 12);
  });

  it('65y0m (780, 24 early): 24*(5/9)/100 = 2/15 -> 1 - 2/15 = 0.866666...', () => {
    expect(workerFactor(780, FRA, data)).toBeCloseTo(1 - (24 * (5 / 9)) / 100, 12);
    expect(workerFactor(780, FRA, data)).toBeCloseTo(0.8667, 4);
  });

  it('66y0m (792, 12 early): 12*(5/9)/100 = 1/15 -> 0.933333...', () => {
    expect(workerFactor(792, FRA, data)).toBeCloseTo(1 - (12 * (5 / 9)) / 100, 12);
    expect(workerFactor(792, FRA, data)).toBeCloseTo(0.9333, 4);
  });

  it('66y11m (803, 1 early): 1 - 1*(5/9)/100 = 0.994444...', () => {
    expect(workerFactor(803, FRA, data)).toBeCloseTo(1 - (5 / 9) / 100, 12);
  });

  it('67y0m (804): exactly FRA -> 1.0', () => {
    expect(workerFactor(804, FRA, data)).toBeCloseTo(1.0, 12);
  });

  // Delayed credits: +2/3% per month past FRA (8%/yr), stop at 70.
  it('68y0m (816, 12 late): 12*(2/3)/100 = 0.08 -> 1.08', () => {
    expect(workerFactor(816, FRA, data)).toBeCloseTo(1.08, 12);
  });

  it('69y0m (828, 24 late): 24*(2/3)/100 = 0.16 -> 1.16', () => {
    expect(workerFactor(828, FRA, data)).toBeCloseTo(1.16, 12);
  });

  it('70y0m (840, 36 late): 36*(2/3)/100 = 0.24 -> 1.24', () => {
    expect(workerFactor(840, FRA, data)).toBeCloseTo(1.24, 12);
  });

  it('70y6m (846): clamped to 70 -> still 1.24 (credits stop at 70)', () => {
    expect(workerFactor(846, FRA, data)).toBeCloseTo(1.24, 12);
    expect(workerFactor(846, FRA, data)).toBe(workerFactor(840, FRA, data));
  });

  it('below 62 (e.g. 61y0m = 732): clamped to 62 -> 0.70', () => {
    expect(workerFactor(732, FRA, data)).toBeCloseTo(0.7, 12);
    expect(workerFactor(732, FRA, data)).toBe(workerFactor(744, FRA, data));
  });
});

describe('spousalFactor (FRA 67) — fraction of the WORKER\'s PIA', () => {
  // Early: 0.5 * (1 - min(monthsEarly,36)*(25/36)/100 - max(monthsEarly-36,0)*(5/12)/100)
  it('62y0m (744, 60 early): 36*(25/36)/100 + 24*(5/12)/100 = 0.25 + 0.10 = 0.35 -> 0.5*0.65 = 0.325', () => {
    expect(spousalFactor(744, FRA, data)).toBeCloseTo(0.325, 12);
  });

  it('63y0m (756, 48 early): 36*(25/36)/100 + 12*(5/12)/100 = 0.25 + 0.05 = 0.30 -> 0.5*0.70 = 0.35', () => {
    expect(spousalFactor(756, FRA, data)).toBeCloseTo(0.35, 12);
  });

  it('64y0m (768, 36 early): 36*(25/36)/100 = 0.25 -> 0.5*0.75 = 0.375', () => {
    expect(spousalFactor(768, FRA, data)).toBeCloseTo(0.375, 12);
  });

  it('67y0m (804, at FRA): 0.5', () => {
    expect(spousalFactor(804, FRA, data)).toBe(0.5);
  });

  it('70y0m (840, past FRA): still 0.5 — NO delayed credits on spousal', () => {
    expect(spousalFactor(840, FRA, data)).toBe(0.5);
  });

  it('below 62 (732): clamped to 62 -> 0.325', () => {
    expect(spousalFactor(732, FRA, data)).toBeCloseTo(0.325, 12);
  });
});

describe('monthlyBenefitAtClaim', () => {
  it('worker: PIA 2000 at 62 (factor 0.70) -> 2000 * 0.70 = 1400', () => {
    expect(monthlyBenefitAtClaim('worker', 2000, 744, FRA, data)).toBeCloseTo(1400, 9);
  });

  it('worker: PIA 2000 at 66y11m -> 2000 * (1 - (5/9)/100) = 2000 - 100/9 = 1988.888...', () => {
    // 2000 * (1 - 1*(5/9)/100) = 2000 * 0.99444... = 1988.8888...
    expect(monthlyBenefitAtClaim('worker', 2000, 803, FRA, data)).toBeCloseTo(2000 * (1 - (5 / 9) / 100), 9);
  });

  it('worker: PIA 2000 at 70 (factor 1.24) -> 2480', () => {
    expect(monthlyBenefitAtClaim('worker', 2000, 840, FRA, data)).toBeCloseTo(2480, 9);
  });

  it('spousal: WORKER PIA 2000 at spouse age 62 (factor 0.325) -> 650', () => {
    expect(monthlyBenefitAtClaim('spousal', 2000, 744, FRA, data)).toBeCloseTo(650, 9);
  });

  it('spousal: WORKER PIA 2000 at spouse FRA (factor 0.5) -> 1000', () => {
    expect(monthlyBenefitAtClaim('spousal', 2000, 804, FRA, data)).toBeCloseTo(1000, 9);
  });

  it('no rounding: fractional results are preserved (PIA 1234.56 at 62 -> 864.192)', () => {
    // 1234.56 * 0.70 = 864.192 exactly in decimal; SSA would round, we must not.
    expect(monthlyBenefitAtClaim('worker', 1234.56, 744, FRA, data)).toBeCloseTo(864.192, 9);
  });
});

describe('end-to-end: household claim sweep plumbing (born 1971-06)', () => {
  it('claim 2033-06 -> 744 months -> worker 0.70 of PIA', () => {
    const p = person(1971, 6);
    const fra = fraMonths(p, data); // 804
    const ageM = claimAgeMonths(p, 2033, 6); // 744
    expect(fra).toBe(804);
    expect(ageM).toBe(744);
    expect(monthlyBenefitAtClaim('worker', p.piaMonthlyAtFraIfWorkingTo62, ageM, fra, data)).toBeCloseTo(
      2000 * 0.7,
      9,
    );
  });

  it('claim 2038-06 (age 67) -> full PIA; spousal on same date -> half the worker PIA', () => {
    const p = person(1971, 6);
    const fra = fraMonths(p, data);
    const ageM = claimAgeMonths(p, 2038, 6); // (2038-1971)*12 = 804
    expect(ageM).toBe(804);
    expect(monthlyBenefitAtClaim('worker', 2000, ageM, fra, data)).toBeCloseTo(2000, 9);
    expect(monthlyBenefitAtClaim('spousal', 2000, ageM, fra, data)).toBeCloseTo(1000, 9);
  });
});

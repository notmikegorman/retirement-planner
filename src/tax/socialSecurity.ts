/**
 * Social Security BENEFIT math: claiming-age adjustment factors (SPEC §7,
 * "Social Security benefit math"). This module computes what a person's
 * monthly check is at a given claiming age — worker, spousal and SURVIVOR
 * factors. Benefit TAXATION (provisional income, the 50%/85% tiers) lives
 * elsewhere in the tax module.
 *
 * The survivor half exists for the widow score. It shares almost nothing with
 * the other two — a different percentage of PIA, a different minimum claim
 * age, a different full-retirement-age table and a different reduction formula
 * — so it has its own functions rather than a flag on the existing ones. See
 * survivorFactor for the four ways reusing workerFactor or spousalFactor for a
 * widow produces a wrong number.
 *
 * All functions are pure and deterministic. Note on rounding: the SSA rounds
 * intermediate monthly amounts down to the dime and the final payable amount
 * down to the dollar. We deliberately skip that — full float precision is kept
 * throughout, per the project-wide "no rounding inside calculations" rule.
 * The error vs. the SSA's figure is under $1/month.
 */

import type { Person, SocialSecurityData } from '../shared/types';

const MONTHS_PER_YEAR = 12;

/** Shared lookup for both FRA tables: largest birth-year threshold <= birthYear wins. */
function fraYearsFor(
  table: Record<string, number>,
  fallback: number,
  birthYear: number,
): number {
  let fraYears = fallback;
  let bestThreshold = -Infinity;
  for (const [key, years] of Object.entries(table)) {
    const threshold = Number.parseInt(key, 10); // "1960" and "1960+" both -> 1960
    if (Number.isNaN(threshold)) continue;
    if (threshold <= birthYear && threshold > bestThreshold) {
      bestThreshold = threshold;
      fraYears = years;
    }
  }
  // Round to guard against float error if FRA is expressed as e.g. 66.5 years.
  return Math.round(fraYears * MONTHS_PER_YEAR);
}

/**
 * Full Retirement Age for a person, in months of age (e.g. 67y -> 804).
 *
 * `fraYearsByBirthYear` keys are birth-year thresholds ("1960" means "born
 * 1960 or later" — see the data file's notes; a literal "1960+" spelling is
 * also tolerated). Lookup: the entry with the largest threshold <= birthYear
 * wins; when no threshold applies, `fraDefaultYears` is used.
 *
 * THIS IS THE RETIREMENT TABLE. Survivor benefits use a different one — see
 * survivorFraMonths — and the two must never be substituted for each other.
 */
export function fraMonths(person: Person, data: SocialSecurityData): number {
  return fraYearsFor(data.fraYearsByBirthYear, data.fraDefaultYears, person.birthYear);
}

/**
 * SURVIVOR Full Retirement Age, in months of age.
 *
 * 20 CFR 404.409 carries TWO tables. The old-age/spousal one (404.409(a))
 * reaches 67 for anyone born 1/2/1960 or later; the widow's/widower's one
 * (404.409(b)) reaches 67 only for 1/2/1962 or later, and the intermediate
 * steps differ too — FRA 66 covers 1943-1955 for retirement but 1945-1957 for
 * survivors. From birth year 1962 on both tables say 67, so a profile born after
 * that pays nothing for the distinction; it exists so that a profile containing
 * an older person does not silently get the wrong reduction window.
 */
export function survivorFraMonths(person: Person, data: SocialSecurityData): number {
  return fraYearsFor(
    data.survivorFraYearsByBirthYear,
    data.survivorFraDefaultYears,
    person.birthYear,
  );
}

/**
 * Age in whole months at the claim date. Both dates are month-granular
 * (YYYY-MM), so this is exact month arithmetic:
 * born 1975-03, claiming 2037-03 -> (2037-1975)*12 + (3-3) = 744 (62y0m).
 */
export function claimAgeMonths(person: Person, claimYear: number, claimMonth: number): number {
  return (claimYear - person.birthYear) * MONTHS_PER_YEAR + (claimMonth - person.birthMonth);
}

/**
 * Worker-benefit factor as a multiple of PIA.
 *
 * Early (claimAgeM < fraM): reduction = 5/9 of 1% per month for the first 36
 * months early plus 5/12 of 1% per month beyond 36; factor = 1 - reduction.
 * Late: +2/3 of 1% delayed retirement credit per month past FRA (8%/yr),
 * credits stop at age 70. Claim age is clamped to [62y, 70y].
 */
export function workerFactor(claimAgeM: number, fraM: number, data: SocialSecurityData): number {
  const minM = data.minClaimAge * MONTHS_PER_YEAR;
  const maxM = data.maxClaimAge * MONTHS_PER_YEAR;
  const ageM = Math.min(Math.max(claimAgeM, minM), maxM);

  if (ageM < fraM) {
    const monthsEarly = fraM - ageM;
    const reduction =
      Math.min(monthsEarly, 36) * data.workerReductionFirst36PerMonth +
      Math.max(monthsEarly - 36, 0) * data.workerReductionBeyond36PerMonth;
    return 1 - reduction;
  }
  return 1 + (ageM - fraM) * data.delayedCreditPerMonth;
}

/**
 * Spousal-benefit factor as a fraction of the WORKER's PIA.
 *
 * At the spouse's FRA or later: spousalMaxPctOfPia (0.5) — there are NO
 * delayed retirement credits on spousal benefits, so the factor is flat past
 * FRA. Early: the 50% is scaled by (1 - 25/36 of 1% per month for the first
 * 36 months early - 5/12 of 1% per month beyond), reaching
 * 0.5 * (1 - 0.35) = 0.325 at 62. Claim age is clamped to [62y, 70y].
 *
 * Gating rules (cannot start before the worker files; deemed filing) are the
 * engine's responsibility, not this function's.
 */
export function spousalFactor(claimAgeM: number, fraM: number, data: SocialSecurityData): number {
  const minM = data.minClaimAge * MONTHS_PER_YEAR;
  const maxM = data.maxClaimAge * MONTHS_PER_YEAR;
  const ageM = Math.min(Math.max(claimAgeM, minM), maxM);

  if (ageM >= fraM) {
    return data.spousalMaxPctOfPia;
  }
  const monthsEarly = fraM - ageM;
  const reduction =
    Math.min(monthsEarly, 36) * data.spousalReductionFirst36PerMonth +
    Math.max(monthsEarly - 36, 0) * data.spousalReductionBeyond36PerMonth;
  return data.spousalMaxPctOfPia * (1 - reduction);
}

/**
 * SURVIVOR (widow/widower) benefit factor as a multiple of the DECEASED's PIA.
 *
 * A survivor benefit is not a larger spousal benefit; nearly every parameter
 * differs, and reusing the worker or spousal factor gets the answer wrong at
 * every single claim age:
 *
 * - IT IS 100% OF PIA, not 50%. So a household collecting the worker's benefit plus a
 *   50% spousal top-up goes from 1.5x PIA to 1.0x PIA — it loses exactly a
 *   third of its Social Security, permanently.
 * - IT CAN START AT 60, not 62 (20 CFR 404.409(c)). The worker and spousal
 *   factors in this file clamp claim age to [minClaimAge, maxClaimAge] =
 *   [62, 70], so feeding a survivor claim at 60 into either of them silently
 *   reprices it as a claim at 62 — 79.6% where 71.5% is right.
 * - THE REDUCTION HAS NO 36-MONTH KINK. 20 CFR 404.410(c)(1): months of
 *   entitlement before FRA x 0.285 / (months from 60 to survivor FRA). The
 *   maximum is 28.5% at 60 however long the window is, spread evenly — which
 *   is why each survivor FRA has its own per-month fraction (19/56 of 1% for
 *   FRA 67, i.e. 0.285/84 exactly).
 * - THERE ARE NO DELAYED CREDITS FOR THE SURVIVOR'S OWN DELAY. Credits belong to the
 *   number holder's old-age benefit (20 CFR 404.313(a)); a widow's benefit
 *   picks up the DECEASED'S credits (404.338(b)) and nothing else. Delaying a survivor
 *   benefit past survivor FRA is pure loss, so the factor is FLAT at 1 after
 *   FRA. Reusing workerFactor here would add 2/3 of 1% a month to 70 and
 *   overstate a delayed widow's benefit by 24%.
 *
 * `claimAgeM` is the survivor's age in months when the survivor benefit starts,
 * `fraM` their SURVIVOR FRA (survivorFraMonths, not fraMonths).
 */
export function survivorFactor(
  claimAgeM: number,
  fraM: number,
  data: SocialSecurityData,
): number {
  const minM = data.survivorMinClaimAge * MONTHS_PER_YEAR;
  // Clamped at BOTH ends for different reasons: below 60 there is no
  // entitlement at all, and above FRA there is nothing further to earn.
  const ageM = Math.min(Math.max(claimAgeM, minM), fraM);
  if (ageM >= fraM) return 1;
  const window = fraM - minM;
  if (window <= 0) return 1;
  const monthsEarly = fraM - ageM;
  return 1 - (data.survivorMaxReduction * monthsEarly) / window;
}

/**
 * The survivor's monthly benefit, in the same units as the deceased's PIA.
 *
 * `deceasedPia` is the deceased's PIA. `deceasedActualMonthly` is the benefit they were
 * actually receiving (or would have been entitled to) — pass null when he
 * never claimed, which is the ordinary case for a death before claiming.
 *
 * THE RIB-LIM RULE (POMS RS 00615.320) applies only when he claimed EARLY, and
 * it is a floor as much as a cap: the survivor benefit is the larger of 82.5% of the deceased's
 * PIA and the reduced amount he was actually drawing, so the widow of a man
 * who claimed at 62 is not dropped to a 70%-of-PIA cheque. When the deceased never
 * claimed, or claimed at or after FRA, RIB-LIM does not apply at all (20 CFR
 * 404.338(c) conditions it on the insured having *chosen* to receive old-age
 * benefits before FRA) and the survivor benefit is the full PIA plus whatever
 * delayed credits were actually earned, reduced only for the survivor's own
 * early claim.
 *
 * DELAYED CREDITS PASS THROUGH BUT ONLY THE EARNED ONES: an increment month is
 * one for which a retirement benefit was DUE and not received (POMS RS
 * 00615.690), and months after the death are not months anything was due.
 * A man who dies at 68 having never claimed passes on 12 months of credits,
 * not 36; one who dies before FRA passes on none. The caller supplies
 * `deceasedActualMonthly` already carrying whatever credits accrued, so that
 * accounting lives with the caller (engine/household.ts) where the death date
 * is known.
 */
export function survivorMonthlyBenefit(
  deceasedPia: number,
  deceasedActualMonthly: number | null,
  claimAgeM: number,
  survivorFraM: number,
  data: SocialSecurityData,
): number {
  if (deceasedPia <= 0) return 0;
  // Base: the deceased's PIA, plus any delayed credits actually earned — which is
  // exactly what `deceasedActualMonthly` is when it exceeds PIA.
  let base = deceasedPia;
  if (deceasedActualMonthly !== null && deceasedActualMonthly > deceasedPia) {
    base = deceasedActualMonthly; // credits earned past their FRA follow the survivor
  } else if (deceasedActualMonthly !== null && deceasedActualMonthly < deceasedPia) {
    // Claimed early: RIB-LIM. Larger of 82.5% of PIA and the deceased's own
    // reduced benefit — a floor when that reduction was steep, a cap when mild.
    base = Math.max(data.survivorRibLimFloorPctOfPia * deceasedPia, deceasedActualMonthly);
  }
  return base * survivorFactor(claimAgeM, survivorFraM, data);
}

/**
 * Monthly benefit at claim, unrounded (see module comment on SSA rounding).
 *
 * - kind 'worker':  piaMonthly is the claimant's own PIA.
 * - kind 'spousal': piaMonthly is the WORKER's PIA (the spousal factor is
 *   already expressed as a fraction of the worker's PIA).
 * - kind 'survivor': piaMonthly is the DECEASED's PIA and `fraM` must be the
 *   claimant's SURVIVOR FRA. Use survivorMonthlyBenefit instead whenever the
 *   deceased's own claiming history matters (RIB-LIM, delayed credits); this
 *   entry point is the no-history case.
 */
export function monthlyBenefitAtClaim(
  kind: 'worker' | 'spousal' | 'survivor',
  piaMonthly: number,
  claimAgeM: number,
  fraM: number,
  data: SocialSecurityData,
): number {
  const factor =
    kind === 'worker'
      ? workerFactor(claimAgeM, fraM, data)
      : kind === 'spousal'
        ? spousalFactor(claimAgeM, fraM, data)
        : survivorFactor(claimAgeM, fraM, data);
  return piaMonthly * factor;
}

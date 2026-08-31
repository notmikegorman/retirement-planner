/**
 * Household precomputation: wages/401(k) contributions, Social Security
 * claiming schedules, penalty-age boundaries, and health-coverage months
 * (employer / ACA / Medicare). Everything here is path-independent — computed
 * once in prepareSim so Monte Carlo paths pay no setup cost (SPEC §2).
 *
 * Documented conventions (SPEC §5 simplifications):
 * - Annual steps; ages at year end (age = year - birthYear).
 * - A retire event's month stops salary: retiring in month m means months
 *   1..m-1 are worked (retire 2026-07 -> 6 worked months).
 * - Social Security COLA = simulated CPI: the monthly benefit computed here is
 *   in start-year (2026) dollars; the sim multiplies by the cumulative CPI
 *   index. PIA values from the SSA statement are treated as 2026 dollars.
 * - PIA depends on the scenario's retirement date (note 3): the profile carries
 *   both the SSA-statement figure (assumes earnings continue to 62) and the
 *   $0-future-earnings figure, and effectivePiaMonthly interpolates between
 *   them — see its doc comment for the simplification.
 * - Employee share of the employer health premium: a Section 125 pre-tax
 *   payroll deduction while the household has employer coverage — it reduces
 *   W-2 wages exactly like the 401(k) deferral and is NOT a health expense.
 *   Prorated by the same worked months that drive employer coverage, and
 *   scaled by plain CPI in-sim (not medical inflation: the employee share is
 *   negotiated with pay, and modeling it above CPI would compound with the
 *   ACA/Medicare premiums it is meant to be compared against — documented).
 * - Investing stream: investingMonthly x worked months, in start-year dollars;
 *   simulate.ts scales it by CPI and caps it at the year's surplus. Investing
 *   STOPS AT RETIREMENT — the app's standing rule (the owner's, 2026-08-31):
 *   investing out of a paycheck ends with the paycheck, and any
 *   investingMonthlyRetired still in a file is parsed but ignored.
 * - Retirement income stream (ProfileIncome.retirementMonthly): the mirror
 *   image of a salary — monthly x the months NOBODY worked, in start-year
 *   dollars, starting in the first year no salary is drawn and continuing for
 *   life. Documented simplification: the Social Security EARNINGS TEST is not
 *   modeled, so a plan that claims before FRA while earning above the annual
 *   exempt amount overstates its benefits (a claim at or after FRA is
 *   never affected — the test does not apply at or after FRA).
 * - Deemed filing: a person with their own worker benefit is modeled as taking
 *   that benefit only (no spousal top-up); a person without one (under 40
 *   credits) takes the spousal benefit off the other spouse's PIA. The spousal
 *   benefit cannot start before the worker files — its start date is clamped
 *   to the later of the two claim dates.
 * - 59 1/2 with annual steps: someone born in month <= 6 attains 59 1/2 in
 *   calendar year birthYear+59 (a March 1975 birth -> September 2034);
 *   distributions in the attainment year are still treated as EARLY
 *   (conservative), so the first penalty-free year is the following year
 *   (2035).
 * - Employer health coverage while anyone works (the household pays only the
 *   employee premium share, above); ACA covers
 *   retired months before Medicare; the Medicare transition year prorates
 *   6 months ACA / 6 months Medicare regardless of birth month (SPEC §5).
 *
 * THE SURVIVOR (a `death` event). Everything about a death is
 * path-independent — the date is written on the scenario — so the whole widow
 * scenario is resolved here, once, and the Monte Carlo hot path never learns
 * that anyone died. What changes:
 *
 * - MONTHLY FLOWS MOVE AT THE MONTH, HOUSEHOLD STATUS MOVES AT THE YEAR.
 *   Salary, Social Security, insurance premiums and living costs are per-month
 *   flows and stop or fall in the month of death, on the same "months 1..m-1"
 *   convention a `retire` event uses. Filing status, the number of people in
 *   the tax household, the ACA household size and the Medicare head-count are
 *   attributes of a TAX YEAR and move at the year boundary — which is not a
 *   simplification but the law: the year of death is filed jointly, and the
 *   decedent is counted on that return.
 * - SOCIAL SECURITY. The deceased's benefit ends (no benefit is payable for
 *   the month of death). Any SPOUSAL benefit the survivor was drawing ends
 *   with the deceased — a spousal benefit is derivative of a living worker.
 *   In its place the survivor is paid the LARGER of their own benefit and a
 *   survivor benefit worth 100% of the deceased's PIA (POMS RS 00615.020: "a
 *   person's benefit amount can never exceed the highest single benefit to
 *   which that person is entitled"). For a household drawing the worker's
 *   benefit plus a 50% spousal top-up that is 1.5x PIA becoming 1.0x PIA — a
 *   third of the household's Social Security, gone permanently, in the same
 *   year the survivor starts filing single. Delayed credits the deceased
 *   actually earned carry over; ones they had not yet earned do not.
 * - LIVING COSTS fall to a fraction of the couple's baseline, prorated in the
 *   death year by the months after it. WHERE THAT FRACTION COMES FROM, in
 *   order: the event's own `livingFraction` (the user asked a specific
 *   what-if), then the per-line survivor amounts in `expenses.lines`, then
 *   DEFAULT_SURVIVOR_LIVING_FRACTION — see resolveSurvivorLiving.
 * - HEALTH COVERAGE is one person: the ACA benchmark is scaled down by the
 *   share of the quoted household still alive, and Medicare is billed for one.
 * - LIFE INSURANCE. EVERY term policy on the deceased that was still in force
 *   pays its face amount, tax-free; their premiums stop.
 * The account side of a death (spousal rollover, basis step-up, terminating
 * the deceased's 72(t)) is per-path and lives in simulate.ts.
 */

import type {
  AcaData,
  FilingStatus,
  LifeInsurancePolicy,
  MedicareData,
  Person,
  Profile,
  SocialSecurityData,
} from '../shared/types';
import { DEFAULT_SURVIVOR_LIVING_FRACTION } from '../shared/types';
import { deriveExpenseStreams, survivorLivingMonthly } from '../shared/expenses';
import {
  claimAgeMonths,
  fraMonths,
  monthlyBenefitAtClaim,
  survivorFraMonths,
  survivorMonthlyBenefit,
} from '../tax/socialSecurity';
import { parseYearMonth } from '../shared/util';
import type { ParsedDeath, ParsedEvents, YM } from './events';
import { compareYm } from './events';

/**
 * Simulated year 1 = tax year 2026 (the tax-data base year; all CPI indexing
 * anchors here, inflationIndex = 1.0 at start). It lives in this module rather
 * than simulate.ts because the PIA-by-retirement-date interpolation anchors on
 * it and simulate.ts already imports this module (simulate.ts re-exports it).
 */
export const SIM_START_YEAR = 2026;

/** Absolute month index, so date comparisons are plain integer arithmetic. */
function absMonth(ym: YM): number {
  return ym.year * 12 + (ym.month - 1);
}

/**
 * What a lone survivor spends on living costs, as a FRACTION of what the couple
 * spent — one figure for each of the two states the plan models, because the
 * per-line answer differs between them (a line's survivor amount defaults to
 * whichever of `monthlyNow` / `monthlyRetired` is in force).
 *
 * `working` and `retired` are the SAME NUMBER unless the answer came from
 * per-line amounts, which is what lets the yearly loop keep using one scalar
 * multiplier in every other case — the arithmetic, and therefore the last bit
 * of every float, is untouched for a profile with no lines.
 */
export interface SurvivorLivingFractions {
  working: number;
  retired: number;
  /**
   * Which of the three sources answered. Reported rather than inferred because
   * "0.75" on screen means something quite different when the user typed it,
   * when their budget implied it, and when nobody chose it at all.
   */
  source: 'event' | 'lines' | 'default';
}

/**
 * THE SURVIVOR'S LIVING COSTS, and the precedence between the three things that
 * can set them.
 *
 * 1. AN EXPLICIT `livingFraction` ON THE DEATH EVENT WINS. It is the user
 *    asking a specific what-if — "what if the survivor's costs did not fall at
 *    all" — and a what-if that the budget could override would not be a
 *    what-if.
 * 2. OTHERWISE THE PER-LINE SURVIVOR AMOUNTS, when the profile carries an
 *    itemised budget. A household with ONE car does not see its $610 payment
 *    fall by a quarter when one of two people dies — it does not fall at all,
 *    and no single fraction can say so. Summing the lines says it exactly.
 * 3. OTHERWISE DEFAULT_SURVIVOR_LIVING_FRACTION — see that constant for why
 *    0.75 is the number in this whole feature most worth arguing with.
 *
 * The lines give a RATIO, not a dollar figure, and are applied to whatever
 * living baseline is in force that year. That is deliberate: it keeps
 * `expense_change` events, the scenario's spending overrides and the
 * working/retired blend all working on the survivor's side exactly as they do
 * on the couple's, instead of pinning the survivor to a figure frozen at
 * prepare time.
 */
function resolveSurvivorLiving(
  profile: Profile,
  eventFraction: number | null,
): SurvivorLivingFractions {
  if (eventFraction !== null) {
    return { working: eventFraction, retired: eventFraction, source: 'event' };
  }
  const survivorWorking = survivorLivingMonthly(profile.expenses, false);
  const survivorRetired = survivorLivingMonthly(profile.expenses, true);
  if (survivorWorking === null || survivorRetired === null) {
    return {
      working: DEFAULT_SURVIVOR_LIVING_FRACTION,
      retired: DEFAULT_SURVIVOR_LIVING_FRACTION,
      source: 'default',
    };
  }
  /*
   * The denominators are the BUDGET'S OWN totals, not the profile's (possibly
   * scenario-overridden) scalars. A what-if that drags living spending down to
   * 6,900 is saying what the household spends, not how differently the survivor
   * spends it; dividing the survivor's line total by an unrelated scalar would
   * mix the two and give a fraction that describes neither.
   */
  const couple = deriveExpenseStreams(profile.expenses);
  const coupleWorking = couple.livingMonthly;
  const coupleRetired = couple.livingMonthlyRetired ?? couple.livingMonthly;
  // A budget that sums to nothing has no ratio to give. Falling back to the
  // default rather than to 0/0 costs nothing either way (the multiplier lands
  // on a baseline that is itself 0) and keeps NaN out of the run.
  return {
    working: coupleWorking > 0 ? survivorWorking / coupleWorking : DEFAULT_SURVIVOR_LIVING_FRACTION,
    retired: coupleRetired > 0 ? survivorRetired / coupleRetired : DEFAULT_SURVIVOR_LIVING_FRACTION,
    source: 'lines',
  };
}

/**
 * ONE LIFE INSURANCE POLICY as the schedules below need it: absolute month
 * bounds instead of "YYYY-MM", the insured resolved to an index, and every
 * default already applied.
 */
interface ResolvedPolicy {
  /** Index into profile.people. Only a death on THIS person pays. */
  insuredIndex: number;
  premiumMonthly: number;
  deathBenefit: number;
  termStartAbs: number | null;
  termEndAbs: number | null;
  /**
   * The premium — AND the cover — stop when the last salary does.
   *
   * FALSE by default (LifeInsurancePolicy.cancelAtRetirement): a policy you are
   * paying for is a policy you are paying for, and dropping it is a decision the
   * plan should show you making rather than one it makes silently. Cover goes
   * with the premium because a cancelled policy pays nothing; a policy you mean
   * to keep past the paycheck is one with `cancelAtRetirement` left alone.
   *
   * It is also exactly the pre-existing single-policy rule, which is why the
   * legacy fields resolve to one policy carrying this flag rather than to a
   * second code path — see resolvePolicies.
   */
  cancelAtRetirement: boolean;
}

/**
 * EVERY policy in force, from whichever of the two representations the profile
 * uses. `lifeInsurancePolicies`, when non-empty, supersedes the single-policy
 * fields entirely — including the insured, the term and the benefit, so a list
 * cannot half-inherit a legacy field and pay twice.
 *
 * THE LEGACY FIELDS ARE ONE POLICY, not a second code path. Their old rule —
 * with no term dates, cover exists only while a paycheck does — is exactly
 * `cancelAtRetirement`, so it needs no special case anywhere downstream. With a
 * term named, the policy stands on its own dates whether anyone is earning or
 * not, which is `cancelAtRetirement: false`.
 */
function resolvePolicies(profile: Profile): ResolvedPolicy[] {
  const e = profile.expenses;
  const known = (): string => profile.people.map((p) => p.id).join(', ');
  const list = e.lifeInsurancePolicies ?? [];
  if (list.length > 0) {
    return list.map((p: LifeInsurancePolicy): ResolvedPolicy => {
      const insuredIndex = profile.people.findIndex((x) => x.id === p.insured);
      if (insuredIndex < 0) {
        throw new Error(
          `life insurance policy "${p.label}" insures unknown person "${p.insured}" ` +
            `(known: ${known()})`,
        );
      }
      return {
        insuredIndex,
        premiumMonthly: p.premiumMonthly,
        deathBenefit: p.deathBenefit,
        termStartAbs: p.termStart ? absMonth(parseYearMonth(p.termStart)) : null,
        termEndAbs: p.termEnd ? absMonth(parseYearMonth(p.termEnd)) : null,
        // ABSENT MEANS FALSE — see ResolvedPolicy.cancelAtRetirement for why
        // keeping a policy is the default and dropping it is the decision.
        cancelAtRetirement: p.cancelAtRetirement === true,
      };
    });
  }

  // The single-policy fields. ABSENT insured = the first person who draws a
  // salary (income replacement insures the earner), failing that the first
  // person.
  const insured = e.lifeInsuranceInsured;
  const insuredIndex = insured
    ? profile.people.findIndex((p) => p.id === insured)
    : Math.max(
        0,
        profile.people.findIndex((p) => (profile.income.salaries[p.id] ?? 0) > 0),
      );
  if (insured !== undefined && insuredIndex < 0) {
    throw new Error(
      `lifeInsuranceInsured names unknown person "${insured}" (known: ${known()})`,
    );
  }
  const termStartAbs = e.lifeInsuranceTermStart
    ? absMonth(parseYearMonth(e.lifeInsuranceTermStart))
    : null;
  const termEndAbs = e.lifeInsuranceTermEnd
    ? absMonth(parseYearMonth(e.lifeInsuranceTermEnd))
    : null;
  return [
    {
      insuredIndex,
      premiumMonthly: e.lifeInsuranceMonthly ?? 0,
      deathBenefit: e.lifeInsuranceDeathBenefit ?? 0,
      termStartAbs,
      termEndAbs,
      cancelAtRetirement: termStartAbs === null && termEndAbs === null,
    },
  ];
}

/**
 * A `death` event, fully resolved: who died, when, who is left, what the
 * survivor's Social Security becomes, and what the insurer pays. Everything
 * here is path-independent, so a survivor scenario costs the simulation
 * nothing per path.
 */
export interface PreparedDeath {
  personId: string;
  /** Index into profile.people. */
  index: number;
  ym: YM;
  year: number;
  survivorId: string;
  survivorIndex: number;
  /** What the survivor spends on living, as a share of the couple (already resolved). */
  survivorLiving: SurvivorLivingFractions;
  /**
   * Month the survivor's benefit off the deceased's record begins — the later
   * of the death and the survivor's own claim date, floored at the survivor
   * minimum claim age of 60 — or null when there can never be one (the
   * deceased had no PIA).
   */
  survivorClaim: YM | null;
  /** The survivor benefit, $/month in start-year dollars (0 when there is none). */
  survivorMonthlyReal: number;
  /** Statutory one-time lump-sum death payment ($255, never indexed). */
  lumpSumDeathPayment: number;
  /**
   * Life-insurance face amount paid on this death, NOMINAL: the SUM over every
   * policy whose term covers the month of death and whose insured is the person
   * who died (0 when none does). Summed, because a household with two policies
   * on the same life collects both.
   */
  lifeInsuranceBenefit: number;
}

export interface PreparedPerson {
  id: string;
  index: number;
  birthYear: number;
  birthMonth: number;
  salary: number;
  retire: YM | null;
  /** Month this person dies, or null — the only thing that can end a life here. */
  death: YM | null;
  /** Retirement calendar year, or null when the person never retires in this scenario. */
  retireYear: number | null;
  /** PIA at FRA actually used, after the retirement-date interpolation (2026 $/month). */
  effectivePiaMonthly: number;
  /** First calendar year IRA / 401(k) withdrawals are penalty-free (59 1/2, annual steps). */
  penaltyFreeFromYear: number;
  /** Year this person turns medicareStartAge (Medicare transition year). */
  medicareFirstYear: number;
  /** Months employed (salary > 0) per sim year. */
  workedMonthsByYear: number[];
  /** Monthly benefit at claim in start-year dollars (PIA x claiming factor); 0 if never claims. */
  ssMonthlyAtClaimReal: number;
  /** Effective benefit start (spousal clamped to the worker's filing); null = never. */
  ssStart: YM | null;
}

export interface PreparedHousehold {
  people: PreparedPerson[];
  /**
   * The resolved `death` event, or null in every ordinary run. Null is the
   * gate on every survivor branch downstream, which is what makes "nothing
   * about a plan without a death changes" checkable by inspection.
   */
  death: PreparedDeath | null;
  /**
   * Filing status per sim year: 'mfj' through the year of death INCLUSIVE
   * (IRC 6013(a)(3) — the year of death is the last joint return), 'single'
   * from the first full year after it. No qualifying-surviving-spouse grace
   * period: IRC 2(a)(1)(B) makes a dependent child a mandatory test, so a
   * childless widow never has that status and the penalty lands immediately.
   */
  filingByYear: FilingStatus[];
  /**
   * Indexes into `people` of the year's TAX HOUSEHOLD — everyone not dead
   * BEFORE the year, so the decedent is counted in the year of death and gone
   * after. Drives the number of 65+ add-ons, Virginia's exemptions and age
   * deduction, South Carolina's per-person deductions, and Medicare's
   * head-count.
   */
  taxPeopleByYear: number[][];
  /**
   * Multiplier on the living baseline: 1 until the death year, blended in it
   * by the months either side, and the event's `livingFraction` after. Exactly
   * 1 everywhere in a run with no death, and the yearly loop multiplies by it
   * unconditionally — 1 is a no-op, so there is no second code path to keep
   * honest.
   */
  livingFactorByYear: number[];
  /**
   * Multiplier on the household's ACA benchmark quote: the share of the quoted
   * household still alive, from the year AFTER the death (the death year keeps
   * the couple's premium, matching the joint return and the fact that both
   * were covered for most of it — a documented simplification that overstates
   * the survivor's cost in that one year and never understates it).
   */
  acaBenchmarkFactorByYear: number[];
  /**
   * Life-insurance premium charged per year, $/year in start-year dollars
   * (x CPI index in-sim): summed over every policy in force, each one's own
   * monthly premium times its own covered months.
   *
   * A DOLLAR FIGURE RATHER THAN A MONTH COUNT, which it used to be: with two
   * policies at different premiums and different expiry dates there is no
   * single month count that means anything. One policy may run to 2034 while
   * the other expires at retirement; charging one number of months against one
   * premium could only ever be right for one of them.
   */
  lifeInsurancePremiumRealByYear: number[];
  /**
   * NON-TAXABLE cash arriving in each year: the life-insurance death benefit
   * (IRC 101(a)(1)) and the Social Security lump-sum death payment. All zeroes
   * without a death. It lands in savings rather than passing through the
   * income lines — see simulate.ts for why routing a seven-figure benefit
   * through a working year's surplus would have been catastrophic.
   */
  lifeInsuranceBenefitByYear: number[];
  ssLumpSumByYear: number[];
  /** Household W-2 wages AFTER 401(k) deferrals, per sim year (nominal = real; salaries are not indexed). */
  wagesNetByYear: number[];
  /** Household gross wages before deferrals (informational). */
  wagesGrossByYear: number[];
  /**
   * 401(k) contributions per year, by account. `amount` is what joins the
   * balance (employee deferral + employer match); `deferral` is the employee's
   * own share of it, tracked separately because only that share came out of
   * gross pay — which is what the tithe-account rule's contribution history
   * means by a dollar already given on. The match never passed under a tithe.
   */
  contribByYear: Array<Array<{ accountId: string; amount: number; deferral: number }>>;
  /** Household Social Security per year in start-year dollars (x CPI index in-sim). */
  ssGrossRealByYear: number[];
  /** Months of employer coverage / paid work in the household (max across people). */
  employerMonthsByYear: number[];
  /**
   * Employee share of the employer health premium per year in start-year
   * dollars (x CPI index in-sim). Pre-tax payroll deduction: simulate.ts
   * subtracts it from wages for BOTH tax and take-home cash.
   */
  premiumShareRealByYear: number[];
  /**
   * Transfer to the taxable brokerage, start-year dollars (capped at surplus
   * in-sim): investingMonthly x worked months, and NOTHING after the last
   * paycheck — investing stops at retirement (the app's standing rule,
   * 2026-08-31), so a fully retired year transfers zero and the retirement
   * year is prorated down to its worked months.
   */
  investingRealByYear: number[];
  /**
   * Retirement income (ProfileIncome.retirementMonthly) per year in start-year
   * dollars (x CPI index in-sim): monthly x the months NOBODY worked, so it
   * starts in the first year no salary is drawn, is prorated in the retirement
   * year, and continues for life. All zeroes when the field is absent.
   */
  retirementIncomeRealByYear: number[];
  /** Household ACA enrolled months per year (0 while employer coverage or full Medicare). */
  acaMonthsByYear: number[];
  /** Age-curve scaling factor for the ACA benchmark quote, per year. */
  acaAgeFactorByYear: number[];
  /** Medicare enrolled months per person per year: [personIndex][yearIndex]. */
  medicareMonthsByPersonYear: number[][];
}

/**
 * Months worked in `year` given a salary, an optional retirement date, and an
 * optional death.
 *
 * Death truncates exactly the way retirement does — months 1..m-1 — because it
 * is the same kind of fact about a month: dying in month m means months 1..m-1
 * were worked. Whichever comes first wins, so a person who retires and then
 * dies contributes nothing twice.
 */
function workedMonths(
  salary: number,
  retire: YM | null,
  death: YM | null,
  year: number,
): number {
  if (salary <= 0) return 0;
  let months = 12;
  if (retire !== null) {
    if (year > retire.year) months = 0;
    else if (year === retire.year) months = Math.min(months, retire.month - 1);
  }
  if (death !== null) {
    if (year > death.year) months = 0;
    else if (year === death.year) months = Math.min(months, death.month - 1);
  }
  return Math.max(0, months);
}

/**
 * First penalty-free calendar year for the 59 1/2 rule with annual steps.
 * Attainment year = birthYear + 59 when birthMonth <= 6 (59 1/2 falls in the
 * same calendar year), else birthYear + 60. Distributions during the
 * attainment year are treated as early (conservative), so penalty-free
 * treatment starts the FOLLOWING year.
 */
export function penaltyFreeFromYear(person: Pick<Person, 'birthYear' | 'birthMonth'>): number {
  const attainYear = person.birthMonth <= 6 ? person.birthYear + 59 : person.birthYear + 60;
  return attainYear + 1;
}

/**
 * PIA at FRA for a person under this scenario's retirement date (note 3).
 *
 * The SSA statement's FRA estimate assumes earnings CONTINUE at the current
 * salary through age 62, so it overstates the benefit of anyone who stops
 * earlier; `piaMonthlyAtFraIfStoppingNow` is the same figure with $0 future
 * earnings. The engine picks between them by retirement year:
 * - no retire event, or retiring in/after the year the person turns 62
 *   (a March-1975 birth -> 2037): the working-to-62 figure;
 * - retiring in or before the sim's first year (2026): the stopping-now figure;
 * - in between: LINEAR interpolation by years worked,
 *   (retireYear - 2026) / (age62Year - 2026).
 *
 * DOCUMENTED SIMPLIFICATION: the real AIME is a 35-highest-years average, so
 * the true curve is slightly concave (early years drop out first) and the last
 * years before 62 add less than the interpolation implies. Linear is within a
 * few percent over a 7-year window and needs only the two figures the SSA
 * actually publishes. Month granularity is ignored: the retirement YEAR drives
 * the interpolation.
 */
export function effectivePiaMonthly(
  person: Pick<
    Person,
    'birthYear' | 'piaMonthlyAtFraIfWorkingTo62' | 'piaMonthlyAtFraIfStoppingNow'
  >,
  retireYear: number | null,
  baseYear: number = SIM_START_YEAR,
): number {
  const working = person.piaMonthlyAtFraIfWorkingTo62;
  const stoppingNow = person.piaMonthlyAtFraIfStoppingNow;
  const age62Year = person.birthYear + 62;
  if (retireYear === null || retireYear >= age62Year) return working;
  if (retireYear <= baseYear || age62Year <= baseYear) return stoppingNow;
  const frac = (retireYear - baseYear) / (age62Year - baseYear);
  return stoppingNow + (working - stoppingNow) * frac;
}

/** Age-curve lookup with clamping to the table's covered ages. */
function ageCurveFactor(curve: AcaData['ageCurve'], age: number): number {
  const keys = Object.keys(curve)
    .map((k) => Number(k))
    .sort((a, b) => a - b);
  const lo = keys[0];
  const hi = keys[keys.length - 1];
  const clamped = Math.min(hi, Math.max(lo, age));
  return curve[String(clamped)];
}

/**
 * Resolve each person's Social Security claim: effective start date and the
 * monthly benefit at claim in start-year dollars.
 *
 * Worker benefit (hasOwnBenefit): own EFFECTIVE PIA x worker factor at the
 * claim age. Spousal benefit: the worker spouse's EFFECTIVE PIA x spousal
 * factor at the claimant's age on the EFFECTIVE start date, which is clamped
 * to the later of the claimant's own claim date and the worker's claim date
 * (spousal cannot start before the worker files; deemed filing documented
 * above). No delayed credits on spousal. "Effective PIA" is the
 * retirement-date interpolation (effectivePiaMonthly) — retiring earlier
 * shrinks the spousal benefit exactly as it shrinks the worker's.
 */
/** One person's own (non-survivor) benefit stream. */
interface ResolvedClaim {
  start: YM | null;
  monthlyReal: number;
  /**
   * Which kind it is. It matters at exactly one place, and only when someone
   * dies: a SPOUSAL benefit is derivative of a living worker and terminates
   * with the worker, while a worker benefit is the claimant's own and does not.
   */
  kind: 'worker' | 'spousal' | 'none';
  /** For a spousal benefit, the person whose record it hangs off. */
  workerIndex: number | null;
}

function resolveClaims(
  people: Person[],
  claims: ParsedEvents['claims'],
  pias: number[],
  ss: SocialSecurityData,
): ResolvedClaim[] {
  const none: ResolvedClaim = { start: null, monthlyReal: 0, kind: 'none', workerIndex: null };
  return people.map((person, index) => {
    const claim = claims.get(person.id);
    if (!claim) return none;
    const fraM = fraMonths(person, ss);
    const pia = pias[index];

    if (person.hasOwnBenefit && pia > 0) {
      const ageM = claimAgeMonths(person, claim.year, claim.month);
      return {
        start: claim,
        monthlyReal: monthlyBenefitAtClaim('worker', pia, ageM, fraM, ss),
        kind: 'worker',
        workerIndex: null,
      };
    }

    // Spousal off the other person's effective PIA.
    const workerIndex = people.findIndex(
      (p, i) => p.id !== person.id && p.hasOwnBenefit && pias[i] > 0,
    );
    if (workerIndex < 0) return none;
    const worker = people[workerIndex];
    const workerClaim = claims.get(worker.id);
    if (!workerClaim) return none; // worker never files -> no spousal
    const effective = compareYm(claim, workerClaim) >= 0 ? claim : workerClaim;
    const ageM = claimAgeMonths(person, effective.year, effective.month);
    return {
      start: effective,
      monthlyReal: monthlyBenefitAtClaim('spousal', pias[workerIndex], ageM, fraM, ss),
      kind: 'spousal',
      workerIndex,
    };
  });
}

/**
 * Resolve a `death` event into everything path-independent about it.
 *
 * Returns null when the scenario carries no death, which is the gate on every
 * survivor branch in the engine. Throws when a scenario names a person who is
 * not in the profile, or when nobody would be left alive — a plan with no
 * household left to score is a question this model has no answer to, and
 * answering it with silence would be worse than refusing.
 */
function resolveDeath(
  profile: Profile,
  parsed: ParsedEvents,
  ss: SocialSecurityData,
  pias: number[],
  claims: ResolvedClaim[],
  lifeInsuranceBenefitAtDeath: (death: ParsedDeath, insuredIndex: number) => number,
): PreparedDeath | null {
  if (parsed.deaths.length === 0) return null;
  if (parsed.deaths.length > 1) {
    throw new Error(
      `A scenario may carry at most one 'death' event; found ${parsed.deaths.length}. ` +
        'Modelling both spouses dying leaves no household to score, and the survivor ' +
        'machinery (filing single, the spousal rollover, the widow benefit) is defined ' +
        'for exactly one survivor.',
    );
  }
  const d = parsed.deaths[0];
  const index = profile.people.findIndex((p) => p.id === d.personId);
  if (index < 0) {
    throw new Error(
      `death event names unknown person "${d.personId}" ` +
        `(known: ${profile.people.map((p) => p.id).join(', ')})`,
    );
  }
  const survivorIndex = profile.people.findIndex((_, i) => i !== index);
  if (survivorIndex < 0) {
    throw new Error(
      `death event on "${d.personId}" would leave nobody alive — there is no survivor to score.`,
    );
  }
  const deceased = profile.people[index];
  const survivor = profile.people[survivorIndex];
  const deathAbs = absMonth(d.ym);

  // --- The survivor's benefit off the deceased's record ---------------------
  // Base it on what the deceased was ACTUALLY entitled to, which is not always
  // their PIA:
  //   - claimed before dying  -> that own reduced-or-credited benefit, and
  //     RIB-LIM applies if it was reduced (survivorMonthlyBenefit handles the
  //     82.5%-of-PIA floor);
  //   - never claimed, died after FRA -> PIA plus the delayed credits actually
  //     LIVED to earn. An increment month is one for which a benefit was due
  //     and not taken (POMS RS 00615.690); months after the death are not such
  //     months. Dying at 68 having never claimed passes on 12 months of
  //     credits, not 36;
  //   - never claimed, died before FRA -> PIA, no credits, no RIB-LIM.
  const deceasedPia = pias[index];
  const deceasedClaim = claims[index];
  let deceasedActualMonthly: number | null = null;
  if (
    deceasedClaim.kind === 'worker' &&
    deceasedClaim.start !== null &&
    absMonth(deceasedClaim.start) < deathAbs
  ) {
    deceasedActualMonthly = deceasedClaim.monthlyReal;
  } else if (deceasedPia > 0) {
    const fraM = fraMonths(deceased, ss);
    const ageAtDeathM = claimAgeMonths(deceased, d.ym.year, d.ym.month);
    const maxCreditM = maxDelayedCreditMonths(ss, fraM);
    const creditM = Math.min(Math.max(0, ageAtDeathM - fraM), maxCreditM);
    deceasedActualMonthly = creditM > 0 ? deceasedPia * (1 + creditM * ss.delayedCreditPerMonth) : null;
  }

  // --- When the survivor benefit starts -------------------------------------
  // The plan's own answer unless the event overrides it (see the event's
  // `survivorClaim` doc for why a death must not silently rewrite a claiming
  // decision), and never before the survivor minimum claim age of 60 — there
  // is simply no benefit before it.
  const survivorMinAbs =
    (survivor.birthYear + ss.survivorMinClaimAge) * 12 + (survivor.birthMonth - 1);
  /*
   * THE SURVIVOR'S OWN CLAIM DATE, from the scenario — not the resolved start.
   *
   * `claims[i].start` is the DEEMED-FILING-ADJUSTED effective date: for a
   * spousal benefit resolveClaims clamps it to the later of the survivor's own
   * date and the WORKER's, because a spousal benefit cannot begin before the
   * worker files. A survivor benefit has no such condition — the worker is
   * dead, there is nothing left to file — so reading the clamped date pushed
   * the survivor benefit out to the deceased's claim date and paid nothing in
   * between. That is silent for a household claiming together, and wrong for
   * the commonest two-earner shape there is: the lower earner claims early
   * while the higher earner delays.
   *
   * The type doc and ASSUMPTIONS.md both promise "whatever claim date the
   * scenario already gives the survivor", so this reads exactly that.
   */
  const ownClaim = parsed.claims.get(profile.people[survivorIndex].id) ?? null;
  const preferredAbs =
    d.survivorClaim !== null
      ? absMonth(d.survivorClaim)
      : Math.max(deathAbs, ownClaim !== null ? absMonth(ownClaim) : deathAbs);
  const startAbs = Math.max(preferredAbs, deathAbs, survivorMinAbs);
  const survivorClaim: YM = { year: Math.floor(startAbs / 12), month: (startAbs % 12) + 1 };

  const survivorMonthlyReal =
    deceasedPia > 0
      ? survivorMonthlyBenefit(
          deceasedPia,
          deceasedActualMonthly,
          claimAgeMonths(survivor, survivorClaim.year, survivorClaim.month),
          survivorFraMonths(survivor, ss),
          ss,
        )
      : 0;

  return {
    personId: deceased.id,
    index,
    ym: d.ym,
    year: d.ym.year,
    survivorId: survivor.id,
    survivorIndex,
    survivorLiving: resolveSurvivorLiving(profile, d.livingFraction),
    survivorClaim: deceasedPia > 0 ? survivorClaim : null,
    survivorMonthlyReal,
    lumpSumDeathPayment: ss.lumpSumDeathPayment,
    lifeInsuranceBenefit: lifeInsuranceBenefitAtDeath(d, index),
  };
}

/** Months of delayed credit available: FRA to maxClaimAge, never negative. */
function maxDelayedCreditMonths(ss: SocialSecurityData, fraM: number): number {
  return Math.max(0, ss.maxClaimAge * 12 - fraM);
}

/** Months of benefit received in `year` for a benefit starting at `start`. */
function benefitMonths(start: YM | null, year: number): number {
  if (start === null || year < start.year) return 0;
  if (year === start.year) return 13 - start.month;
  return 12;
}

/**
 * Precompute all path-independent household schedules. `startYear` is the tax
 * data base year (2026); `horizonYears` the number of simulated years.
 */
export function prepareHousehold(
  profile: Profile,
  parsed: ParsedEvents,
  ss: SocialSecurityData,
  medicare: MedicareData,
  aca: AcaData,
  startYear: number,
  horizonYears: number,
): PreparedHousehold {
  // PIA per person from this scenario's retirement dates (note 3), then the
  // claims — worker AND spousal both key off these effective figures.
  const retireByPerson = profile.people.map((p) => parsed.retirements.get(p.id) ?? null);
  const pias = profile.people.map((p, i) =>
    effectivePiaMonthly(p, retireByPerson[i]?.year ?? null, startYear),
  );
  const claims = resolveClaims(profile.people, parsed.claims, pias, ss);

  /*
   * --- Term life ------------------------------------------------------------
   * EVERY policy the household holds: who each one insures, what it costs, what
   * it pays, and for which months it is in force.
   *
   * `expenses.lifeInsurancePolicies` SUPERSEDES the single-policy fields, which
   * survive only so that profiles written before the list existed keep running.
   * There is no second code path for them: the legacy fields resolve to ONE
   * policy through the same loop, with `cancelAtRetirement` carrying the old
   * "coverage ends with the paycheck" rule (see resolvePolicies). One loop is
   * what makes "an untouched profile is bit-for-bit unchanged" a property that
   * can be checked rather than hoped for —
   * tests/engine/preExpenseLinesUnchanged.test.ts is the check.
   *
   * WHY A LIST AT ALL. Modelling two policies as one costs real money in both
   * directions: a term policy running to 2034 against a plan that retires in
   * 2030 means an "ends at retirement" rule drops four years of $1,900/yr
   * premium AND four years of $2,500,000 of cover — in exactly the
   * pre-Social-Security years where a death hurts most.
   */
  const policies = resolvePolicies(profile);

  // Worked months per person BEFORE any death, so the "coverage ends with the
  // paycheck" rule has the same household signal it always had.
  const workedMonthsNoDeath = profile.people.map((p, index) => {
    const salary = profile.income.salaries[p.id] ?? 0;
    const arr: number[] = new Array(horizonYears);
    for (let yi = 0; yi < horizonYears; yi++) {
      arr[yi] = workedMonths(salary, retireByPerson[index], null, startYear + yi);
    }
    return arr;
  });
  const employerMonthsNoDeath: number[] = new Array(horizonYears);
  for (let yi = 0; yi < horizonYears; yi++) {
    let m = 0;
    for (const arr of workedMonthsNoDeath) m = Math.max(m, arr[yi]);
    employerMonthsNoDeath[yi] = m;
  }

  /**
   * Is THIS policy in force in the month `abs`, given a household worked-months
   * schedule to test `cancelAtRetirement` against?
   *
   * The schedule is a parameter because the two callers genuinely need
   * different ones. The BENEFIT test passes the months before any death: the
   * death that ends the paycheck is the same death that claims the benefit, and
   * a policy in force the morning somebody dies has not lapsed by that
   * afternoon. The PREMIUM schedule passes the months actually worked, so a
   * household whose earner dies mid-year stops paying a
   * cancel-at-retirement premium from the month the salary stopped.
   */
  const policyInForce = (p: ResolvedPolicy, abs: number, employerMonths: number[]): boolean => {
    if (p.termStartAbs !== null && abs < p.termStartAbs) return false;
    if (p.termEndAbs !== null && abs > p.termEndAbs) return false;
    if (!p.cancelAtRetirement) return true;
    const yi = Math.floor(abs / 12) - startYear;
    if (yi < 0 || yi >= horizonYears) return false;
    return (abs % 12) + 1 <= employerMonths[yi];
  };

  /** Face amount payable on this death: every policy on the decedent, summed. */
  const lifeInsuranceBenefitAtDeath = (d: ParsedDeath, insuredIndex: number): number => {
    const abs = absMonth(d.ym);
    let total = 0;
    for (const p of policies) {
      if (p.insuredIndex !== insuredIndex) continue;
      if (p.deathBenefit <= 0) continue;
      if (policyInForce(p, abs, employerMonthsNoDeath)) total += p.deathBenefit;
    }
    return total;
  };

  const death = resolveDeath(profile, parsed, ss, pias, claims, lifeInsuranceBenefitAtDeath);
  const deathByIndex = (index: number): YM | null =>
    death !== null && death.index === index ? death.ym : null;

  const people: PreparedPerson[] = profile.people.map((p, index) => {
    const salary = profile.income.salaries[p.id] ?? 0;
    const retire = retireByPerson[index];
    const dies = deathByIndex(index);
    const workedMonthsByYear: number[] = new Array(horizonYears);
    for (let yi = 0; yi < horizonYears; yi++) {
      workedMonthsByYear[yi] = workedMonths(salary, retire, dies, startYear + yi);
    }
    return {
      id: p.id,
      index,
      birthYear: p.birthYear,
      birthMonth: p.birthMonth,
      salary,
      retire,
      death: dies,
      retireYear: retire?.year ?? null,
      effectivePiaMonthly: pias[index],
      penaltyFreeFromYear: penaltyFreeFromYear(p),
      medicareFirstYear: p.birthYear + medicare.medicareStartAge,
      workedMonthsByYear,
      ssMonthlyAtClaimReal: claims[index].monthlyReal,
      ssStart: claims[index].start,
    };
  });

  // --- Wages, deferrals, matches -------------------------------------------
  // contribution401k/employerMatch401k apply to the FIRST person (profile
  // order) with a salary and a 401(k) account they own (the spec's "while
  // person 1 works"); prorated by worked months and capped at wages.
  const deferralPerson = people.find(
    (p) => p.salary > 0 && profile.accounts.some((a) => a.type === '401k' && a.owner === p.id),
  );
  const deferralAccountId = deferralPerson
    ? profile.accounts.find((a) => a.type === '401k' && a.owner === deferralPerson.id)!.id
    : null;

  const wagesNetByYear: number[] = new Array(horizonYears);
  const wagesGrossByYear: number[] = new Array(horizonYears);
  const contribByYear: PreparedHousehold['contribByYear'] = new Array(horizonYears);
  for (let yi = 0; yi < horizonYears; yi++) {
    let gross = 0;
    let deferral = 0;
    const contribs: PreparedHousehold['contribByYear'][number] = [];
    for (const p of people) {
      const frac = p.workedMonthsByYear[yi] / 12;
      const w = p.salary * frac;
      gross += w;
      if (deferralPerson && p.id === deferralPerson.id && frac > 0) {
        const def = Math.min(profile.income.contribution401k * frac, w);
        const match = profile.income.employerMatch401k * frac;
        deferral += def;
        if (def + match > 0 && deferralAccountId) {
          contribs.push({ accountId: deferralAccountId, amount: def + match, deferral: def });
        }
      }
    }
    wagesGrossByYear[yi] = gross;
    wagesNetByYear[yi] = gross - deferral;
    contribByYear[yi] = contribs;
  }

  // --- Social Security (start-year dollars; x CPI index in-sim) -------------
  const ssGrossRealByYear: number[] = new Array(horizonYears);
  if (death === null) {
    // The unchanged path: whole years of each person's own benefit.
    for (let yi = 0; yi < horizonYears; yi++) {
      const year = startYear + yi;
      let total = 0;
      for (const p of people) {
        total += p.ssMonthlyAtClaimReal * benefitMonths(p.ssStart, year);
      }
      ssGrossRealByYear[yi] = total;
    }
  } else {
    /*
     * A death needs a MONTH-BY-MONTH walk, because three different things
     * change on three different months: the deceased's benefit ends in the
     * month of death, any spousal benefit ends with it (a spousal benefit is
     * derivative of a living worker and has nothing left to derive from), and
     * the survivor benefit begins on its own start date. Walking the months costs
     * ~500 iterations ONCE per run — it is path-independent — against getting
     * the transition year wrong forever.
     *
     * The rule at each month is the one POMS states: the survivor is paid the
     * LARGER of their own benefit and the survivor benefit, never the sum. That single
     * `Math.max` is where two cheques become one.
     */
    const deathAbs = absMonth(death.ym);
    const survivorStartAbs = death.survivorClaim ? absMonth(death.survivorClaim) : null;
    for (let yi = 0; yi < horizonYears; yi++) {
      const year = startYear + yi;
      let total = 0;
      for (let m = 1; m <= 12; m++) {
        const nowAbs = year * 12 + (m - 1);
        for (const p of people) {
          const claim = claims[p.index];
          // Dead: no benefit is payable for the month of death or after.
          if (p.death !== null && nowAbs >= deathAbs) continue;
          let own = 0;
          if (claim.start !== null && nowAbs >= absMonth(claim.start)) {
            // A spousal benefit dies with the worker it hangs off.
            const workerDead =
              claim.kind === 'spousal' &&
              claim.workerIndex === death.index &&
              nowAbs >= deathAbs;
            if (!workerDead) own = p.ssMonthlyAtClaimReal;
          }
          const survivorNow =
            p.index === death.survivorIndex &&
            survivorStartAbs !== null &&
            nowAbs >= survivorStartAbs
              ? death.survivorMonthlyReal
              : 0;
          total += Math.max(own, survivorNow);
        }
      }
      ssGrossRealByYear[yi] = total;
    }
  }

  // --- Filing status and the tax household, per year -----------------------
  // The year of death is the LAST joint return (IRC 6013(a)(3)) and the
  // decedent is counted on it; every year after is single, with no qualifying
  // surviving-spouse grace period available to a childless widow. This pair of
  // arrays is where the widow penalty actually enters the model — one flips
  // the bracket/deduction/threshold tables, the other drops the head-count
  // that drives per-person deductions and Medicare enrollment.
  const filingByYear: FilingStatus[] = new Array(horizonYears);
  const taxPeopleByYear: number[][] = new Array(horizonYears);
  const allIndexes = people.map((p) => p.index);
  for (let yi = 0; yi < horizonYears; yi++) {
    const year = startYear + yi;
    if (death === null || year <= death.year) {
      filingByYear[yi] = profile.filing.status;
      taxPeopleByYear[yi] = allIndexes;
    } else {
      filingByYear[yi] = 'single';
      taxPeopleByYear[yi] = allIndexes.filter((i) => i !== death.index);
    }
  }

  // --- Health coverage months ----------------------------------------------
  // Employer coverage for the whole household while anyone works (cost = the
  // employee premium share, handled as a payroll deduction, not an expense).
  // Medicare from the year each person turns medicareStartAge: 6 months in the
  // transition year (SPEC §5 6/6 proration), 12 after. ACA fills the rest.
  //
  // A death truncates the deceased's Medicare months on the same "months
  // 1..m-1" convention everything else here uses, and zeroes them after. (In
  // practice the premium for the month of death is generally not refunded, so
  // this understates by at most one month of Part B — noted rather than
  // modelled, because a whole extra convention for $200 is not worth the
  // reader's attention.)
  const medicareMonthsByPersonYear: number[][] = people.map((p) => {
    const arr: number[] = new Array(horizonYears);
    for (let yi = 0; yi < horizonYears; yi++) {
      const year = startYear + yi;
      let m = year < p.medicareFirstYear ? 0 : year === p.medicareFirstYear ? 6 : 12;
      if (p.death !== null) {
        if (year > p.death.year) m = 0;
        else if (year === p.death.year) m = Math.min(m, p.death.month - 1);
      }
      arr[yi] = m;
    }
    return arr;
  });

  const acaMonthsByYear: number[] = new Array(horizonYears);
  const acaAgeFactorByYear: number[] = new Array(horizonYears);
  const employerMonthsByYear: number[] = new Array(horizonYears);
  const premiumShareRealByYear: number[] = new Array(horizonYears);
  const investingRealByYear: number[] = new Array(horizonYears);
  const retirementIncomeRealByYear: number[] = new Array(horizonYears);
  // Retirement income: absent means "contributes nothing", and the code below
  // adds nothing at all in that case, so a profile without it produces
  // bit-for-bit the numbers it produced before the field existed. (Investing
  // has no retired side at all any more — see investingRealByYear.)
  const retirementIncomeMonthly = profile.income.retirementMonthly;
  // The quote's own age anchor, per person: the household benchmark is a
  // sum of age-rated individual premiums, so a survivor's ratio has to be
  // anchored on THEIR age at the quote year rather than on person 1's.
  // Identical for same-age spouses, correct rather than lucky for any other.
  const quoteFactorFor = (p: Person): number =>
    ageCurveFactor(aca.ageCurve, profile.health.acaQuoteYear - p.birthYear);
  for (let yi = 0; yi < horizonYears; yi++) {
    let employerMonths = 0;
    for (const p of people) employerMonths = Math.max(employerMonths, p.workedMonthsByYear[yi]);
    employerMonthsByYear[yi] = employerMonths;
    /*
     * ONLY PEOPLE WHO ARE STILL ALIVE NEED HEALTH COVER.
     *
     * This iterated every person in the profile, so a decedent evaluated to
     * 12 - 0 employer months - 0 Medicare months = 12 uncovered months in
     * EVERY year after the death, forever. The Math.max then pinned the
     * household at a full year of exchange premiums even when the surviving
     * spouse was on Medicare twelve months out of twelve — charging a survivor
     * in their seventies an ACA benchmark on top of Part B for the rest of the
     * run, and understating the chance of success by six to nine points.
     *
     * `taxPeopleByYear` is the list that already knows: it keeps the decedent
     * in the YEAR OF DEATH, where cover was genuinely needed for the months
     * they were alive and the return is still joint, and drops them from the
     * year after. Reusing it means the two can never disagree.
     */
    let acaMonths = 0;
    for (const i of taxPeopleByYear[yi]) {
      acaMonths = Math.max(
        acaMonths,
        Math.max(0, 12 - employerMonths - medicareMonthsByPersonYear[i][yi]),
      );
    }
    acaMonthsByYear[yi] = acaMonths;
    // The age curve tracks the household the quote was written for. Once only
    // the survivor is left it tracks THAT person's age instead — identical for
    // same-age spouses, and right rather than lucky for any other pairing.
    const ageSubject =
      death !== null && startYear + yi > death.year
        ? profile.people[death.survivorIndex]
        : profile.people[0];
    const age = startYear + yi - ageSubject.birthYear;
    acaAgeFactorByYear[yi] = ageCurveFactor(aca.ageCurve, age) / quoteFactorFor(ageSubject);
    // Employer coverage runs only while someone works, prorated by worked
    // months; the investing stream is paid for the SAME months — it stops at
    // retirement, the app's standing rule.
    const retiredMonths = 12 - employerMonths;
    premiumShareRealByYear[yi] = profile.health.employerPremiumShareMonthly * employerMonths;
    investingRealByYear[yi] = profile.expenses.investingMonthly * employerMonths;
    retirementIncomeRealByYear[yi] =
      retirementIncomeMonthly !== undefined && retiredMonths > 0
        ? retirementIncomeMonthly * retiredMonths
        : 0;
  }

  // --- Survivor schedules ---------------------------------------------------
  // All of these are exactly the no-op value in a run with no death, and the
  // yearly loop applies them unconditionally. A multiplier of 1 and an addend
  // of 0 are the cheapest possible way to guarantee the property that matters
  // most here: nothing about a plan without a death may change.
  const livingFactorByYear: number[] = new Array(horizonYears).fill(1);
  const acaBenchmarkFactorByYear: number[] = new Array(horizonYears).fill(1);
  const lifeInsuranceBenefitByYear: number[] = new Array(horizonYears).fill(0);
  const ssLumpSumByYear: number[] = new Array(horizonYears).fill(0);
  if (death !== null) {
    // The survivor's share of the household the ACA quote covers. Applied from
    // the year AFTER the death, in step with the filing status — the death
    // year is a joint return on which both were covered for most of the year.
    const survivorShare = 1 / Math.max(1, profile.people.length);
    const sl = death.survivorLiving;
    /*
     * Weights for a year that is part worked and part retired: the very
     * baselines simulate.ts blends, so the factor below is exact rather than
     * approximately right. Post-override on purpose — these are the engine's
     * actual operands, unlike the fractions' denominators (see
     * resolveSurvivorLiving for why those are the budget's own).
     */
    const coupleWorking = profile.expenses.livingMonthly;
    const coupleRetired = profile.expenses.livingMonthlyRetired ?? coupleWorking;
    /**
     * The survivor's share of the couple's living costs IN THIS YEAR.
     *
     * One number unless per-line amounts are in play, in which case the two
     * states have different answers and the year is whatever mixture of them
     * its worked months make it. The `===` guard is not an optimization: it
     * keeps every other profile on the literal scalar, so not one float in a
     * run without lines moves.
     */
    const fractionFor = (yi: number): number => {
      if (sl.working === sl.retired) return sl.retired;
      const w = employerMonthsByYear[yi];
      if (w === 0) return sl.retired;
      if (w === 12) return sl.working;
      const r = 12 - w;
      const couple = coupleWorking * w + coupleRetired * r;
      if (couple <= 0) return sl.retired;
      return (sl.working * coupleWorking * w + sl.retired * coupleRetired * r) / couple;
    };
    for (let yi = 0; yi < horizonYears; yi++) {
      const year = startYear + yi;
      if (year < death.year) continue;
      if (year === death.year) {
        // Living costs fall in the MONTH of death, not at the year boundary:
        // consumption is a per-month flow and does not wait for a tax year.
        const before = death.ym.month - 1;
        const after = 12 - before;
        livingFactorByYear[yi] = (before + after * fractionFor(yi)) / 12;
        lifeInsuranceBenefitByYear[yi] = death.lifeInsuranceBenefit;
        ssLumpSumByYear[yi] = death.lumpSumDeathPayment;
      } else {
        livingFactorByYear[yi] = fractionFor(yi);
        acaBenchmarkFactorByYear[yi] = survivorShare;
      }
    }
  }

  /*
   * Life-insurance premiums: each policy's own monthly cost times its own
   * covered months, summed. A policy expiring mid-year is therefore prorated by
   * the month loop for free — the same way the pre-existing code prorated the
   * single premium at retirement — so the year a mid-year term expires
   * carries six months of it, not twelve and not none.
   */
  const lifeInsurancePremiumRealByYear: number[] = new Array(horizonYears).fill(0);
  for (const p of policies) {
    if (p.premiumMonthly <= 0) continue;
    const insuredDeath = deathByIndex(p.insuredIndex);
    for (let yi = 0; yi < horizonYears; yi++) {
      const year = startYear + yi;
      let months = 0;
      for (let m = 1; m <= 12; m++) {
        const abs = year * 12 + (m - 1);
        // The policy ends when the insured does — the premium is not paid for
        // the month of death or after, and from here the benefit takes over.
        if (insuredDeath !== null && abs >= absMonth(insuredDeath)) break;
        if (policyInForce(p, abs, employerMonthsByYear)) months++;
      }
      lifeInsurancePremiumRealByYear[yi] += p.premiumMonthly * months;
    }
  }

  return {
    people,
    death,
    filingByYear,
    taxPeopleByYear,
    livingFactorByYear,
    acaBenchmarkFactorByYear,
    lifeInsurancePremiumRealByYear,
    lifeInsuranceBenefitByYear,
    ssLumpSumByYear,
    wagesNetByYear,
    wagesGrossByYear,
    contribByYear,
    ssGrossRealByYear,
    employerMonthsByYear,
    premiumShareRealByYear,
    investingRealByYear,
    retirementIncomeRealByYear,
    acaMonthsByYear,
    acaAgeFactorByYear,
    medicareMonthsByPersonYear,
  };
}

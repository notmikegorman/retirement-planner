/**
 * Pure data-shaping for the WIDOW SCORE view. No React, no IO.
 *
 * THE QUESTION THIS ANSWERS: "if I retire next year with a 95% score but die
 * the year after that, and my spouse is left with a 64% score, that is not
 * good." One number cannot answer it, because the answer moves with two
 * decisions — when the earner stops working, and whether a term policy is still
 * in force — and the whole point is to read the trade off the screen. So the view
 * is a CURVE: the survivor's probability of success against the year of death,
 * with the household's own score drawn across it as a reference.
 *
 * NOTHING HERE COMPUTES A SURVIVOR. A widow score is a normal simulation of a
 * plan that happens to contain a `death` event; the engine's `widow_score`
 * solver runs one per candidate year and reports the same success metric. This
 * module only decides which years to probe, builds the counterfactual plan the
 * comparison needs, and turns points into rows and sentences.
 *
 * (Unit tests: tests/ui/widowData.test.ts.)
 */
import type {
  ProfileExpenses,
  AssumptionOverrides,
  HousingPlan,
  LifeInsurancePolicyPlan,
  Person,
  Profile,
  Scenario,
  SolverPoint,
  SolverResult,
  SolverSpec,
  YearMonth,
} from '../../../shared/types';
import { deriveExpenseStreams, survivorLivingMonthly } from '../../../shared/expenses';
import { formatPct, formatUSD, parseYearMonth } from '../../../shared/util';
// The engine's own purchase date and downsize-delay default, not lookalikes —
// safe for the bundle: engine/housingPlan imports nothing beyond src/shared
// (HousingCard already pulls it in), unlike engine/solvers, which would drag
// the whole simulation engine into the client chunk.
import { DEFAULT_SURVIVOR_DOWNSIZE_DELAY_MONTHS, purchaseDate } from '../../../engine/housingPlan';
import { coverageBands, householdWorkStopMonth } from '../workbench/workbenchLogic';

/**
 * First year worth probing. A death THIS year is both legitimate and the most
 * alarming probe on the curve — it is the one year in which nothing has been
 * accumulated, nothing has been de-risked, and the salary that was going to
 * fund the next decade never arrives — so the sweep starts here rather than at
 * some comfortable distance.
 */
export const WIDOW_FIRST_YEAR = 2026;

/** How many years past the first the default sweep reaches. */
export const WIDOW_SPAN_YEARS = 24;

/**
 * Years between probes, by default.
 *
 * A widow curve is smooth: the survivor's odds drift with the portfolio and
 * with their own claiming, and the ONE thing on it that is a genuine cliff — the
 * month term coverage lapses — is a date the user already knows. So every
 * other year shows the same shape for half the simulations, and the step is
 * editable for anyone who wants the intervening ones.
 */
export const WIDOW_DEFAULT_STEP = 2;

/** Hard ceiling on probes per sweep, so a step of 1 over a long range can't melt the tab. */
export const WIDOW_MAX_POINTS = 40;

// ---------------------------------------------------------------------------
// Who dies, and who survives
// ---------------------------------------------------------------------------

/**
 * The person a widow score is about by default: the first who draws a salary.
 *
 * This mirrors engine/solvers.ts exactly — the earner's death is the one that takes a
 * paycheck, the larger Social Security record and (usually) the insurance with
 * it. The UI resolves it explicitly rather than leaving `person` absent so the
 * screen can NAME them; an unnamed "if someone dies" in a view about one household's
 * mortality is a worse kind of vague than usual.
 */
export function defaultDeceased(profile: Pick<Profile, 'people' | 'income'>): string | null {
  const earner = profile.people.find((p) => (profile.income.salaries[p.id] ?? 0) > 0);
  return (earner ?? profile.people[0])?.id ?? null;
}

/** The other person — the survivor the score is about. Null in a one-person profile. */
export function survivorOf(people: readonly Person[], deceasedId: string): Person | null {
  return people.find((p) => p.id !== deceasedId) ?? null;
}

/**
 * The month the sweep's death events land in.
 *
 * Mid-year, matching engine/solvers.ts `scenarioWithDeath`. It matters for the
 * age column: a July death makes the survivor's age in that year their age as of
 * July, not as of January.
 */
export const WIDOW_DEATH_MONTH = 7;

/** How old `person` is when a sweep death lands in `year`. */
export function ageInSweepYear(person: Person, year: number): number {
  const hadBirthday = person.birthMonth <= WIDOW_DEATH_MONTH;
  return year - person.birthYear - (hadBirthday ? 0 : 1);
}

// ---------------------------------------------------------------------------
// The sweep
// ---------------------------------------------------------------------------

export interface WidowSweepFields {
  /** Person id of the deceased. */
  person: string;
  from: number;
  to: number;
  step: number;
  /**
   * Survivor's share of the couple's living baseline, or undefined to inherit
   * DEFAULT_SURVIVOR_LIVING_FRACTION from the engine. Undefined is not the same
   * as 0.75: writing the default down would turn an inherited assumption into a
   * stated one.
   */
  livingFraction: number | undefined;
}

export function defaultWidowFields(
  profile: Pick<Profile, 'people' | 'income'>,
): WidowSweepFields {
  return {
    person: defaultDeceased(profile) ?? '',
    from: WIDOW_FIRST_YEAR,
    to: WIDOW_FIRST_YEAR + WIDOW_SPAN_YEARS,
    step: WIDOW_DEFAULT_STEP,
    livingFraction: undefined,
  };
}

/** How many full simulations a set of fields implies (one per probe). */
export function widowPointCount(f: WidowSweepFields): number {
  if (f.to < f.from || f.step <= 0) return 0;
  return Math.floor((f.to - f.from) / f.step) + 1;
}

/** Inline validity message for the controls; null when the sweep is runnable. */
export function widowFieldError(f: WidowSweepFields): string | null {
  if (!f.person) return 'Choose whose death to model.';
  if (!Number.isInteger(f.from) || !Number.isInteger(f.to)) return 'Years must be whole numbers.';
  if (f.to < f.from) return 'The last year must not come before the first.';
  if (!Number.isInteger(f.step) || f.step < 1 || f.step > 10) {
    return 'The step must be a whole number of years, 1 to 10.';
  }
  if (
    f.livingFraction !== undefined &&
    (!Number.isFinite(f.livingFraction) || f.livingFraction < 0 || f.livingFraction > 1)
  ) {
    return 'The survivor’s living share must be between 0 and 1 (0.75 = 75%).';
  }
  const n = widowPointCount(f);
  if (n > WIDOW_MAX_POINTS) {
    return `That is ${n} full simulations — widen the step or shorten the range (max ${WIDOW_MAX_POINTS}).`;
  }
  return null;
}

export function widowSpec(
  f: WidowSweepFields,
  expenses?: ProfileExpenses,
): Extract<SolverSpec, { type: 'widow_score' }> {
  /*
   * AN ITEMISED BUDGET MAKES THIS FIELD A TRAP, so it is dropped outright.
   *
   * The engine's precedence is event livingFraction > per-line survivor
   * amounts > the 0.75 default. When the profile carries an If-I-die column,
   * a fraction lingering here — typed once months ago, restored from the tab's
   * saved session — silently overrides every number the user keyed into that
   * column, and nothing on screen says so. The card renders the derived share
   * read-only in that case, so the only honest spec is one that carries no
   * fraction at all; a stored value from before the budget existed is stale
   * state, not a decision.
   */
  const itemised = expenses !== undefined && survivorLivingMonthly(expenses, true) !== null;
  return {
    type: 'widow_score',
    person: f.person,
    from: f.from,
    to: f.to,
    step: f.step,
    ...(!itemised && f.livingFraction !== undefined ? { livingFraction: f.livingFraction } : {}),
  };
}

/**
 * The survivor's living spend as the budget states it, for the read-only
 * display: dollars, and the share of the couple's own figure. Null when the
 * profile has no itemised budget — the editable fraction stays in charge there.
 * Retired-state figures on both sides, because every probe year the sweep can
 * model is at or after the death of a retiree-to-be; for this household the
 * working and retired figures coincide anyway.
 */
export function survivorShareFromBudget(
  expenses: ProfileExpenses,
): { survivorMonthly: number; coupleMonthly: number; share: number } | null {
  const survivorMonthly = survivorLivingMonthly(expenses, true);
  if (survivorMonthly === null) return null;
  const d = deriveExpenseStreams(expenses);
  const coupleMonthly = d.livingMonthlyRetired ?? d.livingMonthly;
  if (coupleMonthly <= 0) return null;
  return { survivorMonthly, coupleMonthly, share: survivorMonthly / coupleMonthly };
}

// ---------------------------------------------------------------------------
// The life-insurance policy, and the plan without it
// ---------------------------------------------------------------------------

export interface EffectivePolicy {
  /** Premium the run will actually charge, $/month in today's dollars. */
  premiumMonthly: number;
  /** Face amount the run will actually pay, in NOMINAL dollars (level term does not inflate). */
  benefit: number;
  /** Last month of coverage; undefined means coverage ends with the paycheck. */
  termEnd: YearMonth | undefined;
  /** Whose life it covers; undefined means the first person drawing a salary. */
  insured: string | undefined;
  /** Where the benefit figure came from, so the screen can say which file to edit. */
  benefitSource: 'plan' | 'profile' | 'none';
  /**
   * The display suffix after the benefit amount — " to 2034-12", ", ending
   * with the paycheck", or "" when no single date is true of the cover (a
   * policy LIST whose bands end at different months). Computed here rather
   * than in the card so the one place that knows WHICH policies contribute is
   * the one that decides what may be claimed about their term.
   */
  termText: string;
}

/**
 * The cover THIS RUN uses: for a profile on the legacy single-policy fields,
 * the plan's override where it has one, else the profile's — the same
 * precedence the engine applies. For a profile carrying a POLICY LIST, the
 * list with the plan's per-policy dispositions applied
 * (assumption_overrides.expenses.lifeInsurancePolicyPlans), because the legacy
 * fields are superseded entirely (engine resolvePolicies) — reading only them
 * told this card "benefit is 0" while the plan carried $3,500,000 of
 * cover, which disabled the drop-the-policy comparison and rendered a false
 * "no payout is in force" note under it.
 *
 * `benefit` for a list is the LARGEST payout a single death can collect: the
 * peak coverage band on one insured life (coverageBands — the same arithmetic
 * the Spending card's caption states). Summing across insureds would claim a
 * A $2.5M-on-one plus $1M-on-the-other household pays $3.5M, and only one of them can be
 * the one who died; summing face amounts on one life would overstate policies
 * whose terms do not overlap.
 */
export function effectivePolicy(
  profile: Pick<Profile, 'expenses' | 'income'>,
  plan: Pick<Scenario, 'assumption_overrides' | 'events'>,
): EffectivePolicy {
  const o = plan.assumption_overrides?.expenses;
  const p = profile.expenses;
  const policies = p.lifeInsurancePolicies ?? [];
  if (policies.length > 0) {
    const plans = o?.lifeInsurancePolicyPlans;
    const stopMonth = householdWorkStopMonth(plan.events ?? [], profile.income.salaries);
    const hasEarner = Object.values(profile.income.salaries).some((s) => s > 0);
    // The premium is the whole household's: every policy still charged is a
    // drag the drop-everything counterfactual removes, whoever it insures.
    const premiumMonthly = policies.reduce(
      (sum, pol) => sum + (plans?.[pol.id] === 'cancel_now' ? 0 : pol.premiumMonthly),
      0,
    );
    // Bands per insured life; the benefit is the best single death's peak.
    let benefit = 0;
    let bestBands: ReturnType<typeof coverageBands> = [];
    for (const insured of new Set(policies.map((pol) => pol.insured))) {
      const bands = coverageBands(
        policies.filter((pol) => pol.insured === insured),
        plans,
        stopMonth,
        hasEarner,
      );
      const peak = bands.reduce((max, b) => Math.max(max, b.benefit), 0);
      if (peak > benefit) {
        benefit = peak;
        bestBands = bands;
      }
    }
    // One band = one honest date. Several bands end at different months, and
    // "$3,500,000 to 2034-12" about cover that is $2.5M by then is the exact
    // overclaim the banded Spending caption exists to avoid — so say nothing.
    const to = bestBands.length === 1 ? bestBands[0].to : null;
    return {
      premiumMonthly,
      benefit,
      termEnd: to ?? undefined,
      insured: undefined,
      benefitSource: benefit > 0 ? 'profile' : 'none',
      termText: bestBands.length === 1 && to !== null ? ` to ${to}` : '',
    };
  }
  const benefit = o?.lifeInsuranceDeathBenefit ?? p.lifeInsuranceDeathBenefit ?? 0;
  const benefitSource =
    o?.lifeInsuranceDeathBenefit !== undefined
      ? 'plan'
      : p.lifeInsuranceDeathBenefit !== undefined
        ? 'profile'
        : 'none';
  const termEnd = o?.lifeInsuranceTermEnd ?? p.lifeInsuranceTermEnd;
  return {
    premiumMonthly: o?.lifeInsuranceMonthly ?? p.lifeInsuranceMonthly ?? 0,
    benefit,
    termEnd,
    insured: o?.lifeInsuranceInsured ?? p.lifeInsuranceInsured,
    benefitSource: benefit > 0 ? benefitSource : 'none',
    termText: termEnd !== undefined ? ` to ${termEnd}` : ', ending with the paycheck',
  };
}

/**
 * The same plan with the life cover DROPPED — no benefit and no premium.
 *
 * Both halves, deliberately. The decision the user is weighing is not "what if
 * the payout vanished but I kept paying for it"; it is "keep the policy or
 * drop it", and dropping it stops the premium as surely as it stops the payout.
 * Zeroing only the benefit would charge the counterfactual for cover it does
 * not have and quietly understate what the policy costs.
 *
 * Expressed as an assumption override rather than a profile edit, because an
 * override always outranks the profile — including for a plan that already
 * carries one of its own.
 *
 * `policyIds` are the profile's listed policies, every one of which is set to
 * 'cancel_now' — the zeroed legacy fields cannot reach a listed policy (the
 * list supersedes them in the engine), which is precisely how this comparison
 * used to run twenty-six simulations and change nothing for a list profile.
 * Any dispositions the plan already carries are REPLACED, not merged: this
 * counterfactual is "no cover at all", including cover the plan was keeping.
 */
export function planWithoutPolicy(plan: Scenario, policyIds: readonly string[] = []): Scenario {
  const overrides: AssumptionOverrides = { ...plan.assumption_overrides };
  overrides.expenses = {
    ...overrides.expenses,
    lifeInsuranceMonthly: 0,
    lifeInsuranceDeathBenefit: 0,
    ...(policyIds.length > 0
      ? {
          lifeInsurancePolicyPlans: Object.fromEntries(
            policyIds.map((id): [string, LifeInsurancePolicyPlan] => [id, 'cancel_now']),
          ),
        }
      : {}),
  };
  return { ...plan, assumption_overrides: overrides };
}

// ---------------------------------------------------------------------------
// Points -> rows
// ---------------------------------------------------------------------------

export interface WidowRow {
  /** Year of death. */
  year: number;
  /** How old the survivor is in that year; null when there is no survivor to name. */
  survivorAge: number | null;
  /** Survivor's success rate, plan as it stands. */
  asPlanned: number;
  /** Survivor's success rate with the policy dropped; absent when not compared. */
  dropped?: number;
  /** dropped -> asPlanned, i.e. what the policy is worth in that year. */
  policyWorth?: number;
  /** The pinned sweep's score for the same year; absent when nothing is pinned. */
  pinned?: number;
  /** pinned -> asPlanned, i.e. what the plan change since pinning is worth. */
  sincePinned?: number;
}

function byYear(points: readonly SolverPoint[]): Map<number, number> {
  return new Map(points.map((p) => [p.x, p.success]));
}

/**
 * Join up to three sweeps on the year of death.
 *
 * The as-planned sweep drives the row set; the other two are looked up, so a
 * pinned sweep over a different range contributes only the years it shares and
 * never invents a row. That is what lets the pin survive a change to the range.
 */
export function widowRows(
  asPlanned: readonly SolverPoint[],
  survivor: Person | null,
  dropped?: readonly SolverPoint[],
  pinned?: readonly SolverPoint[],
): WidowRow[] {
  const droppedBy = dropped ? byYear(dropped) : null;
  const pinnedBy = pinned ? byYear(pinned) : null;
  return asPlanned.map((p) => {
    const row: WidowRow = {
      year: p.x,
      survivorAge: survivor ? ageInSweepYear(survivor, p.x) : null,
      asPlanned: p.success,
    };
    const d = droppedBy?.get(p.x);
    if (d !== undefined) {
      row.dropped = d;
      row.policyWorth = p.success - d;
    }
    const q = pinnedBy?.get(p.x);
    if (q !== undefined) {
      row.pinned = q;
      row.sincePinned = p.success - q;
    }
    return row;
  });
}

/** The weakest year on a sweep — the one the plan is actually betting on. */
export function weakestPoint(points: readonly SolverPoint[]): SolverPoint | null {
  let worst: SolverPoint | null = null;
  for (const p of points) if (worst === null || p.success < worst.success) worst = p;
  return worst;
}

/**
 * The year from which the survivor is safe FOR GOOD: the earliest probed year
 * such that it and every later probe clear the target. Null when the last probe
 * fails, i.e. when there is no such year.
 *
 * IT IS NOT "the first year that passes", which is the tempting version and is
 * wrong, because a widow curve is not monotonic. On a representative plan the
 * first passing year is the FIRST year on the chart — a death in 2026 leaves
 * them at 99.5%, because a term policy pays out — and every year from 2034 on
 * fails once the cover lapses. "Reaches your target in 2026 or later" is a true
 * sentence about that curve and a completely false impression: it describes a
 * plan that is safe from here on, when the truth is the opposite. Scanning
 * BACKWARDS from the end is what makes the claim mean what it says.
 */
export function clearsTargetFromYear(
  points: readonly SolverPoint[],
  target: number,
): number | null {
  let from: number | null = null;
  for (let i = points.length - 1; i >= 0; i--) {
    if (points[i].success < target) break;
    from = points[i].x;
  }
  return from;
}

/** How many probed years fall short of the target. */
export function yearsBelowTarget(points: readonly SolverPoint[], target: number): number {
  return points.filter((p) => p.success < target).length;
}

// ---------------------------------------------------------------------------
// Sentences
// ---------------------------------------------------------------------------

/**
 * The headline: the gap, where it is worst, and when it closes.
 *
 * Written as the answer to the user's question rather than as a description of
 * a sweep — "95% household, 64% survivor" is the comparison, and the number that
 * matters is the difference between the two.
 */
export function widowHeadline(
  points: readonly SolverPoint[],
  household: number,
  target: number,
  survivorName: string,
): string {
  const worst = weakestPoint(points);
  if (!worst) return 'That sweep produced no results.';
  // Stated as a MAGNITUDE. "a gap of +14.5 pts" reads as the survivor being ahead by
  // fourteen points, which is the exact opposite of what the number means; the
  // word "below" carries the direction, so the sign must not also try to.
  const gap = Math.abs(household - worst.success) * 100;
  const lead =
    `This plan works in ${formatPct(household, 1)} of futures with both of you alive. ` +
    `Its weakest year for ${survivorName} is a death in ${worst.x}, which leaves them at ` +
    `${formatPct(worst.success, 1)} — ${gap.toFixed(1)} points below the household.`;

  const targetPct = formatPct(target, 0);
  const below = yearsBelowTarget(points, target);
  if (below === 0) return `${lead} They clear your ${targetPct} target in every year tried.`;
  if (below === points.length) {
    return `${lead} No year in the range gets them to your ${targetPct} target.`;
  }
  const safeFrom = clearsTargetFromYear(points, target);
  if (safeFrom !== null) {
    return (
      `${lead} They are above your ${targetPct} target for a death in ${safeFrom} or later, and ` +
      'below it before that.'
    );
  }
  const last = points[points.length - 1];
  return (
    `${lead} They clear your ${targetPct} target in ${points.length - below} of the ` +
    `${points.length} years tried, but NOT in the later ones — by ${last.x} they are at ` +
    `${formatPct(last.success, 1)}.`
  );
}

/**
 * What the policy buys, as a sentence.
 *
 * THE PART THAT IS EASY TO GET WRONG: after the term lapses the policy is not
 * worth ZERO, it is worth LESS than zero. Every premium paid up to that point
 * came out of the same portfolio the survivor now lives on, and no payout ever
 * arrives to offset it — so the with-cover line sits BELOW the without-cover
 * one for the rest of the chart. That is a real finding and the honest reading
 * of "should I keep paying for this?", so the sentence names it rather than
 * rounding it off to "no longer helps".
 */
export function policyVerdict(
  rows: readonly WidowRow[],
  policy: EffectivePolicy,
): string | null {
  const compared = rows.filter((r) => r.policyWorth !== undefined);
  if (compared.length === 0) return null;
  let best: WidowRow | null = null;
  for (const r of compared) {
    if (best === null || (r.policyWorth ?? 0) > (best.policyWorth ?? 0)) best = r;
  }
  const worth = best?.policyWorth ?? 0;
  const cover = formatUSD(policy.benefit);
  if (worth < 0.005) {
    return (
      `${cover} of cover never gains them half a point in any year tried — on these numbers the ` +
      'premium is buying protection the plan does not need, and paying for it makes both ' +
      'scores slightly worse.'
    );
  }
  // The first year the cover has stopped paying its way, AFTER the year it was
  // most valuable — a curve that dips early and recovers is not a lapse.
  const afterBest = compared.filter((r) => r.year > (best?.year ?? 0));
  const lapsed = afterBest.find((r) => (r.policyWorth ?? 0) <= 0.005) ?? null;
  const head =
    `${cover} of cover is worth up to ${formatPoints(worth)} of widow score — most for a ` +
    `death in ${best?.year}, the year they would have the longest to live on it.`;
  if (lapsed === null) return head;
  const cost = lapsed.policyWorth ?? 0;
  const tail =
    cost < -0.005
      ? ` From ${lapsed.year} it is worth ${formatPoints(cost)}: the cover has run out, but the ` +
        'premiums paid for it have not come back, so they are measurably worse off than if the ' +
        'policy had never been bought.'
      : ` From ${lapsed.year} it is worth nothing — the cover has run out.`;
  return head + tail;
}

/** "+12.8 pts" / "-0.4 pts" — a success DIFFERENCE, never a percentage of a percentage. */
export function formatPoints(delta: number): string {
  const pts = delta * 100;
  const sign = pts > 0 ? '+' : pts < 0 ? '−' : '';
  return `${sign}${Math.abs(pts).toFixed(1)} pts`;
}

/**
 * What the survivor is modelled doing about the HOUSE, when the sweep probes
 * death years before the plan's purchase month — or null when there is
 * nothing to say.
 *
 * THE NUMBER AND ITS ASSUMPTION MUST TRAVEL TOGETHER. A user learned this
 * the hard way: a 62.7% widow score that was really "62.7% if the survivor
 * executes a $1.2M purchase without the deceased's last two salary years", an
 * assumption nothing on screen stated and no survivor would act out. So when the plan names a
 * `survivorPurchasePrice`, the copy SAYS the pre-purchase probes bought at
 * that price (or at the proceeds); when it does not, a muted note says the survivor is
 * modelled executing the plan price — the honest caveat — and where to change
 * it.
 *
 * Null when: the move is not plan-modelled (hand-written events carry no
 * survivor field to speak about), the plan buys nothing, no probed death year
 * precedes the purchase, or the plan price is ALREADY 'sale_proceeds' with no
 * survivor field — executing a proceeds-priced purchase is exactly what a
 * survivor would do, so there is no misleading assumption to caveat.
 *
 * Probes land in WIDOW_DEATH_MONTH (July), so "precedes the purchase" is the
 * engine's own strictly-before rule applied to that month — the same
 * comparison survivorHousingPlan makes, or the copy would claim a switch the
 * run did not perform.
 */
export function survivorHousingNote(
  housing: HousingPlan | undefined,
  probedYears: readonly number[],
  survivorName: string,
): string | null {
  if (!housing) return null;
  if (housing.purchasePrice === 'none' || housing.purchasePrice === 0) return null;
  let buyYm: YearMonth;
  let buyAbs: number;
  try {
    buyYm = purchaseDate(housing);
    const b = parseYearMonth(buyYm);
    buyAbs = b.year * 12 + (b.month - 1);
  } catch {
    return null; // a half-typed sell date must not blank the whole results pane
  }
  const preYears = probedYears.filter((y) => y * 12 + (WIDOW_DEATH_MONTH - 1) < buyAbs);
  if (preYears.length === 0) return null;

  const range =
    preYears.length === 1 ? `the ${preYears[0]} probe` : `the ${preYears[0]}–${preYears[preYears.length - 1]} probes`;
  const sp = housing.survivorPurchasePrice;
  if (sp !== undefined) {
    const buys =
      sp === 'sale_proceeds'
        ? 'buying with whatever the sale nets'
        : `buying at ${formatUSD(sp)}`;
    const planText =
      typeof housing.purchasePrice === 'number'
        ? `${formatUSD(housing.purchasePrice)} purchase`
        : 'proceeds-priced purchase';
    return (
      `For a death before the purchase (${buyYm}) — ${range} — ${survivorName} is modelled ` +
      `${buys}, the survivor price this plan states, rather than executing the plan's ${planText}.`
    );
  }
  if (housing.purchasePrice === 'sale_proceeds') return null;
  return (
    `For a death before the purchase (${buyYm}) — ${range} — ${survivorName} is modelled ` +
    `executing the plan's ${formatUSD(housing.purchasePrice)} purchase exactly as written, ` +
    'because no survivor price is set. If they would buy something smaller on their own, say so ' +
    'on the Housing card (“If one of us dies before the purchase”) — these scores are only as ' +
    'honest as that assumption.'
  );
}

/**
 * What the survivor is modelled doing about the HOUSE for probes AT OR AFTER
 * the purchase month — the post-purchase companion of `survivorHousingNote`,
 * and the same contract: THE NUMBER AND ITS ASSUMPTION MUST TRAVEL TOGETHER,
 * in both directions. When the plan names a `survivorDownsizeTo`, the copy
 * says the post-purchase probes sold after the stated delay and rebought at
 * that price (or rented from then on); when it does not, a muted note says
 * the survivor is modelled KEEPING the just-bought house for good — the honest caveat,
 * because staying put is an assumption exactly as much as downsizing is —
 * and where to change it.
 *
 * Null when: the move is not plan-modelled, the plan buys nothing (a
 * rent-forever plan leaves the survivor nothing to downsize), or no probed
 * death year lands at/after the purchase month. The at-or-after comparison is
 * the engine's own boundary (survivorDownsizeEvents), applied to the probes'
 * WIDOW_DEATH_MONTH — the partition survivorHousingNote's strictly-before
 * rule leaves on the other side.
 */
export function survivorDownsizeNote(
  housing: HousingPlan | undefined,
  probedYears: readonly number[],
  survivorName: string,
): string | null {
  if (!housing) return null;
  if (housing.purchasePrice === 'none' || housing.purchasePrice === 0) return null;
  let buyYm: YearMonth;
  let buyAbs: number;
  try {
    buyYm = purchaseDate(housing);
    const b = parseYearMonth(buyYm);
    buyAbs = b.year * 12 + (b.month - 1);
  } catch {
    return null; // a half-typed sell date must not blank the whole results pane
  }
  const postYears = probedYears.filter((y) => y * 12 + (WIDOW_DEATH_MONTH - 1) >= buyAbs);
  if (postYears.length === 0) return null;

  const range =
    postYears.length === 1
      ? `the ${postYears[0]} probe`
      : `the ${postYears[0]}–${postYears[postYears.length - 1]} probes`;
  const dt = housing.survivorDownsizeTo;
  if (dt !== undefined) {
    const delay = housing.survivorDownsizeDelayMonths ?? DEFAULT_SURVIVOR_DOWNSIZE_DELAY_MONTHS;
    const when =
      delay === 0
        ? 'in the death month'
        : delay === 12
          ? 'a year after the death'
          : `${delay} months after the death`;
    const then =
      dt === 'none'
        ? 'renting from then on'
        : `rebuying at ${formatUSD(dt)}`;
    return (
      `For a death once the house is bought (${buyYm}) — ${range} — ${survivorName} is ` +
      `modelled selling it ${when} and ${then}, the downsize this plan states; selling costs ` +
      'come out of the proceeds like any other sale.'
    );
  }
  return (
    `For a death once the house is bought (${buyYm}) — ${range} — ${survivorName} is ` +
    'modelled KEEPING it for good, because no downsize is set. Staying put is an assumption ' +
    'too: if they would sell and buy something smaller, say so on the Housing card (“If one of ' +
    'us dies after the purchase”) — these scores are only as honest as that assumption.'
  );
}

/**
 * The `solverOutput` of a finished widow run, or null if the run somehow came
 * back without one. Narrowing here keeps the component from re-testing the
 * spec type at three different call sites.
 */
export function widowOutput(out: SolverResult | undefined): SolverResult | null {
  return out && out.spec.type === 'widow_score' ? out : null;
}

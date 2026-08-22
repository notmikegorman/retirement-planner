/**
 * THE ITEMISED BUDGET, REDUCED TO THE NUMBERS THE ENGINE ALREADY CONSUMES.
 *
 * The engine has never seen a budget line and does not need to: it runs on
 * three monthly streams while a salary is coming in and two more once it stops.
 * This module is the entire bridge between the two representations, so the UI,
 * the engine and the transcription script cannot each invent their own answer
 * to "what does this budget cost".
 *
 * TWO RULES CARRY ALL THE WEIGHT.
 *
 * ONLY `SUMMED_EXPENSE_CATEGORIES` CONTRIBUTE. 'insurance',
 * 'modeled_elsewhere' and 'excluded' exist so the transcribed budget
 * reconciles line-for-line against the real one, and they must never reach a
 * stream: $820/mo of housing once sat inside the living baseline while the
 * engine ALSO modeled property tax and insurance from the housing plan,
 * double-charging it for thirty years and costing 7.8 points of success rate
 * before anyone noticed. The type exists to make that unrepeatable; this file
 * is where the type has to be believed.
 *
 * ABSENT IS NOT ZERO. A blank retired cell means "the same as today", a blank
 * survivor cell means "the same as whichever state is in force" — see
 * `effectiveLineMonthly`, the one place either fallback is written down. Read
 * as zeroes those blanks would delete most of a household's spending, and the
 * plan would come back at 100% success for a household that had stopped
 * eating.
 */

import type { ExpenseLine, ExpenseLineCategory, ProfileExpenses } from './types';
import { SUMMED_EXPENSE_CATEGORIES } from './types';

/**
 * Which of the household's states a figure is wanted for. Both flags, not one
 * three-valued enum, because they are genuinely independent: a death can
 * happen while somebody is still working, and that year's survivor spends the
 * survivor figure against the WORKING baseline.
 */
export interface ExpenseState {
  /** True once NOBODY in the household earns a salary. */
  retired: boolean;
  /** True once only one of the two is alive. */
  survivor: boolean;
  /**
   * True for a month the household is BETWEEN HOMES — sold, renting, purchase
   * pending (the scenario housing plan's window, not profile data). OPTIONAL
   * so every existing caller keeps its exact meaning: absent is false.
   */
  renting?: boolean;
}

/**
 * What one line actually costs in a given state — the single definition of
 * what a blank cell means, exported so the UI's placeholder text and the
 * engine's arithmetic can never disagree about it.
 *
 * The chain is survivor -> retired -> now, and it is a chain rather than two
 * independent lookups on purpose: a survivor cell left blank in a RETIRED year
 * inherits the retired figure, not the working one. Filling the retired column
 * and leaving survivor blank otherwise silently walked the widow's spending
 * back up to the couple's working baseline.
 *
 * THE RENTING COLUMN sits BELOW the survivor in that chain — a survivor month
 * never reads it, not even as an inherited fallback. The renting figure
 * describes the COUPLE's between-homes interlude; the survivor column is the
 * more deliberate, person-specific number, and the engine's rule is that after
 * a death the survivor column governs outright (see the blend site in
 * simulate.ts). For a non-survivor month it overrides whichever working/retired
 * figure is in force, and a blank cell inherits exactly that figure.
 */
export function effectiveLineMonthly(line: ExpenseLine, state: ExpenseState): number {
  const inForce = state.retired ? (line.monthlyRetired ?? line.monthlyNow) : line.monthlyNow;
  if (state.survivor) return line.monthlySurvivor ?? inForce;
  return state.renting === true ? (line.monthlyRenting ?? inForce) : inForce;
}

type SummedCategory = (typeof SUMMED_EXPENSE_CATEGORIES)[number];

const SUMMED: ReadonlySet<ExpenseLineCategory> = new Set(SUMMED_EXPENSE_CATEGORIES);

function isSummed(category: ExpenseLineCategory): category is SummedCategory {
  return SUMMED.has(category);
}

/**
 * Per-stream totals for one state. Lines are added in array order so two calls
 * that ought to agree agree to the last bit — float addition is not
 * associative, and these figures end up inside a success rate compared against
 * a target.
 */
function totalsFor(
  lines: readonly ExpenseLine[],
  state: ExpenseState,
): Record<SummedCategory, number> {
  /*
   * The literal IS the exhaustiveness check: a fourth category added to
   * SUMMED_EXPENSE_CATEGORIES stops compiling here rather than quietly
   * summing into nothing. And the `isSummed` guard below is the double-count
   * fix in code — everything else on the budget is display-only.
   */
  const totals: Record<SummedCategory, number> = { living: 0, charitable: 0, investing: 0 };
  for (const line of lines) {
    if (!isSummed(line.category)) continue;
    totals[line.category] += effectiveLineMonthly(line, state);
  }
  return totals;
}

/**
 * The five scalar streams `ProfileExpenses` declares, with each field keeping
 * the meaning it has there — INCLUDING the two whose absence is meaningful.
 */
export interface DerivedExpenseStreams {
  livingMonthly: number;
  charitableMonthly: number;
  investingMonthly: number;
  /** undefined keeps ProfileExpenses' meaning: the same as `livingMonthly`. */
  livingMonthlyRetired: number | undefined;
  /** undefined keeps ProfileExpenses' meaning: 0. */
  investingMonthlyRetired: number | undefined;
}

/**
 * The budget's streams, or the profile's own scalars when there is no budget.
 *
 * WITH NO LINES THIS IS THE IDENTITY, field for field — deliberately not
 * `{ ...expenses }`, so an absent `livingMonthlyRetired` stays absent rather
 * than becoming a number equal to `livingMonthly`. Those two are not the same
 * input: absent skips the working/retired blend in simulate.ts outright, and a
 * present-but-equal figure walks through it, where `x * (5/12) + x * (7/12)`
 * is not `x` in floating point. Every profile written before the budget
 * existed must produce BIT-IDENTICAL results, so the identity has to be exact.
 *
 * Giving has no retired column here because its retired side is a RULE
 * (`retirementGiving`), not a second number — see RetirementGivingRule.
 */
export function deriveExpenseStreams(expenses: ProfileExpenses): DerivedExpenseStreams {
  const lines = expenses.lines;
  if (lines === undefined || lines.length === 0) {
    return {
      livingMonthly: expenses.livingMonthly,
      charitableMonthly: expenses.charitableMonthly,
      investingMonthly: expenses.investingMonthly,
      livingMonthlyRetired: expenses.livingMonthlyRetired,
      investingMonthlyRetired: expenses.investingMonthlyRetired,
    };
  }
  const now = totalsFor(lines, { retired: false, survivor: false });
  const retired = totalsFor(lines, { retired: true, survivor: false });
  /*
   * A BUDGET WHOSE LIVING LINES ALL INHERIT HAS NO RETIRED FIGURE AT ALL.
   *
   * When not one living line names `monthlyRetired`, the retired total is the
   * same terms added in the same order as the working total — identical to the
   * last bit — and reporting it as `undefined` says exactly that while keeping
   * the engine on its untouched code path. Reporting the number instead would
   * be arithmetically equal and still change answers: the retirement year
   * blends the two sides by worked months, and that blend does not round-trip.
   */
  const namesRetiredLiving = lines.some(
    (l) => l.category === 'living' && l.monthlyRetired !== undefined,
  );
  return {
    livingMonthly: now.living,
    charitableMonthly: now.charitable,
    investingMonthly: now.investing,
    livingMonthlyRetired: namesRetiredLiving ? retired.living : undefined,
    /*
     * ALWAYS A NUMBER, unlike living above, because the two representations
     * genuinely disagree about a blank: the scalar's absence means 0
     * ("investing out of a paycheck ends with the paycheck") while a LINE's
     * blank retired cell means "the same as now". Where there is a budget, the
     * budget wins — a household that means to stop investing types a 0 in the
     * retired column, and sees it.
     */
    investingMonthlyRetired: retired.investing,
  };
}

/**
 * The SURVIVOR's living stream, in today's dollars, or null when the household
 * has no budget to compute it from.
 *
 * Null rather than 0 or the couple's own figure: the caller (the engine's
 * `death` event) falls back to the global `livingFraction`, which is what every
 * plan written before the budget existed relies on. A 0 would zero a widow's
 * groceries and report the result as a 100% success rate.
 *
 * Per-line is the whole point. A household with ONE car does not see its $610
 * payment fall by a quarter when one of two people dies — it does not fall at
 * all, and no single fraction of the couple's baseline can say so.
 */
export function survivorLivingMonthly(
  expenses: ProfileExpenses,
  retired: boolean,
): number | null {
  const lines = expenses.lines;
  if (lines === undefined || lines.length === 0) return null;
  return totalsFor(lines, { retired, survivor: true }).living;
}

/**
 * The LIVING stream while the household is between homes, in today's dollars —
 * one figure per working/retired state, because the fallback for a blank
 * renting cell is whichever of those is in force and the window can straddle
 * the retirement date (the user's does: sold salaried, bought retired).
 *
 * NULL unless some LIVING line actually names `monthlyRenting`: null is what
 * lets the engine skip the renting blend outright, so a budget without the
 * column — every profile written before it existed — walks the exact float
 * path it always did. LIVING LINES ONLY, by summation and not merely by
 * convention: a `monthlyRenting` hand-edited onto a giving or investing line
 * reaches no total anywhere, which is the same dead-cell rule the retired and
 * survivor columns already follow (LINE_TAB_COLUMNS).
 *
 * Lines are added in array order, matching `totalsFor`, so the renting total
 * and the base totals it is blended against agree to the last bit.
 */
export function rentingLivingMonthly(
  expenses: ProfileExpenses,
): { working: number; retired: number } | null {
  const lines = expenses.lines;
  if (lines === undefined || lines.length === 0) return null;
  if (!lines.some((l) => l.category === 'living' && l.monthlyRenting !== undefined)) return null;
  let working = 0;
  let retired = 0;
  for (const line of lines) {
    if (line.category !== 'living') continue;
    working += effectiveLineMonthly(line, { retired: false, survivor: false, renting: true });
    retired += effectiveLineMonthly(line, { retired: true, survivor: false, renting: true });
  }
  return { working, retired };
}

/**
 * Pure helpers behind the budget tabs (Expenses, Tithing, Investing — one per
 * summed category of ProfileExpenses.lines) and the Insurance tab's policy
 * list (lifeInsurancePolicies).
 *
 * Kept free of React/DOM so it can be unit-tested under vitest's node
 * environment, like profileLogic beside it. All money values are $/month in
 * TODAY'S dollars — the one exception is a policy's face amount, which is
 * nominal and says so at its own type.
 *
 * ABSENT CARRIES MEANING, and every function here exists to keep that true in
 * one place: `monthlyRetired` absent means "the same as now", `monthlySurvivor`
 * absent means "the same as whichever state is in force", and `lines` absent or
 * empty means the three scalar streams are the truth. The editor has to be able
 * to tell a chosen figure from an inherited one at every point, so nothing here
 * ever defaults an absent field into a stored number.
 */
import type {
  ExpenseLine,
  HousingPlan,
  LifeInsurancePolicy,
  Person,
  ProfileExpenses,
  ScenarioEvent,
  YearMonth,
} from '../../../shared/types';
import { SUMMED_EXPENSE_CATEGORIES } from '../../../shared/types';
import { deriveExpenseStreams, effectiveLineMonthly } from '../../../shared/expenses';
// The engine's own purchase-date derivation, so the window this tab names is
// the window the run actually prices (the HousingCard rule, applied here too).
import { purchaseDate } from '../../../engine/housingPlan';
import { monthsBetween } from '../scenarios/scenarioHelpers';
import { MONTH_NAMES } from './profileLogic';

// ---------------------------------------------------------------------------
// Categories, as tabs
// ---------------------------------------------------------------------------

/** The categories that have a tab: Expenses, Tithing, Investing — one each. */
export type SummedLineCategory = (typeof SUMMED_EXPENSE_CATEGORIES)[number];

/**
 * Which optional money columns each tab renders. THE RULE IS: a cell exists
 * only where src/shared/expenses.ts actually reads the field — a column that
 * commits a number nothing consumes is a lie in a financial tool.
 *
 * - living: `deriveExpenseStreams` reads `monthlyRetired` (the retired living
 *   stream), `rentingLivingMonthly` reads `monthlyRenting` (the between-homes
 *   stream), and `survivorLivingMonthly` reads `monthlySurvivor` (the widow's
 *   own baseline), so all three columns render.
 * - charitable: the engine reads giving lines in the WORKING state only. The
 *   retired side of giving is the Tithing RULE (`retirementGiving`), no
 *   survivor giving stream exists, and giving does not change by dwelling —
 *   so none of the three renders.
 * - investing: NO optional column since 2026-08-31 — investing stops at
 *   retirement (the app's standing rule), so a retired cell would commit a
 *   number nothing consumes; no survivor investing stream exists, and the
 *   transfer's between-homes behaviour is the ENGINE's decision (it redirects
 *   the same dollars to savings, note 24), not a per-line figure.
 *
 * There is no entry for 'insurance' / 'modeled_elsewhere' / 'excluded' because
 * there is no tab: the user deleted those lines and the import no longer
 * writes them. One hand-edited into profile.json is filtered out of every tab
 * and every total below — present in the file, invisible and inert on screen.
 */
export const LINE_TAB_COLUMNS = {
  living: { renting: true, retired: true, survivor: true },
  charitable: { renting: false, retired: false, survivor: false },
  investing: { renting: false, retired: false, survivor: false },
} as const satisfies Record<
  SummedLineCategory,
  { renting: boolean; retired: boolean; survivor: boolean }
>;

// ---------------------------------------------------------------------------
// What a blank cell means
// ---------------------------------------------------------------------------

/*
 * Both wrappers go through `effectiveLineMonthly` rather than reading the
 * optional fields themselves. That function is where shared/expenses.ts writes
 * down what a blank cell means, and the engine sums the same one — so a
 * placeholder in this editor cannot promise a number the run does not spend.
 */

/** The figure in force once nobody works: the typed one, else "same as now". */
export function retiredMonthly(line: ExpenseLine): number {
  return effectiveLineMonthly(line, { retired: true, survivor: false });
}

/**
 * The figure in force while between homes. An absent `monthlyRenting` inherits
 * whichever working/retired figure is in force, so the answer depends on
 * whether the window month falls before or after the last paycheck — the
 * owner's own window straddles exactly that line, which is why the caller has
 * to say.
 */
export function rentingMonthly(line: ExpenseLine, state: 'working' | 'retired'): number {
  return effectiveLineMonthly(line, {
    retired: state === 'retired',
    survivor: false,
    renting: true,
  });
}

/** True when a renting cell inherits two different numbers, one per state. */
export function rentingInheritanceSplits(line: ExpenseLine): boolean {
  return (
    line.monthlyRenting === undefined &&
    rentingMonthly(line, 'working') !== rentingMonthly(line, 'retired')
  );
}

/** The between-homes span the current plan implies, for the column's tooltip. */
export interface RentingWindow {
  /** Sale month — the window opens here. */
  from: YearMonth;
  /** Purchase month — the window closes the month before. */
  to: YearMonth;
  months: number;
}

/**
 * The window the renting column prices, read off the CURRENT PLAN — the same
 * sale-to-purchase span the engine derives (sold, renting, purchase pending).
 * Null when the plan implies none: no move at all, a same-month sale-and-buy,
 * or a rent-to-the-horizon plan whose 'none' purchase leaves nothing pending.
 *
 * A housing plan wins over hand-written events exactly as it does in the
 * engine (presence supersedes); with no plan the events are read the way
 * prepareSim reads them — the sale, then the first later purchase. The column
 * itself is PROFILE data and stays editable with no window in the plan; this
 * only decides whether the header can name real dates or must speak
 * hypothetically.
 */
export function rentingWindowFromPlan(
  housing: HousingPlan | undefined,
  events: readonly ScenarioEvent[],
): RentingWindow | null {
  if (housing !== undefined) {
    if (housing.purchasePrice === 'none' || housing.purchasePrice === 0) return null;
    if (housing.rentMonths <= 0) return null;
    try {
      return { from: housing.sellDate, to: purchaseDate(housing), months: housing.rentMonths };
    } catch {
      return null; // a half-typed sale date is not a window
    }
  }
  const sell = events.find(
    (e): e is Extract<ScenarioEvent, { type: 'sell_house' }> => e.type === 'sell_house',
  );
  if (!sell) return null;
  let best: { date: YearMonth; months: number } | null = null;
  for (const e of events) {
    if (e.type !== 'buy_house') continue;
    // monthsBetween reads 0 off a malformed date, and 0 is already "no gap".
    const gap = monthsBetween(sell.date, e.date);
    if (gap > 0 && (best === null || gap < best.months)) best = { date: e.date, months: gap };
  }
  return best === null ? null : { from: sell.date, to: best.date, months: best.months };
}

/**
 * The figure in force for the survivor alone. An absent `monthlySurvivor`
 * inherits WHICHEVER STATE IS IN FORCE, so the answer depends on when the death
 * lands — which is why the caller has to say. The mortgage and the one car are
 * the reason: they do not fall when one of two people dies, in either state.
 */
export function survivorMonthly(line: ExpenseLine, state: 'working' | 'retired'): number {
  return effectiveLineMonthly(line, { retired: state === 'retired', survivor: true });
}

/** True when a survivor cell inherits two different numbers, one per state. */
export function survivorInheritanceSplits(line: ExpenseLine): boolean {
  return (
    line.monthlySurvivor === undefined &&
    survivorMonthly(line, 'working') !== survivorMonthly(line, 'retired')
  );
}

// ---------------------------------------------------------------------------
// Totals
// ---------------------------------------------------------------------------

export interface ColumnTotals {
  now: number;
  /** Between homes, while still salaried — the user's own window shape. */
  renting: number;
  retired: number;
  /** A death BEFORE work stops — the survivor inherits the working figures. */
  survivorWhileWorking: number;
  /** A death after work stops. */
  survivorAfterRetiring: number;
}

/**
 * Column sums for ONE tab's lines. Each tab is homogeneous, so its totals are
 * a single filter-and-sum — but the filter is load-bearing twice over:
 *
 * - It is what keeps a hand-edited 'insurance' / 'modeled_elsewhere' /
 *   'excluded' line out of every figure on screen. Property tax inside the
 *   living baseline while the housing plan also charged it cost this plan
 *   $820/mo for thirty years; those categories have no tab now, and this is
 *   where they stay out of the tabs that exist.
 * - Filtering PRESERVES ARRAY ORDER, and the engine's own `totalsFor` sums the
 *   same lines in the same order — so a tab's Now total agrees with the derived
 *   stream to the last bit. Float addition is not associative; a total that
 *   summed in tab-display order after a reorder-by-copy would drift.
 *
 * Every column is summed even where a tab hides one (a charitable line's
 * retired figure): the sums cost nothing, and the TAB decides what to render —
 * LINE_TAB_COLUMNS is the single place that decision lives.
 */
export function categoryTotals(
  lines: readonly ExpenseLine[],
  category: SummedLineCategory,
): ColumnTotals {
  const totals: ColumnTotals = {
    now: 0,
    renting: 0,
    retired: 0,
    survivorWhileWorking: 0,
    survivorAfterRetiring: 0,
  };
  for (const line of lines) {
    if (line.category !== category) continue;
    totals.now += line.monthlyNow;
    totals.renting += rentingMonthly(line, 'working');
    totals.retired += retiredMonthly(line);
    totals.survivorWhileWorking += survivorMonthly(line, 'working');
    totals.survivorAfterRetiring += survivorMonthly(line, 'retired');
  }
  return totals;
}

// ---------------------------------------------------------------------------
// The scalar streams, as a cache of the table
// ---------------------------------------------------------------------------

/**
 * Refresh the scalar cache from the rows, in place.
 *
 * With rows present the scalars are no longer an input — the contract says they
 * are derived, and `deriveExpenseStreams` is what derives them for the run — but
 * they are still what the Workbench's Spending card and the saved file show.
 * Left alone they would drift into a second, wrong answer to "what do you
 * spend", which is the failure this codebase keeps paying for. So every edit
 * rewrites them from the shared derivation, and deleting the last row leaves
 * those totals behind rather than whatever was typed months ago: the
 * itemisation collapses back into the streams it came from instead of being
 * lost.
 *
 * An undefined half is DELETED rather than written as its equal-valued number.
 * That is not tidiness: absent `livingMonthlyRetired` skips the engine's
 * working/retired blend outright, and a present-but-equal figure walks through
 * `x * (5/12) + x * (7/12)`, which is not `x` in floating point.
 */
export function applyDerivedStreams(expenses: ProfileExpenses): void {
  const lines = expenses.lines;
  if (!lines || lines.length === 0) return; // the scalars ARE the truth here
  const d = deriveExpenseStreams(expenses);
  expenses.livingMonthly = d.livingMonthly;
  expenses.charitableMonthly = d.charitableMonthly;
  expenses.investingMonthly = d.investingMonthly;
  if (d.livingMonthlyRetired === undefined) delete expenses.livingMonthlyRetired;
  else expenses.livingMonthlyRetired = d.livingMonthlyRetired;
  if (d.investingMonthlyRetired === undefined) delete expenses.investingMonthlyRetired;
  else expenses.investingMonthlyRetired = d.investingMonthlyRetired;
}

// ---------------------------------------------------------------------------
// Editing rows
// ---------------------------------------------------------------------------

/** Ids are stable across reorders and edits, so a row is never re-keyed. */
export function uniqueExpenseLineId(lines: readonly ExpenseLine[]): string {
  const taken = new Set(lines.map((l) => l.id));
  let n = 1;
  while (taken.has(`line-${n}`)) n += 1;
  return `line-${n}`;
}

/**
 * A new row at $0 with the two blank cells absent, stamped with the CALLER'S
 * category. The caller is a tab, and the stamp is what makes tabs work without
 * a category selector: a row added on the Investing tab IS an investing line,
 * and there is no control anywhere that could file it somewhere else.
 */
export function makeExpenseLine(
  lines: readonly ExpenseLine[],
  category: SummedLineCategory,
): ExpenseLine {
  return {
    id: uniqueExpenseLineId(lines),
    label: 'New line',
    category,
    monthlyNow: 0,
  };
}

/**
 * Move a line up or down WITHIN ITS OWN CATEGORY, in the full array.
 *
 * Each tab shows a filtered view, so "up" means "past the previous line of my
 * category" — the two members swap the array slots they already hold, and every
 * other line (including one whose category has no tab) keeps its exact
 * position. A naive adjacent swap in the full array would look like a no-op on
 * screen whenever the neighbour belongs to another tab; splicing the moved row
 * to a new slot would shift the positions of lines the user cannot even see.
 */
export function moveLineWithinCategory(
  lines: readonly ExpenseLine[],
  id: string,
  delta: -1 | 1,
): ExpenseLine[] {
  const out = [...lines];
  const moved = lines.find((l) => l.id === id);
  if (!moved) return out;
  const slots = lines
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => line.category === moved.category);
  const at = slots.findIndex(({ line }) => line.id === id);
  const to = at + delta;
  if (to < 0 || to >= slots.length) return out;
  out[slots[at].index] = slots[to].line;
  out[slots[to].index] = slots[at].line;
  return out;
}

/**
 * One row per stream, so an owner who has only ever typed three numbers loses
 * nothing by itemising.
 *
 * The investing row still carries an EXPLICIT retired figure so the FILE says
 * what the engine assumes: since 2026-08-31 investing stops at retirement
 * whatever the row says (the app's standing rule — the retired cell is
 * transcribed, never dollars), and before that a row's blank retired cell
 * meant "same as now". The seed writes the 0 (or whatever the profile says)
 * rather than inheriting.
 *
 * Giving gets no retired figure for the opposite reason: its after-work answer
 * is the Tithing rule, and a number here would be ignored.
 *
 * NO 'insurance' row is seeded any more, even when the profile carries a
 * premium. That category has no tab, so a seeded row would be a line in
 * profile.json that no screen shows and no control can delete — and the
 * premium it names is already charged, visibly, from the Insurance tab.
 */
export function seedLinesFromStreams(expenses: ProfileExpenses): ExpenseLine[] {
  const living: ExpenseLine = {
    id: 'living',
    label: 'Living expenses',
    category: 'living',
    monthlyNow: expenses.livingMonthly,
  };
  if (expenses.livingMonthlyRetired !== undefined) {
    living.monthlyRetired = expenses.livingMonthlyRetired;
  }
  return [
    living,
    {
      id: 'charitable',
      label: 'Charitable giving',
      category: 'charitable',
      monthlyNow: expenses.charitableMonthly,
    },
    {
      id: 'investing',
      label: 'Investing / savings',
      category: 'investing',
      monthlyNow: expenses.investingMonthly,
      monthlyRetired: expenses.investingMonthlyRetired ?? 0,
    },
  ];
}

// ---------------------------------------------------------------------------
// Policies
// ---------------------------------------------------------------------------

export function uniquePolicyId(policies: readonly LifeInsurancePolicy[]): string {
  const taken = new Set(policies.map((p) => p.id));
  let n = 1;
  while (taken.has(`policy-${n}`)) n += 1;
  return `policy-${n}`;
}

/**
 * A new policy insures `insured` for nothing, at no cost, with no end date.
 * Every figure is zero on purpose: a seeded face amount would be a number
 * nobody chose sitting in the one field the widow score turns on.
 */
export function makePolicy(
  policies: readonly LifeInsurancePolicy[],
  insured: string,
): LifeInsurancePolicy {
  return {
    id: uniquePolicyId(policies),
    label: 'New policy',
    insured,
    premiumMonthly: 0,
    deathBenefit: 0,
  };
}

/**
 * The single-policy fields, promoted to a one-element list. Everything the old
 * fields could say survives the move, including the ones that mean something by
 * being absent: naming NO dates still means "cover ends with the paycheck",
 * which `cancelAtRetirement` is how a policy says it now.
 */
export function seedPoliciesFromFields(
  expenses: ProfileExpenses,
  defaultInsured: string,
): LifeInsurancePolicy[] {
  const policy: LifeInsurancePolicy = {
    id: 'policy-1',
    label: 'Term life',
    insured: expenses.lifeInsuranceInsured ?? defaultInsured,
    premiumMonthly: expenses.lifeInsuranceMonthly ?? 0,
    deathBenefit: expenses.lifeInsuranceDeathBenefit ?? 0,
  };
  if (expenses.lifeInsuranceTermStart !== undefined) {
    policy.termStart = expenses.lifeInsuranceTermStart;
  }
  if (expenses.lifeInsuranceTermEnd !== undefined) policy.termEnd = expenses.lifeInsuranceTermEnd;
  /*
   * BOTH dates, not just the end. The engine reads the legacy fields as
   * `cancelAtRetirement: termStart === null && termEnd === null` — naming
   * EITHER date puts the policy on its own dates, in force whether anyone is
   * earning or not. Keying this off `termEnd` alone made a start date with no
   * end (which is how "five years of term bought at retirement" is written)
   * convert into a policy cancelled at the last paycheck: the conversion threw
   * away the entire term, cover and premium both, and the widow score fell
   * without a single field on screen having changed.
   */
  if (
    expenses.lifeInsuranceTermStart === undefined &&
    expenses.lifeInsuranceTermEnd === undefined
  ) {
    policy.cancelAtRetirement = true;
  }
  return [policy];
}

export interface PolicyTotals {
  premiumMonthly: number;
  deathBenefit: number;
}

export function policyTotals(policies: readonly LifeInsurancePolicy[]): PolicyTotals {
  return policies.reduce<PolicyTotals>(
    (acc, p) => ({
      premiumMonthly: acc.premiumMonthly + p.premiumMonthly,
      deathBenefit: acc.deathBenefit + p.deathBenefit,
    }),
    { premiumMonthly: 0, deathBenefit: 0 },
  );
}

/**
 * The FIRST month in which nobody in the household draws a salary — the date
 * every policy is measured against, because "cancel at retirement" and "the
 * cover lapses before the paycheck does" are both statements about THIS month.
 *
 * First, not last: a `retire` event's month is the month the salary stops, so
 * retiring in 2028-07 means months 1..6 are worked and JUNE holds the last
 * paycheck. `policyTermNote` is where that one-month difference decides whether
 * a warning is true.
 *
 * Only earners count. A spouse who draws no salary has no retire event, and
 * that must not make the household look like it works forever, which is exactly
 * what taking the latest date over everybody would do. An earner with no retire date
 * is the real "we never stop" case and returns null, and so does a household
 * with no salary at all — there is nothing left for a policy to replace.
 */
export function workStopsMonth(
  people: readonly Pick<Person, 'id'>[],
  salaries: Record<string, number>,
  retireByPerson: Record<string, YearMonth | null>,
): YearMonth | null {
  const earners = people.filter((p) => (salaries[p.id] ?? 0) > 0);
  if (earners.length === 0) return null;
  let last: YearMonth | null = null;
  for (const p of earners) {
    const date = retireByPerson[p.id];
    if (!date) return null;
    // "YYYY-MM" sorts lexicographically, so no parsing is needed to compare.
    if (last === null || date > last) last = date;
  }
  return last;
}

/** "2028-06" -> "June 2028"; the raw string while it is still half-typed. */
export function formatMonth(ym: YearMonth): string {
  const m = /^(\d{4})-(\d{2})$/.exec(ym);
  if (!m) return ym;
  const month = Number(m[2]);
  const name = MONTH_NAMES[month - 1];
  return name === undefined ? ym : `${name} ${m[1]}`;
}

/** "8 months", "5 yr", "4 yr 3 mo" — a gap a reader can weigh at a glance. */
export function formatGap(months: number): string {
  const n = Math.abs(months);
  if (n < 12) return n === 1 ? '1 month' : `${n} months`;
  const years = Math.floor(n / 12);
  const rest = n % 12;
  return rest === 0 ? `${years} yr` : `${years} yr ${rest} mo`;
}

export interface PolicyTermNote {
  text: string;
  tone: 'muted' | 'warn';
}

/**
 * When this policy ends, said against the date the paychecks stop.
 *
 * That gap IS the reason policies are modeled one by one. Treating two policies
 * with different expiries as one that ends at retirement dropped $2,500,000 of
 * cover four years early, in the years before Social Security starts where a
 * death hurts most — and it dropped the premium that bought it just as early.
 * Cover that lapses BEFORE the last paycheck is the loud case: term life is
 * income replacement, so a policy that ends while a salary is still being
 * earned is missing in precisely the years it was bought for.
 *
 * EVERY COUNT HERE IS OFF `workStops - 1`, NOT `workStops`. The last paycheck
 * lands the month before work stops (see workStopsMonth), and a term ending on
 * THAT month covers every earning month there is. Counting against `workStops`
 * itself shouted "1 month BEFORE work stops, so a death in that gap pays
 * nothing" at a policy with no gap at all — the natural way to write "my term
 * runs to my last day at work" — and inflated every genuine gap by a month.
 */
export function policyTermNote(
  policy: LifeInsurancePolicy,
  workStops: YearMonth | null,
): PolicyTermNote {
  const start = policy.termStart ? `Starts ${formatMonth(policy.termStart)}. ` : '';
  const end = policy.termEnd;

  if (policy.cancelAtRetirement) {
    if (workStops === null) {
      return { text: `${start}Cancelled when work stops — the plan has no retirement date yet.`, tone: 'muted' };
    }
    const cancelled = `${start}Cancelled when work stops, ${formatMonth(workStops)}`;
    if (end === undefined) return { text: `${cancelled}.`, tone: 'muted' };
    // The cancel cuts the cover after the last paycheck, so what it throws away
    // is every month from `workStops` to the term's end INCLUSIVE — one more
    // than the distance between them, and 1 rather than 0 when they coincide.
    const dropped = monthsBetween(workStops, end) + 1;
    return dropped > 0
      ? {
          text: `${cancelled} — dropping ${formatGap(dropped)} of cover the term still had.`,
          tone: 'warn',
        }
      : { text: `${cancelled}, after the term ends ${formatMonth(end)}.`, tone: 'muted' };
  }

  if (end === undefined) {
    return {
      text: `${start}No end date: the cover and the premium both run to the horizon.`,
      tone: 'muted',
    };
  }
  if (workStops === null) {
    return { text: `${start}Ends ${formatMonth(end)}. The plan has no retirement date yet.`, tone: 'muted' };
  }
  const gap = monthsBetween(workStops, end);
  if (gap > 0) {
    return {
      text: `${start}Ends ${formatMonth(end)} — ${formatGap(gap)} after work stops.`,
      tone: 'muted',
    };
  }
  if (gap === 0) {
    return { text: `${start}Ends ${formatMonth(end)}, the month work stops.`, tone: 'muted' };
  }
  // Earning months with no cover over them. `gap === -1` is the term ending ON
  // the last paycheck, which leaves none — the quiet case, not the loud one.
  const uncovered = -gap - 1;
  if (uncovered === 0) {
    return {
      text: `${start}Ends ${formatMonth(end)}, the last month a salary is drawn.`,
      tone: 'muted',
    };
  }
  return {
    text: `${start}Ends ${formatMonth(end)} — ${formatGap(uncovered)} BEFORE the last paycheck, so a death in that gap pays nothing.`,
    tone: 'warn',
  };
}

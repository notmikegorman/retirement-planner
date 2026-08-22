/**
 * Pure helpers for the Workbench.
 *
 * The Workbench is one page: inputs on the left, results on the right, and the
 * results re-run themselves whenever an input is committed. Everything in this
 * file is the data-in/data-out part of that loop — what changed between two
 * runs, how a plan-level spending override is read and written, when the
 * autosave actually needs to write, how a pinned baseline's median line lines
 * up with the current fan, and what conditions a run was computed under. No
 * React and no IO, so it is all unit tested in tests/ui/workbench.test.ts.
 */
import type {
  AssetMix,
  AssumptionOverrides,
  FanChart,
  GuardrailStats,
  LifeInsurancePolicy,
  LifeInsurancePolicyPlan,
  OngoingGivingRule,
  ProfileIncome,
  ProfileSettings,
  RetirementGivingRule,
  RunMeta,
  RunMode,
  RunResult,
  Scenario,
  ScenarioEvent,
  UntithedPotPolicy,
  UntithedPotSetting,
  YearMonth,
  YearRow,
} from '../../../shared/types';
import {
  DEFAULT_POT_PERCENT,
  DEFAULT_TITHE_DISTRIBUTE_YEARS,
} from '../../../shared/types';
import { potIsEnabled, resolveUntithedPot, titheBundleToPair } from '../../../shared/giving';
import { clamp, formatPct, formatUSD, stableStringify } from '../../../shared/util';
import {
  formatCompactUSD,
  referencePathInsolvencyYear,
  typicalShortfallYear,
} from '../results/resultsData';
// The app's one "date, then the clock" idiom, imported rather than re-derived:
// a second copy of "Aug 21, 2026, 3:41 PM" would drift from the History tab's
// the first time either was touched, and a run's moment is read on the same
// screen the user compares that tab's rows on.
import { historyMoment } from './planHistoryLogic';

// ---------------------------------------------------------------------------
// The classic withdrawal rate ("am I at 4% or 6%?")
// ---------------------------------------------------------------------------

/**
 * The guardrails band translated into the same units as the headline rate —
 * a percent of the start-of-year spendable portfolio — read from the engine's
 * own audit trace rather than recomputed here.
 *
 * THE RAILS DO NOT POLICE THE HEADLINE RATE. The engine measures and moves the
 * LIVING stream alone (simulate.ts note 22: rate = living × factor / spendable
 * start; housing, health, giving and tax sit outside both the numerator and
 * the lever), so all three figures here are living-only rates, and the strip
 * must say so rather than pretend the band brackets the all-in number above it.
 */
export interface GuardrailRailsView {
  /** The living-only rate the plan anchored on in its first fully retired year. */
  anchor: number;
  /** Living-only rate above which a year's spending is cut. */
  cutAbove: number;
  /** Living-only rate below which it is raised. */
  raiseBelow: number;
}

/**
 * What the Summary strip can say about the withdrawal rate. The two rateless
 * kinds exist so the tile states its own reason instead of going blank: a plan
 * that never fully retires inside the horizon has no such year to price, and a
 * plan already retired in its first simulated year has no prior-year closing
 * balance to divide by (the same kind also covers a portfolio that was already
 * empty when the first retired year opened).
 */
export type WithdrawalRateStat =
  | {
      kind: 'rate';
      rate: number;
      year: number;
      rails: GuardrailRailsView | null;
      /**
       * The whole-retirement companion figure (lifetimeEquivalentDraw, below):
       * null when fewer than two retired years are priced, and the tile then
       * states the headline alone. Required rather than optional so no
       * construction site can forget the decision — the rails field's own rule.
       */
      lifetime: LifetimeEquivalentDraw | null;
    }
  | { kind: 'never-retired' }
  | { kind: 'no-opening-balance'; year: number };

/**
 * The engine's guardrails audit line (simulate.ts note 22), whose note reads
 * "withdrawal rate 5.00% against an opening 4.00%; rails at 3.20%-4.80%".
 * Parsing the trace is deliberate: the engine exports its anchor nowhere else,
 * and the living-only numerator cannot be rebuilt from the row (expenses.
 * baseline folds in the living multiplier, delta events and life-insurance
 * premiums). The wording is pinned by tests/engine/guardrails.test.ts, and a
 * drift degrades to "headline only" here rather than to a wrong number.
 */
const GUARDRAIL_TRACE_LABEL = 'Spending policy — guardrails';
const GUARDRAIL_NOTE_RE =
  /withdrawal rate [\d.]+% against an opening ([\d.]+)%; rails at ([\d.]+)%-([\d.]+)%/;

function guardrailRails(row: YearRow): GuardrailRailsView | null {
  const line = row.taxes.trace?.find((t) => t.label.startsWith(GUARDRAIL_TRACE_LABEL));
  const m = line?.note !== undefined ? GUARDRAIL_NOTE_RE.exec(line.note) : null;
  if (m === null || m === undefined) return null;
  return {
    anchor: Number(m[1]) / 100,
    raiseBelow: Number(m[2]) / 100,
    cutAbove: Number(m[3]) / 100,
  };
}

/**
 * One year of the classic-withdrawal-rate series: the rate, and the two
 * nominal dollar figures behind it. The dollars ride along so the chart's
 * hover can show the arithmetic — a figure the user can reconcile against
 * the Cashflow table — instead of asking them to trust a bare percentage.
 */
export interface WithdrawalRatePoint {
  year: number;
  /** funded / opening — the classic withdrawal rate for this year. */
  rate: number;
  /** What the portfolio had to fund this year (nominal dollars of `year`). */
  funded: number;
  /** The spendable balance the year opened with — the prior row's close. */
  opening: number;
  /**
   * The row's own cumulative CPI factor — the engine stamps each row with the
   * factor at its year's START (1.0 in the first simulated year; the index
   * advances at year end, after the row is emitted). Carried on the point so
   * the lifetime-equivalent draw can restate `funded` and `opening` in real
   * start-year dollars from the series alone, instead of re-walking the path
   * with a second copy of the year-selection rules.
   */
  inflationIndex: number;
}

/**
 * THE CLASSIC WITHDRAWAL RATE, for EVERY fully retired year: what the
 * portfolio had to fund that year, over the balance it started the year with
 * — the number the 4%-rule literature is about, as a per-year series so the
 * SHAPE is visible (the bridge years before Social Security draw hard,
 * benefits relieve them, and RMDs against a shrinking horizon can lift the
 * rate again late in life — real, and left unclipped).
 *
 * THIS FUNCTION IS THE ONLY HOME OF THE ARITHMETIC. The Summary tile
 * (classicWithdrawalRate, below) is literally this series' first point, so
 * the tile and the chart cannot disagree about a year — a disagreement there
 * would be worse than having no chart at all.
 *
 * WHICH YEARS: rows with income.wages === 0, i.e. nobody earned a salary at
 * any point in the year. The retirement year itself is a blend — part-year
 * wages fund part of the spending and would understate the rate — and any
 * wages at all disqualify a row, so blend and working years are skipped by
 * construction. (Wages are reported net of the 401(k) deferral, so a worked
 * year whose entire salary was deferred would misread as retired; no real
 * payroll allows that, and it is the honest signal available without an
 * engine change.)
 *
 * THE NUMERATOR — what the portfolio must fund, field by field:
 *   IN:  expenses.total         — baseline living (which CARRIES life-insurance
 *                                 premiums: simulate.ts folds them into
 *                                 expenses.baseline) + charitable + housing +
 *                                 health + oneTime.
 *   IN:  taxes.totalTax         — federal + state + penalties.
 *   NET: income.wages           — 0 by the row's own selection; kept in the
 *                                 arithmetic so the formula reads as stated.
 *   NET: income.socialSecurity  — outside money.
 *   NET: income.retirement      — the pension / consulting stream: outside money.
 *   NET: income.other           — one-time income: outside money.
 *   OUT: income.taxableInterest, income.dividends — the PORTFOLIO'S OWN return.
 *        Netting them would flatter the rate: the question is how hard the
 *        portfolio is being drawn, and its own yield is part of how the draw is
 *        met, not a reduction of it.
 *   OUT: investing              — the brokerage transfer stays inside the
 *        portfolio; it is not consumption, and it is already outside
 *        expenses.total.
 *   OUT: unbudgeted             — always 0 in a fully retired year (engine
 *        contract on YearRow.unbudgeted).
 *   OUT: survivor.lifeInsuranceBenefit / ssLumpSum — recorded outside the
 *        income block; a death-year payout is a balance-sheet event, not a
 *        recurring funding source, so it does not reduce the stated rate.
 *
 * A NEGATIVE RATE IS POSSIBLE and left as computed: outside income exceeding
 * the year's outflows means the portfolio funded nothing and grew from
 * outside help, and that is the honest statement of it.
 *
 * THE DENOMINATOR: the PRIOR row's end-of-year balances.spendable — the
 * engine's own start-of-year convention (year N's spendableStart is year N-1's
 * closing spendable; simulate.ts prices fixed_percent and the guardrails off
 * exactly this figure). Spendable, not total: a locked tithe carve-out is
 * charity's money and cannot fund the household. Numerator and denominator are
 * nominal dollars of the same year boundary, so the ratio needs no deflating.
 *
 * A year whose opening balance is zero or negative states NO point rather
 * than an infinite or nonsense rate — the tile's own no-opening-balance
 * ruling, applied per year. (This is also what ends the series at
 * insolvency: the year after the portfolio empties has nothing to price a
 * draw against.) The first simulated year can never state a point either —
 * it has no prior close to divide by.
 */
export function withdrawalRateSeries(referencePath: readonly YearRow[]): WithdrawalRatePoint[] {
  const points: WithdrawalRatePoint[] = [];
  for (let i = 1; i < referencePath.length; i++) {
    const row = referencePath[i];
    if (row.income.wages !== 0) continue;
    const opening = referencePath[i - 1].balances.spendable;
    if (opening <= 0) continue;
    const funded =
      row.expenses.total +
      row.taxes.totalTax -
      (row.income.wages + row.income.socialSecurity + row.income.retirement + row.income.other);
    points.push({
      year: row.year,
      rate: funded / opening,
      funded,
      opening,
      inflationIndex: row.inflationIndex,
    });
  }
  return points;
}

/**
 * THE LIFETIME-EQUIVALENT DRAW: what constant initial-percentage rule this
 * plan funds over its WHOLE retirement, in the 4%-folklore's own units.
 *
 *   (mean over the priced years of that year's portfolio-funded outflow,
 *    in REAL start-year dollars)
 *   ÷ (the first priced year's opening spendable balance, same REAL dollars)
 *
 * WHY THIS STATISTIC AND NOT A MEAN OF THE YEARLY RATES. Each year's rate has
 * its own denominator (that year's opening balance), so a mean of the
 * percentages answers no question — a plan could raise its "average rate" by
 * shrinking its own portfolio. The Bengen 4% rule is a CONSTANT REAL DRAW
 * priced as a percentage of the INITIAL balance; the only honest comparison
 * in those units is the constant real draw this plan's actual outflows are
 * equivalent to. Front-loading is thereby included rather than averaged away:
 * bridge years before Social Security pull the figure up, a one-time pot gift
 * adds its bump, and the long post-SS stretch pulls it down.
 *
 * THE REAL CONVERSION, term by term:
 * - Each year's `funded` is nominal dollars of that year and deflates by that
 *   ROW'S OWN inflationIndex — the engine's uniform convention (every *Real
 *   field on a row divides by the row's own index).
 * - The DENOMINATOR is the first priced year's `opening` — the PRIOR row's
 *   year-end close — deflated by the FIRST PRICED ROW'S index, not the prior
 *   row's. WHY: the boundary instant "end of year N-1" IS "start of year N",
 *   and the engine stamps row N with exactly the start-of-year-N cumulative
 *   factor (the index advances at year end, after the row is emitted), so the
 *   first priced row's index is the price level at the very instant the
 *   opening balance exists. This choice also buys the invariance an
 *   "equivalent rate" must have: the first year's real contribution,
 *   (funded/idx) / (opening/idx), is exactly its nominal headline rate — the
 *   tile's own number — where the prior row's index would silently shift the
 *   whole figure by one year's inflation relative to the headline beside it.
 *
 * THE POPULATION IS THE SERIES' OWN — the same points the tile and the chart
 * price, by construction (one series feeds all three). Years the series
 * cannot price (no opening balance, which is also what truncates it at
 * insolvency) contribute neither dollars nor a divisor-year: a year the
 * portfolio could not open cannot have funded anything, and counting it would
 * dilute the figure with years the statistic cannot describe.
 *
 * NULL UNDER TWO PRICED YEARS, so the tile omits the clause: a "lifetime" of
 * one year would restate the headline rate with extra words (see the
 * invariance above — for a single year the two are the same number).
 */
export interface LifetimeEquivalentDraw {
  /** The X in "this plan funds the real-dollar equivalent of an X% rule". */
  rate: number;
  /** How many fully retired years the mean runs over — the series' length. */
  years: number;
}

export function lifetimeEquivalentDraw(
  points: readonly WithdrawalRatePoint[],
): LifetimeEquivalentDraw | null {
  if (points.length < 2) return null;
  let sumFundedReal = 0;
  for (const p of points) sumFundedReal += p.funded / p.inflationIndex;
  // Positive by construction: the series states no point for opening <= 0.
  const openingReal = points[0].opening / points[0].inflationIndex;
  return { rate: sumFundedReal / points.length / openingReal, years: points.length };
}

/**
 * THE CLASSIC WITHDRAWAL RATE tile: the plan's first FULLY retired year,
 * priced by withdrawalRateSeries — the tile reads the series' first point
 * rather than repeating the arithmetic, so it and the Summary chart are one
 * computation by construction. The year selection, the numerator and the
 * denominator are all documented on the series function above.
 *
 * What is the tile's own: the two rateless kinds. A plan that never fully
 * retires inside the horizon has no such year to price ('never-retired'), and
 * the first retired year can lack a divisor — it is the first simulated year,
 * or the portfolio was already empty when it opened ('no-opening-balance').
 * The series simply omits such years; the tile must instead SAY why there is
 * no number, because a tile that goes blank states nothing.
 */
export function classicWithdrawalRate(referencePath: readonly YearRow[]): WithdrawalRateStat {
  const i = referencePath.findIndex((r) => r.income.wages === 0);
  if (i === -1) return { kind: 'never-retired' };
  const row = referencePath[i];
  // The series' first point is this row exactly when the row can state a rate
  // (a prior year exists and its close was positive); a first point for some
  // LATER year means this one couldn't, which is the no-opening-balance story.
  const series = withdrawalRateSeries(referencePath);
  const first = series[0];
  if (first === undefined || first.year !== row.year) {
    return { kind: 'no-opening-balance', year: row.year };
  }
  // The lifetime figure consumes the SAME series array the headline was just
  // read from — one withdrawalRateSeries call feeds both clauses of the tile,
  // so they cannot price different populations (the tile-and-chart guarantee,
  // extended to the tile's own second clause).
  return {
    kind: 'rate',
    rate: first.rate,
    year: first.year,
    rails: guardrailRails(row),
    lifetime: lifetimeEquivalentDraw(series),
  };
}

// ---------------------------------------------------------------------------
// The withdrawal-rate chart's view helpers (Summary tab, WithdrawalRateCard)
// ---------------------------------------------------------------------------

/**
 * The year Social Security starts under this plan: the year of the EARLIEST
 * claim_social_security event, because the household's benefit stream begins
 * with the first person to claim (a second claim raises the stream; it does
 * not start it). Read from the plan's events rather than hardcoded — the
 * marker must move the moment the claiming decision is edited.
 *
 * Null when the plan never claims, when nothing is plotted, or when the claim
 * lands outside the plotted years (claimed while still working, or past the
 * horizon): a marker pointing off the chart would misplace the one story —
 * bridge, then relief — it exists to anchor.
 */
export function ssClaimMarkerYear(
  points: readonly WithdrawalRatePoint[],
  events: readonly ScenarioEvent[],
): number | null {
  if (points.length === 0) return null;
  let earliest: YearMonth | null = null;
  for (const e of events) {
    if (e.type !== 'claim_social_security') continue;
    // "YYYY-MM" compares correctly as a string — householdWorkStopMonth's own
    // convention.
    if (earliest === null || e.date < earliest) earliest = e.date;
  }
  if (earliest === null) return null;
  const year = Number(earliest.slice(0, 4));
  if (!Number.isFinite(year)) return null;
  const first = points[0].year;
  const last = points[points.length - 1].year;
  return year >= first && year <= last ? year : null;
}

/**
 * Y domain from the data with sensible padding: a tenth of the span each side,
 * floored at half a percentage point so a nearly-flat series still has body.
 * Deliberately NOT clamped at zero or anywhere else — an RMD-era spike is a
 * real fact about the plan and must not be clipped or smoothed into flattening
 * the bridge story, and the negative rate an outside-income year can produce
 * is kept for the same reason.
 */
export function withdrawalRateAxisDomain(
  points: readonly WithdrawalRatePoint[],
): [number, number] {
  if (points.length === 0) return [0, 0.1];
  let min = Infinity;
  let max = -Infinity;
  for (const p of points) {
    if (p.rate < min) min = p.rate;
    if (p.rate > max) max = p.rate;
  }
  const pad = Math.max((max - min) * 0.1, 0.005);
  return [min - pad, max + pad];
}

/** One formatted row of the chart's hover card. */
export interface WithdrawalTooltipLine {
  label: string;
  value: string;
}

/** The hover card's content for one plotted year: rows plus a units line. */
export interface WithdrawalTooltipView {
  lines: WithdrawalTooltipLine[];
  /** The units statement: both dollar figures are that year's nominal dollars. */
  note: string;
}

/**
 * What hovering a year says: the rate AND the dollars behind it — what the
 * portfolio funded, over the opening balance it funded it from — because the
 * dollars are what the user can reconcile by hand against the Cashflow
 * table, and a bare percentage cannot be checked against anything. The note
 * names the units: these are the hovered year's nominal dollars, not today's.
 */
export function withdrawalTooltipView(p: WithdrawalRatePoint): WithdrawalTooltipView {
  return {
    lines: [
      { label: 'withdrawal rate', value: formatPct(p.rate, 1) },
      { label: 'the portfolio funded', value: formatUSD(p.funded) },
      { label: 'from an opening balance of', value: formatUSD(p.opening) },
    ],
    note: `Nominal ${p.year} dollars.`,
  };
}

/**
 * What the Summary shows where the chart would be when the series is empty:
 * plain words, the tile-never-goes-blank rule again. Both rateless reasons
 * share the sentence because the tile directly above the chart already states
 * which one applies to this run.
 */
export const WITHDRAWAL_CHART_EMPTY_NOTE =
  'Nothing to chart — this plan never fully retires inside the horizon, or the portfolio ' +
  'had no opening balance when it did.';

// ---------------------------------------------------------------------------
// How precisely a run measured a fraction of its paths
// ---------------------------------------------------------------------------

/*
 * THE SUCCESS RATE IS AN ESTIMATE AND THE SCREEN PRINTED IT LIKE A MEASUREMENT.
 *
 * A user turned the tithing hold period from 2 to 0 and back to 2, read
 * 94.2% -> 93.0% -> 92.9%, pressed Run now and got 94.2% again, and reported it
 * as a bug because it happened the same way every time. Nothing was corrupt.
 * Same plan hash (7ff9a75c12f24aa1), same profile hash, same seed: 1,000 paths
 * gives 0.931 and 10,000 gives 0.942, and the hold-0 plan gives 0.930 at 1,000.
 * The toggle round-trips exactly. The 1.1-point swing was the quick run against
 * the final one — which df1a13f had already labelled — and the 0.1 points
 * between 93.0 and 92.9 was a difference a 1,000-path run cannot resolve at
 * all, drawn as a movement anyway.
 *
 * A FIXED SEED MAKES THAT WORSE, NOT BETTER. The live loop locks the seed so a
 * knob's effect is not drowned in resampling noise, which means the quick run's
 * error is DETERMINISTIC for a given plan: ask twice, get the same wrong-by-1.1
 * -points answer twice. An estimate that never wobbles reads as a measurement.
 *
 * So the fractions this file reports now carry the precision they were measured
 * to, and a difference smaller than that precision is reported as unresolved
 * rather than as a move.
 */

/**
 * The multiplier from a standard error to a two-sided interval half-width, and
 * the word that goes beside it wherever one is printed.
 *
 * 95% BECAUSE THE REST OF THE APP ALREADY SAYS 95%. The Search page reports
 * every effect it measures as a 95% interval (searchLogic.formatSpread over
 * SeedStat.ci95, itself built on stats.tCritical(0.05, n - 1)). Two "±" figures
 * in one app at two confidence levels would be two different claims wearing the
 * same symbol, which is the exact class of mistake this section exists to end.
 *
 * 1.959964 is the NORMAL quantile, not Student's t. The smallest run this app
 * takes seriously has 999 degrees of freedom, where t = 1.9623 against
 * z = 1.9600 — a difference of 0.0015 points on the user's plan, four decimal
 * places below anything printed.
 */
export const CI_Z_95 = 1.959964;

/** The confidence level, as the UI says it. Never print a "±" without it. */
export const CI_LABEL_95 = '95%';

/**
 * The within-run sampling error of a fraction of paths: sqrt(p(1 - p) / n).
 *
 * Every fraction this strip reports is a count of paths over the path count —
 * metrics.ts's successRate divides successes by n, and aggregateGuardrailStats
 * divides its cut and above-plan counts by the same n — so each path is one
 * Bernoulli trial and the fraction's standard error is the textbook binomial
 * one. Both inputs come off the run itself (RunResult.success or
 * guardrailStats, and RunMeta.paths); nothing here re-simulates anything.
 *
 * THIS IS NOT THE SPREAD ACROSS SEEDS, and the two must never be printed as one
 * number. The Search page runs a plan at many seeds and reports the spread of
 * those answers (SeedStat.sd, over n = SEEDS), which asks "how much does the
 * answer move when the futures are redrawn". This asks "how precisely did THIS
 * draw of futures pin the fraction down", over n = PATHS. A plan can have a
 * tiny within-run error and a large across-seed spread at the same time; that
 * is not a contradiction, it is two questions.
 *
 * NaN for a run with no paths. metrics.ts throws on one, so this is defensive
 * only — but sqrt(x/0) is Infinity, and an Infinity would print as a plausible
 * "±Infinity pts" where NaN cannot be mistaken for a measurement.
 */
export function pathFractionStandardError(fraction: number, paths: number): number {
  if (!Number.isFinite(paths) || paths < 1) return Number.NaN;
  return Math.sqrt((fraction * (1 - fraction)) / paths);
}

/**
 * The half-width the screen is allowed to print: z x the standard error, EXCEPT
 * at the two boundaries, where the standard error is exactly zero and "±0.0
 * pts" would be the one lie this whole section exists to stop.
 *
 * THE RULE OF THREE covers p = 1 and p = 0. Zero failures in n paths does not
 * mean the failure rate is zero: if the true rate were x, the chance of seeing
 * none in n draws is (1 - x)^n, and setting that to 0.05 gives x ~ 3/n. At the
 * owner's 1,000 paths that is 0.3 points; at 10,000 it is 0.03. This household
 * reaches p = 1 often enough for it to matter — the plan is over-funded and the
 * success rate saturates — so the boundary is the ordinary case here, not the
 * exotic one.
 *
 * The rule-of-three bound is ONE-SIDED: a run in which nothing failed can only
 * be wrong downward. successPrecision prints it as a one-sided bound for that
 * reason and never as a "±", which would claim futures above 100%.
 */
export function pathFractionHalfWidth(fraction: number, paths: number): number {
  if (!Number.isFinite(paths) || paths < 1) return Number.NaN;
  if (fraction >= 1 || fraction <= 0) return 3 / paths;
  return CI_Z_95 * pathFractionStandardError(fraction, paths);
}

/**
 * The standard error to COMBINE when differencing two runs — the same binomial
 * one, except at a boundary, where the zero would let a difference of any size
 * through the guard on exactly the plan most likely to produce one. There it is
 * the standard error that reproduces the rule-of-three bound at this z, so the
 * two paths through the arithmetic agree at the seam.
 */
function combinableStandardError(fraction: number, paths: number): number {
  return fraction >= 1 || fraction <= 0
    ? 3 / paths / CI_Z_95
    : pathFractionStandardError(fraction, paths);
}

/** One side of a difference: a fraction of paths, and how many paths made it. */
export interface PathFraction {
  fraction: number;
  /** Undefined when the run's path count is not known — see the null return. */
  paths?: number;
}

/**
 * THE SMALLEST DIFFERENCE TWO RUNS CAN RESOLVE, at 95%: z x sqrt(se1^2 + se2^2),
 * the half-width of the difference of two independent binomial estimates.
 *
 * Null when either path count is unknown, matching comparableRun's rule exactly:
 * hand-built metrics carry no meta, and suppressing every chip because of that
 * would cost the strip its whole reason for existing.
 *
 * CONSERVATIVE FOR TWO RUNS ON THE SAME SEED, AND KNOWINGLY SO. returns.ts
 * draws market futures from (historical rows, horizon, path count, block years,
 * seed, expense ratios) and nothing scenario-dependent, so two plans run at one
 * seed face bit-identical futures and their difference is PAIRED — the common
 * random numbers the Search page's stats.ts is built on, worth a measured 1.3x
 * to 6.4x there. A paired interval on the tithing toggle would be narrower,
 * possibly much narrower.
 *
 * IT IS NOT COMPUTED HERE BECAUSE THE RUN DOES NOT RETURN IT. The paired
 * quantity needs the count of paths that flipped between the two plans, and
 * RunResult carries the success FRACTION with nothing per-path behind it.
 * Narrowing the interval with a number we do not have would be the same sin as
 * printing 92.9% with no interval at all, one decimal place further down. So
 * the strip declines to resolve some differences a paired test could have
 * resolved, and says where the paired test lives: Run now for ten times the
 * paths, and the Search page for the properly paired answer across seeds.
 */
export function pathFractionDeltaResolution(
  current: PathFraction,
  comparison: PathFraction,
): number | null {
  if (current.paths === undefined || comparison.paths === undefined) return null;
  if (current.paths < 1 || comparison.paths < 1) return null;
  const a = combinableStandardError(current.fraction, current.paths);
  const b = combinableStandardError(comparison.fraction, comparison.paths);
  return CI_Z_95 * Math.sqrt(a * a + b * b);
}

/**
 * A fraction-of-paths interval in the strip's own units: "1.3" means 1.3 points.
 *
 * ONE DECIMAL IS THE STRIP'S UNIT AND IT IS NOT ALWAYS ENOUGH. A tenth of a
 * point is the right grain for the quick run — ±1.3, ±1.8 — but the intervals
 * this section prints do not all live at that scale, and toFixed(1) rounds the
 * small ones to "0.0". That is the exact string the rule of three exists to
 * replace, reappearing one path count further along: at mcPathsFinal's 10,000
 * paths the rule-of-three bound is 3/10,000 = 0.03 points, so a saturated final
 * run printed "-0.0 / +0 pts" and a sentence that read "puts the unseen
 * failures under 0.0 points rather than at zero" — a claim of exactness in the
 * one branch written to refuse one, and this household's ordinary case, since
 * the plan is over-funded and the rate saturates.
 *
 * So the decimal count widens until the figure survives it, and no further. A
 * number the eye reads as zero is worse than a third decimal place: the reader
 * came here to learn a magnitude, and "0.0" says there is none.
 */
function points(fraction: number): string {
  const pts = fraction * 100;
  if (pts === 0) return '0.0';
  for (const dp of [1, 2, 3]) {
    const text = pts.toFixed(dp);
    if (Number(text) !== 0) return text;
  }
  // Four places is where a path count of a million lands; nothing this app runs
  // goes finer, and a fifth would be printing the arithmetic rather than a figure.
  return pts.toFixed(4);
}

/** The precision of a displayed success rate, ready to print. */
export interface SuccessPrecision {
  /** Half-width as a FRACTION of futures (0..1) — the success rate's own units. */
  halfWidth: number;
  /** True when no path failed (or none succeeded): the bound is one-sided. */
  saturated: boolean;
  /** The chip: "±1.3 pts (95%)", or "-0.3 / +0 pts (95%)" at a boundary. */
  text: string;
  /**
   * The chip's meaning in one line, printed under the run-quality note rather
   * than hidden in a hover. "±1.3" on its own is another unlabelled number, and
   * an unlabelled number is what this whole change is about — a reader should
   * not have to find the tooltip to learn what the symbol claims.
   */
  sentence: string;
  /** The full hover: what the interval is, what it is not, and what widens it. */
  title: string;
}

/**
 * The precision of the success rate this run reported, or null when the run's
 * mode has no sampling error to state.
 *
 * NULL FOR EVERY MODE BUT MONTE CARLO, for two different reasons that end in
 * the same place. A deterministic run is a single path: its success is 0 or 1
 * and it is a sample of nothing. A historical run enumerates every rolling
 * window the return series holds (returns.ts mode 2) — a census of the windows
 * that exist, not a draw from a population — so there is no sampling error, and
 * printing one would invent a randomness the mode does not have.
 */
export function successPrecision(
  success: number,
  meta: Pick<RunMeta, 'mode' | 'paths'>,
): SuccessPrecision | null {
  if (meta.mode !== 'montecarlo') return null;
  if (!Number.isFinite(meta.paths) || meta.paths < 1) return null;
  const halfWidth = pathFractionHalfWidth(success, meta.paths);
  const n = meta.paths.toLocaleString('en-US');
  const pts = points(halfWidth);

  if (success >= 1 || success <= 0) {
    /*
     * A run in which nothing failed can only be wrong downward, so the bound
     * goes on one side. "±" here would claim futures above 100%.
     *
     * ASCII '-' rather than a typographic minus, because every other signed
     * number on this strip comes out of toFixed and two kinds of minus sign in
     * one row of chips is a thing the eye notices and cannot explain.
     */
    const saturatedText = success >= 1 ? `-${pts} / +0 pts` : `+${pts} / -0 pts`;
    return {
      halfWidth,
      saturated: true,
      text: `${saturatedText} (${CI_LABEL_95})`,
      sentence:
        `Every path ${success >= 1 ? 'survived' : 'failed'}, so the bound is one-sided: ` +
        `${CI_LABEL_95} confidence puts the unseen ${success >= 1 ? 'failures' : 'survivals'} ` +
        `under ${pts} points rather than at zero.`,
      title:
        `Every one of these ${n} paths ${success >= 1 ? 'survived' : 'failed'}, which does not ` +
        `mean the rate is exactly ${success >= 1 ? '100%' : '0%'}: with none seen in ${n} draws, ` +
        `${CI_LABEL_95} confidence puts the unseen ones at no more than ${pts} points (the rule ` +
        `of three, 3/${n}). It is one-sided because the rate cannot pass the boundary. This is ` +
        `the spread WITHIN this draw of futures, not the spread across seeds — the Search page ` +
        `measures that one.`,
    };
  }

  return {
    halfWidth,
    saturated: false,
    text: `±${pts} pts (${CI_LABEL_95})`,
    /*
     * IT DESCRIBES THE LEVEL, NOT A DIFFERENCE, and says so. The threshold a
     * difference has to clear is the COMBINED half-width of two runs
     * (pathFractionDeltaResolution), which is wider than this one — quoting
     * ±1.3 as the bar a move must beat would be a second unlabelled number
     * standing in for a first.
     */
    sentence:
      `The ± is a ${CI_LABEL_95} interval on this run's own success rate: ${n} paths pin it to ` +
      `±${pts} points, and re-running the same plan at another path count moves it by about ` +
      `that much on its own.`,
    title:
      `${n} paths pin this fraction down to about ±${pts} points, ${CI_LABEL_95} of the time ` +
      `(binomial standard error sqrt(p(1-p)/n), times ${CI_Z_95.toFixed(2)}). Re-running the same ` +
      `plan at a different path count moves the number by roughly this much with nothing about ` +
      `the plan having changed. This is the spread WITHIN this draw of futures; the spread ` +
      `ACROSS seeds is a different quantity and the Search page is what measures it.`,
  };
}

// ---------------------------------------------------------------------------
// The numbers the strip reports
// ---------------------------------------------------------------------------

/**
 * The headline numbers of a run, reduced to plain scalars so two runs can be
 * subtracted. `shortfallYear` follows runVerdict's own precedence exactly: the
 * worst-decile histogram's typical year when the mode produced one, else the
 * deterministic reference path's insolvency year, and null when nothing failed.
 */
export interface RunMetrics {
  /** Fraction of paths that never went insolvent (0..1). */
  success: number;
  /** Median terminal portfolio in real (start-year) dollars. */
  medianTerminalReal: number;
  /** Typical year the money runs out among failing futures; null when none fail. */
  shortfallYear: number | null;
  /**
   * BREAK GLASS: across the futures that FAILED, the median tithe carve-out
   * balance (real dollars) sitting in the account in the year the money ran
   * out. A failure during the soft window has already spent the pot as its
   * last resort, so it contributes ~0; a meaningful figure means futures
   * failed AFTER the lock, with the promise standing in escrow.
   *
   * UNDEFINED MEANS THERE IS NO SUCH NUMBER — no future failed, or the plan
   * has no carve-out — and the strip then omits the tile rather than printing
   * a "none" that would imply the plan had a reserve and it was empty. The
   * engine reports null for the same condition; this collapses both to absent
   * because for the strip they are the same story.
   */
  breakGlassReal?: number;
  /**
   * The classic withdrawal rate of the first fully retired year (or the named
   * reason there is none). Not a scalar like its neighbours, but still
   * subtractable: the delta builder compares the `rate` members and reports
   * kind transitions in words, the way the shortfall year reports null.
   */
  withdrawal: WithdrawalRateStat;
  /**
   * The run's guardrails cut/raise statistics. ABSENT MEANS THE PLAN HAS NO
   * RAILS TO REPORT, and the two spending rows then say the plan never
   * adjusts spending rather than vanishing — the tile-never-goes-blank rule
   * the withdrawal stat set. (fixed_percent technically re-prices spending
   * every year, but it has no cut/raise events to count, and the app's own
   * policy comparisons offer fixed_real vs guardrails — the search-axis rule
   * — so the wording states the case that exists.)
   */
  guardrails?: GuardrailStats;
  /**
   * How many paths produced these numbers, so a delta is never drawn between
   * two runs that were not measured the same way.
   *
   * The Workbench runs at mcPathsInteractive while knobs move and at
   * mcPathsFinal when Run now is pressed, and the gap between those two is
   * real: the user read 93.1% on screen against 94.2% recorded for the same
   * plan and took the 1.0pt for a change in the plan. It was the path count.
   * `comparableRun` is what stops the strip drawing that chip.
   *
   * UNDEFINED MEANS THE PATH COUNT IS NOT KNOWN, not that it is zero, and an
   * unknown one is treated as comparable — the only metrics without it are
   * hand-built ones in tests.
   */
  paths?: number;
}

export function runMetrics(
  result: Pick<
    RunResult,
    'success' | 'medianTerminalReal' | 'worstDecileShortfallYears' | 'referencePath' | 'guardrailStats'
  > & { breakGlassReal?: number | null; meta?: Pick<RunMeta, 'paths'> },
): RunMetrics {
  let shortfallYear: number | null = null;
  if (result.success < 1) {
    shortfallYear =
      typicalShortfallYear(result.worstDecileShortfallYears) ??
      referencePathInsolvencyYear(result.referencePath);
  }
  return {
    success: result.success,
    medianTerminalReal: result.medianTerminalReal,
    shortfallYear,
    breakGlassReal: result.breakGlassReal ?? undefined,
    withdrawal: classicWithdrawalRate(result.referencePath),
    guardrails: result.guardrailStats,
    paths: result.meta?.paths,
  };
}

export type MetricKey =
  | 'success'
  | 'terminal'
  | 'withdrawal'
  | 'guardCut'
  | 'guardRaise'
  | 'shortfall'
  | 'breakGlass';

/**
 * One metric, formatted for the strip: what it is now, and how far it moved
 * from the comparison run.
 *
 * `direction` is the sign of the move, not its goodness — `tone` says whether
 * that move is good news. They differ for the shortfall year, where a LATER
 * year (a positive move) is good news, and where "the money no longer runs
 * out" is the best news of all.
 */
export interface MetricDelta {
  key: MetricKey;
  label: string;
  /** The current run's value, formatted ("52.5%", "$1,240,000", "2049"). */
  value: string;
  /** Signed change ("+12.8 pts"), 'no change', or null when nothing to compare. */
  change: string | null;
  direction: 'up' | 'down' | 'flat' | 'none';
  tone: 'good' | 'bad' | 'neutral';
  /** Optional second line under the value (the guardrails translation). */
  note?: string;
  /** Hover text: what the number counts, what it leaves out, and why. */
  tooltip?: string;
  /**
   * Hover text for the CHANGE CHIP alone, separate from `tooltip` because they
   * answer different questions: `tooltip` defines the metric and rides on the
   * whole tile, this one explains what the app did with the difference. Today
   * it is the unresolved case — a chip that declines to report a move has to be
   * able to say why on the chip itself.
   */
  changeTitle?: string;
}

/** Leading '+' for positive numbers; negatives already carry their own sign. */
function signed(n: number, body: string): string {
  return n > 0 ? `+${body}` : body;
}

/**
 * THE CHIP THAT DECLINES TO REPORT A MOVE.
 *
 * The word is the Search page's, deliberately: searchLogic.verdictWord already
 * calls this state "not resolved" and keeps it apart from "same plan", because
 * one is a finding and the other is a confession. The strip now has the same
 * two states and must not blur them either — `no change` means the two runs
 * produced the identical fraction, `not resolved` means they did not and the
 * difference is smaller than the runs can see.
 */
export const UNRESOLVED_CHIP = 'not resolved';

/**
 * What a fraction-of-paths tile says when the difference is inside the noise.
 *
 * THE DIFFERENCE IS STILL PRINTED, in the sentence that disowns it. Hiding it
 * would be the other failure mode: the user asked what the toggle did, and
 * "nothing measurable, and here is how small the thing I could not measure is"
 * answers them, while a blank does not. What must not happen is the number
 * appearing in the chip, where an arrow and a colour would read it as a verdict.
 *
 * AND THE WAY TO A REAL ANSWER IS NAMED. Run now sits on the same card, four
 * lines above, and re-runs the plan at the conditions every recorded score uses;
 * the Search page is the one that resolves a difference this small properly,
 * paired across seeds. A dead end here would just teach the user to squint at
 * the chip again.
 */
function unresolvedChange(
  difference: number,
  resolution: number,
): Pick<MetricDelta, 'change' | 'direction' | 'tone' | 'note' | 'changeTitle'> {
  const moved = `${signed(difference, points(difference))} pts`;
  const band = `±${points(resolution)} pts at ${CI_LABEL_95}`;
  return {
    change: UNRESOLVED_CHIP,
    // FLAT, NOT UP OR DOWN: direction drives the arrow, and an arrow is a claim
    // about which way the plan moved. That claim is the one thing these two
    // runs cannot support.
    direction: 'flat',
    tone: 'neutral',
    note:
      `No measurable change: ${moved} is inside what these two runs resolve (${band}). Run now ` +
      `re-runs at the recorded conditions; the Search page measures effects this small, paired ` +
      `across seeds.`,
    changeTitle:
      `The two runs differ by ${moved}, which is inside the ${band} a difference between runs ` +
      `this size carries — so the app will not call it a move`,
  };
}

/**
 * What the success rate counts, and — the part that was missing — how precisely
 * this run counted it. The tile is the app's headline statistic and carried no
 * definition at all until the 1,000-path run started being read as exact.
 */
const SUCCESS_TOOLTIP =
  'The fraction of simulated futures in which the money never ran out and the portfolio ' +
  'finished at or above the terminal-value floor in your settings. It is an ESTIMATE from ' +
  'this run’s paths, not a measurement: the chip above the verdict states how precisely ' +
  'these paths pinned it down, and re-running the same plan at a different path count moves ' +
  'it by about that much with nothing about the plan having changed.';

function successDelta(current: RunMetrics, comparison: RunMetrics | null): MetricDelta {
  const base: Pick<MetricDelta, 'key' | 'label' | 'value' | 'tooltip'> = {
    key: 'success',
    label: 'Success',
    value: formatPct(current.success, 1),
    tooltip: SUCCESS_TOOLTIP,
  };
  if (!comparison) return { ...base, change: null, direction: 'none', tone: 'neutral' };
  const d = current.success - comparison.success;
  if (d === 0) return { ...base, change: 'no change', direction: 'flat', tone: 'neutral' };
  /*
   * A MOVE THE RUNS CANNOT SEE IS NOT REPORTED AS A MOVE. The tithing hold
   * period at 1,000 paths moves this fraction from 0.930 to 0.929 — 0.1 points,
   * against a ±2.2-point resolution between two runs that size — and the strip
   * drew "-0.1 pts" over it with an arrow and a colour. See
   * pathFractionDeltaResolution for why the bound is the unpaired one.
   */
  const resolution = pathFractionDeltaResolution(
    { fraction: current.success, paths: current.paths },
    { fraction: comparison.success, paths: comparison.paths },
  );
  if (resolution !== null && Math.abs(d) < resolution) {
    return { ...base, ...unresolvedChange(d, resolution) };
  }
  // Percentage POINTS, not percent: 0.397 -> 0.525 is +12.8 points, and
  // calling that "+32%" (the relative change) would be the wrong number.
  const pts = d * 100;
  return {
    ...base,
    change: `${signed(d, pts.toFixed(1))} pts`,
    direction: d > 0 ? 'up' : 'down',
    tone: d > 0 ? 'good' : 'bad',
  };
}

function terminalDelta(current: RunMetrics, comparison: RunMetrics | null): MetricDelta {
  const base: Pick<MetricDelta, 'key' | 'label' | 'value'> = {
    key: 'terminal',
    label: 'Median terminal (real)',
    value: formatUSD(current.medianTerminalReal),
  };
  if (!comparison) return { ...base, change: null, direction: 'none', tone: 'neutral' };
  const d = current.medianTerminalReal - comparison.medianTerminalReal;
  if (d === 0) return { ...base, change: 'no change', direction: 'flat', tone: 'neutral' };
  return {
    ...base,
    change: signed(d, formatCompactUSD(d)),
    direction: d > 0 ? 'up' : 'down',
    tone: d > 0 ? 'good' : 'bad',
  };
}

/**
 * The tooltip, per the house rule that a statistic must carry its own
 * definition: one sentence for what counts, one for what does not, one for
 * why the first fully retired year, one for the divisor. The full field-by-
 * field ruling lives on classicWithdrawalRate; this is the plain-language
 * rendering of the same list.
 */
const WITHDRAWAL_RATE_TOOLTIP =
  'Counts everything the portfolio had to fund that year — living costs (including ' +
  'life-insurance premiums), giving, housing, health, one-time costs and taxes — minus the ' +
  'money that came from outside it (Social Security, pension or other retirement income, ' +
  "one-time income). Interest and dividends are the portfolio's own return and transfers " +
  'into the brokerage stay inside the portfolio, so neither reduces the rate. Measured on ' +
  'the first year nobody earned a salary at all, because the retirement year itself is ' +
  'still part-paid by wages and would understate the rate. The divisor is the portfolio ' +
  "the year opened with — the prior year's closing spendable balance. " +
  // The lifetime clause's own two sentences: what was summed, and the warning
  // that the figure is NOT a mean of the yearly rates (with the why in one
  // clause) — the trap a whole-life comparison against the 4% rule invites.
  'The lifetime-equivalent figure sums every dollar the portfolio funded across all fully ' +
  'retired years — one-time gifts included — in real start-year dollars, and divides the ' +
  "per-year average by the first fully retired year's real opening balance: this plan funds " +
  'the real-dollar equivalent of that constant-percentage rule. It is NOT an average of the ' +
  "yearly percentages, which answers no question because each year's percentage sits on a " +
  'different denominator.';

/** The guardrails second line, in the headline's units, honest about its base. */
function railsNote(rails: GuardrailRailsView): string {
  return (
    `Guardrails react to the living portion only: anchored at ${formatPct(rails.anchor, 2)} ` +
    `of the start-of-year portfolio, spending is cut above ${formatPct(rails.cutAbove, 2)} ` +
    `and raised below ${formatPct(rails.raiseBelow, 2)}.`
  );
}

function withdrawalDelta(current: RunMetrics, comparison: RunMetrics | null): MetricDelta {
  const cur = current.withdrawal;
  /*
   * THE VALUE NAMES ITS YEAR. "5.3%" alone invites the misreading the blend
   * year makes tempting ("that's this year's rate"); "5.3% of the portfolio
   * in 2029" is a statement the user can check against the cashflow table.
   * The rateless kinds put their reason where the number would be, so the
   * tile never goes blank and never shows a number it cannot stand behind.
   *
   * The second clause is the whole-retirement companion: the constant-
   * equivalent real draw, in the 4%-rule's own initial-rate units (see
   * lifetimeEquivalentDraw for the arithmetic and the mean-of-percentages
   * trap it exists to avoid). Omitted when fewer than two retired years are
   * priced — a one-year "lifetime" would restate the headline beside it.
   */
  const lifetimeClause =
    cur.kind === 'rate' && cur.lifetime !== null
      ? ` — lifetime-equivalent ${formatPct(cur.lifetime.rate, 1)} over ${cur.lifetime.years} years`
      : '';
  const base: Pick<MetricDelta, 'key' | 'label' | 'value' | 'note' | 'tooltip'> = {
    key: 'withdrawal',
    label: 'Withdrawal rate when fully retired',
    value:
      cur.kind === 'rate'
        ? `${formatPct(cur.rate, 1)} of the portfolio in ${cur.year}${lifetimeClause}`
        : cur.kind === 'never-retired'
          ? 'never fully retired in this horizon'
          : `not stated — no opening balance for ${cur.year}`,
    note: cur.kind === 'rate' && cur.rails !== null ? railsNote(cur.rails) : undefined,
    tooltip: WITHDRAWAL_RATE_TOOLTIP,
  };
  if (!comparison) return { ...base, change: null, direction: 'none', tone: 'neutral' };
  const cmp = comparison.withdrawal;
  if (cur.kind !== 'rate') {
    if (cmp.kind !== 'rate') {
      // Neither run states a rate. When the REASON changed the value already
      // says the new one, so the chip only admits there is still nothing to
      // subtract rather than claiming "no change" about a line that moved.
      return {
        ...base,
        change: cur.kind === cmp.kind ? 'no change' : 'still none',
        direction: 'flat',
        tone: 'neutral',
      };
    }
    /*
     * Appearing or disappearing has no pts-difference to report — and unlike
     * the shortfall year the transition carries no verdict: a rate that
     * vanished because the retire date slid past the horizon is a DIFFERENT
     * PLAN, not a better or worse rate. Tone stays neutral and the arrow is
     * withheld ('flat'), because an arrow would claim the rate itself moved,
     * which is exactly what did not happen.
     */
    return {
      ...base,
      change: `gone (was ${formatPct(cmp.rate, 1)})`,
      direction: 'flat',
      tone: 'neutral',
    };
  }
  if (cmp.kind !== 'rate') {
    return { ...base, change: 'new (was none)', direction: 'flat', tone: 'neutral' };
  }
  // THE DELTA RIDES THE HEADLINE RATE ALONE. The lifetime figure moves too,
  // but two signed chips on one tile is noise: the headline is the number the
  // tile is named for, and the lifetime clause already shows its new value in
  // the same breath — the reader who wants its movement can read both runs.
  const d = cur.rate - cmp.rate;
  if (d === 0) return { ...base, change: 'no change', direction: 'flat', tone: 'neutral' };
  // Percentage POINTS, like the success metric: 5.3% -> 4.9% is "-0.4 pts".
  const pts = d * 100;
  return {
    ...base,
    change: `${signed(d, pts.toFixed(1))} pts`,
    direction: d > 0 ? 'up' : 'down',
    // LOWER IS BETTER — the one strip metric where down is the good arrow:
    // drawing a smaller share of the portfolio is the safer plan.
    tone: d > 0 ? 'bad' : 'good',
  };
}

// ---------------------------------------------------------------------------
// The guardrails pair: futures cut below plan, futures raised above it
// ---------------------------------------------------------------------------

/**
 * Whole-percent formatting for the guardrails fractions ("23%", "61%") — with
 * one decimal rescued for a real-but-small fraction, because "0% hit the 70%
 * floor" about futures that DID hit it is exactly the kind of rounding lie
 * these tiles exist to avoid.
 */
function wholePct(f: number): string {
  const whole = formatPct(f, 0);
  return whole === '0%' && f > 0 ? formatPct(f, 1) : whole;
}

/**
 * "5 yrs", "1 yr", "3.5 yrs" — the median of integer year-counts can be a
 * half. (Not `yearsText` below: that one spells out "years" for the pot's
 * whole-year hold; this abbreviates to fit inside a tile's parenthetical.)
 */
function yrsShort(n: number): string {
  const body = Number.isInteger(n) ? String(n) : n.toFixed(1);
  return `${body} ${n === 1 ? 'yr' : 'yrs'}`;
}

/** What the spending rows say when the run has no rails: words, not a blank. */
const NEVER_ADJUSTS = 'never — this plan never adjusts spending';

/**
 * The cut row's value: "23% (typically bottoming at 87% of plan, 5 yrs
 * below)". The parenthetical describes THE CUT FUTURES ONLY — the engine's
 * medians are conditional on cutting (GuardrailStats), the label's own "where
 * spending ever gets cut" names that population, and the tooltip spells the
 * conditionality out. The floor clause rides along only when somebody
 * actually hit it, so a plan whose cuts never reach the floor is not told
 * about a 0% event.
 */
function guardCutValue(g: GuardrailStats): string {
  if (g.everCutFraction === 0) return 'none ever';
  const parts: string[] = [];
  if (g.medianMinFactorAmongCut !== null && g.medianYearsBelowAmongCut !== null) {
    parts.push(
      `typically bottoming at ${formatPct(g.medianMinFactorAmongCut, 0)} of plan, ` +
        `${yrsShort(g.medianYearsBelowAmongCut)} below`,
    );
  }
  if (g.floorTouchedFraction > 0) {
    parts.push(`${wholePct(g.floorTouchedFraction)} hit the ${formatPct(g.floor, 0)} floor`);
  }
  const head = wholePct(g.everCutFraction);
  return parts.length > 0 ? `${head} (${parts.join('; ')})` : head;
}

const GUARD_CUT_TOOLTIP =
  'The share of simulated futures in which the guardrails ever cut real spending below the ' +
  "plan's figure. The depth and duration in parentheses are medians among those cut futures " +
  'only — futures that never cut do not dilute them — so they answer "when a cut happens, how ' +
  'deep and how long", not "what usually happens". A cut the floor absorbed entirely moved ' +
  'nothing and does not count as one.';

/** The raise tooltip names the ceiling when the run had one, so 61% under a cap reads as capped. */
function guardRaiseTooltip(g: GuardrailStats | undefined): string {
  const base =
    'The prosperity side of the same rails: the share of simulated futures in which real ' +
    "spending ever rose above the plan's figure. More such futures are neither good news nor " +
    'bad — they mean the portfolio ran ahead of the plan and the band spent some of the ' +
    'surplus.';
  return g?.ceiling !== undefined
    ? `${base} Raises in this run are capped at ${formatPct(g.ceiling, 0)} of plan.`
    : base;
}

function guardCutDelta(current: RunMetrics, comparison: RunMetrics | null): MetricDelta {
  const cur = current.guardrails;
  const base: Pick<MetricDelta, 'key' | 'label' | 'value' | 'tooltip'> = {
    key: 'guardCut',
    label: 'Futures where spending ever gets cut',
    value: cur === undefined ? NEVER_ADJUSTS : guardCutValue(cur),
    tooltip: GUARD_CUT_TOOLTIP,
  };
  if (!comparison) return { ...base, change: null, direction: 'none', tone: 'neutral' };
  const cmp = comparison.guardrails;
  if (cur === undefined && cmp === undefined) {
    return { ...base, change: 'no change', direction: 'flat', tone: 'neutral' };
  }
  /*
   * The statistic appearing or disappearing means the POLICY changed, not
   * that cutting became more or less likely — a different plan, the
   * withdrawal tile's own ruling: no arrow, no verdict.
   */
  if (cur === undefined) {
    return {
      ...base,
      change: `gone (was ${wholePct((cmp as GuardrailStats).everCutFraction)})`,
      direction: 'flat',
      tone: 'neutral',
    };
  }
  if (cmp === undefined) {
    return { ...base, change: 'new (was none)', direction: 'flat', tone: 'neutral' };
  }
  const d = cur.everCutFraction - cmp.everCutFraction;
  if (d === 0) return { ...base, change: 'no change', direction: 'flat', tone: 'neutral' };
  /*
   * THE SAME GUARD AS THE SUCCESS TILE, because this is the same kind of
   * number: metrics.ts's aggregateGuardrailStats divides a count of paths by
   * the same path count the success rate uses, so it is a binomial fraction
   * with a binomial standard error. It is the WIDER of the two here — a
   * fraction near 0.23 has more variance than one near 0.96 — which is exactly
   * why it needed the guard rather than being spared it.
   */
  const resolution = pathFractionDeltaResolution(
    { fraction: cur.everCutFraction, paths: current.paths },
    { fraction: cmp.everCutFraction, paths: comparison.paths },
  );
  if (resolution !== null && Math.abs(d) < resolution) {
    return { ...base, ...unresolvedChange(d, resolution) };
  }
  const pts = d * 100;
  return {
    ...base,
    change: `${signed(d, pts.toFixed(1))} pts`,
    direction: d > 0 ? 'up' : 'down',
    // FEWER futures forced to cut is the good direction — unlike its raise
    // neighbour, this fraction carries a verdict: a cut is the plan failing
    // to deliver the spending it promised.
    tone: d > 0 ? 'bad' : 'good',
  };
}

function guardRaiseDelta(current: RunMetrics, comparison: RunMetrics | null): MetricDelta {
  const cur = current.guardrails;
  const base: Pick<MetricDelta, 'key' | 'label' | 'value' | 'tooltip'> = {
    key: 'guardRaise',
    label: 'Futures where spending rises above plan',
    value:
      cur === undefined
        ? NEVER_ADJUSTS
        : cur.everAbovePlanFraction === 0
          ? 'none ever'
          : wholePct(cur.everAbovePlanFraction),
    tooltip: guardRaiseTooltip(cur),
  };
  if (!comparison) return { ...base, change: null, direction: 'none', tone: 'neutral' };
  const cmp = comparison.guardrails;
  if (cur === undefined && cmp === undefined) {
    return { ...base, change: 'no change', direction: 'flat', tone: 'neutral' };
  }
  if (cur === undefined) {
    return {
      ...base,
      change: `gone (was ${wholePct((cmp as GuardrailStats).everAbovePlanFraction)})`,
      direction: 'flat',
      tone: 'neutral',
    };
  }
  if (cmp === undefined) {
    return { ...base, change: 'new (was none)', direction: 'flat', tone: 'neutral' };
  }
  const d = cur.everAbovePlanFraction - cmp.everAbovePlanFraction;
  if (d === 0) return { ...base, change: 'no change', direction: 'flat', tone: 'neutral' };
  // A fraction of paths, so the success tile's guard applies unchanged.
  const resolution = pathFractionDeltaResolution(
    { fraction: cur.everAbovePlanFraction, paths: current.paths },
    { fraction: cmp.everAbovePlanFraction, paths: comparison.paths },
  );
  if (resolution !== null && Math.abs(d) < resolution) {
    return { ...base, ...unresolvedChange(d, resolution) };
  }
  const pts = d * 100;
  return {
    ...base,
    change: `${signed(d, pts.toFixed(1))} pts`,
    direction: d > 0 ? 'up' : 'down',
    /*
     * NEUTRAL IN BOTH DIRECTIONS, deliberately. More above-plan futures says
     * the portfolio ran ahead of the plan more often — but a ceiling the
     * owner just added REDUCES this number on purpose, and painting that red
     * would scold them for getting exactly what they asked for. The arrow still
     * reports which way it moved; the verdict is theirs.
     */
    tone: 'neutral',
  };
}

function shortfallDelta(current: RunMetrics, comparison: RunMetrics | null): MetricDelta {
  /*
   * THE VALUE CARRIES ITS OWN CONDITION. "Typical shortfall year: 2042" on a
   * 93.1% plan read as "this plan typically runs out in 2042" — the user said
   * so — when the statistic is computed ONLY from the futures that fail. The
   * failing share rides along in the value because a label cannot hold the
   * caveat and a bare year actively misleads: the right reading is "failure is
   * rare, and WHEN it happens it happens mid-plan", which is a statement about
   * sequence risk, not about the plan's typical outcome.
   */
  const failingShare =
    current.success < 1 ? ` (in the ${((1 - current.success) * 100).toFixed(1)}% that fail)` : '';
  const base: Pick<MetricDelta, 'key' | 'label' | 'value'> = {
    key: 'shortfall',
    label: 'If a future fails, money runs out around',
    value: current.shortfallYear === null ? 'none ever' : `${current.shortfallYear}${failingShare}`,
  };
  if (!comparison) return { ...base, change: null, direction: 'none', tone: 'neutral' };
  const cur = current.shortfallYear;
  const cmp = comparison.shortfallYear;
  if (cur === null && cmp === null) {
    return { ...base, change: 'no change', direction: 'flat', tone: 'neutral' };
  }
  // Gaining or losing a shortfall entirely is the biggest move there is, and
  // it has no year-difference to report — say what happened instead.
  if (cur === null) return { ...base, change: `gone (was ${cmp})`, direction: 'up', tone: 'good' };
  if (cmp === null) return { ...base, change: 'new (was none)', direction: 'down', tone: 'bad' };
  const d = cur - cmp;
  if (d === 0) return { ...base, change: 'no change', direction: 'flat', tone: 'neutral' };
  const years = `${Math.abs(d) === 1 ? '1 yr' : `${Math.abs(d)} yrs`}`;
  return {
    ...base,
    // Later is better: the money lasting three more years is "+3 yrs".
    change: `${d > 0 ? '+' : '-'}${years}`,
    direction: d > 0 ? 'up' : 'down',
    tone: d > 0 ? 'good' : 'bad',
  };
}

/**
 * The tithe carve-out that a failing future left on the table.
 *
 * TONE IS ALWAYS NEUTRAL, deliberately, and it is the only metric here that
 * works that way. A bigger untapped carve-out is not good news (the household
 * is richer than the success rate admits) and not bad news (it is money the
 * plan promised away); it is the SIZE OF A CHOICE — what breaking the escrow
 * would have been worth in the years it would have mattered. (A soft-window
 * failure has already made that choice automatically: the ordering spends the
 * pot last, so such futures report ~0 here.) Painting it green or red would
 * answer a question that is the user's to answer. The arrow still reports
 * which way it moved.
 */
function breakGlassDelta(current: RunMetrics, comparison: RunMetrics | null): MetricDelta {
  const cur = current.breakGlassReal;
  /*
   * "Break glass (real)" was a working name from the design conversation and
   * meant nothing on screen — the user said so. The label now asks the
   * question the metric answers, and $0 carries its meaning inline: the value
   * every giving configuration should want, because it says no failing future
   * ever died beside charity money it was allowed to use.
   */
  const base: Pick<MetricDelta, 'key' | 'label' | 'value'> = {
    key: 'breakGlass',
    label: 'Tithe escrow left if money runs out',
    value:
      cur === undefined ? 'none' : cur === 0 ? '$0 — already given or spent' : formatUSD(cur),
  };
  const cmp = comparison?.breakGlassReal;
  if (!comparison) return { ...base, change: null, direction: 'none', tone: 'neutral' };
  if (cur === undefined && cmp === undefined) {
    return { ...base, change: 'no change', direction: 'flat', tone: 'neutral' };
  }
  // Gaining or losing the figure entirely has no difference to report — say
  // what happened, the way the shortfall year does.
  if (cur === undefined) {
    return { ...base, change: `gone (was ${formatCompactUSD(cmp ?? 0)})`, direction: 'down', tone: 'neutral' };
  }
  if (cmp === undefined) return { ...base, change: 'new (was none)', direction: 'up', tone: 'neutral' };
  const d = cur - cmp;
  if (d === 0) return { ...base, change: 'no change', direction: 'flat', tone: 'neutral' };
  return {
    ...base,
    change: signed(d, formatCompactUSD(d)),
    direction: d > 0 ? 'up' : 'down',
    tone: 'neutral',
  };
}

/**
 * The metrics strip: current values plus the signed move against `comparison`
 * (the pinned baseline when there is one, else the immediately previous run).
 * A null comparison — the first run of a session — yields values with no
 * change chips rather than fake zeros.
 *
 * The break-glass tile appears only when there is a figure to report on ONE
 * side or the other, so a plan with no tithe carve-out — or one no future ever
 * failed — keeps the three-tile strip it has always had. Losing the figure is
 * itself worth a tile, which is why the comparison is checked too.
 *
 * WHICH TILES REFUSE AN UNRESOLVED DIFFERENCE, AND WHY THE REST DO NOT. Three
 * of them are fractions of paths — success, and the two guardrails rows — so a
 * binomial standard error applies exactly and they carry the guard. The others
 * are left alone ON PURPOSE, because an error bar invented for a statistic
 * whose sampling distribution nobody has worked out is the same lie in a lab
 * coat:
 *
 *  - MEDIAN TERMINAL is a sample median, whose standard error is
 *    1 / (2 f(m) sqrt(n)) and needs the density of terminal wealth at the
 *    median. RunResult carries a five-point fan (p10/p25/p50/p75/p90) and no
 *    density, and estimating one off two quartiles 25 points apart would be a
 *    guess wearing an interval.
 *  - THE SHORTFALL YEAR is a median over the worst-decile histogram — roughly
 *    a tenth of the paths, and on this plan only ~45 of 1,000 fail at all. It
 *    is coarse in a way a year-granular figure cannot express, and it is
 *    reported in whole years, which is its own admission.
 *  - THE WITHDRAWAL RATE is read off the single deterministic reference path.
 *    It does not move with the path count at all, so there is no sampling
 *    error to state — a different fact from having a small one.
 *  - THE TITHE ESCROW is a median over the failing paths only, so it inherits
 *    the median problem above AND a denominator that shrinks as the plan
 *    improves.
 *
 * Sustainable spend has the same shape as the last two — a solver's answer, not
 * a sample statistic — and is reported on the History tab rather than here, at
 * the path count printed beside it.
 */
export function computeDeltas(
  current: RunMetrics,
  comparison: RunMetrics | null,
): MetricDelta[] {
  const deltas = [
    successDelta(current, comparison),
    terminalDelta(current, comparison),
    // Third, between the outcome pair above and the failure pair below: the
    // withdrawal rate describes the plan's draw, not its verdict, and it is
    // ALWAYS present — a rateless run states its reason in the value.
    withdrawalDelta(current, comparison),
    // The guardrails pair sits with the behaviour tiles, not the failure
    // pair: cuts and raises are the plan working as designed, and both rows
    // are ALWAYS present — a run without rails says so in words.
    guardCutDelta(current, comparison),
    guardRaiseDelta(current, comparison),
    shortfallDelta(current, comparison),
  ];
  if (current.breakGlassReal !== undefined || comparison?.breakGlassReal !== undefined) {
    deltas.push(breakGlassDelta(current, comparison));
  }
  return deltas;
}

/**
 * The comparison run, or null when subtracting the two would report method
 * rather than plan.
 *
 * TWO RUNS ARE ONLY SUBTRACTABLE AT THE SAME PATH COUNT. Monte Carlo at 1,000
 * paths and the same plan at 10,000 land a point or so apart with nothing
 * whatever having changed, and a chip reading "+1.0 pts" beside them says the
 * plan improved. That chip is the exact mistake this app went looking for: the
 * owner compared 93.1% on screen (mcPathsInteractive) with 94.2% recorded by
 * the History tab (mcPathsFinal) and read the difference as the plan moving.
 *
 * An unknown path count on either side is treated as comparable — suppressing
 * every chip because a hand-built metrics object carries no meta would cost the
 * strip its whole reason for existing.
 */
export function comparableRun(
  current: RunMetrics,
  comparison: RunMetrics | null,
): RunMetrics | null {
  if (comparison === null) return null;
  if (current.paths === undefined || comparison.paths === undefined) return comparison;
  return current.paths === comparison.paths ? comparison : null;
}

/**
 * WHAT A CHIP SAYS WHEN THERE IS NO CHANGE TO SHOW — and it is not always the
 * same reason.
 *
 * The chip read "first run" for both cases, which is true of the first run of a
 * session and false the moment `comparableRun` throws a comparison out: after a
 * Run now there IS a previous run, it is on the same plan, and what disqualified
 * it was the path count. Telling the user "first run" there teaches them the app
 * forgets, which is the opposite of the thing being built.
 */
export function noChangeChip(methodMismatch: boolean): { text: string; title: string } {
  return methodMismatch
    ? {
        text: 'not comparable',
        title:
          'The run before this one used a different number of paths — a difference between two ' +
          'path counts is method, not plan',
      }
    : { text: 'first run', title: 'Nothing to compare against yet' };
}

/**
 * What the delta chips are measured against, in one line.
 *
 * `methodMismatch` is the case where there IS a comparison run and it was
 * thrown out by `comparableRun`: saying "first run" there would be a lie, and
 * saying nothing would leave the missing chips unexplained at exactly the
 * moment the reader is looking for them.
 */
export function comparisonNote(
  baselineLabel: string | null,
  hasPrevious: boolean,
  methodMismatch = false,
): string {
  if (methodMismatch) {
    return (
      'No change shown — the run this would be measured against used a different number of ' +
      'paths, and the difference between two path counts is method, not plan'
    );
  }
  if (baselineLabel !== null) return `Change vs pinned baseline — ${baselineLabel}`;
  if (hasPrevious) return 'Change vs the previous run';
  return 'First run — nothing to compare against yet';
}

// ---------------------------------------------------------------------------
// Plan-level spending override (assumption_overrides.expenses)
// ---------------------------------------------------------------------------

/**
 * Every monthly figure a plan can override — BOTH sides of each pair. Living
 * and investing have a plain retired counterpart; giving's retired side is a
 * rule (`retirementGiving`, below) rather than a number, which is why it has no
 * `charitableMonthlyRetired` here.
 */
export type ExpenseKey =
  | 'livingMonthly'
  | 'livingMonthlyRetired'
  | 'charitableMonthly'
  | 'investingMonthly'
  | 'investingMonthlyRetired';

export const EXPENSE_KEYS: readonly ExpenseKey[] = [
  'livingMonthly',
  'livingMonthlyRetired',
  'charitableMonthly',
  'investingMonthly',
  'investingMonthlyRetired',
];

export function expenseOverride(
  overrides: AssumptionOverrides | undefined,
  key: ExpenseKey,
): number | undefined {
  return overrides?.expenses?.[key];
}

/** The value the run will actually use: the override if set, else the profile's. */
export function effectiveMonthly(profileValue: number, override: number | undefined): number {
  return override ?? profileValue;
}

/**
 * Reattach an `expenses` block to the overrides, pruning upward: an empty
 * block takes the `expenses` key with it, and an otherwise-empty overrides
 * object collapses to `undefined`. That matters because the scenario file is
 * read by a human — a scenario back on the profile's spending should say so by
 * having no `expenses` key at all, not by carrying an empty object.
 */
function withExpenses(
  overrides: AssumptionOverrides | undefined,
  expenses: NonNullable<AssumptionOverrides['expenses']>,
): AssumptionOverrides | undefined {
  const next: AssumptionOverrides = { ...overrides };
  if (Object.keys(expenses).length === 0) delete next.expenses;
  else next.expenses = expenses;
  return Object.keys(next).length === 0 ? undefined : next;
}

/**
 * Set (or clear, with `undefined`) one monthly expense override, returning a
 * NEW overrides object — the input is never mutated.
 */
export function setExpenseOverride(
  overrides: AssumptionOverrides | undefined,
  key: ExpenseKey,
  value: number | undefined,
): AssumptionOverrides | undefined {
  const expenses: NonNullable<AssumptionOverrides['expenses']> = { ...overrides?.expenses };
  if (value === undefined) delete expenses[key];
  else expenses[key] = value;
  return withExpenses(overrides, expenses);
}

// ---------------------------------------------------------------------------
// Plan-level LIFE INSURANCE override
// ---------------------------------------------------------------------------
//
// The policy is deliberately overridable at plan level, for the same reason
// spending is: "five years of term at retirement" is a QUESTION ABOUT A PLAN,
// not a fact about the household, and it has to be askable without editing
// profile.json — two plans must be able to disagree about the policy at the
// same time. That is the entire mechanism behind "does this premium buy enough
// widow score to be worth paying?", which is not answerable by a household that
// can only hold one answer.
//
// Kept separate from ExpenseKey rather than folded into it because these are not
// all monthly dollars: the premium is, the face amount is a one-off nominal
// figure, and the term end is a date.

/** The two policy fields that carry money. */
export type PolicyMoneyKey = 'lifeInsuranceMonthly' | 'lifeInsuranceDeathBenefit';

export function policyMoneyOverride(
  overrides: AssumptionOverrides | undefined,
  key: PolicyMoneyKey,
): number | undefined {
  return overrides?.expenses?.[key];
}

/** Set (or clear, with `undefined`) the premium or the face amount. Never mutates. */
export function setPolicyMoneyOverride(
  overrides: AssumptionOverrides | undefined,
  key: PolicyMoneyKey,
  value: number | undefined,
): AssumptionOverrides | undefined {
  const expenses: NonNullable<AssumptionOverrides['expenses']> = { ...overrides?.expenses };
  if (value === undefined) delete expenses[key];
  else expenses[key] = value;
  return withExpenses(overrides, expenses);
}

export function termEndOverride(
  overrides: AssumptionOverrides | undefined,
): YearMonth | undefined {
  return overrides?.expenses?.lifeInsuranceTermEnd;
}

/** Set (or clear, with `undefined`) the last month of coverage. Never mutates. */
export function setTermEndOverride(
  overrides: AssumptionOverrides | undefined,
  value: YearMonth | undefined,
): AssumptionOverrides | undefined {
  const expenses: NonNullable<AssumptionOverrides['expenses']> = { ...overrides?.expenses };
  if (value === undefined || value === '') delete expenses.lifeInsuranceTermEnd;
  else expenses.lifeInsuranceTermEnd = value;
  return withExpenses(overrides, expenses);
}

/**
 * What an empty term-end box means, in words. An absent term end is NOT "no
 * coverage" and it is not "for life": the engine ends cover with the paycheck,
 * on the grounds that term life is income replacement. That is a real rule with
 * real consequences for a widow score, so the box says it rather than sitting
 * blank.
 */
export const TERM_END_PLACEHOLDER = 'ends with the paycheck';

// ---------------------------------------------------------------------------
// Per-policy dispositions (assumption_overrides.expenses.lifeInsurancePolicyPlans)
// ---------------------------------------------------------------------------
//
// For a profile carrying a POLICY LIST the three legacy override fields above
// are unreachable knobs: a non-empty `lifeInsurancePolicies` supersedes them
// entirely (engine resolvePolicies), so the workbench showed three live-looking
// inputs that changed nothing. The question the user actually has — "what if I
// cancelled one or both?" — is PER POLICY, and these helpers read and write the
// per-policy map on the same terms as every other override on the card: absent
// means "as the profile says", and clearing prunes upward so an untouched plan
// carries no key at all.

export function policyPlanOverride(
  overrides: AssumptionOverrides | undefined,
  policyId: string,
): LifeInsurancePolicyPlan | undefined {
  return overrides?.expenses?.lifeInsurancePolicyPlans?.[policyId];
}

/**
 * Set (or clear, with `undefined`) one policy's disposition. Never mutates.
 * Clearing the last disposition removes the map itself — then the `expenses`
 * block, then `assumption_overrides` — so a plan back on the profile's policies
 * says so by having no key, exactly like the neighbouring overrides.
 */
export function setPolicyPlanOverride(
  overrides: AssumptionOverrides | undefined,
  policyId: string,
  plan: LifeInsurancePolicyPlan | undefined,
): AssumptionOverrides | undefined {
  const plans: Record<string, LifeInsurancePolicyPlan> = {
    ...overrides?.expenses?.lifeInsurancePolicyPlans,
  };
  if (plan === undefined) delete plans[policyId];
  else plans[policyId] = plan;
  const expenses: NonNullable<AssumptionOverrides['expenses']> = { ...overrides?.expenses };
  if (Object.keys(plans).length === 0) delete expenses.lifeInsurancePolicyPlans;
  else expenses.lifeInsurancePolicyPlans = plans;
  return withExpenses(overrides, expenses);
}

/** The disposition a run will actually apply: the plan's, else the profile's flag. */
export function effectivePolicyPlan(
  policy: Pick<LifeInsurancePolicy, 'cancelAtRetirement'>,
  override: LifeInsurancePolicyPlan | undefined,
): LifeInsurancePolicyPlan {
  if (override !== undefined) return override;
  return policy.cancelAtRetirement === true ? 'cancel_at_retirement' : 'keep_to_term';
}

const MONTH_LABELS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
] as const;

/** "2032-12" -> "Dec 2032". Unparseable input comes back as typed, never NaN. */
export function monthLabel(ym: YearMonth): string {
  const m = /^(\d{4})-(\d{2})$/.exec(ym);
  if (!m) return ym;
  const month = Number(m[2]);
  if (month < 1 || month > 12) return ym;
  return `${MONTH_LABELS[month - 1]} ${m[1]}`;
}

/** "YYYY-MM" -> absolute month index, for coverage arithmetic. */
function ymAbs(ym: YearMonth): number {
  const m = /^(\d{4})-(\d{2})$/.exec(ym);
  if (!m) return Number.NaN;
  return Number(m[1]) * 12 + (Number(m[2]) - 1);
}

function absYm(abs: number): YearMonth {
  const year = Math.floor(abs / 12);
  const month = (abs % 12) + 1;
  return `${year}-${String(month).padStart(2, '0')}`;
}

/**
 * The month the household's LAST paycheck stops under this plan — the latest
 * retire date across everyone who draws a salary — or null when work never
 * stops (someone salaried has no retire event, or nobody draws a salary at
 * all). This is the date `cancelAtRetirement` bites on: the engine keeps a
 * cancel-at-retirement policy in force while ANY earner still works
 * (household.ts policyInForce reads the max worked months across people), so
 * one earner's own retirement is the wrong date the moment the other is still
 * earning.
 */
export function householdWorkStopMonth(
  events: readonly ScenarioEvent[],
  salaries: Record<string, number>,
): YearMonth | null {
  const earners = Object.keys(salaries).filter((id) => (salaries[id] ?? 0) > 0);
  if (earners.length === 0) return null;
  let latest: YearMonth | null = null;
  for (const id of earners) {
    const retire = events.find(
      (e): e is Extract<ScenarioEvent, { type: 'retire' }> =>
        e.type === 'retire' && e.person === id,
    );
    if (!retire) return null; // this earner never stops, so the household never does
    if (latest === null || retire.date > latest) latest = retire.date;
  }
  return latest;
}

/** "Jun 2028", or the honest words when the plan never stops working. */
export function workStopText(stopMonth: YearMonth | null): string {
  return stopMonth === null ? 'never in this plan' : monthLabel(stopMonth);
}

/**
 * One row's numbers, stated from the policy itself: "$158.33/mo · $2,500,000 ·
 * to Dec 2032". Cents on the premium because the real figure has them and
 * rounding would misstate a number this row exists to show verbatim.
 */
export function policyRowSummary(
  policy: Pick<LifeInsurancePolicy, 'premiumMonthly' | 'deathBenefit' | 'termEnd'>,
): string {
  const term = policy.termEnd !== undefined ? `to ${monthLabel(policy.termEnd)}` : 'no term end';
  return `${formatUSD(policy.premiumMonthly, { cents: true })}/mo · ${formatUSD(
    policy.deathBenefit,
  )} · ${term}`;
}

/** One choice in a policy's three-way control. '' = as the profile configures it. */
export interface PolicyPlanOption {
  value: '' | LifeInsurancePolicyPlan;
  label: string;
}

/**
 * The three-way control for one policy: "as configured" (clears the override),
 * the counterfactual the profile does NOT already do, and "cancel now". The
 * middle option flips per policy — a policy the profile keeps to term is
 * offered "cancel when work stops", one the profile already cancels there is
 * offered "keep to term" — because offering a disposition identical to the
 * profile's would be the inert-input bug again, one level down.
 *
 * `current` is appended when a saved plan carries exactly such a redundant
 * disposition (legal, and possible once the profile's own flag is edited): the
 * select must show what the file says rather than silently displaying a choice
 * the user never made.
 */
export function policyPlanOptions(
  policy: Pick<LifeInsurancePolicy, 'cancelAtRetirement' | 'termEnd'>,
  stopMonth: YearMonth | null,
  current: LifeInsurancePolicyPlan | undefined,
): PolicyPlanOption[] {
  const termText =
    policy.termEnd !== undefined ? `to ${monthLabel(policy.termEnd)}` : 'no term end';
  const keepLabel = `Keep to term (${termText})`;
  const cancelAtLabel = `Cancel when work stops (${workStopText(stopMonth)})`;
  const cancelsAtRetirement = policy.cancelAtRetirement === true;
  const options: PolicyPlanOption[] = [
    {
      value: '',
      label: `As configured (${
        cancelsAtRetirement ? `cancelled when work stops — ${workStopText(stopMonth)}` : termText
      })`,
    },
    cancelsAtRetirement
      ? { value: 'keep_to_term', label: keepLabel }
      : { value: 'cancel_at_retirement', label: cancelAtLabel },
    { value: 'cancel_now', label: 'Cancel now' },
  ];
  if (current !== undefined && !options.some((o) => o.value === current)) {
    options.push(
      current === 'keep_to_term'
        ? { value: 'keep_to_term', label: keepLabel }
        : { value: 'cancel_at_retirement', label: cancelAtLabel },
    );
  }
  return options;
}

/**
 * A stretch of months and what a death inside it pays: the caption's raw
 * material. `from` null = from the start of the plan; `to` null = to the
 * horizon.
 */
export interface CoverageBand {
  from: YearMonth | null;
  to: YearMonth | null;
  benefit: number;
}

/**
 * What the plan ACTUALLY pays on a death, month by month, after the per-policy
 * dispositions are applied — the truth the caption states. The old caption
 * read only the legacy single-policy fields, which a policy list supersedes,
 * so it told the user "no payout in this plan" while their plan carried
 * $3,500,000 of cover.
 *
 * Windows follow the engine exactly (household.ts policyInForce):
 * - 'cancel_now' contributes nothing;
 * - 'cancel_at_retirement' covers through the month BEFORE work stops (a
 *   retire date is the first month not worked), and never when the household
 *   has no earner to stop;
 * - 'keep_to_term' stands on the policy's own termStart/termEnd.
 *
 * Bands with the same total are merged, and a leading/trailing zero band is
 * dropped, so the caption reads "…$3.5M through Dec 2030, $2.5M through Dec 2032"
 * rather than enumerating every boundary twice.
 *
 * SUMMING ACROSS POLICIES ASSUMES ONE INSURED LIFE. The caller must pass
 * policies on the same person (group by `insured` first) — a $2.5M policy on one
 * life plus $1M on the other is never a $3.5M payout, because only one of them can be the
 * one who died.
 */
export function coverageBands(
  policies: ReadonlyArray<
    Pick<LifeInsurancePolicy, 'deathBenefit' | 'termStart' | 'termEnd' | 'cancelAtRetirement'> & {
      id: string;
    }
  >,
  plans: Record<string, LifeInsurancePolicyPlan> | undefined,
  stopMonth: YearMonth | null,
  hasEarner: boolean,
): CoverageBand[] {
  interface Window {
    startAbs: number | null;
    endAbs: number | null;
    benefit: number;
  }
  const windows: Window[] = [];
  for (const p of policies) {
    const plan = effectivePolicyPlan(p, plans?.[p.id]);
    if (plan === 'cancel_now' || p.deathBenefit <= 0) continue;
    let endAbs = p.termEnd !== undefined ? ymAbs(p.termEnd) : null;
    if (plan === 'cancel_at_retirement') {
      // No earner means no month in which anyone works, so a policy that only
      // exists while somebody does is never in force at all.
      if (!hasEarner) continue;
      if (stopMonth !== null) {
        const lastWorked = ymAbs(stopMonth) - 1; // retire date = first month NOT worked
        endAbs = endAbs === null ? lastWorked : Math.min(endAbs, lastWorked);
      }
    }
    windows.push({
      startAbs: p.termStart !== undefined ? ymAbs(p.termStart) : null,
      endAbs,
      benefit: p.deathBenefit,
    });
  }
  if (windows.length === 0) return [];

  // Boundaries where the total can change: each window's first month in force
  // and the first month after it lapses.
  const cuts = new Set<number>();
  for (const w of windows) {
    if (w.startAbs !== null) cuts.add(w.startAbs);
    if (w.endAbs !== null) cuts.add(w.endAbs + 1);
  }
  const sorted = [...cuts].sort((a, b) => a - b);
  const starts: Array<number | null> = [null, ...sorted];
  const bands: CoverageBand[] = [];
  for (let i = 0; i < starts.length; i++) {
    const from = starts[i];
    const next = i + 1 < starts.length ? (starts[i + 1] as number) : null;
    const probe = from ?? (next !== null ? next - 1 : 0);
    let total = 0;
    for (const w of windows) {
      if (w.startAbs !== null && probe < w.startAbs) continue;
      if (w.endAbs !== null && probe > w.endAbs) continue;
      total += w.benefit;
    }
    const band: CoverageBand = {
      from: from === null ? null : absYm(from),
      to: next === null ? null : absYm(next - 1),
      benefit: total,
    };
    const prev = bands[bands.length - 1];
    if (prev !== undefined && prev.benefit === band.benefit) prev.to = band.to;
    else bands.push(band);
  }
  while (bands.length > 0 && bands[bands.length - 1].benefit === 0) bands.pop();
  while (bands.length > 0 && bands[0].benefit === 0) bands.shift();
  return bands;
}

/**
 * The caption under the policy rows: what this plan pays, when, and that it
 * runs out — every clause from the bands, nothing hardcoded. Empty bands get
 * the honest zero sentence (every policy cancelled, or none carries a
 * benefit); a final open band ends the sentence without a false "nothing
 * after".
 */
export function coverageCaption(bands: readonly CoverageBand[]): string {
  if (bands.length === 0) {
    return (
      'No payout in this plan: every policy is cancelled or carries no benefit, so a death ' +
      'collects nothing and the premiums buy nothing the model can see.'
    );
  }
  const parts = bands.map((b) => {
    const amount = b.benefit === 0 ? 'nothing' : formatUSD(b.benefit);
    const from = b.from !== null ? `from ${monthLabel(b.from)} ` : '';
    const to = b.to !== null ? `through ${monthLabel(b.to)}` : 'to the end of the plan';
    return `${amount} ${from}${to}`;
  });
  const closes = bands[bands.length - 1].to !== null;
  return (
    `This plan pays ${parts.join(', ')} on a death of the insured` +
    `${closes ? ', and nothing after' : ''} — tax-free, straight into savings. ` +
    'See the Widow tab for what the cover is worth.'
  );
}

// ---------------------------------------------------------------------------
// The retired side of a paired stream
// ---------------------------------------------------------------------------
//
// Living, investing and giving each have a value in play WHILE WORKING and a
// value in play AFTER nobody works, and all three switch on one signal (the
// months anyone earned). What an ABSENT retired value means differs per stream
// because the honest default differs per stream — living keeps the working
// figure, investing falls to nothing — so the two cases are named rather than
// both being written as a bare `?? something`.

/** What an absent retired value means for a stream (the engine's own default). */
export type RetiredDefault = 'same_as_working' | 'stops';

/**
 * The retired-side monthly the run will actually use: the plan's override, else
 * the profile's own retired figure, else the stream's default — the working
 * figure for living, nothing for investing. `workingEffective` must already
 * include the working side's override, because "same as working" means the
 * value THIS run uses, not the one profile.json happens to hold.
 */
export function effectiveRetiredMonthly(
  fallback: RetiredDefault,
  workingEffective: number,
  profileRetired: number | undefined,
  override: number | undefined,
): number {
  const set = override ?? profileRetired;
  if (set !== undefined) return set;
  return fallback === 'same_as_working' ? workingEffective : 0;
}

/**
 * What an empty retired box should SAY. A profile that has its own answer shows
 * that number (the box is empty because the plan isn't overriding it); a
 * profile that doesn't shows the default in words, so the behavior is obvious
 * without anything being set.
 */
export function retiredPlaceholder(
  fallback: RetiredDefault,
  profileRetired: number | undefined,
): string {
  if (profileRetired !== undefined) return String(profileRetired);
  return fallback === 'same_as_working' ? 'same as working' : 'stops';
}

// ---------------------------------------------------------------------------
// Giving after the last paycheck (ProfileExpenses.retirementGiving)
// ---------------------------------------------------------------------------

/**
 * The charitable stream is a share of a paycheck: while wages come in it has a
 * base, and afterwards it does not. `retirementGiving` says what replaces it
 * from the first year nobody works — THE ONGOING METHOD, one of the two knobs
 * the old bundled 'tithe_account' rule fused (the other, the un-tithed pot,
 * has its own section below). The household's answer lives in the PROFILE;
 * the plan can override each knob independently
 * (assumption_overrides.expenses) to try one out without editing the profile.
 *
 * ABSENT ANYWHERE MEANS 'continue' — the engine's default and its behavior
 * before the rule existed.
 */
export type GivingRuleType = OngoingGivingRule['type'];

/** The `percent_of_growth` member, so its optional fields can be edited by name. */
type GrowthGivingRule = Extract<OngoingGivingRule, { type: 'percent_of_growth' }>;

/**
 * The ongoing half of whatever a stored rule is: a legacy bundled
 * 'tithe_account' — still possible in a plan pasted through the raw-JSON
 * editor, or a cabinet file saved before the split — reads as the
 * percent_of_growth stream it always carried; everything else IS the ongoing
 * method. The bundle's pot half is picked up by `effectivePotSetting` below,
 * so the two halves can never silently drop on screen.
 */
export function ongoingOf(rule: RetirementGivingRule | undefined): OngoingGivingRule | undefined {
  if (rule === undefined) return undefined;
  return rule.type === 'tithe_account' ? titheBundleToPair(rule).ongoing : rule;
}

/** The pot half of a legacy bundled rule; undefined for every current rule. */
function bundledPotOf(rule: RetirementGivingRule | undefined): UntithedPotPolicy | undefined {
  return rule !== undefined && rule.type === 'tithe_account'
    ? titheBundleToPair(rule).pot
    : undefined;
}

/**
 * Plain-language names, used identically in the workbench and the Profile.
 *
 * They are phrased to be read INSIDE the right-hand cell of the giving row,
 * under the "After you stop working" heading — the heading supplies the
 * "after you stop working" half of every sentence, so the option itself only
 * has to finish it ("Amount", "Same as working", "Stops").
 */
const GIVING_RULE_LABELS: Record<GivingRuleType, string> = {
  amount: 'Amount',
  continue: 'Same as working',
  none: 'Stops',
  percent_of_growth: '% of investment growth',
  percent_of_income: '% of income drawn',
};

export interface GivingRuleOption {
  value: GivingRuleType;
  label: string;
}

/**
 * The five options, in the order they are offered: the two plain answers a
 * person reaches for first (a number, or the working figure), then stopping,
 * then the rules that can only be expressed as a rule — the two percentages.
 * The tithe account is NOT one of them any more: its pot half is its own
 * section (the un-tithed pot), and its stream half is '% of investment
 * growth' — which, whenever a pot is present, runs on the new-real-highs
 * high-water mark exactly as the bundle's stream did.
 */
export const GIVING_RULE_OPTIONS: readonly GivingRuleOption[] = (
  ['amount', 'continue', 'none', 'percent_of_growth', 'percent_of_income'] as const
).map((value) => ({ value, label: GIVING_RULE_LABELS[value] }));

/** What an absent rule means, everywhere. Frozen: it is handed out by reference. */
export const DEFAULT_GIVING_RULE: OngoingGivingRule = Object.freeze({ type: 'continue' });

/** Seed for a percentage rule chosen for the first time (10%). */
export const DEFAULT_GIVING_PERCENT = 0.1;

/** Schema bounds (shared/schemas.ts is authoritative; these keep edits legal). */
export const GIVING_SMOOTHING_MIN = 1;
export const GIVING_SMOOTHING_MAX = 10;
export const TITHE_DEFER_MIN = 0;
export const TITHE_DEFER_MAX = 30;
export const TITHE_DISTRIBUTE_MIN = 1;
export const TITHE_DISTRIBUTE_MAX = 30;

/**
 * How long a first un-tithed pot holds before it starts giving in cash. A
 * round decade: long enough that the accumulate-then-give shape of the pot is
 * visible in the results (which is the point of choosing it), short enough to
 * sit well inside the schema's 30. 0 is a legal answer and means "lock and
 * distribute from the first retired year"; the user is expected to set their
 * own number.
 */
export const DEFAULT_POT_HOLD_YEARS = 10;

/**
 * A pot switched on for the first time: the default hold, everything else on
 * its documented absent-means default (seed the catch-up, 10% of the gains,
 * pay out over 10 years, early release on, the growth tithe accruing during
 * the hold). One required key only, so the file says exactly what was chosen
 * and nothing more.
 */
export const DEFAULT_NEW_POT: UntithedPotPolicy = Object.freeze({
  holdYears: DEFAULT_POT_HOLD_YEARS,
});

/**
 * A carve-out with its own mix starts here. NOT a recommendation and not the
 * default behavior: leaving the mix unset inherits the parent IRA's, which is
 * what an untouched rule does. This is only the starting point of an editor
 * the user has explicitly opened, so it is a plainly balanced blend rather
 * than anything that could be mistaken for advice.
 */
export const DEFAULT_TITHE_ALLOCATION: AssetMix = Object.freeze({
  stocks: 0.6,
  bonds: 0.4,
  bills: 0,
});

export function givingRuleLabel(rule: OngoingGivingRule): string {
  return GIVING_RULE_LABELS[rule.type];
}

/**
 * The plan's ongoing-method override, normalised: a legacy bundled override
 * reads as its stream half, so the select can render it without a sixth
 * option. (Migration rewrites stored files; this covers a bundle pasted in.)
 */
export function givingOverride(
  overrides: AssumptionOverrides | undefined,
): OngoingGivingRule | undefined {
  return ongoingOf(overrides?.expenses?.retirementGiving);
}

/** The rule the run will actually use: the scenario's, else the profile's, else 'continue'. */
export function effectiveGivingRule(
  profileRule: RetirementGivingRule | undefined,
  override: OngoingGivingRule | undefined,
): OngoingGivingRule {
  return override ?? ongoingOf(profileRule) ?? DEFAULT_GIVING_RULE;
}

/** Set (or clear, with `undefined`) the scenario-level giving rule. Never mutates. */
export function setGivingOverride(
  overrides: AssumptionOverrides | undefined,
  rule: OngoingGivingRule | undefined,
): AssumptionOverrides | undefined {
  const expenses: NonNullable<AssumptionOverrides['expenses']> = { ...overrides?.expenses };
  if (rule === undefined) delete expenses.retirementGiving;
  else expenses.retirementGiving = rule;
  return withExpenses(overrides, expenses);
}

/**
 * Switch a rule to `type`, carrying over whatever still applies: a percentage
 * survives a move between the two percentage-shaped rules (the number the
 * owner typed is the number he meant), and the parameters that belong to one
 * rule only — smoothing and the cap — survive only within that rule. A first
 * percentage rule starts at 10%.
 *
 * A first 'amount' rule starts at `seedMonthly` — the working-years giving
 * stream, when the caller passes it — so choosing "Amount" opens on the figure
 * 'Same as working' means and the user edits DOWN from a real number instead
 * of up from a $0 that silently reads as "Stops".
 *
 * NOTE FOR ANYONE ADDING A VARIANT: the return type is OngoingGivingRule, so
 * an unhandled `type` falls out of the bottom as a percent_of_growth rule and
 * TypeScript says nothing. Every variant needs its own branch here.
 */
export function givingRuleOfType(
  type: GivingRuleType,
  previous?: OngoingGivingRule,
  seedMonthly?: number,
): OngoingGivingRule {
  if (type === 'continue' || type === 'none') return { type };
  if (type === 'amount') {
    return {
      type,
      monthly: previous?.type === 'amount' ? previous.monthly : Math.max(0, seedMonthly ?? 0),
    };
  }
  const percent =
    previous?.type === 'percent_of_growth' || previous?.type === 'percent_of_income'
      ? previous.percent
      : DEFAULT_GIVING_PERCENT;
  if (type === 'percent_of_income') return { type, percent };
  const next: GrowthGivingRule = { type: 'percent_of_growth', percent };
  if (previous?.type === 'percent_of_growth') {
    if (previous.smoothingYears !== undefined) next.smoothingYears = previous.smoothingYears;
    if (previous.capMonthly !== undefined) next.capMonthly = previous.capMonthly;
  }
  return next;
}

/**
 * Set the percentage, clamped to the schema's 0..1 (a decimal fraction, not a
 * percentage). A blank box keeps the last percentage rather than committing a
 * rule with no percentage at all; rules without a percentage are returned
 * untouched.
 */
export function setGivingPercent(
  rule: OngoingGivingRule,
  percent: number | undefined,
): OngoingGivingRule {
  if (rule.type !== 'percent_of_growth' && rule.type !== 'percent_of_income') {
    return rule;
  }
  if (percent === undefined) return rule;
  return { ...rule, percent: clamp(percent, 0, 1) };
}

/**
 * Set the smoothing window (whole years, 1..10). Blank — or 1, which IS "last
 * year only" — removes the field, so a scenario that isn't smoothing says so
 * by having no `smoothingYears` key.
 */
export function setGivingSmoothing(
  rule: OngoingGivingRule,
  years: number | undefined,
): OngoingGivingRule {
  if (rule.type !== 'percent_of_growth') return rule;
  const next: GrowthGivingRule = { ...rule };
  const rounded = years === undefined ? undefined : Math.round(years);
  if (rounded === undefined || rounded <= GIVING_SMOOTHING_MIN) delete next.smoothingYears;
  else next.smoothingYears = Math.min(rounded, GIVING_SMOOTHING_MAX);
  return next;
}

/**
 * Set the flat monthly amount (today's dollars, never negative). A blank box
 * keeps the last amount rather than committing $0, which would silently be the
 * 'Stops' rule wearing a different name; rules without an amount are returned
 * untouched.
 */
export function setGivingAmount(
  rule: OngoingGivingRule,
  monthly: number | undefined,
): OngoingGivingRule {
  if (rule.type !== 'amount') return rule;
  if (monthly === undefined) return rule;
  return { ...rule, monthly: Math.max(0, monthly) };
}

/** Set the optional monthly ceiling (today's dollars); blank removes it. */
export function setGivingCap(
  rule: OngoingGivingRule,
  capMonthly: number | undefined,
): OngoingGivingRule {
  if (rule.type !== 'percent_of_growth') return rule;
  const next: GrowthGivingRule = { ...rule };
  if (capMonthly === undefined) delete next.capMonthly;
  else next.capMonthly = Math.max(0, capMonthly);
  return next;
}

// ---------------------------------------------------------------------------
// The un-tithed pot (ProfileExpenses.untithedPot / the expenses override)
// ---------------------------------------------------------------------------
//
// The other knob of the pair. The pot's setters follow the giving rule's
// conventions exactly: a field whose absence means the documented default is
// REMOVED when set back to it (the file says only what was chosen), and a
// required field ignores a blank rather than silently rewriting the shape.

/** The plan's pot override, exactly as stored (absent = inherit the profile's). */
export function potOverride(
  overrides: AssumptionOverrides | undefined,
): UntithedPotSetting | undefined {
  return overrides?.expenses?.untithedPot;
}

/** Set (or clear, with `undefined`) the scenario-level pot. Never mutates. */
export function setPotOverride(
  overrides: AssumptionOverrides | undefined,
  pot: UntithedPotSetting | undefined,
): AssumptionOverrides | undefined {
  const expenses: NonNullable<AssumptionOverrides['expenses']> = { ...overrides?.expenses };
  if (pot === undefined) delete expenses.untithedPot;
  else expenses.untithedPot = pot;
  return withExpenses(overrides, expenses);
}

/**
 * The pot the run will actually use, as a stored setting (undefined = none):
 * the plan's override, else the profile's own pot, else the pot half of a
 * profile still carrying the legacy bundled rule. Mirrors the engine's
 * resolveGivingPair precedence so the tab can never show a pot the run will
 * not have.
 */
export function effectivePotSetting(
  profileRule: RetirementGivingRule | undefined,
  profilePot: UntithedPotSetting | undefined,
  override: UntithedPotSetting | undefined,
): UntithedPotSetting | undefined {
  return override ?? profilePot ?? bundledPotOf(profileRule);
}

/**
 * Set the pot's seed share (a decimal fraction, 0..1). Back on exactly the
 * default 10% the key is removed — absence IS the tithe, and writing 0.1 in
 * would make an untouched default indistinguishable from a typed choice. A
 * blank box keeps the last value (the placeholder already shows the default).
 */
export function setPotPercent(
  pot: UntithedPotPolicy,
  percent: number | undefined,
): UntithedPotPolicy {
  const next: UntithedPotPolicy = { ...pot };
  if (percent === undefined) return next;
  const clamped = clamp(percent, 0, 1);
  if (clamped === DEFAULT_POT_PERCENT) delete next.percent;
  else next.percent = clamped;
  return next;
}

/**
 * Set the hold (whole retired years, 0..30). A blank box keeps the last value:
 * `holdYears` is the pot's one required field, and 0 is a real, very
 * different instruction ("lock and distribute from the first retired year"),
 * so an empty box must never silently mean it.
 */
export function setPotHoldYears(
  pot: UntithedPotPolicy,
  years: number | undefined,
): UntithedPotPolicy {
  if (years === undefined) return pot;
  return { ...pot, holdYears: clamp(Math.round(years), TITHE_DEFER_MIN, TITHE_DEFER_MAX) };
}

/** Set the payout window (whole years, 1..30); blank removes the key (= 10). */
export function setPotDistributeYears(
  pot: UntithedPotPolicy,
  years: number | undefined,
): UntithedPotPolicy {
  const next: UntithedPotPolicy = { ...pot };
  if (years === undefined) delete next.distributeYears;
  else next.distributeYears = clamp(Math.round(years), TITHE_DISTRIBUTE_MIN, TITHE_DISTRIBUTE_MAX);
  return next;
}

/**
 * Turn the safe-zone early release on or off. ON writes NO key (absence means
 * true — the default matches the hold's purpose); OFF writes the explicit
 * `earlyRelease: false`, so a plan that opts into waiting out the full hold
 * says so in the file.
 */
export function setPotEarlyRelease(pot: UntithedPotPolicy, on: boolean): UntithedPotPolicy {
  const next: UntithedPotPolicy = { ...pot };
  if (on) delete next.earlyRelease;
  else next.earlyRelease = false;
  return next;
}

/**
 * What the ongoing method does while the pot holds. 'accrue_to_pot' removes
 * the key (it is the default AND the old bundled behaviour); 'give_cash' — the
 * new capability — is written out.
 */
export function setPotOngoingDuringHold(
  pot: UntithedPotPolicy,
  mode: 'accrue_to_pot' | 'give_cash',
): UntithedPotPolicy {
  const next: UntithedPotPolicy = { ...pot };
  if (mode === 'accrue_to_pot') delete next.ongoingDuringHold;
  else next.ongoingDuringHold = mode;
  return next;
}

/** Turn the one-time catch-up seed on or off. ON removes the key (the default). */
export function setPotSeedFromGains(pot: UntithedPotPolicy, on: boolean): UntithedPotPolicy {
  const next: UntithedPotPolicy = { ...pot };
  if (on) delete next.seedFromGains;
  else next.seedFromGains = false;
  return next;
}

/**
 * Set the carve-out's own asset mix, or clear it with `undefined` — which is
 * how the pot says "invest it exactly like the IRA it is carved out of". The
 * key is deleted rather than written back as the parent's mix, following the
 * same convention as smoothing and the cap: a pot that isn't doing the thing
 * says so by having no key.
 */
export function setPotAllocation(
  pot: UntithedPotPolicy,
  allocation: AssetMix | undefined,
): UntithedPotPolicy {
  const next: UntithedPotPolicy = { ...pot };
  if (allocation === undefined) delete next.allocation;
  else next.allocation = { ...allocation };
  return next;
}

/**
 * One line naming the pot and its parameters — the Profile's summary and the
 * Tithing tab's "profile says …" line. Undefined and disabled both read as
 * "no pot", because that is exactly what they both mean to a run.
 */
export function potSummary(setting: UntithedPotSetting | undefined): string {
  const pot = resolveUntithedPot(setting);
  if (pot === null) return 'No un-tithed pot';
  const seed = pot.seedFromGains
    ? `opens with ${givingPercentText(pot.percent)}% of the gains never tithed yet`
    : 'opens empty (the past is left alone)';
  const hold =
    pot.holdYears > 0
      ? `held soft for up to ${yearsText(pot.holdYears)}` +
        (pot.earlyRelease ? ' (released early on a new real high)' : ' (no early release)')
      : 'locked at retirement';
  const during =
    pot.holdYears > 0
      ? pot.ongoingDuringHold === 'accrue_to_pot'
        ? ', the growth tithe accruing into it meanwhile'
        : ', ongoing giving paid in cash meanwhile'
      : '';
  return `Pot ${seed}, ${hold}${during}, then paid out over ${yearsText(pot.distributeYears)}; the remainder goes to charity at death`;
}

/**
 * The annual giving a rule implies in today's dollars, where that is knowable
 * before the run: `continue` is the paycheck stream x 12, `amount` is its own
 * figure x 12, `none` is zero. The rules that read a base the simulation
 * produces — last year's real portfolio growth, last year's Social Security
 * plus withdrawals — return null rather than a figure invented here.
 */
export function annualGivingEquivalent(
  rule: OngoingGivingRule,
  charitableMonthly: number,
): number | null {
  if (rule.type === 'continue') return charitableMonthly * 12;
  if (rule.type === 'amount') return rule.monthly * 12;
  if (rule.type === 'none') return 0;
  return null;
}

/** "8 years" / "1 year" — a whole-year count with the right noun. */
function yearsText(years: number): string {
  return `${years} ${years === 1 ? 'year' : 'years'}`;
}

/**
 * The inline annual figure next to the control: the amount when it is
 * knowable, and otherwise what the amount actually depends on — the markets
 * for the growth rule, the year's draw for the income rule. The pot's own
 * accumulate-then-give shape is narrated by `potSummary` in its own section;
 * this note speaks for the ongoing method alone.
 */
export function annualGivingNote(rule: OngoingGivingRule, charitableMonthly: number): string {
  const annual = annualGivingEquivalent(rule, charitableMonthly);
  if (annual !== null) return `${formatUSD(annual)}/yr`;
  return rule.type === 'percent_of_growth'
    ? 'annual amount varies with the markets'
    : 'annual amount varies with what you draw';
}

/** "10", "12.5", "100" — the percentage without trailing-zero noise. */
function givingPercentText(percent: number): string {
  return String(Number((percent * 100).toFixed(4)));
}

/**
 * One line naming the rule and its parameters — the Profile's summary and the
 * workbench's "profile says …" line. `charitableMonthly` (the stream the
 * 'continue' rule keeps running) is optional; without it that rule is named
 * but not priced.
 */
export function givingRuleSummary(
  rule: OngoingGivingRule,
  charitableMonthly?: number,
): string {
  switch (rule.type) {
    case 'continue':
      return charitableMonthly === undefined
        ? 'Keep giving the same amount, inflation-adjusted'
        : `Keep giving the same amount — ${formatUSD(charitableMonthly)}/mo ` +
            `(${formatUSD(charitableMonthly * 12)}/yr), inflation-adjusted`;
    case 'amount':
      return (
        `Give ${formatUSD(rule.monthly)}/mo (${formatUSD(rule.monthly * 12)}/yr), ` +
        'inflation-adjusted'
      );
    case 'none':
      return 'Stop giving — $0 from the first year nobody is working';
    case 'percent_of_growth': {
      const window =
        rule.smoothingYears !== undefined && rule.smoothingYears > 1
          ? `, averaged over the last ${rule.smoothingYears} years`
          : '';
      const cap =
        rule.capMonthly !== undefined
          ? `, capped at ${formatUSD(rule.capMonthly)}/mo (${formatUSD(rule.capMonthly * 12)}/yr)`
          : '';
      return `${givingPercentText(rule.percent)}% of last year's real investment growth${window}${cap}`;
    }
    case 'percent_of_income':
      return `${givingPercentText(rule.percent)}% of last year's Social Security plus withdrawals`;
  }
}

/**
 * How the rule actually computes, in the user's terms — the mechanic he has
 * to know to choose between them, stated without recommendation.
 */
export function givingRuleHelp(rule: OngoingGivingRule, hasPot = false): string {
  switch (rule.type) {
    case 'continue':
      return (
        'The working-years giving stream keeps running for life, inflation-adjusted. This is ' +
        'what the app does when nothing is set here, and charitable expense-change events still ' +
        'apply to it.'
      );
    case 'amount':
      return (
        `A flat ${formatUSD(rule.monthly)}/mo in today's dollars from the first year nobody is ` +
        'working, inflation-adjusted in the sim exactly like the working-years stream. Unlike ' +
        'that stream it is NOT retargeted by charitable expense-change events: once a rule ' +
        "governs a year, the rule's own number sets the giving."
      );
    case 'none':
      return 'Giving ends with the last paycheck: $0 in every fully retired year.';
    case 'percent_of_growth': {
      if (hasPot) {
        // With a pot the base changes shape entirely, so the plain-base help
        // below would describe arithmetic the run does not do.
        return (
          'With an un-tithed pot in the plan, the base is a HIGH-WATER MARK on the real value ' +
          'of the portfolio outside the pot: nothing is owed until it is worth more, after ' +
          'inflation, than it has ever been, so climbing back out of a downturn is never ' +
          'tithed twice ("tithe the gross, once"). While the pot holds, this stream either ' +
          'accrues into it or pays in cash — the pot section’s “during the hold” switch ' +
          'decides. The smoothing window does not apply on this base (averaging new-high ' +
          'increments would tithe the same increment twice); the monthly cap still does.'
        );
      }
      const smoothed =
        rule.smoothingYears !== undefined && rule.smoothingYears > 1
          ? ` The base is the average of the last ${rule.smoothingYears} years' growth, which ` +
            'steadies the figure and keeps one down year from zeroing it.'
          : '';
      const capped =
        rule.capMonthly !== undefined
          ? ` Whatever the growth, the result is capped at ${formatUSD(rule.capMonthly)}/mo in ` +
            "today's dollars."
          : '';
      return (
        "Computed from LAST year's real portfolio growth — this year's is not known until the " +
        "year is over, and this year's growth would itself depend on what you gave. Real growth " +
        'is the year\'s investment gain across every account minus inflation on the ' +
        'start-of-year balance; a year the portfolio lost ground gives $0.' +
        smoothed +
        capped
      );
    }
    case 'percent_of_income':
      return (
        "Computed from LAST year's Social Security plus gross withdrawals (Roth conversions are " +
        'excluded — moving money between accounts is not income). It is steadier than the growth ' +
        'rule and is never $0, and it counts withdrawals of money that came out of pay you ' +
        'already gave on.'
      );
  }
}

/**
 * How the pot actually works, in the user's terms — the mechanics he has to
 * know to switch it on, stated without recommendation. One text for both the
 * profile's own pot and a plan-level override, like givingRuleHelp above.
 */
export function potHelp(setting: UntithedPotSetting | undefined): string {
  const pot = resolveUntithedPot(setting);
  if (pot === null) {
    return (
      'No pot: giving after the last paycheck is whatever the ongoing method below says, and ' +
      'the gains earned before retirement are never caught up on. Switch it on to set aside a ' +
      'share of the never-tithed gains as a carve-out inside the largest pre-tax IRA — an ' +
      'accounting label on money that never leaves the account, so it costs nothing in tax.'
    );
  }
  const p = givingPercentText(pot.percent);
  const seed = pot.seedFromGains
    ? `On the day you stop working it opens with ${p}% of the gains that have never been ` +
      'tithed — each retirement account’s balance minus what you put into it over your career ' +
      '(the “Contributed over your career” figure on the Accounts card). '
    : 'It opens empty: what the portfolio earned before you retired is left alone. ';
  const during =
    pot.ongoingDuringHold === 'accrue_to_pot'
      ? 'While the hold runs, a percent-of-growth ongoing tithe accrues into the pot instead of ' +
        'being paid — those years give nothing in cash and claim no charitable deduction. (Any ' +
        'other ongoing method has nothing growth-shaped to accrue and simply pays its cash: ' +
        'the hold defers the POT, not the giving.) '
      : 'While the hold runs, the ongoing method below keeps paying in cash, fully independent ' +
        'of the pot. ';
  const hold =
    pot.holdYears > 0
      ? `The pot is held SOFT for up to the first ${yearsText(pot.holdYears)} of retirement: it ` +
        'sits in your spendable assets and your success rate, and if every other account runs ' +
        'dry the plan spends it — last, and for good. The hold exists to carry the promise past ' +
        'the fragile first years, not to starve them. ' +
        (pot.earlyRelease
          ? 'It ends early once the plan sets a new REAL (inflation-adjusted) spendable high ' +
            'after the first retired year — the fragile window is provably over — and otherwise ' +
            'when the years run out. '
          : 'This plan waits out the full hold (early release is switched off). ') +
        during
      : 'With no hold the pot locks the day you retire: charity money in escrow from day one. ';
  return (
    'THE UN-TITHED POT is a carve-out INSIDE your largest pre-tax IRA — an accounting label on ' +
    'money that never leaves the account, the same device the 72(t) machinery uses — not a new ' +
    'account. That is what makes it free: funding a real giving account would mean a taxable ' +
    'IRA withdrawal. ' +
    seed +
    hold +
    `When the hold ends the pot LOCKS — out of your spendable assets and your odds — and is ` +
    `distributed to charity over ${yearsText(pot.distributeYears)} (each year gives the balance ` +
    'over the years remaining, so growth is given too and the pot empties on schedule), feeding ' +
    'your charitable deduction like any other gift. Whatever is still in it at the end goes to ' +
    'charity — including if a death lands during the hold.'
  );
}

// ---------------------------------------------------------------------------
// Income (assumption_overrides.income)
// ---------------------------------------------------------------------------
//
// The income pair is the one asymmetric row in the panel. The LEFT side —
// salaries and the 401(k) — is payroll fact the profile owns and the plan
// cannot override; the only thing a plan moves about it is the date it stops,
// which is a retire event. The RIGHT side is the money the household expects to
// bring in AFTER it stops working (consulting, part-time work, a rental, a
// pension), and it is fully plan-level: "what if the consulting brings in
// $2,000 a month?" is a what-if, not a change to the household baseline.

/** Total gross salary while working, across everyone in the household. */
export function annualSalaryTotal(salaries: Record<string, number>): number {
  return Object.values(salaries).reduce((sum, s) => sum + s, 0);
}

export function retirementIncomeOverride(
  overrides: AssumptionOverrides | undefined,
): number | undefined {
  return overrides?.income?.retirementMonthly;
}

export function retirementTaxableOverride(
  overrides: AssumptionOverrides | undefined,
): boolean | undefined {
  return overrides?.income?.retirementIncomeTaxable;
}

/**
 * Reattach an `income` block, pruning upward exactly like `withExpenses`: an
 * empty block takes the key with it so a plan back on the profile's income says
 * so by having no `income` key at all.
 */
function withIncome(
  overrides: AssumptionOverrides | undefined,
  income: NonNullable<AssumptionOverrides['income']>,
): AssumptionOverrides | undefined {
  const next: AssumptionOverrides = { ...overrides };
  if (Object.keys(income).length === 0) delete next.income;
  else next.income = income;
  return Object.keys(next).length === 0 ? undefined : next;
}

/** Set (or clear, with `undefined`) the plan's retirement-income amount. Never mutates. */
export function setRetirementIncomeOverride(
  overrides: AssumptionOverrides | undefined,
  monthly: number | undefined,
): AssumptionOverrides | undefined {
  const income: NonNullable<AssumptionOverrides['income']> = { ...overrides?.income };
  if (monthly === undefined) delete income.retirementMonthly;
  else income.retirementMonthly = monthly;
  return withIncome(overrides, income);
}

/** Set (or clear, with `undefined`) the plan's taxable/not-taxable answer. Never mutates. */
export function setRetirementTaxableOverride(
  overrides: AssumptionOverrides | undefined,
  taxable: boolean | undefined,
): AssumptionOverrides | undefined {
  const income: NonNullable<AssumptionOverrides['income']> = { ...overrides?.income };
  if (taxable === undefined) delete income.retirementIncomeTaxable;
  else income.retirementIncomeTaxable = taxable;
  return withIncome(overrides, income);
}

/** The retirement income the run will use: the plan's, else the profile's, else 0. */
export function effectiveRetirementIncome(
  profileMonthly: number | undefined,
  override: number | undefined,
): number {
  return override ?? profileMonthly ?? 0;
}

/** Whether that income is taxed as ordinary income: the plan's, else the profile's, else true. */
export function effectiveRetirementTaxable(
  profileTaxable: boolean | undefined,
  override: boolean | undefined,
): boolean {
  return override ?? profileTaxable ?? true;
}

/**
 * Commit a taxable/not-taxable CHOICE. The control shows the effective answer
 * (two options, no third "inherit" entry to explain), so choosing the value the
 * profile already implies clears the override instead of writing a redundant
 * one — the same "blank means whatever the profile says" contract the number
 * boxes have, expressed for a control that cannot be blank.
 */
export function setRetirementTaxableChoice(
  overrides: AssumptionOverrides | undefined,
  profileTaxable: boolean | undefined,
  choice: boolean,
): AssumptionOverrides | undefined {
  const profileEffective = profileTaxable ?? true;
  return setRetirementTaxableOverride(overrides, choice === profileEffective ? undefined : choice);
}

/** What an empty retirement-income box says: the profile's figure, or the default. */
export function retirementIncomePlaceholder(profileMonthly: number | undefined): string {
  return profileMonthly === undefined ? 'none' : String(profileMonthly);
}

/**
 * The read-only working-income summary: what the household earns now, in the
 * order the panel shows it. Pure so the strings are testable — the panel only
 * lays them out.
 */
export interface WorkingIncomeLine {
  label: string;
  /** Annual dollars. */
  amount: number;
}

export function workingIncomeLines(
  income: Pick<ProfileIncome, 'salaries' | 'contribution401k' | 'employerMatch401k'>,
  people: ReadonlyArray<{ id: string; name: string }>,
): WorkingIncomeLine[] {
  const lines: WorkingIncomeLine[] = people.map((p) => ({
    label: `${p.name} salary`,
    amount: income.salaries[p.id] ?? 0,
  }));
  lines.push({ label: '401(k) deferral', amount: income.contribution401k });
  lines.push({ label: 'Employer match', amount: income.employerMatch401k });
  return lines;
}

// ---------------------------------------------------------------------------
// Autosave
// ---------------------------------------------------------------------------
//
// There is no Save button: every committed change is written to plan.json, on
// the same debounce that re-runs the simulation. Two pure pieces of that live
// here — how the page decides a write is actually needed, and what the little
// status line says.

/**
 * The identity of the plan AS IT WILL BE SAVED. The page holds the last saved
 * key and skips the PUT when it hasn't moved, so changing a RUN setting (mode,
 * seed, path count — none of which are saved) never writes the file, and the
 * first debounce after load never rewrites the file it was just read from.
 */
export function planSaveKey(plan: Scenario): string {
  return stableStringify(plan);
}

/**
 * Where the plan stands with the file on disk. `idle` is the state between
 * loading and the first write of the session — nothing has changed yet, so
 * claiming "Saved" would be claiming credit for a write that never happened.
 */
export type SaveState =
  | { status: 'idle' }
  | { status: 'saving' }
  | { status: 'saved' }
  | { status: 'error'; message: string };

/**
 * WHAT THE PANEL SAYS ABOUT SAVING, WHICH IS NOTHING UNLESS IT BROKE.
 *
 * There used to be a quiet status line here reading "Saved — every change
 * writes itself to plan.json", and the user asked for it gone: it spent a row
 * of the panel restating, on every render, a promise the app keeps anyway.
 *
 * The FAILURE did not go with it. With no manual save to fall back on, an
 * unreported error means the user keeps turning knobs into a file that
 * stopped being written, so a failed write still raises a banner — this is the
 * text on it. Null means there is nothing to say, which is the ordinary case.
 */
export function saveFailureText(state: SaveState): string | null {
  return state.status === 'error' ? `NOT SAVED — ${state.message}` : null;
}

/**
 * The identity of a run's INPUTS. Two runs with the same key produce the same
 * numbers, so the live loop uses this to avoid re-running on a change that
 * changed nothing (re-selecting the same scenario, a blur that committed the
 * same value).
 */
export function runInputKey(
  scenario: Scenario,
  params: { mode: string; paths?: number; seed: number },
): string {
  return stableStringify({ scenario, ...params });
}

// ---------------------------------------------------------------------------
// Run settings
// ---------------------------------------------------------------------------

/**
 * The run controls as the panel holds them. Number fields keep free text and
 * are parsed at run time (a half-typed "25" must not fire a 25-path run).
 */
export interface RunSettings {
  mode: RunMode;
  pathsText: string;
  /** Swap the interactive path count for the final-quality one. */
  finalQuality: boolean;
  seedText: string;
  /**
   * The seed is FIXED for interactive runs — that is the whole point of the
   * live loop, since a resampled Monte Carlo would move the numbers on its own
   * and every edit would look significant. Unlocking it is a deliberate act.
   */
  seedUnlocked: boolean;
}

export interface ResolvedRunParams {
  mode: RunMode;
  /** Monte Carlo only; the engine derives its own count for the other modes. */
  paths?: number;
  seed: number;
}

/**
 * Parse a positive integer from an input string; fallback when invalid. Zero
 * and negatives are not path counts, so they take the fallback too.
 */
export function parsePositiveInt(raw: string, fallback: number): number {
  const s = raw.trim();
  if (s === '') return fallback;
  const n = Math.floor(Number(s));
  return Number.isFinite(n) && n >= 1 ? n : fallback;
}

/** Parse an integer seed from an input string; fallback when invalid. */
export function parseSeed(raw: string, fallback: number): number {
  const s = raw.trim();
  if (s === '') return fallback;
  const n = Math.floor(Number(s));
  return Number.isFinite(n) ? n : fallback;
}

export function defaultRunSettings(
  settings: Pick<ProfileSettings, 'mcPathsInteractive' | 'seed'>,
): RunSettings {
  return {
    mode: 'montecarlo',
    pathsText: String(settings.mcPathsInteractive),
    finalQuality: false,
    seedText: String(settings.seed),
    seedUnlocked: false,
  };
}

export function resolveRunParams(
  settings: RunSettings,
  profileSettings: Pick<ProfileSettings, 'mcPathsInteractive' | 'seed'>,
): ResolvedRunParams {
  const seed = parseSeed(settings.seedText, profileSettings.seed);
  if (settings.mode !== 'montecarlo') return { mode: settings.mode, seed };
  return {
    mode: settings.mode,
    paths: parsePositiveInt(settings.pathsText, profileSettings.mcPathsInteractive),
    seed,
  };
}

// ---------------------------------------------------------------------------
// Pinned-baseline overlay on the fan chart
// ---------------------------------------------------------------------------

/**
 * The baseline's median (p50) line, re-indexed onto the CURRENT fan's years so
 * Recharts can draw it as one more series over the same rows. Years the
 * baseline does not cover come back as undefined, which Recharts renders as a
 * gap rather than a line to zero.
 */
export function alignBaselineP50(
  years: readonly number[],
  baseline: FanChart,
): Array<number | undefined> {
  const byYear = new Map<number, number>();
  baseline.years.forEach((year, i) => {
    const v = baseline.p50[i];
    if (typeof v === 'number') byYear.set(year, v);
  });
  return years.map((y) => byYear.get(y));
}

// ---------------------------------------------------------------------------
// Run now: the score under the conditions everything else records under
// ---------------------------------------------------------------------------

/*
 * THE PANEL NO LONGER COLLAPSES. There was a ⌘B toggle, a vertical rail and a
 * `fplan-workbench-panel` localStorage key holding 'collapsed' | 'open'. All
 * three are gone: the panel IS the left half of the Workbench, hiding it left a
 * 40px stub that answered no question, and the stored flag could restore the
 * app into that stub on a load nobody asked for it on.
 */

/**
 * The conditions a RECORDED score is measured under, read off the profile.
 *
 * These three values are the whole point of the Run now button. The History
 * tab's scores and the net-worth ledger's are both computed by the server at
 * `montecarlo` / `mcPathsFinal` / the profile seed (src/server/scoreRunner.ts),
 * while the live loop runs at `mcPathsInteractive` for responsiveness. Two
 * numbers measured that differently are not comparable, and the app said so
 * nowhere: 93.1% on screen against 94.2% in the History tab, same plan.
 *
 * The mode is forced rather than taken from the panel's run settings on
 * purpose: only Monte Carlo answers "in what fraction of futures does this
 * work", so a deterministic panel setting must not quietly produce a "final"
 * number that no recorded score could ever be compared with.
 */
export function finalRunParams(
  settings: Pick<ProfileSettings, 'mcPathsFinal' | 'seed'>,
): ResolvedRunParams {
  return { mode: 'montecarlo', paths: settings.mcPathsFinal, seed: settings.seed };
}

/**
 * THE FINAL RUN THAT MAY STAND IN FOR THIS INTERACTIVE ONE, or null when none
 * may.
 *
 * The live loop asks the server whether this run already exists at final
 * quality before it computes a quick one, because the user ran at 10,000
 * paths, refreshed the browser, and watched 94.2% revert to 93.1% — the better
 * answer was sitting in the run cache the whole time and nothing looked for it.
 *
 * SUBSTITUTION IS ONLY HONEST WHEN THE FINAL RUN ANSWERS THE SAME QUESTION,
 * BETTER. Three conditions, and every one of them is a way the app could
 * otherwise put a number on screen that the user did not ask for:
 *
 *  - MONTE CARLO. A deterministic or historical run answers a different
 *    question entirely, and swapping a fraction-of-futures in for a single
 *    projected path would be a different number wearing the panel's label.
 *  - THE PROFILE'S SEED. An unlocked seed is a deliberate act (see RunSettings)
 *    and draws a different set of futures; a 10,000-path run on the profile
 *    seed is not a more precise version of it, it is a different sample.
 *  - NO MORE PRECISION THAN ASKED FOR IS FINE; LESS IS NOT. Typing 25,000 into
 *    the Paths box asks for a finer answer than mcPathsFinal, and quietly
 *    serving 10,000 instead would be a downgrade the user requested the
 *    opposite of. At or below it, the final run is strictly better and free.
 *
 * The cache is asked without starting anything (api.lookupCachedRun), so a
 * miss — the ordinary case straight after an edit — costs a file stat and the
 * quick run happens exactly as before.
 */
export function finalStandInParams(
  params: ResolvedRunParams,
  settings: Pick<ProfileSettings, 'mcPathsFinal' | 'seed'>,
): ResolvedRunParams | null {
  if (params.mode !== 'montecarlo') return null;
  if (params.seed !== settings.seed) return null;
  // Undefined paths means "whatever the server defaults Monte Carlo to", which
  // is mcPathsInteractive — below the final count, so the swap is an upgrade.
  if ((params.paths ?? 0) > settings.mcPathsFinal) return null;
  return finalRunParams(settings);
}

/** How far along a Run now is — the button says this, so it never looks dead. */
export type RunNowState =
  | { status: 'idle' }
  /** Fetching today's prices, before anything is simulated. */
  | { status: 'quotes' }
  /** The 10,000-path simulation itself; the progress bar carries the fraction. */
  | { status: 'running' }
  | { status: 'error'; message: string };

/**
 * The button's own label. A 10,000-path run after a network fetch is tens of
 * seconds of work, and a button that still reads "Run now" throughout it reads
 * as one that did not take the click.
 */
export function runNowButtonText(state: RunNowState): string {
  switch (state.status) {
    case 'quotes':
      return 'Refreshing prices…';
    case 'running':
      return 'Running…';
    case 'idle':
    case 'error':
      return 'Run now';
  }
}

/** Whether the button may be pressed — an in-flight run must not be re-entered. */
export function runNowBusy(state: RunNowState): boolean {
  return state.status === 'quotes' || state.status === 'running';
}

/**
 * WHICH RUN IS ON SCREEN, where the eye lands on the number rather than in
 * small text at the foot of the card.
 *
 * `tone` drives the chip's colour: a final run is the one that can be set beside
 * a recorded score, and that is worth marking as the good state.
 *
 * The seed is only mentioned when it is NOT the profile's, because an unlocked
 * seed makes a 10,000-path run just as incomparable as a 1,000-path one — the
 * Monte Carlo drew a different set of futures — and that is invisible from the
 * number itself.
 */
export interface RunQualityLabel {
  tone: 'final' | 'quick';
  /** The chip: what this run is, and at what size. */
  headline: string;
  /** The sentence under it: whether the number can be set beside a recorded one. */
  note: string;
}

export function runQualityLabel(
  meta: Pick<RunMeta, 'mode' | 'paths' | 'seed'>,
  settings: Pick<ProfileSettings, 'mcPathsFinal' | 'seed'>,
): RunQualityLabel {
  const paths = meta.paths.toLocaleString('en-US');
  const wrongSeed = meta.seed !== settings.seed;
  const seedClause = wrongSeed
    ? ` It also drew seed ${meta.seed} rather than the profile's ${settings.seed}, which is a` +
      ' different set of futures again.'
    : '';

  // Only Monte Carlo produces a fraction of futures, so a deterministic or
  // historical run is never the recorded kind however many paths it reports.
  if (meta.mode !== 'montecarlo') {
    return {
      tone: 'quick',
      headline: `${meta.mode} · ${paths} paths`,
      note:
        'Recorded scores are Monte Carlo, so this number cannot be set beside one. Run now ' +
        'refreshes prices and re-runs on the recorded conditions.',
    };
  }

  if (meta.paths >= settings.mcPathsFinal && !wrongSeed) {
    return {
      tone: 'final',
      headline: `Final quality · ${paths} paths`,
      note:
        'The conditions the History tab and the net-worth ledger record under, so this number ' +
        'is directly comparable with theirs.',
    };
  }

  return {
    tone: 'quick',
    headline: `Quick run · ${paths} paths`,
    note:
      `A fast run, for turning knobs. Recorded scores use ` +
      `${settings.mcPathsFinal.toLocaleString('en-US')} paths, so a point either way against ` +
      `one of those is method rather than the plan.${seedClause} Run now refreshes prices and ` +
      `re-runs on the recorded conditions.`,
  };
}

/**
 * WHEN THIS RUN WAS COMPUTED — which is not always now.
 *
 * The page now prefers a final-quality run it already has over a quick one it
 * would have to compute, so the number on screen can be one made at 3:41 PM
 * this afternoon rather than a second ago. It is not stale: the cache key is
 * the WHOLE input — the plan, the assumptions, and the resolved profile whose
 * balances move with every quote price — so a run only comes back while all of
 * it is identical to what is on screen, which makes the number exactly as right
 * as a fresh one. But "still exactly right" and "just computed" are different
 * claims, and the user should be able to see which he is looking at.
 *
 * SAID ON EVERY RUN, including one computed a second ago. A chip that appeared
 * only for an older run would teach the reader that its absence means "just
 * now" — and its absence would then have to keep meaning that forever, on every
 * future path that puts a result on screen. Same reasoning as the precision
 * chip beside it, which states ±0.3 as readily as ±1.3.
 *
 * THE MOMENT IS ABSOLUTE, never "22 minutes ago". Nothing on this page ticks:
 * a relative phrase is rendered once, when the result lands, and would still
 * read "just now" an hour later with nobody to correct it.
 *
 * Null for an unparseable createdAt — an unreadable moment is worse than none.
 */
export function runComputedAt(
  meta: Pick<RunMeta, 'createdAt'>,
): { text: string; title: string } | null {
  if (Number.isNaN(new Date(meta.createdAt).getTime())) return null;
  return {
    text: `Computed ${historyMoment(meta.createdAt)}`,
    title:
      'A run is filed under its whole input — the plan, the assumptions, and every balance as ' +
      'priced by the quotes behind it. One computed earlier is only shown while all of that is ' +
      'unchanged, so it is the same number a fresh run would produce.',
  };
}

/**
 * The symbols whose price did NOT refresh, said plainly, or null when they all
 * did.
 *
 * A per-symbol failure is survivable — the previous quote stays on the file and
 * the run prices that holding at it — but survivable is not the same as silent:
 * the whole promise of the button is "this is scored on today's prices", and a
 * run that used yesterday's price for one holding has to say which holding.
 */
export function refreshFailureNote(
  results: readonly { symbol: string; ok: boolean }[],
): string | null {
  const failed = results.filter((r) => !r.ok).map((r) => r.symbol);
  if (failed.length === 0) return null;
  return (
    `Prices did not refresh for ${failed.join(', ')} — this run used the last stored price for ` +
    `${failed.length === 1 ? 'it' : 'those'}.`
  );
}

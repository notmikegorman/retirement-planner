/**
 * Pure data-shaping for the two TREND charts under the net-worth bars — what
 * the plan scored on each of those days, and what it could afford. No React,
 * no IO.
 *
 * WHY SEPARATE CHARTS AND NOT SHARED AXES. Net worth is millions of dollars,
 * the score is a probability between 0 and 1, and the sustainable spend is tens
 * of thousands a year. Overlaying any two of them needs a second y scale, and
 * the moment two series share a plot on two scales the eye reads their CROSSING
 * as an event — a crossing that means nothing at all, because moving either
 * axis moves it. Separate plots stacked directly beneath, on the SAME
 * categorical x axis in the same order, keep all three readable and make the
 * only true relationship — same day, same reading — a matter of looking
 * straight down.
 *
 * WHY THE SPEND LINE EXISTS AT ALL. This household's success rate saturates:
 * every version of the plan reads 96-point-something, so a trend of
 * probabilities can be flat while the plan gets materially better or worse.
 * What separates two versions is what they could afford, in dollars — so the
 * dollar-denominated score gets a plot of its own rather than a footnote.
 *
 * THE X AXIS IS THE BARS' AXIS, one point per snapshot including the ones that
 * carry no score. A snapshot with no score is a GAP (null), never a zero: 0%
 * means "this plan fails in every simulated future", which is a catastrophe,
 * and drawing one for "the run had not finished" or "this row predates the
 * feature" would put an imaginary collapse on a chart the user reads to see
 * whether anything has changed.
 *
 * WHAT THE MARKS ARE FOR. Two conditions make two scores incomparable, and
 * both are invisible in the numbers themselves:
 *  - a different PLAN — the thing being scored changed, so the line's step is
 *    not "my odds improved" but "I am measuring something else";
 *  - a different ENGINE VERSION — ENGINE_VERSION is part of the run-cache key
 *    precisely because two engines do not agree.
 * Either one marks the point, and the tooltip says which. A line that smooths
 * over them is the one-golden-number trap this whole app is built against.
 *
 * AND ONE CONDITION THAT PROVES NOTHING EITHER WAY, which used to be drawn as
 * if it were the first. A row scored before the baseline concept was collapsed
 * names its plan by a hash of the WHOLE frozen record; a row scored since names
 * it by `planIdentityKey` (name and description excluded). The same plan hashes
 * differently under the two rules — this ledger proves it, today's plan.json
 * hashing to 7ff9a75c… under the old rule and f5cccb… under the new, which are
 * exactly the two values the Aug-19 and Aug-20 rows recorded — so a boundary
 * between a row of each kind ALWAYS compared unequal, and the chart ringed it
 * and said "scored against a different plan". It was one unchanged plan. The
 * claim was false every single time it could be made.
 *
 * The app still cannot prove the two are the same: neither fingerprint can be
 * converted into the other, and the frozen record that would settle it was
 * deleted in the collapse. But "I cannot compare these" is a weaker and
 * different statement from "these were different plans", and only the weaker
 * one is true — so that boundary keeps a mark, in its own colour, with its own
 * words. Dropping the mark would be the opposite lie: a boundary the app cannot
 * reason about drawn as a clean join.
 *
 * (Unit tests: tests/ui/netWorthScoreChart.test.ts.)
 */
import type { NetWorthSnapshot, SnapshotScore } from '../../shared/types';
import { formatUSD } from '../../shared/util';
import { formatSnapshotDate } from './netWorthChart';

/**
 * WHAT THE PLAN COMPARISON AT ONE BOUNDARY CONCLUDED. Three answers, not two,
 * because "I could not compare them" is a real answer and used to be filed
 * under "they differed".
 *
 *  - 'comparable' — both points named their plan under the same rule and wrote
 *    the same name. Also the answer where there is nothing to compare against.
 *  - 'changed'    — same rule, different names: one rule applied twice to two
 *    different plans, which is a fact about the plans.
 *  - 'unknown'    — the two points named their plans under DIFFERENT rules (or
 *    one named nothing at all). Their names cannot match even when the plan is
 *    identical, so their inequality is a fact about the bookkeeping and says
 *    nothing whatever about the plan.
 */
export type PlanComparability = 'comparable' | 'changed' | 'unknown';

/** One tick on the shared axis: a snapshot, scored or not. */
export interface ScorePoint {
  /** X tick and tooltip header, identical to the bar above it. */
  date: string;
  /**
   * What the CHART addresses this point by — which is deliberately not the
   * date, because the date is not unique.
   *
   * Two snapshots taken on one day share a `date`, and recharts answers a
   * category axis with duplicated values by throwing the values away and
   * scaling on serial numbers instead ("When category axis has duplicated
   * text, serial numbers are used to generate scale" — generateCategoricalChart).
   * A `ReferenceLine x="Aug 19, 2026"` then resolves to nothing on that scale
   * and, because recharts discards an out-of-range reference by default, it
   * renders NOTHING AT ALL and says nothing about it. The comparability rules
   * would disappear from the chart on exactly the ledger that has two readings
   * in a day — silently, which is the failure mode this whole feature exists
   * to prevent. So the axis is keyed on a value that is unique per row, and
   * the tick text is formatted back to the date (scoreAxisTick).
   */
  axisKey: string;
  takenAt: string;
  /**
   * The score as a PERCENTAGE for the axis, or null for a snapshot that
   * carries none. Null draws a gap; recharts skips it as long as the line does
   * not connect nulls, which is the whole reason this is null and not 0.
   */
  pct: number | null;
  /**
   * The highest annual living spend this plan supported, in dollars, or null.
   *
   * NULL IN THREE ORDINARY CASES, all of them "not measured": the snapshot has
   * no score at all, the score predates the spend solve, or the solve itself
   * reported a reason instead of a number (an over-funded plan clears the top
   * of the solver's bracket, which is "more than this", not "this"). Every one
   * of them draws a gap. Zero would say this plan can support NO spending,
   * which is a different and much worse claim than "nobody worked it out".
   */
  spend: number | null;
  /** The recorded score with all its conditions, or null when there is none. */
  score: SnapshotScore | null;
  /** Why there is no score, when the row recorded a reason. */
  reason: string | null;
  /**
   * How this point's conditions differ from the previous SCORED point's — the
   * previous point, not the previous row, because an unscored row carries no
   * conditions to differ from. 'comparable' and false on the first scored
   * point: there is nothing behind it that it could fail to be comparable
   * with, which is not the same as having compared and found no difference,
   * but is the same mark — none.
   */
  breaks: { plan: PlanComparability; engine: boolean };
}

export interface ScoreSeries {
  /** One per snapshot, oldest first — the bars' own order. */
  points: ScorePoint[];
  /** How many carry a score. 0 draws no chart; 1 draws one dot, not a line. */
  scored: number;
  /** [min, max] for the y axis, in percent. See scoreDomain. */
  domain: [number, number];
  /**
   * How many carry a sustainable-spend figure. Counted SEPARATELY from
   * `scored` because the two numbers are attached separately: the probability
   * lands first and the spend a dozen runs later, and a row can carry one
   * without the other for ever (every score recorded before the spend was
   * measured is exactly that).
   */
  spendScored: number;
  /** [min, max] for the spend y axis, in dollars. See spendDomain. */
  spendDomain: [number, number];
}

/**
 * How much room to leave above and below the observed scores, in percentage
 * points, so the extreme points are not drawn on the axis lines themselves.
 */
export const SCORE_AXIS_PAD_PCT = 2;

/**
 * The narrowest window the axis may show, in percentage points.
 *
 * A fixed 0-100 axis would flatten this household's history to a straight line
 * — its scores live between about 88% and 97% — and an axis fitted tightly to
 * the data does the opposite: three points spanning 0.3pp would fill the plot
 * and read as a dramatic collapse and recovery, when the truth is that the
 * three numbers are the same number inside the engine's own noise (roughly
 * 0.3pp at 10,000 paths). Ten points is the compromise: wide enough that a
 * move inside the noise stays visibly small, narrow enough that a real 5-point
 * slide is unmistakable.
 */
export const MIN_SCORE_SPAN_PCT = 10;

/** What the axis is, stated on the chart so no reader has to infer it. */
export const SCORE_AXIS_LABEL = 'Chance the plan never runs out';

/**
 * What the SPEND axis is. It names the ceiling rather than the spending, because
 * the figure is not what the household spends — it is the most it could spend
 * and still clear the success target, which is a different number and a much
 * more useful one.
 */
export const SPEND_AXIS_LABEL = 'Most the plan could spend, per year';

/**
 * How much room to leave above and below the observed spend figures, in
 * dollars.
 */
export const SPEND_AXIS_PAD_USD = 2_000;

/**
 * The narrowest window the spend axis may show, in dollars.
 *
 * Same argument as MIN_SCORE_SPAN_PCT, with the engine's own numbers. The
 * max_spend solver stops bisecting once its bracket is under $500
 * (engine/solvers.MAX_SPEND_INTERVAL), so two answers within $500 of each other
 * are one answer as far as the solver is concerned — and its inner sweeps run
 * at a capped path count, which makes the real resolution coarser still. Ten
 * times the bracket is the compromise: wide enough that a difference the
 * bisection could not have resolved stays visibly small, narrow enough that a
 * genuine $20,000/yr slide is unmistakable.
 */
export const MIN_SPEND_SPAN_USD = 5_000;

/**
 * The dollar grid the axis snaps to — the solver's own stopping bracket. A
 * tick reading "$64,200" would claim a precision twelve probes at a capped
 * path count do not have.
 */
const SPEND_TICK_USD = 500;

/**
 * Shown instead of the chart when nothing has been scored yet. There is no
 * missing step to send the user off to fix any more — there is one plan and
 * it is always scoreable — so this says what the next snapshot will do and
 * what to press for the rows already there.
 */
export function scoreChartEmptyNote(): string {
  return (
    'No snapshot carries a score yet. The next one will record what your plan scores — at ' +
    'final quality, on the profile’s own seed. Older rows can be scored from the table below, ' +
    'against today’s balances.'
  );
}

/**
 * The y-axis window for a set of scores, in percent.
 *
 * Padded, then widened to MIN_SCORE_SPAN_PCT around the middle of the data,
 * then slid (not squashed) back inside 0..100 so the span promised above is
 * the span actually drawn. Whole numbers, because a tick reading "88.37%"
 * claims a precision 10,000 paths do not have.
 */
export function scoreDomain(percents: readonly number[]): [number, number] {
  if (percents.length === 0) return [0, 100];
  let lo = Math.min(...percents) - SCORE_AXIS_PAD_PCT;
  let hi = Math.max(...percents) + SCORE_AXIS_PAD_PCT;
  if (hi - lo < MIN_SCORE_SPAN_PCT) {
    const middle = (hi + lo) / 2;
    lo = middle - MIN_SCORE_SPAN_PCT / 2;
    hi = middle + MIN_SCORE_SPAN_PCT / 2;
  }
  // Slide rather than clamp: clamping a window that runs past 100 would narrow
  // it below the minimum span and re-introduce the exaggeration.
  const span = hi - lo;
  if (hi > 100) {
    hi = 100;
    lo = hi - span;
  }
  if (lo < 0) {
    lo = 0;
    hi = Math.min(100, lo + span);
  }
  return [Math.floor(lo), Math.ceil(hi)];
}

/**
 * Shown instead of the spend chart when no snapshot carries a figure.
 *
 * It is a likely state rather than an edge case: every score recorded before
 * the solve existed has a probability and no dollars, and there is no way to
 * work one out after the fact from what those rows stored. So the note says
 * which snapshots fill it — the ones taken from now on — instead of implying
 * the feature is broken.
 *
 * IT NO LONGER OFFERS A REPAIR. It used to point at a button that re-scored an
 * old row, and that button measured TODAY's plan and filed the answer on a row
 * recorded weeks ago. A chart filled that way would be a trend line through
 * points that were never true of the days under them, which is worse than an
 * empty chart.
 */
export function spendChartEmptyNote(): string {
  return (
    'No snapshot carries a sustainable-spend figure yet. Every score taken from now on solves ' +
    'for one; a row scored before that existed has none, and cannot be given one now — the ' +
    'answer would be measured against today, not against the day the row records.'
  );
}

/**
 * The y-axis window for a set of spend figures, in dollars.
 *
 * Padded, widened to MIN_SPEND_SPAN_USD around the middle of the data, floored
 * at zero (no plan supports negative spending) and snapped out to the solver's
 * own $500 bracket. The floor SLIDES the window rather than squashing it, for
 * the same reason the score axis does: a clamp would narrow the window below
 * the span promised above and re-introduce the exaggeration it prevents.
 */
export function spendDomain(values: readonly number[]): [number, number] {
  if (values.length === 0) return [0, MIN_SPEND_SPAN_USD];
  let lo = Math.min(...values) - SPEND_AXIS_PAD_USD;
  let hi = Math.max(...values) + SPEND_AXIS_PAD_USD;
  if (hi - lo < MIN_SPEND_SPAN_USD) {
    const middle = (hi + lo) / 2;
    lo = middle - MIN_SPEND_SPAN_USD / 2;
    hi = middle + MIN_SPEND_SPAN_USD / 2;
  }
  if (lo < 0) {
    const span = hi - lo;
    lo = 0;
    hi = span;
  }
  return [
    Math.floor(lo / SPEND_TICK_USD) * SPEND_TICK_USD,
    Math.ceil(hi / SPEND_TICK_USD) * SPEND_TICK_USD,
  ];
}

/**
 * Separator between a point's ordinal and its date inside `axisKey`. The
 * ordinal is what makes the key unique; the date rides along so the axis can
 * label itself from the key alone, without a lookup back into the series.
 */
const AXIS_KEY_SEP = '|';

/** The x value for the point at `index` — unique, and self-labelling. */
export function scoreAxisKey(index: number, date: string): string {
  return `${index}${AXIS_KEY_SEP}${date}`;
}

/** The tick text for an axis key: the date it was built from. */
export function scoreAxisTick(axisKey: string): string {
  const at = axisKey.indexOf(AXIS_KEY_SEP);
  return at < 0 ? axisKey : axisKey.slice(at + 1);
}

/** A recorded score as the axis and the tooltip say it: "94.1%". */
export function formatScorePct(pct: number): string {
  return `${pct.toFixed(1)}%`;
}

/**
 * WHICH MARK THIS POINT GETS — one answer for all three places that draw it:
 * the ringed dot, the boundary rule, and the hover card's border. One function
 * rather than three inline conditions, because three copies of a three-way rule
 * is how a point ends up ringed amber with a grey rule through it.
 *
 *  - 'break'   — PROVABLE. The plan changed under one naming rule, or the
 *                engine version changed. Those two numbers were never on one
 *                scale, and the chart says so outright.
 *  - 'unknown' — UNPROVABLE EITHER WAY. The two points named their plans under
 *                different rules. Still marked, because a boundary the app
 *                cannot reason about is still a boundary the reader must see —
 *                but marked differently, because "I cannot tell" is a weaker
 *                and different claim from "it changed", and drawing them alike
 *                is what made the user ask what the ring meant.
 *  - 'none'    — nothing recorded stands between these two numbers.
 *
 * A proven break OUTRANKS an unknown: when the engine version also moved, the
 * strong claim is true, and the strong claim is the one worth drawing.
 */
export type ScoreMark = 'none' | 'break' | 'unknown';

export function scoreMark(point: ScorePoint): ScoreMark {
  if (point.breaks.engine || point.breaks.plan === 'changed') return 'break';
  return point.breaks.plan === 'unknown' ? 'unknown' : 'none';
}

/**
 * THE TWO MARKS, IN WORDS, FOR THE EYE THAT NEVER HOVERS.
 *
 * The user's report on the first version of this was "I don't understand what
 * the dashed yellow line means or the yellow circle on Aug 20" — a legend
 * reading "not comparable with the point before it" said a mark existed
 * and nothing about which condition put it there. So each chip below states
 * its OWN condition, in full, and the two conditions are different sentences
 * because they are different claims.
 *
 * They live here, next to `scoreMark`, and are shared by both trend plots
 * rather than written twice in the page: two copies of one legend are how the
 * spend chart ends up explaining a ring the score chart has since renamed.
 */
export const BREAK_CHIP_LABEL =
  'a different plan, or a different engine, from the point before it';

export const UNKNOWN_CHIP_LABEL =
  'recorded differently from the point before it — no way to tell whether the plan changed';

/**
 * The same distinction at caption length, under BOTH plots.
 *
 * Worded for either chart (“measured”, not “scored” or “solved”) so one
 * sentence can serve both: the conditions are identical on the two plots, and
 * the spend chart used to draw the marks while explaining none of them.
 *
 * IT REFUSES TO GUESS, in both directions. It does not say the plan changed at
 * a grey ring, because the app cannot know that; and it does not say the two
 * numbers are fine to compare, because the app cannot know that either.
 */
export const COMPARABILITY_CAPTION =
  'An amber ring marks a point measured against a different plan, or by a different engine ' +
  'version, than the point before it: those two numbers were never on one scale, and the ' +
  'tooltip says which of the two it was. A grey dotted ring means something weaker and quite ' +
  'different — the two points record WHAT they measured in ways that cannot be compared (the ' +
  'older names the frozen baseline of its day, the newer the plan’s own identity, and neither ' +
  'name can be turned into the other). There the app cannot tell whether the plan changed, so ' +
  'it claims neither: not a plan change, and not a clean join.';

/**
 * WHAT THIS SCORE SAYS IT SCORED — the name, and the RULE that wrote it.
 *
 * Two vocabularies meet here. A score recorded since the collapse names the
 * plan's own identity (`planHash`: sha256 of `planIdentityKey`, name and
 * description excluded). One recorded before it names a frozen baseline record
 * (`baselineHash`, which covered the whole record, name included). A score that
 * carries neither says nothing at all about what it scored.
 *
 * THE RULE TRAVELS WITH THE NAME because comparing names is only meaningful
 * inside one rule. Verified against this ledger: today's plan.json hashes to
 * 7ff9a75c… under the baseline rule and f5cccb… under the identity rule, so an
 * unchanged plan produces two unequal names across the seam — always, for every
 * plan, by construction. A comparison across the rules measures the rules.
 */
type PlanNaming = { rule: 'identity' | 'baseline' | 'none'; name: string };

function planNaming(score: SnapshotScore): PlanNaming {
  if (score.planHash !== undefined) return { rule: 'identity', name: score.planHash };
  if (score.baselineHash !== undefined) return { rule: 'baseline', name: score.baselineHash };
  return { rule: 'none', name: '' };
}

/** What one boundary's plan comparison concludes. See PlanComparability. */
function comparePlans(score: SnapshotScore, previous: SnapshotScore): PlanComparability {
  const now = planNaming(score);
  const before = planNaming(previous);
  // Different rules — or a score that names nothing — is not a difference in
  // the plan, and must never be reported as one. A row that names nothing is
  // lumped in here rather than matched against another such row: two silences
  // agreeing is not evidence that one plan was scored twice.
  if (now.rule === 'none' || before.rule === 'none' || now.rule !== before.rule) return 'unknown';
  return now.name === before.name ? 'comparable' : 'changed';
}

/**
 * The point under the cursor, from the page's own hover index.
 *
 * Same discipline as the bar chart's `hoveredSlice`, and for the same reason:
 * recharts' tooltip payload is rebuilt from chart state the page's own
 * re-renders can invalidate, and a card that reads it can end up describing a
 * different day from the one being pointed at. Null is a blank card — never a
 * fallback to point 0, which is exactly the bug that cost a day here.
 */
export function scoreAt(points: readonly ScorePoint[], index: number | null): ScorePoint | null {
  if (index === null) return null;
  return points[index] ?? null;
}

/**
 * The lines the hover card shows under the headline: the conditions THIS point
 * was computed under, and every reason it may not be comparable to its
 * neighbour.
 *
 * Conditions are named on every point, not only the odd ones out. A tooltip
 * that mentioned the path count only when it changed would leave the reader
 * inferring that silence meant "the same as the last one you looked at", which
 * is a memory test rather than a label.
 */
export function scoreTooltipLines(point: ScorePoint): string[] {
  const score = point.score;
  if (score === null) {
    return point.reason === null
      ? ['Not scored — this snapshot has no score.']
      : [`Not scored — ${point.reason}`];
  }
  const lines = [
    `${score.paths.toLocaleString('en-US')} paths, seed ${score.seed}, engine ${score.engineVersion}`,
  ];
  // Only the older rows can say this, and they are the only ones that need to:
  // they scored a plan that was frozen separately from the plan of the day.
  if (score.baselineLabel !== undefined) {
    lines.push(`Baseline r${score.baselineRevision} — ${score.baselineLabel}`);
  }
  if (score.medianTerminalReal !== undefined) {
    lines.push(`Median terminal ${formatUSD(score.medianTerminalReal)} (real)`);
  }
  if (point.breaks.plan === 'changed') {
    lines.push(
      'Scored against a DIFFERENT plan than the point before it — the plan changed, so the ' +
        'step is not a change in your odds.',
    );
  }
  if (point.breaks.plan === 'unknown') {
    lines.push(
      'Recorded under DIFFERENT BOOKKEEPING from the point before it — one of the two names ' +
        'the frozen baseline it scored, the other names the plan itself, and neither name can ' +
        'be turned into the other. Whether the plan changed here is UNKNOWN, not settled.',
    );
  }
  if (point.breaks.engine) {
    lines.push(
      'Scored by a DIFFERENT engine version than the point before it — those two numbers were ' +
        'never on one scale.',
    );
  }
  if (score.planDriftedFromBaseline) {
    lines.push(
      'Your live plan had already drifted from the baseline when this was scored: the number is ' +
        'the baseline’s, not the plan you were editing.',
    );
  }
  return lines;
}

/**
 * The spend line's hover card, under its headline.
 *
 * It says the figure's OWN conditions, which are NOT the ones on the score
 * chart above it: the bisection runs at a capped path count, so this number is
 * measured coarser than the probability drawn from the same score block. A
 * reader who assumes both lines were measured alike will over-read a $2,000
 * step here.
 */
export function spendTooltipLines(point: ScorePoint): string[] {
  const score = point.score;
  if (score === null) {
    return point.reason === null
      ? ['Not scored — this snapshot has no score, so nothing solved for spending.']
      : [`Not scored — ${point.reason}`];
  }
  if (score.sustainableSpend === undefined) {
    // ABSENT IS NOT ZERO, and the two absences mean different things: a solve
    // that reported a reason (the plan clears the top of the bracket) is a
    // fact about the plan, while silence means nobody asked.
    // It does not name a cause. "Scored before the spend was measured" is true
    // of the August rows and false of a row whose solve was interrupted between
    // the probability and the bisection, and the row stores no way to tell the
    // two apart.
    return score.sustainableSpendError === undefined
      ? [
          'No figure — none was solved alongside this score, and none can be added: solving it ' +
            'today would answer for today, not for the day this row records.',
        ]
      : [`No figure — ${score.sustainableSpendError}`];
  }
  const lines: string[] = [];
  lines.push(
    score.sustainableSpendPaths === undefined
      ? `Bisected on seed ${score.seed}, engine ${score.engineVersion}`
      : `Bisected at ${score.sustainableSpendPaths.toLocaleString('en-US')} paths ` +
        `(the probability above used ${score.paths.toLocaleString('en-US')}), ` +
        `seed ${score.seed}, engine ${score.engineVersion}`,
  );
  lines.push(`Alongside a ${formatScorePct(score.success * 100)} chance of never running out`);
  if (point.breaks.plan === 'changed') {
    lines.push(
      'Solved for a DIFFERENT plan than the point before it — the plan changed, so the step is ' +
        'not a change in what your plan affords.',
    );
  }
  if (point.breaks.plan === 'unknown') {
    lines.push(
      'Recorded under DIFFERENT BOOKKEEPING from the point before it — the two rows name what ' +
        'they measured in ways that cannot be compared with each other, so whether the plan ' +
        'changed here is UNKNOWN, not settled.',
    );
  }
  if (point.breaks.engine) {
    lines.push(
      'Solved by a DIFFERENT engine version than the point before it — those two figures were ' +
        'never on one scale.',
    );
  }
  return lines;
}

/**
 * Assemble the series. One point per snapshot, in the ledger's own order, so
 * all three charts' x axes cannot disagree about what row 3 is.
 */
export function buildScoreSeries(snapshots: readonly NetWorthSnapshot[]): ScoreSeries {
  let previous: SnapshotScore | null = null;
  const points: ScorePoint[] = snapshots.map((s, index) => {
    const score = s.score ?? null;
    const breaks: ScorePoint['breaks'] =
      score === null || previous === null
        ? { plan: 'comparable', engine: false }
        : {
            plan: comparePlans(score, previous),
            engine: score.engineVersion !== previous.engineVersion,
          };
    if (score !== null) previous = score;
    const date = formatSnapshotDate(s.takenAt);
    return {
      date,
      axisKey: scoreAxisKey(index, date),
      takenAt: s.takenAt,
      pct: score === null ? null : score.success * 100,
      // `?? null` and never `?? 0`: the field is absent on every row scored
      // before the solve existed and on every solve that reported a reason
      // instead of a number, and both must leave a hole in the line.
      spend: score === null ? null : (score.sustainableSpend ?? null),
      score,
      reason: s.scoreError ?? null,
      breaks,
    };
  });

  const percents = points.flatMap((p) => (p.pct === null ? [] : [p.pct]));
  const spends = points.flatMap((p) => (p.spend === null ? [] : [p.spend]));
  return {
    points,
    scored: percents.length,
    domain: scoreDomain(percents),
    spendScored: spends.length,
    spendDomain: spendDomain(spends),
  };
}

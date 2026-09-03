/**
 * The score chart's assembly (src/ui/pages/netWorthScoreChart.ts) and its
 * wiring into the Net Worth page.
 *
 * This chart plots a probability over time, which is the shape most likely to
 * be read as a single golden number — so every property below is a guard
 * against it lying about one of the three things it cannot show on its own:
 *
 * 1. A SNAPSHOT WITH NO SCORE IS A GAP, NOT A ZERO. 0% means "this plan fails
 *    in every simulated future". A row taken before the feature existed and
 *    one whose run failed must both leave a hole in the line — and the ledger
 *    row must carry no `score` at all, so nothing downstream can read one as 0.
 * 2. TWO SCORES ARE NOT ALWAYS ON ONE SCALE. A different plan means a
 *    different thing was measured; a different engine version means a
 *    different measuring instrument. Both are invisible in the numbers, both
 *    are marked, and the mark is against the previous SCORED point (an
 *    unscored row carries no conditions to differ from).
 * 2b. AND "I CANNOT TELL" IS NOT "IT CHANGED". A row scored in the baseline
 *    era names its plan by a hash of the whole frozen record; a row scored
 *    since names it by `planIdentityKey`. The same plan hashes differently
 *    under the two rules, ALWAYS, so that one boundary could never compare
 *    equal — and the chart used to ring it and assert a plan change that never
 *    happened (an Aug 19 -> Aug 20 seam, on an unchanged plan). It gets its
 *    own mark and its own words now. It does NOT get to vanish: a boundary the
 *    app cannot reason about is still one the reader must see.
 * 3. THE AXIS MUST NOT INVENT MOVEMENT. Fitted tightly to the data, a 0.3pp
 *    wobble inside the engine's own noise fills the plot and reads as a crash;
 *    fixed at 0-100, this household's whole history is a flat line. The
 *    minimum span is the compromise, and it is pinned here.
 *
 * The source scan pins the SEPARATION: the score is its own plot under the
 * bars, sharing their categorical axis — not a second series with a second y
 * axis on the bars, where the eye reads a crossing point that means nothing.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { NetWorthSnapshot, SnapshotScore } from '../../src/shared/types';
import {
  BREAK_CHIP_LABEL,
  MIN_SCORE_SPAN_PCT,
  MIN_SPEND_SPAN_USD,
  SPEND_AXIS_PAD_USD,
  buildScoreSeries,
  formatScorePct,
  scoreAt,
  scoreAxisKey,
  scoreAxisTick,
  scoreChartEmptyNote,
  UNKNOWN_CHIP_LABEL,
  scoreDomain,
  scoreMark,
  scoreTooltipLines,
  spendChartEmptyNote,
  spendDomain,
  spendTooltipLines,
} from '../../src/ui/pages/netWorthScoreChart';

const read = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const page = read('../../src/ui/pages/NetWorthPage.tsx');

const score = (over: Partial<SnapshotScore> = {}): SnapshotScore => ({
  success: 0.94,
  medianTerminalReal: 3_100_000,
  mode: 'montecarlo',
  paths: 10_000,
  seed: 12_345,
  engineVersion: '1.21.0',
  planHash: 'a'.repeat(64),
  scoredAt: '2026-08-19T10:00:00.000Z',
  ...over,
});

/**
 * A score from before the collapse: it names a frozen baseline rather than the
 * plan, and those rows are still in the user's ledger.
 */
const baselineEraScore = (over: Partial<SnapshotScore> = {}): SnapshotScore => {
  const { planHash: _planHash, ...rest } = score();
  return {
    ...rest,
    baselineRevision: 1,
    baselineHash: 'f'.repeat(64),
    baselineLabel: 'Retire 2031',
    planDriftedFromBaseline: false,
    ...over,
  };
};

/** A ledger row; `score` is left off entirely when a test wants an unscored one. */
const row = (
  takenAt: string,
  over: Partial<NetWorthSnapshot> = {},
): NetWorthSnapshot => ({
  id: `nw-${takenAt}`,
  takenAt,
  total: 3_600_000,
  homeValue: 550_000,
  accounts: [],
  prices: {},
  ...over,
});

describe('buildScoreSeries — one point per snapshot, in the bars’ own order', () => {
  it('gives every snapshot a tick, scored or not, so the two axes cannot disagree', () => {
    const series = buildScoreSeries([
      row('2026-06-01T12:00:00.000Z'),
      row('2026-07-01T12:00:00.000Z', { score: score({ success: 0.93 }) }),
      row('2026-08-01T12:00:00.000Z', { score: score({ success: 0.94 }) }),
    ]);
    expect(series.points).toHaveLength(3);
    expect(series.points.map((p) => p.date)).toEqual(['Jun 1, 2026', 'Jul 1, 2026', 'Aug 1, 2026']);
    expect(series.scored).toBe(2);
  });

  it('leaves a GAP for an unscored snapshot — never a zero', () => {
    // The failure this prevents: 0% is "fails in every future", and drawing
    // one for "nobody has scored this row" puts an imaginary collapse on the
    // chart the user reads to see whether anything changed.
    const series = buildScoreSeries([
      row('2026-06-01T12:00:00.000Z', { score: score({ success: 0.94 }) }),
      row('2026-07-01T12:00:00.000Z'),
      row('2026-08-01T12:00:00.000Z', { score: score({ success: 0.93 }) }),
    ]);
    expect(series.points.map((p) => p.pct)).toEqual([94, null, 93]);
    expect(series.points[1].score).toBeNull();
    expect(series.points[1].pct).not.toBe(0);
  });

  it('carries the reason a row has no score, when it recorded one', () => {
    const series = buildScoreSeries([
      row('2026-07-01T12:00:00.000Z', { scoreError: 'The simulation failed: code 3' }),
    ]);
    expect(series.points[0].pct).toBeNull();
    expect(series.points[0].reason).toBe('The simulation failed: code 3');
    expect(scoreTooltipLines(series.points[0])[0]).toContain('The simulation failed');
  });

  it('says "not scored" without inventing a reason when there is none', () => {
    const series = buildScoreSeries([row('2026-07-01T12:00:00.000Z')]);
    expect(scoreTooltipLines(series.points[0])).toEqual([
      'Not scored — this snapshot has no score.',
    ]);
  });

  it('calls two planHash scores with different hashes a real plan CHANGE', () => {
    // Not "my odds improved" — a different plan was measured. One naming rule
    // applied twice to two different names is the one case where inequality is
    // a fact about the plans, and it keeps the strong mark and the strong words.
    const before = 'a'.repeat(64);
    const after = 'b'.repeat(64);
    const series = buildScoreSeries([
      row('2026-06-01T12:00:00.000Z', { score: score({ success: 0.9, planHash: before }) }),
      row('2026-07-01T12:00:00.000Z', { score: score({ success: 0.96, planHash: after }) }),
      row('2026-08-01T12:00:00.000Z', { score: score({ success: 0.97, planHash: after }) }),
    ]);
    expect(series.points.map((p) => p.breaks.plan)).toEqual([
      'comparable',
      'changed',
      'comparable',
    ]);
    expect(series.points.map(scoreMark)).toEqual(['none', 'break', 'none']);
    expect(scoreTooltipLines(series.points[1]).join(' ')).toContain('DIFFERENT plan');
  });

  it('does NOT mark two planHash scores of the same plan, however far apart', () => {
    // The ordinary case, and the one the marks exist to stay quiet for: the
    // plan has not moved, so the step between the two numbers is the world
    // moving, which is exactly what the chart is for. No mark of either kind —
    // a quiet boundary must not pick up the grey ring on its way past.
    const series = buildScoreSeries([
      row('2026-06-01T12:00:00.000Z', { score: score({ success: 0.9 }) }),
      row('2026-07-01T12:00:00.000Z', { score: score({ success: 0.96 }) }),
    ]);
    expect(series.points[1].breaks.plan).toBe('comparable');
    expect(scoreMark(series.points[1])).toBe('none');
    expect(scoreTooltipLines(series.points[1]).join(' ')).not.toContain('DIFFERENT');
    expect(scoreTooltipLines(series.points[1]).join(' ')).not.toContain('BOOKKEEPING');
  });

  it('calls a baselineHash score followed by a planHash score UNKNOWN, not a plan change', () => {
    // HIS LEDGER, TO THE DIGIT. The Aug-19 row names a frozen baseline
    // (7ff9a75c…), every row since names the plan's own identity (f5cccb…) —
    // and both are fingerprints of THE SAME UNCHANGED plan.json, taken under
    // two rules. sha256(stableStringify(scenario)) is the first, and
    // sha256(planIdentityKey(scenario)) is the second, verified against the
    // file itself. So the two names could never have matched, whatever the
    // plan did, and the ring that used to appear here asserted a change that
    // did not happen.
    const AUG_19_BASELINE = '7ff9a75c12f24aa17af4d8fc64dc89d9ce8b7ba62e202a6baa0132fe26b5687e';
    const AUG_20_IDENTITY = 'f5cccb2374910405ea367fd8d9f930460f6559ddc8cecc60d5772f56b6b15610';
    const series = buildScoreSeries([
      row('2026-08-19T12:51:50.866Z', {
        score: baselineEraScore({ success: 0.942, baselineHash: AUG_19_BASELINE }),
      }),
      row('2026-08-20T11:14:22.215Z', {
        score: score({ success: 0.9694, planHash: AUG_20_IDENTITY }),
      }),
    ]);
    expect(series.points[1].breaks.plan).toBe('unknown');
    // Still visible — the app cannot reason about this boundary and must not
    // draw it as a clean join either.
    expect(scoreMark(series.points[1])).toBe('unknown');
    const said = scoreTooltipLines(series.points[1]).join(' ');
    expect(said).toContain('DIFFERENT BOOKKEEPING');
    expect(said).toContain('UNKNOWN, not settled');
    // And it must NOT make the strong claim any more. It may still use the
    // words "the plan changed" — "whether the plan changed is unknown" is the
    // whole point — but never as the assertion the old line made.
    expect(said).not.toContain('DIFFERENT plan');
    expect(said).not.toContain('the plan changed, so');
  });

  it('calls a score that names no plan at all UNKNOWN, never a match', () => {
    // Two silences agreeing is not evidence that one plan was scored twice.
    const { planHash: _planHash, ...nameless } = score();
    const series = buildScoreSeries([
      row('2026-06-01T12:00:00.000Z', { score: nameless }),
      row('2026-07-01T12:00:00.000Z', { score: nameless }),
    ]);
    expect(series.points[1].breaks.plan).toBe('unknown');
  });

  it('lets a proven engine break outrank an unknown plan comparison', () => {
    // Both conditions at one boundary: the engine moved, which IS provable, so
    // the strong mark is the true one and is the one drawn.
    const series = buildScoreSeries([
      row('2026-06-01T12:00:00.000Z', { score: baselineEraScore({ engineVersion: '1.20.0' }) }),
      row('2026-07-01T12:00:00.000Z', { score: score({ engineVersion: '1.21.0' }) }),
    ]);
    expect(series.points[1].breaks.plan).toBe('unknown');
    expect(series.points[1].breaks.engine).toBe(true);
    expect(scoreMark(series.points[1])).toBe('break');
  });

  it('marks two baseline-era scores whose frozen plans differed', () => {
    // The ledger's older rows still have to be readable against each other,
    // and the rule that applies to them is their own hash.
    const series = buildScoreSeries([
      row('2026-06-01T12:00:00.000Z', { score: baselineEraScore({ baselineHash: 'c'.repeat(64) }) }),
      row('2026-07-01T12:00:00.000Z', { score: baselineEraScore({ baselineHash: 'd'.repeat(64) }) }),
    ]);
    // One rule, two names: provable, and it keeps the strong mark.
    expect(series.points[1].breaks.plan).toBe('changed');
    expect(scoreMark(series.points[1])).toBe('break');
  });

  it('does NOT mark a baseline re-freeze that only renamed the plan', () => {
    // A revision bump with an identical frozen plan was an ordinary thing to
    // do. Marking it would say two identical measurements were never on one
    // scale — which is why the comparison reads the hash and not the revision.
    const frozen = 'c'.repeat(64);
    const series = buildScoreSeries([
      row('2026-06-01T12:00:00.000Z', {
        score: baselineEraScore({ baselineRevision: 3, baselineHash: frozen, baselineLabel: 'Base case' }),
      }),
      row('2026-07-01T12:00:00.000Z', {
        score: baselineEraScore({ baselineRevision: 4, baselineHash: frozen, baselineLabel: 'Retire 2031' }),
      }),
    ]);
    expect(series.points[1].breaks.plan).toBe('comparable');
    expect(scoreMark(series.points[1])).toBe('none');
  });

  it('marks a point scored by a DIFFERENT engine version', () => {
    // ENGINE_VERSION is part of the run-cache key precisely because two
    // engines do not agree; the same reason applies one layer up, here.
    const series = buildScoreSeries([
      row('2026-06-01T12:00:00.000Z', { score: score({ engineVersion: '1.20.0' }) }),
      row('2026-07-01T12:00:00.000Z', { score: score({ engineVersion: '1.21.0' }) }),
    ]);
    expect(series.points.map((p) => p.breaks.engine)).toEqual([false, true]);
    // Unweakened: a differing engine version is provable incomparability, and
    // the three-way plan rule beside it changes nothing about that.
    expect(scoreMark(series.points[1])).toBe('break');
    expect(scoreTooltipLines(series.points[1]).join(' ')).toContain('DIFFERENT engine');
  });

  it('compares against the previous SCORED point, across an unscored gap', () => {
    // The row in the middle carries no conditions at all, so it cannot be the
    // thing a comparability break is measured against.
    const series = buildScoreSeries([
      row('2026-06-01T12:00:00.000Z', { score: score({ planHash: 'a'.repeat(64) }) }),
      row('2026-07-01T12:00:00.000Z'),
      row('2026-08-01T12:00:00.000Z', { score: score({ planHash: 'b'.repeat(64) }) }),
    ]);
    expect(series.points[2].breaks.plan).toBe('changed');
    expect(series.points[1].breaks).toEqual({ plan: 'comparable', engine: false });
  });

  it('never marks the FIRST scored point — there is nothing behind it', () => {
    const series = buildScoreSeries([
      row('2026-06-01T12:00:00.000Z'),
      row('2026-07-01T12:00:00.000Z', { score: score({ planHash: 'e'.repeat(64) }) }),
    ]);
    expect(scoreMark(series.points[1])).toBe('none');
  });

  it('surfaces drift on the older points where it was true', () => {
    // Only a baseline-era score can say this, and it is a fact about that
    // number: the plan being edited had already moved away from the frozen one.
    const series = buildScoreSeries([
      row('2026-07-01T12:00:00.000Z', {
        score: baselineEraScore({ planDriftedFromBaseline: true }),
      }),
    ]);
    expect(scoreTooltipLines(series.points[0]).join(' ')).toContain('drifted');
  });

  it('names every condition on every point, not only the odd ones out', () => {
    // A tooltip that mentioned the path count only when it changed would make
    // silence mean "same as the last one you looked at" — a memory test.
    const lines = scoreTooltipLines(buildScoreSeries([
      row('2026-07-01T12:00:00.000Z', { score: score() }),
    ]).points[0]);
    expect(lines[0]).toBe('10,000 paths, seed 12345, engine 1.21.0');
    // A plan score has no label to give; the older rows carry theirs.
    expect(lines).not.toContain('Baseline r1 — Retire 2031');
    const older = scoreTooltipLines(buildScoreSeries([
      row('2026-07-01T12:00:00.000Z', { score: baselineEraScore() }),
    ]).points[0]);
    expect(older[1]).toBe('Baseline r1 — Retire 2031');
  });

  it('reads an empty ledger as an empty series, not as a chart of nothing', () => {
    const series = buildScoreSeries([]);
    expect(series.points).toEqual([]);
    expect(series.scored).toBe(0);
  });

  it('draws ONE point as one point — a single dot, not a broken line', () => {
    const series = buildScoreSeries([row('2026-08-19T12:00:00.000Z', { score: score() })]);
    expect(series.scored).toBe(1);
    expect(series.points[0].pct).toBe(94);
    // And it still gets an axis it sits inside rather than on.
    expect(series.domain[0]).toBeLessThan(94);
    expect(series.domain[1]).toBeGreaterThan(94);
  });
});

describe('two snapshots on one day', () => {
  /**
   * A category axis whose values repeat is not the axis it looks like.
   * recharts throws duplicated category values away and scales on serial
   * numbers instead — so a ReferenceLine addressed by the visible date lands
   * outside the scale's domain and, with the default ifOverflow="discard", is
   * dropped WITHOUT A WORD in the console.
   *
   * A representative ledger already has two rows dated Aug 19, 2026, and the
   * live page drew none of its comparability rules because of it: the marks
   * that say "these two numbers were never on one scale" simply were not
   * there. So the x value every point is addressed by has to be unique, and
   * the tick text is formatted back out of it.
   */
  const sameDay = [
    row('2026-08-19T09:43:20.873Z', { score: score({ success: 0.941 }) }),
    row('2026-08-19T12:51:50.866Z', { score: score({ success: 0.942, engineVersion: '1.22.0' }) }),
  ];

  it('label the same tick, and are still two different points on the axis', () => {
    const series = buildScoreSeries(sameDay);
    expect(series.points[0].date).toBe(series.points[1].date);
    expect(new Set(series.points.map((p) => p.axisKey)).size).toBe(2);
  });

  it('every axis key in a series is unique, whatever the dates do', () => {
    const series = buildScoreSeries([
      ...sameDay,
      row('2026-08-19T18:00:00.000Z'),
      row('2026-08-20T09:00:00.000Z', { score: score() }),
    ]);
    expect(new Set(series.points.map((p) => p.axisKey)).size).toBe(series.points.length);
  });

  it('the axis reads the date back out of the key, so the ticks are unchanged', () => {
    const series = buildScoreSeries(sameDay);
    for (const p of series.points) expect(scoreAxisTick(p.axisKey)).toBe(p.date);
    // A key that never went through scoreAxisKey is returned whole rather than
    // silently truncated.
    expect(scoreAxisTick('Aug 19, 2026')).toBe('Aug 19, 2026');
    expect(scoreAxisTick(scoreAxisKey(11, 'Sep 1, 2026'))).toBe('Sep 1, 2026');
  });
});

describe('scoreDomain — an axis that shows real movement and invents none', () => {
  it('never squashes this household’s range into a 0-100 flatline', () => {
    // 88-97 is where these scores live. On a full axis that is nine pixels of
    // a 260px plot: every point on the same line.
    const [lo, hi] = scoreDomain([88.4, 91.2, 96.8]);
    expect(lo).toBeGreaterThan(80);
    expect(hi).toBeLessThanOrEqual(100);
    expect(lo).toBeLessThan(88.4);
    expect(hi).toBeGreaterThan(96.8);
  });

  it('never inflates a wobble inside the engine’s own noise', () => {
    // Three readings 0.2pp apart are the same number at 10,000 paths. Fitted
    // tightly they would fill the plot and read as a collapse and a recovery.
    const [lo, hi] = scoreDomain([93.9, 94.0, 94.1]);
    expect(hi - lo).toBeGreaterThanOrEqual(MIN_SCORE_SPAN_PCT);
  });

  it('keeps the promised span when the data sits against 100%', () => {
    // Clamping instead of sliding would narrow the window below the minimum
    // and re-introduce the exaggeration at exactly the interesting end.
    const [lo, hi] = scoreDomain([99.4, 100]);
    expect(hi).toBe(100);
    expect(hi - lo).toBeGreaterThanOrEqual(MIN_SCORE_SPAN_PCT);
  });

  it('never runs below 0% or above 100% — they are not possible readings', () => {
    expect(scoreDomain([0.5])[0]).toBe(0);
    expect(scoreDomain([100])[1]).toBe(100);
  });

  it('uses whole percentage points, which is all 10,000 paths can support', () => {
    const [lo, hi] = scoreDomain([88.37, 96.82]);
    expect(Number.isInteger(lo)).toBe(true);
    expect(Number.isInteger(hi)).toBe(true);
  });

  it('falls back to the full axis when there is nothing to fit', () => {
    expect(scoreDomain([])).toEqual([0, 100]);
  });
});

describe('scoreAt — the card describes the point under the cursor', () => {
  const series = buildScoreSeries([
    row('2026-06-01T12:00:00.000Z', { score: score({ success: 0.9 }) }),
    row('2026-07-01T12:00:00.000Z', { score: score({ success: 0.95 }) }),
  ]);

  it('resolves the hovered index against the same points the chart drew', () => {
    expect(scoreAt(series.points, 1)?.pct).toBe(95);
  });

  it('draws nothing — never point 0 — when nothing resolves', () => {
    // Guessing is the bug the bar chart above already paid for once.
    expect(scoreAt(series.points, null)).toBeNull();
    expect(scoreAt(series.points, 9)).toBeNull();
  });
});

describe('formatScorePct', () => {
  it('shows one decimal: enough to see a real move, not more than the paths support', () => {
    expect(formatScorePct(94.06)).toBe('94.1%');
    expect(formatScorePct(88)).toBe('88.0%');
  });
});

describe('the score chart’s wiring (source scan)', () => {
  it('is a SEPARATE chart under the bars, on the bars’ own categorical axis', () => {
    // Not an overlay: dollars and a probability need two scales, and two
    // scales make the eye read a crossing point that means nothing at all.
    expect(page).toContain('<LineChart');
    expect(page).toContain('<BarChart');
    // One y axis per chart. A second <YAxis yAxisId=...> on the bar chart is
    // exactly the shape this decision rejected.
    expect(page).not.toContain('yAxisId');
    // Same x, same order: the score chart is fed the series built from the
    // same snapshots, so reading straight down from a bar lands on its score.
    expect(page).toContain('buildScoreSeries(snapshots ?? [])');
    // The bars are keyed on the date; the score line is keyed on the unique
    // per-row key and labelled back to that same date, because a repeated
    // category value silently disables the boundary rules (see above).
    expect(page).toContain('<XAxis dataKey="date"');
    expect(page).toContain('dataKey="axisKey"');
    expect(page).toContain('tickFormatter={scoreAxisTick}');
  });

  it('never joins across a snapshot with no score', () => {
    // connectNulls would draw a straight segment through days nothing was
    // measured — a trend line invented out of two real points.
    expect(page).toContain('connectNulls={false}');
  });

  it('fits the axis to the data instead of forcing 0-100', () => {
    expect(page).toContain('domain={domain}');
    expect(page).toContain('scoreSeries.domain');
  });

  it('marks the points that are not comparable with their neighbour', () => {
    // Both marks: the ringed dot on the point, and the rule on the boundary —
    // the incomparability is BETWEEN two points, not a property of either.
    expect(page).toContain('const mark = scoreMark(datum);');
    expect(page).toContain('<ReferenceLine');
    expect(page).toContain('const mark = scoreMark(p);');
    // Addressed by the unique key, never by the date: two snapshots on one
    // day would put the date outside the axis' own scale, and recharts
    // discards a reference line it cannot place without saying so.
    expect(page).toContain('x={p.axisKey}');
    expect(page).not.toContain('x={p.date}');
    // The old two-way predicate is gone rather than left beside the new rule:
    // one live rule and one dead one is how the dot and the boundary end up
    // disagreeing about the same point.
    expect(page).not.toContain('isComparabilityBreak');
  });

  it('draws the unknown boundary DIFFERENTLY from the proven break', () => {
    // The user's question was "I don't understand what the dashed yellow line
    // means or the yellow circle on Aug 20". One mark carrying two different
    // claims is what made it unanswerable, so the two claims get two marks —
    // and they differ in STROKE as well as colour, because colour alone is a
    // channel a colour-blind reader does not have.
    expect(page).toContain("if (mark === 'break') return chart.amber;");
    expect(page).toContain("return mark === 'unknown' ? chart.neutralStrong : null;");
    expect(page).toContain("strokeDasharray={mark === 'break' ? '4 4' : '1 5'}");
    expect(page).toContain("strokeDasharray={mark === 'unknown' ? '2 2' : undefined}");
  });

  it('lets the legend chips carry the distinction without a hover', () => {
    // He had to ask what the marks meant. Each chip states its OWN condition,
    // the two chips are two different sentences because they are two different
    // claims, and BOTH plots get both — the spend chart used to draw the marks
    // and explain none of them.
    expect(BREAK_CHIP_LABEL).toContain('a different plan, or a different engine');
    expect(UNKNOWN_CHIP_LABEL).toContain('no way to tell whether the plan changed');
    // Rendered twice each — once under the score plot, once under the spend
    // plot — from the one definition, so the two legends cannot drift apart.
    expect(page.match(/\{BREAK_CHIP_LABEL\}/g)?.length).toBe(2);
    expect(page.match(/\{UNKNOWN_CHIP_LABEL\}/g)?.length).toBe(2);
    // Distinct glyphs, in the marks' own colours, so the chip is readable as
    // the thing on the plot rather than as a colour swatch.
    expect(page).toContain('<span style={{ color: chart.amber }}>○</span> {BREAK_CHIP_LABEL}');
    expect(page).toContain(
      '<span style={{ color: chart.neutralStrong }}>◌</span> {UNKNOWN_CHIP_LABEL}',
    );
    // The caption paragraphs under both plots are GONE (the owner's fluff
    // rule, 2026-08-31) — the chips and each point's tooltip carry the
    // conditions now, and nothing may reintroduce a legend paragraph.
    expect(page).not.toContain('COMPARABILITY_CAPTION');
    expect(page).not.toContain('probability of never running out');
    expect(page).not.toContain('highest annual LIVING spend');
  });

  it('keeps the house rule: no entry animation on either chart', () => {
    expect(page.match(/isAnimationActive=\{false\}/g)?.length).toBeGreaterThanOrEqual(3);
  });

  it('says nothing at all rather than an empty plot before the first score', () => {
    // And it says the RIGHT nothing. There is no missing step to send the
    // owner off to fix any more — there is one plan and it is always
    // scoreable — so it names what happens next and what to press for the rows
    // already there.
    expect(scoreChartEmptyNote()).toContain('The next one will record what your plan scores');
    expect(scoreChartEmptyNote()).toContain('Older rows can be scored');
    expect(page).toContain('scoreSeries.scored === 0');
    expect(page).toContain('scoreChartEmptyNote()');
  });
});

describe('the ledger table’s score cell (source scan)', () => {
  it('never renders a scoreless row as 0%', () => {
    // Four states, and none of them is a number: a score, a run in flight, a
    // failed run with its reason, and a row nobody has scored.
    expect(page).toContain('formatScorePct(s.score.success * 100)');
    expect(page).toContain('scoring…');
    // Words, not a dash: "not measured" is a statement, and a permanent one.
    expect(page).toContain('not measured');
    // The cell is reached only through `s.score ?`, so there is no branch in
    // which a missing score can be multiplied into a zero.
    expect(page).toMatch(/\{s\.score \? \(/);
    expect(page).not.toContain('s.score?.success ?? 0');
    expect(page).not.toContain('score?.success || 0');
  });

  it('offers NO scoring affordance on any row, whatever state it is in', () => {
    /*
     * THE REPLACEMENT FOR "offers a re-score on a scoreless row". Every version
     * of that button — "Score it", "Try again", "Add the spend figure" — ran
     * TODAY's plan against TODAY's profile and filed the answer on a row
     * recorded on a different day under a different plan. The number it
     * produced was never true of the row it landed on, which is the one thing
     * a ledger row is for.
     *
     * Delete is the only action left on a row, and that is the assertion.
     */
    expect(page).not.toContain('rescoreNetWorthSnapshot');
    expect(page).not.toContain('Add the spend figure');
    expect(page).not.toContain('spendUnmeasured');
    expect(page).not.toMatch(/>\s*Score it\s*</);
    expect(page).not.toMatch(/>\s*Try again\s*</);
  });

  it('says a scoreless row is unmeasured for good, not waiting to be filled', () => {
    // The cost of removing the button, stated where it is paid. A row whose run
    // died stays scoreless, and "this was not measured" is a true statement
    // about that day — which is more than a fabricated figure would be.
    expect(page).toContain('cannot be now');
    expect(page).toContain('row stays unscored');
    expect(page).toContain('the plan is scored once, when the snapshot is taken');
  });

  it('shows the reason a row failed in full, not only in a tooltip', () => {
    expect(page).toContain('has no score: {s.scoreError}');
  });
});

describe('what the scores on this page are scores OF (source scan)', () => {
  it('says whose score it is, on the chart and on the row', () => {
    // Never "your plan right now": a recorded score is of the plan as it stood
    // when it was taken, and a reader who forgets that reads the chart wrong.
    expect(page).toContain('The plan, as scored');
    // The header card that spelled this out retired with the tab redesign
    // (2026-08-30); the row titles and the table footer carry it now.
    expect(page).toContain('the plan is scored once, when the snapshot is taken');
    expect(page).toContain('<th style={{ textAlign: \'right\' }}>Plan score</th>');
  });

  it('keeps the older rows’ own words rather than papering over them', () => {
    // A user has a recorded score that named a frozen baseline, by revision
    // and label. That is a historical fact about a point already on the chart.
    expect(page).toContain('baseline r${score.baselineRevision}');
    expect(page).toContain('the plan as it then stood');
  });

  it('has no baseline left to designate, drift from, or re-freeze', () => {
    expect(page).not.toContain('putBaseline');
    expect(page).not.toContain('redesignate');
    expect(page).not.toContain('no longer matches this baseline');
  });

  it('lets the snapshots table scroll SIDEWAYS inside its own card', () => {
    // Every cell in this table is `white-space: nowrap` (styles.css), so five
    // money columns are already wider than the card they sit in on a narrow
    // window — and the page would then hand the WHOLE window a horizontal
    // scrollbar, scrolling the heading and the charts along with it. That got
    // worse, not better, when the table moved under the bars (2026-09-03):
    // sideways scrolling now drags the chart too. `.table-scroll` is the app's
    // answer to exactly this, and every other wide table here already uses it.
    expect(page).toContain('<div className="table-scroll managedTableWrap"');
  });
});

// ---------------------------------------------------------------------------
// The sustainable-spend trend
// ---------------------------------------------------------------------------

/**
 * The second line, and for this household the load-bearing one: its success
 * rate saturates near the ceiling, so the probability trend can be flat while
 * the plan gets materially better or worse. What separates two versions is
 * what they could afford.
 *
 * The gap rule is the SAME rule as the score's and the reason is the same
 * shape: $0/yr says "this household can afford nothing", which is a very
 * different and much worse claim than "nobody solved for this". There are
 * THREE ordinary ways a row ends up with no figure and none of them is zero.
 */
describe('the spend series draws dollars, and draws nothing where there are none', () => {
  const spent = (usd: number, over: Partial<SnapshotScore> = {}): SnapshotScore =>
    score({ sustainableSpend: usd, sustainableSpendPaths: 2_000, ...over });

  it('reads the figure off the score block, one point per snapshot', () => {
    const series = buildScoreSeries([
      row('2026-06-01T12:00:00.000Z', { score: spent(78_000) }),
      row('2026-07-01T12:00:00.000Z', { score: spent(81_500) }),
    ]);
    expect(series.points.map((p) => p.spend)).toEqual([78_000, 81_500]);
    expect(series.spendScored).toBe(2);
  });

  it('gaps a row with no score at all', () => {
    const series = buildScoreSeries([
      row('2026-06-01T12:00:00.000Z', { score: spent(78_000) }),
      row('2026-07-01T12:00:00.000Z'),
    ]);
    expect(series.points.map((p) => p.spend)).toEqual([78_000, null]);
    expect(series.points[1].spend).not.toBe(0);
  });

  it('gaps a row whose score carries no spend figure, without guessing why', () => {
    // A representative ledger has one of these: a scored row recorded when a
    // score was a probability and nothing else. The tooltip says the figure is
    // absent and permanent, and stops — a solve INTERRUPTED between the
    // probability and the bisection leaves the identical shape, and the row
    // stores no way to tell the two apart.
    const series = buildScoreSeries([row('2026-07-01T12:00:00.000Z', { score: score() })]);
    expect(series.points[0].pct).toBe(94);
    expect(series.points[0].spend).toBeNull();
    expect(series.spendScored).toBe(0);
    const line = spendTooltipLines(series.points[0])[0];
    expect(line).toContain('none was solved alongside this score');
    expect(line).toContain('none can be added');
    expect(line).not.toContain('scored before');
  });

  it('gaps a row whose solve reported a reason instead of a number', () => {
    // An over-funded plan clears the top of the solver's bracket, and the
    // truth is "more than this", not "this". Recording the ceiling as the
    // answer would put a figure on the chart nothing measured.
    const series = buildScoreSeries([
      row('2026-07-01T12:00:00.000Z', {
        score: score({
          sustainableSpendError:
            'Even $400,000/yr clears this plan’s success target, so the sustainable level is ' +
            'above the top of the solver’s range — more than this, not this.',
        }),
      }),
    ]);
    expect(series.points[0].spend).toBeNull();
    expect(spendTooltipLines(series.points[0])[0]).toContain('above the top of the solver');
  });

  it('counts the two absences separately from the score’s', () => {
    // A row can carry a perfectly good probability and no dollars for ever, so
    // "how many points does the spend line have" is its own question.
    const series = buildScoreSeries([
      row('2026-06-01T12:00:00.000Z', { score: score() }),
      row('2026-07-01T12:00:00.000Z', { score: spent(81_500) }),
      row('2026-08-01T12:00:00.000Z'),
    ]);
    expect(series.scored).toBe(2);
    expect(series.spendScored).toBe(1);
  });
});

describe('the spend tooltip says what its own number was measured with', () => {
  it('names the path count the BISECTION used, and the one the probability used', () => {
    // They are not the same number and never can be: the solver caps its inner
    // sweeps, so this figure is the coarser of the two on the page. A reader
    // who assumes both lines were measured alike over-reads a $2,000 step.
    const series = buildScoreSeries([
      row('2026-07-01T12:00:00.000Z', {
        score: score({ sustainableSpend: 64_199, sustainableSpendPaths: 2_000, paths: 10_000 }),
      }),
    ]);
    const lines = spendTooltipLines(series.points[0]);
    expect(lines[0]).toContain('Bisected at 2,000 paths');
    expect(lines[0]).toContain('the probability above used 10,000');
    expect(lines[0]).toContain('engine 1.21.0');
    // And the probability beside it, so the two readings are never separated
    // from each other by a chart boundary.
    expect(lines[1]).toContain('94.0% chance of never running out');
  });

  it('marks a step across a plan change as a change of subject, not of affordability', () => {
    const series = buildScoreSeries([
      row('2026-06-01T12:00:00.000Z', { score: score({ sustainableSpend: 78_000 }) }),
      row('2026-07-01T12:00:00.000Z', {
        score: score({ sustainableSpend: 95_000, planHash: 'b'.repeat(64) }),
      }),
    ]);
    expect(series.points[1].breaks.plan).toBe('changed');
    expect(spendTooltipLines(series.points[1]).join(' ')).toContain(
      'not a change in what your plan affords',
    );
  });

  it('says the spend boundary is UNKNOWN, not a plan change, across the bookkeeping seam', () => {
    // Same rule as the probability above it, and it must be said here too: the
    // spend chart draws the same marks and used to explain none of them.
    const series = buildScoreSeries([
      row('2026-06-01T12:00:00.000Z', {
        score: baselineEraScore({ sustainableSpend: 78_000 }),
      }),
      row('2026-07-01T12:00:00.000Z', { score: score({ sustainableSpend: 64_570 }) }),
    ]);
    const said = spendTooltipLines(series.points[1]).join(' ');
    expect(said).toContain('DIFFERENT BOOKKEEPING');
    expect(said).toContain('UNKNOWN, not settled');
    expect(said).not.toContain('DIFFERENT plan');
  });

  it('marks a step across an engine bump the same way', () => {
    const series = buildScoreSeries([
      row('2026-06-01T12:00:00.000Z', { score: score({ sustainableSpend: 78_000 }) }),
      row('2026-07-01T12:00:00.000Z', {
        score: score({ sustainableSpend: 95_000, engineVersion: '1.22.0' }),
      }),
    ]);
    expect(series.points[1].breaks.engine).toBe(true);
    expect(spendTooltipLines(series.points[1]).join(' ')).toContain('never on one scale');
  });
});

describe('spendDomain — a dollar axis that cannot invent movement', () => {
  it('pads the observed range rather than drawing the extremes on the axis lines', () => {
    const [lo, hi] = spendDomain([70_000, 90_000]);
    expect(lo).toBeLessThanOrEqual(70_000 - SPEND_AXIS_PAD_USD);
    expect(hi).toBeGreaterThanOrEqual(90_000 + SPEND_AXIS_PAD_USD);
  });

  it('never shows a window narrower than the solver could resolve', () => {
    // Three figures $300 apart are ONE figure to a bisection that stops at a
    // $500 bracket. Fitted tightly they would fill the plot and read as a
    // collapse and recovery that the engine never measured.
    const [lo, hi] = spendDomain([81_800, 81_950, 82_100]);
    expect(hi - lo).toBeGreaterThanOrEqual(MIN_SPEND_SPAN_USD);
  });

  it('slides off the floor rather than squashing against it — spending is never negative', () => {
    const [lo, hi] = spendDomain([1_000]);
    expect(lo).toBe(0);
    // Sliding, not clamping: a clamp would narrow the window below the span
    // promised above and re-introduce the exaggeration it prevents.
    expect(hi - lo).toBeGreaterThanOrEqual(MIN_SPEND_SPAN_USD);
  });

  it('snaps ticks to the solver’s own $500 bracket', () => {
    // A tick reading "$64,200" claims a precision twelve probes at a capped
    // path count do not have.
    const [lo, hi] = spendDomain([64_200, 66_339]);
    expect(lo % 500).toBe(0);
    expect(hi % 500).toBe(0);
  });

  it('answers an empty set without dividing by anything', () => {
    expect(spendDomain([])).toEqual([0, MIN_SPEND_SPAN_USD]);
  });
});

describe('the spend chart’s wiring (source scan)', () => {
  it('is a THIRD plot, not a second axis on either of the other two', () => {
    // (The axis-label heading retired with the tab redesign — the Spend tab
    // names the plot now; the separation pins below are the load-bearing ones.)
    // The spec is completed per render (its tooltip needs the LIVE in-flight
    // registry — the Phase-4 wording-quirk fix), but it is still the spend
    // spec on its own third plot.
    expect(page).toContain('spec={spendTrend}');
    expect(page).toMatch(/\.\.\.SPEND_TREND/);
    // Still one y axis per chart. A second <YAxis yAxisId=...> is exactly the
    // shape this decision rejects — dollars and a percentage on one plot make
    // the eye read a crossing point that means nothing.
    expect(page).not.toContain('yAxisId');
    // Same points, same order, so reading straight down from a bar lands on
    // that day's figure.
    expect(page).toMatch(/points=\{scoreSeries\.points\}[\s\S]{0,80}scoreSeries\.spendDomain/);
  });

  it('never joins across a snapshot with no figure', () => {
    expect(page).toContain('connectNulls={false}');
    expect(page).toContain('datum[spec.dataKey] === null');
  });

  it('carries no legend paragraph — retired with the caption (the fluff rule, 2026-08-31)', () => {
    // The paragraph that stated the success target and the living-only scope
    // is gone, along with the successTarget state that existed only to feed
    // it. Per-point conditions live in the tooltip.
    expect(page).not.toContain('successTarget');
    expect(page).not.toContain('still clears its success');
    expect(page).not.toContain('Living expenses only');
  });

  it('says nothing at all rather than an empty plot before the first figure', () => {
    expect(page).toContain('scoreSeries.spendScored === 0');
    expect(page).toContain('spendChartEmptyNote()');
    // The note names which snapshots fill it — the ones taken from now on — and
    // no longer points at a button that filled it by measuring a different day.
    expect(spendChartEmptyNote()).toContain('Every score taken from now on solves for one');
    expect(spendChartEmptyNote()).toContain('cannot be given one now');
    expect(spendChartEmptyNote()).not.toMatch(/re-score/i);
  });

  it('keeps ONE copy of the pointer-following tooltip machinery', () => {
    // Two plots, one <TrendChart>. A second copy would be a second copy of the
    // positioning that took a day to get right, and the copy is the one that
    // silently stops being fixed. The card is still placed from the page's own
    // pointer state and an explicit position recharts cannot override.
    expect(page.match(/function TrendChart\(/g)).toHaveLength(1);
    expect(page.match(/function TrendTooltip\(/g)).toHaveLength(1);
    expect(page).toContain('position={cardAt}');
    expect(page).toContain('tooltipPosition(pointer, cardSize ?? TOOLTIP_CARD_ESTIMATE, plotSize)');
    expect(page).toContain('scoreAt(points, hovered)');
  });
});

/**
 * Success metrics over simulated paths (SPEC §4.5):
 * percentile fan (10/25/50/75/90), success rate, and the worst-decile
 * insolvency-year histogram. Pure functions; no IO, no randomness.
 */

import type { FanChart, GuardrailPathStats, GuardrailStats } from '../shared/types';

/**
 * Percentile of an ASCENDING-sorted array with linear interpolation.
 * `p` is a fraction in [0, 1] (0.1 = 10th percentile). Uses the standard
 * rank = p * (n - 1) definition (same as numpy's default "linear" method).
 */
export function percentileSorted(sorted: number[], p: number): number {
  if (sorted.length === 0) {
    throw new Error('percentileSorted: empty array');
  }
  if (p < 0 || p > 1) {
    throw new Error(`percentileSorted: p must be in [0, 1], got ${p}`);
  }
  const rank = p * (sorted.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return sorted[lo];
  const frac = rank - lo;
  return sorted[lo] + frac * (sorted[hi] - sorted[lo]);
}

/**
 * Build the percentile fan chart from per-path real balance series.
 * `realBalancesPerPath[path][yearIndex]` are end-of-year balances in real
 * (start-year) dollars; all paths must have equal length. Year labels start
 * at `startYear`.
 */
export function buildFan(realBalancesPerPath: number[][], startYear: number): FanChart {
  if (realBalancesPerPath.length === 0) {
    throw new Error('buildFan: no paths');
  }
  const horizon = realBalancesPerPath[0].length;
  for (const path of realBalancesPerPath) {
    if (path.length !== horizon) {
      throw new Error(
        `buildFan: ragged input — expected every path to have ${horizon} years, found ${path.length}`,
      );
    }
  }
  const fan: FanChart = { years: [], p10: [], p25: [], p50: [], p75: [], p90: [] };
  for (let y = 0; y < horizon; y++) {
    const values = realBalancesPerPath.map((path) => path[y]).sort((a, b) => a - b);
    fan.years.push(startYear + y);
    fan.p10.push(percentileSorted(values, 0.1));
    fan.p25.push(percentileSorted(values, 0.25));
    fan.p50.push(percentileSorted(values, 0.5));
    fan.p75.push(percentileSorted(values, 0.75));
    fan.p90.push(percentileSorted(values, 0.9));
  }
  return fan;
}

/**
 * Fraction of paths that succeed: never insolvent (insolvencyYears[i] === null)
 * AND terminal real balance >= the floor (floorReal undefined => floor of 0).
 */
export function successRate(
  insolvencyYears: Array<number | null>,
  terminalReal: number[],
  floorReal: number | undefined,
): number {
  const n = insolvencyYears.length;
  if (n === 0) {
    throw new Error('successRate: no paths');
  }
  if (terminalReal.length !== n) {
    throw new Error(
      `successRate: length mismatch — ${n} insolvency entries vs ${terminalReal.length} terminal values`,
    );
  }
  const floor = floorReal ?? 0;
  let successes = 0;
  for (let i = 0; i < n; i++) {
    if (insolvencyYears[i] === null && terminalReal[i] >= floor) successes++;
  }
  return successes / n;
}

/**
 * Reduce per-path guardrails records to the run-level statistics
 * (RunResult.guardrailStats). Pure, so the conditionality property can be
 * unit-tested on hand-built arrays instead of inferred from a Monte Carlo run.
 *
 * THE DEPTH AND DURATION MEDIANS ARE TAKEN OVER THE CUT PATHS ONLY. A
 * mostly-uncut run contributes its untouched paths (minFactor 1, yearsBelow 0)
 * to the FRACTIONS but never to the medians — folding them in would drag
 * "typically bottoms at 87% of plan" toward 100% exactly in proportion to how
 * rarely cuts happen, which is the opposite of what "how bad is it when it
 * happens" asks. No cut paths at all means the medians are null, not 1 and 0:
 * there is no cut future to describe.
 *
 * `floor` and `ceiling` are the band values the run enforced, passed through
 * verbatim so the UI can label "the 70% floor" / "capped at 100% of plan"
 * from the result alone.
 */
export function aggregateGuardrailStats(
  perPath: readonly GuardrailPathStats[],
  floor: number,
  ceiling: number | undefined,
): GuardrailStats {
  const n = perPath.length;
  if (n === 0) {
    throw new Error('aggregateGuardrailStats: no paths');
  }
  let cut = 0;
  let above = 0;
  let floored = 0;
  const minFactors: number[] = [];
  const yearsBelow: number[] = [];
  for (const p of perPath) {
    if (p.everCut) {
      cut++;
      minFactors.push(p.minFactor);
      yearsBelow.push(p.yearsBelow);
    }
    if (p.everAbovePlan) above++;
    if (p.floorTouched) floored++;
  }
  minFactors.sort((a, b) => a - b);
  yearsBelow.sort((a, b) => a - b);
  return {
    everCutFraction: cut / n,
    medianMinFactorAmongCut: cut > 0 ? percentileSorted(minFactors, 0.5) : null,
    medianYearsBelowAmongCut: cut > 0 ? percentileSorted(yearsBelow, 0.5) : null,
    everAbovePlanFraction: above / n,
    floorTouchedFraction: floored / n,
    floor,
    ...(ceiling !== undefined ? { ceiling } : {}),
  };
}

/**
 * Histogram of insolvency years within the worst decile of paths.
 * Paths are ranked ascending by terminal real value; the worst
 * max(1, floor(n/10)) paths are selected; of those, each path that went
 * insolvent contributes to the histogram keyed by its insolvency year
 * (as a string). Paths in the worst decile that never went insolvent are
 * simply not counted.
 */
export function worstDecileShortfallYears(
  insolvencyYears: Array<number | null>,
  terminalReal: number[],
): Record<string, number> {
  const n = insolvencyYears.length;
  if (n === 0) {
    throw new Error('worstDecileShortfallYears: no paths');
  }
  if (terminalReal.length !== n) {
    throw new Error(
      `worstDecileShortfallYears: length mismatch — ${n} insolvency entries vs ${terminalReal.length} terminal values`,
    );
  }
  // Stable sort of path indices by terminal value (ascending): ties keep
  // original path order, so results are deterministic.
  const order = terminalReal.map((_, i) => i).sort((a, b) => terminalReal[a] - terminalReal[b]);
  const decileCount = Math.max(1, Math.floor(n / 10));
  const histogram: Record<string, number> = {};
  for (let k = 0; k < decileCount; k++) {
    const year = insolvencyYears[order[k]];
    if (year !== null) {
      const key = String(year);
      histogram[key] = (histogram[key] ?? 0) + 1;
    }
  }
  return histogram;
}

import { describe, expect, it } from 'vitest';
import {
  aggregateGuardrailStats,
  buildFan,
  percentileSorted,
  successRate,
  worstDecileShortfallYears,
} from '../../src/engine/metrics';
import type { GuardrailPathStats } from '../../src/shared/types';

describe('percentileSorted', () => {
  const sorted = [10, 20, 30, 40];

  it('returns endpoints for p=0 and p=1', () => {
    expect(percentileSorted(sorted, 0)).toBe(10);
    expect(percentileSorted(sorted, 1)).toBe(40);
  });

  it('interpolates linearly between ranks', () => {
    // n=4 -> rank = p * 3
    // p=0.5: rank 1.5 -> 20 + 0.5*(30-20) = 25
    expect(percentileSorted(sorted, 0.5)).toBe(25);
    // p=0.25: rank 0.75 -> 10 + 0.75*(20-10) = 17.5
    expect(percentileSorted(sorted, 0.25)).toBe(17.5);
    // p=0.9: rank 2.7 -> 30 + 0.7*(40-30) = 37
    expect(percentileSorted(sorted, 0.9)).toBeCloseTo(37, 12);
    // p=0.1: rank 0.3 -> 10 + 0.3*10 = 13
    expect(percentileSorted(sorted, 0.1)).toBeCloseTo(13, 12);
  });

  it('handles a single-element array', () => {
    expect(percentileSorted([7], 0)).toBe(7);
    expect(percentileSorted([7], 0.5)).toBe(7);
    expect(percentileSorted([7], 1)).toBe(7);
  });

  it('lands exactly on elements at integer ranks', () => {
    // n=5 -> rank = p * 4; p=0.25 -> rank 1 -> element index 1
    expect(percentileSorted([1, 2, 3, 4, 5], 0.25)).toBe(2);
    expect(percentileSorted([1, 2, 3, 4, 5], 0.5)).toBe(3);
    expect(percentileSorted([1, 2, 3, 4, 5], 0.75)).toBe(4);
  });

  it('rejects empty input and out-of-range p', () => {
    expect(() => percentileSorted([], 0.5)).toThrow(/empty/);
    expect(() => percentileSorted([1], -0.1)).toThrow(/\[0, 1\]/);
    expect(() => percentileSorted([1], 1.1)).toThrow(/\[0, 1\]/);
  });
});

describe('buildFan', () => {
  it('computes per-year percentiles across paths (sorting each year independently)', () => {
    // 5 paths x 2 years. Year 1 is deliberately shuffled relative to year 0
    // so the test fails if buildFan forgets to sort per year.
    const paths = [
      [100, 200],
      [200, 0],
      [300, 150],
      [400, 50],
      [500, 100],
    ];
    const fan = buildFan(paths, 2026);
    expect(fan.years).toEqual([2026, 2027]);

    // Year 0 sorted: [100,200,300,400,500]; n=5 -> rank = p*4
    // p10: rank 0.4 -> 100 + 0.4*(200-100) = 140
    // p25: rank 1.0 -> 200
    // p50: rank 2.0 -> 300
    // p75: rank 3.0 -> 400
    // p90: rank 3.6 -> 400 + 0.6*(500-400) = 460
    expect(fan.p10[0]).toBeCloseTo(140, 12);
    expect(fan.p25[0]).toBe(200);
    expect(fan.p50[0]).toBe(300);
    expect(fan.p75[0]).toBe(400);
    expect(fan.p90[0]).toBeCloseTo(460, 12);

    // Year 1 sorted: [0,50,100,150,200]
    // p10: rank 0.4 -> 0 + 0.4*50 = 20
    // p25: 50 ; p50: 100 ; p75: 150
    // p90: rank 3.6 -> 150 + 0.6*50 = 180
    expect(fan.p10[1]).toBeCloseTo(20, 12);
    expect(fan.p25[1]).toBe(50);
    expect(fan.p50[1]).toBe(100);
    expect(fan.p75[1]).toBe(150);
    expect(fan.p90[1]).toBeCloseTo(180, 12);
  });

  it('with a single path the fan collapses to that path', () => {
    const fan = buildFan([[100, 90, 80]], 2030);
    expect(fan.years).toEqual([2030, 2031, 2032]);
    expect(fan.p10).toEqual([100, 90, 80]);
    expect(fan.p50).toEqual([100, 90, 80]);
    expect(fan.p90).toEqual([100, 90, 80]);
  });

  it('rejects empty and ragged input', () => {
    expect(() => buildFan([], 2026)).toThrow(/no paths/);
    expect(() => buildFan([[1, 2], [1]], 2026)).toThrow(/ragged/);
  });
});

describe('successRate', () => {
  it('success = never insolvent AND terminal >= floor', () => {
    const insolvency = [null, 2030, null, null];
    const terminal = [500, 0, 50, 100];
    // floor=100: path0 (null, 500>=100) ok; path1 insolvent; path2 50<100 fails;
    // path3 (null, 100>=100) ok -> 2/4 = 0.5
    expect(successRate(insolvency, terminal, 100)).toBe(0.5);
  });

  it('floor undefined means floor of 0', () => {
    const insolvency = [null, 2030, null, null];
    const terminal = [500, 0, 50, 100];
    // floor=0: paths 0,2,3 succeed (never insolvent, terminal >= 0) -> 3/4
    expect(successRate(insolvency, terminal, undefined)).toBe(0.75);
  });

  it('handles all-success and all-fail', () => {
    expect(successRate([null, null], [10, 20], undefined)).toBe(1);
    expect(successRate([2030, 2040], [0, 0], undefined)).toBe(0);
  });

  it('terminal exactly at the floor counts as success', () => {
    expect(successRate([null], [250000], 250000)).toBe(1);
    expect(successRate([null], [249999.99], 250000)).toBe(0);
  });

  it('rejects empty and mismatched input', () => {
    expect(() => successRate([], [], undefined)).toThrow(/no paths/);
    expect(() => successRate([null], [1, 2], undefined)).toThrow(/mismatch/);
  });
});

describe('worstDecileShortfallYears', () => {
  it('histograms insolvency years over the worst 10% of paths by terminal value', () => {
    // 30 paths -> worst decile = floor(30/10) = 3 paths.
    // Terminals: path0=0 (insolvent 2040), path1=0.5 (insolvent 2043),
    // path2=0.2 (insolvent 2040); all others 1000+ and never insolvent.
    // Ascending by terminal: path0 (0), path2 (0.2), path1 (0.5) -> exactly
    // the three insolvents -> {'2040': 2, '2043': 1}
    const n = 30;
    const insolvency: Array<number | null> = Array.from({ length: n }, () => null);
    const terminal: number[] = Array.from({ length: n }, (_, i) => 1000 + i);
    insolvency[0] = 2040;
    terminal[0] = 0;
    insolvency[1] = 2043;
    terminal[1] = 0.5;
    insolvency[2] = 2040;
    terminal[2] = 0.2;
    expect(worstDecileShortfallYears(insolvency, terminal)).toEqual({ '2040': 2, '2043': 1 });
  });

  it('takes at least 1 path when n < 10', () => {
    // 5 paths -> max(1, floor(5/10)) = 1: only the single worst path counts.
    // Worst by terminal is path2 (terminal 0, insolvent 2035).
    expect(
      worstDecileShortfallYears([null, null, 2035, null, 2050], [900, 800, 0, 700, 600]),
    ).toEqual({ '2035': 1 });
  });

  it('worst path that never went insolvent contributes nothing', () => {
    // 3 paths -> worst decile = 1 path: path1 (terminal 10) never insolvent -> {}
    expect(worstDecileShortfallYears([null, null, null], [500, 10, 900])).toEqual({});
  });

  it('excludes insolvent paths outside the worst decile', () => {
    // 10 paths -> worst decile = 1 path. path0 terminal 0 insolvent 2038 is
    // the worst; path5 also insolvent (2044) but terminal 5 ranks second, so
    // it is NOT in the histogram.
    const insolvency: Array<number | null> = [2038, null, null, null, null, 2044, null, null, null, null];
    const terminal = [0, 100, 200, 300, 400, 5, 500, 600, 700, 800];
    expect(worstDecileShortfallYears(insolvency, terminal)).toEqual({ '2038': 1 });
  });

  it('rejects empty and mismatched input', () => {
    expect(() => worstDecileShortfallYears([], [])).toThrow(/no paths/);
    expect(() => worstDecileShortfallYears([null], [1, 2])).toThrow(/mismatch/);
  });
});

describe('aggregateGuardrailStats', () => {
  /** An untouched path: never cut, never raised, never floored. */
  const quiet = (): GuardrailPathStats => ({
    everCut: false,
    minFactor: 1,
    yearsBelow: 0,
    everAbovePlan: false,
    floorTouched: false,
  });

  it('takes the depth and duration medians over the CUT paths only', () => {
    /*
     * THE DILUTION TRAP THIS FUNCTION EXISTS TO AVOID. Three cut paths among
     * ten: minFactors 0.9 / 0.81 / 0.7, yearsBelow 2 / 5 / 9. The medians must
     * be 0.81 and 5 — the middle CUT path. Folding in the seven quiet paths
     * (minFactor 1, yearsBelow 0) would report 1 and 0, i.e. "a typical cut
     * bottoms at 100% of plan for 0 years", which describes no future at all.
     */
    const perPath = [
      { everCut: true, minFactor: 0.9, yearsBelow: 2, everAbovePlan: false, floorTouched: false },
      { everCut: true, minFactor: 0.81, yearsBelow: 5, everAbovePlan: false, floorTouched: false },
      { everCut: true, minFactor: 0.7, yearsBelow: 9, everAbovePlan: false, floorTouched: true },
      ...Array.from({ length: 7 }, quiet),
    ];
    const agg = aggregateGuardrailStats(perPath, 0.7, undefined);
    expect(agg.everCutFraction).toBeCloseTo(0.3, 12);
    expect(agg.medianMinFactorAmongCut).toBeCloseTo(0.81, 12);
    expect(agg.medianYearsBelowAmongCut).toBe(5);
    expect(agg.floorTouchedFraction).toBeCloseTo(0.1, 12);
    expect(agg.everAbovePlanFraction).toBe(0);
    expect(agg.floor).toBe(0.7);
    // No ceiling handed in -> the key is ABSENT, not undefined-valued: the
    // stats round-trip through the run cache's JSON, and an explicit
    // undefined would not survive it.
    expect('ceiling' in agg).toBe(false);
  });

  it('reports null medians when no path ever cut — not 1 and 0', () => {
    const perPath = [
      quiet(),
      { everCut: false, minFactor: 1, yearsBelow: 0, everAbovePlan: true, floorTouched: false },
    ];
    const agg = aggregateGuardrailStats(perPath, 0.7, 1);
    expect(agg.everCutFraction).toBe(0);
    // Null, deliberately: "the typical cut future" does not exist here, and a
    // fabricated depth of 1 would render as "typically bottoms at 100% of
    // plan" — a statement about futures that never happened.
    expect(agg.medianMinFactorAmongCut).toBeNull();
    expect(agg.medianYearsBelowAmongCut).toBeNull();
    expect(agg.everAbovePlanFraction).toBe(0.5);
    expect(agg.ceiling).toBe(1);
  });

  it('interpolates an even count of cut paths like every other median here', () => {
    const perPath = [
      { everCut: true, minFactor: 0.9, yearsBelow: 2, everAbovePlan: false, floorTouched: false },
      { everCut: true, minFactor: 0.7, yearsBelow: 5, everAbovePlan: false, floorTouched: false },
    ];
    const agg = aggregateGuardrailStats(perPath, 0.7, undefined);
    expect(agg.medianMinFactorAmongCut).toBeCloseTo(0.8, 12);
    expect(agg.medianYearsBelowAmongCut).toBeCloseTo(3.5, 12);
  });

  it('rejects an empty path list — the caller gates on the policy, not this function', () => {
    expect(() => aggregateGuardrailStats([], 0.7, undefined)).toThrow(/no paths/);
  });
});

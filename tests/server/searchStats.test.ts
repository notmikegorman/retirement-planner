/**
 * The statistics that decide whether a difference is real.
 *
 * This is the file that stands between the user and a report that crowns the
 * random number generator. Three properties are pinned here, and each one has a
 * specific lie it prevents:
 *
 *   PAIRING IS MANDATORY, NOT PREFERRED. pairedDelta refuses inputs of unequal
 *   length, because the seed-by-seed alignment IS the method: unaligned arrays
 *   would silently produce a difference of levels dressed up as a paired one.
 *
 *   "EQUIVALENT" AND "INCONCLUSIVE" ARE DIFFERENT FINDINGS. "These are the same
 *   plan" and "we did not measure this well enough" must never share wording.
 *   Collapsing them into "no difference" is the single most misleading thing
 *   this report could say, so the verdicts, and the sentences, are tested apart.
 *
 *   ONE OBSERVATION LICENSES NO INTERVAL. At n = 1 there is no error bar, and
 *   the code must decline to invent one rather than print +/- 0.
 */
import { describe, expect, it } from 'vitest';
import {
  holmAdjust,
  incompleteBeta,
  linearSlope,
  normalQuantile,
  pairedDelta,
  seedStat,
  stdev,
  tCritical,
  tTestP,
  winnersCurseBias,
} from '../../src/server/search/stats';

const pp = (v: number): string => `${(Math.abs(v) * 100).toFixed(2)}pp`;

/** Standard options: a half-point practical floor, in success units. */
function opts(overrides: Partial<Parameters<typeof pairedDelta>[2]> = {}) {
  return { practicalFloor: 0.005, format: pp, ...overrides };
}

// ---------------------------------------------------------------------------
// Student's t, from scratch
// ---------------------------------------------------------------------------

describe("Student's t", () => {
  it('reproduces the textbook two-sided critical values', () => {
    // t(0.975, df) from any table: 12.706, 2.262, 2.093, 2.045, 1.984.
    expect(tCritical(0.05, 1)).toBeCloseTo(12.706, 2);
    expect(tCritical(0.05, 9)).toBeCloseTo(2.262, 2);
    expect(tCritical(0.05, 19)).toBeCloseTo(2.093, 2);
    expect(tCritical(0.05, 29)).toBeCloseTo(2.045, 2);
    expect(tCritical(0.05, 100)).toBeCloseTo(1.984, 2);
    // Holm hands it a tighter alpha, so that path has to be right too.
    expect(tCritical(0.01, 19)).toBeCloseTo(2.861, 2);
  });

  it('inverts: the p-value at the critical value is the alpha it came from', () => {
    for (const df of [1, 5, 19, 40]) {
      for (const alpha of [0.05, 0.01, 0.2]) {
        expect(tTestP(tCritical(alpha, df), df)).toBeCloseTo(alpha, 6);
      }
    }
  });

  it('is symmetric, monotone, and degenerates safely', () => {
    expect(tTestP(2.5, 19)).toBeCloseTo(tTestP(-2.5, 19), 12);
    expect(tTestP(0, 19)).toBeCloseTo(1, 10);
    expect(tTestP(3, 19)).toBeLessThan(tTestP(2, 19));
    expect(tTestP(Number.POSITIVE_INFINITY, 19)).toBe(0);
    // n = 1 means df = 0: no test is possible and the honest answer is p = 1.
    expect(tTestP(5, 0)).toBe(1);
    expect(tCritical(0.05, 0)).toBe(Number.POSITIVE_INFINITY);
  });

  it('has a regularized incomplete beta with the right endpoints and symmetry', () => {
    expect(incompleteBeta(2, 3, 0)).toBe(0);
    expect(incompleteBeta(2, 3, 1)).toBe(1);
    expect(incompleteBeta(3, 3, 0.5)).toBeCloseTo(0.5, 10);
    expect(incompleteBeta(2, 5, 0.4)).toBeCloseTo(1 - incompleteBeta(5, 2, 0.6), 10);
  });

  it('inverts the normal CDF to known quantiles', () => {
    expect(normalQuantile(0.5)).toBeCloseTo(0, 8);
    expect(normalQuantile(0.975)).toBeCloseTo(1.959964, 5);
    expect(normalQuantile(0.025)).toBeCloseTo(-1.959964, 5);
    expect(normalQuantile(0.999)).toBeCloseTo(3.090232, 4);
  });
});

// ---------------------------------------------------------------------------
// Summaries
// ---------------------------------------------------------------------------

describe('seedStat', () => {
  it('summarises several seeds with the interval they earned', () => {
    const s = seedStat([0.9, 0.92, 0.88, 0.91]);
    expect(s.n).toBe(4);
    expect(s.mean).toBeCloseTo(0.9025, 10);
    expect(s.sd).toBeCloseTo(stdev([0.9, 0.92, 0.88, 0.91]), 12);
    expect(s.se).toBeCloseTo(s.sd / 2, 12);
    expect(s.min).toBe(0.88);
    expect(s.max).toBe(0.92);
    const half = tCritical(0.05, 3) * s.se;
    expect(s.ci95[0]).toBeCloseTo(s.mean - half, 12);
    expect(s.ci95[1]).toBeCloseTo(s.mean + half, 12);
    expect(s.values).toEqual([0.9, 0.92, 0.88, 0.91]);
  });

  it('declines to invent an interval from one observation', () => {
    const s = seedStat([0.9]);
    expect(s.n).toBe(1);
    expect(s.sd).toBe(0);
    // [mean, mean] is the signal to callers that there is no bar to draw; a
    // "+/- 0" would read as infinite precision on the least precise row shown.
    expect(s.ci95).toEqual([0.9, 0.9]);
  });

  it('keeps the per-seed values so a comparison can be re-paired later', () => {
    expect(seedStat([1, 2, 3]).values).toEqual([1, 2, 3]);
  });
});

// ---------------------------------------------------------------------------
// Paired comparison
// ---------------------------------------------------------------------------

describe('pairedDelta', () => {
  it('refuses unaligned inputs rather than silently comparing levels', () => {
    expect(() => pairedDelta([1, 2, 3], [1, 2], opts())).toThrow(/unpaired/i);
    expect(() => pairedDelta([1, 2], [1, 2, 3], opts())).toThrow(/same seeds/i);
  });

  it('is the mean of the per-seed differences, not the difference of the means', () => {
    // Same means either way, but only the paired route knows the spread of the
    // DIFFERENCES, which is the quantity every verdict is made from.
    const cand = [0.90, 0.80, 0.70];
    const base = [0.88, 0.78, 0.68];
    const d = pairedDelta(cand, base, opts());
    expect(d.mean).toBeCloseTo(0.02, 12);
    expect(d.sd).toBeCloseTo(0, 12);
    expect(d.n).toBe(3);
    expect(d.winsOn).toBe(3);
  });

  it('is dramatically tighter than a difference of levels under common seeds', () => {
    // The engine's market draw depends on (rows, horizon, paths, block years,
    // seed, expense ratios) and nothing scenario-dependent, so two plans at one
    // seed face bit-identical futures. Synthesised here: a large common per-seed
    // offset plus a small, steady, real effect.
    const seedLuck = [0.10, -0.08, 0.05, -0.11, 0.07, -0.03];
    const base = seedLuck.map((l) => 0.70 + l);
    const cand = seedLuck.map((l) => 0.72 + l);

    const paired = pairedDelta(cand, base, opts());
    // The levels wobble by 8 points; the paired difference does not wobble at all.
    expect(stdev(base)).toBeGreaterThan(0.07);
    expect(paired.sd).toBeLessThan(1e-12);
    expect(paired.mean).toBeCloseTo(0.02, 12);
    expect(paired.verdict).toBe('better');

    // The unpaired route, for contrast: the same 2pp effect is invisible inside
    // the seed luck. This is why the report never ranks raw levels.
    const unpairedSe = Math.sqrt(stdev(cand) ** 2 / cand.length + stdev(base) ** 2 / base.length);
    expect(unpairedSe).toBeGreaterThan(paired.se * 100);
  });

  it('calls a difference real only when the whole interval clears the floor', () => {
    const base = [0.70, 0.71, 0.69, 0.70, 0.71, 0.69];
    const better = base.map((v) => v + 0.03);
    const d = pairedDelta(better, base, opts());
    expect(d.verdict).toBe('better');
    expect(d.ci95[0]).toBeGreaterThan(0.005);
    expect(d.note).toMatch(/Real/);
    expect(d.p).toBeLessThan(0.001);
    expect(d.winsOn).toBe(6);
  });

  it('renders a loss with a minus sign, because the formatter prints magnitudes', () => {
    const base = [0.70, 0.71, 0.69, 0.70];
    const worse = base.map((v) => v - 0.03);
    const d = pairedDelta(worse, base, opts());
    expect(d.verdict).toBe('worse');
    expect(d.mean).toBeLessThan(0);
    // A magnitude formatter plus a missing sign printed -0.67pp as "+0.67pp".
    expect(d.note.startsWith('-')).toBe(true);
    expect(d.note).not.toMatch(/^\+/);
    expect(d.note).toMatch(/wrong direction/i);
  });

  it('distinguishes "the same plan" from "not measured well enough"', () => {
    const base = [0.700, 0.701, 0.699, 0.700, 0.701, 0.699];

    // Tiny, precise difference: the whole interval sits inside +/- the floor.
    const twin = base.map((v) => v + 0.0005);
    const equivalent = pairedDelta(twin, base, opts());
    expect(equivalent.verdict).toBe('equivalent');
    expect(equivalent.ci95[0]).toBeGreaterThanOrEqual(-0.005);
    expect(equivalent.ci95[1]).toBeLessThanOrEqual(0.005);
    expect(equivalent.note).toMatch(/same plan/);
    expect(equivalent.note).not.toMatch(/INCONCLUSIVE/);

    // Same point estimate, hopeless precision: the interval straddles zero AND
    // is wider than the floor. A completely different message.
    const noisy = [0.75, 0.62, 0.78, 0.60, 0.74, 0.66];
    const inconclusive = pairedDelta(noisy, base, opts());
    expect(inconclusive.verdict).toBe('inconclusive');
    expect(inconclusive.note).toMatch(/INCONCLUSIVE/);
    expect(inconclusive.note).toMatch(/More seeds would settle it/);
    expect(inconclusive.note).not.toMatch(/same plan/);

    // And the two sentences are genuinely different text, not one template.
    expect(equivalent.note).not.toBe(inconclusive.note);
  });

  it('reports n = 1 as inconclusive with no interval at all', () => {
    const d = pairedDelta([0.9], [0.7], opts());
    // A 20-point difference on one seed is still not a finding.
    expect(d.verdict).toBe('inconclusive');
    expect(d.n).toBe(1);
    expect(d.p).toBe(1);
    expect(d.ci95[0]).toBeCloseTo(0.2, 12);
    expect(d.ci95[1]).toBeCloseTo(0.2, 12);
    expect(d.ci95[0]).toBe(d.ci95[1]);
    // No error band after the point estimate: the only "±" in the sentence is
    // the practical floor it is being judged against.
    expect(d.note).toMatch(/^\+20\.00pp \(1 seeds?\)\./);
    expect(d.note).not.toMatch(/95% CI/);
  });

  it('flags a slope-converted figure as rankable but not quotable', () => {
    const d = pairedDelta([0.72, 0.73], [0.70, 0.71], opts({ approximate: true }));
    expect(d.approximate).toBe(true);
    expect(d.note).toMatch(/good enough to rank, not to quote/);
    const direct = pairedDelta([0.72, 0.73], [0.70, 0.71], opts());
    expect(direct.approximate).toBeUndefined();
    expect(direct.note).not.toMatch(/rank, not to quote/);
  });

  it('carries the seed provenance and the sign-test count into the note', () => {
    const d = pairedDelta([0.72, 0.73, 0.68], [0.70, 0.71, 0.71], opts({ seedsLabel: '20 held-out seeds' }));
    expect(d.note).toContain('20 held-out seeds');
    expect(d.note).toContain('beat the baseline on 2 of 3');
    expect(d.winsOn).toBe(2);
  });

  it('honours a tighter alpha by widening the interval', () => {
    const cand = [0.72, 0.74, 0.71, 0.73];
    const base = [0.70, 0.71, 0.70, 0.70];
    const wide = pairedDelta(cand, base, opts({ alpha: 0.001 }));
    const normal = pairedDelta(cand, base, opts());
    expect(wide.ci95[1] - wide.ci95[0]).toBeGreaterThan(normal.ci95[1] - normal.ci95[0]);
    expect(wide.mean).toBeCloseTo(normal.mean, 12);
  });

  it('treats a floor given with the wrong sign as a magnitude', () => {
    const base = [0.70, 0.70, 0.70, 0.70];
    const d = pairedDelta(base.map((v) => v + 0.001), base, opts({ practicalFloor: -0.005 }));
    expect(d.verdict).toBe('equivalent');
  });
});

// ---------------------------------------------------------------------------
// Multiplicity
// ---------------------------------------------------------------------------

describe('holmAdjust', () => {
  it('demotes a lone-test winner once it is one of ten comparisons', () => {
    const base = [0.70, 0.71, 0.69, 0.70, 0.71, 0.69];
    // A real but marginal effect: p = 0.008, comfortably significant on its own.
    const lifts = [0.036, 0.006, 0.031, 0.011, 0.028, 0.014];
    const marginal = pairedDelta(base.map((v, i) => v + lifts[i]), base, opts());
    expect(marginal.verdict).toBe('better');
    expect(marginal.p).toBeLessThan(0.01);

    // Nine null comparisons alongside it — the six finalists and their rivals a
    // real report tests at once.
    const nulls = [0.002, -0.002, 0.001, -0.001, 0.0015, -0.0015];
    const family = [
      marginal,
      ...Array.from({ length: 9 }, () =>
        pairedDelta(base.map((v, i) => v + nulls[i]), base, opts()),
      ),
    ];
    holmAdjust(family);

    // Ranking six finalists and reporting the best-looking one as significant
    // at 0.05 runs six tests and pays for none of them.
    expect(family[0].pAdjusted).toBeCloseTo(marginal.p * 10, 12);
    expect(family[0].pAdjusted).toBeGreaterThan(0.05);
    expect(family[0].verdict).toBe('inconclusive');
    expect(family[0].note).toMatch(/Holm correction across 10 comparisons/);
    expect(family[0].note).toMatch(/each one needs a higher bar/);
  });

  it('never demotes an equivalence finding, which needs no significance test', () => {
    const base = [0.700, 0.701, 0.699, 0.700, 0.701, 0.699];
    const twins = Array.from({ length: 8 }, () =>
      pairedDelta(base.map((v) => v + 0.0002), base, opts()),
    );
    expect(twins.every((d) => d.verdict === 'equivalent')).toBe(true);
    holmAdjust(twins);
    // "These are the same plan" survives multiplicity: it is a statement about
    // the interval, not about beating a null.
    expect(twins.every((d) => d.verdict === 'equivalent')).toBe(true);
  });

  it('is monotone in rank and never reports an adjusted p below the raw one', () => {
    const base = [0.70, 0.71, 0.69, 0.70, 0.71, 0.69, 0.70, 0.71];
    const deltas = [0.03, 0.02, 0.012, 0.006, 0.001, 0.0002].map((lift, k) =>
      pairedDelta(
        base.map((v, i) => v + lift + (i % 3 === 0 ? 0.002 : -0.001) * (k + 1)),
        base,
        opts(),
      ),
    );
    holmAdjust(deltas);
    const bySignificance = [...deltas].sort((a, b) => a.p - b.p);
    let previous = 0;
    for (const d of bySignificance) {
      expect(d.pAdjusted).toBeGreaterThanOrEqual(previous - 1e-12);
      expect(d.pAdjusted).toBeGreaterThanOrEqual(d.p - 1e-12);
      previous = d.pAdjusted as number;
    }
    expect(bySignificance[bySignificance.length - 1].pAdjusted).toBeLessThanOrEqual(1);
  });

  it('leaves a single comparison alone', () => {
    const base = [0.70, 0.71, 0.69, 0.70];
    const only = [pairedDelta(base.map((v) => v + 0.03), base, opts())];
    holmAdjust(only);
    expect(only[0].pAdjusted).toBeCloseTo(only[0].p, 12);
    expect(only[0].verdict).toBe('better');
  });
});

// ---------------------------------------------------------------------------
// The winner's curse — the number that justifies two disjoint seed sets
// ---------------------------------------------------------------------------

describe('winnersCurseBias', () => {
  it('is zero for one candidate and grows with the size of the field', () => {
    expect(winnersCurseBias(1, 0.02)).toBe(0);
    expect(winnersCurseBias(0, 0.02)).toBe(0);
    const k64 = winnersCurseBias(64, 0.02);
    const k1024 = winnersCurseBias(1024, 0.02);
    expect(k64).toBeGreaterThan(0);
    expect(k1024).toBeGreaterThan(k64);
  });

  it('reproduces the measured figure that sizes this whole design', () => {
    // 1,024 truly-tied candidates at the measured 1-seed noise of 2.00pp are
    // expected to hand the maximum +6.5pp of pure luck — larger than any real
    // effect in this space, and the reason the report stage exists.
    expect(winnersCurseBias(1024, 0.02) * 100).toBeCloseTo(6.5, 1);
    // Scales linearly in the noise: halve the noise, halve the curse.
    expect(winnersCurseBias(1024, 0.01)).toBeCloseTo(winnersCurseBias(1024, 0.02) / 2, 12);
  });
});

describe('linearSlope', () => {
  it('recovers the slope of a straight line and ignores the intercept', () => {
    const xs = [72000, 82800, 93600];
    const ys = xs.map((x) => 1.4 - 1e-5 * x);
    expect(linearSlope(xs, ys)).toBeCloseTo(-1e-5, 12);
  });

  it('returns zero rather than NaN when there is nothing to fit', () => {
    expect(linearSlope([1], [1])).toBe(0);
    expect(linearSlope([5, 5, 5], [1, 2, 3])).toBe(0);
  });
});

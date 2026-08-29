/**
 * The statistics that decide whether a difference is real.
 *
 * Everything here is built around ONE property of the engine, which is worth
 * stating before any of the formulas: engine/returns.ts's bootstrapPaths()
 * draws market futures from (historical rows, horizon, path count, block years,
 * seed, expense ratios) and NOTHING scenario-dependent. Two candidate plans
 * evaluated at the same seed therefore face bit-identical market futures. A
 * paired difference is not merely a variance-reduction trick here — market luck
 * is literally held constant, and the difference is attributable to the
 * decision.
 *
 * Measured variance-reduction factors on this household (12 seeds, 4,000 paths,
 * sd of an unpaired difference over sd of the paired one):
 *
 *   retire 2029 vs 2027   +29.26pp   1.3x
 *   80/20 vs 60/40         +8.60pp   1.7x
 *   claim 70 vs 67         -2.17pp   3.4x
 *   spend -$5,000/yr       +7.42pp   2.6x
 *   spend -$1,000/yr       +1.42pp   6.4x
 *
 * The pattern is not an accident: with common random numbers the delta's
 * variance is governed by the fraction of paths on which the two plans actually
 * DISAGREE, so pairing helps most exactly where it is needed — separating two
 * plans that look the same. Ranking raw levels throws away a 3-6x multiplier.
 *
 * The pairing breaks if a comparison changes the horizon, the bootstrap block
 * length, expense ratios, or the path count, because each of those changes the
 * draw itself. None of them is a search axis.
 */
import type { DeltaVerdict, PairedDelta, SeedStat } from '../../shared/types';
/*
 * Why not Math.log/Math.exp: the ES spec lets engines approximate them, and
 * node's V8 and Chromium's V8 disagree by 1 ULP on some inputs — which forked
 * a search report between the two backends at a single ci95 digit (caught by
 * the dual-stack byte gate). Every OTHER operation in this module is IEEE-
 * correctly-rounded and engine-identical; these two come from the vendored
 * fdlibm port (./ieee754.ts) so the whole module is bit-deterministic.
 */
import { exp, log } from './ieee754';

// ---------------------------------------------------------------------------
// Student's t, from scratch
// ---------------------------------------------------------------------------

/** Lanczos log-gamma, standard coefficients. */
function logGamma(x: number): number {
  const g = [
    76.18009172947146, -86.50532032941677, 24.01409824083091, -1.231739572450155,
    0.1208650973866179e-2, -0.5395239384953e-5,
  ];
  let y = x;
  let tmp = x + 5.5;
  tmp -= (x + 0.5) * log(tmp);
  let ser = 1.000000000190015;
  for (const c of g) ser += c / ++y;
  return -tmp + log((2.5066282746310005 * ser) / x);
}

/** Continued fraction for the incomplete beta (Numerical Recipes betacf). */
function betaContinuedFraction(a: number, b: number, x: number): number {
  const MAXIT = 200;
  const EPS = 3e-14;
  const FPMIN = 1e-300;
  const qab = a + b;
  const qap = a + 1;
  const qam = a - 1;
  let c = 1;
  let d = 1 - (qab * x) / qap;
  if (Math.abs(d) < FPMIN) d = FPMIN;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= MAXIT; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    h *= d * c;
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < EPS) break;
  }
  return h;
}

/** Regularized incomplete beta I_x(a, b). */
export function incompleteBeta(a: number, b: number, x: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const front = exp(
    logGamma(a + b) - logGamma(a) - logGamma(b) + a * log(x) + b * log(1 - x),
  );
  return x < (a + 1) / (a + b + 2)
    ? (front * betaContinuedFraction(a, b, x)) / a
    : 1 - (front * betaContinuedFraction(b, a, 1 - x)) / b;
}

/**
 * Two-sided p-value for a t statistic with `df` degrees of freedom:
 * P(|T| >= |t|) = I_{df/(df+t^2)}(df/2, 1/2).
 */
export function tTestP(t: number, df: number): number {
  if (df <= 0) return 1;
  if (!Number.isFinite(t)) return 0;
  const x = df / (df + t * t);
  return incompleteBeta(df / 2, 0.5, x);
}

/**
 * Two-sided critical value t*(1 - alpha/2, df), by bisection on the p-value.
 *
 * Bisection rather than a table because the search's df moves with the seed
 * budget and with Holm's per-comparison alpha, and a wrong-by-a-table interval
 * is exactly the kind of quiet over-confidence this feature must not ship.
 */
export function tCritical(alpha: number, df: number): number {
  if (df <= 0) return Number.POSITIVE_INFINITY;
  let lo = 0;
  let hi = 1000;
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    if (tTestP(mid, df) > alpha) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

// ---------------------------------------------------------------------------
// Summaries
// ---------------------------------------------------------------------------

export function mean(values: readonly number[]): number {
  if (values.length === 0) return Number.NaN;
  let s = 0;
  for (const v of values) s += v;
  return s / values.length;
}

/** Sample standard deviation (n-1). 0 for n < 2 — one observation has no spread. */
export function stdev(values: readonly number[]): number {
  const n = values.length;
  if (n < 2) return 0;
  const m = mean(values);
  let s = 0;
  for (const v of values) s += (v - m) * (v - m);
  return Math.sqrt(s / (n - 1));
}

/**
 * A metric across seeds, with the interval it actually earned.
 *
 * At n = 1 the interval is [mean, mean]: not because the estimate is exact, but
 * because a single observation licenses NO interval at all, and inventing one
 * would be the lie. Callers show such rows as screening estimates.
 */
export function seedStat(values: readonly number[]): SeedStat {
  const n = values.length;
  const m = mean(values);
  const sd = stdev(values);
  const se = n > 0 ? sd / Math.sqrt(n) : 0;
  const half = n > 1 ? tCritical(0.05, n - 1) * se : 0;
  return {
    mean: m,
    sd,
    se,
    n,
    min: n > 0 ? Math.min(...values) : Number.NaN,
    max: n > 0 ? Math.max(...values) : Number.NaN,
    ci95: [m - half, m + half],
    values: [...values],
  };
}

// ---------------------------------------------------------------------------
// Paired comparison
// ---------------------------------------------------------------------------

export interface PairedOptions {
  /**
   * The difference below which two plans are called the same plan, in the
   * metric's own units. Statistical significance is cheap when seeds can be
   * bought; this is the bar that means "worth rearranging your life over".
   */
  practicalFloor: number;
  /** Renders a value with its unit, for the note. */
  format: (v: number) => string;
  /** Alpha for the reported interval. Default 0.05; Holm passes a tighter one. */
  alpha?: number;
  /** Marks a slope-converted (ranking-grade) figure. */
  approximate?: boolean;
  /** Where the numbers came from, for the note: "20 held-out seeds". */
  seedsLabel?: string;
}

/**
 * Paired difference of `candidate` against `baseline`, seed by seed.
 *
 * The two arrays MUST be aligned on the same seeds in the same order — that
 * alignment is the whole method, and a mismatch would silently produce a
 * difference of levels dressed up as a paired one.
 */
export function pairedDelta(
  candidate: readonly number[],
  baseline: readonly number[],
  opts: PairedOptions,
): PairedDelta {
  if (candidate.length !== baseline.length) {
    throw new Error(
      `pairedDelta: unpaired inputs (${candidate.length} vs ${baseline.length}) — ` +
        'both sides must be scored on the same seeds, in the same order',
    );
  }
  const diffs = candidate.map((v, i) => v - baseline[i]);
  const n = diffs.length;
  const m = mean(diffs);
  const sd = stdev(diffs);
  const se = n > 0 ? sd / Math.sqrt(n) : 0;
  const alpha = opts.alpha ?? 0.05;
  const half = n > 1 ? tCritical(alpha, n - 1) * se : 0;
  const ci95: [number, number] = [m - half, m + half];
  const t = se > 0 ? m / se : m === 0 ? 0 : Number.POSITIVE_INFINITY * Math.sign(m);
  const p = n > 1 ? tTestP(t, n - 1) : 1;
  const winsOn = diffs.filter((d) => d > 0).length;

  const floor = Math.abs(opts.practicalFloor);
  let verdict: DeltaVerdict;
  if (n < 2) verdict = 'inconclusive';
  else if (ci95[0] > floor) verdict = 'better';
  else if (ci95[1] < -floor) verdict = 'worse';
  else if (ci95[0] >= -floor && ci95[1] <= floor) verdict = 'equivalent';
  else verdict = 'inconclusive';

  return {
    mean: m,
    sd,
    se,
    n,
    ci95,
    p,
    winsOn,
    verdict,
    note: deltaNote(m, half, n, winsOn, verdict, floor, opts),
    ...(opts.approximate ? { approximate: true } : {}),
  };
}

/**
 * The row in words. Four different sentences for four different findings —
 * collapsing "equivalent" and "inconclusive" into "no difference" is the single
 * most misleading thing this report could do, so they never share wording.
 */
function deltaNote(
  m: number,
  half: number,
  n: number,
  winsOn: number,
  verdict: DeltaVerdict,
  floor: number,
  opts: PairedOptions,
): string {
  const f = opts.format;
  const seeds = opts.seedsLabel ?? `${n} seeds`;
  // The sign is written explicitly because `format` renders a MAGNITUDE (it has
  // to: "-$820/yr" needs the minus outside the currency formatting). Leaving it
  // off for negatives printed a loss as though it were a gain.
  const sign = m >= 0 ? '+' : '-';
  const point = `${sign}${f(m)}`;
  const band = n > 1 ? ` ± ${f(half)}` : '';
  const provenance = n > 1 ? ` (95% CI, ${seeds}; beat the baseline on ${winsOn} of ${n})` : ` (${seeds})`;
  const approx = opts.approximate
    ? ' Converted from success at the screening spend using the measured local slope — ' +
      'good enough to rank, not to quote.'
    : '';

  switch (verdict) {
    case 'better':
      return `${point}${band}${provenance}. Real: the whole interval clears the ${f(floor)} floor.${approx}`;
    case 'worse':
      return `${point}${band}${provenance}. Real, and in the wrong direction.${approx}`;
    case 'equivalent':
      return (
        `${point}${band}${provenance}. Equivalent within ± ${f(floor)} — this is not "we could not ` +
        `tell", it is "these are the same plan". Choose on other grounds.${approx}`
      );
    case 'inconclusive':
      return (
        `${point}${band}${provenance}. INCONCLUSIVE: the interval straddles zero and is wider than ` +
        `the ± ${f(floor)} floor, so this was not measured well enough to call either way. ` +
        `More seeds would settle it.${approx}`
      );
  }
}

// ---------------------------------------------------------------------------
// Multiplicity
// ---------------------------------------------------------------------------

/**
 * Holm-Bonferroni across a family of comparisons, in place on `pAdjusted`.
 *
 * Holm rather than plain Bonferroni: no independence assumption (the finalists
 * are anything but independent — they share seeds by construction) and
 * uniformly more powerful. Rows whose adjusted p no longer clears alpha are
 * demoted out of 'better'/'worse', because a ranking of six finalists that
 * reports the best-looking one as significant at 0.05 has run six tests and
 * paid for none of them.
 */
export function holmAdjust(deltas: PairedDelta[], alpha = 0.05): void {
  const order = deltas.map((d, i) => ({ i, p: d.p })).sort((a, b) => a.p - b.p);
  const k = order.length;
  let running = 0;
  for (let rank = 0; rank < k; rank++) {
    const { i, p } = order[rank];
    const adjusted = Math.min(1, p * (k - rank));
    running = Math.max(running, adjusted); // enforce monotonicity
    deltas[i].pAdjusted = running;
    if (running > alpha && (deltas[i].verdict === 'better' || deltas[i].verdict === 'worse')) {
      deltas[i].verdict = 'inconclusive';
      deltas[i].note +=
        ` Demoted by the Holm correction across ${k} comparisons (adjusted p = ${running.toFixed(3)}): ` +
        'testing several candidates at once means each one needs a higher bar.';
    }
  }
}

/**
 * Expected upward bias from taking the maximum of k noisy, truly-tied
 * candidates: sigma x E[max of k standard normals], via the Blom approximation.
 *
 * This is the number that justifies the two disjoint seed sets. At k = 1,024
 * and the measured 1-seed noise of 2.00pp it is +6.5pp of pure luck — larger
 * than any real effect in this space. Re-running the winner on the SAME seeds
 * does not fix it, because the bias is in the selection, not the precision.
 * Re-running on held-out seeds fixes it completely.
 */
export function winnersCurseBias(k: number, sigma: number): number {
  if (k <= 1) return 0;
  // E[max of k] ~= Phi^-1((k - 0.375) / (k + 0.25))
  return sigma * normalQuantile((k - 0.375) / (k + 0.25));
}

/** Acklam's inverse normal CDF (absolute error < 1.15e-9). */
export function normalQuantile(p: number): number {
  if (p <= 0) return Number.NEGATIVE_INFINITY;
  if (p >= 1) return Number.POSITIVE_INFINITY;
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
  const pLow = 0.02425;
  const pHigh = 1 - pLow;
  let q: number;
  let r: number;
  if (p < pLow) {
    q = Math.sqrt(-2 * log(p));
    return (
      (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
    );
  }
  if (p > pHigh) {
    q = Math.sqrt(-2 * log(1 - p));
    return (
      -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
    );
  }
  q = p - 0.5;
  r = q * q;
  return (
    ((((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q) /
    (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1)
  );
}

/**
 * Least-squares slope of y on x. Used for the success-per-dollar conversion,
 * where x is annual spending and y is probability of success.
 */
export function linearSlope(xs: readonly number[], ys: readonly number[]): number {
  const n = Math.min(xs.length, ys.length);
  if (n < 2) return 0;
  const mx = mean(xs.slice(0, n));
  const my = mean(ys.slice(0, n));
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    num += (xs[i] - mx) * (ys[i] - my);
    den += (xs[i] - mx) * (xs[i] - mx);
  }
  return den === 0 ? 0 : num / den;
}

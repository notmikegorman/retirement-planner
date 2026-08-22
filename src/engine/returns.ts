/**
 * Return-path generation for the three run modes (SPEC §4.3):
 *  1. deterministic  - fixed real returns, same every year
 *  2. historical     - every rolling N-year window of the historical series
 *  3. montecarlo     - seeded block bootstrap of JOINT historical rows
 *
 * Pure and deterministic: no IO, no clock, no unseeded randomness.
 */

import type { HistoricalRow, MarketAssumptions, YearReturns } from '../shared/types';
import { mulberry32, randInt } from './rng';

// ---------------------------------------------------------------------------
// CSV loading + sanity checks (SPEC §6)
// ---------------------------------------------------------------------------

/** Minimum number of annual rows we accept (1928->latest should be ~98). */
const MIN_ROWS = 95;
/** Long-run geometric-mean REAL stock return must land in ~6-7%/yr. */
const STOCK_REAL_MIN = 0.055;
const STOCK_REAL_MAX = 0.08;
/** Long-run geometric-mean REAL 10-yr bond return must land in ~1.5-2.5%/yr. */
const BOND_REAL_MIN = 0.005;
const BOND_REAL_MAX = 0.03;
/**
 * Long-run geometric-mean REAL Baa corporate return must land in ~2-5%/yr.
 * The bundled 1928-2025 series computes to 3.49% — comfortably inside, while a
 * column shifted by one row (or a Treasury column pasted twice) lands outside.
 */
const BAA_REAL_MIN = 0.02;
const BAA_REAL_MAX = 0.05;

/**
 * Parse the historical-returns CSV (columns: year,stocks,bonds10,tbills,cpi,baa;
 * `#` comment lines and the header row are skipped) and run the SPEC §6
 * sanity checks. Refuses to load — throws a descriptive Error — when the
 * series is too short, has gaps, or its long-run real returns are implausible.
 */
export function loadHistoricalCsv(text: string): HistoricalRow[] {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith('#'));

  const rows: HistoricalRow[] = [];
  for (const line of lines) {
    if (/^year\s*,/i.test(line)) continue; // header row
    const parts = line.split(',').map((p) => p.trim());
    if (parts.length !== 6) {
      throw new Error(
        `historical-returns: expected 6 columns (year,stocks,bonds10,tbills,cpi,baa), got ${parts.length} in line "${line}"`,
      );
    }
    const [year, stocks, bonds10, tbills, cpi, baa] = parts.map(Number) as [
      number,
      number,
      number,
      number,
      number,
      number,
    ];
    for (const [name, v] of Object.entries({ year, stocks, bonds10, tbills, cpi, baa })) {
      if (!Number.isFinite(v)) {
        throw new Error(`historical-returns: non-numeric ${name} in line "${line}"`);
      }
    }
    if (!Number.isInteger(year)) {
      throw new Error(`historical-returns: non-integer year in line "${line}"`);
    }
    rows.push({ year, stocks, bonds10, tbills, cpi, baa });
  }

  // --- Sanity checks (refuse to load a series failing them) ---
  if (rows.length < MIN_ROWS) {
    throw new Error(
      `historical-returns: only ${rows.length} data rows; need at least ${MIN_ROWS} (1928->latest).`,
    );
  }
  for (let i = 1; i < rows.length; i++) {
    if (rows[i].year !== rows[i - 1].year + 1) {
      throw new Error(
        `historical-returns: years must be contiguous; gap between ${rows[i - 1].year} and ${rows[i].year}.`,
      );
    }
  }

  const geoRealStocks = geometricMeanReal(rows, (r) => r.stocks);
  if (geoRealStocks < STOCK_REAL_MIN || geoRealStocks > STOCK_REAL_MAX) {
    throw new Error(
      `historical-returns: geometric-mean REAL stock return ${geoRealStocks.toFixed(4)} ` +
        `outside plausible range [${STOCK_REAL_MIN}, ${STOCK_REAL_MAX}]; refusing to load.`,
    );
  }
  const geoRealBonds = geometricMeanReal(rows, (r) => r.bonds10);
  if (geoRealBonds < BOND_REAL_MIN || geoRealBonds > BOND_REAL_MAX) {
    throw new Error(
      `historical-returns: geometric-mean REAL 10-yr bond return ${geoRealBonds.toFixed(4)} ` +
        `outside plausible range [${BOND_REAL_MIN}, ${BOND_REAL_MAX}]; refusing to load.`,
    );
  }
  const geoRealBaa = geometricMeanReal(rows, (r) => r.baa);
  if (geoRealBaa < BAA_REAL_MIN || geoRealBaa > BAA_REAL_MAX) {
    throw new Error(
      `historical-returns: geometric-mean REAL Baa corporate return ${geoRealBaa.toFixed(4)} ` +
        `outside plausible range [${BAA_REAL_MIN}, ${BAA_REAL_MAX}]; refusing to load.`,
    );
  }

  return rows;
}

/** Geometric mean of the annual REAL return (1+nom)/(1+cpi)-1, compounded. */
function geometricMeanReal(rows: HistoricalRow[], nominal: (r: HistoricalRow) => number): number {
  let product = 1;
  for (const r of rows) {
    product *= (1 + nominal(r)) / (1 + r.cpi);
  }
  return Math.pow(product, 1 / rows.length) - 1;
}

// ---------------------------------------------------------------------------
// Expense-ratio drag
// ---------------------------------------------------------------------------

/**
 * Subtract the per-class expense-ratio drag from stocks/bonds/bills nominal
 * returns. CPI is untouched (it is not an investable class).
 */
export function applyExpenseRatios(
  r: YearReturns,
  er: MarketAssumptions['expenseRatios'],
): YearReturns {
  return {
    stocks: r.stocks - er.stocks,
    bonds: r.bonds - er.bonds,
    bills: r.bills - er.bills,
    cpi: r.cpi,
  };
}

// ---------------------------------------------------------------------------
// Bond composition (Treasury/Baa blend)
// ---------------------------------------------------------------------------

/**
 * The corporate share of the bond sleeve, read once per path-set. Absent = 0 =
 * pure Treasury (the engine's historical behavior). Validated here rather than
 * trusted, because market.json is hand-editable and a fraction of 30 (percent
 * typed where a fraction belongs) would silently produce -29x leveraged
 * Treasuries.
 */
function corporateFraction(market: MarketAssumptions): number {
  const f = market.bondComposition?.corporateFraction ?? 0;
  if (!Number.isFinite(f) || f < 0 || f > 1) {
    throw new Error(`bondComposition.corporateFraction must be in [0, 1], got ${f}`);
  }
  return f;
}

/**
 * The one place a sampled year's bond return is priced: (1-f)*bonds10 + f*baa
 * on the SAME row, so cross-asset crash behavior (2008: Treasuries +20.10%,
 * Baa -3.44%) stays historical rather than assumed.
 *
 * f === 0 returns row.bonds10 ITSELF, not the blend evaluated at zero: the
 * branch guarantees the default is bit-identical to the pre-blend engine by
 * construction, so every golden digest holds without trusting float identities
 * like (1-0)*x + 0*y === x (true today, but the pin should not depend on it).
 */
function blendedBondReturn(row: HistoricalRow, f: number): number {
  return f === 0 ? row.bonds10 : (1 - f) * row.bonds10 + f * row.baa;
}

/** Map a historical row (bonds10/tbills naming) to engine YearReturns, with drag. */
function rowToReturns(
  row: HistoricalRow,
  er: MarketAssumptions['expenseRatios'],
  f: number,
): YearReturns {
  return applyExpenseRatios(
    { stocks: row.stocks, bonds: blendedBondReturn(row, f), bills: row.tbills, cpi: row.cpi },
    er,
  );
}

// ---------------------------------------------------------------------------
// Mode 1: deterministic
// ---------------------------------------------------------------------------

/**
 * Deterministic-mode REAL return for a pure Baa corporate sleeve.
 *
 * Chosen the way the existing deterministicReal numbers were chosen (see the
 * ASSUMPTIONS.md market section): a round-number summary of the bundled
 * series' long-run geometric-mean REAL return. The 1928-2025 Baa column
 * real-ises to 3.49%/yr against the same CPI column that puts stocks at 6.78%
 * (summarised as 6.5%) and 10-yr Treasuries at 1.45% (summarised as 1.8%) —
 * so Baa gets 3.5%. tests/engine/returns.test.ts recomputes the mean from the
 * CSV and fails if this pin drifts more than rounding distance from it, so a
 * data update cannot silently strand the constant.
 */
export const BAA_DETERMINISTIC_REAL = 0.035;

/**
 * Fixed-return path: nominal per class = (1 + real) * (1 + inflation) - 1,
 * minus that class's expense ratio; cpi = deterministicInflation. Identical
 * every year.
 *
 * With a corporate share f, the bond REAL return is the same blend the
 * samplers apply to each historical row, evaluated on the deterministic
 * anchors: (1-f)*deterministicReal.bonds + f*BAA_DETERMINISTIC_REAL. The
 * deterministicReal.bonds knob stays the TREASURY anchor (an override of it
 * moves the Treasury share only); f = 0 keeps the field itself, bit-identical
 * to the pre-blend engine.
 */
export function deterministicPath(market: MarketAssumptions, years: number): YearReturns[] {
  if (!Number.isInteger(years) || years <= 0) {
    throw new Error(`deterministicPath: years must be a positive integer, got ${years}`);
  }
  const infl = market.deterministicInflation;
  const real = market.deterministicReal;
  const er = market.expenseRatios;
  const f = corporateFraction(market);
  const bondsReal = f === 0 ? real.bonds : (1 - f) * real.bonds + f * BAA_DETERMINISTIC_REAL;
  const nominal = (r: number): number => (1 + r) * (1 + infl) - 1;
  const path: YearReturns[] = [];
  for (let i = 0; i < years; i++) {
    path.push({
      stocks: nominal(real.stocks) - er.stocks,
      bonds: nominal(bondsReal) - er.bonds,
      bills: nominal(real.bills) - er.bills,
      cpi: infl,
    });
  }
  return path;
}

// ---------------------------------------------------------------------------
// Mode 2: historical rolling windows (cFIREsim method)
// ---------------------------------------------------------------------------

/**
 * Every rolling window of length `years` from the historical series:
 * paths = rows.length - years + 1. Window i covers rows[i .. i+years-1].
 */
export function historicalPaths(
  rows: HistoricalRow[],
  years: number,
  market: MarketAssumptions,
): YearReturns[][] {
  if (!Number.isInteger(years) || years <= 0) {
    throw new Error(`historicalPaths: years must be a positive integer, got ${years}`);
  }
  if (years > rows.length) {
    throw new Error(
      `historicalPaths: horizon of ${years} years exceeds the ${rows.length}-year historical ` +
        `series (${rows[0]?.year}-${rows[rows.length - 1]?.year}); no rolling window is that long. ` +
        `Shorten the horizon or use Monte Carlo mode.`,
    );
  }
  const er = market.expenseRatios;
  const f = corporateFraction(market);
  const paths: YearReturns[][] = [];
  for (let start = 0; start + years <= rows.length; start++) {
    const path: YearReturns[] = [];
    for (let j = 0; j < years; j++) {
      path.push(rowToReturns(rows[start + j], er, f));
    }
    paths.push(path);
  }
  return paths;
}

// ---------------------------------------------------------------------------
// Mode 3: block bootstrap Monte Carlo
// ---------------------------------------------------------------------------

/**
 * Block bootstrap (SPEC §4.3): per path, repeatedly draw a uniform start
 * index in [0, rows.length - blockYears] and take `blockYears` CONTIGUOUS
 * JOINT rows — stocks+bonds+bills+cpi stay together, never sampled
 * independently, preserving cross-class correlation and inflation linkage —
 * concatenating blocks until `years` are filled, trimming any tail overflow.
 * Seeded exclusively via mulberry32(seed): same seed => identical output.
 */
export function bootstrapPaths(
  rows: HistoricalRow[],
  years: number,
  paths: number,
  blockYears: number,
  seed: number,
  market: MarketAssumptions,
): YearReturns[][] {
  if (!Number.isInteger(years) || years <= 0) {
    throw new Error(`bootstrapPaths: years must be a positive integer, got ${years}`);
  }
  if (!Number.isInteger(paths) || paths <= 0) {
    throw new Error(`bootstrapPaths: paths must be a positive integer, got ${paths}`);
  }
  if (!Number.isInteger(blockYears) || blockYears <= 0) {
    throw new Error(`bootstrapPaths: blockYears must be a positive integer, got ${blockYears}`);
  }
  if (blockYears > rows.length) {
    throw new Error(
      `bootstrapPaths: blockYears ${blockYears} exceeds the ${rows.length}-row historical series.`,
    );
  }
  const rng = mulberry32(seed);
  const er = market.expenseRatios;
  const f = corporateFraction(market);
  const maxStartExclusive = rows.length - blockYears + 1; // start in [0, rows.length - blockYears]
  const out: YearReturns[][] = [];
  for (let p = 0; p < paths; p++) {
    const path: YearReturns[] = [];
    while (path.length < years) {
      const start = randInt(rng, maxStartExclusive);
      const take = Math.min(blockYears, years - path.length); // trim tail overflow
      for (let j = 0; j < take; j++) {
        path.push(rowToReturns(rows[start + j], er, f));
      }
    }
    out.push(path);
  }
  return out;
}

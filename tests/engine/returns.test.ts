import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { HistoricalRow, MarketAssumptions } from '../../src/shared/types';
import { mulberry32, randInt } from '../../src/engine/rng';
import {
  BAA_DETERMINISTIC_REAL,
  applyExpenseRatios,
  bootstrapPaths,
  deterministicPath,
  historicalPaths,
  loadHistoricalCsv,
} from '../../src/engine/returns';

const CSV_PATH = fileURLToPath(
  new URL('../../data-defaults/assumptions/historical-returns.csv', import.meta.url),
);

/**
 * The Baa column as independently verified (Damodaran cross-checked against
 * FRED BAA/DBAA recomputation) — a verbatim copy of the verification
 * deliverable, NOT of the engine's CSV. The row-for-row comparison below is
 * what makes a silent edit to either file surface.
 */
const VERIFIED_BAA_PATH = fileURLToPath(
  new URL('../fixtures/baa-corporate-returns.verified.csv', import.meta.url),
);

const MARKET: MarketAssumptions = {
  deterministicReal: { stocks: 0.065, bonds: 0.02, bills: 0.005 },
  deterministicInflation: 0.025,
  expenseRatios: { stocks: 0.0003, bonds: 0.0004, bills: 0.0005 },
  stockDividendYield: 0.014,
  bootstrapBlockYears: 5,
  homeAppreciationRealSpread: 0.01,
  medicalInflationRealSpread: 0.02,
  rentGrowthRealSpread: 0.005,
};

/** Build a CSV text (with comments + header) from row tuples. */
function csvOf(rows: Array<[number, number, number, number, number, number]>): string {
  const lines = [
    '# synthetic test series',
    'year,stocks,bonds10,tbills,cpi,baa',
    ...rows.map((r) => r.join(',')),
  ];
  return lines.join('\n') + '\n';
}

/**
 * 98 synthetic years (1900-1997) with constant returns and cpi = 2%:
 * stocks nominal 1.065*1.02-1 = 0.0863  -> real exactly 6.5% (in range)
 * bonds  nominal = (1+bondReal)*1.02-1  -> real exactly bondReal
 * baa    nominal = (1+baaReal)*1.02-1   -> real exactly baaReal (default 3%,
 *                                          inside the [0.02, 0.05] gate)
 */
function syntheticRows(
  bondReal: number,
  stockReal = 0.065,
  baaReal = 0.03,
): Array<[number, number, number, number, number, number]> {
  const cpi = 0.02;
  const stocksNom = (1 + stockReal) * (1 + cpi) - 1;
  const bondsNom = (1 + bondReal) * (1 + cpi) - 1;
  const baaNom = (1 + baaReal) * (1 + cpi) - 1;
  const rows: Array<[number, number, number, number, number, number]> = [];
  for (let y = 1900; y <= 1997; y++) {
    rows.push([y, stocksNom, bondsNom, 0.03, cpi, baaNom]);
  }
  return rows;
}

describe('mulberry32', () => {
  it('produces the golden sequence for seed 12345', () => {
    const rng = mulberry32(12345);
    // Golden values captured from this exact algorithm; deterministic per spec.
    expect(rng()).toBe(0.9797282677609473);
    expect(rng()).toBe(0.3067522644996643);
    expect(rng()).toBe(0.484205421525985);
    expect(rng()).toBe(0.817934412509203);
    expect(rng()).toBe(0.5094283693470061);
  });

  it('produces the golden sequence for seed 42', () => {
    const rng = mulberry32(42);
    expect(rng()).toBe(0.6011037519201636);
    expect(rng()).toBe(0.44829055899754167);
    expect(rng()).toBe(0.8524657934904099);
  });

  it('is bit-identical across two invocations with the same seed', () => {
    const a = mulberry32(987654321);
    const b = mulberry32(987654321);
    const seqA = Array.from({ length: 1000 }, () => a());
    const seqB = Array.from({ length: 1000 }, () => b());
    expect(seqA).toEqual(seqB);
  });

  it('stays in [0, 1)', () => {
    const rng = mulberry32(7);
    for (let i = 0; i < 10000; i++) {
      const x = rng();
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThan(1);
    }
  });
});

describe('randInt', () => {
  it('maps rng output to [0, maxExclusive)', () => {
    // rng = 0 -> floor(0 * 10) = 0; rng = 0.999 -> floor(9.99) = 9
    expect(randInt(() => 0, 10)).toBe(0);
    expect(randInt(() => 0.999, 10)).toBe(9);
    // 0.35 * 4 = 1.4 -> 1
    expect(randInt(() => 0.35, 4)).toBe(1);
  });

  it('covers the full range with a real rng', () => {
    const rng = mulberry32(1);
    const seen = new Set<number>();
    for (let i = 0; i < 1000; i++) seen.add(randInt(rng, 5));
    expect([...seen].sort()).toEqual([0, 1, 2, 3, 4]);
  });

  it('rejects non-positive or non-integer maxExclusive', () => {
    expect(() => randInt(() => 0.5, 0)).toThrow(/positive integer/);
    expect(() => randInt(() => 0.5, -3)).toThrow(/positive integer/);
    expect(() => randInt(() => 0.5, 2.5)).toThrow(/positive integer/);
  });
});

describe('loadHistoricalCsv', () => {
  it('loads the real bundled series: 98 rows, 1928-2025, 1931 crash present', () => {
    const rows = loadHistoricalCsv(readFileSync(CSV_PATH, 'utf8'));
    expect(rows).toHaveLength(98);
    expect(rows[0].year).toBe(1928);
    expect(rows[97].year).toBe(2025);
    // 1931: worst year in the series, stocks -43.84%; Baa's own worst year too
    // (-15.68%, the Depression credit crash) — the divergence from Treasuries
    // (-2.56%) is the reason the column exists.
    expect(rows[3].year).toBe(1931);
    expect(rows[3].stocks).toBeCloseTo(-0.4384, 10);
    expect(rows[3].bonds10).toBeCloseTo(-0.0256, 10);
    expect(rows[3].tbills).toBeCloseTo(0.0231, 10);
    expect(rows[3].cpi).toBeCloseTo(-0.0932, 10);
    expect(rows[3].baa).toBeCloseTo(-0.1568, 10);
  });

  it('the baa column matches the verified deliverable row for row', () => {
    /*
     * Two independent statements of the same 98 numbers: the engine's CSV and
     * the verification deliverable (Damodaran, cross-checked against a FRED
     * yield recomputation — exact to the bp 1928-1985). Comparing them here
     * means a silent edit to EITHER file fails a test, and the failure names
     * the year. Compared as numbers, not strings, so a cosmetic "0.0322" vs
     * "0.03220" rewrite doesn't false-alarm — but any value change does.
     */
    const rows = loadHistoricalCsv(readFileSync(CSV_PATH, 'utf8'));
    const verified = readFileSync(VERIFIED_BAA_PATH, 'utf8')
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !l.startsWith('#') && !/^year/i.test(l))
      .map((l) => l.split(',').map(Number) as [number, number]);
    expect(verified).toHaveLength(98);
    expect(rows).toHaveLength(verified.length);
    for (let i = 0; i < rows.length; i++) {
      expect(rows[i].year, `row ${i}`).toBe(verified[i][0]);
      expect(rows[i].baa, `baa for ${verified[i][0]}`).toBe(verified[i][1]);
    }
  });

  it('accepts a plausible synthetic series (control for the doctored cases)', () => {
    // bonds real exactly 2% -> inside [0.005, 0.03]; stocks real 6.5% -> inside [0.055, 0.08]
    const rows = loadHistoricalCsv(csvOf(syntheticRows(0.02)));
    expect(rows).toHaveLength(98);
    expect(rows[0].year).toBe(1900);
  });

  it('refuses a doctored series with 8%-real bonds', () => {
    // bond real return of 0.08 is far above the [0.005, 0.03] sanity range
    expect(() => loadHistoricalCsv(csvOf(syntheticRows(0.08)))).toThrow(
      /bond.*outside plausible range/i,
    );
  });

  it('refuses a series with an implausible real stock return', () => {
    // stocks real 12% > 0.08 upper bound
    expect(() => loadHistoricalCsv(csvOf(syntheticRows(0.02, 0.12)))).toThrow(
      /stock.*outside plausible range/i,
    );
  });

  it('refuses a series with fewer than 95 rows', () => {
    const short = syntheticRows(0.02).slice(0, 50);
    expect(() => loadHistoricalCsv(csvOf(short))).toThrow(/at least 95/);
  });

  it('refuses a series with a year gap', () => {
    const gappy = syntheticRows(0.02).filter(([year]) => year !== 1950);
    // still 97 rows (>= 95) but 1949 -> 1951 is a gap
    expect(() => loadHistoricalCsv(csvOf(gappy))).toThrow(/contiguous.*1949.*1951/);
  });

  it('refuses a doctored series with an implausible real Baa return', () => {
    // baa real 8% > 0.05 upper bound (and 1% < 0.02 lower bound): a pasted
    // Treasury column or a one-row shift lands outside the gate.
    expect(() => loadHistoricalCsv(csvOf(syntheticRows(0.02, 0.065, 0.08)))).toThrow(
      /Baa.*outside plausible range/i,
    );
    expect(() => loadHistoricalCsv(csvOf(syntheticRows(0.02, 0.065, 0.01)))).toThrow(
      /Baa.*outside plausible range/i,
    );
  });

  it('refuses malformed lines', () => {
    // A 5-column line is the PRE-BAA format — it must fail loudly, or a stale
    // user-copied CSV would silently zero the corporate sleeve.
    expect(() =>
      loadHistoricalCsv('year,stocks,bonds10,tbills,cpi,baa\n1928,0.1,0.2,0.03,0.01\n'),
    ).toThrow(/expected 6 columns/);
    expect(() => loadHistoricalCsv('year,stocks,bonds10,tbills,cpi,baa\n1928,0.1,0.2\n')).toThrow(
      /expected 6 columns/,
    );
    expect(() =>
      loadHistoricalCsv('year,stocks,bonds10,tbills,cpi,baa\n1928,abc,0.01,0.02,0.03,0.04\n'),
    ).toThrow(/non-numeric/);
  });
});

describe('applyExpenseRatios', () => {
  it('subtracts per-class drag from stocks/bonds/bills but never cpi', () => {
    const out = applyExpenseRatios(
      { stocks: 0.1, bonds: 0.05, bills: 0.02, cpi: 0.03 },
      { stocks: 0.0003, bonds: 0.0004, bills: 0.0005 },
    );
    // 0.10 - 0.0003 = 0.0997; 0.05 - 0.0004 = 0.0496; 0.02 - 0.0005 = 0.0195
    expect(out.stocks).toBeCloseTo(0.0997, 12);
    expect(out.bonds).toBeCloseTo(0.0496, 12);
    expect(out.bills).toBeCloseTo(0.0195, 12);
    expect(out.cpi).toBe(0.03); // untouched
  });
});

describe('deterministicPath', () => {
  it('computes nominal = (1+real)(1+inflation)-1 minus expense drag, same every year', () => {
    const path = deterministicPath(MARKET, 40);
    expect(path).toHaveLength(40);
    // stocks: (1.065)(1.025) - 1 = 0.091625 gross nominal; - 0.0003 er = 0.091325
    expect(path[0].stocks).toBeCloseTo(0.091325, 12);
    // bonds: (1.02)(1.025) - 1 = 0.0455; - 0.0004 = 0.0451
    expect(path[0].bonds).toBeCloseTo(0.0451, 12);
    // bills: (1.005)(1.025) - 1 = 0.030125; - 0.0005 = 0.029625
    expect(path[0].bills).toBeCloseTo(0.029625, 12);
    // cpi = deterministicInflation exactly (no drag)
    expect(path[0].cpi).toBe(0.025);
    // identical every year
    for (const yr of path) expect(yr).toEqual(path[0]);
  });

  it('rejects a non-positive horizon', () => {
    expect(() => deterministicPath(MARKET, 0)).toThrow(/positive integer/);
  });
});

describe('historicalPaths', () => {
  const rows = loadHistoricalCsv(readFileSync(CSV_PATH, 'utf8'));

  it('produces rows.length - years + 1 rolling windows', () => {
    // 98 rows, 30-year horizon -> 98 - 30 + 1 = 69 windows
    const paths = historicalPaths(rows, 30, MARKET);
    expect(paths).toHaveLength(69);
    for (const p of paths) expect(p).toHaveLength(30);
  });

  it('maps bonds10->bonds, tbills->bills and applies expense ratios', () => {
    const paths = historicalPaths(rows, 30, MARKET);
    // window 0, year 0 = 1928: stocks 0.4381 - 0.0003 = 0.4378;
    // bonds 0.0084 - 0.0004 = 0.0080; bills 0.0308 - 0.0005 = 0.0303; cpi -0.0116 untouched
    expect(paths[0][0].stocks).toBeCloseTo(0.4378, 12);
    expect(paths[0][0].bonds).toBeCloseTo(0.008, 12);
    expect(paths[0][0].bills).toBeCloseTo(0.0303, 12);
    expect(paths[0][0].cpi).toBe(-0.0116);
  });

  it('windows overlap correctly: window i year j === window i+1 year j-1', () => {
    const paths = historicalPaths(rows, 10, MARKET);
    // paths[i][j] is rows[i + j], so paths[3][5] and paths[4][4] are both rows[8]
    expect(paths[3][5]).toEqual(paths[4][4]);
    // exhaustive overlap check on a few windows
    for (let i = 0; i < 5; i++) {
      for (let j = 1; j < 10; j++) {
        expect(paths[i][j]).toEqual(paths[i + 1][j - 1]);
      }
    }
    // last window ends on the last row (2025)
    const last = paths[paths.length - 1];
    expect(last[9].cpi).toBe(rows[97].cpi);
  });

  it('throws a helpful error when the horizon exceeds the series', () => {
    expect(() => historicalPaths(rows, 99, MARKET)).toThrow(/99 years exceeds the 98-year/);
  });
});

describe('bootstrapPaths', () => {
  const rows = loadHistoricalCsv(readFileSync(CSV_PATH, 'utf8'));
  const er = MARKET.expenseRatios;

  /** Map post-expense-ratio stocks value -> source row index (values are unique in the real series). */
  function buildStocksIndex(): Map<number, number> {
    const map = new Map<number, number>();
    rows.forEach((r, i) => map.set(r.stocks - er.stocks, i));
    expect(map.size).toBe(rows.length); // uniqueness precondition for the lookup
    return map;
  }

  it('has the requested dimensions and trims the tail block', () => {
    // years=12 with blockYears=5 -> blocks of 5+5+2; length must be exactly 12
    const paths = bootstrapPaths(rows, 12, 25, 5, 123, MARKET);
    expect(paths).toHaveLength(25);
    for (const p of paths) expect(p).toHaveLength(12);
  });

  it('is bit-identical for the same seed and different for another seed', () => {
    const a = bootstrapPaths(rows, 30, 50, 5, 20260812, MARKET);
    const b = bootstrapPaths(rows, 30, 50, 5, 20260812, MARKET);
    expect(a).toEqual(b);
    const c = bootstrapPaths(rows, 30, 50, 5, 20260813, MARKET);
    expect(JSON.stringify(c)).not.toBe(JSON.stringify(a));
  });

  it('every block is a verbatim contiguous slice of the source rows', () => {
    const stocksIndex = buildStocksIndex();
    const blockYears = 5;
    const years = 12;
    const paths = bootstrapPaths(rows, years, 20, blockYears, 777, MARKET);
    for (const path of paths) {
      for (let blockStart = 0; blockStart < years; blockStart += blockYears) {
        const len = Math.min(blockYears, years - blockStart);
        const srcIdx = stocksIndex.get(path[blockStart].stocks);
        expect(srcIdx).toBeDefined();
        // block must fit inside the series (start drawn from [0, rows.length - blockYears])
        expect(srcIdx!).toBeLessThanOrEqual(rows.length - blockYears);
        for (let k = 0; k < len; k++) {
          const src = rows[srcIdx! + k];
          expect(path[blockStart + k].stocks).toBe(src.stocks - er.stocks);
          expect(path[blockStart + k].bonds).toBe(src.bonds10 - er.bonds);
          expect(path[blockStart + k].bills).toBe(src.tbills - er.bills);
          expect(path[blockStart + k].cpi).toBe(src.cpi);
        }
      }
    }
  });

  it('samples JOINT rows: every sampled year keeps its original cross-class pairing', () => {
    const stocksIndex = buildStocksIndex();
    const paths = bootstrapPaths(rows, 40, 30, 5, 424242, MARKET);
    for (const path of paths) {
      for (const yr of path) {
        const srcIdx = stocksIndex.get(yr.stocks);
        expect(srcIdx).toBeDefined();
        const src = rows[srcIdx!];
        // stocks matched this row; bonds, bills, AND cpi must come from the SAME row
        expect(yr.bonds).toBe(src.bonds10 - er.bonds);
        expect(yr.bills).toBe(src.tbills - er.bills);
        expect(yr.cpi).toBe(src.cpi);
      }
    }
  });

  it('validates arguments', () => {
    expect(() => bootstrapPaths(rows, 0, 10, 5, 1, MARKET)).toThrow(/years/);
    expect(() => bootstrapPaths(rows, 30, 0, 5, 1, MARKET)).toThrow(/paths/);
    expect(() => bootstrapPaths(rows, 30, 10, 0, 1, MARKET)).toThrow(/blockYears/);
    expect(() => bootstrapPaths(rows, 30, 10, 99, 1, MARKET)).toThrow(/exceeds the 98-row/);
  });
});

describe('bondComposition: the Treasury/Baa blend', () => {
  const rows = loadHistoricalCsv(readFileSync(CSV_PATH, 'utf8'));

  /** MARKET with a corporate share; zeroEr strips drag so pins stay hand-checkable. */
  function withF(f: number, zeroEr = false): MarketAssumptions {
    return {
      ...MARKET,
      ...(zeroEr ? { expenseRatios: { stocks: 0, bonds: 0, bills: 0 } } : {}),
      bondComposition: { corporateFraction: f },
    };
  }

  it('prices 2008 at f=0.3 as 0.7*0.2010 + 0.3*(-0.0344) = 0.13038 (pinned by hand)', () => {
    // One-year windows: window index = year - 1928, so 2008 is window 80.
    const paths = historicalPaths(rows, 1, withF(0.3, true));
    const i2008 = 2008 - 1928;
    expect(rows[i2008].year).toBe(2008);
    expect(rows[i2008].bonds10).toBeCloseTo(0.201, 12);
    expect(rows[i2008].baa).toBeCloseTo(-0.0344, 12);
    expect(paths[i2008][0].bonds).toBeCloseTo(0.13038, 10);
    // The same year at f=0: the +20.10% Treasury rally, undiluted. The 23.5pp
    // gap between these two numbers is the crash behavior the dial trades away.
    const pure = historicalPaths(rows, 1, withF(0, true));
    expect(pure[i2008][0].bonds).toBeCloseTo(0.201, 12);
  });

  it('f absent and f=0 are bit-identical across all three generators', () => {
    // toEqual on numbers is exact (===), so these are bit-identity checks:
    // the f===0 branch returns row.bonds10 / real.bonds THEMSELVES, never the
    // blend arithmetic evaluated at zero.
    expect(historicalPaths(rows, 30, withF(0))).toEqual(historicalPaths(rows, 30, MARKET));
    expect(bootstrapPaths(rows, 30, 50, 5, 20260812, withF(0))).toEqual(
      bootstrapPaths(rows, 30, 50, 5, 20260812, MARKET),
    );
    expect(deterministicPath(withF(0), 40)).toEqual(deterministicPath(MARKET, 40));
  });

  it('f=1 is the pure Baa series (sampled modes)', () => {
    const er = MARKET.expenseRatios;
    const hist = historicalPaths(rows, 5, withF(1));
    for (let w = 0; w < hist.length; w++) {
      for (let j = 0; j < 5; j++) {
        expect(hist[w][j].bonds).toBe(rows[w + j].baa - er.bonds);
        // The other classes never move with f.
        expect(hist[w][j].stocks).toBe(rows[w + j].stocks - er.stocks);
        expect(hist[w][j].cpi).toBe(rows[w + j].cpi);
      }
    }
    // Bootstrap keeps JOINT rows at f=1 too: match each sampled year back to
    // its source row via the (unique) stocks value and demand the bonds slot
    // carries that same row's baa.
    const stocksIndex = new Map<number, number>();
    rows.forEach((r, i) => stocksIndex.set(r.stocks - er.stocks, i));
    const paths = bootstrapPaths(rows, 40, 20, 5, 424242, withF(1));
    for (const path of paths) {
      for (const yr of path) {
        const srcIdx = stocksIndex.get(yr.stocks);
        expect(srcIdx).toBeDefined();
        expect(yr.bonds).toBe(rows[srcIdx!].baa - er.bonds);
      }
    }
  });

  it('deterministic mode blends the REAL anchors: f=0.3 -> 0.7*0.02 + 0.3*0.035 = 0.0245', () => {
    // MARKET.deterministicReal.bonds = 0.02 (Treasury anchor), Baa anchor 0.035.
    // Nominal: (1.0245)(1.025) - 1 = 0.0501125, minus er.bonds 0.0004.
    const path = deterministicPath(withF(0.3), 10);
    expect(path[0].bonds).toBeCloseTo(0.0501125 - 0.0004, 12);
    // f=1: the pure Baa anchor, (1.035)(1.025) - 1 - 0.0004 = 0.0604375.
    const pure = deterministicPath(withF(1), 10);
    expect(pure[0].bonds).toBeCloseTo(1.035 * 1.025 - 1 - 0.0004, 12);
    // Identical every year, like every deterministic path.
    for (const yr of path) expect(yr).toEqual(path[0]);
  });

  it('BAA_DETERMINISTIC_REAL is the bundled series real-ised, to rounding distance', () => {
    /*
     * The deterministic Baa anchor was CHOSEN the way the market.json anchors
     * were chosen: a round-number summary of the series' long-run
     * geometric-mean REAL return. Recompute that mean from the shipped CSV and
     * demand the pin sits within rounding distance (0.005), so a future data
     * update cannot silently strand the constant on an old vintage.
     */
    let product = 1;
    for (const r of rows) product *= (1 + r.baa) / (1 + r.cpi);
    const geoReal = Math.pow(product, 1 / rows.length) - 1;
    expect(Math.abs(geoReal - BAA_DETERMINISTIC_REAL)).toBeLessThan(0.005);
  });

  it('rejects a corporateFraction outside [0, 1] in every generator', () => {
    // 30 is the percent-typed-as-fraction mistake; without the gate it would
    // price the sleeve as -29x leveraged Treasuries and say nothing.
    expect(() => deterministicPath(withF(30), 10)).toThrow(/corporateFraction/);
    expect(() => historicalPaths(rows, 10, withF(-0.1))).toThrow(/corporateFraction/);
    expect(() => bootstrapPaths(rows, 10, 5, 5, 1, withF(1.5))).toThrow(/corporateFraction/);
    expect(() => deterministicPath(withF(Number.NaN), 10)).toThrow(/corporateFraction/);
  });
});

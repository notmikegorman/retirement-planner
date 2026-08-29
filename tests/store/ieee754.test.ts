/**
 * The vendored fdlibm log/exp (src/store/search/ieee754.ts) — the search
 * statistics' answer to Math.log/Math.exp being merely "implementation-
 * approximated" in the ES spec, which let node's V8 and Chromium's V8 fork a
 * search report by one ULP inside a ci95.
 *
 * What can be tested here and what cannot, stated honestly: DETERMINISM
 * (same bits on every engine) is a property of the code — only correctly-
 * rounded arithmetic and integer bit ops, no Math.log/Math.exp anywhere — and
 * the dual-stack gate proves it end to end by byte-comparing whole reports
 * across node and Chromium. What THIS file pins is FAITHFULNESS: the port
 * must agree with the platform libm to within a couple of ULP everywhere the
 * statistics roam (fdlibm's own guarantee is < 1 ULP error, and Math.* is
 * itself within a few ULP of correctly rounded), plus the exact IEEE edge
 * semantics fdlibm defines. A transcription slip in a polynomial coefficient
 * would fail the ULP sweep on the first run.
 */
import { describe, expect, it } from 'vitest';
import { exp, log } from '../../src/store/search/ieee754';
import { mulberry32 } from '../../src/engine/rng';

/** Distance in representable doubles between two finite numbers. */
function ulpDistance(a: number, b: number): number {
  if (a === b) return 0;
  const buf = new DataView(new ArrayBuffer(8));
  const bits = (x: number): bigint => {
    buf.setFloat64(0, x);
    let u = buf.getBigUint64(0);
    // Map to a monotone integer line so distance works across signs.
    if (u & 0x8000000000000000n) u = 0x8000000000000000n - (u & 0x7fffffffffffffffn);
    else u += 0x8000000000000000n;
    return u;
  };
  const d = bits(a) - bits(b);
  return Number(d < 0n ? -d : d);
}

describe('log', () => {
  it('stays within 2 ULP of the platform libm across the full finite range', () => {
    const rng = mulberry32(0xf00d);
    for (let i = 0; i < 100_000; i++) {
      // log-uniform over (~5e-324, ~1.8e308): exponent first, then mantissa.
      const x = 2 ** (rng() * 2090 - 1060) * (1 + rng());
      const got = log(x);
      const want = Math.log(x);
      expect(
        ulpDistance(got, want),
        `log(${x}) = ${got}, Math.log = ${want}`,
      ).toBeLessThanOrEqual(2);
    }
  });

  it('is exact where fdlibm is exact, and honours the IEEE edges', () => {
    expect(log(1)).toBe(0);
    expect(log(0)).toBe(Number.NEGATIVE_INFINITY);
    expect(log(-0)).toBe(Number.NEGATIVE_INFINITY);
    expect(log(-1)).toBeNaN();
    expect(log(Number.NEGATIVE_INFINITY)).toBeNaN();
    expect(log(Number.POSITIVE_INFINITY)).toBe(Number.POSITIVE_INFINITY);
    expect(log(Number.NaN)).toBeNaN();
    // The smallest subnormal goes through the two54 scaling branch.
    expect(log(Number.MIN_VALUE)).toBeCloseTo(-744.4400719213812, 10);
  });
});

describe('exp', () => {
  it('stays within 2 ULP of the platform libm across the useful range', () => {
    const rng = mulberry32(0xbeef);
    for (let i = 0; i < 100_000; i++) {
      const x = rng() * 1500 - 750; // covers underflow to overflow
      const got = exp(x);
      const want = Math.exp(x);
      if (!Number.isFinite(want) || want === 0) {
        expect(got, `exp(${x})`).toBe(want);
      } else {
        expect(
          ulpDistance(got, want),
          `exp(${x}) = ${got}, Math.exp = ${want}`,
        ).toBeLessThanOrEqual(2);
      }
    }
  });

  it('honours the IEEE edges and the fdlibm thresholds', () => {
    expect(exp(0)).toBe(1);
    expect(exp(Number.POSITIVE_INFINITY)).toBe(Number.POSITIVE_INFINITY);
    expect(exp(Number.NEGATIVE_INFINITY)).toBe(0);
    expect(exp(Number.NaN)).toBeNaN();
    expect(exp(710)).toBe(Number.POSITIVE_INFINITY); // past o_threshold
    expect(exp(-746)).toBe(0); // past u_threshold
    expect(exp(1e-30)).toBe(1 + 1e-30); // the |x| < 2^-28 shortcut
    // Deep-but-representable results go through the k < -1021 rescale branch.
    expect(exp(-709)).toBeCloseTo(1.216780750623423e-308, 10);
    expect(exp(-709) > 0).toBe(true);
  });

  it('round-trips with log to within the mathematical amplification bound', () => {
    // Not a precision claim about the port — a sanity net against gross
    // transcription errors. exp amplifies an absolute input error d to a
    // RELATIVE output error of ~d, so a sub-ULP error in log(x) (absolute
    // ~|log x| * 2^-52) legitimately becomes up to ~|log x| output ULPs;
    // over this range (|log x| <= ~14.6) that allows mid-teens distances.
    // Math.exp(Math.log(x)) drifts the same way, for the same reason.
    const rng = mulberry32(0xcafe);
    for (let i = 0; i < 10_000; i++) {
      const x = 2 ** (rng() * 40 - 20) * (1 + rng());
      expect(ulpDistance(exp(log(x)), x), `round-trip ${x}`).toBeLessThanOrEqual(32);
    }
  });
});

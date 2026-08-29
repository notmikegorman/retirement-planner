/**
 * Vendored fdlibm log/exp — the shared sha256's sibling, for the same reason.
 *
 * THE PROBLEM. The ECMAScript spec does not require Math.log or Math.exp to
 * be correctly rounded ("implementation-approximated"), and in practice the
 * V8 build inside node and the V8 build inside Chromium disagree by 1 ULP on
 * some inputs. Every other operation the search statistics perform — + - * /,
 * Math.sqrt, comparisons — IS correctly rounded by IEEE-754 and identical on
 * every engine. So the t-quantiles, p-values and confidence intervals in a
 * search report were deterministic except for exactly these two functions,
 * and the dual-stack gate caught the fork: a report byte-identical for 4,041
 * characters and then one ULP apart inside a ci95.
 *
 * THE FIX, on the Phase-0 pattern: one vendored implementation, both
 * environments, so "identical" stays literal rather than degrading to "close
 * enough per tested input" (the trade the plan's parity section explicitly
 * refuses). These are straight ports of Sun's fdlibm 5.3 e_log.c and e_exp.c
 * — the same code most libm implementations (and V8's own src/base/ieee754)
 * descend from — using only correctly-rounded arithmetic and integer bit
 * manipulation, so they produce bit-identical doubles on every JS engine.
 * Accuracy is the fdlibm guarantee: error below 1 ULP.
 *
 * SCOPE, deliberately narrow: the search statistics (stats.ts) are the only
 * consumer. The ENGINE keeps native Math — its cross-environment byte
 * fidelity is proven directly by the parity gate on every CI run, and
 * swapping its math on suspicion would risk the very numbers the gate pins.
 * If the parity gate ever catches the engine forking the same way, this
 * module is the remedy waiting.
 */

// One scratch buffer for word access. DataView with explicit (default,
// big-endian) byte order, so high word = bytes 0-3 on every platform.
const scratch = new DataView(new ArrayBuffer(8));

/** High 32 bits of a double, as a SIGNED int32 (fdlibm's __HI). */
function hi(x: number): number {
  scratch.setFloat64(0, x);
  return scratch.getInt32(0);
}

/** Low 32 bits of a double, unsigned (fdlibm's __LO). */
function lo(x: number): number {
  scratch.setFloat64(0, x);
  return scratch.getUint32(4);
}

/** x with its high word replaced (fdlibm's `__HI(x) = ...`). */
function setHi(x: number, h: number): number {
  scratch.setFloat64(0, x);
  scratch.setInt32(0, h | 0);
  return scratch.getFloat64(0);
}

// ---------------------------------------------------------------------------
// e_log.c
// ---------------------------------------------------------------------------

const ln2_hi = 6.93147180369123816490e-1;
const ln2_lo = 1.90821492927058770002e-10;
const two54 = 1.80143985094819840000e16;
const Lg1 = 6.666666666666735130e-1;
const Lg2 = 3.999999999940941908e-1;
const Lg3 = 2.857142874366239149e-1;
const Lg4 = 2.222219843214978396e-1;
const Lg5 = 1.818357216161805012e-1;
const Lg6 = 1.531383769920937332e-1;
const Lg7 = 1.479819860511658591e-1;

/** Natural log, fdlibm e_log — bit-identical on every engine. */
export function log(xIn: number): number {
  let x = xIn;
  let hx = hi(x);
  const lx = lo(x);

  let k = 0;
  if (hx < 0x00100000) {
    // x < 2**-1022: zero, negative, or subnormal
    if (((hx & 0x7fffffff) | lx) === 0) return -two54 / 0; // log(±0) = -Inf
    if (hx < 0) return (x - x) / 0; // log(negative) = NaN
    k -= 54;
    x *= two54; // scale the subnormal up
    hx = hi(x);
  }
  if (hx >= 0x7ff00000) return x + x; // +Inf or NaN
  k += (hx >> 20) - 1023;
  hx &= 0x000fffff;
  const i0 = (hx + 0x95f64) & 0x100000;
  x = setHi(x, hx | (i0 ^ 0x3ff00000)); // normalize x or x/2
  k += i0 >> 20;
  const f = x - 1.0;
  const dk = k;
  if ((0x000fffff & (2 + hx)) < 3) {
    // |f| < 2**-20
    if (f === 0) {
      if (k === 0) return 0;
      return dk * ln2_hi + dk * ln2_lo;
    }
    const R = f * f * (0.5 - 0.33333333333333333 * f);
    if (k === 0) return f - R;
    return dk * ln2_hi - (R - dk * ln2_lo - f);
  }
  const s = f / (2.0 + f);
  const z = s * s;
  const i1 = hx - 0x6147a;
  const w = z * z;
  const j1 = 0x6b851 - hx;
  const t1 = w * (Lg2 + w * (Lg4 + w * Lg6));
  const t2 = z * (Lg1 + w * (Lg3 + w * (Lg5 + w * Lg7)));
  const i = i1 | j1;
  const R = t2 + t1;
  if (i > 0) {
    const hfsq = 0.5 * f * f;
    if (k === 0) return f - (hfsq - s * (hfsq + R));
    return dk * ln2_hi - (hfsq - (s * (hfsq + R) + dk * ln2_lo) - f);
  }
  if (k === 0) return f - s * (f - R);
  return dk * ln2_hi - (s * (f - R) - dk * ln2_lo - f);
}

// ---------------------------------------------------------------------------
// e_exp.c
// ---------------------------------------------------------------------------

const halF = [0.5, -0.5];
const huge = 1.0e300;
const twom1000 = 9.33263618503218878990e-302;
const o_threshold = 7.09782712893383973096e2;
const u_threshold = -7.45133219101941108420e2;
const ln2HI = [6.93147180369123816490e-1, -6.93147180369123816490e-1];
const ln2LO = [1.90821492927058770002e-10, -1.90821492927058770002e-10];
const invln2 = 1.44269504088896338700;
const P1 = 1.66666666666666019037e-1;
const P2 = -2.77777777770155933842e-3;
const P3 = 6.61375632143793436117e-5;
const P4 = -1.65339022054652515390e-6;
const P5 = 4.13813679705723846039e-8;

/** e^x, fdlibm e_exp — bit-identical on every engine. */
export function exp(xIn: number): number {
  let x = xIn;
  const hxs = hi(x); // signed, for the sign bit
  const xsb = (hxs >>> 31) & 1;
  let hx = hxs & 0x7fffffff; // high word of |x|

  // Non-finite and out-of-range arguments first.
  if (hx >= 0x40862e42) {
    // |x| >= 709.78...
    if (hx >= 0x7ff00000) {
      if (((hx & 0xfffff) | lo(x)) !== 0) return x + x; // NaN
      return xsb === 0 ? x : 0.0; // exp(±Inf) = Inf, 0
    }
    if (x > o_threshold) return huge * huge; // overflow -> Inf
    if (x < u_threshold) return twom1000 * twom1000; // underflow -> 0
  }

  // Argument reduction: x = k*ln2 + r, |r| <= 0.5*ln2.
  let k = 0;
  let hiPart = 0;
  let loPart = 0;
  if (hx > 0x3fd62e42) {
    // |x| > 0.5 ln2
    if (hx < 0x3ff0a2b2) {
      // and |x| < 1.5 ln2
      hiPart = x - ln2HI[xsb];
      loPart = ln2LO[xsb];
      k = 1 - xsb - xsb;
    } else {
      k = Math.trunc(invln2 * x + halF[xsb]);
      const t = k;
      hiPart = x - t * ln2HI[0]; // t*ln2HI is exact here
      loPart = t * ln2LO[0];
    }
    x = hiPart - loPart;
  } else if (hx < 0x3e300000) {
    // |x| < 2**-28
    return 1 + x; // (fdlibm's huge+x inexact trigger; value is 1+x either way)
  }

  // x is now in the primary range.
  const t = x * x;
  const c = x - t * (P1 + t * (P2 + t * (P3 + t * (P4 + t * P5))));
  if (k === 0) return 1 - (x * c / (c - 2.0) - x);
  let y = 1 - (loPart - (x * c) / (2.0 - c) - hiPart);
  if (k >= -1021) {
    return setHi(y, hi(y) + (k << 20)); // add k to y's exponent
  }
  y = setHi(y, hi(y) + ((k + 1000) << 20));
  return y * twom1000;
}

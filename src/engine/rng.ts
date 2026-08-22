/**
 * Deterministic seeded RNG for the simulation engine.
 *
 * mulberry32 is a tiny, fast, well-distributed 32-bit PRNG. Given the same
 * seed it produces a bit-identical sequence on every platform, which is what
 * makes Monte Carlo runs reproducible (SPEC §2 "Determinism").
 */

/**
 * Create a mulberry32 generator. Returns a function producing floats in
 * [0, 1), bit-identical for a given seed across runs and platforms.
 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function next(): number {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Uniform integer in [0, maxExclusive) drawn from `rng`.
 * Throws if maxExclusive is not a positive integer.
 */
export function randInt(rng: () => number, maxExclusive: number): number {
  if (!Number.isInteger(maxExclusive) || maxExclusive <= 0) {
    throw new Error(`randInt: maxExclusive must be a positive integer, got ${maxExclusive}`);
  }
  return Math.floor(rng() * maxExclusive);
}

/**
 * Which points in the space get tried.
 *
 * THREE SOURCES, and the first two are not optional:
 *
 * 1. THE INCUMBENT — the plan exactly as it stands, as the empty assignment.
 *    It is the baseline every delta is measured against and the floor the
 *    search cannot return worse than.
 * 2. ITS ONE-KNOB NEIGHBOURS — every level of every dimension, applied alone.
 *    About 44 candidates for the twelve-dimension space. These pre-compute the
 *    "worth on its own" column of the report for free, and they guarantee that
 *    if a single knob is the whole answer, the search finds it rather than
 *    burying it inside a random combination.
 * 3. A BALANCED RANDOMISED SAMPLE — see below.
 *
 * WHY BALANCED RATHER THAN UNIFORM. Uniform sampling of N points leaves a
 * 6-level dimension with (say) 140 observations on one level and 200 on
 * another, so the marginal-effect estimates that feed the report carry
 * different precision per level for no reason. Repeating each level list to
 * length N and shuffling it independently per dimension gives every level
 * exactly N/L observations. Same cost, uniform precision, and the "what did not
 * matter" section becomes defensible.
 */
import { mulberry32 } from '../../engine/rng';
import type { SearchAssignment, SearchAxis } from '../../shared/types';

/** Fisher-Yates on a seeded RNG, so a search is reproducible from its seed. */
function shuffle<T>(items: T[], rng: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** The incumbent: no dimension written, so every knob keeps the plan's setting. */
export const BASELINE_ASSIGNMENT: SearchAssignment = {};

/** Every level of every dimension, applied ALONE to the plan as it stands. */
export function oneKnobNeighbours(axes: SearchAxis[]): SearchAssignment[] {
  const out: SearchAssignment[] = [];
  for (const axis of axes) {
    for (let i = 0; i < axis.levels.length; i++) {
      out.push({ [axis.dim]: i } as SearchAssignment);
    }
  }
  return out;
}

/** Total cells in the cartesian product (may be astronomically large). */
export function spaceSize(axes: SearchAxis[]): number {
  return axes.reduce((n, a) => n * a.levels.length, 1);
}

/**
 * The full cartesian product, capped. Honest for a small space — it removes the
 * sampling caveat entirely — and the caller is responsible for the arithmetic
 * on a large one.
 */
export function enumerateAll(axes: SearchAxis[], cap: number): SearchAssignment[] {
  const out: SearchAssignment[] = [];
  const walk = (index: number, acc: SearchAssignment): void => {
    if (out.length >= cap) return;
    if (index === axes.length) {
      out.push({ ...acc });
      return;
    }
    const axis = axes[index];
    for (let i = 0; i < axis.levels.length; i++) {
      (acc as Record<string, number>)[axis.dim] = i;
      walk(index + 1, acc);
      if (out.length >= cap) return;
    }
    delete (acc as Record<string, number>)[axis.dim];
  };
  walk(0, {});
  return out;
}

/**
 * `n` full assignments in which every level of every dimension appears exactly
 * n/L times (up to rounding).
 */
export function balancedSample(axes: SearchAxis[], n: number, seed: number): SearchAssignment[] {
  const rng = mulberry32(seed);
  const columns = new Map<string, number[]>();
  for (const axis of axes) {
    const repeated: number[] = [];
    for (let i = 0; repeated.length < n; i++) repeated.push(i % axis.levels.length);
    columns.set(axis.dim, shuffle(repeated.slice(0, n), rng));
  }
  const out: SearchAssignment[] = [];
  for (let row = 0; row < n; row++) {
    const assignment: Record<string, number> = {};
    for (const axis of axes) assignment[axis.dim] = (columns.get(axis.dim) as number[])[row];
    out.push(assignment as SearchAssignment);
  }
  return out;
}

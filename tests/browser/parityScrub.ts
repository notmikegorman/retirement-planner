/**
 * The parity gate's ONE concession to nondeterminism, written down as data.
 *
 * The gate (parity.test.ts) asserts that the Node engine and the browser
 * worker produce byte-equal RunResults. "Byte-equal" is only honest if the
 * exclusion list is principled and pinned: exclude too much and the gate
 * proves nothing (a scrub that deleted "whatever differed" would wave through
 * a genuine numeric fork); exclude too little and the gate fails on every run
 * for a reason nobody should fix.
 *
 * So the list below enumerates EXACTLY the wall-clock fields — the fields
 * whose value is a measurement of the machine, not of the plan — and the
 * scrub deletes only what the list names. The engine writes precisely two
 * wall-clock values, both landing in the same top-level field:
 *
 *   - RunResult.elapsedMs  (simulate.ts: `elapsedMs: performance.now() - t0`;
 *     solvers.ts writes the same field the same way for solver runs)
 *
 * Nothing else in a RunResult reads a clock: `meta.createdAt` is deliberately
 * the empty string from the engine ("server stamps it — engine stays
 * deterministic"), so it is NOT excluded — it participates in the byte
 * comparison, which is what keeps it deterministic. If a future engine field
 * ever measures time, the gate will fail byte-equality until that field is
 * added HERE and to the pin in parity.test.ts — two edits, on purpose, so the
 * exclusion list can never grow as a side effect of making a red test green.
 */
import type { RunResult } from '../../src/shared/types';
import { stableStringify } from '../../src/shared/util';

export const PARITY_EXCLUDED_FIELDS: readonly string[] = Object.freeze(['elapsedMs']);

/**
 * A RunResult minus exactly the excluded fields. Driven off the list (not a
 * hand-written destructure) so the list IS the behaviour: growing it without
 * editing parity.test.ts's pin fails the gate.
 */
export function scrubForParity(result: RunResult): Record<string, unknown> {
  const out: Record<string, unknown> = { ...(result as unknown as Record<string, unknown>) };
  for (const field of PARITY_EXCLUDED_FIELDS) delete out[field];
  return out;
}

/**
 * The string the gate byte-compares. stableStringify (sorted keys, arrays in
 * order) so property-insertion order — a V8 implementation detail neither
 * environment promises — cannot fail a comparison the numbers pass.
 */
export function parityText(result: RunResult): string {
  return stableStringify(scrubForParity(result));
}

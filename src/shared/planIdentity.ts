/**
 * WHAT MAKES TWO PLANS THE SAME PLAN. No IO, no React, no crypto.
 *
 * A recorded number — a score on a net-worth row, a score on a history entry —
 * is only worth keeping if the thing it scored is pinned down, and "the plan"
 * is the one input in this app that moves constantly: plan.json is rewritten on
 * every knob turn (there is no Save button, by design). So every recorded score
 * carries the identity of the plan it scored, and this module holds the one
 * rule that computes it.
 *
 * It is shared rather than server-side because both sides ask: the server
 * stamps identity onto a score at the moment it scores, and the workbench has
 * to answer for the plan on screen, which may not have reached disk yet
 * (autosave is debounced 400ms).
 *
 * (Unit tests: tests/shared/planIdentity.test.ts.)
 */
import type { Scenario } from './types';
import { stableStringify } from './util';

/**
 * Content identity of a plan — everything about it EXCEPT what it is called.
 *
 * The exclusion is load-bearing. `savePlan` pins plan.json's name to the
 * constant "Plan" on every write, so a plan frozen under any other name would
 * differ from the identical live plan ON THE NAME ALONE — and a score stamped
 * with that identity would read as a score of a different plan, which is the
 * one thing an identity must never say. `description` goes with it: two plans
 * that differ only in their prose are the same plan to the engine, which reads
 * neither field.
 *
 * NOT the same question as "would the stored file differ" — the plan's history
 * asks that wider one, because the description is a paragraph of the user's
 * own analysis and losing it silently would be a real loss (see
 * planStore.savePlan).
 */
export function planIdentityKey(plan: Scenario): string {
  const { name: _name, description: _description, ...identity } = plan;
  return stableStringify(identity);
}

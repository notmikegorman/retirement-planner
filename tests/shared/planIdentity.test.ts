/**
 * PLAN IDENTITY (src/shared/planIdentity.ts) — what makes two plans the same
 * plan, and the rule every recorded score points back at.
 *
 * It is about FALSE ALARMS versus MISSED ALARMS. A plan's NAME is not part of
 * it: `savePlan` pins plan.json's name to the constant "Plan" on every write,
 * so a plan filed under any other name would differ from the byte-identical
 * live plan on the name alone — and a score stamped with that identity would
 * read as a score of something else. Anything the ENGINE reads, on the other
 * hand, must count.
 *
 * Every other identity question in the app delegates here rather than
 * re-deriving the rule — the plan's history hashes this string, and a second
 * copy that drifted by one excluded field would disagree about whether a plan
 * had changed, silently and in opposite directions.
 */
import { describe, expect, it } from 'vitest';
import type { Scenario } from '../../src/shared/types';
import { planIdentityKey } from '../../src/shared/planIdentity';

const plan = (over: Partial<Scenario> = {}): Scenario => ({
  name: 'Plan',
  events: [
    { type: 'retire', person: 'p1', date: '2031-07' },
    { type: 'retire', person: 'p2', date: '2031-07' },
  ],
  ...over,
});

describe('planIdentityKey — what makes two plans the same plan', () => {
  it('ignores the name, because savePlan rewrites it on every save', () => {
    // The exact case: freeze "Base case" from the cabinet, then compare it
    // against plan.json, which the server always names "Plan".
    expect(planIdentityKey(plan({ name: 'Base case' }))).toBe(planIdentityKey(plan()));
  });

  it('ignores the description — two plans differing only in prose are one plan', () => {
    expect(planIdentityKey(plan({ description: 'the one I mean' }))).toBe(planIdentityKey(plan()));
  });

  it('is stable against key order, so a round trip through disk is not a change', () => {
    const reordered: Scenario = { events: plan().events, name: 'Plan' };
    expect(planIdentityKey(reordered)).toBe(planIdentityKey(plan()));
  });

});

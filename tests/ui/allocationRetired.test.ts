/**
 * The allocation card's retirement (2026-08-18: the user executed the
 * reallocation for real, so the what-if section came off the Plan card).
 * Three properties protect what must NOT retire with it:
 *
 * 1. THE EVENT TYPE SURVIVES END TO END. Old saved scenarios carry
 *    allocation_change / glidepath events and must keep parsing and running.
 * 2. NOTHING BECOMES AN INVISIBLE KNOB. A whole-portfolio allocation event's
 *    only editor was the removed section; if no surface showed it, a mix
 *    would silently steer every simulated year. It now renders as a
 *    READ-ONLY row in the Additional-events list — named, dated, uneditable.
 * 3. THE PLAN CARD ROUND-TRIPS IT. readPlan/writePlan still own the event, so
 *    changing a retirement age must not destroy an allocation event the plan
 *    happens to carry.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseOrThrow, scenarioSchema } from '../../src/shared/schemas';
import type { Person, Scenario, ScenarioEvent } from '../../src/shared/types';
import {
  isPlanOwnedEvent,
  readPlan,
  writePlan,
} from '../../src/ui/components/scenarios/scenarioHelpers';

const read = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const planCard = read('../../src/ui/components/scenarios/PlanCard.tsx');
const eventsCard = read('../../src/ui/components/scenarios/EventsCard.tsx');

const PEOPLE: Person[] = [
  {
    id: 'p1',
    name: 'P1',
    birthYear: 1971,
    birthMonth: 6,
    piaMonthlyAtFraIfWorkingTo62: 2900,
    piaMonthlyAtFraIfStoppingNow: 2600,
    hasOwnBenefit: true,
  },
];

/** The exact event the user's plan.json carried until the migration. */
const LEGACY_ALLOCATION: ScenarioEvent = {
  type: 'allocation_change',
  date: '2026-06',
  mix: { stocks: 0.6, bonds: 0.4, bills: 0 },
};

describe('the event type survives end to end', () => {
  it('a saved scenario with a whole-portfolio allocation_change still parses', () => {
    const scenario: Scenario = parseOrThrow(
      scenarioSchema,
      { name: 'legacy', events: [LEGACY_ALLOCATION] },
      'scenario',
    );
    expect(scenario.events).toEqual([LEGACY_ALLOCATION]);
  });

  it('writePlan round-trips an allocation event a knob turn never touched', () => {
    const events: ScenarioEvent[] = [
      { type: 'retire', person: 'p1', date: '2028-06' },
      LEGACY_ALLOCATION,
    ];
    // A retire-age change goes readPlan → mutate → writePlan, exactly as the
    // card commits. The allocation decision rides along unchanged.
    const plan = readPlan(events, PEOPLE);
    const rewritten = writePlan(events, { ...plan, claimDate: '2038-06' }, PEOPLE);
    expect(rewritten).toContainEqual(LEGACY_ALLOCATION);
    // Still plan-owned: writePlan must keep replacing it rather than
    // duplicating it on every commit.
    expect(isPlanOwnedEvent(LEGACY_ALLOCATION)).toBe(true);
  });
});

describe('nothing becomes an invisible knob (source scan)', () => {
  it('the Plan card no longer offers the allocation what-if', () => {
    // The string survives in the header comment as history; what must be gone
    // is the rendered section carrying it as a title.
    expect(planCard).not.toContain('title="When the allocation changes"');
    expect(planCard).not.toContain('AllocationSection');
    // The bond dial deliberately survives — it is a market assumption, not
    // the retired what-if.
    expect(planCard).toContain('<BondsAreSelect');
    // The header tooltip counts what the card now presents: TWO decisions
    // (stop working, claim). "Three" was the retired section still talking.
    expect(planCard).toContain('These two decisions');
    expect(planCard).not.toContain('These three decisions');
  });

  it('the events list shows a whole-portfolio allocation event, read-only', () => {
    // The row filter re-admits what isPlanOwnedEvent hides…
    expect(eventsCard).toContain('isLegacyAllocation(event)');
    expect(eventsCard).toMatch(/!isPlanOwnedEvent\(event\) \|\| isLegacyAllocation\(event\)/);
    // …and renders it without Edit/Delete: the Raw JSON editor is the only
    // editor, on purpose.
    expect(eventsCard).toContain('read-only');
    expect(eventsCard).toMatch(/isLegacyAllocation\(event\) \? \(/);
  });

  it('account-targeted allocation events keep their ordinary editor', () => {
    // Only account === undefined is the retired whole-portfolio decision; a
    // targeted event (a single fund's own glide) was always an additional
    // event and must stay editable.
    expect(eventsCard).toMatch(/event\.account === undefined/);
  });
});

/**
 * The PLAN's facts a profile module needs for context, read once and never
 * written (the same read the retired ProfilePage did): the profile has no
 * retirement date — a PLAN decides when work stops — so the Insurance
 * module's term notes and the Expenses module's renting column both price
 * windows the plan owns. A failed read leaves both empty/undefined and the
 * notes degrade to speaking hypothetically, which is the honest answer
 * either way.
 */
import { useEffect, useState } from 'react';
import type { HousingPlan, ScenarioEvent } from '../../shared/types';
import { api } from '../api';

export function usePlanFacts(): {
  planEvents: ScenarioEvent[];
  planHousing: HousingPlan | undefined;
} {
  const [planEvents, setPlanEvents] = useState<ScenarioEvent[]>([]);
  const [planHousing, setPlanHousing] = useState<HousingPlan | undefined>(undefined);

  useEffect(() => {
    api.getPlan().then(
      (plan) => {
        setPlanEvents(plan.events);
        setPlanHousing(plan.housing);
      },
      () => {
        setPlanEvents([]);
        setPlanHousing(undefined);
      },
    );
  }, []);

  return { planEvents, planHousing };
}

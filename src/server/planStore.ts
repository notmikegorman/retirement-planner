/**
 * The plan store's NODE FACE. The plan file, the daily guard and the restore
 * flow moved whole to src/store/planStore.ts in Phase 3 of the browser port
 * (see that header for every WHY); this module binds them to the real data
 * folder and keeps the historical export surface.
 */
import { stores } from './stores';

export { PLAN_NAME, defaultPlanScenario } from '../store/planStore';

const plan = stores.plan;

/** See src/store/planStore.ts (loadPlan). */
export const loadPlan: typeof plan.loadPlan = plan.loadPlan;
/** See src/store/planStore.ts (savePlan — the daily guard's one door). */
export const savePlan: typeof plan.savePlan = plan.savePlan;
/** See src/store/planStore.ts (restorePlan). */
export const restorePlan: typeof plan.restorePlan = plan.restorePlan;

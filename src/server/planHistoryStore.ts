/**
 * The plan-history store's NODE FACE. The history file, the daily-guard
 * append, the keep flow and the score-attach rules moved whole to
 * src/store/planHistoryStore.ts in Phase 3 of the browser port (see that
 * header for every WHY); this module binds them to the real data folder and
 * keeps the historical export surface.
 */
import { stores } from './stores';

export { localDayKey, planHash, type PlanHistoryScoreWrite } from '../store/planHistoryStore';

const history = stores.planHistory;

/** See src/store/planHistoryStore.ts (listPlanHistory). */
export const listPlanHistory: typeof history.listPlanHistory = history.listPlanHistory;
/** See src/store/planHistoryStore.ts (getPlanHistoryEntry). */
export const getPlanHistoryEntry: typeof history.getPlanHistoryEntry = history.getPlanHistoryEntry;
/** See src/store/planHistoryStore.ts (recordDayStart — the daily guard). */
export const recordDayStart: typeof history.recordDayStart = history.recordDayStart;
/** See src/store/planHistoryStore.ts (keepPlan). */
export const keepPlan: typeof history.keepPlan = history.keepPlan;
/** See src/store/planHistoryStore.ts (attachPlanHistoryScore). */
export const attachPlanHistoryScore: typeof history.attachPlanHistoryScore =
  history.attachPlanHistoryScore;
/** See src/store/planHistoryStore.ts (attachPlanHistorySpend). */
export const attachPlanHistorySpend: typeof history.attachPlanHistorySpend =
  history.attachPlanHistorySpend;

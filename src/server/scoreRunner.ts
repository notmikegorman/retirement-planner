/**
 * The score runner's NODE FACE. The scoring logic — SCORE_MODE, the poll
 * loop, the 20-minute deadline, the max-spend bisection's two non-answers —
 * moved whole to src/store/scoreRunner.ts in Phase 4 of the browser port
 * (see that header for every WHY); this module binds it to the node stores
 * and the node run manager and keeps the historical export surface.
 */
import type { Scenario } from '../shared/types';
import {
  type ScoreAttempt,
  type ScoringDeps,
  type SpendAttempt,
} from '../store/scoreRunner';
import { services } from './services';

export {
  SCORE_MODE,
  message,
  planForScoring,
  type ScoreAttempt,
  type ScoringDeps,
  type SpendAttempt,
} from '../store/scoreRunner';

/**
 * The real deps: the node run manager's startRun/getRun, the real clock.
 * Built from the ONE composed service set, so the scorers poll the same
 * registry the routes report from.
 */
export const REAL_SCORING_DEPS: ScoringDeps = services.scoringDeps;

/** See src/store/scoreRunner.ts (scorePlan). */
export const scorePlan: (plan: Scenario, deps: ScoringDeps) => Promise<ScoreAttempt> =
  services.scoreRunner.scorePlan;
/** See src/store/scoreRunner.ts (solveSustainableSpend). */
export const solveSustainableSpend: (
  plan: Scenario,
  deps: ScoringDeps,
) => Promise<SpendAttempt> = services.scoreRunner.solveSustainableSpend;

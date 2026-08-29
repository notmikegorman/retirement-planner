/**
 * The plan-version scorer's NODE FACE. The on-demand scoring flow — the
 * refuse-before-spending-minutes 409, the fill-a-blank-never-overwrite rule,
 * the in-flight registry — moved whole to src/store/planHistoryScorer.ts in
 * Phase 4 of the browser port (see that header for every WHY); this module
 * binds it to the node stores and run manager and keeps the historical
 * export surface.
 */
import type { ScoringDeps } from '../store/scoreRunner';
import type { VersionScoringOutcome } from '../store/planHistoryScorer';
import { services } from './services';

export type { VersionScoringOutcome } from '../store/planHistoryScorer';

const scorer = services.planHistoryScorer;

/** See src/store/planHistoryScorer.ts (versionsBeingScored). */
export const versionsBeingScored: () => string[] = scorer.versionsBeingScored;
/** See src/store/planHistoryScorer.ts (startVersionScoring). */
export const startVersionScoring: (
  id: string,
  deps?: ScoringDeps,
) => Promise<VersionScoringOutcome> = scorer.startVersionScoring;
/** See src/store/planHistoryScorer.ts (scorePlanVersion). */
export const scorePlanVersion: (
  id: string,
  deps?: ScoringDeps,
) => Promise<{ ok: true; scoring: boolean }> = scorer.scorePlanVersion;

/**
 * The snapshot scorer's NODE FACE. The scoring flow — row first, score
 * attached later or never, the two-phase attach, the in-flight registry, the
 * scored-once rule — moved whole to src/store/snapshotScorer.ts in Phase 4 of
 * the browser port (see that header for every WHY); this module binds it to
 * the node stores and run manager and keeps the historical export surface.
 */
import type { ScoringDeps } from '../store/scoreRunner';
import type { ScoringOutcome } from '../store/snapshotScorer';
import { services } from './services';

export type { ScoringDeps } from '../store/scoreRunner';
export type { ScoringOutcome } from '../store/snapshotScorer';

const scorer = services.snapshotScorer;

/** See src/store/snapshotScorer.ts (snapshotsBeingScored). */
export const snapshotsBeingScored: () => string[] = scorer.snapshotsBeingScored;
/** See src/store/snapshotScorer.ts (startScoring). */
export const startScoring: (
  snapshotId: string,
  deps?: ScoringDeps,
) => Promise<ScoringOutcome> = scorer.startScoring;

/**
 * The scoring-intent machinery's NODE FACE. The write-ahead intent file, the
 * boot healer and the Finish front door all live in the shared core
 * (src/store/scoringIntent.ts + src/store/services.ts — see those headers for
 * every WHY, including the Aug-20 incident this closes); this module binds
 * them to the node services instance for server.ts and the tests.
 */
import type { InterruptedScoring, ScoringTargetKind } from '../shared/types';
import { services } from './services';

const service = services.scoringIntents;

/** See src/store/scoringIntent.ts (healScoringIntents). Called at boot. */
export const healScoringIntents: () => Promise<void> = service.heal;
/** See src/store/services.ts (ScoringIntentsService.list). */
export const listScoringIntents: () => Promise<InterruptedScoring[]> = service.list;
/** See src/store/services.ts (ScoringIntentsService.finish). */
export const finishScoring: (t: {
  kind: ScoringTargetKind;
  id: string;
}) => Promise<{ ok: true; scoring: true }> = service.finish;

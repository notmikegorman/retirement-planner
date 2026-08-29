/**
 * The slim score cache's NODE FACE. The store itself — the SearchScore shape,
 * scoreFromResult, and the read/write pair over a FileStore — moved whole to
 * src/store/search/scoreStore.ts in Phase 5 of the browser port, where it is
 * environment-neutral (the browser coordinator persists the very same records
 * through the very same code). This module binds one instance to THE data
 * folder and re-exports every name this path always exported, so the pool,
 * the worker and the tests keep one import path and identical behaviour.
 */
import path from 'node:path';
import { getDataDir } from '../dataStore';
import { dataFiles } from '../fileStore';
import {
  SCORES_DIR,
  createScoreStore,
  type SearchScore,
} from '../../store/search/scoreStore';

export { scoreFromResult, type SearchScore } from '../../store/search/scoreStore';

/**
 * ABSOLUTE path of the score-cache directory, kept because callers outside
 * the seam (tests, tooling) locate the cache with it. Store IO below speaks
 * data-dir-relative paths like everything else behind the seam.
 */
export function scoresDir(): string {
  return path.join(getDataDir(), ...SCORES_DIR.split('/'));
}

const store = createScoreStore(dataFiles);

/** See src/store/search/scoreStore.ts (readScore). */
export const readScore: (runKey: string) => Promise<SearchScore | null> = store.readScore;
/** See src/store/search/scoreStore.ts (writeScore). */
export const writeScore: (score: SearchScore) => Promise<void> = store.writeScore;

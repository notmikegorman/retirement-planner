/**
 * The data store's NODE FACE. The logic — seeding, backfills, the giving-split
 * pass, profile/quotes/assumptions load and save — moved whole to
 * src/store/dataStore.ts in Phase 3 of the browser port, where it is
 * environment-neutral and runs against either driver. This module binds that
 * logic to the real folders (src/server/stores.ts) and re-exports every name
 * this path always exported, so the server, the scorers, the golden harness
 * and the tests keep one import path and identical behaviour.
 *
 * If you are looking for the WHY of any function here, it is on the function
 * in src/store/dataStore.ts — moved, not rewritten.
 */
import { stores } from './stores';

// The one place the data folder's location is decided stays fileStore.ts
// (the driver needs it and must not depend on this module); re-exported here
// so its many existing importers keep one import path.
export { getDataDir } from './fileStore';

// The error taxonomy and the pure migrations live with the neutral logic.
export {
  ConflictError,
  NotFoundError,
  ValidationError,
  migrateProfile,
  migrateScenarioGivingInPlace,
} from '../store/dataStore';

const data = stores.data;

/** See src/store/dataStore.ts (describeDataFile). */
export const describeDataFile: (relPath: string) => string = data.describeDataFile;
/** See src/store/dataStore.ts (pathExists). */
export const pathExists: (relPath: string) => Promise<boolean> = data.pathExists;
/** See src/store/dataStore.ts (readJsonFile). */
export const readJsonFile: (relPath: string) => Promise<unknown> = data.readJsonFile;
/** See src/store/dataStore.ts (writeJsonPretty). */
export const writeJsonPretty: (relPath: string, value: unknown) => Promise<void> =
  data.writeJsonPretty;
/** See src/store/dataStore.ts (initDataDir). */
export const initDataDir: typeof data.initDataDir = data.initDataDir;
/** See src/store/dataStore.ts (backfillAssumptionDefaults). */
export const backfillAssumptionDefaults: typeof data.backfillAssumptionDefaults =
  data.backfillAssumptionDefaults;
/** See src/store/dataStore.ts (migrateGivingSplitFiles). */
export const migrateGivingSplitFiles: typeof data.migrateGivingSplitFiles =
  data.migrateGivingSplitFiles;
/** See src/store/dataStore.ts (loadProfile). */
export const loadProfile: typeof data.loadProfile = data.loadProfile;
/** See src/store/dataStore.ts (saveProfile). */
export const saveProfile: typeof data.saveProfile = data.saveProfile;
/** See src/store/dataStore.ts (loadQuotes). */
export const loadQuotes: typeof data.loadQuotes = data.loadQuotes;
/** See src/store/dataStore.ts (saveQuotes). */
export const saveQuotes: typeof data.saveQuotes = data.saveQuotes;
/** See src/store/dataStore.ts (loadResolvedProfile). */
export const loadResolvedProfile: typeof data.loadResolvedProfile = data.loadResolvedProfile;
/** See src/store/dataStore.ts (loadAssumptions). */
export const loadAssumptions: typeof data.loadAssumptions = data.loadAssumptions;
/** See src/store/dataStore.ts (saveMarket). */
export const saveMarket: typeof data.saveMarket = data.saveMarket;

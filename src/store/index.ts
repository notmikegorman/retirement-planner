/**
 * The store layer, composed: one call wires the data store and every record
 * store to a pair of FileStores. Both environments go through this same
 * function —
 *
 *   - src/server/stores.ts binds it to node:fs (the FPLAN_DATA_DIR folder and
 *     <repoRoot>/data-defaults) and re-exports the instance methods under the
 *     exact module surface the server and its 300+ tests always had;
 *   - the browser binds it to a FileSystemDirectoryHandle driver (the picked
 *     folder / OPFS) and a memory store of bundled defaults.
 *
 * One composition function rather than per-module wiring at every call site,
 * because the stores reference EACH OTHER (planStore's guard writes through
 * planHistoryStore) and two half-wired instances pointing at different
 * folders would be a corruption generator with a green typecheck.
 */
import { createDataStore, type DataStore, type DataStoreOptions } from './dataStore';
import { createNetworthStore, type NetworthStore } from './networthStore';
import { createPlanHistoryStore, type PlanHistoryStore } from './planHistoryStore';
import { createPlanStore, type PlanStore } from './planStore';
import { createQuoteService, type QuoteService } from './quotes';

export interface Stores {
  data: DataStore;
  planHistory: PlanHistoryStore;
  plan: PlanStore;
  networth: NetworthStore;
  quotes: QuoteService;
}

export function createStores(opts: DataStoreOptions): Stores {
  const data = createDataStore(opts);
  const planHistory = createPlanHistoryStore(data);
  const plan = createPlanStore(data, planHistory);
  const networth = createNetworthStore(data);
  const quotes = createQuoteService(data);
  return { data, planHistory, plan, networth, quotes };
}

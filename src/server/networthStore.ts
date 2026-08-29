/**
 * The net-worth store's NODE FACE. The ledger, its serialized chain and the
 * attach-once rules moved whole to src/store/networthStore.ts in Phase 3 of
 * the browser port (see that header for every WHY); this module binds them to
 * the real data folder and keeps the historical export surface.
 */
import { stores } from './stores';

export type { SnapshotScoreWrite } from '../store/networthStore';

const networth = stores.networth;

/** See src/store/networthStore.ts (listSnapshots). */
export const listSnapshots: typeof networth.listSnapshots = networth.listSnapshots;
/** See src/store/networthStore.ts (takeSnapshot). */
export const takeSnapshot: typeof networth.takeSnapshot = networth.takeSnapshot;
/** See src/store/networthStore.ts (deleteSnapshot). */
export const deleteSnapshot: typeof networth.deleteSnapshot = networth.deleteSnapshot;
/** See src/store/networthStore.ts (attachScore). */
export const attachScore: typeof networth.attachScore = networth.attachScore;
/** See src/store/networthStore.ts (attachSustainableSpend). */
export const attachSustainableSpend: typeof networth.attachSustainableSpend =
  networth.attachSustainableSpend;

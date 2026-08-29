/**
 * The service layer, composed: one call wires the run manager, the score
 * runner, both scorers and the write-ahead scoring-intent machinery to a
 * store set and an execution seam. The sibling of createStores (./index.ts),
 * one layer up —
 *
 *   - src/server/services.ts binds it to the node stores and a worker_threads
 *     executor, and the node faces re-export the instance methods under the
 *     exact module surface the server and its tests always had;
 *   - the browser's local backend binds it to the picked-folder/OPFS stores
 *     and the reusable Web Worker executor.
 *
 * One composition function for the same reason createStores is one: the
 * services reference EACH OTHER (both scorers poll through the one run
 * manager's registry, and their ScoringDeps must be built from THAT instance,
 * not a second one with an empty registry) — two half-wired instances would
 * poll a manager that never heard of their runs, and every score would
 * "disappear before it produced a result". The same argument pins the intent
 * machinery here: the recorded runKeys come from THIS run manager's resolver,
 * and both scorers share ONE intent store over ONE folder.
 */
import type { InterruptedScoring, ScoringTargetKind } from '../shared/types';
import { NotFoundError } from './dataStore';
import type { Stores } from './index';
import { createPlanHistoryScorer, type PlanHistoryScorer } from './planHistoryScorer';
import { createRunManager, type RunExecutor, type RunManager } from './runManager';
import {
  createScoreRunner,
  realScoringDeps,
  type ScoreRunner,
  type ScoringDeps,
} from './scoreRunner';
import {
  createScoringIntentStore,
  healScoringIntents,
  type ScoringIntentStore,
} from './scoringIntent';
import { createSnapshotScorer, type SnapshotScorer } from './snapshotScorer';

/**
 * The intent machinery's public face — what the two backends expose as
 * GET /api/scoring/intents and POST /api/scoring/finish, and what each calls
 * once at boot. One implementation here so the healing, the listing and the
 * finish front door cannot drift between the server and the tab.
 */
export interface ScoringIntentsService {
  /**
   * Resolve every orphaned intent, once, at boot — BEFORE the backend serves
   * anything (store/scoringIntent.healScoringIntents has the whole rule).
   */
  heal(): Promise<void>;
  /** The interrupted records still awaiting a Finish/never-finish decision. */
  list(): Promise<InterruptedScoring[]>;
  /**
   * Start finishing one interrupted record; answers immediately, like every
   * scoring start. Throws NotFoundError when no intent names the target — a
   * stale click deserves a sentence, not silence.
   */
  finish(t: { kind: ScoringTargetKind; id: string }): Promise<{ ok: true; scoring: true }>;
}

export interface Services {
  runManager: RunManager;
  scoreRunner: ScoreRunner;
  /** The real deps both scorers default to — built from THIS run manager. */
  scoringDeps: ScoringDeps;
  snapshotScorer: SnapshotScorer;
  planHistoryScorer: PlanHistoryScorer;
  /** The shared write-ahead intent store, for tests and the service below. */
  scoringIntentStore: ScoringIntentStore;
  scoringIntents: ScoringIntentsService;
}

export interface ServicesOptions {
  /**
   * Fired with the TOTAL number of scoring runs in flight (both scorers)
   * whenever it changes. The local backend arms its beforeunload warning
   * through this — exactly while any scoring is in flight, mirroring the
   * search guard's arm/disarm discipline. The node server passes nothing:
   * its process outlives every tab.
   */
  onScoringInFlightChange?: (inFlight: number) => void;
}

export function createServices(
  stores: Stores,
  executor: RunExecutor,
  opts: ServicesOptions = {},
): Services {
  const runManager = createRunManager({ data: stores.data, executor });
  const scoringIntentStore = createScoringIntentStore(stores.data);
  const scoreRunner = createScoreRunner(stores.data, {
    intents: scoringIntentStore,
    resolveRunKey: runManager.resolveRunKey,
  });
  const scoringDeps = realScoringDeps(runManager);

  // The two registries report separately; the guard cares about the sum.
  let snapshotFlights = 0;
  let versionFlights = 0;
  const notifyFlights = (): void => {
    opts.onScoringInFlightChange?.(snapshotFlights + versionFlights);
  };

  const snapshotScorer = createSnapshotScorer({
    networth: stores.networth,
    planHistory: stores.planHistory,
    plan: stores.plan,
    runner: scoreRunner,
    defaultDeps: scoringDeps,
    intents: scoringIntentStore,
    onInFlightChange: (n) => {
      snapshotFlights = n;
      notifyFlights();
    },
  });
  const planHistoryScorer = createPlanHistoryScorer({
    planHistory: stores.planHistory,
    runner: scoreRunner,
    defaultDeps: scoringDeps,
    intents: scoringIntentStore,
    onInFlightChange: (n) => {
      versionFlights = n;
      notifyFlights();
    },
  });

  const scoringIntents: ScoringIntentsService = {
    heal: () =>
      healScoringIntents({
        intents: scoringIntentStore,
        networth: stores.networth,
        planHistory: stores.planHistory,
        plan: stores.plan,
        runner: scoreRunner,
      }),
    list: async () =>
      (await scoringIntentStore.list()).map(({ kind, id, phase, startedAt }) => ({
        kind,
        id,
        phase,
        startedAt,
      })),
    async finish(t) {
      const intent = (await scoringIntentStore.list()).find(
        (i) => i.kind === t.kind && i.id === t.id,
      );
      if (!intent) {
        throw new NotFoundError(
          `No interrupted scoring is recorded for ${
            t.kind === 'snapshot' ? 'snapshot' : 'plan version'
          } "${t.id}" — it may already have been finished or resolved.`,
        );
      }
      // Fire and forget, like every scoring start: the row answers through the
      // in-flight registry ("scoring…") and the record fills in when the
      // simulation lands. finishScoring/finishVersionScoring never reject.
      if (t.kind === 'snapshot') void snapshotScorer.finishScoring(t.id);
      else void planHistoryScorer.finishVersionScoring(t.id);
      return { ok: true as const, scoring: true as const };
    },
  };

  return {
    runManager,
    scoreRunner,
    scoringDeps,
    snapshotScorer,
    planHistoryScorer,
    scoringIntentStore,
    scoringIntents,
  };
}

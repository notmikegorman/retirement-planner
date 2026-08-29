/**
 * THE WRITE-AHEAD SCORING INTENT (src/store/scoringIntent.ts + the scorer/
 * runner wiring): the machinery that turns the Aug-20 class of loss — a
 * process dying between the two halves of a scoring run, permanently costing
 * a record its figure — into an explicit, recoverable state.
 *
 * Everything runs over the COMPOSED services (createServices on memory-driver
 * stores with a fake executor), not over mocks of the intent store: the
 * property under test is precisely that the recorded runKey is THE runKey the
 * run manager computes, that the intent is on disk before a simulation
 * starts, and that every terminal path clears it. A mock could agree with
 * itself and prove nothing.
 *
 * The three-state claim (browser-port plan, Phase 6 gate): after any
 * interruption, a record is provably in exactly one of — fully scored,
 * completable-from-intent (Interrupted + Finish), or explicitly unmeasured
 * with the reason. No fourth state.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';
import type { RunResult, Scenario, SimulationInput } from '../../src/shared/types';
import {
  createMemoryFileStore,
  seedMemoryFileStore,
  type MemoryFileStore,
} from '../../src/shared/memoryFileStore';
import { createStores, type Stores } from '../../src/store';
import { NotFoundError } from '../../src/store/dataStore';
import type { RunExecutor } from '../../src/store/runManager';
import {
  scoreRunRequest,
  spendRunRequest,
  type ScoringDeps,
} from '../../src/store/scoreRunner';
import {
  SCORING_INTENT_FILE,
  createScoringIntentStore,
  inputsMovedReason,
  type ScoringIntent,
} from '../../src/store/scoringIntent';
import { createServices, type Services } from '../../src/store/services';
import { createSnapshotScorer } from '../../src/store/snapshotScorer';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const defaultsDir = path.join(repoRoot, 'data-defaults');

/** data-defaults as a memory store — the browser's bundled-defaults shape. */
async function memoryDefaults(): Promise<MemoryFileStore> {
  const store = createMemoryFileStore('(bundled defaults)');
  const manifest: Record<string, Uint8Array> = {};
  async function walk(rel: string): Promise<void> {
    for (const entry of await fs.readdir(path.join(defaultsDir, rel), { withFileTypes: true })) {
      const childRel = rel === '' ? entry.name : `${rel}/${entry.name}`;
      if (entry.isDirectory()) await walk(childRel);
      else manifest[childRel] = new Uint8Array(await fs.readFile(path.join(defaultsDir, childRel)));
    }
  }
  await walk('');
  await seedMemoryFileStore(store, manifest);
  return store;
}

const PLAN: Scenario = {
  name: 'Plan',
  events: [{ type: 'retire', person: 'p1', date: '2031-07' }],
};

const EDITED: Scenario = {
  name: 'Plan',
  events: [{ type: 'retire', person: 'p1', date: '2027-01' }],
};

function finished(over: Partial<RunResult> = {}): RunResult {
  return {
    success: 0.941,
    medianTerminalReal: 3_100_000,
    meta: { engineVersion: '1.21.0', mode: 'montecarlo', paths: 10_000, seed: 12_345 },
    ...over,
  } as unknown as RunResult;
}

function solved(): RunResult {
  return finished({
    solverOutput: {
      spec: { type: 'max_spend' },
      points: [],
      answer: 118_000,
      answerLabel: 'x',
    },
  } as unknown as Partial<RunResult>);
}

/**
 * One composed world per test: memory folder, real stores, real services, an
 * executor whose behaviour each test scripts. `gates` lets a test hold a run
 * open to look at the world mid-flight — the closest an in-process test gets
 * to "the tab is about to die here".
 */
interface World {
  stores: Stores;
  services: Services;
  deps: ScoringDeps;
  executorCalls: SimulationInput[];
  flights: number[];
  /** Swap what the executor does; default resolves immediately. */
  setExecutor(run: RunExecutor['run']): void;
  intentFileExists(): Promise<boolean>;
  readIntents(): Promise<ScoringIntent[]>;
  /** Re-compose services over the SAME folder — "the app reopened". */
  reboot(): Promise<World>;
}

async function makeWorld(
  files?: MemoryFileStore,
  defaults?: MemoryFileStore,
): Promise<World> {
  const dataFiles = files ?? createMemoryFileStore('(memory data folder)');
  const defaultStore = defaults ?? (await memoryDefaults());
  const executorCalls: SimulationInput[] = [];
  const flights: number[] = [];
  let runImpl: RunExecutor['run'] = async (input) =>
    input.scenario.solver ? solved() : finished();
  const executor: RunExecutor = {
    run: (input, onProgress) => {
      executorCalls.push(input);
      return runImpl(input, onProgress);
    },
  };
  const stores = createStores({ files: dataFiles, defaults: defaultStore });
  const services = createServices(stores, executor, {
    onScoringInFlightChange: (n) => flights.push(n),
  });
  if (files === undefined) await stores.data.initDataDir();
  const deps: ScoringDeps = {
    startRun: services.runManager.startRun,
    getRun: services.runManager.getRun,
    wait: async () => undefined,
    now: () => new Date('2026-08-29T10:00:00.000Z'),
  };
  return {
    stores,
    services,
    deps,
    executorCalls,
    flights,
    setExecutor: (run) => {
      runImpl = run;
    },
    intentFileExists: () => dataFiles.exists(SCORING_INTENT_FILE),
    readIntents: async () =>
      JSON.parse(await dataFiles.readText(SCORING_INTENT_FILE)) as ScoringIntent[],
    reboot: () => makeWorld(dataFiles, defaultStore),
  };
}

let w: World;
beforeEach(async () => {
  w = await makeWorld();
  await w.stores.plan.savePlan(PLAN, new Date('2026-08-29T08:00:00.000Z'));
});

/** A real plan-version target: PLAN, filed the way a kept finalist is. */
async function keptVersionId(): Promise<string> {
  return (await w.stores.planHistory.keepPlan(PLAN, 'kept', new Date('2026-08-29T08:05:00.000Z')))
    .id;
}

async function snapshotRow(): Promise<string> {
  const row = await w.stores.networth.takeSnapshot({ homeValue: 550_000 });
  return row.id;
}

/** What an interrupted 'score' phase leaves on disk, without dying mid-test. */
async function orphanScoreIntent(id: string, kind: 'snapshot' | 'plan-version', plan = PLAN) {
  const profile = await w.stores.data.loadProfile();
  const runKey = await w.services.runManager.resolveRunKey(scoreRunRequest(plan, profile));
  const intents = createScoringIntentStore(w.stores.data);
  await intents.record({
    kind,
    id,
    phase: 'score',
    runKey,
    startedAt: '2026-08-29T09:00:00.000Z',
  });
  return runKey;
}

/** What an interrupted 'spend' phase leaves: the score attached, the rest lost. */
async function orphanSpendIntent(id: string, kind: 'snapshot' | 'plan-version', plan = PLAN) {
  const profile = await w.stores.data.loadProfile();
  const runKey = await w.services.runManager.resolveRunKey(spendRunRequest(plan, profile));
  const intents = createScoringIntentStore(w.stores.data);
  await intents.record({
    kind,
    id,
    phase: 'spend',
    runKey,
    startedAt: '2026-08-29T09:00:00.000Z',
  });
  return runKey;
}

const SCORE = {
  success: 0.941,
  mode: 'montecarlo' as const,
  paths: 10_000,
  seed: 12_345,
  engineVersion: '1.21.0',
  scoredAt: '2026-08-29T09:00:00.000Z',
};

// ---------------------------------------------------------------------------
// The store itself
// ---------------------------------------------------------------------------

describe('the intent store', () => {
  it('records, upserts by record, clears, and deletes the file when empty', async () => {
    const intents = w.services.scoringIntentStore;
    await intents.record({ kind: 'snapshot', id: 'a', phase: 'score', runKey: 'f'.repeat(64), startedAt: 't1' });
    await intents.record({ kind: 'plan-version', id: 'a', phase: 'score', runKey: 'e'.repeat(64), startedAt: 't2' });
    // Same id, different KIND: two records, not one — the target is the pair.
    expect(await intents.list()).toHaveLength(2);

    // Upsert: the phase boundary rewrites the same record's intent in place.
    await intents.record({ kind: 'snapshot', id: 'a', phase: 'spend', runKey: 'd'.repeat(64), startedAt: 't3' });
    const all = await intents.list();
    expect(all).toHaveLength(2);
    expect(all.find((i) => i.kind === 'snapshot')?.phase).toBe('spend');

    await intents.clear({ kind: 'snapshot', id: 'a' });
    expect(await intents.list()).toHaveLength(1);
    await intents.clear({ kind: 'plan-version', id: 'a' });
    // ABSENT, not empty: the dual-stack gate asserts the file gone from
    // finished trees, and an empty stub would fail it.
    expect(await w.intentFileExists()).toBe(false);
  });

  it('treats a torn file as empty and removes it — never worse than pre-intent behaviour', async () => {
    await w.stores.data.files.writeText(SCORING_INTENT_FILE, '{"half": ');
    const intents = createScoringIntentStore(w.stores.data, () => undefined);
    expect(await intents.list()).toEqual([]);
    expect(await w.intentFileExists()).toBe(false);
  });

  it('rejects a parseable file that fails the schema, loudly enough to log, quietly enough to boot', async () => {
    await w.stores.data.files.writeText(
      SCORING_INTENT_FILE,
      `${JSON.stringify([{ kind: 'snapshot', id: 'a', phase: 'later', runKey: 'x', startedAt: 't' }])}\n`,
    );
    const logged: string[] = [];
    const intents = createScoringIntentStore(w.stores.data, (m) => logged.push(m));
    expect(await intents.list()).toEqual([]);
    expect(logged.join('\n')).toContain('Discarding');
  });
});

// ---------------------------------------------------------------------------
// The lifecycle: written before the run, phase-advanced, cleared after
// ---------------------------------------------------------------------------

describe('the write-ahead lifecycle around a snapshot scoring', () => {
  it('is on disk with the right phase and runKey BEFORE each run, and gone after both attaches', async () => {
    const id = await snapshotRow();
    const seen: { phase: string; runKey: string; solver: boolean }[] = [];
    w.setExecutor(async (input) => {
      // The moment a simulation starts is the moment a kill becomes a loss —
      // so THIS is where the intent must already be readable.
      const onDisk = await w.readIntents();
      expect(onDisk).toHaveLength(1);
      seen.push({
        phase: onDisk[0].phase,
        runKey: onDisk[0].runKey,
        solver: input.scenario.solver !== undefined,
      });
      return input.scenario.solver ? solved() : finished();
    });

    const outcome = await w.services.snapshotScorer.startScoring(id, w.deps);
    expect(outcome.status).toBe('scored');

    const profile = await w.stores.data.loadProfile();
    expect(seen).toEqual([
      {
        phase: 'score',
        runKey: await w.services.runManager.resolveRunKey(scoreRunRequest(PLAN, profile)),
        solver: false,
      },
      {
        phase: 'spend',
        runKey: await w.services.runManager.resolveRunKey(spendRunRequest(PLAN, profile)),
        solver: true,
      },
    ]);
    // Cleared only after BOTH attaches: the finished tree carries no intent.
    expect(await w.intentFileExists()).toBe(false);
  });

  it('clears the intent when the run fails — a recorded failure is an outcome', async () => {
    const id = await snapshotRow();
    w.setExecutor(async () => {
      throw new Error('worker died');
    });
    const outcome = await w.services.snapshotScorer.startScoring(id, w.deps);
    expect(outcome.status).toBe('failed');
    const [row] = await w.stores.networth.listSnapshots();
    expect(row.scoreError).toContain('worker died');
    expect(await w.intentFileExists()).toBe(false);
  });

  it('clears the intent when the row vanished mid-run — the score belongs to nothing', async () => {
    const id = await snapshotRow();
    w.setExecutor(async (input) => {
      // The user deletes the row while its simulation runs.
      if (input.scenario.solver === undefined) await w.stores.networth.deleteSnapshot(id);
      return input.scenario.solver ? solved() : finished();
    });
    const outcome = await w.services.snapshotScorer.startScoring(id, w.deps);
    expect(outcome.status).toBe('row_gone');
    expect(await w.intentFileExists()).toBe(false);
  });

  it('arms and disarms the in-flight hook exactly around the work — the unload guard seam', async () => {
    const id = await snapshotRow();
    w.flights.length = 0;
    await w.services.snapshotScorer.startScoring(id, w.deps);
    expect(w.flights[0]).toBe(1);
    expect(w.flights.at(-1)).toBe(0);
  });

  it('a version scoring writes plan-version intents through the same runner path', async () => {
    const id = await keptVersionId();
    const phases: string[] = [];
    w.setExecutor(async (input) => {
      phases.push((await w.readIntents())[0].phase);
      return input.scenario.solver ? solved() : finished();
    });
    const outcome = await w.services.planHistoryScorer.startVersionScoring(id, w.deps);
    expect(outcome.status).toBe('scored');
    expect(phases).toEqual(['score', 'spend']);
    expect(await w.intentFileExists()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Boot healing — the orphan matrix
// ---------------------------------------------------------------------------

describe('healing on boot: every orphan resolves to one of three states', () => {
  it('keeps a completable score-phase intent and lists it — Interrupted, Finish on offer', async () => {
    const id = await snapshotRow();
    await orphanScoreIntent(id, 'snapshot');

    const w2 = await w.reboot();
    await w2.services.scoringIntents.heal();

    expect(await w2.services.scoringIntents.list()).toEqual([
      { kind: 'snapshot', id, phase: 'score', startedAt: '2026-08-29T09:00:00.000Z' },
    ]);
    // And the row is untouched: no stamp, no score — the decision is the
    // owner's button, never the healer's (D4).
    const [row] = await w2.stores.networth.listSnapshots();
    expect(row.score).toBeUndefined();
    expect(row.scoreError).toBeUndefined();
  });

  it('stamps a score-phase intent whose inputs moved, with the honest reason, and clears it', async () => {
    const id = await snapshotRow();
    await orphanScoreIntent(id, 'snapshot');
    // The world moves: the plan is edited before the app reopens.
    await w.stores.plan.savePlan(EDITED, new Date('2026-08-29T09:30:00.000Z'));

    const w2 = await w.reboot();
    await w2.services.scoringIntents.heal();

    const [row] = await w2.stores.networth.listSnapshots();
    expect(row.scoreError).toBe(inputsMovedReason('score'));
    expect(row.score).toBeUndefined();
    expect(await w2.services.scoringIntents.list()).toEqual([]);
    expect(await w2.intentFileExists()).toBe(false);
  });

  it('keeps a completable spend-phase intent — the Aug-20 shape, now finishable', async () => {
    const id = await snapshotRow();
    await w.stores.networth.attachScore(id, { score: SCORE });
    await orphanSpendIntent(id, 'snapshot');

    const w2 = await w.reboot();
    await w2.services.scoringIntents.heal();

    expect((await w2.services.scoringIntents.list()).map((i) => i.id)).toEqual([id]);
    const [row] = await w2.stores.networth.listSnapshots();
    expect(row.score?.success).toBe(0.941);
    expect(row.score?.sustainableSpend).toBeUndefined();
    expect(row.score?.sustainableSpendError).toBeUndefined();
  });

  it('stamps a moved spend-phase intent onto the spend slot — the probability stands', async () => {
    const id = await snapshotRow();
    await w.stores.networth.attachScore(id, { score: SCORE });
    await orphanSpendIntent(id, 'snapshot');
    await w.stores.plan.savePlan(EDITED, new Date('2026-08-29T09:30:00.000Z'));

    const w2 = await w.reboot();
    await w2.services.scoringIntents.heal();

    const [row] = await w2.stores.networth.listSnapshots();
    expect(row.score?.success).toBe(0.941);
    expect(row.score?.sustainableSpendError).toBe(inputsMovedReason('spend'));
    expect(await w2.intentFileExists()).toBe(false);
  });

  it('clears an intent whose record is already complete — a race the design allows', async () => {
    const id = await snapshotRow();
    await w.services.snapshotScorer.startScoring(id, w.deps); // fully scored
    await orphanSpendIntent(id, 'snapshot'); // a stale leftover reappears (sync, crash timing)

    const w2 = await w.reboot();
    await w2.services.scoringIntents.heal();
    expect(await w2.intentFileExists()).toBe(false);
    const [row] = await w2.stores.networth.listSnapshots();
    expect(row.score?.sustainableSpend).toBe(118_000);
  });

  it('clears an intent whose record is gone', async () => {
    const id = await snapshotRow();
    await orphanScoreIntent(id, 'snapshot');
    await w.stores.networth.deleteSnapshot(id);

    const w2 = await w.reboot();
    await w2.services.scoringIntents.heal();
    expect(await w2.intentFileExists()).toBe(false);
  });

  it('heals plan-version intents identically — both kinds, one healer', async () => {
    const id = await keptVersionId();
    await orphanScoreIntent(id, 'plan-version');

    const w2 = await w.reboot();
    await w2.services.scoringIntents.heal();
    expect(await w2.services.scoringIntents.list()).toEqual([
      { kind: 'plan-version', id, phase: 'score', startedAt: '2026-08-29T09:00:00.000Z' },
    ]);

    // Note the asymmetry that makes 'moved' honest here: the version's PLAN
    // cannot move (it is frozen in the entry) — what moves is the world it
    // would be measured against. Quotes are the usual mover; the plan edit
    // below moves the SNAPSHOT target only, so this intent stays completable.
    await w2.stores.plan.savePlan(EDITED, new Date('2026-08-29T09:40:00.000Z'));
    const w3 = await w2.reboot();
    await w3.services.scoringIntents.heal();
    expect((await w3.services.scoringIntents.list()).map((i) => i.kind)).toEqual([
      'plan-version',
    ]);
  });

  it('reads a moved world for a version through its resolved inputs (a quote-bearing profile)', async () => {
    // Give the profile a priced holding, file a version, orphan its intent,
    // then move the PRICE. The version's plan is frozen; the resolved profile
    // is not — and the runKey covers the resolution, so the intent must read
    // as moved.
    const profile = await w.stores.data.loadProfile();
    const target = profile.accounts.find((a) => a.id === 'brokerage') ?? profile.accounts[0];
    target.holdings = [{ symbol: 'VTI', quantity: 10, assetClass: 'stocks' }];
    await w.stores.data.saveProfile(profile);
    await w.stores.data.saveQuotes({
      VTI: {
        price: 300,
        currency: 'USD',
        asOf: '2026-08-29T13:00:00.000Z',
        source: 'yahoo',
        fetchedAt: '2026-08-29T13:00:00.000Z',
      },
    });
    const id = (await w.stores.planHistory.keepPlan(PLAN, 'kept', new Date('2026-08-29T09:10:00.000Z'))).id;
    await orphanScoreIntent(id, 'plan-version');

    await w.stores.data.saveQuotes({
      VTI: {
        price: 301.5,
        currency: 'USD',
        asOf: '2026-08-29T14:00:00.000Z',
        source: 'yahoo',
        fetchedAt: '2026-08-29T14:00:00.000Z',
      },
    });
    const w2 = await w.reboot();
    await w2.services.scoringIntents.heal();

    const entry = await w2.stores.planHistory.getPlanHistoryEntry(id);
    expect(entry.scoreError).toBe(inputsMovedReason('score'));
    expect(await w2.intentFileExists()).toBe(false);
  });

  it('leaves an unverifiable intent in place — a transient failure must not stamp a permanent verdict', async () => {
    const id = await snapshotRow();
    await orphanScoreIntent(id, 'snapshot');
    // The profile is unreadable this boot (a sync hiccup, a torn write).
    await w.stores.data.files.writeText('profile.json', '{"torn": ');

    const w2 = await w.reboot();
    await w2.services.scoringIntents.heal();

    expect(await w2.intentFileExists()).toBe(true);
    const [row] = await w2.stores.networth.listSnapshots();
    expect(row.scoreError).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Finish — the one-click completion (decision D4)
// ---------------------------------------------------------------------------

describe('finishing an interrupted scoring', () => {
  it('completes the whole measurement on a blank row when the runKey still verifies', async () => {
    const id = await snapshotRow();
    await orphanScoreIntent(id, 'snapshot');

    const w2 = await w.reboot();
    await w2.services.scoringIntents.heal();
    const outcome = await w2.services.snapshotScorer.finishScoring(id, w2.deps);

    expect(outcome.status).toBe('scored');
    const [row] = await w2.stores.networth.listSnapshots();
    expect(row.score?.success).toBe(0.941);
    expect(row.score?.sustainableSpend).toBe(118_000);
    expect(await w2.intentFileExists()).toBe(false);
  });

  it('completes ONLY the spend half when the probability already stands — filling the one blank', async () => {
    const id = await snapshotRow();
    await w.stores.networth.attachScore(id, { score: SCORE });
    await orphanSpendIntent(id, 'snapshot');

    const w2 = await w.reboot();
    const outcome = await w2.services.snapshotScorer.finishScoring(id, w2.deps);

    expect(outcome.status).toBe('scored');
    const [row] = await w2.stores.networth.listSnapshots();
    // The recorded probability is untouched — same scoredAt, same number.
    expect(row.score?.scoredAt).toBe(SCORE.scoredAt);
    expect(row.score?.success).toBe(0.941);
    expect(row.score?.sustainableSpend).toBe(118_000);
    // Exactly one run was spent: the bisection. The probability was never
    // recomputed — there was nowhere to put a second one.
    expect(w2.executorCalls).toHaveLength(1);
    expect(w2.executorCalls[0].scenario.solver).toEqual({ type: 'max_spend' });
    expect(await w2.intentFileExists()).toBe(false);
  });

  it('re-verifies at the press and refuses a moved world without spending a path', async () => {
    const id = await snapshotRow();
    await orphanScoreIntent(id, 'snapshot');
    const w2 = await w.reboot();
    // The world moves AFTER boot healing found it completable — the exact
    // window that makes verify-at-press non-optional.
    await w2.services.scoringIntents.heal();
    await w2.stores.plan.savePlan(EDITED, new Date('2026-08-29T10:30:00.000Z'));

    const outcome = await w2.services.snapshotScorer.finishScoring(id, w2.deps);

    expect(outcome).toEqual({ status: 'failed', reason: inputsMovedReason('score') });
    expect(w2.executorCalls).toHaveLength(0);
    const [row] = await w2.stores.networth.listSnapshots();
    expect(row.scoreError).toBe(inputsMovedReason('score'));
    expect(await w2.intentFileExists()).toBe(false);
  });

  it('finishes a plan version spend-half the same way — the Aug-20 record, healed', async () => {
    const id = await keptVersionId();
    await w.stores.planHistory.attachPlanHistoryScore(id, { score: SCORE });
    await orphanSpendIntent(id, 'plan-version');

    const w2 = await w.reboot();
    const outcome = await w2.services.planHistoryScorer.finishVersionScoring(id, w2.deps);

    expect(outcome.status).toBe('scored');
    const entry = await w2.stores.planHistory.getPlanHistoryEntry(id);
    expect(entry.score?.scoredAt).toBe(SCORE.scoredAt);
    expect(entry.score?.sustainableSpend).toBe(118_000);
    expect(await w2.intentFileExists()).toBe(false);
  });

  it('the front door 404s a target with no intent — a stale click gets a sentence', async () => {
    const id = await snapshotRow();
    await expect(w.services.scoringIntents.finish({ kind: 'snapshot', id })).rejects.toThrow(
      NotFoundError,
    );
  });

  it('the front door answers scoring:true and the registry lists the row while it works', async () => {
    const id = await snapshotRow();
    await orphanScoreIntent(id, 'snapshot');
    const w2 = await w.reboot();

    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    w2.setExecutor(async (input) => {
      await gate;
      return input.scenario.solver ? solved() : finished();
    });

    const answer = await w2.services.scoringIntents.finish({ kind: 'snapshot', id });
    expect(answer).toEqual({ ok: true, scoring: true });
    expect(w2.services.snapshotScorer.snapshotsBeingScored()).toEqual([id]);
    release();
    await w2.services.snapshotScorer.finishScoring(id, w2.deps); // joins the same work
    expect(w2.services.snapshotScorer.snapshotsBeingScored()).toEqual([]);
  });

  it('a Finish on an already-complete row is a no-op that clears the leftover', async () => {
    const id = await snapshotRow();
    await w.services.snapshotScorer.startScoring(id, w.deps);
    await orphanSpendIntent(id, 'snapshot'); // stale leftover
    const before = JSON.stringify(await w.stores.networth.listSnapshots());

    const outcome = await w.services.snapshotScorer.finishScoring(id, w.deps);
    expect(outcome.status).toBe('already_scored');
    expect(JSON.stringify(await w.stores.networth.listSnapshots())).toBe(before);
    expect(await w.intentFileExists()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The write boundary: attach FIRST, clear SECOND
// ---------------------------------------------------------------------------

describe('the intent outlives a death at the attach itself', () => {
  /**
   * The ordering the scorers promise in their comments — attach first, clear
   * second — pinned at the one boundary where reversing it silently loses a
   * record: the run has answered, the attach is the very next write, and the
   * process dies ON that write. The intent is then the only thing on disk
   * that says a run was in flight, so it MUST still be there — cleared-first
   * would put the row back in the pre-Phase-6 silent-permanent-blank state.
   */
  function scorerDyingAt(method: 'attachScore' | 'attachSustainableSpend') {
    const dying = {
      ...w.stores.networth,
      [method]: async () => {
        throw new Error('the process died on this write');
      },
    };
    return createSnapshotScorer({
      networth: dying,
      planHistory: w.stores.planHistory,
      plan: w.stores.plan,
      runner: w.services.scoreRunner,
      defaultDeps: w.deps,
      intents: w.services.scoringIntentStore,
    });
  }

  it('a spend attach that never lands leaves the spend-phase intent standing', async () => {
    const id = await snapshotRow();
    const scorer = scorerDyingAt('attachSustainableSpend');
    // The whole flow, dying exactly at the spend attach: the probability
    // landed (the real attachScore ran), the bisection answered, the figure
    // never reached the row.
    await expect(scorer.startScoring(id, w.deps)).rejects.toThrow('died on this write');

    expect((await w.readIntents()).find((i) => i.id === id)).toMatchObject({
      kind: 'snapshot',
      phase: 'spend',
    });

    // And the reopened app turns it into the Aug-20 repair, not a loss.
    const w2 = await w.reboot();
    await w2.services.scoringIntents.heal();
    expect((await w2.services.scoringIntents.list()).map((i) => i.id)).toContain(id);
    const outcome = await w2.services.snapshotScorer.finishScoring(id, w2.deps);
    expect(outcome.status).toBe('scored');
    expect(await w2.intentFileExists()).toBe(false);
  });

  it('a score attach that never lands leaves the score-phase intent standing', async () => {
    const id = await snapshotRow();
    const scorer = scorerDyingAt('attachScore');
    await expect(scorer.startScoring(id, w.deps)).rejects.toThrow('died on this write');

    expect((await w.readIntents()).find((i) => i.id === id)).toMatchObject({
      kind: 'snapshot',
      phase: 'score',
    });

    const w2 = await w.reboot();
    await w2.services.scoringIntents.heal();
    const outcome = await w2.services.snapshotScorer.finishScoring(id, w2.deps);
    expect(outcome.status).toBe('scored');
    expect(await w2.intentFileExists()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Two scorings in flight share the one intent file
// ---------------------------------------------------------------------------

describe('concurrent recording through the serialized store', () => {
  it('a snapshot and a version scoring keep BOTH intents on disk mid-flight', async () => {
    // The interleaving the store's serialized chain exists to survive: two
    // scorers record into the one file at once, and a read-modify-write that
    // bypassed the chain (or wrote the file raw) would drop one of them —
    // exactly the loss class the intent machinery was built to close.
    const snapId = await snapshotRow();
    const verId = await keptVersionId();
    let releaseRuns: () => void = () => undefined;
    const gate = new Promise<void>((r) => {
      releaseRuns = r;
    });
    w.setExecutor(async (input) => {
      await gate;
      return input.scenario.solver ? solved() : finished();
    });
    // Real (short) waits: the gated polling loops must yield the event loop.
    const deps: ScoringDeps = { ...w.deps, wait: () => new Promise((r) => setTimeout(r, 2)) };
    const snapWork = w.services.snapshotScorer.startScoring(snapId, deps);
    const verWork = w.services.planHistoryScorer.startVersionScoring(verId, deps);

    const deadline = Date.now() + 10_000;
    for (;;) {
      const kinds = (await w.services.scoringIntentStore.list()).map((i) => i.kind).sort();
      if (kinds.length === 2) {
        expect(kinds).toEqual(['plan-version', 'snapshot']);
        break;
      }
      if (Date.now() > deadline) throw new Error('both intents never appeared on disk');
      await new Promise((r) => setTimeout(r, 5));
    }

    releaseRuns();
    expect((await snapWork).status).toBe('scored');
    expect((await verWork).status).toBe('scored');
    expect(await w.intentFileExists()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The completed record is the SAME record an uninterrupted run writes
// ---------------------------------------------------------------------------

describe('byte-level honesty of a finished interruption', () => {
  it('a finished blank-row interruption equals an uninterrupted scoring, byte for byte (masked stamp)', async () => {
    // Control world: the same folder shape, scored without interruption.
    const control = await makeWorld();
    await control.stores.plan.savePlan(PLAN, new Date('2026-08-29T08:00:00.000Z'));
    const controlId = (await control.stores.networth.takeSnapshot({ homeValue: 550_000 })).id;
    await control.services.snapshotScorer.startScoring(controlId, control.deps);

    // Interrupted world: intent lands, "the tab dies", reopen, Finish.
    const id = await snapshotRow();
    await orphanScoreIntent(id, 'snapshot');
    const w2 = await w.reboot();
    await w2.services.scoringIntents.heal();
    await w2.services.snapshotScorer.finishScoring(id, w2.deps);

    const mask = (text: string): string =>
      text
        .replace(/"id": "nw-[^"]+"/g, '"id": "nw-MASKED"')
        .replace(/"takenAt": "[^"]+"/g, '"takenAt": "MASKED"');
    const controlLedger = await control.stores.data.files.readText('networth.json');
    const healedLedger = await w2.stores.data.files.readText('networth.json');
    expect(mask(healedLedger)).toBe(mask(controlLedger));
  });
});

/**
 * Search lifecycle: start, poll, cancel, persist, list, reopen.
 *
 * A search takes minutes, so it cannot be an HTTP request — POST returns an id
 * and the work continues in the background. Two things are pinned here:
 *
 *   CANCELLATION IS AN OUTCOME, NOT AN ERROR. A run the user stops after eight
 *   minutes still writes a report, still persists it, and still says clearly
 *   that it stopped early. Throwing the work away teaches him not to start one.
 *
 *   A FINISHED SEARCH SURVIVES A RESTART. The report is on disk, the index
 *   reads it back, and reopening it does not re-run anything.
 *
 * The worker pool is faked (see searchExecutor.test.ts for the reasoning); this
 * file is about the lifecycle around it, not the arithmetic inside it.
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Scenario, SearchAxis, SearchReport, SearchRequest } from '../../src/shared/types';
import { NotFoundError, initDataDir } from '../../src/server/dataStore';

const world = vi.hoisted(() => ({
  calls: 0,
  destroys: 0,
  reset(): void {
    world.calls = 0;
    world.destroys = 0;
  },
}));

vi.mock('../../src/server/search/pool', () => {
  class FakePool {
    async destroy(): Promise<void> {
      world.destroys += 1;
    }
  }
  class FakeEvaluator {
    evaluations = 0;
    cacheHits = 0;
    runKeyFor(): string {
      return 'fake';
    }
    async evaluate(req: { scenario: Scenario; paths: number; seed: number }) {
      world.calls += 1;
      this.evaluations += 1;
      const monthly = req.scenario.assumption_overrides?.expenses?.livingMonthly ?? 6000;
      const spend = monthly * 12;
      // A plausible, monotone world: spending more lowers success.
      const success = Math.min(1, Math.max(0, 1 - 1e-5 * (spend - 72_000)));
      return {
        score: {
          runKey: 'f'.repeat(64),
          success,
          medianTerminalReal: 1_000_000,
          breakGlassReal: null,
          charitableTotalReal: 0,
          horizonYears: 36,
          worstDecileFirstShortfallYear: null,
          elapsedMs: 1,
        },
        cached: false,
      };
    }
  }
  return { SimPool: FakePool, CachedEvaluator: FakeEvaluator, defaultPoolSize: () => 2 };
});

import {
  cancelSearch,
  getSearch,
  getSearchReport,
  listSearches,
  startSearch,
} from '../../src/server/searchManager';

let tmpDir: string;
let prevEnv: string | undefined;

beforeAll(async () => {
  prevEnv = process.env.FPLAN_DATA_DIR;
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fplan-searchmgr-'));
  process.env.FPLAN_DATA_DIR = tmpDir;
  await initDataDir();
});

afterAll(async () => {
  if (prevEnv === undefined) delete process.env.FPLAN_DATA_DIR;
  else process.env.FPLAN_DATA_DIR = prevEnv;
  await fs.rm(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  world.reset();
});

function basePlan(): Scenario {
  return {
    name: 'Plan',
    events: [
      { type: 'retire', person: 'p1', date: '2033-06' },
      { type: 'retire', person: 'p2', date: '2033-06' },
    ],
  } as Scenario;
}

const smallAxes: SearchAxis[] = [
  { dim: 'retireYear', levels: [2029, 2031, 2033] },
  { dim: 'stockShare', levels: [0.5, 0.7] },
];

/** A space big enough that a cancel lands mid-flight rather than after the end. */
const bigAxes: SearchAxis[] = [
  { dim: 'retireYear', levels: [2027, 2028, 2029, 2030, 2031, 2032] },
  { dim: 'stockShare', levels: [0.3, 0.5, 0.7, 0.9] },
  { dim: 'claimAge', levels: [62, 65, 67, 70] },
];

function request(overrides: Partial<SearchRequest> = {}): SearchRequest {
  return {
    base: basePlan(),
    axes: smallAxes,
    budget: {
      candidates: 12,
      enumerate: true,
      finalists: 2,
      screenPaths: 200,
      racePaths: 400,
      reportPaths: 400,
      selectionSeedCount: 2,
      reportSeedCount: 3,
      seedBase: 500,
      attribution: false,
      polish: false,
      widowProbe: false,
      workers: 2,
    },
    ...overrides,
  };
}

/**
 * The status flips to done/cancelled BEFORE the report is written to disk (the
 * manager sets the progress and then awaits persistReport), so anything reading
 * searches/<id>.json has to wait for the file rather than for the status.
 */
async function persisted(searchId: string, timeoutMs = 15_000): Promise<SearchReport> {
  const file = path.join(tmpDir, 'searches', `${searchId}.json`);
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      return JSON.parse(await fs.readFile(file, 'utf8')) as SearchReport;
    } catch (err) {
      if (Date.now() > deadline) throw err;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
}

async function settle(searchId: string, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const progress = await getSearch(searchId);
    if (!progress) throw new Error(`search ${searchId} vanished`);
    if (progress.status === 'done' || progress.status === 'error' || progress.status === 'cancelled') {
      return progress;
    }
    if (Date.now() > deadline) throw new Error(`search ${searchId} never settled: ${progress.stage}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

// ---------------------------------------------------------------------------

describe('running a search to completion', () => {
  it('hands back an id immediately, then reports progress until it is done', async () => {
    const { searchId } = await startSearch(request({ label: 'first pass' }));
    expect(searchId).toMatch(/^[a-z0-9]{8,40}$/);

    const progress = await settle(searchId);
    expect(progress.status).toBe('done');
    expect(progress.stage).toBe('done');
    expect(progress.report).toBeDefined();
    expect(progress.report?.truncated).toBe(false);
    expect(progress.report?.label).toBe('first pass');
    expect(progress.evaluated).toBeGreaterThan(0);
    expect(world.calls).toBeGreaterThan(0);
    // The pool is torn down exactly once, whatever happened inside.
    expect(world.destroys).toBe(1);
  });

  it('persists the report so a finished search survives a restart', async () => {
    const { searchId } = await startSearch(request({ label: 'persisted' }));
    await settle(searchId);

    const stored = await persisted(searchId);
    expect(stored.searchId).toBe(searchId);
    expect(stored.label).toBe('persisted');
    expect(stored.finalists.length).toBeGreaterThan(0);

    // Reopening reads the same report rather than re-running anything.
    const before = world.calls;
    const reopened = await getSearchReport(searchId);
    expect(reopened.searchId).toBe(searchId);
    expect(world.calls).toBe(before);
  });

  it('reads a report off disk for a search this process never ran', async () => {
    // The restart case: nothing in memory, everything on disk.
    const orphan = 'restartedaaa1';
    const source = await startSearch(request());
    await settle(source.searchId);
    const stored = await persisted(source.searchId);
    const transplanted: SearchReport = { ...stored, searchId: orphan, label: 'from disk' };
    await fs.writeFile(
      path.join(tmpDir, 'searches', `${orphan}.json`),
      JSON.stringify(transplanted, null, 2),
      'utf8',
    );

    const progress = await getSearch(orphan);
    expect(progress).not.toBeNull();
    expect(progress?.status).toBe('done');
    expect(progress?.report?.label).toBe('from disk');
    expect(progress?.leaderboard).toEqual([]);
    expect(await getSearchReport(orphan)).toMatchObject({ searchId: orphan });
  });

  it('indexes finished searches newest first, with enough to choose between them', async () => {
    const summaries = await listSearches();
    expect(summaries.length).toBeGreaterThan(0);
    for (let i = 1; i < summaries.length; i++) {
      expect(summaries[i - 1].createdAt >= summaries[i].createdAt).toBe(true);
    }
    const one = summaries.find((s) => s.label === 'persisted');
    expect(one).toBeDefined();
    expect(one?.dims).toEqual(['retireYear', 'stockShare']);
    expect(one?.candidatesGenerated).toBeGreaterThan(0);
    expect(one?.winnerLabel?.length).toBeGreaterThan(0);
    expect(one?.truncated).toBe(false);
    expect(one?.engineVersion).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

describe('cancellation', () => {
  it('stops a running search and still writes a report, labelled as partial', async () => {
    const { searchId } = await startSearch(
      request({
        axes: bigAxes,
        budget: { ...request().budget, candidates: 96, enumerate: true, finalists: 4 },
      }),
    );
    expect(cancelSearch(searchId)).toBe(true);

    const progress = await settle(searchId);
    expect(progress.status).toBe('cancelled');
    expect(progress.stage).toBe('cancelled');
    expect(progress.stageLabel).toMatch(/stopped early/);
    expect(progress.report?.truncated).toBe(true);
    expect(progress.report?.caveats[0]).toMatch(/^CANCELLED/);

    // The partial report is persisted like any other: the work is not thrown
    // away, and the file says on its face that it stopped early.
    const stored = await persisted(searchId);
    expect(stored.truncated).toBe(true);
    expect(world.destroys).toBe(1);

    // ... and it shows up in the index flagged as truncated, so it can never be
    // mistaken for a completed answer.
    const summary = (await listSearches()).find((s) => s.searchId === searchId);
    expect(summary?.truncated).toBe(true);
  });

  it('really stops: far fewer evaluations than the same search run to the end', async () => {
    const big = request({
      axes: bigAxes,
      budget: { ...request().budget, candidates: 96, enumerate: true, finalists: 4 },
    });

    const cancelled = await startSearch(big);
    cancelSearch(cancelled.searchId);
    await settle(cancelled.searchId);
    const cancelledCalls = world.calls;

    world.reset();
    const complete = await startSearch(big);
    await settle(complete.searchId);
    const completeCalls = world.calls;

    expect(cancelledCalls).toBeLessThan(completeCalls / 2);
  });

  it('says so, without erroring, when there is nothing left to cancel', async () => {
    const { searchId } = await startSearch(request());
    await settle(searchId);
    // Already finished: not an error, just nothing to do.
    expect(cancelSearch(searchId)).toBe(false);
    expect((await getSearch(searchId))?.status).toBe('done');
    // Never existed.
    expect(cancelSearch('nosuchsearch')).toBe(false);
  });
});

describe('unknown searches', () => {
  it('returns null rather than throwing, for both missing and malformed ids', async () => {
    expect(await getSearch('nosuchsearchid')).toBeNull();
    expect(await getSearch('../../etc/passwd')).toBeNull();
    expect(await getSearch('SHOUTING')).toBeNull();
    expect(await getSearch('x')).toBeNull();
  });

  it('throws NotFound when asked for a report that does not exist', async () => {
    await expect(getSearchReport('nosuchsearchid')).rejects.toBeInstanceOf(NotFoundError);
    // A path-shaped id must not become a path.
    await expect(getSearchReport('../../etc/passwd')).rejects.toBeInstanceOf(NotFoundError);
  });

  it('ignores junk in the searches folder instead of failing the index', async () => {
    const dir = path.join(tmpDir, 'searches');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'notasearch.json'), '{ broken', 'utf8');
    await fs.writeFile(path.join(dir, 'README.txt'), 'hello', 'utf8');
    const summaries = await listSearches();
    expect(summaries.length).toBeGreaterThan(0);
    expect(summaries.every((s) => s.searchId !== 'notasearch')).toBe(true);
  });
});

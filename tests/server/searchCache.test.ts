/**
 * The caches the search runs on, and the pool it runs them in.
 *
 * NO WORKERS ARE SPAWNED HERE. Every test either hits a cache (so nothing is
 * simulated) or exercises the pool's queue and shutdown paths, which need no
 * threads. That is deliberate: booting a tsx worker costs ~99ms and tells us
 * nothing about the logic under test.
 *
 * The property that matters most is the FIRST one: the search's cache key must
 * be byte-identical to runManager's, because the whole economy of the feature
 * rests on it. A user has ~113MB of cached runs from using the workbench; a
 * key that drifted by one field would miss every one of them, silently, while
 * looking perfectly healthy — the search would just be four times slower and
 * nobody would know why.
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type {
  Assumptions,
  Profile,
  RunResult,
  Scenario,
  SimulationInput,
} from '../../src/shared/types';
import { initDataDir, loadAssumptions, loadProfile } from '../../src/server/dataStore';
import { runKeyFor } from '../../src/server/runManager';
import { CachedEvaluator, SimPool, defaultPoolSize } from '../../src/server/search/pool';
import {
  readScore,
  scoreFromResult,
  scoresDir,
  writeScore,
  type SearchScore,
} from '../../src/server/search/scoreStore';

let tmpDir: string;
let prevEnv: string | undefined;
let profile: Profile;
let assumptions: Assumptions;

beforeAll(async () => {
  prevEnv = process.env.FPLAN_DATA_DIR;
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fplan-searchcache-'));
  process.env.FPLAN_DATA_DIR = tmpDir;
  await initDataDir();
  profile = await loadProfile();
  assumptions = await loadAssumptions();
});

afterAll(async () => {
  if (prevEnv === undefined) delete process.env.FPLAN_DATA_DIR;
  else process.env.FPLAN_DATA_DIR = prevEnv;
  await fs.rm(tmpDir, { recursive: true, force: true });
});

beforeEach(async () => {
  await fs.rm(scoresDir(), { recursive: true, force: true });
  await fs.rm(path.join(tmpDir, 'runs'), { recursive: true, force: true });
  await fs.mkdir(path.join(tmpDir, 'runs'), { recursive: true });
});

function plan(): Scenario {
  return {
    name: 'candidate',
    events: [{ type: 'retire', person: 'p1', date: '2033-06' }],
  } as Scenario;
}

/** A pool that never spawns a thread and counts what it was asked to run. */
class CountingPool {
  jobs: Array<{ runKey: string; seed: number; paths: number }> = [];
  delayMs = 0;
  async run(input: { runKey: string; seed: number; paths: number }): Promise<SearchScore> {
    this.jobs.push({ runKey: input.runKey, seed: input.seed, paths: input.paths });
    if (this.delayMs > 0) await new Promise((r) => setTimeout(r, this.delayMs));
    return {
      runKey: input.runKey,
      success: 0.9,
      medianTerminalReal: 1_000_000,
      breakGlassReal: null,
      charitableTotalReal: 0,
      horizonYears: 36,
      worstDecileFirstShortfallYear: null,
      elapsedMs: 1,
    };
  }
}

function evaluator(pool: CountingPool): CachedEvaluator {
  return new CachedEvaluator(pool as unknown as SimPool, profile, assumptions);
}

const request = { scenario: plan(), mode: 'montecarlo' as const, paths: 4000, seed: 42 };

// ---------------------------------------------------------------------------

describe('the search and the app agree on what a run is', () => {
  it('derives the same key runManager would, field for field', () => {
    const input: SimulationInput = {
      profile,
      assumptions,
      scenario: request.scenario,
      mode: request.mode,
      paths: request.paths,
      seed: request.seed,
    };
    expect(evaluator(new CountingPool()).runKeyFor(request)).toBe(runKeyFor(input));
    expect(runKeyFor(input)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('gives a different key to every field that changes a number', () => {
    const evalr = evaluator(new CountingPool());
    const base = evalr.runKeyFor(request);
    expect(evalr.runKeyFor({ ...request, seed: 43 })).not.toBe(base);
    expect(evalr.runKeyFor({ ...request, paths: 4001 })).not.toBe(base);
    expect(evalr.runKeyFor({ ...request, mode: 'historical' })).not.toBe(base);
    expect(
      evalr.runKeyFor({
        ...request,
        scenario: { ...plan(), events: [{ type: 'retire', person: 'p1', date: '2034-06' }] } as Scenario,
      }),
    ).not.toBe(base);
  });
});

describe('the cached evaluator', () => {
  it('simulates once, then answers from memory', async () => {
    const pool = new CountingPool();
    const evalr = evaluator(pool);

    const first = await evalr.evaluate(request);
    expect(first.cached).toBe(false);
    const second = await evalr.evaluate(request);
    expect(second.cached).toBe(true);
    expect(second.score).toEqual(first.score);

    expect(pool.jobs).toHaveLength(1);
    expect(evalr.evaluations).toBe(1);
    expect(evalr.cacheHits).toBe(1);
  });

  it('collapses concurrent identical asks into one simulation', async () => {
    const pool = new CountingPool();
    pool.delayMs = 5;
    const evalr = evaluator(pool);

    const outcomes = await Promise.all(Array.from({ length: 6 }, () => evalr.evaluate(request)));
    // Six rounds asking for the same configuration at once must not compute it
    // six times — the in-flight map is what stops that.
    expect(pool.jobs).toHaveLength(1);
    expect(outcomes.filter((o) => !o.cached)).toHaveLength(1);
    expect(evalr.evaluations).toBe(1);
    expect(evalr.cacheHits).toBe(5);
  });

  it('reads the slim score store, so a previous search is free', async () => {
    const pool = new CountingPool();
    const runKey = evaluator(pool).runKeyFor(request);
    await writeScore({
      runKey,
      success: 0.77,
      medianTerminalReal: 2_000_000,
      breakGlassReal: null,
      charitableTotalReal: 1234,
      horizonYears: 36,
      worstDecileFirstShortfallYear: 2044,
      elapsedMs: 1,
    });

    const evalr = evaluator(pool);
    const outcome = await evalr.evaluate(request);
    expect(outcome.cached).toBe(true);
    expect(outcome.score.success).toBe(0.77);
    expect(pool.jobs).toHaveLength(0);
    expect(evalr.evaluations).toBe(0);
  });

  it("reads the app's own full run cache, so the workbench's runs are free", async () => {
    const pool = new CountingPool();
    const runKey = evaluator(pool).runKeyFor(request);
    // What the workbench leaves behind: a full RunResult at runs/<runKey>.json.
    const full = {
      runKey,
      success: 0.8125,
      medianTerminalReal: 3_000_000,
      breakGlassReal: 4321,
      charitableLegacy: { totalReal: 99_000 },
      horizonYears: 36,
      worstDecileShortfallYears: { 2051: 3, 2048: 1 },
      elapsedMs: 1660,
    } as unknown as RunResult;
    await fs.writeFile(
      path.join(tmpDir, 'runs', `${runKey}.json`),
      JSON.stringify(full),
      'utf8',
    );

    const evalr = evaluator(pool);
    const outcome = await evalr.evaluate(request);
    expect(outcome.cached).toBe(true);
    expect(pool.jobs).toHaveLength(0);
    expect(outcome.score.success).toBe(0.8125);
    expect(outcome.score.charitableTotalReal).toBe(99_000);
    // The earliest year a worst-decile path ran short, not just any of them.
    expect(outcome.score.worstDecileFirstShortfallYear).toBe(2048);

    // ... and the slim record is written on the way past, so the next search
    // does not have to parse a ~472KB file again.
    const slim = await readScore(runKey);
    expect(slim?.success).toBe(0.8125);
    const bytes = (await fs.stat(path.join(scoresDir(), `${runKey}.json`))).size;
    expect(bytes).toBeLessThan(1000);
  });

  it('writes a slim record after simulating, and treats a corrupt one as a miss', async () => {
    const pool = new CountingPool();
    const evalr = evaluator(pool);
    const runKey = evalr.runKeyFor(request);

    await evalr.evaluate(request);
    expect(await readScore(runKey)).not.toBeNull();

    // A cache that throws is worse than one that misses.
    await fs.writeFile(path.join(scoresDir(), `${runKey}.json`), '{ truncated', 'utf8');
    expect(await readScore(runKey)).toBeNull();
    const fresh = evaluator(pool);
    const outcome = await fresh.evaluate(request);
    expect(outcome.cached).toBe(false);
    expect(pool.jobs).toHaveLength(2);
  });

  it('refuses to build a path out of a key that is not a key', async () => {
    // The runKey reaches the filesystem, so it is checked before it does.
    await expect(readScore('../../etc/passwd')).resolves.toBeNull();
    await expect(
      writeScore({ runKey: '../escape' } as unknown as SearchScore),
    ).resolves.toBeUndefined();
    await expect(fs.access(path.join(tmpDir, '..', 'escape.json'))).rejects.toThrow();
  });
});

describe('scoreFromResult', () => {
  it('keeps exactly what the search reads and nothing else', () => {
    const score = scoreFromResult('a'.repeat(64), {
      success: 0.5,
      medianTerminalReal: 10,
      breakGlassReal: null,
      horizonYears: 36,
      elapsedMs: 5,
      // The ~472KB the search does not need, and must not persist by the
      // thousand: 245 cached runs already measure 113MB on the user's disk.
      fan: new Array(1000).fill({ p10: 1, p50: 2, p90: 3 }),
      reference: { years: new Array(36).fill({ taxes: {} }) },
    } as unknown as RunResult);

    expect(Object.keys(score).sort()).toEqual([
      'breakGlassReal',
      'charitableTotalReal',
      'elapsedMs',
      'horizonYears',
      'medianTerminalReal',
      'runKey',
      'success',
      'worstDecileFirstShortfallYear',
    ]);
    expect(JSON.stringify(score).length).toBeLessThan(400);
    expect(score.charitableTotalReal).toBe(0);
    expect(score.worstDecileFirstShortfallYear).toBeNull();
  });
});

describe('the worker pool', () => {
  it('sizes itself to leave the machine usable', () => {
    const size = defaultPoolSize();
    expect(size).toBeGreaterThanOrEqual(2);
    // Measured on this class of machine: throughput saturates at eight workers
    // and ten is measurably worse than eight.
    expect(size).toBeLessThanOrEqual(8);
  });

  it('rejects queued work when it is destroyed, rather than hanging the search', async () => {
    // Size 0 never spawns, so the job goes straight to the queue — which is the
    // state a cancelled search leaves its pool in.
    const pool = new SimPool(0, { profile, assumptions });
    const queued = pool.run({
      runKey: 'a'.repeat(64),
      scenario: plan(),
      mode: 'montecarlo',
      paths: 100,
      seed: 1,
    });
    const settled = queued.then(
      () => 'resolved',
      (err: Error) => err.message,
    );
    await pool.destroy();
    expect(await settled).toMatch(/cancelled/i);
  });

  it('refuses new work after shutdown instead of quietly spawning threads', async () => {
    const pool = new SimPool(2, { profile, assumptions });
    await pool.destroy();
    await expect(
      pool.run({ runKey: 'b'.repeat(64), scenario: plan(), mode: 'montecarlo', paths: 100, seed: 1 }),
    ).rejects.toThrow(/shut down/i);
    // Destroying twice is not an error: the executor's `finally` may race a
    // cancellation that already tore it down.
    await expect(pool.destroy()).resolves.toBeUndefined();
  });
});

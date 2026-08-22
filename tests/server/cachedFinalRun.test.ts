/**
 * ASKING THE RUN CACHE WITHOUT STARTING A RUN.
 *
 * A user pressed Run now, read 94.2% at 10,000 paths, refreshed the browser,
 * and the page came back reading 93.1%. Nothing had changed but the path count:
 * the live loop recomputed at 1,000 paths because nothing ever asked whether the
 * better answer was still on file. It was — the run cache holds every run the
 * app has ever made.
 *
 * `lookupCachedRun` is what asks. The properties below are the four ways it can
 * be wrong, and each one is a real hazard rather than a shape check:
 *
 *  1. IT MUST FIND the final run for these exact inputs, so the refresh stops
 *     losing it.
 *  2. IT MUST NOT REUSE a run made from DIFFERENT inputs. The plan hash alone is
 *     the wrong key: holdings balances are derived from quote prices, so the
 *     same plan at two prices is two different runs, and serving one for the
 *     other would put a stale number on screen labelled as the current one. The
 *     plan and the engine version are the same argument in easier clothes.
 *  3. IT MUST START NOTHING on a miss. POST /api/run answers a hit just as
 *     instantly, but its miss spawns the simulation — so asking with it would
 *     mean a page load with no cached answer quietly beginning a 10,000-path
 *     run. Looking is free; computing is not, and that is the entire reason
 *     this route exists rather than reusing the one next to it.
 *  4. Run now, whose whole job is to refresh prices and then run at final
 *     quality, must be an INSTANT cache hit when the prices did not move.
 *
 * NO WORKERS ARE SPAWNED HERE, in the idiom of tests/server/searchCache.test.ts:
 * every test either hits a cache or asserts that nothing was started. Each
 * points FPLAN_DATA_DIR at a fresh temp dir seeded from data-defaults, so the
 * owner's real data folder is never read or touched.
 */
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type {
  Assumptions,
  Profile,
  RunResult,
  Scenario,
  SimulationInput,
  StoredQuote,
} from '../../src/shared/types';
import { ENGINE_VERSION } from '../../src/shared/types';
import { stableStringify } from '../../src/shared/util';
import {
  initDataDir,
  loadAssumptions,
  loadProfile,
  loadResolvedProfile,
  saveProfile,
  saveQuotes,
} from '../../src/server/dataStore';
import { getRun, lookupCachedRun, runKeyFor, startRun } from '../../src/server/runManager';

let tmpDir: string;
let prevEnv: string | undefined;
let assumptions: Assumptions;

/** A price at a moment — the only field that has to move to reprice a holding. */
const quoteAt = (price: number): StoredQuote => ({
  price,
  currency: 'USD',
  asOf: '2026-08-20T20:00:00.000Z',
  source: 'yahoo',
  fetchedAt: '2026-08-20T20:05:00.000Z',
});

beforeEach(async () => {
  prevEnv = process.env.FPLAN_DATA_DIR;
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fplan-cachedrun-'));
  process.env.FPLAN_DATA_DIR = tmpDir;
  await initDataDir();

  // The IRA goes holdings-mode with prices on file, which is a representative
  // arrangement and the only one where "the same plan" can still be two
  // different runs. Without it there is nothing for a price move to move.
  const profile = await loadProfile();
  const ira = profile.accounts.find((a) => a.id === 'ira1')!;
  ira.holdings = [
    { symbol: 'VTI', quantity: 100, assetClass: 'stocks' },
    { symbol: 'BND', quantity: 200, assetClass: 'bonds' },
  ];
  ira.cash = 50;
  await saveProfile(profile);
  await saveQuotes({ VTI: quoteAt(300), BND: quoteAt(70) });

  assumptions = await loadAssumptions();
  await fs.mkdir(path.join(tmpDir, 'runs'), { recursive: true });
});

afterEach(async () => {
  if (prevEnv === undefined) delete process.env.FPLAN_DATA_DIR;
  else process.env.FPLAN_DATA_DIR = prevEnv;
  await fs.rm(tmpDir, { recursive: true, force: true });
});

/**
 * A plan, named so each test's inputs hash somewhere of their own.
 *
 * The in-memory run map in runManager is module-level and outlives a temp dir,
 * so two tests sharing a plan could share a runKey and one could see the
 * other's entry. A distinct name per test makes that impossible.
 */
const plan = (name: string): Scenario =>
  ({ name, events: [{ type: 'retire', person: 'p1', date: '2033-06' }] }) as Scenario;

/** The resolved profile, priced from whatever is on quotes.json right now. */
async function pricedProfile(): Promise<Profile> {
  const { profile, missing } = await loadResolvedProfile();
  expect(missing, 'the fixture must price every holding').toEqual([]);
  return profile;
}

/** The exact input a final-quality run of `scenario` would execute. */
async function finalInput(scenario: Scenario): Promise<SimulationInput> {
  const profile = await pricedProfile();
  return {
    profile,
    assumptions,
    scenario,
    mode: 'montecarlo',
    paths: profile.settings.mcPathsFinal,
    seed: profile.settings.seed,
  };
}

/**
 * File a result under `runKey`, the way finishRun does: the run key normalised
 * into meta, so a caller reading it back can tell the server which run it has.
 */
async function fileRun(runKey: string, success: number): Promise<RunResult> {
  const result = {
    meta: {
      engineVersion: ENGINE_VERSION,
      mode: 'montecarlo',
      seed: 20260812,
      paths: 10_000,
      createdAt: '2026-08-20T15:41:00.000Z',
      scenarioName: 'cached',
      hashes: { profile: 'p', assumptions: 'a', scenario: 's' },
      runKey,
    },
    success,
  } as unknown as RunResult;
  await fs.writeFile(
    path.join(tmpDir, 'runs', `${runKey}.json`),
    `${JSON.stringify(result, null, 2)}\n`,
    'utf8',
  );
  return result;
}

/** How many runs are on file — the count that must not grow when nothing ran. */
async function cachedRunCount(): Promise<number> {
  return (await fs.readdir(path.join(tmpDir, 'runs'))).length;
}

describe('a cached final result for the current inputs is preferred over a quick run', () => {
  it('hands back the 10,000-path run already on file for these exact inputs', async () => {
    const scenario = plan('prefer-final');
    await fileRun(runKeyFor(await finalInput(scenario)), 0.942);

    const found = await lookupCachedRun({
      scenario,
      mode: 'montecarlo',
      paths: 10_000,
      seed: 20260812,
    });
    expect(found).not.toBeNull();
    expect(found!.success).toBe(0.942);
    expect(found!.meta.paths).toBe(10_000);
  });

  it('has nothing to hand back for the 1,000-path run the loop would have made', async () => {
    // The pair IS the preference. The final run is on file and the quick one is
    // not, so a page that asks for the final one first shows 94.2% and a page
    // that does not computes 93.1% — which is the whole bug, in two lines.
    const scenario = plan('prefer-final-quick-miss');
    await fileRun(runKeyFor(await finalInput(scenario)), 0.942);

    const quick = await lookupCachedRun({
      scenario,
      mode: 'montecarlo',
      paths: 1_000,
      seed: 20260812,
    });
    expect(quick).toBeNull();
  });
});

describe('a cached result for DIFFERENT inputs is never reused', () => {
  it('does not survive a price move, because the balances moved with it', async () => {
    /*
     * THE REASON THE PLAN HASH IS THE WRONG KEY. The plan is byte-identical
     * across these two lookups; the IRA is not, because its balance is 100 VTI
     * at whatever VTI costs. Reusing the first run for the second would show a
     * number computed at $300 while the app says the holding is worth $310 —
     * a stale figure wearing a current label, which is the one outcome worse
     * than recomputing.
     */
    const scenario = plan('price-move');
    await fileRun(runKeyFor(await finalInput(scenario)), 0.942);
    const req = { scenario, mode: 'montecarlo' as const, paths: 10_000, seed: 20260812 };
    expect(await lookupCachedRun(req)).not.toBeNull();

    await saveQuotes({ VTI: quoteAt(310), BND: quoteAt(70) });
    expect(await lookupCachedRun(req)).toBeNull();
  });

  it('does not survive an edit to the plan', async () => {
    const scenario = plan('plan-edit');
    await fileRun(runKeyFor(await finalInput(scenario)), 0.942);
    const edited = {
      ...scenario,
      events: [{ type: 'retire', person: 'p1', date: '2035-06' }],
    } as Scenario;
    expect(
      await lookupCachedRun({ scenario: edited, mode: 'montecarlo', paths: 10_000, seed: 20260812 }),
    ).toBeNull();
  });

  it('does not survive an engine version change, because the run is filed under it', async () => {
    /*
     * Two engines do not agree, so a run made by one is not an answer for the
     * other. runKeyFor folds ENGINE_VERSION into the hash, which means the old
     * engine's run is at a different ADDRESS rather than merely marked stale —
     * it can be sitting on disk, readable and intact, and still be unfindable.
     * The alternate hash is spelled out here on purpose: it is what the
     * previous engine wrote, not a second implementation of the key.
     */
    const scenario = plan('engine-change');
    const input = await finalInput(scenario);
    const oldEngineKey = createHash('sha256')
      .update(stableStringify({ engineVersion: '0.0.0-previous', input }))
      .digest('hex');
    await fileRun(oldEngineKey, 0.942);
    expect(oldEngineKey).not.toBe(runKeyFor(input));

    expect(
      await lookupCachedRun({ scenario, mode: 'montecarlo', paths: 10_000, seed: 20260812 }),
    ).toBeNull();
  });
});

describe('the lookup starts nothing on a miss', () => {
  it('leaves no run in flight and no new file behind', async () => {
    /*
     * This is the property the whole route exists for. startRun registers its
     * run in the manager's map SYNCHRONOUSLY before the worker boots, so a
     * getRun that answers null is proof no simulation was begun — not merely
     * that none has finished. The file count is the second half: a lookup that
     * quietly computed would leave its answer on disk.
     *
     * The contrast with startRun is deliberately not asserted by calling it:
     * that would boot a real tsx worker for tens of seconds to prove something
     * every other test in this repo already relies on.
     */
    const scenario = plan('starts-nothing');
    const key = runKeyFor(await finalInput(scenario));
    const before = await cachedRunCount();

    expect(
      await lookupCachedRun({ scenario, mode: 'montecarlo', paths: 10_000, seed: 20260812 }),
    ).toBeNull();

    expect(await getRun(key)).toBeNull();
    expect(await cachedRunCount()).toBe(before);
  });
});

describe('Run now costs nothing when the prices did not move', () => {
  it('is a cache hit rather than a second 10,000-path simulation', async () => {
    /*
     * Run now refreshes prices FIRST and then runs at final quality, so its
     * input changes exactly when the prices actually change. Press it twice in
     * a quiet market and the second press has the same input as the first —
     * and startRun is required to answer it from the cache, done, without
     * spawning anything. A `queued` or `running` status here would mean the
     * owner paid for the same 10,000 paths twice.
     */
    const scenario = plan('run-now-repeat');
    const cached = await fileRun(runKeyFor(await finalInput(scenario)), 0.942);
    const before = await cachedRunCount();

    const { runId } = await startRun({
      scenario,
      mode: 'montecarlo',
      paths: 10_000,
      seed: 20260812,
    });
    const progress = await getRun(runId);
    expect(progress).not.toBeNull();
    expect(progress!.status).toBe('done');
    expect(progress!.result?.success).toBe(cached.success);
    expect(await cachedRunCount()).toBe(before);
  });
});

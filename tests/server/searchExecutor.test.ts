/**
 * THE SEARCH EXECUTOR, run end to end against a simulated world.
 *
 * WHY A FAKE ENGINE. The property under test is not "does the tax code work" —
 * eight hundred other tests cover that. It is "does the executor choose, rank
 * and report honestly in the presence of seed noise", and the only way to test
 * that is to KNOW what the noise is. So the worker pool is replaced with a
 * model whose success rate is an exact function of (plan, spending, seed):
 *
 *     success = 1.00 + slope x (spend - planSpend) + quality(plan) + noise(plan, seed)
 *
 * Every number the executor sees is therefore something this file chose, which
 * makes it possible to construct the case that matters most — a candidate whose
 * SCREENING score is inflated by luck on the selection seeds and whose true
 * quality is lower — and pin that the held-out multi-seed pass overrules it.
 *
 * The fake also records every single evaluation it is asked for: the plan, the
 * spending level, the seed and the path count. That recording is what lets the
 * attribution tests assert the thing the report's whole credibility rests on —
 * that both sides of every reported difference were measured on the SAME seeds
 * at the SAME path count, i.e. that it is a paired delta and not a difference
 * of independently seeded levels.
 *
 * WHAT THIS FILE DOES NOT TEST: that the engine's market draw depends only on
 * (rows, horizon, paths, block years, seed, expense ratios). That is the
 * property that makes pairing meaningful in the first place, and it is pinned
 * in tests/engine/returns.test.ts ("bit-identical for the same seed") plus the
 * real-engine check at the bottom of this file.
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  Assumptions,
  Profile,
  Scenario,
  ScenarioEvent,
  SearchAxis,
  SearchProgress,
  SearchReport,
  SearchRequest,
} from '../../src/shared/types';
import { initDataDir, loadAssumptions, loadProfile } from '../../src/server/dataStore';

// ---------------------------------------------------------------------------
// The simulated world (hoisted, so the vi.mock factory below can close over it)
// ---------------------------------------------------------------------------

const world = vi.hoisted(() => {
  interface Call {
    plan: string;
    spend: number;
    seed: number;
    paths: number;
  }
  interface Score {
    runKey: string;
    success: number;
    medianTerminalReal: number;
    breakGlassReal: number | null;
    charitableTotalReal: number;
    horizonYears: number;
    worstDecileFirstShortfallYear: number | null;
    elapsedMs: number;
  }

  const state = {
    calls: [] as Call[],
    memo: new Map<string, Score>(),
    destroys: 0,
    poolSizes: [] as number[],
    /** Trip the cancel flag once this many evaluations have been requested. */
    cancelAfter: Number.POSITIVE_INFINITY,
    cancelled: false,
    /** The plan's own annual spending; the model is anchored here. */
    planSpend: 72_000,
    slopePerDollar: -1e-5,
    /** Additive success offset per plan, in success units. */
    quality: new Map<string, number>(),
    /** Per (plan, seed) luck, in success units. */
    noise: (_plan: string, _seed: number): number => 0,
    /** Full override: when set, this IS the model. */
    success: null as null | ((plan: string, spend: number, seed: number) => number),

    /**
     * A plan's identity, read back out of the compiled scenario. The axes used
     * in this file all leave a legible mark: a retire date, an allocation mix,
     * a claim date, a 72(t) flag, a death (the survivor probe).
     */
    planOf(scenario: Scenario): string {
      const events = scenario.events as ScenarioEvent[];
      const dates = (type: string): string =>
        events
          .filter((e) => e.type === type)
          .map((e) => ((e as { date?: string }).date ?? ''))
          .sort()
          .join(',') || '-';
      const alloc = events.filter((e) => e.type === 'allocation_change');
      const stocks =
        alloc.length > 0
          ? ((alloc[alloc.length - 1] as { mix: { stocks: number } }).mix.stocks).toFixed(3)
          : '-';
      const glide = events.filter((e) => e.type === 'glidepath').length;
      return [
        `r=${dates('retire')}`,
        `c=${dates('claim_social_security')}`,
        `s=${stocks}`,
        `g=${glide}`,
        `sepp=${scenario.autoSepp ?? '-'}`,
        `d=${dates('death')}`,
      ].join(' ');
    },

    spendOf(scenario: Scenario): number {
      const monthly = scenario.assumption_overrides?.expenses?.livingMonthly;
      return monthly === undefined ? state.planSpend : Math.round(monthly * 12);
    },

    scoreFor(plan: string, spend: number, seed: number): Score {
      const raw = state.success
        ? state.success(plan, spend, seed)
        : 1 +
          state.slopePerDollar * (spend - state.planSpend) +
          (state.quality.get(plan) ?? 0) +
          state.noise(plan, seed);
      const success = Math.min(1, Math.max(0, raw));
      return {
        runKey: 'f'.repeat(64),
        success,
        // Terminal wealth does not saturate, which is what makes it usable as
        // the screening tiebreak; give it a monotone relationship to quality.
        medianTerminalReal: 1_000_000 * (1 + (state.quality.get(plan) ?? 0)) - spend,
        breakGlassReal: null,
        charitableTotalReal: 250_000,
        horizonYears: 36,
        worstDecileFirstShortfallYear: null,
        elapsedMs: 1,
      };
    },

    reset(): void {
      state.calls = [];
      state.memo = new Map();
      state.destroys = 0;
      state.poolSizes = [];
      state.cancelAfter = Number.POSITIVE_INFINITY;
      state.cancelled = false;
      state.planSpend = 72_000;
      state.slopePerDollar = -1e-5;
      state.quality = new Map();
      state.noise = () => 0;
      state.success = null;
    },

    /** Every seed this (plan, spend, paths) combination was ever scored on. */
    seedsFor(plan: string, spend: number, paths?: number): number[] {
      return state.calls
        .filter(
          (c) => c.plan === plan && c.spend === spend && (paths === undefined || c.paths === paths),
        )
        .map((c) => c.seed);
    },

    plansAt(paths: number): Set<string> {
      return new Set(state.calls.filter((c) => c.paths === paths).map((c) => c.plan));
    },
  };
  return state;
});

vi.mock('../../src/server/search/pool', () => {
  class FakePool {
    constructor(size: number) {
      world.poolSizes.push(size);
    }
    run(): Promise<never> {
      // Nothing should reach the pool: the fake evaluator answers everything.
      return Promise.reject(new Error('FakePool.run must not be called'));
    }
    async destroy(): Promise<void> {
      world.destroys += 1;
    }
  }

  class FakeEvaluator {
    evaluations = 0;
    cacheHits = 0;
    runKeyFor(req: { scenario: Scenario; paths: number; seed: number }): string {
      return `${world.planOf(req.scenario)}|${world.spendOf(req.scenario)}|${req.paths}|${req.seed}`;
    }
    async evaluate(req: { scenario: Scenario; paths: number; seed: number }) {
      const plan = world.planOf(req.scenario);
      const spend = world.spendOf(req.scenario);
      world.calls.push({ plan, spend, seed: req.seed, paths: req.paths });
      if (world.calls.length >= world.cancelAfter) world.cancelled = true;
      const key = `${plan}|${spend}|${req.paths}|${req.seed}`;
      const hit = world.memo.get(key);
      if (hit) {
        this.cacheHits += 1;
        return { score: hit, cached: true };
      }
      const score = world.scoreFor(plan, spend, req.seed);
      world.memo.set(key, score);
      this.evaluations += 1;
      return { score, cached: false };
    }
  }

  return {
    SimPool: FakePool,
    CachedEvaluator: FakeEvaluator,
    defaultPoolSize: () => 4,
  };
});

// Imported AFTER the mock declaration; vitest hoists vi.mock above it.
import { DEFAULT_BUDGET, runSearch } from '../../src/server/search/execute';
import { compileCandidate, planHash, planSpendAnnual } from '../../src/server/search/compile';
import { BASELINE_ASSIGNMENT, enumerateAll, oneKnobNeighbours } from '../../src/server/search/sample';
import { pairedDelta } from '../../src/server/search/stats';
import { runSimulation } from '../../src/engine/simulate';
import { withSpend } from '../../src/server/search/compile';

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

let tmpDir: string;
let prevEnv: string | undefined;
let profile: Profile;
let assumptions: Assumptions;

beforeAll(async () => {
  prevEnv = process.env.FPLAN_DATA_DIR;
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fplan-search-'));
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

beforeEach(() => {
  world.reset();
});

afterEach(() => {
  // Every pool a search opened must be destroyed, however that search ended.
  // Threads that outlive their search are how a twenty-minute run leaves a
  // machine with forty idle workers on it.
  expect(world.destroys).toBe(world.poolSizes.length);
});

/** The user's plan as it stands: retire mid-2033, claim at FRA. */
function basePlan(): Scenario {
  return {
    name: 'Plan',
    events: [
      { type: 'retire', person: 'p1', date: '2033-06' },
      { type: 'retire', person: 'p2', date: '2033-06' },
      // The starter's p1 is born 1975-03, so FRA 67 is 2042-03. The base plan
      // claims AT FRA on purpose: the claimAge axis's 67 level is then the
      // incumbent decision, which is what makes "revert this axis" a real
      // no-op and lets the inert/attribution logic be tested at all.
      { type: 'claim_social_security', person: 'p1', date: '2042-03' },
      { type: 'claim_social_security', person: 'p2', date: '2042-03' },
    ],
  } as Scenario;
}

interface Ran {
  report: SearchReport;
  /** Every progress patch, in order. */
  patches: Array<Partial<SearchProgress>>;
  /** The progress as it stood at the end. */
  progress: Partial<SearchProgress>;
}

/** Run a search against the simulated world, recording everything it emitted. */
async function run(request: SearchRequest, id = 'testsearch01'): Promise<Ran> {
  const patches: Array<Partial<SearchProgress>> = [];
  let progress: Partial<SearchProgress> = {};
  const report = await runSearch(
    id,
    request,
    { profile, assumptions },
    {
      update(patch) {
        patches.push(patch);
        progress = { ...progress, ...patch };
      },
      cancelled: () => world.cancelled,
    },
  );
  return { report, patches, progress };
}

/** A small, fast budget: the executor's logic does not care about path counts. */
function budget(overrides: Partial<SearchRequest['budget']> = {}) {
  return {
    candidates: 16,
    enumerate: true,
    eta: 4,
    finalists: 3,
    screenPaths: 200,
    racePaths: 400,
    reportPaths: 400,
    selectionSeedCount: 4,
    reportSeedCount: 6,
    seedBase: 1000,
    attribution: false,
    polish: false,
    polishSeedCount: 2,
    widowProbe: false,
    workers: 2,
    ...overrides,
  };
}

/** The plan key (as the fake sees it) for one point in the space. */
function planKeyOf(base: Scenario, axes: SearchAxis[], assignment: Record<string, number>): string {
  return world.planOf(compileCandidate(profile, base, axes, assignment));
}

// ---------------------------------------------------------------------------
// (b) The space it says it searched is the space it searched
// ---------------------------------------------------------------------------

describe('the executor searches the space it reports searching', () => {
  const axes: SearchAxis[] = [
    { dim: 'retireYear', levels: [2029, 2031, 2033] },
    { dim: 'stockShare', levels: [0.5, 0.7] },
  ];

  it('evaluates every distinct plan in an exhaustive space, and says so', async () => {
    const { report } = await run({ base: basePlan(), axes, budget: budget() });

    // The draws: the incumbent, its one-knob neighbours, and every cell.
    const drawn = [BASELINE_ASSIGNMENT, ...oneKnobNeighbours(axes), ...enumerateAll(axes, 4096)];
    expect(report.candidatesGenerated).toBe(drawn.length);
    expect(report.candidatesGenerated).toBe(1 + (3 + 2) + 6);

    // ... deduped by what they actually compile to. Canonicalisation is the
    // honest denominator: two candidates differing only in a knob that cannot
    // act are one plan, and counting them twice would overstate the search.
    const distinct = new Set(
      drawn.map((a) => planHash(compileCandidate(profile, basePlan(), axes, a))),
    );
    expect(report.distinctPlans).toBe(distinct.size);
    expect(report.rounds[0].candidates).toBe(distinct.size);

    // And every one of them was really simulated in round 1 — no silent drop.
    const screened = world.plansAt(200);
    const expected = new Set(
      drawn.map((a) => planKeyOf(basePlan(), axes, a as Record<string, number>)),
    );
    for (const plan of expected) expect(screened).toContain(plan);

    expect(report.caveats.join(' ')).toMatch(
      /Every one of the 6 combinations in this space was tried/,
    );
  });

  it('narrows through the rounds it published, ending on the finalist count', async () => {
    const { report } = await run({ base: basePlan(), axes, budget: budget({ finalists: 2 }) });

    expect(report.rounds.length).toBeGreaterThan(0);
    for (let i = 1; i < report.rounds.length; i++) {
      // The chain has to be unbroken: what one round kept is what the next ran.
      expect(report.rounds[i].candidates).toBe(report.rounds[i - 1].keep);
    }
    for (const r of report.rounds) {
      expect(r.status).toBe('done');
      expect(r.keep).toBeLessThanOrEqual(r.candidates);
      expect(r.probeSpend).toBeGreaterThan(0);
      expect(r.saturatedFraction).toBeGreaterThanOrEqual(0);
    }
    const lastKeep = report.rounds[report.rounds.length - 1].keep;
    // The baseline is measured separately, so it does not occupy a finalist slot.
    expect(report.finalists.length).toBeGreaterThan(0);
    expect(report.finalists.length).toBeLessThanOrEqual(lastKeep);
    expect(report.finalists.map((f) => f.rank)).toEqual(
      report.finalists.map((_, i) => i + 1),
    );
  });

  it('reports honest coverage when it sampled instead of enumerating', async () => {
    const wide: SearchAxis[] = [
      { dim: 'retireYear', levels: [2028, 2029, 2030, 2031] },
      { dim: 'stockShare', levels: [0.4, 0.6, 0.8, 1.0] },
      { dim: 'claimAge', levels: [62, 67, 70] },
    ];
    const { report } = await run({
      base: basePlan(),
      axes: wide,
      budget: budget({ enumerate: false, candidates: 12 }),
    });

    const coverage = report.caveats.find((c) => c.includes('combinations'));
    expect(coverage).toBeDefined();
    // 48 cells in the product; a 12-draw sample cannot have tried them all, and
    // the caveat must name both numbers rather than implying completeness.
    expect(coverage).toMatch(/of 48 combinations were tried/);
    expect(coverage).not.toMatch(/Every one of/);
    expect(coverage).toMatch(/not a global optimum/);
    const tried = Number(/^(\d+) of 48/.exec(coverage as string)?.[1]);
    expect(tried).toBeGreaterThan(0);
    expect(tried).toBeLessThanOrEqual(12);
    expect(report.candidatesGenerated).toBe(1 + (4 + 4 + 3) + 12);
  });

  it('makes the enumeration cap visible instead of quietly searching a prefix', async () => {
    // 5,184 cells against a 4,096 hard cap. What gets tried is the first 4,096
    // in axis order, which is emphatically NOT a representative sample — so the
    // report has to say that, in those words.
    const huge: SearchAxis[] = [
      { dim: 'retireYear', levels: Array.from({ length: 24 }, (_, i) => 2027 + i) },
      { dim: 'claimAge', levels: [62, 63, 64, 65, 66, 67, 68, 69, 70] },
      { dim: 'stockShare', levels: [0.4, 0.6, 0.8] },
      { dim: 'moveOffsetYears', levels: [0, 1, 2, 3, 4, 5, 6, 7] },
    ];
    const { report } = await run({
      base: basePlan(),
      axes: huge,
      budget: budget({ enumerate: true, finalists: 2, selectionSeedCount: 2, reportSeedCount: 2 }),
    });

    const capped = report.caveats.find((c) => c.includes('enumeration stops'));
    expect(capped).toBeDefined();
    expect(capped).toMatch(/5,184 cells/);
    expect(capped).toMatch(/4,096/);
    expect(capped).toMatch(/NOT a\s+representative sample/);
    expect(report.candidatesGenerated).toBe(1 + (24 + 9 + 3 + 8) + 4096);
    expect(report.distinctPlans).toBeLessThanOrEqual(report.candidatesGenerated);
  }, 30_000);
});

// ---------------------------------------------------------------------------
// (c) THE NOISE DISCIPLINE
// ---------------------------------------------------------------------------

describe('noise discipline: the held-out pass overrules the screen', () => {
  const axes: SearchAxis[] = [
    { dim: 'retireYear', levels: [2029, 2031, 2033] },
    { dim: 'stockShare', levels: [0.5, 0.7] },
  ];

  /**
   * LUCKY is a mediocre plan that draws +8pp of luck on every selection seed
   * and -2pp on every report seed. SOLID is genuinely the better plan by 3pp
   * and has no luck at all. A search that quoted its own screening score would
   * crown LUCKY; this is the whole reason the report stage exists.
   */
  function riggedWorld(): { lucky: string; solid: string } {
    const lucky = planKeyOf(basePlan(), axes, { retireYear: 0, stockShare: 0 });
    const solid = planKeyOf(basePlan(), axes, { retireYear: 1, stockShare: 1 });
    expect(lucky).not.toBe(solid);

    world.quality.set(lucky, 0.0);
    world.quality.set(solid, 0.03);
    // Selection seeds are seedBase+1..; report seeds are seedBase+1,000,001..
    world.noise = (plan, seed) => {
      if (plan !== lucky) return 0;
      return seed < 1_000_000 ? 0.08 : -0.02;
    };
    return { lucky, solid };
  }

  it('picks the plan that wins on held-out seeds, not the one that won the screen', async () => {
    const { lucky, solid } = riggedWorld();
    const { report, patches } = await run({
      base: basePlan(),
      axes,
      budget: budget({ finalists: 3 }),
    });

    // The screen really was fooled: on the selection seeds LUCKY led the board.
    const screeningBoards = patches
      .map((p) => p.leaderboard)
      .filter((b): b is NonNullable<typeof b> => Array.isArray(b) && b.length > 0)
      .filter((b) => b[0].screeningEstimate);
    expect(screeningBoards.length).toBeGreaterThan(0);
    const lastScreen = screeningBoards[screeningBoards.length - 1];
    expect(lastScreen[0].label).toBe('retire 2029 - 50/50');

    // And the report overruled it. Ranking is by the paired delta on the
    // held-out seeds, so SOLID wins and LUCKY is demoted.
    const winner = report.finalists[0];
    expect(winner.assignment).toEqual({ retireYear: 2031, stockShare: 0.7 });
    expect(winner.rank).toBe(1);
    const luckyRow = report.finalists.find((f) => f.label === 'retire 2029 - 50/50');
    expect(luckyRow).toBeDefined();
    expect(luckyRow?.rank).toBeGreaterThan(1);
    expect((winner.delta?.mean as number)).toBeGreaterThan(luckyRow?.delta?.mean as number);

    // The screening score is still on the row, clearly marked as what it is.
    expect(world.planOf(winner.scenario)).toBe(solid);
    expect(world.planOf(luckyRow?.scenario as Scenario)).toBe(lucky);
  });

  it('never lets a selection seed touch a reported number', async () => {
    riggedWorld();
    const { report } = await run({ base: basePlan(), axes, budget: budget() });

    const selection = new Set(report.seeds.selection);
    const reportSeeds = new Set(report.seeds.report);
    expect(selection.size).toBe(4);
    expect(reportSeeds.size).toBe(6);
    // Disjoint, by construction and in fact.
    for (const s of selection) expect(reportSeeds.has(s)).toBe(false);

    for (const f of [report.baseline, ...report.finalists]) {
      for (const stat of [f.probeSuccess, f.successAtPlanSpend, f.sustainableSpend]) {
        if (!stat) continue;
        expect(stat.n).toBe(report.seeds.report.length);
      }
      if (f.delta) {
        expect(f.delta.n).toBe(report.seeds.report.length);
        expect(f.delta.note).toContain('6 held-out seeds');
      }
    }

    // The curse is quantified in the user's language, not left implicit.
    const heldOut = report.caveats.find((c) => c.includes('pure luck'));
    expect(heldOut).toBeDefined();
    expect(heldOut).toMatch(/Selection used seeds 1001-1004/);

    // And it does NOT overclaim. The caveat used to say the report seeds "chose
    // nothing", which is false: the screen picks the FIELD, but the ranking,
    // the winner and the tie bracket are all decided on the held-out seeds.
    // Rank 1 therefore still carries the optimism of having been picked — a
    // smaller curse than the screen's, not zero — and a reader told otherwise
    // would quote the top row as if it needed no bracket at all.
    expect(heldOut).not.toMatch(/chose nothing/);
    expect(heldOut).toMatch(/winner and the tie bracket are all decided on these\s+seeds/);
  });

  it('re-runs every finalist on all the report seeds, at the report path count', async () => {
    riggedWorld();
    const { report } = await run({ base: basePlan(), axes, budget: budget() });

    for (const f of [report.baseline, ...report.finalists]) {
      const plan = world.planOf(f.scenario);
      const seeds = world.seedsFor(plan, report.calibration.probeSpend, 400);
      // Every report seed, and nothing but report seeds, at reporting precision.
      expect([...new Set(seeds)].sort((a, b) => a - b)).toEqual(report.seeds.report);
    }
  });

  it('shows a one-seed row with no error bar rather than a fabricated one', async () => {
    riggedWorld();
    const { patches, report } = await run({ base: basePlan(), axes, budget: budget() });

    const boards = patches
      .map((p) => p.leaderboard)
      .filter((b): b is NonNullable<typeof b> => Array.isArray(b) && b.length > 0);
    const oneSeed = boards.flat().filter((r) => r.seeds === 1);
    expect(oneSeed.length).toBeGreaterThan(0);
    for (const row of oneSeed) {
      // A single observation licenses no interval; "± 0" would read as infinite
      // precision on the least precise row in the table.
      expect(row.ci95HalfWidth).toBeUndefined();
      expect(row.screeningEstimate).toBe(true);
      expect(row.sd).toBe(0);
    }

    const multiSeed = boards.flat().filter((r) => r.seeds > 1 && r.screeningEstimate);
    for (const row of multiSeed) expect(row.ci95HalfWidth).toBeGreaterThanOrEqual(0);

    // The final board is not a screening estimate at all.
    const finalBoard = boards[boards.length - 1];
    expect(finalBoard.every((r) => r.screeningEstimate === false)).toBe(true);
    expect(finalBoard.map((r) => r.id)).toEqual(report.finalists.map((f) => f.id));
  });

  it('reports two plans it cannot separate as the same plan, not as a ranking', async () => {
    // Two structurally different plans with identical quality and identical
    // luck: whatever the seeds do, they do it to both.
    const twinA = planKeyOf(basePlan(), axes, { retireYear: 0, stockShare: 0 });
    const twinB = planKeyOf(basePlan(), axes, { retireYear: 0, stockShare: 1 });
    expect(twinA).not.toBe(twinB);
    world.quality.set(twinA, 0.04);
    world.quality.set(twinB, 0.04);
    world.noise = (_plan, seed) => (seed % 2 === 0 ? 0.01 : -0.01);

    const { report } = await run({
      base: basePlan(),
      axes,
      budget: budget({ finalists: 3 }),
    });

    const a = report.finalists.find((f) => world.planOf(f.scenario) === twinA);
    const b = report.finalists.find((f) => world.planOf(f.scenario) === twinB);
    expect(a).toBeDefined();
    expect(b).toBeDefined();

    // The bracket is the complete set of indistinguishable plans, INCLUDING the
    // winner's own id — that is what the UI needs to draw it.
    expect(report.tieBracket).toContain(report.finalists[0].id);
    expect(report.tieBracket).toContain(a?.id);
    expect(report.tieBracket).toContain(b?.id);
    // ... but "tied with the winner" is nonsense on the winner's own row.
    expect(report.finalists[0].tiedWithWinner).toBe(false);
    const runnerUp = report.finalists[1];
    expect(runnerUp.tiedWithWinner).toBe(true);

    // And it is a FINDING, not a shrug. Each row carries its per-seed values
    // precisely so the comparison can be re-paired later; re-pairing them here
    // says "these are the same plan", which is a different sentence from "we
    // did not measure this well enough", and the two must never be conflated.
    const left = a?.sustainableSpend?.values as number[];
    const right = b?.sustainableSpend?.values as number[];
    expect(left).toHaveLength(report.seeds.report.length);
    expect(right).toHaveLength(report.seeds.report.length);
    const head = pairedDelta(left, right, {
      practicalFloor: report.objective.practicalFloor,
      format: (v) => `$${Math.abs(Math.round(v))}/yr`,
    });
    expect(head.verdict).toBe('equivalent');
    expect(head.note).toMatch(/same plan/);
    expect(head.note).not.toMatch(/INCONCLUSIVE/);

    // Their deltas against the common baseline agree to the dollar, which is
    // what "indistinguishable" means here — not that either is a null result.
    expect(a?.delta?.mean).toBeCloseTo(b?.delta?.mean as number, 6);
    expect(a?.delta?.verdict).toBe(b?.delta?.verdict);
  });

  it('ranks a plan that fails at its own spending below every plan that does not', async () => {
    // A greedy plan: enormous notional headroom at the screening stress level,
    // but it cannot clear the household's success target on the money the
    // household actually spends. Gate 1 is enforced, not merely measured.
    const greedy = planKeyOf(basePlan(), axes, { retireYear: 0, stockShare: 0 });
    const honest = planKeyOf(basePlan(), axes, { retireYear: 1, stockShare: 1 });
    world.success = (plan, spend) => {
      if (plan === greedy) return 0.8 + (spend - 72_000) * 1.2e-5;
      return 1 - 1e-5 * (spend - 72_000) + (plan === honest ? 0.02 : 0);
    };

    const { report } = await run({
      base: basePlan(),
      axes,
      budget: budget({ finalists: 3 }),
      objective: { metric: 'sustainable_spend', probeSpend: 87_000, practicalFloor: 500 },
    });

    const greedyRow = report.finalists.find((f) => world.planOf(f.scenario) === greedy);
    expect(greedyRow).toBeDefined();
    expect(greedyRow?.feasible).toBe(false);
    // It scored higher than everyone and still lost.
    expect(greedyRow?.sustainableSpend?.mean).toBeGreaterThan(
      report.finalists[0].sustainableSpend?.mean as number,
    );
    expect(greedyRow?.rank).toBeGreaterThan(1);
    for (const f of report.finalists) {
      if (f.feasible) expect(f.rank).toBeLessThan(greedyRow?.rank as number);
    }
    expect(report.finalists[0].feasible).toBe(true);
    expect(report.caveats.join(' ')).toMatch(/do not reach the 85% success target/);
  });

  it('raises the screening spend when the field saturates, and says the rounds are not comparable', async () => {
    // Every candidate is strong enough to score a flat 100% at a probe
    // calibrated on the INCUMBENT — five more years of salary moves sustainable
    // spending by tens of thousands, far more than the calibration ladder ever
    // explores. A round that cannot separate its field is not racing, it is
    // shuffling.
    const incumbent = planKeyOf(basePlan(), axes, {});
    world.success = (plan, spend) =>
      1 - 1e-5 * (spend - 72_000) + (plan === incumbent ? 0 : 0.25);

    const { report } = await run({
      base: basePlan(),
      axes,
      budget: budget({ finalists: 2 }),
    });

    const saturatedRound = report.rounds.find((r) => (r.saturatedFraction ?? 0) > 0.25);
    expect(saturatedRound).toBeDefined();
    const probes = report.rounds.map((r) => r.probeSpend as number);
    expect(Math.max(...probes)).toBeGreaterThan(probes[0]);
    const raised = report.caveats.find((c) => c.includes('screening spend was raised'));
    expect(raised).toBeDefined();
    expect(raised).toMatch(/not comparable to one another/);
  });

  it('leaves an explicitly requested screening spend exactly where the caller put it', async () => {
    const incumbent = planKeyOf(basePlan(), axes, {});
    world.success = (plan, spend) =>
      1 - 1e-5 * (spend - 72_000) + (plan === incumbent ? 0 : 0.25);
    const { report } = await run({
      base: basePlan(),
      axes,
      budget: budget({ finalists: 2 }),
      objective: { metric: 'sustainable_spend', probeSpend: 90_000 },
    });
    // The caller asked a specific question ("rank these at $90,000/yr"); moving
    // the probe would answer a different one.
    for (const r of report.rounds) expect(r.probeSpend).toBe(90_000);
    expect(report.caveats.join(' ')).not.toMatch(/screening spend was raised/);
  });
});

// ---------------------------------------------------------------------------
// (d) Attribution is paired, against a common baseline, on shared seeds
// ---------------------------------------------------------------------------

describe('attribution', () => {
  const axes: SearchAxis[] = [
    { dim: 'retireYear', levels: [2029, 2033] },
    { dim: 'claimAge', levels: [67, 70] },
    { dim: 'autoSepp', levels: [true, false] },
  ];

  async function attributed() {
    // Retiring 2029 and claiming at 70 are both real gains, so the winner moves
    // two knobs and the two attribution columns have something to disagree about.
    world.quality = new Map();
    world.noise = (plan) => {
      let q = 0;
      if (plan.includes('2029-06')) q += 0.04;
      // Claiming at 70 for the starter's p1 (born 1975-03) compiles to 2045-03.
      if (plan.includes('2045-03')) q += 0.02;
      return q;
    };
    return run({
      base: basePlan(),
      axes,
      budget: budget({ finalists: 3, attribution: true, polish: true, polishSeedCount: 3 }),
    });
  }

  it('measures both columns against the same baseline on the same held-out seeds', async () => {
    const { report } = await attributed();
    expect(report.attribution.length).toBe(axes.length);

    const probe = report.calibration.probeSpend;
    const reportSeeds = [...report.seeds.report].sort((a, b) => a - b);
    const winnerPlan = world.planOf(report.finalists[0].scenario);
    const baselinePlan = world.planOf(report.baseline.scenario);

    // The two ends of every paired comparison in the report: the winner and the
    // incumbent, each scored on the identical seed list at the identical path
    // count and the identical spending level. If those lists ever diverged, the
    // "paired" delta would silently be a difference of independently seeded
    // levels — which is precisely the mistake the whole design exists to avoid.
    for (const plan of [winnerPlan, baselinePlan]) {
      const seeds = [...new Set(world.seedsFor(plan, probe, 400))].sort((a, b) => a - b);
      expect(seeds).toEqual(reportSeeds);
    }

    let checked = 0;
    for (const row of report.attribution) {
      if (row.inert) continue;
      for (const delta of [row.insideWinner, row.onOwn]) {
        if (!delta) continue;
        checked += 1;
        expect(delta.n).toBe(reportSeeds.length);
        expect(delta.note).toContain('6 held-out seeds');
        // Slope-converted: rankable, not quotable, and flagged as such.
        expect(delta.approximate).toBe(true);
        expect(delta.note).toMatch(/good enough to rank, not to quote/);
      }
    }
    // Guard against the loop above quietly checking nothing.
    expect(checked).toBeGreaterThanOrEqual(3);
    expect(report.caveats.join(' ')).toMatch(/only\s+those dollar figures are quotable/);
  });

  it('scores every revert-one and add-one variant on the full report seed set', async () => {
    const { report } = await attributed();
    const probe = report.calibration.probeSpend;
    const reportSeeds = [...report.seeds.report].sort((a, b) => a - b);
    const winnerAssignment = report.finalists[0].assignment;
    let checked = 0;

    for (const axis of axes) {
      const row = report.attribution.find((r) => r.dim === axis.dim);
      if (!row || row.inert) continue;

      // Rebuild the exact two comparison plans the executor should have run.
      const chosen = Object.fromEntries(
        axes
          .map((a, i) => [a.dim, a.levels.findIndex((l) => l === winnerAssignment[a.dim]), i])
          .filter(([, idx]) => (idx as number) >= 0)
          .map(([dim, idx]) => [dim as string, idx as number]),
      ) as Record<string, number>;

      const reverted = { ...chosen };
      delete reverted[axis.dim];
      const alone =
        chosen[axis.dim] !== undefined ? { [axis.dim]: chosen[axis.dim] } : {};

      for (const [delta, assignment] of [
        [row.insideWinner, reverted],
        [row.onOwn, alone],
      ] as const) {
        if (!delta) continue;
        const plan = planKeyOf(basePlan(), axes, assignment as Record<string, number>);
        const seeds = [...new Set(world.seedsFor(plan, probe, 400))].sort((a, b) => a - b);
        expect(seeds).toEqual(reportSeeds);
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThanOrEqual(3);
  });

  it('separates "the question does not arise" from "the search tried it and it lost"', async () => {
    // Retiring 2038 is past the penalty-free year of BOTH starter people (p2,
    // born 1977-09, attains 59 1/2 in 2037 and is penalty-free from 2038), so
    // with the rest of the plan at the winner's settings the 72(t) knob is
    // DISCONNECTED: every level of it compiles to the same plan. That is a
    // different statement from "the winner left this alone", and the two must
    // never share a label. Both levels have to clear the LATER person — a level
    // that clears only p1 leaves the bridge live and this test green for the
    // wrong reason.
    world.quality = new Map();
    world.noise = (plan) => (plan.includes('2038-06') ? 0.05 : 0);

    const { report } = await run({
      base: basePlan(),
      axes: [
        { dim: 'retireYear', levels: [2038, 2039] },
        { dim: 'autoSepp', levels: [true, false] },
        { dim: 'claimAge', levels: [67, 70] },
      ],
      budget: budget({ finalists: 3, attribution: true, polish: false }),
    });

    const sepp = report.attribution.find((r) => r.dim === 'autoSepp');
    expect(sepp?.inert).toBe(true);
    expect(sepp?.note).toMatch(/question does not arise/);
    expect(sepp?.insideWinner).toBeUndefined();
    expect(sepp?.onOwn).toBeUndefined();

    // Claiming age is NOT inert: the search compiled both levels, ran them, and
    // the plan's own answer stood. Reporting that as "does not arise" was a real
    // bug — it told the user a decision they can act on is not a decision.
    const claim = report.attribution.find((r) => r.dim === 'claimAge');
    expect(claim?.inert).toBeUndefined();
    expect(claim?.note).not.toMatch(/question does not arise/);
  });

  it('reports the interaction residual instead of pretending the parts add up', async () => {
    // A world with a REAL interaction, whose size this file knows exactly:
    // retiring 2029 is worth +4pp alone, claiming at 70 is worth +2pp alone,
    // and doing both is worth +9pp — three points more than the sum of the
    // parts. The report must surface that three points rather than quietly
    // distributing it over the rows.
    const pair: SearchAxis[] = [
      { dim: 'retireYear', levels: [2029, 2033] },
      { dim: 'claimAge', levels: [67, 70] },
    ];
    world.success = (plan, spend) => {
      const early = plan.includes('2029-06');
      const late = plan.includes('2045-03');
      const bonus = early && late ? 0.09 : early ? 0.04 : late ? 0.02 : 0;
      return 1 - 1e-5 * (spend - 72_000) + bonus;
    };

    const { report } = await run({
      base: basePlan(),
      axes: pair,
      budget: budget({ finalists: 3, attribution: true, polish: false }),
    });

    expect(report.finalists[0].assignment).toEqual({ retireYear: 2029, claimAge: 70 });
    const byDim = Object.fromEntries(report.attribution.map((r) => [r.dim, r]));
    // Attribution figures are success converted to dollars at 1pp per
    // $1,000/yr, so 4pp on its own reads as $4,000/yr.
    expect(byDim.retireYear.onOwn?.mean).toBeCloseTo(4000, 6);
    expect(byDim.claimAge.onOwn?.mean).toBeCloseTo(2000, 6);
    // Inside the winner each knob is worth more than it is alone: that is what
    // "this decision has a partner" means, and the note says so.
    expect(byDim.retireYear.insideWinner?.mean).toBeCloseTo(7000, 6);
    expect(byDim.claimAge.insideWinner?.mean).toBeCloseTo(5000, 6);

    // 9pp total minus (4pp + 2pp) of parts = 3pp = $3,000/yr unexplained.
    expect(report.interactionResidual).toBeCloseTo(3000, 6);
    const sumOfParts = report.attribution.reduce((s, r) => s + (r.onOwn?.mean ?? 0), 0);
    expect(sumOfParts).toBeCloseTo(6000, 6);
  });

  it('reports a residual of nothing when the decisions really are additive', async () => {
    const { report } = await attributed();
    expect(report.interactionResidual).toBeDefined();
    // The `attributed` world is exactly additive, so the parts DO add up here —
    // which is the control that proves the residual above is measuring the
    // interaction and not an artefact of the arithmetic.
    expect(Math.abs(report.interactionResidual as number)).toBeLessThan(1);
  });

  it('certifies the winner against its neighbours, and says so when one beats it', async () => {
    const { report } = await attributed();
    const withLevels = report.attribution.filter((r) => r.levels && r.levels.length > 0);
    expect(withLevels.length).toBeGreaterThan(0);
    for (const row of withLevels) {
      for (const level of row.levels ?? []) {
        expect(level.label.length).toBeGreaterThan(0);
        expect(level.delta.n).toBe(3);
        expect(level.delta.note).toContain('3 held-out seeds');
      }
    }
    // The polish pass found nothing better here, so no "not a local optimum"
    // caveat — the winner really is the top of its neighbourhood.
    expect(report.caveats.join(' ')).not.toMatch(/NOT a local optimum/);
  });
});

// ---------------------------------------------------------------------------
// (e) Cancellation
// ---------------------------------------------------------------------------

describe('cancellation', () => {
  const axes: SearchAxis[] = [
    { dim: 'retireYear', levels: [2029, 2030, 2031, 2032] },
    { dim: 'stockShare', levels: [0.4, 0.6, 0.8] },
    { dim: 'claimAge', levels: [62, 67, 70] },
  ];

  it('stops the run, tears down the pool, and still writes a labelled partial report', async () => {
    world.cancelAfter = 40;
    const { report, progress } = await run({
      base: basePlan(),
      axes,
      budget: budget({ enumerate: true, finalists: 3, attribution: true, polish: true }),
    });

    expect(report.truncated).toBe(true);
    // The warning is FIRST, because everything under it is provisional.
    expect(report.caveats[0]).toMatch(/^CANCELLED before the search finished/);
    expect(report.caveats[0]).toMatch(/must not be\s+acted on/);

    // It really stopped: a full run of this space is many hundreds of
    // evaluations, and cancelling at 40 finishes the batch in flight and no more.
    expect(world.calls.length).toBeGreaterThanOrEqual(40);
    expect(world.calls.length).toBeLessThan(200);

    // Threads gone (asserted for every test in afterEach), and the report is
    // still a report: it has its baseline, its space, and its seeds.
    expect(report.searchId).toBe('testsearch01');
    expect(report.baseline).toBeDefined();
    expect(report.axes).toEqual(axes);
    expect(report.seeds.selection.length).toBe(4);
    expect(report.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(progress.stage).not.toBe('done');
  });

  it('overruns a cancel by at most one chunk — the chunking IS the latency bound', async () => {
    // The executor submits evaluations in chunks of max(8, workers x 4) and
    // checks the cancel flag between chunks; that chunk size exists for
    // exactly this property (execute.ts: "chunked at 4x the pool so
    // cancellation is responsive"). The loose < 200 bound above catches "never
    // stopped" but would NOT catch a ballooned chunk that submits a whole
    // screening round at once — a mutation that makes a mid-round cancel cost
    // minutes at real path counts while every shape assertion stays green. So
    // pin the overrun itself: with workers=2 the chunk is 8, the flag flips at
    // evaluation 40, and everything after it must fit inside the one chunk
    // already in flight (later batches check the flag before submitting).
    world.cancelAfter = 40;
    const { report } = await run({
      base: basePlan(),
      axes,
      budget: budget({ enumerate: true, finalists: 3, workers: 2 }),
    });

    expect(report.truncated).toBe(true);
    expect(world.calls.length).toBeGreaterThanOrEqual(40);
    expect(world.calls.length).toBeLessThanOrEqual(40 + 8);
  });

  it('cancels cleanly before anything at all has been measured', async () => {
    world.cancelAfter = 1;
    const { report } = await run({ base: basePlan(), axes, budget: budget() });

    expect(report.truncated).toBe(true);
    expect(report.finalists).toEqual([]);
    // A placeholder baseline rather than a crash or a half-built object.
    expect(report.baseline.id).toBe('baseline');
    expect(report.baseline.feasible).toBe(false);
    expect(report.baseline.rank).toBe(0);
    expect(report.calibration.ladder.length).toBeLessThanOrEqual(3);
    expect(world.calls.length).toBeLessThan(40);
  });

  it('carries the rounds it did finish, so a partial answer can still be read', async () => {
    world.cancelAfter = 120;
    const { report } = await run({
      base: basePlan(),
      axes,
      budget: budget({ enumerate: true, finalists: 3 }),
    });

    expect(report.truncated).toBe(true);
    const done = report.rounds.filter((r) => r.status === 'done');
    expect(done.length).toBeGreaterThan(0);
    for (const r of done) {
      expect(r.probeSpend).toBeGreaterThan(0);
      expect(r.saturatedFraction).toBeGreaterThanOrEqual(0);
    }
    // Anything it never got to is still visibly pending, not silently dropped.
    for (const r of report.rounds) expect(['pending', 'running', 'done']).toContain(r.status);
  });
});

// ---------------------------------------------------------------------------
// Bookkeeping the user reads
// ---------------------------------------------------------------------------

describe('bookkeeping', () => {
  const axes: SearchAxis[] = [
    { dim: 'retireYear', levels: [2029, 2031, 2033] },
    { dim: 'stockShare', levels: [0.5, 0.7] },
  ];

  it('accounts for every simulation as either an evaluation or a cache hit', async () => {
    const { report } = await run({ base: basePlan(), axes, budget: budget() });
    expect(report.evaluations + report.cacheHits).toBe(world.calls.length);
    // Re-asking for a configuration already computed is free, and that is the
    // entire economy of re-running a search over an overlapping space.
    expect(report.cacheHits).toBeGreaterThan(0);
    expect(report.evaluations).toBeGreaterThan(0);
  });

  it('stamps the report with the engine that produced it and a stable space hash', async () => {
    const first = await run({ base: basePlan(), axes, budget: budget() }, 'searchaaaa1');
    world.reset();
    const second = await run({ base: basePlan(), axes, budget: budget() }, 'searchbbbb2');
    expect(first.report.engineVersion).toMatch(/^\d+\.\d+\.\d+$/);
    expect(first.report.spaceHash).toBe(second.report.spaceHash);
    expect(first.report.searchId).not.toBe(second.report.searchId);
    // Reproducible: the same world, the same space, the same answer.
    expect(second.report.finalists.map((f) => f.label)).toEqual(
      first.report.finalists.map((f) => f.label),
    );
  });

  it('measures the plan before it searches, and reports what it measured', async () => {
    const { report } = await run({ base: basePlan(), axes, budget: budget() });
    const cal = report.calibration;
    expect(cal.planSpend).toBe(planSpendAnnual(profile, basePlan()));
    expect(cal.ladder).toHaveLength(3);
    expect(cal.ladder[0].spend).toBe(cal.planSpend);
    // The model's slope is exactly -1pp per $1,000/yr; the calibration has to
    // recover it, because every dollar figure in the report is scaled by it.
    expect(cal.successPerThousand).toBeCloseTo(-0.01, 6);
    expect(cal.probeSpend).toBeGreaterThan(cal.planSpend);
    // Saturation at the plan's own spending is called out rather than shown as
    // a probability of 100%.
    expect(report.caveats.join(' ')).toMatch(/every path succeeds/);
  });

  /**
   * Reported figures come from the run at the PLAN'S OWN SPENDING.
   *
   * This used to be the probe run's, and it was a trap. Both runs happen — the
   * one at the plan's own spending is the feasibility gate — but only the probe
   * run's scores were kept, so `medianTerminalReal`, `charitableTotalReal` and
   * `worstDecileFirstShortfallYear` described a world in which the household
   * spends the SCREENING level: a stress spend the search invents to drag
   * success into a band where plans can be told apart. On an over-funded plan
   * that is tens of thousands a year above what is actually spent, so terminal
   * wealth was understated and the shortfall year pulled early. Nothing on the
   * row recorded the spending level, so a figure lifted into a saved scenario's
   * metrics sat next to a workbench figure computed at a different spend with
   * no field able to tell them apart.
   *
   * Ranking is unaffected: it reads `probe` and the bisected `spend`, never
   * these. The consistency argument for the probe run therefore bought nothing
   * that the plan-spend run does not also give — every finalist is still
   * measured at its own spending, which is the level the names claim.
   */
  it('measures terminal wealth and giving at the plan\'s own spend, not the probe', async () => {
    const { report } = await run({ base: basePlan(), axes, budget: budget() });
    const cal = report.calibration;
    // The two levels really are different, or this test proves nothing.
    expect(cal.probeSpend).toBeGreaterThan(cal.planSpend);

    for (const f of [report.baseline, ...report.finalists]) {
      const plan = world.planOf(f.scenario);
      const atProbe = world.scoreFor(plan, cal.probeSpend, report.seeds.report[0]);
      const atOwn = world.scoreFor(plan, cal.planSpend, report.seeds.report[0]);
      expect(atProbe.medianTerminalReal).not.toBe(atOwn.medianTerminalReal);
      expect(f.medianTerminalReal?.mean).toBeCloseTo(atOwn.medianTerminalReal, 6);
      expect(f.medianTerminalReal?.mean).not.toBeCloseTo(atProbe.medianTerminalReal, 0);
    }
  });

  it('carries a runnable, named plan on every finalist row', async () => {
    const { report } = await run({ base: basePlan(), axes, budget: budget() });
    for (const f of report.finalists) {
      expect(f.scenario.name).toBe(f.label.slice(0, 120));
      expect(f.scenario.events.length).toBeGreaterThan(0);
      expect(f.scenario.solver).toBeUndefined();
      expect(f.planHash).toHaveLength(16);
      // Saving it and re-running it must land on the very same cache entry, so
      // the hash has to be of the canonical plan, not of the renamed copy.
      expect(planHash({ ...f.scenario, name: 'candidate' } as Scenario)).toBe(f.planHash);
      // SearchFinalist.screenScore is declared but never written by the
      // executor. A UI that renders it will render nothing, every time.
      expect(f.screenScore).toBeUndefined();
    }
  });

  it('probes the survivor when asked, on the same held-out seeds', async () => {
    const { report } = await run({
      base: basePlan(),
      axes,
      budget: budget({ widowProbe: true, widowProbeYear: 2035 }),
    });
    for (const f of [report.baseline, ...report.finalists]) {
      expect(f.widowScore).toBeDefined();
      expect(f.widowScore?.n).toBe(report.seeds.report.length);
    }
    // The death really was written into the scenario that got scored.
    expect([...world.plansAt(400)].some((p) => p.includes('d=2035-07'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The precondition the pairing rests on, checked against the REAL engine
// ---------------------------------------------------------------------------

describe('the pairing precondition, on the real engine', () => {
  it('gives two different plans the same horizon and the same draw at one seed', async () => {
    const axes: SearchAxis[] = [
      { dim: 'retireYear', levels: [2029, 2034] },
      { dim: 'stockShare', levels: [0.4, 0.9] },
    ];
    const a = compileCandidate(profile, basePlan(), axes, { retireYear: 0, stockShare: 0 });
    const b = compileCandidate(profile, basePlan(), axes, { retireYear: 1, stockShare: 1 });
    // A stress level where the starter household's success is mid-range:
    // saturated plans (success pinned at 0 or 1) hide the very noise this test
    // is about, so the number matters and is re-derived whenever the starter
    // profile changes.
    const run1 = (s: Scenario, seed: number) =>
      runSimulation({
        profile,
        assumptions,
        scenario: withSpend(profile, s, 60_000),
        mode: 'montecarlo',
        paths: 40,
        seed,
      });

    // bootstrapPaths draws from (rows, horizon, paths, block years, seed,
    // expense ratios) and nothing scenario-dependent. The horizon comes from the
    // profile, so two candidates at one seed face bit-identical market futures —
    // which is why a paired difference is attributable to the decision.
    expect(run1(a, 101).horizonYears).toBe(run1(b, 101).horizonYears);

    // Determinism, which is what makes the run cache (and therefore every
    // paired re-comparison) legitimate.
    const twice = [run1(a, 101), run1(a, 101)];
    expect(twice[0].success).toBe(twice[1].success);
    expect(twice[0].medianTerminalReal).toBe(twice[1].medianTerminalReal);

    // And the seed really is doing something. This is the noise the entire
    // report stage exists to defend against: one plan, one spending level, four
    // seeds, and a spread far wider than any decision in the space is worth.
    const seeds = [101, 202, 303, 404].map((s) => run1(a, s).success);
    expect(new Set(seeds).size).toBeGreaterThan(1);
    expect(Math.max(...seeds) - Math.min(...seeds)).toBeGreaterThan(0.02);
  });
});

// ---------------------------------------------------------------------------
// Multiplicity in the tie bracket
// ---------------------------------------------------------------------------

describe('the tie bracket pays for its own comparisons', () => {
  const axes: SearchAxis[] = [
    { dim: 'retireYear', levels: [2029, 2031, 2033] },
    { dim: 'stockShare', levels: [0.5, 0.7] },
  ];

  /**
   * Six seed-by-seed margins with mean 0.05 and sample sd 0.045 — engineered to
   * land in the window where the correction is the whole story. Over 6 seeds
   * that is t = 2.72, p = 0.042: significant on its own, and NOT significant
   * once four such tests are run against the same winner (Holm: 0.042 x 4).
   */
  const MARGIN = [-0.0175, 0.01625, 0.05, 0.06125, 0.08375, 0.10625];

  function riggedField(): void {
    // The winner: retires 2029 at a 50/50 mix. Everything else is a rival, and
    // every rival trails by the same engineered margin.
    const isWinner = (plan: string): boolean =>
      plan.includes('2029-06') && plan.includes('s=0.500');
    world.success = (plan, spend, seed) => {
      const base = 1 + world.slopePerDollar * (spend - world.planSpend);
      if (isWinner(plan)) return base;
      return base - MARGIN[(seed - 1000) % MARGIN.length];
    };
  }

  it('keeps the whole indistinguishable field in the bracket, not just the top row', async () => {
    riggedField();
    const { report } = await run({
      base: basePlan(),
      axes,
      budget: budget({ finalists: 5 }),
      objective: { metric: 'success', practicalFloor: 0.001 },
    } as SearchRequest);

    const tied = report.finalists.filter((f) => f.rank > 1 && f.tiedWithWinner);
    // Every rival trails by a margin that only ONE test could call real. Run
    // four of them against the same winner and none survives the correction —
    // so the honest answer is a bracket, not a crown. Unadjusted, each rival
    // clears 0.05 on its own and the bracket collapses to the winner alone,
    // which is precisely the overconfident single winner this design exists to
    // avoid.
    expect(report.finalists.length).toBeGreaterThanOrEqual(4);
    expect(tied.length).toBe(report.finalists.length - 1);
  });
});

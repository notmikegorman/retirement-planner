/**
 * THE SEARCH EXECUTOR: successive halving over a balanced randomised sample,
 * finished with a coordinate-wise polish that doubles as the attribution table.
 *
 * The whole design answers one hazard, which the user named: a search
 * over a hundred combinations produces a winner that is partly luck, because
 * the maximum of a noisy sample is biased upward. Four mechanisms address it,
 * and none of them is optional.
 *
 * 1. TWO DISJOINT SEED SETS. Selection seeds choose; report seeds report. They
 *    never overlap. Selecting the best of k candidates and then quoting that
 *    same evaluation keeps the favourable half of the noise: at k = 64 and the
 *    measured 4,000-path sd of 0.74pp that is +1.79pp of pure luck, and at
 *    k = 1,024 on one screening seed it is +6.5pp — larger than any real effect
 *    in this space. Re-running the winner on the SAME seeds does not fix it;
 *    the bias is in the selection, not the precision. Held-out seeds fix it
 *    completely, and cheaply. This is the single most important line here.
 *
 * 2. PAIRED DELTAS, NEVER LEVELS. Every reported comparison is a per-seed
 *    difference against a common baseline. bootstrapPaths() depends only on
 *    (rows, horizon, paths, block years, seed, expense ratios), so two plans at
 *    one seed face bit-identical futures — market luck is held constant rather
 *    than averaged away. Measured variance reduction: 1.3x on large structural
 *    changes, 6.4x on the near-ties that actually need deciding.
 *
 * 3. A DOLLAR OBJECTIVE. Measured over 20 structurally diverse plans at one
 *    household's actual spending, six tied at exactly 100.00% success and the
 *    whole space spanned 2.57pp; retiring five years earlier and buying a
 *    $950k house cost 0.05pp. Success cannot rank an over-funded plan's
 *    decisions — maximising it would be maximising the RNG. Max sustainable
 *    spending moves by hundreds to thousands of dollars over the same space.
 *
 * 4. HONEST VERDICTS. Every difference is classified against a practical floor,
 *    and "equivalent within ± $500" is reported as a FINDING while "the
 *    interval straddles zero and is too wide to call" is reported as a failure
 *    to measure. Collapsing those two into "no difference" is the lie this
 *    report must never tell.
 *
 * Measured cost on this machine: a 1,024-candidate, 12-dimension search with
 * full seed replication and a complete attribution pass is about 20-25 minutes,
 * not the days the brief assumed — a 4,000-path run is 1.66s single-threaded
 * and an 8-worker pool sustains ~2.2 runs/s.
 */
import type {
  Assumptions,
  PairedDelta,
  Profile,
  Scenario,
  SearchAssignment,
  SearchAttributionRow,
  SearchAxis,
  SearchBudget,
  SearchCalibration,
  SearchDim,
  SearchFinalist,
  SearchLeaderRow,
  SearchObjective,
  SearchProgress,
  SearchReport,
  SearchRequest,
  SearchRound,
  SeedStat,
} from "../../shared/types";
import { createHash } from "node:crypto";
import { ENGINE_VERSION } from "../../shared/types";
import { formatUSD, stableStringify } from "../../shared/util";
// Read-only imports from the engine. Nothing under src/engine is MODIFIED by
// the search, which is what keeps ENGINE_VERSION (and therefore the whole run
// cache) still.
import {
  MAX_SPEND_HI,
  MAX_SPEND_LO,
  scenarioWithDeath,
} from "../../engine/solvers";
import { SIM_START_YEAR } from "../../engine/household";
import {
  assignmentValues,
  compileCandidate,
  describeAssignment,
  dimLabel,
  levelLabel,
  planHash,
  planSpendAnnual,
  spaceHash,
  withSpend,
} from "./compile";
import { CachedEvaluator, SimPool, defaultPoolSize } from "./pool";
import {
  BASELINE_ASSIGNMENT,
  balancedSample,
  enumerateAll,
  oneKnobNeighbours,
  spaceSize,
} from "./sample";
import {
  holmAdjust,
  linearSlope,
  pairedDelta,
  seedStat,
  winnersCurseBias,
} from "./stats";
import type { SearchScore } from "./scoreStore";

/** Raised when the user cancels; caught at the top so a partial report survives. */
export class CancelledError extends Error {
  constructor() {
    super("Search cancelled");
  }
}

export interface SearchHooks {
  update(patch: Partial<SearchProgress>): void;
  cancelled(): boolean;
}

export interface SearchDeps {
  profile: Profile;
  assumptions: Assumptions;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

/**
 * Every default is measured, not guessed. The seed counts come from the
 * confidence arithmetic: at 20 report seeds the 95% half-width on a paired
 * delta is t(0.975, 19) x sd/sqrt(20) = 0.468 x sd, which on the measured
 * paired sds of 0.12-0.63pp is 0.06-0.29pp — enough to resolve every effect
 * worth acting on. Solving for a 0.25pp half-width needs n = 28 at the worst
 * measured sd and n = 7 at the typical one; 20 is the compromise.
 */
export const DEFAULT_BUDGET: SearchBudget = {
  candidates: 512,
  enumerate: false,
  eta: 4,
  finalists: 6,
  // Round 1 screening: one seed at 1,000 paths ranks candidates at Spearman
  // 0.995 against a 6-seed/4,000-path truth, because its error is almost
  // entirely a COMMON OFFSET that cancels under common random numbers. It is a
  // ranking signal and nothing else, which is why the cut is generous.
  screenPaths: 1000,
  racePaths: 4000,
  reportPaths: 4000,
  selectionSeedCount: 16,
  reportSeedCount: 20,
  attribution: true,
  polish: true,
  polishSeedCount: 8,
  widowProbe: true,
};

/** $500/yr: half the bisection's own stopping interval, and a real-life bar. */
const DEFAULT_FLOOR_DOLLARS = 500;
/** Half a percentage point of success. */
const DEFAULT_FLOOR_SUCCESS = 0.005;

/** Hard cap on enumerated candidates, so a careless space cannot hang the box. */
const ENUMERATE_CAP = 4096;

/** Bisection: probes are quantised to this grid so different searches share cache. */
const SPEND_GRID = 100;
const SPEND_STOP_INTERVAL = 500;
const BISECT_MAX_ITERATIONS = 8;

/** Seeds are drawn from two blocks far enough apart that they cannot collide. */
const REPORT_SEED_OFFSET = 1_000_000;

function resolveBudget(b?: Partial<SearchBudget>): SearchBudget {
  return { ...DEFAULT_BUDGET, ...(b ?? {}) };
}

function resolveObjective(o?: Partial<SearchObjective>): SearchObjective {
  const metric = o?.metric ?? "sustainable_spend";
  return {
    metric,
    ...(o?.probeSpend !== undefined ? { probeSpend: o.probeSpend } : {}),
    probeTargetSuccess: o?.probeTargetSuccess ?? 0.85,
    practicalFloor:
      o?.practicalFloor ??
      (metric === "sustainable_spend"
        ? DEFAULT_FLOOR_DOLLARS
        : DEFAULT_FLOOR_SUCCESS),
  };
}

// ---------------------------------------------------------------------------
// Internal shapes
// ---------------------------------------------------------------------------

interface Candidate {
  id: string;
  assignment: SearchAssignment;
  /** Canonical compiled plan (inert knobs stripped). */
  scenario: Scenario;
  planHash: string;
  label: string;
  /** Per-seed success at the probe spend, from the last round it survived. */
  values: number[];
  /**
   * Mean median-terminal-real, used ONLY to break ties in the screen. Success
   * saturates; terminal wealth does not, so when two plans both score a
   * flat 100% this is the difference between a meaningful order and an
   * arbitrary one.
   */
  tiebreak: number;
  seeds: number[];
  paths: number;
}

interface EvalKey {
  key: string;
  scenario: Scenario;
  seed: number;
  paths: number;
}

// ---------------------------------------------------------------------------
// The executor
// ---------------------------------------------------------------------------

/**
 * The engine's own input hash, reproduced here.
 *
 * simulate.ts keeps its `sha256Hex` private, and exporting it would edit a file
 * under src/engine — which trips the version-pinning test, forces an
 * ENGINE_VERSION bump, and voids every cached run for a helper that computes
 * the same eight lines. This must stay byte-identical to that one: the values
 * are compared against RunMeta.hashes.
 */
function inputHash(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

export async function runSearch(
  searchId: string,
  request: SearchRequest,
  deps: SearchDeps,
  hooks: SearchHooks,
): Promise<SearchReport> {
  const t0 = Date.now();
  const { profile, assumptions } = deps;
  const budget = resolveBudget(request.budget);
  const objective = resolveObjective(request.objective);
  const axes = request.axes;
  const target =
    request.base.assumption_overrides?.settings?.successTarget ??
    profile.settings.successTarget;

  const seedBase = budget.seedBase ?? profile.settings.seed;
  const selectionSeeds = Array.from(
    { length: budget.selectionSeedCount },
    (_, i) => seedBase + 1 + i,
  );
  const reportSeeds = Array.from(
    { length: budget.reportSeedCount },
    (_, i) => seedBase + REPORT_SEED_OFFSET + 1 + i,
  );

  const pool = new SimPool(budget.workers ?? defaultPoolSize(), {
    profile,
    assumptions,
  });
  const evaluator = new CachedEvaluator(pool, profile, assumptions);

  // Mutable state, so a cancellation at any point can still produce a report.
  let calibration: SearchCalibration | undefined;
  let baselineFinalist: SearchFinalist | undefined;
  let finalists: SearchFinalist[] = [];
  let attribution: SearchAttributionRow[] = [];
  let interactionResidual: number | undefined;
  let tieBracket: string[] = [];
  const rounds: SearchRound[] = [];
  const caveats: string[] = [];
  let distinctPlans = 0;
  let candidatesGenerated = 0;
  let truncated = false;
  let plannedTotal = 0;
  let doneCount = 0;

  const report = (): SearchReport => ({
    searchId,
    ...(request.label !== undefined ? { label: request.label } : {}),
    createdAt: new Date(t0).toISOString(),
    engineVersion: ENGINE_VERSION,
    // The same two hashes the engine stamps on every RunMeta, so a saved
    // finalist and a saved workbench run are directly comparable — or provably
    // not. Computed exactly as the engine does it, from the same inputs.
    inputsHash: `${inputHash(profile)}:${inputHash(assumptions)}`,
    spaceHash: spaceHash(request.base, axes),
    axes,
    objective,
    seeds: { selection: selectionSeeds, report: reportSeeds },
    paths: {
      screen: budget.screenPaths,
      race: budget.racePaths,
      report: budget.reportPaths,
    },
    calibration:
      calibration ?? emptyCalibration(planSpendAnnual(profile, request.base)),
    candidatesGenerated,
    distinctPlans,
    evaluations: evaluator.evaluations,
    cacheHits: evaluator.cacheHits,
    rounds,
    baseline: baselineFinalist ?? placeholderBaseline(profile, request.base),
    finalists,
    tieBracket,
    attribution,
    ...(interactionResidual !== undefined ? { interactionResidual } : {}),
    caveats,
    truncated,
    elapsedMs: Date.now() - t0,
  });

  // ---- progress plumbing -------------------------------------------------

  const pushProgress = (patch: Partial<SearchProgress> = {}): void => {
    const elapsed = Date.now() - t0;
    // Rate is measured over the PROGRESS COUNTER, not over simulations
    // actually computed, because that is the quantity the ETA divides into.
    // Using the computation rate would put the ETA hours out on a cache-heavy
    // re-run — the exact case where the search is fastest and the user is
    // most likely to be watching. `cacheHits` is reported separately so the
    // difference stays visible.
    const rate = elapsed > 0 ? (doneCount * 1000) / elapsed : 0;
    const remaining = Math.max(0, plannedTotal - doneCount);
    hooks.update({
      evaluated: doneCount,
      total: Math.max(plannedTotal, doneCount),
      cacheHits: evaluator.cacheHits,
      ratePerSec: Number(rate.toFixed(2)),
      elapsedMs: elapsed,
      ...(rate > 0.01 && remaining > 0
        ? { etaMs: Math.round((remaining / rate) * 1000) }
        : {}),
      rounds: rounds.map((r) => ({ ...r })),
      ...patch,
    });
  };

  const checkCancel = (): void => {
    if (hooks.cancelled()) throw new CancelledError();
  };

  /**
   * Evaluate a batch. Chunked at 4x the pool so cancellation is responsive and
   * the leaderboard moves while a long round runs; the pool queues internally,
   * so chunking costs nothing in throughput.
   */
  const evaluateBatch = async (
    jobs: EvalKey[],
    onChunk?: (done: Map<string, SearchScore>) => void,
  ): Promise<Map<string, SearchScore>> => {
    const out = new Map<string, SearchScore>();
    const chunk = Math.max(8, (budget.workers ?? defaultPoolSize()) * 4);
    for (let i = 0; i < jobs.length; i += chunk) {
      checkCancel();
      const slice = jobs.slice(i, i + chunk);
      const results = await Promise.all(
        slice.map((j) =>
          evaluator.evaluate({
            scenario: j.scenario,
            mode: "montecarlo",
            paths: j.paths,
            seed: j.seed,
          }),
        ),
      );
      for (let k = 0; k < slice.length; k++)
        out.set(slice[k].key, results[k].score);
      doneCount += slice.length;
      onChunk?.(out);
      pushProgress();
    }
    return out;
  };

  /** Success at `spend`, per seed, for one plan. The atom everything is built from. */
  const successSeries = async (
    scenario: Scenario,
    spend: number,
    seeds: number[],
    paths: number,
  ): Promise<{ values: number[]; scores: SearchScore[] }> => {
    const probe = withSpend(profile, scenario, spend);
    const jobs: EvalKey[] = seeds.map((seed) => ({
      key: String(seed),
      scenario: probe,
      seed,
      paths,
    }));
    const got = await evaluateBatch(jobs);
    const scores = seeds.map((s) => got.get(String(s)) as SearchScore);
    return { values: scores.map((s) => s.success), scores };
  };

  /**
   * Success for an arbitrary list of (spend, seed) pairs, submitted as ONE
   * batch. The bisection needs this: by its later iterations every seed sits in
   * a different bracket and therefore wants a different probe level, so
   * grouping the work by level would leave the pool running one job at a time.
   */
  const probePairs = async (
    scenario: Scenario,
    pairs: Array<{ spend: number; seed: number }>,
    paths: number,
  ): Promise<number[]> => {
    const jobs: EvalKey[] = pairs.map((p, i) => ({
      key: String(i),
      scenario: withSpend(profile, scenario, p.spend),
      seed: p.seed,
      paths,
    }));
    const got = await evaluateBatch(jobs);
    return pairs.map((_, i) => (got.get(String(i)) as SearchScore).success);
  };

  try {
    // =====================================================================
    // STAGE 0 — CALIBRATE. Measure this plan's noise floor and the local
    // success-per-dollar slope rather than assuming either. The floor moves by
    // 3x depending on where a plan sits (0.25pp at 4,000 paths near the
    // ceiling, 0.74pp in the discriminating middle), so a constant would either
    // over-claim or under-claim precision on most plans. The slope is what lets
    // a success screen be read in dollars.
    // =====================================================================
    hooks.update({
      status: "running",
      stage: "calibrating",
      stageLabel: "measuring this plan",
    });

    const baseScenario = compileCandidate(
      profile,
      request.base,
      axes,
      BASELINE_ASSIGNMENT,
    );
    const planSpend = planSpendAnnual(profile, request.base);
    const calSeeds = reportSeeds.slice(0, Math.min(6, reportSeeds.length));
    const ladderSpends = [planSpend, planSpend * 1.15, planSpend * 1.3].map(
      quantiseSpend,
    );

    plannedTotal =
      ladderSpends.length * calSeeds.length +
      selectionSeeds.length +
      reportSeeds.length;
    pushProgress({ stage: "calibrating", stageLabel: "measuring this plan" });

    const ladder: SearchCalibration["ladder"] = [];
    for (const spend of ladderSpends) {
      const { values } = await successSeries(
        baseScenario,
        spend,
        calSeeds,
        budget.racePaths,
      );
      ladder.push({ spend, success: seedStat(values) });
    }

    const slopePerDollar = linearSlope(
      ladder.map((l) => l.spend),
      ladder.map((l) => l.success.mean),
    );
    let probeSpend =
      objective.probeSpend ??
      choosProbeSpend(
        ladder,
        slopePerDollar,
        objective.probeTargetSuccess,
        planSpend,
        objective.metric,
      );

    const baseScreen = await successSeries(
      baseScenario,
      probeSpend,
      selectionSeeds,
      budget.screenPaths,
    );
    const baseReport = await successSeries(
      baseScenario,
      probeSpend,
      reportSeeds,
      budget.reportPaths,
    );
    const screenStat = seedStat(baseScreen.values);
    const reportStat = seedStat(baseReport.values);

    const calib: SearchCalibration = {
      planSpend,
      probeSpend,
      ladder,
      // Signed: negative, because spending more lowers success. Callers take
      // the magnitude when converting probability into dollars.
      successPerThousand: slopePerDollar * 1000,
      noiseFloorScreen: screenStat.sd,
      noiseFloorReport: reportStat.sd,
      ...(Math.abs(slopePerDollar) > 1e-9
        ? {
            pairedFloorDollars: Math.round(
              reportStat.sd / Math.abs(slopePerDollar),
            ),
          }
        : {}),
    };
    calibration = calib;
    pushProgress({ calibration: calib });

    if (Math.abs(slopePerDollar) < 1e-9) {
      caveats.push(
        "The success-vs-spending curve is flat over the calibration range, so no dollar " +
          "conversion is possible and the search is ranking on probability alone. Widen the " +
          "spending ladder or check whether this plan can fail at all.",
      );
    }
    if (ladder[0].success.mean >= 0.9999) {
      caveats.push(
        `At the plan's own spending (${formatUSD(planSpend)}/yr) every path succeeds, which is ` +
          "why candidates are screened at a stress level instead. Read the score as spending " +
          "headroom, not as a probability.",
      );
    }

    // =====================================================================
    // CANDIDATES
    // =====================================================================
    const total = spaceSize(axes);
    const fullCells = budget.enumerate
      ? enumerateAll(axes, ENUMERATE_CAP)
      : balancedSample(axes, budget.candidates, seedBase ^ 0x5eed);
    const drawn: SearchAssignment[] = [
      BASELINE_ASSIGNMENT,
      ...oneKnobNeighbours(axes),
      ...fullCells,
    ];
    candidatesGenerated = drawn.length;

    // Canonicalisation dedupe: candidates differing only in a knob that cannot
    // act are ONE plan. Typically 15-30% of a space like this, and it also lets
    // the report say "the question does not arise" instead of reporting a
    // spurious near-zero effect.
    const byHash = new Map<string, Candidate>();
    let idSeq = 0;
    for (const assignment of drawn) {
      const scenario = compileCandidate(
        profile,
        request.base,
        axes,
        assignment,
      );
      const hash = planHash(scenario);
      if (byHash.has(hash)) continue;
      byHash.set(hash, {
        id:
          hash === planHash(baseScenario)
            ? "baseline"
            : `c${String(++idSeq).padStart(4, "0")}`,
        assignment,
        scenario,
        planHash: hash,
        label: describeAssignment(axes, assignment),
        values: [],
        tiebreak: 0,
        seeds: [],
        paths: 0,
      });
    }
    let field = [...byHash.values()];
    distinctPlans = field.length;

    // COVERAGE, counted honestly. Only the full-assignment draws are cells of
    // the product; the incumbent and its one-knob neighbours are not, so
    // counting them would overstate coverage. Distinct cells, not draws,
    // because a balanced sample repeats.
    const distinctCells = new Set(fullCells.map((a) => JSON.stringify(a))).size;
    if (budget.enumerate && total > ENUMERATE_CAP) {
      caveats.push(
        `Exhaustive mode was asked for, but the space has ${total.toLocaleString("en-US")} cells ` +
          `and enumeration stops at ${ENUMERATE_CAP.toLocaleString("en-US")}. Only the first ` +
          `${ENUMERATE_CAP.toLocaleString("en-US")} were tried, in axis order — which is NOT a ` +
          "representative sample. Reduce the space or switch to sampling.",
      );
    } else if (distinctCells >= total) {
      caveats.push(
        `Every one of the ${total.toLocaleString("en-US")} combinations in this space was tried, ` +
          "so there is no sampling caveat: the winner is the best cell in the space, subject only " +
          "to the confidence intervals below.",
      );
    } else {
      const frac = distinctCells / total;
      const pct = (frac * 100).toFixed(frac < 0.001 ? 4 : 2);
      caveats.push(
        `${distinctCells.toLocaleString("en-US")} of ${total.toLocaleString("en-US")} combinations ` +
          `were tried (${pct}%), plus your own plan and each of its one-knob neighbours. This is ` +
          "not a global optimum: what it reliably delivers is each dimension's main effect and a " +
          "good region that the polish pass then climbs. Given how small the real effects are " +
          "here relative to the noise, the gap to the true optimum is very likely inside the " +
          "confidence intervals below.",
      );
    }

    // =====================================================================
    // SUCCESSIVE HALVING
    // =====================================================================
    const schedule = buildSchedule(field.length, budget, selectionSeeds.length);
    for (const s of schedule) {
      rounds.push({ ...s, status: "pending" });
    }
    plannedTotal =
      doneCount +
      schedule.reduce((n, r) => n + r.candidates * r.seeds + r.seeds, 0) +
      estimateReportCost(budget, objective) +
      estimateAttributionCost(axes, budget);
    pushProgress();

    let roundProbe = probeSpend;
    const probeRaised: Array<{ from: number; to: number; round: number }> = [];

    for (let r = 0; r < schedule.length; r++) {
      const round = rounds[r];
      round.status = "running";
      round.probeSpend = roundProbe;
      const seeds = selectionSeeds.slice(0, round.seeds);
      const stageLabel =
        r === 0
          ? `screening ${field.length.toLocaleString("en-US")} plans on 1 seed x ${round.paths.toLocaleString("en-US")} paths`
          : `racing ${field.length} plans on ${round.seeds} seeds x ${round.paths.toLocaleString("en-US")} paths`;
      hooks.update({ stage: r === 0 ? "screening" : "racing", stageLabel });
      pushProgress({ stage: r === 0 ? "screening" : "racing", stageLabel });

      // The baseline is scored on the SAME seeds and paths as the round, so the
      // leaderboard's numbers are paired from the very first screen.
      const baseRound = await successSeries(
        baseScenario,
        roundProbe,
        seeds,
        round.paths,
      );

      const jobs: EvalKey[] = [];
      for (const cand of field) {
        const probe = withSpend(profile, cand.scenario, roundProbe);
        for (const seed of seeds) {
          jobs.push({
            key: `${cand.id}|${seed}`,
            scenario: probe,
            seed,
            paths: round.paths,
          });
        }
      }
      // The leaderboard is rebuilt as chunks land, not only when the round
      // ends. Round 1 is the longest stretch of the whole search (a thousand
      // candidates on one seed), and staring at an empty table for three
      // minutes is exactly how a twenty-minute run loses the user's trust.
      // Only candidates with ALL their seeds in are shown, so a row never
      // ranks on a partial seed set.
      const absorb = (cand: Candidate, scores: SearchScore[]): void => {
        cand.values = scores.map((s) => s.success);
        cand.tiebreak = meanOf(scores.map((s) => s.medianTerminalReal));
        cand.seeds = seeds;
        cand.paths = round.paths;
      };

      const got = await evaluateBatch(jobs, (partial) => {
        for (const cand of field) {
          const scores: SearchScore[] = [];
          for (const s of seeds) {
            const score = partial.get(`${cand.id}|${s}`);
            if (!score) break;
            scores.push(score);
          }
          if (scores.length === seeds.length) absorb(cand, scores);
        }
        hooks.update({
          leaderboard: leaderboard(
            field,
            baseRound.values,
            roundProbe,
            slopePerDollar,
            true,
          ),
        });
      });
      for (const cand of field) {
        absorb(
          cand,
          seeds.map((s) => got.get(`${cand.id}|${s}`) as SearchScore),
        );
      }

      // Success first, then terminal wealth. The tiebreak only ever decides
      // rows the primary metric CANNOT separate, which is exactly the
      // saturated ones — and leaving those in arbitrary order would let the
      // cut throw away a good plan on the strength of nothing.
      field.sort(
        (a, b) =>
          meanOf(b.values) - meanOf(a.values) || b.tiebreak - a.tiebreak,
      );

      /*
       * Saturated means "the screen cannot tell this apart from a perfect
       * score", NOT "this scored exactly 1.0". A field sitting at 99.5% has no
       * more resolution left than one at 100.0% when the screen's own noise
       * floor is half a point — but an exact test never fires there, the probe
       * never rises, and every downstream dollar figure is then read off a
       * slope through a flat region. That compresses attribution badly: the
       * measured effect of a real five-year decision can land within the noise
       * and be reported as "does not matter".
       *
       * The floor is the screen's own SD, so the test asks the only question
       * that matters: is this plan separable from perfection AT THIS
       * RESOLUTION? A 1e-9 guard keeps a zero-noise fixture (every test world)
       * on the old exact behaviour.
       */
      const satFloor = 1 - Math.max(calib.noiseFloorScreen, 1e-9);
      const saturated = field.filter((c) => meanOf(c.values) >= satFloor).length;
      round.saturatedFraction = field.length > 0 ? saturated / field.length : 0;
      round.status = "done";
      pushProgress({
        leaderboard: leaderboard(
          field,
          baseRound.values,
          roundProbe,
          slopePerDollar,
          true,
        ),
      });

      field = field.slice(0, round.keep);

      // RE-CALIBRATE THE PROBE when the survivors have outgrown it. A stress
      // level chosen so the INCUMBENT lands near 85% has no resolution left
      // once the field is plans that score a flat 100% at it — five more years
      // of salary moves sustainable spending by tens of thousands, far more
      // than the calibration ladder ever explored. Raising it costs nothing
      // (each round is self-contained: one probe, one seed set, one path
      // count) and is the difference between a race and a shuffle.
      // An explicitly requested probe spend is never overridden: the caller
      // asked a specific question ("rank these at $90,000/yr") and silently
      // changing it would answer a different one.
      const stillRacing =
        r < schedule.length - 1 && objective.probeSpend === undefined;
      if (
        stillRacing &&
        saturated / Math.max(1, field.length) > 0.25 &&
        Math.abs(slopePerDollar) > 1e-9
      ) {
        const top = meanOf(field[0]?.values ?? [1]);
        const lift =
          (top - objective.probeTargetSuccess) / Math.abs(slopePerDollar);
        const raised = quantiseSpend(
          Math.min(roundProbe * 1.5, roundProbe + Math.max(0, lift)),
        );
        if (raised > roundProbe) {
          probeRaised.push({
            from: roundProbe,
            to: raised,
            round: round.index,
          });
          roundProbe = raised;
        }
      }
    }
    // Everything downstream — the report bisection's bracket, the attribution
    // probes — uses the level the race finished on.
    probeSpend = roundProbe;
    calib.probeSpend = probeSpend;
    if (probeRaised.length > 0) {
      const last = probeRaised[probeRaised.length - 1];
      caveats.push(
        `The screening spend was raised from ${formatUSD(probeRaised[0].from)}/yr to ` +
          `${formatUSD(last.to)}/yr during the race, because the surviving plans all scored 100% ` +
          "at the original level and the screen had stopped separating them. Scores from " +
          "different rounds are therefore not comparable to one another — which was already true " +
          "across rounds (different seeds, different path counts), and is why only the held-out " +
          "report numbers are quoted.",
      );
    }

    // =====================================================================
    // REPORT STAGE — held-out seeds only. Nothing from here on was used to
    // choose anything.
    // =====================================================================
    hooks.update({
      stage: "reporting",
      stageLabel: `re-running ${field.length} finalists on ${reportSeeds.length} held-out seeds`,
    });
    pushProgress({ stage: "reporting" });

    const widowYear =
      budget.widowProbeYear ?? pickWidowYear(axes, request.base);
    const earner =
      profile.people.find((p) => (profile.income.salaries[p.id] ?? 0) > 0)
        ?.id ?? profile.people[0].id;
    const canWidow = budget.widowProbe && profile.people.length > 1;

    const measured = new Map<string, MeasuredPlan>();
    const toMeasure: Array<{
      id: string;
      label: string;
      scenario: Scenario;
      assignment: SearchAssignment;
      hash: string;
    }> = [
      {
        id: "baseline",
        label: "your plan as it stands",
        scenario: baseScenario,
        assignment: BASELINE_ASSIGNMENT,
        hash: planHash(baseScenario),
      },
      ...field
        .filter((c) => c.id !== "baseline")
        .map((c) => ({
          id: c.id,
          label: c.label,
          scenario: c.scenario,
          assignment: c.assignment,
          hash: c.planHash,
        })),
    ];

    for (const item of toMeasure) {
      const probe = await successSeries(
        item.scenario,
        probeSpend,
        reportSeeds,
        budget.reportPaths,
      );
      const own = await successSeries(
        item.scenario,
        planSpend,
        reportSeeds,
        budget.reportPaths,
      );
      let spendValues: number[] | undefined;
      if (objective.metric === "sustainable_spend") {
        spendValues = await bisectSustainableSpend(
          item.scenario,
          reportSeeds,
          budget.reportPaths,
          target,
          probeSpend,
          probePairs,
        );
      }
      let widow: number[] | undefined;
      if (canWidow) {
        const withDeath = scenarioWithDeath(item.scenario, earner, widowYear);
        widow = (
          await successSeries(
            withDeath,
            planSpend,
            reportSeeds,
            budget.racePaths,
          )
        ).values;
      }
      measured.set(item.id, {
        ...item,
        probe: probe.values,
        scores: own.scores,
        own: own.values,
        ...(spendValues ? { spend: spendValues } : {}),
        ...(widow ? { widow } : {}),
      });
      pushProgress();
    }

    // Objective values, per seed, in the units the report ranks on.
    const objectiveValues = (m: MeasuredPlan): number[] =>
      objective.metric === "sustainable_spend" && m.spend ? m.spend : m.probe;

    const baseMeasured = measured.get("baseline") as MeasuredPlan;
    const baseObjective = objectiveValues(baseMeasured);
    const fmt = objective.metric === "sustainable_spend" ? fmtDollars : fmtPP;

    const finalistList = toMeasure
      .filter((i) => i.id !== "baseline")
      .map((i) => measured.get(i.id) as MeasuredPlan);

    const deltas = finalistList.map((m) =>
      pairedDelta(objectiveValues(m), baseObjective, {
        practicalFloor: objective.practicalFloor,
        format: fmt,
        seedsLabel: `${reportSeeds.length} held-out seeds`,
      }),
    );
    holmAdjust(deltas);

    // GATE 1, enforced and not merely measured: a plan that cannot clear the
    // household's own success target AT ITS OWN SPENDING is not a candidate for
    // winning, however much notional headroom some other metric credits it
    // with. Feasible plans sort above infeasible ones; within each group, by
    // the paired delta.
    const feasibleAt = (m: MeasuredPlan): boolean => meanOf(m.own) >= target;
    const order = finalistList
      .map((m, i) => ({ m, d: deltas[i] }))
      .sort(
        (a, b) =>
          Number(feasibleAt(b.m)) - Number(feasibleAt(a.m)) ||
          b.d.mean - a.d.mean,
      );
    const infeasible = order.filter((r) => !feasibleAt(r.m));
    if (infeasible.length > 0) {
      caveats.push(
        `${infeasible.length} of ${order.length} finalists do not reach the ${(target * 100).toFixed(0)}% ` +
          "success target at your own spending, and are ranked below the ones that do however " +
          "they scored. They are shown rather than hidden because a plan that just misses the bar " +
          "is worth seeing.",
      );
    }

    // TIE BRACKET, computed from data already in hand: a paired winner-vs-rival
    // delta needs no new simulations, because both sides were scored on the
    // same held-out seeds. A single crowned winner out of a noisy search is the
    // failure mode this whole design exists to avoid.
    const winner = order[0];
    tieBracket = [];
    if (winner) {
      const rivals = order.filter((row) => row !== winner);
      // ONE family, Holm-adjusted together. Each winner-vs-rival test asks the
      // same question of the same winner, so running them unadjusted inflates
      // the family-wise error rate and — because an unadjusted test says
      // "better" more readily — yields a bracket that is too NARROW. That is
      // the wrong direction to err: it crowns a lone winner out of a field the
      // data cannot actually separate, which is the exact failure this design
      // exists to avoid. ScenarioFinalist.tiedWithWinner has always documented
      // the bracket as post-Holm; this makes the code match.
      const vs = rivals.map((row) =>
        pairedDelta(objectiveValues(winner.m), objectiveValues(row.m), {
          practicalFloor: objective.practicalFloor,
          format: fmt,
          seedsLabel: `${reportSeeds.length} held-out seeds`,
        }),
      );
      holmAdjust(vs);
      tieBracket.push(winner.m.id);
      rivals.forEach((row, i) => {
        if (vs[i].verdict !== "better") tieBracket.push(row.m.id);
      });
    }

    baselineFinalist = toFinalist(
      baseMeasured,
      axes,
      target,
      0,
      false,
      undefined,
    );
    finalists = order.map((row, i) =>
      // The winner is in its own tie bracket by definition (the bracket is the
      // complete set of indistinguishable plans, which is what the UI needs to
      // draw it), but flagging rank 1 as "tied with the winner" would be
      // nonsense on the row itself.
      toFinalist(
        row.m,
        axes,
        target,
        i + 1,
        i > 0 && tieBracket.includes(row.m.id),
        row.d,
      ),
    );
    pushProgress({
      leaderboard: reportLeaderboard(finalists, objective, budget.reportPaths),
    });

    // =====================================================================
    // ATTRIBUTION — two columns, because they answer different questions.
    // =====================================================================
    if (budget.attribution && winner) {
      hooks.update({
        stage: "attributing",
        stageLabel: "measuring what each decision was worth",
      });
      pushProgress({ stage: "attributing" });
      const built = await buildAttribution({
        axes,
        profile,
        base: request.base,
        baseScenario,
        winner: winner.m,
        winnerAssignment: winner.m.assignment,
        baselineProbe: baseMeasured.probe,
        winnerProbe: winner.m.probe,
        seeds: reportSeeds,
        paths: budget.reportPaths,
        probeSpend,
        slopePerDollar,
        objective,
        successSeries,
        polish: budget.polish,
        polishSeeds: reportSeeds.slice(
          0,
          Math.min(budget.polishSeedCount, reportSeeds.length),
        ),
        polishPaths: budget.racePaths,
        onStage: (label) => {
          hooks.update({ stage: "polishing", stageLabel: label });
          pushProgress();
        },
      });
      attribution = built.rows;
      interactionResidual = built.interactionResidual;
      if (built.betterNeighbours.length > 0) {
        caveats.push(
          "The coordinate pass found a neighbour of the winner that scores higher: " +
            `${built.betterNeighbours.join("; ")}. The winner is therefore NOT a local optimum — ` +
            "treat the top of the table as a region, not a point.",
        );
      }
      if (objective.metric === "sustainable_spend") {
        caveats.push(
          "Attribution rows are measured as success at the screening spend and converted to " +
            `dollars with the calibrated slope (${(Math.abs(slopePerDollar) * 1000 * 100).toFixed(2)}pp ` +
            "per $1,000/yr). The finalists above use the real per-seed bisection instead; only " +
            "those dollar figures are quotable.",
        );
      }
    }

    caveats.push(
      `Selection used seeds ${selectionSeeds[0]}-${selectionSeeds[selectionSeeds.length - 1]}; ` +
        `every number reported above comes from the disjoint set ` +
        `${reportSeeds[0]}-${reportSeeds[reportSeeds.length - 1]}. Reporting ` +
        "the selection score instead would have inflated the winner by roughly " +
        `${fmtPP(winnersCurseBias(distinctPlans, calib.noiseFloorScreen))} of pure luck. ` +
        "Be precise about what that buys: the held-out seeds narrowed a field of " +
        `${distinctPlans} plans down to these ${field.length}, so the winner's margin over the ` +
        "rest of the table is free of the curse. It does NOT make the top row's own number " +
        "unselected — the ranking, the winner and the tie bracket are all decided on these " +
        "seeds, so rank 1 still carries the optimism of having been picked from " +
        `${field.length}. That residual is why the tie bracket exists and why the bracket, ` +
        "rather than the top row alone, is the honest answer.",
    );
    caveats.push(
      "Every comparison here is paired: both sides face bit-identical market paths at each seed, " +
        "so the difference is the decision and not the weather. That property breaks if a " +
        "comparison changes the horizon, the bootstrap block length, expense ratios or the path " +
        "count — none of which is a search axis.",
    );

    hooks.update({ stage: "done", stageLabel: "done" });
    return report();
  } catch (err) {
    if (err instanceof CancelledError) {
      truncated = true;
      caveats.unshift(
        "CANCELLED before the search finished. Everything below is as far as it got: rows that " +
          "never reached the held-out report stage carry screening precision only and must not be " +
          "acted on.",
      );
      // Salvage a leaderboard from whatever the last completed round produced.
      if (finalists.length === 0 && baselineFinalist === undefined) {
        baselineFinalist = placeholderBaseline(profile, request.base);
      }
      return report();
    }
    throw err;
  } finally {
    await pool.destroy();
  }
}

// ---------------------------------------------------------------------------
// Pieces
// ---------------------------------------------------------------------------

interface MeasuredPlan {
  id: string;
  label: string;
  scenario: Scenario;
  assignment: SearchAssignment;
  hash: string;
  /** Success at the probe spend, per report seed. */
  probe: number[];
  /**
   * Full scores from the run AT THE PLAN'S OWN SPENDING.
   *
   * Deliberately not the probe run's. Everything read off this array —
   * terminal wealth, lifetime giving, the shortfall year — is reported under a
   * name that means "this plan, as it stands", and the probe spend is a stress
   * level chosen to drag success down to a rankable band. On an over-funded
   * plan that is tens of thousands of dollars a year above what the household
   * actually spends, so a terminal balance taken there understates the real one
   * badly, and a report that quoted it would understate every finalist with
   * nothing to mark it.
   */
  scores: SearchScore[];
  /** Success at the plan's OWN spending, per report seed — the feasibility gate. */
  own: number[];
  /** Max sustainable spend, bisected per report seed. */
  spend?: number[];
  /** Survivor's success for a death in the probe year, per report seed. */
  widow?: number[];
}

function meanOf(values: readonly number[]): number {
  if (values.length === 0) return Number.NaN;
  let s = 0;
  for (const v of values) s += v;
  return s / values.length;
}

function quantiseSpend(spend: number): number {
  return Math.max(
    MAX_SPEND_LO,
    Math.min(MAX_SPEND_HI, Math.round(spend / SPEND_GRID) * SPEND_GRID),
  );
}

function fmtDollars(v: number): string {
  return `${formatUSD(Math.abs(v))}/yr`;
}

function fmtPP(v: number): string {
  return `${(Math.abs(v) * 100).toFixed(2)}pp`;
}

/**
 * Where to screen.
 *
 * Screening at the plan's own spending is useless when success saturates there
 * — six of twenty diverse plans tied at exactly 100.00% — so candidates are
 * scored at a stress level where the metric still has resolution, chosen so the
 * INCUMBENT lands near `targetSuccess`. That band (around 85%) is where the
 * success-vs-spend curve is steepest for this household, roughly 1.0-1.4pp per
 * $1,000/yr, and where nothing saturates.
 */
function choosProbeSpend(
  ladder: SearchCalibration["ladder"],
  slopePerDollar: number,
  targetSuccess: number,
  planSpend: number,
  metric: SearchObjective["metric"],
): number {
  // Maximising probability at the household's own spending is a coherent
  // request; do not stress it in that case.
  if (metric === "success") return quantiseSpend(planSpend);
  if (Math.abs(slopePerDollar) < 1e-9) return quantiseSpend(planSpend);
  const anchor = ladder[ladder.length - 1];
  const needed = (targetSuccess - anchor.success.mean) / slopePerDollar;
  // Never screen BELOW the plan's own spending: that is even more saturated.
  return quantiseSpend(Math.max(planSpend, anchor.spend + needed));
}

/**
 * The successive-halving schedule.
 *
 * eta = 4 with seed replication quadrupling each round, so every round costs
 * roughly the same while the survivors' precision compounds. The cut is
 * generous by design: a 1-seed screen's error is dominated by a COMMON OFFSET
 * that cancels under common random numbers (measured mean -0.50pp, reordering
 * sd 0.45pp against a 35.60pp spread), so its RANKING is trustworthy while its
 * levels are not — but the reordering component still argues for keeping the
 * top quarter, never the top 5%.
 */
export function buildSchedule(
  n: number,
  budget: SearchBudget,
  seedsAvailable: number,
): Array<Omit<SearchRound, "status">> {
  const seedSeq = [1, 4, 8, 16, 24, 32];
  const pathSeq = [
    budget.screenPaths,
    Math.round((budget.screenPaths + budget.racePaths) / 2),
    budget.racePaths,
    budget.racePaths,
  ];
  const out: Array<Omit<SearchRound, "status">> = [];
  let candidates = n;
  let i = 0;
  for (;;) {
    const keep = Math.max(budget.finalists, Math.ceil(candidates / budget.eta));
    const round = {
      index: i + 1,
      candidates,
      seeds: Math.min(seedsAvailable, seedSeq[Math.min(i, seedSeq.length - 1)]),
      paths: pathSeq[Math.min(i, pathSeq.length - 1)],
      keep: Math.min(keep, candidates),
    };
    out.push(round);
    if (round.keep <= budget.finalists || round.keep >= candidates) {
      out[out.length - 1].keep = Math.min(budget.finalists, candidates);
      break;
    }
    candidates = round.keep;
    i++;
    if (i > 8) break;
  }
  return out;
}

function estimateReportCost(
  budget: SearchBudget,
  objective: SearchObjective,
): number {
  const configs = budget.finalists + 1;
  const perConfig =
    budget.reportSeedCount * 2 +
    (objective.metric === "sustainable_spend"
      ? budget.reportSeedCount * 6
      : 0) +
    (budget.widowProbe ? budget.reportSeedCount : 0);
  return configs * perConfig;
}

function estimateAttributionCost(
  axes: SearchAxis[],
  budget: SearchBudget,
): number {
  if (!budget.attribution) return 0;
  const pairs = axes.length * 2 * budget.reportSeedCount;
  const polish = budget.polish
    ? axes.reduce((n, a) => n + Math.max(0, a.levels.length - 1), 0) *
      budget.polishSeedCount
    : 0;
  return pairs + polish;
}

/**
 * Max sustainable spending, bisected PER SEED.
 *
 * Per seed rather than on the mean, because a per-seed answer is what makes the
 * comparison paired: d_i = spend_candidate(seed i) - spend_baseline(seed i),
 * with the market futures identical on both sides. Bisecting the mean would
 * give one number with no measurable spread and no paired structure at all.
 *
 * Probes are quantised to a $100 grid so that two finalists, two searches, or a
 * later re-run land on the SAME probe levels and therefore the same cache keys.
 * Without that, every bisection midpoint would be a unique float and the run
 * cache would never hit.
 *
 * The bracket starts at +/- $8,000 around the screening estimate (which the
 * calibrated slope makes a good guess), so a typical solve is five or six
 * probes rather than the twelve a blind [20k, 400k] bisection needs.
 */
async function bisectSustainableSpend(
  scenario: Scenario,
  seeds: number[],
  paths: number,
  target: number,
  center: number,
  probePairs: (
    s: Scenario,
    pairs: Array<{ spend: number; seed: number }>,
    paths: number,
  ) => Promise<number[]>,
): Promise<number[]> {
  const n = seeds.length;
  // INVARIANT, and the whole reason this is written as an explicit state
  // machine: `lo` is the highest level KNOWN to pass and `hi` the lowest known
  // to fail. The bracket starts at the full [20k, 400k] range so a guess that
  // misses in either direction is still correct — it just costs more probes.
  const lo = new Array<number>(n).fill(MAX_SPEND_LO);
  const hi = new Array<number>(n).fill(MAX_SPEND_HI);

  const probe = async (
    levels: number[],
    active: number[],
  ): Promise<Map<number, number>> => {
    const values = await probePairs(
      scenario,
      active.map((i) => ({ spend: levels[i], seed: seeds[i] })),
      paths,
    );
    return new Map(active.map((i, k) => [i, values[k]]));
  };

  const allIdx = Array.from({ length: n }, (_, i) => i);
  const low = quantiseSpend(center - 8000);
  const high = quantiseSpend(center + 8000);

  const first = await probe(new Array<number>(n).fill(low), allIdx);
  for (const i of allIdx) {
    if ((first.get(i) as number) >= target) lo[i] = low;
    else hi[i] = low;
  }
  // Only seeds whose lower guess PASSED can learn anything from the upper one.
  const upper = allIdx.filter((i) => lo[i] === low && high > low);
  if (upper.length > 0) {
    const second = await probe(new Array<number>(n).fill(high), upper);
    for (const i of upper) {
      if ((second.get(i) as number) >= target) lo[i] = high;
      else hi[i] = high;
    }
  }

  for (let iter = 0; iter < BISECT_MAX_ITERATIONS; iter++) {
    const mids = allIdx.map((i) => quantiseSpend((lo[i] + hi[i]) / 2));
    const active = allIdx.filter(
      (i) =>
        hi[i] - lo[i] >= SPEND_STOP_INTERVAL &&
        mids[i] > lo[i] &&
        mids[i] < hi[i],
    );
    if (active.length === 0) break;
    const got = await probe(mids, active);
    for (const i of active) {
      if ((got.get(i) as number) >= target) lo[i] = mids[i];
      else hi[i] = mids[i];
    }
  }
  // `lo` may still be the floor when even $20,000/yr fails; the number then
  // reads as "at most $20,000", which the bracket bound makes honest.
  return lo;
}

/** Death year for the survivor probe: the earliest retirement the space allows. */
function pickWidowYear(axes: SearchAxis[], base: Scenario): number {
  const axis = axes.find((a) => a.dim === "retireYear");
  if (axis?.dim === "retireYear") return Math.min(...axis.levels);
  const years = base.events
    .filter((e) => e.type === "retire")
    .map((e) => Number((e as { date: string }).date.slice(0, 4)));
  if (years.length > 0) return Math.min(...years);
  return SIM_START_YEAR + 1;
}

function toFinalist(
  m: MeasuredPlan,
  axes: SearchAxis[],
  target: number,
  rank: number,
  tied: boolean,
  delta: PairedDelta | undefined,
): SearchFinalist {
  const ownStat = seedStat(m.own);
  const probeStat = seedStat(m.probe);
  const shortfalls = m.scores
    .map((s) => s.worstDecileFirstShortfallYear)
    .filter((y): y is number => y !== null);
  return {
    id: m.id,
    assignment: assignmentValues(axes, m.assignment),
    label: m.label,
    // The saved copy carries a readable name; everything else is the canonical
    // plan the numbers were computed on, so saving it and re-running it lands
    // on the very same cache entries.
    scenario: { ...m.scenario, name: m.label.slice(0, 120) },
    planHash: m.hash,
    ...(m.spend ? { sustainableSpend: seedStat(m.spend) } : {}),
    probeSuccess: probeStat,
    successAtPlanSpend: ownStat,
    ...(m.widow ? { widowScore: seedStat(m.widow) } : {}),
    medianTerminalReal: seedStat(m.scores.map((s) => s.medianTerminalReal)),
    charitableTotalReal: seedStat(m.scores.map((s) => s.charitableTotalReal)),
    ...(shortfalls.length > 0
      ? { worstDecileFirstShortfallYear: Math.min(...shortfalls) }
      : {}),
    feasible: ownStat.mean >= target,
    ...(delta ? { delta } : {}),
    rank,
    tiedWithWinner: tied,
  };
}

function leaderboard(
  field: Candidate[],
  baseValues: number[],
  probeSpend: number,
  slopePerDollar: number,
  screening: boolean,
): SearchLeaderRow[] {
  const ranked = [...field]
    .filter((c) => c.values.length > 0)
    .sort((a, b) => meanOf(b.values) - meanOf(a.values));
  return ranked.slice(0, 10).map((c) => {
    const stat = seedStat(c.values);
    return {
      id: c.id,
      label: c.label,
      score: stat.mean,
      sd: stat.sd,
      seeds: c.values.length,
      paths: c.paths,
      // Omitted at one seed on purpose — see SearchLeaderRow.ci95HalfWidth.
      ...(stat.n > 1
        ? { ci95HalfWidth: (stat.ci95[1] - stat.ci95[0]) / 2 }
        : {}),
      ...(Math.abs(slopePerDollar) > 1e-9 && baseValues.length > 0
        ? {
            impliedSpend:
              probeSpend +
              (stat.mean - meanOf(baseValues)) / Math.abs(slopePerDollar),
          }
        : {}),
      screeningEstimate: screening,
    };
  });
}

function reportLeaderboard(
  finalists: SearchFinalist[],
  objective: SearchObjective,
  paths: number,
): SearchLeaderRow[] {
  return finalists.map((f) => {
    const stat =
      objective.metric === "sustainable_spend" && f.sustainableSpend
        ? f.sustainableSpend
        : (f.probeSuccess as SeedStat);
    return {
      id: f.id,
      label: f.label,
      score: stat.mean,
      sd: stat.sd,
      seeds: stat.n,
      paths,
      ci95HalfWidth: (stat.ci95[1] - stat.ci95[0]) / 2,
      ...(objective.metric === "sustainable_spend" && f.sustainableSpend
        ? { impliedSpend: f.sustainableSpend.mean }
        : {}),
      screeningEstimate: false,
    };
  });
}

function emptyCalibration(planSpend: number): SearchCalibration {
  return {
    planSpend,
    probeSpend: planSpend,
    ladder: [],
    successPerThousand: 0,
    noiseFloorScreen: 0,
    noiseFloorReport: 0,
  };
}

function placeholderBaseline(profile: Profile, base: Scenario): SearchFinalist {
  void profile;
  return {
    id: "baseline",
    assignment: {},
    label: "your plan as it stands",
    scenario: base,
    planHash: planHash(base),
    feasible: false,
    rank: 0,
    tiedWithWinner: false,
  };
}

// ---------------------------------------------------------------------------
// Attribution
// ---------------------------------------------------------------------------

interface AttributionArgs {
  axes: SearchAxis[];
  profile: Profile;
  base: Scenario;
  baseScenario: Scenario;
  winner: MeasuredPlan;
  winnerAssignment: SearchAssignment;
  baselineProbe: number[];
  winnerProbe: number[];
  seeds: number[];
  paths: number;
  probeSpend: number;
  slopePerDollar: number;
  objective: SearchObjective;
  successSeries: (
    s: Scenario,
    spend: number,
    seeds: number[],
    paths: number,
  ) => Promise<{ values: number[] }>;
  polish: boolean;
  polishSeeds: number[];
  polishPaths: number;
  onStage: (label: string) => void;
}

/**
 * What each decision was worth, measured two ways because they answer different
 * questions.
 *
 *   "on its own"        = ADD-ONE-KNOB. Change this dimension alone, from the
 *                         plan as it stands. What the user can act on
 *                         independently, without adopting the whole winner.
 *   "inside the winner" = REVERT-ONE-KNOB. Put this dimension back to the
 *                         plan's own setting while everything else stays at the
 *                         winner's. What dropping it costs.
 *
 * Where the two agree, the decision is separable. Where they diverge, it has a
 * partner and the note says so. Both fall out of evaluations the polish pass
 * needs anyway, so the second column is nearly free.
 *
 * Measured in success at the probe spend and converted to dollars with the
 * calibrated slope: one evaluation per configuration per seed, against the
 * six-probe bisection a dollar measurement would need. That is the difference
 * between a 480-evaluation attribution pass and a 2,880-evaluation one, and it
 * is why the conversion is flagged `approximate` everywhere it appears.
 */
async function buildAttribution(args: AttributionArgs): Promise<{
  rows: SearchAttributionRow[];
  interactionResidual?: number;
  betterNeighbours: string[];
}> {
  const {
    axes,
    profile,
    base,
    baseScenario,
    winner,
    winnerAssignment,
    baselineProbe,
    winnerProbe,
    seeds,
    paths,
    probeSpend,
    slopePerDollar,
    objective,
    successSeries,
  } = args;

  // Success -> dollars, via the calibrated local slope. NOTE that this drops
  // the additive constant (the probe spend itself): only DIFFERENCES of these
  // values are ever taken, so a shared offset is irrelevant, and leaving it out
  // keeps the conversion obviously linear. Every figure derived this way is
  // flagged `approximate` — it is ranking-grade, not quotable; the finalists
  // above carry the real per-seed bisection instead.
  // The conversion is only available when the slope was actually measurable.
  // With a flat success-vs-spend curve there is no exchange rate, so these
  // rows stay in percentage points — AND the practical floor has to switch
  // units with them. Formatting a success fraction with a dollar sign because
  // the metric was nominally "dollars" would be a fabricated number.
  const inDollars =
    objective.metric === "sustainable_spend" && Math.abs(slopePerDollar) > 1e-9;
  const toUnits = (successValues: number[]): number[] =>
    inDollars
      ? successValues.map((s) => s / Math.abs(slopePerDollar))
      : successValues;
  const fmt = inDollars ? fmtDollars : fmtPP;
  const floor =
    inDollars || objective.metric === "success"
      ? objective.practicalFloor
      : DEFAULT_FLOOR_SUCCESS;
  const approximate = objective.metric === "sustainable_spend";
  const mkDelta = (a: number[], b: number[]): PairedDelta =>
    pairedDelta(toUnits(a), toUnits(b), {
      practicalFloor: floor,
      format: fmt,
      seedsLabel: `${seeds.length} held-out seeds`,
      ...(approximate ? { approximate: true } : {}),
    });

  const winnerHash = planHash(winner.scenario);
  const baselineHash = planHash(baseScenario);
  const rows: SearchAttributionRow[] = [];
  const insideFamily: PairedDelta[] = [];
  const ownFamily: PairedDelta[] = [];
  /*
   * Rows are staged rather than emitted, because the prose and the `separable`
   * flag both read verdicts that holmAdjust rewrites at the end of the loop.
   * Finished rows (the inert ones, which have no verdicts to adjust) ride along
   * so that the table keeps AXIS ORDER — materialising the deferred rows in a
   * second pass would otherwise float every inert row to the top of the report.
   */
  type Pending =
    | { ready: SearchAttributionRow }
    | {
        axis: SearchAxis;
        idx: number | undefined;
        winnerLevel: string;
        degenerate: boolean;
        insideWinner: PairedDelta | undefined;
        onOwn: PairedDelta | undefined;
      };
  const pending: Pending[] = [];
  const betterNeighbours: string[] = [];

  for (const axis of axes) {
    const idx = winnerAssignment[axis.dim];
    const winnerLevel =
      idx !== undefined ? levelLabel(axis, idx) : "your plan's own setting";

    // TRULY INERT means the knob is DISCONNECTED under the winner's other
    // settings: every level of it compiles to the very same plan. That is a
    // different statement from "the winner left this knob alone", and the two
    // must never share a label — the first says the question does not arise,
    // the second says the plan's own answer survived the search.
    const inert = axis.levels.every(
      (_, i) =>
        planHash(
          compileCandidate(profile, base, axes, {
            ...winnerAssignment,
            [axis.dim]: i,
          } as SearchAssignment),
        ) === winnerHash,
    );
    if (inert) {
      pending.push({
        ready: {
          dim: axis.dim,
          label: dimLabel(axis.dim),
          winnerLevel,
          inert: true,
          note:
            `The question does not arise: with everything else at the winner's settings, ` +
            `${dimLabel(axis.dim)} cannot change any number — every level of it is the same plan. ` +
            "Reporting a near-zero effect here would be reporting the arithmetic of a " +
            "disconnected knob.",
        },
      });
      continue;
    }

    // REVERT-ONE: drop this axis from the winner's assignment entirely, which
    // is exactly "put it back to whatever the plan already said" — no guessing
    // which level the incumbent is on.
    const reverted = { ...winnerAssignment };
    delete reverted[axis.dim];
    const revertScenario = compileCandidate(profile, base, axes, reverted);
    const revertHash = planHash(revertScenario);

    // ADD-ONE: only this axis, applied to the plan as it stands.
    const alone: SearchAssignment =
      idx !== undefined ? ({ [axis.dim]: idx } as SearchAssignment) : {};
    const aloneScenario = compileCandidate(profile, base, axes, alone);
    const aloneHash = planHash(aloneScenario);

    let insideWinner: PairedDelta | undefined;
    if (revertHash !== winnerHash) {
      const revert = await successSeries(
        revertScenario,
        probeSpend,
        seeds,
        paths,
      );
      insideWinner = mkDelta(winnerProbe, revert.values);
      insideFamily.push(insideWinner);
    }

    let onOwn: PairedDelta | undefined;
    if (aloneHash !== baselineHash) {
      const aloneRun = await successSeries(
        aloneScenario,
        probeSpend,
        seeds,
        paths,
      );
      onOwn = mkDelta(aloneRun.values, baselineProbe);
      ownFamily.push(onOwn);
    }

    // When the winner moves only THIS knob, the two columns are the same
    // comparison and their agreement carries no information. Say so rather than
    // congratulating the decision for agreeing with itself.
    const degenerate = revertHash === baselineHash && aloneHash === winnerHash;

    // `separable` and the prose are DEFERRED, because both read verdicts that
    // holmAdjust is about to rewrite. Computing them here froze the pre-
    // adjustment story into the row: a decision Holm demotes to noise would
    // still carry a note declaring it worth the dollars, and `separable` would
    // report agreement between two verdicts that no longer exist. The
    // adjustment has to finish before anything describes its results.
    pending.push({ axis, idx, winnerLevel, degenerate, insideWinner, onOwn });
  }

  holmAdjust(insideFamily);
  holmAdjust(ownFamily);

  for (const p of pending) {
    if ("ready" in p) {
      rows.push(p.ready);
      continue;
    }
    const separable =
      p.insideWinner && p.onOwn && !p.degenerate
        ? p.insideWinner.verdict === p.onOwn.verdict &&
          Math.sign(p.insideWinner.mean) === Math.sign(p.onOwn.mean)
        : undefined;
    rows.push({
      dim: p.axis.dim,
      label: dimLabel(p.axis.dim),
      winnerLevel: p.winnerLevel,
      ...(p.insideWinner ? { insideWinner: p.insideWinner } : {}),
      ...(p.onOwn ? { onOwn: p.onOwn } : {}),
      ...(separable !== undefined ? { separable } : {}),
      note: attributionNote(
        dimLabel(p.axis.dim),
        p.winnerLevel,
        p.idx !== undefined,
        p.degenerate,
        p.insideWinner,
        p.onOwn,
        separable,
        fmt,
      ),
    });
  }

  // POLISH / LOCAL-OPTIMUM CERTIFICATE. Flipping each dimension through its
  // other levels at the winner's settings both certifies the winner is a local
  // optimum and fills in the "what did not matter" column — the same
  // evaluations serve both purposes, which is why the pass is worth its cost.
  if (args.polish) {
    args.onStage("checking the winner is a local optimum");
    const polishWinner = await successSeries(
      winner.scenario,
      probeSpend,
      args.polishSeeds,
      args.polishPaths,
    );
    for (const row of rows) {
      const axis = axes.find((a) => a.dim === row.dim);
      if (!axis || row.inert) continue;
      const chosen = winnerAssignment[axis.dim];
      const levels: NonNullable<SearchAttributionRow["levels"]> = [];
      for (let i = 0; i < axis.levels.length; i++) {
        if (i === chosen) continue;
        const alt = { ...winnerAssignment, [axis.dim]: i } as SearchAssignment;
        const altScenario = compileCandidate(profile, base, axes, alt);
        if (planHash(altScenario) === winnerHash) continue;
        const got = await successSeries(
          altScenario,
          probeSpend,
          args.polishSeeds,
          args.polishPaths,
        );
        const delta = pairedDelta(
          toUnits(got.values),
          toUnits(polishWinner.values),
          {
            practicalFloor: floor,
            format: fmt,
            seedsLabel: `${args.polishSeeds.length} held-out seeds`,
            ...(approximate ? { approximate: true } : {}),
          },
        );
        levels.push({ label: levelLabel(axis, i), delta });
        if (delta.verdict === "better") {
          betterNeighbours.push(
            `${dimLabel(axis.dim)} -> ${levelLabel(axis, i)} (${delta.note.split(".")[0]})`,
          );
        }
      }
      if (levels.length > 0) row.levels = levels;
    }
  }

  // THE PARTS DO NOT ADD UP, and pretending they do is the classic attribution
  // lie. Report the remainder with its sign so the reader knows whether the
  // decisions reinforce one another or overlap.
  let interactionResidual: number | undefined;
  const winnerTotal = mkDelta(winnerProbe, baselineProbe);
  const sumOfParts = rows.reduce((s, r) => s + (r.onOwn?.mean ?? 0), 0);
  if (Number.isFinite(winnerTotal.mean))
    interactionResidual = winnerTotal.mean - sumOfParts;

  return {
    rows,
    ...(interactionResidual !== undefined ? { interactionResidual } : {}),
    betterNeighbours,
  };
}

function attributionNote(
  dim: string,
  winnerLevel: string,
  winnerMovedIt: boolean,
  degenerate: boolean,
  insideWinner: PairedDelta | undefined,
  onOwn: PairedDelta | undefined,
  separable: boolean | undefined,
  fmt: (v: number) => string,
): string {
  const parts: string[] = [];
  if (!winnerMovedIt) {
    // Not the same as inert, and the difference matters: the search TRIED other
    // levels of this knob and none of them won, so the plan's own answer stood.
    parts.push(
      `The search left ${dim} where your plan already had it — no level of it beat what you ` +
        "are doing. The alternatives it tried, and what each was worth, are in the levels below.",
    );
  }
  if (onOwn)
    parts.push(
      `On its own, ${winnerLevel} is worth ${signed(onOwn.mean, fmt)}. ${onOwn.note}`,
    );
  if (insideWinner) {
    parts.push(
      `Inside the winner, dropping it costs ${signed(insideWinner.mean, fmt)}. ${insideWinner.note}`,
    );
  }
  if (degenerate) {
    parts.push(
      "The winner changes only this knob, so both columns are literally the same comparison — " +
        "their agreement says nothing extra.",
    );
  } else if (separable === true) {
    parts.push(
      "The two agree, so this decision stands on its own — you can take it without the rest.",
    );
  } else if (separable === false) {
    parts.push(
      "The two disagree, so this decision has a partner: it is worth something different alone " +
        "than it is alongside the winner's other choices. Read the levels table before taking " +
        "it in isolation.",
    );
  }
  if (parts.length === 0) return `${dim}: nothing measurable to compare.`;
  return parts.join(" ");
}

function signed(v: number, fmt: (x: number) => string): string {
  return `${v >= 0 ? "+" : "-"}${fmt(v)}`;
}

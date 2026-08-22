/**
 * SCORING A PLAN: run it at final quality and report the number, or the reason
 * there isn't one.
 *
 * Two callers ask this question about two different things — a net-worth row
 * asks it about the plan as it stands (snapshotScorer.ts), a version in the
 * plan's history asks it about the plan as it stood (planHistoryScorer.ts) —
 * and the answer has to mean the same thing on both. A trend of probabilities
 * only means anything if every point answers the same question, so the mode,
 * the paths and the seed are decided HERE, once, from the profile's own
 * settings, rather than by whoever is asking.
 *
 * WHAT "FRESH" MEANS HERE. This does NOT pass `fresh: true`, and that is
 * deliberate. The run key already includes the fully resolved profile —
 * holdings balances derived from today's quotes — plus the assumptions, the
 * plan, the mode, the paths and the seed. So an unchanged world legitimately
 * returns the identical number from the run cache, and a changed one (a price
 * moved, an expense was edited, the engine was bumped) misses the cache and
 * re-runs. "Fresh" means "reflects today's inputs", not "recompute what cannot
 * have changed" — forcing a re-run would spend minutes to reproduce a number
 * bit for bit.
 */
import type {
  PlanScore,
  RunProgress,
  RunRequest,
  RunResult,
  Scenario,
} from '../shared/types';
import { formatUSD } from '../shared/util';
// Read, never written: the solver's own bracket and its inner path cap. A
// second copy of these numbers here would drift from the engine's silently,
// and both of the answers below are ABOUT the bracket.
import { INNER_PATH_CAP, MAX_SPEND_HI, MAX_SPEND_LO } from '../engine/solvers';
import { loadProfile } from './dataStore';
import { getRun, startRun } from './runManager';

/**
 * The mode a recorded score is always computed in. Only Monte Carlo answers
 * "in what fraction of futures does this work" — a deterministic run reports 0
 * or 1, and a historical one reports a fraction of a different, fixed
 * population that changes size with the horizon.
 */
export const SCORE_MODE = 'montecarlo' as const;

/** How often the scorer asks the run manager whether the simulation has landed. */
const POLL_MS = 500;

/**
 * When to stop waiting and record a reason instead.
 *
 * 10,000 paths on this profile is a couple of minutes; twenty of them is not a
 * slow run, it is a run that is never coming back (a wedged worker, a machine
 * asleep). Waiting forever would leave a row "scoring…" for as long as the
 * server stayed up — a state that claims work is still happening — which is
 * worse than a plain recorded failure that says nothing was measured.
 */
const TIMEOUT_MS = 20 * 60 * 1000;

/** Injectable seams — the real ones by default, fakes in tests. */
export interface ScoringDeps {
  startRun: (req: RunRequest) => Promise<{ runId: string }>;
  getRun: (runId: string) => Promise<RunProgress | null>;
  wait: (ms: number) => Promise<void>;
  now: () => Date;
}

export const REAL_SCORING_DEPS: ScoringDeps = {
  startRun,
  getRun,
  wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: () => new Date(),
};

/** A number, or the sentence that goes on the row instead of one. */
export type ScoreAttempt = { ok: true; score: PlanScore } | { ok: false; reason: string };

/**
 * The plan a scoring run actually runs: the plan as written, minus any solver.
 *
 * The same strip the workbench makes before every plain run
 * (resultsData.scenarioForPlainRun). A `solver` on the scenario makes the
 * engine run a SWEEP instead of a projection — many simulations, answering a
 * question about a different plan — and a plan hand-edited through the Raw JSON
 * editor, or filed before the sweep UI was removed, can still carry one. What
 * is stored keeps whatever it was stored with (and its hash covers it); what
 * runs is the plan as written, exactly as in the workbench.
 */
export function planForScoring(scenario: Scenario): Scenario {
  const { solver: _solver, ...rest } = scenario;
  return rest;
}

/** Start a run and wait for it, or say why there is no result. */
async function runToCompletion(
  request: RunRequest,
  deps: ScoringDeps,
): Promise<{ ok: true; result: RunResult } | { ok: false; reason: string }> {
  let runId: string;
  try {
    ({ runId } = await deps.startRun(request));
  } catch (err) {
    // The usual one: a holdings symbol with no stored quote. The message names
    // the symbol and the fix, so it is passed through whole.
    return { ok: false, reason: `The simulation could not start: ${message(err)}` };
  }

  const deadline = deps.now().getTime() + TIMEOUT_MS;
  for (;;) {
    const progress = await deps.getRun(runId);
    if (progress?.status === 'done' && progress.result) {
      return { ok: true, result: progress.result };
    }
    if (progress === null) {
      // The run manager has never heard of this id — it cannot be waited on,
      // and pretending otherwise would poll until the deadline for nothing.
      return { ok: false, reason: 'The simulation disappeared before it produced a result.' };
    }
    if (progress.status === 'error') {
      return { ok: false, reason: `The simulation failed: ${progress.error ?? 'no reason given'}` };
    }
    if (deps.now().getTime() >= deadline) {
      return {
        ok: false,
        reason:
          `The simulation did not finish within ${Math.round(TIMEOUT_MS / 60000)} minutes. ` +
          // Deliberately silent about what to press: this message lands on a
          // net-worth row, which is never scored twice, AND on a plan version,
          // which may be scored once a failure is all it carries. Naming one
          // repair would be wrong on the other half of its readers.
          'Nothing recorded was lost — the record itself is untouched; only the measurement is ' +
          'missing.',
      };
    }
    await deps.wait(POLL_MS);
  }
}

/**
 * Score one plan: its probability of success, and what it leaves behind.
 *
 * The paths and the seed come from the profile's settings and the CONDITIONS
 * ARE READ BACK OFF THE RUN, not off the request — a cache hit returns the
 * conditions it was computed under, and those are the ones this number
 * actually has.
 */
export async function scorePlan(plan: Scenario, deps: ScoringDeps): Promise<ScoreAttempt> {
  let request: RunRequest;
  try {
    // Only `settings` is read here — the paths and seed that make successive
    // scores comparable. The run resolves the profile itself (holdings priced
    // from stored quotes), which is what puts today's balances in the run key.
    const profile = await loadProfile();
    request = {
      scenario: planForScoring(plan),
      mode: SCORE_MODE,
      paths: profile.settings.mcPathsFinal,
      seed: profile.settings.seed,
    };
  } catch (err) {
    return { ok: false, reason: `The profile could not be read: ${message(err)}` };
  }

  const run = await runToCompletion(request, deps);
  if (!run.ok) return run;
  const result = run.result;
  return {
    ok: true,
    score: {
      success: result.success,
      ...(Number.isFinite(result.medianTerminalReal)
        ? { medianTerminalReal: result.medianTerminalReal }
        : {}),
      mode: SCORE_MODE,
      paths: result.meta.paths,
      seed: result.meta.seed,
      engineVersion: result.meta.engineVersion,
      scoredAt: deps.now().toISOString(),
    },
  };
}

export function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * WHAT THIS PLAN COULD AFFORD, or why there is no answer.
 *
 * The dollar-denominated score, and for this household the one that separates
 * its versions at all: its probability of success saturates near the ceiling,
 * so two plans can both read 96-point-something while differing by tens of
 * thousands a year in what they can actually spend.
 */
export type SpendAttempt =
  | { ok: true; sustainableSpend: number; sustainableSpendPaths: number }
  | { ok: false; reason: string };

/**
 * Bisect the plan's max sustainable living spend, through the engine's own
 * max_spend solver.
 *
 * COST: a dozen inner runs plus one full one, so tens of seconds where the
 * success score is one run. That is why this is a separate call the caller
 * makes AFTER the success number is already recorded — the cheap half must
 * never wait on the expensive one, and a failure here must not cost it.
 *
 * TWO NON-ANSWERS, both recorded as reasons rather than numbers:
 *
 *  - THE CEILING PASSED. When even the top of the solver's bracket clears the
 *    success target, the solver returns that top ($400,000/yr) after two
 *    probes, and it is indistinguishable inside SolverResult from a bisected
 *    answer. Recording it would put a figure on the row that nothing measured:
 *    the truth is "more than this", not "this". For an over-funded plan that is
 *    the likely case, so it gets a sentence of its own.
 *  - THE FLOOR FAILED. Nothing in the bracket reaches the target, so there is
 *    no sustainable level to report at all.
 */
export async function solveSustainableSpend(
  plan: Scenario,
  deps: ScoringDeps,
): Promise<SpendAttempt> {
  let request: RunRequest;
  try {
    const profile = await loadProfile();
    request = {
      // The plan's own solver (if it had one) is stripped first: what runs here
      // is a max_spend sweep of the plan as written, not whatever sweep someone
      // typed into the Raw JSON editor.
      scenario: { ...planForScoring(plan), solver: { type: 'max_spend' } },
      mode: SCORE_MODE,
      paths: profile.settings.mcPathsFinal,
      seed: profile.settings.seed,
    };
  } catch (err) {
    return { ok: false, reason: `The profile could not be read: ${message(err)}` };
  }

  const run = await runToCompletion(request, deps);
  if (!run.ok) return run;

  const answer = run.result.solverOutput?.answer;
  if (answer === undefined) {
    return {
      ok: false,
      reason:
        `No spending level down to ${formatUSD(MAX_SPEND_LO)}/yr reaches this plan’s success ` +
        'target, so there is no sustainable level to report.',
    };
  }
  if (answer >= MAX_SPEND_HI) {
    return {
      ok: false,
      reason:
        `Even ${formatUSD(MAX_SPEND_HI)}/yr clears this plan’s success target, so the ` +
        'sustainable level is above the top of the solver’s range — more than this, not this.',
    };
  }
  return {
    ok: true,
    sustainableSpend: answer,
    // The solver caps its inner sweep runs (engine/solvers.runSolver), so this
    // number is measured at lower precision than the success figure beside it.
    // Recorded rather than assumed: a label carries its own condition.
    sustainableSpendPaths: Math.min(run.result.meta.paths, INNER_PATH_CAP),
  };
}

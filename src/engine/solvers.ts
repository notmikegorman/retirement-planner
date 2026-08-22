/**
 * Scenario solvers (SPEC §9 scenarios 1, 5, 6): retire_year_sweep,
 * ss_claim_sweep, swr_curve, max_spend, earliest_retirement.
 *
 * Every solver runs VARIANTS of the input scenario: the scenario is
 * structuredClone'd, events / fields are mutated, and runSimulation is called
 * on the variant with the SAME mode and seed as the input — deterministic
 * seeds make every sweep reproducible. The PROFILE is never touched: the
 * spending solvers vary living expenses through the scenario's
 * assumption_overrides.expenses, the same mechanism a hand-written what-if
 * uses (and the only one that outranks an override the scenario already has).
 *
 * Inner sweep runs are capped at INNER_PATH_CAP paths when input.paths
 * exceeds it (the cap is noted in answerLabel) so a 10,000-path final run
 * doesn't turn a 100-point sweep into a million path-simulations. The
 * returned RunResult's meta / fan / referencePath come from the base
 * scenario's own runSimulation (run once, at full input.paths), with
 * solverOutput attached.
 *
 * runKey correctness: runSimulation hashes the entire scenario object —
 * including its `solver` field — into meta.runKey (verified in
 * simulate.ts), so a solver run can never collide in the run cache with a
 * plain run of the same events.
 *
 * Success target precedence: spec.targetSuccess (for specs that carry one)
 * -> scenario assumption_overrides.settings.successTarget ->
 * profile.settings.successTarget.
 *
 * ss_claim_sweep expected lifetime benefits: household claiming reduces to
 * ONE date because person 2's benefit is purely spousal and gated by person
 * 1's filing (SPEC §9.5). Per claim date, the benefit total is computed from
 * a deterministic-mode variant's referencePath as
 * sum(row.income.socialSecurity / row.inflationIndex) — a REAL-dollar
 * (start-year dollars) undiscounted lifetime total through the horizon
 * (default age 95). Undiscounted-real is the standard break-even framing for
 * claiming-age comparisons; it is independent of the return path because
 * SS COLA = simulated CPI exactly cancels the deflation.
 */

import type {
  ProgressFn,
  Profile,
  RunResult,
  Scenario,
  ScenarioEvent,
  SimulationInput,
  SolverPoint,
  SolverResult,
  SolverSpec,
  YearMonth,
} from '../shared/types';
import { formatPct, formatUSD } from '../shared/util';
import { deriveExpenseStreams } from '../shared/expenses';
import { SIM_START_YEAR } from './household';
import { runSimulation } from './simulate';

/** Inner sweep runs never use more than this many paths (noted in answerLabel). */
export const INNER_PATH_CAP = 2000;

/** max_spend bisection bounds and stopping rules (task spec). */
export const MAX_SPEND_LO = 20000;
export const MAX_SPEND_HI = 400000;
const MAX_SPEND_ITERATIONS = 12;
const MAX_SPEND_INTERVAL = 500; // dollars

// ---------------------------------------------------------------------------
// Variant plumbing
// ---------------------------------------------------------------------------

interface SolverCtx {
  input: SimulationInput;
  /** Paths for inner sweep runs (min(input.paths, INNER_PATH_CAP)). */
  innerPaths: number;
  capped: boolean;
  target: number;
  /** Base scenario with the solver field stripped (variants derive from this). */
  baseScenario: Scenario;
}

/** "YYYY-MM" from numeric year/month. */
function ym(year: number, month: number): YearMonth {
  return `${year}-${String(month).padStart(2, '0')}`;
}

/** Deep-cloned scenario without its solver field (variants must not re-solve). */
function cloneWithoutSolver(scenario: Scenario): Scenario {
  const { solver: _solver, ...rest } = structuredClone(scenario);
  return rest;
}

/** Variant: every person's retire event replaced/set to July of `year` (claims untouched). */
function withRetirementsAt(ctx: SolverCtx, year: number): Scenario {
  const scenario = cloneWithoutSolver(ctx.baseScenario);
  const events: ScenarioEvent[] = scenario.events.filter((e) => e.type !== 'retire');
  for (const p of ctx.input.profile.people) {
    events.push({ type: 'retire', person: p.id, date: ym(year, 7) });
  }
  scenario.events = events;
  return scenario;
}

/**
 * Scenario with a `death` event on `person` in July of `year`, replacing any
 * death the scenario already carried.
 *
 * July for the same reason the retirement sweep uses it: a sweep over YEARS
 * needs one month, and mid-year is the least misleading choice — it splits the
 * year's salary, Social Security and living costs down the middle instead of
 * pretending a death that could fall anywhere in the year always falls in
 * January (which would overstate the damage) or December (which would hide it
 * for a year).
 *
 * Exported because the widow score is not only a sweep: the UI and the server
 * ask "what if he dies in 2029" as a single ordinary run, and this is how that
 * scenario is built. There is no survivor code path — a widow score is a
 * normal simulation of a plan that happens to contain a death.
 */
export function scenarioWithDeath(
  scenario: Scenario,
  person: string,
  year: number,
  opts?: { month?: number; livingFraction?: number },
): Scenario {
  const out = cloneWithoutSolver(scenario);
  out.events = [
    ...out.events.filter((e) => e.type !== 'death'),
    {
      type: 'death',
      person,
      date: ym(year, opts?.month ?? 7),
      ...(opts?.livingFraction !== undefined ? { livingFraction: opts.livingFraction } : {}),
    },
  ];
  return out;
}

/** Variant: every person's claim_social_security event replaced/set to `date`. */
function withClaimsAt(ctx: SolverCtx, date: YearMonth): Scenario {
  const scenario = cloneWithoutSolver(ctx.baseScenario);
  const events: ScenarioEvent[] = scenario.events.filter(
    (e) => e.type !== 'claim_social_security',
  );
  for (const p of ctx.input.profile.people) {
    events.push({ type: 'claim_social_security', person: p.id, date });
  }
  scenario.events = events;
  return scenario;
}

/** Run one variant with the input's mode/seed and the (possibly capped) inner path count. */
function runVariant(ctx: SolverCtx, scenario: Scenario): RunResult {
  return runSimulation({
    profile: ctx.input.profile,
    assumptions: ctx.input.assumptions,
    scenario,
    mode: ctx.input.mode,
    paths: ctx.innerPaths,
    seed: ctx.input.seed,
  });
}

/**
 * Scenario clone whose LIVING expense stream equals `spend` per year
 * (livingMonthly = spend / 12 — the solvers sweep annual spending levels).
 * The charitable and investing streams are left alone: giving is not the
 * variable being solved for, and investing is capped at surplus anyway.
 *
 * Expressed as a scenario-level assumption_overrides.expenses entry rather
 * than a mutated profile clone. Identical arithmetic (prepareSim substitutes
 * the stream before anything reads it), and it keeps the sweep authoritative:
 * an override always beats the profile, so a scenario that already carries an
 * expenses override would otherwise outrank a profile the solver had edited
 * and flatten the whole curve.
 */
function scenarioWithSpend(profile: Profile, scenario: Scenario, spend: number): Scenario {
  const out = structuredClone(scenario);
  const overrides = out.assumption_overrides?.expenses;
  const derived = deriveExpenseStreams(profile.expenses);
  const working = overrides?.livingMonthly ?? derived.livingMonthly;
  const retired = overrides?.livingMonthlyRetired ?? derived.livingMonthlyRetired;
  const monthly = spend / 12;
  const expenses: NonNullable<NonNullable<Scenario['assumption_overrides']>['expenses']> = {
    ...overrides,
    livingMonthly: monthly,
  };
  /*
   * BOTH SIDES MOVE, in proportion.
   *
   * Setting only the working figure was correct while a profile had no separate
   * retired one — the retired side inherits the working side, so the sweep moved
   * every year. An itemised budget breaks that: the moment one row names a
   * figure in the "if I stop working" column, the derivation produces a retired
   * total, and a sweep that leaves it pinned changes spending only for the years
   * still earning. This plan retires in 2028 against a horizon in 2061, so that
   * is 2 years swept and 33 untouched — the curve goes flat and max-sustainable
   * spend comes back as whatever the top of the bracket was.
   *
   * The RATIO is preserved rather than both sides being set equal, so a
   * household that plans to live on less after it stops working keeps that
   * intention at every probe instead of having it silently normalised away.
   */
  if (retired !== undefined && working > 0) {
    expenses.livingMonthlyRetired = monthly * (retired / working);
  }
  out.assumption_overrides = { ...out.assumption_overrides, expenses };
  return out;
}

// ---------------------------------------------------------------------------
// Max-spend bisection (shared by max_spend and retire_year_sweep alsoMaxSpend)
// ---------------------------------------------------------------------------

/**
 * Bisect annual living expenses on [MAX_SPEND_LO, MAX_SPEND_HI] for the highest
 * spending level whose success >= target. At most MAX_SPEND_ITERATIONS
 * midpoint probes, stopping early once the bracket is narrower than
 * MAX_SPEND_INTERVAL. Invariant: lo = highest known passing level, hi =
 * lowest known failing level. Returns the probe points sorted ascending by
 * spending level; answer is undefined when even MAX_SPEND_LO fails.
 */
function maxSpendBisection(
  ctx: SolverCtx,
  scenario: Scenario,
): { answer: number | undefined; points: SolverPoint[] } {
  const points: SolverPoint[] = [];
  const probe = (spend: number): number => {
    const res = runVariant(ctx, scenarioWithSpend(ctx.input.profile, scenario, spend));
    points.push({
      x: spend,
      label: formatUSD(spend),
      success: res.success,
      medianTerminalReal: res.medianTerminalReal,
    });
    return res.success;
  };

  const sorted = () => points.sort((a, b) => a.x - b.x);

  let lo = MAX_SPEND_LO;
  let hi = MAX_SPEND_HI;
  if (probe(lo) < ctx.target) {
    return { answer: undefined, points: sorted() }; // even the floor fails
  }
  if (probe(hi) >= ctx.target) {
    return { answer: hi, points: sorted() }; // even the ceiling passes
  }
  for (let iter = 0; iter < MAX_SPEND_ITERATIONS && hi - lo >= MAX_SPEND_INTERVAL; iter++) {
    const mid = (lo + hi) / 2;
    if (probe(mid) >= ctx.target) lo = mid;
    else hi = mid;
  }
  return { answer: lo, points: sorted() };
}

// ---------------------------------------------------------------------------
// Individual solvers (each returns points/best/answer/answerLabel)
// ---------------------------------------------------------------------------

type SolverBody = Omit<SolverResult, 'spec'>;

/** SPEC §9.1: sweep retirement year; optional max-spend bisection per year. */
function solveRetireYearSweep(
  ctx: SolverCtx,
  spec: Extract<SolverSpec, { type: 'retire_year_sweep' }>,
  tick: (done: number, total: number, message?: string) => void,
): SolverBody {
  if (spec.to < spec.from) {
    throw new Error(`retire_year_sweep: to (${spec.to}) < from (${spec.from})`);
  }
  const total = spec.to - spec.from + 1;
  const points: SolverPoint[] = [];
  for (let year = spec.from; year <= spec.to; year++) {
    const scenario = withRetirementsAt(ctx, year);
    const res = runVariant(ctx, scenario);
    const point: SolverPoint = {
      x: year,
      label: String(year),
      success: res.success,
      medianTerminalReal: res.medianTerminalReal,
    };
    if (spec.alsoMaxSpend) {
      const ms = maxSpendBisection(ctx, scenario);
      if (ms.answer !== undefined) point.maxSpend = ms.answer;
    }
    points.push(point);
    tick(year - spec.from + 1, total, `retire ${year}`);
  }
  const pass = points.find((p) => p.success >= ctx.target);
  let best = pass;
  if (!best) {
    for (const p of points) if (!best || p.success > best.success) best = p;
  }
  const answerLabel = pass
    ? `Earliest retirement year at >=${formatPct(ctx.target, 0)} success: ${pass.x}`
    : `No retirement year in ${spec.from}-${spec.to} reaches ${formatPct(ctx.target, 0)} success`;
  return {
    points,
    ...(best ? { best } : {}),
    ...(pass ? { answer: pass.x } : {}),
    answerLabel,
  };
}

/**
 * SPEC §9.5: sweep the single household claim date from 62y0m to 70y0m of
 * person 1's age. x = claim age in months; label "62y0m" style. Success comes
 * from the input-mode variant; expectedLifetimeBenefits from a
 * deterministic-mode variant (reused when the input mode is already
 * deterministic) — see the module header for the real-dollar convention.
 */
function solveSsClaimSweep(
  ctx: SolverCtx,
  spec: Extract<SolverSpec, { type: 'ss_claim_sweep' }>,
  tick: (done: number, total: number, message?: string) => void,
): SolverBody {
  const step = spec.stepMonths ?? 1;
  if (step <= 0 || !Number.isInteger(step)) {
    throw new Error(`ss_claim_sweep: stepMonths must be a positive integer, got ${step}`);
  }
  const ss = ctx.input.assumptions.socialSecurity;
  const p1 = ctx.input.profile.people[0];
  const minM = ss.minClaimAge * 12; // 62y0m = 744
  const maxM = ss.maxClaimAge * 12; // 70y0m = 840
  const ageMonthsList: number[] = [];
  for (let m = minM; m <= maxM; m += step) ageMonthsList.push(m);

  const points: SolverPoint[] = [];
  for (let i = 0; i < ageMonthsList.length; i++) {
    const ageM = ageMonthsList[i];
    // Claim date = the month person 1 reaches this age (a 1975-03 birth ->
    // 62y0m = 2037-03): absolute month of birth + ageM.
    const abs = p1.birthYear * 12 + (p1.birthMonth - 1) + ageM;
    const date = ym(Math.floor(abs / 12), (abs % 12) + 1);
    const scenario = withClaimsAt(ctx, date);
    const res = runVariant(ctx, scenario);
    const detRes =
      ctx.input.mode === 'deterministic'
        ? res
        : runSimulation({
            profile: ctx.input.profile,
            assumptions: ctx.input.assumptions,
            scenario,
            mode: 'deterministic',
            paths: 1,
            seed: ctx.input.seed,
          });
    let benefitsReal = 0;
    for (const row of detRes.referencePath) {
      benefitsReal += row.income.socialSecurity / row.inflationIndex;
    }
    const label = `${Math.floor(ageM / 12)}y${ageM % 12}m`;
    points.push({
      x: ageM,
      label,
      success: res.success,
      medianTerminalReal: res.medianTerminalReal,
      expectedLifetimeBenefits: benefitsReal,
    });
    tick(i + 1, ageMonthsList.length, `claim at ${label}`);
  }

  // Best = highest success; ties broken by higher lifetime benefits.
  let best = points[0];
  for (const p of points) {
    if (
      p.success > best.success ||
      (p.success === best.success &&
        (p.expectedLifetimeBenefits ?? 0) > (best.expectedLifetimeBenefits ?? 0))
    ) {
      best = p;
    }
  }
  return {
    points,
    best,
    answer: best.x,
    answerLabel:
      `Best claiming age: ${best.label} ` +
      `(success ${formatPct(best.success, 1)}, ` +
      `expected lifetime benefits ${formatUSD(best.expectedLifetimeBenefits ?? 0)} real)`,
  };
}

/**
 * THE WIDOW SCORE: survivor probability of success by year of death.
 *
 * One ordinary simulation per candidate year, each with a `death` event in it.
 * Nothing about the machinery is special — the survivor's filing status,
 * Social Security, ACA cliff and spousal rollover all come from the
 * same engine the household run uses — which is exactly the property that
 * makes the two numbers comparable. A parallel "survivor engine" could drift
 * from the real one and nobody would notice until it mattered.
 *
 * WHY A CURVE RATHER THAN A NUMBER. The question is not "what is the
 * survivor's score" but "what does another year of work, or another year of
 * term insurance, DO to that score" — and that is a shape, not a point. A plan
 * whose widow score climbs steeply through the next three years says the risk
 * is concentrated and temporary (bridge it with term life); one that is flat
 * and low says the plan itself does not support a survivor, and no amount of
 * insurance timing fixes that.
 *
 * Read every point against the base scenario's own success, which runSolver
 * returns alongside as it does for every sweep. The GAP is the widow penalty
 * priced in probability.
 */
function solveWidowScore(
  ctx: SolverCtx,
  spec: Extract<SolverSpec, { type: 'widow_score' }>,
  tick: (done: number, total: number, message?: string) => void,
): SolverBody {
  const people = ctx.input.profile.people;
  // Default to the earner: that death is the one that takes a salary, the
  // larger Social Security record and (usually) the insurance with it.
  const person =
    spec.person ??
    (people.find((p) => (ctx.input.profile.income.salaries[p.id] ?? 0) > 0) ?? people[0]).id;
  if (!people.some((p) => p.id === person)) {
    throw new Error(
      `widow_score: unknown person "${person}" (known: ${people.map((p) => p.id).join(', ')})`,
    );
  }
  if (people.length < 2) {
    throw new Error(
      'widow_score: the profile has only one person, so there is no survivor to score.',
    );
  }
  const from = spec.from ?? SIM_START_YEAR;
  const to = spec.to ?? from + 20;
  const step = spec.step ?? 1;
  if (to < from) throw new Error(`widow_score: to (${to}) < from (${from})`);
  if (step <= 0 || !Number.isInteger(step)) {
    throw new Error(`widow_score: step must be a positive integer, got ${step}`);
  }

  const years: number[] = [];
  for (let y = from; y <= to; y += step) years.push(y);
  const points: SolverPoint[] = [];
  for (let i = 0; i < years.length; i++) {
    const year = years[i];
    const res = runVariant(
      ctx,
      scenarioWithDeath(ctx.baseScenario, person, year, {
        ...(spec.livingFraction !== undefined ? { livingFraction: spec.livingFraction } : {}),
      }),
    );
    points.push({
      x: year,
      label: String(year),
      success: res.success,
      medianTerminalReal: res.medianTerminalReal,
    });
    tick(i + 1, years.length, `death in ${year}`);
  }

  // The answer is the first year the survivor's score clears the target — i.e.
  // the year from which the household no longer relies on the earner staying
  // alive. Before
  // it is the window term insurance exists to cover.
  const firstPass = points.find((p) => p.success >= ctx.target);
  let worst = points[0];
  for (const p of points) if (p.success < worst.success) worst = p;
  // `best` is the WORST point on purpose: a fan chart highlights the answer,
  // and the answer a widow score is asked for is where the plan is weakest.
  const answerLabel = firstPass
    ? `Widow score reaches ${formatPct(ctx.target, 0)} for a death in ${firstPass.x} or later; ` +
      `the weakest year is ${worst.label} at ${formatPct(worst.success, 1)}`
    : `No death year in ${from}-${to} leaves the survivor at ${formatPct(ctx.target, 0)}; ` +
      `the weakest year is ${worst.label} at ${formatPct(worst.success, 1)}`;
  return {
    points,
    best: worst,
    ...(firstPass ? { answer: firstPass.x } : {}),
    answerLabel,
  };
}

/** SPEC §9.6: success per spending level; answer = max level with success >= target. */
function solveSwrCurve(
  ctx: SolverCtx,
  spec: Extract<SolverSpec, { type: 'swr_curve' }>,
  tick: (done: number, total: number, message?: string) => void,
): SolverBody {
  if (spec.step <= 0) throw new Error(`swr_curve: step must be positive, got ${spec.step}`);
  if (spec.spendTo < spec.spendFrom) {
    throw new Error(`swr_curve: spendTo (${spec.spendTo}) < spendFrom (${spec.spendFrom})`);
  }
  // Levels computed as spendFrom + i*step (not accumulated) to avoid float drift.
  const n = Math.floor((spec.spendTo - spec.spendFrom) / spec.step + 1e-9) + 1;
  const points: SolverPoint[] = [];
  for (let i = 0; i < n; i++) {
    const spend = spec.spendFrom + i * spec.step;
    const res = runVariant(ctx, scenarioWithSpend(ctx.input.profile, ctx.baseScenario, spend));
    points.push({
      x: spend,
      label: `${formatUSD(spend)}/yr`,
      success: res.success,
      medianTerminalReal: res.medianTerminalReal,
    });
    tick(i + 1, n, `spend ${formatUSD(spend)}`);
  }
  let best: SolverPoint | undefined;
  for (const p of points) {
    if (p.success >= ctx.target) best = p; // ascending sweep: last pass = max level
  }
  const answerLabel = best
    ? `Max spending at >=${formatPct(ctx.target, 0)} success: ${formatUSD(best.x)}/yr`
    : `No spending level in ${formatUSD(spec.spendFrom)}-${formatUSD(spec.spendTo)} reaches ` +
      `${formatPct(ctx.target, 0)} success`;
  return {
    points,
    ...(best ? { best, answer: best.x } : {}),
    answerLabel,
  };
}

/** Max sustainable spending via bisection (task spec: [20k, 400k], 12 iters or <$500). */
function solveMaxSpend(
  ctx: SolverCtx,
  tick: (done: number, total: number, message?: string) => void,
): SolverBody {
  const { answer, points } = maxSpendBisection(ctx, ctx.baseScenario);
  tick(1, 1);
  let best: SolverPoint | undefined;
  if (answer !== undefined) best = points.find((p) => p.x === answer);
  const answerLabel =
    answer !== undefined
      ? `Max sustainable spending at >=${formatPct(ctx.target, 0)} success: ` +
        `${formatUSD(answer)}/yr`
      : `No spending level in ${formatUSD(MAX_SPEND_LO)}-${formatUSD(MAX_SPEND_HI)} reaches ` +
        `${formatPct(ctx.target, 0)} success`;
  return {
    points,
    ...(best ? { best } : {}),
    ...(answer !== undefined ? { answer } : {}),
    answerLabel,
  };
}

/** Ascending retirement-year probe; the first year meeting the target wins. */
function solveEarliestRetirement(
  ctx: SolverCtx,
  spec: Extract<SolverSpec, { type: 'earliest_retirement' }>,
  tick: (done: number, total: number, message?: string) => void,
): SolverBody {
  const from = spec.from ?? 2026;
  const to = spec.to ?? 2035;
  if (to < from) throw new Error(`earliest_retirement: to (${to}) < from (${from})`);
  const total = to - from + 1;
  const points: SolverPoint[] = [];
  let winner: SolverPoint | undefined;
  for (let year = from; year <= to; year++) {
    const res = runVariant(ctx, withRetirementsAt(ctx, year));
    const point: SolverPoint = {
      x: year,
      label: String(year),
      success: res.success,
      medianTerminalReal: res.medianTerminalReal,
    };
    points.push(point);
    tick(year - from + 1, total, `retire ${year}`);
    if (res.success >= ctx.target) {
      winner = point;
      break; // first year meeting the target wins; later years are not probed
    }
  }
  const answerLabel = winner
    ? `Earliest retirement year at >=${formatPct(ctx.target, 0)} success: ${winner.x}`
    : `No retirement year in ${from}-${to} reaches ${formatPct(ctx.target, 0)} success`;
  return {
    points,
    ...(winner ? { best: winner, answer: winner.x } : {}),
    answerLabel,
  };
}

// ---------------------------------------------------------------------------
// runSolver
// ---------------------------------------------------------------------------

/**
 * Success target: spec override -> scenario settings override -> profile
 * default.
 *
 * `widow_score` deliberately carries NO per-spec target. The whole point of
 * the number is that the survivor is held to the SAME standard as the
 * household — a plan at 95% household and 64% widow is only alarming because
 * both are read against one bar, and letting a widow-score run quietly lower
 * its own bar would erase the comparison the feature exists to make.
 */
function targetFor(spec: SolverSpec, input: SimulationInput): number {
  const specTarget =
    spec.type === 'max_spend' || spec.type === 'earliest_retirement'
      ? spec.targetSuccess
      : undefined;
  return (
    specTarget ??
    input.scenario.assumption_overrides?.settings?.successTarget ??
    input.profile.settings.successTarget
  );
}

/**
 * Run the scenario's solver: sweep/bisect variants of the scenario, then run
 * the base scenario itself once at full input.paths for the returned
 * meta/fan/referencePath, attaching the SolverResult as solverOutput.
 * Progress: the sweep advances 0..~0.95 by variant, the base run fills the
 * final segment (retire_year_sweep progresses by years done / total, per
 * SPEC §9.1).
 */
export function runSolver(input: SimulationInput, onProgress?: ProgressFn): RunResult {
  const t0 = performance.now();
  const spec = input.scenario.solver;
  if (!spec) {
    throw new Error('runSolver: scenario has no solver spec (use runSimulation instead)');
  }
  const ctx: SolverCtx = {
    input,
    innerPaths: Math.min(input.paths, INNER_PATH_CAP),
    capped: input.paths > INNER_PATH_CAP,
    target: targetFor(spec, input),
    baseScenario: cloneWithoutSolver(input.scenario),
  };

  // The sweep occupies [0, SWEEP_FRAC) of the progress bar; the base run the rest.
  const SWEEP_FRAC = 0.95;
  const tick = (done: number, total: number, message?: string) => {
    onProgress?.((done / total) * SWEEP_FRAC, message);
  };

  let body: SolverBody;
  switch (spec.type) {
    case 'retire_year_sweep':
      body = solveRetireYearSweep(ctx, spec, tick);
      break;
    case 'ss_claim_sweep':
      body = solveSsClaimSweep(ctx, spec, tick);
      break;
    case 'swr_curve':
      body = solveSwrCurve(ctx, spec, tick);
      break;
    case 'max_spend':
      body = solveMaxSpend(ctx, tick);
      break;
    case 'earliest_retirement':
      body = solveEarliestRetirement(ctx, spec, tick);
      break;
    case 'widow_score':
      body = solveWidowScore(ctx, spec, tick);
      break;
  }
  if (ctx.capped) {
    // Every solver body sets answerLabel, so this appends rather than replaces.
    body.answerLabel =
      `${body.answerLabel} ` +
      `(sweep runs capped at ${INNER_PATH_CAP.toLocaleString('en-US')} paths; ` +
      `headline metrics use the full ${input.paths.toLocaleString('en-US')})`;
  }
  const solverOutput: SolverResult = { spec, ...body };

  // Base scenario's own full run supplies meta (runKey covers the solver spec
  // via the scenario hash), fan, and referencePath.
  const base = runSimulation(input, (frac, message) => {
    onProgress?.(SWEEP_FRAC + frac * (1 - SWEEP_FRAC), message);
  });
  return { ...base, solverOutput, elapsedMs: performance.now() - t0 };
}

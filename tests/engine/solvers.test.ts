/**
 * Tests for src/engine/solvers.ts and src/engine/index.ts (SPEC §9 scenarios
 * 1, 5, 6):
 *  1. swr_curve: success monotonically non-increasing as spending rises;
 *     answer = max level meeting the target (hand-computed zero-tax profile)
 *  2. retire_year_sweep: one point per year; later retirement never lowers
 *     success (deterministic world); alsoMaxSpend bisection per year
 *  3. max_spend: bisection converges to the hand-computed probe grid; the
 *     answer's success >= target while answer + $5k fails
 *  4. ss_claim_sweep: 9 points for stepMonths=12; 62y0m maps to 2033-06
 *     (proven via hand-computed real-dollar lifetime benefit sums); best =
 *     highest success with ties broken by benefits
 *  5. earliest_retirement: ascending probe stops at the first passing year
 *  6. execute(): dispatches on scenario.solver presence
 *  7. inner-path cap: sweeps capped at 2,000 paths (noted in answerLabel)
 *     while the base run keeps the full path count
 *  8. widow_score: every point reproduces a plain runSimulation of the
 *     scenario scenarioWithDeath builds (there is no survivor engine); the
 *     probe years and step; term life steering the curve so covered death
 *     years pass and the first uncovered one fails; the answer as the first
 *     year clearing the target with `best` deliberately the WORST point; the
 *     default person being the earner; and a household that owes no tax at all
 *     acquiring one the moment it files as a survivor
 *
 * All tests use deterministic mode with the real data-defaults files and
 * slimmed profiles chosen so the arithmetic is hand-computable (see the
 * per-test comments). Deterministic-mode success is 0 or 1 (single path).
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { execute } from '../../src/engine/index';
import { runSimulation } from '../../src/engine/simulate';
import {
  INNER_PATH_CAP,
  MAX_SPEND_HI,
  MAX_SPEND_LO,
  runSolver,
  scenarioWithDeath,
} from '../../src/engine/solvers';
import type {
  AcaData,
  Assumptions,
  FederalTaxData,
  MarketAssumptions,
  MedicareData,
  Profile,
  RmdTableData,
  Scenario,
  SimulationInput,
  SocialSecurityData,
  StateTaxData,
} from '../../src/shared/types';
import { loadHistoricalCsv } from '../../src/engine/returns';
import marketJson from '../../data-defaults/assumptions/market.json';
import federalJson from '../../data-defaults/assumptions/tax/federal-2026.json';
import vaJson from '../../data-defaults/assumptions/tax/va-2026.json';
import scJson from '../../data-defaults/assumptions/tax/sc-2026.json';
import ncJson from '../../data-defaults/assumptions/tax/nc-2026.json';
import ssJson from '../../data-defaults/assumptions/social-security.json';
import medicareJson from '../../data-defaults/assumptions/medicare-2026.json';
import acaJson from '../../data-defaults/assumptions/aca-2026.json';
import rmdJson from '../../data-defaults/assumptions/rmd-table.json';

const historical = loadHistoricalCsv(
  readFileSync(new URL('../../data-defaults/assumptions/historical-returns.csv', import.meta.url), 'utf8'),
);

function assumptions(): Assumptions {
  return {
    market: marketJson as unknown as MarketAssumptions,
    historical,
    federal: federalJson as unknown as FederalTaxData,
    states: {
      va: vaJson as unknown as StateTaxData,
      sc: scJson as unknown as StateTaxData,
      nc: ncJson as unknown as StateTaxData,
    },
    socialSecurity: ssJson as unknown as SocialSecurityData,
    medicare: medicareJson as unknown as MedicareData,
    aca: acaJson as unknown as AcaData,
    rmd: rmdJson as unknown as RmdTableData,
  };
}

/**
 * Slimmed household: both born 1971-06, single savings account (bills),
 * no housing costs, no health premiums, VA. Savings interest is DISTRIBUTED
 * (never compounds) at the deterministic bills nominal rate
 * (1 + 0.005 real) x (1 + 0.025 inflation) - 1 = 0.030125, and CPI is 2.5%/yr.
 *
 * `baseline` is the ANNUAL living-expense stream (note 12 replaced
 * expenses.annualBaseline with livingMonthly = baseline / 12); charitable and
 * investing stay 0, as does the employee premium share, so the solver
 * arithmetic below is unchanged. Both PIA figures are set to `pia`, which
 * makes the benefit independent of the retirement year — the PIA-interpolation
 * effect gets its own test in simulate.test.ts.
 */
function slimProfile(over: {
  savings?: number;
  baseline?: number;
  horizonAge?: number;
  salaryP1?: number;
  pia?: number;
  piaStoppingNow?: number;
}): Profile {
  const pia = over.pia ?? 0;
  return {
    people: [
      {
        id: 'p1',
        name: 'P1',
        birthYear: 1971,
        birthMonth: 6,
        piaMonthlyAtFraIfWorkingTo62: pia,
        piaMonthlyAtFraIfStoppingNow: over.piaStoppingNow ?? pia,
        hasOwnBenefit: pia > 0,
      },
      { id: 'p2', name: 'P2', birthYear: 1971, birthMonth: 6, piaMonthlyAtFraIfWorkingTo62: 0, piaMonthlyAtFraIfStoppingNow: 0, hasOwnBenefit: false },
    ],
    filing: { status: 'mfj', state: 'va' },
    accounts: [
      {
        id: 'savings',
        name: 'Savings',
        type: 'savings',
        owner: 'p1',
        balance: over.savings ?? 600000,
        allocation: { stocks: 0, bonds: 0, bills: 1 },
      },
    ],
    home: {
      value: 0,
      costBasis: 0,
      state: 'va',
      propertyTaxAnnual: 0,
      insuranceAnnual: 0,
      maintenancePctOfValue: 0,
      sellingCostPct: 0,
      mortgage: null,
    },
    income: { salaries: { p1: over.salaryP1 ?? 0, p2: 0 }, contribution401k: 0, employerMatch401k: 0 },
    expenses: {
      livingMonthly: (over.baseline ?? 30000) / 12,
      charitableMonthly: 0,
      investingMonthly: 0,
    },
    health: {
      acaBenchmarkMonthly: 0,
      acaQuoteYear: 2026,
      partDPlanMonthly: 0,
      employerPremiumShareMonthly: 0,
    },
    settings: {
      horizonAge: over.horizonAge ?? 59,
      successTarget: 0.85,
      mcPathsInteractive: 1000,
      mcPathsFinal: 10000,
      seed: 1,
      spendingPolicy: { type: 'fixed_real' },
      withdrawalPolicy: {
        order: ['cash', 'taxable', 'pretax', 'roth'],
        pretaxPreference: 'ira_first',
      },
    },
  };
}

function simInput(profile: Profile, scenario: Scenario, over?: Partial<SimulationInput>): SimulationInput {
  return {
    profile,
    assumptions: assumptions(),
    scenario,
    mode: 'deterministic',
    paths: 1,
    seed: 42,
    ...over,
  };
}

/**
 * Zero-tax drawdown recurrence for the 600k/5yr profile used by the swr_curve
 * and max_spend tests (horizonAge 59 -> years 2026..2030):
 *
 *   B_{y+1} = B_y * 1.030125 - L * 1.025^y
 *
 * (interest is distributed income; withdrawal = spending - interest). Taxes
 * are exactly 0 throughout: max AGI = first-year interest
 * 600,000 x 0.030125 = 18,075 < the 32,200 federal MFJ standard deduction,
 * and VA taxable = 18,075 - 17,500 std deduction - 2 x 930 exemptions < 0.
 *
 * Solvency through 2030 requires B_5 >= 0:
 *   B_5 = 600,000 x 1.030125^5 - L x S,
 *   S   = sum_{y=0..4} 1.025^y x 1.030125^(4-y) = 5.5745317...
 *   => L* = 600,000 x 1.159977688 / 5.5745317 = 124,851.13
 *
 * So every level <= 124,851 passes (success 1) and every level above fails
 * (success 0) in deterministic mode.
 */
const SPEND_THRESHOLD = (600000 * 1.030125 ** 5) /
  (1.030125 ** 4 +
    1.025 * 1.030125 ** 3 +
    1.025 ** 2 * 1.030125 ** 2 +
    1.025 ** 3 * 1.030125 +
    1.025 ** 4); // = 124,851.134...

describe('swr_curve (SPEC §9.6)', () => {
  it('success is monotonically non-increasing in spending and answer = max passing level', () => {
    // Levels 110k..135k step 5k against L* = 124,851.13 (see comment above):
    // 110,000 / 115,000 / 120,000 pass; 125,000 / 130,000 / 135,000 fail.
    // Answer = 120,000 (max level with success >= 0.85).
    const result = runSolver(
      simInput(slimProfile({ savings: 600000, horizonAge: 59 }), {
        name: 'swr',
        events: [],
        solver: { type: 'swr_curve', spendFrom: 110000, spendTo: 135000, step: 5000 },
      }),
    );
    const out = result.solverOutput;
    expect(out).toBeDefined();
    expect(out!.spec).toEqual({ type: 'swr_curve', spendFrom: 110000, spendTo: 135000, step: 5000 });

    const points = out!.points;
    expect(points.map((p) => p.x)).toEqual([110000, 115000, 120000, 125000, 130000, 135000]);
    expect(points.map((p) => p.label)).toEqual([
      '$110,000/yr',
      '$115,000/yr',
      '$120,000/yr',
      '$125,000/yr',
      '$130,000/yr',
      '$135,000/yr',
    ]);
    // Hand-computed pass/fail pattern around L* = 124,851.
    expect(points.map((p) => p.success)).toEqual([1, 1, 1, 0, 0, 0]);
    // Monotone non-increasing success as spending rises.
    for (let i = 1; i < points.length; i++) {
      expect(points[i].success).toBeLessThanOrEqual(points[i - 1].success);
    }
    expect(out!.answer).toBe(120000);
    expect(out!.best?.x).toBe(120000);
    expect(out!.answerLabel).toContain('$120,000/yr');
    expect(out!.answerLabel).toContain('85%');
    // Deterministic single-path run: no inner-path cap note.
    expect(out!.answerLabel).not.toContain('capped');
    // The base run supplies the reference path (5 years 2026..2030).
    expect(result.referencePath).toHaveLength(5);
    expect(result.referencePath[0].year).toBe(2026);
  });
});

describe('the spend sweep moves BOTH sides of the working/retired pair', () => {
  /*
   * The bug this pins, which stayed latent for as long as no profile had a
   * separate retired figure.
   *
   * scenarioWithSpend used to write only `livingMonthly`. That was correct
   * while the retired side was always absent — absent inherits the working
   * figure, so every year moved with the sweep. An itemised budget ends that:
   * the moment one row names a number in the "if I stop working" column the
   * derivation produces a retired total, and a sweep that leaves it pinned
   * changes spending ONLY for the years still earning. On the user's plan that
   * is 2 years swept against 33 untouched, so almost every probe passes and the
   * answer comes back as the top of the bracket — a fabricated number rather
   * than merely an inaccurate one.
   */
  function maxSpendFor(retiredMonthly?: number): number {
    const profile = slimProfile({ savings: 600_000, baseline: 60_000, horizonAge: 59 });
    profile.expenses.livingMonthly = 5_000;
    if (retiredMonthly !== undefined) profile.expenses.livingMonthlyRetired = retiredMonthly;
    const out = runSolver(
      simInput(
        profile,
        {
          name: 'ms',
          events: [{ type: 'retire', person: 'p1', date: '2027-01' }],
          solver: { type: 'max_spend' },
        },
        { mode: 'deterministic' },
      ),
    ).solverOutput;
    expect(out?.answer).toBeDefined();
    return out?.answer as number;
  }

  it('does not let a pinned retired figure run the answer up to the bracket', () => {
    // Spending half as much once retired genuinely supports a higher working
    // level, so this must exceed the flat-spending answer...
    const flat = maxSpendFor(undefined);
    const cheaperInRetirement = maxSpendFor(2_500);
    expect(cheaperInRetirement).toBeGreaterThan(flat);

    // ...and it must be a real crossing rather than the top of the bracket.
    // With the retired side pinned, four of the five modelled years cost a flat
    // $2,500/mo whatever the probe asks, so no level in range ever fails and the
    // bisection walks all the way up: measured, it returns exactly MAX_SPEND_HI
    // ($400,000) against $249,336 once both sides move. That is the signature of
    // this bug — not a number that is somewhat too high, but the edge of the
    // search space reported as an answer.
    expect(cheaperInRetirement).toBeLessThan(MAX_SPEND_HI);
  });
});

describe('max_spend bisection (SPEC §9.1 helper)', () => {
  const scenario: Scenario = { name: 'ms', events: [], solver: { type: 'max_spend' } };

  it('converges on the hand-computed probe grid; answer passes, answer + $5k fails', () => {
    // Bisection on [20,000, 400,000] against L* = 124,851.13:
    //   20,000 pass | 400,000 fail
    //   210,000     F -> [20,000, 210,000]
    //   115,000     P -> [115,000, 210,000]
    //   162,500     F -> [115,000, 162,500]
    //   138,750     F -> [115,000, 138,750]
    //   126,875     F -> [115,000, 126,875]
    //   120,937.5   P -> [120,937.5, 126,875]
    //   123,906.25  P -> [123,906.25, 126,875]
    //   125,390.625 F -> [123,906.25, 125,390.625]
    //   124,648.4375   P -> [124,648.4375, 125,390.625]
    //   125,019.53125  F -> [124,648.4375, 125,019.53125]
    //   interval = 371.09375 < $500 -> stop (10 midpoints, within the 12 cap)
    // Answer = highest passing probe = 124,648.4375.
    const input = simInput(slimProfile({ savings: 600000, horizonAge: 59 }), scenario);
    const result = runSolver(input);
    const out = result.solverOutput!;

    expect(out.answer).toBeCloseTo(124648.4375, 6);
    // Converged within the $500 interval of the true threshold.
    expect(Math.abs(out.answer! - SPEND_THRESHOLD)).toBeLessThan(500);

    // 12 probes (2 endpoints + 10 midpoints), sorted ascending by spending.
    expect(out.points).toHaveLength(12);
    const xs = out.points.map((p) => p.x);
    expect(xs).toEqual([...xs].sort((a, b) => a - b));
    expect(xs[0]).toBe(MAX_SPEND_LO);
    expect(xs[xs.length - 1]).toBe(MAX_SPEND_HI);
    expect(xs).toContain(124648.4375);
    // Best points at the answer probe.
    expect(out.best?.x).toBeCloseTo(124648.4375, 6);
    expect(out.best?.success).toBe(1);

    // The answer's success meets the target while answer + $5,000 fails:
    // 124,648 < L* = 124,851 < 129,648.
    const passProfile = slimProfile({ savings: 600000, horizonAge: 59, baseline: out.answer! });
    const failProfile = slimProfile({
      savings: 600000,
      horizonAge: 59,
      baseline: out.answer! + 5000,
    });
    const plain: Scenario = { name: 'check', events: [] };
    expect(runSimulation(simInput(passProfile, plain)).success).toBeGreaterThanOrEqual(0.85);
    expect(runSimulation(simInput(failProfile, plain)).success).toBeLessThan(0.85);
  });

  it('spec.targetSuccess overrides the profile default', () => {
    // targetSuccess 2 is unreachable (success <= 1): even the $20,000 floor
    // "fails", so the bisection stops after one probe with no answer.
    const result = runSolver(
      simInput(slimProfile({ savings: 600000, horizonAge: 59 }), {
        name: 'ms-unreachable',
        events: [],
        solver: { type: 'max_spend', targetSuccess: 2 },
      }),
    );
    const out = result.solverOutput!;
    expect(out.answer).toBeUndefined();
    expect(out.points).toHaveLength(1);
    expect(out.points[0].x).toBe(MAX_SPEND_LO);
    expect(out.answerLabel).toContain('No spending level');
  });
});

describe('retire_year_sweep (SPEC §9.1)', () => {
  it('one point per year, success non-decreasing in retirement year, maxSpend per year', () => {
    // Salary 200,000 (p1), savings 550,000, baseline 50,000, horizon 2038
    // (age 67, 13 years).
    //
    // NOTE 20 changed the mechanism this test rests on. An extra work year no
    // longer ADDS the leftover paycheck to assets — while anyone earns, cash
    // beyond taxes, expenses and the explicit investing stream (0 here) is
    // consumed, not swept — so the salary's only job is to keep the household
    // off its savings. Retiring later therefore helps purely by POSTPONING
    // the drawdown: savings has to cover fewer years. 50,000 real x the years
    // from retirement to 2038 is the whole story, so 550,000 lands the flip
    // between 2027 (~11.5 years to fund) and 2028 (~10.5): calibrated against
    // the engine, 2026 and 2027 fail, 2028+ pass — the same shape this test
    // has always asserted, for a different (and now honest) reason.
    const profile = slimProfile({
      savings: 550000,
      baseline: 50000,
      horizonAge: 67,
      salaryP1: 200000,
    });
    const progress: number[] = [];
    const result = runSolver(
      simInput(profile, {
        name: 'sweep',
        events: [],
        solver: { type: 'retire_year_sweep', from: 2026, to: 2029, alsoMaxSpend: true },
      }),
      (frac) => progress.push(frac),
    );
    const out = result.solverOutput!;

    // One point per year with String(year) labels.
    expect(out.points.map((p) => p.x)).toEqual([2026, 2027, 2028, 2029]);
    expect(out.points.map((p) => p.label)).toEqual(['2026', '2027', '2028', '2029']);
    // Deterministic world: retiring later can never reduce success.
    for (let i = 1; i < out.points.length; i++) {
      expect(out.points[i].success).toBeGreaterThanOrEqual(out.points[i - 1].success);
    }
    expect(out.points.map((p) => p.success)).toEqual([0, 0, 1, 1]);
    // Earliest passing year is the headline answer.
    expect(out.answer).toBe(2028);
    expect(out.best?.x).toBe(2028);
    expect(out.answerLabel).toContain('2028');

    // alsoMaxSpend: a bisection result for every year, non-decreasing with
    // later retirement (each work year postpones far more than the $500
    // bracket's worth of drawdown).
    for (const p of out.points) {
      expect(p.maxSpend).toBeDefined();
      expect(p.maxSpend!).toBeGreaterThanOrEqual(MAX_SPEND_LO);
      expect(p.maxSpend!).toBeLessThanOrEqual(MAX_SPEND_HI);
    }
    for (let i = 1; i < out.points.length; i++) {
      expect(out.points[i].maxSpend!).toBeGreaterThanOrEqual(out.points[i - 1].maxSpend!);
    }
    // 2027 fails at the 50,000 baseline -> its max sustainable spend is below
    // 50,000; 2028 passes -> its max spend is at least 50,000 - $500 bracket.
    expect(out.points[1].maxSpend!).toBeLessThan(50000);
    expect(out.points[2].maxSpend!).toBeGreaterThan(49500);
    expect(out.points[2].maxSpend!).toBeGreaterThan(out.points[1].maxSpend!);

    // Progress: monotone non-decreasing, ends at exactly 1 (base run done).
    for (let i = 1; i < progress.length; i++) {
      expect(progress[i]).toBeGreaterThanOrEqual(progress[i - 1]);
    }
    expect(progress[progress.length - 1]).toBe(1);
  });
});

describe('retire_year_sweep picks up the PIA-by-retirement-date effect (note 3)', () => {
  it('later retirement years leave strictly more terminal wealth via a larger benefit', () => {
    // ISOLATION: salary 0, so a retire event changes NOTHING about wages,
    // contributions, or health coverage — the only thing that moves across
    // the swept years is the effective PIA (2,400/mo stopping now ->
    // 3,000/mo working to 62 in 2033, linear in between). Every year is
    // solvent (2,000,000 of savings against 40,000 of spending), so success
    // ties at 1 and the ordering shows up in terminal wealth.
    const profile = slimProfile({
      savings: 2000000,
      baseline: 40000,
      horizonAge: 68, // 2026..2039, so 2039 is a full benefit year
      pia: 3000,
      piaStoppingNow: 2400,
    });
    const result = runSolver(
      simInput(profile, {
        name: 'pia-sweep',
        events: [
          { type: 'claim_social_security', person: 'p1', date: '2038-06' },
          { type: 'claim_social_security', person: 'p2', date: '2038-06' },
        ],
        solver: { type: 'retire_year_sweep', from: 2026, to: 2033 },
      }),
    );
    const points = result.solverOutput!.points;
    expect(points.map((p) => p.x)).toEqual([2026, 2027, 2028, 2029, 2030, 2031, 2032, 2033]);
    for (const p of points) expect(p.success).toBe(1);
    for (let i = 1; i < points.length; i++) {
      expect(points[i].medianTerminalReal!).toBeGreaterThan(points[i - 1].medianTerminalReal!);
    }
  });
});

describe('ss_claim_sweep (SPEC §9.5)', () => {
  it('stepMonths=12 gives 9 points 62..70 whose dates map from person 1 birth 1971-06', () => {
    // PIA 2,000 (p1 worker; p2 purely spousal, same claim date), savings
    // 2,000,000, baseline 40,000, horizon 2046 (age 75). Success is 1 at
    // every claim age (2M >> needs), so best is decided by the benefit
    // tiebreak.
    //
    // expectedLifetimeBenefits is the REAL (start-year dollar) undiscounted
    // sum: benefit months x household monthly benefit at claim, because
    // income.socialSecurity = monthlyReal x months x CPI index and the sum
    // divides the index back out. Hand computations (horizon end 2046):
    //
    // 62y0m -> claim 2033-06 (born 1971-06 + 744 months), 60 months early:
    //   worker factor = 1 - (36 x 5/9% + 24 x 5/12%) = 0.70 -> 1,400/mo
    //   spousal factor = 0.5 x (1 - (36 x 25/36% + 24 x 5/12%)) = 0.325 -> 650/mo
    //   months = 7 (Jun-Dec 2033) + 13 yr x 12 = 163
    //   total = 2,050 x 163 = 334,150
    // 67y0m -> claim 2038-06 at FRA: 2,000 + 1,000 = 3,000/mo
    //   months = 7 + 8 x 12 = 103 -> total = 309,000
    // 70y0m -> claim 2041-06: worker 1.24 x 2,000 = 2,480 (+8%/yr delayed
    //   credits); spousal stays 1,000 (no delayed credits on spousal)
    //   months = 7 + 5 x 12 = 67 -> total = 3,480 x 67 = 233,160
    //
    // The 7-month proration in the claim year proves the date mapping
    // (62y0m -> 2033-06): any other start month would change the totals.
    const profile = slimProfile({ savings: 2000000, baseline: 40000, horizonAge: 75, pia: 2000 });
    const scenario: Scenario = {
      name: 'ss-sweep',
      events: [
        { type: 'retire', person: 'p1', date: '2026-07' },
        { type: 'retire', person: 'p2', date: '2026-07' },
      ],
      solver: { type: 'ss_claim_sweep', stepMonths: 12 },
    };
    const result = runSolver(simInput(profile, scenario));
    const out = result.solverOutput!;

    expect(out.points).toHaveLength(9);
    expect(out.points.map((p) => p.x)).toEqual([744, 756, 768, 780, 792, 804, 816, 828, 840]);
    expect(out.points.map((p) => p.label)).toEqual([
      '62y0m',
      '63y0m',
      '64y0m',
      '65y0m',
      '66y0m',
      '67y0m',
      '68y0m',
      '69y0m',
      '70y0m',
    ]);
    for (const p of out.points) expect(p.success).toBe(1);

    const byX = new Map(out.points.map((p) => [p.x, p]));
    expect(byX.get(744)!.expectedLifetimeBenefits).toBeCloseTo(334150, 4);
    expect(byX.get(804)!.expectedLifetimeBenefits).toBeCloseTo(309000, 4);
    expect(byX.get(840)!.expectedLifetimeBenefits).toBeCloseTo(233160, 4);
    // 63y0m sanity: 48 months early -> worker 0.75 x 2,000 = 1,500; spousal
    // 0.5 x (1 - (36 x 25/36% + 12 x 5/12%)) = 0.35 -> 700; months =
    // 7 + 12 x 12 = 151 -> 2,200 x 151 = 332,200.
    expect(byX.get(756)!.expectedLifetimeBenefits).toBeCloseTo(332200, 4);

    // All successes tie at 1 -> the tiebreak picks the highest benefits,
    // which at this short horizon (age 75) is the earliest claim.
    expect(out.best?.x).toBe(744);
    expect(out.answer).toBe(744);
    expect(out.answerLabel).toContain('62y0m');
  });

  it('default stepMonths=1 sweeps every month 62y0m..70y0m (97 points)', () => {
    // 840 - 744 = 96 monthly steps -> 97 points inclusive.
    const profile = slimProfile({ savings: 2000000, baseline: 40000, horizonAge: 75, pia: 2000 });
    const result = runSolver(
      simInput(profile, {
        name: 'ss-monthly',
        events: [
          { type: 'retire', person: 'p1', date: '2026-07' },
          { type: 'retire', person: 'p2', date: '2026-07' },
        ],
        solver: { type: 'ss_claim_sweep' },
      }),
    );
    const out = result.solverOutput!;
    expect(out.points).toHaveLength(97);
    expect(out.points[0].label).toBe('62y0m');
    expect(out.points[1].label).toBe('62y1m');
    expect(out.points[96].label).toBe('70y0m');
    // 62y1m -> claim 2033-07: 59 months early -> worker factor
    // 1 - (36 x 5/9% + 23 x 5/12%) = 0.7041666...; spousal factor
    // 0.5 x (1 - (36 x 25/36% + 23 x 5/12%)) = 0.3270833...
    // monthly = 2,000 x (0.7041666 + 0.3270833) = 2,062.50
    // months = 6 (Jul-Dec 2033) + 13 x 12 = 162 -> total = 334,125.
    expect(out.points[1].expectedLifetimeBenefits).toBeCloseTo(2062.5 * 162, 4);
  });
});

describe('earliest_retirement', () => {
  it('ascending probe stops at the first year meeting the target', () => {
    // Same calibrated profile as the retire sweep: 2026-2027 fail, 2028
    // passes -> probing stops at 2028 (2029..2033 never run).
    const profile = slimProfile({
      savings: 550000,
      baseline: 50000,
      horizonAge: 67,
      salaryP1: 200000,
    });
    const result = runSolver(
      simInput(profile, {
        name: 'earliest',
        events: [],
        solver: { type: 'earliest_retirement', from: 2026, to: 2033 },
      }),
    );
    const out = result.solverOutput!;
    expect(out.points.map((p) => p.x)).toEqual([2026, 2027, 2028]);
    expect(out.points.map((p) => p.success)).toEqual([0, 0, 1]);
    expect(out.answer).toBe(2028);
    expect(out.best?.x).toBe(2028);
    expect(out.answerLabel).toContain('2028');
  });

  it('no passing year: every year in range is probed and answer is undefined', () => {
    // targetSuccess 2 is unreachable (success <= 1), so all 4 years probe
    // and fail.
    const profile = slimProfile({ savings: 300000, baseline: 50000, horizonAge: 67, salaryP1: 200000 });
    const result = runSolver(
      simInput(profile, {
        name: 'never',
        events: [],
        solver: { type: 'earliest_retirement', targetSuccess: 2, from: 2026, to: 2029 },
      }),
    );
    const out = result.solverOutput!;
    expect(out.points).toHaveLength(4);
    expect(out.answer).toBeUndefined();
    expect(out.answerLabel).toContain('No retirement year');
  });
});

describe('execute() dispatch (engine/index)', () => {
  it('runs a plain simulation when scenario.solver is absent', () => {
    const input = simInput(slimProfile({ savings: 600000, horizonAge: 59 }), {
      name: 'plain',
      events: [],
    });
    const viaExecute = execute(input);
    const direct = runSimulation(input);
    expect(viaExecute.solverOutput).toBeUndefined();
    expect(viaExecute.meta.runKey).toBe(direct.meta.runKey);
    expect(viaExecute.success).toBe(direct.success);
  });

  it('runs the solver when scenario.solver is present, and the runKey covers the spec', () => {
    const plainScenario: Scenario = { name: 's', events: [] };
    const solverScenario: Scenario = {
      name: 's',
      events: [],
      solver: { type: 'swr_curve', spendFrom: 120000, spendTo: 120000, step: 5000 },
    };
    const profile = slimProfile({ savings: 600000, horizonAge: 59 });
    const viaExecute = execute(simInput(profile, solverScenario));
    expect(viaExecute.solverOutput).toBeDefined();
    expect(viaExecute.solverOutput!.spec).toEqual(solverScenario.solver);
    expect(viaExecute.solverOutput!.points).toHaveLength(1);
    // 120,000 < L* = 124,851 -> the single level passes.
    expect(viaExecute.solverOutput!.points[0].success).toBe(1);

    // The solver spec is part of the scenario hash: same events, different
    // solver presence -> different runKey (run cache can never collide).
    const plain = runSimulation(simInput(profile, plainScenario));
    expect(viaExecute.meta.runKey).not.toBe(plain.meta.runKey);
    // The base-run metadata reflects the input mode/paths/seed unchanged.
    expect(viaExecute.meta.mode).toBe('deterministic');
    expect(viaExecute.meta.seed).toBe(42);
  });
});

describe('inner-path cap for sweeps', () => {
  it('caps sweep runs at 2,000 paths (noted in answerLabel); base run keeps full paths', () => {
    // Tiny horizon (2026..2028, 3 years) keeps 2,200-path Monte Carlo cheap.
    // input.paths = 2,200 > INNER_PATH_CAP = 2,000 -> the single sweep run
    // is capped and the label says so, while the base run's meta reports the
    // full 2,200 paths.
    const profile = slimProfile({ savings: 600000, baseline: 30000, horizonAge: 57 });
    const result = runSolver(
      simInput(
        profile,
        {
          name: 'mc-cap',
          events: [],
          solver: { type: 'swr_curve', spendFrom: 40000, spendTo: 40000, step: 5000 },
        },
        { mode: 'montecarlo', paths: 2200, seed: 7 },
      ),
    );
    expect(INNER_PATH_CAP).toBe(2000);
    expect(result.meta.paths).toBe(2200);
    expect(result.solverOutput!.points).toHaveLength(1);
    expect(result.solverOutput!.answerLabel).toContain('capped at 2,000 paths');
    // The sweep runs share the input seed, so the run is reproducible.
    const again = runSolver(
      simInput(
        profile,
        {
          name: 'mc-cap',
          events: [],
          solver: { type: 'swr_curve', spendFrom: 40000, spendTo: 40000, step: 5000 },
        },
        { mode: 'montecarlo', paths: 2200, seed: 7 },
      ),
    );
    expect(again.solverOutput!.points[0].success).toBe(result.solverOutput!.points[0].success);
    expect(again.meta.runKey).toBe(result.meta.runKey);
  });
});

// ---------------------------------------------------------------------------
// widow_score (the survivor's probability of success, by year of death)
// ---------------------------------------------------------------------------

describe('widow_score', () => {
  /**
   * THE QUESTION THIS EXISTS FOR, in solver form: "if I retire and then die, what
   * is HER score, and what does another year of work or another year of term
   * insurance do to it?"
   *
   * There is no survivor engine to test — a widow score is one ordinary
   * simulation per candidate year, each carrying a `death` event — so what
   * these tests pin is the SWEEP: that it probes the years it says it will,
   * that the answer is the first year clearing the household's own target,
   * that `best` is deliberately the WORST point, and that a death which costs
   * the household nothing scores exactly the household.
   *
   * Deterministic mode throughout, so success is 0 or 1 and the curve is a
   * step function — which is what makes the step's LOCATION assertable to the
   * year instead of to a percentage.
   */

  it('every point IS an ordinary run of the same plan with a death in it', () => {
    /*
     * THE ANCHOR. There is no parallel survivor engine, and this is what says
     * so mechanically: each sweep point must reproduce, to the last digit, a
     * plain runSimulation of the scenario `scenarioWithDeath` builds. If the
     * solver ever grew its own arithmetic — a different month, a different
     * default, a shortcut — the two would drift and nobody would notice until
     * it mattered.
     *
     * Deaths are placed in JULY, for the same reason the retirement sweep uses
     * it: a sweep over years needs one month, and mid-year splits the year's
     * salary, benefits and living costs down the middle instead of pretending
     * a death always falls in January (overstating the damage) or December
     * (hiding it for a year).
     */
    const profile = slimProfile({ savings: 600000, baseline: 30000, horizonAge: 65 });
    const plan: Scenario = {
      name: 'widow',
      events: [{ type: 'retire', person: 'p1', date: '2030-07' }],
    };
    const res = runSolver(
      simInput(profile, { ...plan, solver: { type: 'widow_score', from: 2027, to: 2031 } }),
    );
    const points = res.solverOutput!.points;
    expect(points.map((p) => p.x)).toEqual([2027, 2028, 2029, 2030, 2031]);
    for (const p of points) {
      const direct = runSimulation(simInput(profile, scenarioWithDeath(plan, 'p1', p.x)));
      expect(p.success).toBe(direct.success);
      expect(p.medianTerminalReal).toBe(direct.medianTerminalReal);
    }
    // And the helper really did put it in July, on the person named.
    const built = scenarioWithDeath(plan, 'p1', 2029);
    expect(built.events).toContainEqual({ type: 'death', person: 'p1', date: '2029-07' });
    // It replaces any death the scenario already carried rather than stacking
    // a second one (which prepareHousehold would reject outright).
    expect(
      scenarioWithDeath(built, 'p1', 2031).events.filter((e) => e.type === 'death'),
    ).toHaveLength(1);
  });

  it('even a household that owes NO tax at all starts owing it as a widow', () => {
    /*
     * The widow penalty turning up where a reader would least expect it, and
     * the reason this file's slim profile is the right place to show it.
     *
     * That profile pays exactly zero tax, every year, by construction: its
     * whole income is 600,000-ish of savings interest, about 18,075 a year,
     * which is under the 32,200 joint standard deduction and miles under
     * Virginia's 17,500 plus two 930 exemptions. Nothing else happens in it —
     * no salary, no Social Security, no insurance, no housing.
     *
     * Kill one spouse with `livingFraction: 1`, so not one dollar of spending
     * changes, and the SAME 18,075 of interest is now taxed: 16,100 of
     * standard deduction instead of 32,200, and 8,750 of Virginia's instead of
     * 17,500 with one exemption instead of two. A household that had no tax
     * bill at all acquires one, purely from the filing change.
     *
     * The 255 lump-sum death payment goes the other way and is swamped by it,
     * which is the honest summary of the whole feature in one line.
     *
     * The horizon stops in 2029 deliberately, for two reasons that have
     * nothing to do with the survivor: Virginia's elevated standard deduction
     * is legislated only through TY2029 and reverts to 6,000 after it (which
     * gives even the COUPLE a tax bill, wrecking the "no tax at all" premise),
     * and both spouses turn 65 in 2036, from which a survivor is one Medicare
     * enrollee instead of two — a real saving, and a different effect.
     */
    const profile = slimProfile({ savings: 600000, baseline: 30000, horizonAge: 58 });
    const base = runSimulation(simInput(profile, { name: 'base', events: [] }));
    expect(base.success).toBe(1);
    expect(base.referencePath.every((r) => r.taxes.totalTax === 0)).toBe(true);

    const widowed = runSimulation(
      simInput(profile, scenarioWithDeath({ name: 'w', events: [] }, 'p1', 2027, {
        livingFraction: 1,
      })),
    );
    const row = (y: number) => widowed.referencePath.find((r) => r.year === y)!;
    // 2027 is still a joint return, so it is still tax-free.
    expect(row(2027).taxes.totalTax).toBe(0);
    expect(row(2027).survivor?.ssLumpSum).toBe(255);
    // 2028 is her first single year: (16,100 x 1.025^2) of federal deduction
    // against the couple's (32,200 x 1.025^2), and a tax bill appears.
    expect(row(2028).taxes.federal.standardDeduction).toBeCloseTo(16_100 * 1.025 ** 2, 6);
    expect(row(2028).taxes.federal.total).toBeGreaterThan(0);
    expect(row(2028).taxes.state.total).toBeGreaterThan(0);
    expect(row(2029).taxes.totalTax).toBeGreaterThan(0);
    // Spending never moved, so every dollar of the gap is tax — and it beats
    // the 255 several times over.
    expect(row(2028).expenses.total).toBeCloseTo(
      base.referencePath.find((r) => r.year === 2028)!.expenses.total,
      6,
    );
    /*
     * And she ends poorer, NET of the 255 she was paid: two single years cost
     * about 190 real dollars of terminal balance here, which is roughly 450 of
     * tax less the lump sum. Two hundred dollars is nothing — that is the
     * point. This household is rich enough that the penalty costs it money
     * rather than the plan, and telling those two cases apart is the entire
     * job of a widow score.
     */
    expect(widowed.medianTerminalReal).toBeLessThan(base.medianTerminalReal);
    expect(base.medianTerminalReal - widowed.medianTerminalReal).toBeGreaterThan(100);
    // Still solvent, though: this household has enough that the penalty costs
    // it money rather than the plan. That is the distinction a widow score is
    // for.
    expect(widowed.success).toBe(1);
  });

  it('probes exactly the years asked for, and honours step', () => {
    const profile = slimProfile({ savings: 600000, baseline: 30000, horizonAge: 65 });
    const res = runSolver(
      simInput(profile, {
        name: 'widow',
        events: [],
        solver: { type: 'widow_score', from: 2028, to: 2036, step: 3 },
      }),
    );
    expect(res.solverOutput!.points.map((p) => p.x)).toEqual([2028, 2031, 2034]);
    expect(res.solverOutput!.points.map((p) => p.label)).toEqual(['2028', '2031', '2034']);
  });

  it('term life steers it: covered years pass, the year after the term lapses fails', () => {
    /*
     * THE DELIVERABLE, reduced to its smallest honest form. The household
     * cannot fund its own horizon — 30,000 a year of real spending against
     * 240,000 of savings over sixteen years — so the base run fails and so
     * does every uninsured widow year. Give it a million dollars of term
     * insurance running to the end of 2032 and every death the policy covers
     * pays for the rest of her life; the first death it does not cover is back
     * to failing.
     *
     * The solver places each death in JULY, so the last covered probe is 2032
     * and 2033 is the cliff. `livingFraction: 1` keeps the survivor's spending
     * unchanged, so the ONLY thing moving across the step is the insurance —
     * which is exactly the question "what is the term buying?".
     */
    const profile = slimProfile({ savings: 240000, baseline: 30000, horizonAge: 70 });
    profile.expenses.lifeInsuranceDeathBenefit = 1_000_000;
    profile.expenses.lifeInsuranceTermEnd = '2032-12';

    const base = runSimulation(simInput(profile, { name: 'base', events: [] }));
    expect(base.success).toBe(0); // the household cannot fund itself

    const res = runSolver(
      simInput(profile, {
        name: 'widow',
        events: [],
        solver: { type: 'widow_score', from: 2028, to: 2035, livingFraction: 1 },
      }),
    );
    const byYear = new Map(res.solverOutput!.points.map((p) => [p.x, p.success]));
    for (const y of [2028, 2029, 2030, 2031, 2032]) expect(byYear.get(y)).toBe(1);
    for (const y of [2033, 2034, 2035]) expect(byYear.get(y)).toBe(0);
    // The answer is the first year that clears the bar; the highlighted point
    // is deliberately the WORST one, because the answer a widow score is asked
    // for is where the plan is weakest.
    expect(res.solverOutput!.answer).toBe(2028);
    expect(res.solverOutput!.best!.success).toBe(0);
    expect(res.solverOutput!.answerLabel).toContain('2028');
    expect(res.solverOutput!.answerLabel).toMatch(/weakest year/);
  });

  it('with no year clearing the bar, it says so and still names the weakest', () => {
    const profile = slimProfile({ savings: 240000, baseline: 30000, horizonAge: 70 });
    const res = runSolver(
      simInput(profile, {
        name: 'widow',
        events: [],
        solver: { type: 'widow_score', from: 2028, to: 2030 },
      }),
    );
    expect(res.solverOutput!.answer).toBeUndefined();
    expect(res.solverOutput!.answerLabel).toMatch(/No death year in 2028-2030/);
  });

  it('defaults to the earner, because his death is the one that takes the salary', () => {
    const profile = slimProfile({ savings: 600000, baseline: 30000, horizonAge: 65, salaryP1: 120000 });
    // p1 is the only person with a salary, so the sweep should kill p1 without
    // being told to — and naming p2 explicitly must produce a different curve
    // (p2 earns nothing, so her death costs the household nothing but her
    // share of the living costs).
    const sweep = (spec: Record<string, unknown>) =>
      runSolver(
        simInput(profile, {
          name: 'widow',
          events: [{ type: 'retire', person: 'p1', date: '2031-07' }],
          solver: { type: 'widow_score', from: 2027, to: 2029, ...spec } as any,
        }),
      ).solverOutput!.points.map((p) => p.medianTerminalReal);
    expect(sweep({})).toEqual(sweep({ person: 'p1' }));
    expect(sweep({})).not.toEqual(sweep({ person: 'p2' }));
  });

  it('rejects a stranger, a backwards range, and a household with nobody to survive', () => {
    const profile = slimProfile({ savings: 600000, horizonAge: 65 });
    const solve = (spec: Record<string, unknown>, p: Profile = profile) =>
      runSolver(simInput(p, { name: 'w', events: [], solver: { type: 'widow_score', ...spec } as any }));
    expect(() => solve({ person: 'nobody' })).toThrow(/unknown person/);
    expect(() => solve({ from: 2040, to: 2030 })).toThrow(/to \(2030\) < from \(2040\)/);
    expect(() => solve({ step: 0 })).toThrow(/positive integer/);
    const lone = slimProfile({ savings: 600000, horizonAge: 65 });
    lone.people = [lone.people[0]];
    lone.income.salaries = { p1: 0 };
    expect(() => solve({}, lone)).toThrow(/no survivor to score/);
  });
});

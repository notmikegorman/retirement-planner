/**
 * bondComposition end-to-end: the corporate-share dial is INERT at its default
 * and CONNECTED when named.
 *
 * The inert half is the load-bearing one. corporateFraction ABSENT and
 * corporateFraction 0 must produce bit-identical runs — reference path AND
 * Monte Carlo fan — because "absent = 0 = pure Treasury = what the engine
 * always did" is the contract that lets every pre-existing golden digest
 * (mfjUnchanged, preExpenseLinesUnchanged, housingPlan, guardrails §7) stand
 * un-re-pinned while the feature ships. These two tests state that contract
 * directly, on a fixture whose bond sleeve is large enough (40% of $1M) that
 * any accidental repricing would move dollars, not decimals.
 *
 * The connected half guards the plumbing: a share set via
 * scenario.assumption_overrides.market must reach the samplers through the
 * deepMerge exactly as one set in assumptions.market itself — and must move
 * the numbers, or the Workbench field is a placebo.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { runSimulation } from '../../src/engine/simulate';
import { loadHistoricalCsv } from '../../src/engine/returns';
import type {
  AcaData,
  Assumptions,
  FederalTaxData,
  MarketAssumptions,
  MedicareData,
  Profile,
  RmdTableData,
  RunResult,
  Scenario,
  SimulationInput,
  SocialSecurityData,
  StateTaxData,
} from '../../src/shared/types';
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
  readFileSync(
    new URL('../../data-defaults/assumptions/historical-returns.csv', import.meta.url),
    'utf8',
  ),
);

/** Base assumptions; corporateFraction is set ONLY where a test names it. */
function assumptions(f?: number): Assumptions {
  const market = {
    ...(marketJson as unknown as MarketAssumptions),
    ...(f !== undefined ? { bondComposition: { corporateFraction: f } } : {}),
  };
  return {
    market,
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
 * Retired household living off a 60/40 IRA: the 40% bond sleeve is what makes
 * this fixture SENSITIVE to the dial — a savings-only household would pass the
 * identity tests vacuously.
 */
function household(): Profile {
  return {
    people: [
      {
        id: 'p1',
        name: 'P1',
        birthYear: 1971,
        birthMonth: 6,
        piaMonthlyAtFraIfWorkingTo62: 0,
        piaMonthlyAtFraIfStoppingNow: 0,
        hasOwnBenefit: false,
      },
      {
        id: 'p2',
        name: 'P2',
        birthYear: 1971,
        birthMonth: 6,
        piaMonthlyAtFraIfWorkingTo62: 0,
        piaMonthlyAtFraIfStoppingNow: 0,
        hasOwnBenefit: false,
      },
    ],
    filing: { status: 'mfj', state: 'va' },
    accounts: [
      {
        id: 'ira',
        name: 'IRA',
        type: 'traditional_ira',
        owner: 'p1',
        balance: 1000000,
        allocation: { stocks: 0.6, bonds: 0.4, bills: 0 },
      },
      {
        id: 'savings',
        name: 'savings',
        type: 'savings',
        owner: 'joint',
        balance: 50000,
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
    income: { salaries: { p1: 0, p2: 0 }, contribution401k: 0, employerMatch401k: 0 },
    expenses: { livingMonthly: 5000, charitableMonthly: 0, investingMonthly: 0 },
    health: {
      acaBenchmarkMonthly: 0,
      acaQuoteYear: 2026,
      partDPlanMonthly: 0,
      employerPremiumShareMonthly: 0,
    },
    settings: {
      horizonAge: 70, // 2041: 16 years — enough for compounding to expose any repricing
      successTarget: 0.85,
      mcPathsInteractive: 1000,
      mcPathsFinal: 10000,
      seed: 20260812,
      spendingPolicy: { type: 'fixed_real' },
      withdrawalPolicy: {
        order: ['cash', 'taxable', 'pretax', 'roth'],
        pretaxPreference: 'ira_first',
      },
    },
  };
}

function input(
  a: Assumptions,
  scenario: Scenario,
  over?: Partial<SimulationInput>,
): SimulationInput {
  return {
    profile: household(),
    assumptions: a,
    scenario,
    mode: 'montecarlo',
    paths: 200,
    seed: 20260812,
    ...over,
  };
}

const PLAIN: Scenario = { name: 'bond-blend-probe', events: [] };

/** Everything arithmetic (the mfjUnchanged convention: meta/elapsedMs excluded). */
function digest(res: RunResult): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        success: res.success,
        fan: res.fan,
        medianTerminalReal: res.medianTerminalReal,
        worstDecileShortfallYears: res.worstDecileShortfallYears,
        referencePath: res.referencePath,
      }),
    )
    .digest('hex');
}

describe('corporateFraction absent vs 0: bit-identical runs', () => {
  it('Monte Carlo (fan + reference companion) digests are equal', () => {
    const base = digest(runSimulation(input(assumptions(), PLAIN)));
    expect(digest(runSimulation(input(assumptions(0), PLAIN)))).toBe(base);
    // The same zero arriving via the scenario override (the Workbench path).
    const overridden: Scenario = {
      ...PLAIN,
      assumption_overrides: { market: { bondComposition: { corporateFraction: 0 } } },
    };
    expect(digest(runSimulation(input(assumptions(), overridden)))).toBe(base);
  });

  it('deterministic reference path digests are equal', () => {
    const det = { mode: 'deterministic' as const, paths: 1 };
    const base = digest(runSimulation(input(assumptions(), PLAIN, det)));
    expect(digest(runSimulation(input(assumptions(0), PLAIN, det)))).toBe(base);
  });
});

describe('corporateFraction connected end-to-end', () => {
  it('f=0.3 moves the Monte Carlo digest, and the override path equals the direct path', () => {
    const base = digest(runSimulation(input(assumptions(), PLAIN)));
    const direct = digest(runSimulation(input(assumptions(0.3), PLAIN)));
    // A dial that changes nothing is a placebo — the whole feature is fake.
    expect(direct).not.toBe(base);
    // Same share via assumption_overrides: deepMerge must deliver the
    // identical market to the samplers, or the Workbench and the data file
    // would quietly disagree about what "30%" means.
    const overridden: Scenario = {
      ...PLAIN,
      assumption_overrides: { market: { bondComposition: { corporateFraction: 0.3 } } },
    };
    expect(digest(runSimulation(input(assumptions(), overridden)))).toBe(direct);
  });

  it('f=0.3 moves the deterministic reference path too', () => {
    const det = { mode: 'deterministic' as const, paths: 1 };
    const base = digest(runSimulation(input(assumptions(), PLAIN, det)));
    expect(digest(runSimulation(input(assumptions(0.3), PLAIN, det)))).not.toBe(base);
  });
});

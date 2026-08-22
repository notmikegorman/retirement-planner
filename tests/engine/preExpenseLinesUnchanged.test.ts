/**
 * THE HEADLINE PROPERTY OF THE EXPENSE-LINES WORK: a profile that carries no
 * `expenses.lines`, no `expenses.lifeInsurancePolicies` and no 'guardrails'
 * spending policy is bit-for-bit the engine that existed before any of them.
 *
 * The three features all landed inside code every run executes. The per-line
 * survivor fraction rewrote the multiplier `livingFactorByYear`, which every
 * year of every run multiplies by. Multi-policy life insurance replaced the
 * single-premium month count outright — the legacy fields are now ONE synthetic
 * policy through the same loop, which is the kind of unification that is either
 * exactly equal or quietly off by a month. Guardrails added a third arm to the
 * spending-policy switch that `fixed_real` and `fixed_percent` fall through.
 *
 * So the pins below were produced by running these exact fixtures against the
 * tree as it stood BEFORE those three changes (ENGINE_VERSION 1.10.0), and
 * pasted in unchanged. They are genuine before/after hashes rather than
 * snapshots of whatever the code now does, which is the only kind worth having.
 *
 * WHAT IS HASHED: everything arithmetic — success, the fan, the median
 * terminal, the shortfall histogram, the charitable legacy, the break-glass
 * figure, and the whole reference path INCLUDING its tax traces. NOT `meta` or
 * `elapsedMs`: `elapsedMs` is a wall clock and `meta` carries ENGINE_VERSION
 * and the run key, both of which are SUPPOSED to have moved (that is the
 * cache-invalidation rule; tests/shared/engineVersion.test.ts guards it).
 *
 * tests/engine/mfjUnchanged.test.ts pins the same property for a plain MFJ run
 * against an even older commit and is not superseded by this file: its fixtures
 * carry no death at all, so they never reach the survivor multiplier or the
 * covered-at-death test, and none of them uses `fixed_percent`.
 *
 * THE FIXTURES, chosen for the code the three features actually touched:
 *  A. a death inside a legacy term — the survivor living fraction AND the
 *     policy that pays
 *  B. the same death after the term lapsed — the policy that does not pay
 *  C. a legacy policy with NO term dates and a death while a salary is still
 *     coming in — the "coverage ends with the paycheck" rule, which is now the
 *     synthetic policy's `cancelAtRetirement`
 *  D. `fixed_percent`, which the guardrails arm must not have disturbed
 *  E. a death carrying an explicit `livingFraction` — the precedence rule's
 *     top branch, which per-line amounts must never outrank
 *
 * IF ONE OF THESE FAILS, a profile written before this work changed answer.
 * Find out what before touching the pin.
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
  ScenarioEvent,
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
 * A REPRESENTATIVE MFJ HOUSEHOLD: two spouses, one salary, a pre-tax IRA, a
 * 401(k), a Roth on the non-earner, a brokerage, savings and a house. A run
 * over it visits ACA, Medicare, Social Security, RMDs and the housing module,
 * so a pin taken here is not pinning an empty path.
 *
 * DELIBERATELY NOT read from a live data folder: a golden hash has to be
 * reproducible from the repo alone, on any machine, forever.
 */
function household(over?: Partial<Profile['expenses']>): Profile {
  return {
    people: [
      {
        id: 'p1',
        name: 'P1',
        birthYear: 1971,
        birthMonth: 6,
        piaMonthlyAtFraIfWorkingTo62: 4200,
        piaMonthlyAtFraIfStoppingNow: 3900,
        hasOwnBenefit: true,
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
        id: 'ira1',
        name: 'Traditional IRA',
        type: 'traditional_ira',
        owner: 'p1',
        balance: 1985000,
        allocation: { stocks: 0.7, bonds: 0.3, bills: 0 },
      },
      {
        id: 'k401',
        name: '401(k)',
        type: '401k',
        owner: 'p1',
        balance: 162400,
        currentEmployer: true,
        allocation: { stocks: 0.7, bonds: 0.3, bills: 0 },
      },
      {
        id: 'roth2',
        name: 'Roth IRA (p2)',
        type: 'roth_ira',
        owner: 'p2',
        balance: 96200,
        rothBasis: { contributions: 45000, conversions: [] },
        allocation: { stocks: 1, bonds: 0, bills: 0 },
      },
      {
        id: 'brok',
        name: 'Taxable brokerage',
        type: 'taxable_brokerage',
        owner: 'joint',
        balance: 71500,
        costBasis: 41000,
        allocation: { stocks: 1, bonds: 0, bills: 0 },
      },
      {
        id: 'savings',
        name: 'Savings',
        type: 'savings',
        owner: 'joint',
        balance: 31400,
        allocation: { stocks: 0, bonds: 0, bills: 1 },
      },
    ],
    home: {
      value: 1200000,
      costBasis: 620000,
      state: 'va',
      propertyTaxAnnual: 9800,
      insuranceAnnual: 2400,
      maintenancePctOfValue: 0.01,
      sellingCostPct: 0.06,
      mortgage: null,
    },
    income: {
      salaries: { p1: 260000, p2: 0 },
      contribution401k: 24000,
      employerMatch401k: 6000,
    },
    expenses: {
      livingMonthly: 7100,
      charitableMonthly: 2300,
      investingMonthly: 0,
      ...over,
    },
    health: {
      acaBenchmarkMonthly: 1572,
      acaQuoteYear: 2026,
      partDPlanMonthly: 45,
      employerPremiumShareMonthly: 350,
    },
    settings: {
      horizonAge: 95,
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

/** Retire mid-2028, both claim at 67. Long enough to reach RMDs at 75. */
const basePlan: ScenarioEvent[] = [
  { type: 'retire', person: 'p1', date: '2028-07' },
  { type: 'retire', person: 'p2', date: '2028-07' },
  { type: 'claim_social_security', person: 'p1', date: '2038-07' },
  { type: 'claim_social_security', person: 'p2', date: '2038-07' },
];

function run(profile: Profile, events: ScenarioEvent[], name: string): RunResult {
  const scenario: Scenario = { name, events };
  return runSimulation({
    profile,
    assumptions: assumptions(),
    scenario,
    mode: 'deterministic',
    paths: 1,
    seed: 20260812,
  } satisfies SimulationInput);
}

/** Everything arithmetic about a run, hashed (see the header for the exclusions). */
function runDigest(res: RunResult): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        success: res.success,
        horizonYears: res.horizonYears,
        fan: res.fan,
        medianTerminalReal: res.medianTerminalReal,
        worstDecileShortfallYears: res.worstDecileShortfallYears,
        breakGlassReal: res.breakGlassReal,
        charitableLegacy: res.charitableLegacy,
        referencePath: res.referencePath,
      }),
    )
    .digest('hex');
}

/*
 * WHY THE PINS BELOW MOVED ONCE, AND WHAT THAT DID NOT MEAN.
 *
 * The de-personalisation pass rebased this fixture: the balances, home value,
 * salary and PIA figures used to be one real household's, and are now invented
 * ones of the same shape. A digest hashes the run, so changing the INPUT moves
 * it — that is arithmetic, not a regression.
 *
 * The evidence that the ENGINE did not move is separate and was taken first:
 * src/engine changed only inside comments in that pass (tests/shared/
 * engineVersion.test.ts pins the source bytes, so the change is visible), and
 * every golden digest in the suite — these included — passed UNCHANGED under
 * the edited engine while the fixtures still held their old values. Only then
 * were the fixtures rebased and the pins re-taken.
 *
 * The rule this file has always had still stands: if one of these moves again,
 * find out what changed before touching it.
 */
const FAIL =
  'A PROFILE WITH NO LINES AND NO POLICIES MOVED. Per-line survivor spending, ' +
  'multi-policy life insurance and the guardrails policy were all supposed to ' +
  'be inert until a profile asks for them. Find out what changed before ' +
  'touching this pin.';

/** The legacy single-policy fields, as a profile written before this work had them. */
const legacyPolicy = {
  lifeInsuranceMonthly: 320,
  lifeInsuranceDeathBenefit: 1_000_000,
  lifeInsuranceInsured: 'p1',
};

describe('a profile with no lines and no policies is the pre-lines engine', () => {
  it('A. a death inside a legacy term: the survivor fraction and the policy that pays', () => {
    const profile = household({
      ...legacyPolicy,
      lifeInsuranceTermStart: '2026-01',
      lifeInsuranceTermEnd: '2036-06',
    });
    const res = run(
      profile,
      [...basePlan, { type: 'death', person: 'p1', date: '2034-07' }],
      'legacy-death-in-term',
    );
    // The fixture really is exercising what it claims: the policy paid, and
    // the survivor's living costs fell to the (arguable) global default.
    expect(res.referencePath.find((r) => r.year === 2034)?.survivor?.lifeInsuranceBenefit).toBe(
      1_000_000,
    );
    expect(runDigest(res), FAIL).toBe(
      '6c8eabf7ac58803a09d16e527e4e80df39e5e1593e5415db30a86fe807dc0e48',
    );
  });

  it('B. the same death after the term lapsed: the policy that does not pay', () => {
    const profile = household({
      ...legacyPolicy,
      lifeInsuranceTermStart: '2026-01',
      lifeInsuranceTermEnd: '2032-06',
    });
    const res = run(
      profile,
      [...basePlan, { type: 'death', person: 'p1', date: '2034-07' }],
      'legacy-death-after-term',
    );
    expect(res.referencePath.find((r) => r.year === 2034)?.survivor?.lifeInsuranceBenefit).toBe(0);
    expect(runDigest(res), FAIL).toBe(
      '8c9c6b9a35ee53822fafe15f0be263693c518cc2a339925b8e5a80875959621e',
    );
  });

  it('C. no term dates at all: coverage that ends with the paycheck', () => {
    // The pre-existing rule, and the one the synthetic policy now expresses as
    // cancelAtRetirement: the premium runs for the months somebody worked and
    // the benefit is payable only inside them. The death here is in a working
    // month, so it pays; the premium months in the retirement year are the
    // worked ones.
    const profile = household(legacyPolicy);
    const res = run(
      profile,
      [...basePlan, { type: 'death', person: 'p1', date: '2027-04' }],
      'legacy-no-term',
    );
    expect(res.referencePath.find((r) => r.year === 2027)?.survivor?.lifeInsuranceBenefit).toBe(
      1_000_000,
    );
    expect(runDigest(res), FAIL).toBe(
      '81f77be8233cfa2b4789a33b890bf04b07b7df78bfa44911393b8bb13949606f',
    );
  });

  it('D. fixed_percent, the spending policy guardrails sits next to', () => {
    const profile = household(legacyPolicy);
    profile.settings.spendingPolicy = { type: 'fixed_percent', percent: 0.04 };
    const res = run(profile, basePlan, 'legacy-fixed-percent');
    expect(runDigest(res), FAIL).toBe(
      'e75c7aa524f1b6e669a5bf7d0d7e5eba972c9404e0abfe292d6a2c8acb4e09e0',
    );
  });

  it('E. a death carrying an explicit livingFraction, which nothing may outrank', () => {
    const profile = household(legacyPolicy);
    const res = run(
      profile,
      [...basePlan, { type: 'death', person: 'p1', date: '2040-07', livingFraction: 0.6 }],
      'legacy-explicit-fraction',
    );
    expect(runDigest(res), FAIL).toBe(
      'a0820f4c15ed3b4dca3b5b6105453b8d85313bee051967a75948c5fce7105d3f',
    );
  });
});

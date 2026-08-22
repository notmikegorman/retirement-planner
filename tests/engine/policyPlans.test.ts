/**
 * PER-POLICY DISPOSITIONS: assumption_overrides.expenses.lifeInsurancePolicyPlans.
 *
 * For a profile carrying a POLICY LIST, the legacy single-policy override
 * fields are unreachable — resolvePolicies gives the list total precedence —
 * so "what if we cancelled one or both?" needs its own per-policy override.
 * The map is keyed by policy id: 'cancel_now' takes the policy out of the run
 * entirely (no premium, no benefit), 'cancel_at_retirement' forces the
 * cancelAtRetirement flag on, 'keep_to_term' forces it off. ABSENT — the map
 * or an id — means the profile's own configuration, which is the property
 * every existing scenario's bit-identity rests on.
 *
 * Applied in profileWithOverrides (simulate.ts), the one funnel every run
 * passes through, so every test here goes through runSimulation rather than
 * prepareHousehold: prepareHousehold never sees the scenario's overrides.
 *
 * Contents:
 *  1. absence in every form is a byte-level no-op (empty map, unknown ids,
 *     a map on a legacy no-list profile)
 *  2. cancel_now: no premium, no benefit, from the first month
 *  3. cancel_at_retirement: premium and cover both stop with the paycheck
 *  4. keep_to_term: un-cancels a policy the profile drops at retirement
 *  5. one cancelled + one kept — the comparison the feature exists for
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { runSimulation } from '../../src/engine/simulate';
import { loadHistoricalCsv } from '../../src/engine/returns';
import { stableStringify } from '../../src/shared/util';
import type {
  AcaData,
  Assumptions,
  FederalTaxData,
  LifeInsurancePolicy,
  LifeInsurancePolicyPlan,
  MarketAssumptions,
  MedicareData,
  Profile,
  RmdTableData,
  RunResult,
  Scenario,
  ScenarioEvent,
  SocialSecurityData,
  StateTaxData,
  YearRow,
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

/** Two representative policies: the numbers the Spending card shows. */
const TERM_A_PREMIUM = 158.33;
const TERM_B_PREMIUM = 141.67;

const termA: LifeInsurancePolicy = {
  id: 'termA',
  label: 'Northbridge Term',
  insured: 'p1',
  premiumMonthly: TERM_A_PREMIUM,
  deathBenefit: 2_500_000,
  termEnd: '2032-12',
};

const termB: LifeInsurancePolicy = {
  id: 'termB',
  label: 'Cardinal Mutual',
  insured: 'p1',
  premiumMonthly: TERM_B_PREMIUM,
  deathBenefit: 1_000_000,
  termEnd: '2030-12',
};

function household(over?: {
  policies?: LifeInsurancePolicy[];
  legacy?: Partial<Profile['expenses']>;
}): Profile {
  const person = (id: string) => ({
    id,
    name: id.toUpperCase(),
    birthYear: 1971,
    birthMonth: 6,
    piaMonthlyAtFraIfWorkingTo62: 0,
    piaMonthlyAtFraIfStoppingNow: 0,
    hasOwnBenefit: false,
  });
  const expenses: Profile['expenses'] = {
    livingMonthly: 5_000,
    charitableMonthly: 0,
    investingMonthly: 0,
    ...over?.legacy,
  };
  if (over?.policies !== undefined) expenses.lifeInsurancePolicies = over.policies;
  return {
    people: [person('p1'), person('p2')],
    filing: { status: 'mfj', state: 'va' },
    accounts: [
      {
        id: 'savings',
        name: 'Savings',
        type: 'savings',
        owner: 'joint',
        balance: 3_000_000,
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
    income: { salaries: { p1: 265_000, p2: 0 }, contribution401k: 0, employerMatch401k: 0 },
    expenses,
    health: {
      acaBenchmarkMonthly: 0,
      acaQuoteYear: 2026,
      partDPlanMonthly: 0,
      employerPremiumShareMonthly: 0,
    },
    settings: {
      horizonAge: 64,
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

const RETIRE_2028: ScenarioEvent = { type: 'retire', person: 'p1', date: '2028-07' };

function run(
  profile: Profile,
  events: ScenarioEvent[],
  plans?: Record<string, LifeInsurancePolicyPlan>,
): RunResult {
  const scenario: Scenario = {
    name: 'policy plans',
    autoSepp: false,
    events,
    // Zero inflation, so a premium in today's dollars is the premium charged.
    assumption_overrides: {
      market: {
        deterministicReal: { stocks: 0, bonds: 0, bills: 0 },
        deterministicInflation: 0,
        cashYieldNominal: 0,
      },
      ...(plans !== undefined ? { expenses: { lifeInsurancePolicyPlans: plans } } : {}),
    },
  };
  return runSimulation({
    profile,
    assumptions: assumptions(),
    scenario,
    mode: 'deterministic',
    paths: 1,
    seed: 1,
  });
}

const rowFor = (rows: YearRow[], year: number): YearRow => rows.find((r) => r.year === year)!;

/**
 * Everything but `meta` (which hashes the INPUT and therefore legitimately
 * differs between a scenario with the map and one without) and `elapsedMs`
 * (wall-clock noise). The numbers are what must not move.
 */
function numbers(res: RunResult): string {
  const { meta: _meta, elapsedMs: _elapsed, ...rest } = res;
  return stableStringify(rest);
}

// ---------------------------------------------------------------------------
// 1. Absence, in every form, is a no-op
// ---------------------------------------------------------------------------

describe('an absent or inert plans map changes not one byte of the output', () => {
  const DEATH_2029: ScenarioEvent = { type: 'death', person: 'p1', date: '2029-05' };

  it('an empty map is byte-identical to no map at all', () => {
    // {} still trips the profile rebuild in profileWithOverrides — the rebuild
    // itself must reproduce the untouched run exactly, or every scenario
    // carrying the key would drift without touching any policy.
    const base = run(household({ policies: [termA, termB] }), [RETIRE_2028, DEATH_2029]);
    const withEmpty = run(household({ policies: [termA, termB] }), [RETIRE_2028, DEATH_2029], {});
    expect(numbers(withEmpty)).toBe(numbers(base));
  });

  it('an id naming no policy is ignored, never a crash — profiles get renamed', () => {
    const base = run(household({ policies: [termA, termB] }), [RETIRE_2028, DEATH_2029]);
    const withUnknown = run(household({ policies: [termA, termB] }), [RETIRE_2028, DEATH_2029], {
      'term-a-2500k-renamed': 'cancel_now',
    });
    expect(numbers(withUnknown)).toBe(numbers(base));
  });

  it('a map aimed at a legacy no-list profile matches nothing and does nothing', () => {
    // The map is keyed by policy id and the legacy fields have none, so a
    // legacy profile keeps its single-policy behaviour untouched.
    const legacy = () =>
      household({ legacy: { lifeInsuranceMonthly: 320, lifeInsuranceDeathBenefit: 1_000_000 } });
    const base = run(legacy(), [RETIRE_2028, { type: 'death', person: 'p1', date: '2027-05' }]);
    const withMap = run(legacy(), [RETIRE_2028, { type: 'death', person: 'p1', date: '2027-05' }], {
      termA: 'cancel_now',
    });
    expect(numbers(withMap)).toBe(numbers(base));
    // And the legacy policy genuinely ran in both: a working-year death pays.
    expect(rowFor(base.referencePath, 2027).survivor?.lifeInsuranceBenefit).toBe(1_000_000);
  });
});

// ---------------------------------------------------------------------------
// 2. cancel_now
// ---------------------------------------------------------------------------

describe("'cancel_now' takes the policy out of the run entirely", () => {
  it('charges no premium from the very first simulated year', () => {
    const base = run(household({ policies: [termA, termB] }), [RETIRE_2028]);
    const cancelled = run(household({ policies: [termA, termB] }), [RETIRE_2028], {
      termA: 'cancel_now',
      termB: 'cancel_now',
    });
    // Both premiums gone in 2026: baseline is living alone.
    expect(rowFor(base.referencePath, 2026).expenses.baseline).toBeCloseTo(
      5_000 * 12 + (TERM_A_PREMIUM + TERM_B_PREMIUM) * 12,
      6,
    );
    expect(rowFor(cancelled.referencePath, 2026).expenses.baseline).toBeCloseTo(5_000 * 12, 6);
  });

  it('pays no benefit either — a cancelled policy is not a free option on death', () => {
    const cancelled = run(
      household({ policies: [termA, termB] }),
      [RETIRE_2028, { type: 'death', person: 'p1', date: '2027-05' }],
      { termA: 'cancel_now', termB: 'cancel_now' },
    );
    expect(rowFor(cancelled.referencePath, 2027).survivor?.lifeInsuranceBenefit ?? 0).toBe(0);
  });

  it('cancelling EVERY policy must not resurrect the legacy single-policy fields', () => {
    /*
     * The trap: resolvePolicies falls back to the legacy fields when the list
     * is EMPTY (pinned in lifePolicies.test.ts), so implementing cancel_now by
     * filtering would hand a stale legacy policy the run — in exactly the
     * scenario that said "no cover at all". The engine zeroes instead of
     * filtering; this test is what keeps it that way.
     */
    const profile = household({
      policies: [termA],
      legacy: {
        lifeInsuranceMonthly: 999,
        lifeInsuranceDeathBenefit: 5_000_000,
        lifeInsuranceInsured: 'p1',
      },
    });
    const cancelled = run(
      profile,
      [RETIRE_2028, { type: 'death', person: 'p1', date: '2027-05' }],
      { termA: 'cancel_now' },
    );
    expect(rowFor(cancelled.referencePath, 2026).expenses.baseline).toBeCloseTo(5_000 * 12, 6);
    expect(rowFor(cancelled.referencePath, 2027).survivor?.lifeInsuranceBenefit ?? 0).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 3. cancel_at_retirement
// ---------------------------------------------------------------------------

describe("'cancel_at_retirement' stops premium and cover with the last paycheck", () => {
  it('prorates the retirement year and charges nothing after', () => {
    const res = run(household({ policies: [termA] }), [RETIRE_2028], {
      termA: 'cancel_at_retirement',
    });
    // Retire 2028-07: six worked months, so six premium months in 2028.
    expect(rowFor(res.referencePath, 2027).expenses.baseline).toBeCloseTo(
      5_000 * 12 + TERM_A_PREMIUM * 12,
      6,
    );
    expect(rowFor(res.referencePath, 2028).expenses.baseline).toBeCloseTo(
      5_000 * 12 + TERM_A_PREMIUM * 6,
      6,
    );
    expect(rowFor(res.referencePath, 2029).expenses.baseline).toBeCloseTo(5_000 * 12, 6);
  });

  it('a post-retirement death collects nothing; a working-year death still pays', () => {
    const after = run(
      household({ policies: [termA] }),
      [RETIRE_2028, { type: 'death', person: 'p1', date: '2029-03' }],
      { termA: 'cancel_at_retirement' },
    );
    expect(rowFor(after.referencePath, 2029).survivor?.lifeInsuranceBenefit ?? 0).toBe(0);
    const inside = run(
      household({ policies: [termA] }),
      [RETIRE_2028, { type: 'death', person: 'p1', date: '2028-03' }],
      { termA: 'cancel_at_retirement' },
    );
    expect(rowFor(inside.referencePath, 2028).survivor?.lifeInsuranceBenefit).toBe(2_500_000);
  });
});

// ---------------------------------------------------------------------------
// 4. keep_to_term
// ---------------------------------------------------------------------------

describe("'keep_to_term' un-cancels a policy the profile drops at retirement", () => {
  const cancelledInProfile: LifeInsurancePolicy = { ...termA, cancelAtRetirement: true };

  it('the premium runs to the term end, past the last paycheck', () => {
    const asProfile = run(household({ policies: [cancelledInProfile] }), [RETIRE_2028]);
    expect(rowFor(asProfile.referencePath, 2029).expenses.baseline).toBeCloseTo(5_000 * 12, 6);
    const kept = run(household({ policies: [cancelledInProfile] }), [RETIRE_2028], {
      termA: 'keep_to_term',
    });
    expect(rowFor(kept.referencePath, 2029).expenses.baseline).toBeCloseTo(
      5_000 * 12 + TERM_A_PREMIUM * 12,
      6,
    );
  });

  it('and the cover comes back with it: a 2029 death pays the face amount', () => {
    const kept = run(
      household({ policies: [cancelledInProfile] }),
      [RETIRE_2028, { type: 'death', person: 'p1', date: '2029-03' }],
      { termA: 'keep_to_term' },
    );
    expect(rowFor(kept.referencePath, 2029).survivor?.lifeInsuranceBenefit).toBe(2_500_000);
  });
});

// ---------------------------------------------------------------------------
// 5. One cancelled, one kept — the actual question
// ---------------------------------------------------------------------------

describe('one cancelled + one kept: dispositions are genuinely per policy', () => {
  it('charges only the kept premium and pays only the kept face amount', () => {
    const res = run(
      household({ policies: [termA, termB] }),
      [RETIRE_2028, { type: 'death', person: 'p1', date: '2029-05' }],
      { termB: 'cancel_now' },
    );
    // Northbridge alone is charged...
    expect(rowFor(res.referencePath, 2026).expenses.baseline).toBeCloseTo(
      5_000 * 12 + TERM_A_PREMIUM * 12,
      6,
    );
    // ...and Northbridge alone pays: $2.5M, not the $3.5M both would sum to.
    expect(rowFor(res.referencePath, 2029).survivor?.lifeInsuranceBenefit).toBe(2_500_000);
  });

  it('an unknown id beside a known one does not blunt the known one', () => {
    const res = run(household({ policies: [termA, termB] }), [RETIRE_2028], {
      termB: 'cancel_now',
      ghost: 'cancel_now',
    });
    expect(rowFor(res.referencePath, 2026).expenses.baseline).toBeCloseTo(
      5_000 * 12 + TERM_A_PREMIUM * 12,
      6,
    );
  });
});

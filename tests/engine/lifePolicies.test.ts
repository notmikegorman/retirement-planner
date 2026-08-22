/**
 * MULTI-POLICY LIFE INSURANCE: several policies, several terms, one household.
 *
 * The engine used to model one policy that ended when the paycheck did. A
 * household can hold two, and the difference is not academic. The Northbridge
 * Term policy runs to 2032 while the plan retires in 2028, so the old rule
 * dropped FOUR YEARS of $1,900/yr premium and — far worse — four years of
 * $2,500,000 of cover, in exactly the pre-Social-Security years where a death
 * hurts most. It
 * made the plan look cheaper and the widow look safer, both wrong, and it did
 * it silently.
 *
 * So: each policy has its own insured, its own premium, its own term window and
 * its own answer to "does this end at retirement". Premiums SUM across the
 * policies in force; the benefit is the sum over the policies whose term covers
 * the month of death AND whose insured is the person who died.
 *
 * The fixture's two premiums add to $300/mo — the point being that one number
 * on a budget line can be two policies with two very different expiry dates
 * behind it.
 *
 * Contents:
 *  1. premiums sum, and a policy expiring mid-year is prorated
 *  2. a term that outlasts retirement keeps charging AND keeps paying
 *  3. cancelAtRetirement, which is how you say "drop it" — and is FALSE by default
 *  4. the benefit: whose life, which months, and two policies on one life
 *  5. the list supersedes the single-policy fields entirely
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseEvents } from '../../src/engine/events';
import { prepareHousehold, SIM_START_YEAR } from '../../src/engine/household';
import { runSimulation } from '../../src/engine/simulate';
import { loadHistoricalCsv } from '../../src/engine/returns';
import type {
  AcaData,
  Assumptions,
  FederalTaxData,
  LifeInsurancePolicy,
  MarketAssumptions,
  MedicareData,
  Profile,
  RmdTableData,
  Scenario,
  ScenarioEvent,
  RunResult,
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

const ssData = ssJson as unknown as SocialSecurityData;
const medicareData = medicareJson as unknown as MedicareData;
const acaData = acaJson as unknown as AcaData;

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
    socialSecurity: ssData,
    medicare: medicareData,
    aca: acaData,
    rmd: rmdJson as unknown as RmdTableData,
  };
}

/** Two premiums behind one budget line: 158.33 + 141.67 = the 300/mo on it. */
const TERM_A_PREMIUM = 158.33;
const TERM_B_PREMIUM = 141.67;

/** Runs past the 2028 retirement and expires mid-2032 — the policy that broke the old rule. */
const termA: LifeInsurancePolicy = {
  id: 'termA',
  label: 'Northbridge Term',
  insured: 'p1',
  premiumMonthly: TERM_A_PREMIUM,
  deathBenefit: 2_500_000,
  termEnd: '2032-06',
};

/** The longer one, on the same life. */
const other: LifeInsurancePolicy = {
  id: 'other',
  label: 'Harborline',
  insured: 'p1',
  premiumMonthly: TERM_B_PREMIUM,
  deathBenefit: 1_000_000,
  termEnd: '2040-06',
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
    // p1 carries the salary and retires in 2028 — the four-year gap between the
    // last paycheck and the Northbridge Term expiry is what this file is about.
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

const RETIRE_2028: ScenarioEvent = { type: 'retire', person: 'p1', date: '2028-01' };

const prepared = (profile: Profile, events: ScenarioEvent[], horizonYears = 10) =>
  prepareHousehold(profile, parseEvents(events), ssData, medicareData, acaData, SIM_START_YEAR, horizonYears);

function run(profile: Profile, events: ScenarioEvent[]): RunResult {
  const scenario: Scenario = {
    name: 'policies',
    autoSepp: false,
    events,
    // Zero inflation, so a premium in today's dollars is the premium charged.
    assumption_overrides: {
      market: {
        deterministicReal: { stocks: 0, bonds: 0, bills: 0 },
        deterministicInflation: 0,
        cashYieldNominal: 0,
      },
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

const yearIndex = (year: number): number => year - SIM_START_YEAR;
const rowFor = (rows: YearRow[], year: number): YearRow => rows.find((r) => r.year === year)!;

// ---------------------------------------------------------------------------
// 1. Premiums sum, and expiry prorates
// ---------------------------------------------------------------------------

describe('premiums sum across the policies in force', () => {
  const h = () => prepared(household({ policies: [termA, other] }), [RETIRE_2028]);

  it('charges both while both run', () => {
    expect(h().lifeInsurancePremiumRealByYear[yearIndex(2026)]).toBeCloseTo(
      (TERM_A_PREMIUM + TERM_B_PREMIUM) * 12,
      9,
    );
  });

  it('prorates the year a policy expires — six months of Northbridge Term in 2032', () => {
    // termEnd '2032-06' is INCLUSIVE, so 2032 carries six Northbridge months and a
    // full twelve of the other. The same proration the single-premium code did
    // at retirement, now per policy and driven by that policy's own dates.
    expect(h().lifeInsurancePremiumRealByYear[yearIndex(2032)]).toBeCloseTo(
      TERM_A_PREMIUM * 6 + TERM_B_PREMIUM * 12,
      9,
    );
    expect(h().lifeInsurancePremiumRealByYear[yearIndex(2033)]).toBeCloseTo(
      TERM_B_PREMIUM * 12,
      9,
    );
  });
});

// ---------------------------------------------------------------------------
// 2. A term that outlasts retirement
// ---------------------------------------------------------------------------

describe('a policy whose term outlasts retirement still charges and still pays', () => {
  it('charges the premium in every year between the last paycheck and the expiry', () => {
    /*
     * THE BUG THIS FEATURE EXISTS FOR. The plan retires in January 2028 and
     * Northbridge Term runs to June 2032: 2028 through 2031 are four full
     * years the old rule charged nothing for, and 2032 a fifth part-year.
     */
    const h = prepared(household({ policies: [termA] }), [RETIRE_2028]);
    for (const year of [2028, 2029, 2030, 2031]) {
      expect(h.lifeInsurancePremiumRealByYear[yearIndex(year)]).toBeCloseTo(
        TERM_A_PREMIUM * 12,
        9,
      );
    }
    // 1,900/yr, the policy's own figure, four times over.
    const postRetirement = [2028, 2029, 2030, 2031].reduce(
      (sum, y) => sum + h.lifeInsurancePremiumRealByYear[yearIndex(y)],
      0,
    );
    expect(postRetirement).toBeCloseTo(TERM_A_PREMIUM * 12 * 4, 6);
  });

  it('pays the face amount for a death in those same years', () => {
    // The other half of the same fix, and the half that moves a widow score:
    // 2,500,000 of cover in the years before Social Security starts.
    const h = prepared(household({ policies: [termA] }), [
      RETIRE_2028,
      { type: 'death', person: 'p1', date: '2030-07' },
    ]);
    expect(h.death?.lifeInsuranceBenefit).toBe(2_500_000);
    expect(h.lifeInsuranceBenefitByYear[yearIndex(2030)]).toBe(2_500_000);
  });

  it('shows up as real money in the run: premium spent, benefit banked', () => {
    const res = run(household({ policies: [termA, other] }), [
      RETIRE_2028,
      { type: 'death', person: 'p1', date: '2030-07' },
    ]);
    // Living 5,000/mo plus both premiums, in a year with no paycheck.
    expect(rowFor(res.referencePath, 2029).expenses.baseline).toBeCloseTo(
      5_000 * 12 + (TERM_A_PREMIUM + TERM_B_PREMIUM) * 12,
      6,
    );
    // Both policies pay, and the money is a balance rather than income —
    // IRC 101(a)(1) puts not one dollar of it into AGI.
    expect(rowFor(res.referencePath, 2030).survivor?.lifeInsuranceBenefit).toBe(3_500_000);
    expect(rowFor(res.referencePath, 2030).taxes.federal.agi).toBeLessThan(1_000_000);
  });
});

// ---------------------------------------------------------------------------
// 3. cancelAtRetirement
// ---------------------------------------------------------------------------

describe('cancelAtRetirement is how a plan says "drop it", and it is off by default', () => {
  it('an absent flag keeps the policy — dropping cover is a decision, not a default', () => {
    const h = prepared(household({ policies: [termA] }), [RETIRE_2028]);
    expect(h.lifeInsurancePremiumRealByYear[yearIndex(2029)]).toBeCloseTo(TERM_A_PREMIUM * 12, 9);
  });

  it('the flag stops the premium at the last paycheck, prorated in the retirement year', () => {
    const cancelled: LifeInsurancePolicy = { ...termA, cancelAtRetirement: true };
    const h = prepared(household({ policies: [cancelled] }), [
      { type: 'retire', person: 'p1', date: '2028-07' },
    ]);
    expect(h.lifeInsurancePremiumRealByYear[yearIndex(2027)]).toBeCloseTo(TERM_A_PREMIUM * 12, 9);
    expect(h.lifeInsurancePremiumRealByYear[yearIndex(2028)]).toBeCloseTo(TERM_A_PREMIUM * 6, 9);
    expect(h.lifeInsurancePremiumRealByYear[yearIndex(2029)]).toBe(0);
  });

  it('a cancelled policy pays nothing either — you cannot keep the cover and drop the cheque', () => {
    const cancelled: LifeInsurancePolicy = { ...termA, cancelAtRetirement: true };
    const inside = prepared(household({ policies: [cancelled] }), [
      { type: 'retire', person: 'p1', date: '2028-07' },
      { type: 'death', person: 'p1', date: '2028-03' },
    ]);
    expect(inside.death?.lifeInsuranceBenefit).toBe(2_500_000);
    const after = prepared(household({ policies: [cancelled] }), [
      { type: 'retire', person: 'p1', date: '2028-07' },
      { type: 'death', person: 'p1', date: '2029-03' },
    ]);
    expect(after.death?.lifeInsuranceBenefit).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 4. The benefit
// ---------------------------------------------------------------------------

describe('the benefit is the sum over policies on the person who died, in term', () => {
  it('two policies on one life both pay', () => {
    const h = prepared(household({ policies: [termA, other] }), [
      RETIRE_2028,
      { type: 'death', person: 'p1', date: '2029-05' },
    ]);
    expect(h.death?.lifeInsuranceBenefit).toBe(3_500_000);
  });

  it('a policy on the SURVIVOR pays nothing — that is not who died', () => {
    const onP2: LifeInsurancePolicy = { ...other, id: 'onP2', insured: 'p2' };
    const h = prepared(household({ policies: [termA, onP2] }), [
      RETIRE_2028,
      { type: 'death', person: 'p1', date: '2029-05' },
    ]);
    expect(h.death?.lifeInsuranceBenefit).toBe(2_500_000);
  });

  it('each policy answers for its own term: the expired one drops out, the live one pays', () => {
    // A death in 2035 is past Northbridge Term's June 2032 expiry and inside the
    // other's. One face amount, not two, and not zero.
    const h = prepared(
      household({ policies: [termA, other] }),
      [RETIRE_2028, { type: 'death', person: 'p1', date: '2035-05' }],
      20,
    );
    expect(h.death?.lifeInsuranceBenefit).toBe(1_000_000);
  });

  it('honours termStart: cover bought at retirement is not cover held today', () => {
    const bought: LifeInsurancePolicy = {
      ...termA,
      termStart: '2028-01',
      termEnd: '2033-12',
    };
    const early = prepared(household({ policies: [bought] }), [
      RETIRE_2028,
      { type: 'death', person: 'p1', date: '2027-05' },
    ]);
    expect(early.death?.lifeInsuranceBenefit).toBe(0);
    // And the premium starts with the cover, not with the simulation.
    const h = prepared(household({ policies: [bought] }), [RETIRE_2028]);
    expect(h.lifeInsurancePremiumRealByYear[yearIndex(2027)]).toBe(0);
    expect(h.lifeInsurancePremiumRealByYear[yearIndex(2028)]).toBeCloseTo(TERM_A_PREMIUM * 12, 9);
  });

  it('rejects a policy insuring somebody who is not in the profile', () => {
    // Silently insuring nobody would report a widow score with no cover at all
    // and no way to tell why.
    expect(() =>
      prepared(household({ policies: [{ ...termA, insured: 'ghost' }] }), [RETIRE_2028]),
    ).toThrow(/unknown person "ghost"/);
  });
});

// ---------------------------------------------------------------------------
// 5. The list supersedes the single-policy fields
// ---------------------------------------------------------------------------

describe('a non-empty list supersedes the single-policy fields entirely', () => {
  it('ignores the legacy premium, benefit and term rather than adding them on', () => {
    /*
     * Half-inheriting would be the worst of both: a household that transcribed
     * its policies into the list and left the old fields in place would pay
     * two premiums and collect two benefits for one policy.
     */
    const profile = household({
      policies: [termA],
      legacy: {
        lifeInsuranceMonthly: 999,
        lifeInsuranceDeathBenefit: 5_000_000,
        lifeInsuranceInsured: 'p1',
      },
    });
    const h = prepared(profile, [RETIRE_2028, { type: 'death', person: 'p1', date: '2029-05' }]);
    expect(h.lifeInsurancePremiumRealByYear[yearIndex(2026)]).toBeCloseTo(TERM_A_PREMIUM * 12, 9);
    expect(h.death?.lifeInsuranceBenefit).toBe(2_500_000);
  });

  it('an EMPTY list leaves the legacy fields in charge', () => {
    // Absent-or-empty means "the old fields are the truth", exactly as it does
    // for the itemised budget.
    const profile = household({
      policies: [],
      legacy: { lifeInsuranceMonthly: 320, lifeInsuranceDeathBenefit: 1_000_000 },
    });
    const h = prepared(profile, [{ type: 'retire', person: 'p1', date: '2028-07' }]);
    // No term dates, so the legacy rule applies: cover for the months worked.
    expect(h.lifeInsurancePremiumRealByYear[yearIndex(2027)]).toBe(320 * 12);
    expect(h.lifeInsurancePremiumRealByYear[yearIndex(2028)]).toBe(320 * 6);
    expect(h.lifeInsurancePremiumRealByYear[yearIndex(2029)]).toBe(0);
  });
});

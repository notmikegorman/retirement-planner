/**
 * THE WIDOW SCORE, engine side: what a `death` event actually does to a plan.
 *
 * The tax module's half is in tests/tax/singleFiler.test.ts (brackets,
 * deduction, LTCG, NIIT, the Social Security worksheet, ACA and IRMAA
 * thresholds) and tests/tax/survivorBenefit.test.ts (the survivor benefit
 * factors). This file is about the ENGINE: which year files which way, whose
 * cheque stops, whose account it becomes, and when the insurer pays.
 *
 * The organising claim is that there is no survivor engine. A widow score is
 * an ordinary simulation of a plan that happens to contain a death, and every
 * survivor-specific quantity is resolved ONCE in prepareHousehold because a
 * death date is path-independent. So most of what is asserted here is asserted
 * against prepareHousehold directly — hand-computed month by month — with full
 * runs used where the question is genuinely about the yearly loop.
 *
 * Contents:
 *  1. filing status and the tax household by year — MFJ through the year of
 *     death INCLUSIVE, single from the first full year after
 *  2. Social Security — the larger benefit survives, the smaller one stops,
 *     and a spousal benefit dies with the worker it hangs off
 *  3. accounts — spousal rollover onto HER RMD schedule (not a 10-year
 *     inherited-IRA drain), the 401(k) re-typed, and the basis step-up
 *  4. term life — inside the term it pays, outside it does not, and the
 *     payout is not income
 *  5. the widow penalty inside a real run
 *  6. one-person ACA and IRMAA after the death
 *  7. the guard: with no death, every survivor schedule is exactly the
 *     no-op value
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseEvents } from '../../src/engine/events';
import { prepareHousehold, SIM_START_YEAR } from '../../src/engine/household';
import { runSimulation } from '../../src/engine/simulate';
import { loadHistoricalCsv } from '../../src/engine/returns';
import { DEFAULT_SURVIVOR_LIVING_FRACTION } from '../../src/shared/types';
import type {
  AcaData,
  Account,
  Assumptions,
  FederalTaxData,
  MarketAssumptions,
  MedicareData,
  Person,
  Profile,
  RmdTableData,
  RunResult,
  Scenario,
  ScenarioEvent,
  SimulationInput,
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

function person(id: string, over?: Partial<Person>): Person {
  return {
    id,
    name: id.toUpperCase(),
    birthYear: 1971,
    birthMonth: 6,
    piaMonthlyAtFraIfWorkingTo62: 0,
    piaMonthlyAtFraIfStoppingNow: 0,
    hasOwnBenefit: false,
    ...over,
  };
}

function account(a: Omit<Account, 'name'> & { name?: string }): Account {
  return { name: a.id, ...a };
}

/**
 * Minimal two-person household: Virginia, MFJ, no salary, no housing cost, no
 * health premiums. Everything a survivor test wants to vary is a parameter;
 * everything else is zero so the arithmetic stays hand-checkable.
 */
function household(partial?: {
  people?: Person[];
  accounts?: Account[];
  annualLiving?: number;
  horizonAge?: number;
  lifeInsuranceMonthly?: number;
  lifeInsuranceDeathBenefit?: number;
  lifeInsuranceTermEnd?: string;
  lifeInsuranceInsured?: string;
  salaries?: Record<string, number>;
  acaBenchmarkMonthly?: number;
  partDPlanMonthly?: number;
}): Profile {
  const expenses: Profile['expenses'] = {
    livingMonthly: (partial?.annualLiving ?? 60_000) / 12,
    charitableMonthly: 0,
    investingMonthly: 0,
  };
  if (partial?.lifeInsuranceMonthly !== undefined) {
    expenses.lifeInsuranceMonthly = partial.lifeInsuranceMonthly;
  }
  if (partial?.lifeInsuranceDeathBenefit !== undefined) {
    expenses.lifeInsuranceDeathBenefit = partial.lifeInsuranceDeathBenefit;
  }
  if (partial?.lifeInsuranceTermEnd !== undefined) {
    expenses.lifeInsuranceTermEnd = partial.lifeInsuranceTermEnd;
  }
  if (partial?.lifeInsuranceInsured !== undefined) {
    expenses.lifeInsuranceInsured = partial.lifeInsuranceInsured;
  }
  return {
    people: partial?.people ?? [person('p1'), person('p2')],
    filing: { status: 'mfj', state: 'va' },
    accounts:
      partial?.accounts ??
      [
        account({
          id: 'savings',
          type: 'savings',
          owner: 'joint',
          balance: 2_000_000,
          allocation: { stocks: 0, bonds: 0, bills: 1 },
        }),
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
    income: {
      salaries: partial?.salaries ?? { p1: 0, p2: 0 },
      contribution401k: 0,
      employerMatch401k: 0,
    },
    expenses,
    health: {
      acaBenchmarkMonthly: partial?.acaBenchmarkMonthly ?? 0,
      acaQuoteYear: 2026,
      partDPlanMonthly: partial?.partDPlanMonthly ?? 0,
      employerPremiumShareMonthly: 0,
    },
    settings: {
      horizonAge: partial?.horizonAge ?? 95,
      successTarget: 0.85,
      mcPathsInteractive: 1000,
      mcPathsFinal: 10000,
      seed: 1,
      spendingPolicy: { type: 'fixed_real' },
      withdrawalPolicy: { order: ['cash', 'taxable', 'pretax', 'roth'], pretaxPreference: 'ira_first' },
    },
  };
}

/** prepareHousehold over a scenario's events, at the engine's real start year. */
function prepared(profile: Profile, events: ScenarioEvent[], horizonYears = 41) {
  return prepareHousehold(
    profile,
    parseEvents(events),
    ssData,
    medicareData,
    acaData,
    SIM_START_YEAR,
    horizonYears,
  );
}

function run(profile: Profile, scenario: Scenario, over?: Partial<SimulationInput>): RunResult {
  return runSimulation({
    profile,
    assumptions: assumptions(),
    scenario,
    mode: 'deterministic',
    paths: 1,
    seed: 42,
    ...over,
  });
}

const rowFor = (rows: YearRow[], year: number): YearRow => rows.find((r) => r.year === year)!;
const yearIndex = (year: number): number => year - SIM_START_YEAR;

// ---------------------------------------------------------------------------
// 1. Filing status and the tax household
// ---------------------------------------------------------------------------

describe('the year of death files MFJ; the year after files single', () => {
  const events: ScenarioEvent[] = [{ type: 'death', person: 'p1', date: '2035-07' }];

  it('IRC 6013(a)(3): the year of death is the LAST joint return', () => {
    /*
     * "The year of death is the last year for which you can file jointly with
     * your deceased spouse" (IRS Pub. 501, on IRC 6013(a)(3)). And with no
     * dependent child there is no two-year grace period at joint rates:
     * qualifying-surviving-spouse status under IRC 2(a)(1)(B) requires a
     * dependent son/stepson/daughter/stepdaughter joined to the other
     * conditions by "and". So the penalty lands the VERY NEXT year — 2036 —
     * not in 2038.
     */
    const h = prepared(household(), events);
    expect(h.filingByYear[yearIndex(2034)]).toBe('mfj');
    expect(h.filingByYear[yearIndex(2035)]).toBe('mfj'); // the year of death
    expect(h.filingByYear[yearIndex(2036)]).toBe('single');
    expect(h.filingByYear[yearIndex(2037)]).toBe('single');
    // No qualifying-surviving-spouse window anywhere in the run.
    expect(h.filingByYear.slice(yearIndex(2036)).every((s) => s === 'single')).toBe(true);
  });

  it('the decedent is counted on the death-year return and gone from the next', () => {
    // The head-count drives 65+ standard-deduction add-ons, Virginia's
    // exemptions and age deduction, South Carolina's per-person deductions,
    // and how many people Medicare is billed for. It moves at the YEAR
    // boundary, one year later than the cash flows — which is law, not a
    // simplification.
    const h = prepared(household(), events);
    expect(h.taxPeopleByYear[yearIndex(2035)]).toEqual([0, 1]);
    expect(h.taxPeopleByYear[yearIndex(2036)]).toEqual([1]);
  });

  it('a death in December still files jointly for that whole year', () => {
    // The boundary case the "months 1..m-1" convention makes tempting to get
    // wrong: cash flows stop in December, but the RETURN is joint for all of
    // 2035 and single only from 2036.
    const h = prepared(household(), [{ type: 'death', person: 'p1', date: '2035-12' }]);
    expect(h.filingByYear[yearIndex(2035)]).toBe('mfj');
    expect(h.filingByYear[yearIndex(2036)]).toBe('single');
  });

  it('a death in January is likewise joint for the year it happens', () => {
    const h = prepared(household(), [{ type: 'death', person: 'p1', date: '2035-01' }]);
    expect(h.filingByYear[yearIndex(2035)]).toBe('mfj');
    expect(h.filingByYear[yearIndex(2036)]).toBe('single');
  });

  it('a full run records the status it actually taxed on, year by year', () => {
    const res = run(household({ annualLiving: 60_000 }), { name: 'death', events });
    const rows = res.referencePath;
    // Nothing before the death even mentions a survivor.
    expect(rows.filter((r) => r.year < 2035).every((r) => r.survivor === undefined)).toBe(true);
    const deathYear = rowFor(rows, 2035);
    expect(deathYear.survivor).toEqual({
      deceased: 'p1',
      deathYear: true,
      filingStatus: 'mfj',
      taxPeople: 2,
      lifeInsuranceBenefit: 0, // no policy on this fixture
      ssLumpSum: 255, // SSA §202(i), statutory and never indexed
    });
    const after = rowFor(rows, 2036);
    expect(after.survivor?.filingStatus).toBe('single');
    expect(after.survivor?.taxPeople).toBe(1);
    expect(after.survivor?.deathYear).toBe(false);
    expect(deathYear.flags).toContain('death');
    expect(after.flags).toContain('survivor');
    expect(deathYear.eventsFired).toContain('spousal-rollover');
  });

  it('the standard deduction on the return proves the status was really used', () => {
    /*
     * A filing-status field that nothing reads would pass every test above.
     * This one checks the money: in 2035 (index 1.025^9 = 1.2488632...) the
     * couple's deduction is 32,200 x index and in 2036 the widow's is
     * 16,100 x index — nobody is 65 yet (born 1971, 65 in 2036 — and the
     * add-on is counted at YEAR END, so 2036 is the first year it applies to
     * her). So the 2036 figure is (16,100 + 2,050) x 1.025^10.
     */
    const res = run(household({ annualLiving: 200_000 }), { name: 'death', events });
    const rows = res.referencePath;
    const idx2035 = 1.025 ** 9;
    const idx2036 = 1.025 ** 10;
    expect(rowFor(rows, 2035).taxes.federal.standardDeduction).toBeCloseTo(32_200 * idx2035, 6);
    expect(rowFor(rows, 2036).taxes.federal.standardDeduction).toBeCloseTo(
      (16_100 + 2_050) * idx2036,
      6,
    );
  });

  it('rejects a scenario that leaves nobody alive, or names a stranger', () => {
    // A plan with no household left to score is a question the model has no
    // answer to; better a loud throw than a run of nothing.
    expect(() => prepared(household(), [{ type: 'death', person: 'nobody', date: '2035-07' }])).toThrow(
      /unknown person/,
    );
    expect(() =>
      prepared(household({ people: [person('p1')] }), [
        { type: 'death', person: 'p1', date: '2035-07' },
      ]),
    ).toThrow(/nobody alive/);
    expect(() =>
      prepared(household(), [
        { type: 'death', person: 'p1', date: '2035-07' },
        { type: 'death', person: 'p2', date: '2040-07' },
      ]),
    ).toThrow(/at most one/);
  });
});

// ---------------------------------------------------------------------------
// 2. Social Security
// ---------------------------------------------------------------------------

describe('the survivor is paid the LARGER benefit, and the smaller one stops', () => {
  /**
   * All three fixtures below share a shape: both spouses born June 1971, both
   * claim in 2038-06 (exactly age 67, so every claiming factor is 1.000 and
   * the arithmetic is about the death, not the claim), and he dies 2040-07.
   *
   * Her survivor benefit starts on the plan's own claim date floored at the
   * death and at age 60 — here that is the death month, 2040-07, because she
   * had already claimed. That default is deliberate: a death event must not
   * silently rewrite a claiming decision the user made on purpose.
   */
  const claims: ScenarioEvent[] = [
    { type: 'claim_social_security', person: 'p1', date: '2038-06' },
    { type: 'claim_social_security', person: 'p2', date: '2038-06' },
  ];
  const death: ScenarioEvent = { type: 'death', person: 'p1', date: '2040-07' };

  it('1.5 x PIA becomes 1.0 x PIA — the household loses a third, permanently', () => {
    /*
     * He has a 4,000 PIA and she has no record of her own, so she draws a 50%
     * spousal benefit: 4,000 + 2,000 = 6,000/mo, 72,000/yr.
     *
     * 2038: benefits start in June, so 7 months (June..December):
     *   7 x 6,000 = 42,000.
     * 2039: 12 x 6,000 = 72,000.
     * 2040 (he dies in July): no benefit is payable for the month of death, so
     *   he is paid months 1-6 = 6 x 4,000 = 24,000. Her SPOUSAL benefit dies
     *   with him — it is derivative of a living worker and has nothing left to
     *   derive from — so it pays months 1-6 = 6 x 2,000 = 12,000, and her
     *   SURVIVOR benefit (100% of his PIA, her age 69 is past survivor FRA so
     *   the factor is 1) picks up from July: 6 x 4,000 = 24,000.
     *   Total 24,000 + 12,000 + 24,000 = 60,000.
     * 2041 onward: 12 x 4,000 = 48,000 — exactly two thirds of 72,000.
     */
    const p = household({
      people: [
        person('p1', {
          hasOwnBenefit: true,
          piaMonthlyAtFraIfWorkingTo62: 4_000,
          piaMonthlyAtFraIfStoppingNow: 4_000,
        }),
        person('p2'),
      ],
    });
    const h = prepared(p, [...claims, death]);
    expect(h.ssGrossRealByYear[yearIndex(2038)]).toBeCloseTo(42_000, 6);
    expect(h.ssGrossRealByYear[yearIndex(2039)]).toBeCloseTo(72_000, 6);
    expect(h.ssGrossRealByYear[yearIndex(2040)]).toBeCloseTo(60_000, 6);
    expect(h.ssGrossRealByYear[yearIndex(2041)]).toBeCloseTo(48_000, 6);
    expect(h.ssGrossRealByYear[yearIndex(2041)] / h.ssGrossRealByYear[yearIndex(2039)]).toBeCloseTo(
      2 / 3,
      12,
    );
    expect(h.death?.survivorMonthlyReal).toBeCloseTo(4_000, 9);
    expect(h.death?.survivorClaim).toEqual({ year: 2040, month: 7 });
  });

  it('she is paid the larger of her own and the survivor benefit — NEVER the sum', () => {
    /*
     * POMS RS 00615.020: "a person's benefit amount can never exceed the
     * highest single benefit to which that person is entitled." She has her
     * own 1,200 PIA; he has 4,000.
     *
     * Before: 4,000 + 1,200 = 5,200/mo = 62,400/yr.
     * 2040: he 6 x 4,000 = 24,000. Her own WORKER benefit is hers and does NOT
     *   die with him, so months 1-6 pay 1,200 (6 x 1,200 = 7,200); from July
     *   she takes max(1,200, 4,000) = 4,000 (6 x 4,000 = 24,000).
     *   Total 24,000 + 7,200 + 24,000 = 55,200.
     * 2041: 12 x 4,000 = 48,000. Adding the two would give 62,400 — the single
     *   most valuable Math.max in this engine, worth 14,400 a year of income
     *   that does not exist.
     */
    const p = household({
      people: [
        person('p1', {
          hasOwnBenefit: true,
          piaMonthlyAtFraIfWorkingTo62: 4_000,
          piaMonthlyAtFraIfStoppingNow: 4_000,
        }),
        person('p2', {
          hasOwnBenefit: true,
          piaMonthlyAtFraIfWorkingTo62: 1_200,
          piaMonthlyAtFraIfStoppingNow: 1_200,
        }),
      ],
    });
    const h = prepared(p, [...claims, death]);
    expect(h.ssGrossRealByYear[yearIndex(2039)]).toBeCloseTo(62_400, 6);
    expect(h.ssGrossRealByYear[yearIndex(2040)]).toBeCloseTo(55_200, 6);
    expect(h.ssGrossRealByYear[yearIndex(2041)]).toBeCloseTo(48_000, 6);
    expect(h.ssGrossRealByYear[yearIndex(2041)]).not.toBeCloseTo(62_400, 6);
  });

  it('when HER record is the larger one, the survivor benefit is inert', () => {
    /*
     * The mirror image, and the case that proves the rule is a max and not a
     * substitution. He has 1,000, she has 5,000. His benefit stops; hers is
     * untouched; the survivor benefit off his record (1,000) never beats her
     * own, so the household simply loses his 12,000 a year.
     *
     * 2039: 12 x 6,000 = 72,000.
     * 2040: him 6 x 1,000 = 6,000 + her 12 x 5,000 = 60,000 -> 66,000.
     * 2041: 12 x 5,000 = 60,000.
     */
    const p = household({
      people: [
        person('p1', {
          hasOwnBenefit: true,
          piaMonthlyAtFraIfWorkingTo62: 1_000,
          piaMonthlyAtFraIfStoppingNow: 1_000,
        }),
        person('p2', {
          hasOwnBenefit: true,
          piaMonthlyAtFraIfWorkingTo62: 5_000,
          piaMonthlyAtFraIfStoppingNow: 5_000,
        }),
      ],
    });
    const h = prepared(p, [...claims, death]);
    expect(h.ssGrossRealByYear[yearIndex(2039)]).toBeCloseTo(72_000, 6);
    expect(h.ssGrossRealByYear[yearIndex(2040)]).toBeCloseTo(66_000, 6);
    expect(h.ssGrossRealByYear[yearIndex(2041)]).toBeCloseTo(60_000, 6);
    expect(h.death?.survivorMonthlyReal).toBeCloseTo(1_000, 9);
  });

  it('a widow who has not claimed yet keeps the plan’s date, floored at 60', () => {
    /*
     * THE DESIGN DECISION, made visible rather than buried. A widow already
     * collecting converts in the month of death. One who has NOT claimed has a
     * real decision in front of her — 71.5% at 60 against 100% at survivor FRA
     * — and a death event must not make it for her silently. So the default is
     * the plan's own claim date, floored at the death and at 60.
     *
     * Here he dies in 2033-07, ten months before her 2038-06 claim: her
     * survivor benefit starts on the date the plan already gave her, 2038-06,
     * at which point she is exactly 67 (factor 1.000). Nothing is paid in
     * between — which is the honest answer, and an overridable one.
     */
    const p = household({
      people: [
        person('p1', {
          hasOwnBenefit: true,
          piaMonthlyAtFraIfWorkingTo62: 4_000,
          piaMonthlyAtFraIfStoppingNow: 4_000,
        }),
        person('p2'),
      ],
    });
    const h = prepared(p, [...claims, { type: 'death', person: 'p1', date: '2033-07' }]);
    expect(h.death?.survivorClaim).toEqual({ year: 2038, month: 6 });
    expect(h.ssGrossRealByYear[yearIndex(2034)]).toBe(0); // nobody is drawing
    expect(h.ssGrossRealByYear[yearIndex(2038)]).toBeCloseTo(7 * 4_000, 6);

    // Overridden: she takes it at the earliest possible moment instead. Her
    // age in 2031-06 is exactly 60, so the factor is 0.715 and the benefit is
    // 4,000 x 0.715 = 2,860/mo — and it is FROZEN there for life, because a
    // survivor benefit earns no delayed credits for her own delay.
    const early = prepared(p, [
      ...claims,
      { type: 'death', person: 'p1', date: '2031-01', survivorClaim: '2031-06' },
    ]);
    expect(early.death?.survivorMonthlyReal).toBeCloseTo(2_860, 9);
    expect(early.ssGrossRealByYear[yearIndex(2031)]).toBeCloseTo(7 * 2_860, 6);
    expect(early.ssGrossRealByYear[yearIndex(2032)]).toBeCloseTo(12 * 2_860, 6);
    expect(early.ssGrossRealByYear[yearIndex(2045)]).toBeCloseTo(12 * 2_860, 6);
  });

  it('a survivor claim before 60 is floored, not honoured', () => {
    // There is no entitlement at all below 60, so an over-eager scenario gets
    // the earliest legal date rather than an illegal factor.
    const p = household({
      people: [
        person('p1', {
          hasOwnBenefit: true,
          piaMonthlyAtFraIfWorkingTo62: 4_000,
          piaMonthlyAtFraIfStoppingNow: 4_000,
        }),
        person('p2'),
      ],
    });
    const h = prepared(p, [
      ...claims,
      { type: 'death', person: 'p1', date: '2029-01', survivorClaim: '2029-02' },
    ]);
    expect(h.death?.survivorClaim).toEqual({ year: 2031, month: 6 }); // her 60th birthday
    expect(h.death?.survivorMonthlyReal).toBeCloseTo(2_860, 9);
  });

  it('the $255 lump sum is paid once, in the death year, and never indexed', () => {
    const h = prepared(household(), [{ type: 'death', person: 'p1', date: '2035-07' }]);
    expect(h.ssLumpSumByYear[yearIndex(2035)]).toBe(255);
    expect(h.ssLumpSumByYear.reduce((a, b) => a + b, 0)).toBe(255);
  });
});

// ---------------------------------------------------------------------------
// 3. Accounts: spousal rollover, her RMD schedule, the step-up
// ---------------------------------------------------------------------------

describe('his IRA becomes HER IRA — not an inherited one on the 10-year rule', () => {
  /**
   * THE MOST VALUABLE LINE IN THE ACCOUNT HANDLING, and the one whose absence
   * would be hardest to spot: an inherited IRA is emptied under the 10-year
   * rule, forcing a decade of large distributions through a widow's compressed
   * single brackets. A surviving SPOUSE — and only a spouse — may instead
   * treat it as HER OWN, on HER required-distribution schedule.
   *
   * The fixture makes the difference impossible to miss by giving the spouses
   * twenty years between them: he is born 1951 (75 in 2026, so his RMDs are
   * already running at the start of the sim) and she is born 1971 (75 in
   * 2046). He dies in 2030. If the account became hers, RMDs STOP for fifteen
   * years and resume in 2046. If it had become an inherited IRA, it would be
   * empty by 2040.
   *
   * Savings covers the spending so the IRA is touched by nothing but RMDs, and
   * autoSepp is off so the automatic 72(t) bridge cannot muddy the picture.
   */
  const spouses = [
    person('p1', { birthYear: 1951 }),
    person('p2', { birthYear: 1971 }),
  ];
  const accounts: Account[] = [
    account({
      id: 'ira-his',
      type: 'traditional_ira',
      owner: 'p1',
      balance: 1_000_000,
      allocation: { stocks: 0, bonds: 0, bills: 1 },
    }),
    account({
      id: 'savings',
      type: 'savings',
      owner: 'joint',
      balance: 3_000_000,
      allocation: { stocks: 0, bonds: 0, bills: 1 },
    }),
  ];
  const scenario: Scenario = {
    name: 'rollover',
    autoSepp: false,
    events: [{ type: 'death', person: 'p1', date: '2030-07' }],
  };

  it('RMDs run on HIS age, stop when he dies, and resume on HERS at 75', () => {
    const rows = run(
      household({ people: spouses, accounts, annualLiving: 90_000 }),
      scenario,
    ).referencePath;
    // He is 75 in 2026 (the shipped rmdStartAge), so RMDs are running from the
    // first year of the sim: 1,000,000 / 24.6 = 40,650.41 in 2026, on the
    // uniform lifetime divisor for age 75.
    expect(rowFor(rows, 2026).withdrawals.rmd).toBeCloseTo(1_000_000 / 24.6, 6);
    for (const y of [2027, 2028, 2029]) {
      expect(rowFor(rows, y).withdrawals.rmd).toBeGreaterThan(0);
    }
    /*
     * From the DEATH YEAR the account is hers and she is 59. Sixteen years of
     * nothing, then 2046 when she turns 75.
     *
     * Note the boundary: the handover runs at the top of the death year,
     * BEFORE anything reads balances or ages, so 2030 itself already sits on
     * her schedule. In real law the decedent's year-of-death RMD still has to
     * come out — the engine skips it. It is one year of forced income on one
     * account, it makes the survivor look very slightly better rather than
     * worse, and it is called out here rather than left for someone to
     * discover in a trace.
     */
    for (let y = 2030; y <= 2045; y++) {
      expect(rowFor(rows, y).withdrawals.rmd).toBe(0);
    }
    // 2046: she turns 75 and her own schedule starts.
    expect(rowFor(rows, 2046).withdrawals.rmd).toBeGreaterThan(0);
    expect(rowFor(rows, 2046).agesAtYearEnd[1]).toBe(75);
  });

  it('and the account is NOT drained in ten years', () => {
    const rows = run(
      household({ people: spouses, accounts, annualLiving: 90_000 }),
      scenario,
    ).referencePath;
    // An inherited IRA opened by a 2030 death must be empty by the end of
    // 2040. Hers still holds most of its money — the whole point.
    expect(rowFor(rows, 2040).balances.byAccount['ira-his']).toBeGreaterThan(900_000);
    expect(rowFor(rows, 2045).balances.byAccount['ira-his']).toBeGreaterThan(900_000);
  });

  it('his 401(k) is re-typed to an IRA of hers rather than left a plan account', () => {
    /*
     * A 401(k) belongs to an employment relationship that ended with him. The
     * rollover re-types it, which is observable here through the SAME RMD
     * schedule test: a 401(k) she does not own would keep answering to his
     * age (or to nobody), and the balance would behave differently. Both
     * pretax accounts go quiet together from 2031 and both wake in 2046.
     */
    const withPlan: Account[] = [
      ...accounts,
      account({
        id: 'k401-his',
        type: '401k',
        owner: 'p1',
        balance: 400_000,
        allocation: { stocks: 0, bonds: 0, bills: 1 },
      }),
    ];
    const rows = run(
      household({ people: spouses, accounts: withPlan, annualLiving: 90_000 }),
      scenario,
    ).referencePath;
    // 2029, both pretax accounts on his schedule: 1,000,000/24.6-ish from the
    // IRA plus 400,000-ish from the 401(k), so the RMD is markedly larger than
    // the IRA-only fixture above.
    expect(rowFor(rows, 2029).withdrawals.rmd).toBeGreaterThan(
      run(household({ people: spouses, accounts, annualLiving: 90_000 }), scenario).referencePath[3]
        .withdrawals.rmd,
    );
    for (let y = 2030; y <= 2045; y++) {
      expect(rowFor(rows, y).withdrawals.rmd).toBe(0);
    }
    expect(rowFor(rows, 2046).withdrawals.rmd).toBeGreaterThan(0);
    expect(rowFor(rows, 2045).balances.byAccount['k401-his']).toBeGreaterThan(350_000);
  });

  it('taxable holdings step up in full when solely his, by half when joint (IRC 2040(b))', () => {
    /*
     * IRC 1014(a)(1) and (b)(9): property included in the decedent's gross
     * estate takes a basis of its fair market value at death. A solely-owned
     * holding is included in full; a spousal JOINT account is a "qualified
     * joint interest" of which IRC 2040(b) includes exactly ONE HALF. Virginia
     * is not a community-property state, so the full step-up of IRC 1014(b)(6)
     * does not apply — a household that moved to one would get more than this.
     *
     * THE FIXTURE IS BUILT SO THE UNREALIZED GAIN NEVER MOVES. The brokerage
     * starts at 500,000 on a 100,000 basis and holds bills; its balance does
     * grow, but only through the surplus sweep, which adds cash to BOTH
     * balance and basis (cash entering a brokerage is basis). So the
     * unrealized gain is 400,000 on the day of the death, exactly as it was on
     * day one, and the arithmetic is clean:
     *
     *   nobody dies:  basis untouched          -> realized gain 400,000
     *   solely his:   basis steps up in full   -> realized gain 0
     *   joint:        basis steps up by half   -> realized gain 200,000
     *
     * Three runs, identical but for the user field and the death, each forced
     * to liquidate the whole brokerage in 2031 by a one-time expense larger
     * than the portfolio. The death carries livingFraction 1 so spending is
     * the same in all three and the sale proceeds really are identical.
     */
    const brokerage = (owner: string): Account[] => [
      account({
        id: 'brok',
        type: 'taxable_brokerage',
        owner,
        balance: 500_000,
        costBasis: 100_000,
        allocation: { stocks: 0, bonds: 0, bills: 1 },
      }),
      account({
        id: 'savings',
        type: 'savings',
        owner: 'joint',
        balance: 500_000,
        allocation: { stocks: 0, bonds: 0, bills: 1 },
      }),
    ];
    const liquidation: ScenarioEvent = {
      type: 'one_time_expense',
      date: '2031-06',
      amount: 5_000_000,
    };
    const death: ScenarioEvent = {
      type: 'death',
      person: 'p1',
      date: '2030-07',
      livingFraction: 1,
    };
    const gainIn2031 = (owner: string, events: ScenarioEvent[]): number => {
      const rows = run(
        household({ accounts: brokerage(owner), annualLiving: 12_000, horizonAge: 62 }),
        { name: 'step-up', autoSepp: false, events },
      ).referencePath;
      // Everything really was sold, so the proceeds are the same in all three.
      expect(rowFor(rows, 2031).balances.byAccount['brok']).toBeCloseTo(0, 6);
      return rowFor(rows, 2031).withdrawals.realizedLtcg;
    };

    const noDeath = gainIn2031('p1', [liquidation]);
    const sole = gainIn2031('p1', [death, liquidation]);
    const joint = gainIn2031('joint', [death, liquidation]);

    // The gain that was there to step up: 500,000 - 100,000.
    expect(noDeath).toBeCloseTo(400_000, 6);
    // Full step-up on a solely-owned holding: nothing left to tax.
    expect(sole).toBeCloseTo(0, 6);
    // Half on a spousal joint interest — IRC 2040(b), to the dollar.
    expect(joint).toBeCloseTo(200_000, 6);
    // Stated as the identity, so the point survives a change of fixture:
    // a joint account gets exactly half the relief a solely-owned one does.
    expect(joint).toBeCloseTo((noDeath + sole) / 2, 6);
  });
});

// ---------------------------------------------------------------------------
// 4. Term life
// ---------------------------------------------------------------------------

describe('term life pays inside the term and nothing outside it', () => {
  /**
   * The user's actual question: "five years of term at retirement that gets
   * her to 90+, then dropped." Answering it means the model has to charge the
   * premium, pay the benefit while the term runs, and pay NOTHING the month
   * after it lapses.
   */
  const policy = {
    lifeInsuranceMonthly: 320,
    lifeInsuranceDeathBenefit: 1_000_000,
    lifeInsuranceTermEnd: '2032-06',
  };

  it('a death inside the term pays the face amount into savings', () => {
    const h = prepared(household(policy), [{ type: 'death', person: 'p1', date: '2030-07' }]);
    expect(h.death?.lifeInsuranceBenefit).toBe(1_000_000);
    expect(h.lifeInsuranceBenefitByYear[yearIndex(2030)]).toBe(1_000_000);
    expect(h.lifeInsuranceBenefitByYear.reduce((a, b) => a + b, 0)).toBe(1_000_000); // once
  });

  it('a death in the LAST covered month still pays; the next month does not', () => {
    // The term ends 2032-06 INCLUSIVE. This is the boundary the user's whole
    // question turns on, so it is asserted on both sides of the same month.
    const inside = prepared(household(policy), [
      { type: 'death', person: 'p1', date: '2032-06' },
    ]);
    expect(inside.death?.lifeInsuranceBenefit).toBe(1_000_000);
    const outside = prepared(household(policy), [
      { type: 'death', person: 'p1', date: '2032-07' },
    ]);
    expect(outside.death?.lifeInsuranceBenefit).toBe(0);
    expect(outside.lifeInsuranceBenefitByYear.every((x) => x === 0)).toBe(true);
  });

  it('the premium stops with the term, and stops early if the insured dies first', () => {
    // Premium months: 12 a year through 2031, 6 in 2032 (term ends in June),
    // 0 after. And if he dies in 2030-07 the policy ends with him — months
    // 1..6 of 2030 and nothing thereafter, because from there the BENEFIT
    // takes over. The schedule is a DOLLAR figure rather than a month count
    // now that a household can hold several policies at different premiums.
    const alive = prepared(household(policy), []);
    expect(alive.lifeInsurancePremiumRealByYear[yearIndex(2031)]).toBe(320 * 12);
    expect(alive.lifeInsurancePremiumRealByYear[yearIndex(2032)]).toBe(320 * 6);
    expect(alive.lifeInsurancePremiumRealByYear[yearIndex(2033)]).toBe(0);

    const dies = prepared(household(policy), [{ type: 'death', person: 'p1', date: '2030-07' }]);
    expect(dies.lifeInsurancePremiumRealByYear[yearIndex(2030)]).toBe(320 * 6);
    expect(dies.lifeInsurancePremiumRealByYear[yearIndex(2031)]).toBe(0);
  });

  it('with NO term end the policy lives only as long as the paycheck (the old rule)', () => {
    /*
     * The pre-existing behaviour, preserved exactly: term life is income
     * replacement, so with no explicit term the premium is charged for the
     * months somebody worked and a death after the last worked month is a
     * death after the policy lapsed. Every profile written before the term
     * fields existed keeps its numbers.
     */
    const noTerm = {
      lifeInsuranceMonthly: 320,
      lifeInsuranceDeathBenefit: 1_000_000,
      salaries: { p1: 200_000, p2: 0 },
    };
    const retire: ScenarioEvent = { type: 'retire', person: 'p1', date: '2030-07' };
    // Dies in June 2030, the last month he draws a salary: covered.
    const working = prepared(household(noTerm), [
      retire,
      { type: 'death', person: 'p1', date: '2030-06' },
    ]);
    expect(working.death?.lifeInsuranceBenefit).toBe(1_000_000);
    // Dies in August 2030, after the paycheck stopped: not covered.
    const retired = prepared(household(noTerm), [
      retire,
      { type: 'death', person: 'p1', date: '2030-08' },
    ]);
    expect(retired.death?.lifeInsuranceBenefit).toBe(0);
  });

  it('a premium with no face amount buys nothing — the pre-field behaviour', () => {
    // ABSENT MEANS 0. A profile that names only lifeInsuranceMonthly is money
    // leaving the household that buys nothing, which is exactly what the model
    // did before the benefit field existed.
    const h = prepared(household({ lifeInsuranceMonthly: 320 }), [
      { type: 'death', person: 'p1', date: '2027-07' },
    ]);
    expect(h.death?.lifeInsuranceBenefit).toBe(0);
  });

  it('the payout is NOT income: it raises no AGI and no MAGI variant', () => {
    /*
     * IRC 101(a)(1) — "gross income does not include amounts received ...
     * under a life insurance contract, if such amounts are paid by reason of
     * the death of the insured" — with no dollar cap and no filing-status
     * condition. So a million dollars arriving cannot push her over the ACA
     * cliff, into an IRMAA tier, into NIIT, or make more of her Social
     * Security taxable.
     *
     * Two runs identical but for the face amount. The death year's AGI and
     * every MAGI variant must be IDENTICAL; only the balance sheet moves.
     */
    const withCover = run(household({ ...policy }), {
      name: 'insured',
      events: [{ type: 'death', person: 'p1', date: '2030-07' }],
    }).referencePath;
    const without = run(household({ lifeInsuranceMonthly: 320, lifeInsuranceTermEnd: '2032-06' }), {
      name: 'uninsured',
      events: [{ type: 'death', person: 'p1', date: '2030-07' }],
    }).referencePath;

    const a = rowFor(withCover, 2030);
    const b = rowFor(without, 2030);
    expect(a.survivor?.lifeInsuranceBenefit).toBe(1_000_000);
    expect(b.survivor?.lifeInsuranceBenefit).toBe(0);
    expect(a.taxes.federal.agi).toBeCloseTo(b.taxes.federal.agi, 6);
    expect(a.taxes.magi.acaMagi).toBeCloseTo(b.taxes.magi.acaMagi, 6);
    expect(a.taxes.magi.irmaaMagi).toBeCloseTo(b.taxes.magi.irmaaMagi, 6);
    expect(a.taxes.magi.niitMagi).toBeCloseTo(b.taxes.magi.niitMagi, 6);
    expect(a.taxes.totalTax).toBeCloseTo(b.taxes.totalTax, 6);
    // But the money really did arrive: a million more on the balance sheet.
    expect(a.balances.total - b.balances.total).toBeGreaterThan(900_000);
  });

  it('and it is a BALANCE, not spending money — a working-year death does not consume it', () => {
    /*
     * The mechanical trap that would have been a disaster. Routing the benefit
     * through one-time INCOME would have put it in the year's cash, where a
     * WORKING year's leftover is consumed as unbudgeted spending (note 20) —
     * a seven-figure cheque paid to the widow of a man who died with a
     * paycheck would have evaporated in the year it arrived. It lands in
     * savings, like house-sale proceeds, because that is what a cheque from an
     * insurer actually is.
     */
    const rows = run(
      household({
        ...policy,
        salaries: { p1: 200_000, p2: 0 },
        annualLiving: 60_000,
      }),
      { name: 'working-death', events: [{ type: 'death', person: 'p1', date: '2030-07' }] },
    ).referencePath;
    const deathYear = rowFor(rows, 2030);
    expect(deathYear.income.wages).toBeGreaterThan(0); // he really was still earning
    expect(deathYear.unbudgeted).toBeLessThan(200_000); // nowhere near a million
    expect(deathYear.balances.total - rowFor(rows, 2029).balances.total).toBeGreaterThan(900_000);
  });

  it('the policy is overridable per SCENARIO, which is what makes the question askable', () => {
    /*
     * "Five years of term at retirement" is a question about a PLAN, not a
     * fact about the household: two scenarios must be able to disagree about
     * the policy at the same time. This is also the regression test for a real
     * bug — simulate.ts rebuilds ProfileExpenses field by field when a
     * scenario carries an expenses override, and it silently DROPPED the new
     * policy fields, so the widow score came back byte-identical with and
     * without a million dollars of cover.
     */
    const bare = household(); // no policy at all in the profile
    const events: ScenarioEvent[] = [{ type: 'death', person: 'p1', date: '2030-07' }];
    const plain = run(bare, { name: 'no-term', events }).referencePath;
    const insured = run(bare, {
      name: 'buy-term',
      events,
      assumption_overrides: {
        expenses: {
          lifeInsuranceMonthly: 320,
          lifeInsuranceDeathBenefit: 1_000_000,
          lifeInsuranceTermEnd: '2032-06',
        },
      },
    }).referencePath;
    expect(rowFor(plain, 2030).survivor?.lifeInsuranceBenefit).toBe(0);
    expect(rowFor(insured, 2030).survivor?.lifeInsuranceBenefit).toBe(1_000_000);
    expect(
      rowFor(insured, 2030).balances.total - rowFor(plain, 2030).balances.total,
    ).toBeGreaterThan(900_000);
  });
});

// ---------------------------------------------------------------------------
// 5. The widow penalty inside a real run
// ---------------------------------------------------------------------------

describe('THE WIDOW PENALTY inside a run: same portfolio, same draw, more tax', () => {
  /**
   * The tax module proves the penalty on hand-built inputs. This proves the
   * ENGINE actually delivers those inputs — that the status, the head-count
   * and the survivor's benefit all arrive at computeYear together.
   *
   * The comparison is the cleanest one available: the same household, the same
   * IRA, the same withdrawals, in the year AFTER a death versus the same year
   * with nobody dead. Social Security is deliberately absent from this
   * fixture so the ONLY difference is the filing change — the benefit cut is
   * real but it is a different effect, tested in section 2.
   */
  const people = [
    person('p1', { birthYear: 1971 }),
    person('p2', { birthYear: 1971 }),
  ];
  const accounts: Account[] = [
    account({
      id: 'ira',
      type: 'traditional_ira',
      owner: 'p1',
      balance: 5_000_000,
      allocation: { stocks: 0, bonds: 0, bills: 1 },
    }),
    account({
      id: 'savings',
      type: 'savings',
      owner: 'joint',
      balance: 100_000,
      allocation: { stocks: 0, bonds: 0, bills: 1 },
    }),
  ];
  const profile = household({ people, accounts, annualLiving: 180_000, horizonAge: 80 });

  it('the survivor’s year pays materially more tax on a comparable draw', () => {
    const alive = run(profile, { name: 'both alive', autoSepp: false, events: [] }).referencePath;
    const widowed = run(profile, {
      name: 'he dies 2040',
      autoSepp: false,
      events: [{ type: 'death', person: 'p1', date: '2040-07' }],
    }).referencePath;

    const a = rowFor(alive, 2041);
    const w = rowFor(widowed, 2041);
    /*
     * She is the only one left, so the living cost falls to 75% of the
     * couple's: 180,000 x 1.025^15 = 260,693.42 becomes 195,520.06. She draws
     * LESS from the IRA — 277,541 against 342,052 — and still pays a higher
     * rate on every dollar of it, because 17,350-odd of deduction went with
     * him and her brackets compress far sooner.
     */
    expect(w.expenses.baseline).toBeCloseTo(a.expenses.baseline * DEFAULT_SURVIVOR_LIVING_FRACTION, 6);
    expect(a.expenses.baseline).toBeCloseTo(180_000 * 1.025 ** 15, 4);
    expect(w.withdrawals.pretax).toBeLessThan(a.withdrawals.pretax);
    expect(w.taxes.federal.standardDeduction).toBeLessThan(a.taxes.federal.standardDeduction);
    // The rate on what she does draw is the story: 23.4% against 19.7%.
    const rate = (r: YearRow) => r.taxes.federal.total / r.taxes.federal.agi;
    expect(rate(w)).toBeGreaterThan(rate(a) * 1.15);
    expect(w.survivor?.filingStatus).toBe('single');
    expect(a.survivor).toBeUndefined();
  });

  it('and the same draw, forced equal, costs her strictly more', () => {
    /*
     * The comparison above lets spending fall with the household, which is
     * realistic but muddies the tax question. Here the living fraction is
     * pinned at 1 — a survivor whose costs do not fall at all — so the two
     * runs draw the same money and the ONLY difference left is the return she
     * files it on.
     */
    const alive = run(profile, { name: 'both alive', autoSepp: false, events: [] }).referencePath;
    const widowed = run(profile, {
      name: 'he dies 2040, costs unchanged',
      autoSepp: false,
      events: [{ type: 'death', person: 'p1', date: '2040-07', livingFraction: 1 }],
    }).referencePath;
    const a = rowFor(alive, 2041);
    const w = rowFor(widowed, 2041);
    expect(w.expenses.baseline).toBeCloseTo(a.expenses.baseline, 6);
    // 67,490 becomes 99,267 — nearly 32,000 a year of tax on identical
    // spending, and she has to draw 35,000 more from the IRA to pay it, which
    // is why the gap is bigger than the tax-table gap alone.
    expect(w.taxes.totalTax).toBeGreaterThan(a.taxes.totalTax * 1.4);
    expect(w.withdrawals.pretax).toBeGreaterThan(a.withdrawals.pretax);
    // And it compounds: her portfolio is smaller every year after, purely
    // from the tax.
    expect(rowFor(widowed, 2045).balances.total).toBeLessThan(rowFor(alive, 2045).balances.total);
  });

  it('the living fraction defaults to 0.75 and is overridable, as an assumption should be', () => {
    // There is no primary source for this number and there cannot be — it is a
    // judgment about one household's consumption. 0.75 sits at the high end of
    // the OECD-modified (0.67) / square-root (0.71) / planning-practice
    // (0.70-0.80) range, on purpose: spending more of her money reports a
    // LOWER widow score, which is the conservative direction.
    expect(DEFAULT_SURVIVOR_LIVING_FRACTION).toBe(0.75);
    const h = prepared(household(), [{ type: 'death', person: 'p1', date: '2035-07' }]);
    // The death year blends by month: 6 months at 1 and 6 at 0.75.
    expect(h.livingFactorByYear[yearIndex(2035)]).toBeCloseTo((6 + 6 * 0.75) / 12, 12);
    expect(h.livingFactorByYear[yearIndex(2036)]).toBe(0.75);
    const thrifty = prepared(household(), [
      { type: 'death', person: 'p1', date: '2035-07', livingFraction: 0.6 },
    ]);
    expect(thrifty.livingFactorByYear[yearIndex(2036)]).toBe(0.6);
  });
});

// ---------------------------------------------------------------------------
// 6. One-person ACA and IRMAA after the death
// ---------------------------------------------------------------------------

describe('after the death the household is ONE person to the ACA and to Medicare', () => {
  it('the ACA cliff is computed against the one-person FPL from the year after', () => {
    /*
     * Quite possibly the biggest line in a widow score for a household that
     * retires in its mid-fifties: nine years on the exchange, and the 400%
     * cliff for one person is 62,600 of MAGI against 84,600 for the couple.
     *
     * The fixture draws enough to sit BETWEEN the two cliffs — comfortably
     * under the couple's, hopelessly over hers. So the death year (still a
     * joint return) keeps the credit and the very next year forfeits all of
     * it. Ages 56/57 in 2027/2028, so both are on the exchange.
     */
    const accounts: Account[] = [
      account({
        id: 'ira',
        type: 'traditional_ira',
        owner: 'p1',
        balance: 3_000_000,
        allocation: { stocks: 0, bonds: 0, bills: 1 },
      }),
      account({
        id: 'savings',
        type: 'savings',
        owner: 'joint',
        balance: 50_000,
        allocation: { stocks: 0, bonds: 0, bills: 1 },
      }),
    ];
    const rows = run(
      household({
        accounts,
        annualLiving: 60_000,
        acaBenchmarkMonthly: 1_572,
        horizonAge: 62,
      }),
      { name: 'aca widow', autoSepp: false, events: [{ type: 'death', person: 'p1', date: '2028-07' }] },
    ).referencePath;

    const deathYear = rowFor(rows, 2028);
    const after = rowFor(rows, 2029);
    // Both years are full ACA years — nobody is 65 and nobody works.
    expect(deathYear.taxes.aca?.enrolled).toBe(true);
    expect(after.taxes.aca?.enrolled).toBe(true);

    // 2028 is still a JOINT return on a two-person poverty level: MAGI 78,484
    // against a cliff of 4 x 21,150 x 1.0506 = 88,882, so the credit stands.
    expect(deathYear.taxes.magi.acaMagi).toBeLessThan(
      4 * 21_150 * deathYear.inflationIndex,
    );
    expect(deathYear.taxes.aca?.cliffApplied).toBe(false);
    expect(deathYear.taxes.aca!.ptc).toBeGreaterThan(0);

    // 2029 is one person: MAGI 80,970 against a cliff of 4 x 15,650 x 1.0769 =
    // 67,414. Nine thousand dollars UNDER the couple's cliff is thirteen
    // thousand OVER hers, and the entire credit is forfeited — the same
    // withdrawal, the same coverage, a different household size.
    expect(after.taxes.magi.acaMagi).toBeGreaterThan(4 * 15_650 * after.inflationIndex);
    expect(after.taxes.magi.acaMagi).toBeLessThan(4 * 21_150 * after.inflationIndex);
    expect(after.taxes.aca?.cliffApplied).toBe(true);
    expect(after.taxes.aca!.ptc).toBe(0);
    expect(after.flags).toContain('aca-cliff');

    // The denominator really is the one-person FPL, not the couple's.
    expect(after.taxes.aca!.fplPct).toBeCloseTo(
      after.taxes.magi.acaMagi / (15_650 * after.inflationIndex),
      9,
    );
    expect(deathYear.taxes.aca!.fplPct).toBeCloseTo(
      deathYear.taxes.magi.acaMagi / (21_150 * deathYear.inflationIndex),
      9,
    );

    // And she is charged for one person, not two: the engine scales the
    // household's own benchmark quote by her share of it. Not exactly half,
    // because the quote also carries a year of medical inflation and a year of
    // the age curve — hence the band rather than an equality.
    const premiumRatio = after.taxes.aca!.grossPremium / deathYear.taxes.aca!.grossPremium;
    expect(premiumRatio).toBeGreaterThan(0.5);
    expect(premiumRatio).toBeLessThan(0.6);
  });

  it('Medicare is billed for one enrollee, on the single IRMAA tier table', () => {
    /*
     * Two things move at once from the first full year after the death, and
     * they push opposite ways: the household pays for ONE Part B instead of
     * two, and the surcharge is looked up on the single tier table, whose
     * first threshold is 109,000 instead of 218,000. IRMAA reads MAGI from two
     * years prior, so the income from their last JOINT years follows her into
     * her first single ones.
     *
     * The fixture draws enough for the lookback MAGI to sit between the two
     * tier-1 thresholds: no surcharge while they file jointly, tier 1 the
     * moment she files alone.
     */
    const accounts: Account[] = [
      account({
        id: 'ira',
        type: 'traditional_ira',
        owner: 'p1',
        balance: 5_000_000,
        allocation: { stocks: 0, bonds: 0, bills: 1 },
      }),
      account({
        id: 'savings',
        type: 'savings',
        owner: 'joint',
        balance: 50_000,
        allocation: { stocks: 0, bonds: 0, bills: 1 },
      }),
    ];
    const profile = household({
      accounts,
      annualLiving: 150_000,
      partDPlanMonthly: 45,
      horizonAge: 72,
    });
    // Two runs of the SAME year, so premium indexing and the age curve cancel
    // and the only difference left is the household.
    const alive = run(profile, { name: 'both alive', autoSepp: false, events: [] }).referencePath;
    const widowed = run(profile, {
      name: 'irmaa widow',
      autoSepp: false,
      events: [{ type: 'death', person: 'p1', date: '2039-07', livingFraction: 1 }],
    }).referencePath;

    const a = rowFor(alive, 2040);
    const w = rowFor(widowed, 2040);
    expect(a.taxes.medicare).not.toBeNull();
    expect(w.taxes.medicare).not.toBeNull();
    // Two enrollees become one: the base Part B premium halves, exactly.
    expect(w.taxes.medicare!.partB).toBeCloseTo(a.taxes.medicare!.partB / 2, 6);
    // And the surcharge lands on her. The couple cleared every joint
    // threshold; on the single table the same money is several tiers in, and
    // the lookback means it is their LAST JOINT YEARS' income doing it.
    expect(a.taxes.medicare!.tierIndex).toBe(0);
    expect(a.taxes.medicare!.irmaaPartB).toBe(0);
    expect(w.taxes.medicare!.tierIndex).toBeGreaterThan(0);
    expect(w.taxes.medicare!.irmaaPartB).toBeGreaterThan(0);
    // The surcharge on one person outweighs the whole saving from dropping the
    // second enrollee: her Medicare bill is HIGHER than the couple's was.
    expect(w.taxes.medicare!.total).toBeGreaterThan(a.taxes.medicare!.total);
  });
});

// ---------------------------------------------------------------------------
// 7. The guard
// ---------------------------------------------------------------------------

describe('without a death, every survivor schedule is exactly the no-op value', () => {
  it('null death, factors of 1, addends of 0 — checkable by inspection', () => {
    /*
     * The yearly loop multiplies by livingFactorByYear and adds
     * lifeInsuranceBenefitByYear unconditionally, with no `if (death)` around
     * them. That is deliberate: a multiplier of 1 and an addend of 0 are the
     * cheapest possible guarantee that nothing about a plan without a death
     * can change, and there is no second code path to keep honest. This test
     * is the guarantee stated out loud.
     */
    const h = prepared(household({ lifeInsuranceMonthly: 320, lifeInsuranceDeathBenefit: 1_000_000 }), [
      { type: 'retire', person: 'p1', date: '2030-07' },
    ]);
    expect(h.death).toBeNull();
    expect(h.filingByYear.every((s) => s === 'mfj')).toBe(true);
    expect(h.taxPeopleByYear.every((p) => p.length === 2)).toBe(true);
    expect(h.livingFactorByYear.every((x) => x === 1)).toBe(true);
    expect(h.acaBenchmarkFactorByYear.every((x) => x === 1)).toBe(true);
    expect(h.lifeInsuranceBenefitByYear.every((x) => x === 0)).toBe(true);
    expect(h.ssLumpSumByYear.every((x) => x === 0)).toBe(true);
  });

  it('and no YearRow carries a survivor block', () => {
    const rows = run(household(), { name: 'ordinary', events: [] }).referencePath;
    expect(rows.every((r) => r.survivor === undefined)).toBe(true);
    expect(rows.every((r) => !r.flags.includes('death') && !r.flags.includes('survivor'))).toBe(
      true,
    );
  });
});

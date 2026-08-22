/**
 * THE HEADLINE PROPERTY OF THE SURVIVOR WORK: adding single-filer support
 * changed NOTHING about a married-filing-jointly run.
 *
 * That claim is easy to make and easy to get wrong. `FilingStatus` went from a
 * one-member union to two, and the widening reached into the ordinary bracket
 * table, the standard deduction, the 65+ add-on, the LTCG breakpoints, the
 * NIIT threshold, the Social Security provisional worksheet, the non-itemizer
 * charitable cap, the §121 exclusion, the IRMAA tier table, the ACA federal
 * poverty level, all three state modules, the household preparation, the
 * yearly loop and the profile-override rebuild. Every one of those is a place
 * where a resolver could quietly pick the wrong table, or a trace line could
 * gain a suffix, or a new multiplier could be 0.999999 instead of 1.
 *
 * So this file does not ASSERT the property, it PINS it. Each digest below was
 * produced by running that exact fixture against commit 93d3c90 ("feat(expenses):
 * life insurance as its own stream, ending with the paycheck") — the commit
 * immediately BEFORE `FilingStatus` gained 'single', where src/shared/types.ts
 * still reads `export type FilingStatus = 'mfj'` and ENGINE_VERSION is 1.8.0 —
 * with this file copied verbatim into a clean `git archive` extract of that
 * tree. They are genuine before/after hashes, not snapshots of whatever the
 * current code happens to do, which is the only kind of hash worth having here.
 *
 * WHAT IS HASHED: everything arithmetic. Success, the fan, the median
 * terminal, the shortfall histogram, the charitable legacy, the break-glass
 * figure, and the entire reference path INCLUDING ITS TAX TRACES.
 *
 * WHAT IS NOT, and why it would be wrong to include it: `meta` and
 * `elapsedMs`. `elapsedMs` is a wall clock. `meta` carries `engineVersion` and
 * `runKey`, and BOTH ARE SUPPOSED TO HAVE MOVED — the project's hard rule is
 * that any edit under src/engine bumps ENGINE_VERSION precisely so the run
 * cache cannot serve a stale answer, and the key is a hash of that constant
 * plus the input. `meta.hashes.assumptions` moved too, because the data files
 * gained single-filer tables. Hashing those here would make this pin fail for
 * the one reason that is not a regression, and a pin that fails on purpose is
 * a pin nobody reads. tests/shared/engineVersion.test.ts is what guards the
 * version bump; this file guards the numbers.
 *
 * The traces are the strict part of what IS hashed. A status annotation
 * appended to "Federal income tax (2041)"
 * would not move a single number and would still fail this file, which is
 * exactly right: the three other pinned path digests in this suite
 * (housingPlan.test.ts, simulate.test.ts x2) would have had to be re-pinned for
 * a cosmetic reason, and re-pinning a golden hash "for a cosmetic reason" is
 * how a real regression gets waved through. Every status annotation in the tax
 * module is therefore a suffix that is EMPTY for MFJ, and this file is what
 * keeps it that way.
 *
 * THE FIXTURES, chosen to cover the paths the survivor work actually touched:
 *
 *  A. a representative shape — retire mid-2027, sell the house, rent, buy in
 *     2028, ACA from 2027, Medicare from 2036, Social Security from 2038, RMDs
 *     from 2046, a $320/mo life-insurance premium, giving for life, 41 years to
 *     age 95. This one path visits nearly every module the widening reached.
 *  B. the same household with an `assumption_overrides.expenses` block — the
 *     field-by-field profile rebuild in simulate.ts, which is where a real bug
 *     lived (it silently dropped the new policy fields, so a widow score came
 *     back identical with and without $1M of cover). A rebuild that drops or
 *     reorders anything shows up here.
 *  C. Monte Carlo, 200 paths, fixed seed — the hot path, where a per-year
 *     multiplier that is 1 only in the deterministic case would show up.
 *  D. South Carolina and North Carolina, because two of the three state
 *     modules gained single-filer deduction resolvers and only one of them is
 *     on the user's path.
 *
 * IF ONE OF THESE FAILS, something changed an MFJ run. Do not re-pin without
 * finding out what: the entire argument that a widow score can be trusted
 * rests on the survivor code being inert until somebody dies.
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
  StateCode,
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
 * A REPRESENTATIVE MFJ HOUSEHOLD, invented but shaped like a real one: two
 * spouses, one salary, a pre-tax IRA and a 401(k) on the earner, a Roth on the
 * other, a joint brokerage, savings and a house. Living $7,275/mo, giving
 * $2,300/mo, life insurance $320/mo.
 *
 * DELIBERATELY NOT read from ~/finance-planner-data: a golden hash must be
 * reproducible from the repo alone, on any machine, forever. A fixture that
 * read a live profile would start failing the day someone edited a balance.
 */
function referenceHousehold(over?: Partial<Profile>): Profile {
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
      lifeInsuranceMonthly: 320,
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
      withdrawalPolicy: { order: ['cash', 'taxable', 'pretax', 'roth'], pretaxPreference: 'ira_first' },
    },
    ...over,
  };
}

/** Retire mid-2027, sell, rent 12 months, buy 2028, both claim at 67 (2038-07). */
const ownerPlan: Scenario = {
  name: 'mfj-reference',
  events: [
    { type: 'retire', person: 'p1', date: '2027-07' },
    { type: 'retire', person: 'p2', date: '2027-07' },
    { type: 'claim_social_security', person: 'p1', date: '2038-07' },
    { type: 'claim_social_security', person: 'p2', date: '2038-07' },
    { type: 'sell_house', date: '2027-08' },
    { type: 'rent', start: '2027-08', months: 12, monthlyCost: 3600 },
    {
      type: 'buy_house',
      date: '2028-08',
      price: 900000,
      financing: 'cash',
      propertyTaxAnnual: 7500,
      insuranceAnnual: 1850,
    },
  ],
};

function simInput(profile: Profile, scenario: Scenario, over?: Partial<SimulationInput>): SimulationInput {
  return {
    profile,
    assumptions: assumptions(),
    scenario,
    mode: 'deterministic',
    paths: 1,
    seed: 20260812,
    ...over,
  };
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
  'AN MFJ RUN MOVED. Adding single-filer support was supposed to leave every ' +
  'joint run bit-for-bit alone — including its tax traces. Find out what ' +
  'changed before touching this pin.';

describe('MFJ is byte-for-byte the pre-survivor engine', () => {
  it('A. a fully-streamed shape: retire 2027, sell, rent, buy, ACA, Medicare, SS, RMDs', () => {
    const res = runSimulation(simInput(referenceHousehold(), ownerPlan));
    // 2026..2066 inclusive — age 95 in 2066.
    expect(res.referencePath).toHaveLength(41);
    // Sanity that the fixture really is visiting the machinery this pin is
    // about, so a future edit cannot make the hash trivially stable by
    // emptying the path.
    expect(res.referencePath.some((r) => r.taxes.aca?.enrolled === true)).toBe(true);
    expect(res.referencePath.some((r) => (r.taxes.medicare?.total ?? 0) > 0)).toBe(true);
    expect(res.referencePath.some((r) => r.income.socialSecurity > 0)).toBe(true);
    expect(res.referencePath.some((r) => r.taxes.trace !== undefined)).toBe(true);
    // Nothing in an ordinary plan may even mention a survivor.
    expect(res.referencePath.every((r) => r.survivor === undefined)).toBe(true);
    expect(runDigest(res), FAIL).toBe(
      'a55547a5d5ef80de033d26bc9542adc8999c6d866cacb9babdd3d30a53a83123',
    );
  });

  it('B. the same household through assumption_overrides.expenses (the rebuild path)', () => {
    /*
     * simulate.ts rebuilds ProfileExpenses FIELD BY FIELD when a scenario
     * carries an expenses override, which is exactly the construction that
     * silently drops a field somebody forgot to copy across. It really did:
     * the new policy fields were dropped, so a widow score came back identical
     * with and without a million dollars of term cover. This pin is the
     * regression test for the MFJ half of that rebuild — every stream the
     * override does NOT name must survive it untouched.
     */
    const scenario: Scenario = {
      ...ownerPlan,
      name: 'mfj-reference-overridden',
      assumption_overrides: {
        expenses: { livingMonthly: 6900, charitableMonthly: 2000 },
      },
    };
    const res = runSimulation(simInput(referenceHousehold(), scenario));
    // baseline = living + the life-insurance premium for the months it is in
    // force (12 in 2026): 6,900 x 12 + 320 x 12 = 86,640. The premium is the
    // field the rebuild dropped in the survivor work's sibling bug, so seeing
    // it survive an override that does not name it is the point.
    expect(res.referencePath[0].expenses.baseline).toBeCloseTo(6900 * 12 + 320 * 12, 8);
    expect(res.referencePath[0].expenses.charitable).toBeCloseTo(2000 * 12, 8);
    expect(runDigest(res), FAIL).toBe(
      'a3e3a80debc2766a2a232cb4ca7a5f8a590e72684a9e8c1932c39c42ac400fbf',
    );
  });

  it('C. Monte Carlo, 200 paths, fixed seed — the hot path', () => {
    const res = runSimulation(
      simInput(referenceHousehold(), ownerPlan, { mode: 'montecarlo', paths: 200, seed: 7 }),
    );
    expect(runDigest(res), FAIL).toBe(
      'bd476cb272e4d023b1593cbff6917a01ce5fe312c0511311084c3bb14db78206',
    );
  });

  it('D. South Carolina and North Carolina, whose state modules also widened', () => {
    // Two of the three state modules grew single-filer deduction resolvers
    // (SC's SCIAD trio, NC's standard deduction); only VA is on the user's
    // path, so without this the other two would be pinned nowhere.
    const forState = (state: StateCode): string => {
      const profile = referenceHousehold();
      profile.filing = { status: 'mfj', state };
      profile.home = { ...profile.home, state };
      return runDigest(runSimulation(simInput(profile, ownerPlan)));
    };
    expect(forState('sc'), FAIL).toBe(
      'c51ae9ad07df43177c65927144c39a5abd44ce36f85a7c56b12c5d1d0a2ffa26',
    );
    expect(forState('nc'), FAIL).toBe(
      '2d42c955d8125240db96e6b7ec82d58a8c90710a29f095e5ae61fa054a80ed6f',
    );
  });
});

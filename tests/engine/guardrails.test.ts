/**
 * THE GUARDRAILS SPENDING POLICY (Guyton-Klinger), engine side.
 *
 * The rule in one sentence: real spending HOLDS CONSTANT while the current
 * withdrawal rate stays inside a band around the rate the plan started at, and
 * moves by `adjustment` when it does not. The holding is the whole point —
 * `fixed_percent` re-prices spending every single year, so a 12% dip cuts the
 * grocery budget 12%, and `fixed_real` spends the same dollars through a 40%
 * crash, which nobody does. Guardrails is what people actually do, and its
 * defining behaviour is the years in which it does NOTHING.
 *
 * Every fixture here is arranged so the portfolio path can be written out by
 * hand: one taxable brokerage, no salary, no housing, no health premiums, no
 * dividends, zero inflation, and a flat real return. So a year is exactly
 * `start - spend`, grown by the fixed rate, and the withdrawal rate the rule
 * reads is a fraction of two numbers on this page. That is deliberate — a
 * spending rule tested against a stochastic path can only be tested for its
 * average, and the average is not where a rule like this goes wrong.
 *
 * Contents:
 *  1. inside the band, nothing happens — and the run is IDENTICAL to fixed_real
 *  2. the upper rail cuts, by exactly `adjustment`, on exactly the right year
 *  3. the lower rail raises
 *  4. the floor holds through a long bad sequence
 *  5. the band is configurable, and DEFAULT_GUARDRAILS is what an absent one means
 *  6. every path tells on itself: RunResult.guardrailStats
 *  7. the spending ceiling (raiseCeiling) — and ceiling-absent bit-identity
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { runSimulation } from '../../src/engine/simulate';
import { loadHistoricalCsv } from '../../src/engine/returns';
import { DEFAULT_GUARDRAILS } from '../../src/shared/types';
import type {
  AcaData,
  Assumptions,
  AssumptionOverrides,
  FederalTaxData,
  MarketAssumptions,
  MedicareData,
  Profile,
  RmdTableData,
  RunResult,
  Scenario,
  SocialSecurityData,
  SpendingPolicy,
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

/** The plan's opening figures, so the arithmetic below reads as arithmetic. */
const PORTFOLIO = 1_500_000;
const LIVING_ANNUAL = 60_000;
/** 60,000 / 1,500,000. Rails at 0.8x and 1.2x of it: 3.2% and 4.8%. */
const OPENING_RATE = LIVING_ANNUAL / PORTFOLIO;

/**
 * A household already retired at the simulation's first year, holding one
 * all-equity taxable brokerage at full basis. No salary (so the plan's opening
 * withdrawal rate is measured in year one), no house, no giving, no investing,
 * and a benchmark ACA quote of 0 — leaving exactly one expense and exactly one
 * account, which is what makes every figure in this file checkable by hand.
 *
 * `horizonAge: 64` stops the run in 2035, the year before Medicare would start
 * charging premiums and add a second moving part.
 */
function household(spendingPolicy: SpendingPolicy): Profile {
  const person = (id: string) => ({
    id,
    name: id.toUpperCase(),
    birthYear: 1971,
    birthMonth: 6,
    piaMonthlyAtFraIfWorkingTo62: 0,
    piaMonthlyAtFraIfStoppingNow: 0,
    hasOwnBenefit: false,
  });
  return {
    people: [person('p1'), person('p2')],
    filing: { status: 'mfj', state: 'va' },
    accounts: [
      {
        id: 'brok',
        name: 'Taxable brokerage',
        type: 'taxable_brokerage',
        owner: 'joint',
        balance: PORTFOLIO,
        // Full basis, so a withdrawal realises no gain and the tax bill stays
        // 0 — the rule under test must not be read through a tax model.
        costBasis: PORTFOLIO,
        allocation: { stocks: 1, bonds: 0, bills: 0 },
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
    expenses: {
      livingMonthly: LIVING_ANNUAL / 12,
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
      horizonAge: 64,
      successTarget: 0.85,
      mcPathsInteractive: 1000,
      mcPathsFinal: 10000,
      seed: 1,
      spendingPolicy,
      withdrawalPolicy: {
        order: ['cash', 'taxable', 'pretax', 'roth'],
        pretaxPreference: 'ira_first',
      },
    },
  };
}

/**
 * A flat real return with zero inflation and no dividend or expense drag, so
 * the portfolio path is `(start - spend) x (1 + rate)` and nothing else.
 */
function flatMarket(realReturn: number): AssumptionOverrides {
  return {
    market: {
      deterministicReal: { stocks: realReturn, bonds: realReturn, bills: realReturn },
      deterministicInflation: 0,
      stockDividendYield: 0,
      expenseRatios: { stocks: 0, bonds: 0, bills: 0 },
      cashYieldNominal: 0,
    },
  };
}

/** The whole RunResult of a flat-market deterministic run (stats live on it). */
function runFor(policy: SpendingPolicy, realReturn: number): RunResult {
  const scenario: Scenario = {
    name: 'guardrails',
    // No bridge to elect and nothing to elect it on; off so the fixture cannot
    // grow a second moving part.
    autoSepp: false,
    events: [],
    assumption_overrides: flatMarket(realReturn),
  };
  return runSimulation({
    profile: household(policy),
    assumptions: assumptions(),
    scenario,
    mode: 'deterministic',
    paths: 1,
    seed: 1,
  });
}

function rows(policy: SpendingPolicy, realReturn: number): YearRow[] {
  return runFor(policy, realReturn).referencePath;
}

const GUARDRAILS: SpendingPolicy = { type: 'guardrails' };
const baselineFor = (rs: YearRow[], year: number): number =>
  rs.find((r) => r.year === year)!.expenses.baseline;
const startBalanceFor = (rs: YearRow[], year: number): number =>
  year === 2026 ? PORTFOLIO : rs.find((r) => r.year === year - 1)!.balances.spendable;

// ---------------------------------------------------------------------------
// 1. Inside the band, nothing happens
// ---------------------------------------------------------------------------

describe('inside the band guardrails does nothing at all', () => {
  it('is the same run as fixed_real, year for year, while the rate stays inside', () => {
    /*
     * THE PROPERTY THAT DISTINGUISHES THIS POLICY FROM fixed_percent. With a
     * flat 0% real return the portfolio falls only by what is spent, so the
     * rate climbs 4.00% -> 4.17% -> 4.35% -> 4.55% -> 4.76% and never reaches
     * the 4.80% rail until 2031. Through those five years the household spends
     * the same 60,000 it always meant to; a percentage rule would have cut it
     * every one of them.
     */
    const guard = rows(GUARDRAILS, 0);
    const fixed = rows({ type: 'fixed_real' }, 0);
    for (let year = 2026; year <= 2030; year++) {
      expect(baselineFor(guard, year)).toBe(LIVING_ANNUAL);
      expect(baselineFor(guard, year)).toBe(baselineFor(fixed, year));
      expect(startBalanceFor(guard, year)).toBe(startBalanceFor(fixed, year));
    }
    // And the years it did nothing say nothing: no flag, because nothing about
    // the household's standard of living changed.
    expect(guard.filter((r) => r.year <= 2030).some((r) => r.flags.some((f) => f.startsWith('guardrail')))).toBe(
      false,
    );
  });

  it('measures the rate against the plan’s opening rate, not against 4% or any other constant', () => {
    // The band is relative, so a household that opens at 3% has rails at 2.4%
    // and 3.6% — nowhere near the 4% rule of thumb. Spending 45,000 off the
    // same portfolio opens at exactly 3% and stays inside far longer.
    const profile = household(GUARDRAILS);
    profile.expenses.livingMonthly = 45_000 / 12;
    const rs = runSimulation({
      profile,
      assumptions: assumptions(),
      scenario: { name: 'lower opening rate', autoSepp: false, events: [], assumption_overrides: flatMarket(0) },
      mode: 'deterministic',
      paths: 1,
      seed: 1,
    }).referencePath;
    /*
     * 45,000 / 1,500,000 = 3.00%, so the upper rail is 3.60% and is first
     * crossed when the portfolio falls below 1,250,000 — start of 2032, at
     * 1,230,000 and 3.659%. The 4%-spending household of the tests above cut in
     * 2031 at 1,200,000. Neither number is 4%, and neither is 5%: the rails are
     * this plan's own opening rate, scaled.
     */
    for (let year = 2026; year <= 2031; year++) {
      expect(rs.find((r) => r.year === year)!.expenses.baseline).toBe(45_000);
    }
    expect(startBalanceFor(rs, 2032)).toBeCloseTo(1_230_000, 6);
    expect(rs.find((r) => r.year === 2032)!.expenses.baseline).toBeCloseTo(45_000 * 0.9, 8);
  });
});

// ---------------------------------------------------------------------------
// 2. The upper rail cuts
// ---------------------------------------------------------------------------

describe('breaching the upper rail cuts spending by the adjustment', () => {
  it('cuts in 2031, the first year the rate is above the rail, and by exactly 10%', () => {
    /*
     * Hand-computed, at a flat 0% real return and 0% inflation:
     *   2026 start 1,500,000  rate 4.000%  (the anchor)
     *   2027 start 1,440,000  rate 4.167%
     *   2028 start 1,380,000  rate 4.348%
     *   2029 start 1,320,000  rate 4.545%
     *   2030 start 1,260,000  rate 4.762%  — still inside, by four basis points
     *   2031 start 1,200,000  rate 5.000%  — over the 4.800% rail: cut to 54,000
     */
    const rs = rows(GUARDRAILS, 0);
    expect(startBalanceFor(rs, 2030)).toBe(1_260_000);
    expect(baselineFor(rs, 2030)).toBe(LIVING_ANNUAL);
    expect(startBalanceFor(rs, 2031)).toBe(1_200_000);
    expect(baselineFor(rs, 2031)).toBeCloseTo(LIVING_ANNUAL * 0.9, 8);
    expect(rs.find((r) => r.year === 2031)!.flags).toContain('guardrail-cut');
    expect(rs.find((r) => r.year === 2030)!.flags).not.toContain('guardrail-cut');
  });

  it('holds the cut level until the rate breaches again — a cut is not a new anchor', () => {
    /*
     * 2032 opens at 1,146,000 and spends 54,000: a rate of 4.712%, back inside
     * the band. The rule does nothing, and the household stays at 54,000. The
     * anchor is still the 4.00% the plan opened at — re-anchoring on each cut
     * would ratchet spending down forever, one rail crossing at a time.
     */
    const rs = rows(GUARDRAILS, 0);
    expect(startBalanceFor(rs, 2032)).toBeCloseTo(1_146_000, 6);
    expect(baselineFor(rs, 2032)).toBeCloseTo(LIVING_ANNUAL * 0.9, 8);
    expect(rs.find((r) => r.year === 2032)!.flags).not.toContain('guardrail-cut');
    // 2033 opens at 1,092,000: 54,000 over it is 4.945%, over the rail again.
    expect(baselineFor(rs, 2033)).toBeCloseTo(LIVING_ANNUAL * 0.81, 8);
    expect(rs.find((r) => r.year === 2033)!.flags).toContain('guardrail-cut');
  });

  it('says so in the trace, with the rate it actually tested', () => {
    /*
     * A cut looks, in the baseline column alone, exactly like a mis-typed
     * number. The trace has to carry the rate the rails were tested against —
     * which is the spending the household was ABOUT to do, factor and all, not
     * the plan's original figure — or the reader cannot check the decision.
     */
    const row = rows(GUARDRAILS, 0).find((r) => r.year === 2031)!;
    const line = row.taxes.trace?.find((t) => t.label.startsWith('Spending policy — guardrails'));
    expect(line?.note).toContain('withdrawal rate 5.00%');
    expect(line?.note).toContain('opening 4.00%');
    expect(line?.note).toContain('rails at 3.20%-4.80%');
    expect(
      row.taxes.trace?.some((t) => t.label.includes('Upper rail breached')),
    ).toBe(true);
    // And the year before, the rule states that it deliberately did nothing.
    const quiet = rows(GUARDRAILS, 0).find((r) => r.year === 2030)!;
    expect(quiet.taxes.trace?.some((t) => t.label === 'Inside the band — real spending unchanged')).toBe(
      true,
    );
  });

  it('spends strictly less than fixed_real once it has cut, which is the point of cutting', () => {
    const guard = rows(GUARDRAILS, 0);
    const fixed = rows({ type: 'fixed_real' }, 0);
    expect(baselineFor(guard, 2035)).toBeLessThan(baselineFor(fixed, 2035));
    // And it therefore ends with more money than the plan that did not cut.
    const last = (rs: YearRow[]): number => rs[rs.length - 1].balances.spendableReal;
    expect(last(guard)).toBeGreaterThan(last(fixed));
  });
});

// ---------------------------------------------------------------------------
// 3. The lower rail raises
// ---------------------------------------------------------------------------

describe('breaching the lower rail raises spending by the same adjustment', () => {
  it('raises in 2030, the first year the rate falls below the rail', () => {
    /*
     * At a flat 10% real return the portfolio outruns the spending:
     *   2026 start 1,500,000  rate 4.000%  (the anchor)
     *   2027 start 1,584,000  rate 3.788%
     *   2028 start 1,676,400  rate 3.579%
     *   2029 start 1,778,040  rate 3.374%
     *   2030 start 1,889,844  rate 3.175%  — under the 3.200% rail: raise to 66,000
     */
    const rs = rows(GUARDRAILS, 0.1);
    expect(startBalanceFor(rs, 2029)).toBeCloseTo(1_778_040, 4);
    expect(baselineFor(rs, 2029)).toBe(LIVING_ANNUAL);
    expect(startBalanceFor(rs, 2030)).toBeCloseTo(1_889_844, 4);
    expect(baselineFor(rs, 2030)).toBeCloseTo(LIVING_ANNUAL * 1.1, 8);
    expect(rs.find((r) => r.year === 2030)!.flags).toContain('guardrail-raise');
  });

  it('has no ceiling: a portfolio that keeps running away keeps buying raises', () => {
    // Guyton-Klinger's prosperity rule has no upper limit, and a household
    // whose portfolio has outgrown its spending is not taking a risk by
    // spending more of it. Only the FLOOR is ours to impose.
    const rs = rows(GUARDRAILS, 0.1);
    const raises = rs.filter((r) => r.flags.includes('guardrail-raise')).length;
    expect(raises).toBeGreaterThan(1);
    expect(baselineFor(rs, 2035)).toBeGreaterThan(LIVING_ANNUAL * 1.1);
  });
});

// ---------------------------------------------------------------------------
// 4. The floor
// ---------------------------------------------------------------------------

describe('the floor holds after a long bad sequence', () => {
  /*
   * At a flat -10% real return the rate breaches every year from 2028, so the
   * factor walks 1 -> 0.9 -> 0.81 -> 0.729 and would reach 0.6561 on the
   * fourth cut. It does not: floorFraction 0.7 stops it, and stops it for
   * good. A rule with no floor grinds a household down to nothing and still
   * reports the path as a success — a success rate measured on a standard of
   * living nobody would accept is worth less than no number at all.
   */
  const rs = rows(GUARDRAILS, -0.1);

  it('never spends below floorFraction of the plan’s original real spending', () => {
    const floor = LIVING_ANNUAL * DEFAULT_GUARDRAILS.floorFraction;
    for (const r of rs) expect(r.expenses.baseline).toBeGreaterThanOrEqual(floor - 1e-6);
    expect(Math.min(...rs.map((r) => r.expenses.baseline))).toBeCloseTo(floor, 6);
  });

  it('reaches the floor by cutting, not by clamping a single huge cut', () => {
    // 0.9, 0.81, 0.729, then the floor: four crossings, three of which moved.
    expect(baselineFor(rs, 2028)).toBeCloseTo(LIVING_ANNUAL * 0.9, 8);
    expect(baselineFor(rs, 2029)).toBeCloseTo(LIVING_ANNUAL * 0.81, 8);
    expect(baselineFor(rs, 2030)).toBeCloseTo(LIVING_ANNUAL * 0.729, 8);
    expect(baselineFor(rs, 2031)).toBeCloseTo(LIVING_ANNUAL * 0.7, 8);
  });

  it('stops flagging a cut once the floor is absorbing it — the row states what happened', () => {
    // A rail is breached in every remaining year, but the household's spending
    // does not move, so the year did not cut. Flagging it would train the
    // reader to ignore the flag that matters.
    for (const r of rs.filter((x) => x.year > 2031)) {
      expect(r.expenses.baseline).toBeCloseTo(LIVING_ANNUAL * 0.7, 8);
      expect(r.flags).not.toContain('guardrail-cut');
    }
  });
});

// ---------------------------------------------------------------------------
// 5. The band is configuration, not law
// ---------------------------------------------------------------------------

describe('the band and the adjustment are the owner’s to set', () => {
  it('an absent band is DEFAULT_GUARDRAILS, exactly', () => {
    const implicit = rows(GUARDRAILS, 0);
    const explicit = rows(
      {
        type: 'guardrails',
        guardrails: {
          upper: DEFAULT_GUARDRAILS.upper,
          lower: DEFAULT_GUARDRAILS.lower,
          adjustment: DEFAULT_GUARDRAILS.adjustment,
          floorFraction: DEFAULT_GUARDRAILS.floorFraction,
        },
      },
      0,
    );
    expect(explicit.map((r) => r.expenses.baseline)).toEqual(
      implicit.map((r) => r.expenses.baseline),
    );
  });

  it('a tighter band cuts earlier and a bigger adjustment cuts harder', () => {
    // Rails at +/-5% of the opening rate: 4.2% upper, first crossed in 2028
    // (4.348%) rather than 2031, and a 20% correction rather than 10%.
    const rs = rows(
      { type: 'guardrails', guardrails: { upper: 1.05, lower: 0.95, adjustment: 0.2 } },
      0,
    );
    expect(baselineFor(rs, 2027)).toBe(LIVING_ANNUAL); // 4.167%, still inside
    expect(baselineFor(rs, 2028)).toBeCloseTo(LIVING_ANNUAL * 0.8, 8);
  });

  it('the opening rate is the first FULLY RETIRED year, not the first simulated one', () => {
    /*
     * A withdrawal rate measured while a salary is paying the bills is not a
     * withdrawal rate: the household withdraws nothing, and spending over
     * portfolio is a ratio of two unrelated numbers. Anchoring there would hand
     * this household a raise the day it retires, purely because the portfolio
     * grew for the two years it was still earning.
     *
     * THE FIXTURE HAS TO MAKE THE TWO ANCHORS DIFFERENT NUMBERS, which is the
     * trap the first version of this test fell into: at a flat 0% return the
     * salary years leave the portfolio at 1,500,000, so 60,000 over it is 4.00%
     * in 2026 AND in 2028, and anchoring on the wrong year is invisible. At 10%
     * the portfolio compounds untouched while the salary pays the bills:
     *   2026 start 1,500,000  (working — no anchor)
     *   2027 start 1,650,000  (working — no anchor)
     *   2028 start 1,815,000  RETIRED: 60,000 over it is 3.306%, THE ANCHOR
     *   2029 start 1,930,500  3.108% — inside 2.64%-3.97%, so nothing happens
     * Against a 2026 anchor the rails would be 3.20%-4.80% and 2029's 3.108%
     * would buy a 10% raise. It does not, and that is the whole property.
     */
    const profile = household(GUARDRAILS);
    profile.income.salaries = { p1: 200_000, p2: 0 };
    const rs = runSimulation({
      profile,
      assumptions: assumptions(),
      scenario: {
        name: 'retires in 2028',
        autoSepp: false,
        events: [{ type: 'retire', person: 'p1', date: '2028-01' }],
        assumption_overrides: flatMarket(0.1),
      },
      mode: 'deterministic',
      paths: 1,
      seed: 1,
    }).referencePath;
    const guardTrace = (year: number) =>
      rs
        .find((r) => r.year === year)!
        .taxes.trace?.find((t) => t.label.startsWith('Spending policy — guardrails'));
    // A working year does not report a rate because there is nothing to report
    // it against: no anchor exists, so the rule cannot have been applied.
    expect(guardTrace(2026)).toBeUndefined();
    expect(guardTrace(2027)).toBeUndefined();
    expect(rs.find((r) => r.year === 2026)!.expenses.baseline).toBe(LIVING_ANNUAL);
    expect(rs.find((r) => r.year === 2027)!.expenses.baseline).toBe(LIVING_ANNUAL);
    // The anchor is the retired year's own rate — 60,000 over the portfolio it
    // actually has by then, NOT the 4.00% the plan opened at.
    expect(startBalanceFor(rs, 2028)).toBeCloseTo(1_815_000, 6);
    expect(guardTrace(2028)?.note).toContain('opening 3.31%');
    expect(guardTrace(2028)?.note).toContain('rails at 2.64%-3.97%');
    expect(guardTrace(2028)?.note).not.toContain('opening 4.00%');
    expect(OPENING_RATE).toBe(0.04);
    // And the consequence: 2029 sits below a 2026-anchored lower rail and above
    // a 2028-anchored one. A raise here would mean the anchor came from a year
    // in which nobody was withdrawing anything.
    expect(rs.find((r) => r.year === 2029)!.flags).not.toContain('guardrail-raise');
    expect(rs.find((r) => r.year === 2029)!.expenses.baseline).toBe(LIVING_ANNUAL);
    // The first raise this plan does earn is 2032, four years after the anchor.
    expect(rs.find((r) => r.year === 2032)!.flags).toContain('guardrail-raise');
  });
});

// ---------------------------------------------------------------------------
// 6. Every path tells on itself: RunResult.guardrailStats
// ---------------------------------------------------------------------------
//
// Before these statistics existed, each Monte Carlo path applied its cuts
// internally and reported only survival — a plan could look 97% safe while
// funding that safety with spending cuts in a third of its futures, and
// nothing on screen said so. The deterministic fixtures here are single paths
// whose factor history is written out by hand above, so every aggregate is a
// number already derived on this page.

describe('guardrailStats — per-path facts pinned on hand-computed shapes', () => {
  it('a path that keeps cutting: flat 0% (cuts 2031, 2033, 2035 — see §2)', () => {
    const stats = runFor(GUARDRAILS, 0).guardrailStats!;
    expect(stats).toBeDefined();
    // One deterministic path, and it cut: the fractions are 0 or 1.
    expect(stats.everCutFraction).toBe(1);
    // Deepest factor: the third cut, 0.9^3.
    expect(stats.medianMinFactorAmongCut).toBeCloseTo(0.729, 8);
    // Below plan from the first cut (2031) through the horizon (2035).
    expect(stats.medianYearsBelowAmongCut).toBe(5);
    // Never raised, and 0.729 never reached the 0.7 floor.
    expect(stats.everAbovePlanFraction).toBe(0);
    expect(stats.floorTouchedFraction).toBe(0);
    expect(stats.floor).toBe(DEFAULT_GUARDRAILS.floorFraction);
    // No ceiling configured -> the key is absent, not undefined-valued.
    expect('ceiling' in stats).toBe(false);
  });

  it('a path that never cuts and rides prosperity: flat +10% (raises from 2030 — see §3)', () => {
    const stats = runFor(GUARDRAILS, 0.1).guardrailStats!;
    expect(stats.everCutFraction).toBe(0);
    // Conditional-on-cutting means NULL here, not "bottomed at 100% for 0
    // years": there is no cut future to describe.
    expect(stats.medianMinFactorAmongCut).toBeNull();
    expect(stats.medianYearsBelowAmongCut).toBeNull();
    expect(stats.everAbovePlanFraction).toBe(1);
    expect(stats.floorTouchedFraction).toBe(0);
  });

  it('a path that rides the floor: flat -10% (cuts 2028-2030, clamped 2031 — see §4)', () => {
    const stats = runFor(GUARDRAILS, -0.1).guardrailStats!;
    expect(stats.everCutFraction).toBe(1);
    // The clamp writes the floor itself, exactly.
    expect(stats.medianMinFactorAmongCut).toBe(DEFAULT_GUARDRAILS.floorFraction);
    // Below plan from the first cut (2028) through the horizon (2035).
    expect(stats.medianYearsBelowAmongCut).toBe(8);
    expect(stats.everAbovePlanFraction).toBe(0);
    expect(stats.floorTouchedFraction).toBe(1);
  });

  it('a floor of 100% absorbs every cut: everCut stays false, floorTouched says why', () => {
    /*
     * floorFraction 1 is schema-legal, and it makes the FIRST breach's cut
     * fully absorbed: uncapped = 1 x 0.9 = 0.9, clamped straight back to 1,
     * nothing about the household's spending moved. everCut must stay FALSE
     * ("a cut the floor absorbed entirely does not count") while floorTouched
     * reports that the rule kept asking — this is the only shape where the
     * two can disagree from year one, so it is the test that catches an
     * accumulator recording absorbed cuts as cuts (which would render as
     * "100% of futures cut, typically bottoming at 100% of plan, 0 yrs
     * below" — a cut future that cut nothing).
     */
    const res = runFor(
      { type: 'guardrails', guardrails: { ...DEFAULT_GUARDRAILS, floorFraction: 1 } },
      0,
    );
    const stats = res.guardrailStats!;
    expect(stats.everCutFraction).toBe(0);
    expect(stats.medianMinFactorAmongCut).toBeNull();
    expect(stats.medianYearsBelowAmongCut).toBeNull();
    expect(stats.everAbovePlanFraction).toBe(0);
    expect(stats.floorTouchedFraction).toBe(1);
    expect(stats.floor).toBe(1);
    // And spending genuinely never moved: the plan's own figure, unflagged.
    for (const r of res.referencePath) {
      expect(r.expenses.baseline).toBe(LIVING_ANNUAL);
      expect(r.flags).not.toContain('guardrail-cut');
    }
  });

  it('a path that cuts and recovers: raises BELOW plan are recoveries, not prosperity', () => {
    /*
     * The tight band from §5 (rails at +/-5%, 20% steps) at a flat 0% return
     * alternates: cut 2028 (0.8), raise 2029 (0.96), cut 2030 (0.768), raise
     * 2031 (0.9216), cut 2032 (0.73728), quiet 2033-34, floor-clamped cut
     * 2035 (0.7). Two real guardrail-raise years — and everAbovePlanFraction
     * must still be 0, because a recovery back TOWARD plan never crossed it.
     */
    const res = runFor(
      { type: 'guardrails', guardrails: { upper: 1.05, lower: 0.95, adjustment: 0.2 } },
      0,
    );
    const raiseYears = res.referencePath
      .filter((r) => r.flags.includes('guardrail-raise'))
      .map((r) => r.year);
    expect(raiseYears).toEqual([2029, 2031]);
    const stats = res.guardrailStats!;
    expect(stats.everCutFraction).toBe(1);
    expect(stats.everAbovePlanFraction).toBe(0);
    // Deepest point is the final clamp to the (defaulted) 0.7 floor...
    expect(stats.medianMinFactorAmongCut).toBe(DEFAULT_GUARDRAILS.floorFraction);
    expect(stats.floorTouchedFraction).toBe(1);
    // ...and the recoveries never got the path back to plan: below throughout
    // 2028-2035.
    expect(stats.medianYearsBelowAmongCut).toBe(8);
  });

  it('is present on a Monte Carlo guardrails run and absent under fixed_real — exact shape', () => {
    const scenario: Scenario = { name: 'guardrails mc', autoSepp: false, events: [] };
    const mc = (policy: SpendingPolicy) =>
      runSimulation({
        profile: household(policy),
        assumptions: assumptions(),
        scenario,
        mode: 'montecarlo',
        paths: 100,
        seed: 3,
      });
    const guarded = mc(GUARDRAILS);
    const stats = guarded.guardrailStats!;
    expect(stats).toBeDefined();
    for (const f of [
      stats.everCutFraction,
      stats.everAbovePlanFraction,
      stats.floorTouchedFraction,
    ]) {
      expect(f).toBeGreaterThanOrEqual(0);
      expect(f).toBeLessThanOrEqual(1);
    }
    // The medians exist exactly when somebody cut (the conditionality contract).
    expect(stats.medianMinFactorAmongCut === null).toBe(stats.everCutFraction === 0);
    expect(stats.medianYearsBelowAmongCut === null).toBe(stats.everCutFraction === 0);
    // A rail can only ever LOWER the deepest factor below 1, never above.
    if (stats.medianMinFactorAmongCut !== null) {
      expect(stats.medianMinFactorAmongCut).toBeLessThan(1);
      expect(stats.medianMinFactorAmongCut).toBeGreaterThanOrEqual(stats.floor);
    }
    // fixed_real keeps its exact JSON shape: no key at all, not an empty one.
    expect('guardrailStats' in mc({ type: 'fixed_real' })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 7. The spending ceiling (raiseCeiling)
// ---------------------------------------------------------------------------

describe('the ceiling caps the prosperity rule', () => {
  const CEILING_ONE: SpendingPolicy = {
    type: 'guardrails',
    guardrails: { ...DEFAULT_GUARDRAILS, raiseCeiling: 1 },
  };

  it('raiseCeiling 1.0 means never above plan: the +10% run keeps spending 60,000 flat', () => {
    /*
     * §3's fixture: flat +10% buys a raise in 2030 and keeps buying them. With
     * the ceiling at 1.0 the 2030 raise computes min(1.0, 1 x 1.1) = 1.0 —
     * nothing moved, so nothing is flagged, and every year spends the plan's
     * own 60,000. The rails still exist (a bad sequence would still cut);
     * prosperity alone is capped.
     */
    const res = runFor(CEILING_ONE, 0.1);
    for (const r of res.referencePath) {
      expect(r.expenses.baseline).toBe(LIVING_ANNUAL);
      expect(r.flags).not.toContain('guardrail-raise');
    }
    const stats = res.guardrailStats!;
    expect(stats.everAbovePlanFraction).toBe(0);
    expect(stats.everCutFraction).toBe(0);
    expect(stats.ceiling).toBe(1);
    // Year for year it is the fixed_real run — which is the point of 1.0.
    const fixed = rows({ type: 'fixed_real' }, 0.1);
    expect(res.referencePath.map((r) => r.expenses.baseline)).toEqual(
      fixed.map((r) => r.expenses.baseline),
    );
  });

  it('a partial ceiling caps the raise it cannot absorb, and absorbs the rest silently', () => {
    /*
     * Ceiling 1.15 on the +10% fixture. Uncapped, the factor walks 1.1 (2030),
     * 1.21 (2032), 1.331 (2034), 1.4641 (2035). Capped:
     *   2030: min(1.15, 1.1)   = 1.1   — a real raise, flagged;
     *   2032: min(1.15, 1.21)  = 1.15  — CAPPED, still a raise (it moved);
     *   2033+: min(1.15, ...)  = 1.15  — absorbed entirely, no flag, the
     *          floor's absorbed-cut ruling mirrored on the prosperity side.
     */
    const res = runFor(
      { type: 'guardrails', guardrails: { ...DEFAULT_GUARDRAILS, raiseCeiling: 1.15 } },
      0.1,
    );
    const byYear = (y: number) => res.referencePath.find((r) => r.year === y)!;
    expect(byYear(2030).expenses.baseline).toBeCloseTo(LIVING_ANNUAL * 1.1, 8);
    expect(byYear(2030).flags).toContain('guardrail-raise');
    expect(byYear(2032).expenses.baseline).toBeCloseTo(LIVING_ANNUAL * 1.15, 8);
    expect(byYear(2032).flags).toContain('guardrail-raise');
    // NOT the uncapped 72,600.
    expect(byYear(2032).expenses.baseline).toBeLessThan(LIVING_ANNUAL * 1.21);
    for (const year of [2033, 2034, 2035]) {
      expect(byYear(year).expenses.baseline).toBeCloseTo(LIVING_ANNUAL * 1.15, 8);
      expect(byYear(year).flags).not.toContain('guardrail-raise');
    }
    // The trace says what held the factor, the way the floor years do.
    const note = byYear(2033)
      .taxes.trace?.find((t) => t.note?.includes('cumulative factor'))?.note;
    expect(note).toContain('capped at the 115% ceiling');
    expect(res.guardrailStats!.ceiling).toBe(1.15);
    expect(res.guardrailStats!.everAbovePlanFraction).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Ceiling-absent bit-identity: pinned digests from the 1.17.0 engine
// ---------------------------------------------------------------------------

/**
 * Everything arithmetic about a run, hashed — the same field list as the
 * mfjUnchanged / preExpenseLinesUnchanged suites. guardrailStats is DELIBERATELY
 * not in the list: it is additive reporting beside the arithmetic (the
 * purchaseFunding convention), and these digests exist to prove the arithmetic
 * itself did not move.
 */
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

describe('a guardrails plan WITHOUT a ceiling is bit-for-bit the 1.17.0 engine', () => {
  /*
   * These four hexes were captured by running the 1.17.0 engine — before
   * raiseCeiling or the per-path stats existed — over exactly these fixtures.
   * An absent ceiling takes the else-branch of the raise (the pre-knob
   * expression, untouched), and the stats are bookkeeping beside the
   * arithmetic, so all four must hold. If one moves, the "absent = the
   * published rule, bit for bit" contract in types.ts is broken — find out
   * how before touching a pin.
   */
  const PINNED_117 = {
    flat0: 'e47578910641ca3a93141e2c00a3d2ccf4e857b2805cfe5e1646c543b46bc407',
    flatUp10: 'cf3a5df3046363bb60ddd79004182202fc3201634979d61a75637f495e267077',
    flatDown10: 'dcbec17659fa90e458c309ec1d708b26801f248bf67cd459fbadfdf90fd1d511',
    mc300seed7: 'b2a197e86409ac3f8c94c95ec552fe0833aa3561136c239f9b812d1a31ea8220',
  };

  it('deterministic: the cut, raise and floor fixtures all hold', () => {
    expect(runDigest(runFor(GUARDRAILS, 0))).toBe(PINNED_117.flat0);
    expect(runDigest(runFor(GUARDRAILS, 0.1))).toBe(PINNED_117.flatUp10);
    expect(runDigest(runFor(GUARDRAILS, -0.1))).toBe(PINNED_117.flatDown10);
  });

  it('monte carlo: 300 bootstrapped paths hold, cuts, raises, floor years and all', () => {
    const res = runSimulation({
      profile: household(GUARDRAILS),
      assumptions: assumptions(),
      scenario: { name: 'guardrails mc', autoSepp: false, events: [] },
      mode: 'montecarlo',
      paths: 300,
      seed: 7,
    });
    expect(runDigest(res)).toBe(PINNED_117.mc300seed7);
    // And the run still REPORTS: bit-identical arithmetic, new visibility.
    expect(res.guardrailStats).toBeDefined();
  });
});

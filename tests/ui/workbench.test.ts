/**
 * Unit tests for the pure Workbench helpers (src/ui/components/workbench/
 * workbenchLogic.ts). Every expected value is hand-computed here in comments —
 * nothing is pasted from a run.
 */
import { describe, expect, it } from 'vitest';
import type {
  AssumptionOverrides,
  FanChart,
  LifeInsurancePolicy,
  RetirementGivingRule,
  Scenario,
  ScenarioEvent,
  TraceLine,
  UntithedPotPolicy,
  YearRow,
} from '../../src/shared/types';
import {
  DEFAULT_GIVING_PERCENT,
  DEFAULT_GIVING_RULE,
  GIVING_RULE_OPTIONS,
  alignBaselineP50,
  coverageBands,
  coverageCaption,
  effectivePolicyPlan,
  householdWorkStopMonth,
  monthLabel,
  policyPlanOptions,
  policyPlanOverride,
  policyRowSummary,
  setPolicyPlanOverride,
  workStopText,
  annualGivingEquivalent,
  annualGivingNote,
  annualSalaryTotal,
  classicWithdrawalRate,
  comparableRun,
  comparisonNote,
  computeDeltas,
  defaultRunSettings,
  effectiveGivingRule,
  effectiveMonthly,
  effectiveRetiredMonthly,
  effectiveRetirementIncome,
  effectiveRetirementTaxable,
  expenseOverride,
  givingOverride,
  givingRuleHelp,
  givingRuleOfType,
  givingRuleSummary,
  lifetimeEquivalentDraw,
  parsePositiveInt,
  parseSeed,
  planSaveKey,
  finalRunParams,
  finalStandInParams,
  refreshFailureNote,
  resolveRunParams,
  retiredPlaceholder,
  retirementIncomeOverride,
  retirementIncomePlaceholder,
  retirementTaxableOverride,
  noChangeChip,
  pathFractionDeltaResolution,
  pathFractionHalfWidth,
  pathFractionStandardError,
  successPrecision,
  CI_Z_95,
  UNRESOLVED_CHIP,
  runComputedAt,
  runInputKey,
  runMetrics,
  runNowBusy,
  runNowButtonText,
  runQualityLabel,
  saveFailureText,
  setExpenseOverride,
  setGivingAmount,
  setGivingCap,
  setGivingOverride,
  setGivingPercent,
  setGivingSmoothing,
  effectivePotSetting,
  ongoingOf,
  potHelp,
  potOverride,
  potSummary,
  setPotAllocation,
  setPotDistributeYears,
  setPotEarlyRelease,
  setPotHoldYears,
  setPotOngoingDuringHold,
  setPotOverride,
  setPotPercent,
  setPotSeedFromGains,
  setRetirementIncomeOverride,
  setRetirementTaxableChoice,
  ssClaimMarkerYear,
  WITHDRAWAL_CHART_EMPTY_NOTE,
  withdrawalRateAxisDomain,
  withdrawalRateSeries,
  withdrawalTooltipView,
  workingIncomeLines,
  type RunMetrics,
  type WithdrawalRatePoint,
} from '../../src/ui/components/workbench/workbenchLogic';
import {
  autoSeppPatch,
  buildOverrides,
  overrideFieldErrors,
  overrideFieldsFrom,
} from '../../src/ui/components/scenarios/scenarioHelpers';
// The Search page's own "±" formatter, imported so the two quantities can be
// set side by side in one assertion — see the WITHIN/ACROSS test below.
import { formatSpread } from '../../src/ui/components/search/searchLogic';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Type-complete YearRow carrying only the fields these helpers read. */
function makeRow(year: number, flags: string[] = []): YearRow {
  return {
    year,
    agesAtYearEnd: [year - 1971, year - 1971],
    inflationIndex: 1,
    income: {
      wages: 0,
      socialSecurity: 0,
      taxableInterest: 0,
      dividends: 0,
      other: 0,
      retirement: 0,
      employerHealthPremiumShare: 0,
    },
    expenses: { baseline: 0, charitable: 0, housing: 0, health: 0, oneTime: 0, total: 0 },
    investing: 0,
    unbudgeted: 0,
    housing: {
      rent: 0,
      mortgagePayment: 0,
      mortgageInterest: 0,
      propertyTax: 0,
      insurance: 0,
      maintenance: 0,
      homeValue: 0,
      saleProceeds: 0,
    },
    withdrawals: {
      byAccount: {},
      cash: 0,
      taxable: 0,
      pretax: 0,
      roth: 0,
      rothConversion: 0,
      rmd: 0,
      penaltyBase: 0,
      realizedLtcg: 0,
    },
    taxes: {
      federal: {
        agi: 0,
        standardDeduction: 0,
        itemizedDeduction: 0,
        deductionUsed: 'standard',
        taxableIncome: 0,
        taxableOrdinaryIncome: 0,
        ssTaxableAmount: 0,
        ordinaryTax: 0,
        ltcgTax: 0,
        niit: 0,
        total: 0,
      },
      state: { code: 'va', taxableIncome: 0, total: 0 },
      penalties: 0,
      aca: null,
      medicare: null,
      magi: { agi: 0, acaMagi: 0, irmaaMagi: 0, niitMagi: 0 },
      totalTax: 0,
    },
    // A YearRow always carries both views of the balance sheet (note 21):
    // `total` includes a Tithe Account carve-out, `spendable` does not, and
    // the two are the same figure in a plan that has none — which is what
    // this fixture is.
    balances: { byAccount: {}, total: 0, totalReal: 0, tithe: 0, spendable: 0, spendableReal: 0 },
    returns: { stocks: 0, bonds: 0, bills: 0, cpi: 0 },
    eventsFired: [],
    flags,
  };
}

function metrics(
  success: number,
  medianTerminalReal: number,
  shortfallYear: number | null,
  // A fixed, rail-less rate by default, so the delta tests around OTHER
  // metrics see "no change" on this tile rather than noise from the fixture.
  withdrawal: RunMetrics['withdrawal'] = {
    kind: 'rate',
    rate: 0.053,
    year: 2029,
    rails: null,
    lifetime: null,
  },
  // Absent by default — the never-adjusts state — so the guardrails pair reads
  // "no change" across every comparison the other tiles' tests build.
  guardrails?: RunMetrics['guardrails'],
): RunMetrics {
  return { success, medianTerminalReal, shortfallYear, withdrawal, guardrails };
}

/** In-band guardrails stats, overridable per test. */
function guardStats(over?: Partial<NonNullable<RunMetrics['guardrails']>>): NonNullable<RunMetrics['guardrails']> {
  return {
    everCutFraction: 0.23,
    medianMinFactorAmongCut: 0.87,
    medianYearsBelowAmongCut: 5,
    everAbovePlanFraction: 0.61,
    floorTouchedFraction: 0,
    floor: 0.7,
    ...over,
  };
}

/**
 * A reference-path row for the withdrawal-rate tests: makeRow with exactly the
 * fields classicWithdrawalRate reads set by name, so each test states its own
 * arithmetic and nothing rides in by accident.
 */
function pathRow(
  year: number,
  patch: {
    wages?: number;
    socialSecurity?: number;
    retirement?: number;
    other?: number;
    taxableInterest?: number;
    dividends?: number;
    expensesTotal?: number;
    totalTax?: number;
    investing?: number;
    spendable?: number;
    inflationIndex?: number;
    trace?: TraceLine[];
  } = {},
): YearRow {
  const row = makeRow(year);
  row.inflationIndex = patch.inflationIndex ?? 1;
  row.income.wages = patch.wages ?? 0;
  row.income.socialSecurity = patch.socialSecurity ?? 0;
  row.income.retirement = patch.retirement ?? 0;
  row.income.other = patch.other ?? 0;
  row.income.taxableInterest = patch.taxableInterest ?? 0;
  row.income.dividends = patch.dividends ?? 0;
  row.expenses.total = patch.expensesTotal ?? 0;
  row.taxes.totalTax = patch.totalTax ?? 0;
  row.investing = patch.investing ?? 0;
  row.balances.spendable = patch.spendable ?? 0;
  if (patch.trace !== undefined) row.taxes.trace = patch.trace;
  return row;
}

/** Pick one metric out of the strip by key. */
function pick(deltas: ReturnType<typeof computeDeltas>, key: string) {
  const found = deltas.find((d) => d.key === key);
  if (!found) throw new Error(`no delta for "${key}"`);
  return found;
}

// ---------------------------------------------------------------------------
// runMetrics
// ---------------------------------------------------------------------------

describe('runMetrics', () => {
  it('takes the shortfall year from the worst-decile histogram', () => {
    // Histogram {2045: 2, 2049: 3}: total 5 failures, half = 2.5.
    // Cumulative at 2045 = 2 (< 2.5); at 2049 = 5 (>= 2.5) -> 2049.
    const m = runMetrics({
      success: 0.85,
      medianTerminalReal: 1_000_000,
      worstDecileShortfallYears: { '2045': 2, '2049': 3 },
      referencePath: [makeRow(2045, ['insolvent'])],
    });
    // The one-row path is wageless from its first row, so the withdrawal rate
    // has no prior-year opening balance and says so.
    expect(m).toEqual({
      success: 0.85,
      medianTerminalReal: 1_000_000,
      shortfallYear: 2049,
      withdrawal: { kind: 'no-opening-balance', year: 2045 },
    });
  });

  it('falls back to the deterministic reference path when the histogram is empty', () => {
    // No per-path histogram (deterministic mode): first row flagged insolvent
    // is 2051, so that is the reported year.
    const m = runMetrics({
      success: 0,
      medianTerminalReal: 0,
      worstDecileShortfallYears: {},
      referencePath: [makeRow(2050), makeRow(2051, ['insolvent']), makeRow(2052, ['insolvent'])],
    });
    expect(m.shortfallYear).toBe(2051);
  });

  it('reports no shortfall year when every path succeeded', () => {
    // success === 1 short-circuits: nothing failed, so there is no year to name.
    const m = runMetrics({
      success: 1,
      medianTerminalReal: 2_000_000,
      worstDecileShortfallYears: { '2045': 4 },
      referencePath: [makeRow(2045, ['insolvent'])],
    });
    expect(m.shortfallYear).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// computeDeltas
// ---------------------------------------------------------------------------

describe('computeDeltas', () => {
  it('reports values with no change chips when there is nothing to compare', () => {
    const d = computeDeltas(metrics(0.397, 1_420_000, 2046), null);
    // The guardrails pair is ALWAYS present — a run without rails says so in
    // its value — so the baseline strip is six tiles, not four.
    expect(d.map((x) => x.key)).toEqual([
      'success',
      'terminal',
      'withdrawal',
      'guardCut',
      'guardRaise',
      'shortfall',
    ]);
    // 0.397 * 100 = 39.7 -> "39.7%"
    expect(pick(d, 'success').value).toBe('39.7%');
    expect(pick(d, 'terminal').value).toBe('$1,420,000');
    // The value states its own condition: a bare year on a mostly-passing plan
    // read as "typically runs out then", when only failing futures are counted.
    expect(pick(d, 'shortfall').value).toBe('2046 (in the 60.3% that fail)');
    for (const x of d) {
      expect(x.change).toBeNull();
      expect(x.direction).toBe('none');
      expect(x.tone).toBe('neutral');
    }
  });

  it('reports success in percentage POINTS, signed', () => {
    // 0.525 -> "52.5%". Move: 0.525 - 0.397 = 0.128 -> 12.8 points.
    const up = pick(computeDeltas(metrics(0.525, 1, null), metrics(0.397, 1, null)), 'success');
    expect(up.value).toBe('52.5%');
    expect(up.change).toBe('+12.8 pts');
    expect(up.direction).toBe('up');
    expect(up.tone).toBe('good');

    // 0.397 - 0.525 = -0.128 -> -12.8 points; the minus comes from toFixed.
    const down = pick(computeDeltas(metrics(0.397, 1, null), metrics(0.525, 1, null)), 'success');
    expect(down.change).toBe('-12.8 pts');
    expect(down.direction).toBe('down');
    expect(down.tone).toBe('bad');
  });

  it('formats the terminal move compactly and signs it', () => {
    // 1,240,000 - 1,420,000 = -180,000 -> 180000/1000 = 180 -> "-$180K".
    const down = pick(
      computeDeltas(metrics(0.5, 1_240_000, null), metrics(0.5, 1_420_000, null)),
      'terminal',
    );
    expect(down.value).toBe('$1,240,000');
    expect(down.change).toBe('-$180K');
    expect(down.direction).toBe('down');
    expect(down.tone).toBe('bad');

    // 1,420,000 - 1,240,000 = +180,000; positives take an explicit '+'.
    const up = pick(
      computeDeltas(metrics(0.5, 1_420_000, null), metrics(0.5, 1_240_000, null)),
      'terminal',
    );
    expect(up.change).toBe('+$180K');
    expect(up.tone).toBe('good');

    // 2,500,000 - 1,000,000 = 1,500,000 -> 1.5 million -> "+$1.5M".
    const big = pick(
      computeDeltas(metrics(0.5, 2_500_000, null), metrics(0.5, 1_000_000, null)),
      'terminal',
    );
    expect(big.change).toBe('+$1.5M');
  });

  it('treats a later shortfall year as good news', () => {
    // 2049 - 2046 = +3 -> three more years of money.
    const later = pick(
      computeDeltas(metrics(0.5, 1, 2049), metrics(0.5, 1, 2046)),
      'shortfall',
    );
    expect(later.value).toBe('2049 (in the 50.0% that fail)');
    expect(later.change).toBe('+3 yrs');
    expect(later.direction).toBe('up');
    expect(later.tone).toBe('good');

    // 2043 - 2046 = -3 -> the money runs out three years sooner.
    const sooner = pick(
      computeDeltas(metrics(0.5, 1, 2043), metrics(0.5, 1, 2046)),
      'shortfall',
    );
    expect(sooner.change).toBe('-3 yrs');
    expect(sooner.direction).toBe('down');
    expect(sooner.tone).toBe('bad');

    // 2047 - 2046 = +1 -> singular unit.
    expect(
      pick(computeDeltas(metrics(0.5, 1, 2047), metrics(0.5, 1, 2046)), 'shortfall').change,
    ).toBe('+1 yr');
  });

  it('says so when the shortfall appears or disappears entirely', () => {
    const gone = pick(computeDeltas(metrics(1, 1, null), metrics(0.5, 1, 2046)), 'shortfall');
    expect(gone.value).toBe('none ever');
    expect(gone.change).toBe('gone (was 2046)');
    expect(gone.tone).toBe('good');

    const appeared = pick(computeDeltas(metrics(0.5, 1, 2046), metrics(1, 1, null)), 'shortfall');
    expect(appeared.change).toBe('new (was none)');
    expect(appeared.tone).toBe('bad');
  });

  it('says "no change" rather than a signed zero', () => {
    const same = computeDeltas(metrics(0.85, 1_000_000, 2050), metrics(0.85, 1_000_000, 2050));
    for (const x of same) {
      expect(x.change).toBe('no change');
      expect(x.direction).toBe('flat');
      expect(x.tone).toBe('neutral');
    }
    // Both runs succeed everywhere: two nulls are also "no change", not "gone".
    expect(
      pick(computeDeltas(metrics(1, 1, null), metrics(1, 1, null)), 'shortfall').change,
    ).toBe('no change');
  });
});

// ---------------------------------------------------------------------------
// classicWithdrawalRate
// ---------------------------------------------------------------------------

/**
 * The three-row path the arithmetic tests share: a full working year, the
 * blend year, and the first fully retired year. Numbers are chosen so every
 * mis-inclusion produces a DIFFERENT rate than the correct 6.2%:
 *
 *   2027 worked (wages 120,000), closes at 950,000 spendable.
 *   2028 blend  (wages 60,000 — someone earned part of the year), spends
 *        150,000 total, closes at 1,000,000 spendable.
 *   2029 first fully retired (wages 0):
 *        expenses.total 90,000 + totalTax 12,000 = 102,000 out
 *        - (SS 30,000 + retirement 6,000 + other 4,000) = 62,000 funded
 *        by the portfolio; taxableInterest 5,000 and dividends 7,000 are
 *        NOT netted; investing 10,000 is NOT added.
 *
 *   rate = 62,000 / 1,000,000 (2028's closing spendable) = 0.062.
 *
 *   Wrongly netting interest+dividends: 50,000 / 1,000,000 = 0.050.
 *   Wrongly adding the investing transfer: 72,000 / 1,000,000 = 0.072.
 *   Wrongly using the blend year: (150,000 - 60,000) / 950,000 ≈ 0.0947.
 */
function retirementPath(): YearRow[] {
  return [
    pathRow(2027, { wages: 120_000, expensesTotal: 100_000, spendable: 950_000 }),
    pathRow(2028, { wages: 60_000, expensesTotal: 150_000, spendable: 1_000_000 }),
    pathRow(2029, {
      wages: 0,
      socialSecurity: 30_000,
      retirement: 6_000,
      other: 4_000,
      taxableInterest: 5_000,
      dividends: 7_000,
      expensesTotal: 90_000,
      totalTax: 12_000,
      investing: 10_000,
      spendable: 940_000,
    }),
  ];
}

describe('classicWithdrawalRate', () => {
  it('divides what the portfolio funded by the prior year-end spendable balance', () => {
    // (90,000 + 12,000 - 30,000 - 6,000 - 4,000) / 1,000,000 = 0.062.
    const stat = classicWithdrawalRate(retirementPath());
    expect(stat).toEqual({ kind: 'rate', rate: 0.062, year: 2029, rails: null, lifetime: null });
  });

  it('does NOT net interest or dividend income — the portfolio paying you is not outside help', () => {
    const withPortfolioIncome = classicWithdrawalRate(retirementPath());
    const without = retirementPath();
    without[2].income.taxableInterest = 0;
    without[2].income.dividends = 0;
    // Identical rate with and without 12,000 of portfolio income: had either
    // been netted, the first rate would read 0.050 instead of 0.062.
    expect(classicWithdrawalRate(without)).toEqual(withPortfolioIncome);
  });

  it('does NOT count the investing transfer as spending — it stays inside the portfolio', () => {
    const withTransfer = classicWithdrawalRate(retirementPath());
    const without = retirementPath();
    without[2].investing = 0;
    // Identical rate with and without the 10,000 transfer: had it been
    // counted, the first rate would read 0.072 instead of 0.062.
    expect(classicWithdrawalRate(without)).toEqual(withTransfer);
  });

  it('skips the blend year — any wages at all disqualify a row', () => {
    const stat = classicWithdrawalRate(retirementPath());
    // 2028 earned 60,000 for part of the year; using it would report
    // ~0.0947 for 2028. The stat must be 2029's.
    expect(stat.kind).toBe('rate');
    if (stat.kind === 'rate') {
      expect(stat.year).toBe(2029);
      expect(stat.rate).toBeCloseTo(0.062, 12);
    }
  });

  it('nets Social Security, retirement income and one-time income', () => {
    const without = retirementPath();
    without[2].income.socialSecurity = 0;
    without[2].income.retirement = 0;
    without[2].income.other = 0;
    const stat = classicWithdrawalRate(without);
    // With no outside income the portfolio funds the full 102,000: 0.102.
    expect(stat.kind === 'rate' && stat.rate).toBeCloseTo(0.102, 12);
  });

  it('reports never-retired when someone earns a salary in every year', () => {
    const rows = [
      pathRow(2027, { wages: 120_000, spendable: 900_000 }),
      pathRow(2028, { wages: 120_000, spendable: 950_000 }),
    ];
    expect(classicWithdrawalRate(rows)).toEqual({ kind: 'never-retired' });
  });

  it('reports no-opening-balance for a plan already retired in its first year', () => {
    const rows = [pathRow(2027, { wages: 0, spendable: 900_000 }), pathRow(2028)];
    expect(classicWithdrawalRate(rows)).toEqual({ kind: 'no-opening-balance', year: 2027 });
  });

  it('reports no-opening-balance when the prior year closed empty', () => {
    const rows = [
      pathRow(2027, { wages: 120_000, spendable: 0 }),
      pathRow(2028, { wages: 0, expensesTotal: 50_000 }),
    ];
    expect(classicWithdrawalRate(rows)).toEqual({ kind: 'no-opening-balance', year: 2028 });
  });

  it('reads the guardrails band from the engine trace, in the engine wording', () => {
    // The wording below is the engine's own (pinned independently by
    // tests/engine/guardrails.test.ts); the rails come back as fractions.
    const rows = retirementPath();
    rows[2].taxes.trace = [
      { label: 'Federal ordinary tax', amount: 12_000 },
      {
        label: 'Spending policy — guardrails (Guyton-Klinger)',
        note: 'withdrawal rate 4.00% against an opening 4.00%; rails at 3.20%-4.80%',
      },
    ];
    const stat = classicWithdrawalRate(rows);
    expect(stat.kind).toBe('rate');
    if (stat.kind === 'rate') {
      expect(stat.rails).not.toBeNull();
      expect(stat.rails?.anchor).toBeCloseTo(0.04, 12);
      expect(stat.rails?.raiseBelow).toBeCloseTo(0.032, 12);
      expect(stat.rails?.cutAbove).toBeCloseTo(0.048, 12);
    }
  });

  it('degrades to headline-only when the trace is absent or its wording drifts', () => {
    // No trace at all (the fixture path) -> no rails.
    const plain = classicWithdrawalRate(retirementPath());
    expect(plain.kind === 'rate' && plain.rails).toBeNull();
    // A guardrails line whose note no longer parses -> no rails, not garbage.
    const drifted = retirementPath();
    drifted[2].taxes.trace = [
      { label: 'Spending policy — guardrails (Guyton-Klinger)', note: 'reworded entirely' },
    ];
    const stat = classicWithdrawalRate(drifted);
    expect(stat.kind === 'rate' && stat.rails).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// withdrawalRateSeries (the Summary chart) + its view helpers
// ---------------------------------------------------------------------------

/**
 * retirementPath() plus a second fully retired year, so the series has a
 * shape to state. Hand-computed:
 *
 *   2030 (wages 0): expenses.total 95,000 + totalTax 13,000 = 108,000 out
 *        - SS 40,000 = 68,000 funded by the portfolio, from 2029's closing
 *        spendable 940,000 -> rate 68,000 / 940,000 ≈ 0.0723.
 */
function twoRetiredYearsPath(): YearRow[] {
  const rows = retirementPath();
  rows.push(
    pathRow(2030, {
      wages: 0,
      socialSecurity: 40_000,
      expensesTotal: 95_000,
      totalTax: 13_000,
      spendable: 900_000,
    }),
  );
  return rows;
}

/** A minimal plotted point for the marker/domain tests. */
function pt(year: number, rate = 0.05): WithdrawalRatePoint {
  return { year, rate, funded: rate * 1_000_000, opening: 1_000_000, inflationIndex: 1 };
}

describe('withdrawalRateSeries', () => {
  it('prices every fully retired year by the tile rules, carrying the dollars behind each rate', () => {
    // 2029 is the tile's own hand-computed 0.062 (see retirementPath); 2030
    // follows the same field rulings from 2029's close.
    expect(withdrawalRateSeries(twoRetiredYearsPath())).toEqual([
      { year: 2029, rate: 0.062, funded: 62_000, opening: 1_000_000, inflationIndex: 1 },
      { year: 2030, rate: 68_000 / 940_000, funded: 68_000, opening: 940_000, inflationIndex: 1 },
    ]);
  });

  it('excludes working and blend years — the plotted series starts at the first fully retired year', () => {
    // 2027 worked (wages 120,000) and 2028 blended (wages 60,000): any wages
    // at all disqualify a row, so neither is plotted.
    const years = withdrawalRateSeries(twoRetiredYearsPath()).map((p) => p.year);
    expect(years).toEqual([2029, 2030]);
  });

  it('IS the tile arithmetic: perturbing a shared input moves both to the same new value', () => {
    // The divergence guard, stated honestly: a fork that DRIFTS fails here
    // (the fixture keeps every numerator term nonzero so any behavioural
    // difference shows), but a byte-faithful fork is undetectable by any
    // black-box test — the real guarantee is structural, in the shipped code:
    // classicWithdrawalRate literally reads withdrawalRateSeries()[0], so
    // there is no second computation to drift. Baseline first —
    const path = retirementPath();
    const tile = classicWithdrawalRate(path);
    const series = withdrawalRateSeries(path);
    expect(tile.kind === 'rate' && tile.rate).toBe(series[0].rate);
    expect(tile.kind === 'rate' && tile.year).toBe(series[0].year);
    // — then change an input the arithmetic nets. Removing 2029's Social
    // Security leaves the portfolio funding 102,000 - 10,000 = 92,000 of the
    // year: BOTH must now say 92,000 / 1,000,000 = 0.092.
    const moved = retirementPath();
    moved[2].income.socialSecurity = 0;
    const movedTile = classicWithdrawalRate(moved);
    const movedSeries = withdrawalRateSeries(moved);
    expect(movedSeries[0].rate).toBeCloseTo(0.092, 12);
    expect(movedTile.kind === 'rate' && movedTile.rate).toBe(movedSeries[0].rate);
  });

  it('states no point for a year with no opening balance, rather than a nonsense rate', () => {
    // 2028 closed at 0 (insolvent-shaped), so 2029 has nothing to divide by:
    // only 2028 — funded 60,000 over 2027's 950,000 close — is plotted.
    const rows = [
      pathRow(2027, { wages: 120_000, spendable: 950_000 }),
      pathRow(2028, { wages: 0, expensesTotal: 60_000, spendable: 0 }),
      pathRow(2029, { wages: 0, expensesTotal: 50_000, spendable: 0 }),
    ];
    expect(withdrawalRateSeries(rows)).toEqual([
      { year: 2028, rate: 60_000 / 950_000, funded: 60_000, opening: 950_000, inflationIndex: 1 },
    ]);
  });

  it('is empty for a plan that never fully retires — and the chart then shows words, not a blank', () => {
    const rows = [
      pathRow(2027, { wages: 120_000, spendable: 900_000 }),
      pathRow(2028, { wages: 120_000, spendable: 950_000 }),
    ];
    expect(withdrawalRateSeries(rows)).toEqual([]);
    // The card renders this sentence in place of the chart; it must name the
    // reasons in plain words rather than leaving a silent gap in the Summary.
    expect(WITHDRAWAL_CHART_EMPTY_NOTE).toMatch(/never fully retires/);
    expect(WITHDRAWAL_CHART_EMPTY_NOTE).toMatch(/no opening balance/);
  });
});

// ---------------------------------------------------------------------------
// lifetimeEquivalentDraw (the withdrawal tile's second clause)
// ---------------------------------------------------------------------------

/**
 * A path with REAL inflation, so the real conversion is actually exercised.
 * Hand-computed:
 *
 *   2026 worked (wages 120,000), index 1.0,  closes at 1,000,000 spendable.
 *   2027 worked (wages 120,000), index 1.05, closes at 1,100,000 spendable.
 *   2028 first fully retired,    index 1.1:
 *        expenses.total 66,000, no outside income -> funded 66,000 nominal;
 *        66,000 / 1.1 = 60,000 real. It opens on 2027's close, 1,100,000,
 *        deflated by 2028's OWN index (the boundary instant end-of-2027 IS
 *        start-of-2028): 1,100,000 / 1.1 = 1,000,000 real. Closes 1,050,000.
 *   2029 retired, index 1.25: expenses.total 87,500 - SS 25,000 = 62,500
 *        funded; 62,500 / 1.25 = 50,000 real.
 *
 *   lifetime = mean(60,000, 50,000) / 1,000,000 = 55,000 / 1,000,000 = 0.055
 *   over 2 years.
 *
 * Every mutant lands on a DIFFERENT number, so the 12-digit pin below kills
 * each by name:
 *   summing nominal dollars:      (66,000 + 62,500)/2 / 1,100,000 ~ 0.0584
 *   nominal denominator only:      55,000 / 1,100,000            =  0.05
 *   denominator by 2027's index:   55,000 / (1,100,000/1.05)     ~  0.0525
 *   mean of the yearly RATES:     (0.06 + 62,500/1,050,000)/2    ~  0.0598
 */
function inflatedRetirementPath(): YearRow[] {
  return [
    pathRow(2026, { wages: 120_000, spendable: 1_000_000, inflationIndex: 1 }),
    pathRow(2027, { wages: 120_000, spendable: 1_100_000, inflationIndex: 1.05 }),
    pathRow(2028, { expensesTotal: 66_000, spendable: 1_050_000, inflationIndex: 1.1 }),
    pathRow(2029, {
      expensesTotal: 87_500,
      socialSecurity: 25_000,
      spendable: 980_000,
      inflationIndex: 1.25,
    }),
  ];
}

describe('lifetimeEquivalentDraw', () => {
  it('states the constant-equivalent REAL draw — summing nominal dollars fails this pin', () => {
    const stat = classicWithdrawalRate(inflatedRetirementPath());
    expect(stat.kind).toBe('rate');
    if (stat.kind === 'rate') {
      // The headline is 2028's own nominal ratio, untouched by the new figure.
      expect(stat.rate).toBeCloseTo(0.06, 12);
      // mean(60,000, 50,000) real / 1,000,000 real — see the fixture comment
      // for the four mutants this number excludes (nominal summing ~0.0584,
      // nominal denominator 0.05, prior-year index ~0.0525, mean-of-rates
      // ~0.0598).
      expect(stat.lifetime).not.toBeNull();
      expect(stat.lifetime?.years).toBe(2);
      expect(stat.lifetime?.rate).toBeCloseTo(0.055, 12);
    }
  });

  it('includes a one-time gift year — the pot instalment is money the portfolio funded', () => {
    // 2030 gives a 75,000 one-time gift on top of 50,000 of ordinary outflow
    // (gifts ride inside expenses.total, where charitable always lands); at
    // index 1.25 the year funds 125,000 / 1.25 = 100,000 real.
    // lifetime = mean(60,000, 50,000, 100,000) / 1,000,000 = 0.07.
    const rows = inflatedRetirementPath();
    const giftYear = pathRow(2030, {
      expensesTotal: 125_000,
      spendable: 800_000,
      inflationIndex: 1.25,
    });
    giftYear.expenses.charitable = 75_000; // labelled, and inside the total
    rows.push(giftYear);
    const withGift = classicWithdrawalRate(rows);
    expect(withGift.kind === 'rate' && withGift.lifetime?.rate).toBeCloseTo(0.07, 12);
    // Strip the gift dollars and the figure must drop to mean(60,000, 50,000,
    // 40,000) / 1,000,000 = 0.05 — proof the gift year was genuinely summed,
    // not skipped as an outlier.
    const rowsWithout = inflatedRetirementPath();
    rowsWithout.push(
      pathRow(2030, { expensesTotal: 50_000, spendable: 800_000, inflationIndex: 1.25 }),
    );
    const without = classicWithdrawalRate(rowsWithout);
    expect(without.kind === 'rate' && without.lifetime?.rate).toBeCloseTo(0.05, 12);
  });

  it('is null under two priced years — a one-year "lifetime" would restate the headline', () => {
    // retirementPath prices exactly one retired year (2029).
    const stat = classicWithdrawalRate(retirementPath());
    expect(stat.kind === 'rate' && stat.lifetime).toBeNull();
    // Direct: the exported function makes the same ruling on a bare series.
    expect(lifetimeEquivalentDraw(withdrawalRateSeries(retirementPath()))).toBeNull();
    expect(lifetimeEquivalentDraw([])).toBeNull();
  });

  it('consumes the SAME series as the tile: perturbing a shared input moves both consistently', () => {
    // The divergence guard, stated honestly (the reworded precedent above): a
    // byte-faithful fork of the arithmetic is undetectable by any black-box
    // test. The real guarantee is structural, in the shipped code —
    // classicWithdrawalRate reads its headline AND its lifetime figure off
    // ONE withdrawalRateSeries() call, so there is no second series to drift.
    // What a test CAN pin: the exported pieces, recombined by hand, land on
    // the tile's own numbers before and after a perturbation.
    const path = inflatedRetirementPath();
    const tile = classicWithdrawalRate(path);
    expect(tile.kind === 'rate' && tile.lifetime).toEqual(
      lifetimeEquivalentDraw(withdrawalRateSeries(path)),
    );
    // Remove 2029's Social Security: that year now funds 87,500 nominal =
    // 70,000 real, so BOTH recombinations must say mean(60,000, 70,000) /
    // 1,000,000 = 0.065.
    const moved = inflatedRetirementPath();
    moved[3].income.socialSecurity = 0;
    const movedTile = classicWithdrawalRate(moved);
    expect(movedTile.kind === 'rate' && movedTile.lifetime?.rate).toBeCloseTo(0.065, 12);
    expect(movedTile.kind === 'rate' && movedTile.lifetime).toEqual(
      lifetimeEquivalentDraw(withdrawalRateSeries(moved)),
    );
  });
});

describe('ssClaimMarkerYear', () => {
  const points = [pt(2029), pt(2030), pt(2040), pt(2050)];

  it('derives the marker from the EARLIEST claim event, not from a hardcoded year', () => {
    // She claims 2040-06, he claims 2038-03: the household stream starts with
    // the primary's claim, so the marker sits at 2038.
    const events: ScenarioEvent[] = [
      { type: 'retire', person: 'p1', date: '2028-07' },
      { type: 'claim_social_security', person: 'p2', date: '2040-06' },
      { type: 'claim_social_security', person: 'p1', date: '2038-03' },
    ];
    expect(ssClaimMarkerYear(points, events)).toBe(2038);
  });

  it('reports no marker when the plan never claims', () => {
    expect(ssClaimMarkerYear(points, [{ type: 'retire', person: 'p1', date: '2028-07' }])).toBe(
      null,
    );
  });

  it('reports no marker for a claim outside the plotted years — off-chart would misplace the story', () => {
    // Claimed while still working (before the first plotted year)…
    expect(
      ssClaimMarkerYear(points, [{ type: 'claim_social_security', person: 'p1', date: '2027-01' }]),
    ).toBe(null);
    // …or past the horizon.
    expect(
      ssClaimMarkerYear(points, [{ type: 'claim_social_security', person: 'p1', date: '2051-01' }]),
    ).toBe(null);
    // Boundary years ARE the chart.
    expect(
      ssClaimMarkerYear(points, [{ type: 'claim_social_security', person: 'p1', date: '2029-12' }]),
    ).toBe(2029);
  });

  it('reports no marker when nothing is plotted', () => {
    expect(
      ssClaimMarkerYear([], [{ type: 'claim_social_security', person: 'p1', date: '2038-03' }]),
    ).toBe(null);
  });
});

describe('withdrawalRateAxisDomain', () => {
  it('pads a tenth of the span beyond the data on each side', () => {
    // Rates 0.05..0.10: span 0.05, pad 0.005 -> [0.045, 0.105].
    const [lo, hi] = withdrawalRateAxisDomain([pt(2029, 0.05), pt(2030, 0.1)]);
    expect(lo).toBeCloseTo(0.045, 12);
    expect(hi).toBeCloseTo(0.105, 12);
  });

  it('gives a flat series half a point of body instead of a zero-height band', () => {
    const [lo, hi] = withdrawalRateAxisDomain([pt(2029, 0.06), pt(2030, 0.06)]);
    expect(lo).toBeCloseTo(0.055, 12);
    expect(hi).toBeCloseTo(0.065, 12);
  });

  it('keeps a spike and a negative rate inside the domain — nothing is clipped', () => {
    // A -1% outside-income year and a 14% RMD-era spike both stay visible;
    // the domain follows the data rather than flattering it.
    const [lo, hi] = withdrawalRateAxisDomain([pt(2029, -0.01), pt(2040, 0.14), pt(2041, 0.07)]);
    expect(lo).toBeLessThan(-0.01);
    expect(hi).toBeGreaterThan(0.14);
  });
});

describe('withdrawalTooltipView', () => {
  it('carries the rate AND both dollar figures, labelled as that year nominal dollars', () => {
    const view = withdrawalTooltipView({
      year: 2029,
      rate: 0.062,
      funded: 62_000,
      opening: 1_000_000,
      inflationIndex: 1,
    });
    expect(view.lines).toEqual([
      { label: 'withdrawal rate', value: '6.2%' },
      { label: 'the portfolio funded', value: '$62,000' },
      { label: 'from an opening balance of', value: '$1,000,000' },
    ]);
    expect(view.note).toBe('Nominal 2029 dollars.');
  });
});

// ---------------------------------------------------------------------------
// withdrawalDelta (via computeDeltas)
// ---------------------------------------------------------------------------

describe('withdrawal-rate strip tile', () => {
  it('states the rate, its year, and its units in the value', () => {
    const d = pick(
      computeDeltas(metrics(0.9, 1, null, { kind: 'rate', rate: 0.062, year: 2029, rails: null, lifetime: null }), null),
      'withdrawal',
    );
    // 0.062 -> "6.2%", and the year rides in the value so the user never
    // wonders which year the rate describes. lifetime is null here, so the
    // value keeps its single-clause sentence — the omission rule.
    expect(d.value).toBe('6.2% of the portfolio in 2029');
    expect(d.label).toBe('Withdrawal rate when fully retired');
    expect(d.tooltip).toContain('Social Security');
    expect(d.tooltip).toContain('Interest and dividends');
    expect(d.note).toBeUndefined();
  });

  it('appends the lifetime-equivalent clause when the plan priced two or more retired years', () => {
    const d = pick(
      computeDeltas(
        metrics(0.9, 1, null, {
          kind: 'rate',
          rate: 0.074,
          year: 2030,
          rails: null,
          lifetime: { rate: 0.046, years: 32 },
        }),
        null,
      ),
      'withdrawal',
    );
    // Both clauses in one value: the first retired year's rate, then the
    // whole retirement restated in the 4%-rule's own initial-rate units.
    expect(d.value).toBe('7.4% of the portfolio in 2030 — lifetime-equivalent 4.6% over 32 years');
    // The tooltip carries the lifetime figure's own two sentences: what was
    // summed (real dollars, gifts included) and the mean-of-percentages
    // warning with its reason.
    expect(d.tooltip).toContain('one-time gifts included');
    expect(d.tooltip).toContain('real start-year dollars');
    expect(d.tooltip).toContain('NOT an average of the yearly percentages');
    expect(d.tooltip).toContain('different denominator');
  });

  it('keeps the delta on the headline rate alone — the lifetime figure gets no second chip', () => {
    // The headline fell 0.4 pts while the lifetime figure ROSE 3 pts: the
    // chip must report the headline's move only. Two deltas on one tile is
    // noise, and the lifetime clause already shows its new value in the same
    // breath (the choice is commented at the delta site).
    const d = pick(
      computeDeltas(
        metrics(0.9, 1, null, {
          kind: 'rate',
          rate: 0.049,
          year: 2029,
          rails: null,
          lifetime: { rate: 0.08, years: 30 },
        }),
        metrics(0.9, 1, null, {
          kind: 'rate',
          rate: 0.053,
          year: 2029,
          rails: null,
          lifetime: { rate: 0.05, years: 30 },
        }),
      ),
      'withdrawal',
    );
    expect(d.change).toBe('-0.4 pts');
    expect(d.direction).toBe('down');
    expect(d.tone).toBe('good');
  });

  it('treats a falling rate as good news, in percentage points', () => {
    // 0.049 - 0.053 = -0.004 -> -0.4 pts, and drawing less is the good move.
    const down = pick(
      computeDeltas(
        metrics(0.9, 1, null, { kind: 'rate', rate: 0.049, year: 2029, rails: null, lifetime: null }),
        metrics(0.9, 1, null, { kind: 'rate', rate: 0.053, year: 2029, rails: null, lifetime: null }),
      ),
      'withdrawal',
    );
    expect(down.change).toBe('-0.4 pts');
    expect(down.direction).toBe('down');
    expect(down.tone).toBe('good');

    const up = pick(
      computeDeltas(
        metrics(0.9, 1, null, { kind: 'rate', rate: 0.053, year: 2029, rails: null, lifetime: null }),
        metrics(0.9, 1, null, { kind: 'rate', rate: 0.049, year: 2029, rails: null, lifetime: null }),
      ),
      'withdrawal',
    );
    expect(up.change).toBe('+0.4 pts');
    expect(up.direction).toBe('up');
    expect(up.tone).toBe('bad');
  });

  it('shows the guardrails second line only when the run carried rails', () => {
    const railed = pick(
      computeDeltas(
        metrics(0.9, 1, null, {
          kind: 'rate',
          rate: 0.062,
          year: 2029,
          rails: { anchor: 0.04, cutAbove: 0.048, raiseBelow: 0.032 },
          lifetime: null,
        }),
        null,
      ),
      'withdrawal',
    );
    // The line is honest about the engine's base: the rails police the living
    // portion, not the all-in headline rate above them.
    expect(railed.note).toBe(
      'Guardrails react to the living portion only: anchored at 4.00% of the start-of-year ' +
        'portfolio, spending is cut above 4.80% and raised below 3.20%.',
    );
    const unrailed = pick(
      computeDeltas(metrics(0.9, 1, null, { kind: 'rate', rate: 0.062, year: 2029, rails: null, lifetime: null }), null),
      'withdrawal',
    );
    expect(unrailed.note).toBeUndefined();
  });

  it('says so plainly when the plan never fully retires', () => {
    const d = pick(
      computeDeltas(metrics(0.9, 1, null, { kind: 'never-retired' }), null),
      'withdrawal',
    );
    expect(d.value).toBe('never fully retired in this horizon');
    expect(d.change).toBeNull();
  });

  it('says so plainly when there is no opening balance to divide by', () => {
    const d = pick(
      computeDeltas(metrics(0.9, 1, null, { kind: 'no-opening-balance', year: 2026 }), null),
      'withdrawal',
    );
    expect(d.value).toBe('not stated — no opening balance for 2026');
  });

  it('reports kind transitions in words, neutrally and without an arrow', () => {
    const gone = pick(
      computeDeltas(
        metrics(0.9, 1, null, { kind: 'never-retired' }),
        metrics(0.9, 1, null, { kind: 'rate', rate: 0.053, year: 2029, rails: null, lifetime: null }),
      ),
      'withdrawal',
    );
    // The rate did not move up or down — it stopped existing because the plan
    // changed shape — so no arrow and no verdict.
    expect(gone.change).toBe('gone (was 5.3%)');
    expect(gone.direction).toBe('flat');
    expect(gone.tone).toBe('neutral');

    const appeared = pick(
      computeDeltas(
        metrics(0.9, 1, null, { kind: 'rate', rate: 0.053, year: 2029, rails: null, lifetime: null }),
        metrics(0.9, 1, null, { kind: 'never-retired' }),
      ),
      'withdrawal',
    );
    expect(appeared.change).toBe('new (was none)');
    expect(appeared.tone).toBe('neutral');

    // Rateless on both sides but for different reasons: the value already
    // states the new reason, so the chip admits there is still nothing to
    // subtract instead of claiming "no change".
    const stillNone = pick(
      computeDeltas(
        metrics(0.9, 1, null, { kind: 'no-opening-balance', year: 2026 }),
        metrics(0.9, 1, null, { kind: 'never-retired' }),
      ),
      'withdrawal',
    );
    expect(stillNone.change).toBe('still none');
    expect(
      pick(
        computeDeltas(
          metrics(0.9, 1, null, { kind: 'never-retired' }),
          metrics(0.9, 1, null, { kind: 'never-retired' }),
        ),
        'withdrawal',
      ).change,
    ).toBe('no change');
  });

  it('is carried by runMetrics off the reference path', () => {
    const m = runMetrics({
      success: 1,
      medianTerminalReal: 2_000_000,
      worstDecileShortfallYears: {},
      referencePath: retirementPath(),
    });
    expect(m.withdrawal).toEqual({ kind: 'rate', rate: 0.062, year: 2029, rails: null, lifetime: null });
  });
});

// ---------------------------------------------------------------------------
// The guardrails pair (guardCut / guardRaise, via computeDeltas)
// ---------------------------------------------------------------------------

describe('guardrails strip tiles', () => {
  const withStats = (g: NonNullable<RunMetrics['guardrails']>) =>
    metrics(0.9, 1, null, undefined, g);

  it('renders the cut tile with conditional depth and duration, floor clause omitted at zero', () => {
    const d = pick(computeDeltas(withStats(guardStats()), null), 'guardCut');
    expect(d.label).toBe('Futures where spending ever gets cut');
    expect(d.value).toBe('23% (typically bottoming at 87% of plan, 5 yrs below)');
    // No future hit the floor, so the value does not mention a 0% event.
    expect(d.value).not.toContain('floor');
    // The tooltip carries the conditionality in words: the parenthetical
    // describes the cut futures ONLY, and an absorbed cut is not a cut.
    expect(d.tooltip).toContain('among those cut futures');
    expect(d.tooltip).toContain('absorbed');
  });

  it('appends the floor clause when somebody actually hit it, naming the floor', () => {
    const d = pick(
      computeDeltas(withStats(guardStats({ floorTouchedFraction: 0.04 })), null),
      'guardCut',
    );
    expect(d.value).toBe(
      '23% (typically bottoming at 87% of plan, 5 yrs below; 4% hit the 70% floor)',
    );
  });

  it('does not round a real floor-touch fraction down to "0%"', () => {
    const d = pick(
      computeDeltas(withStats(guardStats({ floorTouchedFraction: 0.004 })), null),
      'guardCut',
    );
    expect(d.value).toContain('0.4% hit the 70% floor');
  });

  it('pluralises the duration and shows a half-year median as one', () => {
    const one = pick(
      computeDeltas(withStats(guardStats({ medianYearsBelowAmongCut: 1 })), null),
      'guardCut',
    );
    expect(one.value).toContain('1 yr below');
    const half = pick(
      computeDeltas(withStats(guardStats({ medianYearsBelowAmongCut: 3.5 })), null),
      'guardCut',
    );
    expect(half.value).toContain('3.5 yrs below');
  });

  it('renders the never-cut state as words, not an empty parenthetical', () => {
    const d = pick(
      computeDeltas(
        withStats(
          guardStats({
            everCutFraction: 0,
            medianMinFactorAmongCut: null,
            medianYearsBelowAmongCut: null,
          }),
        ),
        null,
      ),
      'guardCut',
    );
    expect(d.value).toBe('none ever');
  });

  it('renders the raise tile as a bare fraction, prosperity tooltip attached', () => {
    const d = pick(computeDeltas(withStats(guardStats()), null), 'guardRaise');
    expect(d.label).toBe('Futures where spending rises above plan');
    expect(d.value).toBe('61%');
    expect(d.tooltip).toContain('prosperity side of the same rails');
    // No ceiling in this run, so the tooltip must not claim one.
    expect(d.tooltip).not.toContain('capped');
  });

  it('names the ceiling in the raise tooltip when the run had one', () => {
    const d = pick(
      computeDeltas(withStats(guardStats({ ceiling: 1 })), null),
      'guardRaise',
    );
    expect(d.tooltip).toContain('capped at 100% of plan');
  });

  it('says the plan never adjusts spending, in words, on a run without rails', () => {
    // The default metrics() fixture has no guardrails stats — a fixed_real
    // run — and both rows still render rather than vanishing.
    const d = computeDeltas(metrics(0.9, 1, null), null);
    expect(pick(d, 'guardCut').value).toBe('never — this plan never adjusts spending');
    expect(pick(d, 'guardRaise').value).toBe('never — this plan never adjusts spending');
  });

  it('scores a falling cut fraction as good news, in percentage points', () => {
    const fell = pick(
      computeDeltas(
        withStats(guardStats({ everCutFraction: 0.18 })),
        withStats(guardStats({ everCutFraction: 0.23 })),
      ),
      'guardCut',
    );
    expect(fell.change).toBe('-5.0 pts');
    expect(fell.direction).toBe('down');
    expect(fell.tone).toBe('good');
    const rose = pick(
      computeDeltas(
        withStats(guardStats({ everCutFraction: 0.3 })),
        withStats(guardStats({ everCutFraction: 0.23 })),
      ),
      'guardCut',
    );
    expect(rose.change).toBe('+7.0 pts');
    expect(rose.tone).toBe('bad');
  });

  it('keeps the raise fraction NEUTRAL in both directions — more raises is not a verdict', () => {
    const more = pick(
      computeDeltas(
        withStats(guardStats({ everAbovePlanFraction: 0.7 })),
        withStats(guardStats({ everAbovePlanFraction: 0.61 })),
      ),
      'guardRaise',
    );
    expect(more.change).toBe('+9.0 pts');
    expect(more.direction).toBe('up');
    expect(more.tone).toBe('neutral');
    const fewer = pick(
      computeDeltas(
        withStats(guardStats({ everAbovePlanFraction: 0.5 })),
        withStats(guardStats({ everAbovePlanFraction: 0.61 })),
      ),
      'guardRaise',
    );
    expect(fewer.direction).toBe('down');
    expect(fewer.tone).toBe('neutral');
  });

  it('reports a policy change as a transition, not an arrow', () => {
    // Guardrails -> fixed_real: the stats vanish because the PLAN changed.
    const gone = pick(
      computeDeltas(metrics(0.9, 1, null), withStats(guardStats())),
      'guardCut',
    );
    expect(gone.change).toBe('gone (was 23%)');
    expect(gone.direction).toBe('flat');
    expect(gone.tone).toBe('neutral');
    const appeared = pick(
      computeDeltas(withStats(guardStats()), metrics(0.9, 1, null)),
      'guardRaise',
    );
    expect(appeared.change).toBe('new (was none)');
    expect(appeared.direction).toBe('flat');
    // Two railless runs have nothing to subtract and say so quietly.
    const still = pick(computeDeltas(metrics(0.9, 1, null), metrics(0.9, 1, null)), 'guardCut');
    expect(still.change).toBe('no change');
  });
});

describe('comparisonNote', () => {
  it('names the pinned baseline when one is set', () => {
    expect(comparisonNote('Base case · a1b2c3d4', true)).toBe(
      'Change vs pinned baseline — Base case · a1b2c3d4',
    );
    // A pinned baseline wins even when a previous run exists.
    expect(comparisonNote('Base case', false)).toBe('Change vs pinned baseline — Base case');
  });

  it('falls back to the previous run, then to nothing', () => {
    expect(comparisonNote(null, true)).toBe('Change vs the previous run');
    expect(comparisonNote(null, false)).toBe('First run — nothing to compare against yet');
  });
});

// ---------------------------------------------------------------------------
// Spending override
// ---------------------------------------------------------------------------

describe('expenseOverride / effectiveMonthly', () => {
  it('reads the override, or nothing when absent', () => {
    const o: AssumptionOverrides = { expenses: { livingMonthly: 5200 } };
    expect(expenseOverride(o, 'livingMonthly')).toBe(5200);
    expect(expenseOverride(o, 'charitableMonthly')).toBeUndefined();
    expect(expenseOverride(undefined, 'livingMonthly')).toBeUndefined();
  });

  it('uses the profile value only when there is no override', () => {
    expect(effectiveMonthly(6000, 5200)).toBe(5200);
    expect(effectiveMonthly(6000, undefined)).toBe(6000);
    // 0 is a real override ("we stop giving"), not an absent one.
    expect(effectiveMonthly(800, 0)).toBe(0);
  });
});

describe('setExpenseOverride', () => {
  it('creates the overrides object when there is none', () => {
    expect(setExpenseOverride(undefined, 'livingMonthly', 5200)).toEqual({
      expenses: { livingMonthly: 5200 },
    });
  });

  it('adds to existing overrides without disturbing them', () => {
    const before: AssumptionOverrides = {
      market: { deterministicInflation: 0.025 },
      expenses: { livingMonthly: 5200 },
    };
    expect(setExpenseOverride(before, 'charitableMonthly', 800)).toEqual({
      market: { deterministicInflation: 0.025 },
      expenses: { livingMonthly: 5200, charitableMonthly: 800 },
    });
    // The input is untouched — the caller still holds the old draft.
    expect(before.expenses).toEqual({ livingMonthly: 5200 });
  });

  it('clearing one of several overrides keeps the rest', () => {
    const before: AssumptionOverrides = {
      expenses: { livingMonthly: 5200, charitableMonthly: 800 },
    };
    expect(setExpenseOverride(before, 'livingMonthly', undefined)).toEqual({
      expenses: { charitableMonthly: 800 },
    });
  });

  it('prunes the empty expenses object, and then the empty overrides object', () => {
    // Last expense override removed and nothing else overridden -> undefined,
    // so the saved scenario file carries no assumption_overrides key at all.
    expect(
      setExpenseOverride({ expenses: { livingMonthly: 5200 } }, 'livingMonthly', undefined),
    ).toBeUndefined();
    // With something else overridden, only `expenses` goes.
    expect(
      setExpenseOverride(
        { aca: { enhancedCreditsExtended: true }, expenses: { livingMonthly: 5200 } },
        'livingMonthly',
        undefined,
      ),
    ).toEqual({ aca: { enhancedCreditsExtended: true } });
  });

  it('stores an explicit zero rather than treating it as a clear', () => {
    expect(setExpenseOverride(undefined, 'charitableMonthly', 0)).toEqual({
      expenses: { charitableMonthly: 0 },
    });
  });

  it('writes the retired side of a pair through the same path', () => {
    // The two halves of a stream are independent overrides, so a plan can drag
    // retirement spending without touching what it spends while working.
    const both = setExpenseOverride(
      setExpenseOverride(undefined, 'livingMonthly', 8000),
      'livingMonthlyRetired',
      7000,
    );
    expect(both).toEqual({ expenses: { livingMonthly: 8000, livingMonthlyRetired: 7000 } });
    expect(setExpenseOverride(both, 'livingMonthly', undefined)).toEqual({
      expenses: { livingMonthlyRetired: 7000 },
    });
  });
});

// ---------------------------------------------------------------------------
// The retired side of a paired stream
// ---------------------------------------------------------------------------

describe('effectiveRetiredMonthly / retiredPlaceholder', () => {
  it('falls back per stream: living keeps working, investing stops', () => {
    // Nothing set anywhere: living is the working figure, investing is nothing.
    expect(effectiveRetiredMonthly('same_as_working', 8000, undefined, undefined)).toBe(8000);
    expect(effectiveRetiredMonthly('stops', 1500, undefined, undefined)).toBe(0);
  });

  it('prefers the plan override, then the profile, then the fallback', () => {
    // Override wins over both.
    expect(effectiveRetiredMonthly('same_as_working', 8000, 7000, 6500)).toBe(6500);
    // No override: the household's own retired figure.
    expect(effectiveRetiredMonthly('same_as_working', 8000, 7000, undefined)).toBe(7000);
    // An explicit 0 is a real answer ("we stop investing"), not an absent one.
    expect(effectiveRetiredMonthly('same_as_working', 8000, 0, undefined)).toBe(0);
    expect(effectiveRetiredMonthly('stops', 1500, undefined, 400)).toBe(400);
  });

  it('follows the WORKING cell’s override, not the profile, for "same as working"', () => {
    // The working cell is overridden to 7,000 for this plan; "same as working"
    // has to mean 7,000, not whatever profile.json still says.
    expect(effectiveRetiredMonthly('same_as_working', 7000, undefined, undefined)).toBe(7000);
  });

  it('says in words what an empty cell will do, or shows the profile figure', () => {
    expect(retiredPlaceholder('same_as_working', undefined)).toBe('same as working');
    expect(retiredPlaceholder('stops', undefined)).toBe('stops');
    // The profile has its own answer: the box is empty because the PLAN isn't
    // overriding it, so the placeholder is that number.
    expect(retiredPlaceholder('same_as_working', 7000)).toBe('7000');
    expect(retiredPlaceholder('stops', 0)).toBe('0');
  });
});

// ---------------------------------------------------------------------------
// Giving after the last paycheck (retirementGiving)
// ---------------------------------------------------------------------------

describe('giving rule — options and resolution', () => {
  it('offers the five ongoing methods in the order they are asked about', () => {
    // The two plain answers first, then stopping, then the rules that can only
    // be expressed as a rule. The Tithe Account is no longer an option here:
    // its pot half is its own section (the un-tithed pot) and its stream half
    // IS '% of investment growth' — on the new-highs base whenever a pot is
    // present.
    expect(GIVING_RULE_OPTIONS.map((o) => o.value)).toEqual([
      'amount',
      'continue',
      'none',
      'percent_of_growth',
      'percent_of_income',
    ]);
    // The labels finish a sentence the column heading starts ("After you stop
    // working: …"), which is what lets them fit a 160px cell.
    expect(GIVING_RULE_OPTIONS.map((o) => o.label)).toEqual([
      'Amount',
      'Same as working',
      'Stops',
      '% of investment growth',
      '% of income drawn',
    ]);
  });

  it('a legacy bundled rule reads as its stream half wherever a rule is displayed', () => {
    // A bundle can still arrive (raw-JSON paste, a cabinet file saved before
    // the split); the select must render its ongoing half rather than crash
    // or fall back to 'continue' — and the pot half must surface through
    // effectivePotSetting, not vanish.
    const bundle: RetirementGivingRule = {
      type: 'tithe_account',
      percent: 0.12,
      deferYears: 5,
      seedFromExistingGains: false,
      distributeYears: 7,
      earlyRelease: false,
    };
    expect(ongoingOf(bundle)).toEqual({ type: 'percent_of_growth', percent: 0.12 });
    expect(effectiveGivingRule(bundle, undefined)).toEqual({
      type: 'percent_of_growth',
      percent: 0.12,
    });
    expect(effectivePotSetting(bundle, undefined, undefined)).toMatchObject({
      percent: 0.12,
      holdYears: 5,
      seedFromGains: false,
      distributeYears: 7,
      earlyRelease: false,
    });
    // The explicit halves outrank the bundle's, in the engine's own order.
    expect(effectivePotSetting(bundle, { holdYears: 2 }, undefined)).toEqual({ holdYears: 2 });
    expect(effectivePotSetting(bundle, { holdYears: 2 }, { enabled: false })).toEqual({
      enabled: false,
    });
  });

  it('tells the truth about the pot in its summary line', () => {
    // The summary is the "profile: …" baseline under the Tithing tab's pot
    // section, so it has to carry the window, the release and the payout —
    // with "up to" only while the safe-zone release (the default) can close
    // the hold early.
    expect(potSummary({ holdYears: 11 })).toBe(
      'Pot opens with 10% of the gains never tithed yet, held soft for up to 11 years ' +
        '(released early on a new real high), the growth tithe accruing into it meanwhile, ' +
        'then paid out over 10 years; the remainder goes to charity at death',
    );
    // Opting out of the release, paying cash through the hold, a custom
    // payout window — each read back in the line.
    expect(potSummary({ holdYears: 1, earlyRelease: false, distributeYears: 1 })).toBe(
      'Pot opens with 10% of the gains never tithed yet, held soft for up to 1 year ' +
        '(no early release), the growth tithe accruing into it meanwhile, then paid out ' +
        'over 1 year; the remainder goes to charity at death',
    );
    expect(potSummary({ holdYears: 6, ongoingDuringHold: 'give_cash', seedFromGains: false })).toBe(
      'Pot opens empty (the past is left alone), held soft for up to 6 years ' +
        '(released early on a new real high), ongoing giving paid in cash meanwhile, ' +
        'then paid out over 10 years; the remainder goes to charity at death',
    );
    // No hold: locked at retirement, and no "during the hold" clause at all.
    expect(potSummary({ holdYears: 0 })).toBe(
      'Pot opens with 10% of the gains never tithed yet, locked at retirement, then paid out ' +
        'over 10 years; the remainder goes to charity at death',
    );
    // No pot and the explicit disable read identically — they mean the same.
    expect(potSummary(undefined)).toBe('No un-tithed pot');
    expect(potSummary({ enabled: false })).toBe('No un-tithed pot');
    // And the long help names the mechanics the numbers hang off.
    expect(potHelp({ holdYears: 11 })).toContain('last, and for good');
    expect(potHelp({ holdYears: 11 })).toContain('new REAL (inflation-adjusted) spendable high');
    expect(potHelp({ holdYears: 11, earlyRelease: false })).toContain('waits out the full hold');
    expect(potHelp({ holdYears: 11, ongoingDuringHold: 'give_cash' })).toContain(
      'fully independent of the pot',
    );
  });

  it('round-trips every pot field through its setter, absence meaning the default', () => {
    const pot: UntithedPotPolicy = { holdYears: 5 };
    // percent: clamped into 0..1; exactly the default 10% removes the key
    // (absence IS the tithe), so an untouched pot writes nothing extra.
    expect(setPotPercent(pot, 0.15)).toMatchObject({ percent: 0.15 });
    expect('percent' in setPotPercent(pot, 0.1)).toBe(false);
    expect(setPotPercent(pot, 2)).toMatchObject({ percent: 1 });
    expect(setPotPercent(setPotPercent(pot, 0.15), undefined)).toMatchObject({ percent: 0.15 });
    // holdYears: required, clamped, and a blank keeps the last value — 0 is a
    // real, very different instruction and must never arrive by mis-click.
    expect(setPotHoldYears(pot, 12)).toMatchObject({ holdYears: 12 });
    expect(setPotHoldYears(pot, 99)).toMatchObject({ holdYears: 30 });
    expect(setPotHoldYears(pot, undefined)).toBe(pot);
    // distributeYears: clamped into 1..30; blank removes the key (absence IS
    // the default 10), so an untouched plan writes nothing into the file.
    const set = setPotDistributeYears(pot, 7);
    expect(set).toMatchObject({ distributeYears: 7 });
    expect(setPotDistributeYears(set, 0)).toMatchObject({ distributeYears: 1 });
    expect(setPotDistributeYears(set, 99)).toMatchObject({ distributeYears: 30 });
    expect('distributeYears' in setPotDistributeYears(set, undefined)).toBe(false);
    // earlyRelease: ON deletes the key (absent means true); OFF writes false.
    const off = setPotEarlyRelease(pot, false);
    expect(off).toMatchObject({ earlyRelease: false });
    expect('earlyRelease' in setPotEarlyRelease(off, true)).toBe(false);
    // seedFromGains follows the same convention (absent means true)...
    const noSeed = setPotSeedFromGains(pot, false);
    expect(noSeed).toMatchObject({ seedFromGains: false });
    expect('seedFromGains' in setPotSeedFromGains(noSeed, true)).toBe(false);
    // ...and so does ongoingDuringHold (absent means accrue_to_pot, the old
    // bundled behaviour — which is exactly why the migration can omit it).
    const cash = setPotOngoingDuringHold(pot, 'give_cash');
    expect(cash).toMatchObject({ ongoingDuringHold: 'give_cash' });
    expect('ongoingDuringHold' in setPotOngoingDuringHold(cash, 'accrue_to_pot')).toBe(false);
    // The allocation key is deleted, never written back as the parent's mix.
    const mixed = setPotAllocation(pot, { stocks: 0.6, bonds: 0.4, bills: 0 });
    expect(mixed).toMatchObject({ allocation: { stocks: 0.6, bonds: 0.4, bills: 0 } });
    expect('allocation' in setPotAllocation(mixed, undefined)).toBe(false);
    // None of it mutated the original.
    expect(pot).toEqual({ holdYears: 5 });
  });

  it('writes and clears the pot override, pruning like every other override', () => {
    expect(setPotOverride(undefined, { holdYears: 5 })).toEqual({
      expenses: { untithedPot: { holdYears: 5 } },
    });
    // The explicit disable is a real override — the spelling that suppresses
    // an inherited pot — and must survive a write.
    expect(setPotOverride(undefined, { enabled: false })).toEqual({
      expenses: { untithedPot: { enabled: false } },
    });
    expect(
      setPotOverride({ expenses: { untithedPot: { holdYears: 5 } } }, undefined),
    ).toBeUndefined();
    expect(potOverride({ expenses: { untithedPot: { enabled: false } } })).toEqual({
      enabled: false,
    });
    expect(potOverride(undefined)).toBeUndefined();
  });

  it('resolves scenario override → profile → continue', () => {
    const growth: RetirementGivingRule = { type: 'percent_of_growth', percent: 0.1 };
    // Scenario wins over the profile.
    expect(effectiveGivingRule({ type: 'none' }, growth)).toEqual(growth);
    // No scenario override: the household's own answer.
    expect(effectiveGivingRule({ type: 'none' }, undefined)).toEqual({ type: 'none' });
    // Absent in both places means 'continue' — the engine's documented default.
    expect(effectiveGivingRule(undefined, undefined)).toEqual({ type: 'continue' });
    expect(DEFAULT_GIVING_RULE).toEqual({ type: 'continue' });
  });

  it('reads the override out of the scenario overrides', () => {
    expect(givingOverride({ expenses: { retirementGiving: { type: 'none' } } })).toEqual({
      type: 'none',
    });
    expect(givingOverride({ expenses: { livingMonthly: 5200 } })).toBeUndefined();
    expect(givingOverride(undefined)).toBeUndefined();
  });
});

describe('setGivingOverride', () => {
  it('creates, coexists with the monthly overrides, and never mutates', () => {
    expect(setGivingOverride(undefined, { type: 'none' })).toEqual({
      expenses: { retirementGiving: { type: 'none' } },
    });
    const before: AssumptionOverrides = { expenses: { charitableMonthly: 1250 } };
    expect(setGivingOverride(before, { type: 'percent_of_growth', percent: 0.1 })).toEqual({
      expenses: { charitableMonthly: 1250, retirementGiving: { type: 'percent_of_growth', percent: 0.1 } },
    });
    expect(before.expenses).toEqual({ charitableMonthly: 1250 });
  });

  it('prunes back to undefined when the rule is the only override', () => {
    expect(
      setGivingOverride({ expenses: { retirementGiving: { type: 'none' } } }, undefined),
    ).toBeUndefined();
    // With a monthly override still set, only the rule goes.
    expect(
      setGivingOverride(
        { expenses: { livingMonthly: 5200, retirementGiving: { type: 'none' } } },
        undefined,
      ),
    ).toEqual({ expenses: { livingMonthly: 5200 } });
  });
});

describe('givingRuleOfType', () => {
  it('carries no parameters into the two parameterless rules', () => {
    expect(givingRuleOfType('continue', { type: 'percent_of_growth', percent: 0.1 })).toEqual({
      type: 'continue',
    });
    expect(givingRuleOfType('none')).toEqual({ type: 'none' });
  });

  it('opens a first "Amount" rule on the working-years stream', () => {
    // Choosing "Amount" from 'continue' should not drop the user into $0 —
    // which is the 'Stops' rule wearing another name. It opens on what
    // 'continue' meant (the working stream) so he edits DOWN from a real
    // number.
    expect(givingRuleOfType('amount', { type: 'continue' }, 1250)).toEqual({
      type: 'amount',
      monthly: 1250,
    });
    // No seed offered: $0, and never a negative one.
    expect(givingRuleOfType('amount')).toEqual({ type: 'amount', monthly: 0 });
    expect(givingRuleOfType('amount', { type: 'none' }, -50)).toEqual({
      type: 'amount',
      monthly: 0,
    });
    // An amount already typed survives a round trip through another rule's
    // shape only when it is still an amount rule — the figure the user typed
    // is the figure he meant.
    expect(givingRuleOfType('amount', { type: 'amount', monthly: 400 }, 1250)).toEqual({
      type: 'amount',
      monthly: 400,
    });
    // Leaving 'amount' for a parameterless rule carries nothing.
    expect(givingRuleOfType('none', { type: 'amount', monthly: 400 })).toEqual({ type: 'none' });
  });

  it('seeds a first percentage rule at 10%', () => {
    expect(DEFAULT_GIVING_PERCENT).toBe(0.1);
    expect(givingRuleOfType('percent_of_growth', { type: 'continue' })).toEqual({
      type: 'percent_of_growth',
      percent: 0.1,
    });
    expect(givingRuleOfType('percent_of_income')).toEqual({
      type: 'percent_of_income',
      percent: 0.1,
    });
  });

  it('keeps the percentage the user typed when switching between percentage rules', () => {
    const growth: RetirementGivingRule = {
      type: 'percent_of_growth',
      percent: 0.08,
      smoothingYears: 3,
      capMonthly: 2000,
    };
    // Smoothing and the cap belong to the growth rule only, so they do not
    // travel to the income rule...
    const income = givingRuleOfType('percent_of_income', growth);
    expect(income).toEqual({ type: 'percent_of_income', percent: 0.08 });
    // ...and switching back keeps the 8% but starts the growth extras clean.
    expect(givingRuleOfType('percent_of_growth', income)).toEqual({
      type: 'percent_of_growth',
      percent: 0.08,
    });
    // Growth -> growth keeps everything.
    expect(givingRuleOfType('percent_of_growth', growth)).toEqual(growth);
  });
});

describe('giving rule field setters', () => {
  const growth: RetirementGivingRule = { type: 'percent_of_growth', percent: 0.1 };

  it('clamps the percentage into the schema range and ignores a blank box', () => {
    expect(setGivingPercent(growth, 0.125)).toEqual({ type: 'percent_of_growth', percent: 0.125 });
    // 150% typed into the field is 1.5 -> clamped to 1 (100%), which the
    // scenario schema accepts; -5% clamps to 0.
    expect(setGivingPercent(growth, 1.5)).toEqual({ type: 'percent_of_growth', percent: 1 });
    expect(setGivingPercent(growth, -0.05)).toEqual({ type: 'percent_of_growth', percent: 0 });
    // Blanking keeps the last percentage rather than producing a percent-less rule.
    expect(setGivingPercent(growth, undefined)).toEqual(growth);
    // Rules with no percentage are returned untouched.
    expect(setGivingPercent({ type: 'none' }, 0.2)).toEqual({ type: 'none' });
  });

  it('stores smoothing only when it changes the arithmetic', () => {
    expect(setGivingSmoothing(growth, 3)).toEqual({ ...growth, smoothingYears: 3 });
    // 2.6 years is not a thing; round to 3.
    expect(setGivingSmoothing(growth, 2.6)).toEqual({ ...growth, smoothingYears: 3 });
    // The schema tops out at 10.
    expect(setGivingSmoothing(growth, 12)).toEqual({ ...growth, smoothingYears: 10 });
    // 1 IS "last year only" (the engine's default), so it is written as absent
    // — the scenario file then says plainly that it is not smoothing.
    expect(setGivingSmoothing({ ...growth, smoothingYears: 3 }, 1)).toEqual(growth);
    expect(setGivingSmoothing({ ...growth, smoothingYears: 3 }, undefined)).toEqual(growth);
    expect(setGivingSmoothing({ type: 'percent_of_income', percent: 0.1 }, 3)).toEqual({
      type: 'percent_of_income',
      percent: 0.1,
    });
  });

  it('stores the flat amount, floors it at zero, and ignores a blank box', () => {
    const amount: RetirementGivingRule = { type: 'amount', monthly: 1250 };
    expect(setGivingAmount(amount, 400)).toEqual({ type: 'amount', monthly: 400 });
    // $0 is a legitimate answer typed deliberately; a NEGATIVE gift is not.
    expect(setGivingAmount(amount, 0)).toEqual({ type: 'amount', monthly: 0 });
    expect(setGivingAmount(amount, -100)).toEqual({ type: 'amount', monthly: 0 });
    // Blanking keeps the last amount rather than silently committing $0, which
    // would be the 'Stops' rule under another name.
    expect(setGivingAmount(amount, undefined)).toEqual(amount);
    // Rules with no amount are returned untouched.
    expect(setGivingAmount({ type: 'none' }, 400)).toEqual({ type: 'none' });
  });

  it('stores, floors and clears the monthly cap', () => {
    expect(setGivingCap(growth, 2000)).toEqual({ ...growth, capMonthly: 2000 });
    expect(setGivingCap(growth, -100)).toEqual({ ...growth, capMonthly: 0 });
    expect(setGivingCap({ ...growth, capMonthly: 2000 }, undefined)).toEqual(growth);
    expect(setGivingCap({ type: 'none' }, 2000)).toEqual({ type: 'none' });
  });
});

describe('annualGivingEquivalent', () => {
  it('prices the three rules that can be priced before the run', () => {
    // 1,250/mo x 12 = 15,000/yr, in today's dollars.
    expect(annualGivingEquivalent({ type: 'continue' }, 1250)).toBe(15_000);
    // The amount rule prices off its OWN figure, not the working stream:
    // 400 x 12 = 4,800.
    expect(annualGivingEquivalent({ type: 'amount', monthly: 400 }, 1250)).toBe(4_800);
    expect(annualGivingEquivalent({ type: 'none' }, 1250)).toBe(0);
  });

  it('refuses to invent a figure for the percentage rules', () => {
    // Their base (last year's real growth / SS + withdrawals) only exists once
    // the simulation has run, so the UI says "varies" instead of guessing.
    expect(annualGivingEquivalent({ type: 'percent_of_growth', percent: 0.1 }, 1250)).toBeNull();
    expect(annualGivingEquivalent({ type: 'percent_of_income', percent: 0.1 }, 1250)).toBeNull();
  });

  it('says what an unknowable amount depends on, rule by rule', () => {
    expect(annualGivingNote({ type: 'continue' }, 1250)).toBe('$15,000/yr');
    expect(annualGivingNote({ type: 'amount', monthly: 400 }, 1250)).toBe('$4,800/yr');
    expect(annualGivingNote({ type: 'none' }, 1250)).toBe('$0/yr');
    expect(annualGivingNote({ type: 'percent_of_growth', percent: 0.1 }, 1250)).toBe(
      'annual amount varies with the markets',
    );
    // The income rule tracks the draw, not the market directly.
    expect(annualGivingNote({ type: 'percent_of_income', percent: 0.1 }, 1250)).toBe(
      'annual amount varies with what you draw',
    );
  });
});

describe('givingRuleSummary / givingRuleHelp', () => {
  it('prices the continue rule off the stream the run will actually use', () => {
    expect(givingRuleSummary({ type: 'continue' }, 1250)).toBe(
      'Keep giving the same amount — $1,250/mo ($15,000/yr), inflation-adjusted',
    );
    // Without a monthly figure it is named but not priced.
    expect(givingRuleSummary({ type: 'continue' })).toBe(
      'Keep giving the same amount, inflation-adjusted',
    );
    expect(givingRuleSummary({ type: 'none' })).toContain('$0');
  });

  it('prices the amount rule off its own figure', () => {
    // 400/mo x 12 = 4,800/yr — the working stream is irrelevant here, which is
    // the whole point of choosing an amount instead of 'continue'.
    expect(givingRuleSummary({ type: 'amount', monthly: 400 }, 1250)).toBe(
      'Give $400/mo ($4,800/yr), inflation-adjusted',
    );
    const help = givingRuleHelp({ type: 'amount', monthly: 400 });
    expect(help).toContain('$400/mo');
    // The one behavioural difference from the working stream: expense_change
    // events no longer retarget it.
    expect(help).toContain('expense-change');
  });

  it('states the percentage without trailing-zero noise, plus smoothing and cap', () => {
    expect(givingRuleSummary({ type: 'percent_of_growth', percent: 0.1 })).toBe(
      "10% of last year's real investment growth",
    );
    expect(givingRuleSummary({ type: 'percent_of_income', percent: 0.125 })).toBe(
      "12.5% of last year's Social Security plus withdrawals",
    );
    expect(
      givingRuleSummary({
        type: 'percent_of_growth',
        percent: 0.1,
        smoothingYears: 3,
        capMonthly: 2000,
      }),
      // 2,000/mo x 12 = 24,000/yr.
    ).toBe(
      "10% of last year's real investment growth, averaged over the last 3 years, capped at " +
        '$2,000/mo ($24,000/yr)',
    );
    // smoothingYears: 1 is "last year only" — no window clause.
    expect(givingRuleSummary({ type: 'percent_of_growth', percent: 0.1, smoothingYears: 1 })).toBe(
      "10% of last year's real investment growth",
    );
  });

  it('states the mechanic each rule actually uses', () => {
    const growthHelp = givingRuleHelp({ type: 'percent_of_growth', percent: 0.1 });
    expect(growthHelp).toContain('LAST');
    expect(growthHelp).toContain('$0'); // a down year gives nothing
    expect(givingRuleHelp({ type: 'percent_of_growth', percent: 0.1, smoothingYears: 3 })).toContain(
      "last 3 years' growth",
    );
    expect(
      givingRuleHelp({ type: 'percent_of_growth', percent: 0.1, capMonthly: 2000 }),
    ).toContain('$2,000/mo');
    expect(givingRuleHelp({ type: 'percent_of_income', percent: 0.1 })).toContain(
      'Social Security',
    );
    expect(givingRuleHelp({ type: 'none' })).toContain('$0');
  });
});

// ---------------------------------------------------------------------------
// Income (assumption_overrides.income)
// ---------------------------------------------------------------------------

describe('retirement income override', () => {
  it('reads the override, or nothing when absent', () => {
    const o: AssumptionOverrides = { income: { retirementMonthly: 2000 } };
    expect(retirementIncomeOverride(o)).toBe(2000);
    expect(retirementIncomeOverride({ expenses: { livingMonthly: 8000 } })).toBeUndefined();
    expect(retirementIncomeOverride(undefined)).toBeUndefined();
    expect(retirementTaxableOverride(o)).toBeUndefined();
    expect(retirementTaxableOverride({ income: { retirementIncomeTaxable: false } })).toBe(false);
  });

  it('creates, coexists with the expense overrides, and never mutates', () => {
    expect(setRetirementIncomeOverride(undefined, 2000)).toEqual({
      income: { retirementMonthly: 2000 },
    });
    const before: AssumptionOverrides = { expenses: { livingMonthly: 8000 } };
    expect(setRetirementIncomeOverride(before, 2000)).toEqual({
      expenses: { livingMonthly: 8000 },
      income: { retirementMonthly: 2000 },
    });
    expect(before).toEqual({ expenses: { livingMonthly: 8000 } });
  });

  it('prunes the empty income block, then the empty overrides object', () => {
    expect(
      setRetirementIncomeOverride({ income: { retirementMonthly: 2000 } }, undefined),
    ).toBeUndefined();
    // The taxable flag alone keeps the block alive.
    expect(
      setRetirementIncomeOverride(
        { income: { retirementMonthly: 2000, retirementIncomeTaxable: false } },
        undefined,
      ),
    ).toEqual({ income: { retirementIncomeTaxable: false } });
    // Something else overridden: only `income` goes.
    expect(
      setRetirementIncomeOverride(
        { expenses: { livingMonthly: 8000 }, income: { retirementMonthly: 2000 } },
        undefined,
      ),
    ).toEqual({ expenses: { livingMonthly: 8000 } });
  });

  it('stores an explicit zero rather than treating it as a clear', () => {
    // "The consulting dries up" is a real what-if, distinct from "use whatever
    // the profile says".
    expect(setRetirementIncomeOverride({ income: { retirementMonthly: 2000 } }, 0)).toEqual({
      income: { retirementMonthly: 0 },
    });
  });

  it('resolves plan → profile → 0', () => {
    expect(effectiveRetirementIncome(1000, 2000)).toBe(2000);
    expect(effectiveRetirementIncome(1000, undefined)).toBe(1000);
    expect(effectiveRetirementIncome(undefined, undefined)).toBe(0);
    // An explicit 0 override beats a profile figure.
    expect(effectiveRetirementIncome(1000, 0)).toBe(0);
  });

  it('says in words what an empty box will do', () => {
    expect(retirementIncomePlaceholder(undefined)).toBe('none');
    expect(retirementIncomePlaceholder(1000)).toBe('1000');
  });
});

describe('retirement income — taxable or not', () => {
  it('resolves plan → profile → taxable', () => {
    // Absent everywhere means TAXABLE: the honest default for earned money.
    expect(effectiveRetirementTaxable(undefined, undefined)).toBe(true);
    expect(effectiveRetirementTaxable(false, undefined)).toBe(false);
    expect(effectiveRetirementTaxable(false, true)).toBe(true);
    expect(effectiveRetirementTaxable(undefined, false)).toBe(false);
  });

  it('writes an override only when the choice differs from the profile', () => {
    // Profile absent (= taxable). Choosing "taxable" is already what the
    // profile says, so nothing is written and the plan stays clean.
    expect(setRetirementTaxableChoice(undefined, undefined, true)).toBeUndefined();
    expect(setRetirementTaxableChoice(undefined, undefined, false)).toEqual({
      income: { retirementIncomeTaxable: false },
    });
    // Profile says false: choosing "not taxable" clears any override...
    expect(
      setRetirementTaxableChoice({ income: { retirementIncomeTaxable: true } }, false, false),
    ).toBeUndefined();
    // ...and choosing "taxable" writes one.
    expect(setRetirementTaxableChoice(undefined, false, true)).toEqual({
      income: { retirementIncomeTaxable: true },
    });
  });

  it('keeps the amount override when the taxable choice collapses to the profile', () => {
    expect(
      setRetirementTaxableChoice(
        { income: { retirementMonthly: 2000, retirementIncomeTaxable: false } },
        undefined,
        true,
      ),
    ).toEqual({ income: { retirementMonthly: 2000 } });
  });
});

describe('working income summary', () => {
  const income = {
    salaries: { p1: 180_000, p2: 20_000 },
    contribution401k: 23_500,
    employerMatch401k: 9_000,
  };

  it('totals the salaries', () => {
    // 180,000 + 20,000 = 200,000.
    expect(annualSalaryTotal(income.salaries)).toBe(200_000);
    expect(annualSalaryTotal({})).toBe(0);
  });

  it('lists a line per person, then the 401(k) context', () => {
    expect(
      workingIncomeLines(income, [
        { id: 'p1', name: 'Alex' },
        { id: 'p2', name: 'Sam' },
      ]),
    ).toEqual([
      { label: 'Alex salary', amount: 180_000 },
      { label: 'Sam salary', amount: 20_000 },
      { label: '401(k) deferral', amount: 23_500 },
      { label: 'Employer match', amount: 9_000 },
    ]);
  });

  it('shows a person with no salary entry as $0 rather than dropping them', () => {
    expect(workingIncomeLines(income, [{ id: 'ghost', name: 'Pat' }])[0]).toEqual({
      label: 'Pat salary',
      amount: 0,
    });
  });
});

// ---------------------------------------------------------------------------
// Autosave
// ---------------------------------------------------------------------------

describe('planSaveKey', () => {
  const base: Scenario = { name: 'Plan', events: [] };

  it('ignores key order, so a re-render never triggers a write', () => {
    // stableStringify sorts keys: both objects serialize as {"events":[],"name":"Plan"}.
    const reordered = { events: [], name: 'Plan' } as Scenario;
    expect(planSaveKey(reordered)).toBe(planSaveKey(base));
  });

  it('moves when any part of the plan moves', () => {
    expect(planSaveKey({ ...base, autoSepp: false })).not.toBe(planSaveKey(base));
    expect(
      planSaveKey({ ...base, assumption_overrides: { expenses: { livingMonthly: 1 } } }),
    ).not.toBe(planSaveKey(base));
    expect(
      planSaveKey({ ...base, events: [{ type: 'retire', person: 'p1', date: '2033-06' }] }),
    ).not.toBe(planSaveKey(base));
  });

  it('treats an undefined-valued key as absent (autoSeppPatch(true) is a no-op)', () => {
    // autoSeppPatch(true) writes `autoSepp: undefined`; stableStringify drops
    // undefined values, so turning the bridge off and back on leaves the plan
    // byte-identical and no save is issued.
    const off = planSaveKey({ ...base, ...autoSeppPatch(false) });
    const back = planSaveKey({ ...base, ...autoSeppPatch(false), ...autoSeppPatch(true) });
    expect(back).toBe(planSaveKey(base));
    expect(off).not.toBe(back);
  });
});

describe('saveFailureText', () => {
  it('says nothing at all while saving is working', () => {
    // The quiet "Saved — every change writes itself to plan.json" line is gone
    // from the panel; these three states now have no text because they have no
    // termA to put it in.
    expect(saveFailureText({ status: 'idle' })).toBeNull();
    expect(saveFailureText({ status: 'saving' })).toBeNull();
    expect(saveFailureText({ status: 'saved' })).toBeNull();
  });

  it('shouts, and repeats the reason, when a write fails', () => {
    // No manual save exists to fall back on, so the message must carry the
    // server's own words rather than a generic "couldn't save".
    expect(saveFailureText({ status: 'error', message: 'ECONNREFUSED' })).toBe(
      'NOT SAVED — ECONNREFUSED',
    );
  });
});

describe('runInputKey', () => {
  const scenario: Scenario = { name: 'Base case', events: [] };

  it('is stable across key order', () => {
    const a = runInputKey(scenario, { mode: 'montecarlo', paths: 1000, seed: 42 });
    const b = runInputKey({ events: [], name: 'Base case' } as Scenario, {
      mode: 'montecarlo',
      paths: 1000,
      seed: 42,
    });
    expect(a).toBe(b);
  });

  it('changes when any run input changes', () => {
    const a = runInputKey(scenario, { mode: 'montecarlo', paths: 1000, seed: 42 });
    expect(a).not.toBe(runInputKey(scenario, { mode: 'montecarlo', paths: 1000, seed: 43 }));
    expect(a).not.toBe(runInputKey(scenario, { mode: 'montecarlo', paths: 5000, seed: 42 }));
    expect(a).not.toBe(runInputKey(scenario, { mode: 'historical', paths: 1000, seed: 42 }));
    expect(a).not.toBe(
      runInputKey({ ...scenario, name: 'Other' }, { mode: 'montecarlo', paths: 1000, seed: 42 }),
    );
  });

  it('changes when the giving rule changes, and comes back when it is reset', () => {
    // The rule lives in assumption_overrides.expenses, so the live loop only
    // re-runs for it if the run key moves — which is what this pins down.
    const params = { mode: 'montecarlo', paths: 1000, seed: 42 } as const;
    const profileDefault = runInputKey(scenario, params);
    const stopped = runInputKey(
      { ...scenario, assumption_overrides: setGivingOverride(undefined, { type: 'none' }) },
      params,
    );
    const growth = runInputKey(
      {
        ...scenario,
        assumption_overrides: setGivingOverride(undefined, {
          type: 'percent_of_growth',
          percent: 0.1,
        }),
      },
      params,
    );
    expect(stopped).not.toBe(profileDefault);
    expect(growth).not.toBe(stopped);
    // Even a parameter of the same rule is a different run.
    const smoothed = runInputKey(
      {
        ...scenario,
        assumption_overrides: setGivingOverride(undefined, {
          type: 'percent_of_growth',
          percent: 0.1,
          smoothingYears: 3,
        }),
      },
      params,
    );
    expect(smoothed).not.toBe(growth);
    // Resetting to the profile prunes the override away entirely, so the key
    // is the original one again rather than a third variant.
    const reset = runInputKey(
      {
        ...scenario,
        assumption_overrides: setGivingOverride({ expenses: { retirementGiving: { type: 'none' } } }, undefined),
      },
      params,
    );
    expect(reset).toBe(profileDefault);
  });

  it('changes when the 72(t) toggle is unchecked, and comes back when re-checked', () => {
    // The toggle writes a scenario FIELD rather than an event, so this is what
    // makes the Workbench's live loop re-run for it: the run key must move.
    const params = { mode: 'montecarlo', paths: 1000, seed: 42 } as const;
    const on = runInputKey(scenario, params);
    const off = runInputKey({ ...scenario, ...autoSeppPatch(false) }, params);
    expect(off).not.toBe(on);
    // Re-checking clears the field (undefined), which hashes identically to a
    // scenario that never had it — the same run, not a third one.
    const back = runInputKey(
      { ...scenario, ...autoSeppPatch(false), ...autoSeppPatch(true) },
      params,
    );
    expect(back).toBe(on);
  });
});

// ---------------------------------------------------------------------------
// Run settings
// ---------------------------------------------------------------------------

describe('parsePositiveInt', () => {
  it('parses valid positive integers', () => {
    expect(parsePositiveInt('2500', 1000)).toBe(2500);
    // trims whitespace
    expect(parsePositiveInt('  42 ', 7)).toBe(42);
    // floors decimals: floor(10.9) = 10
    expect(parsePositiveInt('10.9', 1000)).toBe(10);
  });

  it('falls back for invalid input', () => {
    expect(parsePositiveInt('', 1000)).toBe(1000);
    expect(parsePositiveInt('abc', 1000)).toBe(1000);
    // zero and negatives are not valid path counts
    expect(parsePositiveInt('0', 1000)).toBe(1000);
    expect(parsePositiveInt('-5', 1000)).toBe(1000);
  });
});

describe('parseSeed', () => {
  it('parses any integer including negatives', () => {
    expect(parseSeed('42', 7)).toBe(42);
    expect(parseSeed('-3', 7)).toBe(-3);
    // floors decimals: floor(3.7) = 3
    expect(parseSeed('3.7', 7)).toBe(3);
  });

  it('falls back for empty or non-numeric input', () => {
    expect(parseSeed('', 7)).toBe(7);
    expect(parseSeed('x', 7)).toBe(7);
  });
});

describe('defaultRunSettings / resolveRunParams', () => {
  const profileSettings = { mcPathsInteractive: 1000, seed: 42 };

  it('defaults to an interactive Monte Carlo run on the profile seed', () => {
    expect(defaultRunSettings(profileSettings)).toEqual({
      mode: 'montecarlo',
      pathsText: '1000',
      finalQuality: false,
      seedText: '42',
      seedUnlocked: false,
    });
    expect(resolveRunParams(defaultRunSettings(profileSettings), profileSettings)).toEqual({
      mode: 'montecarlo',
      paths: 1000,
      seed: 42,
    });
  });

  it('parses the typed path count, falling back for junk', () => {
    const s = defaultRunSettings(profileSettings);
    expect(resolveRunParams({ ...s, pathsText: '2500' }, profileSettings).paths).toBe(2500);
    // Unparseable / non-positive input keeps the profile's interactive count.
    expect(resolveRunParams({ ...s, pathsText: '' }, profileSettings).paths).toBe(1000);
    expect(resolveRunParams({ ...s, pathsText: '0' }, profileSettings).paths).toBe(1000);
  });

  it('omits paths outside Monte Carlo', () => {
    const s = defaultRunSettings(profileSettings);
    expect(resolveRunParams({ ...s, mode: 'deterministic' }, profileSettings)).toEqual({
      mode: 'deterministic',
      seed: 42,
    });
    expect(resolveRunParams({ ...s, mode: 'historical' }, profileSettings)).toEqual({
      mode: 'historical',
      seed: 42,
    });
  });

  it('parses the seed, falling back to the profile seed', () => {
    const s = defaultRunSettings(profileSettings);
    expect(resolveRunParams({ ...s, seedText: '7' }, profileSettings).seed).toBe(7);
    expect(resolveRunParams({ ...s, seedText: 'nope' }, profileSettings).seed).toBe(42);
  });
});

// ---------------------------------------------------------------------------
// Baseline overlay
// ---------------------------------------------------------------------------

describe('alignBaselineP50', () => {
  const baseline: FanChart = {
    years: [2027, 2028, 2029],
    p10: [10, 20, 30],
    p25: [40, 50, 60],
    p50: [100, 200, 300],
    p75: [400, 500, 600],
    p90: [700, 800, 900],
  };

  it('re-indexes the baseline median onto the current fan years', () => {
    // Current fan starts a year earlier and ends a year earlier: 2026 has no
    // baseline value (undefined = a gap), 2027 -> 100, 2028 -> 200.
    expect(alignBaselineP50([2026, 2027, 2028], baseline)).toEqual([undefined, 100, 200]);
  });

  it('covers every year when the two fans line up exactly', () => {
    expect(alignBaselineP50([2027, 2028, 2029], baseline)).toEqual([100, 200, 300]);
  });

  it('returns all gaps when the fans do not overlap', () => {
    expect(alignBaselineP50([2040, 2041], baseline)).toEqual([undefined, undefined]);
  });
});

describe('cash yield override (topic 3)', () => {
  /*
   * The knob has to survive the round trip on its own. It is built OUTSIDE
   * buildMarketOverride, which only emits anything when the whole
   * deterministic-real trio is present — so the risk this pins is a household
   * that asks for 4.25% on its savings and silently gets nothing because it
   * did not also pin stock and bond returns.
   */
  const defaults = { stocks: 0.05, bonds: 0.02, bills: 0.005, inflation: 0.025 };

  it('writes the yield with no deterministic returns set', () => {
    const fields = overrideFieldsFrom(undefined);
    const out = buildOverrides({ ...fields, market: { ...fields.market, cashYield: '0.0425' } }, defaults);
    expect(out?.market?.cashYieldNominal).toBe(0.0425);
    // ...and does NOT invent a deterministic set as a side effect.
    expect(out?.market?.deterministicReal).toBeUndefined();
  });

  it('round-trips an existing override back into the form', () => {
    const fields = overrideFieldsFrom({ market: { cashYieldNominal: 0.05 } });
    expect(fields.market.cashYield).toBe('0.05');
    expect(buildOverrides(fields, defaults)?.market?.cashYieldNominal).toBe(0.05);
  });

  it('rejects a yield outside 0..25% rather than saving it', () => {
    const fields = overrideFieldsFrom(undefined);
    const bad = { ...fields, market: { ...fields.market, cashYield: '0.9' } };
    expect(overrideFieldErrors(bad).cashYield).toMatch(/between 0 and 0.25/);
    expect(buildOverrides(bad, defaults)?.market?.cashYieldNominal).toBeUndefined();
    const negative = { ...fields, market: { ...fields.market, cashYield: '-0.01' } };
    expect(overrideFieldErrors(negative).cashYield).toBeDefined();
  });

  it('leaves the overrides alone when the field is blank', () => {
    const fields = overrideFieldsFrom(undefined);
    expect(buildOverrides(fields, defaults)?.market?.cashYieldNominal).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Per-policy dispositions (lifeInsurancePolicyPlans)
// ---------------------------------------------------------------------------
//
// A representative two policies, verbatim: the section exists because the
// legacy three-box override cannot reach either of them (a non-empty policy
// list supersedes those fields in the engine), so the card grew one row per
// policy writing assumption_overrides.expenses.lifeInsurancePolicyPlans.

const termAPolicy: LifeInsurancePolicy = {
  id: 'term-a-2500k',
  label: 'Northbridge Term — $2.5M term',
  insured: 'p1',
  premiumMonthly: 158.33,
  deathBenefit: 2_500_000,
  termEnd: '2032-12',
};

const termBPolicy: LifeInsurancePolicy = {
  id: 'term-b-1000k',
  label: 'Cardinal Mutual — $1M 10-year term',
  insured: 'p1',
  premiumMonthly: 141.67,
  deathBenefit: 1_000_000,
  termEnd: '2030-12',
};

const RETIRE_BOTH_2028: ScenarioEvent[] = [
  { type: 'retire', person: 'p1', date: '2028-06' },
  { type: 'retire', person: 'p2', date: '2028-06' },
];

describe('policyPlanOverride / setPolicyPlanOverride', () => {
  it('reads one policy id, or nothing when absent', () => {
    const o: AssumptionOverrides = {
      expenses: { lifeInsurancePolicyPlans: { 'term-a-2500k': 'cancel_now' } },
    };
    expect(policyPlanOverride(o, 'term-a-2500k')).toBe('cancel_now');
    expect(policyPlanOverride(o, 'term-b-1000k')).toBeUndefined();
    expect(policyPlanOverride(undefined, 'term-a-2500k')).toBeUndefined();
  });

  it('sets per policy without disturbing the neighbours', () => {
    const one = setPolicyPlanOverride(undefined, 'term-a-2500k', 'cancel_at_retirement');
    expect(one).toEqual({
      expenses: { lifeInsurancePolicyPlans: { 'term-a-2500k': 'cancel_at_retirement' } },
    });
    const both = setPolicyPlanOverride(one, 'term-b-1000k', 'cancel_now');
    expect(both?.expenses?.lifeInsurancePolicyPlans).toEqual({
      'term-a-2500k': 'cancel_at_retirement',
      'term-b-1000k': 'cancel_now',
    });
    // The input is untouched — the caller still holds the old draft.
    expect(one?.expenses?.lifeInsurancePolicyPlans).toEqual({
      'term-a-2500k': 'cancel_at_retirement',
    });
  });

  it('clearing one disposition keeps the other', () => {
    const both = setPolicyPlanOverride(
      setPolicyPlanOverride(undefined, 'term-a-2500k', 'cancel_now'),
      'term-b-1000k',
      'cancel_now',
    );
    expect(
      setPolicyPlanOverride(both, 'term-a-2500k', undefined)?.expenses
        ?.lifeInsurancePolicyPlans,
    ).toEqual({ 'term-b-1000k': 'cancel_now' });
  });

  it('prunes the empty map, then the expenses block, then the whole overrides object', () => {
    // A plan back on the profile's policies must say so by having NO key — the
    // scenario file is read by a human, and an empty {} reads as a decision.
    expect(
      setPolicyPlanOverride(
        { expenses: { lifeInsurancePolicyPlans: { 'term-a-2500k': 'cancel_now' } } },
        'term-a-2500k',
        undefined,
      ),
    ).toBeUndefined();
    expect(
      setPolicyPlanOverride(
        {
          expenses: {
            livingMonthly: 5200,
            lifeInsurancePolicyPlans: { 'term-a-2500k': 'cancel_now' },
          },
        },
        'term-a-2500k',
        undefined,
      ),
    ).toEqual({ expenses: { livingMonthly: 5200 } });
  });
});

describe('effectivePolicyPlan', () => {
  it('the override wins; otherwise the profile flag decides', () => {
    expect(effectivePolicyPlan(termAPolicy, 'cancel_now')).toBe('cancel_now');
    // Absent flag = the engine's keep-by-default rule.
    expect(effectivePolicyPlan(termAPolicy, undefined)).toBe('keep_to_term');
    expect(effectivePolicyPlan({ cancelAtRetirement: true }, undefined)).toBe(
      'cancel_at_retirement',
    );
  });
});

describe('householdWorkStopMonth / workStopText', () => {
  it('the household stops when its LAST earner does', () => {
    // Both salaried, retiring together: a representative plan.
    expect(
      householdWorkStopMonth(RETIRE_BOTH_2028, { p1: 300_000, p2: 60_000 }),
    ).toBe('2028-06');
    // Staggered: the later date is the one cancelAtRetirement bites on,
    // because the engine keeps such a policy in force while ANYONE earns.
    expect(
      householdWorkStopMonth(
        [
          { type: 'retire', person: 'p1', date: '2028-06' },
          { type: 'retire', person: 'p2', date: '2031-01' },
        ],
        { p1: 300_000, p2: 60_000 },
      ),
    ).toBe('2031-01');
  });

  it('a non-earner without a retire event does not keep the household "working"', () => {
    // p2 draws no salary, so only p1's retirement matters.
    expect(
      householdWorkStopMonth([{ type: 'retire', person: 'p1', date: '2028-06' }], {
        p1: 300_000,
        p2: 0,
      }),
    ).toBe('2028-06');
  });

  it('null when work never stops: an earner with no retire event, or no earners', () => {
    expect(householdWorkStopMonth([], { p1: 300_000 })).toBeNull();
    expect(householdWorkStopMonth(RETIRE_BOTH_2028, {})).toBeNull();
    expect(workStopText(null)).toBe('never in this plan');
    expect(workStopText('2028-06')).toBe('Jun 2028');
  });
});

describe('monthLabel / policyRowSummary', () => {
  it('renders "YYYY-MM" as a human month and leaves garbage as typed', () => {
    expect(monthLabel('2032-12')).toBe('Dec 2032');
    expect(monthLabel('2028-06')).toBe('Jun 2028');
    expect(monthLabel('not-a-month')).toBe('not-a-month');
  });

  it('states the row numbers verbatim — cents on the premium, term from the policy', () => {
    expect(policyRowSummary(termAPolicy)).toBe('$158.33/mo · $2,500,000 · to Dec 2032');
    expect(policyRowSummary({ premiumMonthly: 100, deathBenefit: 500_000 })).toBe(
      '$100.00/mo · $500,000 · no term end',
    );
  });
});

describe('policyPlanOptions', () => {
  it('offers "cancel when work stops" for a policy the profile keeps to term', () => {
    const options = policyPlanOptions(termAPolicy, '2028-06', undefined);
    expect(options.map((o) => o.value)).toEqual(['', 'cancel_at_retirement', 'cancel_now']);
    expect(options[0].label).toBe('As configured (to Dec 2032)');
    expect(options[1].label).toBe('Cancel when work stops (Jun 2028)');
    expect(options[2].label).toBe('Cancel now');
  });

  it('offers "keep to term" instead for a policy the profile already cancels', () => {
    // Offering a disposition identical to the profile's would be the inert
    // input bug again, one level down.
    const cancelled = { ...termAPolicy, cancelAtRetirement: true };
    const options = policyPlanOptions(cancelled, '2028-06', undefined);
    expect(options.map((o) => o.value)).toEqual(['', 'keep_to_term', 'cancel_now']);
    expect(options[0].label).toContain('cancelled when work stops — Jun 2028');
    expect(options[1].label).toBe('Keep to term (to Dec 2032)');
  });

  it('appends a redundant saved disposition so the select never lies about the file', () => {
    const options = policyPlanOptions(termAPolicy, '2028-06', 'keep_to_term');
    expect(options.map((o) => o.value)).toEqual([
      '',
      'cancel_at_retirement',
      'cancel_now',
      'keep_to_term',
    ]);
  });

  it('says so when work never stops in this plan', () => {
    const options = policyPlanOptions(termAPolicy, null, undefined);
    expect(options[1].label).toBe('Cancel when work stops (never in this plan)');
  });
});

describe('coverageBands', () => {
  const bothKept = () => coverageBands([termAPolicy, termBPolicy], undefined, '2028-06', true);

  it("two overlapping policies: $3.5M through Dec 2030, $2.5M through Dec 2032, nothing after", () => {
    expect(bothKept()).toEqual([
      { from: null, to: '2030-12', benefit: 3_500_000 },
      { from: '2031-01', to: '2032-12', benefit: 2_500_000 },
    ]);
  });

  it('cancel_now removes a policy from every band', () => {
    expect(
      coverageBands(
        [termAPolicy, termBPolicy],
        { 'term-b-1000k': 'cancel_now' },
        '2028-06',
        true,
      ),
    ).toEqual([{ from: null, to: '2032-12', benefit: 2_500_000 }]);
    expect(
      coverageBands(
        [termAPolicy, termBPolicy],
        { 'term-a-2500k': 'cancel_now', 'term-b-1000k': 'cancel_now' },
        '2028-06',
        true,
      ),
    ).toEqual([]);
  });

  it('cancel_at_retirement ends cover with the month BEFORE work stops', () => {
    // Retire date 2028-06 is the first month NOT worked, so the last covered
    // month is May 2028 — the same arithmetic the engine's workedMonths does.
    expect(
      coverageBands([termAPolicy], { 'term-a-2500k': 'cancel_at_retirement' }, '2028-06', true),
    ).toEqual([{ from: null, to: '2028-05', benefit: 2_500_000 }]);
  });

  it('a cancel-at-retirement policy with no earner to stop is never in force', () => {
    expect(
      coverageBands([termAPolicy], { 'term-a-2500k': 'cancel_at_retirement' }, null, false),
    ).toEqual([]);
  });

  it('honours a future termStart: cover bought at retirement starts a band', () => {
    const bought: LifeInsurancePolicy = {
      ...termAPolicy,
      id: 'bought',
      termStart: '2028-06',
      termEnd: '2033-05',
    };
    expect(coverageBands([bought], undefined, '2028-06', true)).toEqual([
      { from: '2028-06', to: '2033-05', benefit: 2_500_000 },
    ]);
  });

  it('an unknown id in the plans map changes nothing', () => {
    expect(
      coverageBands([termAPolicy, termBPolicy], { ghost: 'cancel_now' }, '2028-06', true),
    ).toEqual(bothKept());
  });
});

describe('coverageCaption', () => {
  it('states the cover exactly, with the lapse spelled out', () => {
    const text = coverageCaption([
      { from: null, to: '2030-12', benefit: 3_500_000 },
      { from: '2031-01', to: '2032-12', benefit: 2_500_000 },
    ]);
    expect(text).toContain('$3,500,000 through Dec 2030');
    expect(text).toContain('$2,500,000 from Jan 2031 through Dec 2032');
    expect(text).toContain('nothing after');
  });

  it('a policy with no term end closes nothing, so no false "nothing after"', () => {
    const text = coverageCaption([{ from: null, to: null, benefit: 500_000 }]);
    expect(text).toContain('$500,000 to the end of the plan');
    expect(text).not.toContain('nothing after');
  });

  it('no cover left says so — the honest replacement for the old false caption', () => {
    expect(coverageCaption([])).toContain('No payout in this plan');
  });
});

// ---------------------------------------------------------------------------
// Which run is on screen, and Run now
// ---------------------------------------------------------------------------

/**
 * The whole of this section exists because of one afternoon: the Workbench said
 * 93.1%, the History tab said 94.2% for the same plan on the same day, and the
 * user reasonably read the point between them as the plan having moved. It had
 * not. The live loop runs at mcPathsInteractive; every RECORDED score is
 * measured at mcPathsFinal on the profile seed.
 *
 * Everything below is a different way of refusing to let that happen again: the
 * conditions a recorded score uses, the chip that says which kind of run made
 * the number on screen, and the rule that stops the delta chips subtracting one
 * kind from the other.
 */

/** Representative settings, so the numbers in the expectations follow from them. */
const OWNER_SETTINGS = { mcPathsFinal: 10_000, mcPathsInteractive: 1_000, seed: 20260812 };

describe('finalRunParams — the conditions a recorded score is measured under', () => {
  it('is Monte Carlo, mcPathsFinal, and the PROFILE seed', () => {
    // Matched, value for value, against src/server/scoreRunner.ts, which is
    // what the History tab and the net-worth ledger actually run. A run that
    // differs in any one of the three produces a number that cannot be set
    // beside theirs, however long it took.
    expect(finalRunParams(OWNER_SETTINGS)).toEqual({
      mode: 'montecarlo',
      paths: 10_000,
      seed: 20260812,
    });
  });

  it('takes the seed from the profile, never from an unlocked panel seed', () => {
    // The panel can unlock the seed. A 10,000-path run on a different seed drew
    // a different set of futures, so it is exactly as incomparable as a
    // 1,000-path one — and far less obviously so.
    expect(finalRunParams({ mcPathsFinal: 10_000, seed: 7 }).seed).toBe(7);
  });
});

describe('runQualityLabel — the number states its own conditions', () => {
  const meta = (over: { mode?: 'montecarlo' | 'deterministic' | 'historical'; paths?: number; seed?: number } = {}) => ({
    mode: over.mode ?? ('montecarlo' as const),
    paths: over.paths ?? 1_000,
    seed: over.seed ?? 20260812,
  });

  it('marks the interactive run as quick, and names the path count in it', () => {
    const label = runQualityLabel(meta({ paths: 1_000 }), OWNER_SETTINGS);
    expect(label.tone).toBe('quick');
    expect(label.headline).toBe('Quick run · 1,000 paths');
    // The sentence that answers the user's actual question.
    expect(label.note).toContain('10,000 paths');
    expect(label.note).toContain('method rather than the plan');
  });

  it('marks the final run as final, and says the number is comparable', () => {
    const label = runQualityLabel(meta({ paths: 10_000 }), OWNER_SETTINGS);
    expect(label.tone).toBe('final');
    expect(label.headline).toBe('Final quality · 10,000 paths');
    expect(label.note).toContain('History tab');
    expect(label.note).toContain('net-worth ledger');
  });

  it('tells the two apart at a glance — the headline alone is enough', () => {
    // The failure this fixes is a reader who cannot see which run he is looking
    // at, so the distinguishing fact has to be in the chip, not in the sentence
    // under it.
    const quick = runQualityLabel(meta({ paths: 1_000 }), OWNER_SETTINGS).headline;
    const final = runQualityLabel(meta({ paths: 10_000 }), OWNER_SETTINGS).headline;
    expect(quick).not.toBe(final);
    expect(quick).toContain('1,000');
    expect(final).toContain('10,000');
  });

  it('refuses to call a run final when it drew a different seed', () => {
    // Same path count, different futures. Calling this "final quality" would
    // invite exactly the comparison it cannot survive.
    const label = runQualityLabel(meta({ paths: 10_000, seed: 99 }), OWNER_SETTINGS);
    expect(label.tone).toBe('quick');
    expect(label.note).toContain('seed 99');
    expect(label.note).toContain("profile's 20260812");
  });

  it('never calls a deterministic or historical run final, at any path count', () => {
    // Only Monte Carlo answers "in what fraction of futures does this work";
    // a recorded score is always Monte Carlo (SCORE_MODE), so nothing else can
    // be set beside one.
    for (const mode of ['deterministic', 'historical'] as const) {
      const label = runQualityLabel(meta({ mode, paths: 50_000 }), OWNER_SETTINGS);
      expect(label.tone).toBe('quick');
      expect(label.headline).toContain(mode);
      expect(label.note).toContain('Monte Carlo');
    }
  });
});

describe('finalStandInParams — when a final run may stand in for the quick one', () => {
  /*
   * THE REFRESH BUG. A user pressed Run now, read 94.2% at 10,000 paths,
   * refreshed the browser, and the page came back reading 93.1% — the live loop
   * recomputed at 1,000 paths and nothing asked whether the better answer was
   * still on file. It was: the run cache holds every run the app has ever made,
   * keyed on the whole input.
   *
   * This is the rule that decides when swapping the final run in is honest.
   * Every "no" below is a way the page could otherwise put a number on screen
   * that the user asked for the opposite of.
   */
  const quick = { mode: 'montecarlo' as const, paths: 1_000, seed: 20260812 };

  it('stands in for the ordinary interactive run — same question, more paths', () => {
    expect(finalStandInParams(quick, OWNER_SETTINGS)).toEqual({
      mode: 'montecarlo',
      paths: 10_000,
      seed: 20260812,
    });
  });

  it('refuses for a deterministic or historical run, which answer something else', () => {
    // A fraction of futures is not a more precise version of a single projected
    // path. Substituting one would change the number AND the question.
    for (const mode of ['deterministic', 'historical'] as const) {
      expect(finalStandInParams({ mode, seed: 20260812 }, OWNER_SETTINGS)).toBeNull();
    }
  });

  it('refuses when the panel seed is not the profile seed', () => {
    // Unlocking the seed is a deliberate act, and 10,000 paths on the profile
    // seed is a DIFFERENT sample rather than a finer one — exactly the trap
    // runQualityLabel refuses to call "final" for the same reason.
    expect(finalStandInParams({ ...quick, seed: 99 }, OWNER_SETTINGS)).toBeNull();
  });

  it('refuses when more paths than the final count were asked for', () => {
    // Typing 25,000 in the Paths box asks for a FINER answer than mcPathsFinal.
    // Quietly serving 10,000 would be a downgrade dressed as a saving.
    expect(finalStandInParams({ ...quick, paths: 25_000 }, OWNER_SETTINGS)).toBeNull();
    // At the count itself the swap is a no-op, so it is allowed: the two
    // requests are the same run and the cache answers either instantly.
    expect(finalStandInParams({ ...quick, paths: 10_000 }, OWNER_SETTINGS)).not.toBeNull();
  });

  it('allows it when no path count was stated at all', () => {
    // Undefined means "whatever the server defaults Monte Carlo to", which is
    // mcPathsInteractive — below the final count, so the swap is an upgrade.
    expect(finalStandInParams({ mode: 'montecarlo', seed: 20260812 }, OWNER_SETTINGS)).toEqual({
      mode: 'montecarlo',
      paths: 10_000,
      seed: 20260812,
    });
  });
});

describe('runComputedAt — the run says when it was made, not only how', () => {
  it('carries the date and the clock, so 3:41 PM is not read as just now', () => {
    // The page prefers a final run already in the cache, so the headline can be
    // a number computed this afternoon. "Final quality · 10,000 paths" on its
    // own reads as a run that has just finished.
    const chip = runComputedAt({ createdAt: '2026-08-20T10:23:15.156Z' });
    expect(chip).not.toBeNull();
    expect(chip!.text).toMatch(/^Computed Aug 20, 2026, \d{1,2}:\d{2} (AM|PM)$/);
  });

  it('explains why an older run is still the right number', () => {
    // The whole input is the key — plan, assumptions, and the balances as
    // priced. That is what makes a 3:41 PM number exactly as right as a fresh
    // one, and it is the sentence the user needs to trust the chip.
    const chip = runComputedAt({ createdAt: '2026-08-20T10:23:15.156Z' });
    expect(chip!.title).toContain('whole input');
    expect(chip!.title).toContain('same number a fresh run would produce');
  });

  it('says nothing at all when the moment is unreadable', () => {
    // An "Invalid Date" chip beside the headline would be worse than no chip:
    // it makes the run look broken when only its timestamp is.
    expect(runComputedAt({ createdAt: 'not-a-date' })).toBeNull();
  });

  it('is stated for a run computed a second ago as readily as an old one', () => {
    // A chip that appeared only for an OLD run would teach the reader that its
    // absence means "just now" — and its absence would then have to keep
    // meaning that forever. Same rule as the precision chip, which states ±0.3
    // as readily as ±1.3.
    expect(runComputedAt({ createdAt: new Date().toISOString() })).not.toBeNull();
  });
});

describe('comparableRun — a delta is never drawn across two path counts', () => {
  const at = (paths: number | undefined, success: number): RunMetrics => ({
    success,
    medianTerminalReal: 1_000_000,
    shortfallYear: null,
    withdrawal: { kind: 'rate', rate: 0.04, year: 2032, rails: null, lifetime: null },
    paths,
  });

  it('keeps the comparison when both runs used the same number of paths', () => {
    const comparison = at(1_000, 0.921);
    expect(comparableRun(at(1_000, 0.931), comparison)).toBe(comparison);
  });

  it('drops it when they did not — 93.1% at 1,000 vs 94.2% at 10,000', () => {
    // The exact pair from the afternoon that prompted the button. Subtracting
    // them reports +1.1 pts, which is a fact about Monte Carlo and not about
    // this plan.
    expect(comparableRun(at(10_000, 0.942), at(1_000, 0.931))).toBeNull();
    // …and in the other direction too: the quick run that follows a Run now
    // must not measure itself against the final one either.
    expect(comparableRun(at(1_000, 0.958), at(10_000, 0.968))).toBeNull();
  });

  it('treats an unknown path count as comparable rather than suppressing the strip', () => {
    // Metrics built by hand carry no meta. Blanking every chip because of that
    // would cost the strip its whole reason for existing.
    const unknown = at(undefined, 0.9);
    expect(comparableRun(at(10_000, 0.95), unknown)).toBe(unknown);
    expect(comparableRun(unknown, at(10_000, 0.95))).not.toBeNull();
  });

  it('passes null through — nothing to compare stays nothing to compare', () => {
    expect(comparableRun(at(1_000, 0.95), null)).toBeNull();
  });

  it('is fed by runMetrics, which reads the count off the run itself', () => {
    // The count has to come from the RUN, not from what the page thinks it
    // asked for: Run now forces final quality whatever the panel's settings say.
    const m = runMetrics({
      success: 1,
      medianTerminalReal: 0,
      worstDecileShortfallYears: {},
      referencePath: [],
      meta: { paths: 10_000 },
    });
    expect(m.paths).toBe(10_000);
  });
});

describe('noChangeChip — a chip with no change says which reason it is', () => {
  it('says "first run" only when there really was no run before this one', () => {
    expect(noChangeChip(false).text).toBe('first run');
    expect(noChangeChip(false).title).toContain('Nothing to compare');
  });

  it('says "not comparable" when the run before this one was measured differently', () => {
    // The case Run now creates every time it is pressed: there IS a previous
    // run, on the same plan, and "first run" would teach the user that the app
    // forgets — the opposite of what the button was built to fix.
    expect(noChangeChip(true).text).toBe('not comparable');
    expect(noChangeChip(true).title).toContain('different number of paths');
    expect(noChangeChip(true).title).toContain('method, not plan');
  });
});

describe('comparisonNote — the missing chips explain themselves', () => {
  it('says why there is no change shown when the two runs differ in method', () => {
    // Without this the reader sees bare values where chips were and concludes
    // the app forgot, or that nothing changed.
    const note = comparisonNote(null, true, true);
    expect(note).toContain('different number of paths');
    expect(note).toContain('method, not plan');
  });

  it('does not claim "first run" when there IS a previous one it threw out', () => {
    expect(comparisonNote(null, true, true)).not.toContain('First run');
    expect(comparisonNote(null, true, false)).toBe('Change vs the previous run');
  });

  it('outranks the pinned baseline, which is just as incomparable', () => {
    expect(comparisonNote('run 8f21ac30', true, true)).not.toContain('8f21ac30');
  });
});

describe('the Run now button never looks like a dead click', () => {
  it('names the phase it is in, and the phases are the two slow ones', () => {
    // A quote fetch then a 10,000-path run is tens of seconds. Both halves get
    // their own word, because "Running…" during the network fetch would be a
    // small lie that costs its credibility on the day the fetch is what hangs.
    expect(runNowButtonText({ status: 'quotes' })).toBe('Refreshing prices…');
    expect(runNowButtonText({ status: 'running' })).toBe('Running…');
  });

  it('offers itself again once it is over, however it ended', () => {
    expect(runNowButtonText({ status: 'idle' })).toBe('Run now');
    expect(runNowButtonText({ status: 'error', message: 'boom' })).toBe('Run now');
  });

  it('is disabled only while work is in flight', () => {
    // A failed run must be retryable at once — the button IS the retry.
    expect(runNowBusy({ status: 'quotes' })).toBe(true);
    expect(runNowBusy({ status: 'running' })).toBe(true);
    expect(runNowBusy({ status: 'idle' })).toBe(false);
    expect(runNowBusy({ status: 'error', message: 'boom' })).toBe(false);
  });
});

describe('refreshFailureNote — a price that did not refresh is named', () => {
  it('says nothing when every symbol refreshed', () => {
    expect(refreshFailureNote([{ symbol: 'VTI', ok: true }, { symbol: 'BND', ok: true }])).toBeNull();
    expect(refreshFailureNote([])).toBeNull();
  });

  it('names the symbol and what the run used instead', () => {
    // Survivable — the previous quote is still on file — but not silent: the
    // button's promise is "scored on today's prices", and one holding priced at
    // yesterday's close makes that promise partly false.
    expect(refreshFailureNote([{ symbol: 'VTI', ok: true }, { symbol: 'SCHD', ok: false }])).toBe(
      'Prices did not refresh for SCHD — this run used the last stored price for it.',
    );
  });

  it('lists every failure, not just the first', () => {
    expect(
      refreshFailureNote([
        { symbol: 'SCHD', ok: false },
        { symbol: 'VTI', ok: true },
        { symbol: 'BND', ok: false },
      ]),
    ).toBe('Prices did not refresh for SCHD, BND — this run used the last stored price for those.');
  });
});

// ---------------------------------------------------------------------------
// How precisely a run measured a fraction of its paths
// ---------------------------------------------------------------------------

/*
 * THE REPORT THESE NUMBERS COME FROM. The user pressed Run now and got 94.2%,
 * moved the tithing hold period from 2 to 0 (93.0%), moved it back to 2
 * (92.9%), and pressed Run now again (94.2%). Deterministically, every time.
 *
 * Verified against a running server on a live plan — same scenario hash
 * 7ff9a75c12f24aa1, same profile hash, same seed 20260812:
 *
 *   1,000 paths   -> success 0.929
 *   10,000 paths  -> success 0.9421
 *
 * So the plan round-trips exactly and nothing is corrupt. 94.2 against 92.9 is
 * the final run against the quick one; 93.0 against 92.9 is the toggle's real
 * effect, 0.1 points, measured by a run that cannot resolve 1.6. Every expected
 * value below is hand-computed in its own comment.
 */

describe('pathFractionStandardError — sqrt(p(1-p)/n) on the run"s own paths', () => {
  it('is the binomial standard error, to the digit', () => {
    // p = 0.5, n = 10,000: 0.25/10,000 = 2.5e-5, sqrt = 0.005 EXACTLY. The one
    // case that needs no tolerance, so a wrong formula cannot hide behind one.
    expect(pathFractionStandardError(0.5, 10_000)).toBe(0.005);

    // p = 0.75, n = 1,875: 0.1875/1,875 = 1e-4, sqrt = 0.01.
    expect(pathFractionStandardError(0.75, 1_875)).toBeCloseTo(0.01, 12);

    // THE QUICK RUN FROM THE REPORT. p = 0.929, n = 1,000:
    //   0.929 x 0.071 = 0.065959; /1,000 = 6.5959e-5; sqrt = 0.00812151...
    // i.e. 0.8122 points — which is why 92.9 and 93.0 are the same reading.
    expect(pathFractionStandardError(0.929, 1_000)).toBeCloseTo(0.00812151, 8);

    // THE FINAL RUN FROM THE REPORT. p = 0.9421, n = 10,000:
    //   0.9421 x 0.0579 = 0.05454759; /10,000 = 5.454759e-6; sqrt = 0.00233554
    // i.e. 0.2336 points.
    expect(pathFractionStandardError(0.9421, 10_000)).toBeCloseTo(0.00233554, 8);
  });

  it('shrinks as the fraction approaches certainty', () => {
    // p(1-p) peaks at p = 0.5 and falls away either side, so a near-certain
    // plan is measured MORE precisely by the same paths. At n = 10,000:
    //   p = 0.50 -> sqrt(0.25/1e4)   = 0.005
    //   p = 0.99 -> sqrt(0.0099/1e4) = 0.00099499 — five times smaller.
    expect(pathFractionStandardError(0.99, 10_000)).toBeCloseTo(0.00099499, 8);
    expect(pathFractionStandardError(0.99, 10_000)).toBeLessThan(
      pathFractionStandardError(0.5, 10_000),
    );
    // …and it is symmetric about a half: 0.99 and 0.01 are equally precise.
    expect(pathFractionStandardError(0.01, 10_000)).toBeCloseTo(
      pathFractionStandardError(0.99, 10_000),
      15,
    );
  });

  it('halves for four times the paths, which is why Run now is ten times as slow', () => {
    // 1/sqrt(n). Quadrupling the paths buys one bit of precision, not four —
    // the reason the quick run exists and the reason it cannot be trusted with
    // a two-tenths-of-a-point difference.
    const at1k = pathFractionStandardError(0.929, 1_000);
    expect(pathFractionStandardError(0.929, 4_000)).toBeCloseTo(at1k / 2, 12);
  });

  it('is exactly zero at both boundaries, which is why nothing prints it raw', () => {
    // p(1-p) = 0. True, and the one number the screen must never show: a run in
    // which nothing failed has not proved that nothing can.
    expect(pathFractionStandardError(1, 1_000)).toBe(0);
    expect(pathFractionStandardError(0, 1_000)).toBe(0);
  });

  it('refuses a pathless run rather than returning an Infinity that would print', () => {
    // metrics.ts throws on zero paths, so this is defensive — but sqrt(x/0) is
    // Infinity, and "±Infinity pts" looks like a measurement while NaN cannot.
    expect(pathFractionStandardError(0.5, 0)).toBeNaN();
    expect(pathFractionStandardError(0.5, -1)).toBeNaN();
  });
});

describe('pathFractionHalfWidth — the 95% interval the screen is allowed to print', () => {
  it('is 1.959964 standard errors, the same confidence the Search page uses', () => {
    // A second confidence level in one app would be two claims wearing one
    // symbol. 0.005 x 1.959964 = 0.00979982.
    expect(CI_Z_95).toBeCloseTo(1.959964, 6);
    expect(pathFractionHalfWidth(0.5, 10_000)).toBeCloseTo(0.00979982, 8);

    // The quick run: 0.0081215 x 1.959964 = 0.0159179 -> 1.59 points.
    expect(pathFractionHalfWidth(0.929, 1_000)).toBeCloseTo(0.01591788, 8);
    // The final run: 0.0023355 x 1.959964 = 0.0045776 -> 0.46 points.
    expect(pathFractionHalfWidth(0.9421, 10_000)).toBeCloseTo(0.00457758, 8);
  });

  it('falls back to the rule of three where the standard error is zero', () => {
    // Zero failures in n draws does not mean zero failure rate: if the rate
    // were x, P(none in n) = (1-x)^n, and setting that to 0.05 gives x ~ 3/n.
    // 3/1,000 = 0.003 -> 0.3 points. 3/10,000 = 0.0003 -> 0.03 points.
    expect(pathFractionHalfWidth(1, 1_000)).toBe(0.003);
    expect(pathFractionHalfWidth(0, 1_000)).toBe(0.003);
    expect(pathFractionHalfWidth(1, 10_000)).toBe(0.0003);
    // Never zero. This household's plan is over-funded and saturates, so the
    // boundary is its ordinary case rather than an exotic one.
    expect(pathFractionHalfWidth(1, 1_000)).toBeGreaterThan(0);
  });
});

describe('successPrecision — the headline number states how precisely it was measured', () => {
  const mc = (paths: number) => ({ mode: 'montecarlo' as const, paths });

  it("carries the quick run's sampling error beside the quick run", () => {
    // 0.929 at 1,000 paths -> ±1.5918 points -> "±1.6 pts". The whole swing
    // the user reported as a bug — 94.2 - 92.9 = 1.3 — fits inside it.
    const p = successPrecision(0.929, mc(1_000));
    expect(p?.text).toBe('±1.6 pts (95%)');
    expect(p?.halfWidth).toBeCloseTo(0.01591788, 8);
  });

  it("carries the final run's too, and the two are told apart by the number", () => {
    // A run that states its precision only when the precision is poor teaches
    // the reader that a missing chip means exact. 0.9421 at 10,000 -> ±0.5.
    const quick = successPrecision(0.929, mc(1_000));
    const final = successPrecision(0.9421, mc(10_000));
    expect(final?.text).toBe('±0.5 pts (95%)');
    expect(final?.text).not.toBe(quick?.text);
    expect(final!.halfWidth).toBeLessThan(quick!.halfWidth);
  });

  it('never prints a bare ± — the confidence level rides with the number', () => {
    // "±0.6" with no stated meaning is another unlabelled number, which is the
    // defect and not the fix.
    for (const p of [successPrecision(0.929, mc(1_000)), successPrecision(0.9421, mc(10_000))]) {
      expect(p?.text).toContain('95%');
      expect(p?.sentence).toContain('95%');
    }
  });

  it('states a one-sided bound rather than "±0.0" when no path failed', () => {
    // sqrt(p(1-p)/n) is exactly 0 at p = 1, and "±0.0 pts (95%)" beside "100%"
    // would be the most confident lie on the page.
    const p = successPrecision(1, mc(1_000));
    expect(p?.saturated).toBe(true);
    expect(p?.text).toBe('-0.3 / +0 pts (95%)');
    expect(p?.text).not.toContain('±');
    expect(p?.title).toContain('rule of three');
    // The other boundary is the mirror image, and points the other way.
    expect(successPrecision(0, mc(1_000))?.text).toBe('+0.3 / -0 pts (95%)');
  });

  it('keeps the one-sided bound off zero at the FINAL path count too', () => {
    // THE ROUNDING PUT THE LIE BACK. The rule of three at mcPathsFinal's 10,000
    // paths is 3/10,000 = 0.03 points, and one decimal place renders that "0.0"
    // — so a saturated final run printed "-0.0 / +0 pts" and a sentence reading
    // "under 0.0 points rather than at zero", which is the exact claim of
    // exactness the branch exists to refuse. A well-funded plan reaches p = 1 —
    // the rate saturates — and Run now always uses this count.
    const p = successPrecision(1, mc(10_000));
    expect(p?.saturated).toBe(true);
    expect(p?.text).toBe('-0.03 / +0 pts (95%)');
    expect(p?.text).not.toContain('0.0 ');
    expect(p?.sentence).toContain('under 0.03 points rather than at zero');
    expect(p?.title).toContain('no more than 0.03 points');
    // The quick run's grain is unchanged — one decimal is still the strip's unit
    // wherever one decimal says something.
    expect(successPrecision(1, mc(1_000))?.text).toBe('-0.3 / +0 pts (95%)');
    expect(successPrecision(0.9421, mc(10_000))?.text).toBe('±0.5 pts (95%)');
    expect(successPrecision(0.929, mc(1_000))?.text).toBe('±1.6 pts (95%)');
  });

  it('declines to invent one for a mode that has no sampling error', () => {
    // A deterministic run is ONE path: its success is 0 or 1 and it samples
    // nothing. A historical run enumerates every rolling window the return
    // series holds — a census, not a draw — so there is no sampling error to
    // state and printing one would invent a randomness the mode lacks.
    expect(successPrecision(0.929, { mode: 'deterministic', paths: 1 })).toBeNull();
    expect(successPrecision(0.929, { mode: 'historical', paths: 66 })).toBeNull();
    expect(successPrecision(0.929, { mode: 'montecarlo', paths: 0 })).toBeNull();
  });

  it('labels the WITHIN-run quantity apart from the ACROSS-seed one', () => {
    /*
     * Two different numbers that would both render as "± something pts". This
     * one is the binomial error over PATHS inside one draw of futures; the
     * Search page's is the spread of the answer over SEEDS, i.e. what happens
     * when the futures are redrawn. A plan can have a small one and a large
     * other at the same time. Neither may borrow the other's name.
     */
    const within = successPrecision(0.929, mc(1_000))!;
    const across = formatSpread(
      { metric: 'success', direction: 'maximize' } as never,
      { mean: 0.929, sd: 0.0074, se: 0.0021, n: 12, min: 0.914, max: 0.944, ci95: [0.9244, 0.9336], values: [] },
    )!;
    expect(within.text).toContain('pts');
    expect(across).toContain('pts');
    // …and they are still distinguishable, because each names its own divisor.
    expect(within.text).not.toBe(across);
    expect(across).toContain('seeds');
    expect(within.title).toContain('paths');
    expect(within.title).toContain('ACROSS seeds');
  });
});

describe('pathFractionDeltaResolution — the smallest difference two runs can see', () => {
  it('combines the two standard errors in quadrature, at 95%', () => {
    /*
     * THE TITHING TOGGLE. 0.929 and 0.930, both at 1,000 paths:
     *   se(0.929) = sqrt(0.065959/1e3) = 0.0081215
     *   se(0.930) = sqrt(0.065100/1e3) = 0.0080685
     *   sqrt(0.0081215^2 + 0.0080685^2) = sqrt(1.310590e-4) = 0.0114481
     *   x 1.959964 = 0.02243786 -> 2.2438 points.
     * The move it was drawn over is 0.1 points.
     */
    const r = pathFractionDeltaResolution(
      { fraction: 0.929, paths: 1_000 },
      { fraction: 0.930, paths: 1_000 },
    );
    expect(r).toBeCloseTo(0.02243786, 8);
    expect(Math.abs(0.929 - 0.930)).toBeLessThan(r!);
  });

  it('narrows with paths, so the final run resolves what the quick one cannot', () => {
    // Same two fractions at 10,000 paths: 0.02243786/sqrt(10) = 0.0070955 ->
    // 0.71 points. Still wider than 0.1, which is the honest answer: this knob
    // is below what even a final run resolves, and the Search page is what
    // measures it properly. Run now is a real answer, not a promised verdict.
    const r = pathFractionDeltaResolution(
      { fraction: 0.929, paths: 10_000 },
      { fraction: 0.930, paths: 10_000 },
    );
    expect(r).toBeCloseTo(0.02243786 / Math.sqrt(10), 8);
    expect(Math.abs(0.929 - 0.930)).toBeLessThan(r!);
  });

  it('stays finite and non-zero when a run saturated', () => {
    // Two zero standard errors would combine to a zero threshold and let a
    // difference of any size through, on exactly the plan most likely to
    // produce one. The rule-of-three bound stands in: (3/n)/z per side.
    //   (0.003/1.959964) = 0.00153064 each; sqrt(2) x that x 1.959964 = 0.00424264
    const r = pathFractionDeltaResolution(
      { fraction: 1, paths: 1_000 },
      { fraction: 1, paths: 1_000 },
    );
    expect(r).toBeCloseTo(0.00424264, 8);
    expect(r).toBeGreaterThan(0);
  });

  it('returns null when a path count is unknown, exactly as comparableRun does', () => {
    // Hand-built metrics carry no meta. Guarding on a count we do not have
    // would blank chips for a reason nobody could see.
    expect(pathFractionDeltaResolution({ fraction: 0.9 }, { fraction: 0.5, paths: 1_000 })).toBeNull();
    expect(pathFractionDeltaResolution({ fraction: 0.9, paths: 1_000 }, { fraction: 0.5 })).toBeNull();
  });
});

describe('no chip reports a difference its runs cannot resolve', () => {
  const at = (success: number, paths?: number, guardrails?: RunMetrics['guardrails']): RunMetrics => ({
    success,
    medianTerminalReal: 1_000_000,
    shortfallYear: null,
    withdrawal: { kind: 'rate', rate: 0.04, year: 2032, rails: null, lifetime: null },
    guardrails,
    paths,
  });

  it('says "not resolved" for the tithing toggle instead of drawing "-0.1 pts"', () => {
    // The chip the user read as the plan moving. 0.1 points against a 2.24
    // -point resolution: the runs disagree, and they cannot tell why.
    const d = pick(computeDeltas(at(0.929, 1_000), at(0.930, 1_000)), 'success');
    expect(d.change).toBe(UNRESOLVED_CHIP);
    expect(d.change).toBe('not resolved');
    expect(d.direction).toBe('flat');
    expect(d.tone).toBe('neutral');
    // No arrow, because an arrow is a claim about which way the plan moved and
    // that is the one claim these two runs cannot support.
    expect(d.change).not.toContain('pts');
  });

  it('still prints the difference it declined to call a move, and where to get one', () => {
    // Hiding the number is the other failure: the user asked what the toggle
    // did, and a blank does not answer them. It goes in the sentence that
    // disowns it, never in the chip.
    const d = pick(computeDeltas(at(0.929, 1_000), at(0.930, 1_000)), 'success');
    expect(d.note).toContain('-0.1 pts');
    expect(d.note).toContain('±2.2 pts at 95%');
    expect(d.note).toContain('No measurable change');
    // A dead end would just teach the user to squint at the chip again.
    expect(d.note).toContain('Run now');
    expect(d.note).toContain('Search page');
    // …and the chip itself can say why on hover, separately from the tile's
    // own definition of the metric.
    expect(d.changeTitle).toContain('will not call it a move');
  });

  it('states a band and a difference the reader can read, at the final count too', () => {
    // A NOTE THAT SAYS "0.0 pts is inside ±0.0 pts" disowns the difference and
    // withholds the magnitude in the same breath — the sentence exists to give
    // the reader the size of the thing that could not be measured. Two 10,000-
    // path runs on a saturating plan (one loses a single path) resolve to 0.04
    // points and differ by 0.01, and one decimal rounded both to nothing.
    const d = pick(computeDeltas(at(1, 10_000), at(0.9999, 10_000)), 'success');
    expect(d.change).toBe('not resolved');
    expect(d.note).toContain('+0.01 pts');
    expect(d.note).toContain('±0.04 pts at 95%');
    expect(d.note).not.toContain('0.0 pts');
    expect(d.changeTitle).toContain('+0.01 pts');
    // The quick run's wording is untouched.
    const quick = pick(computeDeltas(at(0.929, 1_000), at(0.930, 1_000)), 'success');
    expect(quick.note).toContain('-0.1 pts is inside');
    expect(quick.note).toContain('±2.2 pts at 95%');
  });

  it('reports a difference above the resolution exactly as it always did', () => {
    // 0.397 -> 0.525 at 1,000 paths each: 12.8 points against a 4.33-point
    // resolution. The guard must not cost the strip the moves it exists for.
    const d = pick(computeDeltas(at(0.525, 1_000), at(0.397, 1_000)), 'success');
    expect(d.change).toBe('+12.8 pts');
    expect(d.direction).toBe('up');
    expect(d.tone).toBe('good');
    expect(d.note).toBeUndefined();
  });

  it('keeps "no change" for an identical pair — a finding, not a confession', () => {
    // The two states must never render the same. "no change" means the runs
    // produced the SAME fraction; "not resolved" means they did not and the
    // difference is smaller than they can see. searchLogic keeps "same plan"
    // and "not resolved" apart for the identical reason.
    const same = pick(computeDeltas(at(0.929, 1_000), at(0.929, 1_000)), 'success');
    expect(same.change).toBe('no change');
    expect(same.change).not.toBe(UNRESOLVED_CHIP);
  });

  it('guards the guardrails fractions the same way, since they count the same paths', () => {
    // aggregateGuardrailStats divides a count of paths by the same n the
    // success rate uses, so they are binomial fractions with binomial errors —
    // and WIDER ones, because 0.23 has more variance than 0.96.
    //   se(0.23, 1e3) = sqrt(0.1771/1e3) = 0.0133079
    //   se(0.24, 1e3) = sqrt(0.1824/1e3) = 0.0135056
    //   1.959964 x sqrt(both squared) = 0.0371619 -> 3.72 points.
    const cut = pick(
      computeDeltas(at(0.9, 1_000, guardStats({ everCutFraction: 0.23 })), at(0.9, 1_000, guardStats({ everCutFraction: 0.24 }))),
      'guardCut',
    );
    expect(cut.change).toBe(UNRESOLVED_CHIP);
    expect(cut.note).toContain('-1.0 pts');

    const raise = pick(
      computeDeltas(
        at(0.9, 1_000, guardStats({ everAbovePlanFraction: 0.61 })),
        at(0.9, 1_000, guardStats({ everAbovePlanFraction: 0.62 })),
      ),
      'guardRaise',
    );
    expect(raise.change).toBe(UNRESOLVED_CHIP);

    // …and a real move on the same tile still reports. 0.23 -> 0.55 is 32
    // points against 3.9.
    const moved = pick(
      computeDeltas(at(0.9, 1_000, guardStats({ everCutFraction: 0.55 })), at(0.9, 1_000, guardStats({ everCutFraction: 0.23 }))),
      'guardCut',
    );
    expect(moved.change).toBe('+32.0 pts');
  });

  it('leaves the metrics with no sampling model of their own alone', () => {
    /*
     * A $1 move in the median terminal and a one-year move in the shortfall
     * year are both far below anything 1,000 paths resolves — and both still
     * report, because neither has a sampling distribution this app has worked
     * out. A sample median needs the density of terminal wealth at the median,
     * which RunResult does not carry; the shortfall year is a median over the
     * ~45 paths that fail at all. Inventing an interval for either would be the
     * same lie in a lab coat, so they get the honest treatment instead: no
     * claim of precision, in either direction.
     */
    const a: RunMetrics = { ...at(0.9, 1_000), medianTerminalReal: 1_000_001, shortfallYear: 2047 };
    const b: RunMetrics = { ...at(0.9, 1_000), medianTerminalReal: 1_000_000, shortfallYear: 2046 };
    const d = computeDeltas(a, b);
    expect(pick(d, 'terminal').change).toBe('+$1');
    expect(pick(d, 'shortfall').change).toBe('+1 yr');
  });

  it('does not guard a comparison whose path count nobody stated', () => {
    // Same rule as comparableRun: an unknown count is treated as comparable,
    // because suppressing every chip over a missing field would cost the strip
    // its whole reason for existing.
    const d = pick(computeDeltas(at(0.929), at(0.930)), 'success');
    expect(d.change).toBe('-0.1 pts');
  });
});

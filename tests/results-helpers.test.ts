/**
 * Unit tests for the Results page pure helpers
 * (src/ui/components/results/resultsData.ts). All expected values are
 * hand-computed; the arithmetic is spelled out in comments.
 */
import { describe, expect, it } from 'vitest';
import type {
  FanChart,
  ProfileSettings,
  Scenario,
  SolverPoint,
  SolverResult,
  TaxYearResult,
  YearRow,
} from '../src/shared/types';
import { accountLabel } from '../src/ui/components/results/CashflowTable';
import { buildTitheRows, titheParentIdOf } from '../src/ui/components/results/TitheCard';
import {
  EXPLORE_QUESTIONS,
  GIVING_RULE_FLAG,
  IRMAA_TIER1_MFJ_2026,
  NIIT_THRESHOLD_MFJ,
  charitableLineLabel,
  SS_PROVISIONAL_TIER1_MFJ,
  SS_PROVISIONAL_TIER2_MFJ,
  buildFanData,
  chipInfo,
  buildMagiData,
  buildWorstDecileData,
  effectiveSuccessTarget,
  exploreAnswerLine,
  exploreSpec,
  formatClaimAgeMonths,
  formatCompactUSD,
  seppBustCostInYear,
  seppPaymentInYear,
  formatElapsed,
  referencePathInsolvencyYear,
  runResultCache,
  runVerdict,
  scenarioForPlainRun,
  scenarioWithSolver,
  solverPointsHave,
  solverSuccessTarget,
  spendingCurveSpec,
  successClass,
  totalExpenses,
  totalIncome,
  totalWithdrawals,
  typicalShortfallYear,
} from '../src/ui/components/results/resultsData';

// ---------------------------------------------------------------------------
// Fixture builders (minimal but type-complete YearRow / TaxYearResult stubs)
// ---------------------------------------------------------------------------

function makeTaxes(over: {
  acaMagi?: number;
  irmaaMagi?: number;
  niitMagi?: number;
  aca?: TaxYearResult['aca'];
  medicare?: TaxYearResult['medicare'];
} = {}): TaxYearResult {
  return {
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
    aca: over.aca ?? null,
    medicare: over.medicare ?? null,
    magi: {
      agi: 0,
      acaMagi: over.acaMagi ?? 0,
      irmaaMagi: over.irmaaMagi ?? 0,
      niitMagi: over.niitMagi ?? 0,
    },
    totalTax: 0,
  };
}

function makeAca(cliffHeadroom: number | null): NonNullable<TaxYearResult['aca']> {
  return {
    enrolled: true,
    fplPct: 2.5,
    applicablePct: 0.085,
    expectedContribution: 5000,
    ptc: 12000,
    grossPremium: 21000,
    netPremium: 9000,
    cliffApplied: false,
    cliffHeadroom,
  };
}

function makeMedicare(): NonNullable<TaxYearResult['medicare']> {
  return { partB: 2434.8, partDPlan: 540, irmaaPartB: 0, irmaaPartD: 0, total: 2974.8, tierIndex: 0 };
}

function makeRow(over: {
  year: number;
  inflationIndex?: number;
  income?: Partial<YearRow['income']>;
  expenses?: Partial<YearRow['expenses']>;
  investing?: number;
  unbudgeted?: number;
  withdrawals?: Partial<YearRow['withdrawals']>;
  taxes?: TaxYearResult;
  flags?: string[];
}): YearRow {
  return {
    year: over.year,
    agesAtYearEnd: [over.year - 1971, over.year - 1971],
    inflationIndex: over.inflationIndex ?? 1,
    income: {
      wages: 0,
      socialSecurity: 0,
      taxableInterest: 0,
      dividends: 0,
      other: 0,
      retirement: 0,
      employerHealthPremiumShare: 0,
      ...over.income,
    },
    expenses: {
      baseline: 0,
      charitable: 0,
      housing: 0,
      health: 0,
      oneTime: 0,
      total: 0,
      ...over.expenses,
    },
    investing: over.investing ?? 0,
    unbudgeted: over.unbudgeted ?? 0,
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
      ...over.withdrawals,
    },
    taxes: over.taxes ?? makeTaxes(),
    // A YearRow always carries both views of the balance sheet (note 21):
    // `total` includes a Tithe Account carve-out, `spendable` does not, and
    // the two are the same figure in a plan that has none — which is what
    // this fixture is.
    balances: { byAccount: {}, total: 0, totalReal: 0, tithe: 0, spendable: 0, spendableReal: 0 },
    returns: { stocks: 0, bonds: 0, bills: 0, cpi: 0 },
    eventsFired: [],
    flags: over.flags ?? [],
  };
}

const SETTINGS: ProfileSettings = {
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
};

// ---------------------------------------------------------------------------

describe('successClass', () => {
  it('good at or above target', () => {
    expect(successClass(0.85, 0.85)).toBe('good');
    expect(successClass(0.92, 0.85)).toBe('good');
  });

  it('warn within 10 percentage points below target (inclusive)', () => {
    // 0.84 is 1pt below 0.85 -> warn
    expect(successClass(0.84, 0.85)).toBe('warn');
    // 0.75 is exactly 10pts below 0.85 -> still warn (epsilon guards the
    // float subtraction 0.85 - 0.10)
    expect(successClass(0.75, 0.85)).toBe('warn');
  });

  it('bad more than 10 points below target', () => {
    // 0.749 is 10.1pts below 0.85 -> bad
    expect(successClass(0.749, 0.85)).toBe('bad');
    expect(successClass(0, 0.85)).toBe('bad');
  });

  it('epsilon guard: exactly 10 points below survives float noise', () => {
    // 0.92 - 0.1 = 0.82000000000000006 in IEEE 754, strictly above the double
    // for 0.82 — a plain >= comparison would misclassify 0.82 as bad. The
    // epsilon guard keeps it warn.
    expect(successClass(0.82, 0.92)).toBe('warn');
    expect(successClass(0.83, 0.93)).toBe('warn');
  });
});

describe('effectiveSuccessTarget', () => {
  it('uses the profile default when the scenario has no override', () => {
    expect(effectiveSuccessTarget({ settings: SETTINGS }, { assumption_overrides: {} })).toBe(0.85);
    expect(effectiveSuccessTarget({ settings: SETTINGS }, undefined)).toBe(0.85);
  });

  it('scenario override wins over the profile default', () => {
    expect(
      effectiveSuccessTarget(
        { settings: SETTINGS },
        { assumption_overrides: { settings: { successTarget: 0.9 } } },
      ),
    ).toBe(0.9);
  });

  it('falls back to 0.85 with no profile at all', () => {
    expect(effectiveSuccessTarget(null, null)).toBe(0.85);
  });
});

describe('solverSuccessTarget', () => {
  // Mirrors the engine's targetFor: spec.targetSuccess (max_spend /
  // earliest_retirement only) -> scenario settings override -> profile.
  const overridden = { settings: { successTarget: 0.9 } };

  it('spec targetSuccess wins over scenario override and profile', () => {
    expect(
      solverSuccessTarget(
        { settings: SETTINGS },
        {
          assumption_overrides: overridden,
          solver: { type: 'max_spend', targetSuccess: 0.95 },
        },
      ),
    ).toBe(0.95);
    expect(
      solverSuccessTarget(
        { settings: SETTINGS },
        {
          assumption_overrides: overridden,
          solver: { type: 'earliest_retirement', targetSuccess: 0.8 },
        },
      ),
    ).toBe(0.8);
  });

  it('solver without a targetSuccess falls back to the scenario override', () => {
    expect(
      solverSuccessTarget(
        { settings: SETTINGS },
        { assumption_overrides: overridden, solver: { type: 'max_spend' } },
      ),
    ).toBe(0.9);
  });

  it('spec types without a targetSuccess field use scenario/profile precedence', () => {
    expect(
      solverSuccessTarget(
        { settings: SETTINGS },
        {
          assumption_overrides: overridden,
          solver: { type: 'swr_curve', spendFrom: 50000, spendTo: 120000, step: 5000 },
        },
      ),
    ).toBe(0.9);
    expect(
      solverSuccessTarget(
        { settings: SETTINGS },
        { solver: { type: 'retire_year_sweep', from: 2026, to: 2033 } },
      ),
    ).toBe(0.85);
  });

  it('no solver at all behaves like effectiveSuccessTarget', () => {
    expect(solverSuccessTarget({ settings: SETTINGS }, { assumption_overrides: overridden })).toBe(
      0.9,
    );
    expect(solverSuccessTarget({ settings: SETTINGS }, undefined)).toBe(0.85);
    expect(solverSuccessTarget(null, null)).toBe(0.85);
  });
});

describe('formatCompactUSD', () => {
  it('formats sub-thousand values as plain dollars', () => {
    expect(formatCompactUSD(950)).toBe('$950');
    expect(formatCompactUSD(0)).toBe('$0');
    // 999.4 rounds to 999
    expect(formatCompactUSD(999.4)).toBe('$999');
  });

  it('formats thousands with K', () => {
    // 12500 / 1000 = 12.5 -> "$12.5K"
    expect(formatCompactUSD(12_500)).toBe('$12.5K');
    // 850000 / 1000 = 850.0 -> ".0" trimmed -> "$850K"
    expect(formatCompactUSD(850_000)).toBe('$850K');
  });

  it('formats millions with M and trims trailing .0', () => {
    // 1234567 / 1e6 = 1.234567 -> toFixed(1) = "1.2" -> "$1.2M"
    expect(formatCompactUSD(1_234_567)).toBe('$1.2M');
    // 1000000 / 1e6 = 1.0 -> trimmed -> "$1M"
    expect(formatCompactUSD(1_000_000)).toBe('$1M');
  });

  it('formats billions with B', () => {
    // 2.5e9 / 1e9 = 2.5 -> "$2.5B"
    expect(formatCompactUSD(2_500_000_000)).toBe('$2.5B');
  });

  it('keeps the sign on negatives', () => {
    // |-1500000| / 1e6 = 1.5 -> "-$1.5M"
    expect(formatCompactUSD(-1_500_000)).toBe('-$1.5M');
  });
});

describe('formatClaimAgeMonths', () => {
  it('formats total months as XyZm', () => {
    // 62 * 12 = 744 -> "62y0m"
    expect(formatClaimAgeMonths(744)).toBe('62y0m');
    // 62 * 12 + 3 = 747 -> "62y3m"
    expect(formatClaimAgeMonths(747)).toBe('62y3m');
    // 66 * 12 + 11 = 792 + 11 = 803 -> "66y11m"
    expect(formatClaimAgeMonths(803)).toBe('66y11m');
    // 70 * 12 = 840 -> "70y0m"
    expect(formatClaimAgeMonths(840)).toBe('70y0m');
  });
});

describe('formatElapsed', () => {
  it('milliseconds below one second', () => {
    expect(formatElapsed(850)).toBe('850 ms');
  });
  it('seconds with one decimal at/above one second', () => {
    // 12345 / 1000 = 12.345 -> toFixed(1) = "12.3"
    expect(formatElapsed(12_345)).toBe('12.3 s');
  });
});

describe('buildFanData', () => {
  it('zips percentile arrays into rows with [low, high] band tuples', () => {
    const fan: FanChart = {
      years: [2026, 2027],
      p10: [100, 110],
      p25: [200, 210],
      p50: [300, 310],
      p75: [400, 410],
      p90: [500, 510],
    };
    const rows = buildFanData(fan);
    expect(rows).toEqual([
      {
        year: 2026,
        p10: 100,
        p25: 200,
        p50: 300,
        p75: 400,
        p90: 500,
        band1090: [100, 500], // [p10, p90]
        band2575: [200, 400], // [p25, p75]
      },
      {
        year: 2027,
        p10: 110,
        p25: 210,
        p50: 310,
        p75: 410,
        p90: 510,
        band1090: [110, 510],
        band2575: [210, 410],
      },
    ]);
  });
});

describe('totalIncome / totalWithdrawals', () => {
  it('totalIncome sums the six cash components and ignores the premium share', () => {
    const row = makeRow({
      year: 2030,
      income: {
        wages: 100_000,
        socialSecurity: 20_000,
        taxableInterest: 500,
        dividends: 1_500,
        other: 250,
        // Informational only: wages are already reported NET of this pre-tax
        // payroll deduction, so adding it would double-count (note 13).
        employerHealthPremiumShare: 2_400,
      },
    });
    // 100000 + 20000 + 500 + 1500 + 250 = 122250 (the 2400 share is excluded)
    expect(totalIncome(row)).toBe(122_250);
  });

  it('totalIncome includes the retirement income stream', () => {
    // The part-time/consulting/pension stream is spendable cash exactly like
    // wages: leaving it out would understate the year's income by the amount
    // the portfolio did NOT have to produce.
    const row = makeRow({
      year: 2040,
      income: {
        socialSecurity: 40_000,
        retirement: 24_000,
        taxableInterest: 300,
      },
    });
    // 40000 + 24000 + 300 = 64300
    expect(totalIncome(row)).toBe(64_300);
  });

  it('totalWithdrawals sums the four spending buckets only', () => {
    const row = makeRow({
      year: 2030,
      withdrawals: {
        cash: 1_000,
        taxable: 2_000,
        pretax: 3_000,
        roth: 4_000,
        // Reported separately, not additive: RMD is already inside pretax and
        // a Roth conversion is not spendable cash.
        rothConversion: 50_000,
        rmd: 2_500,
      },
    });
    // 1000 + 2000 + 3000 + 4000 = 10000
    expect(totalWithdrawals(row)).toBe(10_000);
  });

  it('totalExpenses sums the five breakdown lines and excludes taxes + investing', () => {
    const row = makeRow({
      year: 2030,
      expenses: {
        baseline: 60_000,
        charitable: 6_000,
        housing: 14_000,
        health: 9_000,
        oneTime: 2_500,
        // Engine contract: total = baseline + charitable + housing + health +
        // oneTime = 60000 + 6000 + 14000 + 9000 + 2500 = 91500 (tax-exclusive).
        total: 91_500,
      },
      // A transfer into the brokerage, not consumption (note 12) — it must NOT
      // land in the expense total.
      investing: 12_000,
    });
    // Taxes live in taxes.totalTax, never inside expenses.
    row.taxes.totalTax = 12_000;
    expect(totalExpenses(row)).toBe(91_500);
    // Self-summing: the helper reproduces the engine's tax-exclusive total,
    // so the Expenses column and the breakdown Total always agree.
    expect(totalExpenses(row)).toBe(row.expenses.total);
  });

  it('a charitable-only year still self-sums', () => {
    // 0 + 4800 + 0 + 0 + 0 = 4800
    const row = makeRow({
      year: 2040,
      expenses: { charitable: 4_800, total: 4_800 },
    });
    expect(totalExpenses(row)).toBe(4_800);
    expect(totalExpenses(row)).toBe(row.expenses.total);
  });
});

describe('charitableLineLabel', () => {
  it('says when the cashflow charitable line came from the giving rule', () => {
    // Unflagged years are the working-years stream — the label stays plain.
    expect(charitableLineLabel(makeRow({ year: 2030 }))).toBe('Charitable giving');
    expect(charitableLineLabel(makeRow({ year: 2031, flags: [GIVING_RULE_FLAG] }))).toBe(
      'Charitable giving (giving-after-work rule)',
    );
    // Other flags don't rename the line.
    expect(charitableLineLabel(makeRow({ year: 2031, flags: ['sepp'] }))).toBe(
      'Charitable giving',
    );
  });
});

describe('chipInfo (cashflow event/flag chips)', () => {
  it('labels the rollover, SEPP and depleted-SEPP markers', () => {
    expect(chipInfo('rollover-401k').label).toBe('401(k) → IRA rollover');
    expect(chipInfo('rollover-401k').title).toContain('rule of 55');
    expect(chipInfo('sepp').label).toBe('SEPP payment');
    expect(chipInfo('sepp').title).toContain('59½');
    expect(chipInfo('sepp-depleted').label).toBe('SEPP account depleted');
  });

  it('every marker carries a tooltip', () => {
    for (const marker of ['aca-cliff', 'penalty', 'insolvent', 'no-convergence', 'auto-sepp']) {
      expect(chipInfo(marker).title.length).toBeGreaterThan(marker.length);
    }
  });

  it('names the automatic 72(t) election in plain language', () => {
    expect(chipInfo('auto-sepp').label).toBe('72(t) SEPP started automatically');
    expect(chipInfo('auto-sepp').title).toContain('59½');
  });

  it("states the automatic 72(t) payment when the year's row is available", () => {
    // Locked accounts are skipped by the ordinary ordering, so the carve-out's
    // only draw IS the forced payment — 41,000, next to an ordinary sale.
    const row = makeRow({
      year: 2028,
      withdrawals: { byAccount: { 'ira1-sepp': 41_000, brokerage: 12_500 } },
    });
    expect(seppPaymentInYear(row)).toBe(41_000);
    expect(chipInfo('auto-sepp', row).title).toContain('$41,000');
    // The label never changes — only the tooltip gains the number.
    expect(chipInfo('auto-sepp', row).label).toBe(chipInfo('auto-sepp').label);
  });

  it('falls back to the tax trace when the election took the whole account', () => {
    // fraction 1: no `-sepp` id exists and the payment is drawn under the
    // original id, where it is indistinguishable from an ordinary withdrawal —
    // so the traced payment line is the only honest source.
    const row = makeRow({ year: 2028, withdrawals: { byAccount: { ira1: 139_160.94 } } });
    row.taxes.trace = [
      { label: '72(t) SEPP distribution — IRA', amount: 139_160.94 },
      { label: 'Annual payment (fixed nominal for the whole term)', amount: 139_160.94, indent: 1 },
    ];
    expect(seppPaymentInYear(row)).toBe(139_160.94);
    expect(chipInfo('auto-sepp', row).title).toContain('$139,161'); // formatUSD rounds
  });

  it('leaves the tooltip alone when the year records no 72(t) payment at all', () => {
    const row = makeRow({ year: 2028, withdrawals: { byAccount: { ira1: 41_000 } } });
    expect(seppPaymentInYear(row)).toBeNull();
    expect(chipInfo('auto-sepp', row)).toEqual(chipInfo('auto-sepp'));
  });

  it('sums multiple carve-outs (a second election takes `-sepp2`)', () => {
    const row = makeRow({
      year: 2029,
      withdrawals: { byAccount: { 'ira1-sepp': 30_000, 'ira1-sepp2': 12_000, savings: 500 } },
    });
    expect(seppPaymentInYear(row)).toBe(42_000); // 30,000 + 12,000
  });

  it('names the busted series and states what the recapture cost from the trace', () => {
    // Fix B: the engine states the recapture on the bust year's trace
    // (headline line per busted series); the chip's tooltip surfaces it —
    // the one figure the user wants from that chip.
    expect(chipInfo('sepp-busted').label).toBe('72(t) series busted');
    expect(chipInfo('sepp-busted').title).toContain('72(t)(4)');
    const row = makeRow({ year: 2028, withdrawals: { byAccount: { ira1: 900_000 } } });
    row.taxes.trace = [
      { label: '72(t) series BUSTED — IRA', amount: 43_712.5 },
      { label: 'Recapture base: pre-59 1/2 payments + interest', amount: 437_125, indent: 1 },
    ];
    expect(seppBustCostInYear(row)).toBe(43_712.5);
    expect(chipInfo('sepp-busted', row).title).toContain('$43,713'); // formatUSD rounds
    // The label never changes — only the tooltip gains the number.
    expect(chipInfo('sepp-busted', row).label).toBe(chipInfo('sepp-busted').label);
    // A year with no bust leaves the tooltip alone.
    expect(seppBustCostInYear(makeRow({ year: 2028 }))).toBeNull();
    expect(chipInfo('sepp-busted', makeRow({ year: 2028 }))).toEqual(chipInfo('sepp-busted'));
  });

  it('names the giving-after-work rule in plain language', () => {
    // The engine flags every year whose charitable giving came from the rule
    // rather than the paycheck stream (note 18).
    expect(chipInfo('giving-rule').label).toBe('giving-after-work rule');
    expect(chipInfo('giving-rule').title).toContain('charitable deductions');
  });

  it('unknown markers pass through unchanged', () => {
    // A future engine flag still renders rather than vanishing.
    expect(chipInfo('brand-new-flag')).toEqual({
      label: 'brand-new-flag',
      title: 'brand-new-flag',
    });
  });
});

describe('buildWorstDecileData', () => {
  it('converts the histogram record to year-sorted rows', () => {
    expect(buildWorstDecileData({ '2043': 3, '2039': 1, '2050': 2 })).toEqual([
      { year: 2039, count: 1 },
      { year: 2043, count: 3 },
      { year: 2050, count: 2 },
    ]);
  });

  it('empty histogram -> empty array', () => {
    expect(buildWorstDecileData({})).toEqual([]);
  });
});

describe('buildMagiData', () => {
  // Reference path: ACA years 2026-2027, SS starts by 2034, Medicare starts
  // 2036 (so the IRMAA threshold applies from 2036 - 2 = 2034 on).
  const rows: YearRow[] = [
    makeRow({
      year: 2026,
      inflationIndex: 1.0,
      taxes: makeTaxes({ acaMagi: 60_000, irmaaMagi: 61_000, niitMagi: 62_000, aca: makeAca(24_600) }),
    }),
    makeRow({
      year: 2027,
      inflationIndex: 1.02,
      taxes: makeTaxes({ acaMagi: 70_000, aca: makeAca(null) }),
    }),
    makeRow({
      year: 2034,
      inflationIndex: 1.2,
      income: { socialSecurity: 30_000 },
      taxes: makeTaxes({ irmaaMagi: 120_000 }),
    }),
    makeRow({
      year: 2036,
      inflationIndex: 1.3,
      income: { socialSecurity: 31_000 },
      taxes: makeTaxes({ medicare: makeMedicare() }),
    }),
  ];
  const out = buildMagiData(rows);

  it('copies the three MAGI variants per year', () => {
    expect(out[0].acaMagi).toBe(60_000);
    expect(out[0].irmaaMagi).toBe(61_000);
    expect(out[0].niitMagi).toBe(62_000);
  });

  it('NIIT threshold is $250K flat on every row', () => {
    expect(NIIT_THRESHOLD_MFJ).toBe(250_000);
    for (const r of out) expect(r.niitThreshold).toBe(250_000);
  });

  it('ACA cliff = acaMagi + cliffHeadroom, only when headroom is present', () => {
    // 2026: acaMagi 60000 + headroom 24600 = 84600 (= 4 x FPL 21150)
    expect(out[0].acaCliff).toBe(84_600);
    // 2027: enrolled but cliffHeadroom null -> no cliff point
    expect(out[1].acaCliff).toBeUndefined();
    // 2034: not on ACA -> no cliff point
    expect(out[2].acaCliff).toBeUndefined();
  });

  it('SS tiers appear only in years with SS income', () => {
    expect(out[0].ssTier1).toBeUndefined();
    expect(out[1].ssTier2).toBeUndefined();
    expect(out[2].ssTier1).toBe(SS_PROVISIONAL_TIER1_MFJ); // 32000
    expect(out[2].ssTier2).toBe(SS_PROVISIONAL_TIER2_MFJ); // 44000
    expect(out[3].ssTier1).toBe(32_000);
    expect(out[3].ssTier2).toBe(44_000);
  });

  it('IRMAA first tier applies from 2 years before Medicare, indexed by the premium year', () => {
    expect(IRMAA_TIER1_MFJ_2026).toBe(218_000);
    // Before the lookback window: absent
    expect(out[0].irmaaTier1).toBeUndefined();
    expect(out[1].irmaaTier1).toBeUndefined();
    // The boundary at MAGI-year Y uses the inflationIndex two POSITIONS later
    // (the premium year Y+2 with the 2-year lookback). This 4-row fixture has
    // only 4 positions, so both boundaries extrapolate past the end at the
    // final position's growth ratio g = 1.3 / 1.2.
    // 2034 (position 2): position 4 is one past the end ->
    //   idx = 1.3 x (1.3/1.2) = 1.4083333...; 218000 x 1.4083333... / 1.0
    //   = 307,016.6667
    expect(out[2].irmaaTier1).toBeCloseTo(307_016.6667, 2);
    // 2036 (position 3): position 5 is two past the end ->
    //   idx = 1.3 x (1.3/1.2)^2 = 1.5256944...; 218000 x 1.5256944...
    //   = 332,601.3889
    expect(out[3].irmaaTier1).toBeCloseTo(332_601.3889, 2);
  });

  it('no Medicare anywhere in the path -> no IRMAA series at all', () => {
    const noMedicare = buildMagiData(rows.slice(0, 3));
    for (const r of noMedicare) expect(r.irmaaTier1).toBeUndefined();
  });

  it('empty reference path -> empty output', () => {
    expect(buildMagiData([])).toEqual([]);
  });
});

describe('buildMagiData IRMAA premium-year indexing (consecutive path)', () => {
  // Consecutive years 2032-2036 with a clean index ladder; Medicare starts
  // 2036, so the IRMAA boundary is drawn from 2034 (= 2036 - 2 lookback).
  // No 2026 row, so baseIdx = first row's index = 1.0.
  const rows: YearRow[] = [
    makeRow({ year: 2032, inflationIndex: 1.0 }),
    makeRow({ year: 2033, inflationIndex: 1.05 }),
    makeRow({ year: 2034, inflationIndex: 1.1 }),
    makeRow({ year: 2035, inflationIndex: 1.15 }),
    makeRow({
      year: 2036,
      inflationIndex: 1.2,
      taxes: makeTaxes({ medicare: makeMedicare() }),
    }),
  ];
  const out = buildMagiData(rows);

  it('is absent before the lookback window', () => {
    expect(out[0].irmaaTier1).toBeUndefined(); // 2032
    expect(out[1].irmaaTier1).toBeUndefined(); // 2033
  });

  it('uses the index of the row two positions later when in range', () => {
    // 2034 MAGI sets 2036 premiums: use 2036's index 1.2 (NOT 2034's 1.1).
    // 218000 x 1.2 / 1.0 = 261,600
    expect(out[2].irmaaTier1).toBeCloseTo(261_600, 6);
  });

  it('extrapolates past the end at the final year growth ratio', () => {
    // Final-year ratio g = idx(2036) / idx(2035) = 1.2 / 1.15 = 1.0434783...
    // 2035 -> premium year 2037 (one past the end):
    //   idx = 1.2 x (1.2/1.15) = 1.2521739...; x 218000 = 272,973.9130
    expect(out[3].irmaaTier1).toBeCloseTo(272_973.913, 2);
    // 2036 -> premium year 2038 (two past the end):
    //   idx = 1.2 x (1.2/1.15)^2 = 1.3066163...; x 218000 = 284,842.3440
    expect(out[4].irmaaTier1).toBeCloseTo(284_842.344, 2);
  });
});

describe('solverPointsHave', () => {
  const points: SolverPoint[] = [
    { x: 2026, label: '2026', success: 0.8 },
    { x: 2027, label: '2027', success: 0.9, maxSpend: 95_000 },
  ];
  it('true when any point carries the field', () => {
    expect(solverPointsHave(points, 'maxSpend')).toBe(true);
  });
  it('false when no point carries the field', () => {
    expect(solverPointsHave(points, 'expectedLifetimeBenefits')).toBe(false);
    expect(solverPointsHave([], 'maxSpend')).toBe(false);
  });
});

describe('runResultCache', () => {
  it('is a module-level Map keyed by runId', () => {
    expect(runResultCache).toBeInstanceOf(Map);
    const fake = { success: 1 } as unknown as import('../src/shared/types').RunResult;
    runResultCache.set('run-test-1', fake);
    expect(runResultCache.get('run-test-1')).toBe(fake);
    runResultCache.delete('run-test-1');
  });
});

describe('accountLabel', () => {
  const names = { ira1: 'IRA', k401: '401(k)' };

  it('uses the profile display name when the id is a real account', () => {
    expect(accountLabel('ira1', names)).toBe('IRA');
  });

  it('derives a readable label for the engine-synthesized SEPP carve-out', () => {
    // The split-IRA technique creates `<id>-sepp`; it must not show as a raw id.
    expect(accountLabel('ira1-sepp', names)).toBe('IRA (72(t) SEPP)');
  });

  it('derives a readable label for a synthesized rollover destination', () => {
    expect(accountLabel('k401-rollover-ira', names)).toBe('401(k) (rolled over)');
  });

  it('resolves nested synthesized ids', () => {
    // An automatic 72(t) elects on the largest traditional IRA, which for
    // someone whose only pre-tax money was a 401(k) is the rollover IRA the
    // engine just synthesized — so both suffixes stack on one id.
    expect(accountLabel('k401-rollover-ira-sepp', names)).toBe('401(k) (rolled over) (72(t) SEPP)');
    // A second election on the same account takes `-sepp2`.
    expect(accountLabel('ira1-sepp2', names)).toBe('IRA (72(t) SEPP)');
  });

  it('falls back to the raw id when nothing is known', () => {
    expect(accountLabel('mystery', names)).toBe('mystery');
    expect(accountLabel('gone-sepp', {})).toBe('gone (72(t) SEPP)');
  });
});

// ---------------------------------------------------------------------------
// Running the plan: a plain run never solves
// ---------------------------------------------------------------------------

describe('scenarioForPlainRun', () => {
  // A solver can only reach plan.json by hand — typed into the Raw JSON editor,
  // or pasted in with events lifted from one of the user's old scenario files.
  const plan: Scenario = {
    name: 'Plan',
    description: 'Retire at 62',
    assumption_overrides: { settings: { successTarget: 0.9 } },
    events: [{ type: 'retire', person: 'p1', date: '2033-06' }],
    solver: { type: 'max_spend', targetSuccess: 0.85 },
  };

  it('drops a leftover solver so the run stays a plain run', () => {
    const out = scenarioForPlainRun(plan);
    expect('solver' in out).toBe(false);
  });

  it('keeps everything else byte-for-byte', () => {
    const out = scenarioForPlainRun(plan);
    expect(out).toEqual({
      name: 'Plan',
      description: 'Retire at 62',
      assumption_overrides: { settings: { successTarget: 0.9 } },
      events: [{ type: 'retire', person: 'p1', date: '2033-06' }],
    });
  });

  it('leaves the input untouched (the panel keeps editing the plan it holds)', () => {
    scenarioForPlainRun(plan);
    expect(plan.solver).toEqual({ type: 'max_spend', targetSuccess: 0.85 });
  });

  it('is a no-op for a plan that never had a solver', () => {
    const plain: Scenario = { name: 'Plan', events: [] };
    expect(scenarioForPlainRun(plain)).toEqual({ name: 'Plan', events: [] });
  });
});

describe('scenarioWithSolver', () => {
  const plan: Scenario = {
    name: 'Plan',
    events: [{ type: 'retire', person: 'p1', date: '2033-06' }],
    solver: { type: 'max_spend' },
  };

  it('replaces any existing solver with the Explore sweep', () => {
    const out = scenarioWithSolver(plan, { type: 'ss_claim_sweep', stepMonths: 12 });
    expect(out.solver).toEqual({ type: 'ss_claim_sweep', stepMonths: 12 });
    expect(out.events).toEqual([{ type: 'retire', person: 'p1', date: '2033-06' }]);
  });
});

// ---------------------------------------------------------------------------
// "Will this work?" verdict
// ---------------------------------------------------------------------------

describe('typicalShortfallYear', () => {
  it('returns the count-weighted median year', () => {
    // counts 2 + 3 + 1 = 6 failures, half = 3.
    // cumulative: 2047 -> 2 (< 3); 2049 -> 5 (>= 3)  => 2049
    expect(typicalShortfallYear({ '2047': 2, '2049': 3, '2053': 1 })).toBe(2049);
  });

  it('is insensitive to key order (years are sorted, not enumerated)', () => {
    expect(typicalShortfallYear({ '2053': 1, '2049': 3, '2047': 2 })).toBe(2049);
  });

  it('handles a single failing year', () => {
    expect(typicalShortfallYear({ '2044': 7 })).toBe(2044);
  });

  it('takes the lower year when the halves are exactly even', () => {
    // counts 2 + 2 = 4, half = 2; cumulative 2040 -> 2 (>= 2) => 2040
    expect(typicalShortfallYear({ '2040': 2, '2050': 2 })).toBe(2040);
  });

  it('returns null when nothing failed', () => {
    expect(typicalShortfallYear({})).toBe(null);
    expect(typicalShortfallYear({ '2050': 0 })).toBe(null);
  });
});

describe('referencePathInsolvencyYear', () => {
  it('returns the first year flagged insolvent', () => {
    const rows = [
      makeRow({ year: 2040 }),
      makeRow({ year: 2041, flags: ['penalty'] }),
      makeRow({ year: 2042, flags: ['penalty', 'insolvent'] }),
      makeRow({ year: 2043, flags: ['insolvent'] }),
    ];
    expect(referencePathInsolvencyYear(rows)).toBe(2042);
  });

  it('returns null for a path that never runs out', () => {
    expect(referencePathInsolvencyYear([makeRow({ year: 2040 })])).toBe(null);
    expect(referencePathInsolvencyYear([])).toBe(null);
  });
});

describe('runVerdict', () => {
  const base = { worstDecileShortfallYears: {}, referencePath: [] as YearRow[] };

  it('says yes at or above the target', () => {
    const v = runVerdict({ ...base, success: 0.914 }, 0.85);
    expect(v.kind).toBe('yes');
    expect(v.tone).toBe('good');
    // formatPct(0.914, 1) = "91.4%"
    expect(v.headline).toBe('Yes — this plan works in 91.4% of simulated futures');
  });

  it('says close within ten points of the target, naming the target', () => {
    const v = runVerdict({ ...base, success: 0.8 }, 0.85);
    expect(v.kind).toBe('close');
    expect(v.tone).toBe('warn');
    // formatPct(0.8, 1) = "80.0%", formatPct(0.85, 0) = "85%"
    expect(v.headline).toBe(
      'Close — works in 80.0% of simulated futures, short of your 85% target',
    );
  });

  it('says no more than ten points below the target', () => {
    const v = runVerdict({ ...base, success: 0.45 }, 0.85);
    expect(v.kind).toBe('no');
    expect(v.tone).toBe('bad');
    expect(v.headline).toBe('No — works in only 45.0% of simulated futures');
  });

  it('reports when the money runs out, from the worst-decile histogram', () => {
    const v = runVerdict(
      {
        success: 0.45,
        // weighted median of 2 + 3 + 1 failures (half = 3) is 2049
        worstDecileShortfallYears: { '2047': 2, '2049': 3, '2053': 1 },
        referencePath: [makeRow({ year: 2042, flags: ['insolvent'] })],
      },
      0.85,
    );
    expect(v.failureYear).toBe(2049);
    expect(v.timingSource).toBe('worst-decile');
    expect(v.timing).toBe(
      'In the futures that fail, the money typically runs out around 2049.',
    );
  });

  it('falls back to the reference path when there is no histogram', () => {
    const v = runVerdict(
      {
        success: 0,
        worstDecileShortfallYears: {},
        referencePath: [makeRow({ year: 2041 }), makeRow({ year: 2042, flags: ['insolvent'] })],
      },
      0.85,
    );
    expect(v.failureYear).toBe(2042);
    expect(v.timingSource).toBe('reference-path');
    expect(v.timing).toBe(
      'In the futures that fail, the money typically runs out around 2042.',
    );
  });

  it('reports no timing at all when every future succeeds', () => {
    const v = runVerdict(
      {
        success: 1,
        worstDecileShortfallYears: { '2050': 3 },
        referencePath: [makeRow({ year: 2050, flags: ['insolvent'] })],
      },
      0.85,
    );
    expect(v.timing).toBe(null);
    expect(v.timingSource).toBe(null);
    expect(v.failureYear).toBe(null);
  });

  it('reports no timing when a failing run carries no insolvency year anywhere', () => {
    // Success can miss the target on the terminal-value floor alone, with no
    // path ever going insolvent — there is then no year to name.
    const v = runVerdict({ ...base, success: 0.5 }, 0.85);
    expect(v.kind).toBe('no');
    expect(v.timing).toBe(null);
    expect(v.timingSource).toBe(null);
  });
});

// ---------------------------------------------------------------------------
// Explore
// ---------------------------------------------------------------------------

describe('exploreSpec', () => {
  const ctx = { currentYear: 2026, annualSpend: 96_000 };

  it('sweeps the next decade of retirement years, also solving max spend', () => {
    expect(exploreSpec('earliest-stop', ctx)).toEqual({
      type: 'retire_year_sweep',
      from: 2026,
      // 2026 + EXPLORE_RETIRE_HORIZON_YEARS (10)
      to: 2036,
      alsoMaxSpend: true,
    });
  });

  it('uses the profile/scenario success target for max spend (no spec override)', () => {
    expect(exploreSpec('max-spend', ctx)).toEqual({ type: 'max_spend' });
  });

  it('steps the claiming sweep a year at a time (9 points, not 97)', () => {
    expect(exploreSpec('ss-claim', ctx)).toEqual({ type: 'ss_claim_sweep', stepMonths: 12 });
  });

  it('brackets today’s spending for the spending curve', () => {
    expect(exploreSpec('spending-curve', ctx)).toEqual(spendingCurveSpec(96_000));
  });

  it('covers every question on the card', () => {
    for (const q of EXPLORE_QUESTIONS) {
      expect(exploreSpec(q.id, ctx).type).toBeTypeOf('string');
    }
    expect(EXPLORE_QUESTIONS.map((q) => q.id)).toEqual([
      'earliest-stop',
      'max-spend',
      'ss-claim',
      'spending-curve',
    ]);
  });
});

describe('spendingCurveSpec', () => {
  it('runs 60%-160% of today’s spending, rounded to $1,000 steps', () => {
    // base 96,000: from = round(57,600 / 1000) * 1000 = 58,000
    //              to   = round(153,600 / 1000) * 1000 = 154,000
    //              step = round(((154,000 - 58,000) / 7) / 1000) * 1000
    //                   = round(13.714…) * 1000 = 14,000
    expect(spendingCurveSpec(96_000)).toEqual({
      type: 'swr_curve',
      spendFrom: 58_000,
      spendTo: 154_000,
      step: 14_000,
    });
  });

  it('produces about eight probe points', () => {
    // The engine walks spendFrom + i*step while <= spendTo:
    // 58k, 72k, 86k, 100k, 114k, 128k, 142k -> 7 levels (156k overshoots).
    const spec = spendingCurveSpec(96_000);
    const n = Math.floor((spec.spendTo - spec.spendFrom) / spec.step) + 1;
    expect(n).toBe(7);
  });

  it('floors an empty or nonsense spending figure at $12,000/yr', () => {
    // base 12,000: from = round(7,200/1000)*1000 = 7,000
    //              to   = round(19,200/1000)*1000 = 19,000
    //              step = round((12,000/7)/1000)*1000 = round(1.714…)*1000 = 2,000
    const expected = { type: 'swr_curve', spendFrom: 7_000, spendTo: 19_000, step: 2_000 };
    expect(spendingCurveSpec(0)).toEqual(expected);
    expect(spendingCurveSpec(Number.NaN)).toEqual(expected);
    expect(spendingCurveSpec(-5_000)).toEqual(expected);
  });
});

describe('exploreAnswerLine', () => {
  const point = (x: number, success: number, over: Partial<SolverPoint> = {}): SolverPoint => ({
    x,
    label: String(x),
    success,
    ...over,
  });

  it('names the earliest year that reaches the target', () => {
    const out: SolverResult = {
      spec: { type: 'retire_year_sweep', from: 2026, to: 2033, alsoMaxSpend: true },
      points: [point(2026, 0.62), point(2031, 0.86), point(2033, 0.91)],
      answer: 2031,
    };
    expect(exploreAnswerLine('earliest-stop', out, 0.85)).toBe(
      'Earliest year that reaches your 85% target: 2031.',
    );
  });

  it('says so when no year reaches the target, naming the best one', () => {
    const out: SolverResult = {
      spec: { type: 'retire_year_sweep', from: 2026, to: 2028 },
      points: [point(2026, 0.4), point(2027, 0.55), point(2028, 0.52)],
    };
    expect(exploreAnswerLine('earliest-stop', out, 0.85)).toBe(
      'No year from 2026 to 2028 reaches your 85% target — the best is 2027, which works in ' +
        '55.0% of futures.',
    );
  });

  it('states the sustainable spending figure', () => {
    const out: SolverResult = {
      spec: { type: 'max_spend' },
      points: [point(20_000, 0.99), point(118_000, 0.86)],
      answer: 118_000,
    };
    expect(exploreAnswerLine('max-spend', out, 0.85)).toBe(
      'You could spend about $118,000 a year and still hit your 85% target.',
    );
  });

  it('states when even the lowest spending level misses', () => {
    const out: SolverResult = {
      spec: { type: 'max_spend' },
      points: [point(20_000, 0.4), point(400_000, 0.02)],
    };
    expect(exploreAnswerLine('max-spend', out, 0.85)).toBe(
      'Even $20,000 a year misses your 85% target.',
    );
  });

  it('names the best claiming age with its lifetime benefits', () => {
    const best = point(840, 0.884, { label: '70y0m', expectedLifetimeBenefits: 1_234_567 });
    const out: SolverResult = {
      spec: { type: 'ss_claim_sweep', stepMonths: 12 },
      points: [point(744, 0.81, { label: '62y0m', expectedLifetimeBenefits: 900_000 }), best],
      best,
      answer: 840,
    };
    expect(exploreAnswerLine('ss-claim', out, 0.85)).toBe(
      "Claiming at 70y0m gives the best odds: it works in 88.4% of futures, and pays " +
        "$1,234,567 of lifetime benefits in today's dollars.",
    );
  });

  it('names the highest spending level on the curve that still meets the target', () => {
    const out: SolverResult = {
      spec: { type: 'swr_curve', spendFrom: 58_000, spendTo: 142_000, step: 42_000 },
      points: [point(58_000, 0.99), point(100_000, 0.88), point(142_000, 0.6)],
      answer: 100_000,
    };
    expect(exploreAnswerLine('spending-curve', out, 0.85)).toBe(
      'Spending up to $100,000 a year stays at or above your 85% target.',
    );
  });

  it('states the range tried when no spending level meets the target', () => {
    const out: SolverResult = {
      spec: { type: 'swr_curve', spendFrom: 58_000, spendTo: 142_000, step: 42_000 },
      points: [point(58_000, 0.7), point(100_000, 0.5), point(142_000, 0.2)],
    };
    expect(exploreAnswerLine('spending-curve', out, 0.85)).toBe(
      'No spending level tried ($58,000 to $142,000 a year) reaches your 85% target.',
    );
  });

  it('degrades gracefully when a sweep produced nothing', () => {
    const out: SolverResult = { spec: { type: 'max_spend' }, points: [] };
    expect(exploreAnswerLine('max-spend', out, 0.85)).toBe('That sweep produced no results.');
  });
});

describe('the Tithing tab reads the carve-out out of a year row (note 21)', () => {
  it('strips the engine’s id suffix to find the parent IRA, bump included', () => {
    // The chart stacks the carve-out UNDER the rest of its parent, which means
    // it has to find the parent by id. The engine writes `<parent>-tithe`, with
    // a `-tithe2`/`-tithe3` bump on collision exactly like `-sepp2`; missing the
    // bumped form would silently draw a zero-height band for the parent and
    // report the whole IRA as being nothing but tithe.
    expect(titheParentIdOf('ira-tithe')).toBe('ira');
    expect(titheParentIdOf('ira-tithe2')).toBe('ira');
    expect(titheParentIdOf('k401-rollover-ira-tithe3')).toBe('k401-rollover-ira');
    // A non-carve-out id is returned untouched rather than mangled.
    expect(titheParentIdOf('ira')).toBe('ira');
  });

  it('keeps EVERY year, so the years giving nothing are visible as a gap', () => {
    /*
     * The table and the giving chart both read this, and both have to show the
     * working years. "My church received 27,600 last year and will receive 0
     * for twelve years" is the comparison the user is making, and it cannot be
     * seen from a series that starts at retirement — the hole in the bars IS
     * the finding. So years before the carve-out exists are rows with a zero
     * balance, not absent rows.
     */
    const row = (year: number, tithe: number, withBlock: boolean, charitable = 0): YearRow => {
      const base = makeRow({ year, expenses: { charitable } });
      return {
        ...base,
        balances: {
          byAccount: { ira: 1000 },
          total: 1000,
          totalReal: 1000,
          tithe,
          spendable: 1000 - tithe,
          spendableReal: 1000 - tithe,
        },
        ...(withBlock
          ? {
              tithe: {
                accountId: 'ira-tithe',
                balance: tithe,
                seeded: year === 2032 ? tithe : 0,
                accrued: year > 2032 ? 5 : 0,
                given: 0,
                distributed: 0,
                drawn: 0,
                locked: false,
                forcedDistributionGiven: year === 2033 ? 20 : 0,
                breakGlassReal: tithe,
              },
            }
          : {}),
      };
    };
    const path = [
      row(2030, 0, false, 300), // still working: the paycheck tithe
      row(2031, 0, false, 0), // retired, inside the hold: nothing given
      row(2032, 100, true, 0),
      row(2033, 150, true, 50),
    ];
    const built = buildTitheRows(path);
    expect(built.map((r) => r.year)).toEqual([2030, 2031, 2032, 2033]);
    expect(built[0].carveOut).toBe(0);
    expect(built[2].seeded).toBe(100);

    // The giving split: charity's total, and how much of it the household did
    // not choose. A forced distribution must not be double-counted into both.
    expect(built[3].totalGiven).toBe(50);
    expect(built[3].forced).toBe(20);
    expect(built[3].given).toBe(30);
    expect(built[3].given + built[3].forced).toBe(built[3].totalGiven);
    // A year with no forced distribution attributes the whole gift to the rule.
    expect(built[0].totalGiven).toBe(300);
    expect(built[0].forced).toBe(0);

    // The parent band is the REST of the IRA, never the whole balance — adding
    // the two must give the account back, or the stack double-counts the tithe.
    expect(built[2].carveOut + built[2].restOfIra).toBe(100 + 1000);
  });
});

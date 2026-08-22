/**
 * Pure data-shaping helpers for the results view (the Workbench's right-hand
 * column). No React, no IO — everything here is unit-tested in
 * tests/results-helpers.test.ts.
 */
import type {
  FanChart,
  Profile,
  RunResult,
  Scenario,
  SolverPoint,
  SolverResult,
  SolverSpec,
  YearRow,
} from '../../../shared/types';
import { formatPct, formatUSD } from '../../../shared/util';

/**
 * Module-level run-result cache keyed by runId so navigating away from the
 * Workbench and back doesn't leave the results blank while the live loop
 * re-runs (SPEC §2 run cache is server-side; this is just the UI's in-memory
 * copy).
 */
export const runResultCache = new Map<string, RunResult>();

// ---------------------------------------------------------------------------
// Thresholds charted on the MAGI chart (MFJ).
// The SS provisional-income tiers and the NIIT threshold are statutory and
// unindexed by law (SPEC §7). The IRMAA first-tier boundary is in 2026 dollars
// and is CPI-indexed in the sim (medicare-2026.json irmaaTiersMfj[0].magiOver).
// ---------------------------------------------------------------------------
export const NIIT_THRESHOLD_MFJ = 250_000;
export const SS_PROVISIONAL_TIER1_MFJ = 32_000;
export const SS_PROVISIONAL_TIER2_MFJ = 44_000;
export const IRMAA_TIER1_MFJ_2026 = 218_000;
/** IRMAA premiums are keyed to MAGI from this many years prior (SPEC §7). */
export const IRMAA_MAGI_LOOKBACK_YEARS = 2;

/**
 * Success-gauge color class: good at/above target, warn within 10 percentage
 * points below target, bad further below. Epsilon guards float noise at the
 * exact boundaries (e.g. 0.85 - 0.10).
 */
export function successClass(success: number, target: number): 'good' | 'warn' | 'bad' {
  const EPS = 1e-9;
  if (success >= target - EPS) return 'good';
  if (success >= target - 0.1 - EPS) return 'warn';
  return 'bad';
}

/** Scenario override wins over the profile default; last-resort 0.85. */
export function effectiveSuccessTarget(
  profile: Pick<Profile, 'settings'> | null,
  scenario?: Pick<Scenario, 'assumption_overrides'> | null,
): number {
  return (
    scenario?.assumption_overrides?.settings?.successTarget ??
    profile?.settings.successTarget ??
    0.85
  );
}

/**
 * Solver-aware success target: the target the engine actually used for a run
 * of this plan. Mirrors the engine's precedence exactly —
 * spec.targetSuccess (max_spend / earliest_retirement only) ->
 * scenario assumption_overrides.settings.successTarget ->
 * profile.settings.successTarget -> 0.85.
 */
export function solverSuccessTarget(
  profile: Pick<Profile, 'settings'> | null,
  scenario?: Pick<Scenario, 'assumption_overrides' | 'solver'> | null,
): number {
  const spec = scenario?.solver;
  const specTarget =
    spec && (spec.type === 'max_spend' || spec.type === 'earliest_retirement')
      ? spec.targetSuccess
      : undefined;
  return specTarget ?? effectiveSuccessTarget(profile, scenario);
}

/** Compact axis-tick money: $950, $12.5K, $850K, $1.2M, $2.5B. */
export function formatCompactUSD(value: number): string {
  const sign = value < 0 ? '-' : '';
  const abs = Math.abs(value);
  const fmt = (n: number, suffix: string): string =>
    `${sign}$${n.toFixed(1).replace(/\.0$/, '')}${suffix}`;
  if (abs >= 1e9) return fmt(abs / 1e9, 'B');
  if (abs >= 1e6) return fmt(abs / 1e6, 'M');
  if (abs >= 1e3) return fmt(abs / 1e3, 'K');
  return `${sign}$${Math.round(abs)}`;
}

/** Format a claiming age given in total months, e.g. 747 -> "62y3m". */
export function formatClaimAgeMonths(totalMonths: number): string {
  const m = Math.round(totalMonths);
  const years = Math.floor(m / 12);
  const months = m - years * 12;
  return `${years}y${months}m`;
}

/** "850 ms" below one second, "12.3 s" above. */
export function formatElapsed(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(1)} s`;
}

// ---------------------------------------------------------------------------
// Fan chart
// ---------------------------------------------------------------------------

export interface FanRow {
  year: number;
  p10: number;
  p25: number;
  p50: number;
  p75: number;
  p90: number;
  /** Recharts range-area values: [low, high]. */
  band1090: [number, number];
  band2575: [number, number];
}

export function buildFanData(fan: FanChart): FanRow[] {
  return fan.years.map((year, i) => ({
    year,
    p10: fan.p10[i],
    p25: fan.p25[i],
    p50: fan.p50[i],
    p75: fan.p75[i],
    p90: fan.p90[i],
    band1090: [fan.p10[i], fan.p90[i]],
    band2575: [fan.p25[i], fan.p75[i]],
  }));
}

// ---------------------------------------------------------------------------
// Cashflow table aggregates
// ---------------------------------------------------------------------------

/**
 * Cash income for the year, including the retirement income stream — the
 * part-time/consulting/pension money that starts when the salaries stop. It is
 * spendable cash like wages and Social Security, so leaving it out would
 * understate the year's income by exactly the amount the portfolio did not have
 * to produce.
 *
 * `employerHealthPremiumShare` is deliberately NOT added: wages are already
 * reported net of it (it is a pre-tax payroll deduction, like the 401(k)
 * deferral), so adding it would double-count.
 */
export function totalIncome(row: YearRow): number {
  const inc = row.income;
  return (
    inc.wages +
    inc.socialSecurity +
    inc.retirement +
    inc.taxableInterest +
    inc.dividends +
    inc.other
  );
}

/**
 * Gross withdrawals across the four spending buckets. Roth conversions and
 * RMDs are reported separately (RMDs are already inside `pretax`).
 */
export function totalWithdrawals(row: YearRow): number {
  const w = row.withdrawals;
  return w.cash + w.taxable + w.pretax + w.roth;
}

/**
 * Sum of the expense breakdown lines shown in the cashflow table:
 * baseline + charitable + housing + health + one-time. Taxes are NOT expenses
 * — they live in their own column (taxes.totalTax) — and neither is the
 * `investing` transfer to the brokerage (note 12: it moves money between
 * accounts rather than consuming it). By the YearRow contract this equals
 * expenses.total exactly; computing it here keeps the Expenses column and the
 * expandable breakdown self-summing by construction.
 */
export function totalExpenses(row: YearRow): number {
  const e = row.expenses;
  return e.baseline + e.charitable + e.housing + e.health + e.oneTime;
}

// ---------------------------------------------------------------------------
// Event / flag chips (cashflow table)
// ---------------------------------------------------------------------------

export interface ChipInfo {
  /** Short label rendered inside the chip. */
  label: string;
  /** Tooltip (title attribute) explaining what the marker means. */
  title: string;
}

/**
 * Human-readable label + tooltip for a YearRow `eventsFired` / `flags` entry.
 * Unknown markers pass through unchanged so a new engine flag still renders.
 */
const CHIP_INFO: Record<string, ChipInfo> = {
  'rollover-401k': {
    label: '401(k) → IRA rollover',
    title:
      'The 401(k) was rolled into the traditional IRA at separation. The rule of 55 is lost on ' +
      'rollover, so pre-59½ withdrawals are penalized unless a 72(t) stream is running.',
  },
  'auto-sepp': {
    label: '72(t) SEPP started automatically',
    title:
      'This retirement lands before 59½, so the engine elected a 72(t) series in the retirement ' +
      'year. The payment is sized to what the plan needs each year until 59½ (capped at the ' +
      'formula maximum), and only the principal that payment requires is put under the series — ' +
      'the rest of the IRA stays freely accessible.',
  },
  sepp: {
    label: 'SEPP payment',
    title:
      'A 72(t) substantially-equal-periodic-payment was taken this year. It is forced income ' +
      '(like an RMD) and the account is locked until the later of five years or age 59½.',
  },
  'sepp-depleted': {
    label: 'SEPP account depleted',
    title:
      'The 72(t) account could not fund its full scheduled payment — the stream dies here. In ' +
      'reality a busted SEPP retroactively penalizes every prior payment.',
  },
  'sepp-busted': {
    label: '72(t) series busted',
    title:
      'This year could not be funded from any account the withdrawal order may touch, so the ' +
      'household broke its 72(t) series rather than fail beside its own money. The lock lifts ' +
      'permanently and the year is charged the IRC 72(t)(4) recapture — a retroactive 10% on ' +
      'every pre-59½ payment the series made, plus interest — and the busting draw itself is ' +
      'penalized like any early IRA withdrawal.',
  },
  'giving-rule': {
    label: 'giving-after-work rule',
    title:
      'Charitable giving this year came from the giving-after-work rule rather than the ' +
      'paycheck stream, whole or in part (the retirement year is split between the two). The ' +
      'tax trace names the rule, the base it read and the arithmetic — and the giving still ' +
      'feeds the charitable deductions.',
  },
  'tithe-seeded': {
    label: 'tithe account opened',
    title:
      'A tithe account was carved out inside the largest pre-tax IRA this year — an accounting ' +
      'label on money that never leaves the account, so it costs nothing in tax. Its balance is ' +
      'excluded from spendable assets: it never funds an expense, and it is left out of the ' +
      'success rate, the terminal value and the fan chart.',
  },
  'tithe-basis-missing': {
    label: 'career contributions missing',
    title:
      'At least one retirement account had no “contributed over your career” figure when the ' +
      'tithe account was seeded, so its gains counted as zero rather than being guessed at — the ' +
      'account opened smaller than it should have. Fill the figure in on the Accounts card and ' +
      're-run.',
  },
  'tithe-seed-capped': {
    label: 'seed capped by the IRA',
    title:
      'The untithed gains span every retirement account including Roths, but the tithe account ' +
      'can only be carved out of one pre-tax IRA — and that IRA did not hold the full amount. ' +
      'The remainder stays where it is: there is no way to move Roth money into a traditional ' +
      'IRA, so it is tithed as it is drawn rather than up front.',
  },
  'mortgage-payoff': {
    label: 'mortgage paid off',
    title:
      'The scheduled early payoff fired this year: the remaining principal was paid in one lump ' +
      'from the portfolio through the ordinary withdrawal order — taxed draws, penalized before ' +
      '59½ where a draw is penalizable. From the payoff month the payment, interest and any PMI ' +
      'stop; property tax, insurance and maintenance continue.',
  },
  'aca-cliff': {
    label: 'ACA cliff',
    title: 'MAGI crossed 400% of the federal poverty level and the entire premium tax credit was lost.',
  },
  penalty: {
    label: 'early-withdrawal penalty',
    title: 'A 10% early-withdrawal penalty applied to some pre-59½ distribution this year.',
  },
  insolvent: { label: 'insolvent', title: 'The portfolio ran out of money in this year.' },
  'no-convergence': {
    label: 'no convergence',
    title: 'The withdrawal/tax fixed-point iteration hit its iteration cap for this year.',
  },
};

/**
 * The engine flag marking a year whose charitable giving came (wholly or
 * partly) from the giving-after-work rule instead of the paycheck stream.
 */
export const GIVING_RULE_FLAG = 'giving-rule';

/**
 * Label for the cashflow table's charitable line. The number means two
 * different things depending on the year — the paycheck giving stream, or the
 * rule that replaces it — and a line reading plain "Charitable giving" under a
 * 'none' rule (a run of $0 rows) or a growth rule (a figure that swings with
 * the markets) invites the wrong reading. The flagged years say which.
 */
export function charitableLineLabel(row: Pick<YearRow, 'flags'>): string {
  return row.flags.includes(GIVING_RULE_FLAG)
    ? 'Charitable giving (giving-after-work rule)'
    : 'Charitable giving';
}

/** Engine trace label prefix for a forced 72(t) payment (one line per series). */
const SEPP_TRACE_PREFIX = '72(t) SEPP distribution';

/** Engine trace label prefix for a scheduled mortgage payoff; its amount is the lump. */
const MORTGAGE_PAYOFF_TRACE_PREFIX = 'Mortgage paid off early';

/**
 * The principal a scheduled payoff retired this year, read from the trace —
 * the engine states it there (the purchaseFunding convention: no new YearRow
 * field, so rows without the feature keep their exact shape) and the cashflow
 * table only ever renders traced rows. Null when no payoff fired, so the chip
 * can fall back to its plain text.
 */
export function mortgagePayoffInYear(row: Pick<YearRow, 'taxes'>): number | null {
  let total = 0;
  let found = false;
  for (const line of row.taxes.trace ?? []) {
    if (!line.label.startsWith(MORTGAGE_PAYOFF_TRACE_PREFIX) || line.amount === undefined) continue;
    total += line.amount;
    found = true;
  }
  return found ? total : null;
}

/** Engine trace label prefix for a busted series (Fix B); its amount is the recapture tax. */
const SEPP_BUST_TRACE_PREFIX = '72(t) series BUSTED';

/**
 * The recapture tax charged by this year's bust(s), read from the trace — the
 * engine states it there (headline line per busted series) rather than adding
 * a YearRow field, and the cashflow table only ever renders traced rows. Null
 * when the year busted nothing, so the chip can fall back to its plain text.
 */
export function seppBustCostInYear(row: Pick<YearRow, 'taxes'>): number | null {
  let total = 0;
  let found = false;
  for (const line of row.taxes.trace ?? []) {
    if (!line.label.startsWith(SEPP_BUST_TRACE_PREFIX) || line.amount === undefined) continue;
    total += line.amount;
    found = true;
  }
  return found ? total : null;
}

/**
 * This year's 72(t) payment(s), from the two places the engine states them.
 *
 * 1. The withdrawal breakdown, when the election split the account: every draw
 *    from a carve-out (`<id>-sepp`, `<id>-sepp2`, …). A locked account is
 *    skipped by the ordinary ordering, so a carve-out's only draw IS its
 *    forced payment.
 * 2. Otherwise the tax trace. When the payment needed the WHOLE account there
 *    is no carve-out and the draw sits under the original id, where it cannot
 *    be told apart from an ordinary withdrawal — but the traced year names the
 *    payment outright, and the cashflow table only ever renders traced rows.
 *
 * Null when the year records neither, so a caller can simply omit the figure.
 */
export function seppPaymentInYear(row: Pick<YearRow, 'withdrawals' | 'taxes'>): number | null {
  let total = 0;
  let found = false;
  for (const [id, amount] of Object.entries(row.withdrawals.byAccount)) {
    if (!/-sepp\d*$/.test(id)) continue;
    total += amount;
    found = true;
  }
  if (found) return total;
  for (const line of row.taxes.trace ?? []) {
    if (!line.label.startsWith(SEPP_TRACE_PREFIX) || line.amount === undefined) continue;
    total += line.amount;
    found = true;
  }
  return found ? total : null;
}

/**
 * Chip label + tooltip for a marker. Passing the row lets a marker name its own
 * number — the automatic 72(t) chip states the payment the series was fixed at,
 * and the tithe chip states what the account opened with, which in both cases
 * is the one figure the user wants from that chip.
 */
export function chipInfo(
  marker: string,
  row?: Pick<YearRow, 'withdrawals' | 'taxes' | 'tithe'>,
): ChipInfo {
  const base = CHIP_INFO[marker] ?? { label: marker, title: marker };
  if (row === undefined) return base;
  if (marker === 'tithe-seeded') {
    // A rule that defers without seeding opens the account at $0 and fills it
    // from the first year end; saying "opened with $0" there would read as a
    // failure rather than as the instruction the user gave.
    if (row.tithe === undefined || row.tithe.seeded <= 0) return base;
    return {
      ...base,
      title: `${base.title} It opened with ${formatUSD(row.tithe.seeded)} — the catch-up on gains never tithed.`,
    };
  }
  if (marker === 'sepp-busted') {
    // The one figure the user wants from this chip is what the bust cost.
    const cost = seppBustCostInYear(row);
    if (cost === null) return base;
    return { ...base, title: `${base.title} Recapture charged this year: ${formatUSD(cost)}.` };
  }
  if (marker === 'mortgage-payoff') {
    // The one figure the user wants here is the lump itself.
    const lump = mortgagePayoffInYear(row);
    if (lump === null) return base;
    return { ...base, title: `${base.title} Principal retired: ${formatUSD(lump)}.` };
  }
  if (marker !== 'auto-sepp') return base;
  const payment = seppPaymentInYear(row);
  if (payment === null) return base;
  return { ...base, title: `${base.title} This year’s payment: ${formatUSD(payment)}.` };
}

// ---------------------------------------------------------------------------
// MAGI chart (SPEC §9): each year's MAGI variants against that year's
// applicable thresholds. Threshold series are only present for the years they
// apply so Recharts draws them over the correct ranges.
// ---------------------------------------------------------------------------

export interface MagiRow {
  year: number;
  acaMagi: number;
  irmaaMagi: number;
  niitMagi: number;
  /** 4x FPL cliff, only in ACA-enrolled years (= acaMagi + cliffHeadroom). */
  acaCliff?: number;
  /** Statutory $250K, all years. */
  niitThreshold: number;
  /** SS provisional-income tiers, only when SS benefits are being received. */
  ssTier1?: number;
  ssTier2?: number;
  /**
   * First IRMAA MAGI boundary (2026$ CPI-indexed), shown from 2 years before
   * Medicare enrollment because of the 2-year MAGI lookback. The boundary
   * drawn at MAGI-year Y is the threshold of premium year Y+2 — the year
   * whose premiums that MAGI actually sets.
   */
  irmaaTier1?: number;
}

export function buildMagiData(referencePath: YearRow[]): MagiRow[] {
  // Normalize inflationIndex to the 2026 row so the IRMAA boundary (stated in
  // 2026 dollars) is indexed the same way the sim indexes it.
  const baseRow = referencePath.find((r) => r.year === 2026) ?? referencePath[0];
  const baseIdx = baseRow && baseRow.inflationIndex > 0 ? baseRow.inflationIndex : 1;

  let firstMedicareYear: number | undefined;
  for (const r of referencePath) {
    if (r.taxes.medicare !== null && (firstMedicareYear === undefined || r.year < firstMedicareYear)) {
      firstMedicareYear = r.year;
    }
  }

  // IRMAA premiums for year Y+2 are keyed to MAGI from year Y (2-year
  // lookback), so the boundary charted at Y must be indexed by the inflation
  // index of the row two positions later. Past the end of the path, keep
  // extrapolating at the final year's index growth ratio.
  const n = referencePath.length;
  const lastIdx = n > 0 ? referencePath[n - 1].inflationIndex : 1;
  const growth =
    n >= 2 && referencePath[n - 2].inflationIndex > 0
      ? lastIdx / referencePath[n - 2].inflationIndex
      : 1;
  const idxAt = (j: number): number =>
    j < n ? referencePath[j].inflationIndex : lastIdx * growth ** (j - (n - 1));

  return referencePath.map((row, i) => {
    const m: MagiRow = {
      year: row.year,
      acaMagi: row.taxes.magi.acaMagi,
      irmaaMagi: row.taxes.magi.irmaaMagi,
      niitMagi: row.taxes.magi.niitMagi,
      niitThreshold: NIIT_THRESHOLD_MFJ,
    };
    const aca = row.taxes.aca;
    if (aca && aca.cliffHeadroom !== null) {
      // cliffHeadroom = fpl400Magi - acaMagi, so the cliff line = acaMagi + headroom.
      m.acaCliff = row.taxes.magi.acaMagi + aca.cliffHeadroom;
    }
    if (row.income.socialSecurity > 0) {
      m.ssTier1 = SS_PROVISIONAL_TIER1_MFJ;
      m.ssTier2 = SS_PROVISIONAL_TIER2_MFJ;
    }
    if (
      firstMedicareYear !== undefined &&
      row.year >= firstMedicareYear - IRMAA_MAGI_LOOKBACK_YEARS
    ) {
      m.irmaaTier1 = (IRMAA_TIER1_MFJ_2026 * idxAt(i + IRMAA_MAGI_LOOKBACK_YEARS)) / baseIdx;
    }
    return m;
  });
}

// ---------------------------------------------------------------------------
// Worst-decile insolvency histogram
// ---------------------------------------------------------------------------

export function buildWorstDecileData(
  hist: Record<string, number>,
): Array<{ year: number; count: number }> {
  return Object.entries(hist)
    .map(([year, count]) => ({ year: Number(year), count }))
    .sort((a, b) => a.year - b.year);
}

// ---------------------------------------------------------------------------
// Sweep views
// ---------------------------------------------------------------------------

export function solverPointsHave(
  points: SolverPoint[],
  key: 'maxSpend' | 'expectedLifetimeBenefits' | 'medianTerminalReal',
): boolean {
  return points.some((p) => p[key] != null);
}

// ---------------------------------------------------------------------------
// What a run actually runs: a plain run never solves
// ---------------------------------------------------------------------------

/**
 * The plan a NORMAL run sends: the plan as it stands, minus any `solver` spec.
 *
 * plan.json can still acquire a solver — hand-typed into the Raw JSON editor,
 * or pasted in from one of the user's old scenario files. The engine
 * dispatches on that field (engine/index.ts: `execute`), so leaving it in place
 * would silently turn "run this plan" into a many-simulation sweep whose answer
 * is about a DIFFERENT plan: every sweep overrides the very decisions just made
 * (see solverOverrideNote). Running the plan must mean running it as written,
 * so the solver is stripped here and sweeps are opt-in through Explore
 * (scenarioWithSolver).
 */
export function scenarioForPlainRun(scenario: Scenario): Scenario {
  const { solver: _solver, ...rest } = scenario;
  return rest;
}

/** The same plan with an Explore sweep attached — the only way to solve. */
export function scenarioWithSolver(scenario: Scenario, solver: SolverSpec): Scenario {
  return { ...scenarioForPlainRun(scenario), solver };
}

// ---------------------------------------------------------------------------
// "Will this work?" — the one question a scenario answers
// ---------------------------------------------------------------------------

export type VerdictKind = 'yes' | 'close' | 'no';

export interface RunVerdict {
  kind: VerdictKind;
  /** Color class; shares the success gauge's thresholds exactly. */
  tone: 'good' | 'warn' | 'bad';
  /** Plain-language answer, e.g. "Yes — this plan works in 91.4% of simulated futures". */
  headline: string;
  /** When the money runs out in the futures that fail; null when nothing fails. */
  timing: string | null;
  /** Where `timing` came from, so the page can show the derivation. */
  timingSource: 'worst-decile' | 'reference-path' | null;
  failureYear: number | null;
}

/**
 * Typical insolvency year in a worst-decile shortfall histogram (year ->
 * number of failing paths): the count-weighted median, i.e. the earliest year
 * whose cumulative count reaches half the failures. The median (not the mean)
 * because the histogram's tail is long and a single very late failure should
 * not drag the reported year to a year nothing actually happens in.
 *
 * Returns null for an empty histogram (nothing failed, or the mode records no
 * per-path insolvency years).
 */
export function typicalShortfallYear(hist: Record<string, number>): number | null {
  const rows = Object.entries(hist)
    .map(([year, count]) => ({ year: Number(year), count }))
    .filter((r) => Number.isFinite(r.year) && r.count > 0)
    .sort((a, b) => a.year - b.year);
  const total = rows.reduce((sum, r) => sum + r.count, 0);
  if (total === 0) return null;
  const half = total / 2;
  let cumulative = 0;
  for (const r of rows) {
    cumulative += r.count;
    if (cumulative >= half) return r.year;
  }
  // Unreachable: the cumulative count always reaches `half` on the last row.
  return rows[rows.length - 1].year;
}

/** First year the deterministic reference path ran out of money, if it did. */
export function referencePathInsolvencyYear(referencePath: readonly YearRow[]): number | null {
  const row = referencePath.find((r) => r.flags.includes('insolvent'));
  return row ? row.year : null;
}

/**
 * The verdict headline for a finished run: does this plan work, and if not,
 * when does the money run out?
 *
 * Thresholds match the success gauge (successClass): at/above target is a yes,
 * within 10 points is "close", anything lower is a no. The failure year is the
 * worst-decile histogram's typical year when there is one, else the
 * deterministic reference path's own insolvency year — the only signal a
 * single-path deterministic run has.
 */
export function runVerdict(
  result: Pick<RunResult, 'success' | 'worstDecileShortfallYears' | 'referencePath'>,
  target: number,
): RunVerdict {
  const tone = successClass(result.success, target);
  const kind: VerdictKind = tone === 'good' ? 'yes' : tone === 'warn' ? 'close' : 'no';
  const pct = formatPct(result.success, 1);
  const headline =
    kind === 'yes'
      ? `Yes — this plan works in ${pct} of simulated futures`
      : kind === 'close'
        ? `Close — works in ${pct} of simulated futures, short of your ${formatPct(
            target,
            0,
          )} target`
        : `No — works in only ${pct} of simulated futures`;

  let failureYear: number | null = null;
  let timingSource: RunVerdict['timingSource'] = null;
  if (result.success < 1) {
    failureYear = typicalShortfallYear(result.worstDecileShortfallYears);
    if (failureYear !== null) {
      timingSource = 'worst-decile';
    } else {
      failureYear = referencePathInsolvencyYear(result.referencePath);
      if (failureYear !== null) timingSource = 'reference-path';
    }
  }
  const timing =
    failureYear === null
      ? null
      : `In the futures that fail, the money typically runs out around ${failureYear}.`;

  return { kind, tone, headline, timing, timingSource, failureYear };
}

// ---------------------------------------------------------------------------
// Explore: one-click answers, run against the scenario being viewed
// ---------------------------------------------------------------------------

export type ExploreId = 'earliest-stop' | 'max-spend' | 'ss-claim' | 'spending-curve';

export interface ExploreQuestion {
  id: ExploreId;
  /** The button: the question in the user's words. */
  question: string;
  /** What the run does, and what it therefore ignores in the scenario. */
  detail: string;
}

export const EXPLORE_QUESTIONS: readonly ExploreQuestion[] = [
  {
    id: 'earliest-stop',
    question: 'What is the earliest year we could stop working?',
    detail:
      'Runs the plan once per year for the next decade, with both people stopping work that ' +
      'year, and also solves the most you could spend in each of those years. The slowest answer ' +
      'here — dozens of full simulations.',
  },
  {
    id: 'max-spend',
    question: 'How much could we spend each year?',
    detail:
      'Searches for the highest annual living expense that still hits your success target, ' +
      'keeping everything else in your plan as written.',
  },
  {
    id: 'ss-claim',
    question: 'When should we claim Social Security?',
    detail:
      'Tries every claiming age from 62 to 70 and reports both the success odds and the expected ' +
      'lifetime benefits in today’s dollars.',
  },
  {
    id: 'spending-curve',
    question: 'How does spending change our odds?',
    detail:
      'Charts success against a range of annual spending levels around what you spend today, so ' +
      'you can see how steep the trade-off is.',
  },
];

/** How far ahead "the earliest year we could stop working" looks. */
export const EXPLORE_RETIRE_HORIZON_YEARS = 10;

/**
 * Spending levels for the "how does spending change our odds?" curve: roughly
 * 60%-160% of what the household spends today (living + charitable), in about
 * eight steps. Every level is rounded to the nearest $1,000 so the chart's
 * axis and the table read like money rather than like arithmetic. A household
 * with no spending recorded yet gets a $12,000 floor so the range stays valid
 * (the schema requires step >= 1).
 */
export function spendingCurveSpec(annualSpend: number): Extract<SolverSpec, { type: 'swr_curve' }> {
  const base = Number.isFinite(annualSpend) && annualSpend > 12_000 ? annualSpend : 12_000;
  const round1k = (x: number): number => Math.max(1000, Math.round(x / 1000) * 1000);
  const spendFrom = round1k(base * 0.6);
  const spendTo = round1k(base * 1.6);
  const step = round1k((spendTo - spendFrom) / 7);
  return { type: 'swr_curve', spendFrom, spendTo, step };
}

/** The sweep behind each Explore button. */
export function exploreSpec(
  id: ExploreId,
  ctx: { currentYear: number; annualSpend: number },
): SolverSpec {
  switch (id) {
    case 'earliest-stop':
      return {
        type: 'retire_year_sweep',
        from: ctx.currentYear,
        to: ctx.currentYear + EXPLORE_RETIRE_HORIZON_YEARS,
        alsoMaxSpend: true,
      };
    case 'max-spend':
      return { type: 'max_spend' };
    case 'ss-claim':
      // Yearly steps: 62-70 in one-month steps is 97 full simulations for a
      // curve whose shape is already obvious at nine points.
      return { type: 'ss_claim_sweep', stepMonths: 12 };
    case 'spending-curve':
      return spendingCurveSpec(ctx.annualSpend);
  }
}

/**
 * The answer, as a sentence. The engine's own answerLabel is written for the
 * scenario file ("Max spending at >=85% success: $118,000/yr"); this restates
 * the same fact as the answer to the question that was asked.
 */
export function exploreAnswerLine(id: ExploreId, out: SolverResult, target: number): string {
  const points = out.points;
  if (points.length === 0) return 'That sweep produced no results.';
  const targetPct = formatPct(target, 0);
  const xs = points.map((p) => p.x);
  const lo = Math.min(...xs);
  const hi = Math.max(...xs);
  let bestSuccess = points[0];
  for (const p of points) if (p.success > bestSuccess.success) bestSuccess = p;

  switch (id) {
    case 'earliest-stop': {
      const hit = points.find((p) => p.success >= target);
      return hit
        ? `Earliest year that reaches your ${targetPct} target: ${hit.x}.`
        : `No year from ${lo} to ${hi} reaches your ${targetPct} target — the best is ` +
            `${bestSuccess.x}, which works in ${formatPct(bestSuccess.success, 1)} of futures.`;
    }
    case 'max-spend':
      return out.answer !== undefined
        ? `You could spend about ${formatUSD(out.answer)} a year and still hit your ` +
            `${targetPct} target.`
        : `Even ${formatUSD(lo)} a year misses your ${targetPct} target.`;
    case 'ss-claim': {
      const best = out.best ?? bestSuccess;
      const benefits =
        best.expectedLifetimeBenefits != null
          ? `, and pays ${formatUSD(best.expectedLifetimeBenefits)} of lifetime benefits in ` +
            "today's dollars"
          : '';
      return (
        `Claiming at ${best.label} gives the best odds: it works in ` +
        `${formatPct(best.success, 1)} of futures${benefits}.`
      );
    }
    case 'spending-curve': {
      let affordable: SolverPoint | null = null;
      for (const p of points) {
        if (p.success >= target && (affordable === null || p.x > affordable.x)) affordable = p;
      }
      return affordable
        ? `Spending up to ${formatUSD(affordable.x)} a year stays at or above your ` +
            `${targetPct} target.`
        : `No spending level tried (${formatUSD(lo)} to ${formatUSD(hi)} a year) reaches your ` +
            `${targetPct} target.`;
    }
  }
}

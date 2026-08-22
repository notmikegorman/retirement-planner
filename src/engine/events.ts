/**
 * Scenario-event parsing and path-independent schedule precomputation
 * (SPEC §4.1, §9 event vocabulary).
 *
 * Everything here is pure and deterministic: events are normalized into typed
 * structures once (prepareSim), so the per-path simulation loop never touches
 * raw ScenarioEvent objects. An event applies from its month within its year;
 * first-year effects are prorated by months where the spec says so.
 */

import type {
  AcaData,
  AssetMix,
  Assumptions,
  AssumptionOverrides,
  MarketAssumptions,
  ProfileSettings,
  Scenario,
  ScenarioEvent,
  StateCode,
  WithdrawalPolicy,
} from '../shared/types';
import { parseYearMonth } from '../shared/util';

/** A parsed "YYYY-MM". */
export interface YM {
  year: number;
  month: number; // 1-12
}

/** Compare two YMs chronologically. */
export function compareYm(a: YM, b: YM): number {
  return a.year !== b.year ? a.year - b.year : a.month - b.month;
}

export interface ParsedBuyHouse {
  ym: YM;
  price: number | 'sale_proceeds';
  financing:
    | 'cash'
    | { downPct: number; rate: number; termYears: number; payoffAfterYears?: number };
  propertyTaxAnnual: number;
  insuranceAnnual: number;
}

export interface ParsedRent {
  start: YM;
  months: number;
  monthlyCost: number;
}

export interface ParsedRothConversion {
  ym: YM | null;
  yearly: boolean;
  amount?: number;
  toBracketTop?: number;
}

/** Expense stream an expense_change event targets (absent = 'living'). */
export type ExpenseCategory = 'living' | 'charitable';

/** A parsed `death` event (see ScenarioEvent's 'death' member for what it means). */
export interface ParsedDeath {
  personId: string;
  ym: YM;
  /**
   * Share of the couple's living baseline the survivor spends, AS WRITTEN, or
   * null when the event did not say.
   *
   * It used to be defaulted here, which read well until per-line survivor
   * amounts arrived: with the default already baked in, household.ts could no
   * longer tell "the user asked for 0.75" from "the user said nothing", and
   * the itemised budget — the household's own answer, line by line — would have
   * lost to a constant nobody typed. Resolving the precedence needs the absent
   * case intact, so the default now lives at the one place that ranks the three
   * sources (household.ts, resolveSurvivorLiving).
   */
  livingFraction: number | null;
  /** Explicit survivor claim date, or null to let household.ts pick the default. */
  survivorClaim: YM | null;
}

/** All scenario events normalized into typed, date-parsed structures. */
export interface ParsedEvents {
  /** personId -> retirement date (last event wins if duplicated). */
  retirements: Map<string, YM>;
  /** personId -> claim date as written (spousal clamping happens in household.ts). */
  claims: Map<string, YM>;
  /**
   * Deaths, in chronological order. Normally empty — a plan is a plan, not a
   * mortality table — and non-empty only when the scenario is deliberately
   * asking the widow-score question. `prepareHousehold` rejects a scenario in
   * which nobody survives.
   */
  deaths: ParsedDeath[];
  expenseChanges: Array<{ ym: YM; multiplier?: number; delta?: number; category: ExpenseCategory }>;
  stateChanges: Array<{ ym: YM; state: StateCode }>;
  /**
   * Every sell_house, in chronological order. A LIST, not a slot: this used to
   * be a single `YM | null` that kept only the last event written, so a plan
   * with two sell/rent/buy cycles (a survivor's downsize after the couple's
   * own move) silently dropped its FIRST sale — the household never sold, the
   * later buy_house REPLACED the still-owned home (housing.ts), and the
   * home's entire equity vanished from the balance sheet without a sale.
   */
  sellHouses: YM[];
  rents: ParsedRent[];
  buys: ParsedBuyHouse[];
  /** `account` absent = every non-savings account (the historical behavior). */
  allocationChanges: Array<{ ym: YM; mix: AssetMix; account?: string }>;
  glidepaths: Array<{ start: YM; end: YM; fromMix: AssetMix; toMix: AssetMix; account?: string }>;
  withdrawalStrategies: Array<{ ym: YM; policy: WithdrawalPolicy }>;
  oneTimeExpenses: Array<{ ym: YM; amount: number }>;
  oneTimeIncomes: Array<{ ym: YM; amount: number; taxable: boolean }>;
  start72t: Array<{ ym: YM; account: string; annualAmount?: number; interestRate?: number }>;
  rothConversions: ParsedRothConversion[];
  /** year -> human-readable labels of events firing that year (YearRow.eventsFired). */
  firedByYear: Map<number, string[]>;
}

function fireLabel(e: ScenarioEvent): string {
  switch (e.type) {
    case 'retire':
    case 'claim_social_security':
    case 'death':
      return `${e.type}:${e.person}`;
    case 'state_change':
      return `${e.type}:${e.state}`;
    default:
      return e.type;
  }
}

function fireYear(e: ScenarioEvent): number | null {
  switch (e.type) {
    case 'rent':
      return parseYearMonth(e.start).year;
    case 'glidepath':
      return parseYearMonth(e.start).year;
    case 'roth_conversion':
      return e.date ? parseYearMonth(e.date).year : null;
    default:
      return 'date' in e ? parseYearMonth(e.date).year : null;
  }
}

/** Normalize scenario events into ParsedEvents. Throws on malformed dates. */
export function parseEvents(events: ScenarioEvent[]): ParsedEvents {
  const out: ParsedEvents = {
    retirements: new Map(),
    claims: new Map(),
    deaths: [],
    expenseChanges: [],
    stateChanges: [],
    sellHouses: [],
    rents: [],
    buys: [],
    allocationChanges: [],
    glidepaths: [],
    withdrawalStrategies: [],
    oneTimeExpenses: [],
    oneTimeIncomes: [],
    start72t: [],
    rothConversions: [],
    firedByYear: new Map(),
  };

  for (const e of events) {
    const y = fireYear(e);
    if (y !== null) {
      const list = out.firedByYear.get(y) ?? [];
      list.push(fireLabel(e));
      out.firedByYear.set(y, list);
    }
    switch (e.type) {
      case 'retire':
        out.retirements.set(e.person, parseYearMonth(e.date));
        break;
      case 'claim_social_security':
        out.claims.set(e.person, parseYearMonth(e.date));
        break;
      case 'death':
        out.deaths.push({
          personId: e.person,
          ym: parseYearMonth(e.date),
          // NOT defaulted here — see ParsedDeath.livingFraction. The absent
          // case has to survive this far or per-line survivor amounts can never
          // outrank a constant the user never typed.
          livingFraction: e.livingFraction ?? null,
          survivorClaim: e.survivorClaim ? parseYearMonth(e.survivorClaim) : null,
        });
        break;
      case 'expense_change':
        out.expenseChanges.push({
          ym: parseYearMonth(e.date),
          ...(e.multiplier !== undefined ? { multiplier: e.multiplier } : {}),
          ...(e.delta !== undefined ? { delta: e.delta } : {}),
          category: e.category ?? 'living',
        });
        break;
      case 'state_change':
        out.stateChanges.push({ ym: parseYearMonth(e.date), state: e.state });
        break;
      case 'sell_house':
        out.sellHouses.push(parseYearMonth(e.date));
        break;
      case 'rent':
        out.rents.push({ start: parseYearMonth(e.start), months: e.months, monthlyCost: e.monthlyCost });
        break;
      case 'buy_house':
        out.buys.push({
          ym: parseYearMonth(e.date),
          price: e.price,
          financing: e.financing,
          propertyTaxAnnual: e.propertyTaxAnnual,
          insuranceAnnual: e.insuranceAnnual,
        });
        break;
      case 'allocation_change':
        out.allocationChanges.push({
          ym: parseYearMonth(e.date),
          mix: { ...e.mix },
          ...(e.account !== undefined ? { account: e.account } : {}),
        });
        break;
      case 'glidepath':
        out.glidepaths.push({
          start: parseYearMonth(e.start),
          end: parseYearMonth(e.end),
          fromMix: { ...e.fromMix },
          toMix: { ...e.toMix },
          ...(e.account !== undefined ? { account: e.account } : {}),
        });
        break;
      case 'withdrawal_strategy':
        out.withdrawalStrategies.push({
          ym: parseYearMonth(e.date),
          policy: { order: [...e.policy.order], pretaxPreference: e.policy.pretaxPreference },
        });
        break;
      case 'one_time_expense':
        out.oneTimeExpenses.push({ ym: parseYearMonth(e.date), amount: e.amount });
        break;
      case 'one_time_income':
        // Taxable unless explicitly taxable === false (SPEC §4.1 step 2).
        out.oneTimeIncomes.push({
          ym: parseYearMonth(e.date),
          amount: e.amount,
          taxable: e.taxable !== false,
        });
        break;
      case 'start_72t':
        out.start72t.push({
          ym: parseYearMonth(e.date),
          account: e.account,
          ...(e.annualAmount !== undefined ? { annualAmount: e.annualAmount } : {}),
          ...(e.interestRate !== undefined ? { interestRate: e.interestRate } : {}),
        });
        break;
      case 'roth_conversion':
        out.rothConversions.push({
          ym: e.date ? parseYearMonth(e.date) : null,
          yearly: e.yearly === true,
          ...(e.amount !== undefined ? { amount: e.amount } : {}),
          ...(e.toBracketTop !== undefined ? { toBracketTop: e.toBracketTop } : {}),
        });
        break;
    }
  }

  // Deterministic chronological ordering for date-sensitive lists.
  out.deaths.sort((a, b) => compareYm(a.ym, b.ym));
  out.expenseChanges.sort((a, b) => compareYm(a.ym, b.ym));
  out.stateChanges.sort((a, b) => compareYm(a.ym, b.ym));
  out.withdrawalStrategies.sort((a, b) => compareYm(a.ym, b.ym));
  out.sellHouses.sort(compareYm);
  out.buys.sort((a, b) => compareYm(a.ym, b.ym));
  return out;
}

// ---------------------------------------------------------------------------
// Assumption overrides (deep merge)
// ---------------------------------------------------------------------------

export interface EffectiveAssumptions {
  market: MarketAssumptions;
  aca: AcaData;
  settings: ProfileSettings;
}

/**
 * Apply scenario.assumption_overrides on top of the base assumptions and
 * profile settings. Deep merge: nested objects are merged key-wise, scalars
 * and arrays replace. Inputs are never mutated.
 */
export function applyAssumptionOverrides(
  assumptions: Assumptions,
  settings: ProfileSettings,
  overrides: AssumptionOverrides | undefined,
): EffectiveAssumptions {
  const market = deepMerge(assumptions.market, overrides?.market ?? {}) as MarketAssumptions;
  const aca = deepMerge(assumptions.aca, overrides?.aca ?? {}) as AcaData;
  const merged = deepMerge(settings, overrides?.settings ?? {}) as ProfileSettings;
  return { market, aca, settings: merged };
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function deepMerge(base: unknown, patch: unknown): unknown {
  if (!isPlainObject(base) || !isPlainObject(patch)) {
    return patch === undefined ? structuredClone(base) : structuredClone(patch);
  }
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(base)) out[key] = structuredClone(base[key]);
  for (const key of Object.keys(patch)) {
    const pv = patch[key];
    if (pv === undefined) continue;
    out[key] = isPlainObject(out[key]) && isPlainObject(pv) ? deepMerge(out[key], pv) : structuredClone(pv);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Per-year schedules (path-independent precomputation for prepareSim)
// ---------------------------------------------------------------------------

/**
 * Month-weighted expense-change schedule.
 *
 * multiplier[yi]: the year's average multiplier — a month-by-month walk where
 * each expense_change's multiplier takes effect from its event month, so the
 * first year is prorated by months (SPEC §4.1 step 3). Multiple multipliers
 * compound multiplicatively.
 *
 * deltaReal[yi]: sum of active deltas in REAL (base-year) dollars — the first
 * year prorated by (13 - month)/12 — to be scaled by the CPI index in-sim.
 */
export function expenseScheduleByYear(
  changes: ParsedEvents['expenseChanges'],
  startYear: number,
  horizonYears: number,
): { multiplier: number[]; deltaReal: number[] } {
  const multiplier: number[] = new Array(horizonYears);
  const deltaReal: number[] = new Array(horizonYears);
  for (let yi = 0; yi < horizonYears; yi++) {
    const year = startYear + yi;
    let sum = 0;
    for (let m = 1; m <= 12; m++) {
      let prod = 1;
      for (const c of changes) {
        if (c.multiplier === undefined) continue;
        if (c.ym.year < year || (c.ym.year === year && c.ym.month <= m)) prod *= c.multiplier;
      }
      sum += prod;
    }
    multiplier[yi] = sum / 12;
    let delta = 0;
    for (const c of changes) {
      if (c.delta === undefined) continue;
      if (c.ym.year < year) delta += c.delta;
      else if (c.ym.year === year) delta += (c.delta * (13 - c.ym.month)) / 12;
    }
    deltaReal[yi] = delta;
  }
  return { multiplier, deltaReal };
}

/**
 * Residency per year. SPEC §5: state residency for a whole tax year = the
 * residence on Dec 31, so a state_change during year Y applies to all of Y.
 */
export function residencyByYear(
  homeState: StateCode,
  changes: ParsedEvents['stateChanges'],
  startYear: number,
  horizonYears: number,
): StateCode[] {
  const out: StateCode[] = new Array(horizonYears);
  for (let yi = 0; yi < horizonYears; yi++) {
    const year = startYear + yi;
    let state = homeState;
    for (const c of changes) {
      if (c.ym.year <= year) state = c.state;
    }
    out[yi] = state;
  }
  return out;
}

/** Withdrawal policy per year: initial policy, swapped by withdrawal_strategy events from their date. */
export function withdrawalPolicyByYear(
  initial: WithdrawalPolicy,
  strategies: ParsedEvents['withdrawalStrategies'],
  startYear: number,
  horizonYears: number,
): WithdrawalPolicy[] {
  const out: WithdrawalPolicy[] = new Array(horizonYears);
  for (let yi = 0; yi < horizonYears; yi++) {
    const year = startYear + yi;
    let policy = initial;
    for (const s of strategies) {
      if (s.ym.year <= year) policy = s.policy;
    }
    out[yi] = policy;
  }
  return out;
}

/** An account-targeted allocation for one simulated year. */
export interface TargetedMix {
  accountId: string;
  mix: AssetMix;
}

/** Resolved allocation_change / glidepath schedules (SPEC §9 + note 8). */
export interface AllocationSchedule {
  /**
   * Untargeted governing mix per year (applies to every non-savings account),
   * or null when no untargeted event governs yet.
   */
  global: Array<AssetMix | null>;
  /** Account-targeted governing mixes per year (events carrying an `account`). */
  targeted: TargetedMix[][];
  /** First year an untargeted event governs (null when there is none). */
  globalFromYear: number | null;
  /** accountId -> first year an account-targeted event governs it. */
  targetedFromYear: Map<string, number>;
}

/**
 * Portfolio asset mix per year, or null when no allocation event governs yet
 * (accounts keep their own allocations). allocation_change sets the mix from
 * its year on; glidepath interpolates linearly BY YEAR between its start and
 * end years, then holds toMix (documented simplification: yearly, not monthly,
 * interpolation). When multiple events could govern a year, the one with the
 * latest start date <= that year wins.
 *
 * Events carrying an `account` govern ONLY that account (note 8: the 401(k)
 * can follow its target-date-fund glide while VTI accounts stay 100% equity);
 * events without one govern every non-savings account, as they always have.
 * The two `...FromYear` outputs tell simulate.ts when to switch OFF a
 * target-date fund's automatic glide: an explicit allocation instruction wins
 * over the fund's built-in glidepath from the date it takes effect.
 */
export function allocationSchedules(
  changes: ParsedEvents['allocationChanges'],
  glidepaths: ParsedEvents['glidepaths'],
  startYear: number,
  horizonYears: number,
): AllocationSchedule {
  interface Governor {
    start: YM;
    account?: string;
    mixAt: (year: number) => AssetMix;
  }
  const governors: Governor[] = [];
  for (const c of changes) {
    governors.push({
      start: c.ym,
      ...(c.account !== undefined ? { account: c.account } : {}),
      mixAt: () => c.mix,
    });
  }
  for (const g of glidepaths) {
    const span = g.end.year - g.start.year;
    governors.push({
      start: g.start,
      ...(g.account !== undefined ? { account: g.account } : {}),
      mixAt: (year: number) => {
        const frac = span <= 0 ? 1 : Math.min(1, Math.max(0, (year - g.start.year) / span));
        return {
          stocks: g.fromMix.stocks + (g.toMix.stocks - g.fromMix.stocks) * frac,
          bonds: g.fromMix.bonds + (g.toMix.bonds - g.fromMix.bonds) * frac,
          bills: g.fromMix.bills + (g.toMix.bills - g.fromMix.bills) * frac,
        };
      },
    });
  }

  const pick = (list: Governor[], year: number): Governor | null => {
    let best: Governor | null = null;
    for (const g of list) {
      if (g.start.year <= year && (best === null || compareYm(g.start, best.start) >= 0)) {
        best = g;
      }
    }
    return best;
  };

  const globalGovs = governors.filter((g) => g.account === undefined);
  const byAccount = new Map<string, Governor[]>();
  for (const g of governors) {
    if (g.account === undefined) continue;
    const list = byAccount.get(g.account) ?? [];
    list.push(g);
    byAccount.set(g.account, list);
  }

  const global: Array<AssetMix | null> = new Array(horizonYears);
  const targeted: TargetedMix[][] = new Array(horizonYears);
  for (let yi = 0; yi < horizonYears; yi++) {
    const year = startYear + yi;
    const g = pick(globalGovs, year);
    global[yi] = g ? g.mixAt(year) : null;
    const list: TargetedMix[] = [];
    for (const [accountId, govs] of byAccount) {
      const t = pick(govs, year);
      if (t) list.push({ accountId, mix: t.mixAt(year) });
    }
    targeted[yi] = list;
  }

  let globalFromYear: number | null = null;
  for (const g of globalGovs) {
    if (globalFromYear === null || g.start.year < globalFromYear) globalFromYear = g.start.year;
  }
  const targetedFromYear = new Map<string, number>();
  for (const [accountId, govs] of byAccount) {
    let first = Infinity;
    for (const g of govs) first = Math.min(first, g.start.year);
    targetedFromYear.set(accountId, first);
  }

  return { global, targeted, globalFromYear, targetedFromYear };
}

/** Months of a rent event active in each simulated year (absolute-month overlap). */
export function rentMonthsByYear(rent: ParsedRent, startYear: number, horizonYears: number): number[] {
  const out: number[] = new Array(horizonYears).fill(0);
  const startAbs = rent.start.year * 12 + (rent.start.month - 1);
  const endAbs = startAbs + rent.months; // exclusive
  for (let yi = 0; yi < horizonYears; yi++) {
    const yAbs = (startYear + yi) * 12;
    out[yi] = Math.max(0, Math.min(endAbs, yAbs + 12) - Math.max(startAbs, yAbs));
  }
  return out;
}

/** One-time expense totals per year (nominal at event date — amounts are not CPI-indexed; documented). */
export function oneTimeExpenseByYear(
  items: ParsedEvents['oneTimeExpenses'],
  startYear: number,
  horizonYears: number,
): number[] {
  const out: number[] = new Array(horizonYears).fill(0);
  for (const e of items) {
    const yi = e.ym.year - startYear;
    if (yi >= 0 && yi < horizonYears) out[yi] += e.amount;
  }
  return out;
}

/** One-time income totals per year, split taxable/total (amounts nominal; documented). */
export function oneTimeIncomeByYear(
  items: ParsedEvents['oneTimeIncomes'],
  startYear: number,
  horizonYears: number,
): Array<{ total: number; taxable: number }> {
  const out = Array.from({ length: horizonYears }, () => ({ total: 0, taxable: 0 }));
  for (const e of items) {
    const yi = e.ym.year - startYear;
    if (yi >= 0 && yi < horizonYears) {
      out[yi].total += e.amount;
      if (e.taxable) out[yi].taxable += e.amount;
    }
  }
  return out;
}

/**
 * Active roth_conversion directive per year (or null). A dated event applies
 * to its year only; yearly: true applies from its date's year (or sim start
 * when no date) through the horizon. Later-listed events win on overlap.
 */
export function rothConversionByYear(
  conversions: ParsedRothConversion[],
  startYear: number,
  horizonYears: number,
): Array<{ amount?: number; toBracketTop?: number } | null> {
  const out: Array<{ amount?: number; toBracketTop?: number } | null> = new Array(horizonYears).fill(null);
  for (let yi = 0; yi < horizonYears; yi++) {
    const year = startYear + yi;
    for (const c of conversions) {
      const fromYear = c.ym?.year ?? startYear;
      const active = c.yearly ? year >= fromYear : c.ym !== null && c.ym.year === year;
      if (active) {
        out[yi] = {
          ...(c.amount !== undefined ? { amount: c.amount } : {}),
          ...(c.toBracketTop !== undefined ? { toBracketTop: c.toBracketTop } : {}),
        };
      }
    }
  }
  return out;
}

/*
 * 72(t)/SEPP schedules live in withdrawals.ts (prepareSepp): unlike everything
 * here they need profile facts — the account owner's attained age for the
 * single-life table and their 59 1/2 year for the lock — so they are built where the
 * rest of the distribution machinery lives.
 */

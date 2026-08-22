/**
 * Withdrawal machinery (SPEC §4.2): RMDs, 72(t)/SEPP payment schedules, the
 * ordered withdrawal plan (cash -> taxable -> pretax -> roth by default;
 * policy is data), penalty classification (59 1/2 with annual steps, SEPP,
 * Roth ordering rules), and Roth conversions.
 *
 * Plans are computed as PURE functions of the current account states so the
 * fixed-point tax iteration in simulate.ts can recompute them cheaply; a
 * separate apply step mutates balances once per year after convergence.
 *
 * Documented conventions:
 * - Taxable brokerage sales realize LTCG = S x max(0, 1 - costBasis/balance)
 *   (proportional basis); basis is reduced proportionally on apply. Cash added
 *   to the account (e.g. surplus sweep, the investing stream) raises basis
 *   dollar-for-dollar.
 * - NO RULE OF 55 (note 7): the engine rolls every 401(k) into the account
 *   owner's traditional IRA at separation, and the §72(t)(2)(A)(v) separation
 *   exception does not survive a rollover — so pre-59 1/2 pre-tax money is
 *   penalized unless a 72(t)/SEPP is running. `PenaltyException` keeps its
 *   'rule_of_55' member for the shared contract, but nothing assigns it, and
 *   the deprecated account flags (ruleOf55Eligible / allowsPartialWithdrawals)
 *   are ignored.
 * - 72(t)/SEPP (note 16): a start_72t event computes a FIXED annual payment by
 *   the IRS fixed-amortization method and forces it every year of the lock
 *   (see prepareSepp / seppAnnualPayment). While locked the SEPP account is
 *   skipped by the ordinary withdrawal ordering: any extra distribution would
 *   bust the exception and retroactively penalize the whole series. The
 *   ordering itself never reaches past the lock — but simulate.ts MODELS the
 *   bust as a last resort (a year that cannot meet its need after every
 *   unlocked source, the tithe seat included, lifts the lock and pays the
 *   IRC 72(t)(4) recapture price rather than failing beside its own money).
 * - AUTOMATIC 72(t) (scenario.autoSepp, undefined = ON): retiring before 59 1/2
 *   elects a series by itself — see prepareAutoSepp for who qualifies and
 *   simulate.ts for the sizing. The automatic election is an ordinary election
 *   in every other respect; it just picks its own account and payment.
 * - SPLIT-IRA technique (see seppSplit): an `annualAmount` below the formula
 *   maximum does NOT freeze the whole account. Real practice is to split the
 *   IRA — a SEPP IRA sized so that the desired payment IS its formula maximum,
 *   and a second IRA that stays outside the series and remains freely
 *   accessible (penalized before 59 1/2 like any ordinary IRA). seppSplit
 *   returns that carve-out fraction; simulate.ts materialises the two halves as
 *   two AccountStates, so only the SEPP half is ever locked.
 * - Roth ordering: lifetime contributions first (always tax/penalty-free),
 *   then conversions oldest-first (a conversion younger than 5 calendar years
 *   withdrawn before the penalty-free year takes the 10% penalty on itself),
 *   then earnings (taxable + penalized before the penalty-free year; from the
 *   penalty-free year treated as qualified — account 5-year clocks assumed
 *   met, documented simplification).
 * - RMDs (SPEC §7): from rmdStartAge, per owner, prior-Dec-31 pretax balance /
 *   Uniform Lifetime Table divisor at attained age — forced whether or not
 *   the cash is needed. Ages beyond the table use the last divisor.
 */

import type {
  AccountType,
  AssetMix,
  PenaltyException,
  Person,
  Profile,
  RetirementDistribution,
  RmdTableData,
  WithdrawalBucket,
  WithdrawalPolicy,
} from '../shared/types';
import type { ParsedEvents } from './events';
import { penaltyFreeFromYear } from './household';

// ---------------------------------------------------------------------------
// Account state
// ---------------------------------------------------------------------------

export interface AccountState {
  id: string;
  /** Display name (carried so synthesized accounts can name themselves in traces). */
  name: string;
  type: AccountType;
  owner: string;
  balance: number;
  /** Taxable brokerage only (0 elsewhere). */
  costBasis: number;
  /** Roth only: lifetime direct contributions remaining. */
  rothContributions: number;
  /** Roth only: conversion buckets sorted oldest-first (each has its own 5-year clock). */
  rothConversions: Array<{ year: number; amount: number }>;
  allocation: AssetMix;
  /**
   * Set only on a SEPP IRA carved out of another account by the split-IRA
   * technique (see seppSplit): the id of the account it was split from. The
   * two halves are separate IRAs for every purpose EXCEPT allocation
   * instructions, which target the account the user actually holds and so
   * follow through to the carve-out.
   */
  seppParentId?: string;
  /**
   * Set only on a Tithe Account carve-out (note 21): the id of the IRA it was
   * split from. It follows allocation instructions aimed at the parent for the
   * same reason a SEPP carve-out does — the user holds one account there and
   * an instruction naming it means both halves.
   *
   * The field is also what keeps the carve-out out of trouble elsewhere: the
   * automatic-72(t) scan will not elect on an account carrying it.
   */
  titheParentId?: string;
  /**
   * Retirement accounts only: lifetime dollars contributed, carried straight
   * through from Account.lifetimeContributions. UNDEFINED MEANS UNKNOWN and is
   * not the same as 0 — see the shared type for why the distinction matters to
   * the tithe seed.
   */
  lifetimeContributions?: number;
}

/** Pre-tax and Roth: the wrappers whose gains a tithe on gross pay never reached. */
const RETIREMENT_TYPES: ReadonlySet<AccountType> = new Set([
  '401k',
  'traditional_ira',
  'roth_ira',
]);

/** Build the initial per-path account states from the profile. */
export function initAccountStates(profile: Profile): AccountState[] {
  return profile.accounts.map((a) => ({
    id: a.id,
    name: a.name,
    type: a.type,
    owner: a.owner,
    balance: a.balance,
    costBasis: a.type === 'taxable_brokerage' ? (a.costBasis ?? 0) : 0,
    // Carried only where it means something. A figure left on a savings or
    // brokerage account by an earlier edit is dropped here rather than
    // silently widening the tithe seed's base.
    lifetimeContributions: RETIREMENT_TYPES.has(a.type) ? a.lifetimeContributions : undefined,
    rothContributions: a.type === 'roth_ira' ? (a.rothBasis?.contributions ?? 0) : 0,
    rothConversions:
      a.type === 'roth_ira' && a.rothBasis
        ? [...a.rothBasis.conversions].sort((x, y) => x.year - y.year).map((c) => ({ ...c }))
        : [],
    allocation: { ...a.allocation },
  }));
}

/** Deep-clone account states for a new simulation path. */
export function cloneAccountStates(accounts: AccountState[]): AccountState[] {
  return accounts.map((a) => ({
    ...a,
    allocation: { ...a.allocation },
    rothConversions: a.rothConversions.map((c) => ({ ...c })),
  }));
}

const PRETAX_TYPES: ReadonlySet<AccountType> = new Set(['401k', 'traditional_ira']);

export function isPretax(type: AccountType): boolean {
  return PRETAX_TYPES.has(type);
}

/**
 * A retirement WRAPPER: pre-tax or Roth. These are the accounts the Tithe
 * Account's seed measures untithed gains across (note 21) — savings and the
 * taxable brokerage are excluded because the carve-out lives inside an IRA and
 * can only ever hold pre-tax dollars, so sizing it against money it could
 * never receive would promise more than the wrapper can deliver.
 */
export function isRetirementWrapper(type: AccountType): boolean {
  return RETIREMENT_TYPES.has(type);
}

export function bucketOf(type: AccountType): WithdrawalBucket {
  switch (type) {
    case 'savings':
      return 'cash';
    case 'taxable_brokerage':
      return 'taxable';
    case '401k':
    case 'traditional_ira':
      return 'pretax';
    case 'roth_ira':
      return 'roth';
  }
}

// ---------------------------------------------------------------------------
// RMDs
// ---------------------------------------------------------------------------

export interface RmdItem {
  accountId: string;
  owner: string;
  accountType: AccountType;
  amount: number;
}

/**
 * Forced RMDs for the year: for every pretax account whose owner's age at
 * year end is >= rmdStartAge, prior-year-end balance (the current balance at
 * the point this runs, before any of this year's flows) / the Uniform
 * Lifetime Table divisor at the attained age. Summing per-account equals the
 * per-owner statutory amount because the divisor depends only on age.
 */
export function computeRmds(
  accounts: AccountState[],
  agesByOwner: Map<string, number>,
  rmd: RmdTableData,
): RmdItem[] {
  const out: RmdItem[] = [];
  const tableAges = Object.keys(rmd.uniformLifetimeTable).map(Number);
  const maxAge = Math.max(...tableAges);
  for (const a of accounts) {
    if (!isPretax(a.type) || a.balance <= 0) continue;
    const age = agesByOwner.get(a.owner);
    if (age === undefined || age < rmd.rmdStartAge) continue;
    const divisor = rmd.uniformLifetimeTable[String(Math.min(age, maxAge))];
    const amount = Math.min(a.balance, a.balance / divisor);
    if (amount > 0) out.push({ accountId: a.id, owner: a.owner, accountType: a.type, amount });
  }
  return out;
}

/** RMD items as tax-input distribution slices (forced ordinary income, no penalty at RMD ages). */
export function rmdDistributions(rmds: RmdItem[]): RetirementDistribution[] {
  return rmds.map((r) => ({
    personId: r.owner,
    accountType: r.accountType,
    amount: r.amount,
    taxableAmount: r.amount,
    penaltyException: 'age_59_5',
    penaltyBase: 0,
  }));
}

// ---------------------------------------------------------------------------
// 72(t) / SEPP (note 16)
// ---------------------------------------------------------------------------

/**
 * IRS Single Life Expectancy Table fallback, used only when the assumptions
 * file carries no `singleLifeTable`. NEEDS VERIFICATION if it is ever the
 * value actually used: these are the post-2022 (Treas. Reg. 1.401(a)(9)-9)
 * figures for the ages a pre-59 1/2 SEPP can plausibly start at; the shipped
 * data-defaults/assumptions/rmd-table.json is the verified source.
 */
const SINGLE_LIFE_FALLBACK: Record<string, number> = {
  '50': 36.2, '51': 35.3, '52': 34.3, '53': 33.4, '54': 32.5, '55': 31.6,
  '56': 30.6, '57': 29.8, '58': 28.9, '59': 28.0, '60': 27.1,
};

/** Notice 2022-6 default: the greater of 5% or 120% of the federal mid-term AFR. */
export const SEPP_DEFAULT_RATE = 0.05;

/** Minimum number of SEPP payment years: the election year plus four (the "5 years" leg). */
export const SEPP_MIN_PAYMENT_YEARS = 5;

/**
 * Single life expectancy at `age`, from the assumptions table when present
 * (RmdTableData in shared/types does not declare the field yet, so it is read
 * through a local assertion) and otherwise from the fallback above. Ages
 * outside the table clamp to its ends.
 */
export function singleLifeExpectancy(rmd: RmdTableData, age: number): number {
  const table =
    (rmd as RmdTableData & { singleLifeTable?: Record<string, number> }).singleLifeTable ??
    SINGLE_LIFE_FALLBACK;
  const ages = Object.keys(table).map(Number);
  const lo = Math.min(...ages);
  const hi = Math.max(...ages);
  return table[String(Math.min(hi, Math.max(lo, age)))];
}

/**
 * The IRS FIXED AMORTIZATION method: the level annual payment that amortizes
 * `balance` over `lifeExpectancy` years at `rate`,
 *
 *   P = B x r / (1 - (1 + r)^-N)
 *
 * (Rev. Rul. 2002-62 / Notice 2022-6, which also caps the rate at the greater
 * of 5% or 120% of the federal mid-term AFR — the schema bounds the scenario
 * input at 6% and the engine defaults to 5%.) A 0% rate degenerates to B / N.
 */
export function seppAnnualPayment(balance: number, rate: number, lifeExpectancy: number): number {
  if (balance <= 0 || lifeExpectancy <= 0) return 0;
  if (rate <= 0) return balance / lifeExpectancy;
  return (balance * rate) / (1 - Math.pow(1 + rate, -lifeExpectancy));
}

/** How a 72(t) election splits its account (the split-IRA technique). */
export interface SeppSplit {
  /** Formula maximum for the WHOLE starting balance. */
  maxPayment: number;
  /** The fixed annual payment actually elected: min(requested, maxPayment). */
  payment: number;
  /** payment / maxPayment, clamped to [0, 1]: the share of the account locked. */
  fraction: number;
  /** fraction x balance — the SEPP IRA's balance, whose formula max IS `payment`. */
  principal: number;
}

/**
 * Size the SEPP IRA for an election (the SPLIT-IRA technique).
 *
 * The fixed-amortization payment is proportional to the balance it is computed
 * on, so asking for a payment smaller than the formula maximum is equivalent to
 * carving off a SMALLER IRA and putting the whole of THAT one under the series:
 *
 *   principal = (payment / maxPayment) x balance
 *   principal x r / (1 - (1+r)^-N) = payment   (by construction)
 *
 * The remainder (balance - principal) is a second, ordinary traditional IRA:
 * outside the series, freely withdrawable, and penalized before 59 1/2 exactly
 * like any other IRA. Only the SEPP IRA is locked. With no requested amount
 * (or one at/above the maximum) the fraction is 1: the entire account is the
 * SEPP IRA and there is no split at all.
 */
export function seppSplit(
  balance: number,
  rate: number,
  lifeExpectancy: number,
  requestedAnnual?: number,
): SeppSplit {
  const maxPayment = seppAnnualPayment(balance, rate, lifeExpectancy);
  const payment = Math.max(0, Math.min(requestedAnnual ?? maxPayment, maxPayment));
  const fraction = maxPayment > 0 ? Math.min(1, payment / maxPayment) : 0;
  return { maxPayment, payment, fraction, principal: fraction * balance };
}

/** One prepared 72(t) election (everything path-independent about it). */
export interface PreparedSepp {
  /**
   * True when the engine elected this series itself (scenario.autoSepp), not
   * a start_72t event. Only the trace reads it — everything else about an
   * automatic election behaves exactly like a hand-written one.
   */
  automatic?: boolean;
  accountId: string;
  accountName: string;
  /**
   * Id the carved-out SEPP IRA takes when the election splits the account
   * (unique across the profile). Doubles as this election's stable key: which
   * of the two ids ends up locked is path-dependent (it depends on the balance
   * the amortization lands on), so simulate.ts resolves that in-path.
   */
  seppAccountId: string;
  /** Display name of the carved-out SEPP IRA. */
  seppAccountName: string;
  owner: string;
  /** Owner's attained age in the election year (drives the single-life divisor). */
  ownerAge: number;
  eventYear: number;
  /** Amortization rate actually used (event value, else SEPP_DEFAULT_RATE). */
  rate: number;
  lifeExpectancy: number;
  /**
   * Desired annual payment; the engine caps it at the formula maximum and
   * sizes the SEPP IRA to it (seppSplit).
   */
  requestedAnnual?: number;
  /**
   * Last year of the lock: the LATER of eventYear + 4 (five payments) and the
   * owner's first penalty-free year (59 1/2, annual steps — 2035 for a
   * March-1975 birthday).
   */
  lockThroughYear: number;
  /**
   * Set only on an AUTOMATIC election whose carve was capped by the calendar
   * (the 0.0% incident, DECISIONS.md): committed one-off outflows inside the
   * prospective lock window — numeric-price house purchases above all —
   * exceeded the cash and projected sale proceeds on hand, so the payment was
   * capped to leave `reservedRemainder` of the IRA outside the series. Carried
   * on the spec purely so the election-year trace can say the cap fired and
   * why; nothing else reads it.
   */
  calendarCarveCap?: {
    /** Committed one-off outflows scheduled inside the lock window. */
    committedOutflows: number;
    /** Cash + taxable on hand + projected sale proceeds those outflows can use first. */
    nonIraFunding: number;
    /**
     * The IRA remainder the cap reserved: the net gap
     * (committedOutflows - nonIraFunding) plus the living top-ups the capped
     * payment can no longer carry, both grossed up for the tax and penalty
     * the producing draws will themselves owe (simulate.ts, the closed-form
     * solve beside SEPP_RESERVE_MARGINAL_RATE).
     */
    reservedRemainder: number;
  };
}

/** Minimal account facts prepareSepp needs (profile accounts + rollover destinations). */
export interface SeppAccountRef {
  id: string;
  name: string;
  owner: string;
}

/**
 * Prepare every start_72t election: resolve the owner, the single-life
 * divisor at the owner's attained age in the election year, the amortization
 * rate, the lock window, and the id/name the carved-out SEPP IRA will take if
 * the election splits the account. The BALANCE (and therefore the payment, the
 * split fraction, and which of the two accounts ends up locked) is
 * path-dependent, so all of that is computed in-sim at the election year —
 * after any same-year 401(k) rollover, which is exactly the point of retiring
 * and rolling before starting a SEPP.
 *
 * Throws on an election naming an account that does not exist (a scenario
 * typo would otherwise silently produce no SEPP at all).
 */
export function prepareSepp(
  start72t: ParsedEvents['start72t'],
  accounts: SeppAccountRef[],
  people: Person[],
  rmd: RmdTableData,
): PreparedSepp[] {
  const byId = new Map(accounts.map((a) => [a.id, a]));
  const peopleById = new Map(people.map((p) => [p.id, p]));
  const takenIds = new Set(accounts.map((a) => a.id));
  const out: PreparedSepp[] = [];
  for (const e of start72t) {
    const account = byId.get(e.account);
    if (!account) {
      throw new Error(
        `start_72t references unknown account "${e.account}" ` +
          `(known: ${accounts.map((a) => a.id).join(', ')})`,
      );
    }
    const person = peopleById.get(account.owner);
    if (!person) {
      throw new Error(
        `start_72t account "${e.account}" has owner "${account.owner}", who is not a person in the profile`,
      );
    }
    const ownerAge = e.ym.year - person.birthYear;
    // Id for the carve-out, kept unique against the profile's own ids and any
    // earlier election's (two elections on one account each get their own).
    let seppAccountId = `${account.id}-sepp`;
    for (let n = 2; takenIds.has(seppAccountId); n++) seppAccountId = `${account.id}-sepp${n}`;
    takenIds.add(seppAccountId);
    out.push({
      accountId: account.id,
      accountName: account.name,
      seppAccountId,
      seppAccountName: `${account.name} (72(t) SEPP)`,
      owner: account.owner,
      ownerAge,
      eventYear: e.ym.year,
      rate: e.interestRate ?? SEPP_DEFAULT_RATE,
      lifeExpectancy: singleLifeExpectancy(rmd, ownerAge),
      ...(e.annualAmount !== undefined ? { requestedAnnual: e.annualAmount } : {}),
      lockThroughYear: Math.max(
        e.ym.year + SEPP_MIN_PAYMENT_YEARS - 1,
        penaltyFreeFromYear(person),
      ),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Automatic 72(t)/SEPP bridge (scenario.autoSepp — undefined means ON)
// ---------------------------------------------------------------------------

/**
 * A person who retires BEFORE their own penalty-free year, and therefore gets
 * an automatic 72(t) election in the retirement year. Everything on this
 * object is path-independent; the account, the payment and the split are not —
 * the balance is the post-rollover one and depends on the return path — so
 * simulate.ts resolves those in-sim and builds the PreparedSepp there.
 */
export interface AutoSeppPlan {
  owner: string;
  /** The year the bridge OPENS. The election may land later — see below. */
  retireYear: number;
  /** Owner's birth year, so a later election can re-derive its own age. */
  birthYear: number;
  /**
   * First penalty-free year. The bridge is [retireYear, penaltyFreeYear), and
   * the election may happen in ANY year of it: a household holding house-sale
   * proceeds needs no series until the proceeds run out. Electing before there
   * is a reason to would force taxable income in a year that did not want it,
   * and a 72(t) is irrevocable — so `ownerAge`, `lifeExpectancy`,
   * `bridgeYears` and `lockThroughYear` below are the values FOR AN ELECTION
   * IN `retireYear`, and are re-derived from the actual election year when it
   * turns out to be later.
   */
  penaltyFreeYear: number;
  /** Owner's attained age in the election year (drives the single-life divisor). */
  ownerAge: number;
  /** Amortization rate: the Notice 2022-6 default (no scenario input to override it). */
  rate: number;
  lifeExpectancy: number;
  /** Later of retireYear + 4 and the owner's first penalty-free year. */
  lockThroughYear: number;
  /**
   * penaltyFreeFromYear - retireYear: how many years the bridge has to span
   * (>= 1 by construction). The sizing spreads the household's accessible
   * cash/taxable balances over exactly this many years.
   */
  bridgeYears: number;
}

/**
 * Which people get an automatic 72(t) election, and the fixed inputs for each.
 *
 * A person qualifies when they retire in this scenario in a year strictly
 * before `penaltyFreeFromYear(person)` — that gap IS the bridge the series
 * exists to cross. Two exclusions:
 * - a person with ANY explicit start_72t election (on any account they own)
 *   keeps exactly the election the scenario wrote; the automatic one would be
 *   a second election on the same person and is skipped entirely;
 * - a person who never retires, or retires at/after their penalty-free year,
 *   has no bridge to cross.
 *
 * Pure and path-independent; `enabled` is `scenario.autoSepp !== false`.
 */
export function prepareAutoSepp(
  people: Person[],
  retirements: ParsedEvents['retirements'],
  manual: PreparedSepp[],
  rmd: RmdTableData,
  enabled: boolean,
): AutoSeppPlan[] {
  if (!enabled) return [];
  const manualOwners = new Set(manual.map((m) => m.owner));
  const out: AutoSeppPlan[] = [];
  for (const person of people) {
    const retire = retirements.get(person.id);
    if (!retire) continue;
    const penaltyFree = penaltyFreeFromYear(person);
    if (retire.year >= penaltyFree) continue; // no bridge to cross
    if (manualOwners.has(person.id)) continue; // the explicit election wins
    const ownerAge = retire.year - person.birthYear;
    out.push({
      owner: person.id,
      retireYear: retire.year,
      birthYear: person.birthYear,
      penaltyFreeYear: penaltyFree,
      ownerAge,
      rate: SEPP_DEFAULT_RATE,
      lifeExpectancy: singleLifeExpectancy(rmd, ownerAge),
      lockThroughYear: Math.max(retire.year + SEPP_MIN_PAYMENT_YEARS - 1, penaltyFree),
      bridgeYears: penaltyFree - retire.year,
    });
  }
  return out;
}

/**
 * The plan's inputs FOR A GIVEN ELECTION YEAR.
 *
 * The series is sized on the age it actually starts at, and the lock runs five
 * years from the start or to the penalty-free year, whichever ends later — so
 * every year of delay buys a year of not-yet-taxed income and costs a year of
 * being locked in past the point the exception was needed. Both halves of that
 * trade are computed here rather than at the call site.
 */
export function autoSeppForYear(
  plan: AutoSeppPlan,
  electionYear: number,
  rmd: RmdTableData,
): Pick<AutoSeppPlan, 'ownerAge' | 'lifeExpectancy' | 'bridgeYears' | 'lockThroughYear'> {
  const ownerAge = electionYear - plan.birthYear;
  return {
    ownerAge,
    lifeExpectancy: singleLifeExpectancy(rmd, ownerAge),
    // At least one year, even electing in the final bridge year.
    bridgeYears: Math.max(1, plan.penaltyFreeYear - electionYear),
    lockThroughYear: Math.max(
      electionYear + SEPP_MIN_PAYMENT_YEARS - 1,
      plan.penaltyFreeYear,
    ),
  };
}

/** Forced 72(t) payments as tax-input distribution slices (ordinary income, exception sepp_72t). */
export function seppDistributions(items: RmdItem[]): RetirementDistribution[] {
  return items.map((s) => ({
    personId: s.owner,
    accountType: s.accountType,
    amount: s.amount,
    taxableAmount: s.amount,
    penaltyException: 'sepp_72t',
    penaltyBase: 0,
  }));
}

// ---------------------------------------------------------------------------
// Withdrawal plan
// ---------------------------------------------------------------------------

/** Per-owner facts the penalty rules need for the current year. */
export interface OwnerWithdrawalInfo {
  /** First calendar year pre-tax money is penalty-free (annual-steps 59 1/2). */
  penaltyFreeFromYear: number;
}

export type RothSubBucket = 'contributions' | 'conversion' | 'earnings';

export interface WithdrawalSlice {
  accountId: string;
  accountType: AccountType;
  owner: string;
  bucket: WithdrawalBucket;
  amount: number;
  /** Ordinary-taxable portion (pretax: all; roth: early earnings only; cash/taxable: 0). */
  taxableAmount: number;
  penaltyException: PenaltyException;
  penaltyBase: number;
  /** Taxable brokerage only: LTCG realized by this sale. */
  realizedLtcg: number;
  /** Roth only. */
  rothSubBucket?: RothSubBucket;
  /** Roth conversion-bucket year (rothSubBucket === 'conversion'). */
  conversionYear?: number;
}

export interface WithdrawalPlan {
  slices: WithdrawalSlice[];
  total: number;
  byBucket: Record<WithdrawalBucket, number>;
  realizedLtcg: number;
  penaltyBase: number;
  /** Unmet need after draining every bucket (insolvency signal). */
  shortfall: number;
}

/** Amount already committed against an account (RMDs), by account id. */
export type DrawnByAccount = ReadonlyMap<string, number>;

function available(a: AccountState, drawn: DrawnByAccount): number {
  return Math.max(0, a.balance - (drawn.get(a.id) ?? 0));
}

const NO_ACCOUNTS: ReadonlySet<string> = new Set();

/**
 * Compute the ordered withdrawal plan for `target` gross dollars against the
 * CURRENT account states (pure: nothing is mutated). `drawnByAccount` carries
 * amounts already committed this year (RMDs, 72(t) payments) so they are not
 * double-drawn.
 *
 * `lockedAccounts` are accounts under an active 72(t)/SEPP: they are skipped
 * entirely by the pre-tax ordering, because ANY distribution beyond the fixed
 * series busts the exception and retroactively penalizes every payment made
 * (Rev. Rul. 2002-62 §2.02(e)). The forced payment itself is injected by
 * simulate.ts, not planned here.
 *
 * Bucket order comes from the policy (§4.2, policies are data). Within
 * pretax, `pretaxPreference` decides the order:
 * - 'ira_first': traditional IRAs before 401(k)s;
 * - 'proportional': pro-rata across pretax accounts by available balance.
 * ('rule_of_55_first' is gone — see the module header.)
 *
 * `lastResortAccountId` — THE TITHE ORDERING DECISION (note 21's soft
 * window). During its deferral a Tithe Account carve-out is spendable, but it
 * is a PROMISE, so it is the last money touched: not "last within pretax" but
 * after the policy's ENTIRE order, Roth included. A household in enough
 * trouble to be spending Roth earnings early has not yet touched the gift;
 * only when every bucket the policy names is dry does the promise absorb the
 * shortfall — and what it absorbs is gone for good. The account must ALSO be
 * in `lockedAccounts` so the normal pretax pass cannot reach it mid-order;
 * this step reaches past that lock deliberately, and only here. It draws as
 * an ordinary pretax slice (taxable, and penalized before 59 1/2 like any
 * IRA draw — an emergency does not change the tax code).
 */
export function computeWithdrawalPlan(
  target: number,
  accounts: AccountState[],
  policy: WithdrawalPolicy,
  year: number,
  owners: ReadonlyMap<string, OwnerWithdrawalInfo>,
  lockedAccounts: ReadonlySet<string> = NO_ACCOUNTS,
  drawnByAccount: DrawnByAccount = new Map(),
  lastResortAccountId: string | null = null,
): WithdrawalPlan {
  const plan: WithdrawalPlan = {
    slices: [],
    total: 0,
    byBucket: { cash: 0, taxable: 0, pretax: 0, roth: 0 },
    realizedLtcg: 0,
    penaltyBase: 0,
    shortfall: 0,
  };
  let remaining = target;
  if (remaining <= 0) return plan;

  for (const bucket of policy.order) {
    if (remaining <= 0) break;
    switch (bucket) {
      case 'cash':
        remaining = drawCash(plan, accounts, remaining, drawnByAccount);
        break;
      case 'taxable':
        remaining = drawTaxable(plan, accounts, remaining, drawnByAccount);
        break;
      case 'pretax':
        remaining = drawPretax(
          plan,
          accounts,
          policy,
          year,
          owners,
          lockedAccounts,
          remaining,
          drawnByAccount,
        );
        break;
      case 'roth':
        remaining = drawRoth(plan, accounts, year, owners, remaining, drawnByAccount);
        break;
    }
  }
  if (remaining > 0 && lastResortAccountId !== null) {
    const a = accounts.find((x) => x.id === lastResortAccountId);
    if (a) {
      const amt = Math.min(remaining, available(a, drawnByAccount));
      if (amt > 0) {
        pushPretaxSlice(plan, a, amt, year, owners);
        remaining -= amt;
      }
    }
  }
  plan.shortfall = Math.max(0, remaining);
  return plan;
}

function pushSlice(plan: WithdrawalPlan, slice: WithdrawalSlice): void {
  plan.slices.push(slice);
  plan.total += slice.amount;
  plan.byBucket[slice.bucket] += slice.amount;
  plan.realizedLtcg += slice.realizedLtcg;
  plan.penaltyBase += slice.penaltyBase;
}

function drawCash(
  plan: WithdrawalPlan,
  accounts: AccountState[],
  remaining: number,
  drawn: DrawnByAccount,
): number {
  for (const a of accounts) {
    if (remaining <= 0) break;
    if (a.type !== 'savings') continue;
    const amt = Math.min(remaining, available(a, drawn));
    if (amt <= 0) continue;
    pushSlice(plan, {
      accountId: a.id,
      accountType: a.type,
      owner: a.owner,
      bucket: 'cash',
      amount: amt,
      taxableAmount: 0,
      penaltyException: 'none',
      penaltyBase: 0,
      realizedLtcg: 0,
    });
    remaining -= amt;
  }
  return remaining;
}

function drawTaxable(
  plan: WithdrawalPlan,
  accounts: AccountState[],
  remaining: number,
  drawn: DrawnByAccount,
): number {
  for (const a of accounts) {
    if (remaining <= 0) break;
    if (a.type !== 'taxable_brokerage') continue;
    const avail = available(a, drawn);
    const amt = Math.min(remaining, avail);
    if (amt <= 0) continue;
    const gainFrac = a.balance > 0 ? Math.max(0, 1 - a.costBasis / a.balance) : 0;
    pushSlice(plan, {
      accountId: a.id,
      accountType: a.type,
      owner: a.owner,
      bucket: 'taxable',
      amount: amt,
      taxableAmount: 0, // LTCG carried separately
      penaltyException: 'none',
      penaltyBase: 0,
      realizedLtcg: amt * gainFrac,
    });
    remaining -= amt;
  }
  return remaining;
}

/**
 * Penalty classification for a pretax slice. Post-note-7 there are exactly two
 * outcomes: penalty-free from the owner's 59 1/2 year, penalized before it.
 * (72(t) money never reaches here — a locked account is skipped by the
 * ordering and its forced payment is classified by seppDistributions.)
 */
function pretaxPenalty(
  a: AccountState,
  year: number,
  owners: ReadonlyMap<string, OwnerWithdrawalInfo>,
  amount: number,
): { exception: PenaltyException; base: number } {
  const info = owners.get(a.owner);
  if (!info) return { exception: 'none', base: amount };
  if (year >= info.penaltyFreeFromYear) return { exception: 'age_59_5', base: 0 };
  return { exception: 'none', base: amount };
}

function pushPretaxSlice(
  plan: WithdrawalPlan,
  a: AccountState,
  amt: number,
  year: number,
  owners: ReadonlyMap<string, OwnerWithdrawalInfo>,
): void {
  const pen = pretaxPenalty(a, year, owners, amt);
  pushSlice(plan, {
    accountId: a.id,
    accountType: a.type,
    owner: a.owner,
    bucket: 'pretax',
    amount: amt,
    taxableAmount: amt,
    penaltyException: pen.exception,
    penaltyBase: pen.base,
    realizedLtcg: 0,
  });
}

function drawPretax(
  plan: WithdrawalPlan,
  accounts: AccountState[],
  policy: WithdrawalPolicy,
  year: number,
  owners: ReadonlyMap<string, OwnerWithdrawalInfo>,
  lockedAccounts: ReadonlySet<string>,
  remaining: number,
  drawn: DrawnByAccount,
): number {
  // Accounts under an active SEPP are invisible to the ordering (documented
  // in the module header): drawing from them would bust the exception.
  const pretax = accounts.filter((a) => isPretax(a.type) && !lockedAccounts.has(a.id));

  if (policy.pretaxPreference === 'proportional') {
    let totalAvail = 0;
    for (const a of pretax) totalAvail += available(a, drawn);
    if (totalAvail <= 0) return remaining;
    const need = Math.min(remaining, totalAvail);
    for (const a of pretax) {
      const avail = available(a, drawn);
      if (avail <= 0) continue;
      const amt = (need * avail) / totalAvail;
      if (amt <= 0) continue;
      pushPretaxSlice(plan, a, amt, year, owners);
    }
    return remaining - need;
  }

  // 'ira_first': traditional IRAs before 401(k)s.
  const ordered = [
    ...pretax.filter((a) => a.type === 'traditional_ira'),
    ...pretax.filter((a) => a.type === '401k'),
  ];

  for (const a of ordered) {
    if (remaining <= 0) break;
    const amt = Math.min(remaining, available(a, drawn));
    if (amt <= 0) continue;
    pushPretaxSlice(plan, a, amt, year, owners);
    remaining -= amt;
  }
  return remaining;
}

function drawRoth(
  plan: WithdrawalPlan,
  accounts: AccountState[],
  year: number,
  owners: ReadonlyMap<string, OwnerWithdrawalInfo>,
  remaining: number,
  drawn: DrawnByAccount,
): number {
  for (const a of accounts) {
    if (remaining <= 0) break;
    if (a.type !== 'roth_ira') continue;
    const info = owners.get(a.owner);
    const penaltyFree = info === undefined || year >= info.penaltyFreeFromYear;
    let avail = available(a, drawn);

    // 1. Contributions: tax/penalty-free always.
    const contrib = Math.min(remaining, Math.min(a.rothContributions, avail));
    if (contrib > 0) {
      pushSlice(plan, {
        accountId: a.id,
        accountType: a.type,
        owner: a.owner,
        bucket: 'roth',
        amount: contrib,
        taxableAmount: 0,
        penaltyException: 'roth_basis',
        penaltyBase: 0,
        realizedLtcg: 0,
        rothSubBucket: 'contributions',
      });
      remaining -= contrib;
      avail -= contrib;
    }

    // 2. Conversions, oldest first: 5-year clock each pre-59 1/2 (a conversion
    //    made in year c is penalty-free from year c+5).
    for (const c of a.rothConversions) {
      if (remaining <= 0 || avail <= 0) break;
      const amt = Math.min(remaining, Math.min(c.amount, avail));
      if (amt <= 0) continue;
      const seasoned = year >= c.year + 5;
      const penalized = !penaltyFree && !seasoned;
      pushSlice(plan, {
        accountId: a.id,
        accountType: a.type,
        owner: a.owner,
        bucket: 'roth',
        amount: amt,
        taxableAmount: 0, // conversions were taxed when converted
        penaltyException: penalized ? 'none' : penaltyFree ? 'age_59_5' : 'roth_basis',
        penaltyBase: penalized ? amt : 0,
        realizedLtcg: 0,
        rothSubBucket: 'conversion',
        conversionYear: c.year,
      });
      remaining -= amt;
      avail -= amt;
    }

    // 3. Earnings: taxable + penalized before the penalty-free year; from then
    //    qualified (account 5-year clocks assumed met — documented).
    if (remaining > 0 && avail > 0) {
      const amt = Math.min(remaining, avail);
      pushSlice(plan, {
        accountId: a.id,
        accountType: a.type,
        owner: a.owner,
        bucket: 'roth',
        amount: amt,
        taxableAmount: penaltyFree ? 0 : amt,
        penaltyException: penaltyFree ? 'age_59_5' : 'none',
        penaltyBase: penaltyFree ? 0 : amt,
        realizedLtcg: 0,
        rothSubBucket: 'earnings',
      });
      remaining -= amt;
    }
  }
  return remaining;
}

// ---------------------------------------------------------------------------
// Applying flows
// ---------------------------------------------------------------------------

/** Apply forced distributions — RMDs and 72(t) payments — to balances (mutates). */
export function applyRmds(accounts: AccountState[], rmds: RmdItem[]): void {
  const byId = new Map(accounts.map((a) => [a.id, a]));
  for (const r of rmds) {
    const a = byId.get(r.accountId);
    if (a) a.balance = Math.max(0, a.balance - r.amount);
  }
}

/** Apply a converged withdrawal plan to balances/basis buckets (mutates). */
export function applyWithdrawalPlan(accounts: AccountState[], plan: WithdrawalPlan): void {
  const byId = new Map(accounts.map((a) => [a.id, a]));
  for (const s of plan.slices) {
    const a = byId.get(s.accountId);
    if (!a) continue;
    if (a.type === 'taxable_brokerage' && a.balance > 0) {
      const basisFrac = Math.min(1, a.costBasis / a.balance);
      a.costBasis = Math.max(0, a.costBasis - s.amount * basisFrac);
    }
    if (a.type === 'roth_ira') {
      if (s.rothSubBucket === 'contributions') {
        a.rothContributions = Math.max(0, a.rothContributions - s.amount);
      } else if (s.rothSubBucket === 'conversion') {
        const c = a.rothConversions.find((x) => x.year === s.conversionYear && x.amount > 0);
        if (c) c.amount = Math.max(0, c.amount - s.amount);
      }
    }
    a.balance = Math.max(0, a.balance - s.amount);
  }
  for (const a of accounts) {
    if (a.type === 'roth_ira' && a.rothConversions.length > 0) {
      a.rothConversions = a.rothConversions.filter((c) => c.amount > 0);
    }
  }
}

// ---------------------------------------------------------------------------
// Roth conversions
// ---------------------------------------------------------------------------

export interface ConversionSlice {
  fromAccountId: string;
  owner: string;
  accountType: AccountType;
  amount: number;
}

/**
 * Plan a Roth conversion of up to `amountRequested`, IRA-first (traditional
 * IRAs in profile order, then 401(k)s), capped by each account's balance net
 * of amounts already committed this year (RMDs, 72(t) payments, and
 * withdrawal-plan draws). Accounts under an active SEPP are excluded for the
 * same reason the withdrawal ordering skips them: a conversion is a
 * distribution, and it would bust the series.
 * Pure — used inside the fixed-point iteration; applied once after
 * convergence.
 */
export function planRothConversion(
  accounts: AccountState[],
  drawnByAccount: DrawnByAccount,
  amountRequested: number,
  lockedAccounts: ReadonlySet<string> = NO_ACCOUNTS,
): ConversionSlice[] {
  if (amountRequested <= 0) return [];
  const eligible = accounts.filter((a) => !lockedAccounts.has(a.id));
  const ordered = [
    ...eligible.filter((a) => a.type === 'traditional_ira'),
    ...eligible.filter((a) => a.type === '401k'),
  ];
  const out: ConversionSlice[] = [];
  let remaining = amountRequested;
  for (const a of ordered) {
    if (remaining <= 0) break;
    const amt = Math.min(remaining, available(a, drawnByAccount));
    if (amt <= 0) continue;
    out.push({ fromAccountId: a.id, owner: a.owner, accountType: a.type, amount: amt });
    remaining -= amt;
  }
  return out;
}

/** Conversion slices as tax-input distributions (ordinary income, never penalized). */
export function conversionDistributions(slices: ConversionSlice[]): RetirementDistribution[] {
  return slices.map((s) => ({
    personId: s.owner,
    accountType: s.accountType,
    amount: s.amount,
    taxableAmount: s.amount,
    penaltyException: 'none',
    penaltyBase: 0,
  }));
}

/**
 * Apply a conversion: move balances from pretax accounts into the owner's
 * first Roth IRA as a year-stamped conversion bucket (mutates). When the
 * owner has no Roth IRA, one is synthesized (id `roth_conv_<owner>`) with the
 * source account's allocation — a conversion legally creates a Roth IRA.
 */
export function applyRothConversion(
  accounts: AccountState[],
  slices: ConversionSlice[],
  year: number,
): void {
  for (const s of slices) {
    const from = accounts.find((a) => a.id === s.fromAccountId);
    if (!from) continue;
    const amt = Math.min(s.amount, from.balance);
    if (amt <= 0) continue;
    // Lifetime contributions follow the converted dollars PRO RATA (note 21).
    // A conversion changes the wrapper, not the history: the same money is
    // still part contributed and part earned, and the tithe seed reads pre-tax
    // and Roth balances together, so the household total only stays right if
    // the figure moves with the balance. An unknown source leaves the
    // destination unknown — see the rollover for why a known-plus-unknown sum
    // must not be reported as known.
    const movedContrib =
      from.lifetimeContributions === undefined || from.balance <= 0
        ? undefined
        : from.lifetimeContributions * (amt / from.balance);
    if (from.lifetimeContributions !== undefined && movedContrib !== undefined) {
      from.lifetimeContributions -= movedContrib;
    }
    from.balance -= amt;
    let dest = accounts.find((a) => a.type === 'roth_ira' && a.owner === s.owner);
    const createdDest = dest === undefined;
    if (!dest) {
      dest = {
        id: `roth_conv_${s.owner}`,
        name: `${from.name} (converted to Roth)`,
        type: 'roth_ira',
        owner: s.owner,
        balance: 0,
        costBasis: 0,
        rothContributions: 0,
        rothConversions: [],
        allocation: { ...from.allocation },
      };
      accounts.push(dest);
    }
    if (createdDest) {
      dest.lifetimeContributions = movedContrib;
    } else if (dest.lifetimeContributions === undefined || movedContrib === undefined) {
      dest.lifetimeContributions = undefined;
    } else {
      dest.lifetimeContributions += movedContrib;
    }
    dest.balance += amt;
    const bucket = dest.rothConversions.find((c) => c.year === year);
    if (bucket) bucket.amount += amt;
    else dest.rothConversions.push({ year, amount: amt });
  }
}

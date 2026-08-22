/**
 * Pure helpers behind DashboardPage and ProfilePage.
 *
 * Kept free of React/DOM so they can be unit-tested under vitest's node
 * environment. All money values are dollars, rates are decimals.
 */
import type {
  Account,
  AccountType,
  AssetMix,
  Mortgage,
  Person,
  Profile,
  RothBasis,
  SpendingPolicy,
  StateCode,
  WithdrawalBucket,
  WithdrawalPolicy,
} from '../../../shared/types';
import { DEFAULT_GUARDRAILS } from '../../../shared/types';
import { clamp, formatPct } from '../../../shared/util';

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

export const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
] as const;

export const ACCOUNT_TYPE_LABELS: Record<AccountType, string> = {
  traditional_ira: 'Traditional IRA',
  roth_ira: 'Roth IRA',
  taxable_brokerage: 'Taxable brokerage',
  savings: 'Savings',
  '401k': '401(k)',
};

export function accountTypeLabel(type: AccountType): string {
  return ACCOUNT_TYPE_LABELS[type];
}

export const STATE_LABELS: Record<StateCode, string> = {
  va: 'Virginia',
  sc: 'South Carolina',
  nc: 'North Carolina',
};

export const BUCKET_LABELS: Record<WithdrawalBucket, string> = {
  cash: 'Cash',
  taxable: 'Taxable brokerage',
  pretax: 'Pre-tax (401k/IRA)',
  roth: 'Roth',
};

/**
 * 'rule_of_55_first' was removed from the contract (note 7/15): the engine
 * rolls the 401(k) into the traditional IRA at separation, so there is no
 * rule-of-55 door left to prefer.
 */
export const PRETAX_PREFERENCE_LABELS: Record<WithdrawalPolicy['pretaxPreference'], string> = {
  ira_first: 'IRA first',
  proportional: 'Proportional',
};

/** "March 1975" */
export function formatBirth(birthYear: number, birthMonth: number): string {
  const name = MONTH_NAMES[birthMonth - 1] ?? `month ${birthMonth}`;
  return `${name} ${birthYear}`;
}

// ---------------------------------------------------------------------------
// Dashboard math
// ---------------------------------------------------------------------------

/**
 * Completed age as of (nowYear, nowMonth). The birthday month counts as
 * attained. Pure so the UI can pass `new Date()` values while tests pass
 * fixed ones (engine/tax code never calls this).
 */
export function ageAt(
  nowYear: number,
  nowMonth: number,
  birthYear: number,
  birthMonth: number,
): number {
  return nowYear - birthYear - (nowMonth < birthMonth ? 1 : 0);
}

/** Sum of account balances + home value, minus mortgage balance if any. */
export function netWorth(profile: Profile): number {
  const accounts = profile.accounts.reduce((sum, a) => sum + a.balance, 0);
  const mortgage = profile.home.mortgage?.balance ?? 0;
  return accounts + profile.home.value - mortgage;
}

export function personName(profile: Profile, personId: string): string {
  return profile.people.find((p) => p.id === personId)?.name ?? personId;
}

/** Starter-file convention: notes containing PLACEHOLDER mean "still fake data". */
export function isPlaceholder(notes: string | undefined): boolean {
  return (notes ?? '').includes('PLACEHOLDER');
}

/** Tooltip on the placeholder chip — the marker used to read like part of the name (note 6). */
export const PLACEHOLDER_TITLE =
  'This entry still holds a made-up starter number. Replace it with your real figure ' +
  'and remove "PLACEHOLDER" from its notes.';

// ---------------------------------------------------------------------------
// Account identity + ownership (notes 6, 10)
// ---------------------------------------------------------------------------

/** The literal Account.owner value meaning "titled jointly". */
export const JOINT_OWNER = 'joint';

/**
 * Only taxable brokerage and savings accounts may be owned jointly —
 * retirement accounts are individually owned by law (mirrors the refinement
 * in shared/schemas.ts, which is authoritative).
 */
export const JOINT_OWNABLE_TYPES: readonly AccountType[] = ['taxable_brokerage', 'savings'];

export function canOwnJointly(type: AccountType): boolean {
  return JOINT_OWNABLE_TYPES.includes(type);
}

/** Owner <select> options for an account of this type ("Joint" only where legal). */
export function ownerOptions(
  people: Pick<Person, 'id' | 'name'>[],
  type: AccountType,
): Array<{ value: string; label: string }> {
  const opts = people.map((p) => ({ value: p.id, label: p.name }));
  return canOwnJointly(type) ? [...opts, { value: JOINT_OWNER, label: 'Joint' }] : opts;
}

/** Display name for an account's owner; 'joint' renders as "Joint". */
export function ownerLabel(profile: Profile, owner: string): string {
  return owner === JOINT_OWNER ? 'Joint' : personName(profile, owner);
}

/**
 * Keep `owner` legal for `type`: switching a joint brokerage to an IRA must
 * not leave owner 'joint' (the profile schema rejects it). Falls back to the
 * given person id.
 */
export function normalizeOwnerForType(
  owner: string,
  type: AccountType,
  fallbackPersonId: string,
): string {
  if (owner === JOINT_OWNER && !canOwnJointly(type)) return fallbackPersonId;
  return owner;
}

/** Display name shown everywhere in the UI; falls back to the internal id. */
export function accountDisplayName(account: Pick<Account, 'id' | 'name'>): string {
  return account.name.trim() === '' ? account.id : account.name;
}

/** Look up an account's display name by id (withdrawal breakdowns, event rows). */
export function accountNameById(accounts: Pick<Account, 'id' | 'name'>[], id: string): string {
  const found = accounts.find((a) => a.id === id);
  return found ? accountDisplayName(found) : id;
}

// ---------------------------------------------------------------------------
// Target-date funds (note 8)
// ---------------------------------------------------------------------------

/** Savings is a cash account — a target-date fund makes no sense there. */
export function canBeTargetDateFund(type: AccountType): boolean {
  return type !== 'savings';
}

/** Default target year offered when the TDF checkbox is first ticked. */
export const DEFAULT_TDF_TARGET_YEAR = 2035;

/** Toggle the target-date-fund marker, seeding/clearing the target year. */
export function setTargetDateFund(
  account: Account,
  on: boolean,
  defaultTargetYear: number = DEFAULT_TDF_TARGET_YEAR,
): Account {
  const next: Account = { ...account };
  if (!on || !canBeTargetDateFund(next.type)) {
    delete next.targetDateFund;
    return next;
  }
  next.targetDateFund = { targetYear: account.targetDateFund?.targetYear ?? defaultTargetYear };
  return next;
}

// ---------------------------------------------------------------------------
// Roth funding editor (note 9)
// ---------------------------------------------------------------------------

export function emptyRothBasis(): RothBasis {
  return { contributions: 0, conversions: [] };
}

/** Append a conversion bucket (year, amount) to a Roth basis; returns a copy. */
export function addConversion(basis: RothBasis | undefined, year: number, amount = 0): RothBasis {
  const base = basis ?? emptyRothBasis();
  return { ...base, conversions: [...base.conversions, { year, amount }] };
}

/** Patch one conversion bucket; out-of-range indexes return an unchanged copy. */
export function updateConversion(
  basis: RothBasis | undefined,
  index: number,
  patch: Partial<{ year: number; amount: number }>,
): RothBasis {
  const base = basis ?? emptyRothBasis();
  if (index < 0 || index >= base.conversions.length) {
    return { ...base, conversions: [...base.conversions] };
  }
  const conversions = base.conversions.map((c, i) => (i === index ? { ...c, ...patch } : c));
  return { ...base, conversions };
}

/** Drop one conversion bucket; out-of-range indexes return an unchanged copy. */
export function removeConversion(basis: RothBasis | undefined, index: number): RothBasis {
  const base = basis ?? emptyRothBasis();
  return { ...base, conversions: base.conversions.filter((_, i) => i !== index) };
}

/** Direct contributions + every conversion bucket = total dollars ever put in. */
export function rothBasisTotal(basis: RothBasis | undefined): number {
  if (!basis) return 0;
  return basis.conversions.reduce((sum, c) => sum + c.amount, basis.contributions);
}

// ---------------------------------------------------------------------------
// Lifetime contributions (note 21 — the tithe account's seed base)
// ---------------------------------------------------------------------------

/**
 * The wrappers that carry a `lifetimeContributions` figure: the three
 * retirement accounts. Mirrors the engine's own rule (withdrawals.ts
 * RETIREMENT_TYPES), restated here rather than imported so the profile editor
 * does not pull an engine module into the browser bundle for one predicate. If
 * the engine's list ever changes, this one has to follow.
 *
 * A brokerage or savings account has no such thing: money moves in and out of
 * it freely and the balance is not a record of anything. The engine drops a
 * figure left on one by an earlier edit rather than widening the tithe seed's
 * base with it.
 */
export function hasLifetimeContributions(type: AccountType): boolean {
  return type === '401k' || type === 'traditional_ira' || type === 'roth_ira';
}

/**
 * The two wrappers whose money has never been taxed. They are the ones with no
 * funding history anywhere else in the model — a Roth has `rothBasis` and a
 * brokerage has `costBasis`, but a 401(k) or traditional IRA carries nothing
 * that says how much of its balance is growth.
 */
export function isPretaxAccount(type: AccountType): boolean {
  return type === '401k' || type === 'traditional_ira';
}

// ---------------------------------------------------------------------------
// Expense streams (note 12)
// ---------------------------------------------------------------------------

/** Monthly input -> the annual equivalent shown inline next to the field. */
export function annualFromMonthly(monthly: number): number {
  return monthly * 12;
}

export function spendingPolicySummary(policy: SpendingPolicy): string {
  if (policy.type === 'fixed_percent') {
    return `Fixed percent: ${formatPct(policy.percent ?? 0)} of portfolio/yr`;
  }
  if (policy.type === 'guardrails') {
    const g = policy.guardrails ?? DEFAULT_GUARDRAILS;
    // The band is stated as multiples of the STARTING withdrawal rate, which is
    // what it is — quoting it as a percentage would read as a spending rate.
    return `Guardrails: ${g.lower}–${g.upper}× the starting rate, ${formatPct(
      g.adjustment,
      0,
    )} steps`;
  }
  return 'Fixed real (inflation-adjusted baseline)';
}

export function withdrawalPolicySummary(policy: WithdrawalPolicy): string {
  const order = policy.order.map((b) => BUCKET_LABELS[b]).join(' → ');
  return `${order} · ${PRETAX_PREFERENCE_LABELS[policy.pretaxPreference]}`;
}

// ---------------------------------------------------------------------------
// Editing helpers
// ---------------------------------------------------------------------------

/**
 * Parse a user-typed number. Tolerates commas, $, %, and whitespace.
 * Returns null for empty or unparseable input (caller decides the fallback).
 */
export function parseNumberInput(raw: string): number | null {
  const cleaned = raw.replace(/[,$%\s]/g, '');
  if (cleaned === '') return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

/**
 * Decimal rate -> percent number for display (0.85 -> 85, 0.065 -> 6.5),
 * scrubbing float noise like 85.00000000000001.
 */
export function pctDisplayValue(rate: number): number {
  return Number((rate * 100).toPrecision(12));
}

// ---------------------------------------------------------------------------
// Holdings mode
// ---------------------------------------------------------------------------

/**
 * The schema's own symbol grammar, duplicated here so the editor can refuse
 * before the server does. Uppercase letters/digits plus the separators real
 * tickers use (BRK.B, ^GSPC, BF-B), at most 10 chars.
 */
const SYMBOL_RE = /^[A-Z0-9.^-]{1,10}$/;

/**
 * Normalise a typed ticker: trim, uppercase, then hold it to the schema's
 * grammar. Null means "not a symbol" — the caller reverts rather than storing
 * text the save would bounce with a zod message three tabs from the box.
 */
export function normalizeSymbolInput(raw: string): string | null {
  const symbol = raw.trim().toUpperCase();
  return SYMBOL_RE.test(symbol) ? symbol : null;
}

/**
 * A stored quote's moment, in the market's own clock: "Aug 18, 4:00 PM ET".
 * Eastern time deliberately — that is when the exchange priced it, and a
 * viewer in another zone reading "1:00 PM" would think the quote three hours
 * staler than it is. The label's caller appends "— delayed", because a stored
 * quote is never live and every price should say so.
 */
export function formatQuoteAsOf(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
  return `${fmt.format(d)} ET`;
}

/**
 * The derived mix as a compact "55.7 / 44.3 / 0.0" (stocks/bonds/bills).
 * One decimal: whole percents would show the IRA's 55.69/44.31 as 56/44,
 * which is a different-looking portfolio than the one the engine prices.
 */
export function formatDerivedMix(mix: AssetMix): string {
  const pct = (x: number) => (x * 100).toFixed(1);
  return `${pct(mix.stocks)} / ${pct(mix.bonds)} / ${pct(mix.bills)}`;
}

export function allocationSum(mix: AssetMix): number {
  return mix.stocks + mix.bonds + mix.bills;
}

export function allocationOk(mix: AssetMix): boolean {
  return Math.abs(allocationSum(mix) - 1) < 1e-6;
}

/** Swap arr[index] with its neighbor; out-of-range moves return an unchanged copy. */
export function moveItem<T>(arr: readonly T[], index: number, delta: -1 | 1): T[] {
  const j = index + delta;
  const out = [...arr];
  if (index < 0 || index >= arr.length || j < 0 || j >= arr.length) return out;
  const tmp = out[index] as T;
  out[index] = out[j] as T;
  out[j] = tmp;
  return out;
}

export function uniqueAccountId(accounts: Account[]): string {
  const taken = new Set(accounts.map((a) => a.id));
  let n = 1;
  while (taken.has(`account-${n}`)) n += 1;
  return `account-${n}`;
}

/** A new account starts as a taxable brokerage owned by person 1, named after its id. */
export function makeNewAccount(profile: Profile): Account {
  const id = uniqueAccountId(profile.accounts);
  return {
    id,
    name: 'New account',
    type: 'taxable_brokerage',
    owner: profile.people[0]?.id ?? 'p1',
    balance: 0,
    costBasis: 0,
    allocation: { stocks: 1, bonds: 0, bills: 0 },
  };
}

/**
 * Change an account's type, keeping only the fields relevant to the new type
 * (SPEC §3: costBasis is taxable-only, rothBasis is Roth-only, currentEmployer
 * is 401(k)-only, savings can't be a target-date fund). The deprecated
 * ruleOf55Eligible / allowsPartialWithdrawals flags are dropped outright: the
 * engine rolls the 401(k) into the IRA at separation, so neither is modeled.
 *
 * `lifetimeContributions` is the one field carried across a retype rather than
 * re-seeded: it means the same thing on all three retirement wrappers (what
 * you put in over a career), so an IRA relabelled a 401(k) keeps it — but it
 * is NEVER defaulted to 0, because absent means UNKNOWN and inventing a zero
 * would silently tell the tithe rule that every dollar of the balance is
 * untithed growth.
 *
 * Pass `fallbackPersonId` to also repair the owner: 'joint' is illegal on
 * retirement accounts, so a joint brokerage retyped as an IRA would otherwise
 * produce a profile the server rejects.
 */
export function normalizeAccountForType(
  account: Account,
  type: AccountType,
  fallbackPersonId?: string,
): Account {
  const next: Account = { ...account, type };
  if (fallbackPersonId !== undefined) {
    next.owner = normalizeOwnerForType(account.owner, type, fallbackPersonId);
  }
  delete next.costBasis;
  delete next.rothBasis;
  delete next.currentEmployer;
  delete next.ruleOf55Eligible;
  delete next.allowsPartialWithdrawals;
  if (!canBeTargetDateFund(type)) delete next.targetDateFund;
  if (!hasLifetimeContributions(type)) delete next.lifetimeContributions;
  if (type === 'taxable_brokerage') {
    next.costBasis = account.costBasis ?? 0;
  } else if (type === 'roth_ira') {
    next.rothBasis = account.rothBasis ?? emptyRothBasis();
  } else if (type === '401k') {
    next.currentEmployer = account.currentEmployer ?? false;
  }
  return next;
}

/**
 * Starter mortgage for the Home card's "has mortgage" toggle. Values sit
 * inside the profile schema's bounds (rate <= 0.25, termYears 1-50,
 * startMonth 1-12) so a freshly toggled mortgage always validates; the user
 * fills in the real numbers.
 */
export function makeDefaultMortgage(startYear: number): Mortgage {
  return {
    originalPrincipal: 0,
    balance: 0,
    rate: 0.06,
    termYears: 30,
    startYear,
    startMonth: 1,
  };
}

// ---------------------------------------------------------------------------
// Spending policy
// ---------------------------------------------------------------------------

/** The three policies, in the order the Settings tab asks about them. */
export const SPENDING_TYPE_OPTIONS: Array<{ value: SpendingPolicy['type']; label: string }> = [
  { value: 'fixed_real', label: 'Fixed real (inflation-adjusted)' },
  { value: 'fixed_percent', label: 'Fixed percent of portfolio' },
  { value: 'guardrails', label: 'Guardrails (Guyton-Klinger)' },
];

/**
 * Switch spending-policy type, seeding whatever the new one cannot run without.
 *
 * Guardrails without a band is a rule with no rails: the engine would have to
 * invent them, and invented numbers that change spending are exactly what this
 * app refuses to hide. Writing DEFAULT_GUARDRAILS the moment the type is chosen
 * puts Guyton-Klinger's own figures on screen where they can be argued with.
 */
export function normalizeSpendingPolicy(
  policy: SpendingPolicy,
  type: SpendingPolicy['type'],
): SpendingPolicy {
  if (type === 'fixed_percent') return { type, percent: policy.percent ?? 0.04 };
  if (type === 'guardrails') {
    return { type, guardrails: policy.guardrails ?? { ...DEFAULT_GUARDRAILS } };
  }
  return { type: 'fixed_real' };
}

export type GuardrailKey = 'upper' | 'lower' | 'adjustment' | 'floorFraction' | 'raiseCeiling';

/**
 * The schema's own bounds, restated so a typed figure is CLAMPED here rather
 * than rejected by the server on save. A number outside these is a typo, and
 * failing the whole profile on it — three tabs away from the field — is a
 * miserable way to find out.
 */
const GUARDRAIL_BOUNDS: Record<GuardrailKey, readonly [number, number]> = {
  upper: [1, 3],
  lower: [0.2, 1],
  adjustment: [0.01, 0.5],
  floorFraction: [0.1, 1],
  raiseCeiling: [1, 3],
};

/**
 * Write one rail, in place. An empty floor box means NO FLOOR — the published
 * rule has none — and an empty ceiling box means NO CEILING, the same rule's
 * uncapped prosperity side: both delete the field rather than storing a zero,
 * which the schema would reject anyway. A blank rail keeps its current value:
 * there is no such thing as a band with one edge missing.
 */
export function setGuardrail(
  policy: SpendingPolicy,
  key: GuardrailKey,
  value: number | undefined,
): void {
  const band = policy.guardrails ?? { ...DEFAULT_GUARDRAILS };
  policy.guardrails = band;
  if (value === undefined) {
    if (key === 'floorFraction' || key === 'raiseCeiling') delete band[key];
    return;
  }
  const [lo, hi] = GUARDRAIL_BOUNDS[key];
  band[key] = clamp(value, lo, hi);
}

/** An inverted band breaches both rails every year; the schema rejects it. */
export function guardrailsOk(band: SpendingPolicy['guardrails']): boolean {
  return band === undefined || band.upper > band.lower;
}

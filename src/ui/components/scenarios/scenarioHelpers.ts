/**
 * Pure helpers for the scenario editor (the Workbench panel): event metadata,
 * param summaries,
 * form-field <-> event conversion, assumption-override and solver builders,
 * and raw-JSON parsing. No React, no IO — everything here is unit tested in
 * tests/scenario-helpers.test.ts.
 */
// The 59 1/2 boundary comes from the same pure engine module the simulation
// uses, so the Plan card's 72(t) copy can never disagree with the run.
import { penaltyFreeFromYear } from '../../../engine/household';
import { formatZodError, scenarioSchema } from '../../../shared/schemas';
import { DEFAULT_SURVIVOR_LIVING_FRACTION } from '../../../shared/types';
import type {
  Account,
  AssetMix,
  AssumptionOverrides,
  MarketAssumptions,
  Person,
  Scenario,
  ScenarioEvent,
  SolverSpec,
  SpendingPolicy,
  StateCode,
  WithdrawalBucket,
  WithdrawalPolicy,
  YearMonth,
} from '../../../shared/types';
import { formatPct, formatUSD } from '../../../shared/util';

export type EventType = ScenarioEvent['type'];

/** Sensible default date for newly added events (baseline retirement month). */
export const DEFAULT_EVENT_DATE: YearMonth = '2026-07';

// ---------------------------------------------------------------------------
// Event vocabulary metadata
// ---------------------------------------------------------------------------

export const EVENT_TYPES: Array<{ type: EventType; label: string; hint: string }> = [
  { type: 'retire', label: 'Retire', hint: 'A person stops working on this date' },
  { type: 'claim_social_security', label: 'Claim Social Security', hint: 'Start SS benefits' },
  {
    type: 'expense_change',
    label: 'Expense change',
    hint: 'Multiply or shift the living or charitable stream',
  },
  { type: 'state_change', label: 'State change', hint: 'Residency moves to VA / SC / NC' },
  { type: 'sell_house', label: 'Sell house', hint: 'Sell the primary home' },
  { type: 'rent', label: 'Rent', hint: 'Rent for N months at a monthly cost' },
  { type: 'buy_house', label: 'Buy house', hint: 'Purchase a home, cash or mortgage' },
  {
    type: 'allocation_change',
    label: 'Allocation change',
    hint: 'Change one account’s mix (the whole portfolio is in the plan)',
  },
  {
    type: 'glidepath',
    label: 'Glidepath',
    hint: 'Shift one account’s mix gradually between two dates',
  },
  {
    type: 'withdrawal_strategy',
    label: 'Withdrawal strategy',
    hint: 'Change bucket order / pre-tax rule',
  },
  { type: 'one_time_expense', label: 'One-time expense', hint: 'A single lump-sum outflow' },
  { type: 'one_time_income', label: 'One-time income', hint: 'A single lump-sum inflow' },
  {
    type: 'start_72t',
    label: 'Start 72(t)',
    hint: 'Begin locked SEPP payments from an IRA',
  },
  { type: 'roth_conversion', label: 'Roth conversion', hint: 'Convert pre-tax dollars to Roth' },
];

/**
 * Labels for event types the "add event" picker deliberately does NOT offer,
 * but which a plan can still legitimately contain — so the events list and the
 * edit form have a name for them instead of printing the raw type.
 *
 * `death` is the only one today. It is not in EVENT_TYPES because a dedicated
 * view owns it (the results column's Widow tab, which writes one per death year
 * it probes), exactly as Plan owns `retire` and Housing owns the move: do not
 * offer what another card is going to rewrite. But a plan CAN carry one — a
 * widow run pinned into plan.json, or one pasted into the Raw JSON editor — and
 * when it does, the Events list must be able to show it and let it be edited or
 * removed, which is the whole reason summarizeEvent, eventFieldsFrom, buildEvent
 * and EventForm all have a `death` arm.
 */
const OFF_PICKER_EVENT_LABELS: Partial<Record<EventType, string>> = {
  death: 'Death',
};

export function eventTypeLabel(type: EventType): string {
  return EVENT_TYPES.find((t) => t.type === type)?.label ?? OFF_PICKER_EVENT_LABELS[type] ?? type;
}

// ---------------------------------------------------------------------------
// Dates, sorting, summaries
// ---------------------------------------------------------------------------

/** The date an event fires: `date` for most, `start` for rent/glidepath, null for undated (yearly). */
export function eventDate(e: ScenarioEvent): YearMonth | null {
  if ('date' in e && typeof e.date === 'string') return e.date;
  if ('start' in e) return e.start;
  return null;
}

/** Display order: by date ascending, undated events last, original order as tiebreak. */
export function sortedWithIndex(
  events: readonly ScenarioEvent[],
): Array<{ event: ScenarioEvent; index: number }> {
  return events
    .map((event, index) => ({ event, index }))
    .sort((a, b) => {
      const da = eventDate(a.event) ?? '9999-99';
      const db = eventDate(b.event) ?? '9999-99';
      if (da !== db) return da < db ? -1 : 1;
      return a.index - b.index;
    });
}

export function sortEvents(events: readonly ScenarioEvent[]): ScenarioEvent[] {
  return sortedWithIndex(events).map((x) => x.event);
}

export function personName(people: readonly Person[], id: string): string {
  return people.find((p) => p.id === id)?.name ?? id;
}

/** "60/40/0" (stocks/bonds/bills as whole percents). */
export function formatMix(mix: AssetMix): string {
  const pct = (x: number) => String(Math.round(x * 100));
  return `${pct(mix.stocks)}/${pct(mix.bonds)}/${pct(mix.bills)}`;
}

/** Display name for an account id, falling back to the id itself. */
export function accountName(
  accounts: readonly Pick<Account, 'id' | 'name'>[],
  id: string,
): string {
  const found = accounts.find((a) => a.id === id);
  return found && found.name.trim() !== '' ? found.name : id;
}

/** " (Traditional IRA only)" for a targeted allocation event; '' for all accounts. */
function accountSuffix(
  id: string | undefined,
  accounts: readonly Pick<Account, 'id' | 'name'>[],
): string {
  return id ? ` — ${accountName(accounts, id)} only` : '';
}

/**
 * Compact one-line parameter summary for an event row (date is shown
 * separately). `accounts` resolves display names for account-targeted events.
 */
export function summarizeEvent(
  e: ScenarioEvent,
  people: readonly Person[] = [],
  accounts: readonly Pick<Account, 'id' | 'name'>[] = [],
): string {
  switch (e.type) {
    case 'retire':
      return `${personName(people, e.person)} stops working`;
    case 'claim_social_security':
      return `${personName(people, e.person)} claims benefits`;
    /*
     * Says the two things a reader of the events list cannot infer: whose death
     * it is, and what the survivor is modelled to spend. The living fraction is
     * spelled out even when it is the default, because 75% of the couple's
     * baseline is a JUDGMENT (there is no primary source for it — see
     * DEFAULT_SURVIVOR_LIVING_FRACTION) and a plan that leans on it should say
     * so on the row rather than in a doc comment nobody opens.
     */
    case 'death': {
      const fraction = e.livingFraction ?? DEFAULT_SURVIVOR_LIVING_FRACTION;
      const claim = e.survivorClaim ? `, survivor benefit starts ${e.survivorClaim}` : '';
      return `${personName(people, e.person)} dies — survivor spends ${formatPct(
        fraction,
        0,
      )} of the couple’s living baseline${claim}`;
    }
    case 'expense_change': {
      const parts: string[] = [];
      if (e.multiplier !== undefined) parts.push(`×${e.multiplier}`);
      if (e.delta !== undefined)
        parts.push(`${e.delta >= 0 ? '+' : '-'}${formatUSD(Math.abs(e.delta))}/yr`);
      const s = parts.join(', ') || 'no change';
      return e.category ? `${s} (${e.category})` : s;
    }
    case 'state_change':
      return `Residency → ${e.state.toUpperCase()}`;
    case 'sell_house':
      return 'Sell primary home';
    case 'rent':
      return `${formatUSD(e.monthlyCost)}/mo × ${e.months} months`;
    case 'buy_house': {
      const price =
        e.price === 'sale_proceeds' ? 'price = sale proceeds' : `price ${formatUSD(e.price)}`;
      const fin =
        e.financing === 'cash'
          ? 'cash'
          : `${formatPct(e.financing.downPct, 0)} down @ ${formatPct(e.financing.rate, 2)}, ${
              e.financing.termYears
            }yr${
              // A scheduled lump payoff changes what the loan IS; the summary
              // line must not read as a full-term note.
              e.financing.payoffAfterYears !== undefined
                ? `, paid off yr ${e.financing.payoffAfterYears}`
                : ''
            }`;
      return `${price}, ${fin}`;
    }
    case 'allocation_change':
      return `Mix → ${formatMix(e.mix)} (stocks/bonds/bills)${accountSuffix(e.account, accounts)}`;
    case 'glidepath':
      return `${formatMix(e.fromMix)} → ${formatMix(e.toMix)} by ${e.end}${accountSuffix(
        e.account,
        accounts,
      )}`;
    case 'withdrawal_strategy':
      return `${e.policy.order.join(' → ')} (${e.policy.pretaxPreference.replace(/_/g, ' ')})`;
    case 'one_time_expense':
      return `${formatUSD(e.amount)} expense`;
    case 'one_time_income':
      return `${formatUSD(e.amount)} income${e.taxable === false ? ' (tax-free)' : ''}`;
    case 'start_72t': {
      const parts = [`SEPP from ${accountName(accounts, e.account)}`];
      parts.push(
        e.annualAmount !== undefined ? `${formatUSD(e.annualAmount)}/yr` : 'maximum payment',
      );
      if (e.interestRate !== undefined) parts.push(`@ ${formatPct(e.interestRate, 1)}`);
      return parts.join(', ');
    }
    case 'roth_conversion': {
      const how =
        e.amount !== undefined
          ? formatUSD(e.amount)
          : e.toBracketTop !== undefined
            ? `to top of ${formatPct(e.toBracketTop, 0)} bracket`
            : 'unspecified amount';
      return e.yearly ? `Yearly, ${how}` : how;
    }
  }
}

// ---------------------------------------------------------------------------
// Mix validation
// ---------------------------------------------------------------------------

export function mixSum(mix: AssetMix): number {
  return mix.stocks + mix.bonds + mix.bills;
}

export function mixError(mix: AssetMix): string | null {
  for (const key of ['stocks', 'bonds', 'bills'] as const) {
    if (mix[key] < 0 || mix[key] > 1) return `${key} must be between 0 and 1`;
  }
  const sum = mixSum(mix);
  if (Math.abs(sum - 1) >= 1e-6) {
    return `weights sum to ${Number(sum.toFixed(4))}, must sum to 1`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------
//
// There is no scenario library any more, so nothing here creates, names, or
// identifies one: the app has a single plan.json that the server seeds and the
// workbench saves on every change (see dataStore.defaultPlanScenario, which
// builds that seed from defaultPlan/writePlan below). What survives is the
// validation the editor needs before it writes.

export function validateScenario(s: Scenario): string | null {
  const res = scenarioSchema.safeParse(s);
  return res.success ? null : formatZodError(res.error);
}

/** Validate a single event via the scenario schema; strips the events.0 path prefix. */
export function validateEvent(event: ScenarioEvent): string | null {
  const res = scenarioSchema.safeParse({ name: 'x', events: [event] });
  if (res.success) return null;
  return formatZodError(res.error).replace(/(^|;\s)events\.0\.?/g, '$1');
}

// ---------------------------------------------------------------------------
// Raw JSON <-> the plan
// ---------------------------------------------------------------------------

export type ParseScenarioResult =
  | { ok: true; scenario: Scenario }
  | { ok: false; error: string };

export function parseScenarioText(text: string): ParseScenarioResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    return { ok: false, error: `Invalid JSON: ${(err as Error).message}` };
  }
  const res = scenarioSchema.safeParse(raw);
  if (!res.success) return { ok: false, error: formatZodError(res.error) };
  return { ok: true, scenario: res.data };
}

export function scenarioToText(s: Scenario): string {
  return JSON.stringify(s, null, 2);
}

// ---------------------------------------------------------------------------
// Number parsing (string fields; parse on blur/save so typing isn't fought)
// ---------------------------------------------------------------------------

/** '' or unparseable -> null; otherwise the finite number. */
export function parseNumber(s: string): number | null {
  const t = s.trim();
  if (t === '') return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

export function parseInteger(s: string): number | null {
  const n = parseNumber(s);
  return n === null ? null : Math.trunc(n);
}

export function addYears(ym: YearMonth, years: number): YearMonth {
  const [y, m] = ym.split('-');
  return `${Number(y) + years}-${m}`;
}

// ---------------------------------------------------------------------------
// Event form fields <-> ScenarioEvent
// ---------------------------------------------------------------------------

/**
 * Flat form state for the typed event editor. Scalar values are strings
 * (local input state, parsed on save); mixes and order arrays are structured.
 */
export interface EventFields {
  type: EventType;
  person: string;
  date: string;
  start: string;
  end: string;
  state: StateCode;
  expenseMode: 'multiplier' | 'delta';
  multiplier: string;
  delta: string;
  /** expense_change target stream (note 12). */
  category: 'living' | 'charitable';
  months: string;
  monthlyCost: string;
  priceMode: 'sale_proceeds' | 'amount';
  price: string;
  financingMode: 'cash' | 'mortgage';
  downPct: string;
  rate: string;
  termYears: string;
  /** buy_house mortgage: lump payoff N years after origination ('' = pay the full term). */
  payoffAfterYears: string;
  propertyTaxAnnual: string;
  insuranceAnnual: string;
  mix: AssetMix;
  fromMix: AssetMix;
  toMix: AssetMix;
  order: WithdrawalBucket[];
  pretaxPreference: WithdrawalPolicy['pretaxPreference'];
  amount: string;
  taxable: 'default' | 'yes' | 'no';
  /**
   * Account target. start_72t requires one; allocation_change / glidepath
   * treat '' as "all accounts" (note 8).
   */
  account: string;
  /** start_72t: desired SEPP annual payment ('' = the IRS formula maximum). */
  annualAmount: string;
  /** start_72t: amortization rate ('' = the engine default, 5%). */
  interestRate: string;
  schedule: 'once' | 'yearly';
  conversionMode: 'amount' | 'bracket';
  toBracketTop: string;
  /**
   * death: the survivor's share of the couple's living baseline, as a decimal
   * ('' = DEFAULT_SURVIVOR_LIVING_FRACTION). Kept as free text like every other
   * numeric field so typing "0." is not fought.
   */
  livingFraction: string;
  /**
   * death: the month the survivor's own benefit starts ('' = leave the plan's
   * claiming decision alone, which is the engine's default and the only one
   * that does not silently rewrite a choice the user made).
   */
  survivorClaim: string;
}

export function defaultEventFields(date: YearMonth = DEFAULT_EVENT_DATE): EventFields {
  return {
    type: 'retire',
    person: '',
    date,
    start: date,
    end: addYears(date, 5),
    state: 'sc',
    expenseMode: 'multiplier',
    multiplier: '0.85',
    delta: '',
    category: 'living',
    months: '12',
    monthlyCost: '2500',
    priceMode: 'sale_proceeds',
    price: '',
    financingMode: 'cash',
    downPct: '0.2',
    rate: '0.065',
    termYears: '30',
    payoffAfterYears: '',
    propertyTaxAnnual: '3000',
    insuranceAnnual: '1500',
    mix: { stocks: 0.6, bonds: 0.4, bills: 0 },
    fromMix: { stocks: 1, bonds: 0, bills: 0 },
    toMix: { stocks: 0.6, bonds: 0.4, bills: 0 },
    order: ['cash', 'taxable', 'pretax', 'roth'],
    pretaxPreference: 'ira_first',
    amount: '10000',
    taxable: 'default',
    account: '',
    annualAmount: '',
    interestRate: '',
    schedule: 'yearly',
    conversionMode: 'bracket',
    toBracketTop: '0.12',
    livingFraction: '',
    survivorClaim: '',
  };
}

/** Populate form fields from an existing event (for editing). */
export function eventFieldsFrom(e: ScenarioEvent): EventFields {
  const f = defaultEventFields(eventDate(e) ?? DEFAULT_EVENT_DATE);
  f.type = e.type;
  switch (e.type) {
    case 'retire':
    case 'claim_social_security':
      f.person = e.person;
      f.date = e.date;
      break;
    case 'death':
      f.person = e.person;
      f.date = e.date;
      // Blank means "the engine's default", and it must round-trip as blank:
      // writing 0.75 into the box would turn an inherited assumption into a
      // stated one the next time the event was saved.
      f.livingFraction = e.livingFraction !== undefined ? String(e.livingFraction) : '';
      f.survivorClaim = e.survivorClaim ?? '';
      break;
    case 'expense_change':
      f.date = e.date;
      if (e.delta !== undefined && e.multiplier === undefined) {
        f.expenseMode = 'delta';
        f.delta = String(e.delta);
      } else if (e.multiplier !== undefined) {
        f.expenseMode = 'multiplier';
        f.multiplier = String(e.multiplier);
      }
      f.category = e.category ?? 'living';
      break;
    case 'state_change':
      f.date = e.date;
      f.state = e.state;
      break;
    case 'sell_house':
      f.date = e.date;
      break;
    case 'rent':
      f.start = e.start;
      f.months = String(e.months);
      f.monthlyCost = String(e.monthlyCost);
      break;
    case 'buy_house':
      f.date = e.date;
      if (e.price === 'sale_proceeds') {
        f.priceMode = 'sale_proceeds';
      } else {
        f.priceMode = 'amount';
        f.price = String(e.price);
      }
      if (e.financing === 'cash') {
        f.financingMode = 'cash';
      } else {
        f.financingMode = 'mortgage';
        f.downPct = String(e.financing.downPct);
        f.rate = String(e.financing.rate);
        f.termYears = String(e.financing.termYears);
        // Blank means "full term" and must round-trip as blank (the death
        // event's livingFraction rule): writing a number in would turn the
        // absent default into a stated instruction on the next save.
        f.payoffAfterYears =
          e.financing.payoffAfterYears !== undefined ? String(e.financing.payoffAfterYears) : '';
      }
      f.propertyTaxAnnual = String(e.propertyTaxAnnual);
      f.insuranceAnnual = String(e.insuranceAnnual);
      break;
    case 'allocation_change':
      f.date = e.date;
      f.mix = { ...e.mix };
      f.account = e.account ?? '';
      break;
    case 'glidepath':
      f.start = e.start;
      f.end = e.end;
      f.fromMix = { ...e.fromMix };
      f.toMix = { ...e.toMix };
      f.account = e.account ?? '';
      break;
    case 'withdrawal_strategy':
      f.date = e.date;
      f.order = [...e.policy.order];
      f.pretaxPreference = e.policy.pretaxPreference;
      break;
    case 'one_time_expense':
      f.date = e.date;
      f.amount = String(e.amount);
      break;
    case 'one_time_income':
      f.date = e.date;
      f.amount = String(e.amount);
      f.taxable = e.taxable === undefined ? 'default' : e.taxable ? 'yes' : 'no';
      break;
    case 'start_72t':
      f.date = e.date;
      f.account = e.account;
      f.annualAmount = e.annualAmount !== undefined ? String(e.annualAmount) : '';
      f.interestRate = e.interestRate !== undefined ? String(e.interestRate) : '';
      break;
    case 'roth_conversion':
      f.schedule = e.yearly ? 'yearly' : 'once';
      if (e.date) f.date = e.date;
      if (e.amount !== undefined) {
        f.conversionMode = 'amount';
        f.amount = String(e.amount);
      } else if (e.toBracketTop !== undefined) {
        f.conversionMode = 'bracket';
        f.toBracketTop = String(e.toBracketTop);
      }
      break;
  }
  return f;
}

export type BuildEventResult =
  | { ok: true; event: ScenarioEvent }
  | { ok: false; error: string };

/** Build + validate a ScenarioEvent from form fields. */
export function buildEvent(f: EventFields): BuildEventResult {
  const errs: string[] = [];
  const num = (label: string, s: string): number => {
    const v = parseNumber(s);
    if (v === null) {
      errs.push(`${label} must be a number`);
      return Number.NaN;
    }
    return v;
  };
  const int = (label: string, s: string): number => {
    const v = num(label, s);
    return Number.isNaN(v) ? v : Math.trunc(v);
  };

  let event: ScenarioEvent;
  switch (f.type) {
    case 'retire':
    case 'claim_social_security':
      if (!f.person) errs.push('person is required');
      event = { type: f.type, person: f.person, date: f.date };
      break;
    case 'death': {
      if (!f.person) errs.push('person is required');
      const fraction = parseNumber(f.livingFraction);
      if (f.livingFraction.trim() !== '' && fraction === null) {
        errs.push('living fraction must be a number (or blank for the default)');
      }
      const claim = f.survivorClaim.trim();
      event = {
        type: 'death',
        person: f.person,
        date: f.date,
        ...(fraction !== null ? { livingFraction: fraction } : {}),
        ...(claim !== '' ? { survivorClaim: claim } : {}),
      };
      break;
    }
    case 'expense_change':
      event = {
        type: 'expense_change',
        date: f.date,
        ...(f.expenseMode === 'multiplier'
          ? { multiplier: num('multiplier', f.multiplier) }
          : { delta: num('delta', f.delta) }),
        // 'living' is the contract default; only write the key when it isn't.
        ...(f.category === 'charitable' ? { category: 'charitable' as const } : {}),
      };
      break;
    case 'state_change':
      event = { type: 'state_change', date: f.date, state: f.state };
      break;
    case 'sell_house':
      event = { type: 'sell_house', date: f.date };
      break;
    case 'rent':
      event = {
        type: 'rent',
        start: f.start,
        months: int('months', f.months),
        monthlyCost: num('monthly cost', f.monthlyCost),
      };
      break;
    case 'buy_house': {
      // Blank = full term, like start_72t's blank-means-maximum fields. A
      // stated value is validated against the stated term HERE so the owner
      // reads "payoff must be inside the term", not a raw schema error later.
      const payoff = parseNumber(f.payoffAfterYears);
      // Validated only under a mortgage: switching to cash must not let stale
      // text in a field the form no longer shows block the save.
      if (f.financingMode === 'mortgage' && f.payoffAfterYears.trim() !== '') {
        if (payoff === null) {
          errs.push('pay off after must be a number of years (or blank for the full term)');
        } else {
          const term = parseNumber(f.termYears);
          if (term !== null && Math.trunc(payoff) >= Math.trunc(term)) {
            errs.push('pay off after must be strictly inside the term (or blank for the full term)');
          }
        }
      }
      event = {
        type: 'buy_house',
        date: f.date,
        price: f.priceMode === 'sale_proceeds' ? 'sale_proceeds' : num('price', f.price),
        financing:
          f.financingMode === 'cash'
            ? 'cash'
            : {
                downPct: num('down payment', f.downPct),
                rate: num('rate', f.rate),
                termYears: int('term years', f.termYears),
                ...(f.payoffAfterYears.trim() !== '' && payoff !== null
                  ? { payoffAfterYears: Math.trunc(payoff) }
                  : {}),
              },
        propertyTaxAnnual: num('property tax', f.propertyTaxAnnual),
        insuranceAnnual: num('insurance', f.insuranceAnnual),
      };
      break;
    }
    case 'allocation_change':
      event = {
        type: 'allocation_change',
        date: f.date,
        mix: { ...f.mix },
        ...(f.account ? { account: f.account } : {}),
      };
      break;
    case 'glidepath':
      event = {
        type: 'glidepath',
        start: f.start,
        end: f.end,
        fromMix: { ...f.fromMix },
        toMix: { ...f.toMix },
        ...(f.account ? { account: f.account } : {}),
      };
      break;
    case 'withdrawal_strategy':
      event = {
        type: 'withdrawal_strategy',
        date: f.date,
        policy: { order: [...f.order], pretaxPreference: f.pretaxPreference },
      };
      break;
    case 'one_time_expense':
      event = { type: 'one_time_expense', date: f.date, amount: num('amount', f.amount) };
      break;
    case 'one_time_income':
      event = {
        type: 'one_time_income',
        date: f.date,
        amount: num('amount', f.amount),
        ...(f.taxable === 'default' ? {} : { taxable: f.taxable === 'yes' }),
      };
      break;
    case 'start_72t': {
      if (!f.account) errs.push('account is required');
      const annual = parseNumber(f.annualAmount);
      const rate = parseNumber(f.interestRate);
      if (f.annualAmount.trim() !== '' && annual === null) {
        errs.push('annual amount must be a number (or blank for the maximum)');
      }
      if (f.interestRate.trim() !== '' && rate === null) {
        errs.push('interest rate must be a number (or blank for the default)');
      }
      event = {
        type: 'start_72t',
        date: f.date,
        account: f.account,
        ...(annual !== null ? { annualAmount: annual } : {}),
        ...(rate !== null ? { interestRate: rate } : {}),
      };
      break;
    }
    case 'roth_conversion':
      event = {
        type: 'roth_conversion',
        ...(f.schedule === 'yearly' ? { yearly: true } : { date: f.date }),
        ...(f.conversionMode === 'amount'
          ? { amount: num('amount', f.amount) }
          : { toBracketTop: num('bracket rate', f.toBracketTop) }),
      };
      break;
  }

  if (errs.length) return { ok: false, error: errs.join('; ') };
  const schemaError = validateEvent(event);
  if (schemaError) return { ok: false, error: schemaError };
  return { ok: true, event };
}

// ---------------------------------------------------------------------------
// Assumption overrides <-> form fields
// ---------------------------------------------------------------------------

export interface MarketDefaults {
  stocks: number;
  bonds: number;
  bills: number;
  inflation: number;
  /**
   * Home appreciation ABOVE inflation (market.json's
   * homeAppreciationRealSpread). Not an override field — the overrides card
   * does not edit it — but the Housing tab needs it to state the rate the
   * engine would use for the house when the housing plan names none, and to
   * seed that rate. Optional so a caller that only feeds the overrides card
   * (which never reads it) stays valid.
   */
  homeSpread?: number;
}

export interface OverrideFields {
  market: {
    stocks: string;
    bonds: string;
    bills: string;
    inflation: string;
    /**
     * Nominal yield on savings cash. Independent of the deterministic-real
     * trio above: it applies in Monte Carlo runs too, because "what my cash
     * earns" is a standing choice about where the money sits rather than a
     * deterministic-mode convenience.
     */
    cashYield: string;
    /**
     * Corporate share of the bond sleeve, in PERCENT (the field is labelled
     * "(%)" and BND is described as "~30", so the box takes 30, not 0.3).
     * Stored as bondComposition.corporateFraction = value/100. Like cashYield
     * it is mode-independent: the blend applies to every sampled historical
     * year, not just deterministic runs.
     */
    corporateShare: string;
  };
  acaEnhanced: boolean;
  horizonAge: string;
  successTarget: string;
  spendingPolicyType: '' | 'fixed_real' | 'fixed_percent' | 'guardrails';
  spendingPercent: string;
  /**
   * The guardrails band the stored override ALREADY carries, held verbatim —
   * the card never edits it (the rails, floor and raiseCeiling stay a
   * profile-level decision) but it must survive a commit: before this
   * passthrough, touching any field on the card rebuilt the override as a
   * bare `{ type: 'guardrails' }` and silently stripped a band that arrived
   * via raw JSON — the same next-edit-drops-it trap the 'guardrails' select
   * option itself exists to close.
   */
  spendingGuardrails: SpendingPolicy['guardrails'];
  /**
   * The rest of what the stored override carries and this card never edits,
   * held verbatim and re-emitted by buildOverrides — the guardrails band's
   * trap, generalized. buildOverrides rebuilds the WHOLE assumption_overrides
   * object from these fields, so every override key without a box on the card
   * needs a passthrough or the next commit of ANY field silently strips it.
   * The expenses block is the motivating case: a plan carrying
   * lifeInsurancePolicyPlans / untithedPot lost both to a stray edit of, say,
   * the horizon box.
   */
  expenses: AssumptionOverrides['expenses'];
  /** Retirement-income overrides, same passthrough contract as `expenses`. */
  income: AssumptionOverrides['income'];
  /** settings.terminalFloorReal — the one settings key with no box. */
  terminalFloorReal: number | undefined;
  /**
   * Market keys with no box (expenseRatios, stockDividendYield,
   * bootstrapBlockYears, the three real spreads). Never contains the four
   * edited keys — overrideFieldsFrom splits those out into `market` above.
   */
  marketPassthrough: Omit<NonNullable<AssumptionOverrides['market']>, EditedMarketKey>;
}

/** The market-override keys the card's boxes actually edit (everything else passes through). */
type EditedMarketKey =
  | 'deterministicReal'
  | 'deterministicInflation'
  | 'cashYieldNominal'
  | 'bondComposition';

export function overrideFieldsFrom(o?: AssumptionOverrides): OverrideFields {
  const det = o?.market?.deterministicReal;
  // Split the market block into the four edited keys (fields below) and the
  // verbatim remainder. Destructuring-with-rest so a market key added later
  // lands in the passthrough by default instead of in the drop.
  const {
    deterministicReal: _det,
    deterministicInflation: _inf,
    cashYieldNominal: _cash,
    bondComposition: _bond,
    ...marketPassthrough
  } = o?.market ?? {};
  return {
    market: {
      stocks: det ? String(det.stocks) : '',
      bonds: det ? String(det.bonds) : '',
      bills: det ? String(det.bills) : '',
      inflation:
        o?.market?.deterministicInflation !== undefined
          ? String(o.market.deterministicInflation)
          : '',
      cashYield:
        o?.market?.cashYieldNominal !== undefined ? String(o.market.cashYieldNominal) : '',
      corporateShare:
        o?.market?.bondComposition?.corporateFraction !== undefined
          ? corporateShareText(o.market.bondComposition.corporateFraction)
          : '',
    },
    acaEnhanced: o?.aca?.enhancedCreditsExtended === true,
    horizonAge: o?.settings?.horizonAge !== undefined ? String(o.settings.horizonAge) : '',
    successTarget:
      o?.settings?.successTarget !== undefined ? String(o.settings.successTarget) : '',
    spendingPolicyType: o?.settings?.spendingPolicy?.type ?? '',
    spendingPercent:
      o?.settings?.spendingPolicy?.percent !== undefined
        ? String(o.settings.spendingPolicy.percent)
        : '',
    spendingGuardrails: o?.settings?.spendingPolicy?.guardrails,
    expenses: o?.expenses,
    income: o?.income,
    terminalFloorReal: o?.settings?.terminalFloorReal,
    marketPassthrough,
  };
}

/**
 * Field keys of OverrideFields that carry free-text numbers and therefore
 * need bound checks at commit time.
 */
export type OverrideFieldKey =
  | 'stocks'
  | 'bonds'
  | 'bills'
  | 'inflation'
  | 'cashYield'
  | 'corporateShare'
  | 'horizonAge'
  | 'successTarget'
  | 'spendingPercent';

/**
 * Per-field bound checks for the overrides card, mirroring the scenario
 * schema exactly (schemas.ts: realReturn ±0.2, inflation -0.05..0.15,
 * horizonAge int 70-110, successTarget 0-1, spending percent 0-0.25).
 * Blank fields are fine (they mean "keep the default"); non-numeric or
 * out-of-range input gets an inline error and is NOT written into the draft
 * (see buildOverrides).
 */
export function overrideFieldErrors(
  f: OverrideFields,
): Partial<Record<OverrideFieldKey, string>> {
  const errs: Partial<Record<OverrideFieldKey, string>> = {};
  const check = (
    key: OverrideFieldKey,
    raw: string,
    lo: number,
    hi: number,
    opts?: { int?: boolean; hint?: string },
  ): void => {
    if (raw.trim() === '') return;
    const n = parseNumber(raw);
    if (n === null) {
      errs[key] = 'must be a number';
      return;
    }
    if (opts?.int && !Number.isInteger(n)) {
      errs[key] = 'must be a whole number';
      return;
    }
    if (n < lo || n > hi) {
      errs[key] = `must be between ${lo} and ${hi}${opts?.hint ? ` ${opts.hint}` : ''}`;
    }
  };
  check('stocks', f.market.stocks, -0.2, 0.2);
  check('bonds', f.market.bonds, -0.2, 0.2);
  check('bills', f.market.bills, -0.2, 0.2);
  check('inflation', f.market.inflation, -0.05, 0.15);
  // Matches the schema's 0..0.25 bound. A "yield" below zero is not a yield,
  // and anything above 25% is not a savings account.
  check('cashYield', f.market.cashYield, 0, 0.25, { hint: '(0.0425 = 4.25%)' });
  // Delegated to the standalone checker the Plan card's Custom box shares, so
  // the two doors to this dial can never disagree about what is legal.
  const corp = corporateShareErrorText(f.market.corporateShare);
  if (corp !== undefined) errs.corporateShare = corp;
  check('horizonAge', f.horizonAge, 70, 110, { int: true });
  check('successTarget', f.successTarget, 0, 1, { hint: '(0.85 = 85%)' });
  if (f.spendingPolicyType === 'fixed_percent') {
    check('spendingPercent', f.spendingPercent, 0, 0.25);
  }
  return errs;
}

/**
 * Market override: only written when a field is set. deterministicReal is a
 * complete object in the contract, so unset members are backfilled from the
 * loaded market.json defaults.
 */
export function buildMarketOverride(
  fields: { stocks: string; bonds: string; bills: string; inflation: string },
  defaults: MarketDefaults,
): Partial<MarketAssumptions> | undefined {
  const stocks = parseNumber(fields.stocks);
  const bonds = parseNumber(fields.bonds);
  const bills = parseNumber(fields.bills);
  const inflation = parseNumber(fields.inflation);
  const out: Partial<MarketAssumptions> = {};
  if (stocks !== null || bonds !== null || bills !== null) {
    out.deterministicReal = {
      stocks: stocks ?? defaults.stocks,
      bonds: bonds ?? defaults.bonds,
      bills: bills ?? defaults.bills,
    };
  }
  if (inflation !== null) out.deterministicInflation = inflation;
  return out.deterministicReal !== undefined || out.deterministicInflation !== undefined
    ? out
    : undefined;
}

/**
 * Build the whole assumption_overrides object; undefined when nothing is
 * overridden. Fields failing overrideFieldErrors are skipped — a value the
 * strict scenario schema would reject (e.g. successTarget 85 instead of 0.85,
 * or NaN from unparseable input) must never be written into the draft.
 */
export function buildOverrides(
  f: OverrideFields,
  marketDefaults: MarketDefaults,
): AssumptionOverrides | undefined {
  const errs = overrideFieldErrors(f);
  const out: AssumptionOverrides = {};
  const market = buildMarketOverride(
    {
      stocks: errs.stocks ? '' : f.market.stocks,
      bonds: errs.bonds ? '' : f.market.bonds,
      bills: errs.bills ? '' : f.market.bills,
      inflation: errs.inflation ? '' : f.market.inflation,
    },
    marketDefaults,
  );
  if (market) out.market = market;
  /*
   * Added AFTER the deterministic trio and outside buildMarketOverride, which
   * only emits anything when that whole set is present. The cash yield has to
   * survive on its own: a household that wants 4.25% on its savings is not
   * thereby asking to pin stock and bond returns as well.
   */
  const cashYield = errs.cashYield ? null : parseNumber(f.market.cashYield);
  if (cashYield !== null) out.market = { ...(out.market ?? {}), cashYieldNominal: cashYield };
  /*
   * Same standalone treatment as the cash yield, and for the same reason: a
   * bond-composition choice must not drag the deterministic trio in with it.
   * Percent -> fraction here (the schema and engine speak 0..1); an explicit
   * "0" is written as corporateFraction 0 — semantically the engine default,
   * but the user said it, and stripping a stated value is how a later
   * default change silently rewrites saved plans.
   */
  const corporateShare = errs.corporateShare ? null : parseNumber(f.market.corporateShare);
  if (corporateShare !== null) {
    out.market = {
      ...(out.market ?? {}),
      bondComposition: { corporateFraction: corporateShare / 100 },
    };
  }
  /*
   * Market keys the card has no boxes for, re-emitted verbatim (see
   * OverrideFields.marketPassthrough). Merged on its own so it survives the
   * edited keys being cleared: blanking the deterministic trio must not take
   * homeAppreciationRealSpread down with it. The key sets are disjoint by
   * construction, so spread order is immaterial.
   */
  if (Object.keys(f.marketPassthrough).length > 0) {
    out.market = { ...(out.market ?? {}), ...f.marketPassthrough };
  }
  if (f.acaEnhanced) out.aca = { enhancedCreditsExtended: true };
  const settings: NonNullable<AssumptionOverrides['settings']> = {};
  const horizon = errs.horizonAge ? null : parseInteger(f.horizonAge);
  if (horizon !== null) settings.horizonAge = horizon;
  const target = errs.successTarget ? null : parseNumber(f.successTarget);
  if (target !== null) settings.successTarget = target;
  // Passthrough: no box edits the terminal floor, so it is carried verbatim.
  if (f.terminalFloorReal !== undefined) settings.terminalFloorReal = f.terminalFloorReal;
  if (f.spendingPolicyType === 'fixed_real') {
    settings.spendingPolicy = { type: 'fixed_real' };
  } else if (f.spendingPolicyType === 'fixed_percent') {
    settings.spendingPolicy = {
      type: 'fixed_percent',
      percent: (errs.spendingPercent ? null : parseNumber(f.spendingPercent)) ?? 0.04,
    };
  } else if (f.spendingPolicyType === 'guardrails') {
    // The rails themselves are a profile-level decision, not a per-scenario
    // override: this form never AUTHORS a band. But a band the stored
    // override already carries (raw JSON — the raiseCeiling knob is the
    // motivating case) is re-emitted verbatim, or the next commit of any
    // field on this card would silently strip it.
    settings.spendingPolicy = {
      type: 'guardrails',
      ...(f.spendingGuardrails !== undefined ? { guardrails: f.spendingGuardrails } : {}),
    };
  }
  if (Object.keys(settings).length > 0) out.settings = settings;
  /*
   * Whole-block passthroughs: the card edits neither, but the plan can carry
   * both (lifeInsurancePolicyPlans / untithedPot live in expenses), and
   * rebuilding the override without them turned any edit on this card into
   * silent data loss.
   */
  if (f.expenses !== undefined) out.expenses = f.expenses;
  if (f.income !== undefined) out.income = f.income;
  return Object.keys(out).length > 0 ? out : undefined;
}

// ---------------------------------------------------------------------------
// Bond composition: one dial, two doors
// ---------------------------------------------------------------------------
//
// A user thinks in the instruments he would buy ("BND or VGIT"); the model
// thinks in what those instruments are made of
// (market.bondComposition.corporateFraction). These helpers bridge the two so
// the Plan card can offer a "Bonds are" preset select beside the allocation
// mix — where the bond decision is actually made — while the Settings tab's
// "Corporate share of bonds (%)" field keeps stating the number directly.
// Both controls read and write THE SAME override; neither caches it, so they
// cannot drift.

/** The Plan card's vocabulary for the stored fraction. */
export type BondPreset = 'treasuries' | 'total_bond' | 'custom';

/**
 * The corporate share a total-bond-market fund (BND) approximates. ~30% of
 * BND's holdings are corporates; the mapping is approximate on purpose — the
 * model names compositions, not products.
 */
export const TOTAL_BOND_CORPORATE_FRACTION = 0.3;

/** The stored corporate fraction, or undefined when the plan never set one. */
export function corporateFractionOf(o: AssumptionOverrides | undefined): number | undefined {
  return o?.market?.bondComposition?.corporateFraction;
}

/**
 * Fraction -> percent text for display. toPrecision(12) strips the float dust
 * the x100 conversion manufactures (0.07 * 100 === 7.000000000000001 — the
 * mutation run in tests/ui/bondPreset.test.ts found 0.3 itself multiplies
 * clean, so the dusty cases are the ones pinned there; a field that shows
 * such a string teaches the user not to trust the app). Nobody states a
 * corporate share to 12 significant digits.
 */
export function corporateShareText(fraction: number): string {
  return String(parseFloat((fraction * 100).toPrecision(12)));
}

/**
 * Bound check for the corporate-share percent field — ONE checker for both
 * doors (the OverridesCard field via overrideFieldErrors, and the Plan card's
 * Custom box directly). Blank is fine: it means "keep the default". The hint
 * anchors the unit so 0.3 typed here reads as 0.3% — a near-Treasury sleeve —
 * and not as the 30% its author probably meant.
 */
export function corporateShareErrorText(raw: string): string | undefined {
  if (raw.trim() === '') return undefined;
  const n = parseNumber(raw);
  if (n === null) return 'must be a number';
  if (n < 0 || n > 100) return 'must be between 0 and 100 (30 ≈ a total-bond fund)';
  return undefined;
}

/**
 * Which preset a stored fraction reads as. Absent and explicit 0 BOTH read as
 * Treasuries — they price identically (the engine's bond sleeve is
 * all-Treasury by default), and a select showing "Custom" for a stored 0
 * would invent a distinction the run cannot see. Only the exact 0.3 reads as
 * the total-bond preset; everything else is Custom, shown with its value.
 */
export function bondPresetFor(fraction: number | undefined): BondPreset {
  if (fraction === undefined || fraction === 0) return 'treasuries';
  if (fraction === TOTAL_BOND_CORPORATE_FRACTION) return 'total_bond';
  return 'custom';
}

/** The fraction a concrete preset pick writes ('custom' writes nothing — its field does). */
export function bondPresetFraction(preset: 'treasuries' | 'total_bond'): number | undefined {
  return preset === 'total_bond' ? TOTAL_BOND_CORPORATE_FRACTION : undefined;
}

/**
 * Set (or clear, with undefined) bondComposition.corporateFraction, leaving
 * every OTHER override exactly as it was and pruning upward (workbenchLogic's
 * withExpenses rule): an empty market block takes the `market` key with it,
 * and an otherwise-empty overrides object collapses to undefined, because the
 * plan file is read by a human. Never mutates.
 *
 * Deliberately NOT buildOverrides: this is a surgical patch from a card that
 * edits one dial, so overrides it does not understand (expenses, guardrail
 * bands…) survive untouched.
 *
 * Clearing is what the Treasuries preset writes — not an explicit 0. The
 * OverridesCard's explicit-0 convention covers the OTHER direction: a 0 the
 * owner TYPED is a stated value and stays. Choosing the preset named for the
 * default is not stating a number, and absence is what guarantees a plan
 * that never set the dial stays byte-identical through a Treasuries pick,
 * and a plan flipped away and back carries no residue.
 */
export function setCorporateFraction(
  o: AssumptionOverrides | undefined,
  fraction: number | undefined,
): AssumptionOverrides | undefined {
  const market: NonNullable<AssumptionOverrides['market']> = { ...o?.market };
  if (fraction === undefined) delete market.bondComposition;
  else market.bondComposition = { corporateFraction: fraction };
  const next: AssumptionOverrides = { ...o };
  if (Object.keys(market).length === 0) delete next.market;
  else next.market = market;
  return Object.keys(next).length === 0 ? undefined : next;
}

// ---------------------------------------------------------------------------
// Solver spec <-> form fields
// ---------------------------------------------------------------------------

export const SOLVER_TYPES: Array<{ type: SolverSpec['type']; label: string }> = [
  { type: 'widow_score', label: 'Widow score by year of death' },
  { type: 'retire_year_sweep', label: 'Retirement-year sweep' },
  { type: 'ss_claim_sweep', label: 'SS claiming sweep' },
  { type: 'swr_curve', label: 'SWR curve' },
  { type: 'max_spend', label: 'Max sustainable spend' },
  { type: 'earliest_retirement', label: 'Earliest retirement' },
];

export function solverTypeLabel(type: SolverSpec['type']): string {
  return SOLVER_TYPES.find((t) => t.type === type)?.label ?? type;
}

export function defaultSolverForType(type: SolverSpec['type']): SolverSpec {
  switch (type) {
    /*
     * Two-year steps over two decades — eleven full simulations rather than
     * twenty-one. A widow curve is smooth (nothing about it is a cliff except
     * the year term coverage lapses, which the user knows the date of), so the
     * shape is already legible at every other year and costs half the runs.
     * The Widow tab builds its own range from the household's ages; this is the
     * vocabulary's default, not that view's.
     */
    case 'widow_score':
      return { type, from: 2027, to: 2047, step: 2 };
    case 'retire_year_sweep':
      return { type, from: 2026, to: 2033, alsoMaxSpend: true };
    case 'ss_claim_sweep':
      return { type, stepMonths: 1 };
    case 'swr_curve':
      return { type, spendFrom: 50000, spendTo: 120000, step: 5000 };
    case 'max_spend':
      return { type, targetSuccess: 0.85 };
    case 'earliest_retirement':
      return { type, targetSuccess: 0.85, from: 2026, to: 2035 };
  }
}

export interface SolverFields {
  type: '' | SolverSpec['type'];
  from: string;
  to: string;
  alsoMaxSpend: boolean;
  stepMonths: string;
  spendFrom: string;
  spendTo: string;
  /**
   * Shared by swr_curve (dollars of annual spending) and widow_score (years
   * between death-year probes). Only one solver type is active at a time, and
   * each reads it in its own units.
   */
  step: string;
  targetSuccess: string;
  /** widow_score: whose death ('' = the first person drawing a salary). */
  person: string;
  /** widow_score: living fraction handed to every death event it writes. */
  livingFraction: string;
}

export function solverFieldsFrom(s?: SolverSpec): SolverFields {
  const f: SolverFields = {
    type: s?.type ?? '',
    from: '',
    to: '',
    alsoMaxSpend: false,
    stepMonths: '',
    spendFrom: '',
    spendTo: '',
    step: '',
    targetSuccess: '',
    person: '',
    livingFraction: '',
  };
  if (!s) return f;
  switch (s.type) {
    case 'widow_score':
      f.person = s.person ?? '';
      f.from = s.from !== undefined ? String(s.from) : '';
      f.to = s.to !== undefined ? String(s.to) : '';
      f.step = s.step !== undefined ? String(s.step) : '';
      f.livingFraction = s.livingFraction !== undefined ? String(s.livingFraction) : '';
      break;
    case 'retire_year_sweep':
      f.from = String(s.from);
      f.to = String(s.to);
      f.alsoMaxSpend = s.alsoMaxSpend === true;
      break;
    case 'ss_claim_sweep':
      f.stepMonths = s.stepMonths !== undefined ? String(s.stepMonths) : '';
      break;
    case 'swr_curve':
      f.spendFrom = String(s.spendFrom);
      f.spendTo = String(s.spendTo);
      f.step = String(s.step);
      break;
    case 'max_spend':
      f.targetSuccess = s.targetSuccess !== undefined ? String(s.targetSuccess) : '';
      break;
    case 'earliest_retirement':
      f.targetSuccess = s.targetSuccess !== undefined ? String(s.targetSuccess) : '';
      f.from = s.from !== undefined ? String(s.from) : '';
      f.to = s.to !== undefined ? String(s.to) : '';
      break;
  }
  return f;
}

export function buildSolver(f: SolverFields): SolverSpec | undefined {
  switch (f.type) {
    case '':
      return undefined;
    /*
     * Every field is optional in the contract and every blank one is LEFT OUT
     * rather than defaulted here — the engine's own defaults (the earner, the
     * simulation's start year, from+20, step 1, DEFAULT_SURVIVOR_LIVING_FRACTION)
     * are the ones that should apply, and writing this layer's guess of them
     * into the spec would pin them silently.
     */
    case 'widow_score': {
      const from = parseInteger(f.from);
      const to = parseInteger(f.to);
      const step = parseInteger(f.step);
      const fraction = parseNumber(f.livingFraction);
      return {
        type: 'widow_score',
        ...(f.person ? { person: f.person } : {}),
        ...(from !== null ? { from } : {}),
        ...(to !== null ? { to } : {}),
        ...(step !== null ? { step } : {}),
        ...(fraction !== null ? { livingFraction: fraction } : {}),
      };
    }
    case 'retire_year_sweep':
      return {
        type: 'retire_year_sweep',
        from: parseInteger(f.from) ?? 2026,
        to: parseInteger(f.to) ?? 2033,
        ...(f.alsoMaxSpend ? { alsoMaxSpend: true } : {}),
      };
    case 'ss_claim_sweep': {
      const step = parseInteger(f.stepMonths);
      return { type: 'ss_claim_sweep', ...(step !== null ? { stepMonths: step } : {}) };
    }
    case 'swr_curve':
      return {
        type: 'swr_curve',
        spendFrom: parseNumber(f.spendFrom) ?? 50000,
        spendTo: parseNumber(f.spendTo) ?? 120000,
        step: parseNumber(f.step) ?? 5000,
      };
    case 'max_spend': {
      const t = parseNumber(f.targetSuccess);
      return { type: 'max_spend', ...(t !== null ? { targetSuccess: t } : {}) };
    }
    case 'earliest_retirement': {
      const t = parseNumber(f.targetSuccess);
      const from = parseInteger(f.from);
      const to = parseInteger(f.to);
      return {
        type: 'earliest_retirement',
        ...(t !== null ? { targetSuccess: t } : {}),
        ...(from !== null ? { from } : {}),
        ...(to !== null ? { to } : {}),
      };
    }
  }
}

export function describeSolver(spec?: SolverSpec): string {
  if (!spec) return 'None';
  switch (spec.type) {
    case 'widow_score': {
      const range =
        spec.from !== undefined && spec.to !== undefined ? ` ${spec.from}–${spec.to}` : '';
      const step = spec.step !== undefined && spec.step !== 1 ? ` every ${spec.step} yr` : '';
      return `Widow score${range}${step}`;
    }
    case 'retire_year_sweep':
      return `Retire-year sweep ${spec.from}–${spec.to}${spec.alsoMaxSpend ? ' + max spend' : ''}`;
    case 'ss_claim_sweep':
      return `SS claim sweep, every ${spec.stepMonths ?? 1} mo`;
    case 'swr_curve':
      return `SWR curve ${formatUSD(spec.spendFrom)}–${formatUSD(spec.spendTo)} step ${formatUSD(
        spec.step,
      )}`;
    case 'max_spend':
      return `Max spend${
        spec.targetSuccess !== undefined ? ` @ ${formatPct(spec.targetSuccess, 0)}` : ''
      }`;
    case 'earliest_retirement':
      return `Earliest retirement${
        spec.targetSuccess !== undefined ? ` @ ${formatPct(spec.targetSuccess, 0)}` : ''
      }${spec.from !== undefined && spec.to !== undefined ? ` (${spec.from}–${spec.to})` : ''}`;
  }
}

// ---------------------------------------------------------------------------
// Age <-> date helpers (note 17)
// ---------------------------------------------------------------------------
//
// Events are stored as "YYYY-MM" dates, but retiring and claiming Social
// Security are decisions people make in AGES ("claim at 67"), and claiming is
// only legal between 62 and 70. These convert between the two so the forms can
// offer an age picker while the scenario file keeps its date.

/** Social Security may be claimed from age 62 through age 70. */
export const SS_CLAIM_AGES: readonly number[] = [62, 63, 64, 65, 66, 67, 68, 69, 70];

/**
 * The month a person reaches `ageYears` + `extraMonths`, as "YYYY-MM".
 * Someone born 1975-03 reaches 62y0m in 2037-03 and 62y7m in 2037-10.
 */
export function dateAtAge(person: Person, ageYears: number, extraMonths = 0): YearMonth {
  const totalMonths = person.birthMonth - 1 + ageYears * 12 + extraMonths;
  const year = person.birthYear + Math.floor(totalMonths / 12);
  const month = (totalMonths % 12) + 1;
  return `${year}-${String(month).padStart(2, '0')}`;
}

/** Age (whole years + leftover months) a person is at a "YYYY-MM" date. */
export function ageAtDate(
  person: Person,
  date: YearMonth,
): { years: number; months: number } | null {
  const m = /^(\d{4})-(\d{2})$/.exec(date);
  if (!m) return null;
  const elapsed = (Number(m[1]) - person.birthYear) * 12 + (Number(m[2]) - person.birthMonth);
  if (elapsed < 0) return null;
  return { years: Math.floor(elapsed / 12), months: elapsed % 12 };
}

/** "age 67" / "age 62 + 7 months", for labelling a stored date. */
export function formatAge(age: { years: number; months: number } | null): string {
  if (!age) return '';
  return age.months === 0 ? `age ${age.years}` : `age ${age.years} + ${age.months} mo`;
}

/**
 * What a solver overrides in the scenario it runs against (note 18).
 *
 * Solvers answer "what is the best X?" by re-running the scenario many times
 * with X changed, so the scenario's own value for X is deliberately discarded.
 * That is invisible otherwise, and reads as the app contradicting the scenario
 * ("my scenario retires in 2026 but the sweep says 2031"), so every solver
 * states its override in the editor and on the results page.
 */
export function solverOverrideNote(type: SolverSpec['type']): string {
  switch (type) {
    case 'widow_score':
      return (
        'This sweep IGNORES any death already in this plan, replacing it with one in each year ' +
        'it tries. Everything else — the retirement dates, the housing plan, the life ' +
        'insurance — is the plan exactly as written, which is the point: the number moves when ' +
        'you change those, and that is what makes it steerable.'
      );
    case 'retire_year_sweep':
      return (
        'This sweep IGNORES the retirement date in this plan. It removes the retire ' +
        'events and runs one full simulation per year in the range, so each row is a ' +
        '“what if we retired that year instead” — not the plan as written.'
      );
    case 'earliest_retirement':
      return (
        'This solver IGNORES the retirement date in this plan, trying each year in ' +
        'turn and reporting the earliest one that meets the success target.'
      );
    case 'ss_claim_sweep':
      return (
        'This sweep IGNORES the Social Security claim dates in this plan, replacing ' +
        'both people’s claim dates with each age it tries (62 through 70).'
      );
    case 'swr_curve':
      return (
        'This sweep IGNORES the living-expenses figure in your profile, substituting each ' +
        'spending level in the range so you can see success against spending.'
      );
    case 'max_spend':
      return (
        'This solver IGNORES the living-expenses figure in your profile, searching for the ' +
        'highest spending that still meets the success target.'
      );
  }
}

// ---------------------------------------------------------------------------
// The plan: the three decisions every scenario is built on
// ---------------------------------------------------------------------------
//
// Every scenario answers one question — "will this work?" — and three
// decisions dominate the answer: when each person stops working, when the
// household claims Social Security, and whether the allocation changes.
//
// STORAGE IS UNCHANGED. Those decisions are still ordinary retire /
// claim_social_security / allocation_change / glidepath events in
// scenario.events; this layer only reads and rewrites them so the editor can
// present them as a single always-present Plan card instead of making the user
// hand-add four events. Everything here is pure and unit tested.

/** The event types the plan owns. Anything else is an "additional event". */
export function planEventTypes(): EventType[] {
  return ['retire', 'claim_social_security', 'allocation_change', 'glidepath'];
}

/**
 * Types that ONLY ever belong to the plan, so the "add event" picker hides
 * them. Allocation events are not in this list: an allocation event aimed at a
 * single account (note 8 — e.g. a target-date fund's own glide) is a detail,
 * not the household allocation decision, so it stays addable and stays in the
 * additional-events list. See isPlanOwnedEvent.
 */
/*
 * Event types the Additional-events list will not offer, because a dedicated
 * card owns them: Plan owns retire and claim, and HOUSING owns the whole move.
 *
 * The housing three are here at the user's instruction. Housing stopped being
 * an ad-hoc event when it became first-class configuration, and he does not
 * contemplate more than one future move — so offering "Sell house" beside
 * "State change" invited a second, contradictory way to say the same thing,
 * which the compiled plan then silently discarded. Withdrawing them from the
 * menu is the honest version of a supersede rule: do not offer what you will
 * throw away.
 *
 * The engine still UNDERSTANDS all three — old plan.json files with
 * hand-written moves keep running, and the plan compiles down to exactly these
 * events. They simply cannot be hand-added any more.
 */
export const PLAN_ONLY_EVENT_TYPES: readonly EventType[] = [
  'retire',
  'claim_social_security',
  'sell_house',
  'rent',
  'buy_house',
];

/**
 * Is this event one the Plan card owns (and therefore one writePlan replaces
 * and the additional-events list hides)? Retire and claim events always are.
 * Allocation events are only plan-owned when they apply to the WHOLE portfolio
 * — an account-targeted one is left alone.
 */
export function isPlanOwnedEvent(e: ScenarioEvent): boolean {
  switch (e.type) {
    case 'retire':
    case 'claim_social_security':
      return true;
    case 'allocation_change':
    case 'glidepath':
      return e.account === undefined;
    default:
      return false;
  }
}

/** Default age each person stops working in a brand-new scenario. */
export const DEFAULT_RETIRE_AGE = 62;
/** Default claiming age: full retirement age for anyone born 1960 or later. */
export const DEFAULT_CLAIM_AGE = 67;
/**
 * Where a newly written glidepath starts. The engine interpolates fromMix →
 * toMix, so a glide needs a starting mix; the plan only carries the target, so
 * an existing glidepath's fromMix is preserved (planGlideFromMix) and a brand
 * new one starts from all-stocks, matching the starter portfolio.
 */
export const DEFAULT_GLIDE_FROM_MIX: AssetMix = { stocks: 1, bonds: 0, bills: 0 };

/** "Do we change the allocation, when, to what, and how gradually?" */
export interface PlanAllocationDecision {
  /** When the change starts. */
  date: YearMonth;
  /** The target mix. */
  mix: AssetMix;
  /** 0 = switch at once (allocation_change); N > 0 = glide over N years. */
  glideYears: number;
}

export interface PlanDecisions {
  /** personId -> the month that person stops working; null = keeps working. */
  retireByPerson: Record<string, YearMonth | null>;
  /**
   * The household's Social Security start month; null = not claimed in this
   * scenario. One date, not one per person: person 2's benefit is spousal and
   * cannot start before person 1 files, so the household decision is single.
   */
  claimDate: YearMonth | null;
  /** null = keep the current allocation. */
  allocation: PlanAllocationDecision | null;
}

/** Whole months from `a` to `b` (negative when b precedes a); 0 if unparseable. */
export function monthsBetween(a: YearMonth, b: YearMonth): number {
  const ma = /^(\d{4})-(\d{2})$/.exec(a);
  const mb = /^(\d{4})-(\d{2})$/.exec(b);
  if (!ma || !mb) return 0;
  return (Number(mb[1]) - Number(ma[1])) * 12 + (Number(mb[2]) - Number(ma[2]));
}

/**
 * The mix a rewritten glidepath starts from: the fromMix of the whole-portfolio
 * glidepath already in the scenario, else all-stocks. Exposed so the Plan card
 * can state the starting mix instead of hiding it.
 */
export function planGlideFromMix(events: readonly ScenarioEvent[]): AssetMix {
  const existing = events.find(
    (e): e is Extract<ScenarioEvent, { type: 'glidepath' }> =>
      e.type === 'glidepath' && e.account === undefined,
  );
  return existing ? { ...existing.fromMix } : { ...DEFAULT_GLIDE_FROM_MIX };
}

/**
 * Read the three plan decisions out of a scenario's events.
 *
 * - retire: the first retire event per person; people with none "keep working".
 * - claim: person 1's claim date wins when the two disagree (the household
 *   decision is single); falls back to whichever claim event exists.
 * - allocation: the first whole-portfolio allocation event. allocation_change
 *   reads as glideYears 0; glidepath reads as its end-minus-start in whole
 *   years (at least 1, so a glide never round-trips into an instant switch)
 *   with its toMix as the target.
 *
 * Events beyond the first of each kind are not represented — editing the plan
 * replaces them (writePlan). That is the point: the plan is one decision each.
 */
export function readPlan(
  events: readonly ScenarioEvent[],
  people: readonly Person[],
): PlanDecisions {
  const retireByPerson: Record<string, YearMonth | null> = {};
  for (const p of people) {
    const ev = events.find(
      (e): e is Extract<ScenarioEvent, { type: 'retire' }> =>
        e.type === 'retire' && e.person === p.id,
    );
    retireByPerson[p.id] = ev ? ev.date : null;
  }

  const claims = events.filter(
    (e): e is Extract<ScenarioEvent, { type: 'claim_social_security' }> =>
      e.type === 'claim_social_security',
  );
  const primaryId = people[0]?.id;
  const claim = claims.find((c) => c.person === primaryId) ?? claims[0];

  const allocEvent = events.find(
    (e): e is Extract<ScenarioEvent, { type: 'allocation_change' | 'glidepath' }> =>
      (e.type === 'allocation_change' || e.type === 'glidepath') && e.account === undefined,
  );
  let allocation: PlanAllocationDecision | null = null;
  if (allocEvent?.type === 'allocation_change') {
    allocation = { date: allocEvent.date, mix: { ...allocEvent.mix }, glideYears: 0 };
  } else if (allocEvent?.type === 'glidepath') {
    const years = Math.round(monthsBetween(allocEvent.start, allocEvent.end) / 12);
    allocation = {
      date: allocEvent.start,
      mix: { ...allocEvent.toMix },
      glideYears: Math.max(1, years),
    };
  }

  return { retireByPerson, claimDate: claim ? claim.date : null, allocation };
}

/**
 * Write the plan back into an event list: every plan-owned event is removed and
 * the plan's own events take their place, ahead of every other event (whose
 * relative order is preserved untouched). A null decision means "no such event".
 *
 * The claim date is written for EVERY person — the household files once.
 */
export function writePlan(
  events: readonly ScenarioEvent[],
  plan: PlanDecisions,
  people: readonly Person[],
): ScenarioEvent[] {
  const kept = events.filter((e) => !isPlanOwnedEvent(e));
  const planEvents: ScenarioEvent[] = [];

  for (const p of people) {
    const date = plan.retireByPerson[p.id];
    if (date) planEvents.push({ type: 'retire', person: p.id, date });
  }
  if (plan.claimDate) {
    for (const p of people) {
      planEvents.push({ type: 'claim_social_security', person: p.id, date: plan.claimDate });
    }
  }
  const a = plan.allocation;
  if (a) {
    const years = Number.isFinite(a.glideYears) ? Math.round(a.glideYears) : 0;
    if (years > 0) {
      planEvents.push({
        type: 'glidepath',
        start: a.date,
        end: addYears(a.date, years),
        fromMix: planGlideFromMix(events),
        toMix: { ...a.mix },
      });
    } else {
      planEvents.push({ type: 'allocation_change', date: a.date, mix: { ...a.mix } });
    }
  }

  return [...planEvents, ...kept];
}

/**
 * The plan a brand-new scenario starts with: everyone stops working at 62,
 * the household claims at full retirement age, allocation unchanged. Sensible
 * starting points, all three visible and editable from the first screen.
 */
export function defaultPlan(people: readonly Person[]): PlanDecisions {
  const retireByPerson: Record<string, YearMonth | null> = {};
  for (const p of people) retireByPerson[p.id] = dateAtAge(p, DEFAULT_RETIRE_AGE);
  const primary = people[0];
  return {
    retireByPerson,
    claimDate: primary ? dateAtAge(primary, DEFAULT_CLAIM_AGE) : null,
    allocation: null,
  };
}

// ---------------------------------------------------------------------------
// The automatic 72(t)/SEPP bridge (scenario.autoSepp — ABSENT MEANS ON)
// ---------------------------------------------------------------------------
//
// Stopping work before 59 1/2 leaves a stretch of years in which pre-tax money
// can only be reached through the 10% early-withdrawal penalty, unless a 72(t)
// series is running. The engine therefore elects one BY ITSELF for anyone whose
// retirement lands before their own penalty-free year: the payment is sized to
// what the plan actually needs each year over that stretch, and the IRA is split
// so only the principal that payment requires sits under the series
// (engine/withdrawals.ts prepareAutoSepp + simulate.ts). `autoSepp: false` turns
// that off; an ABSENT field means ON.
//
// The Plan card needs two answers from that: is the toggle meaningful for the
// plan on screen (a household that never retires early has no gap to bridge),
// and what does checking or unchecking write. Both live here, pure and tested.
// `penaltyFreeFromYear` is the ENGINE's own function, so the card can never
// disagree with the simulation about who has a gap.

/** One person whose retirement lands before their own penalty-free year. */
export interface SeppBridge {
  personId: string;
  name: string;
  /** Calendar year this person stops working. */
  retireYear: number;
  /** First year their pre-tax money is penalty-free (59 1/2, annual steps). */
  penaltyFreeYear: number;
  /** penaltyFreeYear - retireYear: the years the bridge spans (>= 1). */
  bridgeYears: number;
}

/**
 * The people this plan retires before their own penalty-free year — exactly
 * the people prepareAutoSepp gives an automatic election to. People who keep
 * working, or who stop in/after their penalty-free year, have nothing to bridge.
 */
export function planSeppBridges(
  plan: PlanDecisions,
  people: readonly Person[],
): SeppBridge[] {
  const out: SeppBridge[] = [];
  for (const p of people) {
    const date = plan.retireByPerson[p.id] ?? null;
    if (date === null) continue;
    const retireYear = Number(date.slice(0, 4));
    if (!Number.isFinite(retireYear)) continue;
    const penaltyFreeYear = penaltyFreeFromYear(p);
    if (retireYear >= penaltyFreeYear) continue;
    out.push({
      personId: p.id,
      name: p.name,
      retireYear,
      penaltyFreeYear,
      bridgeYears: penaltyFreeYear - retireYear,
    });
  }
  return out;
}

/** Earliest year anybody's pre-tax money turns penalty-free; null with no people. */
export function firstPenaltyFreeYear(people: readonly Person[]): number | null {
  let first: number | null = null;
  for (const p of people) {
    const y = penaltyFreeFromYear(p);
    if (first === null || y < first) first = y;
  }
  return first;
}

/**
 * Owners of accounts named by a `start_72t` event. Such a person keeps exactly
 * the election the scenario wrote and gets no automatic one (prepareAutoSepp),
 * so the toggle does not speak for them. Accounts are needed because the event
 * names an ACCOUNT and the exclusion is per PERSON.
 */
export function explicitSeppOwners(
  events: readonly ScenarioEvent[],
  accounts: readonly Pick<Account, 'id' | 'owner'>[],
): Set<string> {
  const ownerById = new Map(accounts.map((a) => [a.id, a.owner]));
  const out = new Set<string>();
  for (const e of events) {
    if (e.type !== 'start_72t') continue;
    const owner = ownerById.get(e.account);
    if (owner !== undefined) out.add(owner);
  }
  return out;
}

/** "Alice 2028 → 2031", or "Alice 2028 → 2031 and Bob 2029 → 2031". */
export function describeSeppBridges(bridges: readonly SeppBridge[]): string {
  const parts = bridges.map((b) => `${b.name} ${b.retireYear} → ${b.penaltyFreeYear}`);
  if (parts.length <= 1) return parts[0] ?? '';
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

export interface AutoSeppStatus {
  /** The toggle changes this plan's numbers: somebody gets an automatic election. */
  applies: boolean;
  /** Is the bridge on? An absent `autoSepp` means ON. */
  on: boolean;
  /** People who get an automatic election. */
  bridges: SeppBridge[];
  /** People who retire early but wrote their own start_72t — that election wins. */
  explicit: SeppBridge[];
  /** One line saying why the toggle does nothing here; null when it applies. */
  inertReason: string | null;
}

/**
 * Everything the Plan card's 72(t) toggle needs about a scenario: whether it
 * is on, who it is for, and — when it is inert — why.
 */
export function autoSeppStatus(
  scenario: Pick<Scenario, 'autoSepp' | 'events'>,
  people: readonly Person[],
  accounts: readonly Pick<Account, 'id' | 'owner'>[] = [],
): AutoSeppStatus {
  const all = planSeppBridges(readPlan(scenario.events, people), people);
  const explicitOwners = explicitSeppOwners(scenario.events, accounts);
  const bridges = all.filter((b) => !explicitOwners.has(b.personId));
  const explicit = all.filter((b) => explicitOwners.has(b.personId));
  const firstFree = firstPenaltyFreeYear(people);
  let inertReason: string | null = null;
  if (bridges.length === 0) {
    if (explicit.length > 0) {
      inertReason =
        'This plan starts a 72(t) by hand, and that election is the one that runs.';
    } else if (firstFree === null) {
      inertReason = 'No people in this profile yet.';
    } else {
      inertReason =
        `Nobody stops working before ${firstFree}, the first year pre-tax money is ` +
        'penalty-free, so there is no gap to bridge.';
    }
  }
  return { applies: bridges.length > 0, on: scenario.autoSepp !== false, bridges, explicit, inertReason };
}

/**
 * The patch the checkbox writes. Turning the bridge ON CLEARS the field rather
 * than writing `true`: absent already means on, so a saved scenario carries
 * `autoSepp` only when the user deliberately turned the bridge off. (A patch
 * cannot delete a key, and it does not need to — both stableStringify and the
 * JSON written to disk drop undefined-valued keys, so the saved file and the
 * run key are identical to one that never had the field.)
 */
export function autoSeppPatch(on: boolean): Partial<Scenario> {
  return on ? { autoSepp: undefined } : { autoSepp: false };
}

/** Event types a solver replaces, so the editor can flag a conflict. */
export function solverOverriddenEventTypes(type: SolverSpec['type']): EventType[] {
  switch (type) {
    case 'retire_year_sweep':
    case 'earliest_retirement':
      return ['retire'];
    case 'ss_claim_sweep':
      return ['claim_social_security'];
    case 'widow_score':
      return ['death'];
    default:
      return [];
  }
}

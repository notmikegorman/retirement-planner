/**
 * Typed form for a single scenario event, covering the full v1 vocabulary.
 * Numeric inputs keep local string state and are parsed on save (buildEvent).
 */
import { useState, type ReactNode } from 'react';
import { DEFAULT_SURVIVOR_LIVING_FRACTION } from '../../../shared/types';
import type {
  Account,
  Person,
  ScenarioEvent,
  SocialSecurityData,
} from '../../../shared/types';
import { formatUSD } from '../../../shared/util';
// Claiming factors come from the same pure module the engine uses, so the
// preview shown in this form can never disagree with the simulation.
import { fraMonths, spousalFactor, workerFactor } from '../../../tax/socialSecurity';
import { FieldNote, InfoTip } from '../profile/fields';
import { MixEditor } from './MixEditor';
import {
  SS_CLAIM_AGES,
  ageAtDate,
  buildEvent,
  dateAtAge,
  eventTypeLabel,
  formatAge,
  type EventFields,
} from './scenarioHelpers';

/** Ages offered for a retirement event (claiming is restricted to 62-70). */
const RETIRE_AGES: readonly number[] = Array.from({ length: 26 }, (_, i) => 50 + i);

interface EventFormProps {
  initial: EventFields;
  people: Person[];
  accounts: Account[];
  /** Statutory claiming factors, for the age-picker preview. Null while loading. */
  ssData?: SocialSecurityData | null;
  isNew: boolean;
  onSave: (event: ScenarioEvent) => void;
  onCancel: () => void;
}

/** Keys of EventFields whose values are plain strings (safe for text inputs). */
type StringKey =
  | 'multiplier'
  | 'delta'
  | 'months'
  | 'monthlyCost'
  | 'price'
  | 'downPct'
  | 'rate'
  | 'termYears'
  | 'payoffAfterYears'
  | 'propertyTaxAnnual'
  | 'insuranceAnnual'
  | 'amount'
  | 'annualAmount'
  | 'interestRate'
  | 'toBracketTop';

const STATE_OPTIONS: Array<{ value: 'va' | 'sc' | 'nc'; label: string }> = [
  { value: 'va', label: 'Virginia' },
  { value: 'sc', label: 'South Carolina' },
  { value: 'nc', label: 'North Carolina' },
];

const ACCOUNT_TARGET_HELP =
  'Leave this on “All accounts” to re-mix the whole portfolio. Targeting one account turns off ' +
  'that account’s target-date auto-glide from this date on — the instruction you give here wins.';

const SEPP_EXPLAINER =
  'IRS Section 72(t) substantially equal periodic payments — penalty-free IRA access before ' +
  '59½. The app computes the IRS amortization payment and locks the stream until the later of ' +
  'five years or age 59½; extra withdrawals from that account are blocked while the lock runs.';

const SEPP_AMOUNT_HELP =
  'Annual amount: leave blank for the maximum. A smaller amount models splitting the IRA and ' +
  'running SEPP on one piece.';

const SEPP_RATE_HELP =
  'Interest rate: the amortization rate, as a decimal. Blank uses the default 5% (the Notice ' +
  '2022-6 floor).';

const DEATH_EXPLAINER =
  'From the year after this date the survivor files SINGLE — roughly half the standard ' +
  'deduction, brackets that compress far faster, Social Security taxable from a lower ' +
  'threshold, and a one-person poverty level for ACA subsidies. The deceased’s benefit stops and the survivor’s ' +
  'becomes the larger of their own and 100% of the deceased’s; the accounts roll over to them; a term policy ' +
  'still in force pays out tax-free. The year of the death itself is still a joint return.';

const DEATH_FRACTION_HELP =
  'The share of the couple’s LIVING baseline the survivor is modelled to spend from this month ' +
  'on — everyday consumption only, since housing and health are modelled separately and fall ' +
  'least. There is no primary source for this number and there cannot be: equivalence scales ' +
  'put two adults at 1.5 consumption units against one (0.67) or 1/sqrt(2) (0.71), and planning ' +
  'practice uses 70-80%. The default sits at the high end on purpose, because spending more of ' +
  'the survivor’s money reports a LOWER widow score, which is the conservative direction. Argue with it.';

const DEATH_CLAIM_HELP =
  'When the survivor’s own benefit starts, if they have not already claimed. Leave it blank and ' +
  'the plan’s own claiming decision stands (floored at 60, the earliest a survivor benefit can ' +
  'begin) — a death should not silently rewrite a choice you made on purpose. Set it to model ' +
  'them deciding differently once widowed: 71.5% at 60 against 100% at their survivor full ' +
  'retirement age.';

export function EventForm({
  initial,
  people,
  accounts,
  ssData = null,
  isNew,
  onSave,
  onCancel,
}: EventFormProps) {
  const [f, setF] = useState<EventFields>(initial);
  const [error, setError] = useState<string | null>(null);

  const set = (patch: Partial<EventFields>) => {
    setF((prev) => ({ ...prev, ...patch }));
    setError(null);
  };

  const save = () => {
    const res = buildEvent(f);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    onSave(res.event);
  };

  const month = (label: string, key: 'date' | 'start' | 'end') => (
    <label className="field" key={key}>
      {label}
      <input
        type="month"
        value={f[key]}
        onChange={(e) => set({ [key]: e.target.value } as Partial<EventFields>)}
      />
    </label>
  );

  const text = (label: string, key: StringKey, width = 120, placeholder?: string) => (
    <label className="field" key={key}>
      {label}
      <input
        style={{ width }}
        value={f[key]}
        placeholder={placeholder}
        onChange={(e) => set({ [key]: e.target.value } as Partial<EventFields>)}
      />
    </label>
  );

  const personSelect = (
    <label className="field">
      <span className="field-label">Person</span>
      <select value={f.person} onChange={(e) => set({ person: e.target.value })}>
        <option value="">— select —</option>
        {people.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </select>
    </label>
  );

  const moveBucket = (idx: number, dir: -1 | 1) => {
    const next = [...f.order];
    const j = idx + dir;
    if (j < 0 || j >= next.length) return;
    [next[idx], next[j]] = [next[j], next[idx]];
    set({ order: next });
  };

  const pretaxAccounts = accounts.filter(
    (a) => a.type === 'traditional_ira' || a.type === '401k',
  );

  /** Optional account target for allocation_change / glidepath (note 8). */
  const accountTargetSelect = (
    <label className="field">
      <span className="field-label">Applies to</span>
      <select value={f.account} onChange={(e) => set({ account: e.target.value })}>
        <option value="">All accounts</option>
        {accounts.map((a) => (
          <option key={a.id} value={a.id}>
            {a.name || a.id} ({a.id})
          </option>
        ))}
      </select>
    </label>
  );
  const accountTargetHelp = (
    <div className="field-help" style={{ marginTop: 2 }}>
      {ACCOUNT_TARGET_HELP}
    </div>
  );

  let body: ReactNode;
  switch (f.type) {
    case 'retire':
      body = (
        <AgePicker
          kind="retire"
          people={people}
          personId={f.person}
          date={f.date}
          ssData={ssData}
          onDate={(date) => set({ date })}
          personSelect={personSelect}
        />
      );
      break;
    case 'claim_social_security':
      body = (
        <AgePicker
          kind="claim"
          people={people}
          personId={f.person}
          date={f.date}
          ssData={ssData}
          onDate={(date) => set({ date })}
          personSelect={personSelect}
        />
      );
      break;
    /*
     * Not reachable from the "add event" picker — the Widow tab writes these —
     * but reachable from the events list the moment a plan carries one, and an
     * event you can see but not open is worse than no event at all.
     */
    case 'death':
      body = (
        <>
          <div className="muted" style={{ marginBottom: 8 }}>
            {DEATH_EXPLAINER}
          </div>
          <div className="row">
            {personSelect}
            {month('Date', 'date')}
          </div>
          <div className="row">
            <label className="field" style={{ width: 170 }}>
              <span className="field-label">
                Survivor’s living costs
                <InfoTip label="the survivor's living costs" text={DEATH_FRACTION_HELP} />
              </span>
              <input
                style={{ width: 170 }}
                value={f.livingFraction}
                placeholder={`blank = ${DEFAULT_SURVIVOR_LIVING_FRACTION}`}
                onChange={(e) => set({ livingFraction: e.target.value })}
              />
              {/* The one load-bearing scope fact, kept visible when the tips
                  went quiet (2026-08-30); DEATH_FRACTION_HELP holds the rest. */}
              <span className="field-help">
                Of everyday LIVING spending only — housing and health are modelled separately
              </span>
            </label>
            <label className="field">
              <span className="field-label">
                Survivor benefit starts
                <InfoTip label="the survivor's claim date" text={DEATH_CLAIM_HELP} />
              </span>
              <input
                type="month"
                value={f.survivorClaim}
                onChange={(e) => set({ survivorClaim: e.target.value })}
              />
            </label>
            <FieldNote className="muted">
              {f.survivorClaim === '' ? 'blank = the claim date this plan already gives them' : ''}
            </FieldNote>
          </div>
        </>
      );
      break;
    case 'expense_change':
      body = (
        <div className="row">
          {month('Date', 'date')}
          <label className="field">
            <span className="field-label">Change</span>
            <select
              value={f.expenseMode}
              onChange={(e) => set({ expenseMode: e.target.value as EventFields['expenseMode'] })}
            >
              <option value="multiplier">Multiplier (×)</option>
              <option value="delta">Delta ($/yr)</option>
            </select>
          </label>
          {f.expenseMode === 'multiplier'
            ? text('Multiplier', 'multiplier', 90, 'e.g. 0.85')
            : text('Delta $/yr', 'delta', 110, 'e.g. -5000')}
          <label className="field">
            <span className="field-label">Stream</span>
            <select
              value={f.category}
              onChange={(e) => set({ category: e.target.value as EventFields['category'] })}
            >
              <option value="living">Living expenses</option>
              <option value="charitable">Charitable giving</option>
            </select>
          </label>
        </div>
      );
      break;
    case 'state_change':
      body = (
        <div className="row">
          {month('Date', 'date')}
          <label className="field">
            <span className="field-label">State</span>
            <select
              value={f.state}
              onChange={(e) => set({ state: e.target.value as EventFields['state'] })}
            >
              {STATE_OPTIONS.map((s) => (
                <option key={s.value} value={s.value}>
                  {s.label}
                </option>
              ))}
            </select>
          </label>
        </div>
      );
      break;
    case 'sell_house':
      body = (
        <div className="row">
          {month('Date', 'date')}
          <span className="muted">
            Sells the primary home; the §121 gain exclusion uses the profile's home cost basis.
          </span>
        </div>
      );
      break;
    case 'rent':
      body = (
        <div className="row">
          {month('Start', 'start')}
          {text('Months', 'months', 80)}
          {text('Monthly cost $', 'monthlyCost', 110)}
        </div>
      );
      break;
    case 'buy_house':
      body = (
        <>
          <div className="row">
            {month('Date', 'date')}
            <label className="field">
              <span className="field-label">Price</span>
              <select
                value={f.priceMode}
                onChange={(e) => set({ priceMode: e.target.value as EventFields['priceMode'] })}
              >
                <option value="sale_proceeds">= net sale proceeds</option>
                <option value="amount">Fixed amount</option>
              </select>
            </label>
            {f.priceMode === 'amount' && text('Price $', 'price', 120, 'e.g. 400000')}
            <label className="field">
              <span className="field-label">Financing</span>
              <select
                value={f.financingMode}
                onChange={(e) =>
                  set({ financingMode: e.target.value as EventFields['financingMode'] })
                }
              >
                <option value="cash">Cash</option>
                <option value="mortgage">Mortgage</option>
              </select>
            </label>
          </div>
          {f.financingMode === 'mortgage' && (
            <div className="row">
              {text('Down payment (0–1)', 'downPct', 110, 'e.g. 0.2')}
              {text('Rate (decimal)', 'rate', 100, 'e.g. 0.065')}
              {text('Term (years)', 'termYears', 90, 'e.g. 30')}
              {text('Pay off after (yrs)', 'payoffAfterYears', 110, 'blank = full term')}
            </div>
          )}
          <div className="row">
            {text('Property tax $/yr', 'propertyTaxAnnual', 120)}
            {text('Insurance $/yr', 'insuranceAnnual', 120)}
          </div>
        </>
      );
      break;
    case 'allocation_change':
      body = (
        <>
          <div className="row">
            {month('Date', 'date')}
            {accountTargetSelect}
          </div>
          {accountTargetHelp}
          <MixEditor label="New mix" mix={f.mix} onChange={(mix) => set({ mix })} />
        </>
      );
      break;
    case 'glidepath':
      body = (
        <>
          <div className="row">
            {month('Start', 'start')}
            {month('End', 'end')}
            {accountTargetSelect}
          </div>
          {accountTargetHelp}
          <MixEditor label="From mix" mix={f.fromMix} onChange={(fromMix) => set({ fromMix })} />
          <MixEditor label="To mix" mix={f.toMix} onChange={(toMix) => set({ toMix })} />
        </>
      );
      break;
    case 'withdrawal_strategy':
      body = (
        <>
          <div className="row">
            {month('Date', 'date')}
            <label className="field">
              <span className="field-label">Pre-tax preference</span>
              <select
                value={f.pretaxPreference}
                onChange={(e) =>
                  set({ pretaxPreference: e.target.value as EventFields['pretaxPreference'] })
                }
              >
                <option value="ira_first">IRA first</option>
                <option value="proportional">Proportional</option>
              </select>
            </label>
          </div>
          <div className="muted" style={{ marginTop: 6 }}>
            Withdrawal order (top is tapped first)
          </div>
          {f.order.map((bucket, i) => (
            <div className="row" key={bucket} style={{ marginTop: 4 }}>
              <span style={{ width: 80 }}>{bucket}</span>
              <button onClick={() => moveBucket(i, -1)} disabled={i === 0}>
                Up
              </button>
              <button onClick={() => moveBucket(i, 1)} disabled={i === f.order.length - 1}>
                Down
              </button>
            </div>
          ))}
        </>
      );
      break;
    case 'one_time_expense':
      body = (
        <div className="row">
          {month('Date', 'date')}
          {text('Amount $', 'amount', 120)}
        </div>
      );
      break;
    case 'one_time_income':
      body = (
        <div className="row">
          {month('Date', 'date')}
          {text('Amount $', 'amount', 120)}
          <label className="field">
            <span className="field-label">Taxability</span>
            <select
              value={f.taxable}
              onChange={(e) => set({ taxable: e.target.value as EventFields['taxable'] })}
            >
              <option value="default">Default (taxable)</option>
              <option value="yes">Taxable</option>
              <option value="no">Tax-free</option>
            </select>
          </label>
        </div>
      );
      break;
    case 'start_72t':
      body = (
        <>
          <div className="muted" style={{ marginBottom: 8 }}>
            {SEPP_EXPLAINER}
          </div>
          <div className="row">
            {month('Date', 'date')}
            <label className="field">
              <span className="field-label">Account</span>
              <select value={f.account} onChange={(e) => set({ account: e.target.value })}>
                <option value="">— select —</option>
                {pretaxAccounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name || a.id} ({a.id})
                  </option>
                ))}
              </select>
            </label>
            {text('Annual amount $ (optional)', 'annualAmount', 150, 'blank = maximum')}
            {text('Interest rate (optional)', 'interestRate', 140, 'blank = 0.05')}
          </div>
          <div className="field-help" style={{ marginTop: 6 }}>
            {SEPP_AMOUNT_HELP}
          </div>
          <div className="field-help" style={{ marginTop: 2 }}>
            {SEPP_RATE_HELP}
          </div>
        </>
      );
      break;
    case 'roth_conversion':
      body = (
        <div className="row">
          <label className="field">
            <span className="field-label">Schedule</span>
            <select
              value={f.schedule}
              onChange={(e) => set({ schedule: e.target.value as EventFields['schedule'] })}
            >
              <option value="once">One-time</option>
              <option value="yearly">Every year</option>
            </select>
          </label>
          {f.schedule === 'once' && month('Date', 'date')}
          <label className="field">
            <span className="field-label">Amount</span>
            <select
              value={f.conversionMode}
              onChange={(e) =>
                set({ conversionMode: e.target.value as EventFields['conversionMode'] })
              }
            >
              <option value="amount">Fixed $</option>
              <option value="bracket">To top of bracket</option>
            </select>
          </label>
          {f.conversionMode === 'amount'
            ? text('Amount $', 'amount', 110)
            : text('Bracket rate (decimal)', 'toBracketTop', 130, 'e.g. 0.12')}
        </div>
      );
      break;
  }

  return (
    <div
      style={{
        border: '1px solid var(--border)',
        borderRadius: 8,
        padding: '10px 14px',
        margin: '8px 0',
        background: 'var(--bg)',
      }}
    >
      <h3 style={{ marginTop: 0 }}>
        {isNew ? 'Add event' : 'Edit event'}: {eventTypeLabel(f.type)}
      </h3>
      {body}
      {error && (
        <div className="error-banner" style={{ marginTop: 10, marginBottom: 0 }}>
          {error}
        </div>
      )}
      <div className="row" style={{ marginTop: 10 }}>
        <button className="primary" onClick={save}>
          Save event
        </button>
        <button onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}

/**
 * Claiming age picker (note 17). Social Security can only start between 62 and
 * 70, and people decide in ages, not calendar months — so the form offers an age
 * (plus optional months) and derives the stored "YYYY-MM" date from the person's
 * birth month. The preview shows what that age is worth: the statutory factor
 * comes from src/tax/socialSecurity.ts, the same pure functions the engine uses,
 * so the number shown here can never disagree with the simulation.
 */
function AgePicker({
  kind,
  people,
  personId,
  date,
  ssData,
  onDate,
  personSelect,
}: {
  kind: 'retire' | 'claim';
  people: Person[];
  personId: string;
  date: string;
  ssData: SocialSecurityData | null;
  onDate: (date: string) => void;
  personSelect: ReactNode;
}) {
  const ages = kind === 'claim' ? SS_CLAIM_AGES : RETIRE_AGES;
  const person = people.find((p) => p.id === personId) ?? null;
  const age = person ? ageAtDate(person, date) : null;
  // Age mode is the default. Fall back to a raw date only when the stored date
  // maps to an age the dropdown cannot express (e.g. a claim date outside 62-70).
  const [advanced, setAdvanced] = useState(() => !!age && !ages.includes(age.years));

  // Factor + resulting benefit for the currently chosen age.
  let preview: string | null = null;
  if (kind === 'retire') {
    preview = person && age ? `Stops ${person.name}'s salary from ${date}.` : null;
  } else if (person && ssData && age) {
    const fraM = fraMonths(person, ssData);
    const claimM = age.years * 12 + age.months;
    const own = person.hasOwnBenefit;
    const factor = own
      ? workerFactor(claimM, fraM, ssData)
      : spousalFactor(claimM, fraM, ssData);
    const pct = `${(factor * 100).toFixed(1)}%`;
    if (own) {
      const monthly = person.piaMonthlyAtFraIfWorkingTo62 * factor;
      preview = `${pct} of your full benefit — about ${formatUSD(monthly)}/mo in today's dollars${
        claimM > fraM ? ' (delayed-retirement credits)' : claimM < fraM ? ' (early-claiming reduction)' : ' (full retirement age)'
      }.`;
    } else {
      preview =
        `Spousal benefit: ${pct} of the worker's full benefit. Spousal benefits get no ` +
        `delayed credits after full retirement age, and cannot start before the worker files.`;
    }
  }

  return (
    <div>
      <div className="row">
        {personSelect}
        {!advanced && person ? (
          <>
            <label className="field" style={{ width: 150 }}>
              <span className="field-label">{kind === 'claim' ? 'Claim at age' : 'Retire at age'}</span>
              <select
                value={String(age?.years ?? (kind === 'claim' ? 67 : 60))}
                onChange={(e) => onDate(dateAtAge(person, Number(e.target.value)))}
              >
                {ages.map((a) => (
                  <option key={a} value={a}>
                    {kind === 'claim' && a === 67 ? '67 — full retirement age' : String(a)}
                  </option>
                ))}
              </select>
            </label>
            <FieldNote className="muted">
              starts {date}
              {age && age.months !== 0 ? ` (${formatAge(age)})` : ''}
            </FieldNote>
          </>
        ) : (
          <label className="field" key="date">
            <span className="field-label">Date</span>
            <input type="month" value={date} onChange={(e) => onDate(e.target.value)} />
          </label>
        )}
      </div>
      {preview && (
        <div className="field-help" style={{ marginTop: 4 }}>
          {preview}
        </div>
      )}
      <div className="field-help" style={{ marginTop: 4 }}>
        <button
          type="button"
          className="link-button"
          onClick={() => {
            const next = !advanced;
            setAdvanced(next);
            if (!next && person && age) onDate(dateAtAge(person, age.years));
          }}
        >
          {advanced ? 'Pick a whole age instead' : 'Use an exact month instead'}
        </button>
        {!person && ' — choose a person first.'}
      </div>
    </div>
  );
}

/**
 * Spending, in the plan — three streams, each as ONE row with two cells.
 *
 * LIVING is the one true pair: a value in play WHILE WORKING and a value in
 * play AFTER nobody works, side by side, because that is the actual decision
 * ("we spend 8,000 now and expect to spend 7,000 then") and reading it as one
 * line is what makes the retired side impossible to forget. A blank
 * right-hand cell says the default in words — "same as working".
 *
 * INVESTING's right-hand cell is a NOTE, not a control, since 2026-08-31:
 * investing stops at retirement (the app's standing rule), so there is no
 * retired stream to override and a box would be a knob wired to nothing.
 *
 * Giving's right-hand cell is a POINTER, not a control: what happens to giving
 * once the paychecks stop is two decisions (the un-tithed pot, and the ongoing
 * method), and both live on the Tithing tab where they get the room they need.
 * Only the working-side stream — a plain monthly number like the other two —
 * is edited here.
 *
 * The household's spending lives in the PROFILE — one shared baseline. But
 * "what if we lived on $500 a month less?" is a what-if, not a change to the
 * household's baseline, so the numbers here are written into the plan as
 * `assumption_overrides.expenses` and the profile is never touched — which is
 * what lets a what-if be undone by clearing one box. Each cell shows the
 * profile value as its placeholder and says "overridden", with one click back,
 * only when it is. Blanking a box is the same as clicking reset.
 */
import { useEffect, useState } from 'react';
import type { AssumptionOverrides, ProfileExpenses } from '../../../shared/types';
import { deriveExpenseStreams } from '../../../shared/expenses';
import { formatUSD } from '../../../shared/util';
import { InfoTip } from '../profile/fields';
import { parseNumber } from '../scenarios/scenarioHelpers';
import {
  effectiveMonthly,
  effectiveRetiredMonthly,
  expenseOverride,
  retiredPlaceholder,
  setExpenseOverride,
  type ExpenseKey,
} from './workbenchLogic';

// ---------------------------------------------------------------------------
// Help text — all of it behind a "?" (see fields.tsx InfoTip)
// ---------------------------------------------------------------------------

/** The section-header tip (ScenarioPanel renders it beside the fold). */
export const SPENDING_CARD_TIP =
  'Monthly, in today’s dollars. Blank means “whatever the profile says” — the placeholder shows ' +
  'that value. A number here overrides it in THIS PLAN only, leaving profile.json alone, so a ' +
  'what-if is undone by clearing the box.';

const RETIRED_COLUMN_TIP =
  'Everything switches on one signal: the first year in which nobody in the household earns a ' +
  'salary. The retirement year itself is split — the working figure for the months worked, the ' +
  'after-work behavior for the rest. Living takes the figure in this column; investing stops at ' +
  'retirement outright; giving follows the Tithing rule.';

const LIVING_TIP =
  'Everyday consumption: excludes health premiums, housing (property tax, insurance, maintenance, ' +
  'rent, mortgage), giving and investing — all modeled separately. An empty right-hand cell keeps ' +
  'the working figure, because costs do not fall the day the salary stops. (Under the fixed-percent ' +
  'spending policy the policy sets living spending outright and neither cell is consulted.)';

const INVESTING_TIP =
  'A transfer into the taxable brokerage, not consumption — it moves money between accounts and is ' +
  'capped at what is left after taxes and expenses, so it can never force a withdrawal. It stops ' +
  'at retirement: investing out of a paycheck ends with the paycheck.';

const GIVING_TIP =
  'Your giving while anyone is still earning — its own stream, and it drives the charitable tax ' +
  'deductions. Unlike investing it does NOT stop by itself when the paychecks do: what replaces ' +
  'it — the un-tithed pot and the ongoing method — is configured on the Tithing tab.';

// ---------------------------------------------------------------------------
// The card
// ---------------------------------------------------------------------------

interface StreamRow {
  /** The working-side override key (and the profile field of the same name). */
  key: Extract<ExpenseKey, 'livingMonthly'>;
  retiredKey: Extract<ExpenseKey, 'livingMonthlyRetired'>;
  label: string;
  tip: string;
}

/*
 * ONE paired row now: living. Investing lost its retired cell when the app
 * adopted "investing stops at retirement" as a standing rule (the owner's,
 * 2026-08-31) — its row below is a working-side override plus a pointer,
 * the same shape giving has always had.
 */
const STREAMS: readonly StreamRow[] = [
  {
    key: 'livingMonthly',
    retiredKey: 'livingMonthlyRetired',
    label: 'Living',
    tip: LIVING_TIP,
  },
];

interface SpendingCardProps {
  /** The household baseline these cells override. */
  profileExpenses: ProfileExpenses;
  overrides: AssumptionOverrides | undefined;
  onChange: (overrides: AssumptionOverrides | undefined) => void;
}

export function SpendingCard({
  profileExpenses,
  overrides,
  onChange,
}: SpendingCardProps) {
  return (
    <div className="card">
      {/* No heading: the section header names this card (ScenarioPanel
          carries its tip). */}
      <div className="pair-grid">
        <div className="pair-head">While working</div>
        <div className="pair-head">
          After you stop working
          <InfoTip label="the after-work column" text={RETIRED_COLUMN_TIP} align="end" />
        </div>
        {STREAMS.map((row) => (
          <StreamPair
            key={row.key}
            row={row}
            profileExpenses={profileExpenses}
            overrides={overrides}
            onChange={onChange}
          />
        ))}
        <InvestingPair
          profileExpenses={profileExpenses}
          overrides={overrides}
          onChange={onChange}
        />
        <GivingPair
          profileExpenses={profileExpenses}
          overrides={overrides}
          onChange={onChange}
        />
      </div>
      {/* Life insurance left this card for its own fold (InsuranceCard, the
          owner's relocation 2026-08-31) — this card is the three streams. */}
    </div>
  );
}

/**
 * One stream as one row: the working figure, the after-work figure, and each
 * one's annual equivalent. The retired cell's placeholder is the profile's own
 * retired figure when it has one and the stream's default in words when it does
 * not, so an empty cell is never ambiguous.
 */
function StreamPair({
  row,
  profileExpenses,
  overrides,
  onChange,
}: {
  row: StreamRow;
  profileExpenses: ProfileExpenses;
  overrides: AssumptionOverrides | undefined;
  onChange: (overrides: AssumptionOverrides | undefined) => void;
}) {
  const workingOverride = expenseOverride(overrides, row.key);
  const retiredOverride = expenseOverride(overrides, row.retiredKey);
  // The BASELINE these cells override is what the run will actually spend, so
  // it is derived from the budget rows rather than read off the scalar cache
  // they replace: this card showed "Living $7,100/mo" as the figure to beat
  // while the plan beside it simulated $7,340, which makes every override typed
  // here an answer to the wrong question.
  const baseline = deriveExpenseStreams(profileExpenses);
  const profileWorking = baseline[row.key];
  const profileRetired = baseline[row.retiredKey];

  const working = effectiveMonthly(profileWorking, workingOverride);
  // Priced off the value THIS run uses: "same as working" has to follow the
  // working cell's override, not the profile's untouched number.
  const retired = effectiveRetiredMonthly(working, profileRetired, retiredOverride);

  return (
    <>
      <div className="pair-label">
        {row.label}
        <InfoTip label={row.label.toLowerCase()} text={row.tip} />
      </div>
      <div className="pair-cell">
        <MoneyBox
          value={workingOverride}
          placeholder={String(profileWorking)}
          onCommit={(v) => onChange(setExpenseOverride(overrides, row.key, v))}
        />
        <AnnualNote monthly={working} />
        <OverrideStatus
          override={workingOverride}
          profileText={`${formatUSD(profileWorking)}/mo`}
          onReset={() => onChange(setExpenseOverride(overrides, row.key, undefined))}
        />
      </div>
      <div className="pair-cell">
        <MoneyBox
          value={retiredOverride}
          placeholder={retiredPlaceholder(profileRetired)}
          onCommit={(v) => onChange(setExpenseOverride(overrides, row.retiredKey, v))}
        />
        <AnnualNote monthly={retired} />
        <OverrideStatus
          override={retiredOverride}
          profileText={
            profileRetired === undefined
              ? retiredPlaceholder(undefined)
              : `${formatUSD(profileRetired)}/mo`
          }
          onReset={() => onChange(setExpenseOverride(overrides, row.retiredKey, undefined))}
        />
      </div>
    </>
  );
}

/**
 * Investing, as the giving row's shape: a number on the left, a NOTE on the
 * right. There is no retired cell to override because there is no retired
 * stream — investing stops at retirement, the app's standing rule
 * (2026-08-31), and a cell here would be a knob wired to nothing.
 */
function InvestingPair({
  profileExpenses,
  overrides,
  onChange,
}: {
  profileExpenses: ProfileExpenses;
  overrides: AssumptionOverrides | undefined;
  onChange: (overrides: AssumptionOverrides | undefined) => void;
}) {
  const workingOverride = expenseOverride(overrides, 'investingMonthly');
  const profileWorking = deriveExpenseStreams(profileExpenses).investingMonthly;
  const working = effectiveMonthly(profileWorking, workingOverride);

  return (
    <>
      <div className="pair-label">
        Investing → brokerage
        <InfoTip label="investing → brokerage" text={INVESTING_TIP} />
      </div>
      <div className="pair-cell">
        <MoneyBox
          value={workingOverride}
          placeholder={String(profileWorking)}
          onCommit={(v) => onChange(setExpenseOverride(overrides, 'investingMonthly', v))}
        />
        <AnnualNote monthly={working} />
        <OverrideStatus
          override={workingOverride}
          profileText={`${formatUSD(profileWorking)}/mo`}
          onReset={() => onChange(setExpenseOverride(overrides, 'investingMonthly', undefined))}
        />
      </div>
      <div className="pair-cell">
        <span className="pair-note">Stops at retirement.</span>
      </div>
    </>
  );
}

/**
 * Giving, as the same row shape: a number on the left, a POINTER on the
 * right. The working-side stream is a plain monthly figure like the other
 * two; everything about giving AFTER the paychecks — the un-tithed pot and
 * the ongoing method — lives on the Tithing tab, where the two decisions get
 * clearly-headed sections instead of a dropdown squeezed into a cell.
 */
function GivingPair({
  profileExpenses,
  overrides,
  onChange,
}: {
  profileExpenses: ProfileExpenses;
  overrides: AssumptionOverrides | undefined;
  onChange: (overrides: AssumptionOverrides | undefined) => void;
}) {
  const workingOverride = expenseOverride(overrides, 'charitableMonthly');
  // Derived for the same reason as the living/investing pair above: with an
  // itemised budget the giving rows are the truth and the scalar is their cache.
  const profileWorking = deriveExpenseStreams(profileExpenses).charitableMonthly;
  const working = effectiveMonthly(profileWorking, workingOverride);

  return (
    <>
      <div className="pair-label">
        Charitable giving
        <InfoTip label="charitable giving" text={GIVING_TIP} />
      </div>
      <div className="pair-cell">
        <MoneyBox
          value={workingOverride}
          placeholder={String(profileWorking)}
          onCommit={(v) => onChange(setExpenseOverride(overrides, 'charitableMonthly', v))}
        />
        <AnnualNote monthly={working} />
        <OverrideStatus
          override={workingOverride}
          profileText={`${formatUSD(profileWorking)}/mo`}
          onReset={() => onChange(setExpenseOverride(overrides, 'charitableMonthly', undefined))}
        />
      </div>
      <div className="pair-cell">
        <span className="pair-note">Set on the Tithing tab — the pot and the ongoing method.</span>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Cell primitives
// ---------------------------------------------------------------------------

/** "$5,000/mo · $60,000/yr" — what this cell means for a year, at a glance. */
function AnnualNote({ monthly }: { monthly: number }) {
  return (
    <span className="pair-note">
      {formatUSD(monthly)}/mo · {formatUSD(monthly * 12)}/yr
    </span>
  );
}

/**
 * Whether this cell is the profile's answer or the plan's. Silent in the common
 * case — the placeholder already shows the profile's value — and one badge plus
 * one click back when it isn't, which is what keeps six cells from turning into
 * six paragraphs of status.
 */
export function OverrideStatus({
  override,
  profileText,
  onReset,
}: {
  override: unknown;
  profileText: string;
  onReset: () => void;
}) {
  if (override === undefined) return null;
  return (
    <span className="pair-status">
      <span className="badge">overridden</span> profile: {profileText} —{' '}
      <button type="button" className="link-button" onClick={onReset}>
        reset
      </button>
    </span>
  );
}

/**
 * One monthly-dollar box. Local text state so typing isn't fought; the value is
 * committed on blur or Enter, which is also what makes the live re-run fire
 * once per decision instead of once per keystroke. An empty box means "back to
 * the profile value", never "$0" — $0 is typed as a zero.
 */
export function MoneyBox({
  value,
  placeholder,
  onCommit,
}: {
  value: number | undefined;
  placeholder: string;
  onCommit: (value: number | undefined) => void;
}) {
  const [text, setText] = useState(value === undefined ? '' : String(value));

  // Re-sync when the plan changes underneath us (load, raw-JSON apply, reset).
  useEffect(() => {
    setText(value === undefined ? '' : String(value));
  }, [value]);

  const commit = () => {
    const trimmed = text.trim();
    if (trimmed === '') {
      setText('');
      if (value !== undefined) onCommit(undefined);
      return;
    }
    const n = parseNumber(trimmed);
    if (n === null || n < 0) {
      setText(value === undefined ? '' : String(value)); // revert
      return;
    }
    setText(String(n));
    if (n !== value) onCommit(n);
  };

  return (
    <input
      inputMode="decimal"
      value={text}
      placeholder={placeholder}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur();
      }}
    />
  );
}

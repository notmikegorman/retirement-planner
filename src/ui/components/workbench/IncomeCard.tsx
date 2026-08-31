/**
 * Income, in the plan — ONE knob: the money the household expects to bring in
 * AFTER it stops working — consulting, part-time work, a rental, a pension.
 * It is the mirror image of a salary (it starts the first year no salary is
 * drawn, is prorated in the retirement year, and inflates with everything
 * else), it is spendable cash that reduces the year's withdrawal, and on this
 * household's numbers a few hundred a month moves the verdict more than
 * almost anything else on the page. That is exactly why it lives in the plan
 * rather than the profile: "what if I picked up two days a week of
 * consulting?" is a what-if, and clearing the box undoes it.
 *
 * The card used to open with a read-only "While working" column (salaries,
 * 401(k), match) and a taxable/not-taxable select. Both are gone (the
 * owner's calls, 2026-08-31): the working figures are the Income page's
 * facts, restated here as furniture; and post-retirement income is now
 * ALWAYS ordinary income — the engine assumes taxable, and any
 * retirementIncomeTaxable still in a file is parsed but ignored.
 */
import { useEffect, useState } from 'react';
import type { AssumptionOverrides, ProfileIncome } from '../../../shared/types';
import { formatUSD } from '../../../shared/util';
import { InfoTip } from '../profile/fields';
import { parseNumber } from '../scenarios/scenarioHelpers';
import {
  effectiveRetirementIncome,
  retirementIncomeOverride,
  retirementIncomePlaceholder,
  setRetirementIncomeOverride,
} from './workbenchLogic';

/** The section-header tip (ScenarioPanel renders it beside the fold). */
export const INCOME_CARD_TIP =
  'What you expect to bring in once you have stopped working. Blank means “whatever the profile ' +
  'says” — a number here overrides it in THIS PLAN only, leaving profile.json alone. It counts ' +
  'as ordinary income for every tax and MAGI purpose.';

const RETIREMENT_TIP =
  'Part-time work, consulting, a rental, a pension — anything recurring you expect after you stop ' +
  'working, in today’s dollars per month. It is the mirror image of a salary: it starts in the ' +
  'first year nobody draws one, the retirement year is prorated by the months nobody worked, and ' +
  'it inflates with CPI and then runs for life. It is spendable cash, so it directly reduces what ' +
  'the portfolio has to produce that year — and it shrinks any automatic 72(t) series, which locks ' +
  'up less of the IRA. It is always ordinary income: it raises AGI and every MAGI test with it ' +
  '(simplification: plain ordinary income, not wages — no payroll tax, and the Social Security ' +
  'earnings test is not modeled).';

interface IncomeCardProps {
  /** The household baseline: any profile-level retirement income. */
  profileIncome: ProfileIncome;
  overrides: AssumptionOverrides | undefined;
  onChange: (overrides: AssumptionOverrides | undefined) => void;
}

export function IncomeCard({ profileIncome, overrides, onChange }: IncomeCardProps) {
  const override = retirementIncomeOverride(overrides);
  const monthly = effectiveRetirementIncome(profileIncome.retirementMonthly, override);

  return (
    <div className="card">
      {/* No heading: the section header names this card (ScenarioPanel
          carries its tip). */}
      <div className="pair-cell">
        <div className="pair-head">
          Income after you stop working
          <InfoTip label="income after you stop working" text={RETIREMENT_TIP} align="end" />
        </div>
        <MoneyBox
          value={override}
          placeholder={retirementIncomePlaceholder(profileIncome.retirementMonthly)}
          label="Income after you stop working ($/mo)"
          onCommit={(v) => onChange(setRetirementIncomeOverride(overrides, v))}
        />
        <span className="pair-note">
          {formatUSD(monthly)}/mo · {formatUSD(monthly * 12)}/yr — ordinary income
        </span>
        {override !== undefined && (
          <span className="pair-status">
            <span className="badge">overridden</span> profile:{' '}
            {profileIncome.retirementMonthly === undefined
              ? 'none'
              : `${formatUSD(profileIncome.retirementMonthly)}/mo`}{' '}
            —{' '}
            <button
              type="button"
              className="link-button"
              onClick={() => onChange(setRetirementIncomeOverride(overrides, undefined))}
            >
              reset
            </button>
          </span>
        )}
      </div>
    </div>
  );
}

/**
 * The monthly box, with the same commit-on-blur contract as the spending cells
 * (see SpendingCard.MoneyBox): one live re-run per decision, and an empty box
 * means "whatever the profile says", never "$0".
 */
function MoneyBox({
  value,
  placeholder,
  label,
  onCommit,
}: {
  value: number | undefined;
  placeholder: string;
  label: string;
  onCommit: (value: number | undefined) => void;
}) {
  const [text, setText] = useState(value === undefined ? '' : String(value));

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
      aria-label={label}
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

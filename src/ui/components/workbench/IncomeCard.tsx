/**
 * Income, in the plan — the same two-column shape as Spending, with one honest
 * asymmetry.
 *
 * The LEFT cell is what the household earns now: salaries, the 401(k) deferral
 * and the employer match. It is READ-ONLY here because it is payroll fact the
 * profile owns — the only thing a plan changes about a salary is the date it
 * stops, which is a retire event on the Plan card above.
 *
 * The RIGHT cell is the knob this card exists for: the money the household
 * expects to bring in AFTER it stops working — consulting, part-time work, a
 * rental, a pension. It is the mirror image of a salary (it starts the first
 * year no salary is drawn, is prorated in the retirement year, and inflates with
 * everything else), it is spendable cash that reduces the year's withdrawal, and
 * on this household's numbers a few hundred a month moves the verdict more than
 * almost anything else on the page. That is exactly why it lives in the plan
 * rather than the profile: "what if I picked up two days a week of consulting?"
 * is a what-if, and clearing the box undoes it.
 */
import { useEffect, useState } from 'react';
import type { AssumptionOverrides, Person, ProfileIncome } from '../../../shared/types';
import { formatUSD } from '../../../shared/util';
import { InfoTip } from '../profile/fields';
import { parseNumber } from '../scenarios/scenarioHelpers';
import {
  effectiveRetirementIncome,
  effectiveRetirementTaxable,
  retirementIncomeOverride,
  retirementIncomePlaceholder,
  retirementTaxableOverride,
  setRetirementIncomeOverride,
  setRetirementTaxableChoice,
  workingIncomeLines,
} from './workbenchLogic';

const CARD_TIP =
  'What comes IN, on the same two-column shape as spending: what you earn now on the left, what ' +
  'you expect to bring in once you have stopped on the right. Only the right-hand side is a plan ' +
  'setting — blank means “whatever the profile says”, and a number here leaves profile.json alone.';

const WORKING_TIP =
  'From your profile, and not editable here: salaries and the 401(k) are payroll facts, not ' +
  'what-ifs. Change them on the Profile page. The one thing this plan DOES decide about them is ' +
  'the date they stop — that is the retire event on the Plan card above.';

const RETIREMENT_TIP =
  'Part-time work, consulting, a rental, a pension — anything recurring you expect after you stop ' +
  'working, in today’s dollars per month. It is the mirror image of a salary: it starts in the ' +
  'first year nobody draws one, the retirement year is prorated by the months nobody worked, and ' +
  'it inflates with CPI and then runs for life. It is spendable cash, so it directly reduces what ' +
  'the portfolio has to produce that year — and it shrinks any automatic 72(t) series, which locks ' +
  'up less of the IRA.';

const TAXABLE_TIP =
  'Taxable is the honest default for anything earned: it is ordinary income, so it raises AGI and ' +
  'therefore every MAGI test — the ACA subsidy cliff, IRMAA, the taxability of Social Security. ' +
  'Not taxable models money that is not income at all (a return of capital, a gift, a ' +
  'reimbursement): spendable cash that touches none of them. Simplification: taxable income here ' +
  'is plain ordinary income, not wages — no payroll tax, and the Social Security earnings test is ' +
  'not modeled (this household claims at 67, its full retirement age, where the test never ' +
  'applies).';

interface IncomeCardProps {
  /** The household baseline: salaries, 401(k), and any profile-level retirement income. */
  profileIncome: ProfileIncome;
  people: Person[];
  overrides: AssumptionOverrides | undefined;
  onChange: (overrides: AssumptionOverrides | undefined) => void;
}

export function IncomeCard({ profileIncome, people, overrides, onChange }: IncomeCardProps) {
  const override = retirementIncomeOverride(overrides);
  const monthly = effectiveRetirementIncome(profileIncome.retirementMonthly, override);
  const taxable = effectiveRetirementTaxable(
    profileIncome.retirementIncomeTaxable,
    retirementTaxableOverride(overrides),
  );
  const lines = workingIncomeLines(profileIncome, people);

  return (
    <div className="card">
      <h2 style={{ marginTop: 0 }}>
        Income
        <InfoTip label="income" text={CARD_TIP} />
      </h2>
      <div className="pair-grid">
        <div className="pair-head">While working</div>
        <div className="pair-head">
          After you stop working
          <InfoTip label="income after you stop working" text={RETIREMENT_TIP} align="end" />
        </div>

        <div className="pair-cell">
          <div className="pair-readonly">
            {lines.map((line) => (
              <div className="pair-readonly-line" key={line.label}>
                <span>{line.label}</span>
                <span>{formatUSD(line.amount)}/yr</span>
              </div>
            ))}
          </div>
          <span className="pair-note">
            from your profile
            <InfoTip label="the working income" text={WORKING_TIP} />
          </span>
        </div>

        <div className="pair-cell">
          <MoneyBox
            value={override}
            placeholder={retirementIncomePlaceholder(profileIncome.retirementMonthly)}
            label="Income after you stop working ($/mo)"
            onCommit={(v) => onChange(setRetirementIncomeOverride(overrides, v))}
          />
          <span className="pair-note">
            {formatUSD(monthly)}/mo · {formatUSD(monthly * 12)}/yr
          </span>
          <select
            value={taxable ? 'taxable' : 'not_taxable'}
            aria-label="Is that income taxable?"
            onChange={(e) =>
              onChange(
                setRetirementTaxableChoice(
                  overrides,
                  profileIncome.retirementIncomeTaxable,
                  e.target.value === 'taxable',
                ),
              )
            }
          >
            <option value="taxable">Taxable (ordinary income)</option>
            <option value="not_taxable">Not taxable</option>
          </select>
          <span className="pair-note">
            {taxable ? 'raises AGI, and every MAGI test with it' : 'raises no AGI and no MAGI'}
            <InfoTip label="taxable or not" text={TAXABLE_TIP} align="end" />
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

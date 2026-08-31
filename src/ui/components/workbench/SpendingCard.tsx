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
import type {
  AssumptionOverrides,
  LifeInsurancePolicy,
  LifeInsurancePolicyPlan,
  ProfileExpenses,
  ScenarioEvent,
} from '../../../shared/types';
import { deriveExpenseStreams } from '../../../shared/expenses';
import { formatUSD } from '../../../shared/util';
import { InfoTip, MonthField } from '../profile/fields';
import { parseNumber } from '../scenarios/scenarioHelpers';
import {
  TERM_END_PLACEHOLDER,
  coverageBands,
  coverageCaption,
  householdWorkStopMonth,
  policyMoneyOverride,
  policyPlanOptions,
  policyPlanOverride,
  policyRowSummary,
  setPolicyMoneyOverride,
  setPolicyPlanOverride,
  setTermEndOverride,
  termEndOverride,
  workStopText,
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

const POLICY_TIP =
  'Term life, as a plan-level what-if. The Profile holds the policy you actually have; these ' +
  'three boxes try a different one on THIS plan only, which is the only way to compare “keep it ” ' +
  'against “drop it” — a single profile figure can hold one answer, and the question needs two. ' +
  'Clearing a box hands the field back to the profile.';

const POLICY_LIST_TIP =
  'The policies the household actually holds live on the Insurance page; each row here decides what ' +
  'THIS PLAN does with one of them — keep it to its own term, cancel it when the paychecks ' +
  'stop, or cancel it now. “As configured” hands the decision back to the profile, so an ' +
  'untouched row writes nothing into the plan. Comparing “keep” against “cancel” is what the ' +
  'Widow tab is for: the premium drags the household score a little, and the payout only ever ' +
  'appears in a run containing a death.';

const POLICY_PLAN_ROW_TIP =
  '“Cancel when work stops” ends premium AND cover with the household’s last paycheck — a ' +
  'cancelled policy pays nothing, so you cannot keep the cheque and drop the bill. “Cancel now” ' +
  'takes the policy out of the plan entirely, from the first month. Either way the saving is ' +
  'the premium and the cost is the cover, and the Widow tab prices that trade.';

const PREMIUM_TIP =
  'What the policy costs, per month in today’s dollars. It is charged like any other expense ' +
  'and stops the moment nobody earns a salary — prorated in the retirement year — because term ' +
  'life is income replacement. Make sure it is NOT also inside your living figure above, or it ' +
  'is paid for twice.';

const BENEFIT_TIP =
  'The face amount paid to the survivor, in NOMINAL dollars: level term does not inflate, so a ' +
  '$1,000,000 policy is worth $1,000,000 whenever it pays and steadily less in real terms the ' +
  'later that is. It is not taxable income (IRC 101(a)(1)) and lands in savings. It only ever ' +
  'appears in a run containing a death — the household score never sees it, which is precisely ' +
  'why it needs the Widow tab to be worth anything on screen.';

const TERM_END_TIP =
  'The last month of coverage. LEAVE IT EMPTY and cover ends when the paychecks do, which is ' +
  'the model’s default reading of term life as income replacement — not “for life”. Setting a ' +
  'date is how to ask the actual question: five years of term from retirement, dropped after, ' +
  'and is the survivor’s score still acceptable on the far side of it? On the Widow chart the year the ' +
  'coverage lapses is the year the two lines merge.';

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
  /**
   * The plan's events and the profile's salaries, for the one date the policy
   * rows must state rather than guess: the month the household's last paycheck
   * stops, which is when a cancel-at-retirement disposition bites.
   */
  events: readonly ScenarioEvent[];
  salaries: Record<string, number>;
  /** id -> display name, so a two-insured caption can say whose death pays. */
  personNames: Record<string, string>;
  overrides: AssumptionOverrides | undefined;
  onChange: (overrides: AssumptionOverrides | undefined) => void;
}

export function SpendingCard({
  profileExpenses,
  events,
  salaries,
  personNames,
  overrides,
  onChange,
}: SpendingCardProps) {
  const policies = profileExpenses.lifeInsurancePolicies ?? [];
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
      {/*
        Which life-insurance UI a profile gets follows the ENGINE's own rule
        (resolvePolicies): a non-empty policy list supersedes the single-policy
        fields entirely, so showing the three legacy boxes to a profile with a
        list would be offering knobs wired to nothing — which is the exact bug
        this split fixes.
      */}
      {policies.length > 0 ? (
        <PolicyListBlock
          policies={policies}
          events={events}
          salaries={salaries}
          personNames={personNames}
          overrides={overrides}
          onChange={onChange}
        />
      ) : (
        <PolicyBlock
          profileExpenses={profileExpenses}
          overrides={overrides}
          onChange={onChange}
        />
      )}
    </div>
  );
}

/**
 * One row per profile policy, each with a three-way disposition — the
 * replacement for the legacy three-box override, FOR PROFILES WITH A POLICY
 * LIST. The legacy boxes write fields the engine ignores whenever the list is
 * non-empty (resolvePolicies gives the list total precedence), so for this
 * household they were three live-looking inputs that changed nothing, under a
 * caption that was false about the plan. Each row here writes
 * `assumption_overrides.expenses.lifeInsurancePolicyPlans[policy.id]`, which
 * the engine applies per policy — and "As configured" clears the entry, so an
 * untouched section leaves the plan file without the key at all, like every
 * other override on this card.
 */
function PolicyListBlock({
  policies,
  events,
  salaries,
  personNames,
  overrides,
  onChange,
}: {
  policies: readonly LifeInsurancePolicy[];
  events: readonly ScenarioEvent[];
  salaries: Record<string, number>;
  personNames: Record<string, string>;
  overrides: AssumptionOverrides | undefined;
  onChange: (overrides: AssumptionOverrides | undefined) => void;
}) {
  const stopMonth = householdWorkStopMonth(events, salaries);
  const hasEarner = Object.values(salaries).some((s) => s > 0);
  const plans = overrides?.expenses?.lifeInsurancePolicyPlans;

  // Bands are computed PER INSURED LIFE: a $2.5M policy on one life plus $1M on the other
  // is never a $3.5M payout, because only one of them can be the one who died.
  const insureds = [...new Set(policies.map((p) => p.insured))];
  const captions = insureds.map((insured) => {
    const bands = coverageBands(
      policies.filter((p) => p.insured === insured),
      plans,
      stopMonth,
      hasEarner,
    );
    return { insured, text: coverageCaption(bands) };
  });

  return (
    <div style={{ marginTop: 14, paddingTop: 12, borderTop: '1px solid var(--border)' }}>
      <div className="pair-head" style={{ marginBottom: 6 }}>
        Life insurance
        <InfoTip label="life insurance in this plan" text={POLICY_LIST_TIP} />
      </div>
      {policies.map((policy) => {
        const current = policyPlanOverride(overrides, policy.id);
        const options = policyPlanOptions(policy, stopMonth, current);
        return (
          <div key={policy.id} style={{ marginBottom: 8 }}>
            <div className="row" style={{ alignItems: 'baseline' }}>
              <label className="field" style={{ minWidth: 280 }}>
                <span className="field-label">
                  {policy.label}
                  <InfoTip label={`what this plan does with ${policy.label}`} text={POLICY_PLAN_ROW_TIP} />
                </span>
                <select
                  aria-label={`${policy.label} in this plan`}
                  value={current ?? ''}
                  onChange={(e) =>
                    onChange(
                      setPolicyPlanOverride(
                        overrides,
                        policy.id,
                        e.target.value === ''
                          ? undefined
                          : (e.target.value as LifeInsurancePolicyPlan),
                      ),
                    )
                  }
                >
                  {options.map((o) => (
                    <option key={o.value || 'as_configured'} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </label>
              <span className="field-note muted">{policyRowSummary(policy)}</span>
            </div>
            {current !== undefined && (
              <span className="pair-status">
                <span className="badge">overridden</span> profile:{' '}
                {policy.cancelAtRetirement === true
                  ? `cancelled when work stops (${workStopText(stopMonth)})`
                  : policy.termEnd !== undefined
                    ? `runs to ${policy.termEnd}`
                    : 'no term end'}{' '}
                —{' '}
                <button
                  type="button"
                  className="link-button"
                  onClick={() => onChange(setPolicyPlanOverride(overrides, policy.id, undefined))}
                >
                  reset
                </button>
              </span>
            )}
          </div>
        );
      })}
      <div className="field-help" style={{ marginTop: 2 }}>
        {captions.map(({ insured, text }) => (
          <div key={insured}>
            {captions.length > 1 ? `${personNames[insured] ?? insured}: ` : ''}
            {text}
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * LIFE INSURANCE, as a plan-level what-if — THE LEGACY SINGLE-POLICY FORM,
 * shown ONLY to profiles still on the single-policy fields. A profile with a
 * policy list gets PolicyListBlock above instead, because the engine ignores
 * these three fields entirely the moment `lifeInsurancePolicies` is non-empty
 * (resolvePolicies) — rendering this block for such a profile is exactly the
 * three-inert-inputs bug the split exists to fix.
 *
 * WHY IT IS HERE AND ALSO ON THE PROFILE. The policy the household actually
 * holds is a fact about the household and lives on the Profile beside the
 * premium, exactly like every other standing number. But "five years of term at
 * retirement, then drop it" is a QUESTION ABOUT A PLAN — and the whole reason to
 * ask it is to compare two answers, which a single profile figure cannot hold.
 * So the three fields are overridable here on the same terms as spending:
 * placeholder shows the profile's answer, a number overrides it for THIS plan
 * only, and clearing the box undoes the what-if without touching profile.json.
 *
 * It sits outside the pair grid because it does not have the grid's shape.
 * Premium is a working/after-work pair (it stops with the paycheck); a face
 * amount and a term end are neither.
 *
 * WHAT IT COSTS AND WHAT IT BUYS ARE BOTH REAL. The premium is charged against
 * the plan like any other expense, so it drags the household score; the benefit
 * only ever appears in a run containing a death. That asymmetry is exactly why
 * the Widow tab compares the plan against itself with the policy dropped — the
 * premium is a certain cost and the payout is a contingent one, and the two can
 * only be weighed against each other on the survivor's number.
 */
function PolicyBlock({
  profileExpenses,
  overrides,
  onChange,
}: {
  profileExpenses: ProfileExpenses;
  overrides: AssumptionOverrides | undefined;
  onChange: (overrides: AssumptionOverrides | undefined) => void;
}) {
  const premium = policyMoneyOverride(overrides, 'lifeInsuranceMonthly');
  const benefit = policyMoneyOverride(overrides, 'lifeInsuranceDeathBenefit');
  const termEnd = termEndOverride(overrides);

  const effectiveBenefit = benefit ?? profileExpenses.lifeInsuranceDeathBenefit ?? 0;
  const effectiveTermEnd = termEnd ?? profileExpenses.lifeInsuranceTermEnd;

  return (
    <div style={{ marginTop: 14, paddingTop: 12, borderTop: '1px solid var(--border)' }}>
      <div className="pair-head" style={{ marginBottom: 6 }}>
        Life insurance
        <InfoTip label="life insurance in this plan" text={POLICY_TIP} />
      </div>
      <div className="row">
        <label className="field" style={{ width: 150 }}>
          <span className="field-label">
            Premium ($/mo)
            <InfoTip label="the premium" text={PREMIUM_TIP} />
          </span>
          <MoneyBox
            value={premium}
            placeholder={String(profileExpenses.lifeInsuranceMonthly ?? 0)}
            onCommit={(v) =>
              onChange(setPolicyMoneyOverride(overrides, 'lifeInsuranceMonthly', v))
            }
          />
        </label>
        <label className="field" style={{ width: 170 }}>
          <span className="field-label">
            Death benefit ($)
            <InfoTip label="the death benefit" text={BENEFIT_TIP} />
          </span>
          <MoneyBox
            value={benefit}
            placeholder={String(profileExpenses.lifeInsuranceDeathBenefit ?? 0)}
            onCommit={(v) =>
              onChange(setPolicyMoneyOverride(overrides, 'lifeInsuranceDeathBenefit', v))
            }
          />
        </label>
        <MonthField
          label="Coverage ends"
          value={termEnd}
          tip={TERM_END_TIP}
          onCommit={(v) => onChange(setTermEndOverride(overrides, v))}
        />
      </div>
      {/*
        Both branches name their subject — the LEGACY single-policy override —
        because this caption once made a plain claim about "this plan" that was
        false for any profile whose policy list superseded these fields. The
        block is no longer rendered for such profiles, but the caption stays
        scoped so it can never overclaim again if the render condition drifts.
      */}
      <div className="field-help" style={{ marginTop: 2 }}>
        {effectiveBenefit > 0
          ? `The legacy single-policy override: this plan pays ${formatUSD(effectiveBenefit)} if ` +
            `the insured dies ${
              effectiveTermEnd ? `on or before ${effectiveTermEnd}` : 'while still working'
            } — tax-free, straight into savings. See the Widow tab for what it is worth.`
          : 'These boxes are the legacy single-policy override, and it is empty: ' +
            `${TERM_END_PLACEHOLDER} and the benefit is zero, so the premium buys nothing the ` +
            'model can see. Set a benefit to make the Widow tab’s comparison mean something.'}
      </div>
      {/* Silent unless something IS overridden — three empty status lines under
          three untouched boxes would be three lines of nothing. */}
      {(premium !== undefined || benefit !== undefined || termEnd !== undefined) && (
        <div className="row" style={{ marginTop: 4 }}>
          <OverrideStatus
            override={premium}
            profileText={`premium ${formatUSD(profileExpenses.lifeInsuranceMonthly ?? 0)}/mo`}
            onReset={() =>
              onChange(setPolicyMoneyOverride(overrides, 'lifeInsuranceMonthly', undefined))
            }
          />
          <OverrideStatus
            override={benefit}
            profileText={`benefit ${formatUSD(profileExpenses.lifeInsuranceDeathBenefit ?? 0)}`}
            onReset={() =>
              onChange(setPolicyMoneyOverride(overrides, 'lifeInsuranceDeathBenefit', undefined))
            }
          />
          <OverrideStatus
            override={termEnd}
            profileText={`ends ${profileExpenses.lifeInsuranceTermEnd ?? TERM_END_PLACEHOLDER}`}
            onReset={() => onChange(setTermEndOverride(overrides, undefined))}
          />
        </div>
      )}
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
function OverrideStatus({
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
function MoneyBox({
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

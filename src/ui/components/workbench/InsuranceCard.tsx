/**
 * Life insurance, in the plan — its own fold (the owner's relocation,
 * 2026-08-31; it used to render at the bottom of the Spending card, under a
 * divider and its own sub-heading, which the fold header now replaces).
 *
 * Which UI a profile gets follows the ENGINE's own rule (resolvePolicies): a
 * non-empty policy list supersedes the legacy single-policy fields entirely,
 * so showing the three legacy boxes to a profile with a list would be
 * offering knobs wired to nothing — the exact bug the list/legacy split
 * exists to fix.
 *
 * WHAT IT COSTS AND WHAT IT BUYS ARE BOTH REAL. The premium is charged
 * against the plan like any other expense, so it drags the household score;
 * the benefit only ever appears in a run containing a death. That asymmetry
 * is exactly why the Widow tab compares the plan against itself with the
 * policy dropped — the premium is a certain cost and the payout a contingent
 * one, and the two can only be weighed on the survivor's number.
 */
import type {
  AssumptionOverrides,
  LifeInsurancePolicy,
  LifeInsurancePolicyPlan,
  ProfileExpenses,
  ScenarioEvent,
} from '../../../shared/types';
import { formatUSD } from '../../../shared/util';
import { InfoTip, MonthField } from '../profile/fields';
import { MoneyBox, OverrideStatus } from './SpendingCard';
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
} from './workbenchLogic';

/** The section-header tip (ScenarioPanel renders it beside the fold). */
export const INSURANCE_CARD_TIP =
  'The policies the household actually holds live on the Insurance page; this fold decides what ' +
  'THIS PLAN does with them — keep one to its own term, cancel it when the paychecks stop, or ' +
  'cancel it now. “As configured” hands the decision back to the profile, so an untouched ' +
  'control writes nothing into the plan. (A profile still on the legacy single-policy fields ' +
  'gets three what-if boxes here instead of per-policy rows.) Comparing “keep” against ' +
  '“cancel” is what the Widow tab is for: the premium drags the household score a little, and ' +
  'the payout only ever appears in a run containing a death.';

const POLICY_PLAN_ROW_TIP =
  '“Cancel when work stops” ends premium AND cover with the household’s last paycheck — a ' +
  'cancelled policy pays nothing, so you cannot keep the cheque and drop the bill. “Cancel now” ' +
  'takes the policy out of the plan entirely, from the first month. Either way the saving is ' +
  'the premium and the cost is the cover, and the Widow tab prices that trade.';

const POLICY_TIP =
  'Term life, as a plan-level what-if. The Profile holds the policy you actually have; these ' +
  'three boxes try a different one on THIS plan only, which is the only way to compare “keep it ” ' +
  'against “drop it” — a single profile figure can hold one answer, and the question needs two. ' +
  'Clearing a box hands the field back to the profile.';

const PREMIUM_TIP =
  'What the policy costs, per month in today’s dollars. It is charged like any other expense ' +
  'and stops the moment nobody earns a salary — prorated in the retirement year — because term ' +
  'life is income replacement. Make sure it is NOT also inside the Spending section’s living ' +
  'figure, or it is paid for twice.';

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

export interface InsuranceCardProps {
  /** The household baseline: the policy list, or the legacy single-policy fields. */
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

export function InsuranceCard({
  profileExpenses,
  events,
  salaries,
  personNames,
  overrides,
  onChange,
}: InsuranceCardProps) {
  const policies = profileExpenses.lifeInsurancePolicies ?? [];
  return (
    <div className="card">
      {/* No heading: the section header names this card (ScenarioPanel
          carries its tip). */}
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
    <div>
      {policies.map((policy) => {
        const current = policyPlanOverride(overrides, policy.id);
        const options = policyPlanOptions(policy, stopMonth, current);
        return (
          <div key={policy.id} style={{ marginBottom: 8 }}>
            <div className="row">
              {/*
                The premium/benefit/term summary lives UNDER the select as its
                help line, not in a field-note beside it: on this panel's width
                the note wrapped below the select with its whole
                control-alignment shim showing as a blank gap (the owner's
                life-insurance screenshot, 2026-08-31 — the same disease the
                Tithing panel's giving note had).
              */}
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
                <span className="field-help">{policyRowSummary(policy)}</span>
              </label>
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
    <div>
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
        <InfoTip label="life insurance as a what-if" text={POLICY_TIP} />
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

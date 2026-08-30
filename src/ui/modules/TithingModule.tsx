/**
 * Tithing — giving while working (the charitable budget lines) and the two
 * after-the-last-paycheck decisions: the un-tithed pot, and how to tithe
 * going forward. Bound to the profile itself, so the plan's overrides on
 * the Workbench's Tithing tab are visibly overrides OF these answers.
 */
import { deriveExpenseStreams } from '../../shared/expenses';
import { potIsEnabled } from '../../shared/giving';
import { formatUSD } from '../../shared/util';
import { GivingLines } from '../components/profile/BudgetCard';
import { CheckboxField, InfoTip } from '../components/profile/fields';
import { annualFromMonthly } from '../components/profile/profileLogic';
import { OngoingGivingEditor, PotFields } from '../components/workbench/TithingCard';
import {
  DEFAULT_GIVING_RULE,
  DEFAULT_NEW_POT,
  effectiveGivingRule,
  potHelp,
} from '../components/workbench/workbenchLogic';
import { ProfileFormModule } from './ProfileFormModule';

const GIVING_RULE_HELP =
  'The household default. The plan can override it on the Workbench’s Tithing tab ' +
  'without changing this answer.';

const POT_PROFILE_HELP =
  'The household default for the pot. The plan can override it — or switch it off for one ' +
  'what-if — on the Workbench’s Tithing tab without changing this answer.';

export function TithingModule() {
  return (
    <ProfileFormModule title="Tithing">
      {(draft, doc) => {
        /**
         * Giving while working, as the plan will actually run it: summed from
         * the rows when the budget is itemised, the scalar otherwise. The
         * Tithing rule prices "same as working" off this, and reading the
         * scalar cache instead would quote a figure the rows have already
         * replaced.
         */
        const givingMonthly = deriveExpenseStreams(draft.expenses).charitableMonthly;
        /**
         * Whether the budget is itemised — the intro has to say where giving
         * is EDITED, and that is the lines below it only once lines exist;
         * before that it is the scalar stream on the Expenses page.
         */
        const itemised = (draft.expenses.lines ?? []).length > 0;
        return (
          <div className="card">
            <h2 style={{ marginTop: 0 }}>Tithing</h2>
            <p className="muted" style={{ marginTop: 0 }}>
              {itemised
                ? `Giving while anyone is still earning is the lines below — ${formatUSD(
                    givingMonthly,
                  )}/mo (${formatUSD(annualFromMonthly(givingMonthly))}/yr) at the moment. What ` +
                  'happens after the last paycheck is TWO decisions, set underneath them: the ' +
                  'un-tithed pot, and how to tithe going forward.'
                : `Giving while anyone is still earning is a budget stream — it is edited on the ` +
                  `Expenses page, and it currently runs at ${formatUSD(givingMonthly)}/mo ` +
                  `(${formatUSD(annualFromMonthly(givingMonthly))}/yr). What happens to it after ` +
                  'the last paycheck is TWO decisions: the un-tithed pot, and how to tithe ' +
                  'going forward.'}
            </p>
            {/* The charitable budget lines — nothing before itemisation; the
                paragraph above already points at the Expenses page then. */}
            <GivingLines expenses={draft.expenses} update={doc.update} />
            {/*
              The two decisions, same sections and same field components as
              the Workbench's Tithing tab — bound here to the profile itself,
              so the plan's overrides there are visibly overrides OF these
              answers.
            */}
            <div className="pair-head" style={{ marginTop: 14, marginBottom: 6 }}>
              The un-tithed pot
              <InfoTip
                label="the un-tithed pot"
                text={potHelp(
                  potIsEnabled(draft.expenses.untithedPot) ? draft.expenses.untithedPot : undefined,
                )}
              />
            </div>
            <CheckboxField
              label="Set aside an un-tithed pot at retirement"
              checked={potIsEnabled(draft.expenses.untithedPot)}
              onChange={(on) =>
                doc.update((p) => {
                  // The PROFILE spells "no pot" by absence — the explicit
                  // { enabled: false } form exists for plan overrides,
                  // where absence means "inherit" instead.
                  if (on) p.expenses.untithedPot = { ...DEFAULT_NEW_POT };
                  else delete p.expenses.untithedPot;
                })
              }
            />
            {potIsEnabled(draft.expenses.untithedPot) && (
              <PotFields
                pot={draft.expenses.untithedPot}
                onChange={(pot) =>
                  doc.update((p) => {
                    p.expenses.untithedPot = pot;
                  })
                }
              />
            )}
            <div className="field-help">{POT_PROFILE_HELP}</div>
            <div
              className="pair-head"
              style={{
                marginTop: 14,
                paddingTop: 12,
                borderTop: '1px solid var(--border)',
                marginBottom: 6,
              }}
            >
              Tithing going forward
            </div>
            <OngoingGivingEditor
              key={(draft.expenses.retirementGiving ?? DEFAULT_GIVING_RULE).type}
              rule={effectiveGivingRule(draft.expenses.retirementGiving, undefined)}
              charitableMonthly={givingMonthly}
              hasPot={potIsEnabled(draft.expenses.untithedPot)}
              status={GIVING_RULE_HELP}
              onChange={(rule) =>
                doc.update((p) => {
                  // 'continue' is what an absent field already means; writing it
                  // out would only add noise to profile.json.
                  if (rule.type === 'continue') delete p.expenses.retirementGiving;
                  else p.expenses.retirementGiving = rule;
                })
              }
            />
            <div className="field-help">
              The rule takes over in the first year nobody is working — the same signal that
              switches the living and investing streams. The retirement year itself is split: the
              paycheck stream for the months worked, the rule for the rest. Whatever is given in
              cash still feeds the charitable tax deductions.
            </div>
          </div>
        );
      }}
    </ProfileFormModule>
  );
}

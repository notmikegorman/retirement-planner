/**
 * Tithing — two tabs (the owner's split, 2026-08-30): WHILE WORKING holds the
 * giving figures (GivingFields — one field per charitable line; the model
 * reads only their monthly total); GOING FORWARD holds the two
 * after-the-last-paycheck decisions — the un-tithed pot, and how to tithe
 * from then on. Bound to the profile itself, so the plan's overrides on the
 * Plan page's Tithing tab are visibly overrides OF these answers.
 *
 * The tab is LOCAL state, deliberately not in the URL: these are two halves of
 * one editing surface (both write the same draft, one Save commits both) —
 * TabStrip.tsx carries the rule.
 */
import { useState } from 'react';
import { deriveExpenseStreams } from '../../shared/expenses';
import { potIsEnabled } from '../../shared/giving';
import { GivingFields } from '../components/profile/BudgetCard';
import { CheckboxField, InfoTip } from '../components/profile/fields';
import { OngoingGivingEditor, PotFields } from '../components/workbench/TithingCard';
import {
  DEFAULT_GIVING_RULE,
  DEFAULT_NEW_POT,
  effectiveGivingRule,
  potHelp,
} from '../components/workbench/workbenchLogic';
import { IntroModal } from './IntroModal';
import { ProfileFormModule } from './ProfileFormModule';
import { TabPanel, TabStrip } from './TabStrip';

const GIVING_RULE_HELP =
  'The household default. The plan can override it on the Plan page’s Tithing tab ' +
  'without changing this answer.';

const POT_PROFILE_HELP =
  'The household default for the pot. The plan can override it — or switch it off for one ' +
  'what-if — on the Plan page’s Tithing tab without changing this answer.';

/**
 * The today's-dollars ground rule used to sit as a preamble over the giving
 * table; the owner moved it into the first-visit modal (2026-08-30), same
 * as the Expenses table's. IntroModal.tsx carries the modal rules.
 */
const INTRO_SEEN_KEY = 'fplan-tithing-intro-seen';

const TITHING_TABS = [
  { id: 'working', label: 'While working' },
  { id: 'forward', label: 'Going forward' },
] as const;

type TithingTabId = (typeof TITHING_TABS)[number]['id'];

export function TithingModule() {
  const [tab, setTab] = useState<TithingTabId>('working');

  return (
    <ProfileFormModule
      title="Tithing"
      tabs={
        <TabStrip
          idPrefix="tithing"
          label="Tithing views"
          tabs={TITHING_TABS}
          active={tab}
          onSelect={setTab}
        />
      }
      /*
        Outside the fieldset (its button must work in view mode), like the
        Expenses table's intro. The rule it states covers every giving
        figure, itemised or not, so it is not gated on the budget's shape.
      */
      after={
        <IntroModal title="About these figures" storageKey={INTRO_SEEN_KEY}>
          <p>
            Every figure is $/month in <strong>today’s dollars</strong> — the plan inflates them
            itself, so never type a future number.
          </p>
        </IntroModal>
      }
    >
      {(draft, doc) => {
        /**
         * Giving while working, as the plan will actually run it: summed from
         * the rows when the budget is itemised, the scalar otherwise. The
         * Tithing rule prices "same as working" off this, and reading the
         * scalar cache instead would quote a figure the rows have already
         * replaced.
         */
        const givingMonthly = deriveExpenseStreams(draft.expenses).charitableMonthly;
        return (
          <TabPanel idPrefix="tithing" tab={tab}>
            {tab === 'working' && <GivingFields expenses={draft.expenses} update={doc.update} />}
            {tab === 'forward' && (
              <div className="card">
                {/* The two decisions, same sections and same field components
                    as the Workbench's Tithing tab — bound here to the profile
                    itself. */}
                <div className="pair-head" style={{ marginTop: 0, marginBottom: 6 }}>
                  The un-tithed pot
                  <InfoTip
                    label="the un-tithed pot"
                    text={potHelp(
                      potIsEnabled(draft.expenses.untithedPot)
                        ? draft.expenses.untithedPot
                        : undefined,
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
                      // 'continue' is what an absent field already means; writing
                      // it out would only add noise to profile.json.
                      if (rule.type === 'continue') delete p.expenses.retirementGiving;
                      else p.expenses.retirementGiving = rule;
                    })
                  }
                />
                <div className="field-help">
                  The rule takes over in the first year nobody is working — the same signal that
                  switches the living and investing streams. The retirement year itself is split:
                  the paycheck stream for the months worked, the rule for the rest. Whatever is
                  given in cash still feeds the charitable tax deductions.
                </div>
              </div>
            )}
          </TabPanel>
        );
      }}
    </ProfileFormModule>
  );
}

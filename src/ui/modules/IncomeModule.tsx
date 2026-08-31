/**
 * Income — two tabs (the owner's split, 2026-08-30): CURRENT holds the
 * salaries while working and the 401(k) flows they feed; AFTER RETIREMENT
 * holds the household's expected income once the last paycheck stops. One
 * editing surface — both tabs write the same draft, one Save commits both.
 */
import { useState } from 'react';
import { formatUSD } from '../../shared/util';
import { FieldNote, NumberField } from '../components/profile/fields';
import { annualFromMonthly } from '../components/profile/profileLogic';
import { ProfileFormModule } from './ProfileFormModule';
import { TabPanel, TabStrip, type TabDef } from './TabStrip';

const RETIREMENT_INCOME_HELP =
  'Recurring money you expect AFTER you stop working — part-time work, consulting, a rental, a ' +
  'pension — in today’s dollars per month. The mirror image of a salary: it starts in the first ' +
  'year nobody draws one, the retirement year is prorated by the months nobody worked, and it ' +
  'inflates with CPI and runs for life. Empty means none. The plan can override it on the Plan page, ' +
  'which is where “what if I consulted two days a week?” belongs.';
const INCOME_TABS: ReadonlyArray<TabDef<'current' | 'retirement'>> = [
  { id: 'current', label: 'Current' },
  { id: 'retirement', label: 'After Retirement' },
];

type IncomeTabId = (typeof INCOME_TABS)[number]['id'];

export function IncomeModule() {
  const [tab, setTab] = useState<IncomeTabId>('current');

  return (
    <ProfileFormModule
      title="Income"
      tabs={
        <TabStrip
          idPrefix="income"
          label="Income views"
          tabs={INCOME_TABS}
          active={tab}
          onSelect={setTab}
        />
      }
    >
      {(draft, doc) => (
        <TabPanel idPrefix="income" tab={tab}>
          {tab === 'current' && (
            <div className="card">
              <div className="row">
                {draft.people.map((person) => (
                  <NumberField
                    key={person.id}
                    label={`${person.name} salary ($/yr)`}
                    value={draft.income.salaries[person.id] ?? 0}
                    width={170}
                    onCommit={(v) =>
                      doc.update((p) => {
                        p.income.salaries[person.id] = v ?? 0;
                      })
                    }
                  />
                ))}
                <NumberField
                  label="401(k) employee contribution ($/yr)"
                  value={draft.income.contribution401k}
                  width={230}
                  help="Annual deferral while working — reduces taxable wages"
                  onCommit={(v) =>
                    doc.update((p) => {
                      p.income.contribution401k = v ?? 0;
                    })
                  }
                />
                <NumberField
                  label="Employer match ($/yr)"
                  value={draft.income.employerMatch401k}
                  width={160}
                  help="Goes into the 401(k), not wages"
                  onCommit={(v) =>
                    doc.update((p) => {
                      p.income.employerMatch401k = v ?? 0;
                    })
                  }
                />
              </div>
            </div>
          )}
          {tab === 'retirement' && (
            <div className="card">
              {/*
                The household's own baseline for what it expects to bring in
                after the salaries stop. Absent means none, so an empty box is
                left as an ABSENT field rather than a written 0 — that is what
                keeps profile.json quiet about defaults it never chose.
              */}
              <div className="row">
                <NumberField
                  label="Retirement income ($/mo)"
                  allowEmpty
                  placeholder="none"
                  value={draft.income.retirementMonthly}
                  width={190}
                  tip={RETIREMENT_INCOME_HELP}
                  onCommit={(v) =>
                    doc.update((p) => {
                      if (v == null) delete p.income.retirementMonthly;
                      else p.income.retirementMonthly = v;
                    })
                  }
                />
                <FieldNote className="muted">
                  = {formatUSD(annualFromMonthly(draft.income.retirementMonthly ?? 0))}/yr —
                  taxed as ordinary income
                </FieldNote>
              </div>
            </div>
          )}
        </TabPanel>
      )}
    </ProfileFormModule>
  );
}

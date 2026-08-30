/**
 * Income — salaries while working, the 401(k) flows they feed, and the
 * household's expected income after the last paycheck.
 */
import { formatUSD } from '../../shared/util';
import { CheckboxField, FieldNote, NumberField } from '../components/profile/fields';
import { annualFromMonthly } from '../components/profile/profileLogic';
import { ProfileFormModule } from './ProfileFormModule';

const RETIREMENT_INCOME_HELP =
  'Recurring money you expect AFTER you stop working — part-time work, consulting, a rental, a ' +
  'pension — in today’s dollars per month. The mirror image of a salary: it starts in the first ' +
  'year nobody draws one, the retirement year is prorated by the months nobody worked, and it ' +
  'inflates with CPI and runs for life. Empty means none. The Workbench can override it per plan, ' +
  'which is where “what if I consulted two days a week?” belongs.';
const RETIREMENT_INCOME_TAXABLE_HELP =
  'On by default, which is the honest answer for anything earned: it is ordinary income, so it ' +
  'raises AGI and every MAGI test with it (the ACA subsidy cliff, IRMAA, the taxability of Social ' +
  'Security). Switch it off only for money that is not income at all — a return of capital, a ' +
  'gift, a reimbursement. Simplification: taxable income here is plain ordinary income, not wages ' +
  '— no payroll tax, and the Social Security earnings test is not modeled (this household claims ' +
  'at 67, its full retirement age, where that test never applies).';

export function IncomeModule() {
  return (
    <ProfileFormModule title="Income">
      {(draft, doc) => (
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
          {/*
            The retired side of income: the household's own baseline for what it
            expects to bring in after the salaries stop. Absent means none, so
            an empty box is left as an ABSENT field rather than a written 0 —
            that is what keeps profile.json quiet about defaults it never chose.
          */}
          <h3>After you stop working</h3>
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
              = {formatUSD(annualFromMonthly(draft.income.retirementMonthly ?? 0))}/yr
            </FieldNote>
            <CheckboxField
              label="Taxable as ordinary income"
              checked={draft.income.retirementIncomeTaxable !== false}
              tip={RETIREMENT_INCOME_TAXABLE_HELP}
              onChange={(v) =>
                doc.update((p) => {
                  // true is what an absent field already means; writing it out
                  // would only add noise.
                  if (v) delete p.income.retirementIncomeTaxable;
                  else p.income.retirementIncomeTaxable = false;
                })
              }
            />
          </div>
        </div>
      )}
    </ProfileFormModule>
  );
}

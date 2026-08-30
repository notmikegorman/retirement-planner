/**
 * Health — the ACA benchmark quote and the Medicare inputs the simulation
 * prices coverage from.
 */
import { InfoTip, NumberField, PlaceholderChip, TextField } from '../components/profile/fields';
import { isPlaceholder } from '../components/profile/profileLogic';
import { ProfileFormModule } from './ProfileFormModule';

const ACA_INTRO =
  'The ACA marketplace (healthcare.gov) is where you buy your own health insurance when you no ' +
  'longer have employer coverage. This quote only matters if the plan retires BEFORE age 65: ' +
  'employer coverage runs until you retire, and Medicare takes over at 65.';
const ACA_STEPS =
  'How to get the number: go to healthcare.gov (or your state’s own marketplace, if it runs ' +
  'one), browse/estimate plans anonymously — no account needed — enter your county and both ' +
  'of your ages, then take the SECOND-lowest-cost Silver plan’s monthly ' +
  'premium for the household at full price, before any subsidies. The app computes the subsidy ' +
  'itself from your simulated income.';
const PART_D_HELP =
  'Your future Medicare drug-plan premium; about 45 dollars a month is typical.';
const EMPLOYER_SHARE_HELP =
  'Your share of the employer premium (pre-tax payroll deduction while working)';

export function HealthModule() {
  return (
    <ProfileFormModule title="Health">
      {(draft, doc) => (
        <div className="card">
          {/* No "Health" heading: the banner already says where you are. */}
          <p className="muted" style={{ marginTop: 0 }}>
            Only matters if the plan retires before 65 — employer coverage runs until you retire,
            Medicare takes over at 65.
            <InfoTip label="the health quote" text={ACA_INTRO} />
            <InfoTip label="how to get the ACA quote" text={ACA_STEPS} />
          </p>
          <div className="row">
            <NumberField
              label="ACA benchmark premium ($/mo)"
              value={draft.health.acaBenchmarkMonthly}
              width={200}
              tip="Second-lowest-cost Silver plan, household total, full price before subsidies — the app computes the subsidy itself from your simulated income."
              onCommit={(v) =>
                doc.update((p) => {
                  p.health.acaBenchmarkMonthly = v ?? 0;
                })
              }
            />
            <NumberField
              label="Quote year"
              int
              value={draft.health.acaQuoteYear}
              width={100}
              help="The plan year the quote is priced for"
              onCommit={(v) =>
                doc.update((p) => {
                  p.health.acaQuoteYear = v ?? draft.health.acaQuoteYear;
                })
              }
            />
            <NumberField
              label="Employee share of employer premium ($/mo)"
              value={draft.health.employerPremiumShareMonthly}
              width={250}
              tip={EMPLOYER_SHARE_HELP}
              onCommit={(v) =>
                doc.update((p) => {
                  p.health.employerPremiumShareMonthly = v ?? 0;
                })
              }
            />
            <NumberField
              label="Part D plan ($/mo per person)"
              value={draft.health.partDPlanMonthly}
              width={190}
              help={PART_D_HELP}
              onCommit={(v) =>
                doc.update((p) => {
                  p.health.partDPlanMonthly = v ?? 0;
                })
              }
            />
          </div>
          <TextField
            label="Notes (where this quote came from)"
            value={draft.health.notes ?? ''}
            width="full"
            onCommit={(v) =>
              doc.update((p) => {
                p.health.notes = v || undefined;
              })
            }
          />
          {draft.health.notes ? (
            <div className="muted" style={{ marginTop: 6 }}>
              {draft.health.notes}
              {isPlaceholder(draft.health.notes) ? (
                <>
                  {' '}
                  <PlaceholderChip />
                </>
              ) : null}
            </div>
          ) : null}
        </div>
      )}
    </ProfileFormModule>
  );
}

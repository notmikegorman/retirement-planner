/**
 * Household — who this plan is for: filing status, tax residency, and the
 * people with their Social Security inputs. One thing, so it shows that one
 * thing (view/edit form; the machinery is ProfileFormModule's).
 */
import {
  CheckboxField,
  FieldNote,
  InfoTip,
  NumberField,
  PlaceholderChip,
  SelectField,
  TextField,
} from '../components/profile/fields';
import { isPlaceholder } from '../components/profile/profileLogic';
import type { StateCode } from '../../shared/types';
import { MONTH_OPTIONS, STATE_OPTIONS } from './formOptions';
import { ProfileFormModule } from './ProfileFormModule';

const PIA_WORKING_HELP =
  'From your SSA statement (its estimates assume you keep working at your current salary).';
const PIA_STOPPING_HELP =
  'From ssa.gov’s estimator with average future annual salary set to 0.';
const PIA_SHARED_NOTE =
  'Enter only the full-retirement-age figure — the app derives the age-62 through age-70 ' +
  'amounts itself, and blends these two numbers based on the plan’s retirement date.';

export function HouseholdModule() {
  return (
    <ProfileFormModule title="Household">
      {(draft, doc) => (
        <>
          <div className="card">
            <h2 style={{ marginTop: 0 }}>Filing</h2>
            <div className="row">
              <label className="field" style={{ width: 170 }}>
                {/* Uses .field-label like every other field so the control lines up
                    with its neighbours (a bare text node skips the reserved height). */}
                <span className="field-label">Filing status</span>
                <input value="Married filing jointly" disabled />
              </label>
              <SelectField
                label="State (tax residency)"
                value={draft.filing.state}
                options={STATE_OPTIONS}
                width={170}
                help="Drives the state income-tax module (VA / SC / NC)"
                onChange={(v) =>
                  doc.update((p) => {
                    p.filing.state = v as StateCode;
                  })
                }
              />
            </div>
          </div>

          <div className="card">
            <h2 style={{ marginTop: 0 }}>People</h2>
            <div className="muted" style={{ marginBottom: 4 }}>
              Adding or removing people: edit via profile.json (v1 models exactly this household).
            </div>
            {draft.people.map((person, i) => (
              <div
                key={person.id}
                style={
                  i > 0
                    ? { borderTop: '1px solid var(--border)', paddingTop: 12, marginTop: 12 }
                    : undefined
                }
              >
                <div className="row">
                  <TextField
                    label="Name"
                    required
                    value={person.name}
                    width={180}
                    onCommit={(v) =>
                      doc.update((p) => {
                        p.people[i].name = v;
                      })
                    }
                  />
                  <NumberField
                    label="Birth year"
                    required
                    int
                    value={person.birthYear}
                    width={100}
                    onCommit={(v) =>
                      doc.update((p) => {
                        p.people[i].birthYear = v ?? person.birthYear;
                      })
                    }
                  />
                  <SelectField
                    label="Birth month"
                    value={String(person.birthMonth)}
                    options={MONTH_OPTIONS}
                    width={130}
                    onChange={(v) =>
                      doc.update((p) => {
                        p.people[i].birthMonth = Number(v);
                      })
                    }
                  />
                  <CheckboxField
                    label="Has own SS benefit (40 credits)"
                    checked={person.hasOwnBenefit}
                    onChange={(v) =>
                      doc.update((p) => {
                        p.people[i].hasOwnBenefit = v;
                      })
                    }
                  />
                  {isPlaceholder(person.notes) ? (
                    <FieldNote>
                      <PlaceholderChip />
                    </FieldNote>
                  ) : null}
                </div>
                <div className="row">
                  <NumberField
                    label="PIA at FRA if you work to 62 ($/mo)"
                    value={person.piaMonthlyAtFraIfWorkingTo62}
                    width={230}
                    tip={PIA_WORKING_HELP}
                    onCommit={(v) =>
                      doc.update((p) => {
                        p.people[i].piaMonthlyAtFraIfWorkingTo62 = v ?? 0;
                      })
                    }
                  />
                  <NumberField
                    label="PIA at FRA if you stop working now ($/mo)"
                    value={person.piaMonthlyAtFraIfStoppingNow}
                    width={250}
                    tip={PIA_STOPPING_HELP}
                    onCommit={(v) =>
                      doc.update((p) => {
                        p.people[i].piaMonthlyAtFraIfStoppingNow = v ?? 0;
                      })
                    }
                  />
                </div>
                <div className="field-help" style={{ marginTop: 4 }}>
                  Full-retirement-age figures only
                  <InfoTip label="the two PIA figures" text={PIA_SHARED_NOTE} />
                </div>
                <TextField
                  label="Notes"
                  value={person.notes ?? ''}
                  width="full"
                  onCommit={(v) =>
                    doc.update((p) => {
                      p.people[i].notes = v || undefined;
                    })
                  }
                />
              </div>
            ))}
          </div>
        </>
      )}
    </ProfileFormModule>
  );
}

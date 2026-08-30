/**
 * Home — the house the plan lives in: value, basis, carrying costs, and the
 * mortgage when there is one. One thing, shown as one thing.
 */
import type { StateCode } from '../../shared/types';
import { CheckboxField, NumberField, SelectField } from '../components/profile/fields';
import { makeDefaultMortgage } from '../components/profile/profileLogic';
import { MONTH_OPTIONS, STATE_OPTIONS } from './formOptions';
import { ProfileFormModule } from './ProfileFormModule';

export function HomeModule() {
  return (
    <ProfileFormModule title="Home">
      {(draft, doc) => (
        <div className="card">
          <div className="row">
            <NumberField
              label="Value ($)"
              value={draft.home.value}
              width={130}
              onCommit={(v) =>
                doc.update((p) => {
                  p.home.value = v ?? 0;
                })
              }
            />
            <NumberField
              label="Cost basis ($)"
              value={draft.home.costBasis}
              width={140}
              help="Purchase price + improvements (§121 exclusion)"
              onCommit={(v) =>
                doc.update((p) => {
                  p.home.costBasis = v ?? 0;
                })
              }
            />
            <SelectField
              label="State"
              value={draft.home.state}
              options={STATE_OPTIONS}
              width={150}
              onChange={(v) =>
                doc.update((p) => {
                  p.home.state = v as StateCode;
                })
              }
            />
            <NumberField
              label="Property tax ($/yr)"
              value={draft.home.propertyTaxAnnual}
              width={140}
              onCommit={(v) =>
                doc.update((p) => {
                  p.home.propertyTaxAnnual = v ?? 0;
                })
              }
            />
            <NumberField
              label="Insurance ($/yr)"
              value={draft.home.insuranceAnnual}
              width={130}
              onCommit={(v) =>
                doc.update((p) => {
                  p.home.insuranceAnnual = v ?? 0;
                })
              }
            />
            <NumberField
              label="Maintenance (% of value)"
              pct
              value={draft.home.maintenancePctOfValue}
              width={170}
              onCommit={(v) =>
                doc.update((p) => {
                  p.home.maintenancePctOfValue = v ?? 0;
                })
              }
            />
            <NumberField
              label="Selling cost (%)"
              pct
              value={draft.home.sellingCostPct}
              width={120}
              help="Agent fees etc."
              onCommit={(v) =>
                doc.update((p) => {
                  p.home.sellingCostPct = v ?? 0;
                })
              }
            />
          </div>
          <div className="row">
            <CheckboxField
              label="Has mortgage"
              checked={draft.home.mortgage != null}
              onChange={(v) =>
                doc.update((p) => {
                  p.home.mortgage = v
                    ? (p.home.mortgage ?? makeDefaultMortgage(new Date().getFullYear()))
                    : null;
                })
              }
            />
          </div>
          {draft.home.mortgage ? (
            <div className="row">
              <NumberField
                label="Original principal ($)"
                value={draft.home.mortgage.originalPrincipal}
                width={150}
                onCommit={(v) =>
                  doc.update((p) => {
                    if (p.home.mortgage) p.home.mortgage.originalPrincipal = v ?? 0;
                  })
                }
              />
              <NumberField
                label="Balance ($)"
                value={draft.home.mortgage.balance}
                width={130}
                onCommit={(v) =>
                  doc.update((p) => {
                    if (p.home.mortgage) p.home.mortgage.balance = v ?? 0;
                  })
                }
              />
              <NumberField
                label="Rate (%)"
                pct
                value={draft.home.mortgage.rate}
                width={100}
                onCommit={(v) =>
                  doc.update((p) => {
                    if (p.home.mortgage) p.home.mortgage.rate = v ?? 0;
                  })
                }
              />
              <NumberField
                label="Term (years)"
                int
                value={draft.home.mortgage.termYears}
                width={110}
                onCommit={(v) =>
                  doc.update((p) => {
                    if (p.home.mortgage) p.home.mortgage.termYears = v ?? 30;
                  })
                }
              />
              <NumberField
                label="Start year"
                int
                value={draft.home.mortgage.startYear}
                width={100}
                onCommit={(v) =>
                  doc.update((p) => {
                    if (p.home.mortgage) {
                      p.home.mortgage.startYear = v ?? p.home.mortgage.startYear;
                    }
                  })
                }
              />
              <SelectField
                label="Start month"
                value={String(draft.home.mortgage.startMonth)}
                options={MONTH_OPTIONS}
                width={130}
                onChange={(v) =>
                  doc.update((p) => {
                    if (p.home.mortgage) p.home.mortgage.startMonth = Number(v);
                  })
                }
              />
            </div>
          ) : null}
        </div>
      )}
    </ProfileFormModule>
  );
}

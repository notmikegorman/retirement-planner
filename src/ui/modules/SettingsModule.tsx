/**
 * Settings — how the simulation behaves (horizon, target, path counts,
 * spending and withdrawal policy), plus the data-folder card (which is
 * informational and lives OUTSIDE the view/edit form: its Switch storage
 * button is an action, not an edit).
 */
import type { SpendingPolicy, WithdrawalPolicy } from '../../shared/types';
import { DEFAULT_GUARDRAILS } from '../../shared/types';
import { InfoTip, NumberField, SelectField } from '../components/profile/fields';
import {
  BUCKET_LABELS,
  SPENDING_TYPE_OPTIONS,
  guardrailsOk,
  moveItem,
  normalizeSpendingPolicy,
  setGuardrail,
} from '../components/profile/profileLogic';
import { DataFolderCard } from '../components/profile/DataFolderCard';
import { themeModeLabel, useTheme, type ThemeMode } from '../theme';
import { PRETAX_OPTIONS } from './formOptions';
import { ProfileFormModule } from './ProfileFormModule';

const MC_PATHS_HELP =
  'How many alternate market futures to simulate — each is a possible sequence of returns and ' +
  'inflation drawn from 1928-2025 history. 1,000 for quick exploration, 10,000 for final answers.';
const TERMINAL_FLOOR_HELP =
  'Optional: also require at least this much (in today’s dollars) left at the horizon for a run ' +
  'to count as a success. Leave empty and success just means never running out.';
const SPENDING_POLICY_HELP =
  'Fixed real = your baseline spending, inflation-adjusted every year — the classic assumption ' +
  'and the one the Explore answers assume. Fixed percent = spend X% of the current portfolio ' +
  'each year, ' +
  'which rarely depletes but makes your lifestyle swing with the markets. Guardrails = fixed ' +
  'real UNTIL the withdrawal rate drifts outside a band around the one you started at, and only ' +
  'then a one-off cut or raise — which is what people actually do, and the reason it is neither ' +
  'of the other two: fixed real spends the same through a 40% crash, fixed percent moves your ' +
  'grocery budget every single year.';

const GUARDRAILS_HELP =
  'The rails are MULTIPLES of the withdrawal rate the plan started at, not percentages of the ' +
  'portfolio. Starting at 4%, the default 1.2 / 0.8 band means a cut when this year’s rate passes ' +
  '4.8% and a raise when it falls below 3.2%; in between nothing happens, which is the entire ' +
  'point. The adjustment is how big that one-off move is, and the floor is how far the cuts are ' +
  'allowed to grind real spending down in total — without one, a bad sequence can stack cuts until ' +
  'the plan “succeeds” on a standard of living nobody would accept. The ceiling is the same idea ' +
  'on the prosperity side: raises may not push real spending above it (100% = never spend above ' +
  'plan), and leaving it blank keeps the published rule’s unlimited raises.';
const PRETAX_PREFERENCE_HELP =
  'Which pre-tax account to tap first. IRA first drains the traditional IRA before any other ' +
  'pre-tax money; proportional splits withdrawals across them by balance.';

/**
 * The theme, as just another setting (owner's relocation, 2026-08-30 — it
 * used to be a sidebar toggle). OUTSIDE the view/edit form: it is a local
 * preference applied on change, not a profile field with a Save.
 */
function AppearanceCard() {
  const theme = useTheme();
  return (
    <div className="card">
      <h2 style={{ marginTop: 0 }}>Appearance</h2>
      <SelectField
        label="Theme"
        value={theme.mode}
        options={(['system', 'light', 'dark'] as ThemeMode[]).map((mode) => ({
          value: mode,
          label: themeModeLabel(mode),
        }))}
        width={170}
        onChange={(v) => theme.setMode(v as ThemeMode)}
      />
    </div>
  );
}

export function SettingsModule() {
  return (
    <ProfileFormModule
      title="Settings"
      after={
        <>
          <AppearanceCard />
          <DataFolderCard />
        </>
      }
    >
      {(draft, doc) => {
        const settings = draft.settings;
        const spending = settings.spendingPolicy;
        const order = settings.withdrawalPolicy.order;
        return (
          <div className="card">
            <div className="row">
              <NumberField
                label="Horizon age"
                int
                value={settings.horizonAge}
                width={100}
                tip="Simulate through the year you both reach this age. Money left at the horizon is the terminal balance the results report."
                onCommit={(v) =>
                  doc.update((p) => {
                    p.settings.horizonAge = v ?? settings.horizonAge;
                  })
                }
              />
              <NumberField
                label="Success target (%)"
                pct
                value={settings.successTarget}
                width={130}
                tip="The share of simulated futures you want to survive to the horizon. The verdict on the Workbench is measured against this number."
                onCommit={(v) =>
                  doc.update((p) => {
                    p.settings.successTarget = v ?? settings.successTarget;
                  })
                }
              />
              <NumberField
                label="MC paths (interactive)"
                int
                value={settings.mcPathsInteractive}
                width={150}
                tip={MC_PATHS_HELP}
                onCommit={(v) =>
                  doc.update((p) => {
                    p.settings.mcPathsInteractive = v ?? settings.mcPathsInteractive;
                  })
                }
              />
              <NumberField
                label="MC paths (final)"
                int
                value={settings.mcPathsFinal}
                width={130}
                tip="Path count used when you tick “final quality” in the Workbench run settings — slower, but the success percentage stops wobbling between runs."
                onCommit={(v) =>
                  doc.update((p) => {
                    p.settings.mcPathsFinal = v ?? settings.mcPathsFinal;
                  })
                }
              />
              <NumberField
                label="Seed"
                int
                value={settings.seed}
                width={110}
                help="Same seed + same inputs = identical results, every time"
                onCommit={(v) =>
                  doc.update((p) => {
                    p.settings.seed = v ?? settings.seed;
                  })
                }
              />
              <NumberField
                label="Terminal floor (real $)"
                allowEmpty
                value={settings.terminalFloorReal}
                width={190}
                tip={TERMINAL_FLOOR_HELP}
                onCommit={(v) =>
                  doc.update((p) => {
                    if (v == null) delete p.settings.terminalFloorReal;
                    else p.settings.terminalFloorReal = v;
                  })
                }
              />
            </div>

            <h3>Spending policy</h3>
            <div className="row">
              <SelectField
                label="Type"
                value={spending.type}
                options={SPENDING_TYPE_OPTIONS}
                width={230}
                tip={SPENDING_POLICY_HELP}
                onChange={(v) =>
                  doc.update((p) => {
                    p.settings.spendingPolicy = normalizeSpendingPolicy(
                      p.settings.spendingPolicy,
                      v as SpendingPolicy['type'],
                    );
                  })
                }
              />
              {spending.type === 'fixed_percent' ? (
                <NumberField
                  label="Percent of portfolio (%/yr)"
                  pct
                  value={spending.percent ?? 0.04}
                  width={170}
                  onCommit={(v) =>
                    doc.update((p) => {
                      p.settings.spendingPolicy.percent = v ?? 0.04;
                    })
                  }
                />
              ) : null}
            </div>
            {spending.type === 'guardrails' ? (
              <>
                <div className="field-help" style={{ marginTop: 6 }}>
                  Spending holds steady in real terms — like fixed real — and moves only when the
                  CURRENT withdrawal rate leaves the band around the rate the plan started at: above
                  the upper rail it is cut, below the lower rail it is raised, and in between
                  nothing happens at all. That last part is the whole difference from fixed
                  percent, which moves your grocery budget every year the market does.
                  <InfoTip label="the guardrail band" text={GUARDRAILS_HELP} />
                </div>
                <div className="row">
                  <NumberField
                    label="Upper rail (× starting rate)"
                    value={spending.guardrails?.upper ?? DEFAULT_GUARDRAILS.upper}
                    width={190}
                    help="1.2 = cut once the rate is 20% above where it started"
                    /*
                      An inverted band breaches both rails every year, and the
                      server's schema rejects it — better to say so on the field
                      than to fail the save with a zod message. (Field-shaped
                      errors render on the field; the banner is whole-form.)
                    */
                    error={
                      guardrailsOk(spending.guardrails) ? null : 'Must sit above the lower rail'
                    }
                    onCommit={(v) =>
                      doc.update((p) => {
                        setGuardrail(p.settings.spendingPolicy, 'upper', v);
                      })
                    }
                  />
                  <NumberField
                    label="Lower rail (× starting rate)"
                    value={spending.guardrails?.lower ?? DEFAULT_GUARDRAILS.lower}
                    width={190}
                    help="0.8 = raise once the rate is 20% below it"
                    onCommit={(v) =>
                      doc.update((p) => {
                        setGuardrail(p.settings.spendingPolicy, 'lower', v);
                      })
                    }
                  />
                  <NumberField
                    label="Adjustment (%)"
                    pct
                    value={spending.guardrails?.adjustment ?? DEFAULT_GUARDRAILS.adjustment}
                    width={140}
                    help="Size of the one-off cut or raise"
                    onCommit={(v) =>
                      doc.update((p) => {
                        setGuardrail(p.settings.spendingPolicy, 'adjustment', v);
                      })
                    }
                  />
                  <NumberField
                    label="Spending floor (% of plan)"
                    pct
                    allowEmpty
                    placeholder="no floor"
                    value={spending.guardrails?.floorFraction}
                    width={190}
                    help="Cuts may not grind real spending below this"
                    onCommit={(v) =>
                      doc.update((p) => {
                        setGuardrail(p.settings.spendingPolicy, 'floorFraction', v);
                      })
                    }
                  />
                  <NumberField
                    label="Spending ceiling (% of plan)"
                    pct
                    allowEmpty
                    placeholder="unlimited"
                    value={spending.guardrails?.raiseCeiling}
                    width={190}
                    help="Raises may not push real spending above this; 100 = never above plan"
                    onCommit={(v) =>
                      doc.update((p) => {
                        setGuardrail(p.settings.spendingPolicy, 'raiseCeiling', v);
                      })
                    }
                  />
                </div>
              </>
            ) : null}

            <h3>Withdrawal policy</h3>
            <div className="row" style={{ alignItems: 'flex-start' }}>
              <div>
                <div className="muted" style={{ marginBottom: 4 }}>
                  Buckets are tapped in this order
                </div>
                {order.map((bucket, i) => (
                  <div className="row inlineRow" key={bucket} style={{ marginBottom: 4 }}>
                    <span style={{ width: 170 }}>
                      {i + 1}. {BUCKET_LABELS[bucket]}
                    </span>
                    <button
                      disabled={i === 0}
                      title="Move up"
                      onClick={() =>
                        doc.update((p) => {
                          p.settings.withdrawalPolicy.order = moveItem(
                            p.settings.withdrawalPolicy.order,
                            i,
                            -1,
                          );
                        })
                      }
                    >
                      ↑
                    </button>
                    <button
                      disabled={i === order.length - 1}
                      title="Move down"
                      onClick={() =>
                        doc.update((p) => {
                          p.settings.withdrawalPolicy.order = moveItem(
                            p.settings.withdrawalPolicy.order,
                            i,
                            1,
                          );
                        })
                      }
                    >
                      ↓
                    </button>
                  </div>
                ))}
              </div>
              <SelectField
                label="Pre-tax preference"
                value={settings.withdrawalPolicy.pretaxPreference}
                options={PRETAX_OPTIONS}
                width={210}
                tip={PRETAX_PREFERENCE_HELP}
                onChange={(v) =>
                  doc.update((p) => {
                    p.settings.withdrawalPolicy.pretaxPreference =
                      v as WithdrawalPolicy['pretaxPreference'];
                  })
                }
              />
            </div>
          </div>
        );
      }}
    </ProfileFormModule>
  );
}

/**
 * Profile editor — the "update my IRA balance" screen (SPEC §9).
 * Loads profile.json into local state, tracks dirty, and writes back via
 * api.putProfile. Client-side checks are advisory only; the server's zod
 * validation is authoritative and its errors surface in the banner.
 */
import { useCallback, useEffect, useState } from 'react';
import type {
  HousingPlan,
  Profile,
  ScenarioEvent,
  SpendingPolicy,
  StateCode,
  WithdrawalPolicy,
} from '../../shared/types';
import { DEFAULT_GUARDRAILS } from '../../shared/types';
import { deriveExpenseStreams } from '../../shared/expenses';
import { formatUSD, stableStringify } from '../../shared/util';
import { api } from '../api';
import {
  PROFILE_TAB_IDS,
  PROFILE_TAB_STORAGE_KEY,
  resolveTab,
  writeStoredTab,
  type PageProps,
  type ProfileTabId,
} from '../nav';
import { useToast } from '../toast';
import {
  CheckboxField,
  FieldNote,
  InfoTip,
  NumberField,
  PlaceholderChip,
  SelectField,
  TextField,
} from '../components/profile/fields';
import { AccountsCard } from '../components/profile/AccountsCard';
import { BudgetCard, GivingLines, InvestingCard } from '../components/profile/BudgetCard';
import { InsuranceCard } from '../components/profile/InsuranceCard';
import { OngoingGivingEditor, PotFields } from '../components/workbench/TithingCard';
import {
  DEFAULT_GIVING_RULE,
  DEFAULT_NEW_POT,
  effectiveGivingRule,
  potHelp,
} from '../components/workbench/workbenchLogic';
import { potIsEnabled } from '../../shared/giving';
import { readPlan } from '../components/scenarios/scenarioHelpers';
import { rentingWindowFromPlan, workStopsMonth } from '../components/profile/expensesLogic';
import {
  BUCKET_LABELS,
  MONTH_NAMES,
  PRETAX_PREFERENCE_LABELS,
  SPENDING_TYPE_OPTIONS,
  STATE_LABELS,
  annualFromMonthly,
  guardrailsOk,
  isPlaceholder,
  makeDefaultMortgage,
  moveItem,
  normalizeSpendingPolicy,
  setGuardrail,
} from '../components/profile/profileLogic';

const STATE_OPTIONS = (Object.keys(STATE_LABELS) as StateCode[]).map((value) => ({
  value,
  label: STATE_LABELS[value],
}));
const MONTH_OPTIONS = MONTH_NAMES.map((name, i) => ({ value: String(i + 1), label: name }));
const PRETAX_OPTIONS = (
  Object.keys(PRETAX_PREFERENCE_LABELS) as WithdrawalPolicy['pretaxPreference'][]
).map((value) => ({ value, label: PRETAX_PREFERENCE_LABELS[value] }));

// --- Plain-English helper copy (notes 2, 3, 12, 13, 14) ---------------------
//
// Anything longer than a glance lives behind the "?" beside its label (the
// `tip` prop; see fields.tsx InfoTip) rather than as a permanent paragraph
// under the control. Genuinely short hints — "Agent fees etc.", "Goes into the
// 401(k), not wages" — stay inline, where hiding them behind a click would cost
// more than it saves.

const PIA_WORKING_HELP =
  'From your SSA statement (its estimates assume you keep working at your current salary).';
const PIA_STOPPING_HELP =
  'From ssa.gov’s estimator with average future annual salary set to 0.';
const PIA_SHARED_NOTE =
  'Enter only the full-retirement-age figure — the app derives the age-62 through age-70 ' +
  'amounts itself, and blends these two numbers based on the plan’s retirement date.';

const GIVING_RULE_HELP =
  'The household default. The plan can override it on the Workbench’s Tithing tab ' +
  'without changing this answer.';

const POT_PROFILE_HELP =
  'The household default for the pot. The plan can override it — or switch it off for one ' +
  'what-if — on the Workbench’s Tithing tab without changing this answer.';

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
 * The Profile's tabs.
 *
 * Eight cards in one column put Settings — which holds the horizon and the
 * success target — several screens below the fold, so finding one field meant
 * scrolling past every field that was not it.
 *
 * The selection is in the PATH (/profile/expenses), and persists in
 * localStorage behind it for a bare /profile — nav.ts's resolveTab owns which
 * one wins. Coming back to check one number does not start at the top every
 * time, and the tab you are looking at is now the thing you can send someone.
 * The SAVE BAR stays OUTSIDE the tabs deliberately: unlike the Workbench, this
 * page does not autosave, so the control that commits an edit — and the words
 * warning you there is an uncommitted one — must never be a tab away from the
 * field you just changed.
 *
 * EXPENSES USED TO CARRY THREE SUBJECTS: the budget, the rule for giving after
 * the last paycheck, and the life-insurance policy. They are three different
 * questions asked at three different times — "what do we spend", "what do we
 * give once the paychecks stop", "what happens if I die" — and the middle one
 * kept getting answered by whoever was in the tab for the other two. Splitting
 * them costs two tab widths and buys a page where the budget is the only thing
 * on screen while you transcribe it. 'expenses' keeps its id (in nav.ts, which
 * owns the ids because they are URL segments now), so a stored tab — or a link
 * — from before the split still restores to something.
 *
 * THE BUDGET ITSELF THEN SPLIT BY CATEGORY: Expenses holds the living lines,
 * Tithing the giving lines (beside the rule that owns their after-work half),
 * and Investing the transfer into the brokerage. Each tab is homogeneous, so
 * none needs a category column, and each renders only the money columns the
 * engine reads off its lines — BudgetCard.tsx says why that rule is hard.
 */
const PROFILE_TAB_LABELS: Record<ProfileTabId, string> = {
  household: 'Household',
  accounts: 'Accounts',
  home: 'Home',
  income: 'Income',
  expenses: 'Expenses',
  tithing: 'Tithing',
  investing: 'Investing',
  insurance: 'Insurance',
  health: 'Health',
  settings: 'Settings',
};

export function ProfilePage({ route, navigate, storedTab }: PageProps) {
  const { showToast } = useToast();
  // Only answers for a URL that names no tab, and it is App's snapshot rather
  // than a read of our own — resolveTab and readStoredTab in nav.ts say why.
  const tab = resolveTab(route.tab, PROFILE_TAB_IDS, storedTab);
  const selectTab = (id: ProfileTabId) => {
    writeStoredTab(PROFILE_TAB_STORAGE_KEY, id);
    // The URL is the state: navigating re-renders this page with a new
    // route.tab. Setting a local tab as well is what would let the two drift.
    navigate('profile', id);
  };
  const [saved, setSaved] = useState<Profile | null>(null);
  const [draft, setDraft] = useState<Profile | null>(null);
  /** Bumped on load/discard so blur-committed fields remount with fresh text. */
  const [rev, setRev] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  /**
   * The plan's events, read once and never written. The profile has no
   * retirement date — the household holds policies, a PLAN decides when work
   * stops — and the Insurance tab is close to meaningless without one: "ends
   * June 2038" says nothing until you know it is four years past the last
   * paycheck. A failed read leaves the list empty and the notes degrade to
   * saying the plan has no date yet, which is the honest answer either way.
   */
  const [planEvents, setPlanEvents] = useState<ScenarioEvent[]>([]);
  /**
   * The plan's housing move, read the same way and for the same reason: the
   * renting column prices a window the PLAN owns (sale to purchase), and its
   * header should name the real dates when the plan has them. Undefined —
   * no plan housing, or the read failed — degrades the tooltip to speaking
   * hypothetically, which is the honest answer either way.
   */
  const [planHousing, setPlanHousing] = useState<HousingPlan | undefined>(undefined);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    setSaveError(null);
    try {
      const p = await api.getProfile();
      setSaved(p);
      setDraft(structuredClone(p));
      setRev((r) => r + 1);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    api.getPlan().then(
      (plan) => {
        setPlanEvents(plan.events);
        setPlanHousing(plan.housing);
      },
      () => {
        setPlanEvents([]);
        setPlanHousing(undefined);
      },
    );
  }, []);

  const update = useCallback((mutate: (p: Profile) => void) => {
    setDraft((d) => {
      if (!d) return d;
      const next = structuredClone(d);
      mutate(next);
      return next;
    });
  }, []);

  if (loading) return <div className="muted">Loading…</div>;
  if (loadError || !draft || !saved) {
    return (
      <div>
        <div className="error-banner">Failed to load profile: {loadError ?? 'missing data'}</div>
        <button onClick={() => void load()}>Retry</button>
      </div>
    );
  }

  const dirty = stableStringify(draft) !== stableStringify(saved);

  const save = async () => {
    setSaving(true);
    setSaveError(null);
    try {
      await api.putProfile(draft);
      setSaved(structuredClone(draft));
      showToast('Profile saved');
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const settings = draft.settings;
  const spending = settings.spendingPolicy;
  const order = settings.withdrawalPolicy.order;

  /**
   * Giving while working, as the plan will actually run it: summed from the
   * rows when the budget is itemised, the scalar otherwise. The Tithing rule
   * prices "same as working" off this, and reading the scalar cache instead
   * would quote a figure the rows have already replaced.
   */
  const givingMonthly = deriveExpenseStreams(draft.expenses).charitableMonthly;

  /**
   * Whether the budget is itemised — the Tithing tab's intro has to say where
   * giving is EDITED, and that is the lines below it only once lines exist;
   * before that it is the scalar stream on the Expenses tab.
   */
  const itemised = (draft.expenses.lines ?? []).length > 0;

  /** The month nobody draws a salary any more; null when the plan is silent. */
  const workStops = workStopsMonth(
    draft.people,
    draft.income.salaries,
    readPlan(planEvents, draft.people).retireByPerson,
  );

  return (
    <div>
      <div className="row" style={{ marginBottom: 16 }}>
        <button className="primary" disabled={!dirty || saving} onClick={() => void save()}>
          {saving ? 'Saving…' : 'Save'}
        </button>
        <button disabled={(!dirty && !saveError) || saving} onClick={() => void load()}>
          Discard changes
        </button>
        <span className="muted">
          {dirty ? 'Unsaved changes' : 'All changes saved to profile.json'}
        </span>
      </div>

      {saveError ? <div className="error-banner">Save failed: {saveError}</div> : null}

      <div className="tabs" role="tablist" aria-label="Profile sections">
        {PROFILE_TAB_IDS.map((id) => (
          <button
            key={id}
            role="tab"
            id={`profile-tab-${id}`}
            aria-selected={tab === id}
            aria-controls={`profile-panel-${id}`}
            className={tab === id ? 'tab is-active' : 'tab'}
            onClick={() => selectTab(id)}
          >
            {PROFILE_TAB_LABELS[id]}
          </button>
        ))}
      </div>

      <div key={rev} role="tabpanel" id={`profile-panel-${tab}`} aria-labelledby={`profile-tab-${tab}`}>
        {tab === 'household' && (
          <>
        <div className="card">
          <h2 style={{ marginTop: 0 }}>Household &amp; filing</h2>
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
                update((p) => {
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
                  value={person.name}
                  width={180}
                  onCommit={(v) =>
                    update((p) => {
                      p.people[i].name = v;
                    })
                  }
                />
                <NumberField
                  label="Birth year"
                  int
                  value={person.birthYear}
                  width={100}
                  onCommit={(v) =>
                    update((p) => {
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
                    update((p) => {
                      p.people[i].birthMonth = Number(v);
                    })
                  }
                />
                <CheckboxField
                  label="Has own SS benefit (40 credits)"
                  checked={person.hasOwnBenefit}
                  onChange={(v) =>
                    update((p) => {
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
                    update((p) => {
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
                    update((p) => {
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
                  update((p) => {
                    p.people[i].notes = v || undefined;
                  })
                }
              />
            </div>
          ))}
        </div>
          </>
        )}

        {tab === 'accounts' && (
          <>
        <AccountsCard accounts={draft.accounts} people={draft.people} update={update} />
          </>
        )}

        {tab === 'home' && (
          <>
        <div className="card">
          <h2 style={{ marginTop: 0 }}>Home</h2>
          <div className="row">
            <NumberField
              label="Value ($)"
              value={draft.home.value}
              width={130}
              onCommit={(v) =>
                update((p) => {
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
                update((p) => {
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
                update((p) => {
                  p.home.state = v as StateCode;
                })
              }
            />
            <NumberField
              label="Property tax ($/yr)"
              value={draft.home.propertyTaxAnnual}
              width={140}
              onCommit={(v) =>
                update((p) => {
                  p.home.propertyTaxAnnual = v ?? 0;
                })
              }
            />
            <NumberField
              label="Insurance ($/yr)"
              value={draft.home.insuranceAnnual}
              width={130}
              onCommit={(v) =>
                update((p) => {
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
                update((p) => {
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
                update((p) => {
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
                update((p) => {
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
                  update((p) => {
                    if (p.home.mortgage) p.home.mortgage.originalPrincipal = v ?? 0;
                  })
                }
              />
              <NumberField
                label="Balance ($)"
                value={draft.home.mortgage.balance}
                width={130}
                onCommit={(v) =>
                  update((p) => {
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
                  update((p) => {
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
                  update((p) => {
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
                  update((p) => {
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
                  update((p) => {
                    if (p.home.mortgage) p.home.mortgage.startMonth = Number(v);
                  })
                }
              />
            </div>
          ) : null}
        </div>
          </>
        )}

        {tab === 'income' && (
          <>
        <div className="card">
          <h2 style={{ marginTop: 0 }}>Income</h2>
          <div className="row">
            {draft.people.map((person) => (
              <NumberField
                key={person.id}
                label={`${person.name} salary ($/yr)`}
                value={draft.income.salaries[person.id] ?? 0}
                width={170}
                onCommit={(v) =>
                  update((p) => {
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
                update((p) => {
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
                update((p) => {
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
                update((p) => {
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
                update((p) => {
                  // true is what an absent field already means; writing it out
                  // would only add noise.
                  if (v) delete p.income.retirementIncomeTaxable;
                  else p.income.retirementIncomeTaxable = false;
                })
              }
            />
          </div>
        </div>
          </>
        )}

        {tab === 'expenses' && (
          <BudgetCard
            expenses={draft.expenses}
            update={update}
            rentingWindow={rentingWindowFromPlan(planHousing, planEvents)}
          />
        )}

        {tab === 'tithing' && (
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
                  `Expenses tab, and it currently runs at ${formatUSD(givingMonthly)}/mo ` +
                  `(${formatUSD(annualFromMonthly(givingMonthly))}/yr). What happens to it after ` +
                  'the last paycheck is TWO decisions: the un-tithed pot, and how to tithe ' +
                  'going forward.'}
            </p>
            {/* The charitable budget lines — nothing before itemisation; the
                paragraph above already points at the Expenses tab then. */}
            <GivingLines expenses={draft.expenses} update={update} />
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
                text={potHelp(potIsEnabled(draft.expenses.untithedPot) ? draft.expenses.untithedPot : undefined)}
              />
            </div>
            <CheckboxField
              label="Set aside an un-tithed pot at retirement"
              checked={potIsEnabled(draft.expenses.untithedPot)}
              onChange={(on) =>
                update((p) => {
                  // The PROFILE spells "no pot" by absence — the explicit
                  // { enabled: false } form exists for scenario overrides,
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
                  update((p) => {
                    p.expenses.untithedPot = pot;
                  })
                }
              />
            )}
            <div className="field-help">{POT_PROFILE_HELP}</div>
            <div
              className="pair-head"
              style={{ marginTop: 14, paddingTop: 12, borderTop: '1px solid var(--border)', marginBottom: 6 }}
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
                update((p) => {
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
        )}

        {tab === 'investing' && <InvestingCard expenses={draft.expenses} update={update} />}

        {tab === 'insurance' && (
          <InsuranceCard
            expenses={draft.expenses}
            people={draft.people}
            workStops={workStops}
            update={update}
          />
        )}

        {tab === 'health' && (
          <>
        <div className="card">
          <h2 style={{ marginTop: 0 }}>
            Health
            <InfoTip label="the health quote" text={ACA_INTRO} />
          </h2>
          <p className="muted" style={{ marginTop: 0 }}>
            Only matters if the plan retires before 65 — employer coverage runs until you retire,
            Medicare takes over at 65.
            <InfoTip label="how to get the ACA quote" text={ACA_STEPS} />
          </p>
          <div className="row">
            <NumberField
              label="ACA benchmark premium ($/mo)"
              value={draft.health.acaBenchmarkMonthly}
              width={200}
              tip="Second-lowest-cost Silver plan, household total, full price before subsidies — the app computes the subsidy itself from your simulated income."
              onCommit={(v) =>
                update((p) => {
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
                update((p) => {
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
                update((p) => {
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
                update((p) => {
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
              update((p) => {
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
          </>
        )}

        {tab === 'settings' && (
          <>
        <div className="card">
          <h2 style={{ marginTop: 0 }}>Settings</h2>
          <div className="row">
            <NumberField
              label="Horizon age"
              int
              value={settings.horizonAge}
              width={100}
              tip="Simulate through the year you both reach this age. Money left at the horizon is the terminal balance the results report."
              onCommit={(v) =>
                update((p) => {
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
                update((p) => {
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
                update((p) => {
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
                update((p) => {
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
                update((p) => {
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
                update((p) => {
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
                update((p) => {
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
                  update((p) => {
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
                the upper rail it is cut, below the lower rail it is raised, and in between nothing
                happens at all. That last part is the whole difference from fixed percent, which
                moves your grocery budget every year the market does.
                <InfoTip label="the guardrail band" text={GUARDRAILS_HELP} />
              </div>
              <div className="row">
                <NumberField
                  label="Upper rail (× starting rate)"
                  value={spending.guardrails?.upper ?? DEFAULT_GUARDRAILS.upper}
                  width={190}
                  help="1.2 = cut once the rate is 20% above where it started"
                  onCommit={(v) =>
                    update((p) => {
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
                    update((p) => {
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
                    update((p) => {
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
                    update((p) => {
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
                    update((p) => {
                      setGuardrail(p.settings.spendingPolicy, 'raiseCeiling', v);
                    })
                  }
                />
                {/* An inverted band breaches both rails every year, and the
                    server's schema rejects it — better to say so beside the
                    field than to fail the save with a zod message. */}
                {guardrailsOk(spending.guardrails) ? null : (
                  <FieldNote className="warn">upper rail must be above the lower one</FieldNote>
                )}
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
                <div className="row" key={bucket} style={{ marginBottom: 4 }}>
                  <span style={{ width: 170 }}>
                    {i + 1}. {BUCKET_LABELS[bucket]}
                  </span>
                  <button
                    disabled={i === 0}
                    title="Move up"
                    onClick={() =>
                      update((p) => {
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
                      update((p) => {
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
                update((p) => {
                  p.settings.withdrawalPolicy.pretaxPreference =
                    v as WithdrawalPolicy['pretaxPreference'];
                })
              }
            />
          </div>
        </div>
          </>
        )}
      </div>
    </div>
  );
}

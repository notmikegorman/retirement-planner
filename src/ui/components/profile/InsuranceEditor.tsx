/**
 * The INSURANCE EDITORS — one policy's fields (PolicyEditor), the legacy
 * single-policy fields (LegacyPolicyFields), and the convert-to-list offer.
 * The table half lives in modules/InsuranceModule.tsx (the managed-table
 * standard); this file is what its views render.
 *
 * WHY A LIST. The single-policy fields could hold one premium, one face amount
 * and one end date — and this household has two policies with different
 * expiries. Modeling them as one that ends at retirement was wrong in both
 * directions at once: it dropped a real premium four years early AND real
 * cover four years early, in exactly the years before Social Security starts
 * where a death hurts most.
 *
 * WHICH IS WHY EVERY POLICY STATES ITS EXPIRY AGAINST THE RETIREMENT DATE.
 * That gap is the entire reason the policies are separate objects; a list of
 * face amounts with no dates beside them would be a list of numbers nobody can
 * act on. The date comes from the plan (the retire events), because the
 * profile has no such thing — the household holds policies, a plan decides
 * when work stops.
 *
 * The premium is a certain cost and the payout is a contingent one, so a policy
 * can only ever make the household score worse. The Widow tab is where the two
 * are weighed against each other, and this module is what gives it something to
 * weigh.
 */
import type { LifeInsurancePolicy, Person, Profile, ProfileExpenses, YearMonth } from '../../../shared/types';
import { formatUSD } from '../../../shared/util';
import {
  CheckboxField,
  FieldNote,
  InfoTip,
  MonthField,
  MonthlyMoneyField,
  NumberField,
  SelectField,
  TextField,
} from './fields';
import { annualFromMonthly } from './profileLogic';
import {
  makePolicy,
  policyTermNote,
  policyTotals,
  seedPoliciesFromFields,
} from './expensesLogic';

type UpdateFn = (mutate: (p: Profile) => void) => void;

// --- Help copy -------------------------------------------------------------

export const CARD_TIP =
  'Term life is INCOME REPLACEMENT: it exists so that a salary disappearing early does not take ' +
  'the household’s future with it. That is why each policy carries its own dates — a death one ' +
  'month after the term ends is worth exactly nothing to your wife, and a premium charged past ' +
  'the term is money the plan spends on nothing. ' +
  'TAKE THE PREMIUMS OUT OF YOUR LIVING EXPENSES: naming one here and leaving it in that number ' +
  'pays for it twice, the same way property tax used to be double-counted.';

const PREMIUM_HELP =
  'What the policy costs, per month in today’s dollars. It is charged like any other expense from ' +
  'the term start (or the simulation start) until the term ends — or until work stops, if this ' +
  'policy is cancelled then. On its own a premium is pure cost: the household score assumes you ' +
  'both live to the horizon, so it can only ever make the plan look worse. The benefit beside it ' +
  'is the other half.';

const BENEFIT_HELP =
  'The face amount your survivor receives, in NOMINAL dollars — level term does not inflate, so ' +
  '$1,000,000 of cover is worth $1,000,000 whenever it pays and steadily less in real terms the ' +
  'later that is. It is not taxable income (IRC 101(a)(1)) and it lands in savings, like sale ' +
  'proceeds. A premium with no benefit is a cost the model charges and a payout it can never ' +
  'make.';

const INSURED_HELP =
  'Whose death triggers the payout. Only a death of the INSURED pays out, so getting this wrong ' +
  'makes the cover invisible in exactly the death you bought it for. For a one-earner ' +
  'household the answer is almost always the earner: that is the income the policy replaces.';

const TERM_START_HELP =
  'The first month of coverage. LEAVE IT EMPTY for a policy you are already paying for. It exists ' +
  'because an end date alone cannot express “five years of term AT RETIREMENT” — with only an end ' +
  'date the premium is charged from today, seventy-eight months instead of sixty, which makes a ' +
  'policy you have not bought yet look worse than it is.';

const TERM_END_HELP =
  'The last month of coverage — for level term, the end of the term. LEAVE IT EMPTY and both the ' +
  'premium and the cover run to the horizon: it is NOT “for life” in any other sense, and a ' +
  'whole-life policy is not what this models. The date matters enormously to a widow score, ' +
  'because a death one month after it is worth exactly nothing to the survivor.';

const CANCEL_HELP =
  'Off by default, and deliberately: a policy you are paying for is a policy you are paying for, ' +
  'and dropping it at retirement is a DECISION the plan should show you making rather than one it ' +
  'makes silently. Tick it and the premium stops the month work does — and so does the cover, ' +
  'which is the half that is easy to forget.';

const LEGACY_TIP =
  'The one policy these four fields can describe. Convert them into the list and each policy gets ' +
  'its own dates, its own insured person and its own cancel-at-retirement decision — which is the ' +
  'only way to say that one policy runs four years past another. Nothing is lost in the move: no ' +
  'end date here means “cover ends with the paycheck”, and the converted policy says that with ' +
  'cancel-at-retirement ticked.';

// --- Legacy single-policy help (moved verbatim from the Expenses tab) -------

const LIFE_INSURANCE_HELP =
  'Your premium. By default it goes to ZERO the moment nobody is earning a salary — prorated ' +
  'in the retirement year like every other stream — because term life is income replacement, and ' +
  'once there is no salary to replace there is nothing left for it to do. Give the policy an end ' +
  'date beside this box and the premium runs to THAT month instead. ' +
  'TAKE IT OUT OF YOUR LIVING EXPENSES: naming it here and leaving it in that number pays ' +
  'for it twice, the same way property tax used to be double-counted. ' +
  'On its own the premium is pure cost: the household score assumes you both live to the ' +
  'horizon, so it can only ever make the plan look worse. The death benefit beside it is the ' +
  'other half, and the Widow tab is where the two are weighed against each other.';

const DEATH_BENEFIT_HELP =
  'The face amount your survivor receives, in NOMINAL dollars — level term does not inflate, so ' +
  '$1,000,000 of cover is worth $1,000,000 whenever it pays and steadily less in real terms the ' +
  'later that is. It is not taxable income (IRC 101(a)(1)) and it lands in savings, like sale ' +
  'proceeds. Leave it empty for a policy you do not have; a premium with no benefit is a cost ' +
  'the model charges and a payout it can never make.';

const LEGACY_TERM_END_HELP =
  'The last month of coverage — for level term, the end of the term. LEAVE IT EMPTY and both the ' +
  'premium and the cover end when the paychecks do, which is the model’s default reading of term ' +
  'life as income replacement. It is NOT “for life”: a whole-life policy is not what this models. ' +
  'The date matters enormously to a widow score, because a death one month after it is worth ' +
  'exactly nothing to the survivor.';

const LEGACY_INSURED_HELP =
  'Whose death triggers the payout. The default is whoever draws a salary — for one earner that ' +
  'is unambiguous, and it is the death the plan is most exposed to. Name someone explicitly if ' +
  'the policy covers the other of you: only a death of the INSURED pays out, so getting this ' +
  'wrong makes the cover invisible in exactly the death you bought it for.';

/** The first person drawing a salary — the life a term policy usually covers. */
export function defaultInsured(profile: Profile): string {
  const earner = profile.people.find((p) => (profile.income.salaries[p.id] ?? 0) > 0);
  return earner?.id ?? profile.people[0]?.id ?? 'p1';
}

/**
 * One policy's fields — the caller (InsuranceModule) owns the surrounding
 * chrome: banner crumb, Edit / Delete actions, and the view-mode fieldset.
 */
export function PolicyEditor({
  policy,
  index,
  people,
  workStops,
  update,
}: {
  policy: LifeInsurancePolicy;
  index: number;
  people: Person[];
  workStops: YearMonth | null;
  update: UpdateFn;
}) {
  const term = policyTermNote(policy, workStops);
  const patch = (mutate: (policy: LifeInsurancePolicy) => void) =>
    update((p) => {
      const found = p.expenses.lifeInsurancePolicies?.[index];
      if (found) mutate(found);
    });

  return (
    <div>
      <div className="row">
        <span className="muted" style={{ fontSize: 12 }}>
          id: {policy.id}
        </span>
      </div>
      <div className="row">
        <TextField
          label="Policy"
          value={policy.label}
          width={200}
          help="The carrier, or whatever you call it"
          onCommit={(v) =>
            patch((pl) => {
              // The schema requires a name; an empty one would fail the save.
              if (v.trim() !== '') pl.label = v;
            })
          }
        />
        <SelectField
          label="Whose life it covers"
          value={policy.insured}
          width={170}
          options={people.map((p) => ({ value: p.id, label: p.name }))}
          tip={INSURED_HELP}
          onChange={(v) =>
            patch((pl) => {
              pl.insured = v;
            })
          }
        />
        <NumberField
          label="Premium ($/mo)"
          value={policy.premiumMonthly}
          width={150}
          tip={PREMIUM_HELP}
          onCommit={(v) =>
            patch((pl) => {
              pl.premiumMonthly = Math.max(0, v ?? 0);
            })
          }
        />
        <FieldNote className="muted">
          = {formatUSD(annualFromMonthly(policy.premiumMonthly))}/yr
        </FieldNote>
        <NumberField
          label="Death benefit ($)"
          value={policy.deathBenefit}
          width={180}
          tip={BENEFIT_HELP}
          onCommit={(v) =>
            patch((pl) => {
              pl.deathBenefit = Math.max(0, v ?? 0);
            })
          }
        />
      </div>
      <div className="row">
        <MonthField
          label="Coverage starts"
          value={policy.termStart}
          tip={TERM_START_HELP}
          onCommit={(v) =>
            patch((pl) => {
              if (!v) delete pl.termStart;
              else pl.termStart = v;
            })
          }
        />
        <MonthField
          label="Coverage ends"
          value={policy.termEnd}
          tip={TERM_END_HELP}
          onCommit={(v) =>
            patch((pl) => {
              if (!v) delete pl.termEnd;
              else pl.termEnd = v;
            })
          }
        />
        <CheckboxField
          label="Cancel it when work stops"
          checked={policy.cancelAtRetirement === true}
          tip={CANCEL_HELP}
          onChange={(v) =>
            patch((pl) => {
              // false is what an absent field already means; writing it out
              // would only add noise to profile.json.
              if (v) pl.cancelAtRetirement = true;
              else delete pl.cancelAtRetirement;
            })
          }
        />
        <FieldNote className={term.tone === 'warn' ? 'warn' : 'muted'}>{term.text}</FieldNote>
      </div>
      {policy.premiumMonthly > 0 && policy.deathBenefit === 0 ? (
        <div className="field-help warn">
          This policy costs {formatUSD(annualFromMonthly(policy.premiumMonthly))}/yr and buys
          nothing the model can see: with no face amount it drags the household score and can never
          pay your survivor a cent.
        </div>
      ) : null}
      <TextField
        label="Notes"
        value={policy.note ?? ''}
        width="full"
        onCommit={(v) =>
          patch((pl) => {
            if (v.trim() === '') delete pl.note;
            else pl.note = v;
          })
        }
      />
    </div>
  );
}

/**
 * The four single-policy fields, exactly as they were on the old Expenses tab.
 *
 * They stay reachable because every profile written before the list existed
 * still holds its policy in them, and deleting the last policy has to land
 * somewhere editable. The convert offer renders separately
 * (ConvertToListOffer) because converting is an immediate act, not an edit.
 */
export function LegacyPolicyFields({
  expenses,
  people,
  update,
}: {
  expenses: ProfileExpenses;
  people: Person[];
  update: UpdateFn;
}) {
  return (
    <div className="card">
      <h2 style={{ marginTop: 0 }}>
        Life insurance
        <InfoTip label="life insurance" text={CARD_TIP} />
      </h2>
      <div className="row">
        <MonthlyMoneyField
          label="Life insurance ($/mo)"
          value={expenses.lifeInsuranceMonthly ?? 0}
          tip={LIFE_INSURANCE_HELP}
          onCommit={(v) =>
            update((p) => {
              if (!v) delete p.expenses.lifeInsuranceMonthly;
              else p.expenses.lifeInsuranceMonthly = v;
            })
          }
        />
        <FieldNote className="muted">
          {expenses.lifeInsuranceTermEnd
            ? `runs to ${expenses.lifeInsuranceTermEnd}`
            : 'stops when you stop working'}
        </FieldNote>
      </div>
      <div className="row">
        <NumberField
          label="Death benefit ($)"
          value={expenses.lifeInsuranceDeathBenefit}
          allowEmpty
          width={190}
          placeholder="none"
          tip={DEATH_BENEFIT_HELP}
          onCommit={(v) =>
            update((p) => {
              if (v == null || v <= 0) delete p.expenses.lifeInsuranceDeathBenefit;
              else p.expenses.lifeInsuranceDeathBenefit = v;
            })
          }
        />
        <MonthField
          label="Coverage ends"
          value={expenses.lifeInsuranceTermEnd}
          tip={LEGACY_TERM_END_HELP}
          onCommit={(v) =>
            update((p) => {
              if (!v) delete p.expenses.lifeInsuranceTermEnd;
              else p.expenses.lifeInsuranceTermEnd = v;
            })
          }
        />
        <SelectField
          label="Whose life it covers"
          value={expenses.lifeInsuranceInsured ?? ''}
          width={180}
          options={[
            { value: '', label: 'Whoever earns (default)' },
            ...people.map((p) => ({ value: p.id, label: p.name })),
          ]}
          tip={LEGACY_INSURED_HELP}
          onChange={(v) =>
            update((p) => {
              if (!v) delete p.expenses.lifeInsuranceInsured;
              else p.expenses.lifeInsuranceInsured = v;
            })
          }
        />
      </div>
      <div className="field-help">
        {expenses.lifeInsuranceDeathBenefit
          ? `${formatUSD(expenses.lifeInsuranceDeathBenefit)} paid tax-free to the survivor if the ` +
            'insured dies while the cover is in force. It changes nothing about the household ' +
            'score — only the Widow tab can show what it is worth.'
          : 'No death benefit recorded, so this premium buys nothing the model can see. Fill it in ' +
            'and the Widow tab can price the policy against your wife’s odds.'}
      </div>

    </div>
  );
}

/**
 * The list offer, its own card OUTSIDE the legacy form's view/edit fieldset:
 * converting restructures and saves in one move (the module wires onConvert
 * to mutateAndSave), which must work from view mode — it is an act, not a
 * field edit.
 */
export function ConvertToListOffer({ onConvert }: { onConvert: () => void }) {
  return (
    <div className="card">
      <h3 style={{ margin: '0 0 4px' }}>
        Hold more than one policy?
        <InfoTip label="converting to a policy list" text={LEGACY_TIP} />
      </h3>
      <p className="field-help" style={{ marginTop: 0 }}>
        Two policies with different end dates cannot be described by one premium and one date.
        Converting keeps this policy exactly as it stands and lets you add the second.
      </p>
      <div className="row">
        <button className="primary" onClick={onConvert}>
          Convert to a policy list
        </button>
      </div>
    </div>
  );
}

/** The conversion itself, shared so the module cannot drift from the offer. */
export function convertToPolicyList(p: Profile): void {
  p.expenses.lifeInsurancePolicies = seedPoliciesFromFields(p.expenses, defaultInsured(p));
}

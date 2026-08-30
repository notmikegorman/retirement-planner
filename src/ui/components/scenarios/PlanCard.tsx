/**
 * The Plan card — always the first thing in the workbench's inputs panel.
 *
 * The plan answers exactly one question: will this work? Two decisions
 * dominate that answer, so they are never something the user has to think to
 * add — they are always on screen, pre-filled, in plain language:
 *
 *   1. When we stop working (one age for both, or per person)
 *   2. When we claim Social Security (one household date)
 *
 * There used to be a third section here — "When the allocation changes" —
 * built for the what-if the user was actually weighing. He executed it
 * (2026-08-18: the IRA went to VTI/BND at ~56/44), so the question stopped
 * being a what-if and the section was retired. The allocation_change /
 * glidepath EVENTS still exist end to end (old saved scenarios must keep
 * parsing and running); a whole-portfolio one in the loaded plan now shows as
 * a read-only row under Additional events, edited only through the Raw JSON
 * editor. What stayed is the "Bonds are" dial below — a plan-level market
 * assumption, not a dated change, so it never belonged to that section's
 * checkbox in the first place.
 *
 * Nothing new is stored: the card reads and rewrites the ordinary retire /
 * claim_social_security events in the plan (readPlan / writePlan in
 * scenarioHelpers, which still round-trip an existing allocation event
 * untouched). Everything else the user wants to model stays in "Additional
 * events" below.
 */
import { useState, type ReactNode } from 'react';
import type {
  Account,
  AssumptionOverrides,
  Person,
  ScenarioEvent,
  SocialSecurityData,
} from '../../../shared/types';
import { formatUSD } from '../../../shared/util';
// Claiming factors come from the same pure module the engine uses, so the
// preview here can never disagree with the simulation.
import { fraMonths, spousalFactor, workerFactor } from '../../../tax/socialSecurity';
import { FieldNote, InfoTip } from '../profile/fields';
import { CorporateShareField } from './CorporateShareField';
import {
  DEFAULT_CLAIM_AGE,
  SS_CLAIM_AGES,
  ageAtDate,
  autoSeppStatus,
  bondPresetFor,
  bondPresetFraction,
  corporateFractionOf,
  corporateShareErrorText,
  corporateShareText,
  dateAtAge,
  describeSeppBridges,
  formatAge,
  parseNumber,
  readPlan,
  setCorporateFraction,
  writePlan,
  type AutoSeppStatus,
  type BondPreset,
  type PlanDecisions,
} from './scenarioHelpers';

/** Ages offered for "when we stop working". */
/**
 * Retirement ages offered for a person: from the age they reach in the first
 * simulated year through 75. Offering ages already in the past ("age 50 — 2021")
 * is meaningless — the simulation starts in SIM_START_YEAR.
 */
const SIM_START_YEAR = 2026;
const LAST_RETIRE_AGE = 75;

function retireAgesFor(person: Person): number[] {
  const first = Math.max(0, SIM_START_YEAR - person.birthYear);
  const out: number[] = [];
  for (let a = first; a <= LAST_RETIRE_AGE; a++) out.push(a);
  return out;
}

/** Sentinel select value for "no such decision" (keeps working / never claims). */
const NONE = 'none';

interface PlanCardProps {
  events: ScenarioEvent[];
  people: Person[];
  /** Accounts, so a hand-written start_72t can be matched to its owner. */
  accounts?: readonly Pick<Account, 'id' | 'owner'>[];
  /** plan.autoSepp — UNDEFINED MEANS ON (see the 72(t) toggle below). */
  autoSepp?: boolean;
  /** Statutory claiming factors for the benefit preview (null while loading). */
  ssData?: SocialSecurityData | null;
  /**
   * The plan's assumption overrides, for the allocation section's "Bonds are"
   * select — the SAME market.bondComposition.corporateFraction dial the
   * Settings tab's percent field edits (see BondsAreSelect). Read fresh from
   * the draft on every render; this card never holds its own copy.
   */
  overrides: AssumptionOverrides | undefined;
  onChange: (events: ScenarioEvent[]) => void;
  /** Checked = automatic 72(t) bridge on; the panel writes the plan field. */
  onAutoSeppChange?: (on: boolean) => void;
  /** The "Bonds are" commit path — the panel patches assumption_overrides. */
  onOverridesChange: (overrides: AssumptionOverrides | undefined) => void;
}

export function PlanCard({
  events,
  people,
  accounts = [],
  autoSepp,
  ssData = null,
  overrides,
  onChange,
  onAutoSeppChange,
  onOverridesChange,
}: PlanCardProps) {
  const plan = readPlan(events, people);
  const commit = (next: PlanDecisions) => onChange(writePlan(events, next, people));
  const sepp = autoSeppStatus({ autoSepp, events }, people, accounts);

  return (
    <div className="card">
      <div className="row">
        <h2 style={{ margin: 0 }}>
          The plan
          <InfoTip
            label="the plan"
            text={
              'These two decisions drive the answer, so they are always here and always filled ' +
              'in. Anything else you want to model — moving, selling the house, a big one-off ' +
              'cost — goes in Additional events below.'
            }
          />
        </h2>
        <span className="spacer" />
        <span className="muted">Will this work?</span>
      </div>

      <StopWorkingSection
        plan={plan}
        people={people}
        commit={commit}
        sepp={sepp}
        onAutoSeppChange={onAutoSeppChange}
      />
      <ClaimSection plan={plan} people={people} ssData={ssData} commit={commit} />
      {/*
        The bond dial survives the allocation section it used to sit in (see
        the header): the accounts hold bonds today whether or not the mix ever
        changes, and the composition reprices every simulated year — so it is
        plan-level configuration, not part of a dated what-if.
      */}
      <Section
        title="What the bonds are"
        help={
          'What the bond share of every account is made of — Treasuries, or a blend with ' +
          'corporates. A market assumption for the whole plan, priced from history: in 2008 ' +
          'Treasuries returned +20.1% while Baa corporates returned −3.4%, so the choice moves ' +
          'the crash years, not the averages.'
        }
      >
        <BondsAreSelect
          /*
            Keyed by the STORED fraction: the Settings section's corporate-
            share field edits the same dial, and sections can be open at once
            (2026-08-30) — without this, the Custom box's mount-seeded typing
            buffer survives an outside write, shows the old figure, and a
            blur would commit it right back over the newer one. An outside
            (or own) commit remounts the select fresh; typing in the box
            writes nothing, so no remount can interrupt it.
          */
          key={String(corporateFractionOf(overrides) ?? 'unset')}
          overrides={overrides}
          onChange={onOverridesChange}
        />
      </Section>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Shared bits
// ---------------------------------------------------------------------------

function Section({
  title,
  help,
  children,
}: {
  title: string;
  help: string;
  children: ReactNode;
}) {
  // The section's explanation lives behind the "?" beside its heading rather
  // than as a permanent paragraph: three of these paragraphs, stacked, are what
  // pushed the controls that actually matter below the fold.
  return (
    <div style={{ marginTop: 14, paddingTop: 12, borderTop: '1px solid var(--border)' }}>
      <h3 style={{ margin: '0 0 6px' }}>
        {title}
        <InfoTip label={title.toLowerCase()} text={help} />
      </h3>
      {children}
    </div>
  );
}

/**
 * Age dropdown for one decision. Always labelled with the age AND the month it
 * lands on ("age 60 — 2031-07") because an age nobody can date is not a plan.
 * `noneLabel` gives the decision an explicit "not in this plan" answer.
 */
function AgeSelect({
  label,
  person,
  date,
  ages,
  noneLabel,
  onPick,
}: {
  label: string;
  person: Person;
  date: string | null;
  ages: readonly number[];
  noneLabel: string;
  onPick: (date: string | null) => void;
}) {
  const age = date ? ageAtDate(person, date) : null;
  // A stored date that isn't a whole listed age still needs to be selectable.
  const options = age && !ages.includes(age.years) ? [age.years, ...ages] : ages;
  return (
    <div className="row">
      <label className="field" style={{ width: 210 }}>
        <span className="field-label">{label}</span>
        <select
          value={age ? String(age.years) : NONE}
          onChange={(e) =>
            onPick(e.target.value === NONE ? null : dateAtAge(person, Number(e.target.value)))
          }
        >
          <option value={NONE}>{noneLabel}</option>
          {options.map((a) => (
            <option key={a} value={a}>
              age {a} — {dateAtAge(person, a)}
            </option>
          ))}
        </select>
      </label>
      <FieldNote className="muted">
        {date ? `starts ${date}${age && age.months !== 0 ? ` (${formatAge(age)})` : ''}` : '—'}
      </FieldNote>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 1. When we stop working
// ---------------------------------------------------------------------------

function StopWorkingSection({
  plan,
  people,
  commit,
  sepp,
  onAutoSeppChange,
}: {
  plan: PlanDecisions;
  people: Person[];
  commit: (plan: PlanDecisions) => void;
  sepp: AutoSeppStatus;
  onAutoSeppChange?: (on: boolean) => void;
}) {
  const primary = people[0];
  const primaryDate = primary ? (plan.retireByPerson[primary.id] ?? null) : null;
  const primaryAge = primary && primaryDate ? ageAtDate(primary, primaryDate) : null;
  /** The one age everyone would be stopping at, if there is one. */
  const sharedAge = primaryAge && primaryAge.months === 0 ? primaryAge.years : null;
  /** True when one age describes everybody (including "nobody stops"). */
  const sameDateForAll = people.every((p) => (plan.retireByPerson[p.id] ?? null) === primaryDate);
  const together =
    sameDateForAll ||
    people.every((p) => {
      const d = plan.retireByPerson[p.id] ?? null;
      if (primaryDate === null) return d === null;
      return sharedAge !== null && d === dateAtAge(p, sharedAge);
    });

  const [separate, setSeparate] = useState(!together);
  const showSeparate = separate || !together;

  const setEveryone = (date: string | null) => {
    // One AGE for the household — each person's date comes from their own
    // birthday, so different birth months don't quietly drift apart.
    const years = date && primary ? (ageAtDate(primary, date)?.years ?? null) : null;
    const retireByPerson: Record<string, string | null> = {};
    for (const p of people) retireByPerson[p.id] = years === null ? null : dateAtAge(p, years);
    commit({ ...plan, retireByPerson });
  };

  const setOne = (id: string, date: string | null) => {
    commit({ ...plan, retireByPerson: { ...plan.retireByPerson, [id]: date } });
  };

  if (!primary) return null;

  return (
    <Section
      title="When we stop working"
      help={
        'The last paycheck. Salary, 401(k) contributions and employer health coverage all stop ' +
        'here, and the 401(k) rolls into the IRA. Pick “we keep working” to see what never ' +
        'retiring looks like.'
      }
    >
      {!showSeparate ? (
        <AgeSelect
          label="We stop working at"
          person={primary}
          date={primaryDate}
          ages={retireAgesFor(primary)}
          noneLabel="we keep working"
          onPick={setEveryone}
        />
      ) : (
        people.map((p) => (
          <AgeSelect
            key={p.id}
            label={`${p.name} stops at`}
            person={p}
            date={plan.retireByPerson[p.id] ?? null}
            ages={retireAgesFor(p)}
            noneLabel="keeps working"
            onPick={(date) => setOne(p.id, date)}
          />
        ))
      )}
      {/* One age can still mean two different months when birthdays differ. */}
      {!showSeparate &&
        primaryDate !== null &&
        people.length > 1 &&
        people.some((p) => plan.retireByPerson[p.id] !== primaryDate) && (
          <div className="field-help" style={{ marginTop: 4 }}>
            Same age for both, so the months differ:{' '}
            {people.map((p) => `${p.name} in ${plan.retireByPerson[p.id] ?? '—'}`).join(', ')}.
          </div>
        )}
      {people.length > 1 && (
        <div className="field-help" style={{ marginTop: 4 }}>
          <button
            type="button"
            className="link-button"
            onClick={() => {
              const next = !showSeparate;
              setSeparate(next);
              // Collapsing back to one control re-applies person 1's age to
              // everyone, so what the single picker says is what is stored.
              if (!next) setEveryone(primaryDate);
            }}
          >
            {showSeparate ? 'Use one date for both of us' : 'Set separately for each of us'}
          </button>
          {showSeparate ? ' — each person has their own last day.' : ' — if you stop at different times.'}
        </div>
      )}
      <AutoSeppToggle sepp={sepp} onChange={onAutoSeppChange} />
    </Section>
  );
}

/**
 * The 72(t)/SEPP bridge toggle — on unless the plan says otherwise.
 *
 * It sits under the stop-working pickers because it only exists as a
 * consequence of them: stopping before 59 1/2 is what creates the gap the
 * series crosses. When the plan has no such gap the checkbox is DISABLED with
 * the reason rather than removed — a control that vanishes as the retirement
 * age moves is harder to trust than one that says why it is inert — and a
 * plan that turned the bridge off keeps its setting visible either way.
 */
function AutoSeppToggle({
  sepp,
  onChange,
}: {
  sepp: AutoSeppStatus;
  onChange?: (on: boolean) => void;
}) {
  const disabled = !sepp.applies || onChange === undefined;
  const span = describeSeppBridges(sepp.bridges);
  return (
    <div style={{ marginTop: 12, paddingTop: 10, borderTop: '1px dashed var(--border)' }}>
      <label className="row" style={{ gap: 8, cursor: disabled ? 'default' : 'pointer' }}>
        <input
          type="checkbox"
          checked={sepp.on}
          disabled={disabled}
          onChange={(e) => onChange?.(e.target.checked)}
        />
        <span className={disabled ? 'muted' : undefined}>
          Use a 72(t) SEPP to reach 59½ penalty-free
        </span>
      </label>
      <div className="field-help" style={{ marginTop: 4 }}>
        {!sepp.applies
          ? sepp.inertReason
          : sepp.on
            ? `This plan stops work before 59½ (${span}), so a 72(t) series starts in the ` +
              'retirement year. The payment is sized to what the plan actually needs each year ' +
              'over that stretch — not automatically the IRS formula maximum, though it is ' +
              'capped there — and the IRA is split so only the principal that payment requires ' +
              'sits under the series. The rest stays an ordinary IRA you can draw on freely, and ' +
              'anything a year’s payment leaves over is reinvested in the taxable brokerage.'
            : `Off: pre-tax withdrawals before 59½ pay the 10% early-withdrawal penalty in this ` +
              `plan (${span}), so the bridge runs on savings, the brokerage and Roth ` +
              'contribution basis.'}
      </div>
      {sepp.explicit.length > 0 && (
        <div className="field-help" style={{ marginTop: 4 }}>
          {sepp.explicit.map((b) => b.name).join(', ')} already start a 72(t) by hand in this
          plan (a Start 72(t) event), and that election runs as written.
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 2. When we claim Social Security
// ---------------------------------------------------------------------------

function ClaimSection({
  plan,
  people,
  ssData,
  commit,
}: {
  plan: PlanDecisions;
  people: Person[];
  ssData: SocialSecurityData | null;
  commit: (plan: PlanDecisions) => void;
}) {
  const primary = people[0];
  if (!primary) return null;
  const date = plan.claimDate;
  const age = date ? ageAtDate(primary, date) : null;
  const options =
    age && !SS_CLAIM_AGES.includes(age.years) ? [age.years, ...SS_CLAIM_AGES] : SS_CLAIM_AGES;

  const spouse = people[1];
  const help =
    'Benefits can start any time from 62 to 70 — later means a bigger monthly check for life. ' +
    (spouse
      ? `This is one decision for the household: ${spouse.name}'s benefit is a spousal benefit, ` +
        `which cannot start until ${primary.name} files, so the same start date is written for both.`
      : 'The date is written as the household claim date.');

  return (
    <Section title="When we claim Social Security" help={help}>
      <div className="row">
        <label className="field" style={{ width: 250 }}>
          <span className="field-label">We claim at</span>
          <select
            value={age ? String(age.years) : NONE}
            onChange={(e) =>
              commit({
                ...plan,
                claimDate:
                  e.target.value === NONE ? null : dateAtAge(primary, Number(e.target.value)),
              })
            }
          >
            <option value={NONE}>we don&apos;t claim at all</option>
            {options.map((a) => (
              <option key={a} value={a}>
                age {a} — {dateAtAge(primary, a)}
                {a === DEFAULT_CLAIM_AGE ? ' (full benefit)' : ''}
              </option>
            ))}
          </select>
        </label>
        <FieldNote className="muted">
          {date ? `starts ${date}${age && age.months !== 0 ? ` (${formatAge(age)})` : ''}` : '—'}
        </FieldNote>
      </div>
      <ClaimPreview person={primary} age={age?.years ?? null} months={age?.months ?? 0} ssData={ssData} />
    </Section>
  );
}

/** What the chosen claiming age is actually worth, in today's dollars. */
function ClaimPreview({
  person,
  age,
  months,
  ssData,
}: {
  person: Person;
  age: number | null;
  months: number;
  ssData: SocialSecurityData | null;
}) {
  if (age === null) {
    return (
      <div className="field-help" style={{ marginTop: 4 }}>
        No Social Security income in this plan — the portfolio carries everything.
      </div>
    );
  }
  if (!ssData) return null;

  const fraM = fraMonths(person, ssData);
  const claimM = age * 12 + months;
  const factor = person.hasOwnBenefit
    ? workerFactor(claimM, fraM, ssData)
    : spousalFactor(claimM, fraM, ssData);
  const pct = `${(factor * 100).toFixed(1)}%`;
  const timing =
    claimM > fraM
      ? ' — waiting past full retirement age earns extra credits'
      : claimM < fraM
        ? ' — claiming early permanently reduces the check'
        : ' — this is full retirement age';

  return (
    <div className="field-help" style={{ marginTop: 4 }}>
      {person.hasOwnBenefit
        ? `${pct} of ${person.name}'s full benefit — about ${formatUSD(
            person.piaMonthlyAtFraIfWorkingTo62 * factor,
          )}/mo in today's dollars${timing}.`
        : `${pct} of the worker's full benefit (spousal)${timing}.`}
    </div>
  );
}

// ---------------------------------------------------------------------------
// What the bonds are (the dial that outlived the allocation section)
// ---------------------------------------------------------------------------

/**
 * "Bonds are" — what the bond share IS, in the vocabulary of the instruments
 * the user would actually buy.
 *
 * THE DIAL LIVES SOMEWHERE ELSE TOO. This select reads and writes
 * assumption_overrides.market.bondComposition.corporateFraction — the same
 * override the Settings tab's "Corporate share of bonds (%)" field edits.
 * Conceptually it IS a market assumption, and that card is its correct home;
 * practically the bond decision is made on the Plan card (the user changed
 * their allocation and looked for "a dropdown of BND or VGIT" here). One
 * override, two doors: both derive from the stored plan on every render, so
 * they cannot drift, and this control caches nothing but a typing buffer.
 *
 * It OUTLIVED the allocation section it was born inside: the what-if that
 * section modeled was executed for real (2026-08-18) and the section retired,
 * but the accounts hold bonds every year of every plan, so the composition
 * dial keeps its own section on the card.
 *
 * The fund names are parenthetical anchors, never the primary vocabulary:
 * the model names compositions, not products, and the mapping is
 * approximate — which the help line says out loud.
 */
function BondsAreSelect({
  overrides,
  onChange,
}: {
  overrides: AssumptionOverrides | undefined;
  onChange: (overrides: AssumptionOverrides | undefined) => void;
}) {
  const fraction = corporateFractionOf(overrides);
  const stored = bondPresetFor(fraction);
  /*
   * Menu intent, not a cached value. Picking "Custom" writes nothing until a
   * number is committed, so without this flag the select would snap straight
   * back to the stored preset and the field could never be revealed. It only
   * ever FORCES 'custom': the two concrete presets write through immediately
   * and re-derive from the stored plan, and a remount (tab switch, plan
   * replace) re-derives everything from the override again.
   */
  const [customChosen, setCustomChosen] = useState(false);
  const preset: BondPreset = customChosen ? 'custom' : stored;
  /** The Custom box's typing buffer (parse-on-blur, like every number field). */
  const [customText, setCustomText] = useState(() =>
    fraction !== undefined ? corporateShareText(fraction) : '',
  );

  const pick = (next: BondPreset) => {
    if (next === 'custom') {
      // Seed the box from what is stored NOW (0.3 flips to "30", ready to
      // edit), then just reveal it — nothing is written until it commits.
      setCustomText(fraction !== undefined ? corporateShareText(fraction) : '');
      setCustomChosen(true);
      return;
    }
    setCustomChosen(false);
    // Treasuries CLEARS rather than writing 0: absent already means
    // all-Treasury, so a plan that never set the dial stays untouched and a
    // flip away-and-back leaves no residue (setCorporateFraction has the
    // full contrast with the OverridesCard's typed-0 convention).
    onChange(setCorporateFraction(overrides, bondPresetFraction(next)));
  };

  const commitCustom = (text: string) => {
    // Out-of-range or non-numeric input shows its error inline (the shared
    // field computes it) and is never written — the OverridesCard rule.
    if (corporateShareErrorText(text) !== undefined) return;
    const share = parseNumber(text);
    // Blank clears, like blanking the Settings field: "no stated share".
    onChange(setCorporateFraction(overrides, share === null ? undefined : share / 100));
  };

  return (
    // No inner divider: the Section heading above already sets this block off.
    <div>
      <div className="row">
        <label className="field" style={{ width: 340 }}>
          <span className="field-label">Bonds are</span>
          <select value={preset} onChange={(e) => pick(e.target.value as BondPreset)}>
            <option value="treasuries">US Treasuries — what VGIT tracks</option>
            <option value="total_bond">
              Total bond market — what BND approximates (~30% corporate)
            </option>
            <option value="custom">Custom…</option>
          </select>
        </label>
        {preset === 'custom' && (
          <CorporateShareField
            value={customText}
            placeholder="0"
            onChange={setCustomText}
            onBlur={commitCustom}
          />
        )}
      </div>
      <div className="field-help" style={{ marginTop: 4 }}>
        One setting for the whole plan: it says what every bond sleeve is made of, in every
        account and every year. The fund mapping is approximate;
        the same dial appears on Settings as &ldquo;Corporate share of bonds (%)&rdquo;.
      </div>
    </div>
  );
}

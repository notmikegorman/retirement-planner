/**
 * Tithing — the two-knob decomposition, on its own tab.
 *
 * A user thinks in two independent decisions and said so: (1) what to do
 * with THE UN-TITHED POT — a share of the never-tithed gains, seeded at
 * retirement, held soft through the fragile first years, paid out over a
 * window, remainder to charity at death; and (2) how to TITHE GOING FORWARD —
 * a share of growth at new real highs, a share of income drawn, a fixed
 * amount, or nothing. The old bundled 'tithe_account' rule fused them and hid
 * the pot inside the Spending card's giving dropdown; this tab gives each
 * decision its own clearly-headed section.
 *
 * TWO BINDINGS, ONE SET OF FIELDS. The Workbench card below writes SCENARIO
 * OVERRIDES (assumption_overrides.expenses.{retirementGiving,untithedPot}) in
 * the established form-state -> parse -> override pattern, showing the
 * profile's answer as the inherited baseline exactly like the Spending card's
 * cells. The Profile page binds the SAME field components
 * (OngoingGivingEditor / PotFields) straight to profile.json, so the plan's
 * override is visibly an override OF that answer and the two surfaces can
 * never drift apart on what is on offer.
 */
import type { ReactNode } from 'react';
import type {
  AssumptionOverrides,
  OngoingGivingRule,
  ProfileExpenses,
  UntithedPotPolicy,
  UntithedPotSetting,
} from '../../../shared/types';
import { DEFAULT_POT_PERCENT, DEFAULT_TITHE_DISTRIBUTE_YEARS } from '../../../shared/types';
import { potIsEnabled } from '../../../shared/giving';
import { deriveExpenseStreams } from '../../../shared/expenses';
import { formatUSD } from '../../../shared/util';
import { AllocationEditor, CheckboxField, InfoTip, NumberField } from '../profile/fields';
import {
  DEFAULT_GIVING_RULE,
  DEFAULT_NEW_POT,
  DEFAULT_TITHE_ALLOCATION,
  GIVING_RULE_OPTIONS,
  GIVING_SMOOTHING_MAX,
  TITHE_DEFER_MAX,
  TITHE_DISTRIBUTE_MAX,
  annualGivingNote,
  effectiveGivingRule,
  effectiveMonthly,
  effectivePotSetting,
  expenseOverride,
  givingOverride,
  givingRuleHelp,
  givingRuleOfType,
  givingRuleSummary,
  potHelp,
  potOverride,
  potSummary,
  setGivingAmount,
  setGivingCap,
  setGivingOverride,
  setGivingPercent,
  setGivingSmoothing,
  setPotAllocation,
  setPotDistributeYears,
  setPotEarlyRelease,
  setPotHoldYears,
  setPotOngoingDuringHold,
  setPotOverride,
  setPotPercent,
  setPotSeedFromGains,
  type GivingRuleType,
} from './workbenchLogic';

// ---------------------------------------------------------------------------
// Help text — all of it behind a "?" (see fields.tsx InfoTip)
// ---------------------------------------------------------------------------

const CARD_TIP =
  'Two independent decisions: what to do with the pot of gains that were never tithed, and how ' +
  'to tithe going forward. Each section overrides the profile’s answer for THIS PLAN only — ' +
  'reset hands it back, so a what-if is undone in one click.';

const POT_SECTION_TIP =
  'A carve-out inside your largest pre-tax IRA holding the catch-up on gains a tithe on gross ' +
  'pay never touched. It seeds at retirement, holds soft through the fragile first years (a ' +
  'last resort meanwhile), locks, pays out on a schedule, and whatever remains goes to charity ' +
  'at death. Fully independent of how you tithe going forward — the section below.';

const ONGOING_SECTION_TIP =
  'What replaces the paycheck-based giving stream once nobody earns a salary. A rule rather ' +
  'than a number, because the honest answer is often not a figure: a share of what the ' +
  'portfolio produced, a share of what you draw, a flat amount, the same as now, or nothing. ' +
  'Works with or without the pot above.';

const POT_PERCENT_TIP =
  'The share of the never-tithed gains the pot opens with — applied to every retirement ' +
  'account’s balance ABOVE what you contributed over your career. Blank means 10%, the tithe. ' +
  'This sizes the SEED only; the ongoing growth tithe below carries its own percentage, which ' +
  'is the whole point of the split.';

const POT_HOLD_TIP =
  'How long the pot stays SOFT after retirement before it locks and starts paying out. While ' +
  'the hold runs the balance still counts as yours: it sits in your spendable assets and your ' +
  'success rate, and if every other account runs dry the plan spends it (last, and for good). ' +
  '0 locks it on retirement day.';

const POT_DISTRIBUTE_TIP =
  'How many years the held pot takes to reach charity once it locks. Each year gives the ' +
  'balance over the years remaining — growth earned along the way is given too, and the pot ' +
  'is exactly empty on schedule. Each instalment is a real IRA distribution, so it is ' +
  'ordinary income in the year it is paid, and it feeds the charitable deduction.';

const POT_EARLY_TIP =
  'The hold exists to carry the promise past the fragile first years of retirement, not to ' +
  'delay giving for its own sake. Ticked (the default), the hold ends as soon as a year closes ' +
  'above the REAL, inflation-adjusted spendable balance the plan held at the end of its first ' +
  'retired year — proof the fragile window is over — and distribution starts the next year. ' +
  'Untick to always wait out the full hold.';

const POT_SEED_TIP =
  'A one-time catch-up on the day you stop working: the percentage applied to every retirement ' +
  'account’s balance ABOVE what you contributed to it over your career. Those contributions ' +
  'came out of pay you already gave on — only the growth on top has never passed under a ' +
  'tithe. Untick to start the pot empty and tithe only what the portfolio earns from here on. ' +
  'An account whose career-contributions figure is missing counts as zero and flags the year, ' +
  'so fill that in on the Accounts card first.';

const POT_DURING_HOLD_TIP =
  'What the ongoing method does while the pot holds. “Accrue into the pot”: a percent-of-growth ' +
  'tithe moves into the carve-out at each year end instead of being paid — no cash giving and ' +
  'no charitable deduction until the lock (the old bundled behaviour; only a growth tithe has ' +
  'anything growth-shaped to accrue, so any other method simply pays its cash either way). ' +
  '“Give in cash”: the ongoing method pays from retirement day, fully independent of the pot.';

const POT_ALLOCATION_TIP =
  'Unticked, the carve-out is invested exactly like the IRA it sits inside, and an allocation ' +
  'change or glidepath aimed at that IRA reaches it too. Tick it to invest the gift on its own ' +
  'horizon — a long hold argues for more equity, an imminent payout for less. It sets the ' +
  'STARTING mix only; later allocation events still sweep it.';

// ---------------------------------------------------------------------------
// The shared field components (bound by the Workbench card AND the Profile)
// ---------------------------------------------------------------------------

/**
 * The pot's parameters, and nothing else — the on/off decision belongs to the
 * caller because its meaning differs by surface (the profile deletes the
 * field; a plan writes the explicit `{ enabled: false }` so it can suppress
 * an inherited pot).
 */
export function PotFields({
  pot,
  onChange,
}: {
  pot: UntithedPotPolicy;
  onChange: (pot: UntithedPotPolicy) => void;
}) {
  return (
    <>
      <div className="row">
        <NumberField
          label="Percent of untithed gains"
          pct
          allowEmpty
          value={pot.percent}
          width={170}
          placeholder="10"
          help={`Blank = ${DEFAULT_POT_PERCENT * 100}% (the tithe)`}
          tip={POT_PERCENT_TIP}
          onCommit={(v) => onChange(setPotPercent(pot, v))}
        />
        <NumberField
          label="Hold before paying out (years)"
          int
          value={pot.holdYears}
          width={190}
          help={`0 = lock and pay right away (max ${TITHE_DEFER_MAX})`}
          tip={POT_HOLD_TIP}
          onCommit={(v) => onChange(setPotHoldYears(pot, v))}
        />
        <NumberField
          label="Distribute the pot over (years)"
          int
          allowEmpty
          value={pot.distributeYears}
          width={190}
          placeholder={String(DEFAULT_TITHE_DISTRIBUTE_YEARS)}
          help={`Blank = ${DEFAULT_TITHE_DISTRIBUTE_YEARS} (max ${TITHE_DISTRIBUTE_MAX})`}
          tip={POT_DISTRIBUTE_TIP}
          onCommit={(v) => onChange(setPotDistributeYears(pot, v))}
        />
      </div>
      <div className="row">
        <label className="field" style={{ width: 250 }}>
          <span className="field-label">
            During the hold, ongoing giving…
            <InfoTip label="ongoing giving during the hold" text={POT_DURING_HOLD_TIP} />
          </span>
          <select
            aria-label="Ongoing giving during the hold"
            value={pot.ongoingDuringHold ?? 'accrue_to_pot'}
            onChange={(e) =>
              onChange(
                setPotOngoingDuringHold(pot, e.target.value as 'accrue_to_pot' | 'give_cash'),
              )
            }
          >
            <option value="accrue_to_pot">accrues into the pot</option>
            <option value="give_cash">is given in cash</option>
          </select>
        </label>
        <CheckboxField
          label="Seed from gains never tithed"
          checked={pot.seedFromGains !== false}
          tip={POT_SEED_TIP}
          onChange={(v) => onChange(setPotSeedFromGains(pot, v))}
        />
        <CheckboxField
          label="Start early on a new real high"
          checked={pot.earlyRelease !== false}
          tip={POT_EARLY_TIP}
          onChange={(v) => onChange(setPotEarlyRelease(pot, v))}
        />
        <CheckboxField
          label="Invest it differently from the IRA"
          checked={pot.allocation !== undefined}
          tip={POT_ALLOCATION_TIP}
          onChange={(v) =>
            onChange(setPotAllocation(pot, v ? DEFAULT_TITHE_ALLOCATION : undefined))
          }
        />
      </div>
      {pot.allocation !== undefined && (
        <AllocationEditor
          mix={pot.allocation}
          help="The carve-out’s starting mix. Untick above to invest it like the parent IRA."
          onChange={(mix) => onChange(setPotAllocation(pot, mix))}
        />
      )}
    </>
  );
}

/**
 * The ongoing method as a labelled control with its own explanation — used by
 * the Profile page (bound to profile.json) and by the Workbench card below
 * (bound to the plan's override), so the two always offer the same methods.
 *
 * `charitableMonthly` prices the 'continue' rule and seeds a first 'amount'
 * rule; pass the value the run will actually use. `hasPot` switches the
 * percent-of-growth help onto the high-water-mark story, which is the base
 * that method actually runs on whenever a pot is present. `status` is the
 * line directly under the control.
 */
export function OngoingGivingEditor({
  rule,
  charitableMonthly,
  hasPot,
  onChange,
  status,
}: {
  rule: OngoingGivingRule;
  charitableMonthly: number;
  hasPot: boolean;
  onChange: (rule: OngoingGivingRule) => void;
  status?: ReactNode;
}) {
  return (
    <>
      <div className="row">
        <label className="field" style={{ width: 250 }}>
          <span className="field-label">
            Giving after you stop working
            <InfoTip label="this giving rule" text={givingRuleHelp(rule, hasPot)} />
          </span>
          <select
            value={rule.type}
            onChange={(e) =>
              onChange(givingRuleOfType(e.target.value as GivingRuleType, rule, charitableMonthly))
            }
          >
            {GIVING_RULE_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
        <span className="field-note muted">{annualGivingNote(rule, charitableMonthly)}</span>
      </div>
      <OngoingRuleParams rule={rule} hasPot={hasPot} onChange={onChange} />
      {status !== undefined && <div className="field-help">{status}</div>}
    </>
  );
}

/**
 * Whichever numbers the chosen ongoing method needs, and nothing when it
 * needs none. The smoothing window is hidden when a pot is present: on the
 * high-water-mark base the engine deliberately ignores it (averaging new-high
 * increments would tithe the same increment twice), and a live-looking box
 * wired to nothing is the exact bug the policy split exists to avoid.
 */
function OngoingRuleParams({
  rule,
  hasPot,
  onChange,
}: {
  rule: OngoingGivingRule;
  hasPot: boolean;
  onChange: (rule: OngoingGivingRule) => void;
}) {
  if (rule.type === 'continue' || rule.type === 'none') return null;
  return (
    <div className="row">
      {rule.type === 'amount' && (
        <NumberField
          label="Amount ($/mo)"
          value={rule.monthly}
          width={140}
          help={`= ${formatUSD(rule.monthly * 12)}/yr`}
          onCommit={(v) => onChange(setGivingAmount(rule, v))}
        />
      )}
      {rule.type === 'percent_of_growth' && (
        <>
          <NumberField
            label={hasPot ? 'Percent of new real highs' : 'Percent of growth'}
            pct
            value={rule.percent}
            width={160}
            onCommit={(v) => onChange(setGivingPercent(rule, v))}
          />
          {!hasPot && (
            <NumberField
              label="Average over (years)"
              int
              allowEmpty
              value={rule.smoothingYears}
              width={150}
              placeholder="1"
              help={`Blank = last year only (max ${GIVING_SMOOTHING_MAX})`}
              onCommit={(v) => onChange(setGivingSmoothing(rule, v))}
            />
          )}
          <NumberField
            label="Monthly cap ($)"
            allowEmpty
            value={rule.capMonthly}
            width={140}
            placeholder="no cap"
            help="Today's dollars"
            onCommit={(v) => onChange(setGivingCap(rule, v))}
          />
        </>
      )}
      {rule.type === 'percent_of_income' && (
        <NumberField
          label="Percent of income"
          pct
          value={rule.percent}
          width={130}
          onCommit={(v) => onChange(setGivingPercent(rule, v))}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// The Workbench card (plan-level overrides)
// ---------------------------------------------------------------------------

interface TithingCardProps {
  /** The household baseline both sections override. */
  profileExpenses: ProfileExpenses;
  overrides: AssumptionOverrides | undefined;
  onChange: (overrides: AssumptionOverrides | undefined) => void;
}

export function TithingCard({ profileExpenses, overrides, onChange }: TithingCardProps) {
  // Derived for the same reason the Spending card derives: with an itemised
  // budget the giving rows are the truth and the scalar is their cache.
  const profileWorking = deriveExpenseStreams(profileExpenses).charitableMonthly;
  const working = effectiveMonthly(
    profileWorking,
    expenseOverride(overrides, 'charitableMonthly'),
  );

  const ruleOverride = givingOverride(overrides);
  const profileRule = profileExpenses.retirementGiving;
  const rule = effectiveGivingRule(profileRule, ruleOverride);

  const overridePot = potOverride(overrides);
  const profilePot = effectivePotSetting(profileRule, profileExpenses.untithedPot, undefined);
  const pot = effectivePotSetting(profileRule, profileExpenses.untithedPot, overridePot);
  const potOn = potIsEnabled(pot);

  /**
   * Ticking the pot on restores the inherited pot when the profile has one
   * (by clearing the override), and otherwise starts a fresh default pot;
   * unticking writes the EXPLICIT disable — never clears the key — because an
   * absent override inherits, and "off" must survive the profile having a pot.
   */
  const togglePot = (on: boolean) => {
    if (!on) {
      onChange(setPotOverride(overrides, { enabled: false }));
      return;
    }
    if (potIsEnabled(profilePot)) onChange(setPotOverride(overrides, undefined));
    else onChange(setPotOverride(overrides, { ...DEFAULT_NEW_POT }));
  };

  return (
    <div className="card">
      <h2 style={{ marginTop: 0 }}>
        Tithing
        <InfoTip label="tithing" text={CARD_TIP} />
      </h2>

      {/* ---------------- section 1: the pot ---------------- */}
      <div className="pair-head" style={{ marginBottom: 6 }}>
        The un-tithed pot
        <InfoTip label="the un-tithed pot" text={potHelp(pot)} />
        <InfoTip label="what the pot is" text={POT_SECTION_TIP} align="end" />
      </div>
      <CheckboxField
        label="Set aside an un-tithed pot at retirement"
        checked={potOn}
        onChange={togglePot}
      />
      {potOn && (
        <PotFields
          // Remounts the number boxes when the source flips between profile
          // and override, so no stale text is left behind a reset.
          key={overridePot === undefined ? 'profile' : 'override'}
          pot={pot}
          onChange={(next) => onChange(setPotOverride(overrides, next))}
        />
      )}
      {overridePot !== undefined && (
        <div className="field-help">
          <span className="badge">overridden</span> profile: {potSummary(profilePot)} —{' '}
          <button
            type="button"
            className="link-button"
            onClick={() => onChange(setPotOverride(overrides, undefined))}
          >
            reset
          </button>
        </div>
      )}

      {/* ---------------- section 2: the ongoing method ---------------- */}
      <div
        className="pair-head"
        style={{ marginTop: 14, paddingTop: 12, borderTop: '1px solid var(--border)', marginBottom: 6 }}
      >
        Tithing going forward
        <InfoTip label="tithing going forward" text={ONGOING_SECTION_TIP} />
      </div>
      <OngoingGivingEditor
        // Remounts when the rule changes shape, or when a reset hands the
        // boxes the profile's numbers, so no stale text is left.
        key={`${rule.type}:${ruleOverride === undefined ? 'profile' : 'override'}`}
        rule={rule}
        charitableMonthly={working}
        hasPot={potOn}
        onChange={(next) => onChange(setGivingOverride(overrides, next))}
        status={
          ruleOverride !== undefined ? (
            <>
              <span className="badge">overridden</span> profile:{' '}
              {givingRuleSummary(
                effectiveGivingRule(profileRule, undefined) ?? DEFAULT_GIVING_RULE,
                profileWorking,
              )}{' '}
              —{' '}
              <button
                type="button"
                className="link-button"
                onClick={() => onChange(setGivingOverride(overrides, undefined))}
              >
                reset
              </button>
            </>
          ) : undefined
        }
      />
      <div className="field-help">
        The rule takes over in the first year nobody is working — the same signal that switches
        the living and investing streams. The retirement year itself is split: the paycheck
        stream for the months worked, the rule for the rest. Whatever is given in cash still
        feeds the charitable tax deductions — with one deliberate exception: while a pot is
        accruing the growth tithe through its hold, nothing is given in cash and there is
        nothing to deduct.
      </div>
    </div>
  );
}

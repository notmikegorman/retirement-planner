/**
 * THE WIDOW VIEW'S POLICY RESOLUTION — effectivePolicy and planWithoutPolicy.
 *
 * These two are where the Widow tab decides what cover a plan carries and how
 * to build the "no cover at all" counterfactual, and both used to read ONLY the
 * legacy single-policy fields. For a profile carrying a policy LIST the engine
 * ignores those fields entirely (resolvePolicies gives the list precedence), so
 * on a representative profile the tab claimed "no payout is in force" under
 * $3,500,000 of cover, disabled the drop-the-policy comparison, and — had it
 * run — would have compared the plan against itself for twenty-six full
 * simulations. Every list-path test here protects against a variant of that.
 */
import { describe, expect, it } from 'vitest';
import type {
  HousingPlan,
  LifeInsurancePolicy,
  Profile,
  Scenario,
  ScenarioEvent,
} from '../../src/shared/types';
import {
  effectivePolicy,
  planWithoutPolicy,
  survivorDownsizeNote,
  survivorHousingNote,
  survivorShareFromBudget,
  widowSpec,
} from '../../src/ui/components/results/widowData';

// A representative two policies, verbatim — both on p1, overlapping terms.
const termA: LifeInsurancePolicy = {
  id: 'term-a-2500k',
  label: 'Northbridge Term — $2.5M term',
  insured: 'p1',
  premiumMonthly: 158.33,
  deathBenefit: 2_500_000,
  termEnd: '2032-12',
};

const termB: LifeInsurancePolicy = {
  id: 'term-b-1000k',
  label: 'Cardinal Mutual — $1M 10-year term',
  insured: 'p1',
  premiumMonthly: 141.67,
  deathBenefit: 1_000_000,
  termEnd: '2030-12',
};

const RETIRE_2028: ScenarioEvent[] = [
  { type: 'retire', person: 'p1', date: '2028-06' },
  { type: 'retire', person: 'p2', date: '2028-06' },
];

function listProfile(
  policies: LifeInsurancePolicy[],
): Pick<Profile, 'expenses' | 'income'> {
  return {
    expenses: {
      livingMonthly: 5_000,
      charitableMonthly: 0,
      investingMonthly: 0,
      lifeInsurancePolicies: policies,
    },
    income: { salaries: { p1: 265_000, p2: 60_000 }, contribution401k: 0, employerMatch401k: 0 },
  };
}

function legacyProfile(
  expenses?: Partial<Profile['expenses']>,
): Pick<Profile, 'expenses' | 'income'> {
  return {
    expenses: {
      livingMonthly: 5_000,
      charitableMonthly: 0,
      investingMonthly: 0,
      ...expenses,
    },
    income: { salaries: { p1: 265_000, p2: 0 }, contribution401k: 0, employerMatch401k: 0 },
  };
}

const plan = (over?: Partial<Scenario>): Scenario => ({
  name: 'widow test',
  autoSepp: false,
  events: RETIRE_2028,
  ...over,
});

describe('effectivePolicy on a legacy single-policy profile', () => {
  it("the plan's override wins; the profile is the fallback", () => {
    const profile = legacyProfile({
      lifeInsuranceMonthly: 320,
      lifeInsuranceDeathBenefit: 1_000_000,
      lifeInsuranceTermEnd: '2031-06',
    });
    const fromProfile = effectivePolicy(profile, plan());
    expect(fromProfile.benefit).toBe(1_000_000);
    expect(fromProfile.benefitSource).toBe('profile');
    expect(fromProfile.termText).toBe(' to 2031-06');
    const overridden = effectivePolicy(
      profile,
      plan({ assumption_overrides: { expenses: { lifeInsuranceDeathBenefit: 2_000_000 } } }),
    );
    expect(overridden.benefit).toBe(2_000_000);
    expect(overridden.benefitSource).toBe('plan');
  });

  it('no term end reads as ending with the paycheck — the legacy vocabulary', () => {
    const p = effectivePolicy(
      legacyProfile({ lifeInsuranceMonthly: 100, lifeInsuranceDeathBenefit: 500_000 }),
      plan(),
    );
    expect(p.termText).toBe(', ending with the paycheck');
  });

  it('no cover at all: benefit 0, source none', () => {
    const p = effectivePolicy(legacyProfile(), plan());
    expect(p.benefit).toBe(0);
    expect(p.benefitSource).toBe('none');
  });
});

describe('effectivePolicy on a policy-list profile', () => {
  it("reads the LIST, not the legacy fields — the full $3.5M was invisible here", () => {
    const p = effectivePolicy(listProfile([termA, termB]), plan());
    // Peak simultaneous cover on p1: both policies in force through Dec 2030.
    expect(p.benefit).toBe(3_500_000);
    expect(p.benefitSource).toBe('profile');
    expect(p.premiumMonthly).toBeCloseTo(158.33 + 141.67, 10);
    // Two bands ($3.5M to Dec 2030, $2.5M to Dec 2032) end at different months, so
    // no single "to" date is true of the cover and none may be claimed.
    expect(p.termText).toBe('');
  });

  it('the legacy fields beside a list stay superseded, exactly as the engine treats them', () => {
    const profile = listProfile([termA]);
    profile.expenses.lifeInsuranceDeathBenefit = 9_000_000;
    const p = effectivePolicy(profile, plan());
    expect(p.benefit).toBe(2_500_000);
  });

  it("applies the plan's dispositions: cancelling Cardinal Mutual leaves $2.5M on one honest date", () => {
    const p = effectivePolicy(
      listProfile([termA, termB]),
      plan({
        assumption_overrides: {
          expenses: { lifeInsurancePolicyPlans: { 'term-b-1000k': 'cancel_now' } },
        },
      }),
    );
    expect(p.benefit).toBe(2_500_000);
    expect(p.premiumMonthly).toBeCloseTo(158.33, 10);
    // One band left, so its end date may be stated again.
    expect(p.termText).toBe(' to 2032-12');
  });

  it('every policy cancelled = no cover, which is what gates the comparison off', () => {
    const p = effectivePolicy(
      listProfile([termA, termB]),
      plan({
        assumption_overrides: {
          expenses: {
            lifeInsurancePolicyPlans: {
              'term-a-2500k': 'cancel_now',
              'term-b-1000k': 'cancel_now',
            },
          },
        },
      }),
    );
    expect(p.benefit).toBe(0);
    expect(p.benefitSource).toBe('none');
    expect(p.premiumMonthly).toBe(0);
  });

  it('policies on DIFFERENT lives never sum: only one insured can be the one who died', () => {
    const onHer: LifeInsurancePolicy = { ...termB, id: 'hers', insured: 'p2' };
    const p = effectivePolicy(listProfile([termA, onHer]), plan());
    // $2.5M on one life and $1M on the other is a $2.5M answer, not $3.5M.
    expect(p.benefit).toBe(2_500_000);
    // Both premiums are still real money the household pays.
    expect(p.premiumMonthly).toBeCloseTo(158.33 + 141.67, 10);
  });

  it('a cancel-at-retirement policy ends at the month before work stops, and says so', () => {
    const cancelled: LifeInsurancePolicy = { ...termA, cancelAtRetirement: true };
    const p = effectivePolicy(listProfile([cancelled]), plan());
    expect(p.benefit).toBe(2_500_000);
    // Retire 2028-06 = first month not worked, so cover runs through 2028-05.
    expect(p.termText).toBe(' to 2028-05');
  });
});

describe('planWithoutPolicy', () => {
  it('zeroes the legacy fields — premium AND benefit, because dropping is both', () => {
    const dropped = planWithoutPolicy(plan(), []);
    expect(dropped.assumption_overrides?.expenses?.lifeInsuranceMonthly).toBe(0);
    expect(dropped.assumption_overrides?.expenses?.lifeInsuranceDeathBenefit).toBe(0);
    // No policy ids = no dispositions map: a legacy profile must not grow a
    // key that changes the run's input hash without changing the run.
    expect(dropped.assumption_overrides?.expenses?.lifeInsurancePolicyPlans).toBeUndefined();
  });

  it("names every listed policy 'cancel_now' — the zeroed legacy fields cannot reach a list", () => {
    const dropped = planWithoutPolicy(plan(), ['term-a-2500k', 'term-b-1000k']);
    expect(dropped.assumption_overrides?.expenses?.lifeInsurancePolicyPlans).toEqual({
      'term-a-2500k': 'cancel_now',
      'term-b-1000k': 'cancel_now',
    });
  });

  it('REPLACES any dispositions the plan already carries: this counterfactual is no cover at all', () => {
    const keeping = plan({
      assumption_overrides: {
        expenses: { lifeInsurancePolicyPlans: { 'term-a-2500k': 'keep_to_term' } },
      },
    });
    const dropped = planWithoutPolicy(keeping, ['term-a-2500k', 'term-b-1000k']);
    expect(dropped.assumption_overrides?.expenses?.lifeInsurancePolicyPlans).toEqual({
      'term-a-2500k': 'cancel_now',
      'term-b-1000k': 'cancel_now',
    });
  });

  it('never mutates the plan it was given — the workbench still holds it', () => {
    const original = plan({
      assumption_overrides: { expenses: { livingMonthly: 6_000 } },
    });
    const before = JSON.stringify(original);
    planWithoutPolicy(original, ['term-a-2500k']);
    expect(JSON.stringify(original)).toBe(before);
    // And the unrelated override rode along into the counterfactual.
    const dropped = planWithoutPolicy(original, ['term-a-2500k']);
    expect(dropped.assumption_overrides?.expenses?.livingMonthly).toBe(6_000);
  });
});

// ---------------------------------------------------------------------------
// The survivor's living share, once the budget states it line by line
// ---------------------------------------------------------------------------

const LINES: import('../../src/shared/types').ExpenseLine[] = [
  // The one-car household in miniature: the payment survives whole, the
  // groceries drop, the middle line inherits.
  { id: 'car', label: 'Car payment', category: 'living', monthlyNow: 610, monthlySurvivor: 610 },
  { id: 'groceries', label: 'Groceries', category: 'living', monthlyNow: 1854, monthlySurvivor: 1020 },
  { id: 'utilities', label: 'Utilities', category: 'living', monthlyNow: 536 },
];

function itemisedExpenses(): Profile['expenses'] {
  return {
    livingMonthly: 3_000, // stale on purpose: the lines are the truth
    charitableMonthly: 0,
    investingMonthly: 0,
    lines: LINES,
  };
}

describe('widowSpec with an itemised budget', () => {
  const fields = {
    person: 'p1',
    from: 2029,
    to: 2035,
    step: 2,
    livingFraction: 0.6 as number | undefined,
  };

  it('drops a lingering fraction — the If-I-die column is the truth', () => {
    // The trap this pins: the engine gives an event-level livingFraction
    // precedence over the per-line survivor amounts. A 0.6 typed before the
    // budget existed — or restored from the tab's saved session — would
    // silently override every number the user keyed into the column, and the
    // read-only display would then be describing a share the sweep is not
    // using. The spec must carry no fraction at all.
    const spec = widowSpec(fields, itemisedExpenses());
    expect('livingFraction' in spec).toBe(false);
  });

  it('keeps an explicit fraction for a profile with no budget lines', () => {
    const spec = widowSpec(fields, legacyProfile().expenses);
    expect(spec.livingFraction).toBe(0.6);
  });

  it('keeps the fraction when called without expenses, as the solvers do', () => {
    expect(widowSpec(fields).livingFraction).toBe(0.6);
  });
});

describe('survivorShareFromBudget', () => {
  it('sums the column with inheritance, against the derived couple figure', () => {
    const out = survivorShareFromBudget(itemisedExpenses());
    expect(out).not.toBeNull();
    // 610 stated + 1020 stated + 536 inherited = 2166, of the lines' own
    // 3000 total — NOT of the stale 3000 scalar, which only coincidentally
    // matches here; the derivation is what both figures come from.
    expect(out?.survivorMonthly).toBe(2_166);
    expect(out?.coupleMonthly).toBe(3_000);
    expect(out?.share).toBeCloseTo(2_166 / 3_000, 10);
  });

  it('returns null with no lines, keeping the editable fraction in charge', () => {
    expect(survivorShareFromBudget(legacyProfile().expenses)).toBeNull();
  });
});

describe('survivorHousingNote: the number and its assumption travel together', () => {
  /*
   * The 62.7% lesson, as copy: a widow score over a plan with a pre-purchase
   * death year is only honest if the screen SAYS what the survivor was
   * modelled doing about the house. Both directions are pinned here — the
   * survivor price stated when the plan has one, the executing-the-plan-price
   * caveat when it does not — and every "nothing to say" case returns null so
   * the tab never renders an empty warning.
   */
  const housing = (over?: Partial<HousingPlan>): HousingPlan => ({
    sellDate: '2027-06',
    rentMonths: 12,
    rentMonthly: 3000,
    purchasePrice: 1_750_000, // buy month: 2028-06
    propertyTaxAnnual: 7500,
    financing: { type: 'cash' },
    ...over,
  });

  it('states the survivor price on the pre-purchase probes', () => {
    const note = survivorHousingNote(
      housing({ survivorPurchasePrice: 900_000 }),
      [2026, 2027, 2028, 2030],
      'Jordan',
    );
    // The probes land in July, so 2027 (2027-07) precedes the 2028-06 purchase
    // and 2028 (2028-07) does not — the copy must claim exactly the switch the
    // engine performed, no more.
    expect(note).toContain('the 2026–2027 probes');
    expect(note).toContain('2028-06');
    expect(note).toContain('Jordan');
    expect(note).toContain('buying at $900,000');
    expect(note).toContain("the plan's $1,750,000 purchase");
  });

  it("states the proceeds-priced answer for survivorPurchasePrice 'sale_proceeds'", () => {
    const note = survivorHousingNote(
      housing({ survivorPurchasePrice: 'sale_proceeds' }),
      [2026],
      'Jordan',
    );
    expect(note).toContain('the 2026 probe');
    expect(note).toContain('buying with whatever the sale nets');
  });

  it('caveats the absent field: the survivor is modelled executing the plan price', () => {
    const note = survivorHousingNote(housing(), [2026, 2030], 'Jordan');
    expect(note).toContain("executing the plan's $1,750,000 purchase");
    expect(note).toContain('no survivor price is set');
    // The fix lives on the Housing card, and the note says so by the field's
    // own label so the user can find it.
    expect(note).toContain('Housing card');
    expect(note).toContain('If one of us dies before the purchase');
  });

  it('a July probe against a July purchase is NOT claimed as switched', () => {
    // The engine's rule is STRICTLY before, and probes land in July — so when
    // the buy month is itself July (sell 2027-07 + 12 months = 2028-07), the
    // 2028 probe dies IN the buy month and the run executes the plan price.
    // The copy must not claim that probe bought at the survivor price: this is
    // the one alignment where the note's < and a <= disagree, and <= would
    // make the screen describe a switch the run never performed.
    const julyBuy = housing({ sellDate: '2027-07', survivorPurchasePrice: 900_000 });
    expect(survivorHousingNote(julyBuy, [2028, 2030], 'M')).toBeNull();
    const note = survivorHousingNote(julyBuy, [2027, 2028], 'Jordan');
    expect(note).toContain('the 2027 probe');
    expect(note).not.toContain('2027–2028');
  });

  it('is null whenever there is nothing honest to say', () => {
    // No plan-modelled move: hand-written events carry no survivor field.
    expect(survivorHousingNote(undefined, [2026], 'Jordan')).toBeNull();
    // No purchase at all — 'none' and its 0 spelling alike.
    expect(survivorHousingNote(housing({ purchasePrice: 'none' }), [2026], 'M')).toBeNull();
    expect(survivorHousingNote(housing({ purchasePrice: 0 }), [2026], 'M')).toBeNull();
    // No probed death precedes the purchase (July 2028 is after June 2028).
    expect(
      survivorHousingNote(housing({ survivorPurchasePrice: 900_000 }), [2028, 2030], 'M'),
    ).toBeNull();
    // A proceeds-priced PLAN with no survivor field is already what a survivor
    // would do — there is no misleading assumption to caveat.
    expect(
      survivorHousingNote(housing({ purchasePrice: 'sale_proceeds' }), [2026], 'M'),
    ).toBeNull();
    // A half-typed sell date must return null, not throw through the tab.
    expect(
      survivorHousingNote(housing({ sellDate: '20-xx' as HousingPlan['sellDate'] }), [2026], 'M'),
    ).toBeNull();
  });
});

describe('survivorDownsizeNote: the post-purchase probes state their assumption too', () => {
  /*
   * The other half of the timeline, same contract. The staying-put widow is
   * an ASSUMPTION — measured on the user's plan, an uninsured death the
   * month after a $1.75M closing scored 93.0% staying put while downsizing
   * recovers ~$195k net of selling costs — so both directions must speak:
   * the downsize stated when the plan has one, the keeping-the-house caveat
   * when it does not.
   */
  const housing = (over?: Partial<HousingPlan>): HousingPlan => ({
    sellDate: '2027-06',
    rentMonths: 12,
    rentMonthly: 3000,
    purchasePrice: 1_750_000, // buy month: 2028-06
    propertyTaxAnnual: 7500,
    financing: { type: 'cash' },
    ...over,
  });

  it('states the downsize on the post-purchase probes, delay and price together', () => {
    const note = survivorDownsizeNote(
      housing({ survivorDownsizeTo: 1_450_000 }),
      [2026, 2027, 2028, 2030],
      'Jordan',
    );
    // July probes: 2028 (2028-07) is after the 2028-06 purchase, 2027 is not.
    expect(note).toContain('the 2028–2030 probes');
    expect(note).toContain('2028-06');
    expect(note).toContain('Jordan');
    // The default delay reads as prose, not a unit soup.
    expect(note).toContain('a year after the death');
    expect(note).toContain('rebuying at $1,450,000');
    expect(note).toContain('selling costs');
  });

  it('states a non-default delay in months, and the renting variant as renting', () => {
    const note = survivorDownsizeNote(
      housing({ survivorDownsizeTo: 'none', survivorDownsizeDelayMonths: 3 }),
      [2029],
      'Jordan',
    );
    expect(note).toContain('3 months after the death');
    expect(note).toContain('renting from then on');
  });

  it('caveats the absent field: the survivor is modelled keeping the house for good', () => {
    const note = survivorDownsizeNote(housing(), [2028, 2030], 'Jordan');
    expect(note).toContain('KEEPING it for good');
    expect(note).toContain('no downsize is set');
    // Staying put is an assumption — the note must say so in as many words,
    // or the caveat reads as a description instead of a warning.
    expect(note).toContain('Staying put is an assumption');
    expect(note).toContain('Housing card');
    expect(note).toContain('If one of us dies after the purchase');
  });

  it('a July probe against a July purchase IS claimed — the boundary is at/after', () => {
    // The mirror of survivorHousingNote's alignment case: the engine's
    // downsize rule is IN OR AFTER the buy month, so a 2028-07 probe against
    // a 2028-07 purchase is a completed move and the downsize fires. The two
    // notes must split exactly this probe between them.
    const julyBuy = housing({ sellDate: '2027-07', survivorDownsizeTo: 1_450_000 });
    const note = survivorDownsizeNote(julyBuy, [2027, 2028], 'Jordan');
    expect(note).toContain('the 2028 probe');
    expect(note).not.toContain('2027–2028');
  });

  it('is null whenever there is nothing honest to say', () => {
    // No plan-modelled move.
    expect(survivorDownsizeNote(undefined, [2030], 'Jordan')).toBeNull();
    // A rent-forever plan leaves the survivor nothing to downsize.
    expect(survivorDownsizeNote(housing({ purchasePrice: 'none' }), [2030], 'M')).toBeNull();
    expect(survivorDownsizeNote(housing({ purchasePrice: 0 }), [2030], 'M')).toBeNull();
    // No probed death lands at/after the purchase.
    expect(
      survivorDownsizeNote(housing({ survivorDownsizeTo: 1_450_000 }), [2026, 2027], 'M'),
    ).toBeNull();
    // A half-typed sell date must return null, not throw through the tab.
    expect(
      survivorDownsizeNote(housing({ sellDate: '20-xx' as HousingPlan['sellDate'] }), [2030], 'M'),
    ).toBeNull();
  });
});
